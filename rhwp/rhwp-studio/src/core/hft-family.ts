/**
 * 한컴 HFT 글꼴 가족(문자군별 파일 묶음)을 OpenType 하나로 바꾸는 실행 경로.
 * 변환은 Worker에서 하고, 결과는 IndexedDB에 남겨 다음 실행부터는 원본을 다시 읽지 않는다.
 * Worker나 IndexedDB를 쓸 수 없으면 메인 스레드 변환·캐시 없음으로 동작한다.
 */
import { convertHftFamilyToOpenType } from './hft-font.ts';
import { openIndexedDatabase, withTimeout, IDB_OPERATION_TIMEOUT_MS } from './idb-open.ts';

export interface HftFamilyFile { bytes: ArrayBuffer; fileName: string }

export type HftFamilyWorkerRequest = { id: number; files: HftFamilyFile[]; family: string };
export type HftFamilyWorkerResponse =
  | { id: number; ok: true; bytes: ArrayBuffer }
  | { id: number; ok: false; error: string };

// 변환 규칙이 바뀌면 올려서 옛 결과를 버린다.
const CACHE_FORMAT = 1;
const DB_NAME = 'rhwp-hft-fonts';
const STORE = 'converted';
/** 가족 하나가 1~4 MB라 오래 안 쓴 것부터 지운다. */
const MAX_CACHED_FAMILIES = 48;

/** 변환 결과 또는 변환할 수 없는 가족(보호된 HFT 등)의 사유. 실패도 기억해 원본을 다시 읽지 않는다. */
interface CachedFamily { bytes?: ArrayBuffer; error?: string; usedAt: number }

export type CachedHftFamily = { bytes: ArrayBuffer } | { error: string };

/** 원본 face id는 (경로, 크기, 수정 시각)을 담으므로 파일이 바뀌면 키도 바뀐다. */
export function hftFamilyCacheKey(faceIds: readonly string[], family: string): string {
  return `${CACHE_FORMAT}:${family}:${faceIds.join(',')}`;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  dbPromise ??= openIndexedDatabase(DB_NAME, 1, (database) => {
    if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
  });
  return dbPromise;
}

function request<T>(database: IDBDatabase, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return withTimeout(new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE, mode);
    const pending = action(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(pending.result);
    transaction.onerror = () => reject(transaction.error ?? pending.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  }), IDB_OPERATION_TIMEOUT_MS, 'hft font cache');
}

export async function loadCachedHftFamily(key: string): Promise<CachedHftFamily | null> {
  try {
    const database = await db();
    if (!database) return null;
    const entry = await request<CachedFamily | undefined>(database, 'readonly', store => store.get(key));
    const found: CachedHftFamily | null = entry?.bytes instanceof ArrayBuffer ? { bytes: entry.bytes }
      : typeof entry?.error === 'string' ? { error: entry.error } : null;
    if (!found) return null;
    void request(database, 'readwrite', store => store.put({ ...entry, usedAt: Date.now() }, key)).catch(() => {});
    return found;
  } catch {
    return null;
  }
}

export async function saveCachedHftFamily(key: string, result: CachedHftFamily): Promise<void> {
  try {
    const database = await db();
    if (!database) return;
    await request(database, 'readwrite', store => store.put({ ...result, usedAt: Date.now() } satisfies CachedFamily, key));
    const keys = await request<IDBValidKey[]>(database, 'readonly', store => store.getAllKeys());
    if (keys.length <= MAX_CACHED_FAMILIES) return;
    const entries = await request<CachedFamily[]>(database, 'readonly', store => store.getAll());
    const oldest = keys
      .map((entryKey, i) => ({ entryKey, usedAt: entries[i]?.usedAt ?? 0 }))
      .sort((a, b) => a.usedAt - b.usedAt)
      .slice(0, keys.length - MAX_CACHED_FAMILIES);
    await request(database, 'readwrite', (store) => {
      let last: IDBRequest<undefined> = store.delete(oldest[0]!.entryKey);
      for (const { entryKey } of oldest.slice(1)) last = store.delete(entryKey);
      return last;
    });
  } catch {
    /* 캐시는 최선 노력이다. */
  }
}

type Converter = (files: HftFamilyFile[], family: string) => Promise<ArrayBuffer>;

const inlineConverter: Converter = async (files, family) => convertHftFamilyToOpenType(files, family);

let converter: Converter | null = null;

function workerConverter(): Converter | null {
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return null;
  let worker: Worker;
  try {
    worker = new Worker(new URL('./hft-font.worker.ts', import.meta.url), { type: 'module', name: 'rhwp-hft-font' });
  } catch {
    return null;
  }
  let nextId = 0;
  let broken = false;
  const pending = new Map<number, { resolve: (bytes: ArrayBuffer) => void; reject: (error: Error) => void }>();
  worker.onmessage = (event: MessageEvent<HftFamilyWorkerResponse>) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    if (event.data.ok) entry.resolve(event.data.bytes);
    else entry.reject(new Error(event.data.error));
  };
  worker.onerror = (event) => {
    // 모듈을 불러오지 못한 Worker는 메인 스레드 변환으로 바꾼다.
    event.preventDefault?.();
    broken = true;
    for (const entry of pending.values()) entry.reject(new Error(HFT_WORKER_FAILED));
    pending.clear();
    worker.terminate();
  };
  return async (files, family) => {
    if (broken) return inlineConverter(files, family);
    const id = ++nextId;
    return new Promise<ArrayBuffer>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, files, family } satisfies HftFamilyWorkerRequest, files.map(file => file.bytes));
    });
  };
}

export const HFT_WORKER_FAILED = 'hft font worker failed';

/**
 * 원본 바이트는 Worker로 옮겨지므로(transfer) 호출 뒤에는 쓰지 않는다. Worker가 죽어
 * `HFT_WORKER_FAILED`로 끝나면 원본을 다시 읽어 한 번 더 부르면 메인 스레드에서 변환한다.
 */
export function convertHftFamily(files: HftFamilyFile[], family: string): Promise<ArrayBuffer> {
  converter ??= workerConverter() ?? inlineConverter;
  return converter(files, family);
}
