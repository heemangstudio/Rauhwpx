import assert from 'node:assert/strict';
import { promises as realFs } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recoverReplacedFile, replaceFile, __test as replaceTest } from '../desktop/fs-replace.mjs';
import { createSecretVault } from '../desktop/secret-vault.mjs';

function errorWithCode(code) {
  return Object.assign(new Error(code), { code });
}

function rmFileOnly(filePath, options) {
  if (options?.recursive) throw new Error(`recursive rm is forbidden for ${filePath}`);
  return realFs.rm(filePath, options);
}

function memoryFs(entries, hooks = {}) {
  const files = new Map(entries);
  const fileStat = (filePath) => {
    if (!files.has(filePath)) throw errorWithCode('ENOENT');
    return { isFile: () => true, isDirectory: () => false };
  };
  return {
    files,
    async lstat(filePath) { return fileStat(filePath); },
    async stat(filePath) { return fileStat(filePath); },
    async rename(from, to) {
      await hooks.rename?.(from, to);
      if (!files.has(from)) throw errorWithCode('ENOENT');
      if (files.has(to)) throw errorWithCode('EEXIST');
      files.set(to, files.get(from));
      files.delete(from);
    },
    async rm(filePath) {
      await hooks.rm?.(filePath);
      files.delete(filePath);
    },
  };
}

test('win32 replacement commits even when old-backup cleanup stays locked', async () => {
  const target = 'state.json';
  const temp = 'state.json.tmp';
  const previous = replaceTest.backupPath(target);
  let cleanupLocked = true;
  const fsImpl = memoryFs([[target, 'old'], [temp, 'new']], {
    rm(filePath) {
      if (cleanupLocked && filePath === previous) throw errorWithCode('EPERM');
    },
  });
  const options = { fsImpl, sleep: async () => {} };

  await replaceFile(temp, target, 'win32', options);
  assert.equal(fsImpl.files.get(target), 'new');
  assert.equal(fsImpl.files.get(previous), 'old');

  cleanupLocked = false;
  await recoverReplacedFile(target, 'win32', options);
  assert.equal(fsImpl.files.get(target), 'new');
  assert.equal(fsImpl.files.has(previous), false);
});

test('win32 replacement preserves a deterministic backup after rollback failure', async () => {
  const target = 'state.json';
  const temp = 'state.json.tmp';
  const previous = replaceTest.backupPath(target);
  let commitLocked = true;
  let rollbackLocked = true;
  const fsImpl = memoryFs([[target, 'old'], [temp, 'new']], {
    rename(from, to) {
      if (commitLocked && from === temp && to === target) throw errorWithCode('EPERM');
      if (rollbackLocked && from === previous && to === target) throw errorWithCode('EPERM');
    },
  });
  const options = { fsImpl, sleep: async () => {} };

  await assert.rejects(
    replaceFile(temp, target, 'win32', options),
    (error) => error.code === 'FILE_REPLACE_ROLLBACK_FAILED'
      && error.backupPath === previous
      && error.tempPath === temp,
  );
  assert.equal(fsImpl.files.has(target), false);
  assert.equal(fsImpl.files.get(previous), 'old');
  assert.equal(fsImpl.files.get(temp), 'new');

  commitLocked = false;
  rollbackLocked = false;
  await recoverReplacedFile(target, 'win32', options);
  assert.equal(fsImpl.files.get(target), 'old');
  assert.equal(fsImpl.files.has(previous), false);
});

test('win32 replacement removes its temp file after a successful rollback', async () => {
  const target = 'state.json';
  const temp = 'state.json.tmp';
  const previous = replaceTest.backupPath(target);
  const fsImpl = memoryFs([[target, 'old'], [temp, 'new']], {
    rename(from, to) {
      if (from === temp && to === target) throw errorWithCode('EPERM');
    },
  });

  await assert.rejects(
    replaceFile(temp, target, 'win32', { fsImpl, sleep: async () => {} }),
    (error) => error.code === 'EPERM',
  );
  assert.equal(fsImpl.files.get(target), 'old');
  assert.equal(fsImpl.files.has(previous), false);
  assert.equal(fsImpl.files.has(temp), false);
});

