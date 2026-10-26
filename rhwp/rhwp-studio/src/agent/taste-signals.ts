/**
 * 취향 학습용 검토 신호 — 사용자가 에이전트의 글을 받아들이고(accepted), 거절하고(rejected),
 * 고쳐 쓰고(rewritten), 되돌린(undone) 흔적을 모아 허브에 보낸다 (chat-review-signal).
 *
 * - accepted·rejected: 대기 편집의 승인·거절에서 op 마다 원래 글(before)과 에이전트 글(after)을 짝짓는다.
 *   승인은 문단 하나 안의 op 들을 문단 전체 글의 짝으로 묶는다. 전체 모드의 즉시 확정(direct)과
 *   무효화는 검토가 아니라 신호를 내지 않는다.
 * - rewritten: taste-rewrites.ts 의 RewriteTracker 가 맡는다. 'agent-*' 변이(같은 문서의 다른 채팅 포함)와
 *   실행 취소는 사용자 편집이 아니라 기준만 다시 잡는다. 승인은 이미 보이던 미리보기를 채택할 뿐이라
 *   ('input-handler-edit' 로 와도) 글이 바뀌지 않는다 — 글은 스테이징 때 'agent-*' 로 이미 바뀌었다.
 * - undone: 에이전트 적용 항목을 실행 취소했거나(history-jumped 뒤 redo 스택에 있다)
 *   "이 작업 전으로 되돌리기"로 그 턴 이전으로 돌렸을 때.
 * 신호는 ReviewSignalOutbox 가 2초씩 모아 프레임 하나에 20개까지 싣는다. 끊긴 동안은 잠깐(1분)
 * 쌓아 두고, 다른 문서로 바뀐 신호는 버린다. 허브는 메모리에만 둔다.
 * 저장·이름 바꾸기는 문서를 바꾸지 않는다 — 문서 인스턴스가 바뀔 때만 모은 것을 버린다.
 *
 * 알려진 한계: 턴 되돌리기로 낸 undone 은 사용자가 그 되돌리기를 실행 취소해도 거두지 않는다.
 *
 * node --test 가 그대로 읽도록 상대 경로 import 와 타입 import 만 쓴다.
 */
import type { DocumentPosition } from '../core/types.ts';
import type { EventBus } from '../core/event-bus.ts';
import type { PendingChangeSet, PendingEditsChangeEvent, PendingOp, ReviewSignal } from './types.ts';
import {
  RewriteTracker,
  SPAN_END,
  changedRegion,
  containerKey,
  type ParagraphReader,
  type ParagraphRef,
  type RewriteHandle,
  type RewriteSource,
  type TrackParagraph,
  type TrackedParagraph,
} from './taste-rewrites.ts';

export const SIGNAL_TEXT_LIMIT = 600;
export const SIGNALS_PER_FRAME = 20;
const DEBOUNCE_MS = 2_000;
/** 계속 신호가 들어와도 이보다 오래 미루지 않는다. */
const MAX_WAIT_MS = 8_000;
const QUEUE_LIMIT = 100;
const QUEUE_MAX_AGE_MS = 60_000;
/** 되돌리기에 쓰려고 기억하는 에이전트 적용 기록 수 */
const WRITE_RECORD_LIMIT = 50;
/** op 하나가 지켜볼 문단 수 상한 (긴 삽입) */
const TRACK_PARAGRAPHS_PER_OP = 20;
const AGENT_APPLY_COMMAND = 'snapshot:agentApplyChangeSet';

type TimerHandle = ReturnType<typeof setTimeout>;

/** 코드 포인트 단위로 max 자까지 자른다. 잘랐으면 끝에 … 를 붙인다. */
export function clipText(text: string, max = SIGNAL_TEXT_LIMIT): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * 긴 두 글을 바뀐 곳 둘레만 남기고 자른다 — 600자에 문단 앞부분만 남아 정작 바뀐 곳이
 * 잘려 나가지 않게. 둘 다 max 이하면 그대로 둔다.
 */
export function focusPair(a: string, b: string, max = SIGNAL_TEXT_LIMIT): [string, string] {
  if ([...a].length <= max && [...b].length <= max) return [a, b];
  const { prefix, suffix } = changedRegion(a, b);
  const mid = Math.max(a.length - prefix - suffix, b.length - prefix - suffix);
  const context = Math.max(40, Math.floor((max - mid) / 2));
  const start = Math.max(0, prefix - context);
  const crop = (text: string) => {
    const end = Math.min(text.length, text.length - suffix + context);
    return clipText(`${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`, max);
  };
  return [crop(a), crop(b)];
}

