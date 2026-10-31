import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { GIFT_CODE_RE, generateGiftCode, normalizeGiftCode } from '../gift-codes.mjs';
import { generateLeaseKeyPair, verifyAccountLease } from '../license-lease.mjs';
import { subscriptionEnd } from '../licenses.mjs';
import { createSiteServer } from '../server.mjs';
import { DEFAULT_WORKOS_CLIENT_ID } from '../workos.mjs';
import { createFakeWorkOS } from './fixtures/fake-workos.mjs';
import { BASIC_ENV } from './fixtures/groble-basic.mjs';

const ADMIN = 'admin-token-for-gift-code-tests';
const WORKOS_KEY = 'sk_test_fake_gift_codes';
const PAIR = generateLeaseKeyPair();
const T0 = Date.parse('2026-10-31T10:00:00+09:00');
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const CLI = new URL('../scripts/license-admin.mjs', import.meta.url).pathname;

const device = (n) => ({ id: `device-${String(n).padStart(4, '0')}`, name: `기기 ${n}`, platform: 'darwin', appVersion: '2.1.0' });

async function setup(t, env = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-gift-codes-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const workos = createFakeWorkOS({ apiKey: WORKOS_KEY, clientId: DEFAULT_WORKOS_CLIENT_ID });
  const workosBase = await workos.listen();
  t.after(() => workos.close());
  const clock = { now: T0 };
  const lines = [];
  const emails = [];
  const server = createSiteServer({
    RAU_SITE_DATA: directory,
    ADMIN_TOKEN: ADMIN,
    LICENSE_SIGNING_PRIVATE_KEY: PAIR.privateKeyDerBase64,
    WORKOS_API_KEY: WORKOS_KEY,
    WORKOS_API_BASE: workosBase,
    ACCOUNT_AUTH_REDIRECT_URI: 'https://site.test/v1/account/auth/callback',
    ...BASIC_ENV,
    ...env,
  }, {
    log: (line) => lines.push(line),
    emailProvider: { name: 'test', async send(message) { emails.push(message); return { status: 'sent' }; } },
    alertProvider: null,
    now: () => clock.now,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); return new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;

  const bearer = (token) => ({ Authorization: `Bearer ${token}` });
  const json = async (res) => ({ status: res.status, body: await res.json() });
  const post = (route, body, headers = {}) => fetch(`${origin}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  }).then(json);
  const admin = (route, body) => post(route, body, bearer(ADMIN));
  const adminGet = (route) => fetch(`${origin}${route}`, { headers: bearer(ADMIN) }).then(json);
  const issue = (body) => admin('/v1/admin/gift-codes/issue', body);

  /** A whole sign-in on one device; resolves to the token answer's body. */
  async function signIn(email, dev = device(1)) {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const started = await post('/v1/account/auth/start', { provider: 'google', challenge, port: 49152, state: `app-${randomBytes(12).toString('hex')}` });
    const loginId = new URL(started.body.url).searchParams.get('state');
    const back = await fetch(`${origin}/v1/account/auth/callback?${new URLSearchParams({ code: workos.signIn({ email }), state: loginId })}`, { redirect: 'manual' });
    const code = new URL(back.headers.get('location')).searchParams.get('code');
    const res = await post('/v1/account/auth/token', { code, verifier, device: dev });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  }
  const redeem = (session, code) => post('/v1/account/gift-codes/redeem', { code }, bearer(session));
  const refresh = (session) => post('/v1/account/refresh', {}, bearer(session));
  const cli = (...args) => promisify(execFile)(process.execPath, [CLI, ...args], { env: { ...process.env, SITE_API_BASE: origin, ADMIN_TOKEN: ADMIN } });
  return {
    origin, directory, clock, lines, emails, post, admin, adminGet, issue, signIn, redeem, refresh, bearer, json, cli,
    licensesText: () => fs.readFile(path.join(directory, 'licenses.json'), 'utf8'),
    licensesFile: async () => JSON.parse(await fs.readFile(path.join(directory, 'licenses.json'), 'utf8')),
  };
}

const leaseOf = (body) => verifyAccountLease(body.lease, { 'hama-prod-1': PAIR.publicKeyRawBase64 }, { now: T0 }).payload;

test('codes: 80 random bits as GIFT-XXXX-XXXX-XXXX-XXXX, normalized like license keys', () => {
  assert.equal(generateGiftCode(() => Buffer.alloc(10, 0xff)), 'GIFT-ZZZZ-ZZZZ-ZZZZ-ZZZZ');
  assert.equal(generateGiftCode(() => Buffer.alloc(10, 0)), 'GIFT-0000-0000-0000-0000');
  // The same packing as RFC 4648 base32 in Crockford's alphabet, so all 80 bits reach the code.
  assert.equal(generateGiftCode(() => Buffer.from('0123456789abcdef0123', 'hex')), 'GIFT-04HM-ASW9-NF6Y-Y093');
  const code = generateGiftCode();
  assert.match(code, GIFT_CODE_RE);
  assert.notEqual(code, generateGiftCode());
  for (const input of [code, code.toLowerCase(), ` ${code.slice(5).replace(/-/g, ' ')} `, code.replace(/-/g, '')]) {
    assert.equal(normalizeGiftCode(input), code, input);
  }
  assert.equal(normalizeGiftCode('gift-o1il-0000-0000-000O'), 'GIFT-0111-0000-0000-0000');
  for (const bad of ['', 'GIFT-1234', 'GIFT-UUUU-0000-0000-0000', 'HAMA-0000-0000-0000-0000', 42, null, 'x'.repeat(65)]) {
    assert.equal(normalizeGiftCode(bad), '', String(bad));
  }
});

test('issue: plan and term are required with no defaults, and every bound is checked before anything is stored', async (t) => {
  const s = await setup(t);
  const valid = { plan: 'basic', durationMonths: 1, count: 1 };
  const refused = (error) => ({ status: 400, body: { ok: false, error } });
  assert.equal((await s.post('/v1/admin/gift-codes/issue', valid)).status, 403);
  assert.deepEqual(await s.issue({ durationMonths: 1, count: 1 }), refused('plan_required'));
  assert.deepEqual(await s.issue({ ...valid, plan: 'signature' }), refused('plan_invalid'));
  assert.deepEqual(await s.issue({ plan: 'basic', count: 1 }), refused('duration_required'));
  assert.deepEqual(await s.issue({ ...valid, durationDays: 30 }), refused('duration_conflict'));
  for (const term of [{ durationMonths: 0 }, { durationMonths: 121 }, { durationMonths: 1.5 }, { durationMonths: '2개월' }, { durationDays: 0 }, { durationDays: 3661 }]) {
    assert.deepEqual(await s.issue({ plan: 'hama', count: 1, ...term }), refused('duration_invalid'), JSON.stringify(term));
  }
  for (const count of [undefined, 0, 1001, -1, '']) assert.deepEqual(await s.issue({ ...valid, count }), refused('count_invalid'), String(count));
  for (const redeemBy of ['2026-10-30', '2026-02-30', 'soon']) assert.deepEqual(await s.issue({ ...valid, redeemBy }), refused('redeem_by_invalid'), redeemBy);
  const state = await s.licensesFile().catch(() => ({ giftCodeBatches: {}, giftCodes: {} }));
  assert.deepEqual([state.giftCodeBatches, state.giftCodes], [{}, {}]);
});

test('issue returns the codes once; storage, list and logs only ever hold a hash and a masked prefix', async (t) => {
  const s = await setup(t);
  const issued = await s.issue({ plan: 'basic', durationMonths: '3', count: '3', note: '베타 감사', redeemBy: '2026-12-31' });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const { batch, codes } = issued.body;
  assert.equal(new Set(codes).size, 3);
  for (const code of codes) assert.match(code, GIFT_CODE_RE);
  assert.match(batch.batchId, /^gcb_[0-9a-f]{18}$/);
  assert.deepEqual(
    [batch.plan, batch.durationMonths, batch.durationDays, batch.count, batch.note, batch.redeemBy, batch.counts],
    ['basic', 3, undefined, 3, '베타 감사', '2026-12-31T14:59:59.999Z', { active: 3, redeemed: 0, revoked: 0, expired: 0 }],
  );
  assert.deepEqual(batch.codes.map((c) => c.maskedCode).sort(), codes.map((c) => `${c.slice(0, 9)}-••••-••••-••••`).sort());

  const text = await s.licensesText();
  const state = JSON.parse(text);
  assert.deepEqual(Object.keys(state.giftCodeBatches), [batch.batchId]);
  const hashes = codes.map((code) => createHash('sha256').update(code).digest('hex'));
  assert.deepEqual(Object.keys(state.giftCodes).sort(), [...hashes].sort());
  assert.deepEqual(state.giftCodes[hashes[0]], { codeHash: hashes[0], batchId: batch.batchId, prefix: codes[0].slice(0, 9), status: 'active', createdAt: new Date(T0).toISOString() });

  const listed = await s.adminGet('/v1/admin/gift-codes');
  assert.deepEqual([listed.status, listed.body.count, listed.body.batches[0].counts.active], [200, 1, 3]);
  assert.deepEqual((await s.adminGet(`/v1/admin/gift-codes?batchId=${batch.batchId}&status=redeemed`)).body.batches[0].codes, []);
  assert.deepEqual((await s.adminGet('/v1/admin/gift-codes?batchId=gcb_nope')).body, { ok: true, count: 0, batches: [] });
  assert.deepEqual(await s.adminGet('/v1/admin/gift-codes?status=used'), { status: 400, body: { ok: false, error: 'status_invalid' } });
  assert.equal((await fetch(`${s.origin}/v1/admin/gift-codes`)).status, 403);

  const me = await s.signIn('me@example.com');
  await s.redeem(me.session, codes[0]);
  await s.redeem(me.session, 'GIFT-0000-0000-0000-0000');
  const everything = [text, await s.licensesText(), JSON.stringify((await s.adminGet('/v1/admin/gift-codes')).body), s.lines.join('\n')].join('\n');
  for (const code of codes) assert.ok(!everything.includes(code.slice(10)), 'a code never leaves the issue answer');
  assert.ok(s.lines.some((line) => line.includes(batch.batchId)), 'the issue is logged by batch id');
});

test('a Basic code: tier and Rau follow the key, it never renews, re-redeem is idempotent and another account gets 409', async (t) => {
  const s = await setup(t);
  const { codes: [code] } = (await s.issue({ plan: 'basic', durationMonths: 3, count: 1 })).body;
  const me = await s.signIn('me@example.com', device(1));
  const other = await s.signIn('other@example.com', device(2));
  assert.equal(me.plan.tier, 'free');

  s.clock.now += MINUTE;
  const first = await s.redeem(me.session, ` ${code.slice(5).toLowerCase().replace(/-/g, ' ')} `);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const expiresAt = subscriptionEnd(s.clock.now, 3);
  assert.equal(new Date(expiresAt).toISOString(), '2027-01-31T14:59:59.999Z');
  const { license, plan } = first.body;
  assert.deepEqual(
    [first.body.ok, first.body.alreadyRedeemed, license.edition, license.plan, license.autoRenew, license.expiresAt, license.linkedBy, license.primary, license.status],
    [true, false, 'basic', null, false, expiresAt, 'gift_code', true, 'active'],
  );
  assert.deepEqual(
    [plan.tier, plan.edition, plan.plan, plan.autoRenew, plan.expiresAt, plan.manageUrl, plan.paymentFailed, plan.rau.eligible],
    ['basic', 'basic', null, false, expiresAt, null, false, true],
  );
  assert.deepEqual([leaseOf(first.body).tier, leaseOf(first.body).plan, leaseOf(first.body).licenseExpiresAt], ['basic', null, expiresAt]);

  const again = await s.redeem(me.session, code);
  assert.deepEqual([again.status, again.body.alreadyRedeemed, again.body.license.keyId, again.body.licenses.length], [200, true, license.keyId, 1]);
  assert.deepEqual(await s.redeem(other.session, code), { status: 409, body: { ok: false, error: 'code_redeemed' } });

  const stored = (await s.licensesFile()).licenses[license.keyId];
  assert.deepEqual(
    [stored.source, stored.edition, stored.accountId, stored.email, stored.emailDelivery, stored.subscription, stored.giftBatchId.startsWith('gcb_')],
    ['gift_code', 'basic', me.account.id, undefined, undefined, undefined, true],
  );
  const [viewed] = (await s.adminGet(`/v1/admin/licenses?keyId=${license.keyId}`)).body.licenses;
  assert.deepEqual([viewed.plan, viewed.billingCycleMonths, viewed.source], [null, undefined, 'gift_code']);
  const [batch] = (await s.adminGet('/v1/admin/gift-codes?status=redeemed')).body.batches;
  assert.deepEqual(batch.codes.map((c) => [c.status, c.accountId, c.keyId, c.redeemedAt]), [['redeemed', me.account.id, license.keyId, new Date(T0 + MINUTE).toISOString()]]);

  // The key itself activates like any key: no renewal, no Groble payment page, no key email.
  const activated = await s.post('/v1/license/activate', { key: viewed.key, deviceId: 'mac-gift-0001', platform: 'darwin' });
  assert.deepEqual(
    [activated.status, activated.body.plan, activated.body.autoRenew, activated.body.paymentFixUrl, activated.body.licenseExpiresAt, activated.body.rau.eligible],
    [200, null, false, undefined, expiresAt, true],
  );
  assert.deepEqual(s.emails, []);

  // It runs out at the end of its term and the account is free again.
  s.clock.now = expiresAt + 1;
  const lapsed = (await s.refresh(me.session)).body;
  assert.deepEqual([lapsed.plan.tier, lapsed.licenses[0].status, lapsed.licenses[0].autoRenew], ['free', 'expired', false]);
  const expired = await s.post('/v1/license/validate', { key: viewed.key, deviceId: 'mac-gift-0001' });
  assert.deepEqual(expired, { status: 403, body: { ok: false, error: 'expired', tier: 'paid', licenseExpiresAt: expiresAt } });
});

test('a Hama code in days: the Hama plan starts with the key and the term ends on the KST day N days later', async (t) => {
  const s = await setup(t, { HAMA_ENABLED: 'true' });
  const { codes: [code] } = (await s.issue({ plan: 'hama', durationDays: 30, count: 1 })).body;
  const me = await s.signIn('me@example.com');
  const res = await s.redeem(me.session, code);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { license, plan } = res.body;
  assert.deepEqual(
    [plan.tier, plan.edition, plan.plan, plan.autoRenew, plan.rau.eligible, new Date(license.expiresAt).toISOString()],
    ['hama', 'hama', null, false, true, '2026-11-30T14:59:59.999Z'],
  );
  const hama = JSON.parse(await fs.readFile(path.join(s.directory, 'hama.json'), 'utf8'));
  assert.deepEqual([hama.plans[license.keyId].status, hama.plans[license.keyId].periodAnchor], ['active', new Date(T0).toISOString()]);
  assert.equal(res.body.stats.hama.usedUsd, 0);
  const status = await fetch(`${s.origin}/v1/hama/status`, { headers: s.bearer(res.body.lease) });
  assert.equal(status.status, 200);
});

test('revoked codes and codes past their redeem-by date answer 410; revoke never touches a redeemed code', async (t) => {
  const s = await setup(t);
  const a = (await s.issue({ plan: 'basic', durationDays: 7, count: 3 })).body;
  const b = (await s.issue({ plan: 'basic', durationDays: 7, count: 2, redeemBy: '2026-11-01' })).body;
  const me = await s.signIn('me@example.com');
  const used = await s.redeem(me.session, a.codes[0]);
  assert.equal(used.status, 200);

  const refused = (error) => ({ status: 400, body: { ok: false, error } });
  assert.deepEqual(await s.admin('/v1/admin/gift-codes/revoke', {}), refused('target_required'));
  assert.deepEqual(await s.admin('/v1/admin/gift-codes/revoke', { batchId: a.batch.batchId, code: a.codes[1] }), refused('target_required'));
  assert.deepEqual(await s.admin('/v1/admin/gift-codes/revoke', { code: 'GIFT-12' }), refused('invalid_format'));
  assert.deepEqual(await s.admin('/v1/admin/gift-codes/revoke', { code: 'GIFT-0000-0000-0000-0000' }), { status: 404, body: { ok: false, error: 'invalid_code' } });
  assert.deepEqual(await s.admin('/v1/admin/gift-codes/revoke', { batchId: 'gcb_nope' }), { status: 404, body: { ok: false, error: 'batch_not_found' } });
  assert.deepEqual(await s.admin('/v1/admin/gift-codes/revoke', { code: a.codes[0] }), { status: 409, body: { ok: false, error: 'code_redeemed', keyId: used.body.license.keyId } });

  const one = await s.admin('/v1/admin/gift-codes/revoke', { code: a.codes[1].toLowerCase(), reason: 'leaked' });
  assert.deepEqual([one.status, one.body.changed, one.body.batch.counts], [200, 1, { active: 1, redeemed: 1, revoked: 1, expired: 0 }]);
  const all = await s.admin('/v1/admin/gift-codes/revoke', { batchId: a.batch.batchId });
  assert.deepEqual([all.body.changed, all.body.batch.counts], [1, { active: 0, redeemed: 1, revoked: 2, expired: 0 }]);
  assert.equal((await s.admin('/v1/admin/gift-codes/revoke', { batchId: a.batch.batchId })).body.changed, 0);
  assert.deepEqual(await s.redeem(me.session, a.codes[2]), { status: 410, body: { ok: false, error: 'code_revoked' } });
  assert.equal((await s.redeem(me.session, a.codes[0])).body.alreadyRedeemed, true, 'the redeemed key stays');

  s.clock.now = Date.parse('2026-11-02T00:00:00+09:00');
  assert.deepEqual(await s.redeem(me.session, b.codes[0]), { status: 410, body: { ok: false, error: 'code_expired' } });
  const [listed] = (await s.adminGet(`/v1/admin/gift-codes?batchId=${b.batch.batchId}`)).body.batches;
  assert.deepEqual(listed.counts, { active: 0, redeemed: 0, revoked: 0, expired: 2 });
});

test('admin views carry each code\'s hash, and revoke takes that hash as its one target', async (t) => {
  const s = await setup(t);
  const { batch, codes } = (await s.issue({ plan: 'hama', durationMonths: 1, count: 3 })).body;
  const hashOf = (code) => createHash('sha256').update(code).digest('hex');
  assert.deepEqual(batch.codes.map((c) => c.codeHash).sort(), codes.map(hashOf).sort());
  const me = await s.signIn('me@example.com');
  const used = await s.redeem(me.session, codes[0]);

  const refused = (error) => ({ status: 400, body: { ok: false, error } });
  const revoke = (body) => s.admin('/v1/admin/gift-codes/revoke', body);
  assert.deepEqual(await revoke({ codeHash: hashOf(codes[1]), batchId: batch.batchId }), refused('target_required'));
  assert.deepEqual(await revoke({ codeHash: hashOf(codes[1]), code: codes[1] }), refused('target_required'));
  for (const codeHash of ['abc', hashOf(codes[1]).toUpperCase(), 42]) assert.deepEqual(await revoke({ codeHash }), refused('invalid_format'), String(codeHash));
  assert.deepEqual(await revoke({ codeHash: 'f'.repeat(64) }), { status: 404, body: { ok: false, error: 'invalid_code' } });
  assert.deepEqual(await revoke({ codeHash: hashOf(codes[0]) }), { status: 409, body: { ok: false, error: 'code_redeemed', keyId: used.body.license.keyId } });

  const one = await revoke({ codeHash: hashOf(codes[1]) });
  assert.deepEqual([one.status, one.body.changed, one.body.batch.counts], [200, 1, { active: 1, redeemed: 1, revoked: 1, expired: 0 }]);
  assert.equal((await revoke({ codeHash: hashOf(codes[1]) })).body.changed, 0);
  assert.deepEqual(await s.redeem(me.session, codes[1]), { status: 410, body: { ok: false, error: 'code_revoked' } });
  const [listed] = (await s.adminGet(`/v1/admin/gift-codes?batchId=${batch.batchId}&status=active`)).body.batches;
  assert.deepEqual(listed.codes.map((c) => c.codeHash), [hashOf(codes[2])]);
});

test('redeem refuses bad formats and unknown codes, and every attempt counts against a per-account hourly limit', async (t) => {
  const s = await setup(t);
  const me = await s.signIn('me@example.com', device(1));
  const other = await s.signIn('other@example.com', device(2));
  assert.deepEqual(await s.redeem('hes_nope', 'GIFT-0000-0000-0000-0000'), { status: 401, body: { ok: false, error: 'session_invalid' } });
  assert.deepEqual(await s.redeem(me.session, 'GIFT-1234'), { status: 400, body: { ok: false, error: 'invalid_format' } });
  assert.deepEqual(await s.redeem(me.session, 42), { status: 400, body: { ok: false, error: 'invalid_format' } });
  for (let i = 0; i < 8; i += 1) {
    assert.deepEqual(await s.redeem(me.session, 'GIFT-0000-0000-0000-0000'), { status: 404, body: { ok: false, error: 'invalid_code' } });
  }
  const { codes: [code] } = (await s.issue({ plan: 'basic', durationDays: 7, count: 1 })).body;
  assert.deepEqual(await s.redeem(me.session, code), { status: 429, body: { ok: false, error: 'rate_limited' } });
  assert.equal((await s.redeem(other.session, 'GIFT-0000-0000-0000-0000')).body.error, 'invalid_code', 'another account has its own budget');
  s.clock.now += 61 * MINUTE;
  assert.equal((await s.redeem(me.session, code)).status, 200);
});

test('without WORKOS_API_KEY redeem answers accounts_not_configured', async (t) => {
  const s = await setup(t, { WORKOS_API_KEY: '' });
  const res = await fetch(`${s.origin}/v1/account/gift-codes/redeem`, { method: 'POST', body: JSON.stringify({ code: 'GIFT-0000-0000-0000-0000' }) });
  assert.deepEqual([res.status, await res.json()], [503, { ok: false, error: 'accounts_not_configured' }]);
});

test('a gift key never blocks deleting the account', async (t) => {
  const s = await setup(t);
  const { codes: [code] } = (await s.issue({ plan: 'basic', durationMonths: 12, count: 1 })).body;
  const me = await s.signIn('leaving@example.com');
  const { license } = (await s.redeem(me.session, code)).body;
  assert.deepEqual(await s.post('/v1/account/delete', { confirm: 'leaving@example.com' }, s.bearer(me.session)), { status: 200, body: { ok: true } });
  const stored = (await s.licensesFile()).licenses[license.keyId];
  assert.deepEqual([stored.accountId, stored.unlinkedBy, stored.status], [undefined, 'delete', 'active']);
});

test('CLI: issue prints the codes once or writes them only to --out; list and revoke show masked codes', async (t) => {
  const s = await setup(t);
  await assert.rejects(s.cli('gift-codes', 'issue', '--count', '2', '--months', '1'), (error) => error.code === 2 && /usage/.test(error.stderr));
  await assert.rejects(s.cli('gift-codes', 'issue', '--plan', 'basic', '--count', '2', '--months', '1', '--days', '7'), (error) => error.code === 2);

  const printed = await s.cli('gift-codes', 'issue', '--plan', 'basic', '--months', '1', '--count', '2', '--note', 'printed');
  const shown = printed.stdout.match(/GIFT(?:-[0-9A-Z]{4}){4}/g);
  assert.equal(new Set(shown).size, 2);
  assert.equal(printed.stdout.split(shown[0]).length, 2, 'each code once');

  const out = path.join(s.directory, 'codes.csv');
  const written = await s.cli('gift-codes', 'issue', '--plan', 'hama', '--days', '14', '--count', '3', '--redeem-by', '2026-12-31', '--out', out);
  assert.doesNotMatch(written.stdout, /GIFT(?:-[0-9A-Z]{4}){4}/);
  assert.match(written.stdout, /3 codes written to /);
  assert.equal((await fs.stat(out)).mode & 0o777, 0o600);
  const [header, ...rows] = (await fs.readFile(out, 'utf8')).trim().split('\n');
  assert.equal(header, 'code,batch_id,plan,duration_months,duration_days,redeem_by');
  assert.equal(rows.length, 3);
  const [code, batchId, plan, months, days, redeemBy] = rows[0].split(',');
  assert.match(code, GIFT_CODE_RE);
  assert.deepEqual([batchId.startsWith('gcb_'), plan, months, days, redeemBy], [true, 'hama', '', '14', '2026-12-31T14:59:59.999Z']);

  await assert.rejects(s.cli('gift-codes', 'issue', '--plan', 'basic', '--months', '1', '--count', '1', '--out', out), (error) => error.code === 2 && /already exists/.test(error.stderr));
  assert.equal((await s.adminGet('/v1/admin/gift-codes')).body.count, 2, 'a refused --out issues nothing');

  const listed = await s.cli('gift-codes', 'list');
  assert.doesNotMatch(listed.stdout, /GIFT(?:-[0-9A-Z]{4}){4}/);
  assert.match(listed.stdout, new RegExp(`\\n${batchId} hama · 14일 · 미사용 3 · 사용 0 · 취소 0 · 기한 지남 0\\n`));
  const revoked = await s.cli('gift-codes', 'revoke', '--batch-id', batchId);
  assert.match(revoked.stdout, /^200 [\s\S]*"changed": 3/);
  assert.doesNotMatch(revoked.stdout, /GIFT(?:-[0-9A-Z]{4}){4}/);
  await assert.rejects(s.cli('gift-codes', 'nope'), (error) => error.code === 2);
});
