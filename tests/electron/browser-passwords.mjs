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
import { createSecretVault } from '../../desktop/secret-vault.mjs';
import { createBrowserPolicy } from '../../rhwp/rhwp-agent/browser-policy.mjs';
import { createBrowserCredentialBroker } from '../../rhwp/rhwp-agent/browser-credentials.mjs';
import { createOwnedBrowserService, createIpcNativeBrowserAdapter } from '../../rhwp/rhwp-agent/owned-browser-service.mjs';
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
  const ownerVault = createSecretVault({ filePath: join(root, 'owner-secrets.json'), safeStorage });
  const secretStore = { available: true, get: key => ownerVault.get(key), set: (key, value) => ownerVault.set(key, value), delete: key => ownerVault.delete(key) };
  const credentialBroker = createBrowserCredentialBroker({ dataDir, policy: createBrowserPolicy({ dataDir }), secretStore });
  const passwords = new NativeBrowserPasswords({ host, vault, Menu, readBrokerCredential: async id => {
    const value = await ownerVault.get(`browser.password.${id}`); return value ? JSON.parse(value) : null;
  } });
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
  service = createOwnedBrowserService({ dataDir, credentialBroker, policy: { assertAllowed: async () => {} }, nativeAdapter: adapter, workspaceTargets: [origin], autoInstall: false, runtimeFactory: startOwnedBrowserRuntime });
  report.stage = 'opening';
  const actor = { threadId: 'chat-one', agentId: 'agent-one', sessionId: 'editor', projectId: 'project-one' };
  const idle = await service.request(actor, 'status');
  assert.equal(idle.runtime.state, 'idle');
  assert.equal(idle.readiness.installed, true);
  assert.equal(idle.readiness.state, 'ready');
  const opened = await service.request(actor, 'open', { url: origin });
  report.stage = 'opened';
  const tabId = opened.tab.tabId;
  const tab = host.tab(tabId);
  host.attach(editor, { tabId, mode: 'dock', bounds: { x: 0, y: 0, width: 800, height: 600 }, interactive: true });
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
  const username = observed.snapshot.elements.find((element) => element.autocomplete === 'username');
  const password = observed.snapshot.elements.find((element) => element.inputType === 'password');
  const submit = observed.snapshot.elements.find((element) => element.tag === 'button');
  assert.ok(username && password && submit);
  const args = { tabId, snapshotId: observed.snapshot.snapshotId, navigationEpoch: observed.tab.navigationEpoch, controllerEpoch: observed.tab.controllerEpoch };
  await service.request(actor, 'type', { ...args, ref: username.ref, text: 'public-identifier' });
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
  await service.request(actor, 'click', { ...currentArgs, ref: submit.ref });
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
  // The secure account form stores this account in the owner vault, never the Chrome-import vault.
  const ownerActor = { ...actor, isHuman: true, clientId: 'fixture-owner' };
  const registration = await credentialBroker.requestAccount({ actor: ownerActor, origin, origins: [origin], profileId: 'default', label: 'Owner-vault fixture' });
  const { account: brokerAccount } = await credentialBroker.submit({ actor: ownerActor, requestId: registration.requestId,
    approval: { approved: true, requestId: registration.requestId, save: true, use: true },
    account: { origin, origins: [origin], label: 'Owner-vault fixture', profileId: 'default' }, username: 'owner-vault-user', password: secret, remember: true });
  assert.equal((await vault.list()).accounts.some(row => row.id === brokerAccount.id), false);
  await credentialBroker.registerSessionOrigins({ profileId: 'native', origins: [origin], source: 'human' });
  await assert.rejects(credentialBroker.assertBrowserAccess({ actor, url: origin, tab: { profileId: 'native' } }), { code: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED' });
  const nativeApproval = await credentialBroker.requestAccount({ actor, accountId: brokerAccount.id, profileId: 'native' });
  await service.request(ownerActor, 'control', { tabId, owner: 'human' });
  await tab.view.webContents.executeJavaScript("document.cookie='approvalFixture=owner-login; path=/; Secure'; localStorage.setItem('approvalFixture','owner-login')");
  const migrated = await service.approveAccount({ actor: ownerActor, requestId: nativeApproval.requestId,
    approval: { approved: true, requestId: nativeApproval.requestId, use: true } });
  assert.equal(migrated.account.id, brokerAccount.id);
  await service.request(ownerActor, 'control', { tabId, owner: 'agent' });
  await tab.view.webContents.executeJavaScript("document.cookie='approvalFixture=site-refresh; path=/; Secure'; localStorage.setItem('approvalFixture','site-refresh')");
  await service.inventory(actor);
  assert.equal((await credentialBroker.listAccounts()).accounts.find(account => account.id === brokerAccount.id).agentReuseApproved, true,
    'the approved native account survives normal cookie and localStorage refresh');
  await service.request(ownerActor, 'control', { tabId, owner: 'human' });
  await tab.view.webContents.executeJavaScript("document.cookie='approvalFixture=owner-update; path=/; Secure'");
  const update = await credentialBroker.requestAccount({ actor: ownerActor, accountId: brokerAccount.id, profileId: 'native', intent: 'save' });
  const updated = await service.submitAccount({ actor: ownerActor, requestId: update.requestId,
    username: 'owner-vault-user', password: secret, approval: { approved: true, requestId: update.requestId, save: true, use: true } });
  assert.equal(updated.account.id, brokerAccount.id);
  await service.request(ownerActor, 'control', { tabId, owner: 'agent' });
  await tab.view.webContents.executeJavaScript("document.cookie='approvalFixture=after-save; path=/; Secure'");
  await service.inventory(actor);
  assert.equal((await credentialBroker.listAccounts()).accounts.find(account => account.id === brokerAccount.id).agentReuseApproved, true,
    'saving an account with reuse consent also settles the current session');
  report.brokerApprovalSurvivesSessionRefresh = true;
  assert.equal(migrated.account.profileId, 'native');
  assert.equal(migrated.account.sessionApprovalRequired, false);

  const nativeObservation = await service.request(actor, 'snapshot', { tabId });
  const userField = nativeObservation.snapshot.elements.find(row => row.tag === 'input' && row.inputType !== 'password');
  const secretField = nativeObservation.snapshot.elements.find(row => row.inputType === 'password');
  const nativeArgs = { tabId, accountId: brokerAccount.id, snapshotId: nativeObservation.snapshot.snapshotId,
    usernameRef: userField.ref, passwordRef: secretField.ref, navigationEpoch: nativeObservation.tab.navigationEpoch, controllerEpoch: nativeObservation.tab.controllerEpoch };
  const brokerFilled = await service.request(actor, 'fill-account', nativeArgs);
  assert.equal(brokerFilled.completed, true);
  assert.equal(await tab.view.webContents.executeJavaScript(`document.querySelector('#identity').value === 'owner-vault-user' && document.querySelector('#secret').value === ${JSON.stringify(secret)}`), true);
  assert.equal(wire.some(message => message.includes(secret)), false, 'owner-vault password never crosses the native adapter wire');
  const shielded = await service.request(actor, 'snapshot', { tabId });
  assert.equal(JSON.stringify(shielded).includes(secret), false);
  await credentialBroker.revokeAccount({ actor: ownerActor, accountId: brokerAccount.id });
  await assert.rejects(service.request(actor, 'fill-account', { ...nativeArgs, snapshotId: shielded.snapshot.snapshotId,
    navigationEpoch: shielded.tab.navigationEpoch, controllerEpoch: shielded.tab.controllerEpoch }), { code: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED' });
  report.brokerAccountAutofill = true;
  report.nativeSubmit = true; report.postNavigationInput = true; report.noSecretInHub = true; report.staleAndWrongOriginRejected = true; report.rawReadbackAndCaptureBlocked = true;
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
