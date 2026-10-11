/**
 * 미저장 문서 복구용 자동 백업 저장소.
 *
 * 문서 비교 이력(`rhwpStudioDocHistory`)과 섞지 않기 위해 별도 IndexedDB를 사용한다.
 * IndexedDB 자체가 없는 테스트/제한 환경에서만 메모리 저장소로 폴백한다. IndexedDB 가 있는데
 * 기록이 실패하면 오류를 그대로 알린다. 메모리 사본은 크래시 뒤 복구에 쓸 수 없기 때문이다.
 *
 * 문서 바이트는 `drafts`, 목록과 정리에 쓰는 메타데이터는 `draftMeta` 에 따로 둔다. 목록을
 * 읽거나 오래된 복구본을 정리할 때 모든 복구본의 바이트를 복제하지 않기 위해서다.
 * `draftBases` 에는 draft 마다 그 창이 마지막으로 열거나 저장한 파일 바이트를 하나 둔다. 복구할 때
 * 디스크 파일이 바뀌었는지 판단하고, 바뀌었으면 3-way 병합의 기준으로 쓴다.
 */

import type { FileSystemFileHandleLike } from '../command/file-system-access.ts';
import {
  openIndexedDatabase,
  requestResult,
  transactionDone,
  withDatabase,
  withTimeout,
} from '../core/idb-open.ts';

const DB_NAME = 'rhwpStudioAutosave';
const DB_VER = 4;
const DRAFTS = 'drafts';
const DRAFT_META = 'draftMeta';
const DRAFT_BASES = 'draftBases';
const SESSIONS = 'sessions';
/** 사용자에게 한 번 보여 준 복구본은 이 개수를 넘으면 오래된 것부터 정리한다. */
const MAX_DRAFTS = 12;
/** 아직 보여 주지 않은 복구본까지 포함한 상한. 이를 넘으면 오래된 것부터 정리한다. */
const MAX_DRAFTS_HARD = 32;
export const AUTOSAVE_SESSION_STALE_MS = 20_000;
/** 큰 문서도 기록을 끝낼 수 있게 크기에 비례해 기다린다. */
const DRAFT_WRITE_BASE_TIMEOUT_MS = 10_000;
const DRAFT_WRITE_TIMEOUT_PER_MIB_MS = 250;
const DRAFT_WRITE_MAX_TIMEOUT_MS = 60_000;
const DRAFT_READ_TIMEOUT_MS = 30_000;
const INSTANCE_LOCK_PREFIX = 'rhwp-autosave-owner:';

export interface AutosaveOwner {
  launchId: string;
  sessionId: string;
  /** 페이지 로드마다 새로 만든 id. 새로고침한 페이지는 sessionId 는 같아도 instanceId 가 다르다. */
  instanceId?: string;
}

export type AutosaveDataFormat = 'hwp' | 'hwpx' | 'hml';

/** draft 를 만든 창이 마지막으로 열거나 저장한 파일 바이트의 요약. 바이트는 `draftBases` 에 있다. */
export interface AutosaveDraftBaseSummary {
  digest: string;
  byteLength: number;
  /** false 면 기준 바이트로 병합할 수 없다(.rhwpx 묶음 등). */
  mergeable: boolean;
}

export interface AutosaveDraftBase {
  digest: string;
  byteLength: number;
  data: Uint8Array;
}

export interface AutosaveDraftSummary {
  id: string;
  fileName: string;
  sourceFormat: string;
  savedAt: number;
  byteLength: number;
  /** 논리 문서 ID. 없으면 v3 이전 draft 이다. */
  documentId?: string;
  /** data 의 형식. 없으면 HWP 이다. */
  dataFormat?: AutosaveDataFormat;
  base?: AutosaveDraftBaseSummary;
  /** draft 를 만들 때 문서에 붙어 있던 파일 핸들의 종류. browser 핸들만 drafts 행에 저장한다. */
  handleKind?: 'browser' | 'native-path';
  dirtyReason?: string;
  ownerLaunchId?: string;
  ownerSessionId?: string;
  /** 이 값이 있으면 소유 페이지가 살아 있는 동안 해당 instance lock 이 잡혀 있다. */
  ownerInstanceId?: string;
  ownerHeartbeatAt?: number;
  /** 복구 대화상자나 안내로 사용자에게 보여 준 시각. 보여 주기 전에는 정리하지 않는다. */
  offeredAt?: number;
}

