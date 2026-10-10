/**
 * 에이전트 턴 체크포인트 — "이 작업 전으로 되돌리기".
 *
 * 요청 하나(사용자 메시지의 turnKey)가 시작한 턴이 문서에 처음 쓰기 직전에 엔진 스냅샷을 하나
 * 찍어 둔다. 그 턴이 문서에 남긴 것이 있으면(전체 모드의 직접 확정, 에이전트 모드의 승인) 사용자는
 * 문서 전체를 그 순간으로 되돌릴 수 있다. 되돌리기는 실행 취소 한 단계다.
 *
 * 문서 세션마다 하나다 (DocumentSession.turnCheckpoints). 채팅을 닫거나 화면에서 떼어도 남고,
 * 같은 히스토리를 쓴다. 스냅샷은 렌더러 메모리라 새로고침하면 사라지고, 그때는 아무것도 내놓지
 * 않는다.
 *
 * 예산: 살아 있는 체크포인트는 문서마다 최대 TURN_CHECKPOINT_LIMIT 개이고, 모두 히스토리의
 * 외부 점유(retainExternalSnapshot)로 세어 스냅샷 id 예산(98) 안에 든다. 문서 인스턴스가 바뀌면
 * 스냅샷 id 는 새 문서의 것과 겹치므로 discard 하지 않고 점유만 반환한다.
 *
 * node --test 가 그대로 읽도록 상대 경로 import 와 타입 import 만 쓴다.
 */
import type { EventBus } from '../core/event-bus.ts';

/** 문서 하나가 동시에 품는 체크포인트 스냅샷 수. 넘으면 가장 오래된 것을 놓는다. */
export const TURN_CHECKPOINT_LIMIT = 5;

/** 스냅샷을 놓은 뒤에도 이유를 알려 주려고 남겨 두는 기록 수 (오래된 것부터 지운다). */
const TOMBSTONE_LIMIT = 32;

/**
 * 체크포인트를 찍기 전에 히스토리에 확보할 id 여유. prepareSnapshotCapacity 는 저장소 상한(100)
 * 기준으로 비우므로 3 을 비우면 살아 있는 id 가 97 이하가 되고, 찍은 뒤에도 98 예산 안에 있다.
 * 그래서 다음 스냅샷 명령이 잠시 2 개를 더 저장해도 엔진의 무통보 축출이 일어나지 않는다.
 */
const CAPTURE_RESERVE = 3;

/** 되돌릴 수 없게 된 까닭 (기록은 남아 있다). */
export type TurnRestoreBlock = 'evicted' | 'document-replaced' | 'superseded' | 'capture-failed';

export type TurnRestoreStatus =
  /** 이 요청에는 되돌릴 작업이 없다 (또는 아직 끝나지 않았거나 검토를 기다린다). */
  | { kind: 'none' }
  | { kind: 'blocked'; reason: TurnRestoreBlock }
  /**
   * 되돌릴 수 있다. laterEdits 는 이 작업 뒤에 다른 편집(사용자·다른 채팅·다음 턴·실행 취소)이
   * 있었다는 뜻이라 확인을 받는다. alreadyRestored 는 바로 전에 되돌린 그대로라는 뜻이다.
   */
  | { kind: 'ready'; laterEdits: boolean; alreadyRestored: boolean };

/** 되돌리기를 거절한 까닭. 체크포인트의 막힘 사유와 그때그때의 문서 상태를 함께 담는다. */
export type TurnRestoreRefusal =
  | 'engine'
  | 'hidden'
  | 'running'
  | 'review-pending'
  | 'read-only'
  | 'unavailable'
  | 'failed'
  | TurnRestoreBlock;

export type TurnRestoreResult = { ok: true } | { ok: false; reason: TurnRestoreRefusal; error?: string };

/** 체크포인트가 쓰는 엔진 — WasmBridge 가 그대로 맞는다. */
export interface CheckpointEngine {
  readonly documentInstance: number;
  saveSnapshot(): number;
  discardSnapshot(id: number): void;
}

/** 체크포인트가 쓰는 히스토리 — CommandHistory 의 일부. */
export interface CheckpointHistory {
  readonly version: number;
  hasSnapshotCapacity(additionalIds: number): boolean;
  prepareSnapshotCapacity(engine: CheckpointEngine, additionalIds: number): void;
  retainExternalSnapshot(count?: number): void;
  releaseExternalSnapshot(count?: number): void;
  peekUndoTop(): { readonly type: string } | null;
  /** 이 항목이 아직 실행 취소되지 않고 undo 스택에 있다. */
  hasUndoEntry(entry: object): boolean;
}