test('win32 replacement removes its temp file when the original stays locked', async () => {
  const target = 'state.json';
  const temp = 'state.json.tmp';
  const previous = replaceTest.backupPath(target);
  const fsImpl = memoryFs([[target, 'old'], [temp, 'new']], {
    rename(from, to) {
      if (from === target && to === previous) throw errorWithCode('EPERM');
    },
  });

  await assert.rejects(
    replaceFile(temp, target, 'win32', { fsImpl, sleep: async () => {} }),
    (error) => error.code === 'EPERM',
  );
  assert.equal(fsImpl.files.get(target), 'old');
  assert.equal(fsImpl.files.has(previous), false);
  assert.equal(fsImpl.files.has(temp), false);
});

test('win32 replacement refuses to move a directory target aside', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-replace-dir-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'fonts.json');
  const temp = path.join(directory, 'fonts.tmp');
  await mkdir(target);
  await writeFile(path.join(target, 'inside.txt'), 'keep');
  await writeFile(temp, 'new');

  await assert.rejects(replaceFile(temp, target, 'win32'), { code: 'EISDIR' });
  assert.equal(await readFile(path.join(target, 'inside.txt'), 'utf8'), 'keep');
  await assert.rejects(access(replaceTest.backupPath(target)), { code: 'ENOENT' });
  assert.equal(await readFile(temp, 'utf8'), 'new');
});

test('win32 replacement recovery does not publish over a restored directory backup', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-replace-dir-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'fonts.json');
  const temp = path.join(directory, 'fonts.tmp');
  const previous = replaceTest.backupPath(target);
  await mkdir(previous);
  await writeFile(path.join(previous, 'inside.txt'), 'keep');
  await writeFile(temp, 'new');

  await assert.rejects(replaceFile(temp, target, 'win32'), { code: 'EISDIR' });
  assert.equal(await readFile(path.join(target, 'inside.txt'), 'utf8'), 'keep');
  await assert.rejects(access(previous), { code: 'ENOENT' });
  assert.equal(await readFile(temp, 'utf8'), 'new');
});

test('win32 replacement restores a directory that appears between lstat and rename', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-replace-dir-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'fonts.json');
  const temp = path.join(directory, 'fonts.tmp');
  const previous = replaceTest.backupPath(target);
  await mkdir(target);
  await writeFile(path.join(target, 'inside.txt'), 'keep');
  await writeFile(temp, 'new');

  const fsImpl = {
    lstat(filePath) {
      if (filePath === target) return Promise.resolve({ isDirectory: () => false, isFile: () => true });
      return realFs.lstat(filePath);
    },
    stat: (...args) => realFs.stat(...args),
    rename: (...args) => realFs.rename(...args),
    rm: rmFileOnly,
  };

  await assert.rejects(
    replaceFile(temp, target, 'win32', { fsImpl, sleep: async () => {} }),
    { code: 'EISDIR' },
  );
  assert.equal(await readFile(path.join(target, 'inside.txt'), 'utf8'), 'keep');
  await assert.rejects(access(previous), { code: 'ENOENT' });
  assert.equal(await readFile(temp, 'utf8'), 'new');
});

test('win32 replacement leaves a raced directory stranded when restore fails', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-replace-dir-stranded-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'fonts.json');
  const temp = path.join(directory, 'fonts.tmp');
  const previous = replaceTest.backupPath(target);
  await mkdir(target);
  await writeFile(path.join(target, 'inside.txt'), 'keep');
  await writeFile(temp, 'new');

  const fsImpl = {
    lstat(filePath) {
      if (filePath === target) return Promise.resolve({ isDirectory: () => false, isFile: () => true });
      return realFs.lstat(filePath);
    },
    stat: (...args) => realFs.stat(...args),
    async rename(from, to) {
      if (from === previous && to === target) throw errorWithCode('EPERM');
      return realFs.rename(from, to);
    },
    rm: rmFileOnly,
  };

  await assert.rejects(
    replaceFile(temp, target, 'win32', { fsImpl, sleep: async () => {} }),
    (error) => error.code === 'FILE_REPLACE_ROLLBACK_FAILED'
      && error.backupPath === previous
      && error.tempPath === temp,
  );
  assert.equal(await readFile(path.join(previous, 'inside.txt'), 'utf8'), 'keep');
  await assert.rejects(access(target), { code: 'ENOENT' });
  assert.equal(await readFile(temp, 'utf8'), 'new');
});

