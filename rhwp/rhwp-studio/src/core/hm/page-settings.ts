import type { Address, EditOp, PageInfo as HmPage } from '../../../vendor/hm-wasm/hm_wasm';
import { pageDef } from '../heemang-format';
import type { HmCore } from './core';
import { unsupported } from './core';
import { bodyList, logicalAddress } from './address';
import { extendBridge } from './api';
import type { PageBorderFillSettings, PageDef, SectionDef } from './bridge-types';
import type { BorderLineProps } from '../types';
import { colorToHex, hexToColor } from './format';

type PagePatch = Partial<Omit<PageDef, 'marginGutter'>> & { gutter?: number };
type SectionPatch = {
  attr?: number; columnGap?: number; tabStop?: number; pageNumber?: number;
  figureNumber?: number; tableNumber?: number; equationNumber?: number;
};
type Line = { kind: number; width: number; color: number };
type PageFill = { kind: 'none' } | { kind: 'solid'; color: number; patternColor: number; pattern: number } | { kind: 'gradient' | 'image' };
interface PageBorder { attr: number; offsets: [number, number, number, number]; borderFill: number; lines: Line[]; fill: PageFill }
interface Settings {
  page: Required<PagePatch> | null;
  pageBorders: PageBorder[];
  settings: Required<SectionPatch> | null;
  columns: { count: number; kind: number; equalWidths: boolean; gap: number; columns?: [number, number][] } | null;
}
type ColumnPatch = { count: number; kind: number; equalWidths: boolean; gap: number; columns?: [number, number][] };
type PageOp =
  | { op: 'setPageSettings'; section: number; patch: PagePatch }
  | { op: 'setSectionSettings'; section: number; patch: SectionPatch }
  | { op: 'setColumns'; at: Address; patch: ColumnPatch }
  | { op: 'setPageHide'; at: Address; flags: number }
  | { op: 'setPageBorder'; section: number; side: 'both'; patch: { attr?: number; offsets?: number[]; borderFill?: number; lines?: Line[]; fill?: PageFill } }
  | { op: 'columnBreak'; at: Address }
  | { op: 'insertNewNumber'; at: Address; number: number };

// 새 엔진 스키마는 vendor 재생성 전까지 이 경계에서만 형변환한다.
const apply = (core: HmCore, ops: PageOp[]) => core.transact(ops as unknown as EditOp[]);
const settings = (core: HmCore, section: number) => core.query<Settings>({ kind: 'sectionSettings', section });
const result = (core: HmCore) => ({ ok: true, pageCount: core.state().pageCount });
const sections = (core: HmCore) => core.query<{ sectionCount: number }>({ kind: 'documentProperties' }).sectionCount;

export function getPageDef(core: HmCore, sectionIdx: number): PageDef {
  const page = settings(core, sectionIdx).page;
  if (page) {
    const { gutter, ...rest } = page;
    return { ...rest, marginGutter: gutter };
  }
  // 구역 설정에 용지 정의가 없으면 그 구역 첫 쪽의 배치 결과로 채운다.
  const laid = (JSON.parse(core.call(doc => doc.pages())) as HmPage[]).find(item => item.section === sectionIdx);
  if (!laid) throw new RangeError(`구역 ${sectionIdx} 이 없습니다`);
  return pageDef(laid);
}

function pagePatch({ marginGutter, ...rest }: Partial<PageDef>): PagePatch {
  return { ...rest, ...(marginGutter === undefined ? {} : { gutter: marginGutter }) };
}

export function setPageDef(core: HmCore, sectionIdx: number, pageDef: PageDef): { ok: boolean; pageCount: number } {
  apply(core, [{ op: 'setPageSettings', section: sectionIdx, patch: pagePatch(pageDef) }]);
  return result(core);
}

export function setPageDefAll(core: HmCore, patch: Partial<PageDef>): { ok: boolean; pageCount: number } {
  apply(core, Array.from({ length: sections(core) }, (_, section) => ({ op: 'setPageSettings', section, patch: pagePatch(patch) })));
  return result(core);
}

export function getSectionDef(core: HmCore, sectionIdx: number): SectionDef {
  const value = settings(core, sectionIdx).settings;
  if (!value) throw unsupported('getSectionDef');
  const attr = value.attr;
  return {
    pageNum: value.pageNumber, pageNumType: (attr >>> 20) & 3,
    pictureNum: value.figureNumber, tableNum: value.tableNumber, equationNum: value.equationNumber,
    columnSpacing: value.columnGap, defaultTabSpacing: value.tabStop,
    hideHeader: !!(attr & 1), hideFooter: !!(attr & 2), hideMasterPage: !!(attr & 4),
    hideBorder: !!(attr & 8), hideFill: !!(attr & 16), hideEmptyLine: !!(attr & (1 << 19)),
  };
}

