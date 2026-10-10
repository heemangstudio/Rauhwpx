/**
 * 2.0.11 이 이름을 바꿔 남긴 브라우저 저장소를 원래 저장소로 합친다.
 *
 * 2.0.11 은 localStorage 키와 IndexedDB 이름의 접두사를 rhwp 에서 hamaeditor 로 바꿔 기록했다.
 * 원래 이름이 정본이다. 2.0.11 기록은 정본에 이미 있는 기록을 덮지 않는 선에서 더하고, 원본은
 * 지우지 않는다.
 *
 * 웹에서는 같은 출처의 hamaeditor 저장소를 직접 읽는다. 데스크톱 2.0.11 은 다른 프로필과 출처
 * (hamaeditor://app)에 기록했으므로 메인 프로세스가 그 저장소를 덤프해 넘겨 준다. 두 경로 모두
 * 같은 덤프 형식을 쓴다.
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

export interface RebrandImportOptions {
  storage?: Storage | null;
  indexedDB?: IDBFactory | null;
  /** 같은 파일을 가리키는 2.0.11 문서 ID → 정본 문서 ID. 데스크톱 북마크 병합이 만든다. */
  documentIdAliases?: Readonly<Record<string, string>>;
}

export interface RebrandImportResult {
  localStorageKeys: number;
  records: number;
  repositories: number;
  /** 정본과 겹치거나 손상돼 옮기지 않은 항목. 다시 시도해도 결과가 같다. */
  skipped: string[];
  /** 저장소를 열거나 쓰지 못한 항목. 다음 실행에서 다시 시도한다. */
  failures: string[];
}

/** 덤프를 정본에 한 번 합친 뒤 남기는 표시. 웹 경로만 쓴다. 데스크톱은 메인 프로세스가 기록한다. */
export const REBRAND_IMPORT_MARKER_KEY = 'rhwp-rebrand-import-v1';

const SOURCE_PREFIX = 'hamaeditor';
const TARGET_PREFIX = 'rhwp';
const VERSION_DATABASE = 'rhwpStudioVersionGraph';
const THREADS_DATABASE = 'rhwpAgentThreads';
const LEGACY_THREADS_KEY = 'rhwp-agent-threads';
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

export function rebrandedTargetKey(sourceKey: string): string {
  return sourceKey.startsWith(SOURCE_PREFIX)
    ? `${TARGET_PREFIX}${sourceKey.slice(SOURCE_PREFIX.length)}`
    : sourceKey;
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

function openDatabase(
  factory: IDBFactory,
  name: string,
  version?: number,
  upgrade?: (db: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? factory.open(name) : factory.open(name, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`${name} 을 열지 못했습니다`));
    request.onblocked = () => reject(new Error(`${name} 이 다른 연결에 막혀 있습니다`));
  });
}

function keyPathOf(store: IDBObjectStore): string | string[] | null {
  const keyPath = store.keyPath as string | string[] | null;
  return Array.isArray(keyPath) ? [...keyPath] : keyPath;
}

/** 같은 출처의 2.0.11 데이터베이스 하나를 스키마와 레코드째 읽는다. */
async function dumpDatabase(factory: IDBFactory, name: string): Promise<RebrandedDatabase> {
  const db = await openDatabase(factory, name);
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
        const indexKeyPath = index.keyPath as string | string[];
        return {
          name: indexName,
          keyPath: Array.isArray(indexKeyPath) ? [...indexKeyPath] : indexKeyPath,
          unique: index.unique,
          multiEntry: index.multiEntry,
        };
      });
      await transactionDone(tx);
      stores.push({
        name: storeName,
        keyPath: keyPathOf(store),
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

/** 한 트랜잭션 안에서 레코드마다 정본을 확인하고 쓴다. 트랜잭션 밖 await 이 없어야 커밋되지 않는다. */
function writeRecords(
  store: IDBObjectStore,
  records: readonly RebrandedRecord[],
  policy: StorePolicy,
  inlineKeys: boolean,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let written = 0;
    let pending = records.length;
    if (pending === 0) {
      resolve(0);
      return;
    }
    const settle = () => {
      pending -= 1;
      if (pending === 0) resolve(written);
    };
    for (const record of records) {
      const existing = store.get(record.key);
      existing.onerror = () => reject(existing.error);
      existing.onsuccess = () => {
        const current = existing.result;
        const replace = current === undefined
          || (policy === 'newer' && updatedAtOf(current) < updatedAtOf(record.value));
        if (!replace) {
          settle();
          return;
        }
        const put = inlineKeys ? store.put(record.value) : store.put(record.value, record.key);
        put.onerror = () => reject(put.error);
        put.onsuccess = () => {
          written += 1;
          settle();
        };
      };
    }
  });
}

