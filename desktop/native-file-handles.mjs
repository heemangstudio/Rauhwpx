import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, open, opendir, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, normalize, win32 } from 'node:path';

import { retryWindows } from './fs-replace.mjs';

const SUPPORTED_EXTENSIONS = new Set(['.hwp', '.hwpx', '.hml', '.rhwpx']);
const PORTABLE_HISTORY_INNER_FILE = 'history';
// Studio writes the original signature. 2.0.11 wrote the second one; its archives stay valid.
const PORTABLE_HISTORY_SIGNATURES = Object.freeze([
  { magic: new TextEncoder().encode('RAUHWPX-HISTORY\0'), format: 'rauhwpx-history' },
  { magic: new TextEncoder().encode('HAMAEDITOR-HISTORY\0'), format: 'hamaeditor-history' },
]);
export const MAX_NATIVE_DOCUMENT_BYTES = 512 * 1024 * 1024;
export const MAX_PORTABLE_HISTORY_BYTES = 128 * 1024 * 1024;
const MAX_PORTABLE_HISTORY_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_PORTABLE_HISTORY_OBJECTS = 50_000;
const NEARBY_DIRECTORY_CAP = 12;
const NEARBY_FILE_CAP = 8;
const NEARBY_DIR_ENTRY_CAP = 256;
/** 문서 홈: 옮겨진 파일을 찾을 때 내용을 해시해 볼 후보의 크기 상한. */
const RELOCATE_CANDIDATE_MAX_BYTES = 64 * 1024 * 1024;
/** 문서 홈: 미리보기용으로 읽는 파일의 크기 상한. */
export const HOME_THUMBNAIL_SOURCE_MAX_BYTES = 24 * 1024 * 1024;
/** 문서 홈: 닿지 않는 네트워크 위치에서 상태 확인이 멈추지 않게 한다. */
const HOME_STAT_TIMEOUT_MS = 1500;
/** 저장 중 남는 임시·복구 파일은 다른 문서의 새 위치 후보가 아니다. */
const TRANSIENT_DOCUMENT_NAME = /\.rauhwpx-(recovery|dacl)|\.target\.rauhwpx-/i;
/** 심볼릭 링크를 따라가지 않고 읽기로 연다. 북마크 경로는 이미 실제 경로다. */
const OPEN_READ_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const CFB_SIGNATURE = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
// Windows refuses fsync on a directory handle with EPERM — same "not
// implemented" class as EINVAL/ENOSYS, not a storage failure.
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM']);
export const NATIVE_FILE_CONFLICT_CODE = 'NATIVE_FILE_CONFLICT';
export const NATIVE_FILE_CONFLICT_MESSAGE = 'This document changed on disk after it was opened. Reopen it before saving.';
export const NATIVE_FILE_ATOMIC_UNSUPPORTED_CODE = 'NATIVE_FILE_ATOMIC_UNSUPPORTED';
export const NATIVE_FILE_ATOMIC_UNSUPPORTED_MESSAGE = 'This filesystem cannot safely publish an atomic document save.';
export const NATIVE_FILE_RECOVERY_REQUIRED_CODE = 'NATIVE_FILE_RECOVERY_REQUIRED';
export const NATIVE_FILE_WRITE_BUSY_CODE = 'NATIVE_FILE_WRITE_BUSY';
export const NATIVE_FILE_READ_ONLY_CODE = 'NATIVE_FILE_READ_ONLY';
export const NATIVE_FILE_READ_ONLY_MESSAGE = 'This document is marked read-only. Save it under a different name.';
export const NATIVE_FILE_IN_USE_CODE = 'NATIVE_FILE_IN_USE';
export const NATIVE_FILE_IN_USE_MESSAGE = 'Another program is using this document. Close it there or wait a moment, then save again.';
export const NATIVE_FILE_ACCESS_DENIED_CODE = 'NATIVE_FILE_ACCESS_DENIED';
export const NATIVE_FILE_ACCESS_DENIED_MESSAGE = 'Windows denied access to this document or its folder. Save it under a different name or in another folder.';
export const NATIVE_FILE_MISSING_CODE = 'NATIVE_FILE_MISSING';
export const NATIVE_FILE_MISSING_MESSAGE = 'This document was moved or deleted after it was opened and could not be found. Nothing was written; save it under a different name.';
export const NATIVE_FILE_UNAVAILABLE_CODE = 'NATIVE_FILE_UNAVAILABLE';
export const NATIVE_FILE_UNAVAILABLE_MESSAGE = 'The drive or network folder that holds this document is not available. Nothing was written; reconnect it, or save under a different name.';
export const NATIVE_FILE_MOVED_INTO_OPEN_CODE = 'NATIVE_FILE_MOVED_INTO_OPEN';
export const NATIVE_FILE_MOVED_INTO_OPEN_MESSAGE = 'This document was renamed to the name of another open document. Nothing was written; close that document or save this one under a different name.';

const WINDOWS_ICACLS_DACL_SUFFIX = '.rauhwpx-dacl';

function startsWithBytes(bytes, signature) {
  return signature.every((value, index) => bytes[index] === value);
}

function byteView(value) {
  if (Buffer.isBuffer(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error('Native file reads require byte data');
}

function nativeFileConflictError() {
  const error = new Error(NATIVE_FILE_CONFLICT_MESSAGE);
  error.code = NATIVE_FILE_CONFLICT_CODE;
  return error;
}

function nativeFileAtomicUnsupportedError(cause = null) {
  const error = new Error(NATIVE_FILE_ATOMIC_UNSUPPORTED_MESSAGE, cause ? { cause } : undefined);
  error.code = NATIVE_FILE_ATOMIC_UNSUPPORTED_CODE;
  return error;
}

function nativeFileRecoveryRequiredError(original, backupPath, restoreErrors) {
  const error = new AggregateError(
    [original, ...restoreErrors],
    `The original document could not be restored automatically. A recovery copy was retained at ${backupPath}`,
    { cause: original },
  );
  error.code = NATIVE_FILE_RECOVERY_REQUIRED_CODE;
  error.recoveryFile = backupPath;
  return error;
}

function nativeFileReadOnlyError() {
  const error = new Error(NATIVE_FILE_READ_ONLY_MESSAGE);
  error.code = NATIVE_FILE_READ_ONLY_CODE;
  return error;
}

function nativeFileMissingError() {
  const error = new Error(NATIVE_FILE_MISSING_MESSAGE);
  error.code = NATIVE_FILE_MISSING_CODE;
  return error;
}

function nativeFileUnavailableError() {
  const error = new Error(NATIVE_FILE_UNAVAILABLE_MESSAGE);
  error.code = NATIVE_FILE_UNAVAILABLE_CODE;
  return error;
}

function nativeFileMovedIntoOpenError() {
  const error = new Error(NATIVE_FILE_MOVED_INTO_OPEN_MESSAGE);
  error.code = NATIVE_FILE_MOVED_INTO_OPEN_CODE;
  return error;
}

/**
 * 다른 프로그램이 문서를 쥐었거나(EBUSY) 쓸 권한이 없어(EPERM, EACCES) 실패한 Windows 저장은
 * 내부 임시 경로 대신 이유를 알린다.
 */
function windowsSharingError(error, platform) {
  if (platform !== 'win32') return error;
  let message;
  let code;
  if (error?.code === 'EBUSY') {
    message = NATIVE_FILE_IN_USE_MESSAGE;
    code = NATIVE_FILE_IN_USE_CODE;
  } else if (error?.code === 'EPERM' || error?.code === 'EACCES') {
    message = NATIVE_FILE_ACCESS_DENIED_MESSAGE;
    code = NATIVE_FILE_ACCESS_DENIED_CODE;
  } else {
    return error;
  }
  const failure = new Error(message, { cause: error });
  failure.code = code;
  return failure;
}

// NTFS allows 255 UTF-16 units per name; APFS and Linux filesystems allow 255
// UTF-8 bytes, so 85 Korean characters already fill one. Clip the document name
// inside helper names under both limits so the suffix always fits.
const HELPER_NAME_STEM_MAX_UNITS = 96;
const HELPER_NAME_STEM_MAX_BYTES = 180;

function clippedName(name) {
  let units = 0;
  let bytes = 0;
  let clipped = '';
  for (const character of name) {
    units += character.length;
    bytes += Buffer.byteLength(character, 'utf8');
    if (units > HELPER_NAME_STEM_MAX_UNITS || bytes > HELPER_NAME_STEM_MAX_BYTES) break;
    clipped += character;
  }
  return clipped;
}

/** CON.hwp, nul.hwpx and the like name a Windows device, not a file, whatever the extension. */
function isWindowsDeviceName(name) {
  const stem = String(name).split('.')[0].replace(/[ ]+$/, '');
  return /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i.test(stem);
}

function shortRandomId() {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

function nativeRecoveryPrefix(filePath) {
  const extension = extname(filePath);
  const name = basename(filePath);
  return `${clippedName(extension ? name.slice(0, -extension.length) : name)}.rauhwpx-recovery-`;
}

function nativeRecoveryPath(filePath) {
  return join(dirname(filePath), `${nativeRecoveryPrefix(filePath)}${shortRandomId()}${extname(filePath)}`);
}

function nativeHelperPath(filePath, suffix) {
  return join(dirname(filePath), `${clippedName(basename(filePath))}.rauhwpx-${shortRandomId()}${suffix}`);
}

/**
 * icacls.exe is not long-path aware even with LongPathsEnabled. The \\?\ form
 * lets it reach documents whose full path passes MAX_PATH.
 */
function windowsCommandPath(filePath) {
  return /^[A-Za-z]:[\\/]/.test(filePath) || /^[\\/]{2}[^\\/?.]/.test(filePath)
    ? win32.toNamespacedPath(filePath)
    : filePath;
}

function statValue(info, key, fallbackKey = null) {
  const value = info?.[key] ?? (fallbackKey ? info?.[fallbackKey] : undefined);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function nativeFileGeneration(info) {
  return JSON.stringify([
    statValue(info, 'dev'),
    statValue(info, 'ino'),
    statValue(info, 'mode'),
    statValue(info, 'nlink'),
    statValue(info, 'uid'),
    statValue(info, 'gid'),
    statValue(info, 'size'),
    statValue(info, 'mtimeNs', 'mtimeMs'),
    statValue(info, 'birthtimeNs', 'birthtimeMs'),
  ]);
}

function nativeFileChangeTime(info) {
  return statValue(info, 'ctimeNs', 'ctimeMs');
}

function contentDigest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** 문서 홈이 옮겨진 파일을 알아보는 내용 표시. 크기와 sha256 은 디스크 지문에서 가져온다. */
function bookmarkContentOf(fingerprint) {
  if (fingerprint?.state !== 'file' || !/^sha256:[0-9a-f]{64}$/.test(fingerprint.digest ?? '')) return null;
  let size = null;
  try {
    const value = JSON.parse(fingerprint.generation)[6];
    size = Number.isSafeInteger(Number(value)) ? Number(value) : null;
  } catch {
    size = null;
  }
  // 크기를 모르면 후보를 좁힐 수 없다. 내용 표시를 남기지 않고 옮겨진 파일도 찾지 않는다.
  if (size === null) return null;
  // 파일 id 와 시각까지 남겨야 이름이 바뀐 파일을 같은 내용의 사본과 가려 찾는다.
  return { contentDigest: fingerprint.digest, size, generation: fingerprint.generation };
}

/** 북마크가 기억한 마지막 파일 상태. 옮겨진 파일을 찾는 기준으로 쓴다. */
function bookmarkFingerprintOf(bookmark) {
  const fingerprint = {
    state: 'file',
    generation: bookmark?.generation,
    changeTime: null,
    digest: bookmark?.contentDigest,
  };
  return isNativeFileFingerprint(fingerprint) ? fingerprint : null;
}

function parseStoredGeneration(value) {
  if (typeof value !== 'string' || value.length > 1024) return null;
  try {
    const fields = JSON.parse(value);
    return Array.isArray(fields)
      && fields.length === 9
      && fields.every((field) => field === null || typeof field === 'string')
      ? value
      : null;
  } catch {
    return null;
  }
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
    }),
  ]);
}

function nativeFileFingerprint(info, digest) {
  return Object.freeze({
    state: 'file',
    generation: nativeFileGeneration(info),
    changeTime: nativeFileChangeTime(info),
    digest,
  });
}

const MISSING_NATIVE_FILE_FINGERPRINT = Object.freeze({ state: 'missing' });

function isNativeFileFingerprint(value) {
  return value?.state === 'missing'
    || (value?.state === 'file'
      && typeof value.generation === 'string'
      && (value.changeTime === null || typeof value.changeTime === 'string')
      && /^sha256:[0-9a-f]{64}$/.test(value.digest));
}

// dev, ino, nlink and birth time in nativeFileGeneration. FAT and exFAT derive
// the file index from the directory entry, so a rename changes ino; deleting a
// stray temp link changes nlink. Windows name tunneling gives a file renamed
// onto a name that was removed in the last 15 s that file's creation time, and
// every save briefly removes the document's name, so renaming it right after a
// save (even only its letter case) changes the birth time. None of these means
// the content changed; size, modification time and the digest still must match.
const MOVED_IDENTITY_FIELDS = new Set([0, 1, 3, 8]);

