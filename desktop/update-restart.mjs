import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';

// An update restart reopens every window with its documents. Before the
// installer runs, each window hands over its documents; main records their
// paths in a manifest that the next launch consumes once.
export const UPDATE_RESTART_FILE_NAME = 'update-restart.json';
export const UPDATE_RESTART_MAX_AGE_MS = 30 * 60 * 1000;
// A window may wait on the user (a draft it could not keep) while preparing.
export const UPDATE_PREPARE_TIMEOUT_MS = 60_000;
const MAX_WINDOWS = 64;
const MAX_DOCUMENTS = 200;
const MAX_THREADS = 200;

function text(value, max = 1024) {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

/** A window's answer to a prepare or commit request, or null when it is malformed. */
export function normalizeRestartSlice(slice) {
  if (!slice || typeof slice !== 'object' || slice.ok !== true) return null;
  if (!Array.isArray(slice.documents) || !Array.isArray(slice.continueThreadIds)) return null;
  const documents = [];
  for (const item of slice.documents.slice(0, MAX_DOCUMENTS)) {
    const documentId = text(item?.documentId);
    if (!documentId) return null;
    documents.push({
      documentId,
      handleId: text(item.handleId),
      fileName: typeof item.fileName === 'string' ? item.fileName.slice(0, 512) : '',
      active: item.active === true,
    });
  }
  const continueThreadIds = [...new Set(slice.continueThreadIds.map((id) => text(id, 256)).filter(Boolean))]
    .slice(0, MAX_THREADS);
  return { ok: true, documents, continueThreadIds };
}

/**
 * Hands the restart over to every window in two phases and pairs the answers
 * by request id. Any refusal, malformed answer or timeout aborts the whole
 * restart, and nothing further is sent.
 */
export function createRestartPrepareBroker({
  timeoutMs = UPDATE_PREPARE_TIMEOUT_MS,
  createId = randomUUID,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const pending = new Map();

  function settle(requestId, value) {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    clearTimeoutImpl(entry.timer);
    entry.resolve(value);
    return true;
  }

  async function requestAll(targets, phase) {
    const answers = await Promise.all(targets.map((target) => new Promise((resolve) => {
      const requestId = createId();
      const timer = setTimeoutImpl(() => settle(requestId, { refused: 'timeout' }), timeoutMs);
      pending.set(requestId, { windowId: target.windowId, resolve, timer });
      try {
        target.send(phase, requestId);
      } catch {
        settle(requestId, { refused: 'send' });
      }
    }).then((answer) => ({ windowId: target.windowId, answer }))));
    const slices = new Map();
    for (const { windowId, answer } of answers) {
      if (answer?.closed) continue;
      if (answer?.refused) return { ok: false, reason: `${phase} ${answer.refused}` };
      slices.set(windowId, answer.slice);
    }
    return { ok: true, slices };
  }

  /**
   * targets: [{ windowId, send(phase, requestId), isOpen() }]. Every window
   * first prepares (flushes and may ask the user) without disarming its close
   * prompt. Only when all of them agreed does each prepared window commit: a
   * last flush of edits made since, close prompt disarmed, and the slice to
   * restore. Resolves { ok, slices: Map<windowId, commit slice> }.
   */
  async function handOff(targets) {
    const prepared = await requestAll(targets, 'prepare');
    if (!prepared.ok) return prepared;
    const committing = targets.filter((target) => prepared.slices.has(target.windowId) && target.isOpen?.() !== false);
    return requestAll(committing, 'commit');
  }

  /** The answer must come from the window the request went to. */
  function respond(windowId, requestId, slice) {
    const entry = pending.get(requestId);
    if (!entry || entry.windowId !== windowId) return false;
    const normalized = normalizeRestartSlice(slice);
    return settle(requestId, normalized ? { slice: normalized } : { refused: 'refused' });
  }

  /** A window that closed while preparing has nothing left to restore. */
  function drop(windowId) {
    for (const [requestId, entry] of pending) {
      if (entry.windowId === windowId) settle(requestId, { closed: true });
    }
  }

  return { handOff, respond, drop };
}

/**
 * windows: [{ bounds, maximized, slice, pathForHandle(handleId) }]. A handle
 * that no longer resolves keeps its document with `path: null`, so the next
 * launch still restores its draft.
 */
export function buildRestartManifest({ fromVersion, targetVersion, createdAt, fake = false, windows, logger = console }) {
  return {
    fromVersion,
    targetVersion,
    createdAt,
    ...(fake ? { fake: true } : {}),
    windows: windows.map(({ bounds, maximized, slice, pathForHandle }) => ({
      bounds,
      maximized: maximized === true,
      documents: slice.documents.map((document) => {
        let path = null;
        if (document.handleId) {
          try {
            path = pathForHandle(document.handleId) ?? null;
          } catch (error) {
            logger.warn('[hamaeditor] update restart could not resolve a document path:', error?.message ?? error);
          }
        }
        return { documentId: document.documentId, path, fileName: document.fileName, active: document.active };
      }),
      continueThreadIds: slice.continueThreadIds,
    })),
  };
}

function normalizeBounds(raw) {
  const values = ['x', 'y', 'width', 'height'].map((key) => raw?.[key]);
  if (!values.every(Number.isFinite)) return null;
  const [x, y, width, height] = values.map(Math.round);
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function normalizeManifest(raw, { now }) {
  if (!raw || typeof raw !== 'object') return null;
  const fromVersion = text(raw.fromVersion, 64);
  const targetVersion = text(raw.targetVersion, 64);
  const createdAt = Number(raw.createdAt);
  if (!fromVersion || !targetVersion || !Number.isFinite(createdAt)) return null;
  const age = now - createdAt;
  // A clock that moved backwards by more than a minute makes the age unknowable.
  if (age > UPDATE_RESTART_MAX_AGE_MS || age < -60_000) return null;
  if (!Array.isArray(raw.windows)) return null;
  const windows = raw.windows.slice(0, MAX_WINDOWS).map((window) => {
    const documents = Array.isArray(window?.documents) ? window.documents.slice(0, MAX_DOCUMENTS) : [];
    return {
      bounds: normalizeBounds(window?.bounds),
      maximized: window?.maximized === true,
      documents: documents
        .filter((document) => text(document?.documentId))
        .map((document) => ({
          documentId: document.documentId,
          path: text(document.path, 4096),
          fileName: typeof document.fileName === 'string' ? document.fileName.slice(0, 512) : '',
          active: document.active === true,
        })),
      continueThreadIds: Array.isArray(window?.continueThreadIds)
        ? window.continueThreadIds.map((id) => text(id, 256)).filter(Boolean).slice(0, MAX_THREADS)
        : [],
    };
  });
  return { fromVersion, targetVersion, createdAt, fake: raw.fake === true, windows };
}

/** Reads and deletes the manifest. Returns it only when it is valid and recent. */
export async function consumeRestartManifest(filePath, {
  now = Date.now(),
  readFileImpl = readFile,
  rmImpl = rm,
  logger = console,
} = {}) {
  let raw;
  try {
    raw = await readFileImpl(filePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') logger.warn('[hamaeditor] update restart state unreadable:', error);
    return null;
  }
  try {
    await rmImpl(filePath, { force: true });
  } catch (error) {
    // A manifest that cannot be deleted would restore the same windows on every launch.
    logger.warn('[hamaeditor] update restart state could not be removed:', error);
    return null;
  }
  try {
    return normalizeManifest(JSON.parse(raw), { now });
  } catch {
    return null;
  }
}

/** The restart did not install anything when the app still runs the version it restarted from. */
export function updateWasApplied(manifest, currentVersion) {
  return manifest.fake === true || manifest.fromVersion !== currentVersion;
}

/**
 * The slice served to a relaunched window. `register(path)` creates a handle
 * for the new window session and returns its descriptor, or null when the file
 * is gone or owned elsewhere; the document then restores detached from a file.
 * `restoredDocumentIds` lists the documents of every relaunched window, so the
 * window offering autosave recovery leaves the other windows' drafts alone.
 */
export async function restoreSliceFor(entry, { register, restoredDocumentIds = [], logger = console }) {
  const documents = [];
  for (const document of entry.documents) {
    let file = null;
    if (document.path) {
      try {
        file = await register(document.path);
      } catch (error) {
        logger.warn('[hamaeditor] update restart could not reopen a document:', error?.message ?? error);
      }
    }
    documents.push({ documentId: document.documentId, file: file ?? null, fileName: document.fileName, active: document.active });
  }
  return { documents, continueThreadIds: [...entry.continueThreadIds], restoredDocumentIds: [...restoredDocumentIds] };
}
