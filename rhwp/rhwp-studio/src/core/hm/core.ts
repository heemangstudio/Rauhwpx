/**
 * WasmBridge 위임부의 공통 상태와 저수준 엔진 호출.
 *
 * 브리지의 공개 API는 기존 Studio 좌표(구역·문단·캐럿 논리 오프셋, 셀 경로)를 쓰고, HeemangEngine은
 * 목록 경로(steps)와 wire 오프셋을 쓴다. 변환은 address.ts, 엔진 호출과 캐시는 여기서 맡는다.
 * 문서 내용을 바꾸는 호출은 모두 transact/mutate 를 거쳐 캐시·쪽 packet·화면 갱신 정보를 함께 맞춘다.
 */
import type {
  Address, Affinity, Caret, Doc, EditOp, LineInfo as HmLineInfo, Located, ParagraphInfo, Receipt, Step, TableAddress, TableInfo,
} from '../../../vendor/hm-wasm/hm_wasm';
import { EngineNotSupportedError } from '../engine-support';
import type { HeemangAdapter } from '../heemang-adapter';

/** 쪽 좌표: HU(1/7200 inch) ÷ 75 = 96 DPI px. */
export const HU_PER_PX = 75;
export const px = (hu: number): number => hu / HU_PER_PX;
/** 개체·표 상자처럼 에이전트에게도 보이는 값은 구 엔진처럼 0.1px 로 반올림한다. */
export const px1 = (hu: number): number => Math.round(hu / HU_PER_PX * 10) / 10;
export const hu = (value: number): number => Math.round(value * HU_PER_PX);

export function unsupported(operation: string): EngineNotSupportedError {
  return new EngineNotSupportedError(operation);
}

export interface ListAddress { section: number; steps: Step[] }

/** hm-wasm EngineError 는 Error 가 아니다. 호출부가 message·code 를 읽도록 Error 로 바꾼다. */
export function engineError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const code = 'code' in error ? String((error as { code: unknown }).code) : 'ENGINE_ERROR';
    const message = String((error as { message: unknown }).message);
    return Object.assign(new Error(`${code}: ${message}`), { code });
  }
  return new Error(String(error));
}

export function listKey(list: ListAddress): string {
  let key = String(list.section);
  for (const step of list.steps) key += `/${step.para}.${step.control}.${step.index}`;
  return key;
}

export class HmCore {
  /** 문서 내용이 바뀔 때마다 오른다. 문단 정보 캐시의 키다. */
  private revision = 0;
  private cacheTag = '';
  private readonly paras = new Map<string, ParagraphInfo>();
  private readonly counts = new Map<string, number>();
  private readonly lineCache = new Map<string, HmLineInfo[]>();
  private lineTag = '';
  private readonly tables = new Map<string, TableInfo>();
  private tableTag = '';
  /** 마지막 편집 영수증. 화면은 바뀐 쪽만 다시 그린다. */
  lastReceipt: Receipt | null = null;

  constructor(readonly adapter: HeemangAdapter) {}

  get doc(): Doc { return this.adapter.hmDoc(); }
  hasDocument(): boolean { return this.adapter.hasLoadedDocument(); }

  /** 엔진 호출을 감싸 EngineError 를 Error 로 바꾼다. */
  call<T>(run: (doc: Doc) => T): T {
    const doc = this.doc;
    try {
      return run(doc);
    } catch (error) {
      throw engineError(error);
    }
  }

  private validate(): void {
    const tag = `${this.adapter.documentInstance}:${this.revision}`;
    if (tag === this.cacheTag) return;
    this.cacheTag = tag;
    this.paras.clear();
    this.counts.clear();
  }

  /** 내용이 바뀐 뒤 캐시와 쪽 packet 을 맞춘다. 영수증이 없으면(복원 등) 모두 다시 그린다. */
  noteMutation(receipt: Receipt | null): void {
    this.revision += 1;
    this.lineCache.clear();
    this.tables.clear();
    if (receipt) {
      this.adapter.applyReceipt(receipt);
      this.lastReceipt = receipt;
    } else {
      this.adapter.refreshLayout();
      this.lastReceipt = null;
    }
  }

  /** 문서를 새로 들였다. */
  noteDocumentReplaced(): void {
    this.revision += 1;
    this.lineCache.clear();
    this.tables.clear();
    this.lastReceipt = null;
  }

  query<T>(request: object): T {
    return JSON.parse(this.call(doc => doc.query(JSON.stringify(request)))) as T;
  }

