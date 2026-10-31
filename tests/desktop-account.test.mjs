import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAccountClient } from '../desktop/account-client.mjs';
import { installAccountHost } from '../desktop/account-host.mjs';
import {
  ACCOUNT_OFFLINE_RETRY_MS, ACTIVITY_FLUSH_MS, AVATAR_MAX_BYTES, createAccountManager, SIGN_IN_TIMEOUT_MS,
} from '../desktop/account-manager.mjs';
import { licenseKeyHash, verifyAccountLease, verifyLease } from '../desktop/license-lease.mjs';
import { createMockAccountServer, DEV_KEYPAIR, DEV_PUBLIC_KEYS } from './fixtures/account-mock-server.mjs';
import { signLease } from './fixtures/license-mock-server.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 31, 0, 0, 0);
const quiet = { warn() {}, info() {} };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png body')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake jpeg body')]);

/** 손으로 부르는 타이머. setTimeout 과 setInterval 을 따로 모은다. */
function fakeTimers() {
  const timeouts = new Map();
  const intervals = new Map();
  let id = 0;
  return {
    setTimeout(fn, ms) { timeouts.set(++id, { fn, ms }); return id; },
    clearTimeout(handle) { timeouts.delete(handle); },
    setInterval(fn, ms) { intervals.set(++id, { fn, ms }); return id; },
    clearInterval(handle) { intervals.delete(handle); },
    timeout(ms) { return [...timeouts.entries()].find(([, timer]) => timer.ms === ms) ?? null; },
    fireTimeout(ms) {
      const [handle, timer] = this.timeout(ms);
      timeouts.delete(handle);
      timer.fn();
    },
    tick() { for (const timer of intervals.values()) timer.fn(); },
  };
}