function sectionPatch(core: HmCore, section: number, value: SectionDef): SectionPatch {
  const current = settings(core, section).settings;
  if (!current) throw unsupported('setSectionDef');
  const mask = 31 | (1 << 19) | (3 << 20);
  const flags = Number(value.hideHeader) | (Number(value.hideFooter) << 1)
    | (Number(value.hideMasterPage) << 2) | (Number(value.hideBorder) << 3)
    | (Number(value.hideFill) << 4) | (Number(value.hideEmptyLine) << 19) | ((value.pageNumType & 3) << 20);
  return {
    attr: ((current.attr & ~mask) | flags) >>> 0, pageNumber: value.pageNum,
    figureNumber: value.pictureNum, tableNumber: value.tableNum, equationNumber: value.equationNum,
    columnGap: value.columnSpacing, tabStop: value.defaultTabSpacing,
  };
}

export function setSectionDef(core: HmCore, sectionIdx: number, sectionDef: SectionDef): { ok: boolean; pageCount: number } {
  apply(core, [{ op: 'setSectionSettings', section: sectionIdx, patch: sectionPatch(core, sectionIdx, sectionDef) }]);
  return result(core);
}

export function setSectionDefAll(core: HmCore, sectionDef: SectionDef): { ok: boolean; pageCount: number } {
  apply(core, Array.from({ length: sections(core) }, (_, section) => ({ op: 'setSectionSettings', section, patch: sectionPatch(core, section, sectionDef) })));
  return result(core);
}

export function insertPageBreak(core: HmCore, sec: number, para: number, charOffset: number): string {
  core.transact([{ op: 'split', at: logicalAddress(core, bodyList(sec), para, charOffset), pageBreak: true }]);
  return JSON.stringify({ ok: true, paraIdx: para + 1, charOffset: 0 });
}

export function insertColumnBreak(core: HmCore, sec: number, para: number, charOffset: number): string {
  apply(core, [{ op: 'columnBreak', at: logicalAddress(core, bodyList(sec), para, charOffset) }]);
  return JSON.stringify({ ok: true, paraIdx: para + 1, charOffset: 0 });
}

export function insertNewNumber(core: HmCore, sec: number, para: number, charOffset: number, startNum: number): string {
  apply(core, [{ op: 'insertNewNumber', at: logicalAddress(core, bodyList(sec), para, charOffset), number: startNum }]);
  return JSON.stringify({ ok: true });
}

export function getColumnDef(core: HmCore, sec: number): { columnCount: number; columnType: number; sameWidth: boolean; spacing: number; widths?: number[] } {
  const columns = settings(core, sec).columns;
  const def = { columnCount: columns?.count ?? 1, columnType: columns?.kind ?? 0, sameWidth: columns?.equalWidths ?? true, spacing: columns?.gap ?? 0 };
  if (def.sameWidth || columns?.columns?.length !== def.columnCount) return def;
  // 너비가 다른 단은 비례값(합 32768)으로 저장된다. 본문 너비에 맞춰 HU 로 돌려준다.
  // HWP5 는 이때 공통 간격을 따로 적지 않으므로 간격도 첫 단 뒤 비례값에서 읽는다.
  const body = bodyWidth(core, sec);
  const total = columns.columns.reduce((sum, [w, g]) => sum + w + g, 0) || 1;
  const hu = (value: number) => Math.round(value * body / total);
  return { ...def, spacing: hu(columns.columns[0][1]), widths: columns.columns.map(([w]) => hu(w)) };
}

/** 구역 첫 쪽의 본문 너비(HU). */
function bodyWidth(core: HmCore, sec: number): number {
  const laid = (JSON.parse(core.call(doc => doc.pages())) as HmPage[]).find(item => item.section === sec);
  if (laid) return laid.body.width;
  const page = getPageDef(core, sec);
  return (page.landscape ? page.height : page.width) - page.marginLeft - page.marginRight - page.marginGutter;
}