function movedGenerationFields(generation) {
  try {
    const fields = JSON.parse(generation);
    return Array.isArray(fields)
      ? JSON.stringify(fields.filter((_, index) => !MOVED_IDENTITY_FIELDS.has(index)))
      : null;
  } catch {
    return null;
  }
}

function sameMovedNativeFileFingerprint(left, right) {
  if (
    !isNativeFileFingerprint(left)
    || !isNativeFileFingerprint(right)
    || left.state !== 'file'
    || right.state !== 'file'
    || left.digest !== right.digest
  ) return false;
  if (left.generation === right.generation) return true;
  const leftFields = movedGenerationFields(left.generation);
  return leftFields !== null && leftFields === movedGenerationFields(right.generation);
}

/**
 * Volume serial and file id. NTFS, ReFS and APFS keep both across a rename and
 * a move within the volume, so they still name the file the user is editing
 * after its path stops doing so. A volume that reports no id (some SMB servers
 * report 0) gives null; such files are matched by content instead.
 */
function fileIdentityOfFields(dev, ino) {
  if (typeof dev !== 'string' || typeof ino !== 'string' || !/^\d+$/.test(ino) || /^0+$/.test(ino)) return null;
  return { dev, ino };
}

function fileIdentityOfGeneration(generation) {
  try {
    const fields = JSON.parse(generation);
    return Array.isArray(fields) ? fileIdentityOfFields(fields[0], fields[1]) : null;
  } catch {
    return null;
  }
}

function fileIdentityOfStat(info) {
  return fileIdentityOfFields(statValue(info, 'dev'), statValue(info, 'ino'));
}

function sameFileIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

/**
 * FAT keeps modification times in 2 s units and exFAT in 10 ms units; both give
 * a renamed file a new id. Such a document can only be recognized by content.
 */
function hasCoarseModificationTime(generation) {
  try {
    const value = JSON.parse(generation)?.[7];
    return typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) % 10_000_000n === 0n;
  } catch {
    return false;
  }
}

/** Windows Recycle Bin, macOS and freedesktop trash. A document there was deleted, not moved. */
const TRASH_PATH = /[\\/](?:\$recycle\.bin|\.trash(?:es)?|\.trash-\d+)(?:[\\/]|$)|[\\/]\.local[\\/]share[\\/]trash[\\/]/i;
const MOVED_FILE_DIRECTORY_ENTRY_CAP = 4096;
const MOVED_FILE_SIBLING_FOLDER_CAP = 512;
const MOVED_FILE_CONTENT_CANDIDATE_CAP = 8;
const WINDOWS_FILE_ID_LOOKUP_TIMEOUT_MS = 5_000;
const WINDOWS_FILE_ID_LOOKUP_OUTPUT_CAP = 64 * 1024;

/** The path fsutil prints after "\\?\" (localized text around it is ignored). */
export function parseWindowsFileIdLookupOutput(text) {
  const match = /\\\\\?\\([^\r\n]+)/.exec(String(text ?? ''));
  if (!match) return null;
  const rest = match[1].trimEnd();
  if (/^UNC\\/i.test(rest)) return `\\\\${rest.slice(4)}`;
  return /^[A-Za-z]:\\/.test(rest) ? rest : null;
}

/**
 * Ask Windows where the file with this id now lives on the volume of filePath.
 * A document moved to another folder of the same volume keeps its id, and
 * fsutil answers without elevation. The console is switched to UTF-8 first;
 * otherwise a name outside the console code page comes back with '?'.
 * Resolves null when there is no answer; callers verify any path it returns.
 */
export function lookupWindowsFileIdPath(filePath, fileId, {
  env = process.env,
  spawnImpl = spawn,
  timeoutMs = WINDOWS_FILE_ID_LOOKUP_TIMEOUT_MS,
} = {}) {
  const drive = /^([A-Za-z]):[\\/]/.exec(String(filePath))?.[1];
  const systemRoot = env.SystemRoot ?? env.WINDIR;
  let id;
  try {
    id = BigInt(fileId);
  } catch {
    return Promise.resolve(null);
  }
  if (!drive || id <= 0n || typeof systemRoot !== 'string' || !win32.isAbsolute(systemRoot)) {
    return Promise.resolve(null);
  }
  const system32 = win32.join(systemRoot, 'System32');
  // Only a drive letter and a hex number reach the command line.
  const command = `"chcp 65001 >nul & "${win32.join(system32, 'fsutil.exe')}" file queryFileNameById ${drive.toUpperCase()}:\\ 0x${id.toString(16)}"`;
  const commandEnv = windowsMetadataCommandEnv(systemRoot, env);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(win32.join(system32, 'cmd.exe'), ['/d', '/s', '/c', command], {
        env: commandEnv,
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
    } catch {
      resolve(null);
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      void terminateMetadataCommand(child, { platform: 'win32', env: commandEnv, spawnImpl }).catch(() => {});
      finish(null);
    }, timeoutMs);
    child.stdout?.on?.('data', (chunk) => {
      size += chunk.length;
      if (size <= WINDOWS_FILE_ID_LOOKUP_OUTPUT_CAP) chunks.push(chunk);
    });
    child.once?.('error', () => finish(null));
    child.once?.('close', (code) => {
      finish(code === 0 && size <= WINDOWS_FILE_ID_LOOKUP_OUTPUT_CAP
        ? parseWindowsFileIdLookupOutput(Buffer.concat(chunks).toString('utf8'))
        : null);
    });
  });
}

/**
 * Find the document that was at filePath after it was renamed or moved outside
 * the app. The same volume and file id is the same file. Where ids are missing
 * or change on rename (FAT, exFAT), exactly one file with the same size, times,
 * mode and content stands in for it; two identical copies are not guessed
 * between. Looks in the document's folder, then for a renamed parent folder,
 * then (Windows) across the volume by file id. Never returns trash, recovery
 * or helper files, or a file with another extension. Null when not found.
 */
export async function locateMovedNativeFile(filePath, expectedFingerprint, {
  platform = process.platform,
  readdirImpl = readdir,
  statImpl = stat,
  fingerprintImpl = fingerprintNativeFile,
  lookupFileIdImpl = platform === 'win32' ? lookupWindowsFileIdPath : null,
} = {}) {
  if (expectedFingerprint?.state !== 'file' || !isNativeFileFingerprint(expectedFingerprint)) return null;
  const identity = fileIdentityOfGeneration(expectedFingerprint.generation);
  const movedFields = movedGenerationFields(expectedFingerprint.generation);
  const matchByContent = movedFields !== null
    && (!identity || hasCoarseModificationTime(expectedFingerprint.generation));
  const extension = extname(filePath).toLowerCase();
  const foldCase = platform === 'win32' || platform === 'darwin';
  const pathKey = (value) => (foldCase ? value.toLowerCase() : value);
  const originalKey = pathKey(filePath);
  const contentCandidates = [];
  const seen = new Set();

  const eligible = (candidatePath) => extname(candidatePath).toLowerCase() === extension
    && !TRANSIENT_DOCUMENT_NAME.test(basename(candidatePath))
    && !TRASH_PATH.test(candidatePath)
    && pathKey(candidatePath) !== originalKey;
  const sameFile = async (candidatePath, { contentCandidate = true } = {}) => {
    if (!eligible(candidatePath) || seen.has(pathKey(candidatePath))) return false;
    seen.add(pathKey(candidatePath));
    let info;
    try {
      info = await statImpl(candidatePath, { bigint: true });
    } catch {
      return false;
    }
    if (!info?.isFile?.()) return false;
    if (identity && sameFileIdentity(identity, fileIdentityOfStat(info))) return true;
    if (
      contentCandidate
      && matchByContent
      && movedGenerationFields(nativeFileGeneration(info)) === movedFields
    ) {
      contentCandidates.push(candidatePath);
    }
    return false;
  };

  const directory = dirname(filePath);
  let names = null;
  try {
    names = await readdirImpl(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') names = [];
  }
  if (names) {
    for (const name of names.slice(0, MOVED_FILE_DIRECTORY_ENTRY_CAP)) {
      const candidatePath = join(directory, String(name));
      if (await sameFile(candidatePath)) return { path: candidatePath, via: 'file-id' };
    }
  } else {
    // The document's folder is gone. If it was renamed, the document keeps its
    // own name in one of the sibling folders.
    const parent = dirname(directory);
    if (parent !== directory) {
      let folders = [];
      try {
        folders = await readdirImpl(parent, { withFileTypes: true });
      } catch {
        folders = [];
      }
      for (const folder of folders.slice(0, MOVED_FILE_SIBLING_FOLDER_CAP)) {
        if (typeof folder !== 'string' && typeof folder?.isDirectory === 'function' && !folder.isDirectory()) continue;
        const name = typeof folder === 'string' ? folder : folder?.name;
        if (typeof name !== 'string' || !name) continue;
        const candidatePath = join(parent, name, basename(filePath));
        if (await sameFile(candidatePath)) return { path: candidatePath, via: 'parent-folder' };
      }
    }
  }

  // An unplugged drive has no volume to ask.
  const volumeRoot = platform === 'win32' ? win32.parse(filePath).root : '';
  const volumePresent = Boolean(volumeRoot)
    && await statImpl(volumeRoot).then((info) => info?.isDirectory?.() === true, () => false);
  if (identity && lookupFileIdImpl && volumePresent) {
    let found = null;
    try {
      found = await lookupFileIdImpl(filePath, identity.ino);
    } catch {
      found = null;
    }
    if (typeof found === 'string' && found && await sameFile(found, { contentCandidate: false })) {
      return { path: found, via: 'volume' };
    }
  }

  if (contentCandidates.length === 0 || contentCandidates.length > MOVED_FILE_CONTENT_CANDIDATE_CAP) return null;
  const matches = [];
  for (const candidatePath of contentCandidates) {
    let fingerprint;
    try {
      fingerprint = await fingerprintImpl(candidatePath);
    } catch {
      continue;
    }
    if (sameMovedNativeFileFingerprint(expectedFingerprint, fingerprint)) matches.push(candidatePath);
  }
  return matches.length === 1 ? { path: matches[0], via: 'content' } : null;
}

function waitForCommandExit(child, timeoutMs, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      child.off?.('exit', onExit);
      child.off?.('close', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimer(() => finish(false), timeoutMs);
    child.once?.('exit', onExit);
    child.once?.('close', onExit);
  });
}

async function terminateMetadataCommand(child, {
  platform,
  env,
  spawnImpl,
  finalGraceMs = 5_000,
}) {
  if (child.exitCode != null || child.signalCode != null) return true;
  const pid = Number(child.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot ?? env.WINDIR;
    if (typeof systemRoot !== 'string' || !win32.isAbsolute(systemRoot)) return false;
    let killer;
    try {
      killer = spawnImpl(
        win32.join(systemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(pid), '/T', '/F'],
        { env, shell: false, stdio: 'ignore', windowsHide: true },
      );
    } catch {
      return false;
    }
    const [taskkillExited, childExited] = await Promise.all([
      waitForCommandExit(killer, finalGraceMs),
      waitForCommandExit(child, finalGraceMs),
    ]);
    if (!taskkillExited) {
      try { killer.kill?.('SIGKILL'); } catch {}
    }
    return taskkillExited && killer.exitCode === 0 && childExited;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') return false;
  }
  const childExited = await waitForCommandExit(child, finalGraceMs);
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return childExited && error?.code === 'ESRCH';
  }
}

export function runNativeMetadataCommand(command, args, {
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  timeoutMs = platform === 'win32' ? 15_000 : 120_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        detached: platform !== 'win32',
        env,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let timedOut = false;
    let timer = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimer(timer);
      child.off?.('error', onError);
      child.off?.('exit', onExit);
      child.off?.('close', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => finish(error);
    const onExit = (code, signal) => {
      if (timedOut) return;
      if (code === 0) {
        finish();
        return;
      }
      const error = new Error(`Metadata copy command failed (${command}, code=${code ?? 'none'}, signal=${signal ?? 'none'})`);
      error.code = 'NATIVE_FILE_METADATA_COPY_FAILED';
      finish(error);
    };
    child.once?.('error', onError);
    child.once?.('exit', onExit);
    child.once?.('close', onExit);
    timer = setTimer(() => {
      timedOut = true;
      void terminateMetadataCommand(child, { platform, env, spawnImpl })
        .then((cleaned) => {
          const error = new Error(`Metadata copy command timed out (${command})`);
          error.code = 'NATIVE_FILE_METADATA_COPY_TIMEOUT';
          if (!cleaned) error.processCleanupUncertain = true;
          finish(error);
        }, (cause) => {
          const error = new Error(`Metadata copy command cleanup failed (${command})`, { cause });
          error.code = 'NATIVE_FILE_METADATA_COPY_TIMEOUT';
          error.processCleanupUncertain = true;
          finish(error);
        });
    }, timeoutMs);
  });
}

function windowsMetadataCommandEnv(systemRoot, sourceEnv = process.env) {
  const system32 = win32.join(systemRoot, 'System32');
  const env = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: win32.join(system32, 'cmd.exe'),
    PATH: system32,
    PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC',
  };
  if (systemRoot.length >= 2 && systemRoot[1] === ':') {
    env.SystemDrive = systemRoot.slice(0, 2);
  }
  if (typeof sourceEnv?.PATHEXT === 'string' && sourceEnv.PATHEXT) {
    env.PATHEXT = sourceEnv.PATHEXT;
  }
  if (typeof sourceEnv?.ComSpec === 'string' && win32.isAbsolute(sourceEnv.ComSpec)) {
    env.ComSpec = sourceEnv.ComSpec;
  }
  return env;
}

