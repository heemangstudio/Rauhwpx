/**
 * 고쳐 쓰기 신호 — 에이전트가 쓴 문단을 사용자가 다시 고쳤는지 지켜본다.
 *
 * 승인했거나(에이전트 모드) 곧바로 반영된(전체 모드) 에이전트 글의 문단을 그때 내용·앞뒤 문단과 함께
 * 기억한다. 사용자 편집이 있으면 커서가 그 문단을 떠났을 때, 또는 5초 동안 편집이 없을 때 지금 내용과 견준다.
 *
 * 문단 다시 찾기:
 * - 내용이 그대로인 문단은 번호만 밀린 것이다 — 넓게 찾는다.
 * - 내용이 바뀐 문단은 문단 수 변화와 앞뒤 문단으로 자리를 확인한다. 문단 수가 그대로면 제자리,
 *   늘었으면 앞(제자리)이나 뒤(밀린 자리) 문단이 그대로인 자리, 줄었으면 앞·뒤 문단과 합친 흔적이
 *   있을 때만 받아들인다.
 *   그 밖에는 문단을 지운 것으로 보고 놓는다 — 닮은 이웃 문단을 고쳐 쓴 글로 잘못 잡지 않게.
 * - 문단을 나눴거나 합쳤으면 그 글로 한 번 견주고 놓는다.
 *
 * 다른 에이전트(같은 문서의 다른 채팅 포함)의 변이나 실행 취소·다시 실행은 고쳐 쓰기가 아니다 —
 * 내용이 그대로인 문단의 자리만 다시 잡고, 바뀐 문단은 누가 바꿨는지 알 수 없어 놓는다.
 *
 * 무엇을 고쳐 쓰기로 치는가:
 * - 공백만 바뀌었거나 한 글자만 고친 것(오타)은 사소한 수정이라 내지 않고 기준만 옮긴다.
 *   두 글자부터는 센다 — '합니다'→'한다' 같은 종결 어미 교체가 두 글자 편집이다.
 * - 에이전트가 쓴 구간 밖만 고쳤으면 에이전트 글을 고친 것이 아니다 (기준만 옮긴다).
 * - 지금 글이 에이전트가 바꾸기 전 글과 같으면 되돌린 것이다 (undone 이 맡는다).
 * - 닮은 정도(글자 bigram Dice)가 MIN_SIMILARITY 아래면 통째로 바꾼 것이라 내지 않는다.
 * 신호를 낸 문단은 더 지켜보지 않는다. 다음 에이전트 턴이 시작되거나, 10분이 지나거나,
 * 문서가 바뀌면 지켜보기를 그만둔다.
 *
 * node --test 가 그대로 읽도록 상대 경로 import 와 타입 import 만 쓴다.
 */
import type { DocumentPosition } from '../core/types.ts';
import type { CellAddr, ReviewSignal } from './types.ts';

/** 같은 문단으로 칠 최소 닮음. 이보다 낮으면 통째로 바꾼 것으로 본다. */
export const MIN_SIMILARITY = 0.25;
/** 사소한 수정으로 치는 최대 글자 편집 수 (공백 정규화 뒤). */
export const TRIVIAL_EDIT_CHARS = 1;
const IDLE_MS = 5_000;
const POLL_MS = 1_000;
const TTL_MS = 10 * 60_000;
/** 내용이 그대로인 문단을 찾는 범위 (원래 번호 ±) */
const EXACT_RADIUS = 64;
const MAX_TRACKED = 200;
/** 끝이 열린 구간 표시 (여러 문단에 걸친 삽입의 첫 문단). */
export const SPAN_END = Number.MAX_SAFE_INTEGER;

export interface ParagraphContainer {
  sectionIdx: number;
  /** 있으면 paraIdx 는 이 셀 안의 문단 번호다 */
  cell?: CellAddr;
}

export interface ParagraphRef extends ParagraphContainer {
  paraIdx: number;
}

/** 문단 글 읽기 — 브리지는 WASM 으로, 테스트는 배열로 채운다. */
export interface ParagraphReader {
  count(container: ParagraphContainer): number;
  text(ref: ParagraphRef): string | null;
}

