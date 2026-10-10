/**
 * 채팅 IndexedDB 의 이름과 스키마. 저장소 모듈(threads.ts)과 2.0.11 가져오기가 함께 쓴다.
 * threads.ts 는 불러오는 순간 캐시를 채우므로, 가져오기는 이 모듈로만 데이터베이스를 연다.
 */
import { openIndexedDatabase } from '../core/idb-open.ts';

export const THREADS_DB_NAME = 'rhwpAgentThreads';
export const THREADS_DB_VERSION = 1;
export const THREADS_STORE = 'threads';

export function openThreadsDatabase(): Promise<IDBDatabase | null> {
  return openIndexedDatabase(THREADS_DB_NAME, THREADS_DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains(THREADS_STORE)) {
      db.createObjectStore(THREADS_STORE, { keyPath: 'id' });
    }
  });
}