export interface AutosaveDraft extends AutosaveDraftSummary {
  data: Uint8Array;
  /** 원본 파일 핸들. 메타 저장소에는 넣지 않고, 브라우저 핸들만 drafts 행에 저장한다. */
  fileHandle?: FileSystemFileHandleLike;
}

export interface AutosaveSessionHeartbeat extends AutosaveOwner {
  heartbeatAt: number;
}

/** navigator.locks 중 이 저장소가 쓰는 부분. */
export interface AutosaveLockManagerLike {
  request(name: string, callback: () => unknown): Promise<unknown>;
  query(): Promise<{ held?: ReadonlyArray<{ name?: string | null }> }>;
}

export interface RecoverableAutosaveOptions {
  now?: number;
  staleAfterMs?: number;
  /** 생략하면 navigator.locks, null 이면 heartbeat 만으로 판단한다. */
  locks?: AutosaveLockManagerLike | null;
}

export interface SaveAutosaveDraftOptions {
  now?: number;
  locks?: AutosaveLockManagerLike | null;
  /** 기준 바이트가 바뀌었을 때만 넘긴다. 같은 트랜잭션에서 draft 와 함께 기록한다. */
  base?: AutosaveDraftBase;
}

type DraftRow = Omit<AutosaveDraft, 'data'> & { data?: ArrayBuffer };
type DraftBaseRow = Omit<AutosaveDraftBase, 'data'> & { id: string; data: ArrayBuffer };

interface OwnerLiveness {
  now: number;
  staleAfterMs: number;
  sessions: ReadonlyMap<string, AutosaveSessionHeartbeat>;
  heldLocks: ReadonlySet<string> | null;
}

const memory = new Map<string, AutosaveDraft>();
const memoryBases = new Map<string, AutosaveDraftBase>();
const memorySessions = new Map<string, AutosaveSessionHeartbeat>();

export function autosaveInstanceLockName(instanceId: string): string {
  return `${INSTANCE_LOCK_PREFIX}${instanceId}`;
}

export function defaultAutosaveLocks(): AutosaveLockManagerLike | null {
  const locks = (globalThis as { navigator?: { locks?: Partial<AutosaveLockManagerLike> } })
    .navigator?.locks;
  return locks && typeof locks.request === 'function' && typeof locks.query === 'function'
    ? locks as AutosaveLockManagerLike
    : null;
}

function resolveLocks(locks: AutosaveLockManagerLike | null | undefined) {
  return locks === undefined ? defaultAutosaveLocks() : locks;
}

/** IndexedDB 트랜잭션 안에서 기다리면 트랜잭션이 커밋되므로 반드시 먼저 조회한다. */
async function heldOwnerLocks(locks: AutosaveLockManagerLike | null): Promise<ReadonlySet<string> | null> {
  if (!locks) return null;
  try {
    const snapshot = await locks.query();
    return new Set(
      (snapshot.held ?? [])
        .map((lock) => lock.name)
        .filter((name): name is string => typeof name === 'string' && name.startsWith(INSTANCE_LOCK_PREFIX)),
    );
  } catch {
    return null;
  }
}

function cloneBytes(bytes: Uint8Array) {
  return new Uint8Array(bytes);
}

