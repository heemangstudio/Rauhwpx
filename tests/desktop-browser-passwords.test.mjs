import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, randomUUID, pbkdf2Sync, createDecipheriv } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir, stat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { LocalBrowserPasswordVault } from '../desktop/browser-local-password-vault.mjs';
import { ChromePasswordImporter, decryptChromeMacPassword } from '../desktop/browser-chrome-password-import.mjs';
import { NativeBrowserPasswords } from '../desktop/browser-passwords.mjs';
import { PrivateBrowserCdp } from '../desktop/browser-cdp.mjs';
import { OwnedBrowserHost } from '../desktop/browser-host.mjs';

function fixtureStorage() {
  const key = randomBytes(32);
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value) => { const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce); const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), body]); },
    decryptStringAsync: async (value) => { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return { result: Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8') }; },
  };
}
async function vaultFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hama-password-vault-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const safeStorage = fixtureStorage(); const vault = new LocalBrowserPasswordVault({ dataDir: join(root, 'vault'), safeStorage });
  return { root, vault, safeStorage };
}
function encryptChrome(password, passphrase) {
  const key = pbkdf2Sync(passphrase, 'saltysalt', 1003, 16, 'sha1');
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from('v10'), cipher.update(password, 'utf8'), cipher.final()]);
}

