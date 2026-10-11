import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BrowserWebAuthn, WEB_AUTHN_KEYCHAIN_GROUP } from '../desktop/browser-webauthn.mjs';

function fixture(options = {}) {
  const contents = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false });
  const window = Object.assign(new EventEmitter(), { id: 2, isDestroyed: () => false });
  const tab = { view: { webContents: contents }, targetId: 'native', sessionId: 'editor', windowId: 2, navigationEpoch: 1 };
  const frame = { url: 'https://site.example/login' };
  const requests = [];
  const events = [];
  const configured = [];
  const service = new BrowserWebAuthn({ app: { whenReady: async () => {}, configureWebAuthn: (value) => configured.push(value) },
    systemPreferences: { canPromptTouchID: () => true }, platform: 'darwin', electronVersion: '43.3.0',
    checkEntitlement: async () => true, getTabForFrame: (value) => value === frame ? tab : null,
    getWindowForTab: () => window, onState: (_tab, state) => events.push(state),
    dialog: { showMessageBox: (_window, request) => new Promise((resolve) => requests.push({ request, resolve })) }, ...options });
  const details = { frame, relyingPartyId: 'site.example', accounts: [{ credentialId: 'secret-handle-one', name: 'private-name-one' }, { credentialId: 'secret-handle-two', name: 'private-name-two' }] };
  return { service, contents, window, tab, frame, requests, events, configured, details };
}

test('native Touch ID config requires the running signature and describes its credential scope', async () => {
  const denied = fixture({ checkEntitlement: async () => false });
  assert.equal((await denied.service.configure()).touchIdConfigured, false);
  assert.equal(denied.configured.length, 0);
  const signed = fixture();
  const result = await signed.service.configure();
  await signed.service.configure();
  assert.equal(signed.configured.length, 1);
  assert.equal(signed.configured[0].touchID.keychainAccessGroup, WEB_AUTHN_KEYCHAIN_GROUP);
  assert.equal(result.touchIdAvailable, true);
  assert.equal(result.existingMacPasskeys, false);
  assert.equal(result.credentialScope, 'device-and-browser-profile');
});

test('only a human native account choice completes WebAuthn and metadata stays private', async () => {
  const f = fixture();
  const calls = [];
  const selection = f.service.selectAccount(f.details, (id) => calls.push(id));
  assert.deepEqual(calls, []);
  assert.equal(f.requests[0].request.defaultId, 0);
  assert.equal(f.requests[0].request.cancelId, 0);
  assert.equal(JSON.stringify(f.events).includes('secret-handle'), false);
  assert.equal(JSON.stringify(f.events).includes('private-name'), false);
  f.requests[0].resolve({ response: 2 });
  await selection;
  assert.deepEqual(calls, ['secret-handle-two']);
  assert.equal(f.service.pending.size, 0);
});

test('navigation, renderer loss, window close and disposal cancel once despite a late selection', async () => {
  for (const event of ['did-start-navigation', 'destroyed', 'render-process-gone', 'closed', 'dispose']) {
    const f = fixture();
    const calls = [];
    const selection = f.service.selectAccount(f.details, (id) => calls.push(id));
    if (event === 'dispose') f.service.dispose();
    else if (event === 'closed') f.window.emit(event);
    else f.contents.emit(event);
    assert.equal(f.requests[0].request.signal.aborted, true);
    assert.deepEqual(calls, [undefined]);
    f.requests[0].resolve({ response: 1 });
    await selection;
    assert.deepEqual(calls, [undefined]);
    assert.equal(f.contents.listenerCount('did-start-navigation'), 0);
  }
});

test('stale bindings, unknown frames and explicit dismissal do not select a credential', async () => {
  const f = fixture();
  const calls = [];
  const selection = f.service.selectAccount(f.details, (id) => calls.push(id));
  f.tab.sessionId = 'other-editor';
  f.requests[0].resolve({ response: 1 });
  await selection;
  await f.service.selectAccount({ ...f.details, frame: null }, (id) => calls.push(id));
  const dismissal = f.service.selectAccount(f.details, (id) => calls.push(id));
  f.requests[1].resolve({ response: 0 });
  await dismissal;
  assert.deepEqual(calls, [undefined, undefined, undefined]);
});

const require = createRequire(import.meta.url);
let electron;
try { electron = require('electron'); } catch {}
const unavailable = !electron || !existsSync(electron) || (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
test('real Electron validates RP and cancels a local WebAuthn request with virtual credentials', { skip: unavailable ? 'Electron binary and display are required' : false, timeout: 35_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hama-webauthn-'));
  const env = { ...process.env, RHWP_WEBAUTHN_TEST_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const entry = fileURLToPath(new URL('./electron/browser-webauthn.mjs', import.meta.url));
  try {
    const report = await new Promise((resolve, reject) => {
      const child = spawn(electron, [entry, '--use-mock-keychain'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (data) => { stdout += data; });
      child.stderr.on('data', (data) => { stderr += data; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => {
        clearTimeout(timer);
        const line = stdout.split('\n').find((value) => value.startsWith('WEBAUTHN_REPORT '));
        if (code !== 0 || !line) reject(new Error(`WebAuthn fixture failed\n${stdout}\n${stderr}`));
        else resolve(JSON.parse(line.slice('WEBAUTHN_REPORT '.length)));
      });
    });
    assert.equal(report.invalidRp, 'SecurityError');
    assert.equal(report.cancelled, 'NotAllowedError');
    assert.equal(report.selectedAccounts, 2);
    assert.equal(report.existingMacPasskeys, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
