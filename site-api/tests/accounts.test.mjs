import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveAccountConfig } from '../config.mjs';
import {
  generateLeaseKeyPair,
  parseSigningPrivateKey,
  signAccountLease,
  signLease,
  verifyAccountLease,
  verifyLease,
} from '../license-lease.mjs';
import { createSiteServer } from '../server.mjs';
import { DEFAULT_WORKOS_CLIENT_ID } from '../workos.mjs';
import { createFakeWorkOS } from './fixtures/fake-workos.mjs';
import { planPaid, signedGroblePost } from './fixtures/groble-plans.mjs';

const ADMIN = 'admin-token-for-account-tests';
const SECRET = 'whsec_test_accounts';
const WORKOS_KEY = 'sk_test_fake_accounts';
const PAIR = generateLeaseKeyPair();
const T0 = Date.parse('2026-10-31T10:00:00+09:00');
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const REDIRECT = 'https://site.test/v1/account/auth/callback';
// Hosted Rau needs an upstream key to count as configured; nothing here calls it (the base is a closed port).
const RAU_KEY = ['test', 'openrouter', 'placeholder'].join('-');
// A key bought at planPaid's default time bills monthly from then.
const RAU_RESETS_AT = Date.parse('2026-11-20T05:22:11.000Z');
const NO_RAU = { eligible: false, source: null, remainingPercent: null, resetsAt: null };

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

const device = (n, fields = {}) => ({ id: `device-${String(n).padStart(4, '0')}`, name: `기기 ${n}`, platform: 'darwin', appVersion: '2.1.0', ...fields });

