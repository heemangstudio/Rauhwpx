import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { createIpcNativeBrowserAdapter, createOwnedBrowserService } from '../owned-browser-service.mjs';
import { inspectOwnedBrowserRuntime } from '../owned-browser-runtime.mjs';

const agent = { threadId: 'chat', agentId: 'researcher', sessionId: 'window' };
const human = { isHuman: true, clientId: 'window', sessionId: 'window' };
const ids = tab => ({ tabId: tab.tabId, navigationEpoch: tab.navigationEpoch, controllerEpoch: tab.controllerEpoch });

function fakeRuntime({ wheel = async () => {}, nativeTargetId } = {}) {
  const page = Object.assign(new EventEmitter(), {
    url: () => 'https://example.com/', isClosed: () => false, frames: () => [], async routeWebSocket() {}, async close() {}, async goto() {},
    async evaluate() { return ''; }, locator: () => ({ async elementHandles() { return []; }, async innerText() { return 'Fixture page'; } }),
    mouse: { wheel, async up() {} }, keyboard: { async up() {} },
  });
  const context = Object.assign(new EventEmitter(), {
    async storageState() { return { cookies: [], origins: [] }; }, async route() {}, pages: () => [], async newPage() { return page; },
    async newCDPSession() { return { async send() { return { targetInfo: { targetId: nativeTargetId } }; }, async detach() {} }; },
  });
  return async () => ({ kind: nativeTargetId ? 'native' : 'chromium', nativeGeneration: 'native-generation', context, browser: new EventEmitter(), async close() {} });
}

