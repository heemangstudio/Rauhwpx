/** 머리말·꼬리말과 주석을 엔진의 중첩 문단 목록으로 편집한다. */
import type { Address, ControlInfo, EditOp, Rect } from '../../../vendor/hm-wasm/hm_wasm';
import type { HmCore, ListAddress } from './core';
import { px, unsupported } from './core';
import { afterFieldEnds, bodyList, isLogicalControl, logicalLength, logicalRangeToWire, logicalToWire, paraMap, toAddress, wireToLogical, wireToText } from './address';
import { api, extendBridge } from './api';
import * as format from './format';
import type { CharProperties, CursorRect, EndnoteShapeSettings, RemovedParaMeta, SelectionRect, TextContent } from './bridge-types';
import { validateTextContent } from '../local-text-replace-result';

type Side = 'both' | 'even' | 'odd';
const SIDES: Side[] = ['both', 'even', 'odd'];
interface FurnitureTarget { section: number; para: number; control: number; info: ControlInfo }
interface FurnitureList extends ListAddress { headerFooter?: boolean }
interface ControlRecord { target: { section: number; steps?: ListAddress['steps']; para: number; control: number }; offset: number; kind: string; flags?: number }

function edit(core: HmCore, op: EditOp): void {
  core.transact([op]);
}

function furniture(core: HmCore, section: number): FurnitureTarget[] {
  const list = bodyList(section);
  return Array.from({ length: core.paragraphCount(list) }, (_, para) =>
    core.paragraph(list, para).controls.map(info => ({ section, para, control: info.index, info }))).flat();
}

function hfTarget(core: HmCore, section: number, isHeader: boolean, applyTo: number): FurnitureTarget | undefined {
  const side = SIDES[applyTo];
  if (!side) throw new RangeError('잘못된 머리말·꼬리말 적용 범위');
  return furniture(core, section).find(target => target.info.kind === (isHeader ? 'header' : 'footer') && target.info.side === side);
}

function nested(target: FurnitureTarget, headerFooter = false): FurnitureList {
  return { section: target.section, steps: [{ para: target.para, control: target.control, index: 0 }], headerFooter };
}

function hfList(core: HmCore, section: number, isHeader: boolean, applyTo: number): FurnitureList {
  const target = hfTarget(core, section, isHeader, applyTo);
  if (!target) throw new Error('머리말·꼬리말이 없습니다');
  return nested(target, true);
}

function noteTarget(core: HmCore, sec: number, para: number, control: number): FurnitureTarget {
  const info = core.paragraph(bodyList(sec), para).controls.find(item => item.index === control);
  if (!info || !['footnote', 'endnote'].includes(info.kind)) throw new Error('각주·미주가 없습니다');
  return { section: sec, para, control, info };
}

const noteList = (core: HmCore, sec: number, para: number, control: number): FurnitureList => nested(noteTarget(core, sec, para, control));

/** 기존 HF·주석 커서는 유니코드 scalar를 센다. 엔진 주소는 UTF-16 wire 단위다. */
function mapIn(core: HmCore, list: FurnitureList, para: number) {
  const info = core.paragraph(list, para);
  const units: { start: number; width: number; text: string | null }[] = [];
  let utf16 = 0;
  for (const text of info.text) {
    units.push({ start: info.offsets[utf16], width: text === '\t' ? 8 : text.length, text });
    utf16 += text.length;
  }
  for (const control of info.controls) {
    if (isLogicalControl(control) || (list.headerFooter && control.kind === 'autoNumber')) units.push({ start: control.offset, width: 8, text: null });
  }
  units.sort((a, b) => a.start - b.start);
  // 각주·미주 첫 문단 맨 앞의 번호는 주석 자신의 번호다. 캐럿 0 은 그 뒤에 선다.
  const number = list.headerFooter ? undefined : info.controls.find(control => control.kind === 'autoNumber' && control.offset === info.caret[0]);
  return { ...paraMap(info), stops: units.map(unit => unit.start), widths: units.map(unit => unit.width), isText: units.map(unit => unit.text !== null),
    lead: number ? number.offset + 8 : info.caret[0], end: info.offsets.at(-1)!, units };
}

const at = (core: HmCore, list: FurnitureList, para: number, offset: number): Address => toAddress(list, para, logicalToWire(mapIn(core, list, para), offset));
const cursor = (caret: { page: number; x: number; y: number; height: number }): CursorRect => ({ pageIndex: caret.page, x: px(caret.x), y: px(caret.y), height: px(caret.height) });

function insert(core: HmCore, list: FurnitureList, para: number, offset: number, text: string): number {
  if (!text) return offset;
  const receipt = core.transact([{ op: 'insertText', at: at(core, list, para, offset), text: text.replace(/\r\n?/g, '\n') }]);
  const caret = receipt?.caret;
  return caret ? wireToLogical(mapIn(core, list, caret.para), caret.offset) : offset;
}