/** 브리지가 부르는 부분 (AgentBridgeDeps.turnCheckpoints). */
export type TurnCheckpointPort = Pick<TurnCheckpoints, 'beforeWrite' | 'settleSet' | 'endTurn'>;

/** 사이드바가 쓰는 부분 (AgentSidebarDeps.turnRestore). restore 는 편집기가 문(門)을 채워 넘긴다. */
export interface TurnRestoreControl {
  noteTurnStart(threadId: string, messageKey: string | null): void;
  /** 요청 말풍선이 허브에 거절돼 걷혔다 — 그 요청에 묶였던 턴을 앞 요청(toKey)으로 옮긴다. */
  rebindTurn(threadId: string, fromKey: string, toKey: string | null): void;
  status(threadId: string, messageKey: string): TurnRestoreStatus;
  /** 지금 되돌릴 수 있는지만 본다 (문서를 건드리지 않는다) — 확인을 묻기 전에 거절 사유를 먼저 알린다. */
  check(threadId: string, messageKey: string): TurnRestoreResult;
  restore(threadId: string, messageKey: string): TurnRestoreResult;
  subscribe(listener: () => void): () => void;
}

export interface TurnCheckpointsDeps {
  engine: CheckpointEngine;
  /** 이 문서의 히스토리. 화면에 붙고 떨어질 때도 같은 객체지만, 그때그때 읽는다. */
  history: () => CheckpointHistory;
  /** 문서 교체 신호(document-swapped / document-context-changed)를 듣는다. */
  eventBus?: Pick<EventBus, 'on'>;
  limit?: number;
}

interface Checkpoint {
  readonly threadId: string;
  readonly messageKey: string;
  /** 찍은 순서 — 오래된 것부터 놓는다. */
  seq: number;
  /** 이번 턴에서 찍기를 시도했다 (성공·실패 모두). 같은 턴에 다시 찍지 않는다. */
  captured: boolean;
  /** 살아 있는 스냅샷 id. 아직 찍지 않았거나 놓았으면 null. */
  snapshotId: number | null;
  /** 스냅샷을 찍은 문서 인스턴스. 찍기 전에는 null. */
  documentInstance: number | null;
  /** 찍을 때의 히스토리 번호 */
  versionAtCapture: number;
  /** 이 요청의 턴이 히스토리에 남긴 적용 항목 수 */
  ownCommits: number;
  /** 마지막 적용 항목 직후의 히스토리 번호 */
  lastOwnVersion: number;
  /** 찍을 때 이 채팅에 검토 대기였던 set — 그 미리보기가 스냅샷에 들어 있다. */
  pendingAtCapture: Set<string>;
  /** 이 요청의 턴이 남긴, 아직 검토를 기다리는 set */
  ownedAwaiting: Set<string>;
  /** 이 요청의 턴이 지금 돈다 */
  open: boolean;
  blocked: TurnRestoreBlock | null;
  /** 마지막으로 되돌린 직후의 히스토리 번호 */
  restoredAtVersion: number | null;
  /** 마지막으로 되돌린 히스토리 항목 — 실행 취소하면 undo 스택에서 빠진다. */
  restoredEntry: object | null;
}

const recordKey = (threadId: string, messageKey: string) => `${threadId}\u0000${messageKey}`;

export class TurnCheckpoints {
  private readonly engine: CheckpointEngine;
  private readonly history: () => CheckpointHistory;
  private readonly limit: number;
  private readonly records = new Map<string, Checkpoint>();
  private readonly listeners = new Set<() => void>();
  /** 이미 어느 요청의 적용으로 센 히스토리 항목 — 같은 항목을 두 번 세지 않는다. */
  private readonly countedCommits = new WeakSet<object>();
  private readonly unsubs: Array<() => void> = [];
  private seq = 0;
  private disposed = false;

  constructor(deps: TurnCheckpointsDeps) {
    this.engine = deps.engine;
    this.history = deps.history;
    this.limit = Math.max(1, Math.trunc(deps.limit ?? TURN_CHECKPOINT_LIMIT));
    // 문서가 바뀌면 이전 문서의 점유를 곧바로 돌려준다 — 다음 호출까지 새 문서의 예산을 잡지 않게.
    for (const name of ['document-swapped', 'document-context-changed'] as const) {
      const off = deps.eventBus?.on(name, () => {
        if (this.syncDocument()) this.emit();
      });
      if (off) this.unsubs.push(off);
    }
  }

