import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { app, BrowserWindow, WebContentsView, session } from 'electron';
import { OwnedBrowserHost } from '../../desktop/browser-host.mjs';
import { NativeBrowserPasswords } from '../../desktop/browser-passwords.mjs';
import { LocalBrowserPasswordVault } from '../../desktop/browser-local-password-vault.mjs';
import { createOwnedBrowserService, createIpcNativeBrowserAdapter } from '../../rhwp/rhwp-agent/owned-browser-service.mjs';
import { createBrowserPolicy } from '../../rhwp/rhwp-agent/browser-policy.mjs';
import { startOwnedBrowserRuntime } from '../../rhwp/rhwp-agent/owned-browser-runtime.mjs';
import { key, cert } from '../../rhwp/rhwp-agent/tests/fixtures/owned-browser-tls.mjs';

// 사용자 비밀을 데스크톱 브라우저의 격리된 세계에서 입력한다. 실제 계정·키체인·앱 창은 쓰지 않는다.
const root = mkdtempSync(join(tmpdir(), 'hama-native-secret-test-'));
app.setPath('userData', join(root, 'electron'));
app.commandLine.appendSwitch('ignore-certificate-errors');
app.on('window-all-closed', () => {});
const value = `sk-native-${randomUUID()}`;
const keyBytes = randomBytes(32);
const safeStorage = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (input) => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', keyBytes, iv); const body = Buffer.concat([cipher.update(input), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); },
  decryptStringAsync: async (input) => { const cipher = createDecipheriv('aes-256-gcm', keyBytes, input.subarray(0, 12)); cipher.setAuthTag(input.subarray(12, 28)); return { result: Buffer.concat([cipher.update(input.subarray(28)), cipher.final()]).toString() }; },
};
let server; let host; let service; let editor;
const sockets = new Set();
const report = {};
const timer = setTimeout(() => { console.error('NATIVE_SECRET_TIMEOUT', report.stage); process.exit(1); }, 45_000);
const outlineRef = (snapshot, name) => snapshot.outline.split('\n').find((line) => line.includes(`"${name}"`))?.match(/\[ref=([^\]]+)\]/)?.[1];