export function readIcaclsSavedDacl(buffer) {
  const payload = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
    ? buffer.subarray(2)
    : buffer;
  const dacl = payload.toString('utf16le').split(/\r?\n/)[1]?.trim();
  if (!dacl?.startsWith('D:')) {
    const error = new Error('icacls save file did not contain a DACL entry');
    error.code = 'NATIVE_FILE_METADATA_COPY_FAILED';
    throw error;
  }
  return dacl;
}

// FileSecurity persists only the sections it changed, so applying the DACL
// needs WRITE_DAC on the temp file and no SeRestorePrivilege. Plain .NET calls
// skip cmdlet module autoloading, which takes 20+ s with the pinned env.
const WINDOWS_SET_DACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$security = [System.Security.AccessControl.FileSecurity]::new()',
  "$security.SetSecurityDescriptorSddlForm($env:RAUHWPX_DACL_SDDL, 'Access')",
  '[System.IO.File]::SetAccessControl($env:RAUHWPX_DACL_TARGET, $security)',
].join('; ');
// CLR startup stalls without these, even with -NoProfile. PATH and
// PSModulePath stay pinned so a user-writable entry cannot load a module.
const WINDOWS_POWERSHELL_ENV_KEYS = Object.freeze([
  'TEMP',
  'TMP',
  'USERNAME',
  'USERDOMAIN',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'ProgramData',
  'ProgramFiles',
]);

async function readSavedDacl(aclFile) {
  try {
    return readIcaclsSavedDacl(await readFile(aclFile));
  } catch (error) {
    // Test doubles that succeed without writing a save file still allow the
    // replace to proceed. A real icacls /save that exits 0 creates this file.
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function copyWindowsDacl(
  sourcePath,
  temporaryPath,
  runCommandImpl,
  systemRoot = process.env.SystemRoot ?? process.env.WINDIR,
  sourceEnv = process.env,
  metadataDirectory = tmpdir(),
) {
  if (typeof systemRoot !== 'string' || !win32.isAbsolute(systemRoot)) {
    const error = new Error('Windows system root is unavailable for DACL preservation');
    error.code = 'NATIVE_FILE_METADATA_COPY_FAILED';
    throw error;
  }
  const icacls = win32.join(systemRoot, 'System32', 'icacls.exe');
  const env = windowsMetadataCommandEnv(systemRoot, sourceEnv);
  const options = { platform: 'win32', env };
  // Keep the save files short and away from the document: icacls cannot write
  // one whose path passes MAX_PATH, and a deep document folder gets there fast.
  const saveId = shortRandomId();
  const sourceAclFile = join(metadataDirectory, `rauhwpx-${saveId}${WINDOWS_ICACLS_DACL_SUFFIX}`);
  const temporaryAclFile = join(metadataDirectory, `rauhwpx-${saveId}.target${WINDOWS_ICACLS_DACL_SUFFIX}`);
  try {
    await runCommandImpl(icacls, [windowsCommandPath(sourcePath), '/save', sourceAclFile, '/q'], options);
    const sourceDacl = await readSavedDacl(sourceAclFile);
    if (sourceDacl === null) return;
    await runCommandImpl(icacls, [windowsCommandPath(temporaryPath), '/save', temporaryAclFile, '/q'], options);
    // Most documents carry only entries inherited from their folder, and the
    // temp file beside them already inherits the same ones.
    if (sourceDacl === await readSavedDacl(temporaryAclFile)) return;
    // icacls /restore demands SeRestorePrivilege, which standard and
    // non-elevated users lack (exit 1300), so apply the DACL directly.
    const powershellHome = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
    const powershellEnv = {
      ...env,
      PSModulePath: win32.join(powershellHome, 'Modules'),
      RAUHWPX_DACL_SDDL: sourceDacl,
      RAUHWPX_DACL_TARGET: windowsCommandPath(temporaryPath),
    };
    for (const key of WINDOWS_POWERSHELL_ENV_KEYS) {
      const value = sourceEnv?.[key];
      if (typeof value === 'string' && value) powershellEnv[key] = value;
    }
    await runCommandImpl(
      win32.join(powershellHome, 'powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(WINDOWS_SET_DACL_SCRIPT, 'utf16le').toString('base64'),
      ],
      { ...options, env: powershellEnv },
    );
  } finally {
    await rm(sourceAclFile, { force: true }).catch(() => {});
    await rm(temporaryAclFile, { force: true }).catch(() => {});
  }
}

/**
 * Capture a bounded content hash and file-generation token from one opened
 * file. A path swap or in-place mutation during the read is a conflict.
 */
export async function fingerprintNativeFile(
  filePath,
  {
    openImpl = open,
    statImpl = stat,
  } = {},
) {
  let handle;
  try {
    try {
      handle = await openImpl(filePath, 'r');
    } catch (error) {
      if (error?.code === 'ENOENT') return MISSING_NATIVE_FILE_FINGERPRINT;
      throw error;
    }
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw nativeFileConflictError();
    const size = Number(before.size);
    const maxBytes = nativeDocumentMaxBytes(filePath);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      throw nativeDocumentSizeError(maxBytes);
    }

    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(Math.max(size, 1), 1024 * 1024));
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, size - offset),
        offset,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, offset);
    const after = await handle.stat({ bigint: true });
    const pathInfo = await statImpl(filePath, { bigint: true });
    if (
      offset !== size
      || extraBytes !== 0
      || !after.isFile()
      || !pathInfo.isFile()
      || nativeFileGeneration(before) !== nativeFileGeneration(after)
      || nativeFileGeneration(after) !== nativeFileGeneration(pathInfo)
      || nativeFileChangeTime(before) !== nativeFileChangeTime(after)
      || nativeFileChangeTime(after) !== nativeFileChangeTime(pathInfo)
    ) {
      throw nativeFileConflictError();
    }
    return nativeFileFingerprint(after, `sha256:${hash.digest('hex')}`);
  } catch (error) {
    if (error?.code === 'ENOENT') throw nativeFileConflictError();
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function hasValidHmlPreamble(bytes) {
  if (bytes.byteLength < 16) return false;
  const prefixLength = Math.min(bytes.byteLength, 64 * 1024);
  const evenPrefixLength = prefixLength - (prefixLength % 2);
  let text;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      text = new TextDecoder('utf-16le').decode(bytes.subarray(2, evenPrefixLength));
    } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      text = new TextDecoder('utf-16be').decode(bytes.subarray(2, evenPrefixLength));
    } else {
      text = new TextDecoder('utf-8').decode(bytes.subarray(0, prefixLength));
    }
  } catch {
    return false;
  }
  return /^\s*(?:<\?xml[\s\S]{0,2048}?\?>\s*)?<HWPML(?:\s|>)/i.test(text);
}

function hasValidZipDirectory(bytes) {
  if (bytes.byteLength < 22) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumOffset = Math.max(0, bytes.byteLength - 65_557);
  let eocdOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === bytes.byteLength) {
        eocdOffset = offset;
        break;
      }
    }
  }
  if (eocdOffset < 0) return false;

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const directoryDisk = view.getUint16(eocdOffset + 6, true);
  const diskEntries = view.getUint16(eocdOffset + 8, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const directorySize = view.getUint32(eocdOffset + 12, true);
  const directoryOffset = view.getUint32(eocdOffset + 16, true);
  if (diskNumber !== 0 || directoryDisk !== 0 || totalEntries === 0 || diskEntries !== totalEntries) {
    return false;
  }
  if (directoryOffset + directorySize !== eocdOffset || directorySize < 46) return false;
  return directoryOffset + 4 <= bytes.byteLength
    && view.getUint32(directoryOffset, true) === 0x02014b50;
}

function hasValidPortableHistoryLayout(bytes, signature, manifestLength) {
  const prefixLength = signature.magic.byteLength + 4;
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(prefixLength, prefixLength + manifestLength),
    ));
  } catch {
    return false;
  }
  if (
    !manifest
    || typeof manifest !== 'object'
    || manifest.format !== signature.format
    || manifest.version !== 1
    || !manifest.document
    || typeof manifest.document !== 'object'
    || !manifest.repository
    || typeof manifest.repository !== 'object'
    || !Array.isArray(manifest.objects)
    || manifest.objects.length === 0
    || manifest.objects.length > MAX_PORTABLE_HISTORY_OBJECTS
  ) return false;

  const payloadOffset = prefixLength + manifestLength;
  const descriptors = [...manifest.objects].sort((left, right) => left?.offset - right?.offset);
  let expectedOffset = 0;
  for (const descriptor of descriptors) {
    if (
      !descriptor
      || (descriptor.kind !== 'blob' && descriptor.kind !== 'compare-snapshot')
      || typeof descriptor.id !== 'string'
      || descriptor.id.length === 0
      || !Number.isSafeInteger(descriptor.offset)
      || descriptor.offset < 0
      || !Number.isSafeInteger(descriptor.byteLength)
      || descriptor.byteLength < 0
      || descriptor.offset !== expectedOffset
      || payloadOffset + descriptor.offset + descriptor.byteLength > bytes.byteLength
    ) return false;
    expectedOffset += descriptor.byteLength;
  }
  return payloadOffset + expectedOffset === bytes.byteLength;
}

function isCfbV4Package(bytes) {
  return bytes.byteLength >= 3 * 4096
    && bytes.byteLength % 4096 === 0
    && startsWithBytes(bytes, CFB_SIGNATURE)
    && bytes[26] === 4 && bytes[27] === 0
    && bytes[28] === 0xfe && bytes[29] === 0xff
    && bytes[30] === 12 && bytes[31] === 0;
}

/**
 * Check a document that is about to be opened, not written. Other CFB writers
 * emit major version 4 (4096-byte sectors), which the publish check accepts;
 * only rhwp's own save output is held to the v3 layout.
 */
export function validateOpenedDocumentBytes(filePath, bytes) {
  if (extname(filePath).toLowerCase() === '.hwp' && bytes instanceof Uint8Array && isCfbV4Package(bytes)) return;
  try {
    validateNativeDocumentBytes(filePath, bytes);
  } catch (error) {
    throw new Error(`The document cannot be opened because its data is invalid or incomplete (${extname(filePath).slice(1).toUpperCase()})`, { cause: error });
  }
}

/** Reject obviously truncated or format-mismatched output before replacing a real document. */
export function validateNativeDocumentBytes(filePath, bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('Native file writes require byte data');
  const extension = extname(filePath).toLowerCase();
  const maxBytes = extension === '.rhwpx'
    ? MAX_PORTABLE_HISTORY_BYTES
    : MAX_NATIVE_DOCUMENT_BYTES;
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new Error('Refusing to replace a document with empty or oversized data');
  }
  if (extension === '.rhwpx') {
    const signature = PORTABLE_HISTORY_SIGNATURES.find(({ magic }) => (
      bytes.byteLength >= magic.byteLength + 4 && startsWithBytes(bytes, magic)
    ));
    const manifestLength = signature
      ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        .getUint32(signature.magic.byteLength, true)
      : 0;
    if (
      !signature
      || manifestLength === 0
      || manifestLength > MAX_PORTABLE_HISTORY_MANIFEST_BYTES
      || signature.magic.byteLength + 4 + manifestLength > bytes.byteLength
      || !hasValidPortableHistoryLayout(bytes, signature, manifestLength)
    ) {
      throw new Error('Refusing to replace an RHWPX file with an invalid or truncated history archive');
    }
  } else if (extension === '.hwp') {
    // The in-process writer always emits CFB v3: a 512-byte header followed by
    // whole 512-byte sectors. This catches empty/truncated/wrong-format IPC
    // payloads before they can replace the previous document.
    const valid = bytes.byteLength >= 1536
      && (bytes.byteLength - 512) % 512 === 0
      && startsWithBytes(bytes, CFB_SIGNATURE)
      && bytes[28] === 0xfe && bytes[29] === 0xff
      && bytes[30] === 9 && bytes[31] === 0;
    if (!valid) throw new Error('Refusing to replace an HWP file with an invalid or truncated CFB package');
  } else if (extension === '.hwpx') {
    if (!startsWithBytes(bytes, new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
      || !hasValidZipDirectory(bytes)) {
      throw new Error('Refusing to replace an HWPX file with an invalid or truncated ZIP package');
    }
  } else if (extension === '.hml') {
    if (!hasValidHmlPreamble(bytes)) {
      throw new Error('Refusing to replace an HML file with invalid or truncated XML');
    }
  }
}

async function syncParentDirectory(filePath, platform) {
  // Directory fsync makes the rename durable on POSIX. Windows does not allow
  // opening directories this way; the temporary file itself is still fsynced.
  if (platform === 'win32') return;
  let directory;
  try {
    directory = await open(dirname(filePath), 'r');
    await directory.sync();
  } catch (error) {
    // Some filesystems do not implement directory fsync. Real storage errors
    // still make the write fail because the rename may not be durable.
    if (!UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error?.code)) throw error;
  } finally {
    await directory?.close().catch(() => {});
  }
}

