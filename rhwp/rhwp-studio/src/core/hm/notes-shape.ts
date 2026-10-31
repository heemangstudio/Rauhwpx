/**
 * 구역의 각주·미주 모양을 읽고 쓴다.
 *
 * 속성(attr) 비트는 HWP 5.0 각주/미주 모양 속성을 따른다: 0~7 번호 모양, 8~9 위치, 10~11 번호 매기기,
 * 12 내용 번호 위 첨자, 13 본문 아래(각주). 14비트 위와 이름이 없는 저장값은 그대로 남긴다.
 */
import type { EditOp } from '../../../vendor/hm-wasm/hm_wasm';
import type { HmCore } from './core';
import { extendBridge } from './api';
import * as format from './format';
import type { NoteNumberFormat, NoteShapeSettings } from './bridge-types';

type NoteKind = 'footnote' | 'endnote';
interface NoteShape { attr?: number; userChar?: number; prefix?: number; suffix?: number; start?: number; separatorLength?: number; spaceAbove?: number; spaceBelow?: number; spaceBetween?: number; lineKind?: number; lineWidth?: number; lineColor?: number }

const NUMBER_FORMATS: Record<NoteNumberFormat, number> = {
  digit: 0, circledDigit: 1, upperRoman: 2, lowerRoman: 3, upperAlpha: 4, lowerAlpha: 5, circledUpperAlpha: 6,
  circledLowerAlpha: 7, hangulSyllable: 8, circledHangulSyllable: 9, hangulJamo: 10, circledHangulJamo: 11,
  hangulDigit: 12, hanjaDigit: 13, circledHanjaDigit: 14, decagonCircle: 15, decagonCircleHanja: 16, symbol: 0x80, userChar: 0x81,
};
const NUMBERING = ['continue', 'restartSection', 'restartPage'];
const PLACEMENT: Record<NoteKind, string[]> = {
  footnote: ['eachColumn', 'mergedColumn', 'rightMostColumn'],
  endnote: ['documentEnd', 'sectionEnd'],
};
/** 구분선을 다시 켤 때의 길이: 한컴이 새 문서에 쓰는 값 (각주 -1 = 5 cm, 미주 단 너비). */
const DEFAULT_SEPARATOR_LENGTH: Record<NoteKind, number> = { footnote: -1, endnote: 14692344 };
const SUPERSCRIPT = 1 << 12, BENEATH_TEXT = 1 << 13, MODELLED_BITS = 0x3fff;

const char = (code: number | undefined): string => code ? String.fromCharCode(code) : '';

function charCode(value: string, field: string): number {
  if (!value) return 0;
  const code = value.charCodeAt(0);
  if (value.length > 1 || (code >= 0xd800 && code <= 0xdfff)) throw new RangeError(`${field}는 글자 하나여야 합니다`);
  return code;
}

/** 이름이나 숫자 문자열을 저장 코드로 바꾼다. 숫자 문자열은 읽을 때 이름이 없던 값이다. */
function code(names: readonly string[] | Record<string, number>, value: unknown, max: number, field: string): number {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 0 && n <= max) return n;
  } else if (typeof value === 'string') {
    const n = Array.isArray(names) ? names.indexOf(value) : (names as Record<string, number>)[value];
    if (n !== undefined && n >= 0) return n;
  }
  throw new RangeError(`알 수 없는 ${field}: ${String(value)}`);
}

function nameOf(names: readonly string[] | Record<string, number>, n: number): string {
  if (Array.isArray(names)) return names[n] ?? String(n);
  return Object.keys(names).find(key => (names as Record<string, number>)[key] === n) ?? String(n);
}

function query(core: HmCore, sec: number, kind: NoteKind): NoteShape | null {
  return core.query<NoteShape | null>({ kind: 'noteShape', section: sec, noteKind: kind });
}

export function getNoteShape(core: HmCore, sec: number, kind: NoteKind): NoteShapeSettings {
  const shape = query(core, sec, kind) ?? {};
  const attr = shape.attr ?? 0;
  const settings: NoteShapeSettings = {
    ok: true,
    numberFormat: nameOf(NUMBER_FORMATS, attr & 0xff),
    userChar: char(shape.userChar), prefixChar: char(shape.prefix), suffixChar: char(shape.suffix),
    startNumber: shape.start ?? 1,
    superscript: !!(attr & SUPERSCRIPT),
    separatorEnabled: shape.separatorLength !== 0,
    separatorLength: shape.separatorLength ?? DEFAULT_SEPARATOR_LENGTH[kind],
    separatorMarginTop: shape.spaceAbove ?? 0, separatorMarginBottom: shape.spaceBelow ?? 0, noteSpacing: shape.spaceBetween ?? 0,
    separatorLineType: shape.lineKind ?? 1, separatorLineWidth: shape.lineWidth ?? 0,
    separatorColor: format.colorToHex(shape.lineColor ?? 0),
    numbering: nameOf(NUMBERING, (attr >> 10) & 3),
    placement: nameOf(PLACEMENT[kind], (attr >> 8) & 3),
  };
  if (kind === 'footnote') settings.beneathText = !!(attr & BENEATH_TEXT);
  return settings;
}