type TextOp = Extract<PendingOp, { kind: 'insert' | 'replace' }>;

function textOps(ops: readonly PendingOp[], exclude?: ReadonlySet<string>): TextOp[] {
  return ops.filter((op): op is TextOp =>
    (op.kind === 'insert' || op.kind === 'replace')
    && !exclude?.has(op.id)
    && op.text !== (op.kind === 'replace' ? op.deletedText : ''));
}

const deletedOf = (op: TextOp): string => (op.kind === 'replace' ? op.deletedText : '');
const opContainer = (op: TextOp): ParagraphRef => ({
  sectionIdx: op.range.sectionIdx,
  paraIdx: op.range.startParaIdx,
  ...(op.range.cell ? { cell: op.range.cell } : {}),
});

/** 같은 문단에서 시작하는 op 끼리 묶는다 (문서 순서). */
function groupByParagraph(ops: readonly TextOp[]): TextOp[][] {
  const groups = new Map<string, TextOp[]>();
  for (const op of ops) {
    const key = `${containerKey(opContainer(op))}#${op.range.startParaIdx}`;
    const group = groups.get(key);
    if (group) group.push(op);
    else groups.set(key, [op]);
  }
  return [...groups.values()].map((group) => group.sort((x, y) => x.range.startCharOffset - y.range.startCharOffset));
}

const singleParagraph = (op: TextOp): boolean =>
  op.range.startParaIdx === op.range.endParaIdx && !op.text.includes('\n') && !deletedOf(op).includes('\n');

/**
 * 문단 하나 안의 op 들로 승인 전·후 문단 전체 글을 만든다. 지금 문서의 op 자리에 에이전트 글이
 * 그대로 있을 때만 — 아니면 null.
 */
function paragraphPair(group: readonly TextOp[], reader: ParagraphReader): { before: string; after: string } | null {
  if (!group.every(singleParagraph)) return null;
  let after: string | null;
  try {
    after = reader.text(opContainer(group[0]));
  } catch {
    return null;
  }
  if (after === null) return null;
  let before = after;
  let limit = after.length;
  for (const op of [...group].reverse()) {
    const { startCharOffset: from, endCharOffset: to } = op.range;
    if (from < 0 || to > limit || to < from || after.slice(from, to) !== op.text) return null;
    before = before.slice(0, from) + deletedOf(op) + before.slice(to);
    limit = from;
  }
  return { before, after };
}

