/**
 * 보드의 순서 계산과 편집 연산 만들기. DOM 을 모르는 순수 함수만 둔다.
 */
import { columnItems, itemColumnId } from '../../../agent/project-service.ts';
import type { ProjectItem, ProjectOp, ProjectSnapshot } from '../../../agent/types.ts';

export type BoardDirection = 'left' | 'right' | 'up' | 'down';

/** 보드에 보이는 항목인가. 작업 공간으로 거르면 일부 카드가 숨는다. */
export type BoardVisible = (item: ProjectItem) => boolean;

const SHOW_ALL: BoardVisible = () => true;

/**
 * 보이는 카드 사이의 자리를 열 전체 순서의 자리로 바꾼다 (끄는 항목은 뺀 순서).
 * 보이는 카드 바로 앞에, 맨 끝이면 마지막으로 보이는 카드 바로 뒤에 놓아 숨은 카드의 차례는 그대로 둔다.
 */
export function fullDropIndex(
  project: ProjectSnapshot,
  itemId: string,
  columnId: string,
  visibleIndex: number,
  visible: BoardVisible = SHOW_ALL,
): number {
  const others = columnItems(project, columnId).filter((entry) => entry.id !== itemId);
  const shown = others.filter(visible);
  if (!shown.length) return others.length;
  const at = Math.max(0, Math.trunc(visibleIndex));
  if (at < shown.length) return others.indexOf(shown[at]);
  return others.indexOf(shown[shown.length - 1]) + 1;
}

/**
 * 끌어 놓기 결과를 move 연산으로 바꾼다. index 는 끄는 항목을 뺀 뒤 대상 열에서의 자리다.
 * 자리가 그대로면 null.
 */
export function moveOpFor(
  project: ProjectSnapshot,
  itemId: string,
  columnId: string,
  index: number,
): Extract<ProjectOp, { op: 'move' }> | null {
  const item = project.items.find((entry) => entry.id === itemId);
  if (!item || !project.columns.some((column) => column.id === columnId)) return null;
  const others = columnItems(project, columnId).filter((entry) => entry.id !== itemId);
  const at = Math.max(0, Math.min(others.length, Math.trunc(index)));
  const source = itemColumnId(project, item);
  if (source === columnId) {
    const current = columnItems(project, columnId).findIndex((entry) => entry.id === itemId);
    if (current === at) return null;
  }
  return { op: 'move', id: itemId, column: columnId, index: at };
}

/** Alt+화살표: 옆 열로 같은 높이에, 또는 같은 열에서 보이는 이웃을 한 칸 넘어 위·아래로. */
export function keyboardMoveOp(
  project: ProjectSnapshot,
  itemId: string,
  direction: BoardDirection,
  visible: BoardVisible = SHOW_ALL,
): Extract<ProjectOp, { op: 'move' }> | null {
  const item = project.items.find((entry) => entry.id === itemId);
  if (!item) return null;
  const columnId = itemColumnId(project, item);
  if (!columnId) return null;
  const columnIndex = project.columns.findIndex((column) => column.id === columnId);
  const shown = columnItems(project, columnId).filter((entry) => entry.id === itemId || visible(entry));
  const current = shown.findIndex((entry) => entry.id === itemId);
  if (direction === 'up' || direction === 'down') {
    const neighbor = shown[current + (direction === 'up' ? -1 : 1)];
    if (!neighbor) return null;
    const others = columnItems(project, columnId).filter((entry) => entry.id !== itemId);
    return moveOpFor(project, itemId, columnId, others.indexOf(neighbor) + (direction === 'up' ? 0 : 1));
  }
  const target = project.columns[columnIndex + (direction === 'left' ? -1 : 1)];
  if (!target) return null;
  return moveOpFor(project, itemId, target.id, fullDropIndex(project, itemId, target.id, current, visible));
}

/** 열 목록 연산. 이름이 비면 null. */
export function renameColumnOp(project: ProjectSnapshot, columnId: string, name: string): ProjectOp | null {
  const trimmed = name.trim();
  const column = project.columns.find((entry) => entry.id === columnId);
  if (!column || !trimmed || column.name === trimmed) return null;
  return {
    op: 'columns',
    columns: project.columns.map((entry) => ({ id: entry.id, name: entry.id === columnId ? trimmed : entry.name })),
  };
}

export function addColumnOp(project: ProjectSnapshot, name: string): ProjectOp | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  return {
    op: 'columns',
    columns: [...project.columns.map((entry) => ({ id: entry.id, name: entry.name })), { name: trimmed }],
  };
}

/** 마지막 열은 지우지 않는다. 지운 열의 항목은 서버가 첫 열로 옮긴다. */
export function removeColumnOp(project: ProjectSnapshot, columnId: string): ProjectOp | null {
  if (project.columns.length <= 1 || !project.columns.some((entry) => entry.id === columnId)) return null;
  return {
    op: 'columns',
    columns: project.columns.filter((entry) => entry.id !== columnId).map((entry) => ({ id: entry.id, name: entry.name })),
  };
}

/** 열을 왼쪽·오른쪽으로 한 칸 옮긴다. */
export function shiftColumnOp(project: ProjectSnapshot, columnId: string, delta: -1 | 1): ProjectOp | null {
  const index = project.columns.findIndex((entry) => entry.id === columnId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= project.columns.length) return null;
  const columns = project.columns.map((entry) => ({ id: entry.id, name: entry.name }));
  const [moved] = columns.splice(index, 1);
  columns.splice(target, 0, moved);
  return { op: 'columns', columns };
}

/**
 * 끌기 중 포인터 높이로 놓일 자리를 찾는다. tops 는 대상 열에서 끄는 카드를 뺀
 * 나머지 카드의 세로 가운데 좌표다.
 */
export function dropIndexFor(pointerY: number, centers: readonly number[]): number {
  let index = 0;
  while (index < centers.length && pointerY > centers[index]) index++;
  return index;
}
