import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createOwnedBrowserService } from '../owned-browser-service.mjs';
import { inspectOwnedBrowserRuntime, startOwnedBrowserRuntime } from '../owned-browser-runtime.mjs';

const human = { isHuman: true, clientId: 'editor', sessionId: 'editor', threadId: 'chat', agentId: 'owner' };
async function fixture(t, native = false) {
  if (!(await inspectOwnedBrowserRuntime()).installed) { t.skip('Managed Chromium is required.'); return; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-viewport-'));
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Viewport fixture</title><input type="password" value="secret"><div style="height:9000px;background:linear-gradient(green,red)">Long page</div><button onclick="window.clicked=true">Bottom</button>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  const state = { shield: false, epoch: 1, zoom: 1, page: null }; const events = [];
  const adapter = native ? { bind: async () => ({ generation: 'fixture', zoomFactor: 1 }), control: async () => {}, activity: async () => {},
    passwordSnapshot: async () => ({ passwordProtected: state.shield, nativeNavigationEpoch: 1, nativeControlEpoch: state.epoch, zoomFactor: state.zoom }) } : undefined;
  const browser = createOwnedBrowserService({ dataDir: directory, workspaceTargets: [origin], nativeAdapter: adapter, autoInstall: false, onEvent: event => events.push(event),
    runtimeFactory: async options => { const runtime = await startOwnedBrowserRuntime({ ...options, nativeAdapter: undefined }); runtime.context.on('page', page => { state.page = page; }); return runtime; } });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const opened = await browser.request(human, 'open', { url: origin }); return { browser, tab: opened.tab, state, events };
}
test('a tall page captures only its current viewport and remains usable without retained full-page state', async t => {
  const f = await fixture(t); if (!f) return;
  const scroll = await f.state.page.evaluate(() => { scrollTo(0, 8700); return scrollY; });
  const { capture } = await f.browser.request(human, 'capture', { tabId: f.tab.tabId, mode: 'page' });
  const pixels = await f.state.page.evaluate(async data => { const response = await fetch(`data:image/jpeg;base64,${data}`); const image = await createImageBitmap(await response.blob()); return { width: image.width, height: image.height }; }, capture.screenshot.data);
  assert.equal(capture.viewport.scrollY, scroll); assert.equal(pixels.height, capture.viewport.height); assert.ok(pixels.height < 1000);
  assert.equal(f.events.find(event => event.type === 'owned_browser_capture').capture.screenshot, undefined, 'events retain metadata without duplicating image bytes');
  await f.state.page.locator('button').click(); assert.equal(await f.state.page.evaluate(() => window.clicked), true);
});
test('viewport images fail closed when native password protection activates before or during capture', async t => {
  const f = await fixture(t, true); if (!f) return;
  const screenshot = f.state.page.screenshot.bind(f.state.page); let shots = 0;
  f.state.page.screenshot = async (...args) => { shots++; const image = await screenshot(...args); f.state.shield = true; return image; };
  f.state.shield = true;
  let result = await f.browser.request(human, 'capture', { tabId: f.tab.tabId, mode: 'page' });
  assert.equal(shots, 0); assert.equal(result.capture.screenshot, undefined);
  f.state.shield = false;
  result = await f.browser.request(human, 'capture', { tabId: f.tab.tabId, mode: 'page' });
  assert.equal(shots, 1); assert.equal(result.capture.screenshot, undefined);
  assert.ok(f.events.filter(event => event.type === 'owned_browser_capture').every(event => !event.capture.screenshot));
});
