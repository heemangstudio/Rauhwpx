/**
 * 문서 홈의 첫 쪽 미리보기 저장소. 그림만 담고 문서 바이트는 담지 않는다.
 *
 * 항목마다 stamp(파일 크기·수정 시각, 템플릿 개정 등)를 함께 두어 원본이 바뀌면 다시
 * 그린다. 항목 수에 상한을 두고, 넘치면 가장 오래 전에 그린 것부터 지운다. IndexedDB 를
 * 쓸 수 없는 환경에서는 같은 규칙의 메모리 저장소를 쓴다.
 */
import {
  openIndexedDatabase,
  requestResult,
  transactionDone,
  withDatabase,
} from '../core/idb-open.ts';

const DB_NAME = 'rhwpStudioDocumentHome';
const DB_VER = 1;
const STORE = 'thumbnails';
export const THUMBNAIL_CACHE_LIMIT = 160;

export interface CachedThumbnail {
  key: string;
  stamp: string;
  blob: Blob;
  usedAt: number;
}

const memory = new Map<string, CachedThumbnail>();

function openDb(): Promise<IDBDatabase | null> {
  return openIndexedDatabase(DB_NAME, DB_VER, (db) => {
    if (!db.objectStoreNames.contains(STORE)) {
      db.createObjectStore(STORE, { keyPath: 'key' }).createIndex('usedAt', 'usedAt');
    }
  });
}

function trimMemory(): void {
  if (memory.size <= THUMBNAIL_CACHE_LIMIT) return;
  const oldest = [...memory.values()].sort((a, b) => a.usedAt - b.usedAt);
  for (const row of oldest.slice(0, memory.size - THUMBNAIL_CACHE_LIMIT)) memory.delete(row.key);
}

/** 저장한 미리보기. stamp 가 다르면 낡은 그림이므로 호출 쪽이 다시 그린다. */
export function readThumbnail(key: string): Promise<CachedThumbnail | null> {
  return withDatabase(openDb, DB_NAME, async (db) => {
    return await requestResult(
      db.transaction(STORE, 'readonly').objectStore(STORE).get(key) as IDBRequest<CachedThumbnail | undefined>,
    ) ?? null;
  }, async () => memory.get(key) ?? null);
}

export function writeThumbnail(key: string, stamp: string, blob: Blob): Promise<void> {
  const row: CachedThumbnail = { key, stamp, blob, usedAt: Date.now() };
  return withDatabase(openDb, DB_NAME, async (db) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.put(row);
    const count = await requestResult(store.count());
    if (count > THUMBNAIL_CACHE_LIMIT) {
      let excess = count - THUMBNAIL_CACHE_LIMIT;
      const cursor = store.index('usedAt').openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current || excess <= 0) return;
        if ((current.value as CachedThumbnail).key !== key) {
          current.delete();
          excess -= 1;
        }
        current.continue();
      };
    }
    await transactionDone(tx);
  }, async () => {
    memory.set(key, row);
    trimMemory();
  });
}

export function deleteThumbnail(key: string): Promise<void> {
  memory.delete(key);
  return withDatabase(openDb, DB_NAME, async (db) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    await transactionDone(tx);
  }, async () => {});
}
