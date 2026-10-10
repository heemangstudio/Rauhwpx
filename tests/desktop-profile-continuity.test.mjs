import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  importRebrandedProfileFiles,
  isChromiumProfileInUse,
  planRebrandImport,
  resolveProfileDirectories,
  snapshotBrowserStorage,
  writeRebrandImportMarker,
} from '../desktop/profile-continuity.mjs';
import {
  REBRAND_EXPORT_TIMEOUT_CODE,
  createRebrandImportController,
} from '../desktop/rebrand-import-controller.mjs';
import {
  REBRANDED_LAUNCH_MARKERS,
  rebrandedRuntimeRoots,
  removeStaleLaunchDirectories,
} from '../desktop/runtime-cleanup.mjs';
import { createSecretVault } from '../desktop/secret-vault.mjs';

async function tempDir(t, label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `rauhwpx-${label}-`));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function write(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

const plainWrite = (file, bytes) => write(file, bytes);

const safeStorage = {
  async isAsyncEncryptionAvailable() { return true; },
  getSelectedStorageBackend() { return 'gnome_libsecret'; },
  async encryptStringAsync(value) { return Buffer.from(`protected:${value}`); },
  async decryptStringAsync(value) {
    return { shouldReEncrypt: false, result: value.toString().replace(/^protected:/, '') };
  },
};

test('the packaged app keeps opening the profile and secrets 2.0.10 wrote', async (t) => {
  const appData = await tempDir(t, 'appdata');
  // 2.0.10 stored an API key under its original vault id in its own profile folder.
  const seeded = createSecretVault({ filePath: path.join(appData, 'Rauhwpx', 'secrets.json'), safeStorage });
  await seeded.set('rhwp.claude.api-key', 'sk-ant-2010');

  const { userData, rebranded } = resolveProfileDirectories({ packaged: true, appDataDir: appData });
  const vault = createSecretVault({ filePath: path.join(userData, 'secrets.json'), safeStorage });
  assert.equal(await vault.get('rhwp.claude.api-key'), 'sk-ant-2010');
  assert.equal(rebranded, path.join(appData, 'HamaEditor'));
});

test('2.0.11 bookmarks join without taking over files 2.0.10 already tracked', async (t) => {
  const root = await tempDir(t, 'bookmarks');
  const source = path.join(root, 'HamaEditor');
  const target = path.join(root, 'Rauhwpx');
  await write(path.join(target, 'native-document-bookmarks.json'), JSON.stringify([
    ['doc-2010', { path: '/Users/a/Report.hwpx', digest: null }],
  ]));
  await write(path.join(source, 'native-document-bookmarks.json'), JSON.stringify([
    ['doc-2011-same', { path: '/users/a/report.hwpx', digest: null }],
    ['doc-2011-new', { path: '/Users/a/New.hwpx', digest: null }],
  ]));
  await write(path.join(source, 'unique-install.json'), '{"installId":"11111111-1111-4111-8111-111111111111","recorded":true}');

  const first = await importRebrandedProfileFiles({ sourceDir: source, targetDir: target, platform: 'darwin', write: plainWrite });
  assert.deepEqual(first.documentIdAliases, { 'doc-2011-same': 'doc-2010' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(target, 'native-document-bookmarks.json'), 'utf8')), [
    ['doc-2010', { path: '/Users/a/Report.hwpx', digest: null }],
    ['doc-2011-new', { path: '/Users/a/New.hwpx', digest: null }],
  ]);
  // A first install of 2.0.11 keeps its install id instead of counting twice.
  assert.match(await fs.readFile(path.join(target, 'unique-install.json'), 'utf8'), /11111111-1111/);

  const again = await importRebrandedProfileFiles({ sourceDir: source, targetDir: target, platform: 'darwin', write: plainWrite });
  assert.deepEqual(again.documentIdAliases, { 'doc-2011-same': 'doc-2010' });
  assert.equal(again.results.bookmarks, 0);
  assert.equal(again.results.uniqueInstall, false);
});

