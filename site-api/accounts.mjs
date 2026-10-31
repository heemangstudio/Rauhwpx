import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  ACCOUNT_LEASE_VERSION,
  BETA_LEASE_TTL_MS,
  DEFAULT_LEASE_KID,
  LEASE_TTL_MS,
  leaseVersion,
  publicKeyFromPrivate,
  signAccountLease,
  verifyAccountLease,
} from './license-lease.mjs';
import { licenseError, tokenEquals } from './licenses.mjs';
import { createMemoryStore } from './store.mjs';
import { maskedEmail } from './workos.mjs';

/**
 * HamaEditor accounts: WorkOS AuthKit sign-in, devices, sessions and the account lease (v2). The
 * app-facing contract is in README.md, "Accounts".
 *
 * accounts.json = { accounts, byWorkosUser, byEmail (verified emails only), sessions, logins, grants }
 * Sessions and grants are stored only as sha256 hex. The license ↔ account link lives on the license
 * record in licenses.json. Lock rule: this service never awaits the licenses lock while it holds its
 * own, and licenses.mjs reads accounts.json only as a plain file. Assumes ONE replica.
 */

export const DEVICE_LIMIT_PER_ACCOUNT = 5;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const LOGIN_TTL_MS = 10 * MINUTE;
const GRANT_TTL_MS = 10 * MINUTE;
const MAX_GRANT_ATTEMPTS = 10;
const SESSION_IDLE_MS = 180 * DAY;
// lastUsedAt / lastSeenAt are written at most this often per session.
const TOUCH_INTERVAL_MS = HOUR;
// A flood of unfinished logins drops the oldest; a real one lives 10 minutes.
const MAX_PENDING_LOGINS = 5000;
const DEVICE_ID_RE = /^[A-Za-z0-9\-_.:]{8,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const APP_STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const SESSION_RE = /^hes_[A-Za-z0-9_-]{43}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const DEFAULT_DEVICE_NAME = '이름 없는 기기';

export function emptyAccountsState() {
  return { accounts: {}, byWorkosUser: {}, byEmail: {}, sessions: {}, logins: {}, grants: {} };
}

/** A license-style error; `extra` fields go into the `{ ok:false, error }` reply. */
export function accountError(code, status, extra) {
  return Object.assign(licenseError(code, status), extra ? { extra } : {});
}

const invalid = (field) => accountError('invalid', 400, { field });
const grantInvalid = () => accountError('grant_invalid', 400);
const sessionInvalid = () => accountError('session_invalid', 401);
const sha256hex = (text) => createHash('sha256').update(text).digest('hex');
const challengeOf = (verifier) => createHash('sha256').update(verifier, 'ascii').digest('base64url');
const iso = (ms) => new Date(ms).toISOString();
const ms = (value) => {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
};

function own(map, key) {
  return map && typeof map === 'object' && typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : undefined;
}

function sameText(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Trimmed, control characters removed, at most `max` characters. */
export function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(CONTROL_RE, '').trim()).slice(0, max).join('').trim();
}

/** The account id a verified email belongs to, from a plain read of accounts.json. */
export function accountIdForEmail(state, emailLower) {
  const id = own(state?.byEmail, emailLower);
  const account = own(state?.accounts, id);
  return account?.emailVerified && account.emailLower === emailLower ? id : null;
}

function normalize(state) {
  const next = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  for (const key of Object.keys(emptyAccountsState())) {
    if (!next[key] || typeof next[key] !== 'object' || Array.isArray(next[key])) next[key] = {};
  }
  return next;
}