function remove(core: HmCore, list: FurnitureList, para: number, offset: number, count: number) {
  const map = mapIn(core, list, para);
  const [from, to] = logicalRangeToWire(map, offset, offset + Math.max(0, count));
  const deletedText = map.units.slice(offset, offset + Math.max(0, count)).map(unit => unit.text ?? '').join('');
  if (to > from) core.transact([{ op: 'delete', from: toAddress(list, para, from), to: toAddress(list, para, to) }]);
  return { ok: true, charOffset: offset, deletedText, removedStart: offset, removedCount: [...deletedText].length, removedContent: { text: deletedText } };
}

function split(core: HmCore, list: FurnitureList, para: number, offset: number, meta?: RemovedParaMeta) {
  core.transact([{ op: 'split', at: at(core, list, para, offset) }]);
  const restored = meta?.heemang as { styleId: number; paragraphs: object } | undefined;
  if (restored) {
    const from = at(core, list, para + 1, 0);
    const to = toAddress(list, para + 1, mapIn(core, list, para + 1).end);
    core.transact([{ op: 'applyStyle', from, to, styleId: restored.styleId }, { op: 'formatParas', from, to, patch: restored.paragraphs }]);
  }
  return { ok: true, charOffset: 0, hfParaIndex: para + 1, fnParaIndex: para + 1 };
}

function merge(core: HmCore, list: FurnitureList, para: number) {
  if (para <= 0) throw new RangeError('첫 문단은 앞 문단과 합칠 수 없습니다');
  const previous = mapIn(core, list, para - 1), current = mapIn(core, list, para);
  const heemang = core.query<{ styleId: number; paragraphs: object }>({ kind: 'formatContext', at: at(core, list, para, 0) });
  const charOffset = logicalLength(previous);
  core.transact([{ op: 'delete', from: toAddress(list, para - 1, previous.end), to: toAddress(list, para, current.lead) }]);
  return { ok: true, charOffset, hfParaIndex: para - 1, fnParaIndex: para - 1, removedParaMeta: { heemang } };
}

function selection(core: HmCore, list: FurnitureList, page: number, startPara: number, startOffset: number, endPara: number, endOffset: number): SelectionRect[] {
  const rects = JSON.parse(core.call(doc => doc.select(JSON.stringify({ from: at(core, list, startPara, startOffset), to: at(core, list, endPara, endOffset), page })))) as Rect[];
  return rects.map(rect => ({ ...cursor(rect), width: px(rect.width) }));
}

function charProps(core: HmCore, list: FurnitureList, para: number, offset: number): CharProperties {
  const owner = list.steps[0];
  const textOffset = wireToText(paraMap(core.paragraph(list, para)), logicalToWire(mapIn(core, list, para), offset));
  return api.getCellCharPropertiesAt(core, list.section, owner.para, owner.control, owner.index, para, textOffset);
}

function paraProps(core: HmCore, list: FurnitureList, para: number) {
  const owner = list.steps[0];
  return api.getCellParaPropertiesAt(core, list.section, owner.para, owner.control, owner.index, para);
}

function formatChars(core: HmCore, list: FurnitureList, startPara: number, startOffset: number, endPara: number, endOffset: number, propsJson: string): string {
  const patch = format.charPatch(JSON.parse(propsJson));
  core.transact([{ op: 'formatChars', from: at(core, list, startPara, startOffset), to: at(core, list, endPara, endOffset), patch }]);
  return JSON.stringify({ ok: true });
}

function formatPara(core: HmCore, list: FurnitureList, para: number, propsJson: string): string {
  core.transact([{ op: 'formatParas', from: at(core, list, para, 0), to: toAddress(list, para, mapIn(core, list, para).end), patch: format.paraPatch(JSON.parse(propsJson)) }]);
  return JSON.stringify({ ok: true });
}

export function getHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number): string {
  const target = hfTarget(core, sec, isHeader, applyTo);
  if (!target) return JSON.stringify({ exists: false, paraCount: 0, text: '' });
  const list = nested(target, true), paraCount = core.paragraphCount(list);
  const text = Array.from({ length: paraCount }, (_, para) => core.paragraph(list, para).text).join('\n');
  return JSON.stringify({ exists: true, paraCount, text, paraIdx: target.para, controlIdx: target.control });
}

export function createHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number): string {
  if (!SIDES[applyTo]) throw new RangeError('잘못된 머리말·꼬리말 적용 범위');
  edit(core, { op: 'createHeaderFooter', section: sec, kind: isHeader ? 'header' : 'footer', side: SIDES[applyTo] });
  return JSON.stringify({ ok: true, ...JSON.parse(getHeaderFooter(core, sec, isHeader, applyTo)) });
}

