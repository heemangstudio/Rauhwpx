import type { WasmBridge } from './wasm-bridge';
import type { CellPathEntry, DocumentPosition, SearchResult } from './types';

export type FindOffsetApi = Pick<WasmBridge, 'textToLogicalOffset' | 'logicalToTextOffset'
  | 'textToLogicalOffsetInCellByPath' | 'logicalToTextOffsetInCellByPath'>;

/** 찾기 시작점은 셀의 실제 경로와 최상위 호스트 문단을 유지한다. */
export function findSearchStart(position: DocumentPosition, offsets: FindOffsetApi): {
  section: number; paragraph: number; offset: number; path: CellPathEntry[];
} {
  const path = position.cellPath?.length ? position.cellPath.map(entry => ({ ...entry }))
    : position.parentParaIndex !== undefined && position.controlIndex !== undefined
      && position.cellIndex !== undefined && !position.isTextBox
      ? [{ controlIndex: position.controlIndex, cellIndex: position.cellIndex,
        cellParaIndex: position.cellParaIndex ?? position.paragraphIndex }]
      : [];
  return { section: position.sectionIndex,
    paragraph: path.length ? position.parentParaIndex! : position.paragraphIndex,
    offset: path.length
      ? offsets.logicalToTextOffsetInCellByPath(position.sectionIndex, position.parentParaIndex!, JSON.stringify(path), position.charOffset)
      : offsets.logicalToTextOffset(position.sectionIndex, position.paragraphIndex, position.charOffset), path };
}

export function findHitRange(hit: SearchResult, offsets: FindOffsetApi): { start: DocumentPosition; end: DocumentPosition } | null {
  if (!hit.found || hit.sec === undefined || hit.para === undefined
    || hit.charOffset === undefined || hit.length === undefined) return null;
  const path = hit.cellPath?.map(entry => ({ ...entry })) ?? [];
  // 기존 cellContext는 글상자와 표를 구분하지 못하므로 경로 없는 튜플로 이동하지 않는다.
  if (hit.cellContext && !path.length) return null;
  const toLogical = (textOffset: number) => path.length
    ? offsets.textToLogicalOffsetInCellByPath(hit.sec!, hit.para!, JSON.stringify(path), textOffset)
    : offsets.textToLogicalOffset(hit.sec!, hit.para!, textOffset);
  const first = path[0];
  const start: DocumentPosition = first ? {
    sectionIndex: hit.sec, paragraphIndex: path.at(-1)!.cellParaIndex,
    parentParaIndex: hit.para, controlIndex: first.controlIndex,
    cellIndex: first.cellIndex, cellParaIndex: first.cellParaIndex,
    cellPath: path, charOffset: toLogical(hit.charOffset),
  } : { sectionIndex: hit.sec, paragraphIndex: hit.para, charOffset: toLogical(hit.charOffset) };
  return { start, end: { ...start, cellPath: first ? path.map(entry => ({ ...entry })) : undefined,
    charOffset: toLogical(hit.charOffset + hit.length) } };
}

export interface FindNavigationHandler {
  moveCursorTo(position: DocumentPosition): boolean;
  cursor?: { setAnchor(): void; moveTo(position: DocumentPosition): void };
  updateCaret?: () => void;
}

/** 실재하는 셀 커서 API로 먼저 이동한 뒤 같은 경로의 끝점으로 선택한다. */
export function navigateToFindHit(handler: FindNavigationHandler, hit: SearchResult, offsets: FindOffsetApi): boolean {
  const range = findHitRange(hit, offsets);
  if (!range || !handler.moveCursorTo(range.start)) return false;
  handler.cursor?.setAnchor();
  handler.cursor?.moveTo(range.end);
  handler.updateCaret?.();
  return true;
}
