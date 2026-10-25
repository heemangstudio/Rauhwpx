/** 도구 모음·서식 대화상자·스타일·문단 번호의 HeemangEngine 연결. */
import type { CharPatch, ParaPatch, EditOp, FormatContext, ParagraphFormat, StyleInfo, ListInfo } from '../../../vendor/hm-wasm/hm_wasm';
import type { CharProperties, ParaProperties, CharShapeRun } from '../types';
import type { HmCore, ListAddress } from './core';
import { hu, unsupported } from './core';
import { bodyList, cellList, paraMap, pathTarget, textAddress, textRangeToWire, toAddress, wireToText } from './address';
import { charProperties, hexToColorRef, paraProperties } from '../heemang-format';
import { charPatch as basicCharPatch, paraPatch as basicParaPatch } from './format';
import { extendBridge } from './api';

const ok = (): string => JSON.stringify({ ok: true });
type Font = { id: number; name: string };
const fontIds = new WeakMap<HmCore, { instance: number; names: string[] }>();
const VIRTUAL_FONT = 0x100000;

function names(core: HmCore): string[] {
  let state = fontIds.get(core);
  if (state?.instance !== core.adapter.documentInstance) {
    state = { instance: core.adapter.documentInstance, names: [] };
    fontIds.set(core, state);
  }
  return state.names;
}

export function getFontList(core: HmCore): Array<Font & { lang: number }> {
  return core.query<Font[][]>({ kind: 'fonts' }).flatMap((fonts, lang) => fonts.map(font => ({ ...font, lang })));
}

export function findOrCreateFontId(core: HmCore, name: string): number {
  if (!name.trim()) return -1;
  const fonts = names(core);
  let id = fonts.indexOf(name.trim());
  if (id < 0) id = fonts.push(name.trim()) - 1;
  return VIRTUAL_FONT + id;
}

export function findOrCreateFontIdForLang(core: HmCore, lang: number, name: string): number {
  if (!Number.isInteger(lang) || lang < 0 || lang > 6) throw new RangeError('잘못된 글꼴 언어');
  return findOrCreateFontId(core, name);
}

function fontName(core: HmCore, lang: number, id: number): string | null {
  if (id < 0) return null;
  const name = id >= VIRTUAL_FONT ? names(core)[id - VIRTUAL_FONT] : getFontList(core).find(font => font.lang === lang && font.id === id)?.name;
  if (!name) throw new RangeError(`글꼴 ${id} 이 없습니다`);
  return name;
}

/** 색 없음(형광펜 해제)은 흰색으로 들어오고, 엔진은 0xFFFFFFFF 로 적는다. */
const NO_SHADE = 0xFFFFFFFF;
const UNDERLINE_KINDS: Record<string, CharPatch['underlineKind']> = { None: 'none', Bottom: 'below', Top: 'above' };
const BORDER_KEYS = ['borderFillId', 'borderLeft', 'borderRight', 'borderTop', 'borderBottom', 'fillType', 'fillColor', 'patternColor', 'patternType'];

function colorRef(value: unknown): number {
  const color = hexToColorRef(String(value));
  if (color === null) throw new RangeError(`잘못된 색: ${String(value)}`);
  return color;
}

/**
 * Studio 글자 서식 변경을 엔진 patch 로. current 는 그림자 위치처럼 두 값이 한 필드인 속성의 나머지 값을 준다.
 * 엔진이 아직 못 바꾸는 속성(글자 테두리·배경)이 있으면 문서를 바꾸기 전에 거절한다.
 */
