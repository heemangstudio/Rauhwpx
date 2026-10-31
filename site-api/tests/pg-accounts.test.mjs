import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { accountIdForEmail, createAccountsService, emptyAccountsState } from '../accounts.mjs';
import { createFileAvatars, createPostgresAvatars } from '../avatars.mjs';
import { resolveLicenseConfig } from '../config.mjs';
import { generateLeaseKeyPair, parseSigningPrivateKey } from '../license-lease.mjs';
import { createLicensesService, emptyLicensesState } from '../licenses.mjs';
import { accountsMapper } from '../mappers/accounts.mjs';
import { licensesMapper } from '../mappers/licenses.mjs';
import { createPostgresStore } from '../pg-store.mjs';
import { createMemoryStore } from '../store.mjs';
import { DEFAULT_WORKOS_CLIENT_ID, createWorkOSClient } from '../workos.mjs';
import { createFakeWorkOS } from './fixtures/fake-workos.mjs';
import { PRO_ENV, proPaid } from './fixtures/groble-pro.mjs';
import { differential, seededRandom } from './helpers/differential.mjs';
import { postgresSuite } from './helpers/postgres.mjs';

const pgSuite = postgresSuite();
const ADMIN = 'admin-token-for-pg-accounts';
const WORKOS_KEY = 'sk_test_fake_pg_accounts';
const PAIR = generateLeaseKeyPair();
const T0 = Date.parse('2026-10-31T10:00:00+09:00');
const HOUR = 60 * 60 * 1000;
const USER = { object: 'user', id: 'user_01PGACCOUNTS', email: 'Buyer@Example.com', email_verified: true, first_name: '하마', last_name: '' };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('jpeg-body')]);

const verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
const device = (n) => ({ id: `device-${String(n).padStart(4, '0')}`, name: `기기 ${n}`, platform: 'darwin', appVersion: n === 3 ? '' : '2.1.0' });

function world({ stores, avatars, workosBase, clock }) {
  const config = resolveLicenseConfig({ ...PRO_ENV, ADMIN_TOKEN: ADMIN });
  const signingKey = parseSigningPrivateKey(PAIR.privateKeyPem);
  const licenses = createLicensesService({
    store: stores.licenses,
    products: config.products,
    signingKey,
    adminToken: ADMIN,
    now: () => clock.now,
    random: seededRandom('licenses'),
    accountForEmail: async (email) => accountIdForEmail(await stores.accounts.read(), email),
    log: () => {},
  });
  const accounts = createAccountsService({
    store: stores.accounts,
    licenses,
    workos: createWorkOSClient({ apiKey: WORKOS_KEY, apiBase: workosBase, redirectUri: 'https://site.test/v1/account/auth/callback' }),
    signingKey,
    avatars,
    deviceLimit: 2,
    adminToken: ADMIN,
    now: () => clock.now,
    random: seededRandom('accounts'),
    log: () => {},
  });
  return { stores, avatars, licenses, accounts };
}

function orderOf(name, state) {
  if (name !== 'accounts') return Object.keys(state.licenses);
  return {
    accounts: Object.keys(state.accounts),
    devices: Object.values(state.accounts).map((a) => Object.keys(a.devices)),
    sessions: Object.keys(state.sessions),
    byEmail: Object.keys(state.byEmail),
  };
}

