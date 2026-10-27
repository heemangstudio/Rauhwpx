// 에이전트 도구 open_document({path})·create_document({name, folder?})의 데스크톱 쪽.
// 열기 대화상자와 같은 네이티브 핸들(경로 점유·저장 대상)을 만들어, Studio 가 고른 파일을 여는
// 흐름(open-document-bytes)을 그대로 쓰게 한다. 문서 id·북마크·문서 점유는 그 흐름이 잡는다.
// 대화상자와 달리 다른 창이 쥔 문서는 그 창을 앞으로 가져오지 않고 코드만 돌려준다.
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import {
  MAX_NATIVE_DOCUMENT_BYTES,
  hardLinksUnsupported,
  validateNativeDocumentBytes,
} from './native-file-handles.mjs';

export const AGENT_DOCUMENT_EXTENSIONS = Object.freeze(['hwp', 'hwpx', 'hml']);
export const DEFAULT_AGENT_DOCUMENT_NAME = '새 문서';
export const AGENT_DOCUMENT_NAME_MAX_LENGTH = 120;
export const AGENT_DOCUMENT_FOLDER_NAME = 'HamaEditor';
const MAX_COLLISION_SUFFIX = 999;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;
// 제어 문자와 보이지 않는 방향 제어 문자. 이름에 남으면 탐색기에서 확장자를 속일 수 있다.
// eslint-disable-next-line no-control-regex
const INVISIBLE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

function fail(code) {
  return { ok: false, code };
}

function pathApi(platform) {
  return platform === 'win32' ? win32 : posix;
}

/** 절대 경로인지, 네트워크·장치 경로(\\server, //server, \\?\)가 아닌지 글자로만 본다. */
function lexicalAbsolutePath(candidate, platform) {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) return null;
  // UNC·장치 경로는 어느 플랫폼에서도 fs 에 넘기지 않는다. Windows 는 stat 만으로 원격에 접속한다.
  if (/^[\\/]{2}/.test(candidate)) return null;
  if (platform === 'win32') {
    // 드라이브 없는 \foo 는 현재 드라이브 기준이라 절대 경로로 보지 않는다.
    if (!/^[A-Za-z]:[\\/]/.test(candidate)) return null;
  } else if (!posix.isAbsolute(candidate)) {
    return null;
  }
  return pathApi(platform).resolve(candidate);
}

/**
 * 에이전트가 준 문서 경로를 글자로 검사한다. 절대 경로, NUL·UNC·장치 경로 없음, hwp/hwpx/hml.
 * @returns {string | null} 정규화한 경로. 쓸 수 없으면 null.
 */
export function validateAgentDocumentPath(candidate, { platform = process.platform } = {}) {
  const resolved = lexicalAbsolutePath(candidate, platform);
  if (!resolved) return null;
  // NTFS 대체 데이터 스트림(a.txt:hidden.hwp)은 다른 파일의 숨은 내용이다.
  if (platform === 'win32' && win32.basename(resolved).includes(':')) return null;
  const extension = pathApi(platform).extname(resolved).slice(1).toLowerCase();
  return AGENT_DOCUMENT_EXTENSIONS.includes(extension) ? resolved : null;
}

/**
 * 새 문서 파일 이름(확장자 없음). 경로 구분자·예약 문자·제어 문자를 없애고, Windows 예약 이름은
 * 앞에 _ 를 붙이고, 길이를 자른다. 비면 '새 문서'. 문자열이 아니면 null.
 */
