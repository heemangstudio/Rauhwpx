// 이 파일의 함수는 WasmBridge 의 같은 이름 메서드가 위임한다. 엔진이 아직 못 하는 기능은
// EngineNotSupportedError 를 던지고, 명령 계층이 해당 메뉴·버튼을 비활성으로 보여 준다.
//
// 본문·셀·글상자 문단의 글자 편집. 캐럿 오프셋(logical=true)은 개체를 한 칸으로, 텍스트 오프셋은
// 글자만 센다 (address.ts).
import type { EditOp } from '../../../vendor/hm-wasm/hm_wasm';
import type { HmCore, ListAddress } from './core';
import {
  bodyList, cellList, logicalLength, logicalRangeToWire, logicalText, logicalToText, logicalToWire, paraMap,
  pathTarget, textRangeToWire, textSlice, textToLogical, textToWire, toAddress, wireToLogical, wireToText,
} from './address';
import type { TextContent, LocalBodyTextReplaceResult, RemovedParaMeta, DeferredCellTextMutationResult } from './bridge-types';

const json = (value: unknown): string => JSON.stringify(value);

/** 엔진 입력 문자열로 바꾼다. CR/LF 는 문단 나누기다. */
function engineText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** 유니코드 scalar 로 센 글자 수 (Studio 캐럿 산술과 같은 축). */
const units = (text: string): number => [...text].length;

// ─── 목록 단위 연산 ─────────────────────────────────────────

export function insertIn(core: HmCore, list: ListAddress, para: number, offset: number, text: string, logical: boolean): number {
  const map = paraMap(core.paragraph(list, para));
  const at = logical ? logicalToWire(map, offset) : textToWire(map, offset);
  const value = engineText(text);
  if (value) core.transact([{ op: 'insertText', at: toAddress(list, para, at), text: value }]);
  if (value.includes('\n')) {
    // 문단이 나뉘었다. 마지막 문단의 캐럿을 돌려준다.
    const tail = value.slice(value.lastIndexOf('\n') + 1);
    return units(tail);
  }
  const after = paraMap(core.paragraph(list, para));
  const wire = at + [...value].reduce((n, c) => n + (c === '\t' ? 8 : c.length), 0);
  return logical ? wireToLogical(after, wire) : wireToText(after, wire);
}

export interface Removal { removedStart: number; removedCount: number; removedContent: TextContent }

export function deleteIn(core: HmCore, list: ListAddress, para: number, offset: number, count: number, logical: boolean): Removal & { charOffset: number } {
  const map = paraMap(core.paragraph(list, para));
  const end = offset + Math.max(0, count);
  const [from, to] = logical ? logicalRangeToWire(map, offset, end) : textRangeToWire(map, offset, end);
  const removedText = logical ? logicalText(map, offset, end) : textSlice(map, offset, end);
  const removedStart = logical ? logicalToText(map, offset) : Math.min(offset, map.textLength);
  if (to > from) core.transact([{ op: 'delete', from: toAddress(list, para, from), to: toAddress(list, para, to) }]);
  return {
    charOffset: offset,
    removedStart,
    removedCount: [...removedText].length,
    removedContent: { text: removedText },
  };
}

/**
 * 지우고 같은 자리에 넣기(IME 조합 갱신)를 엔진 트랜잭션 하나로 한다. 따로 하면 조판을 두 번 한다.
 * 넣는 자리는 지운 뒤 문단에서 캐럿 오프셋이 가리키는 wire 위치다. 캐럿 앞 단위는 지워도 그대로라
 * 지우기 전 문단에서 같은 값을 얻는다(logicalToWire 는 캐럿 앞 단위만 본다).
 */
export function replaceIn(core: HmCore, list: ListAddress, para: number, offset: number, count: number, text: string): Removal & { charOffset: number } {
  const map = paraMap(core.paragraph(list, para));
  const end = offset + Math.max(0, count);
  const [from, to] = logicalRangeToWire(map, offset, end);
  const removedText = logicalText(map, offset, end);
  const at = logicalToWire(map, offset);
  const value = engineText(text);
  const ops: EditOp[] = [];
  if (to > from) ops.push({ op: 'delete', from: toAddress(list, para, from), to: toAddress(list, para, to) });
  if (value) ops.push({ op: 'insertText', at: toAddress(list, para, at), text: value });
  core.transact(ops);
  const removal = { removedStart: logicalToText(map, offset), removedCount: [...removedText].length, removedContent: { text: removedText } };
  if (value.includes('\n')) return { ...removal, charOffset: units(value.slice(value.lastIndexOf('\n') + 1)) };
  const after = paraMap(core.paragraph(list, para));
  const wire = at + [...value].reduce((n, c) => n + (c === '\t' ? 8 : c.length), 0);
  return { ...removal, charOffset: value ? wireToLogical(after, wire) : offset };
}