/** 승인·거절된 set 의 op 들에서 신호를 만든다. 같은 짝(바꾸기 전체 등)은 한 번만 낸다. */
export function outcomeSignals(
  kind: 'accepted' | 'rejected',
  ops: readonly PendingOp[],
  opts: { at: string; turnId?: string; reader?: ParagraphReader; exclude?: ReadonlySet<string> },
): ReviewSignal[] {
  const signals: ReviewSignal[] = [];
  const seen = new Set<string>();
  for (const group of groupByParagraph(textOps(ops, opts.exclude))) {
    const pair = kind === 'accepted' && opts.reader ? paragraphPair(group, opts.reader) : null;
    let before: string;
    let after: string;
    if (pair) {
      [before, after] = focusPair(pair.before, pair.after);
    } else {
      before = group.map((op) => deletedOf(op).trim()).filter(Boolean).join(' … ');
      after = group.map((op) => op.text.trim()).filter(Boolean).join(' … ');
    }
    const key = `${before}\u0000${after}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const head = group[0].range;
    // 문단 끝에 '\n…' 을 붙인 삽입은 새 문단에 글이 있다.
    const lead = group[0].text.length - group[0].text.replace(/^\n+/, '').length;
    signals.push({
      kind,
      at: opts.at,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
      ...(head.cell ? {} : { paraIdx: head.startParaIdx + lead }),
      ...(opts.turnId ? { turnId: opts.turnId } : {}),
    });
  }
  return signals;
}

/** 승인된 op 들이 쓴 문단 — 고쳐 쓰기를 지켜볼 대상. 에이전트가 지우기만 한 문단은 뺀다. */
export function writtenParagraphs(
  ops: readonly PendingOp[],
  opts: { threadId?: string; turnId?: string; reader?: ParagraphReader; exclude?: ReadonlySet<string> } = {},
): TrackParagraph[] {
  const byKey = new Map<string, TrackParagraph>();
  const add = (ref: ParagraphRef, span: [number, number] | null, beforeText?: string) => {
    const key = `${containerKey(ref)}#${ref.paraIdx}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ref,
        spans: span ? [span] : null,
        ...(beforeText !== undefined ? { beforeText } : {}),
        ...(opts.threadId ? { threadId: opts.threadId } : {}),
        ...(opts.turnId ? { turnId: opts.turnId } : {}),
      });
      return;
    }
    existing.spans = existing.spans && span ? [...existing.spans, span] : null;
  };
  for (const group of groupByParagraph(textOps(ops, opts.exclude).filter((op) => op.text))) {
    const pair = opts.reader ? paragraphPair(group, opts.reader) : null;
    for (const op of group) {
      const { startParaIdx, endParaIdx, startCharOffset, endCharOffset } = op.range;
      const last = Math.min(endParaIdx, startParaIdx + TRACK_PARAGRAPHS_PER_OP - 1);
      // op 글을 문단으로 나눈 조각 — 조각이 빈 문단(문단 끝에 '\n…' 을 붙인 앞 문단 등)은 에이전트가 쓰지 않았다.
      const pieces = op.text.split('\n');
      for (let paraIdx = startParaIdx; paraIdx <= last; paraIdx++) {
        if (pieces[paraIdx - startParaIdx] === '') continue;
        const ref = { ...opContainer(op), paraIdx };
        const from = paraIdx === startParaIdx ? startCharOffset : 0;
        const to = paraIdx === endParaIdx ? endCharOffset : SPAN_END;
        // 오프셋을 믿을 수 있는(문단 짝이 맞은) 문단만 구간을 쓴다 — 아니면 문단 전체.
        const span: [number, number] | null = pair ? [from, to] : null;
        add(ref, span, pair && paraIdx === startParaIdx ? pair.before : undefined);
      }
    }
  }
  return [...byKey.values()];
}

/** 에이전트가 고친 문단의 지금 글과 (알면) 고치기 전 글 — 글 없는 지우기(빈 바꾸기)도 담는다. */
export interface AgentEditedParagraph {
  ref: ParagraphRef;
  /** 고치기 전 문단 전체 글 (문단 하나 안의 op 일 때만) */
  before?: string;
  /** 지금 문단 글. 읽지 못하면 null */
  text: string | null;
}

/** 승인·확정된 op 들이 닿은 문단. 문단 하나 안의 op 는 전·후 글을, 여러 문단에 걸치면 닿은 문단의 지금 글만. */
export function editedParagraphs(
  ops: readonly PendingOp[],
  opts: { reader: ParagraphReader; exclude?: ReadonlySet<string> },
): AgentEditedParagraph[] {
  const out = new Map<string, AgentEditedParagraph>();
  const read = (ref: ParagraphRef): string | null => {
    try {
      return opts.reader.text(ref);
    } catch {
      return null;
    }
  };
  for (const group of groupByParagraph(textOps(ops, opts.exclude))) {
    const pair = paragraphPair(group, opts.reader);
    if (pair) {
      const ref = opContainer(group[0]);
      out.set(`${containerKey(ref)}#${ref.paraIdx}`, { ref, before: pair.before, text: pair.after });
      continue;
    }
    for (const op of group) {
      const last = Math.min(op.range.endParaIdx, op.range.startParaIdx + TRACK_PARAGRAPHS_PER_OP - 1);
      for (let paraIdx = op.range.startParaIdx; paraIdx <= last; paraIdx++) {
        const ref = { ...opContainer(op), paraIdx };
        const key = `${containerKey(ref)}#${paraIdx}`;
        if (!out.has(key)) out.set(key, { ref, text: read(ref) });
      }
    }
  }
  return [...out.values()];
}

// ── 보내기 ────────────────────────────────────────────────

export interface ReviewSignalFrame {
  threadId: string;
  turnId?: string;
  documentId: string;
  signals: ReviewSignal[];
}

export interface ReviewSignalContext {
  threadId: string;
  documentId: string | null;
  turnId?: string | null;
}

