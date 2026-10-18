import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { createBrowserCredentialBroker } from '../browser-credentials.mjs';
import { createBrowserPolicy } from '../browser-policy.mjs';
import { createOwnedBrowserService } from '../owned-browser-service.mjs';
import { createBrowserNetworkGuard, createBrowserNetworkProxy } from '../owned-browser-network.mjs';
import { inspectOwnedBrowserRuntime, startOwnedBrowserRuntime } from '../owned-browser-runtime.mjs';

test('human new tabs announce their request identity before navigation completes', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-new-tab-focus-'));
  const events = []; let finishNavigation; let navigationStarted;
  const started = new Promise(resolve => { navigationStarted = resolve; });
  const navigation = new Promise(resolve => { finishNavigation = resolve; });
  let url = 'about:blank';
  const page = Object.assign(new EventEmitter(), { url: () => url, isClosed: () => false, frames: () => [], async routeWebSocket() {}, async close() {},
    async goto(next) { navigationStarted(); await navigation; url = next; },
  });
  const service = createOwnedBrowserService({ dataDir, onEvent: event => events.push(event), lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    runtimeFactory: async () => ({ kind: 'native', browser: new EventEmitter(), async close() {}, context: Object.assign(new EventEmitter(), {
      async storageState() { return { cookies: [], origins: [] }; }, async route() {}, pages: () => [page], async newPage() { return page; },
    }) }),
  });
  t.after(async () => { finishNavigation(); await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const pending = service.request({ isHuman: true, clientId: 'window', sessionId: 'window' }, 'open', { url: 'https://example.com/', openRequestId: 'new-tab-request' });
  await started;
  const created = events.find(event => event.openRequestId === 'new-tab-request');
  assert.equal(created.type, 'owned_browser_tab');
  assert.ok(created.tab.tabId);
  finishNavigation();
  const result = await pending;
  assert.equal(result.tab.tabId, created.tab.tabId);
  assert.equal(result.tab.url, 'https://example.com/');
});

test('failed native setup releases its owned connection before retry and concurrent opens wait for setup', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-native-setup-failure-'));
  let signalSetup; let failSetup;
  const setupEntered = new Promise((resolve) => { signalSetup = resolve; });
  const setup = new Promise((_resolve, reject) => { failSetup = reject; });
  let launches = 0; let releases = 0; let pages = 0; let ownerOccupied = false;
  const browser = createOwnedBrowserService({ dataDir, nativeAdapter: {}, runtimeFactory: async () => {
    assert.equal(ownerOccupied, false, 'an earlier failed native runtime must release its connection');
    ownerOccupied = true; launches++;
    const firstLaunch = launches === 1;
    const context = Object.assign(new EventEmitter(), {
      async storageState() { return { cookies: [], origins: [] }; },
      async route() { if (firstLaunch) { signalSetup(); return setup; } }, pages: () => [],
      async newPage() { pages++; return Object.assign(new EventEmitter(), { url: () => 'about:blank', isClosed: () => false, async close() {}, async routeWebSocket() {}, frames: () => [] }); },
    });
    return { kind: 'native', context, browser: new EventEmitter(), async close() { releases++; ownerOccupied = false; } };
  } });
  t.after(async () => { await browser.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const actor = { isHuman: true, clientId: 'window', sessionId: 'window' };
  const first = browser.request(actor, 'open', {});
  await setupEntered;
  const second = browser.request(actor, 'open', {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await browser.inventory(actor)).runtime.state, 'starting');
  assert.equal(pages, 0, 'opens must not use a partially initialized native runtime');
  const rejected = Promise.all([assert.rejects(first, /Controlled native setup failure/), assert.rejects(second, /Controlled native setup failure/)]);
  failSetup(new Error('Controlled native setup failure'));
  await rejected;
  assert.equal(releases, 1);
  assert.equal(ownerOccupied, false);
  assert.equal((await browser.request(actor, 'open', {})).runtime.state, 'ready');
  assert.equal(launches, 2);
  assert.equal(pages, 1);
});

test('native CDP connection failure reports its phase without disclosing the private endpoint', async (t) => {
  const previousCache = process.env.PLAYWRIGHT_BROWSERS_PATH;
  t.after(() => { if (previousCache === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH; else process.env.PLAYWRIGHT_BROWSERS_PATH = previousCache; });
  // 기존 실행 파일 캐시를 먼저 읽어 다른 실제 런타임 테스트의 설치 경로를 바꾸지 않는다.
  await inspectOwnedBrowserRuntime();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-native-connect-failure-'));
  const server = http.createServer((_request, response) => { response.writeHead(403); response.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  let released = false;
  const secret = 'private-native-endpoint-token';
  await assert.rejects(startOwnedBrowserRuntime({ dataDir, guard: createBrowserNetworkGuard(), nativeAdapter: {
    async start() { return { endpointURL: `ws://127.0.0.1:${server.address().port}/browser/${secret}`, close: async () => { released = true; } }; },
  } }), (failure) => {
    assert.equal(failure.code, 'BROWSER_NATIVE_CONNECT_FAILED');
    assert.equal(failure.details.phase, 'native-cdp');
    assert.match(failure.details.reason, /WebSocket|403/);
    assert.equal(JSON.stringify({ message: failure.message, details: failure.details, cause: failure.cause.message }).includes(secret), false);
    assert.equal(failure.message.includes('competing'), false);
    return true;
  });
  assert.equal(released, true);
});

test('desktop startup selects the native adapter while explicit managed profiles remain managed', async (t) => {
  const nativeAdapter = {};
  for (const [name, options, savedMode, expected] of [
    ['desktop default', { nativeAdapter }, null, nativeAdapter],
    ['web default', {}, null, undefined],
    ['explicit managed', { nativeAdapter, runtimeMode: 'managed' }, null, undefined],
    ['saved managed', { nativeAdapter }, 'managed', undefined],
  ]) await t.test(name, async (subtest) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-browser-selection-'));
    let selected;
    const browser = createOwnedBrowserService({ dataDir, ...options, runtimeFactory: async (settings) => {
      selected = settings.nativeAdapter;
      throw Object.assign(new Error('Controlled startup boundary'), { code: 'BROWSER_START_FAILED' });
    } });
    subtest.after(async () => { await browser.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
    if (savedMode) {
      await fs.mkdir(path.join(dataDir, 'browser'), { recursive: true });
      await fs.writeFile(path.join(dataDir, 'browser', 'runtime.json'), JSON.stringify({ version: 1, mode: savedMode, headless: true }));
    }
    await browser.restore();
    await assert.rejects(browser.request({ isHuman: true, clientId: 'window', threadId: 'chat', agentId: 'owner' }, 'open', {}), { code: 'BROWSER_START_FAILED' });
    assert.equal(selected, expected);
  });
});

test('browser network resolves every hop and permits only exact configured private origins', async () => {
  let address = '93.184.216.34';
  const guard = createBrowserNetworkGuard({ lookup: async () => [{ address, family: 4 }], workspaceTargets: ['http://localhost:7715'] });
  assert.equal((await guard.resolve('https://example.org/research')).address, address);
  address = '127.0.0.1';
  await assert.rejects(guard.resolve('https://example.org/rebound'), { code: 'BROWSER_ADDRESS_BLOCKED' });
  assert.equal((await guard.resolve('http://localhost:7715/view')).address, '127.0.0.1');
  await assert.rejects(guard.resolve('http://localhost:5175/healthz'), { code: 'BROWSER_URL_BLOCKED' });
  await assert.rejects(guard.resolve('https://localhost:7715/'), { code: 'BROWSER_ADDRESS_BLOCKED' });
  assert.throws(() => guard.parse('https://user:password@example.org'), { code: 'BROWSER_URL_INVALID' });
  assert.throws(() => guard.parse('file:///etc/passwd'), { code: 'BROWSER_URL_BLOCKED' });
});

test('network proxy denies requests without its private transport credential', async (t) => {
  const proxy = await createBrowserNetworkProxy(createBrowserNetworkGuard());
  t.after(() => proxy.close());
  const endpoint = new URL(proxy.settings.server);
  const code = await new Promise((resolve, reject) => {
    const request = http.request({ host: endpoint.hostname, port: endpoint.port, path: 'http://127.0.0.1:5175/', method: 'GET' }, (response) => { response.resume(); resolve(response.statusCode); });
    request.once('error', reject); request.end();
  });
  assert.equal(code, 407);
});

async function requireManagedChromium(t) {
  const runtime = await inspectOwnedBrowserRuntime();
  if (process.env.CI) {
    assert.equal(runtime.installed, true, 'CI requires the locked Playwright Chromium installation.');
  }
  if (runtime.installed) return true;
  t.skip('Managed Chromium is not installed; run the owned-browser installer.');
  return false;
}

test('real managed browser keeps login shared while refs and input stay tab scoped', async (t) => {
  if (!await requireManagedChromium(t)) return;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-browser-test-'));
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url, cookie: request.headers.cookie });
    if (request.url === '/redirect-private') { response.writeHead(302, { location: 'http://127.0.0.1:1/internal' }); response.end(); return; }
    if (request.url === '/login') response.setHeader('Set-Cookie', 'fixtureAuth=approved; Path=/; HttpOnly');
    response.setHeader('Content-Type', 'text/html');
    response.end('<title>Owned browser fixture</title><h1>Research</h1><label>Query<input id="query"></label><label>Password<input type="password" value="vault-secret"></label><button onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#query\').value">Search</button><p id="result"></p>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const events = [];
  const browser = createOwnedBrowserService({ dataDir: directory, policy: { assertAllowed: async () => {} }, workspaceTargets: [origin], autoInstall: false, onEvent: (event) => events.push(event) });
  t.after(async () => { await browser.close(); await new Promise((resolve) => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const alice = { sessionId: 'window-a', agentId: 'alice', threadId: 'chat-a', projectId: 'project-a' };
  const bob = { agentId: 'bob', threadId: 'chat-b', projectId: 'project-b' };
  const human = { isHuman: true, clientId: 'window-a', threadId: 'chat-a', agentId: 'alice', projectId: 'project-a' };
  const a = (await browser.request(alice, 'open', { url: `${origin}/login` })).tab;
  const b = (await browser.request(bob, 'open', { url: `${origin}/research` })).tab;
  assert.notEqual(a.tabId, b.tabId);
  assert.ok(requests.some((request) => request.path === '/research' && request.cookie?.includes('fixtureAuth=approved')));
  await assert.rejects(browser.request(bob, 'snapshot', { tabId: a.tabId }), { code: 'BROWSER_TAB_NOT_FOUND' });
  assert.equal((await browser.inventory(alice)).tabs.length, 1);
  let observation = await browser.request(alice, 'snapshot', { tabId: a.tabId });
  assert.deepEqual(events.filter(event => event.type === 'owned_browser_activity' && event.tab.tabId === a.tabId && event.sessionId === 'window-a').map(event => event.active), [true, false, true, false], 'opening and observing each finish their preview activity');
  events.length = 0;
  await browser.request(human, 'snapshot', { tabId: a.tabId });
  assert.equal(events.some(event => event.type === 'owned_browser_activity'), false, 'human observation does not spawn an agent preview');
  observation = await browser.request(alice, 'snapshot', { tabId: a.tabId });
  assert.equal(JSON.stringify(observation).includes('vault-secret'), false);
  const refOf = (snapshot, name) => snapshot.outline.split('\n').find(line => line.includes(`"${name}"`)).match(/\[ref=([^\]]+)\]/)[1];
  assert.match(observation.snapshot.outline, /textbox "Password" \[ref=[^\]]+\]: \[masked\]/);
  const inputArgs = { tabId: a.tabId, snapshotId: observation.snapshot.snapshotId, ref: refOf(observation.snapshot, 'Query'), navigationEpoch: observation.tab.navigationEpoch, controllerEpoch: observation.tab.controllerEpoch, text: '한국어 research' };
  await browser.request(alice, 'type', inputArgs);
  observation = await browser.request(alice, 'snapshot', { tabId: a.tabId });
  assert.match(observation.snapshot.outline, /textbox "Query" \[ref=[^\]]+\]: 한국어 research/);
  await assert.rejects(browser.request(alice, 'type', inputArgs), { code: 'BROWSER_STALE_REFERENCE' });
  const taken = await browser.request(human, 'control', { tabId: a.tabId, owner: 'human' });
  assert.equal(taken.tab.controller.held, true);
  const press = { tabId: a.tabId, key: 'Enter', navigationEpoch: taken.tab.navigationEpoch, controllerEpoch: taken.tab.controllerEpoch };
  await assert.rejects(browser.request(alice, 'press', press), { code: 'BROWSER_USER_IN_CONTROL' });
  events.length = 0;
  const stillReadable = await browser.request(alice, 'snapshot', { tabId: a.tabId });
  assert.ok(stillReadable.snapshot.outline.includes('Research'), 'agent reads continue while the user holds the tab');
  assert.equal(events.some(event => event.type === 'owned_browser_activity'), false, 'observe-only reads do not lock the user out');
  const frame = await browser.request(human, 'frame', { tabId: a.tabId });
  assert.equal(frame.frame.mimeType, 'image/jpeg');
  assert.ok(Buffer.from(frame.frame.data, 'base64').length > 100);
  const capture = await browser.request(human, 'capture', { tabId: a.tabId, frameId: frame.frame.frameId, mode: 'region', region: { x: 0, y: 0, width: 200, height: 100 }, comment: 'Pinned evidence', destinationThreadId: 'chat-a', navigationEpoch: frame.tab.navigationEpoch });
  assert.equal(capture.capture.threadId, 'chat-a');
  assert.equal(capture.capture.comment, 'Pinned evidence');
  assert.equal(capture.capture.screenshot, undefined);
  assert.equal(capture.capture.screenshotError.code, 'BROWSER_PASSWORD_CAPTURE_PROTECTED');
  const returned = await browser.request(human, 'control', { tabId: a.tabId, owner: 'agent' });
  assert.equal(returned.tab.controller.held, undefined);
  await browser.request(alice, 'press', { ...press, navigationEpoch: returned.tab.navigationEpoch, controllerEpoch: returned.tab.controllerEpoch });
  await assert.rejects(browser.request(alice, 'navigate', { tabId: a.tabId, url: `${origin}/redirect-private`, navigationEpoch: returned.tab.navigationEpoch, controllerEpoch: returned.tab.controllerEpoch }), { code: 'BROWSER_ACTION_FAILED' });
  const shared = (await browser.request({ ...human, sessionId: 'window-a' }, 'open', { url: `${origin}/research` })).tab;
  const sidebarAgent = { ...bob, sessionId: 'window-b', activeBrowserTabId: shared.tabId };
  const status = await browser.inventory(sidebarAgent);
  assert.equal(status.activeTabId, shared.tabId);
  assert.deepEqual(status.tabs.map(tab => tab.tabId).sort(), [b.tabId, shared.tabId].sort());
  const current = await browser.request(sidebarAgent, 'snapshot', { tabId: status.activeTabId });
  assert.equal(JSON.stringify(current).includes('vault-secret'), false, 'shared page observations still mask passwords');
  await browser.request(sidebarAgent, 'type', { tabId: shared.tabId, snapshotId: current.snapshot.snapshotId, ref: refOf(current.snapshot, 'Query'),
    navigationEpoch: current.tab.navigationEpoch, controllerEpoch: current.tab.controllerEpoch, text: 'Shared sidebar research' });
  const filled = await browser.request(sidebarAgent, 'snapshot', { tabId: shared.tabId });
  await browser.request(sidebarAgent, 'click', { tabId: shared.tabId, snapshotId: filled.snapshot.snapshotId, ref: refOf(filled.snapshot, 'Search'),
    navigationEpoch: filled.tab.navigationEpoch, controllerEpoch: filled.tab.controllerEpoch });
  assert.ok((await browser.request(human, 'snapshot', { tabId: shared.tabId })).snapshot.outline.includes('Shared sidebar research'));
  assert.ok(events.some(event => event.type === 'owned_browser_activity' && event.tab.tabId === shared.tabId && event.sessionId === 'window-b'), 'activity follows the controlling chat instead of the tab creator');

});

test('encrypted profile checkpoint hooks run on shutdown and restore before observation', async (t) => {
  if (!await requireManagedChromium(t)) return;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-browser-checkpoint-'));
  const calls = [];
  let saved;
  const broker = {
    assertBrowserAccess: async () => {},
    setSessionClearer: () => {},
    saveCheckpoint: async ({ state }) => { calls.push('save'); saved = state; },
    restoreCheckpoint: async () => { calls.push('restore'); return saved; },
  };
  const actor = { agentId: 'owner', threadId: 'chat' };
  const first = createOwnedBrowserService({ dataDir: directory, autoInstall: false, credentialBroker: broker });
  await first.request(actor, 'open', {});
  await first.close();
  assert.deepEqual(calls, ['restore', 'save']);
  assert.ok(Array.isArray(saved.cookies));
  const second = createOwnedBrowserService({ dataDir: directory, autoInstall: false, credentialBroker: broker });
  t.after(async () => { await second.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await second.restore();
  assert.equal((await second.inventory(actor)).tabs[0].status, 'disconnected');
  await second.request(actor, 'open', {});
  assert.equal(calls.filter((value) => value === 'restore').length, 2);
});


test('human tab closure retains epoch and agent scope checks without requiring page input takeover', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-close-control-'));
  let closedPages = 0;
  const browser = createOwnedBrowserService({ dataDir, runtimeFactory: async () => {
    const context = Object.assign(new EventEmitter(), {
      async storageState() { return { cookies: [], origins: [] }; }, async route() {}, pages: () => [],
      async newPage() { return Object.assign(new EventEmitter(), { url: () => 'about:blank', isClosed: () => false, async close() { closedPages++; }, async routeWebSocket() {}, frames: () => [] }); },
    });
    return { kind: 'chromium', context, browser: new EventEmitter(), async close() {} };
  } });
  t.after(async () => { await browser.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const agent = { threadId: 'research', agentId: 'owner' };
  const human = { isHuman: true, clientId: 'editor' };
  const opened = await browser.request(agent, 'open', {});
  const identity = tab => ({ tabId: tab.tabId, navigationEpoch: tab.navigationEpoch, controllerEpoch: tab.controllerEpoch, runtimeGeneration: tab.runtimeGeneration });
  const target = identity(opened.tab);
  await browser.request(human, 'input', { ...target, type: 'release' });
  await assert.rejects(browser.request(human, 'close', { tabId: target.tabId }), { code: 'BROWSER_EPOCH_REQUIRED' });
  await assert.rejects(browser.request(human, 'close', { ...target, navigationEpoch: target.navigationEpoch + 1 }), { code: 'BROWSER_STALE_NAVIGATION' });
  await assert.rejects(browser.request(human, 'close', { ...target, controllerEpoch: target.controllerEpoch + 1 }), { code: 'BROWSER_STALE_CONTROL' });
  await assert.rejects(browser.request(human, 'close', { ...target, runtimeGeneration: target.runtimeGeneration + 1 }), { code: 'BROWSER_STALE_RUNTIME' });
  await assert.rejects(browser.request({ threadId: 'other', agentId: 'other' }, 'close', target), { code: 'BROWSER_TAB_NOT_FOUND' });
  const closed = await browser.request(human, 'close', target);
  assert.equal(closed.completed, true); assert.equal(closedPages, 1); assert.equal((await browser.inventory(human)).tabs.length, 0);
  const humanOwned = await browser.request(human, 'open', {});
  const controlled = await browser.request(human, 'control', { tabId: humanOwned.tab.tabId, owner: 'human' });
  // 사용자가 잡은 탭은 같은 창의 새 턴이 시작되면 소유 에이전트가 다시 조작할 수 있다.
  const next = await browser.request(agent, 'open', {});
  const taken = await browser.request(human, 'control', { tabId: next.tab.tabId, owner: 'human' });
  await assert.rejects(browser.request(agent, 'close', identity(taken.tab)), { code: 'BROWSER_USER_IN_CONTROL' });
  await browser.releaseHolds({ clientId: 'another-editor' });
  await assert.rejects(browser.request(agent, 'close', identity(taken.tab)), { code: 'BROWSER_USER_IN_CONTROL' });
  await browser.releaseHolds(human);
  const released = (await browser.inventory(agent)).tabs.find(tab => tab.tabId === next.tab.tabId);
  assert.equal(released.controller.held, undefined);
  await browser.request(agent, 'close', identity(released));
  await browser.request({ isHuman: true, clientId: 'another-editor' }, 'close', identity((await browser.inventory(human)).tabs.find(tab => tab.tabId === controlled.tab.tabId)));
  assert.equal(closedPages, 3);
});

test('restored native tabs materialize once on selection without transferring control or reviving closed guests', async (t) => {
  if (!await requireManagedChromium(t)) return;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-native-reopen-'));
  const server = http.createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<title>Restored research</title><input id="draft">'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await fs.mkdir(path.join(dataDir, 'browser'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'browser', 'tabs.json'), JSON.stringify({ version: 1, humanStorageOrigins: [origin], tabs: [{ tabId: 'saved-research', nativeTargetId: 'retired-target', threadId: 'chat-a', agentId: 'researcher', projectId: 'project-a', sessionId: 'retired-window', url: `${origin}/research`, navigationEpoch: 3, controllerEpoch: 2 }] }));
  const policy = createBrowserPolicy({ dataDir });
  const credentialBroker = createBrowserCredentialBroker({ dataDir, policy, wrappingKeyProvider: async () => Buffer.alloc(32, 7) });
  const retainedOwner = { threadId: 'chat-a', agentId: 'researcher', projectId: 'project-a' };
  const bindings = [];
  let actual; let creations = 0;
  const browser = createOwnedBrowserService({ dataDir, policy, credentialBroker, workspaceTargets: [origin], autoInstall: false,
    nativeAdapter: { async bind(binding) { bindings.push(binding); }, async control(binding) { assert.equal(binding.human, true); } },
    runtimeFactory: async (settings) => {
      actual = await startOwnedBrowserRuntime({ ...settings, nativeAdapter: undefined });
      for (const initial of actual.context.pages()) await initial.close();
      const newPage = actual.context.newPage.bind(actual.context);
      actual.context.newPage = async () => { creations++; return newPage(); };
      return { ...actual, kind: 'native' };
    },
  });
  t.after(async () => { await browser.close(); await new Promise((resolve) => server.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  await browser.restore();
  const human = { isHuman: true, clientId: 'new-window', sessionId: 'new-window', threadId: 'chat-a', agentId: 'researcher' };
  const args = { tabId: 'saved-research' };
  const [first, second] = await Promise.all([browser.request(human, 'reconnect', args), browser.request(human, 'reconnect', args)]);
  assert.equal(creations, 1);
  assert.equal(first.tab.tabId, args.tabId);
  assert.equal(first.tab.nativeTargetId, second.tab.nativeTargetId);
  assert.notEqual(first.tab.nativeTargetId, 'retired-target');
  assert.equal(first.tab.threadId, 'chat-a'); assert.equal(first.tab.projectId, 'project-a');
  assert.deepEqual(first.tab.controller, { owner: 'agent' });
  assert.equal(first.tab.status, 'ready'); assert.equal(actual.context.pages().length, 1);
  assert.equal(await actual.context.pages()[0].title(), 'Restored research');
  assert.equal((await browser.request(retainedOwner, 'snapshot', args)).ok, true, 'owned-tab access includes the retained session');
  assert.equal(browser.ownsTarget(retainedOwner, first.tab), true);
  assert.equal(browser.ownsTarget({ isHuman: true, sessionId: 'wrong-window' }, first.tab), false);
  assert.equal(browser.downloadTarget({ isHuman: true, sessionId: 'wrong-window' }, `${origin}/file.pdf`), null);
  assert.equal(browser.ownsTarget({ ...retainedOwner, projectId: 'other-project' }, first.tab), false);
  await assert.rejects(browser.request({ ...retainedOwner, projectId: 'other-project' }, 'snapshot', args), { code: 'BROWSER_TAB_NOT_FOUND' });
  assert.equal((await browser.request(human, 'snapshot', args)).ok, true, 'human observation and agent control share the owned browser');
  assert.ok(bindings.every((binding) => binding.sessionId === 'new-window' && binding.chatId === 'chat-a'));
  await assert.rejects(browser.request({ agentId: 'other', threadId: 'other-chat' }, 'snapshot', args), { code: 'BROWSER_TAB_NOT_FOUND' });
  const page = actual.context.pages()[0];
  await page.locator('#draft').fill('retained page state');
  await browser.request(human, 'reconnect', args);
  assert.equal(await page.locator('#draft').inputValue(), 'retained page state'); assert.equal(creations, 1);
  await page.close();
  await assert.rejects(browser.request(human, 'reconnect', args), { code: 'BROWSER_RECONNECT_REQUIRED' });
  assert.equal(creations, 1, 'an in-session destroyed guest requires explicit recovery');
  const closedTab = (await browser.inventory(human)).tabs.find((tab) => tab.tabId === args.tabId);
  await browser.request(human, 'close', { ...args, navigationEpoch: closedTab.navigationEpoch, controllerEpoch: closedTab.controllerEpoch });
  await assert.rejects(browser.request(human, 'reconnect', args), { code: 'BROWSER_TAB_NOT_FOUND' });
  assert.equal(creations, 1);
});

test('native saved searches retain their query and failed materialization closes its guest before retry', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-native-search-reopen-'));
  await fs.mkdir(path.join(dataDir, 'browser'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'browser', 'tabs.json'), JSON.stringify({ version: 1, tabs: [{ tabId: 'saved-search', nativeTargetId: 'old', threadId: 'research', agentId: 'owner', url: 'https://www.google.com/sorry/index', searchQuery: '한국어 research', sessionId: 'old-window' }] }));
  const pages = []; const navigations = []; let failBind = true;
  const browser = createOwnedBrowserService({ dataDir, lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    nativeAdapter: { async bind() { if (failBind) { failBind = false; throw new Error('Controlled binding failure'); } }, async control({ human }) { assert.equal(human, true); } },
    runtimeFactory: async () => ({ kind: 'native', browser: new EventEmitter(), async close() {}, context: Object.assign(new EventEmitter(), {
      async storageState() { return { cookies: [], origins: [] }; }, async route() {}, pages: () => [],
      async newCDPSession(page) { return { async send() { return { targetInfo: { targetId: page.target } }; }, async detach() {} }; },
      async newPage() {
        let closed = false; let url = 'about:blank';
        const page = Object.assign(new EventEmitter(), { target: `new-${pages.length}`, url: () => url, isClosed: () => closed, frames: () => [], async routeWebSocket() {},
          async goto(destination) { navigations.push(destination); url = destination; }, async close() { closed = true; page.emit('close'); } });
        pages.push(page); return page;
      },
    }) }),
  });
  t.after(async () => { await browser.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await browser.restore();
  const human = { isHuman: true, clientId: 'window', sessionId: 'window' };
  const args = { tabId: 'saved-search' };
  await assert.rejects(browser.request(human, 'reconnect', args), /Controlled binding failure/);
  assert.equal(pages[0].isClosed(), true);
  const result = await browser.request(human, 'reconnect', args);
  assert.equal(result.tab.tabId, args.tabId); assert.equal(result.tab.nativeTargetId, 'new-1');
  assert.deepEqual(navigations, ['https://www.google.com/search?q=%ED%95%9C%EA%B5%AD%EC%96%B4+research']);
  let releaseTitle;
  pages[1].title = () => new Promise((resolve) => { releaseTitle = resolve; });
  pages[1].emit('domcontentloaded');
  await pages[1].close();
  await browser.request(human, 'reconnect', { ...args, restore: true });
  assert.equal(pages.length, 3, 'explicit user reconnect can safely reopen an unavailable guest');
  assert.deepEqual(navigations, [navigations[0], navigations[0]]);
  releaseTitle('Retired guest title');
  pages[0].emit('domcontentloaded'); pages[0].emit('crash');
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = (await browser.inventory(human)).tabs[0];
  assert.equal(recovered.status, 'ready', 'late events from retired guests cannot replace the recovered guest state');
  assert.notEqual(recovered.title, 'Retired guest title');
});


test('same-document navigation settles browser readiness while a real unfinished document stays loading', async (t) => {
  if (!await requireManagedChromium(t)) return;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-browser-navigation-ready-'));
  let slowResponse;
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/slow') { slowResponse = response; response.write('<html><head><title>Loading</title></head><body>Waiting'); return; }
    response.end('<title>Ready</title><h1>Research</h1>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let runtime;
  const browser = createOwnedBrowserService({ dataDir, workspaceTargets: [origin], autoInstall: false,
    runtimeFactory: async (settings) => { runtime = await startOwnedBrowserRuntime(settings); return runtime; },
  });
  t.after(async () => { slowResponse?.end(); await browser.close(); await new Promise((resolve) => server.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  const actor = { threadId: 'research', agentId: 'owner' };
  const opened = (await browser.request(actor, 'open', { url: origin })).tab;
  const page = runtime.context.pages().find((page) => page.url().startsWith(origin));
  const read = async () => (await browser.inventory(actor)).tabs.find((tab) => tab.tabId === opened.tabId);
  const waitFor = async (predicate) => { const deadline = Date.now() + 3000; while (Date.now() < deadline) { const tab = await read(); if (predicate(tab)) return tab; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error('Navigation state did not settle'); };
  await page.evaluate(() => { location.hash = 'section'; });
  const hash = await waitFor((tab) => tab.navigationEpoch > opened.navigationEpoch && tab.status === 'ready');
  await page.evaluate(() => { history.pushState({}, '', '/research'); });
  const pushed = await waitFor((tab) => tab.navigationEpoch > hash.navigationEpoch && tab.status === 'ready');
  await assert.rejects(browser.request(actor, 'press', { tabId: opened.tabId, navigationEpoch: opened.navigationEpoch, controllerEpoch: opened.controllerEpoch, key: 'Enter' }), { code: 'BROWSER_STALE_NAVIGATION' });
  const navigating = browser.request(actor, 'navigate', { tabId: pushed.tabId, navigationEpoch: pushed.navigationEpoch, controllerEpoch: pushed.controllerEpoch, url: `${origin}/slow` });
  const loading = await waitFor((tab) => slowResponse && tab.navigationEpoch > pushed.navigationEpoch && tab.status === 'loading');
  assert.equal(loading.status, 'loading');
  slowResponse.end('</body></html>'); await navigating;
  assert.equal((await waitFor((tab) => tab.status === 'ready')).status, 'ready');
});

test('shared browser tabs survive document switches and expose the current sidebar tab to agents', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-global-browser-'));
  let closedPages = 0;
  const runtimeFactory = async () => ({ kind: 'chromium', browser: new EventEmitter(), async close() {}, context: Object.assign(new EventEmitter(), {
    async storageState() { return { cookies: [], origins: [] }; }, async route() {}, pages: () => [],
    async newPage() { return Object.assign(new EventEmitter(), { url: () => 'about:blank', isClosed: () => false, async close() { closedPages++; }, async routeWebSocket() {}, frames: () => [] }); },
  }) });
  const browser = createOwnedBrowserService({ dataDir, runtimeFactory });
  let restored;
  t.after(async () => { await browser.close(); await restored?.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const first = { isHuman: true, clientId: 'window', sessionId: 'document-a', threadId: 'chat-a', documentId: 'a', projectId: 'project-a', agentId: 'chat-a:root' };
  const second = { ...first, sessionId: 'document-b', threadId: 'chat-b', documentId: 'b', projectId: 'project-b', agentId: 'chat-b:root' };
  const opened = await browser.request(first, 'open', { url: 'about:blank' });
  assert.equal(opened.tab.scope, 'global');
  assert.equal(opened.tab.projectId, null); assert.equal(opened.tab.documentId, null); assert.equal(opened.tab.threadId, null);
  const identity = { tabId: opened.tab.tabId, navigationEpoch: opened.tab.navigationEpoch, controllerEpoch: opened.tab.controllerEpoch };
  assert.equal((await browser.inventory(second)).tabs[0].tabId, opened.tab.tabId);
  await browser.request(second, 'input', { ...identity, type: 'release' });
  const agent = { ...second, isHuman: false, activeBrowserTabId: opened.tab.tabId };
  const inventory = await browser.inventory(agent);
  assert.equal(inventory.tabs[0].tabId, opened.tab.tabId);
  assert.equal(inventory.activeTabId, opened.tab.tabId);
  assert.equal(browser.ownsTarget(agent, opened.tab), true);
  const privateTab = (await browser.request({ ...first, isHuman: false }, 'open', { url: 'about:blank' })).tab;
  assert.equal((await browser.inventory(agent)).tabs.length, 1, 'other agents retain their private tab scope');
  assert.equal((await browser.inventory({ ...agent, activeBrowserTabId: privateTab.tabId })).activeTabId, null);
  await assert.rejects(browser.request(agent, 'close', { ...identity, tabId: privateTab.tabId }), { code: 'BROWSER_TAB_NOT_FOUND' });
  await browser.request({ ...first, isHuman: false }, 'close', { tabId: privateTab.tabId, navigationEpoch: privateTab.navigationEpoch, controllerEpoch: privateTab.controllerEpoch });
  await browser.close();
  restored = createOwnedBrowserService({ dataDir, runtimeFactory });
  await restored.restore();
  assert.equal((await restored.inventory(second)).tabs[0].tabId, opened.tab.tabId, 'global tabs restore without a chat owner');
  await restored.request(second, 'close', { ...identity, controllerEpoch: identity.controllerEpoch + 1 });
  assert.equal((await restored.inventory(first)).tabs.length, 0);
  assert.equal(closedPages, 1, 'closing a restored descriptor does not create or reload its page');
});


test('human link popups retain global ownership and downloads are attributed to the user', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-browser-popup-'));
  const page = opener => Object.assign(new EventEmitter(), { url: () => 'about:blank', opener: async () => opener, isClosed: () => false, async close() {}, async routeWebSocket() {}, frames: () => [] });
  const parent = page(null);
  const context = Object.assign(new EventEmitter(), { async storageState() { return { cookies: [], origins: [] }; }, async route() {}, pages: () => [], async newPage() { return parent; } });
  let captured;
  const service = createOwnedBrowserService({ dataDir, downloads: { async handleBrowserDownload(args) { captured = args.actor; } }, runtimeFactory: async () => ({ kind: 'chromium', browser: new EventEmitter(), context, async close() {} }) });
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const actor = { isHuman: true, sessionId: 'window', clientId: 'window' };
  await service.request(actor, 'open', {});
  const popup = page(parent); context.emit('page', popup);
  const deadline = Date.now() + 1000;
  while ((await service.inventory(actor)).tabs.length !== 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  const tabs = (await service.inventory(actor)).tabs;
  assert.equal(tabs.length, 2);
  assert.ok(tabs.every(tab => tab.scope === 'global' && tab.controller.owner === 'human'));
  popup.emit('download', { url: () => 'about:blank', async cancel() {} });
  while (!captured && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(captured?.isHuman, true);
  assert.equal((await service.inventory({ agentId: 'other', threadId: 'other' })).tabs.length, 2, 'user popups are shared with agents too');
});
