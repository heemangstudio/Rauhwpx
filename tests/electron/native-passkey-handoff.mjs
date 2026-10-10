import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { app, BrowserWindow, WebContentsView, session } from 'electron';
import { OwnedBrowserHost } from '../../desktop/browser-host.mjs';
import { startOwnedBrowserSignIn } from '../../rhwp/rhwp-agent/owned-browser-runtime.mjs';
import { key, cert } from '../../rhwp/rhwp-agent/tests/fixtures/owned-browser-tls.mjs';
import { createOwnedBrowserService } from '../../rhwp/rhwp-agent/owned-browser-service.mjs';

const dataDir = process.env.RHWP_WEBAUTHN_TEST_DIR;
app.setPath('userData', path.join(dataDir, 'electron'));
app.commandLine.appendSwitch('ignore-certificate-errors');
app.on('window-all-closed', () => {});
let browser; let editor; let host;
const createService = process.env.RHWP_TEST_BROWSER_SERVICE_MODULE ? (await import(process.env.RHWP_TEST_BROWSER_SERVICE_MODULE)).createOwnedBrowserService : createOwnedBrowserService;
let servedLogin;
const served = new Promise((resolve) => { servedLogin = resolve; });
const server = createServer({ key, cert }, (request, response) => {
  response.setHeader('Content-Type', 'text/html');
  if (request.url === '/login') {
    response.setHeader('Set-Cookie', 'nativeFixture=approved; Path=/; Secure; HttpOnly; Max-Age=3600');
    response.on('finish', servedLogin);
    response.end('<title>Controlled Chrome session</title><h1>Local session created</h1>');
  } else response.end(`<title>Native guest fixture</title><h1>${request.headers.cookie?.includes('nativeFixture=approved') ? 'Authenticated native guest' : 'Initial native guest'}</h1><label>Research field <input id=research></label><form><input name=identity autocomplete=username><input name=secret type=password autocomplete=current-password></form>`);
});
const unrelatedServer = createServer({ key, cert }, (_request, response) => response.end('<title>Unrelated origin storage</title><h1>Retained storage</h1>'));
app.whenReady().then(async () => {
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => unrelatedServer.listen(0, '127.0.0.1', resolve));
  const unrelatedOrigin = `https://127.0.0.1:${unrelatedServer.address().port}`;
  editor = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const Host = process.env.RHWP_TEST_NATIVE_PASSWORD_HOST ? (await import(process.env.RHWP_TEST_NATIVE_PASSWORD_HOST)).OwnedBrowserHost : OwnedBrowserHost;
  host = new Host({ BrowserWindow, WebContentsView, electronSession: session, dataDir, getWindowForSession: () => editor });
  const nativeOwner = {};
  const passwordsModule = await import(process.env.RHWP_TEST_NATIVE_PASSWORD_HOST ? new URL('./browser-passwords.mjs', process.env.RHWP_TEST_NATIVE_PASSWORD_HOST).href : '../../desktop/browser-passwords.mjs').catch(() => null);
  const secret = 'synthetic-native-autofill-only';
  if (passwordsModule) new passwordsModule.NativeBrowserPasswords({ host, vault: { async withCredential(_id, use) { return use({ origin, username: 'fixture-user', password: secret }, { assertCurrent() {}, write: callback => callback() }); } } });
  const nativeAdapter = {
    async start(params) { return { ...await host.start(params, nativeOwner), close: () => host.release(nativeOwner) }; },
    ...(host.activity ? { activity: (params) => host.activity(params) } : {}),
    ...(host.importSession ? { importSession: (params) => host.importSession(params) } : {}),
    passwordStorageState: () => host.passwords?.storageState() ?? null,
    ...(host.passwords ? { passwordSnapshot: (params) => host.passwords.snapshot(params), passwordAction: (params) => host.passwords.action(params), passwordFill: (params) => host.passwords.fill(params) } : {}),
    bind: (params) => host.bind(params), control: (params) => host.control(params),
    inventory: () => [...host.tabs.values()].map((tab) => host.state(tab)),
  };
  const checkpoints = new Map();
  if (process.env.RHWP_TEST_NATIVE_PARTIAL_CHECKPOINT === '1') {
    const { createBrowserCredentialBroker } = await import('../../rhwp/rhwp-agent/browser-credentials.mjs');
    const { createBrowserPolicy } = await import('../../rhwp/rhwp-agent/browser-policy.mjs');
    const policy = createBrowserPolicy({ dataDir });
    const options = { dataDir, policy, wrappingKeyProvider: async () => Buffer.alloc(32, 8) };
    const secureBroker = createBrowserCredentialBroker(options);
    await secureBroker.ready();
    const human = { isHuman: true };
    const requested = await secureBroker.requestAccount({ actor: human, origin, origins: [origin], label: 'Synthetic restart archive' });
    const { account } = await secureBroker.approveAccount({ actor: human, requestId: requested.requestId, approval: { approved: true, requestId: requested.requestId, use: true } });
    await secureBroker.confirmAccountSession({ actor: human, accountId: account.id, additionalProfileId: 'native' });
    await secureBroker.saveCheckpoint({ profileId: 'native', state: { cookies: [], origins: [{ origin, localStorage: [{ name: 'fresh-archive-token', value: 'encrypted-approved-origin' }] }] } });
    await secureBroker.saveCheckpoint({ profileId: 'native', state: { cookies: [], origins: [], originsComplete: false } });
    const restarted = createBrowserCredentialBroker(options);
    await restarted.ready();
    checkpoints.set('native', await restarted.restoreCheckpoint({ profileId: 'native' }));
    assert.equal(host.tabs.size, 0, 'the checkpoint must restore before any native guest exists');
  }
  const account = { id: 'local-native-fixture', profileId: 'default', origins: [origin], agentReuseApproved: true };
  const broker = {
    async listAccounts() { return { accounts: [account] }; }, async registerSessionOrigins() {}, setSessionClearer() {},
    async assertBrowserAccess() {}, async saveCheckpoint({ profileId, state }) { checkpoints.set(profileId, state); },
    async restoreCheckpoint({ profileId }) { return checkpoints.get(profileId) ?? null; }, async deleteCheckpoint({ profileId }) { checkpoints.delete(profileId); },
    async confirmAccountSession({ additionalProfileId }) { assert.equal(additionalProfileId, 'native'); return { account }; },
  };
  browser = createService({ dataDir, nativeAdapter, credentialBroker: broker, workspaceTargets: [origin, unrelatedOrigin], autoInstall: false, signInFactory: (settings) => startOwnedBrowserSignIn({ ...settings, spawnProcess: (executable, args, options) => spawn(executable, ['--ignore-certificate-errors', ...args], options) }) });
  const actor = { isHuman: true, clientId: 'editor', sessionId: 'editor', threadId: 'research', agentId: 'owner' };
  const opened = await browser.request(actor, 'open', { url: `${origin}/research` });
  const unrelated = await browser.request(actor, 'open', { url: `${unrelatedOrigin}/other` });
  const unrelatedContents = host.tab(unrelated.tab.tabId).view.webContents;
  await unrelatedContents.executeJavaScript(`localStorage.setItem('retained-session', 'unrelated-local-value'); new Promise((resolve, reject) => { const request = indexedDB.open('retained-session-db', 1); request.onupgradeneeded = () => request.result.createObjectStore('values'); request.onsuccess = () => { request.result.close(); resolve(true); }; request.onerror = () => reject(request.error); })`);
  const nativeTab = host.tab(opened.tab.tabId);
  if (process.env.RHWP_TEST_NATIVE_PARTIAL_CHECKPOINT === '1') assert.equal(await nativeTab.view.webContents.executeJavaScript("localStorage.getItem('fresh-archive-token')"), 'encrypted-approved-origin');
  const before = await nativeTab.view.webContents.executeJavaScript('document.querySelector("h1").textContent');
  assert.equal(before, 'Initial native guest');
  if (host.zoom) host.zoom(editor, { tabId: nativeTab.tabId, factor: 1.5 });
  if (host.passwords) {
    const binding = { targetId: nativeTab.targetId, tabId: nativeTab.tabId, sessionId: nativeTab.sessionId, chatId: nativeTab.chatId };
    const snapshot = await host.passwords.snapshot(binding);
    await host.passwords.fill({ ...binding, accountId: 'fixture', snapshotId: snapshot.snapshotId, passwordRef: snapshot.elements.find((entry) => entry.inputType === 'password').ref, usernameRef: snapshot.elements.find((entry) => entry.autocomplete === 'username').ref });
    assert.equal(nativeTab.passwordShield, true);
  }
  await browser.request(actor, 'sign-in', { accountId: account.id, url: `${origin}/login`, authenticationMethod: 'mac-passkey' });
  await Promise.race([served, new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('Chrome fixture failed to load')), 12000); timer.unref(); })]);
  const confirmed = await browser.request(actor, 'confirm-sign-in', { accountId: account.id });
  assert.equal(confirmed.runtime.mode, 'native');
  const tabs = (await browser.inventory(actor)).tabs;
  const retained = tabs.find((tab) => tab.tabId === opened.tab.tabId);
  assert.equal(retained.nativeTargetId, opened.tab.nativeTargetId);
  const contents = host.tab(opened.tab.tabId).view.webContents;
  assert.equal(await contents.executeJavaScript('document.querySelector("h1").textContent'), 'Authenticated native guest');
  assert.equal(await contents.executeJavaScript('location.pathname'), '/research');
  const agent = { threadId: 'research', agentId: 'owner', sessionId: 'editor' };
  console.error('NATIVE_PASSKEY_STAGE agent-snapshot');
  const observed = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  assert.ok(observed.snapshot.text.includes('Authenticated native guest'));
  if (host.zoom) {
    assert.equal(contents.getZoomFactor(), 1.5);
    assert.ok(Math.abs(observed.snapshot.viewport.width * 1.5 - nativeTab.viewport.width) <= 2, 'zoomed snapshot must use CSS viewport dimensions');
  }
  const field = observed.snapshot.elements.find((entry) => entry.name === 'Research field');
  assert.ok(field?.rect.width > 0 && field.rect.x + field.rect.width <= observed.snapshot.viewport.width, 'research ref coordinates must fit the zoomed viewport');
  assert.ok(field, 'the recovered browser must expose a usable research field');
  console.error('NATIVE_PASSKEY_STAGE agent-type');
  await browser.request(agent, 'type', { tabId: opened.tab.tabId, snapshotId: observed.snapshot.snapshotId, navigationEpoch: observed.tab.navigationEpoch, controllerEpoch: observed.tab.controllerEpoch, ref: field.ref, text: 'agent research resumed' });
  assert.equal(await contents.executeJavaScript('document.querySelector("#research").value'), 'agent research resumed');
  assert.equal(nativeTab.activityLeases?.size ?? 0, 0);
  assert.equal(await contents.executeJavaScript('document.hidden'), true);
  assert.equal(await unrelatedContents.executeJavaScript("localStorage.getItem('retained-session')"), 'unrelated-local-value');
  assert.equal(await unrelatedContents.executeJavaScript("indexedDB.databases().then(databases => databases.some(entry => entry.name === 'retained-session-db'))"), true);
  console.log(`NATIVE_PASSKEY_REPORT ${JSON.stringify({ mode: confirmed.runtime.mode, retainedTarget: true, authenticated: true, retainedPath: '/research', protectedAutofill: !!host.passwords, unrelatedStoragePreserved: true, agentReady: true, hiddenAfterAction: true, zoomGeometry: !!host.zoom, freshCheckpointRestored: process.env.RHWP_TEST_NATIVE_PARTIAL_CHECKPOINT === '1' })}`);
} catch (error) { console.error(error.stack); process.exitCode = 1; }
finally {
  await browser?.close();
  await host?.dispose();
  await host?.session?.closeAllConnections();
  editor?.destroy();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  unrelatedServer.closeAllConnections();
  await new Promise((resolve) => unrelatedServer.close(resolve));
  app.exit(process.exitCode ?? 0);
}
});
