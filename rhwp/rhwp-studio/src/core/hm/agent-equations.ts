/**
 * 수식 개체: 넣기, 속성 읽기·바꾸기, 미리보기. 크기는 엔진이 스크립트 조판으로 정한다.
 * 놓임새(글자처럼 취급, 위치, 배치) 같은 공통 속성은 엔진 개체 속성 조회·편집을 함께 쓴다.
 */
import type { Address, EditOp, TableAddress } from '../../../vendor/hm-wasm/hm_wasm';
import type { EquationProperties, NoteControlRef } from '../types';
import type { CellPathLike } from './bridge-types';
import type { HmCore, ListAddress } from './core';
import { bodyList, cellList, logicalAddress, pathTarget, textAddress } from './address';
import { extendBridge } from './api';

interface EquationInfo { script: string; size: number; color: number; baseline: number; font: string; width: number; height: number }
interface ObjectInfo {
  width?: number; height?: number; horzOffset?: number; vertOffset?: number; treatAsChar?: boolean;
  vertRelTo?: string; horzRelTo?: string; vertAlign?: string; horzAlign?: string; textWrap?: string;
  margins?: [number, number, number, number]; description?: string; zOrder?: number; sizeProtect?: boolean;
}

const WRAP_OUT: Record<string, string> = { square: 'Square', topAndBottom: 'TopAndBottom', behind: 'BehindText', inFront: 'InFrontOfText' };
const WRAP_IN: Record<string, string> = { Square: 'square', TopAndBottom: 'topAndBottom', BehindText: 'behind', InFrontOfText: 'inFront' };
const upper = (value?: string) => (value ? value[0].toUpperCase() + value.slice(1) : undefined);
const lower = (value: unknown) => (typeof value === 'string' && value ? value[0].toLowerCase() + value.slice(1) : undefined);

function objectAt(list: ListAddress, para: number, control: number): TableAddress {
  return { section: list.section, steps: list.steps, para, control };
}

/** 문단에서 수식 컨트롤 번호. 지정이 없으면 첫 수식이다. */
function equationControl(core: HmCore, list: ListAddress, para: number, control?: number): number {
  const controls = core.paragraph(list, para).controls;
  const found = control === undefined ? controls.find(c => c.kind === 'equation') : controls.find(c => c.index === control);
  if (!found || found.kind !== 'equation') throw new RangeError(`수식 컨트롤을 찾을 수 없습니다 (문단 ${para})`);
  return found.index;
}

function cellTarget(sec: number, para: number, ci: number, cellIdx?: number, cellParaIdx?: number, inner?: number): TableAddress {
  return cellIdx === undefined
    ? objectAt(bodyList(sec), para, ci)
    : objectAt(cellList(sec, para, ci, cellIdx), cellParaIdx ?? 0, inner ?? -1);
}

function resolve(core: HmCore, target: TableAddress): TableAddress {
  const list = { section: target.section, steps: target.steps ?? [] };
  return objectAt(list, target.para, equationControl(core, list, target.para, target.control < 0 ? undefined : target.control));
}

function read(core: HmCore, raw: TableAddress): EquationProperties {
  const object = resolve(core, raw);
  const eq = core.query<EquationInfo>({ kind: 'equation', object });
  let common: ObjectInfo = {};
  try { common = core.query<ObjectInfo>({ kind: 'objectProperties', object }); } catch { /* 수식 고유 속성만 낸다 */ }
  const [left, right, top, bottom] = common.margins ?? [0, 0, 0, 0];
  return {
    width: eq.width, height: eq.height, treatAsChar: common.treatAsChar ?? true,
    vertRelTo: upper(common.vertRelTo), horzRelTo: upper(common.horzRelTo),
    vertAlign: upper(common.vertAlign), horzAlign: upper(common.horzAlign),
    vertOffset: common.vertOffset ?? 0, horzOffset: common.horzOffset ?? 0,
    textWrap: common.textWrap ? WRAP_OUT[common.textWrap] ?? upper(common.textWrap) : undefined,
    sizeProtect: common.sizeProtect, zOrder: common.zOrder, description: common.description ?? '',
    outerMarginLeft: left, outerMarginRight: right, outerMarginTop: top, outerMarginBottom: bottom,
    script: eq.script, fontSize: eq.size, color: eq.color, baseline: eq.baseline, fontName: eq.font,
  };
}

function write(core: HmCore, raw: TableAddress, props: Record<string, unknown>): { ok: boolean } {
  const object = resolve(core, raw);
  const patch: Record<string, unknown> = {};
  if (typeof props.script === 'string') patch.script = props.script;
  if (typeof props.fontSize === 'number') patch.size = props.fontSize;
  if (typeof props.color === 'number') patch.color = props.color;
  if (typeof props.baseline === 'number') patch.baseline = props.baseline;
  if (typeof props.fontName === 'string' && props.fontName) patch.font = props.fontName;
  const place: Record<string, unknown> = {};
  for (const key of ['treatAsChar', 'horzOffset', 'vertOffset', 'description', 'zOrder', 'sizeProtect'] as const) {
    if (props[key] !== undefined) place[key] = props[key];
  }
  for (const key of ['vertRelTo', 'horzRelTo', 'vertAlign', 'horzAlign'] as const) {
    const value = lower(props[key]);
    if (value) place[key] = value;
  }
  if (typeof props.textWrap === 'string') place.textWrap = WRAP_IN[props.textWrap] ?? lower(props.textWrap);
  const margins = ['outerMarginLeft', 'outerMarginRight', 'outerMarginTop', 'outerMarginBottom'].map(key => props[key]);
  if (margins.some(value => typeof value === 'number')) {
    const current = core.query<ObjectInfo>({ kind: 'objectProperties', object }).margins ?? [0, 0, 0, 0];
    place.margins = margins.map((value, i) => (typeof value === 'number' ? value : current[i]));
  }
  const ops = [] as EditOp[];
  if (Object.keys(patch).length) ops.push({ op: 'setEquation', object, patch });
  if (Object.keys(place).length) ops.push({ op: 'setObjectProperties', object, patch: place });
  core.transact(ops);
  return { ok: true };
}

