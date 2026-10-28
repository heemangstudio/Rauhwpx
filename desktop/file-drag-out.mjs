/**
 * Dragging document-home cards out to other apps as files. A saved document
 * with no pending edits drags its own file. A document with unsaved edits, or a
 * new document that was never saved, is exported by the window that has it open
 * and written to its own temp folder. The temp copy lingers for a minute after
 * the drop because the receiving app may read it after the drop; leftovers are
 * removed at quit and at the next launch.
 */
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeSuggestedFilename } from './safe-filename.mjs';

export const DRAG_FILE_LINGER_MS = 60_000;
/** A drag the renderer never reports as finished (crash, lost pointer) is cleaned up after this. */
export const DRAG_ABANDON_MS = 10 * 60_000;
export const DRAG_EXPORT_TIMEOUT_MS = 15_000;
const MAX_DRAG_ITEMS = 64;
const MAX_EXPORT_BYTES = 1024 * 1024 * 1024;
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN_PATTERN = /^[0-9a-f-]{36}$/;

/**
 * Validate the renderer's list. `recent` and `unsaved` name a document by id;
 * `bytes` is a document this window exported itself.
 */
export function normalizeDragItems(input) {
  if (!Array.isArray(input)) return [];
  const items = [];
  for (const item of input.slice(0, MAX_DRAG_ITEMS)) {
    const fileName = typeof item?.fileName === 'string' ? item.fileName.slice(0, 255) : '';
    if (item?.kind === 'bytes') {
      const bytes = item.bytes;
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_EXPORT_BYTES) continue;
      items.push({ kind: 'bytes', fileName, bytes });
    } else if ((item?.kind === 'recent' || item?.kind === 'unsaved')
      && typeof item.documentId === 'string' && DOCUMENT_ID_PATTERN.test(item.documentId)) {
      items.push({ kind: item.kind, documentId: item.documentId, fileName });
    }
  }
  return items;
}

/** An owning window's answer: fresh bytes, `clean` (use the saved file), or null. */
export function normalizeDragExport(result) {
  if (result === 'clean') return 'clean';
  const bytes = result?.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_EXPORT_BYTES) return null;
  return { fileName: typeof result.fileName === 'string' ? result.fileName.slice(0, 255) : '', bytes };
}

/**
 * Turn the dragged items into file sources. Each item becomes `{ path }` (the
 * saved file), `{ fileName, bytes }` (an export to stage) or a failure named by
 * its file name.
 *
 * io.ownerOf(item)      another window's session that has the document open, or null
 * io.exportFrom(owner, documentId)  that window's export (see normalizeDragExport)
 * io.savedPath(documentId)          the saved file's path when it is on disk, or null
 */
export async function collectDragSources(items, io) {
  const sources = [];
  const failed = [];
  await Promise.all(items.map(async (item, index) => {
    if (item.kind === 'bytes') {
      sources[index] = { fileName: item.fileName, bytes: item.bytes };
      return;
    }
    const owner = io.ownerOf(item);
    const exported = owner ? normalizeDragExport(await io.exportFrom(owner, item.documentId).catch(() => null)) : null;
    if (exported && exported !== 'clean') {
      sources[index] = exported;
      return;
    }
    // A new document only exists in the window that made it.
    const path = item.kind === 'recent' ? await io.savedPath(item.documentId).catch(() => null) : null;
    if (path) sources[index] = { path };
    else failed.push(item.fileName || item.documentId);
  }));
  return { sources: sources.filter(Boolean), failed };
}

/** Requests to another window to export its open document, answered over IPC. */
export class DragExportRequests {
  #pending = new Map();
  #timeoutMs;

  constructor({ timeoutMs = DRAG_EXPORT_TIMEOUT_MS } = {}) {
    this.#timeoutMs = timeoutMs;
  }

  /** send(requestId) delivers the request; resolves with the raw answer or null on timeout. */
  request(ownerSessionId, send) {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.#settle(requestId, null), this.#timeoutMs);
      timer.unref?.();
      this.#pending.set(requestId, { ownerSessionId, resolve, timer });
      try {
        send(requestId);
      } catch {
        this.#settle(requestId, null);
      }
    });
  }

  /** Only the window that was asked can answer. */
  reply(fromSessionId, requestId, result) {
    const pending = this.#pending.get(requestId);
    if (!pending || pending.ownerSessionId !== fromSessionId) return false;
    this.#settle(requestId, result);
    return true;
  }

  /** A closed window answers nothing; stop waiting for it. */
  forgetSession(sessionId) {
    for (const [requestId, pending] of this.#pending) {
      if (pending.ownerSessionId === sessionId) this.#settle(requestId, null);
    }
  }

  #settle(requestId, result) {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }
}

/** Staged drags: the files each drag hands to the OS and the temp folders to remove. */
export class FileDragStaging {
  #root;
  #lingerMs;
  #abandonMs;
  #drags = new Map();
  #removals = new Set();

  constructor({ root, lingerMs = DRAG_FILE_LINGER_MS, abandonMs = DRAG_ABANDON_MS }) {
    this.#root = root;
    this.#lingerMs = lingerMs;
    this.#abandonMs = abandonMs;
  }

  get root() {
    return this.#root;
  }

  /** Write exports into their own folders so two files with one name never collide. */
  async stage(sessionId, sources) {
    const token = randomUUID();
    const folders = [];
    const paths = [];
    try {
      for (const source of sources) {
        if (source.path) {
          paths.push(source.path);
          continue;
        }
        const folder = join(this.#root, randomUUID());
        await mkdir(folder, { recursive: true });
        folders.push(folder);
        const path = join(folder, safeSuggestedFilename(source.fileName, 'document.hwpx'));
        await writeFile(path, source.bytes);
        paths.push(path);
      }
    } catch (error) {
      await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
      throw error;
    }
    const timer = setTimeout(() => this.end(sessionId, token, { immediate: true }), this.#abandonMs);
    timer.unref?.();
    this.#drags.set(token, { sessionId, paths, folders, timer });
    return { token, paths };
  }

  pathsFor(sessionId, token) {
    const drag = typeof token === 'string' && TOKEN_PATTERN.test(token) ? this.#drags.get(token) : null;
    return drag?.sessionId === sessionId ? drag.paths : null;
  }

  /**
   * The drag finished (or never started). Temp copies stay for a minute after a
   * drop, since the receiver may still be reading; an unused drag goes at once.
   */
  end(sessionId, token, { immediate = false } = {}) {
    const drag = this.#drags.get(token);
    if (!drag || drag.sessionId !== sessionId) return false;
    this.#drags.delete(token);
    clearTimeout(drag.timer);
    if (!drag.folders.length) return true;
    const remove = () => {
      for (const folder of drag.folders) void rm(folder, { recursive: true, force: true }).catch(() => {});
    };
    if (immediate) {
      remove();
      return true;
    }
    const timer = setTimeout(() => {
      this.#removals.delete(timer);
      remove();
    }, this.#lingerMs);
    timer.unref?.();
    this.#removals.add(timer);
    return true;
  }

  /** Drop every temp copy (quit, and leftovers at launch). */
  clearSync() {
    for (const drag of this.#drags.values()) clearTimeout(drag.timer);
    for (const timer of this.#removals) clearTimeout(timer);
    this.#drags.clear();
    this.#removals.clear();
    try {
      rmSync(this.#root, { recursive: true, force: true });
    } catch {
      // A file still held open by another app is left for the next launch.
    }
  }
}