  /** 내부 읽기 전용 표 정보. 내용·조판·글꼴이나 문서가 바뀌면 셀 경로와 상자도 다시 읽는다. */
  tableInfo(table: TableAddress, page?: number): TableInfo {
    const state = this.state();
    const tag = `${this.adapter.documentInstance}:${state.contentEpoch}:${state.layoutEpoch}:${state.fontGeneration}`;
    if (tag !== this.tableTag) {
      this.tableTag = tag;
      this.tables.clear();
    }
    const key = JSON.stringify([table.section, table.steps ?? [], table.para, table.control, page ?? null]);
    let info = this.tables.get(key);
    if (!info) {
      info = this.query<TableInfo>({ kind: 'table', table, ...(page === undefined ? {} : { page }) });
      this.tables.set(key, info);
      if (this.tables.size > 64) this.tables.delete(this.tables.keys().next().value!);
    }
    return info;
  }

  paragraph(list: ListAddress, para: number): ParagraphInfo {
    this.validate();
    const key = `${listKey(list)}#${para}`;
    let info = this.paras.get(key);
    if (!info) {
      const found = this.query<ParagraphInfo[]>({ kind: 'paragraphs', list, from: para, count: 1 })[0];
      if (!found) throw Object.assign(new RangeError(`문단 인덱스 ${para} 범위 초과`), { code: 'BAD_ADDRESS' });
      info = found;
      this.paras.set(key, info);
    }
    return info;
  }

  /** 목록의 문단 수. 엔진 query 는 범위를 잘라 주므로 끝에서 하나를 물어 센다. */
  paragraphCount(list: ListAddress): number {
    this.validate();
    const key = listKey(list);
    const cached = this.counts.get(key);
    if (cached !== undefined) return cached;
    let count = 0;
    for (;;) {
      const page = this.query<ParagraphInfo[]>({ kind: 'paragraphs', list, from: count, count: 4096 });
      for (const info of page) this.paras.set(`${key}#${info.index}`, info);
      count += page.length;
      if (page.length < 4096) break;
    }
    this.counts.set(key, count);
    return count;
  }

  /** 문단의 조판된 줄. 레이아웃이 바뀌면 다시 읽는다. */
  lines(list: ListAddress, para: number): HmLineInfo[] {
    const state = this.state();
    const tag = `${this.adapter.documentInstance}:${state.layoutEpoch}`;
    if (tag !== this.lineTag) {
      this.lineTag = tag;
      this.lineCache.clear();
    }
    const key = `${listKey(list)}#${para}`;
    let lines = this.lineCache.get(key);
    if (!lines) {
      lines = this.query<HmLineInfo[]>({ kind: 'lines', list, para });
      this.lineCache.set(key, lines);
    }
    return lines;
  }

  state(): { contentEpoch: number; layoutEpoch: number; pageCount: number; undo: number; redo: number; dirty: boolean; format: string; fontGeneration: number } {
    return JSON.parse(this.call(doc => doc.state()));
  }

  /** 편집 묶음을 한 엔진 트랜잭션으로 적용한다. 바뀐 것이 없으면 null. */
  transact(ops: EditOp[]): Receipt | null {
    if (!ops.length) return null;
    const before = this.state().contentEpoch;
    const receipt = JSON.parse(this.call(doc => doc.transact(JSON.stringify({ ops })))) as Receipt;
    if (receipt.contentEpoch === before) return null;
    this.noteMutation(receipt);
    return receipt;
  }

  /** transact 외의 내용 변경 호출(paste·undo·restore 등). 영수증 JSON 을 받아 캐시를 맞춘다. */
  mutate(run: (doc: Doc) => string): Receipt | null {
    const raw = this.call(run);
    const receipt = raw && raw !== 'null' ? JSON.parse(raw) as Receipt : null;
    this.noteMutation(receipt);
    return receipt;
  }

  caret(position: Address, affinity: Affinity = 'downstream', page?: number): Caret | null {
    const request: Record<string, unknown> = { kind: 'caret', position, affinity };
    if (page !== undefined && page >= 0) request.page = page;
    return JSON.parse(this.call(doc => doc.locate(JSON.stringify(request)))) as Caret | null;
  }

  /** 쪽 px 좌표의 위치. body 면 머리말·꼬리말·주석을 뺀다. */
  locate(page: number, xPx: number, yPx: number, scope: { body?: boolean; within?: ListAddress } = {}): Located | null {
    return JSON.parse(this.call(doc => doc.locate(JSON.stringify({
      kind: 'point', page, x: hu(xPx), y: hu(yPx), ...scope,
    })))) as Located | null;
  }
}
