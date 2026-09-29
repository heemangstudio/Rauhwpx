import type { CellProperties } from '@/core/types';

export interface CellBorderLine {
  type: number;
  width: number;
  color: string;
}

export type CellFillEdit =
  | { fillType: 'solid'; fillColor: string; patternColor: string; patternType: number }
  | { fillType: 'none' };

export interface CellDiagonalEdit {
  diagonalLine: number;
  diagonalSlash: number;
  diagonalBackSlash: number;
  diagonalWidth: number;
  diagonalColor: string;
  centerLine: string;
}

/**
 * 셀 테두리/배경 대화상자에서 사용자가 실제로 바꾼 묶음.
 * `borders` 는 왼/오/위/아래 순서이고 바꾸지 않은 변은 null 이다.
 */
export interface CellBorderFillEdits {
  borders: readonly (CellBorderLine | null)[];
  fill: CellFillEdit | null;
  diagonal: CellDiagonalEdit | null;
}

const BORDER_KEYS = ['borderLeft', 'borderRight', 'borderTop', 'borderBottom'] as const;
const NO_BORDER: CellBorderLine = { type: 0, width: 0, color: '#000000' };

export function hasCellBorderFillEdits(edits: CellBorderFillEdits): boolean {
  return edits.borders.some(Boolean) || edits.fill !== null || edits.diagonal !== null;
}

/**
 * 대상 셀 하나에 보낼 속성 JSON 을 만든다. 바꾼 것이 없으면 null.
 *
 * 엔진은 넘겨받은 borderFillId 를 바탕으로 JSON 을 덮어 새 테두리/배경을 만든다.
 * 캐럿 셀의 ID와 전체 테두리를 모든 셀에 보내면 배경만 바꿔도 선택한 셀(또는 표
 * 전체)의 테두리·대각선이 캐럿 셀 것으로 바뀐다. 대상 셀 자신의 ID를 바탕으로,
 * 바꾼 묶음만 덮는다. 엔진은 borderLeft 가 있어야 테두리 변경으로 보므로 테두리를
 * 바꾸면 네 변을 모두 싣되, 바꾸지 않은 변은 그 셀의 현재 값을 쓴다.
 */
export function buildCellBorderFillPatch(
  edits: CellBorderFillEdits,
  target: Pick<CellProperties, 'borderFillId' | 'borderLeft' | 'borderRight' | 'borderTop' | 'borderBottom'>,
): Record<string, unknown> | null {
  if (!hasCellBorderFillEdits(edits)) return null;
  const patch: Record<string, unknown> = { borderFillId: target.borderFillId ?? 0 };
  if (edits.borders.some(Boolean)) {
    BORDER_KEYS.forEach((key, i) => {
      const edited = edits.borders[i];
      const own = target[key];
      patch[key] = edited
        ? { ...edited }
        : own ? { type: own.type, width: own.width, color: own.color } : { ...NO_BORDER };
    });
  }
  if (edits.fill) Object.assign(patch, edits.fill);
  if (edits.diagonal) Object.assign(patch, edits.diagonal);
  return patch;
}
