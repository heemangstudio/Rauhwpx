import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, WebContentsView, session } from 'electron';
import { OwnedBrowserHost } from '../../desktop/browser-host.mjs';
import { createOwnedBrowserService } from '../../rhwp/rhwp-agent/owned-browser-service.mjs';

const root = process.env.RHWP_BROWSER_TEST_DATA_DIR;
process.on('uncaughtException', error => { console.error(error.stack); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error.stack ?? error); app.exit(1); });
app.setPath('userData', path.join(root, 'electron'));
app.on('window-all-closed', () => {});
let host; let service; let editor; const sites = []; const events = [];
function waitForEvent(type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(listener); reject(new Error(`Missing ${type}`)); }, 5000);
    const listener = event => { if (event.type === type) { clearTimeout(timer); waiters.delete(listener); resolve(event); } };
    waiters.add(listener);
  });
}
const waiters = new Set();
const report = {};
app.whenReady().then(async () => {
try {
  let providerOrigin;
  const openerSite = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><title>OAuth opener fixture</title><input id="draft" value="retained"><script>
      window.callbacks=[];addEventListener('message',e=>{if(e.origin===${JSON.stringify(providerOrigin)})callbacks.push(e.data)});
      window.startOAuth=()=>{window.authPopup=window.open('about:blank','controlled-auth','popup,width=460,height=600');return !!authPopup};
    </script><a id="link" href="/result" target="_blank">Result</a>`);
  });
  const providerSite = createServer((request, response) => {
    if (request.url === '/authorize') { response.writeHead(302, { location: '/callback' }); response.end(); return; }
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>OAuth provider fixture</title><button id="finish">Finish</button><script>finish.onclick=()=>{opener.postMessage({result:"complete"},"*");window.close()}</script>');
  });
  for (const site of [openerSite, providerSite]) { sites.push(site); await new Promise(resolve => site.listen(0, '127.0.0.1', resolve)); }
  const openerOrigin = `http://127.0.0.1:${openerSite.address().port}`;
  providerOrigin = `http://127.0.0.1:${providerSite.address().port}`;
  editor = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const dataDir = path.join(root, 'browser-data'); await mkdir(dataDir, { recursive: true });
  const owner = {};
  host = new OwnedBrowserHost({ BrowserWindow, WebContentsView, electronSession: session, dataDir, getWindowForSession: id => id === 'fixture-editor' ? editor : null });
  const adapter = {
    async start(settings) { return { ...await host.start(settings, owner), close: () => host.release(owner) }; },
    bind: args => host.bind(args), control: args => host.control(args),
    inventory: async () => [...host.tabs.values()].map(tab => host.state(tab)),
  };
  service = createOwnedBrowserService({ dataDir, nativeAdapter: adapter, workspaceTargets: [openerOrigin, providerOrigin], onEvent: event => { events.push(event); for (const listener of waiters) listener(event); } });
  const actor = { isHuman: true, sessionId: 'fixture-editor', clientId: 'fixture-editor', threadId: 'fixture-chat', agentId: 'fixture-agent' };
  const opened = await service.request(actor, 'open', { url: openerOrigin });
  const parent = host.tab(opened.tab.tabId); const contents = parent.view.webContents;
  host.attach(editor, { tabId: opened.tab.tabId, bounds: { x: 0, y: 0, width: 700, height: 500 }, interactive: true });
  const popupEvent = waitForEvent('owned_browser_popup');
  assert.equal(await contents.executeJavaScript('startOAuth()', true), true, 'OAuth needs the real WindowProxy returned by window.open');
  const popup = await popupEvent; const guest = host.tab(popup.tab.tabId);
  assert.equal(popup.openerTabId, opened.tab.tabId);
  assert.equal(guest.sessionId, actor.sessionId);
  assert.equal(guest.chatId, actor.threadId);
  assert.equal(guest.view.webContents.session, contents.session);
  const preferences = guest.view.webContents.getLastWebPreferences();
  assert.equal(preferences.sandbox, true); assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.contextIsolation, true);
  assert.equal(await contents.executeJavaScript('authPopup.opener === window'), true);
  const tabCount = host.tabs.size;
  assert.equal(await contents.executeJavaScript('(()=>{const previous=authPopup;startOAuth();return previous===authPopup})()', true), true);
  assert.equal(host.tabs.size, tabCount); assert.equal(host.pendingTabs.size, 0);
  assert.throws(() => host.bind({ targetId: guest.targetId, tabId: 'wrong-chat', sessionId: actor.sessionId, chatId: 'different-chat' }), /another chat/);
  await contents.executeJavaScript(`authPopup.location = ${JSON.stringify(providerOrigin + '/authorize')}`);
  await guest.view.webContents.executeJavaScript('document.readyState');
  assert.equal(guest.view.webContents.getURL(), providerOrigin + '/callback');
  assert.deepEqual(await guest.view.webContents.executeJavaScript('({opener:!!opener,node:typeof require,desktop:typeof window.rhwpDesktop})'), { opener: true, node: 'undefined', desktop: 'undefined' });
  await assert.rejects(service.request({ ...actor, isHuman: false, threadId: 'different-chat' }, 'snapshot', { tabId: popup.tab.tabId }), { code: 'BROWSER_TAB_NOT_FOUND' });
  const closed = waitForEvent('owned_browser_closed');
  await guest.view.webContents.executeJavaScript('finish.click()', true).catch(() => {});
  const closeEvent = await closed;
  assert.equal(closeEvent.tabId, popup.tab.tabId); assert.equal(closeEvent.openerTabId, opened.tab.tabId);
  assert.deepEqual(await contents.executeJavaScript('callbacks'), [{ result: 'complete' }]);
  const directPopup = waitForEvent('owned_browser_popup');
  assert.equal(await contents.executeJavaScript(`!!window.open(${JSON.stringify(providerOrigin + '/authorize')},'direct-auth','popup')`, true), true);
  const direct = await directPopup; const directGuest = host.tab(direct.tab.tabId).view.webContents;
  await directGuest.executeJavaScript('document.readyState');
  assert.equal(await directGuest.executeJavaScript('!!opener'), true);
  const directClosed = waitForEvent('owned_browser_closed');
  await directGuest.executeJavaScript('window.close()', true).catch(() => {}); await directClosed;
  assert.equal(await contents.executeJavaScript('authPopup.closed'), true);
  assert.equal(await contents.executeJavaScript('document.querySelector("#draft").value'), 'retained');
  assert.equal(host.tabs.has(guest.targetId), false);
  assert.equal((await service.inventory(actor)).tabs.some(tab => tab.tabId === popup.tab.tabId), false);
  const cancelledPopup = waitForEvent('owned_browser_popup');
  assert.equal(await contents.executeJavaScript('startOAuth()', true), true);
  const cancelled = await cancelledPopup; const cancelledClosed = waitForEvent('owned_browser_closed');
  const cancelState = (await service.inventory(actor)).tabs.find(tab => tab.tabId === cancelled.tab.tabId);
  await service.request(actor, 'close', cancelState); await cancelledClosed;
  assert.equal(await contents.executeJavaScript('authPopup.closed'), true);
  assert.deepEqual(await contents.executeJavaScript('callbacks'), [{ result: 'complete' }]);
  const linkPopup = waitForEvent('owned_browser_popup');
  await contents.executeJavaScript('document.querySelector("#link").click()', true);
  const linked = await linkPopup;
  assert.equal(linked.foreground, true);
  const linkedState = (await service.inventory(actor)).tabs.find(tab => tab.tabId === linked.tab.tabId);
  await service.request(actor, 'close', linkedState);
  const backgroundPopup = waitForEvent('owned_browser_popup');
  const point = await contents.executeJavaScript('(()=>{const r=document.querySelector("#link").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'middle', clickCount: 1 });
  contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'middle', clickCount: 1 });
  const background = await backgroundPopup; assert.equal(background.foreground, false);
  assert.equal(host.tab(background.tab.tabId).disposition, 'background-tab');
  const backgroundState = (await service.inventory(actor)).tabs.find(tab => tab.tabId === background.tab.tabId);
  await service.request(actor, 'close', backgroundState);
  await contents.executeJavaScript('window.helper=window.open("about:blank","transient-helper","popup");helper.close()', true);
  assert.equal(await contents.executeJavaScript('new Promise((resolve,reject)=>{const end=Date.now()+2000;const check=()=>{if(helper.closed)return resolve(true);if(Date.now()>end)return reject(new Error("Helper did not close"));setTimeout(check,20)};check()})'), true);
  assert.equal(host.pendingTabs.size, 0);
  report.oauth = { returnedWindow: true, redirectOpener: true, postMessage: true, selfClose: true, cancelled: true, bindingIsolated: true, namedReuse: true, directPopup: true, targetBlank: true, backgroundTab: true, transientHelper: true };
} catch (error) { report.error = error.stack ?? String(error); console.error(report.error); process.exitCode = 1; }
finally {
  await service?.close().catch(() => {}); await host?.dispose().catch(() => {});
  if (editor && !editor.isDestroyed()) editor.destroy();
  for (const site of sites) { site.closeAllConnections(); await new Promise(resolve => site.close(resolve)); }
  console.log('BROWSER_OAUTH_REPORT ' + JSON.stringify(report)); app.exit(process.exitCode ?? 0);
}
});
