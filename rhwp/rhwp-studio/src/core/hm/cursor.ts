// 이 파일의 함수는 WasmBridge 의 같은 이름 메서드가 위임한다. 엔진이 아직 못 하는 기능은
// EngineNotSupportedError 를 던지고, 명령 계층이 해당 메뉴·버튼을 비활성으로 보여 준다.
//
// 캐럿 좌표·히트 테스트·줄 정보·수직 이동·선택 사각형. 좌표는 쪽 px(96 DPI)다.
import type { Address, Affinity, Caret, LineInfo as HmLineInfo, Located, Rect } from '../../../vendor/hm-wasm/hm_wasm';
import type { HmCore, ListAddress } from './core';
import { hu, px, unsupported } from './core';
import {
  addressToPosition, bodyList, cellList, logicalLength, logicalToWire, paraMap, pathTarget, toAddress,
  wireToLogical, wireToText,
} from './address';
import type { CursorRect, HitTestResult, NavContextEntry, LineInfo, DocumentPosition, MoveVerticalResult, SelectionRect, SelectionPageHints, CellPathEntry } from './bridge-types';

const BODY = 0xFFFFFFFF;

function toCursorRect(caret: Caret): CursorRect {
  return { pageIndex: caret.page, x: px(caret.x), y: px(caret.y), height: px(caret.height) };
}

function caretRect(core: HmCore, list: ListAddress, para: number, logical: number, page?: number, affinity: Affinity = 'downstream'): CursorRect {
  const at = toAddress(list, para, logicalToWire(paraMap(core.paragraph(list, para)), logical));
  const caret = core.caret(at, affinity, page);
  if (!caret) throw new Error(`커서 위치를 찾을 수 없습니다 (${list.section}:${para}:${logical})`);
  return toCursorRect(caret);
}

/** 이전 API 의 flat 셀 인자: 0xFFFFFFFF 이면 본문이다. */
function flatTarget(sec: number, para: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number): { list: ListAddress; para: number } {
  if (parentPara === BODY || parentPara < 0 || controlIdx === BODY) return { list: bodyList(sec), para };
  return { list: cellList(sec, parentPara, controlIdx, cellIdx), para: cellParaIdx === BODY ? para : cellParaIdx };
}

export function getCursorRect(core: HmCore, sec: number, para: number, charOffset: number): CursorRect {
  return caretRect(core, bodyList(sec), para, charOffset);
}

export function getCursorRectOnLine(core: HmCore, sec: number, para: number, lineIndex: number, atEnd: boolean, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number): CursorRect {
  const target = flatTarget(sec, para, parentPara, controlIdx, cellIdx, cellParaIdx);
  const lines = core.lines(target.list, target.para);
  const line = lines.find(item => item.line === lineIndex) ?? lines[lineIndex];
  if (!line) throw new Error(`줄 ${lineIndex} 이 없습니다`);
  const at = toAddress(target.list, target.para, atEnd ? line.end : line.start);
  const caret = core.caret(at, atEnd ? 'upstream' : 'downstream', line.page);
  if (!caret) throw new Error('줄 커서를 찾을 수 없습니다');
  return toCursorRect(caret);
}

export function hitTest(core: HmCore, pageNum: number, x: number, y: number): HitTestResult {
  const located = core.locate(pageNum, x, y, { body: true });
  if (!located) throw new Error('이 위치에 편집할 수 있는 글이 없습니다');
  return locatedToHit(core, located);
}

export function locatedToHit(core: HmCore, located: Located): HitTestResult & { cursorRect: CursorRect } {
  const position = addressToPosition(core, located.position);
  return { ...position, cursorRect: toCursorRect(located.caret) } as HitTestResult & { cursorRect: CursorRect };
}

export function getTextBoxControlIndex(core: HmCore, sec: number, para: number): number {
  const info = core.paragraph(bodyList(sec), para);
  const box = info.controls.find(control => control.kind === 'object' && control.lists > 0);
  return box ? box.index : -1;
}