export function createAccountsService({
  store = createMemoryStore(emptyAccountsState()),
  licenses,
  // createWorkOSClient(); null while WORKOS_API_KEY is unset.
  workos = null,
  signingKey = null,
  leaseKid = DEFAULT_LEASE_KID,
  providers = ['email', 'google', 'apple'],
  deviceLimit = DEVICE_LIMIT_PER_ACCOUNT,
  adminToken = '',
  now = Date.now,
  random = randomBytes,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  // Account leases are signed with the license key, so both must be set.
  const configured = Boolean(workos && signingKey);

  let mutation = Promise.resolve();
  function withLock(fn) {
    const result = mutation.then(fn, fn);
    mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  function prune(state) {
    const at = now();
    for (const [id, login] of Object.entries(state.logins)) if (!(ms(login?.expiresAt) > at)) delete state.logins[id];
    for (const [hash, grant] of Object.entries(state.grants)) if (!(ms(grant?.expiresAt) > at)) delete state.grants[hash];
  }

  /** `fn` returns `{ value, dirty }`; the state is saved unless `dirty` is false. Expired logins and grants go on every write. */
  async function mutate(fn) {
    return withLock(async () => {
      const state = normalize(await store.load());
      prune(state);
      const result = await fn(state);
      if (result?.dirty !== false) await store.save(state);
      return result?.value;
    });
  }

  async function read() {
    await mutation.catch(() => {});
    return normalize(await store.load());
  }

  function requireConfigured() {
    if (!configured) throw accountError('accounts_not_configured', 503);
  }

  const idle = (session) => !(now() - (ms(session?.lastUsedAt) ?? 0) < SESSION_IDLE_MS);

  // ------------------------------------------------------------- devices

  function parseDevice(raw) {
    const id = typeof raw?.id === 'string' ? raw.id.trim() : '';
    if (!DEVICE_ID_RE.test(id)) throw invalid('device');
    return {
      id,
      name: cleanText(raw.name, 64) || DEFAULT_DEVICE_NAME,
      platform: cleanText(raw.platform, 16) || 'unknown',
      appVersion: cleanText(raw.appVersion, 32) || null,
    };
  }

  function removeDevice(state, account, deviceId) {
    const device = own(account.devices, deviceId);
    if (!device) return false;
    if (own(state.sessions, device.sessionHash)) delete state.sessions[device.sessionHash];
    delete account.devices[deviceId];
    return true;
  }

  /** A device whose session is gone or idle frees its slot. */
  function dropIdleDevices(state, account) {
    for (const [deviceId, device] of Object.entries(account.devices)) {
      const session = own(state.sessions, device.sessionHash);
      if (!session || idle(session)) removeDevice(state, account, deviceId);
    }
  }

  /** One session per device: signing in again on a device replaces its session and keeps its slot. */
  function addDeviceSession(state, account, device, sessionHash) {
    const existing = own(account.devices, device.id);
    if (existing && own(state.sessions, existing.sessionHash)) delete state.sessions[existing.sessionHash];
    const stamp = iso(now());
    account.devices[device.id] = {
      name: device.name,
      platform: device.platform,
      appVersion: device.appVersion,
      addedAt: existing?.addedAt ?? stamp,
      lastSeenAt: stamp,
      sessionHash,
    };
    state.sessions[sessionHash] = { accountId: account.id, deviceId: device.id, createdAt: stamp, lastUsedAt: stamp };
  }

  /** Newest lastSeenAt first; times in epoch ms. */
  function deviceViews(account, currentId) {
    return Object.entries(account.devices ?? {})
      .map(([id, d]) => ({
        id,
        name: d.name,
        platform: d.platform,
        appVersion: d.appVersion ?? null,
        addedAt: ms(d.addedAt),
        lastSeenAt: ms(d.lastSeenAt),
        current: id === currentId,
      }))
      .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  }

  // ------------------------------------------------------------ accounts

  /** WorkOS first/last name, else the email's local part. */
  function providerName(user) {
    return cleanText([user.firstName, user.lastName].filter(Boolean).join(' '), 30);
  }

  /** By WorkOS user, else by verified email, else a new account. Keeps the indexes in step. */
  function upsertAccount(state, user, loginProvider) {
    const emailLower = user.email.trim().toLowerCase();
    let account = own(state.accounts, own(state.byWorkosUser, user.workosUserId));
    if (!account && user.emailVerified) account = own(state.accounts, own(state.byEmail, emailLower));
    const stamp = iso(now());
    if (!account) {
      let id;
      do id = `acct_${random(9).toString('hex')}`; while (own(state.accounts, id));
      account = {
        id,
        workosUserId: user.workosUserId,
        name: providerName(user) || cleanText(emailLower.split('@')[0], 30) || cleanText(emailLower, 30),
        nameSource: 'provider',
        avatar: null,
        createdAt: stamp,
        devices: {},
        stats: { agentSessions: 0, documentsEdited: 0, since: stamp, batches: [] },
      };
      state.accounts[id] = account;
    }
    // An account found by email moves to the WorkOS user that signed in now.
    if (account.workosUserId !== user.workosUserId && own(state.byWorkosUser, account.workosUserId) === account.id) {
      delete state.byWorkosUser[account.workosUserId];
    }
    if (account.emailLower && account.emailLower !== emailLower && own(state.byEmail, account.emailLower) === account.id) {
      delete state.byEmail[account.emailLower];
    }
    Object.assign(account, {
      workosUserId: user.workosUserId,
      email: user.email,
      emailLower,
      emailVerified: user.emailVerified,
      provider: user.provider ?? loginProvider,
      lastSignInAt: stamp,
    });
    // A name the user set is never overwritten; a later sign-in without a name keeps the old one.
    const name = providerName(user);
    if (account.nameSource !== 'user' && name) account.name = name;
    state.byWorkosUser[user.workosUserId] = account.id;
    if (account.emailVerified && !own(state.byEmail, emailLower)) state.byEmail[emailLower] = account.id;
    if (!account.emailVerified && own(state.byEmail, emailLower) === account.id) delete state.byEmail[emailLower];
    return account;
  }

  function accountView(account) {
    return {
      id: account.id,
      email: account.email,
      name: account.name,
      avatar: account.avatar ? { rev: account.avatar.rev, type: account.avatar.type } : null,
      provider: account.provider ?? null,
      createdAt: account.createdAt,
    };
  }

  function statsView(account) {
    const stats = account.stats ?? {};
    return {
      agentSessions: stats.agentSessions ?? 0,
      documentsEdited: stats.documentsEdited ?? 0,
      since: ms(stats.since ?? account.createdAt),
      hama: null,
    };
  }

  /** Everything the app shows and keeps: account, plan, licenses, devices, stats and a fresh lease. */
  async function accountPayload(accountId, deviceId) {
    const account = own((await read()).accounts, accountId);
    if (!account) throw sessionInvalid();
    const entitlements = await licenses.accountEntitlements(accountId);
    const primary = entitlements.primary;
    const { lease, payload } = signAccountLease({
      kid: leaseKid,
      accountId,
      deviceId,
      keyId: primary?.keyId ?? null,
      tier: entitlements.tier,
      plan: primary?.plan ?? null,
      now: now(),
      ttlMs: primary?.beta ? BETA_LEASE_TTL_MS : LEASE_TTL_MS,
      licenseExpiresAt: primary?.licenseExpiresAt ?? null,
      paymentGraceEndsAt: primary?.paymentGraceEndsAt ?? null,
    }, signingKey);
    return {
      ok: true,
      account: accountView(account),
      plan: entitlements.plan,
      licenses: entitlements.licenses,
      devices: deviceViews(account, deviceId),
      deviceLimit,
      stats: statsView(account),
      lease,
      leaseExpiresAt: payload.expiresAt,
    };
  }

  /** Links the licenses of a verified email; a failure leaves them for the next refresh. */
  async function linkLicenses(account) {
    if (!account.emailVerified) return;
    await licenses.linkByEmail(account.emailLower, account.id).catch((error) => {
      log(`[site-api] license link for ${account.id} failed: ${error?.message ?? error}`);
    });
  }

  // ------------------------------------------------------------- sign-in

  function providersView() {
    requireConfigured();
    return { ok: true, providers: [...providers] };
  }

  async function startLogin(body) {
    requireConfigured();
    const provider = typeof body?.provider === 'string' ? body.provider : '';
    if (!provider) throw invalid('provider');
    if (!providers.includes(provider)) throw accountError('provider_unavailable', 400);
    const challenge = body.challenge;
    if (typeof challenge !== 'string' || !CHALLENGE_RE.test(challenge)) throw invalid('challenge');
    const port = body.port;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw invalid('port');
    const appState = body.state;
    if (typeof appState !== 'string' || !APP_STATE_RE.test(appState)) throw invalid('state');
    let loginHint;
    if (body.loginHint !== undefined && body.loginHint !== null && body.loginHint !== '') {
      loginHint = typeof body.loginHint === 'string' ? body.loginHint.trim() : '';
      if (!loginHint || loginHint.length > 254 || !EMAIL_RE.test(loginHint)) throw invalid('loginHint');
    }
    const loginId = random(24).toString('base64url');
    const createdAt = now();
    const expiresAt = createdAt + LOGIN_TTL_MS;
    await mutate((state) => {
      const pending = Object.entries(state.logins);
      if (pending.length >= MAX_PENDING_LOGINS) {
        pending.sort((a, b) => (ms(a[1].createdAt) ?? 0) - (ms(b[1].createdAt) ?? 0));
        for (const [id] of pending.slice(0, pending.length - MAX_PENDING_LOGINS + 1)) delete state.logins[id];
      }
      state.logins[loginId] = { challenge, port, appState, provider, createdAt: iso(createdAt), expiresAt: iso(expiresAt) };
      return {};
    });
    return { ok: true, url: workos.authorizeUrl({ provider, state: loginId, loginHint }), expiresAt };
  }

  function loopbackUrl(port, params) {
    return `http://127.0.0.1:${port}/auth/callback?${new URLSearchParams(params)}`;
  }

  /**
   * WorkOS redirect target. Answers `{ redirect }` (the app's loopback URL with a grant or an error
   * code) once the login is known, else `{ expired: true }` for the HTML page. The login is single use.
   */
  async function callback({ code, state: loginId, error } = {}) {
    requireConfigured();
    const login = await mutate((state) => {
      const found = own(state.logins, loginId);
      if (!found) return { dirty: false, value: null };
      delete state.logins[loginId];
      return { value: found };
    });
    if (!login) return { expired: true };
    const back = (params) => ({ redirect: loopbackUrl(login.port, { ...params, state: login.appState }) });
    if (error) return back({ error: error === 'access_denied' ? 'auth_cancelled' : 'auth_failed' });
    if (typeof code !== 'string' || !code || code.length > 512) return back({ error: 'auth_failed' });
    let user;
    try {
      user = await workos.authenticateWithCode(code);
    } catch (failure) {
      log(`[site-api] account sign-in failed: ${failure?.code ?? 'error'}`);
      return back({ error: 'auth_failed' });
    }
    const grant = random(32).toString('base64url');
    const account = await mutate((state) => {
      const stored = upsertAccount(state, user, login.provider);
      const at = now();
      state.grants[sha256hex(grant)] = {
        accountId: stored.id,
        challenge: login.challenge,
        createdAt: iso(at),
        expiresAt: iso(at + GRANT_TTL_MS),
        attempts: 0,
      };
      return { value: { ...stored } };
    });
    // The accounts lock is released before the licenses lock is taken.
    await linkLicenses(account);
    log(`[site-api] account ${account.id} signed in with ${account.provider} (${maskedEmail(account.email)})`);
    return back({ code: grant });
  }

  /**
   * Grant → session for one device. Every grant failure is `grant_invalid`. A `device_limit` or
   * `device_not_found` answer leaves the grant for a retry with `replaceDeviceId`.
   */
  async function token(body) {
    requireConfigured();
    const device = parseDevice(body?.device);
    let replaceDeviceId = null;
    if (body?.replaceDeviceId !== undefined && body.replaceDeviceId !== null) {
      replaceDeviceId = typeof body.replaceDeviceId === 'string' ? body.replaceDeviceId.trim() : '';
      if (!DEVICE_ID_RE.test(replaceDeviceId)) throw invalid('replaceDeviceId');
    }
    const code = typeof body?.code === 'string' ? body.code : '';
    const verifier = typeof body?.verifier === 'string' ? body.verifier : '';
    if (!code || code.length > 128 || !VERIFIER_RE.test(verifier)) throw grantInvalid();
    const hash = sha256hex(code);
    const session = `hes_${random(32).toString('base64url')}`;
    const outcome = await mutate((state) => {
      const grant = own(state.grants, hash);
      if (!grant) return { dirty: false, value: { error: grantInvalid() } };
      grant.attempts = (Number.isSafeInteger(grant.attempts) ? grant.attempts : 0) + 1;
      const account = own(state.accounts, grant.accountId);
      if (grant.attempts > MAX_GRANT_ATTEMPTS || !account) {
        delete state.grants[hash];
        return { value: { error: grantInvalid() } };
      }
      if (!sameText(challengeOf(verifier), grant.challenge)) return { value: { error: grantInvalid() } };
      dropIdleDevices(state, account);
      if (!own(account.devices, device.id) && Object.keys(account.devices).length >= deviceLimit) {
        if (!replaceDeviceId) {
          return { value: { error: accountError('device_limit', 409, { limit: deviceLimit, devices: deviceViews(account, null) }) } };
        }
        if (!removeDevice(state, account, replaceDeviceId)) return { value: { error: accountError('device_not_found', 404) } };
      }
      addDeviceSession(state, account, device, sha256hex(session));
      delete state.grants[hash];
      return { value: { accountId: account.id } };
    });
    if (outcome.error) throw outcome.error;
    log(`[site-api] account ${outcome.accountId} session on a ${device.platform} device`);
    return { ok: true, session, ...(await accountPayload(outcome.accountId, device.id)) };
  }

  // ------------------------------------------------------------- session

  /** Bearer session → `{ hash, session, account, deviceId }`, or 401 session_invalid. */
  async function sessionOf(bearer) {
    requireConfigured();
    if (typeof bearer !== 'string' || !SESSION_RE.test(bearer)) throw sessionInvalid();
    const hash = sha256hex(bearer);
    const state = await read();
    const session = own(state.sessions, hash);
    const account = own(state.accounts, session?.accountId);
    const device = own(account?.devices, session?.deviceId);
    if (!device || device.sessionHash !== hash || idle(session)) throw sessionInvalid();
    return { hash, session, account, deviceId: session.deviceId, device };
  }

  /** Marks the session used, at most once an hour (and when the app version changed). */
  async function touch({ hash, session, account, deviceId, device }, appVersion) {
    const due = now() - (ms(session.lastUsedAt) ?? 0) >= TOUCH_INTERVAL_MS;
    if (!due && (!appVersion || appVersion === device.appVersion)) return;
    await mutate((state) => {
      const current = own(state.sessions, hash);
      const found = own(own(state.accounts, account.id)?.devices, deviceId);
      if (!current || found?.sessionHash !== hash) return { dirty: false };
      const stamp = iso(now());
      current.lastUsedAt = stamp;
      found.lastSeenAt = stamp;
      if (appVersion) found.appVersion = appVersion;
      return {};
    });
  }

  async function refresh(bearer, body) {
    const context = await sessionOf(bearer);
    await touch(context, cleanText(body?.appVersion, 32) || null);
    await linkLicenses(context.account);
    return accountPayload(context.account.id, context.deviceId);
  }

  /** Removes this device and its session. Idempotent: an unknown session is already signed out. */
  async function signout(bearer) {
    requireConfigured();
    if (typeof bearer === 'string' && SESSION_RE.test(bearer)) {
      const hash = sha256hex(bearer);
      await mutate((state) => {
        const session = own(state.sessions, hash);
        if (!session) return { dirty: false };
        const account = own(state.accounts, session.accountId);
        if (own(account?.devices, session.deviceId)?.sessionHash === hash) delete account.devices[session.deviceId];
        delete state.sessions[hash];
        return {};
      });
    }
    return { ok: true };
  }

  async function removeDeviceRoute(bearer, body) {
    const context = await sessionOf(bearer);
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim() : '';
    const account = await mutate((state) => {
      const found = own(state.accounts, context.account.id);
      if (!found || !removeDevice(state, found, deviceId)) return { dirty: false, value: null };
      return { value: { ...found } };
    });
    if (!account) throw accountError('device_not_found', 404);
    if (deviceId === context.deviceId) return { ok: true, signedOut: true };
    return { ok: true, signedOut: false, devices: deviceViews(account, context.deviceId) };
  }

  // --------------------------------------------------------------- lease

  let publicKeys;

  /**
   * Bearer lease for gifts, Hama and Rau. A v1 (license) lease goes to licenses.authenticateLease
   * unchanged. A v2 lease must verify, its account must exist and its device must still be on the
   * account with a live session; the license is then chosen now by `purpose` (licenses.authenticateAccount).
   */
  async function authenticateLease(lease, { allowInactive = false, withRauPlan = false, purpose } = {}) {
    if (leaseVersion(lease) !== ACCOUNT_LEASE_VERSION) return licenses.authenticateLease(lease, { allowInactive, withRauPlan });
    if (!signingKey) throw licenseError('unauthorized', 401);
    publicKeys ??= { [leaseKid]: publicKeyFromPrivate(signingKey) };
    const checked = verifyAccountLease(lease, publicKeys, { now: now() });
    if (!checked.ok) throw licenseError('unauthorized', 401);
    const { accountId, deviceId } = checked.payload;
    const state = await read();
    const device = own(own(state.accounts, accountId)?.devices, deviceId);
    const session = own(state.sessions, device?.sessionHash);
    if (!session || session.accountId !== accountId || session.deviceId !== deviceId || idle(session)) {
      throw licenseError('unauthorized', 401);
    }
    return licenses.authenticateAccount(accountId, { deviceId, platform: device.platform, purpose, allowInactive, withRauPlan });
  }

  // --------------------------------------------------------------- admin

  function requireAdmin(token) {
    if (!tokenEquals(token, adminToken)) throw licenseError('forbidden', 403);
  }

  async function adminView(account) {
    return {
      id: account.id,
      workosUserId: account.workosUserId,
      email: account.email,
      emailVerified: account.emailVerified,
      name: account.name,
      nameSource: account.nameSource,
      avatar: account.avatar ?? null,
      provider: account.provider ?? null,
      createdAt: account.createdAt,
      lastSignInAt: account.lastSignInAt,
      devices: Object.entries(account.devices ?? {}).map(([id, d]) => ({
        id, name: d.name, platform: d.platform, appVersion: d.appVersion ?? null, addedAt: d.addedAt, lastSeenAt: d.lastSeenAt,
      })),
      stats: { agentSessions: account.stats?.agentSessions ?? 0, documentsEdited: account.stats?.documentsEdited ?? 0, since: account.stats?.since ?? account.createdAt },
      licenses: await licenses.accountLicensesView(account.id),
    };
  }

  const admin = {
    /** `{ email }`, `{ id }` or `{ keyId }` (the account the license is linked to). No sessions or grants. */
    async lookup(token, { email, id, keyId } = {}) {
      requireAdmin(token);
      let ids;
      if (typeof id === 'string' && id.trim()) ids = [id.trim()];
      else if (typeof email === 'string' && email.trim()) {
        const needle = email.trim().toLowerCase();
        ids = Object.values((await read()).accounts).filter((a) => a.emailLower === needle).map((a) => a.id);
      } else if (typeof keyId === 'string' && keyId.trim()) {
        const license = (await licenses.admin.lookup(token, { keyId: keyId.trim() })).licenses[0];
        ids = license?.accountId ? [license.accountId] : [];
      } else throw accountError('query_required', 400);
      const state = await read();
      const found = ids.map((accountId) => own(state.accounts, accountId)).filter(Boolean);
      return { ok: true, accounts: await Promise.all(found.map(adminView)) };
    },
  };

  return {
    configured,
    providers: providersView,
    startLogin,
    callback,
    token,
    refresh,
    signout,
    removeDevice: removeDeviceRoute,
    authenticateLease,
    admin,
  };
}
