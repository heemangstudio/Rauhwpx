import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseDomain } from 'tldts';

// 브라우저 권한의 유일한 결정 지점. 서비스·자격 증명 중개자·서버·데스크톱 모두 check() 에 묻고, 모든 카드는 이 상태에 쓴다.
const ACTIONS = new Set(['browse', 'read', 'download', 'research-import', 'website-change', 'account-use']);
const RESEARCH_ACTIONS = ['browse', 'read', 'download', 'research-import'];
/** 사이트 사용 하나가 허용하는 일: 로그인한 채 읽기, 사이트 변경, 그 사이트의 저장된 로그인·비밀 사용. */
export const SITE_ACCESS_ACTIONS = Object.freeze(['browse', 'read', 'website-change', 'account-use']);
const POLICY_BYTES = 4 * 1024 * 1024;
const CHAT_GRANT_LIMIT = 2048;
const CHAT_GRANT_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const CHAT_GRANT_TOUCH_MS = 24 * 60 * 60 * 1000;
const SIGNED_IN_LIMIT = 4096;
const SIGNED_IN_SOURCES = new Set(['owner-form', 'handoff', 'chrome-import', 'passkey', 'federated', 'legacy']);
/** 허브의 웹 비서 행위자(chatgpt-web.mjs·claude-web.mjs)가 쓰는 사이트. 일반 에이전트 브라우저 도구에는 해당하지 않는다. */
const SYSTEM_ACTOR_SITE_KEYS = Object.freeze({
  chatgpt: Object.freeze(['https://chatgpt.com', 'https://openai.com']),
  claude: Object.freeze(['https://claude.ai', 'https://anthropic.com']),
});
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

/** 웹 출처. about:·data:·blob:·chrome-error: 처럼 사이트가 없는 주소는 null 이다. */
export function webOrigin(value) {
  try { const url = new URL(String(value)); return ['https:', 'http:'].includes(url.protocol) ? url.origin : null; } catch { return null; }
}

const scopeCache = new Map();
/**
 * 사이트 범위. HTTPS 이고 공개 접미사 목록(사설 접미사 포함)에 있는 등록 도메인이면 그 도메인 전체
 * (key https://coupang.com, domain coupang.com)다. IP·localhost·알 수 없는 접미사·공개 접미사 자체·HTTP 는 정확한 출처만 덮는다.
 */
export function siteScope(value) {
  const origin = browserOrigin(value);
  const cached = scopeCache.get(origin);
  if (cached) return { ...cached };
  const url = new URL(origin);
  let scope = { origin, key: origin, domain: null };
  if (url.protocol === 'https:') {
    const parsed = parseDomain(url.hostname, { allowPrivateDomains: true });
    if (!parsed.isIp && parsed.domain && (parsed.isIcann || parsed.isPrivate)) scope = { origin, key: `https://${parsed.domain}${url.port ? `:${url.port}` : ''}`, domain: parsed.domain };
  }
  if (scopeCache.size >= 2048) scopeCache.clear();
  scopeCache.set(origin, scope);
  return { ...scope };
}

/** 로그인 표시의 키. 쿠키처럼 포트를 가리지 않는 https://등록도메인 이고, 등록 도메인이 없으면 null 이다. */
export function signedInKey(value) {
  try { const scope = siteScope(value); return scope.domain ? `https://${scope.domain}` : null; } catch { return null; }
}

/** 사람이 읽는 사이트 이름 — 등록 도메인, 없으면 호스트(포트 포함). */
export function siteName(value) {
  const scope = siteScope(value);
  return scope.domain ?? new URL(scope.key).host;
}

/** 두 출처가 같은 사이트인가 — 같은 출처이거나 같은 등록 도메인(HTTPS)이다. */
export function sameSite(left, right) {
  try {
    const a = siteScope(left), b = siteScope(right);
    return a.origin === b.origin || (!!a.domain && a.key === b.key);
  } catch { return false; }
}

/** 사이트 사용 승인이 덮는 범위의 대표 출처 — 등록 도메인이면 https://도메인, 아니면 정확한 출처. */
export function siteAccessOrigins(value) {
  return [siteScope(value).key];
}

/** 설정 항목이 덮는 키 — 연구 기본값은 정확한 출처, 사용자 항목은 사이트 키이거나(허용·도메인 차단) 하위 호스트 차단의 정확한 출처다. */
function entryCovers(entry, origin, key) {
  return entry.origin === origin || (entry.source !== 'research-default' && entry.origin === key);
}

/** 이 출처의 사용자 항목이 머무를 곳. 허용은 늘 사이트 키에, 차단은 apex·www 가 아닌 하위 호스트면 그 호스트에 둔다. */
function placement(origin) {
  const scope = siteScope(origin);
  const host = new URL(scope.origin).hostname;
  const exactHost = !!scope.domain && host !== scope.domain && host !== `www.${scope.domain}`;
  return { scope, blockOrigin: exactHost ? scope.origin : scope.key };
}

