import type { CellBbox } from '@/core/types';

/** 한컴은 방향키 한 번에 셀 크기를 283 HWPUNIT(약 1mm)씩 바꾼다. */
export const KEYBOARD_RESIZE_STEP = 283;

type Arrow = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';
type CellRange = { startRow: number; startCol: number; endRow: number; endCol: number };
export type KeyboardResizeUpdate = { cellIdx: number; widthDelta?: number; heightDelta?: number };

/**
 * 셀 블록의 오른쪽(아래쪽) 경계를 방향키 한 번만큼 옮기는 셀 크기 증감 (한컴 Ctrl/Alt+방향키).
 * Ctrl 은 경계가 지나는 셀을 표 전체에 걸쳐 넓히고(높이고) 표가 그만큼 커진다. Alt(moveBoundary)는
 * 경계만 옮겨 경계에서 끝나는 셀은 커지고 경계에서 시작하는 셀은 줄며, 경계를 걸친 셀과 표 크기는
 * 그대로다. 마지막 칸(줄)의 경계는 Alt 로도 표를 키운다. 엔진은 증감을 그려진 크기에 더한다.
 */
export function keyboardResizeUpdates(
  bboxes: readonly CellBbox[],
  range: CellRange,
  bands: { rowCount: number; colCount: number },
  key: Arrow,
  moveBoundary: boolean,
): KeyboardResizeUpdate[] {
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
  const delta = key === 'ArrowRight' || key === 'ArrowDown' ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP;
  const edge = horizontal ? range.endCol : range.endRow;
  const boundary = moveBoundary && edge + 1 < (horizontal ? bands.colCount : bands.rowCount);
  const updates: KeyboardResizeUpdate[] = [];
  const seen = new Set<number>();
  for (const bbox of bboxes) {
    if (seen.has(bbox.cellIdx)) continue;
    seen.add(bbox.cellIdx);
    const start = horizontal ? bbox.col : bbox.row;
    const end = start + (horizontal ? bbox.colSpan : bbox.rowSpan) - 1;
    let change = 0;
    if (boundary) {
      if (end === edge) change = delta;
      else if (start === edge + 1) change = -delta;
    } else if (start <= edge && edge <= end) {
      change = delta;
    }
    if (change) updates.push(horizontal ? { cellIdx: bbox.cellIdx, widthDelta: change } : { cellIdx: bbox.cellIdx, heightDelta: change });
  }
  return updates;
}
