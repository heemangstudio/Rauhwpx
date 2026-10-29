// 이 파일의 함수는 WasmBridge 의 같은 이름 메서드가 위임한다. 엔진이 아직 못 하는 기능은
// EngineNotSupportedError 를 던지고, 명령 계층이 해당 메뉴·버튼을 비활성으로 보여 준다.
//
// 글자·문단 서식, 스타일, 번호·글머리표. 서식 오프셋은 텍스트 오프셋이다.
import type { CharPatch, EditOp, ParaPatch } from '../../../vendor/hm-wasm/hm_wasm';
import type { HmCore, ListAddress } from './core';
import { hu, px, unsupported } from './core';
import { bodyList, cellList, paraMap, pathTarget, textRangeToWire, textToWire, toAddress } from './address';
import type { CharProperties, ParaProperties, CharShapeRun } from './bridge-types';

interface FormatContext {
  characters: CharPatch;
  paragraphs: ParaPatch;
  styleId: number;
  list: { kind: 'bullet' | 'numbering' | 'outline'; id: number; level: number } | null;
  mixed: string[];
}

interface StyleInfo {
  id: number; name: string; englishName: string; kind: 'paragraph' | 'character'; next: number;
  paraShape: number; charShape: number; characters: CharPatch; paragraphs: ParaPatch;
}

/** COLORREF(0x00BBGGRR) ↔ '#RRGGBB'. */
export function colorToHex(color: number): string {
  const r = color & 0xff, g = (color >> 8) & 0xff, b = (color >> 16) & 0xff;
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

export function hexToColor(hex: string): number {
  const value = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(value)) throw new Error(`잘못된 색: ${hex}`);
  const r = parseInt(value.slice(0, 2), 16), g = parseInt(value.slice(2, 4), 16), b = parseInt(value.slice(4, 6), 16);
  return r | (g << 8) | (b << 16);
}

const ALIGN_TO_STUDIO: Record<string, string> = { justify: 'justify', left: 'left', right: 'right', center: 'center', distribute: 'distribute', divide: 'split' };
const ALIGN_TO_ENGINE: Record<string, ParaPatch['align']> = { justify: 'justify', left: 'left', right: 'right', center: 'center', distribute: 'distribute', split: 'divide' };

function charProps(patch: CharPatch): CharProperties {
  const props: CharProperties = {};
  if (patch.fontFace !== undefined) {
    props.fontFamily = patch.fontFace;
    props.fontFamilies = Array(7).fill(patch.fontFace);
  }
  if (patch.size !== undefined) props.fontSize = patch.size;
  if (patch.bold !== undefined) props.bold = patch.bold;
  if (patch.italic !== undefined) props.italic = patch.italic;
  if (patch.underline !== undefined) {
    props.underline = patch.underline;
    props.underlineType = patch.underline ? 'Bottom' : 'None';
  }
  if (patch.strike !== undefined) props.strikethrough = patch.strike;
  if (patch.color !== undefined) props.textColor = colorToHex(patch.color);
  if (patch.charSpacing !== undefined) props.spacings = Array(7).fill(patch.charSpacing);
  return props;
}

function paraProps(patch: ParaPatch): ParaProperties {
  const props: ParaProperties = {};
  if (patch.align !== undefined) props.alignment = ALIGN_TO_STUDIO[patch.align] ?? 'justify';
  if (patch.lineSpacing !== undefined) {
    props.lineSpacing = patch.lineSpacing;
    props.lineSpacingType = 'Percent';
  }
  if (patch.left !== undefined) props.marginLeft = px(patch.left);
  if (patch.indent !== undefined) props.indent = px(patch.indent);
  if (patch.spaceBefore !== undefined) props.spacingBefore = px(patch.spaceBefore);
  if (patch.spaceAfter !== undefined) props.spacingAfter = px(patch.spaceAfter);
  return props;
}

/** Studio 글자 서식 변경을 엔진 patch 로. 엔진이 아직 못 바꾸는 속성이 있으면 거절한다. */
export function charPatch(props: Record<string, unknown>): CharPatch {
  const patch: CharPatch = {};
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    switch (key) {
      case 'bold': patch.bold = Boolean(value); break;
      case 'italic': patch.italic = Boolean(value); break;
      case 'underline': patch.underline = Boolean(value); break;
      case 'underlineType': patch.underline = value !== 'None'; break;
      case 'strikethrough': patch.strike = Boolean(value); break;
      case 'fontSize': patch.size = Math.round(Number(value)); break;
      case 'textColor': patch.color = hexToColor(String(value)); break;
      case 'fontName': case 'fontFamily': patch.fontFace = String(value); break;
      default: throw unsupported(`글자 서식: ${key}`);
    }
  }
  return patch;
}

