// list_documents({path}) 가 발급하는 file: 핸들과, 다른 문서 목록(list_documents)을 다듬는 도우미.
// 핸들은 에이전트 세션에만 있고(agentSession.documentPaths), 경로는 읽을 때마다 다시 확인한다.
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileBytesBounded } from './bounded-file.mjs';

export const DOCUMENT_PATH_MAX_BYTES = 24 * 1024 * 1024;
export const DOCUMENT_PATH_EXTENSIONS = Object.freeze(['hwp', 'hwpx', 'hml', 'hwpml']);
// open_document 는 데스크톱이 직접 열어 다시 저장한다 — hwpml 은 저장하지 못해 받지 않고, 크기는 데스크톱 한도를 따른다.
export const OPENABLE_DOCUMENT_EXTENSIONS = Object.freeze(['hwp', 'hwpx', 'hml']);
export const OPEN_DOCUMENT_MAX_BYTES = 512 * 1024 * 1024;
export const NEW_DOCUMENT_NAME_MAX_CHARS = 120;
export const MAX_DOCUMENT_PATH_HANDLES = 64;
export const MAX_LISTED_DOCUMENTS = 50;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

function pathError(code, message) {
  return Object.assign(new Error(message), { code });
}

function foldCase(value, platform) {
  const text = value.normalize('NFC');
  return platform === 'darwin' || platform === 'win32' ? text.toLowerCase() : text;
}

/** UNC·장치 경로(\\server\share, \\?\, \\.\, //server)와 상대·NUL 경로를 거절한다. */
function assertLocalAbsolutePath(candidate, label) {
  // 어느 플랫폼에서도 fs 에 넘기지 않는다 — Windows 에서는 stat 만으로 원격 호스트에 접속(NTLM 자격 증명 전송)할 수 있다.
  if (typeof candidate === 'string' && /^[\\/]{2}/.test(candidate)) {
    throw pathError('PATH_REJECTED', 'Network and device paths cannot be used; use a local path');
  }
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0') || !path.isAbsolute(candidate)) {
    throw pathError('PATH_INVALID', `${label} must be an absolute path`);
  }
}

/**
 * 입력 경로가 링크를 지나는지. 실제 경로가 입력과 같으면 링크가 없다.
 * Windows 의 realpath 는 8.3 짧은 이름과 SUBST 드라이브도 풀어 쓰므로 문자열이 달라도 링크가
 * 아닐 수 있다. 그때는 각 경로 요소를 lstat 으로 확인한다(정션도 심볼릭 링크로 보인다).
 * 연결된 네트워크 드라이브는 UNC 경로로 풀리므로 네트워크 경로로 거절한다.
 */
async function assertNoLinkInPath(lexical, real, platform, { linkMessage, inspectMessage }) {
  if (foldCase(real, platform) === foldCase(lexical, platform)) return;
  if (platform !== 'win32') throw pathError('PATH_REJECTED', linkMessage);
  if (/^[\\/]{2}/.test(real)) {
    throw pathError('PATH_REJECTED', 'Network drives cannot be used; copy the file to a local folder');
  }
  for (let current = lexical; ; current = path.dirname(current)) {
    let info;
    try {
      info = await fs.lstat(current);
    } catch {
      throw pathError('PATH_REJECTED', inspectMessage);
    }
    if (info.isSymbolicLink()) throw pathError('PATH_REJECTED', linkMessage);
    if (path.dirname(current) === current) return;
  }
}

/**
 * 절대 경로의 hwp/hwpx/hml/hwpml 일반 파일(1..24 MiB)인지 확인한다. 파일이나 상위 폴더가 링크면 거절한다.
 * open_document 는 extensions·maxBytes 로 연 뒤 저장할 수 있는 형식과 데스크톱 한도를 준다.
 * 오류 코드: PATH_INVALID(인자), PATH_NOT_FOUND(없음), PATH_REJECTED(링크·폴더·확장자), PATH_TOO_LARGE.
 * @returns {Promise<{ path: string, name: string, size: number, mtimeMs: number }>}
 */