async function main() {
  try {
    let posted = null;
    server = createServer({ key, cert }, (request, response) => {
      response.setHeader('content-type', 'text/html');
      // 사이트가 저장한 키를 다른 페이지에 그대로 다시 보여 주는 경우.
      if (request.url === '/stored') { response.end(`<title>Stored</title><p>Your key: ${value}</p>`); return; }
      if (request.method === 'POST') {
        let body = ''; request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => { posted = new URLSearchParams(body).get('key'); response.end('<title>Saved</title><h1>Saved</h1>'); });
        return;
      }
      response.end(`<title>Keys</title><form action="/save" method="post"><label>API key <input id="key" name="key" type="password"></label><button id="save">Save</button></form>
        <form action="https://other.invalid/collect" method="post"><label>Leaky key <input id="leak" name="leak"></label></form><p id="echo"></p>
        <script>document.getElementById('key').addEventListener('input', (event) => { document.getElementById('echo').textContent = 'mirror ' + event.target.value; });</script>`);
    });
    server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `https://127.0.0.1:${server.address().port}`;
    const dataDir = join(root, 'browser-data');
    editor = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const owner = { connected: true };
    host = new OwnedBrowserHost({ BrowserWindow, WebContentsView, electronSession: session, dataDir, getWindowForSession: (id) => id === 'editor' ? editor : null });
    new NativeBrowserPasswords({ host, vault: new LocalBrowserPasswordVault({ dataDir: join(dataDir, 'password-vault'), safeStorage }) });
    const wire = [];
    const messages = new EventEmitter();
    const adapter = createIpcNativeBrowserAdapter({ events: messages, send: (message) => { wire.push(message); void host.handleRequest(message, owner).then((response) => { wire.push(response); messages.emit('message', response); }); } });
    const policy = createBrowserPolicy({ dataDir });
    service = createOwnedBrowserService({ dataDir, policy, nativeAdapter: adapter, workspaceTargets: [origin], autoInstall: false, runtimeFactory: startOwnedBrowserRuntime });
    const actor = { threadId: 'chat-one', agentId: 'chat-one:root', sessionId: 'editor', projectId: 'project-one' };
    // 사용자가 이 채팅에 사이트 사용을 승인했다. 비밀 입력과 제출이 그 승인을 따른다.
    await policy.grantSiteAccess({ actor: { isHuman: true, clientId: 'editor' }, threadId: actor.threadId, origin, scope: 'chat' });
    report.stage = 'opening';
    const opened = await service.request(actor, 'open', { url: origin });
    const tabId = opened.tab.tabId;
    const tab = host.tab(tabId);
    host.attach(editor, { tabId, mode: 'dock', bounds: { x: 0, y: 0, width: 800, height: 600 }, interactive: true });
    let reads = 0;
    const secret = (origins) => ({ origins, resolve: async () => { reads++; return value; } });
    const target = async (name) => {
      const observed = await service.request(actor, 'snapshot', { tabId });
      const ref = outlineRef(observed.snapshot, name);
      assert.ok(ref, observed.snapshot.outline);
      return { tabId, snapshotId: observed.snapshot.snapshotId, ref, navigationEpoch: observed.tab.navigationEpoch, controllerEpoch: observed.tab.controllerEpoch };
    };
    report.stage = 'refusals';
    await assert.rejects(service.fillSecret(actor, await target('API key'), secret(['https://other.invalid'])), { code: 'BROWSER_SECRET_ORIGIN_MISMATCH' });
    await assert.rejects(service.fillSecret(actor, await target('Leaky key'), secret([origin])), { code: 'BROWSER_SECRET_FORM_ORIGIN' });
    assert.equal(reads, 0, 'a refused target never reads the secret');
    assert.notEqual(tab.passwordShield, true);
    report.refusedBeforeRead = true;

    report.stage = 'fill';
    const filled = await service.fillSecret(actor, await target('API key'), secret([origin]));
    assert.equal(filled.ok, true);
    assert.equal(await tab.view.webContents.executeJavaScript('document.getElementById("key").value'), value);
    assert.equal(tab.passwordShield, true, 'the filled tab is shielded like a password page');
    report.nativeSecretFill = true;
    const after = await service.request(actor, 'snapshot', { tabId });
    assert.match(after.snapshot.outline, /mirror \[masked\]/);
    await assert.rejects(service.request(actor, 'frame', { tabId }), { code: 'BROWSER_PASSWORD_CAPTURE_PROTECTED' });
    assert.equal(JSON.stringify({ filled, after }).includes(value), false);
    report.observationsMasked = true;
    // 값은 허브가 데스크톱에 보내는 입력 요청 하나에만 실린다. 응답·다른 요청에는 없다.
    const carriers = wire.filter((message) => JSON.stringify(message).includes(value));
    assert.deepEqual(carriers.map((message) => [message.type, message.operation, message.params?.mode]), [['rhwp-browser-request', 'password-fill', 'secret']]);
    report.onlyFillRequestCarriesValue = true;

    report.stage = 'other-tab';
    const stored = await service.request(actor, 'open', { url: `${origin}/stored` });
    const storedView = await service.request(actor, 'snapshot', { tabId: stored.tab.tabId, text: true });
    const storedCapture = await service.request(actor, 'capture', { tabId: stored.tab.tabId, mode: 'page' });
    assert.equal(storedCapture.capture.screenshotError?.code, 'BROWSER_PASSWORD_CAPTURE_PROTECTED');
    assert.equal(JSON.stringify({ stored, storedView, storedCapture }).includes(value), false);
    report.otherTabMasked = true;

    report.stage = 'submit';
    await service.fillSecret(actor, { ...await target('API key'), submit: true }, secret([origin]));
    const deadline = Date.now() + 5000;
    while (posted === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(posted, value);
    report.nativeSubmit = true;
  } catch (error) { report.error = error.stack; process.exitCode = 1; }
  finally {
    clearTimeout(timer);
    await service?.close().catch(() => {}); await host?.dispose().catch(() => {});
    if (editor && !editor.isDestroyed()) editor.destroy();
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    console.log(`NATIVE_SECRET_REPORT ${JSON.stringify(report)}`);
    app.exit(process.exitCode || 0);
  }
}
void app.whenReady().then(main);
