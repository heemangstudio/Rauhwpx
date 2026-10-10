/**
 * 2.0.11 이 이름을 바꿔 남긴 브라우저 저장소를 원래 저장소로 합친다.
 *
 * 2.0.11 은 localStorage 키와 IndexedDB 이름의 접두사를 rhwp 에서 hamaeditor 로 바꿔 기록했다.
 * 원래 이름이 정본이다. 2.0.11 기록은 정본에 이미 있는 기록을 덮지 않는 선에서 더하고, 원본은
 * 지우지 않는다.
 *
 * 웹에서는 같은 출처의 hamaeditor 저장소를 직접 읽는다. 데스크톱 2.0.11 은 다른 프로필과 출처
 * (hamaeditor://app)에 기록했으므로 메인 프로세스가 그 저장소를 조각으로 나눠 넘겨 준다.
 *
 * 옮긴 기록은 저장소별로 장부에 남긴다. 실패한 저장소만 다음에 다시 시도하고, 이미 옮긴 뒤
 * 사용자가 지운 기록은 다시 들어오지 않는다.
 */

import { requestResult, transactionDone } from './idb-open.ts';

export interface RebrandedIndex {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}

export interface RebrandedRecord {
  key: IDBValidKey;
  value: unknown;
}

export interface RebrandedStore {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: RebrandedIndex[];
  records: RebrandedRecord[];
}

export interface RebrandedDatabase {
  name: string;
  version: number;
  stores: RebrandedStore[];
}

export interface RebrandedStorageDump {
  localStorage: Array<[string, string]>;
  databases: RebrandedDatabase[];
}

/** 메인 프로세스가 IPC 한 번에 넘기는 덤프 조각. */
export type RebrandedStorageChunk =
  | { kind: 'localStorage'; entries: Array<[string, string]> }
  | { kind: 'database'; name: string; version: number; stores: Array<Omit<RebrandedStore, 'records'>> }
  | { kind: 'records'; database: string; store: string; records: RebrandedRecord[] };

/** 저장소 단위마다 이미 옮긴 2.0.11 기록의 키. */
export type RebrandImportLedger = Record<string, string[]>;

export interface RebrandImportOptions {
  storage?: Storage | null;
  /** 2.0.11 저장소를 읽을 IndexedDB. 정본은 각 저장소 모듈이 연다. */
  indexedDB?: IDBFactory | null;
  /** 같은 파일을 가리키는 2.0.11 문서 ID → 정본 문서 ID. 데스크톱 북마크 병합이 만든다. */
  documentIdAliases?: Readonly<Record<string, string>>;
  ledger?: RebrandImportLedger;
  signal?: AbortSignal;
}

export interface RebrandImportResult {
  localStorageKeys: number;
  records: number;
  repositories: number;
  /** 넣을 수 없는 개별 기록(복제 불가, 고유 키 충돌, 손상). 다시 시도해도 결과가 같다. */
  skipped: string[];
  /** 저장소를 열거나 쓰지 못했다. 그 저장소는 다음에 다시 시도한다. */
  failures: string[];
  ledger: RebrandImportLedger;
  /** 모든 저장소를 끝까지 처리했다. */
  complete: boolean;
  /** 시간 제한에 걸려 멈췄다. 실패로 세지 않는다. */
  aborted: boolean;
}

/** 웹 경로의 진행 장부. 데스크톱은 메인 프로세스가 같은 장부를 보관한다. */
export const REBRAND_IMPORT_MARKER_KEY = 'rhwp-rebrand-import-v1';
/** 가져오기가 이보다 오래 걸리면 편집기를 먼저 띄운다. 남은 저장소는 다음 실행에서 이어 간다. */
export const REBRAND_IMPORT_TIMEOUT_MS = 30_000;
const MAX_WEB_ATTEMPTS = 5;

