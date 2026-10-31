// Chrome 사이트 로그인(sign-in-site) 상태 기계의 경계 상황 회귀 테스트.
// 실제 Electron importSession 규칙(desktop/browser-host.mjs)을 흉내 낸 가짜 어댑터와,
// 닫힐 때 'exit'처럼 onWindowsClosed 를 다시 부르는 가짜 Chrome 창을 쓴다.
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { createOwnedBrowserService } from '../owned-browser-service.mjs';

const human = { isHuman: true, clientId: 'editor', sessionId: 'editor', threadId: 'research', agentId: 'owner' };
const agent = { threadId: 'research', agentId: 'owner', sessionId: 'editor' };
const cookie = (name, domain, value = 'v') => ({ name, domain, value, path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' });
const gate = () => { let open; const promise = new Promise((resolve) => { open = resolve; }); return { promise, open }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(predicate, ms = 1000, label = 'condition') {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail(`timed out waiting for ${label}`);
}
const within = (promise, ms, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms).unref())]);

const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });

/**
 * @param {object} t
 * @param {{ openTab?: boolean, chromeStorage?: any, nativeStorage?: any, account?: any }} settings
 */
async function harness(t, settings = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-site-sign-in-stress-'));
  const checkpoints = new Map();
  const launches = [];
  const imports = [];
  const events = [];
  const signIns = [];
  const confirmations = [];
  const pages = [];
  const bindings = [];
  const hooks = { importSession: null, managedFactory: null, managedStorage: null, signInFactory: null, signInClose: null };
  let closedAt = null;
  const launchesAfterClose = [];
  let nativeStorage = structuredClone(settings.nativeStorage ?? { cookies: [cookie('otherSession', 'other.example', 'keep')], origins: [] });
  const chromeStorage = structuredClone(settings.chromeStorage ?? {
    cookies: [cookie('chatSession', '.chatgpt.com', 'gpt'), cookie('claudeSession', 'claude.ai', 'claude'), cookie('siteSession', 'site.example', 'site')],
    origins: [],
  });
  const openOrigins = () => new Set(pages.filter((page) => !page.isClosed()).map((page) => { try { return new URL(page.url()).origin; } catch { return null; } }));
  // desktop/browser-host.mjs importSession 의 검증을 그대로 따른다.
  const strictImport = async ({ origins, state, reload }) => {
    if (!Array.isArray(origins) || !origins.length || origins.length > 32 || state.cookies.length > 2048) throw new Error('Native session import is invalid');
    const approved = new Set(origins.map((value) => { const url = new URL(value); if (url.protocol !== 'https:' || url.origin !== value) throw new Error('Native session import requires approved exact HTTPS origins'); return value; }));
    const hosts = [...approved].map((value) => new URL(value).hostname);
    const matches = (entry) => { const domain = String(entry.domain ?? '').replace(/^\./, '').toLowerCase(); return !!domain && hosts.some((host) => host === domain || domain.includes('.') && host.endsWith(`.${domain}`)); };
    if (state.cookies.some((entry) => !matches(entry))) throw new Error('Native session cookies exceed the approved account origins');
    for (const entry of state.origins) {
      if (!approved.has(entry.origin)) throw new Error('Native session storage exceeds the approved account origins');
      if (entry.indexedDB?.length) throw Object.assign(new Error('IndexedDB'), { code: 'BROWSER_NATIVE_SESSION_STORAGE_UNSUPPORTED' });
      if (!openOrigins().has(entry.origin) && entry.localStorage.length) throw Object.assign(new Error('Open tab first'), { code: 'BROWSER_NATIVE_SESSION_STORAGE_UNSUPPORTED' });
    }
    imports.push({ origins: [...origins], state: structuredClone(state) });
    const scoped = (entry) => hosts.includes(entry.domain.replace(/^\./, '').toLowerCase());
    nativeStorage = { cookies: [...nativeStorage.cookies.filter((entry) => !scoped(entry)), ...state.cookies], origins: [...nativeStorage.origins.filter((entry) => !approved.has(entry.origin)), ...state.origins] };
    if (reload) for (const page of pages) if (!page.isClosed() && approved.has(new URL(page.url()).origin)) await page.reload();
  };
  const nativeAdapter = {
    async bind(value) { bindings.push(value); }, async control() {},
    async inventory() { return pages.map((page) => ({ nativeTargetId: page.target, tabId: bindings.find((entry) => entry.targetId === page.target)?.tabId })); },
    async importSession(input) { if (hooks.importSession) return hooks.importSession(input, strictImport); return strictImport(input); },
  };
  const newNativePage = () => {
    let url = 'about:blank'; let closed = false;
    const frame = { url: () => url };
    const page = Object.assign(new EventEmitter(), { target: `native-target-${pages.length}`,
      url: () => url, isClosed: () => closed, mainFrame: () => frame, frames: () => [frame],
      async goto(destination) { url = destination; }, async reload() {}, async title() { return 'Fixture'; }, async evaluate() { return 'complete'; },
      async routeWebSocket() {}, async close() { closed = true; page.emit('close'); } });
    pages.push(page); return page;
  };
  const contextFor = (kind) => Object.assign(new EventEmitter(), {
    async storageState() {
      if (kind === 'native') return structuredClone(nativeStorage);
      if (hooks.managedStorage) await hooks.managedStorage();
      return structuredClone(chromeStorage);
    },
    // Playwright: setStorageState 는 기존 쿠키·저장소를 지우고 새 상태로 바꾼다.
    async setStorageState(state) { if (kind === 'native') nativeStorage = structuredClone(state); },
    async route() {}, pages: () => kind === 'native' ? pages.filter((page) => !page.isClosed()) : [],
    async newPage() { assert.equal(kind, 'native', 'agent/human pages must never open in the Chrome sign-in profile'); return newNativePage(); },
    async newCDPSession(page) { return { async send() { return { targetInfo: { targetId: page.target } }; }, async detach() {} }; },
  });
  let runtimeOpen = 0;
  const browser = createOwnedBrowserService({ dataDir, nativeAdapter, lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    onEvent: (event) => events.push(structuredClone(event)),
    runtimeFactory: async ({ nativeAdapter: selected }) => {
      const kind = selected ? 'native' : 'chrome';
      launches.push(kind); if (closedAt !== null) launchesAfterClose.push(kind);
      if (kind === 'chrome' && hooks.managedFactory) await hooks.managedFactory();
      runtimeOpen++;
      let open = true;
      return { kind, browser: new EventEmitter(), context: contextFor(kind), async close() { if (open) { open = false; runtimeOpen--; } } };
    },
    signInFactory: async (settingsIn) => {
      if (hooks.signInFactory) await hooks.signInFactory(settingsIn);
      const record = { url: settingsIn.url, onWindowsClosed: settingsIn.onWindowsClosed, closes: 0 };
      let exited = false;
      // 실제 런처처럼 닫으면 프로세스 'exit'가 onExit·onWindowsClosed 를 부른 뒤 close가 끝난다.
      record.exit = () => { if (exited) return; exited = true; settingsIn.onExit?.(); settingsIn.onWindowsClosed?.(); };
      record.signIn = { mode: 'standalone-no-debug', provider: 'chrome', authenticationMethod: 'mac-passkey', get exited() { return exited; },
        async close() { record.closes++; if (hooks.signInClose) await hooks.signInClose(record); await tick(); record.exit(); } };
      signIns.push(record);
      return record.signIn;
    },
    credentialBroker: {
      async listAccounts() { return { accounts: settings.account ? [settings.account] : [] }; }, setSessionClearer() {},
      async saveCheckpoint({ profileId, state }) { checkpoints.set(profileId, structuredClone(state)); },
      async restoreCheckpoint({ profileId }) { return structuredClone(checkpoints.get(profileId) ?? null); },
      async deleteCheckpoint({ profileId }) { checkpoints.delete(profileId); },
      async confirmAccountSession(input) { confirmations.push(input); return { account: { ...settings.account, sessionStatus: 'authenticated' } }; },
    },
  });
  let closePromise;
  const close = () => { closedAt ??= Date.now(); return closePromise ??= browser.close(); };
  t.after(async () => { await within(close(), 2000, 'browser.close in teardown').catch(() => {}); await fs.rm(dataDir, { recursive: true, force: true }); });
  let opened = null;
  if (settings.openTab !== false) opened = await browser.request(human, 'open', { url: 'https://site.example/research' });
  const runtime = async () => (await browser.inventory(human)).runtime;
  const settled = async (label = 'native runtime') => waitFor(async () => { const value = await runtime(); return value.mode === 'native' && value.signIn === null && value.state === 'ready'; }, 1000, label);
  return { browser, opened, hooks, launches, launchesAfterClose, imports, events, signIns, confirmations, pages, checkpoints,
    storage: () => nativeStorage, chromeStorage, runtime, settled, close, runtimeOpen: () => runtimeOpen,
    lastSignIn: () => signIns.at(-1), signInEvents: () => events.filter((event) => event.type === 'owned_browser_sign_in') };
}

