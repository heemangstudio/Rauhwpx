import type { CommandDef, CommandServices, EditorContext } from '../types';
import { TableCellPropsDialog } from '@/ui/table-cell-props-dialog';
import { TableCreateDialog } from '@/ui/table-create-dialog';
import type { TableCreateOptions } from '@/ui/table-create-dialog';
import { CellSplitDialog } from '@/ui/cell-split-dialog';
import { CellBorderBgDialog } from '@/ui/cell-border-bg-dialog';
import { FormulaDialog } from '@/ui/formula-dialog';
import {
  TableDeleteRowColumnDialog,
  TableInsertRowColumnDialog,
  type TableDeleteRowColumnMode,
  type TableInsertRowColumnMode,
} from '@/ui/table-row-column-dialog';
import { remapTableCellPosition, tableModelPathJson } from '@/core/table-structural-cursor';
import { tableCellIndex, tableTarget } from '@/core/table-target';

const inTable = (ctx: EditorContext) => ctx.inTable;
const inTableOrCellSelection = (ctx: EditorContext) => ctx.inTable || ctx.inCellSelectionMode;
const hasMultiCellSelection = (ctx: EditorContext) => ctx.hasMultiCellSelection;
/** 한컴은 여러 셀 블록이 잡혀 있으면 줄·칸 추가와 지우기를 하지 않는다. */
const inTableWithoutBlock = (ctx: EditorContext) => ctx.inTable && !ctx.hasMultiCellSelection;

type CellRange = { startRow: number; startCol: number; endRow: number; endCol: number };
type TableDimensions = { rowCount: number; colCount: number; cellCount: number };
type TableCellCommandContext = {
  ih: NonNullable<ReturnType<CommandServices['getInputHandler']>>;
  pos: ReturnType<NonNullable<ReturnType<CommandServices['getInputHandler']>>['getCursorPosition']>;
  cellInfo: ReturnType<CommandServices['wasm']['getCellInfo']>;
};

type TableCursorPosition = TableCellCommandContext['pos'];

function tablePathJson(pos: TableCursorPosition): string | null {
  return pos.cellPath?.length ? JSON.stringify(pos.cellPath) : null;
}

/**
 * cellPath 깊이 2 이상 = 중첩 표. 이때 평면 필드(parentParaIndex/controlIndex/cellIndex/
 * cellParaIndex)는 바깥 표를 가리키므로, 평면 API 에 넘기면 바깥 표를 읽고 고친다.
 */
function isNestedPath(path: readonly unknown[] | null | undefined): boolean {
  return (path?.length ?? 0) > 1;
}

/**
 * 셀 숫자 서식 명령이 읽고 바꿀 현재 셀 문단.
 * 중첩 표는 경로 API 로 안쪽 셀을 다룬다 (평면 좌표는 바깥 셀의 host 문단을 가리킨다).
 */
function currentCellParagraphText(services: CommandServices, pos: TableCursorPosition) {
  const sec = pos.sectionIndex, ppi = pos.parentParaIndex!, ci = pos.controlIndex!, cei = pos.cellIndex!;
  const cpi = pos.cellParaIndex ?? 0;
  const path = isNestedPath(pos.cellPath) ? tablePathJson(pos) : null;
  const len = path
    ? services.wasm.getCellParagraphLengthByPath(sec, ppi, path)
    : services.wasm.getCellParagraphLength(sec, ppi, ci, cei, cpi);
  const text = len <= 0 ? '' : path
    ? services.wasm.getTextInCellByPath(sec, ppi, path, 0, len)
    : services.wasm.getTextInCell(sec, ppi, ci, cei, cpi, 0, len);
  return {
    len,
    text,
    /** snapshot operation 안에서 호출한다 (delete+insert 원자화). */
    replace(wasm: CommandServices['wasm'], result: string): void {
      if (path) {
        wasm.deleteTextInCellByPath(sec, ppi, path, 0, len);
        wasm.insertTextInCellByPath(sec, ppi, path, 0, result);
      } else {
        wasm.deleteTextInCell(sec, ppi, ci, cei, cpi, 0, len);
        wasm.insertTextInCell(sec, ppi, ci, cei, cpi, 0, result);
      }
    },
  };
}

/** 중첩 표에서 cellIndex 번째 셀을 가리키는 경로. */
function nestedCellPathJson(pos: TableCursorPosition, cellIndex: number): string {
  const path = pos.cellPath ?? [];
  const last = path[path.length - 1];
  return JSON.stringify([...path.slice(0, -1), { ...last, cellIndex, cellParaIndex: 0 }]);
}

function cellInfoAt(wasm: CommandServices['wasm'], pos: TableCursorPosition) {
  const path = tablePathJson(pos);
  return path
    ? wasm.getCellInfoByPath(pos.sectionIndex, pos.parentParaIndex!, path)
    : wasm.getCellInfo(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, pos.cellIndex!);
}

function tableCellPositionAt(
  wasm: CommandServices['wasm'],
  pos: TableCursorPosition,
  row: number,
  col: number,
  resetToStart = false,
): TableCursorPosition {
  const pathJson = tableModelPathJson(pos);
  const target = wasm.getTableCellTargetByPath(
    pos.sectionIndex,
    pos.parentParaIndex!,
    pathJson,
    row,
    col,
    resetToStart ? 0 : (pos.cellParaIndex ?? pos.paragraphIndex),
  );
  return remapTableCellPosition(pos, target, resetToStart);
}

function safeTableOp(fn: () => void, label: string): boolean {
  try {
    fn();
    return true;
  } catch (e) {
    console.error(`[table] ${label} 실패:`, e);
    return false;
  }
}