const SOURCE_PREFIX = 'hamaeditor';
const TARGET_PREFIX = 'rhwp';
const VERSION_DATABASE = 'rhwpStudioVersionGraph';
const THREADS_DATABASE = 'rhwpAgentThreads';
const LEGACY_THREADS_KEY = 'rhwp-agent-threads';
const LOCAL_STORAGE_UNIT = 'localStorage';
const DOC_ORDER_KEY = 'rhwp-agent-doc-order';
const DOC_ORDER_MAX = 200;
const SYMBOLS_RECENT_KEY = 'rhwp-symbols-recent';
const SYMBOLS_RECENT_MAX = 32;

/** 2.0.11 데이터베이스 이름 → 정본 이름. 이 목록에 없는 데이터베이스는 건드리지 않는다. */
export const REBRANDED_DATABASES: Readonly<Record<string, string>> = Object.freeze({
  hamaeditorAgentThreads: THREADS_DATABASE,
  hamaeditorDocHistory: 'rhwpStudioDocHistory',
  hamaeditorRecent: 'rhwpStudioRecent',
  hamaeditorAutosave: 'rhwpStudioAutosave',
  hamaeditorVersionGraph: VERSION_DATABASE,
  'hamaeditor-font-folder': 'rhwp-font-folder',
});

/** 정본은 그 저장소 모듈의 열기 함수로 연다. 오래된 정본도 이때 올림 처리를 거친다. */
const TARGET_OPENERS: Readonly<Record<string, () => Promise<IDBDatabase | null>>> = {
  [THREADS_DATABASE]: async () => (await import('../agent/threads-db.ts')).openThreadsDatabase(),
  rhwpStudioDocHistory: async () => (await import('../history/idb-store.ts')).openDocHistoryDatabase(),
  rhwpStudioRecent: async () => (await import('../recent/recent-store.ts')).openRecentDatabase(),
  rhwpStudioAutosave: async () => (await import('../recovery/autosave-store.ts')).openAutosaveDatabase(),
  'rhwp-font-folder': async () => (await import('./font-folder-store.ts')).openFontFolderDatabase(),
};

type StorePolicy = 'add' | 'newer' | 'skip';

/** 정본에 같은 키가 있으면 기본은 정본을 둔다. 채팅은 더 최근에 바뀐 쪽을 둔다. */
const STORE_POLICIES: Readonly<Record<string, Readonly<Record<string, StorePolicy>>>> = {
  [THREADS_DATABASE]: { threads: 'newer' },
  // 세션 심장박동은 2.0.11 실행이 살아 있다는 기록일 뿐이다. 옮기지 않아야 그 복구본이 복구 후보가 된다.
  rhwpStudioAutosave: { sessions: 'skip' },
};

/** 탭 사이 알림과 실행 중 상태는 그 실행에서만 뜻이 있다. */
const EPHEMERAL_KEYS = new Set([
  'rhwp-agent-threads-notify',
  'rhwp-agent-chat-status',
  'rhwp-codex-pending-reset',
  REBRAND_IMPORT_MARKER_KEY,
]);

/** 기록 하나만의 문제. 나머지 기록은 계속 옮기고, 이 기록은 다시 시도하지 않는다. */
const RECORD_ERRORS = new Set(['DataCloneError', 'ConstraintError', 'DataError']);

class ImportAborted extends Error {
  constructor() {
    super('가져오기를 멈췄습니다');
    this.name = 'ImportAborted';
  }
}

export function rebrandedTargetKey(sourceKey: string): string {
  return sourceKey.startsWith(SOURCE_PREFIX)
    ? `${TARGET_PREFIX}${sourceKey.slice(SOURCE_PREFIX.length)}`
    : sourceKey;
}

function ledgerKey(key: IDBValidKey): string {
  return JSON.stringify(key);
}

