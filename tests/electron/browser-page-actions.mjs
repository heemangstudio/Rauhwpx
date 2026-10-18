import assert from 'node:assert/strict';
import { createServer as createSecureServer } from 'node:https';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, WebContentsView, session, ipcMain } from 'electron';
import { OwnedBrowserHost } from '../../desktop/browser-host.mjs';
import { BrowserAdblock } from '../../desktop/browser-adblock.mjs';
import { NativeBrowserPasswords } from '../../desktop/browser-passwords.mjs';
import { createOwnedBrowserService } from '../../rhwp/rhwp-agent/owned-browser-service.mjs';
import { key, cert } from '../../rhwp/rhwp-agent/tests/fixtures/owned-browser-tls.mjs';

// 웹 페이지가 만든 blob: 주소로 가는 링크·window.open 과, 보호 탭의 네이티브 클릭을 실제 Chromium 에서 확인한다.
const root = process.env.RHWP_BROWSER_TEST_DATA_DIR;
process.on('uncaughtException', error => { console.error(error.stack); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error.stack ?? error); app.exit(1); });
app.setPath('userData', path.join(root, 'electron'));
app.commandLine.appendSwitch('ignore-certificate-errors');
app.on('window-all-closed', () => {});
let host; let service; let editor; let site; const waiters = new Set();
const report = {}; let stage;
function waitForEvent(type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(listener); reject(new Error(`Missing ${type} at ${stage}`)); }, 5000);
    const listener = event => { if (event.type === type) { clearTimeout(timer); waiters.delete(listener); resolve(event); } };
    waiters.add(listener);
  });
}
async function until(read, expected, label) {
  const deadline = Date.now() + 5000; let value;
  while ((value = await read().catch(() => undefined)) !== expected) {
    if (Date.now() >= deadline) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const PAGE = `<!doctype html><title>Page action fixture</title><body style="margin:0">
<a id="blank" target="_blank">Blob in new tab</a> <a id="same">Blob here</a>
<div id="shadow-host"></div>
<input id="readonly" aria-label="Pick date" readonly value="2026-10-18" style="display:block;width:200px">
<button id="covered" style="display:block;width:400px;height:40px">Covered center</button>
<div style="position:absolute;left:150px;width:100px;height:40px;background:#fff" id="center-cover"></div>
<button id="hidden-behind" style="display:block;width:200px;height:40px">Fully covered</button>
<script>
  window.clicks = [];
  window.blobUrl = URL.createObjectURL(new Blob(['<title>Blob fixture</title><p id="blob">BLOB-OK</p>'], { type: 'text/html' }));
  for (const id of ['blank', 'same']) document.getElementById(id).href = blobUrl;
  const shadow = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
  shadow.innerHTML = '<button id="inner" style="width:200px;height:40px">Shadow action</button>';
  shadow.getElementById('inner').addEventListener('click', () => clicks.push('shadow'));
  document.getElementById('readonly').addEventListener('click', () => clicks.push('readonly'));
  document.getElementById('covered').addEventListener('click', () => clicks.push('covered'));
  document.getElementById('hidden-behind').addEventListener('click', () => clicks.push('hidden-behind'));
  // 가운데 덮개는 단추 가운데만 가린다. 완전히 가린 단추는 누르면 안 된다.
  const cover = document.getElementById('center-cover'); const covered = document.getElementById('covered').getBoundingClientRect();
  Object.assign(cover.style, { top: covered.top + 'px' });
  const full = document.createElement('div'); const behind = document.getElementById('hidden-behind').getBoundingClientRect();
  Object.assign(full.style, { position: 'absolute', left: behind.left + 'px', top: behind.top + 'px', width: behind.width + 'px', height: behind.height + 'px', background: '#fff' });
  document.body.append(full);
</script>`;

app.whenReady().then(async () => {
try {
  site = createSecureServer({ key, cert }, (_request, response) => { response.setHeader('content-type', 'text/html'); response.end(PAGE); });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${site.address().port}`;
  editor = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const dataDir = path.join(root, 'browser-data'); await mkdir(dataDir, { recursive: true });
  const owner = {};
  host = new OwnedBrowserHost({ BrowserWindow, WebContentsView, electronSession: session, dataDir, getWindowForSession: id => id === 'fixture-editor' ? editor : null });
  new BrowserAdblock({ host, ipcMain });
  const guestPreferences = host.guestPreferences.bind(host);
  host.guestPreferences = () => ({ ...guestPreferences(), offscreen: true });
  const adapter = {
    async start(settings) { return { ...await host.start(settings, owner), close: () => host.release(owner) }; },
    bind: args => host.bind(args), control: args => host.control(args),
    inventory: async () => [...host.tabs.values()].map(tab => host.state(tab)),
  };
  service = createOwnedBrowserService({ dataDir, nativeAdapter: adapter, workspaceTargets: [origin], onEvent: event => { for (const listener of waiters) listener(event); } });
  const actor = { isHuman: true, sessionId: 'fixture-editor', clientId: 'fixture-editor', threadId: 'fixture-chat', agentId: 'fixture-agent' };
  const opened = await service.request(actor, 'open', { url: origin });
  const parent = host.tab(opened.tab.tabId); const contents = parent.view.webContents;
  host.attach(editor, { tabId: opened.tab.tabId, bounds: { x: 0, y: 0, width: 800, height: 600 }, interactive: true });
  await until(() => contents.executeJavaScript('typeof blobUrl'), 'string', 'fixture page');
  const blobText = guest => guest.executeJavaScript('document.getElementById("blob")?.textContent ?? ""');
  const closeTab = async tabId => service.request(actor, 'close', (await service.inventory(actor)).tabs.find(tab => tab.tabId === tabId));

  stage = 'blob-target-blank';
  const blankPopup = waitForEvent('owned_browser_popup');
  await contents.executeJavaScript('document.getElementById("blank").click()', true);
  const blank = host.tab((await blankPopup).tab.tabId).view.webContents;
  await until(() => blobText(blank), 'BLOB-OK', 'target=_blank blob link');
  assert.match(blank.getURL(), new RegExp(`^blob:${origin}/`));
  await closeTab((await blankPopup).tab.tabId);

  stage = 'blob-window-open';
  const openedPopup = waitForEvent('owned_browser_popup');
  assert.equal(await contents.executeJavaScript('!!window.open(blobUrl, "_blank")', true), true, 'window.open(blob:) must not be refused');
  const scripted = await openedPopup;
  await until(() => blobText(host.tab(scripted.tab.tabId).view.webContents), 'BLOB-OK', 'window.open blob');
  await closeTab(scripted.tab.tabId);

  stage = 'blob-background-tab';
  // 가운데 단추 클릭은 Chromium 이 게스트를 만들지 않아 호스트가 직접 주소를 연다.
  const backgroundPopup = waitForEvent('owned_browser_popup');
  const point = await contents.executeJavaScript('(()=>{const r=document.getElementById("blank").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  const inputScope = { targetId: parent.targetId, tabId: parent.tabId, sessionId: parent.sessionId, chatId: parent.chatId, generation: host.generation, token: 'fixture-middle-click' };
  let background;
  await host.activity({ ...inputScope, active: true });
  try {
    await host.cdp.command({ method: 'Input.dispatchMouseEvent', sessionId: parent.cdpSessionId, params: { type: 'mouseMoved', ...point, button: 'none' } });
    await host.cdp.command({ method: 'Input.dispatchMouseEvent', sessionId: parent.cdpSessionId, params: { type: 'mousePressed', ...point, button: 'middle', buttons: 4, clickCount: 1 } });
    await host.cdp.command({ method: 'Input.dispatchMouseEvent', sessionId: parent.cdpSessionId, params: { type: 'mouseReleased', ...point, button: 'middle', buttons: 0, clickCount: 1 } });
    background = await backgroundPopup;
  } finally { await host.activity({ ...inputScope, active: false }); }
  assert.equal(host.tab(background.tab.tabId).disposition, 'background-tab');
  await until(() => blobText(host.tab(background.tab.tabId).view.webContents), 'BLOB-OK', 'background blob tab must load instead of staying blank');
  await closeTab(background.tab.tabId);
  report.blob = { targetBlank: true, windowOpen: true, backgroundTab: true };

  stage = 'protected-click';
  const passwords = new NativeBrowserPasswords({ host, vault: { withCredential: async () => assert.fail('no credential use') } });
  const binding = { targetId: parent.targetId, tabId: parent.tabId, sessionId: parent.sessionId, chatId: parent.chatId };
  const clickScope = { ...binding, generation: host.generation, token: 'fixture-protected-click' };
  const act = async (name, action = 'click', extra = {}) => {
    const observed = await passwords.snapshot(binding);
    const ref = observed.elements.find(element => element.name === name)?.ref;
    assert.ok(ref, `${name} must appear in the native snapshot`);
    return passwords.action({ ...binding, snapshotId: observed.snapshotId, ref, action, ...extra });
  };
  const clicks = () => contents.executeJavaScript('clicks.join(",")');
  await host.activity({ ...clickScope, active: true });
  try {
    await act('Shadow action');
    await until(clicks, 'shadow', 'button inside an open shadow root');
    await act('Pick date');
    await until(clicks, 'shadow,readonly', 'readonly input');
    await act('Covered center');
    await until(clicks, 'shadow,readonly,covered', 'button whose center is covered');
    await assert.rejects(act('Fully covered'), { code: 'BROWSER_PASSWORD_TARGET_INVALID' });
    await assert.rejects(act('Pick date', 'type', { text: 'x' }), { code: 'BROWSER_PASSWORD_TARGET_INVALID' });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(await clicks(), 'shadow,readonly,covered');
    assert.equal(await contents.executeJavaScript('document.getElementById("readonly").value'), '2026-10-18');
  } finally { await host.activity({ ...clickScope, active: false }); }
  report.protectedClick = { shadowRoot: true, readonly: true, coveredCenter: true, fullyCoveredRefused: true, readonlyTypeRefused: true };

  stage = 'blob-same-tab';
  await contents.executeJavaScript('document.getElementById("same").click()', true);
  await until(() => blobText(contents), 'BLOB-OK', 'same-tab blob link');
  report.blob.sameTab = true;
} catch (error) { report.error = `${stage}: ${error.stack ?? String(error)}`; console.error(report.error); process.exitCode = 1; }
finally {
  await service?.close().catch(() => {}); await host?.dispose().catch(() => {});
  if (editor && !editor.isDestroyed()) editor.destroy();
  if (site) { site.closeAllConnections(); await new Promise(resolve => site.close(resolve)); }
  console.log('BROWSER_PAGE_ACTIONS_REPORT ' + JSON.stringify(report)); app.exit(process.exitCode ?? 0);
}
});