function equalizeTargetRange(ih: ReturnType<CommandServices['getInputHandler']>, dims: TableDimensions): CellRange {
  const range = ih?.isInCellSelectionMode?.() ? ih.getSelectedCellRange?.() : null;
  return range ?? {
    startRow: 0,
    startCol: 0,
    endRow: Math.max(0, dims.rowCount - 1),
    endCol: Math.max(0, dims.colCount - 1),
  };
}

function hasNonRectangularCellSelection(ih: ReturnType<CommandServices['getInputHandler']>): boolean {
  return Boolean(ih?.isInCellSelectionMode?.() && ih.hasExcludedCellSelection?.());
}

function isTransposeTargetOverflowError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('표 크기') && message.includes('초과');
}

function isCellInRange(cell: { row: number; col: number }, range: CellRange): boolean {
  return cell.row >= range.startRow && cell.row <= range.endRow &&
    cell.col >= range.startCol && cell.col <= range.endCol;
}

function stub(id: string, label: string, icon?: string, shortcut?: string): CommandDef {
  return {
    id,
    label,
    icon,
    shortcutLabel: shortcut,
    canExecute: inTable,
    execute() { /* TODO: 후속 타스크에서 구현 */ },
  };
}

function blockCalcCommand(id: string, label: string, func: string, shortcut?: string): CommandDef {
  return {
    id,
    label,
    ...(shortcut ? { shortcutLabel: shortcut } : {}),
    canExecute: inTable,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      // 중첩 표는 셀 경로로 안쪽 표의 셀을 읽고 쓴다 (평면 좌표는 바깥 표).
      const ref = { sec: pos.sectionIndex, ppi: pos.parentParaIndex, ci: pos.controlIndex, cellPath: pos.cellPath };
      try {
        const { row, col } = tableTarget(services.wasm, ref).cellInfo(tableCellIndex(pos)!);
        const formula = { targetRow: row, targetCol: col, formula: `=${func}(above)` };
        // [블록계산 이관] 결과 기록은 셀 문자 수를 바꾼다 — 미기록 시 후속 undo 오프셋 오염(#2344 셀 숫자
        // 서식과 동일 계열). 먼저 계산만 해 보고, 기록은 snapshot 으로 라우팅한다(라우터가 refresh).
        tableTarget(services.wasm, ref).evaluateFormula({ ...formula, writeResult: false });
        safeTableOp(() => ih.executeOperation({
          kind: 'snapshot',
          operationType: 'tableBlockCalc',
          operation: (wasm) => {
            // 기록하지 못하면 던져서 빈 되돌리기 항목을 남기지 않는다 (snapshot 복원·폐기).
            tableTarget(wasm, ref).evaluateFormula({ ...formula, writeResult: true });
            return pos;
          },
        }), '블록 계산');
      } catch (err) {
        console.warn(`[${id}] 블록 계산 실패:`, err);
      }
    },
  };
}

function openFormulaDialog(services: Parameters<CommandDef['execute']>[0]): void {
  const ih = services.getInputHandler();
  if (!ih) return;
  const pos = ih.getCursorPosition();
  if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
  const dialog = new FormulaDialog(services.wasm, services.eventBus, {
    sec: pos.sectionIndex,
    ppi: pos.parentParaIndex,
    ci: pos.controlIndex,
    cellPath: pos.cellPath,
    cellIndex: tableCellIndex(pos)!,
  }, services);
  dialog.show();
}

function currentTableCellContext(services: CommandServices): TableCellCommandContext | null {
  const ih = services.getInputHandler();
  if (!ih) return null;
  const pos = ih.getCursorPosition();
  if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return null;
  const cellInfo = cellInfoAt(services.wasm, pos);
  return { ih, pos, cellInfo };
}

function restoreEditorFocus(ih: TableCellCommandContext['ih']): void {
  const textarea = (ih as unknown as { textarea?: HTMLTextAreaElement }).textarea;
  textarea?.focus();
}

function applyTableInsertRowColumn(
  services: CommandServices,
  mode: TableInsertRowColumnMode,
  count: number,
): void {
  const ctx = currentTableCellContext(services);
  if (!ctx) return;
  const { ih, pos, cellInfo } = ctx;
  if (ih.hasMultiCellSelection?.()) return;
  const succeeded = safeTableOp(() => ih.executeOperation({
    kind: 'snapshot',
    operationType: mode.startsWith('row') ? 'insertTableRow' : 'insertTableColumn',
    operation: (wasm) => {
      const path = tablePathJson(pos);
      const columns = mode.startsWith('col');
      const after = mode === 'row-below' || mode === 'col-right';
      // 새 줄·칸은 커서 셀의 줄·칸을 본뜬다 (한컴). 아래·오른쪽은 셀이 걸친 마지막 줄·칸 뒤에 넣는다.
      const band = columns
        ? cellInfo.col + (after ? cellInfo.colSpan - 1 : 0)
        : cellInfo.row + (after ? cellInfo.rowSpan - 1 : 0);
      const sec = pos.sectionIndex, ppi = pos.parentParaIndex!, ci = pos.controlIndex!;
      if (columns) {
        path ? wasm.insertTableColumnByPath(sec, ppi, path, band, after, count) : wasm.insertTableColumn(sec, ppi, ci, band, after, count);
      } else {
        path ? wasm.insertTableRowByPath(sec, ppi, path, band, after, count) : wasm.insertTableRow(sec, ppi, ci, band, after, count);
      }
      const row = cellInfo.row + (mode === 'row-above' ? count : 0);
      const col = cellInfo.col + (mode === 'col-left' ? count : 0);
      return tableCellPositionAt(wasm, pos, row, col);
    },
  }), '줄/칸 추가');
  if (succeeded && ih.isInCellSelectionMode?.()) ih.exitCellSelectionMode?.();
  restoreEditorFocus(ih);
}