// 1. 창 닫힘 콜백 중복·경합 ----------------------------------------------------------------

test('1a. window-closed firing twice alongside finish imports once and returns to native', async (t) => {
  const f = await harness(t);
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  const closed = f.lastSignIn().onWindowsClosed;
  closed(); closed();
  const finished = await f.browser.request(human, 'sign-in-site-finish');
  closed();
  await f.settled();
  assert.equal(finished.site, 'site.example');
  assert.equal(f.imports.length, 1, 'exactly one import');
  assert.equal(f.lastSignIn().closes, 1, 'Chrome closed once');
  assert.equal(f.signInEvents().filter((event) => event.ok).length, 1);
});

test('1b. a late window-closed callback after finish does not wedge the next Chrome sign-in', async (t) => {
  const f = await harness(t);
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  const first = f.lastSignIn();
  await f.browser.request(human, 'sign-in-site-finish');
  await f.settled();
  // 창 감시가 끝난 뒤 한 번 더 부른다(예: 감시 타이머와 프로세스 종료가 둘 다 알린 경우).
  first.onWindowsClosed();
  await tick();
  assert.equal(f.browser.signInActive?.() ?? false, false, 'ChatGPT/Claude stay busy after a late window-closed callback');
  await f.browser.request(human, 'sign-in-site', { url: 'https://claude.ai/login' });
  assert.equal((await f.runtime()).signIn?.site, 'claude.ai');
  const finished = await within(f.browser.request(human, 'sign-in-site-finish'), 1000, 'second finish');
  assert.equal(finished.site, 'claude.ai', 'the second finish must run, not reuse the stale finished promise');
  assert.equal(f.lastSignIn().closes, 1, 'the second Chrome window is closed');
  await f.settled('native after the second sign-in');
  assert.ok(f.imports.some((entry) => entry.origins.includes('https://claude.ai')), 'Claude cookies imported');
});

