// 이 파일의 함수는 WasmBridge 의 같은 이름 메서드가 위임한다. 엔진이 아직 못 하는 기능은
// EngineNotSupportedError 를 던지고, 명령 계층이 해당 메뉴·버튼을 비활성으로 보여 준다.
import type { HmCore } from './core';
import { unsupported } from './core';
import type { TableDimensions, CellInfo, TableCellTarget, CellBbox, CellProperties, TableProperties, CellPathEntry, TableCellResizeUpdate, TableTransposeResult } from './bridge-types';

export function getTableDimensions(core: HmCore, sec: number, parentPara: number, controlIdx: number): TableDimensions {
  throw unsupported('getTableDimensions');
}

export function getCellInfo(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number): CellInfo {
  throw unsupported('getCellInfo');
}

export function getTableCellBboxes(core: HmCore, sec: number, parentPara: number, controlIdx: number, pageHint?: number): CellBbox[] {
  throw unsupported('getTableCellBboxes');
}

export function getTableBBox(core: HmCore, sec: number, parentPara: number, controlIdx: number): { pageIndex: number; x: number; y: number; width: number; height: number } {
  throw unsupported('getTableBBox');
}

export function getTableBBoxAtPage(core: HmCore, sec: number, parentPara: number, controlIdx: number, pageIdx: number): { pageIndex: number; x: number; y: number; width: number; height: number } {
  throw unsupported('getTableBBoxAtPage');
}

export function deleteTableControl(core: HmCore, sec: number, parentPara: number, controlIdx: number): { ok: boolean } {
  throw unsupported('deleteTableControl');
}

export function deleteCellTableControlByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, controlIdx: number): { ok: boolean } {
  throw unsupported('deleteCellTableControlByPath');
}

export function getCellProperties(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number): CellProperties {
  throw unsupported('getCellProperties');
}

export function getCellPropertiesByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, cellIdx: number): CellProperties {
  throw unsupported('getCellPropertiesByPath');
}

export function getCellOwnProperties(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number): CellProperties {
  throw unsupported('getCellOwnProperties');
}

export function getCellOwnPropertiesByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, cellIdx: number): CellProperties {
  throw unsupported('getCellOwnPropertiesByPath');
}

export function setCellProperties(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, props: Partial<CellProperties>): { ok: boolean } {
  throw unsupported('setCellProperties');
}

export function setCellPropertiesByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, cellIdx: number, props: Partial<CellProperties>): { ok: boolean } {
  throw unsupported('setCellPropertiesByPath');
}

export function setCellZoneProperties(core: HmCore, sec: number, parentPara: number, controlIdx: number, range: { startRow: number; startCol: number; endRow: number; endCol: number }, props: Partial<CellProperties>): { ok: boolean; borderFillId: number } {
  throw unsupported('setCellZoneProperties');
}

export function setCellZonePropertiesByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, range: { startRow: number; startCol: number; endRow: number; endCol: number }, props: Partial<CellProperties>): { ok: boolean; borderFillId: number } {
  throw unsupported('setCellZonePropertiesByPath');
}

export function resizeTableCells(core: HmCore, sec: number, parentPara: number, controlIdx: number, updates: TableCellResizeUpdate[]): { ok: boolean } {
  throw unsupported('resizeTableCells');
}

export function resizeTableCellsByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, updates: TableCellResizeUpdate[]): { ok: boolean } {
  throw unsupported('resizeTableCellsByPath');
}

export function moveTableCellEdgeByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, row: number, col: number, side: 'right' | 'bottom', delta: number): { ok: boolean } {
  throw unsupported('moveTableCellEdgeByPath');
}

export function moveTableOffset(core: HmCore, sec: number, parentPara: number, controlIdx: number, deltaH: number, deltaV: number): { ok: boolean; ppi: number; ci: number } {
  throw unsupported('moveTableOffset');
}

export function getTableProperties(core: HmCore, sec: number, parentPara: number, controlIdx: number): TableProperties {
  throw unsupported('getTableProperties');
}

export function getTablePropertiesByPath(core: HmCore, sec: number, parentPara: number, pathJson: string): TableProperties {
  throw unsupported('getTablePropertiesByPath');
}