function message(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

function isRecordError(error: unknown): boolean {
  return RECORD_ERRORS.has((error as { name?: string } | null)?.name ?? '');
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function defaultFactory(): IDBFactory | null {
  return typeof indexedDB === 'undefined' ? null : indexedDB;
}

/** 데이터베이스가 없으면 0. 없는 데이터베이스를 빈 채로 만들지 않는다. */
async function databaseVersion(factory: IDBFactory, name: string): Promise<number> {
  if (typeof factory.databases === 'function') {
    try {
      const listed = await factory.databases();
      return listed.find((entry) => entry.name === name)?.version ?? 0;
    } catch {
      // databases()를 못 쓰면 아래처럼 열어서 확인한다.
    }
  }
  return new Promise((resolve, reject) => {
    let created = false;
    const request = factory.open(name);
    request.onupgradeneeded = () => {
      created = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      const version = request.result.version;
      request.result.close();
      resolve(version);
    };
    request.onerror = () => {
      if (created) resolve(0);
      else reject(request.error ?? new Error(`${name} 을 열지 못했습니다`));
    };
  });
}

function openSource(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`${name} 을 열지 못했습니다`));
    request.onblocked = () => reject(new Error(`${name} 이 다른 연결에 막혀 있습니다`));
  });
}

function copyKeyPath(keyPath: string | string[] | null): string | string[] | null {
  return Array.isArray(keyPath) ? [...keyPath] : keyPath;
}

/** 같은 출처의 2.0.11 데이터베이스 하나를 스키마와 기록째 읽는다. */
async function dumpDatabase(factory: IDBFactory, name: string): Promise<RebrandedDatabase> {
  const db = await openSource(factory, name);
  try {
    const stores: RebrandedStore[] = [];
    for (const storeName of Array.from(db.objectStoreNames)) {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const [keys, values] = await Promise.all([
        requestResult(store.getAllKeys()),
        requestResult(store.getAll()),
      ]);
      const indexes: RebrandedIndex[] = Array.from(store.indexNames).map((indexName) => {
        const index = store.index(indexName);
        return {
          name: indexName,
          keyPath: copyKeyPath(index.keyPath as string | string[]) as string | string[],
          unique: index.unique,
          multiEntry: index.multiEntry,
        };
      });
      await transactionDone(tx);
      stores.push({
        name: storeName,
        keyPath: copyKeyPath(store.keyPath as string | string[] | null),
        autoIncrement: store.autoIncrement,
        indexes,
        records: keys.map((key, position) => ({ key, value: values[position] })),
      });
    }
    return { name, version: db.version, stores };
  } finally {
    db.close();
  }
}

/** 이 출처에 남은 2.0.11 저장소를 읽는다. 하나도 없으면 null. */
export async function dumpRebrandedStorage(
  options: Pick<RebrandImportOptions, 'storage' | 'indexedDB'> = {},
): Promise<RebrandedStorageDump | null> {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const factory = options.indexedDB === undefined ? defaultFactory() : options.indexedDB;
  const entries: Array<[string, string]> = [];
  if (storage) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(SOURCE_PREFIX)) continue;
      const value = storage.getItem(key);
      if (value !== null) entries.push([key, value]);
    }
  }
  const databases: RebrandedDatabase[] = [];
  if (factory) {
    for (const name of Object.keys(REBRANDED_DATABASES)) {
      if (await databaseVersion(factory, name) === 0) continue;
      databases.push(await dumpDatabase(factory, name));
    }
  }
  return entries.length || databases.length ? { localStorage: entries, databases } : null;
}

/** 데스크톱이 보낸 조각을 덤프 하나로 다시 모은다. */
export function assembleRebrandedChunks(chunks: readonly RebrandedStorageChunk[]): RebrandedStorageDump {
  const dump: RebrandedStorageDump = { localStorage: [], databases: [] };
  const stores = new Map<string, RebrandedStore>();
  for (const chunk of chunks) {
    if (chunk?.kind === 'localStorage') {
      dump.localStorage.push(...chunk.entries);
    } else if (chunk?.kind === 'database') {
      const database: RebrandedDatabase = {
        name: chunk.name,
        version: chunk.version,
        stores: chunk.stores.map((store) => ({ ...store, records: [] })),
      };
      for (const store of database.stores) stores.set(`${chunk.name}\u0000${store.name}`, store);
      dump.databases.push(database);
    } else if (chunk?.kind === 'records') {
      const store = stores.get(`${chunk.database}\u0000${chunk.store}`);
      if (!store) throw new Error(`${chunk.database}/${chunk.store} 조각의 스키마가 없습니다`);
      store.records.push(...chunk.records);
    }
  }
  return dump;
}

