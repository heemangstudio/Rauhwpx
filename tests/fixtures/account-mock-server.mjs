// In-memory test double of the site-api account routes (/v1/account/*, accounts contract §3),
// GET /v1/license/by-ref and the hosted Rau routes (/v1/rau/*, rau-mock.mjs). It signs real v2 account leases with
// the generated dev key from license-mock-server.mjs, so the app verifies them (HAMA_LICENSE_DEV_PUBLIC_KEY).
// Plans: a live 'rau' key makes the Rau tier ($8 a month); every other live key (hama, signature, null) is the Hama
// tier. An active Rau trial (7 days, $2, once per account and email) makes the Rau tier without a Rau key.
//
// Desktop tests use `.fetch`. `.listen()` serves it on 127.0.0.1 for live checks; then `auth/start` answers
// a URL to the mock's own `/authorize`, which plays WorkOS and 302s to the app's loopback with a grant
// (or `?error=` after `setAuthorizeError`). Scripted outcomes: `script(path, [status, body], ...)` answers the
// next calls to that path, `setOffline`, `setConfigured(false)` (503 accounts_not_configured).
//
// `node tests/fixtures/account-mock-server.mjs [--port N]` (or MOCK_PORT, default 8788) serves it for manual runs
// and prints the env to point the app at it. Admin routes under /__mock/: GET state, POST next-user
// {email, name, emailVerified}, POST key {edition, plan, tier, email} → {key}, POST devices {email, count},
// POST session {email, deviceId} → {token}, POST authorize-error {error|null}, POST configured {on},
// POST checkout/complete {edition, plan} (issues keys for every by-ref the app asked about),
// POST rau/usage {email, usd} (sets the current Rau spend), POST rau/configured {on}.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { normalizeLicenseKey, verifyAccountLease } from '../../desktop/license-lease.mjs';
import { DEV_KEYPAIR, DEV_PUBLIC_KEYS, signLease } from './license-mock-server.mjs';
import { createRauMock, RAU_PLAN_ALLOWANCE_USD, RAU_TRIAL_ALLOWANCE_USD } from './rau-mock.mjs';

export { DEV_KEYPAIR, DEV_PUBLIC_KEYS };

const DAY = 24 * 60 * 60 * 1000;
const LEASE_TTL_MS = 7 * DAY;
const BETA_LEASE_TTL_MS = 3 * DAY;
const GRANT_TTL_MS = 10 * 60 * 1000;
const TRIAL_DAYS = 7;
const MANAGE_URL = 'https://groble.im/manage/purchase';
const AVATAR_MAX_BYTES = 1024 * 1024;
const AVATAR_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DEVICE_ID_RE = /^[A-Za-z0-9\-_.:]{8,128}$/;
const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const BATCH_RE = /^[A-Za-z0-9_-]{8,64}$/;
const KNOWN_PROVIDERS = ['email', 'google'];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const b64sha = (value) => createHash('sha256').update(value, 'ascii').digest('base64url');
const token = (bytes = 32) => randomBytes(bytes).toString('base64url');

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) ?? '';
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
  }
  return '';
}

export function maskKey(key) {
  const parts = key.split('-');
  return [parts[0], parts[1], '•••••', '•••••', '•••••', parts[5]].join('-');
}

