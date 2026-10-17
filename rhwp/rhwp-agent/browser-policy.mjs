import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ACTIONS = new Set(['browse', 'read', 'download', 'research-import', 'website-change', 'account-use']);
const RESEARCH_ACTIONS = ['browse', 'read', 'download', 'research-import'];
export const DEFAULT_RESEARCH_SITES = Object.freeze([
  { origin: 'https://www.google.com', label: 'Google Search' },
  { origin: 'https://docs.google.com', label: 'Google Slides / Docs reading' },
  { origin: 'https://drive.google.com', label: 'Google Drive reading' },
  { origin: 'https://accounts.google.com', label: 'Google account sign-in' },
  { origin: 'https://www.wikipedia.org', label: 'Wikipedia' },
  { origin: 'https://en.wikipedia.org', label: 'Wikipedia English' },
  { origin: 'https://ko.wikipedia.org', label: 'Wikipedia Korean' },
  { origin: 'https://pubmed.ncbi.nlm.nih.gov', label: 'PubMed' },
  { origin: 'https://pmc.ncbi.nlm.nih.gov', label: 'PMC' },
  { origin: 'https://arxiv.org', label: 'arXiv' },
]);

export function browserOrigin(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw failure('BROWSER_INVALID_ORIGIN', 'A valid website origin is required.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw failure('BROWSER_INVALID_ORIGIN', 'Only HTTP or HTTPS website origins are supported.');
  }
  return url.origin;
}

/** 사이트 사용 승인이 함께 덮는 출처 — 정확한 출처와, 호스트가 www. 하나만 다른 짝. 다른 하위 도메인은 넣지 않는다. */
export function siteAccessOrigins(value) {
  const origin = browserOrigin(value);
  const url = new URL(origin);
  const host = url.hostname;
  if (/^\d+(?:\.\d+){3}$/.test(host) || host.startsWith('[') || !host.includes('.')) return [origin];
  const twin = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
  if (!twin.includes('.')) return [origin];
  return [origin, `${url.protocol}//${twin}${url.port ? `:${url.port}` : ''}`];
}

/** 사이트 사용 승인이 허용하는 일 — 읽기와 사이트 변경. 계정 사용은 계정 승인으로 따로 기록한다. */
export const SITE_ACCESS_ACTIONS = Object.freeze(['browse', 'read', 'website-change']);

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function boundedText(value, limit = 200) { return String(value ?? '').trim().slice(0, limit); }
function actions(values = []) {
  if (!Array.isArray(values) || values.some((value) => !ACTIONS.has(value))) {
    throw failure('BROWSER_INVALID_POLICY', 'The website permission actions are invalid.');
  }
  return [...new Set(values)];
}
function origins(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 32) {
    throw failure('BROWSER_INVALID_POLICY', 'At least one exact account origin is required.');
  }
  return [...new Set(values.map(browserOrigin))];
}
function requireHuman(actor) {
  if (!actor?.isHuman) throw failure('BROWSER_OWNER_REQUIRED', 'Browser permissions can only be changed by the owner.');
}

export async function writeBrowserJson(filePath, value, maxBytes = 1024 * 1024) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > maxBytes) throw failure('BROWSER_STORAGE_LIMIT', 'Browser settings exceed their storage limit.');
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(filePath), 0o700);
  const temp = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await fs.open(temp, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await fs.rename(temp, filePath);
    await fs.chmod(filePath, 0o600);
  } finally { await fs.rm(temp, { force: true }); }
}

export async function readBrowserJson(filePath, maxBytes = 1024 * 1024) {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
      throw failure('BROWSER_STORAGE_INVALID', 'Browser settings storage is invalid.');
    }
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw failure('BROWSER_STORAGE_INVALID', 'Browser settings cannot be read. Restore the saved data before continuing.');
    throw error;
  }
}