/** 병합으로 사라진 문단의 스타일과 문단 모양. 병합을 되돌리는 나누기가 새 문단에 다시 입힌다. */
interface MergedParagraphShape { styleId: number; paragraphs: object }

function splitIn(core: HmCore, list: ListAddress, para: number, offset: number, logical = true, meta?: RemovedParaMeta): string {
  const map = paraMap(core.paragraph(list, para));
  const at = logical ? logicalToWire(map, offset) : textToWire(map, offset);
  const ops: EditOp[] = [{ op: 'split', at: toAddress(list, para, at) }];
  const restored = meta?.heemang as MergedParagraphShape | undefined;
  if (restored) {
    // 나눈 뒤 새 문단은 para + 1 이고 lead 위치에서 시작한다. 끝은 나누기 전 문단 끝을 옮긴 자리다.
    const from = toAddress(list, para + 1, 0);
    const to = toAddress(list, para + 1, map.end - at);
    ops.push({ op: 'applyStyle', from, to, styleId: restored.styleId }, { op: 'formatParas', from, to, patch: restored.paragraphs });
  }
  core.transact(ops);
  return json({ ok: true, paraIdx: para + 1, charOffset: 0 });
}

/** para 를 앞 문단에 붙인다. charOffset 은 붙은 자리(앞 문단의 원래 논리 길이)다. */
function mergeIn(core: HmCore, list: ListAddress, para: number): string {
  if (para <= 0) return json({ ok: true, paraIdx: 0, charOffset: 0 });
  const prev = paraMap(core.paragraph(list, para - 1));
  const next = paraMap(core.paragraph(list, para));
  const mergePoint = logicalLength(prev);
  const heemang = core.query<MergedParagraphShape>({ kind: 'formatContext', at: toAddress(list, para, next.lead) });
  const removedParaMeta: RemovedParaMeta = { heemang: { styleId: heemang.styleId, paragraphs: heemang.paragraphs } };
  core.transact([{ op: 'delete', from: toAddress(list, para - 1, prev.end), to: toAddress(list, para, next.lead) }]);
  return json({ ok: true, paraIdx: para - 1, charOffset: mergePoint, removedParaMeta });
}

function rangeIn(core: HmCore, list: ListAddress, startPara: number, startOffset: number, endPara: number, endOffset: number, logical: boolean): { paraIdx: number; charOffset: number } {
  const a = paraMap(core.paragraph(list, startPara));
  const b = startPara === endPara ? a : paraMap(core.paragraph(list, endPara));
  let from: number, to: number;
  if (startPara === endPara) {
    [from, to] = logical ? logicalRangeToWire(a, startOffset, endOffset) : textRangeToWire(a, startOffset, endOffset);
  } else {
    from = logical ? logicalRangeToWire(a, startOffset, logicalLength(a))[0] : textRangeToWire(a, startOffset, a.textLength)[0];
    if (startOffset >= (logical ? logicalLength(a) : a.textLength)) from = a.end;
    to = endOffset <= 0 ? b.lead : logical ? logicalRangeToWire(b, 0, endOffset)[1] : textRangeToWire(b, 0, endOffset)[1];
  }
  const ops: EditOp[] = [];
  if (startPara !== endPara || to > from) {
    ops.push({ op: 'delete', from: toAddress(list, startPara, from), to: toAddress(list, endPara, to) });
  }
  core.transact(ops);
  return { paraIdx: startPara, charOffset: startOffset };
}

function textIn(core: HmCore, list: ListAddress, para: number, offset: number, count: number, logical: boolean): string {
  const map = paraMap(core.paragraph(list, para));
  return logical ? logicalText(map, offset, offset + count) : textSlice(map, offset, offset + count);
}

const cell = (sec: number, parentPara: number, controlIdx: number, cellIdx: number): ListAddress =>
  cellList(sec, parentPara, controlIdx, cellIdx);

function cellResult(charOffset: number, removal?: Removal): DeferredCellTextMutationResult {
  return { ...(removal ?? {}), ok: true, charOffset, paginationDeferred: false, cellFlowChanged: true };
}

// ─── 본문 ───────────────────────────────────────────────────

export function insertText(core: HmCore, sec: number, para: number, charOffset: number, text: string, logical: boolean): string {
  return json({ ok: true, charOffset: insertIn(core, bodyList(sec), para, charOffset, text, logical) });
}

