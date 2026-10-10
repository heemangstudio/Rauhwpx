import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createBrowserOsSecretStore } from '../browser-os-secret-store.mjs';

const key = `browser.password.${crypto.randomUUID()}`;
function backend() {
  const secrets = new Map();
  const calls = [];
  class AsyncEntry {
    constructor(service, account, options) { this.id = `${service}:${account}`; calls.push({ service, account, options }); }
    async getSecret() { return secrets.get(this.id); }
    async setSecret(value) { secrets.set(this.id, Uint8Array.from(value)); }
    async deleteCredential() { return secrets.delete(this.id); }
  }
  return { native: { AsyncEntry }, secrets, calls };
}

test('native browser vault is lazy, scoped to its data owner and roundtrips asynchronously', async () => {
  const fake = backend();
  let loads = 0;
  const store = await createBrowserOsSecretStore({ dataDir: '/tmp/browser-os-owner-a', platform: 'darwin', loadNative: async () => { loads++; return fake.native; } });
  assert.equal(loads, 0);
  assert.equal(store.backend, 'keychain');
  await store.set(key, 'secret-fixture');
  assert.equal(await store.get(key), 'secret-fixture');
  assert.equal(loads, 1);
  assert.equal(await store.delete(key), true);
  assert.equal(await store.get(key), null);
  const other = await createBrowserOsSecretStore({ dataDir: '/tmp/browser-os-owner-b', platform: 'darwin', loadNative: async () => fake.native });
  await other.get(key);
  assert.notEqual(fake.calls[0].service, fake.calls.at(-1).service);
});

test('Linux pins durable Secret Service and never retries through an insecure backend', async () => {
  const fake = backend();
  const store = await createBrowserOsSecretStore({ dataDir: '/tmp/browser-os-linux', platform: 'linux', loadNative: async () => fake.native });
  await store.set(key, 'fixture');
  assert.deepEqual(fake.calls[0].options, { linux: { store: 'secret-service' } });
  let attempts = 0;
  const unavailable = await createBrowserOsSecretStore({ dataDir: '/tmp/browser-os-unavailable', platform: 'linux', loadNative: async () => ({ AsyncEntry: class { constructor() { attempts++; throw new Error('secret-service unavailable SECRET-MUST-NOT-LEAK'); } } }) });
  await assert.rejects(unavailable.get(key), (error) => error.code === 'BROWSER_SECURE_STORAGE_UNAVAILABLE' && !error.message.includes('SECRET-MUST-NOT-LEAK'));
  assert.equal(attempts, 1);
});

test('browser secret namespaces and payload limits reject input before touching native or IPC stores', async () => {
  let calls = 0;
  const ipcStore = { available: true, async set() { calls++; }, async get() { calls++; return null; } };
  const store = await createBrowserOsSecretStore({ dataDir: '/tmp/browser-os-ipc', ipcStore, platform: 'win32', maxSecretBytes: 2560 });
  await assert.rejects(store.get('provider-password'), { code: 'BROWSER_SECRET_NAMESPACE_INVALID' });
  await assert.rejects(store.get(`${key}.extra`), { code: 'BROWSER_SECRET_NAMESPACE_INVALID' });
  await assert.rejects(store.set(key, 'x'.repeat(2561)), { code: 'BROWSER_SECRET_SIZE_LIMIT' });
  assert.equal(calls, 0);
  await store.set(key, 'fixture');
  assert.equal(calls, 1);
});

test('disabled and unsupported native stores fail closed without loading native code', async () => {
  let loads = 0;
  const disabled = await createBrowserOsSecretStore({ dataDir: '/tmp/browser-os-test', allowOsKeyring: false, loadNative: async () => { loads++; } });
  assert.equal(disabled.available, false);
  await assert.rejects(disabled.set(key, 'fixture'), { code: 'BROWSER_SECURE_STORAGE_UNAVAILABLE' });
  const unsupported = await createBrowserOsSecretStore({ dataDir: '/tmp/browser-os-unknown', platform: 'unknown', loadNative: async () => { loads++; } });
  await assert.rejects(unsupported.get(key), { code: 'BROWSER_SECURE_STORAGE_UNAVAILABLE' });
  assert.equal(loads, 0);
});

test('native vault calls time out and queued writes are not replayed after timeout', async () => {
  let release;
  let writes = 0;
  const store = await createBrowserOsSecretStore({ dataDir: '/tmp/browser-os-timeout', platform: 'darwin', timeoutMs: 20, loadNative: async () => ({ AsyncEntry: class {
    async getSecret() { return new Promise((resolve) => { release = resolve; }); }
    async setSecret() { writes++; }
  } }) });
  const get = store.get(key);
  const set = store.set(key, 'fixture');
  await Promise.all([assert.rejects(get, { code: 'BROWSER_SECRET_STORE_TIMEOUT' }), assert.rejects(set, { code: 'BROWSER_SECRET_STORE_TIMEOUT' })]);
  release(undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 0);
});

test('scoped OS vault cleanup leaves unrelated namespaces and other owner stores intact', async () => {
  const fake = backend();
  const store = await createBrowserOsSecretStore({ dataDir: '/tmp/browser-os-cleanup', platform: 'darwin', loadNative: async () => fake.native });
  const accountId = key.slice('browser.password.'.length);
  await store.set(key, 'fixture');
  await store.set('browser.wrapping-key.v1', 'wrapping-fixture');
  await assert.rejects(store.resetBrowser({ accountIds: ['../provider'] }), { code: 'BROWSER_SECRET_NAMESPACE_INVALID' });
  assert.equal(await store.get(key), 'fixture');
  await store.resetBrowser({ accountIds: [accountId] });
  assert.equal(await store.get(key), null);
  assert.equal(await store.get('browser.wrapping-key.v1'), null);
});