/** 설정대로 쓸 setNoteShape 편집. 저장값과 같으면 null. 빠진 선택 항목은 저장값을 남긴다. */
function shapeOp(core: HmCore, sec: number, kind: NoteKind, settings: NoteShapeSettings): EditOp | null {
  const before = query(core, sec, kind) ?? {};
  const old = before.attr ?? 0;
  const superscript = settings.superscript ?? !!(old & SUPERSCRIPT);
  const beneathText = kind === 'footnote' && settings.beneathText !== undefined ? settings.beneathText : !!(old & BENEATH_TEXT);
  const attr = (old & ~MODELLED_BITS)
    | code(NUMBER_FORMATS, settings.numberFormat, 0xff, '번호 모양')
    | code(PLACEMENT[kind], settings.placement, 3, '주석 위치') << 8
    | code(NUMBERING, settings.numbering, 3, '번호 매기기') << 10
    | (superscript ? SUPERSCRIPT : 0) | (beneathText ? BENEATH_TEXT : 0);
  // 한컴 c11c: 구분선을 끄면 길이 0, 종류 NONE 으로 저장한다. 다시 켜면 5 cm 실선부터다.
  const on = settings.separatorEnabled;
  const lineKind = on ? (settings.separatorLineType || 1) : 0;
  const patch: Required<NoteShape> = {
    attr, userChar: charCode(settings.userChar ?? '', '사용자 기호'), prefix: charCode(settings.prefixChar ?? '', '앞 장식 문자'),
    suffix: charCode(settings.suffixChar ?? '', '뒷 장식 문자'), start: settings.startNumber,
    separatorLength: on ? (settings.separatorLength || DEFAULT_SEPARATOR_LENGTH[kind]) : 0,
    spaceAbove: settings.separatorMarginTop, spaceBelow: settings.separatorMarginBottom, spaceBetween: settings.noteSpacing,
    lineKind, lineWidth: settings.separatorLineWidth, lineColor: format.hexToColor(settings.separatorColor),
  };
  for (const [key, value] of Object.entries(patch)) {
    if (!Number.isInteger(value)) throw new RangeError(`잘못된 주석 모양 값 ${key}: ${String(value)}`);
  }
  if (Object.entries(patch).every(([key, value]) => before[key as keyof NoteShape] === value)) return null;
  return { op: 'setNoteShape', section: sec, kind, patch };
}

/** 한 구역의 주석 모양을 바꾼다. 바뀐 것이 없으면 편집하지 않고 `changed: false` 를 돌려준다. */
export function applyNoteShape(core: HmCore, sec: number, kind: NoteKind, settings: NoteShapeSettings): { ok: boolean; changed: boolean } {
  const op = shapeOp(core, sec, kind, settings);
  if (op) core.transact([op]);
  return { ok: true, changed: !!op };
}

/**
 * 한컴 주석 모양의 적용 범위 "문서 전체": 준 항목만 모든 구역에 덮어쓴다. 구역마다 다른 나머지 항목은 남는다.
 * 편집 한 번(엔진 트랜잭션 하나)이다. 바뀐 구역이 없으면 편집하지 않는다.
 */
export function applyNoteShapeToDocument(core: HmCore, kind: NoteKind, changes: Partial<NoteShapeSettings>): { ok: boolean; changed: boolean } {
  const ops: EditOp[] = [];
  for (let sec = 0; ; sec++) {
    // 조판 전에도 세도록 엔진에 구역을 묻는다. 없는 구역은 BAD_ADDRESS 다.
    try { query(core, sec, kind); } catch (error) { if (sec === 0) throw error; break; }
    const op = shapeOp(core, sec, kind, { ...getNoteShape(core, sec, kind), ...changes });
    if (op) ops.push(op);
  }
  if (ops.length) core.transact(ops);
  return { ok: true, changed: ops.length > 0 };
}

export const getFootnoteShape = (core: HmCore, sec: number): NoteShapeSettings => getNoteShape(core, sec, 'footnote');
export const getEndnoteShape = (core: HmCore, sec: number): NoteShapeSettings => getNoteShape(core, sec, 'endnote');
export const applyFootnoteShape = (core: HmCore, sec: number, settings: NoteShapeSettings) => applyNoteShape(core, sec, 'footnote', settings);
export const applyEndnoteShape = (core: HmCore, sec: number, settings: NoteShapeSettings) => applyNoteShape(core, sec, 'endnote', settings);

extendBridge({ getFootnoteShape, getEndnoteShape, applyFootnoteShape, applyEndnoteShape, applyNoteShapeToDocument });
