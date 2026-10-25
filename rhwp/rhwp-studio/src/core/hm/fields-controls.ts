import type { Address, EditOp, Step } from '../../../vendor/hm-wasm/hm_wasm';
import type { HmCore, ListAddress } from './core';
import { bodyList, cellList, logicalAddress, toAddress, paraMap, pathTarget, positionTarget, stepsToPath, textRangeToWire, wireToLogical, wireToText } from './address';
import { webHyperlinkUrl } from '../hyperlink';
import { api, extendBridge } from './api';
import type { DocumentPosition, FieldInfoResult, BookmarkInfo, HyperlinkTarget, HyperlinkContext } from './bridge-types';

type ControlAddress = { section: number; steps?: Step[]; para: number; control: number };
interface FieldRecord {
  target: ControlAddress; offset: number; kind: string; fieldId?: number; fieldKind?: string;
  name?: string; command?: string; guide?: string; editable?: boolean; value?: string; end?: Address;
}
type FieldPatch = { command?: string; name?: string; editable?: boolean; value?: string };
type FieldOp =
  | { op: 'insertField'; at: Address; kind: 'clickHere'; command: string; name: string; editable: boolean }
  | { op: 'insertField'; at: Address; to: Address; kind: 'hyperlink'; command: string }
  | { op: 'updateField'; target: ControlAddress; patch: FieldPatch }
  | { op: 'insertBookmark'; at: Address; name: string }
  | { op: 'renameBookmark'; target: ControlAddress; name: string }
  | { op: 'deleteControl'; target: ControlAddress };
const apply = (core: HmCore, ops: FieldOp[]) => core.transact(ops as unknown as EditOp[]);
const records = (core: HmCore) => core.query<FieldRecord[]>({ kind: 'fields' });
const fields = (core: HmCore) => records(core).filter(f => f.fieldId !== undefined && f.end);
const field = (core: HmCore, id: number) => fields(core).find(f => f.fieldId === id);
const listOf = (target: { section: number; steps?: Step[] }): ListAddress => ({ section: target.section, steps: target.steps ?? [] });
const sameList = (a: ListAddress, b: ListAddress) => a.section === b.section && JSON.stringify(a.steps) === JSON.stringify(b.steps);

function range(core: HmCore, f: FieldRecord) {
  const list = listOf(f.target);
  const start = wireToLogical(paraMap(core.paragraph(list, f.target.para)), f.offset + 8);
  const end = f.end ? wireToLogical(paraMap(core.paragraph({ section: f.end.section, steps: f.end.steps ?? [] }, f.end.para)), f.end.offset) : start;
  return { start, end };
}

export function getFieldList(core: HmCore): ReturnType<typeof import('./fields').getFieldList> {
  return fields(core).map(f => {
    const { start, end } = range(core, f);
    const steps = f.target.steps ?? [];
    const path = stepsToPath(steps, f.target.para).map(p => ({ controlIndex: p.controlIndex, cellIndex: p.cellIndex, paraIndex: p.cellParaIndex }));
    return { fieldId: f.fieldId!, fieldType: f.fieldKind === 'clickHere' ? 'clickhere' : f.fieldKind ?? 'unknown',
      name: f.name ?? '', guide: guideOf(f), command: f.command ?? '', value: f.value ?? '',
      location: { sectionIndex: f.target.section, paraIndex: steps[0]?.para ?? f.target.para, ...(path.length ? { path } : {}) },
      startCharIdx: start, endCharIdx: end, editableInForm: f.editable ?? false };
  });
}

export function getFieldValue(core: HmCore, fieldId: number): { ok: boolean; value: string } {
  const found = field(core, fieldId);
  return { ok: !!found, value: found?.value ?? '' };
}

export function getFieldValueByName(core: HmCore, name: string): { ok: boolean; fieldId: number; value: string } {
  const found = fields(core).find(f => f.name === name);
  return { ok: !!found, fieldId: found?.fieldId ?? 0, value: found?.value ?? '' };
}

export function setFieldValue(core: HmCore, fieldId: number, value: string): { ok: boolean; fieldId: number; oldValue: string; newValue: string } {
  const found = field(core, fieldId);
  if (!found) return { ok: false, fieldId, oldValue: '', newValue: '' };
  const oldValue = found.value ?? '';
  apply(core, [{ op: 'updateField', target: found.target, patch: { value } }]);
  return { ok: true, fieldId, oldValue, newValue: value };
}

