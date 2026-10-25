/**
 * 한글 클립보드 문서모델([data-hwpjson]) 붙여넣기. 문단·글자 모양과 글자를 그대로 옮긴다.
 *
 * 모델 표: `ro` 본문 문단(`hp` 첫 문단, 문단마다 `np` 다음 문단), `cp` 글자 모양, `pp` 문단 모양.
 * 문단의 `ru` 는 글자 모양(`cp`)이 같은 조각이고, 조각의 `ch` 는 글자(`t`) 또는 조판 부호(`cc`)다.
 * 표·그림 같은 개체(`co`)는 아직 옮기지 않는다. 그런 모델은 거절해 HTML 경로로 넘긴다.
 */
import type { Address, Align, CharPatch, EditOp, FaceCandidates, ParaPatch } from '../../../vendor/hm-wasm/hm_wasm';
import type { HmCore } from './core';
import { unsupported } from './core';
import { addressToPosition, bodyList, logicalAddress } from './address';
import { extendBridge } from './api';

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {});
const num = (o: Obj, key: string): number | undefined => (typeof o[key] === 'number' ? o[key] as number : undefined);
const flag = (o: Obj, key: string): boolean => o[key] === true || o[key] === 1;

const NONE = 0xffffffff;
const ALIGNS: Align[] = ['justify', 'left', 'right', 'center', 'distribute', 'divide'];
const LINE_SPACING = ['percent', 'fixed', 'added', 'atLeast'] as const;
/** 조판 부호(`cc`)가 글자로 들어가는 것: 탭, 줄 바꿈, 묶음·고정폭 빈칸. */
const CHAR_CODES: Record<number, string> = { 9: '\t', 10: ' ', 30: ' ', 31: ' ' };
/** 붙여넣는 쪽 구역이 정하는 구역·단 정의와 쪽 번호 위치(`cc` 2). */
const SECTION_CODE = 2;

/** 언어 슬롯 1~7 의 값. 하나도 없으면 undefined. */
function perLanguage<T>(o: Obj, prefix: string, read: (value: unknown) => T | undefined): (T | null)[] | undefined {
  const values = [1, 2, 3, 4, 5, 6, 7].map(k => read(o[`${prefix}${k}`]) ?? null);
  return values.some(v => v !== null) ? values : undefined;
}

function charPatch(cp: Obj): CharPatch {
  const patch: CharPatch = {};
  const set = <K extends keyof CharPatch>(key: K, value: CharPatch[K] | undefined) => { if (value !== undefined) patch[key] = value; };
  set('size', num(cp, 'he'));
  const color = num(cp, 'tc');
  if (color !== undefined && color !== NONE) patch.color = color & 0xffffff;
  const shade = num(cp, 'sc');
  if (shade !== undefined && shade !== NONE) patch.shadeColor = shade & 0xffffff;
  patch.bold = flag(cp, 'bo');
  patch.italic = flag(cp, 'it');
  const underline = num(cp, 'ut') ?? 0;
  patch.underline = underline === 1 || underline === 3;
  if (underline === 1 || underline === 3) {
    patch.underlineKind = underline === 3 ? 'above' : 'below';
    set('underlineShape', num(cp, 'us'));
    set('underlineColor', num(cp, 'uc'));
  }
  patch.strike = flag(cp, 'st');
  if (patch.strike) { set('strikeShape', num(cp, 'ss')); set('strikeColor', num(cp, 'so')); }
  patch.superscript = flag(cp, 'su');
  patch.subscript = flag(cp, 'sb');
  patch.emboss = flag(cp, 'em');
  patch.engrave = flag(cp, 'en');
  set('outline', num(cp, 'ot'));
  set('emphasis', num(cp, 'sm'));
  if (cp.uk !== undefined) patch.kerning = flag(cp, 'uk');
  const shadow = num(cp, 'ht');
  if (shadow) {
    patch.shadow = shadow;
    set('shadowColor', num(cp, 'hc'));
    const x = num(cp, 'hx'), y = num(cp, 'hy');
    if (x !== undefined && y !== undefined) patch.shadowOffset = [x, y];
  }
  set('fontFaces', perLanguage(cp, 'f', v => (typeof v === 'string' && v ? v : undefined)));
  const percent = (v: unknown) => (typeof v === 'number' ? v : undefined);
  set('ratios', perLanguage(cp, 'r', percent));
  set('spacings', perLanguage(cp, 's', percent));
  set('relSizes', perLanguage(cp, 'e', percent));
  set('offsets', perLanguage(cp, 'o', percent));
  return patch;
}