function instructionsMeta(content, revision, updatedAt) {
  return JSON.stringify({
    version: 1,
    revision,
    contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
    updatedAt,
  });
}

test('2.0.11 bookmarks only take free slots so no 2.0.10 file loses its document', async (t) => {
  const root = await tempDir(t, 'bookmarks-full');
  const source = path.join(root, 'HamaEditor');
  const target = path.join(root, 'Rauhwpx');
  const kept = Array.from({ length: 199 }, (_, index) => [`doc-2010-${index}`, { path: `/docs/old-${index}.hwpx`, digest: null }]);
  await write(path.join(target, 'native-document-bookmarks.json'), JSON.stringify(kept));
  await write(path.join(source, 'native-document-bookmarks.json'), JSON.stringify([
    ['doc-2011-a', { path: '/docs/a.hwpx', digest: null }],
    ['doc-2011-b', { path: '/docs/b.hwpx', digest: null }],
    ['doc-2011-c', { path: '/docs/c.hwpx', digest: null }],
  ]));

  await importRebrandedProfileFiles({ sourceDir: source, targetDir: target, write: plainWrite });

  const merged = JSON.parse(await fs.readFile(path.join(target, 'native-document-bookmarks.json'), 'utf8'));
  assert.equal(merged.length, 200);
  assert.deepEqual(merged.slice(0, 199), kept);
  assert.equal(merged[199][0], 'doc-2011-c', 'the newest 2.0.11 bookmark takes the last free slot');
});

test('edited app instructions from 2.0.11 replace an untouched 2.0.10 seed but never a newer edit', async (t) => {
  const root = await tempDir(t, 'instructions');
  const source = path.join(root, 'HamaEditor');
  const target = path.join(root, 'Rauhwpx');
  await write(path.join(target, 'agent-instructions', 'AGENTS.md'), 'seed');
  await write(path.join(target, 'agent-instructions', '.AGENTS.md.meta.json'), instructionsMeta('seed', 1, '2026-09-01T00:00:00.000Z'));
  await write(path.join(source, 'agent-instructions', 'AGENTS.md'), 'always answer in Korean');
  await write(path.join(source, 'agent-instructions', '.AGENTS.md.meta.json'), instructionsMeta('always answer in Korean', 2, '2026-10-09T10:00:00.000Z'));

  await importRebrandedProfileFiles({ sourceDir: source, targetDir: target, write: plainWrite });
  assert.equal(await fs.readFile(path.join(target, 'agent-instructions', 'AGENTS.md'), 'utf8'), 'always answer in Korean');

  // The user edited 2.0.10 later than 2.0.11: that edit stays.
  await write(path.join(target, 'agent-instructions', 'AGENTS.md'), 'cite sources');
  await write(path.join(target, 'agent-instructions', '.AGENTS.md.meta.json'), instructionsMeta('cite sources', 5, '2026-10-10T00:00:00.000Z'));
  await importRebrandedProfileFiles({ sourceDir: source, targetDir: target, write: plainWrite });
  assert.equal(await fs.readFile(path.join(target, 'agent-instructions', 'AGENTS.md'), 'utf8'), 'cite sources');
});