export function setFieldValueByName(core: HmCore, name: string, value: string): { ok: boolean; fieldId: number; oldValue: string; newValue: string } {
  const found = fields(core).find(f => f.name === name);
  return setFieldValue(core, found?.fieldId ?? -1, value);
}

function hyperlinkTarget(target: HyperlinkTarget) {
  return pathTarget(target.section, target.para, target.cellPath.map(([controlIndex, cellIndex, cellParaIndex]) => ({ controlIndex, cellIndex, cellParaIndex })));
}

function link(core: HmCore, target: HyperlinkTarget, id: number) {
  const found = field(core, id), at = hyperlinkTarget(target);
  return found?.fieldKind === 'hyperlink' && found.target.para === at.para && sameList(listOf(found.target), at.list) ? found : undefined;
}

/** 링크 범위는 text 의 글자 위치다(각주·개체 칸을 세지 않는다). 에이전트 좌표와 같은 축이다. */
export function getHyperlinkContext(core: HmCore, target: HyperlinkTarget): HyperlinkContext {
  const { list, para } = hyperlinkTarget(target);
  const map = paraMap(core.paragraph(list, para));
  return { text: map.info.text, links: fields(core)
    .filter(f => f.fieldKind === 'hyperlink' && f.target.para === para && f.end?.para === para && sameList(listOf(f.target), list))
    .map(f => ({ fieldId: f.fieldId!, start: wireToText(map, f.offset + 8), end: wireToText(map, f.end!.offset),
      text: f.value ?? '', uri: hyperlinkUri(f.command ?? '') })) };
}

function hyperlinkUri(command: string): string {
  let uri = '';
  for (let i = 0; i < command.length; i++) {
    if (command[i] === ';') break;
    if (command[i] === '\\') i++;
    uri += command[i] ?? '';
  }
  return uri.trim();
}