export function createBrowserPolicy({ dataDir, ownerId = 'local-owner', onChange = () => {} } = {}) {
  if (!dataDir) throw new TypeError('Browser policy dataDir is required.');
  const filePath = path.join(dataDir, 'browser-policy.json');
  let state;
  let initialized = false;
  let queue = Promise.resolve();
  const changeGuards = new Set();
  /** threadId\naccountId → { origins, profileId, version } */
  const chatAccounts = new Map();
  let chatAccountVersion = 0;
  /** threadId\norigin → Set(action) — "이 채팅" 사이트 사용 승인. 허브 메모리에만 둔다. */
  const chatSites = new Map();
  const dropChatSites = (origin) => { for (const key of [...chatSites.keys()]) if (key.endsWith(`\n${origin}`)) chatSites.delete(key); };
  const chatAccountKey = (threadId, accountId) => `${threadId ?? ''}\n${accountId ?? ''}`;
  const readyPromise = (async () => {
    state = await readBrowserJson(filePath);
    if (state) {
      if (state.schema !== 1 || state.ownerId !== ownerId || !state.defaults || !Array.isArray(state.sites) || !Array.isArray(state.accounts)) {
        throw failure('BROWSER_POLICY_INVALID', 'Browser policy belongs to a different owner or cannot be read.');
      }
      if (Object.values(state.defaults).some((value) => typeof value !== 'boolean')) throw failure('BROWSER_POLICY_INVALID', 'Browser defaults cannot be read.');
      for (const site of state.sites) { site.origin = browserOrigin(site.origin); actions(site.allowedActions); actions(site.blockedActions); }
      for (const account of state.accounts) { account.origins = origins(account.origins); }
      initialized = true;
      return;
    }
    state = {
      schema: 1, ownerId, revision: 1, seeded: true,
      defaults: { browse: true, download: true, researchImport: true },
      sites: DEFAULT_RESEARCH_SITES.map((site) => ({ ...site, id: crypto.randomUUID(), source: 'research-default', allowedActions: [...RESEARCH_ACTIONS], blockedActions: [] })),
      accounts: [],
    };
    await writeBrowserJson(filePath, state);
    initialized = true;
  })();

  function effectiveResearch() {
    return { browse: initialized && state.defaults.browse === true, downloads: initialized && state.defaults.download === true, import: initialized && state.defaults.researchImport === true };
  }
  function categoryAvailability() {
    const defaults = effectiveResearch();
    if (!initialized) return defaults;
    const permitted = (requested) => state.sites.some((site) => site.source !== 'research-default' && requested.some((action) => site.allowedActions.includes(action) && !site.blockedActions.includes(action)));
    return { browse: defaults.browse || permitted(['browse', 'read']), downloads: defaults.downloads || permitted(['download']), import: defaults.import || permitted(['research-import']) };
  }

  async function list() { await readyPromise; return clone(state); }
  async function update(input = {}) {
    requireHuman(input.actor);
    const operation = async () => {
      await readyPromise;
      const next = clone(state);
      if (input.operation === 'set-default') {
        if (!['browse', 'download', 'researchImport'].includes(input.key) || typeof input.enabled !== 'boolean') throw failure('BROWSER_INVALID_POLICY', 'The research default is invalid.');
        next.defaults[input.key] = input.enabled;
      } else if (input.operation === 'set-site') {
        const origin = browserOrigin(input.origin);
        const previous = next.sites.find((site) => site.origin === origin);
        const allowedActions = actions(input.allowedActions ?? previous?.allowedActions ?? RESEARCH_ACTIONS);
        const blockedActions = actions(input.blockedActions ?? previous?.blockedActions ?? []);
        const site = { id: previous?.id ?? crypto.randomUUID(), origin, label: boundedText(input.label ?? previous?.label ?? origin), source: 'user', allowedActions, blockedActions };
        next.sites = next.sites.filter((entry) => entry.origin !== origin);
        next.sites.push(site);
        // 설정에서 사이트 권한을 다시 정하면 그 사이트의 "이 채팅" 승인도 그 결정을 따른다.
        dropChatSites(origin);
      } else if (input.operation === 'remove-site') {
        const origin = browserOrigin(input.origin);
        next.sites = next.sites.filter((site) => site.origin !== origin);
        dropChatSites(origin);
      } else if (input.operation === 'approve-account' || input.operation === 'revoke-account') {
        if (typeof input.accountId !== 'string' || !input.accountId) throw failure('BROWSER_INVALID_POLICY', 'The account identity is missing.');
        const previous = next.accounts.find((account) => account.accountId === input.accountId);
        const account = {
          accountId: input.accountId,
          profileId: boundedText(input.profileId ?? previous?.profileId ?? 'default', 100),
          origins: origins(input.origins ?? previous?.origins),
          approved: input.operation === 'approve-account',
          version: (previous?.version ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        };
        next.accounts = next.accounts.filter((entry) => entry.accountId !== input.accountId);
        next.accounts.push(account);
      } else if (input.operation === 'forget-account') {
        next.accounts = next.accounts.filter((entry) => entry.accountId !== input.accountId);
      } else throw failure('BROWSER_INVALID_POLICY', 'The browser policy operation is unknown.');
      // 계정 사용을 거두거나 지우면 채팅 승인도 함께 거둔다.
      if (input.operation === 'revoke-account' || input.operation === 'forget-account') {
        for (const key of [...chatAccounts.keys()]) if (key.endsWith(`\n${input.accountId}`)) chatAccounts.delete(key);
      }
      next.revision += 1;
      for (const guard of changeGuards) await guard({ operation: input.operation, accountId: input.accountId, origin: input.origin, key: input.key, enabled: input.enabled });
      await writeBrowserJson(filePath, next);
      state = next;
      try { onChange({ type: 'browser-policy-changed', revision: state.revision }); } catch {}
      return list();
    };
    const task = queue.then(operation, operation);
    queue = task.catch(() => {});
    return task;
  }

  async function check({ actor, action, url, accountId, profileId } = {}) {
    await readyPromise;
    if (!ACTIONS.has(action)) return { allowed: false, code: 'BROWSER_ACTION_UNKNOWN', reason: 'The browser action is unknown.' };
    const origin = url ? browserOrigin(url) : null;
    if (actor?.isHuman) return { allowed: true, origin, source: 'owner', revision: state.revision };
    const site = state.sites.find((entry) => entry.origin === origin);
    // 카드에서 방금 받은 "이 채팅" 사이트 승인은 그 채팅의 행위자에게만 적용된다.
    if (action !== 'account-use' && !accountId && actor?.threadId && chatSites.get(`${actor.threadId}\n${origin}`)?.has(action)) {
      return { allowed: true, origin, source: 'chat-site', revision: state.revision };
    }
    if (site?.blockedActions.includes(action)) return { allowed: false, origin, code: 'BROWSER_SITE_BLOCKED', reason: 'This website action has been revoked.', revision: state.revision };
    if (action === 'account-use' || accountId) {
      const account = state.accounts.find((entry) => entry.accountId === accountId);
      const matches = (grant) => !!grant && !!origin && grant.origins.includes(origin) && (!profileId || grant.profileId === profileId);
      const remembered = account?.approved && matches(account);
      // "이 채팅" 승인은 허브 메모리에만 있고 그 채팅의 행위자에게만 적용된다.
      const chat = remembered ? null : chatAccounts.get(chatAccountKey(actor?.threadId, accountId));
      if (!remembered && !matches(chat)) {
        return { allowed: false, origin, code: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED', reason: 'Approve this website account before agent access.', revision: state.revision };
      }
      if (action === 'account-use') return { allowed: true, origin, source: remembered ? 'remembered-account' : 'chat-account', accountVersion: remembered ? account.version : chat.version, revision: state.revision };
    }
    const enabled = action === 'browse' || action === 'read' ? state.defaults.browse
      : action === 'download' ? state.defaults.download
        : action === 'research-import' ? state.defaults.researchImport : false;
    if (site?.allowedActions.includes(action) && (site.source !== 'research-default' || enabled)) return { allowed: true, origin, source: site.source, revision: state.revision };
    return enabled ? { allowed: true, origin, source: 'research-default', revision: state.revision }
      : { allowed: false, origin, code: 'BROWSER_PERMISSION_REQUIRED', reason: 'This browser action requires owner approval.', revision: state.revision };
  }

  async function assertAllowed(input) {
    const result = await check(input);
    if (!result.allowed) throw failure(result.code, result.reason);
    return result;
  }

  /** 사용자가 "이 채팅"으로 승인한 계정 — 영구 정책에는 남기지 않는다. */
  async function grantChatAccount({ actor, threadId, accountId, origins: values, profileId = 'default' } = {}) {
    requireHuman(actor);
    await readyPromise;
    if (!threadId || typeof accountId !== 'string' || !accountId) throw failure('BROWSER_INVALID_POLICY', 'The chat account approval needs its chat and account.');
    const grant = { origins: origins(values), profileId: boundedText(profileId, 100), version: ++chatAccountVersion, grantedAt: Date.now() };
    for (const guard of changeGuards) await guard({ operation: 'approve-chat-account', accountId });
    chatAccounts.set(chatAccountKey(threadId, accountId), grant);
    try { onChange({ type: 'browser-policy-changed', revision: state.revision }); } catch {}
    return clone(grant);
  }
  function chatAccountApproved(actor, accountId) {
    return !!actor?.threadId && chatAccounts.has(chatAccountKey(actor.threadId, accountId));
  }
  /** 데스크톱 보관함은 이 시각 뒤에 사용자가 사용을 끈 계정이면 채팅 승인도 받지 않는다. */
  function chatAccountGrantedAt(actor, accountId) {
    return actor?.threadId ? chatAccounts.get(chatAccountKey(actor.threadId, accountId))?.grantedAt ?? null : null;
  }
  function clearChatAccounts(threadId) {
    for (const key of [...chatAccounts.keys()]) if (key.startsWith(`${threadId ?? ''}\n`)) chatAccounts.delete(key);
    for (const key of [...chatSites.keys()]) if (key.startsWith(`${threadId ?? ''}\n`)) chatSites.delete(key);
  }

  /**
   * 사이트 사용 카드의 승인. always 는 사이트 정책에 읽기·사이트 변경을 더하고(막아 둔 같은 동작은 푼다),
   * chat 은 이 채팅에만 허브 메모리로 허용한다. 출처는 정확한 출처와 www 짝만이다.
   */
  async function grantSiteAccess({ actor, threadId, origin, scope = 'chat', label } = {}) {
    requireHuman(actor);
    await readyPromise;
    if (!['chat', 'always'].includes(scope)) throw failure('BROWSER_INVALID_POLICY', 'Choose chat or always for this site approval.');
    const covered = siteAccessOrigins(origin);
    if (scope === 'chat') {
      if (!threadId) throw failure('BROWSER_INVALID_POLICY', 'A chat site approval needs its chat.');
      for (const entry of covered) {
        const key = `${threadId}\n${entry}`;
        chatSites.set(key, new Set([...(chatSites.get(key) ?? []), ...SITE_ACCESS_ACTIONS]));
      }
      try { onChange({ type: 'browser-policy-changed', revision: state.revision }); } catch {}
      return { origins: covered, scope };
    }
    for (const entry of covered) {
      const previous = state.sites.find((site) => site.origin === entry);
      await update({ actor, operation: 'set-site', origin: entry, label: previous?.label ?? label ?? new URL(entry).hostname,
        allowedActions: [...new Set([...(previous?.allowedActions ?? RESEARCH_ACTIONS), ...SITE_ACCESS_ACTIONS])],
        blockedActions: (previous?.blockedActions ?? []).filter((action) => !SITE_ACCESS_ACTIONS.includes(action)) });
    }
    return { origins: covered, scope };
  }

  return { ready: () => readyPromise, list, update, check, assertAllowed, effectiveResearch, categoryAvailability,
    grantChatAccount, chatAccountApproved, chatAccountGrantedAt, clearChatAccounts, grantSiteAccess,
    addChangeGuard: (guard) => { changeGuards.add(guard); return () => changeGuards.delete(guard); },
  };
}