export function paraPatch(props: Record<string, unknown>): ParaPatch {
  const patch: ParaPatch = {};
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    switch (key) {
      case 'alignment': {
        const align = ALIGN_TO_ENGINE[String(value)];
        if (!align) throw unsupported(`문단 정렬: ${String(value)}`);
        patch.align = align;
        break;
      }
      case 'lineSpacing': patch.lineSpacing = Math.round(Number(value)); break;
      case 'lineSpacingType': if (value !== 'Percent') throw unsupported(`줄 간격 종류: ${String(value)}`); break;
      case 'marginLeft': patch.left = hu(Number(value)); break;
      case 'indent': patch.indent = hu(Number(value)); break;
      case 'spacingBefore': patch.spaceBefore = hu(Number(value)); break;
      case 'spacingAfter': patch.spaceAfter = hu(Number(value)); break;
      default: throw unsupported(`문단 서식: ${key}`);
    }
  }
  return patch;
}

function context(core: HmCore, list: ListAddress, para: number, textOffset: number, textEnd?: number): FormatContext {
  const map = paraMap(core.paragraph(list, para));
  const at = toAddress(list, para, textToWire(map, textOffset));
  const request: Record<string, unknown> = { kind: 'formatContext', at };
  if (textEnd !== undefined && textEnd > textOffset) request.to = toAddress(list, para, textRangeToWire(map, textOffset, textEnd)[1]);
  return core.query<FormatContext>(request);
}

function charsAt(core: HmCore, list: ListAddress, para: number, offset: number): CharProperties {
  return charProps(context(core, list, para, offset).characters);
}

function parasAt(core: HmCore, list: ListAddress, para: number): ParaProperties {
  const found = context(core, list, para, 0);
  const props = paraProps(found.paragraphs);
  if (found.list) {
    props.headType = found.list.kind === 'outline' ? 'Outline' : found.list.kind === 'bullet' ? 'Bullet' : 'Number';
    props.numberingId = found.list.id;
    props.paraLevel = found.list.level;
  } else {
    props.headType = 'None';
  }
  return props;
}

function formatCharsIn(core: HmCore, list: ListAddress, para: number, start: number, end: number, propsJson: string): string {
  const patch = charPatch(JSON.parse(propsJson) as Record<string, unknown>);
  const map = paraMap(core.paragraph(list, para));
  const [from, to] = textRangeToWire(map, start, end);
  if (Object.keys(patch).length && to > from) {
    core.transact([{ op: 'formatChars', from: toAddress(list, para, from), to: toAddress(list, para, to), patch }]);
  }
  return JSON.stringify({ ok: true });
}

function formatParasIn(core: HmCore, list: ListAddress, first: number, last: number, propsJson: string): string {
  const patch = paraPatch(JSON.parse(propsJson) as Record<string, unknown>);
  if (!Object.keys(patch).length) return JSON.stringify({ ok: true });
  const a = paraMap(core.paragraph(list, first));
  const b = first === last ? a : paraMap(core.paragraph(list, last));
  core.transact([{ op: 'formatParas', from: toAddress(list, first, a.lead), to: toAddress(list, last, b.end), patch }]);
  return JSON.stringify({ ok: true });
}

const cell = (sec: number, parentPara: number, controlIdx: number, cellIdx: number): ListAddress =>
  cellList(sec, parentPara, controlIdx, cellIdx);

/** 문서 글꼴 표: 엔진은 이름으로 글꼴을 고르므로 언어별 ID 표를 내놓지 않는다. */
export function getFontList(_core: HmCore): Array<{ lang: number; id: number; name: string }> {
  return [];
}

export function getCharPropertiesAt(core: HmCore, sec: number, para: number, charOffset: number): CharProperties {
  return charsAt(core, bodyList(sec), para, charOffset);
}

export function getCellCharPropertiesAt(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number): CharProperties {
  return charsAt(core, cell(sec, parentPara, controlIdx, cellIdx), cellParaIdx, charOffset);
}

export function getCellCharPropertiesAtByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, charOffset: number): CharProperties {
  const { list, para } = pathTarget(sec, parentPara, pathJson);
  return charsAt(core, list, para, charOffset);
}

export function applyCharFormat(core: HmCore, sec: number, para: number, startOffset: number, endOffset: number, propsJson: string): string {
  return formatCharsIn(core, bodyList(sec), para, startOffset, endOffset, propsJson);
}

export function getCharShapeRuns(core: HmCore, sec: number, para: number, start: number, end: number): CharShapeRun[] {
  throw unsupported('getCharShapeRuns');
}

