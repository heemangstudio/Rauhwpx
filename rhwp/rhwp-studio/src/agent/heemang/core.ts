/**
 * 에이전트 도구 엔진 — HeemangEngine 위에 에이전트 도구가 쓰던 문서 API 를 옮긴 바탕.
 *
 * 도구 실행기·대기 편집·검토 오버레이는 sectionIdx/paraIdx/charOffset 좌표와 셀 경로
 * (paraIdx·controlIdx·cellIdx, cellPath)로 문서를 읽고 쓴다. 여기서 그 좌표를 엔진 wire 주소
 * (UTF-16 offset, 컨트롤은 8 단위, 중첩 목록은 steps)로 바꾸고, 쓰기는 HeemangAdapter 의
 * 에이전트 구역(agentTransact 등)으로만 보낸다. 쓰기 한 번은 엔진 이력 한 단계이고, 그 번호를
 * stepLog 에 모아 대기 편집이 검토 승인(combineSteps)·거절(revertSteps)에 쓴다.
 *
 * 좌표 규칙 (RHWP TOOL RULES 와 같다):
 * - charOffset 은 문단 텍스트의 글자(유니코드 스칼라) 위치다. 인라인 개체(표·그림·수식 등)는
 *   자리를 차지하지 않는다.
 * - 개체 바로 앞 글자 위치에 넣는 글자는 개체 앞에 들어간다 (insertWire). 범위의 시작은 개체 뒤,
 *   끝은 개체 앞에 붙어 경계의 개체를 삼키지 않는다 (rangeWire).
 * - 논리 offset 은 인라인 개체를 한 글자로 센다 (구역·단 정의 같은 구조 컨트롤은 세지 않는다).
 *
 * 영역별 메서드는 이 클래스를 차례로 잇는 파일들(text.ts → format.ts → tables.ts → objects.ts →
 * document.ts → layout.ts)에 있고, index.ts 가 마지막 클래스를 Proxy 로 감싸 내놓는다.
 */
import { EngineNotSupportedError } from '../../core/engine-support.ts';
import { AgentToolError } from '../types.ts';
import type { HeemangAdapter } from '../../core/heemang-adapter.ts';
import type {
  Address, Capabilities, ControlInfo, EditOp, EngineErrorLike, HmDoc, ListAddress, ParagraphInfo, Receipt, Selection, Step,
} from './wire.ts';

/** rhwp 셀 경로 항목 — 바깥 표부터. 마지막 항목의 cellParaIndex 는 가장 안쪽 셀의 문단이다. */
export interface CellPathEntry { controlIndex: number; cellIndex: number; cellParaIndex: number }

/** 구조 컨트롤 — 편집 위치·논리 offset 에 들지 않는다. */
const STRUCTURAL_CONTROLS = new Set(['section', 'columns']);
/** rhwp 가 논리 offset 에서 한 글자로 세는 인라인 개체 */
const INLINE_CONTROLS = new Set(['table', 'picture', 'shape', 'equation', 'object', 'footnote', 'endnote', 'note', 'chart', 'ole', 'textBox', 'form']);

export function isStructuralControl(c: ControlInfo): boolean { return STRUCTURAL_CONTROLS.has(c.kind); }
export function isInlineControl(c: ControlInfo): boolean { return INLINE_CONTROLS.has(c.kind); }

/** 목록 주소의 캐시 키 */
export function listKey(section: number, steps?: readonly Step[]): string {
  return `${section}|${(steps ?? []).map((s) => `${s.para}.${s.control}.${s.index}`).join('/')}`;
}

export function copySteps(steps?: readonly Step[]): Step[] | undefined {
  return steps && steps.length > 0 ? steps.map((s) => ({ para: s.para, control: s.control, index: s.index })) : undefined;
}

/** 스칼라 위치 ↔ UTF-16 위치. 문단 텍스트는 대부분 BMP 라 빠른 길을 먼저 탄다. */
export function utf16Index(text: string, scalar: number): number {
  if (!/[\uD800-\uDBFF]/.test(text)) return Math.min(scalar, text.length);
  let i = 0;
  for (let k = 0; k < scalar && i < text.length; k++) {
    const c = text.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? 2 : 1;
  }
  return i;
}