/** 모델의 문단 여백·간격은 HWPUNIT 의 두 배다. 비율 줄 간격만 그대로다. */
function paraPatch(pp: Obj): ParaPatch {
  const patch: ParaPatch = {};
  const half = (key: string) => { const v = num(pp, key); return v === undefined ? undefined : Math.round(v / 2); };
  const align = ALIGNS[num(pp, 'ah') ?? 0];
  if (align) patch.align = align;
  const fields: Array<[keyof ParaPatch, string]> = [['indent', 'mi'], ['left', 'ml'], ['right', 'mr'], ['spaceBefore', 'mp'], ['spaceAfter', 'mn']];
  for (const [key, source] of fields) {
    const v = half(source);
    if (v !== undefined) (patch as Record<string, unknown>)[key] = v;
  }
  const kind = LINE_SPACING[num(pp, 'lt') ?? 0];
  const value = num(pp, 'lv');
  if (kind && value !== undefined) {
    patch.lineSpacingKind = kind;
    patch.lineSpacing = kind === 'percent' ? value : Math.round(value / 2);
  }
  return patch;
}

interface Run { text: string; format: CharPatch }
interface Para { runs: Run[]; shape: ParaPatch | null }

/** 본문 문단을 순서대로. 개체가 있으면 거절한다. */
export function readHwpJson(json: string): Para[] {
  let model: Obj;
  try { model = obj(JSON.parse(json.trim())); } catch { throw new SyntaxError('한글 문서모델을 읽을 수 없습니다'); }
  const ro = obj(model.ro), cp = obj(model.cp), pp = obj(model.pp);
  const paras: Para[] = [];
  const seen = new Set<string>();
  for (let id = ro.hp; typeof id === 'string' && id && !seen.has(id); id = obj(ro[id]).np) {
    seen.add(id);
    const p = obj(ro[id]);
    const runs: Run[] = [];
    for (const run of Array.isArray(p.ru) ? p.ru : []) {
      const r = obj(run);
      let text = '';
      for (const item of Array.isArray(r.ch) ? r.ch : []) {
        const c = obj(item);
        if (typeof c.t === 'string') { text += c.t.replace(/\r\n?|\n/g, ' '); continue; }
        const code = num(c, 'cc');
        if (code === SECTION_CODE) continue;
        if (code !== undefined && CHAR_CODES[code] && !c.co) { text += CHAR_CODES[code]; continue; }
        throw unsupported('한글 문서모델의 표·개체 붙여넣기');
      }
      if (text) runs.push({ text, format: charPatch(obj(cp[String(r.cp ?? '')])) });
    }
    const shape = typeof p.pp === 'string' && pp[p.pp] ? paraPatch(obj(pp[p.pp])) : null;
    paras.push({ runs, shape });
  }
  if (!paras.length) throw new SyntaxError('한글 문서모델에 본문 문단이 없습니다');
  return paras;
}

/**
 * 엔진은 등록된 글꼴만 글자 모양에 받는다. 붙여넣기는 글꼴을 기다릴 수 없으므로, 아직 없는 글꼴은
 * 그 언어 칸을 비워 붙여넣는 자리의 글꼴을 쓴다.
 */
function keepRegisteredFaces(core: HmCore, paras: Para[]): void {
  const names = [...new Set(paras.flatMap(p => p.runs.flatMap(r => r.format.fontFaces ?? [])).filter((n): n is string => !!n))];
  if (!names.length) return;
  const known = new Set(core.query<FaceCandidates[]>({ kind: 'fontCandidates', names }).filter(f => f.resolves).map(f => f.name));
  for (const run of paras.flatMap(p => p.runs)) {
    const faces = run.format.fontFaces?.map(name => (name && known.has(name) ? name : null));
    if (faces?.some(Boolean)) run.format.fontFaces = faces;
    else delete run.format.fontFaces;
  }
}

const wireLength = (text: string): number => [...text].reduce((n, c) => n + (c === '\t' ? 8 : c.length), 0);

/**
 * 글자는 조각마다 글자 모양을 실어 넣고, 둘째 문단부터는 문단 모양도 입힌다. 첫 문단은 붙여넣는
 * 자리의 문단 모양을 따른다. 한 번의 엔진 편집이다.
 */
function pasteAt(core: HmCore, at: Address, json: string): string {
  const paras = readHwpJson(json);
  keepRegisteredFaces(core, paras);
  const ops: EditOp[] = [];
  let cursor = { ...at };
  paras.forEach((para, k) => {
    if (k > 0) {
      ops.push({ op: 'split', at: { ...cursor } });
      cursor = { ...cursor, para: cursor.para + 1, offset: 0 };
      if (para.shape && Object.keys(para.shape).length) {
        ops.push({ op: 'formatParas', from: { ...cursor }, to: { ...cursor }, patch: para.shape });
      }
    }
    for (const run of para.runs) {
      ops.push({ op: 'insertText', at: { ...cursor }, text: run.text, format: run.format });
      cursor = { ...cursor, offset: cursor.offset + wireLength(run.text) };
    }
  });
  const receipt = core.transact(ops);
  const end = receipt?.caret ?? cursor;
  const position = addressToPosition(core, end);
  return JSON.stringify({ ok: true, paraIdx: end.para, charOffset: position.charOffset });
}

export function pasteHwpJson(core: HmCore, sec: number, para: number, charOffset: number, json: string): string {
  return pasteAt(core, logicalAddress(core, bodyList(sec), para, charOffset), json);
}

extendBridge({ pasteHwpJson });
