// browser_upload 이 웹사이트에 보낼 수 있는 파일. 에이전트는 로컬 경로를 고르지 못하고,
// 이 채팅이 이미 가진 파일(생성 문서, 받은 파일, 프로젝트 파일, 열린 문서의 사본)만 고른다.
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

export const UPLOAD_LIMITS = Object.freeze({ files: 5, fileBytes: 20 * 1024 * 1024, totalBytes: 40 * 1024 * 1024 });

const failure = (code, message) => Object.assign(new Error(message), { code });
const inside = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const cleanName = (value, fallback) => path.basename(String(value ?? '').replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || fallback;

/** 크기를 먼저 확인하고 일반 파일만 읽는다. 읽는 동안 바뀐 파일은 거절한다. */
async function readPlainFile(filePath, maxBytes) {
  const info = await fs.lstat(filePath).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw failure('BROWSER_UPLOAD_SOURCE_NOT_FOUND', 'The upload file is unavailable.');
  if (info.size > maxBytes) throw failure('BROWSER_UPLOAD_LIMIT', 'Each upload file must be 20 MB or smaller.');
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const bytes = await handle.readFile();
    if (bytes.length !== info.size) throw failure('BROWSER_UPLOAD_SOURCE_CHANGED', 'The upload file changed while it was read.');
    return bytes;
  } finally { await handle.close(); }
}

/**
 * 출처 하나를 { name, mimeType, buffer } 로 바꾼다. 출처마다 이 채팅(또는 이 에이전트)의 소유를 확인한다.
 * - artifactId: 이 채팅이 publish_artifact 로 만든 문서
 * - downloadId: 이 에이전트의 완료된 브라우저 다운로드
 * - projectItemId: 이 채팅 프로젝트의 파일 항목
 * - snapshotPath: materialize_document_snapshot 이 이 채팅에 돌려준 열린 문서의 사본
 */
async function resolveSource(source, { actor, artifactStore, downloads, projectStore, referenceStore, snapshotRoot }) {
  const { fileBytes } = UPLOAD_LIMITS;
  if (source.artifactId) {
    const metadata = await artifactStore?.describe(source.artifactId).catch(() => null);
    if (!metadata?.owner?.threadId || metadata.owner.threadId !== actor.threadId) throw failure('BROWSER_UPLOAD_SOURCE_NOT_FOUND', 'This chat has no artifact with that artifactId.');
    if (metadata.size > fileBytes) throw failure('BROWSER_UPLOAD_LIMIT', 'Each upload file must be 20 MB or smaller.');
    const artifact = await artifactStore.read(source.artifactId);
    return { name: cleanName(artifact.fileName, 'document'), mimeType: artifact.mime || 'application/octet-stream', buffer: Buffer.from(artifact.bytes) };
  }
  if (source.downloadId) {
    const job = await downloads?.get({ downloadId: source.downloadId, actor }).catch(() => null);
    if (!job) throw failure('BROWSER_UPLOAD_SOURCE_NOT_FOUND', 'This chat has no browser download with that downloadId.');
    if (job.size > fileBytes) throw failure('BROWSER_UPLOAD_LIMIT', 'Each upload file must be 20 MB or smaller.');
    const { bytes, mimeType, filename } = await downloads.readBytes({ downloadId: source.downloadId, actor });
    return { name: cleanName(filename, 'download'), mimeType: mimeType || 'application/octet-stream', buffer: Buffer.from(bytes) };
  }
  if (source.projectItemId) {
    if (!actor.projectId || !projectStore || !referenceStore) throw failure('BROWSER_UPLOAD_SOURCE_NOT_FOUND', 'This chat has no research project.');
    const item = await projectStore.getItem(actor.projectId, source.projectItemId).catch(() => null);
    if (item?.kind !== 'file' || !item.fileId) throw failure('BROWSER_UPLOAD_SOURCE_NOT_FOUND', 'The project item is not a file.');
    const scopes = [item.scope === 'global' ? { scope: 'global', scopeId: 'global' } : { scope: 'project', scopeId: actor.projectId }];
    const blob = await referenceStore.openBlob({ fileId: item.fileId, scopes });
    if (blob.size > fileBytes) throw failure('BROWSER_UPLOAD_LIMIT', 'Each upload file must be 20 MB or smaller.');
    return { name: cleanName(item.originalName ?? blob.name, 'file'), mimeType: blob.mimeType || 'application/octet-stream', buffer: await readPlainFile(blob.path, fileBytes) };
  }
  if (source.snapshotPath) {
    // 사본 경로는 모델이 보낸 값이다. 이 채팅의 사본 폴더 안 일반 파일인지 실제 경로로 확인한다.
    const root = snapshotRoot ? await fs.realpath(snapshotRoot).catch(() => null) : null;
    const file = await fs.realpath(path.resolve(String(source.snapshotPath))).catch(() => null);
    if (!root || !file || !inside(root, file)) throw failure('BROWSER_UPLOAD_SOURCE_NOT_FOUND', 'Pass a path returned by materialize_document_snapshot in this chat.');
    const name = cleanName(file, 'document');
    const mimeType = name.toLowerCase().endsWith('.hwpx') ? 'application/vnd.hancom.hwpx+zip' : name.toLowerCase().endsWith('.hwp') ? 'application/x-hwp' : 'application/octet-stream';
    return { name, mimeType, buffer: await readPlainFile(file, fileBytes) };
  }
  throw failure('BROWSER_UPLOAD_INVALID', 'Each file needs artifactId, downloadId, projectItemId or snapshotPath.');
}

export async function resolveBrowserUploadFiles(files, context) {
  if (!Array.isArray(files) || files.length === 0) throw failure('BROWSER_UPLOAD_INVALID', 'Choose at least one file.');
  if (files.length > UPLOAD_LIMITS.files) throw failure('BROWSER_UPLOAD_LIMIT', 'Choose at most five files.');
  const payloads = [];
  let total = 0;
  for (const source of files) {
    const payload = await resolveSource(source ?? {}, context);
    total += payload.buffer.length;
    if (total > UPLOAD_LIMITS.totalBytes) throw failure('BROWSER_UPLOAD_LIMIT', 'The files exceed the 40 MB upload limit.');
    payloads.push(payload);
  }
  return payloads;
}