export async function validateDocumentPath(candidate, {
  platform = process.platform,
  extensions = DOCUMENT_PATH_EXTENSIONS,
  maxBytes = DOCUMENT_PATH_MAX_BYTES,
} = {}) {
  assertLocalAbsolutePath(candidate, 'path');
  const lexical = path.resolve(candidate);
  const name = path.basename(lexical).normalize('NFC');
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!extensions.includes(ext)) {
    throw pathError('PATH_REJECTED', `Only ${extensions.join('/')} files can be used`);
  }
  let link;
  let real;
  try {
    link = await fs.lstat(lexical);
    if (link.isSymbolicLink() || !link.isFile()) throw pathError('PATH_REJECTED', 'path must be a regular file, not a link or folder');
    real = await fs.realpath(lexical);
  } catch (error) {
    if (error?.code === 'PATH_REJECTED') throw error;
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw pathError('PATH_NOT_FOUND', 'The file does not exist');
    throw pathError('PATH_REJECTED', 'The file cannot be inspected');
  }
  // 링크된 상위 폴더가 있으면 실제 경로가 입력과 달라진다.
  await assertNoLinkInPath(lexical, real, platform, {
    linkMessage: 'The path passes through a link',
    inspectMessage: 'The file cannot be inspected',
  });
  if (!Number.isSafeInteger(link.size) || link.size < 1) throw pathError('PATH_REJECTED', 'The file is empty');
  if (link.size > maxBytes) throw pathError('PATH_TOO_LARGE', `The file is larger than ${Math.round(maxBytes / (1024 * 1024))} MiB`);
  return { path: real, name, size: link.size, mtimeMs: Math.round(link.mtimeMs) };
}