test('2.0.11 Studio storage is exported once per change and never while 2.0.11 runs', async (t) => {
  const root = await tempDir(t, 'plan');
  const source = path.join(root, 'HamaEditor');
  const target = path.join(root, 'Rauhwpx');
  await fs.mkdir(target, { recursive: true });
  const idle = async () => false;

  // Only the 2.0.11 agent hub used the folder: files once, nothing to export.
  await write(path.join(source, 'agent-instructions', 'AGENTS.md'), 'x');
  const hubOnly = await planRebrandImport({ userDataDir: target, rebrandedDir: source, inUse: idle });
  assert.equal(hubOnly.exportStorage, false);
  assert.equal(hubOnly.importFiles, true);

  await write(path.join(source, 'Local Storage', 'leveldb', '000003.log'), 'chat index');
  await write(path.join(source, 'IndexedDB', 'hamaeditor_app_0.indexeddb.leveldb', '000005.ldb'), 'threads');
  const first = await planRebrandImport({ userDataDir: target, rebrandedDir: source, inUse: idle });
  assert.equal(first.exportStorage, true);

  const busy = await planRebrandImport({ userDataDir: target, rebrandedDir: source, inUse: async () => true });
  assert.equal(busy.exportStorage, false);

  await writeRebrandImportMarker(target, {
    filesImportedFor: first.filesKey,
    storageFingerprint: first.fingerprint,
  }, { write: plainWrite });
  const done = await planRebrandImport({ userDataDir: target, rebrandedDir: source, inUse: idle });
  assert.equal(done.exportStorage, false);
  assert.equal(done.importFiles, false);

  // 2.0.11 was opened again and wrote more chats.
  await write(path.join(source, 'IndexedDB', 'hamaeditor_app_0.indexeddb.leveldb', '000006.ldb'), 'more threads');
  const changed = await planRebrandImport({ userDataDir: target, rebrandedDir: source, inUse: idle });
  assert.equal(changed.exportStorage, true);
  assert.equal(changed.importFiles, true, 'new 2.0.11 activity merges its files again');

  assert.equal(await planRebrandImport({ userDataDir: target, rebrandedDir: target }), null);
});

