import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readBookmarkState } from './bookmark-state.mjs';
import { nativePathOwnershipKey, writeNativeFileAtomically } from './native-file-handles.mjs';
import { REBRANDED_STUDIO_SCHEME } from './studio-protocol.mjs';
import { INTERNAL_APP_NAME } from './app-identity.mjs';
import { mergeAgentInstructions } from '../rhwp/rhwp-agent/rebrand-import.mjs';

export { INTERNAL_APP_NAME, PRODUCT_NAME } from './app-identity.mjs';
/** 2.0.11 kept its profile here. Its data is imported, never used live. */
export const REBRANDED_PROFILE_NAME = 'HamaEditor';
export const REBRAND_IMPORT_MARKER = 'rebrand-import.json';
export const REBRAND_SNAPSHOT_PREFIX = 'rauhwpx-rebrand-import-';

const NATIVE_BOOKMARK_FILE = 'native-document-bookmarks.json';
const UNIQUE_INSTALL_FILE = 'unique-install.json';
const MAX_NATIVE_BOOKMARKS = 200;
// Chromium keeps origin-keyed Studio storage here. Caches, GPU state and locks stay behind.
const BROWSER_STORAGE_ENTRIES = ['Local Storage', 'IndexedDB', 'WebStorage', 'QuotaManager', 'QuotaManager-journal'];
const STUDIO_INDEXED_DB_PREFIX = `${REBRANDED_STUDIO_SCHEME}_app_0.indexeddb`;

/**
 * The live profile, and where 2.0.11 may have left one. Development runs use
 * RHWP_DESKTOP_USER_DATA and only import from RHWP_DESKTOP_REBRANDED_USER_DATA.
 */
export function resolveProfileDirectories({ packaged, appDataDir, env = process.env, developmentUserData }) {
  if (packaged) {
    return {
      userData: path.join(appDataDir, INTERNAL_APP_NAME),
      rebranded: path.join(appDataDir, REBRANDED_PROFILE_NAME),
    };
  }
  return {
    userData: env.RHWP_DESKTOP_USER_DATA ? path.resolve(env.RHWP_DESKTOP_USER_DATA) : developmentUserData,
    rebranded: env.RHWP_DESKTOP_REBRANDED_USER_DATA
      ? path.resolve(env.RHWP_DESKTOP_REBRANDED_USER_DATA)
      : null,
  };
}

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function sameDirectory(left, right) {
  try {
    const [a, b] = await Promise.all([fs.realpath(left), fs.realpath(right)]);
    return a === b;
  } catch {
    return false;
  }
}

/**
 * Changes whenever 2.0.11 writes Studio storage again. Null when the folder
 * holds no Studio storage, as when only the 2.0.11 agent hub used it.
 */
export async function browserStorageFingerprint(profileDir) {
  const hash = createHash('sha256');
  let files = 0;
  async function walk(directory, relative) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === 'LOCK') continue;
      const child = path.join(directory, entry.name);
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(child, name);
      } else if (entry.isFile()) {
        const stat = await fs.stat(child);
        hash.update(`${name}:${stat.size}:${Math.trunc(stat.mtimeMs)}\n`);
        files += 1;
      }
    }
  }
  await walk(path.join(profileDir, 'Local Storage'), 'Local Storage');
  for (const entry of await fs.readdir(path.join(profileDir, 'IndexedDB')).catch(() => [])) {
    if (entry.startsWith(STUDIO_INDEXED_DB_PREFIX)) {
      await walk(path.join(profileDir, 'IndexedDB', entry), `IndexedDB/${entry}`);
    }
  }
  await walk(path.join(profileDir, 'WebStorage'), 'WebStorage');
  return files > 0 ? hash.digest('hex') : null;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** A running 2.0.11 could be mid-write; its storage is read on a later launch instead. */