async function mergeDatabase(
  factory: IDBFactory,
  source: RebrandedDatabase,
  targetName: string,
  aliases: Readonly<Record<string, string>>,
  extraThreads: readonly RebrandedRecord[],
  result: RebrandImportResult,
): Promise<void> {
  const existingVersion = await databaseVersion(factory, targetName);
  if (existingVersion !== 0 && existingVersion !== source.version) {
    result.skipped.push(`${targetName}: 버전 ${existingVersion} 과 2.0.11 버전 ${source.version} 이 다릅니다`);
    return;
  }
  // 정본이 없으면 2.0.11 과 같은 코드가 만든 스키마를 그대로 만든다. 있으면 스키마는 그대로 둔다.
  const db = await openDatabase(factory, targetName, source.version, (created) => {
    for (const store of source.stores) {
      if (created.objectStoreNames.contains(store.name)) continue;
      const objectStore = created.createObjectStore(store.name, {
        ...(store.keyPath === null ? {} : { keyPath: store.keyPath }),
        autoIncrement: store.autoIncrement,
      });
      for (const index of store.indexes) {
        objectStore.createIndex(index.name, index.keyPath, {
          unique: index.unique,
          multiEntry: index.multiEntry,
        });
      }
    }
  });
  try {
    const policies = STORE_POLICIES[targetName] ?? {};
    for (const store of source.stores) {
      const policy = policies[store.name] ?? 'add';
      if (policy === 'skip' || !db.objectStoreNames.contains(store.name)) continue;
      const records = targetName === THREADS_DATABASE && store.name === 'threads'
        ? [...store.records, ...extraThreads]
        : store.records;
      const remapped = records.map((record) => ({
        key: record.key,
        value: aliasDocumentId(record.value, aliases),
      }));
      const tx = db.transaction(store.name, 'readwrite');
      const objectStore = tx.objectStore(store.name);
      const written = writeRecords(objectStore, remapped, policy, objectStore.keyPath !== null);
      try {
        result.records += await written;
        await transactionDone(tx);
      } catch (error) {
        // 넣을 수 없는 값(다른 출처의 파일 핸들 등)이 있으면 그 저장소만 건너뛴다.
        try {
          tx.abort();
        } catch {
          /* 이미 끝난 트랜잭션 */
        }
        result.skipped.push(`${targetName}/${store.name}: ${String((error as Error)?.message ?? error)}`);
      }
    }
  } finally {
    db.close();
  }
}

async function mergeVersionGraph(
  factory: IDBFactory,
  source: RebrandedDatabase,
  aliases: Readonly<Record<string, string>>,
  result: RebrandImportResult,
): Promise<void> {
  const [{ VersionGraphStore, repositorySnapshotsFromRows }, { documentId }] = await Promise.all([
    import('../versioning/store.ts'),
    import('../versioning/types.ts'),
  ]);
  const rows: Record<string, unknown[]> = {};
  for (const store of source.stores) rows[store.name] = store.records.map((record) => record.value);
  const { snapshots, skipped } = await repositorySnapshotsFromRows(rows);
  for (const id of skipped) result.skipped.push(`${VERSION_DATABASE}: 저장소 ${id} 의 기록이 불완전합니다`);
  const target = new VersionGraphStore({ indexedDB: factory });
  try {
    for (const snapshot of snapshots) {
      // 앞선 실행에서 이미 옮겼다. 그 뒤로 사용자가 이어서 바꿨을 수 있으니 다시 쓰지 않는다.
      if (await target.getRepository(snapshot.repository.id)) continue;
      const original = snapshot.repository.documentId;
      const alias = Object.hasOwn(aliases, original) ? documentId(aliases[original]) : null;
      // 같은 파일의 정본 기록이 없을 때만 정본 문서 ID 로 잇는다. 있으면 2.0.11 문서 ID 로 따로 둔다.
      const candidates = alias && !(await target.findRepositoryByDocumentId(alias))
        ? [alias, original]
        : [original];
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
          if ((error as { code?: string })?.code === 'REPOSITORY_EXISTS') continue;
          result.skipped.push(`${VERSION_DATABASE}: 저장소 ${snapshot.repository.id}: ${String((error as Error)?.message ?? error)}`);
          settled = true;
          break;
        }
      }
      if (!settled) {
        result.skipped.push(`${VERSION_DATABASE}: 저장소 ${snapshot.repository.id} 의 문서에 정본 기록이 따로 있습니다`);
      }
    }
  } finally {
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

function mergeLocalStorage(
  storage: Storage,
  entries: ReadonlyArray<[string, string]>,
  aliases: Readonly<Record<string, string>>,
  result: RebrandImportResult,
): void {
  for (const [sourceKey, value] of entries) {
    const key = rebrandedTargetKey(sourceKey);
    if (EPHEMERAL_KEYS.has(key) || key === LEGACY_THREADS_KEY || key.startsWith('sidebar-preview')) continue;
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
    } catch (error) {
      result.failures.push(`localStorage ${key}: ${String((error as Error)?.message ?? error)}`);
    }
  }
}

