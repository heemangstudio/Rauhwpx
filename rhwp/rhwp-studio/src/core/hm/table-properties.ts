/** 표·셀 속성 대화상자의 HWPUNIT 값을 엔진 속성에 연결한다. */
import type { EditOp, TableAddress, TableCell } from '../../../vendor/hm-wasm/hm_wasm';
import type { HmCore } from './core';
import { unsupported } from './core';
import { bodyList, logicalAddress, logicalLength, paraMap, toAddress } from './address';
import { extendBridge } from './api';
import { deleteObject, insertedControl, objectPatch, objectProperties } from './objects-editing';
import { tableAddress, tableAddressByPath, tableInfo } from './table-editing';
import type * as original from './table';
import type { CellProperties, TableProperties } from './bridge-types';
import type { BorderLineInfo } from '../types';

interface NativeLine { style: number; widthIndex: number; color: number }
interface NativeBorderFill {
  id: number; left: NativeLine; right: NativeLine; top: NativeLine; bottom: NativeLine; diagonal: NativeLine;
  slash: number; backslash: number; centerLine: string;
  fill: { kind: number; solid: { background: number; patternColor: number; pattern: number } | null } | null;
}
interface NativeCell {
  width: number; height: number; padding: number[]; verticalAlign: string; protected: boolean; header: boolean; ownPadding: boolean;
  textDirection: number; editableInForm: boolean; fieldName?: string; borderFill: NativeBorderFill | null;
}
interface NativeZone { startRow: number; startColumn: number; endRow: number; endColumn: number; borderFill: NativeBorderFill | null }
interface NativeTable {
  spacing: number; padding: number[]; repeatHeader: boolean; split: string; borderFill: NativeBorderFill | null;
  caption: { side: 'left' | 'right' | 'top' | 'bottom'; verticalAlign?: string; width: number; gap: number } | null; zones: NativeZone[];
}
type LinePatch = { style: number; width: number; color: number };
type BorderFillPatch = Partial<Record<'left' | 'right' | 'top' | 'bottom' | 'diagonal', LinePatch>> & {
  slash?: number; backslash?: number; centerLine?: string;
  fill?: { kind: 'none' } | { kind: 'solid'; background: number; patternColor: number; pattern: number };
};

/** COLORREF(0x00BBGGRR) ↔ '#rrggbb'. */
const hex = (c: number) => '#' + [c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff].map(v => v.toString(16).padStart(2, '0')).join('');
function colorRef(value: unknown): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(value));
  if (!m) throw new RangeError(`색 값이 올바르지 않습니다: ${String(value)}`);
  const v = parseInt(m[1], 16);
  return ((v & 0xff) << 16) | (v & 0xff00) | ((v >> 16) & 0xff);
}
const BORDER_KEYS = ['borderLeft', 'borderRight', 'borderTop', 'borderBottom'] as const;
const SIDES = ['left', 'right', 'top', 'bottom'] as const;
/** 테두리·배경·대각선 키. 엔진에는 borderFill 묶음 하나로 간다. */
const BORDER_FILL_KEYS = new Set<string>(['borderFillId', ...BORDER_KEYS, 'fillType', 'fillColor', 'patternColor', 'patternType',
  'diagonalLine', 'diagonalSlash', 'diagonalBackSlash', 'diagonalWidth', 'diagonalColor', 'centerLine']);

function borderFillProps(b: NativeBorderFill | null): Partial<CellProperties> {
  const none = { type: 0, width: 0, color: '#000000' };
  if (!b) {
    return { borderFillId: 0, borderLeft: none, borderRight: none, borderTop: none, borderBottom: none,
      fillType: 'none', fillColor: '#ffffff', patternColor: '#000000', patternType: 0,
      diagonalLine: 0, diagonalSlash: 0, diagonalBackSlash: 0, diagonalWidth: 0, diagonalColor: '#000000', centerLine: 'NONE' };
  }
  const line = (l: NativeLine): BorderLineInfo => ({ type: l.style, width: l.widthIndex, color: hex(l.color) });
  const solid = b.fill && b.fill.kind & 1 ? b.fill.solid : null;
  return { borderFillId: b.id, borderLeft: line(b.left), borderRight: line(b.right), borderTop: line(b.top), borderBottom: line(b.bottom),
    fillType: solid ? 'solid' : 'none', fillColor: solid ? hex(solid.background) : '#ffffff',
    patternColor: solid ? hex(solid.patternColor) : '#000000', patternType: solid ? solid.pattern : 0,
    diagonalLine: b.diagonal.style, diagonalSlash: b.slash, diagonalBackSlash: b.backslash,
    diagonalWidth: b.diagonal.widthIndex, diagonalColor: hex(b.diagonal.color), centerLine: b.centerLine.toUpperCase() };
}