function bytesToArrayBuffer(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

function cloneDraft(draft: AutosaveDraft): AutosaveDraft {
  return { ...draft, data: cloneBytes(draft.data) };
}

/**
 * IndexedDB 에 넣을 수 있는 핸들만 남긴다. Electron native-path 핸들은 복제할 수 없고,
 * 재시작 뒤에는 메인 프로세스 북마크가 documentId 로 파일을 다시 찾는다.
 */
function persistableHandle(handle: FileSystemFileHandleLike | undefined): FileSystemFileHandleLike | undefined {
  if (!handle || handle.identityKind === 'native-path') return undefined;
  const BrowserHandle = (globalThis as { FileSystemFileHandle?: abstract new () => unknown }).FileSystemFileHandle;
  if (BrowserHandle && !(handle instanceof BrowserHandle)) return undefined;
  return handle;
}

function isDataFormat(value: unknown): value is AutosaveDataFormat {
  return value === 'hwp' || value === 'hwpx' || value === 'hml';
}

function summaryOf(draft: AutosaveDraftSummary): AutosaveDraftSummary {
  const summary: AutosaveDraftSummary = {
    id: draft.id,
    fileName: draft.fileName,
    sourceFormat: draft.sourceFormat,
    savedAt: draft.savedAt,
    byteLength: draft.byteLength,
  };
  if (typeof draft.documentId === 'string' && draft.documentId) summary.documentId = draft.documentId;
  if (isDataFormat(draft.dataFormat)) summary.dataFormat = draft.dataFormat;
  if (draft.base && typeof draft.base.digest === 'string') {
    summary.base = {
      digest: draft.base.digest,
      byteLength: draft.base.byteLength,
      mergeable: draft.base.mergeable === true,
    };
  }
  if (draft.handleKind === 'browser' || draft.handleKind === 'native-path') summary.handleKind = draft.handleKind;
  if (draft.dirtyReason !== undefined) summary.dirtyReason = draft.dirtyReason;
  if (draft.ownerLaunchId !== undefined) summary.ownerLaunchId = draft.ownerLaunchId;
  if (draft.ownerSessionId !== undefined) summary.ownerSessionId = draft.ownerSessionId;
  if (draft.ownerInstanceId !== undefined) summary.ownerInstanceId = draft.ownerInstanceId;
  if (draft.ownerHeartbeatAt !== undefined) summary.ownerHeartbeatAt = draft.ownerHeartbeatAt;
  if (draft.offeredAt !== undefined) summary.offeredAt = draft.offeredAt;
  return summary;
}

function summaryOfRow(row: DraftRow): AutosaveDraftSummary {
  return summaryOf({
    ...row,
    byteLength: Number.isFinite(row.byteLength) ? row.byteLength : row.data?.byteLength ?? 0,
  });
}

function rowToDraft(row: DraftRow): AutosaveDraft {
  const { data, ...rest } = row;
  return { ...rest, data: new Uint8Array(data ?? new ArrayBuffer(0)) };
}

function draftToRow(draft: AutosaveDraft): DraftRow {
  return {
    ...summaryOf(draft),
    ...(draft.fileHandle ? { fileHandle: draft.fileHandle } : {}),
    data: bytesToArrayBuffer(draft.data),
  };
}

function bySavedAtDesc(a: { savedAt: number }, b: { savedAt: number }) {
  return b.savedAt - a.savedAt;
}

/** 2.0.11 가져오기도 이 함수로 열어 오래된 버전을 먼저 올린다. */
export const AUTOSAVE_DB_NAME = DB_NAME;
export function openAutosaveDatabase(name = DB_NAME): Promise<IDBDatabase | null> {
  return openDb(name);
}

function openDb(name = DB_NAME) {
  return openIndexedDatabase(name, DB_VER, (db, event) => {
    if (!db.objectStoreNames.contains(DRAFTS)) {
      db.createObjectStore(DRAFTS, { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains(SESSIONS)) {
      db.createObjectStore(SESSIONS, { keyPath: 'sessionId' });
    }
    if (!db.objectStoreNames.contains(DRAFT_BASES)) {
      db.createObjectStore(DRAFT_BASES, { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains(DRAFT_META)) {
      const metaStore = db.createObjectStore(DRAFT_META, { keyPath: 'id' });
      // v2 이하에는 메타 저장소가 없다. 버전 변경 트랜잭션 안에서 기존 행의 메타만 옮긴다.
      const upgrade = (event.target as IDBOpenDBRequest | null)?.transaction;
      const cursor = upgrade?.objectStore(DRAFTS).openCursor();
      if (cursor) {
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (!current) return;
          metaStore.put(summaryOfRow(current.value as DraftRow));
          current.continue();
        };
      }
    }
  });
}

function indexedDbAvailable() {
  return typeof indexedDB !== 'undefined';
}

/** 조회·삭제용. 실패하면 경고 후 폴백한다. */
function withDb<T>(fn: (db: IDBDatabase) => Promise<T>, fallback: () => Promise<T>) {
  return withDatabase(() => openDb(), DB_NAME, fn, fallback);
}

/**
 * 복구본 기록·바이트 조회용. IndexedDB 가 아예 없을 때만 withoutDatabase 를 쓰고,
 * 열기 실패·기록 실패·시간 초과는 호출부에 오류로 알린다.
 */
async function withDraftDatabase<T>(
  operation: (db: IDBDatabase) => Promise<T>,
  withoutDatabase: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const db = await openDb();
  if (!db) {
    if (indexedDbAvailable()) throw new Error('자동 저장 데이터베이스를 열 수 없습니다.');
    return withoutDatabase();
  }
  try {
    return await withTimeout(operation(db), timeoutMs, DB_NAME);
  } finally {
    db.close();
  }
}

function draftWriteTimeoutMs(byteLength: number) {
  const mib = Math.ceil(Math.max(0, byteLength) / (1024 * 1024));
  return Math.min(
    DRAFT_WRITE_MAX_TIMEOUT_MS,
    DRAFT_WRITE_BASE_TIMEOUT_MS + mib * DRAFT_WRITE_TIMEOUT_PER_MIB_MS,
  );
}

function sessionMap(sessions: Iterable<AutosaveSessionHeartbeat>) {
  return new Map([...sessions].map((session) => [session.sessionId, session]));
}

function draftIsActive(draft: AutosaveDraftSummary, liveness: OwnerLiveness) {
  const { now, staleAfterMs } = liveness;
  if (draft.ownerInstanceId && liveness.heldLocks) {
    // 소유 페이지는 살아 있는 동안 instance lock 을 쥐고 있다. 크래시·새로고침·창 닫기로
    // 페이지가 사라지면 브라우저가 lock 을 풀어 주므로, heartbeat 시각과 상관없이 바로
    // 복구할 수 있고, 백그라운드에서 타이머가 늦어진 창은 계속 살아 있는 것으로 본다.
    return liveness.heldLocks.has(autosaveInstanceLockName(draft.ownerInstanceId));
  }
  if (!draft.ownerSessionId) return false;
  const session = liveness.sessions.get(draft.ownerSessionId);
  const sessionFresh = Boolean(session)
    && Number.isFinite(session!.heartbeatAt)
    && session!.heartbeatAt >= now - staleAfterMs;
  // 새로고침한 페이지는 같은 sessionId 를 다시 쓴다. 다른 페이지 인스턴스의 heartbeat 로
  // 죽은 페이지의 draft 를 살아 있는 것으로 보면 그 탭에서는 영영 복구를 제안하지 않는다.
  const sameInstance = !draft.ownerInstanceId
    || !session?.instanceId
    || session.instanceId === draft.ownerInstanceId;
  if (sessionFresh && sameInstance) return true;
  return typeof draft.ownerHeartbeatAt === 'number'
    && draft.ownerHeartbeatAt >= now - staleAfterMs;
}

/**
 * 정리할 draft id. 살아 있는 창의 draft 와 방금 저장한 draft 는 지우지 않는다.
 * 사용자에게 아직 보여 주지 않은 복구본은 MAX_DRAFTS_HARD 를 넘을 때만 지운다.
 */
function trimDraftIds(
  drafts: readonly AutosaveDraftSummary[],
  liveness: OwnerLiveness,
  keepId?: string,
) {
  const idle = drafts
    .filter((draft) => draft.id !== keepId && !draftIsActive(draft, liveness))
    .sort((a, b) => a.savedAt - b.savedAt);
  const remove = new Set<string>();
  let excess = drafts.length - MAX_DRAFTS;
  for (const draft of idle) {
    if (excess <= 0) break;
    if (typeof draft.offeredAt !== 'number') continue;
    remove.add(draft.id);
    excess -= 1;
  }
  let hardExcess = drafts.length - remove.size - MAX_DRAFTS_HARD;
  for (const draft of idle) {
    if (hardExcess <= 0) break;
    if (remove.has(draft.id)) continue;
    remove.add(draft.id);
    hardExcess -= 1;
  }
  return [...remove];
}

export function createAutosaveDraftId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `draft_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function saveAutosaveDraft(
  draft: AutosaveDraft,
  options: SaveAutosaveDraftOptions = {},
): Promise<void> {
  // 새로 저장한 내용은 아직 아무에게도 보여 주지 않았다.
  const { offeredAt: _offeredAt, fileHandle: rawHandle, ...fresh } = draft;
  const fileHandle = persistableHandle(rawHandle);
  const normalized = cloneDraft({
    ...fresh,
    ...(fileHandle ? { fileHandle } : {}),
    byteLength: draft.data.byteLength,
  });
  const base = options.base
    ? { digest: options.base.digest, byteLength: options.base.data.byteLength, data: cloneBytes(options.base.data) }
    : null;
  const now = options.now ?? Date.now();
  const heldLocks = await heldOwnerLocks(resolveLocks(options.locks));

  await withDraftDatabase(
    async (db) => {
      const tx = db.transaction([DRAFTS, DRAFT_META, DRAFT_BASES, SESSIONS], 'readwrite');
      const done = transactionDone(tx);
      try {
        const draftsStore = tx.objectStore(DRAFTS);
        const metaStore = tx.objectStore(DRAFT_META);
        const basesStore = tx.objectStore(DRAFT_BASES);
        draftsStore.put(draftToRow(normalized));
        metaStore.put(summaryOf(normalized));
        if (base) {
          basesStore.put({
            id: normalized.id,
            digest: base.digest,
            byteLength: base.byteLength,
            data: bytesToArrayBuffer(base.data),
          } satisfies DraftBaseRow);
        }
        // 메타만 읽어 정리 대상을 고른다. 바이트는 트랜잭션 안에서 복제하지 않는다.
        const [metas, sessions] = await Promise.all([
          requestResult(metaStore.getAll() as IDBRequest<AutosaveDraftSummary[]>),
          requestResult(tx.objectStore(SESSIONS).getAll() as IDBRequest<AutosaveSessionHeartbeat[]>),
        ]);
        const liveness: OwnerLiveness = {
          now,
          staleAfterMs: AUTOSAVE_SESSION_STALE_MS,
          sessions: sessionMap(sessions),
          heldLocks,
        };
        for (const id of trimDraftIds(metas, liveness, normalized.id)) {
          draftsStore.delete(id);
          metaStore.delete(id);
          basesStore.delete(id);
        }
      } catch (error) {
        // 요청을 만들거나 읽는 도중 실패하면 앞서 올린 put 만 커밋되지 않도록 되돌린다.
        try {
          tx.abort();
        } catch {
          /* 이미 끝난 트랜잭션 */
        }
        done.catch(() => {});
        throw error;
      }
      await done;
      memory.delete(normalized.id);
      memoryBases.delete(normalized.id);
    },
    async () => {
      memory.set(normalized.id, normalized);
      if (base) memoryBases.set(normalized.id, base);
      const liveness: OwnerLiveness = {
        now,
        staleAfterMs: AUTOSAVE_SESSION_STALE_MS,
        sessions: memorySessions,
        heldLocks,
      };
      for (const id of trimDraftIds([...memory.values()], liveness, normalized.id)) {
        memory.delete(id);
        memoryBases.delete(id);
      }
    },
    draftWriteTimeoutMs(normalized.byteLength + (base?.byteLength ?? 0)),
  );
}

/** 복구할 draft 의 문서 바이트까지 읽는다. */
export async function getAutosaveDraft(id: string): Promise<AutosaveDraft | null> {
  const fromMemory = () => {
    const mem = memory.get(id);
    return mem ? cloneDraft(mem) : null;
  };
  return withDraftDatabase(
    async (db) => {
      const tx = db.transaction(DRAFTS, 'readonly');
      const row = await requestResult(tx.objectStore(DRAFTS).get(id) as IDBRequest<DraftRow | undefined>);
      await transactionDone(tx);
      // IndexedDB 행이 항상 우선한다. 메모리에는 DB 없이 저장한 draft 만 남는다.
      return row ? rowToDraft(row) : fromMemory();
    },
    async () => fromMemory(),
    DRAFT_READ_TIMEOUT_MS,
  );
}

/** draft 를 만든 창이 마지막으로 열거나 저장한 파일 바이트. 없으면 null. */
export async function getAutosaveDraftBase(id: string): Promise<AutosaveDraftBase | null> {
  const fromMemory = () => {
    const mem = memoryBases.get(id);
    return mem ? { ...mem, data: cloneBytes(mem.data) } : null;
  };
  return withDraftDatabase(
    async (db) => {
      const tx = db.transaction(DRAFT_BASES, 'readonly');
      const row = await requestResult(tx.objectStore(DRAFT_BASES).get(id) as IDBRequest<DraftBaseRow | undefined>);
      await transactionDone(tx);
      if (!row) return fromMemory();
      return { digest: row.digest, byteLength: row.byteLength, data: new Uint8Array(row.data) };
    },
    async () => fromMemory(),
    DRAFT_READ_TIMEOUT_MS,
  );
}

function mergeMemorySummaries(rows: AutosaveDraftSummary[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const draft of memory.values()) {
    if (!byId.has(draft.id)) byId.set(draft.id, summaryOf(draft));
  }
  return [...byId.values()].sort(bySavedAtDesc);
}

/** 문서 바이트 없이 메타데이터만 돌려준다. 복구할 때 getAutosaveDraft 로 바이트를 읽는다. */
export async function listAutosaveDrafts(): Promise<AutosaveDraftSummary[]> {
  return withDb(
    async (db) => {
      const tx = db.transaction(DRAFT_META, 'readonly');
      const rows = await requestResult(tx.objectStore(DRAFT_META).getAll() as IDBRequest<AutosaveDraftSummary[]>);
      await transactionDone(tx);
      return mergeMemorySummaries(rows.map(summaryOf));
    },
    async () => mergeMemorySummaries([]),
  );
}

async function listAutosaveSessions() {
  return withDb(
    async (db) => {
      const tx = db.transaction(SESSIONS, 'readonly');
      const rows = await requestResult(
        tx.objectStore(SESSIONS).getAll() as IDBRequest<AutosaveSessionHeartbeat[]>,
      );
      await transactionDone(tx);
      return rows;
    },
    async () => [...memorySessions.values()].map((session) => ({ ...session })),
  );
}

/** 현재 살아 있는 다른 window의 draft를 복구 후보에서 제외한다. */
export async function listRecoverableAutosaveDrafts(
  options: RecoverableAutosaveOptions = {},
): Promise<AutosaveDraftSummary[]> {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? AUTOSAVE_SESSION_STALE_MS;
  const heldLocks = await heldOwnerLocks(resolveLocks(options.locks));
  const [drafts, sessions] = await Promise.all([listAutosaveDrafts(), listAutosaveSessions()]);
  const liveness: OwnerLiveness = { now, staleAfterMs, sessions: sessionMap(sessions), heldLocks };
  return drafts.filter((draft) => !draftIsActive(draft, liveness));
}

/** 복구 대화상자·안내로 보여 준 draft 를 기록한다. 보여 준 draft 만 개수 제한 정리 대상이 된다. */
export async function markAutosaveDraftsOffered(ids: readonly string[], offeredAt = Date.now()) {
  const wanted = new Set(ids);
  if (wanted.size === 0) return;
  for (const id of wanted) {
    const mem = memory.get(id);
    if (mem) mem.offeredAt = offeredAt;
  }
  await withDb(
    async (db) => {
      const tx = db.transaction(DRAFT_META, 'readwrite');
      const store = tx.objectStore(DRAFT_META);
      const rows = await Promise.all([...wanted].map((id) => (
        requestResult(store.get(id) as IDBRequest<AutosaveDraftSummary | undefined>)
      )));
      for (const row of rows) {
        if (row && typeof row.offeredAt !== 'number') store.put({ ...row, offeredAt });
      }
      await transactionDone(tx);
    },
    async () => {},
  );
}

export async function touchAutosaveSession(owner: AutosaveOwner, heartbeatAt = Date.now()) {
  const heartbeat: AutosaveSessionHeartbeat = {
    launchId: owner.launchId,
    sessionId: owner.sessionId,
    ...(owner.instanceId ? { instanceId: owner.instanceId } : {}),
    heartbeatAt,
  };
  memorySessions.set(owner.sessionId, heartbeat);
  await withDb(
    async (db) => {
      const tx = db.transaction(SESSIONS, 'readwrite');
      tx.objectStore(SESSIONS).put(heartbeat);
      await transactionDone(tx);
    },
    async () => {},
  );
}

export async function releaseAutosaveSession(sessionId: string) {
  memorySessions.delete(sessionId);
  await withDb(
    async (db) => {
      const tx = db.transaction(SESSIONS, 'readwrite');
      tx.objectStore(SESSIONS).delete(sessionId);
      await transactionDone(tx);
    },
    async () => {},
  );
}

export async function deleteAutosaveDraft(id: string): Promise<void> {
  memory.delete(id);
  memoryBases.delete(id);
  await withDb(
    async (db) => {
      const tx = db.transaction([DRAFTS, DRAFT_META, DRAFT_BASES], 'readwrite');
      tx.objectStore(DRAFTS).delete(id);
      tx.objectStore(DRAFT_META).delete(id);
      tx.objectStore(DRAFT_BASES).delete(id);
      await transactionDone(tx);
    },
    async () => {},
  );
}

/** 복구 가능한(죽은 이전 세션 소유) draft만 지운다. */
export async function clearRecoverableAutosaveDrafts(options: RecoverableAutosaveOptions = {}) {
  const drafts = await listRecoverableAutosaveDrafts(options);
  await Promise.all(drafts.map((draft) => deleteAutosaveDraft(draft.id)));
}

/** 명시적인 전체 초기화 API. 일반 복구 UI는 clearRecoverableAutosaveDrafts를 사용한다. */
export async function clearAutosaveDrafts(): Promise<void> {
  memory.clear();
  memoryBases.clear();
  await withDb(
    async (db) => {
      const tx = db.transaction([DRAFTS, DRAFT_META, DRAFT_BASES], 'readwrite');
      tx.objectStore(DRAFTS).clear();
      tx.objectStore(DRAFT_META).clear();
      tx.objectStore(DRAFT_BASES).clear();
      await transactionDone(tx);
    },
    async () => {},
  );
}
