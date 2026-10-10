/**
 * 문서 이력 — IndexedDB + 메모리 폴백.
 * - 신규: IR 스냅샷 JSON(`CompareDocumentSnapshot`)으로 stable_id 보존.
 * - 레거시: HWP 바이트만 있던 항목은 비교 시 `compareDocuments`(alignment)로 폴백.
 * - 메모리 폴백은 IndexedDB 를 못 연 세션에서만 쓴다. JSON 문자열로 두고 열 때 파싱한다.
 */

import type { CompareDocumentSnapshot } from '@/compare/types';
import {
  openIndexedDatabase,
  requestResult,
  transactionDone,
  withDatabase,
} from '../core/idb-open.ts';
import type { DocHistoryEntryMeta } from './types';

const DB_NAME = 'rhwpStudioDocHistory';
const DB_VER = 1;
const META = 'historyMeta';
const BLOBS = 'historyBlobs';
const MAX_SNAPSHOTS = 24;
/** 메모리 폴백 스냅샷의 UTF-8 합계 상한. 가장 최근 스냅샷 하나는 크기와 무관하게 남긴다. */
const MAX_MEMORY_SNAPSHOT_BYTES = 32 * 1024 * 1024;
/** IR 스냅샷 JSON 은 수 MB 가 될 수 있어 일반 IndexedDB 작업보다 넉넉히 기다린다. */
const SNAPSHOT_WRITE_TIMEOUT_MS = 15_000;

type MetaRow = DocHistoryEntryMeta;

type MemEntry = {
  meta: MetaRow;
  snapshotJson: string;
};

const memory = new Map<string, MemEntry>();

export type HistoryPayload =
  | { kind: 'ir'; snapshot: CompareDocumentSnapshot }
  | { kind: 'legacy'; bytes: Uint8Array };

/** 2.0.11 가져오기도 이 함수로 연다. */
export const DOC_HISTORY_DB_NAME = DB_NAME;
export function openDocHistoryDatabase(name = DB_NAME): Promise<IDBDatabase | null> {
  return openDb(name);
}

function openDb(name = DB_NAME): Promise<IDBDatabase | null> {
  return openIndexedDatabase(name, DB_VER, (db) => {
    if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'id' });
  });
}

function withDb<T>(
  fn: (db: IDBDatabase) => Promise<T>,
  fallback: (error?: unknown) => Promise<T>,
  options?: { timeoutMs?: number },
) {
  return withDatabase(() => openDb(), DB_NAME, fn, fallback, options);
}

function getAllMeta(db: IDBDatabase): Promise<MetaRow[]> {
  return requestResult(db.transaction(META, 'readonly').objectStore(META).getAll() as IDBRequest<MetaRow[]>);
}

function deleteEntry(db: IDBDatabase, id: string): Promise<void> {
  const tx = db.transaction([META, BLOBS], 'readwrite');
  tx.objectStore(META).delete(id);
  tx.objectStore(BLOBS).delete(id);
  return transactionDone(tx);
}