export function scalarIndex(text: string, utf16: number): number {
  if (!/[\uD800-\uDBFF]/.test(text)) return Math.min(utf16, text.length);
  let k = 0;
  for (let i = 0; i < utf16 && i < text.length; k++) {
    const c = text.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? 2 : 1;
  }
  return k;
}

export function scalarLength(text: string): number { return scalarIndex(text, text.length); }

/** 엔진 오류 (wasm-bindgen EngineError) 인지 */
export function engineErrorOf(e: unknown): EngineErrorLike | null {
  if (e && typeof e === 'object' && typeof (e as EngineErrorLike).code === 'string' && typeof (e as EngineErrorLike).message === 'string') {
    return e as EngineErrorLike;
  }
  return null;
}

/** 엔진 오류를 도구 오류로 — 모델이 고칠 수 있는 것은 그 코드로, 나머지는 원문 그대로. */
export function toolErrorFromEngine(e: unknown, what: string): unknown {
  const err = engineErrorOf(e);
  if (!err) return e;
  switch (err.code) {
    case 'BAD_ADDRESS':
    case 'BAD_REQUEST':
      return new AgentToolError('INVALID_ARGS', `${what}: ${err.message}`);
    case 'STALE_EPOCH':
      return new AgentToolError('REVISION_MISMATCH', `${what}: the document changed while the edit was prepared; re-read and retry`);
    case 'COMPOSING':
      return new AgentToolError('USER_COMPOSING', 'The user is typing with an input method right now; retry in a moment.');
    case 'CLOSED':
      return new Error('문서가 로드되지 않았습니다');
    default:
      return new AgentToolError('RPC_ERROR', `${what}: ${err.code} ${err.message}`);
  }
}

export class HeemangAgentCore {
  readonly engineKind = 'heemang' as const;
  protected readonly adapter: HeemangAdapter;
  private readonly readCapabilities: () => Capabilities | null;
  private cachedCapabilities: Capabilities | null | undefined;
  private paraCache = new Map<string, ParagraphInfo[]>();
  private paraCacheEpoch = -1;
  private paraCacheInstance = -1;
  /** 에이전트 쓰기가 만든 엔진 이력 단계 — 대기 편집이 op 마다 가져간다. */
  private stepLog: number[] = [];
  /** 체크포인트별 그때의 stepLog 길이 — 복원하면 그 뒤 단계는 이력에서 사라진다. */
  private checkpointSteps = new Map<number, number>();

  constructor(adapter: HeemangAdapter, capabilities: () => Capabilities | null) {
    this.adapter = adapter;
    this.readCapabilities = capabilities;
  }

  // ─── 문서·상태 ───────────────────────────────────────────

  protected doc(): HmDoc { return this.adapter.agentDocument() as unknown as HmDoc; }

  /** 내용 epoch — 엔진이 문서를 바꿀 때마다 오른다. */
  protected epoch(): number { return this.adapter.state().contentEpoch; }

  get documentInstance(): number { return this.adapter.documentInstance; }
  get documentGeneration(): number { return this.adapter.documentGeneration; }
  get fileName(): string { return this.adapter.fileName; }
  set fileName(name: string) { this.adapter.fileName = name; }
  get documentDigest(): string | null { return this.adapter.documentDigest; }
  get currentFileHandle(): unknown { return this.adapter.currentFileHandle; }
  get pageCount(): number { return this.adapter.pageCount; }
  get readOnly(): boolean { return this.adapter.readOnly; }
  hasLoadedDocument(): boolean { return this.adapter.hasLoadedDocument(); }
  getSourceFormat(): string { return this.adapter.getSourceFormat(); }
  getSectionCount(): number { return this.adapter.getSectionCount(); }
  refreshLayout(): void { this.adapter.refreshLayout(); }

  capabilities(): Capabilities | null {
    if (this.cachedCapabilities === undefined) {
      try { this.cachedCapabilities = this.readCapabilities(); } catch { this.cachedCapabilities = null; }
    }
    return this.cachedCapabilities;
  }

