/**
 * Dragging document-home cards out to other apps as files. A saved document
 * with no pending edits drags its own file. A document with unsaved edits, or a
 * new document that was never saved, is exported by the window that has it open
 * and written to its own temp folder. The temp copy lingers for ten minutes
 * after the drop because the receiving app may read it later (a chat app's send
 * confirmation, an upload that starts on send); leftovers are removed at quit
 * and at the next launch.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { safeSuggestedFilename } from './safe-filename.mjs';

export const DRAG_FILE_LINGER_MS = 10 * 60_000;
/** A drag the renderer never reports as finished (crash, lost pointer) is cleaned up after this. */
export const DRAG_ABANDON_MS = 30 * 60_000;
/**
 * Explorer and most Windows apps cannot read a path longer than MAX_PATH (260
 * UTF-16 units: 259 plus the terminator), so a staged copy keeps its whole path
 * within that.
 */
const MAX_PATH_UNITS = 259;
const MIN_NAME_UNITS = 12;
/** NAME_MAX on macOS and Linux file systems. */
const MAX_NAME_BYTES = 255;
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

const utf8Length = (text) => Buffer.byteLength(text, 'utf8');

/**
 * Shorten a file name so it can be written, keeping its extension and never
 * splitting a surrogate pair. Windows: `folder\name` stays within MAX_PATH,
 * counted in UTF-16 units. macOS and Linux: the name stays within 255 UTF-8
 * bytes, which a long Korean name passes at 86 characters.
 */
export function fitFileNameToPath(folder, fileName, platform = process.platform) {
  const windows = platform === 'win32';
  const budget = windows ? Math.max(MIN_NAME_UNITS, MAX_PATH_UNITS - folder.length - 1) : MAX_NAME_BYTES;
  const size = windows ? (text) => text.length : utf8Length;
  if (size(fileName) <= budget) return fileName;
  const dot = fileName.lastIndexOf('.');
  const extension = dot > 0 && fileName.length - dot <= 16 ? fileName.slice(dot) : '';
  let stem = '';
  for (const character of extension ? fileName.slice(0, dot) : fileName) {
    if (size(stem) + size(character) + size(extension) > budget) break;
    stem += character;
  }
  return `${stem.replace(/[ .]+$/g, '') || 'document'}${extension}`;
}

/**
 * Turn the dragged items into file sources. Each item becomes `{ path }` (the
 * saved file), `{ fileName, bytes, owner }` (an export to stage; `owner` is the
 * other window that has the document open, if any) or a failure named by its
 * file name.
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
      sources[index] = { ...exported, owner };
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
      // Not unref'd: the drag waits on this answer, so it must settle even when nothing else is pending.
      const timer = setTimeout(() => this.#settle(requestId, null), this.#timeoutMs);
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
  /** Staged copy path → the window whose document it is, until the copy is removed. */
  #staged = new Map();

  constructor({ root, lingerMs = DRAG_FILE_LINGER_MS, abandonMs = DRAG_ABANDON_MS }) {
    this.#root = root;
    this.#lingerMs = lingerMs;
    this.#abandonMs = abandonMs;
  }

  get root() {
    return this.#root;
  }

  /**
   * Write exports into their own folders so two files with one name never
   * collide. Folder names are short so the copy keeps as much of its name as
   * MAX_PATH allows.
   */
  async stage(sessionId, sources) {
    const token = randomUUID();
    const folders = [];
    const paths = [];
    const staged = [];
    try {
      for (const source of sources) {
        if (source.path) {
          paths.push(source.path);
          continue;
        }
        const folder = await this.#makeFolder();
        folders.push(folder);
        const path = join(folder, fitFileNameToPath(folder, safeSuggestedFilename(source.fileName, 'document.hwpx')));
        await writeFile(path, source.bytes);
        paths.push(path);
        staged.push([path, source.owner ?? sessionId]);
      }
    } catch (error) {
      await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
      throw error;
    }
    for (const [path, owner] of staged) this.#staged.set(this.#key(path), owner);
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
      for (const path of drag.paths) this.#staged.delete(this.#key(path));
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

  /**
   * A path inside the staging folder is one of our temp copies (or a leftover).
   * Returns `{ owner }`, the window whose document it is while that is known, or
   * null for any other path. Opening a copy would edit a file that is about to be
   * deleted, so a window that receives one sends the user to the owner instead.
   */
  stagedCopy(path) {
    if (typeof path !== 'string' || !path) return null;
    const inside = relative(this.#key(this.#root), this.#key(path));
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null;
    return { owner: this.#staged.get(this.#key(path)) ?? null };
  }

  /** Drop every temp copy (quit, and leftovers at launch). */
  clearSync() {
    for (const drag of this.#drags.values()) clearTimeout(drag.timer);
    for (const timer of this.#removals) clearTimeout(timer);
    this.#drags.clear();
    this.#removals.clear();
    this.#staged.clear();
    try {
      rmSync(this.#root, { recursive: true, force: true });
    } catch {
      // A file still held open by another app is left for the next launch.
    }
  }

  async #makeFolder() {
    await mkdir(this.#root, { recursive: true });
    for (;;) {
      const folder = join(this.#root, randomBytes(4).toString('hex'));
      try {
        await mkdir(folder);
        return folder;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
  }

  /** Windows paths compare without case. */
  #key(path) {
    const absolute = resolve(path);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  }
}