export function widgetCharPatch(core: HmCore, props: Record<string, unknown>, current?: () => CharPatch): CharPatch {
  const rest = { ...props };
  const patch: CharPatch = {};
  const take = (key: string): unknown => { const value = rest[key]; delete rest[key]; return value; };
  const has = (key: string): boolean => rest[key] !== undefined;
  if (has('borderFillId')) Object.assign(patch, { borderFillId: Number(take('borderFillId')) });
  if (BORDER_KEYS.slice(1).some(has)) {
    const borderFill: Record<string, unknown> = {};
    for (const side of ['Left', 'Right', 'Top', 'Bottom']) {
      const line = take(`border${side}`) as { type: number; width: number; color: string } | undefined;
      if (line) borderFill[side.toLowerCase()] = { style: line.type, width: line.width, color: colorRef(line.color) };
    }
    const fill = take('fillType'), color = take('fillColor'), patternColor = take('patternColor'), pattern = take('patternType');
    if (fill === 'none') borderFill.fill = { kind: 'none' };
    else if (fill === 'solid' || color !== undefined || patternColor !== undefined || pattern !== undefined) {
      borderFill.fill = { kind: 'solid', background: colorRef(color ?? '#ffffff'), patternColor: colorRef(patternColor ?? '#000000'), pattern: Number(pattern ?? 0) };
    } else if (fill !== undefined) throw new RangeError(`잘못된 글자 배경: ${String(fill)}`);
    Object.assign(patch, { borderFill });
  }
  if (has('fontId')) patch.fontFace = fontName(core, 0, Number(take('fontId'))) ?? undefined;
  if (Array.isArray(rest.fontIds)) patch.fontFaces = (take('fontIds') as unknown[]).map((id, lang) => fontName(core, lang, Number(id)));
  for (const key of ['fontFamilies', 'fontNames']) {
    if (Array.isArray(rest[key])) patch.fontFaces = (take(key) as unknown[]).map(name => name ? String(name) : null);
  }
  for (const key of ['spacings', 'ratios'] as const) if (has(key)) patch[key] = take(key) as number[];
  if (has('relativeSizes')) patch.relSizes = take('relativeSizes') as number[];
  if (has('charOffsets')) patch.offsets = take('charOffsets') as number[];
  if (has('underlineType')) {
    const kind = UNDERLINE_KINDS[String(rest.underlineType)];
    if (!kind) throw unsupported(`밑줄 위치: ${String(rest.underlineType)}`);
    patch.underlineKind = kind;
    take('underlineType');
  }
  for (const [from, to] of [['underlineShape', 'underlineShape'], ['strikeShape', 'strikeShape'], ['outlineType', 'outline'], ['shadowType', 'shadow'], ['emphasisDot', 'emphasis']] as const) {
    if (has(from)) patch[to] = Number(take(from));
  }
  for (const [from, to] of [['underlineColor', 'underlineColor'], ['strikeColor', 'strikeColor'], ['shadowColor', 'shadowColor']] as const) {
    if (has(from)) patch[to] = colorRef(take(from));
  }
  if (has('shadeColor')) {
    const value = String(take('shadeColor'));
    patch.shadeColor = /^#ffffff$/i.test(value) || value === 'none' ? NO_SHADE : colorRef(value);
  }
  for (const key of ['superscript', 'subscript', 'emboss', 'engrave', 'kerning'] as const) {
    if (has(key)) patch[key] = Boolean(take(key));
  }
  if (has('shadowOffsetX') || has('shadowOffsetY')) {
    const [x, y] = current?.().shadowOffset ?? [0, 0];
    patch.shadowOffset = [Number(take('shadowOffsetX') ?? x), Number(take('shadowOffsetY') ?? y)];
  }
  delete rest.charShapeId;
  return { ...basicCharPatch(rest), ...patch };
}

/**
 * 문단 서식 변경의 여백·들여쓰기·문단 간격과 비율이 아닌 줄 간격은 구 엔진처럼 HWP 저장값(HWPUNIT 의 2배,
 * pt×200)으로 들어온다(문단 모양 대화상자·에이전트 도구). 조회는 px 로 돌려준다. 엔진 patch 의 여백은 HWPUNIT,
 * 줄 간격은 저장값 그대로다. currentKind 는 종류 없이 값만 바뀔 때 그 문단의 줄 간격 종류다.
 */
const RAW_DISTANCES = { marginLeft: 'left', marginRight: 'right', indent: 'indent', spacingBefore: 'spaceBefore', spacingAfter: 'spaceAfter' } as const;

