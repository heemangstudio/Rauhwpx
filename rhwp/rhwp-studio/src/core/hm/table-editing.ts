/** 표의 주소·셀 경계와 구조 편집을 희망 엔진 트랜잭션에 연결한다. */
import type { EditOp, Rect, TableAddress, TableCell, TableInfo } from '../../../vendor/hm-wasm/hm_wasm';
import type { HmCore } from './core';
import { px1 } from './core';
import { bodyList, logicalAddress, logicalLength, paraMap, parsePath, pathTarget } from './address';
import { extendBridge } from './api';
import type * as original from './table';
import type { CellBbox, TableCellResizeUpdate } from './bridge-types';

export const tableAddress = (section: number, para: number, control: number): TableAddress => ({ section, para, control });

/** 마지막 경로 항목의 셀을 담고 있는 표를 가리킨다. */
export function tableAddressByPath(section: number, parent: number, pathJson: string): TableAddress {
  const path = parsePath(pathJson);
  if (!path.length) throw new Error('표를 가리키는 셀 경로가 필요합니다');
  const target = pathTarget(section, parent, JSON.parse(pathJson).slice(0, -1));
  return { ...target.list, para: target.para, control: path.at(-1)!.control };
}

export const tableInfo = (core: HmCore, table: TableAddress, page?: number): TableInfo =>
  core.tableInfo(table, page);
const dimensions = (info: TableInfo) => ({ rowCount: info.rows, colCount: info.columns, cellCount: info.cells.length });
const cellInfo = (cell: TableCell) => ({ row: cell.row, col: cell.column, rowSpan: cell.rowSpan, colSpan: cell.columnSpan });
function cellAt(info: TableInfo, index: number): TableCell {
  const cell = info.cells[index];
  if (!cell) throw new RangeError(`셀 ${index}이 없습니다`);
  return cell;
}
function cellBoxes(info: TableInfo): CellBbox[] {
  return info.cells.flatMap((cell, cellIdx) => cell.rects.map(rect => ({
    cellIdx, ...cellInfo(cell), pageIndex: rect.page, x: px1(rect.x), y: px1(rect.y), w: px1(rect.width), h: px1(rect.height),
  })));
}
function boundingBox(rects: Rect[]) {
  const first = rects[0];
  if (!first) throw new Error('표가 표시된 쪽을 찾을 수 없습니다');
  const samePage = rects.filter(rect => rect.page === first.page);
  const x = Math.min(...samePage.map(rect => rect.x));
  const y = Math.min(...samePage.map(rect => rect.y));
  return { pageIndex: first.page, x: px1(x), y: px1(y),
    width: px1(Math.max(...samePage.map(rect => rect.x + rect.width)) - x),
    height: px1(Math.max(...samePage.map(rect => rect.y + rect.height)) - y) };
}
function edit(core: HmCore, op: EditOp, table: TableAddress) {
  core.transact([op]);
  return { ok: true, ...dimensions(tableInfo(core, table)) };
}
function merge(core: HmCore, table: TableAddress, startRow: number, startCol: number, endRow: number, endCol: number) {
  return edit(core, { op: 'mergeTableCells', table, startRow, startColumn: startCol, endRow, endColumn: endCol }, table);
}
function split(core: HmCore, table: TableAddress, row: number, column: number, rows: number, columns: number, equalRowHeight = false) {
  return edit(core, { op: 'splitTableCell', table, row, column, rows, columns, equalRowHeight }, table);
}
function restoreSpan(core: HmCore, table: TableAddress, row: number, column: number) {
  const cell = tableInfo(core, table).cells.find(c => c.row === row && c.column === column);
  if (!cell) throw new Error('나눌 셀이 없습니다');
  return split(core, table, row, column, cell.rowSpan, cell.columnSpan);
}
function resize(core: HmCore, table: TableAddress, updates: TableCellResizeUpdate[]) {
  const info = tableInfo(core, table);
  const cells = updates.map(update => {
    const cell = cellAt(info, update.cellIdx);
    const box = cell.rects[0];
    if ((update.renderWidth !== undefined || update.renderHeight !== undefined) && !box) throw new Error('셀의 현재 크기를 찾을 수 없습니다');
    return { index: update.cellIdx,
      widthDelta: update.renderWidth === undefined ? update.widthDelta : update.renderWidth - box.width,
      heightDelta: update.renderHeight === undefined ? update.heightDelta : update.renderHeight - box.height };
  });
  core.transact([{ op: 'resizeTableCells', table, cells }]);
  return { ok: true };
}