export function insertTextContent(core: HmCore, sec: number, para: number, charOffset: number, content: TextContent, logical: boolean): string {
  return insertText(core, sec, para, charOffset, content.text, logical);
}

export function insertTextContentInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, content: TextContent, logical: boolean): string {
  return insertTextInCell(core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, charOffset, content.text, logical);
}

export function insertTextContentInCellDeferredPagination(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, content: TextContent, logical: boolean): DeferredCellTextMutationResult {
  return insertTextInCellDeferredPagination(core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, charOffset, content.text, logical);
}

export function insertTextContentInCellByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, charOffset: number, content: TextContent, logical: boolean): string {
  return insertTextInCellByPath(core, sec, parentPara, pathJson, charOffset, content.text, logical);
}

export function insertTextLogical(core: HmCore, sec: number, para: number, logicalOffset: number, text: string): string {
  return json({ ok: true, logicalOffset: insertIn(core, bodyList(sec), para, logicalOffset, text, true) });
}

/** 한 문단 안 글자 바꾸기. 엔진은 바뀐 문단만 다시 조판하므로 쪽 나누기를 미루지 않는다. */
export function replaceBodyTextLocal(core: HmCore, sec: number, para: number, charOffset: number, deleteCount: number, text: string, logical: boolean): LocalBodyTextReplaceResult {
  const list = bodyList(sec);
  let removal: (Removal & { charOffset: number }) | undefined;
  let next: number;
  if (logical && deleteCount > 0 && text) {
    removal = replaceIn(core, list, para, charOffset, deleteCount, text);
    next = removal.charOffset;
  } else {
    removal = deleteCount > 0 ? deleteIn(core, list, para, charOffset, deleteCount, logical) : undefined;
    next = text ? insertIn(core, list, para, charOffset, text, logical) : charOffset;
  }
  const { charOffset: _ignored, ...removed } = removal ?? { charOffset: 0 };
  return { ...(removal ? removed : {}), ok: true, charOffset: next, documentPaginationPending: false, flowChanged: true };
}

export function deleteText(core: HmCore, sec: number, para: number, charOffset: number, count: number, logical: boolean): string {
  return json({ ok: true, ...deleteIn(core, bodyList(sec), para, charOffset, count, logical) });
}

export function splitParagraph(core: HmCore, sec: number, para: number, charOffset: number, removedParaMeta?: RemovedParaMeta): string {
  return splitIn(core, bodyList(sec), para, charOffset, true, removedParaMeta);
}

export function splitParagraphLogical(core: HmCore, sec: number, para: number, charOffset: number): string {
  return splitIn(core, bodyList(sec), para, charOffset);
}

export function mergeParagraph(core: HmCore, sec: number, para: number): string {
  return mergeIn(core, bodyList(sec), para);
}

/** 문단 하나를 지운다. 마지막 남은 문단은 내용만 비운다. */
export function deleteParagraph(core: HmCore, sec: number, para: number): string {
  const list = bodyList(sec);
  const count = core.paragraphCount(list);
  const map = paraMap(core.paragraph(list, para));
  if (count <= 1) {
    if (map.end > map.lead) core.transact([{ op: 'delete', from: toAddress(list, para, map.lead), to: toAddress(list, para, map.end) }]);
    return json({ ok: true, paraIdx: 0, charOffset: 0 });
  }
  if (para + 1 < count) {
    const next = paraMap(core.paragraph(list, para + 1));
    core.transact([{ op: 'delete', from: toAddress(list, para, map.lead), to: toAddress(list, para + 1, next.lead) }]);
    return json({ ok: true, paraIdx: para, charOffset: 0 });
  }
  const prev = paraMap(core.paragraph(list, para - 1));
  core.transact([{ op: 'delete', from: toAddress(list, para - 1, prev.end), to: toAddress(list, para, map.end) }]);
  return json({ ok: true, paraIdx: para - 1, charOffset: logicalLength(prev) });
}

/** para 자리에 빈 문단을 넣는다(앞 문단 끝에서 나눈다). */
export function insertParagraph(core: HmCore, sec: number, para: number): string {
  const list = bodyList(sec);
  if (para <= 0) {
    const first = paraMap(core.paragraph(list, 0));
    core.transact([{ op: 'split', at: toAddress(list, 0, first.lead) }]);
    return json({ ok: true, paraIdx: 0, charOffset: 0 });
  }
  const prev = paraMap(core.paragraph(list, para - 1));
  core.transact([{ op: 'split', at: toAddress(list, para - 1, prev.end) }]);
  return json({ ok: true, paraIdx: para, charOffset: 0 });
}