export async function isChromiumProfileInUse(profileDir, {
  platform = process.platform,
  hostname = os.hostname(),
  isProcessAlive = processAlive,
} = {}) {
  if (platform === 'win32') {
    let handle;
    try {
      handle = await fs.open(path.join(profileDir, 'lockfile'), 'r+');
      return false;
    } catch (error) {
      return error?.code === 'EBUSY' || error?.code === 'EPERM' || error?.code === 'EACCES';
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  let target;
  try {
    target = await fs.readlink(path.join(profileDir, 'SingletonLock'));
  } catch {
    return false;
  }
  const separator = target.lastIndexOf('-');
  const host = target.slice(0, separator);
  const pid = Number(target.slice(separator + 1));
  if (separator < 1 || !Number.isSafeInteger(pid) || pid < 1) return false;
  return host === hostname && isProcessAlive(pid);
}

/** Copy only the Studio storage so Chromium can open it without touching the 2.0.11 folder. */
export async function snapshotBrowserStorage(sourceDir, targetDir) {
  await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
  for (const entry of BROWSER_STORAGE_ENTRIES) {
    try {
      await fs.cp(path.join(sourceDir, entry), path.join(targetDir, entry), {
        recursive: true,
        verbatimSymlinks: true,
        filter: (from) => path.basename(from) !== 'LOCK',
      });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return targetDir;
}

/** Snapshots stay open until the app quits, so each launch removes the previous ones. */
export async function removeStaleSnapshots(tempDir, { keep = null } = {}) {
  for (const entry of await fs.readdir(tempDir).catch(() => [])) {
    const full = path.join(tempDir, entry);
    if (!entry.startsWith(REBRAND_SNAPSHOT_PREFIX) || full === keep) continue;
    await fs.rm(full, { recursive: true, force: true }).catch(() => {});
  }
}

export function snapshotDirectory(tempDir) {
  return path.join(tempDir, `${REBRAND_SNAPSHOT_PREFIX}${randomUUID()}`);
}

function parseBookmarks(raw) {
  const entries = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!Array.isArray(item) || typeof item[0] !== 'string' || !item[0]) continue;
    const value = item[1];
    const filePath = typeof value === 'string' ? value : value?.path;
    if (typeof filePath !== 'string' || !filePath) continue;
    entries.push([item[0], typeof value === 'string' ? { path: value, digest: null } : value]);
  }
  return entries;
}

/**
 * Add 2.0.11 bookmarks for files 2.0.10 never opened. A file both versions
 * opened keeps its 2.0.10 document ID; the 2.0.11 ID becomes an alias so its
 * chats and history attach to the same document.
 */
export async function mergeNativeBookmarks({
  sourceDir,
  targetDir,
  platform = process.platform,
  write = (file, bytes) => writeNativeFileAtomically(file, bytes),
}) {
  const incoming = parseBookmarks(await readBookmarkState(path.join(sourceDir, NATIVE_BOOKMARK_FILE)).catch(() => null));
  const documentIdAliases = {};
  if (incoming.length === 0) return { added: 0, documentIdAliases };
  const targetFile = path.join(targetDir, NATIVE_BOOKMARK_FILE);
  const current = parseBookmarks(await readBookmarkState(targetFile));
  const ids = new Set(current.map(([documentId]) => documentId));
  const owners = new Map(current.map(([documentId, value]) => [
    nativePathOwnershipKey(value.path, { platform }),
    documentId,
  ]));
  const merged = [...current];
  let added = 0;
  for (const [documentId, value] of incoming) {
    const owner = owners.get(nativePathOwnershipKey(value.path, { platform }));
    if (owner) {
      if (owner !== documentId) documentIdAliases[documentId] = owner;
      continue;
    }
    if (ids.has(documentId)) continue;
    merged.push([documentId, value]);
    ids.add(documentId);
    owners.set(nativePathOwnershipKey(value.path, { platform }), documentId);
    added += 1;
  }
  if (added > 0) {
    // The registry evicts from the front; keep the newest 200 like it does.
    await write(targetFile, Buffer.from(JSON.stringify(merged.slice(-MAX_NATIVE_BOOKMARKS)), 'utf8'));
  }
  return { added, documentIdAliases };
}

async function copyIfMissing(sourceFile, targetFile) {
  if (await exists(targetFile)) return false;
  let bytes;
  try {
    bytes = await fs.readFile(sourceFile);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  await fs.mkdir(path.dirname(targetFile), { recursive: true });
  await fs.writeFile(targetFile, bytes, { flag: 'wx', mode: 0o644 });
  return true;
}

/**
 * Files 2.0.11 kept in its own profile folder. Secrets stay where they are:
 * 2.0.11 encrypted them with a different Keychain item, so they cannot be
 * moved without the user unlocking it.
 */
export async function importRebrandedProfileFiles({ sourceDir, targetDir, platform = process.platform, write }) {
  const results = {};
  const bookmarks = await mergeNativeBookmarks({ sourceDir, targetDir, platform, write });
  results.bookmarks = bookmarks.added;
  // Keeps the install counted once when someone installed 2.0.11 first.
  results.uniqueInstall = await copyIfMissing(
    path.join(sourceDir, UNIQUE_INSTALL_FILE),
    path.join(targetDir, UNIQUE_INSTALL_FILE),
  );
  results.agentInstructions = (await mergeAgentInstructions(
    path.join(sourceDir, 'agent-instructions'),
    path.join(targetDir, 'agent-instructions'),
  )).reason;
  return { documentIdAliases: bookmarks.documentIdAliases, results };
}

export async function readRebrandImportMarker(userDataDir) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(userDataDir, REBRAND_IMPORT_MARKER), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeRebrandImportMarker(userDataDir, marker, {
  write = (file, bytes) => writeNativeFileAtomically(file, bytes),
} = {}) {
  await write(path.join(userDataDir, REBRAND_IMPORT_MARKER), Buffer.from(`${JSON.stringify(marker, null, 2)}\n`, 'utf8'));
}

/**
 * What this launch should import from the 2.0.11 profile. Files are merged
 * once per change of the 2.0.11 Studio storage; storage is exported only when
 * it changed since the last successful import and 2.0.11 is not running.
 */
export async function planRebrandImport({ userDataDir, rebrandedDir, platform = process.platform, inUse }) {
  if (!rebrandedDir || !await exists(rebrandedDir) || await sameDirectory(userDataDir, rebrandedDir)) {
    return null;
  }
  const marker = await readRebrandImportMarker(userDataDir);
  const fingerprint = await browserStorageFingerprint(rebrandedDir);
  const busy = fingerprint !== null && await (inUse ?? isChromiumProfileInUse)(rebrandedDir, { platform });
  return {
    marker,
    fingerprint,
    importFiles: !marker.filesImportedAt || (fingerprint !== null && marker.storageFingerprint !== fingerprint),
    exportStorage: fingerprint !== null && marker.storageFingerprint !== fingerprint && !busy,
    busy,
  };
}