function insideFolder(child, parent, platform) {
  const folded = foldCase(child, platform);
  const root = foldCase(parent, platform);
  return folded === root || folded.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

/**
 * create_document 의 저장 폴더: 홈 폴더 안에 이미 있는 실제 폴더여야 한다. 폴더나 상위 폴더가 링크면 거절한다.
 * 오류 코드: PATH_INVALID, PATH_NOT_FOUND, PATH_REJECTED(링크·파일·홈 밖).
 * @returns {Promise<string>} 실제 경로
 */
export async function validateDocumentFolder(candidate, { platform = process.platform, home = os.homedir() } = {}) {
  assertLocalAbsolutePath(candidate, 'folder');
  const lexical = path.resolve(candidate);
  let real;
  let homeReal;
  try {
    const info = await fs.lstat(lexical);
    if (info.isSymbolicLink() || !info.isDirectory()) throw pathError('PATH_REJECTED', 'folder must be a folder, not a link or file');
    real = await fs.realpath(lexical);
    homeReal = await fs.realpath(home);
  } catch (error) {
    if (error?.code === 'PATH_REJECTED') throw error;
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw pathError('PATH_NOT_FOUND', 'The folder does not exist');
    throw pathError('PATH_REJECTED', 'The folder cannot be inspected');
  }
  await assertNoLinkInPath(lexical, real, platform, {
    linkMessage: 'The folder path passes through a link',
    inspectMessage: 'The folder cannot be inspected',
  });
  if (!insideFolder(real, homeReal, platform)) throw pathError('PATH_REJECTED', 'folder must be inside the home folder');
  return real;
}

const RESERVED_FILE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * create_document 의 이름 — 확장자 없는 파일 이름. 끝의 .hwpx/.hwp 는 떼고, 경로 문자·제어 문자·
 * Windows 예약 이름·끝의 점/공백은 거절한다(INVALID_ARGS).
 */
export function normalizeNewDocumentName(value) {
  const invalid = (message) => pathError('INVALID_ARGS', message);
  if (typeof value !== 'string') throw invalid('name must be a string');
  const name = value.normalize('NFC').trim().replace(/\.hwpx?$/i, '').trim();
  if (!name || name.length > NEW_DOCUMENT_NAME_MAX_CHARS) throw invalid(`name must be 1-${NEW_DOCUMENT_NAME_MAX_CHARS} characters without the extension`);
  if (/[\\/:*?"<>|\u0000-\u001f\u007f]/.test(name)) throw invalid('name cannot contain control characters or \\ / : * ? " < > |');
  if (/^\.+$/.test(name) || /[. ]$/.test(name) || RESERVED_FILE_NAME.test(name)) throw invalid('name is not a valid file name');
  return name;
}

/**
 * list_documents({path}) 의 동의 확인. 데스크톱(homeAccess)에서 루트 대화만, other-documents 나
 * local-execution 권한을 받았거나 전체 모드(unrestricted)일 때 허용한다.
 * @param {{ homeAccess: boolean, root: boolean, permissionProfile?: string, grants?: string[] }} input
 */
export function assertDocumentPathConsent({ homeAccess, root, permissionProfile, grants = [] }) {
  if (!homeAccess) throw pathError('PATH_UNAVAILABLE', 'Reading a document by path is only available in the desktop app');
  if (!root) throw pathError('ROOT_INTERACTION_REQUIRED', 'Only the root conversation may read a document by path');
  if (permissionProfile === 'unrestricted') return;
  if (Array.isArray(grants) && (grants.includes('other-documents') || grants.includes('local-execution'))) return;
  throw pathError('PERMISSION_REQUIRED', 'Reading a file by path needs the user\'s consent: call request_permission with capability "other-documents", then end the turn and wait.');
}

/** 같은 경로는 같은 핸들을 다시 쓴다. 넘치면 가장 오래 안 쓴 핸들부터 버린다. */
export function rememberDocumentPath(documentPaths, file) {
  for (const [handle, entry] of documentPaths) {
    if (entry.path !== file.path) continue;
    documentPaths.delete(handle);
    documentPaths.set(handle, { ...file });
    return handle;
  }
  const handle = crypto.randomBytes(16).toString('base64url');
  documentPaths.set(handle, { ...file });
  while (documentPaths.size > MAX_DOCUMENT_PATH_HANDLES) {
    documentPaths.delete(documentPaths.keys().next().value);
  }
  return handle;
}

/** 세션의 핸들을 찾아 최근 사용으로 올린다. 없으면 null. */
export function lookupDocumentPath(documentPaths, handle) {
  if (!(documentPaths instanceof Map) || typeof handle !== 'string' || !HANDLE_PATTERN.test(handle)) return null;
  const entry = documentPaths.get(handle);
  if (!entry) return null;
  documentPaths.delete(handle);
  documentPaths.set(handle, entry);
  return entry;
}

/**
 * file: 핸들을 다시 확인해 저장된 크기·시각을 갱신하고 tool-request 의 source 를 돌려준다.
 * 사라진 파일은 SOURCE_NOT_FOUND, 더 이상 읽을 수 없는 파일은 SOURCE_UNREADABLE.
 */
export async function refreshDocumentPath(documentPaths, handle, options) {
  const entry = lookupDocumentPath(documentPaths, handle);
  if (!entry) throw pathError('SOURCE_NOT_FOUND', 'file handles come from list_documents');
  let file;
  try {
    file = await validateDocumentPath(entry.path, options);
  } catch (error) {
    if (error?.code === 'PATH_NOT_FOUND') throw pathError('SOURCE_NOT_FOUND', `${entry.name} no longer exists`);
    throw pathError('SOURCE_UNREADABLE', `${entry.name} can no longer be read: ${error.message}`);
  }
  entry.size = file.size;
  entry.mtimeMs = file.mtimeMs;
  return { kind: 'file', handle, name: entry.name, size: file.size, mtimeMs: file.mtimeMs };
}

/**
 * 핸들의 파일 바이트. 경로를 같은 규칙으로 다시 확인하고 O_NOFOLLOW 로 24 MiB 까지만 읽는다.
 * @returns {Promise<{ status: number, bytes?: Buffer, entry?: object, mtimeMs?: number, code?: string }>}
 */
export async function readDocumentPathContent(documentPaths, handle, options) {
  const entry = lookupDocumentPath(documentPaths, handle);
  if (!entry) return { status: 404, code: 'SOURCE_NOT_FOUND' };
  try {
    const file = await validateDocumentPath(entry.path, options);
    const bytes = await readFileBytesBounded(entry.path, {
      maxBytes: DOCUMENT_PATH_MAX_BYTES,
      label: 'Document',
      platform: options?.platform,
    });
    if (bytes.length !== file.size) return { status: 409, code: 'SOURCE_UNREADABLE' };
    return { status: 200, bytes, entry, mtimeMs: file.mtimeMs };
  } catch (error) {
    if (error?.code === 'PATH_NOT_FOUND' || error?.code === 'ENOENT') return { status: 404, code: 'SOURCE_NOT_FOUND' };
    if (error?.code === 'PATH_TOO_LARGE' || error?.code === 'BOUNDED_FILE_TOO_LARGE') return { status: 413, code: 'SOURCE_TOO_LARGE' };
    return { status: 409, code: 'SOURCE_UNREADABLE' };
  }
}

function matchesQuery(name, query) {
  if (!query) return true;
  return String(name ?? '').normalize('NFC').toLowerCase().includes(query);
}

function formatOf(name) {
  const ext = path.extname(String(name ?? '')).slice(1).toLowerCase();
  return DOCUMENT_PATH_EXTENSIONS.includes(ext) ? ext : undefined;
}

/**
 * Studio 가 돌려준 문서 목록에 허브만 아는 것을 더한다.
 * - 다른 창(studioInstanceId)의 채팅에 묶인 문서는 Studio 가 closed 라 해도 open-elsewhere.
 * - 이 채팅 프로젝트의 구성원 문서 중 목록에 없는 것을 project:true 로 덧붙인다(query 로 거른다).
 * - 50개로 자른다.
 * @param {{ result: any, query?: string, liveDocumentId?: string|null,
 *   openElsewhere?: (documentId: string) => boolean,
 *   projectMembers?: { documentId: string, name?: string }[] }} input
 */
export function enrichDocumentList({ result, query = '', liveDocumentId = null, openElsewhere = () => false, projectMembers = [] }) {
  const listed = Array.isArray(result?.documents) ? result.documents.filter((entry) => entry && typeof entry === 'object') : [];
  let truncated = result?.truncated === true;
  const seen = new Set();
  const documents = listed.map((entry) => {
    if (typeof entry.documentId === 'string') seen.add(entry.documentId);
    return entry.state === 'closed' && typeof entry.documentId === 'string' && openElsewhere(entry.documentId)
      ? { ...entry, state: 'open-elsewhere' }
      : entry;
  });
  const needle = String(query ?? '').normalize('NFC').trim().toLowerCase();
  for (const member of Array.isArray(projectMembers) ? projectMembers : []) {
    const documentId = member?.documentId;
    if (typeof documentId !== 'string' || !documentId || seen.has(documentId)) continue;
    seen.add(documentId);
    const name = typeof member.name === 'string' ? member.name : '';
    if (!matchesQuery(name, needle)) continue;
    const format = formatOf(name);
    documents.push({
      documentId,
      name,
      ...(format ? { format } : {}),
      state: documentId === liveDocumentId ? 'open' : openElsewhere(documentId) ? 'open-elsewhere' : 'closed',
      project: true,
    });
  }
  if (documents.length > MAX_LISTED_DOCUMENTS) {
    documents.length = MAX_LISTED_DOCUMENTS;
    truncated = true;
  }
  return { ...(result && typeof result === 'object' ? result : {}), documents, truncated };
}