interface QueuedSignal {
  threadId: string;
  documentId: string;
  turnId: string | null;
  signal: ReviewSignal;
  queuedAt: number;
}

export interface ReviewSignalOutboxDeps {
  /** 프레임을 보낸다. 보내지 못했으면 false (끊김). */
  send(frame: ReviewSignalFrame): boolean;
  canSend(): boolean;
  /** 지금 이 채팅의 문서 — 다른 문서의 신호는 버린다. */
  documentId(): string | null;
  now?(): number;
  setTimer?(run: () => void, ms: number): TimerHandle;
  clearTimer?(handle: TimerHandle): void;
  debounceMs?: number;
}

function clipSignal(signal: ReviewSignal): ReviewSignal {
  const out: ReviewSignal = { kind: signal.kind, at: signal.at };
  if (signal.before) out.before = clipText(signal.before);
  if (signal.after) out.after = clipText(signal.after);
  if (signal.userText) out.userText = clipText(signal.userText);
  if (signal.paraIdx !== undefined) out.paraIdx = signal.paraIdx;
  if (signal.turnId) out.turnId = signal.turnId;
  return out;
}

export class ReviewSignalOutbox {
  private readonly deps: ReviewSignalOutboxDeps;
  private queue: QueuedSignal[] = [];
  private timer: TimerHandle | null = null;
  private firstQueuedAt: number | null = null;

  constructor(deps: ReviewSignalOutboxDeps) {
    this.deps = deps;
  }

  get pending(): number {
    return this.queue.length;
  }

  push(context: ReviewSignalContext, signals: readonly ReviewSignal[]): void {
    if (!context.documentId || !context.threadId || signals.length === 0) return;
    const now = this.now();
    for (const signal of signals) {
      this.queue.push({
        threadId: context.threadId,
        documentId: context.documentId,
        turnId: signal.turnId ?? context.turnId ?? null,
        signal: clipSignal(signal),
        queuedAt: now,
      });
    }
    if (this.queue.length > QUEUE_LIMIT) this.queue.splice(0, this.queue.length - QUEUE_LIMIT);
    this.firstQueuedAt ??= now;
    this.schedule(Math.min(this.deps.debounceMs ?? DEBOUNCE_MS, Math.max(0, this.firstQueuedAt + MAX_WAIT_MS - now)));
  }

  /** 다시 연결됐다 — 쌓인 신호를 곧 보낸다. */
  noteConnected(): void {
    if (this.queue.length > 0) this.schedule(0);
  }

  /** 모아 둔 신호를 지금 보낸다. 보낼 수 없으면 남겨 둔다 (1분 지난 것은 버린다). */
  flush(): void {
    this.cancel();
    const now = this.now();
    const documentId = this.deps.documentId();
    this.queue = this.queue.filter((item) => item.documentId === documentId && now - item.queuedAt <= QUEUE_MAX_AGE_MS);
    this.firstQueuedAt = this.queue.length > 0 ? this.queue[0].queuedAt : null;
    if (this.queue.length === 0 || !this.deps.canSend()) return;
    while (this.queue.length > 0) {
      const head = this.queue[0];
      const batch: QueuedSignal[] = [];
      for (const item of this.queue) {
        if (batch.length >= SIGNALS_PER_FRAME) break;
        if (item.threadId === head.threadId && item.turnId === head.turnId) batch.push(item);
      }
      const frame: ReviewSignalFrame = {
        threadId: head.threadId,
        ...(head.turnId ? { turnId: head.turnId } : {}),
        documentId: head.documentId,
        signals: batch.map((item) => item.signal),
      };
      if (!this.deps.send(frame)) break;
      const sent = new Set(batch);
      this.queue = this.queue.filter((item) => !sent.has(item));
    }
    this.firstQueuedAt = this.queue.length > 0 ? this.queue[0].queuedAt : null;
  }

  dropAll(): void {
    this.queue = [];
    this.firstQueuedAt = null;
    this.cancel();
  }