export function findNextEditableControl(core: HmCore, sec: number, para: number, ctrlIdx: number, delta: number): { type: string; sec: number; para: number; ci: number } {
  throw unsupported('findNextEditableControl');
}

export function findNearestControlBackward(core: HmCore, sec: number, para: number, charOffset: number): { type: string; sec: number; para: number; ci: number } {
  throw unsupported('findNearestControlBackward');
}

export function findNearestControlForward(core: HmCore, sec: number, para: number, charOffset: number): { type: string; sec: number; para: number; ci: number; charPos?: number } {
  throw unsupported('findNearestControlForward');
}

/** 컨트롤 인덱스마다 텍스트 오프셋. */
export function getControlTextPositions(core: HmCore, sec: number, para: number): number[] {
  const info = core.paragraph(bodyList(sec), para);
  const map = paraMap(info);
  const out: number[] = [];
  for (const control of info.controls) out[control.index] = wireToText(map, control.offset);
  for (let i = 0; i < out.length; i++) out[i] ??= 0;
  return out;
}

/** 본문·글상자의 좌우 이동. 문단 끝에서 다음 문단(본문은 다음 구역까지)으로 넘어간다. */
export function navigateNextEditable(core: HmCore, sec: number, para: number, charOffset: number, delta: number, contextJson: string): { type: string; sec: number; para: number; charOffset: number; context: NavContextEntry[] } {
  const context = JSON.parse(contextJson || '[]') as NavContextEntry[];
  const box = context.at(-1);
  const list = box ? cellList(sec, box.parentPara, box.ctrlIdx, box.isTextBox ? 0 : box.cellIdx) : bodyList(sec);
  const length = logicalLength(paraMap(core.paragraph(list, para)));
  const next = charOffset + delta;
  if (next >= 0 && next <= length) return { type: 'text', sec, para, charOffset: next, context };
  if (next < 0) {
    if (para > 0) {
      return { type: 'text', sec, para: para - 1, charOffset: logicalLength(paraMap(core.paragraph(list, para - 1))), context };
    }
    if (!box && sec > 0) {
      const previous = bodyList(sec - 1);
      const last = core.paragraphCount(previous) - 1;
      return { type: 'text', sec: sec - 1, para: last, charOffset: logicalLength(paraMap(core.paragraph(previous, last))), context };
    }
    return { type: 'boundary', sec, para, charOffset, context };
  }
  if (para + 1 < core.paragraphCount(list)) return { type: 'text', sec, para: para + 1, charOffset: 0, context };
  if (!box && sec + 1 < core.adapter.getSectionCount()) return { type: 'text', sec: sec + 1, para: 0, charOffset: 0, context };
  return { type: 'boundary', sec, para, charOffset, context };
}

export function getCursorRectInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number): CursorRect {
  return caretRect(core, cellList(sec, parentPara, controlIdx, cellIdx), cellParaIdx, charOffset);
}

export function getParagraphPages(core: HmCore, sec: number, para: number): number[] | null {
  const pages = [...new Set(core.lines(bodyList(sec), para).map(line => line.page))];
  return pages.length ? pages : null;
}

function lineInfoIn(core: HmCore, list: ListAddress, para: number, charOffset: number): LineInfo {
  const map = paraMap(core.paragraph(list, para));
  const lines = core.lines(list, para);
  if (!lines.length) return { lineIndex: 0, lineCount: 1, charStart: 0, charEnd: logicalLength(map) };
  const wire = logicalToWire(map, charOffset);
  let index = lines.findIndex(line => wire >= line.start && wire < line.end);
  if (index < 0) index = wire < lines[0].start ? 0 : lines.length - 1;
  const line = lines[index];
  const charEnd = index + 1 === lines.length ? logicalLength(map) : wireToLogical(map, line.end);
  return { lineIndex: index, lineCount: lines.length, charStart: wireToLogical(map, line.start), charEnd };
}

