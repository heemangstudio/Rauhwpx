/**
 * Studio 좌표와 HeemangEngine 주소 사이의 변환.
 *
 * Studio 캐럿 오프셋은 "논리 오프셋"이다: 글자(유니코드 scalar, 이모지 하나가 한 칸)와 글자처럼 취급하는 개체(표·그림·도형·수식)
 * 및 각주·미주를 한 칸씩 센다. 구역·단 정의, 필드 시작·끝, 책갈피, 떠 있는 개체 같은 나머지 컨트롤은
 * 칸을 차지하지 않는다. "텍스트 오프셋"은 글자만 센다. 엔진은 컨트롤이 8칸인 wire 오프셋을 쓴다.
 *
 * 셀 경로: Studio 의 [{controlIndex, cellIndex, cellParaIndex}…] 는 바깥 표부터 안쪽으로 내려가고
 * parentParaIndex 가 본문 문단이다. 엔진 steps[i] = {para: 앞 단계 문단, control, index: 셀}.
 */
import type { Address, ControlInfo, ParagraphInfo, Step } from '../../../vendor/hm-wasm/hm_wasm';
import type { CellPathEntry, DocumentPosition } from '../types';
import type { HmCore, ListAddress } from './core';

export interface ParaMap {
  info: ParagraphInfo;
  /** 논리 칸마다 시작 wire 오프셋. */
  stops: number[];
  /** 논리 칸마다 wire 폭(글자 1, 탭 8, 개체 8). */
  widths: number[];
  /** 논리 칸이 글자인지(false 면 개체). */
  isText: boolean[];
  /** 글자(유니코드 scalar) 수. */
  textLength: number;
  /** 글자마다 시작 wire 오프셋. 서로게이트 쌍은 wire 2칸이다. */
  textStops: number[];
  /** 글자마다 wire 폭(탭 8, 서로게이트 쌍 2, 나머지 1). */
  textWidths: number[];
  /** 글자마다 info.text 의 UTF-16 위치, 끝에 text.length. */
  textUnits: number[];
  /** 캐럿이 설 수 있는 첫 위치(구역·단 정의 뒤). */
  lead: number;
  /** 문단 끝 표시의 wire 오프셋. */
  end: number;
}

const maps = new WeakMap<ParagraphInfo, ParaMap>();

/** 캐럿이 한 칸으로 지나가는 컨트롤인가. */
export function isLogicalControl(control: ControlInfo): boolean {
  if (control.kind === 'footnote' || control.kind === 'endnote') return true;
  return (control.kind === 'table' || control.kind === 'object' || control.kind === 'equation') && control.inline === true;
}

export function paraMap(info: ParagraphInfo): ParaMap {
  let map = maps.get(info);
  if (map) return map;
  const utf16Length = Math.max(0, info.offsets.length - 1);
  const end = info.offsets[utf16Length] ?? Math.max(0, info.length - 1);
  const textStops: number[] = [];
  const textWidths: number[] = [];
  const textUnits: number[] = [];
  for (let u = 0; u < utf16Length;) {
    const code = info.text.codePointAt(u) ?? 0;
    const size = code > 0xffff ? 2 : 1;
    textStops.push(info.offsets[u]);
    textWidths.push(code === 9 ? 8 : size);
    textUnits.push(u);
    u += size;
  }
  textUnits.push(utf16Length);
  const textLength = textStops.length;
  const controls = info.controls.filter(isLogicalControl).map(control => control.offset);
  const stops: number[] = [];
  const widths: number[] = [];
  const isText: boolean[] = [];
  let c = 0;
  for (let t = 0; t < textLength; t++) {
    const wire = textStops[t];
    while (c < controls.length && controls[c] < wire) {
      stops.push(controls[c++]);
      widths.push(8);
      isText.push(false);
    }
    stops.push(wire);
    widths.push(textWidths[t]);
    isText.push(true);
  }
  while (c < controls.length && controls[c] < end) {
    stops.push(controls[c++]);
    widths.push(8);
    isText.push(false);
  }
  map = { info, stops, widths, isText, textLength, textStops, textWidths, textUnits, lead: info.caret[0], end };
  maps.set(info, map);
  return map;
}