export function getTextRange(core: HmCore, sec: number, para: number, charOffset: number, count: number, logical: boolean): string {
  return textIn(core, bodyList(sec), para, charOffset, count, logical);
}

export function getParagraphLength(core: HmCore, sec: number, para: number): number {
  return paraMap(core.paragraph(bodyList(sec), para)).textLength;
}

export function getLogicalLength(core: HmCore, sec: number, para: number): number {
  return logicalLength(paraMap(core.paragraph(bodyList(sec), para)));
}

export function logicalToTextOffset(core: HmCore, sec: number, para: number, logicalOffset: number): number {
  return logicalToText(paraMap(core.paragraph(bodyList(sec), para)), logicalOffset);
}

export function getParagraphCount(core: HmCore, sec: number): number {
  return core.paragraphCount(bodyList(sec));
}

export function textToLogicalOffset(core: HmCore, sec: number, para: number, textOffset: number): number {
  return textToLogical(paraMap(core.paragraph(bodyList(sec), para)), textOffset);
}

export function deleteRange(core: HmCore, sec: number, startPara: number, startOffset: number, endPara: number, endOffset: number, logical: boolean): { ok: boolean; paraIdx: number; charOffset: number } {
  return { ok: true, ...rangeIn(core, bodyList(sec), startPara, startOffset, endPara, endOffset, logical) };
}

export function deleteRangeAcrossSections(core: HmCore, startSec: number, startPara: number, startOffset: number, endSec: number, endPara: number, endOffset: number, logical: boolean): { ok: boolean; sectionIdx: number; paraIdx: number; charOffset: number } {
  if (startSec === endSec) {
    return { ok: true, sectionIdx: startSec, ...rangeIn(core, bodyList(startSec), startPara, startOffset, endPara, endOffset, logical) };
  }
  if (startSec > endSec) throw new RangeError('시작 구역이 끝 구역보다 뒤에 있습니다');
  const first = bodyList(startSec), last = bodyList(endSec);
  const a = paraMap(core.paragraph(first, startPara)), b = paraMap(core.paragraph(last, endPara));
  const from = logical ? logicalRangeToWire(a, startOffset, logicalLength(a))[0] : textRangeToWire(a, startOffset, a.textLength)[0];
  const to = endOffset <= 0 ? b.lead : logical ? logicalRangeToWire(b, 0, endOffset)[1] : textRangeToWire(b, 0, endOffset)[1];
  core.transact([{ op: 'delete', from: toAddress(first, startPara, from), to: toAddress(last, endPara, to) }]);
  return { ok: true, sectionIdx: startSec, paraIdx: startPara, charOffset: startOffset };
}

// ─── 셀(한 단계) ────────────────────────────────────────────

export function splitParagraphInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, removedParaMeta?: RemovedParaMeta): string {
  return splitIn(core, cell(sec, parentPara, controlIdx, cellIdx), cellParaIdx, charOffset, true, removedParaMeta);
}

export function splitParagraphInCellLogical(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number): string {
  return splitIn(core, cell(sec, parentPara, controlIdx, cellIdx), cellParaIdx, charOffset);
}

export function mergeParagraphInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number): string {
  return mergeIn(core, cell(sec, parentPara, controlIdx, cellIdx), cellParaIdx);
}

export function insertTextInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, text: string, logical: boolean): string {
  return json({ ok: true, charOffset: insertIn(core, cell(sec, parentPara, controlIdx, cellIdx), cellParaIdx, charOffset, text, logical) });
}

export function insertTextInCellDeferredPagination(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, text: string, logical: boolean): DeferredCellTextMutationResult {
  return cellResult(insertIn(core, cell(sec, parentPara, controlIdx, cellIdx), cellParaIdx, charOffset, text, logical));
}

export function replaceTextInCellDeferredPagination(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, deleteCount: number, text: string, logical: boolean): DeferredCellTextMutationResult {
  const list = cell(sec, parentPara, controlIdx, cellIdx);
  if (logical && deleteCount > 0 && text) {
    const { charOffset: next, ...removal } = replaceIn(core, list, cellParaIdx, charOffset, deleteCount, text);
    return cellResult(next, removal);
  }
  let removal: Removal | undefined;
  if (deleteCount > 0) {
    const { charOffset: _ignored, ...removed } = deleteIn(core, list, cellParaIdx, charOffset, deleteCount, logical);
    removal = removed;
  }
  const next = text ? insertIn(core, list, cellParaIdx, charOffset, text, logical) : charOffset;
  return cellResult(next, removal);
}