export function setCharShapeRuns(core: HmCore, sec: number, para: number, start: number, end: number, runs: CharShapeRun[]): string {
  throw unsupported('setCharShapeRuns');
}

export function getCharShapeRunsInCellByPath(core: HmCore, sec: number, para: number, path: string, start: number, end: number): CharShapeRun[] {
  throw unsupported('getCharShapeRunsInCellByPath');
}

export function setCharShapeRunsInCellByPath(core: HmCore, sec: number, para: number, path: string, start: number, end: number, runs: CharShapeRun[]): string {
  throw unsupported('setCharShapeRunsInCellByPath');
}

/** 여러 구역에 걸친 글자 서식. 각 구역의 문단 범위마다 적용한다. */
export function applyCharFormatAcrossSections(core: HmCore, startSec: number, startPara: number, startOffset: number, endSec: number, endPara: number, endOffset: number, propsJson: string): string {
  const patch = charPatch(JSON.parse(propsJson) as Record<string, unknown>);
  if (!Object.keys(patch).length) return JSON.stringify({ ok: true });
  const ops: EditOp[] = [];
  for (let sec = startSec; sec <= endSec; sec++) {
    const list = bodyList(sec);
    const first = sec === startSec ? startPara : 0;
    const last = sec === endSec ? endPara : core.paragraphCount(list) - 1;
    const a = paraMap(core.paragraph(list, first));
    const b = paraMap(core.paragraph(list, last));
    const from = sec === startSec ? textRangeToWire(a, startOffset, startOffset)[0] : a.lead;
    const to = sec === endSec ? textRangeToWire(b, 0, endOffset)[1] : b.end;
    ops.push({ op: 'formatChars', from: toAddress(list, first, from), to: toAddress(list, last, to), patch });
  }
  core.transact(ops);
  return JSON.stringify({ ok: true });
}

export function setCharShapeId(core: HmCore, sec: number, para: number, startOffset: number, endOffset: number, charShapeId: number): string {
  throw unsupported('setCharShapeId');
}

export function applyCharFormatInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, startOffset: number, endOffset: number, propsJson: string): string {
  return formatCharsIn(core, cell(sec, parentPara, controlIdx, cellIdx), cellParaIdx, startOffset, endOffset, propsJson);
}

export function applyCharFormatInCellByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, startOffset: number, endOffset: number, propsJson: string): string {
  const { list, para } = pathTarget(sec, parentPara, pathJson);
  return formatCharsIn(core, list, para, startOffset, endOffset, propsJson);
}

export function setCharShapeIdInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, startOffset: number, endOffset: number, charShapeId: number): string {
  throw unsupported('setCharShapeIdInCell');
}

export function setCharShapeIdInCellByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, startOffset: number, endOffset: number, charShapeId: number): string {
  throw unsupported('setCharShapeIdInCellByPath');
}

export function findOrCreateFontId(core: HmCore, name: string): number {
  throw unsupported('findOrCreateFontId');
}

export function prepareFontFamilies(core: HmCore, names: string[]): Promise<void> {
  throw unsupported('prepareFontFamilies');
}

export function findOrCreateFontIdForLang(core: HmCore, lang: number, name: string): number {
  throw unsupported('findOrCreateFontIdForLang');
}

export function getParaPropertiesAt(core: HmCore, sec: number, para: number): ParaProperties {
  return parasAt(core, bodyList(sec), para);
}

export function getCellParaPropertiesAt(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number): ParaProperties {
  return parasAt(core, cell(sec, parentPara, controlIdx, cellIdx), cellParaIdx);
}

export function setNumberingRestart(core: HmCore, sec: number, para: number, mode: number, startNum: number): string {
  throw unsupported('setNumberingRestart');
}

export function applyParaFormat(core: HmCore, sec: number, para: number, propsJson: string): string {
  return formatParasIn(core, bodyList(sec), para, para, propsJson);
}

export function applyParaFormatAcrossSections(core: HmCore, startSec: number, startPara: number, endSec: number, endPara: number, propsJson: string): string {
  const patch = paraPatch(JSON.parse(propsJson) as Record<string, unknown>);
  if (!Object.keys(patch).length) return JSON.stringify({ ok: true });
  const ops: EditOp[] = [];
  for (let sec = startSec; sec <= endSec; sec++) {
    const list = bodyList(sec);
    const first = sec === startSec ? startPara : 0;
    const last = sec === endSec ? endPara : core.paragraphCount(list) - 1;
    const a = paraMap(core.paragraph(list, first));
    const b = paraMap(core.paragraph(list, last));
    ops.push({ op: 'formatParas', from: toAddress(list, first, a.lead), to: toAddress(list, last, b.end), patch });
  }
  core.transact(ops);
  return JSON.stringify({ ok: true });
}