  /**
   * 턴이 시작됐다 (사이드바의 turn-start). key 는 그 스레드의 마지막 사용자 메시지 —
   * 계획 실행처럼 허브가 시작한 턴도 그 턴을 만든 요청에 묶인다. 같은 요청의 기록이 살아 있으면
   * 다시 열어 이어 쌓고, 이유만 남은 기록은 새로 만든다. key 가 없으면 기록하지 않는다.
   */
  noteTurnStart(threadId: string, messageKey: string | null): void {
    if (this.disposed) return;
    this.syncDocument();
    // turn-end 를 놓친 채 열려 있던 같은 스레드의 다른 요청은 닫는다.
    for (const record of [...this.records.values()]) {
      if (record.threadId === threadId && record.open && record.messageKey !== messageKey) {
        record.open = false;
        this.settleIfEmpty(record);
      }
    }
    if (messageKey) {
      const existing = this.records.get(recordKey(threadId, messageKey));
      if (existing && existing.snapshotId !== null && !existing.blocked) {
        existing.open = true;
      } else {
        if (existing) this.drop(existing);
        this.records.set(recordKey(threadId, messageKey), {
          threadId,
          messageKey,
          seq: ++this.seq,
          captured: false,
          snapshotId: null,
          documentInstance: null,
          versionAtCapture: 0,
          ownCommits: 0,
          lastOwnVersion: 0,
          pendingAtCapture: new Set(),
          ownedAwaiting: new Set(),
          open: true,
          blocked: null,
          restoredAtVersion: null,
          restoredEntry: null,
        });
      }
    }
    this.emit();
  }

  /**
   * 요청 말풍선이 허브에 거절돼 대화에서 걷혔다 (대기 메시지의 되돌림). 그 사이 허브가 스스로 시작한
   * 턴(계획 실행 등)의 turn-start 가 먼저 와서 걷힌 요청에 묶였으면, 그 턴을 지금 남은 마지막 요청
   * (toKey)으로 옮긴다 — 처음부터 그 요청에 묶였을 때(noteTurnStart)와 같아진다. 앞 요청의 기록이
   * 살아 있으면 그 기록을 다시 열어 이어 쌓고(시점이 더 이르다), 없으면 이 기록이 앞 요청의 것이 된다.
   * 앞 요청이 없으면 기록을 버린다 — 되돌리기 단추를 달 말풍선이 없다.
   */
  rebindTurn(threadId: string, fromKey: string, toKey: string | null): void {
    if (this.disposed) return;
    const record = this.records.get(recordKey(threadId, fromKey));
    if (!record) return;
    this.syncDocument();
    this.records.delete(recordKey(threadId, fromKey));
    const target = toKey && toKey !== fromKey ? this.records.get(recordKey(threadId, toKey)) : undefined;
    if (!toKey || toKey === fromKey) {
      this.releaseSnapshot(record);
    } else if (target && target.snapshotId !== null && !target.blocked) {
      // 앞 요청의 시점이 이 턴의 시점보다 앞선다 — 그 기록이 이 턴의 몫까지 맡고, 이 기록의 스냅샷은 놓는다.
      target.open ||= record.open;
      target.ownCommits += record.ownCommits;
      if (record.ownCommits > 0) target.lastOwnVersion = Math.max(target.lastOwnVersion, record.lastOwnVersion);
      for (const id of record.ownedAwaiting) target.ownedAwaiting.add(id);
      this.releaseSnapshot(record);
      this.settleIfEmpty(target);
    } else {
      if (target) this.drop(target);
      this.records.set(recordKey(threadId, toKey), { ...record, messageKey: toKey });
    }
    this.pruneTombstones();
    this.emit();
  }

  /**
   * 되돌리려는데 엔진에 그 스냅샷이 없다 (엔진이 상한을 넘겨 말없이 밀어냈다). 매번 실패하지 않게
   * 밀려난 시점으로 막고 점유를 돌려준다.
   */
  markSnapshotMissing(threadId: string, messageKey: string): void {
    const record = this.records.get(recordKey(threadId, messageKey));
    if (!record || this.disposed) return;
    this.block(record, 'evicted');
    this.pruneTombstones();
    this.emit();
  }

