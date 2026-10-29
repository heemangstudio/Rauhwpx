/** 행·열 바꿈 클립보드와 표 편집을 엔진의 원자적 이력에 연결한다. */
import type { HmCore } from './core';
import { bodyList, logicalAddress } from './address';
import { extendBridge } from './api';
import type * as original from './table';
import type { TableTransposeResult } from './bridge-types';
import { tableAddressByPath } from './table-editing';
import { rememberTableClipboard } from './clipboard-native';

type TransposeDoc = { transposeTable(request: string): string; hasTableTransposeClipboard(): boolean };
function transpose(core: HmCore, request: object, write: boolean): TableTransposeResult {
  let result!: TableTransposeResult & { receipt: unknown };
  const run = (doc: unknown) => {
    result = JSON.parse((doc as TransposeDoc).transposeTable(JSON.stringify(request)));
    return JSON.stringify(result.receipt);
  };
  if (write) core.mutate(run);
  else core.call(run);
  const { receipt: _, ...value } = result;
  return value;
}
const table = (section: number, para: number, control: number) => ({ section, para, control });
export const copyTableCellsTransposed: typeof original.copyTableCellsTransposed = (core, s, p, c, startRow, startColumn, endRow, endColumn) =>
  transpose(core, { action: 'copy', table: table(s, p, c), startRow, startColumn, endRow, endColumn }, false);
export const pasteTableCellsTransposed: typeof original.pasteTableCellsTransposed = (core, s, p, c, startRow, startColumn) =>
  transpose(core, { action: 'paste', table: table(s, p, c), startRow, startColumn }, true);
export const transposeTableCellsInPlace: typeof original.transposeTableCellsInPlace = (core, s, p, c) =>
  transpose(core, { action: 'inPlace', table: table(s, p, c) }, true);
export const pasteTableCellsTransposedAsTable: typeof original.pasteTableCellsTransposedAsTable = (core, s, p, offset) =>
  transpose(core, { action: 'insert', at: logicalAddress(core, bodyList(s), p, offset) }, true);
export const hasTableTransposeClipboard: typeof original.hasTableTransposeClipboard = core =>
  core.hasDocument() && core.call(doc => (doc as unknown as TransposeDoc).hasTableTransposeClipboard());

export const copyTableCellRange: typeof original.copyTableCellRange = (core, s, p, path, startRow, startColumn, endRow, endColumn) => {
  const result = transpose(core, { action: 'copy', transpose: false, table: tableAddressByPath(s, p, path), startRow, startColumn, endRow, endColumn }, false) as TableTransposeResult & { text: string; html: string };
  rememberTableClipboard(core, result);
  return { ok: true, text: result.text, html: result.html };
};
export const pasteTableCellRange: typeof original.pasteTableCellRange = (core, s, p, path, startRow, startColumn) => {
  transpose(core, { action: 'paste', transpose: false, table: tableAddressByPath(s, p, path), startRow, startColumn }, true);
  return { ok: true };
};

extendBridge({ copyTableCellRange, pasteTableCellRange, copyTableCellsTransposed, pasteTableCellsTransposed, transposeTableCellsInPlace, pasteTableCellsTransposedAsTable, hasTableTransposeClipboard });
