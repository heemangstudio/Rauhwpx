import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { parse as parseDomainName } from 'tldts';
import { denialError, sameSite, signedInKey, siteScope, webOrigin } from './browser-policy.mjs';
import { createBrowserNetworkGuard } from './owned-browser-network.mjs';
import { OwnedBrowserError, inspectOwnedBrowserRuntime, inspectMacPasskeyCapability, installOwnedBrowserRuntime, startOwnedBrowserRuntime, startOwnedBrowserSignIn } from './owned-browser-runtime.mjs';
import { removeOwnedBrowserState } from './browser-cleanup.mjs';
import { createFaviconCache, faviconCandidates, faviconOrigin } from './owned-browser-favicons.mjs';
import { createBrowserHistory, HISTORY_LIST_LIMIT } from './browser-history.mjs';
import { OUTLINE_HINT, outlineFromAria, renderOutline } from './owned-browser-outline.mjs';
import { citationRecord, citationURL, compactText, findMatches, maskSameLength, pageCitationMetadata, pageReadableText, squash } from './owned-browser-reading.mjs';

export { OwnedBrowserError } from './owned-browser-runtime.mjs';

// aria 관찰에서 이름 없는 generic으로 보이는 편집 영역. 이 요소들의 ref는 textbox로 개요에 남긴다.
const EDITABLE = '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';
const SENSITIVE = 'input[type="password"],input[type="email"],input[autocomplete="username"],input[name="username"],input[name="email"],input[autocomplete="current-password"],input[autocomplete="new-password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"],[data-rhwp-private-field]';
const redactValues = (value, secrets) => {
  if (typeof value === 'string') { for (const secret of secrets ?? []) if (secret) for (const variant of [secret, encodeURIComponent(secret), new URLSearchParams({ v: secret }).toString().slice(2), Buffer.from(secret).toString('base64')]) value = value.split(variant).join('[masked]'); return value; }
  if (Array.isArray(value)) return value.map(entry => redactValues(entry, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValues(entry, secrets)]));
  return value;
};
const MUTATIONS = new Set(['navigate', 'click', 'type', 'press', 'select', 'scroll', 'close', 'input', 'fill-account', 'fill-secret', 'viewport', 'upload', 'fill-form', 'hover', 'drag', 'dialog']);
// 허브가 입력 직전에 비밀 값을 꺼내는 함수. 인자 객체의 기호 키라 직렬화·로그에 실리지 않는다.
const SECRET_FILL = Symbol('rhwp.secretFill');
// 허브가 browser_upload 출처를 확인해 읽은 파일. 기호 키라 모델 인자로는 넣을 수 없다.
const UPLOAD_FILES = Symbol('rhwp.uploadFiles');
// 비밀을 입력할 수 있는 칸: 한 줄 글자 입력과 textarea 만.
const SECRET_INPUT_TYPES = new Set(['text', 'password', 'email', 'tel', 'url']);
// 이 조작들은 결과가 자리 잡을 때까지 기다린 뒤 짧은 변화만 돌려준다.
const SETTLING = new Set(['click', 'type', 'press', 'select']);
const READS = new Set(['snapshot', 'frame', 'capture', 'wait', 'cite']);
// 이 조작 동안 페이지가 보내는 같은 사이트 non-GET 은 에이전트의 사이트 변경이다(입력 창).
const INPUT_WINDOW = new Set(['click', 'press', 'select', 'upload', 'fill-account', 'fill-secret', 'drag', 'dialog']);
const nonGet = (method) => !['GET', 'HEAD', 'OPTIONS'].includes(method);
// GraphQL 읽기: JSON 본문의 query 가 mutation 으로 시작하지 않는다.
const graphQLRead = (request) => {
  try {
    const body = JSON.parse(request.postData() ?? '');
    const queries = Array.isArray(body) ? body : [body];
    return queries.length > 0 && queries.every((entry) => typeof entry?.query === 'string' && !/^\s*mutation\b/.test(entry.query));
  } catch { return false; }
};
const chainHead = (request) => { let head = request; for (let hop = 0; hop < 32; hop++) { const previous = head.redirectedFrom?.(); if (!previous) break; head = previous; } return head; };
// 쿠키 도메인 → 로그인 표시 키(https://등록도메인, 포트 없음).
const cookieSiteKey = (domain) => signedInKey(`https://${String(domain).replace(/^\./, '').toLowerCase()}`);
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const error = (code, message, retryable = false) => new OwnedBrowserError(code, message, retryable);
const bounded = (value, min, max, fallback) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
const text = (value, max = 4000) => String(value ?? '').slice(0, max);
const publicURL = (value) => { try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) return 'about:blank'; return `${url.origin}${url.pathname}`; } catch { return 'about:blank'; } };
// Match Google's challenge endpoint, never a lookalike host or an embedded continue URL.
const googleHost = (host) => ['google.com', 'google.co.kr', 'google.co.uk'].some((domain) => host === domain || host === `www.${domain}`);
const googleResearchURL = (value) => { try { const url = new URL(value); return googleHost(url.hostname) && ['/search', '/sorry', '/sorry/index'].includes(url.pathname); } catch { return false; } };
const challengeFor = (tab) => {
  if (!tab.page || tab.page.isClosed() || ['crashed', 'disconnected', 'closed'].includes(tab.status)) return null;
  try {
    const url = new URL(tab.page?.url?.() ?? tab.url);
    if (!googleHost(url.hostname) || !/^\/sorry(?:\/|$)/.test(url.pathname)) return null;
    const query = tab.searchQuery;
    return { code: 'BROWSER_CHALLENGE_REQUIRED', provider: 'google', retryable: false,
      message: 'Google requires a human traffic check. Search results are unavailable. Do not retry or open another Google tab. The user can take control of this tab to complete the check, or navigate this same tab to the explicit search fallback.',
      ...(query ? { fallback: { provider: 'duckduckgo', url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}` } } : {}) };
  } catch { return null; }
};
const sameScope = (actor, tab) => tab.scope !== 'global' && actor.threadId === tab.threadId && actor.agentId === tab.agentId && (actor.projectId ?? null) === tab.projectId;
// 하위 에이전트는 자기 탭만 쓴다. 사용자 탭은 루트 대화와 사용자만 조작해 서로의 화면과 입력을 빼앗지 않는다.
/** 허브가 직접 움직이는 브라우저 행위자(ask_chatgpt·ask_claude). 그 탭은 사용자 화면에 나오지 않는다. */
const SYSTEM_ACTORS = new Set(['chatgpt', 'claude']);
const canAccessTab = (actor, tab) => tab.scope === 'global' ? !actor.taskId : sameScope(actor, tab);
const PARAMETER_RULES = { verbs: ['delete', 'remove', 'destroy', 'send', 'publish', 'purchase', 'checkout', 'share', 'save', 'edit', 'upload', 'invite', 'logout'], operations: ['action', 'command', 'operation', 'method'], negative: ['0', 'false', 'no', 'none', 'off'] };
const mutatingParameter = (name, value) => { const key = name.toLowerCase(), setting = String(value).trim().toLowerCase(); return PARAMETER_RULES.verbs.includes(key) && !PARAMETER_RULES.negative.includes(setting) || PARAMETER_RULES.operations.includes(key) && PARAMETER_RULES.verbs.includes(setting); };
// Playwright 실패는 첫 줄 사유와 복구 안내만 남긴다. URL·따옴표 안 값·페이지 예외 문구는 넣지 않는다.
const reasonLine = (message) => {
  const line = String(message ?? '').split('\n')[0].replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, '[url]').replace(/(["'])(?:(?!\1).){0,400}\1/g, '"…"').trim();
  const method = line.match(/^([a-zA-Z]+\.[$a-zA-Z]+):/)?.[1];
  if (!method) return '';
  return (/evaluate|\$eval/i.test(method) ? `${method} failed` : line).slice(0, 160).replace(/\.?$/, '.');
};
const elementLabel = (html) => {
  const tag = html.match(/^<([a-z][a-z0-9-]*)/i)?.[1]?.toLowerCase() ?? 'element';
  const elementId = html.match(/\sid="([\w-]{1,40})"/)?.[1];
  const classes = (html.match(/\sclass="([^"]{1,120})"/)?.[1] ?? '').split(/\s+/).filter(name => /^[\w-]{1,40}$/.test(name)).slice(0, 2);
  return `${tag}${elementId ? `#${elementId}` : ''}${classes.map(name => `.${name}`).join('')}`;
};
const browserActionFailure = (failure) => {
  const message = String(failure?.message ?? failure ?? '');
  const cover = message.match(/^\s*-\s*(<[^\n]*?>)[^\n]*intercepts pointer events/m);
  if (cover) return error('BROWSER_TARGET_COVERED', `Another element (${elementLabel(cover[1])}) covers the target. Dismiss it or scroll, then take a new snapshot.`, true);
  if (/strict mode violation/i.test(message)) return error('BROWSER_TARGET_AMBIGUOUS', 'The target matches several elements. Take a new snapshot and choose one ref.', true);
  if (/not attached to the DOM|Node is detached|No node with given id|JSHandle is disposed|Execution context was destroyed|Cannot find context with specified id|frame (?:was|got) detached|Target (?:page, context or browser )?(?:has been |was )?closed/i.test(message)) return error('BROWSER_TARGET_DETACHED', 'The target element is gone. Take a new snapshot before retrying.', true);
  if (/not an <input>, <textarea>|not editable|Cannot type text into input/i.test(message)) return error('BROWSER_NOT_EDITABLE', 'The target is not an editable field. Choose a text field from a new snapshot.');
  if (/not a <select> element/i.test(message)) return error('BROWSER_NOT_SELECTABLE', 'The target is not a native list box. Click custom menus instead.');
  const reason = reasonLine(message);
  if (failure?.name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(message)) return error('BROWSER_ACTION_TIMEOUT', `${reason || 'The browser action timed out.'} Take a new snapshot before retrying.`, true);
  return error('BROWSER_ACTION_FAILED', `${reason || 'The browser action did not complete.'} Observe the current page before retrying.`, true);
};
const abortable = (promise, signal) => !signal ? promise : new Promise((resolve, reject) => {
  if (signal.aborted) { promise.catch(() => {}); reject(signal.reason); return; }
  const stop = () => reject(signal.reason);
  signal.addEventListener('abort', stop, { once: true });
  promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
});
const pause = (ms, signal) => new Promise((resolve) => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
});
const changesWebsiteURL = (value) => {
  try { const url = new URL(value); return /\/(delete|remove|destroy|send|purchase|checkout|logout)(\/|$)/i.test(url.pathname) || [...url.searchParams].some(([name, setting]) => mutatingParameter(name, setting)); }
  catch { return false; }
};

/** The native endpoint and IPC correlation IDs never enter browser tools or UI events. */
export function createIpcNativeBrowserAdapter({ send = process.send?.bind(process), events = process, timeoutMs = 20_000 } = {}) {
  const pending = new Map();
  const listeners = new Set();
  let nativeGeneration;
  const receive = (message) => {
    if (message?.type === 'rhwp-browser-event') {
      const event = message.event;
      if (nativeGeneration && event?.generation === nativeGeneration && typeof event.tabId === 'string' && typeof event.targetId === 'string'
        && (event.reason === 'zoom' && Number.isFinite(event.zoomFactor) && event.zoomFactor >= 0.25 && event.zoomFactor <= 3.000001
          || event.reason === 'favicon' && typeof event.pageUrl === 'string' && Array.isArray(event.favicons)
          || event.reason === 'human-input')) {
        for (const listener of listeners) listener(event);
      }
      return;
    }
    if (message?.type !== 'rhwp-browser-response') return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id); clearTimeout(waiter.timer);
    message.ok ? waiter.resolve(message.value) : waiter.reject(error(message.error?.code ?? 'BROWSER_NATIVE_FAILED', message.error?.message ?? 'The desktop browser request failed.', message.error?.retryable === true));
  };
  events.on('message', receive);
  const call = (operation, params = {}, waitMs = timeoutMs) => new Promise((resolve, reject) => {
    if (!send) { reject(error('BROWSER_NATIVE_UNAVAILABLE', 'The desktop browser is not connected.', true)); return; }
    const requestId = id('native');
    const timer = setTimeout(() => { pending.delete(requestId); reject(error('BROWSER_NATIVE_TIMEOUT', 'The desktop browser did not respond. Reconnect before retrying.', true)); }, waitMs);
    pending.set(requestId, { resolve, reject, timer });
    try { send({ type: 'rhwp-browser-request', id: requestId, operation, params }); }
    catch { clearTimeout(timer); pending.delete(requestId); reject(error('BROWSER_NATIVE_UNAVAILABLE', 'The desktop browser disconnected.', true)); }
  });
  return {
    async start(params) { const result = await call('start', params); nativeGeneration = result.generation; return { ...result, close: () => call('release') }; },
    importSession: (params) => call('import-session', params),
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    revealDownload: (params) => call('reveal-download', params),
    // 사용자가 파일 창을 오래 열어 둘 수 있다.
    chooseFiles: (params) => call('choose-files', params, 30 * 60_000),
    sleep: (params) => call('sleep', params), activity: (params) => call('activity', params), bind: (params) => call('bind', params), control: (params) => call('control', params), reset: () => call('reset'), inventory: () => call('inventory'),
    passwordAccounts: () => call('password-accounts'), passwordSnapshot: (params) => call('password-snapshot', params),
    passwordViewport: (params) => call('password-viewport', params),
    passwordCapture: (params) => call('password-capture', params),
    passwordFill: (params) => call('password-fill', params), passwordAction: (params) => call('password-action', params),
    // 데스크톱의 격리된 세계가 비밀 값을 한 칸에 입력한다. 같은 IPC 동작을 mode 로 나눈다.
    secretFill: (params) => call('password-fill', { ...params, mode: 'secret' }),
    passwordStorageState: () => call('password-storage-state'),
    // 보관함 로그인 하나의 에이전트 사용을 끄거나 켠다({ accountId, blocked }), 저장 카드의 로그인을 보관함에 넣는다({ origin, username, password }).
    passwordBlock: (params) => call('password-block', params),
    passwordSave: (params) => call('password-save', params),
    async dispose() { events.off('message', receive); listeners.clear(); nativeGeneration = undefined; for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error('BROWSER_CLOSED', 'The browser service closed.')); } pending.clear(); },
  };
}

/** One owner for shared authentication, with independently scoped agent tabs and control queues. */
export function createOwnedBrowserService(options = {}) {
  const { dataDir, credentialBroker, policy, downloads, onEvent = () => {}, nativeAdapter, runtimeFactory = startOwnedBrowserRuntime } = options;
  if (!dataDir) throw new TypeError('Owned browser dataDir is required');
  const guard = createBrowserNetworkGuard({ workspaceTargets: options.workspaceTargets ?? policy?.workspaceTargets ?? [], lookup: options.lookup });
  const isWorkspace = (origin) => { try { return guard.isWorkspace(origin); } catch { return false; } };
  const favicons = createFaviconCache({ dir: path.join(dataDir, 'browser', 'favicons'), resolve: guard.resolve, isWorkspace });
  const history = createBrowserHistory({ file: path.join(dataDir, 'browser', 'history.json') });
  const tabs = new Map();
  const pageTabs = new WeakMap();
  // 이 허브가 페이지에 입력한 사용자 비밀. 사이트가 값을 저장해 다른 탭에 다시 보여도 모든 관찰에서 가린다.
  const filledSecrets = new Set();
  const protectedFor = (tab) => filledSecrets.size ? new Set([...(tab?.protectedValues ?? []), ...filledSecrets]) : tab?.protectedValues;
  // 그림은 가릴 수 없다. 입력한 비밀이 페이지 글이나 입력 칸에 보이면 캡처하지 않는다.
  const pageShowsFilledSecret = async (page) => {
    if (!filledSecrets.size || !page) return false;
    for (const frame of page.frames()) {
      const texts = await frame.evaluate(() => [document.documentElement?.innerText ?? '', ...[...document.querySelectorAll('input,textarea')].map((el) => el.value)]).catch(() => []);
      if (texts.some((value) => [...filledSecrets].some((secret) => String(value).includes(secret)))) return true;
    }
    return false;
  };
  const runtimeId = id('runtime');
  const descriptorFile = path.join(dataDir, 'browser', 'tabs.json');
  let generation = 0;
  let runtime;
  let starting;
  let state = 'idle';
  let closed = false;
  let resetting = false;
  let resetFailed = false;
  let persistQueue = Promise.resolve();
  let idleSleepMs = (options.idleMinutes ?? 15) * 60_000;
  let sleepSweepRunning = false;
  const sleepTimer = setInterval(() => { void sweepSleepingTabs().catch(() => {}); }, options.sleepCheckMs ?? 30_000);
  sleepTimer.unref?.();
  async function sweepSleepingTabs(now = Date.now()) {
    if (sleepSweepRunning || closed || !idleSleepMs || state !== 'ready' || resetting || signIn || handoffPending || !selectedAdapter()?.sleep) return;
    sleepSweepRunning = true;
    try {
      for (const tab of tabs.values()) {
        if (!tab.page || tab.sleeping || tab.activeActor || tab.pendingChooser || now - tab.lastActivityAt < idleSleepMs) continue;
        await enqueue(tab, async () => {
          if (!tab.page || tab.sleeping || tab.activeActor || now - tab.lastActivityAt < idleSleepMs) return;
          await sleepTab(tab);
        });
      }
    } finally { sleepSweepRunning = false; }
  }
  async function sleepTab(tab, { manual = false, discard = false } = {}) {
    if (tab.sleeping) return { sleeping: true };
    if (!tab.page || tab.activeActor || tab.pendingChooser || !selectedAdapter()?.sleep) return { sleeping: false, reason: 'busy' };
    tab.sleepPending = true; const url = tab.page.url();
    try {
      const result = await selectedAdapter().sleep({ targetId: tab.nativeTargetId, tabId: tab.tabId, idleMs: idleSleepMs, manual, discard });
      if (!result?.sleeping) return result;
      tab.url = url; tab.page = null; tab.nativeTargetId = undefined;
      tab.sleeping = true; tab.restorePending = true; tab.status = 'sleeping';
      invalidate(tab); publish(tab); await persist();
      return { sleeping: true };
    } finally { tab.sleepPending = false; }
  }
  async function wakeTab(actor, tab) {
    if (!tab.sleeping) return;
    await enqueue(tab, async () => {
      if (!tab.sleeping) return;
      await ensureRuntime(); await assertPolicy(actor, 'browse', tab.url, tab);
      const url = tab.url;
      const page = await runtime.context.newPage();
      tab.activeActor = actor; tab.sleeping = false;
      try {
        if (actor.isHuman) tab.sessionId = actor.sessionId ?? tab.sessionId;
        await attach(tab, page);
        if (url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded' });
        tab.restorePending = false; tab.status = 'ready'; publish(tab); await persist();
      } catch (failure) {
        tab.sleepPending = true; await page.close().catch(() => {}); tab.sleepPending = false;
        tab.page = null; tab.nativeTargetId = undefined; tab.sleeping = true; tab.status = 'sleeping'; throw failure;
      } finally { tab.activeActor = null; }
    });
  }
  let installPromise;
  let runtimeMode = options.runtimeMode === 'managed' ? 'managed' : nativeAdapter ? 'native' : 'managed';
  let headless = options.headless !== false;
  let checkpointTimer;
  let checkpointQueue = Promise.resolve();
  let signIn;
  let signInAccountId;
  let handoffPending = false;
  let handoffPromise;
  let handoffProfile = false;
  let handoffPreviousMode;
  // Chrome에서 사이트 하나에 로그인하는 동안의 상태. 저장 계정 없이 사용자가 고른 사이트만 돌려받는다.
  let signInSite = null;
  let siteFinish = null;
  // Chrome이 뜨는 중에 눌린 취소. 뜨자마자 닫는다.
  let siteCancelRequested = false;
  let passkeys;
  // 에이전트가 이 탭에서 거절된 요청. 조작 결과로 돌려준다(blocked 는 오류, dropped 는 목록).
  const DROPPED_LIMIT = 10;
  let cookieRefresh = null;
  let cookieRefreshedAt = 0;
  // 새 쿠키가 에이전트 방문으로만 생겼는지(손님 쿠키) 가리려고 사이트마다 마지막 요청 시각을 둔다.
  // identity 는 저장된 로그인을 입력한 시각이다. 그 사이트의 쿠키는 사용자 신원이 된다.
  const siteTouches = new Map();
  const cookieSnapshots = new Map();
  const TOUCH_MARGIN_MS = 10_000;
  const IDENTITY_MS = 10 * 60 * 1000;
  const touchSite = (url, kind) => {
    let key; try { key = cookieSiteKey(new URL(url).hostname); } catch { return; }
    if (!key) return;
    const entry = siteTouches.get(key) ?? {}; entry[kind] = Date.now();
    siteTouches.delete(key); siteTouches.set(key, entry);
    if (siteTouches.size > 4096) siteTouches.delete(siteTouches.keys().next().value);
  };
  let protectedLoad;
  const profileId = () => runtimeMode === 'native' ? 'native' : 'default';
  const selectedAdapter = () => runtimeMode === 'native' ? nativeAdapter : undefined;
  const browserStorageState = async () => (await selectedAdapter()?.passwordStorageState?.()) ?? runtime.context.storageState({ indexedDB: true });
  const nativePasswordBinding = (tab) => ({ targetId: tab.nativeTargetId, tabId: tab.tabId, sessionId: tab.sessionId, chatId: tab.threadId });
  const limits = { maxTabs: options.maxTabs ?? 12, maxTabsPerAgent: options.maxTabsPerAgent ?? 3, maxDownloadBytes: options.maxDownloadBytes ?? 100 * 1024 * 1024, maxFrameBytes: options.maxFrameBytes ?? 5 * 1024 * 1024 };

  const emit = (type, payload) => { try { onEvent({ type, ...payload }); } catch {} };
  // 사용자가 직접 조작을 가져간 탭(controller.held). 에이전트 쓰기를 막고, 그동안의 페이지 요청은 사용자의 것으로 본다(pageActor).
  const userHolds = (tab) => tab.controller.held === true;
  const nativeControl = (tab) => ({ targetId: tab.nativeTargetId, human: true, held: userHolds(tab) });
  const runtimeInfo = () => ({ runtimeId, generation, passkeys, state: resetting ? 'resetting' : resetFailed ? 'reset-failed' : handoffPending ? 'sign-in-starting' : state, kind: runtime?.kind ?? (runtimeMode === 'native' ? 'native' : 'chromium'), mode: runtimeMode, headless, profile: 'shared', profileId: profileId(), security: 'restricted-plaintext-profile', supportsSignIn: true, supportsNative: !!nativeAdapter, googleSignIn: runtimeMode === 'native' ? 'switch-to-full-browser' : 'standalone-no-debug-available', signIn: signIn || signInSite ? { mode: signIn?.mode ?? 'standalone-no-debug', accountId: signInAccountId, exited: signIn ? signIn.exited : true, ...(signInSite ? { site: signInSite.domain } : {}) } : null });
  const descriptor = (tab) => redactValues({ tabId: tab.tabId, scope: tab.scope ?? 'agent', threadId: tab.threadId, documentId: tab.documentId, projectId: tab.projectId, agentId: tab.agentId, profileId: profileId(), url: tab.snapshot?.passwordProtected ? tab.snapshot.url : publicURL(tab.page?.url?.() ?? tab.url), title: tab.snapshot?.passwordProtected ? '' : tab.title, status: challengeFor(tab) ? 'challenge-required' : tab.status, challenge: challengeFor(tab), navigationEpoch: tab.navigationEpoch, controllerEpoch: tab.controllerEpoch, controller: { ...tab.controller }, runtime: runtime?.kind ?? tab.runtime ?? 'chromium', nativeTargetId: tab.nativeTargetId, openerTabId: tab.openerTabId, zoomFactor: tab.zoomFactor ?? 1, runtimeGeneration: generation, snapshotId: tab.snapshot?.snapshotId ?? null, ...(tab.pendingDialog ? { dialog: { type: tab.pendingDialog.type, message: tab.lastDialog?.message ?? '', ...(tab.pendingDialog.owner === 'human' ? { owner: 'user' } : {}) } } : {}) }, protectedFor(tab));
  const challengeResult = (action, tab) => ({ ok: false, action, ...challengeFor(tab), tab: descriptor(tab), runtime: runtimeInfo(), continuation: { tabId: tab.tabId, humanControl: true, reuseTab: true } });
  // 사이트 아이콘은 사용자 화면용 이벤트와 목록에만 붙인다. 에이전트 결과·browser_status·tabs.json은 descriptor만 쓴다.
  const faviconFor = (tab) => tab.snapshot?.passwordProtected || tab.passwordShielded ? undefined : favicons.peek(faviconOrigin(tab.page?.url?.() ?? tab.url, isWorkspace)) ?? undefined;
  const humanTab = (tab) => { const current = descriptor(tab), faviconUrl = faviconFor(tab); return faviconUrl ? { ...current, faviconUrl } : current; };
  // 허브 행위자(ChatGPT·Claude)의 탭은 뒤에서 돈다. 사용자의 탭 목록·미리보기·커서에는 나오지 않는다.
  const publish = (tab) => { if (!tab.system) emit('owned_browser_tab', { tab: humanTab(tab), runtime: runtimeInfo() }); };
  const previewActivity = (actor, tab, active = true) => { if (!actor.isHuman && !tab.system) emit('owned_browser_activity', { active, sessionId: actor.sessionId ?? tab.sessionId, ...(actor.taskId ? { subagent: true } : {}), tab: descriptor(tab), runtime: runtimeInfo() }); };
  const persist = () => {
    if (resetting || resetFailed) return Promise.resolve();
    // 로그인 창 같은 일회용 탭은 다음 실행에 되살리지 않는다.
    const records = [...tabs.values()].filter((tab) => !tab.transient).map((tab) => ({ ...descriptor(tab), sessionId: tab.sessionId, taskId: tab.taskId, ...(tab.system ? { system: tab.system } : {}), searchQuery: googleResearchURL(tab.page?.url?.() ?? tab.url) && typeof tab.searchQuery === 'string' ? text(tab.searchQuery, 4000) : undefined }));
    persistQueue = persistQueue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(descriptorFile), { recursive: true, mode: 0o700 });
      const temp = `${descriptorFile}.${crypto.randomBytes(8).toString('hex')}.part`;
      await fs.writeFile(temp, JSON.stringify({ version: 1, tabs: records }), { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, descriptorFile);
    });
    return persistQueue;
  };
  const validateActor = (actor) => {
    if (!actor || (actor.isHuman ? !actor.clientId : !actor.threadId || !actor.agentId)) throw error('BROWSER_SCOPE_REQUIRED', 'A server-authorized browser actor is required.');
    if (closed) throw error('BROWSER_CLOSED', 'The browser service has closed.');
  };
  const ownedTab = (actor, tabId) => {
    const tab = tabs.get(tabId);
    if (!tab || (!actor.isHuman && !canAccessTab(actor, tab))) throw error('BROWSER_TAB_NOT_FOUND', 'This browser tab is unavailable to the current agent.');
    return tab;
  };
  // 정책 동작: 명시한 사이트 변경, 다운로드, 그 밖에 현재 페이지에서 하는 일은 읽기, 새 주소 열기는 열람이다.
  // 위험한 주소(/delete, ?action=purchase 등)로 가는 탐색은 사이트 변경이다. 계정·비밀 사용은 입력하는 곳에서 따로 묻는다.
  const policyAction = (actor, action, url, args) => {
    if (args.intent === 'website-change') return 'website-change';
    if (action === 'download') return 'download';
    if (['open', 'navigate'].includes(action) && !actor.isHuman && changesWebsiteURL(url)) return 'website-change';
    return READS.has(action) || MUTATIONS.has(action) ? 'read' : 'browse';
  };
  /** 에이전트 행위를 정책에 묻는다. 사이트가 없는 주소(about:·data:·chrome-error:)는 묻지 않는다. 거절은 다음 호출을 담은 오류다. */
  const assertPolicy = async (actor, action, url, tab, args = {}) => {
    if (actor.isHuman || !webOrigin(url)) return null;
    const mapped = args.policyAction ?? policyAction(actor, action, url, args);
    if (!policy?.check) {
      if (mapped === 'website-change') throw error('BROWSER_WEBSITE_CHANGE_REQUIRED', "Website changes need the owner's browser policy.");
      return null;
    }
    // 사용자가 공유한 탭의 현재 페이지는 로그인한 사이트여도 읽을 수 있다. 새 주소로 가는 탐색은 그렇지 않다.
    const shared = tab?.scope === 'global' && !['open', 'navigate'].includes(action);
    const decision = await policy.check({ actor, action: mapped, url, profileId: profileId(), resource: args.resource ?? 'document', shared, item: args.item ?? null });
    if (!decision.allowed) throw denialError(decision, actor);
    return decision;
  };
  // 조작 하나 동안 거절된 요청을 모은다. 첫 거절은 조작의 오류가 되고(blocked), 사이트 밖 잡요청은 목록으로만 남는다(dropped).
  const recordDenied = (tab, decision, actor, { performed = false, fatal = true, method = 'GET' } = {}) => {
    if (fatal) { tab.blocked ??= denialError(decision, actor, { performed }); return; }
    tab.dropped ??= [];
    if (tab.dropped.length < DROPPED_LIMIT) tab.dropped.push({ origin: decision.origin, method, code: decision.code });
  };
  /** 저장된 로그인이 있는 사이트와 쿠키가 있는 사이트(새로 생긴 손님 쿠키 포함)를 정책에 알린다. 로그인 표시는 쿠키가 있어야 산다. */
  const refreshCookieSites = ({ force = false } = {}) => {
    if (!policy?.setCookieSites || !runtime || state !== 'ready') return Promise.resolve();
    if (!force && (cookieRefresh || Date.now() - cookieRefreshedAt < 1000)) return cookieRefresh ?? Promise.resolve();
    const profile = profileId();
    const observed = runtime;
    cookieRefresh = (async () => {
      if (policy.setSavedLoginSites) {
        const logins = profile === 'native' ? await selectedAdapter()?.passwordAccounts?.().then((result) => result?.accounts ?? null, () => null)
          : await credentialBroker?.listAccounts?.().then((result) => (result?.accounts ?? []).filter((account) => account.profileId === 'default'), () => null);
        if (Array.isArray(logins)) policy.setSavedLoginSites(profile, logins.map((account) => account.origin).filter((origin) => signedInKey(origin)));
      }
      const readAt = Date.now();
      let cookies = null;
      try { cookies = (await selectedAdapter()?.passwordStorageState?.())?.cookies ?? null; } catch {}
      if (!cookies) try { cookies = await observed.context.cookies?.(); } catch {}
      if (!cookies) try { cookies = (await observed.context.storageState?.())?.cookies; } catch {}
      if (Array.isArray(cookies) && runtime === observed) {
        const live = new Set(cookies.map((cookie) => cookieSiteKey(cookie.domain)).filter(Boolean));
        // 직전 읽기 이후 처음 생긴 쿠키 사이트 중 에이전트만 요청한 곳은 손님 쿠키다. 시작 때 이미 있던 쿠키는 사용자 것으로 본다.
        const previous = cookieSnapshots.get(profile);
        const since = (previous?.at ?? readAt) - TOUCH_MARGIN_MS;
        const identity = (key) => (siteTouches.get(key)?.identity ?? 0) >= readAt - IDENTITY_MS;
        const guest = previous ? [...live].filter((key) => {
          const touched = siteTouches.get(key);
          return !previous.keys.has(key) && (touched?.agent ?? 0) >= since && !((touched?.human ?? 0) >= since) && !identity(key);
        }) : [];
        cookieSnapshots.set(profile, { keys: live, at: readAt });
        await policy.setCookieSites(profile, live, { guest, owned: [...live].filter(identity) });
      }
    })().catch(() => {}).finally(() => { cookieRefresh = null; cookieRefreshedAt = Date.now(); });
    return cookieRefresh;
  };
  /** 사용자의 폼 제출(로그인 등)이 끝난 사이트 중 쿠키가 생긴 곳에 로그인 표시를 남긴다. */
  const markOwnerForm = async (sites) => {
    await refreshCookieSites({ force: true });
    let cookies = null;
    try { cookies = (await selectedAdapter()?.passwordStorageState?.())?.cookies ?? await runtime?.context.cookies?.(); } catch {}
    const withCookies = new Set((cookies ?? []).map((cookie) => cookieSiteKey(cookie.domain)));
    const marked = [...sites].filter((key) => withCookies.has(key)).map((key) => new URL(key).hostname);
    if (marked.length) await policy?.markSignedIn?.({ profileId: profileId(), domains: marked, source: 'owner-form' });
  };
  /** 다시 시작한 뒤 첫 에이전트 관찰 전에, 최근에 입력한 비밀번호·비밀을 가릴 값으로 다시 읽는다. */
  const loadProtected = () => protectedLoad ??= Promise.resolve().then(() => options.loadProtectedValues?.()).then((values) => {
    for (const value of values ?? []) rememberFilled(value);
  }).catch(() => {});
  const rememberFilled = (value) => {
    if (typeof value !== 'string' || !value) return;
    filledSecrets.add(value);
    if (filledSecrets.size > 256) filledSecrets.delete(filledSecrets.values().next().value);
  };
  const invalidate = (tab) => {
    for (const handle of tab.snapshot?.handles?.values?.() ?? []) void handle.dispose?.().catch(() => {});
    tab.snapshot = null;
    tab.frame = null;
    credentialBroker?.invalidateTab?.(tab.tabId);
  };
  // 브라우저가 읽은 페이지가 선언한 아이콘만 받는다. 네이티브 탭은 Electron이 알려 주고, 관리형 탭은 격리된 선택 엔진으로 link만 읽는다.
  const readIconLinks = async (page) => {
    const links = page.locator('link[rel~="icon" i], link[rel~="apple-touch-icon" i], link[rel~="apple-touch-icon-precomposed" i]');
    const found = [];
    for (let index = 0; index < Math.min(8, await links.count()); index++) {
      const link = links.nth(index), read = (name) => link.getAttribute(name, { timeout: 500 }).catch(() => null);
      found.push({ href: await read('href'), rel: await read('rel'), sizes: await read('sizes'), type: await read('type') });
    }
    return found;
  };
  // 저장한 비밀번호가 있는 페이지, 로그인 진행, 작업 미리보기, Google 검색·확인 페이지는 남기지 않는다. 주소는 history 가 다듬는다.
  const recordVisit = (tab, url) => {
    if (closed || resetting || resetFailed || signIn || handoffPending || tab.passwordShielded || tab.snapshot?.passwordProtected) return;
    const origin = webOrigin(url);
    if (!origin || isWorkspace(origin) || googleResearchURL(url)) return;
    void history.record({ url, title: tab.title, profileId: profileId() }).catch(() => {});
  };
  // 나중에 저장한 비밀번호가 보인 페이지는 방문 기록에서 뺀다.
  const forgetVisit = (tab) => { const url = tab.page?.url?.() ?? tab.url; if (webOrigin(url)) void history.forget({ url, profileId: profileId() }).catch(() => {}); };
  /** browser_status { history }: 이 프로필의 자주 간 사이트. 차단한 사이트는 빼고, 승인 없는 로그인 사이트는 주소 경로와 제목을 감춘다. */
  const visitedSites = async (actor, query) => {
    const sites = [], hidden = new Map();
    for (const entry of await history.list({ profileId: profileId(), query, limit: HISTORY_LIST_LIMIT * 2 })) {
      if (sites.length >= HISTORY_LIST_LIMIT) break;
      const origin = webOrigin(entry.url);
      if (!actor.isHuman && policy?.blockedActionsFor && (await policy.blockedActionsFor(origin)).includes('browse')) continue;
      const decision = !actor.isHuman && policy?.check ? await policy.check({ actor, action: 'browse', url: entry.url, profileId: profileId() }).catch(() => null) : null;
      const lastVisited = new Date(entry.lastVisitedAt).toISOString().slice(0, 10);
      if (decision && !decision.allowed) {
        const site = hidden.get(origin);
        if (site) { site.visits += entry.visits; continue; }
        const item = { title: '', url: `${origin}/`, visits: entry.visits, lastVisited, signedIn: true };
        hidden.set(origin, item); sites.push(item); continue;
      }
      sites.push({ title: entry.title, url: entry.url, visits: entry.visits, lastVisited });
    }
    return redactValues(sites, filledSecrets);
  };
  const discoverFavicon = async (tab, pageUrl, links) => {
    const origin = faviconOrigin(pageUrl, isWorkspace);
    if (!origin || closed || resetting || resetFailed || tab.snapshot?.passwordProtected || tab.passwordShielded) return;
    const before = favicons.peek(origin);
    // 허브의 아이콘 요청도 탭 자신의 하위 요청과 같은 사이트 정책을 거친다. 승인되지 않은 출처로 새는 길을 만들지 않는다.
    const authorize = (url) => assertPolicy(pageActor(tab), 'browse', url, tab, { resource: 'subresource' }).then(() => true, () => false);
    const icon = await favicons.discover(origin, faviconCandidates(pageUrl, links, { isWorkspace }), { authorize }).catch(() => null);
    if (icon && icon !== before && tabs.get(tab.tabId) === tab && !closed && !resetting) publish(tab);
  };
  const unsubscribeNativeEvents = nativeAdapter?.onEvent?.((event) => {
    const tab = tabs.get(event.tabId);
    if (!closed && runtimeMode === 'native' && tab && event.reason === 'download-progress' && event.targetId === tab?.nativeTargetId && event.generation === tab?.nativeGeneration) { downloads?.reportProgress?.({ tabId: tab.tabId, ...event }); return; }
    if (event.reason === 'human-input') {
      // 데스크톱이 실제 사용자 입력을 탭에 전달했다. 이어지는 로그인 제출 같은 요청은 사용자의 것이다.
      if (!closed && runtimeMode === 'native' && tab?.page && event.targetId === tab.nativeTargetId && event.generation === tab.nativeGeneration && !tab.humanDriven) tab.humanDriven = true;
      return;
    }
    if (event.reason === 'favicon') { if (!closed && runtimeMode === 'native' && tab?.page && event.targetId === tab.nativeTargetId && event.generation === tab.nativeGeneration) void discoverFavicon(tab, event.pageUrl, event.favicons.slice(0, 16)); return; }
    if (closed || runtimeMode !== 'native' || state !== 'ready' || !tab?.page
      || !tab.nativeGeneration || event.reason !== 'zoom' || event.targetId !== tab.nativeTargetId
      || event.generation !== tab.nativeGeneration || !Number.isFinite(event.zoomFactor)) return;
    tab.zoomFactor = event.zoomFactor;
    tab.geometryEpoch = (tab.geometryEpoch ?? 0) + 1;
    invalidate(tab);
    publish(tab);
  });
  const epochs = (tab, args, required = false) => {
    if (required && (args.navigationEpoch === undefined || args.controllerEpoch === undefined)) throw error('BROWSER_EPOCH_REQUIRED', 'Refresh the browser state before sending input.');
    if (args.navigationEpoch !== undefined && args.navigationEpoch !== tab.navigationEpoch) throw error('BROWSER_STALE_NAVIGATION', 'The page changed. Take a new snapshot before continuing.', true);
    if (args.controllerEpoch !== undefined && args.controllerEpoch !== tab.controllerEpoch) throw error('BROWSER_STALE_CONTROL', 'Browser control changed. Refresh the tab before continuing.', true);
    if (args.runtimeGeneration !== undefined && args.runtimeGeneration !== generation) throw error('BROWSER_STALE_RUNTIME', 'The browser restarted. Refresh its inventory before continuing.', true);
  };
  const assertController = (actor, tab) => {
    if (actor.isHuman && tab.scope !== 'global' && actor.sessionId && tab.sessionId && actor.sessionId !== tab.sessionId) throw error('BROWSER_CONTROL_REQUIRED', 'This browser tab belongs to another editor window.');
    // 사용자가 직접 조작을 가져간 탭은 돌려받을 때까지 에이전트의 페이지 변경을 기다리게 하지 않고 바로 거절한다.
    if (!actor.isHuman && tab.controller.held) throw error('BROWSER_USER_CONTROL', 'The user is controlling this tab. Wait for them to return control, or continue without it.');
  };
  /**
   * 페이지가 연 파일 선택을 사용자에게 넘긴다. browser_upload 가 직접 채우는 선택은 넘기지 않는다.
   * 데스크톱에서 사용자가 직접 누른 파일 칸은 운영체제 파일 창을 열어 고른 파일을 그대로 넣는다.
   * 그 밖(관리형 브라우저, 에이전트가 누른 단추)은 사이드바의 파일 선택 막대로 받는다.
   */
  const offerChooser = (tab, chooser) => {
    if (tab.agentUpload || tab.page !== chooser.page()) return;
    const agentTriggered = tab.activeActor && !tab.activeActor.isHuman;
    void chooser.element().getAttribute('accept').catch(() => null).then(async (accept) => {
      const multiple = chooser.isMultiple();
      const adapter = selectedAdapter();
      if (adapter?.chooseFiles && tab.nativeTargetId && !agentTriggered) {
        const chosen = await adapter.chooseFiles({ ...nativePasswordBinding(tab), multiple, accept: text(accept, 500) }).catch(() => null);
        if (chosen) {
          if (chosen.paths?.length && tab.page === chooser.page()) await chooser.setFiles(chosen.paths).catch(() => {});
          return;
        }
      }
      if (tab.page !== chooser.page()) return;
      tab.pendingChooser = chooser;
      emit('owned_browser_file_chooser', { tabId: tab.tabId, threadId: tab.threadId, multiple, ...(accept ? { accept: text(accept, 500) } : {}), navigationEpoch: tab.navigationEpoch, controllerEpoch: tab.controllerEpoch });
    });
  };
  const enqueue = (tab, operation) => {
    const result = tab.queue.catch(() => {}).then(operation);
    tab.queue = result.catch(() => {});
    return result;
  };
  const dismissPendingDialog = async (tab) => {
    const pending = tab.pendingDialog;
    tab.pendingDialog = null;
    await pending?.dialog.dismiss().catch(() => {});
  };
  // 사용자가 네이티브 창에서 답한 대화상자는 알림이 오지 않는다. 페이지가 다시 응답하면 닫힌 것으로 본다.
  const dialogStillOpen = async (tab) => {
    const pending = tab.pendingDialog;
    if (!pending || !tab.page || tab.page.isClosed()) { tab.pendingDialog = null; return false; }
    let timer;
    const open = await Promise.race([tab.page.evaluate(() => 1).then(() => false, () => false), new Promise((resolve) => { timer = setTimeout(() => resolve(true), 300); })]).finally(() => clearTimeout(timer));
    if (!open && tab.pendingDialog === pending) tab.pendingDialog = null;
    return open;
  };
  const dialogInfo = (tab) => {
    const pending = tab.pendingDialog;
    if (!pending) return undefined;
    const message = tab.lastDialog?.message ?? '';
    return redactValues({ type: pending.type, message, ...(pending.defaultValue ? { defaultValue: pending.defaultValue } : {}), ...(pending.owner === 'human' ? { owner: 'user' } : {}) }, protectedFor(tab));
  };
  const dialogPending = (tab) => {
    const dialog = dialogInfo(tab);
    // 모델에는 코드와 문구만 간다. 대화상자의 종류·문구와 browser_dialog 에 넣을 세대를 문구에 싣는다.
    const detail = dialog ? ` Dialog ${dialog.type}: ${JSON.stringify(text(dialog.message, 300))}${dialog.defaultValue ? ` (default ${JSON.stringify(dialog.defaultValue)})` : ''}.` : '';
    const failure = dialog?.owner === 'user'
      ? error('BROWSER_DIALOG_PENDING', `The user is answering a page dialog in this tab.${detail} Wait for them, then observe the page again.`, true)
      : error('BROWSER_DIALOG_PENDING', `A page dialog is open.${detail} Answer it with browser_dialog before other actions.`, true);
    failure.dialog = dialog; failure.navigationEpoch = tab.navigationEpoch; failure.controllerEpoch = tab.controllerEpoch;
    return failure;
  };
  /**
   * 조작이 대화상자를 열면 Input 명령이 대화상자가 닫힐 때까지 돌아오지 않는다. 조작과 대화상자 열림을 겨루어
   * 대화상자가 먼저면 조작을 기다리지 않고 돌아온다. 남은 조작은 browser_dialog 가 답한 뒤 마무리한다.
   */
  const raceDialog = async (tab, work) => {
    let signal; const opened = new Promise((resolve) => { signal = resolve; });
    tab.dialogSignal = () => { if (tab.pendingDialog) signal(); };
    const running = Promise.resolve().then(work);
    try {
      const outcome = await Promise.race([running.then((value) => ({ value })), opened.then(() => null)]);
      if (outcome) return outcome.value;
      running.catch(() => {}); tab.dialogAction = running;
      return undefined;
    } finally { tab.dialogSignal = null; }
  };
  const releaseInput = async (tab) => {
    await dismissPendingDialog(tab);
    for (const key of tab.heldKeys) await tab.page?.keyboard?.up(key).catch(() => {});
    for (const button of tab.heldButtons) await tab.page?.mouse?.up({ button }).catch(() => {});
    tab.heldKeys.clear(); tab.heldButtons.clear();
  };
  const actorForTab = (tab) => ({ threadId: tab.threadId, projectId: tab.projectId, documentId: tab.documentId, agentId: tab.agentId, ownerId: tab.ownerId, sessionId: tab.sessionId, isHuman: false, ...(tab.system ? { system: tab.system } : {}) });
  // 페이지가 스스로 보내는 요청의 주체. 사용자가 잡았거나 화면에서 직접 누른 탭의 요청은 사용자의 것이다.
  // 에이전트가 다음 조작을 시작하면 humanDriven 이 풀려 다시 에이전트 정책을 따른다.
  const pageActor = (tab, { ignoreActive = false } = {}) => (!ignoreActive && tab.activeActor) || (tab.controller.owner === 'human' || userHolds(tab) || tab.humanDriven
    ? { ...actorForTab(tab), isHuman: true, clientId: tab.controller.clientId ?? tab.sessionId } : actorForTab(tab));
  const onDownload = async (tab, download) => {
    const actor = Object.freeze(pageActor(tab));
    const target = Object.freeze({ ...descriptor(tab), taskId: tab.taskId });
    const pageUrl = tab.page.url();
    const deliveredUrl = typeof download.url === 'function' ? download.url() : '';
    const downloadUrl = /^https?:/.test(deliveredUrl) ? deliveredUrl : pageUrl;
    const transferRuntime = runtime;
    try {
      await assertPolicy(actor, 'download', pageUrl, tab);
      await assertPolicy(actor, 'download', downloadUrl, tab);
      const handler = downloads?.handleBrowserDownload ?? downloads?.acceptBrowserDownload;
      if (!handler) throw error('BROWSER_DOWNLOADS_UNAVAILABLE', 'Managed downloads are not configured.');
      let monitoring = false;
      const monitor = setInterval(async () => {
        if (monitoring) return;
        monitoring = true;
        try {
          await assertPolicy(actor, 'download', pageUrl, tab);
          await assertPolicy(actor, 'download', downloadUrl, tab);
          const files = await fs.readdir(transferRuntime.downloadsPath, { withFileTypes: true });
          let total = 0;
          const maxBytes = downloads.maxBytes ?? limits.maxDownloadBytes;
          for (const file of files) if (file.isFile()) { const stat = await fs.stat(path.join(transferRuntime.downloadsPath, file.name)); total += stat.size; if (stat.size > maxBytes) await download.cancel(); }
          if (total > maxBytes * (downloads.maxConcurrent ?? 4)) await download.cancel();
        } catch (failure) { if (failure.code?.startsWith('BROWSER_')) await download.cancel().catch(() => {}); } finally { monitoring = false; }
      }, 100);
      monitor.unref?.();
      try {
        await handler.call(downloads, { download, actor, tab: target, pageUrl, source: { url: deliveredUrl || undefined, title: tab.title } });
        // The manager reserves a durable job immediately; Playwright completes its temporary transfer later.
        if (typeof download.failure === 'function') await download.failure();
      }
      finally { clearInterval(monitor); }
    } catch (failure) {
      await download.cancel().catch(() => {});
      // 정책이 막은 다운로드는 에이전트도 알아야 한다. 일으킨 조작의 결과와 browser_downloads 에 같은 거절을 싣는다.
      if (failure?.request) tab.lastDownloadDenial = { at: Date.now(), denial: { code: failure.code, message: failure.message, site: failure.site, origin: failure.origin, request: failure.request, ...(failure.blocked ? { blocked: failure.blocked } : {}) } };
      emit('owned_browser_download_error', { tabId: tab.tabId, threadId: tab.threadId, projectId: tab.projectId, error: { code: failure.code ?? 'BROWSER_DOWNLOAD_FAILED', message: failure?.request ? failure.message : 'The browser download could not be stored.' } });
    }
  };

  const attach = async (tab, page) => {
    tab.page = page;
    pageTabs.set(page, tab);
    // 네이티브 WSS는 검증된 목적지로 TLS 프록시를 통과한다. JS 바인딩은 관리형 브라우저에서만 설치한다.
    if (!selectedAdapter()) await page.routeWebSocket('**/*', async (socket) => {
      const url = socket.url().replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
      try {
        await guard.resolve(url);
        // 웹소켓은 페이지의 하위 요청이다. 차단된 사이트만 끊는다.
        const subresource = { resource: 'subresource' };
        await assertPolicy(pageActor(tab), 'browse', url, tab, subresource);
        const server = socket.connectToServer();
        socket.onMessage(async (message) => {
          const actor = pageActor(tab);
          try { await assertPolicy(actor, 'browse', url, tab, subresource); server.send(message); }
          catch { await server.close({ code: 4003, reason: 'Website changes require owner approval' }); await socket.close({ code: 4003, reason: 'Website changes require owner approval' }); }
        });
        server.onMessage(async (message) => {
          const actor = pageActor(tab, { ignoreActive: true });
          try { await assertPolicy(actor, 'browse', url, tab, subresource); socket.send(message); }
          catch { await server.close({ code: 4003, reason: 'Website access requires owner approval' }); await socket.close({ code: 4003, reason: 'Website access requires owner approval' }); }
        });
      } catch { await socket.close({ code: 4003, reason: 'Browser destination blocked' }); }
    });
    // 3xx 홉은 경로에 오지 않는다. 주 프레임 홉을 모아 조작 뒤에 판정하고, 사용자 폼 제출이 지나간 사이트를 모은다.
    page.on('request', (request) => {
      let main = false; try { main = request.isNavigationRequest() && request.frame() === page.mainFrame(); } catch {}
      if (!main || tab.page !== page) return;
      const head = chainHead(request);
      if (head !== request && tab.navHops && tab.navHops.length < 20) tab.navHops.push(request.url());
      if (!pageActor(tab).isHuman || !(nonGet(head.method()) || ownerForms.has(head))) return;
      const sites = ownerForms.get(head) ?? new Set();
      ownerForms.set(head, sites);
      const key = request.url().startsWith('https://') ? cookieSiteKey(new URL(request.url()).hostname) : null;
      if (key) sites.add(key);
      void request.response().then(() => markOwnerForm(sites)).catch(() => {});
    });
    page.on('download', (download) => { void onDownload(tab, download); });
    page.on('dialog', (dialog) => {
      if (tab.page !== page) { void dialog.dismiss().catch(() => {}); return; }
      const type = dialog.type();
      tab.dialogCount = (tab.dialogCount ?? 0) + 1; tab.lastDialog = { type, message: text(dialog.message(), 300) };
      // 네이티브 사용자 확인은 창의 비동기 대화상자로 처리한다. 에이전트는 사용자의 대화상자에 답하지 않는다.
      const human = pageActor(tab).isHuman === true;
      if (human) {
        if (selectedAdapter() && !closed) { tab.pendingDialog = { dialog, type, owner: 'human', at: Date.now() }; return; }
        void dialog.dismiss().catch(() => {}); return;
      }
      // 알림(alert)은 고를 것이 없어 바로 닫고 문구만 결과로 돌려준다. 확인·입력·떠나기 확인은 browser_dialog 를 기다린다.
      if (type === 'alert') { void dialog.dismiss().catch(() => {}); tab.dialogSignal?.(); return; }
      tab.pendingDialog = { dialog, type, owner: 'agent', at: Date.now(), defaultValue: text(dialog.defaultValue?.() ?? '', 300) };
      publish(tab);
      tab.dialogSignal?.();
    });
    page.on('filechooser', (chooser) => offerChooser(tab, chooser));
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      if (tab.page !== page) return;
      const epoch = ++tab.navigationEpoch;
      invalidate(tab); tab.url = page.url(); tab.status = 'loading'; publish(tab); void persist();
      // 해시·history 탐색은 DOMContentLoaded를 다시 보내지 않는다. 다음 탐색의 상태는 덮어쓰지 않는다.
      void Promise.resolve().then(() => page.evaluate(() => document.readyState)).then((ready) => {
        if (tab.page !== page || tab.navigationEpoch !== epoch || ready === 'loading' || page.isClosed()) return;
        tab.status = 'ready'; publish(tab); void persist();
      }).catch(() => {});
    });
    page.on('domcontentloaded', () => {
      if (tab.page !== page) return;
      const epoch = tab.navigationEpoch;
      // 방문 기록은 사용자가 연 페이지만 남긴다. 에이전트가 연 페이지는 사용자가 자주 가는 곳이 아니다.
      const human = pageActor(tab).isHuman === true;
      tab.status = 'ready'; publish(tab);
      void page.title().then((title) => {
        if (tab.page !== page || tab.navigationEpoch !== epoch) return;
        tab.title = text(title, 500); publish(tab); void persist();
        if (human) recordVisit(tab, page.url());
      }).catch(() => {});
      if (!selectedAdapter()) void readIconLinks(page).catch(() => []).then((links) => tab.page === page && tab.navigationEpoch === epoch ? discoverFavicon(tab, page.url(), links) : undefined);
    });
    page.on('crash', () => { if (tab.page !== page) return; tab.status = 'crashed'; tab.controllerEpoch++; invalidate(tab); publish(tab); });
    page.on('close', () => {
      if (tab.page !== page) return;
      if (tab.sleepPending) { tab.page = null; tab.status = 'sleeping'; tab.controllerEpoch++; invalidate(tab); return; }
      tab.status = closed ? 'closed' : 'disconnected'; tab.page = null; tab.controllerEpoch++; invalidate(tab);
      if (!tab.openerTabId || closed) { publish(tab); return; }
      // CDP 연결을 닫아도 네이티브 게스트는 남을 수 있다. 실제로 닫힌 팝업만 제거한다.
      void Promise.resolve().then(async () => {
        const retained = tab.nativeTargetId && (await selectedAdapter()?.inventory?.())?.some(entry => entry.nativeTargetId === tab.nativeTargetId);
        if (retained || closed || state !== 'ready') { publish(tab); return; }
        tab.status = 'closed'; tabs.delete(tab.tabId);
        emit('owned_browser_closed', { tabId: tab.tabId, openerTabId: tab.openerTabId, runtime: runtimeInfo() });
        await persist();
      }).catch(() => publish(tab));
    });
    if (selectedAdapter()?.bind) {
      const session = await runtime.context.newCDPSession(page);
      try { tab.nativeTargetId = (await session.send('Target.getTargetInfo')).targetInfo.targetId; }
      finally { await session.detach().catch(() => {}); }
      const nativeState = await selectedAdapter().bind({ targetId: tab.nativeTargetId, tabId: tab.tabId, sessionId: tab.sessionId, chatId: tab.threadId, global: tab.scope === 'global' });
      tab.nativeGeneration = nativeState?.generation;
      tab.zoomFactor = nativeState?.zoomFactor;
      await selectedAdapter().control?.(nativeControl(tab));
    }
  };

  /**
   * 모든 요청의 정책 판정(DESIGN §4·§5). 하위 GET 은 차단만 본다. 문서 탐색은 열람 판정을 받는다.
   * 에이전트 변경(POST 폼 탐색, 위험한 주소, 입력 창 안의 같은 사이트 non-GET)은 사이트 사용이 필요하다.
   * 주 프레임 거절은 'aborted' 로 끊어 탭이 원래 페이지에 머문다. 3xx 홉은 Playwright 경로에 오지 않으므로
   * 조작이 끝난 뒤 assertLanding 이 홉과 도착 주소를 판정한다.
   */
  const ownerForms = new WeakMap();
  /**
   * 조작이 끝난 뒤 도착한 주 프레임 주소와 거쳐 온 3xx 홉을 판정한다. 허용된 변경이 시작한 체인이면 차단만 본다.
   * 요청은 이미 서버에 닿았으므로 거절은 performed 다. 에이전트는 이 페이지를 읽지 못한다(다음 관찰도 같은 판정을 받는다).
   */
  const assertLanding = async (actor, tab) => {
    if (actor.isHuman || !policy?.check || !tab.page || tab.page.isClosed()) return;
    const urls = [...(tab.navHops ?? []), tab.page.url()];
    for (const url of urls) {
      if (!webOrigin(url)) continue;
      const decision = await policy.check({ actor, action: 'browse', url, profileId: profileId() });
      if (decision.allowed || (tab.changePermitted && decision.code !== 'BROWSER_SITE_BLOCKED')) continue;
      throw denialError(decision, actor, { performed: true });
    }
  };
  const routeRequest = async (route) => {
    const request = route.request();
    const abort = (reason = 'blockedbyclient') => route.abort(reason).catch(() => {});
    try {
      const url = request.url();
      if (url.startsWith('data:') || url === 'about:blank') { await route.continue(); return; }
      try { await guard.resolve(url); } catch { await abort(); return; }
      let page; try { page = request.frame().page(); } catch {}
      let tab = page && pageTabs.get(page);
      // 팝업의 첫 요청이 논리 탭 바인딩보다 먼저 도착해도 원래 탭의 정책을 적용한다.
      if (!tab && page) { const opener = await page.opener().catch(() => null); tab = opener && pageTabs.get(opener); }
      if (!tab || !policy?.check) { await route.continue(); return; }
      const actor = pageActor(tab);
      touchSite(url, actor.isHuman ? 'human' : 'agent');
      const method = request.method();
      const document = request.isNavigationRequest();
      let mainFrame = false; try { mainFrame = document && request.frame() === page.mainFrame(); } catch {}
      if (mainFrame) tab.documentEpoch = (tab.documentEpoch ?? 0) + 1;
      if (actor.isHuman) { await route.continue(); return; }
      const ask = (action, target = url, resource = 'document') => policy.check({ actor, action, url: target, profileId: profileId(), resource });
      const performed = false;
      const inWindow = !!tab.inputWindow && tab.inputWindow.documentEpoch === tab.documentEpoch && tab.inputWindow.agentId === actor.agentId;
      const browse = await ask('browse', url, document ? 'document' : 'subresource');
      if (!browse.allowed) {
        recordDenied(tab, browse, actor, { performed, fatal: mainFrame, method });
        await abort(mainFrame ? 'aborted' : undefined); return;
      }
      let change = false;
      if (document) change = nonGet(method) || (mainFrame && changesWebsiteURL(url));
      else if (nonGet(method)) {
        const pageUrl = page.url();
        const agentChange = inWindow && request.resourceType() !== 'ping' && !graphQLRead(request);
        if (agentChange && sameSite(url, pageUrl)) change = true;
        else {
          // 페이지 스크립트의 요청과 사이트 밖 잡요청: 차단된 사이트만 막는다. 입력 창 안의 사이트 밖 쓰기는 페이지 사이트의 승인을 따른다.
          const target = await ask('website-change');
          const crossSiteWrite = agentChange && !(await ask('website-change', pageUrl)).allowed;
          if (target.code === 'BROWSER_SITE_BLOCKED' || crossSiteWrite) { recordDenied(tab, target.allowed ? { ...target, code: 'BROWSER_PERMISSION_REQUIRED' } : target, actor, { fatal: false, method }); await abort(); return; }
        }
      }
      if (change) {
        const decision = await ask('website-change');
        if (!decision.allowed) {
          recordDenied(tab, decision, actor, { performed, fatal: mainFrame || inWindow, method });
          await abort(mainFrame ? 'aborted' : undefined); return;
        }
        // 허용된 변경이 일으킨 3xx 홉은 이 승인을 이어받는다(홉 사이트의 차단만 본다).
        if (document) tab.changePermitted = true;
      }
      await route.continue();
    } catch { await abort(); }
  };
  const ensureRuntime = async () => {
    if (closed) throw error('BROWSER_CLOSED', 'The browser service has closed.');
    if (resetting || resetFailed) throw error('BROWSER_RESET_REQUIRED', 'Complete browser cleanup in Settings before starting another browser.', true);
    if (signIn || handoffPending) throw error('BROWSER_SIGN_IN_ACTIVE', 'Complete sign-in in the full browser, then confirm the account in Browser settings.', true);
    if (starting) return starting;
    if (runtime && state === 'ready') return runtime;
    state = 'starting'; emit('owned_browser_runtime', { runtime: runtimeInfo() });
    starting = (async () => {
      try {
        if (runtime) { await runtime.close().catch(() => {}); runtime = null; }
        runtime = await runtimeFactory({ dataDir, guard, nativeAdapter: selectedAdapter(), headless, autoInstall: options.autoInstall !== false, onEvent: (progress) => emit('owned_browser_runtime', { runtime: { ...runtimeInfo(), ...progress } }) });
        // 서비스가 그 사이에 닫혔으면 막 뜬 브라우저를 남기지 않는다.
        if (closed) { await runtime.close().catch(() => {}); runtime = null; throw error('BROWSER_CLOSED', 'The browser service has closed.'); }
        generation++;
        let checkpoint;
        if (credentialBroker?.restoreCheckpoint) {
          checkpoint = await credentialBroker.restoreCheckpoint({ profileId: profileId() });
          if (checkpoint && !handoffProfile && !(selectedAdapter() && runtime.context.pages().length)) await runtime.context.setStorageState(checkpoint);
        }
        handoffProfile = false;
        await runtime.context.route('**/*', (route) => routeRequest(route));
        // 팝업 게스트는 논리 탭 없이 남지 않는다. 숨은 고아 창은 같은 이름의 window.open을 계속 삼킨다.
        const adoptPopup = async (page, parent) => {
          if (pageTabs.has(page) || page.isClosed()) return;
          if (!parent || tabs.size >= limits.maxTabs) { await page.close(); return; }
          // Pages created by popup scripts never gain another agent's binding.
          const tab = makeTab({ ...actorForTab(parent), scope: parent.scope }); tab.controller = { ...parent.controller }; tab.humanDriven = parent.humanDriven; tab.openerTabId = parent.tabId; tab.transient = parent.transient; tabs.set(tab.tabId, tab);
          try { await attach(tab, page); }
          catch (failure) {
            // 인증 보조 창은 CDP 바인딩이 끝나기 전에 스스로 닫힐 수 있다.
            tabs.delete(tab.tabId); pageTabs.delete(page);
            await page.close().catch(() => {}); await persist();
            throw failure;
          }
          if (page.isClosed() || tabs.get(tab.tabId) !== tab) return;
          const native = tab.nativeTargetId && (await selectedAdapter()?.inventory?.())?.find((entry) => entry.nativeTargetId === tab.nativeTargetId);
          if (page.isClosed() || tabs.get(tab.tabId) !== tab) return;
          if (!tab.system) emit('owned_browser_popup', { tab: descriptor(tab), openerTabId: parent.tabId, foreground: native?.disposition !== 'background-tab', runtime: runtimeInfo() });
          void persist();
        };
        let adopted; const adoption = new Promise((resolve) => { adopted = resolve; });
        runtime.context.on('page', (page) => {
          // 재연결 중 열린 팝업은 원래 탭을 다시 붙인 뒤에 판정한다.
          void adoption.then(() => page.opener()).then((opener) => opener ? adoptPopup(page, pageTabs.get(opener)) : undefined).catch(() => {});
        });
        try {
          const nativeInventory = await selectedAdapter()?.inventory?.() ?? [];
          const unclaimed = [];
          if (selectedAdapter()) for (const page of runtime.context.pages()) {
            const session = await runtime.context.newCDPSession(page);
            let targetId;
            try { targetId = (await session.send('Target.getTargetInfo')).targetInfo.targetId; }
            finally { await session.detach().catch(() => {}); }
            const native = nativeInventory.find((tab) => tab.nativeTargetId === targetId);
            const retained = tabs.get(native?.tabId) ?? [...tabs.values()].find((tab) => tab.nativeTargetId === targetId);
            if (retained) { retained.controller = { owner: retained.scope === 'global' ? 'human' : 'agent' }; retained.humanDriven = false; retained.controllerEpoch++; retained.status = 'ready'; await attach(retained, page); retained.restorePending = false; publish(retained); }
            else unclaimed.push({ page, native });
          }
          // 허브 연결이 끊긴 동안 열린 팝업은 'page' 이벤트 없이 기존 페이지로 나타난다.
          for (const { page, native } of unclaimed) {
            const opener = await page.opener().catch(() => null);
            if (!opener && !native?.openerTargetId) continue;
            const parent = (opener && pageTabs.get(opener)) ?? [...tabs.values()].find((tab) => tab.page && !tab.page.isClosed() && native?.openerTargetId && tab.nativeTargetId === native.openerTargetId);
            await adoptPopup(page, parent).catch(() => {});
          }
        } finally { adopted(); }
        const observedRuntime = runtime;
        runtime.browser?.on('disconnected', () => {
          if (closed || runtime !== observedRuntime) return;
          state = 'disconnected';
          for (const tab of tabs.values()) { tab.status = 'disconnected'; tab.controllerEpoch++; invalidate(tab); tab.page = null; publish(tab); }
          credentialBroker?.invalidateRuntime?.(generation);
          emit('owned_browser_runtime', { runtime: runtimeInfo() });
        });
        if (credentialBroker?.saveCheckpoint) { clearInterval(checkpointTimer); checkpointTimer = setInterval(() => { void saveCheckpoint().catch(() => {}); }, 30_000); checkpointTimer.unref?.(); }
        state = 'ready';
        // 시작할 때 쿠키가 있는 사이트를 읽는다. 체크포인트가 없거나 쿠키가 많아도 결정은 바뀌지 않는다.
        await refreshCookieSites({ force: true });
        emit('owned_browser_runtime', { runtime: runtimeInfo() });
        return runtime;
      } catch (failure) {
        const failedRuntime = runtime;
        state = 'failed'; runtime = null;
        // 초기화 중 실패해도 해당 연결을 닫아 다음 시작이 같은 CDP 소유자와 충돌하지 않게 한다.
        await failedRuntime?.close().catch(() => {});
        const lines = String(failure?.message ?? failure).split('\n');
        const summary = lines[0].includes('Error setting storage state:') ? lines.slice(0, 2).join(' ') : lines[0];
        const reason = summary.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/gi, '[private endpoint]').replace(/\/browser\/[a-zA-Z0-9_-]+/g, '/browser/[private]').slice(0, 400);
        console.error('[owned-browser-service] startup failed', JSON.stringify({ phase: failedRuntime ? 'setup' : 'connect', code: failure.code ?? 'BROWSER_START_FAILED', reason }));
        emit('owned_browser_runtime', { runtime: { ...runtimeInfo(), error: { code: failure.code ?? 'BROWSER_START_FAILED', message: failure.message } } }); throw failure;
      }
      finally { starting = null; }
    })();
    return starting;
  };
  const makeTab = (input) => { const global = input.isHuman || input.scope === 'global'; const actor = global ? { ...input, threadId: null, projectId: null, documentId: null, agentId: 'human', taskId: null } : input; return ({ lastActivityAt: Date.now(), scope: global ? 'global' : 'agent', tabId: id('tab'), threadId: actor.threadId ?? null, projectId: actor.projectId ?? null, documentId: actor.documentId ?? null, agentId: actor.agentId ?? 'human', ownerId: actor.ownerId, sessionId: actor.sessionId, taskId: actor.taskId, ...(SYSTEM_ACTORS.has(actor.system) ? { system: actor.system } : {}), url: 'about:blank', title: '', status: 'ready', page: null, navigationEpoch: 0, controllerEpoch: 1, controller: { owner: global ? 'human' : 'agent' }, queue: Promise.resolve(), heldKeys: new Set(), heldButtons: new Set(), snapshot: null, frame: null }); };
  const beginHandoff = async ({ url, authenticationMethod, accountId, site = null, onWindowsClosed }) => {
    handoffPreviousMode = runtimeMode;
    handoffPending = true;
    // 사이트는 처음부터 기록한다. 앱 브라우저를 멈추는 사이에 눌린 취소도 이 로그인을 찾는다.
    signInSite = site ? { domain: site, url } : null;
    try {
      let resolveHandoff; handoffPromise = new Promise((resolve) => { resolveHandoff = resolve; });
      try {
        if (starting) await starting;
        clearInterval(checkpointTimer);
        if (runtime) { await saveCheckpoint().catch(() => {}); await runtime.close(); runtime = null; }
        await credentialBroker?.deleteCheckpoint?.({ profileId: 'default' });
        for (const tab of tabs.values()) { tab.page = null; tab.status = 'disconnected'; tab.controllerEpoch++; tab.controller = { owner: tab.scope === 'global' ? 'human' : 'agent' }; invalidate(tab); }
        runtimeMode = 'managed'; state = 'sign-in'; signInAccountId = accountId;
        const start = options.signInFactory ?? startOwnedBrowserSignIn;
        signIn = await start({ dataDir, url, authenticationMethod, autoInstall: options.autoInstall !== false, onExit: () => emit('owned_browser_runtime', { runtime: runtimeInfo() }), ...(onWindowsClosed ? { onWindowsClosed } : {}) });
      } finally { resolveHandoff(); handoffPromise = null; }
    } catch (failure) {
      siteCancelRequested = false;
      signInAccountId = null; signInSite = null; handoffPending = false; runtimeMode = handoffPreviousMode ?? runtimeMode; handoffPreviousMode = null; state = 'idle';
      await ensureRuntime().catch(() => {});
      throw failure;
    }
    finally { handoffPending = false; }
    emit('owned_browser_runtime', { runtime: runtimeInfo() });
    if (site && siteCancelRequested) { siteCancelRequested = false; void finishSiteSignIn({ importSession: false }).catch(() => {}); }
  };
  /** Chrome을 닫고 네이티브 브라우저로 돌아온다. importSession이면 그 사이트의 로그인만 가져온다. 여러 번 불러도 한 번만 돈다. */
  const finishSiteSignIn = ({ importSession }) => {
    if (siteFinish) return siteFinish;
    // 끝난 뒤 늦게 온 'Chrome 닫힘'이나 서비스 종료 뒤의 신호는 아무것도 바꾸지 않는다.
    if (!signInSite || closed) return Promise.resolve(null);
    const site = signInSite;
    // 취소는 Chrome이 뜨기를 기다리지 않는다. 뜬 뒤 beginHandoff가 바로 닫는다.
    if (handoffPending && !importSession) { siteCancelRequested = true; return Promise.resolve(site); }
    siteFinish = (async () => {
      let imported = false;
      try {
        // Chrome이 아직 뜨는 중이면(바로 취소한 경우) 뜬 뒤에 닫는다.
        if (handoffPromise) await handoffPromise;
        // Chrome을 닫지 못하면 로그인을 연 채로 둔다. 사용자가 다시 완료하거나 취소할 수 있다.
        if (signIn) { await signIn.close(); signIn = null; signInAccountId = null; }
        if (importSession && !closed) {
          handoffProfile = true; state = 'idle';
          await ensureRuntime();
          // IndexedDB는 옮기지 않으므로 읽지 않는다. 큰 사이트(claude.ai)에서 읽는 데만 몇 초가 걸린다.
          await returnFromSignIn({ site: site.domain }, await runtime.context.storageState());
          await policy?.markSignedIn?.({ profileId: 'native', domain: site.domain, source: 'handoff' });
          imported = true;
        }
        return site;
      } catch (failure) {
        emit('owned_browser_sign_in', { site: site.domain, ok: false, code: failure?.code ?? 'BROWSER_SITE_SIGN_IN_FAILED' });
        throw failure;
      } finally {
        if (!signIn) {
          // Chrome이 닫혔으면 성공·실패와 상관없이 네이티브 브라우저로 되돌린다.
          handoffPreviousMode = null; handoffProfile = false;
          if (!closed && runtimeMode !== 'native') { await runtime?.close().catch(() => {}); runtime = null; state = 'idle'; runtimeMode = 'native'; await ensureRuntime().catch(() => {}); }
          // 앱 브라우저가 돌아온 뒤에야 로그인이 끝난 것으로 알린다. 그 전의 상태 알림은 진행 중으로 남는다.
          signInSite = null;
        }
        siteFinish = null;
        emit('owned_browser_runtime', { runtime: runtimeInfo() });
        if (imported) emit('owned_browser_sign_in', { site: site.domain, ok: true });
      }
    })();
    return siteFinish;
  };
  const returnFromSignIn = async (account, storage) => {
    // 사이트 로그인은 등록 도메인과 그 하위 호스트의 쿠키·저장소를 돌려받는다. IndexedDB는 옮길 수 없어 뺀다.
    const underSite = (host) => !!account.site && (host === account.site || host.endsWith(`.${account.site}`));
    const siteOrigins = account.site ? [...new Set([...storage.cookies.map((cookie) => `https://${String(cookie.domain).replace(/^\./, '').toLowerCase()}`), ...storage.origins.map((entry) => entry.origin)])]
      .filter((origin) => { try { const url = new URL(origin); return url.protocol === 'https:' && underSite(url.hostname); } catch { return false; } }).slice(0, 32) : null;
    if (siteOrigins && !siteOrigins.length) throw error('BROWSER_SITE_SIGN_IN_EMPTY', 'Chrome did not keep a session for this website. Sign in there, then finish again.', true);
    const origins = new Set(siteOrigins ?? account.origins);
    const hosts = [...origins].map((origin) => new URL(origin).hostname);
    const matchesApprovedHost = (cookie) => {
      const domain = cookie.domain.replace(/^\./, '').toLowerCase();
      return hosts.some((host) => host === domain || cookie.domain.startsWith('.') && host.endsWith(`.${domain}`));
    };
    // 사이트 로그인은 그 등록 도메인 아래의 쿠키만 옮긴다. 상위 도메인(.example) 쿠키는 다른 사이트와 나눠 쓰는 것이다.
    const insideSite = (cookie) => !account.site || underSite(String(cookie.domain).replace(/^\./, '').toLowerCase());
    const approved = { cookies: storage.cookies.filter((cookie) => matchesApprovedHost(cookie) && insideSite(cookie)), origins: storage.origins.filter((entry) => origins.has(entry.origin)).map((entry) => account.site ? { origin: entry.origin, localStorage: entry.localStorage ?? [] } : entry) };
    clearInterval(checkpointTimer);
    await runtime.close(); runtime = null; state = 'idle'; runtimeMode = 'native';
    // 사이트 로그인은 네이티브 체크포인트를 그 사이트만으로 덮지 않는다. 끝에서 전체 상태를 다시 저장한다.
    if (!account.site) await credentialBroker.saveCheckpoint?.({ profileId: 'native', state: approved });
    await ensureRuntime();
    // 유지된 네이티브 게스트는 자동 체크포인트 복원을 건너뛰므로 승인된 세션을 직접 병합한다.
    const adapter = selectedAdapter();
    if (adapter?.importSession) {
      // 메인 프로세스가 승인된 사이트만 갱신한다. 보호된 탭의 숨겨진 저장소는 읽거나 지우지 않는다.
      // 열린 탭이 없는 출처의 localStorage는 네이티브 쪽에서 쓸 곳이 없다. 사이트 로그인은 그 항목을 건너뛴다.
      const openOrigins = new Set([...tabs.values()].flatMap((tab) => { try { return tab.page && !tab.page.isClosed() ? [new URL(tab.page.url()).origin] : []; } catch { return []; } }));
      const imported = account.site ? { cookies: approved.cookies, origins: approved.origins.filter((entry) => openOrigins.has(entry.origin)) } : approved;
      await adapter.importSession({ origins: [...origins], state: imported, reload: true });
    } else {
      if (await adapter?.passwordStorageState?.()) throw error('BROWSER_NATIVE_SESSION_IMPORT_UNAVAILABLE', 'Reconnect the desktop browser before restoring this sign-in.', true);
      const retained = await browserStorageState();
      const merged = { cookies: [...retained.cookies.filter((entry) => !matchesApprovedHost(entry)), ...approved.cookies],
        origins: [...retained.origins.filter((entry) => !origins.has(entry.origin)), ...approved.origins] };
      await runtime.context.setStorageState(merged);
    }
    await refreshCookieSites({ force: true });
    for (const tab of tabs.values()) {
      if (!tab.page || tab.page.isClosed()) { tab.restorePending = true; continue; }
      if (!adapter?.importSession && origins.has(new URL(tab.page.url()).origin)) {
        await tab.page.reload({ waitUntil: 'domcontentloaded' }); tab.status = 'ready';
      }
      publish(tab);
    }
    await persist(); await saveCheckpoint();
    emit('owned_browser_runtime', { runtime: runtimeInfo() });
  };
  const requirePage = (tab) => { if (!tab.page || tab.page.isClosed()) throw error('BROWSER_RECONNECT_REQUIRED', 'The browser page disconnected. Recover it before sending input.', true); return tab.page; };
  const saveCheckpoint = () => {
    if (resetting || resetFailed) return Promise.resolve();
    const result = checkpointQueue.catch(() => {}).then(async () => {
      if (resetting || resetFailed || !runtime || state !== 'ready') return;
      await refreshCookieSites();
      if (credentialBroker?.saveCheckpoint && !resetting && !resetFailed) await credentialBroker.saveCheckpoint({ profileId: profileId(), state: await browserStorageState() });
    });
    checkpointQueue = result.catch(() => {}); return result;
  };
  credentialBroker?.setDataResetter?.(async ({ phase }) => {
    if (phase === 'before') {
      resetting = true; clearInterval(checkpointTimer);
      if (starting) await starting.catch(() => {});
      if (handoffPromise) await handoffPromise.catch(() => {});
      for (const tab of tabs.values()) { tab.controllerEpoch++; invalidate(tab); }
      await Promise.all([...tabs.values()].map((tab) => tab.queue.catch(() => {})));
      await checkpointQueue; await cookieRefresh; await persistQueue.catch(() => {});
      await signIn?.close(); signIn = null; signInAccountId = null;
      for (const tab of tabs.values()) await releaseInput(tab);
      await runtime?.close(); runtime = null;
      const nativeReset = await nativeAdapter?.reset?.();
      tabs.clear(); handoffProfile = false; state = 'resetting';
      await favicons.clear(); await history.clear();
      await removeOwnedBrowserState({ dataDir, nativeStorageCleared: nativeReset?.nativeStorageCleared === true });
    } else if (phase === 'after') { resetting = false; resetFailed = false; state = 'idle'; emit('owned_browser_runtime', { runtime: runtimeInfo(), tabs: [] }); }
    else { resetting = false; resetFailed = true; state = 'failed'; emit('owned_browser_runtime', { runtime: runtimeInfo() }); }
  });
  credentialBroker?.setSessionClearer?.(async ({ profileId: targetProfile, origins }) => {
    if (!['default', 'native'].includes(targetProfile)) throw error('BROWSER_PROFILE_NOT_ACTIVE', 'This browser account profile is unavailable.');
    await ensureRuntime();
    const clearing = targetProfile === profileId() ? runtime : await runtimeFactory({ dataDir, guard, nativeAdapter: targetProfile === 'native' ? nativeAdapter : undefined, headless: true, autoInstall: false });
    try {
    if (targetProfile === 'native' && nativeAdapter?.importSession) {
      await nativeAdapter.importSession({ origins, state: { cookies: [], origins: [] }, clear: true });
      for (const tab of tabs.values()) { invalidate(tab); tab.controllerEpoch++; publish(tab); }
      if (clearing === runtime) await refreshCookieSites({ force: true });
      return { clearedOrigins: origins };
    }
    const hosts = origins.map((origin) => new URL(origin).hostname);
    const cookies = await clearing.context.cookies();
    const domains = [...new Set(cookies.map((cookie) => cookie.domain).filter((raw) => { const domain = raw.replace(/^\./, ''); return hosts.some((host) => host === domain || host.endsWith(`.${domain}`)); }))];
    for (const domain of domains) await clearing.context.clearCookies({ domain });
    const storage = await clearing.context.storageState({ indexedDB: true });
    const clearedOrigins = [...new Set([...origins, ...storage.origins.map((entry) => entry.origin).filter((origin) => domains.some((raw) => { const domain = raw.replace(/^\./, ''), host = new URL(origin).hostname; return host === domain || host.endsWith(`.${domain}`); }))])];
    for (const origin of clearedOrigins) {
      const page = await clearing.context.newPage();
      const session = await clearing.context.newCDPSession(page);
      try { await session.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' }); }
      finally { await session.detach().catch(() => {}); await page.close().catch(() => {}); }
    }
    for (const tab of tabs.values()) { invalidate(tab); tab.controllerEpoch++; publish(tab); }
    if (clearing === runtime) await refreshCookieSites({ force: true });
    return { clearedDomains: domains.map((domain) => domain.replace(/^\./, '')), clearedOrigins };
    } finally { if (clearing !== runtime) await clearing.close(); }
  });
  // 네이티브 ref는 요소 정보를, 관리형 ref는 개요의 역할·이름을 돌려준다. 요소 자체는 elementFor로 찾는다.
  const requireRef = (tab, args) => {
    if (!args.snapshotId || args.snapshotId !== tab.snapshot?.snapshotId || !args.ref) throw error('BROWSER_STALE_REFERENCE', 'Take a new snapshot and use one of its element references.', true);
    const entry = (tab.snapshot.native ? tab.snapshot.handles : tab.snapshot.refs).get(String(args.ref));
    if (!entry) throw error('BROWSER_REFERENCE_NOT_FOUND', 'The element reference is not in the current snapshot.');
    return entry;
  };
  // 관리형 ref는 마지막 aria 관찰에서 요소를 찾는다. 사라진 요소는 시간 제한까지 기다리지 않고 바로 알린다.
  const elementFor = async (tab, args) => {
    const entry = requireRef(tab, args);
    if (tab.snapshot.native) return entry;
    const snapshotId = tab.snapshot.snapshotId;
    const cached = tab.snapshot.handles.get(String(args.ref));
    if (cached) return cached;
    const handle = await requirePage(tab).getByRef(String(args.ref)).elementHandle({ timeout: 1000 }).catch(() => null);
    if (!handle) throw error('BROWSER_TARGET_DETACHED', 'The target element is gone. Take a new snapshot before retrying.', true);
    if (tab.snapshot?.snapshotId !== snapshotId) { void handle.dispose().catch(() => {}); throw error('BROWSER_STALE_REFERENCE', 'Take a new snapshot and use one of its element references.', true); }
    tab.snapshot.handles.set(String(args.ref), handle);
    return handle;
  };
  // 모델에는 개요만 보낸다. 정책·계정 입력에 필요한 요소 정보는 tab.snapshot 안에만 둔다.
  const observation = (tab, base, tree, view, partial = false) => {
    const rendered = renderOutline(tree, { scope: view.scope, find: view.find });
    const result = { ...base, tabId: tab.tabId, controllerEpoch: tab.controllerEpoch, outline: rendered.outline, ...(rendered.truncated || partial ? { truncated: true, hint: OUTLINE_HINT } : {}), ...(view.find ? { matches: rendered.matches } : {}) };
    return { result, rendered };
  };
  const scopeMissing = () => error('BROWSER_REFERENCE_NOT_FOUND', 'The scope reference is not on the current page. Take a new snapshot.');
  const snapshot = async (tab, accept = () => true, view = {}) => {
    invalidate(tab);
    const navigationEpoch = tab.navigationEpoch;
    const geometryEpoch = tab.geometryEpoch;
    if (selectedAdapter()?.passwordSnapshot && tab.nativeTargetId) {
      const raw = await selectedAdapter().passwordSnapshot({ ...nativePasswordBinding(tab), ...(view.text ? { text: true } : {}) });
      const observed = raw?.available === false || !filledSecrets.size ? raw : redactValues(raw, protectedFor(tab));
      if (observed?.available !== false) {
        if (navigationEpoch !== tab.navigationEpoch) throw error('BROWSER_STALE_NAVIGATION', 'The page changed while it was observed. Take a new snapshot.', true);
        if (geometryEpoch !== tab.geometryEpoch) throw error('BROWSER_STALE_GEOMETRY', 'Page zoom changed while it was observed. Take a new snapshot.', true);
        if (!accept()) throw error('BROWSER_ACTION_TIMEOUT', 'The browser wait timed out before its observation completed.', true);
        const { result, rendered } = observation(tab, { snapshotId: observed.snapshotId, navigationEpoch, url: observed.url, title: observed.title }, observed.tree, view, observed.truncated === true);
        tab.snapshot = { snapshotId: observed.snapshotId, url: observed.url, title: observed.title, passwordProtected: observed.passwordProtected, viewport: observed.viewport, native: true, elements: observed.elements, handles: new Map(observed.elements.map((element) => [element.ref, { ...element, native: true }])), refs: rendered.refs, lines: rendered.all };
        if (observed.passwordProtected) forgetVisit(tab);
        if (view.scope && !rendered.scoped) throw scopeMissing();
        return { ...result, ...(observed.passwordProtected ? { passwordProtected: true } : {}), ...(view.text ? { text: observed.text ?? '' } : {}) };
      }
    }
    const page = tab.page;
    const sensitive = page.locator(SENSITIVE);
    const fields = await sensitive.elementHandles();
    tab.protectedValues ??= new Set();
    for (const field of fields) {
      // 페이지가 바꾼 프로토타입을 읽지 않도록 격리된 선택 엔진을 사용한다.
      const value = await field.inputValue().catch(() => '');
      if (value) tab.protectedValues.add(value);
    }
    for (const field of fields) void field.dispose().catch(() => {});
    // 같은 요소는 다음 aria 관찰에서도 같은 ref를 받는다. 비공개 칸의 ref를 먼저 모아 값이 바뀌어도 가린다.
    const masked = new Set(); const extra = new Map();
    const refsOf = async (locator, nested, found = (ref) => masked.add(ref)) => {
      const visit = (node) => { if (!node || typeof node !== 'object') return; if (node.ref) found(node.ref); if (nested) for (const child of node.children ?? []) visit(child); };
      for (const node of await locator.ariaSnapshotJSON({ mode: 'ai', timeout: 1000 }).catch(() => [])) visit(node);
    };
    const maskAll = fields.length > 24;
    if (!maskAll) for (let index = 0; index < fields.length; index++) await refsOf(sensitive.nth(index), true);
    const editable = page.locator(EDITABLE);
    const editableCount = Math.min(24, await editable.count().catch(() => 0));
    for (let index = 0; index < editableCount; index++) await refsOf(editable.nth(index), false, (ref) => extra.set(ref, 'textbox'));
    // 마지막 관찰이 getByRef 기준이 되므로 페이지 전체 관찰은 맨 뒤에 한다.
    const tree = await page.ariaSnapshotJSON({ mode: 'ai', timeout: 10_000 }).catch((failure) => {
      if (navigationEpoch !== tab.navigationEpoch) throw error('BROWSER_STALE_NAVIGATION', 'The page changed while it was observed. Take a new snapshot.', true);
      throw failure;
    });
    const content = view.text ? await page.locator('body').innerText({ timeout: 3000 }).catch(() => '') : undefined;
    const selectedText = protectedFor(tab).size ? '' : await page.evaluate((selector) => {
      if (document.activeElement?.matches(selector)) return '';
      const selection = window.getSelection();
      if (!selection) return '';
      for (let index = 0; index < selection.rangeCount; index++) {
        const range = selection.getRangeAt(index);
        for (const el of document.querySelectorAll(selector)) if (range.intersectsNode(el)) return '';
      }
      return String(selection).slice(0, 16_000);
    }, SENSITIVE);
    if (navigationEpoch !== tab.navigationEpoch) throw error('BROWSER_STALE_NAVIGATION', 'The page changed while it was observed. Take a new snapshot.', true);
    if (geometryEpoch !== tab.geometryEpoch) throw error('BROWSER_STALE_GEOMETRY', 'Page zoom changed while it was observed. Take a new snapshot.', true);
    if (!accept()) throw error('BROWSER_ACTION_TIMEOUT', 'The browser wait timed out before its observation completed.', true);
    const snapshotId = id('snapshot');
    // find 일치 수로 비밀 값을 떠볼 수 없도록 그리기 전에 가린다.
    const { result, rendered } = observation(tab, { snapshotId, navigationEpoch, url: publicURL(page.url()), title: tab.title }, outlineFromAria(redactValues(tree, protectedFor(tab)), { masked, extra, maskAll }), view);
    const redacted = redactValues({ ...result, ...(content !== undefined ? { text: text(content, 24_000) } : {}), ...(selectedText ? { selectedText } : {}) }, protectedFor(tab));
    tab.snapshot = { snapshotId, url: redacted.url, title: redacted.title, handles: new Map(), masked, refs: rendered.refs, lines: rendered.all };
    if (view.scope && !rendered.scoped) throw scopeMissing();
    return redacted;
  };
  const viewportInfo = async (tab) => {
    // 비밀번호 보호 탭에서는 일반 CDP 평가가 금지된다. 네이티브 관찰을 사용한다.
    if (selectedAdapter()?.passwordSnapshot && tab.nativeTargetId) {
      const adapter = selectedAdapter();
      const observed = await (adapter.passwordViewport ?? adapter.passwordSnapshot)(nativePasswordBinding(tab));
      if (observed?.viewport) return observed.viewport;
    }
    return tab.snapshot?.native ? tab.snapshot.viewport : tab.page.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio, scrollX, scrollY }));
  };
  const screenshot = async (tab, rect, humanPreview = false) => {
    if (selectedAdapter()?.passwordCapture && tab.nativeTargetId) {
      const captured = await selectedAdapter().passwordCapture({ ...nativePasswordBinding(tab), rect });
      if (captured?.data) {
        if (Buffer.byteLength(captured.data, 'base64') > limits.maxFrameBytes) throw error('BROWSER_FRAME_TOO_LARGE', 'The captured browser frame exceeds the size limit.');
        return captured.data;
      }
    }
    if (tab.snapshot?.passwordProtected) throw error('BROWSER_PASSWORD_CAPTURE_PROTECTED', 'The page contains a saved password. Use a semantic snapshot for page evidence.');
    const lifetime = humanPreview ? undefined : await assertImageAllowed(tab);
    const masks = tab.page.frames().map((frame) => frame.locator(SENSITIVE));
    const bytes = await tab.page.screenshot({ type: 'jpeg', quality: 75, fullPage: false, mask: masks, maskColor: '#333333', ...(rect ? { clip: rect } : {}), timeout: 10_000 });
    const currentLifetime = humanPreview ? undefined : await assertImageAllowed(tab);
    if (lifetime?.zoomFactor !== currentLifetime?.zoomFactor) throw error('BROWSER_STALE_GEOMETRY', 'Page zoom changed during capture. Capture the current page again.', true);
    if (lifetime?.navigationEpoch !== currentLifetime?.navigationEpoch) throw error('BROWSER_STALE_NAVIGATION', 'The page changed during capture. Capture the current page again.', true);
    if (JSON.stringify(lifetime) !== JSON.stringify(currentLifetime)) throw error('BROWSER_STALE_FRAME', 'The page changed during capture. Capture the current page again.', true);
    if (bytes.length > limits.maxFrameBytes) throw error('BROWSER_FRAME_TOO_LARGE', 'The captured browser frame exceeds the size limit.');
    return bytes.toString('base64');
  };
  const frame = async (tab, actor) => {
    const epoch = tab.navigationEpoch;
    const geometryEpoch = tab.geometryEpoch;
    const viewport = await viewportInfo(tab);
    // 사용자의 화면 표시는 유지하고, 모델로 보내는 이미지 증거만 비밀 값에서 차단한다.
    const data = await screenshot(tab, undefined, actor.isHuman === true && !tab.nativeTargetId);
    if (epoch !== tab.navigationEpoch) throw error('BROWSER_STALE_NAVIGATION', 'The page changed during capture. Request another frame.', true);
    if (geometryEpoch !== tab.geometryEpoch) throw error('BROWSER_STALE_GEOMETRY', 'Page zoom changed during capture. Request another frame.', true);
    const result = { frameId: id('frame'), tabId: tab.tabId, navigationEpoch: epoch, controllerEpoch: tab.controllerEpoch, mimeType: 'image/jpeg', data, ...viewport };
    tab.frame = { ...result, data: undefined };
    return result;
  };

  const assertImageAllowed = async (tab) => {
    if (!selectedAdapter()?.passwordSnapshot || !tab.nativeTargetId) {
      tab.protectedValues ??= new Set();
      for (const frame of tab.page.frames()) {
        const fields = await frame.locator(SENSITIVE).elementHandles();
        try { for (const field of fields) { const value = await field.inputValue().catch(() => ''); if (value) tab.protectedValues.add(value); } }
        finally { for (const field of fields) await field.dispose(); }
      }
      if (tab.protectedValues.size || await pageShowsFilledSecret(tab.page)) throw error('BROWSER_PASSWORD_CAPTURE_PROTECTED', 'The page contains private sign-in data. Use a semantic snapshot for page evidence.');
      return;
    }
    const adapter = selectedAdapter();
    const observed = await (adapter.passwordViewport ?? adapter.passwordSnapshot)({ ...nativePasswordBinding(tab), ...(filledSecrets.size ? { protectedValues: [...filledSecrets] } : {}) });
    if (observed?.passwordProtected) throw error('BROWSER_PASSWORD_CAPTURE_PROTECTED', 'The page contains a saved password. Use a semantic snapshot for page evidence.');
    return observed?.available === false ? undefined : { navigationEpoch: observed.nativeNavigationEpoch, controlEpoch: observed.nativeControlEpoch, zoomFactor: observed.zoomFactor };
  };
  const input = async (tab, args) => {
    if (args.type === 'release') { await releaseInput(tab); return { completed: true }; }
    if (args.frameId && args.frameId !== tab.frame?.frameId) throw error('BROWSER_STALE_FRAME', 'The displayed browser frame is stale.', true);
    const x = bounded(args.x, 0, 1919, 0), y = bounded(args.y, 0, 1079, 0);
    if (args.type === 'pointer') {
      const button = ['left', 'middle', 'right'].includes(args.button) ? args.button : 'left';
      await tab.page.mouse.move(x, y);
      if (args.event === 'down') { await tab.page.mouse.down({ button }); tab.heldButtons.add(button); }
      else if (args.event === 'up') { await tab.page.mouse.up({ button }); tab.heldButtons.delete(button); }
      else if (args.event === 'click') await tab.page.mouse.click(x, y, { button });
    } else if (args.type === 'wheel') await tab.page.mouse.wheel(bounded(args.deltaX, -2000, 2000, 0), bounded(args.deltaY, -2000, 2000, 0));
    else if (args.type === 'text' || args.type === 'composition') { if (args.type === 'text' || args.event === 'end') await tab.page.keyboard.insertText(text(args.text, 16_000)); }
    else if (args.type === 'key') {
      const key = text(args.key, 80);
      if (args.event === 'down') { await tab.page.keyboard.down(key); tab.heldKeys.add(key); }
      else if (args.event === 'up') { await tab.page.keyboard.up(key); tab.heldKeys.delete(key); }
      else await tab.page.keyboard.press(key);
    } else throw error('BROWSER_INPUT_INVALID', 'Unsupported browser input event.');
    return { completed: true };
  };

  const capture = async (actor, tab, args) => {
    if (args.frameId && args.frameId !== tab.frame?.frameId) throw error('BROWSER_STALE_FRAME', 'The displayed browser frame is stale.', true);
    const epoch = tab.navigationEpoch;
    const geometryEpoch = tab.geometryEpoch;
    const viewport = await viewportInfo(tab);
    const result = { captureId: id('capture'), tabId: tab.tabId, threadId: actor.isHuman ? args.destinationThreadId ?? tab.threadId : tab.threadId, projectId: tab.projectId, documentId: tab.documentId, navigationEpoch: epoch, source: { url: publicURL(tab.page.url()), title: tab.title, timestamp: new Date().toISOString() }, viewport, mode: args.mode ?? (args.ref ? 'element' : args.rect || args.region ? 'region' : 'page'), comment: text(args.comment) };
    let rect = args.rect ?? args.region;
    if (result.mode === 'element') {
      const handle = args.ref ? await elementFor(tab, args) : await tab.page.evaluateHandle(({ x, y }) => document.elementFromPoint(x, y), { x: Number(args.point?.x) || 0, y: Number(args.point?.y) || 0 });
      result.element = handle.native ? { tag: handle.tag, role: handle.role, name: handle.name, text: handle.text, rect: handle.rect } : await handle.evaluate((el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') ?? '', name: (el.getAttribute('aria-label') ?? '').slice(0, 500), text: el.matches('input') ? '[masked]' : String(el.textContent ?? '').slice(0, 2000), rect: { x: r.x, y: r.y, width: r.width, height: r.height } }; });
      if (!args.ref) await handle.dispose();
      if (!result.element) throw error('BROWSER_ELEMENT_NOT_FOUND', 'No page element was found at this point.');
      rect = result.element.rect;
    }
    if (rect) {
      const x = bounded(rect.x, 0, viewport.width, 0), y = bounded(rect.y, 0, viewport.height, 0);
      const width = bounded(rect.width, 1, viewport.width - x, 1), height = bounded(rect.height, 1, viewport.height - y, 1);
      if (width < 1 || height < 1) throw error('BROWSER_CAPTURE_REGION_INVALID', 'Select a region inside the browser page.');
      result.rect = { x, y, width, height };
    }
    try { result.screenshot = { mimeType: 'image/jpeg', data: await screenshot(tab, result.rect), width: result.rect?.width ?? viewport.width, height: result.rect?.height ?? viewport.height }; }
    catch (failure) { result.screenshotError = { code: failure.code?.startsWith('BROWSER_') ? failure.code : 'BROWSER_CAPTURE_IMAGE_FAILED', message: failure.code?.startsWith('BROWSER_') ? failure.message : 'The screenshot failed. The annotation and page evidence were retained.' }; }
    if (epoch !== tab.navigationEpoch) throw error('BROWSER_STALE_NAVIGATION', 'The page changed during annotation. Capture the current page again.', true);
    if (geometryEpoch !== tab.geometryEpoch) throw error('BROWSER_STALE_GEOMETRY', 'Page zoom changed during annotation. Capture the current page again.', true);
    return result;
  };

  const assertAgentKey = (actor, key) => {
    if (actor.isHuman) return;
    const value = String(key ?? '');
    const navigation = ['Enter', 'Space', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
    const allowed = navigation.includes(value) || /^[A-Za-z0-9]$/.test(value) || ['Shift+Tab', 'Control+a', 'Meta+a', 'ControlOrMeta+a'].includes(value);
    if (!allowed) throw error('BROWSER_SHORTCUT_BLOCKED', 'Use browser navigation and input tools. Clipboard and browser-window shortcuts are reserved for human control.');
  };

  const waitForCondition = async (actor, tab, args, signal) => {
    const page = requirePage(tab);
    const runtimeGeneration = generation;
    const condition = args.condition ?? 'ready';
    const needle = typeof args.text === 'string' ? args.text.trim() : '';
    if (!['ready', 'idle', 'visible', 'text'].includes(condition)) throw error('BROWSER_WAIT_INVALID', 'Choose ready, idle, visible or text.');
    if (condition === 'text' && !needle) throw error('BROWSER_WAIT_TEXT_REQUIRED', 'Text waits require nonempty text.');
    const deadline = args.waitDeadline ?? Date.now() + bounded(args.timeoutMs, 1, 30_000, 10_000);
    const read = async operation => {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw error('BROWSER_ACTION_TIMEOUT', 'The browser wait timed out.', true);
      let timer;
      try {
        return await abortable(Promise.race([operation(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(error('BROWSER_ACTION_TIMEOUT', 'The browser wait timed out.', true)), Math.max(1, deadline - Date.now()));
        })]), signal);
      } finally { clearTimeout(timer); }
    };
    const observe = () => read(() => snapshot(tab, () => Date.now() <= deadline && generation === runtimeGeneration && !signal?.aborted, { find: args.find }));
    let settledSince;
    let observedEpoch;
    do {
      signal?.throwIfAborted();
      if (generation !== runtimeGeneration || resetting || resetFailed || ownedTab(actor, tab.tabId) !== tab || requirePage(tab) !== page) throw error('BROWSER_RECONNECT_REQUIRED', 'The browser changed while waiting. Observe the current tab before retrying.', true);
      await read(() => assertPolicy(actor, 'wait', page.url(), tab, args));
      let observation;
      let satisfied;
      if (args.ref) {
        requireRef(tab, args);
        const remaining = Math.max(1, deadline - Date.now());
        if (tab.snapshot?.native) await read(() => selectedAdapter().passwordAction({ ...nativePasswordBinding(tab), action: 'wait', ref: args.ref, snapshotId: args.snapshotId, state: args.state === 'hidden' ? 'hidden' : 'visible', timeoutMs: remaining }));
        else await read(() => page.getByRef(String(args.ref)).waitFor({ state: args.state === 'hidden' ? 'hidden' : 'visible', timeout: remaining }));
        satisfied = true;
      } else if (condition === 'ready' || condition === 'idle') {
        const native = selectedAdapter()?.inventory && tab.nativeTargetId ? (await read(() => selectedAdapter().inventory())).find(entry => entry.nativeTargetId === tab.nativeTargetId) : null;
        if (selectedAdapter()?.inventory && tab.nativeTargetId && !native) throw error('BROWSER_RECONNECT_REQUIRED', 'The native browser tab disconnected while waiting.', true);
        const ready = native ? !native.loading && !native.crashed && !native.error : tab.status === 'ready';
        const epoch = native?.navigationEpoch ?? tab.navigationEpoch;
        if (!ready || epoch !== observedEpoch) settledSince = undefined;
        observedEpoch = epoch;
        if (ready) settledSince ??= Date.now();
        satisfied = ready && (condition === 'ready' || Date.now() - settledSince >= 500);
      } else {
        observation = await observe();
        // 조건은 제한 전 전체 개요로 판단한다. 가린 값은 일치 대상이 아니다.
        const current = tab.snapshot;
        satisfied = condition === 'text' ? current.lines.some(line => line.includes(needle)) : [...current.refs.values()].some(entry =>
          !needle || [entry.name, entry.value === '[masked]' ? '' : entry.value].some(value => value.includes(needle)));
      }
      if (satisfied) return { completed: true, snapshot: observation ?? await observe() };
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await pause(Math.min(250, remaining), signal);
    } while (Date.now() <= deadline && !signal?.aborted);
    signal?.throwIfAborted();
    throw error('BROWSER_ACTION_TIMEOUT', 'The browser condition did not appear before the wait timeout.', true);
  };

  // 조작 결과를 짧게 지켜본다. 탐색이 시작되면 로드까지, 아니면 조작이 시작한 요청의 응답까지 각각 최대 5초 기다린다.
  const watchConsequences = (tab) => {
    const page = tab.page; const startEpoch = tab.navigationEpoch; const dialogs = tab.dialogCount ?? 0;
    const pending = new Set(); let navigation; let popup; let watching = true; let activeAt = Date.now();
    const onRequest = (request) => {
      if (!watching) return;
      activeAt = Date.now();
      let frame; try { frame = request.frame(); } catch { return; }
      if (request.isNavigationRequest() && frame === page.mainFrame()) navigation = request;
      // 스트림·웹소켓처럼 오래 열린 연결은 기다리지 않는다. 응답 헤더가 오면 끝난 것으로 본다.
      else if (!['websocket', 'eventsource', 'media', 'ping'].includes(request.resourceType())) pending.add(request);
    };
    const onResponse = (response) => { pending.delete(response.request()); };
    // 커밋 없이 끝난 문서 요청(다운로드·204)은 탐색이 아니다.
    const onDone = (request) => { pending.delete(request); if (request === navigation) navigation = 'done'; };
    const onPopup = (opened) => { popup ??= opened; activeAt = Date.now(); };
    page.on('request', onRequest); page.on('response', onResponse); page.on('requestfailed', onDone); page.on('requestfinished', onDone); page.on('popup', onPopup);
    const stop = () => { watching = false; page.off('request', onRequest); page.off('response', onResponse); page.off('requestfailed', onDone); page.off('requestfinished', onDone); page.off('popup', onPopup); };
    const settle = async () => {
      try {
        // 아무 일도 없으면 200ms 조용한 뒤 끝낸다. 요청·탐색이 시작되면 0.5초까지 더 지켜본다.
        const watchStart = Date.now(); activeAt = Math.max(activeAt, watchStart);
        while (Date.now() - watchStart < 500 && !tab.pendingDialog && (navigation || pending.size || popup || tab.navigationEpoch !== startEpoch || Date.now() - activeAt < 200)) await pause(50);
        watching = false;
        const deadline = Date.now() + 5000;
        // 열린 대화상자는 페이지를 멈춘다. 기다리지 않고 대화상자를 돌려준다.
        const live = () => Date.now() < deadline && tab.page === page && !page.isClosed() && !tab.pendingDialog;
        if (navigation || tab.navigationEpoch !== startEpoch) {
          while (live() && tab.navigationEpoch === startEpoch && navigation !== 'done') await pause(50);
          if (live() && tab.navigationEpoch !== startEpoch) await page.waitForLoadState('load', { timeout: Math.max(1, deadline - Date.now()) }).catch(() => {});
        } else while (live() && pending.size) await pause(50);
        let opened;
        while (popup && !(opened = [...tabs.values()].find((entry) => entry.page === popup)) && live() && !popup.isClosed()) await pause(50);
        const navigated = tab.navigationEpoch !== startEpoch;
        if (navigated && !tab.pendingDialog && tab.page === page && !page.isClosed() && !(selectedAdapter() && tab.nativeTargetId)) { const title = await page.title().catch(() => null); if (typeof title === 'string' && tab.page === page) tab.title = text(title, 500); }
        const dialog = tab.pendingDialog?.owner === 'agent' ? { ...dialogInfo(tab), pending: true } : (tab.dialogCount ?? 0) !== dialogs && tab.lastDialog ? redactValues(tab.lastDialog, protectedFor(tab)) : undefined;
        const newTab = opened ? (({ tabId, url, title }) => ({ tabId, url, ...(title ? { title } : {}) }))(descriptor(opened)) : undefined;
        return { navigated, ...(newTab ? { newTab } : {}), ...(dialog ? { dialog } : {}) };
      } finally { stop(); }
    };
    return { stop, settle };
  };

  // form= 속성으로 묶인 칸과 제출 단추의 formaction 까지 본다. 이름이 action 인 칸이 가리지 않게 속성을 읽는다.
  const formDestinations = (handle) => handle.evaluate((el) => {
    const form = el.form;
    if (!form) return [];
    return [form.getAttribute('action'), ...[...form.elements].filter((item) => ['submit', 'image'].includes(item.type)).map((item) => item.getAttribute('formaction'))]
      .filter(Boolean).map((value) => { try { return new URL(value, document.baseURI).origin; } catch { return 'null'; } });
  }).catch(() => ['null']);

  /**
   * browser_upload: 허브가 확인한 파일만 넣는다. 파일 입력이면 바로 채우고, 버튼·라벨·끌어 놓기 영역이면
   * 눌러서 열린 파일 선택에 채운다. 비밀번호 보호 페이지에는 넣지 않는다.
   */
  const agentUpload = async (tab, args) => {
    const payloads = args[UPLOAD_FILES];
    if (!Array.isArray(payloads) || !payloads.length) throw error('BROWSER_UPLOAD_INVALID', 'Choose files from this chat with browser_upload.');
    if (tab.snapshot?.native) throw error('BROWSER_UPLOAD_UNAVAILABLE', 'Saved passwords protect this page. Ask the user to attach the file.');
    const page = requirePage(tab);
    const handle = await elementFor(tab, args);
    const input = await handle.evaluate((el) => el instanceof HTMLInputElement && el.type === 'file' ? { multiple: el.multiple, disabled: el.disabled } : null);
    if (input?.disabled) throw error('BROWSER_UPLOAD_UNAVAILABLE', 'This file input is disabled.');
    const watch = watchConsequences(tab);
    tab.agentUpload = true;
    try {
      if (input) {
        if (payloads.length > 1 && !input.multiple) throw error('BROWSER_UPLOAD_LIMIT', 'This file input accepts one file.');
        await handle.setInputFiles(payloads, { timeout: 10_000 });
      } else {
        const opened = page.waitForEvent('filechooser', { timeout: 10_000 });
        opened.catch(() => {});
        await handle.click({ timeout: 10_000 });
        const chooser = await opened.catch(() => { throw error('BROWSER_UPLOAD_NO_CHOOSER', 'This element did not open a file chooser. Snapshot the page and choose its file input or upload button.', true); });
        if (payloads.length > 1 && !chooser.isMultiple()) throw error('BROWSER_UPLOAD_LIMIT', 'This file chooser accepts one file.');
        await chooser.setFiles(payloads, { timeout: 10_000 });
      }
      return { completed: true, consequences: { ...(await watch.settle()), files: payloads.map(({ name, buffer }) => ({ name, size: buffer.length })) } };
    } finally { tab.agentUpload = false; watch.stop(); }
  };

  // 저장된 비밀번호가 보호하는 페이지는 일반 페이지 평가를 쓸 수 없다. 네이티브 관찰·입력 도구만 쓴다.
  const protectedPage = (tab) => tab.snapshot?.native === true || tab.passwordShielded === true;
  const passwordProtected = (hint) => error('BROWSER_PASSWORD_PROTECTED', `Saved passwords protect this page. ${hint}`);
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);
  const between = (min, max) => min + Math.random() * (max - min);
  // 사용자가 보는 탭이면 화면이 에이전트 커서를 그린다. 페이지 DOM 에는 아무것도 넣지 않는다.
  const pointerEvent = (actor, tab, point, phase, durationMs = 0) => {
    if (actor.isHuman || tab.system) return;
    emit('owned_browser_pointer', { sessionId: actor.sessionId ?? tab.sessionId, tab: descriptor(tab), x: Math.round(point.x), y: Math.round(point.y), phase, durationMs, runtime: runtimeInfo() });
  };
  // 요소를 화면에 들이고 상자를 새로 읽어 가운데가 아닌 안쪽 한 점을 고른다.
  const aimAt = async (handle, { scroll = true } = {}) => {
    if (scroll) await handle.scrollIntoViewIfNeeded({ timeout: 5_000 });
    const box = await handle.boundingBox();
    if (!box || box.width < 1 || box.height < 1) throw error('BROWSER_TARGET_DETACHED', 'The target element is not visible. Take a new snapshot before retrying.', true);
    const spread = (size) => (size < 8 ? size / 2 : size * between(0.3, 0.7));
    const position = { x: spread(box.width), y: spread(box.height) };
    return { box, position, point: { x: box.x + position.x, y: box.y + position.y } };
  };
  // 포인터가 닿으며 요소가 커지거나 줄 수 있다(호버 메뉴). 누르기 직전 상자 안으로 점을 다시 맞춘다.
  const refit = async (handle, position) => {
    const box = await handle.boundingBox();
    if (!box) throw error('BROWSER_TARGET_DETACHED', 'The target element is gone. Take a new snapshot before retrying.', true);
    const inside = (value, size) => (size < 8 ? size / 2 : Math.min(size - 3, Math.max(3, value)));
    return { x: inside(position.x, box.width), y: inside(position.y, box.height) };
  };
  // 사람 손처럼 가속·감속하는 경로로 포인터를 옮긴다(8–20 걸음, 120–250ms). drag 는 단추를 누른 채 조금 더 천천히 옮긴다.
  const glide = async (actor, tab, to, { dragging = false } = {}) => {
    const page = requirePage(tab);
    const from = tab.pointer ?? { x: Math.max(0, to.x + between(-160, 160)), y: Math.max(0, to.y + between(-100, 100)) };
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.round(Math.min(20, Math.max(8, distance / 40)));
    const duration = Math.round(Math.min(dragging ? 400 : 250, (dragging ? 200 : 120) + distance / 5));
    pointerEvent(actor, tab, to, 'move', duration);
    for (let step = 1; step <= steps; step++) {
      const t = ease(step / steps);
      await page.mouse.move(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
      await pause(duration / steps);
    }
    tab.pointer = { x: to.x, y: to.y };
  };
  // 누르기 전에 대상이 보이고 멈춰 있고 그 점에서 이벤트를 받는지(가려지지 않았는지) 확인한다.
  const reachable = (handle) => handle.hover({ trial: true, timeout: 5_000 });
  const pointerClick = async (actor, tab, handle, { button = 'left' } = {}) => {
    await reachable(handle);
    const { position, point } = await aimAt(handle);
    await glide(actor, tab, point);
    pointerEvent(actor, tab, point, 'click');
    await pause(40);
    await handle.click({ timeout: 10_000, button, position: await refit(handle, position), delay: Math.round(between(40, 90)) });
  };
  const pointerHover = async (actor, tab, handle) => {
    await reachable(handle);
    const { position, point } = await aimAt(handle);
    await glide(actor, tab, point);
    await handle.hover({ timeout: 10_000, position: await refit(handle, position) });
    return {};
  };
  /**
   * 끌기: 출발점으로 옮겨 누르고, 누른 채 목표로 옮겨 놓는다. HTML 끌어 놓기 요소가 dragstart 를 받지 못했으면
   * 같은 순서의 합성 이벤트(dragstart·drag·dragenter·dragover·drop·dragend)를 한 DataTransfer 로 보낸다.
   */
  const pointerDrag = async (actor, tab, handle, targetHandle, args) => {
    const page = requirePage(tab);
    await reachable(handle);
    const source = await aimAt(handle);
    await glide(actor, tab, source.point);
    const grip = await refit(handle, source.position);
    await handle.hover({ timeout: 10_000, position: grip });
    // 옮기는 사이 배치가 바뀌었을 수 있다. 누르기 직전의 상자로 출발점과 목표를 다시 잡는다.
    const fresh = await handle.boundingBox();
    if (!fresh) throw error('BROWSER_TARGET_DETACHED', 'The target element is gone. Take a new snapshot before retrying.', true);
    const start = { x: fresh.x + grip.x, y: fresh.y + grip.y };
    let to;
    if (targetHandle) {
      const target = await aimAt(targetHandle, { scroll: false });
      const viewport = await viewportInfo(tab);
      if (target.point.x < 0 || target.point.y < 0 || target.point.x > viewport.width || target.point.y > viewport.height) throw error('BROWSER_DRAG_OFFSCREEN', 'The drop target is outside the visible page. Scroll so both elements are visible, then take a new snapshot.', true);
      to = target.point;
    } else to = { x: start.x + (Number(args.offsetX) || 0), y: start.y + (Number(args.offsetY) || 0) };
    const html5 = await handle.evaluate((el) => {
      const node = el.closest('[draggable="true"]');
      if (!node) return false;
      node.__rhwpDragStarted = false;
      node.addEventListener('dragstart', () => { node.__rhwpDragStarted = true; }, { once: true, capture: true });
      return true;
    }).catch(() => false);
    pointerEvent(actor, tab, start, 'down');
    await page.mouse.down();
    try {
      // 끌기 문턱을 넘는 첫 움직임 뒤에 목표까지 옮긴다.
      await page.mouse.move(start.x + 4, start.y + 4);
      tab.pointer = { x: start.x + 4, y: start.y + 4 };
      await glide(actor, tab, to, { dragging: true });
    } finally {
      await page.mouse.up();
      pointerEvent(actor, tab, to, 'up');
    }
    if (!html5) return { dragged: { mode: 'pointer' } };
    const started = await handle.evaluate((el) => el.closest('[draggable="true"]')?.__rhwpDragStarted === true).catch(() => true);
    if (started) return { dragged: { mode: 'html5' } };
    const dropped = await handle.evaluate((el, { target, from, to: point }) => {
      const origin = el.closest('[draggable="true"]') ?? el;
      const destination = target ?? document.elementFromPoint(point.x, point.y);
      if (!destination) return false;
      const data = new DataTransfer();
      const fire = (node, type, at) => node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: at.x, clientY: at.y, dataTransfer: data }));
      fire(origin, 'dragstart', from); fire(origin, 'drag', from);
      fire(destination, 'dragenter', point); fire(destination, 'dragover', point); fire(destination, 'drop', point);
      fire(origin, 'dragend', point);
      return true;
    }, { target: targetHandle, from: start, to });
    if (!dropped) throw error('BROWSER_DRAG_FAILED', 'Nothing accepted the drop at the target point. Take a new snapshot before retrying.', true);
    return { dragged: { mode: 'synthetic' } };
  };
  const pointerAction = async (actor, action, tab, args) => {
    if (protectedPage(tab)) throw passwordProtected('Use browser_click instead.');
    const handle = await elementFor(tab, args);
    let targetHandle = null;
    if (action === 'drag') {
      if (args.targetRef) targetHandle = await elementFor(tab, { ...args, ref: args.targetRef });
      else if (!Number(args.offsetX) && !Number(args.offsetY)) throw error('BROWSER_DRAG_INVALID', 'Pass targetRef or a nonzero offsetX/offsetY.');
    }
    const watch = watchConsequences(tab);
    try {
      const outcome = await raceDialog(tab, () => (action === 'hover' ? pointerHover(actor, tab, handle) : pointerDrag(actor, tab, handle, targetHandle, args)));
      return { completed: true, consequences: { ...(await watch.settle()), ...(outcome ?? {}) } };
    } finally { watch.stop(); }
  };

  // 네이티브 <select> 의 선택지를 라벨, 값, 대소문자 무시 라벨 순서로 고른다.
  const chooseOption = async (handle, wanted) => {
    const options = await handle.evaluate((el) => (el instanceof HTMLSelectElement ? [...el.options].map((option) => [option.label.trim(), option.value, option.disabled]) : null));
    if (!options) throw error('BROWSER_NOT_SELECTABLE', 'The target is not a native list box. Click custom menus instead.');
    const value = String(wanted ?? '').trim();
    const choice = [([label]) => label === value, ([, option]) => option === value, ([label]) => label.toLowerCase() === value.toLowerCase()].map((match) => options.findIndex((option) => !option[2] && match(option))).find((index) => index >= 0);
    if (choice === undefined) throw error('BROWSER_OPTION_NOT_FOUND', 'No enabled option has this label or value. Snapshot the list box with scope to see its options.');
    return choice;
  };
  /**
   * browser_fill_form: 한 관찰의 여러 칸을 한 번에 채운다. 칸마다 결과를 돌려주고 한 칸의 실패로 멈추지 않는다.
   * 비밀번호·일회용 코드 칸은 browser_type 과 같이 거절한다. 제출은 submit ref 를 줄 때만 하고, non-GET 폼이면 사이트 사용이 필요하다.
   */
  // 저장된 비밀번호가 보호하는 페이지: 데스크톱의 격리된 입력으로 글자 칸과 목록만 채운다.
  const fillProtectedForm = async (actor, tab, args, fields) => {
    const adapter = selectedAdapter();
    if (!tab.snapshot?.native || !adapter?.passwordAction) throw passwordProtected('Fill fields one by one with browser_type.');
    const binding = { ...nativePasswordBinding(tab), snapshotId: args.snapshotId };
    const watch = watchConsequences(tab);
    try {
      const results = [];
      for (const field of fields) {
        const ref = String(field?.ref ?? '');
        try {
          epochs(tab, args, true); assertController(actor, tab);
          const element = requireRef(tab, { ...args, ref });
          if (!actor.isHuman) await assertTypingTarget(tab, { ...args, ref });
          if (typeof field.value !== 'string') throw error('BROWSER_FORM_INVALID', 'Saved passwords protect this page; set checkboxes with browser_click.');
          if (element.tag === 'select') await adapter.passwordAction({ ...binding, action: 'select', ref, option: text(field.value, 500) });
          else if (element.tag === 'textarea' || element.tag === 'input' && SECRET_INPUT_TYPES.has(element.inputType ?? 'text')) await adapter.passwordAction({ ...binding, action: 'type', ref, text: text(field.value, 16_000) });
          else throw error('BROWSER_NOT_EDITABLE', 'Saved passwords protect this page; only text fields and list boxes can be filled here.');
          results.push({ ref, ok: true });
        } catch (failure) {
          const mapped = failure instanceof OwnedBrowserError || failure.code?.startsWith('BROWSER_') ? failure : browserActionFailure(failure);
          if (['BROWSER_STALE_NAVIGATION', 'BROWSER_STALE_CONTROL', 'BROWSER_STALE_REFERENCE', 'BROWSER_USER_CONTROL'].includes(mapped.code)) throw mapped;
          results.push({ ref, ok: false, error: { code: mapped.code, message: redactValues(mapped.message, protectedFor(tab)) } });
        }
      }
      if (args.submit) {
        const target = { ...args, ref: String(args.submit) };
        requireRef(tab, target);
        if (!actor.isHuman && await raisesChange(tab, 'click', target)) await assertPolicy(actor, 'click', requirePage(tab).url(), tab, { intent: 'website-change' });
        await raceDialog(tab, () => adapter.passwordAction({ ...binding, action: 'click', ref: target.ref }));
      }
      return { completed: true, consequences: { ...(await watch.settle()), fields: results, ...(args.submit ? { submitted: true } : {}) } };
    } finally { watch.stop(); }
  };
  const fillForm = async (actor, tab, args) => {
    const fields = Array.isArray(args.fields) ? args.fields : [];
    if (!fields.length || fields.length > 50) throw error('BROWSER_FORM_INVALID', 'Pass between 1 and 50 fields.');
    if (protectedPage(tab)) return fillProtectedForm(actor, tab, args, fields);
    const page = requirePage(tab);
    const fatal = new Set(['BROWSER_STALE_NAVIGATION', 'BROWSER_STALE_CONTROL', 'BROWSER_STALE_REFERENCE', 'BROWSER_USER_CONTROL', 'BROWSER_DIALOG_PENDING', 'BROWSER_RECONNECT_REQUIRED']);
    const watch = watchConsequences(tab);
    try {
      const results = [];
      for (const field of fields) {
        const ref = String(field?.ref ?? '');
        try {
          epochs(tab, args, true); assertController(actor, tab);
          if (tab.pendingDialog) throw dialogPending(tab);
          const target = { ...args, ref };
          if (!actor.isHuman) await assertTypingTarget(tab, target);
          const handle = await elementFor(tab, target);
          const kind = await handle.evaluate((el) => ({ tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || 'text').trim().toLowerCase(), editable: el.isContentEditable === true }));
          const value = field.value;
          if (kind.tag === 'input' && ['checkbox', 'radio'].includes(kind.type)) {
            const checked = value === true || value === 'true' ? true : value === false || value === 'false' ? false : null;
            if (checked === null) throw error('BROWSER_FORM_INVALID', 'Checkboxes and radios take true or false.');
            if (kind.type === 'radio' && !checked) throw error('BROWSER_FORM_INVALID', 'Choose another radio in the group instead of clearing this one.');
            await handle.setChecked(checked, { timeout: 5_000 });
            results.push({ ref, ok: true, checked });
            continue;
          }
          if (typeof value !== 'string') throw error('BROWSER_FORM_INVALID', 'Text fields and list boxes take a string value.');
          if (kind.tag === 'select') { await handle.selectOption({ index: await chooseOption(handle, value) }, { timeout: 5_000 }); results.push({ ref, ok: true }); continue; }
          if (kind.tag === 'input' && kind.type === 'file') throw error('BROWSER_UPLOAD_REQUIRED', 'Attach files with browser_upload.');
          if (kind.tag === 'input' && ['submit', 'button', 'reset', 'image', 'hidden'].includes(kind.type)) throw error('BROWSER_NOT_EDITABLE', 'This element is not a form field. Pass it as submit or click it.');
          if (kind.tag === 'input' && kind.type === 'range') {
            await handle.evaluate((el, next) => { el.value = next; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, text(value, 100));
          } else if (kind.tag === 'input' || kind.tag === 'textarea' || kind.editable) await handle.fill(text(value, 16_000), { timeout: 5_000 });
          else throw error('BROWSER_NOT_EDITABLE', 'The target is not an editable field. Choose a form field from the snapshot.');
          results.push({ ref, ok: true });
        } catch (failure) {
          const mapped = failure instanceof OwnedBrowserError || failure.code?.startsWith('BROWSER_') ? failure : browserActionFailure(failure);
          if (fatal.has(mapped.code)) throw mapped;
          results.push({ ref, ok: false, error: { code: mapped.code, message: redactValues(mapped.message, protectedFor(tab)) } });
        }
      }
      let submitted = false;
      if (args.submit) {
        const target = { ...args, ref: String(args.submit) };
        epochs(tab, args, true); assertController(actor, tab);
        if (!actor.isHuman && await raisesChange(tab, 'click', target)) await assertPolicy(actor, 'click', page.url(), tab, { intent: 'website-change' });
        const handle = await elementFor(tab, target);
        await raceDialog(tab, () => (actor.isHuman ? handle.click({ timeout: 10_000 }) : pointerClick(actor, tab, handle)));
        submitted = true;
      }
      return { completed: true, consequences: { ...(await watch.settle()), fields: results, ...(submitted ? { submitted } : {}) } };
    } finally { watch.stop(); }
  };

  /** browser_dialog: 에이전트 조작이 연 확인·입력·떠나기 확인 대화상자에 답한다. 대화상자를 연 조작은 그 뒤에 마무리된다. */
  const answerDialog = async (actor, tab, args) => {
    const pending = tab.pendingDialog;
    if (!pending || !(await dialogStillOpen(tab))) throw error('BROWSER_DIALOG_NOT_FOUND', 'No page dialog is open in this tab.');
    if (pending.owner === 'human' && !actor.isHuman) throw error('BROWSER_USER_CONTROL', 'The user is answering this page dialog. Wait for them, then observe the page again.');
    const accept = args.accept === true;
    const promptText = args.promptText === undefined || args.promptText === null ? undefined : text(args.promptText, 2_000);
    if (promptText !== undefined && (pending.type !== 'prompt' || !accept)) throw error('BROWSER_DIALOG_INVALID', 'promptText applies only when accepting a prompt dialog.');
    if (promptText !== undefined && protectedPage(tab)) throw passwordProtected('Prompt text cannot be entered here; ask the user.');
    // 떠나기 확인을 승인하면 페이지가 저장하지 않은 내용을 잃는다. 사용자 탭에서는 사이트 사용이 있어야 한다.
    if (accept && pending.type === 'beforeunload' && !actor.isHuman && tab.scope === 'global') await assertPolicy(actor, 'dialog', requirePage(tab).url(), tab, { intent: 'website-change' });
    const watch = watchConsequences(tab);
    try {
      tab.pendingDialog = null;
      try { if (accept) await pending.dialog.accept(promptText); else await pending.dialog.dismiss(); }
      catch { throw error('BROWSER_DIALOG_NOT_FOUND', 'The page dialog already closed. Observe the page again.', true); }
      const leftover = tab.dialogAction; tab.dialogAction = null;
      if (leftover) await Promise.race([leftover.catch(() => {}), pause(5_000)]);
      return { completed: true, consequences: { ...(await watch.settle()), answered: { type: pending.type, accepted: accept } } };
    } finally { watch.stop(); }
  };

  /**
   * browser_snapshot find: 지금 탭(같은 출처 iframe 포함)의 보이는 글에서 찾는다. 일치 수와 앞뒤 문맥, 그리고 일치한 줄의 ref 개요를 돌려준다.
   * scrollTo 는 n 번째 일치를 화면 가운데로 옮기고 선택해 이어지는 관찰·캡처에 보이게 한다.
   */
  const pageTextWalker = (options) => {
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION']);
    const blockOf = (node) => { let el = node.parentElement; while (el && getComputedStyle(el).display.startsWith('inline')) el = el.parentElement; return el; };
    const visible = new Map();
    const shown = (el) => { if (!visible.has(el)) visible.set(el, el.checkVisibility ? el.checkVisibility() : true); return visible.get(el); };
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
    const pieces = []; let total = 0; let lastBlock;
    for (let node = walker.nextNode(); node && total < 2_000_000; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || SKIP.has(parent.tagName) || parent.closest('[data-rhwp-private-field]') || !node.nodeValue || !shown(parent)) continue;
      const block = blockOf(node);
      const gap = pieces.length && block !== lastBlock ? 1 : 0;
      pieces.push({ node, start: total + gap, gap }); total += gap + node.nodeValue.length; lastBlock = block;
    }
    if (options?.offset === undefined) return pieces.map((piece) => (piece.gap ? '\n' : '') + piece.node.nodeValue).join('');
    const locate = (offset) => { const piece = pieces.findLast((entry) => entry.start <= offset) ?? pieces[0]; return [piece.node, Math.min(piece.node.nodeValue.length, Math.max(0, offset - piece.start))]; };
    const range = document.createRange();
    range.setStart(...locate(options.offset)); range.setEnd(...locate(options.offset + options.length));
    const host = range.startContainer.parentElement;
    host?.scrollIntoView({ block: 'center', inline: 'nearest' });
    const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const findInPage = async (actor, tab, args) => {
    const page = requirePage(tab);
    const query = squash(args.find);
    // 찾기 전에 비공개 칸의 값을 가릴 목록에 넣는다. 처음 찾기에서도 비밀 값으로 일치 수를 떠볼 수 없다.
    tab.protectedValues ??= new Set();
    for (const frame of page.frames()) {
      const fields = await frame.locator(SENSITIVE).elementHandles().catch(() => []);
      for (const field of fields) { const value = await field.inputValue().catch(() => ''); if (value) tab.protectedValues.add(value); void field.dispose().catch(() => {}); }
    }
    let origin = 'null'; try { origin = new URL(page.url()).origin; } catch {}
    const frames = page.frames().filter((frame) => { if (frame === page.mainFrame()) return true; try { return new URL(frame.url()).origin === origin; } catch { return false; } });
    const secrets = protectedFor(tab);
    const found = []; let count = 0;
    for (const frame of frames) {
      const raw = await frame.evaluate(pageTextWalker, {}).catch(() => null);
      if (typeof raw !== 'string') continue;
      // 가린 값은 같은 길이로 바꾼 뒤 찾는다. 비밀 값으로 일치 수를 떠볼 수 없다.
      const result = findMatches(maskSameLength(raw, secrets), query, { limit: 10 });
      for (const [index, offset] of result.offsets.entries()) found.push({ frame, offset, ...(index < 10 ? { excerpt: result.matches[index].text } : {}) });
      count += result.count;
    }
    const matches = found.filter((entry) => entry.excerpt).slice(0, 10).map((entry, index) => ({ index: index + 1, text: entry.excerpt, ...(entry.frame !== page.mainFrame() ? { frame: 'iframe' } : {}) }));
    let scrolledTo;
    if (args.scrollTo !== undefined) {
      const wanted = found[Number(args.scrollTo) - 1];
      if (!wanted) throw error('BROWSER_FIND_NOT_FOUND', `Match ${args.scrollTo} does not exist; the page has ${count}.`);
      if (!actor.isHuman && userHolds(tab)) throw error('BROWSER_USER_CONTROL', 'The user is controlling this tab. Read without scrollTo, or wait for them to return control.');
      await wanted.frame.evaluate(pageTextWalker, { offset: wanted.offset, length: query.length });
      scrolledTo = Number(args.scrollTo);
    }
    const outline = await snapshot(tab, undefined, { scope: args.scope, find: query, text: args.text === true });
    return { snapshot: outline, found: { count, ...(count ? { matches } : {}), ...(scrolledTo ? { scrolledTo } : {}) } };
  };

  /**
   * 인용 근거 그림: 인용한 단락(ref)이나 인용문 글자 범위를 화면 안으로 굴린 뒤 그 상자만 찍는다.
   * 인용문은 앞·뒤 조각을 찾아 그 사이 범위를 잡는다 (블록 경계의 줄바꿈이 전체 일치를 막는다).
   * 찍기는 screenshot 을 거쳐 비밀번호 화면 차단·민감 칸 가림을 그대로 받는다.
   */
  const citeImage = async (tab, handle, quote) => {
    const page = requirePage(tab);
    let box;
    if (handle) {
      await handle.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
      box = await handle.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    } else {
      box = await page.evaluate((wanted) => {
        const selection = getSelection();
        const saved = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
        const find = (needle, from) => {
          selection.removeAllRanges();
          if (from) { const at = document.createRange(); at.setStart(from.startContainer, from.startOffset); at.collapse(true); selection.addRange(at); }
          else window.scrollTo(0, 0);
          return window.find(needle, false, false, !from, false, false, false) && selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
        };
        try {
          let range = find(wanted);
          if (!range) {
            const head = find(wanted.slice(0, 60).trim());
            const tail = head && find(wanted.slice(-60).trim(), head);
            if (!head) return null;
            range = document.createRange();
            range.setStart(head.startContainer, head.startOffset);
            if (tail) range.setEnd(tail.endContainer, tail.endOffset); else range.setEnd(head.endContainer, head.endOffset);
          }
          const anchor = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
          const tall = range.getBoundingClientRect().height > innerHeight * 0.8;
          anchor?.scrollIntoView({ block: tall ? 'start' : 'center', inline: 'nearest' });
          const r = range.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        } finally {
          selection.removeAllRanges();
          if (saved) selection.addRange(saved);
        }
      }, quote);
    }
    if (!box || box.width < 1 || box.height < 1) throw error('BROWSER_QUOTE_NOT_VISIBLE', 'The quoted text has no visible box on the page.');
    const viewport = await viewportInfo(tab);
    const pad = 8;
    const x = Math.max(0, Math.floor(box.x - pad)), y = Math.max(0, Math.floor(box.y - pad));
    const width = Math.min(viewport.width - x, Math.ceil(box.width + pad * 2)), height = Math.min(viewport.height - y, Math.ceil(box.height + pad * 2));
    if (width < 1 || height < 1) throw error('BROWSER_QUOTE_NOT_VISIBLE', 'The quoted text is outside the visible page.');
    const rect = { x, y, width, height };
    return { mimeType: 'image/jpeg', data: await screenshot(tab, rect), width, height };
  };

  /** browser_cite: 지금 탭의 글 한 단락(ref)이나 정확한 인용문을 출처 정보와 함께 인용 기록으로 돌려준다. */
  const cite = async (tab, args) => {
    if (protectedPage(tab)) throw passwordProtected('Quote public pages only.');
    const page = requirePage(tab);
    const secrets = protectedFor(tab);
    let quote;
    let handle;
    if (args.ref) {
      handle = await elementFor(tab, args);
      const picked = await handle.evaluate((el, selector) => ({ field: el.matches('input,textarea,select,[contenteditable="true"]') || el.matches(selector) || !!el.querySelector(selector), text: el.innerText ?? el.textContent ?? '' }), SENSITIVE);
      if (picked.field) throw error('BROWSER_CITE_INVALID', 'Choose page text, not a form field.');
      quote = squash(redactValues(picked.text, secrets));
    } else {
      const wanted = squash(args.quote);
      if (!wanted) throw error('BROWSER_CITE_INVALID', 'Pass a snapshot ref or the exact quote.');
      const body = squash(maskSameLength(await page.locator('body').innerText({ timeout: 3_000 }), secrets));
      let at = body.indexOf(wanted);
      if (at < 0) at = body.toLowerCase().indexOf(wanted.toLowerCase());
      if (at < 0) throw error('BROWSER_QUOTE_NOT_FOUND', 'This text is not on the current page. Locate it with browser_snapshot find and quote it exactly.');
      quote = body.slice(at, at + wanted.length);
    }
    if (!quote) throw error('BROWSER_CITE_INVALID', 'The chosen element has no text.');
    const truncated = quote.length > 4_000;
    if (truncated) quote = `${quote.slice(0, 3_999)}…`;
    const metadata = await page.evaluate(pageCitationMetadata).catch(() => ({}));
    const record = citationRecord({ quote, pageUrl: page.url(), pageTitle: tab.title, metadata });
    const citation = redactValues({ ...record, ...(truncated ? { truncated } : {}) }, secrets);
    if (args.capture !== true) return { citation };
    // 그림을 못 찍어도 인용 기록은 돌려준다. 비밀번호 화면 차단은 그대로 오류다.
    try { return { citation, image: await citeImage(tab, handle, handle ? null : quote.replace(/…$/, '')) }; }
    catch (failure) {
      if (failure.code === 'BROWSER_PASSWORD_CAPTURE_PROTECTED') throw failure;
      return { citation, imageError: { code: failure.code?.startsWith('BROWSER_') ? failure.code : 'BROWSER_CAPTURE_IMAGE_FAILED', message: failure.code?.startsWith('BROWSER_') ? failure.message : 'The passage could not be captured.' } };
    }
  };

  const operate = async (actor, action, tab, args, signal) => {
    if (action === 'close') { await releaseInput(tab); await tab.page?.close(); tab.status = 'closed'; tabs.delete(tab.tabId); await persist(); return { completed: true }; }
    const page = requirePage(tab);
    // find 는 개요 줄과 함께 보이는 글 전체(같은 출처 iframe 포함)의 일치 수·문맥을 돌려주고, scrollTo 로 n 번째 일치를 화면에 보인다.
    if (action === 'snapshot' && args.find && !protectedPage(tab)) return findInPage(actor, tab, args);
    if (action === 'snapshot' && args.scrollTo !== undefined) throw error('BROWSER_FIND_INVALID', 'scrollTo needs find.');
    if (action === 'snapshot') return { snapshot: await snapshot(tab, undefined, { scope: args.scope, find: args.find, text: args.text === true }) };
    if (action === 'frame') return { frame: await frame(tab, actor) };
    if (action === 'capture') return { capture: await capture(actor, tab, args) };
    if (action === 'cite') return cite(tab, args);
    if (action === 'dialog') return answerDialog(actor, tab, args);
    if (action === 'fill-form') return fillForm(actor, tab, args);
    if (action === 'hover' || action === 'drag') return pointerAction(actor, action, tab, args);
    if (tab.snapshot?.native && selectedAdapter()?.passwordAction && ['click', 'type', 'press', 'select', 'scroll'].includes(action)) {
      if (action === 'press') assertAgentKey(actor, args.key);
      const ref = args.ref ?? (action === 'press' ? tab.snapshot.elements.find((element) => element.tag === 'input')?.ref : undefined);
      if (action !== 'scroll') requireRef(tab, { ...args, ref });
      const parameters = { ...nativePasswordBinding(tab), action, ref, snapshotId: args.snapshotId ?? tab.snapshot.snapshotId, text: text(args.text, 16_000), key: text(args.key, 80), option: text(args.option, 500), deltaX: bounded(args.deltaX, -2000, 2000, 0), deltaY: bounded(args.deltaY, -2000, 2000, 600) };
      const watch = SETTLING.has(action) ? watchConsequences(tab) : null;
      try {
        const result = await raceDialog(tab, async () => {
          const value = await selectedAdapter().passwordAction(parameters);
          if (action === 'type' && args.submit === true) {
            epochs(tab, args, true); assertController(actor, tab);
            await assertPolicy(actor, 'press', page.url(), tab, args);
            await selectedAdapter().passwordAction({ ...parameters, action: 'press', key: 'Enter' });
          }
          return value;
        });
        return watch ? { ...result, consequences: await watch.settle() } : result ?? { completed: true };
      } finally { watch?.stop(); }
    }
    if (action === 'wait') return waitForCondition(actor, tab, args, signal);
    if (action === 'navigate') {
      invalidate(tab);
      if (args.direction === 'stop') {
        if (selectedAdapter()?.passwordAction && tab.nativeTargetId) await selectedAdapter().passwordAction({ ...nativePasswordBinding(tab), action: 'stop' });
        else await page.evaluate(() => window.stop());
      }
      else if (args.direction === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
      else if (args.direction === 'forward') await page.goForward({ waitUntil: 'domcontentloaded' });
      else if (args.direction === 'reload') await page.reload({ waitUntil: 'domcontentloaded' });
      else { const url = guard.parse(args.url).href; await assertPolicy(actor, action, url, tab, args); await page.goto(url, { waitUntil: 'domcontentloaded' }); }
      return { completed: true };
    }
    if (SETTLING.has(action)) {
      if (action === 'press') assertAgentKey(actor, args.key);
      const handle = args.ref || action !== 'press' ? await elementFor(tab, args) : null;
      if (action === 'type' && ((await handle.getAttribute('type'))?.toLowerCase() === 'password' || ['current-password', 'new-password'].includes(await handle.getAttribute('autocomplete')))) throw error('BROWSER_SECRET_CHANNEL_REQUIRED', 'Use the saved-account broker to fill password fields.');
      if (action === 'type' && (await handle.getAttribute('autocomplete'))?.trim().toLowerCase() === 'one-time-code') throw error('BROWSER_USER_CODE_REQUIRED', "The user must enter this one-time code. Call browser_request_account with kind 'code'.");
      const choice = action === 'select' ? await chooseOption(handle, args.option) : undefined;
      const watch = watchConsequences(tab);
      try {
        // 대화상자를 여는 조작은 대화상자가 닫힐 때까지 끝나지 않는다. 대화상자가 먼저 열리면 그것을 돌려준다.
        await raceDialog(tab, async () => {
          const button = args.button === 'right' ? 'right' : 'left';
          if (action === 'click') await (actor.isHuman ? handle.click({ timeout: 10_000, button }) : pointerClick(actor, tab, handle, { button }));
          else if (action === 'select') await handle.selectOption({ index: choice }, { timeout: 10_000 });
          else if (action === 'press') { if (handle) await handle.press(text(args.key, 80)); else await page.keyboard.press(text(args.key, 80)); }
          else {
            await handle.fill(text(args.text, 16_000), { timeout: 10_000 });
            if (args.submit === true) {
              epochs(tab, args, true); assertController(actor, tab);
              await assertPolicy(actor, 'press', page.url(), tab, args);
              await (await elementFor(tab, args)).press('Enter', { timeout: 10_000 });
            }
          }
        });
        return { completed: true, consequences: await watch.settle() };
      } finally { watch.stop(); }
    }
    if (action === 'scroll') { await page.mouse.wheel(bounded(args.deltaX, -2000, 2000, 0), bounded(args.deltaY, -2000, 2000, 600)); return { completed: true }; }
    if (action === 'input') { if (!actor.isHuman) throw error('BROWSER_HUMAN_INPUT_REQUIRED', 'Raw browser input is reserved for human takeover.'); return input(tab, args); }
    if (action === 'upload' && !actor.isHuman) return agentUpload(tab, args);
    if (action === 'upload') {
      if (!tab.pendingChooser) throw error('BROWSER_UPLOAD_UNAVAILABLE', 'Choose Upload in a human-controlled page first.');
      const files = Array.isArray(args.files) ? args.files : [];
      if (files.length > 5) throw error('BROWSER_UPLOAD_LIMIT', 'Choose at most five files.');
      let total = 0;
      const payloads = files.map((file) => {
        if (typeof file.data !== 'string' || file.data.length > 28 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw error('BROWSER_UPLOAD_INVALID', 'The selected file data is invalid.');
        const buffer = Buffer.from(file.data, 'base64'); total += buffer.length;
        if (buffer.length > 20 * 1024 * 1024 || total > 40 * 1024 * 1024) throw error('BROWSER_UPLOAD_LIMIT', 'The selected files exceed the upload limit.');
        return { name: path.basename(text(file.name, 256).replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '') || 'upload', mimeType: text(file.mimeType, 128) || 'application/octet-stream', buffer };
      });
      const chooser = tab.pendingChooser; tab.pendingChooser = null; await chooser.setFiles(payloads); return { completed: true };
    }
    if (action === 'viewport') { await page.setViewportSize({ width: Math.floor(bounded(args.width, 320, 1920, 1280)), height: Math.floor(bounded(args.height, 240, 1080, 800)) }); tab.frame = null; return { completed: true }; }
    if (action === 'fill-account') {
      if (tab.snapshot?.native && selectedAdapter()?.passwordFill) {
        requireRef(tab, { ...args, ref: args.passwordRef });
        if (args.usernameRef) requireRef(tab, { ...args, ref: args.usernameRef });
        // 허브가 사이트 사용을 판정해 그 결과(grant)를 함께 보낸다. 보관함은 grant 와 로그인의 끔 여부를 다시 확인한다.
        let grant;
        if (!actor.isHuman) {
          const login = ((await selectedAdapter().passwordAccounts?.())?.accounts ?? []).find((entry) => entry.id === args.accountId);
          if (!login) throw error('BROWSER_ACCOUNT_NOT_FOUND', 'The saved website account no longer exists.');
          if (!sameSite(login.origin, page.url())) throw error('BROWSER_ACCOUNT_ORIGIN_MISMATCH', 'This saved login belongs to a different website.');
          const decision = await assertPolicy(actor, 'fill-account', page.url(), tab, { policyAction: 'account-use', item: { accountId: login.id, blocked: login.agentBlocked === true } });
          grant = { site: decision?.key ?? decision?.site, scope: decision?.source === 'chat' ? 'chat' : 'always', grantedAt: Date.now() };
        }
        const result = await selectedAdapter().passwordFill({ ...nativePasswordBinding(tab), accountId: args.accountId, snapshotId: args.snapshotId, usernameRef: args.usernameRef, passwordRef: args.passwordRef, ...(grant ? { grant } : {}) });
        tab.snapshot.passwordProtected = true; forgetVisit(tab);
        // 사용자의 저장된 로그인으로 들어가는 사이트다. 이 사이트의 쿠키는 이제 손님 쿠키가 아니다.
        touchSite(page.url(), 'identity');
        return result;
      }
      if (!credentialBroker?.issueHandle || !credentialBroker?.fill) throw error('BROWSER_VAULT_UNAVAILABLE', 'The secure account broker is unavailable.', true);
      const passwordHandle = await elementFor(tab, { ...args, ref: args.passwordRef ?? args.ref });
      const usernameHandle = args.usernameRef ? await elementFor(tab, { ...args, ref: args.usernameRef }) : null;
      const origin = new URL(page.url()).origin;
      const binding = { tabId: tab.tabId, runtimeGeneration: generation, navigationEpoch: tab.navigationEpoch, controlEpoch: tab.controllerEpoch, frameId: 'main', origin, accountId: args.accountId };
      const issued = await credentialBroker.issueHandle({ actor, accountId: args.accountId, binding });
      await credentialBroker.fill({ actor, handle: issued.handle, binding, getBinding: async () => ({ ...binding, origin: new URL(page.url()).origin, navigationEpoch: tab.navigationEpoch, controlEpoch: tab.controllerEpoch, runtimeGeneration: generation }), fill: async ({ username, password, assertAuthorized, perform = async (write) => write() }) => {
        epochs(tab, args, true); assertController(actor, tab);
        if (new URL(page.url()).origin !== origin || await passwordHandle.ownerFrame() !== page.mainFrame()) throw error('BROWSER_CREDENTIAL_TARGET_CHANGED', 'The sign-in page or frame changed.');
        if (await passwordHandle.getAttribute('type') !== 'password') throw error('BROWSER_CREDENTIAL_TARGET_INVALID', 'The selected field is not a current password field.');
        // 로그인 폼은 같은 사이트로만 보낸다(하위 도메인끼리는 된다).
        if ((await formDestinations(passwordHandle)).some((destination) => !sameSite(destination, origin))) throw error('BROWSER_PASSWORD_FORM_ORIGIN', 'This sign-in form sends its data to another website.');
        const write = async (handle, value, isPassword) => {
          if (!isPassword) await handle.evaluate((el) => el.setAttribute('data-rhwp-private-field', 'true'));
          // Readiness waits hold no credential data and never hold a revocation fence.
          await handle.waitForElementState('visible', { timeout: 10_000 });
          await handle.waitForElementState('editable', { timeout: 10_000 });
          await assertAuthorized?.();
          await assertPolicy(actor, 'fill-account', page.url(), tab, args);
          epochs(tab, args, true); assertController(actor, tab);
          await perform(async () => {
            if (new URL(page.url()).origin !== origin || isPassword && await handle.getAttribute('type') !== 'password') throw error('BROWSER_CREDENTIAL_TARGET_CHANGED', 'The sign-in field changed before credential input. Refresh it before retrying.');
            tab.protectedValues ??= new Set(); tab.protectedValues.add(value);
            // 비밀번호는 모든 탭의 관찰에서 가리고, 허브도 도구 결과에서 지운다.
            if (isPassword) { rememberFilled(value); try { options.onFilledValue?.(value); } catch {} }
            // Playwright fills through its isolated selector engine, never a site-patched setter.
            await handle.fill(value, { timeout: 10_000 });
          });
        };
        if (usernameHandle) await write(usernameHandle, username, false);
        await write(passwordHandle, password, true);
      } });
      touchSite(page.url(), 'identity');
      return { completed: true, accountId: args.accountId };
    }
    if (action === 'fill-secret') return fillSecret(actor, tab, page, args);
    throw error('BROWSER_ACTION_INVALID', 'Unsupported browser action.');
  };

  // 사용자가 승인한 비밀을 한 칸에 입력한다. 값은 모든 확인을 마친 뒤에야 꺼내고, 탭의 보호 값으로 등록해 관찰·대화상자·오류·캡처에서 가린다.
  const fillSecret = async (actor, tab, page, args) => {
    const secret = args[SECRET_FILL];
    if (actor.isHuman || !secret || typeof secret.resolve !== 'function' || !Array.isArray(secret.origins)) throw error('BROWSER_ACTION_INVALID', 'Fill secrets with browser_fill_secret.');
    const allowed = [...secret.origins];
    // 비밀은 자기 사이트(같은 등록 도메인)에서만 입력한다.
    const onSecretSite = (value) => allowed.some((entry) => sameSite(entry, value));
    const outside = () => error('BROWSER_SECRET_ORIGIN_MISMATCH', 'This page is outside the websites this secret belongs to.');
    const topOrigin = () => { try { return new URL(page.url()).origin; } catch { return 'null'; } };
    const origin = topOrigin();
    if (!onSecretSite(origin)) throw outside();
    const protect = (value) => {
      tab.protectedValues ??= new Set(); tab.protectedValues.add(value);
      rememberFilled(value);
    };
    const submit = async (press) => {
      if (args.submit !== true) return;
      epochs(tab, args, true); assertController(actor, tab);
      // 제출은 browser_type 의 제출과 같은 사이트 변경 승인을 따른다.
      await assertPolicy(actor, 'press', page.url(), tab, { intent: 'website-change' });
      await press();
    };
    // 코드 칸은 사이트 사용보다 먼저 사용자에게 넘긴다. 그다음 사이트 사용(계정 사용)과 비밀의 끔 여부를 본다.
    const assertSecretUse = () => assertPolicy(actor, 'fill-secret', page.url(), tab, { policyAction: 'account-use', item: secret.item ?? null });
    const invalidTarget = () => error('BROWSER_SECRET_TARGET_INVALID', 'Choose a text or password field for this secret.');
    const userCode = () => error('BROWSER_USER_CODE_REQUIRED', "The user must enter this one-time code. Call browser_request_account with kind 'code'.");
    if (tab.snapshot?.native && selectedAdapter()?.secretFill) {
      // 금고를 열기 전에 관찰한 요소 정보로 먼저 거른다. 데스크톱이 입력 직전에 다시 확인한다.
      const element = requireRef(tab, args);
      if (!(element.tag === 'textarea' || element.tag === 'input' && SECRET_INPUT_TYPES.has(element.inputType)) || element.disabled) throw invalidTarget();
      if (element.autocomplete === 'one-time-code') throw userCode();
      let formOrigin = null;
      try { formOrigin = element.formAction ? new URL(element.formAction).origin : null; } catch { formOrigin = 'null'; }
      if (formOrigin && !sameSite(formOrigin, origin)) throw error('BROWSER_SECRET_FORM_ORIGIN', 'This form sends its data to another website.');
      await assertSecretUse();
      const value = await secret.resolve();
      protect(value);
      const watch = watchConsequences(tab);
      try {
        await selectedAdapter().secretFill({ ...nativePasswordBinding(tab), snapshotId: args.snapshotId, ref: args.ref, origins: allowed, value });
        tab.snapshot.passwordProtected = true; forgetVisit(tab);
        await submit(() => selectedAdapter().passwordAction({ ...nativePasswordBinding(tab), action: 'press', key: 'Enter', ref: args.ref, snapshotId: args.snapshotId }));
        return { completed: true, consequences: await watch.settle() };
      } finally { watch.stop(); }
    }
    if (tab.snapshot?.native) throw error('BROWSER_NATIVE_UNAVAILABLE', 'This desktop browser cannot enter secrets yet. Update the app.', true);
    const handle = await elementFor(tab, args);
    const frame = await handle.ownerFrame();
    let frameOrigin = 'null';
    try { frameOrigin = new URL(frame?.url() ?? '').origin; } catch {}
    if (!frame || !onSecretSite(frameOrigin)) throw outside();
    const matches = async (selector) => { const node = await handle.$(selector); await node?.dispose(); return !!node; };
    const isInput = await matches('xpath=self::input');
    const type = ((await handle.getAttribute('type')) || 'text').trim().toLowerCase();
    const autocomplete = ((await handle.getAttribute('autocomplete')) ?? '').trim().toLowerCase();
    if (!(isInput ? SECRET_INPUT_TYPES.has(type) : await matches('xpath=self::textarea'))) throw invalidTarget();
    if (autocomplete === 'one-time-code') throw userCode();
    if (autocomplete.startsWith('cc-')) throw invalidTarget();
    if ((await formDestinations(handle)).some((destination) => !sameSite(destination, frameOrigin))) throw error('BROWSER_SECRET_FORM_ORIGIN', 'This form sends its data to another website.');
    await assertSecretUse();
    try {
      await handle.waitForElementState('visible', { timeout: 5_000 });
      await handle.waitForElementState('editable', { timeout: 5_000 });
    } catch { throw error('BROWSER_NOT_EDITABLE', 'The field is not visible and editable. Take a new snapshot and choose another field.'); }
    epochs(tab, args, true); assertController(actor, tab);
    if (topOrigin() !== origin || await handle.ownerFrame() !== frame) throw error('BROWSER_CREDENTIAL_TARGET_CHANGED', 'The page changed before the secret was entered. Take a new snapshot.');
    const value = await secret.resolve();
    protect(value);
    // 이후 관찰은 이 칸을 비공개 칸으로 다룬다.
    await handle.evaluate((el) => el.setAttribute('data-rhwp-private-field', 'true'));
    if (topOrigin() !== origin) throw error('BROWSER_CREDENTIAL_TARGET_CHANGED', 'The page changed before the secret was entered. Take a new snapshot.');
    const watch = watchConsequences(tab);
    try {
      // Playwright 의 격리된 선택 엔진으로 입력한다. 사이트가 바꾼 setter 를 거치지 않는다.
      await handle.fill(value, { timeout: 10_000 });
      await submit(async () => (await elementFor(tab, args)).press('Enter', { timeout: 10_000 }));
      return { completed: true, consequences: await watch.settle() };
    } finally { watch.stop(); }
  };

  const inventory = async (actor) => {
    validateActor(actor);
    passkeys = await inspectMacPasskeyCapability();
    // 네이티브 창의 중지·완료 이벤트로 새로 읽을 때 실제 로딩 종료도 반영한다.
    if (runtime && state === 'ready' && selectedAdapter()?.inventory) {
      const native = await selectedAdapter().inventory();
      for (const tab of tabs.values()) {
        const current = tab.nativeTargetId && native.find((entry) => entry.nativeTargetId === tab.nativeTargetId);
        if (tab.page && !tab.page.isClosed() && tab.status === 'loading' && current?.loading === false && !current.crashed && !current.error) tab.status = 'ready';
        if (current) tab.passwordShielded = current.passwordProtected === true;
        if (tab.passwordShielded) forgetVisit(tab);
      }
    }
    const visible = [];
    for (const tab of tabs.values()) {
      if (actor.isHuman ? tab.system : !canAccessTab(actor, tab)) continue;
      let current = actor.isHuman ? humanTab(tab) : descriptor(tab);
      if (!actor.isHuman) try { await assertPolicy(actor, 'snapshot', tab.page?.url?.() ?? tab.url, tab); }
      catch (failure) { current = { ...current, url: 'about:blank', title: '', status: 'approval-required', challenge: null, snapshotId: null, ...(failure.site ? { site: failure.site, request: failure.request } : {}) }; }
      visible.push(current);
    }
    const accounts = await runtimeAccounts(actor);
    const activeTabId = visible.find(tab => tab.tabId === actor.activeBrowserTabId)?.tabId ?? null;
    const sites = policy?.siteStatus ? await policy.siteStatus(actor, { profileId: profileId() }).catch(() => []) : [];
    return { ok: true, action: 'status', runtime: runtimeInfo(), tabs: visible, activeTabId, limits, accounts, sites };
  };
  /**
   * 활성 런타임의 로그인만 보인다(네이티브면 데스크톱 보관함, 관리형이면 허브 로그인). 에이전트에게는 지금 채울 수 있는지(usable)를 함께 준다.
   */
  const runtimeAccounts = async (actor) => {
    const listed = runtimeMode === 'native' ? (await selectedAdapter()?.passwordAccounts?.().catch(() => null))?.accounts
      : (await credentialBroker?.listAccounts?.().catch(() => null))?.accounts?.filter((account) => account.profileId === 'default');
    const accounts = [];
    for (const account of listed ?? []) {
      let site; try { site = siteScope(account.origin).domain ?? new URL(account.origin).host; } catch { continue; }
      const agentBlocked = account.agentBlocked === true;
      const row = { id: account.id, label: account.label, origin: account.origin, site, agentBlocked, source: runtimeMode === 'native' ? 'vault' : 'hub' };
      if (actor.isHuman) { accounts.push({ ...account, ...row }); continue; }
      const decision = policy?.check ? await policy.check({ actor, action: 'account-use', url: account.origin, profileId: profileId(), item: { accountId: account.id, blocked: agentBlocked } }).catch(() => null) : null;
      accounts.push({ ...row, usable: decision?.allowed === true });
    }
    return accounts;
  };
  // 비밀번호 칸은 계정 도구로, 일회용 코드 칸은 사용자에게. 사이트 사용보다 먼저 판단한다.
  const assertTypingTarget = async (tab, args) => {
    if (!args.ref) return;
    const element = requireRef(tab, args);
    let type; let autocomplete;
    if (tab.snapshot.native) { type = element.inputType; autocomplete = element.autocomplete; }
    else { const handle = await elementFor(tab, args); type = (await handle.getAttribute('type'))?.toLowerCase(); autocomplete = (await handle.getAttribute('autocomplete'))?.trim().toLowerCase(); }
    if (autocomplete === 'one-time-code') throw error('BROWSER_USER_CODE_REQUIRED', "The user must enter this one-time code. Call browser_request_account with kind 'code' and this tabId, then end the turn.");
    if (type === 'password' || ['current-password', 'new-password'].includes(autocomplete)) throw error('BROWSER_SECRET_CHANNEL_REQUIRED', "Fill passwords with browser_fill_account (a saved login) or browser_fill_secret. If the site has no saved login, call browser_request_account with kind 'account'.");
  };
  /**
   * 조작 전에 사이트 변경으로 보는 경우: 명시한 website-change, 그리고 non-GET 폼을 제출하는 클릭·Enter.
   * 보통 버튼, 입력, 선택, GET 폼(검색)은 자유롭다. 실제로 나가는 요청은 경로에서 다시 판정한다.
   */
  const raisesChange = async (tab, action, args) => {
    if (args.intent === 'website-change') return true;
    const submitKey = (action === 'press' && args.key === 'Enter') || (action === 'type' && args.submit === true);
    if ((action !== 'click' && !submitKey) || !args.ref) return false;
    const element = requireRef(tab, args);
    const changing = (method) => !!method && !['get', 'dialog'].includes(String(method).trim().toLowerCase());
    if (tab.snapshot.native) {
      // 네이티브 관찰은 button 의 type 을 모른다. 확실한 제출(submit·image 입력, 입력 칸의 Enter)만 미리 막고 나머지는 경로가 판정한다.
      const submitter = action !== 'click' ? element.tag === 'input' : element.tag === 'input' && ['submit', 'image'].includes(element.inputType);
      return submitter && changing(element.formMethod);
    }
    const handle = await elementFor(tab, args);
    const form = await handle.$('xpath=ancestor-or-self::form[1]');
    if (!form) return false;
    try {
      let formmethod = null;
      if (action === 'click') {
        const is = async (selector) => { const node = await handle.$(selector); await node?.dispose(); return !!node; };
        const type = ((await handle.getAttribute('type')) ?? '').trim().toLowerCase();
        const submits = await is('xpath=self::button') ? !type || type === 'submit' : await is('xpath=self::input') && ['submit', 'image'].includes(type);
        if (!submits) return false;
        formmethod = await handle.getAttribute('formmethod');
      }
      return changing(formmethod || await form.getAttribute('method') || 'get');
    } finally { await form.dispose(); }
  };
  // 연구 탭을 조용히 닫는다(browser_open urls 가 연 탭). 사용자 화면에는 닫힌 탭으로 알린다.
  const closeQuietly = (tab) => enqueue(tab, async () => {
    if (tabs.get(tab.tabId) !== tab) return;
    await releaseInput(tab); await tab.page?.close().catch(() => {});
    tab.status = 'closed'; tabs.delete(tab.tabId); publish(tab); await persist();
  });
  const READ_MANY_LIMIT = 6;
  /**
   * browser_open urls: 주소 여러 개를 연구 탭으로 동시에 열어(이 에이전트의 남은 탭 수만큼) 읽을 글을 짧게 돌려주고, keep 이 아니면 닫는다.
   * 주소마다 browser_open 과 같은 정책을 거치고, 실패는 그 주소의 결과로만 남는다.
   */
  const readMany = async (actor, args) => {
    if (actor.isHuman) throw error('BROWSER_ACTION_INVALID', 'Reading many pages is an agent research tool.');
    const urls = [...new Set((Array.isArray(args.urls) ? args.urls : []).filter((url) => typeof url === 'string'))];
    if (!urls.length || urls.length > READ_MANY_LIMIT) throw error('BROWSER_READ_INVALID', `Pass between 1 and ${READ_MANY_LIMIT} URLs.`);
    const maxChars = Math.floor(bounded(args.maxChars, 500, 8_000, 3_000));
    const mine = [...tabs.values()].filter((tab) => sameScope(actor, tab)).length;
    const slots = Math.min(limits.maxTabsPerAgent - mine, limits.maxTabs - tabs.size);
    if (slots < 1) throw error('BROWSER_TAB_LIMIT', 'Close an unused browser tab before reading more pages.');
    if (args.keep === true && urls.length > slots) throw error('BROWSER_TAB_LIMIT', `Only ${slots} more tabs fit. Read fewer pages with keep, or close tabs.`);
    const readOne = async (url) => {
      let tab;
      try {
        const opened = await performRequest(actor, 'open', { url, ...(args.intent ? { intent: args.intent } : {}) });
        tab = opened.tab && tabs.get(opened.tab.tabId);
        if (!opened.ok || !tab) return { url, ok: false, error: { code: opened.code ?? 'BROWSER_ACTION_FAILED', message: opened.message ?? 'The page could not be opened.' } };
        const page = requirePage(tab);
        await page.waitForLoadState('load', { timeout: 8_000 }).catch(() => {});
        let timer;
        const read = await Promise.race([enqueue(tab, async () => {
          await assertPolicy(actor, 'snapshot', page.url(), tab);
          if (tab.pendingDialog) throw dialogPending(tab);
          if (protectedPage(tab)) throw passwordProtected('Open it with browser_open and use browser_snapshot.');
          return page.evaluate(pageReadableText);
        }), new Promise((_, reject) => { timer = setTimeout(() => reject(error('BROWSER_ACTION_TIMEOUT', 'The page did not become readable in time.', true)), 10_000); })]).finally(() => clearTimeout(timer));
        const secrets = protectedFor(tab);
        const compact = compactText(redactValues(read.text, secrets), { find: args.find, maxChars });
        return { url: citationURL(page.url()) ?? publicURL(page.url()), title: redactValues(text(read.title || tab.title, 300), secrets), ok: true, ...compact,
          ...(args.keep === true ? { tabId: tab.tabId, navigationEpoch: tab.navigationEpoch, controllerEpoch: tab.controllerEpoch } : {}) };
      } catch (failure) {
        const mapped = failure instanceof OwnedBrowserError || failure.code?.startsWith('BROWSER_') ? failure : browserActionFailure(failure);
        return { url, ok: false, error: { code: mapped.code, message: mapped.message, ...(mapped.site ? { site: mapped.site } : {}), ...(mapped.request ? { request: mapped.request } : {}) } };
      } finally {
        if (tab && args.keep !== true) await closeQuietly(tab).catch(() => {});
      }
    };
    const pages = new Array(urls.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(slots, urls.length) }, async () => { while (next < urls.length) { const index = next++; pages[index] = await readOne(urls[index]); } }));
    return { ok: true, action: 'read-many', pages };
  };
  const performRequest = async (actor, action, args = {}) => {
    // browser_open 의 urls 는 여러 쪽을 함께 읽는다(감시도 'read-many' 로 부른다).
    if (action === 'read-many' || action === 'open' && Array.isArray(args.urls)) return readMany(actor, args);
    // browser_type 의 key 는 글자 입력 대신 키 하나를 누른다.
    if (action === 'type' && typeof args.key === 'string' && args.text === undefined) action = 'press';
    // browser_click 의 hover·dragTo·dragBy 는 포인터 조작이다. 누르기와 달리 폼 제출 판정을 받지 않는다.
    if (action === 'click' && (args.hover === true || args.dragTo || args.dragBy)) {
      const { hover, dragTo, dragBy, ...rest } = args;
      if (hover === true) { action = 'hover'; args = rest; }
      else { action = 'drag'; args = { ...rest, ...(dragTo ? { targetRef: dragTo } : {}), ...(dragBy ? { offsetX: dragBy.x, offsetY: dragBy.y } : {}) }; }
    }
    validateActor(actor);
    if ((resetting || resetFailed) && !['status', 'reset-browser'].includes(action)) throw error('BROWSER_RESET_REQUIRED', 'Complete browser cleanup in Settings before using the browser.', true);
    if (action === 'reset-browser') {
      if (!actor.isHuman) throw error('BROWSER_HUMAN_REQUIRED', 'Browser cleanup is managed from Settings.');
      if (!credentialBroker?.resetBrowserData) throw error('BROWSER_RESET_UNAVAILABLE', 'The browser account store is unavailable.');
      if (resetting) throw error('BROWSER_RESET_ACTIVE', 'Browser cleanup is already running.', true);
      resetting = true; emit('owned_browser_runtime', { runtime: runtimeInfo() });
      try { const result = await credentialBroker.resetBrowserData({ actor }); return { ok: true, action, ...result, runtime: runtimeInfo(), tabs: [] }; }
      catch (failure) { resetting = false; resetFailed = true; throw failure; }
    }
    if (!actor.isHuman && action !== 'status' && (signIn || handoffPending || siteFinish)) throw error('BROWSER_SIGN_IN_ACTIVE', 'The user owns the browser profile during sign-in. Wait for account confirmation.', true);
    // 다시 시작한 뒤 첫 에이전트 관찰 전에 예전에 입력한 값을 가릴 목록에 다시 넣는다.
    if (!actor.isHuman) await loadProtected();
    if (action === 'status') { passkeys = await inspectMacPasskeyCapability(); return { ...(await inventory(actor)), ...(typeof args.history === 'string' ? { history: await visitedSites(actor, args.history) } : {}), readiness: state === 'ready' ? { state: 'ready', installed: true, passkeys }
      // 데스크톱 내장 브라우저는 관리형 Chromium 설치와 무관하다. 첫 탭을 열 때 시작된다.
      : selectedAdapter() ? { state: 'ready', installed: true, message: 'The desktop browser starts with the first tab.', passkeys }
      : await inspectOwnedBrowserRuntime({ dataDir }) }; }
    if (action === 'install') {
      if (!actor.isHuman) throw error('BROWSER_HUMAN_REQUIRED', 'Browser installation is managed from Browser settings.');
      installPromise ??= installOwnedBrowserRuntime({ dataDir, onProgress: (progress) => emit('owned_browser_runtime', { runtime: { ...runtimeInfo(), ...progress } }) }).finally(() => { installPromise = null; });
      return { ok: true, action, readiness: await installPromise };
    }
    if (action === 'configure') {
      if (!actor.isHuman) throw error('BROWSER_HUMAN_REQUIRED', 'Browser configuration is managed by the user.');
      if (signIn || handoffPending) throw error('BROWSER_SIGN_IN_ACTIVE', 'Finish the current sign-in before changing browser mode.');
      if ([...tabs.values()].some((tab) => tab.page && !tab.page.isClosed())) throw error('BROWSER_TABS_OPEN', 'Close browser tabs before changing runtime mode.');
      if (!['managed', 'native'].includes(args.mode)) throw error('BROWSER_CONFIGURATION_INVALID', 'Choose a managed or native browser.');
      if (args.mode === 'native' && !nativeAdapter) throw error('BROWSER_NATIVE_UNAVAILABLE', 'The native desktop browser is unavailable on this hub.');
      await saveCheckpoint().catch(() => {}); await runtime?.close(); runtime = null; state = 'idle';
      runtimeMode = args.mode; if (typeof args.headless === 'boolean') headless = args.headless;
      await fs.mkdir(path.dirname(descriptorFile), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(dataDir, 'browser', 'runtime.json'), JSON.stringify({ version: 1, mode: runtimeMode, headless }), { mode: 0o600 });
      return { ok: true, action, runtime: runtimeInfo() };
    }
    if (action === 'sign-in') {
      if (!actor.isHuman) throw error('BROWSER_HUMAN_REQUIRED', 'Open full-browser sign-in from Browser settings.');
      const url = guard.parse(args.url ?? 'https://accounts.google.com/').href;
      const account = credentialBroker?.listAccounts && (await credentialBroker.listAccounts()).accounts.find((entry) => entry.id === args.accountId);
      if (!account || account.profileId !== 'default' || !account.origins.includes(new URL(url).origin)) throw error('BROWSER_ACCOUNT_REGISTRATION_REQUIRED', 'Add and approve this website account in Browser settings before opening full-browser sign-in.');
      if (signIn || handoffPending) throw error('BROWSER_SIGN_IN_ACTIVE', 'Finish the current sign-in before opening another account.');
      await beginHandoff({ url, authenticationMethod: args.authenticationMethod, accountId: account.id });
      return { ok: true, action, runtime: runtimeInfo(), signIn: { mode: 'standalone-no-debug', accountId: account.id, message: 'Complete sign-in in the separate Chromium window, then confirm the account in Browser settings.' } };
    }
    if (action === 'sign-in-site') {
      // 사용자가 누른 사이트 하나를 Google Chrome에서 로그인한다. 누른 것 자체가 그 사이트의 승인이다.
      if (!actor.isHuman) throw error('BROWSER_HUMAN_REQUIRED', 'Chrome sign-in is started by the user.');
      if (signIn || handoffPending || siteFinish || signInSite) throw error('BROWSER_SIGN_IN_ACTIVE', 'Finish the current sign-in first.', true);
      if (runtimeMode !== 'native' || !nativeAdapter?.importSession) throw error('BROWSER_SITE_SIGN_IN_UNAVAILABLE', 'Chrome sign-in needs the desktop browser.');
      const url = guard.parse(args.url).href;
      // 등록 도메인이 있는 HTTPS 사이트만 받는다. 공용 접미사(github.io, co.uk)·IP·localhost는 사이트 하나가 아니다.
      const parsed = new URL(url).protocol === 'https:' ? parseDomainName(new URL(url).hostname, { allowPrivateDomains: true }) : null;
      const site = parsed && !parsed.isIp && parsed.domain ? parsed.domain : null;
      if (!site) throw error('BROWSER_SITE_SIGN_IN_UNAVAILABLE', 'Chrome sign-in needs an HTTPS website.');
      await beginHandoff({ url, authenticationMethod: 'mac-passkey', accountId: null, site,
        // 사용자가 Chrome 창을 닫으면 로그인이 끝난 것으로 본다.
        onWindowsClosed: () => { void finishSiteSignIn({ importSession: true }).catch(() => {}); } });
      return { ok: true, action, runtime: runtimeInfo() };
    }
    if (action === 'sign-in-site-finish' || action === 'sign-in-site-cancel') {
      if (!actor.isHuman) throw error('BROWSER_HUMAN_REQUIRED', 'Chrome sign-in is finished by the user.');
      if (!signInSite && !siteFinish) throw error('BROWSER_SIGN_IN_INACTIVE', 'No Chrome sign-in is open.');
      const site = await finishSiteSignIn({ importSession: action === 'sign-in-site-finish' });
      return { ok: true, action, ...(site ? { site: site.domain } : {}), runtime: runtimeInfo() };
    }
    if (action === 'confirm-sign-in') {
      if (!actor.isHuman || !credentialBroker?.confirmAccountSession) throw error('BROWSER_HUMAN_REQUIRED', 'Confirm the signed-in account from Browser settings.');
      if (handoffPending) throw error('BROWSER_SIGN_IN_ACTIVE', 'Wait for the sign-in browser to open before confirming the account.');
      if (signIn) {
        if (args.accountId !== signInAccountId) throw error('BROWSER_ACCOUNT_IDENTITY_MISMATCH', 'Confirm the account selected for this sign-in window.');
        await signIn.close(); signIn = null; signInAccountId = null; handoffProfile = true; state = 'idle';
        await ensureRuntime();
      }
      const result = await credentialBroker.confirmAccountSession({ actor, accountId: args.accountId, ...(handoffPreviousMode === 'native' ? { additionalProfileId: 'native' } : {}) });
      const account = result.account ?? result;
      const confirmedStorage = await browserStorageState();
      await refreshCookieSites({ force: true });
      await persist();
      await saveCheckpoint();
      if (handoffPreviousMode === 'native') await returnFromSignIn(account, confirmedStorage);
      handoffPreviousMode = null;
      return { ok: true, action, account, runtime: runtimeInfo() };
    }
    if (action === 'downloads') {
      if (!downloads) throw error('BROWSER_DOWNLOADS_UNAVAILABLE', 'Managed downloads are unavailable.');
      const operation = args.action ?? 'list';
      if (operation === 'list') {
        // 막힌 다운로드도 에이전트가 보게 한다. 같은 다운로드를 다시 누르지 않고 카드를 부를 수 있다.
        const denied = [...tabs.values()].filter((tab) => (actor.isHuman || canAccessTab(actor, tab)) && tab.lastDownloadDenial && Date.now() - tab.lastDownloadDenial.at < 10 * 60_000)
          .map((tab) => ({ tabId: tab.tabId, ...tab.lastDownloadDenial.denial }));
        return { ok: true, action, downloads: await downloads.list(actor), ...(denied.length ? { denied } : {}) };
      }
      if (operation === 'reveal') {
        if (!actor.isHuman || !selectedAdapter()?.revealDownload) throw error('BROWSER_HUMAN_REQUIRED', 'Show downloaded files from the desktop browser.');
        const job = await downloads.save({ ...args, actor });
        await selectedAdapter().revealDownload({ filePath: job.savedPath });
        return { ok: true, action, job };
      }
      if (!['cancel', 'retry', 'import', 'save'].includes(operation)) throw error('BROWSER_ACTION_INVALID', 'Unsupported download action.');
      const method = operation === 'import' ? downloads.importDownload : downloads[operation];
      const job = await method.call(downloads, { ...args, actor });
      return { ok: true, action, download: job, job };
    }
    if (action === 'open') {
      const url = args.url && args.url !== 'about:blank' ? guard.parse(args.url).href : 'about:blank';
      await assertPolicy(actor, action, url, null, args);
      if (!actor.isHuman && googleResearchURL(url)) {
        const blocked = [...tabs.values()].find((tab) => canAccessTab(actor, tab) && challengeFor(tab));
        if (blocked) {
          await assertPolicy(actor, 'snapshot', requirePage(blocked).url(), blocked);
          blocked.searchQuery ||= new URL(url).searchParams.get('q') || undefined;
          publish(blocked); return challengeResult(action, blocked);
        }
      }
      if (tabs.size >= limits.maxTabs || !actor.isHuman && [...tabs.values()].filter((tab) => sameScope(actor, tab)).length >= limits.maxTabsPerAgent) throw error('BROWSER_TAB_LIMIT', 'Close an unused browser tab before opening another.');
      await ensureRuntime();
      if (closed) throw error('BROWSER_CLOSED', 'The browser service has closed.');
      if (resetting || resetFailed) throw error('BROWSER_RESET_REQUIRED', 'Complete browser cleanup before opening another page.');
      if (signIn || handoffPending) throw error('BROWSER_SIGN_IN_ACTIVE', 'The user owns the browser profile during sign-in.', true);
      await assertPolicy(actor, action, url, null, args);
      const tab = makeTab(actor);
      if (actor.isHuman && args.transient === true) tab.transient = true;
      if (googleResearchURL(url)) tab.searchQuery = new URL(url).searchParams.get('q') || undefined;
      tabs.set(tab.tabId, tab);
      tab.blocked = null; tab.dropped = null; tab.navHops = []; tab.changePermitted = false;
      try {
        await attach(tab, await runtime.context.newPage());
        // 새 탭을 만든 화면은 탐색과 계정 저장을 기다리지 않고 즉시 해당 탭을 표시한다.
        if (actor.isHuman && typeof args.openRequestId === 'string' && args.openRequestId.length <= 160) emit('owned_browser_tab', { tab: descriptor(tab), runtime: runtimeInfo(), openRequestId: args.openRequestId });
        previewActivity(actor, tab); tab.activeActor = actor; if (url !== 'about:blank') await tab.page.goto(url, { waitUntil: 'domcontentloaded' });
        // 첫 요청이나 리디렉트가 도착한 곳(로그인한 하위 도메인 등)이 거절되면 그 거절을 돌려준다.
        if (tab.blocked) throw tab.blocked;
        if (!actor.isHuman) await assertLanding(actor, tab);
      }
      catch (failure) { await tab.page?.close().catch(() => {}); tabs.delete(tab.tabId); throw tab.blocked ?? (failure instanceof OwnedBrowserError || failure.code?.startsWith('BROWSER_') ? failure : browserActionFailure(failure)); }
      finally { previewActivity(actor, tab, false); tab.activeActor = null; }
      void refreshCookieSites();
      publish(tab); await persist(); return !actor.isHuman && challengeFor(tab) ? challengeResult(action, tab) : { ok: true, action, runtime: runtimeInfo(), tab: descriptor(tab) };
    }
    const tab = ownedTab(actor, args.tabId);
    // 열린 대화상자는 페이지를 멈춘다. 에이전트의 다른 조작은 기다리지 않고 대화상자를 알린다(답은 browser_dialog).
    if (!actor.isHuman && tab.pendingDialog && !['dialog', 'close'].includes(action) && await dialogStillOpen(tab)) throw dialogPending(tab);
    tab.lastActivityAt = Date.now();
    if (tab.sleeping && !['close', 'reconnect', 'sleep'].includes(action)) await wakeTab(actor, tab);
    if (action === 'sleep') {
      if (!actor.isHuman) throw error('BROWSER_HUMAN_REQUIRED', 'Manual tab sleep is controlled by the user.');
      assertController(actor, tab);
      return enqueue(tab, async () => ({ ok: true, action, ...await sleepTab(tab, { manual: true, discard: args.discard === true }), tab: descriptor(tab), runtime: runtimeInfo() }));
    }
    if (action === 'reconnect') {
      if (!actor.isHuman) throw error('BROWSER_HUMAN_REQUIRED', 'Browser presentation reconnect is managed by the editor.');
      if (!selectedAdapter()) throw error('BROWSER_RECONNECT_REQUIRED', 'This browser does not have a native presentation.', true);
      return enqueue(tab, async () => {
        const previousSession = tab.sessionId;
        tab.sessionId = actor.sessionId ?? previousSession;
        try {
          await ensureRuntime();
          if (tabs.get(tab.tabId) !== tab) throw error('BROWSER_TAB_NOT_FOUND', 'This browser tab was closed.');
          if (args.restore === true && tab.page && !tab.page.isClosed() && tab.nativeTargetId && selectedAdapter().inventory) {
            const inventory = await selectedAdapter().inventory();
            if (!inventory.some(entry => entry.nativeTargetId === tab.nativeTargetId)) {
              // 네이티브 종료 알림보다 화면 복원이 먼저 도착해도 오래된 페이지를 재사용하지 않는다.
              tab.page = null; tab.nativeTargetId = undefined;
            }
          }
          if ((!tab.page || tab.page.isClosed()) && (tab.restorePending || args.restore === true)) {
            // 앱 재시작으로 사라진 게스트만 복원한다. 입력과 조작 권한은 재생하지 않는다.
            let url = tab.url;
            if (googleResearchURL(url) && tab.searchQuery) {
              const search = new URL('/search', url); search.searchParams.set('q', tab.searchQuery); url = search.href;
            }
            // 화면 복원은 사용자의 요청이다. 탭의 에이전트 조작권과 계정 승인은 유지한다.
            await assertPolicy(actor, 'browse', url, tab);
            if (url !== 'about:blank') await guard.resolve(url);
            const page = await runtime.context.newPage();
            try {
              tab.activeActor = actor;
              await attach(tab, page);
              if (url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded' });
            } catch (failure) {
              await page.close().catch(() => {});
              tab.page = null; tab.nativeTargetId = undefined;
              throw failure;
            } finally { tab.activeActor = null; }
            tab.restorePending = false;
            tab.status = 'ready'; invalidate(tab); publish(tab); await persist();
          }
          requirePage(tab);
          tab.restorePending = false; tab.sleeping = false;
          // 허브만 재시작한 경우 기존 게스트를 유지하며 현재 창에 다시 바인딩한다.
          const nativeState = await selectedAdapter().bind({ targetId: tab.nativeTargetId, tabId: tab.tabId, sessionId: tab.sessionId, chatId: tab.threadId, global: tab.scope === 'global' });
          tab.nativeGeneration = nativeState?.generation;
          tab.zoomFactor = nativeState?.zoomFactor;
        } catch (failure) { tab.sessionId = previousSession; throw failure; }
        return { ok: true, action, tab: descriptor(tab), runtime: runtimeInfo() };
      });
    }
    if (action === 'recover') {
      if (!actor.isHuman) throw error('BROWSER_HUMAN_REQUIRED', 'Recover disconnected pages from Browser settings.');
      await ensureRuntime();
      tab.activeActor = actor;
      try { if (!tab.page) { tab.sessionId = actor.sessionId ?? tab.sessionId; tab.controllerEpoch++; invalidate(tab); await attach(tab, await runtime.context.newPage()); if (tab.url !== 'about:blank') { await guard.resolve(tab.url); await tab.page.goto(tab.url, { waitUntil: 'domcontentloaded' }); } } }
      finally { tab.activeActor = null; }
      tab.status = 'ready'; tab.controller = { owner: tab.scope === 'global' ? 'human' : 'agent' };
      await selectedAdapter()?.control?.(nativeControl(tab));
      publish(tab); return { ok: true, action, tab: descriptor(tab), runtime: runtimeInfo(), recovery: 'Page reloaded. Previous uncertain actions were not replayed.' };
    }
    if (action === 'control') {
      if (!actor.isHuman) throw error('BROWSER_HUMAN_REQUIRED', 'Only the user can transfer browser control.');
      if (args.owner !== undefined && args.owner !== 'human' && args.owner !== 'agent') throw error('BROWSER_CONTROL_INVALID', 'Choose human or agent control.');
      assertController(actor, tab);
      epochs(tab, args);
      // 조작권은 사용자만 옮긴다. 가져가면 held로 에이전트의 페이지 변경을 바로 막고, 돌려주면 탭 범위의 기본 소유로 돌아간다.
      // 실행 중인 에이전트 작업은 끝난 뒤 넘겨받는다.
      const held = args.owner === undefined ? userHolds(tab) : args.owner === 'human';
      const epoch = ++tab.controllerEpoch;
      tab.controller = held ? { owner: 'human', held: true } : { owner: tab.scope === 'global' ? 'human' : 'agent' };
      if (!held) tab.humanDriven = false;
      credentialBroker?.invalidateTab?.(tab.tabId);
      publish(tab);
      // Invalidate queued agent input immediately, then drain before confirming the transfer.
      await dismissPendingDialog(tab);
      await tab.queue.catch(() => {}); await releaseInput(tab);
      if (epoch === tab.controllerEpoch && selectedAdapter()?.control) await selectedAdapter().control(nativeControl(tab));
      publish(tab); return { ok: true, action, tab: descriptor(tab), runtime: runtimeInfo() };
    }
    const mutating = MUTATIONS.has(action);
    // 편집기의 탭 닫기는 페이지 입력 조작권을 넘겨받지 않아도 실행한다.
    const requiresControl = mutating && !(action === 'close' && actor.isHuman);
    // 사용자가 잡은 탭은 에포크보다 먼저 확인해 에이전트 변경을 바로 거절한다(assertController).
    if (requiresControl) assertController(actor, tab);
    // 대화상자 답은 열린 대화상자 자체가 대상이라 세대를 요구하지 않는다(주면 확인한다).
    epochs(tab, args, mutating && action !== 'dialog');
    // 사용자가 잡은 탭의 에이전트 읽기는 대기열 밖에서 관찰만 한다. 사용자 입력을 기다리게 하지 않는다.
    const observeOnly = !actor.isHuman && !mutating && userHolds(tab);
    const queuedControlEpoch = tab.controllerEpoch;
    const waitDeadline = action === 'wait' ? Date.now() + bounded(args.timeoutMs, 1, 30_000, 10_000) : undefined;
    const abort = waitDeadline === undefined ? null : new AbortController();
    const signal = abort?.signal;
    let waitTimer;
    const run = async () => {
      signal?.throwIfAborted();
      if (requiresControl) assertController(actor, tab);
      epochs(tab, args, mutating && action !== 'dialog');
      if (resetting || resetFailed) throw error('BROWSER_RESET_REQUIRED', 'Browser cleanup invalidated the pending action.');
      // 비밀번호 칸과 일회용 코드 칸은 사이트 사용보다 먼저 알린다. 둘 다 권한이 아니라 입력 경로의 문제다.
      if (!actor.isHuman && action === 'type') await assertTypingTarget(tab, args);
      // 지금 페이지를 쓰는 조작은 그 페이지를 읽을 수 있어야 한다. 닫기와 탐색(목적지를 따로 판정한다)은 묻지 않는다.
      if (!['close', 'navigate'].includes(action)) await assertPolicy(actor, action, requirePage(tab).url(), tab, { ...args, policyAction: args.intent === 'website-change' ? 'website-change' : 'read' });
      if (!actor.isHuman && challengeFor(tab) && (mutating && action !== 'close' && !(action === 'navigate' && args.url && !googleResearchURL(args.url)))) return challengeResult(action, tab);
      if (action === 'press') assertAgentKey(actor, args.key);
      if (!actor.isHuman && (signIn || handoffPending)) throw error('BROWSER_SIGN_IN_ACTIVE', 'The user owns the browser profile during sign-in.', true);
      if (requiresControl) assertController(actor, tab);
      epochs(tab, args, mutating && action !== 'dialog');
      if (!actor.isHuman && SETTLING.has(action)) {
        if (await raisesChange(tab, action, args)) await assertPolicy(actor, action, requirePage(tab).url(), tab, { intent: 'website-change' });
      }
      // 파일을 보내는 일은 늘 사이트 변경이다(non-GET 폼 제출과 같은 사이트 사용).
      if (!actor.isHuman && action === 'upload') await assertPolicy(actor, action, requirePage(tab).url(), tab, { intent: 'website-change' });
      // 관찰만 하는 읽기는 동시에 진행되는 사용자 입력의 네트워크 귀속을 바꾸지 않는다.
      if (!observeOnly) tab.activeActor = actor;
      if (!actor.isHuman && mutating) tab.humanDriven = false;
      const tracksDenials = !actor.isHuman && !observeOnly && action !== 'close';
      const startEpoch = tab.navigationEpoch;
      if (tracksDenials) {
        tab.blocked = null; tab.dropped = null; tab.navHops = []; tab.changePermitted = false;
        // 입력 창: 이 조작이 일으킨 같은 사이트 non-GET 은 사이트 변경이다. 새 문서가 열리면 끝난다.
        if (INPUT_WINDOW.has(action) || (action === 'type' && args.submit === true) || (action === 'fill-form' && !!args.submit)) tab.inputWindow = { documentEpoch: tab.documentEpoch ?? 0, threadId: actor.threadId, agentId: actor.agentId };
      }
      const downloadMark = tab.lastDownloadDenial;
      try {
        if (action === 'navigate' && args.url && googleResearchURL(args.url)) tab.searchQuery = new URL(args.url).searchParams.get('q') || tab.searchQuery;
        const adapter = selectedAdapter();
        const activity = adapter?.activity && action !== 'close' && !observeOnly ? {
          targetId: tab.nativeTargetId, tabId: tab.tabId, sessionId: tab.sessionId,
          chatId: tab.threadId, generation: runtime.nativeGeneration, token: id('activity'),
        } : null;
        let value; let renewal;
        try {
          if (activity) await abortable(adapter.activity({ ...activity, active: true }), signal);
          // 긴 작업 중에도 네이티브 활동 임대가 만료되지 않게 갱신한다.
          if (activity) { renewal = setInterval(() => { void adapter.activity({ ...activity, active: true, renew: true }).catch(() => {}); }, 10_000); renewal.unref?.(); }
          if (action !== 'close' && !observeOnly) previewActivity(actor, tab);
          value = await operate(actor, action, tab, waitDeadline === undefined ? args : { ...args, waitDeadline }, signal);
        } finally {
          clearInterval(renewal);
          if (tracksDenials) tab.inputWindow = null;
          const released = activity ? adapter.activity({ ...activity, active: false }).catch(() => {}) : null;
          if (released && !signal?.aborted) await released;
          if (action !== 'close' && !observeOnly) previewActivity(actor, tab, false);
        }
        signal?.throwIfAborted();
        if (action !== 'close' && !observeOnly) void refreshCookieSites();
        if (mutating && action !== 'close' && queuedControlEpoch !== tab.controllerEpoch) throw error('BROWSER_ACTION_UNCERTAIN', !actor.isHuman && userHolds(tab) ? 'The user took control during this action. Observe the page, then wait or ask the user before continuing.' : 'Control changed during the action. Observe the current page before deciding what to do next.', true);
        // 이 조작이 보낸 요청 중 정책이 막은 것이 있으면 그 거절을 돌려준다. 문서 요청은 이미 경로에서 판정했으므로 도착한 주소를 다시 묻지 않는다.
        if (tracksDenials && tab.blocked) throw tab.blocked;
        if (tracksDenials && (tab.navigationEpoch !== startEpoch || tab.navHops?.length)) await assertLanding(actor, tab);
        if (value.capture) { const eventCapture = { ...value.capture }; delete eventCapture.screenshot; emit('owned_browser_capture', { capture: eventCapture }); }
        publish(tab); if (!actor.isHuman && action !== 'close' && challengeFor(tab)) return challengeResult(action, tab);
        const extras = {
          ...(tracksDenials && tab.dropped?.length ? { dropped: tab.dropped } : {}),
          ...(tracksDenials && tab.lastDownloadDenial && tab.lastDownloadDenial !== downloadMark ? { downloadDenied: tab.lastDownloadDenial.denial } : {}),
        };
        if (value.consequences) {
          // 조작 결과는 바뀐 점만 돌려준다. 개요는 요청했을 때만 새로 읽고, 실패해도 이미 끝난 조작은 성공으로 남긴다.
          const { navigated, ...changes } = value.consequences; const current = descriptor(tab);
          const delta = { ok: true, action, navigated, url: current.url, title: current.title, ...(navigated ? { navigationEpoch: tab.navigationEpoch } : {}), ...changes, ...extras };
          if (args.snapshot === true) try { delta.snapshot = await snapshot(tab); } catch (failure) { delta.snapshotError = { code: failure.code?.startsWith('BROWSER_') ? failure.code : 'BROWSER_ACTION_FAILED', message: 'The page changed before it could be observed. Take a new snapshot.' }; }
          return delta;
        }
        return { ok: true, action, runtime: runtimeInfo(), tab: descriptor(tab), ...value, ...extras };
      } catch (failure) {
        // 주 프레임 거절은 'aborted' 로 끊기므로 탐색 오류로 보인다. 기록한 거절을 대신 돌려준다.
        if (tracksDenials && tab.blocked) throw tab.blocked;
        if (failure instanceof OwnedBrowserError || failure.code?.startsWith('BROWSER_')) throw failure;
        const mapped = browserActionFailure(failure);
        mapped.message = redactValues(mapped.message, protectedFor(tab));
        throw mapped;
      } finally { if (!observeOnly) tab.activeActor = null; }
    };
    // 대화상자 답은 대기열을 기다리지 않는다. 앞선 조작이 그 대화상자에 막혀 있을 수 있다.
    const queued = observeOnly || action === 'dialog' ? run() : enqueue(tab, run);
    if (!abort) return queued;
    // 기한이 지나면 대기열의 작업도 중단해 다음 조작을 막지 않는다.
    return Promise.race([queued, new Promise((_, reject) => {
      waitTimer = setTimeout(() => { const timeout = error('BROWSER_ACTION_TIMEOUT', 'The browser wait timed out.', true); abort.abort(timeout); reject(timeout); }, Math.max(1, waitDeadline - Date.now()));
    })]).finally(() => clearTimeout(waitTimer));
  };
  // 사용자 화면이 요청한 출처 중 이미 관계가 있는 출처(열린 탭, 저장된 계정, 대기 중인 요청 등)만 처음 받아 온다.
  const relatedOrigins = async () => {
    const related = new Set();
    const add = (value) => { const origin = faviconOrigin(value, isWorkspace); if (origin) related.add(origin); };
    for (const tab of tabs.values()) add(tab.page?.url?.() ?? tab.url);
    const accounts = [...((await credentialBroker?.listAccounts?.().catch(() => null))?.accounts ?? []), ...((await selectedAdapter()?.passwordAccounts?.().catch(() => null))?.accounts ?? [])];
    for (const account of accounts) for (const origin of [account.origin, ...(account.origins ?? [])]) add(origin);
    for (const origin of (await Promise.resolve(options.faviconOrigins?.()).catch(() => null)) ?? []) add(origin);
    return related;
  };
  const faviconsGet = async (actor, args = {}) => {
    validateActor(actor);
    if (!actor.isHuman) throw error('BROWSER_HUMAN_REQUIRED', 'Site icons are shown only in the editor.');
    if (resetting || resetFailed) throw error('BROWSER_RESET_REQUIRED', 'Complete browser cleanup in Settings before using the browser.', true);
    if (!Array.isArray(args.origins) || args.origins.length > 50) throw error('BROWSER_FAVICONS_INVALID', 'Request between 0 and 50 site origins.');
    const requested = [...new Set(args.origins.filter((origin) => typeof origin === 'string' && origin.length <= 2048))];
    const related = await relatedOrigins();
    const icons = {}, pending = [];
    for (const value of requested) {
      const origin = faviconOrigin(value, isWorkspace);
      icons[value] = null;
      if (origin !== value) continue;
      pending.push(async () => { const cached = await favicons.get(origin); icons[value] = cached !== undefined ? cached : related.has(origin) ? await favicons.discoverOrigin(origin) : null; });
    }
    // 처음 받는 출처가 많아도 네트워크 요청은 네 개씩만 동시에 보낸다.
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => { while (pending.length) await pending.shift()(); }));
    return { ok: true, action: 'favicons.get', icons };
  };
  const request = async (actor, action, args) => {
    if (action === 'favicons.get') return faviconsGet(actor, args);
    const result = await performRequest(actor, action, args);
    const tab = actor?.isHuman && result?.tab?.tabId && tabs.get(result.tab.tabId), faviconUrl = tab && faviconFor(tab);
    return faviconUrl ? { ...result, tab: { ...result.tab, faviconUrl } } : result;
  };
  return {
    request, inventory, sweepSleepingTabs,
    /** 허브만 부른다. resolve 는 입력 직전에 값을 돌려주고, origins 는 비밀의 사이트, item 은 정책이 볼 비밀(끔 여부 포함)이다. */
    fillSecret: (actor, args, { origins, resolve, item }) => performRequest(actor, 'fill-secret', { ...args, [SECRET_FILL]: { origins: [...origins], resolve, item } }),
    /** 허브만 부른다. files 는 출처를 확인해 읽은 { name, mimeType, buffer } 다(browser-upload-sources.mjs). */
    uploadFiles: (actor, args, files) => performRequest(actor, 'upload', { ...args, files: undefined, [UPLOAD_FILES]: files }),
    /** 사용자에게 넘긴 로그인·코드 입력이 끝났다. 사용자가 잡고 있던 그 탭을 에이전트에게 돌려준다. */
    async returnControl({ tabId } = {}) {
      const tab = tabs.get(tabId);
      if (!tab || !userHolds(tab)) return;
      tab.controllerEpoch++; tab.controller = { owner: tab.scope === 'global' ? 'human' : 'agent' }; tab.humanDriven = false;
      if (tab.page && !tab.page.isClosed()) await selectedAdapter()?.control?.(nativeControl(tab)).catch(() => {});
      publish(tab);
    },
    profileId,
    /** 쿠키가 있는 사이트와 저장된 로그인 사이트를 다시 읽는다(로그인 표시의 수명). */
    refreshSites: () => refreshCookieSites({ force: true }),
    /** 활성 런타임이 데스크톱 보관함을 쓰는가. 저장 카드와 사이트 카드의 로그인 목록이 이를 따른다. */
    usesNativeVault: () => runtimeMode === 'native' && !!nativeAdapter?.passwordAccounts,
    async nativeAccounts() {
      if (!nativeAdapter?.passwordAccounts) return [];
      return (await nativeAdapter.passwordAccounts()).accounts ?? [];
    },
    async nativeAccount(accountId) {
      if (!nativeAdapter?.passwordAccounts || typeof accountId !== 'string') return null;
      return ((await nativeAdapter.passwordAccounts()).accounts ?? []).find((account) => account.id === accountId) ?? null;
    },
    /** 보관함 로그인 하나의 에이전트 사용을 끄거나 켠다. */
    async setNativeLoginBlocked(accountId, blocked) {
      if (!nativeAdapter?.passwordBlock) throw error('BROWSER_NATIVE_UNAVAILABLE', 'The desktop password vault is unavailable.', true);
      const account = await nativeAdapter.passwordBlock({ accountId, blocked: blocked === true });
      void refreshCookieSites({ force: true });
      return account;
    },
    /** 저장 카드에서 받은 로그인을 데스크톱 보관함에 넣는다. 응답에는 비밀번호가 없다. */
    async saveNativeLogin({ origin, username, password }) {
      if (!nativeAdapter?.passwordSave) throw error('BROWSER_NATIVE_UNAVAILABLE', 'The desktop password vault is unavailable.', true);
      const account = await nativeAdapter.passwordSave({ origin, username, password });
      void refreshCookieSites({ force: true });
      return account;
    },
    /** 사용자가 Chrome 에서 가져온 로그인 세션. 그 사이트들에 로그인 표시를 남긴다. */
    async acceptImportedSessions(domains) {
      if (!Array.isArray(domains)) return { accepted: 0 };
      const roots = [...new Set(domains.filter((domain) => typeof domain === 'string' && /^[a-z0-9.-]{1,253}$/i.test(domain)).map((domain) => domain.replace(/^\./, '').toLowerCase()))];
      if (roots.length) await policy?.markSignedIn?.({ profileId: profileId(), domains: roots, source: 'chrome-import' });
      await refreshCookieSites({ force: true });
      return { accepted: roots.length };
    },
    configureSleep({ idleMinutes = 15 } = {}) {
      if (!Number.isInteger(idleMinutes) || idleMinutes < 0 || idleMinutes > 1440) throw error('BROWSER_CONFIGURATION_INVALID', 'Choose an idle timeout between 0 and 1440 minutes.');
      idleSleepMs = idleMinutes * 60_000;
    },
    /** 앱 안 브라우저가 데스크톱 네이티브 런타임인가. ChatGPT 연결은 이때만 쓴다. */
    nativeActive: () => runtimeMode === 'native' && !!nativeAdapter,
    /** 사용자가 별도 브라우저(Chrome)에서 로그인하는 중이라 앱 브라우저가 멈춰 있다. */
    signInActive: () => !!nativeAdapter && (!!signIn || handoffPending || !!siteFinish),
    /**
     * 허브 행위자(actor.system) 하나가 자기 탭의 페이지를 직접 다룬다. 탭이 없으면 url 로 열고, 작업은 탭 대기열에서 차례로 돈다.
     * 페이지 요청은 이 행위자로 정책을 받는다. 사용자가 탭을 잡고 있으면 기다리지 않고 거절한다.
     */
    async drive(actor, { url }, operation) {
      validateActor(actor);
      if (!actor.system || actor.isHuman) throw error('BROWSER_SCOPE_REQUIRED', 'Only a hub-owned browser actor can drive a page directly.');
      if (runtimeMode !== 'native' || !nativeAdapter) throw error('BROWSER_NATIVE_UNAVAILABLE', 'The desktop browser is unavailable.', true);
      let tab = [...tabs.values()].find((entry) => sameScope(actor, entry) && !['closed', 'crashed'].includes(entry.status));
      // 잠들었거나 끊긴 탭은 새로 붙인다. 앞선 실행의 편집기 창이 아니라 지금 부른 창에 붙인다.
      if (tab && actor.sessionId && (tab.sleeping || !tab.page || tab.page.isClosed())) tab.sessionId = actor.sessionId;
      if (tab?.sleeping) await wakeTab(actor, tab);
      if (tab && (!tab.page || tab.page.isClosed())) {
        await enqueue(tab, async () => { await ensureRuntime(); if (!tab.page || tab.page.isClosed()) { if (actor.sessionId) tab.sessionId = actor.sessionId; invalidate(tab); await attach(tab, await runtime.context.newPage()); tab.status = 'ready'; } });
      }
      if (!tab) {
        const opened = await performRequest(actor, 'open', { url });
        tab = tabs.get(opened?.tab?.tabId);
        if (!tab) throw error('BROWSER_TAB_NOT_FOUND', 'The browser tab could not be opened.', true);
      }
      return enqueue(tab, async () => {
        if (userHolds(tab)) throw error('BROWSER_USER_CONTROL', 'The user is controlling this tab.');
        if (!tab.page || tab.page.isClosed()) throw error('BROWSER_TAB_NOT_FOUND', 'The browser tab closed.', true);
        // 함께 쓰는 탭은 지금 부른 편집기 창에 다시 붙인다(데스크톱 탭은 주인 창이 있어야 한다).
        if (actor.sessionId && tab.sessionId !== actor.sessionId && tab.nativeTargetId && selectedAdapter()?.bind) {
          const nativeState = await selectedAdapter().bind({ targetId: tab.nativeTargetId, tabId: tab.tabId, sessionId: actor.sessionId, chatId: tab.threadId, global: false });
          tab.sessionId = actor.sessionId; tab.nativeGeneration = nativeState?.generation; tab.zoomFactor = nativeState?.zoomFactor;
        }
        tab.activeActor = actor; tab.lastActivityAt = Date.now();
        // 숨은 탭을 다루는 동안 데스크톱이 탭을 깨워 둔다(초점 흉내·백그라운드 제한 해제). 허브가 멈추면 30초 뒤 풀린다.
        const adapter = selectedAdapter();
        const activity = adapter?.activity && tab.nativeTargetId ? { targetId: tab.nativeTargetId, tabId: tab.tabId, sessionId: tab.sessionId, chatId: tab.threadId, generation: runtime.nativeGeneration, token: id('activity') } : null;
        let renewal = null;
        if (activity && await adapter.activity({ ...activity, active: true }).then(() => true, () => false)) {
          renewal = setInterval(() => { void adapter.activity({ ...activity, active: true, renew: true }).catch(() => {}); }, 10_000); renewal.unref?.();
        }
        try { return await operation(tab.page, { tabId: tab.tabId }); }
        finally {
          if (renewal) { clearInterval(renewal); void adapter.activity({ ...activity, active: false }).catch(() => {}); }
          tab.activeActor = null; tab.lastActivityAt = Date.now(); publish(tab); void persist();
        }
      });
    },
    ownsTarget(actor, target) {
      const tab = target?.tabId && tabs.get(target.tabId);
      return !!actor && !!tab && (actor.isHuman ? tab.scope === 'global' || !actor.sessionId || !tab.sessionId || actor.sessionId === tab.sessionId : canAccessTab(actor, tab));
    },
    downloadTarget(actor, url) {
      let origin; try { origin = new URL(url).origin; } catch { return null; }
      for (const tab of tabs.values()) {
        if (!tab.page || tab.page.isClosed() || !(actor.isHuman ? tab.scope === 'global' || !actor.sessionId || !tab.sessionId || actor.sessionId === tab.sessionId : canAccessTab(actor, tab))) continue;
        try { if (new URL(tab.page.url()).origin === origin) return descriptor(tab); } catch {}
      }
      return null;
    },
    async restore() {
      try { const config = JSON.parse(await fs.readFile(path.join(dataDir, 'browser', 'runtime.json'), 'utf8')); if (config.version === 1 && ['managed', 'native'].includes(config.mode) && (config.mode !== 'native' || nativeAdapter)) { runtimeMode = config.mode; headless = config.headless !== false; } } catch {}
      let stored; try { stored = JSON.parse(await fs.readFile(descriptorFile, 'utf8')); } catch { return; }
      if (stored?.version !== 1 || !Array.isArray(stored.tabs)) return;
      for (const record of stored.tabs.slice(0, limits.maxTabs)) {
        if (typeof record.tabId !== 'string' || record.scope !== 'global' && (!record.threadId || !record.agentId)) continue;
        void favicons.get(faviconOrigin(record.url, isWorkspace)).catch(() => {});
        const tab = makeTab(record); Object.assign(tab, { tabId: record.tabId, nativeTargetId: record.nativeTargetId, url: publicURL(record.url), title: text(record.title, 500), openerTabId: typeof record.openerTabId === 'string' ? text(record.openerTabId, 160) : undefined, searchQuery: googleResearchURL(record.url) && typeof record.searchQuery === 'string' ? text(record.searchQuery, 4000) : undefined, restorePending: true, sleeping: record.status === 'sleeping', status: record.status === 'sleeping' ? 'sleeping' : 'disconnected', navigationEpoch: Number(record.navigationEpoch) || 0, controllerEpoch: (Number(record.controllerEpoch) || 0) + 1 }); tabs.set(tab.tabId, tab);
      }
    },
    async close() { if (closed) return; closed = true; clearInterval(sleepTimer); unsubscribeNativeEvents?.(); if (starting) await Promise.race([starting.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 500))]); if (handoffPromise) await handoffPromise; clearInterval(checkpointTimer); for (const tab of tabs.values()) { await releaseInput(tab); } await persist().catch(() => {}); await history.flush(); await saveCheckpoint().catch(() => {}); await signIn?.close(); await runtime?.close(); await nativeAdapter?.dispose?.(); await favicons.clear(); state = 'closed'; },
  };
}