function aliasDocumentId(value: unknown, aliases: Readonly<Record<string, string>>): unknown {
  if (!value || typeof value !== 'object') return value;
  const documentId = (value as { documentId?: unknown }).documentId;
  if (typeof documentId !== 'string' || !Object.hasOwn(aliases, documentId)) return value;
  return { ...(value as object), documentId: aliases[documentId] };
}

function updatedAtOf(value: unknown): number {
  const updatedAt = (value as { updatedAt?: unknown } | null)?.updatedAt;
  return typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : -Infinity;
}

interface WriteOutcome {
  written: number;
  skipped: string[];
  /** 썼거나, 정본을 두었거나, 넣을 수 없어 건너뛴 기록. 다시 시도하지 않는다. */
  handled: string[];
}

/**
 * 한 트랜잭션 안에서 기록마다 정본을 확인하고 쓴다. 트랜잭션 밖 await 이 없어야 커밋되지 않는다.
 * 기록 하나만의 오류는 그 기록만 건너뛰고, 그 밖의 오류는 트랜잭션을 되돌린다.
 */
function writeRecords(
  store: IDBObjectStore,
  records: readonly RebrandedRecord[],
  policy: StorePolicy,
  inlineKeys: boolean,
): Promise<WriteOutcome> {
  return new Promise((resolve, reject) => {
    const outcome: WriteOutcome = { written: 0, skipped: [], handled: [] };
    let pending = records.length;
    if (pending === 0) {
      resolve(outcome);
      return;
    }
    const settle = (id: string) => {
      outcome.handled.push(id);
      pending -= 1;
      if (pending === 0) resolve(outcome);
    };
    const skip = (id: string, error: unknown) => {
      outcome.skipped.push(`${id}: ${(error as { name?: string })?.name ?? message(error)}`);
      settle(id);
    };
    for (const record of records) {
      const id = ledgerKey(record.key);
      let existing: IDBRequest;
      try {
        existing = store.get(record.key);
      } catch (error) {
        if (isRecordError(error)) skip(id, error);
        else reject(error);
        continue;
      }
      existing.onerror = () => reject(existing.error);
      existing.onsuccess = () => {
        const current = existing.result;
        const replace = current === undefined
          || (policy === 'newer' && updatedAtOf(current) < updatedAtOf(record.value));
        if (!replace) {
          settle(id);
          return;
        }
        let put: IDBRequest;
        try {
          put = inlineKeys ? store.put(record.value) : store.put(record.value, record.key);
        } catch (error) {
          if (isRecordError(error)) skip(id, error);
          else reject(error);
          return;
        }
        put.onerror = (event) => {
          if (!isRecordError(put.error)) {
            reject(put.error);
            return;
          }
          // 이 기록만 버리고 트랜잭션은 이어 간다.
          event.preventDefault();
          event.stopPropagation();
          skip(id, put.error);
        };
        put.onsuccess = () => {
          outcome.written += 1;
          settle(id);
        };
      };
    }
  });
}

interface ImportContext {
  aliases: Readonly<Record<string, string>>;
  ledger: RebrandImportLedger;
  signal?: AbortSignal;
  result: RebrandImportResult;
}

function checkAborted(context: ImportContext) {
  if (context.signal?.aborted) throw new ImportAborted();
}