test('the storage snapshot copies Studio storage without locks and leaves the 2.0.11 folder untouched', async (t) => {
  const root = await tempDir(t, 'snapshot');
  const source = path.join(root, 'HamaEditor');
  await write(path.join(source, 'Local Storage', 'leveldb', '000003.log'), 'local');
  await write(path.join(source, 'Local Storage', 'leveldb', 'LOCK'), '');
  await write(path.join(source, 'IndexedDB', 'hamaeditor_app_0.indexeddb.leveldb', '000005.ldb'), 'idb');
  await write(path.join(source, 'Cache', 'Cache_Data', 'data_0'), 'cache');
  const before = await fs.readdir(source, { recursive: true });

  const snapshot = await snapshotBrowserStorage(source, path.join(root, 'snapshot'));
  assert.equal(await fs.readFile(path.join(snapshot, 'Local Storage', 'leveldb', '000003.log'), 'utf8'), 'local');
  assert.equal(await fs.readFile(path.join(snapshot, 'IndexedDB', 'hamaeditor_app_0.indexeddb.leveldb', '000005.ldb'), 'utf8'), 'idb');
  await assert.rejects(fs.stat(path.join(snapshot, 'Local Storage', 'leveldb', 'LOCK')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(snapshot, 'Cache')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(source, { recursive: true }), before);
});

test('a live 2.0.11 process holds its profile lock; a stale lock does not', { skip: process.platform === 'win32' }, async (t) => {
  const root = await tempDir(t, 'lock');
  await fs.symlink(`${os.hostname()}-${process.pid}`, path.join(root, 'SingletonLock'));
  assert.equal(await isChromiumProfileInUse(root), true);
  assert.equal(await isChromiumProfileInUse(root, { isProcessAlive: () => false }), false);
  assert.equal(await isChromiumProfileInUse(root, { hostname: 'another-mac' }), false);
});

test('when the 2.0.11 files cannot merge, its chats wait instead of losing their document links', async (t) => {
  const root = await tempDir(t, 'files-fail');
  const source = path.join(root, 'HamaEditor');
  const target = path.join(root, 'Rauhwpx');
  await fs.mkdir(target, { recursive: true });
  await write(path.join(source, 'IndexedDB', 'hamaeditor_app_0.indexeddb.leveldb', '000005.ldb'), 'threads');
  const opened = [];
  const controller = createRebrandImportController({
    BrowserWindow: function BrowserWindow() { opened.push('window'); },
    session: { fromPath: () => { opened.push('session'); throw new Error('unused'); } },
    userDataDir: target,
    rebrandedDir: source,
    tempDir: path.join(root, 'temp'),
    preloadPath: path.join(root, 'unused.cjs'),
    importFiles: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
    log: { log() {}, warn() {} },
  });

  await controller.prepare();

  assert.equal(await controller.take(), null);
  assert.deepEqual(opened, [], 'the storage export does not start without the merged bookmarks');
  await assert.rejects(fs.stat(path.join(target, 'rebrand-import.json')), { code: 'ENOENT' });
});

test('stale 2.0.11 runtime folders in temp are cleaned unless they still hold a credential copyback', async (t) => {
  const tempRoot = await tempDir(t, 'runtime');
  const runtime = path.join(tempRoot, 'hamaeditor', 'profiles', '0123456789abcdef0123', 'runtime');
  const launch = async (launchId, pid) => {
    const directory = path.join(runtime, launchId);
    await write(path.join(directory, '.hamaeditor-owner.json'), JSON.stringify({
      version: 1, launchId, profileId: '0123456789abcdef0123', pid, createdAtMs: Date.now() - 3 * 24 * 60 * 60 * 1000,
    }));
    return directory;
  };
  const dead = await launch('11111111-1111-4111-8111-111111111111', 424242);
  const alive = await launch('22222222-2222-4222-8222-222222222222', process.pid);
  const pending = await launch('33333333-3333-4333-8333-333333333333', 424242);
  await write(path.join(pending, '.hamaeditor-credential-copybacks', '0123456789abcdef.pending'), 'journal');

  for (const root of await rebrandedRuntimeRoots(tempRoot)) {
    await removeStaleLaunchDirectories(root, 'none', {
      markers: REBRANDED_LAUNCH_MARKERS,
      isAlive: (pid) => pid === process.pid,
    });
  }

  await assert.rejects(fs.stat(dead), { code: 'ENOENT' });
  await fs.stat(alive);
  await fs.stat(pending);
});

test('2.0.11 files merge once per profile state even while its storage waits or keeps failing', async (t) => {
  const root = await tempDir(t, 'files-once');
  const source = path.join(root, 'HamaEditor');
  const target = path.join(root, 'Rauhwpx');
  await fs.mkdir(target, { recursive: true });
  await write(path.join(source, 'IndexedDB', 'hamaeditor_app_0.indexeddb.leveldb', '000005.ldb'), 'threads');
  let fileMerges = 0;
  const launch = (busy) => createRebrandImportController({
    BrowserWindow: function BrowserWindow() { throw new Error('reader unavailable'); },
    session: { fromPath: () => { throw new Error('reader unavailable'); } },
    userDataDir: target,
    rebrandedDir: source,
    tempDir: path.join(root, 'temp'),
    preloadPath: path.join(root, 'unused.cjs'),
    inUse: async () => busy,
    importFiles: async () => {
      fileMerges += 1;
      return { documentIdAliases: { 'doc-2011': 'doc-2010' }, results: {} };
    },
    log: { log() {}, warn() {} },
  });

  for (const busy of [true, true, false, false, false, false, false, false, false]) {
    const controller = launch(busy);
    await controller.prepare();
    await controller.take();
  }

  assert.equal(fileMerges, 1);
  const marker = JSON.parse(await fs.readFile(path.join(target, 'rebrand-import.json'), 'utf8'));
  assert.deepEqual(marker.documentIdAliases, { 'doc-2011': 'doc-2010' }, 'later launches reuse the merged aliases');
});

test('a slow 2.0.11 check never holds the first window past its budget', async (t) => {
  const root = await tempDir(t, 'budget');
  const source = path.join(root, 'HamaEditor');
  const target = path.join(root, 'Rauhwpx');
  await fs.mkdir(target, { recursive: true });
  await write(path.join(source, 'IndexedDB', 'hamaeditor_app_0.indexeddb.leveldb', '000005.ldb'), 'threads');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let wroteAfterBudget = false;
  const controller = createRebrandImportController({
    BrowserWindow: function BrowserWindow() { throw new Error('unused'); },
    session: { fromPath: () => { throw new Error('unused'); } },
    userDataDir: target,
    rebrandedDir: source,
    tempDir: path.join(root, 'temp'),
    preloadPath: path.join(root, 'unused.cjs'),
    prepareBudgetMs: 50,
    inUse: async () => false,
    importFiles: async ({ shouldContinue }) => {
      await sleep(400);
      if (shouldContinue()) wroteAfterBudget = true;
      return { documentIdAliases: {}, results: {} };
    },
    log: { log() {}, warn() {} },
  });

  const started = Date.now();
  await controller.prepare();
  assert.ok(Date.now() - started < 300, `startup waited ${Date.now() - started} ms`);
  assert.equal(await controller.take(), null);
  await sleep(600);
  assert.equal(wroteAfterBudget, false, 'the late merge stops before writing');
  await assert.rejects(fs.stat(path.join(target, 'rebrand-import.json')), { code: 'ENOENT' });
});

test('only failures that made no progress use up the retry budget', async (t) => {
  const sleepless = { log() {}, warn() {} };
  async function scenario(label, launchOnce) {
    const root = await tempDir(t, `budget-${label}`);
    const source = path.join(root, 'HamaEditor');
    const target = path.join(root, 'Rauhwpx');
    await fs.mkdir(target, { recursive: true });
    await write(path.join(source, 'IndexedDB', 'hamaeditor_app_0.indexeddb.leveldb', '000005.ldb'), 'threads');
    const launch = (exportStorage) => createRebrandImportController({
      BrowserWindow: null,
      session: null,
      userDataDir: target,
      rebrandedDir: source,
      tempDir: path.join(root, 'temp'),
      preloadPath: path.join(root, 'unused.cjs'),
      inUse: async () => false,
      importFiles: async () => ({ documentIdAliases: {}, results: {} }),
      exportStorage,
      log: sleepless,
    });
    for (let index = 0; index < 8; index += 1) await launchOnce(launch, index);
    // A ninth launch still exports unless the earlier ones used up the budget.
    let exported = false;
    const last = launch(async () => {
      exported = true;
      return [{ kind: 'localStorage', entries: [['hamaeditor-x', '1']] }];
    });
    await last.prepare();
    await last.take();
    return exported;
  }
  const chunks = [{ kind: 'localStorage', entries: [['hamaeditor-x', '1']] }];

  assert.equal(await scenario('slow-with-progress', async (launch, index) => {
    const controller = launch(async () => chunks);
    await controller.prepare();
    const handoff = await controller.take();
    const keys = Array.from({ length: index + 1 }, (_, position) => `"thread-${position}"`);
    await controller.finish(handoff.token, { complete: false, aborted: true, ledger: { 'rhwpAgentThreads/threads': keys } });
  }), true, 'an import that keeps advancing is never abandoned');

  assert.equal(await scenario('export-timeout', async (launch) => {
    const controller = launch(async () => {
      throw Object.assign(new Error('slow'), { code: REBRAND_EXPORT_TIMEOUT_CODE });
    });
    await controller.prepare();
    await controller.take();
  }), true, 'a slow machine is not a broken profile');

  assert.equal(await scenario('stuck', async (launch) => {
    const controller = launch(async () => chunks);
    await controller.prepare();
    const handoff = await controller.take();
    if (handoff) {
      await controller.finish(handoff.token, { complete: false, aborted: false, failures: ['rhwpStudioAutosave: broken'], ledger: {} });
    }
  }), false, 'a store that fails the same way every time is eventually left alone');
});