export function deleteHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number): void {
  const target = hfTarget(core, sec, isHeader, applyTo);
  if (target) edit(core, { op: 'deleteControl', target: { section: sec, para: target.para, control: target.control } });
}

export function getHeaderFooterParaInfo(core: HmCore, sec: number, isHeader: boolean, applyTo: number, para: number): string {
  const list = hfList(core, sec, isHeader, applyTo), map = mapIn(core, list, para);
  return JSON.stringify({ ok: true, text: map.info.text, charCount: logicalLength(map), paraCount: core.paragraphCount(list) });
}

export function insertTextInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, para: number, offset: number, text: string): string {
  return JSON.stringify({ ok: true, charOffset: insert(core, hfList(core, sec, isHeader, applyTo), para, offset, text) });
}

export function insertTextContentInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, para: number, offset: number, content: TextContent): string {
  validateTextContent(content);
  return insertTextInHeaderFooter(core, sec, isHeader, applyTo, para, offset, content.text);
}

export function deleteTextInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, para: number, offset: number, count: number): string {
  return JSON.stringify(remove(core, hfList(core, sec, isHeader, applyTo), para, offset, count));
}

export function splitParagraphInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, para: number, offset: number, meta?: RemovedParaMeta): string {
  return JSON.stringify(split(core, hfList(core, sec, isHeader, applyTo), para, offset, meta));
}

export function mergeParagraphInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, para: number): string {
  return JSON.stringify(merge(core, hfList(core, sec, isHeader, applyTo), para));
}

export function replaceRangeInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, startPara: number, startOffset: number, endPara: number, endOffset: number, replacement: string) {
  const list = hfList(core, sec, isHeader, applyTo), from = at(core, list, startPara, startOffset), to = at(core, list, endPara, endOffset);
  const ops: EditOp[] = [];
  if (startPara !== endPara || startOffset !== endOffset) ops.push({ op: 'delete', from, to });
  if (replacement) ops.push({ op: 'insertText', at: from, text: replacement.replace(/\r\n?/g, '\n') });
  const caret = core.transact(ops)?.caret;
  const para = caret?.para ?? startPara;
  return { ok: true, hfParaIndex: para, charOffset: caret ? wireToLogical(mapIn(core, list, para), caret.offset) : startOffset };
}

export function copySelectionInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, startPara: number, startOffset: number, endPara: number, endOffset: number) {
  const list = hfList(core, sec, isHeader, applyTo);
  return { ok: true, ...JSON.parse(core.call(doc => doc.copy(JSON.stringify({ from: at(core, list, startPara, startOffset), to: at(core, list, endPara, endOffset) })))) as { text: string } };
}

export function getParaPropertiesInHf(core: HmCore, sec: number, isHeader: boolean, applyTo: number, para: number) { return paraProps(core, hfList(core, sec, isHeader, applyTo), para); }
export function applyParaFormatInHf(core: HmCore, sec: number, isHeader: boolean, applyTo: number, para: number, props: string) { return formatPara(core, hfList(core, sec, isHeader, applyTo), para, props); }
export function getCharPropertiesInHf(core: HmCore, sec: number, isHeader: boolean, applyTo: number, para: number, offset: number) { return charProps(core, hfList(core, sec, isHeader, applyTo), para, offset); }
export const getCharPropertiesInHeaderFooter = getCharPropertiesInHf;
export function applyCharFormatInHf(core: HmCore, sec: number, isHeader: boolean, applyTo: number, para: number, start: number, end: number, props: string) { return formatChars(core, hfList(core, sec, isHeader, applyTo), para, start, para, end, props); }
export function applyCharFormatInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, startPara: number, startOffset: number, endPara: number, endOffset: number, props: string) { return formatChars(core, hfList(core, sec, isHeader, applyTo), startPara, startOffset, endPara, endOffset, props); }

export function insertFieldInHf(core: HmCore, sec: number, isHeader: boolean, applyTo: number, para: number, offset: number, fieldType: number) {
  const kind = ({ 1: 'pageNumber', 2: 'pageCount', 3: 'fileName' } as Record<number, 'pageNumber' | 'pageCount' | 'fileName'>)[fieldType];
  if (!kind) throw new RangeError('잘못된 머리말·꼬리말 필드');
  // 엔진은 총 쪽수·파일 이름 필드의 원본 표현을 아직 확인하지 못해 쓰지 않는다.
  if (kind !== 'pageNumber') throw unsupported(kind === 'pageCount' ? '총 쪽수 필드' : '파일 이름 필드');
  const list = hfList(core, sec, isHeader, applyTo), before = mapIn(core, list, para);
  edit(core, { op: 'insertField', at: at(core, list, para, offset), kind });
  const length = logicalLength(mapIn(core, list, para)) - logicalLength(before);
  return { ok: true, charOffset: offset + length, insertedAt: offset, insertedLength: length };
}

