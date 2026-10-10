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
/** Planning and the file merge before the first window. */
export const REBRAND_PREPARE_BUDGET_MS = 5_000;

const EXPORT_PAGE = '<!doctype html><meta charset="utf-8"><title>import</title>';

export const REBRAND_EXPORT_TIMEOUT_CODE = 'REBRAND_EXPORT_TIMEOUT';

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { code: REBRAND_EXPORT_TIMEOUT_CODE })), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function timeoutError(message) {
  return Object.assign(new Error(message), { code: REBRAND_EXPORT_TIMEOUT_CODE });
}

/**
 * Reads one part of the copied profile in its own hidden window, so a reader
 * that runs out of memory or crashes only loses that part. Resolves with the
 * part's chunks; rejects when its renderer dies, it reports an error, or the
 * deadline passes.
 */
function readPart({ BrowserWindow, exportSession, preloadPath, query, deadline, windows }) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(timeoutError('2.0.11 storage export ran out of time'));
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      session: exportSession,
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  windows.add(window);
  const chunks = [];
  const reading = new Promise((resolve, reject) => {
    const contents = window.webContents;
    contents.on('render-process-gone', (_event, details) => {
      reject(new Error(`2.0.11 storage reader stopped: ${details?.reason ?? 'unknown'}`));
    });
    contents.ipc.on('rebrand-export:chunk', (_event, chunk) => chunks.push(chunk));
    contents.ipc.once('rebrand-export:done', () => resolve(chunks));
    contents.ipc.once('rebrand-export:error', (_event, message) => reject(new Error(String(message))));
    window.loadURL(`${REBRANDED_STUDIO_SCHEME}://${STUDIO_HOST}/export.html?${query}`).catch(reject);
  });
  return withTimeout(reading, remaining, '2.0.11 storage export timed out').finally(() => {
    windows.delete(window);
    if (!window.isDestroyed()) window.destroy();
  });
}

/**
 * Reads the 2.0.11 Studio storage from a copy of its profile. One hidden window
 * lists Local Storage and the databases; each database is then read in its own
 * window and reported as chunks. A database that fails becomes an `error`
 * chunk and the others still arrive. Rejects only when the copy or the listing
 * fails, or the whole run, copy included, exceeds `timeoutMs`.
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
  const deadline = Date.now() + timeoutMs;
  let cancelled = false;
  let exportSession = null;
  let snapshot = null;
  const windows = new Set();
  const run = (async () => {
    snapshot = snapshotDirectory(tempDir);
    await snapshotBrowserStorage(sourceDir, snapshot);
    if (cancelled) return null;
    exportSession = session.fromPath(snapshot);
    exportSession.protocol.handle(REBRANDED_STUDIO_SCHEME, () => new Response(EXPORT_PAGE, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));
    const part = (query) => readPart({ BrowserWindow, exportSession, preloadPath, query, deadline, windows });
    const index = await part('part=index');
    const databases = index.find((chunk) => chunk?.kind === 'index')?.databases ?? [];
    const chunks = index.filter((chunk) => chunk?.kind !== 'index');
    for (const name of databases) {
      if (cancelled) return null;
      try {
        chunks.push(...await part(`part=database&name=${encodeURIComponent(name)}`));
      } catch (error) {
        // A half-read database is dropped whole; it is read again on a later launch.
        chunks.push({
          kind: 'error',
          database: name,
          message: String(error?.message ?? error),
          timedOut: error?.code === REBRAND_EXPORT_TIMEOUT_CODE,
        });
      }
    }
    return chunks;
  })();
  // A copy that outlives the timeout must not surface as an unhandled rejection.
  run.catch(() => {});
  try {
    return await withTimeout(run, timeoutMs, '2.0.11 storage export timed out');
  } finally {
    cancelled = true;
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    exportSession?.protocol.unhandle(REBRANDED_STUDIO_SCHEME);
    // Windows keeps the session files open until the app quits; the next launch removes them.
    if (snapshot && platform !== 'win32') await rm(snapshot, { recursive: true, force: true }).catch(() => {});
  }
}

function ledgerSize(ledger) {
  if (!ledger || typeof ledger !== 'object') return 0;
  return Object.values(ledger).reduce((total, keys) => total + (Array.isArray(keys) ? keys.length : 0), 0);
}

/** Anything to merge or report. A database that failed to export still needs Studio to count it as a failure. */
function hasStorage(chunks) {
  return chunks.some((chunk) => (
    (chunk?.kind === 'localStorage' && chunk.entries?.length > 0)
    || chunk?.kind === 'database'
    || chunk?.kind === 'error'
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
  prepareBudgetMs = REBRAND_PREPARE_BUDGET_MS,
  exportStorage = exportRebrandedStudioStorage,
}) {
  let pending = Promise.resolve(null);
  let marker = {};
  let handedOut = null;

  async function record(patch) {
    marker = { ...marker, ...patch };
    await writeMarker(userDataDir, marker);
  }

  /**
   * Runs before the first window. Planning and the file merge get `prepareBudgetMs`;
   * past that the window opens and this launch's import is dropped, to be retried
   * on the next launch. The storage export then continues in the background.
   */
  async function prepare() {
    let late = false;
    const work = (async () => {
      await removeStaleSnapshots(tempDir);
      const plan = await planRebrandImport({ userDataDir, rebrandedDir, platform, inUse });
      if (!plan || late) return;
      marker = plan.marker;
      if (plan.busy) log.warn?.('[hamaeditor] 2.0.11 is running; its chats and drafts import on a later launch');
      let documentIdAliases = marker.documentIdAliases ?? {};
      if (plan.importFiles) {
        try {
          const imported = await importFiles({
            sourceDir: rebrandedDir,
            targetDir: userDataDir,
            platform,
            shouldContinue: () => !late,
          });
          if (late) return;
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
          if (!late) log.warn?.('[hamaeditor] 2.0.11 profile file import failed; storage import waits:', error);
          return;
        }
      }
      if (!plan.exportStorage || late) return;
      startExport(plan, documentIdAliases);
    })();
    let timer;
    const budget = new Promise((resolve) => {
      timer = setTimeout(() => resolve('late'), prepareBudgetMs);
    });
    try {
      if (await Promise.race([work.then(() => 'done'), budget]) === 'late') {
        late = true;
        work.catch(() => {});
        log.warn?.('[hamaeditor] 2.0.11 import preparation is slow; it runs again on the next launch');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  function startExport(plan, documentIdAliases) {
    const attempts = marker.storageAttempts?.fingerprint === plan.fingerprint
      ? marker.storageAttempts.count ?? 0
      : 0;
    pending = (async () => {
      const chunks = await exportStorage({
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
      // A slow machine is not a broken profile; only a reader that failed counts toward giving up.
      if (error?.code !== REBRAND_EXPORT_TIMEOUT_CODE) {
        await record({ storageAttempts: { fingerprint: plan.fingerprint, count: attempts + 1 } }).catch(() => {});
      }
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
    // An attempt counts toward giving up only when something failed and nothing moved forward.
    handedOut = null;
    const progressed = ledgerSize(ledger) > ledgerSize(marker.storageLedger);
    const failed = outcome?.aborted !== true;
    const count = progressed ? 0 : current.attempts + (failed ? 1 : 0);
    await record({
      storageLedger: ledger,
      storageAttempts: { fingerprint: current.fingerprint, count },
    });
    log.warn?.('[hamaeditor] 2.0.11 storage import incomplete:', JSON.stringify(outcome?.failures ?? []));
    return false;
  }

  return { prepare, take, chunk, finish };
}