test('win32 replacement restores the target when post-aside lstat fails', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-replace-lstat-fail-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'fonts.json');
  const temp = path.join(directory, 'fonts.tmp');
  const previous = replaceTest.backupPath(target);
  await writeFile(target, 'old');
  await writeFile(temp, 'new');
  let asideDone = false;
  const fsImpl = {
    async lstat(filePath) {
      if (asideDone && filePath === previous) throw errorWithCode('EIO');
      return realFs.lstat(filePath);
    },
    stat: (...args) => realFs.stat(...args),
    async rename(from, to) {
      const result = await realFs.rename(from, to);
      if (from === target && to === previous) asideDone = true;
      return result;
    },
    rm: rmFileOnly,
  };

  await assert.rejects(
    replaceFile(temp, target, 'win32', { fsImpl, sleep: async () => {} }),
    { code: 'EIO' },
  );
  assert.equal(await readFile(target, 'utf8'), 'old');
  await assert.rejects(access(previous), { code: 'ENOENT' });
  assert.equal(await readFile(temp, 'utf8'), 'new');
});

test('win32 replacement reports rollback failure when post-aside lstat restore fails', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-replace-lstat-rollback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'fonts.json');
  const temp = path.join(directory, 'fonts.tmp');
  const previous = replaceTest.backupPath(target);
  await writeFile(target, 'old');
  await writeFile(temp, 'new');
  let asideDone = false;
  const fsImpl = {
    async lstat(filePath) {
      if (asideDone && filePath === previous) throw errorWithCode('EIO');
      return realFs.lstat(filePath);
    },
    stat: (...args) => realFs.stat(...args),
    async rename(from, to) {
      if (asideDone && from === previous && to === target) throw errorWithCode('EPERM');
      const result = await realFs.rename(from, to);
      if (from === target && to === previous) asideDone = true;
      return result;
    },
    rm: rmFileOnly,
  };

  await assert.rejects(
    replaceFile(temp, target, 'win32', { fsImpl, sleep: async () => {} }),
    (error) => error.code === 'FILE_REPLACE_ROLLBACK_FAILED'
      && error.backupPath === previous
      && error.tempPath === temp
      && error.errors[0].code === 'EIO'
      && error.errors[1].code === 'EPERM',
  );
  assert.equal(await readFile(previous, 'utf8'), 'old');
  await assert.rejects(access(target), { code: 'ENOENT' });
  assert.equal(await readFile(temp, 'utf8'), 'new');
});

test('win32 recovery does not recursively delete a leftover directory backup', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-replace-dir-leftover-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'fonts.json');
  const previous = replaceTest.backupPath(target);
  await writeFile(target, 'new');
  await mkdir(previous);
  await writeFile(path.join(previous, 'inside.txt'), 'keep');

  const fsImpl = {
    lstat: (...args) => realFs.lstat(...args),
    stat: (...args) => realFs.stat(...args),
    rename: (...args) => realFs.rename(...args),
    rm: rmFileOnly,
  };

  assert.equal(await recoverReplacedFile(target, 'win32', { fsImpl, sleep: async () => {} }), false);
  assert.equal(await readFile(target, 'utf8'), 'new');
  assert.equal(await readFile(path.join(previous, 'inside.txt'), 'utf8'), 'keep');
});

test('credential startup restores an interrupted win32 persistence backup', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-vault-recover-win32-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'secrets.json');
  const safeStorage = {
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(value) { return Buffer.from(value); },
    async decryptStringAsync(value) { return { result: value.toString(), shouldReEncrypt: false }; },
  };
  const writer = createSecretVault({ filePath, safeStorage, platform: 'win32' });
  await writer.set('rhwp.pi.openrouter-api-key', 'secret');
  await rename(filePath, `${filePath}.previous-write`);

  const recovered = createSecretVault({ filePath, safeStorage, platform: 'win32' });
  assert.equal(await recovered.get('rhwp.pi.openrouter-api-key'), 'secret');
});