function failure(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function boundedText(value, limit = 200) { return String(value ?? '').trim().slice(0, limit); }
function actions(values = []) {
  if (!Array.isArray(values) || values.some((value) => !ACTIONS.has(value))) {
    throw failure('BROWSER_INVALID_POLICY', 'The website permission actions are invalid.');
  }
  return [...new Set(values)];
}
function requireHuman(actor) {
  if (!actor?.isHuman) throw failure('BROWSER_OWNER_REQUIRED', 'Browser permissions can only be changed by the owner.');
}
const isSubagent = (actor) => !!actor?.taskId;

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

/**
 * 에이전트가 할 다음 호출. 거절마다 같은 모양으로 실린다. 하위 에이전트는 루트 대화에 알리기만 한다.
 * item 은 끈 로그인({accountId}) 또는 비밀({secretId,label,origins,kind})이다.
 */
export function denialRequest(denial, actor) {
  const item = denial.item ?? null;
  const request = item?.secretId
    ? { tool: 'request_secret', args: { secretId: item.secretId, label: item.label, origins: item.origins, kind: item.kind, reason: `Use the saved secret on ${denial.site}.` } }
    : { tool: 'browser_request_account', args: { kind: 'site', origin: denial.origin,
      ...(denial.blocked?.length ? { blocked: [...denial.blocked] } : {}), ...(item?.accountId ? { accountId: item.accountId } : {}) } };
  return isSubagent(actor) ? { reportToRoot: true, ...request } : request;
}

/** 에이전트에게 보내는 거절 문장. 무엇이 필요한지와 정확히 무엇을 호출할지만 말한다. */
export function denialMessage(denial, actor) {
  const site = denial.site;
  const what = denial.code === 'BROWSER_SITE_BLOCKED'
    ? (denial.item ? `The owner turned off agent use of this saved ${denial.item.secretId ? 'secret' : 'login'} on ${site}.` : `The owner turned off ${denial.blocked.join(', ')} on ${site}.`)
    : denial.reason === 'signed-in' ? `The owner is signed in to ${site}; reading it needs site access.`
      : denial.reason === 'account-use' ? `Using saved logins or secrets on ${site} needs site access.`
        : `Changing things on ${site} needs site access.`;
  if (isSubagent(actor)) return `${what} Report to the root conversation that ${site} needs site access, then continue without it.`;
  const request = denialRequest(denial, actor);
  return `${what} Call ${request.tool} with ${JSON.stringify(request.args)} and end the turn.`;
}

/** 정책 거절을 에이전트·Studio 가 그대로 쓰는 오류로 만든다. */
export function denialError(denial, actor, { performed = false } = {}) {
  return failure(denial.code, denialMessage(denial, actor), {
    reason: denial.reason, site: denial.site, origin: denial.origin, performed,
    request: denialRequest(denial, actor),
    ...(denial.blocked?.length ? { blocked: [...denial.blocked] } : {}),
    ...(denial.item ? { item: denial.item.secretId ? { secretId: denial.item.secretId } : { accountId: denial.item.accountId } } : {}),
  });
}

/** 예전 사이트 항목을 사이트 키로 모은다. 허용은 합치고 차단도 합친다. 하위 호스트 차단은 그 호스트에 남긴다. */
function normalizeSites(sites) {
  const research = sites.filter((site) => site.source === 'research-default');
  const byOrigin = new Map();
  const upsert = (origin, label, allowed, blocked, previous) => {
    const entry = byOrigin.get(origin) ?? { id: previous?.id ?? crypto.randomUUID(), origin, label: boundedText(label ?? origin), source: 'user', allowedActions: [], blockedActions: [], epoch: previous?.epoch ?? 0 };
    entry.allowedActions = [...new Set([...entry.allowedActions, ...allowed])];
    entry.blockedActions = [...new Set([...entry.blockedActions, ...blocked])];
    entry.epoch = Math.max(entry.epoch ?? 0, previous?.epoch ?? 0);
    byOrigin.set(origin, entry);
  };
  for (const site of sites.filter((entry) => entry.source !== 'research-default')) {
    const { scope, blockOrigin } = placement(site.origin);
    const label = site.origin === scope.key || !scope.domain ? site.label : scope.domain;
    if (site.allowedActions.length || !site.blockedActions.length) upsert(scope.key, label, site.allowedActions, blockOrigin === scope.key ? site.blockedActions : [], site);
    if (site.blockedActions.length && blockOrigin !== scope.key) upsert(blockOrigin, site.label, [], site.blockedActions, site);
  }
  return [...research, ...[...byOrigin.values()].filter((entry) => entry.allowedActions.length || entry.blockedActions.length)];
}

function validSite(site) {
  site.origin = browserOrigin(site.origin);
  site.allowedActions = actions(site.allowedActions);
  site.blockedActions = actions(site.blockedActions);
  site.epoch = Number.isSafeInteger(site.epoch) ? site.epoch : 0;
  return site;
}

export function createBrowserPolicy({ dataDir, ownerId = 'local-owner', onChange = () => {}, now = Date.now, signedInLimit = SIGNED_IN_LIMIT } = {}) {
  if (!dataDir) throw new TypeError('Browser policy dataDir is required.');
  const filePath = path.join(dataDir, 'browser-policy.json');
  let state;
  let initialized = false;
  let queue = Promise.resolve();
  let touchPending = false;
  const changeGuards = new Set();
  /** profileId → 쿠키가 있는 사이트 키(메모리). 저장소를 읽을 때마다 새로 맞춘다. */
  const cookieSites = new Map();
  /** profileId → (로그인 표시 키 → 로그인 출처). 저장된 로그인이 있는 사이트(메모리). 활성 런타임의 저장소만 본다. */
  const savedLoginSites = new Map();
  /** threadId\n사이트 키 → { actions, at }. 이 채팅이 최근에 부딪힌 차단. 카드가 에이전트가 빠뜨린 차단도 풀 수 있게 한다. */
  const recentBlocks = new Map();
  const RECENT_BLOCK_MS = 10 * 60 * 1000;

  const readyPromise = (async () => {
    const stored = await readBrowserJson(filePath, POLICY_BYTES);
    if (stored) {
      if (![1, 2].includes(stored.schema) || stored.ownerId !== ownerId || !Array.isArray(stored.sites)) {
        throw failure('BROWSER_POLICY_INVALID', 'Browser policy belongs to a different owner or cannot be read.');
      }
      if (stored.defaults && Object.values(stored.defaults).some((value) => typeof value !== 'boolean')) throw failure('BROWSER_POLICY_INVALID', 'Browser defaults cannot be read.');
      const sites = stored.sites.map(validSite);
      if (stored.schema === 1) {
        // 스키마 1 → 2: 계정 승인은 버리고(로그인 사용은 이제 사이트 사용을 따른다), 허용 항목은 사이트 키로 모은다.
        // 세션 승인 계정을 읽기 허용으로 옮기도록 중개자가 볼 승인 목록만 잠시 남긴다.
        const legacyAccounts = (Array.isArray(stored.accounts) ? stored.accounts : [])
          .filter((account) => account?.approved === true && Array.isArray(account.origins))
          .map((account) => ({ accountId: String(account.accountId ?? ''), profileId: boundedText(account.profileId ?? 'default', 100), origins: account.origins.filter((origin) => webOrigin(origin)) }));
        state = { schema: 2, ownerId, revision: (Number(stored.revision) || 1) + 1, seeded: stored.seeded !== false,
          defaults: stored.defaults ?? { browse: true, download: true, researchImport: true },
          sites: normalizeSites(sites), chatGrants: [], signedIn: [], guestSites: [], ...(legacyAccounts.length ? { legacyAccounts } : {}) };
        await writeBrowserJson(filePath, state, POLICY_BYTES);
      } else {
        state = { ...stored, sites,
          chatGrants: (Array.isArray(stored.chatGrants) ? stored.chatGrants : []).filter((grant) => typeof grant?.threadId === 'string' && grant.threadId && webOrigin(grant.key) === grant.key)
            .map((grant) => ({ threadId: grant.threadId, key: grant.key, actions: actions((grant.actions ?? []).filter((action) => ACTIONS.has(action))), grantedAt: Number(grant.grantedAt) || 0, usedAt: Number(grant.usedAt) || 0, epoch: Number(grant.epoch) || 0 })),
          signedIn: (Array.isArray(stored.signedIn) ? stored.signedIn : []).filter((marker) => typeof marker?.profileId === 'string' && webOrigin(marker.key) === marker.key && SIGNED_IN_SOURCES.has(marker.source))
            .map((marker) => ({ profileId: marker.profileId, key: marker.key, source: marker.source, at: Number(marker.at) || 0 })),
          guestSites: (Array.isArray(stored.guestSites) ? stored.guestSites : []).filter((entry) => typeof entry?.profileId === 'string' && webOrigin(entry.key) === entry.key)
            .map((entry) => ({ profileId: entry.profileId, key: entry.key, at: Number(entry.at) || 0 })) };
        pruneChatGrants();
      }
      initialized = true;
      return;
    }
    state = {
      schema: 2, ownerId, revision: 1, seeded: true,
      defaults: { browse: true, download: true, researchImport: true },
      sites: DEFAULT_RESEARCH_SITES.map((site) => ({ ...site, id: crypto.randomUUID(), source: 'research-default', allowedActions: [...RESEARCH_ACTIONS], blockedActions: [], epoch: 0 })),
      chatGrants: [], signedIn: [], guestSites: [],
    };
    await writeBrowserJson(filePath, state, POLICY_BYTES);
    initialized = true;
  })();

  function pruneChatGrants(next = state) {
    const cutoff = now() - CHAT_GRANT_IDLE_MS;
    next.chatGrants = next.chatGrants.filter((grant) => grant.usedAt >= cutoff);
    if (next.chatGrants.length > CHAT_GRANT_LIMIT) next.chatGrants = [...next.chatGrants].sort((a, b) => b.usedAt - a.usedAt).slice(0, CHAT_GRANT_LIMIT);
  }
  const SKIP = Symbol('skip');
  function changed() { try { onChange({ type: 'browser-policy-changed', revision: state.revision }); } catch {} }
  /** 상태를 바꾸는 모든 일은 한 줄로 선다. narrows 면 바꾸기 전에 진행 중인 자격 증명 사용을 멈춘다. */
  function mutate(operation, { narrows = null, bump = true } = {}) {
    const run = async () => {
      await readyPromise;
      const next = clone(state);
      const result = await operation(next);
      if (result === SKIP) return undefined;
      if (bump) next.revision += 1;
      if (narrows) for (const guard of changeGuards) await guard(typeof narrows === 'function' ? narrows(next) : narrows);
      await writeBrowserJson(filePath, next, POLICY_BYTES);
      state = next;
      if (bump) changed();
      return result;
    };
    const task = queue.then(run, run);
    queue = task.catch(() => {});
    return task;
  }

  function effectiveResearch() {
    // 기본 연구 권한은 설정에서 끌 수 없다. 예전에 끈 기록이 남아 있어도 항상 켠다.
    return { browse: initialized, downloads: initialized, import: initialized };
  }
  function categoryAvailability() { return effectiveResearch(); }

  const coveringEntries = (origin) => {
    const key = siteScope(origin).key;
    return state.sites.filter((entry) => entryCovers(entry, origin, key));
  };
  function blocksFor(origin, action) {
    return coveringEntries(origin).filter((entry) => entry.blockedActions.includes(action)).map((entry) => entry.origin);
  }
  /** 이 출처에 걸린 차단 동작 전체(도메인 항목과 정확한 호스트 항목). */
  function blockedActionsFor(origin) {
    return [...new Set(coveringEntries(origin).flatMap((entry) => entry.blockedActions))];
  }
  function chatGrant(threadId, key, action) {
    if (!threadId) return null;
    const grant = state.chatGrants.find((entry) => entry.threadId === threadId && entry.key === key && entry.actions.includes(action));
    if (grant && now() - grant.usedAt > CHAT_GRANT_TOUCH_MS) {
      grant.usedAt = now();
      if (!touchPending) {
        touchPending = true;
        // 사용 시각은 하루에 한 번만 저장한다. 결정에는 영향이 없다.
        void mutate((next) => { const stored = next.chatGrants.find((entry) => entry.threadId === threadId && entry.key === key); if (!stored) return SKIP; stored.usedAt = grant.usedAt; }, { bump: false }).catch(() => {}).finally(() => { touchPending = false; });
      }
    }
    return grant ? { source: 'chat', epoch: `chat:${grant.epoch}` } : null;
  }
  function userEntry(origin, action) {
    const key = siteScope(origin).key;
    const entry = state.sites.find((site) => site.source !== 'research-default' && (site.origin === key || site.origin === origin) && site.allowedActions.includes(action));
    return entry ? { source: 'user', epoch: `site:${entry.epoch}` } : null;
  }
  function researchDefault(origin, action) {
    if (!RESEARCH_ACTIONS.includes(action)) return null;
    const entry = state.sites.find((site) => site.source === 'research-default' && site.origin === origin && site.allowedActions.includes(action));
    return entry ? { source: 'research-default', epoch: `research:${entry.epoch}` } : null;
  }
  /**
   * 로그인한 사이트: 쿠키가 있고, 사용자 신원의 증거(로그인 표시)가 있거나 저장된 로그인이 있다.
   * 저장된 로그인은 그 쿠키가 손님 쿠키(에이전트 방문으로만 생겼거나 사용자가 표시를 지운 쿠키)면 증거가 아니다.
   */
  function isSignedInSync(profileId, key) {
    if (!profileId || !cookieSites.get(profileId)?.has(key)) return false;
    if (state.signedIn.some((marker) => marker.profileId === profileId && marker.key === key)) return true;
    return savedLoginSites.get(profileId)?.has(key) === true && !state.guestSites.some((entry) => entry.profileId === profileId && entry.key === key);
  }

  /**
   * 결정 함수. 사람은 언제나 허용한다. 차단이 모든 승인을 이기고, 이 채팅 승인·항상 승인·연구 기본값 순으로 본다.
   * 승인이 없으면 사이트 변경과 계정 사용은 거절하고, 로그인한 사이트의 에이전트 읽기도 거절한다. 나머지는 공개 열람이다.
   * item: 끈 로그인·비밀이면 { accountId } / { secretId, label, origins, kind } 와 blocked:true.
   */
  async function check({ actor, action, url, profileId, resource = 'document', shared = false, item = null } = {}) {
    await readyPromise;
    if (!ACTIONS.has(action)) return { allowed: false, code: 'BROWSER_ACTION_UNKNOWN', reason: 'unknown', revision: state.revision };
    if (actor?.isHuman) return { allowed: true, origin: webOrigin(url), source: 'owner', revision: state.revision };
    const origin = webOrigin(url);
    if (!origin) return { allowed: true, origin: null, source: 'no-origin', revision: state.revision };
    const scope = siteScope(origin);
    const site = scope.domain ?? new URL(scope.key).host;
    const base = { origin, key: scope.key, site, revision: state.revision };
    const blocked = blocksFor(origin, action).length ? [action] : [];
    if (blocked.length || item?.blocked === true) {
      if (blocked.length && actor?.threadId) {
        const recentKey = `${actor.threadId}\n${scope.key}`;
        const previous = recentBlocks.get(recentKey);
        recentBlocks.set(recentKey, { actions: new Set([...(previous?.actions ?? []), ...blocked]), at: now() });
        if (recentBlocks.size > 512) recentBlocks.delete(recentBlocks.keys().next().value);
      }
      return { ...base, allowed: false, code: 'BROWSER_SITE_BLOCKED', reason: 'blocked', blocked, item: item?.blocked ? item : null };
    }
    if (resource === 'subresource' && action === 'browse') return { ...base, allowed: true, source: 'subresource' };
    // 허브의 웹 비서 연결(ask_chatgpt·ask_claude)은 설정에서 켜고 채팅마다 허용한 뒤에만 돈다. 그 행위자에게는 자기 사이트만 연다.
    if (Object.hasOwn(SYSTEM_ACTOR_SITE_KEYS, actor?.system ?? '') && SYSTEM_ACTOR_SITE_KEYS[actor.system].includes(scope.key)) return { ...base, allowed: true, source: actor.system };
    const grant = chatGrant(actor?.threadId, scope.key, action) ?? userEntry(origin, action) ?? researchDefault(origin, action);
    if (grant) return { ...base, allowed: true, source: grant.source, grantEpoch: grant.epoch };
    if (action === 'website-change' || action === 'account-use') return { ...base, allowed: false, code: 'BROWSER_PERMISSION_REQUIRED', reason: action, item };
    if ((action === 'browse' || action === 'read') && !shared && scope.domain && isSignedInSync(profileId, `https://${scope.domain}`)) {
      return { ...base, allowed: false, code: 'BROWSER_PERMISSION_REQUIRED', reason: 'signed-in' };
    }
    return { ...base, allowed: true, source: 'public' };
  }

  async function assertAllowed(input) {
    const result = await check(input);
    if (!result.allowed) {
      if (result.code === 'BROWSER_ACTION_UNKNOWN') throw failure(result.code, 'The browser action is unknown.');
      throw denialError(result, input.actor);
    }
    return result;
  }

  /** 이 채팅이 이 사이트에서 사이트 사용 전부를 이미 가졌는가. 차단이 하나라도 있으면 아니다. */
  async function hasSiteAccess(actor, origin) {
    for (const action of SITE_ACCESS_ACTIONS) if (!(await check({ actor, action, url: origin })).allowed) return false;
    return true;
  }

  async function list() {
    await readyPromise;
    const result = clone(state);
    delete result.legacyAccounts;
    // 도메인 전체를 덮는 항목에는 그 등록 도메인을 붙여 설정 화면이 그대로 보여 줄 수 있게 한다.
    for (const site of result.sites) {
      const scope = siteScope(site.origin);
      if (site.source !== 'research-default' && site.origin === scope.key && scope.domain) site.domain = scope.domain;
    }
    return result;
  }

  /** 설정의 사이트 목록. 사이트마다 항상·이 채팅·로그인됨·차단을 한 줄로 준다. origins 를 주면 그 사이트만. */
  async function siteStatus(actor, { profileId, origins } = {}) {
    await readyPromise;
    const keys = new Map();
    const add = (value) => { try { const scope = siteScope(value); if (!keys.has(scope.key)) keys.set(scope.key, scope); } catch {} };
    if (origins) for (const origin of origins) add(origin);
    else {
      for (const site of state.sites) if (site.source !== 'research-default') add(site.origin);
      for (const grant of state.chatGrants) if (!actor?.threadId || grant.threadId === actor.threadId) add(grant.key);
      for (const marker of state.signedIn) if ((!profileId || marker.profileId === profileId) && cookieSites.get(marker.profileId)?.has(marker.key) !== false) add(marker.key);
      // 저장된 로그인과 사용자 쿠키로 로그인한 사이트도 한 줄을 받는다. 키는 로그인 출처의 사이트 키다.
      for (const [profile, logins] of savedLoginSites) if (!profileId || profile === profileId) {
        for (const [key, origin] of logins) if (isSignedInSync(profile, key)) add(origin);
      }
    }
    return [...keys.values()].map((scope) => {
      const entries = state.sites.filter((entry) => entry.source !== 'research-default' && (entry.origin === scope.key || siteScope(entry.origin).key === scope.key));
      const keyEntry = entries.find((entry) => entry.origin === scope.key);
      const blocked = entries.filter((entry) => entry.blockedActions.length).map((entry) => ({ origin: entry.origin, actions: [...entry.blockedActions] }));
      return {
        key: scope.key, site: scope.domain ?? new URL(scope.key).host, domain: scope.domain, label: keyEntry?.label ?? scope.domain ?? new URL(scope.key).host,
        always: SITE_ACCESS_ACTIONS.every((action) => keyEntry?.allowedActions.includes(action)),
        allowedActions: [...(keyEntry?.allowedActions ?? [])],
        chat: !!actor?.threadId && state.chatGrants.some((grant) => grant.threadId === actor.threadId && grant.key === scope.key),
        signedIn: !!scope.domain && (profileId ? isSignedInSync(profileId, `https://${scope.domain}`) : state.signedIn.some((marker) => marker.key === `https://${scope.domain}`)),
        blocked,
      };
    });
  }

  async function update(input = {}) {
    requireHuman(input.actor);
    if (input.operation === 'set-default') {
      if (!['browse', 'download', 'researchImport'].includes(input.key) || typeof input.enabled !== 'boolean') throw failure('BROWSER_INVALID_POLICY', 'The research default is invalid.');
      await mutate((next) => { next.defaults[input.key] = input.enabled; });
      return list();
    }
    if (input.operation === 'set-site') {
      const origin = browserOrigin(input.origin);
      const allowedActions = input.allowedActions === undefined ? undefined : actions(input.allowedActions);
      const blockedActions = input.blockedActions === undefined ? undefined : actions(input.blockedActions);
      await mutate((next) => {
        const { scope, blockOrigin } = placement(origin);
        const find = (value) => next.sites.find((site) => site.source !== 'research-default' && site.origin === value);
        const ensure = (value, label) => {
          let entry = find(value);
          if (!entry) { entry = { id: crypto.randomUUID(), origin: value, label: boundedText(label ?? (value === scope.key ? scope.domain : null) ?? value), source: 'user', allowedActions: [], blockedActions: [], epoch: 0 }; next.sites.push(entry); }
          return entry;
        };
        // 허용은 사이트 키 항목에 둔다. 하위 호스트에서 준 허용은 그 사이트 전체에 더한다.
        const assign = (entry, field, values) => {
          if (values.length === entry[field].length && values.every((value) => entry[field].includes(value))) return;
          entry[field] = values; entry.epoch = next.revision + 1;
        };
        if (allowedActions !== undefined) {
          const entry = ensure(scope.key, input.label);
          assign(entry, 'allowedActions', origin === scope.key || blockOrigin === scope.key ? allowedActions : [...new Set([...entry.allowedActions, ...allowedActions])]);
        }
        if (blockedActions !== undefined) assign(ensure(blockOrigin, input.label), 'blockedActions', blockedActions);
        if (input.label !== undefined) { const entry = find(scope.key) ?? find(blockOrigin); if (entry) entry.label = boundedText(input.label); }
        next.sites = next.sites.filter((site) => site.source === 'research-default' || site.allowedActions.length || site.blockedActions.length);
      }, { narrows: { operation: 'set-site', origin } });
      return list();
    }
    if (input.operation === 'remove-site') {
      const origin = browserOrigin(input.origin);
      await mutate((next) => { next.sites = next.sites.filter((site) => site.origin !== origin); }, { narrows: { operation: 'remove-site', origin } });
      return list();
    }
    throw failure('BROWSER_INVALID_POLICY', 'The browser policy operation is unknown.');
  }

  /**
   * 사이트 사용 승인. chat 은 그 채팅에만(저장되고 채팅을 지울 때까지 남는다), always 는 모든 채팅에.
   * 차단은 unblock 으로 넘긴 동작만, 이 출처에 걸린 항목(도메인 항목·정확한 호스트 항목)에서 푼다.
   */
  async function grantSiteAccess({ actor, threadId, origin, scope = 'chat', unblock = [], label } = {}) {
    requireHuman(actor);
    if (!['chat', 'always'].includes(scope)) throw failure('BROWSER_INVALID_POLICY', 'Choose chat or always for this site approval.');
    const lifted = actions(unblock);
    if (lifted.length && scope !== 'always') throw failure('BROWSER_INVALID_POLICY', 'Turning a blocked action back on is saved for every chat.');
    if (scope === 'chat' && !threadId) throw failure('BROWSER_INVALID_POLICY', 'A chat site approval needs its chat.');
    const site = siteScope(origin);
    await mutate((next) => {
      const epoch = next.revision + 1;
      for (const entry of next.sites) {
        if (!lifted.length || entry.source === 'research-default' || !entryCovers(entry, site.origin, site.key)) continue;
        entry.blockedActions = entry.blockedActions.filter((action) => !lifted.includes(action));
        entry.epoch = epoch;
      }
      if (scope === 'chat') {
        const previous = next.chatGrants.find((grant) => grant.threadId === threadId && grant.key === site.key);
        const grant = { threadId, key: site.key, actions: [...SITE_ACCESS_ACTIONS], grantedAt: now(), usedAt: now(), epoch: previous?.epoch ?? epoch };
        next.chatGrants = next.chatGrants.filter((entry) => entry !== previous).concat(grant);
        pruneChatGrants(next);
      } else {
        let entry = next.sites.find((value) => value.source !== 'research-default' && value.origin === site.key);
        if (!entry) { entry = { id: crypto.randomUUID(), origin: site.key, label: boundedText(label ?? site.domain ?? new URL(site.key).hostname), source: 'user', allowedActions: [], blockedActions: [], epoch }; next.sites.push(entry); }
        if (!SITE_ACCESS_ACTIONS.every((action) => entry.allowedActions.includes(action))) entry.epoch = epoch;
        entry.allowedActions = [...new Set([...entry.allowedActions, ...SITE_ACCESS_ACTIONS])];
      }
      next.sites = next.sites.filter((value) => value.source === 'research-default' || value.allowedActions.length || value.blockedActions.length);
    });
    return { origins: [site.key], domain: site.domain, site: site.domain ?? new URL(site.key).host, scope };
  }

  /** 설정의 "해제": 이 사이트의 항상 승인과 모든 채팅 승인을 거둔다(scope 를 주면 그쪽만). 차단은 그대로 둔다. */
  async function revokeSiteAccess({ actor, origin, scope } = {}) {
    requireHuman(actor);
    const site = siteScope(origin);
    await mutate((next) => {
      if (scope !== 'chat') {
        for (const entry of next.sites) if (entry.source !== 'research-default' && entry.origin === site.key) {
          entry.allowedActions = entry.allowedActions.filter((action) => !SITE_ACCESS_ACTIONS.includes(action)); entry.epoch = next.revision + 1;
        }
        next.sites = next.sites.filter((value) => value.source === 'research-default' || value.allowedActions.length || value.blockedActions.length);
      }
      if (scope !== 'always') next.chatGrants = next.chatGrants.filter((grant) => grant.key !== site.key || (scope === 'chat' && actor.threadId && grant.threadId !== actor.threadId));
    }, { narrows: { operation: 'revoke-site', origin: site.key } });
    return list();
  }

  /** 채팅을 지웠다. 그 채팅의 사이트 승인을 버린다. */
  async function endThread(threadId) {
    if (!threadId) return;
    await mutate((next) => {
      const before = next.chatGrants.length;
      next.chatGrants = next.chatGrants.filter((grant) => grant.threadId !== threadId);
      if (next.chatGrants.length === before) return SKIP;
    }, { narrows: { operation: 'end-thread', threadId } });
  }

  function markerKey({ origin, domain }) {
    return signedInKey(origin ?? `https://${String(domain ?? '').replace(/^\./, '')}`);
  }
  /** 로그인 표시는 프로필마다 4096 개까지. 넘치면 쿠키가 없는 표시부터, 그다음 오래된 표시부터 버린다. */
  function capMarkers(next, profileId) {
    const mine = next.signedIn.filter((marker) => marker.profileId === profileId);
    if (mine.length <= signedInLimit) return;
    const live = cookieSites.get(profileId);
    const order = [...mine].sort((a, b) => (Number(live?.has(a.key) ?? false) - Number(live?.has(b.key) ?? false)) || a.at - b.at);
    const drop = new Set(order.slice(0, mine.length - signedInLimit));
    next.signedIn = next.signedIn.filter((marker) => !drop.has(marker));
  }
  /** 사용자가 이 사이트에 신원이 있다는 증거를 남긴다(HTTPS 등록 도메인만). domains 로 여러 개를 한 번에 쓴다. 실패해도 던지지 않는다. */
  async function markSignedIn({ profileId = 'default', origin, domain, domains, source } = {}) {
    if (!SIGNED_IN_SOURCES.has(source)) return false;
    const keys = [...new Set((domains ?? [origin === undefined ? domain : undefined]).map((value) => markerKey(origin !== undefined && !domains ? { origin } : { domain: value })).filter(Boolean))];
    if (!keys.length) return false;
    try {
      await mutate((next) => {
        let changedAny = false;
        for (const key of keys) {
          const previous = next.signedIn.find((marker) => marker.profileId === profileId && marker.key === key);
          if (previous) { previous.at = now(); if (previous.source !== source) { previous.source = source; changedAny = true; } continue; }
          next.signedIn.push({ profileId, key, source, at: now() });
          changedAny = true;
        }
        if (!changedAny) return SKIP;
        capMarkers(next, profileId);
      });
      return true;
    } catch { return false; }
  }
  /** 손님 쿠키 목록도 프로필마다 4096 개까지. 넘치면 오래된 것부터 버린다. */
  function capGuests(next, profileId) {
    const mine = next.guestSites.filter((entry) => entry.profileId === profileId);
    if (mine.length <= signedInLimit) return;
    const drop = new Set([...mine].sort((a, b) => a.at - b.at).slice(0, mine.length - signedInLimit));
    next.guestSites = next.guestSites.filter((entry) => !drop.has(entry));
  }
  /**
   * 로그인 표시를 지운다. profileId 를 빼면 모든 프로필에서. 지금 남은 쿠키는 손님 쿠키로 보아
   * 저장된 로그인만으로는 다시 로그인한 사이트가 되지 않는다(설정의 "로그인 표시 지우기").
   */
  async function clearSignedIn({ profileId, origin, site } = {}) {
    const key = markerKey({ origin: origin ?? (site ? `https://${String(site).replace(/^https?:\/\//, '')}` : undefined) });
    if (!key) return false;
    await readyPromise;
    const profiles = [...cookieSites].filter(([profile, live]) => (!profileId || profile === profileId) && live.has(key) && savedLoginSites.get(profile)?.has(key)).map(([profile]) => profile);
    await mutate((next) => {
      const before = next.signedIn.length;
      next.signedIn = next.signedIn.filter((marker) => marker.key !== key || (profileId && marker.profileId !== profileId));
      const guests = profiles.filter((profile) => !next.guestSites.some((entry) => entry.profileId === profile && entry.key === key));
      for (const profile of guests) { next.guestSites.push({ profileId: profile, key, at: now() }); capGuests(next, profile); }
      if (next.signedIn.length === before && !guests.length) return SKIP;
    });
    return true;
  }
  /** 브라우저 데이터 초기화: 로그인 표시와 손님 쿠키 기록을 모두 지운다. 사이트와 차단은 남는다. */
  async function clearAllSignedIn() {
    await mutate((next) => { if (!next.signedIn.length && !next.guestSites.length) return SKIP; next.signedIn = []; next.guestSites = []; });
  }
  /**
   * 저장소를 읽은 결과. 쿠키가 사라진 사이트의 로그인 표시와 손님 쿠키 기록은 함께 사라진다.
   * guest: 이번에 처음 생긴 쿠키 중 에이전트 방문으로만 생긴 사이트. 저장된 로그인이 있는 사이트만 기록한다.
   * owned: 저장된 로그인을 막 입력한 사이트. 그 쿠키는 더는 손님 쿠키가 아니다.
   */
  async function setCookieSites(profileId, keys, { guest = [], owned = [] } = {}) {
    const live = new Set(keys);
    // 새 쿠키와 손님 쿠키 기록은 함께 보여야 한다. 상태를 바꾸는 줄에 서서, 바뀐 상태가 저장된 뒤에 쿠키 목록을 바꾼다.
    await mutate((next) => {
      const added = [...new Set(guest)].filter((key) => live.has(key) && savedLoginSites.get(profileId)?.has(key) && !owned.includes(key)
        && !next.guestSites.some((entry) => entry.profileId === profileId && entry.key === key));
      const stale = next.signedIn.some((marker) => marker.profileId === profileId && !live.has(marker.key))
        || next.guestSites.some((entry) => entry.profileId === profileId && (!live.has(entry.key) || owned.includes(entry.key)));
      if (!stale && !added.length) return SKIP;
      next.signedIn = next.signedIn.filter((marker) => marker.profileId !== profileId || live.has(marker.key));
      next.guestSites = next.guestSites.filter((entry) => entry.profileId !== profileId || (live.has(entry.key) && !owned.includes(entry.key)))
        .concat(added.map((key) => ({ profileId, key, at: now() })));
      capGuests(next, profileId);
    }).catch(() => {});
    cookieSites.set(profileId, live);
  }
  /** 저장된 로그인의 출처. 사이트마다 처음 본 출처를 설정 목록의 키로 쓴다. */
  function setSavedLoginSites(profileId, origins) {
    const logins = new Map();
    for (const origin of origins) { const key = signedInKey(origin); if (key && !logins.has(key)) logins.set(key, origin); }
    savedLoginSites.set(profileId, logins);
  }
  async function isSignedIn(profileId, origin) { await readyPromise; const key = markerKey({ origin }); return !!key && isSignedInSync(profileId, key); }

  /** 스키마 1 에서 승인돼 있던 세션 계정. 중개자가 읽기 허용으로 옮긴 뒤 dropLegacyAccounts 로 지운다. */
  async function legacyAccounts() { await readyPromise; return clone(state.legacyAccounts ?? []); }
  async function dropLegacyAccounts() { await mutate((next) => { if (!next.legacyAccounts) return SKIP; delete next.legacyAccounts; }, { bump: false }); }
  /** 마이그레이션이 옮긴 읽기 허용. 이미 있는 허용·차단은 건드리지 않는다. */
  async function migrateAllow(origin, allowed) {
    const site = siteScope(origin);
    await mutate((next) => {
      let entry = next.sites.find((value) => value.source !== 'research-default' && value.origin === site.key);
      if (!entry) { entry = { id: crypto.randomUUID(), origin: site.key, label: site.domain ?? new URL(site.key).hostname, source: 'user', allowedActions: [], blockedActions: [], epoch: next.revision + 1 }; next.sites.push(entry); }
      const merged = [...new Set([...entry.allowedActions, ...actions(allowed)])];
      if (merged.length === entry.allowedActions.length) return SKIP;
      entry.allowedActions = merged;
    });
  }

  /** 이 채팅이 10분 안에 이 사이트에서 부딪힌 차단 동작. */
  function recentBlockedActions(actor, origin) {
    try {
      const entry = recentBlocks.get(`${actor?.threadId ?? ''}\n${siteScope(origin).key}`);
      return entry && now() - entry.at < RECENT_BLOCK_MS ? [...entry.actions] : [];
    } catch { return []; }
  }

  return {
    ready: () => readyPromise, list, update, check, assertAllowed, hasSiteAccess, recentBlockedActions, blockedActionsFor: async (origin) => { await readyPromise; return blockedActionsFor(origin); },
    effectiveResearch, categoryAvailability, siteStatus,
    grantSiteAccess, revokeSiteAccess, endThread,
    markSignedIn, clearSignedIn, clearAllSignedIn, setCookieSites, setSavedLoginSites, isSignedIn,
    legacyAccounts, dropLegacyAccounts, migrateAllow,
    addChangeGuard: (guard) => { changeGuards.add(guard); return () => changeGuards.delete(guard); },
  };
}