function widgetParaPatch(props: Record<string, unknown>, currentKind?: ParaPatch['lineSpacingKind']): ParaPatch {
  const rest = { ...props };
  const patch: ParaPatch = {};
  for (const [key, field] of Object.entries(RAW_DISTANCES)) {
    if (rest[key] === undefined) continue;
    const raw = Number(rest[key]);
    if (!Number.isFinite(raw)) throw new RangeError(`잘못된 문단 값: ${key}`);
    patch[field] = Math.round(raw / 2);
    delete rest[key];
  }
  if (rest.lineSpacingType !== undefined) {
    const kind = { Percent: 'percent', Fixed: 'fixed', SpaceOnly: 'added', Minimum: 'atLeast' }[String(rest.lineSpacingType)];
    if (!kind) throw unsupported(`줄 간격 종류: ${String(rest.lineSpacingType)}`);
    patch.lineSpacingKind = kind as ParaPatch['lineSpacingKind'];
    delete rest.lineSpacingType;
  }
  // 엔진도 비율이 아닌 줄 간격을 HWP 저장값(2배)으로 둔다. 종류 없는 값은 비율로 읽으므로 지금 종류를 함께 보낸다.
  if (rest.lineSpacing !== undefined && rest.lineSpacingType === undefined && currentKind && currentKind !== 'percent') {
    patch.lineSpacingKind = currentKind;
  }
  delete rest.paraShapeId;
  for (const key of ['headType', 'numberingId', 'paraLevel', 'pageBreakBefore']) delete rest[key];
  return { ...basicParaPatch(rest), ...patch };
}

function format(core: HmCore, list: ListAddress, para: number): ParagraphFormat {
  const value = core.query<ParagraphFormat[]>({ kind: 'formatRuns', list, from: para, count: 1 })[0];
  if (!value) throw new RangeError(`문단 ${para} 이 없습니다`);
  return value;
}

function context(core: HmCore, list: ListAddress, para: number, offset: number): FormatContext {
  return core.query<FormatContext>({ kind: 'formatContext', at: textAddress(core, list, para, offset) });
}

/**
 * 글자 속성 API 의 오프셋은 그 자리의 글자를 가리킨다(구 엔진과 같다). 엔진의 캐럿 문맥은 앞 글자 모양이므로
 * 그 글자 하나를 범위로 묻는다. 문단 끝(빈 문단)은 캐럿 문맥을 쓴다.
 */
function charAt(core: HmCore, list: ListAddress, para: number, offset: number): FormatContext {
  const map = paraMap(core.paragraph(list, para));
  const length = map.textLength;
  if (offset >= length) return context(core, list, para, length);
  // 글자 자신의 wire 위치다. 텍스트 오프셋의 캐럿 주소는 앞에 놓인 개체 앞일 수 있다.
  const wire = map.textStops[offset];
  const width = map.textWidths[offset];
  return core.query<FormatContext>({ kind: 'formatContext', at: toAddress(list, para, wire), to: toAddress(list, para, wire + width) });
}

function chars(core: HmCore, list: ListAddress, para: number, offset: number): CharProperties {
  const value = charAt(core, list, para, offset).characters;
  const props = charProperties(value);
  props.underlineType ??= value.underline ? 'Bottom' : 'None';
  props.spacings = 'spacings' in value ? value.spacings as number[] : Array(7).fill(value.charSpacing ?? 0);
  if ('ratios' in value) props.ratios = value.ratios as number[];
  props.fontIds = props.fontFamilies?.map(name => findOrCreateFontId(core, name));
  const map = paraMap(core.paragraph(list, para));
  const wire = offset < map.textLength ? map.textStops[offset] : map.end;
  const runs = format(core, list, para).runs;
  props.charShapeId = runs.slice().reverse().find(run => run.offset <= wire)?.charShapeId ?? runs[0]?.charShapeId;
  return props;
}

function paras(core: HmCore, list: ListAddress, para: number): ParaProperties {
  const value = format(core, list, para);
  return { ...paraProperties(value.paragraphs), paraShapeId: value.paraShapeId,
    headType: value.list ? { bullet: 'Bullet', numbering: 'Number', outline: 'Outline' }[value.list.kind] : 'None',
    numberingId: value.list?.id ?? 0, paraLevel: value.list?.level ?? 0, pageBreakBefore: value.pageBreak,
    numberingRestartMode: value.listRestart?.mode === 'restart' ? 2 : value.listRestart ? 1 : 0,
    numberingStartNum: value.listRestart?.mode === 'restart' ? value.listRestart.start : 1 };
}