  /**
   * 문서 쓰기 도구가 모든 문을 지나 문서에 닿기 직전 (실행기의 beforeDocumentWrite).
   * 그 스레드에서 도는 요청이 아직 찍지 않았으면 지금 문서를 찍는다. 실패해도 쓰기를 막지 않는다.
   */
  beforeWrite(threadId: string, pendingSetIds: readonly string[]): void {
    if (this.disposed) return;
    this.syncDocument();
    const record = this.openRecord(threadId);
    if (!record || record.captured) return;
    record.captured = true;
    // 새 체크포인트 자리를 먼저 만든다 — 살아 있는 스냅샷이 잠시라도 상한을 넘지 않게.
    this.evictOverLimit(this.limit - 1);
    try {
      const history = this.history();
      if (!history.hasSnapshotCapacity(1)) history.prepareSnapshotCapacity(this.engine, CAPTURE_RESERVE);
      // 히스토리를 다 비워도 자리가 없으면(다른 외부 점유) 찍지 않는다 — 엔진이 남의 스냅샷을 밀어낸다.
      if (!history.hasSnapshotCapacity(1)) throw new Error('snapshot budget is full');
      const id = this.engine.saveSnapshot();
      history.retainExternalSnapshot(1);
      record.snapshotId = id;
      record.documentInstance = this.engine.documentInstance;
      record.versionAtCapture = history.version;
      record.lastOwnVersion = history.version;
      record.pendingAtCapture = new Set(pendingSetIds);
      record.seq = ++this.seq;
    } catch (error) {
      record.blocked = 'capture-failed';
      console.warn('[turn-checkpoints] 턴 체크포인트를 찍지 못했습니다:', error);
    }
    this.evictOverLimit(this.limit);
    this.emit();
  }

  /**
   * 검토 set 하나가 정리됐다 — kept 는 승인(전체 모드의 직접 확정 포함), 아니면 거절·폐기.
   * 승인이 히스토리에 새 적용 항목을 남겼으면 그 set 을 만든 요청의 몫으로 센다.
   */
  settleSet(threadId: string, setId: string, kept: boolean): void {
    if (this.disposed) return;
    this.syncDocument();
    const owner = this.ownerOf(threadId, setId);
    if (kept) {
      const top = this.history().peekUndoTop();
      if (top?.type === 'snapshot:agentApplyChangeSet' && !this.countedCommits.has(top)) {
        this.countedCommits.add(top);
        if (owner) {
          owner.ownCommits += 1;
          owner.lastOwnVersion = this.history().version;
        }
      }
    }
    owner?.ownedAwaiting.delete(setId);
    for (const record of [...this.records.values()]) {
      if (!record.pendingAtCapture.delete(setId) || kept) continue;
      // 찍을 때 들어 있던 미리보기를 나중에 거절했다 — 되돌리면 거절한 글이 되살아난다.
      this.block(record, 'superseded');
    }
    if (owner) this.settleIfEmpty(owner);
    this.pruneTombstones();
    this.emit();
  }

  /** 턴이 끝났다. 남은 검토 대기 set 중 이 턴이 만든 것을 기억한다. */
  endTurn(threadId: string, pendingSetIds: readonly string[]): void {
    if (this.disposed) return;
    this.syncDocument();
    let changed = false;
    for (const record of [...this.records.values()]) {
      if (record.threadId !== threadId || !record.open) continue;
      record.open = false;
      if (record.captured) {
        for (const id of pendingSetIds) {
          if (!record.pendingAtCapture.has(id)) record.ownedAwaiting.add(id);
        }
      }
      this.settleIfEmpty(record);
      changed = true;
    }
    if (!changed) return;
    this.pruneTombstones();
    this.emit();
  }

  status(threadId: string, messageKey: string): TurnRestoreStatus {
    if (this.disposed) return { kind: 'none' };
    this.syncDocument();
    const record = this.records.get(recordKey(threadId, messageKey));
    if (!record || record.open || record.ownedAwaiting.size > 0 || record.ownCommits === 0) return { kind: 'none' };
    if (record.blocked) return { kind: 'blocked', reason: record.blocked };
    if (record.snapshotId === null) return { kind: 'none' };
    const version = this.history().version;
    return {
      kind: 'ready',
      laterEdits: record.lastOwnVersion - record.versionAtCapture !== record.ownCommits
        || version !== record.lastOwnVersion,
      alreadyRestored: record.restoredAtVersion === version,
    };
  }

  /** 되돌릴 스냅샷 id. 되돌린 뒤에도 기록이 계속 들고 있어 다시 쓸 수 있다. */
  takeSnapshotForRestore(threadId: string, messageKey: string): number | null {
    if (this.status(threadId, messageKey).kind !== 'ready') return null;
    return this.records.get(recordKey(threadId, messageKey))?.snapshotId ?? null;
  }