test('1c. cancel racing the window-closed callback settles once with no stuck state', async (t) => {
  const f = await harness(t);
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  const cancel = f.browser.request(human, 'sign-in-site-cancel');
  f.lastSignIn().onWindowsClosed();
  await cancel;
  await f.settled();
  assert.ok(f.imports.length <= 1);
  assert.equal(f.lastSignIn().closes, 1);
  await assert.rejects(f.browser.request(human, 'sign-in-site-finish'), { code: 'BROWSER_SIGN_IN_INACTIVE' });
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  assert.equal((await f.runtime()).signIn?.site, 'site.example', 'a fresh sign-in starts after the race');
});

// 2. 연속·중첩 로그인 ---------------------------------------------------------------------

test('2a. a second sign-in-site while one is open is refused and leaves the first intact', async (t) => {
  const f = await harness(t);
  await f.browser.request(human, 'sign-in-site', { url: 'https://chatgpt.com/' });
  await assert.rejects(f.browser.request(human, 'sign-in-site', { url: 'https://claude.ai/' }), { code: 'BROWSER_SIGN_IN_ACTIVE' });
  assert.equal((await f.runtime()).signIn?.site, 'chatgpt.com');
  assert.equal(f.signIns.length, 1);
  await f.browser.request(human, 'sign-in-site-finish');
  await f.settled();
  assert.deepEqual(f.imports.map((entry) => entry.origins), [['https://chatgpt.com']]);
});

test('2b. sign-in-site while the previous finish is reading Chrome reports BROWSER_SIGN_IN_ACTIVE', async (t) => {
  const f = await harness(t);
  await f.browser.request(human, 'sign-in-site', { url: 'https://chatgpt.com/' });
  const hold = gate(); let reading = false;
  f.hooks.managedStorage = async () => { reading = true; await hold.promise; };
  const finish = f.browser.request(human, 'sign-in-site-finish');
  await waitFor(() => reading, 1000, 'finish reading Chrome storage');
  try {
    await assert.rejects(f.browser.request(human, 'sign-in-site', { url: 'https://claude.ai/' }), { code: 'BROWSER_SIGN_IN_ACTIVE' });
  } finally { hold.open(); await finish.catch(() => {}); }
});