async function service(t, options) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-browser-control-'));
  const browser = createOwnedBrowserService({ dataDir, lookup: async () => [{ address: '93.184.216.34', family: 4 }], ...options });
  t.after(async () => { await browser.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return browser;
}

test('a user takeover fails queued agent input fast, marks the in-flight action uncertain and keeps agent reads outside the queue', async (t) => {
  let wheels = 0; let release; let started;
  const wheelStarted = () => new Promise(resolve => { started = resolve; });
  const wheel = () => { wheels++; started?.(); return new Promise(resolve => { release = resolve; }); };
  const browser = await service(t, { runtimeFactory: fakeRuntime({ wheel }) });
  const opened = (await browser.request(agent, 'open', { url: 'https://example.com/' })).tab;
  let running = wheelStarted();
  const inFlight = browser.request(agent, 'scroll', { ...ids(opened), deltaY: 100 });
  await running;
  const queued = browser.request(agent, 'scroll', { ...ids(opened), deltaY: 200 });
  const taking = browser.request(human, 'control', { tabId: opened.tabId, owner: 'human' });
  release();
  await assert.rejects(inFlight, { code: 'BROWSER_ACTION_UNCERTAIN' });
  await assert.rejects(queued, { code: 'BROWSER_USER_IN_CONTROL' });
  const taken = (await taking).tab;
  assert.equal(taken.controller.held, true);
  assert.equal(wheels, 1, 'queued agent input never reaches the page after the user takes control');

  // 사용자의 입력이 대기열을 점유하는 동안에도 에이전트 읽기는 바로 끝난다.
  running = wheelStarted();
  const userInput = browser.request(human, 'input', { ...ids(taken), type: 'wheel', deltaY: 50 });
  await running;
  const observed = await browser.request(agent, 'snapshot', { tabId: opened.tabId });
  assert.equal(observed.snapshot.text, 'Fixture page');
  await assert.rejects(browser.request(agent, 'scroll', { ...ids(taken), deltaY: 10 }), { code: 'BROWSER_USER_IN_CONTROL' });
  release(); await userInput;

  const returned = (await browser.request(human, 'control', { tabId: opened.tabId, owner: 'agent' })).tab;
  assert.equal(returned.controller.held, undefined);
  running = wheelStarted();
  const resumed = browser.request(agent, 'scroll', { ...ids(returned), deltaY: 10 });
  await running; release();
  assert.equal((await resumed).ok, true);
});

test('a timed-out wait abandons its queued work so the next action is not blocked', async (t) => {
  let activities = 0; let finishStuck;
  const nativeAdapter = {
    async bind() { return { generation: 'native-generation' }; }, async control() {}, async inventory() { return []; },
    activity({ active }) {
      if (active && ++activities === 1) return new Promise(resolve => { finishStuck = resolve; setTimeout(resolve, 3000).unref?.(); });
      return Promise.resolve({ active });
    },
  };
  const browser = await service(t, { nativeAdapter, runtimeFactory: fakeRuntime({ nativeTargetId: 'native-target' }) });
  t.after(() => finishStuck?.());
  const opened = (await browser.request(agent, 'open', { url: 'https://example.com/' })).tab;
  const waited = Date.now();
  await assert.rejects(browser.request(agent, 'wait', { tabId: opened.tabId, condition: 'ready', timeoutMs: 150 }), { code: 'BROWSER_ACTION_TIMEOUT' });
  assert.ok(Date.now() - waited < 1000, 'the wait honours its own deadline');
  const scrolled = Date.now();
  assert.equal((await browser.request(agent, 'scroll', { ...ids(opened), deltaY: 10 })).ok, true);
  assert.ok(Date.now() - scrolled < 1000, 'the next action runs without waiting for the abandoned wait');
});

test('native host failures are final while lost or slow desktop connections stay retryable', async () => {
  const events = new EventEmitter(); const sent = [];
  const adapter = createIpcNativeBrowserAdapter({ send: message => sent.push(message), events, timeoutMs: 50 });
  const refused = adapter.control({ targetId: 'target' });
  events.emit('message', { type: 'rhwp-browser-response', id: sent[0].id, ok: false, error: { code: 'NATIVE_BROWSER_FAILED', message: 'Native browser tab is unavailable' } });
  await assert.rejects(refused, { code: 'NATIVE_BROWSER_FAILED', retryable: false });
  await assert.rejects(adapter.control({ targetId: 'target' }), { code: 'BROWSER_NATIVE_TIMEOUT', retryable: true });
  await adapter.dispose();
});

test('real Playwright failures keep a typed reason for covered, detached and non-editable targets', async (t) => {
  if (!(await inspectOwnedBrowserRuntime()).installed) { t.skip('Managed Chromium is not installed; run the owned-browser installer.'); return; }
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<title>Targets</title><button onclick="document.querySelector('#target').remove()">Remove</button><button id="target">Target</button>
      <button style="position:absolute;top:200px;left:20px">Covered</button>
      <div id="cover" class="overlay sheet" style="position:absolute;top:180px;left:0;width:320px;height:80px;background:#eee">Private banner text</div>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await service(t, { policy: { assertAllowed: async () => {} }, workspaceTargets: [origin], autoInstall: false });
  const opened = (await browser.request(agent, 'open', { url: `${origin}/` })).tab;
  const observed = await browser.request(agent, 'snapshot', { tabId: opened.tabId });
  const target = name => ({ ...ids(observed.tab), snapshotId: observed.snapshot.snapshotId, ref: observed.snapshot.elements.find(element => element.name === name).ref });
  await assert.rejects(browser.request(agent, 'type', { ...target('Target'), text: 'research' }), { code: 'BROWSER_NOT_EDITABLE' });
  await browser.request(agent, 'click', target('Remove'));
  await assert.rejects(browser.request(agent, 'click', target('Target')), { code: 'BROWSER_TARGET_DETACHED' });
  const covered = await browser.request(agent, 'click', target('Covered')).catch(failure => failure);
  assert.equal(covered.code, 'BROWSER_TARGET_COVERED');
  assert.match(covered.message, /div#cover\.overlay\.sheet/);
  assert.equal(covered.message.includes('Private banner text'), false, 'the covering element is described without its page text');
});