function hyperlinkCommand(uri: string): string {
  if (!webHyperlinkUrl(uri)) throw new Error('공백 없는 HTTP/HTTPS 주소가 필요합니다.');
  const command = uri.trim().replace(/[\\:;#]/g, '\\$&') + ';1;0;0;';
  if (command.length > 65535) throw new RangeError('하이퍼링크 주소가 너무 깁니다.');
  return command;
}

export function insertHyperlink(core: HmCore, target: HyperlinkTarget, start: number, end: number, uri: string): number {
  const { list, para } = hyperlinkTarget(target);
  const map = paraMap(core.paragraph(list, para));
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > map.textLength) {
    throw new RangeError('하이퍼링크 범위가 올바르지 않습니다.');
  }
  // 글자 범위만 감싼다. 앞뒤의 각주·개체는 링크 밖에 남는다.
  const [from, to] = textRangeToWire(map, start, end);
  if (map.stops.some((stop, i) => !map.isText[i] && from <= stop && stop < to)) {
    throw new Error('하이퍼링크 범위에 각주·미주나 글자처럼 취급한 개체가 있습니다.');
  }
  const ids = new Set(fields(core).map(f => f.fieldId));
  apply(core, [{ op: 'insertField', at: toAddress(list, para, from), to: toAddress(list, para, to), kind: 'hyperlink', command: hyperlinkCommand(uri) }]);
  const inserted = fields(core).find(f => !ids.has(f.fieldId));
  if (!inserted) throw new Error('삽입한 하이퍼링크를 찾을 수 없습니다.');
  return inserted.fieldId!;
}

export function updateHyperlink(core: HmCore, target: HyperlinkTarget, fieldId: number, uri: string): boolean {
  const found = link(core, target, fieldId);
  if (!found) return false;
  apply(core, [{ op: 'updateField', target: found.target, patch: { command: hyperlinkCommand(uri) } }]);
  return true;
}

export function replaceHyperlinkText(core: HmCore, target: HyperlinkTarget, fieldId: number, text: string): boolean {
  const found = link(core, target, fieldId);
  if (!found) return false;
  apply(core, [{ op: 'updateField', target: found.target, patch: { value: text } }]);
  return true;
}

export function removeHyperlink(core: HmCore, target: HyperlinkTarget, fieldId: number, restoreFormatting: boolean): void {
  const found = link(core, target, fieldId);
  if (!found) throw new Error('하이퍼링크를 찾을 수 없습니다.');
  // 엔진은 원래 링크 서식의 별도 사본을 저장하지 않는다. 현재 글자 서식은 유지한다.
  apply(core, [{ op: 'deleteControl', target: found.target }]);
}

function fieldAt(core: HmCore, pos: DocumentPosition): FieldRecord | undefined {
  const { list, para } = positionTarget(pos);
  return fields(core).find(f => {
    if (!sameList(listOf(f.target), list) || f.target.para !== para || f.end?.para !== para) return false;
    const { start, end } = range(core, f);
    return start <= pos.charOffset && pos.charOffset <= end;
  });
}

export function getFieldInfoAt(core: HmCore, pos: DocumentPosition): FieldInfoResult {
  const found = fieldAt(core, pos);
  if (!found) return { inField: false };
  const { start, end } = range(core, found);
  return { inField: true, fieldId: found.fieldId, fieldType: found.fieldKind === 'clickHere' ? 'clickhere' : found.fieldKind,
    startCharIdx: start, endCharIdx: end, isGuide: found.fieldKind === 'clickHere' && !found.value,
    guideName: guideOf(found), editableInForm: found.editable ?? false };
}

export function removeFieldAt(core: HmCore, pos: DocumentPosition): { ok: boolean } {
  const found = fieldAt(core, pos);
  if (!found) return { ok: false };
  apply(core, [{ op: 'deleteControl', target: found.target }]);
  return { ok: true };
}

// ─── 활성 누름틀 ────────────────────────────────────────────
// 캐럿 오프셋은 필드 시작 컨트롤 앞에 놓인다(address.ts). 누름틀에 캐럿이 들어와 활성이 되면, 그 시작에서
// 치는 글자는 필드 안(시작 컨트롤 바로 뒤)에 들어가야 한다. 빈 누름틀은 시작과 끝이 같아 이 구분이 없으면
// 글자가 필드 밖에 쌓인다.

const activeFields = new WeakMap<HmCore, number>();

export function setActiveField(core: HmCore, pos: DocumentPosition): boolean {
  const found = fieldAt(core, pos);
  const previous = activeFields.get(core);
  if (found?.fieldKind !== 'clickHere') {
    activeFields.delete(core);
    return previous !== undefined;
  }
  activeFields.set(core, found.fieldId!);
  return previous !== found.fieldId;
}

export function clearActiveField(core: HmCore): void {
  activeFields.delete(core);
}

/** 활성 누름틀의 시작 캐럿이면 필드 안쪽 wire 오프셋. */
function activeInside(core: HmCore, list: ListAddress, para: number, charOffset: number, logical: boolean): number | null {
  const id = activeFields.get(core);
  if (id === undefined || !logical) return null;
  const found = field(core, id);
  if (found?.fieldKind !== 'clickHere') {
    activeFields.delete(core);
    return null;
  }
  if (!sameList(listOf(found.target), list) || found.target.para !== para || range(core, found).start !== charOffset) return null;
  return found.offset + 8;
}

function insertInside(core: HmCore, list: ListAddress, para: number, wire: number, text: string): number {
  const value = text.replace(/\r\n?/g, '\n');
  if (!value) return wireToLogical(paraMap(core.paragraph(list, para)), wire);
  core.transact([{ op: 'insertText', at: toAddress(list, para, wire), text: value }]);
  if (value.includes('\n')) return value.length - value.lastIndexOf('\n') - 1;
  const width = [...value].reduce((n, c) => n + (c === '\t' ? 8 : c.length), 0);
  return wireToLogical(paraMap(core.paragraph(list, para)), wire + width);
}

const original = {
  insertText: api.insertText, insertTextContent: api.insertTextContent, replaceBodyTextLocal: api.replaceBodyTextLocal,
  insertTextInCell: api.insertTextInCell, insertTextContentInCell: api.insertTextContentInCell,
  insertTextInCellDeferredPagination: api.insertTextInCellDeferredPagination,
  replaceTextInCellDeferredPagination: api.replaceTextInCellDeferredPagination,
  insertTextInCellByPath: api.insertTextInCellByPath, insertTextContentInCellByPath: api.insertTextContentInCellByPath,
};

/** 누름틀 시작에서의 입력만 필드 안으로 보내고, 나머지는 원래 구현이 맡는다. */
const typing: Partial<typeof api> = {
  insertText(core, sec, para, charOffset, text, logical) {
    const list = bodyList(sec), wire = activeInside(core, list, para, charOffset, logical);
    if (wire === null) return original.insertText(core, sec, para, charOffset, text, logical);
    return JSON.stringify({ ok: true, charOffset: insertInside(core, list, para, wire, text) });
  },
  insertTextContent(core, sec, para, charOffset, content, logical) {
    return typing.insertText!(core, sec, para, charOffset, content.text, logical);
  },
  replaceBodyTextLocal(core, sec, para, charOffset, deleteCount, text, logical) {
    const list = bodyList(sec);
    if (activeInside(core, list, para, charOffset, logical) === null) return original.replaceBodyTextLocal(core, sec, para, charOffset, deleteCount, text, logical);
    const removed = deleteCount > 0 ? original.replaceBodyTextLocal(core, sec, para, charOffset, deleteCount, '', logical) : undefined;
    const wire = activeInside(core, list, para, charOffset, logical);
    const next = wire === null ? charOffset : insertInside(core, list, para, wire, text);
    return { ...(removed ?? {}), ok: true, charOffset: next, documentPaginationPending: false, flowChanged: true };
  },
  insertTextInCell(core, sec, parentPara, controlIdx, cellIdx, cellPara, charOffset, text, logical) {
    const list = cellList(sec, parentPara, controlIdx, cellIdx), wire = activeInside(core, list, cellPara, charOffset, logical);
    if (wire === null) return original.insertTextInCell(core, sec, parentPara, controlIdx, cellIdx, cellPara, charOffset, text, logical);
    return JSON.stringify({ ok: true, charOffset: insertInside(core, list, cellPara, wire, text) });
  },
  insertTextContentInCell(core, sec, parentPara, controlIdx, cellIdx, cellPara, charOffset, content, logical) {
    return typing.insertTextInCell!(core, sec, parentPara, controlIdx, cellIdx, cellPara, charOffset, content.text, logical);
  },
  insertTextInCellDeferredPagination(core, sec, parentPara, controlIdx, cellIdx, cellPara, charOffset, text, logical) {
    const list = cellList(sec, parentPara, controlIdx, cellIdx), wire = activeInside(core, list, cellPara, charOffset, logical);
    if (wire === null) return original.insertTextInCellDeferredPagination(core, sec, parentPara, controlIdx, cellIdx, cellPara, charOffset, text, logical);
    return { ok: true, charOffset: insertInside(core, list, cellPara, wire, text), paginationDeferred: false, cellFlowChanged: true };
  },
  replaceTextInCellDeferredPagination(core, sec, parentPara, controlIdx, cellIdx, cellPara, charOffset, deleteCount, text, logical) {
    const list = cellList(sec, parentPara, controlIdx, cellIdx);
    if (activeInside(core, list, cellPara, charOffset, logical) === null) {
      return original.replaceTextInCellDeferredPagination(core, sec, parentPara, controlIdx, cellIdx, cellPara, charOffset, deleteCount, text, logical);
    }
    const removed = deleteCount > 0 ? original.replaceTextInCellDeferredPagination(core, sec, parentPara, controlIdx, cellIdx, cellPara, charOffset, deleteCount, '', logical) : undefined;
    const wire = activeInside(core, list, cellPara, charOffset, logical);
    const next = wire === null ? charOffset : insertInside(core, list, cellPara, wire, text);
    return { ...(removed ?? {}), ok: true, charOffset: next, paginationDeferred: false, cellFlowChanged: true };
  },
  insertTextInCellByPath(core, sec, parentPara, pathJson, charOffset, text, logical) {
    const { list, para } = pathTarget(sec, parentPara, pathJson), wire = activeInside(core, list, para, charOffset, logical);
    if (wire === null) return original.insertTextInCellByPath(core, sec, parentPara, pathJson, charOffset, text, logical);
    return JSON.stringify({ ok: true, charOffset: insertInside(core, list, para, wire, text) });
  },
  insertTextContentInCellByPath(core, sec, parentPara, pathJson, charOffset, content, logical) {
    return typing.insertTextInCellByPath!(core, sec, parentPara, pathJson, charOffset, content.text, logical);
  },
};

// HWP Params의 wstring 길이는 UTF-16 단위다. 값 안의 공백·콜론도 길이로 구분한다.
function clickHereCommand(guide: string, memo: string): string {
  const inner = `Direction:wstring:${guide.length}:${guide} HelpState:wstring:${memo.length}:${memo}  `;
  return `Clickhere:set:${inner.length - 1}:${inner}`;
}

function guideOf(field: FieldRecord): string {
  if (field.fieldKind !== 'clickHere') return field.guide ?? '';
  const command = field.command ?? '';
  const match = /Direction:wstring:(\d+):/.exec(command);
  if (!match) return field.guide ?? '';
  const start = match.index + match[0].length;
  return command.slice(start, start + Number(match[1]));
}

function memoOf(command: string): string {
  const direction = /Direction:wstring:(\d+):/.exec(command);
  const from = direction ? direction.index + direction[0].length + Number(direction[1]) : 0;
  const tail = command.slice(from);
  const match = /HelpState:wstring:(\d+):/.exec(tail);
  return match ? tail.slice(match.index + match[0].length, match.index + match[0].length + Number(match[1])) : '';
}

export function getClickHereProps(core: HmCore, fieldId: number): { ok: boolean; guide?: string; memo?: string; name?: string; editable?: boolean } {
  const found = field(core, fieldId);
  if (found?.fieldKind !== 'clickHere') return { ok: false };
  return { ok: true, guide: guideOf(found), memo: memoOf(found.command ?? ''), name: found.name ?? '', editable: found.editable ?? false };
}

export function updateClickHereProps(core: HmCore, fieldId: number, guide: string, memo: string, name: string, editable: boolean): { ok: boolean } {
  const found = field(core, fieldId);
  if (found?.fieldKind !== 'clickHere') return { ok: false };
  apply(core, [{ op: 'updateField', target: found.target, patch: { command: clickHereCommand(guide, memo), name, editable } }]);
  return { ok: true };
}

export function insertClickHereField(core: HmCore, pos: DocumentPosition, guide: string, memo: string, name: string, editable: boolean): { ok: boolean; fieldId?: number; charOffset?: number } {
  const before = new Set(fields(core).map(f => f.fieldId));
  const { list, para } = positionTarget(pos);
  apply(core, [{ op: 'insertField', at: logicalAddress(core, list, para, pos.charOffset), kind: 'clickHere', command: clickHereCommand(guide, memo), name, editable }]);
  const inserted = fields(core).find(f => !before.has(f.fieldId));
  if (!inserted) throw new Error('삽입한 누름틀을 찾을 수 없습니다.');
  return { ok: true, fieldId: inserted.fieldId, charOffset: range(core, inserted).start };
}

export function getBookmarks(core: HmCore): BookmarkInfo[] {
  return records(core).filter(f => (f.kind === 'bookmark' || f.fieldKind === 'bookmark') && !f.target.steps?.length)
    .map(f => ({ name: f.name ?? '', sec: f.target.section, para: f.target.para, ctrlIdx: f.target.control,
      charPos: wireToLogical(paraMap(core.paragraph(bodyList(f.target.section), f.target.para)), f.offset) }));
}

export function addBookmark(core: HmCore, sec: number, para: number, charOffset: number, name: string): { ok: boolean; error?: string } {
  if (!name.trim() || getBookmarks(core).some(b => b.name === name)) return { ok: false, error: '책갈피 이름을 확인해 주세요.' };
  apply(core, [{ op: 'insertBookmark', at: logicalAddress(core, bodyList(sec), para, charOffset), name }]);
  return { ok: true };
}

function bookmark(core: HmCore, sec: number, para: number, ctrlIdx: number) {
  return records(core).find(f => (f.kind === 'bookmark' || f.fieldKind === 'bookmark')
    && f.target.section === sec && f.target.para === para && f.target.control === ctrlIdx && !f.target.steps?.length);
}

export function deleteBookmark(core: HmCore, sec: number, para: number, ctrlIdx: number): { ok: boolean; error?: string } {
  const found = bookmark(core, sec, para, ctrlIdx);
  if (!found) return { ok: false, error: '책갈피를 찾을 수 없습니다.' };
  apply(core, [{ op: 'deleteControl', target: found.target }]);
  return { ok: true };
}

export function renameBookmark(core: HmCore, sec: number, para: number, ctrlIdx: number, newName: string): { ok: boolean; error?: string } {
  const found = bookmark(core, sec, para, ctrlIdx);
  if (!found || !newName.trim() || getBookmarks(core).some(b => b.name === newName && (b.sec !== sec || b.para !== para || b.ctrlIdx !== ctrlIdx))) {
    return { ok: false, error: '책갈피 이름을 확인해 주세요.' };
  }
  apply(core, [found.fieldKind === 'bookmark'
    ? { op: 'updateField', target: found.target, patch: { name: newName } }
    : { op: 'renameBookmark', target: found.target, name: newName }]);
  return { ok: true };
}

extendBridge({ getFieldList, getFieldValue, getFieldValueByName, setFieldValue, setFieldValueByName,
  getHyperlinkContext, insertHyperlink, updateHyperlink, replaceHyperlinkText, removeHyperlink, getFieldInfoAt, removeFieldAt,
  setActiveField, clearActiveField, ...typing, getClickHereProps, updateClickHereProps, insertClickHereField, getBookmarks, addBookmark, deleteBookmark, renameBookmark });