export function getLineInfo(core: HmCore, sec: number, para: number, charOffset: number): LineInfo {
  return lineInfoIn(core, bodyList(sec), para, charOffset);
}

export function getLineInfoInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number): LineInfo {
  return lineInfoIn(core, cellList(sec, parentPara, controlIdx, cellIdx), cellParaIdx, charOffset);
}

export function getCaretPosition(_core: HmCore): DocumentPosition | null {
  return null;
}

export function getPageControlLayout(core: HmCore, pageNum: number): { controls: import('../types').ControlLayoutItem[] } {
  throw unsupported('getPageControlLayout');
}

export function getPageLineLayout(core: HmCore, pageNum: number): { lines: import('../types').LineLayoutItem[] } {
  throw unsupported('getPageLineLayout');
}

/** 엔진 preferredX 는 HU 다. 줄 끝 요청(아주 큰 값)은 쪽 폭 밖으로 자른다. */
const preferredHu = (preferredX: number): number | undefined =>
  preferredX < 0 || !Number.isFinite(preferredX) ? undefined : Math.min(hu(Math.min(preferredX, 1e6)), 2 ** 31 - 1);

function moveIn(core: HmCore, list: ListAddress, para: number, charOffset: number, delta: number, preferredX: number): MoveVerticalResult {
  const position = toAddress(list, para, logicalToWire(paraMap(core.paragraph(list, para)), charOffset));
  const request: Record<string, unknown> = { position, motion: delta < 0 ? 'up' : 'down' };
  const x = preferredHu(preferredX);
  if (x !== undefined) request.preferredX = x;
  let located = JSON.parse(core.call(doc => doc.navigate(JSON.stringify(request)))) as Located | null;
  for (let step = 1; located && step < Math.abs(delta); step++) {
    located = JSON.parse(core.call(doc => doc.navigate(JSON.stringify({ ...request, position: located!.position })))) as Located | null;
  }
  if (!located) {
    const caret = core.caret(position);
    return {
      ...addressToPosition(core, position),
      pageIndex: caret?.page ?? 0,
      x: caret ? px(caret.x) : 0,
      y: caret ? px(caret.y) : 0,
      height: caret ? px(caret.height) : 0,
      preferredX: preferredX >= 0 ? preferredX : caret ? px(caret.x) : 0,
      rectValid: !!caret,
    };
  }
  const next = addressToPosition(core, located.position);
  return {
    ...next,
    pageIndex: located.caret.page,
    x: px(located.caret.x),
    y: px(located.caret.y),
    height: px(located.caret.height),
    preferredX: preferredX >= 0 && preferredX < 1e6 ? preferredX : px(located.caret.x),
  };
}

export function moveVertical(core: HmCore, sec: number, para: number, charOffset: number, delta: number, preferredX: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number): MoveVerticalResult {
  const target = flatTarget(sec, para, parentPara, controlIdx, cellIdx, cellParaIdx);
  return moveIn(core, target.list, target.para, charOffset, delta, preferredX);
}

export function getCursorRectByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, charOffset: number): CursorRect {
  const { list, para } = pathTarget(sec, parentPara, pathJson);
  return caretRect(core, list, para, charOffset);
}

export function getCursorRectByPathNear(core: HmCore, sec: number, parentPara: number, pathJson: string, charOffset: number, hintPage: number): CursorRect {
  const { list, para } = pathTarget(sec, parentPara, pathJson);
  return caretRect(core, list, para, charOffset, hintPage);
}

export function moveVerticalByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, charOffset: number, delta: number, preferredX: number): MoveVerticalResult {
  const { list, para } = pathTarget(sec, parentPara, pathJson);
  return moveIn(core, list, para, charOffset, delta, preferredX);
}