function insertNote(core: HmCore, sec: number, para: number, offset: number, kind: 'footnote' | 'endnote') {
  const map = paraMap(core.paragraph(bodyList(sec), para));
  const position = toAddress(bodyList(sec), para, afterFieldEnds(map, logicalToWire(map, offset)));
  const before = new Set(core.paragraph(bodyList(sec), para).controls.map(control => control.index));
  edit(core, { op: 'insertNote', at: position, kind });
  const control = core.paragraph(bodyList(sec), para).controls.find(control => control.kind === kind && control.offset === position.offset)
    ?? core.paragraph(bodyList(sec), para).controls.find(control => control.kind === kind && !before.has(control.index));
  if (!control) throw new Error('삽입한 주석을 찾을 수 없습니다');
  return { ok: true, paraIdx: para, controlIdx: control.index, footnoteNumber: control.number ?? 1, endnoteNumber: control.number ?? 1 };
}

export function insertFootnote(core: HmCore, sec: number, para: number, offset: number) { return insertNote(core, sec, para, offset, 'footnote'); }
export function insertEndnote(core: HmCore, sec: number, para: number, offset: number) { return insertNote(core, sec, para, offset, 'endnote'); }
export function getFootnoteInfo(core: HmCore, sec: number, para: number, control: number) {
  const target = noteTarget(core, sec, para, control), list = nested(target), paraCount = core.paragraphCount(list);
  const texts = Array.from({ length: paraCount }, (_, p) => core.paragraph(list, p).text);
  return { ok: true, paraCount, totalTextLen: texts.reduce((count, text) => count + [...text].length, 0), number: target.info.number ?? 0, texts };
}
export function insertTextInFootnote(core: HmCore, sec: number, para: number, control: number, notePara: number, offset: number, text: string) { return { ok: true, charOffset: insert(core, noteList(core, sec, para, control), notePara, offset, text) }; }
export function insertTextContentInFootnote(core: HmCore, sec: number, para: number, control: number, notePara: number, offset: number, content: TextContent) { validateTextContent(content); return insertTextInFootnote(core, sec, para, control, notePara, offset, content.text); }
export function deleteTextInFootnote(core: HmCore, sec: number, para: number, control: number, notePara: number, offset: number, count: number) { return remove(core, noteList(core, sec, para, control), notePara, offset, count); }
export function splitParagraphInFootnote(core: HmCore, sec: number, para: number, control: number, notePara: number, offset: number, meta?: RemovedParaMeta) { return split(core, noteList(core, sec, para, control), notePara, offset, meta); }
export function mergeParagraphInFootnote(core: HmCore, sec: number, para: number, control: number, notePara: number) { return merge(core, noteList(core, sec, para, control), notePara); }
export function getParaPropertiesInFootnote(core: HmCore, sec: number, para: number, control: number, notePara: number) { return paraProps(core, noteList(core, sec, para, control), notePara); }
export function applyParaFormatInFootnote(core: HmCore, sec: number, para: number, control: number, notePara: number, props: string) { return formatPara(core, noteList(core, sec, para, control), notePara, props); }
export function getCharPropertiesInFootnote(core: HmCore, sec: number, para: number, control: number, notePara: number, offset: number) { return charProps(core, noteList(core, sec, para, control), notePara, offset); }
export function applyCharFormatInFootnote(core: HmCore, sec: number, para: number, control: number, notePara: number, start: number, end: number, props: string) { return formatChars(core, noteList(core, sec, para, control), notePara, start, notePara, end, props); }

export function getFootnoteAtCursor(core: HmCore, sec: number, para: number, offset: number, direction: 'backward' | 'forward') {
  const map = paraMap(core.paragraph(bodyList(sec), para));
  const target = map.info.controls.find(control => ['footnote', 'endnote'].includes(control.kind) && wireToLogical(map, control.offset) === offset - (direction === 'backward' ? 1 : 0));
  return target ? { hit: true, sectionIndex: sec, paragraphIndex: para, controlIndex: target.index, charOffset: wireToLogical(map, target.offset), footnoteNumber: target.number } : { hit: false };
}

export function deleteFootnote(core: HmCore, sec: number, para: number, control: number) {
  const target = noteTarget(core, sec, para, control), charOffset = wireToLogical(paraMap(core.paragraph(bodyList(sec), para)), target.info.offset);
  edit(core, { op: 'deleteControl', target: { section: sec, para, control } });
  return { ok: true, sectionIndex: sec, paragraphIndex: para, controlIndex: control, charOffset, deletedNumber: target.info.number ?? 0 };
}