test('accounts on Postgres answer and store exactly what the memory store does, avatars included', async (t) => {
  const db = pgSuite.db(t);
  if (!db) return;
  await pgSuite.reset();
  const workos = createFakeWorkOS({ apiKey: WORKOS_KEY, clientId: DEFAULT_WORKOS_CLIENT_ID });
  const workosBase = await workos.listen();
  t.after(() => workos.close());
  const avatarDir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-pg-avatars-'));
  t.after(() => fs.rm(avatarDir, { recursive: true, force: true }));
  const clock = { now: T0 };
  const worlds = {
    memory: world({
      stores: { accounts: createMemoryStore(emptyAccountsState()), licenses: createMemoryStore(emptyLicensesState()) },
      avatars: createFileAvatars(avatarDir),
      workosBase,
      clock,
    }),
    postgres: world({
      stores: { accounts: createPostgresStore({ db, mapper: accountsMapper }), licenses: createPostgresStore({ db, mapper: licensesMapper }) },
      avatars: createPostgresAvatars(db),
      workosBase,
      clock,
    }),
  };
  const step = differential(worlds, { orderOf });

  // Sign-in: start → AuthKit (the fake mints a code for the same WorkOS user) → callback → token.
  async function signIn(dev, extra = {}) {
    const { value: started } = await step(`start ${dev.id}`, (w) => w.accounts.startLogin({ provider: 'google', challenge, port: 49152, state: 'app-state-0123456789' }));
    const loginId = new URL(started.url).searchParams.get('state');
    const { value: back } = await step(`callback ${dev.id}`, (w) => w.accounts.callback({ code: workos.signIn(USER), state: loginId }));
    const grant = new URL(back.redirect).searchParams.get('code');
    return step(`token ${dev.id}`, (w) => w.accounts.token({ code: grant, verifier, device: dev, ...extra }));
  }
  const { value: first } = await signIn(device(1));
  const session = first.session;
  await signIn(device(2));
  assert.equal((await signIn(device(3))).error.code, 'device_limit');
  // A retry with replaceDeviceId needs a fresh grant; the limit answer left the old one for it.
  const { value: replaced } = await signIn(device(3), { replaceDeviceId: 'device-0002' });
  assert.deepEqual(replaced.devices.map((d) => d.id).sort(), ['device-0001', 'device-0003']);

  clock.now += 2 * HOUR;
  await step('refresh', (w) => w.accounts.refresh(session, { appVersion: '2.2.0' }));
  await step('lease', (w) => w.accounts.authenticateLease(first.lease, { purpose: 'rau', allowInactive: true, withRauPlan: true }));

  // Licenses: a purchase with the verified email links at once; redeem a manual key; claim an order bought with another email.
  await step('purchase', (w) => w.licenses.handleGrobleEvent(proPaid({ merchantUid: 'pro_m1', email: 'buyer@example.com' }), { idempotencyKey: 'idem-1' }));
  const { value: issued } = await step('issue', (w) => w.licenses.admin.issue(ADMIN, { email: 'other@example.com' }));
  await step('redeem', (w) => w.accounts.redeem(session, { key: issued.license.key.toLowerCase() }));
  await step('other purchase', (w) => w.licenses.handleGrobleEvent(proPaid({ merchantUid: 'pro_m2', ref: 'hama-pro-2', email: 'gift@example.com' }), { idempotencyKey: 'idem-2' }));
  await step('claim', (w) => w.accounts.claim(session, { orderId: 'pro_m2', email: 'GIFT@example.com' }));
  await step('claim unknown', (w) => w.accounts.claim(session, { orderId: 'nope', email: 'gift@example.com' }));

  // Profile, picture, stats.
  await step('profile', (w) => w.accounts.updateProfile(session, { name: '새 이름' }));
  await step('avatar png', (w) => w.accounts.setAvatar(session, 'image/png', async () => PNG));
  await step('get png', (w) => w.accounts.getAvatar(session));
  await step('avatar jpeg', (w) => w.accounts.setAvatar(session, 'image/jpeg', async () => JPEG));
  assert.deepEqual((await step('get jpeg', (w) => w.accounts.getAvatar(session))).value.type, 'image/jpeg');
  assert.deepEqual((await db.query('SELECT type FROM account_avatars')).rows, [{ type: 'image/jpeg' }]);
  assert.deepEqual((await fs.readdir(avatarDir)).sort(), [`${first.account.id}.jpg`]);
  await step('avatar remove', (w) => w.accounts.removeAvatar(session));
  assert.equal((await step('get removed', (w) => w.accounts.getAvatar(session))).error.code, 'no_avatar');
  assert.deepEqual((await db.query('SELECT type FROM account_avatars')).rows, []);
  await step('avatar again', (w) => w.accounts.setAvatar(session, 'image/png', async () => PNG));
  await step('stats', (w) => w.accounts.recordStats(session, { batchId: 'batch-0001', agentSessions: 3, documentsEdited: 2 }));
  await step('stats retried', (w) => w.accounts.recordStats(session, { batchId: 'batch-0001', agentSessions: 3, documentsEdited: 2 }));

  // Devices and admin.
  await step('remove device', (w) => w.accounts.removeDevice(session, { deviceId: 'device-0003' }));
  await step('admin lookup', (w) => w.accounts.admin.lookup(ADMIN, { email: 'buyer@example.com' }));
  await step('admin link', (w) => w.accounts.admin.link(ADMIN, { keyId: issued.license.keyId, accountId: first.account.id }));
  const { value: second } = await signIn(device(4));
  await step('signout', (w) => w.accounts.signout(second.session));
  await step('signed out', (w) => w.accounts.refresh(second.session, {}));

  // Delete: refused while the Pro key renews, then done once it is revoked; the picture goes with it.
  await step('delete mismatch', (w) => w.accounts.deleteAccount(session, { confirm: 'someone@example.com' }));
  assert.equal((await step('delete renewing', (w) => w.accounts.deleteAccount(session, { confirm: 'BUYER@example.com' }))).error.code, 'subscription_active');
  for (const merchantUid of ['pro_m1', 'pro_m2']) await step(`revoke ${merchantUid}`, (w) => w.licenses.admin.revoke(ADMIN, { merchantUid }));
  await step('delete', (w) => w.accounts.deleteAccount(session, { confirm: 'buyer@example.com' }));
  await step('deleted', (w) => w.accounts.refresh(session, {}));
  assert.deepEqual((await db.query('SELECT account_id FROM account_avatars')).rows, []);
  assert.deepEqual(await fs.readdir(avatarDir), []);

  // A fresh process loads exactly the state the first one holds.
  assert.deepStrictEqual(await createPostgresStore({ db, mapper: accountsMapper }).read(), await worlds.postgres.stores.accounts.read());
  assert.deepStrictEqual(await createPostgresStore({ db, mapper: licensesMapper }).read(), await worlds.postgres.stores.licenses.read());
});
