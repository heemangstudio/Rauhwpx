import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recoverReplacedFile, replaceFile } from './fs-replace.mjs';

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_SELECTION_BYTES = 1024 * 1024;
const MAX_PENDING_CONTEXTS = 20;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function boundedString(value, max, name) {
  if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid capture ${name}`);
  return value;
}

function imageFile(raw) {
  const name = boundedString(raw?.name, 200, 'image name');
  if (!name.toLowerCase().endsWith('.png') || /[\\/\0]/.test(name) || name === '.' || name === '..') throw new Error('Invalid capture image name');
  const bytes = raw?.bytes instanceof Uint8Array ? Buffer.from(raw.bytes) : null;
  if (!bytes || bytes.byteLength < 33 || bytes.byteLength > MAX_IMAGE_BYTES
    || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid capture PNG');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16_000_000) throw new Error('Capture image exceeds pixel limit');
  return { name, bytes, descriptor: { name, mimeType: 'image/png', byteLength: bytes.byteLength, width, height } };
}

function validateSelection(selection) {
  if (!selection || typeof selection !== 'object' || !Array.isArray(selection.items)
    || selection.items.length > 500 || Buffer.byteLength(JSON.stringify(selection)) > MAX_SELECTION_BYTES) throw new Error('Invalid capture selection');
  boundedString(selection.label, 1000, 'label');
  boundedString(selection.excerpt, 4000, 'excerpt');
  boundedString(selection.contextBlock, MAX_SELECTION_BYTES, 'context');
  for (const item of selection.items) {
    if (!item || typeof item !== 'object' || !['text', 'table', 'equation', 'object', 'screenshot'].includes(item.kind)) throw new Error('Invalid capture item');
    if (item.kind !== 'screenshot') continue;
    imageFileName(item.attachmentName);
    boundedString(item.recordAttachmentName, 200, 'record attachment');
    boundedString(item.comment, 4000, 'comment');
    if (!Array.isArray(item.pageRegions) || !item.pageRegions.length || item.pageRegions.length > 10) throw new Error('Invalid capture geometry');
    for (const part of item.pageRegions) {
      if (!Number.isSafeInteger(part.pageIndex) || part.pageIndex < 0
        || !['pageWidth', 'pageHeight', 'x', 'y', 'width', 'height'].every((key) => Number.isFinite(part[key]))
        || part.pageWidth <= 0 || part.pageHeight <= 0 || part.x < 0 || part.y < 0 || part.width <= 0 || part.height <= 0
        || part.x + part.width > part.pageWidth + 0.01 || part.y + part.height > part.pageHeight + 0.01) throw new Error('Invalid capture geometry');
    }
  }
}

/** 로컬 문맥의 JSON과 이미지를 고정 디렉터리에 저장한다. renderer는 경로를 넘기지 않는다. */
export function createAgentContextStore({ rootDir, now = () => new Date() }) {
  const contextDir = (id) => {
    if (!UUID.test(String(id))) throw new Error('Invalid capture id');
    return join(rootDir, id);
  };
  let mutations = Promise.resolve();
  function mutate(run) {
    const result = mutations.then(run);
    mutations = result.catch(() => undefined);
    return result;
  }
  async function readBounded(directory, name, limit) {
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Invalid capture directory');
    const entryInfo = await lstat(join(directory, name));
    if (!entryInfo.isFile() || entryInfo.isSymbolicLink() || entryInfo.size > limit) throw new Error('Invalid capture file');
    const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > limit) throw new Error('Capture file exceeds size limit');
      const bytes = Buffer.alloc(info.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const { bytesRead } = await file.read(bytes, count, bytes.length - count, null);
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count > info.size) throw new Error('Capture file changed while reading');
      return bytes.subarray(0, count);
    } finally { await file.close(); }
  }
  async function readRecord(id) {
    const directoryInfo = await lstat(contextDir(id));
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Invalid capture directory');
    await recoverReplacedFile(join(contextDir(id), 'record.json'));
    const record = JSON.parse((await readBounded(contextDir(id), 'record.json', MAX_SELECTION_BYTES + 64 * 1024)).toString('utf8'));
    if (record.id !== id || record.schemaVersion !== 1 || !['queued', 'consumed', 'discarded'].includes(record.state)) throw new Error('Invalid capture record');
    boundedString(record.createdAt, 100, 'date');
    boundedString(record.document?.id, 500, 'document id');
    boundedString(record.document?.name, 500, 'document name');
    if (!Number.isSafeInteger(record.document?.revision) || record.document.revision < 0) throw new Error('Invalid capture revision');
    boundedString(record.comment, 4000, 'comment');
    validateSelection(record.selection);
    if (!Array.isArray(record.files) || record.files.length > 10) throw new Error('Invalid capture files');
    let total = 0;
    for (const file of record.files) {
      imageFileName(file.name);
      if (file.mimeType !== 'image/png' || !Number.isSafeInteger(file.byteLength) || file.byteLength < 33
        || !Number.isSafeInteger(file.width) || !Number.isSafeInteger(file.height)
        || file.width <= 0 || file.height <= 0 || file.width > 8192 || file.height > 8192
        || file.width * file.height > 16_000_000) throw new Error('Invalid capture file');
      total += file.byteLength;
    }
    if (total > MAX_IMAGE_BYTES) throw new Error('Capture files exceed size limit');
    return record;
  }
  async function list(documentId) {
    boundedString(documentId, 500, 'document id');
    const names = await readdir(rootDir).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const records = [];
    for (const id of names.filter((name) => UUID.test(name))) {
      try {
        const record = await readRecord(id);
        if (record.document.id === documentId && record.state === 'queued') records.push(record);
      } catch { /* 손상된 한 건 때문에 다른 메모 복원을 막지 않는다. */ }
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  return {
    list,
    save(payload) { return mutate(async () => {
      const documentId = boundedString(payload?.document?.id, 500, 'document id');
      if (!documentId) throw new Error('A loaded document is required for capture');
      const documentName = boundedString(payload?.document?.name, 500, 'document name');
      const revision = payload?.document?.revision;
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid capture revision');
      const comment = boundedString(payload?.comment, 4000, 'comment');
      const selection = payload?.selection;
      validateSelection(selection);
      if (!Array.isArray(payload?.files) || payload.files.length > 10) throw new Error('Invalid capture files');
      const images = payload.files.map(imageFile);
      if (new Set(images.map((image) => image.name)).size !== images.length
        || images.reduce((size, image) => size + image.bytes.byteLength, 0) > MAX_IMAGE_BYTES) throw new Error('Capture files exceed size limit');
      if ((await list(documentId)).length >= MAX_PENDING_CONTEXTS) throw new Error('저장된 메모가 많습니다. 대기 중인 메모를 먼저 정리해 주세요.');
      const id = randomUUID();
      let contextBlock = selection.contextBlock;
      const items = selection.items.map((item) => {
        if (item.kind !== 'screenshot') return item;
        const recordAttachmentName = `capture-${id}.json`;
        contextBlock = contextBlock.split(item.recordAttachmentName).join(recordAttachmentName);
        if (!images.some((image) => image.name === item.attachmentName)) throw new Error('Missing capture image');
        return { ...item, captureId: id, recordAttachmentName };
      });
      const record = {
        schemaVersion: 1, id, createdAt: now().toISOString(), state: 'queued',
        document: { id: documentId, name: documentName, revision }, comment,
        selection: {
          label: selection.label, excerpt: selection.excerpt, contextBlock, items,
          documentId, revision,
        },
        files: images.map((image) => image.descriptor),
      };
      await mkdir(rootDir, { recursive: true, mode: 0o700 });
      const temporary = join(rootDir, `.pending-${id}`);
      try {
        await mkdir(temporary, { mode: 0o700 });
        for (const image of images) await writeFile(join(temporary, image.name), image.bytes, { mode: 0o600 });
        await writeFile(join(temporary, 'record.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
        await rename(temporary, contextDir(id));
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
      return record;
    }); },
    async readFiles(id) {
      const record = await readRecord(id);
      return await Promise.all(record.files.map(async (file) => {
        const bytes = await readBounded(contextDir(id), imageFileName(file.name), file.byteLength);
        if (bytes.length !== file.byteLength) throw new Error('Capture image size changed');
        imageFile({ name: file.name, bytes });
        return { name: file.name, mimeType: file.mimeType, bytes: new Uint8Array(bytes) };
      }));
    },
    setState(ids, state) { return mutate(async () => {
      if (!['consumed', 'discarded'].includes(state) || !Array.isArray(ids) || ids.length > MAX_PENDING_CONTEXTS) throw new Error('Invalid capture state');
      for (const id of new Set(ids)) {
        const record = await readRecord(id);
        if (record.state !== 'queued') continue;
        record.state = state;
        const directory = contextDir(id);
        const temporary = join(directory, `.record-${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
          await replaceFile(temporary, join(directory, 'record.json'));
        } finally { await rm(temporary, { force: true }); }
      }
    }); },
  };
}

