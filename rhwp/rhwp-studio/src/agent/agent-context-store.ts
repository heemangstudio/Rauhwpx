import type { InlinePromptSelection } from './inline-prompt-context.ts';

interface CaptureFileData { name: string; mimeType: 'image/png'; bytes: Uint8Array }
export interface DocumentCaptureRecord {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  state: 'queued' | 'consumed' | 'discarded';
  document: { id: string; name: string; revision: number };
  comment: string;
  selection: Omit<InlinePromptSelection, 'attachments'>;
  files: Array<{ name: string; mimeType: 'image/png'; byteLength: number; width: number; height: number }>;
}
export interface DocumentCaptureDraft extends Omit<DocumentCaptureRecord, 'files'> {
  documentId: string;
  label: string;
  /** PNG와 기록 JSON을 일반 첨부 경로로 전달한다. */
  files: File[];
}
interface CaptureDesktopApi {
  saveAgentContext(payload: {
    document: DocumentCaptureRecord['document']; comment: string;
    selection: DocumentCaptureRecord['selection']; files: CaptureFileData[];
  }): Promise<DocumentCaptureRecord>;
  listAgentContexts(documentId: string): Promise<DocumentCaptureRecord[]>;
  readAgentContextFiles(id: string): Promise<CaptureFileData[]>;
  setAgentContextState(ids: string[], state: 'consumed' | 'discarded'): Promise<void>;
}
interface BrowserCapture { record: DocumentCaptureRecord; files: CaptureFileData[] }
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_PENDING = 20;
const DB_NAME = 'rhwp-document-captures';