  /** 엔진 빌드가 그 편집 op 을 갖췄는지 확인한다. 없으면 ENGINE_NOT_SUPPORTED. */
  protected requireOp(op: string, feature: string): void {
    const caps = this.capabilities();
    if (caps && !caps.ops.includes(op)) throw new EngineNotSupportedError(feature);
  }

  protected requireQuery(kind: string, feature: string): void {
    const caps = this.capabilities();
    if (caps && !caps.query.includes(kind)) throw new EngineNotSupportedError(feature);
  }

  protected json<T>(raw: string): T { return JSON.parse(raw) as T; }

  /** doc.query — 엔진 오류는 도구 오류로 바꾼다. */
  protected query<T>(request: Record<string, unknown>, what = 'query'): T {
    try {
      return this.json<T>(this.doc().query(JSON.stringify(request)));
    } catch (e) {
      throw toolErrorFromEngine(e, what);
    }
  }

  // ─── 문단 목록 ───────────────────────────────────────────

  /** 목록의 모든 문단 (내용 epoch 마다 다시 읽는다). 없는 목록이면 throw. */
  protected list(section: number, steps?: readonly Step[]): ParagraphInfo[] {
    const epoch = this.epoch();
    const instance = this.adapter.documentInstance;
    if (epoch !== this.paraCacheEpoch || instance !== this.paraCacheInstance) {
      this.paraCache.clear();
      this.paraCacheEpoch = epoch;
      this.paraCacheInstance = instance;
    }
    const key = listKey(section, steps);
    let paras = this.paraCache.get(key);
    if (!paras) {
      paras = [];
      const list: ListAddress = { section, ...(steps && steps.length ? { steps: copySteps(steps) } : {}) };
      for (;;) {
        const page = this.query<ParagraphInfo[]>({ kind: 'paragraphs', list, from: paras.length, count: 1024 }, 'paragraphs');
        paras.push(...page);
        if (page.length < 1024) break;
      }
      // 문단 텍스트의 wire offset 표가 없는 엔진 빌드로는 글자 좌표를 옮길 수 없다.
      if (paras.length > 0 && !Array.isArray(paras[0].offsets)) throw new EngineNotSupportedError('문단 글자 offset 표 (hm-wasm 갱신 필요)');
      this.paraCache.set(key, paras);
    }
    return paras;
  }

  /** 목록의 문단 하나. 범위를 벗어나면 rhwp 처럼 오류 문자열을 던진다. */
  protected para(section: number, para: number, steps?: readonly Step[]): ParagraphInfo {
    const paras = this.list(section, steps);
    const p = paras[para];
    if (!p) throw new Error(`인덱스 범위 초과: 문단 ${para} (목록에 ${paras.length}개)`);
    return p;
  }

  protected paraCount(section: number, steps?: readonly Step[]): number {
    return this.list(section, steps).length;
  }

  /** 문단의 글자 수 (스칼라) */
  protected paraLength(p: ParagraphInfo): number { return scalarLength(p.text); }

  /** 문단 텍스트의 글자 [from, from+count) */
  protected paraText(p: ParagraphInfo, from: number, count: number): string {
    const a = utf16Index(p.text, from);
    const b = utf16Index(p.text, from + Math.max(0, count));
    return p.text.slice(a, b);
  }

  // ─── offset 변환 ─────────────────────────────────────────

  /** 글자 k 의 wire offset — 글자 k 바로 앞 개체 뒤 (범위의 시작). k 가 길이면 문단 끝. */
  protected startWire(p: ParagraphInfo, k: number): number {
    return p.offsets[utf16Index(p.text, k)] ?? p.caret[1];
  }

  /** 글자 k 앞, 그 앞 개체 앞 — 넣기 위치와 범위의 끝. */
  protected insertWire(p: ParagraphInfo, k: number): number {
    const i = utf16Index(p.text, k);
    if (i === 0) return p.caret[0];
    // 앞 글자의 끝 — 탭처럼 여러 단위를 차지하는 글자도 있으니 다음 글자나 다음 컨트롤 중 앞선 곳.
    const prev = p.offsets[i - 1];
    let end = p.offsets[i] ?? p.caret[1];
    for (const c of p.controls) if (c.offset > prev && c.offset < end) end = c.offset;
    return end;
  }