/** 단 너비 비율(weights)과 간격(HU)을 본문 너비 안에서 단마다 (너비, 뒤 간격) 비례값(합 32768)으로 바꾼다. */
function proportionalColumns(weights: number[], gap: number, body: number): [number, number][] {
  const n = weights.length;
  const available = Math.max(n, body - gap * (n - 1));
  const positive = weights.map(w => Math.max(0, w));
  const sum = positive.reduce((total, w) => total + w, 0);
  const share = sum > 0 ? positive.map(w => w / sum) : positive.map(() => 1 / n);
  const pairs = share.map((part, i) => [available * part, i < n - 1 ? gap : 0]);
  const total = pairs.reduce((acc, [w, g]) => acc + w + g, 0);
  const scaled = pairs.map(([w, g]) => [Math.max(1, Math.round(w * 32768 / total)), Math.round(g * 32768 / total)] as [number, number]);
  scaled[n - 1][0] += 32768 - scaled.reduce((acc, [w, g]) => acc + w + g, 0);
  return scaled;
}

/**
 * 단 설정. 너비가 다른 단(sameWidth 0)은 columnWidths 로 단마다 너비 비율을 받는다(getColumnDef 의
 * widths(HU)를 그대로 넘겨도 된다). 없으면 지금 단 비율을 쓰고, 단 수가 달라 쓸 비율이 없으면 같은 너비로 나눈다.
 */
export function setColumnDef(core: HmCore, sec: number, columnCount: number, columnType: number, sameWidth: number, spacingHu: number, columnWidths?: number[]): string {
  const patch: ColumnPatch = { count: columnCount, kind: columnType, equalWidths: !!sameWidth, gap: spacingHu };
  if (!sameWidth && columnCount > 1) {
    const weights = columnWidths?.length === columnCount ? columnWidths
      : settings(core, sec).columns?.columns?.length === columnCount ? null
        : Array.from({ length: columnCount }, () => 1);
    if (weights) patch.columns = proportionalColumns(weights, spacingHu, bodyWidth(core, sec));
  }
  apply(core, [{ op: 'setColumns', at: logicalAddress(core, bodyList(sec), 0, 0), patch }]);
  return JSON.stringify(result(core));
}

export function getPageHide(core: HmCore, sec: number, para: number): Record<string, unknown> {
  const controls = core.query<Array<{ target: { para: number; steps?: unknown[] }; kind: string; flags?: number }>>({ kind: 'controls', list: bodyList(sec) });
  const hide = controls.find(c => c.kind === 'pageHide' && c.target.para === para && !c.target.steps?.length);
  const flags = hide?.flags ?? 0;
  return { exists: !!hide, hideHeader: !!(flags & 1), hideFooter: !!(flags & 2), hideMasterPage: !!(flags & 4),
    hideBorder: !!(flags & 8), hideFill: !!(flags & 16), hidePageNum: !!(flags & 32) };
}

export function setPageHide(core: HmCore, sec: number, para: number, hideHeader: boolean, hideFooter: boolean, hideMaster: boolean, hideBorder: boolean, hideFill: boolean, hidePageNum: boolean): string {
  const flags = Number(hideHeader) | (Number(hideFooter) << 1) | (Number(hideMaster) << 2)
    | (Number(hideBorder) << 3) | (Number(hideFill) << 4) | (Number(hidePageNum) << 5);
  apply(core, [{ op: 'setPageHide', at: logicalAddress(core, bodyList(sec), para, 0), flags }]);
  return JSON.stringify({ ok: true });
}


// ─── 쪽 테두리/배경 ─────────────────────────────────────────
// 쪽 테두리 attr: 0 쪽 기준(아니면 종이), 1 머리말 포함, 2 꼬리말 포함, 3-4 채울 영역(종이·쪽·테두리).
// 감추기는 구역 attr 의 3(테두리)·4(배경) 비트다.

const FILL_AREAS = ['paper', 'page', 'border'] as const;
const NO_BORDER: PageBorder = { attr: 0, offsets: [0, 0, 0, 0], borderFill: 0, lines: [], fill: { kind: 'none' } };
const BORDER_KEYS = ['borderLeft', 'borderRight', 'borderTop', 'borderBottom'] as const;

const lineProps = (line: Line | undefined): BorderLineProps => ({ type: line?.kind ?? 0, width: line?.width ?? 0, color: colorToHex(line?.color ?? 0) });

