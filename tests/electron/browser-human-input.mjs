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
const report = {}; let stage; let host; let service; let editor; const sites = [];
const until = async (check, message, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 20)); }
};
// before-mouse-event 를 거치는 실제 사용자 클릭. 에이전트 입력(CDP)과 달리 데스크톱 입력 필터를 지난다.
const humanClick = async (contents, x, y) => {
  contents.sendInputEvent({ type: 'mouseMove', x, y });
  contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await new Promise(resolve => setTimeout(resolve, 60));
  contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
};
const center = (contents, selector) => contents.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);

app.whenReady().then(async () => {
  try {
    const posts = [];
    let providerOrigin;
    const handle = name => (request, response) => {
      if (request.method === 'POST') { posts.push(`${name}${request.url}`); response.writeHead(303, { location: '/done' }); response.end(); return; }
      response.setHeader('content-type', 'text/html');
      if (request.url === '/done') { response.end('<!doctype html><title>Signed in</title><h1>Signed in</h1>'); return; }
      if (name === 'site') {
        response.end(`<!doctype html><title>Site login</title><style>body{margin:0}</style>
          <form method="post" action="/login"><button id="login" style="position:absolute;left:0;top:0;width:200px;height:80px">Log in</button></form>
          <iframe id="provider" src="${providerOrigin}/button" style="position:absolute;left:0;top:120px;width:240px;height:80px;border:0"></iframe>`);
      } else if (request.url === '/button') {
        // Google Identity Services 버튼처럼 교차 출처 iframe 이 이름 붙은 창을 연다.
        response.end(`<!doctype html><style>body{margin:0}</style><button id="continue" style="width:240px;height:80px" onclick="window.open('/auth','provider-auth','popup,width=400,height=500')">Continue with Provider</button>`);
      } else {
        response.end('<!doctype html><title>Provider sign-in</title><style>body{margin:0}</style><form method="post" action="/auth/submit"><button id="submit" style="position:absolute;left:0;top:0;width:200px;height:80px">Next</button></form>');
      }
    };
    const site = createServer(handle('site')); const provider = createServer(handle('provider'));
    for (const server of [site, provider]) { sites.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); }
    const siteOrigin = `http://127.0.0.1:${site.address().port}`;
    providerOrigin = `http://127.0.0.1:${provider.address().port}`;
    editor = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const dataDir = path.join(root, 'browser-data'); await mkdir(dataDir, { recursive: true });
    const listeners = new Set();
    // 허브 자식 프로세스 대신 같은 프로세스에서 데스크톱 이벤트를 전달한다.
    const owner = { connected: true, send(message, callback) { if (message.type === 'rhwp-browser-event') for (const listener of listeners) listener(message.event); callback?.(); } };
    host = new OwnedBrowserHost({ BrowserWindow, WebContentsView, electronSession: session, dataDir, getWindowForSession: id => id === 'fixture-editor' ? editor : null });
    const guestPreferences = host.guestPreferences.bind(host);
    host.guestPreferences = () => ({ ...guestPreferences(), offscreen: true });
    const adapter = {
      async start(settings) { return { ...await host.start(settings, owner), close: () => host.release(owner) }; },
      bind: args => host.bind(args), control: args => host.control(args), activity: args => host.activity(args),
      inventory: async () => [...host.tabs.values()].map(tab => host.state(tab)),
      onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    };
    const events = [];
    // 정책을 주지 않으면 에이전트의 웹사이트 변경(POST)은 소유자 승인이 필요하다.
    service = createOwnedBrowserService({ dataDir, nativeAdapter: adapter, workspaceTargets: [siteOrigin, providerOrigin], onEvent: event => events.push(event) });
    const agent = { threadId: 'fixture-chat', agentId: 'fixture-agent', sessionId: 'fixture-editor' };
    const human = { isHuman: true, sessionId: 'fixture-editor', clientId: 'fixture-editor' };
    const show = tabId => host.attach(editor, { tabId, bounds: { x: 0, y: 0, width: 600, height: 400 }, interactive: true });

    stage = 'agent-tab';
    const opened = (await service.request(agent, 'open', { url: `${siteOrigin}/` })).tab;
    assert.equal(opened.scope, 'agent');
    const parent = host.tab(opened.tabId); const contents = parent.view.webContents;
    show(opened.tabId);

    stage = 'human-login';
    const login = await center(contents, '#login');
    await humanClick(contents, login.x, login.y);
    await until(() => posts.includes('site/login'), 'The user login submit never reached the website');
    await until(() => contents.getURL() === `${siteOrigin}/done`, 'The login submit did not finish');
    report.humanLogin = true;

    stage = 'human-popup';
    await contents.loadURL(`${siteOrigin}/`);
    await until(() => contents.executeJavaScript('document.querySelector("#provider")?.contentWindow && document.readyState === "complete"'), 'The provider frame did not load');
    const frame = await center(contents, '#provider');
    const popupCount = events.filter(event => event.type === 'owned_browser_popup').length;
    await humanClick(contents, frame.x, frame.y);
    const popupEvent = await until(() => events.filter(event => event.type === 'owned_browser_popup')[popupCount], 'The provider popup was not registered');
    assert.equal(popupEvent.openerTabId, opened.tabId);
    const popup = host.tab(popupEvent.tab.tabId); const popupContents = popup.view.webContents;
    await until(() => popupContents.getURL() === `${providerOrigin}/auth` && !popupContents.isLoading(), 'The provider popup did not load');
    show(popupEvent.tab.tabId);
    const next = await center(popupContents, '#submit');
    await humanClick(popupContents, next.x, next.y);
    await until(() => posts.includes('provider/auth/submit'), 'The user submit inside the provider popup never reached the website');
    report.humanPopup = true;

    stage = 'agent-policy';
    // 사용자가 넘겨준 뒤 에이전트가 다시 조작하면 에이전트 정책으로 돌아간다.
    await popupContents.executeJavaScript('window.close()', true).catch(() => {});
    await contents.loadURL(`${siteOrigin}/`);
    const before = posts.length;
    const fresh = (await service.inventory(agent)).tabs.find(tab => tab.tabId === opened.tabId);
    const observed = await service.request(agent, 'snapshot', { tabId: opened.tabId });
    const ref = observed.snapshot.outline.split('\n').find(line => line.includes('"Log in"')).match(/\[ref=([^\]]+)\]/)[1];
    await service.request(agent, 'click', { tabId: opened.tabId, navigationEpoch: observed.tab.navigationEpoch, controllerEpoch: fresh.controllerEpoch, snapshotId: observed.snapshot.snapshotId, ref }).catch(failure => failure);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(posts.length, before, 'Agent website changes still need owner approval');
    report.agentPolicy = true;

    stage = 'orphan-popup';
    // 허브의 CDP 연결이 끊긴 동안 열린 팝업은 재연결 때 원래 탭의 팝업으로 입양된다.
    host.cdp.client.terminate();
    await until(async () => (await service.inventory(human)).runtime.state === 'disconnected', 'The hub did not notice the dropped connection');
    assert.equal(await contents.executeJavaScript(`!!window.open(${JSON.stringify(`${providerOrigin}/auth`)},'provider-auth','popup')`, true), true);
    const orphan = await until(() => [...host.tabs.values()].find(tab => tab.openerTab === parent && !tab.tabId), 'The popup guest was not created');
    await service.request(human, 'reconnect', { tabId: opened.tabId });
    await until(() => orphan.tabId, 'The popup opened while disconnected stayed without a logical tab');
    const adopted = (await service.inventory(human)).tabs.find(tab => tab.tabId === orphan.tabId);
    assert.equal(adopted.openerTabId, opened.tabId);
    report.orphanAdopted = true;
  } catch (error) { report.error = `${stage}: ${error.stack ?? String(error)}`; console.error(report.error); process.exitCode = 1; }
  finally {
    await service?.close().catch(() => {}); await host?.dispose().catch(() => {});
    if (editor && !editor.isDestroyed()) editor.destroy();
    for (const server of sites) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    console.log('BROWSER_HUMAN_INPUT_REPORT ' + JSON.stringify(report)); app.exit(process.exitCode ?? 0);
  }
});
