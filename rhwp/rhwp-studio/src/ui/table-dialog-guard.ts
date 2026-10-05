import type { CellPathEntry } from '@/core/types';
import { showToast } from './toast';

/**
 * 표/셀 속성과 셀 테두리/배경 대화상자는 {sec, ppi, ci} 평면 좌표로 읽고 쓴다.
 * 중첩 표에서 이 좌표는 바깥 표를 가리키므로(cellPath 의 첫 항목), 그대로 열면
 * 안쪽 표 대신 바깥 표와 그 셀을 고친다. 경로가 2단 이상이면 열지 않고 알린다.
 */
export function rejectNestedTableDialog(cellPath: readonly CellPathEntry[] | undefined): boolean {
  if ((cellPath?.length ?? 0) <= 1) return false;
  showToast({ message: '중첩된 표에서는 이 대화상자를 쓸 수 없습니다.' });
  return true;
}