test('2c. ChatGPT then Claude back to back imports both and keeps the first', async (t) => {
  const f = await harness(t);
  await f.browser.request(human, 'sign-in-site', { url: 'https://chatgpt.com/' });
  await f.browser.request(human, 'sign-in-site-finish');
  await f.browser.request(human, 'sign-in-site', { url: 'https://claude.ai/login' });
  f.lastSignIn().onWindowsClosed();
  await f.settled();
  assert.deepEqual(f.imports.map((entry) => entry.origins), [['https://chatgpt.com'], ['https://claude.ai']]);
  const names = f.storage().cookies.map((entry) => entry.name).sort();
  assert.deepEqual(names, ['chatSession', 'claudeSession', 'otherSession']);
  const tab = (await f.browser.inventory(human)).tabs.find((entry) => entry.tabId === f.opened.tab.tabId);
  assert.equal(tab.status, 'ready');
});

test('2d. starting Claude while the ChatGPT import is still applying never strands the Claude handoff', async (t) => {
  const f = await harness(t);
  await f.browser.request(human, 'sign-in-site', { url: 'https://chatgpt.com/' });
  const hold = gate(); let importing = false;
  f.hooks.importSession = async (input, strict) => { importing = true; await hold.promise; return strict(input); };
  const first = f.browser.request(human, 'sign-in-site-finish');
  await waitFor(() => importing, 1000, 'ChatGPT import');
  let second;
  try { second = await f.browser.request(human, 'sign-in-site', { url: 'https://claude.ai/' }); }
  catch (failure) { second = failure; }
  f.hooks.importSession = null; hold.open();
  await first.catch(() => {});
  await tick();
  if (second instanceof Error) {
    assert.equal(second.code, 'BROWSER_SIGN_IN_ACTIVE');
    await f.settled();
    return;
  }
  // 받아들였다면 Claude 로그인이 살아 있어야 하고 끝낼 수 있어야 한다.
  assert.equal((await f.runtime()).signIn?.site, 'claude.ai', 'the Claude handoff must still be open after ChatGPT finishes');
  const finished = await f.browser.request(human, 'sign-in-site-finish');
  assert.equal(finished.site, 'claude.ai');
  await f.settled();
});

test('2e. cancel pressed while Chrome is still launching leaves one consistent state', async (t) => {
  const f = await harness(t);
  const hold = gate(); let launching = false;
  f.hooks.signInFactory = async () => { launching = true; await hold.promise; };
  const start = f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  await waitFor(() => launching, 1000, 'Chrome launch');
  let cancel;
  try { cancel = await f.browser.request(human, 'sign-in-site-cancel'); } catch (failure) { cancel = failure; }
  hold.open();
  await start.catch(() => {});
  await tick();
  const runtime = await f.runtime();
  if (runtime.signIn) {
    // Chrome이 열린 채 남았다면 사이트가 보이고 끝낼 수 있어야 한다.
    assert.equal(runtime.signIn.site, 'site.example', `open Chrome without a site (cancel result: ${cancel?.code ?? 'ok'})`);
    await f.browser.request(human, 'sign-in-site-cancel');
  }
  await f.settled('native after cancel during launch');
  await f.browser.request(agent, 'open', { url: 'https://site.example/after' });
});

// 3. 가져오기 실패 --------------------------------------------------------------------------

test('3a. importSession throwing returns to native, clears signIn, emits ok:false, and the next sign-in works', async (t) => {
  const f = await harness(t);
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  f.hooks.importSession = async () => { throw new Error('native host exploded'); };
  await assert.rejects(f.browser.request(human, 'sign-in-site-finish'));
  await f.settled();
  assert.deepEqual(f.signInEvents().map((event) => [event.site, event.ok]), [['site.example', false]]);
  const tab = (await f.browser.inventory(human)).tabs.find((entry) => entry.tabId === f.opened.tab.tabId);
  assert.equal(tab.status, 'ready');
  f.hooks.importSession = null;
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  await f.browser.request(human, 'sign-in-site-finish');
  await f.settled();
  assert.equal(f.imports.length, 1);
});