export function getTableSignature(core: HmCore, sec: number, parentPara: number, controlIdx: number): string {
  throw unsupported('getTableSignature');
}

export function setTableProperties(core: HmCore, sec: number, parentPara: number, controlIdx: number, props: Partial<TableProperties>): { ok: boolean } {
  throw unsupported('setTableProperties');
}

export function setTablePropertiesByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, props: Partial<TableProperties>): { ok: boolean } {
  throw unsupported('setTablePropertiesByPath');
}

export function setTableColumnWidths(core: HmCore, sec: number, parentPara: number, controlIdx: number, widths: number[]): { ok: boolean; colCount: number; tableWidth: number } {
  throw unsupported('setTableColumnWidths');
}

export function fitTableToPage(core: HmCore, sec: number, parentPara: number, controlIdx: number): { ok: boolean; colCount: number; tableWidth: number } {
  throw unsupported('fitTableToPage');
}

export function setTableCaptionText(core: HmCore, sec: number, parentPara: number, controlIdx: number, text: string, withNumber: boolean): { ok: boolean; captionText: string } {
  throw unsupported('setTableCaptionText');
}

export function mergeTableCells(core: HmCore, sec: number, parentPara: number, controlIdx: number, startRow: number, startCol: number, endRow: number, endCol: number): { ok: boolean; cellCount: number } {
  throw unsupported('mergeTableCells');
}

export function mergeTableCellsByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, startRow: number, startCol: number, endRow: number, endCol: number): { ok: boolean; cellCount: number } {
  throw unsupported('mergeTableCellsByPath');
}

export function splitTableCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, row: number, col: number): { ok: boolean; cellCount: number } {
  throw unsupported('splitTableCell');
}

export function splitTableCellByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, row: number, col: number): { ok: boolean; cellCount: number } {
  throw unsupported('splitTableCellByPath');
}

export function splitTableCellInto(core: HmCore, sec: number, parentPara: number, controlIdx: number, row: number, col: number, nRows: number, mCols: number, equalRowHeight: boolean, mergeFirst: boolean): { ok: boolean; cellCount: number } {
  throw unsupported('splitTableCellInto');
}

export function splitTableCellIntoByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, row: number, col: number, nRows: number, mCols: number, equalRowHeight: boolean, mergeFirst: boolean): { ok: boolean; cellCount: number } {
  throw unsupported('splitTableCellIntoByPath');
}

export function splitTableCellsInRange(core: HmCore, sec: number, parentPara: number, controlIdx: number, startRow: number, startCol: number, endRow: number, endCol: number, nRows: number, mCols: number, equalRowHeight: boolean): { ok: boolean; cellCount: number } {
  throw unsupported('splitTableCellsInRange');
}

export function splitTableCellsInRangeByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, startRow: number, startCol: number, endRow: number, endCol: number, nRows: number, mCols: number, equalRowHeight: boolean): { ok: boolean; cellCount: number } {
  throw unsupported('splitTableCellsInRangeByPath');
}

export function copyTableCellRange(core: HmCore, sec: number, parent: number, pathJson: string, startRow: number, startCol: number, endRow: number, endCol: number): { ok: boolean; text: string; html: string } {
  throw unsupported('copyTableCellRange');
}

export function clearTableCellRange(core: HmCore, sec: number, parent: number, pathJson: string, startRow: number, startCol: number, endRow: number, endCol: number): { ok: boolean } {
  throw unsupported('clearTableCellRange');
}

export function pasteTableCellRange(core: HmCore, sec: number, parent: number, pathJson: string, startRow: number, startCol: number): { ok: boolean } {
  throw unsupported('pasteTableCellRange');
}

export function copyTableCellsTransposed(core: HmCore, sec: number, parentPara: number, controlIdx: number, startRow: number, startCol: number, endRow: number, endCol: number): TableTransposeResult {
  throw unsupported('copyTableCellsTransposed');
}

export function pasteTableCellsTransposed(core: HmCore, sec: number, parentPara: number, controlIdx: number, startRow: number, startCol: number): TableTransposeResult {
  throw unsupported('pasteTableCellsTransposed');
}

export function transposeTableCellsInPlace(core: HmCore, sec: number, parentPara: number, controlIdx: number): TableTransposeResult {
  throw unsupported('transposeTableCellsInPlace');
}