  markRestored(threadId: string, messageKey: string): void {
    const record = this.records.get(recordKey(threadId, messageKey));
    if (!record || this.disposed) return;
    const history = this.history();
    record.restoredAtVersion = history.version;
    record.restoredEntry = history.peekUndoTop();
    this.emit();
  }

  /**
   * 마지막 되돌리기가 아직 문서에 남아 있는가 — 실행 취소하면 거짓, 다시 실행하면 참이다. 그 뒤의
   * 편집은 상관없다. 모르면(기록이 사라졌다) 참으로 본다 — 에이전트에게 가는 안내를 잃지 않게.
   */
  restoreStillApplies(threadId: string, messageKey: string): boolean {
    const entry = this.records.get(recordKey(threadId, messageKey))?.restoredEntry;
    if (!entry || this.disposed) return true;
    return this.history().hasUndoEntry(entry);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** 문서 세션을 닫는다. 같은 문서일 때만 스냅샷을 지우고, 점유는 언제나 돌려준다. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubs.splice(0)) off();
    for (const record of this.records.values()) this.releaseSnapshot(record);
    this.records.clear();
    this.listeners.clear();
  }

  // ─── 내부 ────────────────────────────────────────────

  private openRecord(threadId: string): Checkpoint | null {
    let found: Checkpoint | null = null;
    for (const record of this.records.values()) {
      if (record.threadId === threadId && record.open && (!found || record.seq > found.seq)) found = record;
    }
    return found;
  }

  /**
   * set 을 만든 요청. 검토를 기다리던 set 이면 그것을 남긴 요청이고, 아니면 지금 도는 요청이
   * 찍은 뒤에 생긴 set (전체 모드의 쓰기별 확정)이다. 찍기 전의 set 은 아무 요청의 것도 아니다.
   */
  private ownerOf(threadId: string, setId: string): Checkpoint | null {
    let awaiting: Checkpoint | null = null;
    for (const record of this.records.values()) {
      if (!record.ownedAwaiting.has(setId)) continue;
      if (record.threadId === threadId) return record;
      awaiting ??= record;
    }
    if (awaiting) return awaiting;
    const running = this.openRecord(threadId);
    return running?.captured && !running.pendingAtCapture.has(setId) ? running : null;
  }

  /** 끝난 요청이 문서에 남긴 것도, 기다리는 것도 없으면 기록과 스냅샷을 놓는다. */
  private settleIfEmpty(record: Checkpoint): void {
    if (record.open || record.ownedAwaiting.size > 0 || record.ownCommits > 0) return;
    this.drop(record);
  }

  private drop(record: Checkpoint): void {
    this.releaseSnapshot(record);
    this.records.delete(recordKey(record.threadId, record.messageKey));
  }

  private block(record: Checkpoint, reason: TurnRestoreBlock): void {
    record.blocked ??= reason;
    this.releaseSnapshot(record);
  }

  /** 스냅샷을 놓는다. 다른 문서가 열렸으면 그 id 는 새 문서의 것이므로 지우지 않는다. */
  private releaseSnapshot(record: Checkpoint): void {
    const id = record.snapshotId;
    if (id === null) return;
    record.snapshotId = null;
    if (record.documentInstance === this.engine.documentInstance) {
      try { this.engine.discardSnapshot(id); } catch { /* 문서가 이미 내려갔다 */ }
    }
    this.history().releaseExternalSnapshot(1);
  }

  /** 문서가 바뀌었으면 이전 문서의 체크포인트를 막는다. 바뀐 것이 있으면 true. */
  private syncDocument(): boolean {
    if (this.disposed) return false;
    const instance = this.engine.documentInstance;
    let changed = false;
    for (const record of this.records.values()) {
      if (record.documentInstance === null || record.documentInstance === instance) continue;
      if (record.snapshotId === null && record.blocked) continue;
      this.block(record, 'document-replaced');
      changed = true;
    }
    return changed;
  }

  /** 살아 있는 스냅샷이 max 개를 넘지 않게 끝난 요청 중 가장 오래된 것부터 놓는다. */
  private evictOverLimit(max: number): void {
    const live = () => [...this.records.values()].filter((record) => record.snapshotId !== null);
    while (live().length > max) {
      const oldest = live().filter((record) => !record.open).sort((a, b) => a.seq - b.seq)[0];
      if (!oldest) return;
      this.block(oldest, 'evicted');
    }
    this.pruneTombstones();
  }

  /** 스냅샷 없이 이유만 남은 기록은 오래된 것부터 TOMBSTONE_LIMIT 개만 둔다. */
  private pruneTombstones(): void {
    const tombstones = [...this.records.values()]
      .filter((record) => record.snapshotId === null && !record.open)
      .sort((a, b) => a.seq - b.seq);
    for (const record of tombstones.slice(0, Math.max(0, tombstones.length - TOMBSTONE_LIMIT))) {
      this.records.delete(recordKey(record.threadId, record.messageKey));
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch (error) { console.warn('[turn-checkpoints] listener failed', error); }
    }
  }
}