async function mergeDatabase(
  source: RebrandedDatabase,
  targetName: string,
  extraThreads: readonly RebrandedRecord[],
  context: ImportContext,
): Promise<void> {
  const { ledger, result, aliases } = context;
  const policies = STORE_POLICIES[targetName] ?? {};
  const units = source.stores
    .map((store) => {
      const unit = `${targetName}/${store.name}`;
      const done = new Set(ledger[unit] ?? []);
      const all = targetName === THREADS_DATABASE && store.name === 'threads'
        ? [...store.records, ...extraThreads]
        : store.records;
      return { store, unit, done, records: all.filter((record) => !done.has(ledgerKey(record.key))) };
    })
    .filter(({ store, records }) => (policies[store.name] ?? 'add') !== 'skip' && records.length > 0);
  if (units.length === 0) return;

  const opener = TARGET_OPENERS[targetName];
  let db: IDBDatabase | null;
  try {
    db = opener ? await opener() : null;
  } catch (error) {
    throw new Error(`${targetName} 을 열지 못했습니다: ${message(error)}`);
  }
  if (!db) throw new Error(`${targetName} 을 열지 못했습니다`);
  try {
    if (db.version !== source.version) {
      throw new Error(`${targetName} 버전 ${db.version} 과 2.0.11 버전 ${source.version} 이 다릅니다`);
    }
    for (const { store, unit, done, records } of units) {
      checkAborted(context);
      try {
        if (!db.objectStoreNames.contains(store.name)) throw new Error('정본에 이 저장소가 없습니다');
        const tx = db.transaction(store.name, 'readwrite');
        const committed = transactionDone(tx);
        committed.catch(() => {});
        const objectStore = tx.objectStore(store.name);
        const remapped = records.map((record) => ({
          key: record.key,
          value: aliasDocumentId(record.value, aliases),
        }));
        let outcome: WriteOutcome;
        try {
          outcome = await writeRecords(objectStore, remapped, policies[store.name] ?? 'add', objectStore.keyPath !== null);
        } catch (error) {
          try {
            tx.abort();
          } catch {
            /* 이미 끝난 트랜잭션 */
          }
          throw error;
        }
        await committed;
        result.records += outcome.written;
        result.skipped.push(...outcome.skipped.map((entry) => `${unit}: ${entry}`));
        ledger[unit] = [...done, ...outcome.handled];
      } catch (error) {
        result.failures.push(`${unit}: ${message(error)}`);
      }
    }
  } finally {
    db.close();
  }
}

/** 저장소 문제(용량, 열기 실패)인지, 그 버전 기록 하나의 문제인지 가른다. */
function isVersionStorageFailure(error: unknown): boolean {
  const versionError = error as { name?: string; code?: string; cause?: unknown };
  if (versionError?.name !== 'VersionError') return true;
  if (versionError.code === 'STORAGE_QUOTA') return true;
  return versionError.code === 'VERSION_STORE_FAILED' && versionError.cause !== undefined;
}

async function mergeVersionGraph(source: RebrandedDatabase, context: ImportContext): Promise<void> {
  const { ledger, result, aliases } = context;
  const unit = `${VERSION_DATABASE}/repositories`;
  const done = new Set(ledger[unit] ?? []);
  const [{ VersionGraphStore, repositorySnapshotsFromRows }, { documentId }] = await Promise.all([
    import('../versioning/store.ts'),
    import('../versioning/types.ts'),
  ]);
  const rows: Record<string, unknown[]> = {};
  for (const store of source.stores) rows[store.name] = store.records.map((record) => record.value);
  const { snapshots, skipped } = await repositorySnapshotsFromRows(rows);
  for (const id of skipped) {
    if (done.has(id)) continue;
    result.skipped.push(`${unit}: 저장소 ${id} 의 기록이 불완전합니다`);
    done.add(id);
  }
  const pending = snapshots.filter((snapshot) => !done.has(String(snapshot.repository.id)));
  if (pending.length === 0) {
    ledger[unit] = [...done];
    return;
  }
  const target = new VersionGraphStore();
  try {
    try {
      // 정본 버전 데이터베이스를 그 모듈의 올림 처리로 연다. 열 수 없으면 이 단위 전체가 실패다.
      await target.findRepositoryByDocumentId(documentId('rebrand-import-probe'));
    } catch (error) {
      result.failures.push(`${unit}: ${message(error)}`);
      return;
    }
    for (const snapshot of pending) {
      checkAborted(context);
      const id = String(snapshot.repository.id);
      try {
        // 앞선 실행에서 이미 옮겼다. 그 뒤로 사용자가 이어서 바꿨을 수 있으니 다시 쓰지 않는다.
        if (await target.getRepository(snapshot.repository.id)) {
          done.add(id);
          continue;
        }
        const original = snapshot.repository.documentId;
        const alias = Object.hasOwn(aliases, original) ? documentId(aliases[original]) : null;
        // 같은 파일의 정본 기록이 없을 때만 정본 문서 ID 로 잇는다. 있으면 2.0.11 문서 ID 로 따로 둔다.
        const candidates = alias && !(await target.findRepositoryByDocumentId(alias)) ? [alias, original] : [original];
        let settled = false;
        for (const candidate of candidates) {
          try {
            const outcome = await target.importRepositorySnapshot({
              ...snapshot,
              repository: { ...snapshot.repository, documentId: candidate },
            });
            if (outcome.imported) result.repositories += 1;
            settled = true;
            break;
          } catch (error) {
            if ((error as { code?: string })?.code !== 'REPOSITORY_EXISTS') throw error;
          }
        }
        if (!settled) result.skipped.push(`${unit}: 저장소 ${id} 의 문서에 정본 기록이 따로 있습니다`);
        done.add(id);
      } catch (error) {
        if (error instanceof ImportAborted || isVersionStorageFailure(error)) {
          result.failures.push(`${unit}: 저장소 ${id}: ${message(error)}`);
          if (error instanceof ImportAborted) throw error;
          continue;
        }
        result.skipped.push(`${unit}: 저장소 ${id}: ${message(error)}`);
        done.add(id);
      }
    }
  } finally {
    ledger[unit] = [...done];
    await target.close();
  }
}

