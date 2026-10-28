import type { WasmBridge } from './wasm-bridge';
import type { CellBbox, CellPathEntry, CellProperties, TableProperties } from './types';

/** 표 하나를 가리키는 좌표. 중첩 표는 cellPath(안쪽 셀까지의 경로)를 함께 준다. */
export interface TableRef { sec: number; ppi: number; ci: number; cellPath?: readonly CellPathEntry[] }
type CellRange = { startRow: number; startCol: number; endRow: number; endCol: number };

/**
 * 표 대화상자와 명령이 쓰는 표 읽기·쓰기. 중첩 표(경로 2단 이상)에서 평면 좌표 {sec, ppi, ci} 는
 * 바깥 표를 가리키므로, 경로 API 로 안쪽 표를 다룬다. 셀 번호는 그 표 안의 번호다.
 */
export function tableTarget(wasm: WasmBridge, ref: TableRef) {
  const { sec, ppi, ci } = ref;
  const entries = (ref.cellPath?.length ?? 0) > 1 ? ref.cellPath! : null;
  const path = entries ? JSON.stringify(entries) : null;
  const cellPath = (cellIndex: number) => JSON.stringify([...entries!.slice(0, -1), { ...entries!.at(-1)!, cellIndex, cellParaIndex: 0 }]);
  return {
    nested: path !== null,
    dimensions: () => path ? wasm.getTableDimensionsByPath(sec, ppi, path) : wasm.getTableDimensions(sec, ppi, ci),
    cellInfo: (cellIndex: number) => path ? wasm.getCellInfoByPath(sec, ppi, cellPath(cellIndex)) : wasm.getCellInfo(sec, ppi, ci, cellIndex),
    cellBboxes: (): CellBbox[] => path ? wasm.getTableCellBboxesByPath(sec, ppi, path) : wasm.getTableCellBboxes(sec, ppi, ci),
    cellProperties: (cellIndex: number): CellProperties =>
      path ? wasm.getCellPropertiesByPath(sec, ppi, path, cellIndex) : wasm.getCellProperties(sec, ppi, ci, cellIndex),
    cellOwnProperties: (cellIndex: number): CellProperties =>
      path ? wasm.getCellOwnPropertiesByPath(sec, ppi, path, cellIndex) : wasm.getCellOwnProperties(sec, ppi, ci, cellIndex),
    setCellProperties: (cellIndex: number, props: Partial<CellProperties>) =>
      path ? wasm.setCellPropertiesByPath(sec, ppi, path, cellIndex, props) : wasm.setCellProperties(sec, ppi, ci, cellIndex, props),
    setCellZoneProperties: (range: CellRange, props: Partial<CellProperties>) =>
      path ? wasm.setCellZonePropertiesByPath(sec, ppi, path, range, props) : wasm.setCellZoneProperties(sec, ppi, ci, range, props),
    tableProperties: (): TableProperties => path ? wasm.getTablePropertiesByPath(sec, ppi, path) : wasm.getTableProperties(sec, ppi, ci),
    setTableProperties: (props: Partial<TableProperties>) =>
      path ? wasm.setTablePropertiesByPath(sec, ppi, path, props) : wasm.setTableProperties(sec, ppi, ci, props),
    /** 계산식 결과를 (row, col) 셀에 계산하고, writeResult 면 형식대로 써 넣는다. */
    evaluateFormula: (options: { targetRow: number; targetCol: number; formula: string; writeResult: boolean; decimalPlaces?: number; thousandsSeparator?: boolean }) =>
      wasm.evaluateTableFormulaEx({ sectionIdx: sec, parentParaIdx: ppi, controlIdx: ci, ...(path ? { pathJson: path } : {}), ...options }),
  };
}

/** 셀 경로 깊이 2 이상 = 중첩 표. 이때 평면 cellIndex 는 바깥 셀이므로 경로 끝의 셀 번호를 쓴다. */
export function tableCellIndex(pos: { cellIndex?: number; cellPath?: readonly CellPathEntry[] }): number | undefined {
  return (pos.cellPath?.length ?? 0) > 1 ? pos.cellPath!.at(-1)!.cellIndex : pos.cellIndex;
}