/** sorted 에서 value 보다 작은 원소 수. */
function countBelow(sorted: readonly number[], value: number, limit = sorted.length): number {
  let lo = 0, hi = limit;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export const logicalLength = (map: ParaMap): number => map.stops.length;

/**
 * 논리 캐럿 위치의 wire 오프셋: 앞 칸 바로 뒤. 필드 시작·책갈피처럼 칸이 없는 컨트롤은 캐럿 뒤에 남아
 * 입력이 하이퍼링크 안으로 들어가지 않는다. 문단 처음은 구역·단 정의 뒤다.
 */
export function logicalToWire(map: ParaMap, logical: number): number {
  if (logical <= 0) return map.lead;
  const k = Math.min(logical, map.stops.length) - 1;
  return Math.min(map.stops[k] + map.widths[k], map.end);
}

/**
 * 캐럿 wire 위치 뒤에 붙은 필드 끝을 건너뛴 위치. 필드 끝은 컨트롤 목록에 없는 8칸짜리 wire 다.
 * 필드 시작·책갈피 같은 목록에 있는 컨트롤 앞에서는 멈춘다. 링크 끝에 넣는 각주가 링크 밖에 서게 한다.
 */
export function afterFieldEnds(map: ParaMap, wire: number): number {
  const next = map.stops.find(stop => stop >= wire) ?? map.end;
  const listed = new Set(map.info.controls.map(control => control.offset));
  let at = wire;
  while (at < next && !listed.has(at)) at += 8;
  return at <= next ? at : wire;
}

export function wireToLogical(map: ParaMap, wire: number): number {
  return countBelow(map.stops, wire);
}

/** 논리 범위 [from, to) 의 wire 범위. 칸 사이의 칸 없는 컨트롤은 범위가 그 양쪽 칸을 덮을 때만 지운다. */
export function logicalRangeToWire(map: ParaMap, from: number, to: number): [number, number] {
  const a = Math.max(0, Math.min(from, map.stops.length));
  const b = Math.max(a, Math.min(to, map.stops.length));
  if (a === b) {
    const at = logicalToWire(map, a);
    return [at, at];
  }
  return [map.stops[a], map.stops[b - 1] + map.widths[b - 1]];
}

/** 텍스트 오프셋의 삽입 위치: 앞 글자 바로 뒤(글자처럼 취급 개체 앞). */
export function textToWire(map: ParaMap, text: number): number {
  if (text <= 0) return map.lead;
  const k = Math.min(text, map.textLength) - 1;
  return map.textStops[k] + map.textWidths[k];
}

export function wireToText(map: ParaMap, wire: number): number {
  return countBelow(map.textStops, wire);
}

/** 텍스트 범위 [from, to) 의 wire 범위. */
export function textRangeToWire(map: ParaMap, from: number, to: number): [number, number] {
  const a = Math.max(0, Math.min(from, map.textLength));
  const b = Math.max(a, Math.min(to, map.textLength));
  if (a === b) {
    const at = textToWire(map, a);
    return [at, at];
  }
  return [map.textStops[a], map.textStops[b - 1] + map.textWidths[b - 1]];
}

export function logicalToText(map: ParaMap, logical: number): number {
  const limit = Math.max(0, Math.min(logical, map.stops.length));
  let count = 0;
  for (let i = 0; i < limit; i++) if (map.isText[i]) count++;
  return count;
}

export function textToLogical(map: ParaMap, text: number): number {
  if (text <= 0) return 0;
  return text >= map.textLength ? map.stops.length : wireToLogical(map, map.textStops[text]);
}

/** 텍스트 범위 [from, to) 의 글자. */
export function textSlice(map: ParaMap, from: number, to: number): string {
  const a = Math.max(0, Math.min(from, map.textLength));
  const b = Math.max(a, Math.min(to, map.textLength));
  return map.info.text.slice(map.textUnits[a], map.textUnits[b]);
}

/** 논리 범위 [from, to) 의 글자. 개체 칸은 건너뛴다. */
export function logicalText(map: ParaMap, from: number, to: number): string {
  return textSlice(map, logicalToText(map, from), logicalToText(map, Math.max(from, to)));
}

export function bodyList(section: number): ListAddress {
  return { section, steps: [] };
}

export function cellList(section: number, parentPara: number, control: number, cell: number): ListAddress {
  return { section, steps: [{ para: parentPara, control, index: cell }] };
}

export interface NormalizedPathEntry { control: number; cell: number; para: number }

type PathEntryLike = Partial<CellPathEntry> & { controlIdx?: number; cellIdx?: number; cellParaIdx?: number };

/** rhwp 경로 JSON 의 긴 키(controlIndex)와 짧은 키(controlIdx)를 모두 받는다. */
export function parsePath(path: string | readonly PathEntryLike[]): NormalizedPathEntry[] {
  const entries = (typeof path === 'string' ? JSON.parse(path || '[]') : path) as PathEntryLike[];
  if (!Array.isArray(entries)) throw new Error('잘못된 셀 경로');
  return entries.map(entry => ({
    control: Number(entry.controlIndex ?? entry.controlIdx ?? 0),
    cell: Number(entry.cellIndex ?? entry.cellIdx ?? 0),
    para: Number(entry.cellParaIndex ?? entry.cellParaIdx ?? 0),
  }));
}

/** 셀 경로가 가리키는 안쪽 목록과 그 목록의 문단. */
export function pathTarget(section: number, parentPara: number, path: string | readonly PathEntryLike[]): { list: ListAddress; para: number } {
  const entries = parsePath(path);
  if (!entries.length) return { list: bodyList(section), para: parentPara };
  const steps: Step[] = [];
  let para = parentPara;
  for (const entry of entries) {
    steps.push({ para, control: entry.control, index: entry.cell });
    para = entry.para;
  }
  return { list: { section, steps }, para };
}

/** 엔진 목록 경로를 Studio 셀 경로로 바꾼다. para 는 가장 안쪽 문단. */
export function stepsToPath(steps: readonly Step[], para: number): CellPathEntry[] {
  return steps.map((step, i) => ({
    controlIndex: step.control,
    cellIndex: step.index,
    cellParaIndex: i + 1 < steps.length ? steps[i + 1].para : para,
  }));
}

export function isCellPosition(pos: Pick<DocumentPosition, 'parentParaIndex'>): boolean {
  return pos.parentParaIndex !== undefined && pos.parentParaIndex !== null;
}

/** Studio 위치가 가리키는 목록과 문단. */
export function positionTarget(pos: DocumentPosition): { list: ListAddress; para: number } {
  if (!isCellPosition(pos)) return { list: bodyList(pos.sectionIndex), para: pos.paragraphIndex };
  if (pos.cellPath?.length) return pathTarget(pos.sectionIndex, pos.parentParaIndex!, pos.cellPath);
  return {
    list: cellList(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex ?? 0, pos.cellIndex ?? 0),
    para: pos.cellParaIndex ?? pos.paragraphIndex,
  };
}

export function toAddress(list: ListAddress, para: number, offset: number): Address {
  return list.steps.length ? { section: list.section, steps: list.steps, para, offset } : { section: list.section, para, offset };
}

/** 목록 문단의 논리 오프셋을 엔진 주소로. */
export function logicalAddress(core: HmCore, list: ListAddress, para: number, logical: number): Address {
  return toAddress(list, para, logicalToWire(paraMap(core.paragraph(list, para)), logical));
}

/** 목록 문단의 텍스트 오프셋을 엔진 주소로. */
export function textAddress(core: HmCore, list: ListAddress, para: number, text: number): Address {
  return toAddress(list, para, textToWire(paraMap(core.paragraph(list, para)), text));
}

export function positionToAddress(core: HmCore, pos: DocumentPosition): Address {
  const { list, para } = positionTarget(pos);
  return logicalAddress(core, list, para, pos.charOffset);
}

/** 엔진 주소의 첫 단계가 가리키는 컨트롤. */
function stepControl(core: HmCore, section: number, steps: readonly Step[], depth: number): ControlInfo | undefined {
  const parent: ListAddress = { section, steps: steps.slice(0, depth) };
  const step = steps[depth];
  return core.paragraph(parent, step.para).controls.find(control => control.index === step.control);
}

/** 엔진 주소를 Studio 위치로. 본문·셀·글상자만 다룬다(머리말·각주는 따로 다룬다). */
export function addressToPosition(core: HmCore, address: Address): DocumentPosition {
  const steps = address.steps ?? [];
  const list: ListAddress = { section: address.section, steps };
  const charOffset = wireToLogical(paraMap(core.paragraph(list, address.para)), address.offset);
  if (!steps.length) {
    return { sectionIndex: address.section, paragraphIndex: address.para, charOffset };
  }
  const cellPath = stepsToPath(steps, address.para);
  const outer = stepControl(core, address.section, steps, 0);
  const position: DocumentPosition = {
    sectionIndex: address.section,
    paragraphIndex: address.para,
    charOffset,
    parentParaIndex: steps[0].para,
    controlIndex: steps[0].control,
    cellIndex: steps[0].index,
    cellParaIndex: cellPath[0].cellParaIndex,
    cellPath,
  };
  if (outer && outer.kind !== 'table') position.isTextBox = true;
  return position;
}