export function pasteTableCellsTransposedAsTable(core: HmCore, sec: number, para: number, charOffset: number): TableTransposeResult {
  throw unsupported('pasteTableCellsTransposedAsTable');
}

export function hasTableTransposeClipboard(_core: HmCore): boolean {
  return false;
}

export function insertTableRow(core: HmCore, sec: number, parentPara: number, controlIdx: number, rowIdx: number, below: boolean, count?: number): { ok: boolean; rowCount: number; colCount: number } {
  throw unsupported('insertTableRow');
}

export function insertTableRowByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, rowIdx: number, below: boolean, count?: number): { ok: boolean; rowCount: number; colCount: number } {
  throw unsupported('insertTableRowByPath');
}

export function insertTableColumn(core: HmCore, sec: number, parentPara: number, controlIdx: number, colIdx: number, right: boolean, count?: number): { ok: boolean; rowCount: number; colCount: number } {
  throw unsupported('insertTableColumn');
}

export function insertTableColumnByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, colIdx: number, right: boolean, count?: number): { ok: boolean; rowCount: number; colCount: number } {
  throw unsupported('insertTableColumnByPath');
}

export function deleteTableRow(core: HmCore, sec: number, parentPara: number, controlIdx: number, rowIdx: number, count?: number): { ok: boolean; rowCount: number; colCount: number } {
  throw unsupported('deleteTableRow');
}

export function deleteTableRowByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, rowIdx: number, count?: number): { ok: boolean; rowCount: number; colCount: number } {
  throw unsupported('deleteTableRowByPath');
}

export function deleteTableColumn(core: HmCore, sec: number, parentPara: number, controlIdx: number, colIdx: number, count?: number): { ok: boolean; rowCount: number; colCount: number } {
  throw unsupported('deleteTableColumn');
}

export function deleteTableColumnByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, colIdx: number, count?: number): { ok: boolean; rowCount: number; colCount: number } {
  throw unsupported('deleteTableColumnByPath');
}

export function createTable(core: HmCore, sec: number, para: number, charOffset: number, rows: number, cols: number): { ok: boolean; paraIdx: number; controlIdx: number } {
  throw unsupported('createTable');
}

export function createTableEx(core: HmCore, options: { sectionIdx: number; paraIdx: number; charOffset: number; rowCount: number; colCount: number; treatAsChar?: boolean; colWidths?: number[]; rowHeights?: number[]; }): { ok: boolean; paraIdx: number; controlIdx: number } {
  throw unsupported('createTableEx');
}

export function evaluateTableFormula(core: HmCore, sec: number, parentPara: number, controlIdx: number, targetRow: number, targetCol: number, formula: string, writeResult: boolean): string {
  throw unsupported('evaluateTableFormula');
}

export function evaluateTableFormulaEx(core: HmCore, options: { sectionIdx: number; parentParaIdx: number; controlIdx: number; pathJson?: string; targetRow: number; targetCol: number; formula: string; writeResult: boolean; decimalPlaces?: number; thousandsSeparator?: boolean; prefix?: string; suffix?: string; }): { ok: boolean; value?: number; display?: string } {
  throw unsupported('evaluateTableFormulaEx');
}

export function getCellInfoByPath(core: HmCore, sec: number, parentPara: number, pathJson: string): CellInfo {
  throw unsupported('getCellInfoByPath');
}

export function getTableDimensionsByPath(core: HmCore, sec: number, parentPara: number, pathJson: string): TableDimensions {
  throw unsupported('getTableDimensionsByPath');
}

export function getTableCellTargetByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, row: number, col: number, preferredParaIdx: number): TableCellTarget {
  throw unsupported('getTableCellTargetByPath');
}

export function getTableCellBboxesByPath(core: HmCore, sec: number, parentPara: number, pathJson: string): CellBbox[] {
  throw unsupported('getTableCellBboxesByPath');
}

export function getTableControlsInSelection(core: HmCore, sec: number, parentPara: number, containerPath: CellPathEntry[], startPara: number, startOffset: number, endPara: number, endOffset: number): Array<{ sec: number; ppi: number; ci: number; cellPath?: CellPathEntry[] }> {
  throw unsupported('getTableControlsInSelection');
}
