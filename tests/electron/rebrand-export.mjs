// Electron entry for desktop-rebrand-export.test.mjs. Builds a real 2.0.11-style
// profile on the hamaeditor://app origin, then runs the export and handoff the
// desktop app uses and prints what it observed as one JSON line.
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, protocol, session } from 'electron';

import { createRebrandImportController } from '../../desktop/rebrand-import-controller.mjs';
import { REBRANDED_STUDIO_SCHEME, registerStudioScheme } from '../../desktop/studio-protocol.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-export-electron-'));
app.setPath('userData', path.join(root, 'electron-user-data'));
registerStudioScheme(protocol);
app.on('window-all-closed', () => {});
const quiet = { log() {}, warn() {} };
const BIG_TEXT_LENGTH = 6 * 1024 * 1024;

async function seedRebrandedProfile(profileDir) {
  const profile = session.fromPath(profileDir);
  profile.protocol.handle(REBRANDED_STUDIO_SCHEME, () => new Response('<!doctype html><title>2.0.11</title>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }));
  const window = new BrowserWindow({ show: false, webPreferences: { session: profile } });
  await window.loadURL(`${REBRANDED_STUDIO_SCHEME}://app/index.html`);
  await window.webContents.executeJavaScript(`(async () => {
    localStorage.setItem('hamaeditor-settings', '{"theme":{"mode":"dark"}}');
    const open = (name, version, upgrade) => new Promise((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = () => upgrade(request.result);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const put = (db, store, rows) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      for (const row of rows) tx.objectStore(store).put(row);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    const threads = await open('hamaeditorAgentThreads', 1, (db) => db.createObjectStore('threads', { keyPath: 'id' }));
    await put(threads, 'threads', [
      { id: 'thread-small', title: 'a', createdAt: 1, updatedAt: 2, agent: 'claude', model: 'sonnet', effort: 'high', messages: [] },
      { id: 'thread-big', title: 'b', createdAt: 1, updatedAt: 2, agent: 'claude', model: 'sonnet', effort: 'high',
        messages: [{ role: 'user', text: 'x'.repeat(${BIG_TEXT_LENGTH}) }] },
    ]);
    threads.close();
    const autosave = await open('hamaeditorAutosave', 3, (db) => {
      db.createObjectStore('drafts', { keyPath: 'id' });
      db.createObjectStore('sessions', { keyPath: 'sessionId' });
      db.createObjectStore('draftMeta', { keyPath: 'id' });
    });
    await put(autosave, 'drafts', [{ id: 'draft-1', fileName: 'a.hwpx', data: new Uint8Array([7, 8, 9]).buffer }]);
    autosave.close();
  })()`);
  await profile.flushStorageData();
  window.destroy();
}

async function controllerFor(name, rebrandedDir, options = {}) {
  await mkdir(path.join(root, name), { recursive: true });
  return createRebrandImportController({
    BrowserWindow,
    session,
    userDataDir: path.join(root, name),
    rebrandedDir,
    tempDir: path.join(root, 'temp'),
    preloadPath: path.join(here, '..', '..', 'desktop', 'rebrand-export-preload.cjs'),
    log: quiet,
    ...options,
  });
}

async function marker(name) {
  try {
    return JSON.parse(await readFile(path.join(root, name, 'rebrand-import.json'), 'utf8'));
  } catch {
    return {};
  }
}

// Top-level await on whenReady would deadlock: Electron emits ready only after this module finishes loading.
app.whenReady().then(async () => {
  const report = {};
  try {
    const profileDir = path.join(root, 'HamaEditor');
    await seedRebrandedProfile(profileDir);

    const normal = await controllerFor('normal', profileDir);
    await normal.prepare();
    const handoff = await normal.take();
    const chunks = [];
    for (let index = 0; index < (handoff?.chunkCount ?? 0); index += 1) chunks.push(await normal.chunk(handoff.token, index));
    const records = chunks.filter((chunk) => chunk?.kind === 'records').flatMap((chunk) => chunk.records);
    const big = records.find((record) => record.key === 'thread-big');
    const draft = records.find((record) => record.key === 'draft-1');
    report.normal = {
      chunkCount: handoff?.chunkCount ?? 0,
      threadChunks: chunks.filter((chunk) => chunk?.kind === 'records' && chunk.store === 'threads').length,
      secondTake: await normal.take(),
      localStorage: chunks.find((chunk) => chunk?.kind === 'localStorage')?.entries ?? [],
      databases: chunks.filter((chunk) => chunk?.kind === 'database').map((chunk) => chunk.name).sort(),
      bigTextLength: big?.value?.messages?.[0]?.text?.length ?? 0,
      draftData: draft ? [Object.prototype.toString.call(draft.value.data), [...new Uint8Array(draft.value.data)]] : null,
      finished: await normal.finish(handoff?.token, { complete: true, ledger: { 'rhwpAgentThreads/threads': ['"thread-small"'] } }),
    };
    report.normal.marker = await marker('normal');
    const again = await controllerFor('normal', profileDir);
    await again.prepare();
    report.normal.nextLaunchTake = await again.take();

    const silent = await controllerFor('silent', profileDir, {
      preloadPath: path.join(here, 'silent-preload.cjs'),
      timeoutMs: 1500,
    });
    let started = Date.now();
    await silent.prepare();
    report.timeout = { take: await silent.take(), elapsedMs: Date.now() - started, marker: await marker('silent') };

    const crashing = await controllerFor('crash', profileDir, {
      preloadPath: path.join(here, 'crashing-preload.cjs'),
      timeoutMs: 15000,
    });
    started = Date.now();
    await crashing.prepare();
    report.crash = { take: await crashing.take(), elapsedMs: Date.now() - started };
  } catch (error) {
    report.error = String(error?.stack ?? error);
  }
  process.stdout.write(`REBRAND_EXPORT_REPORT ${JSON.stringify(report)}\n`);
  await rm(root, { recursive: true, force: true }).catch(() => {});
  app.exit(0);
});
