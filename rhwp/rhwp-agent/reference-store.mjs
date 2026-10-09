import crypto from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  recoverInterruptedFileReplacement,
  replaceFileAtomically,
  retryLockedOperation,
} from './harness-update.mjs';
import {
  EXTRACTOR_TEXT_VERSION,
  MAX_EXTRACTED_CHARS as MAX_EXTRACTED_CHARS_PER_FILE,
  MAX_REFERENCE_SOURCE_BYTES,
  ReferenceExtractionError,
  SUPPORTED_REFERENCE_EXTENSIONS,
  chunkReferenceText,
  extractReferenceText,
} from './reference-extractor.mjs';
import { inspectReferenceImage, referenceKindForName } from './reference-image.mjs';

/*
 * 저장소 형식은 둘이다.
 * - legacy: references/. 옛 빌드가 같은 폴더를 그대로 읽는다. 옛 빌드는 모르는 루트 항목·객체 파일을
 *   격리했다가 12시간 뒤 지우고, 메타데이터가 가리키지 않는 blob 도 거둔다. 그래서 이 형식은
 *   schemaVersion 1 메타데이터, 채팅·문서·공용 범위, 옛 한도만 쓰고 새 파일을 두지 않는다.
 * - project: 연구 프로젝트 파일 (RHWP_PROJECTS_DIR/files). project 범위·별칭·이주 그림자를 담는다.
 *   옛 빌드는 이 폴더를 보지 않는다.
 */
const LEGACY_METADATA_SCHEMA_VERSION = 1;
const PROJECT_METADATA_SCHEMA_VERSION = 2;
// 검색 객체(objects/<sha>.json)는 형식을 그대로 둔다. 추출 판은 객체 안 textVersion 으로 적는다(없으면 1).
const OBJECT_SCHEMA_VERSION = 1;
const LEGACY_SCOPES = Object.freeze(['chat', 'document', 'global']);
const PROJECT_SCOPES = Object.freeze(['project']);
export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MAX_SCOPE_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_CHAT_FILES = 20;
export const DEFAULT_MAX_DOCUMENT_FILES = 20;
export const DEFAULT_MAX_GLOBAL_FILES = 100;
export const DEFAULT_MAX_REFERENCE_METADATA_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_REFERENCE_RECORDS = 1_000;
export const DEFAULT_MAX_REFERENCE_TOTAL_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_REFERENCE_TOTAL_FILES = 1_000;
export const DEFAULT_MAX_REFERENCE_EXTRACTED_CHARS = 25_000_000;
/** 프로젝트 파일 저장소 한도. 파일 한 개 상한은 추출기 상한과 같다. */
export const PROJECT_REFERENCE_LIMITS = Object.freeze({
  maxFileBytes: MAX_REFERENCE_SOURCE_BYTES,
  maxScopeBytes: 2 * 1024 * 1024 * 1024,
  maxProjectFiles: 2_000,
  maxMetadataBytes: 16 * 1024 * 1024,
  maxMetadataRecords: 20_000,
  maxTotalBytes: 16 * 1024 * 1024 * 1024,
  maxTotalFiles: 50_000,
  maxExtractedChars: 500_000_000,
});
export const DEFAULT_MAX_STARTUP_INDEX_CHARS = 250_000;
export const DEFAULT_MAX_RESIDENT_INDEX_CHARS = 10_000_000;
export const DEFAULT_MAX_RESIDENT_INDEX_TOKENS = 500_000;
export const DEFAULT_MAX_INDEX_TOKENS_PER_OBJECT = 250_000;
const MAX_STAGED_METADATA_BYTES = 16 * 1024;
const MAX_REFERENCE_OBJECT_BYTES = 32 * 1024 * 1024;
const MAX_STAGING_DIRECTORY_ENTRIES = 4_096;
const MIN_STORAGE_DIRECTORY_ENTRIES = 4_096;
const MAX_ALIAS_DEPTH = 8;
const MAX_READ_CHARS = 20_000;
const MAX_PAGE_TEXT_CHARS = 200_000;
const VIRTUAL_PAGE_CHUNKS = 40;
const MAX_WORD_TOKEN_CHARS = 128;
const MAX_SEARCH_QUERY_CHARS = 20_000;
const PROJECT_SCOPE_ID = /^p[a-z2-7]{10}$/;
export const DEFAULT_STAGED_REFERENCE_TTL_MS = 12 * 60 * 60 * 1000;
const PLAIN_TEXT_REFERENCE_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.html', '.htm',
]);

export class ReferenceStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'ReferenceStoreError';
  }
}

export function defaultReferenceRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.RHWP_REFERENCES_DIR) return path.resolve(env.RHWP_REFERENCES_DIR);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'rhwp', 'references');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'rhwp', 'references');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'rhwp', 'references');
}

export function normalizeReferenceScope(scope, scopeId) {
  if (!LEGACY_SCOPES.includes(scope) && scope !== 'project') {
    throw new ReferenceStoreError('REFERENCE_SCOPE_INVALID', 'scope must be chat, document, project, or global');
  }
  if (scope === 'global') return { scope, scopeId: 'global' };
  if (scope === 'project') {
    if (typeof scopeId !== 'string' || !PROJECT_SCOPE_ID.test(scopeId)) {
      throw new ReferenceStoreError('REFERENCE_SCOPE_ID_INVALID', 'project scopeId is invalid');
    }
    return { scope, scopeId };
  }
  if (typeof scopeId !== 'string') {
    throw new ReferenceStoreError('REFERENCE_SCOPE_ID_REQUIRED', `${scope} references require scopeId`);
  }
  const normalized = scopeId.normalize('NFKC').trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ReferenceStoreError('REFERENCE_SCOPE_ID_INVALID', `${scope} scopeId is invalid`);
  }
  return { scope, scopeId: normalized };
}

export function sanitizeReferenceName(value) {
  const leaf = path.basename(String(value ?? '').replaceAll('\\', '/'));
  const clean = leaf.normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!clean) throw new ReferenceStoreError('REFERENCE_NAME_INVALID', 'A valid file name is required');
  const extension = path.extname(clean).toLowerCase();
  if (!SUPPORTED_REFERENCE_EXTENSIONS.includes(extension)) {
    throw new ReferenceStoreError(
      'REFERENCE_TYPE_UNSUPPORTED',
      `Unsupported reference type ${extension || '(none)'}; supported: ${SUPPORTED_REFERENCE_EXTENSIONS.join(', ')}`,
    );
  }
  const ext = path.extname(clean);
  const stem = path.basename(clean, ext).slice(0, Math.max(1, 220 - ext.length));
  return `${stem}${ext.slice(0, 30)}`;
}

function normalizeMime(value) {
  const mime = String(value || 'application/octet-stream').split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : 'application/octet-stream';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function metadataCorrupt(message = 'Reference metadata contains an invalid file record') {
  return new ReferenceStoreError('REFERENCE_STORE_CORRUPT', message);
}

function isSafeRecordId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function requireGeneratedId(value) {
  if (!isSafeRecordId(value)) {
    throw new ReferenceStoreError('REFERENCE_ID_INVALID', 'Reference id generator returned an unsafe id');
  }
  return value;
}

function extractedReservationFor(name, reservedBytes) {
  if (referenceKindForName(name) === 'image') return 0;
  return PLAIN_TEXT_REFERENCE_EXTENSIONS.has(path.extname(name).toLowerCase())
    ? Math.min(reservedBytes, MAX_EXTRACTED_CHARS_PER_FILE)
    : MAX_EXTRACTED_CHARS_PER_FILE;
}

function preflightTopLevelArrayCount(text, key, maximum) {
  let objectDepth = 0;
  let arrayDepth = 0;
  let found = false;
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (character === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < text.length) {
        const current = text[index];
        index += 1;
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === '"') break;
      }
      if (index > text.length || text[index - 1] !== '"') {
        throw metadataCorrupt('Reference metadata JSON is truncated');
      }
      if (objectDepth !== 1 || arrayDepth !== 0 || text.slice(start, index) !== JSON.stringify(key)) continue;
      let cursor = index;
      while (/\s/.test(text[cursor] ?? '')) cursor += 1;
      if (text[cursor] !== ':') continue;
      cursor += 1;
      while (/\s/.test(text[cursor] ?? '')) cursor += 1;
      if (text[cursor] !== '[') throw metadataCorrupt(`Reference metadata ${key} must be an array`);
      found = true;
      let nesting = 1;
      let count = 0;
      let elementStarted = false;
      for (cursor += 1; cursor < text.length; cursor += 1) {
        const current = text[cursor];
        if (current === '"') {
          if (nesting === 1 && !elementStarted) {
            count += 1;
            elementStarted = true;
            if (count > maximum) {
              throw new ReferenceStoreError(
                'REFERENCE_METADATA_RECORD_LIMIT',
                `Reference metadata exceeds the ${maximum}-record limit`,
              );
            }
          }
          cursor += 1;
          let stringEscaped = false;
          while (cursor < text.length) {
            const stringCharacter = text[cursor];
            if (stringEscaped) stringEscaped = false;
            else if (stringCharacter === '\\') stringEscaped = true;
            else if (stringCharacter === '"') break;
            cursor += 1;
          }
          continue;
        }
        if (current === '[' || current === '{') {
          if (nesting === 1 && !elementStarted) {
            count += 1;
            elementStarted = true;
          }
          nesting += 1;
        } else if (current === ']' || current === '}') {
          nesting -= 1;
          if (nesting === 0) break;
        } else if (current === ',' && nesting === 1) {
          elementStarted = false;
        } else if (nesting === 1 && !elementStarted && !/\s/.test(current)) {
          count += 1;
          elementStarted = true;
        }
        if (count > maximum) {
          throw new ReferenceStoreError(
            'REFERENCE_METADATA_RECORD_LIMIT',
            `Reference metadata exceeds the ${maximum}-record limit`,
          );
        }
      }
      index = cursor + 1;
      continue;
    }
    if (character === '{') objectDepth += 1;
    else if (character === '}') objectDepth -= 1;
    else if (character === '[') arrayDepth += 1;
    else if (character === ']') arrayDepth -= 1;
    index += 1;
  }
  if (!found) throw metadataCorrupt(`Reference metadata is missing ${key}`);
}

async function readPlainUtf8FileBounded(file, maximumBytes, label) {
  let handle;
  try {
    const linkInfo = await fs.lstat(file);
    if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) {
      throw new ReferenceStoreError('REFERENCE_PATH_UNSAFE', `${label} is not a plain file`);
    }
    handle = await fs.open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > maximumBytes) {
      throw new ReferenceStoreError(
        'REFERENCE_METADATA_TOO_LARGE',
        `${label} is empty or exceeds the ${maximumBytes}-byte limit`,
      );
    }
    const bytes = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw metadataCorrupt(`${label} changed while it was being read`);
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
      throw metadataCorrupt(`${label} changed while it was being read`);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof ReferenceStoreError || error?.code === 'ENOENT') throw error;
    throw metadataCorrupt(`Could not read ${label}: ${error?.message ?? error}`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validateRecord(raw, ids) {
  if (!isPlainObject(raw)
    || !isSafeRecordId(raw.id)
    || typeof raw.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(raw.sha256)
    || typeof raw.name !== 'string'
    || typeof raw.mimeType !== 'string'
    || !Number.isSafeInteger(raw.size)
    || raw.size < 0
    || !Number.isSafeInteger(raw.chunkCount)
    || raw.chunkCount < 0
    || typeof raw.createdAt !== 'string'
    || !Number.isFinite(Date.parse(raw.createdAt))
    || (raw.status !== 'ready' && raw.status !== 'error')
    || (raw.pageCount !== undefined && (!Number.isSafeInteger(raw.pageCount) || raw.pageCount < 1))) {
    throw metadataCorrupt();
  }
  if (ids.has(raw.id)) throw metadataCorrupt('Reference metadata contains duplicate file ids');
  ids.add(raw.id);
  let scoped;
  let safeName;
  try {
    scoped = normalizeReferenceScope(raw.scope, raw.scopeId);
    safeName = sanitizeReferenceName(raw.name);
  } catch {
    throw metadataCorrupt();
  }
  if (scoped.scopeId !== raw.scopeId || safeName !== raw.name || normalizeMime(raw.mimeType) !== raw.mimeType) {
    throw metadataCorrupt();
  }
  return {
    id: raw.id,
    ...scoped,
    name: safeName,
    mimeType: raw.mimeType,
    size: raw.size,
    sha256: raw.sha256,
    status: raw.status,
    createdAt: raw.createdAt,
    chunkCount: raw.chunkCount,
    extractedChars: Number.isSafeInteger(raw.extractedChars) && raw.extractedChars >= 0 ? raw.extractedChars : 0,
    ...(raw.pageCount !== undefined ? { pageCount: raw.pageCount } : {}),
  };
}

function validateIdMap(value, ids, maximumRecords) {
  if (value === undefined) return {};
  if (!isPlainObject(value) || Object.keys(value).length > maximumRecords) {
    throw metadataCorrupt('Reference metadata aliases are invalid');
  }
  const out = {};
  for (const [from, to] of Object.entries(value)) {
    if (!isSafeRecordId(from) || !isSafeRecordId(to) || from === to || ids.has(from)) {
      throw metadataCorrupt('Reference metadata aliases are invalid');
    }
    out[from] = to;
  }
  return out;
}

/**
 * legacy 형식: schemaVersion 1 의 채팅·문서·공용 기록. 잠시 쓰였던 schemaVersion 2 파일을 만나면
 * project 범위 기록을 interim 으로 따로 돌려준다 — 프로젝트 저장소로 옮긴 뒤에야 v1 로 다시 쓴다.
 * project 형식: schemaVersion 2 의 project 범위 기록 + 별칭 + legacy 에서 옮겨 온 id(그림자).
 */
function validateMetadata(value, maximumRecords, format) {
  const version = isPlainObject(value) ? value.schemaVersion : null;
  const accepted = format === 'project'
    ? version === PROJECT_METADATA_SCHEMA_VERSION
    : version === LEGACY_METADATA_SCHEMA_VERSION || version === PROJECT_METADATA_SCHEMA_VERSION;
  if (!accepted || !Array.isArray(value.files)) {
    throw metadataCorrupt('Reference metadata has an unsupported or invalid schema');
  }
  if (value.files.length > maximumRecords) {
    throw new ReferenceStoreError(
      'REFERENCE_METADATA_RECORD_LIMIT',
      `Reference metadata exceeds the ${maximumRecords}-record limit`,
    );
  }
  const allowed = format === 'project' ? PROJECT_SCOPES : LEGACY_SCOPES;
  const ids = new Set();
  const files = [];
  const interimFiles = [];
  for (const raw of value.files) {
    const record = validateRecord(raw, ids);
    if (allowed.includes(record.scope)) files.push(record);
    else if (format === 'legacy' && record.scope === 'project' && version === PROJECT_METADATA_SCHEMA_VERSION) interimFiles.push(record);
    else throw metadataCorrupt();
  }
  const aliases = validateIdMap(value.aliases, ids, maximumRecords);
  if (format === 'project') {
    const shadows = Array.isArray(value.shadows) ? value.shadows : [];
    if (shadows.length > maximumRecords || !shadows.every(isSafeRecordId)) {
      throw metadataCorrupt('Reference metadata shadows are invalid');
    }
    return { metadata: { files, aliases, shadows: [...new Set(shadows)] }, interim: null };
  }
  const interim = version === PROJECT_METADATA_SCHEMA_VERSION && (interimFiles.length > 0 || Object.keys(aliases).length > 0)
    ? { files: interimFiles, aliases }
    : null;
  return { metadata: { files, aliases: {}, shadows: [] }, interim, rewrite: version !== LEGACY_METADATA_SCHEMA_VERSION };
}

async function ensurePlainDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ReferenceStoreError('REFERENCE_PATH_UNSAFE', `Reference path is not a plain directory: ${directory}`);
  }
}

