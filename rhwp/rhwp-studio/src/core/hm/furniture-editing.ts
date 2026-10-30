/** 머리말·꼬리말과 주석을 엔진의 중첩 문단 목록으로 편집한다. */
import type { Address, Caret, Located, ControlInfo, EditOp, FormatContext, Rect, Step } from '../../../vendor/hm-wasm/hm_wasm';
import type { HmCore, ListAddress } from './core';
import { hu, px } from './core';
import { addressToPosition, afterFieldEnds, bodyList, isLogicalControl, lineBreakText, logicalLength, logicalRangeToWire, logicalToWire, paraMap, pathTarget, positionTarget, stepsToPath, toAddress, wireToLogical, wireToText } from './address';
import { copyRange } from './clipboard-native';
import { api, extendBridge } from './api';
import * as format from './format';
import { paraOps, widgetCharPatch } from './format-widgets';
import type { CharProperties, CursorRect, DocumentPosition, EndnoteShapeSettings, NoteCaret, NoteContentInfo, NoteHit, NoteListEntry, NoteRef, RemovedParaMeta, SelectionRect, TextContent } from './bridge-types';
import { validateTextContent } from '../local-text-replace-result';

type Side = 'both' | 'even' | 'odd';
const SIDES: Side[] = ['both', 'even', 'odd'];
interface FurnitureTarget { section: number; para: number; control: number; info: ControlInfo }
interface FurnitureList extends ListAddress { headerFooter?: boolean }
interface ControlRecord { target: { section: number; steps?: ListAddress['steps']; para: number; control: number }; offset: number; kind: string; flags?: number; number?: number; lists?: { section: number; steps?: Step[] }[] }

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

/** 기존 HF·주석 커서는 유니코드 scalar를 센다. 엔진 주소는 UTF-16 wire 단위다. */
function mapIn(core: HmCore, list: FurnitureList, para: number) {
  const info = core.paragraph(list, para);
  const units: { start: number; width: number; text: string | null; kind?: string }[] = [];
  let utf16 = 0;
  for (const text of info.text) {
    units.push({ start: info.offsets[utf16], width: text === '\t' ? 8 : text.length, text });
    utf16 += text.length;
  }
  // 머리말의 쪽 번호와 주석 자신의 번호는 한 칸이다. 주석 캐럿 0 은 번호 앞이다(한컴: Home 이 번호 앞으로 가고 그 앞에 글자를 칠 수 있다).
  for (const control of info.controls) {
    if (isLogicalControl(control) || control.kind === 'autoNumber') units.push({ start: control.offset, width: 8, text: null, kind: control.kind });
  }
  units.sort((a, b) => a.start - b.start);
  return { ...paraMap(info), stops: units.map(unit => unit.start), widths: units.map(unit => unit.width), isText: units.map(unit => unit.text !== null),
    lead: info.caret[0], end: info.offsets.at(-1)!, units };
}

const at = (core: HmCore, list: FurnitureList, para: number, offset: number): Address => toAddress(list, para, logicalToWire(mapIn(core, list, para), offset));
const cursor = (caret: { page: number; x: number; y: number; height: number }): CursorRect => ({ pageIndex: caret.page, x: px(caret.x), y: px(caret.y), height: px(caret.height) });