/** 되돌리기 직전에 편집기가 채우는 문(門). 순서대로 검사하고, 통과하면 apply 로 되돌린다. */
export interface TurnRestoreGates {
  /** 엔진이 멈췄다 (engineTrap) */
  engineStopped(): boolean;
  /** 이 문서가 화면에 붙어 있다 */
  documentShown(): boolean;
  /** 이 문서의 어느 채팅이 일하는 중이다 (검토 대기만 남은 것은 아래에서 따로 본다) */
  turnRunning(): boolean;
  /** 이 문서의 어느 채팅에 검토 대기 편집이 있다 */
  reviewPending(): boolean;
  /** 읽기 전용이거나 양식 모드다 */
  readOnly(): boolean;
  /** 스냅샷으로 문서를 되돌리고 실행 취소 한 단계를 남긴다 (InputHandler.restoreDocumentSnapshot) */
  apply(snapshotId: number): void;
}

/**
 * 지금 되돌릴 수 있는가 — 문서와 기록을 건드리지 않는다.
 * 검사 순서: 엔진 → 화면 → 작업 중 → 검토 대기 → 읽기 전용 → 체크포인트 상태.
 */
export function checkTurnRestore(
  store: Pick<TurnCheckpoints, 'status'>,
  threadId: string,
  messageKey: string,
  gates: Omit<TurnRestoreGates, 'apply'>,
): TurnRestoreResult {
  if (gates.engineStopped()) return { ok: false, reason: 'engine' };
  if (!gates.documentShown()) return { ok: false, reason: 'hidden' };
  if (gates.turnRunning()) return { ok: false, reason: 'running' };
  if (gates.reviewPending()) return { ok: false, reason: 'review-pending' };
  if (gates.readOnly()) return { ok: false, reason: 'read-only' };
  const status = store.status(threadId, messageKey);
  if (status.kind === 'blocked') return { ok: false, reason: status.reason };
  if (status.kind !== 'ready') return { ok: false, reason: 'unavailable' };
  return { ok: true };
}

/**
 * 요청 하나의 작업 전으로 문서를 되돌린다. 거절할 때는 문서와 기록을 건드리지 않는다.
 * 검사는 checkTurnRestore 와 같고, 통과하면 apply 로 되돌린 뒤 되돌린 시점을 기억한다.
 */
export function restoreTurn(
  store: Pick<TurnCheckpoints, 'status' | 'takeSnapshotForRestore' | 'markRestored' | 'markSnapshotMissing'>,
  threadId: string,
  messageKey: string,
  gates: TurnRestoreGates,
): TurnRestoreResult {
  const checked = checkTurnRestore(store, threadId, messageKey, gates);
  if (!checked.ok) return checked;
  const snapshotId = store.takeSnapshotForRestore(threadId, messageKey);
  if (snapshotId === null) return { ok: false, reason: 'unavailable' };
  try {
    gates.apply(snapshotId);
  } catch (error) {
    // 엔진에 시점이 남아 있지 않다 — 다시 눌러도 같으므로 밀려난 시점으로 막는다.
    if (isMissingSnapshotError(error, snapshotId)) {
      store.markSnapshotMissing(threadId, messageKey);
      return { ok: false, reason: 'evicted' };
    }
    return { ok: false, reason: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
  store.markRestored(threadId, messageKey);
  return { ok: true };
}

/**
 * 엔진이 없는 스냅샷 id 로 복원하라는 요청을 거절했는가. 엔진(rhwp/src/document_core/commands/document.rs
 * restore_snapshot_native)은 "스냅샷 {id} 없음" 을 문자열로 던진다 (wasm_api.rs 의 HwpError → JsValue).
 */
export function isMissingSnapshotError(error: unknown, snapshotId: number): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.includes(`스냅샷 ${snapshotId} 없음`);
}
