import crypto from 'node:crypto';
import path from 'node:path';
import { browserOrigin, readBrowserJson, writeBrowserJson } from './browser-policy.mjs';
import { createEncryptedBrowserAuthStore } from './browser-auth-store.mjs';

const REQUEST_TTL_MS = 10 * 60 * 1000;
const HANDLE_TTL_MS = 60 * 1000;
const MAX_PENDING = 128;
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BINDING_KEYS = ['tabId', 'runtimeGeneration', 'navigationEpoch', 'controlEpoch', 'frameId', 'origin', 'accountId'];
const SCOPE_KEYS = ['threadId', 'documentId', 'projectId'];
const ACTOR_KEYS = [...SCOPE_KEYS, 'agentId', 'clientId'];
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function text(value, max = 200) { return String(value ?? '').trim().slice(0, max); }
function human(actor) { if (!actor?.isHuman) throw failure('BROWSER_OWNER_REQUIRED', 'Only the owner can manage website accounts.'); }
function sameScope(left, right) { return SCOPE_KEYS.every((key) => (left?.[key] ?? null) === (right?.[key] ?? null)); }
function actorIdentity(actor) { return JSON.stringify(ACTOR_KEYS.map((key) => actor?.[key] ?? null)); }
function validOrigins(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 32) throw failure('BROWSER_ACCOUNT_INVALID', 'At least one exact website origin is required.');
  return [...new Set(values.map((value) => {
    const origin = browserOrigin(value);
    if (!origin.startsWith('https://')) throw failure('BROWSER_ACCOUNT_INSECURE_ORIGIN', 'Saved website accounts require HTTPS.');
    return origin;
  }))];
}
function boundValue(input) {
  const result = Object.fromEntries(BINDING_KEYS.map((key) => [key, input?.[key]]));
  if (BINDING_KEYS.some((key) => result[key] === undefined || result[key] === null || result[key] === '')) throw failure('BROWSER_CREDENTIAL_BINDING_REQUIRED', 'Credential use requires a current tab, frame, navigation and controller binding.');
  result.origin = browserOrigin(result.origin);
  return result;
}
function sameBinding(left, right) { return BINDING_KEYS.every((key) => left[key] === right[key]); }
function domainMatches(origin, domain) { const host = new URL(origin).hostname.toLowerCase(); return host === domain || host.endsWith(`.${domain}`); }
function normalizedDomain(value) {
  const domain = String(value).trim().toLowerCase().replace(/^\./, '');
  if (!domain || domain.length > 253 || /[^a-z0-9.-]/.test(domain) || domain.startsWith('-') || domain.includes('..')) throw failure('BROWSER_SESSION_ORIGIN_INVALID', 'The browser session domain is invalid.');
  return domain;
}
function approvalProof(approval, request, actor, needsSave) {
  if (!approval?.approved || approval.requestId !== request.requestId || (needsSave && approval.save !== true)
    || !sameScope(request.actor, actor) || (approval.actor && !sameScope(approval.actor, actor))) {
    throw failure('BROWSER_ACCOUNT_CONSENT_REQUIRED', 'The website account request needs current owner approval.');
  }
}