const sameLine = (a: BorderLineInfo | undefined, b: BorderLineInfo) =>
  !!a && a.type === b.type && a.width === b.width && a.color.toLowerCase() === b.color.toLowerCase();

/** 바뀐 테두리·배경 키만 엔진 borderFill 묶음으로 바꾼다. current 가 비면 준 값을 모두 쓴다. */
function borderFillPatch(props: Record<string, unknown>, current: Partial<CellProperties>): BorderFillPatch | null {
  const patch: BorderFillPatch = {};
  BORDER_KEYS.forEach((key, i) => {
    const line = props[key] as BorderLineInfo | undefined;
    if (!line || sameLine(current[key], line)) return;
    patch[SIDES[i]] = { style: Number(line.type), width: Number(line.width), color: colorRef(line.color) };
  });
  const pick = <K extends keyof CellProperties>(key: K) => (props[key] ?? current[key]) as CellProperties[K];
  const fillKeys = ['fillType', 'fillColor', 'patternColor', 'patternType'] as const;
  if (fillKeys.some(k => props[k] !== undefined && String(props[k]).toLowerCase() !== String(current[k]).toLowerCase())) {
    const type = pick('fillType');
    if (type === 'solid') {
      patch.fill = { kind: 'solid', background: colorRef(pick('fillColor') ?? '#ffffff'),
        patternColor: colorRef(pick('patternColor') ?? '#000000'), pattern: Number(pick('patternType') ?? 0) };
    } else if (type === 'none' || type === undefined) patch.fill = { kind: 'none' };
    else throw unsupported(`setCellProperties.fillType.${String(type)}`);
  }
  const diagKeys = ['diagonalLine', 'diagonalWidth', 'diagonalColor'] as const;
  if (diagKeys.some(k => props[k] !== undefined && String(props[k]).toLowerCase() !== String(current[k]).toLowerCase())) {
    patch.diagonal = { style: Number(pick('diagonalLine') ?? 0), width: Number(pick('diagonalWidth') ?? 0), color: colorRef(pick('diagonalColor') ?? '#000000') };
  }
  if (props.diagonalSlash !== undefined && props.diagonalSlash !== current.diagonalSlash) patch.slash = Number(props.diagonalSlash);
  if (props.diagonalBackSlash !== undefined && props.diagonalBackSlash !== current.diagonalBackSlash) patch.backslash = Number(props.diagonalBackSlash);
  if (props.centerLine !== undefined && String(props.centerLine).toUpperCase() !== String(current.centerLine ?? 'NONE').toUpperCase()) {
    patch.centerLine = String(props.centerLine).toLowerCase();
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * 셀 영역은 영역 전체를 한 셀처럼 칠한다. 영역 안 셀의 배경·대각선은 영역 것이고, 테두리는 셀이 영역
 * 바깥 가장자리에 닿은 쪽만 영역 것이다. 뒤에 놓인 영역이 앞 영역을 덮는다.
 */
function zonedBorderFill(core: HmCore, table: TableAddress, cell: TableCell, own: NativeBorderFill | null): NativeBorderFill | null {
  const zones = core.query<NativeTable>({ kind: 'tableProperties', table }).zones ?? [];
  let out = own;
  for (const z of zones) {
    const lastRow = cell.row + cell.rowSpan - 1, lastColumn = cell.column + cell.columnSpan - 1;
    if (!z.borderFill || cell.row < z.startRow || lastRow > z.endRow || cell.column < z.startColumn || lastColumn > z.endColumn) continue;
    const zone = z.borderFill;
    out = { ...(out ?? zone), fill: zone.fill, diagonal: zone.diagonal, slash: zone.slash, backslash: zone.backslash,
      ...(cell.column === z.startColumn ? { left: zone.left } : {}), ...(lastColumn === z.endColumn ? { right: zone.right } : {}),
      ...(cell.row === z.startRow ? { top: zone.top } : {}), ...(lastRow === z.endRow ? { bottom: zone.bottom } : {}) };
  }
  return out;
}

function cellProperties(core: HmCore, table: TableAddress, index: number): CellProperties {
  const cell = tableInfo(core, table).cells[index];
  if (!cell) throw new RangeError(`셀 ${index}이 없습니다`);
  const native = core.query<NativeCell>({ kind: 'cellProperties', table, row: cell.row, column: cell.column });
  const props = { ...native, borderFill: zonedBorderFill(core, table, cell, native.borderFill) };
  return { width: props.width, height: props.height,
    paddingLeft: props.padding[0], paddingRight: props.padding[1], paddingTop: props.padding[2], paddingBottom: props.padding[3],
    applyInnerMargin: props.ownPadding, verticalAlign: ['top', 'center', 'bottom'].indexOf(props.verticalAlign),
    textDirection: props.textDirection, isHeader: props.header, cellProtect: props.protected,
    fieldName: props.fieldName ?? '', editableInForm: props.editableInForm, ...borderFillProps(props.borderFill) };
}
function setCell(core: HmCore, table: TableAddress, index: number, props: Partial<CellProperties>) {
  const info = tableInfo(core, table).cells[index];
  if (!info) throw new RangeError(`셀 ${index}이 없습니다`);
  const current = cellProperties(core, table, index);
  const padding = [current.paddingLeft, current.paddingRight, current.paddingTop, current.paddingBottom];
  const paddingKeys = ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'];
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === current[key as keyof CellProperties] || BORDER_FILL_KEYS.has(key)) continue;
    if (key === 'width' || key === 'height') patch[key] = value;
    else if (paddingKeys.includes(key)) { padding[paddingKeys.indexOf(key)] = Number(value); patch.padding = padding; }
    else if (key === 'verticalAlign') patch.verticalAlign = ['top', 'center', 'bottom'][Number(value)];
    else if (key === 'cellProtect') patch.protected = value;
    else if (key === 'isHeader') patch.header = value;
    else if (key === 'applyInnerMargin') patch.ownPadding = value;
    else if (key === 'textDirection') patch.textDirection = Number(value);
    else if (key === 'editableInForm') patch.editableInForm = value;
    else if (key === 'fieldName') patch.fieldName = value;
    else throw unsupported(`setCellProperties.${key}`);
  }
  if (props.borderFillId !== undefined && props.borderFillId !== current.borderFillId) patch.borderFillId = props.borderFillId;
  const borderFill = borderFillPatch(props as Record<string, unknown>, current);
  if (borderFill) patch.borderFill = borderFill;
  if (Object.keys(patch).length) core.transact([{ op: 'setCellProperties', table, row: info.row, column: info.column, patch } as EditOp]);
  return { ok: true };
}
export const getCellProperties: typeof original.getCellProperties = (core, s, p, c, i) => cellProperties(core, tableAddress(s, p, c), i);
export const getCellOwnProperties: typeof original.getCellOwnProperties = getCellProperties;
export const getCellPropertiesByPath: typeof original.getCellPropertiesByPath = (core, s, p, path, i) => cellProperties(core, tableAddressByPath(s, p, path), i);
export const setCellProperties: typeof original.setCellProperties = (core, s, p, c, index, props) => setCell(core, tableAddress(s, p, c), index, props);
export const setCellZoneProperties: typeof original.setCellZoneProperties = (core, s, p, c, range, props) => {
  const table = tableAddress(s, p, c);
  // 하나의 셀처럼 적용: 묶음 전체가 테두리·배경 하나를 나눠 쓰는 표 영역이다. 중심선은 영역에 쓰지 않는다.
  const borderFill = borderFillPatch({ ...props, centerLine: undefined } as Record<string, unknown>, {});
  if (borderFill) core.transact([{ op: 'setCellZone', table, startRow: range.startRow, startColumn: range.startCol,
    endRow: range.endRow, endColumn: range.endCol, borderFill } as EditOp]);
  return { ok: true, borderFillId: 0 };
};
export const getTableProperties: typeof original.getTableProperties = (core, s, p, c) => {
  const table = tableAddress(s, p, c);
  const props = core.query<NativeTable>({ kind: 'tableProperties', table });
  const common = objectProperties(core, table);
  const cap = (v: string) => v[0].toUpperCase() + v.slice(1);
  return { cellSpacing: props.spacing, paddingLeft: props.padding[0], paddingRight: props.padding[1], paddingTop: props.padding[2], paddingBottom: props.padding[3],
    // 표 대화상자처럼 저장값 그대로: 0 나누지 않음, 1 셀 단위로 나눔, 2 나눔.
    pageBreak: Math.max(0, ['none', 'row', 'cell'].indexOf(props.split)), repeatHeader: props.repeatHeader,
    tableWidth: common.width, tableHeight: common.height, treatAsChar: common.treatAsChar,
    horzOffset: common.horzOffset, vertOffset: common.vertOffset, horzRelTo: cap(common.horzRelTo), vertRelTo: cap(common.vertRelTo),
    horzAlign: cap(common.horzAlign), vertAlign: cap(common.vertAlign),
    textWrap: ({ behind: 'BehindText', inFront: 'InFrontOfText' }[common.textWrap] ?? cap(common.textWrap)),
    outerLeft: common.margins[0], outerRight: common.margins[1], outerTop: common.margins[2], outerBottom: common.margins[3],
    restrictInPage: common.restrictInPage, allowOverlap: common.allowOverlap, keepWithAnchor: common.keepWithAnchor,
    // 구 엔진처럼 캡션이 없으면 캡션 칸을 알리지 않는다.
    hasCaption: !!props.caption, ...(props.caption ? { captionDirection: ['left', 'right', 'top', 'bottom'].indexOf(props.caption.side ?? 'bottom'),
      captionVertAlign: ['top', 'center', 'bottom'].indexOf(props.caption.verticalAlign ?? 'top'), captionWidth: props.caption.width ?? 0, captionSpacing: props.caption.gap ?? 0 } : {}),
    ...borderFillProps(props.borderFill) } as TableProperties;
};
export const setTableProperties: typeof original.setTableProperties = (core, s, p, c, props) => {
  const table = tableAddress(s, p, c);
  const current = getTableProperties(core, s, p, c);
  const common: Record<string, unknown> = {};
  const patch: Record<string, unknown> = {};
  const padding = [current.paddingLeft, current.paddingRight, current.paddingTop, current.paddingBottom];
  const paddingKeys = ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'];
  const commonKeys: Record<string, string> = { tableWidth: 'width', tableHeight: 'height', outerLeft: 'outerMarginLeft', outerRight: 'outerMarginRight', outerTop: 'outerMarginTop', outerBottom: 'outerMarginBottom' };
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === current[key as keyof TableProperties] || BORDER_FILL_KEYS.has(key)) continue;
    if (key === 'cellSpacing') patch.spacing = value;
    else if (key === 'repeatHeader') patch.repeatHeader = value;
    else if (key === 'pageBreak') patch.split = ['none', 'row', 'cell'][Number(value)] ?? 'cell';
    else if (paddingKeys.includes(key)) { padding[paddingKeys.indexOf(key)] = Number(value); patch.padding = padding; }
    else if (key === 'captionDirection') common[key] = ['Left', 'Right', 'Top', 'Bottom'][Number(value)];
    else if (key === 'captionVertAlign') common[key] = ['Top', 'Center', 'Bottom'][Number(value)];
    else common[commonKeys[key] ?? key] = value;
  }
  if (props.borderFillId !== undefined && props.borderFillId !== current.borderFillId) patch.borderFillId = props.borderFillId;
  const borderFill = borderFillPatch(props as Record<string, unknown>, current as Partial<CellProperties>);
  if (borderFill) patch.borderFill = borderFill;
  const ops: EditOp[] = [];
  if (props.hasCaption === true && !current.hasCaption) ops.push({ op: 'setTableCaption', table, text: ' ', withNumber: true } as EditOp);
  if (Object.keys(patch).length) ops.push({ op: 'setTableProperties', table, patch } as EditOp);
  if (Object.keys(common).length) {
    const mappedCurrent = Object.fromEntries(Object.entries(current).map(([key, value]) => [commonKeys[key] ?? key, value]));
    const object = objectPatch(objectProperties(core, table), common, mappedCurrent);
    if (Object.keys(object).length) ops.push({ op: 'setObjectProperties', object: table, patch: object } as EditOp);
  }
  core.transact(ops);
  return { ok: true };
};
export const deleteTableControl: typeof original.deleteTableControl = (core, s, p, c) => deleteObject(core, tableAddress(s, p, c));
export const deleteCellTableControlByPath: typeof original.deleteCellTableControlByPath = (core, s, p, path, c) => {
  const container = JSON.parse(path);
  const last = container.at(-1);
  // path 는 삭제할 표를 담은 셀의 경로다.
  if (!last) return deleteTableControl(core, s, p, c);
  const address = tableAddressByPath(s, p, JSON.stringify([...container, { controlIndex: c, cellIndex: 0, cellParaIndex: 0 }]));
  return deleteObject(core, address);
};
/**
 * 글자처럼 취급하지 않는 표(기본)는 구 엔진처럼 제 문단에 놓고 뒤에 빈 문단을 둔다. 빈 문단이면 그 문단에,
 * 문단 처음이면 문단 뒤에, 그 밖에는 캐럿에서 문단을 나눠 사이에 넣는다.
 */