function notesOnPage(core: HmCore, page: number): FurnitureTarget[] {
  const found: FurnitureTarget[] = [];
  for (let sec = 0; sec < core.adapter.getSectionCount(); sec++) {
    for (const target of furniture(core, sec)) {
      if (!['footnote', 'endnote'].includes(target.info.kind)) continue;
      const list = nested(target);
      if (Array.from({ length: core.paragraphCount(list) }, (_, para) => core.lines(list, para)).flat().some(line => line.page === page)) found.push(target);
      else if (core.caret(at(core, list, 0, 0), 'downstream', page)?.page === page) found.push(target);
    }
  }
  return found;
}

export function getPageFootnoteInfo(core: HmCore, page: number, index: number) {
  const target = notesOnPage(core, page)[index];
  return target ? { ok: true, sectionIdx: target.section, paraIdx: target.para, controlIdx: target.control, sourceType: 'body' } : null;
}
export function pageHasFootnoteFootholds(core: HmCore, page: number): boolean { return notesOnPage(core, page).length > 0; }
export function getCursorRectInNote(core: HmCore, sec: number, para: number, control: number, notePara: number, offset: number): CursorRect | null {
  const caret = core.caret(at(core, noteList(core, sec, para, control), notePara, offset));
  return caret ? cursor(caret) : null;
}
export function getCursorRectInFootnote(core: HmCore, page: number, index: number, para: number, offset: number): CursorRect | null {
  const target = notesOnPage(core, page)[index];
  if (!target) return null;
  const caret = core.caret(at(core, nested(target), para, offset), 'downstream', page);
  return caret ? cursor(caret) : null;
}
export function getNoteEditInfo(core: HmCore, sec: number, para: number, control: number) {
  const target = noteTarget(core, sec, para, control), caret = core.caret(at(core, nested(target), 0, 0));
  if (!caret) return null;
  return { ok: true, kind: target.info.kind, pageNum: caret.page, footnoteIndex: notesOnPage(core, caret.page).findIndex(item => item.section === sec && item.para === para && item.control === control), fnParaIndex: 0, charOffset: 0 };
}
export function getSelectionRectsInFootnote(core: HmCore, page: number, index: number, startPara: number, start: number, endPara: number, end: number): SelectionRect[] {
  const target = notesOnPage(core, page)[index];
  return target ? selection(core, nested(target), page, startPara, start, endPara, end) : [];
}
export function hitTestInFootnote(core: HmCore, page: number, x: number, y: number) {
  const located = core.locate(page, x, y), step = located?.position.steps?.[0];
  if (!located || !step) return { hit: false };
  const notes = notesOnPage(core, page), index = notes.findIndex(note => note.section === located.position.section && note.para === step.para && note.control === step.control);
  if (index < 0) return { hit: false };
  return { hit: true, footnoteIndex: index, fnParaIndex: located.position.para, charOffset: wireToLogical(mapIn(core, nested(notes[index]), located.position.para), located.position.offset), cursorRect: cursor(located.caret) };
}
export function hitTestFootnote(core: HmCore, page: number, x: number, y: number) { const hit = hitTestInFootnote(core, page, x, y); return { hit: hit.hit, footnoteIndex: hit.footnoteIndex }; }
export function hitTestBodyFootnoteMarker(core: HmCore, page: number, x: number, y: number) {
  const located = core.locate(page, x, y, { body: true });
  if (!located || located.position.steps?.length) return { hit: false };
  const info = core.paragraph(bodyList(located.position.section), located.position.para), map = paraMap(info);
  for (const control of info.controls.filter(item => ['footnote', 'endnote'].includes(item.kind))) {
    const caret = core.caret(toAddress(bodyList(located.position.section), located.position.para, control.offset), 'downstream', page);
    const after = core.caret(toAddress(bodyList(located.position.section), located.position.para, control.offset + 8), 'upstream', page);
    if (!caret || !after || caret.page !== page) continue;
    const left = Math.min(px(caret.x), px(after.x)), right = Math.max(px(caret.x), px(after.x));
    if (x < left || x > right || y < px(caret.y) || y > px(caret.y + caret.height)) continue;
    return { hit: true, sectionIndex: located.position.section, paragraphIndex: info.index, controlIndex: control.index, footnoteNumber: control.number, bbox: { x: left, y: px(caret.y), w: right - left, h: px(caret.height) }, cursorRect: cursor(caret), charOffset: wireToLogical(map, control.offset) };
  }
  return { hit: false };
}