function parseStringList(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : null;
  } catch {
    return null;
  }
}

function unionList(current: string | null, incoming: string, max: number, map = (value: string) => value): string | null {
  const additions = parseStringList(incoming)?.map(map);
  if (!additions) return null;
  const base = parseStringList(current) ?? [];
  const merged = [...base, ...additions.filter((item) => !base.includes(item))];
  return JSON.stringify(merged.slice(0, max));
}

function legacyThreadRecords(raw: string): RebrandedRecord[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((thread): thread is { id: string } => (
        Boolean(thread) && typeof thread === 'object' && typeof (thread as { id?: unknown }).id === 'string'
      ))
      .map((thread) => ({ key: thread.id, value: thread }));
  } catch {
    return [];
  }
}

function mergeLocalStorage(storage: Storage, entries: ReadonlyArray<[string, string]>, context: ImportContext): void {
  const { ledger, result, aliases } = context;
  const done = new Set(ledger[LOCAL_STORAGE_UNIT] ?? []);
  for (const [sourceKey, value] of entries) {
    if (done.has(sourceKey)) continue;
    const key = rebrandedTargetKey(sourceKey);
    if (EPHEMERAL_KEYS.has(key) || key === LEGACY_THREADS_KEY || key.startsWith('sidebar-preview')) {
      done.add(sourceKey);
      continue;
    }
    try {
      const current = storage.getItem(key);
      let next: string | null = null;
      if (key === DOC_ORDER_KEY) {
        next = unionList(current, value, DOC_ORDER_MAX, (entry) => (
          entry.startsWith('id:') && Object.hasOwn(aliases, entry.slice(3))
            ? `id:${aliases[entry.slice(3)]}`
            : entry
        ));
      } else if (key === SYMBOLS_RECENT_KEY) {
        next = unionList(current, value, SYMBOLS_RECENT_MAX);
      } else if (current === null) {
        next = value;
      }
      if (next !== null && next !== current) {
        storage.setItem(key, next);
        result.localStorageKeys += 1;
      }
      done.add(sourceKey);
    } catch (error) {
      result.failures.push(`${LOCAL_STORAGE_UNIT} ${key}: ${message(error)}`);
    }
  }
  ledger[LOCAL_STORAGE_UNIT] = [...done];
}