export function getCharPropertiesAt(core: HmCore, sec: number, para: number, offset: number): CharProperties { return chars(core, bodyList(sec), para, offset); }
export function getCellCharPropertiesAt(core: HmCore, sec: number, parent: number, control: number, cell: number, para: number, offset: number): CharProperties { return chars(core, cellList(sec, parent, control, cell), para, offset); }
export function getCellCharPropertiesAtByPath(core: HmCore, sec: number, parent: number, path: string, offset: number): CharProperties { const target = pathTarget(sec, parent, path); return chars(core, target.list, target.para, offset); }
export function getParaPropertiesAt(core: HmCore, sec: number, para: number): ParaProperties { return paras(core, bodyList(sec), para); }
export function getCellParaPropertiesAt(core: HmCore, sec: number, parent: number, control: number, cell: number, para: number): ParaProperties { return paras(core, cellList(sec, parent, control, cell), para); }
export function getCellParaPropertiesAtByPath(core: HmCore, sec: number, parent: number, path: string): ParaProperties { const target = pathTarget(sec, parent, path); return paras(core, target.list, target.para); }

function charOp(core: HmCore, list: ListAddress, para: number, start: number, end: number, patch: CharPatch): EditOp[] {
  const [a, b] = textRangeToWire(paraMap(core.paragraph(list, para)), start, end);
  return b > a && Object.keys(patch).length ? [{ op: 'formatChars', from: toAddress(list, para, a), to: toAddress(list, para, b), patch }] : [];
}
function applyChars(core: HmCore, list: ListAddress, para: number, start: number, end: number, json: string): string {
  const patch = widgetCharPatch(core, JSON.parse(json), () => charAt(core, list, para, start).characters);
  core.transact(charOp(core, list, para, start, end, patch));
  return ok();
}
export function applyCharFormat(core: HmCore, sec: number, para: number, start: number, end: number, json: string): string { return applyChars(core, bodyList(sec), para, start, end, json); }
export function applyCharFormatInCell(core: HmCore, sec: number, parent: number, control: number, cell: number, para: number, start: number, end: number, json: string): string { return applyChars(core, cellList(sec, parent, control, cell), para, start, end, json); }
export function applyCharFormatInCellByPath(core: HmCore, sec: number, parent: number, path: string, start: number, end: number, json: string): string { const target = pathTarget(sec, parent, path); return applyChars(core, target.list, target.para, start, end, json); }

export function applyCharFormatAcrossSections(core: HmCore, startSec: number, startPara: number, startOffset: number, endSec: number, endPara: number, endOffset: number, json: string): string {
  const patch = widgetCharPatch(core, JSON.parse(json), () => charAt(core, bodyList(startSec), startPara, startOffset).characters);
  const ops: EditOp[] = [];
  for (let sec = startSec; sec <= endSec; sec++) {
    const list = bodyList(sec);
    for (let para = sec === startSec ? startPara : 0; para <= (sec === endSec ? endPara : core.paragraphCount(list) - 1); para++) {
      const length = paraMap(core.paragraph(list, para)).textLength;
      ops.push(...charOp(core, list, para, sec === startSec && para === startPara ? startOffset : 0, sec === endSec && para === endPara ? endOffset : length, patch));
    }
  }
  core.transact(ops);
  return ok();
}