  /** 닫기 전에 보낼 수 있는 것은 보낸다 (브리지는 소켓을 닫기 전에 flush 를 먼저 부른다). */
  dispose(): void {
    this.flush();
    this.dropAll();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private schedule(ms: number): void {
    this.cancel();
    const set = this.deps.setTimer ?? ((run, delay) => setTimeout(run, delay));
    this.timer = set(() => {
      this.timer = null;
      this.flush();
    }, ms);
  }

  private cancel(): void {
    if (this.timer === null) return;
    (this.deps.clearTimer ?? clearTimeout)(this.timer);
    this.timer = null;
  }
}

// ── 모으기 ────────────────────────────────────────────────

/**
 * 에이전트 글의 출처를 남기는 쪽 (기록에서 배우기, taste-history.ts). 지켜보기를 시작한 문단,
 * 고쳐 쓰기 신호를 낸 문단, 되돌린 쓰기의 문단을 handle 로 알린다. edited 는 승인·확정된 쓰기가 닿은
 * 모든 문단(글 없는 지우기 포함)과, 그 쓰기를 실행 취소해 다시 바뀐 문단이다.
 */
export interface AgentWriteObserver {
  written(paragraphs: readonly TrackedParagraph[]): void;
  edited(paragraphs: readonly AgentEditedParagraph[]): void;
  rewritten(source: RewriteSource): void;
  undone(handles: readonly RewriteHandle[]): void;
}

/** 실행 취소 판별에 쓰는 히스토리 — CommandHistory 의 일부. */
export interface TasteUndoHistory {
  peekUndoTop(): { readonly type: string } | null;
  hasRedoEntry(entry: object): boolean;
}

export interface TasteSignalCollectorDeps {
  pending: {
    onChange(cb: (e: PendingEditsChangeEvent) => void): () => void;
    getChangeSets(): ReadonlyArray<PendingChangeSet>;
  };
  eventBus: Pick<EventBus, 'on'>;
  reader: ParagraphReader;
  /** 화면 커서 (문서가 화면에 없으면 null) */
  caret(): DocumentPosition | null;
  /** 지금 턴의 스레드와 허브 턴 id */
  turnContext(): { threadId: string; turnId: string | null };
  /** 지금 문서 인스턴스 (WasmBridge.documentInstance). 없으면 document-swapped 때만 비운다. */
  documentInstance?(): number | undefined;
  history?(): TasteUndoHistory | null;
  emit(signals: ReviewSignal[], context: { threadId: string; turnId: string | null }): void;
  observer?: AgentWriteObserver;
  now?(): number;
  setTimer?(run: () => void, ms: number): TimerHandle;
  clearTimer?(handle: TimerHandle): void;
}

interface SetOrigin {
  set: PendingChangeSet;
  threadId: string;
  turnId: string | null;
}

/** 문서에 남은 에이전트 적용 하나 — 실행 취소·턴 되돌리기 때 undone 신호의 재료. */
interface WriteRecord {
  seq: number;
  threadId: string;
  turnId: string | null;
  texts: string[];
  /** 이 쓰기가 건 고쳐 쓰기 지켜보기 — 문단 번호가 밀려도 되돌릴 때 찾을 수 있다 */
  tracked: RewriteHandle[];
  /** 이 쓰기가 닿은 문단과 쓴 뒤 글 — 되돌리면 출처 기록의 기준을 되돌린 글로 옮긴다 */
  edited: AgentEditedParagraph[];
  undoEntry: object | null;
}

export class TasteSignalCollector {
  private readonly deps: TasteSignalCollectorDeps;
  private readonly rewrites: RewriteTracker;
  private readonly origins = new Map<string, SetOrigin>();
  /** 승인 직전 무효화로 빠진 op (set 별) — 그 op 은 사용자 편집이 덮었다 */
  private readonly droppedOps = new Map<string, Set<string>>();
  private records: WriteRecord[] = [];
  private recordSeq = 0;
  /** 요청(말풍선 turnKey)마다 그 턴이 시작될 때의 기록 순번 */
  private readonly turnKeys = new Map<string, { turnId: string | null; seq: number }>();
  private readonly unsubs: Array<() => void> = [];
  private documentInstance: number | undefined;