function insert(core: HmCore, list: FurnitureList, para: number, offset: number, text: string): number {
  if (!text) return offset;
  const receipt = core.transact([{ op: 'insertText', at: at(core, list, para, offset), text: lineBreakText(text) }]);
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

/** 중첩 목록(셀 안 주석 포함)의 문단을 셀 경로 API 로 부른다. */
const listPath = (list: FurnitureList, para: number) => ({ parent: list.steps[0].para, path: JSON.stringify(stepsToPath(list.steps, para)) });

function charProps(core: HmCore, list: FurnitureList, para: number, offset: number): CharProperties {
  const textOffset = wireToText(paraMap(core.paragraph(list, para)), logicalToWire(mapIn(core, list, para), offset));
  const { parent, path } = listPath(list, para);
  return api.getCellCharPropertiesAtByPath(core, list.section, parent, path, textOffset);
}

function paraProps(core: HmCore, list: FurnitureList, para: number) {
  const { parent, path } = listPath(list, para);
  return api.getCellParaPropertiesAtByPath(core, list.section, parent, path);
}

/** 본문과 같은 서식 변환을 쓴다. 밑줄 색·모양, 양각, 고정 줄 간격, 오른쪽 여백도 머리말·주석에서 바뀐다. */
function formatChars(core: HmCore, list: FurnitureList, startPara: number, startOffset: number, endPara: number, endOffset: number, propsJson: string): string {
  const from = at(core, list, startPara, startOffset), to = at(core, list, endPara, endOffset);
  const patch = widgetCharPatch(core, JSON.parse(propsJson), () => core.query<FormatContext>({ kind: 'formatContext', at: from, to }).characters);
  if (Object.keys(patch).length) core.transact([{ op: 'formatChars', from, to, patch }]);
  return JSON.stringify({ ok: true });
}

function formatPara(core: HmCore, list: FurnitureList, para: number, propsJson: string): string {
  core.transact(paraOps(core, list, para, para, JSON.parse(propsJson)));
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
  const list = hfList(core, sec, isHeader, applyTo), before = mapIn(core, list, para);
  edit(core, { op: 'insertField', at: at(core, list, para, offset), kind, ...(kind === 'fileName' ? { command: '$F', text: core.adapter.fileName || '문서' } : {}) });
  const length = logicalLength(mapIn(core, list, para)) - logicalLength(before);
  return { ok: true, charOffset: offset + length, insertedAt: offset, insertedLength: length };
}

// ─── 각주·미주 ───────────────────────────────────────────

type NoteKind = 'footnote' | 'endnote';
const isNoteKind = (kind: string): kind is NoteKind => kind === 'footnote' || kind === 'endnote';
/** 번호·개체처럼 글자가 아닌 칸을 units 문자열에서 나타낸다. */
const OBJECT_UNIT = '￼';

/** 주석 표시가 든 문단. path 는 Studio 셀 경로 JSON 이고 para 는 맨 바깥 본문 문단이다. 본문 주석은 path 가 없다. */
function noteOwner(sec: number, para: number, path?: string | null): { list: ListAddress; para: number } {
  return path && path !== '[]' ? pathTarget(sec, para, path) : { list: bodyList(sec), para };
}

interface NoteTarget { owner: { list: ListAddress; para: number }; control: number; info: ControlInfo; list: FurnitureList }

function noteTarget(core: HmCore, sec: number, para: number, control: number, path?: string | null): NoteTarget {
  const owner = noteOwner(sec, para, path);
  const info = core.paragraph(owner.list, owner.para).controls.find(item => item.index === control);
  if (!info || !isNoteKind(info.kind)) throw new Error('각주·미주가 없습니다');
  return { owner, control, info, list: { section: sec, steps: [...owner.list.steps, { para: owner.para, control, index: 0 }] } };
}

const noteList = (core: HmCore, sec: number, para: number, control: number, path?: string | null): FurnitureList => noteTarget(core, sec, para, control, path).list;

/** 엔진의 컨트롤 주소를 Studio 주석 주소로 바꾼다. */
function refOf(target: { section: number; steps?: Step[]; para: number; control: number }): NoteRef {
  const steps = target.steps ?? [];
  if (!steps.length) return { sectionIdx: target.section, paraIdx: target.para, controlIdx: target.control };
  return { sectionIdx: target.section, paraIdx: steps[0].para, controlIdx: target.control, cellPath: stepsToPath(steps, target.para) };
}

const refKey = (ref: NoteRef): string => JSON.stringify([ref.sectionIdx, ref.paraIdx, ref.controlIdx, ref.cellPath ?? []]);
const sameSteps = (a: readonly Step[] | undefined, b: readonly Step[]): boolean =>
  (a ?? []).length === b.length && (a ?? []).every((step, i) => step.para === b[i].para && step.control === b[i].control && step.index === b[i].index);

interface NoteEntry extends NoteHit { key: string; list: FurnitureList; owner: ListAddress; ownerPara: number }

const directories = new WeakMap<HmCore, { tag: string; notes: NoteEntry[]; pageTag?: string; pages?: Map<number, NoteEntry[]> }>();

/** 문서의 모든 주석(본문·표 셀·글상자)을 문서 순서로. 내용이 바뀔 때만 다시 읽는다. */
function noteDirectory(core: HmCore) {
  const tag = core.contentRevision;
  let directory = directories.get(core);
  if (directory?.tag !== tag) {
    const controls = core.query<ControlRecord[]>({ kind: 'controls' });
    const notes = controls.filter(control => isNoteKind(control.kind)).map((control): NoteEntry => {
      const target = { ...control.target, steps: control.target.steps ?? [] };
      const ref = refOf(target);
      return {
        ...ref, kind: control.kind as NoteKind, number: control.number ?? 0, key: refKey(ref),
        owner: { section: target.section, steps: target.steps }, ownerPara: target.para,
        list: { section: target.section, steps: [...target.steps, { para: target.para, control: target.control, index: 0 }] },
      };
    });
    directory = { tag, notes };
    directories.set(core, directory);
  }
  return directory;
}

/** 쪽마다 그 쪽에 줄이 놓인 주석. 조판이 바뀔 때만 다시 센다. */
function notesOnPage(core: HmCore, page: number): NoteEntry[] {
  const directory = noteDirectory(core);
  const tag = `${core.contentRevision}:${core.state().layoutEpoch}`;
  if (directory.pageTag !== tag || !directory.pages) {
    const pages = new Map<number, NoteEntry[]>();
    for (const note of directory.notes) {
      const seen = new Set<number>();
      for (let para = 0; para < core.paragraphCount(note.list); para++) for (const line of core.lines(note.list, para)) seen.add(line.page);
      if (!seen.size) {
        const caret = core.caret(toAddress(note.list, 0, 0));
        if (caret) seen.add(caret.page);
      }
      for (const p of seen) {
        const bucket = pages.get(p);
        if (bucket) bucket.push(note); else pages.set(p, [note]);
      }
    }
    directory.pageTag = tag;
    directory.pages = pages;
  }
  return directory.pages.get(page) ?? [];
}

const sourceTypeOf = (core: HmCore, note: NoteEntry): NoteListEntry['sourceType'] => {
  const steps = note.owner.steps;
  if (!steps.length) return 'body';
  const step = steps[steps.length - 1];
  const parent = core.paragraph({ section: note.owner.section, steps: steps.slice(0, -1) }, step.para).controls.find(item => item.index === step.control);
  return parent?.kind === 'table' ? 'table' : 'shape';
};

/** 주소가 주석 목록 안이면 그 주석. 주석 안 표처럼 더 깊은 곳은 주석 편집 대상이 아니다. */
function noteAtAddress(core: HmCore, address: Address): { ref: NoteRef; kind: NoteKind; number: number; list: FurnitureList } | null {
  const steps = address.steps ?? [];
  const last = steps.at(-1);
  if (!last) return null;
  const parent: ListAddress = { section: address.section, steps: steps.slice(0, -1) };
  const info = core.paragraph(parent, last.para).controls.find(item => item.index === last.control);
  if (!info || !isNoteKind(info.kind)) return null;
  return { ref: refOf({ section: address.section, steps: parent.steps, para: last.para, control: last.control }), kind: info.kind, number: info.number ?? 0, list: { section: address.section, steps } };
}

const caretIn = (core: HmCore, list: FurnitureList, address: Address | undefined, fallback: NoteCaret): NoteCaret =>
  address && sameSteps(address.steps, list.steps)
    ? { fnParaIndex: address.para, charOffset: wireToLogical(mapIn(core, list, address.para), address.offset) }
    : fallback;

/** 주석 내용: 문단 글자, 논리 길이, 번호 칸, 번호와 공백 뒤의 내용. */
function noteContent(core: HmCore, target: NoteTarget): NoteContentInfo {
  const list = target.list, paraCount = core.paragraphCount(list);
  const texts: string[] = [], lengths: number[] = [], units: string[] = [], numbers: NoteCaret[] = [];
  for (let para = 0; para < paraCount; para++) {
    const map = mapIn(core, list, para);
    texts.push(map.info.text);
    lengths.push(logicalLength(map));
    units.push(map.units.map(unit => unit.text ?? OBJECT_UNIT).join(''));
    map.units.forEach((unit, charOffset) => { if (unit.kind === 'autoNumber') numbers.push({ fnParaIndex: para, charOffset }); });
  }
  // 한컴 새 주석은 [번호][공백]으로 시작한다. 에이전트가 읽고 쓰는 주석 글은 그 뒤다.
  const first = mapIn(core, list, 0).units;
  let start = 0;
  if (first[0]?.kind === 'autoNumber') start = first[1]?.text === ' ' ? 2 : 1;
  const plain = (para: number, from = 0) => mapIn(core, list, para).units.slice(from).map(unit => unit.text ?? '').join('');
  const noteText = Array.from({ length: paraCount }, (_, para) => plain(para, para === 0 ? start : 0)).join('\n');
  return { ok: true, kind: target.info.kind as NoteKind, paraCount, totalTextLen: texts.reduce((count, text) => count + [...text].length, 0),
    number: target.info.number ?? 0, texts, lengths, units, numbers, noteText, textStart: { fnParaIndex: 0, charOffset: start } };
}

/** 위치(본문·표 셀·글상자)에 주석을 넣는다. 캐럿은 엔진 영수증의 캐럿(새 주석의 번호와 공백 뒤)이다. */
export function insertNoteAt(core: HmCore, pos: DocumentPosition, kind: NoteKind) {
  if (!isNoteKind(kind)) throw new RangeError('잘못된 주석 종류');
  const { list, para } = positionTarget(pos);
  const map = paraMap(core.paragraph(list, para));
  const position = toAddress(list, para, afterFieldEnds(map, logicalToWire(map, pos.charOffset)));
  const before = new Set(core.paragraph(list, para).controls.map(control => control.index));
  const receipt = core.transact([{ op: 'insertNote', at: position, kind }]);
  const controls = core.paragraph(list, para).controls;
  const control = controls.find(item => item.kind === kind && item.offset === position.offset)
    ?? controls.find(item => item.kind === kind && !before.has(item.index));
  if (!control) throw new Error('삽입한 주석을 찾을 수 없습니다');
  const ref = refOf({ section: list.section, steps: list.steps, para, control: control.index });
  const target = noteTarget(core, ref.sectionIdx, ref.paraIdx, ref.controlIdx, notePath(ref));
  const caret = caretIn(core, target.list, receipt?.caret, noteContent(core, target).textStart);
  return { ok: true, kind, ...ref, number: control.number ?? 1, ...caret, anchor: addressToPosition(core, toAddress(list, para, control.offset)) };
}

/** NoteRef 의 셀 경로 JSON. 본문 주석이면 undefined. */
export const notePath = (ref: Pick<NoteRef, 'cellPath'>): string | undefined => ref.cellPath?.length ? JSON.stringify(ref.cellPath) : undefined;

function insertBodyNote(core: HmCore, sec: number, para: number, offset: number, kind: NoteKind) {
  const note = insertNoteAt(core, { sectionIndex: sec, paragraphIndex: para, charOffset: offset }, kind);
  return { ok: true, paraIdx: para, controlIdx: note.controlIdx, footnoteNumber: note.number, endnoteNumber: note.number, fnParaIndex: note.fnParaIndex, charOffset: note.charOffset };
}

export function insertFootnote(core: HmCore, sec: number, para: number, offset: number) { return insertBodyNote(core, sec, para, offset, 'footnote'); }
export function insertEndnote(core: HmCore, sec: number, para: number, offset: number) { return insertBodyNote(core, sec, para, offset, 'endnote'); }
export function getFootnoteInfo(core: HmCore, sec: number, para: number, control: number, path?: string): NoteContentInfo { return noteContent(core, noteTarget(core, sec, para, control, path)); }
export function insertTextInFootnote(core: HmCore, sec: number, para: number, control: number, notePara: number, offset: number, text: string, path?: string) { return { ok: true, charOffset: insert(core, noteList(core, sec, para, control, path), notePara, offset, text) }; }
export function insertTextContentInFootnote(core: HmCore, sec: number, para: number, control: number, notePara: number, offset: number, content: TextContent, path?: string) { validateTextContent(content); return insertTextInFootnote(core, sec, para, control, notePara, offset, content.text, path); }
export function deleteTextInFootnote(core: HmCore, sec: number, para: number, control: number, notePara: number, offset: number, count: number, path?: string) { return remove(core, noteList(core, sec, para, control, path), notePara, offset, count); }
export function splitParagraphInFootnote(core: HmCore, sec: number, para: number, control: number, notePara: number, offset: number, meta?: RemovedParaMeta, path?: string) { return split(core, noteList(core, sec, para, control, path), notePara, offset, meta); }
export function mergeParagraphInFootnote(core: HmCore, sec: number, para: number, control: number, notePara: number, path?: string) { return merge(core, noteList(core, sec, para, control, path), notePara); }
export function getParaPropertiesInFootnote(core: HmCore, sec: number, para: number, control: number, notePara: number, path?: string) { return paraProps(core, noteList(core, sec, para, control, path), notePara); }
export function applyParaFormatInFootnote(core: HmCore, sec: number, para: number, control: number, notePara: number, props: string, path?: string) { return formatPara(core, noteList(core, sec, para, control, path), notePara, props); }
export function getCharPropertiesInFootnote(core: HmCore, sec: number, para: number, control: number, notePara: number, offset: number, path?: string) { return charProps(core, noteList(core, sec, para, control, path), notePara, offset); }
export function applyCharFormatInFootnote(core: HmCore, sec: number, para: number, control: number, notePara: number, start: number, end: number, props: string, path?: string) { return formatChars(core, noteList(core, sec, para, control, path), notePara, start, notePara, end, props); }

/** 주석 안 범위를 글로 바꾼다. 지우기와 넣기가 한 엔진 트랜잭션이라 IME 조합 한 번, 선택 위 입력 한 번이 각각 한 편집이다. */
export function replaceRangeInFootnote(core: HmCore, sec: number, para: number, control: number, startPara: number, startOffset: number, endPara: number, endOffset: number, replacement: string, path?: string) {
  const list = noteList(core, sec, para, control, path), from = at(core, list, startPara, startOffset);
  const ops: EditOp[] = [];
  if (startPara !== endPara || startOffset !== endOffset) {
    const [a, b] = startPara === endPara ? logicalRangeToWire(mapIn(core, list, startPara), startOffset, endOffset) : [from.offset, at(core, list, endPara, endOffset).offset];
    ops.push({ op: 'delete', from: toAddress(list, startPara, a), to: toAddress(list, endPara, b) });
    if (replacement) ops.push({ op: 'insertText', at: toAddress(list, startPara, a), text: lineBreakText(replacement) });
  } else if (replacement) {
    ops.push({ op: 'insertText', at: from, text: lineBreakText(replacement) });
  }
  const caret = caretIn(core, list, core.transact(ops)?.caret, { fnParaIndex: startPara, charOffset: startOffset });
  return { ok: true, ...caret };
}

/** 범위가 비면 캐럿에, 아니면 범위 위에 붙여 넣는다(한 번의 엔진 붙여넣기). text 가 null 이면 엔진이 복사해 둔 조각이다. 주석 안에 들어온 주석 표시는 버린다. */
export function pasteInFootnote(core: HmCore, sec: number, para: number, control: number, startPara: number, startOffset: number, endPara: number, endOffset: number, text: string | null, path?: string) {
  const list = noteList(core, sec, para, control, path);
  const from = at(core, list, startPara, startOffset), to = at(core, list, endPara, endOffset);
  const request: Record<string, unknown> = startPara === endPara && startOffset === endOffset ? { at: from } : { replace: { from, to } };
  if (text !== null) request.text = text.replace(/\r\n?/g, '\n');
  const receipt = core.mutate(doc => doc.paste(JSON.stringify(request)));
  let caret = caretIn(core, list, receipt?.caret, { fnParaIndex: startPara, charOffset: startOffset });
  const marks: { para: number; control: number; logical: number }[] = [];
  for (let p = 0; p < core.paragraphCount(list); p++) {
    const map = mapIn(core, list, p);
    for (const item of map.info.controls) if (isNoteKind(item.kind)) marks.push({ para: p, control: item.index, logical: wireToLogical(map, item.offset) });
  }
  if (marks.length) {
    core.transact(marks.reverse().map(mark => ({ op: 'deleteControl', target: { section: list.section, steps: list.steps, para: mark.para, control: mark.control } }) as EditOp));
    const before = marks.filter(mark => mark.para === caret.fnParaIndex && mark.logical < caret.charOffset).length;
    caret = { ...caret, charOffset: caret.charOffset - before };
  }
  return { ok: true, ...caret };
}

/** 주석 안 선택을 엔진 클립보드에 담는다. 번호 칸을 고르면 번호도 함께 담긴다. */
export function copySelectionInFootnote(core: HmCore, sec: number, para: number, control: number, startPara: number, startOffset: number, endPara: number, endOffset: number, path?: string) {
  const list = noteList(core, sec, para, control, path);
  let from = at(core, list, startPara, startOffset), to = at(core, list, endPara, endOffset);
  if (startPara === endPara) {
    const [a, b] = logicalRangeToWire(mapIn(core, list, startPara), startOffset, endOffset);
    from = toAddress(list, startPara, a);
    to = toAddress(list, endPara, b);
  }
  const copied = copyRange(core, from, to);
  return { ok: true, text: copied.text, html: copied.html };
}

/** 위치 바로 뒤(forward)나 앞(backward)의 주석 표시. 본문·표 셀·글상자 모두 본다. */
export function getNoteAtPosition(core: HmCore, pos: DocumentPosition, direction: 'backward' | 'forward') {
  const { list, para } = positionTarget(pos);
  const map = paraMap(core.paragraph(list, para));
  const logical = pos.charOffset - (direction === 'backward' ? 1 : 0);
  const control = map.info.controls.find(item => isNoteKind(item.kind) && wireToLogical(map, item.offset) === logical);
  if (!control) return { hit: false as const };
  return { hit: true as const, kind: control.kind as NoteKind, number: control.number ?? 0, charOffset: logical, ...refOf({ section: list.section, steps: list.steps, para, control: control.index }) };
}

export function getFootnoteAtCursor(core: HmCore, sec: number, para: number, offset: number, direction: 'backward' | 'forward') {
  const hit = getNoteAtPosition(core, { sectionIndex: sec, paragraphIndex: para, charOffset: offset }, direction);
  return hit.hit ? { hit: true, sectionIndex: sec, paragraphIndex: para, controlIndex: hit.controlIdx, charOffset: hit.charOffset, footnoteNumber: hit.number } : { hit: false };
}

/** 주석 표시 바로 앞의 본문(셀) 위치. */
export function getNoteAnchor(core: HmCore, sec: number, para: number, control: number, path?: string): DocumentPosition {
  const target = noteTarget(core, sec, para, control, path);
  return addressToPosition(core, toAddress(target.owner.list, target.owner.para, target.info.offset));
}

export function deleteFootnote(core: HmCore, sec: number, para: number, control: number, path?: string) {
  const target = noteTarget(core, sec, para, control, path);
  const position = addressToPosition(core, toAddress(target.owner.list, target.owner.para, target.info.offset));
  edit(core, { op: 'deleteControl', target: { section: sec, steps: target.owner.list.steps, para: target.owner.para, control } });
  return { ok: true, sectionIndex: sec, paragraphIndex: para, controlIndex: control, charOffset: position.charOffset, deletedNumber: target.info.number ?? 0, position };
}

/** 문서 순서의 모든 주석과 그 글. */
export function listNotes(core: HmCore): NoteListEntry[] {
  return noteDirectory(core).notes.map(note => {
    const content = noteContent(core, noteTarget(core, note.sectionIdx, note.paraIdx, note.controlIdx, notePath(note)));
    const { key: _key, list: _list, owner: _owner, ownerPara: _ownerPara, ...ref } = note;
    return { ...ref, sourceType: sourceTypeOf(core, note), paraCount: content.paraCount, noteText: content.noteText };
  });
}

export function getPageFootnoteInfo(core: HmCore, page: number, index: number) {
  const note = notesOnPage(core, page)[index];
  return note ? { ok: true, sectionIdx: note.sectionIdx, paraIdx: note.paraIdx, controlIdx: note.controlIdx, sourceType: sourceTypeOf(core, note), kind: note.kind, cellPath: note.cellPath } : null;
}
export function pageHasFootnoteFootholds(core: HmCore, page: number): boolean { return notesOnPage(core, page).length > 0; }
export function getCursorRectInNote(core: HmCore, sec: number, para: number, control: number, notePara: number, offset: number, path?: string): CursorRect | null {
  const caret = core.caret(at(core, noteList(core, sec, para, control, path), notePara, offset));
  return caret ? cursor(caret) : null;
}
export function getCursorRectInFootnote(core: HmCore, page: number, index: number, para: number, offset: number): CursorRect | null {
  const note = notesOnPage(core, page)[index];
  if (!note) return null;
  const caret = core.caret(at(core, note.list, para, offset), 'downstream', page);
  return caret ? cursor(caret) : null;
}
export function getNoteEditInfo(core: HmCore, sec: number, para: number, control: number, path?: string) {
  const target = noteTarget(core, sec, para, control, path), caret = core.caret(at(core, target.list, 0, 0));
  if (!caret) return null;
  const key = refKey(refOf({ section: sec, steps: target.owner.list.steps, para: target.owner.para, control }));
  return { ok: true, kind: target.info.kind, pageNum: caret.page, footnoteIndex: notesOnPage(core, caret.page).findIndex(item => item.key === key), fnParaIndex: 0, charOffset: 0 };
}
export function getSelectionRectsInFootnote(core: HmCore, page: number, index: number, startPara: number, start: number, endPara: number, end: number): SelectionRect[] {
  const note = notesOnPage(core, page)[index];
  return note ? selection(core, note.list, page, startPara, start, endPara, end) : [];
}
/** 주석 선택의 모든 쪽 사각형. 쪽을 넘는 주석도 이어서 칠한다. */
export function getSelectionRectsInNote(core: HmCore, sec: number, para: number, control: number, startPara: number, start: number, endPara: number, end: number, path?: string): SelectionRect[] {
  const list = noteList(core, sec, para, control, path);
  const rects = JSON.parse(core.call(doc => doc.select(JSON.stringify({ from: at(core, list, startPara, start), to: at(core, list, endPara, end) })))) as Rect[];
  return rects.map(rect => ({ ...cursor(rect), width: px(rect.width) }));
}

/** 주석 안에서 엔진 캐럿 이동(줄 처음·끝, 위·아래 줄). 이 주석을 벗어나면 null. */
export function navigateInNote(core: HmCore, sec: number, para: number, control: number, notePara: number, offset: number, motion: 'lineStart' | 'lineEnd' | 'up' | 'down', preferredX?: number, path?: string) {
  const list = noteList(core, sec, para, control, path);
  const request = { position: at(core, list, notePara, offset), motion, ...(preferredX === undefined ? {} : { preferredX: hu(preferredX) }) };
  const located = JSON.parse(core.call(doc => doc.navigate(JSON.stringify(request)))) as Located | null;
  if (!located || !sameSteps(located.position.steps, list.steps)) return null;
  return { fnParaIndex: located.position.para, charOffset: wireToLogical(mapIn(core, list, located.position.para), located.position.offset), cursorRect: cursor(located.caret) };
}

/** 주석 첫 줄에서 위로 나갈 본문 자리: 그 쪽 주석 영역 바로 위 본문 줄의 같은 x(한컴 c03c). */
export function getBodyPositionAboveNote(core: HmCore, sec: number, para: number, control: number, x: number, path?: string): DocumentPosition | null {
  const target = noteTarget(core, sec, para, control, path);
  const first = core.caret(at(core, target.list, 0, 0));
  if (!first) return null;
  let top = first.y;
  for (const note of notesOnPage(core, first.page)) {
    if (note.kind !== target.info.kind) continue;
    for (let p = 0; p < core.paragraphCount(note.list); p++) for (const line of core.lines(note.list, p)) if (line.page === first.page) top = Math.min(top, line.y);
  }
  for (const step of [1, 4, 12]) {
    const located = core.locate(first.page, x, px(top) - step, { body: true });
    if (located && !noteAtAddress(core, located.position)) return addressToPosition(core, located.position);
  }
  return null;
}

export function hitTestInFootnote(core: HmCore, page: number, x: number, y: number) {
  const located = core.locate(page, x, y);
  const note = located ? noteAtAddress(core, located.position) : null;
  if (!located || !note) return { hit: false as const };
  const key = refKey(note.ref);
  return {
    hit: true as const, footnoteIndex: notesOnPage(core, page).findIndex(item => item.key === key), fnParaIndex: located.position.para,
    charOffset: wireToLogical(mapIn(core, note.list, located.position.para), located.position.offset), cursorRect: cursor(located.caret),
    ...note.ref, kind: note.kind, number: note.number,
  };
}
export function hitTestFootnote(core: HmCore, page: number, x: number, y: number) {
  const hit = hitTestInFootnote(core, page, x, y);
  return hit.hit ? { hit: true, footnoteIndex: hit.footnoteIndex, sectionIdx: hit.sectionIdx, paraIdx: hit.paraIdx, controlIdx: hit.controlIdx, cellPath: hit.cellPath, kind: hit.kind } : { hit: false };
}
/** 본문·표 셀·글상자의 주석 표시 위를 눌렀는지. */
export function hitTestBodyFootnoteMarker(core: HmCore, page: number, x: number, y: number) {
  const located = core.locate(page, x, y, { body: true });
  if (!located) return { hit: false };
  const list: ListAddress = { section: located.position.section, steps: located.position.steps ?? [] };
  const info = core.paragraph(list, located.position.para), map = paraMap(info);
  for (const control of info.controls.filter(item => isNoteKind(item.kind))) {
    const caret = core.caret(toAddress(list, located.position.para, control.offset), 'downstream', page);
    const after = core.caret(toAddress(list, located.position.para, control.offset + 8), 'upstream', page);
    if (!caret || !after || caret.page !== page) continue;
    const left = Math.min(px(caret.x), px(after.x)), right = Math.max(px(caret.x), px(after.x));
    if (x < left || x > right || y < px(caret.y) || y > px(caret.y + caret.height)) continue;
    const ref = refOf({ section: list.section, steps: list.steps, para: located.position.para, control: control.index });
    const notePage = core.caret(toAddress({ section: list.section, steps: [...list.steps, { para: located.position.para, control: control.index, index: 0 }] }, 0, 0))?.page ?? page;
    const key = refKey(ref);
    return {
      hit: true, sectionIndex: ref.sectionIdx, paragraphIndex: ref.paraIdx, controlIndex: control.index, cellPath: ref.cellPath, kind: control.kind,
      footnoteNumber: control.number, footnoteIndex: notesOnPage(core, notePage).findIndex(item => item.key === key), pageNum: notePage,
      bbox: { x: left, y: px(caret.y), w: right - left, h: px(caret.height) }, cursorRect: cursor(caret), charOffset: wireToLogical(map, control.offset),
    };
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
  const list = hfList(core, sec, isHeader, applyTo), position = at(core, list, para, offset);
  let caret = core.caret(position, 'downstream', page);
  if (!caret) {
    const target = hfTarget(core, sec, isHeader, applyTo)!;
    caret = core.adapter.withFurniturePreview({ section: sec, para: target.para, control: target.control }, (doc, list) => JSON.parse(doc.locate(JSON.stringify({ kind: 'caret', position: { ...position, ...list }, page }))) as Caret | null);
  }
  if (!caret) throw new Error('머리말·꼬리말의 캐럿을 찾을 수 없습니다');
  return cursor(caret);
}
export function getSelectionRectsInHeaderFooter(core: HmCore, sec: number, isHeader: boolean, applyTo: number, page: number, startPara: number, start: number, endPara: number, end: number) {
  const list = hfList(core, sec, isHeader, applyTo), rects = selection(core, list, page, startPara, start, endPara, end);
  if (rects.length || (startPara === endPara && start === end)) return rects;
  const target = hfTarget(core, sec, isHeader, applyTo)!;
  return core.adapter.withFurniturePreview({ section: sec, para: target.para, control: target.control }, (doc, previewList) => {
    const from = { ...at(core, list, startPara, start), ...previewList }, to = { ...at(core, list, endPara, end), ...previewList };
    return (JSON.parse(doc.select(JSON.stringify({ from, to, page }))) as Rect[]).map(rect => ({ ...cursor(rect), width: px(rect.width) }));
  });
}
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
  const list = hfList(core, sec, isHeader, applyTo);
  let located = core.locate(page, x, y, { within: list });
  if (!located) {
    const target = hfTarget(core, sec, isHeader, applyTo)!;
    located = core.adapter.withFurniturePreview({ section: sec, para: target.para, control: target.control }, (doc, within) => JSON.parse(doc.locate(JSON.stringify({ kind: 'point', page, x: hu(x), y: hu(y), within }))) as Located | null);
  }
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
  if (target.sectionIndex !== sec || target.applyTo !== applyTo) {
    const selected = hfTarget(core, sec, isHeader, applyTo);
    if (!selected) throw new RangeError('머리말·꼬리말이 없습니다');
    core.adapter.renderFurniturePreviewToCanvas(page, { section: sec, para: selected.para, control: selected.control }, canvas, scale);
    return;
  }
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
 * 4·5·9·10 은 오른쪽 정렬 탭으로 파일 이름과 쪽 번호를 양끝에 놓는다.
 */
export function applyHfTemplate(core: HmCore, sec: number, isHeader: boolean, applyTo: number, templateId: number): { ok: boolean } {
  if (!Number.isInteger(templateId) || templateId < 0 || templateId > 10) throw new RangeError('알 수 없는 머리말·꼬리말 마당');
  if (!SIDES[applyTo]) throw new RangeError('잘못된 머리말·꼬리말 적용 범위');
  const layout = templateId <= 5 ? templateId : templateId - 5;
  const previous = hfTarget(core, sec, isHeader, applyTo);
  const head = core.paragraph(bodyList(sec), 0);
  const control = head.controls.filter(c => c.offset < head.caret[0]).length;
  const list: ListAddress = { section: sec, steps: [{ para: 0, control, index: 0 }] };
  const ops: EditOp[] = [];
  if (previous) ops.push({ op: 'deleteControl', target: { section: sec, para: previous.para, control: previous.control } });
  ops.push({ op: 'createHeaderFooter', section: sec, kind: isHeader ? 'header' : 'footer', side: SIDES[applyTo] });
  let offset = 0;
  const field = (kind: 'pageNumber' | 'fileName') => {
    const text = core.adapter.fileName || '문서';
    ops.push({ op: 'insertField', at: toAddress(list, 0, offset), kind, ...(kind === 'fileName' ? { command: '$F', text } : {}) });
    offset += kind === 'pageNumber' ? 8 : 16 + text.length;
  };
  if (layout) {
    field(layout === 5 ? 'fileName' : 'pageNumber');
    if (layout >= 4) {
      ops.push({ op: 'insertText', at: toAddress(list, 0, offset), text: '\t' }); offset += 8;
      field(layout === 4 ? 'fileName' : 'pageNumber');
    }
    const from = toAddress(list, 0, 0), to = toAddress(list, 0, offset);
    const page = core.query<{ page: { width: number; marginLeft: number; marginRight: number } }>({ kind: 'sectionSettings', section: sec }).page;
    const width = page.width - page.marginLeft - page.marginRight;
    ops.push({ op: 'formatParas', from, to, patch: { align: layout === 2 ? 'center' : layout === 3 ? 'right' : 'left', ...(layout >= 4 ? { tabStops: [{ position: width, type: 1, fill: 0 }] } : {}) } } as EditOp);
    if (templateId > 5) ops.push({ op: 'formatChars', from, to, patch: { bold: true, underline: true } });
  }
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
export function setCharShapeIdInFootnote(core: HmCore, sec: number, para: number, control: number, fnPara: number, start: number, end: number, id: number, path?: string): string {
  return shapeId(core, noteList(core, sec, para, control, path), fnPara, id, start, end);
}
export function setParaShapeIdInFootnote(core: HmCore, sec: number, para: number, control: number, fnPara: number, id: number, path?: string): string {
  return shapeId(core, noteList(core, sec, para, control, path), fnPara, id);
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
  insertNoteAt, replaceRangeInFootnote, pasteInFootnote, copySelectionInFootnote, getNoteAtPosition, getNoteAnchor,
  listNotes, getSelectionRectsInNote, navigateInNote, getBodyPositionAboveNote,
  getHeaderFooterEditTarget, getHeaderFooterPreviewPage, getCursorRectInHeaderFooter, getSelectionRectsInHeaderFooter,
  hitTestHeaderFooter, hitTestInHeaderFooterTarget, hitTestInHeaderFooter, renderHeaderFooterEditPreviewToCanvas,
  getHeaderFooterList, navigateHeaderFooterByPage, toggleHideHeaderFooter, getEndnoteShape, applyEndnoteShape,
});