export function containerKey(container: ParagraphContainer): string {
  const cell = container.cell;
  if (!cell) return `s${container.sectionIdx}`;
  const path = cell.path?.map((entry) => `${entry.controlIndex}.${entry.cellIndex}.${entry.cellParaIndex}`).join('/') ?? '';
  return `s${container.sectionIdx}:p${cell.paraIdx}:c${cell.controlIdx}:i${cell.cellIdx}:${path}`;
}

export function paragraphKey(ref: ParagraphRef): string {
  return `${containerKey(ref)}#${ref.paraIdx}`;
}

export function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 두 글의 편집 거리. limit 를 넘으면 limit + 1 을 돌려준다 (띠 안에서만 센다). */
export function editDistanceWithin(a: string, b: string, limit: number): number {
  const x = [...a];
  const y = [...b];
  if (Math.abs(x.length - y.length) > limit) return limit + 1;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const row = new Array<number>(y.length + 1).fill(limit + 1);
    row[0] = i;
    let best = row[0];
    const from = Math.max(1, i - limit);
    const to = Math.min(y.length, i + limit);
    for (let j = from; j <= to; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j - 1] + cost, (prev[j] ?? limit + 1) + 1, row[j - 1] + 1);
      if (row[j] < best) best = row[j];
    }
    if (best > limit) return limit + 1;
    prev = row;
  }
  return Math.min(prev[y.length], limit + 1);
}