  constructor(deps: TasteSignalCollectorDeps) {
    this.deps = deps;
    this.documentInstance = deps.documentInstance?.();
    this.rewrites = new RewriteTracker({
      reader: deps.reader,
      caret: deps.caret,
      emit: (signal, threadId, source) => {
        this.send([signal], signal.turnId ?? null, threadId);
        if (source) this.observe((observer) => observer.rewritten(source));
      },
      focus: (agentText, userText) => focusPair(agentText, userText),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
      ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
    });
    this.unsubs.push(deps.pending.onChange((e) => this.onPendingChange(e)));
    // 키 입력마다 오므로 깃발만 세운다. 'agent-*' 는 어느 채팅의 매니저든 에이전트의 변이다.
    this.unsubs.push(deps.eventBus.on('document-mutated', (reason) => {
      if (typeof reason === 'string' && reason.startsWith('agent-')) this.rewrites.noteForeignEdit();
      else this.rewrites.noteUserEdit();
    }));
    this.unsubs.push(deps.eventBus.on('history-jumped', () => this.onHistoryJumped()));
    this.unsubs.push(deps.eventBus.on('document-swapped', () => this.syncDocument(true)));
    // 저장·이름 바꾸기도 이 이벤트를 낸다 — 문서가 정말 바뀌었을 때만 비운다.
    this.unsubs.push(deps.eventBus.on('document-context-changed', () => this.syncDocument(false)));
  }

  /** 지켜보는 문단 수 (테스트·진단용) */
  get trackedParagraphs(): number {
    return this.rewrites.size;
  }

  /** 고친 문단을 기다리지 않고 지금 낸다 (채팅을 닫기 전). */
  flush(): void {
    this.rewrites.flush();
  }

  /** 다음 에이전트 턴이 시작된다 — 고친 문단은 지금 내고 지켜보기를 그만둔다. */
  noteTurnStart(): void {
    this.rewrites.flush();
    this.rewrites.clear();
  }

  /**
   * 걷힌 요청 말풍선(fromKey)에 묶였던 턴이 남은 마지막 요청(toKey)으로 옮겨 갔다 (turnRestore.rebindTurn).
   * toKey 에 이미 턴이 있으면 그쪽이 더 이르다 — 그 순번이 옮겨 온 턴의 기록까지 덮는다.
   */
  noteTurnKeyRebound(threadId: string, fromKey: string, toKey: string | null): void {
    const turn = this.turnKeys.get(`${threadId}\u0000${fromKey}`);
    if (!turn) return;
    this.turnKeys.delete(`${threadId}\u0000${fromKey}`);
    if (toKey && !this.turnKeys.has(`${threadId}\u0000${toKey}`)) this.turnKeys.set(`${threadId}\u0000${toKey}`, turn);
  }

  /** 요청 말풍선(turnKey)이 지금 시작된 턴에 묶였다. */
  noteTurnKey(threadId: string, key: string | null): void {
    if (!key) return;
    this.turnKeys.set(`${threadId}\u0000${key}`, { turnId: this.deps.turnContext().turnId, seq: this.recordSeq });
    while (this.turnKeys.size > WRITE_RECORD_LIMIT) this.turnKeys.delete(this.turnKeys.keys().next().value!);
  }

  /** "이 작업 전으로 되돌리기" — 그 요청의 턴과 그 뒤 이 스레드의 에이전트 적용이 모두 되돌려졌다. */
  noteTurnRestored(threadId: string, key: string): void {
    this.rewrites.clear();
    const turn = this.turnKeys.get(`${threadId}\u0000${key}`);
    if (!turn) return;
    const undone = this.records.filter((record) => record.threadId === threadId && record.seq > turn.seq);
    if (undone.length === 0) return;
    this.records = this.records.filter((record) => !undone.includes(record));
    const byTurn = new Map<string | null, WriteRecord[]>();
    for (const record of undone) byTurn.set(record.turnId, [...(byTurn.get(record.turnId) ?? []), record]);
    for (const [turnId, records] of byTurn) this.sendUndone(records, threadId, turnId ?? turn.turnId);
  }

  reset(): void {
    this.rewrites.clear();
    this.origins.clear();
    this.droppedOps.clear();
    this.records = [];
    this.turnKeys.clear();
  }

  dispose(): void {
    for (const off of this.unsubs.splice(0)) off();
    this.reset();
  }

  private syncDocument(swapped: boolean): void {
    const current = this.deps.documentInstance?.();
    if (current === undefined) {
      if (swapped) this.reset();
      return;
    }
    if (current === this.documentInstance) return;
    this.documentInstance = current;
    this.reset();
  }