function magicMatches(bytes, type) {
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png') return bytes.subarray(0, 4).toString('latin1') === '\x89PNG';
  if (type === 'image/webp') return bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

export function createMockAccountServer({
  keypair = DEV_KEYPAIR,
  now = Date.now,
  deviceLimit = 5,
  providers = ['email', 'google'],
  baseUrl = 'https://accounts.test',
  log = null,
} = {}) {
  let origin = baseUrl.replace(/\/+$/, '');
  let offline = false;
  let configured = true;
  let authorizeError = null;
  let nextUser = { email: 'tester@example.com', name: '테스터', emailVerified: true };
  let accountCounter = 0;
  let keyCounter = 0;
  const accounts = new Map();
  const byEmail = new Map();
  const sessions = new Map();
  const logins = new Map();
  const grants = new Map();
  const keys = new Map();
  const orders = new Map();
  const checkouts = new Map();
  const scripted = new Map();
  /** Rau 체험을 쓴 이메일. 계정을 지우고 다시 만들어도 다시 받지 못한다. */
  const trialEmails = new Set();
  let rauConfigured = true;
  const calls = [];

  const iso = (t = now()) => new Date(t).toISOString();

  function ensureAccount({ email, name = null, emailVerified = true, provider = 'email' }) {
    const lower = String(email).trim().toLowerCase();
    let account = accounts.get(byEmail.get(lower));
    if (!account) {
      accountCounter += 1;
      account = {
        id: `acct_${accountCounter.toString(16).padStart(18, '0')}`,
        email, emailLower: lower, emailVerified, name: name ?? lower.split('@')[0], nameSource: 'provider',
        avatar: null, provider, createdAt: iso(), devices: new Map(),
        stats: { agentSessions: 0, documentsEdited: 0, since: now(), batches: [] },
        rauUsedUsd: 0,
        trial: null,
      };
      accounts.set(account.id, account);
      if (emailVerified) byEmail.set(lower, account.id);
    }
    account.provider = provider;
    account.lastSignInAt = iso();
    if (account.nameSource !== 'user' && name) account.name = name;
    // 서버처럼 확인된 이메일이면 같은 구매 이메일의 키를 붙인다.
    if (account.emailVerified) {
      for (const license of keys.values()) {
        if (!license.accountId && license.status !== 'revoked' && license.email?.toLowerCase() === lower) {
          Object.assign(license, { accountId: account.id, linkedBy: 'email', linkedAt: iso() });
        }
      }
    }
    return account;
  }

  function live(license) {
    if (license.status !== 'active') return false;
    return license.expiresAt === null || now() < license.expiresAt;
  }

  const rank = (license) => (license.edition === 'rau' ? 3 : license.edition === 'hama' ? 2 : 1);

  function linked(account) {
    return [...keys.values()].filter((license) => license.accountId === account.id);
  }

  function primaryOf(account) {
    return linked(account).filter(live).sort((a, b) => (rank(b) - rank(a))
      || ((b.expiresAt ?? Infinity) - (a.expiresAt ?? Infinity))
      || (a.createdAt - b.createdAt))[0] ?? null;
  }

  function trialActive(account) {
    const trial = account.trial;
    return Boolean(trial && now() < trial.endsAt && trial.usedUsd < RAU_TRIAL_ALLOWANCE_USD);
  }

  function trialView(account) {
    const trial = account.trial;
    const used = trial || trialEmails.has(account.emailLower);
    return {
      state: !used ? 'available' : trialActive(account) ? 'active' : 'ended',
      startedAt: trial?.startedAt ?? null,
      endsAt: trial?.endsAt ?? null,
      days: TRIAL_DAYS,
    };
  }

  const percentLeft = (allowance, used) => Math.ceil((Math.max(0, allowance - used) / allowance) * 100);

  /** 호스팅 Rau 자격과 크레딧. 플랜이 체험보다 먼저다. */
  function rauOf(account) {
    const primary = primaryOf(account);
    if (primary?.edition === 'rau') {
      return {
        eligible: true, source: 'plan',
        remainingPercent: percentLeft(RAU_PLAN_ALLOWANCE_USD, account.rauUsedUsd), resetsAt: now() + 20 * DAY,
      };
    }
    if (trialActive(account) || (account.trial && now() < account.trial.endsAt)) {
      return {
        eligible: trialActive(account), source: trialActive(account) ? 'trial' : null,
        remainingPercent: trialActive(account) ? percentLeft(RAU_TRIAL_ALLOWANCE_USD, account.trial.usedUsd) : null,
        resetsAt: trialActive(account) ? account.trial.endsAt : null,
      };
    }
    return { eligible: false, source: null, remainingPercent: null, resetsAt: null };
  }

  function spendRau(account, usd) {
    if (primaryOf(account)?.edition === 'rau') account.rauUsedUsd += usd;
    else if (account.trial) account.trial.usedUsd += usd;
  }

  function tierOf(account) {
    const primary = primaryOf(account);
    if (primary?.edition === 'rau' || trialActive(account)) return 'rau';
    return primary ? 'hama' : 'free';
  }

  function deviceView(id, device, currentId) {
    return { id, name: device.name, platform: device.platform, appVersion: device.appVersion, addedAt: device.addedAt, lastSeenAt: device.lastSeenAt, current: id === currentId };
  }

  function devicesView(account, currentId) {
    return [...account.devices.entries()].map(([id, device]) => deviceView(id, device, currentId))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  function leaseFor(account, deviceId) {
    const primary = primaryOf(account);
    const issuedAt = now();
    const expiresAt = issuedAt + (primary?.tier === 'beta' ? BETA_LEASE_TTL_MS : LEASE_TTL_MS);
    return {
      lease: signLease({
        v: 2, kid: keypair.kid, accountId: account.id, deviceId,
        keyId: primary?.keyId ?? null, tier: tierOf(account), plan: primary?.plan ?? null,
        issuedAt, expiresAt,
        ...(primary?.expiresAt ? { licenseExpiresAt: primary.expiresAt } : {}),
      }, keypair),
      leaseExpiresAt: expiresAt,
    };
  }

  function payload(account, deviceId) {
    const primary = primaryOf(account);
    const subscription = primary && primary.plan !== 'lifetime' && primary.expiresAt !== null;
    const licenses = linked(account).sort((a, b) => (a === primary ? -1 : b === primary ? 1 : b.createdAt - a.createdAt));
    return {
      ok: true,
      account: {
        id: account.id, email: account.email, name: account.name,
        avatar: account.avatar ? { rev: account.avatar.rev, type: account.avatar.type } : null,
        provider: account.provider, createdAt: account.createdAt,
      },
      plan: {
        tier: tierOf(account), keyId: primary?.keyId ?? null, edition: primary?.edition ?? null, plan: primary?.plan ?? null,
        expiresAt: primary?.expiresAt ?? null, autoRenew: subscription ? primary.autoRenew !== false : null,
        paymentFailed: false, paymentGraceEndsAt: null, manageUrl: subscription ? MANAGE_URL : null,
        rau: rauOf(account),
      },
      trial: trialView(account),
      licenses: licenses.map((license) => ({
        keyId: license.keyId, maskedKey: maskKey(license.key), tier: license.tier, edition: license.edition,
        plan: license.plan, status: live(license) ? 'active' : license.status === 'revoked' ? 'revoked' : 'expired',
        expiresAt: license.expiresAt, autoRenew: license.expiresAt === null ? null : license.autoRenew !== false,
        primary: license === primary, linkedBy: license.linkedBy, linkedAt: license.linkedAt,
      })),
      devices: devicesView(account, deviceId),
      deviceLimit,
      stats: {
        agentSessions: account.stats.agentSessions,
        documentsEdited: account.stats.documentsEdited,
        since: account.stats.since,
      },
      ...leaseFor(account, deviceId),
    };
  }

  const fail = (status, error, extra = {}) => [status, { ok: false, error, ...extra }];

  /** 호스팅 Rau 의 lease 인증. 이 서버가 서명한 v2 계정 lease 만, 지금 계정에 있는 기기의 것만 받는다. */
  function leaseAccount(headers) {
    const match = /^Bearer\s+(\S+)$/i.exec(headerValue(headers, 'authorization').trim());
    if (!match) return null;
    const result = verifyAccountLease(match[1], { publicKeys: { [keypair.kid]: keypair.publicKeyBase64 }, now: now() });
    if (!result.ok) return null;
    const account = accounts.get(result.payload.accountId);
    return account && account.devices.has(result.payload.deviceId) ? { account } : null;
  }

  const rau = createRauMock({ authenticate: leaseAccount, rauOf, spend: spendRau });

  function authenticate(headers) {
    const match = /^Bearer\s+(hes_\S+)$/i.exec(headerValue(headers, 'authorization').trim());
    const session = match ? sessions.get(sha256(match[1])) : null;
    const account = session ? accounts.get(session.accountId) : null;
    if (!account || !account.devices.has(session.deviceId)) return null;
    return { account, deviceId: session.deviceId, hash: sha256(match[1]) };
  }

  function newSession(account, deviceId) {
    for (const [hash, session] of sessions) {
      if (session.accountId === account.id && session.deviceId === deviceId) sessions.delete(hash);
    }
    const value = `hes_${token()}`;
    sessions.set(sha256(value), { accountId: account.id, deviceId, createdAt: now() });
    return value;
  }

  function removeDeviceFrom(account, deviceId) {
    account.devices.delete(deviceId);
    for (const [hash, session] of sessions) {
      if (session.accountId === account.id && session.deviceId === deviceId) sessions.delete(hash);
    }
  }

  function addDevice(account, device) {
    account.devices.set(device.id, {
      name: String(device.name ?? '').trim().slice(0, 64) || '이름 없는 기기',
      platform: String(device.platform ?? '').slice(0, 16),
      appVersion: typeof device.appVersion === 'string' ? device.appVersion : null,
      addedAt: now(),
      lastSeenAt: now(),
    });
  }

  function authStart(body) {
    if (!KNOWN_PROVIDERS.includes(body?.provider) || !providers.includes(body.provider)) return fail(400, 'provider_unavailable');
    if (typeof body.challenge !== 'string' || body.challenge.length !== 43) return fail(400, 'invalid', { field: 'challenge' });
    if (!Number.isInteger(body.port) || body.port < 1024 || body.port > 65535) return fail(400, 'invalid', { field: 'port' });
    if (typeof body.state !== 'string' || !STATE_RE.test(body.state)) return fail(400, 'invalid', { field: 'state' });
    const loginId = token(24);
    const expiresAt = now() + GRANT_TTL_MS;
    logins.set(loginId, { challenge: body.challenge, port: body.port, appState: body.state, provider: body.provider, loginHint: body.loginHint ?? null, expiresAt });
    return [200, { ok: true, url: `${origin}/authorize?state=${encodeURIComponent(loginId)}&provider=${body.provider}`, expiresAt }];
  }

  /** WorkOS 의 로그인 화면과 서버 콜백을 한 번에 흉내 낸다. */
  function authorize(query) {
    const login = logins.get(query.get('state') ?? '');
    if (!login || now() >= login.expiresAt) {
      return [400, '<!doctype html><meta charset="utf-8"><p>로그인 시간이 지났어요. 앱에서 다시 시도해 주세요.</p>', { 'Content-Type': 'text/html; charset=utf-8' }];
    }
    logins.delete(query.get('state'));
    const target = new URL(`http://127.0.0.1:${login.port}/auth/callback`);
    target.searchParams.set('state', login.appState);
    if (authorizeError) {
      target.searchParams.set('error', authorizeError);
    } else {
      const user = { ...nextUser, ...(login.provider === 'email' && login.loginHint ? { email: login.loginHint } : {}) };
      const account = ensureAccount({ ...user, provider: login.provider });
      const code = token();
      grants.set(sha256(code), { accountId: account.id, challenge: login.challenge, expiresAt: now() + GRANT_TTL_MS, attempts: 0 });
      target.searchParams.set('code', code);
    }
    return [302, '', { Location: target.href }];
  }

  function authToken(body) {
    const hash = sha256(String(body?.code ?? ''));
    const grant = grants.get(hash);
    if (!grant || now() >= grant.expiresAt) return fail(400, 'grant_invalid');
    grant.attempts += 1;
    if (grant.attempts > 10) {
      grants.delete(hash);
      return fail(400, 'grant_invalid');
    }
    if (typeof body.verifier !== 'string' || b64sha(body.verifier) !== grant.challenge) return fail(400, 'grant_invalid');
    const device = body.device;
    if (!device || !DEVICE_ID_RE.test(device.id ?? '')) return fail(400, 'invalid', { field: 'device' });
    const account = accounts.get(grant.accountId);
    if (!account) return fail(400, 'grant_invalid');
    if (!account.devices.has(device.id) && account.devices.size >= deviceLimit) {
      if (!body.replaceDeviceId) return fail(409, 'device_limit', { limit: deviceLimit, devices: devicesView(account, null) });
      if (!account.devices.has(body.replaceDeviceId)) return fail(404, 'device_not_found');
      removeDeviceFrom(account, body.replaceDeviceId);
    }
    grants.delete(hash);
    if (!account.devices.has(device.id)) addDevice(account, device);
    else Object.assign(account.devices.get(device.id), { lastSeenAt: now(), appVersion: device.appVersion ?? null });
    const session = newSession(account, device.id);
    return [200, { ...payload(account, device.id), session }];
  }

  function linkKey(auth, rawKey, linkedBy) {
    const key = normalizeLicenseKey(rawKey);
    if (!key) return fail(400, 'invalid_format');
    const license = keys.get(key);
    if (!license) return fail(404, 'invalid_key');
    if (license.status === 'revoked') return fail(403, 'revoked');
    if (license.accountId && license.accountId !== auth.account.id) return fail(409, 'key_linked_elsewhere');
    const alreadyLinked = license.accountId === auth.account.id;
    if (!alreadyLinked) Object.assign(license, { accountId: auth.account.id, linkedBy, linkedAt: iso() });
    const body = payload(auth.account, auth.deviceId);
    return [200, { ...body, alreadyLinked, license: body.licenses.find((entry) => entry.keyId === license.keyId) }];
  }

  function session(path, method, body, raw, headers) {
    const auth = authenticate(headers);
    if (!auth) return fail(401, 'session_invalid');
    const { account, deviceId } = auth;
    const device = account.devices.get(deviceId);
    if (path === '/v1/account/refresh' && method === 'POST') {
      device.lastSeenAt = now();
      if (typeof body?.appVersion === 'string') device.appVersion = body.appVersion;
      return [200, payload(account, deviceId)];
    }
    if (path === '/v1/account/signout' && method === 'POST') {
      removeDeviceFrom(account, deviceId);
      return [200, { ok: true }];
    }
    if (path === '/v1/account/devices/remove' && method === 'POST') {
      if (!account.devices.has(body?.deviceId)) return fail(404, 'device_not_found');
      removeDeviceFrom(account, body.deviceId);
      if (body.deviceId === deviceId) return [200, { ok: true, signedOut: true }];
      return [200, { ok: true, signedOut: false, devices: devicesView(account, deviceId) }];
    }
    if (path === '/v1/account/redeem' && method === 'POST') return linkKey(auth, body?.key, 'redeem');
    if (path === '/v1/account/rau-trial' && method === 'POST') {
      if (!rauConfigured) return fail(503, 'rau_unavailable');
      if (primaryOf(account)?.edition === 'rau') return fail(409, 'rau_active');
      if (account.trial || trialEmails.has(account.emailLower)) return fail(409, 'trial_used');
      account.trial = { startedAt: now(), endsAt: now() + TRIAL_DAYS * DAY, usedUsd: 0 };
      trialEmails.add(account.emailLower);
      return [200, payload(account, deviceId)];
    }
    if (path === '/v1/account/claim' && method === 'POST') {
      const order = orders.get(String(body?.orderId ?? '').trim());
      if (!order || String(body?.email ?? '').trim().toLowerCase() !== order.email.toLowerCase()) return fail(404, 'order_not_found');
      if (!order.key) return fail(409, 'order_not_ready');
      return linkKey(auth, order.key, 'claim');
    }
    if (path === '/v1/account/profile' && method === 'POST') {
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if ([...name].length < 1 || [...name].length > 30 || /[\u0000-\u001f\u007f]/.test(name)) return fail(400, 'name_invalid');
      Object.assign(account, { name, nameSource: 'user' });
      return [200, { ok: true, account: payload(account, deviceId).account }];
    }
    if (path === '/v1/account/avatar' && method === 'PUT') {
      const type = headerValue(headers, 'content-type').split(';')[0].trim().toLowerCase();
      if (raw.length > AVATAR_MAX_BYTES) return fail(413, 'too_large');
      if (!AVATAR_TYPES.has(type) || !magicMatches(raw, type)) return fail(415, 'unsupported_type');
      account.avatar = { rev: (account.avatar?.rev ?? 0) + 1, type, bytes: Buffer.from(raw), updatedAt: iso() };
      return [200, { ok: true, avatar: { rev: account.avatar.rev, type, bytes: raw.length } }];
    }
    if (path === '/v1/account/avatar' && method === 'GET') {
      if (!account.avatar) return fail(404, 'no_avatar');
      return [200, account.avatar.bytes, { 'Content-Type': account.avatar.type, ETag: `"${account.avatar.rev}"`, 'Cache-Control': 'private, no-cache' }];
    }
    if (path === '/v1/account/avatar/remove' && method === 'POST') {
      account.avatar = null;
      return [200, { ok: true }];
    }
    if (path === '/v1/account/stats' && method === 'POST') {
      const { batchId, agentSessions, documentsEdited } = body ?? {};
      const valid = (n) => Number.isInteger(n) && n >= 0 && n <= 1000;
      if (typeof batchId !== 'string' || !BATCH_RE.test(batchId) || !valid(agentSessions) || !valid(documentsEdited)) return fail(400, 'invalid');
      if (!account.stats.batches.includes(batchId)) {
        account.stats.agentSessions += agentSessions;
        account.stats.documentsEdited += documentsEdited;
        account.stats.batches = [...account.stats.batches, batchId].slice(-50);
      }
      const { batches: _batches, ...stats } = account.stats;
      return [200, { ok: true, stats }];
    }
    if (path === '/v1/account/delete' && method === 'POST') {
      if (String(body?.confirm ?? '').trim().toLowerCase() !== account.emailLower) return fail(400, 'confirm_mismatch');
      if (linked(account).some((license) => live(license) && license.expiresAt !== null && license.autoRenew !== false)) {
        return fail(409, 'subscription_active', { manageUrl: MANAGE_URL });
      }
      for (const license of linked(account)) {
        delete license.accountId;
        delete license.linkedAt;
        delete license.linkedBy;
        license.unlinkedAt = iso();
      }
      for (const id of [...account.devices.keys()]) removeDeviceFrom(account, id);
      accounts.delete(account.id);
      byEmail.delete(account.emailLower);
      return [200, { ok: true }];
    }
    return fail(404, 'not_found');
  }

  /** [status, body(object | Buffer | string), headers?] */
  function route(method, path, query, body, raw, headers) {
    const queued = scripted.get(path);
    if (queued?.length) {
      const next = queued.shift();
      return typeof next === 'function' ? next({ method, path, body }) : next;
    }
    if (path === '/authorize' && method === 'GET') return authorize(query);
    if (path === '/v1/license/by-ref' && method === 'GET') {
      const ref = query.get('ref') ?? '';
      const checkout = checkouts.get(ref) ?? { status: 'pending', key: null };
      checkouts.set(ref, checkout);
      return [200, checkout.key ? { ok: true, status: 'issued', key: checkout.key } : { ok: true, status: 'pending' }];
    }
    if (path.startsWith('/v1/rau/')) {
      rau.setConfigured(rauConfigured);
      return rau.handle(path, body, { method, headers });
    }
    if (!path.startsWith('/v1/account/')) return fail(404, 'not_found');
    if (!configured) return fail(503, 'accounts_not_configured');
    if (path === '/v1/account/auth/providers' && method === 'GET') return [200, { ok: true, providers: [...providers] }];
    if (path === '/v1/account/auth/start' && method === 'POST') return authStart(body);
    if (path === '/v1/account/auth/token' && method === 'POST') return authToken(body);
    return session(path, method, body, raw, headers);
  }

  function handle({ method = 'GET', url, headers = {}, raw = Buffer.alloc(0) }) {
    const parsed = new URL(url, origin);
    const type = headerValue(headers, 'content-type');
    let body = null;
    if (/json/.test(type) && raw.length) {
      try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; }
    }
    const authorization = headerValue(headers, 'authorization');
    calls.push({ method, path: parsed.pathname, body, bearer: authorization ? authorization.replace(/^Bearer\s+/i, '') : null });
    const [status, payloadBody, extra = {}] = route(method, parsed.pathname, parsed.searchParams, body, raw, headers);
    if (log) log(`[account-mock] ${method} ${parsed.pathname} → ${status}`);
    return { status, body: payloadBody, headers: extra };
  }

  function toResponse({ status, body, headers }) {
    if (Buffer.isBuffer(body) || typeof body === 'string') {
      return new Response(status === 302 || body.length === 0 ? null : body, { status, headers });
    }
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  }

  async function fetch(url, init = {}) {
    if (offline) throw new TypeError('fetch failed');
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException('aborted', 'AbortError');
    let raw = Buffer.alloc(0);
    if (typeof init.body === 'string') raw = Buffer.from(init.body, 'utf8');
    else if (init.body instanceof Uint8Array) raw = Buffer.from(init.body);
    else if (init.body instanceof ArrayBuffer) raw = Buffer.from(init.body);
    return toResponse(handle({ method: init.method ?? 'GET', url, headers: init.headers ?? {}, raw }));
  }

  let httpServer = null;
  async function listen({ port = 0, host = '127.0.0.1', admin = null } = {}) {
    httpServer = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      if (offline) {
        req.socket.destroy();
        return;
      }
      if (admin && req.url.startsWith('/__mock/')) {
        let body = {};
        try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { body = {}; }
        const [status, answer] = admin(req.method, new URL(req.url, origin).pathname, body);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(answer));
        return;
      }
      const answer = handle({ method: req.method, url: req.url, headers: req.headers, raw });
      const isRaw = Buffer.isBuffer(answer.body) || typeof answer.body === 'string';
      res.writeHead(answer.status, isRaw ? answer.headers : { 'Content-Type': 'application/json', ...answer.headers });
      res.end(isRaw ? answer.body : JSON.stringify(answer.body));
    });
    await new Promise((resolve) => httpServer.listen(port, host, resolve));
    origin = `http://${host}:${httpServer.address().port}`;
    return origin;
  }

  function close() {
    return new Promise((resolve) => {
      if (!httpServer) return resolve();
      httpServer.closeAllConnections?.();
      httpServer.close(() => resolve());
      httpServer = null;
    });
  }

  function accountByEmail(email) {
    return accounts.get(byEmail.get(String(email).toLowerCase())) ?? null;
  }

  return {
    fetch,
    handle,
    listen,
    close,
    calls,
    get baseUrl() { return origin; },
    /** 다음 /authorize 가 로그인시킬 사용자. */
    setNextUser(user) { nextUser = { emailVerified: true, ...user }; },
    /** 다음 /authorize 가 앱에 돌려줄 오류(auth_failed·auth_cancelled). null 이면 성공. */
    setAuthorizeError(error) { authorizeError = error; },
    setOffline(value) { offline = Boolean(value); },
    setConfigured(value) { configured = Boolean(value); },
    /** 그 경로의 다음 호출들에 순서대로 답한다. 값은 [status, body] 또는 함수. */
    script(path, ...responses) { scripted.set(path, [...(scripted.get(path) ?? []), ...responses]); },
    /** 계정에 붙일 수 있는 키를 만든다. email 이 있으면 그 구매 이메일로 자동 연결된다. */
    issueKey({ edition = 'hama', plan = 'monthly', tier = 'paid', email = null, expiresAt = plan === 'lifetime' ? null : now() + 30 * DAY, autoRenew = true, status = 'active' } = {}) {
      keyCounter += 1;
      const rawKey = Array.from(randomBytes(25), (n) => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[n & 31]).join('');
      const key = `HAMA-${rawKey.match(/.{5}/g).join('-')}`;
      keys.set(key, { keyId: `lic_${keyCounter}`, key, edition, plan, tier, email, expiresAt, autoRenew, status, accountId: null, createdAt: now() + keyCounter });
      const account = email ? accountByEmail(email) : null;
      if (account?.emailVerified) Object.assign(keys.get(key), { accountId: account.id, linkedBy: 'purchase', linkedAt: iso() });
      return key;
    },
    license(key) { return keys.get(normalizeLicenseKey(key)) ?? null; },
    revokeKey(key) { keys.get(normalizeLicenseKey(key)).status = 'revoked'; },
    /** Groble 주문. key 가 없으면 아직 결제를 확인하는 중(order_not_ready)이다. */
    addOrder(orderId, { email, key = null }) { orders.set(orderId, { email, key }); },
    account: accountByEmail,
    /** 계정에 다른 기기를 count 대 채운다. 없는 계정이면 만든다. */
    seedDevices(email, count, { platform = 'win32' } = {}) {
      const account = ensureAccount({ email });
      for (let index = 0; index < count; index += 1) {
        addDevice(account, { id: `seed-device-${account.id}-${account.devices.size + 1}`, name: `기기 ${account.devices.size + 1}`, platform, appVersion: '3.0.0' });
      }
      return [...account.devices.keys()];
    },
    /** 다른 기기에서 이 기기를 뺀 것처럼 서버에서 지운다(세션도 함께). */
    removeDevice(email, deviceId) { removeDeviceFrom(accountByEmail(email), deviceId); },
    /** 로그인 화면 없이 세션을 만든다(실행 중인 앱의 상태 파일을 미리 채울 때). */
    createSession({ email, deviceId, name = '시험 기기', platform = process.platform }) {
      const account = ensureAccount({ email });
      if (!account.devices.has(deviceId)) addDevice(account, { id: deviceId, name, platform, appVersion: null });
      return { token: newSession(account, deviceId), accountId: account.id };
    },
    /** 앱이 by-ref 로 물은 결제를 모두 키로 끝낸다. */
    completeCheckouts({ edition = 'hama', plan = 'monthly' } = {}) {
      const issued = [];
      for (const [ref, checkout] of checkouts) {
        if (checkout.key) continue;
        checkout.key = this.issueKey({ edition, plan });
        issued.push(ref);
      }
      return issued.length;
    },
    setCheckout(ref, key) { checkouts.set(ref, { status: 'issued', key }); },
    /** 이번 기간의 Rau 사용액(USD)을 정한다. 체험 중이면 체험 크레딧이다. */
    setRauUsage(email, usd) {
      const account = accountByEmail(email);
      if (!account) return;
      if (primaryOf(account)?.edition === 'rau') account.rauUsedUsd = usd;
      else if (account.trial) account.trial.usedUsd = usd;
    },
    /** 체험을 끝난 것으로 만든다(7일이 지났다). */
    endRauTrial(email) {
      const account = accountByEmail(email);
      if (account?.trial) account.trial.endsAt = now();
    },
    setRauConfigured(value) { rauConfigured = Boolean(value); },
    rauCalls: rau.calls,
    sessionCount() { return sessions.size; },
    snapshot() {
      return {
        baseUrl: origin,
        accounts: [...accounts.values()].map((account) => ({
          id: account.id, email: account.email, name: account.name, avatarRev: account.avatar?.rev ?? null,
          devices: [...account.devices.keys()], stats: { ...account.stats, batches: account.stats.batches.length },
          licenses: linked(account).map((license) => ({ keyId: license.keyId, edition: license.edition, plan: license.plan })),
        })),
        sessions: sessions.size,
        pendingCheckouts: [...checkouts.values()].filter((checkout) => !checkout.key).length,
      };
    },
  };
}