export function getHeaderFooterEditTarget(core: HmCore, page: number, isHeader: boolean) {
  const p = core.adapter.getPageInfo(page), side = SIDES[(p.pageNumber ?? page + 1) % 2 ? 2 : 1];
  const candidates = new Map<Side, FurnitureTarget>();
  for (let sec = 0; sec <= p.sectionIndex; sec++) for (const target of furniture(core, sec)) {
    if (target.info.kind === (isHeader ? 'header' : 'footer') && target.info.side) candidates.set(target.info.side, target);
  }
  const target = candidates.get(side) ?? candidates.get('both');
  return { sectionIndex: target?.section ?? p.sectionIndex, applyTo: target ? SIDES.indexOf(target.info.side!) : 0 };
}
export function getHeaderFooterPreviewPage(core: HmCore, sec: number): number {
  const pages = core.adapter.getAllPageInfo();
  return pages.find(page => page.sectionIndex === sec)?.pageIndex ?? 0;
}
export function getCursorRectInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, para: number, offset: number, page: number): CursorRect {
  const caret = core.caret(at(core, hfList(core, sec, isHeader, applyTo), para, offset), 'downstream', page);
  if (!caret) throw new Error('머리말·꼬리말의 캐럿을 찾을 수 없습니다');
  return cursor(caret);
}
export function getSelectionRectsInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, page: number, startPara: number, start: number, endPara: number, end: number) { return selection(core, hfList(core, sec, isHeader, applyTo), page, startPara, start, endPara, end); }
export function hitTestHeaderFooter(core: HmCore, page: number, x: number, y: number) {
  const p = core.adapter.getPageInfo(page);
  for (const isHeader of [true, false]) {
    const area = isHeader ? p.headerArea : p.footerArea;
    if (!area || x < area.x || x > area.x + area.width || y < area.y || y > area.y + area.height) continue;
    return { hit: true, isHeader, ...getHeaderFooterEditTarget(core, page, isHeader) };
  }
  return { hit: false };
}
export function hitTestInHeaderFooterTarget(core: HmCore, page: number, sec: number, isHeader: boolean, applyTo: number, x: number, y: number) {
  const list = hfList(core, sec, isHeader, applyTo), located = core.locate(page, x, y, { within: list });
  if (!located) return { hit: false };
  return { hit: true, sectionIndex: sec, applyTo, paraIndex: located.position.para, charOffset: wireToLogical(mapIn(core, list, located.position.para), located.position.offset), cursorRect: cursor(located.caret) };
}
export function hitTestInHeaderFooter(core: HmCore, page: number, isHeader: boolean, x: number, y: number) {
  const target = getHeaderFooterEditTarget(core, page, isHeader);
  if (!hfTarget(core, target.sectionIndex, isHeader, target.applyTo)) return { hit: false };
  return hitTestInHeaderFooterTarget(core, page, target.sectionIndex, isHeader, target.applyTo, x, y);
}
export function renderHeaderFooterEditPreviewToCanvas(core: HmCore, page: number, sec: number, isHeader: boolean, applyTo: number, canvas: HTMLCanvasElement, scale: number): void {
  const target = getHeaderFooterEditTarget(core, page, isHeader);
  if (target.sectionIndex !== sec || target.applyTo !== applyTo) throw unsupported('표시되지 않는 머리말·꼬리말 편집 미리보기');
  core.adapter.renderPageToCanvas(page, canvas, scale);
}
export function getHeaderFooterList(core: HmCore, currentSection: number, currentIsHeader: boolean, currentApplyTo: number) {
  const items = Array.from({ length: core.adapter.getSectionCount() }, (_, sec) => furniture(core, sec).filter(target => ['header', 'footer'].includes(target.info.kind)).map(target => ({ sectionIdx: sec, isHeader: target.info.kind === 'header', applyTo: SIDES.indexOf(target.info.side!), label: `${sec + 1}구역 ${target.info.kind === 'header' ? '머리말' : '꼬리말'} ${['양쪽', '짝수 쪽', '홀수 쪽'][SIDES.indexOf(target.info.side!)]}` }))).flat();
  return { ok: true, items, currentIndex: items.findIndex(item => item.sectionIdx === currentSection && item.isHeader === currentIsHeader && item.applyTo === currentApplyTo) };
}
export function navigateHeaderFooterByPage(core: HmCore, currentPage: number, isHeader: boolean, direction: number) {
  if (!direction) return { ok: false };
  for (let page = currentPage + Math.sign(direction); page >= 0 && page < core.adapter.pageCount; page += Math.sign(direction)) {
    const target = getHeaderFooterEditTarget(core, page, isHeader);
    if (hfTarget(core, target.sectionIndex, isHeader, target.applyTo)) return { ok: true, pageIndex: page, sectionIdx: target.sectionIndex, isHeader, applyTo: target.applyTo };
  }
  return { ok: false };
}
export function toggleHideHeaderFooter(core: HmCore, page: number, isHeader: boolean) {
  const located = core.locate(page, 0, 0, { body: true });
  if (!located) throw new Error('쪽의 첫 본문 위치를 찾을 수 없습니다');
  const position = located.position.steps?.length ? { section: located.position.section, para: located.position.steps[0].para, offset: 0 } : located.position;
  const controls = core.query<ControlRecord[]>({ kind: 'controls', list: bodyList(position.section) });
  const existing = controls.find(control => control.kind === 'pageHide' && !control.target.steps?.length && control.target.para === position.para);
  const bit = isHeader ? 1 : 2, flags = (existing?.flags ?? 0) ^ bit;
  edit(core, { op: 'setPageHide', at: position, flags });
  return { hidden: !!(flags & bit) };
}

