import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createOwnedBrowserService } from '../owned-browser-service.mjs';
import { createBrowserNetworkGuard, createBrowserNetworkProxy } from '../owned-browser-network.mjs';
import { inspectOwnedBrowserRuntime } from '../owned-browser-runtime.mjs';

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
  const browser = createOwnedBrowserService({ dataDir: directory, workspaceTargets: [origin], autoInstall: false });
  t.after(async () => { await browser.close(); await new Promise((resolve) => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const alice = { agentId: 'alice', threadId: 'chat-a', projectId: 'project-a' };
  const bob = { agentId: 'bob', threadId: 'chat-b', projectId: 'project-b' };
  const human = { isHuman: true, clientId: 'window-a', threadId: 'chat-a', agentId: 'alice', projectId: 'project-a' };
  const a = (await browser.request(alice, 'open', { url: `${origin}/login` })).tab;
  const b = (await browser.request(bob, 'open', { url: `${origin}/research` })).tab;
  assert.notEqual(a.tabId, b.tabId);
  assert.ok(requests.some((request) => request.path === '/research' && request.cookie?.includes('fixtureAuth=approved')));
  await assert.rejects(browser.request(bob, 'snapshot', { tabId: a.tabId }), { code: 'BROWSER_TAB_NOT_FOUND' });
  assert.equal((await browser.inventory(alice)).tabs.length, 1);
  let observation = await browser.request(alice, 'snapshot', { tabId: a.tabId });
  assert.equal(JSON.stringify(observation).includes('vault-secret'), false);
  const query = observation.snapshot.elements.find((element) => element.tag === 'input' && !element.sensitive);
  const inputArgs = { tabId: a.tabId, snapshotId: observation.snapshot.snapshotId, ref: query.ref, navigationEpoch: observation.tab.navigationEpoch, controllerEpoch: observation.tab.controllerEpoch, text: '한국어 research' };
  await browser.request(alice, 'type', inputArgs);
  observation = await browser.request(alice, 'snapshot', { tabId: a.tabId });
  assert.ok(observation.snapshot.elements.some((element) => element.value === '한국어 research'));
  await assert.rejects(browser.request(alice, 'type', inputArgs), { code: 'BROWSER_STALE_REFERENCE' });
  const taken = await browser.request(human, 'control', { tabId: a.tabId, owner: 'human' });
  await assert.rejects(browser.request(alice, 'press', { tabId: a.tabId, key: 'Enter', navigationEpoch: taken.tab.navigationEpoch, controllerEpoch: taken.tab.controllerEpoch }), { code: 'BROWSER_HUMAN_CONTROL' });
  const stillReadable = await browser.request(alice, 'snapshot', { tabId: a.tabId });
  assert.ok(stillReadable.snapshot.text.includes('Research'));
  const frame = await browser.request(human, 'frame', { tabId: a.tabId });
  assert.equal(frame.frame.mimeType, 'image/jpeg');
  assert.ok(Buffer.from(frame.frame.data, 'base64').length > 100);
  const capture = await browser.request(human, 'capture', { tabId: a.tabId, frameId: frame.frame.frameId, mode: 'region', region: { x: 0, y: 0, width: 200, height: 100 }, comment: 'Pinned evidence', destinationThreadId: 'chat-a', navigationEpoch: frame.tab.navigationEpoch });
  assert.equal(capture.capture.threadId, 'chat-a');
  assert.equal(capture.capture.comment, 'Pinned evidence');
  assert.ok(capture.capture.screenshot.data);
  const returned = await browser.request(human, 'control', { tabId: a.tabId, owner: 'agent' });
  await assert.rejects(browser.request(alice, 'navigate', { tabId: a.tabId, url: `${origin}/redirect-private`, navigationEpoch: returned.tab.navigationEpoch, controllerEpoch: returned.tab.controllerEpoch }), { code: 'BROWSER_ACTION_FAILED' });
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