/**
 * 줄/칸 지우기 후 커서 셀 보정 (#1483).
 *
 * 삭제로 셀 수가 줄면 기존 cellIndex가 새 표 범위를 벗어나 updateRect가 "셀 인덱스 초과"로
 * 실패한다. 삭제 후 표 크기(rowCount/colCount) 내로 (row,col)을 clamp하고, 재구축된 모델
 * 그리드에서 해당 위치의 새 cellIndex를 얻는다.
 * 표가 소멸(rowCount/colCount<=0)하면 null을 반환한다.
 */
function clampedCellAfterDelete(
  wasm: CommandServices['wasm'],
  pos: TableCursorPosition,
  origRow: number,
  origCol: number,
  rowCount: number,
  colCount: number,
  preserveContent: boolean,
): TableCursorPosition | null {
  if (rowCount <= 0 || colCount <= 0) return null;
  const row = Math.min(origRow, rowCount - 1);
  const col = Math.min(origCol, colCount - 1);
  return tableCellPositionAt(wasm, pos, row, col, !preserveContent);
}

function applyTableDeleteRowColumn(
  services: CommandServices,
  mode: TableDeleteRowColumnMode,
): void {
  const ctx = currentTableCellContext(services);
  if (!ctx) return;
  const { ih, pos, cellInfo } = ctx;
  if (ih.hasMultiCellSelection?.()) return;
  const start = mode === 'row' ? cellInfo.row : cellInfo.col;
  const succeeded = safeTableOp(() => ih.executeOperation({
    kind: 'snapshot',
    operationType: mode === 'row' ? 'deleteTableRow' : 'deleteTableColumn',
    operation: (wasm) => {
      const path = tablePathJson(pos);
      const res = mode === 'row'
        ? (path
            ? wasm.deleteTableRowByPath(pos.sectionIndex, pos.parentParaIndex!, path, start)
            : wasm.deleteTableRow(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, start))
        : (path
            ? wasm.deleteTableColumnByPath(pos.sectionIndex, pos.parentParaIndex!, path, start)
            : wasm.deleteTableColumn(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!, start));
      if (!res.ok) return pos;
      // 한컴처럼 줄을 지우면 그 자리 줄의 첫 셀, 칸을 지우면 그 자리 칸의 첫 셀 처음으로 간다.
      // 삭제 후 셀 수가 줄면 기존 cellIndex가 범위를 벗어날 수 있어 보정한다 (#1483).
      const corrected = clampedCellAfterDelete(
        wasm,
        pos,
        mode === 'row' ? start : 0,
        mode === 'row' ? 0 : start,
        res.rowCount,
        res.colCount,
        false,
      );
      if (!corrected) {
        // 표 소멸 → 표 밖 본문 위치로 폴백.
        return { sectionIndex: pos.sectionIndex, paragraphIndex: pos.parentParaIndex ?? 0, charOffset: 0 };
      }
      return corrected;
    },
  }), '줄/칸 지우기');
  if (succeeded && ih.isInCellSelectionMode?.()) ih.exitCellSelectionMode?.();
  restoreEditorFocus(ih);
}