async function setup(t, { key = null, safeStorage = null, timers } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hama-account-'));
  const clock = { t: T0 };
  const server = createMockAccountServer({ now: () => clock.t });
  const opened = [];
  const leases = [];
  const local = { key };
  const managers = [];
  t.after(async () => {
    for (const manager of managers) manager.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const make = (overrides = {}) => {
    const manager = createAccountManager({
      statePath: join(dir, 'account.json'),
      client: createAccountClient({ baseUrl: 'https://accounts.test', fetchImpl: server.fetch }),
      publicKeys: DEV_PUBLIC_KEYS,
      safeStorage,
      licenseManager: { licenseKey: async () => local.key },
      appVersion: '3.1.0',
      platform: 'darwin',
      deviceName: () => 'Test Mac',
      openExternal: async (url) => { opened.push(url); },
      now: () => clock.t,
      ...(timers ? { timers } : {}),
      onLeaseChange: (lease) => leases.push(lease),
      log: quiet,
      ...overrides,
    });
    managers.push(manager);
    return manager;
  };
  return { dir, clock, server, opened, leases, local, make, manager: make() };
}

/** 브라우저처럼 로그인 주소를 따라가 루프백으로 돌아온다. */
async function followAuthorize(server, url) {
  const authorize = await server.fetch(url);
  assert.equal(authorize.status, 302);
  const location = authorize.headers.get('location');
  return { location, response: await fetch(location) };
}

async function signIn(ctx, provider = 'google', loginHint) {
  const started = await ctx.manager.signIn(provider, loginHint);
  assert.equal(started.ok, true, started.code);
  const { response } = await followAuthorize(ctx.server, ctx.opened.at(-1));
  await response.text();
  return ctx.manager.getStatus();
}

async function waitFor(check, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

const callsTo = (server, path) => server.calls.filter((call) => call.path === path);
const portOf = (server) => callsTo(server, '/v1/account/auth/start').at(-1).body.port;

test('account leases v2 verify offline and never pass as v1 leases', () => {
  const payload = {
    v: 2, kid: DEV_KEYPAIR.kid, accountId: 'acct_1', deviceId: 'dev-a', keyId: 'lic_1', tier: 'pro', plan: 'monthly',
    issuedAt: T0, expiresAt: T0 + 7 * DAY,
  };
  const lease = signLease(payload);
  const opts = { publicKeys: DEV_PUBLIC_KEYS, deviceId: 'dev-a', accountId: 'acct_1', now: T0 + DAY };
  assert.deepEqual(verifyAccountLease(lease, opts), { ok: true, payload });
  assert.equal(verifyAccountLease(lease, { ...opts, deviceId: 'dev-b' }).reason, 'wrong_device');
  assert.equal(verifyAccountLease(lease, { ...opts, accountId: 'acct_2' }).reason, 'wrong_account');
  assert.equal(verifyAccountLease(lease, { ...opts, publicKeys: {} }).reason, 'unknown_kid');
  assert.equal(verifyAccountLease(lease, { ...opts, now: T0 - HOUR }).reason, 'not_yet_valid');
  assert.deepEqual(verifyAccountLease(lease, { ...opts, now: T0 + 7 * DAY }), { ok: false, reason: 'expired', payload });
  const forged = `${Buffer.from(JSON.stringify({ ...payload, tier: 'hama' })).toString('base64url')}.${lease.split('.')[1]}`;
  assert.equal(verifyAccountLease(forged, opts).reason, 'bad_signature');
  assert.equal(verifyAccountLease(signLease({ ...payload, tier: 'gold' }), opts).reason, 'malformed');
  // v1 은 v2 를, v2 는 v1 을 받지 않는다.
  assert.equal(verifyLease(lease, { publicKeys: DEV_PUBLIC_KEYS, now: T0 + DAY }).reason, 'malformed');
  const v1 = signLease({ v: 1, kid: DEV_KEYPAIR.kid, keyId: 'lic_1', keyHash: 'x', deviceId: 'dev-a', issuedAt: T0, expiresAt: T0 + DAY });
  assert.equal(verifyAccountLease(v1, opts).reason, 'malformed');
});

test('sign-in goes through the browser and the loopback with PKCE, and only the free tier keeps the lease to itself', async (t) => {
  const ctx = await setup(t);
  const { manager, server, opened, leases, dir } = ctx;
  assert.deepEqual((await manager.getStatus()).providers, ['email', 'google']);
  assert.equal((await manager.signIn('apple')).code, 'invalid');

  const started = await manager.signIn('email', ' me@example.com ');
  assert.deepEqual([started.ok, started.status.state, started.status.signIn.provider], [true, 'signing_in', 'email']);
  const start = callsTo(server, '/v1/account/auth/start')[0].body;
  assert.equal(start.loginHint, 'me@example.com');
  assert.match(start.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.match(start.state, /^[A-Za-z0-9_-]{16,128}$/);
  assert.ok(opened[0].startsWith('https://accounts.test/authorize?'));

  const { location, response } = await followAuthorize(server, opened[0]);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /HamaEditor로 돌아가세요/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const tokenCall = callsTo(server, '/v1/account/auth/token')[0].body;
  assert.equal(createHash('sha256').update(tokenCall.verifier).digest('base64url'), start.challenge);
  assert.deepEqual({ ...tokenCall.device, id: undefined }, { id: undefined, name: 'Test Mac', platform: 'darwin', appVersion: '3.1.0' });

  const status = await manager.getStatus();
  assert.deepEqual([status.state, status.account.email, status.plan.tier, status.lastError], ['signed_in', 'me@example.com', 'free', null]);
  assert.deepEqual(status.devices.map((device) => [device.id, device.current]), [[tokenCall.device.id, true]]);
  // 무료 lease 는 호스팅 기능에 주지 않는다.
  assert.equal(await manager.currentLease(), null);
  assert.deepEqual(await manager.entitlement(), { signedIn: true, accountId: status.account.id, tier: 'free' });

  // 루프백은 한 번 답하고 닫힌다.
  await assert.rejects(fetch(location));
  const file = await readFile(join(dir, 'account.json'), 'utf8');
  assert.equal((await stat(join(dir, 'account.json'))).mode & 0o777, 0o600);
  const saved = JSON.parse(file);
  assert.equal(saved.session.enc, 'plain');
  const code = new URL(location).searchParams.get('code');
  assert.ok(!file.includes(code) && !file.includes(tokenCall.verifier));

  const key = server.issueKey({ edition: 'pro', plan: 'monthly' });
  const redeemed = await manager.redeem(key);
  assert.deepEqual([redeemed.ok, redeemed.alreadyLinked, redeemed.status.plan.tier], [true, false, 'pro']);
  const lease = await manager.currentLease();
  assert.equal(verifyAccountLease(lease, { publicKeys: DEV_PUBLIC_KEYS, deviceId: tokenCall.device.id, accountId: status.account.id, now: T0 }).payload.tier, 'pro');
  assert.equal(leases.at(-1), lease);
  for (const shown of [started.status, status, redeemed.status]) {
    const text = JSON.stringify(shown);
    assert.ok(!text.includes(saved.session.value) && !text.includes(lease) && !text.includes(key) && !text.includes(tokenCall.verifier));
  }
});

test('the loopback rejects a wrong state and other paths, then still accepts the real callback', async (t) => {
  const ctx = await setup(t);
  await ctx.manager.signIn('google');
  const authorize = await ctx.server.fetch(ctx.opened[0]);
  const location = new URL(authorize.headers.get('location'));
  const forged = new URL(location);
  forged.searchParams.set('state', 'x'.repeat(32));
  const rejected = await fetch(forged);
  assert.equal(rejected.status, 400);
  assert.match(await rejected.text(), /로그인하지 못했어요/);
  const other = await fetch(new URL('/favicon.ico', location));
  assert.equal(other.status, 404);
  await other.text();
  assert.equal((await ctx.manager.getStatus()).state, 'signing_in');
  assert.equal(callsTo(ctx.server, '/v1/account/auth/token').length, 0);

  const accepted = await fetch(location);
  assert.equal(accepted.status, 200);
  await accepted.text();
  assert.equal((await ctx.manager.getStatus()).state, 'signed_in');
});

test('cancel closes the loopback port, and a provider error ends the sign-in with its message', async (t) => {
  const ctx = await setup(t);
  await ctx.manager.signIn('google');
  const port = portOf(ctx.server);
  const cancelled = await ctx.manager.cancelSignIn();
  assert.deepEqual([cancelled.state, cancelled.signIn, cancelled.lastError], ['signed_out', null, null]);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/auth/callback?state=x`));

  ctx.server.setAuthorizeError('auth_cancelled');
  await ctx.manager.signIn('google');
  const { response } = await followAuthorize(ctx.server, ctx.opened.at(-1));
  assert.match(await response.text(), /앱에서 다시 시도해 주세요/);
  const status = await ctx.manager.getStatus();
  assert.deepEqual([status.state, status.lastError], ['signed_out', { code: 'auth_cancelled', message: '로그인을 취소했어요.' }]);

  const failing = await setup(t);
  const broken = failing.make({ openExternal: async () => { throw new Error('no browser'); } });
  const result = await broken.signIn('google');
  assert.deepEqual([result.ok, result.code, result.status.state], [false, 'browser_failed', 'signed_out']);
  await assert.rejects(fetch(`http://127.0.0.1:${portOf(failing.server)}/auth/callback`));
});

test('a sign-in nobody finishes times out after 10 minutes and closes the port', async (t) => {
  const timers = fakeTimers();
  const ctx = await setup(t, { timers });
  await ctx.manager.signIn('google');
  const port = portOf(ctx.server);
  assert.ok(timers.timeout(SIGN_IN_TIMEOUT_MS));
  timers.fireTimeout(SIGN_IN_TIMEOUT_MS);
  const status = await ctx.manager.getStatus();
  assert.deepEqual([status.state, status.lastError?.code], ['signed_out', 'auth_timeout']);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/auth/callback`));
});

test('a sixth device picks one to remove and the sign-in completes with the same grant', async (t) => {
  const ctx = await setup(t);
  const seeded = ctx.server.seedDevices('tester@example.com', 5);
  await ctx.manager.signIn('google');
  const { location, response } = await followAuthorize(ctx.server, ctx.opened[0]);
  assert.match(await response.text(), /HamaEditor로 돌아가세요/);
  let status = await ctx.manager.getStatus();
  assert.deepEqual([status.state, status.deviceChoice.limit, status.deviceChoice.devices.length], ['choose_device', 5, 5]);
  assert.ok(status.deviceChoice.devices.every((device) => !device.current));
  const file = await readFile(join(ctx.dir, 'account.json'), 'utf8');
  assert.ok(!file.includes(new URL(location).searchParams.get('code')), 'the grant stays in memory');

  assert.equal((await ctx.manager.replaceDevice('not-on-the-list')).code, 'device_not_found');
  const replaced = await ctx.manager.replaceDevice(seeded[0]);
  assert.deepEqual([replaced.ok, replaced.status.state, replaced.status.deviceChoice], [true, 'signed_in', null]);
  const devices = ctx.server.account('tester@example.com').devices;
  assert.equal(devices.size, 5);
  assert.ok(!devices.has(seeded[0]));
  const tokens = callsTo(ctx.server, '/v1/account/auth/token');
  assert.deepEqual([tokens.length, tokens[1].body.replaceDeviceId, tokens[1].body.code], [2, seeded[0], tokens[0].body.code]);
});

test('a device removed elsewhere while choosing frees the slot and the sign-in still completes', async (t) => {
  const ctx = await setup(t);
  const seeded = ctx.server.seedDevices('tester@example.com', 5);
  await signIn(ctx);
  ctx.server.removeDevice('tester@example.com', seeded[2]);
  const result = await ctx.manager.replaceDevice(seeded[2]);
  assert.deepEqual([result.ok, result.status.state], [true, 'signed_in']);
});

test('a session the server no longer knows signs out this device but keeps its device id', async (t) => {
  const ctx = await setup(t);
  const first = await signIn(ctx);
  const deviceId = first.devices[0].id;
  await ctx.manager.setAvatar(PNG, 'image/png');
  ctx.server.removeDevice('tester@example.com', deviceId);
  const result = await ctx.manager.refresh();
  assert.deepEqual([result.ok, result.code, result.status.state, result.status.account], [false, 'session_invalid', 'signed_out', null]);
  assert.equal(result.status.lastError.message, '이 기기는 계정에서 빠졌어요. 다시 로그인해 주세요.');
  const saved = JSON.parse(await readFile(join(ctx.dir, 'account.json'), 'utf8'));
  assert.deepEqual([saved.deviceId, saved.session, saved.lease, saved.view, saved.avatar], [deviceId, null, null, null, null]);
  await assert.rejects(stat(join(ctx.dir, 'account-avatar')));
  assert.equal(await ctx.manager.getAvatar(), null);

  await signIn(ctx);
  assert.equal(callsTo(ctx.server, '/v1/account/auth/token').at(-1).body.device.id, deviceId);
});

test('offline refreshes keep the lease and the account view, also after a restart', async (t) => {
  const ctx = await setup(t);
  await signIn(ctx);
  await ctx.manager.redeem(ctx.server.issueKey({ edition: 'hama', plan: 'annual' }));
  const lease = await ctx.manager.currentLease();
  ctx.server.setOffline(true);
  ctx.clock.t += DAY;
  const result = await ctx.manager.refresh();
  assert.deepEqual([result.ok, result.code, result.status.state, result.status.plan.tier, result.status.sync.offline], [false, 'network', 'signed_in', 'hama', true]);
  assert.equal(await ctx.manager.currentLease(), lease);

  const restarted = ctx.make();
  const status = await restarted.getStatus();
  assert.deepEqual([status.state, status.plan.tier, status.stats.hama.calls], ['signed_in', 'hama', 42]);
  assert.equal(await restarted.currentLease(), lease);
  ctx.server.setOffline(false);
  const back = await restarted.refresh();
  assert.deepEqual([back.ok, back.status.sync.offline, back.status.sync.lastSyncAt], [true, false, ctx.clock.t]);
  // lease 가 끝나면 호스팅 기능에 주지 않는다.
  ctx.server.setOffline(true);
  ctx.clock.t += 8 * DAY;
  assert.equal(await restarted.currentLease(), null);
});

test('the session token is encrypted when safeStorage works, stored plain when it does not, and unreadable means signed out', async (t) => {
  const safeStorage = {
    available: true,
    isEncryptionAvailable() { return this.available; },
    encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString('hex')}`),
    decryptString: (buffer) => {
      const text = buffer.toString();
      if (!text.startsWith('sealed:')) throw new Error('bad');
      return Buffer.from(text.slice(7), 'hex').toString();
    },
  };
  const ctx = await setup(t, { safeStorage });
  const first = await signIn(ctx);
  const file = await readFile(join(ctx.dir, 'account.json'), 'utf8');
  const saved = JSON.parse(file);
  assert.equal(saved.session.enc, 'safe');
  assert.ok(!file.includes('hes_'));
  assert.equal((await ctx.make().getStatus()).state, 'signed_in');

  const broken = { isEncryptionAvailable: () => true, encryptString: safeStorage.encryptString, decryptString: () => { throw new Error('keychain denied'); } };
  const denied = await ctx.make({ safeStorage: broken }).getStatus();
  assert.deepEqual([denied.state, denied.sync.error], ['signed_out', 'session_unreadable']);
  assert.equal(JSON.parse(await readFile(join(ctx.dir, 'account.json'), 'utf8')).deviceId, first.devices[0].id);

  const plain = await setup(t, { safeStorage: { isEncryptionAvailable: () => false } });
  await signIn(plain);
  assert.equal(JSON.parse(await readFile(join(plain.dir, 'account.json'), 'utf8')).session.enc, 'plain');
  const reopened = plain.make({ safeStorage: null });
  assert.equal((await reopened.refresh()).status.state, 'signed_in');
});

test('a corrupted state file starts fresh', async (t) => {
  const ctx = await setup(t);
  await writeFile(join(ctx.dir, 'account.json'), '{"v":1,"deviceId":');
  const status = await ctx.manager.getStatus();
  assert.deepEqual([status.state, status.account, status.plan.tier], ['signed_out', null, 'free']);
  const saved = JSON.parse(await readFile(join(ctx.dir, 'account.json'), 'utf8'));
  assert.match(saved.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // 예전 파일에 남은 제공자 목록도 지금 아는 것만 쓴다.
  await writeFile(join(ctx.dir, 'account.json'), JSON.stringify({ ...saved, providers: ['apple', 'email'] }));
  assert.deepEqual((await ctx.make().getStatus()).providers, ['email']);
});

test('activity is counted once per id, sent in batches every 5 minutes, retried with the same batch id and dropped while signed out', async (t) => {
  const timers = fakeTimers();
  const ctx = await setup(t, { timers });
  const { manager, server, clock } = ctx;
  manager.recordActivity('agent_session', 'chat-before');
  await signIn(ctx);
  manager.start();
  await waitFor(() => callsTo(server, '/v1/account/refresh').length > 0, 'launch refresh');
  for (const [kind, id] of [['agent_session', 'chat-1'], ['agent_session', 'chat-1'], ['document_edited', 'doc-1'],
    ['document_edited', 'doc-2'], ['document_edited', 'doc-1'], ['bogus', 'x'], ['agent_session', '']]) {
    manager.recordActivity(kind, id);
  }
  await manager.getStatus();
  // 처음 쌓인 기록은 다음 확인 때 보내고, 그 뒤로는 5분에 한 번까지.
  timers.tick();
  await waitFor(() => callsTo(server, '/v1/account/stats').length === 1, 'first flush');
  await manager.getStatus();
  const first = callsTo(server, '/v1/account/stats')[0].body;
  assert.deepEqual([first.agentSessions, first.documentsEdited], [1, 2]);
  assert.match(first.batchId, /^[A-Za-z0-9_-]{8,64}$/);
  assert.deepEqual((await manager.getStatus()).stats, { agentSessions: 1, documentsEdited: 2, since: T0, hama: null });

  server.script('/v1/account/stats', [503, { ok: false, error: 'server' }]);
  manager.recordActivity('document_edited', 'doc-3');
  await manager.getStatus();
  clock.t += ACTIVITY_FLUSH_MS - 1000;
  timers.tick();
  await manager.getStatus();
  assert.equal(callsTo(server, '/v1/account/stats').length, 1, 'not before 5 minutes');
  clock.t += 1000;
  timers.tick();
  await waitFor(() => callsTo(server, '/v1/account/stats').length === 2, 'failed flush');
  assert.equal(await manager.flushOnQuit(), true);
  const [, failed, retried] = callsTo(server, '/v1/account/stats');
  assert.equal(failed.body.batchId, retried.body.batchId);
  assert.deepEqual(server.account('tester@example.com').stats.documentsEdited, 3);

  await manager.signOut();
  manager.recordActivity('document_edited', 'doc-signed-out');
  await signIn(ctx);
  assert.equal(await manager.flushActivity(), true);
  assert.equal(callsTo(server, '/v1/account/stats').length, 3, 'nothing recorded while signed out');
  // 같은 계정으로 다시 로그인해도 이미 센 문서는 다시 세지 않는다.
  manager.recordActivity('document_edited', 'doc-1');
  assert.equal(await manager.flushActivity(), true);
  assert.equal(callsTo(server, '/v1/account/stats').length, 3);
});

test('the local license key links to the account once, and every outcome shows on the status', async (t) => {
  const ctx = await setup(t);
  const { server, local } = ctx;
  local.key = server.issueKey({ edition: 'pro', plan: 'annual' });
  await signIn(ctx);
  let status = await waitFor(async () => {
    const current = await ctx.manager.getStatus();
    return current.localKey?.state === 'linked' ? current : null;
  }, 'linked key');
  assert.deepEqual([status.plan.tier, status.localKey.maskedKey], ['pro', `${local.key.slice(0, 10)}-•••••-•••••-•••••-${local.key.slice(-5)}`]);
  assert.equal(JSON.parse(await readFile(join(ctx.dir, 'account.json'), 'utf8')).migratedKeyHash, licenseKeyHash(local.key));
  await ctx.manager.licenseChanged();
  assert.equal(callsTo(server, '/v1/account/redeem').length, 1, 'a linked key is not redeemed again');

  server.createSession({ email: 'other@example.com', deviceId: 'other-device-1' });
  local.key = server.issueKey({ edition: 'pro', email: 'other@example.com' });
  await ctx.manager.licenseChanged();
  status = await ctx.manager.getStatus();
  assert.equal(status.localKey.state, 'linked_elsewhere');

  local.key = 'HAMA-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ';
  await ctx.manager.licenseChanged();
  assert.equal((await ctx.manager.getStatus()).localKey.state, 'invalid');

  local.key = server.issueKey({ edition: 'hama', plan: 'monthly' });
  server.setOffline(true);
  await ctx.manager.licenseChanged();
  assert.equal((await ctx.manager.getStatus()).localKey.state, 'pending');
  server.setOffline(false);
  await ctx.manager.licenseChanged();
  assert.equal((await ctx.manager.getStatus()).localKey.state, 'pending', 'network failures wait before retrying');
  ctx.clock.t += ACCOUNT_OFFLINE_RETRY_MS;
  await ctx.manager.licenseChanged();
  status = await ctx.manager.getStatus();
  assert.deepEqual([status.localKey.state, status.plan.tier], ['linked', 'hama']);
});

test('the avatar is cached locally and downloaded again only when the server revision changes', async (t) => {
  const ctx = await setup(t);
  const { manager, server } = ctx;
  await signIn(ctx);
  assert.equal((await manager.setAvatar(Buffer.alloc(AVATAR_MAX_BYTES + 1), 'image/png')).code, 'too_large');
  assert.equal((await manager.setAvatar(JPEG, 'image/png')).code, 'unsupported_type');
  const uploaded = await manager.setAvatar(PNG, 'image/png');
  assert.deepEqual([uploaded.ok, uploaded.status.account.avatarRev], [true, 1]);
  assert.equal(await manager.getAvatar(), `data:image/png;base64,${PNG.toString('base64')}`);
  assert.equal(server.calls.filter((call) => call.path === '/v1/account/avatar' && call.method === 'GET').length, 0);

  // 다른 기기에서 사진을 바꿨다.
  const other = server.createSession({ email: 'tester@example.com', deviceId: 'other-device-2' });
  await server.fetch('https://accounts.test/v1/account/avatar', { method: 'PUT', headers: { Authorization: `Bearer ${other.token}`, 'Content-Type': 'image/jpeg' }, body: JPEG });
  await manager.refresh();
  await manager.refresh();
  assert.equal(server.calls.filter((call) => call.path === '/v1/account/avatar' && call.method === 'GET').length, 1);
  assert.equal(await manager.getAvatar(), `data:image/jpeg;base64,${JPEG.toString('base64')}`);
  assert.equal((await manager.getStatus()).account.avatarRev, 2);

  await manager.removeAvatar();
  assert.equal(await manager.getAvatar(), null);
  await assert.rejects(stat(join(ctx.dir, 'account-avatar')));
});

test('profile, devices, claims and account deletion follow the server rules', async (t) => {
  const ctx = await setup(t);
  const { manager, server, opened } = ctx;
  await signIn(ctx);
  assert.equal((await manager.updateName(' ')).code, 'name_invalid');
  assert.equal((await manager.updateName('하마 사용자')).status.account.name, '하마 사용자');

  const other = server.createSession({ email: 'tester@example.com', deviceId: 'other-device-3' });
  assert.equal(other.accountId, (await manager.getStatus()).account.id);
  await manager.refresh();
  const removed = await manager.removeDevice('other-device-3');
  assert.deepEqual([removed.ok, removed.status.devices.length], [true, 1]);
  assert.equal((await manager.removeDevice('other-device-3')).code, 'device_not_found');

  const orderKey = server.issueKey({ edition: 'pro', plan: 'monthly' });
  server.addOrder('ORDER-1', { email: 'buyer@groble.test', key: orderKey });
  server.addOrder('ORDER-2', { email: 'buyer@groble.test' });
  assert.equal((await manager.claim('ORDER-1', 'someone@else.test')).message, '주문을 찾지 못했어요. 주문번호와 Groble 이메일을 확인해 주세요.');
  assert.equal((await manager.claim('ORDER-2', 'buyer@groble.test')).code, 'order_not_ready');
  const claimed = await manager.claim('ORDER-1', 'BUYER@groble.test');
  assert.deepEqual([claimed.ok, claimed.status.plan.tier, claimed.status.plan.manageUrl], [true, 'pro', 'https://groble.im/manage/purchase']);

  assert.equal((await manager.deleteAccount('wrong@example.com')).code, 'confirm_mismatch');
  const refused = await manager.deleteAccount('Tester@Example.com');
  assert.deepEqual([refused.ok, refused.code, refused.message], [false, 'subscription_active', '구독을 먼저 해지해 주세요.']);
  assert.equal(refused.status.state, 'signed_in');
  await manager.openManage();
  assert.equal(opened.at(-1), 'https://groble.im/manage/purchase');

  // Groble 에서 구독을 해지했다.
  server.license(orderKey).autoRenew = false;
  const deleted = await manager.deleteAccount('Tester@Example.com');
  assert.deepEqual([deleted.ok, deleted.status.state, deleted.status.account], [true, 'signed_out', null]);
  assert.equal(await manager.currentLease(), null);
  assert.equal(server.account('tester@example.com'), null);
  assert.equal(server.license(orderKey).accountId, undefined, 'the license is free again');
});

test('an account server without WorkOS hides sign-in instead of failing', async (t) => {
  const ctx = await setup(t);
  ctx.server.setConfigured(false);
  ctx.manager.start();
  const status = await waitFor(async () => {
    const current = await ctx.manager.getStatus();
    return current.available === false ? current : null;
  }, 'unavailable');
  assert.equal(status.state, 'signed_out');
  assert.equal((await ctx.manager.signIn('google')).code, 'accounts_not_configured');
  assert.equal(ctx.opened.length, 0);
  // 다시 켜지면 다음 확인에서 보인다.
  ctx.server.setConfigured(true);
  assert.equal((await ctx.manager.refresh()).status.available, true);
});

test('the IPC host serves only trusted Studio senders and checks every argument', async (t) => {
  const handlers = new Map();
  const listeners = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn),
  };
  const calls = [];
  const status = { state: 'signed_in' };
  const manager = new Proxy({}, {
    get: (_target, name) => (...args) => {
      calls.push([name, ...args]);
      return name === 'getStatus' ? status : { ok: true, status };
    },
  });
  const trusted = { sender: 'studio' };
  const sent = [];
  const host = installAccountHost({
    ipcMain,
    manager,
    isTrustedStudioEvent: (event) => event === trusted,
    studioWebContents: () => [{ send: (channel, value) => sent.push([channel, value]) }, { isDestroyed: () => true, send: () => assert.fail() }],
  });
  assert.deepEqual(host.channels.toSorted(), [
    'account:cancel-sign-in', 'account:claim', 'account:delete', 'account:get-avatar', 'account:open-manage',
    'account:record-activity', 'account:redeem', 'account:refresh', 'account:remove-avatar', 'account:remove-device',
    'account:replace-device', 'account:set-avatar', 'account:sign-in', 'account:sign-out', 'account:status', 'account:update-name',
  ]);
  const invoke = (channel, ...args) => handlers.get(channel)(trusted, ...args);
  assert.throws(() => handlers.get('account:status')({ sender: 'web page' }), /Untrusted/);
  assert.equal((await invoke('account:sign-in', 'apple')).code, 'invalid');
  assert.equal((await invoke('account:sign-in', 'email', { hint: 1 })).code, 'invalid');
  await invoke('account:sign-in', 'email', 'me@example.com');
  assert.equal((await invoke('account:set-avatar', 'not bytes', 'image/png')).code, 'unsupported_type');
  assert.equal((await invoke('account:set-avatar', new Uint8Array(8), 'image/gif')).code, 'unsupported_type');
  assert.equal((await invoke('account:set-avatar', new Uint8Array(AVATAR_MAX_BYTES + 1), 'image/png')).code, 'too_large');
  await invoke('account:set-avatar', new Uint8Array(PNG).buffer, 'image/png');
  assert.equal((await invoke('account:replace-device', '../etc')).code, 'device_not_found');
  assert.equal((await invoke('account:redeem', 42)).code, 'invalid_format');
  listeners.get('account:record-activity')({ sender: 'web page' }, 'agent_session', 'chat-1');
  listeners.get('account:record-activity')(trusted, 'bogus', 'chat-1');
  listeners.get('account:record-activity')(trusted, 'agent_session', 'chat-1');
  assert.deepEqual(calls.filter(([name]) => name !== 'getStatus').map(([name, ...args]) => [name, args.map((arg) => (arg instanceof Uint8Array ? 'bytes' : arg))]), [
    ['signIn', ['email', 'me@example.com']],
    ['setAvatar', ['bytes', 'image/png']],
    ['recordActivity', ['agent_session', 'chat-1']],
  ]);
  host.broadcast(status);
  assert.deepEqual(sent, [['account:changed', status]]);
});