  private onPendingChange(e: PendingEditsChangeEvent): void {
    // 새 set 은 처음 보일 때의 턴에 묶는다 — 에이전트 모드의 승인은 턴이 끝난 뒤에 온다.
    for (const set of this.deps.pending.getChangeSets()) {
      if (!this.origins.has(set.id)) this.origins.set(set.id, { set, ...this.deps.turnContext() });
    }
    switch (e.type) {
      case 'invalidated':
        if (!e.changeSetId) break;
        if (e.droppedOpIds) {
          const dropped = this.droppedOps.get(e.changeSetId) ?? new Set<string>();
          for (const id of e.droppedOpIds) dropped.add(id);
          this.droppedOps.set(e.changeSetId, dropped);
        } else {
          this.forgetSet(e.changeSetId);
        }
        break;
      case 'approved':
        this.onApproved(e.changeSetId, e.direct === true);
        break;
      case 'rejected':
        this.onRejected(e.changeSetId);
        break;
      case 'ops-changed':
      case 'set-finalized': {
        const live = new Set(this.deps.pending.getChangeSets().map((set) => set.id));
        for (const id of this.origins.keys()) if (!live.has(id)) this.forgetSet(id);
        break;
      }
    }
  }

  private onApproved(changeSetId: string, direct: boolean): void {
    const origin = this.origins.get(changeSetId);
    const exclude = this.droppedOps.get(changeSetId);
    this.forgetSet(changeSetId);
    if (!origin) return;
    const ops = origin.set.ops;
    const turnId = origin.turnId ?? undefined;
    if (!direct) {
      this.send(outcomeSignals('accepted', ops, { at: this.isoNow(), turnId, reader: this.deps.reader, exclude }), origin.turnId, origin.threadId);
    }
    const paragraphs = writtenParagraphs(ops, { threadId: origin.threadId, turnId, reader: this.deps.reader, exclude });
    const tracked = this.rewrites.track(paragraphs);
    if (tracked.length > 0) {
      const written = tracked.map((handle) => this.rewrites.describe(handle)).filter((paragraph) => paragraph !== null);
      this.observe((observer) => observer.written(written));
    }
    // 앞선 쓰기의 출처 기록이 이 쓰기(글 없는 지우기 포함)를 사용자 고침으로 읽지 않게 기준을 옮긴다.
    const edited = editedParagraphs(ops, { reader: this.deps.reader, exclude });
    if (edited.length > 0) this.observe((observer) => observer.edited(edited));
    const texts = ops.filter((op): op is TextOp => (op.kind === 'insert' || op.kind === 'replace') && !exclude?.has(op.id))
      .map((op) => op.text.trim()).filter(Boolean);
    if (texts.length === 0 && edited.length === 0) return;
    const top = this.readHistory()?.peekUndoTop() ?? null;
    this.records.push({
      seq: ++this.recordSeq,
      threadId: origin.threadId,
      turnId: origin.turnId,
      texts,
      tracked,
      edited,
      undoEntry: top?.type === AGENT_APPLY_COMMAND ? top : null,
    });
    if (this.records.length > WRITE_RECORD_LIMIT) this.records.splice(0, this.records.length - WRITE_RECORD_LIMIT);
  }

  private onRejected(changeSetId: string): void {
    const origin = this.origins.get(changeSetId);
    const exclude = this.droppedOps.get(changeSetId);
    this.forgetSet(changeSetId);
    if (!origin) return;
    this.send(outcomeSignals('rejected', origin.set.ops, { at: this.isoNow(), turnId: origin.turnId ?? undefined, exclude }), origin.turnId, origin.threadId);
  }

  /** 실행 취소로 redo 스택에 넘어간 에이전트 적용을 되돌린 것으로 낸다. */
  private onHistoryJumped(): void {
    // 실행 취소·다시 실행은 사용자가 쓴 글이 아니다 — 고쳐 쓰기 기준만 다시 잡는다.
    this.rewrites.noteForeignEdit();
    const history = this.readHistory();
    if (!history) return;
    const undone = this.records.filter((record) => record.undoEntry && history.hasRedoEntry(record.undoEntry));
    if (undone.length === 0) return;
    this.records = this.records.filter((record) => !undone.includes(record));
    for (const record of undone) this.sendUndone([record], record.threadId, record.turnId);
  }