function imageFileName(name) {
  boundedString(name, 200, 'image name');
  if (/[\\/\0]/.test(name) || !name.toLowerCase().endsWith('.png')) throw new Error('Invalid capture image name');
  return name;
}

/** 신뢰한 문서 창의 CSS 영역만 캡처하고, 원본 경로나 다른 창을 받지 않는다. */
export async function captureDocumentRegion({ webContents, bounds, rect }) {
  if (!rect || !['x', 'y', 'width', 'height'].every((key) => Number.isSafeInteger(rect[key]))
    || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0
    || rect.x + rect.width > bounds.width || rect.y + rect.height > bounds.height
    || rect.width > 8192 || rect.height > 8192 || rect.width * rect.height > 16_000_000) throw new Error('Invalid document capture bounds');
  // capturePage의 물리 픽셀 수는 화면 DPR에 따라 커진다. 호출 전에 보수적으로 제한한다.
  const zoom = webContents.getZoomFactor();
  const scale = Math.max(1, bounds.scaleFactor ?? 1) * Math.max(1, zoom);
  if (rect.width * scale > 8192 || rect.height * scale > 8192 || rect.width * rect.height * scale * scale > 16_000_000) throw new Error('Document capture exceeds pixel limit');
  const image = await webContents.capturePage({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  const bytes = image.toPNG();
  const validated = imageFile({ name: 'region.png', bytes });
  return { bytes: new Uint8Array(bytes), width: validated.descriptor.width, height: validated.descriptor.height };
}

export function installAgentContextStore({ ipcMain, rootDir, sessionForEvent, capturePageForEvent }) {
  const store = createAgentContextStore({ rootDir });
  ipcMain.handle('desktop:agent-context-save', (event, payload) => { sessionForEvent(event); return store.save(payload); });
  ipcMain.handle('desktop:agent-context-list', (event, documentId) => { sessionForEvent(event); return store.list(documentId); });
  ipcMain.handle('desktop:agent-context-files', (event, id) => { sessionForEvent(event); return store.readFiles(id); });
  ipcMain.handle('desktop:agent-context-state', (event, ids, state) => { sessionForEvent(event); return store.setState(ids, state); });
  if (capturePageForEvent) ipcMain.handle('desktop:agent-context-capture', (event, rect) => { sessionForEvent(event); return capturePageForEvent(event, rect); });
}