export function sanitizeAgentDocumentName(value) {
  if (value === undefined || value === null) return DEFAULT_AGENT_DOCUMENT_NAME;
  if (typeof value !== 'string') return null;
  let name = value.normalize('NFC')
    .replace(INVISIBLE_CHARACTERS, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 에이전트가 확장자까지 붙여 주면 떼어 낸다 (보고서.hwpx → 보고서).
  while (/\.(?:hwpx|hwp|hml|hwpml)$/i.test(name)) name = name.replace(/\.[^.]+$/, '').trim();
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  const characters = [...name];
  if (characters.length > AGENT_DOCUMENT_NAME_MAX_LENGTH) {
    name = characters.slice(0, AGENT_DOCUMENT_NAME_MAX_LENGTH).join('').replace(/[.\s]+$/, '');
  }
  if (!name) return DEFAULT_AGENT_DOCUMENT_NAME;
  if (WINDOWS_DEVICE_NAME.test(name)) name = `_${name}`;
  return name;
}

/** 기본 저장 폴더: ~/Documents/HamaEditor */
export function defaultAgentDocumentFolder(documentsPath, { platform = process.platform } = {}) {
  return pathApi(platform).join(documentsPath, AGENT_DOCUMENT_FOLDER_NAME);
}

function readFailureCode(error) {
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'NOT_FOUND';
  if (/exceeds the .* MiB limit/.test(String(error?.message))) return 'TOO_LARGE';
  return 'UNREADABLE';
}

/** 이 창의 핸들이 가리키는 문서를 다른 창이 문서 점유로 쥐고 있는가. */
function ownedElsewhere(sessionId, descriptor, { nativeFiles, documentLeases }) {
  if (!documentLeases) return false;
  const ownershipPath = nativeFiles.pathForSender(sessionId, descriptor.handleId);
  const pathOwner = documentLeases.ownerForPath(ownershipPath);
  if (pathOwner && pathOwner !== sessionId) return true;
  const documentOwner = descriptor.verifiedDocumentId
    ? documentLeases.ownerForDocument(descriptor.verifiedDocumentId)
    : null;
  return Boolean(documentOwner && documentOwner !== sessionId);
}

/**
 * 경로의 문서를 이 창의 네이티브 핸들로 열고 바이트를 읽는다.
 * 성공하면 열기 대화상자와 같은 서술자에 name·bytes·path 를 더해 돌려준다.
 * @returns {Promise<{ ok: true, kind: 'file', handleId: string, name: string, verifiedDocumentId?: string,
 *   saveTargetCreated: boolean, bytes: Uint8Array, path: string }
 *   | { ok: false, code: 'INVALID_PATH' | 'NOT_FOUND' | 'UNREADABLE' | 'TOO_LARGE' | 'DOC_OPEN_ELSEWHERE' }>}
 */
export async function openAgentDocumentAtPath(sessionId, filePath, {
  nativeFiles,
  documentLeases = null,
  platform = process.platform,
  lstatImpl = lstat,
  maxBytes = MAX_NATIVE_DOCUMENT_BYTES,
} = {}) {
  const resolved = validateAgentDocumentPath(filePath, { platform });
  if (!resolved) return fail('INVALID_PATH');
  let info;
  try {
    info = await lstatImpl(resolved);
  } catch (error) {
    return fail(error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'NOT_FOUND' : 'UNREADABLE');
  }
  if (info.isSymbolicLink() || !info.isFile()) return fail('INVALID_PATH');
  if (!Number.isSafeInteger(info.size) || info.size <= 0) return fail('UNREADABLE');
  if (info.size > maxBytes) return fail('TOO_LARGE');

  let created;
  try {
    created = await nativeFiles.create(sessionId, resolved);
  } catch (error) {
    return fail(readFailureCode(error));
  }
  if (!created.ok) return fail('DOC_OPEN_ELSEWHERE');
  const { descriptor } = created;
  const releaseIfNew = () => {
    if (created.created) nativeFiles.releaseHandle(sessionId, descriptor.handleId);
  };
  if (ownedElsewhere(sessionId, descriptor, { nativeFiles, documentLeases })) {
    releaseIfNew();
    return fail('DOC_OPEN_ELSEWHERE');
  }
  let read;
  try {
    read = await nativeFiles.read(sessionId, descriptor.handleId);
  } catch (error) {
    releaseIfNew();
    return fail(readFailureCode(error));
  }
  return {
    ok: true,
    ...descriptor,
    saveTargetCreated: created.created,
    name: read.name,
    bytes: read.bytes,
    path: nativeFiles.sourcePathForSender(sessionId, descriptor.handleId),
  };
}

async function writeExclusive(target, bytes) {
  const handle = await open(target, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * target 이 없을 때만 바이트를 채운 파일로 만든다. 임시 파일을 다 쓴 뒤 하드 링크로 걸어
 * 반쯤 쓴 문서가 보이지 않게 한다. 링크를 못 거는 볼륨(FAT·일부 네트워크)은 배타 생성으로 쓴다.
 * 이미 있으면 false. 어느 경우에도 있는 파일을 덮어쓰지 않는다.
 */
async function publishNewFile(folder, target, bytes, platform) {
  const temp = pathApi(platform).join(folder, `.${randomUUID()}.rauhwpx-create`);
  try {
    await writeExclusive(temp, bytes);
    try {
      await link(temp, target);
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      if (!hardLinksUnsupported(error, platform)) throw error;
    }
    try {
      await writeExclusive(target, bytes);
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      await rm(target, { force: true }).catch(() => {});
      throw error;
    }
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

function foldPath(value, platform) {
  const text = value.normalize('NFC');
  return platform === 'darwin' || platform === 'win32' ? text.toLowerCase() : text;
}

function insideFolder(child, parent, platform) {
  const api = pathApi(platform);
  const folded = foldPath(child, platform);
  const root = foldPath(parent, platform);
  return folded === root || folded.startsWith(root.endsWith(api.sep) ? root : `${root}${api.sep}`);
}

/**
 * 에이전트가 고른 폴더. 허브가 이미 검사했지만 여기서도 같은 규칙을 다시 본다 — 절대 경로(UNC·장치 경로 아님),
 * 이미 있는 실제 폴더, 경로의 어느 부분도 링크가 아님, 홈 폴더 안. home 이 없으면 홈 검사를 하지 않는다.
 */
async function resolveTargetFolder(folder, { defaultFolder, home, platform, lstatImpl, realpathImpl }) {
  if (folder === undefined || folder === null || folder === '') {
    if (!defaultFolder) return null;
    await mkdir(defaultFolder, { recursive: true });
    return (await stat(defaultFolder)).isDirectory() ? defaultFolder : null;
  }
  const resolved = lexicalAbsolutePath(folder, platform);
  if (!resolved) return null;
  try {
    const info = await lstatImpl(resolved);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    // 링크된 상위 폴더가 있으면 실제 경로가 입력과 달라진다.
    const real = await realpathImpl(resolved);
    if (foldPath(real, platform) !== foldPath(resolved, platform)) return null;
    if (home && !insideFolder(real, await realpathImpl(home), platform)) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * <folder>/<name>.hwpx 를 새로 만들고, 그 경로를 연 것처럼 이 창의 네이티브 핸들을 잡는다. folder 가 없으면
 * defaultFolder 를 (없으면 만들어) 쓴다. 주어진 folder 는 home 안의 실제 폴더여야 한다.
 * 같은 이름이 있으면 "<name> (2).hwpx", "(3)" … 으로 비켜 가고 절대 덮어쓰지 않는다.
 * @returns {Promise<{ ok: true, kind: 'file', handleId: string, name: string, saveTargetCreated: boolean,
 *   path: string } | { ok: false, code: 'INVALID_NAME' | 'INVALID_FOLDER' | 'WRITE_FAILED' }>}
 */
export async function createAgentDocument(sessionId, { name, folder, bytes } = {}, {
  nativeFiles,
  defaultFolder,
  home = null,
  platform = process.platform,
  lstatImpl = lstat,
  realpathImpl = realpath,
} = {}) {
  const stem = sanitizeAgentDocumentName(name);
  if (!stem) return fail('INVALID_NAME');
  let targetFolder;
  try {
    targetFolder = await resolveTargetFolder(folder, { defaultFolder, home, platform, lstatImpl, realpathImpl });
  } catch {
    return fail(folder ? 'INVALID_FOLDER' : 'WRITE_FAILED');
  }
  if (!targetFolder) return fail('INVALID_FOLDER');
  const path = pathApi(platform);
  const data = bytes instanceof Uint8Array ? bytes : null;
  try {
    if (!data) throw new Error('bytes required');
    validateNativeDocumentBytes(path.join(targetFolder, `${stem}.hwpx`), data);
  } catch {
    return fail('WRITE_FAILED');
  }

  let target = null;
  try {
    for (let index = 1; index <= MAX_COLLISION_SUFFIX && !target; index += 1) {
      const candidate = path.join(targetFolder, index === 1 ? `${stem}.hwpx` : `${stem} (${index}).hwpx`);
      if (await publishNewFile(targetFolder, candidate, data, platform)) target = candidate;
    }
  } catch {
    return fail('WRITE_FAILED');
  }
  if (!target) return fail('WRITE_FAILED');

  let created;
  try {
    created = await nativeFiles.create(sessionId, target);
  } catch {
    created = null;
  }
  if (!created?.ok) {
    // 방금 만든 파일이고 아무도 쥐지 않았다. 등록하지 못했으면 남기지 않는다.
    if (!created) await rm(target, { force: true }).catch(() => {});
    return fail('WRITE_FAILED');
  }
  return {
    ok: true,
    ...created.descriptor,
    saveTargetCreated: created.created,
    path: nativeFiles.sourcePathForSender(sessionId, created.descriptor.handleId),
  };
}