test('native vault exposes metadata and writes OS-encrypted records with private permissions', async (t) => {
  const { root, vault, safeStorage } = await vaultFixture(t);
  const password = `fixture-secret-${randomUUID()}`;
  const account = await vault.importCredential({ origin: 'https://fixture.invalid/login', username: 'andy@example.invalid', password, sourceProfile: 'Fixture profile' });
  const metadata = await vault.list();
  assert.equal(metadata.accounts[0].id, account.id);
  assert.equal(metadata.accounts[0].agentReuseApproved, true);
  assert.equal(JSON.stringify(metadata).includes(password), false);
  const file = join(root, 'vault', 'local-passwords.json');
  assert.equal((await readFile(file, 'utf8')).includes(password), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const reopened = new LocalBrowserPasswordVault({ dataDir: join(root, 'vault'), safeStorage });
  await reopened.withCredential(account.id, async (credential) => assert.equal(credential.password, password));
  const updated = await vault.importCredential({ origin: account.origin, username: account.username, password: 'replacement', sourceProfile: 'Fixture' });
  assert.equal(updated.id, account.id);
  await vault.remove(account.id);
  await assert.rejects(vault.withCredential(account.id, () => {}), { code: 'BROWSER_PASSWORD_NOT_FOUND' });
});

test('native vault refuses unavailable/plaintext OS storage and altered metadata', async (t) => {
  const { root, vault, safeStorage } = await vaultFixture(t);
  const plaintext = new LocalBrowserPasswordVault({ dataDir: join(root, 'plaintext'), platform: 'linux', safeStorage: { ...safeStorage, getSelectedStorageBackend: () => 'basic_text' } });
  await assert.rejects(plaintext.importCredential({ origin: 'https://fixture.invalid', username: 'andy', password: 'fixture' }), { code: 'BROWSER_PASSWORD_STORAGE_UNAVAILABLE' });
  const account = await vault.importCredential({ origin: 'https://fixture.invalid', username: 'andy', password: 'fixture' });
  const file = join(root, 'vault', 'local-passwords.json');
  const state = JSON.parse(await readFile(file, 'utf8')); state.records[0].origin = 'https://other.invalid';
  await writeFile(file, JSON.stringify(state));
  const modified = new LocalBrowserPasswordVault({ dataDir: join(root, 'vault'), safeStorage });
  await assert.rejects(modified.withCredential(account.id, () => {}), { code: 'BROWSER_PASSWORD_STORAGE_UNAVAILABLE' });
});

test('batch import persists once and preserves prior accounts if any encryption fails', async (t) => {
  const { root, vault, safeStorage } = await vaultFixture(t);
  const prior = await vault.importCredential({ origin: 'https://fixture.invalid', username: 'andy', password: 'old-secret' });
  const before = await readFile(join(root, 'vault', 'local-passwords.json'));
  const encrypt = safeStorage.encryptStringAsync; let count = 0;
  safeStorage.encryptStringAsync = async (value) => { if (++count === 2) throw new Error('Synthetic storage failure'); return encrypt(value); };
  const batch = [{ origin: prior.origin, username: prior.username, password: 'new-secret' }, { origin: 'https://second.invalid', username: 'andy', password: 'second-secret' }];
  await assert.rejects(vault.importCredentials(batch), { code: 'BROWSER_PASSWORD_STORAGE_UNAVAILABLE' });
  assert.deepEqual(await readFile(join(root, 'vault', 'local-passwords.json')), before);
  assert.equal((await vault.list()).accounts.length, 1);
  await vault.withCredential(prior.id, ({ password }) => assert.equal(password, 'old-secret'));
  safeStorage.encryptStringAsync = encrypt;
  const persist = vault.persist.bind(vault); let writes = 0;
  vault.persist = async (records) => { writes++; return persist(records); };
  assert.equal((await vault.importCredentials(batch)).length, 2);
  assert.equal(writes, 1);
  assert.deepEqual(await vault.clear(), { removed: 2 });
  const reopened = new LocalBrowserPasswordVault({ dataDir: join(root, 'vault'), safeStorage });
  assert.equal((await reopened.list()).accounts.length, 0);
});

test('explicit Chrome profile import takes a WAL-consistent readonly snapshot and reports unsupported records', async (t) => {
  const { root, vault } = await vaultFixture(t);
  const chrome = join(root, 'Chrome'); const profile = join(chrome, 'Default');
  await mkdir(profile, { recursive: true });
  await writeFile(join(chrome, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Test profile' }, '../escape': { name: 'Blocked' } } } }));
  const db = new DatabaseSync(join(profile, 'Login Data'));
  t.after(() => db.close());
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE logins (origin_url TEXT, signon_realm TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER)');
  const insert = db.prepare('INSERT INTO logins VALUES (?, ?, ?, ?, 0)');
  insert.run('https://fixture.invalid/login', 'https://fixture.invalid/', 'andy', encryptChrome('fixture-password', 'fixture-keychain-key'));
  insert.run('https://unsupported.invalid/', 'https://unsupported.invalid/', 'andy', Buffer.from('v11new-format'));
  insert.run('http://insecure.invalid/', 'http://insecure.invalid/', 'andy', encryptChrome('ignored', 'fixture-keychain-key'));
  const accountDb = new DatabaseSync(join(profile, 'Login Data For Account'));
  t.after(() => accountDb.close());
  accountDb.exec('PRAGMA journal_mode = WAL; CREATE TABLE logins (origin_url TEXT, signon_realm TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER)');
  const accountInsert = accountDb.prepare('INSERT INTO logins VALUES (?, ?, ?, ?, 0)');
  accountInsert.run('https://fixture.invalid/other', 'https://fixture.invalid/', 'andy', encryptChrome('account-store-password', 'fixture-keychain-key'));
  accountInsert.run('https://account-only.invalid/', 'https://account-only.invalid/', 'andy', encryptChrome('account-only-password', 'fixture-keychain-key'));
  const sourceFiles = ['Login Data', 'Login Data-wal', 'Login Data-shm', 'Login Data For Account', 'Login Data For Account-wal', 'Login Data For Account-shm'];
  const sourceBefore = await Promise.all(sourceFiles.map(async (name) => ({ name, bytes: await readFile(join(profile, name)), info: await stat(join(profile, name), { bigint: true }) })));
  let keyReads = 0;
  const importer = new ChromePasswordImporter({ vault, platform: 'darwin', root: chrome, readKey: async () => { keyReads++; return Buffer.from('fixture-keychain-key'); } });
  const profiles = await importer.listProfiles();
  assert.equal(keyReads, 0);
  assert.equal(profiles.profiles.length, 1);
  assert.equal(JSON.stringify(profiles).includes(profile), false);
  await assert.rejects(importer.importProfile({ profileId: profile }), { code: 'BROWSER_CHROME_PROFILE_INVALID' });
  assert.deepEqual(await importer.importProfile({ profileId: profiles.profiles[0].id }), { imported: 2, skipped: 1, unsupported: 1 });
  assert.equal(keyReads, 1);
  assert.equal((await vault.list()).accounts.length, 2);
  const imported = (await vault.list()).accounts.find((account) => account.origin === 'https://fixture.invalid');
  await vault.withCredential(imported.id, ({ password }) => assert.equal(password, 'account-store-password'));
  for (const source of sourceBefore) {
    const file = join(profile, source.name); const after = await stat(file, { bigint: true });
    assert.deepEqual(await readFile(file), source.bytes);
    assert.equal(after.mtimeNs, source.info.mtimeNs); assert.equal(after.ctimeNs, source.info.ctimeNs);
  }
  assert.equal(db.prepare('SELECT count(*) AS count FROM logins').get().count, 3);
  const key = pbkdf2Sync('fixture-keychain-key', 'saltysalt', 1003, 16, 'sha1');
  assert.throws(() => decryptChromeMacPassword(Buffer.from('v20unsupported'), key), { code: 'BROWSER_CHROME_ENCRYPTION_UNSUPPORTED' });
});

test('Chrome keychain cancellation keeps the vault empty and imports can retry', async (t) => {
  const { root, vault } = await vaultFixture(t);
  const profile = join(root, 'Default'); await mkdir(profile);
  await writeFile(join(profile, 'Login Data'), 'fixture');
  const importer = new ChromePasswordImporter({ vault, platform: 'darwin', readRows: async () => [{ origin_url: 'https://fixture.invalid/', signon_realm: 'https://fixture.invalid/', username_value: 'andy', password_value: encryptChrome('fixture-password', 'fixture-keychain-key') }], readKey: async () => { throw Object.assign(new Error('Cancelled'), { code: 'BROWSER_CHROME_KEYCHAIN_DENIED' }); } });
  importer.profiles.set('fixture-profile', { path: await realpath(profile), name: 'Test profile' });
  await assert.rejects(importer.importProfile({ profileId: 'fixture-profile' }), { code: 'BROWSER_CHROME_KEYCHAIN_DENIED' });
  assert.equal((await vault.list()).accounts.length, 0);
  importer.readKey = async () => Buffer.from('fixture-keychain-key');
  assert.equal((await importer.importProfile({ profileId: 'fixture-profile' })).imported, 1);
});

function nativeFixture(vault) {
  const calls = [];
  const contents = { isDestroyed: () => false, getURL: () => 'https://fixture.invalid/login', getTitle: () => 'Login',
    getZoomFactor: () => 1,
    executeJavaScriptInIsolatedWorld: async (_world, scripts) => {
      const json = scripts[0].code.slice(scripts[0].code.lastIndexOf(')(...') + 5, -1);
      const args = JSON.parse(json); calls.push(args);
      if (typeof args[0] === 'string') return { elements: [{ ref: 'e1', tag: 'input', sensitive: true }, { ref: 'e2', tag: 'button', text: 'Sign in' }], text: 'Sign in', viewport: { width: 800, height: 600 } };
      return { completed: true, point: { x: 10, y: 10 } };
    }, sendInputEvent: (event) => calls.push(event) };
  const tab = { targetId: 'target', tabId: 'tab', sessionId: 'window', chatId: 'chat', navigationEpoch: 1, passwordControlEpoch: 1, view: { webContents: contents } };
  const host = { owner: {}, generation: 'generation', tabs: new Map([['target', tab]]), tab: (id) => { assert.ok(['target', 'tab'].includes(id)); return tab; } };
  const passwords = new NativeBrowserPasswords({ host, vault });
  const binding = { targetId: 'target', tabId: 'tab', sessionId: 'window', chatId: 'chat' };
  return { calls, contents, tab, host, passwords, binding };
}

test('native account filling fences chat, origin, snapshot, navigation, control and runtime generation', async (t) => {
  const { vault } = await vaultFixture(t);
  const account = await vault.importCredential({ origin: 'https://fixture.invalid', username: 'andy', password: 'fixture-password' });
  const f = nativeFixture(vault);
  const observation = await f.passwords.snapshot(f.binding);
  const request = { ...f.binding, snapshotId: observation.snapshotId, accountId: account.id, passwordRef: 'e1' };
  await assert.rejects(f.passwords.fill({ ...request, chatId: 'other-chat' }), { code: 'BROWSER_PASSWORD_SCOPE_MISMATCH' });
  f.tab.navigationEpoch++;
  await assert.rejects(f.passwords.fill(request), { code: 'BROWSER_PASSWORD_STALE_REFERENCE' });
  f.tab.navigationEpoch--;
  f.host.generation = 'new-generation';
  await assert.rejects(f.passwords.fill(request), { code: 'BROWSER_PASSWORD_STALE_REFERENCE' });
  f.host.generation = 'generation'; f.tab.passwordControlEpoch++;
  await assert.rejects(f.passwords.fill(request), { code: 'BROWSER_PASSWORD_STALE_REFERENCE' });
  f.tab.passwordControlEpoch--;
  const other = await vault.importCredential({ origin: 'https://other.invalid', username: 'andy', password: 'other-secret' });
  await assert.rejects(f.passwords.fill({ ...request, accountId: other.id }), { code: 'BROWSER_PASSWORD_ORIGIN_MISMATCH' });
  const run = f.passwords.run.bind(f.passwords);
  f.passwords.run = async () => ({ error: 'target' });
  await assert.rejects(f.passwords.fill(request), { code: 'BROWSER_PASSWORD_TARGET_INVALID' });
  assert.equal(f.tab.passwordShield, undefined);
  assert.equal(f.tab.protectedPasswords, undefined);
  f.passwords.run = run;
  const filled = await f.passwords.fill(request);
  assert.deepEqual(filled, { completed: true, accountId: account.id });
  assert.equal(JSON.stringify(filled).includes('fixture-password'), false);
  assert.equal(f.tab.passwordShield, true);
  assert.equal(f.passwords.redact(f.tab, { text: 'fixture-password', encoded: Buffer.from('fixture-password').toString('base64') }).text, '[masked]');
  await f.passwords.action({ ...f.binding, snapshotId: observation.snapshotId, action: 'click', ref: 'e2' });
  assert.equal(f.calls.at(-1).type, 'mouseUp');
});

test('protected CDP denies arbitrary/encoded reads, child sessions, nested commands and pre-fill pending reads', async () => {
  const events = new EventEmitter(); let resolveRead;
  const tab = { passwordShield: true, targetId: 'target', view: { webContents: { getURL: () => 'https://fixture.invalid', getTitle: () => 'Login', debugger: { sendCommand: async (method) => method === 'Runtime.evaluate' ? new Promise((resolve) => { resolveRead = resolve; }) : {} } } } };
  const host = { passwords: { redact: (_tab, value) => value }, session: {}, tabs: new Map([['target', tab]]) };
  const cdp = new PrivateBrowserCdp({ host }); cdp.tabs.set(tab.targetId, tab);
  cdp.sessions.set('main', { tab }); cdp.sessions.set('child', { tab, nativeSessionId: 'native-child' });
  const blocked = ['Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.awaitPromise', 'Runtime.getProperties', 'DOM.getAttributes', 'DOMSnapshot.captureSnapshot', 'Page.captureScreenshot', 'Page.addScriptToEvaluateOnNewDocument', 'Network.getRequestPostData', 'Network.getResponseBody', 'Network.loadNetworkResource', 'Fetch.getResponseBody', 'IO.read', 'DOMStorage.getDOMStorageItems', 'Storage.getStorageKeyForFrame', 'Target.sendMessageToTarget'];
  for (const sessionId of ['main', 'child']) for (const method of blocked) await assert.rejects(cdp.command({ method, sessionId }), /protect this page/);
  const worldName = `__playwright_utility_world_page@${'a'.repeat(32)}`;
  assert.deepEqual(await cdp.command({ method: 'Page.addScriptToEvaluateOnNewDocument', sessionId: 'main', params: { source: '', worldName } }), {});
  assert.deepEqual(await cdp.command({ method: 'Page.createIsolatedWorld', sessionId: 'main', params: { worldName, frameId: 'A'.repeat(32), grantUniveralAccess: true } }), {});
  await assert.rejects(cdp.command({ method: 'Page.addScriptToEvaluateOnNewDocument', sessionId: 'main', params: { source: 'document.querySelector("input").value', worldName } }), /protect this page/);
  await assert.rejects(cdp.command({ method: 'Page.addScriptToEvaluateOnNewDocument', sessionId: 'main', params: { source: '', worldName, runImmediately: true } }), /protect this page/);
  await assert.rejects(cdp.command({ method: 'Page.createIsolatedWorld', sessionId: 'main', params: { worldName: `${worldName}bad`, frameId: 'A'.repeat(32), grantUniveralAccess: true } }), /protect this page/);
  for (const url of ['javascript:alert(document.querySelector("input").value)', 'data:text/html,test', 'file:///tmp/test']) await assert.rejects(cdp.command({ method: 'Page.navigate', sessionId: 'main', params: { url } }), /HTTPS navigation/);
  assert.deepEqual(await cdp.command({ method: 'Page.getFrameTree', sessionId: 'main' }), {});
  tab.passwordShield = false;
  const pending = cdp.command({ method: 'Runtime.evaluate', sessionId: 'main', params: { expression: 'document.querySelector("input").value' } });
  tab.passwordShield = true; resolveRead({ result: { value: 'fixture-secret' } });
  await assert.rejects(pending, /protect this page/);
  events.removeAllListeners();
});

test('native asynchronous snapshots and physical actions reject changed document or runtime ownership', async (t) => {
  const { vault } = await vaultFixture(t); const f = nativeFixture(vault);
  const observed = await f.passwords.snapshot(f.binding);
  f.passwords.run = async () => { f.tab.navigationEpoch++; return { completed: true, point: { x: 10, y: 10 } }; };
  await assert.rejects(f.passwords.action({ ...f.binding, snapshotId: observed.snapshotId, action: 'click', ref: 'e2' }), { code: 'BROWSER_PASSWORD_STALE_REFERENCE' });
  assert.equal(f.calls.some((call) => call.type === 'mouseDown'), false);
  f.passwords.run = async () => { f.host.owner = {}; f.host.generation = 'changed'; return { elements: [], text: '' }; };
  await assert.rejects(f.passwords.snapshot(f.binding), { code: 'BROWSER_PASSWORD_STALE_REFERENCE' });
});

test('website zoom synchronously fences shared-origin native snapshots and pending physical clicks', async (t) => {
  const { vault } = await vaultFixture(t); const f = nativeFixture(vault);
  let factor = 1;
  const peer = { ...f.tab, targetId: 'peer', tabId: 'peer', passwordSnapshot: { snapshotId: 'peer-observation' } };
  f.contents.getZoomFactor = () => factor;
  f.contents.setZoomFactor = (value) => { factor = value; };
  f.host.tabs.set(peer.targetId, peer);
  f.host.ownedTab = () => f.tab;
  f.host.state = (tab) => ({ zoomFactor: tab.view.webContents.getZoomFactor() });
  const zoomEvents = [];
  f.host.emit = (tab) => { zoomEvents.push(tab.tabId); assert.equal(tab.passwordSnapshot, null); };
  const observed = await f.passwords.snapshot(f.binding);
  f.passwords.run = async () => { OwnedBrowserHost.prototype.zoom.call(f.host, {}, { tabId: f.tab.tabId, factor: 1.5 }); return { completed: true, point: { x: 10, y: 10 } }; };
  await assert.rejects(f.passwords.action({ ...f.binding, snapshotId: observed.snapshotId, action: 'click', ref: 'e2' }), { code: 'BROWSER_PASSWORD_STALE_REFERENCE' });
  assert.equal(f.calls.some((call) => call.type === 'mouseDown'), false);
  assert.deepEqual(zoomEvents.sort(), ['peer', 'tab']);
  assert.equal(peer.passwordControlEpoch, 2);
  f.passwords.run = async () => { factor = 2; return { elements: [], text: '' }; };
  await assert.rejects(f.passwords.snapshot(f.binding), { code: 'BROWSER_PASSWORD_STALE_REFERENCE' });
});

test('native physical clicks convert CSS coordinates to DIP at the observed page zoom', async (t) => {
  const { vault } = await vaultFixture(t); const f = nativeFixture(vault);
  f.contents.getZoomFactor = () => 1.5;
  const observed = await f.passwords.snapshot(f.binding);
  await f.passwords.action({ ...f.binding, snapshotId: observed.snapshotId, action: 'click', ref: 'e2' });
  assert.deepEqual(f.calls.filter((call) => call.type === 'mouseDown' || call.type === 'mouseUp').map(({ x, y }) => ({ x, y })), [{ x: 15, y: 15 }, { x: 15, y: 15 }]);
});

test('protected relay projects website-controlled network, dialog and target strings', async () => {
  const secret = 'fixture password ! ~'; const transformed = Buffer.from(secret).toString('hex');
  const debuggerApi = new EventEmitter(); debuggerApi.isAttached = () => false; debuggerApi.attach = () => {};
  debuggerApi.sendCommand = async () => ({ targetInfo: { targetId: 'target' } });
  const tab = { passwordShield: true, passwordAllowedOrigins: new Set(['https://fixture.invalid']), targetId: 'target', view: { webContents: { debugger: debuggerApi, getURL: () => `https://fixture.invalid/${transformed}`, getTitle: () => transformed } } };
  const cdp = new PrivateBrowserCdp({ host: {} }); const sent = []; cdp.send = (message) => sent.push(message);
  await cdp.add(tab); tab.cdpSessionId = 'main';
  debuggerApi.emit('message', {}, 'Network.requestWillBeSent', { requestId: '1', documentURL: `https://fixture.invalid/?${transformed}`, request: { url: `https://fixture.invalid/${transformed}`, method: 'POST', headers: { value: transformed }, postData: secret, hasPostData: true }, initiator: { stack: transformed } });
  debuggerApi.emit('message', {}, 'Fetch.requestPaused', { requestId: '2', request: { url: `https://fixture.invalid/${transformed}`, method: 'POST', headers: { value: transformed }, postData: secret }, responseHeaders: [{ name: 'secret', value: transformed }] });
  debuggerApi.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'prompt', message: transformed, defaultPrompt: secret, url: `https://fixture.invalid/${transformed}` });
  debuggerApi.emit('message', {}, 'Network.webSocketFrameReceived', { response: { payloadData: transformed } });
  assert.equal(sent.length, 3);
  const metadata = cdp.targetInfo(tab);
  assert.equal(metadata.url, 'https://fixture.invalid/'); assert.equal(metadata.title, '');
  for (const value of [secret, transformed]) assert.equal(JSON.stringify({ sent, metadata }).includes(value), false);
  assert.equal(sent[0].params.request.hasPostData, true);
});
