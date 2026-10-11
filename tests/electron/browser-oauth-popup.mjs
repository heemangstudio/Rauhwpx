import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, WebContentsView, session, ipcMain } from 'electron';
import { OwnedBrowserHost } from '../../desktop/browser-host.mjs';
import { BrowserAdblock } from '../../desktop/browser-adblock.mjs';
import { NativeBrowserPasswords } from '../../desktop/browser-passwords.mjs';
import { createOwnedBrowserService } from '../../rhwp/rhwp-agent/owned-browser-service.mjs';
import { key, cert } from '../../rhwp/rhwp-agent/tests/fixtures/owned-browser-tls.mjs';

const root = process.env.RHWP_BROWSER_TEST_DATA_DIR;
process.on('uncaughtException', error => { console.error(error.stack); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error.stack ?? error); app.exit(1); });
app.setPath('userData', path.join(root, 'electron'));
// Only these loopback fixture origins use a synthetic certificate.
app.commandLine.appendSwitch('ignore-certificate-errors');
app.on('window-all-closed', () => {});
let host; let service; let editor; const sites = []; const events = [];
function waitForEvent(type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(listener); reject(new Error(`Missing ${type} at ${stage}`)); }, 5000);
    const listener = event => { if (event.type === type) { clearTimeout(timer); waiters.delete(listener); resolve(event); } };
    waiters.add(listener);
  });
}
const waiters = new Set();
const report = {}; let stage;
app.whenReady().then(async () => {
try {
  let providerOrigin;
  const openerSite = createSecureServer({ key, cert }, (request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><title>OAuth opener fixture</title><input id="draft" value="retained"><script>
      window.callbacks=[];addEventListener('message',e=>{if(e.origin===${JSON.stringify(providerOrigin)})callbacks.push(e.data)});
      window.startOAuth=()=>{window.authPopup=window.open('about:blank','controlled-auth','popup,width=460,height=600');return !!authPopup};
    </script><a id="link" href="/result" target="_blank">Result</a><form action="/signed-in"><label>Password<input id="secret" type="password" autocomplete="current-password"></label></form>`);
  });
  const providerSite = createServer((request, response) => {
    if (request.url === '/authorize') { response.writeHead(302, { location: '/callback' }); response.end(); return; }
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><title>OAuth provider fixture</title><button id="finish">Finish</button><script>finish.onclick=()=>{opener.postMessage({result:"complete"},"*");window.close()}</script>');
  });
  for (const site of [openerSite, providerSite]) { sites.push(site); await new Promise(resolve => site.listen(0, '127.0.0.1', resolve)); }
  const openerOrigin = `https://127.0.0.1:${openerSite.address().port}`;
  providerOrigin = `http://127.0.0.1:${providerSite.address().port}`;
  editor = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const dataDir = path.join(root, 'browser-data'); await mkdir(dataDir, { recursive: true });
  const owner = {};
  host = new OwnedBrowserHost({ BrowserWindow, WebContentsView, electronSession: session, dataDir, getWindowForSession: id => id === 'fixture-editor' ? editor : null });
  new BrowserAdblock({ host, ipcMain });
  // Render fixture guests offscreen so Chromium has a surface without showing an OS window.
  const guestPreferences = host.guestPreferences.bind(host);
  host.guestPreferences = () => ({ ...guestPreferences(), offscreen: true });
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
  stage = 'popupEvent';
  const popupEvent = waitForEvent('owned_browser_popup');
  assert.equal(await contents.executeJavaScript('startOAuth()', true), true, 'OAuth needs the real WindowProxy returned by window.open');
  const popup = await popupEvent; const guest = host.tab(popup.tab.tabId);
  assert.equal(popup.openerTabId, opened.tab.tabId);
  assert.equal(guest.sessionId, actor.sessionId);
  assert.equal(guest.chatId, parent.chatId);
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
  stage = 'directPopup';
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
  stage = 'cancelledPopup';
  const cancelledPopup = waitForEvent('owned_browser_popup');
  assert.equal(await contents.executeJavaScript('startOAuth()', true), true);
  const cancelled = await cancelledPopup; const cancelledClosed = waitForEvent('owned_browser_closed');
  const cancelState = (await service.inventory(actor)).tabs.find(tab => tab.tabId === cancelled.tab.tabId);
  await service.request(actor, 'close', cancelState); await cancelledClosed;
  assert.equal(await contents.executeJavaScript('authPopup.closed'), true);
  assert.deepEqual(await contents.executeJavaScript('callbacks'), [{ result: 'complete' }]);
  stage = 'linkPopup';
  const linkPopup = waitForEvent('owned_browser_popup');
  await contents.executeJavaScript('document.querySelector("#link").click()', true);
  const linked = await linkPopup;
  assert.equal(linked.foreground, true);
  const linkedState = (await service.inventory(actor)).tabs.find(tab => tab.tabId === linked.tab.tabId);
  await service.request(actor, 'close', linkedState);
  stage = 'backgroundPopup';
  const backgroundPopup = waitForEvent('owned_browser_popup');
  const point = await contents.executeJavaScript('(()=>{const r=document.querySelector("#link").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  const inputScope = { targetId: parent.targetId, tabId: parent.tabId, sessionId: parent.sessionId, chatId: parent.chatId, generation: host.generation, token: 'fixture-middle-click' };
  let background;
  await host.activity({ ...inputScope, active: true });
  try {
    // Native Chromium input keeps this hidden fixture independent of OS focus.
    await host.cdp.command({ method: 'Input.dispatchMouseEvent', sessionId: parent.cdpSessionId, params: { type: 'mouseMoved', ...point, button: 'none' } });
    await host.cdp.command({ method: 'Input.dispatchMouseEvent', sessionId: parent.cdpSessionId, params: { type: 'mousePressed', ...point, button: 'middle', buttons: 4, clickCount: 1 } });
    await host.cdp.command({ method: 'Input.dispatchMouseEvent', sessionId: parent.cdpSessionId, params: { type: 'mouseReleased', ...point, button: 'middle', buttons: 0, clickCount: 1 } });
    background = await backgroundPopup;
  } finally { await host.activity({ ...inputScope, active: false }); }
  assert.equal(background.foreground, false);
  assert.equal(host.tab(background.tab.tabId).disposition, 'background-tab');
  const backgroundState = (await service.inventory(actor)).tabs.find(tab => tab.tabId === background.tab.tabId);
  await service.request(actor, 'close', backgroundState);
  stage = 'transient-helper';
  await contents.executeJavaScript('window.helper=window.open("about:blank","transient-helper","popup");helper.close()', true);
  assert.equal(await contents.executeJavaScript('new Promise((resolve,reject)=>{const end=Date.now()+2000;const check=()=>{if(helper.closed)return resolve(true);if(Date.now()>end)return reject(new Error("Helper did not close"));setTimeout(check,20)};check()})'), true);
  assert.equal(host.pendingTabs.size, 0);
  const cleanupDeadline = Date.now() + 2000;
  while ((await service.inventory(actor)).tabs.length !== 1) {
    if (Date.now() >= cleanupDeadline) throw new Error('Transient helper left a stale hub tab');
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  stage = 'password-family';
  const existingPopupEvent = waitForEvent('owned_browser_popup');
  assert.equal(await contents.executeJavaScript('!!(window.existingChild=window.open("/child","existing-password-child","popup"))', true), true);
  const existingChild = host.tab((await existingPopupEvent).tab.tabId);
  assert.equal(existingChild.passwordShield, undefined);
  assert.equal(await existingChild.view.webContents.executeJavaScript('!!opener'), true);
  const secret = 'synthetic-popup-password-3f0dc4';
  const wire = [];
  const send = host.cdp.send.bind(host.cdp);
  host.cdp.send = (message, client) => { wire.push(JSON.stringify(message)); return send(message, client); };
  const passwords = new NativeBrowserPasswords({ host, vault: { withCredential: async (_id, use) => use(
    { origin: openerOrigin, username: 'fixture-user', password: secret },
    { assertCurrent() {}, write: callback => callback() },
  ) } });
  const binding = { targetId: parent.targetId, tabId: parent.tabId, sessionId: parent.sessionId, chatId: parent.chatId };
  const observed = await passwords.snapshot(binding);
  stage = 'password-fill';
  const passwordRef = observed.elements.find(element => element.inputType === 'password').ref;
  const run = passwords.run.bind(passwords);
  let shieldBeforeFill = false;
  passwords.run = (tab, fn, args) => {
    if (args?.[0]?.action === 'fill') {
      assert.equal(existingChild.passwordShield, true);
      assert.notEqual(existingChild.protectedPasswords, parent.protectedPasswords);
      shieldBeforeFill = true;
    }
    return run(tab, fn, args);
  };
  await passwords.fill({ ...binding, snapshotId: observed.snapshotId, passwordRef, accountId: 'fixture-account' });
  assert.equal(shieldBeforeFill, true);
  assert.equal(await contents.executeJavaScript('document.getElementById("secret").value'), secret);
  const readOpener = child => host.cdp.command({ method: 'Runtime.evaluate', sessionId: child.cdpSessionId, params: { expression: 'opener.document.getElementById("secret").value' } });
  await assert.rejects(readOpener(existingChild), /protect this page/);
  const add = host.cdp.add.bind(host.cdp);
  let shieldBeforeAttach = false;
  host.cdp.add = async tab => {
    if (tab.openerTab === parent) {
      assert.equal(tab.passwordShield, true);
      assert.notEqual(tab.protectedPasswords, parent.protectedPasswords);
      assert.notEqual(tab.passwordAllowedOrigins, parent.passwordAllowedOrigins);
      assert.equal(tab.passwordSnapshot, null);
      shieldBeforeAttach = true;
    }
    return add(tab);
  };
  const inheritedPopupEvent = waitForEvent('owned_browser_popup');
  stage = 'inherited-password-popup';
  assert.equal(await contents.executeJavaScript('!!(window.inheritedChild=window.open("/child","inherited-password-child","popup"))', true), true);
  const inheritedChild = host.tab((await inheritedPopupEvent).tab.tabId);
  assert.equal(shieldBeforeAttach, true);
  assert.equal(await inheritedChild.view.webContents.executeJavaScript('opener.document.getElementById("secret").value'), secret);
  await assert.rejects(readOpener(inheritedChild), /protect this page/);
  await inheritedChild.view.webContents.executeJavaScript('console.log(opener.document.getElementById("secret").value)');
  host.closeGuest(parent);
  assert.equal(inheritedChild.protectedPasswords.has(secret), true);
  assert.equal(existingChild.protectedPasswords.has(secret), true);
  await assert.rejects(readOpener(inheritedChild), /protect this page/);
  assert.equal(JSON.stringify(wire).includes(secret), false);
  assert.equal(JSON.stringify(events).includes(secret), false);
  report.passwordFamily = { existingChildBeforeFill: true, inheritedBeforeAttach: true, openerReadDenied: true, secretWireAbsent: true, protectionSurvivesOpenerClose: true };
  report.oauth = { returnedWindow: true, redirectOpener: true, postMessage: true, selfClose: true, cancelled: true, bindingIsolated: true, namedReuse: true, directPopup: true, targetBlank: true, backgroundTab: true, transientHelper: true };
} catch (error) { report.error = `${stage}: ${error.stack ?? String(error)}`; console.error(report.error); process.exitCode = 1; }
finally {
  await service?.close().catch(() => {}); await host?.dispose().catch(() => {});
  if (editor && !editor.isDestroyed()) editor.destroy();
  for (const site of sites) { site.closeAllConnections(); await new Promise(resolve => site.close(resolve)); }
  console.log('BROWSER_OAUTH_REPORT ' + JSON.stringify(report)); app.exit(process.exitCode ?? 0);
}
});