export function deleteTextInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, count: number, logical: boolean): string {
  return json({ ok: true, ...deleteIn(core, cell(sec, parentPara, controlIdx, cellIdx), cellParaIdx, charOffset, count, logical) });
}

export function deleteTextInCellDeferredPagination(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, count: number, logical: boolean): DeferredCellTextMutationResult {
  const { charOffset: next, ...removal } = deleteIn(core, cell(sec, parentPara, controlIdx, cellIdx), cellParaIdx, charOffset, count, logical);
  return cellResult(next, removal);
}

export function getTextInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, count: number, logical: boolean): string {
  return textIn(core, cell(sec, parentPara, controlIdx, cellIdx), cellParaIdx, charOffset, count, logical);
}

export function logicalToTextOffsetInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, logicalOffset: number): number {
  return logicalToText(paraMap(core.paragraph(cell(sec, parentPara, controlIdx, cellIdx), cellParaIdx)), logicalOffset);
}

export function getCellParagraphLength(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number): number {
  return paraMap(core.paragraph(cell(sec, parentPara, controlIdx, cellIdx), cellParaIdx)).textLength;
}

export function getCellParagraphCount(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number): number {
  return core.paragraphCount(cell(sec, parentPara, controlIdx, cellIdx));
}

/** 셀 글자 방향: 0 가로, 1 세로. 엔진 질의가 아직 없어 가로로 본다. */
export function getCellTextDirection(_core: HmCore, _sec: number, _parentPara: number, _controlIdx: number, _cellIdx: number): number {
  return 0;
}

export function deleteRangeInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, startCellPara: number, startOffset: number, endCellPara: number, endOffset: number): { ok: boolean; paraIdx: number; charOffset: number } {
  return { ok: true, ...rangeIn(core, cell(sec, parentPara, controlIdx, cellIdx), startCellPara, startOffset, endCellPara, endOffset, false) };
}

// ─── 셀 경로(중첩 표) ──────────────────────────────────────

export function insertTextInCellByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, charOffset: number, text: string, logical: boolean): string {
  const { list, para } = pathTarget(sec, parentPara, pathJson);
  return json({ ok: true, charOffset: insertIn(core, list, para, charOffset, text, logical) });
}

export function deleteTextInCellByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, charOffset: number, count: number, logical: boolean): string {
  const { list, para } = pathTarget(sec, parentPara, pathJson);
  return json({ ok: true, ...deleteIn(core, list, para, charOffset, count, logical) });
}

export function deleteRangeInCellByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, startPara: number, startOffset: number, endPara: number, endOffset: number, logical: boolean): string {
  const { list } = pathTarget(sec, parentPara, pathJson);
  return json({ ok: true, ...rangeIn(core, list, startPara, startOffset, endPara, endOffset, logical) });
}

export function splitParagraphInCellByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, charOffset: number, removedParaMeta?: RemovedParaMeta): string {
  const { list, para } = pathTarget(sec, parentPara, pathJson);
  return splitIn(core, list, para, charOffset, true, removedParaMeta);
}

export function mergeParagraphInCellByPath(core: HmCore, sec: number, parentPara: number, pathJson: string): string {
  const { list, para } = pathTarget(sec, parentPara, pathJson);
  return mergeIn(core, list, para);
}

export function getTextInCellByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, charOffset: number, count: number, logical: boolean): string {
  const { list, para } = pathTarget(sec, parentPara, pathJson);
  return textIn(core, list, para, charOffset, count, logical);
}

export function textToLogicalOffsetInCellByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, textOffset: number): number {
  const { list, para } = pathTarget(sec, parentPara, pathJson);
  return textToLogical(paraMap(core.paragraph(list, para)), textOffset);
}

export function logicalToTextOffsetInCellByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, logicalOffset: number): number {
  const { list, para } = pathTarget(sec, parentPara, pathJson);
  return logicalToText(paraMap(core.paragraph(list, para)), logicalOffset);
}

export function getCellParagraphCountByPath(core: HmCore, sec: number, parentPara: number, pathJson: string): number {
  return core.paragraphCount(pathTarget(sec, parentPara, pathJson).list);
}

export function getCellParagraphLengthByPath(core: HmCore, sec: number, parentPara: number, pathJson: string): number {
  const { list, para } = pathTarget(sec, parentPara, pathJson);
  return paraMap(core.paragraph(list, para)).textLength;
}

export function getCellLogicalLengthByPath(core: HmCore, sec: number, parentPara: number, pathJson: string): number {
  const { list, para } = pathTarget(sec, parentPara, pathJson);
  return logicalLength(paraMap(core.paragraph(list, para)));
}