test('3b. BROWSER_NATIVE_SESSION_STORAGE_UNSUPPORTED via window close surfaces its code and recovers', async (t) => {
  const f = await harness(t);
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  f.hooks.importSession = async () => { throw Object.assign(new Error('IndexedDB'), { code: 'BROWSER_NATIVE_SESSION_STORAGE_UNSUPPORTED' }); };
  f.lastSignIn().onWindowsClosed();
  await f.settled();
  assert.deepEqual(f.signInEvents().map((event) => [event.ok, event.code]), [[false, 'BROWSER_NATIVE_SESSION_STORAGE_UNSUPPORTED']]);
  f.hooks.importSession = null;
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  assert.equal((await f.runtime()).signIn?.site, 'site.example');
});

test('3c. a failed import keeps the native checkpoint of other sites', async (t) => {
  const f = await harness(t);
  await f.browser.inventory(human);
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  f.hooks.importSession = async () => { throw new Error('native host exploded'); };
  await assert.rejects(f.browser.request(human, 'sign-in-site-finish'));
  await f.settled();
  const checkpoint = f.checkpoints.get('native');
  assert.ok(checkpoint?.cookies.some((entry) => entry.name === 'otherSession'), `native checkpoint lost other sites: ${JSON.stringify(checkpoint?.cookies.map((entry) => entry.name))}`);
});

// 4. 관리형 런타임·Chrome 닫기 실패 -----------------------------------------------------------

test('4a. the managed runtime failing to start recovers to native and the next sign-in works', async (t) => {
  const f = await harness(t);
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  f.hooks.managedFactory = async () => { throw Object.assign(new Error('chrome profile locked'), { code: 'BROWSER_START_FAILED' }); };
  await assert.rejects(f.browser.request(human, 'sign-in-site-finish'), { code: 'BROWSER_START_FAILED' });
  await f.settled();
  assert.equal(f.signInEvents().at(-1).code, 'BROWSER_START_FAILED');
  f.hooks.managedFactory = null;
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  await f.browser.request(human, 'sign-in-site-finish');
  await f.settled();
  assert.equal(f.imports.length, 1);
});

test('4b. Chrome refusing to close (BROWSER_SIGN_IN_CLOSE_FAILED) can be retried or cancelled', async (t) => {
  const f = await harness(t);
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  f.hooks.signInClose = async () => { throw Object.assign(new Error('Close the sign-in browser'), { code: 'BROWSER_SIGN_IN_CLOSE_FAILED', retryable: true }); };
  await assert.rejects(f.browser.request(human, 'sign-in-site-finish'), { code: 'BROWSER_SIGN_IN_CLOSE_FAILED' });
  f.hooks.signInClose = null;
  const runtime = await f.runtime();
  // 재시도 가능한 오류다. 사이트 로그인이 살아 있어 다시 끝낼 수 있거나, 완전히 네이티브로 돌아와 있어야 한다.
  if (runtime.signIn) {
    assert.equal(runtime.signIn.site, 'site.example', `Chrome still open but the site handoff is gone (mode ${runtime.mode}, state ${runtime.state})`);
    await f.browser.request(human, 'sign-in-site-finish');
  }
  await f.settled('native after a close failure');
  await f.browser.request(agent, 'open', { url: 'https://site.example/after' });
});

test('4c. service close does not hang while the managed runtime launch hangs', async (t) => {
  const f = await harness(t);
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  const hold = gate(); let launching = false;
  f.hooks.managedFactory = async () => { launching = true; await hold.promise; };
  const finish = f.browser.request(human, 'sign-in-site-finish').catch(() => {});
  await waitFor(() => launching, 1000, 'managed launch');
  try { await within(f.close(), 1000, 'close() during a hanging managed launch'); }
  finally { hold.open(); await finish; }
});

// 5. 빈 Chrome 저장소 -----------------------------------------------------------------------

test('5. Chrome with no session for the site reports BROWSER_SITE_SIGN_IN_EMPTY and recovers', async (t) => {
  const f = await harness(t, { chromeStorage: { cookies: [cookie('x', 'unrelated.example')], origins: [] } });
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  await assert.rejects(f.browser.request(human, 'sign-in-site-finish'), { code: 'BROWSER_SITE_SIGN_IN_EMPTY' });
  await f.settled();
  assert.deepEqual(f.signInEvents().map((event) => [event.ok, event.code]), [[false, 'BROWSER_SITE_SIGN_IN_EMPTY']]);
  assert.equal(f.imports.length, 0);
  assert.deepEqual(f.storage().cookies.map((entry) => entry.name), ['otherSession']);
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  assert.equal((await f.runtime()).signIn?.site, 'site.example');
});

