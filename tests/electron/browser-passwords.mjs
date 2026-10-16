import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { app, BrowserWindow, WebContentsView, session, ipcMain } from 'electron';
import { OwnedBrowserHost } from '../../desktop/browser-host.mjs';
import { BrowserAdblock } from '../../desktop/browser-adblock.mjs';
import { NativeBrowserPasswords } from '../../desktop/browser-passwords.mjs';
import { LocalBrowserPasswordVault } from '../../desktop/browser-local-password-vault.mjs';
import { createOwnedBrowserService, createIpcNativeBrowserAdapter, OwnedBrowserError } from '../../rhwp/rhwp-agent/owned-browser-service.mjs';
import { startOwnedBrowserRuntime } from '../../rhwp/rhwp-agent/owned-browser-runtime.mjs';
import { key, cert } from '../../rhwp/rhwp-agent/tests/fixtures/owned-browser-tls.mjs';
const { WebSocketServer } = createRequire(new URL('../../rhwp/rhwp-agent/package.json', import.meta.url))('ws');

// No real Chrome profiles, keychain records, accounts or application windows are used.
const root = mkdtempSync(join(tmpdir(), 'hama-native-password-test-'));
app.setPath('userData', join(root, 'electron'));
app.commandLine.appendSwitch('ignore-certificate-errors');
app.on('window-all-closed', () => {});
const secret = `fixture password ! ${randomUUID()}`;
const keyBytes = randomBytes(32);
const safeStorage = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (value) => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', keyBytes, iv); const body = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]); },
  decryptStringAsync: async (value) => { const cipher = createDecipheriv('aes-256-gcm', keyBytes, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return { result: Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString() }; },
};
let server; let webSockets; let host; let service; let editor;
let autocompleteListener; let saveListener;
const sockets = new Set();
const report = {};
const timer = setTimeout(() => { console.error('NATIVE_PASSWORD_TIMEOUT', report.stage); process.exit(1); }, 45_000);
async function main() {
try {
  report.stage = 'ready';
  let submitted = false; let receivedWebSocket = false;
  server = createServer({ key, cert }, (request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.method === 'POST') {
      let body = ''; request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => { const form = new URLSearchParams(body); submitted = form.get('identity') === 'fixture-user' && form.get('secret') === secret; response.end(`<title>Signed in</title><h1>Account research fixture</h1><input id="research"><button id="next">Continue research</button><script>window.socket=new WebSocket(location.origin.replace('https:','wss:')+'/channel');socket.onopen=()=>socket.send(${JSON.stringify(secret)});socket.onmessage=()=>{window.socketReady=true;};</script>`); });
    } else response.end('<title>Sign in fixture</title><form action="/signed-in" method="post"><label>Username <input id="identity" name="identity" autocomplete="username"></label><label>Password <input id="secret" name="secret" type="password" autocomplete="current-password"></label><button id="submit" type="submit">Sign in</button></form>');
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  webSockets = new WebSocketServer({ server, path: '/channel' });
  webSockets.on('connection', (socket) => socket.on('message', (message) => { receivedWebSocket = message.toString() === secret; socket.send(secret); }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${server.address().port}`;
  const dataDir = join(root, 'browser-data');
  editor = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const owner = { connected: true };
  host = new OwnedBrowserHost({ BrowserWindow, WebContentsView, electronSession: session, dataDir, getWindowForSession: (id) => id === 'editor' ? editor : null });
  new BrowserAdblock({ host, ipcMain });
  const vault = new LocalBrowserPasswordVault({ dataDir: join(dataDir, 'password-vault'), safeStorage });
  let autocompleteChoices; let autocompleteShown;
  const Menu = { buildFromTemplate: (choices) => ({ popup: () => { autocompleteChoices = choices; autocompleteShown?.(); } }) };
  const passwords = new NativeBrowserPasswords({ host, vault, Menu });
  autocompleteListener = (event, payload) => { void passwords.autocomplete(event, payload); };
  ipcMain.on('desktop:browser-guest-autocomplete', autocompleteListener);
  saveListener = (event, payload) => { void passwords.saveLogin(event, payload); };
  ipcMain.on('desktop:browser-guest-save-login', saveListener);
  const account = await vault.importCredential({ origin, username: 'fixture-user', password: secret, sourceProfile: 'Synthetic Chrome import' });
  const wire = [];
  const messages = new EventEmitter();
  const adapter = createIpcNativeBrowserAdapter({ events: messages, send: (message) => { wire.push(JSON.stringify(message)); void host.handleRequest(message, owner).then((response) => { wire.push(JSON.stringify(response)); messages.emit('message', response); }); } });
  const originalSend = host.cdp.send.bind(host.cdp);
  host.cdp.send = (message, client) => { wire.push(JSON.stringify(message)); return originalSend(message, client); };
  const publicOrigin = 'https://native-public.example'; const publicRequests = [];
  // Keep the service network guard and policy in front of a fixture-backed public response.
  const publicPage = `<form id="lookup" action="/search"><input name="q" aria-label="Query"><button>Search</button></form><script>
    window.submissions=0;document.querySelector('form').addEventListener('submit',()=>submissions++);
    document.querySelector('input').addEventListener('input',event=>{
      if(location.pathname==='/email')document.body.insertAdjacentHTML('beforeend','<input form="lookup" type="email" name="private" value="fake@review.test">');
      if(location.pathname==='/post')event.target.form.method='post';
      if(location.pathname==='/action')event.target.form.action='/checkout';
    });</script>`;
  const publicRolePage = `<table><thead><tr><th role="columnheader button" tabindex="0" aria-sort="none">Location</th></tr></thead><tbody><tr><td>Zimbabwe</td></tr><tr><td>Afghanistan</td></tr><tr><td>Brazil</td></tr></tbody></table>
    <div role="unsupported button" tabindex="0" onclick="window.unknownClicks++">Unknown fallback button</div>
    <div role="command button" tabindex="0" onclick="window.abstractClicks++">Abstract fallback button</div>
    <div role="button link" tabindex="0" onclick="window.primaryClicks++">Primary button</div>
    <div role="unsupported link" tabindex="0">Fallback link</div><div role="navigation">Navigation text</div>
    <script>window.unknownClicks=window.abstractClicks=window.primaryClicks=0;document.querySelector('th').addEventListener('click',event=>{
      const body=document.querySelector('tbody');[...body.rows].sort((a,b)=>a.textContent.localeCompare(b.textContent)).forEach(row=>body.append(row));
      event.currentTarget.setAttribute('aria-sort','ascending');window.sortedTrusted=event.isTrusted;fetch('/collect',{method:'POST',body:'blocked'}).catch(()=>{});
    });</script>`;
  service = createOwnedBrowserService({ dataDir, policy: { assertAllowed: async ({action,url}) => {
    if(action==='website-change'&&new URL(url).origin===publicOrigin)throw new OwnedBrowserError('BROWSER_PERMISSION_REQUIRED','Website changes require approval.');
  } }, lookup: async () => [{ address: '93.184.216.34', family: 4 }], nativeAdapter: adapter, workspaceTargets: [origin], autoInstall: false, runtimeFactory: async options => {
    const runtime = await startOwnedBrowserRuntime(options); const route = runtime.context.route.bind(runtime.context);
    runtime.context.route = (pattern, handler) => route(pattern, original => handler(new Proxy(original, { get(target,key) {
      if(key!=='continue'){const value=target[key];return typeof value==='function'?value.bind(target):value;}
      return async()=>{const request=target.request();if(new URL(request.url()).origin!==publicOrigin)return target.continue();
        publicRequests.push({method:request.method(),url:request.url()});await target.fulfill({status:200,contentType:'text/html',body:new URL(request.url()).pathname==='/roles'?publicRolePage:publicPage});};
    } })));
    return runtime;
  } });
  report.stage = 'opening';
  const actor = { threadId: 'chat-one', agentId: 'agent-one', sessionId: 'editor', projectId: 'project-one' };
  const opened = await service.request(actor, 'open', { url: origin });
  report.stage = 'opened';
  const tabId = opened.tab.tabId;
  const tab = host.tab(tabId);
  host.attach(editor, { tabId, mode: 'dock', bounds: { x: 0, y: 0, width: 800, height: 600 }, interactive: true });
  // Native page-level keys preserve focus and also work without any input controls.
  await tab.view.webContents.executeJavaScript(`document.body.innerHTML='<input id="first"><input id="second" value="abcd">';document.querySelector('#second').focus();document.querySelector('#second').setSelectionRange(1,1);window.lastTrusted=false;document.addEventListener('keydown',event=>window.lastTrusted=event.isTrusted);void 0;`);
  let contract = await service.request(actor, 'snapshot', { tabId });
  const pageArgs = () => ({ tabId, navigationEpoch: contract.tab.navigationEpoch, controllerEpoch: contract.tab.controllerEpoch, snapshot: false });
  await service.request(actor, 'press', { ...pageArgs(), key: 'Escape' });
  assert.deepEqual(await tab.view.webContents.executeJavaScript('({id:document.activeElement.id,position:document.activeElement.selectionStart,trusted:window.lastTrusted})'), { id: 'second', position: 1, trusted: true });
  await assert.rejects(service.request(actor, 'press', { ...pageArgs(), key: 'Control+l' }), { code: 'BROWSER_SHORTCUT_BLOCKED' });
  await tab.view.webContents.executeJavaScript('document.body.innerHTML="<p>Keyboard page</p>"');
  contract = await service.request(actor, 'snapshot', { tabId });
  await service.request(actor, 'press', { ...pageArgs(), key: 'ArrowDown' });
  report.nativePageKeys = true;
  // A control transfer retires the agent's refs; only a fresh native snapshot can act again.
  await tab.view.webContents.executeJavaScript(`document.body.innerHTML='<input aria-label="Transfer probe">'`);
  contract = await service.request(actor, 'snapshot', { tabId });
  const staleProbe = contract.snapshot.elements.find(element => element.name === 'Transfer probe');
  const transferred = await service.request({ isHuman: true, clientId: 'editor', sessionId: 'editor' }, 'control', { tabId, owner: 'human' });
  assert.equal(transferred.tab.controllerEpoch, contract.tab.controllerEpoch + 1);
  await assert.rejects(service.request(actor, 'type', { tabId, snapshotId: contract.snapshot.snapshotId, ref: staleProbe.ref, text: 'stale', navigationEpoch: transferred.tab.navigationEpoch, controllerEpoch: transferred.tab.controllerEpoch }), { code: 'BROWSER_STALE_REFERENCE' });
  contract = await service.request(actor, 'snapshot', { tabId });
  await service.request(actor, 'type', { tabId, snapshotId: contract.snapshot.snapshotId, ref: contract.snapshot.elements.find(element => element.name === 'Transfer probe').ref, text: 'fresh', navigationEpoch: contract.tab.navigationEpoch, controllerEpoch: contract.tab.controllerEpoch });
  assert.equal(await tab.view.webContents.executeJavaScript('document.querySelector("input").value'), 'fresh');
  // Native facts follow current input state and keep protected URL values out of observations.
  await tab.view.webContents.executeJavaScript(`document.body.innerHTML='<label>Checked option<input id="facts-checkbox" type="checkbox" checked></label><label>First choice<input id="facts-radio-one" name="choice" type="radio" checked></label><label>Second choice<input id="facts-radio-two" name="choice" type="radio"></label><input type="search" aria-label="Search facts"><input type="number" aria-label="Count facts"><input type="search" role="unsupported checkbox" aria-label="Explicit role"><div role="button" aria-checked="true">ARIA toggle</div><a href="https://user:pass@example.test/doc?q=public">Safe link</a><a href="javascript:alert(1)">Unsafe link</a><input type="password" value="native fact secret"><a href="https://example.test/doc?token=native%20fact%20secret">Sensitive link</a><a href="https://example.test/doc?token=native+fact+secret">Form encoded link</a><button style="position:absolute;top:3000px;left:0">Outside viewport</button>';void 0;`);
  let facts = await service.request(actor, 'snapshot', { tabId });
  const fact = name => facts.snapshot.elements.find(element => element.name === name || element.text === name);
  assert.deepEqual(['Checked option','First choice','Second choice','Search facts','Count facts','Explicit role'].map(name=>fact(name).role), ['checkbox','radio','radio','searchbox','spinbutton','checkbox']);
  assert.deepEqual(['Checked option','First choice','Second choice','ARIA toggle'].map(name=>fact(name).checked), [true,true,false,true]);
  assert.equal(fact('Checked option').inViewport, true);
  assert.equal(fact('Outside viewport').inViewport, false);
  assert.equal(fact('Safe link').href, 'https://example.test/doc?q=public');
  assert.equal(fact('Unsafe link').href, undefined);
  for (const name of ['Sensitive link','Form encoded link']) assert.match(fact(name).href, /\[masked\]/);
  assert.equal(/native(?: fact |%20fact%20|\+fact\+)secret/.test(JSON.stringify(facts)), false);
  await tab.view.webContents.executeJavaScript('document.querySelector("#facts-checkbox").checked=false;document.querySelector("#facts-radio-two").checked=true;void 0');
  facts = await service.request(actor, 'snapshot', { tabId });
  assert.deepEqual(['Checked option','First choice','Second choice'].map(name=>fact(name).checked), [false,false,true]);
  report.nativeSnapshotFacts = true;
  // The protected native observation includes form-associated identity siblings without exposing values.
  await tab.view.webContents.executeJavaScript(`document.body.innerHTML='<form id="lookup" action="/search"><input name="q" aria-label="Query"><button>Search</button><button formmethod="post">Post</button><button formaction="/checkout">Checkout</button></form><input form="lookup" type="email" name="private" value="fake@review.test">';void 0;`);
  contract = await service.request(actor, 'snapshot', { tabId });
  let query = contract.snapshot.elements.find(element => element.name === 'Query');
  assert.equal(query.formSensitive, true);
  assert.equal(JSON.stringify(contract).includes('fake@review.test'), false);
  const nativeBinding = { targetId: tab.targetId, tabId, sessionId: tab.sessionId, chatId: tab.chatId };
  // A control transfer clears the native snapshot; the stale action asks for a new snapshot instead of blaming zoom.
  host.control({ targetId: tab.targetId, human: tab.human });
  await assert.rejects(passwords.action({ ...nativeBinding, snapshotId: contract.snapshot.snapshotId, action: 'scroll', deltaX: 0, deltaY: 10 }), { code: 'BROWSER_PASSWORD_STALE_REFERENCE', message: 'Take a new browser snapshot.' });
  contract = await service.request(actor, 'snapshot', { tabId });
  query = contract.snapshot.elements.find(element => element.name === 'Query');
  const submission = () => passwords.action({ ...nativeBinding, snapshotId: contract.snapshot.snapshotId, ref: query.ref, action: 'submission', submissionAction: 'type', typed: 'research', textTypes: ['text', 'search', 'url', 'number'] });
  assert.deepEqual((await submission()).submission, { sensitive: true });
  await tab.view.webContents.executeJavaScript('document.querySelector("input[type=email]").remove()');
  contract = await service.request(actor, 'snapshot', { tabId }); query = contract.snapshot.elements.find(element => element.name === 'Query');
  assert.deepEqual((await submission()).submission, { method: 'get', url: `${origin}/search?q=research`, sensitive: false });
  for (const [name, method, destination] of [['Post', 'post', '/search'], ['Checkout', 'get', '/checkout']]) {
    const button = contract.snapshot.elements.find(element => element.name === name);
    const result = await passwords.action({ ...nativeBinding, snapshotId: contract.snapshot.snapshotId, ref: button.ref, action: 'submission', submissionAction: 'click', typed: null, textTypes: [] });
    assert.equal(result.submission.method, method); assert.ok(result.submission.url.startsWith(`${origin}${destination}`));
  }
  report.nativeFormFacts = true;
  // A covered native target must fail before Electron dispatches trusted pointer events.
  await tab.view.webContents.executeJavaScript(`document.body.innerHTML='<a href="#" onclick="window.coveredClicked=true;return false">Covered link</a><input type="password" value="unsaved-cover-secret"><div style="position:fixed;inset:0" aria-label="Cookie banner unsaved-cover-secret"></div>';window.coveredClicked=false;void 0;`);
  contract = await service.request(actor, 'snapshot', { tabId });
  const covered = contract.snapshot.elements.find(element => element.name === 'Covered link');
  await assert.rejects(service.request(actor, 'click', { ...pageArgs(), snapshotId: contract.snapshot.snapshotId, ref: covered.ref }), failure => failure.code === 'BROWSER_TARGET_COVERED' && failure.retryable === true && !!failure.hint && /Cookie banner/.test(failure.message) && !failure.message.includes('unsaved-cover-secret'));
  assert.equal(await tab.view.webContents.executeJavaScript('window.coveredClicked'), false);
  report.nativeCoveredTarget = true;
  // Input handlers can change a previously public GET form before type(submit:true) sends Enter.
  for (const path of ['/email', '/post', '/action']) {
    const publicTab = await service.request(actor, 'open', { url: publicOrigin + path });
    const query = publicTab.snapshot.elements.find(element => element.name === 'Query');
    await assert.rejects(service.request(actor, 'type', { tabId: publicTab.tab.tabId, snapshotId: publicTab.snapshot.snapshotId, ref: query.ref, navigationEpoch: publicTab.tab.navigationEpoch, controllerEpoch: publicTab.tab.controllerEpoch, text: 'written once', submit: true, intent: 'search' }), failure => failure.code === 'BROWSER_PERMISSION_REQUIRED' && failure.actionCompleted === true && failure.retryable === false && /Do not repeat/.test(failure.hint));
    assert.deepEqual(await host.tab(publicTab.tab.tabId).view.webContents.executeJavaScript('({value:document.querySelector("input").value,submissions})'), { value: 'written once', submissions: 0 });
    await service.request(actor, 'close', { tabId: publicTab.tab.tabId, navigationEpoch: publicTab.tab.navigationEpoch, controllerEpoch: publicTab.tab.controllerEpoch });
  }
  assert.equal(publicRequests.some(request => request.method !== 'GET' || /search|checkout|private=/.test(request.url)), false);
  report.nativeSubmitRevalidation = true;
  await service.request(actor, 'navigate', { ...pageArgs(), url: origin });
  await tab.view.webContents.executeJavaScript(`document.getElementById('secret').value='native-mirrored-secret';document.body.insertAdjacentHTML('beforeend','<div>echo:native-mirrored-secret</div>');Element.prototype.matches=()=>false;void 0;`);
  const hostile = await service.request(actor, 'snapshot', { tabId });
  assert.equal(JSON.stringify(hostile).includes('native-mirrored-secret'), false);
  await assert.rejects(service.request(actor, 'frame', { tabId }), { code: 'BROWSER_PASSWORD_CAPTURE_PROTECTED' });
  assert.equal(wire.some(message => message.includes('native-mirrored-secret')), false);
  await service.request(actor, 'navigate', { tabId, navigationEpoch: hostile.tab.navigationEpoch, controllerEpoch: hostile.tab.controllerEpoch, url: origin });
  report.hostileObservation = true;
  // Saving a login arms protection even before a password exists on a public page.
  tab.passwordShield = true;
  await tab.view.webContents.executeJavaScript('document.getElementById("secret").style.setProperty("visibility", "visible", "important")');
  const unmaskedCapture = await service.request(actor, 'capture', { tabId, mode: 'page' });
  assert.equal(unmaskedCapture.capture.screenshot, undefined);
  assert.equal(unmaskedCapture.capture.screenshotError.code, 'BROWSER_CAPTURE_MASK_FAILED');
  await tab.view.webContents.executeJavaScript('document.getElementById("secret").style.removeProperty("visibility")');
  await tab.view.webContents.executeJavaScript('document.getElementById("secret").value="unsaved-fixture-password"');
  const typedCapture = await service.request(actor, 'capture', { tabId, mode: 'page' });
  assert.equal(typedCapture.capture.screenshot, undefined);
  assert.equal(typedCapture.capture.screenshotError.code, 'BROWSER_PASSWORD_CAPTURE_PROTECTED');
  await tab.view.webContents.executeJavaScript('document.getElementById("secret").value=""');
  const armedCapture = await service.request(actor, 'capture', { tabId, mode: 'page' });
  assert.ok(armedCapture.capture.screenshot?.data, 'Arming password save must not break safe viewport capture');
  assert.ok(armedCapture.capture.viewport.width > 0);
  assert.equal(tab.passwordShield, true);
  assert.equal(await tab.view.webContents.executeJavaScript('getComputedStyle(document.getElementById("secret")).visibility'), 'visible', 'Capture must restore form visibility');
  report.armedCapture = true;
  const beforeCapture = await service.request(actor, 'snapshot', { tabId });
  await service.request(actor, 'capture', { tabId, mode: 'page' });
  const publicUsername = beforeCapture.snapshot.elements.find(el => el.autocomplete === 'username');
  await service.request(actor, 'type', { tabId, snapshotId: beforeCapture.snapshot.snapshotId, navigationEpoch: beforeCapture.tab.navigationEpoch, controllerEpoch: beforeCapture.tab.controllerEpoch, ref: publicUsername.ref, text: 'still usable' });
  const originalCapture = tab.view.webContents.capturePage.bind(tab.view.webContents);
  tab.view.webContents.capturePage = async (...args) => { const image = await originalCapture(...args); tab.protectedPasswords = new Set([secret]); return image; };
  try {
    const racedCapture = await service.request(actor, 'capture', { tabId, mode: 'page' });
    assert.equal(racedCapture.capture.screenshot, undefined);
    assert.equal(racedCapture.capture.screenshotError.code, 'BROWSER_PASSWORD_CAPTURE_PROTECTED');
    assert.equal(tab.passwordCapturePending, false);
  } finally { tab.view.webContents.capturePage = originalCapture; tab.protectedPasswords.clear(); }
  tab.passwordShield = false;
  const observed = await service.request(actor, 'snapshot', { tabId });
  report.stage = 'observed';
  let username = observed.snapshot.elements.find((element) => element.autocomplete === 'username');
  let password = observed.snapshot.elements.find((element) => element.inputType === 'password');
  const submit = observed.snapshot.elements.find((element) => element.tag === 'button');
  assert.ok(username && password && submit);
  const args = { tabId, snapshotId: observed.snapshot.snapshotId, navigationEpoch: observed.tab.navigationEpoch, controllerEpoch: observed.tab.controllerEpoch };
  const typedIdentifier = await service.request(actor, 'type', { ...args, ref: username.ref, text: 'public-identifier' });
  Object.assign(args, { snapshotId: typedIdentifier.snapshot.snapshotId, navigationEpoch: typedIdentifier.tab.navigationEpoch, controllerEpoch: typedIdentifier.tab.controllerEpoch });
  username = typedIdentifier.snapshot.elements.find(element => element.autocomplete === 'username');
  password = typedIdentifier.snapshot.elements.find(element => element.inputType === 'password');
  assert.equal(await tab.view.webContents.executeJavaScript('document.getElementById("identity").value'), 'public-identifier');
  await assert.rejects(service.request({ ...actor, threadId: 'chat-two' }, 'fill-account', { ...args, accountId: account.id, usernameRef: username.ref, passwordRef: password.ref }), /belongs|assigned|own|scope/i);
  const other = await vault.importCredential({ origin: 'https://other.invalid', username: 'other', password: 'other-fixture-secret' });
  await assert.rejects(service.request(actor, 'fill-account', { ...args, accountId: other.id, passwordRef: password.ref }), /different website/);
  await tab.view.webContents.executeJavaScript(`document.querySelector('form').action='https://other.invalid/'`);
  await assert.rejects(service.request(actor, 'fill-account', { ...args, accountId: account.id, passwordRef: password.ref }), /same-origin/);
  assert.equal(tab.passwordShield, false);
  await tab.view.webContents.executeJavaScript(`document.querySelector('form').action='/signed-in'`);
  await service.request(actor, 'fill-account', { ...args, accountId: account.id, usernameRef: username.ref, passwordRef: password.ref });
  report.stage = 'filled';
  assert.equal(await tab.view.webContents.executeJavaScript('document.getElementById("secret").value'), secret);
  report.nativeFill = true;
  const protectedCapture = await service.request(actor, 'capture', { tabId, mode: 'page' });
  assert.equal(protectedCapture.capture.screenshot, undefined);
  assert.equal(protectedCapture.capture.screenshotError.code, 'BROWSER_PASSWORD_CAPTURE_PROTECTED');
  report.protectedCapture = true;
  const focusActivity = { targetId: tab.targetId, tabId, sessionId: tab.sessionId, chatId: tab.chatId, generation: host.generation, token: randomUUID() };
  await host.activity({ ...focusActivity, active: true });
  try {
    await tab.view.webContents.executeJavaScript('document.getElementById("secret").value=""; document.getElementById("submit").focus()');
    const focused = new Promise((resolve) => { autocompleteShown = resolve; });
    const point = await tab.view.webContents.executeJavaScript('(()=>{const r=document.getElementById("secret").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
    tab.view.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    tab.view.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await Promise.race([focused, new Promise((_, reject) => setTimeout(() => reject(new Error('Physical focus did not show native autocomplete')), 3000))]);
    assert.equal(observed.tab.controller.owner, 'agent');
    assert.equal(autocompleteChoices.length, 1);
    assert.equal(autocompleteChoices[0].label, 'fixture-user');
    autocompleteChoices[0].click();
    const autocompleteDeadline = Date.now() + 3000;
    while (await tab.view.webContents.executeJavaScript('document.getElementById("secret").value') !== secret) {
      if (Date.now() >= autocompleteDeadline) throw new Error('Native autocomplete did not fill the focused form');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    report.humanAutocomplete = true;
  } finally { await host.activity({ ...focusActivity, active: false }); }
  const cdpSession = tab.cdpSessionId;
  await assert.rejects(host.cdp.command({ method: 'Runtime.evaluate', sessionId: cdpSession, params: { expression: 'btoa(document.getElementById("secret").value)' } }), /protect this page/);
  await assert.rejects(host.cdp.command({ method: 'Page.captureScreenshot', sessionId: cdpSession }), /protect this page/);
  await assert.rejects(host.cdp.command({ method: 'Network.getRequestPostData', sessionId: cdpSession, params: { requestId: 'fixture' } }), /protect this page/);
  const masked = await service.request(actor, 'snapshot', { tabId });
  assert.equal(masked.snapshot.elements.find((element) => element.inputType === 'password').value, '[masked]');
  const currentArgs = { tabId, snapshotId: masked.snapshot.snapshotId, navigationEpoch: masked.tab.navigationEpoch, controllerEpoch: masked.tab.controllerEpoch };
  const navigation = new Promise((resolve) => tab.view.webContents.once('did-navigate', resolve));
  await service.request(actor, 'click', { ...currentArgs, ref: masked.snapshot.elements.find(element => element.tag === 'button').ref });
  report.stage = 'clicked';
  await Promise.race([navigation, new Promise((_, reject) => setTimeout(() => reject(new Error('Native submit did not navigate')), 10000))]);
  assert.equal(submitted, true);
  await service.request(actor, 'wait', { tabId, state: 'load' });
  const socketDeadline = Date.now() + 3000;
  while (!receivedWebSocket || !await tab.view.webContents.executeJavaScript('!!window.socketReady')) {
    if (Date.now() >= socketDeadline) throw new Error('Protected native WSS did not complete its encrypted round trip');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  report.protectedWebSocket = true;
  let signedIn;
  const deadline = Date.now() + 3000;
  while (!signedIn) {
    try { signedIn = await service.request(actor, 'snapshot', { tabId }); }
    catch (error) { if (!error.code?.includes('STALE') || Date.now() >= deadline) throw error; await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  assert.match(signedIn.snapshot.text, /Account research fixture/);
  const input = signedIn.snapshot.elements.find((element) => element.tag === 'input');
  await service.request(actor, 'type', { tabId, snapshotId: signedIn.snapshot.snapshotId, ref: input.ref, text: 'Signed-in research', navigationEpoch: signedIn.tab.navigationEpoch, controllerEpoch: signedIn.tab.controllerEpoch });
  assert.equal(await tab.view.webContents.executeJavaScript('document.getElementById("research").value'), 'Signed-in research');
  await assert.rejects(service.request(actor, 'fill-account', { ...args, accountId: account.id, passwordRef: password.ref }), /changed|snapshot|stale/i);
  assert.equal(wire.some((message) => [secret, encodeURIComponent(secret), new URLSearchParams({ secret }).toString().slice(7), Buffer.from(secret).toString('base64')].some((value) => message.includes(value))), false);
  await tab.view.webContents.loadURL(origin);
  host.control({ tabId, human: true });
  host.attach(editor, { tabId, mode: 'dock', bounds: { x: 0, y: 0, width: 800, height: 600 }, interactive: true });
  await passwords.armSave(editor, { tabId, enabled: true });
  await tab.view.webContents.loadURL(`${origin}/school-login`);
  await tab.view.webContents.executeJavaScript(`for (const field of document.querySelectorAll('input')) { field.removeAttribute('name'); field.removeAttribute('autocomplete'); }`);
  await tab.view.webContents.executeJavaScript('document.querySelector("#identity").focus()');
  tab.view.webContents.insertText('manual-fixture-user');
  await tab.view.webContents.executeJavaScript('document.querySelector("#secret").focus()');
  tab.view.webContents.insertText(secret);
  await tab.view.webContents.executeJavaScript('document.querySelector("#submit").focus()');
  let manual;
  const saveDeadline = Date.now() + 3000;
  while (!(manual = (await vault.list()).accounts.find(account => account.username === 'manual-fixture-user'))) {
    if (Date.now() > saveDeadline) throw new Error('Manual login was not captured on password change');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await vault.withCredential(manual.id, credential => assert.equal(credential.password, secret));
  assert.equal(wire.some(message => message.includes(secret)), false);
  report.manualSave = true;
  // School login forms often omit both autocomplete and name attributes.
  await tab.view.webContents.executeJavaScript(`for (const field of document.querySelectorAll('input')) { field.removeAttribute('autocomplete'); field.removeAttribute('name'); field.value=''; } document.querySelector('#secret').focus()`);
  const inventory = await service.request(actor, 'status', {});
  assert.ok(inventory.accounts.some(account => account.id === manual.id && account.agentReuseApproved === true));
  assert.equal(JSON.stringify(inventory).includes(secret), false);
  const manualObservation = await service.request(actor, 'snapshot', { tabId });
  const loginId = manualObservation.snapshot.elements.find(element => element.inputType === 'text');
  const loginPassword = manualObservation.snapshot.elements.find(element => element.inputType === 'password');
  assert.ok(loginId && loginPassword);
  const filledManual = await service.request(actor, 'fill-account', { tabId, accountId: manual.id,
    snapshotId: manualObservation.snapshot.snapshotId, usernameRef: loginId.ref, passwordRef: loginPassword.ref,
    navigationEpoch: manualObservation.tab.navigationEpoch, controllerEpoch: manualObservation.tab.controllerEpoch });
  assert.equal(JSON.stringify(filledManual).includes(secret), false);
  report.agentManualAutofill = true;
  assert.equal(await tab.view.webContents.executeJavaScript('document.querySelector("#identity").value'), 'manual-fixture-user');
  report.schoolFormFill = true;
  await host.activity({ ...focusActivity, token: randomUUID(), active: true });
  let schoolIdMenu = false; autocompleteShown = () => { schoolIdMenu = true; };
  await tab.view.webContents.executeJavaScript('document.querySelector("#submit").focus()');
  const schoolPoint = await tab.view.webContents.executeJavaScript('(()=>{const r=document.querySelector("#identity").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  tab.view.webContents.sendInputEvent({ type: 'mouseDown', ...schoolPoint, button: 'left', clickCount: 1 });
  tab.view.webContents.sendInputEvent({ type: 'mouseUp', ...schoolPoint, button: 'left', clickCount: 1 });
  const menuDeadline = Date.now() + 3000;
  while (!schoolIdMenu) {
    if (Date.now() > menuDeadline) throw new Error('Saved-account menu did not open; focused=' + await tab.view.webContents.executeJavaScript('document.activeElement.id'));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(autocompleteChoices.some(choice => choice.label === 'manual-fixture-user'));
  report.schoolIdAutocomplete = true;
  const beforeReload = await service.request(actor, 'snapshot', { tabId });
  const reload = await service.request(actor, 'navigate', { tabId, direction: 'reload', navigationEpoch: beforeReload.tab.navigationEpoch, controllerEpoch: beforeReload.tab.controllerEpoch });
  assert.equal(reload.completed, true);
  const afterReload = await service.request(actor, 'snapshot', { tabId });
  assert.ok(afterReload.tab.navigationEpoch > beforeReload.tab.navigationEpoch);
  assert.equal(tab.passwordShield, true);
  assert.equal(JSON.stringify(afterReload).includes(secret), false);
  const protectedReloadSession = tab.cdpSessionId;
  await assert.rejects(host.cdp.command({ method: 'Page.reload', sessionId: protectedReloadSession, params: { scriptToEvaluateOnLoad: 'document.querySelector("input").value' } }), /protect this page/);
  report.protectedReload = true;
  report.nativeSubmit = true; report.postNavigationInput = true; report.noSecretInHub = true; report.staleAndWrongOriginRejected = true; report.rawReadbackAndCaptureBlocked = true;
  const previousPresentation = { bounds: tab.view.getBounds(), interactive: tab.interactive, focused: tab.view.webContents.isFocused() };
  const roleOpened = await service.request(actor, 'open', { url: publicOrigin + '/roles' });
  host.attach(editor, { tabId: roleOpened.tab.tabId, mode: 'dock', bounds: { x: 0, y: 0, width: 800, height: 600 } });
  const roleTab = await service.request(actor, 'snapshot', { tabId: roleOpened.tab.tabId });
  const roleElement = name => roleTab.snapshot.elements.find(element => element.name === name || element.text === name);
  const roleArgs = element => ({ tabId: roleTab.tab.tabId, snapshotId: roleTab.snapshot.snapshotId, ref: element.ref, navigationEpoch: roleTab.tab.navigationEpoch, controllerEpoch: roleTab.tab.controllerEpoch });
  assert.equal(roleElement('Location')?.role, 'columnheader');
  for (const name of ['Unknown fallback button', 'Abstract fallback button', 'Primary button']) {
    assert.equal(roleElement(name)?.role, 'button');
    await assert.rejects(service.request(actor, 'click', roleArgs(roleElement(name))), { code: 'BROWSER_PERMISSION_REQUIRED' });
  }
  assert.equal(roleElement('Fallback link')?.role, 'link');
  assert.equal(roleElement('Navigation text'), undefined);
  const sorted = await service.request(actor, 'click', roleArgs(roleElement('Location')));
  assert.equal(sorted.ok, true);
  assert.deepEqual(await host.tab(roleTab.tab.tabId).view.webContents.executeJavaScript('({rows:[...document.querySelector("tbody").rows].map(row=>row.textContent),sort:document.querySelector("th").getAttribute("aria-sort"),trusted:window.sortedTrusted,unknownClicks,abstractClicks,primaryClicks})'), { rows:['Afghanistan','Brazil','Zimbabwe'], sort:'ascending', trusted:true, unknownClicks:0, abstractClicks:0, primaryClicks:0 });
  assert.equal(publicRequests.some(request => request.method !== 'GET'), false);
  await service.request(actor, 'close', { tabId: roleTab.tab.tabId, navigationEpoch: sorted.tab.navigationEpoch, controllerEpoch: sorted.tab.controllerEpoch });
  host.attach(editor, { tabId, mode: 'dock', bounds: previousPresentation.bounds, interactive: previousPresentation.interactive });
  if (previousPresentation.focused) tab.view.webContents.focus();
  report.nativeRoleTokens = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  clearTimeout(timer);
  if (saveListener) ipcMain.off('desktop:browser-guest-save-login', saveListener);
  if (autocompleteListener) ipcMain.off('desktop:browser-guest-autocomplete', autocompleteListener);
  await service?.close().catch(() => {}); await host?.dispose().catch(() => {});
  if (editor && !editor.isDestroyed()) editor.destroy();
  if (webSockets) { for (const socket of webSockets.clients) socket.terminate(); await new Promise((resolve) => webSockets.close(resolve)); }
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
  console.log(`NATIVE_PASSWORD_REPORT ${JSON.stringify(report)}`);
  app.exit(process.exitCode || 0);
}
}
void app.whenReady().then(main);