export function applyDocumentParaSpacing(core: HmCore, spacing: { lineSpacing: number; spacingBefore: number; spacingAfter: number }): { ok: boolean; changed: number; pageCount: number } {
  throw unsupported('applyDocumentParaSpacing');
}

export function getDocumentParaSpacing(core: HmCore): { count: number; lineSpacing: number | null; spacingBefore: number | null; spacingAfter: number | null } {
  throw unsupported('getDocumentParaSpacing');
}

export function setParaShapeId(core: HmCore, sec: number, para: number, paraShapeId: number): string {
  throw unsupported('setParaShapeId');
}

export function applyParaFormatInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, propsJson: string): string {
  return formatParasIn(core, cell(sec, parentPara, controlIdx, cellIdx), cellParaIdx, cellParaIdx, propsJson);
}

export function setCellParaShapeId(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, paraShapeId: number): string {
  throw unsupported('setCellParaShapeId');
}

export function getCellParaPropertiesAtByPath(core: HmCore, sec: number, parentPara: number, pathJson: string): ParaProperties {
  const { list, para } = pathTarget(sec, parentPara, pathJson);
  return parasAt(core, list, para);
}

export function applyParaFormatInCellByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, propsJson: string): string {
  const { list, para } = pathTarget(sec, parentPara, pathJson);
  return formatParasIn(core, list, para, para, propsJson);
}

export function setCellParaShapeIdByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, paraShapeId: number): string {
  throw unsupported('setCellParaShapeIdByPath');
}

export function getStyleList(core: HmCore): Array<{ id: number; name: string; englishName: string; type: number; nextStyleId: number; paraShapeId: number; charShapeId: number }> {
  return core.query<StyleInfo[]>({ kind: 'styles' }).map(style => ({
    id: style.id,
    name: style.name,
    englishName: style.englishName,
    type: style.kind === 'character' ? 1 : 0,
    nextStyleId: style.next,
    paraShapeId: style.paraShape,
    charShapeId: style.charShape,
  }));
}

export function getStyleDetail(core: HmCore, styleId: number): { charProps: import('../types').CharProperties; paraProps: import('../types').ParaProperties } {
  const style = core.query<StyleInfo | null>({ kind: 'style', id: styleId });
  if (!style) throw new Error(`스타일 ${styleId} 이 없습니다`);
  return { charProps: charProps(style.characters), paraProps: paraProps(style.paragraphs) };
}

export function updateStyle(core: HmCore, styleId: number, json: string): boolean {
  throw unsupported('updateStyle');
}

export function createStyle(core: HmCore, json: string): number {
  throw unsupported('createStyle');
}

export function deleteStyle(core: HmCore, styleId: number): boolean {
  throw unsupported('deleteStyle');
}

export function getNumberingList(core: HmCore): Array<{ id: number; levelFormats: string[]; numberFormats?: number[]; startNumber: number }> {
  throw unsupported('getNumberingList');
}

export function getBulletList(core: HmCore): Array<{ id: number; char: string; rawCode: number }> {
  throw unsupported('getBulletList');
}

export function ensureDefaultNumbering(core: HmCore): number {
  throw unsupported('ensureDefaultNumbering');
}

export function createNumbering(core: HmCore, json: string): number {
  throw unsupported('createNumbering');
}

export function ensureDefaultBullet(core: HmCore, bulletChar: string): number {
  throw unsupported('ensureDefaultBullet');
}

function styleAt(core: HmCore, list: ListAddress, para: number): { id: number; name: string } {
  const id = context(core, list, para, 0).styleId;
  const style = core.query<StyleInfo | null>({ kind: 'style', id });
  return { id, name: style?.name ?? '' };
}

export function getStyleAt(core: HmCore, sec: number, para: number): { id: number; name: string } {
  return styleAt(core, bodyList(sec), para);
}

export function getCellStyleAt(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number): { id: number; name: string } {
  return styleAt(core, cell(sec, parentPara, controlIdx, cellIdx), cellParaIdx);
}

function applyStyleIn(core: HmCore, list: ListAddress, para: number, styleId: number): { ok: boolean } {
  const map = paraMap(core.paragraph(list, para));
  core.transact([{ op: 'applyStyle', from: toAddress(list, para, map.lead), to: toAddress(list, para, map.end), styleId }]);
  return { ok: true };
}

export function applyStyle(core: HmCore, sec: number, para: number, styleId: number): { ok: boolean } {
  return applyStyleIn(core, bodyList(sec), para, styleId);
}

export function applyCellStyle(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, styleId: number): { ok: boolean } {
  return applyStyleIn(core, cell(sec, parentPara, controlIdx, cellIdx), cellParaIdx, styleId);
}
