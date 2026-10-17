import crypto from 'node:crypto';
import path from 'node:path';
import { isIP } from 'node:net';
import { promises as fs } from 'node:fs';
import { createBrowserNetworkGuard } from './owned-browser-network.mjs';
import { OwnedBrowserError, inspectOwnedBrowserRuntime, inspectMacPasskeyCapability, installOwnedBrowserRuntime, startOwnedBrowserRuntime, startOwnedBrowserSignIn } from './owned-browser-runtime.mjs';
import { removeOwnedBrowserState } from './browser-cleanup.mjs';
import { createFaviconCache, faviconCandidates, faviconOrigin } from './owned-browser-favicons.mjs';
import { OUTLINE_HINT, outlineFromAria, renderOutline } from './owned-browser-outline.mjs';

export { OwnedBrowserError } from './owned-browser-runtime.mjs';

// aria 관찰에서 이름 없는 generic으로 보이는 편집 영역. 이 요소들의 ref는 textbox로 개요에 남긴다.
const EDITABLE = '[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';
const SENSITIVE = 'input[type="password"],input[type="email"],input[autocomplete="username"],input[name="username"],input[name="email"],input[autocomplete="current-password"],input[autocomplete="new-password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"],[data-rhwp-private-field]';
const SEARCH_ORIGINS = new Set(['https://www.google.com', 'https://www.google.co.kr', 'https://duckduckgo.com', 'https://www.bing.com', 'https://search.naver.com', 'https://en.wikipedia.org', 'https://ko.wikipedia.org', 'https://www.wikipedia.org', 'https://pubmed.ncbi.nlm.nih.gov', 'https://arxiv.org']);
const redactValues = (value, secrets) => {
  if (typeof value === 'string') { for (const secret of secrets ?? []) if (secret) for (const variant of [secret, encodeURIComponent(secret), new URLSearchParams({ v: secret }).toString().slice(2), Buffer.from(secret).toString('base64')]) value = value.split(variant).join('[masked]'); return value; }
  if (Array.isArray(value)) return value.map(entry => redactValues(entry, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValues(entry, secrets)]));
  return value;
};
const MUTATIONS = new Set(['navigate', 'click', 'type', 'press', 'select', 'scroll', 'close', 'input', 'fill-account', 'fill-secret', 'viewport', 'upload']);
// 허브가 입력 직전에 비밀 값을 꺼내는 함수. 인자 객체의 기호 키라 직렬화·로그에 실리지 않는다.
const SECRET_FILL = Symbol('rhwp.secretFill');
// 비밀을 입력할 수 있는 칸: 한 줄 글자 입력과 textarea 만.
const SECRET_INPUT_TYPES = new Set(['text', 'password', 'email', 'tel', 'url']);
// 이 조작들은 결과가 자리 잡을 때까지 기다린 뒤 짧은 변화만 돌려준다.
const SETTLING = new Set(['click', 'type', 'press', 'select']);
const READS = new Set(['snapshot', 'frame', 'capture', 'wait']);
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
const canAccessTab = (actor, tab) => tab.scope === 'global' || sameScope(actor, tab);
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
const userInControl = () => error('BROWSER_USER_IN_CONTROL', 'The user is controlling this tab; wait or ask the user to return control.');
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
  const call = (operation, params = {}) => new Promise((resolve, reject) => {
    if (!send) { reject(error('BROWSER_NATIVE_UNAVAILABLE', 'The desktop browser is not connected.', true)); return; }
    const requestId = id('native');
    const timer = setTimeout(() => { pending.delete(requestId); reject(error('BROWSER_NATIVE_TIMEOUT', 'The desktop browser did not respond. Reconnect before retrying.', true)); }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    try { send({ type: 'rhwp-browser-request', id: requestId, operation, params }); }
    catch { clearTimeout(timer); pending.delete(requestId); reject(error('BROWSER_NATIVE_UNAVAILABLE', 'The desktop browser disconnected.', true)); }
  });
  return {
    async start(params) { const result = await call('start', params); nativeGeneration = result.generation; return { ...result, close: () => call('release') }; },
    importSession: (params) => call('import-session', params),
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    revealDownload: (params) => call('reveal-download', params),
    sleep: (params) => call('sleep', params), activity: (params) => call('activity', params), bind: (params) => call('bind', params), control: (params) => call('control', params), reset: () => call('reset'), inventory: () => call('inventory'),
    passwordAccounts: () => call('password-accounts'), passwordSnapshot: (params) => call('password-snapshot', params),
    passwordViewport: (params) => call('password-viewport', params),
    passwordCapture: (params) => call('password-capture', params),
    passwordFill: (params) => call('password-fill', params), passwordAction: (params) => call('password-action', params),
    // 데스크톱의 격리된 세계가 비밀 값을 한 칸에 입력한다. 같은 IPC 동작을 mode 로 나눈다.
    secretFill: (params) => call('password-fill', { ...params, mode: 'secret' }),
    passwordStorageState: () => call('password-storage-state'),
    passwordApprove: (params) => call('password-approve', params),
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
  let passkeys;
  const sessionKey = crypto.randomBytes(32);
  let sessionBaseline = new Map();
  let cookieBaseline = new Map();
  let sessionQueue = Promise.resolve();
  let humanSessionEpoch = 0;
  let humanActionsPending = 0;
  const humanRequestsPending = new Set();
  const humanOrigins = new Set();
  const unconfirmedHumanOrigins = new Set();
  const profileId = () => runtimeMode === 'native' ? 'native' : 'default';
  const selectedAdapter = () => runtimeMode === 'native' ? nativeAdapter : undefined;
  const browserStorageState = async () => (await selectedAdapter()?.passwordStorageState?.()) ?? runtime.context.storageState({ indexedDB: true });
  const nativePasswordBinding = (tab) => ({ targetId: tab.nativeTargetId, tabId: tab.tabId, sessionId: tab.sessionId, chatId: tab.threadId });
  const limits = { maxTabs: options.maxTabs ?? 12, maxTabsPerAgent: options.maxTabsPerAgent ?? 3, maxDownloadBytes: options.maxDownloadBytes ?? 100 * 1024 * 1024, maxFrameBytes: options.maxFrameBytes ?? 5 * 1024 * 1024 };

  const emit = (type, payload) => { try { onEvent({ type, ...payload }); } catch {} };
  // 사용자 보류(hold)는 범위에서 나온 정책 소유자(controller.owner)와 별개다. 에이전트 쓰기를 막고, 보류 중 페이지 요청은 사용자의 것으로 본다(pageActor).
  const userHolds = (tab) => tab.hold?.human === true;
  const nativeControl = (tab) => ({ targetId: tab.nativeTargetId, human: tab.hold?.human !== false, held: userHolds(tab) });
  const runtimeInfo = () => ({ runtimeId, generation, passkeys, state: resetting ? 'resetting' : resetFailed ? 'reset-failed' : handoffPending ? 'sign-in-starting' : state, kind: runtime?.kind ?? (runtimeMode === 'native' ? 'native' : 'chromium'), mode: runtimeMode, headless, profile: 'shared', profileId: profileId(), security: 'restricted-plaintext-profile', supportsSignIn: true, supportsNative: !!nativeAdapter, googleSignIn: runtimeMode === 'native' ? 'switch-to-full-browser' : 'standalone-no-debug-available', signIn: signIn ? { mode: signIn.mode, accountId: signInAccountId, exited: signIn.exited } : null });
  const descriptor = (tab) => redactValues({ tabId: tab.tabId, scope: tab.scope ?? 'agent', threadId: tab.threadId, documentId: tab.documentId, projectId: tab.projectId, agentId: tab.agentId, profileId: profileId(), url: tab.snapshot?.passwordProtected ? tab.snapshot.url : publicURL(tab.page?.url?.() ?? tab.url), title: tab.snapshot?.passwordProtected ? '' : tab.title, status: challengeFor(tab) ? 'challenge-required' : tab.status, challenge: challengeFor(tab), navigationEpoch: tab.navigationEpoch, controllerEpoch: tab.controllerEpoch, controller: userHolds(tab) ? { ...tab.controller, held: true } : { ...tab.controller }, runtime: runtime?.kind ?? tab.runtime ?? 'chromium', nativeTargetId: tab.nativeTargetId, openerTabId: tab.openerTabId, zoomFactor: tab.zoomFactor ?? 1, runtimeGeneration: generation, snapshotId: tab.snapshot?.snapshotId ?? null }, protectedFor(tab));
  const challengeResult = (action, tab) => ({ ok: false, action, ...challengeFor(tab), tab: descriptor(tab), runtime: runtimeInfo(), continuation: { tabId: tab.tabId, humanControl: true, reuseTab: true } });
  // 사이트 아이콘은 사용자 화면용 이벤트와 목록에만 붙인다. 에이전트 결과·browser_status·tabs.json은 descriptor만 쓴다.
  const faviconFor = (tab) => tab.snapshot?.passwordProtected || tab.passwordShielded ? undefined : favicons.peek(faviconOrigin(tab.page?.url?.() ?? tab.url, isWorkspace)) ?? undefined;
  const humanTab = (tab) => { const current = descriptor(tab), faviconUrl = faviconFor(tab); return faviconUrl ? { ...current, faviconUrl } : current; };
  const publish = (tab) => emit('owned_browser_tab', { tab: humanTab(tab), runtime: runtimeInfo() });
  const previewActivity = (actor, tab, active = true) => { if (!actor.isHuman) emit('owned_browser_activity', { active, sessionId: actor.sessionId ?? tab.sessionId, tab: descriptor(tab), runtime: runtimeInfo() }); };
  const persist = () => {
    if (resetting || resetFailed) return Promise.resolve();
    const records = [...tabs.values()].map((tab) => ({ ...descriptor(tab), sessionId: tab.sessionId, taskId: tab.taskId, searchQuery: googleResearchURL(tab.page?.url?.() ?? tab.url) && typeof tab.searchQuery === 'string' ? text(tab.searchQuery, 4000) : undefined }));
    persistQueue = persistQueue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(descriptorFile), { recursive: true, mode: 0o700 });
      const temp = `${descriptorFile}.${crypto.randomBytes(8).toString('hex')}.part`;
      await fs.writeFile(temp, JSON.stringify({ version: 1, tabs: records, humanStorageOrigins: [...unconfirmedHumanOrigins] }), { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, descriptorFile);
    });
    return persistQueue;
  };
  const markHumanOrigin = (origin) => {
    humanOrigins.add(origin);
    if (!unconfirmedHumanOrigins.has(origin)) { unconfirmedHumanOrigins.add(origin); void persist(); }
  };
  const markHumanDocument = (tab) => { for (const frame of tab.page?.frames?.() ?? []) if (/^https?:/.test(frame.url())) markHumanOrigin(new URL(frame.url()).origin); };
  const validateActor = (actor) => {
    if (!actor || (actor.isHuman ? !actor.clientId : !actor.threadId || !actor.agentId)) throw error('BROWSER_SCOPE_REQUIRED', 'A server-authorized browser actor is required.');
    if (closed) throw error('BROWSER_CLOSED', 'The browser service has closed.');
  };
  const ownedTab = (actor, tabId) => {
    const tab = tabs.get(tabId);
    if (!tab || (!actor.isHuman && !canAccessTab(actor, tab))) throw error('BROWSER_TAB_NOT_FOUND', 'This browser tab is unavailable to the current agent.');
    return tab;
  };
  const assertPolicy = async (actor, action, url, tab, args = {}) => {
    if (actor.isHuman) return;
    const mapped = args.intent === 'website-change' || !actor.isHuman && changesWebsiteURL(url) ? 'website-change' : action === 'download' ? 'download' : READS.has(action) || MUTATIONS.has(action) ? 'read' : 'browse';
    if (policy?.assertAllowed && url !== 'about:blank') await policy.assertAllowed({ actor, action: mapped, url, profileId: profileId() });
    else if (policy?.assertBrowserAction) await policy.assertBrowserAction({ actor, action, url, tab: tab && descriptor(tab), intent: args.intent ?? 'research' });
    else if (mapped === 'website-change') throw error('BROWSER_WEBSITE_CHANGE_REQUIRED', 'Approve website changes for this site before continuing.');
    if (credentialBroker?.assertBrowserAccess && tab?.scope !== 'global' && (!tab || ['open', 'browse', 'navigate', 'fill-account', 'fill-secret'].includes(action) || args.intent === 'website-change') && url !== 'about:blank') await credentialBroker.assertBrowserAccess({ actor, url, tab: { ...descriptor(tab ?? { page: null, url, controller: {} }), profileId: profileId() } });
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
  const discoverFavicon = async (tab, pageUrl, links) => {
    const origin = faviconOrigin(pageUrl, isWorkspace);
    if (!origin || closed || resetting || resetFailed || tab.snapshot?.passwordProtected || tab.passwordShielded) return;
    const before = favicons.peek(origin);
    // 허브의 아이콘 요청도 탭 자신의 하위 요청과 같은 사이트 정책을 거친다. 승인되지 않은 출처로 새는 길을 만들지 않는다.
    const authorize = (url) => assertPolicy(pageActor(tab), 'browse', url, tab).then(() => true, () => false);
    const icon = await favicons.discover(origin, faviconCandidates(pageUrl, links, { isWorkspace }), { authorize }).catch(() => null);
    if (icon && icon !== before && tabs.get(tab.tabId) === tab && !closed && !resetting) publish(tab);
  };
  const unsubscribeNativeEvents = nativeAdapter?.onEvent?.((event) => {
    const tab = tabs.get(event.tabId);
    if (!closed && runtimeMode === 'native' && tab && event.reason === 'download-progress' && event.targetId === tab?.nativeTargetId && event.generation === tab?.nativeGeneration) { downloads?.reportProgress?.({ tabId: tab.tabId, ...event }); return; }
    if (event.reason === 'human-input') {
      // 데스크톱이 실제 사용자 입력을 탭에 전달했다. 이어지는 로그인 제출 같은 요청은 사용자의 것이다.
      if (!closed && runtimeMode === 'native' && tab?.page && event.targetId === tab.nativeTargetId && event.generation === tab.nativeGeneration && !tab.humanDriven) { tab.humanDriven = true; markHumanDocument(tab); }
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
  };
  const enqueue = (tab, operation) => {
    const result = tab.queue.catch(() => {}).then(operation);
    tab.queue = result.catch(() => {});
    return result;
  };
  const dismissPendingDialog = async (tab) => {
    const dialog = tab.pendingDialog;
    tab.pendingDialog = null;
    await dialog?.dismiss().catch(() => {});
  };
  const releaseInput = async (tab) => {
    await dismissPendingDialog(tab);
    for (const key of tab.heldKeys) await tab.page?.keyboard?.up(key).catch(() => {});
    for (const button of tab.heldButtons) await tab.page?.mouse?.up({ button }).catch(() => {});
    tab.heldKeys.clear(); tab.heldButtons.clear();
  };
  const actorForTab = (tab) => ({ threadId: tab.threadId, projectId: tab.projectId, documentId: tab.documentId, agentId: tab.agentId, ownerId: tab.ownerId, sessionId: tab.sessionId, isHuman: false });
  // 페이지가 스스로 보내는 요청의 주체. 사용자가 잡았거나 화면에서 직접 누른 탭의 요청은 사용자의 것이다.
  // 에이전트가 다음 조작을 시작하면 humanDriven 이 풀려 다시 에이전트 정책을 따른다.
  const pageActor = (tab, { ignoreActive = false } = {}) => (!ignoreActive && tab.activeActor) || (tab.controller.owner === 'human' || userHolds(tab) || tab.humanDriven
    ? { ...actorForTab(tab), isHuman: true, clientId: tab.controller.clientId ?? tab.hold?.clientId ?? tab.sessionId } : actorForTab(tab));
  const sessionFingerprint = (storage) => {
    const grouped = new Map();
    for (const cookie of storage.cookies ?? []) { const domain = cookie.domain.replace(/^\./, '').toLowerCase(); const key = `domain:${domain}`; if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(cookie); }
    for (const origin of storage.origins ?? []) grouped.set(`origin:${origin.origin}`, origin);
    return new Map([...grouped].map(([key, values]) => [key, crypto.createHmac('sha256', sessionKey).update(JSON.stringify(Array.isArray(values) ? values.sort((a, b) => `${a.domain}:${a.name}:${a.path}`.localeCompare(`${b.domain}:${b.name}:${b.path}`)) : values)).digest('hex')]));
  };
  const cookieIdentity = (cookie) => `${cookie.domain.toLowerCase()}\n${cookie.path}\n${cookie.name}`;
  const serializeSession = (operation) => { const result = sessionQueue.catch(() => {}).then(operation); sessionQueue = result.catch(() => {}); return result; };
  const matchesOrigin = (key, origin) => {
    if (key.startsWith('origin:')) return key.slice(7) === origin;
    const domain = key.slice(7), host = new URL(origin).hostname;
    return host === domain || host.endsWith(`.${domain}`);
  };
  const recordAgentSessions = (url, epoch, headers = []) => serializeSession(async () => {
    if (!runtime || state !== 'ready' || epoch !== humanSessionEpoch || humanActionsPending || humanRequestsPending.size || !/^https?:/.test(url)) return;
    const storage = await browserStorageState();
    const current = sessionFingerprint(storage);
    if (epoch !== humanSessionEpoch || humanActionsPending || humanRequestsPending.size) return;
    const origin = new URL(url).origin;
    const humanStorageOwner = unconfirmedHumanOrigins.has(origin) || runtime.context.pages().some((page) => !pageTabs.has(page) && page.frames().some((frame) => { try { return new URL(frame.url()).origin === origin; } catch { return false; } }));
    // Origin storage has no per-write actor identity. Never credit an agent with
    // an unproved localStorage/IndexedDB change while a human shares that origin.
    if (!humanStorageOwner) for (const [key, fingerprint] of current) if (key.startsWith('origin:') && matchesOrigin(key, origin)) sessionBaseline.set(key, fingerprint);
    const source = new URL(url), touchedDomains = new Set();
    for (const header of headers.filter((entry) => entry.name.toLowerCase() === 'set-cookie')) {
      const [pair, ...attributes] = header.value.split(';'), separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim(), value = pair.slice(separator + 1);
      const attrs = new Map(attributes.map((entry) => { const split = entry.indexOf('='); return [entry.slice(0, split < 0 ? undefined : split).trim().toLowerCase(), split < 0 ? '' : entry.slice(split + 1).trim()]; }));
      const domain = (attrs.get('domain') ?? source.hostname).replace(/^\./, '').toLowerCase();
      if (source.hostname !== domain && !source.hostname.endsWith(`.${domain}`)) continue;
      const cookiePath = attrs.get('path')?.startsWith('/') ? attrs.get('path') : source.pathname.slice(0, source.pathname.lastIndexOf('/')) || '/';
      const cookieDomain = attrs.has('domain') && !isIP(domain) ? `.${domain}` : domain;
      const identity = `${cookieDomain}\n${cookiePath}\n${name}`;
      const cookie = storage.cookies.find((entry) => cookieIdentity(entry) === identity);
      if (cookie?.value === value) { cookieBaseline.set(identity, cookie); touchedDomains.add(domain); }
      else if (!cookie && (Number(attrs.get('max-age')) <= 0 && attrs.has('max-age') || Date.parse(attrs.get('expires')) < Date.now())) { cookieBaseline.delete(identity); touchedDomains.add(domain); }
    }
    // Only the exact keys written by this authorized response advance cookie provenance.
    const approved = sessionFingerprint({ cookies: [...cookieBaseline.values()], origins: [] });
    for (const domain of touchedDomains) { const key = `domain:${domain}`; if (approved.has(key)) sessionBaseline.set(key, approved.get(key)); else sessionBaseline.delete(key); }
  });
  const observeHumanSessions = () => serializeSession(async () => {
    if (!runtime || state !== 'ready' || !credentialBroker?.registerSessionOrigins) return;
    for (const page of runtime.context.pages()) if (!pageTabs.has(page) && /^https?:/.test(page.url())) markHumanOrigin(new URL(page.url()).origin);
    const storage = await browserStorageState();
    const current = sessionFingerprint(storage);
    const domains = [], origins = [];
    for (const [key, fingerprint] of current) {
      if (fingerprint === sessionBaseline.get(key)) continue;
      if (key.startsWith('domain:')) {
        const domain = key.slice(7);
        if ([...humanOrigins].some((origin) => { const host = new URL(origin).hostname; return host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`); })) domains.push(domain);
      } else { const origin = key.slice(7); if (humanOrigins.has(origin)) origins.push(origin); }
    }
    if (domains.length || origins.length) await credentialBroker.registerSessionOrigins({ profileId: profileId(), origins, domains, source: 'human' });
    sessionBaseline = current;
    cookieBaseline = new Map(storage.cookies.map((cookie) => [cookieIdentity(cookie), cookie]));
  });

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
      emit('owned_browser_download_error', { tabId: tab.tabId, threadId: tab.threadId, projectId: tab.projectId, error: { code: failure.code ?? 'BROWSER_DOWNLOAD_FAILED', message: 'The browser download could not be stored.' } });
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
        const handshakeActor = pageActor(tab);
        await assertPolicy(handshakeActor, 'browse', url, tab);
        const server = socket.connectToServer();
        socket.onMessage(async (message) => {
          const actor = pageActor(tab);
          try { await assertPolicy(actor, 'browse', url, tab); server.send(message); }
          catch { await server.close({ code: 4003, reason: 'Website changes require owner approval' }); await socket.close({ code: 4003, reason: 'Website changes require owner approval' }); }
        });
        server.onMessage(async (message) => {
          const actor = pageActor(tab, { ignoreActive: true });
          try { await assertPolicy(actor, 'snapshot', url, tab); socket.send(message); }
          catch { await server.close({ code: 4003, reason: 'Website access requires owner approval' }); await socket.close({ code: 4003, reason: 'Website access requires owner approval' }); }
        });
      } catch { await socket.close({ code: 4003, reason: 'Browser destination blocked' }); }
    });
    page.on('download', (download) => { void onDownload(tab, download); });
    page.on('dialog', (dialog) => {
      if (tab.page !== page) { void dialog.dismiss().catch(() => {}); return; }
      tab.pendingDialog = dialog;
      tab.dialogCount = (tab.dialogCount ?? 0) + 1; tab.lastDialog = { type: dialog.type(), message: text(dialog.message(), 300) };
      // 네이티브 사용자 확인은 창의 비동기 대화상자로 처리한다. 에이전트는 승인하지 않는다.
      const human = pageActor(tab).isHuman === true;
      if (selectedAdapter() && human && !closed) return;
      void dismissPendingDialog(tab);
    });
    page.on('filechooser', (chooser) => {
      tab.pendingChooser = chooser;
      emit('owned_browser_file_chooser', { tabId: tab.tabId, threadId: tab.threadId, multiple: chooser.isMultiple(), navigationEpoch: tab.navigationEpoch, controllerEpoch: tab.controllerEpoch });
    });
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
      tab.status = 'ready'; publish(tab);
      void page.title().then((title) => {
        if (tab.page !== page || tab.navigationEpoch !== epoch) return;
        tab.title = text(title, 500); publish(tab); void persist();
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

  const ensureRuntime = async () => {
    if (resetting || resetFailed) throw error('BROWSER_RESET_REQUIRED', 'Complete browser cleanup in Settings before starting another browser.', true);
    if (signIn || handoffPending) throw error('BROWSER_SIGN_IN_ACTIVE', 'Complete sign-in in the full browser, then confirm the account in Browser settings.', true);
    if (starting) return starting;
    if (runtime && state === 'ready') return runtime;
    state = 'starting'; emit('owned_browser_runtime', { runtime: runtimeInfo() });
    starting = (async () => {
      try {
        if (runtime) { await runtime.close().catch(() => {}); runtime = null; }
        runtime = await runtimeFactory({ dataDir, guard, nativeAdapter: selectedAdapter(), headless, autoInstall: options.autoInstall !== false, onEvent: (progress) => emit('owned_browser_runtime', { runtime: { ...runtimeInfo(), ...progress } }) });
        generation++;
        let checkpoint;
        if (credentialBroker?.restoreCheckpoint) {
          checkpoint = await credentialBroker.restoreCheckpoint({ profileId: profileId() });
          if (checkpoint && !handoffProfile && !(selectedAdapter() && runtime.context.pages().length)) await runtime.context.setStorageState(checkpoint);
        }
        const initialStorage = await browserStorageState();
        const initialFingerprint = sessionFingerprint(initialStorage);
        if ((!checkpoint || handoffProfile) && credentialBroker?.registerSessionOrigins && (initialStorage.cookies.length || initialStorage.origins.length)) {
          const origins = initialStorage.origins.map((entry) => entry.origin).filter((origin) => !handoffProfile || initialFingerprint.get(`origin:${origin}`) !== sessionBaseline.get(`origin:${origin}`));
          const domains = initialStorage.cookies.map((cookie) => cookie.domain.replace(/^\./, '')).filter((domain) => !handoffProfile || initialFingerprint.get(`domain:${domain}`) !== sessionBaseline.get(`domain:${domain}`));
          if (origins.length || domains.length) await credentialBroker.registerSessionOrigins({ profileId: profileId(), origins, domains, source: handoffProfile ? 'human' : 'unknown' });
        }
        sessionBaseline = initialFingerprint;
        cookieBaseline = new Map(initialStorage.cookies.map((cookie) => [cookieIdentity(cookie), cookie]));
        handoffProfile = false;
        await runtime.context.route('**/*', async (route) => {
          const request = route.request();
          try {
            const url = request.url();
            if (url.startsWith('data:') || url === 'about:blank') { await route.continue(); return; }
            await guard.resolve(url);
            let page; try { page = request.frame().page(); } catch {}
            let tab = page && pageTabs.get(page);
            // 팝업의 첫 요청이 논리 탭 바인딩보다 먼저 도착해도 원래 탭의 정책을 적용한다.
            if (!tab && page) { const opener = await page.opener().catch(() => null); tab = opener && pageTabs.get(opener); }
            if (tab) {
              const actor = pageActor(tab);
              if (actor.isHuman) {
                humanSessionEpoch++; humanOrigins.add(new URL(url).origin); humanRequestsPending.add(request);
                // Cookies are applied with response headers. Streaming bodies must not hold
                // the shared profile indefinitely; the human action retains its own fence.
                void request.response().then(async () => { await observeHumanSessions(); }).catch(() => {}).finally(() => { humanRequestsPending.delete(request); });
              }
              else {
                const epoch = humanSessionEpoch;
                void request.response().then(async (response) => { if (response) await recordAgentSessions(url, epoch, await response.headersArray()); }).catch(() => {});
              }
              await assertPolicy(actor, 'browse', url, tab);
              if (!actor.isHuman && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
                await assertPolicy(actor, 'browse', url, tab, { intent: 'website-change' });
              }
            }
            await route.continue();
          } catch { await route.abort('blockedbyclient').catch(() => {}); }
        });
        // 팝업 게스트는 논리 탭 없이 남지 않는다. 숨은 고아 창은 같은 이름의 window.open을 계속 삼킨다.
        const adoptPopup = async (page, parent) => {
          if (pageTabs.has(page) || page.isClosed()) return;
          if (!parent || tabs.size >= limits.maxTabs) { await page.close(); return; }
          // Pages created by popup scripts never gain another agent's binding.
          const tab = makeTab({ ...actorForTab(parent), scope: parent.scope }); tab.controller = { ...parent.controller }; tab.hold = parent.hold; tab.humanDriven = parent.humanDriven; tab.openerTabId = parent.tabId; tabs.set(tab.tabId, tab);
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
          emit('owned_browser_popup', { tab: descriptor(tab), openerTabId: parent.tabId, foreground: native?.disposition !== 'background-tab', runtime: runtimeInfo() });
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
            if (retained) { retained.controller = { owner: retained.scope === 'global' ? 'human' : 'agent' }; retained.hold = null; retained.humanDriven = false; retained.controllerEpoch++; retained.status = 'ready'; await attach(retained, page); retained.restorePending = false; publish(retained); }
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
  const makeTab = (input) => { const global = input.isHuman || input.scope === 'global'; const actor = global ? { ...input, threadId: null, projectId: null, documentId: null, agentId: 'human', taskId: null } : input; return ({ lastActivityAt: Date.now(), scope: global ? 'global' : 'agent', tabId: id('tab'), threadId: actor.threadId ?? null, projectId: actor.projectId ?? null, documentId: actor.documentId ?? null, agentId: actor.agentId ?? 'human', ownerId: actor.ownerId, sessionId: actor.sessionId, taskId: actor.taskId, url: 'about:blank', title: '', status: 'ready', page: null, navigationEpoch: 0, controllerEpoch: 1, controller: { owner: global ? 'human' : 'agent' }, queue: Promise.resolve(), heldKeys: new Set(), heldButtons: new Set(), snapshot: null, frame: null }); };
  const returnFromSignIn = async (account, storage) => {
    const origins = new Set(account.origins);
    const hosts = account.origins.map((origin) => new URL(origin).hostname);
    const matchesApprovedHost = (cookie) => {
      const domain = cookie.domain.replace(/^\./, '').toLowerCase();
      return hosts.some((host) => host === domain || cookie.domain.startsWith('.') && host.endsWith(`.${domain}`));
    };
    const approved = { cookies: storage.cookies.filter(matchesApprovedHost), origins: storage.origins.filter((entry) => origins.has(entry.origin)) };
    clearInterval(checkpointTimer);
    await runtime.close(); runtime = null; state = 'idle'; runtimeMode = 'native';
    await credentialBroker.saveCheckpoint?.({ profileId: 'native', state: approved });
    await ensureRuntime();
    // 유지된 네이티브 게스트는 자동 체크포인트 복원을 건너뛰므로 승인된 세션을 직접 병합한다.
    const adapter = selectedAdapter();
    if (adapter?.importSession) {
      // 메인 프로세스가 승인된 사이트만 갱신한다. 보호된 탭의 숨겨진 저장소는 읽거나 지우지 않는다.
      await adapter.importSession({ origins: [...origins], state: approved, reload: true });
    } else {
      if (await adapter?.passwordStorageState?.()) throw error('BROWSER_NATIVE_SESSION_IMPORT_UNAVAILABLE', 'Reconnect the desktop browser before restoring this sign-in.', true);
      const retained = await browserStorageState();
      const merged = { cookies: [...retained.cookies.filter((entry) => !matchesApprovedHost(entry)), ...approved.cookies],
        origins: [...retained.origins.filter((entry) => !origins.has(entry.origin)), ...approved.origins] };
      await runtime.context.setStorageState(merged);
    }
    const restored = await browserStorageState();
    sessionBaseline = sessionFingerprint(restored); cookieBaseline = new Map(restored.cookies.map((cookie) => [cookieIdentity(cookie), cookie]));
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
    const result = checkpointQueue.catch(() => {}).then(async () => { if (!resetting && !resetFailed && runtime && state === 'ready' && credentialBroker?.saveCheckpoint) { await observeHumanSessions(); if (!resetting && !resetFailed) await credentialBroker.saveCheckpoint({ profileId: profileId(), state: await browserStorageState() }); } });
    checkpointQueue = result.catch(() => {}); return result;
  };
  credentialBroker?.setDataResetter?.(async ({ phase }) => {
    if (phase === 'before') {
      resetting = true; clearInterval(checkpointTimer);
      if (starting) await starting.catch(() => {});
      if (handoffPromise) await handoffPromise.catch(() => {});
      for (const tab of tabs.values()) { tab.controllerEpoch++; invalidate(tab); }
      await Promise.all([...tabs.values()].map((tab) => tab.queue.catch(() => {})));
      await checkpointQueue; await sessionQueue; await persistQueue.catch(() => {});
      await signIn?.close(); signIn = null; signInAccountId = null;
      for (const tab of tabs.values()) await releaseInput(tab);
      await runtime?.close(); runtime = null;
      await nativeAdapter?.reset?.();
      tabs.clear(); sessionBaseline.clear(); cookieBaseline.clear(); humanOrigins.clear(); unconfirmedHumanOrigins.clear(); humanRequestsPending.clear(); handoffProfile = false; state = 'resetting';
      await favicons.clear();
      await removeOwnedBrowserState({ dataDir });
    } else if (phase === 'after') { resetting = false; resetFailed = false; state = 'idle'; emit('owned_browser_runtime', { runtime: runtimeInfo() }); }
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
      if (clearing === runtime) {
        const storage = await browserStorageState();
        sessionBaseline = sessionFingerprint(storage); cookieBaseline = new Map(storage.cookies.map((cookie) => [cookieIdentity(cookie), cookie]));
      }
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
    const clearedStorage = await clearing.context.storageState({ indexedDB: true });
    if (clearing === runtime) { sessionBaseline = sessionFingerprint(clearedStorage); cookieBaseline = new Map(clearedStorage.cookies.map((cookie) => [cookieIdentity(cookie), cookie])); }
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
        while (Date.now() - watchStart < 500 && (navigation || pending.size || popup || tab.navigationEpoch !== startEpoch || Date.now() - activeAt < 200)) await pause(50);
        watching = false;
        const deadline = Date.now() + 5000;
        const live = () => Date.now() < deadline && tab.page === page && !page.isClosed();
        if (navigation || tab.navigationEpoch !== startEpoch) {
          while (live() && tab.navigationEpoch === startEpoch && navigation !== 'done') await pause(50);
          if (live() && tab.navigationEpoch !== startEpoch) await page.waitForLoadState('load', { timeout: Math.max(1, deadline - Date.now()) }).catch(() => {});
        } else while (live() && pending.size) await pause(50);
        let opened;
        while (popup && !(opened = [...tabs.values()].find((entry) => entry.page === popup)) && live() && !popup.isClosed()) await pause(50);
        const navigated = tab.navigationEpoch !== startEpoch;
        if (navigated && tab.page === page && !page.isClosed() && !(selectedAdapter() && tab.nativeTargetId)) { const title = await page.title().catch(() => null); if (typeof title === 'string' && tab.page === page) tab.title = text(title, 500); }
        const dialog = (tab.dialogCount ?? 0) !== dialogs && tab.lastDialog ? redactValues(tab.lastDialog, protectedFor(tab)) : undefined;
        const newTab = opened ? (({ tabId, url, title }) => ({ tabId, url, ...(title ? { title } : {}) }))(descriptor(opened)) : undefined;
        return { navigated, ...(newTab ? { newTab } : {}), ...(dialog ? { dialog } : {}) };
      } finally { stop(); }
    };
    return { stop, settle };
  };

  const operate = async (actor, action, tab, args, signal) => {
    if (action === 'close') { await releaseInput(tab); await tab.page?.close(); tab.status = 'closed'; tabs.delete(tab.tabId); await persist(); return { completed: true }; }
    const page = requirePage(tab);
    if (action === 'snapshot') return { snapshot: await snapshot(tab, undefined, { scope: args.scope, find: args.find, text: args.text === true }) };
    if (action === 'frame') return { frame: await frame(tab, actor) };
    if (action === 'capture') return { capture: await capture(actor, tab, args) };
    if (tab.snapshot?.native && selectedAdapter()?.passwordAction && ['click', 'type', 'press', 'select', 'scroll'].includes(action)) {
      if (action === 'press') assertAgentKey(actor, args.key);
      const ref = args.ref ?? (action === 'press' ? tab.snapshot.elements.find((element) => element.tag === 'input')?.ref : undefined);
      if (action !== 'scroll') requireRef(tab, { ...args, ref });
      const parameters = { ...nativePasswordBinding(tab), action, ref, snapshotId: args.snapshotId ?? tab.snapshot.snapshotId, text: text(args.text, 16_000), key: text(args.key, 80), option: text(args.option, 500), deltaX: bounded(args.deltaX, -2000, 2000, 0), deltaY: bounded(args.deltaY, -2000, 2000, 600) };
      const watch = SETTLING.has(action) ? watchConsequences(tab) : null;
      try {
        const result = await selectedAdapter().passwordAction(parameters);
        if (action === 'type' && args.submit === true) {
          epochs(tab, args, true); assertController(actor, tab);
          await assertPolicy(actor, 'press', page.url(), tab, args);
          await selectedAdapter().passwordAction({ ...parameters, action: 'press', key: 'Enter' });
        }
        return watch ? { ...result, consequences: await watch.settle() } : result;
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
      let choice;
      if (action === 'select') {
        const options = await handle.evaluate((el) => el instanceof HTMLSelectElement ? [...el.options].map((option) => [option.label.trim(), option.value, option.disabled]) : null);
        if (!options) throw error('BROWSER_NOT_SELECTABLE', 'The target is not a native list box. Click custom menus instead.');
        const wanted = String(args.option ?? '').trim();
        choice = [([label]) => label === wanted, ([, value]) => value === wanted, ([label]) => label.toLowerCase() === wanted.toLowerCase()].map((match) => options.findIndex((option) => !option[2] && match(option))).find((index) => index >= 0);
        if (choice === undefined) throw error('BROWSER_OPTION_NOT_FOUND', 'No enabled option has this label or value. Snapshot the list box with scope to see its options.');
      }
      const watch = watchConsequences(tab);
      try {
        if (action === 'click') await handle.click({ timeout: 10_000, button: args.button === 'right' ? 'right' : 'left' });
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
        return { completed: true, consequences: await watch.settle() };
      } finally { watch.stop(); }
    }
    if (action === 'scroll') { await page.mouse.wheel(bounded(args.deltaX, -2000, 2000, 0), bounded(args.deltaY, -2000, 2000, 600)); return { completed: true }; }
    if (action === 'input') { if (!actor.isHuman) throw error('BROWSER_HUMAN_INPUT_REQUIRED', 'Raw browser input is reserved for human takeover.'); return input(tab, args); }
    if (action === 'upload') {
      if (!actor.isHuman || !tab.pendingChooser) throw error('BROWSER_UPLOAD_UNAVAILABLE', 'Choose Upload in a human-controlled page first.');
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
        // "이 채팅" 계정 승인은 허브만 안다. 데스크톱 보관함은 영구 승인이나 이 표시가 있을 때만 입력한다.
        const chatApprovedAt = actor.isHuman ? null : policy?.chatAccountGrantedAt?.(actor, args.accountId) ?? null;
        const result = await selectedAdapter().passwordFill({ ...nativePasswordBinding(tab), accountId: args.accountId, snapshotId: args.snapshotId, usernameRef: args.usernameRef, passwordRef: args.passwordRef, ...(chatApprovedAt ? { chatApprovedAt } : {}) });
        tab.snapshot.passwordProtected = true;
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
            // Playwright fills through its isolated selector engine, never a site-patched setter.
            await handle.fill(value, { timeout: 10_000 });
          });
        };
        if (usernameHandle) await write(usernameHandle, username, false);
        await write(passwordHandle, password, true);
      } });
      return { completed: true, accountId: args.accountId };
    }
    if (action === 'fill-secret') return fillSecret(actor, tab, page, args);
    throw error('BROWSER_ACTION_INVALID', 'Unsupported browser action.');
  };

  // 사용자가 승인한 비밀을 한 칸에 입력한다. 값은 모든 확인을 마친 뒤에야 꺼내고, 탭의 보호 값으로 등록해 관찰·대화상자·오류·캡처에서 가린다.
  const fillSecret = async (actor, tab, page, args) => {
    const secret = args[SECRET_FILL];
    if (actor.isHuman || !secret || typeof secret.resolve !== 'function' || !Array.isArray(secret.origins)) throw error('BROWSER_ACTION_INVALID', 'Fill secrets with browser_fill_secret.');
    const allowed = new Set(secret.origins);
    const outside = () => error('BROWSER_SECRET_ORIGIN_MISMATCH', 'This page is outside the websites the user approved for this secret.');
    const topOrigin = () => { try { return new URL(page.url()).origin; } catch { return 'null'; } };
    const origin = topOrigin();
    if (!allowed.has(origin)) throw outside();
    const protect = (value) => {
      tab.protectedValues ??= new Set(); tab.protectedValues.add(value);
      filledSecrets.add(value);
      if (filledSecrets.size > 256) filledSecrets.delete(filledSecrets.values().next().value);
    };
    const submit = async (press) => {
      if (args.submit !== true) return;
      epochs(tab, args, true); assertController(actor, tab);
      // 제출은 browser_type 의 제출과 같은 사이트 변경 승인을 따른다.
      await assertPolicy(actor, 'press', page.url(), tab, { intent: 'website-change' });
      await press();
    };
    const invalidTarget = () => error('BROWSER_SECRET_TARGET_INVALID', 'Choose a text or password field for this secret.');
    const userCode = () => error('BROWSER_USER_CODE_REQUIRED', "The user must enter this one-time code. Call browser_request_account with kind 'code'.");
    if (tab.snapshot?.native && selectedAdapter()?.secretFill) {
      // 금고를 열기 전에 관찰한 요소 정보로 먼저 거른다. 데스크톱이 입력 직전에 다시 확인한다.
      const element = requireRef(tab, args);
      if (!(element.tag === 'textarea' || element.tag === 'input' && SECRET_INPUT_TYPES.has(element.inputType)) || element.disabled) throw invalidTarget();
      if (element.autocomplete === 'one-time-code') throw userCode();
      let formOrigin = null;
      try { formOrigin = element.formAction ? new URL(element.formAction).origin : null; } catch { formOrigin = 'null'; }
      if (formOrigin && formOrigin !== origin) throw error('BROWSER_SECRET_FORM_ORIGIN', 'This form sends its data to another website.');
      const value = await secret.resolve();
      protect(value);
      const watch = watchConsequences(tab);
      try {
        await selectedAdapter().secretFill({ ...nativePasswordBinding(tab), snapshotId: args.snapshotId, ref: args.ref, origins: [...allowed], value });
        tab.snapshot.passwordProtected = true;
        await submit(() => selectedAdapter().passwordAction({ ...nativePasswordBinding(tab), action: 'press', key: 'Enter', ref: args.ref, snapshotId: args.snapshotId }));
        return { completed: true, consequences: await watch.settle() };
      } finally { watch.stop(); }
    }
    if (tab.snapshot?.native) throw error('BROWSER_NATIVE_UNAVAILABLE', 'This desktop browser cannot enter secrets yet. Update the app.', true);
    const handle = await elementFor(tab, args);
    const frame = await handle.ownerFrame();
    let frameOrigin = 'null';
    try { frameOrigin = new URL(frame?.url() ?? '').origin; } catch {}
    if (!frame || !allowed.has(frameOrigin)) throw outside();
    const matches = async (selector) => { const node = await handle.$(selector); await node?.dispose(); return !!node; };
    const isInput = await matches('xpath=self::input');
    const type = ((await handle.getAttribute('type')) || 'text').trim().toLowerCase();
    const autocomplete = ((await handle.getAttribute('autocomplete')) ?? '').trim().toLowerCase();
    if (!(isInput ? SECRET_INPUT_TYPES.has(type) : await matches('xpath=self::textarea'))) throw invalidTarget();
    if (autocomplete === 'one-time-code') throw userCode();
    if (autocomplete.startsWith('cc-')) throw invalidTarget();
    // form= 속성으로 묶인 칸과 제출 단추의 formaction 까지 본다. 이름이 action 인 칸이 가리지 않게 속성을 읽는다.
    const destinations = await handle.evaluate((el) => {
      const form = el.form;
      if (!form) return [];
      return [form.getAttribute('action'), ...[...form.elements].filter((item) => ['submit', 'image'].includes(item.type)).map((item) => item.getAttribute('formaction'))]
        .filter(Boolean).map((value) => { try { return new URL(value, document.baseURI).origin; } catch { return 'null'; } });
    }).catch(() => ['null']);
    if (destinations.some((destination) => destination !== frameOrigin)) throw error('BROWSER_SECRET_FORM_ORIGIN', 'This form sends its data to another website.');
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
    if (!actor.isHuman) await observeHumanSessions();
    // 네이티브 창의 중지·완료 이벤트로 새로 읽을 때 실제 로딩 종료도 반영한다.
    if (runtime && state === 'ready' && selectedAdapter()?.inventory) {
      const native = await selectedAdapter().inventory();
      for (const tab of tabs.values()) {
        const current = tab.nativeTargetId && native.find((entry) => entry.nativeTargetId === tab.nativeTargetId);
        if (tab.page && !tab.page.isClosed() && tab.status === 'loading' && current?.loading === false && !current.crashed && !current.error) tab.status = 'ready';
        if (current) tab.passwordShielded = current.passwordProtected === true;
      }
    }
    const visible = [];
    for (const tab of tabs.values()) {
      if (!actor.isHuman && !canAccessTab(actor, tab)) continue;
      let current = actor.isHuman ? humanTab(tab) : descriptor(tab);
      if (!actor.isHuman) try { await assertPolicy(actor, 'snapshot', tab.page?.url?.() ?? tab.url, tab); }
      catch { current = { ...current, url: 'about:blank', title: '', status: 'approval-required', challenge: null, snapshotId: null }; }
      visible.push(current);
    }
    let accounts = [];
    if (selectedAdapter()?.passwordAccounts) accounts = (await selectedAdapter().passwordAccounts()).accounts ?? [];
    const activeTabId = visible.find(tab => tab.tabId === actor.activeBrowserTabId)?.tabId ?? null;
    return { ok: true, action: 'status', runtime: runtimeInfo(), tabs: visible, activeTabId, limits, accounts };
  };
  const performRequest = async (actor, action, args = {}) => {
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
    if (!actor.isHuman && action !== 'status' && (signIn || handoffPending)) throw error('BROWSER_SIGN_IN_ACTIVE', 'The user owns the browser profile during sign-in. Wait for account confirmation.', true);
    if (runtime && !actor.isHuman) await observeHumanSessions();
    if (action === 'status') { passkeys = await inspectMacPasskeyCapability(); return { ...(await inventory(actor)), readiness: state === 'ready' ? { state: 'ready', installed: true, passkeys } : await inspectOwnedBrowserRuntime({ dataDir }) }; }
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
      handoffPreviousMode = runtimeMode;
      handoffPending = true;
      try {
        let resolveHandoff; handoffPromise = new Promise((resolve) => { resolveHandoff = resolve; });
        try {
        if (starting) await starting;
        clearInterval(checkpointTimer);
        if (runtime) { await saveCheckpoint().catch(() => {}); await runtime.close(); runtime = null; }
        await credentialBroker.deleteCheckpoint?.({ profileId: 'default' });
        for (const tab of tabs.values()) { tab.page = null; tab.status = 'disconnected'; tab.controllerEpoch++; tab.controller = { owner: tab.scope === 'global' ? 'human' : 'agent' }; tab.hold = null; invalidate(tab); }
        runtimeMode = 'managed'; state = 'sign-in'; signInAccountId = account.id;
        const start = options.signInFactory ?? startOwnedBrowserSignIn;
        signIn = await start({ dataDir, url, authenticationMethod: args.authenticationMethod, autoInstall: options.autoInstall !== false, onExit: () => emit('owned_browser_runtime', { runtime: runtimeInfo() }) });
        } finally { resolveHandoff(); handoffPromise = null; }
      } catch (failure) {
        signInAccountId = null; handoffPending = false; runtimeMode = handoffPreviousMode ?? runtimeMode; handoffPreviousMode = null; state = 'idle';
        await ensureRuntime().catch(() => {});
        throw failure;
      }
      finally { handoffPending = false; }
      emit('owned_browser_runtime', { runtime: runtimeInfo() });
      return { ok: true, action, runtime: runtimeInfo(), signIn: { mode: 'standalone-no-debug', accountId: account.id, message: 'Complete sign-in in the separate Chromium window, then confirm the account in Browser settings.' } };
    }
    if (action === 'confirm-sign-in') {
      if (!actor.isHuman || !credentialBroker?.confirmAccountSession) throw error('BROWSER_HUMAN_REQUIRED', 'Confirm the signed-in account from Browser settings.');
      if (handoffPending) throw error('BROWSER_SIGN_IN_ACTIVE', 'Wait for the sign-in browser to open before confirming the account.');
      if (signIn) {
        if (args.accountId !== signInAccountId) throw error('BROWSER_ACCOUNT_IDENTITY_MISMATCH', 'Confirm the account selected for this sign-in window.');
        await signIn.close(); signIn = null; signInAccountId = null; handoffProfile = true; state = 'idle';
        await ensureRuntime();
      }
      await observeHumanSessions();
      const result = await credentialBroker.confirmAccountSession({ actor, accountId: args.accountId, ...(handoffPreviousMode === 'native' ? { additionalProfileId: 'native' } : {}) });
      const account = result.account ?? result;
      const confirmedStorage = await browserStorageState();
      const confirmed = sessionFingerprint(confirmedStorage);
      for (const origin of account.origins ?? []) {
        unconfirmedHumanOrigins.delete(origin);
        const key = `origin:${origin}`;
        if (confirmed.has(key)) sessionBaseline.set(key, confirmed.get(key)); else sessionBaseline.delete(key);
      }
      await persist();
      await saveCheckpoint();
      if (handoffPreviousMode === 'native') await returnFromSignIn(account, confirmedStorage);
      handoffPreviousMode = null;
      return { ok: true, action, account, runtime: runtimeInfo() };
    }
    if (action === 'downloads') {
      if (!downloads) throw error('BROWSER_DOWNLOADS_UNAVAILABLE', 'Managed downloads are unavailable.');
      const operation = args.action ?? 'list';
      if (operation === 'list') return { ok: true, action, downloads: await downloads.list(actor) };
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
      if (googleResearchURL(url)) tab.searchQuery = new URL(url).searchParams.get('q') || undefined;
      tabs.set(tab.tabId, tab);
      const agentSessionEpoch = humanSessionEpoch;
      if (actor.isHuman) { humanSessionEpoch++; humanActionsPending++; }
      try {
        await attach(tab, await runtime.context.newPage());
        // 새 탭을 만든 화면은 탐색과 계정 저장을 기다리지 않고 즉시 해당 탭을 표시한다.
        if (actor.isHuman && typeof args.openRequestId === 'string' && args.openRequestId.length <= 160) emit('owned_browser_tab', { tab: descriptor(tab), runtime: runtimeInfo(), openRequestId: args.openRequestId });
        previewActivity(actor, tab); tab.activeActor = actor; if (actor.isHuman && url !== 'about:blank') markHumanOrigin(new URL(url).origin); if (url !== 'about:blank') await tab.page.goto(url, { waitUntil: 'domcontentloaded' }); if (actor.isHuman) markHumanDocument(tab);
      }
      catch (failure) { await tab.page?.close().catch(() => {}); tabs.delete(tab.tabId); throw failure instanceof OwnedBrowserError || failure.code?.startsWith('BROWSER_') ? failure : browserActionFailure(failure); }
      finally { previewActivity(actor, tab, false); tab.activeActor = null; if (actor.isHuman) humanActionsPending--; }
      if (actor.isHuman) await observeHumanSessions();
      else { await recordAgentSessions(url, agentSessionEpoch); await observeHumanSessions(); }
      await assertPolicy(actor, action, requirePage(tab).url(), tab, args);
      publish(tab); await persist(); return !actor.isHuman && challengeFor(tab) ? challengeResult(action, tab) : { ok: true, action, runtime: runtimeInfo(), tab: descriptor(tab) };
    }
    const tab = ownedTab(actor, args.tabId);
    // 사용자가 잡은 탭의 대화상자는 사용자의 것이다.
    if (!actor.isHuman && !userHolds(tab)) await dismissPendingDialog(tab);
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
              tab.activeActor = actor; humanSessionEpoch++; humanActionsPending++;
              if (url !== 'about:blank') markHumanOrigin(new URL(url).origin);
              await attach(tab, page);
              if (url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded' });
              markHumanDocument(tab);
            } catch (failure) {
              await page.close().catch(() => {});
              tab.page = null; tab.nativeTargetId = undefined;
              throw failure;
            } finally { tab.activeActor = null; humanActionsPending--; }
            await observeHumanSessions();
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
      try { if (!tab.page) { tab.sessionId = actor.sessionId ?? tab.sessionId; tab.controllerEpoch++; invalidate(tab); await attach(tab, await runtime.context.newPage()); if (tab.url !== 'about:blank') { markHumanOrigin(new URL(tab.url).origin); await guard.resolve(tab.url); await tab.page.goto(tab.url, { waitUntil: 'domcontentloaded' }); } } }
      finally { tab.activeActor = null; }
      tab.status = 'ready'; tab.controller = { owner: tab.scope === 'global' ? 'human' : 'agent' };
      await selectedAdapter()?.control?.(nativeControl(tab));
      markHumanDocument(tab); await observeHumanSessions(); publish(tab); return { ok: true, action, tab: descriptor(tab), runtime: runtimeInfo(), recovery: 'Page reloaded. Previous uncertain actions were not replayed.' };
    }
    if (action === 'control') {
      if (!actor.isHuman) throw error('BROWSER_HUMAN_REQUIRED', 'Only the user can transfer browser control.');
      epochs(tab, args);
      // 보류는 즉시 걸어 대기 중인 에이전트 쓰기를 막고, 실행 중인 작업은 끝난 뒤 넘겨받는다.
      const epoch = ++tab.controllerEpoch;
      tab.hold = { human: args.owner !== 'agent', clientId: actor.clientId };
      if (args.owner === 'agent') tab.humanDriven = false;
      if (tab.controller.owner === 'human') markHumanDocument(tab);
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
    const blockedByUser = () => requiresControl && !actor.isHuman && userHolds(tab);
    if (blockedByUser()) throw userInControl();
    epochs(tab, args, mutating);
    if (requiresControl) assertController(actor, tab);
    // 사용자가 잡은 탭의 에이전트 읽기는 대기열 밖에서 관찰만 한다. 사용자 입력을 기다리게 하지 않는다.
    const observeOnly = !actor.isHuman && !mutating && userHolds(tab);
    const queuedControlEpoch = tab.controllerEpoch;
    const waitDeadline = action === 'wait' ? Date.now() + bounded(args.timeoutMs, 1, 30_000, 10_000) : undefined;
    const abort = waitDeadline === undefined ? null : new AbortController();
    const signal = abort?.signal;
    let waitTimer;
    const run = async () => {
      signal?.throwIfAborted();
      if (blockedByUser()) throw userInControl();
      epochs(tab, args, mutating);
      if (requiresControl) assertController(actor, tab);
      if (resetting || resetFailed) throw error('BROWSER_RESET_REQUIRED', 'Browser cleanup invalidated the pending action.');
      await assertPolicy(actor, action, action === 'close' ? tab.page?.url?.() ?? tab.url : requirePage(tab).url(), tab, args);
      if (!actor.isHuman && challengeFor(tab) && (mutating && action !== 'close' && !(action === 'navigate' && args.url && !googleResearchURL(args.url)))) return challengeResult(action, tab);
      if (action === 'press') assertAgentKey(actor, args.key);
      if (!actor.isHuman && (signIn || handoffPending)) throw error('BROWSER_SIGN_IN_ACTIVE', 'The user owns the browser profile during sign-in.', true);
      if (blockedByUser()) throw userInControl();
      epochs(tab, args, mutating);
      if (requiresControl) assertController(actor, tab);
      if (!actor.isHuman && SETTLING.has(action)) {
        // 네이티브 ref는 격리 세계가 기록한 요소 정보로, 관리형 ref는 실제 요소로 판단한다.
        const element = args.ref ? requireRef(tab, args) : null;
        const handle = element && !tab.snapshot.native ? await elementFor(tab, args) : null;
        const selfButton = handle && action === 'click' ? await handle.$('xpath=self::button|self::summary|self::input[@type="submit" or @type="button" or @type="image"]') : null;
        const role = handle ? await handle.getAttribute('role') : element?.role;
        const writesText = action === 'type' || action === 'select' || action === 'press' && (['Enter', 'Space'].includes(args.key) || /^[\p{L}\p{N}]$/u.test(args.key));
        const submits = action === 'click' && element && (handle ? !!selfButton || ['button', 'menuitem'].includes(role) : ['button', 'summary'].includes(element.tag) || ['button', 'menuitem'].includes(role) || element.tag === 'input' && ['submit', 'button', 'image'].includes(element.inputType));
        await selfButton?.dispose();
        // Search input is a deliberate exception on exact built-in search origins, not URL-shaped arbitrary sites.
        let search = false;
        const currentURL = new URL(requirePage(tab).url());
        if (SEARCH_ORIGINS.has(currentURL.origin) && element && !(handle ? tab.snapshot.masked?.has(String(args.ref)) : element.sensitive)) {
          const form = handle ? await handle.$('xpath=ancestor-or-self::form[1]') : null;
          const method = form ? await form.getAttribute('method') : element.formMethod;
          const destination = new URL((form ? await form.getAttribute('action') : element.formAction) || currentURL.href, currentURL);
          search = (form || element.formAction) && (method || 'get').toLowerCase() === 'get' && destination.origin === currentURL.origin && /^(?:\/|\/search\/?|\/w\/index\.php)$/.test(destination.pathname);
          await form?.dispose();
        }
        if ((writesText || submits) && !search) await assertPolicy(actor, action, requirePage(tab).url(), tab, { intent: 'website-change' });
      }
      // 관찰만 하는 읽기는 동시에 진행되는 사용자 입력의 네트워크 귀속을 바꾸지 않는다.
      if (!observeOnly) tab.activeActor = actor;
      if (!actor.isHuman && mutating) tab.humanDriven = false;
      const agentSessionEpoch = humanSessionEpoch;
      if (actor.isHuman) { humanSessionEpoch++; humanActionsPending++; }
      if (actor.isHuman && mutating && action !== 'close') markHumanDocument(tab);
      try {
        if (action === 'navigate' && args.url && googleResearchURL(args.url)) tab.searchQuery = new URL(args.url).searchParams.get('q') || tab.searchQuery;
        const adapter = selectedAdapter();
        const activity = adapter?.activity && action !== 'close' && !observeOnly ? {
          targetId: tab.nativeTargetId, tabId: tab.tabId, sessionId: tab.sessionId,
          chatId: tab.threadId, generation: runtime.nativeGeneration, token: id('activity'), agent: !actor.isHuman,
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
          const released = activity ? adapter.activity({ ...activity, active: false }).catch(() => {}) : null;
          if (released && !signal?.aborted) await released;
          if (action !== 'close' && !observeOnly) previewActivity(actor, tab, false);
        }
        signal?.throwIfAborted();
        if (actor.isHuman) { if (mutating && action !== 'close') markHumanDocument(tab); await observeHumanSessions(); }
        else if (action !== 'close' && !observeOnly) { await recordAgentSessions(requirePage(tab).url(), agentSessionEpoch); await observeHumanSessions(); }
        if (mutating && action !== 'close' && queuedControlEpoch !== tab.controllerEpoch) throw error('BROWSER_ACTION_UNCERTAIN', !actor.isHuman && userHolds(tab) ? 'The user took control during this action. Observe the page, then wait or ask the user before continuing.' : 'Control changed during the action. Observe the current page before deciding what to do next.', true);
        if (action !== 'close') await assertPolicy(actor, action, requirePage(tab).url(), tab, args);
        if (value.capture) { const eventCapture = { ...value.capture }; delete eventCapture.screenshot; emit('owned_browser_capture', { capture: eventCapture }); }
        publish(tab); if (!actor.isHuman && action !== 'close' && challengeFor(tab)) return challengeResult(action, tab);
        if (value.consequences) {
          // 조작 결과는 바뀐 점만 돌려준다. 개요는 요청했을 때만 새로 읽고, 실패해도 이미 끝난 조작은 성공으로 남긴다.
          const { navigated, ...changes } = value.consequences; const current = descriptor(tab);
          const delta = { ok: true, action, navigated, url: current.url, title: current.title, ...(navigated ? { navigationEpoch: tab.navigationEpoch } : {}), ...changes };
          if (args.snapshot === true) try { delta.snapshot = await snapshot(tab); } catch (failure) { delta.snapshotError = { code: failure.code?.startsWith('BROWSER_') ? failure.code : 'BROWSER_ACTION_FAILED', message: 'The page changed before it could be observed. Take a new snapshot.' }; }
          return delta;
        }
        return { ok: true, action, runtime: runtimeInfo(), tab: descriptor(tab), ...value };
      } catch (failure) {
        if (failure instanceof OwnedBrowserError || failure.code?.startsWith('BROWSER_')) throw failure;
        const mapped = browserActionFailure(failure);
        mapped.message = redactValues(mapped.message, protectedFor(tab));
        throw mapped;
      } finally { if (!observeOnly) tab.activeActor = null; if (actor.isHuman) humanActionsPending--; }
    };
    const queued = observeOnly ? run() : enqueue(tab, run);
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
    /** 허브만 부른다. resolve 는 입력 직전에 값을 돌려주고, origins 는 사용자가 승인한 사이트다. */
    fillSecret: (actor, args, { origins, resolve }) => performRequest(actor, 'fill-secret', { ...args, [SECRET_FILL]: { origins: [...origins], resolve } }),
    /** 새 사용자 턴은 같은 창이 잡았던 탭을 에이전트와 공유 상태로 되돌린다. tabId 를 주면 그 탭만 돌려준다. */
    async releaseHolds(actor, { tabId } = {}) {
      for (const tab of tabs.values()) {
        if (!tab.hold || tab.hold.clientId !== actor?.clientId || (tabId && tab.tabId !== tabId)) continue;
        tab.hold = null; tab.controllerEpoch++;
        if (tab.page && !tab.page.isClosed()) await selectedAdapter()?.control?.(nativeControl(tab)).catch(() => {});
        publish(tab);
      }
    },
    profileId,
    /** 사용자가 넘겨받은 탭에서 바뀐 세션을 확인 전에 기록한다. */
    observeHumanSessions: () => observeHumanSessions(),
    async nativeAccount(accountId) {
      if (!nativeAdapter?.passwordAccounts || typeof accountId !== 'string') return null;
      return ((await nativeAdapter.passwordAccounts()).accounts ?? []).find((account) => account.id === accountId) ?? null;
    },
    async approveNativeAccount(accountId, approved) {
      if (!nativeAdapter?.passwordApprove) throw error('BROWSER_NATIVE_UNAVAILABLE', 'The desktop password vault is unavailable.', true);
      return nativeAdapter.passwordApprove({ accountId, approved: approved === true });
    },
    /** 사용자가 Chrome에서 가져온 사이트 쿠키는 사용자 세션 변경으로 격리하지 않고 기준선으로 받아들인다. */
    acceptImportedSessions: (domains) => serializeSession(async () => {
      if (!runtime || state !== 'ready' || !Array.isArray(domains)) return { accepted: 0 };
      const roots = domains.filter((domain) => typeof domain === 'string' && /^[a-z0-9.-]{1,253}$/.test(domain)).map((domain) => domain.replace(/^\./, ''));
      const covered = (domain) => roots.some((root) => domain === root || domain.endsWith(`.${root}`));
      const storage = await browserStorageState();
      let accepted = 0;
      for (const [key, fingerprint] of sessionFingerprint(storage)) if (key.startsWith('domain:') && covered(key.slice(7))) { sessionBaseline.set(key, fingerprint); accepted++; }
      for (const cookie of storage.cookies ?? []) if (covered(cookie.domain.replace(/^\./, '').toLowerCase())) cookieBaseline.set(cookieIdentity(cookie), cookie);
      return { accepted };
    }),
    configureSleep({ idleMinutes = 15 } = {}) {
      if (!Number.isInteger(idleMinutes) || idleMinutes < 0 || idleMinutes > 1440) throw error('BROWSER_CONFIGURATION_INVALID', 'Choose an idle timeout between 0 and 1440 minutes.');
      idleSleepMs = idleMinutes * 60_000;
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
      for (const origin of Array.isArray(stored.humanStorageOrigins) ? stored.humanStorageOrigins.slice(0, 2048) : []) { try { const url = new URL(origin); if (['https:', 'http:'].includes(url.protocol) && url.origin === origin) { unconfirmedHumanOrigins.add(origin); humanOrigins.add(origin); } } catch {} }
      for (const record of stored.tabs.slice(0, limits.maxTabs)) {
        if (typeof record.tabId !== 'string' || record.scope !== 'global' && (!record.threadId || !record.agentId)) continue;
        void favicons.get(faviconOrigin(record.url, isWorkspace)).catch(() => {});
        const tab = makeTab(record); Object.assign(tab, { tabId: record.tabId, nativeTargetId: record.nativeTargetId, url: publicURL(record.url), title: text(record.title, 500), openerTabId: typeof record.openerTabId === 'string' ? text(record.openerTabId, 160) : undefined, searchQuery: googleResearchURL(record.url) && typeof record.searchQuery === 'string' ? text(record.searchQuery, 4000) : undefined, restorePending: true, sleeping: record.status === 'sleeping', status: record.status === 'sleeping' ? 'sleeping' : 'disconnected', navigationEpoch: Number(record.navigationEpoch) || 0, controllerEpoch: (Number(record.controllerEpoch) || 0) + 1 }); tabs.set(tab.tabId, tab);
      }
    },
    async close() { if (closed) return; closed = true; clearInterval(sleepTimer); unsubscribeNativeEvents?.(); if (starting) await starting.catch(() => {}); if (handoffPromise) await handoffPromise; clearInterval(checkpointTimer); for (const tab of tabs.values()) { await releaseInput(tab); } await persist().catch(() => {}); await saveCheckpoint().catch(() => {}); await signIn?.close(); await runtime?.close(); await nativeAdapter?.dispose?.(); await favicons.clear(); state = 'closed'; },
  };
}