export const createTableEx: typeof original.createTableEx = (core, options) => {
  const list = bodyList(options.sectionIdx);
  const para = options.paraIdx;
  const at = logicalAddress(core, list, para, options.charOffset);
  const inline = options.treatAsChar ?? false;
  const table = (where: typeof at): EditOp => ({ op: 'createTable', at: where, rows: options.rowCount, columns: options.colCount,
    columnWidths: options.colWidths, rowHeights: options.rowHeights, inline } as EditOp);
  if (inline) {
    const before = core.paragraph(list, para).controls.map(c => c.index);
    core.transact([table(at)]);
    return insertedControl(core, at, before);
  }
  const map = paraMap(core.paragraph(list, para));
  if (logicalLength(map) === 0) {
    const before = map.info.controls.map(c => c.index);
    core.transact([table(at), { op: 'split', at: toAddress(list, para, map.end + 8) }]);
    return insertedControl(core, at, before);
  }
  const own = toAddress(list, para + 1, 0);
  const splits: EditOp[] = options.charOffset <= 0
    ? [{ op: 'split', at: toAddress(list, para, map.end) }, table(own), { op: 'split', at: toAddress(list, para + 1, 8) }]
    : [{ op: 'split', at }, { op: 'split', at }, { op: 'split', at }, table(own)];
  core.transact(splits);
  return insertedControl(core, own, []);
};
export const createTable: typeof original.createTable = (core, s, p, offset, rows, cols) => createTableEx(core, { sectionIdx: s, paraIdx: p, charOffset: offset, rowCount: rows, colCount: cols });
export const setTableColumnWidths: typeof original.setTableColumnWidths = (core, s, p, c, widths) => {
  const table = tableAddress(s, p, c);
  const info = tableInfo(core, table);
  if (widths.length !== info.columns || widths.some(w => !Number.isFinite(w) || w <= 0)) throw new RangeError('표의 열 수에 맞는 양수 너비가 필요합니다');
  const cells = info.cells.map((cell, index) => {
    const box = cell.rects[0];
    if (!box) throw new Error('셀의 현재 크기를 찾을 수 없습니다');
    const width = widths.slice(cell.column, cell.column + cell.columnSpan).reduce((a, b) => a + b, 0);
    return { index, widthDelta: width - box.width };
  });
  core.transact([{ op: 'resizeTableCells', table, cells }]);
  return { ok: true, colCount: info.columns, tableWidth: widths.reduce((a, b) => a + b, 0) };
};
export const fitTableToPage: typeof original.fitTableToPage = (core, s, p, c) => {
  const table = tableInfo(core, tableAddress(s, p, c));
  const page = table.rects[0]?.page ?? 0;
  const info = JSON.parse(core.call(doc => doc.pageInfo(page))) as { body: { width: number } };
  const width = info.body.width;
  const colWidth = Math.floor(width / table.columns);
  return setTableColumnWidths(core, s, p, c, Array.from({ length: table.columns }, (_, i) => i === table.columns - 1 ? width - colWidth * i : colWidth));
};

extendBridge({ getCellProperties, getCellOwnProperties, getCellPropertiesByPath, setCellProperties, setCellZoneProperties,
  getTableProperties, setTableProperties, deleteTableControl, deleteCellTableControlByPath,
  createTableEx, createTable, setTableColumnWidths, fitTableToPage });