function rectsIn(core: HmCore, list: ListAddress, startPara: number, startOffset: number, endPara: number, endOffset: number): SelectionRect[] {
  const from = toAddress(list, startPara, logicalToWire(paraMap(core.paragraph(list, startPara)), startOffset));
  const to = toAddress(list, endPara, logicalToWire(paraMap(core.paragraph(list, endPara)), endOffset));
  const rects = JSON.parse(core.call(doc => doc.select(JSON.stringify({ from, to })))) as Rect[];
  return rects.map(rect => ({ pageIndex: rect.page, x: px(rect.x), y: px(rect.y), width: px(rect.width), height: px(rect.height) }));
}

export function getSelectionRects(core: HmCore, sec: number, startPara: number, startOffset: number, endPara: number, endOffset: number, _closeGaps?: boolean): SelectionRect[] {
  return rectsIn(core, bodyList(sec), startPara, startOffset, endPara, endOffset);
}

export function getSelectionRectsInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, startCellPara: number, startOffset: number, endCellPara: number, endOffset: number, _pageHints?: SelectionPageHints, _closeGaps?: boolean): SelectionRect[] {
  return rectsIn(core, cellList(sec, parentPara, controlIdx, cellIdx), startCellPara, startOffset, endCellPara, endOffset);
}

export function getSelectionRectsByPath(core: HmCore, sec: number, parentPara: number, cellPath: unknown[], startCellPara: number, startOffset: number, endCellPara: number, endOffset: number, _closeGaps?: boolean): SelectionRect[] {
  const { list } = pathTarget(sec, parentPara, cellPath as CellPathEntry[]);
  return rectsIn(core, list, startCellPara, startOffset, endCellPara, endOffset);
}

/** 표 컨트롤 앞(after=false) 또는 뒤의 캐럿 위치. 셀 밖으로 선택을 넓힐 때 쓴다. */
export function getTableBoundaryPosition(core: HmCore, request: {
    sectionIndex: number;
    parentParaIndex: number;
    containerPath: CellPathEntry[];
    hostParaIndex: number;
    controlIndex: number;
    after: boolean;
  }): { paraIdx: number; charOffset: number } | null {
  const list = request.containerPath.length
    ? pathTarget(request.sectionIndex, request.parentParaIndex, request.containerPath).list
    : bodyList(request.sectionIndex);
  const info = core.paragraph(list, request.hostParaIndex);
  const control = info.controls.find(item => item.index === request.controlIndex);
  if (!control) return null;
  const map = paraMap(info);
  const before = wireToLogical(map, control.offset);
  if (!request.after) return { paraIdx: request.hostParaIndex, charOffset: before };
  const after = wireToLogical(map, control.offset + 8);
  return { paraIdx: request.hostParaIndex, charOffset: after > before ? after : logicalLength(map) };
}

/** 쪽의 첫 본문 위치. */
export function getPositionOfPage(core: HmCore, globalPage: number): { ok: boolean; sec?: number; para?: number; charOffset?: number; continued?: boolean } {
  const located = core.locate(globalPage, 0, 0, { body: true });
  if (!located) return { ok: false };
  const steps = located.position.steps ?? [];
  const para = steps.length ? steps[0].para : located.position.para;
  const charOffset = steps.length ? 0 : wireToLogical(paraMap(core.paragraph(bodyList(located.position.section), para)), located.position.offset);
  return { ok: true, sec: located.position.section, para, charOffset, continued: charOffset > 0 };
}

export function getPageOfPosition(core: HmCore, sectionIdx: number, paraIdx: number): import('../types').PageOfPositionResult {
  const lines = core.lines(bodyList(sectionIdx), paraIdx);
  if (lines.length) return { ok: true, page: lines[0].page };
  const caret = core.caret(toAddress(bodyList(sectionIdx), paraIdx, paraMap(core.paragraph(bodyList(sectionIdx), paraIdx)).lead));
  return caret ? { ok: true, page: caret.page } : { ok: false };
}

export type { HmLineInfo, Address };