export function nativePathOwnershipKey(filePath, { platform = process.platform } = {}) {
  // APFS treats NFC and NFD spellings as one name. NTFS does not: a 보고서.hwpx
  // unzipped from a Mac archive (NFD) can sit beside the NFC one as a separate
  // file, and folding them would point a Save As at the open original.
  if (platform === 'win32') return String(filePath).toLocaleLowerCase('en-US');
  const normalized = String(filePath).normalize('NFC');
  return platform === 'darwin' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

// Codes a link probe returns on volumes without hard links: exFAT/FAT USB
// drives (ENOTSUP on macOS, EPERM on Linux vfat) and SMB/NFS shares that
// refuse links (EOPNOTSUPP, ENOSYS, EINVAL). libuv maps Windows
// ERROR_INVALID_FUNCTION, which CreateHardLink returns on FAT, to EISDIR.
const HARD_LINK_UNSUPPORTED_CODES = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS', 'EINVAL']);

export function hardLinksUnsupported(error, platform) {
  return HARD_LINK_UNSUPPORTED_CODES.has(error?.code)
    || (platform === 'win32' && error?.code === 'EISDIR');
}

/**
 * The new bytes are already at filePath, but the save cannot be reported as
 * complete. The registry adopts publishedFingerprint so the next save is
 * compared against the bytes that really are on disk.
 */
function publishedWriteError(error, publishedFingerprint) {
  let failure = error;
  if (!(failure instanceof Error) || !Object.isExtensible(failure)) {
    failure = new Error(error?.message ?? String(error), { cause: error });
    if (error?.code) failure.code = error.code;
  }
  failure.published = true;
  failure.publishedFingerprint = publishedFingerprint;
  return failure;
}

export async function writeNativeFileAtomically(
  filePath,
  bytes,
  {
    platform = process.platform,
    openImpl = open,
    copyFileImpl = copyFile,
    linkImpl = link,
    lstatImpl = lstat,
    renameImpl = rename,
    rmImpl = rm,
    statImpl = stat,
    syncParentImpl = syncParentDirectory,
    fingerprintImpl = fingerprintNativeFile,
    runCommandImpl = runNativeMetadataCommand,
    windowsSystemRoot = process.env.SystemRoot ?? process.env.WINDIR,
    windowsProcessEnv = process.env,
    metadataDirectory = tmpdir(),
    expectedFingerprint,
    sleep,
    logger = console,
  } = {},
) {
  const temporaryPath = nativeHelperPath(filePath, '.tmp');
  // Keep the real document extension so a recovery copy left by a power loss
  // remains visible and openable in the platform file picker.
  const backupPath = nativeRecoveryPath(filePath);
  const linkProbePath = nativeHelperPath(filePath, '.link-probe');
  let temporaryFile;
  let backupMoved = false;
  let linkProbeCreated = false;
  let publishByRename = false;
  try {
    let sourceInfo = null;
    try {
      sourceInfo = await statImpl(filePath, { bigint: true });
      if (!sourceInfo.isFile()) throw nativeFileConflictError();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    // CopyFile carries FILE_ATTRIBUTE_READONLY onto the temp, whose r+ open
    // then fails with an EPERM that names the temp. Say why instead.
    if (platform === 'win32' && sourceInfo && (Number(sourceInfo.mode) & 0o200) === 0) {
      throw nativeFileReadOnlyError();
    }
    const effectiveExpectedFingerprint = expectedFingerprint
      ?? await fingerprintImpl(filePath);
    if (!isNativeFileFingerprint(effectiveExpectedFingerprint)) {
      throw new Error('Native file write received an invalid expected fingerprint');
    }

    if ((platform === 'darwin' || platform === 'win32') && sourceInfo) {
      if (platform === 'darwin') {
        // macOS cp -p preserves ACLs, extended attributes, resource forks,
        // flags, and POSIX metadata. clonefile mode omits ACLs on some APFS
        // releases, so do not use cp -c here.
        await runCommandImpl('/bin/cp', ['-p', filePath, temporaryPath]);
      } else {
        // libuv uses the Windows CopyFile API. It retains EFS, compression,
        // alternate streams, extended attributes, and file attributes.
        // Antivirus, indexers and sync clients open documents exclusively for
        // a moment, so a sharing violation here is retried like the renames.
        await retryWindows(async () => {
          try {
            await copyFileImpl(filePath, temporaryPath, constants.COPYFILE_EXCL);
          } catch (error) {
            await rmImpl(temporaryPath, { force: true }).catch(() => {});
            throw error;
          }
        }, platform, sleep).catch((error) => {
          throw error?.code === 'ENOENT' ? nativeFileConflictError() : windowsSharingError(error, platform);
        });
      }
      // A scanner may also open the fresh copy for a moment.
      temporaryFile = await retryWindows(() => openImpl(temporaryPath, 'r+'), platform, sleep)
        .catch((error) => { throw windowsSharingError(error, platform); });
      await temporaryFile.truncate(0);
    } else {
      temporaryFile = await openImpl(temporaryPath, 'wx');
    }
    await temporaryFile.writeFile(bytes);

    if (sourceInfo && platform !== 'win32') {
      await temporaryFile.chmod(Number(sourceInfo.mode) & 0o7777);
    }

    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;

    if (sourceInfo && platform === 'win32') {
      // Copy only the DACL, after the temp handle is closed. icacls /save
      // reads DACL entries, not owner or SACL.
      try {
        await copyWindowsDacl(
          filePath,
          temporaryPath,
          runCommandImpl,
          windowsSystemRoot,
          windowsProcessEnv,
          metadataDirectory,
        );
      } catch (error) {
        // icacls cannot save the DACL of a source that was deleted or moved
        // while the copy was prepared; that is the same concurrent change the
        // rename-aside below would report, not a metadata failure.
        if (error?.code !== 'NATIVE_FILE_METADATA_COPY_FAILED') throw error;
        const sourceGone = await statImpl(filePath, { bigint: true })
          .then(() => false, (statError) => statError?.code === 'ENOENT');
        if (sourceGone) throw nativeFileConflictError();
        throw error;
      }
    }

    try {
      await linkImpl(temporaryPath, linkProbePath);
      linkProbeCreated = true;
    } catch (error) {
      // Volumes without hard links still support an atomic rename. Other probe
      // failures (EIO, EACCES) mean the folder cannot be written safely.
      if (!hardLinksUnsupported(error, platform)) throw nativeFileAtomicUnsupportedError(error);
      publishByRename = true;
    }
    if (linkProbeCreated) {
      try {
        await rmImpl(linkProbePath, { force: true });
        linkProbeCreated = false;
      } catch (error) {
        throw nativeFileAtomicUnsupportedError(error);
      }
    }

    if (effectiveExpectedFingerprint.state === 'file') {
      try {
        await retryWindows(() => renameImpl(filePath, backupPath), platform, sleep);
      } catch (error) {
        if (error?.code === 'ENOENT') throw nativeFileConflictError();
        // Another editor (Hancom, Word) holding the document without
        // FILE_SHARE_DELETE blocks the rename for as long as it stays open.
        throw windowsSharingError(error, platform);
      }
      backupMoved = true;
      const movedFingerprint = await retryWindows(() => fingerprintImpl(backupPath), platform, sleep);
      // Renaming the target changes ctime on POSIX, and the file id on FAT and
      // exFAT. Mode, size, mtime, birth time, and content digest must match.
      if (!sameMovedNativeFileFingerprint(effectiveExpectedFingerprint, movedFingerprint)) {
        throw nativeFileConflictError();
      }
    }
    if (publishByRename) {
      // rename() replaces an existing destination, so first check that
      // nothing took the path after the rename-aside compare.
      let destinationTaken = true;
      try {
        await lstatImpl(filePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        destinationTaken = false;
      }
      if (destinationTaken) throw nativeFileConflictError();
      await retryWindows(() => renameImpl(temporaryPath, filePath), platform, sleep);
    } else {
      try {
        // A hard link publishes the prepared inode only while the destination
        // is absent. If an editor or sync client creates a new path after the
        // rename-aside compare, EEXIST turns the save into a conflict.
        await linkImpl(temporaryPath, filePath);
      } catch (error) {
        if (error?.code === 'EEXIST') throw nativeFileConflictError();
        throw nativeFileAtomicUnsupportedError(error);
      }
    }
  } catch (error) {
    const restoreErrors = [];
    await temporaryFile?.close().catch(() => {});
    if (linkProbeCreated) {
      await rmImpl(linkProbePath, { force: true }).catch(() => {});
    }
    if (backupMoved) {
      try {
        await linkImpl(backupPath, filePath);
        await rmImpl(backupPath, { force: true });
        backupMoved = false;
      } catch (restoreError) {
        try {
          // COPYFILE_EXCL is the non-overwriting rollback for filesystems
          // without hard links, or whose support changed after the probe. It
          // is also worth retrying after EEXIST because a sync client may
          // remove its conflicting path between these two exclusive operations.
          await copyFileImpl(backupPath, filePath, constants.COPYFILE_EXCL);
          await rmImpl(backupPath, { force: true });
          backupMoved = false;
        } catch (copyError) {
          // Never infer that an unrelated file which appeared at the target
          // supersedes the generation we moved aside. If neither exclusive
          // restore can publish it, retain that last known-good document and
          // surface its exact recovery path.
          restoreErrors.push(restoreError, copyError);
        }
        // Other restore failures retain the moved file for manual recovery.
      }
    }
    if (!error?.processCleanupUncertain) {
      // A scanner still reading the temp would otherwise leave a full copy of
      // the document beside it.
      await retryWindows(() => rmImpl(temporaryPath, { force: true }), platform, sleep).catch(() => {});
    }
    if (backupMoved) {
      throw nativeFileRecoveryRequiredError(error, backupPath, restoreErrors);
    }
    throw error;
  }

  // Published: filePath now holds the new bytes. A cleanup failure must not
  // turn this into a failed save, or the registry keeps the old fingerprint
  // and every later save to this document reports a conflict.
  if (!publishByRename) {
    await retryWindows(() => rmImpl(temporaryPath, { force: true }), platform, sleep)
      .catch((error) => logger?.warn?.('[native-save] temporary link cleanup failed:', error));
  }
  let durabilityError = null;
  try {
    await syncParentImpl(filePath, platform);
  } catch (error) {
    // The new bytes are visible, but the rename may not survive a power loss.
    // Report it and keep the recovery copy of the previous document.
    durabilityError = error;
  }
  if (!durabilityError && backupMoved) {
    try {
      await retryWindows(() => rmImpl(backupPath, { force: true }), platform, sleep);
      await syncParentImpl(filePath, platform);
    } catch (error) {
      logger?.warn?.('[native-save] recovery copy cleanup failed:', error);
    }
  }
  let publishedFingerprint = null;
  let fingerprintError = null;
  try {
    // Stat after cleanup so nlink counts a temp link that could not be removed.
    const savedInfo = await statImpl(filePath, { bigint: true });
    if (savedInfo.isFile()) {
      publishedFingerprint = nativeFileFingerprint(savedInfo, contentDigest(bytes));
    } else {
      fingerprintError = nativeFileConflictError();
    }
  } catch (error) {
    fingerprintError = error;
  }
  if (durabilityError) throw publishedWriteError(durabilityError, publishedFingerprint);
  if (!publishedFingerprint) throw publishedWriteError(fingerprintError, null);
  return publishedFingerprint;
}

/**
 * A save moves the document aside before it publishes the new bytes. If the
 * process dies in between (crash, End task, power loss), the path is empty and
 * the last complete version sits beside it under its recovery name. Put the
 * newest valid one back, the same rollback a failed save performs in-process.
 * Returns true when the path was restored.
 */
export async function recoverInterruptedNativeSave(
  filePath,
  {
    platform = process.platform,
    readdirImpl = readdir,
    statImpl = stat,
    lstatImpl = lstat,
    linkImpl = link,
    renameImpl = rename,
    rmImpl = rm,
    sleep,
    logger = console,
  } = {},
) {
  try {
    await lstatImpl(filePath);
    return false;
  } catch (error) {
    if (error?.code !== 'ENOENT') return false;
  }
  const directory = dirname(filePath);
  const foldCase = platform === 'win32' || platform === 'darwin';
  const fold = (value) => (foldCase ? value.toLowerCase() : value);
  const prefix = fold(nativeRecoveryPrefix(filePath));
  const extension = fold(extname(filePath));
  let names;
  try {
    names = await readdirImpl(directory);
  } catch {
    return false;
  }
  const candidates = [];
  for (const name of names) {
    const folded = fold(String(name));
    if (!folded.startsWith(prefix) || !folded.endsWith(extension)) continue;
    const candidatePath = join(directory, String(name));
    const info = await statImpl(candidatePath).catch(() => null);
    // The recovery copy is the original renamed whole, so any non-empty one
    // is complete. Hancom's own files need not match the writer's CFB layout.
    if (info?.isFile?.() && Number(info.size) > 0) {
      candidates.push({ path: candidatePath, mtimeMs: Number(info.mtimeMs) || 0 });
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const [newest] = candidates;
  if (!newest) return false;
  try {
    // Never overwrite a file that appeared in the meantime.
    try {
      await linkImpl(newest.path, filePath);
      await retryWindows(() => rmImpl(newest.path, { force: true }), platform, sleep).catch(() => {});
    } catch (error) {
      if (error?.code === 'EEXIST' || !hardLinksUnsupported(error, platform)) throw error;
      if (await lstatImpl(filePath).then(() => true, () => false)) return false;
      await retryWindows(() => renameImpl(newest.path, filePath), platform, sleep);
    }
    logger?.warn?.('[native-save] restored an interrupted save from', newest.path);
    return true;
  } catch (error) {
    logger?.warn?.('[native-save] could not restore an interrupted save:', error);
    return false;
  }
}

function isPortableHistoryBundleName(filePath) {
  return extname(filePath).toLowerCase() === '.rhwpx';
}

function nativeDocumentMaxBytes(filePath) {
  return isPortableHistoryBundleName(filePath)
    ? MAX_PORTABLE_HISTORY_BYTES
    : MAX_NATIVE_DOCUMENT_BYTES;
}

function nativeDocumentSizeError(maxBytes) {
  return new Error(`The selected document is empty or exceeds the ${maxBytes / 1024 / 1024} MiB limit`);
}

export async function readPortableHistoryBytes(
  targetPath,
  {
    readFileImpl = readFile,
    statImpl = stat,
    openImpl = readFileImpl === readFile && statImpl === stat ? open : null,
  } = {},
) {
  const maxBytes = nativeDocumentMaxBytes(targetPath);
  let targetInfo;
  try {
    targetInfo = await statImpl(targetPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (!openImpl) {
      const bytes = byteView(await readFileImpl(targetPath));
      if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
        throw nativeDocumentSizeError(maxBytes);
      }
      return byteView(bytes);
    }
    targetInfo = null;
  }
  let sourcePath = targetPath;
  let sourceInfo = targetInfo;
  if (targetInfo?.isDirectory()) {
    if (!isPortableHistoryBundleName(targetPath)) {
      throw new Error('Only RHWPX folders can be imported as legacy history bundles');
    }
    sourcePath = join(targetPath, PORTABLE_HISTORY_INNER_FILE);
    sourceInfo = await statImpl(sourcePath);
  }
  if (sourceInfo && !sourceInfo.isFile()) {
    throw new Error('The selected document is not a regular file');
  }
  if (sourceInfo && (
    !Number.isSafeInteger(sourceInfo.size)
    || sourceInfo.size <= 0
    || sourceInfo.size > maxBytes
  )) {
    throw nativeDocumentSizeError(maxBytes);
  }
  if (openImpl) {
    let handle;
    try {
      handle = await openImpl(sourcePath, 'r');
      const openedInfo = await handle.stat();
      if (!openedInfo.isFile()) throw new Error('The selected document is not a regular file');
      if (
        !Number.isSafeInteger(openedInfo.size)
        || openedInfo.size <= 0
        || openedInfo.size > maxBytes
      ) {
        throw nativeDocumentSizeError(maxBytes);
      }
      const bytes = Buffer.allocUnsafe(openedInfo.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          bytes.byteLength - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const extra = Buffer.allocUnsafe(1);
      const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, offset);
      if (offset !== bytes.byteLength || extraBytes !== 0) {
        throw new Error('The selected document changed while it was being read');
      }
      return byteView(bytes);
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  const bytes = byteView(await readFileImpl(sourcePath));
  if (bytes.byteLength !== sourceInfo.size || bytes.byteLength > maxBytes) {
    throw new Error('The selected document changed while it was being read');
  }
  return bytes;
}

export function validateNativeDocumentPath(filePath, { platform = process.platform } = {}) {
  const absolute = typeof filePath === 'string'
    && (platform === 'win32' ? win32.isAbsolute(filePath) : isAbsolute(filePath));
  if (!absolute) {
    throw new Error('Native document paths must be absolute');
  }
  if (!SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase())) {
    throw new Error('Only HWP, HWPX, HML, and RHWPX files can be opened');
  }
  return filePath;
}

export async function canonicalNativePath(
  filePath,
  {
    platform = process.platform,
    resolveRealPath = realpath,
    allowMissing = false,
    recoverInterruptedSave = resolveRealPath === realpath ? recoverInterruptedNativeSave : null,
  } = {},
) {
  validateNativeDocumentPath(filePath, { platform });
  let resolved;
  try {
    resolved = await resolveRealPath(filePath);
  } catch (error) {
    if (
      error?.code === 'ENOENT'
      && !allowMissing
      && await recoverInterruptedSave?.(filePath, { platform })
    ) {
      resolved = await resolveRealPath(filePath);
      validateNativeDocumentPath(resolved, { platform });
      return platform === 'win32' ? win32.normalize(resolved) : normalize(resolved);
    }
    if (!allowMissing || error?.code !== 'ENOENT') throw error;
    const parent = await resolveRealPath(dirname(filePath));
    resolved = join(parent, basename(filePath));
  }
  validateNativeDocumentPath(resolved, { platform });
  return platform === 'win32' ? win32.normalize(resolved) : normalize(resolved);
}

/**
 * 이미 놓았거나 이번 실행에서 만든 적 없는 핸들. 닫은 문서나 지난 실행의 최근 문서가 들고 있는
 * 옛 핸들이 흔히 이렇다. 다른 창이 쥔 핸들과 달리 접근 위반이 아니라 "더는 없음"이다.
 */
export class StaleNativeHandleError extends Error {
  constructor() {
    super('Native file handle is no longer available');
    this.name = 'StaleNativeHandleError';
  }
}

export class NativeFileHandleRegistry {
  #byId = new Map();
  #byPath = new Map();
  /**
   * 창마다 문서를 놓은 횟수(닫힘·렌더러 종료). 열기가 끝나기 전에 늘면 그 열기는 쥐지 않는다.
   * 크래시 뒤 같은 창이 다시 열 수 있게 집합이 아니라 횟수로 센다.
   */
  #sessionReleases = new Map();
  #bookmarks = new Map();
  #probes = new Map();
  #canonicalize;
  #ownershipKey;
  #createId;
  #readFile;
  #writeFile;
  #openDir;
  #stat;
  #digest;
  #fingerprint;
  #openFile;
  #recoverInterruptedSave;
  #locateMoved;
  #renameFile;
  #moveLeases;
  #onEntriesMoved;
  #platform;

  constructor({
    canonicalize = canonicalNativePath,
    ownershipKey = nativePathOwnershipKey,
    createId = randomUUID,
    readFileImpl = readFile,
    writeFileImpl = writeNativeFileAtomically,
    openDirImpl = opendir,
    statImpl = stat,
    digestImpl = null,
    fingerprintImpl = fingerprintNativeFile,
    openFileImpl = open,
    recoverInterruptedSaveImpl = statImpl === stat ? recoverInterruptedNativeSave : null,
    // Following a moved document needs the real filesystem. Doubles that fake
    // paths or fingerprints keep the fixed-path behavior unless they opt in.
    locateMovedImpl = statImpl === stat
      && canonicalize === canonicalNativePath
      && fingerprintImpl === fingerprintNativeFile
      ? locateMovedNativeFile
      : null,
    renameImpl = rename,
    platform = process.platform,
    /** Move the window's document claims with a followed rename. May throw to refuse it. */
    moveLeases = null,
    /** Told after a document was found under a new path. */
    onEntriesMoved = null,
  } = {}) {
    this.#canonicalize = canonicalize;
    this.#ownershipKey = ownershipKey;
    this.#createId = createId;
    this.#readFile = readFileImpl;
    this.#writeFile = writeFileImpl;
    this.#openDir = openDirImpl;
    this.#stat = statImpl;
    this.#digest = digestImpl;
    this.#fingerprint = fingerprintImpl;
    this.#openFile = openFileImpl;
    this.#recoverInterruptedSave = recoverInterruptedSaveImpl;
    this.#locateMoved = locateMovedImpl;
    this.#renameFile = renameImpl;
    this.#platform = platform;
    this.#moveLeases = moveLeases;
    this.#onEntriesMoved = onEntriesMoved;
  }

  async create(sessionId, filePath, { allowMissing = false } = {}) {
    const releases = this.#sessionReleases.get(sessionId) ?? 0;
    const canonicalPath = await this.#canonicalize(filePath, { allowMissing });
    let legacyPortableHistoryFolder = false;
    if (isPortableHistoryBundleName(canonicalPath)) {
      try {
        const info = await this.#stat(canonicalPath);
        if (info.isDirectory()) {
          if (allowMissing) {
            throw new Error('Legacy RHWPX folders are import-only; choose a file destination');
          }
          legacyPortableHistoryFolder = true;
        } else if (!info.isFile()) {
          throw new Error('The selected document is not a regular file');
        }
      } catch (error) {
        if (!allowMissing || error?.code !== 'ENOENT') throw error;
      }
    }
    const ownershipPath = this.#ownershipKey(canonicalPath);
    // A document renamed outside the app leaves its handle on the old name. A
    // new file with that name is not the open document, so let the handle
    // follow its own file before treating the path as taken.
    const existing = await this.#settledHolder(ownershipPath);
    if (existing && existing.sessionId !== sessionId) {
      return { ok: false, ownerSessionId: existing.sessionId };
    }
    if (existing) {
      // Re-acquiring a handle cancels a pending release; otherwise the handle
      // would silently vanish once the in-flight write that pinned it finishes.
      existing.releaseRequested = false;
      return { ok: true, descriptor: this.#descriptor(existing), created: false };
    }

    const diskFingerprint = legacyPortableHistoryFolder
      ? null
      : await this.#fingerprint(canonicalPath);
    if (!allowMissing && diskFingerprint?.state === 'missing') {
      throw nativeFileConflictError();
    }
    if (!legacyPortableHistoryFolder && !isNativeFileFingerprint(diskFingerprint)) {
      throw new Error('Native file fingerprint provider returned an invalid result');
    }

    // Fingerprinting yields to I/O. Another window can claim the path while
    // it is in progress, so repeat the ownership check before publishing.
    const concurrent = this.#byPath.get(ownershipPath);
    if (concurrent && concurrent.sessionId !== sessionId) {
      return { ok: false, ownerSessionId: concurrent.sessionId };
    }
    if (concurrent) {
      concurrent.releaseRequested = false;
      return { ok: true, descriptor: this.#descriptor(concurrent), created: false };
    }
    // 지문을 재는 사이 창이 닫혔으면 정리는 이미 끝났다. 여기서 쥐면 없는 창이 파일을 계속 쥐어
    // 다른 창에서도 열 수 없다.
    if ((this.#sessionReleases.get(sessionId) ?? 0) !== releases) {
      throw new Error('The window closed before the document finished opening');
    }

    const entry = {
      handleId: this.#createId(),
      sessionId,
      canonicalPath,
      ownershipPath,
      // The real on-disk name, not the caller's spelling: an 8.3 alias such as
      // REPORT~1.HWP for report.hwpx would otherwise pick the save format.
      name: basename(canonicalPath),
      activeWrites: 0,
      writeChain: Promise.resolve(),
      releaseRequested: false,
      legacyPortableHistoryFolder,
      diskFingerprint,
      // Bumped by every write so a slower adoptLoadedContent read never
      // replaces a fingerprint that a save produced in the meantime.
      fingerprintEpoch: 0,
    };
    this.#byId.set(entry.handleId, entry);
    this.#byPath.set(ownershipPath, entry);
    return { ok: true, descriptor: this.#descriptor(entry), created: true };
  }

  /**
   * 이 창이 연 문서 파일의 이름을 같은 폴더 안에서 바꾼다. 확장자는 바꾸지 않고, 이미 있는 이름이나
   * 다른 창이 쥔 경로는 거절한다. 핸들 id 는 그대로 두고 경로·이름·북마크·점유를 새 경로로 옮긴다.
   * 바깥에서 먼저 이름이 바뀌었으면 그 파일을 따라간 뒤 바꾼다. 저장과 겹치지 않는다.
   */
  async renameHandle(sessionId, handleId, nextName) {
    const entry = this.#entryForSender(sessionId, handleId);
    const refuse = (reason, message, cause) => Object.assign(
      new Error(message, cause ? { cause } : undefined),
      { renameRefusal: reason },
    );
    if (entry.legacyPortableHistoryFolder) throw refuse('invalid', 'Legacy RHWPX folders cannot be renamed');
    if (entry.activeWrites > 0) throw refuse('saving', 'The document is being saved; try again in a moment');
    const name = typeof nextName === 'string' ? nextName.trim() : '';
    if (
      !name
      || name !== basename(name)
      || name.startsWith('.')
      || name.length > 255
      // eslint-disable-next-line no-control-regex
      || /[\\/:*?"<>|\u0000-\u001f]/.test(name)
      || isWindowsDeviceName(name)
    ) {
      throw refuse('invalid', 'Invalid file name');
    }
    if (extname(name).toLowerCase() !== extname(entry.canonicalPath).toLowerCase()) {
      throw refuse('extension', 'The file extension cannot change');
    }
    // 이름을 바꾸는 동안 저장·놓기·바깥 이동 확인이 끼어들지 않게 쓰기 중으로 둔다.
    entry.activeWrites += 1;
    try {
      const located = await this.#locate(entry, { writing: true });
      if (located === 'missing') throw refuse('missing', 'The document file was moved or deleted');
      if (located === 'unavailable') throw refuse('unavailable', 'The drive or network folder of the document is not available');
      const previousPath = entry.canonicalPath;
      const previousOwnershipPath = entry.ownershipPath;
      const target = join(dirname(previousPath), name);
      validateNativeDocumentPath(target);
      if (basename(previousPath) === name) {
        return {
          descriptor: this.#descriptor(entry),
          previousPath,
          canonicalPath: previousPath,
          previousOwnershipPath,
          ownershipPath: previousOwnershipPath,
        };
      }
      const targetOwnership = this.#ownershipKey(target);
      // 대소문자만 다른 이름은 같은 파일이다 (대소문자를 가리지 않는 볼륨).
      if (targetOwnership !== entry.ownershipPath) {
        if (this.#byPath.has(targetOwnership)) throw refuse('open', 'A file with that name is already open');
        let exists = true;
        try {
          await this.#stat(target);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          exists = false;
        }
        if (exists) throw refuse('exists', 'A file with that name already exists');
      }
      try {
        // 백신·색인기가 문서를 잠깐 쥐면 Windows 이름 바꾸기가 실패한다. 저장처럼 다시 해 본다.
        await retryWindows(() => this.#renameFile(previousPath, target), this.#platform);
      } catch (error) {
        if (error?.code === 'ENOENT') throw refuse('missing', 'The document file was moved or deleted', error);
        if (error?.code === 'EEXIST') throw refuse('exists', 'A file with that name already exists', error);
        if (error?.code === 'EBUSY') throw refuse('in-use', 'Another program is using this document', error);
        if (error?.code === 'EPERM' || error?.code === 'EACCES') {
          throw refuse('denied', 'Access to this document or its folder was denied', error);
        }
        throw error;
      }
      const canonicalPath = await this.#canonicalize(target);
      const previousFingerprint = entry.diskFingerprint;
      this.#applyMoves([{ entry, from: previousPath, path: canonicalPath }], { reason: 'rename' });
      // 이름을 바꾸면 파일 상태 시각이 바뀐다(FAT·exFAT 는 파일 id 도). 다음 저장이 바깥 수정으로
      // 오해하지 않게 다시 재되, 이름을 바꾸기 전에 다른 프로그램이 내용을 바꿨으면 예전 기준을 둔다.
      // 새 기준으로 삼으면 다음 저장이 그 바뀐 내용을 묻지 않고 덮어쓴다.
      const fingerprint = await this.#fingerprint(canonicalPath).catch(() => null);
      if (
        isNativeFileFingerprint(fingerprint)
        && fingerprint.state === 'file'
        && (previousFingerprint?.state !== 'file' || fingerprint.digest === previousFingerprint.digest)
      ) {
        entry.diskFingerprint = fingerprint;
        entry.fingerprintEpoch += 1;
      }
      return {
        descriptor: this.#descriptor(entry),
        previousPath,
        canonicalPath: entry.canonicalPath,
        previousOwnershipPath,
        ownershipPath: entry.ownershipPath,
      };
    } finally {
      entry.activeWrites -= 1;
      if (entry.activeWrites === 0 && entry.releaseRequested) this.#deleteEntry(entry);
    }
  }

  /**
   * 바깥에서 이름이 바뀌거나 옮겨진 문서를 찾아 핸들이 그 파일을 다시 가리키게 한다. 창이 다시
   * 앞으로 올 때 렌더러가 부른다. state 가 missing 이면 파일이 지워졌거나 찾을 수 없는 곳으로 갔고,
   * unavailable 이면 문서가 있는 드라이브나 네트워크 폴더에 닿지 않는다.
   */
  async locate(senderSessionId, handleId) {
    const entry = this.#entryForSender(senderSessionId, handleId);
    let state = 'present';
    if (entry.activeWrites === 0) {
      try {
        state = await this.#locate(entry);
      } catch {
        state = 'present';
      }
    }
    return { name: entry.name, state: state === 'missing' || state === 'unavailable' ? state : 'present' };
  }

  async createSaveTarget(sessionId, filePath) {
    return this.create(sessionId, filePath, { allowMissing: true });
  }

  /**
   * The renderer finished loading bytes whose SHA-256 is `digest` through this
   * handle. Opening a path this window already owns reuses its entry, whose
   * fingerprint still describes the version first opened. After an external
   * change every save would then conflict until the window closed. Adopt the
   * disk state only when it holds exactly the loaded bytes, so a load that was
   * cancelled or read a different version can never enable a silent overwrite.
   */
  async adoptLoadedContent(senderSessionId, handleId, digest) {
    const entry = this.#entryForSender(senderSessionId, handleId);
    if (entry.legacyPortableHistoryFolder) return false;
    if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) return false;
    if (entry.diskFingerprint?.state === 'file' && entry.diskFingerprint.digest === digest) {
      // Same bytes as the baseline. A sync client rewriting identical bytes, or
      // deleting a leftover temp link, still changes the file generation and
      // every save would conflict. Skip the rehash only if a stat agrees.
      const info = await this.#stat(entry.canonicalPath, { bigint: true }).catch(() => null);
      if (info?.isFile?.() && nativeFileGeneration(info) === entry.diskFingerprint.generation) {
        return true;
      }
    }
    if (entry.activeWrites > 0) return false;
    const epoch = entry.fingerprintEpoch;
    const fingerprint = await this.#fingerprint(entry.canonicalPath);
    if (
      entry.activeWrites > 0
      || entry.fingerprintEpoch !== epoch
      || this.#byId.get(handleId) !== entry
      || !isNativeFileFingerprint(fingerprint)
      || fingerprint.state !== 'file'
      || fingerprint.digest !== digest
    ) {
      return false;
    }
    entry.diskFingerprint = fingerprint;
    return true;
  }

  async ownerForPath(filePath) {
    const canonicalPath = await this.#canonicalize(filePath);
    return (await this.#settledHolder(this.#ownershipKey(canonicalPath)))?.sessionId ?? null;
  }

  pathForSender(senderSessionId, handleId) {
    return this.#entryForSender(senderSessionId, handleId).ownershipPath;
  }

  /** Exact canonical source path for an explicitly sender-owned live handle. */
  sourcePathForSender(senderSessionId, handleId) {
    return this.#entryForSender(senderSessionId, handleId).canonicalPath;
  }

  async read(senderSessionId, handleId) {
    const entry = this.#entryForSender(senderSessionId, handleId);
    // A reload after a rename outside the app reads the document, not its old name.
    if (entry.activeWrites === 0) await this.#locate(entry).catch(() => {});
    return {
      name: entry.name,
      bytes: await readPortableHistoryBytes(entry.canonicalPath, {
        readFileImpl: this.#readFile,
        statImpl: this.#stat,
      }),
    };
  }

  validateSave(senderSessionId, handleId, identity, leases) {
    const entry = this.#entryForSender(senderSessionId, handleId);
    return leases.validateSaveTarget(senderSessionId, identity, entry.ownershipPath);
  }

  async write(senderSessionId, handleId, bytes, identity, leases) {
    const entry = this.#entryForSender(senderSessionId, handleId);
    if (entry.legacyPortableHistoryFolder) {
      throw new Error('Legacy RHWPX folders are import-only; save to an RHWPX file instead');
    }
    if (entry.activeWrites > 0) {
      const error = new Error('A native save is already in progress for this document');
      error.code = NATIVE_FILE_WRITE_BUSY_CODE;
      throw error;
    }
    entry.activeWrites += 1;
    try {
      this.validateSave(senderSessionId, handleId, identity, leases);
      validateNativeDocumentBytes(entry.canonicalPath, bytes);
      const write = entry.writeChain.then(async () => {
        // Follow a rename or move made outside the app, so the save lands in
        // the file being edited instead of failing or recreating the old name.
        const located = await this.#locate(entry, { writing: true });
        if (located === 'missing') throw nativeFileMissingError();
        if (located === 'unavailable') throw nativeFileUnavailableError();
        // Revalidate after earlier queued writes. A stale window/document must
        // never reach the filesystem merely because it entered the queue first.
        this.validateSave(senderSessionId, handleId, identity, leases);
        entry.fingerprintEpoch += 1;
        let savedFingerprint;
        try {
          savedFingerprint = await this.#writeFile(entry.canonicalPath, bytes, {
            expectedFingerprint: entry.diskFingerprint,
          });
        } catch (error) {
          // The bytes reached disk before a durability or cleanup step failed.
          // Keeping the old fingerprint would turn every later save into a
          // conflict, and reopening to clear it would discard the edits.
          const published = error?.published === true ? error.publishedFingerprint : null;
          if (isNativeFileFingerprint(published) && published.state === 'file') {
            entry.diskFingerprint = published;
            this.#refreshBookmarkDigest(identity, entry, bytes);
          }
          throw error;
        }
        entry.diskFingerprint = isNativeFileFingerprint(savedFingerprint)
          ? savedFingerprint
          : await this.#fingerprint(entry.canonicalPath);
        if (!isNativeFileFingerprint(entry.diskFingerprint)
          || entry.diskFingerprint.state !== 'file') {
          throw new Error('Native file write did not produce a durable fingerprint');
        }
        this.#refreshBookmarkDigest(identity, entry, bytes);
        this.#refreshBookmarkContent(entry);
      });
      // A failed write must not poison later saves to the same handle.
      entry.writeChain = write.catch(() => {});
      await write;
      return { name: entry.name, byteLength: bytes.byteLength };
    } finally {
      entry.activeWrites -= 1;
      if (entry.activeWrites === 0 && entry.releaseRequested) this.#deleteEntry(entry);
    }
  }

  async isSameEntry(senderSessionId, firstHandleId, secondHandleId) {
    // 창 경계를 넘어 같은 파일인지 판정한다 — 다른 창에 이미 열린 문서를
    // 다시 열 때 중복 열기 방지가 이 비교에 의존한다. 한쪽 핸들이 다른 창의
    // 것이어도 경로 일치 여부만 반환하므로 크래시 대신 판정 결과를 준다.
    // 임의 핸들 탐색을 막기 위해 둘 다 이 창의 핸들이 아니면 기존처럼 거절한다.
    const first = this.#byId.get(firstHandleId);
    const second = this.#byId.get(secondHandleId);
    // 놓은 핸들(최근 문서의 옛 핸들 등)은 비교할 수 없다. "다른 파일"로 답하면 맞는 파일을 거절한다.
    if (!first || !second) return null;
    if (first.sessionId !== senderSessionId && second.sessionId !== senderSessionId) {
      throw new Error('Native file handle does not belong to this window');
    }
    return first.ownershipPath === second.ownershipPath;
  }

  rememberDocument(documentId, senderSessionId, handleId, digest) {
    // 이미 놓은 핸들은 북마크를 바꾸지 않는다. 마지막으로 기억한 위치를 그대로 둔다.
    if (!this.#byId.has(handleId)) return this.#bookmarks.get(documentId)?.path ?? null;
    const entry = this.#entryForSender(senderSessionId, handleId);
    const previous = this.#bookmarks.get(documentId);
    if (
      previous
      && digest === undefined
      && this.#ownershipKey(previous.path) !== entry.ownershipPath
    ) {
      return previous.path;
    }
    let nextDigest = previous?.digest ?? null;
    if (digest !== undefined) nextDigest = parseStoredDigest(digest);
    // A canonical path has one logical owner. Old builds could accumulate
    // duplicate owners after every broken reopen; the first loaded owner is
    // used until a successful remember cleans the ambiguity up.
    for (const [otherDocumentId, bookmark] of this.#bookmarks) {
      if (
        otherDocumentId !== documentId
        && this.#ownershipKey(bookmark.path) === entry.ownershipPath
      ) {
        this.#bookmarks.delete(otherDocumentId);
      }
    }
    if (this.#bookmarks.has(documentId)) this.#bookmarks.delete(documentId);
    this.#bookmarks.set(documentId, {
      path: entry.canonicalPath,
      digest: nextDigest,
      ...bookmarkContentOf(entry.diskFingerprint),
    });
    while (this.#bookmarks.size > 200) {
      const oldest = this.#bookmarks.keys().next().value;
      this.#bookmarks.delete(oldest);
    }
    return entry.canonicalPath;
  }

  async reopenDocument(sessionId, documentId) {
    const bookmark = this.#bookmarks.get(documentId);
    if (!bookmark) return null;
    // 닫혀 있는 동안 이름이 바뀐 문서는 그 파일을 연다. 옛 이름에 새로 생긴 다른 파일이 아니다.
    await this.#followBookmark(sessionId, documentId, bookmark);
    return this.create(sessionId, bookmark.path);
  }

  bookmarkPathFor(documentId) {
    return this.#bookmarks.get(documentId)?.path ?? null;
  }

  /**
   * 기억한 위치의 파일이 아직 있는지 본다. 핸들을 만들거나 경로를 점유하지 않는다.
   * 파일만 없고 폴더가 남아 있으면 missing(지워졌거나 옮겨짐), 폴더째 없거나 확인이 멈추면
   * 꺼낸 디스크·닿지 않는 네트워크일 수 있으므로 unavailable 로 구분한다. 지금 저장 중인
   * 경로는 원자적 교체 사이에 잠깐 비므로 있는 것으로 친다.
   */
  async inspectDocument(documentId, { recovered = false } = {}) {
    const bookmark = this.#bookmarks.get(documentId);
    if (!bookmark) return { state: 'unknown' };
    const holder = this.#byPath.get(this.#ownershipKey(bookmark.path));
    if (holder && holder.activeWrites > 0) {
      return { state: 'present', fileName: basename(bookmark.path), size: 0, modifiedAt: 0 };
    }
    try {
      const info = await withTimeout(this.#stat(bookmark.path), HOME_STAT_TIMEOUT_MS);
      if (!info.isFile() && !info.isDirectory()) return { state: 'unavailable' };
      return {
        state: 'present',
        fileName: basename(bookmark.path),
        size: info.isFile() ? info.size : 0,
        modifiedAt: Math.round(info.mtimeMs ?? 0),
      };
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return { state: 'unavailable' };
    }
    try {
      const parent = await withTimeout(this.#stat(dirname(bookmark.path)), HOME_STAT_TIMEOUT_MS);
      if (!parent.isDirectory()) return { state: 'unavailable' };
      // 저장 도중 앱이 꺼지면 원본은 복구 이름으로 곁에 남는다. 없어진 문서로 보이기 전에 되돌린다.
      if (!recovered && await this.#recoverInterruptedSave?.(bookmark.path)) {
        return this.inspectDocument(documentId, { recovered: true });
      }
      return { state: 'missing' };
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return { state: 'unavailable' };
    }
    // 폴더째 없다. 꺼낸 디스크·끊긴 네트워크일 수 있어 그대로 두되, 폴더 이름만 바뀌어 그 파일이
    // 다른 이름의 폴더에 있으면 missing 으로 알려 문서 홈이 새 위치를 기억하게 한다.
    try {
      const found = await withTimeout(
        this.#findBookmarkedFile(null, documentId, bookmark),
        HOME_STAT_TIMEOUT_MS * 4,
      );
      return { state: found ? 'missing' : 'unavailable' };
    } catch {
      return { state: 'unavailable' };
    }
  }

  /**
   * 옮겨진 문서를 근처 폴더에서 찾아 새 위치로 기억한다. 메인이 직접 크기와 sha256 내용을
   * 마지막으로 기억한 것과 맞춘다. 다른 창이 쥔 파일, 다른 문서가 기억하는 파일, 임시·복구
   * 파일은 후보가 아니다. 내용 표시가 없는 옛 북마크는 찾지 않는다(null).
   */
  async relocateDocument(sessionId, documentId) {
    const bookmark = this.#bookmarks.get(documentId);
    if (!bookmark?.contentDigest) return null;
    // 이름이나 폴더만 바뀐 그 파일 (파일 id 로 확인).
    const followed = await this.#findBookmarkedFile(sessionId, documentId, bookmark);
    if (followed) {
      bookmark.path = followed;
      return { fileName: basename(followed) };
    }
    const matches = [];
    const claimed = new Set();
    for (const [otherDocumentId, other] of this.#bookmarks) {
      if (otherDocumentId !== documentId) claimed.add(this.#ownershipKey(other.path));
    }
    for (const candidate of await this.#collectNearbyFiles(sessionId, documentId, basename(bookmark.path))) {
      const key = this.#ownershipKey(candidate);
      if (claimed.has(key)) continue;
      const owner = this.#byPath.get(key);
      if (owner && owner.sessionId !== sessionId) continue;
      let info;
      try {
        info = await withTimeout(this.#stat(candidate), HOME_STAT_TIMEOUT_MS);
      } catch {
        continue;
      }
      if (!info.isFile() || info.size > RELOCATE_CANDIDATE_MAX_BYTES) continue;
      if (info.size !== bookmark.size) continue;
      let fingerprint;
      try {
        fingerprint = await this.#fingerprint(candidate);
      } catch {
        continue;
      }
      if (fingerprint?.state !== 'file' || fingerprint.digest !== bookmark.contentDigest) continue;
      matches.push(candidate);
      if (matches.length > 1) break;
    }
    // 같은 내용의 파일이 둘이면 어느 쪽이 그 문서인지 모른다. 사본에 이어 저장하지 않게 고르지 않는다.
    if (matches.length !== 1) return null;
    bookmark.path = matches[0];
    return { fileName: basename(matches[0]) };
  }

  /**
   * 기억한 문서 파일이 이름이나 폴더를 바꿨으면 그 파일의 경로. 파일 id 로(FAT·exFAT 는 시각과
   * 내용으로) 같은 파일임을 확인한 것만 돌려준다. 다른 문서가 기억하거나 다른 창이 쥔 파일은 아니다.
   */
  async #findBookmarkedFile(sessionId, documentId, bookmark) {
    const expected = bookmarkFingerprintOf(bookmark);
    if (!expected || !this.#locateMoved) return null;
    let found = null;
    try {
      found = await this.#locateMoved(bookmark.path, expected, { platform: this.#platform });
    } catch {
      found = null;
    }
    if (!found?.path) return null;
    const canonicalPath = await this.#canonicalize(found.path).catch(() => null);
    if (!canonicalPath || extname(canonicalPath).toLowerCase() !== extname(bookmark.path).toLowerCase()) return null;
    const key = this.#ownershipKey(canonicalPath);
    for (const [otherDocumentId, other] of this.#bookmarks) {
      if (otherDocumentId !== documentId && this.#ownershipKey(other.path) === key) return null;
    }
    const owner = this.#byPath.get(key);
    if (owner && owner.sessionId !== sessionId) return null;
    return canonicalPath;
  }

  /** 기억한 경로가 그 파일을 더는 가리키지 않으면 파일의 새 경로로 옮긴다. 옮겼으면 true. */
  async #followBookmark(sessionId, documentId, bookmark) {
    const expected = bookmarkFingerprintOf(bookmark);
    // 열린 핸들은 자기 파일을 스스로 따라간다.
    if (!expected || this.#byPath.has(this.#ownershipKey(bookmark.path))) return false;
    const identity = fileIdentityOfGeneration(expected.generation);
    let info = null;
    try {
      info = await this.#stat(bookmark.path, { bigint: true });
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return false;
    }
    if (info?.isFile?.() && (!identity || sameFileIdentity(identity, fileIdentityOfStat(info)))) return false;
    if (!info && await this.#recoverInterruptedSave?.(bookmark.path)) return false;
    // 옛 이름의 파일이 다른 프로그램의 저장으로 바뀌었을 뿐이면 원래 id 는 어디에도 없다. 그대로 연다.
    const found = await this.#findBookmarkedFile(sessionId, documentId, bookmark);
    if (!found) return false;
    bookmark.path = found;
    return true;
  }

  /**
   * 미리보기용으로 기억한 위치의 문서 바이트를 읽는다. 읽지 못하면 null — 이유는
   * {@link readRememberedDocumentResult} 가 알려 준다.
   */
  async readRememberedDocument(sessionId, documentId, options) {
    const result = await this.readRememberedDocumentResult(sessionId, documentId, options);
    return result.ok ? { name: result.name, bytes: result.bytes } : null;
  }

  /**
   * 기억한 위치의 문서 바이트와, 읽지 못했을 때의 이유. 한 번 연 파일로 크기를 보고 그만큼만 읽는다.
   * - owned: 다른 창이 쥔 파일
   * - missing: 기억한 문서가 없거나 파일·폴더가 없다
   * - too-large: maxBytes 를 넘는다
   * - unreadable: 링크로 바뀐 경로, 폴더 묶음, 아직 내려받지 않은 클라우드 자리표시 파일(크기는
   *   있는데 디스크 블록이 없음), 권한·잠김(EACCES·EPERM·EBUSY) 같은 읽기 실패. 잠깐일 수 있다.
   * @returns {Promise<{ ok: true, name: string, bytes: Buffer }
   *   | { ok: false, reason: 'owned' | 'missing' | 'too-large' | 'unreadable', size?: number }>}
   */
  async readRememberedDocumentResult(sessionId, documentId, { maxBytes = HOME_THUMBNAIL_SOURCE_MAX_BYTES } = {}) {
    const bookmark = this.#bookmarks.get(documentId);
    if (!bookmark) return { ok: false, reason: 'missing' };
    const owner = this.#byPath.get(this.#ownershipKey(bookmark.path));
    if (owner && owner.sessionId !== sessionId) return { ok: false, reason: 'owned' };
    let handle;
    try {
      handle = await this.#openFile(bookmark.path, OPEN_READ_NO_FOLLOW);
      const info = await handle.stat();
      if (!info.isFile()) return { ok: false, reason: 'unreadable' };
      if (info.size > maxBytes) return { ok: false, reason: 'too-large', size: info.size };
      if (process.platform !== 'win32' && info.size > 0 && typeof info.blocks === 'number' && info.blocks === 0) return { ok: false, reason: 'unreadable' };
      const bytes = Buffer.allocUnsafe(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return { ok: true, name: basename(bookmark.path), bytes: bytes.subarray(0, offset) };
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { ok: false, reason: 'missing' };
      return { ok: false, reason: 'unreadable' };
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /** 이 창이 쥔 경로인가. 새 창 열기는 이미 이 창에 열린 문서를 다시 열지 않는다. */
  ownsDocumentPath(sessionId, documentId) {
    const bookmark = this.#bookmarks.get(documentId);
    if (!bookmark) return false;
    return this.#byPath.get(this.#ownershipKey(bookmark.path))?.sessionId === sessionId;
  }

  async searchNearby(sessionId, documentId, { basenameHint = '' } = {}) {
    this.#forgetSessionProbes(sessionId);
    const probes = [];
    const nearby = await this.#collectNearbyFiles(sessionId, documentId, basenameHint);
    // 이름이나 폴더만 바뀐 그 파일을 먼저 본다. 같은 내용의 사본이 앞에 있으면 사본이 열린다.
    const bookmark = this.#bookmarks.get(documentId);
    const followed = bookmark ? await this.#findBookmarkedFile(sessionId, documentId, bookmark) : null;
    if (followed) {
      const key = this.#ownershipKey(followed);
      nearby.splice(0, nearby.length, followed, ...nearby.filter((filePath) => this.#ownershipKey(filePath) !== key));
    }
    for (const filePath of nearby) {
      const probeId = this.#createId();
      const name = basename(filePath);
      this.#probes.set(probeId, { sessionId, path: filePath, name });
      probes.push(Object.freeze({ probeId, fileName: name }));
    }
    return probes;
  }

  async readProbe(sessionId, probeId) {
    const probe = this.#probeForSender(sessionId, probeId);
    const canonicalPath = await this.#canonicalize(probe.path);
    const owner = this.#byPath.get(this.#ownershipKey(canonicalPath));
    if (owner && owner.sessionId !== sessionId) {
      throw new Error('Native file probe does not belong to this window');
    }
    return {
      name: probe.name,
      bytes: await readPortableHistoryBytes(canonicalPath, {
        readFileImpl: this.#readFile,
        statImpl: this.#stat,
      }),
    };
  }

  async claimProbe(sessionId, probeId) {
    const probe = this.#probeForSender(sessionId, probeId);
    this.#probes.delete(probeId);
    return this.create(sessionId, probe.path);
  }

  async verifyPick(sessionId, documentId, handleId) {
    const entry = this.#entryForSender(sessionId, handleId);
    const bookmark = this.#bookmarks.get(documentId);
    if (!bookmark) return false;
    return entry.ownershipPath === this.#ownershipKey(bookmark.path);
  }

  loadBookmarks(entries, { strict = false } = {}) {
    if (!Array.isArray(entries)) throw new Error('Native bookmark store must be an array');
    const next = new Map();
    for (const item of entries ?? []) {
      const parsed = parseBookmarkEntry(item);
      if (!parsed) {
        if (strict) throw new Error('Native bookmark store contains an invalid entry');
        continue;
      }
      if (strict && next.has(parsed.documentId)) {
        throw new Error('Native bookmark store contains a duplicate document id');
      }
      next.set(parsed.documentId, {
        path: parsed.path,
        digest: parsed.digest,
        ...(parsed.contentDigest && parsed.size !== null ? { contentDigest: parsed.contentDigest, size: parsed.size } : {}),
        ...(parsed.contentDigest && parsed.size !== null && parsed.generation ? { generation: parsed.generation } : {}),
      });
    }
    if (strict && next.size > 200) throw new Error('Native bookmark store contains too many entries');
    this.#bookmarks = next;
  }

  dumpBookmarks() {
    return [...this.#bookmarks.entries()].map(([documentId, bookmark]) => [
      documentId,
      {
        path: bookmark.path,
        digest: bookmark.digest,
        ...(bookmark.contentDigest ? { contentDigest: bookmark.contentDigest, size: bookmark.size } : {}),
        ...(bookmark.contentDigest && bookmark.generation ? { generation: bookmark.generation } : {}),
      },
    ]);
  }

  descriptorsForSession(sessionId) {
    return [...this.#byId.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => this.#descriptor(entry));
  }

  releaseHandle(sessionId, handleId) {
    // 놓기는 여러 번 해도 된다. 문서를 닫는 경로가 겹쳐도 이미 놓은 핸들은 조용히 넘어간다.
    if (!this.#byId.has(handleId)) return;
    const entry = this.#entryForSender(sessionId, handleId);
    if (entry.activeWrites > 0) {
      entry.releaseRequested = true;
      return;
    }
    this.#deleteEntry(entry);
  }

  releaseSession(sessionId) {
    this.#sessionReleases.set(sessionId, (this.#sessionReleases.get(sessionId) ?? 0) + 1);
    for (const [handleId, entry] of this.#byId) {
      if (entry.sessionId !== sessionId) continue;
      if (entry.activeWrites > 0) {
        entry.releaseRequested = true;
        continue;
      }
      this.#deleteEntry(entry);
    }
    this.#forgetSessionProbes(sessionId);
  }

  #forgetSessionProbes(sessionId) {
    for (const [probeId, probe] of this.#probes) {
      if (probe.sessionId === sessionId) this.#probes.delete(probeId);
    }
  }

  /** 저장으로 바뀐 내용 표시를 그 경로를 기억한 북마크에 옮긴다. */
  #refreshBookmarkContent(entry) {
    const content = bookmarkContentOf(entry.diskFingerprint);
    if (!content) return;
    for (const bookmark of this.#bookmarks.values()) {
      if (this.#ownershipKey(bookmark.path) === entry.ownershipPath) Object.assign(bookmark, content);
    }
  }

  #refreshBookmarkDigest(identity, entry, bytes) {
    const documentId = identity?.documentId;
    if (!documentId || !this.#digest) return;
    const bookmark = this.#bookmarks.get(documentId);
    if (!bookmark || this.#ownershipKey(bookmark.path) !== entry.ownershipPath) return;
    bookmark.digest = parseStoredDigest(this.#digest(bytes));
  }

  async #collectNearbyFiles(sessionId, documentId, basenameHint) {
    const wanted = basename(String(basenameHint || this.#bookmarks.get(documentId)?.path || ''));
    const dirs = [];
    const seenDirs = new Set();
    const addDir = (dir) => {
      if (!dir || dir === '.' || dir === '/' ) return;
      const key = this.#ownershipKey(dir);
      if (seenDirs.has(key) || dirs.length >= NEARBY_DIRECTORY_CAP) return;
      seenDirs.add(key);
      dirs.push(dir);
    };

    const bookmark = this.#bookmarks.get(documentId);
    if (bookmark) {
      addDir(dirname(bookmark.path));
      addDir(dirname(dirname(bookmark.path)));
    }
    for (const other of [...this.#bookmarks.values()].reverse()) {
      addDir(dirname(other.path));
      if (dirs.length >= NEARBY_DIRECTORY_CAP) break;
    }

    const preferred = [];
    const rest = [];
    for (const dir of dirs) {
      const wantedKey = wanted ? this.#ownershipKey(join(dir, wanted)) : null;
      for (const filePath of await this.#listDocumentFiles(dir)) {
        if (wantedKey && this.#ownershipKey(filePath) === wantedKey) preferred.push(filePath);
        else rest.push(filePath);
      }
    }

    const unique = [];
    const seenFiles = new Set();
    for (const filePath of [...preferred, ...rest]) {
      let canonicalPath;
      try {
        canonicalPath = await this.#canonicalize(filePath);
      } catch {
        continue;
      }
      const key = this.#ownershipKey(canonicalPath);
      if (seenFiles.has(key)) continue;
      const owner = this.#byPath.get(key);
      if (owner && owner.sessionId !== sessionId) continue;
      seenFiles.add(key);
      unique.push(canonicalPath);
      if (unique.length >= NEARBY_FILE_CAP) break;
    }
    return unique;
  }

  async #listDocumentFiles(dir) {
    let directory;
    try {
      directory = await this.#openDir(dir);
    } catch {
      return [];
    }
    const files = [];
    let seen = 0;
    try {
      for await (const entry of directory) {
        seen += 1;
        if (seen > NEARBY_DIR_ENTRY_CAP) break;
        const name = typeof entry === 'string' ? entry : entry.name;
        const isDirectory = typeof entry !== 'string'
          && typeof entry.isDirectory === 'function'
          && entry.isDirectory();
        const supported = SUPPORTED_EXTENSIONS.has(extname(name).toLowerCase());
        if (!supported || TRANSIENT_DOCUMENT_NAME.test(name)) continue;
        if (isDirectory && extname(name).toLowerCase() !== '.rhwpx') continue;
        files.push(join(dir, name));
      }
    } catch {
      return files;
    } finally {
      await directory.close?.().catch(() => {});
    }
    return files;
  }

  #probeForSender(sessionId, probeId) {
    const probe = this.#probes.get(probeId);
    if (!probe || probe.sessionId !== sessionId) {
      throw new Error('Native file probe does not belong to this window');
    }
    return probe;
  }

  /**
   * Make the entry name its file again after the file was renamed or moved
   * outside the app. 'present': the path holds the file (now under its real
   * spelling), or there is nothing to follow. 'moved': the entry follows the
   * file to its new path. 'missing': the file left its path and was not found.
   * 'unavailable': its drive or network folder cannot be reached.
   * Callers share one search. Only the entry's own save or rename may look
   * while it writes: the path is briefly empty while a save publishes.
   */
  #locate(entry, { writing = false } = {}) {
    if (!this.#locateMoved || entry.legacyPortableHistoryFolder) return Promise.resolve('present');
    if (entry.activeWrites > (writing ? 1 : 0)) return Promise.resolve('present');
    if (!entry.locating) {
      entry.locating = this.#locateNow(entry).finally(() => {
        entry.locating = null;
      });
    }
    return entry.locating;
  }

  async #locateNow(entry) {
    // Another entry can move between planning and applying; plan again then.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const where = await this.#findEntryFile(entry);
      if (where.state !== 'moved') return where.state;
      if (where.path === entry.canonicalPath) return 'present';
      const moves = await this.#planMoves(entry, where.path, new Set());
      if (!moves) throw nativeFileMovedIntoOpenError();
      if (moves.some((move) => move.entry.canonicalPath !== move.from || !this.#byId.has(move.entry.handleId))) {
        continue;
      }
      this.#applyMoves(moves, { reason: 'followed' });
      return 'moved';
    }
    return 'present';
  }

  /**
   * Where the entry's file is now: { state: 'moved', path } when it sits at a
   * path other than the recorded one (a case-only rename included),
   * { state: 'present' } when the recorded path still names it or nothing can
   * be followed, { state: 'missing' } when it is gone, { state: 'unavailable' }
   * when its folder cannot be reached.
   */
  async #findEntryFile(entry, { recover = true } = {}) {
    const expected = entry.diskFingerprint;
    // A Save As target the app has not written yet has nothing to follow.
    if (expected?.state !== 'file') return { state: 'present' };
    const identity = fileIdentityOfGeneration(expected.generation);
    let info = null;
    try {
      info = await this.#stat(entry.canonicalPath, { bigint: true });
    } catch (error) {
      // Locked, offline or denied: let the save itself report why.
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return { state: 'present' };
    }
    if (info?.isFile?.() && (!identity || sameFileIdentity(identity, fileIdentityOfStat(info)))) {
      // Windows keeps the case a name was given in Explorer. Writing through
      // the old spelling would put the old case back.
      const spelled = await this.#canonicalize(entry.canonicalPath).catch(() => entry.canonicalPath);
      return spelled !== entry.canonicalPath
        && extname(spelled).toLowerCase() === extname(entry.canonicalPath).toLowerCase()
        ? { state: 'moved', path: spelled }
        : { state: 'present' };
    }
    // A save that was killed while the document sat under its recovery name.
    if (!info && recover && await this.#recoverInterruptedSave?.(entry.canonicalPath)) {
      return this.#findEntryFile(entry, { recover: false });
    }
    let found = null;
    try {
      found = await this.#locateMoved(entry.canonicalPath, expected, { platform: this.#platform });
    } catch {
      found = null;
    }
    if (found?.path) {
      const canonicalPath = await this.#canonicalize(found.path).catch(() => null);
      if (canonicalPath && extname(canonicalPath).toLowerCase() === extname(entry.canonicalPath).toLowerCase()) {
        return { state: 'moved', path: canonicalPath };
      }
    }
    // A different file under the old name is left to the save's conflict check.
    if (info) return { state: 'present' };
    // Neither the folder nor the one above it is there: an unplugged drive or
    // an offline share, not a deleted document.
    const reachable = async (path) => this.#stat(path).then(() => true, () => false);
    const folder = dirname(entry.canonicalPath);
    if (!await reachable(folder) && (dirname(folder) === folder || !await reachable(dirname(folder)))) {
      return { state: 'unavailable' };
    }
    return { state: 'missing' };
  }

  /**
   * The entry's file is at `path`. If another open entry still claims that
   * name, its own file went elsewhere (names swapped or shifted); move it too.
   * Null when a claimed name cannot be freed.
   */
  async #planMoves(entry, path, visiting) {
    visiting.add(entry);
    const moves = [{ entry, from: entry.canonicalPath, path }];
    const holder = this.#byPath.get(this.#ownershipKey(path));
    if (!holder || holder === entry || visiting.has(holder)) return moves;
    if (visiting.size >= 16 || holder.activeWrites > 0 || holder.locating || holder.legacyPortableHistoryFolder) {
      return null;
    }
    const where = await this.#findEntryFile(holder);
    if (where.state !== 'moved' || !where.path) return null;
    const rest = await this.#planMoves(holder, where.path, visiting);
    return rest ? [...moves, ...rest] : null;
  }

  /** Point entries at their files' new paths. Claims move all at once, so swapped names work. */
  #applyMoves(moves, { reason }) {
    const changes = moves.map(({ entry, path }) => ({
      entry,
      sessionId: entry.sessionId,
      handleId: entry.handleId,
      previousPath: entry.canonicalPath,
      previousOwnershipPath: entry.ownershipPath,
      canonicalPath: path,
      ownershipPath: this.#ownershipKey(path),
      name: basename(path),
    }));
    const moving = new Set(changes.map((change) => change.entry));
    for (const change of changes) {
      const holder = this.#byPath.get(change.ownershipPath);
      if (holder && !moving.has(holder)) throw nativeFileMovedIntoOpenError();
    }
    const leaseMoves = changes
      .filter((change) => change.previousOwnershipPath !== change.ownershipPath)
      .map(({ sessionId, previousOwnershipPath, ownershipPath }) => ({
        sessionId,
        from: previousOwnershipPath,
        to: ownershipPath,
      }));
    // Leases refuse first, so a refused move changes nothing.
    if (leaseMoves.length > 0) this.#moveLeases?.(leaseMoves);
    for (const change of changes) {
      if (this.#byPath.get(change.previousOwnershipPath) === change.entry) {
        this.#byPath.delete(change.previousOwnershipPath);
      }
    }
    for (const change of changes) {
      change.entry.canonicalPath = change.canonicalPath;
      change.entry.ownershipPath = change.ownershipPath;
      change.entry.name = change.name;
      this.#byPath.set(change.ownershipPath, change.entry);
    }
    const nextPathByKey = new Map(changes.map((change) => [change.previousOwnershipPath, change.canonicalPath]));
    for (const bookmark of this.#bookmarks.values()) {
      const nextPath = nextPathByKey.get(this.#ownershipKey(bookmark.path));
      if (nextPath) bookmark.path = nextPath;
    }
    try {
      this.#onEntriesMoved?.(changes.map(({ entry: _entry, ...change }) => change), { reason });
    } catch (error) {
      console.warn('[native-file] moved document notification failed:', error);
    }
  }

  /** The entry that claims a path, after it had the chance to follow its own file elsewhere. */
  async #settledHolder(ownershipPath) {
    const holder = this.#byPath.get(ownershipPath);
    if (!holder || holder.activeWrites > 0) return holder ?? null;
    await this.#locate(holder).catch(() => {});
    return this.#byPath.get(ownershipPath) ?? null;
  }

  #deleteEntry(entry) {
    this.#byId.delete(entry.handleId);
    if (this.#byPath.get(entry.ownershipPath) === entry) this.#byPath.delete(entry.ownershipPath);
  }

  #entryForSender(senderSessionId, handleId) {
    const entry = this.#byId.get(handleId);
    if (!entry) throw new StaleNativeHandleError();
    if (entry.sessionId !== senderSessionId) {
      throw new Error('Native file handle does not belong to this window');
    }
    return entry;
  }

  #descriptor(entry) {
    const verifiedDocumentId = this.#documentIdForOwnershipPath(entry.ownershipPath);
    return Object.freeze({
      kind: 'file',
      handleId: entry.handleId,
      name: entry.name,
      ...(entry.legacyPortableHistoryFolder ? { legacyPortableHistoryFolder: true } : {}),
      ...(verifiedDocumentId ? { verifiedDocumentId } : {}),
    });
  }

  #documentIdForOwnershipPath(ownershipPath) {
    for (const [documentId, bookmark] of this.#bookmarks) {
      if (this.#ownershipKey(bookmark.path) === ownershipPath) return documentId;
    }
    return null;
  }
}

function parseStoredDigest(value) {
  return typeof value === 'string' && /^blake3:[0-9a-f]{64}$/.test(value) ? value : null;
}

function parseBookmarkEntry(item) {
  if (!Array.isArray(item) || item.length < 2) return null;
  const documentId = item[0];
  if (typeof documentId !== 'string' || !documentId) return null;
  const value = item[1];
  if (typeof value === 'string' && value) {
    return { documentId, path: value, digest: null };
  }
  if (value && typeof value === 'object' && typeof value.path === 'string' && value.path) {
    const contentDigest = typeof value.contentDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(value.contentDigest)
      ? value.contentDigest
      : null;
    const size = Number.isSafeInteger(value.size) && value.size >= 0 ? value.size : null;
    return {
      documentId,
      path: value.path,
      digest: parseStoredDigest(value.digest),
      contentDigest,
      size,
      generation: parseStoredGeneration(value.generation),
    };
  }
  return null;
}
