import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { app, BrowserWindow, WebContentsView, session } from 'electron';
import { OwnedBrowserHost } from '../../desktop/browser-host.mjs';

app.setPath('userData', path.join(process.env.RHWP_BROWSER_TEST_DATA_DIR, 'electron'));
app.on('window-all-closed', () => {});
const report = {};
let host, proxy;
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
  await host.start({ proxy: { server: `http://127.0.0.1:${proxy.address().port}`, username: 'fixture', password: 'owned' } }, {});
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
} catch (error) { report.error = error.stack ?? String(error); }
finally {
  await host?.dispose().catch(() => {});
  for (const window of windows.values()) if (!window.isDestroyed()) window.destroy();
  proxy?.closeAllConnections();
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
  console.log(`BROWSER_ZOOM_REPORT ${JSON.stringify(report)}`);
  app.exit(report.error ? 1 : 0);
}
});
