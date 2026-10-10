import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod/v3';
import { TOOL_DEFINITIONS } from '../tools.mjs';
import { createOwnedBrowserService } from '../owned-browser-service.mjs';
import { inspectOwnedBrowserRuntime, startOwnedBrowserRuntime } from '../owned-browser-runtime.mjs';

const actor = { threadId: 'contract-chat', agentId: 'contract-agent' };
const call = (browser, name, input) => browser.request(actor, name.slice('browser_'.length), z.object(TOOL_DEFINITIONS.find(tool => tool.name === name).shape).parse(input));
const refs = observation => ({ tabId: observation.tab.tabId, snapshotId: observation.snapshot.snapshotId, navigationEpoch: observation.tab.navigationEpoch, controllerEpoch: observation.tab.controllerEpoch, ref: observation.snapshot.elements.find(element => element.name === 'Query').ref });
async function fixture(t) {
  if (!(await inspectOwnedBrowserRuntime()).installed) { t.skip('The pinned managed browser is not installed'); return; }
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hama-browser-contracts-'));
  const sockets = new Set();
  const server = createServer((request, response) => {
    if (request.url === '/stream') { response.writeHead(200, { 'content-type': 'text/plain' }); response.write('streaming'); return; }
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><form onsubmit="event.preventDefault();submissions++;trusted=event.isTrusted"><label>Query<input name="query"></label><button>Ready search</button></form><button id="delayed" style="display:none">Delayed action</button><p id="result" hidden>Loaded result</p><script>window.submissions=0;window.trusted=false;fetch("/stream");setTimeout(()=>{document.querySelector("#delayed").style.display="block";document.querySelector("#result").hidden=false},300)</script>');
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let runtime;
  const browser = createOwnedBrowserService({ dataDir, workspaceTargets: [origin], autoInstall: false, runtimeFactory: async options => runtime = await startOwnedBrowserRuntime(options) });
  t.after(async () => { await browser.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const opened = await call(browser, 'browser_open', { url: origin });
  return { browser, tabId: opened.tab.tabId, page: runtime.context.pages().find(page => page.url().startsWith(origin)) };
}

test('public browser_type submit fills then submits once with a trusted Enter', async t => {
  const f = await fixture(t); if (!f) return;
  let observed = await call(f.browser, 'browser_snapshot', { tabId: f.tabId });
  await call(f.browser, 'browser_type', { ...refs(observed), text: 'first draft' });
  assert.equal(await f.page.evaluate(() => submissions), 0);
  observed = await call(f.browser, 'browser_snapshot', { tabId: f.tabId });
  await call(f.browser, 'browser_type', { ...refs(observed), text: 'submitted research', submit: true, intent: 'search' });
  assert.deepEqual(await f.page.evaluate(() => ({ submissions, trusted, text: document.querySelector('input').value })), { submissions: 1, trusted: true, text: 'submitted research' });
});

test('public browser_wait conditions poll visible text, bound timeouts and return fresh actionable refs', async t => {
  const f = await fixture(t); if (!f) return;
  const observed = await call(f.browser, 'browser_snapshot', { tabId: f.tabId });
  const ready = await call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'ready', timeoutMs: 2000 });
  assert.notEqual(ready.snapshot.snapshotId, observed.snapshot.snapshotId);
  const visible = await call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'visible', text: 'Delayed action', timeoutMs: 2000 });
  assert.ok(visible.snapshot.elements.some(element => element.name === 'Delayed action'));
  const text = await call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'text', text: 'Loaded result', timeoutMs: 2000 });
  assert.ok(text.snapshot.text.includes('Loaded result'));
  const start = Date.now();
  const idle = await call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'idle', timeoutMs: 2000 });
  assert.ok(Date.now() - start >= 500);
  assert.equal(idle.completed, true);
  assert.ok(idle.snapshot.snapshotId);
  await call(f.browser, 'browser_type', { ...refs({ tab: ready.tab, snapshot: idle.snapshot }), text: 'fresh wait reference' });
  await assert.rejects(call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'text' }), { code: 'BROWSER_WAIT_TEXT_REQUIRED' });
  const timed = Date.now();
  await assert.rejects(call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'text', text: 'never appears', timeoutMs: 70 }), { code: 'BROWSER_ACTION_TIMEOUT' });
  assert.ok(Date.now() - timed < 2000);
});

test('wait budget includes queued actions and late reads do not replace a newer snapshot', async t => {
  const f = await fixture(t); if (!f) return;
  const idle = call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'idle', timeoutMs: 2000 });
  const queuedStart = Date.now();
  await assert.rejects(call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'ready', timeoutMs: 40 }), { code: 'BROWSER_ACTION_TIMEOUT' });
  assert.ok(Date.now() - queuedStart < 300);
  await idle;
  const locate = f.page.locator.bind(f.page);
  let delayed = false;
  f.page.locator = (...args) => {
    const locator = locate(...args);
    if (args[0] === 'body' && !delayed) {
      delayed = true;
      const innerText = locator.innerText.bind(locator);
      locator.innerText = async (...options) => { await new Promise(resolve => setTimeout(resolve, 300)); return innerText(...options); };
    }
    return locator;
  };
  const start = Date.now();
  await assert.rejects(call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'text', text: 'Loaded result', timeoutMs: 60 }), { code: 'BROWSER_ACTION_TIMEOUT' });
  assert.ok(Date.now() - start < 300);
  const current = await call(f.browser, 'browser_wait', { tabId: f.tabId, condition: 'ready', timeoutMs: 2000 });
  await new Promise(resolve => setTimeout(resolve, 350));
  await call(f.browser, 'browser_type', { ...refs(current), text: 'current snapshot survives' });
});