function desktopApi(): CaptureDesktopApi | undefined {
  const api = (globalThis as { rhwpDesktop?: Partial<CaptureDesktopApi> }).rhwpDesktop;
  return api?.saveAgentContext && api.listAgentContexts && api.readAgentContextFiles && api.setAgentContextState
    ? api as CaptureDesktopApi : undefined;
}
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('이 브라우저에서는 자료를 저장할 수 없습니다.')); return; }
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const store = request.result.objectStoreNames.contains('captures')
        ? request.transaction!.objectStore('captures')
        : request.result.createObjectStore('captures', { keyPath: 'record.id' });
      if (!store.indexNames.contains('documentState')) store.createIndex('documentState', ['record.document.id', 'record.state']);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function browserTransaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, setResult: (value: T) => void) => void): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('captures', mode);
    let result: T;
    transaction.oncomplete = () => { db.close(); resolve(result); };
    transaction.onerror = transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error('자료를 저장하지 못했습니다.')); };
    try { run(transaction.objectStore('captures'), (value) => { result = value; }); }
    catch (error) { transaction.abort(); reject(error); }
  });
}
function toDraft(record: DocumentCaptureRecord, images: CaptureFileData[]): DocumentCaptureDraft {
  return {
    ...record, documentId: record.document.id, label: record.selection.label,
    files: [
      ...images.map((image) => new File([new Uint8Array(image.bytes)], image.name, { type: image.mimeType })),
      new File([JSON.stringify(record, null, 2) + '\n'], `capture-${record.id}.json`, { type: 'application/json' }),
    ],
  };
}
function recordSelection(selection: InlinePromptSelection, id: string): DocumentCaptureRecord['selection'] {
  const { attachments: _attachments, ...saved } = selection;
  let contextBlock = saved.contextBlock;
  const items = saved.items.map((item) => {
    if (item.kind !== 'screenshot') return item;
    const recordAttachmentName = `capture-${id}.json`;
    contextBlock = contextBlock.split(item.recordAttachmentName).join(recordAttachmentName);
    return { ...item, captureId: id, recordAttachmentName };
  });
  return { ...saved, items, contextBlock };
}
async function pngData(files: File[]): Promise<{ data: CaptureFileData[]; descriptors: DocumentCaptureRecord['files'] }> {
  if (files.length > 10 || files.reduce((total, file) => total + file.size, 0) > MAX_BYTES) throw new Error('선택 자료가 너무 큽니다. 영역을 줄여 주세요.');
  const data: CaptureFileData[] = [];
  const descriptors: DocumentCaptureRecord['files'] = [];
  for (const file of files) {
    if (file.type !== 'image/png' || !file.name.toLowerCase().endsWith('.png') || /[\\/\0]/.test(file.name)) throw new Error('선택 자료에 올바른 PNG가 필요합니다.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const header = new DataView(bytes.buffer);
    if (bytes.length < 33 || [137, 80, 78, 71, 13, 10, 26, 10].some((value, index) => bytes[index] !== value)
      || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') throw new Error('올바르지 않은 PNG입니다.');
    const width = header.getUint32(16); const height = header.getUint32(20);
    if (!width || !height || width > 8192 || height > 8192 || width * height > 16_000_000) throw new Error('선택 자료가 너무 큽니다. 영역을 줄여 주세요.');
    data.push({ name: file.name, mimeType: 'image/png', bytes });
    descriptors.push({ name: file.name, mimeType: 'image/png', byteLength: bytes.length, width, height });
  }
  if (new Set(data.map((file) => file.name)).size !== data.length) throw new Error('선택 자료의 파일 이름이 겹칩니다.');
  return { data, descriptors };
}

/** 저장은 네트워크를 쓰지 않는다. 소비·취소 뒤에도 원본 기록은 남긴다. */
export async function saveSelectionCapture(selection: InlinePromptSelection, comment: string, documentName = '제목 없음'): Promise<DocumentCaptureDraft> {
  if (!selection.documentId || !Number.isSafeInteger(selection.revision) || selection.revision! < 0) throw new Error('문서를 연 뒤 자료를 저장해 주세요.');
  if (comment.length > 4000 || documentName.length > 500 || selection.documentId.length > 500
    || new TextEncoder().encode(JSON.stringify({ ...selection, attachments: undefined })).length > 1_000_000) throw new Error('선택 자료가 너무 큽니다.');
  const { data, descriptors } = await pngData(selection.attachments ?? []);
  const document = { id: selection.documentId, name: documentName, revision: selection.revision! };
  const desktop = desktopApi();
  if (desktop) {
    const { attachments: _attachments, ...saved } = selection;
    const record = await desktop.saveAgentContext({ document, comment, selection: saved, files: data });
    return toDraft(record, data);
  }
  const id = crypto.randomUUID();
  const record: DocumentCaptureRecord = {
    schemaVersion: 1, id, createdAt: new Date().toISOString(), state: 'queued', document, comment,
    selection: recordSelection(selection, id), files: descriptors,
  };
  await browserTransaction<void>('readwrite', (store, done) => {
    const request = store.index('documentState').count([document.id, 'queued']);
    request.onsuccess = () => {
      if (request.result >= MAX_PENDING) {
        store.transaction.abort(); return;
      }
      store.put({ record, files: data } satisfies BrowserCapture); done(undefined);
    };
  });
  return toDraft(record, data);
}
export async function listCaptureDrafts(documentId: string): Promise<DocumentCaptureDraft[]> {
  const desktop = desktopApi();
  if (desktop) {
    const records = await desktop.listAgentContexts(documentId);
    return await Promise.all(records.map(async (record) => toDraft(record, await desktop.readAgentContextFiles(record.id))));
  }
  const entries = await browserTransaction<BrowserCapture[]>('readonly', (store, done) => {
    const request = store.index('documentState').getAll([documentId, 'queued']); request.onsuccess = () => done(request.result);
  });
  return entries.filter(({ record }) => record.document.id === documentId && record.state === 'queued')
    .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt))
    .map(({ record, files }) => toDraft(record, files));
}
async function setState(ids: string[], state: 'consumed' | 'discarded'): Promise<void> {
  if (!Array.isArray(ids) || ids.length > MAX_PENDING) throw new Error('올바르지 않은 저장 자료입니다.');
  const desktop = desktopApi();
  if (desktop) { await desktop.setAgentContextState(ids, state); return; }
  await browserTransaction<void>('readwrite', (store, done) => {
    for (const id of new Set(ids)) {
      const request = store.get(id);
      request.onsuccess = () => {
        const entry = request.result as BrowserCapture | undefined;
        if (entry?.record.state === 'queued') { entry.record.state = state; store.put(entry); }
      };
    }
    done(undefined);
  });
}
export function removeCaptureDraft(id: string): Promise<void> { return setState([id], 'discarded'); }
export function consumeCaptureDrafts(ids: string[]): Promise<void> { return setState(ids, 'consumed'); }