  /** wire offset → 글자 위치 (그 offset 이후 첫 글자). */
  protected charAt(p: ParagraphInfo, wire: number): number {
    let i = p.offsets.findIndex((o) => o >= wire);
    if (i < 0 || i > p.text.length) i = p.text.length;
    return scalarIndex(p.text, i);
  }

  protected address(section: number, para: number, offset: number, steps?: readonly Step[]): Address {
    const s = copySteps(steps);
    return s ? { section, steps: s, para, offset } : { section, para, offset };
  }

  /** 넣기 주소 */
  protected insertAddress(section: number, para: number, charOffset: number, steps?: readonly Step[]): Address {
    const p = this.para(section, para, steps);
    this.checkOffset(p, charOffset);
    return this.address(section, para, this.insertWire(p, charOffset), steps);
  }

  /** 범위 [start, end) 의 주소 — 시작은 개체 뒤, 끝은 개체 앞. 같은 위치면 빈 범위. */
  protected rangeAddresses(
    section: number, startPara: number, startOffset: number, endPara: number, endOffset: number, steps?: readonly Step[],
  ): { from: Address; to: Address } {
    const a = this.para(section, startPara, steps);
    const b = this.para(section, endPara, steps);
    this.checkOffset(a, startOffset);
    this.checkOffset(b, endOffset);
    if (startPara === endPara && startOffset === endOffset) {
      const at = this.address(section, startPara, this.insertWire(a, startOffset), steps);
      return { from: at, to: at };
    }
    const from = this.address(section, startPara, this.startWire(a, startOffset), steps);
    let toWire = this.insertWire(b, endOffset);
    if (startPara === endPara && toWire < from.offset) toWire = from.offset;
    return { from, to: this.address(section, endPara, toWire, steps) };
  }

  protected checkOffset(p: ParagraphInfo, k: number): void {
    if (!Number.isInteger(k) || k < 0 || k > this.paraLength(p)) {
      throw new Error(`인덱스 범위 초과: 글자 ${k} (문단 ${p.index} 길이 ${this.paraLength(p)})`);
    }
  }

  /** 문단 앞쪽에서 인라인 개체를 한 글자로 센 논리 offset 목록 — 각 텍스트 글자의 논리 위치. */
  protected logicalOf(p: ParagraphInfo, k: number): number {
    const wire = this.insertWire(p, k);
    const before = p.controls.filter((c) => isInlineControl(c) && c.offset < wire).length;
    return k + before;
  }

  /** 논리 offset 의 wire 위치 — 글자와 인라인 개체를 wire 순서로 세어 logical 번째 칸 뒤. */
  protected logicalWire(p: ParagraphInfo, logical: number): number {
    if (logical <= 0) return p.caret[0];
    const ends: Array<[number, number]> = [];
    for (let k = 0; k < this.paraLength(p); k++) {
      const i = utf16Index(p.text, k);
      ends.push([p.offsets[i], this.insertWire(p, k + 1)]);
    }
    for (const c of p.controls) if (isInlineControl(c)) ends.push([c.offset, c.offset + 8]);
    ends.sort((x, y) => x[0] - y[0]);
    return ends[Math.min(logical, ends.length) - 1]?.[1] ?? p.caret[1];
  }

  protected textOfLogical(p: ParagraphInfo, logical: number): number {
    const inline = p.controls.filter(isInlineControl).sort((x, y) => x.offset - y.offset);
    let objects = 0;
    for (let k = 0; k <= this.paraLength(p); k++) {
      const wire = this.insertWire(p, k);
      while (objects < inline.length && inline[objects].offset < wire) objects++;
      if (k + objects >= logical) return k;
    }
    return this.paraLength(p);
  }

  // ─── 셀 경로 ─────────────────────────────────────────────

  /** 본문 표 셀 (parentPara, controlIdx, cellIdx) 의 목록 steps */
  protected cellSteps(parentPara: number, controlIdx: number, cellIdx: number, outer?: readonly Step[]): Step[] {
    return [...(outer ?? []).map((s) => ({ ...s })), { para: parentPara, control: controlIdx, index: cellIdx }];
  }