/** 덤프를 정본 저장소에 합친다. 같은 덤프를 다시 넣어도 결과가 같다. */
export async function importRebrandedStorage(
  dump: RebrandedStorageDump,
  options: RebrandImportOptions = {},
): Promise<RebrandImportResult> {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const factory = options.indexedDB === undefined ? defaultFactory() : options.indexedDB;
  const aliases = options.documentIdAliases ?? {};
  const result: RebrandImportResult = {
    localStorageKeys: 0,
    records: 0,
    repositories: 0,
    skipped: [],
    failures: [],
  };
  const legacyThreads = dump.localStorage
    .filter(([key]) => rebrandedTargetKey(key) === LEGACY_THREADS_KEY)
    .flatMap(([, value]) => legacyThreadRecords(value));

  if (factory) {
    const databases = [...dump.databases];
    if (legacyThreads.length && !databases.some((db) => REBRANDED_DATABASES[db.name] === THREADS_DATABASE)) {
      databases.push({
        name: 'hamaeditorAgentThreads',
        version: 1,
        stores: [{ name: 'threads', keyPath: 'id', autoIncrement: false, indexes: [], records: [] }],
      });
    }
    for (const database of databases) {
      const targetName = REBRANDED_DATABASES[database.name];
      if (!targetName) continue;
      try {
        if (targetName === VERSION_DATABASE) {
          await mergeVersionGraph(factory, database, aliases, result);
        } else {
          await mergeDatabase(
            factory,
            database,
            targetName,
            aliases,
            targetName === THREADS_DATABASE ? legacyThreads : [],
            result,
          );
        }
      } catch (error) {
        result.failures.push(`${targetName}: ${String((error as Error)?.message ?? error)}`);
      }
    }
  }
  if (storage) mergeLocalStorage(storage, dump.localStorage, aliases, result);
  return result;
}

interface DesktopRebrandImport {
  token: string;
  dump: RebrandedStorageDump;
  documentIdAliases?: Record<string, string>;
}

interface DesktopRebrandApi {
  takeRebrandImport?: () => Promise<DesktopRebrandImport | null>;
  finishRebrandImport?: (token: string, outcome: { ok: boolean; result: RebrandImportResult }) => Promise<unknown>;
}

function withImportLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  if (!locks?.request) return run();
  return locks.request('rhwp-rebrand-import', run) as Promise<T>;
}

/**
 * Studio 를 띄우기 전에 부른다. 데스크톱이 넘긴 2.0.11 프로필 덤프와 이 출처에 남은 2.0.11
 * 저장소를 정본에 합친다. 실패해도 Studio 는 뜨고, 표시를 남기지 않았으니 다음 실행에서 다시 시도한다.
 */
export async function runRebrandedStorageImport(): Promise<void> {
  await withImportLock(async () => {
    const desktop = (globalThis as { rhwpDesktop?: DesktopRebrandApi }).rhwpDesktop;
    if (desktop?.takeRebrandImport) {
      const pending = await desktop.takeRebrandImport();
      if (pending) {
        const result = await importRebrandedStorage(pending.dump, {
          documentIdAliases: pending.documentIdAliases ?? {},
        });
        await desktop.finishRebrandImport?.(pending.token, { ok: result.failures.length === 0, result });
        logResult('2.0.11 데스크톱 프로필', result);
      }
    }
    const storage = defaultStorage();
    if (storage?.getItem(REBRAND_IMPORT_MARKER_KEY)) return;
    const dump = await dumpRebrandedStorage();
    if (!dump) return;
    const result = await importRebrandedStorage(dump);
    logResult('2.0.11 저장소', result);
    if (result.failures.length === 0) {
      storage?.setItem(REBRAND_IMPORT_MARKER_KEY, JSON.stringify({ importedAt: Date.now() }));
    }
  });
}

function logResult(label: string, result: RebrandImportResult): void {
  if (result.failures.length) console.warn(`[rebrand] ${label} 일부를 옮기지 못했습니다:`, result.failures);
  if (result.skipped.length) console.info(`[rebrand] ${label} 에서 정본과 겹친 항목:`, result.skipped);
  console.info(`[rebrand] ${label}: 레코드 ${result.records}개, 버전 저장소 ${result.repositories}개, 설정 ${result.localStorageKeys}개를 옮겼습니다`);
}
