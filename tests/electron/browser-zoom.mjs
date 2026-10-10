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

app.setPath('userData', path.join(process.env.RHWP_BROWSER_TEST_DATA_DIR, 'electron'));
app.on('window-all-closed', () => {});
const report = {};
let host, proxy, service;
const windows = new Map();
app.whenReady().then(async () => {
try {
  proxy = createServer((request, response) => {
    if (request.headers['proxy-authorization'] !== `Basic ${Buffer.from('fixture:owned').toString('base64')}`) {
      response.writeHead(407, { 'proxy-authenticate': 'Basic realm="Zoom fixture"' }); response.end(); return;
    }
    if (new URL(request.url).hostname !== 'zoom-fixture.invalid') { response.writeHead(403); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Zoom fixture</title><input id="draft"><div style="width:200px">Native page zoom</div>');
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  for (const id of ['owner', 'foreign']) windows.set(id, new BrowserWindow({ show: false, width: 900, height: 700 }));
  const events = [];
  host = new OwnedBrowserHost({ BrowserWindow, WebContentsView, electronSession: session,
    dataDir: path.join(process.env.RHWP_BROWSER_TEST_DATA_DIR, 'browser-data'),
    getWindowForSession: (id) => windows.get(id), onEvent: (event) => events.push(event) });
  const ipcEvents = new EventEmitter();
  const ipcOwner = { connected: true, send: (message, callback) => { ipcEvents.emit('message', message); callback?.(); } };
  const settings = { proxy: { server: `http://127.0.0.1:${proxy.address().port}`, username: 'fixture', password: 'owned' } };
  await host.start(settings, ipcOwner);
  const tab = await host.createTab();
  const contents = tab.view.webContents;
  await contents.loadURL('http://zoom-fixture.invalid/');
  host.bind({ targetId: tab.targetId, tabId: 'zoom-tab', sessionId: 'owner' });
  const owner = windows.get('owner');
  owner.showInactive();
  const bounds = { x: 0, y: 40, width: 600, height: 400 };
  host.attach(owner, { tabId: tab.tabId, bounds, mode: 'float', interactive: true });
  await host.viewport(tab, bounds);
  await contents.executeJavaScript('document.querySelector("#draft").value="kept draft"; window.pageMarker=42');
  const metrics = () => contents.executeJavaScript('({width:innerWidth,dpr:devicePixelRatio, draft:document.querySelector("#draft").value, marker:window.pageMarker})');
  const baseline = await metrics();
  const epoch = tab.navigationEpoch;
  const zoomed = host.zoom(owner, { tabId: tab.tabId, factor: 1.5 });
  assert.ok(Math.abs(zoomed.zoomFactor - 1.5) < 0.001);
  assert.equal(zoomed.controller, 'agent');
  const after = await contents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline=Date.now()+3000;
    const check=()=>{if(Math.abs(devicePixelRatio-${baseline.dpr * 1.5})<0.01){resolve({width:innerWidth,dpr:devicePixelRatio,draft:document.querySelector('#draft').value,marker:window.pageMarker});return;}
      if(Date.now()>deadline){reject(new Error('Native DOM zoom did not change devicePixelRatio: '+devicePixelRatio+' width:'+innerWidth));return;} setTimeout(check,20);}; check();
  })`);
  assert.equal(after.draft, 'kept draft');
  assert.ok(after.width < baseline.width, 'Page zoom must reduce the available CSS layout width');
  assert.equal(after.marker, 42);
  assert.equal(tab.navigationEpoch, epoch);
  assert.ok(events.some((event) => event.type === 'zoom' && Math.abs(event.zoomFactor - 1.5) < 0.001));
  host.detach(owner, { tabId: tab.tabId });
  host.attach(owner, { tabId: tab.tabId, bounds, mode: 'dock' });
  assert.ok(Math.abs(host.state(tab).zoomFactor - 1.5) < 0.001);
  assert.equal((await metrics()).draft, 'kept draft');
  assert.throws(() => host.zoom(windows.get('foreign'), { tabId: tab.tabId, factor: 1 }), /another editor window/);
  for (const factor of [NaN, Infinity, -Infinity, '1.5', null, undefined]) assert.throws(() => host.zoom(owner, { tabId: tab.tabId, factor }), /invalid/);
  assert.ok(Math.abs(host.zoom(owner, { tabId: tab.tabId, factor: 0 }).zoomFactor - 0.25) < 0.001);
  assert.ok(Math.abs(host.zoom(owner, { tabId: tab.tabId, factor: 99 }).zoomFactor - 3) < 0.001);
  host.zoom(owner, { tabId: tab.tabId, factor: 1.25 });
  await new Promise((resolve) => { contents.once('did-finish-load', resolve); contents.reload(); });
  assert.ok(Math.abs(host.state(tab).zoomFactor - 1.25) < 0.001, 'Reload must retain native website zoom');
  report.zoom = { percent: Math.round(zoomed.zoomFactor * 100), baseline, after, formPreserved: true, placementPreserved: true, foreignWindowRejected: true, invalidRejected: true, clamped: true, reloadPreserved: true };
  const adapter = createIpcNativeBrowserAdapter({ events: ipcEvents, send: (message) => {
    void host.handleRequest(message, ipcOwner).then((response) => ipcEvents.emit('message', response));
  } });
  const invalidated = [];
  let servicePage;
  service = createOwnedBrowserService({ dataDir: path.join(process.env.RHWP_BROWSER_TEST_DATA_DIR, 'service'),
    nativeAdapter: adapter, workspaceTargets: ['http://zoom-fixture.invalid/'], lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    credentialBroker: { invalidateTab: (tabId) => invalidated.push(tabId) },
    runtimeFactory: async () => {
      const native = await adapter.start(settings);
      const browser = await chromium.connectOverCDP(native.endpointURL);
      const context = browser.contexts()[0];
      const newPage = context.newPage.bind(context);
      context.newPage = async () => { servicePage = await newPage(); return servicePage; };
      return { kind: 'native', context, browser, close: async () => { await browser.close(); await native.close(); } };
    } });
  const actor = { isHuman: true, clientId: 'owner', sessionId: 'owner', threadId: 'zoom-chat', agentId: 'owner' };
  const opened = await service.request(actor, 'open', { url: 'http://zoom-fixture.invalid/' });
  const serviceTab = host.tab(opened.tab.tabId);
  host.attach(owner, { tabId: serviceTab.tabId, bounds, mode: 'float', interactive: true });
  const observation = await service.request(actor, 'snapshot', { tabId: serviceTab.tabId });
  const captured = await service.request(actor, 'frame', { tabId: serviceTab.tabId });
  for (const stale of [{ generation: 'obsolete' }, { targetId: 'foreign-target' }]) {
    ipcEvents.emit('message', { type: 'rhwp-browser-event', event: { tabId: serviceTab.tabId, targetId: serviceTab.targetId, generation: host.generation, reason: 'zoom', zoomFactor: 2, ...stale } });
    assert.equal((await service.inventory(actor)).tabs.find((entry) => entry.tabId === serviceTab.tabId).snapshotId, observation.snapshot.snapshotId);
  }
  const beforeInvalidation = invalidated.length;
  host.zoom(owner, { tabId: serviceTab.tabId, factor: 1.5 });
  const refreshed = (await service.inventory(actor)).tabs.find((entry) => entry.tabId === serviceTab.tabId);
  assert.equal(refreshed.snapshotId, null);
  assert.equal(refreshed.navigationEpoch, observation.snapshot.navigationEpoch);
  assert.ok(Math.abs(refreshed.zoomFactor - 1.5) < 0.001);
  assert.ok(invalidated.length > beforeInvalidation);
  await assert.rejects(service.request(actor, 'capture', { tabId: serviceTab.tabId, frameId: captured.frame.frameId }), { code: 'BROWSER_STALE_FRAME' });
  await assert.rejects(service.request(actor, 'capture', { tabId: serviceTab.tabId, mode: 'element', snapshotId: observation.snapshot.snapshotId, ref: observation.snapshot.elements[0].ref }), { code: 'BROWSER_STALE_REFERENCE' });
  const originalScreenshot = servicePage.screenshot.bind(servicePage);
  let beginCapture, finishCapture;
  const captureStarted = new Promise((resolve) => { beginCapture = resolve; });
  const captureGate = new Promise((resolve) => { finishCapture = resolve; });
  servicePage.screenshot = async (options) => { beginCapture(); await captureGate; return originalScreenshot(options); };
  const pendingFrame = service.request(actor, 'frame', { tabId: serviceTab.tabId });
  const staleGeometry = assert.rejects(pendingFrame, { code: 'BROWSER_STALE_GEOMETRY' });
  await captureStarted;
  host.zoom(owner, { tabId: serviceTab.tabId, factor: 1.75 });
  finishCapture();
  await staleGeometry;
  servicePage.screenshot = originalScreenshot;
  await service.close(); service = null;
  assert.equal(ipcEvents.listenerCount('message'), 0);
  report.geometry = { snapshotsInvalidated: true, framesInvalidated: true, credentialRefsInvalidated: true, staleEventsRejected: true, navigationPreserved: true, listenerDisposed: true };
} catch (error) { report.error = error.stack ?? String(error); }
finally {
  await service?.close().catch(() => {});
  await host?.dispose().catch(() => {});
  for (const window of windows.values()) if (!window.isDestroyed()) window.destroy();
  proxy?.closeAllConnections();
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
  console.log(`BROWSER_ZOOM_REPORT ${JSON.stringify(report)}`);
  app.exit(report.error ? 1 : 0);
}
});