/** 문단 서식 변경을 엔진 편집으로. 본문·셀·머리말·주석 목록이 같은 변환을 쓴다. */
export function paraOps(core: HmCore, list: ListAddress, first: number, last: number, props: Record<string, unknown>): EditOp[] {
  const from = toAddress(list, first, paraMap(core.paragraph(list, first)).lead);
  const to = toAddress(list, last, paraMap(core.paragraph(list, last)).end);
  const kind = props.lineSpacing !== undefined && props.lineSpacingType === undefined ? format(core, list, first).paragraphs.lineSpacingKind : undefined;
  const patch = widgetParaPatch(props, kind);
  const ops: EditOp[] = Object.keys(patch).length ? [{ op: 'formatParas', from, to, patch }] : [];
  // 쪽 나눔은 문단 모양이 아니라 문단마다의 나눔 표시다. 바뀌는 문단에만 엔진 pageBreak 를 둔다.
  if (props.pageBreakBefore !== undefined) {
    const on = props.pageBreakBefore === true;
    const marks = core.query<ParagraphFormat[]>({ kind: 'formatRuns', list, from: first, count: last - first + 1 });
    for (const mark of marks) if (mark.pageBreak !== on) {
      ops.push({ op: 'pageBreak', at: toAddress(list, mark.index, paraMap(core.paragraph(list, mark.index)).lead), on });
    }
  }
  if (props.headType !== undefined || props.numberingId !== undefined || props.paraLevel !== undefined) {
    const current = context(core, list, first, 0).list;
    const kind = props.headType ?? (current?.kind === 'bullet' ? 'Bullet' : current?.kind === 'outline' ? 'Outline' : current ? 'Number' : 'None');
    let id = Number(props.numberingId ?? current?.id ?? 0);
    if (kind === 'Outline') {
      const section = core.query<{ settings: { outlineNumbering?: number } | null }>({ kind: 'sectionSettings', section: list.section });
      id = id || section.settings?.outlineNumbering || getNumberingList(core)[0]?.id || 0;
      if (!id) {
        const definition = { kind: 'numbering', start: 1, levels: DEFAULT_NUMBERING.levelFormats.map((format, i) => ({ format, numberKind: DEFAULT_NUMBERING.numberFormats[i] })) };
        ops.push({ op: 'ensureList', definition } as EditOp);
        id = getNumberingList(core).length + 1;
      }
      if (id !== section.settings?.outlineNumbering) ops.push({ op: 'setSectionSettings', section: list.section, patch: { outlineNumbering: id } });
    }
    ops.push({ op: 'setList', from, to, list: kind === 'None' ? null : {
      kind: kind === 'Outline' ? 'outline' : kind === 'Bullet' ? 'bullet' : 'numbering', id, level: Number(props.paraLevel ?? current?.level ?? 0),
    } } as EditOp);
  }
  return ops;
}
export function applyParaFormat(core: HmCore, sec: number, para: number, json: string): string { core.transact(paraOps(core, bodyList(sec), para, para, JSON.parse(json))); return ok(); }
export function applyParaFormatInCell(core: HmCore, sec: number, parent: number, control: number, cell: number, para: number, json: string): string { core.transact(paraOps(core, cellList(sec, parent, control, cell), para, para, JSON.parse(json))); return ok(); }
export function applyParaFormatInCellByPath(core: HmCore, sec: number, parent: number, path: string, json: string): string { const target = pathTarget(sec, parent, path); core.transact(paraOps(core, target.list, target.para, target.para, JSON.parse(json))); return ok(); }
export function applyParaFormatAcrossSections(core: HmCore, startSec: number, startPara: number, endSec: number, endPara: number, json: string): string {
  const ops: EditOp[] = [];
  for (let sec = startSec; sec <= endSec; sec++) ops.push(...paraOps(core, bodyList(sec), sec === startSec ? startPara : 0, sec === endSec ? endPara : core.paragraphCount(bodyList(sec)) - 1, JSON.parse(json)));
  core.transact(ops);
  return ok();
}

function runs(core: HmCore, list: ListAddress, para: number, start: number, end: number): CharShapeRun[] {
  const map = paraMap(core.paragraph(list, para));
  const values = format(core, list, para).runs;
  return values.flatMap((run, index) => {
    const a = Math.max(start, wireToText(map, run.offset));
    const b = Math.min(end, index + 1 < values.length ? wireToText(map, values[index + 1].offset) : map.textLength);
    return a < b ? [{ startOffset: a, endOffset: b, charShapeId: run.charShapeId }] : [];
  });
}
export function getCharShapeRuns(core: HmCore, sec: number, para: number, start: number, end: number): CharShapeRun[] { return runs(core, bodyList(sec), para, start, end); }
export function getCharShapeRunsInCellByPath(core: HmCore, sec: number, parent: number, path: string, start: number, end: number): CharShapeRun[] { const target = pathTarget(sec, parent, path); return runs(core, target.list, target.para, start, end); }