export const getTableDimensions: typeof original.getTableDimensions = (core, s, p, c) => dimensions(tableInfo(core, tableAddress(s, p, c)));
export const getTableDimensionsByPath: typeof original.getTableDimensionsByPath = (core, s, p, path) => dimensions(tableInfo(core, tableAddressByPath(s, p, path)));
export const getCellInfo: typeof original.getCellInfo = (core, s, p, c, i) => cellInfo(cellAt(tableInfo(core, tableAddress(s, p, c)), i));
export const getCellInfoByPath: typeof original.getCellInfoByPath = (core, s, p, path) => cellInfo(cellAt(tableInfo(core, tableAddressByPath(s, p, path)), parsePath(path).at(-1)!.cell));
export const getTableCellBboxes: typeof original.getTableCellBboxes = (core, s, p, c, page) => cellBoxes(tableInfo(core, tableAddress(s, p, c), page));
export const getTableCellBboxesByPath: typeof original.getTableCellBboxesByPath = (core, s, p, path) => cellBoxes(tableInfo(core, tableAddressByPath(s, p, path)));
export const getTableBBox: typeof original.getTableBBox = (core, s, p, c) => boundingBox(tableInfo(core, tableAddress(s, p, c)).rects);
export const getTableBBoxAtPage: typeof original.getTableBBoxAtPage = (core, s, p, c, page) => boundingBox(tableInfo(core, tableAddress(s, p, c), page).rects);
export const getTableCellTargetByPath: typeof original.getTableCellTargetByPath = (core, s, p, path, row, col, preferred) => {
  const info = tableInfo(core, tableAddressByPath(s, p, path));
  const cellIndex = info.cells.findIndex(c => row >= c.row && row < c.row + c.rowSpan && col >= c.column && col < c.column + c.columnSpan);
  const cell = cellAt(info, cellIndex);
  const list = { section: cell.list.section, steps: cell.list.steps ?? [] };
  const cellParaIndex = Math.max(0, Math.min(preferred, core.paragraphCount(list) - 1));
  return { cellIndex, cellParaIndex, charCount: logicalLength(paraMap(core.paragraph(list, cellParaIndex))) };
};
export const resizeTableCells: typeof original.resizeTableCells = (core, s, p, c, updates) => resize(core, tableAddress(s, p, c), updates);
export const resizeTableCellsByPath: typeof original.resizeTableCellsByPath = (core, s, p, path, updates) => resize(core, tableAddressByPath(s, p, path), updates);
export const mergeTableCells: typeof original.mergeTableCells = (core, s, p, c, a, b, d, e) => merge(core, tableAddress(s, p, c), a, b, d, e);
export const mergeTableCellsByPath: typeof original.mergeTableCellsByPath = (core, s, p, path, a, b, d, e) => merge(core, tableAddressByPath(s, p, path), a, b, d, e);
export const splitTableCell: typeof original.splitTableCell = (core, s, p, c, r, col) => restoreSpan(core, tableAddress(s, p, c), r, col);
export const splitTableCellByPath: typeof original.splitTableCellByPath = (core, s, p, path, r, col) => restoreSpan(core, tableAddressByPath(s, p, path), r, col);
export const splitTableCellInto: typeof original.splitTableCellInto = (core, s, p, c, r, col, rows, cols, equal, _mergeFirst) => split(core, tableAddress(s, p, c), r, col, rows, cols, equal);
export const splitTableCellIntoByPath: typeof original.splitTableCellIntoByPath = (core, s, p, path, r, col, rows, cols, equal, _mergeFirst) => split(core, tableAddressByPath(s, p, path), r, col, rows, cols, equal);
export const insertTableRow: typeof original.insertTableRow = (core, s, p, c, row, below) => { const table = tableAddress(s, p, c); return edit(core, { op: 'insertTableRows', table, beforeRow: row + Number(below), count: 1 }, table); };
export const insertTableRowByPath: typeof original.insertTableRowByPath = (core, s, p, path, row, below) => { const table = tableAddressByPath(s, p, path); return edit(core, { op: 'insertTableRows', table, beforeRow: row + Number(below), count: 1 }, table); };
export const insertTableColumn: typeof original.insertTableColumn = (core, s, p, c, col, right) => { const table = tableAddress(s, p, c); return edit(core, { op: 'insertTableColumns', table, beforeColumn: col + Number(right), count: 1 }, table); };
export const insertTableColumnByPath: typeof original.insertTableColumnByPath = (core, s, p, path, col, right) => { const table = tableAddressByPath(s, p, path); return edit(core, { op: 'insertTableColumns', table, beforeColumn: col + Number(right), count: 1 }, table); };
export const deleteTableRow: typeof original.deleteTableRow = (core, s, p, c, row) => { const table = tableAddress(s, p, c); return edit(core, { op: 'deleteTableRows', table, startRow: row, count: 1 }, table); };
export const deleteTableRowByPath: typeof original.deleteTableRowByPath = (core, s, p, path, row) => { const table = tableAddressByPath(s, p, path); return edit(core, { op: 'deleteTableRows', table, startRow: row, count: 1 }, table); };
export const deleteTableColumn: typeof original.deleteTableColumn = (core, s, p, c, col) => { const table = tableAddress(s, p, c); return edit(core, { op: 'deleteTableColumns', table, startColumn: col, count: 1 }, table); };
export const deleteTableColumnByPath: typeof original.deleteTableColumnByPath = (core, s, p, path, col) => { const table = tableAddressByPath(s, p, path); return edit(core, { op: 'deleteTableColumns', table, startColumn: col, count: 1 }, table); };
export const moveTableOffset: typeof original.moveTableOffset = (core, s, p, c, dx, dy) => {
  core.transact([{ op: 'moveObject', object: tableAddress(s, p, c), dx, dy }]);
  return { ok: true, ppi: p, ci: c };
};
export const getTableSignature: typeof original.getTableSignature = (core, s, p, c) => {
  const info = tableInfo(core, tableAddress(s, p, c));
  return JSON.stringify([info.rows, info.columns, info.cells.map(cell => {
    const list = { section: cell.list.section, steps: cell.list.steps ?? [] };
    return [cell.row, cell.column, cell.rowSpan, cell.columnSpan,
      Array.from({ length: core.paragraphCount(list) }, (_, p) => core.paragraph(list, p))];
  })]);
};
export const clearTableCellRange: typeof original.clearTableCellRange = (core, s, parent, path, startRow, startCol, endRow, endCol) => {
  const info = tableInfo(core, tableAddressByPath(s, parent, path));
  if (startRow < 0 || startCol < 0 || endRow < startRow || endCol < startCol || endRow >= info.rows || endCol >= info.columns) throw new RangeError('표 선택 범위를 벗어났습니다');
  const ops: EditOp[] = info.cells.filter(c => c.row <= endRow && c.row + c.rowSpan > startRow && c.column <= endCol && c.column + c.columnSpan > startCol).map(cell => {
    const list = { section: cell.list.section, steps: cell.list.steps ?? [] };
    const last = core.paragraphCount(list) - 1;
    return { op: 'delete', from: logicalAddress(core, list, 0, 0),
      to: { ...logicalAddress(core, list, last, 0), offset: paraMap(core.paragraph(list, last)).end } };
  });
  core.transact(ops);
  return { ok: true };
};
export const getTableControlsInSelection: typeof original.getTableControlsInSelection = (core, s, parent, path, startPara, startOffset, endPara, endOffset) => {
  const list = pathTarget(s, parent, path).list;
  const out: ReturnType<typeof original.getTableControlsInSelection> = [];
  for (let p = startPara; p <= endPara; p++) {
    const from = logicalAddress(core, list, p, p === startPara ? startOffset : 0).offset;
    const to = logicalAddress(core, list, p, p === endPara ? endOffset : logicalLength(paraMap(core.paragraph(list, p)))).offset;
    for (const c of core.paragraph(list, p).controls) if (c.kind === 'table' && c.offset >= from && c.offset < to) {
      out.push({ sec: s, ppi: path.length ? parent : p, ci: c.index, ...(path.length ? { cellPath: path.map((entry, i) => i === path.length - 1 ? { ...entry, cellParaIndex: p } : entry) } : {}) });
    }
  }
  return out;
};

extendBridge({ getTableDimensions, getTableDimensionsByPath, getCellInfo, getCellInfoByPath,
  getTableCellBboxes, getTableCellBboxesByPath, getTableBBox, getTableBBoxAtPage, getTableCellTargetByPath,
  resizeTableCells, resizeTableCellsByPath, mergeTableCells, mergeTableCellsByPath, splitTableCell,
  splitTableCellByPath, splitTableCellInto, splitTableCellIntoByPath, insertTableRow, insertTableRowByPath,
  insertTableColumn, insertTableColumnByPath, deleteTableRow, deleteTableRowByPath, deleteTableColumn,
  deleteTableColumnByPath, moveTableOffset, getTableSignature, getTableControlsInSelection, clearTableCellRange });