export function getPageBorderFill(core: HmCore, sectionIdx: number): PageBorderFillSettings {
  const value = settings(core, sectionIdx);
  const border = value.pageBorders[0] ?? NO_BORDER;
  const sectionAttr = value.settings?.attr ?? 0;
  const fill = border.fill;
  const [borderLeft, borderRight, borderTop, borderBottom] = [0, 1, 2, 3].map(i => lineProps(border.lines[i]));
  return {
    attr: border.attr, basis: border.attr & 1 ? 'page' : 'paper',
    spacingLeft: border.offsets[0], spacingRight: border.offsets[1], spacingTop: border.offsets[2], spacingBottom: border.offsets[3],
    borderFillId: border.borderFill, headerInside: !!(border.attr & 2), footerInside: !!(border.attr & 4),
    fillArea: FILL_AREAS[(border.attr >> 3) & 3] ?? 'paper',
    hideBorder: !!(sectionAttr & 8), hideFill: !!(sectionAttr & 16),
    borderLeft, borderRight, borderTop, borderBottom,
    fillType: fill.kind,
    fillColor: fill.kind === 'solid' ? colorToHex(fill.color) : '#ffffff',
    patternColor: fill.kind === 'solid' ? colorToHex(fill.patternColor) : '#000000',
    patternType: fill.kind === 'solid' ? Math.max(0, fill.pattern) : 0,
  };
}

function bit(attr: number, mask: number, on: boolean | undefined): number {
  return on === undefined ? attr : on ? attr | mask : attr & ~mask;
}

export function setPageBorderFill(core: HmCore, sectionIdx: number, value: PageBorderFillSettings): { ok: boolean; pageCount: number } {
  const current = settings(core, sectionIdx);
  const border = current.pageBorders[0] ?? NO_BORDER;
  const next: Partial<PageBorderFillSettings> = value;
  let attr = border.attr;
  if (next.basis !== undefined) attr = bit(attr, 1, next.basis === 'page');
  attr = bit(attr, 2, next.headerInside);
  attr = bit(attr, 4, next.footerInside);
  if (next.fillArea !== undefined) attr = (attr & ~(3 << 3)) | (Math.max(0, FILL_AREAS.indexOf(next.fillArea)) << 3);
  const offsets = [next.spacingLeft, next.spacingRight, next.spacingTop, next.spacingBottom].map((v, i) => v ?? border.offsets[i]);
  const patch: { attr: number; offsets: number[]; borderFill?: number; lines?: Line[]; fill?: PageFill } = { attr, offsets };
  if (BORDER_KEYS.some(key => next[key] !== undefined)) {
    patch.lines = BORDER_KEYS.map((key, i) => {
      const line = next[key];
      return line ? { kind: line.type, width: line.width, color: hexToColor(line.color) } : border.lines[i] ?? { kind: 0, width: 0, color: 0 };
    });
  }
  if (next.fillType === 'none') patch.fill = { kind: 'none' };
  else if (next.fillType === 'solid') {
    patch.fill = { kind: 'solid', color: hexToColor(next.fillColor ?? '#ffffff'), patternColor: hexToColor(next.patternColor ?? '#000000'),
      pattern: next.patternType && next.patternType > 0 ? next.patternType : -1 };
  } else if (next.fillType !== undefined && next.fillType !== border.fill.kind) {
    // 그러데이션·그림 배경은 고르지 않는다. 지금 배경을 그대로 다시 적용할 때만 받는다.
    throw unsupported('그러데이션·그림 쪽 배경 바꾸기');
  }
  if (!patch.lines && !patch.fill && next.borderFillId !== undefined && next.borderFillId !== border.borderFill) {
    patch.borderFill = next.borderFillId;
  }
  const ops: PageOp[] = [{ op: 'setPageBorder', section: sectionIdx, side: 'both', patch }];
  const hide = next.hideBorder ?? (next.applyPage ? next.applyPage === 'exceptFirst' : undefined);
  const hideFill = next.hideFill ?? (next.applyPage ? next.applyPage === 'exceptFirst' : undefined);
  if ((hide !== undefined || hideFill !== undefined) && current.settings) {
    const sectionAttr = bit(bit(current.settings.attr, 8, hide), 16, hideFill) >>> 0;
    if (sectionAttr !== current.settings.attr) ops.push({ op: 'setSectionSettings', section: sectionIdx, patch: { attr: sectionAttr } });
  }
  apply(core, ops);
  return result(core);
}

extendBridge({ getPageBorderFill, setPageBorderFill, getPageDef, setPageDef, setPageDefAll, getSectionDef, setSectionDef, setSectionDefAll,
  insertPageBreak, insertColumnBreak, insertNewNumber, getColumnDef, setColumnDef, getPageHide, setPageHide });
