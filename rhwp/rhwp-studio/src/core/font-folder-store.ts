/**
 * 글꼴 폴더 연결의 IndexedDB 저장소. 메인 스레드는 폴더 핸들을, Worker는 파싱 캐시를 쓴다.
 * 글꼴 바이트는 저장하지 않는다. IndexedDB가 없으면 모든 호출이 아무것도 하지 않는다.
 */
import type { ParsedFontFileResult } from '../../../rhwp-shared/fonts/font-index-core.mjs';

const DB_NAME = 'hamaeditor-font-folder';
const DB_VERSION = 1;
const HANDLE_STORE = 'handles';
const CACHE_STORE = 'index-cache';
const HANDLE_KEY = 'folder';

export interface FontFolderCacheData {
  format: number;
  files: Record<string, ParsedFontFileResult>;
}

/** 파일별 파싱 결과 캐시. 키는 폴더 이름이고 항목은 (상대 경로, 크기, 수정 시각)으로 검증한다. */
export interface FontFolderCache {
  load(key: string): Promise<FontFolderCacheData | null>;
  save(key: string, data: FontFolderCacheData): Promise<void>;
  clear(): Promise<void>;
}

function idb(): IDBFactory | null {
  return typeof indexedDB === 'undefined' ? null : indexedDB;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  const factory = idb();
  if (!factory) return Promise.reject(new Error('IndexedDB unavailable'));
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
      if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

async function run<T>(store: string, mode: IDBTransactionMode, action: (objects: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = action(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error('IndexedDB request failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export async function loadStoredFolderHandle<T>(): Promise<T | null> {
  if (!idb()) return null;
  try {
    return (await run<T | undefined>(HANDLE_STORE, 'readonly', objects => objects.get(HANDLE_KEY) as IDBRequest<T | undefined>)) ?? null;
  } catch {
    return null;
  }
}

export async function saveStoredFolderHandle(handle: unknown): Promise<void> {
  if (!idb()) return;
  await run(HANDLE_STORE, 'readwrite', objects => objects.put(handle, HANDLE_KEY));
}

export async function clearStoredFolderHandle(): Promise<void> {
  if (!idb()) return;
  await run(HANDLE_STORE, 'readwrite', objects => objects.delete(HANDLE_KEY));
}

export function indexedDbFontFolderCache(): FontFolderCache {
  return {
    async load(key) {
      if (!idb()) return null;
      try {
        return (await run<FontFolderCacheData | undefined>(CACHE_STORE, 'readonly', objects => objects.get(key) as IDBRequest<FontFolderCacheData | undefined>)) ?? null;
      } catch {
        return null;
      }
    },
    async save(key, data) {
      if (!idb()) return;
      try {
        await run(CACHE_STORE, 'readwrite', objects => objects.put(data, key));
      } catch {
        // 캐시 저장 실패는 다음 연결을 느리게 할 뿐이다.
      }
    },
    async clear() {
      if (!idb()) return;
      try {
        await run(CACHE_STORE, 'readwrite', objects => objects.clear());
      } catch {
        // 무시
      }
    },
  };
}