async function setup(t, env = {}, { clock = { now: T0 } } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-accounts-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const workos = createFakeWorkOS({ apiKey: WORKOS_KEY, clientId: DEFAULT_WORKOS_CLIENT_ID });
  const workosBase = await workos.listen();
  t.after(() => workos.close());
  const lines = [];
  const server = createSiteServer({
    RAU_SITE_DATA: directory,
    GROBLE_WEBHOOK_SECRET: SECRET,
    ADMIN_TOKEN: ADMIN,
    LICENSE_SIGNING_PRIVATE_KEY: PAIR.privateKeyDerBase64,
    OPENROUTER_PROVISIONING_KEY: 'pk-test-accounts',
    GIFT_EVENT_ID: 'special-test',
    WORKOS_API_KEY: WORKOS_KEY,
    WORKOS_API_BASE: workosBase,
    ACCOUNT_AUTH_REDIRECT_URI: REDIRECT,
    RAU_OPENROUTER_KEY: RAU_KEY,
    OPENROUTER_API_BASE: 'http://127.0.0.1:9/api/v1',
    ...env,
  }, {
    log: (line) => lines.push(line),
    emailProvider: { name: 'test', async send() { return { status: 'sent' }; } },
    alertProvider: null,
    now: () => clock.now,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); return new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;

  const post = (route, body, headers = {}) => fetch(`${origin}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
  const bearer = (token) => ({ Authorization: `Bearer ${token}` });
  const json = async (res) => ({ status: res.status, body: await res.json() });
  const admin = (route, body) => post(route, body, bearer(ADMIN)).then((r) => r.json());
  const adminGet = (route) => fetch(`${origin}${route}`, { headers: bearer(ADMIN) }).then((r) => r.json());

  /** POST /auth/start; resolves to the login id (WorkOS `state`) and the PKCE pair. */
  async function start(fields = {}) {
    const pair = pkce();
    const appState = `app-${randomBytes(12).toString('hex')}`;
    const res = await json(await post('/v1/account/auth/start', { provider: 'google', challenge: pair.challenge, port: 49152, state: appState, ...fields }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return { ...pair, appState, url: new URL(res.body.url), loginId: new URL(res.body.url).searchParams.get('state'), res };
  }
  /** The WorkOS redirect onto our callback; resolves to the status and the loopback URL it sends the browser to. */
  async function callback(query) {
    const res = await fetch(`${origin}/v1/account/auth/callback?${new URLSearchParams(query)}`, { redirect: 'manual' });
    const location = res.headers.get('location');
    return { status: res.status, location: location ? new URL(location) : null, text: await res.text(), headers: res.headers };
  }
  /** start → AuthKit → callback; resolves to the grant and what the token call needs. */
  async function authorize(user = { email: 'buyer@example.com' }) {
    const login = await start();
    const back = await callback({ code: workos.signIn(user), state: login.loginId });
    assert.equal(back.status, 302, back.text);
    return { ...login, code: back.location.searchParams.get('code'), back };
  }
  const token = (body) => post('/v1/account/auth/token', body).then(json);
  /** A whole sign-in on one device; resolves to the token answer's body. */
  async function signIn(user, dev = device(1)) {
    const grant = await authorize(user);
    const res = await token({ code: grant.code, verifier: grant.verifier, device: dev });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  }
  const refresh = (session, body = {}) => post('/v1/account/refresh', body, bearer(session)).then(json);
  async function buy(event) {
    const result = await (await signedGroblePost(origin, SECRET, event)).json();
    assert.equal(result.action, 'issued', JSON.stringify(result));
    return result;
  }
  return {
    origin, directory, workos, workosBase, clock, lines, post, bearer, json, admin, adminGet,
    start, callback, authorize, token, signIn, refresh, buy,
    stored: async () => JSON.parse(await fs.readFile(path.join(directory, 'accounts.json'), 'utf8')),
    licensesFile: async () => JSON.parse(await fs.readFile(path.join(directory, 'licenses.json'), 'utf8')),
    rauStatus: (lease) => fetch(`${origin}/v1/rau/status`, { headers: bearer(lease) }).then(json),
    startTrial: (session) => post('/v1/account/rau-trial', {}, bearer(session)).then(json),
    giftStatus: (lease) => fetch(`${origin}/v1/gift/status`, { headers: bearer(lease) }).then(json),
  };
}

test('config: defaults, provider and device-limit checks fail startup on a typo', () => {
  const config = resolveAccountConfig({});
  assert.deepEqual(config, {
    apiKey: '',
    clientId: 'client_01M66W83D02NGE62TDVKR8PW8S',
    apiBase: 'https://api.workos.com',
    redirectUri: 'https://rau-credits-production.up.railway.app/v1/account/auth/callback',
    providers: ['email', 'google'],
    deviceLimit: 5,
  });
  assert.deepEqual(resolveAccountConfig({ ACCOUNT_AUTH_PROVIDERS: 'google', ACCOUNT_DEVICE_LIMIT: '3' }).providers, ['google']);
  assert.throws(() => resolveAccountConfig({ ACCOUNT_AUTH_PROVIDERS: 'email,kakao' }), /kakao/);
  assert.throws(() => resolveAccountConfig({ ACCOUNT_AUTH_PROVIDERS: 'email,google,apple' }), /apple/);
  assert.throws(() => resolveAccountConfig({ ACCOUNT_AUTH_PROVIDERS: 'github' }), /github/);
  assert.throws(() => resolveAccountConfig({ ACCOUNT_DEVICE_LIMIT: '21' }), /ACCOUNT_DEVICE_LIMIT/);
  assert.throws(() => resolveAccountConfig({ ACCOUNT_AUTH_REDIRECT_URI: 'http://example.com/cb' }), /https/);
});

test('account leases: v2 signs and verifies with every reason, and neither version accepts the other', () => {
  const key = parseSigningPrivateKey(PAIR.privateKeyDerBase64);
  const keys = { 'hama-prod-1': PAIR.publicKeyRawBase64 };
  const { lease, payload } = signAccountLease({ accountId: 'acct_1', deviceId: 'device-0001', keyId: 'lic_1', tier: 'basic', plan: 'monthly', now: T0, licenseExpiresAt: T0 + 30 * DAY }, key);
  assert.deepEqual(payload, { v: 2, kid: 'hama-prod-1', accountId: 'acct_1', deviceId: 'device-0001', keyId: 'lic_1', tier: 'basic', plan: 'monthly', issuedAt: T0, expiresAt: T0 + 7 * DAY, licenseExpiresAt: T0 + 30 * DAY });
  assert.deepEqual(verifyAccountLease(lease, keys, { deviceId: 'device-0001', accountId: 'acct_1', now: T0 + DAY }), { ok: true, payload });
  const reason = (l, opts = {}) => verifyAccountLease(l, keys, { now: T0 + DAY, ...opts }).reason;
  assert.equal(reason(lease, { deviceId: 'other-device' }), 'wrong_device');
  assert.equal(reason(lease, { accountId: 'acct_2' }), 'wrong_account');
  assert.equal(reason(lease, { now: T0 + 8 * DAY }), 'expired');
  assert.equal(reason(lease, { now: T0 - DAY }), 'not_yet_valid');
  assert.equal(verifyAccountLease(lease, { other: PAIR.publicKeyRawBase64 }, { now: T0 }).reason, 'unknown_kid');
  assert.equal(reason(`${lease.split('.')[0]}.${Buffer.alloc(64).toString('base64url')}`), 'bad_signature');
  assert.equal(reason('nope'), 'malformed');
  const free = signAccountLease({ accountId: 'acct_1', deviceId: 'device-0001', now: T0 }, key);
  assert.deepEqual([free.payload.keyId, free.payload.tier, free.payload.plan], [null, 'free', null]);

  const v1 = signLease({ keyId: 'lic_1', key: 'HAMA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA', deviceId: 'device-0001', now: T0 }, key).lease;
  assert.equal(verifyLease(v1, keys, { now: T0 }).ok, true);
  assert.equal(verifyLease(lease, keys, { now: T0 }).reason, 'malformed');
  assert.equal(reason(v1), 'malformed');
});

test('without WORKOS_API_KEY every account route answers accounts_not_configured', async (t) => {
  const s = await setup(t, { WORKOS_API_KEY: '' });
  for (const [method, route] of [['GET', '/v1/account/auth/providers'], ['POST', '/v1/account/auth/start'], ['GET', '/v1/account/auth/callback?code=x&state=y'], ['POST', '/v1/account/auth/token'], ['POST', '/v1/account/refresh'], ['POST', '/v1/account/signout'], ['POST', '/v1/account/devices/remove']]) {
    const res = await fetch(`${s.origin}${route}`, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.deepEqual([res.status, await res.json()], [503, { ok: false, error: 'accounts_not_configured' }], route);
  }
});

test('start validates its input and builds the AuthKit URL; providers come from env', async (t) => {
  const s = await setup(t);
  assert.deepEqual(await (await fetch(`${s.origin}/v1/account/auth/providers`)).json(), { ok: true, providers: ['email', 'google'] });
  const login = await s.start({ provider: 'email', loginHint: 'me@example.com' });
  assert.equal(login.res.body.expiresAt, T0 + 10 * MINUTE);
  assert.equal(`${login.url.origin}${login.url.pathname}`, `${s.workosBase}/user_management/authorize`);
  assert.deepEqual(Object.fromEntries(login.url.searchParams), {
    response_type: 'code', client_id: DEFAULT_WORKOS_CLIENT_ID, redirect_uri: REDIRECT, provider: 'authkit', state: login.loginId, login_hint: 'me@example.com',
  });
  assert.match(login.loginId, /^[A-Za-z0-9_-]{32}$/);
  assert.equal((await s.start({ provider: 'google' })).url.searchParams.get('provider'), 'GoogleOAuth');
  // 가입은 AuthKit 화면만 가입 쪽으로 연다. Google 에는 그런 화면이 없다.
  assert.equal((await s.start({ provider: 'email', intent: 'sign_up' })).url.searchParams.get('screen_hint'), 'sign-up');
  assert.equal((await s.start({ provider: 'email', intent: 'sign_in' })).url.searchParams.has('screen_hint'), false);
  assert.equal((await s.start({ provider: 'google', intent: 'sign_up' })).url.searchParams.has('screen_hint'), false);
  const stored = (await s.stored()).logins[login.loginId];
  assert.deepEqual(stored, { challenge: login.challenge, port: 49152, appState: login.appState, provider: 'email', createdAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 10 * MINUTE).toISOString() });

  const good = { provider: 'google', challenge: pkce().challenge, port: 49152, state: 'app-state-0123456789' };
  const refused = async (body) => (await s.json(await s.post('/v1/account/auth/start', body))).body;
  for (const provider of ['apple', 'kakao']) {
    assert.deepEqual(await refused({ ...good, provider }), { ok: false, error: 'provider_unavailable' }, provider);
  }
  for (const [field, value] of [['provider', ''], ['challenge', 'short'], ['port', 80], ['port', '49152'], ['state', 'short'], ['loginHint', 'not-an-email'], ['intent', 'register']]) {
    assert.deepEqual(await refused({ ...good, [field]: value }), { ok: false, error: 'invalid', field }, `${field}=${value}`);
  }
});

test('the callback exchanges the code, stores the account and sends the browser to the loopback with a grant', async (t) => {
  const s = await setup(t);
  const login = await s.start();
  const code = s.workos.signIn({ id: 'user_g1', email: 'Buyer@Example.com', firstName: '희망', lastName: '하' });
  const back = await s.callback({ code, state: login.loginId });
  assert.equal(back.status, 302);
  assert.equal(`${back.location.origin}${back.location.pathname}`, 'http://127.0.0.1:49152/auth/callback');
  const grant = back.location.searchParams.get('code');
  assert.match(grant, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(back.location.searchParams.get('state'), login.appState);
  assert.equal(back.headers.get('cache-control'), 'no-store');

  const exchange = s.workos.calls.find((c) => c.path === '/user_management/authenticate');
  assert.deepEqual(exchange.body, { client_id: DEFAULT_WORKOS_CLIENT_ID, client_secret: WORKOS_KEY, grant_type: 'authorization_code', code });
  const stored = await s.stored();
  const [account] = Object.values(stored.accounts);
  assert.match(account.id, /^acct_[0-9a-f]{18}$/);
  assert.deepEqual(
    [account.workosUserId, account.email, account.emailLower, account.emailVerified, account.name, account.nameSource, account.provider, account.avatar],
    ['user_g1', 'Buyer@Example.com', 'buyer@example.com', true, '희망 하', 'provider', 'google', null],
  );
  assert.deepEqual([stored.byWorkosUser, stored.byEmail, stored.logins], [{ user_g1: account.id }, { 'buyer@example.com': account.id }, {}]);
  const grantHash = createHash('sha256').update(grant).digest('hex');
  assert.deepEqual(stored.grants[grantHash], { accountId: account.id, challenge: login.challenge, createdAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 10 * MINUTE).toISOString(), attempts: 0 });
  const logged = s.lines.join('\n');
  for (const secret of [code, grant, 'Buyer@Example.com', 'buyer@example.com', WORKOS_KEY]) assert.ok(!logged.includes(secret), 'never logged');

  // The login is single use: the same state again is unknown.
  const again = await s.callback({ code: s.workos.signIn({ email: 'x@example.com' }), state: login.loginId });
  assert.equal(again.status, 400);
});

test('WorkOS errors and a cancelled sign-in go back to the app as error codes', async (t) => {
  const s = await setup(t);
  const cancelled = await s.start();
  const denied = await s.callback({ error: 'access_denied', error_description: 'The user denied', state: cancelled.loginId });
  assert.deepEqual([denied.status, Object.fromEntries(denied.location.searchParams)], [302, { error: 'auth_cancelled', state: cancelled.appState }]);
  const failed = await s.start();
  const refused = await s.callback({ code: 'code_unknown', state: failed.loginId });
  assert.deepEqual(Object.fromEntries(refused.location.searchParams), { error: 'auth_failed', state: failed.appState });
  const other = await s.start();
  assert.equal((await s.callback({ error: 'server_error', state: other.loginId })).location.searchParams.get('error'), 'auth_failed');
  assert.deepEqual((await s.stored()).accounts, {});
});

test('an unknown or expired login answers a small Korean page and no redirect', async (t) => {
  const s = await setup(t);
  const unknown = await s.callback({ code: 'x', state: 'no-such-login' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.location, null);
  assert.match(unknown.headers.get('content-type'), /^text\/html/);
  assert.match(unknown.text, /로그인 시간이 지났어요/);
  assert.match(unknown.text, /앱에서 다시 시도해 주세요/);
  assert.doesNotMatch(unknown.text, /<(script|img|link)\b/);

  const login = await s.start();
  s.clock.now += 11 * MINUTE;
  const expired = await s.callback({ code: s.workos.signIn({ email: 'late@example.com' }), state: login.loginId });
  assert.equal(expired.status, 400);
  assert.equal(s.workos.calls.filter((c) => c.path === '/user_management/authenticate').length, 0, 'an expired login never exchanges its code');
});

test('token: the grant is PKCE-bound, single use, capped at 10 attempts and expires', async (t) => {
  const s = await setup(t);
  const a = await s.authorize();
  assert.deepEqual(await s.token({ code: a.code, verifier: pkce().verifier, device: device(1) }), { status: 400, body: { ok: false, error: 'grant_invalid' } });
  const ok = await s.token({ code: a.code, verifier: a.verifier, device: device(1) });
  assert.equal(ok.status, 200);
  assert.match(ok.body.session, /^hes_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await s.token({ code: a.code, verifier: a.verifier, device: device(1) }), { status: 400, body: { ok: false, error: 'grant_invalid' } });
  const stored = await s.stored();
  assert.deepEqual(stored.grants, {});
  assert.deepEqual(Object.keys(stored.sessions), [createHash('sha256').update(ok.body.session).digest('hex')]);

  const b = await s.authorize();
  for (let i = 0; i < 10; i += 1) assert.equal((await s.token({ code: b.code, verifier: pkce().verifier, device: device(2) })).body.error, 'grant_invalid');
  assert.equal((await s.token({ code: b.code, verifier: b.verifier, device: device(2) })).body.error, 'grant_invalid', 'the 11th attempt finds no grant');

  const c = await s.authorize();
  s.clock.now += 11 * MINUTE;
  assert.equal((await s.token({ code: c.code, verifier: c.verifier, device: device(3) })).body.error, 'grant_invalid');
  assert.deepEqual((await s.token({ code: 'x', verifier: c.verifier, device: { id: 'bad id' } })).body, { ok: false, error: 'invalid', field: 'device' });
});

test('the token answer is the whole account payload with a v2 lease', async (t) => {
  const s = await setup(t);
  const body = await s.signIn({ email: 'new@example.com', firstName: '', lastName: '' }, device(1, { name: ' 맥북\u0007 에어 ', appVersion: '2.1.0' }));
  const keys = { 'hama-prod-1': PAIR.publicKeyRawBase64 };
  const verified = verifyAccountLease(body.lease, keys, { deviceId: 'device-0001', accountId: body.account.id, now: T0 });
  assert.equal(verified.ok, true);
  assert.deepEqual(body, {
    ok: true,
    session: body.session,
    account: { id: body.account.id, email: 'new@example.com', name: 'new', avatar: null, provider: 'google', createdAt: new Date(T0).toISOString() },
    plan: { tier: 'free', keyId: null, edition: null, plan: null, expiresAt: null, autoRenew: null, paymentFailed: false, paymentGraceEndsAt: null, manageUrl: null, rau: NO_RAU },
    trial: { state: 'available', startedAt: null, endsAt: null, days: 7 },
    licenses: [],
    devices: [{ id: 'device-0001', name: '맥북 에어', platform: 'darwin', appVersion: '2.1.0', addedAt: T0, lastSeenAt: T0, current: true }],
    deviceLimit: 5,
    stats: { agentSessions: 0, documentsEdited: 0, since: T0 },
    lease: body.lease,
    leaseExpiresAt: T0 + 7 * DAY,
  });
  assert.deepEqual([verified.payload.keyId, verified.payload.tier, verified.payload.plan], [null, 'free', null]);
});

test('devices: limit 409 with the list, replace with replaceDeviceId, unknown replace id 404, same device keeps one slot', async (t) => {
  const s = await setup(t, { ACCOUNT_DEVICE_LIMIT: '2' });
  const user = { id: 'user_d', email: 'devices@example.com' };
  const first = await s.signIn(user, device(1));
  s.clock.now += MINUTE;
  const second = await s.signIn(user, device(2));
  assert.deepEqual(second.devices.map((d) => [d.id, d.current]), [['device-0002', true], ['device-0001', false]]);

  // The same device again replaces its session and keeps one slot.
  const again = await s.signIn(user, device(1, { appVersion: '2.2.0' }));
  assert.deepEqual(again.devices.map((d) => d.id).sort(), ['device-0001', 'device-0002']);
  assert.equal(again.devices.find((d) => d.id === 'device-0001').addedAt, T0);
  assert.deepEqual(await s.refresh(first.session), { status: 401, body: { ok: false, error: 'session_invalid' } });
  assert.equal((await s.refresh(again.session)).status, 200);

  const third = await s.authorize(user);
  const limited = await s.token({ code: third.code, verifier: third.verifier, device: device(3) });
  assert.equal(limited.status, 409);
  assert.deepEqual([limited.body.error, limited.body.limit, limited.body.devices.map((d) => d.id).sort()], ['device_limit', 2, ['device-0001', 'device-0002']]);
  assert.ok(limited.body.devices.every((d) => d.current === false && typeof d.lastSeenAt === 'number'));
  assert.deepEqual(await s.token({ code: third.code, verifier: third.verifier, device: device(3), replaceDeviceId: 'device-9999' }), { status: 404, body: { ok: false, error: 'device_not_found' } });
  const replaced = await s.token({ code: third.code, verifier: third.verifier, device: device(3), replaceDeviceId: 'device-0002' });
  assert.equal(replaced.status, 200, 'the grant survived both refusals');
  assert.deepEqual(replaced.body.devices.map((d) => d.id).sort(), ['device-0001', 'device-0003']);
  assert.deepEqual(await s.refresh(second.session), { status: 401, body: { ok: false, error: 'session_invalid' } });
  assert.equal(Object.keys((await s.stored()).sessions).length, 2);
});

test('removing a device revokes its session; removing your own signs you out; signout is idempotent', async (t) => {
  const s = await setup(t);
  const user = { id: 'user_r', email: 'remove@example.com' };
  const mac = await s.signIn(user, device(1));
  const pc = await s.signIn(user, device(2, { platform: 'win32' }));
  const removed = await s.json(await s.post('/v1/account/devices/remove', { deviceId: 'device-0002' }, s.bearer(mac.session)));
  assert.deepEqual([removed.status, removed.body.ok, removed.body.signedOut, removed.body.devices.map((d) => d.id)], [200, true, false, ['device-0001']]);
  assert.deepEqual(await s.refresh(pc.session), { status: 401, body: { ok: false, error: 'session_invalid' } });
  assert.deepEqual((await s.json(await s.post('/v1/account/devices/remove', { deviceId: 'device-0002' }, s.bearer(mac.session)))).body, { ok: false, error: 'device_not_found' });

  const self = await s.json(await s.post('/v1/account/devices/remove', { deviceId: 'device-0001' }, s.bearer(mac.session)));
  assert.deepEqual(self, { status: 200, body: { ok: true, signedOut: true } });
  assert.equal((await s.refresh(mac.session)).status, 401);

  const again = await s.signIn(user, device(3));
  for (let i = 0; i < 2; i += 1) {
    assert.deepEqual(await s.json(await s.post('/v1/account/signout', {}, s.bearer(again.session))), { status: 200, body: { ok: true } });
  }
  assert.deepEqual(await s.json(await s.post('/v1/account/signout', {}, s.bearer('nonsense'))), { status: 200, body: { ok: true } });
  assert.equal((await s.refresh(again.session)).status, 401);
  const stored = await s.stored();
  assert.deepEqual([stored.sessions, Object.values(stored.accounts)[0].devices], [{}, {}]);
});

test('refresh writes lastSeenAt at most hourly, updates the app version, and a session idle for 180 days is invalid', async (t) => {
  const s = await setup(t);
  const body = await s.signIn({ email: 'idle@example.com' });
  const deviceOf = async () => Object.values((await s.stored()).accounts)[0].devices['device-0001'];
  s.clock.now += 30 * MINUTE;
  assert.equal((await s.refresh(body.session)).status, 200);
  assert.equal((await deviceOf()).lastSeenAt, new Date(T0).toISOString(), 'no write within the hour');
  const updated = await s.refresh(body.session, { appVersion: '2.3.0' });
  assert.equal(updated.body.devices[0].appVersion, '2.3.0');
  s.clock.now += 2 * 60 * MINUTE;
  await s.refresh(body.session);
  assert.equal((await deviceOf()).lastSeenAt, new Date(s.clock.now).toISOString());
  s.clock.now += 181 * DAY;
  assert.deepEqual(await s.refresh(body.session), { status: 401, body: { ok: false, error: 'session_invalid' } });
  // Its slot is free for the next sign-in.
  const next = await s.signIn({ email: 'idle@example.com' }, device(2));
  assert.deepEqual(next.devices.map((d) => d.id), ['device-0002']);
});

test('licenses link by verified email only, and a webhook purchase attaches to the verified account', async (t) => {
  const s = await setup(t);
  const manual = await s.admin('/v1/admin/licenses/issue', { email: 'Owner@Example.com', note: 'old key' });
  await s.admin('/v1/admin/licenses/issue', { email: 'stranger@example.com' });
  const revoked = await s.admin('/v1/admin/licenses/issue', { email: 'owner@example.com' });
  await s.admin('/v1/admin/licenses/revoke', { keyId: revoked.license.keyId });

  const unverified = await s.signIn({ id: 'user_u', email: 'owner@example.com', verified: false }, device(1));
  assert.deepEqual([unverified.licenses, unverified.plan.tier], [[], 'free']);
  assert.deepEqual((await s.stored()).byEmail, {});
  // A purchase with an unverified account's email is not attached either.
  await s.buy(planPaid({ merchantUid: 'pro_u', ref: 'ref-u', email: 'owner@example.com' }));
  assert.equal(Object.values((await s.licensesFile()).licenses).filter((l) => l.accountId).length, 0);

  // The same WorkOS user verifies the email: the next sign-in links the manual key and the Hama key.
  const verified = await s.signIn({ id: 'user_u', email: 'owner@example.com', verified: true }, device(1));
  assert.equal(verified.account.id, unverified.account.id);
  assert.deepEqual(verified.licenses.map((l) => [l.linkedBy, l.edition, l.primary]), [['email', 'hama', true], ['email', null, false]]);
  assert.deepEqual([verified.plan.tier, verified.plan.edition, verified.plan.plan, verified.plan.rau, verified.plan.manageUrl], ['hama', 'hama', 'monthly', NO_RAU, 'https://groble.im/manage/purchase']);
  assert.match(verified.licenses[1].maskedKey, /^HAMA-[0-9A-Z]{5}-•••••-•••••-•••••-[0-9A-Z]{5}$/);
  assert.equal(verified.licenses[1].keyId, manual.license.keyId);
  const file = await s.licensesFile();
  assert.equal(file.licenses[revoked.license.keyId].accountId, undefined, 'revoked keys stay out');

  // A later purchase with the verified email attaches at once.
  await s.buy(planPaid({ merchantUid: 'pro_2', ref: 'ref-2', email: 'OWNER@example.com' }));
  const after = await s.refresh(verified.session);
  assert.deepEqual(after.body.licenses.map((l) => l.linkedBy).sort(), ['email', 'email', 'purchase']);
  const purchased = Object.values((await s.licensesFile()).licenses).find((l) => l.merchantUid === 'pro_2');
  assert.deepEqual([purchased.accountId, purchased.linkedBy], [verified.account.id, 'purchase']);

  // Another verified email signing in through the same email address finds the same account.
  const sameEmail = await s.signIn({ id: 'user_other', email: 'owner@example.com' }, device(2));
  assert.equal(sameEmail.account.id, verified.account.id);
  assert.equal((await s.stored()).byWorkosUser.user_other, verified.account.id);
});

test('a v2 lease reaches the gift and Rau with the license each purpose needs, and stops after its device is removed', async (t) => {
  const s = await setup(t);
  await s.admin('/v1/admin/licenses/issue-beta', { name: '테스터', email: 'mixed@example.com' });
  await s.buy(planPaid({ merchantUid: 'hama_mix', ref: 'ref-mix', email: 'mixed@example.com' }));
  const mixed = await s.signIn({ email: 'mixed@example.com' }, device(1));
  assert.deepEqual([mixed.plan.tier, mixed.plan.edition, mixed.plan.rau], ['hama', 'hama', NO_RAU], 'the Hama subscription is primary over the beta key');
  const gift = await s.giftStatus(mixed.lease);
  assert.deepEqual([gift.status, gift.body.eligible], [200, true], 'the gift picks the beta key');
  const notRau = (await s.rauStatus(mixed.lease)).body;
  assert.deepEqual([notRau.eligible, notRau.reason, notRau.remainingPercent], [false, 'rau_plan_required', null]);

  const rauUser = await s.signIn({ email: 'rau@example.com' }, device(2));
  await s.buy(planPaid({ sku: 'rauMonthly', merchantUid: 'rau_1', ref: 'ref-rau', email: 'rau@example.com' }));
  const refreshed = (await s.refresh(rauUser.session)).body;
  assert.deepEqual([refreshed.plan.tier, refreshed.plan.edition, refreshed.plan.rau], ['rau', 'rau', { eligible: true, source: 'plan', remainingPercent: 100, resetsAt: RAU_RESETS_AT }]);
  const rau = (await s.rauStatus(refreshed.lease)).body;
  assert.deepEqual([rau.eligible, rau.source, rau.remainingPercent], [true, 'plan', 100]);
  assert.equal((await s.giftStatus(refreshed.lease)).body.eligible, false);

  // A free account: Rau answers rau_plan_required, the gift refuses the lease.
  const free = await s.signIn({ email: 'free@example.com' }, device(3));
  assert.deepEqual([(await s.rauStatus(free.lease)).body.eligible, (await s.rauStatus(free.lease)).body.reason], [false, 'rau_plan_required']);
  assert.equal((await s.giftStatus(free.lease)).status, 401);

  await s.post('/v1/account/devices/remove', { deviceId: 'device-0001' }, s.bearer(mixed.session));
  for (const check of [s.giftStatus, s.rauStatus]) assert.equal((await check(mixed.lease)).status, 401);
  s.clock.now += 8 * DAY;
  assert.equal((await s.rauStatus(refreshed.lease)).status, 401, 'an expired v2 lease');
});

test('v1 license leases keep working unchanged, and never carry a trial', async (t) => {
  const s = await setup(t);
  for (const [sku, eligible] of [['hamaMonthly', false], ['rauMonthly', true]]) {
    await s.buy(planPaid({ sku, merchantUid: `v1_${sku}`, ref: `ref-v1-${sku}`, email: 'v1@example.com' }));
    const { key } = await (await fetch(`${s.origin}/v1/license/by-ref?ref=ref-v1-${sku}`)).json();
    const activated = await (await s.post('/v1/license/activate', { key, deviceId: `mac-v1-${sku}`, platform: 'darwin' })).json();
    assert.equal(JSON.parse(Buffer.from(activated.lease.split('.')[0], 'base64url')).v, 1);
    const rau = await s.rauStatus(activated.lease);
    assert.deepEqual([rau.status, rau.body.eligible, rau.body.remainingPercent], [200, eligible, eligible ? 100 : null], sku);
    assert.equal((await s.giftStatus(activated.lease)).body.eligible, false);
  }
  // The account's trial belongs to its account lease only.
  const me = await s.signIn({ email: 'v1@example.com' }, device(1));
  await s.startTrial(me.session);
  await s.buy(planPaid({ merchantUid: 'v1_more', ref: 'ref-v1-more', email: 'other-v1@example.com' }));
  const { key } = await (await fetch(`${s.origin}/v1/license/by-ref?ref=ref-v1-more`)).json();
  const lease = (await (await s.post('/v1/license/activate', { key, deviceId: 'mac-v1-more', platform: 'darwin' })).json()).lease;
  assert.equal((await s.rauStatus(lease)).body.eligible, false);
});

test('admin lookup by email, id and key shows the account without sessions or grants', async (t) => {
  const s = await setup(t);
  await s.buy(planPaid({ merchantUid: 'pro_adm', ref: 'ref-adm', email: 'admin-view@example.com' }));
  const body = await s.signIn({ id: 'user_adm', email: 'admin-view@example.com' }, device(1));
  const byEmail = await s.adminGet('/v1/admin/accounts?email=ADMIN-VIEW@example.com');
  const keyId = body.licenses[0].keyId;
  assert.deepEqual(await s.adminGet(`/v1/admin/accounts?keyId=${keyId}`), byEmail);
  assert.deepEqual(await s.adminGet(`/v1/admin/accounts?id=${body.account.id}`), byEmail);
  const [view] = byEmail.accounts;
  assert.deepEqual([view.id, view.workosUserId, view.emailVerified, view.devices.map((d) => d.id), view.licenses.map((l) => l.keyId)], [body.account.id, 'user_adm', true, ['device-0001'], [keyId]]);
  const text = JSON.stringify(byEmail);
  assert.ok(!text.includes('sessionHash') && !text.includes(body.session) && !text.includes(createHash('sha256').update(body.session).digest('hex')));
  assert.equal((await fetch(`${s.origin}/v1/admin/accounts?email=x`)).status, 403);
  assert.deepEqual(await s.adminGet('/v1/admin/licenses?keyId=' + keyId).then((r) => [r.licenses[0].accountId, r.licenses[0].linkedBy]), [body.account.id, 'email']);
});

// ------------------------------------------------------------ licenses

/** A Hama (or Rau) purchase with its own email; resolves to the raw key and its key id. */
async function bought(s, { n, email = `buyer${n}@groble.example`, sku = 'hamaMonthly' } = {}) {
  const event = planPaid({ sku, merchantUid: `order_${n}`, ref: `ref-${n}`, email });
  await s.buy(event);
  const [license] = (await s.adminGet(`/v1/admin/licenses?ref=ref-${n}`)).licenses;
  return { key: license.key, keyId: license.keyId, merchantUid: `order_${n}`, email };
}

test('redeem links a typed key once, and refuses bad formats, unknown, revoked and other accounts\' keys', async (t) => {
  const s = await setup(t);
  const me = await s.signIn({ email: 'me@example.com' }, device(1));
  const other = await s.signIn({ email: 'other@example.com' }, device(2));
  const redeem = (session, key) => s.post('/v1/account/redeem', { key }, s.bearer(session)).then(s.json);
  const pro = await bought(s, { n: 1 });

  const first = await redeem(me.session, ` ${pro.key.toLowerCase().replace(/-/g, ' ')} `);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual([first.body.alreadyLinked, first.body.license.keyId, first.body.license.linkedBy, first.body.license.primary, first.body.plan.tier], [false, pro.keyId, 'redeem', true, 'hama']);
  assert.equal(first.body.license.maskedKey, `${pro.key.slice(0, 10)}-•••••-•••••-•••••-${pro.key.slice(-5)}`);
  assert.ok(!JSON.stringify(first.body).includes(pro.key), 'the full key never comes back');
  assert.equal(typeof first.body.lease, 'string');
  const again = await redeem(me.session, pro.key);
  assert.deepEqual([again.status, again.body.alreadyLinked, again.body.licenses.length], [200, true, 1]);

  assert.deepEqual(await redeem(other.session, pro.key), { status: 409, body: { ok: false, error: 'key_linked_elsewhere' } });
  assert.deepEqual(await redeem(me.session, 'HAMA-12345'), { status: 400, body: { ok: false, error: 'invalid_format' } });
  assert.deepEqual(await redeem(me.session, 42), { status: 400, body: { ok: false, error: 'invalid_format' } });
  assert.deepEqual(await redeem(me.session, 'HAMA-00000-00000-00000-00000-00000'), { status: 404, body: { ok: false, error: 'invalid_key' } });
  const revoked = await bought(s, { n: 2 });
  await s.admin('/v1/admin/licenses/revoke', { keyId: revoked.keyId });
  assert.deepEqual(await redeem(me.session, revoked.key), { status: 403, body: { ok: false, error: 'revoked' } });
  assert.deepEqual(await redeem('hes_nope', pro.key), { status: 401, body: { ok: false, error: 'session_invalid' } });
});

test('claim links an order bought with another email by order number and Groble email, without telling which part was wrong', async (t) => {
  const s = await setup(t);
  const me = await s.signIn({ email: 'me@example.com' }, device(1));
  const other = await s.signIn({ email: 'other@example.com' }, device(2));
  const claim = (session, orderId, email) => s.post('/v1/account/claim', { orderId, email }, s.bearer(session)).then(s.json);
  const pro = await bought(s, { n: 1, email: 'Groble.Buyer@example.com' });

  const notFound = { status: 404, body: { ok: false, error: 'order_not_found' } };
  assert.deepEqual(await claim(me.session, pro.merchantUid, 'me@example.com'), notFound, 'wrong email');
  assert.deepEqual(await claim(me.session, 'order_404', 'groble.buyer@example.com'), notFound, 'unknown order');
  assert.deepEqual(await claim(me.session, '', ''), notFound);
  const ok = await claim(me.session, pro.merchantUid, ' GROBLE.BUYER@example.com ');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.alreadyLinked, ok.body.license.keyId, ok.body.license.linkedBy, ok.body.plan.tier], [false, pro.keyId, 'claim', 'hama']);
  assert.equal((await claim(me.session, pro.merchantUid, 'groble.buyer@example.com')).body.alreadyLinked, true);
  assert.deepEqual(await claim(other.session, pro.merchantUid, 'groble.buyer@example.com'), { status: 409, body: { ok: false, error: 'key_linked_elsewhere' } });

  // A held order (wrong price) has no key yet.
  const held = planPaid({ merchantUid: 'order_held', ref: 'ref-held', email: 'held@example.com', price: 1000 });
  assert.equal((await (await signedGroblePost(s.origin, SECRET, held)).json()).action, 'held');
  assert.deepEqual(await claim(me.session, 'order_held', 'held@example.com'), { status: 409, body: { ok: false, error: 'order_not_ready' } });
  assert.deepEqual(await claim(me.session, 'order_held', 'someone@example.com'), notFound, 'a held order needs the right email too');
});

test('redeem and claim are limited per account per hour', async (t) => {
  const s = await setup(t);
  const me = await s.signIn({ email: 'me@example.com' }, device(1));
  const other = await s.signIn({ email: 'other@example.com' }, device(2));
  const redeem = (session) => s.post('/v1/account/redeem', { key: 'HAMA-00000-00000-00000-00000-00000' }, s.bearer(session)).then(s.json);
  const claim = (session) => s.post('/v1/account/claim', { orderId: 'nope', email: 'x@example.com' }, s.bearer(session)).then(s.json);
  for (let i = 0; i < 20; i += 1) assert.equal((await redeem(me.session)).body.error, 'invalid_key');
  assert.deepEqual(await redeem(me.session), { status: 429, body: { ok: false, error: 'rate_limited' } });
  assert.equal((await redeem(other.session)).body.error, 'invalid_key', 'another account has its own budget');
  for (let i = 0; i < 10; i += 1) assert.equal((await claim(me.session)).body.error, 'order_not_found');
  assert.deepEqual(await claim(me.session), { status: 429, body: { ok: false, error: 'rate_limited' } });
  s.clock.now += 61 * MINUTE;
  assert.equal((await redeem(me.session)).body.error, 'invalid_key');
  assert.equal((await claim(me.session)).body.error, 'order_not_found');
});

test('redeeming a Hama and then a Rau key moves the tier, the primary license and the lease with them', async (t) => {
  const s = await setup(t);
  await s.admin('/v1/admin/licenses/issue', { email: 'me@example.com', note: 'lifetime' });
  const me = await s.signIn({ email: 'me@example.com' }, device(1));
  const keys = { 'hama-prod-1': PAIR.publicKeyRawBase64 };
  const leaseOf = (body) => verifyAccountLease(body.lease, keys, { now: s.clock.now }).payload;
  assert.deepEqual([me.plan.tier, leaseOf(me).tier, leaseOf(me).plan, me.plan.autoRenew], ['hama', 'hama', 'lifetime', null], 'every live key is at least Hama');
  const redeem = (key) => s.post('/v1/account/redeem', { key }, s.bearer(me.session)).then(s.json);

  s.clock.now += MINUTE;
  const hama = await bought(s, { n: 1 });
  const withHama = (await redeem(hama.key)).body;
  assert.deepEqual([withHama.plan.tier, withHama.plan.keyId, withHama.plan.autoRenew, leaseOf(withHama).tier, leaseOf(withHama).keyId], ['hama', hama.keyId, true, 'hama', hama.keyId]);
  assert.equal(leaseOf(withHama).licenseExpiresAt, withHama.plan.expiresAt);
  assert.deepEqual(withHama.licenses.map((l) => [l.keyId === hama.keyId, l.primary]), [[true, true], [false, false]]);

  s.clock.now += MINUTE;
  const rau = await bought(s, { n: 2, sku: 'rauMonthly' });
  const withRau = (await redeem(rau.key)).body;
  assert.deepEqual([withRau.plan.tier, withRau.plan.edition, withRau.plan.rau.source, leaseOf(withRau).tier, leaseOf(withRau).keyId], ['rau', 'rau', 'plan', 'rau', rau.keyId]);
  assert.deepEqual(withRau.licenses.map((l) => l.keyId), [rau.keyId, hama.keyId, me.licenses[0].keyId], 'primary first, then newest');
  assert.equal((await s.rauStatus(withRau.lease)).body.eligible, true);
});

test('admin unlink frees a key for good, admin link moves it, and the CLI wraps both', async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const cli = (...args) => promisify(execFile)(process.execPath, [new URL('../scripts/license-admin.mjs', import.meta.url).pathname, ...args], { env: { ...process.env, SITE_API_BASE: s.origin, ADMIN_TOKEN: ADMIN } });
  const s = await setup(t);
  await s.admin('/v1/admin/licenses/issue', { email: 'me@example.com' });
  const me = await s.signIn({ email: 'me@example.com' }, device(1));
  const other = await s.signIn({ email: 'other@example.com' }, device(2));
  const keyId = me.licenses[0].keyId;

  const listed = await cli('accounts', '--email', 'me@example.com');
  assert.match(listed.stdout, new RegExp(`\\n${me.account.id} me@example.com · 기기 1 · 키 ${keyId} active\\n$`));
  const unlinked = await cli('account-unlink', '--key-id', keyId);
  assert.match(unlinked.stdout, /^200 /);
  const file = (await s.licensesFile()).licenses[keyId];
  assert.deepEqual([file.accountId, file.unlinkedBy, typeof file.unlinkedAt], [undefined, 'admin', 'string']);
  // The owner's verified email does not pull it back on refresh.
  assert.deepEqual((await s.refresh(me.session)).body.licenses, []);

  assert.deepEqual(await s.admin('/v1/admin/accounts/link', { keyId, accountId: 'acct_000000000000000000' }), { ok: false, error: 'account_not_found' });
  const linked = await s.admin('/v1/admin/accounts/link', { keyId, accountId: other.account.id });
  assert.deepEqual([linked.ok, linked.license.accountId, linked.license.linkedBy], [true, other.account.id, 'admin']);
  assert.deepEqual((await s.refresh(other.session)).body.licenses.map((l) => [l.keyId, l.linkedBy]), [[keyId, 'admin']]);
  assert.deepEqual(await s.admin('/v1/admin/accounts/unlink', { keyId: 'lic_none' }), { ok: false, error: 'invalid_key' });
  assert.equal((await fetch(`${s.origin}/v1/admin/accounts/unlink`, { method: 'POST', body: JSON.stringify({ keyId }) })).status, 403);
});

// ------------------------------------------------------------- profile

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(64)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), randomBytes(32)]);

function putAvatar(s, session, bytes, type) {
  return fetch(`${s.origin}/v1/account/avatar`, { method: 'PUT', headers: { ...s.bearer(session), 'Content-Type': type }, body: bytes }).then(s.json);
}

test('profile: a user-set name sticks across sign-ins, and a bad one is name_invalid', async (t) => {
  const s = await setup(t);
  const user = { id: 'user_p', email: 'profile@example.com', firstName: 'Provider', lastName: 'Name' };
  const me = await s.signIn(user, device(1));
  assert.equal(me.account.name, 'Provider Name');
  let session = me.session;
  const profile = (name) => s.post('/v1/account/profile', { name }, s.bearer(session)).then(s.json);
  const set = await profile('  하마 편집자 ');
  assert.deepEqual(set, { status: 200, body: { ok: true, account: { ...me.account, name: '하마 편집자' } } });
  const again = await s.signIn(user, device(1));
  assert.equal(again.account.name, '하마 편집자', 'a later sign-in keeps the user name');
  session = again.session;
  assert.equal((await profile('가'.repeat(30))).status, 200);
  for (const bad of ['', '   ', '가'.repeat(31), 'tab\there', 42, null]) {
    assert.deepEqual(await profile(bad), { status: 400, body: { ok: false, error: 'name_invalid' } }, String(bad));
  }
});

test('avatar: upload, serve with its rev, replace with another type, remove; types are sniffed and the size capped', async (t) => {
  const s = await setup(t);
  const me = await s.signIn({ email: 'avatar@example.com' }, device(1));
  const dir = path.join(s.directory, 'avatars');
  const file = (ext) => path.join(dir, `${me.account.id}.${ext}`);
  const get = (headers = {}) => fetch(`${s.origin}/v1/account/avatar`, { headers: { ...s.bearer(me.session), ...headers } });

  assert.deepEqual(await (await get()).json(), { ok: false, error: 'no_avatar' });
  assert.deepEqual(await putAvatar(s, me.session, PNG, 'image/png'), { status: 200, body: { ok: true, avatar: { rev: 1, type: 'image/png', bytes: PNG.length } } });
  assert.equal((await fs.stat(file('png'))).mode & 0o777, 0o600);
  const served = await get();
  assert.deepEqual([served.status, served.headers.get('content-type'), served.headers.get('etag'), served.headers.get('cache-control')], [200, 'image/png', '"1"', 'private, no-cache']);
  assert.ok(Buffer.from(await served.arrayBuffer()).equals(PNG));
  assert.equal((await get({ 'If-None-Match': '"1"' })).status, 304);
  assert.deepEqual((await s.refresh(me.session)).body.account.avatar, { rev: 1, type: 'image/png' });

  assert.deepEqual((await putAvatar(s, me.session, JPEG, 'image/jpeg')).body.avatar, { rev: 2, type: 'image/jpeg', bytes: JPEG.length });
  assert.deepEqual(await fs.readdir(dir), [`${me.account.id}.jpg`], 'the PNG is gone');
  assert.deepEqual((await putAvatar(s, me.session, WEBP, 'image/webp')).body.avatar.type, 'image/webp');

  const unsupported = { status: 415, body: { ok: false, error: 'unsupported_type' } };
  assert.deepEqual(await putAvatar(s, me.session, PNG, 'image/jpeg'), unsupported, 'bytes must match the type');
  assert.deepEqual(await putAvatar(s, me.session, Buffer.from('GIF89a....'), 'image/gif'), unsupported);
  assert.deepEqual(await putAvatar(s, me.session, Buffer.from('<svg/>'), 'image/png'), unsupported);
  const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]);
  assert.deepEqual(await putAvatar(s, me.session, big, 'image/png'), { status: 413, body: { ok: false, error: 'too_large' } });
  // A body declared past twice the cap is refused before it is read.
  const declared = await new Promise((resolve, reject) => {
    const req = http.request(`${s.origin}/v1/account/avatar`, {
      method: 'PUT',
      headers: { ...s.bearer(me.session), 'Content-Type': 'image/png', 'Content-Length': 3 * 1024 * 1024 },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { req.destroy(); resolve({ status: res.statusCode, body: JSON.parse(text), connection: res.headers.connection }); });
    });
    req.on('error', reject);
    req.write(PNG);
  });
  assert.deepEqual(declared, { status: 413, body: { ok: false, error: 'too_large' }, connection: 'close' });
  assert.deepEqual(await putAvatar(s, 'hes_nope', PNG, 'image/png'), { status: 401, body: { ok: false, error: 'session_invalid' } });
  assert.equal((await s.stored()).accounts[me.account.id].avatar.rev, 3, 'refusals change nothing');

  assert.deepEqual(await s.json(await s.post('/v1/account/avatar/remove', {}, s.bearer(me.session))), { status: 200, body: { ok: true } });
  assert.deepEqual(await fs.readdir(dir), []);
  assert.equal((await get()).status, 404);
  assert.equal((await s.refresh(me.session)).body.account.avatar, null);
  assert.equal((await putAvatar(s, me.session, PNG, 'image/png')).body.avatar.rev, 4, 'the rev never goes back');
});

test('stats add up per batch, a repeated batch id is a no-op, and bad counts are refused', async (t) => {
  const s = await setup(t);
  const me = await s.signIn({ email: 'stats@example.com' }, device(1));
  const stats = (body) => s.post('/v1/account/stats', body, s.bearer(me.session)).then(s.json);
  assert.deepEqual(await stats({ batchId: 'batch-0001', agentSessions: 2, documentsEdited: 5 }), {
    status: 200, body: { ok: true, stats: { agentSessions: 2, documentsEdited: 5, since: T0 } },
  });
  assert.equal((await stats({ batchId: 'batch-0001', agentSessions: 2, documentsEdited: 5 })).body.stats.agentSessions, 2, 'a retried flush counts once');
  for (let i = 2; i <= 52; i += 1) await stats({ batchId: `batch-${String(i).padStart(4, '0')}`, agentSessions: 1, documentsEdited: 0 });
  const stored = (await s.stored()).accounts[me.account.id].stats;
  assert.deepEqual([stored.agentSessions, stored.batches.length, stored.batches[0]], [53, 50, 'batch-0003']);
  assert.deepEqual((await s.refresh(me.session)).body.stats, { agentSessions: 53, documentsEdited: 5, since: T0 });
  for (const [body, field] of [
    [{ batchId: 'short', agentSessions: 1, documentsEdited: 1 }, 'batchId'],
    [{ batchId: 'batch-x001', agentSessions: 1001, documentsEdited: 1 }, 'agentSessions'],
    [{ batchId: 'batch-x001', agentSessions: 1, documentsEdited: -1 }, 'documentsEdited'],
    [{ batchId: 'batch-x001', agentSessions: 1.5, documentsEdited: 1 }, 'agentSessions'],
  ]) assert.deepEqual(await stats(body), { status: 400, body: { ok: false, error: 'invalid', field } });
});

// ------------------------------------------------------------ Rau trial

const TRIAL_END = T0 + 7 * DAY;

/** Sets a principal's spend in the given period of rau.json on disk. */
async function seedRauSpend(s, principalId, usedUsd, { start, end, source }) {
  const file = path.join(s.directory, 'rau.json');
  const state = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{}'));
  state.ledgers ??= {};
  state.ledgers[principalId] = { source, period: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), usedUsd, calls: 1 }, ids: {}, totalUsd: usedUsd, calls: 1, lastCallAt: new Date(start).toISOString() };
  await fs.writeFile(file, JSON.stringify(state));
}

test('a trial gives a signed-in account Rau for 7 days with $2, once, and a Hama key stays its primary', async (t) => {
  const s = await setup(t);
  await s.buy(planPaid({ merchantUid: 'hama_t', ref: 'ref-hama-t', email: 'trial@example.com' }));
  const me = await s.signIn({ email: 'trial@example.com' }, device(1));
  assert.deepEqual([me.plan.tier, me.trial.state], ['hama', 'available']);
  const keys = { 'hama-prod-1': PAIR.publicKeyRawBase64 };

  const started = await s.startTrial(me.session);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const body = started.body;
  assert.deepEqual(body.trial, { state: 'active', startedAt: T0, endsAt: TRIAL_END, days: 7 });
  assert.deepEqual([body.plan.tier, body.plan.edition, body.plan.keyId], ['rau', 'hama', body.licenses[0].keyId], 'the trial lifts the tier, the Hama key stays primary');
  assert.deepEqual(body.plan.rau, { eligible: true, source: 'trial', remainingPercent: 100, resetsAt: TRIAL_END });
  assert.equal(verifyAccountLease(body.lease, keys, { now: T0 }).payload.tier, 'rau');
  const status = (await s.rauStatus(body.lease)).body;
  assert.deepEqual([status.eligible, status.source, status.remainingPercent, status.resetsAt], [true, 'trial', 100, new Date(TRIAL_END).toISOString()]);
  assert.equal((await s.stored()).accounts[me.account.id].rauTrial.endsAt, new Date(TRIAL_END).toISOString());

  assert.deepEqual(await s.startTrial(me.session), { status: 409, body: { ok: false, error: 'trial_used' } });
  s.clock.now = TRIAL_END - MINUTE;
  assert.equal((await s.refresh(me.session)).body.trial.state, 'active');
  s.clock.now = TRIAL_END;
  const after = (await s.refresh(me.session)).body;
  assert.deepEqual([after.trial.state, after.plan.tier, after.plan.rau], ['ended', 'hama', NO_RAU]);
  assert.equal(verifyAccountLease(after.lease, keys, { now: TRIAL_END }).payload.tier, 'hama');
  assert.deepEqual([(await s.rauStatus(after.lease)).body.eligible, (await s.rauStatus(after.lease)).body.reason], [false, 'rau_plan_required']);
  assert.deepEqual(await s.startTrial(me.session), { status: 409, body: { ok: false, error: 'trial_used' } });
});

test('a trial ends once its $2 is spent: just under it Rau still runs, at it Rau refuses for credits until the trial end, then for the plan', async (t) => {
  const s = await setup(t);
  const me = await s.signIn({ email: 'spender@example.com' }, device(1));
  const { body } = await s.startTrial(me.session);
  assert.deepEqual([body.plan.tier, body.plan.keyId, body.trial.state], ['rau', null, 'active'], 'a free account gets Rau from the trial alone');
  const period = { start: T0, end: TRIAL_END, source: 'trial' };
  await seedRauSpend(s, me.account.id, 1.99, period);
  const under = (await s.refresh(me.session)).body;
  assert.deepEqual([under.trial.state, under.plan.rau.remainingPercent], ['active', 1]);
  assert.equal((await s.rauStatus(under.lease)).body.remainingPercent, 1);
  await seedRauSpend(s, me.account.id, 2, period);
  const spent = (await s.refresh(me.session)).body;
  assert.deepEqual([spent.trial.state, spent.plan.tier, spent.plan.rau], ['ended', 'free', NO_RAU]);
  const status = (await s.rauStatus(spent.lease)).body;
  assert.deepEqual([status.eligible, status.source, status.remainingPercent, status.resetsAt], [true, 'trial', 0, new Date(TRIAL_END).toISOString()]);
  const learn = await s.post('/v1/rau/learn', { prompt: 'x' }, { authorization: `Bearer ${spent.lease}` });
  assert.deepEqual([learn.status, await learn.json()], [402, { ok: false, error: 'rau_credits_exhausted', resetsAt: new Date(TRIAL_END).toISOString() }]);

  s.clock.now = TRIAL_END;
  const over = (await s.refresh(me.session)).body;
  assert.deepEqual([(await s.rauStatus(over.lease)).body.eligible, (await s.rauStatus(over.lease)).body.reason], [false, 'rau_plan_required']);
  const lateLearn = await s.post('/v1/rau/learn', { prompt: 'x' }, { authorization: `Bearer ${over.lease}` });
  assert.deepEqual([lateLearn.status, (await lateLearn.json()).error], [403, 'rau_plan_required']);
});

test('an email gets one trial, also after its account is deleted', async (t) => {
  const s = await setup(t);
  const first = await s.signIn({ id: 'user_first', email: 'Once@example.com' }, device(1));
  assert.equal((await s.startTrial(first.session)).status, 200);
  assert.deepEqual(await s.post('/v1/account/delete', { confirm: 'once@example.com' }, s.bearer(first.session)).then(s.json), { status: 200, body: { ok: true } });
  const stored = await s.stored();
  assert.equal(Object.keys(stored.trialEmails).length, 1, 'the email record outlives the account');
  assert.ok(!JSON.stringify(stored.trialEmails).includes('once@example.com'), 'stored only as a hash');

  const again = await s.signIn({ id: 'user_second', email: 'once@example.com' }, device(1));
  assert.notEqual(again.account.id, first.account.id);
  assert.deepEqual([again.trial.state, again.trial.startedAt, again.trial.endsAt, again.plan.tier], ['ended', T0, TRIAL_END, 'free']);
  assert.deepEqual(await s.startTrial(again.session), { status: 409, body: { ok: false, error: 'trial_used' } });
});

test('the trial is refused on a live Rau plan, without hosted Rau, and past 10 tries an hour', async (t) => {
  const s = await setup(t);
  await s.buy(planPaid({ sku: 'rauYearly', merchantUid: 'rau_y', ref: 'ref-rau-y', email: 'payer@example.com' }));
  const payer = await s.signIn({ email: 'payer@example.com' }, device(1));
  assert.deepEqual([payer.plan.tier, payer.trial.state], ['rau', 'available']);
  assert.deepEqual(await s.startTrial(payer.session), { status: 409, body: { ok: false, error: 'rau_active' } });
  for (let i = 1; i < 10; i += 1) assert.equal((await s.startTrial(payer.session)).body.error, 'rau_active');
  assert.deepEqual(await s.startTrial(payer.session), { status: 429, body: { ok: false, error: 'rate_limited' } });
  assert.deepEqual(await s.startTrial('hes_nope'), { status: 401, body: { ok: false, error: 'session_invalid' } });

  const off = await setup(t, { RAU_ENABLED: 'false' });
  const me = await off.signIn({ email: 'off@example.com' }, device(1));
  assert.deepEqual(await off.startTrial(me.session), { status: 503, body: { ok: false, error: 'rau_unavailable' } });
  assert.equal((await off.stored()).accounts[me.account.id].rauTrial, undefined);
});

test('a beta key and every other live key put an account on Hama', async (t) => {
  const s = await setup(t);
  await s.admin('/v1/admin/licenses/issue-beta', { name: '테스터', email: 'beta@example.com' });
  const beta = await s.signIn({ email: 'beta@example.com' }, device(1));
  assert.deepEqual([beta.plan.tier, beta.plan.edition, beta.plan.plan, beta.plan.rau], ['hama', null, 'lifetime', NO_RAU]);
  await s.admin('/v1/admin/licenses/issue', { email: 'signature@example.com', edition: 'signature' });
  const signature = await s.signIn({ email: 'signature@example.com' }, device(2));
  assert.deepEqual([signature.plan.tier, signature.plan.edition], ['hama', 'signature']);
});

/** A Groble subscription event for the key bought under `ref`. */
function subscriptionEvent(type, ref, object = {}) {
  return {
    id: `evt_${type}_${ref}`,
    type,
    occurredAt: '2026-10-31T12:00:00+09:00',
    data: { object: { merchantUid: `${type}_${ref}`, sellerReference: ref, content: { paymentType: 'SUBSCRIPTION' }, ...object } },
  };
}

test('delete: typed email, refused while a subscription renews, then everything goes and the keys link to the next account', async (t) => {
  const s = await setup(t);
  await s.admin('/v1/admin/licenses/issue', { email: 'leaving@example.com', note: 'lifetime' });
  await s.buy(planPaid({ merchantUid: 'pro_a', ref: 'ref-a', email: 'leaving@example.com' }));
  await s.buy(planPaid({ sku: 'rauMonthly', merchantUid: 'pro_b', ref: 'ref-b', email: 'leaving@example.com' }));
  const me = await s.signIn({ id: 'user_leaving', email: 'Leaving@example.com' }, device(1));
  const pc = await s.signIn({ id: 'user_leaving', email: 'Leaving@example.com' }, device(2));
  assert.equal(me.licenses.length, 3);
  await putAvatar(s, me.session, PNG, 'image/png');
  await s.post('/v1/account/stats', { batchId: 'batch-0001', agentSessions: 4, documentsEdited: 4 }, s.bearer(me.session));
  const remove = (confirm, session = me.session) => s.post('/v1/account/delete', { confirm }, s.bearer(session)).then(s.json);

  assert.deepEqual(await remove('someone@example.com'), { status: 400, body: { ok: false, error: 'confirm_mismatch' } });
  assert.deepEqual(await remove(''), { status: 400, body: { ok: false, error: 'confirm_mismatch' } });
  const refused = { status: 409, body: { ok: false, error: 'subscription_active', manageUrl: 'https://groble.im/manage/purchase' } };
  assert.deepEqual(await remove(' LEAVING@example.com '), refused);
  assert.equal((await (await signedGroblePost(s.origin, SECRET, subscriptionEvent('subscription.cancel_requested', 'ref-a', { cancelRequest: { requestedAt: '2026-10-31T12:00:00+09:00' } }))).json()).action, 'cancel_recorded');
  assert.deepEqual(await remove('leaving@example.com'), refused, 'the other key still renews');
  assert.equal((await (await signedGroblePost(s.origin, SECRET, subscriptionEvent('subscription.terminated', 'ref-b', { termination: { reason: 'BUYER_CANCELLED' } }))).json()).action, 'termination_recorded');
  assert.equal((await s.refresh(me.session)).body.licenses.length, 3, 'a refusal unlinks nothing');

  assert.deepEqual(await remove('leaving@example.com'), { status: 200, body: { ok: true } });
  for (const session of [me.session, pc.session]) assert.deepEqual(await s.refresh(session), { status: 401, body: { ok: false, error: 'session_invalid' } });
  const stored = await s.stored();
  assert.deepEqual([stored.accounts, stored.sessions, stored.byEmail, stored.byWorkosUser], [{}, {}, {}, {}]);
  assert.deepEqual(await fs.readdir(path.join(s.directory, 'avatars')), []);
  const licenses = Object.values((await s.licensesFile()).licenses);
  assert.ok(licenses.every((l) => l.accountId === undefined && l.unlinkedBy === 'delete' && l.unlinkedAt));
  const deletion = s.workos.calls.find((c) => c.method === 'DELETE');
  assert.deepEqual([deletion.path, deletion.auth], ['/user_management/users/user_leaving', `Bearer ${WORKOS_KEY}`]);
  assert.deepEqual(await s.adminGet('/v1/admin/accounts?email=leaving@example.com'), { ok: true, accounts: [] });

  // Signing up again with the same email is a new account, and the keys come back to it.
  const again = await s.signIn({ id: 'user_leaving_2', email: 'leaving@example.com' }, device(1));
  assert.notEqual(again.account.id, me.account.id);
  assert.deepEqual([again.licenses.length, again.licenses.every((l) => l.linkedBy === 'email'), again.stats.agentSessions, again.account.avatar], [3, true, 0, null]);
});

test('delete answers 200 when WorkOS fails to delete the user, and never logs the WorkOS id', async (t) => {
  const s = await setup(t);
  const me = await s.signIn({ id: 'user_secret_id_77', email: 'gone@example.com' }, device(1));
  s.workos.failDelete(500);
  assert.deepEqual(await s.json(await s.post('/v1/account/delete', { confirm: 'gone@example.com' }, s.bearer(me.session))), { status: 200, body: { ok: true } });
  assert.deepEqual((await s.stored()).accounts, {});
  const logged = s.lines.join('\n');
  assert.match(logged, /WorkOS user of deleted acct_[0-9a-f]{18} not deleted: workos_failed \(500\)/);
  assert.ok(!logged.includes('user_secret_id_77') && !logged.includes('gone@example.com'));
});
