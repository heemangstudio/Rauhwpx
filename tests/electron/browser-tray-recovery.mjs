import assert from 'node:assert/strict';
import { app, BrowserWindow, WebContentsView, session, nativeImage } from 'electron';
import { createServer } from 'node:http';
import path from 'node:path';
import { OwnedBrowserHost } from '../../desktop/browser-host.mjs';
import { createOwnedBrowserService } from '../../rhwp/rhwp-agent/owned-browser-service.mjs';

const root = process.env.RHWP_BROWSER_TEST_DATA_DIR;
app.setPath('userData', path.join(root, 'electron'));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
let host, service, window, site;
const report = {};
try {
  let requests = 0;
  site = createServer((request, response) => { if (request.url === '/') requests++; response.end('<!doctype html><style>body{background:#235678}</style><label>Draft<input id="draft"></label>'); });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${site.address().port}`;
  window = new BrowserWindow({ show: false, width: 800, height: 600 });
  await window.loadURL('data:text/html,<body>Tray recovery fixture</body>'); window.showInactive();
  const owner = {};
  host = new OwnedBrowserHost({ BrowserWindow, WebContentsView, electronSession: session, dataDir: root, getWindowForSession: () => window });
  service = createOwnedBrowserService({ dataDir: root, workspaceTargets: [origin], nativeAdapter: {
    async start(settings) { return { ...await host.start(settings, owner), close: () => host.release(owner) }; },
    bind: args => host.bind(args), control: args => host.control(args), activity: args => host.activity(args),
    inventory: async () => [...host.tabs.values()].map(tab => host.state(tab)),
  } });
  const actor = { threadId: 'tray', agentId: 'owner', sessionId: 'window' };
  const human = { ...actor, isHuman: true, clientId: 'window' };
  const opened = (await service.request(actor, 'open', { url: origin })).tab;
  async function ready(placement) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const state = await host.presentationState(window, placement);
      if (state.presentationHealth !== 'loading') return state;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Native document did not finish loading');
  }
  let tab = host.tab(opened.tabId);
  await tab.view.webContents.executeJavaScript('document.querySelector("#draft").value="kept draft"');
  const placement = { tabId: opened.tabId, expectedTargetId: tab.targetId, bounds: { x: 0, y: 0, width: 500, height: 350 }, interactive: true };
  const initialRequests = requests;
  await tab.view.webContents.executeJavaScript('document.body.style.background="white"; document.querySelector("label").style.marginLeft="73px"');
  for (let index = 0; index < 2; index++) {
    host.attach(window, placement);
    const health = await host.presentationState(window, placement);
    assert.equal(health.presentationHealth, 'ready');
    assert.equal(await tab.view.webContents.executeJavaScript('document.querySelector("#draft").value'), 'kept draft');
    host.detach(window, { tabId: opened.tabId });
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const healthyReconnected = await service.request(human, 'reconnect', { tabId: opened.tabId, restore: true });
  assert.equal(healthyReconnected.tab.nativeTargetId, tab.targetId);
  assert.equal(requests, initialRequests, 'healthy hide/reopen and reconnect never reload the document');
  host.attach(window, placement);
  const capture = tab.view.webContents.capturePage.bind(tab.view.webContents);
  tab.view.webContents.capturePage = async () => nativeImage.createEmpty();
  assert.equal((await host.presentationState(window, placement)).presentationHealth, 'paint-timeout');
  tab.view.webContents.capturePage = async () => nativeImage.createFromBitmap(Buffer.alloc(20 * 20 * 4, 255), { width: 20, height: 20 });
  assert.equal((await host.presentationState(window, placement)).presentationHealth, 'paint-timeout', 'white pixels cannot hide visible form content');
  let captures = 0;
  tab.passwordShield = true;
  tab.passwordAllowedOrigins = new Set([origin]);
  tab.view.webContents.capturePage = async () => { captures++; throw new Error('protected pixels'); };
  const protectedHealth = await host.presentationState(window, placement);
  assert.equal(protectedHealth.presentationHealth, 'ready'); assert.equal(captures, 0);
  assert.equal('image' in protectedHealth, false);
  tab.passwordShield = false;
  captures = 0;
  tab.view.webContents.capturePage = async () => { captures++; tab.passwordShield = true; return nativeImage.createEmpty(); };
  assert.equal((await host.presentationState(window, placement)).presentationHealth, 'ready');
  assert.equal(captures, 1, 'shield activation prevents a second capture');
  tab.passwordShield = false;
  tab.view.webContents.capturePage = async () => {
    const moved = new Promise(resolve => tab.view.webContents.once('did-navigate-in-page', resolve));
    await tab.view.webContents.executeJavaScript('history.replaceState(null, "", "#new-navigation")');
    await moved; return nativeImage.createEmpty();
  };
  assert.equal((await host.presentationState(window, placement)).presentationHealth, 'unavailable');
  tab.view.webContents.capturePage = capture;
  const crashed = new Promise(resolve => tab.view.webContents.once('render-process-gone', resolve));
  tab.view.webContents.forcefullyCrashRenderer();
  await Promise.race([crashed, new Promise((_, reject) => setTimeout(() => reject(new Error('crash event timed out')), 3000))]);
  assert.equal((await host.presentationState(window, placement)).presentationHealth, 'failed');
  assert.deepEqual(host.navigation(window, { ...placement, navigationEpoch: tab.navigationEpoch, recovery: true }, 'reload'), { restoreRequired: true });
  const crashRestored = await service.request(human, 'reconnect', { tabId: opened.tabId, restore: true });
  assert.equal(crashRestored.tab.tabId, opened.tabId);
  tab = host.tab(opened.tabId); placement.expectedTargetId = tab.targetId;
  host.attach(window, placement);
  assert.equal((await ready(placement)).presentationHealth, 'ready');
  assert.equal(requests, initialRequests + 1);
  assert.throws(() => host.navigation(window, { ...placement, navigationEpoch: tab.navigationEpoch - 1, recovery: true }, 'reload'), /stale/);
  const oldTarget = tab.targetId;
  host.closeGuest(tab);
  const restored = await service.request(human, 'reconnect', { tabId: opened.tabId, restore: true });
  assert.equal(restored.tab.tabId, opened.tabId); assert.notEqual(restored.tab.nativeTargetId, oldTarget);
  tab = host.tab(opened.tabId);
  assert.throws(() => host.attach(window, { ...placement, expectedTargetId: oldTarget }), /stale/);
  host.attach(window, { ...placement, expectedTargetId: tab.targetId });
  assert.equal((await ready({ ...placement, expectedTargetId: tab.targetId })).presentationHealth, 'ready');
  host.popout(window, tab);
  const popout = host.popouts.get(tab.targetId);
  popout.close();
  assert.equal(popout.isDestroyed(), false); assert.equal(popout.isVisible(), false);
  host.setQuitRequested(true); host.setQuitRequested(false); popout.close();
  assert.equal(popout.isDestroyed(), false); assert.equal(tab.view.webContents.isDestroyed(), false);
  report.quit = { normalCloseRetainsGuest: true, canceledQuitRetainsGuest: true };
  report.healthy = { retainedDraft: true, noReload: true, painted: true };
  report.recovery = { crash: true, missingGuest: true, staleNavigation: true, staleTarget: true, paintFailure: true, protectedCaptureBlocked: true };
} catch (error) { report.error = error.stack ?? String(error); console.error(report.error); }
finally {
  if (!report.error) {
    app.on('before-quit', () => host.setQuitRequested(true));
    app.once('will-quit', () => {
      report.quit.hiddenPopoutClosed = host.popouts.size === 0;
      console.log(`BROWSER_TRAY_REPORT ${JSON.stringify(report)}`);
    });
    app.quit();
  } else {
    await Promise.race([host?.dispose().catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000))]);
    console.log(`BROWSER_TRAY_REPORT ${JSON.stringify(report)}`); app.exit(1);
  }
}
});