  /** rhwp 셀 경로 (JSON 문자열이나 배열) → 가장 안쪽 셀 목록 steps 와 그 안의 문단 */
  protected pathSteps(parentPara: number, path: string | readonly CellPathEntry[] | unknown): { steps: Step[]; para: number } {
    const entries = (typeof path === 'string' ? JSON.parse(path) : path) as CellPathEntry[];
    if (!Array.isArray(entries) || entries.length === 0) throw new Error('잘못된 셀 경로');
    const steps: Step[] = [];
    let host = parentPara;
    for (const entry of entries) {
      const control = entry.controlIndex;
      const index = entry.cellIndex;
      if (![control, index].every((n) => Number.isInteger(n) && n >= 0)) throw new Error('잘못된 셀 경로');
      steps.push({ para: host, control, index });
      host = entry.cellParaIndex ?? 0;
    }
    return { steps, para: host };
  }

  // ─── 쓰기 ────────────────────────────────────────────────

  /**
   * 엔진 편집 한 단계. 바뀐 것이 없으면 null. 엔진 오류는 도구 오류로 바꾸고 문서는 그대로다
   * (transact 는 모두 적용하거나 아무것도 적용하지 않는다).
   */
  protected transact(ops: EditOp[], what: string, selection?: Selection | null): Receipt | null {
    let receipt: Receipt | null;
    try {
      // 어댑터는 번들 엔진의 Selection 타입을 쓴다 — 같은 wire 모양이다.
      receipt = this.adapter.agentTransact(ops, selection as Parameters<HeemangAdapter['agentTransact']>[1]) as Receipt | null;
    } catch (e) {
      throw toolErrorFromEngine(e, what);
    }
    if (receipt) this.stepLog.push(receipt.historyId);
    return receipt;
  }

  /** 지난 drainSteps 뒤로 에이전트 쓰기가 만든 이력 단계 */
  drainSteps(): number[] {
    const steps = this.stepLog;
    this.stepLog = [];
    for (const [id] of this.checkpointSteps) this.checkpointSteps.set(id, 0);
    return steps;
  }

  /** 이 엔진 빌드가 검토용 이력 조작을 갖췄는가 */
  hasHistorySurgery(): boolean {
    const caps = this.capabilities();
    const doc = this.doc();
    return typeof doc.revertSteps === 'function' && typeof doc.combineSteps === 'function'
      && (!caps?.history || (caps.history.includes('revert') && caps.history.includes('combine')));
  }

  /** 이력 단계 되돌리기 — reverted 는 사라진 단계, kept 는 뒤 편집과 겹쳐 남긴 단계. */
  revertSteps(steps: number[]): { reverted: number[]; kept: number[] } {
    if (steps.length === 0) return { reverted: [], kept: [] };
    const result = this.json<{ reverted: number[]; kept: number[] }>(this.adapter.agentHistory('revertSteps', { steps }));
    return { reverted: result.reverted, kept: result.kept };
  }

  /** 이력 단계를 맨 위 한 단계로 합친다 — 내용은 그대로다. */
  combineSteps(steps: number[]): { combined: number[]; kept: number[]; historyId: number } {
    if (steps.length === 0) return { combined: [], kept: [], historyId: 0 };
    return this.json(this.adapter.agentHistory('combineSteps', { steps }));
  }

  // ─── 스냅샷 (체크포인트) ─────────────────────────────────

  /** 문서와 이력을 통째로 남긴다 — 원자 배치 롤백용. */
  saveSnapshot(): number {
    const id = this.adapter.agentCheckpoint();
    this.checkpointSteps.set(id, this.stepLog.length);
    return id;
  }

  /** 체크포인트의 문서와 이력으로 돌아간다. 그 뒤에 만든 이력 단계는 사라진다. */
  restoreSnapshot(id: number): void {
    this.adapter.agentRestore(id);
    const kept = this.checkpointSteps.get(id);
    if (kept !== undefined) this.stepLog.length = Math.min(this.stepLog.length, kept);
    this.paraCache.clear();
  }

  discardSnapshot(id: number): void {
    this.checkpointSteps.delete(id);
    this.adapter.agentReleaseCheckpoint(id);
  }
}