export function createBrowserCredentialBroker({ dataDir, policy, secretStore, wrappingKeyProvider, onEvent = () => {}, now = Date.now } = {}) {
  if (!dataDir || !policy) throw new TypeError('Browser credential dataDir and policy are required.');
  const filePath = path.join(dataDir, 'browser-accounts.json');
  const authStore = createEncryptedBrowserAuthStore({ dataDir, secretStore, wrappingKeyProvider });
  let state;
  let queue = Promise.resolve();
  let sessionClearer;
  let dataResetter;
  let resetting = false;
  let dataGeneration = 0;
  const requests = new Map();
  const handles = new Map();
  const activeUses = new Map();
  const readyPromise = (async () => {
    await policy.ready();
    state = await readBrowserJson(filePath);
    if (state) {
      if (state.schema !== 1 || !Array.isArray(state.accounts) || !state.configuration || state.accounts.length > 1024) throw failure('BROWSER_ACCOUNT_STORAGE_INVALID', 'Saved website account metadata cannot be read.');
      for (const account of state.accounts) {
        if (!ACCOUNT_ID.test(account.id)) throw failure('BROWSER_ACCOUNT_STORAGE_INVALID', 'Saved website account identity cannot be read.');
        account.origin = browserOrigin(account.origin);
        account.origins = validOrigins(account.origins);
      }
      state.sessions ??= [];
      if (!Array.isArray(state.sessions) || state.sessions.length > 2048) throw failure('BROWSER_ACCOUNT_STORAGE_INVALID', 'Saved browser session provenance cannot be read.');
      return;
    }
    state = { schema: 1, accounts: [], sessions: [], configuration: { profileId: 'default', downloads: { directory: 'managed', maxFileBytes: 100 * 1024 * 1024, autoImport: true }, preview: { mode: 'docked', reducedMotion: false } } };
    await writeBrowserJson(filePath, state);
  })();
  function serialized(operation, { allowDuringReset = false } = {}) {
    if (!allowDuringReset) {
      try { assertNotResetting(); } catch (error) { return Promise.reject(error); }
    }
    const execute = async () => { await readyPromise; if (!allowDuringReset) assertNotResetting(); return operation(); };
    const task = queue.then(execute, execute);
    queue = task.catch(() => {});
    return task;
  }
  function emit(event) { try { onEvent(event); } catch {} }
  function assertNotResetting() {
    if (resetting || state?.resetPending) throw failure('BROWSER_RESET_INCOMPLETE', 'Browser data cleanup must finish before saved sessions can be used. Retry cleanup in Browser settings.');
  }
  function invalidateAccount(id) {
    for (const [key, handle] of handles) if (handle.accountId === id) handles.delete(key);
    for (const use of activeUses.values()) if (use.accountId === id) use.invalidated = true;
  }
  async function drainWrites(accountIds) {
    const selected = accountIds ? new Set(accountIds) : null;
    await Promise.all([...activeUses.values()].filter((use) => !selected || selected.has(use.accountId)).flatMap((use) => [...use.writes]));
  }
  const removePolicyGuard = policy.addChangeGuard?.(async (change) => {
    const selected = change.accountId ? [change.accountId] : [...new Set([...handles.values(), ...activeUses.values()]
      .filter((use) => !change.origin || use.binding.origin === browserOrigin(change.origin)).map((use) => use.accountId))];
    selected.forEach(invalidateAccount);
    await drainWrites(selected);
  });
  function sweep() {
    for (const [id, request] of requests) if (request.expiresAt <= now()) requests.delete(id);
    for (const [id, handle] of handles) if (handle.expiresAt <= now()) handles.delete(id);
  }
  function findAccount(id) {
    const account = state.accounts.find((entry) => entry.id === id);
    if (!account) throw failure('BROWSER_ACCOUNT_NOT_FOUND', 'The saved website account no longer exists.');
    return account;
  }
  function sessionVersion(account) {
    return Math.max(0, ...state.sessions.filter((entry) => entry.profileId === account.profileId && account.origins.some((origin) => entry.origin === origin || (entry.domain && domainMatches(origin, entry.domain)))).map((entry) => entry.version));
  }
  async function metadata(account) {
    const currentPolicy = await policy.list();
    const approval = currentPolicy.accounts.find((entry) => entry.accountId === account.id);
    return { ...clone(account), agentReuseApproved: approval?.approved === true && (account.sessionVersion ?? 0) === sessionVersion(account), approvalVersion: approval?.version ?? 0, sessionApprovalRequired: (account.sessionVersion ?? 0) !== sessionVersion(account) };
  }
  async function listAccounts() {
    await readyPromise;
    return { accounts: await Promise.all(state.accounts.map(metadata)), secureStorageAvailable: !!(secretStore?.available || authStore.available) };
  }
  async function requestAccount({ actor, tabId, origin, label, reason, accountId, origins, profileId = 'default', intent } = {}) {
    await readyPromise;
    assertNotResetting();
    sweep();
    if (!actor || (!actor.isHuman && !actor.threadId)) throw failure('BROWSER_ACTOR_REQUIRED', 'A browser account request needs an owning chat or human client.');
    const account = accountId ? findAccount(accountId) : null;
    const normalizedOrigin = browserOrigin(origin ?? account?.origin);
    const allowedOrigins = validOrigins(origins ?? account?.origins ?? [normalizedOrigin]);
    if (!allowedOrigins.includes(normalizedOrigin)) throw failure('BROWSER_ACCOUNT_INVALID', 'The sign-in origin must be included in the account origins.');
    if (account && !actor.isHuman && (account.profileId !== profileId || allowedOrigins.some((value) => !account.origins.includes(value)))) {
      throw failure('BROWSER_ACCOUNT_ORIGIN_MISMATCH', 'An existing account approval cannot be extended by an agent.');
    }
    if (requests.size >= MAX_PENDING) throw failure('BROWSER_ACCOUNT_REQUEST_LIMIT', 'Too many website account requests are pending.');
    const request = {
      requestId: crypto.randomUUID(), kind: intent === 'use' || (account && intent !== 'save') ? 'browser-use-account' : 'browser-save-account',
      origin: normalizedOrigin, origins: allowedOrigins, accountId: account?.id ?? null,
      accountLabel: text(label ?? account?.label ?? normalizedOrigin), profileId: text(profileId, 100),
      tabId: tabId ?? null, reason: text(reason, 500), remember: true, expiresAt: now() + REQUEST_TTL_MS,
      actor: clone(actor),
    };
    requests.set(request.requestId, request);
    const publicRequest = clone(request);
    emit({ type: 'browser-account-request', request: publicRequest });
    return publicRequest;
  }
  async function getAccountRequest(id) {
    await readyPromise; sweep();
    const request = requests.get(id);
    return request ? clone(request) : null;
  }
  async function cancelAccountRequest({ actor, requestId } = {}) {
    human(actor);
    await readyPromise;
    const request = consumeRequest(requestId);
    if (!sameScope(request.actor, actor)) throw failure('BROWSER_ACCOUNT_CONSENT_REQUIRED', 'This website account request belongs to a different chat.');
    requests.delete(requestId);
    emit({ type: 'browser-account-request-cancelled', requestId });
    return { cancelled: true, requestId };
  }
  function consumeRequest(id) {
    sweep();
    const request = requests.get(id);
    if (!request) throw failure('BROWSER_ACCOUNT_REQUEST_EXPIRED', 'The website account request expired. Request it again.');
    return request;
  }
  async function writePassword(id, value) {
    if (secretStore?.available) {
      try { await secretStore.set(`browser.password.${id}`, JSON.stringify(value)); }
      catch { throw failure('BROWSER_SECURE_STORAGE_UNAVAILABLE', 'The owner vault could not save this website account.'); }
    } else await authStore.savePassword(id, value);
  }
  async function readPassword(id) {
    if (secretStore?.available) {
      try {
        const value = await secretStore.get(`browser.password.${id}`);
        return value ? JSON.parse(value) : null;
      } catch { throw failure('BROWSER_SECURE_STORAGE_UNAVAILABLE', 'The owner vault could not read this website account.'); }
    }
    return authStore.readPassword(id);
  }
  async function deletePassword(id) {
    if (secretStore?.available) {
      try { await secretStore.delete(`browser.password.${id}`); }
      catch { throw failure('BROWSER_SECURE_STORAGE_UNAVAILABLE', 'The owner vault could not remove this website account.'); }
    }
    await authStore.deletePassword(id);
  }
  async function submit({ actor, requestId, approval, account: submitted = {}, username, password, remember = true } = {}) {
    human(actor);
    return serialized(async () => {
      const request = consumeRequest(requestId);
      approvalProof(approval, request, actor, true);
      if (approval.use === true && remember !== true) throw failure('BROWSER_ACCOUNT_CONSENT_REQUIRED', 'Remembered agent account use needs explicit approval.');
      if (typeof username !== 'string' || typeof password !== 'string' || !password || Buffer.byteLength(username) + Buffer.byteLength(password) > 12 * 1024) throw failure('BROWSER_ACCOUNT_INVALID', 'Enter a valid username and password within the account size limit.');
      const origin = browserOrigin(submitted.origin ?? request.origin);
      const accountOrigins = validOrigins(submitted.origins ?? request.origins);
      if (origin !== request.origin || accountOrigins.some((value) => !request.origins.includes(value)) || !accountOrigins.includes(origin)
        || (submitted.id && submitted.id !== request.accountId) || (submitted.profileId && submitted.profileId !== request.profileId)) {
        throw failure('BROWSER_ACCOUNT_ORIGIN_MISMATCH', 'The approved account origin or profile changed. Request approval again.');
      }
      const previous = request.accountId ? findAccount(request.accountId) : null;
      const id = previous?.id ?? crypto.randomUUID();
      const record = {
        id, origin, origins: accountOrigins, label: text(submitted.label ?? request.accountLabel),
        stableIdentity: text(submitted.stableIdentity ?? previous?.stableIdentity ?? id, 256),
        profileId: request.profileId, hasPassword: true, sessionStatus: 'saved',
        version: (previous?.version ?? 0) + 1, updatedAt: new Date(now()).toISOString(),
      };
      record.sessionVersion = sessionVersion(record);
      if (previous && submitted.stableIdentity && submitted.stableIdentity !== previous.stableIdentity) throw failure('BROWSER_ACCOUNT_IDENTITY_MISMATCH', 'Add a new account when the website identity changes.');
      requests.delete(requestId);
      invalidateAccount(id);
      await authStore.deleteCheckpoint(record.profileId);
      await writePassword(id, { username, password });
      const next = { ...state, accounts: state.accounts.filter((entry) => entry.id !== id).concat(record) };
      await writeBrowserJson(filePath, next);
      state = next;
      await policy.update({ actor, operation: approval.use === true ? 'approve-account' : 'revoke-account', accountId: id, origins: record.origins, profileId: record.profileId });
      const safeAccount = await metadata(record);
      emit({ type: 'browser-account-changed', account: safeAccount });
      return { account: safeAccount };
    });
  }
  async function approveAccount({ actor, requestId, accountId, approval, account: submitted = {} } = {}) {
    human(actor);
    return serialized(async () => {
      let account;
      if (requestId) {
        const request = consumeRequest(requestId);
        approvalProof(approval, request, actor, false);
        if (approval.use !== true || (accountId && request.accountId !== accountId)) throw failure('BROWSER_ACCOUNT_CONSENT_REQUIRED', 'Approve this exact saved account before agent use.');
        if (request.accountId) account = findAccount(request.accountId);
        else {
          const origin = browserOrigin(submitted.origin ?? request.origin);
          const accountOrigins = validOrigins(submitted.origins ?? request.origins);
          if (origin !== request.origin || accountOrigins.some((value) => !request.origins.includes(value)) || !accountOrigins.includes(origin)
            || submitted.id || (submitted.profileId && submitted.profileId !== request.profileId)) {
            throw failure('BROWSER_ACCOUNT_ORIGIN_MISMATCH', 'The approved session account origin or profile changed.');
          }
          const id = crypto.randomUUID();
          account = { id, origin, origins: accountOrigins, label: text(submitted.label ?? request.accountLabel), stableIdentity: text(submitted.stableIdentity ?? id, 256), profileId: request.profileId, hasPassword: false, sessionStatus: 'session-retained', version: 1, updatedAt: new Date(now()).toISOString() };
          const next = { ...state, accounts: [...state.accounts, account] };
          await writeBrowserJson(filePath, next); state = next;
        }
        requests.delete(requestId);
      } else account = findAccount(accountId);
      invalidateAccount(account.id);
      const acknowledgedAccount = { ...account, sessionVersion: sessionVersion(account) };
      const next = { ...state, accounts: state.accounts.map((entry) => entry.id === account.id ? acknowledgedAccount : entry) };
      await writeBrowserJson(filePath, next); state = next;
      account = acknowledgedAccount;
      await policy.update({ actor, operation: 'approve-account', accountId: account.id, origins: account.origins, profileId: account.profileId });
      const safeAccount = await metadata(account);
      emit({ type: 'browser-account-changed', account: safeAccount });
      return { account: safeAccount };
    });
  }
  async function assertBrowserAccess({ actor, url, tab = {} } = {}) {
    await readyPromise;
    assertNotResetting();
    const origin = browserOrigin(url);
    if (actor?.isHuman) return true;
    const profileId = tab.profileId ?? 'default';
    const candidates = state.accounts.filter((account) => account.profileId === profileId && account.origins.includes(origin));
    const quarantined = state.sessions.some((entry) => entry.profileId === profileId && (entry.origin === origin || (entry.domain && domainMatches(origin, entry.domain))))
      || tab.sessionRequiresApproval === true || tab.unapprovedSessionDomains?.some((domain) => domainMatches(origin, normalizedDomain(domain)));
    if (quarantined && candidates.length === 0) throw failure('BROWSER_ACCOUNT_APPROVAL_REQUIRED', 'Approve this retained website session before agent access.');
    for (const account of candidates) {
      if ((account.sessionVersion ?? 0) !== sessionVersion(account)) throw failure('BROWSER_ACCOUNT_APPROVAL_REQUIRED', 'The owner changed this website session. Approve its account identity before agent access.');
      await policy.assertAllowed({ actor, action: 'account-use', url: origin, accountId: account.id, profileId });
    }
    return true;
  }
  async function registerSessionOrigins({ profileId = 'default', origins = [], domains = [], source = 'unknown' } = {}) {
    if (!['human', 'unknown'].includes(source) || !Array.isArray(origins) || !Array.isArray(domains) || origins.length + domains.length > 1024) throw failure('BROWSER_SESSION_ORIGIN_INVALID', 'The browser session provenance is invalid.');
    const entries = [...new Set(origins.map(browserOrigin))].map((origin) => ({ origin }))
      .concat([...new Set(domains.map(normalizedDomain))].map((domain) => ({ domain })));
    return serialized(async () => {
      if (entries.length === 0) return { quarantined: false };
      const version = Math.max(0, ...state.sessions.map((entry) => entry.version)) + 1;
      let sessions = [...state.sessions];
      for (const entry of entries) {
        const previous = sessions.find((item) => item.profileId === profileId && item.origin === entry.origin && item.domain === entry.domain);
        if (source === 'unknown' && previous) continue;
        sessions = sessions.filter((item) => !(item.profileId === profileId && item.origin === entry.origin && item.domain === entry.domain));
        sessions.push({ ...entry, profileId, source, version });
      }
      if (sessions.length > 2048) throw failure('BROWSER_SESSION_ORIGIN_LIMIT', 'Too many retained session origins require approval.');
      const next = { ...state, sessions };
      const affectedIds = state.accounts.filter((account) => account.profileId === profileId && account.origins.some((origin) => entries.some((entry) => entry.origin === origin || (entry.domain && domainMatches(origin, entry.domain))))).map((account) => account.id);
      affectedIds.forEach(invalidateAccount);
      await drainWrites(affectedIds);
      await writeBrowserJson(filePath, next); state = next;
      await authStore.deleteCheckpoint(profileId);
      for (const account of state.accounts) if ((account.sessionVersion ?? 0) !== sessionVersion(account)) invalidateAccount(account.id);
      emit({ type: 'browser-session-approval-required', profileId, origins: entries.filter((entry) => entry.origin).map((entry) => entry.origin), domains: entries.filter((entry) => entry.domain).map((entry) => entry.domain) });
      return { quarantined: true };
    });
  }
  async function confirmAccountSession({ actor, accountId } = {}) {
    human(actor);
    await approveAccount({ actor, accountId });
    return serialized(async () => {
      const account = findAccount(accountId);
      const confirmed = { ...account, sessionStatus: 'authenticated', updatedAt: new Date(now()).toISOString() };
      const next = { ...state, accounts: state.accounts.map((entry) => entry.id === accountId ? confirmed : entry) };
      await writeBrowserJson(filePath, next); state = next;
      const safeAccount = await metadata(confirmed);
      emit({ type: 'browser-account-changed', account: safeAccount });
      return { account: safeAccount };
    });
  }
  async function issueHandle({ actor, accountId, binding } = {}) {
    await readyPromise; sweep();
    const account = findAccount(accountId);
    await assertBrowserAccess({ actor, url: binding?.origin, tab: { profileId: account.profileId } });
    const target = boundValue({ ...binding, accountId });
    if (!account.origins.includes(target.origin)) throw failure('BROWSER_ACCOUNT_ORIGIN_MISMATCH', 'The credential target is outside the approved account origins.');
    const access = await policy.assertAllowed({ actor, action: 'account-use', url: target.origin, accountId, profileId: account.profileId });
    if (handles.size >= MAX_PENDING) throw failure('BROWSER_CREDENTIAL_HANDLE_LIMIT', 'Too many credential uses are pending.');
    const handle = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now() + HANDLE_TTL_MS;
    handles.set(handle, { accountId, accountVersion: account.version, policyVersion: access.accountVersion, actor: actorIdentity(actor), binding: target, expiresAt });
    return { handle, expiresAt };
  }
  async function fill({ actor, handle, binding, getBinding, fill: fillFields } = {}) {
    await readyPromise; sweep();
    const use = handles.get(handle);
    handles.delete(handle);
    if (!use) throw failure('BROWSER_CREDENTIAL_HANDLE_EXPIRED', 'The credential-use handle expired. Request a current handle.');
    use.invalidated = false;
    use.writes = new Set();
    activeUses.set(handle, use);
    try {
      const target = boundValue(binding);
      const account = findAccount(use.accountId);
      if (use.actor !== actorIdentity(actor) || account.version !== use.accountVersion || !sameBinding(use.binding, target)) throw failure('BROWSER_CREDENTIAL_BINDING_STALE', 'The account, tab, frame, navigation or controller changed before credential use.');
      const access = await policy.assertAllowed({ actor, action: 'account-use', url: target.origin, accountId: account.id, profileId: account.profileId });
      if (access.accountVersion !== use.policyVersion) throw failure('BROWSER_CREDENTIAL_BINDING_STALE', 'The account permission changed before credential use.');
      const secret = await readPassword(account.id);
      if (!secret || typeof secret.username !== 'string' || typeof secret.password !== 'string') throw failure('BROWSER_ACCOUNT_PASSWORD_MISSING', 'This saved account has no available password. Update it in Browser settings.');
      if (typeof fillFields !== 'function' || typeof getBinding !== 'function') throw failure('BROWSER_CREDENTIAL_FILL_UNAVAILABLE', 'The browser cannot verify and securely fill this account.');
      const finalTarget = boundValue(await getBinding());
      if (!sameBinding(use.binding, finalTarget) || findAccount(account.id).version !== use.accountVersion) throw failure('BROWSER_CREDENTIAL_BINDING_STALE', 'The page or account changed while the owner vault was responding.');
      await assertBrowserAccess({ actor, url: finalTarget.origin, tab: { profileId: account.profileId } });
      const finalAccess = await policy.assertAllowed({ actor, action: 'account-use', url: finalTarget.origin, accountId: account.id, profileId: account.profileId });
      if (finalAccess.accountVersion !== use.policyVersion) throw failure('BROWSER_CREDENTIAL_BINDING_STALE', 'The account permission changed before credential use.');
      const assertAuthorized = async () => {
        assertNotResetting();
        const current = findAccount(use.accountId);
        if (activeUses.get(handle) !== use || use.invalidated || use.expiresAt <= now() || current.version !== use.accountVersion) throw failure('BROWSER_CREDENTIAL_BINDING_STALE', 'The account credential use is no longer authorized.');
        const liveBinding = boundValue(await getBinding());
        if (!sameBinding(use.binding, liveBinding)) throw failure('BROWSER_CREDENTIAL_BINDING_STALE', 'The sign-in target changed before credential input.');
        await assertBrowserAccess({ actor, url: liveBinding.origin, tab: { profileId: current.profileId } });
        const grant = await policy.assertAllowed({ actor, action: 'account-use', url: liveBinding.origin, accountId: current.id, profileId: current.profileId });
        if (use.invalidated || activeUses.get(handle) !== use || findAccount(current.id).version !== use.accountVersion || grant.accountVersion !== use.policyVersion) throw failure('BROWSER_CREDENTIAL_BINDING_STALE', 'The account permission changed before credential input.');
      };
      const perform = async (writeField) => {
        if (typeof writeField !== 'function') throw failure('BROWSER_CREDENTIAL_FILL_UNAVAILABLE', 'A secure field write is required.');
        await assertAuthorized();
        if (use.invalidated || activeUses.get(handle) !== use) throw failure('BROWSER_CREDENTIAL_BINDING_STALE', 'The account credential use was cancelled.');
        let completed;
        const write = new Promise((resolve) => { completed = resolve; });
        use.writes.add(write);
        try { return await writeField(); }
        finally { completed(); use.writes.delete(write); }
      };
      try { await fillFields({ username: secret.username, password: secret.password, assertAuthorized, perform }); }
      catch { throw failure('BROWSER_CREDENTIAL_FILL_FAILED', 'Secure account fill failed. Refresh the sign-in page and try again.'); }
      await assertAuthorized();
      return { filled: true, accountId: account.id };
    } finally { await Promise.all([...use.writes]); activeUses.delete(handle); }
  }
  async function revokeAccount({ actor, accountId } = {}) {
    human(actor);
    return serialized(async () => {
      const account = findAccount(accountId);
      invalidateAccount(account.id);
      await policy.update({ actor, operation: 'revoke-account', accountId: account.id, origins: account.origins, profileId: account.profileId });
      await authStore.deleteCheckpoint(account.profileId);
      const safeAccount = await metadata(account);
      emit({ type: 'browser-account-changed', account: safeAccount });
      return { account: safeAccount };
    });
  }
  async function clearSession(account) {
    if (typeof sessionClearer !== 'function') throw failure('BROWSER_SESSION_CLEAR_UNAVAILABLE', 'Connect the browser runtime to clear this saved login.');
    const cleared = await sessionClearer({ accountId: account.id, profileId: account.profileId, origins: [...account.origins] });
    await authStore.deleteCheckpoint(account.profileId);
    return cleared ?? {};
  }
  async function signOut({ actor, accountId } = {}) {
    human(actor);
    await readyPromise;
    assertNotResetting();
    const target = clone(findAccount(accountId));
    invalidateAccount(target.id);
    await drainWrites([target.id]);
    const cleared = await clearSession(target);
    return serialized(async () => {
      const account = findAccount(accountId);
      invalidateAccount(account.id);
      const clearedDomains = (cleared.clearedDomains ?? []).map(normalizedDomain);
      const clearedOrigins = (cleared.clearedOrigins ?? []).map(browserOrigin);
      const affected = state.accounts.filter((entry) => entry.profileId === account.profileId && entry.origins.some((origin) => account.origins.includes(origin) || clearedOrigins.includes(origin) || clearedDomains.some((domain) => domainMatches(origin, domain))));
      const affectedIds = new Set(affected.map((entry) => entry.id));
      for (const id of affectedIds) invalidateAccount(id);
      await drainWrites([...affectedIds]);
      const updatedAt = new Date(now()).toISOString();
      const next = { ...state, accounts: state.accounts.map((entry) => affectedIds.has(entry.id) ? { ...entry, sessionStatus: 'signed-out', version: entry.version + 1, updatedAt } : entry) };
      await writeBrowserJson(filePath, next); state = next;
      const affectedAccounts = await Promise.all(state.accounts.filter((entry) => affectedIds.has(entry.id)).map(metadata));
      for (const record of affectedAccounts) emit({ type: 'browser-account-changed', account: record });
      return { account: affectedAccounts.find((entry) => entry.id === account.id), affectedAccounts };
    });
  }
  async function forgetAccount({ actor, accountId } = {}) {
    human(actor);
    await revokeAccount({ actor, accountId });
    await signOut({ actor, accountId });
    return serialized(async () => {
      const account = findAccount(accountId);
      invalidateAccount(account.id);
      await deletePassword(account.id);
      const next = { ...state, accounts: state.accounts.filter((entry) => entry.id !== account.id) };
      await writeBrowserJson(filePath, next); state = next;
      await policy.update({ actor, operation: 'forget-account', accountId: account.id });
      emit({ type: 'browser-account-forgotten', accountId: account.id });
      return { forgotten: true, accountId: account.id };
    });
  }
  async function saveCheckpoint({ profileId = 'default', state: storageState } = {}) {
    await readyPromise;
    assertNotResetting();
    const checkpointGeneration = dataGeneration;
    if (!storageState || !Array.isArray(storageState.cookies) || !Array.isArray(storageState.origins)) throw failure('BROWSER_AUTH_CHECKPOINT_INVALID', 'The browser session checkpoint is invalid.');
    const currentPolicy = await policy.list();
    assertNotResetting();
    if (checkpointGeneration !== dataGeneration) throw failure('BROWSER_RESET_INCOMPLETE', 'The browser authentication checkpoint was cancelled by cleanup.');
    const accounts = state.accounts.filter((account) => account.profileId === profileId).map((account) => ({ id: account.id, version: account.version, sessionVersion: account.sessionVersion ?? 0, policyVersion: currentPolicy.accounts.find((entry) => entry.accountId === account.id)?.version ?? 0 }));
    await authStore.saveCheckpoint(profileId, { schema: 1, profileId, accounts, state: storageState });
    return { saved: true };
  }
  async function restoreCheckpoint({ profileId = 'default' } = {}) {
    await readyPromise;
    if (resetting || state.resetPending) return null;
    const checkpointGeneration = dataGeneration;
    const saved = await authStore.restoreCheckpoint(profileId);
    if (resetting || state.resetPending || checkpointGeneration !== dataGeneration) return null;
    if (!saved) return null;
    const currentPolicy = await policy.list();
    const currentAccounts = state.accounts.filter((account) => account.profileId === profileId);
    if (saved.schema !== 1 || saved.profileId !== profileId || !Array.isArray(saved.accounts)
      || saved.accounts.length !== currentAccounts.length || saved.accounts.some((entry) => {
        const account = currentAccounts.find((item) => item.id === entry.id);
        const approval = currentPolicy.accounts.find((item) => item.accountId === entry.id);
        return !account || entry.version !== account.version || entry.policyVersion !== (approval?.version ?? 0) || !approval?.approved
          || entry.sessionVersion !== (account.sessionVersion ?? 0) || (account.sessionVersion ?? 0) !== sessionVersion(account);
      })) {
      await authStore.deleteCheckpoint(profileId);
      return null;
    }
    return resetting || state.resetPending || checkpointGeneration !== dataGeneration ? null : saved.state;
  }
  async function getConfiguration() {
    await readyPromise;
    return { ...clone(state.configuration), security: authStore.available ? clone(authStore.protection) : { passwords: 'unavailable', checkpoints: 'unavailable', chromiumProfile: 'restricted-plaintext-profile' }, googleSignIn: { mode: 'human-owned-full-browser', status: 'requires-compatibility-validation' } };
  }
  async function resetBrowserData({ actor } = {}) {
    human(actor);
    if (resetting) throw failure('BROWSER_RESET_IN_PROGRESS', 'Browser data cleanup is already running.');
    resetting = true;
    dataGeneration += 1;
    handles.clear(); requests.clear();
    for (const use of activeUses.values()) use.invalidated = true;
    return serialized(async () => {
      const accountIds = [...new Set([...(state.resetAccounts ?? []), ...state.accounts.map((account) => account.id)])];
      const profileIds = [...new Set(['default', ...(state.resetProfiles ?? []), ...state.accounts.map((account) => account.profileId), ...state.sessions.map((entry) => entry.profileId)])];
      const pending = { ...state, resetPending: true, resetAccounts: accountIds, resetProfiles: profileIds };
      await writeBrowserJson(filePath, pending); state = pending;
      emit({ type: 'browser-data-reset-started' });
      await drainWrites();
      await authStore.beginReset();
      for (const account of state.accounts) await policy.update({ actor, operation: 'revoke-account', accountId: account.id, origins: account.origins, profileId: account.profileId });
      if (typeof dataResetter !== 'function') throw failure('BROWSER_RESET_RUNTIME_UNAVAILABLE', 'Connect the browser runtime before clearing its saved profiles.');
      try {
        await dataResetter({ phase: 'before', profileIds });
        if (secretStore?.available) {
          if (typeof secretStore.resetBrowser === 'function') await secretStore.resetBrowser({ accountIds });
          else {
            for (const accountId of accountIds) await secretStore.delete(`browser.password.${accountId}`);
            await secretStore.delete('browser.wrapping-key.v1');
          }
        }
        await authStore.clearEncryptedData();
        for (const accountId of accountIds) await policy.update({ actor, operation: 'forget-account', accountId });
        const next = { ...state, accounts: [], sessions: [] };
        await writeBrowserJson(filePath, next); state = next;
        await dataResetter({ phase: 'after', profileIds });
        const complete = { ...state, resetPending: false };
        delete complete.resetAccounts; delete complete.resetProfiles;
        await writeBrowserJson(filePath, complete); state = complete;
        authStore.endReset();
        emit({ type: 'browser-data-reset', removedAccounts: accountIds.length });
        return { cleared: true, removedAccounts: accountIds.length };
      } catch {
        await dataResetter?.({ phase: 'failed', profileIds }).catch(() => {});
        throw failure('BROWSER_RESET_FAILED', 'Browser data cleanup did not finish. Account access remains blocked. Retry cleanup in Browser settings.');
      }
    }, { allowDuringReset: true }).finally(() => { resetting = false; });
  }
  async function updateConfiguration({ actor, downloads, preview } = {}) {
    human(actor);
    return serialized(async () => {
      const configuration = clone(state.configuration);
      if (downloads) {
        if (downloads.maxFileBytes !== undefined) {
          if (!Number.isSafeInteger(downloads.maxFileBytes) || downloads.maxFileBytes < 1024 * 1024 || downloads.maxFileBytes > 512 * 1024 * 1024) throw failure('BROWSER_CONFIGURATION_INVALID', 'The download limit must be between 1 and 512 MB.');
          configuration.downloads.maxFileBytes = downloads.maxFileBytes;
        }
        if (downloads.autoImport !== undefined) {
          if (typeof downloads.autoImport !== 'boolean') throw failure('BROWSER_CONFIGURATION_INVALID', 'The automatic import preference is invalid.');
          configuration.downloads.autoImport = downloads.autoImport;
        }
      }
      if (preview) {
        if (preview.mode !== undefined) {
          if (!['docked', 'floating', 'popout'].includes(preview.mode)) throw failure('BROWSER_CONFIGURATION_INVALID', 'The browser preview mode is invalid.');
          configuration.preview.mode = preview.mode;
        }
        if (preview.reducedMotion !== undefined) {
          if (typeof preview.reducedMotion !== 'boolean') throw failure('BROWSER_CONFIGURATION_INVALID', 'The motion preference is invalid.');
          configuration.preview.reducedMotion = preview.reducedMotion;
        }
      }
      const next = { ...state, configuration };
      await writeBrowserJson(filePath, next); state = next;
      emit({ type: 'browser-configuration-changed' });
      return getConfiguration();
    });
  }
  return {
    ready: () => readyPromise, requestAccount, getAccountRequest, cancelAccountRequest, listAccounts, submit, approveAccount,
    assertBrowserAccess, registerSessionOrigins, confirmAccountSession, issueHandle, fill, revokeAccount, signOut, forgetAccount,
    getConfiguration, updateConfiguration, resetBrowserData, saveCheckpoint, restoreCheckpoint,
    deleteCheckpoint: ({ profileId = 'default' } = {}) => authStore.deleteCheckpoint(profileId),
    setSessionClearer: (callback) => { sessionClearer = callback; },
    setDataResetter: (callback) => { dataResetter = callback; },
    invalidateTab: (tabId) => {
      for (const [id, handle] of handles) if (handle.binding.tabId === tabId) handles.delete(id);
      for (const use of activeUses.values()) if (use.binding.tabId === tabId) use.invalidated = true;
    },
    invalidateRuntime: () => { handles.clear(); for (const use of activeUses.values()) use.invalidated = true; },
    close: async () => { handles.clear(); requests.clear(); for (const use of activeUses.values()) use.invalidated = true; await drainWrites(); removePolicyGuard?.(); },
  };
}