function bigrams(text: string): Map<string, number> {
  const chars = [...text.replace(/\s+/g, '')];
  const grams = new Map<string, number>();
  for (let i = 0; i + 1 < chars.length; i++) {
    const gram = chars[i] + chars[i + 1];
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/** 글자 bigram Dice 계수 (0~1). 공백은 무시한다. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let total = 0;
  for (const n of ga.values()) total += n;
  for (const n of gb.values()) total += n;
  if (total === 0) return normalizeSpace(a) === normalizeSpace(b) ? 1 : 0;
  let shared = 0;
  for (const [gram, n] of ga) shared += Math.min(n, gb.get(gram) ?? 0);
  return (2 * shared) / total;
}

/** 두 글에서 바뀐 가운데 구간 — 앞뒤 공통 부분의 길이. */
export function changedRegion(a: string, b: string): { prefix: number; suffix: number } {
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { prefix, suffix };
}

export type RewriteVerdict = 'same' | 'reverted' | 'outside' | 'trivial' | 'replaced' | 'rewrite';

/**
 * 에이전트가 쓴 문단(agentText)이 지금 글(userText)로 바뀐 것을 어떻게 볼지 정한다.
 * spans 는 agentText 안에서 에이전트가 쓴 구간이다 (null = 문단 전체).
 */
export function classifyRewrite(
  agentText: string,
  userText: string,
  opts: { beforeText?: string; spans?: ReadonlyArray<readonly [number, number]> | null } = {},
): RewriteVerdict {
  if (agentText === userText) return 'same';
  const agent = normalizeSpace(agentText);
  const user = normalizeSpace(userText);
  if (opts.beforeText !== undefined && user === normalizeSpace(opts.beforeText)) return 'reverted';
  if (opts.spans && !touchesSpans(agentText, userText, opts.spans)) return 'outside';
  if (agent === user) return 'trivial';
  if (editDistanceWithin(agent, user, TRIVIAL_EDIT_CHARS) <= TRIVIAL_EDIT_CHARS) return 'trivial';
  if (!user || similarity(agent, user) < MIN_SIMILARITY) return 'replaced';
  return 'rewrite';
}

function touchesSpans(agentText: string, userText: string, spans: ReadonlyArray<readonly [number, number]>): boolean {
  const { prefix, suffix } = changedRegion(agentText, userText);
  const start = prefix;
  const end = agentText.length - suffix;
  return spans.some(([from, to]) => (start === end ? start >= from && start <= to : start < to && end > from));
}

/** 바뀐 구간 밖의 구간을 새 글 기준으로 옮긴다. */
export function shiftSpans(
  spans: ReadonlyArray<readonly [number, number]>, agentText: string, userText: string,
): Array<[number, number]> {
  const { prefix, suffix } = changedRegion(agentText, userText);
  const end = agentText.length - suffix;
  const delta = userText.length - agentText.length;
  const newEnd = userText.length - suffix;
  // 바뀐 구간 안에 걸친 끝점은 새 구간의 시작(from)·끝(to)으로 붙인다.
  const shift = (at: number, inside: number) => (at === SPAN_END || at <= prefix ? at : at >= end ? at + delta : inside);
  return spans.map(([from, to]) => [shift(from, prefix), shift(to, newEnd)]);
}

/** 커서가 이 문단 안에 있는가. 커서가 없으면(화면 밖 문서) false. */
export function caretInParagraph(caret: DocumentPosition | null, ref: ParagraphRef): boolean {
  if (!caret || caret.sectionIndex !== ref.sectionIdx) return false;
  const cell = ref.cell;
  if (!cell) return caret.cellIndex === undefined && !caret.isTextBox && caret.paragraphIndex === ref.paraIdx;
  return caret.parentParaIndex === cell.paraIdx
    && caret.controlIndex === cell.controlIdx
    && caret.cellIndex === cell.cellIdx
    && caret.cellParaIndex === ref.paraIdx;
}

export interface TrackParagraph {
  ref: ParagraphRef;
  /** 에이전트가 바꾸기 전 문단 글 (알 때만) */
  beforeText?: string;
  /** 문단 안에서 에이전트가 쓴 구간 (null·생략 = 문단 전체) */
  spans?: Array<[number, number]> | null;
  threadId?: string;
  turnId?: string;
}

/** track() 이 돌려주는 지켜보기 표 — untrack() 에 넘긴다. 문단 번호가 밀려도 그대로다. */
export type RewriteHandle = object;

/** 문단을 다시 찾는 기준 — 지켜보기와 기록에서 배우기(taste-history.ts)가 같이 쓴다. */
export interface ParagraphAnchor {
  ref: ParagraphRef;
  agentText: string;
  lastText: string;
  /** 마지막으로 확인했을 때의 앞·뒤 문단 글 (null = 칸의 처음·끝)과 칸의 문단 수 */
  prevText: string | null;
  nextText: string | null;
  count: number;
}

interface Tracked extends ParagraphAnchor {
  beforeText?: string;
  spans: Array<[number, number]> | null;
  threadId?: string;
  turnId?: string;
  trackedAt: number;
}

/** 지켜보기를 시작한 문단의 그때 모습 (handle 은 untrack·고쳐 쓰기 알림에 쓰는 같은 표). */
export interface TrackedParagraph extends ParagraphAnchor {
  handle: RewriteHandle;
  beforeText?: string;
  spans: Array<[number, number]> | null;
  threadId?: string;
  turnId?: string;
}

/** 고쳐 쓰기 신호를 낸 지켜보기와 그때의 글 (자르기 전). */
export interface RewriteSource {
  handle: RewriteHandle;
  agentText: string;
  userText: string;
}

/** 다시 찾은 문단. joined 면 나누거나 합친 문단이라 한 번 견주고 놓는다. */
export interface LocatedParagraph {
  paraIdx: number;
  text: string;
  joined?: boolean;
}
type Located = LocatedParagraph;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface RewriteTrackerDeps {
  reader: ParagraphReader;
  caret(): DocumentPosition | null;
  emit(signal: ReviewSignal, threadId?: string, source?: RewriteSource): void;
  /** 긴 두 글을 바뀐 곳 둘레로 줄인다 (보낼 글 길이 상한) */
  focus?(agentText: string, userText: string): [string, string];
  now?(): number;
  setTimer?(run: () => void, ms: number): TimerHandle;
  clearTimer?(handle: TimerHandle): void;
  idleMs?: number;
  pollMs?: number;
  ttlMs?: number;
}

export class RewriteTracker {
  private readonly deps: RewriteTrackerDeps;
  private readonly entries = new Set<Tracked>();
  /** 사용자 편집이 있었다 — 견줘야 한다 */
  private dirty = false;
  /** 다른 이의 변이가 있었다 — 기준을 다시 잡아야 한다 */
  private rebaseDue = false;
  private lastEditAt = 0;
  private timer: TimerHandle | null = null;
  private timerDueAt = 0;

  constructor(deps: RewriteTrackerDeps) {
    this.deps = deps;
  }

  get size(): number {
    return this.entries.size;
  }

  /** 에이전트가 방금 쓴 문단들을 지금 내용으로 기억한다. 같은 문단은 새 내용으로 바꾼다. */
  track(paragraphs: readonly TrackParagraph[]): RewriteHandle[] {
    const now = this.now();
    const handles: RewriteHandle[] = [];
    for (const paragraph of paragraphs) {
      const text = this.read(paragraph.ref);
      if (text === null || !text.trim()) continue;
      const key = paragraphKey(paragraph.ref);
      for (const entry of this.entries) if (paragraphKey(entry.ref) === key) this.entries.delete(entry);
      const entry: Tracked = {
        ref: cloneRef(paragraph.ref),
        agentText: text,
        lastText: text,
        prevText: null,
        nextText: null,
        count: 0,
        ...(paragraph.beforeText !== undefined ? { beforeText: paragraph.beforeText } : {}),
        spans: paragraph.spans ?? null,
        ...(paragraph.threadId ? { threadId: paragraph.threadId } : {}),
        ...(paragraph.turnId ? { turnId: paragraph.turnId } : {}),
        trackedAt: now,
      };
      this.settle(entry, paragraph.ref.paraIdx, text);
      this.entries.add(entry);
      handles.push(entry);
    }
    for (const entry of this.entries) {
      if (this.entries.size <= MAX_TRACKED) break;
      this.entries.delete(entry);
    }
    return handles;
  }

  /** track() 이 돌려준 지켜보기의 지금 모습. 이미 놓았으면 null. */
  describe(handle: RewriteHandle): TrackedParagraph | null {
    const entry = handle as Tracked;
    if (!this.entries.has(entry)) return null;
    return {
      handle,
      ref: cloneRef(entry.ref),
      agentText: entry.agentText,
      lastText: entry.lastText,
      prevText: entry.prevText,
      nextText: entry.nextText,
      count: entry.count,
      ...(entry.beforeText !== undefined ? { beforeText: entry.beforeText } : {}),
      spans: entry.spans ? entry.spans.map(([from, to]) => [from, to] as [number, number]) : null,
      ...(entry.threadId ? { threadId: entry.threadId } : {}),
      ...(entry.turnId ? { turnId: entry.turnId } : {}),
    };
  }

  /** 사용자(비-에이전트) 편집이 있었다. 깃발만 세운다 — 키 입력마다 문서를 읽지 않는다. */
  noteUserEdit(): void {
    if (this.entries.size === 0) return;
    this.dirty = true;
    this.lastEditAt = this.now();
    this.schedule(this.deps.pollMs ?? POLL_MS);
  }

  /**
   * 다른 에이전트의 변이·실행 취소처럼 사용자가 쓰지 않은 변경이 있었다. 곧 기준을 다시 잡는다
   * (몰려오는 변이는 한 번에). 그 전에 쌓인 사용자 편집은 누구 것인지 가릴 수 없어 함께 놓는다.
   */
  noteForeignEdit(): void {
    if (this.entries.size === 0) return;
    this.rebaseDue = true;
    this.schedule(0);
  }

  /** 기다리지 않고 지금 견준다 (다음 턴 직전) — 커서가 문단 안에 있어도 낸다. */
  flush(): void {
    if (this.rebaseDue) this.rebase();
    if (this.dirty) this.evaluateAll(true);
    this.dirty = false;
  }

  /** 주어진 지켜보기를 그만둔다 (되돌린 쓰기). 이미 놓은 것은 건너뛴다. */
  untrack(handles: readonly RewriteHandle[]): void {
    for (const handle of handles) this.entries.delete(handle as Tracked);
    if (this.entries.size === 0) this.stop();
  }

  clear(): void {
    this.entries.clear();
    this.dirty = false;
    this.rebaseDue = false;
    this.stop();
  }

  dispose(): void {
    this.clear();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private schedule(ms: number): void {
    const due = this.now() + ms;
    if (this.timer !== null) {
      if (this.timerDueAt <= due) return;
      this.stop();
    }
    const set = this.deps.setTimer ?? ((run, delay) => setTimeout(run, delay));
    this.timerDueAt = due;
    this.timer = set(() => {
      this.timer = null;
      this.tick();
    }, ms);
  }

  private stop(): void {
    if (this.timer === null) return;
    (this.deps.clearTimer ?? clearTimeout)(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (this.rebaseDue) this.rebase();
    if (!this.dirty || this.entries.size === 0) {
      this.dirty = false;
      return;
    }
    const idle = this.now() - this.lastEditAt >= (this.deps.idleMs ?? IDLE_MS);
    const waiting = this.evaluateAll(idle);
    if (idle || !waiting) this.dirty = false;
    else this.schedule(this.deps.pollMs ?? POLL_MS);
  }

  /** 내용이 그대로인 문단은 자리만 다시 잡고, 바뀐 문단은 놓는다. 쌓인 사용자 편집도 여기서 끝난다. */
  private rebase(): void {
    this.rebaseDue = false;
    this.dirty = false;
    for (const entry of [...this.entries]) {
      const found = this.locateExact(entry, this.count(entry.ref));
      if (found) this.settle(entry, found.paraIdx, found.text);
      else this.entries.delete(entry);
    }
    if (this.entries.size === 0) this.stop();
  }

  /** 모든 기억을 견준다. 커서가 아직 머문 고친 문단이 있으면 true. */
  private evaluateAll(force: boolean): boolean {
    const now = this.now();
    const ttl = this.deps.ttlMs ?? TTL_MS;
    const caret = force ? null : this.deps.caret();
    let waiting = false;
    for (const entry of [...this.entries]) {
      if (now - entry.trackedAt > ttl) {
        this.entries.delete(entry);
        continue;
      }
      const found = this.locate(entry);
      if (!found) {
        this.entries.delete(entry);
        continue;
      }
      if (found.text === entry.agentText && !found.joined) {
        this.settle(entry, found.paraIdx, found.text);
        continue;
      }
      const at = { ...entry.ref, paraIdx: found.paraIdx };
      if (!force && (caretInParagraph(caret, at) || (found.joined && caretInParagraph(caret, { ...at, paraIdx: at.paraIdx + 1 })))) {
        // 아직 고치는 중이다 — 자리·기준은 그대로 두고 다음에 다시 찾는다.
        waiting = true;
        continue;
      }
      const verdict = classifyRewrite(entry.agentText, found.text, entry);
      if (!found.joined && (verdict === 'outside' || verdict === 'trivial')) {
        // 에이전트 글은 그대로다 — 기준을 지금 글로 옮겨 다음 고쳐 쓰기와 견준다.
        if (entry.spans) entry.spans = shiftSpans(entry.spans, entry.agentText, found.text);
        entry.agentText = found.text;
        this.settle(entry, found.paraIdx, found.text);
        continue;
      }
      this.entries.delete(entry);
      if (verdict !== 'rewrite') continue;
      const [after, userText] = this.deps.focus?.(entry.agentText, found.text) ?? [entry.agentText, found.text];
      this.deps.emit({
        kind: 'rewritten',
        at: new Date(now).toISOString(),
        after,
        userText,
        ...(entry.ref.cell ? {} : { paraIdx: found.paraIdx }),
        ...(entry.turnId ? { turnId: entry.turnId } : {}),
      }, entry.threadId, { handle: entry, agentText: entry.agentText, userText: found.text });
    }
    if (this.entries.size === 0) this.stop();
    return waiting;
  }

  /** 찾은 자리와 글, 그 앞뒤 문단을 새 기준으로 적어 둔다. */
  private settle(entry: Tracked, paraIdx: number, text: string): void {
    settleAnchor(entry, this.deps.reader, paraIdx, text);
  }

  private locateExact(entry: Tracked, count: number): Located | null {
    return locateExactParagraph(entry, this.deps.reader, count);
  }

  private locate(entry: Tracked): Located | null {
    return locateParagraph(entry, this.deps.reader);
  }

  private count(container: ParagraphContainer): number {
    return safeCount(this.deps.reader, container);
  }

  private read(ref: ParagraphRef): string | null {
    return safeRead(this.deps.reader, ref);
  }
}

function safeCount(reader: ParagraphReader, container: ParagraphContainer): number {
  try {
    return reader.count(container);
  } catch {
    return 0;
  }
}

function safeRead(reader: ParagraphReader, ref: ParagraphRef): string | null {
  try {
    return reader.text(ref);
  } catch {
    return null;
  }
}

/** 찾은 자리와 글, 그 앞뒤 문단을 기준에 적어 둔다. */
export function settleAnchor(anchor: ParagraphAnchor, reader: ParagraphReader, paraIdx: number, text: string): void {
  const count = safeCount(reader, anchor.ref);
  const at = (index: number) => (index >= 0 && index < count ? safeRead(reader, { ...anchor.ref, paraIdx: index }) : null);
  anchor.ref = { ...anchor.ref, paraIdx };
  anchor.lastText = text;
  anchor.prevText = at(paraIdx - 1);
  anchor.nextText = at(paraIdx + 1);
  anchor.count = count;
}

/** 내용이 그대로인(마지막으로 본 글이나 기준 글) 문단을 원래 번호 가까이에서 찾는다. */
export function locateExactParagraph(
  anchor: ParagraphAnchor, reader: ParagraphReader, count = safeCount(reader, anchor.ref),
): LocatedParagraph | null {
  const origin = anchor.ref.paraIdx;
  for (let d = 0; d <= EXACT_RADIUS; d++) {
    for (const paraIdx of d === 0 ? [origin] : [origin - d, origin + d]) {
      if (paraIdx < 0 || paraIdx >= count) continue;
      const text = safeRead(reader, { ...anchor.ref, paraIdx });
      if (text !== null && (text === anchor.lastText || text === anchor.agentText)) return { paraIdx, text };
    }
  }
  return null;
}

/** 기억한 문단을 지금 문서에서 찾는다. 지웠거나 자리를 확인할 수 없으면 null. */
export function locateParagraph(anchor: ParagraphAnchor, reader: ParagraphReader): LocatedParagraph | null {
  const count = safeCount(reader, anchor.ref);
  const exact = locateExactParagraph(anchor, reader, count);
  if (exact) return exact;
  const origin = anchor.ref.paraIdx;
  const at = (index: number) => (index >= 0 && index < count ? safeRead(reader, { ...anchor.ref, paraIdx: index }) : null);
  const prevOk = (index: number) => at(index - 1) === anchor.prevText;
  const nextOk = (index: number) => at(index + 1) === anchor.nextText;
  const close = (text: string) =>
    Math.max(similarity(text, anchor.lastText), similarity(text, anchor.agentText)) >= MIN_SIMILARITY;
  const delta = count - anchor.count;

  if (delta === 0) {
    // 문단 수가 그대로다 — 제자리에서 고쳤다 (앞뒤 문단 하나는 그대로여야 한다).
    const own = at(origin);
    return own !== null && (prevOk(origin) || nextOk(origin)) && close(own) ? { paraIdx: origin, text: own } : null;
  }
  if (delta > 0) {
    // 문단을 나눴다 — 원래 자리와 다음 문단이 기준 글의 앞·뒤 조각이다.
    const head = at(origin);
    const tail = at(origin + 1);
    if (delta === 1 && head !== null && tail !== null && prevOk(origin) && nextOk(origin + 1)
      && (anchor.lastText.startsWith(head) || anchor.lastText.endsWith(tail))) {
      return { paraIdx: origin, text: `${head}\n${tail}`, joined: true };
    }
    // 뒤에 문단이 늘었으면 제자리(앞 문단이 그대로), 앞에 늘었으면 그만큼 밀린 자리(뒤 문단이 그대로)다.
    const own = at(origin);
    if (own !== null && prevOk(origin) && close(own)) return { paraIdx: origin, text: own };
    const shifted = at(origin + delta);
    if (shifted !== null && nextOk(origin + delta) && close(shifted)) return { paraIdx: origin + delta, text: shifted };
    return null;
  }
  if (delta === -1) {
    // 앞 문단과 합쳤다 (문단 첫머리에서 Backspace) — 합친 문단이 앞 문단 글로 시작한다.
    const merged = at(origin - 1);
    if (anchor.prevText && merged !== null && merged.startsWith(anchor.prevText) && nextOk(origin - 1)) {
      const text = merged.slice(anchor.prevText.length);
      if (text.trim() && close(text)) return { paraIdx: origin - 1, text, joined: true };
    }
    // 뒤 문단을 끌어왔다 (문단 끝에서 Delete) — 이 문단이 뒤 문단 글로 끝난다.
    const pulled = at(origin);
    if (anchor.nextText && pulled !== null && pulled.endsWith(anchor.nextText) && prevOk(origin)) {
      const text = pulled.slice(0, pulled.length - anchor.nextText.length);
      if (text.trim() && close(text)) return { paraIdx: origin, text, joined: true };
    }
  }
  // 문단이 줄었는데 합친 흔적이 없다 — 지웠다.
  return null;
}

function cloneRef(ref: ParagraphRef): ParagraphRef {
  return { sectionIdx: ref.sectionIdx, paraIdx: ref.paraIdx, ...(ref.cell ? { cell: structuredClone(ref.cell) } : {}) };
}