async function listMetaMemory(): Promise<MetaRow[]> {
  return [...memory.values()]
    .map((e) => e.meta)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function listHistoryMeta(): Promise<MetaRow[]> {
  return withDb(
    async (db) => {
      // 이번 세션에서 IndexedDB 를 열지 못해 메모리에만 저장한 스냅샷도 함께 보인다.
      const rows = new Map((await getAllMeta(db)).map((row) => [row.id, row]));
      for (const entry of memory.values()) {
        if (!rows.has(entry.meta.id)) rows.set(entry.meta.id, entry.meta);
      }
      return [...rows.values()].sort((a, b) => b.createdAt - a.createdAt);
    },
    listMetaMemory,
  );
}

type BlobRow = { id: string; snapshotJson?: string; data?: ArrayBuffer };

export async function getHistoryPayload(id: string): Promise<HistoryPayload | null> {
  const mem = memory.get(id);
  if (mem) return { kind: 'ir', snapshot: JSON.parse(mem.snapshotJson) as CompareDocumentSnapshot };
  return withDb(
    async (db) => {
      const v = await requestResult(
        db.transaction(BLOBS, 'readonly').objectStore(BLOBS).get(id) as IDBRequest<BlobRow | undefined>,
      );
      if (!v) return null;
      if (typeof v.snapshotJson === 'string' && v.snapshotJson.length > 0) {
        try {
          return { kind: 'ir', snapshot: JSON.parse(v.snapshotJson) as CompareDocumentSnapshot };
        } catch {
          return null;
        }
      }
      if (v.data) return { kind: 'legacy', bytes: new Uint8Array(v.data) };
      return null;
    },
    async () => null,
  );
}

/**
 * 새 스냅샷 기록과 한도 초과분 정리를 한 트랜잭션으로 묶는다.
 * 따로 커밋하면 put 이 할당량 초과 등으로 실패해도 가장 오래된 스냅샷은 이미 지워진다.
 * 한 트랜잭션이면 put 실패가 트랜잭션을 중단시켜 삭제도 함께 되돌아간다.
 */
async function putSnapshotAndPrune(db: IDBDatabase, meta: MetaRow, blob: BlobRow): Promise<void> {
  const tx = db.transaction([META, BLOBS], 'readwrite');
  const done = transactionDone(tx);
  try {
    const metaStore = tx.objectStore(META);
    const blobStore = tx.objectStore(BLOBS);
    metaStore.put(meta);
    blobStore.put(blob);
    const all = metaStore.getAll() as IDBRequest<MetaRow[]>;
    all.onsuccess = () => {
      const older = all.result
        .filter((row) => row.id !== meta.id)
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const row of older.slice(0, Math.max(0, older.length + 1 - MAX_SNAPSHOTS))) {
        metaStore.delete(row.id);
        blobStore.delete(row.id);
      }
    };
  } catch (error) {
    // 요청을 만드는 도중 동기 예외가 나면 앞서 올린 put 만 커밋되지 않도록 되돌린다.
    try {
      tx.abort();
    } catch {
      /* 이미 끝난 트랜잭션 */
    }
    done.catch(() => {});
    throw error;
  }
  await done;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** IR 스냅샷 저장 — 문단 stable_id가 JSON에 포함되어 이력 비교 시 identity 모드에 적합 */
export async function saveHistoryIrSnapshot(
  label: string,
  sourceFileName: string,
  snapshot: CompareDocumentSnapshot,
): Promise<DocHistoryEntryMeta> {
  const id = globalThis.crypto?.randomUUID?.() ?? `h_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const createdAt = Date.now();
  const json = JSON.stringify(snapshot);
  const byteLength = utf8ByteLength(json);
  const meta: MetaRow = {
    id,
    label: label.trim() || `스냅샷 ${new Date(createdAt).toLocaleString('ko-KR')}`,
    createdAt,
    sourceFileName,
    byteLength,
    storageKind: 'ir',
  };

  return withDb(
    async (db) => {
      await putSnapshotAndPrune(db, meta, { id, snapshotJson: json });
      return meta;
    },
    async (error) => {
      // IndexedDB 는 열렸는데 기록이 실패·지연됐다. 메모리에만 두고 성공으로 알리면
      // 목록에도 없고 새로고침하면 사라지므로 실패를 그대로 알린다.
      if (error !== undefined) throw error;
      memory.set(id, { meta, snapshotJson: json });
      pruneMemorySnapshots();
      return meta;
    },
    { timeoutMs: SNAPSHOT_WRITE_TIMEOUT_MS },
  );
}

function pruneMemorySnapshots(): void {
  let totalBytes = 0;
  for (const entry of memory.values()) totalBytes += entry.meta.byteLength;
  // Map 은 삽입 순서를 지키므로 앞쪽이 가장 오래된 스냅샷이다.
  for (const [id, entry] of memory) {
    if (memory.size <= 1 || (memory.size <= MAX_SNAPSHOTS && totalBytes <= MAX_MEMORY_SNAPSHOT_BYTES)) break;
    memory.delete(id);
    totalBytes -= entry.meta.byteLength;
  }
}

export async function deleteHistorySnapshot(id: string): Promise<void> {
  memory.delete(id);
  await withDb((db) => deleteEntry(db, id), async () => {});
}

export async function clearHistory(): Promise<void> {
  memory.clear();
  await withDb(
    async (db) => {
      const tx = db.transaction([META, BLOBS], 'readwrite');
      tx.objectStore(META).clear();
      tx.objectStore(BLOBS).clear();
      await transactionDone(tx);
    },
    async () => {},
  );
}
