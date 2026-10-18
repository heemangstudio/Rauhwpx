import crypto from 'node:crypto';
import path from 'node:path';
import { browserOrigin, readBrowserJson, sameSite, siteName, siteScope, writeBrowserJson } from './browser-policy.mjs';
import { createEncryptedBrowserAuthStore } from './browser-auth-store.mjs';

// 허브 로그인(관리형 브라우저), 요청 카드, 세션 체크포인트. 권한 결정은 하지 않고 정책(policy.check)에 묻는다.
const REQUEST_TTL_MS = 10 * 60 * 1000;
const HANDLE_TTL_MS = 60 * 1000;
const MAX_PENDING = 128;
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BINDING_KEYS = ['tabId', 'runtimeGeneration', 'navigationEpoch', 'controlEpoch', 'frameId', 'origin', 'accountId'];
const SCOPE_KEYS = ['threadId', 'documentId', 'projectId'];
const ACTOR_KEYS = [...SCOPE_KEYS, 'agentId', 'clientId'];
const SESSION_PROFILES = new Set(['default', 'native']);
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function text(value, max = 200) { return String(value ?? '').trim().slice(0, max); }
function human(actor) { if (!actor?.isHuman) throw failure('BROWSER_OWNER_REQUIRED', 'Only the owner can manage website accounts.'); }
function sameScope(left, right) { return SCOPE_KEYS.every((key) => (left?.[key] ?? null) === (right?.[key] ?? null)); }
function actorIdentity(actor) { return JSON.stringify(ACTOR_KEYS.map((key) => actor?.[key] ?? null)); }
function loginOrigin(value) {
  const origin = browserOrigin(value);
  if (!origin.startsWith('https://')) throw failure('BROWSER_ACCOUNT_INSECURE_ORIGIN', 'Saved website accounts require HTTPS.');
  return origin;
}
function boundValue(input) {
  const result = Object.fromEntries(BINDING_KEYS.map((key) => [key, input?.[key]]));
  if (BINDING_KEYS.some((key) => result[key] === undefined || result[key] === null || result[key] === '')) throw failure('BROWSER_CREDENTIAL_BINDING_REQUIRED', 'Credential use requires a current tab, frame, navigation and controller binding.');
  result.origin = browserOrigin(result.origin);
  return result;
}
function sameBinding(left, right) { return BINDING_KEYS.every((key) => left[key] === right[key]); }
const defaultConfiguration = () => ({ profileId: 'default', downloads: { directory: 'managed', maxFileBytes: 100 * 1024 * 1024, autoImport: true }, preview: { mode: 'docked', reducedMotion: false } });

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
  let checkpointEpoch = 0;
  let checkpointMutations = 0;
  const requests = new Map();
  const resetParticipants = new Set();
  const handles = new Map();
  const activeUses = new Map();

  /** 스키마 1 → 2. 정책에 로그인 표시와 읽기 허용을 먼저 쓰고 이 파일을 쓴다. 중간에 끊겨도 다시 돌리면 같은 결과다. */
  async function migrate(stored) {
    const legacy = await policy.legacyAccounts();
    for (const session of Array.isArray(stored.sessions) ? stored.sessions : []) {
      // 출처를 모르는 세션(쿠키만 남은 기록)은 버린다. 사용자 세션만 로그인 표시로 옮긴다.
      if (session?.source !== 'human') continue;
      await policy.markSignedIn({ profileId: text(session.profileId ?? 'default', 100), origin: session.origin, domain: session.domain, source: 'legacy' });
    }
    for (const account of stored.accounts) {
      if (account.hasPassword !== false) continue;
      // 세션 승인 계정은 그 사이트의 읽기 허용과 로그인 표시가 된다(사이트 변경은 넓히지 않는다).
      if (!legacy.some((entry) => entry.accountId === account.id)) continue;
      for (const origin of Array.isArray(account.origins) ? account.origins : [account.origin]) {
        try { await policy.migrateAllow(origin, ['browse', 'read']); } catch { continue; }
        await policy.markSignedIn({ profileId: text(account.profileId ?? 'default', 100), origin, source: 'legacy' });
      }
    }
    const accounts = stored.accounts.filter((account) => account.hasPassword !== false).map((account) => {
      const { sessionVersion: _version, sourceAccountId: _source, ...login } = account;
      return { ...login, agentBlocked: account.agentBlocked === true, ...(account.blockedAt ? { blockedAt: account.blockedAt } : {}) };
    });
    const next = { schema: 2, accounts, configuration: stored.configuration ?? defaultConfiguration(),
      ...(stored.resetPending ? { resetPending: true, resetAccounts: stored.resetAccounts, resetProfiles: stored.resetProfiles } : {}) };
    await writeBrowserJson(filePath, next);
    await policy.dropLegacyAccounts();
    return next;
  }
  const readyPromise = (async () => {
    await policy.ready();
    const stored = await readBrowserJson(filePath);
    if (stored) {
      if (![1, 2].includes(stored.schema) || !Array.isArray(stored.accounts) || !stored.configuration || stored.accounts.length > 1024) throw failure('BROWSER_ACCOUNT_STORAGE_INVALID', 'Saved website account metadata cannot be read.');
      for (const account of stored.accounts) {
        if (!ACCOUNT_ID.test(account.id)) throw failure('BROWSER_ACCOUNT_STORAGE_INVALID', 'Saved website account identity cannot be read.');
        account.origin = browserOrigin(account.origin);
        account.origins = Array.isArray(account.origins) && account.origins.length ? [...new Set(account.origins.map(browserOrigin))] : [account.origin];
      }
      state = stored.schema === 1 ? await migrate(stored) : stored;
      if (stored.schema === 2 && (await policy.legacyAccounts()).length) await policy.dropLegacyAccounts();
      return;
    }
    state = { schema: 2, accounts: [], configuration: defaultConfiguration() };
    await writeBrowserJson(filePath, state);
    await policy.dropLegacyAccounts();
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
  async function mutateCheckpoints(operation) {
    checkpointEpoch++; checkpointMutations++;
    try { return await operation(); }
    finally { checkpointEpoch++; checkpointMutations--; }
  }
  function assertCheckpointEpoch(epoch) {
    if (checkpointMutations || checkpointEpoch !== epoch) throw failure('BROWSER_AUTH_CHECKPOINT_INVALIDATED', 'The browser authentication checkpoint was cancelled by an account change.');
  }
  function invalidateAccount(id) {
    for (const [key, handle] of handles) if (handle.accountId === id) handles.delete(key);
    for (const use of activeUses.values()) if (use.accountId === id) use.invalidated = true;
  }
  async function drainWrites(accountIds) {
    const selected = accountIds ? new Set(accountIds) : null;
    await Promise.all([...activeUses.values()].filter((use) => !selected || selected.has(use.accountId)).flatMap((use) => [...use.writes]));
  }
  // 사이트 승인이 줄면 그 사이트에서 진행 중인 입력을 멈추고, 이미 시작한 쓰기가 끝난 뒤에야 변경을 받아들인다.
  const removePolicyGuard = policy.addChangeGuard?.(async (change) => {
    const touched = (use) => !change.origin || sameSite(use.binding.origin, change.origin);
    const selected = [...new Set([...handles.values(), ...activeUses.values()].filter(touched).map((use) => use.accountId))];
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
  function metadata(account) {
    const { blockedAt: _blockedAt, ...login } = clone(account);
    return { ...login, site: siteName(account.origin), agentBlocked: account.agentBlocked === true };
  }
  async function write(next) { await writeBrowserJson(filePath, next); state = next; }
  async function listAccounts() {
    await readyPromise;
    return { accounts: state.accounts.map(metadata), secureStorageAvailable: !!(secretStore?.available || authStore.available) };
  }

  /**
   * 요청 카드. site: 사이트 사용(목록·차단은 호출자가 정책과 활성 저장소에서 모아 넘긴다), account: 로그인 저장 양식,
   * sign-in / code: 사용자가 그 탭에서 직접 한다. 같은 채팅·같은 사이트의 같은 종류 요청은 이미 열린 요청을 돌려준다.
   */
  async function requestAccount({ actor, tabId, origin, label, reason, kind = 'account', logins = [], secrets = [], blocked = [], item = null, origins: siteOrigins } = {}) {
    await readyPromise;
    assertNotResetting();
    sweep();
    if (!actor || (!actor.isHuman && !actor.threadId)) throw failure('BROWSER_ACTOR_REQUIRED', 'A browser account request needs an owning chat or human client.');
    const normalizedOrigin = browserOrigin(origin);
    const scope = siteScope(normalizedOrigin);
    const requestKind = kind === 'site' ? 'browser-site-access' : kind === 'code' ? 'browser-code' : kind === 'sign-in' ? 'browser-sign-in' : 'browser-save-account';
    if (['browser-sign-in', 'browser-code'].includes(requestKind) && !tabId) throw failure('BROWSER_TAB_REQUIRED', 'A sign-in handoff needs the browser tab to hand over.');
    if (requestKind === 'browser-save-account') loginOrigin(normalizedOrigin);
    const keys = [...new Set([scope.key, ...(siteOrigins ?? []).map((value) => siteScope(value).key)])];
    const pending = [...requests.values()].find((entry) => entry.kind === requestKind && sameScope(entry.actor, actor)
      && entry.origins[0] === keys[0] && (!['browser-sign-in', 'browser-code'].includes(requestKind) || entry.tabId === tabId));
    if (pending) return { ...clone(pending), duplicate: true };
    if (requests.size >= MAX_PENDING) throw failure('BROWSER_ACCOUNT_REQUEST_LIMIT', 'Too many website account requests are pending.');
    const site = scope.domain ?? new URL(scope.key).host;
    const request = {
      requestId: crypto.randomUUID(), kind: requestKind,
      origin: normalizedOrigin, origins: keys, site, siteDomain: scope.domain,
      accountLabel: text(label ?? site), tabId: tabId ?? null, reason: text(reason, 500), expiresAt: now() + REQUEST_TTL_MS, actor: clone(actor),
    };
    if (requestKind === 'browser-site-access') {
      Object.assign(request, {
        logins: logins.map((login) => ({ id: login.id, label: text(login.label, 200), origin: login.origin, source: login.source, agentBlocked: login.agentBlocked === true })),
        secrets: secrets.map((secret) => ({ id: secret.id, label: text(secret.label, 80), kind: secret.kind, origins: [...(secret.origins ?? [])], blocked: secret.blocked === true })),
        blocked: [...new Set(blocked)], item: item ? clone(item) : null,
        scopes: blocked.length || item ? ['always'] : ['chat', 'always'],
      });
      // 예전 카드가 읽던 계정 한 줄. 첫 번째 로그인이다.
      const first = request.logins[0];
      if (first) Object.assign(request, { accountId: first.id, accountLabel: first.label });
    } else if (requestKind === 'browser-save-account') request.scopes = ['chat', 'always'];
    requests.set(request.requestId, request);
    const publicRequest = clone(request);
    emit({ type: 'browser-account-request', request: publicRequest });
    return publicRequest;
  }
  /** 허브가 만료·중지·거절로 닫은 요청을 버린다. 이미 없으면 false. */
  function discardAccountRequest(id) {
    sweep();
    return requests.delete(id);
  }
  async function getAccountRequest(id) {
    await readyPromise; sweep();
    const request = requests.get(id);
    return request ? clone(request) : null;
  }
  /** 이 채팅의 열린 사이트 카드(같은 사이트). 한 번 승인하면 모두 닫는다. */
  async function pendingSiteRequests(actor, origin) {
    await readyPromise; sweep();
    const key = siteScope(origin).key;
    return [...requests.values()].filter((entry) => entry.kind === 'browser-site-access' && sameScope(entry.actor, actor) && entry.origins.includes(key)).map(clone);
  }
  function consumeRequest(id) {
    sweep();
    const request = requests.get(id);
    if (!request) throw failure('BROWSER_ACCOUNT_REQUEST_EXPIRED', 'The website account request expired. Request it again.');
    return request;
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
  /** 사용자가 답한 요청을 닫는다. 승인이 무엇을 쓰는지는 서버가 정책에 정한다. */
  async function settleRequest({ actor, requestId, kinds } = {}) {
    human(actor);
    await readyPromise;
    const request = consumeRequest(requestId);
    if ((kinds && !kinds.includes(request.kind)) || !sameScope(request.actor, actor)) throw failure('BROWSER_ACCOUNT_CONSENT_REQUIRED', 'This website account request belongs to a different chat.');
    requests.delete(requestId);
    return clone(request);
  }
  /** 사용자가 넘겨받은 탭에서 로그인·코드 입력을 마쳤다. 서버가 로그인 표시와 이 채팅의 사이트 사용을 남긴다. */
  async function completeHandoff({ actor, requestId } = {}) {
    human(actor);
    await readyPromise;
    const request = consumeRequest(requestId);
    if (!['browser-sign-in', 'browser-code'].includes(request.kind)) throw failure('BROWSER_ACCOUNT_REQUEST_INVALID', 'This request is not a sign-in handoff.');
    if (!sameScope(request.actor, actor)) throw failure('BROWSER_ACCOUNT_CONSENT_REQUIRED', 'This website account request belongs to a different chat.');
    requests.delete(requestId);
    return { completed: true, origin: request.origin, site: request.site, request: clone(request) };
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
  /** 저장 카드나 설정에서 받은 로그인을 허브 저장소(관리형 브라우저)에 둔다. 사이트 승인은 서버가 정한다. */
  async function saveLogin({ actor, requestId, account: submitted = {}, username, password } = {}) {
    human(actor);
    return serialized(async () => {
      const request = consumeRequest(requestId);
      if (request.kind !== 'browser-save-account' || !sameScope(request.actor, actor)) throw failure('BROWSER_ACCOUNT_CONSENT_REQUIRED', 'The website account request needs current owner approval.');
      if (typeof username !== 'string' || typeof password !== 'string' || !password || Buffer.byteLength(username) + Buffer.byteLength(password) > 12 * 1024) throw failure('BROWSER_ACCOUNT_INVALID', 'Enter a valid username and password within the account size limit.');
      const origin = loginOrigin(submitted.origin ?? request.origin);
      if (!sameSite(origin, request.origin)) throw failure('BROWSER_ACCOUNT_ORIGIN_MISMATCH', 'The account belongs to a different website. Request it again.');
      // 같은 사이트의 같은 아이디는 새로 만들지 않고 고친다. 설정의 계정 수정은 그 계정 id 를 넘긴다.
      const previous = submitted.id ? findAccount(submitted.id)
        : state.accounts.find((entry) => entry.origin === origin && entry.stableIdentity === text(submitted.stableIdentity ?? username, 256)) ?? null;
      if (previous && !sameSite(previous.origin, request.origin)) throw failure('BROWSER_ACCOUNT_ORIGIN_MISMATCH', 'The account belongs to a different website. Request it again.');
      const id = previous?.id ?? crypto.randomUUID();
      const record = {
        id, origin, origins: [origin], label: text(submitted.label ?? (username || request.accountLabel)),
        stableIdentity: text(submitted.stableIdentity ?? previous?.stableIdentity ?? (username || id), 256),
        profileId: 'default', hasPassword: true, sessionStatus: 'saved', agentBlocked: previous?.agentBlocked === true,
        ...(previous?.blockedAt ? { blockedAt: previous.blockedAt } : {}),
        version: (previous?.version ?? 0) + 1, updatedAt: new Date(now()).toISOString(),
      };
      requests.delete(requestId);
      invalidateAccount(id);
      await writePassword(id, { username, password });
      await write({ ...state, accounts: state.accounts.filter((entry) => entry.id !== id).concat(record) });
      const safeAccount = metadata(record);
      emit({ type: 'browser-account-changed', account: safeAccount });
      return { account: safeAccount, request: clone(request) };
    });
  }
  /** 로그인 하나의 에이전트 사용을 끄거나 켠다. 체크포인트와 세션은 건드리지 않는다. */
  async function setLoginBlocked({ actor, accountId, blocked } = {}) {
    human(actor);
    if (typeof blocked !== 'boolean') throw failure('BROWSER_ACCOUNT_INVALID', 'Choose whether the agent may use this login.');
    return serialized(async () => {
      const account = findAccount(accountId);
      invalidateAccount(account.id);
      await drainWrites([account.id]);
      const updated = { ...account, agentBlocked: blocked, ...(blocked ? { blockedAt: now() } : {}), version: account.version + 1, updatedAt: new Date(now()).toISOString() };
      await write({ ...state, accounts: state.accounts.map((entry) => entry.id === account.id ? updated : entry) });
      const safeAccount = metadata(updated);
      emit({ type: 'browser-account-changed', account: safeAccount });
      return { account: safeAccount };
    });
  }
  /** 사용자가 전체 브라우저 로그인을 마쳤다. 그 사이트에 로그인 표시를 남긴다. 승인은 따로 없다. */
  async function confirmAccountSession({ actor, accountId, additionalProfileId } = {}) {
    human(actor);
    if (additionalProfileId !== undefined && additionalProfileId !== 'native') throw failure('BROWSER_ACCOUNT_PROFILE_INVALID', 'Website sign-in can return only to the native browser profile.');
    const confirmed = await serialized(async () => {
      const account = findAccount(accountId);
      const profiles = [...new Set([account.profileId, ...(account.sessionProfiles ?? []), ...(additionalProfileId ? [additionalProfileId] : [])])];
      const updated = { ...account, sessionStatus: 'authenticated', sessionProfiles: profiles, updatedAt: new Date(now()).toISOString() };
      await write({ ...state, accounts: state.accounts.map((entry) => entry.id === account.id ? updated : entry) });
      return updated;
    });
    for (const profileId of confirmed.sessionProfiles) for (const origin of confirmed.origins) await policy.markSignedIn({ profileId, origin, source: 'handoff' });
    const safeAccount = metadata(confirmed);
    emit({ type: 'browser-account-changed', account: safeAccount });
    return { account: safeAccount };
  }
  const loginItem = (account) => ({ accountId: account.id, blocked: account.agentBlocked === true });
  async function issueHandle({ actor, accountId, binding } = {}) {
    await readyPromise; sweep();
    assertNotResetting();
    const account = findAccount(accountId);
    const target = boundValue({ ...binding, accountId });
    // 로그인은 저장된 사이트(같은 등록 도메인)의 페이지에만 채운다.
    if (!sameSite(account.origin, target.origin)) throw failure('BROWSER_ACCOUNT_ORIGIN_MISMATCH', 'The credential target is outside this login\'s website.');
    const access = await policy.assertAllowed({ actor, action: 'account-use', url: target.origin, profileId: account.profileId, item: loginItem(account) });
    if (handles.size >= MAX_PENDING) throw failure('BROWSER_CREDENTIAL_HANDLE_LIMIT', 'Too many credential uses are pending.');
    const handle = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now() + HANDLE_TTL_MS;
    handles.set(handle, { accountId, accountVersion: account.version, grantEpoch: access.grantEpoch, actor: actorIdentity(actor), binding: target, expiresAt });
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
    // 승인은 매번 다시 묻는다. 승인이 바뀌었으면(grantEpoch) 진행 중이던 입력도 멈춘다.
    const authorize = async (origin) => {
      assertNotResetting();
      const current = findAccount(use.accountId);
      if (current.version !== use.accountVersion) throw failure('BROWSER_CREDENTIAL_BINDING_STALE', 'The account changed before credential use.');
      if (!sameSite(current.origin, origin)) throw failure('BROWSER_ACCOUNT_ORIGIN_MISMATCH', 'The credential target is outside this login\'s website.');
      const access = await policy.assertAllowed({ actor, action: 'account-use', url: origin, profileId: current.profileId, item: loginItem(current) });
      if (access.grantEpoch !== use.grantEpoch) throw failure('BROWSER_CREDENTIAL_BINDING_STALE', 'The site permission changed before credential use.');
      return current;
    };
    try {
      const target = boundValue(binding);
      if (use.actor !== actorIdentity(actor) || !sameBinding(use.binding, target)) throw failure('BROWSER_CREDENTIAL_BINDING_STALE', 'The account, tab, frame, navigation or controller changed before credential use.');
      const account = await authorize(target.origin);
      const secret = await readPassword(account.id);
      if (!secret || typeof secret.username !== 'string' || typeof secret.password !== 'string') throw failure('BROWSER_ACCOUNT_PASSWORD_MISSING', 'This saved account has no available password. Update it in Browser settings.');
      if (typeof fillFields !== 'function' || typeof getBinding !== 'function') throw failure('BROWSER_CREDENTIAL_FILL_UNAVAILABLE', 'The browser cannot verify and securely fill this account.');
      const finalTarget = boundValue(await getBinding());
      if (!sameBinding(use.binding, finalTarget)) throw failure('BROWSER_CREDENTIAL_BINDING_STALE', 'The page or account changed while the owner vault was responding.');
      await authorize(finalTarget.origin);
      const assertAuthorized = async () => {
        if (activeUses.get(handle) !== use || use.invalidated || use.expiresAt <= now()) throw failure('BROWSER_CREDENTIAL_BINDING_STALE', 'The account credential use is no longer authorized.');
        const liveBinding = boundValue(await getBinding());
        if (!sameBinding(use.binding, liveBinding)) throw failure('BROWSER_CREDENTIAL_BINDING_STALE', 'The sign-in target changed before credential input.');
        await authorize(liveBinding.origin);
        if (use.invalidated || activeUses.get(handle) !== use) throw failure('BROWSER_CREDENTIAL_BINDING_STALE', 'The account permission changed before credential input.');
      };
      const perform = async (writeField) => {
        if (typeof writeField !== 'function') throw failure('BROWSER_CREDENTIAL_FILL_UNAVAILABLE', 'A secure field write is required.');
        await assertAuthorized();
        if (use.invalidated || activeUses.get(handle) !== use) throw failure('BROWSER_CREDENTIAL_BINDING_STALE', 'The account credential use was cancelled.');
        let completed;
        const pending = new Promise((resolve) => { completed = resolve; });
        use.writes.add(pending);
        try { return await writeField(); }
        finally { completed(); use.writes.delete(pending); }
      };
      try { await fillFields({ username: secret.username, password: secret.password, assertAuthorized, perform }); }
      catch { throw failure('BROWSER_CREDENTIAL_FILL_FAILED', 'Secure account fill failed. Refresh the sign-in page and try again.'); }
      await assertAuthorized();
      void serialized(async () => {
        const current = state.accounts.find((entry) => entry.id === account.id);
        if (current) await write({ ...state, accounts: state.accounts.map((entry) => entry.id === account.id ? { ...entry, filledAt: now() } : entry) });
      }).catch(() => {});
      return { filled: true, accountId: account.id };
    } finally { await Promise.all([...use.writes]); activeUses.delete(handle); }
  }
  /** 최근에 페이지에 넣은 로그인 비밀번호. 허브가 다시 시작해도 관찰에서 계속 가린다. */
  async function filledPasswords({ since = 0, limit = 64 } = {}) {
    await readyPromise;
    const values = [];
    for (const account of state.accounts.filter((entry) => (entry.filledAt ?? 0) >= since).slice(-limit)) {
      try { const secret = await readPassword(account.id); if (typeof secret?.password === 'string' && secret.password) values.push(secret.password); } catch {}
    }
    return values;
  }
  async function clearSession(account, profileId) {
    if (typeof sessionClearer !== 'function') throw failure('BROWSER_SESSION_CLEAR_UNAVAILABLE', 'Connect the browser runtime to clear this saved login.');
    const cleared = await sessionClearer({ accountId: account.id, profileId, origins: [...account.origins] });
    await authStore.deleteCheckpoint(profileId);
    return cleared ?? {};
  }
  /** 로그아웃: 이 로그인이 세션을 둔 프로필마다 사이트 저장소를 지우고, 로그인 표시도 지운다. */
  async function signOut({ actor, accountId } = {}) {
    human(actor);
    return mutateCheckpoints(async () => {
      await readyPromise;
      assertNotResetting();
      const target = clone(findAccount(accountId));
      invalidateAccount(target.id);
      await drainWrites([target.id]);
      const profiles = [...new Set([target.profileId, ...(target.sessionProfiles ?? [])])].filter((profileId) => SESSION_PROFILES.has(profileId));
      for (const profileId of profiles) {
        await clearSession(target, profileId);
        for (const origin of target.origins) await policy.clearSignedIn({ profileId, origin });
      }
      return serialized(async () => {
        const affected = state.accounts.filter((entry) => entry.id === target.id || target.origins.some((origin) => sameSite(origin, entry.origin)));
        const ids = new Set(affected.map((entry) => entry.id));
        for (const id of ids) invalidateAccount(id);
        await drainWrites([...ids]);
        const updatedAt = new Date(now()).toISOString();
        await write({ ...state, accounts: state.accounts.map((entry) => ids.has(entry.id) ? { ...entry, sessionStatus: 'signed-out', version: entry.version + 1, updatedAt } : entry) });
        const affectedAccounts = state.accounts.filter((entry) => ids.has(entry.id)).map(metadata);
        for (const record of affectedAccounts) emit({ type: 'browser-account-changed', account: record });
        return { account: affectedAccounts.find((entry) => entry.id === target.id), affectedAccounts };
      });
    });
  }
  /** 로그인을 지운다. 세션은 그대로 두고 그 사이트의 로그인 표시만 지운다. */
  async function forgetAccount({ actor, accountId } = {}) {
    human(actor);
    const forgotten = await serialized(async () => {
      const account = findAccount(accountId);
      invalidateAccount(account.id);
      await drainWrites([account.id]);
      await deletePassword(account.id);
      await write({ ...state, accounts: state.accounts.filter((entry) => entry.id !== account.id) });
      emit({ type: 'browser-account-forgotten', accountId: account.id });
      return account;
    });
    for (const profileId of new Set([forgotten.profileId, ...(forgotten.sessionProfiles ?? [])])) for (const origin of forgotten.origins) await policy.clearSignedIn({ profileId, origin });
    return { forgotten: true, accountId: forgotten.id };
  }
  async function saveCheckpoint({ profileId = 'default', state: storageState } = {}) {
    const epoch = checkpointEpoch;
    assertCheckpointEpoch(epoch);
    await readyPromise;
    assertCheckpointEpoch(epoch);
    assertNotResetting();
    const checkpointGeneration = dataGeneration;
    if (!storageState || !Array.isArray(storageState.cookies) || !Array.isArray(storageState.origins)) throw failure('BROWSER_AUTH_CHECKPOINT_INVALID', 'The browser session checkpoint is invalid.');
    let checkpointState = storageState;
    if (storageState.originsComplete === false) {
      if (profileId !== 'native' || storageState.origins.length) throw failure('BROWSER_AUTH_CHECKPOINT_INVALID', 'Partial origin checkpoints require the protected native browser.');
      // 보호된 탭은 원본 저장소를 읽지 않는다. 이전 체크포인트의 출처 저장소를 유지한다.
      const previous = await restoreCheckpoint({ profileId });
      checkpointState = { cookies: storageState.cookies, origins: previous?.origins ?? [] };
    }
    assertCheckpointEpoch(epoch);
    assertNotResetting();
    if (checkpointGeneration !== dataGeneration) throw failure('BROWSER_RESET_INCOMPLETE', 'The browser authentication checkpoint was cancelled by cleanup.');
    await authStore.saveCheckpoint(profileId, { schema: 2, profileId, state: checkpointState });
    return { saved: true };
  }
  async function restoreCheckpoint({ profileId = 'default' } = {}) {
    const epoch = checkpointEpoch;
    await readyPromise;
    const stale = () => checkpointMutations || checkpointEpoch !== epoch || resetting || state.resetPending || checkpointGeneration !== dataGeneration;
    const checkpointGeneration = dataGeneration;
    if (stale()) return null;
    const saved = await authStore.restoreCheckpoint(profileId);
    if (stale() || !saved) return null;
    // 체크포인트는 저장소만 담는다. 스키마 1 의 계정 기록은 읽지 않는다.
    if (![1, 2].includes(saved.schema) || saved.profileId !== profileId || !saved.state || !Array.isArray(saved.state.cookies) || !Array.isArray(saved.state.origins)) return null;
    return stale() ? null : saved.state;
  }
  async function getConfiguration() {
    await readyPromise;
    return { searchEngine: 'google', performance: { idleMinutes: 15 }, ...clone(state.configuration), security: authStore.available ? clone(authStore.protection) : { passwords: 'unavailable', checkpoints: 'unavailable', chromiumProfile: 'restricted-plaintext-profile' }, googleSignIn: { mode: 'human-owned-full-browser', status: 'requires-compatibility-validation' } };
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
      const profileIds = [...new Set(['default', ...(state.resetProfiles ?? []), ...state.accounts.flatMap((account) => [account.profileId, ...(account.sessionProfiles ?? [])])])];
      await write({ ...state, resetPending: true, resetAccounts: accountIds, resetProfiles: profileIds });
      emit({ type: 'browser-data-reset-started' });
      await drainWrites();
      await authStore.beginReset();
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
        for (const participant of resetParticipants) await participant();
        // 사이트 승인과 차단은 남기고, 로그인 표시만 지운다.
        await policy.clearAllSignedIn();
        await write({ ...state, accounts: [] });
        await dataResetter({ phase: 'after', profileIds });
        const complete = { ...state, resetPending: false };
        delete complete.resetAccounts; delete complete.resetProfiles;
        await write(complete);
        authStore.endReset();
        emit({ type: 'browser-data-reset', removedAccounts: accountIds.length });
        return { cleared: true, removedAccounts: accountIds.length };
      } catch {
        await dataResetter?.({ phase: 'failed', profileIds }).catch(() => {});
        throw failure('BROWSER_RESET_FAILED', 'Browser data cleanup did not finish. Account access remains blocked. Retry cleanup in Browser settings.');
      }
    }, { allowDuringReset: true }).finally(() => { resetting = false; });
  }
  async function updateConfiguration({ actor, downloads, preview, performance, searchEngine } = {}) {
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
      if (searchEngine !== undefined) {
        if (!['duckduckgo', 'google', 'bing', 'naver'].includes(searchEngine)) throw failure('BROWSER_CONFIGURATION_INVALID', 'Choose a supported search engine.');
        configuration.searchEngine = searchEngine;
      }
      if (performance) {
        if (!Number.isInteger(performance.idleMinutes) || performance.idleMinutes < 0 || performance.idleMinutes > 1440) throw failure('BROWSER_CONFIGURATION_INVALID', 'The sleep time must be between 0 and 1440 minutes.');
        configuration.performance = { idleMinutes: performance.idleMinutes };
      }
      await write({ ...state, configuration });
      emit({ type: 'browser-configuration-changed' });
      return getConfiguration();
    });
  }
  return {
    ready: () => readyPromise, requestAccount, getAccountRequest, discardAccountRequest, cancelAccountRequest, settleRequest, pendingSiteRequests, completeHandoff,
    listAccounts, saveLogin, setLoginBlocked, confirmAccountSession, issueHandle, fill, filledPasswords, signOut, forgetAccount,
    getConfiguration, updateConfiguration, resetBrowserData, saveCheckpoint, restoreCheckpoint,
    deleteCheckpoint: ({ profileId = 'default' } = {}) => authStore.deleteCheckpoint(profileId),
    setSessionClearer: (callback) => { sessionClearer = callback; },
    setDataResetter: (callback) => { dataResetter = callback; },
    /** 브라우저 데이터 초기화 안에서 함께 지울 저장소(사용자 비밀 등). */
    addResetParticipant: (callback) => { resetParticipants.add(callback); return () => resetParticipants.delete(callback); },
    invalidateTab: (tabId) => {
      for (const [id, handle] of handles) if (handle.binding.tabId === tabId) handles.delete(id);
      for (const use of activeUses.values()) if (use.binding.tabId === tabId) use.invalidated = true;
    },
    invalidateRuntime: () => { handles.clear(); for (const use of activeUses.values()) use.invalidated = true; },
    close: async () => { handles.clear(); requests.clear(); for (const use of activeUses.values()) use.invalidated = true; await drainWrites(); removePolicyGuard?.(); },
  };
}