async function pathIsPlainFile(file) {
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function atomicWriteJson(file, value, { onRetainedTemp = null, platform = process.platform } = {}) {
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const serialized = `${JSON.stringify(value)}\n`;
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await replaceFileAtomically(temp, file, { platform });
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temp).catch((error) => {
      if (error?.code !== 'ENOENT') {
        onRetainedTemp?.(temp, Buffer.byteLength(serialized, 'utf8'));
        throw error;
      }
    });
  }
}

export async function publishNewReferenceBlob(staging, blobPath, {
  platform = process.platform,
  rename = fs.rename,
  lstat = fs.lstat,
  delays,
} = {}) {
  if (platform !== 'win32') return rename(staging, blobPath);
  try {
    const stats = await lstat(blobPath);
    if (stats.isDirectory()) {
      const error = new Error(`Refusing to replace directory ${blobPath}`);
      error.code = 'EISDIR';
      throw error;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await retryLockedOperation(() => rename(staging, blobPath), { platform, delays });
}

function publicFile(record) {
  return {
    id: record.id,
    scope: record.scope,
    scopeId: record.scopeId,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    sha256: record.sha256,
    status: record.status,
    createdAt: record.createdAt,
    chunkCount: record.chunkCount,
    ...(record.pageCount ? { pageCount: record.pageCount } : {}),
    kind: referenceKindForName(record.name),
  };
}

function normalizedSearchText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('ko-KR');
}

/** Korean-aware word tokens plus compact character bigrams for unsegmented Hangul. */
function* iterateReferenceTokens(value) {
  const normalized = normalizedSearchText(value);
  let words;
  try {
    const segmenter = new Intl.Segmenter('ko', { granularity: 'word' });
    words = segmenter.segment(normalized);
  } catch {
    words = normalized.matchAll(/[\p{Letter}\p{Number}]+/gu);
  }
  for (const entry of words) {
    if ('isWordLike' in entry && !entry.isWordLike) continue;
    const segment = entry.segment ?? entry[0];
    const hasHangul = /\p{Script=Hangul}/u.test(segment);
    let clean = '';
    let cleanChars = 0;
    for (const character of segment) {
      if (!/[\p{Letter}\p{Number}]/u.test(character)) continue;
      cleanChars += 1;
      if (cleanChars <= MAX_WORD_TOKEN_CHARS) clean += character;
    }
    if (cleanChars > 0 && cleanChars <= MAX_WORD_TOKEN_CHARS) yield `w:${clean}`;
    if (!hasHangul || cleanChars < 2) continue;
    let previous = null;
    for (const character of segment) {
      if (!/[\p{Letter}\p{Number}]/u.test(character)) continue;
      if (previous !== null) yield `g:${previous}${character}`;
      previous = character;
    }
  }
}

export function tokenizeReferenceText(value) {
  return [...iterateReferenceTokens(value)];
}

function scopeKey(scope, scopeId) {
  return `${scope}\u0000${scopeId}`;
}

function chunkKey(sha256, chunkId) {
  return `${sha256}:${chunkId}`;
}

export function scopesForReferenceSession({ threadId, documentId, projectId } = {}) {
  const scopes = [{ scope: 'global', scopeId: 'global' }];
  if (typeof projectId === 'string' && PROJECT_SCOPE_ID.test(projectId)) {
    scopes.push({ scope: 'project', scopeId: projectId });
  }
  if (typeof documentId === 'string' && documentId) scopes.push({ scope: 'document', scopeId: documentId });
  if (typeof threadId === 'string' && threadId) scopes.push({ scope: 'chat', scopeId: threadId });
  return scopes;
}

/** 청크의 쪽 번호로 쪽 수를 센다 — 쪽 정보가 없으면 null. */
function pageCountForChunks(chunks) {
  let maximum = 0;
  for (const chunk of chunks) {
    if (Number.isSafeInteger(chunk.page) && chunk.page > maximum) maximum = chunk.page;
  }
  return maximum > 0 ? maximum : null;
}

/** 추출한 쪽 목록이 있으면 그 수(글 없는 뒤쪽까지), 없으면 청크로 센다. */
function pageCountFor(extracted, chunks) {
  return extracted?.pages?.length || pageCountForChunks(chunks);
}

/** 글자 층이 없는 스캔 PDF 는 청크 없이 쪽만으로 저장한다. 다른 형식의 빈 글은 실패다. */
function isTextlessPdf(name, extracted) {
  return path.extname(name).toLowerCase() === '.pdf' && Boolean(extracted?.pages?.length);
}

export class ReferenceStore {
  /**
   * @param {object} [options]
   * @param {'legacy'|'project'} [options.format] legacy = 옛 빌드와 같은 references/, project = 프로젝트 파일.
   * @param {string|null} [options.textCacheDir] 옛 추출 판 객체를 지금 판으로 다시 추출한 결과를 두는 곳.
   *   legacy 루트 밖이어야 한다(옛 빌드가 모르는 파일을 지운다). null 이면 다시 추출하지 않는다.
   */
  constructor({
    format = 'legacy',
    root = defaultReferenceRoot(),
    projectRoot = null,
    textCacheDir = null,
    textVersion = EXTRACTOR_TEXT_VERSION,
    maxFileBytes,
    maxScopeBytes,
    maxChatFiles = DEFAULT_MAX_CHAT_FILES,
    maxDocumentFiles = DEFAULT_MAX_DOCUMENT_FILES,
    maxGlobalFiles = DEFAULT_MAX_GLOBAL_FILES,
    maxProjectFiles = PROJECT_REFERENCE_LIMITS.maxProjectFiles,
    maxMetadataBytes,
    maxMetadataRecords,
    maxTotalBytes,
    maxTotalFiles,
    maxExtractedChars,
    maxStartupIndexChars = DEFAULT_MAX_STARTUP_INDEX_CHARS,
    maxResidentIndexChars = DEFAULT_MAX_RESIDENT_INDEX_CHARS,
    maxResidentIndexTokens = DEFAULT_MAX_RESIDENT_INDEX_TOKENS,
    maxIndexTokensPerObject = DEFAULT_MAX_INDEX_TOKENS_PER_OBJECT,
    now = () => new Date().toISOString(),
    createId = () => crypto.randomUUID(),
    persistMetadata = atomicWriteJson,
    stagedReferenceTtlMs = DEFAULT_STAGED_REFERENCE_TTL_MS,
    platform = process.platform,
    logger = null,
  } = {}) {
    if (format !== 'legacy' && format !== 'project') {
      throw new ReferenceStoreError('REFERENCE_CONFIG_INVALID', 'format must be legacy or project');
    }
    const project = format === 'project';
    maxFileBytes ??= project ? PROJECT_REFERENCE_LIMITS.maxFileBytes : DEFAULT_MAX_FILE_BYTES;
    maxScopeBytes ??= project ? PROJECT_REFERENCE_LIMITS.maxScopeBytes : DEFAULT_MAX_SCOPE_BYTES;
    maxMetadataBytes ??= project ? PROJECT_REFERENCE_LIMITS.maxMetadataBytes : DEFAULT_MAX_REFERENCE_METADATA_BYTES;
    maxMetadataRecords ??= project ? PROJECT_REFERENCE_LIMITS.maxMetadataRecords : DEFAULT_MAX_REFERENCE_RECORDS;
    maxTotalBytes ??= project ? PROJECT_REFERENCE_LIMITS.maxTotalBytes : DEFAULT_MAX_REFERENCE_TOTAL_BYTES;
    maxTotalFiles ??= project ? PROJECT_REFERENCE_LIMITS.maxTotalFiles : DEFAULT_MAX_REFERENCE_TOTAL_FILES;
    maxExtractedChars ??= project ? PROJECT_REFERENCE_LIMITS.maxExtractedChars : DEFAULT_MAX_REFERENCE_EXTRACTED_CHARS;
    for (const [name, value, allowZero] of [
      ['maxFileBytes', maxFileBytes, false],
      ['maxScopeBytes', maxScopeBytes, false],
      ['maxChatFiles', maxChatFiles, false],
      ['maxDocumentFiles', maxDocumentFiles, false],
      ['maxGlobalFiles', maxGlobalFiles, false],
      ['maxProjectFiles', maxProjectFiles, false],
      ['maxMetadataBytes', maxMetadataBytes, false],
      ['maxMetadataRecords', maxMetadataRecords, false],
      ['maxTotalBytes', maxTotalBytes, false],
      ['maxTotalFiles', maxTotalFiles, false],
      ['maxExtractedChars', maxExtractedChars, false],
      ['maxStartupIndexChars', maxStartupIndexChars, true],
      ['maxResidentIndexChars', maxResidentIndexChars, false],
      ['maxResidentIndexTokens', maxResidentIndexTokens, false],
      ['maxIndexTokensPerObject', maxIndexTokensPerObject, false],
      ['stagedReferenceTtlMs', stagedReferenceTtlMs, false],
      ['textVersion', textVersion, false],
    ]) {
      if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
        throw new ReferenceStoreError(
          'REFERENCE_CONFIG_INVALID',
          `${name} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer`,
        );
      }
    }
    this.format = format;
    this.scopes = project ? PROJECT_SCOPES : LEGACY_SCOPES;
    this.root = path.resolve(root);
    this.blobsDir = path.join(this.root, 'blobs');
    this.objectsDir = path.join(this.root, 'objects');
    this.stagingDir = path.join(this.root, 'staging');
    this.metadataPath = path.join(this.root, 'metadata.json');
    this.textCacheDir = textCacheDir ? path.resolve(textCacheDir) : null;
    if (this.textCacheDir && (this.textCacheDir === this.root || this.textCacheDir.startsWith(`${this.root}${path.sep}`))) {
      throw new ReferenceStoreError('REFERENCE_CONFIG_INVALID', 'textCacheDir must be outside the reference root');
    }
    this.textVersion = textVersion;
    this.projectRoot = projectRoot ? path.resolve(projectRoot) : null;
    this.maxFileBytes = maxFileBytes;
    this.maxScopeBytes = maxScopeBytes;
    this.maxFiles = { chat: maxChatFiles, document: maxDocumentFiles, global: maxGlobalFiles, project: maxProjectFiles };
    this.maxMetadataBytes = maxMetadataBytes;
    this.maxMetadataRecords = maxMetadataRecords;
    this.maxTotalBytes = maxTotalBytes;
    this.maxTotalFiles = maxTotalFiles;
    // legacy 는 옛 빌드와 같은 4,096 개. 프로젝트 파일은 고유 파일마다 blob·객체가 생겨 전체 상한을 따른다.
    this.maxStorageDirectoryEntries = project
      ? Math.max(MIN_STORAGE_DIRECTORY_ENTRIES, maxTotalFiles + 64)
      : MIN_STORAGE_DIRECTORY_ENTRIES;
    this.maxExtractedChars = maxExtractedChars;
    this.maxStartupIndexChars = Math.min(maxStartupIndexChars, maxResidentIndexChars);
    this.maxResidentIndexChars = maxResidentIndexChars;
    this.maxResidentIndexTokens = maxResidentIndexTokens;
    this.maxIndexTokensPerObject = Math.min(maxIndexTokensPerObject, maxResidentIndexTokens);
    this.now = now;
    this.createId = createId;
    this.persistMetadata = persistMetadata;
    this.stagedReferenceTtlMs = stagedReferenceTtlMs;
    this.platform = platform;
    this.logger = logger;
    this.metadata = { files: [], aliases: {}, shadows: [] };
    this.interim = null;
    this.shadowCache = null;
    this.metadataPhysicalBytes = 0;
    this.objects = new Map();
    this.indexChunks = new Map();
    this.postings = new Map();
    this.totalTokenCount = 0;
    this.residentIndexChars = 0;
    this.residentIndexTokens = 0;
    this.indexTokenCounts = new Map();
    this.indexAccess = new Map();
    this.indexClock = 0;
    this.physicalObjects = new Map();
    this.stagedFiles = new Map();
    this.quotaReservations = new Map();
    this.quarantinedUploads = new Map();
    this.inFlightStages = new Set();
    this.activeScopeOperations = new Map();
    this.scopePins = new Map();
    this.writeQueue = Promise.resolve();
    // 메타데이터 그룹 커밋: 쓰기가 진행 중일 때 들어온 변경은 다음 한 번의 쓰기로 묶인다.
    this.commitWaiters = [];
    this.commitLoop = null;
    this.promotionQueue = Promise.resolve();
    this.indexQueue = Promise.resolve();
    // 옛 판으로 추출된 객체를 백그라운드에서 다시 추출한다(한 번에 하나).
    this.upgradeQueue = Promise.resolve();
    this.upgradesPending = new Set();
    this.upgradeFailures = new Set();
  }

  /** 디스크에 쓰는 모양. legacy 는 옛 빌드가 읽는 그대로(schemaVersion 1, 기록 필드만)다. */
  #serializableMetadata(metadata = this.metadata) {
    if (this.format === 'project') {
      return {
        schemaVersion: PROJECT_METADATA_SCHEMA_VERSION,
        files: metadata.files,
        aliases: metadata.aliases,
        shadows: metadata.shadows,
      };
    }
    return {
      schemaVersion: LEGACY_METADATA_SCHEMA_VERSION,
      files: metadata.files.map(({ pageCount: _pageCount, ...record }) => record),
    };
  }

  async init() {
    await ensurePlainDirectory(this.root);
    await ensurePlainDirectory(this.blobsDir);
    await ensurePlainDirectory(this.objectsDir);
    await ensurePlainDirectory(this.stagingDir);
    if (this.textCacheDir) await ensurePlainDirectory(this.textCacheDir);
    await recoverInterruptedFileReplacement(this.metadataPath, {
      platform: this.platform,
    });
    let rewrite = false;
    try {
      const serialized = await readPlainUtf8FileBounded(
        this.metadataPath,
        this.maxMetadataBytes,
        'Reference metadata',
      );
      preflightTopLevelArrayCount(serialized, 'files', this.maxMetadataRecords);
      const loaded = validateMetadata(JSON.parse(serialized), this.maxMetadataRecords, this.format);
      this.metadata = loaded.metadata;
      this.interim = loaded.interim;
      rewrite = loaded.rewrite === true && !loaded.interim;
      this.metadataPhysicalBytes = Buffer.byteLength(serialized, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error instanceof ReferenceStoreError) throw error;
        throw new ReferenceStoreError('REFERENCE_STORE_CORRUPT', `Could not read reference metadata: ${error?.message ?? error}`);
      }
      rewrite = true;
    }
    if (rewrite) {
      const serializable = this.#serializableMetadata();
      await atomicWriteJson(this.metadataPath, serializable, { platform: this.platform });
      this.metadataPhysicalBytes = Buffer.byteLength(JSON.stringify(serializable), 'utf8') + 1;
    }
    await this.#loadPhysicalObjects();
    await this.#loadStagedFiles();
    await this.#loadTextCache();
    this.#assertCurrentUsage();
    await this.#preloadRecentIndexes();
    return this;
  }

  /**
   * 잠시 쓰였던 v2 references/metadata.json 에 들어 있던 project 범위 기록. 호출자가 프로젝트 파일
   * 저장소로 옮긴 뒤 releaseInterim() 을 부르면 그때 v1 로 다시 쓴다.
   */
  interimRecords() {
    if (!this.interim) return [];
    return this.interim.files.map((record) => ({
      record: { ...record },
      blobPath: this.#blobPath(record.sha256),
      objectPath: this.#objectPath(record.sha256),
      cachePath: this.#cachePath(record.sha256),
    }));
  }

  interimAliases() {
    return { ...(this.interim?.aliases ?? {}) };
  }

  async releaseInterim() {
    if (!this.interim) return;
    const released = this.interim.files;
    await this.#exclusive(async () => {
      this.interim = null;
      await this.#persist({});
      for (const sha256 of new Set(released.map((record) => record.sha256))) {
        if (this.metadata.files.some((record) => record.sha256 === sha256)) continue;
        await this.#deletePhysicalObject(sha256);
      }
    });
  }

  #assertScopeHere(scoped) {
    if (!this.scopes.includes(scoped.scope)) {
      throw new ReferenceStoreError('REFERENCE_SCOPE_INVALID', `${scoped.scope} references are not stored here`);
    }
    return scoped;
  }

  #exclusive(task) {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.catch(() => undefined);
    return run;
  }


  #scopeUsageEntry(map, scope, scopeId) {
    const key = scopeKey(scope, scopeId);
    let usage = map.get(key);
    if (!usage) {
      usage = { scope, scopeId, files: 0, bytes: 0 };
      map.set(key, usage);
    }
    return usage;
  }

  #usage({
    excludeReservations = new Set(),
    excludeStages = new Set(),
    excludeExtractedReservations = new Set(),
    excludeExtractedStages = new Set(),
    excludeLogicalReservations = new Set(),
    excludeLogicalStages = new Set(),
  } = {}) {
    const scopes = new Map();
    const uniqueReady = new Map();
    let metadataRecords = this.metadata.files.length;
    for (const record of this.metadata.files) {
      const scoped = this.#scopeUsageEntry(scopes, record.scope, record.scopeId);
      scoped.files += 1;
      scoped.bytes += record.size;
      const existing = uniqueReady.get(record.sha256);
      if (existing && (existing.size !== record.size || existing.extractedChars !== record.extractedChars)) {
        throw metadataCorrupt('Deduplicated reference metadata has inconsistent sizes');
      }
      uniqueReady.set(record.sha256, {
        size: record.size,
        extractedChars: record.extractedChars,
      });
    }
    let totalBytes = 0;
    let totalFiles = 0;
    let extractedChars = 0;
    for (const ready of uniqueReady.values()) {
      extractedChars += ready.extractedChars;
    }
    if (this.metadataPhysicalBytes > 0) {
      totalFiles += 1;
      totalBytes += this.metadataPhysicalBytes;
    }
    for (const physical of this.physicalObjects.values()) {
      if (physical.blobBytes !== null) {
        totalFiles += 1;
        totalBytes += physical.blobBytes;
      }
      if (physical.objectBytes !== null) {
        totalFiles += 1;
        totalBytes += physical.objectBytes;
      }
    }
    for (const [stageId, staged] of this.stagedFiles) {
      if (excludeStages.has(stageId)) continue;
      if (!excludeLogicalStages.has(stageId)) {
        const scoped = this.#scopeUsageEntry(scopes, staged.scope, staged.scopeId);
        scoped.files += 1;
        scoped.bytes += staged.size;
      }
      const metadataBytes = Buffer.byteLength(JSON.stringify({
        id: staged.id,
        scope: staged.scope,
        scopeId: staged.scopeId,
        name: staged.name,
        mimeType: staged.mimeType,
        size: staged.size,
        createdAt: staged.createdAt,
        expiresAt: staged.expiresAt,
      }), 'utf8') + 1;
      // A live draft owns data + metadata. Until promotion commits, it also
      // reserves one same-size upload copy so promotion cannot deadlock at the
      // disk ceiling. A completed promotion no longer needs that headroom.
      totalFiles += staged.promotionComplete ? 2 : 3;
      totalBytes += staged.size + metadataBytes + (staged.promotionComplete ? 0 : staged.size);
      if (!excludeLogicalStages.has(stageId)
        && !excludeExtractedStages.has(stageId)
        && !staged.promotionComplete) {
        extractedChars += extractedReservationFor(staged.name, staged.size);
      }
    }
    for (const quarantined of this.quarantinedUploads.values()) {
      if (quarantined.coveredByStageId
        && this.stagedFiles.has(quarantined.coveredByStageId)
        && !this.stagedFiles.get(quarantined.coveredByStageId).promotionComplete) continue;
      totalFiles += 1;
      totalBytes += quarantined.size;
    }
    for (const [reservationId, reservation] of this.quotaReservations) {
      if (excludeReservations.has(reservationId)) continue;
      totalFiles += reservation.globalFiles;
      totalBytes += reservation.globalBytes;
      if (!excludeLogicalReservations.has(reservationId)) {
        metadataRecords += reservation.metadataRecords;
      }
      if (!excludeLogicalReservations.has(reservationId)
        && !excludeExtractedReservations.has(reservationId)) {
        extractedChars += reservation.extractedChars;
      }
      if (!excludeLogicalReservations.has(reservationId)
        && (reservation.scopeFiles || reservation.scopeBytes)) {
        const scoped = this.#scopeUsageEntry(scopes, reservation.scope, reservation.scopeId);
        scoped.files += reservation.scopeFiles;
        scoped.bytes += reservation.scopeBytes;
      }
    }
    return { scopes, uniqueReady, totalFiles, totalBytes, extractedChars, metadataRecords };
  }

  #assertUsageWithinLimits(usage) {
    if (usage.totalFiles > this.maxTotalFiles) {
      throw new ReferenceStoreError(
        'REFERENCE_GLOBAL_FILE_COUNT_LIMIT',
        `Reference storage exceeds the ${this.maxTotalFiles}-file global limit`,
      );
    }
    if (usage.totalBytes > this.maxTotalBytes) {
      throw new ReferenceStoreError(
        'REFERENCE_GLOBAL_SIZE_LIMIT',
        `Reference storage exceeds the ${this.maxTotalBytes}-byte global limit`,
      );
    }
    if (usage.extractedChars > this.maxExtractedChars) {
      throw new ReferenceStoreError(
        'REFERENCE_GLOBAL_EXTRACTED_LIMIT',
        `Reference indexes exceed the ${this.maxExtractedChars}-character global limit`,
      );
    }
    for (const scoped of usage.scopes.values()) {
      if (scoped.files > this.maxFiles[scoped.scope]) {
        throw new ReferenceStoreError(
          'REFERENCE_FILE_COUNT_LIMIT',
          `${scoped.scope} scope already has ${this.maxFiles[scoped.scope]} reference files`,
        );
      }
      if (scoped.bytes > this.maxScopeBytes) {
        throw new ReferenceStoreError(
          'REFERENCE_SCOPE_SIZE_LIMIT',
          `${scoped.scope} references exceed the ${this.maxScopeBytes}-byte scope limit`,
        );
      }
    }
  }

  #assertCurrentUsage() {
    this.#assertUsageWithinLimits(this.#usage());
    if (this.metadata.files.length > this.maxMetadataRecords) {
      throw new ReferenceStoreError(
        'REFERENCE_METADATA_RECORD_LIMIT',
        `Reference metadata exceeds the ${this.maxMetadataRecords}-record limit`,
      );
    }
  }

  #assertProjectedReference({
    scope,
    scopeId,
    bytes,
    sha256 = null,
    extractedChars = 0,
    globalFiles = 1,
    globalBytes = bytes,
    scopeFiles = 1,
    scopeBytes = bytes,
    excludeReservations = new Set(),
    excludeStages = new Set(),
    excludeExtractedReservations = new Set(),
    excludeExtractedStages = new Set(),
    metadataRecords = 0,
  }) {
    const usage = this.#usage({
      excludeReservations,
      excludeStages,
      excludeExtractedReservations,
      excludeExtractedStages,
    });
    const scoped = this.#scopeUsageEntry(usage.scopes, scope, scopeId);
    scoped.files += scopeFiles;
    scoped.bytes += scopeBytes;
    usage.totalFiles += globalFiles;
    usage.totalBytes += globalBytes;
    usage.metadataRecords += metadataRecords;
    if (sha256 && usage.uniqueReady.has(sha256)) {
      const existing = usage.uniqueReady.get(sha256);
      if (existing.size !== bytes) throw metadataCorrupt('Deduplicated reference size does not match');
    } else {
      usage.extractedChars += extractedChars;
    }
    this.#assertUsageWithinLimits(usage);
    if (usage.metadataRecords > this.maxMetadataRecords) {
      throw new ReferenceStoreError(
        'REFERENCE_METADATA_RECORD_LIMIT',
        `Reference metadata exceeds the ${this.maxMetadataRecords}-record limit`,
      );
    }
  }

  async #reserveUpload(scoped, reservedBytes, {
    kind = 'ready',
    transferStageId = null,
    extractedChars = 0,
  } = {}) {
    return this.#exclusive(() => {
      let stage = null;
      if (transferStageId) {
        stage = this.stagedFiles.get(transferStageId);
        if (!stage || stage.scope !== scoped.scope || stage.scopeId !== scoped.scopeId) {
          throw new ReferenceStoreError('REFERENCE_STAGE_NOT_FOUND', 'Staged reference was not found in this chat');
        }
        if (this.inFlightStages.has(transferStageId)) {
          throw new ReferenceStoreError('REFERENCE_SCOPE_BUSY', 'Staged reference promotion is already in progress');
        }
        this.inFlightStages.add(transferStageId);
      }
      try {
        const projection = kind === 'stage'
          ? {
            globalFiles: 3,
            globalBytes: (reservedBytes * 2) + MAX_STAGED_METADATA_BYTES,
            scopeFiles: 1,
            scopeBytes: reservedBytes,
            metadataRecords: 0,
          }
          : transferStageId
            ? {
              globalFiles: 0,
              globalBytes: 0,
              scopeFiles: 0,
              scopeBytes: 0,
              metadataRecords: 1,
            }
            : {
              globalFiles: 1,
              globalBytes: reservedBytes,
              scopeFiles: 1,
              scopeBytes: reservedBytes,
              metadataRecords: 1,
            };
        this.#assertProjectedReference({
          ...scoped,
          bytes: reservedBytes,
          extractedChars,
          ...projection,
        });
        const reservationId = crypto.randomUUID();
        this.quotaReservations.set(reservationId, {
          reservationId,
          ...scoped,
          reservedBytes,
          extractedChars,
          transferStageId,
          ...projection,
        });
        return reservationId;
      } catch (error) {
        if (transferStageId) this.inFlightStages.delete(transferStageId);
        throw error;
      }
    });
  }

  #finishReservation(reservationId) {
    const reservation = this.quotaReservations.get(reservationId);
    if (!reservation) return;
    this.quotaReservations.delete(reservationId);
    if (reservation.transferStageId) this.inFlightStages.delete(reservation.transferStageId);
  }

  async #releaseReservation(reservationId, { quarantinePath = null, size = 0 } = {}) {
    await this.#exclusive(() => {
      const reservation = this.quotaReservations.get(reservationId);
      if (!reservation) return;
      this.#finishReservation(reservationId);
      if (quarantinePath) {
        this.quarantinedUploads.set(quarantinePath, {
          path: quarantinePath,
          size: Math.max(0, size),
          createdAt: Date.parse(this.now()),
          coveredByStageId: reservation.transferStageId,
        });
        this.#assertCurrentUsage();
      }
    });
  }

  async #readStagedFromDisk(stageId) {
    const metadataPath = this.#stagedMetadataPath(stageId);
    const serialized = await readPlainUtf8FileBounded(
      metadataPath,
      MAX_STAGED_METADATA_BYTES,
      'Staged reference metadata',
    );
    let raw;
    try {
      raw = JSON.parse(serialized);
    } catch {
      throw metadataCorrupt('Staged reference metadata is invalid');
    }
    if (!isPlainObject(raw)
      || raw.id !== stageId
      || raw.scope !== 'chat'
      || typeof raw.scopeId !== 'string'
      || typeof raw.name !== 'string'
      || typeof raw.mimeType !== 'string'
      || !Number.isSafeInteger(raw.size)
      || raw.size <= 0
      || raw.size > this.maxFileBytes
      || typeof raw.createdAt !== 'string'
      || !Number.isFinite(Date.parse(raw.createdAt))
      || typeof raw.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(raw.expiresAt))) {
      throw metadataCorrupt('Staged reference metadata is invalid');
    }
    const scoped = normalizeReferenceScope('chat', raw.scopeId);
    const name = sanitizeReferenceName(raw.name);
    if (scoped.scopeId !== raw.scopeId || name !== raw.name || normalizeMime(raw.mimeType) !== raw.mimeType) {
      throw metadataCorrupt('Staged reference metadata is invalid');
    }
    const dataPath = this.#stagedDataPath(stageId);
    const dataInfo = await fs.lstat(dataPath).catch((error) => {
      if (error?.code === 'ENOENT') {
        throw new ReferenceStoreError('REFERENCE_STAGE_NOT_FOUND', 'Staged reference data was not found');
      }
      throw error;
    });
    if (!dataInfo.isFile() || dataInfo.isSymbolicLink() || dataInfo.size !== raw.size) {
      throw metadataCorrupt('Staged reference data does not match its metadata');
    }
    return { ...raw, ...scoped, status: 'ready' };
  }

  async #boundedDirectoryEntries(directory, label, maximum = this.maxStorageDirectoryEntries) {
    const entries = [];
    const handle = await fs.opendir(directory);
    try {
      for await (const entry of handle) {
        entries.push(entry.name);
        if (entries.length > maximum) {
          throw new ReferenceStoreError(
            'REFERENCE_GLOBAL_FILE_COUNT_LIMIT',
            `${label} contains more than ${maximum} entries`,
          );
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    return entries;
  }

  async #loadPhysicalObjects() {
    const referenced = new Map();
    for (const record of [...this.metadata.files, ...(this.interim?.files ?? [])]) {
      if (!referenced.has(record.sha256)) referenced.set(record.sha256, record);
    }
    const loadDirectory = async (directory, kind) => {
      const entries = await this.#boundedDirectoryEntries(directory, `Reference ${kind} storage`);
      for (const entry of entries) {
        const match = kind === 'blob'
          ? /^([a-f0-9]{64})$/.exec(entry)
          : /^([a-f0-9]{64})\.json$/.exec(entry);
        const file = path.join(directory, entry);
        const info = await fs.lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || !Number.isSafeInteger(info.size) || info.size < 1) {
          throw new ReferenceStoreError('REFERENCE_PATH_UNSAFE', `Reference storage entry is not a plain file: ${file}`);
        }
        const sha256 = match?.[1] ?? null;
        const expected = sha256 ? referenced.get(sha256) : null;
        if (!expected) {
          this.quarantinedUploads.set(file, {
            path: file,
            size: info.size,
            createdAt: info.mtimeMs,
          });
          continue;
        }
        if (kind === 'blob' && info.size !== expected.size) {
          throw metadataCorrupt(`Reference blob size does not match metadata for sha256:${sha256}`);
        }
        if (kind === 'object' && info.size > MAX_REFERENCE_OBJECT_BYTES) {
          throw new ReferenceStoreError(
            'REFERENCE_GLOBAL_SIZE_LIMIT',
            `Reference search index exceeds the ${MAX_REFERENCE_OBJECT_BYTES}-byte object limit`,
          );
        }
        const physical = this.physicalObjects.get(sha256) ?? { blobBytes: null, objectBytes: null };
        physical[`${kind}Bytes`] = info.size;
        this.physicalObjects.set(sha256, physical);
      }
    };
    await loadDirectory(this.blobsDir, 'blob');
    await loadDirectory(this.objectsDir, 'object');
    const rootEntries = await this.#boundedDirectoryEntries(this.root, 'Reference root');
    for (const entry of rootEntries) {
      if (entry === 'metadata.json' || entry === 'blobs' || entry === 'objects' || entry === 'staging') continue;
      const file = path.join(this.root, entry);
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new ReferenceStoreError('REFERENCE_PATH_UNSAFE', `Unexpected reference root entry: ${file}`);
      }
      this.quarantinedUploads.set(file, { path: file, size: info.size, createdAt: info.mtimeMs });
    }
  }

  async #loadStagedFiles() {
    const entries = await this.#boundedDirectoryEntries(
      this.stagingDir,
      'Reference staging',
      MAX_STAGING_DIRECTORY_ENTRIES,
    ).catch((error) => {
      if (error?.code === 'REFERENCE_GLOBAL_FILE_COUNT_LIMIT') {
        throw new ReferenceStoreError(
          'REFERENCE_STAGING_ENTRY_LIMIT',
          `Reference staging contains more than ${MAX_STAGING_DIRECTORY_ENTRIES} entries`,
        );
      }
      throw error;
    });
    const now = Date.parse(this.now());
    for (const entry of entries) {
      const match = /^\.draft-([A-Za-z0-9_-]{1,128})\.json$/.exec(entry);
      if (!match) continue;
      const stageId = match[1];
      try {
        const staged = await this.#readStagedFromDisk(stageId);
        if (Date.parse(staged.expiresAt) <= now) {
          await Promise.all([
            this.#unlinkOrQuarantine(this.#stagedDataPath(stageId), staged.size),
            this.#unlinkOrQuarantine(this.#stagedMetadataPath(stageId), MAX_STAGED_METADATA_BYTES),
          ]);
        } else {
          this.stagedFiles.set(stageId, staged);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT'
          && error?.code !== 'REFERENCE_STAGE_NOT_FOUND'
          && error?.code !== 'REFERENCE_STORE_CORRUPT'
          && error?.code !== 'REFERENCE_METADATA_TOO_LARGE'
          && error?.code !== 'REFERENCE_PATH_UNSAFE') throw error;
        const dataInfo = await fs.lstat(this.#stagedDataPath(stageId)).catch(() => null);
        const metadataInfo = await fs.lstat(this.#stagedMetadataPath(stageId)).catch(() => null);
        await Promise.all([
          this.#unlinkOrQuarantine(this.#stagedDataPath(stageId), dataInfo?.size ?? 0),
          this.#unlinkOrQuarantine(this.#stagedMetadataPath(stageId), metadataInfo?.size ?? 0),
        ]);
      }
    }
    for (const entry of entries) {
      const draft = /^\.draft-([A-Za-z0-9_-]{1,128})\.bin$/.exec(entry);
      const draftMetadata = /^\.draft-([A-Za-z0-9_-]{1,128})\.json$/.exec(entry);
      const upload = /^\.upload-[A-Za-z0-9_-]{1,128}(?:\.[A-Za-z0-9_-]{1,30})?$/.test(entry)
        || /^\.upload-p-([a-f0-9]{64})-[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,30})?$/.test(entry);
      if (draftMetadata && this.stagedFiles.has(draftMetadata[1])) continue;
      if (draft && this.stagedFiles.has(draft[1])) continue;
      const file = path.join(this.stagingDir, entry);
      const info = await fs.lstat(file).catch(() => null);
      if (!info) continue;
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new ReferenceStoreError('REFERENCE_PATH_UNSAFE', `Unexpected reference staging entry: ${file}`);
      }
      if (info.mtimeMs + this.stagedReferenceTtlMs <= now) {
        await this.#unlinkOrQuarantine(file, info.size);
      } else {
        const promotion = upload ? /^\.upload-p-([a-f0-9]{64})-/.exec(entry) : null;
        const coveredByStageId = promotion
          ? [...this.stagedFiles.keys()].find((stageId) => (
            crypto.createHash('sha256').update(stageId).digest('hex') === promotion[1]
          )) ?? null
          : null;
        this.quarantinedUploads.set(file, {
          path: file,
          size: info.size,
          createdAt: info.mtimeMs,
          coveredByStageId,
        });
      }
    }
  }

  async #preloadRecentIndexes() {
    let remaining = this.maxStartupIndexChars;
    const seen = new Set();
    const records = this.metadata.files
      .filter((file) => file.status === 'ready' && file.extractedChars > 0)
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    for (const record of records) {
      if (seen.has(record.sha256)) continue;
      seen.add(record.sha256);
      if (record.extractedChars > remaining) continue;
      try {
        const object = await this.#currentObject(record.sha256, record, { upgrade: false });
        this.#indexObject(object, { protectedShas: seen });
        remaining -= object.extractedChars;
      } catch {
        // The bounded startup slice is opportunistic. Scoped activation reports
        // corrupt indexes when that exact reference is next used.
      }
      if (remaining <= 0) break;
    }
  }

  #blobPath(sha256) {
    return path.join(this.blobsDir, sha256);
  }

  #objectPath(sha256) {
    return path.join(this.objectsDir, `${sha256}.json`);
  }

  #stagedDataPath(stageId) {
    return path.join(this.stagingDir, `.draft-${stageId}.bin`);
  }

  #stagedMetadataPath(stageId) {
    return path.join(this.stagingDir, `.draft-${stageId}.json`);
  }

  #trackQuarantinedFile(file, size, { coveredByStageId = null } = {}) {
    this.quarantinedUploads.set(file, {
      path: file,
      size: Math.max(0, size),
      createdAt: Date.parse(this.now()),
      coveredByStageId,
    });
  }

  async #unlinkOrQuarantine(file, size, { coveredByStageId = null } = {}) {
    try {
      await fs.unlink(file);
      this.quarantinedUploads.delete(file);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.quarantinedUploads.delete(file);
        return true;
      }
      this.#trackQuarantinedFile(file, size, { coveredByStageId });
      return false;
    }
  }

  async #readStaged(stageId) {
    if (!isSafeRecordId(stageId)) {
      throw new ReferenceStoreError('REFERENCE_STAGE_ID_INVALID', 'Invalid staged reference id');
    }
    const staged = this.stagedFiles.get(stageId);
    if (!staged) throw new ReferenceStoreError('REFERENCE_STAGE_NOT_FOUND', 'Staged reference was not found');
    return staged;
  }

  async stageStream({ stream, name, mimeType, scopeId, contentLength }) {
    const scoped = this.#assertScopeHere(normalizeReferenceScope('chat', scopeId));
    const safeName = sanitizeReferenceName(name);
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && (!Number.isSafeInteger(declared) || declared <= 0 || declared > this.maxFileBytes)) {
      throw new ReferenceStoreError('REFERENCE_FILE_TOO_LARGE', `Reference files must be 1-${this.maxFileBytes} bytes`);
    }
    const stageId = requireGeneratedId(this.createId());
    const reservedBytes = Number.isFinite(declared) ? declared : this.maxFileBytes;
    const extractedChars = extractedReservationFor(safeName, reservedBytes);
    const reservationId = await this.#reserveUpload(scoped, reservedBytes, {
      kind: 'stage',
      extractedChars,
    });
    const dataPath = this.#stagedDataPath(stageId);
    let handle;
    let size = 0;
    try {
      handle = await fs.open(dataPath, 'wx', 0o600);
      try {
        for await (const raw of stream) {
          const chunk = Buffer.from(raw);
          size += chunk.length;
          if (size > this.maxFileBytes) {
            throw new ReferenceStoreError('REFERENCE_FILE_TOO_LARGE', `Reference file exceeds the ${this.maxFileBytes}-byte limit`);
          }
          if (size > reservedBytes) {
            throw new ReferenceStoreError('REFERENCE_SIZE_MISMATCH', 'Reference upload exceeds its declared length');
          }
          await handle.write(chunk);
        }
        await handle.sync();
      } finally {
        await handle.close();
        handle = null;
      }
      if (size === 0) throw new ReferenceStoreError('REFERENCE_FILE_EMPTY', 'Reference file is empty');
      if (Number.isFinite(declared) && declared !== size) {
        throw new ReferenceStoreError('REFERENCE_SIZE_MISMATCH', 'Reference upload length did not match Content-Length');
      }
      let resolvedMime = normalizeMime(mimeType);
      if (referenceKindForName(safeName) === 'image') {
        const inspected = await inspectReferenceImage({ filePath: dataPath, name: safeName, mimeType });
        resolvedMime = inspected.mimeType;
      }
      const createdAt = this.now();
      const expiresAt = new Date(Date.parse(createdAt) + this.stagedReferenceTtlMs).toISOString();
      const staged = {
        id: stageId,
        ...scoped,
        name: safeName,
        mimeType: resolvedMime,
        size,
        createdAt,
        expiresAt,
      };
      await atomicWriteJson(this.#stagedMetadataPath(stageId), staged, {
        onRetainedTemp: (file, bytes) => this.#trackQuarantinedFile(file, bytes),
        platform: this.platform,
      });
      await this.#exclusive(() => {
        if (this.stagedFiles.has(stageId)) {
          throw new ReferenceStoreError('REFERENCE_ID_CONFLICT', 'Could not allocate a unique staged reference id');
        }
        this.#assertProjectedReference({
          ...scoped,
          bytes: size,
          extractedChars: extractedReservationFor(safeName, size),
          globalFiles: 3,
          globalBytes: (size * 2) + Buffer.byteLength(JSON.stringify(staged), 'utf8') + 1,
          excludeReservations: new Set([reservationId]),
        });
        this.stagedFiles.set(stageId, { ...staged, status: 'ready' });
        this.#finishReservation(reservationId);
      });
      return { ...staged, status: 'ready' };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await this.#unlinkOrQuarantine(dataPath, size);
      await this.#unlinkOrQuarantine(this.#stagedMetadataPath(stageId), MAX_STAGED_METADATA_BYTES);
      await this.#releaseReservation(reservationId);
      await this.#exclusive(() => this.#assertCurrentUsage());
      throw error;
    }
  }

  async getStaged({ stageId, scopeId }) {
    const staged = await this.#readStaged(stageId);
    const scoped = normalizeReferenceScope('chat', scopeId);
    if (staged.scopeId !== scoped.scopeId) {
      throw new ReferenceStoreError('REFERENCE_STAGE_NOT_FOUND', 'Staged reference was not found in this chat');
    }
    if (Date.parse(staged.expiresAt) <= Date.parse(this.now())) {
      await this.discardStaged({ stageId, scopeId });
      throw new ReferenceStoreError('REFERENCE_STAGE_EXPIRED', 'Staged reference has expired');
    }
    return staged;
  }

  async discardStaged({ stageId, scopeId }) {
    const staged = await this.#readStaged(stageId);
    const scoped = normalizeReferenceScope('chat', scopeId);
    if (staged.scopeId !== scoped.scopeId) {
      throw new ReferenceStoreError('REFERENCE_STAGE_NOT_FOUND', 'Staged reference was not found in this chat');
    }
    return this.#exclusive(async () => {
      if (this.inFlightStages.has(stageId)) {
        throw new ReferenceStoreError('REFERENCE_SCOPE_BUSY', 'Staged reference promotion is in progress');
      }
      await this.#discardStagedLocked(stageId, staged);
      return { ...staged, status: 'discarded' };
    });
  }

  async promoteStaged({ stageId, scopeId }) {
    const promote = this.promotionQueue.then(async () => {
      const staged = await this.getStaged({ stageId, scopeId });
      return this.addStream({
        stream: createReadStream(this.#stagedDataPath(stageId)),
        name: staged.name,
        mimeType: staged.mimeType,
        contentLength: staged.size,
        scope: 'chat',
        scopeId: staged.scopeId,
        transferStageId: stageId,
      });
    });
    this.promotionQueue = promote.then(() => undefined, () => undefined);
    return promote;
  }

  async cleanupStaged() {
    return this.#exclusive(async () => {
      const now = Date.parse(this.now());
      let removed = 0;
      for (const [stageId, staged] of [...this.stagedFiles]) {
        if (this.inFlightStages.has(stageId) || Date.parse(staged.expiresAt) > now) continue;
        await this.#discardStagedLocked(stageId, staged);
        removed += 1;
      }

      for (const [file, quarantined] of [...this.quarantinedUploads]) {
        if (quarantined.createdAt + this.stagedReferenceTtlMs > now) continue;
        try {
          await fs.unlink(file);
          this.quarantinedUploads.delete(file);
          removed += 1;
        } catch (error) {
          if (error?.code === 'ENOENT') {
            this.quarantinedUploads.delete(file);
            removed += 1;
          }
        }
      }
      this.#assertCurrentUsage();
      return removed;
    });
  }

  async #discardStagedLocked(stageId, staged) {
    const metadataPath = this.#stagedMetadataPath(stageId);
    const dataPath = this.#stagedDataPath(stageId);
    await fs.unlink(metadataPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    try {
      await fs.unlink(dataPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        const info = await fs.lstat(dataPath).catch(() => null);
        this.quarantinedUploads.set(dataPath, {
          path: dataPath,
          size: info?.isFile() && !info.isSymbolicLink() ? info.size : staged.size,
          createdAt: Date.parse(this.now()),
        });
      }
    }
    this.stagedFiles.delete(stageId);
    this.inFlightStages.delete(stageId);
    return staged;
  }

  /** 검색 객체 파일 하나를 검사해 읽는다. expected 가 있으면 기록의 글자 수·청크 수와 맞아야 한다. */
  async #parseObjectFile(file, sha256, expected) {
    if (!await pathIsPlainFile(file)) throw new ReferenceStoreError('REFERENCE_INDEX_MISSING', `Search index is missing for sha256:${sha256}`);
    const serialized = await readPlainUtf8FileBounded(
      file,
      MAX_REFERENCE_OBJECT_BYTES,
      `Reference search index sha256:${sha256}`,
    );
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new ReferenceStoreError('REFERENCE_STORE_CORRUPT', `Search index is corrupt for sha256:${sha256}`);
    }
    if (!isPlainObject(parsed) || parsed.schemaVersion !== OBJECT_SCHEMA_VERSION || parsed.sha256 !== sha256 || !Array.isArray(parsed.chunks)) {
      throw new ReferenceStoreError('REFERENCE_STORE_CORRUPT', `Search index is corrupt for sha256:${sha256}`);
    }
    const extractedChars = Number(parsed.extractedChars);
    if (!Number.isSafeInteger(extractedChars)
      || extractedChars < 0
      || extractedChars > this.maxExtractedChars
      || (expected && extractedChars !== expected.extractedChars)
      || (expected && parsed.chunks.length !== expected.chunkCount)
      || (extractedChars === 0 && parsed.chunks.length !== 0)
      || (extractedChars > 0 && parsed.chunks.length > extractedChars + 1)) {
      throw new ReferenceStoreError('REFERENCE_STORE_CORRUPT', `Search index size is corrupt for sha256:${sha256}`);
    }
    const chunkIds = new Set();
    let totalChunkChars = 0;
    return {
      schemaVersion: OBJECT_SCHEMA_VERSION,
      textVersion: Number.isSafeInteger(parsed.textVersion) && parsed.textVersion >= 1 ? parsed.textVersion : 1,
      sha256,
      extractedChars,
      chunks: parsed.chunks.map((chunk, index) => {
        if (!isPlainObject(chunk)
          || typeof chunk.id !== 'string'
          || !isSafeRecordId(chunk.id)
          || chunkIds.has(chunk.id)
          || !Number.isSafeInteger(chunk.start)
          || chunk.start < 0
          || !Number.isSafeInteger(chunk.end)
          || chunk.end < chunk.start
          || chunk.end > extractedChars
          || typeof chunk.text !== 'string'
          || chunk.text.length < 1
          || chunk.text.length > chunk.end - chunk.start
          || chunk.text.length > 1_200) {
          throw new ReferenceStoreError('REFERENCE_STORE_CORRUPT', `Search index chunk ${index} is corrupt for sha256:${sha256}`);
        }
        chunkIds.add(chunk.id);
        totalChunkChars += chunk.text.length;
        if (!Number.isSafeInteger(totalChunkChars)
          || totalChunkChars > extractedChars + (parsed.chunks.length * 180)) {
          throw new ReferenceStoreError('REFERENCE_STORE_CORRUPT', `Search index chunks are oversized for sha256:${sha256}`);
        }
        return {
          id: chunk.id,
          page: Number.isSafeInteger(chunk.page) ? chunk.page : null,
          start: chunk.start,
          end: chunk.end,
          text: chunk.text,
        };
      }),
    };
  }

  /**
   * 기록이 가리키는 원본 객체(objects/<sha>.json). 기록의 개수와 맞아야 한다. 이 파일은 한번 쓰면
   * 다시 쓰지 않는다 — 옛 빌드가 같은 파일을 같은 기록 개수로 읽는다.
   */
  async #readObject(sha256, expectedRecord = null) {
    const cached = this.objects.get(sha256);
    if (cached?.source === 'primary') {
      this.#touchIndex(sha256);
      return cached;
    }
    const expected = expectedRecord ?? this.metadata.files.find((record) => record.sha256 === sha256) ?? null;
    const object = await this.#parseObjectFile(this.#objectPath(sha256), sha256, expected);
    object.source = 'primary';
    return object;
  }

  #cachePath(sha256) {
    return this.textCacheDir ? path.join(this.textCacheDir, `${sha256}.t${this.textVersion}.json`) : null;
  }

  async #readCachedObject(sha256) {
    const file = this.#cachePath(sha256);
    if (!file) return null;
    try {
      const object = await this.#parseObjectFile(file, sha256, null);
      if (object.textVersion !== this.textVersion) return null;
      object.source = 'cache';
      return object;
    } catch (error) {
      if (error?.code !== 'REFERENCE_INDEX_MISSING') {
        await fs.unlink(file).catch(() => undefined);
      }
      return null;
    }
  }

  /**
   * 읽기·검색에 쓸 지금 판 객체. 원본이 옛 판이면 캐시를 쓰고, 캐시가 없으면 원본을 돌려주면서
   * 다시 추출을 예약한다(끝나면 상주 색인을 갈아 끼운다).
   */
  async #currentObject(sha256, record = null, { upgrade = true } = {}) {
    const resident = this.objects.get(sha256);
    if (resident && (resident.textVersion >= this.textVersion || !this.textCacheDir)) {
      this.#touchIndex(sha256);
      return resident;
    }
    const primary = await this.#readObject(sha256, record);
    if (primary.textVersion >= this.textVersion || !this.textCacheDir) return primary;
    const cached = await this.#readCachedObject(sha256);
    if (cached) return cached;
    if (upgrade) this.#scheduleUpgrade(sha256);
    return primary;
  }

  #scheduleUpgrade(sha256) {
    if (!this.textCacheDir || this.upgradesPending.has(sha256) || this.upgradeFailures.has(sha256)) return;
    this.upgradesPending.add(sha256);
    this.upgradeQueue = this.upgradeQueue
      .then(() => this.#upgradeObject(sha256))
      .catch((error) => {
        this.upgradeFailures.add(sha256);
        this.logger?.(`reference re-extraction failed for sha256:${sha256}: ${error?.message ?? error}`);
      })
      .finally(() => this.upgradesPending.delete(sha256));
  }

  /** 테스트·종료용: 예약된 다시 추출이 모두 끝날 때까지 기다린다. */
  async settleUpgrades() {
    while (this.upgradesPending.size > 0) await this.upgradeQueue;
  }

  async #upgradeObject(sha256) {
    const record = this.metadata.files.find((file) => file.sha256 === sha256 && file.status === 'ready');
    if (!record || referenceKindForName(record.name) === 'image') return;
    if (await this.#readCachedObject(sha256)) return;
    const extracted = await extractReferenceText({
      filePath: this.#blobPath(sha256),
      name: record.name,
      mimeType: record.mimeType,
      projectRoot: this.projectRoot,
    });
    const chunks = chunkReferenceText(extracted);
    if (chunks.length === 0 && !isTextlessPdf(record.name, extracted)) {
      throw new ReferenceExtractionError('REFERENCE_EMPTY_TEXT', `${record.name} contains no searchable chunks`);
    }
    const object = {
      schemaVersion: OBJECT_SCHEMA_VERSION,
      textVersion: this.textVersion,
      sha256,
      extractedChars: extracted.text.length,
      chunks,
    };
    await this.#writeCachedObject(object);
    // 그 사이 지워졌으면 캐시도 거둔다.
    if (!this.metadata.files.some((file) => file.sha256 === sha256)) {
      await fs.unlink(this.#cachePath(sha256)).catch(() => undefined);
      return;
    }
    if (this.objects.has(sha256)) {
      this.#dropIndexedObject(sha256);
      this.#indexObject({ ...object, source: 'cache' });
    }
  }

  async #writeCachedObject(object) {
    const file = this.#cachePath(object.sha256);
    if (!file) return false;
    const bytes = Buffer.byteLength(JSON.stringify(object), 'utf8') + 1;
    if (bytes > MAX_REFERENCE_OBJECT_BYTES) return false;
    await atomicWriteJson(file, object, { platform: this.platform });
    return true;
  }

  /** 부팅 때: 지금 판이 아니거나 어떤 기록도 가리키지 않는 캐시 파일을 지운다. 우리만 쓰는 폴더다. */
  async #loadTextCache() {
    if (!this.textCacheDir) return;
    const referenced = new Set([...this.metadata.files, ...(this.interim?.files ?? [])].map((record) => record.sha256));
    const entries = await this.#boundedDirectoryEntries(this.textCacheDir, 'Reference text cache', this.maxStorageDirectoryEntries * 2);
    for (const entry of entries) {
      const match = /^([a-f0-9]{64})\.t(\d+)\.json$/.exec(entry);
      if (match && referenced.has(match[1]) && Number(match[2]) === this.textVersion) continue;
      await fs.rm(path.join(this.textCacheDir, entry), { force: true, recursive: false }).catch(() => undefined);
    }
  }

  #touchIndex(sha256) {
    if (this.objects.has(sha256)) this.indexAccess.set(sha256, ++this.indexClock);
  }

  #evictIndexesFor(incomingChars, incomingTokens, protectedShas = new Set()) {
    if (incomingChars > this.maxResidentIndexChars || incomingTokens > this.maxResidentIndexTokens) return false;
    const protectedIndexes = protectedShas;
    const candidates = [...this.indexAccess.entries()].sort((left, right) => left[1] - right[1]);
    for (const [sha256] of candidates) {
      if (this.residentIndexChars + incomingChars <= this.maxResidentIndexChars
        && this.residentIndexTokens + incomingTokens <= this.maxResidentIndexTokens) break;
      if (protectedIndexes.has(sha256)) continue;
      this.#dropIndexedObject(sha256);
    }
    return this.residentIndexChars + incomingChars <= this.maxResidentIndexChars
      && this.residentIndexTokens + incomingTokens <= this.maxResidentIndexTokens;
  }

  #indexObject(object, { protectedShas = new Set() } = {}) {
    if (this.objects.has(object.sha256)) {
      this.#touchIndex(object.sha256);
      return true;
    }
    let indexedTokenCount = 0;
    outer: for (const chunk of object.chunks) {
      for (const _token of iterateReferenceTokens(chunk.text)) {
        indexedTokenCount += 1;
        if (indexedTokenCount >= this.maxIndexTokensPerObject) break outer;
      }
    }
    if (!this.#evictIndexesFor(object.extractedChars, indexedTokenCount, protectedShas)) return false;
    this.objects.set(object.sha256, object);
    this.residentIndexChars += object.extractedChars;
    this.residentIndexTokens += indexedTokenCount;
    this.indexTokenCounts.set(object.sha256, indexedTokenCount);
    this.#touchIndex(object.sha256);
    let remainingTokens = indexedTokenCount;
    for (const chunk of object.chunks) {
      if (remainingTokens <= 0) break;
      const key = chunkKey(object.sha256, chunk.id);
      if (this.indexChunks.has(key)) continue;
      const frequencies = new Map();
      let length = 0;
      for (const token of iterateReferenceTokens(chunk.text)) {
        if (remainingTokens <= 0) break;
        remainingTokens -= 1;
        length += 1;
        frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      }
      const indexed = { key, sha256: object.sha256, chunk, length: Math.max(1, length), frequencies };
      this.indexChunks.set(key, indexed);
      this.totalTokenCount += indexed.length;
      for (const [token, frequency] of frequencies) {
        let posting = this.postings.get(token);
        if (!posting) { posting = new Map(); this.postings.set(token, posting); }
        posting.set(key, frequency);
      }
    }
    return true;
  }

  #dropIndexedObject(sha256) {
    for (const [key, indexed] of this.indexChunks) {
      if (indexed.sha256 !== sha256) continue;
      this.indexChunks.delete(key);
      this.totalTokenCount -= indexed.length;
      for (const token of indexed.frequencies.keys()) {
        const posting = this.postings.get(token);
        posting?.delete(key);
        if (posting?.size === 0) this.postings.delete(token);
      }
    }
    const object = this.objects.get(sha256);
    if (object) this.residentIndexChars = Math.max(0, this.residentIndexChars - object.extractedChars);
    this.residentIndexTokens = Math.max(
      0,
      this.residentIndexTokens - (this.indexTokenCounts.get(sha256) ?? 0),
    );
    this.objects.delete(sha256);
    this.indexAccess.delete(sha256);
    this.indexTokenCounts.delete(sha256);
  }

  #normalizedScopeList(scopes) {
    return scopes.map((item) => normalizeReferenceScope(item.scope, item.scopeId));
  }

  #beginScopeOperation(scopes) {
    const keys = [...new Set(this.#normalizedScopeList(scopes).map((item) => scopeKey(item.scope, item.scopeId)))];
    for (const key of keys) this.activeScopeOperations.set(key, (this.activeScopeOperations.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of keys) {
        const remaining = (this.activeScopeOperations.get(key) ?? 1) - 1;
        if (remaining <= 0) this.activeScopeOperations.delete(key);
        else this.activeScopeOperations.set(key, remaining);
      }
    };
  }

  /** Pin active session scopes so LRU/teardown cannot evict their indexes. */
  retainScopes(scopes) {
    const normalized = this.#normalizedScopeList(scopes);
    const keys = [...new Set(normalized.map((item) => scopeKey(item.scope, item.scopeId)))];
    for (const key of keys) this.scopePins.set(key, (this.scopePins.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of keys) {
        const remaining = (this.scopePins.get(key) ?? 1) - 1;
        if (remaining <= 0) this.scopePins.delete(key);
        else this.scopePins.set(key, remaining);
      }
    };
  }

  #protectedIndexHashes() {
    const busyScopes = new Set([
      ...this.activeScopeOperations.keys(),
      ...this.scopePins.keys(),
    ]);
    return new Set(this.metadata.files
      .filter((record) => busyScopes.has(scopeKey(record.scope, record.scopeId)))
      .map((record) => record.sha256));
  }

  #scopeIsBusy(scoped, { includePins = true, includeStaged = true } = {}) {
    const key = scopeKey(scoped.scope, scoped.scopeId);
    if ((this.activeScopeOperations.get(key) ?? 0) > 0) return true;
    if (includePins && (this.scopePins.get(key) ?? 0) > 0) return true;
    if ([...this.quotaReservations.values()].some((reservation) => (
      reservation.scope === scoped.scope && reservation.scopeId === scoped.scopeId
    ))) return true;
    if (includeStaged && [...this.stagedFiles.values()].some((staged) => (
      staged.scope === scoped.scope && staged.scopeId === scoped.scopeId
    ))) return true;
    return false;
  }

  /** Load only the requested scopes into the bounded resident search index. */
  async activateScopes(scopes) {
    const activate = this.indexQueue.then(async () => {
      const normalized = this.#normalizedScopeList(scopes);
      const release = this.#beginScopeOperation(normalized);
      try {
        const allowed = new Set(normalized.map((item) => scopeKey(item.scope, item.scopeId)));
        const newestByHash = new Map();
        for (const record of this.metadata.files) {
          if (record.status !== 'ready'
            || record.extractedChars <= 0
            || !allowed.has(scopeKey(record.scope, record.scopeId))) continue;
          const previous = newestByHash.get(record.sha256);
          if (!previous || record.createdAt > previous.createdAt) newestByHash.set(record.sha256, record);
        }
        const records = [...newestByHash.values()]
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        const protectedShas = new Set();
        for (const record of records) {
          if (this.objects.has(record.sha256)) {
            protectedShas.add(record.sha256);
            this.#touchIndex(record.sha256);
            continue;
          }
          const object = await this.#currentObject(record.sha256, record);
          if (this.#indexObject(object, { protectedShas })) protectedShas.add(record.sha256);
        }
        return {
          indexedObjects: protectedShas.size,
          indexedChars: [...protectedShas].reduce(
            (total, sha256) => total + (this.objects.get(sha256)?.extractedChars ?? 0),
            0,
          ),
          complete: protectedShas.size === records.length,
        };
      } finally {
        release();
      }
    });
    this.indexQueue = activate.then(() => undefined, () => undefined);
    return activate;
  }

  /** Drop a scope's resident search data without deleting persisted references. */
  unloadScopeIndexes({ scope, scopeId }) {
    const scoped = normalizeReferenceScope(scope, scopeId);
    if (this.#scopeIsBusy(scoped, { includeStaged: false })) {
      throw new ReferenceStoreError('REFERENCE_SCOPE_BUSY', 'Reference scope is active and cannot be unloaded');
    }
    const protectedShas = this.#protectedIndexHashes();
    const hashes = new Set(this.#scopeFiles(scoped.scope, scoped.scopeId).map((record) => record.sha256));
    let unloaded = 0;
    for (const sha256 of hashes) {
      if (protectedShas.has(sha256) || !this.objects.has(sha256)) continue;
      this.#dropIndexedObject(sha256);
      unloaded += 1;
    }
    return unloaded;
  }

  #scopeFiles(scope, scopeId) {
    return this.metadata.files.filter((file) => file.scope === scope && file.scopeId === scopeId);
  }

  /**
   * 메타데이터 그룹 커밋. 한도 검사는 호출 즉시(동기) 끝내고 디스크 쓰기는 커밋 루프가 맡는다.
   * 쓰기가 진행 중일 때 들어온 변경은 다음 한 번의 쓰기로 묶인다. 호출자는 메모리 변경과 이 호출
   * 사이에 await 를 두지 않는다 — 그래야 루프가 쓰는 스냅숏마다 대기자가 정확히 대응한다.
   * 실패하면 묶인 변경의 rollback 을 최신 것부터 동기로 되돌린 뒤 대기자들을 거절한다.
   */
  #persist({
    replaceReservationId = null,
    replaceStageId = null,
    pendingPhysicalFiles = 0,
    pendingPhysicalBytes = 0,
    rollback = null,
  } = {}) {
    try {
      if (this.metadata.files.length > this.maxMetadataRecords) {
        throw new ReferenceStoreError(
          'REFERENCE_METADATA_RECORD_LIMIT',
          `Reference metadata exceeds the ${this.maxMetadataRecords}-record limit`,
        );
      }
      const serializedBytes = Buffer.byteLength(JSON.stringify(this.#serializableMetadata()), 'utf8') + 1;
      if (serializedBytes > this.maxMetadataBytes) {
        throw new ReferenceStoreError(
          'REFERENCE_METADATA_TOO_LARGE',
          `Reference metadata exceeds the ${this.maxMetadataBytes}-byte limit`,
        );
      }
      const usage = this.#usage({
        excludeLogicalReservations: replaceReservationId ? new Set([replaceReservationId]) : new Set(),
        excludeLogicalStages: replaceStageId ? new Set([replaceStageId]) : new Set(),
      });
      // Atomic replacement temporarily keeps the previous metadata alongside
      // the new temp file. Include that peak plus any just-written object that
      // has not yet been adopted into physicalObjects.
      usage.totalFiles += 1 + pendingPhysicalFiles;
      usage.totalBytes += serializedBytes + pendingPhysicalBytes;
      this.#assertUsageWithinLimits(usage);
    } catch (error) {
      rollback?.();
      const rejected = Promise.reject(error);
      rejected.catch(() => undefined);
      return rejected;
    }
    const committed = new Promise((resolve, reject) => {
      this.commitWaiters.push({ resolve, reject, rollback });
    });
    // 호출자가 결과를 늦게 기다려도 처리되지 않은 거절로 보고되지 않게 한다.
    committed.catch(() => undefined);
    if (!this.commitLoop) this.commitLoop = this.#runCommitLoop();
    return committed;
  }

  async #runCommitLoop() {
    try {
      while (this.commitWaiters.length > 0) {
        // 같은 틱에 들어온 변경을 한 번에 묶는다.
        await null;
        const waiters = this.commitWaiters.splice(0);
        const snapshot = this.#serializableMetadata();
        const serializedBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8') + 1;
        try {
          await this.persistMetadata(this.metadataPath, snapshot, {
            onRetainedTemp: (file, bytes) => this.#trackQuarantinedFile(file, bytes),
            platform: this.platform,
          });
          this.metadataPhysicalBytes = serializedBytes;
          for (const waiter of waiters) waiter.resolve();
        } catch (error) {
          for (const waiter of [...waiters].reverse()) {
            try { waiter.rollback?.(); } catch {}
          }
          for (const waiter of waiters) waiter.reject(error);
        }
      }
    } finally {
      this.commitLoop = null;
    }
  }

  #dropRecordInMemory(id) {
    this.metadata = { ...this.metadata, files: this.metadata.files.filter((file) => file.id !== id) };
  }

  #restoreRecordInMemory(record) {
    if (this.metadata.files.some((file) => file.id === record.id)) return;
    this.metadata = { ...this.metadata, files: [...this.metadata.files, record] };
  }

  #resolveAlias(fileId) {
    let resolved = fileId;
    for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth += 1) {
      const next = this.metadata.aliases?.[resolved];
      if (typeof next !== 'string') break;
      resolved = next;
    }
    return resolved;
  }

  async addBuffer(options) {
    const bytes = Buffer.from(options.bytes ?? []);
    async function* stream() { yield bytes; }
    return this.addStream({ ...options, stream: stream(), contentLength: bytes.length });
  }

  async addStream({ stream, name, mimeType, scope, scopeId, contentLength, transferStageId = null }) {
    const scoped = this.#assertScopeHere(normalizeReferenceScope(scope, scopeId));
    const safeName = sanitizeReferenceName(name);
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && (!Number.isSafeInteger(declared) || declared <= 0 || declared > this.maxFileBytes)) {
      throw new ReferenceStoreError('REFERENCE_FILE_TOO_LARGE', `Reference files must be 1-${this.maxFileBytes} bytes`);
    }
    const extension = path.extname(safeName).toLowerCase();
    const stagingId = transferStageId ? crypto.randomUUID() : requireGeneratedId(this.createId());
    const stagingLeaf = transferStageId
      ? `.upload-p-${crypto.createHash('sha256').update(transferStageId).digest('hex')}-${stagingId}${extension}`
      : `.upload-${stagingId}${extension}`;
    const staging = path.join(this.stagingDir, stagingLeaf);
    const reservedBytes = Number.isFinite(declared) ? declared : this.maxFileBytes;
    const reservationId = await this.#reserveUpload(scoped, reservedBytes, {
      transferStageId,
      extractedChars: transferStageId ? 0 : extractedReservationFor(safeName, reservedBytes),
    });
    let handle;
    const hash = crypto.createHash('sha256');
    let size = 0;
    try {
      handle = await fs.open(staging, 'wx', 0o600);
      try {
        for await (const raw of stream) {
          const chunk = Buffer.from(raw);
          size += chunk.length;
          if (size > this.maxFileBytes) {
            throw new ReferenceStoreError('REFERENCE_FILE_TOO_LARGE', `Reference file exceeds the ${this.maxFileBytes}-byte limit`);
          }
          if (size > reservedBytes) {
            throw new ReferenceStoreError('REFERENCE_SIZE_MISMATCH', 'Reference upload exceeds its declared length');
          }
          hash.update(chunk);
          await handle.write(chunk);
        }
        await handle.sync();
      } finally {
        await handle.close();
        handle = null;
      }
      if (size === 0) throw new ReferenceStoreError('REFERENCE_FILE_EMPTY', 'Reference file is empty');
      if (Number.isFinite(declared) && declared !== size) {
        throw new ReferenceStoreError('REFERENCE_SIZE_MISMATCH', 'Reference upload length did not match Content-Length');
      }
      const sha256 = hash.digest('hex');
      const kind = referenceKindForName(safeName);
      let chunks;
      let extractedChars;
      let extracted = null;
      let resolvedMime = normalizeMime(mimeType);
      if (kind === 'image') {
        const inspected = await inspectReferenceImage({ filePath: staging, name: safeName, mimeType });
        chunks = [];
        extractedChars = 0;
        resolvedMime = inspected.mimeType;
      } else {
        extracted = await extractReferenceText({ filePath: staging, name: safeName, mimeType, projectRoot: this.projectRoot });
        chunks = chunkReferenceText(extracted);
        extractedChars = extracted.text.length;
        if (chunks.length === 0 && !isTextlessPdf(safeName, extracted)) {
          throw new ReferenceExtractionError('REFERENCE_EMPTY_TEXT', `${safeName} contains no searchable chunks`);
        }
      }

      const prepared = await this.#exclusive(async () => {
        const duplicate = this.metadata.files.find((file) =>
          file.scope === scoped.scope && file.scopeId === scoped.scopeId && file.sha256 === sha256);
        if (duplicate) {
          await this.#unlinkOrQuarantine(staging, size, { coveredByStageId: transferStageId });
          if (transferStageId) {
            const staged = this.stagedFiles.get(transferStageId);
            if (staged) await this.#discardStagedLocked(transferStageId, staged).catch(() => undefined);
          }
          this.#finishReservation(reservationId);
          this.#assertCurrentUsage();
          return { file: publicFile(duplicate) };
        }
        const recordId = requireGeneratedId(this.createId());
        if (this.metadata.files.some((file) => file.id === recordId) || this.metadata.aliases?.[recordId]) {
          throw new ReferenceStoreError('REFERENCE_ID_CONFLICT', 'Could not allocate a unique reference id');
        }
        const objectPath = this.#objectPath(sha256);
        const objectExisted = await pathIsPlainFile(objectPath);
        const freshObject = { schemaVersion: OBJECT_SCHEMA_VERSION, textVersion: this.textVersion, sha256, extractedChars, chunks };
        let object = freshObject;
        let objectBytes;
        if (objectExisted) {
          const expected = this.metadata.files.find((record) => record.sha256 === sha256) ?? {
            extractedChars,
            chunkCount: chunks.length,
          };
          object = await this.#readObject(sha256, expected);
          extractedChars = object.extractedChars;
          chunks = object.chunks;
          const info = await fs.lstat(objectPath);
          if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_REFERENCE_OBJECT_BYTES) {
            throw metadataCorrupt(`Search index is invalid for sha256:${sha256}`);
          }
          objectBytes = info.size;
        } else {
          objectBytes = Buffer.byteLength(JSON.stringify(object), 'utf8') + 1;
          if (objectBytes > MAX_REFERENCE_OBJECT_BYTES) {
            throw new ReferenceStoreError(
              'REFERENCE_INDEX_TOO_LARGE',
              `Reference search index exceeds the ${MAX_REFERENCE_OBJECT_BYTES}-byte object limit`,
            );
          }
        }
        const blobPath = this.#blobPath(sha256);
        const blobExisted = await pathIsPlainFile(blobPath);
        if (blobExisted) {
          const info = await fs.lstat(blobPath);
          if (!info.isFile() || info.isSymbolicLink() || info.size !== size) {
            throw metadataCorrupt(`Reference blob is invalid for sha256:${sha256}`);
          }
        }
        this.#assertProjectedReference({
          ...scoped,
          bytes: size,
          sha256,
          extractedChars: transferStageId ? 0 : extractedChars,
          globalFiles: objectExisted ? 0 : 1,
          globalBytes: objectExisted ? 0 : objectBytes,
          // The upload reservation (or the staged draft during promotion)
          // already holds the logical per-scope slot and bytes.
          scopeFiles: 0,
          scopeBytes: 0,
          excludeExtractedReservations: transferStageId ? new Set() : new Set([reservationId]),
        });
        if (!objectExisted) {
          await atomicWriteJson(objectPath, object, {
            onRetainedTemp: (file, bytes) => this.#trackQuarantinedFile(file, bytes),
            platform: this.platform,
          });
        }
        try {
          if (blobExisted) await this.#unlinkOrQuarantine(staging, size, { coveredByStageId: transferStageId });
          else await publishNewReferenceBlob(staging, blobPath, { platform: this.platform });
        } catch (error) {
          if (!objectExisted) await this.#unlinkOrQuarantine(objectPath, objectBytes);
          throw error;
        }
        const pageCount = pageCountFor(extracted, chunks);
        const record = {
          id: recordId,
          ...scoped,
          name: safeName,
          mimeType: resolvedMime,
          size,
          sha256,
          status: 'ready',
          createdAt: this.now(),
          chunkCount: chunks.length,
          extractedChars,
          ...(pageCount ? { pageCount } : {}),
        };
        const pending = {
          record, object, freshObject, sha256, size, objectPath, objectBytes, objectExisted, blobPath, blobExisted,
          reservationId, transferStageId,
        };
        this.metadata = { ...this.metadata, files: [...this.metadata.files, record] };
        pending.committed = this.#persist({
          replaceReservationId: reservationId,
          replaceStageId: transferStageId,
          pendingPhysicalFiles: objectExisted ? 0 : 1,
          pendingPhysicalBytes: objectExisted ? 0 : objectBytes,
          rollback: () => this.#dropRecordInMemory(record.id),
        });
        if (transferStageId) {
          // 승격은 드래프트 장부와 얽혀 있어 커밋까지 잠금 안에서 끝낸다.
          try {
            await pending.committed;
          } catch (error) {
            await this.#cleanupFailedAdd(pending);
            throw error;
          }
          return { file: await this.#finishAdd(pending) };
        }
        // 기록이 메모리에 들어간 순간부터 예약의 논리 몫(범위·기록·추출 글자)은 기록이 대신한다.
        // 아직 장부에 오르지 않은 blob·검색 객체만 물리 몫으로 남긴다.
        const reservation = this.quotaReservations.get(reservationId);
        if (reservation) {
          Object.assign(reservation, {
            scopeFiles: 0,
            scopeBytes: 0,
            metadataRecords: 0,
            extractedChars: 0,
            globalFiles: (blobExisted ? 0 : 1) + (objectExisted ? 0 : 1),
            globalBytes: (blobExisted ? 0 : size) + (objectExisted ? 0 : objectBytes),
          });
        }
        return { pending };
      });
      if (prepared.file) return prepared.file;
      const { pending } = prepared;
      try {
        await pending.committed;
      } catch (error) {
        await this.#exclusive(() => this.#cleanupFailedAdd(pending));
        throw error;
      }
      return await this.#exclusive(() => this.#finishAdd(pending));
    } catch (error) {
      await handle?.close().catch(() => undefined);
      let quarantine = error?.processCleanupUncertain === true;
      if (!quarantine) {
        try {
          await fs.unlink(staging);
        } catch (unlinkError) {
          if (unlinkError?.code !== 'ENOENT') quarantine = true;
        }
      }
      await this.#releaseReservation(reservationId, quarantine
        ? { quarantinePath: staging, size }
        : {});
      throw error;
    }
  }

  /** 커밋이 실패한 추가의 뒷정리 (잠금 안). 기록은 커밋 루프가 이미 메모리에서 뺐다. */
  async #cleanupFailedAdd(pending) {
    const referenced = this.metadata.files.some((file) => file.sha256 === pending.sha256);
    if (!referenced) {
      if (!pending.blobExisted) await this.#unlinkOrQuarantine(pending.blobPath, pending.size);
      if (!pending.objectExisted) await this.#unlinkOrQuarantine(pending.objectPath, pending.objectBytes);
    }
    this.#finishReservation(pending.reservationId);
  }

  /** 커밋된 추가를 물리 장부·검색 색인에 올린다 (잠금 안). */
  async #finishAdd(pending) {
    this.quarantinedUploads.delete(pending.blobPath);
    this.quarantinedUploads.delete(pending.objectPath);
    if (this.metadata.files.some((file) => file.sha256 === pending.sha256)) {
      this.physicalObjects.set(pending.sha256, { blobBytes: pending.size, objectBytes: pending.objectBytes });
      // 원본이 옛 판이면(같은 내용이 예전에 들어와 있었다) 방금 추출한 지금 판을 캐시에 둔다.
      let indexed = pending.objectExisted ? pending.object : { ...pending.freshObject, source: 'primary' };
      if (pending.object.textVersion < this.textVersion && pending.freshObject.chunks.length > 0) {
        const written = await this.#writeCachedObject(pending.freshObject).catch(() => false);
        if (written) indexed = { ...pending.freshObject, source: 'cache' };
      }
      if (this.objects.get(pending.sha256)?.textVersion < indexed.textVersion) this.#dropIndexedObject(pending.sha256);
      this.#indexObject(indexed);
    }
    if (pending.transferStageId) {
      const staged = this.stagedFiles.get(pending.transferStageId);
      if (staged) await this.#discardStagedLocked(pending.transferStageId, staged).catch(() => {
        staged.promotionComplete = true;
        this.inFlightStages.delete(pending.transferStageId);
      });
    }
    this.#finishReservation(pending.reservationId);
    this.#assertCurrentUsage();
    return publicFile(pending.record);
  }

  list({ scope, scopeId }) {
    const scoped = normalizeReferenceScope(scope, scopeId);
    return this.#scopeFiles(scoped.scope, scoped.scopeId)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(publicFile);
  }

  listAccessible(scopes) {
    const allowed = new Set(scopes.map((item) => {
      const scoped = normalizeReferenceScope(item.scope, item.scopeId);
      return scopeKey(scoped.scope, scoped.scopeId);
    }));
    return this.metadata.files
      .filter((file) => allowed.has(scopeKey(file.scope, file.scopeId)))
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(publicFile);
  }

  /** 범위 종류별 scopeId 와 파일 수 — 이주(document → project)가 대상을 찾는 데 쓴다. */
  listScopes(kind) {
    const scopes = new Map();
    for (const record of this.metadata.files) {
      if (kind && record.scope !== kind) continue;
      const key = scopeKey(record.scope, record.scopeId);
      const entry = scopes.get(key) ?? { scope: record.scope, scopeId: record.scopeId, files: 0, bytes: 0 };
      entry.files += 1;
      entry.bytes += record.size;
      scopes.set(key, entry);
    }
    return [...scopes.values()];
  }

  /** 범위 검사 없이 기록 하나를 읽는다 (허브 내부용). 별칭은 따라간다. */
  getFile(fileId) {
    const record = this.metadata.files.find((file) => file.id === this.#resolveAlias(String(fileId ?? '')));
    return record ? publicFile(record) : null;
  }

  /**
   * PDF 에서 글자가 threshold 자보다 적은 쪽(1부터). 스캔·그림 쪽을 알려 에이전트가 그림으로 보게 한다.
   * getFile 처럼 범위 검사 없이 기록을 찾는다(허브 내부용, 별칭을 따라간다). PDF 가 아니거나
   * 모르는 파일이면 null.
   * @returns {Promise<{pageCount: number, pages: number[]}|null>}
   */
  async textlessPages(fileId, { threshold = 20 } = {}) {
    const record = this.metadata.files.find((file) => file.id === this.#resolveAlias(String(fileId ?? '')));
    if (!record || record.status !== 'ready' || path.extname(record.name).toLowerCase() !== '.pdf') return null;
    const release = this.#beginScopeOperation([{ scope: record.scope, scopeId: record.scopeId }]);
    try {
      const object = await this.#currentObject(record.sha256, record);
      const pageCount = Math.max(record.pageCount ?? 0, pageCountForChunks(object.chunks) ?? 0);
      if (pageCount === 0) return null;
      // 청크는 겹치므로 쪽마다 가장 긴 청크로 본다. 청크가 없는 쪽은 0자다.
      const longest = new Map();
      for (const chunk of object.chunks) {
        if (Number.isSafeInteger(chunk.page)) longest.set(chunk.page, Math.max(longest.get(chunk.page) ?? 0, chunk.text.length));
      }
      const pages = [];
      for (let page = 1; page <= pageCount; page += 1) {
        if ((longest.get(page) ?? 0) < threshold) pages.push(page);
      }
      return { pageCount, pages };
    } finally {
      release();
    }
  }

  async #deletePhysicalObject(sha256) {
    const physical = this.physicalObjects.get(sha256) ?? { blobBytes: 0, objectBytes: 0 };
    this.physicalObjects.delete(sha256);
    const cachePath = this.#cachePath(sha256);
    await Promise.all([
      this.#unlinkOrQuarantine(this.#objectPath(sha256), physical.objectBytes ?? 0),
      this.#unlinkOrQuarantine(this.#blobPath(sha256), physical.blobBytes ?? 0),
      ...(cachePath ? [fs.unlink(cachePath).catch(() => undefined)] : []),
    ]);
    this.#dropIndexedObject(sha256);
  }

  async remove({ fileId, scope, scopeId }) {
    const scoped = normalizeReferenceScope(scope, scopeId);
    const { record, committed } = await this.#exclusive(() => {
      if (this.#scopeIsBusy(scoped, { includePins: false, includeStaged: false })) {
        throw new ReferenceStoreError('REFERENCE_SCOPE_BUSY', 'Reference scope is currently being read or written');
      }
      const resolvedId = this.#resolveAlias(fileId);
      const found = this.metadata.files.find((file) => file.id === resolvedId
        && file.scope === scoped.scope && file.scopeId === scoped.scopeId);
      if (!found) throw new ReferenceStoreError('REFERENCE_NOT_FOUND', 'Reference file was not found in this scope');
      this.#dropRecordInMemory(found.id);
      return {
        record: found,
        committed: this.#persist({ rollback: () => this.#restoreRecordInMemory(found) }),
      };
    });
    await committed;
    return this.#exclusive(async () => {
      const retained = this.metadata.files.some((file) => file.sha256 === record.sha256);
      if (!retained) {
        await this.#deletePhysicalObject(record.sha256);
      }
      this.#assertCurrentUsage();
      return { ...publicFile(record), deleted: true, blobDeleted: !retained };
    });
  }

  /** Delete an inactive persisted scope and garbage-collect unshared objects. */
  async removeScope({ scope, scopeId }) {
    const scoped = normalizeReferenceScope(scope, scopeId);
    return this.#exclusive(async () => {
      if (this.#scopeIsBusy(scoped)) {
        throw new ReferenceStoreError(
          'REFERENCE_SCOPE_BUSY',
          'Reference scope has an active session, upload, staged file, or read operation',
        );
      }
      const removed = this.#scopeFiles(scoped.scope, scoped.scopeId);
      if (removed.length === 0) {
        return { ...scoped, deletedFiles: 0, deletedObjects: 0 };
      }
      const removedIds = new Set(removed.map((record) => record.id));
      this.metadata = { ...this.metadata, files: this.metadata.files.filter((record) => !removedIds.has(record.id)) };
      await this.#persist({
        rollback: () => { for (const record of removed) this.#restoreRecordInMemory(record); },
      });
      let deletedObjects = 0;
      for (const sha256 of new Set(removed.map((record) => record.sha256))) {
        if (this.metadata.files.some((record) => record.sha256 === sha256)) continue;
        await this.#deletePhysicalObject(sha256);
        deletedObjects += 1;
      }
      this.#assertCurrentUsage();
      return { ...scoped, deletedFiles: removed.length, deletedObjects };
    });
  }

  /**
   * 기록을 다른 범위로 옮긴다. fileId 는 그대로다. 대상 범위에 같은 내용(sha256)이 이미 있으면
   * 옮길 기록을 지우고 옛 id 를 그 기록의 별칭으로 남긴다 — 결과의 aliasedFrom 이 옛 id 다.
   */
  async rescope({ fileId, to }) {
    const target = this.#assertScopeHere(normalizeReferenceScope(to?.scope, to?.scopeId));
    const prepared = await this.#exclusive(() => {
      const resolvedId = this.#resolveAlias(String(fileId ?? ''));
      const record = this.metadata.files.find((file) => file.id === resolvedId);
      if (!record) throw new ReferenceStoreError('REFERENCE_NOT_FOUND', 'Reference file was not found');
      if (record.scope === target.scope && record.scopeId === target.scopeId) {
        return { file: publicFile(record), committed: null };
      }
      const duplicate = this.metadata.files.find((file) => file.id !== record.id
        && file.scope === target.scope && file.scopeId === target.scopeId && file.sha256 === record.sha256);
      if (duplicate) {
        const previousAliases = this.metadata.aliases ?? {};
        const changed = new Map([[record.id, previousAliases[record.id]]]);
        const aliases = { ...previousAliases, [record.id]: duplicate.id };
        for (const [from, aliasTarget] of Object.entries(previousAliases)) {
          if (aliasTarget === record.id) {
            changed.set(from, aliasTarget);
            aliases[from] = duplicate.id;
          }
        }
        this.metadata = {
          ...this.metadata,
          files: this.metadata.files.filter((file) => file.id !== record.id),
          aliases,
        };
        const committed = this.#persist({
          rollback: () => {
            const restored = { ...this.metadata.aliases };
            for (const [from, previous] of changed) {
              if (previous === undefined) delete restored[from];
              else restored[from] = previous;
            }
            this.metadata = { ...this.metadata, aliases: restored };
            this.#restoreRecordInMemory(record);
          },
        });
        return { file: { ...publicFile(duplicate), aliasedFrom: record.id }, committed };
      }
      this.#assertProjectedReference({
        ...target,
        bytes: record.size,
        sha256: record.sha256,
        globalFiles: 0,
        globalBytes: 0,
        scopeFiles: 1,
        scopeBytes: record.size,
      });
      const moved = { ...record, ...target };
      this.metadata = {
        ...this.metadata,
        files: this.metadata.files.map((file) => (file.id === record.id ? moved : file)),
      };
      const committed = this.#persist({
        rollback: () => {
          this.metadata = {
            ...this.metadata,
            files: this.metadata.files.map((file) => (file === moved ? record : file)),
          };
        },
      });
      return { file: publicFile(moved), committed };
    });
    if (prepared.committed) await prepared.committed;
    return prepared.file;
  }

  /** 다른 저장소(legacy)에서 옮겨 와 그쪽 기록을 가리는 id 들. */
  shadowedIds() {
    if (this.shadowCache?.source !== this.metadata.shadows) {
      this.shadowCache = { source: this.metadata.shadows, ids: new Set(this.metadata.shadows) };
    }
    return this.shadowCache.ids;
  }

  /** legacy 기록을 옮길 때 넘길 원본 경로들. 범위 검사는 하지 않는다(허브 내부용). */
  exportRecord(fileId) {
    const record = this.metadata.files.find((file) => file.id === this.#resolveAlias(String(fileId ?? '')));
    if (!record) throw new ReferenceStoreError('REFERENCE_NOT_FOUND', 'Reference file was not found');
    return {
      record: { ...record },
      blobPath: this.#blobPath(record.sha256),
      objectPath: this.#objectPath(record.sha256),
      cachePath: this.#cachePath(record.sha256),
    };
  }

  /** 원자적으로 하드 링크하고, 안 되면(다른 볼륨 등) staging 에 복사한 뒤 이름을 바꾼다. */
  async #linkOrCopy(source, target) {
    try {
      await fs.link(source, target);
      return;
    } catch (error) {
      if (error?.code === 'EEXIST') return;
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK', 'EACCES'].includes(error?.code)) throw error;
    }
    const temp = path.join(this.stagingDir, `.upload-${crypto.randomUUID()}`);
    try {
      await fs.copyFile(source, temp, fsConstants.COPYFILE_EXCL);
      await publishNewReferenceBlob(temp, target, { platform: this.platform });
    } finally {
      await fs.unlink(temp).catch(() => undefined);
    }
  }

  /**
   * legacy 저장소의 기록을 같은 id 로 이 저장소(project 형식)에 들인다. blob·원본 객체·다시 추출한
   * 캐시는 하드 링크(안 되면 복사)로 가져오므로 legacy 쪽 파일과 metadata.json 은 그대로 남는다.
   * 들인 id 는 shadows 에 남아 묶음 저장소가 legacy 쪽 기록을 가린다. 같은 내용이 대상 범위에 이미
   * 있으면 옛 id 는 그 기록의 별칭이 된다(aliasedFrom). 이미 들인 id 면 그대로 돌려준다.
   */
  async importRecord({ record, to, blobPath, objectPath, cachePath = null }) {
    if (this.format !== 'project') throw new ReferenceStoreError('REFERENCE_SCOPE_INVALID', 'Only the project store imports records');
    const target = this.#assertScopeHere(normalizeReferenceScope(to?.scope, to?.scopeId));
    if (!isSafeRecordId(record?.id) || !/^[a-f0-9]{64}$/.test(String(record?.sha256 ?? ''))) {
      throw new ReferenceStoreError('REFERENCE_ID_INVALID', 'Imported reference record is invalid');
    }
    const shadowed = (metadata) => (metadata.shadows.includes(record.id)
      ? metadata.shadows
      : [...metadata.shadows, record.id]);
    const removeShadow = () => {
      this.metadata = { ...this.metadata, shadows: this.metadata.shadows.filter((id) => id !== record.id) };
    };
    const prepared = await this.#exclusive(async () => {
      const knownId = this.#resolveAlias(record.id);
      const existing = this.metadata.files.find((file) => file.id === knownId);
      const duplicate = existing ?? this.metadata.files.find((file) => file.scope === target.scope
        && file.scopeId === target.scopeId && file.sha256 === record.sha256);
      if (duplicate) {
        const aliased = duplicate.id !== record.id;
        const needsShadow = !this.metadata.shadows.includes(record.id);
        const needsAlias = aliased && this.metadata.aliases[record.id] !== duplicate.id;
        if (!needsShadow && !needsAlias) return { file: { ...publicFile(duplicate), ...(aliased ? { aliasedFrom: record.id } : {}) } };
        const previousAlias = this.metadata.aliases[record.id];
        this.metadata = {
          ...this.metadata,
          shadows: shadowed(this.metadata),
          aliases: needsAlias ? { ...this.metadata.aliases, [record.id]: duplicate.id } : this.metadata.aliases,
        };
        const committed = this.#persist({
          rollback: () => {
            if (needsShadow) removeShadow();
            if (needsAlias) {
              const aliases = { ...this.metadata.aliases };
              if (previousAlias === undefined) delete aliases[record.id];
              else aliases[record.id] = previousAlias;
              this.metadata = { ...this.metadata, aliases };
            }
          },
        });
        return { file: { ...publicFile(duplicate), ...(aliased ? { aliasedFrom: record.id } : {}) }, committed };
      }
      const sourceBlob = await fs.lstat(blobPath).catch(() => null);
      if (!sourceBlob?.isFile() || sourceBlob.isSymbolicLink() || sourceBlob.size !== record.size) {
        throw new ReferenceStoreError('REFERENCE_BLOB_MISSING', 'Reference file data is missing');
      }
      const sha256 = record.sha256;
      const blobTarget = this.#blobPath(sha256);
      const objectTarget = this.#objectPath(sha256);
      const blobExisted = await pathIsPlainFile(blobTarget);
      const objectExisted = await pathIsPlainFile(objectTarget);
      const objectBytes = objectExisted
        ? (await fs.lstat(objectTarget)).size
        : (await fs.lstat(objectPath)).size;
      this.#assertProjectedReference({
        ...target,
        bytes: record.size,
        sha256,
        extractedChars: record.extractedChars,
        globalFiles: (blobExisted ? 0 : 1) + (objectExisted ? 0 : 1),
        globalBytes: (blobExisted ? 0 : record.size) + (objectExisted ? 0 : objectBytes),
        scopeFiles: 1,
        scopeBytes: record.size,
        metadataRecords: 1,
      });
      if (!blobExisted) await this.#linkOrCopy(blobPath, blobTarget);
      if (!objectExisted) await this.#linkOrCopy(objectPath, objectTarget);
      let object;
      try {
        object = await this.#parseObjectFile(objectTarget, sha256, record);
      } catch (error) {
        if (!blobExisted) await this.#unlinkOrQuarantine(blobTarget, record.size);
        if (!objectExisted) await this.#unlinkOrQuarantine(objectTarget, objectBytes);
        throw error;
      }
      object.source = 'primary';
      const cacheTarget = this.#cachePath(sha256);
      if (cachePath && cacheTarget && await pathIsPlainFile(cachePath) && !await pathIsPlainFile(cacheTarget)) {
        await this.#linkOrCopy(cachePath, cacheTarget).catch(() => undefined);
      }
      const pageCount = Number.isSafeInteger(record.pageCount) && record.pageCount > 0
        ? record.pageCount
        : pageCountForChunks(object.chunks);
      const imported = {
        id: record.id,
        ...target,
        name: record.name,
        mimeType: record.mimeType,
        size: record.size,
        sha256,
        status: record.status,
        createdAt: record.createdAt,
        chunkCount: record.chunkCount,
        extractedChars: record.extractedChars,
        ...(pageCount ? { pageCount } : {}),
      };
      this.metadata = {
        ...this.metadata,
        files: [...this.metadata.files, imported],
        shadows: shadowed(this.metadata),
      };
      const committed = this.#persist({
        pendingPhysicalFiles: (blobExisted ? 0 : 1) + (objectExisted ? 0 : 1),
        pendingPhysicalBytes: (blobExisted ? 0 : record.size) + (objectExisted ? 0 : objectBytes),
        rollback: () => {
          this.#dropRecordInMemory(imported.id);
          removeShadow();
        },
      });
      return {
        file: publicFile(imported),
        committed,
        physical: { sha256, size: record.size, objectBytes, blobExisted, objectExisted, blobTarget, objectTarget },
      };
    });
    if (prepared.committed) {
      try {
        await prepared.committed;
      } catch (error) {
        const physical = prepared.physical;
        if (physical) {
          await this.#exclusive(async () => {
            if (this.metadata.files.some((file) => file.sha256 === physical.sha256)) return;
            if (!physical.blobExisted) await this.#unlinkOrQuarantine(physical.blobTarget, physical.size);
            if (!physical.objectExisted) await this.#unlinkOrQuarantine(physical.objectTarget, physical.objectBytes);
          });
        }
        throw error;
      }
    }
    if (prepared.physical) {
      await this.#exclusive(() => {
        const { sha256, size, objectBytes } = prepared.physical;
        if (this.metadata.files.some((file) => file.sha256 === sha256)) {
          this.physicalObjects.set(sha256, { blobBytes: size, objectBytes });
        }
      });
    }
    return prepared.file;
  }

  /** 옛 id → 지금 id 별칭을 더한다(project 형식). 이미 기록인 id 는 건너뛴다. */
  async addAliases(aliases) {
    const entries = Object.entries(aliases ?? {})
      .filter(([from, to]) => isSafeRecordId(from) && isSafeRecordId(to) && from !== to);
    if (entries.length === 0 || this.format !== 'project') return;
    await this.#exclusive(async () => {
      const added = entries.filter(([from]) => !this.metadata.files.some((file) => file.id === from)
        && this.metadata.aliases[from] === undefined);
      if (added.length === 0) return;
      this.metadata = { ...this.metadata, aliases: { ...this.metadata.aliases, ...Object.fromEntries(added) } };
      await this.#persist({
        rollback: () => {
          const aliases = { ...this.metadata.aliases };
          for (const [from] of added) delete aliases[from];
          this.metadata = { ...this.metadata, aliases };
        },
      });
    });
  }

  /**
   * 채팅에 올려 둔 첨부를 다른 곳(프로젝트 파일 저장소)으로 넘긴다. consume 이 성공하면 드래프트를 지운다.
   * 넘기는 동안 드래프트는 진행 중으로 표시돼 만료 정리가 건드리지 않는다.
   */
  async transferStaged({ stageId, scopeId, consume }) {
    const run = this.promotionQueue.then(async () => {
      const staged = await this.getStaged({ stageId, scopeId });
      await this.#exclusive(() => {
        if (this.inFlightStages.has(stageId)) {
          throw new ReferenceStoreError('REFERENCE_SCOPE_BUSY', 'Staged reference promotion is already in progress');
        }
        this.inFlightStages.add(stageId);
      });
      let result;
      try {
        result = await consume({
          stream: createReadStream(this.#stagedDataPath(stageId)),
          name: staged.name,
          mimeType: staged.mimeType,
          size: staged.size,
        });
      } finally {
        await this.#exclusive(() => { this.inFlightStages.delete(stageId); });
      }
      await this.discardStaged({ stageId, scopeId }).catch((error) => {
        this.logger?.(`staged reference ${stageId} kept after transfer: ${error?.message ?? error}`);
      });
      return result;
    });
    this.promotionQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  storageUsage() {
    const usage = this.#usage();
    return {
      totalFiles: usage.totalFiles,
      totalBytes: usage.totalBytes,
      extractedChars: usage.extractedChars,
      metadataRecords: usage.metadataRecords,
      stagedFiles: this.stagedFiles.size,
      quarantinedFiles: this.quarantinedUploads.size,
      reservedUploads: this.quotaReservations.size,
      residentIndexChars: this.residentIndexChars,
      residentIndexTokens: this.residentIndexTokens,
      limits: {
        totalFiles: this.maxTotalFiles,
        totalBytes: this.maxTotalBytes,
        extractedChars: this.maxExtractedChars,
        metadataRecords: this.maxMetadataRecords,
        residentIndexChars: this.maxResidentIndexChars,
        residentIndexTokens: this.maxResidentIndexTokens,
      },
    };
  }

  #accessibleRecords(scopes) {
    const allowed = new Set(scopes.map((item) => {
      const scoped = normalizeReferenceScope(item.scope, item.scopeId);
      return scopeKey(scoped.scope, scoped.scopeId);
    }));
    const byHash = new Map();
    for (const file of this.metadata.files) {
      if (file.status !== 'ready' || !allowed.has(scopeKey(file.scope, file.scopeId))) continue;
      const entries = byHash.get(file.sha256) ?? [];
      entries.push(file);
      byHash.set(file.sha256, entries);
    }
    return byHash;
  }

  search({ query, scopes, maxResults = 8 }) {
    if (String(query ?? '').length > MAX_SEARCH_QUERY_CHARS) {
      throw new ReferenceStoreError(
        'REFERENCE_QUERY_TOO_LARGE',
        `Reference search query exceeds ${MAX_SEARCH_QUERY_CHARS} characters`,
      );
    }
    const tokens = [...new Set(tokenizeReferenceText(query))];
    if (tokens.length === 0) return [];
    const release = this.#beginScopeOperation(scopes);
    try {
      const accessible = this.#accessibleRecords(scopes);
      const allowedKeys = [...this.indexChunks.values()].filter((entry) => accessible.has(entry.sha256));
      if (allowedKeys.length === 0) return [];
      for (const sha256 of accessible.keys()) this.#touchIndex(sha256);
      const allowedSet = new Set(allowedKeys.map((entry) => entry.key));
      const averageLength = allowedKeys.reduce((total, entry) => total + entry.length, 0) / allowedKeys.length;
      const scores = new Map();
      const k1 = 1.2;
      const b = 0.75;
      for (const token of tokens) {
        const posting = this.postings.get(token);
        if (!posting) continue;
        const allowedPosting = [...posting.entries()].filter(([key]) => allowedSet.has(key));
        const df = allowedPosting.length;
        if (df === 0) continue;
        const idf = Math.log(1 + ((allowedKeys.length - df + 0.5) / (df + 0.5)));
        for (const [key, frequency] of allowedPosting) {
          const indexed = this.indexChunks.get(key);
          const denominator = frequency + k1 * (1 - b + b * (indexed.length / averageLength));
          scores.set(key, (scores.get(key) ?? 0) + idf * ((frequency * (k1 + 1)) / denominator));
        }
      }
      const normalizedQuery = normalizedSearchText(query).trim();
      for (const [key, score] of scores) {
        const indexed = this.indexChunks.get(key);
        if (normalizedQuery.length >= 2 && normalizedSearchText(indexed.chunk.text).includes(normalizedQuery)) {
          scores.set(key, score + 2.5);
        }
      }
      const perHash = new Map();
      for (const [key, score] of [...scores.entries()].sort((a, b) => b[1] - a[1])) {
        const indexed = this.indexChunks.get(key);
        const count = perHash.get(indexed.sha256) ?? 0;
        if (count >= 3) continue;
        perHash.set(indexed.sha256, count + 1);
        const records = accessible.get(indexed.sha256);
        const primary = records[0];
        const result = {
          fileId: primary.id,
          name: primary.name,
          mimeType: primary.mimeType,
          sha256: primary.sha256,
          scopes: records.map((record) => ({ scope: record.scope, scopeId: record.scopeId })),
          chunkId: indexed.chunk.id,
          page: indexed.chunk.page,
          score: Number(score.toFixed(6)),
          text: indexed.chunk.text,
        };
        perHash.set(`${key}:result`, result);
        if ([...perHash.keys()].filter((item) => item.endsWith(':result')).length >= Math.min(20, Math.max(1, maxResults))) break;
      }
      return [...perHash.entries()]
        .filter(([key]) => key.endsWith(':result'))
        .map(([, result]) => result);
    } finally {
      release();
    }
  }

  /** 세션 범위 안에서 기록 하나를 찾는다. 별칭(이주로 합쳐진 옛 id)도 따라간다. */
  #accessibleRecord(fileId, scopes) {
    const accessible = this.#accessibleRecords(scopes);
    const resolvedId = this.#resolveAlias(String(fileId ?? ''));
    const record = this.metadata.files.find((file) =>
      file.id === resolvedId && accessible.get(file.sha256)?.some((allowed) => allowed.id === file.id));
    if (!record) throw new ReferenceStoreError('REFERENCE_NOT_FOUND', 'Reference file is not available to this chat');
    return record;
  }

  async readChunk({ fileId, chunkId, scopes, maxChars = MAX_READ_CHARS }) {
    const release = this.#beginScopeOperation(scopes);
    try {
      const record = this.#accessibleRecord(fileId, scopes);
      if (referenceKindForName(record.name) === 'image') {
        throw new ReferenceStoreError('REFERENCE_NOT_TEXT', 'Image references must be read with read_reference_image');
      }
      const object = await this.#currentObject(record.sha256, record);
      const chunk = object.chunks.find((item) => item.id === chunkId);
      if (!chunk) throw new ReferenceStoreError('REFERENCE_CHUNK_NOT_FOUND', `Chunk ${chunkId} was not found`);
      const limit = Number.isSafeInteger(maxChars) ? Math.min(MAX_READ_CHARS, Math.max(1, maxChars)) : MAX_READ_CHARS;
      return {
        fileId: record.id,
        name: record.name,
        sha256: record.sha256,
        chunkId: chunk.id,
        page: chunk.page,
        start: chunk.start,
        end: chunk.end,
        text: chunk.text.slice(0, limit),
        truncated: chunk.text.length > limit,
      };
    } finally {
      release();
    }
  }

  async readImage({ fileId, scopes }) {
    const release = this.#beginScopeOperation(scopes);
    try {
      const record = this.#accessibleRecord(fileId, scopes);
      if (referenceKindForName(record.name) !== 'image') {
        throw new ReferenceStoreError('REFERENCE_NOT_IMAGE', 'Document references must be read with search_reference_files and read_reference_chunk');
      }
      const blobPath = this.#blobPath(record.sha256);
      if (!await pathIsPlainFile(blobPath)) {
        throw new ReferenceStoreError('REFERENCE_BLOB_MISSING', 'Reference image data is missing');
      }
      const inspected = await inspectReferenceImage({
        filePath: blobPath,
        name: record.name,
        mimeType: record.mimeType,
      });
      return {
        fileId: record.id,
        name: record.name,
        sha256: record.sha256,
        image: { data: inspected.bytes.toString('base64'), mimeType: inspected.mimeType },
      };
    } finally {
      release();
    }
  }

  /** 원본 바이트 경로 (HTTP 미리보기용). 호출자가 스트림으로 읽는다. */
  async openBlob({ fileId, scopes }) {
    const record = this.#accessibleRecord(fileId, scopes);
    const blobPath = this.#blobPath(record.sha256);
    const info = await fs.lstat(blobPath).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size !== record.size) {
      throw new ReferenceStoreError('REFERENCE_BLOB_MISSING', 'Reference file data is missing');
    }
    return { ...publicFile(record), path: blobPath };
  }

  /**
   * 읽기 화면용 쪽 본문. PDF 처럼 쪽 정보가 있으면 그 쪽의 청크를, 없으면 청크 40개씩을 한 쪽으로
   * 묶는다. 겹치는 청크는 겹친 부분을 한 번만 이어 붙이고, 청크 경계는 돌려주는 본문 기준이다.
   */
  async readPageText({ fileId, scopes, page = null }) {
    const release = this.#beginScopeOperation(scopes);
    try {
      const record = this.#accessibleRecord(fileId, scopes);
      if (referenceKindForName(record.name) === 'image') {
        throw new ReferenceStoreError('REFERENCE_NOT_TEXT', 'Image references have no text');
      }
      const object = await this.#currentObject(record.sha256, record);
      // 기록의 쪽 수는 글 없는 쪽(스캔)까지 센다.
      const knownPages = Math.max(record.pageCount ?? 0, pageCountForChunks(object.chunks) ?? 0);
      const paged = knownPages > 0;
      const pageCount = paged
        ? knownPages
        : Math.max(1, Math.ceil(object.chunks.length / VIRTUAL_PAGE_CHUNKS));
      const requested = Number.isSafeInteger(page) ? Math.min(pageCount, Math.max(1, page)) : 1;
      const selected = paged
        ? object.chunks.filter((chunk) => chunk.page === requested)
        : object.chunks.slice((requested - 1) * VIRTUAL_PAGE_CHUNKS, requested * VIRTUAL_PAGE_CHUNKS);
      let text = '';
      let coveredEnd = -1;
      const spans = [];
      let truncated = false;
      for (const chunk of selected) {
        let start;
        let addition;
        if (coveredEnd > chunk.start && text) {
          // 겹친 머리를 본문 꼬리와 맞춰 본다 — 다듬어진 공백 때문에 원본 좌표만으로는 어긋날 수 있다.
          const expected = coveredEnd - chunk.start;
          let overlap = 0;
          for (let length = Math.min(chunk.text.length, expected + 8); length > 0; length -= 1) {
            if (text.endsWith(chunk.text.slice(0, length))) { overlap = length; break; }
          }
          start = text.length - overlap;
          addition = overlap > 0 ? chunk.text.slice(overlap) : `
${chunk.text}`;
          if (overlap === 0) start = text.length + 1;
        } else {
          start = text ? text.length + 1 : 0;
          addition = text ? `
${chunk.text}` : chunk.text;
        }
        if (text.length + addition.length > MAX_PAGE_TEXT_CHARS) {
          truncated = true;
          break;
        }
        text += addition;
        spans.push({ id: chunk.id, start, end: text.length });
        coveredEnd = Math.max(coveredEnd, chunk.end);
      }
      return { fileId: record.id, page: requested, pageCount, paged, text, chunks: spans, truncated };
    } finally {
      release();
    }
  }
}