const NUMBER_FORMATS: Record<string, number> = { digit: 0, circledDigit: 1, upperRoman: 2, lowerRoman: 3, upperAlpha: 4, lowerAlpha: 5, hangulSyllable: 8, hangulJamo: 10, hangulDigit: 12, hanjaDigit: 13 };
interface NoteShape { attr?: number; userChar?: number; prefix?: number; suffix?: number; start?: number; separatorLength?: number; spaceAbove?: number; spaceBelow?: number; spaceBetween?: number; lineKind?: number; lineWidth?: number; lineColor?: number }
export function getEndnoteShape(core: HmCore, sec: number): EndnoteShapeSettings {
  const shape = core.query<NoteShape | null>({ kind: 'noteShape', section: sec, noteKind: 'endnote' }) ?? {};
  const attr = shape.attr ?? 0;
  return { ok: true, numberFormat: Object.keys(NUMBER_FORMATS).find(key => NUMBER_FORMATS[key] === (attr & 0xff)) ?? 'digit', userChar: String.fromCharCode(shape.userChar ?? 0).replace('\0', ''), prefixChar: String.fromCharCode(shape.prefix ?? 0).replace('\0', ''), suffixChar: String.fromCharCode(shape.suffix ?? 0).replace('\0', ''), startNumber: shape.start ?? 1, separatorEnabled: shape.separatorLength !== 0, separatorLength: shape.separatorLength ?? -1, separatorMarginTop: shape.spaceAbove ?? 0, separatorMarginBottom: shape.spaceBelow ?? 0, noteSpacing: shape.spaceBetween ?? 0, separatorLineType: shape.lineKind ?? 1, separatorLineWidth: shape.lineWidth ?? 0, separatorColor: format.colorToHex(shape.lineColor ?? 0), numbering: ['continue', 'restartSection', 'restartPage'][(attr >> 10) & 3] ?? 'continue', placement: ((attr >> 8) & 3) === 1 ? 'sectionEnd' : 'documentEnd' };
}
export function applyEndnoteShape(core: HmCore, sec: number, settings: EndnoteShapeSettings) {
  const before = core.query<NoteShape | null>({ kind: 'noteShape', section: sec, noteKind: 'endnote' });
  const numberFormat = NUMBER_FORMATS[settings.numberFormat];
  if (numberFormat === undefined) throw new Error('지원하지 않는 미주 번호 모양');
  const attr = ((before?.attr ?? 0) & ~(0xff | (3 << 8) | (3 << 10))) | numberFormat | (settings.placement === 'sectionEnd' ? 1 << 8 : 0) | (Math.max(0, ['continue', 'restartSection', 'restartPage'].indexOf(settings.numbering)) << 10);
  edit(core, { op: 'setNoteShape', section: sec, kind: 'endnote', patch: { attr, userChar: settings.userChar.charCodeAt(0) || 0, prefix: settings.prefixChar.charCodeAt(0) || 0, suffix: settings.suffixChar.charCodeAt(0) || 0, start: settings.startNumber, separatorLength: settings.separatorEnabled ? settings.separatorLength : 0, spaceAbove: settings.separatorMarginTop, spaceBelow: settings.separatorMarginBottom, spaceBetween: settings.noteSpacing, lineKind: settings.separatorLineType, lineWidth: settings.separatorLineWidth, lineColor: format.hexToColor(settings.separatorColor) } });
  return { ok: true };
}

/**
 * 머리말·꼬리말 마당: 지우고 새로 만든 뒤 쪽 번호를 넣고 정렬한다. 6~10 은 1~5 에 굵게·밑줄을 더한다.
 * 파일 이름이 든 마당(4·5·9·10)은 엔진이 파일 이름 필드를 아직 쓰지 못해 막는다.
 */