// 6. 쿠키 범위 -------------------------------------------------------------------------------

test('6a. only cookies inside the registrable domain are imported and the desktop importer accepts them', async (t) => {
  const chromeStorage = { cookies: [
    cookie('root', 'site.example'), cookie('dotted', '.site.example'), cookie('__Host-id', 'site.example'), cookie('__Secure-id', '.site.example'),
    cookie('apiOnly', 'api.site.example'), cookie('deep', '.a.b.site.example'), cookie('mixedCase', 'WWW.Site.Example'),
    cookie('evil', 'evilsite.example'), cookie('evilDot', '.evilsite.example'), cookie('xsite', 'xsite.example'), cookie('suffixTrick', 'site.example.attacker.test'),
  ], origins: [{ origin: 'https://site.example', localStorage: [{ name: 'k', value: 'v' }], indexedDB: [{ name: 'db' }] }, { origin: 'https://evilsite.example', localStorage: [{ name: 'k', value: 'evil' }] }] };
  const f = await harness(t, { chromeStorage });
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  await f.browser.request(human, 'sign-in-site-finish');
  await f.settled();
  assert.equal(f.imports.length, 1);
  const [imported] = f.imports;
  assert.deepEqual(imported.state.cookies.map((entry) => entry.name).sort(), ['__Host-id', '__Secure-id', 'apiOnly', 'deep', 'dotted', 'mixedCase', 'root'].sort());
  assert.ok(imported.origins.every((value) => /^https:\/\/([a-z0-9-]+\.)*site\.example$/.test(value)), JSON.stringify(imported.origins));
  assert.deepEqual(imported.state.origins, [{ origin: 'https://site.example', localStorage: [{ name: 'k', value: 'v' }] }]);
});

test('6d. a cookie scoped above the registrable domain is not imported and does not sink the whole import', async (t) => {
  const f = await harness(t, { chromeStorage: { cookies: [cookie('root', 'site.example'), cookie('parent', '.example')], origins: [] } });
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  await f.browser.request(human, 'sign-in-site-finish');
  await f.settled();
  assert.deepEqual(f.imports.map((entry) => entry.state.cookies.map((value) => value.name)), [['root']]);
});

test('6b. more than 32 subdomain origins still import the site root session', async (t) => {
  const many = Array.from({ length: 40 }, (_, index) => cookie(`sub${index}`, `s${index}.site.example`));
  const f = await harness(t, { chromeStorage: { cookies: [...many, cookie('rootSession', '.site.example', 'root')], origins: [] } });
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  await f.browser.request(human, 'sign-in-site-finish');
  await f.settled();
  assert.equal(f.imports.length, 1);
  assert.ok(f.imports[0].origins.length <= 32);
  assert.ok(f.imports[0].state.cookies.some((entry) => entry.name === 'rootSession'), 'the site-wide session cookie must survive the 32-origin cap');
});

test('6c. finishing with no app browser tabs open keeps other sites signed in', async (t) => {
  const f = await harness(t, { openTab: false });
  // 네이티브 브라우저를 한 번 띄워 다른 사이트 세션이 체크포인트에 있게 한다.
  await f.browser.request(human, 'open', { url: 'https://other.example/' });
  await f.browser.request(human, 'close', { tabId: (await f.browser.inventory(human)).tabs[0].tabId }).catch(async () => {
    for (const page of f.pages) await page.close();
  });
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  await f.browser.request(human, 'sign-in-site-finish');
  await f.settled();
  const names = f.storage().cookies.map((entry) => entry.name).sort();
  assert.ok(names.includes('otherSession'), `other.example session was wiped: ${JSON.stringify(names)}`);
  assert.ok(names.includes('siteSession'));
});

// 7. 주소 검증 -------------------------------------------------------------------------------

async function assertRejectedWithoutChange(f, url, codes) {
  const before = { launches: f.launches.length, signIns: f.signIns.length };
  await assert.rejects(f.browser.request(human, 'sign-in-site', { url }), (failure) => {
    assert.ok(codes.includes(failure.code), `${url}: expected one of ${codes.join(', ')}, got ${failure.code} (${failure.message})`);
    return true;
  }, `${url} must be rejected`);
  const runtime = await f.runtime();
  assert.equal(runtime.mode, 'native', url); assert.equal(runtime.signIn, null, url);
  assert.equal(f.signIns.length, before.signIns, `${url} launched Chrome`);
  assert.equal(f.launches.length, before.launches, `${url} restarted a runtime`);
}