export const tableCommands: CommandDef[] = [
  { id: 'table:create', label: '표 만들기', icon: 'icon-table',
    canExecute: (ctx) => ctx.hasDocument && !ctx.inTable,
    execute(services, params) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex !== undefined) return;
      const dialog = new TableCreateDialog();
      dialog.onApply = (rows, cols, options?: TableCreateOptions) => {
        const ih2 = services.getInputHandler();
        if (!ih2) return;
        safeTableOp(() => ih2.executeOperation({
          kind: 'snapshot',
          operationType: 'createTable',
          operation: (wasm) => {
            const result = options
              ? wasm.createTableEx({
                  sectionIdx: pos.sectionIndex,
                  paraIdx: pos.paragraphIndex,
                  charOffset: pos.charOffset,
                  rowCount: rows,
                  colCount: cols,
                  ...options,
                })
              : wasm.createTable(pos.sectionIndex, pos.paragraphIndex, pos.charOffset, rows, cols);
            if (result.ok) {
              return {
                sectionIndex: pos.sectionIndex,
                paragraphIndex: 0,
                charOffset: 0,
                parentParaIndex: result.paraIdx,
                controlIndex: result.controlIdx,
                cellIndex: 0,
                cellParaIndex: 0,
                cellPath: [{ controlIndex: result.controlIdx, cellIndex: 0, cellParaIndex: 0 }],
              };
            }
            return pos;
          },
        }), '표 만들기');
        // 대화상자 닫힘 후 편집 포커스 복원 — textarea 에 keydown 이 바인딩되어
        // 있어, 복원하지 않으면 직후 F5 등이 브라우저 기본동작으로 빠진다 (#1140)
        (ih2 as any).textarea?.focus();
      };
      dialog.show(params?.anchorEl as HTMLElement | undefined);
    },
  },
  {
    id: 'table:cell-props',
    label: '표/셀 속성',
    canExecute: (ctx) => ctx.inTable || ctx.inCellSelectionMode || ctx.inTableObjectSelection,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      if (ih.isInTableObjectSelection()) {
        const ref = ih.getSelectedTableRef();
        if (!ref) return;
        // 중첩 표 참조의 sec/ppi/ci 는 바깥 표다. 대화상자는 cellPath 로 안쪽 표를 다룬다.
        const tableCtx = { sec: ref.sec, ppi: ref.ppi, ci: ref.ci, cellPath: ref.cellPath };
        const dialog = new TableCellPropsDialog(services.wasm, services.eventBus, tableCtx, 0, 'table', services);
        dialog.show();
        return;
      }

      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      const tableCtx = { sec: pos.sectionIndex, ppi: pos.parentParaIndex, ci: pos.controlIndex, cellPath: pos.cellPath };
      const dialog = new TableCellPropsDialog(services.wasm, services.eventBus, tableCtx, tableCellIndex(pos)!, 'cell', services);
      dialog.show();
    },
  },
  {
    id: 'table:border-each',
    label: '각 셀마다 적용(E)...',
    canExecute: inTable,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      const tableCtx = { sec: pos.sectionIndex, ppi: pos.parentParaIndex, ci: pos.controlIndex, cellPath: pos.cellPath };
      const selectionRange = ih.isInCellSelectionMode?.() ? ih.getSelectedCellRange?.() ?? null : null;
      const dialog = new CellBorderBgDialog(
        services.wasm,
        services.eventBus,
        tableCtx,
        tableCellIndex(pos)!,
        'each',
        selectionRange,
        services,
      );
      dialog.show();
    },
  },
  {
    id: 'table:border-one',
    label: '하나의 셀처럼 적용(Z)...',
    canExecute: hasMultiCellSelection,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      if (!ih.hasMultiCellSelection()) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      const tableCtx = { sec: pos.sectionIndex, ppi: pos.parentParaIndex, ci: pos.controlIndex, cellPath: pos.cellPath };
      const dialog = new CellBorderBgDialog(
        services.wasm,
        services.eventBus,
        tableCtx,
        tableCellIndex(pos)!,
        'asOne',
        ih.getSelectedCellRange(),
        services,
      );
      dialog.show();
    },
  },
  {
    id: 'table:insert-row-col',
    label: '줄/칸 추가하기(I)...',
    shortcutLabel: 'Alt+Enter',
    canExecute: inTableWithoutBlock,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const dialog = new TableInsertRowColumnDialog();
      dialog.onApply = ({ mode, count }) => applyTableInsertRowColumn(services, mode, count);
      dialog.afterClose = () => restoreEditorFocus(ih);
      dialog.show();
    },
  },
  {
    id: 'table:delete-row-col',
    label: '줄/칸 지우기(E)...',
    shortcutLabel: 'Alt+Delete',
    canExecute: inTableWithoutBlock,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const dialog = new TableDeleteRowColumnDialog();
      dialog.onApply = ({ mode }) => applyTableDeleteRowColumn(services, mode);
      dialog.afterClose = () => restoreEditorFocus(ih);
      dialog.show();
    },
  },
  {
    id: 'table:insert-row-above',
    label: '위쪽에 줄 추가하기',
    canExecute: inTableWithoutBlock,
    execute(services) {
      applyTableInsertRowColumn(services, 'row-above', 1);
    },
  },
  {
    id: 'table:insert-row-below',
    label: '아래쪽에 줄 추가하기',
    canExecute: inTableWithoutBlock,
    execute(services) {
      applyTableInsertRowColumn(services, 'row-below', 1);
    },
  },
  {
    id: 'table:insert-col-left',
    label: '왼쪽에 칸 추가하기',
    canExecute: inTableWithoutBlock,
    execute(services) {
      applyTableInsertRowColumn(services, 'col-left', 1);
    },
  },
  {
    id: 'table:insert-col-right',
    label: '오른쪽에 칸 추가하기',
    canExecute: inTableWithoutBlock,
    execute(services) {
      applyTableInsertRowColumn(services, 'col-right', 1);
    },
  },
  {
    id: 'table:delete-row',
    label: '줄 지우기',
    canExecute: inTableWithoutBlock,
    execute(services) {
      applyTableDeleteRowColumn(services, 'row');
    },
  },
  {
    id: 'table:delete-col',
    label: '칸 지우기',
    canExecute: inTableWithoutBlock,
    execute(services) {
      applyTableDeleteRowColumn(services, 'col');
    },
  },
  {
    id: 'table:cell-split',
    label: '셀 나누기',
    shortcutLabel: 'S',
    canExecute: inTable,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;

      // F5 셀 선택 모드: 범위 선택 여부 확인
      const range = ih.getSelectedCellRange?.();
      const tableCtx = ih.getCellTableContext?.();
      const isMultiCell = range && tableCtx &&
        (range.startRow !== range.endRow || range.startCol !== range.endCol);

      const cellInfo = cellInfoAt(services.wasm, pos);
      const isMerged = !isMultiCell && (cellInfo.rowSpan > 1 || cellInfo.colSpan > 1);

      const dialog = new CellSplitDialog(Boolean(isMultiCell) || isMerged);
      dialog.onApply = (nRows, mCols, equalHeight, mergeFirst) => {
        const ih2 = services.getInputHandler();
        if (!ih2) return;
        const succeeded = safeTableOp(() => ih2.executeOperation({
          kind: 'snapshot',
          operationType: 'splitTableCell',
          operation: (wasm) => {
            if (isMultiCell && range && tableCtx) {
              const path = tableCtx.cellPath?.length ? JSON.stringify(tableCtx.cellPath) : null;
              if (mergeFirst) {
                // 블록을 한 셀로 합친 뒤 그 셀을 줄·칸 수만큼 나눈다.
                if (path) {
                  wasm.mergeTableCellsByPath(tableCtx.sec, tableCtx.ppi, path, range.startRow, range.startCol, range.endRow, range.endCol);
                  wasm.splitTableCellIntoByPath(tableCtx.sec, tableCtx.ppi, path, range.startRow, range.startCol, nRows, mCols, equalHeight, false);
                } else {
                  wasm.mergeTableCells(tableCtx.sec, tableCtx.ppi, tableCtx.ci, range.startRow, range.startCol, range.endRow, range.endCol);
                  wasm.splitTableCellInto(tableCtx.sec, tableCtx.ppi, tableCtx.ci, range.startRow, range.startCol, nRows, mCols, equalHeight, false);
                }
                return tableCellPositionAt(wasm, pos, range.startRow, range.startCol, true);
              }
              path
                ? wasm.splitTableCellsInRangeByPath(
                    tableCtx.sec, tableCtx.ppi, path,
                    range.startRow, range.startCol, range.endRow, range.endCol,
                    nRows, mCols, equalHeight,
                  )
                : wasm.splitTableCellsInRange(
                    tableCtx.sec, tableCtx.ppi, tableCtx.ci,
                    range.startRow, range.startCol, range.endRow, range.endCol,
                    nRows, mCols, equalHeight,
                  );
            } else {
              const path = tablePathJson(pos);
              path
                ? wasm.splitTableCellIntoByPath(
                    pos.sectionIndex, pos.parentParaIndex!, path,
                    cellInfo.row, cellInfo.col,
                    nRows, mCols, equalHeight, mergeFirst,
                  )
                : wasm.splitTableCellInto(
                    pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!,
                    cellInfo.row, cellInfo.col,
                    nRows, mCols, equalHeight, mergeFirst,
                  );
            }
            return tableCellPositionAt(
              wasm,
              pos,
              isMultiCell && range ? range.startRow : cellInfo.row,
              isMultiCell && range ? range.startCol : cellInfo.col,
            );
          },
        }), '셀 나누기');
        if (succeeded && isMultiCell) ih2.exitCellSelectionMode?.();
        // 대화상자 닫힘 후 편집 포커스 복원 (#1140 — 표 만들기와 동일 결함)
        (ih2 as any).textarea?.focus();
      };
      dialog.show();
    },
  },
  {
    id: 'table:cell-merge',
    label: '셀 합치기',
    shortcutLabel: 'M',
    canExecute: (ctx) => ctx.inCellSelectionMode,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const range = ih.getSelectedCellRange();
      const tableCtx = ih.getCellTableContext();
      if (!range || !tableCtx) return;
      if (range.startRow === range.endRow && range.startCol === range.endCol) return;
      const succeeded = safeTableOp(() => ih.executeOperation({
        kind: 'snapshot',
        operationType: 'mergeTableCells',
        operation: (wasm) => {
          const pos = ih.getCursorPosition();
          const path = tableCtx.cellPath?.length ? JSON.stringify(tableCtx.cellPath) : null;
          path
            ? wasm.mergeTableCellsByPath(tableCtx.sec, tableCtx.ppi, path, range.startRow, range.startCol, range.endRow, range.endCol)
            : wasm.mergeTableCells(tableCtx.sec, tableCtx.ppi, tableCtx.ci, range.startRow, range.startCol, range.endRow, range.endCol);
          return tableCellPositionAt(wasm, pos, range.startRow, range.startCol, true);
        },
      }), '셀 합치기');
      if (succeeded) ih.exitCellSelectionMode();
    },
  },
  {
    id: 'table:transpose-copy',
    label: '행/열 바꿈 복사',
    canExecute: (ctx) => ctx.inCellSelectionMode,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const range = ih.getSelectedCellRange?.();
      const tableCtx = ih.getCellTableContext?.();
      if (!range || !tableCtx) return;
      if (hasNonRectangularCellSelection(ih)) return;
      if (tableCtx.cellPath && tableCtx.cellPath.length > 1) return;

      safeTableOp(() => {
        services.wasm.copyTableCellsTransposed(
          tableCtx.sec,
          tableCtx.ppi,
          tableCtx.ci,
          range.startRow,
          range.startCol,
          range.endRow,
          range.endCol,
        );
      }, '행/열 바꿈 복사');
      restoreEditorFocus(ih);
    },
  },
  {
    id: 'table:transpose-paste',
    label: '행/열 바꿈 붙여넣기',
    canExecute: (ctx) => ctx.hasDocument && ctx.hasTableTransposeClipboard,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if ((pos.cellPath?.length ?? 0) > 1) return;

      safeTableOp(() => ih.executeOperation({
        kind: 'snapshot',
        operationType: 'pasteTableCellsTransposed',
        operation: (wasm) => {
          const pasteAsNewTable = (sectionIndex: number, paragraphIndex: number, charOffset: number) => {
            const result = wasm.pasteTableCellsTransposedAsTable(
              sectionIndex,
              paragraphIndex,
              charOffset,
            );
            if (result.ok && result.paraIdx !== undefined && result.controlIdx !== undefined) {
              return {
                sectionIndex,
                paragraphIndex: 0,
                charOffset: 0,
                parentParaIndex: result.paraIdx,
                controlIndex: result.controlIdx,
                cellIndex: 0,
                cellParaIndex: 0,
              };
            }
            return pos;
          };

          const selectionTableCtx = ih.isInCellSelectionMode?.() ? ih.getCellTableContext?.() : null;
          if (selectionTableCtx) {
            if ((selectionTableCtx.cellPath?.length ?? 0) > 1) return pos;
            const range = ih.getSelectedCellRange?.();
            const dims = wasm.getTableDimensions(
              selectionTableCtx.sec,
              selectionTableCtx.ppi,
              selectionTableCtx.ci,
            );
            const isWholeTable = range
              && range.startRow === 0
              && range.startCol === 0
              && range.endRow === dims.rowCount - 1
              && range.endCol === dims.colCount - 1;
            if (isWholeTable) {
              wasm.transposeTableCellsInPlace(
                selectionTableCtx.sec,
                selectionTableCtx.ppi,
                selectionTableCtx.ci,
              );
              return {
                sectionIndex: selectionTableCtx.sec,
                paragraphIndex: 0,
                charOffset: 0,
                parentParaIndex: selectionTableCtx.ppi,
                controlIndex: selectionTableCtx.ci,
                cellIndex: 0,
                cellParaIndex: 0,
              };
            }
            if (range) {
              try {
                wasm.pasteTableCellsTransposed(
                  selectionTableCtx.sec,
                  selectionTableCtx.ppi,
                  selectionTableCtx.ci,
                  range.startRow,
                  range.startCol,
                );
                return {
                  sectionIndex: selectionTableCtx.sec,
                  paragraphIndex: 0,
                  charOffset: 0,
                  parentParaIndex: selectionTableCtx.ppi,
                  controlIndex: selectionTableCtx.ci,
                  cellIndex: 0,
                  cellParaIndex: 0,
                };
              } catch (err) {
                if (!isTransposeTargetOverflowError(err)) throw err;
              }
            }
            return pasteAsNewTable(selectionTableCtx.sec, selectionTableCtx.ppi, 0);
          }

          if (pos.parentParaIndex !== undefined && pos.controlIndex !== undefined && pos.cellIndex !== undefined) {
            const cellInfo = services.wasm.getCellInfo(
              pos.sectionIndex,
              pos.parentParaIndex,
              pos.controlIndex,
              pos.cellIndex,
            );
            try {
              wasm.pasteTableCellsTransposed(
                pos.sectionIndex,
                pos.parentParaIndex,
                pos.controlIndex,
                cellInfo.row,
                cellInfo.col,
              );
            } catch (err) {
              if (!isTransposeTargetOverflowError(err)) throw err;
              return pasteAsNewTable(pos.sectionIndex, pos.parentParaIndex, 0);
            }
            return pos;
          }

          return pasteAsNewTable(pos.sectionIndex, pos.paragraphIndex, pos.charOffset);
        },
      }), '행/열 바꿈 붙여넣기');
      restoreEditorFocus(ih);
    },
  },
  {
    id: 'table:delete',
    label: '표 지우기',
    canExecute: (ctx) => ctx.inTable || ctx.inTableObjectSelection,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const ref = ih.getSelectedTableRef();
      const pos = ih.getCursorPosition();
      const path = ref ? ref.cellPath : pos.cellPath;
      // 안쪽 표를 지운 뒤에는 그 표를 담던 셀 문단으로 돌아간다.
      if (path && path.length > 1) {
        const parentPath = path.slice(0, -1);
        const outer = parentPath[0];
        const host = parentPath[parentPath.length - 1];
        safeTableOp(() => ih.executeOperation({
          kind: 'snapshot',
          operationType: 'deleteTable',
          operation: (wasm) => {
            wasm.deleteCellTableControlByPath(
              ref?.sec ?? pos.sectionIndex, ref?.ppi ?? pos.parentParaIndex!,
              JSON.stringify(parentPath), path[path.length - 1].controlIndex,
            );
            return {
              ...pos, sectionIndex: ref?.sec ?? pos.sectionIndex,
              parentParaIndex: ref?.ppi ?? pos.parentParaIndex,
              paragraphIndex: host.cellParaIndex, charOffset: 0,
              controlIndex: outer.controlIndex, cellIndex: outer.cellIndex,
              cellParaIndex: outer.cellParaIndex, cellPath: parentPath,
            };
          },
        }), '표 지우기');
        return;
      }
      if (ref) {
        safeTableOp(() => ih.executeOperation({
          kind: 'snapshot',
          operationType: 'deleteTable',
          operation: (wasm) => {
            wasm.deleteTableControl(ref.sec, ref.ppi, ref.ci);
            return { sectionIndex: ref.sec, paragraphIndex: ref.ppi, charOffset: 0 };
          },
        }), '표 지우기');
        return;
      }
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined) return;
      safeTableOp(() => ih.executeOperation({
        kind: 'snapshot',
        operationType: 'deleteTable',
        operation: (wasm) => {
          wasm.deleteTableControl(pos.sectionIndex, pos.parentParaIndex!, pos.controlIndex!);
          return { sectionIndex: pos.sectionIndex, paragraphIndex: pos.parentParaIndex!, charOffset: 0 };
        },
      }), '표 지우기');
    },
  },
  {
    id: 'table:caption-toggle',
    label: '캡션 넣기',
    canExecute: (ctx) => ctx.inTable || ctx.inTableObjectSelection,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      // 표 참조 획득 (표 객체 선택 또는 셀 내부). 중첩 표는 cellPath 로 안쪽 표를 가리킨다.
      const selected = ih.getSelectedTableRef();
      const pos = ih.getCursorPosition();
      if (!selected && (pos.parentParaIndex === undefined || pos.controlIndex === undefined)) return;
      const ref = selected ?? { sec: pos.sectionIndex, ppi: pos.parentParaIndex!, ci: pos.controlIndex!, cellPath: pos.cellPath };
      const target = tableTarget(services.wasm, ref);
      // 현재 캡션 상태 조회
      let props: ReturnType<typeof target.tableProperties>;
      try { props = target.tableProperties(); } catch { return; }
      if (!props) return;
      // 캡션 목록은 셀 목록 다음 번호다.
      const captionIndex = target.dimensions().cellCount;
      const captionPath = isNestedPath(ref.cellPath)
        ? JSON.stringify([...ref.cellPath!.slice(0, -1), { ...ref.cellPath!.at(-1)!, cellIndex: captionIndex, cellParaIndex: 0 }])
        : null;
      let charOffset = 0;
      if (!props.hasCaption) {
        const created = safeTableOp(() => ih.executeOperation({
          kind: 'snapshot',
          operationType: 'toggleTableCaption',
          operation: (wasm) => {
            tableTarget(wasm, ref).setTableProperties({ hasCaption: true });
            return pos;
          },
        }), '캡션 넣기');
        if (!created) return;
      }
      // 캡션 글 끝에서 편집을 시작한다.
      try {
        charOffset = captionPath
          ? services.wasm.getCellParagraphLengthByPath(ref.sec, ref.ppi, captionPath)
          : services.wasm.getCellParagraphLength(ref.sec, ref.ppi, ref.ci, captionIndex, 0);
      } catch { charOffset = 0; }
      // 표 내부 편집 모드 종료 후 캡션 편집 진입
      if (selected) {
        ih.exitTableObjectSelection();
      }
      ih.enterTableCaptionEditing(ref.sec, ref.ppi, ref.ci, charOffset, captionIndex, ref.cellPath);
    },
  },
  {
    id: 'table:cell-height-equal',
    label: '셀 높이를 같게',
    shortcutLabel: 'H',
    canExecute: inTableOrCellSelection,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      const sec = pos.sectionIndex, ppi = pos.parentParaIndex, ci = pos.controlIndex;
      // 중첩 표는 평면 좌표가 바깥 표를 가리키므로 경로 API 로 안쪽 표를 다룬다.
      const path = isNestedPath(pos.cellPath) ? tablePathJson(pos) : null;
      try {
        if (hasNonRectangularCellSelection(ih)) return;
        const dims = path
          ? services.wasm.getTableDimensionsByPath(sec, ppi, path)
          : services.wasm.getTableDimensions(sec, ppi, ci);
        const range = equalizeTargetRange(ih, dims);
        const bboxes = path
          ? services.wasm.getTableCellBboxesByPath(sec, ppi, path)
          : services.wasm.getTableCellBboxes(sec, ppi, ci);
        const bboxByCellIdx = new Map(bboxes.map(bbox => [bbox.cellIdx, bbox]));
        const cells: Array<{ idx: number; height: number; renderHeight: number }> = [];
        for (let i = 0; i < dims.cellCount; i++) {
          const info = path
            ? services.wasm.getCellInfoByPath(sec, ppi, nestedCellPathJson(pos, i))
            : services.wasm.getCellInfo(sec, ppi, ci, i);
          if (!isCellInRange(info, range)) continue;
          if (info.rowSpan > 1) continue;
          const h = (path
            ? services.wasm.getCellPropertiesByPath(sec, ppi, path, i)
            : services.wasm.getCellProperties(sec, ppi, ci, i)).height;
          const bbox = bboxByCellIdx.get(i);
          const renderHeight = bbox ? Math.round(bbox.h * 75) : h;
          cells.push({ idx: i, height: h, renderHeight });
        }
        if (cells.length < 2) return;
        const totalHeight = cells.reduce((sum, cell) => sum + cell.renderHeight, 0);
        const avgHeight = Math.round(totalHeight / cells.length);
        const updates: Parameters<CommandServices['wasm']['resizeTableCells']>[3] = [];
        let changed = false;
        for (const c of cells) {
          if (c.renderHeight !== avgHeight) changed = true;
          updates.push({
            cellIdx: c.idx,
            heightDelta: 0,
            localResize: true,
            renderHeight: avgHeight,
          });
        }
        if (!changed) return;
        safeTableOp(() => ih.executeOperation({
          kind: 'snapshot',
          operationType: 'equalizeTableCellHeights',
          operation: (wasm) => {
            if (path) wasm.resizeTableCellsByPath(sec, ppi, path, updates);
            else wasm.resizeTableCells(sec, ppi, ci, updates);
            return pos;
          },
        }), '셀 높이를 같게');
        restoreEditorFocus(ih);
      } catch (err) {
        console.warn('[table:cell-height-equal] 높이 균등화 실패:', err);
      }
    },
  },
  {
    id: 'table:cell-width-equal',
    label: '셀 너비를 같게',
    shortcutLabel: 'W',
    canExecute: inTableOrCellSelection,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      const sec = pos.sectionIndex, ppi = pos.parentParaIndex, ci = pos.controlIndex;
      // 중첩 표는 평면 좌표가 바깥 표를 가리키므로 경로 API 로 안쪽 표를 다룬다.
      const path = isNestedPath(pos.cellPath) ? tablePathJson(pos) : null;
      try {
        if (hasNonRectangularCellSelection(ih)) return;
        const dims = path
          ? services.wasm.getTableDimensionsByPath(sec, ppi, path)
          : services.wasm.getTableDimensions(sec, ppi, ci);
        const range = equalizeTargetRange(ih, dims);
        const bboxes = path
          ? services.wasm.getTableCellBboxesByPath(sec, ppi, path)
          : services.wasm.getTableCellBboxes(sec, ppi, ci);
        const bboxByCellIdx = new Map(bboxes.map(bbox => [bbox.cellIdx, bbox]));
        const cells: Array<{ idx: number; col: number; width: number; renderWidth: number }> = [];
        for (let i = 0; i < dims.cellCount; i++) {
          const info = path
            ? services.wasm.getCellInfoByPath(sec, ppi, nestedCellPathJson(pos, i))
            : services.wasm.getCellInfo(sec, ppi, ci, i);
          if (!isCellInRange(info, range)) continue;
          if (info.rowSpan > 1) continue;
          const w = (path
            ? services.wasm.getCellPropertiesByPath(sec, ppi, path, i)
            : services.wasm.getCellProperties(sec, ppi, ci, i)).width;
          const bbox = bboxByCellIdx.get(i);
          const renderWidth = bbox ? Math.round(bbox.w * 75) : w;
          cells.push({ idx: i, col: info.col, width: w, renderWidth });
        }
        if (cells.length < 2) return;
        const totalWidth = cells.reduce((sum, cell) => sum + cell.renderWidth, 0);
        const avgWidth = Math.round(totalWidth / cells.length);
        const updates: Parameters<CommandServices['wasm']['resizeTableCells']>[3] = [];
        let changed = false;
        for (const c of cells) {
          const delta = avgWidth - c.width;
          if (delta !== 0 || c.renderWidth !== avgWidth) changed = true;
          updates.push({
            cellIdx: c.idx,
            widthDelta: delta,
            localResize: true,
            renderWidth: avgWidth,
          });
        }
        if (!changed) return;
        safeTableOp(() => ih.executeOperation({
          kind: 'snapshot',
          operationType: 'equalizeTableCellWidths',
          operation: (wasm) => {
            if (path) wasm.resizeTableCellsByPath(sec, ppi, path, updates);
            else wasm.resizeTableCells(sec, ppi, ci, updates);
            return pos;
          },
        }), '셀 너비를 같게');
        restoreEditorFocus(ih);
      } catch (err) {
        console.warn('[table:cell-width-equal] 너비 균등화 실패:', err);
      }
    },
  },
  {
    id: 'table:formula',
    label: '계산식(F)...',
    shortcutLabel: 'Ctrl+M,F',
    canExecute: inTable,
    execute(services) { openFormulaDialog(services); },
  },
  {
    id: 'table:block-formula',
    label: '블록 계산식',
    canExecute: inTable,
    execute(services) { openFormulaDialog(services); },
  },
  // Ctrl+Shift+S 는 다른 이름으로 저장 단축키라 블록 합계에는 표시하지 않는다.
  blockCalcCommand('table:block-sum', '블록 합계', 'SUM'),
  blockCalcCommand('table:block-avg', '블록 평균', 'AVERAGE', 'Ctrl+Shift+A'),
  blockCalcCommand('table:block-product', '블록 곱', 'PRODUCT', 'Ctrl+Shift+P'),
  {
    id: 'table:thousand-sep',
    label: '1,000 단위 구분 쉼표',
    canExecute: inTable,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      try {
        const cell = currentCellParagraphText(services, pos);
        if (cell.len <= 0) return;
        const text = cell.text;
        const trimmed = text.trim();
        if (!trimmed) return;
        const stripped = trimmed.replace(/,/g, '');
        const numMatch = stripped.match(/^([+-]?)(\d+)(\.?\d*)$/);
        if (!numMatch) return;
        const [, sign, intPart, decPart] = numMatch;
        let result: string;
        if (trimmed.includes(',')) {
          result = sign + intPart + decPart;
        } else {
          const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
          result = sign + formatted + decPart;
        }
        if (result === text) return;
        // [#2344] delete+insert 를 하나의 snapshot 으로 원자화해 라우팅 — 미기록 시 셀 문자
        // 수가 바뀌어 후속 undo 오프셋이 오염되고 텍스트가 손상된다("1234567"→쉼표→Ctrl+Z="67").
        // 라우터가 refresh 하므로 수동 document-changed emit 은 제거.
        safeTableOp(() => ih.executeOperation({
          kind: 'snapshot',
          operationType: 'cellNumberFormat',
          operation: (wasm) => {
            cell.replace(wasm, result);
            return pos;
          },
        }), '셀 숫자 서식');
      } catch (err) {
        console.warn('[table:thousand-sep] 구분 쉼표 변환 실패:', err);
      }
    },
  },
  {
    id: 'table:decimal-add',
    label: '자릿점 넣기',
    canExecute: inTable,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      try {
        const cell = currentCellParagraphText(services, pos);
        if (cell.len <= 0) return;
        const text = cell.text;
        const trimmed = text.trim();
        const raw = trimmed.replace(/,/g, '');
        const match = raw.match(/^([+-]?)(\d+)(\.(\d*))?$/);
        if (!match) return;
        const [, sign, intPart, , decimals] = match;
        const newDecimals = (decimals ?? '') + '0';
        const hasCommas = trimmed.includes(',');
        const fmtInt = hasCommas ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : intPart;
        const result = sign + fmtInt + '.' + newDecimals;
        if (result === text) return;
        // [#2344] delete+insert 를 하나의 snapshot 으로 원자화해 라우팅 — 미기록 시 셀 문자
        // 수가 바뀌어 후속 undo 오프셋이 오염되고 텍스트가 손상된다("1234567"→쉼표→Ctrl+Z="67").
        // 라우터가 refresh 하므로 수동 document-changed emit 은 제거.
        safeTableOp(() => ih.executeOperation({
          kind: 'snapshot',
          operationType: 'cellNumberFormat',
          operation: (wasm) => {
            cell.replace(wasm, result);
            return pos;
          },
        }), '셀 숫자 서식');
      } catch (err) {
        console.warn('[table:decimal-add] 자릿점 넣기 실패:', err);
      }
    },
  },
  {
    id: 'table:decimal-remove',
    label: '자릿점 빼기',
    canExecute: inTable,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      const pos = ih.getCursorPosition();
      if (pos.parentParaIndex === undefined || pos.controlIndex === undefined || pos.cellIndex === undefined) return;
      try {
        const cell = currentCellParagraphText(services, pos);
        if (cell.len <= 0) return;
        const text = cell.text;
        const trimmed = text.trim();
        const raw = trimmed.replace(/,/g, '');
        const match = raw.match(/^([+-]?)(\d+)\.(\d+)$/);
        if (!match) return;
        const [, sign, intPart, decimals] = match;
        const hasCommas = trimmed.includes(',');
        const fmtInt = hasCommas ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : intPart;
        const newDecimals = decimals.slice(0, -1);
        const result = newDecimals ? sign + fmtInt + '.' + newDecimals : sign + fmtInt;
        if (result === text) return;
        // [#2344] delete+insert 를 하나의 snapshot 으로 원자화해 라우팅 — 미기록 시 셀 문자
        // 수가 바뀌어 후속 undo 오프셋이 오염되고 텍스트가 손상된다("1234567"→쉼표→Ctrl+Z="67").
        // 라우터가 refresh 하므로 수동 document-changed emit 은 제거.
        safeTableOp(() => ih.executeOperation({
          kind: 'snapshot',
          operationType: 'cellNumberFormat',
          operation: (wasm) => {
            cell.replace(wasm, result);
            return pos;
          },
        }), '셀 숫자 서식');
      } catch (err) {
        console.warn('[table:decimal-remove] 자릿점 빼기 실패:', err);
      }
    },
  },
];
