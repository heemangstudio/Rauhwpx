import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSecretVault } from '../../../desktop/secret-vault.mjs';
import { isNewerStableVersion, selectDebAsset } from '../../../desktop/update-policy.mjs';

const rootPackage = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
);

function fakeSafeStorage(backend) {
  return {
    async isAsyncEncryptionAvailable() { return true; },
    getSelectedStorageBackend() { return backend; },
    async encryptStringAsync(value) { return Buffer.from(`protected:${value}`); },
    async decryptStringAsync(value) {
      return { shouldReEncrypt: false, result: value.toString().replace(/^protected:/, '') };
    },
  };
}

test('Linux packages register every supported document extension', () => {
  const extensions = (rootPackage.build?.fileAssociations ?? [])
    .flatMap(({ ext }) => Array.isArray(ext) ? ext : [ext]);
  assert.equal(extensions.includes('hwp'), true);
  assert.equal(extensions.includes('hwpx'), true);
  assert.equal(extensions.includes('hml'), true);
});

test('Deb update discovery compares stable versions and selects the native architecture', () => {
  assert.equal(isNewerStableVersion('v0.2.0', '0.1.11'), true);
  assert.equal(isNewerStableVersion('v0.1.11', '0.1.11'), false);
  assert.equal(isNewerStableVersion('v0.2.0-beta.1', '0.1.11'), false);
  const assets = [
    { name: 'HamaEditor-0.2.0-amd64.deb', browser_download_url: 'https://github.com/example/amd64' },
    { name: 'HamaEditor-0.2.0-arm64.deb', browser_download_url: 'https://github.com/example/arm64' },
  ];
  assert.equal(selectDebAsset(assets, 'x64')?.name, assets[0].name);
  assert.equal(selectDebAsset(assets, 'arm64')?.name, assets[1].name);
});

test('Linux secret vault rejects plaintext and unknown storage backends', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-linux-vault-reject-'));
  try {
    for (const backend of ['basic_text', 'unknown', undefined]) {
      const vault = createSecretVault({
        filePath: path.join(root, `${backend ?? 'missing'}.json`),
        safeStorage: fakeSafeStorage(backend),
        platform: 'linux',
      });
      await assert.rejects(
        () => vault.set('rhwp.test', 'secret'),
        /Secret Service or KWallet system keyring/,
      );
    }
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Linux secret vault accepts secure keyrings and locks down persisted ciphertext', async () => {
  for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-linux-vault-secure-'));
    const directory = path.join(root, 'private');
    const filePath = path.join(directory, 'secrets.json');
    try {
      const vault = createSecretVault({
        filePath,
        safeStorage: fakeSafeStorage(backend),
        platform: 'linux',
      });
      await vault.set('rhwp.test', `secret-${backend}`);
      assert.equal(await vault.get('rhwp.test'), `secret-${backend}`);
      assert.doesNotMatch(await fs.readFile(filePath, 'utf8'), new RegExp(`secret-${backend}`));
      if (process.platform !== 'win32') {
        assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
        assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
