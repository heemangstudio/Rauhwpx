import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSecretVault, handleSecretRequest } from '../desktop/secret-vault.mjs';

const accountKey = 'browser.password.3cb5dc5a-8f9b-40a4-9b9d-4a5c61ea7ceb';
function protectedStorage() {
  return {
    isAsyncEncryptionAvailable: async () => true,
    async encryptStringAsync(value) { return Buffer.from(`protected:${value}`); },
    async decryptStringAsync(value) { return { result: value.toString().slice('protected:'.length), shouldReEncrypt: false }; },
  };
}

test('website credentials persist separately and each reset preserves the other namespace', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hama-browser-vault-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'secrets.json');
  const safeStorage = protectedStorage();
  let vault = createSecretVault({ filePath, safeStorage, platform: 'darwin' });
  await vault.set(accountKey, JSON.stringify({ username: 'owned-account', password: 'retained-password' }));
  await vault.set('browser.wrapping-key.v1', 'checkpoint-key');
  await vault.set('provider.api-key', 'provider-value');
  vault = createSecretVault({ filePath, safeStorage, platform: 'darwin' });
  assert.equal(JSON.parse(await vault.get(accountKey)).username, 'owned-account');
  assert.equal((await handleSecretRequest(vault, { type: 'rhwp-secret-request', id: 'provider-reset', operation: 'resetProviders' })).ok, true);
  assert.equal(await vault.get('provider.api-key'), null);
  assert.equal(JSON.parse(await vault.get(accountKey)).password, 'retained-password');
  assert.equal(await vault.get('browser.wrapping-key.v1'), 'checkpoint-key');
  await vault.set('provider.api-key', 'restored-provider');
  assert.equal((await handleSecretRequest(vault, { type: 'rhwp-secret-request', id: 'browser-reset', operation: 'resetBrowser' })).ok, true);
  assert.equal(await vault.get(accountKey), null);
  assert.equal(await vault.get('browser.wrapping-key.v1'), null);
  assert.equal(await vault.get('provider.api-key'), 'restored-provider');
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /retained-password/);
});

test('website namespace rejects unrelated keys and fails closed when OS encryption is unavailable', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hama-browser-vault-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = createSecretVault({ filePath: path.join(root, 'secrets.json'), platform: 'linux', safeStorage: { ...protectedStorage(), getSelectedStorageBackend: () => 'basic_text' } });
  await assert.rejects(() => vault.set('browser.password.not-an-account-id', 'secret'), /Invalid website secret identifier/);
  await assert.rejects(() => vault.set('Browser.password.not-an-account-id', 'secret'), /Invalid website secret identifier/);
  await assert.rejects(() => vault.set(accountKey, 'secret'), /system keyring/);
  await assert.rejects(() => vault.resetBrowser(), /system keyring/);
});

test('user secrets live in their own namespace, leave with browser data and survive a provider reset', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hama-browser-vault-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = createSecretVault({ filePath: path.join(root, 'secrets.json'), safeStorage: protectedStorage(), platform: 'darwin' });
  const userSecret = 'usersecret.9d3c1f7e-2b4a-4c8d-9e1f-0a2b3c4d5e6f';
  await assert.rejects(() => vault.set('usersecret.not-a-uuid', 'value'), /Invalid user secret identifier/);
  await vault.set(userSecret, 'sk-user-fixture');
  await vault.set('provider.api-key', 'provider-value');
  await vault.resetProviders();
  assert.equal(await vault.get(userSecret), 'sk-user-fixture');
  await vault.set('provider.api-key', 'provider-value');
  await vault.resetBrowser();
  assert.equal(await vault.get(userSecret), null);
  assert.equal(await vault.get('provider.api-key'), 'provider-value');
});