// 받아들여진 주소와 그때 Chrome이 가져올 사이트 범위를 모은다. 받아들였으면 취소해 다음 주소를 시험한다.
async function acceptedUrls(f, urls) {
  const accepted = [];
  for (const url of urls) {
    try { const started = await f.browser.request(human, 'sign-in-site', { url }); accepted.push(`${url} -> site ${started.runtime.signIn?.site}`); await f.browser.request(human, 'sign-in-site-cancel'); await f.settled(); }
    catch (failure) { assert.ok(['BROWSER_SITE_SIGN_IN_UNAVAILABLE', 'BROWSER_ADDRESS_BLOCKED', 'BROWSER_URL_BLOCKED'].includes(failure.code), `${url}: ${failure.code}`); }
  }
  return accepted;
}

test('7a. non-HTTPS, credentialed and script URLs are rejected without a state change', async (t) => {
  const f = await harness(t);
  await assertRejectedWithoutChange(f, 'http://site.example/', ['BROWSER_URL_BLOCKED', 'BROWSER_SITE_SIGN_IN_UNAVAILABLE']);
  await assertRejectedWithoutChange(f, 'https://user:pass@site.example/', ['BROWSER_URL_INVALID']);
  await assertRejectedWithoutChange(f, 'data:text/html,hi', ['BROWSER_URL_BLOCKED', 'BROWSER_URL_INVALID']);
  await assertRejectedWithoutChange(f, 'javascript:alert(1)', ['BROWSER_URL_BLOCKED', 'BROWSER_URL_INVALID']);
  await assertRejectedWithoutChange(f, 'file:///etc/passwd', ['BROWSER_URL_BLOCKED', 'BROWSER_URL_INVALID']);
  await assertRejectedWithoutChange(f, 'not a url', ['BROWSER_URL_INVALID']);
  await assertRejectedWithoutChange(f, undefined, ['BROWSER_URL_INVALID']);
});

test('7b. public-suffix hosts are rejected so one sign-in cannot import every site under the suffix', async (t) => {
  const f = await harness(t);
  assert.deepEqual(await acceptedUrls(f, ['https://github.io/', 'https://vercel.app/', 'https://co.uk/', 'https://com/']), []);
});

test('7c. loopback and IP hosts are rejected like the rest of the app browser', async (t) => {
  const f = await harness(t);
  assert.deepEqual(await acceptedUrls(f, ['https://127.0.0.1/', 'https://localhost/', 'https://[::1]/', 'https://10.0.0.5/']), []);
});

// 8. 서비스 종료 -----------------------------------------------------------------------------

test('8a. closing the service during an open handoff finishes fast and starts no runtime afterwards', async (t) => {
  const f = await harness(t);
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  const unhandledBefore = unhandled.length;
  await within(f.close(), 1000, 'close() during handoff');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(f.launchesAfterClose, [], 'the window-closed callback from shutting Chrome must not relaunch browsers');
  assert.equal(f.runtimeOpen(), 0, 'no runtime left open after close');
  assert.equal(unhandled.length, unhandledBefore);
});

test('8b. closing the service during finish finishes fast and starts no runtime afterwards', async (t) => {
  const f = await harness(t);
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  const hold = gate(); let reading = false;
  f.hooks.managedStorage = async () => { reading = true; await hold.promise; };
  const finish = f.browser.request(human, 'sign-in-site-finish').then(() => 'ok', (failure) => failure);
  await waitFor(() => reading, 1000, 'finish reading Chrome storage');
  const unhandledBefore = unhandled.length;
  const closing = within(f.close(), 1000, 'close() during finish');
  hold.open();
  await closing;
  await within(finish, 1000, 'finish after close');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(f.launchesAfterClose, [], 'finish must not relaunch the native browser after close');
  assert.equal(f.runtimeOpen(), 0, 'no runtime left open after close');
  assert.equal(unhandled.length, unhandledBefore);
});

// 9. 계정 기반 로그인과 섞기 -----------------------------------------------------------------