export function applyHfTemplate(core: HmCore, sec: number, isHeader: boolean, applyTo: number, templateId: number): { ok: boolean } {
  if (!Number.isInteger(templateId) || templateId < 0 || templateId > 10) throw new RangeError('알 수 없는 머리말·꼬리말 마당');
  if (!SIDES[applyTo]) throw new RangeError('잘못된 머리말·꼬리말 적용 범위');
  const layout = templateId <= 5 ? templateId : templateId - 5;
  if (layout === 4 || layout === 5) throw unsupported('파일 이름이 든 머리말·꼬리말 마당');
  deleteHeaderFooter(core, sec, isHeader, applyTo);
  createHeaderFooter(core, sec, isHeader, applyTo);
  if (layout === 0) return { ok: true };
  const list = hfList(core, sec, isHeader, applyTo);
  edit(core, { op: 'insertField', at: at(core, list, 0, 0), kind: 'pageNumber' });
  const map = mapIn(core, list, 0), from = toAddress(list, 0, map.lead), to = toAddress(list, 0, map.end);
  const ops: EditOp[] = [{ op: 'formatParas', from, to, patch: format.paraPatch({ alignment: ['left', 'center', 'right'][layout - 1] }) }];
  if (templateId > 5) ops.push({ op: 'formatChars', from, to, patch: format.charPatch({ bold: true, underline: true }) });
  core.transact(ops);
  return { ok: true };
}

/** 취소·되돌리기는 같은 목록 주소에서 기존 모양 ID를 그대로 복원한다. */
function shapeId(core: HmCore, list: FurnitureList, para: number, id: number, start?: number, end?: number): string {
  const from = at(core, list, para, start ?? 0);
  const to = start === undefined ? toAddress(list, para, mapIn(core, list, para).end) : at(core, list, para, end!);
  core.transact([start === undefined ? { op: 'setParaShape', from, to, paraShapeId: id } : { op: 'setCharShape', from, to, charShapeId: id }]);
  return JSON.stringify({ ok: true });
}
export function setCharShapeIdInFootnote(core: HmCore, sec: number, para: number, control: number, fnPara: number, start: number, end: number, id: number): string {
  return shapeId(core, noteList(core, sec, para, control), fnPara, id, start, end);
}
export function setParaShapeIdInFootnote(core: HmCore, sec: number, para: number, control: number, fnPara: number, id: number): string {
  return shapeId(core, noteList(core, sec, para, control), fnPara, id);
}
export function setCharShapeIdInHf(core: HmCore, sec: number, header: boolean, applyTo: number, para: number, start: number, end: number, id: number): string {
  return shapeId(core, hfList(core, sec, header, applyTo), para, id, start, end);
}
export function setParaShapeIdInHf(core: HmCore, sec: number, header: boolean, applyTo: number, para: number, id: number): string {
  return shapeId(core, hfList(core, sec, header, applyTo), para, id);
}

extendBridge({
  setCharShapeIdInFootnote, setParaShapeIdInFootnote, setCharShapeIdInHf, setParaShapeIdInHf,
  applyHfTemplate, getHeaderFooter, createHeaderFooter, deleteHeaderFooter, getHeaderFooterParaInfo,
  insertTextInHeaderFooter, insertTextContentInHeaderFooter, deleteTextInHeaderFooter, splitParagraphInHeaderFooter,
  mergeParagraphInHeaderFooter, replaceRangeInHeaderFooter, copySelectionInHeaderFooter,
  getParaPropertiesInHf, applyParaFormatInHf, getCharPropertiesInHf, getCharPropertiesInHeaderFooter, applyCharFormatInHf, applyCharFormatInHeaderFooter,
  insertFieldInHf, insertFootnote, insertEndnote, getFootnoteInfo, insertTextInFootnote, insertTextContentInFootnote,
  deleteTextInFootnote, splitParagraphInFootnote, mergeParagraphInFootnote, getParaPropertiesInFootnote, applyParaFormatInFootnote,
  getCharPropertiesInFootnote, applyCharFormatInFootnote, getFootnoteAtCursor, deleteFootnote,
  getPageFootnoteInfo, pageHasFootnoteFootholds, getCursorRectInNote, getCursorRectInFootnote, getNoteEditInfo,
  getSelectionRectsInFootnote, hitTestInFootnote, hitTestFootnote, hitTestBodyFootnoteMarker,
  getHeaderFooterEditTarget, getHeaderFooterPreviewPage, getCursorRectInHeaderFooter, getSelectionRectsInHeaderFooter,
  hitTestHeaderFooter, hitTestInHeaderFooterTarget, hitTestInHeaderFooter, renderHeaderFooterEditPreviewToCanvas,
  getHeaderFooterList, navigateHeaderFooterByPage, toggleHideHeaderFooter, getEndnoteShape, applyEndnoteShape,
});
