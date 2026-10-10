import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

import {
  importRebrandedProfileFiles,
  planRebrandImport,
  removeStaleSnapshots,
  snapshotBrowserStorage,
  snapshotDirectory,
  writeRebrandImportMarker,
} from './profile-continuity.mjs';
import { REBRANDED_STUDIO_SCHEME, STUDIO_HOST } from './studio-protocol.mjs';

/** Covers the storage copy, the hidden window and the dump. Startup never waits longer. */
export const REBRAND_EXPORT_TIMEOUT_MS = 20_000;

const EXPORT_PAGE = '<!doctype html><meta charset="utf-8"><title>import</title>';

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Reads the 2.0.11 Studio storage from a copy of its profile. A hidden window
 * opens the copy on the 2.0.11 origin; its preload sends the storage as
 * bounded chunks. Rejects when the renderer dies or the whole run, copy
 * included, exceeds `timeoutMs`.
 */
export async function exportRebrandedStudioStorage({
  BrowserWindow,
  session,
  sourceDir,
  tempDir,
  preloadPath,
  timeoutMs = REBRAND_EXPORT_TIMEOUT_MS,
  platform = process.platform,
}) {
  let cancelled = false;
  let window = null;
  let exportSession = null;
  let snapshot = null;
  const run = (async () => {
    snapshot = snapshotDirectory(tempDir);
    await snapshotBrowserStorage(sourceDir, snapshot);
    if (cancelled) return null;
    exportSession = session.fromPath(snapshot);
    exportSession.protocol.handle(REBRANDED_STUDIO_SCHEME, () => new Response(EXPORT_PAGE, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        session: exportSession,
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    const chunks = [];
    return new Promise((resolve, reject) => {
      const contents = window.webContents;
      contents.on('render-process-gone', (_event, details) => {
        reject(new Error(`2.0.11 storage reader stopped: ${details?.reason ?? 'unknown'}`));
      });
      contents.ipc.on('rebrand-export:chunk', (_event, chunk) => chunks.push(chunk));
      contents.ipc.once('rebrand-export:done', () => resolve(chunks));
      contents.ipc.once('rebrand-export:error', (_event, message) => reject(new Error(String(message))));
      window.loadURL(`${REBRANDED_STUDIO_SCHEME}://${STUDIO_HOST}/export.html`).catch(reject);
    });
  })();
  // A copy that outlives the timeout must not surface as an unhandled rejection.
  run.catch(() => {});
  try {
    return await withTimeout(run, timeoutMs, '2.0.11 storage export timed out');
  } finally {
    cancelled = true;
    if (window && !window.isDestroyed()) window.destroy();
    exportSession?.protocol.unhandle(REBRANDED_STUDIO_SCHEME);
    // Windows keeps the session files open until the app quits; the next launch removes them.
    if (snapshot && platform !== 'win32') await rm(snapshot, { recursive: true, force: true }).catch(() => {});
  }
}

function hasStorage(chunks) {
  return chunks.some((chunk) => (
    (chunk?.kind === 'localStorage' && chunk.entries?.length > 0)
    || chunk?.kind === 'database'
  ));
}

/**
 * Owns the 2.0.11 profile import for one launch: files are merged before the
 * hub and bookmarks load, the Studio storage is exported in the background,
 * and the first Studio window pulls it in chunks and reports which records it
 * merged. Progress is kept per record, so a store that failed is retried
 * without bringing back records the user deleted after an earlier import.
 */
export function createRebrandImportController({
  BrowserWindow,
  session,
  userDataDir,
  rebrandedDir,
  tempDir,
  preloadPath,
  platform = process.platform,
  timeoutMs = REBRAND_EXPORT_TIMEOUT_MS,
  log = console,
  importFiles = importRebrandedProfileFiles,
  writeMarker = writeRebrandImportMarker,
  inUse,
}) {
  let pending = Promise.resolve(null);
  let marker = {};
  let handedOut = null;

  async function record(patch) {
    marker = { ...marker, ...patch };
    await writeMarker(userDataDir, marker);
  }

  async function prepare() {
    await removeStaleSnapshots(tempDir);
    const plan = await planRebrandImport({ userDataDir, rebrandedDir, platform, inUse });
    if (!plan) return;
    marker = plan.marker;
    if (plan.busy) log.warn?.('[hamaeditor] 2.0.11 is running; its chats and drafts import on a later launch');
    let documentIdAliases = marker.documentIdAliases ?? {};
    if (plan.importFiles) {
      try {
        const imported = await importFiles({ sourceDir: rebrandedDir, targetDir: userDataDir, platform });
        documentIdAliases = imported.documentIdAliases;
        await record({
          filesImportedFor: plan.filesKey,
          filesImportedAt: new Date().toISOString(),
          documentIdAliases,
        });
        log.log?.('[hamaeditor] imported 2.0.11 profile files:', JSON.stringify(imported.results));
      } catch (error) {
        // Without the merged bookmarks, chats for files both versions opened would attach
        // to the wrong document. Leave the storage for a launch where the files merge.
        log.warn?.('[hamaeditor] 2.0.11 profile file import failed; storage import waits:', error);
        return;
      }
    }
    if (!plan.exportStorage) return;
    const attempts = marker.storageAttempts?.fingerprint === plan.fingerprint
      ? marker.storageAttempts.count ?? 0
      : 0;
    pending = (async () => {
      const chunks = await exportRebrandedStudioStorage({
        BrowserWindow,
        session,
        sourceDir: rebrandedDir,
        tempDir,
        preloadPath,
        timeoutMs,
        platform,
      });
      if (!chunks) return null;
      if (!hasStorage(chunks)) {
        await record({ storageFingerprint: plan.fingerprint, storageImportedAt: new Date().toISOString() });
        return null;
      }
      return { token: randomUUID(), fingerprint: plan.fingerprint, chunks, documentIdAliases, attempts };
    })().catch(async (error) => {
      log.warn?.('[hamaeditor] 2.0.11 storage export failed:', error);
      await record({ storageAttempts: { fingerprint: plan.fingerprint, count: attempts + 1 } }).catch(() => {});
      return null;
    });
  }

  async function take() {
    const current = await pending;
    if (!current || handedOut) return null;
    handedOut = current.token;
    return {
      token: current.token,
      chunkCount: current.chunks.length,
      documentIdAliases: current.documentIdAliases,
      ledger: marker.storageLedger ?? {},
    };
  }

  async function chunk(token, index) {
    const current = await pending;
    if (!current || token !== current.token || token !== handedOut) return null;
    return current.chunks[index] ?? null;
  }

  async function finish(token, outcome) {
    const current = await pending;
    if (!current || typeof token !== 'string' || token !== current.token) return false;
    const ledger = outcome?.ledger && typeof outcome.ledger === 'object' ? outcome.ledger : marker.storageLedger ?? {};
    if (outcome?.complete === true) {
      pending = Promise.resolve(null);
      await record({
        storageLedger: ledger,
        storageFingerprint: current.fingerprint,
        storageImportedAt: new Date().toISOString(),
        storageAttempts: undefined,
      });
      return true;
    }
    // Merged records stay merged; the rest is retried by another window now or a later launch.
    handedOut = null;
    await record({
      storageLedger: ledger,
      storageAttempts: { fingerprint: current.fingerprint, count: current.attempts + 1 },
    });
    log.warn?.('[hamaeditor] 2.0.11 storage import incomplete:', JSON.stringify(outcome?.failures ?? []));
    return false;
  }

  return { prepare, take, chunk, finish };
}