function setRuns(core: HmCore, list: ListAddress, para: number, start: number, end: number, values: CharShapeRun[]): string {
  const map = paraMap(core.paragraph(list, para));
  const ops: EditOp[] = values.flatMap(run => {
    const a = Math.max(start, run.startOffset), b = Math.min(end, run.endOffset);
    const [from, to] = textRangeToWire(map, a, b);
    return a < b ? [{ op: 'setCharShape' as const, from: toAddress(list, para, from), to: toAddress(list, para, to), charShapeId: run.charShapeId }] : [];
  });
  core.transact(ops);
  return ok();
}
export function setCharShapeRuns(core: HmCore, sec: number, para: number, start: number, end: number, values: CharShapeRun[]): string { return setRuns(core, bodyList(sec), para, start, end, values); }
export function setCharShapeRunsInCellByPath(core: HmCore, sec: number, parent: number, path: string, start: number, end: number, values: CharShapeRun[]): string { const target = pathTarget(sec, parent, path); return setRuns(core, target.list, target.para, start, end, values); }
export function setCharShapeId(core: HmCore, sec: number, para: number, start: number, end: number, id: number): string { return setCharShapeRuns(core, sec, para, start, end, [{ startOffset: start, endOffset: end, charShapeId: id }]); }
export function setCharShapeIdInCell(core: HmCore, sec: number, parent: number, control: number, cell: number, para: number, start: number, end: number, id: number): string { return setRuns(core, cellList(sec, parent, control, cell), para, start, end, [{ startOffset: start, endOffset: end, charShapeId: id }]); }
export function setCharShapeIdInCellByPath(core: HmCore, sec: number, parent: number, path: string, start: number, end: number, id: number): string { return setCharShapeRunsInCellByPath(core, sec, parent, path, start, end, [{ startOffset: start, endOffset: end, charShapeId: id }]); }

function setPara(core: HmCore, list: ListAddress, para: number, id: number): string {
  const map = paraMap(core.paragraph(list, para));
  core.transact([{ op: 'setParaShape', from: toAddress(list, para, map.lead), to: toAddress(list, para, map.end), paraShapeId: id }]);
  return ok();
}
export function setParaShapeId(core: HmCore, sec: number, para: number, id: number): string { return setPara(core, bodyList(sec), para, id); }
export function setCellParaShapeId(core: HmCore, sec: number, parent: number, control: number, cell: number, para: number, id: number): string { return setPara(core, cellList(sec, parent, control, cell), para, id); }
export function setCellParaShapeIdByPath(core: HmCore, sec: number, parent: number, path: string, id: number): string { const target = pathTarget(sec, parent, path); return setPara(core, target.list, target.para, id); }

export function getStyleDetail(core: HmCore, styleId: number): { charProps: CharProperties; paraProps: ParaProperties } {
  const style = core.query<StyleInfo | null>({ kind: 'style', id: styleId });
  if (!style) throw new RangeError(`스타일 ${styleId} 이 없습니다`);
  return { charProps: { ...charProperties(style.characters), charShapeId: style.charShape }, paraProps: { ...paraProperties(style.paragraphs), paraShapeId: style.paraShape } };
}

