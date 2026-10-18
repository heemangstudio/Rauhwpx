import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import { app, BrowserWindow, WebContentsView, session } from 'electron';
import { OwnedBrowserHost } from '../../desktop/browser-host.mjs';
import { createIpcNativeBrowserAdapter, createOwnedBrowserService } from '../../rhwp/rhwp-agent/owned-browser-service.mjs';

const require = createRequire(new URL('../../rhwp/rhwp-agent/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

app.setPath('userData', path.join(process.env.RHWP_BROWSER_TEST_DATA_DIR, 'electron'));
app.on('window-all-closed', () => {});
const report = {};
let host, proxy, service;
const windows = new Map();
app.whenReady().then(async () => {
try {
  proxy = createServer((request, response) => {
    if (request.headers['proxy-authorization'] !== `Basic ${Buffer.from('fixture:owned').toString('base64')}`) {
      response.writeHead(407, { 'proxy-authenticate': 'Basic realm="Favicon fixture"' }); response.end(); return;
    }
    if (new URL(request.url).hostname !== 'favicon-fixture.invalid') { response.writeHead(403); response.end(); return; }
    if (new URL(request.url).pathname !== '/') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><title>Favicon fixture</title><link rel="icon" href="data:image/png;base64,${PNG}"><p>Native icon</p>`);
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  windows.set('owner', new BrowserWindow({ show: false, width: 900, height: 700 }));
  host = new OwnedBrowserHost({ BrowserWindow, WebContentsView, electronSession: session,
    dataDir: path.join(process.env.RHWP_BROWSER_TEST_DATA_DIR, 'browser-data'), getWindowForSession: (id) => windows.get(id), onEvent: () => {} });
  const ipcEvents = new EventEmitter();
  const forwarded = [];
  const ipcOwner = { connected: true, send: (message, callback) => { if (message?.type === 'rhwp-browser-event') forwarded.push(message.event); ipcEvents.emit('message', message); callback?.(); } };
  const settings = { proxy: { server: `http://127.0.0.1:${proxy.address().port}`, username: 'fixture', password: 'owned' } };
  await host.start(settings, ipcOwner);
  const adapter = createIpcNativeBrowserAdapter({ events: ipcEvents, send: (message) => {
    void host.handleRequest(message, ipcOwner).then((response) => ipcEvents.emit('message', response));
  } });
  const events = [];
  service = createOwnedBrowserService({ dataDir: path.join(process.env.RHWP_BROWSER_TEST_DATA_DIR, 'service'),
    nativeAdapter: adapter, workspaceTargets: ['http://favicon-fixture.invalid/'], lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    onEvent: (event) => events.push(event),
    runtimeFactory: async () => {
      const native = await adapter.start(settings);
      const browser = await chromium.connectOverCDP(native.endpointURL);
      return { kind: 'native', nativeGeneration: native.generation, context: browser.contexts()[0], browser, close: async () => { await browser.close(); await native.close(); } };
    } });
  const actor = { isHuman: true, clientId: 'owner', sessionId: 'owner', threadId: 'favicon-chat', agentId: 'owner' };
  const opened = await service.request(actor, 'open', { url: 'http://favicon-fixture.invalid/' });
  const icon = `data:image/png;base64,${PNG}`;
  const deadline = Date.now() + 8000;
  let published;
  while (!(published = events.find((event) => event.type === 'owned_browser_tab' && event.tab.tabId === opened.tab.tabId && event.tab.faviconUrl)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(published?.tab.faviconUrl, icon, 'the Electron favicon event reaches the hub and the editor tab');
  const event = forwarded.find((entry) => entry.reason === 'favicon');
  assert.equal(event.tabId, opened.tab.tabId);
  assert.equal(event.pageUrl, 'http://favicon-fixture.invalid/');
  assert.equal((await service.inventory(actor)).tabs.find((tab) => tab.tabId === opened.tab.tabId).faviconUrl, icon);
  report.favicon = { forwarded: true, published: true, inventory: true };
} catch (error) { report.error = error.stack ?? String(error); }
finally {
  await service?.close().catch(() => {});
  await host?.dispose().catch(() => {});
  for (const window of windows.values()) if (!window.isDestroyed()) window.destroy();
  proxy?.closeAllConnections();
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
  console.log(`BROWSER_FAVICON_REPORT ${JSON.stringify(report)}`);
  app.exit(report.error ? 1 : 0);
}
});