  private sendUndone(records: readonly WriteRecord[], threadId: string, turnId: string | null): void {
    for (const record of records) this.rewrites.untrack(record.tracked);
    this.observe((observer) => observer.undone(records.flatMap((record) => record.tracked)));
    // 되돌린 쓰기가 옮긴 기준을 되돌린 뒤 글로 다시 옮긴다.
    const reverted = records.flatMap((record) => record.edited)
      .filter((edit) => edit.text !== null)
      .map((edit) => ({ ref: edit.ref, before: edit.text!, text: this.readText(edit.ref) }));
    if (reverted.length > 0) this.observe((observer) => observer.edited(reverted));
    // 글 없는 쓰기(지우기)만 되돌렸으면 신호는 내지 않는다.
    if (records.every((record) => record.texts.length === 0)) return;
    const after = records.flatMap((record) => record.texts).join(' … ');
    this.send([{
      kind: 'undone',
      at: this.isoNow(),
      ...(after ? { after: clipText(after) } : {}),
      ...(turnId ? { turnId } : {}),
    }], turnId, threadId);
  }

  private send(signals: ReviewSignal[], turnId: string | null, threadId?: string): void {
    if (signals.length === 0) return;
    this.deps.emit(signals, { threadId: threadId ?? this.deps.turnContext().threadId, turnId });
  }

  private forgetSet(changeSetId: string): void {
    this.origins.delete(changeSetId);
    this.droppedOps.delete(changeSetId);
  }

  /** 출처 기록의 오류가 신호 모으기를 막지 않는다. */
  private observe(run: (observer: AgentWriteObserver) => void): void {
    if (!this.deps.observer) return;
    try {
      run(this.deps.observer);
    } catch (error) {
      console.warn('[taste] agent write observer failed:', error);
    }
  }

  private readText(ref: ParagraphRef): string | null {
    try {
      return this.deps.reader.text(ref);
    } catch {
      return null;
    }
  }

  private readHistory(): TasteUndoHistory | null {
    try {
      return this.deps.history?.() ?? null;
    } catch {
      return null;
    }
  }

  private isoNow(): string {
    return new Date(this.deps.now?.() ?? Date.now()).toISOString();
  }
}

/** WASM 으로 문단 글을 읽는다 (본문·셀·중첩 셀). */
export function wasmParagraphReader(wasm: {
  getParagraphCount(sec: number): number;
  getParagraphLength(sec: number, para: number): number;
  getTextRange(sec: number, para: number, offset: number, count: number): string;
  getCellParagraphCount(sec: number, parentPara: number, control: number, cell: number): number;
  getCellParagraphLength(sec: number, parentPara: number, control: number, cell: number, cellPara: number): number;
  getTextInCell(sec: number, parentPara: number, control: number, cell: number, cellPara: number, offset: number, count: number): string;
  getCellParagraphCountByPath(sec: number, parentPara: number, pathJson: string): number;
  getCellParagraphLengthByPath(sec: number, parentPara: number, pathJson: string): number;
  getTextInCellByPath(sec: number, parentPara: number, pathJson: string, offset: number, count: number): string;
}): ParagraphReader {
  const pathAt = (cell: NonNullable<ParagraphRef['cell']>, para: number) => JSON.stringify(cell.path!.map((entry, index) =>
    index === cell.path!.length - 1 ? { ...entry, cellParaIndex: para } : entry));
  return {
    count({ sectionIdx: sec, cell }) {
      if (!cell) return wasm.getParagraphCount(sec);
      return cell.path
        ? wasm.getCellParagraphCountByPath(sec, cell.paraIdx, pathAt(cell, 0))
        : wasm.getCellParagraphCount(sec, cell.paraIdx, cell.controlIdx, cell.cellIdx);
    },
    text({ sectionIdx: sec, cell, paraIdx: para }) {
      if (!cell) return wasm.getTextRange(sec, para, 0, wasm.getParagraphLength(sec, para));
      if (cell.path) {
        const path = pathAt(cell, para);
        return wasm.getTextInCellByPath(sec, cell.paraIdx, path, 0, wasm.getCellParagraphLengthByPath(sec, cell.paraIdx, path));
      }
      const length = wasm.getCellParagraphLength(sec, cell.paraIdx, cell.controlIdx, cell.cellIdx, para);
      return wasm.getTextInCell(sec, cell.paraIdx, cell.controlIdx, cell.cellIdx, para, 0, length);
    },
  };
}