function cliPort(argv, env) {
  const index = argv.indexOf('--port');
  const port = Number(index >= 0 ? argv[index + 1] : env.MOCK_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 8788;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createMockAccountServer({ log: (line) => console.log(line) });
  const admin = (method, path, body) => {
    if (method === 'GET' && path === '/__mock/state') return [200, { ok: true, state: server.snapshot() }];
    if (method !== 'POST') return [404, { ok: false, error: 'not_found' }];
    if (path === '/__mock/next-user') server.setNextUser(body);
    else if (path === '/__mock/key') return [200, { ok: true, key: server.issueKey(body) }];
    else if (path === '/__mock/devices') return [200, { ok: true, devices: server.seedDevices(body.email, Number(body.count) || 1) }];
    else if (path === '/__mock/session') return [200, { ok: true, ...server.createSession(body) }];
    else if (path === '/__mock/authorize-error') server.setAuthorizeError(body.error ?? null);
    else if (path === '/__mock/configured') server.setConfigured(body.on !== false);
    else if (path === '/__mock/checkout/complete') return [200, { ok: true, completed: server.completeCheckouts(body) }];
    else if (path === '/__mock/rau/usage') server.setRauUsage(body.email, Number(body.usd) || 0);
    else if (path === '/__mock/rau/configured') server.setRauConfigured(body.on !== false);
    else return [404, { ok: false, error: 'not_found' }];
    return [200, { ok: true, state: server.snapshot() }];
  };
  const base = await server.listen({ port: cliPort(process.argv.slice(2), process.env), admin });
  console.log(`mock account server on ${base}`);
  console.log(`HAMA_LICENSE_API_BASE=${base}`);
  console.log(`HAMA_LICENSE_DEV_PUBLIC_KEY=${DEV_KEYPAIR.kid}:${DEV_KEYPAIR.publicKeyBase64}`);
}