/** 넣은 수식의 문단과 컨트롤 번호. 캐럿은 수식 바로 뒤에 선다. */
function insertAt(core: HmCore, at: Address, script: string, size: number, color: number): { para: number; control: number } {
  const receipt = core.transact([{ op: 'insertEquation', at, script, size, color }]);
  const caret = receipt?.caret;
  if (!caret) throw new Error('수식을 넣지 못했습니다');
  const list = { section: caret.section, steps: caret.steps ?? [] };
  const control = core.paragraph(list, caret.para).controls.find(c => c.kind === 'equation' && c.offset === caret.offset - 8);
  if (!control) throw new Error('넣은 수식을 찾을 수 없습니다');
  return { para: caret.para, control: control.index };
}

export function getEquationProperties(core: HmCore, sec: number, para: number, ci: number, cellIdx?: number, cellParaIdx?: number, innerControlIdx?: number): EquationProperties {
  return read(core, cellTarget(sec, para, ci, cellIdx, cellParaIdx, innerControlIdx));
}

export function getEquationPropertiesByPath(core: HmCore, sec: number, parentPara: number, cellPath: CellPathLike, innerControlIdx: number): EquationProperties {
  const { list, para } = pathTarget(sec, parentPara, cellPath);
  return read(core, objectAt(list, para, innerControlIdx));
}

export function getNoteEquationProperties(core: HmCore, ref: NoteControlRef): EquationProperties {
  return read(core, objectAt(cellList(ref.sectionIdx, ref.paraIdx, ref.controlIdx, 0), ref.noteParaIdx, ref.innerControlIdx));
}

export function setEquationProperties(core: HmCore, sec: number, para: number, ci: number, cellIdx: number | undefined, cellParaIdx: number | undefined, props: Record<string, unknown>, innerControlIdx?: number): { ok: boolean } {
  return write(core, cellTarget(sec, para, ci, cellIdx, cellParaIdx, innerControlIdx), props);
}

export function setEquationPropertiesByPath(core: HmCore, sec: number, parentPara: number, cellPath: CellPathLike, innerControlIdx: number, props: Record<string, unknown>): { ok: boolean } {
  const { list, para } = pathTarget(sec, parentPara, cellPath);
  return write(core, objectAt(list, para, innerControlIdx), props);
}

/** `{svg, widthPx, heightPx, baselinePx, warnings}` JSON. 문서는 바꾸지 않는다. */
export function renderEquationPreview(core: HmCore, script: string, fontSizeHwpunit: number, color: number, fontName?: string): string {
  return JSON.stringify(core.query({ kind: 'equationPreview', script, size: fontSizeHwpunit, color, ...(fontName ? { font: fontName } : {}) }));
}

export function insertEquation(core: HmCore, sec: number, para: number, charOffset: number, script: string, fontSizeHwpunit: number, color: number, logical = false): { ok: boolean; paraIdx: number; controlIdx: number } {
  const at = (logical ? logicalAddress : textAddress)(core, bodyList(sec), para, charOffset);
  const placed = insertAt(core, at, script, fontSizeHwpunit, color);
  return { ok: true, paraIdx: placed.para, controlIdx: placed.control };
}

export function insertEquationInCellByPath(core: HmCore, sec: number, parentPara: number, cellPath: CellPathLike, charOffset: number, script: string, fontSizeHwpunit: number, color: number, logical = false): { ok: boolean; cellParaIdx: number; controlIdx: number } {
  const { list, para } = pathTarget(sec, parentPara, cellPath);
  const placed = insertAt(core, (logical ? logicalAddress : textAddress)(core, list, para, charOffset), script, fontSizeHwpunit, color);
  return { ok: true, cellParaIdx: placed.para, controlIdx: placed.control };
}

export function insertEquationInCell(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, script: string, fontSizeHwpunit: number, color: number, logical = false): { ok: boolean; cellParaIdx: number; controlIdx: number } {
  return insertEquationInCellByPath(core, sec, parentPara, [{ controlIndex: controlIdx, cellIndex: cellIdx, cellParaIndex: cellParaIdx }], charOffset, script, fontSizeHwpunit, color, logical);
}

export function getEquationScriptInCellAt(core: HmCore, sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, eqControlIdx: number): string | null {
  const control = core.paragraph(cellList(sec, parentPara, controlIdx, cellIdx), cellParaIdx).controls
    .find(c => c.index === eqControlIdx && c.kind === 'equation');
  return control?.script ?? null;
}

extendBridge({
  getEquationProperties, getEquationPropertiesByPath, getNoteEquationProperties,
  setEquationProperties, setEquationPropertiesByPath, renderEquationPreview,
  insertEquation, insertEquationInCell, insertEquationInCellByPath, getEquationScriptInCellAt,
});