/** 덤프를 정본 저장소에 합친다. 장부에 있는 기록은 건너뛰고, 새로 처리한 기록을 장부에 더한다. */
export async function importRebrandedStorage(
  dump: RebrandedStorageDump,
  options: RebrandImportOptions = {},
): Promise<RebrandImportResult> {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const ledger: RebrandImportLedger = {};
  for (const [unit, keys] of Object.entries(options.ledger ?? {})) {
    if (Array.isArray(keys)) ledger[unit] = keys.filter((key) => typeof key === 'string');
  }
  const result: RebrandImportResult = {
    localStorageKeys: 0,
    records: 0,
    repositories: 0,
    skipped: [],
    failures: [],
    ledger,
    complete: false,
    aborted: false,
  };
  const context: ImportContext = { aliases: options.documentIdAliases ?? {}, ledger, signal: options.signal, result };
  const legacyThreads = dump.localStorage
    .filter(([key]) => rebrandedTargetKey(key) === LEGACY_THREADS_KEY)
    .flatMap(([, value]) => legacyThreadRecords(value));
  const databases = [...dump.databases];
  if (legacyThreads.length && !databases.some((db) => REBRANDED_DATABASES[db.name] === THREADS_DATABASE)) {
    const { THREADS_DB_VERSION } = await import('../agent/threads-db.ts');
    databases.push({
      name: 'hamaeditorAgentThreads',
      version: THREADS_DB_VERSION,
      stores: [{ name: 'threads', keyPath: 'id', autoIncrement: false, indexes: [], records: [] }],
    });
  }
  let aborted = false;
  try {
    for (const database of databases) {
      checkAborted(context);
      const targetName = REBRANDED_DATABASES[database.name];
      if (!targetName) continue;
      try {
        if (targetName === VERSION_DATABASE) {
          await mergeVersionGraph(database, context);
        } else {
          await mergeDatabase(database, targetName, targetName === THREADS_DATABASE ? legacyThreads : [], context);
        }
      } catch (error) {
        if (error instanceof ImportAborted) throw error;
        result.failures.push(`${targetName}: ${message(error)}`);
      }
    }
    checkAborted(context);
    if (storage) mergeLocalStorage(storage, dump.localStorage, context);
  } catch (error) {
    if (!(error instanceof ImportAborted)) throw error;
    aborted = true;
    result.failures.push('시간 안에 끝나지 않아 멈췄습니다');
  }
  result.aborted = aborted;
  result.complete = !aborted && result.failures.length === 0;
  return result;
}

interface DesktopRebrandHandoff {
  token: string;
  chunkCount: number;
  documentIdAliases?: Record<string, string>;
  ledger?: RebrandImportLedger;
}

interface DesktopRebrandApi {
  takeRebrandImport?: () => Promise<DesktopRebrandHandoff | null>;
  takeRebrandImportChunk?: (token: string, index: number) => Promise<RebrandedStorageChunk | null>;
  finishRebrandImport?: (
    token: string,
    outcome: { complete: boolean; aborted: boolean; ledger: RebrandImportLedger; failures: string[] },
  ) => Promise<unknown>;
}

interface WebMarker {
  ledger?: RebrandImportLedger;
  complete?: boolean;
  attempts?: number;
}

function readWebMarker(storage: Storage | null): WebMarker {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(REBRAND_IMPORT_MARKER_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as WebMarker : {};
  } catch {
    return {};
  }
}

function withImportLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  if (!locks?.request) return run();
  return locks.request('rhwp-rebrand-import', run) as Promise<T>;
}