function styleProps(json: string): Record<string, unknown> {
  const input = JSON.parse(json) as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ['name', 'englishName']) if (input[key] !== undefined) output[key] = input[key];
  if (input.type !== undefined) output.kind = input.type === 1 ? 'character' : 'paragraph';
  if (input.nextStyleId !== undefined) output.next = input.nextStyleId;
  if (input.baseCharShapeId !== undefined) output.charShapeId = input.baseCharShapeId;
  if (input.baseParaShapeId !== undefined) output.paraShapeId = input.baseParaShapeId;
  return output;
}
export function createStyle(core: HmCore, json: string): number {
  const id = core.query<StyleInfo[]>({ kind: 'styles' }).length;
  const base = core.query<StyleInfo | null>({ kind: 'style', id: 0 });
  core.transact([{ op: 'createStyle', style: { charShapeId: base?.charShape ?? 0, paraShapeId: base?.paraShape ?? 0, ...styleProps(json) } } as EditOp]);
  return id;
}
export function updateStyle(core: HmCore, styleId: number, json: string): boolean { core.transact([{ op: 'updateStyle', id: styleId, style: styleProps(json) } as EditOp]); return true; }
export function deleteStyle(core: HmCore, styleId: number): boolean { core.transact([{ op: 'deleteStyle', id: styleId }]); return true; }
export function updateStyleShapes(core: HmCore, styleId: number, charsJson: string, parasJson: string): boolean {
  const current = () => core.query<StyleInfo>({ kind: 'style', id: styleId }).characters;
  core.transact([{ op: 'updateStyle', id: styleId, style: { characters: widgetCharPatch(core, JSON.parse(charsJson), current), paragraphs: widgetParaPatch(JSON.parse(parasJson), core.query<StyleInfo>({ kind: 'style', id: styleId }).paragraphs.lineSpacingKind) } }]);
  return true;
}

export function getNumberingList(core: HmCore): Array<{ id: number; levelFormats: string[]; numberFormats?: number[]; startNumber: number }> {
  return core.query<ListInfo[]>({ kind: 'lists' }).filter(list => list.kind === 'numbering').map(list => ({ id: list.id, levelFormats: list.levels?.map(level => level.format) ?? [], numberFormats: list.levels?.map(level => level.numberKind) ?? [], startNumber: list.start ?? 1 }));
}
export function getBulletList(core: HmCore): Array<{ id: number; char: string; rawCode: number }> {
  return core.query<ListInfo[]>({ kind: 'lists' }).filter(list => list.kind === 'bullet').map(list => ({ id: list.id, char: list.bullet ?? '', rawCode: list.bullet?.codePointAt(0) ?? 0 }));
}
export function createNumbering(core: HmCore, json: string): number {
  const input = JSON.parse(json) as { levelFormats: string[]; numberFormats?: number[]; startNumber?: number };
  const definition = { kind: 'numbering' as const, start: input.startNumber ?? 1, levels: input.levelFormats.map((format, index) => ({ format, numberKind: input.numberFormats?.[index] ?? 0, start: input.startNumber ?? 1 })) };
  core.transact([{ op: 'ensureList', definition }]);
  const list = getNumberingList(core).find(list => list.startNumber === definition.start && definition.levels.every((level, index) => list.levelFormats[index] === level.format && list.numberFormats?.[index] === level.numberKind));
  if (!list) throw new Error('문단 번호를 만들지 못했습니다');
  return list.id;
}
/** 한컴 기본 문단 번호: 1. 가. 1) 가) (1) (가) ①. */
const DEFAULT_NUMBERING = { levelFormats: ['^1.', '^2.', '^3)', '^4)', '(^5)', '(^6)', '^7'], numberFormats: [0, 8, 0, 8, 0, 8, 1] };
/** 문서에 문단 번호 정의가 있으면 첫 정의를, 없으면 한컴 기본 정의를 만들어 쓴다. */
export function ensureDefaultNumbering(core: HmCore): number {
  return getNumberingList(core)[0]?.id ?? createNumbering(core, JSON.stringify(DEFAULT_NUMBERING));
}
export function ensureDefaultBullet(core: HmCore, bulletChar: string): number {
  core.transact([{ op: 'ensureList', definition: { kind: 'bullet', bullet: bulletChar } }]);
  const list = getBulletList(core).find(list => list.char === bulletChar);
  if (!list) throw new Error('글머리표를 만들지 못했습니다');
  return list.id;
}
export function setNumberingRestart(core: HmCore, sec: number, para: number, mode: number, startNum: number): string {
  const list = bodyList(sec), map = paraMap(core.paragraph(list, para));
  core.transact([{ op: 'setListRestart', at: toAddress(list, para, map.lead),
    restart: mode === 2 ? { mode: 'restart', start: startNum } : mode === 1 ? { mode: 'continue' } : null }]);
  return ok();
}

