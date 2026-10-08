import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { removeRetiredCloudData } from '../desktop/retired-cloud-data.mjs';
import { createSecretVault } from '../desktop/secret-vault.mjs';

const safeStorage = {
  async isAsyncEncryptionAvailable() { return true; },
  async encryptStringAsync(value) { return Buffer.from(`protected:${value}`); },
  async decryptStringAsync(value) {
    return { shouldReEncrypt: false, result: value.toString().replace(/^protected:/, '') };
  },
};

test('startup removes retired Cloud credentials and files but keeps other secrets and document copies', async (t) => {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-retired-cloud-'));
  t.after(() => fs.rm(userDataDir, { recursive: true, force: true }));
  const filePath = path.join(userDataDir, 'secrets.json');
  const seed = createSecretVault({ filePath, safeStorage });
  await seed.set('cloud.boat.account', 'boat-api-key');
  await seed.set('rhwp.account.session-token', 'session');
  await seed.set('rhwp.rau.openrouter-api-key', 'sk-or-delegated');
  await seed.set('rhwp.pi.api-key', 'sk-or-kept');
  const cloudDir = path.join(userDataDir, 'cloud');
  await fs.mkdir(path.join(cloudDir, 'boat'), { recursive: true });
  await fs.writeFile(path.join(cloudDir, 'boat', 'id_ed25519'), 'private key');
  await fs.writeFile(path.join(cloudDir, 'handoffs.json'), '{}');
  await fs.mkdir(path.join(cloudDir, 'recovery', 'handoff-1'), { recursive: true });
  await fs.writeFile(path.join(cloudDir, 'recovery', 'handoff-1', 'report.hwpx'), 'document');

  // Desktop startup opens a fresh vault, which must not need the OS keyring to purge.
  const vault = createSecretVault({
    filePath,
    safeStorage: { ...safeStorage, async isAsyncEncryptionAvailable() { return false; } },
  });
  await removeRetiredCloudData({ userDataDir, vault });

  const stored = JSON.parse(await fs.readFile(filePath, 'utf8')).secrets;
  assert.deepEqual(Object.keys(stored), ['rhwp.pi.api-key']);
  assert.deepEqual((await fs.readdir(cloudDir)).sort(), ['recovery']);
  assert.equal(
    await fs.readFile(path.join(cloudDir, 'recovery', 'handoff-1', 'report.hwpx'), 'utf8'),
    'document',
  );

  // A second launch finds nothing to remove and leaves the vault file untouched.
  const { ino } = await fs.stat(filePath);
  await removeRetiredCloudData({ userDataDir, vault });
  assert.equal((await fs.stat(filePath)).ino, ino);
  assert.deepEqual(await fs.readdir(cloudDir), ['recovery']);
});

test('startup removes the whole Cloud folder when it holds no document copies', async (t) => {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-retired-cloud-'));
  t.after(() => fs.rm(userDataDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(userDataDir, 'cloud', 'boat'), { recursive: true });
  await fs.writeFile(path.join(userDataDir, 'cloud', 'boat', 'id_ed25519'), 'private key');
  const vault = createSecretVault({ filePath: path.join(userDataDir, 'secrets.json'), safeStorage });

  await removeRetiredCloudData({ userDataDir, vault });

  await assert.rejects(fs.stat(path.join(userDataDir, 'cloud')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(userDataDir, 'secrets.json')), { code: 'ENOENT' });
});