async function importFromDesktop(desktop: DesktopRebrandApi, signal: AbortSignal): Promise<void> {
  const handoff = await desktop.takeRebrandImport?.();
  if (!handoff) return;
  let outcome = { complete: false, aborted: false, ledger: handoff.ledger ?? {}, failures: [] as string[] };
  try {
    if (signal.aborted) throw new ImportAborted();
    const chunks: RebrandedStorageChunk[] = [];
    for (let index = 0; index < handoff.chunkCount; index += 1) {
      if (signal.aborted) throw new ImportAborted();
      const chunk = await desktop.takeRebrandImportChunk?.(handoff.token, index);
      if (!chunk) throw new Error(`${index}번째 조각을 받지 못했습니다`);
      chunks.push(chunk);
    }
    const result = await importRebrandedStorage(assembleRebrandedChunks(chunks), {
      documentIdAliases: handoff.documentIdAliases ?? {},
      ledger: handoff.ledger ?? {},
      signal,
    });
    outcome = { complete: result.complete, aborted: result.aborted, ledger: result.ledger, failures: result.failures };
    logResult('2.0.11 데스크톱 프로필', result);
  } catch (error) {
    outcome.failures = [message(error)];
    outcome.aborted = error instanceof ImportAborted;
  } finally {
    await desktop.finishRebrandImport?.(handoff.token, outcome);
  }
}

async function importFromThisOrigin(signal: AbortSignal): Promise<void> {
  const storage = defaultStorage();
  const marker = readWebMarker(storage);
  if (marker.complete || (marker.attempts ?? 0) >= MAX_WEB_ATTEMPTS) return;
  const dump = await dumpRebrandedStorage();
  if (!dump) return;
  const result = await importRebrandedStorage(dump, { ledger: marker.ledger ?? {}, signal });
  logResult('2.0.11 저장소', result);
  storage?.setItem(REBRAND_IMPORT_MARKER_KEY, JSON.stringify({
    ledger: result.ledger,
    complete: result.complete,
    attempts: nextAttempts(marker, result),
    importedAt: Date.now(),
  } satisfies WebMarker & { importedAt: number }));
}

function ledgerSize(ledger: RebrandImportLedger | undefined): number {
  return Object.values(ledger ?? {}).reduce((total, keys) => total + (Array.isArray(keys) ? keys.length : 0), 0);
}

/** 무언가 실패했는데 장부가 그대로일 때만 한 번으로 센다. 시간 제한으로 멈춘 것은 세지 않는다. */
function nextAttempts(marker: WebMarker, result: RebrandImportResult): number {
  if (result.complete || ledgerSize(result.ledger) > ledgerSize(marker.ledger)) return 0;
  return (marker.attempts ?? 0) + (result.aborted ? 0 : 1);
}

/**
 * Studio 를 띄우기 전에 부른다. 데스크톱이 넘긴 2.0.11 프로필 덤프와 이 출처에 남은 2.0.11
 * 저장소를 정본에 합친다. 실패하거나 `timeoutMs` 를 넘기면 편집기를 먼저 띄우고, 남은 저장소는
 * 다음 실행에서 이어 간다.
 */
export async function runRebrandedStorageImport({ timeoutMs = REBRAND_IMPORT_TIMEOUT_MS } = {}): Promise<void> {
  const controller = new AbortController();
  const work = withImportLock(async () => {
    const desktop = (globalThis as { rhwpDesktop?: DesktopRebrandApi }).rhwpDesktop;
    if (desktop?.takeRebrandImport) await importFromDesktop(desktop, controller.signal);
    if (!controller.signal.aborted) await importFromThisOrigin(controller.signal);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const finished = work.then(() => 'done' as const, (error) => {
    console.warn('[rebrand] 2.0.11 저장소를 옮기지 못했습니다:', error);
    return 'done' as const;
  });
  try {
    if (await Promise.race([finished, timedOut]) === 'timeout') {
      controller.abort();
      console.warn('[rebrand] 2.0.11 저장소 가져오기가 길어져 편집기를 먼저 띄웁니다. 남은 부분은 다음 실행에서 이어 갑니다.');
    }
  } finally {
    clearTimeout(timer);
  }
}

function logResult(label: string, result: RebrandImportResult): void {
  if (result.failures.length) console.warn(`[rebrand] ${label} 일부를 옮기지 못했습니다:`, result.failures);
  if (result.skipped.length) console.info(`[rebrand] ${label} 에서 옮기지 않은 기록:`, result.skipped);
  console.info(`[rebrand] ${label}: 기록 ${result.records}개, 버전 저장소 ${result.repositories}개, 설정 ${result.localStorageKeys}개를 옮겼습니다`);
}