export function getDocumentParaSpacing(core: HmCore): { count: number; lineSpacing: number | null; spacingBefore: number | null; spacingAfter: number | null } {
  const values: ParaProperties[] = [];
  for (let sec = 0; sec < core.adapter.getSectionCount(); sec++) for (let para = 0; para < core.paragraphCount(bodyList(sec)); para++) {
    const value = paras(core, bodyList(sec), para);
    if (value.lineSpacingType === 'Percent') values.push(value);
  }
  const uniform = (key: 'lineSpacing' | 'spacingBefore' | 'spacingAfter'): number | null => {
    if (!values.length || !values.every(value => value[key] === values[0][key])) return null;
    const value = values[0][key];
    return value === undefined ? null : key === 'lineSpacing' ? value : Math.round(hu(value) * 2);
  };
  return { count: values.length, lineSpacing: uniform('lineSpacing'), spacingBefore: uniform('spacingBefore'), spacingAfter: uniform('spacingAfter') };
}
export function applyDocumentParaSpacing(core: HmCore, spacing: { lineSpacing: number; spacingBefore: number; spacingAfter: number }): { ok: boolean; changed: number; pageCount: number } {
  const ops: EditOp[] = [];
  let changed = 0;
  for (let sec = 0; sec < core.adapter.getSectionCount(); sec++) {
    const list = bodyList(sec);
    for (let para = 0; para < core.paragraphCount(list); para++) {
      const current = paras(core, list, para);
      if (current.lineSpacingType !== 'Percent') continue;
      // 조회 값은 px, 보내는 값은 저장값(pt×200 = px×150)이다.
      const shown = { lineSpacing: spacing.lineSpacing, spacingBefore: spacing.spacingBefore / 150, spacingAfter: spacing.spacingAfter / 150 };
      if (Object.entries(shown).every(([key, value]) => current[key as keyof ParaProperties] === value)) continue;
      ops.push(...paraOps(core, list, para, para, spacing));
      changed++;
    }
  }
  for (const style of core.query<StyleInfo[]>({ kind: 'styles' })) {
    if (!['바탕글', '본문'].includes(style.name) || (style.paragraphs.lineSpacingKind ?? 'percent') !== 'percent') continue;
    const paragraphs: ParaPatch = { lineSpacing: spacing.lineSpacing, spaceBefore: Math.round(spacing.spacingBefore / 2), spaceAfter: Math.round(spacing.spacingAfter / 2) };
    if (Object.entries(paragraphs).some(([key, value]) => style.paragraphs[key as keyof ParaPatch] !== value)) ops.push({ op: 'updateStyle', id: style.id, style: { paragraphs } });
  }
  core.transact(ops);
  return { ok: true, changed, pageCount: core.state().pageCount };
}

extendBridge({ getFontList, findOrCreateFontId, findOrCreateFontIdForLang,
  getCharPropertiesAt, getCellCharPropertiesAt, getCellCharPropertiesAtByPath, getParaPropertiesAt, getCellParaPropertiesAt, getCellParaPropertiesAtByPath,
  applyCharFormat, applyCharFormatInCell, applyCharFormatInCellByPath, applyCharFormatAcrossSections,
  applyParaFormat, applyParaFormatInCell, applyParaFormatInCellByPath, applyParaFormatAcrossSections,
  getCharShapeRuns, getCharShapeRunsInCellByPath, setCharShapeRuns, setCharShapeRunsInCellByPath, setCharShapeId, setCharShapeIdInCell, setCharShapeIdInCellByPath,
  setParaShapeId, setCellParaShapeId, setCellParaShapeIdByPath, getStyleDetail, createStyle, updateStyle, deleteStyle, updateStyleShapes,
  getNumberingList, getBulletList, createNumbering, ensureDefaultNumbering, ensureDefaultBullet, setNumberingRestart,
  getDocumentParaSpacing, applyDocumentParaSpacing });