test('9a. account sign-in after a site sign-in still returns to native with the native profile', async (t) => {
  const accountOrigin = 'https://acct.example';
  const account = { id: 'acct', profileId: 'default', origin: accountOrigin, origins: [accountOrigin], agentBlocked: false, sessionStatus: 'saved' };
  const f = await harness(t, { account, chromeStorage: { cookies: [cookie('siteSession', 'site.example'), cookie('acctSession', 'acct.example')], origins: [] } });
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  await f.browser.request(human, 'sign-in-site-finish');
  await f.settled();
  await f.browser.request(human, 'sign-in', { accountId: 'acct', url: `${accountOrigin}/login`, authenticationMethod: 'mac-passkey' });
  const confirmed = await f.browser.request(human, 'confirm-sign-in', { accountId: 'acct' });
  assert.equal(confirmed.runtime.mode, 'native');
  assert.equal(f.confirmations[0].additionalProfileId, 'native');
  assert.ok(f.storage().cookies.some((entry) => entry.name === 'acctSession'));
});

test('9b. a stray window-closed callback from the old site sign-in does not hijack a later account sign-in', async (t) => {
  const accountOrigin = 'https://acct.example';
  const account = { id: 'acct', profileId: 'default', origin: accountOrigin, origins: [accountOrigin], agentBlocked: false, sessionStatus: 'saved' };
  const f = await harness(t, { account, chromeStorage: { cookies: [cookie('siteSession', 'site.example'), cookie('acctSession', 'acct.example')], origins: [] } });
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  const old = f.lastSignIn();
  await f.browser.request(human, 'sign-in-site-finish');
  await f.settled();
  await f.browser.request(human, 'sign-in', { accountId: 'acct', url: `${accountOrigin}/login`, authenticationMethod: 'mac-passkey' });
  old.onWindowsClosed();
  await tick(); await tick();
  const during = await f.runtime();
  assert.equal(during.signIn?.accountId, 'acct', 'the account handoff must stay open');
  const confirmed = await f.browser.request(human, 'confirm-sign-in', { accountId: 'acct' });
  assert.equal(confirmed.runtime.mode, 'native');
  assert.equal(f.confirmations[0].additionalProfileId, 'native');
});

// 10. 에이전트 호출 -------------------------------------------------------------------------

test('10a. agents are refused while finish still holds the Chrome profile, and status keeps answering', async (t) => {
  const f = await harness(t);
  await f.browser.request(human, 'sign-in-site', { url: 'https://site.example/login' });
  await assert.rejects(f.browser.request(agent, 'open', { url: 'https://site.example/a' }), { code: 'BROWSER_SIGN_IN_ACTIVE' });
  const hold = gate(); let reading = false;
  f.hooks.managedStorage = async () => { reading = true; await hold.promise; };
  const finish = f.browser.request(human, 'sign-in-site-finish');
  await waitFor(() => reading, 1000, 'finish reading Chrome storage');
  try {
    const status = await within(f.browser.request(agent, 'status'), 500, 'agent status during finish');
    assert.ok(status.runtime);
    await within(f.browser.inventory(human), 500, 'inventory during finish');
    let agentResult;
    try { agentResult = await within(f.browser.request(agent, 'open', { url: 'https://site.example/b' }), 500, 'agent open during finish'); }
    catch (failure) { agentResult = failure; }
    assert.equal(agentResult?.code, 'BROWSER_SIGN_IN_ACTIVE', `agent open during finish ran in the Chrome sign-in profile: ${agentResult?.code ?? JSON.stringify(agentResult?.runtime?.mode)}`);
  } finally { hold.open(); await finish.catch(() => {}); }
});

test('10b. after the handoff an agent tab and a hub ChatGPT drive both work on the native browser', async (t) => {
  const f = await harness(t);
  await f.browser.request(human, 'sign-in-site', { url: 'https://chatgpt.com/' });
  assert.equal(f.browser.nativeActive(), false);
  f.lastSignIn().onWindowsClosed();
  await f.settled();
  assert.equal(f.browser.nativeActive(), true);
  assert.equal(f.browser.signInActive?.() ?? false, false);
  const opened = await f.browser.request(agent, 'open', { url: 'https://site.example/after' });
  assert.equal(opened.tab.status, 'ready');
  const chatgpt = { threadId: 'chatgpt', agentId: 'chatgpt:driver', projectId: null, documentId: null, sessionId: 'editor', taskId: null, isHuman: false, system: 'chatgpt' };
  const result = await within(f.browser.drive(chatgpt, { url: 'https://chatgpt.com/' }, async (page) => page.url()), 1000, 'ChatGPT drive');
  assert.equal(result, 'https://chatgpt.com/');
});
