/** 기존 개체 선택·삽입·속성 UI가 쓰는 좌표와 희망 엔진 주소를 연결한다. */
import type { Address, EditOp, ObjectAddress, PageObject } from '../../../vendor/hm-wasm/hm_wasm';
import type { HmCore } from './core';
import { hu, px, unsupported } from './core';
import { logicalAddress, paraMap, pathTarget, stepsToPath, wireToLogical } from './address';
import { extendBridge } from './api';
import type * as original from './objects';
import type { CellPathLike, ControlLayoutItem, PictureProperties, ShapeProperties } from '../types';

export interface NativeObject {
  instanceId?: number;
  kind: string; width: number; height: number; treatAsChar: boolean; horzOffset: number; vertOffset: number;
  horzRelTo: string; vertRelTo: string; horzAlign: string; vertAlign: string; textWrap: string;
  description: string; margins: number[]; rotation: number; zOrder: number; sizeProtect: boolean;
  restrictInPage: boolean; allowOverlap: boolean; keepWithAnchor: boolean;
  border?: { color: number; width: number; style: number; attr?: number; outline?: number; endCap?: number; head?: number; tail?: number; headSize?: number; tailSize?: number }; crop?: number[];
  naturalWidth?: number; naturalHeight?: number; text?: string; size?: number[];
  brightness?: number; contrast?: number; effect?: number; transparency?: number;
  flipHorizontal?: boolean; flipVertical?: boolean; pictureMargins?: number[];
  fill?: { color?: number | null; kind: number; solid?: { background: number; patternColor: number; pattern: number } | null; gradient?: { kind: number; angle: number; centerX: number; centerY: number; step: number }; alpha?: number[] };
  textMargins?: number[]; textVerticalAlign?: string; round?: number; shadow?: { kind: number; color: number; x: number; y: number } | null;
  /** 캡션. list 는 개체 안 목록 가운데 캡션의 번호다. */
  caption?: { side: string; verticalAlign?: string; includeMargin: boolean; width: number; gap: number; maxWidth: number; paragraphs: number; list: number } | null;
}
export const objectAddress = (section: number, para: number, control: number): ObjectAddress => ({ section, para, control });
export function objectAddressByPath(section: number, parent: number, path: CellPathLike | string, control: number): ObjectAddress {
  const target = pathTarget(section, parent, path);
  return { ...target.list, para: target.para, control };
}
export const objectProperties = (core: HmCore, object: ObjectAddress): NativeObject => core.query({ kind: 'objectProperties', object });
export function pageObjects(core: HmCore, page: number): PageObject[] {
  return JSON.parse(core.call(doc => doc.pageObjects(page)));
}
function box(core: HmCore, object: ObjectAddress) {
  for (let page = 0; page < core.state().pageCount; page++) {
    const found = pageObjects(core, page).find(o => o.section === object.section && o.para === object.para && o.control === object.control
      && JSON.stringify(o.steps ?? []) === JSON.stringify(object.steps ?? []));
    if (found) return { pageIndex: page, x: px(found.x), y: px(found.y), width: px(found.width), height: px(found.height) };
  }
  throw new Error('개체가 표시된 쪽을 찾을 수 없습니다');
}
const title = (value: string) => value ? value[0].toUpperCase() + value.slice(1) : value;
const nativeEnum = (value: unknown) => ({ Paragraph: 'para', Para: 'para', TopAndBottom: 'topAndBottom', BehindText: 'behind', InFrontOfText: 'inFront' }[String(value)] ?? String(value)[0]?.toLowerCase() + String(value).slice(1));
function commonProperties(o: NativeObject) {
  return { width: o.width, height: o.height, treatAsChar: o.treatAsChar,
    horzOffset: o.horzOffset, vertOffset: o.vertOffset,
    horzRelTo: o.horzRelTo === 'para' ? 'Para' : title(o.horzRelTo), vertRelTo: o.vertRelTo === 'para' ? 'Para' : title(o.vertRelTo),
    horzAlign: title(o.horzAlign), vertAlign: title(o.vertAlign),
    textWrap: ({ behind: 'BehindText', inFront: 'InFrontOfText' }[o.textWrap] ?? title(o.textWrap)),
    description: o.description, sizeProtect: o.sizeProtect,
    outerMarginLeft: o.margins[0], outerMarginRight: o.margins[1], outerMarginTop: o.margins[2], outerMarginBottom: o.margins[3],
    borderColor: o.border?.color ?? 0, borderWidth: o.border?.width ?? 0,
    rotationAngle: o.rotation ?? 0, horzFlip: o.flipHorizontal ?? false, vertFlip: o.flipVertical ?? false };
}
const EFFECTS = ['RealPic', 'GrayScale', 'BlackWhite', '', 'Pattern8x8'];
export function pictureProperties(core: HmCore, object: ObjectAddress): PictureProperties {
  const o = objectProperties(core, object);
  return { ...commonProperties(o), brightness: o.brightness ?? 0, contrast: o.contrast ?? 0, effect: EFFECTS[o.effect ?? 0] ?? 'RealPic',
    transparency: Math.round((o.transparency ?? 0) * 100 / 255), originalWidth: o.naturalWidth ?? o.width, originalHeight: o.naturalHeight ?? o.height,
    cropLeft: o.crop?.[0] ?? 0, cropTop: o.crop?.[1] ?? 0, cropRight: o.crop?.[2] ?? o.width, cropBottom: o.crop?.[3] ?? o.height,
    paddingLeft: o.pictureMargins?.[0] ?? 0, paddingRight: o.pictureMargins?.[1] ?? 0, paddingTop: o.pictureMargins?.[2] ?? 0, paddingBottom: o.pictureMargins?.[3] ?? 0,
    hasCaption: !!o.caption, captionDirection: title(o.caption?.side ?? 'bottom'), captionVertAlign: title(o.caption?.verticalAlign ?? 'top'), captionWidth: o.caption?.width ?? 0,
    captionSpacing: o.caption?.gap ?? 0, captionMaxWidth: o.caption?.maxWidth ?? 0, captionIncludeMargin: o.caption?.includeMargin ?? false };
}
function captionProperties(o: NativeObject) {
  return { hasCaption: !!o.caption, captionDirection: title(o.caption?.side ?? 'bottom'), captionVertAlign: title(o.caption?.verticalAlign ?? 'top'), captionWidth: o.caption?.width ?? 0,
    captionSpacing: o.caption?.gap ?? 0, captionMaxWidth: o.caption?.maxWidth ?? 0, captionIncludeMargin: o.caption?.includeMargin ?? false };
}
function shapeProperties(core: HmCore, object: ObjectAddress): ShapeProperties {
  const o = objectProperties(core, object);
  const kind = o.fill?.kind ?? 0;
  const solid = o.fill?.solid;
  return { ...commonProperties(o), ...captionProperties(o), instanceId: o.instanceId, fillType: kind & 1 ? 'solid' : kind & 4 ? 'gradient' : kind & 2 ? 'image' : 'none',
    fillBgColor: solid?.background, fillPatColor: solid?.patternColor, fillPatType: solid?.pattern, fillAlpha: o.fill?.alpha?.[0] ?? 0,
    lineType: o.border?.style ?? 0, borderAttr: o.border?.attr ?? 0, borderOutlineStyle: o.border?.outline ?? 0,
    lineEndShape: o.border?.endCap ?? 0, arrowStart: o.border?.head ?? 0, arrowEnd: o.border?.tail ?? 0,
    arrowStartSize: o.border?.headSize ?? 0, arrowEndSize: o.border?.tailSize ?? 0,
    tbMarginLeft: o.textMargins?.[0] ?? 0, tbMarginRight: o.textMargins?.[1] ?? 0, tbMarginTop: o.textMargins?.[2] ?? 0, tbMarginBottom: o.textMargins?.[3] ?? 0,
    tbVerticalAlign: title(o.textVerticalAlign ?? 'top'), roundRate: o.round ?? 0,
    ...(o.fill?.gradient ? { gradientType: o.fill.gradient.kind, gradientAngle: o.fill.gradient.angle, gradientCenterX: o.fill.gradient.centerX, gradientCenterY: o.fill.gradient.centerY, gradientBlur: o.fill.gradient.step } : {}),
    shadowType: o.shadow?.kind ?? 0, shadowColor: o.shadow?.color ?? 0, shadowOffsetX: o.shadow?.x ?? 0, shadowOffsetY: o.shadow?.y ?? 0 } as ShapeProperties;
}
export function objectPatch(native: NativeObject, props: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const margins = [...native.margins];
  const crop = [...(native.crop ?? [0, 0, native.width, native.height])];
  const pictureMargins = [...(native.pictureMargins ?? [0, 0, 0, 0])];
  const border = { color: 0, width: 0, style: 0, ...native.border };
  const direct = ['width', 'height', 'horzOffset', 'vertOffset', 'treatAsChar', 'description', 'zOrder', 'sizeProtect',
    'restrictInPage', 'allowOverlap', 'keepWithAnchor', 'brightness', 'contrast'];
  const enums = ['horzRelTo', 'vertRelTo', 'horzAlign', 'vertAlign', 'textWrap'];
  const marginKeys = ['outerMarginLeft', 'outerMarginRight', 'outerMarginTop', 'outerMarginBottom'];
  const cropKeys = ['cropLeft', 'cropTop', 'cropRight', 'cropBottom'];
  const paddingKeys = ['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'];
  const caption: Record<string, unknown> = {};
  const textMargins = [...(native.textMargins ?? [0, 0, 0, 0])];
  const textMarginKeys = ['tbMarginLeft', 'tbMarginRight', 'tbMarginTop', 'tbMarginBottom'];
  const shadow: Record<string, unknown> = {};
  const gradientKeys = ['gradientType', 'gradientAngle', 'gradientCenterX', 'gradientCenterY', 'gradientBlur'];
  const fillKeys = ['fillType', 'fillBgColor', 'fillPatColor', 'fillPatType'];
  let fillChanged = false;
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || Object.is(value, current[key])) continue;
    if (direct.includes(key)) patch[key] = value;
    else if (enums.includes(key)) patch[key] = nativeEnum(value);
    else if (key === 'hasCaption') caption.enabled = value;
    else if (key.startsWith('caption')) {
      const mapped = { captionDirection: 'side', captionVertAlign: 'verticalAlign', captionWidth: 'width', captionSpacing: 'gap', captionMaxWidth: 'maxWidth', captionIncludeMargin: 'includeMargin' }[key];
      if (!mapped) throw new RangeError(`잘못된 캡션 속성: ${key}`);
      caption[mapped] = mapped === 'side' || mapped === 'verticalAlign' ? nativeEnum(value) : value;
    }
    else if (key === 'rotationAngle') patch.rotation = value;
    else if (key === 'horzFlip') patch.flipHorizontal = value;
    else if (key === 'vertFlip') patch.flipVertical = value;
    else if (key === 'effect') {
      const index = EFFECTS.indexOf(String(value));
      if (index < 0) throw unsupported(`setObjectProperties.effect.${String(value)}`);
      patch.effect = index;
    } else if (key === 'transparency') patch.transparency = Math.round(Math.max(0, Math.min(100, Number(value))) * 255 / 100);
    else if (marginKeys.includes(key)) { margins[marginKeys.indexOf(key)] = Number(value); patch.margins = margins; }
    else if (cropKeys.includes(key)) { crop[cropKeys.indexOf(key)] = Number(value); patch.crop = crop; }
    else if (paddingKeys.includes(key)) { pictureMargins[paddingKeys.indexOf(key)] = Number(value); patch.pictureMargins = pictureMargins; }
    else if (fillKeys.includes(key)) fillChanged = true;
    else if (gradientKeys.includes(key)) fillChanged = true;
    else if (textMarginKeys.includes(key)) { textMargins[textMarginKeys.indexOf(key)] = Number(value); patch.textMargins = textMargins; }
    else if (key === 'tbVerticalAlign') patch.textVerticalAlign = nativeEnum(value);
    else if (key === 'roundRate') patch.round = Number(value);
    else if (key.startsWith('shadow')) {
      const name = { shadowType: 'kind', shadowColor: 'color', shadowOffsetX: 'x', shadowOffsetY: 'y' }[key];
      if (!name) throw new RangeError(`잘못된 그림자 속성: ${key}`);
      shadow[name] = value;
    }
    else if (['lineEndShape', 'arrowStart', 'arrowEnd', 'arrowStartSize', 'arrowEndSize'].includes(key)) {
      const name = { lineEndShape: 'endCap', arrowStart: 'head', arrowEnd: 'tail', arrowStartSize: 'headSize', arrowEndSize: 'tailSize' }[key]!;
      Object.assign(border, { [name]: Number(value) }); patch.border = border;
    }
    else if (key === 'fillAlpha') patch.fillAlpha = Number(value);
    else if (key === 'borderColor' || key === 'borderWidth' || key === 'lineType') {
      border[key === 'borderColor' ? 'color' : key === 'borderWidth' ? 'width' : 'style'] = Number(value); patch.border = border;
    } else throw unsupported(`setObjectProperties.${key}`);
  }
  if (Object.keys(shadow).length) patch.shadow = shadow;
  if (Object.keys(caption).length) patch.caption = caption;
  if (fillChanged) {
    const pick = (key: string) => props[key] ?? current[key];
    const type = pick('fillType');
    if (type === 'solid') {
      patch.fill = { kind: 'solid', background: Number(pick('fillBgColor') ?? 0xffffff),
        patternColor: Number(pick('fillPatColor') ?? 0), pattern: Number(pick('fillPatType') ?? 0) };
    } else if (type === 'gradient') patch.fill = { kind: 'gradient', gradientType: pick('gradientType'), angle: pick('gradientAngle'), centerX: pick('gradientCenterX'), centerY: pick('gradientCenterY'), step: pick('gradientBlur') };
    else if (type === 'image') patch.fill = { kind: 'image' };
    else if (type === 'none') patch.fill = { kind: 'none' };
    else throw unsupported(`setObjectProperties.fillType.${String(type)}`);
  }
  return patch;
}
export function setObjectProperties(core: HmCore, object: ObjectAddress, props: Record<string, unknown>, current: Record<string, unknown>) {
  const patch = objectPatch(objectProperties(core, object), props, current);
  if (Object.keys(patch).length) core.transact([{ op: 'setObjectProperties', object, patch } as EditOp]);
  return { ok: true };
}
export function deleteObject(core: HmCore, object: ObjectAddress) {
  core.transact([{ op: 'deleteObject', object } as EditOp]);
  return { ok: true };
}
export function insertedControl(core: HmCore, at: Address, before: number[]) {
  const list = { section: at.section, steps: at.steps ?? [] };
  const info = core.paragraph(list, at.para);
  // 삽입된 컨트롤의 wire 위치로 찾는다. 컨트롤 인덱스는 중간 삽입으로 달라질 수 있다.
  const found = info.controls.find(c => c.offset === at.offset && !before.includes(c.index))
    ?? info.controls.find(c => c.offset === at.offset && ['object', 'table', 'equation'].includes(c.kind));
  if (!found) throw new Error('삽입한 개체를 찾을 수 없습니다');
  return { ok: true, paraIdx: at.para, controlIdx: found.index, logicalOffset: wireToLogical(paraMap(info), found.offset) };
}

export const getShapeBBox: typeof original.getShapeBBox = (core, s, p, c) => box(core, objectAddress(s, p, c));
export const getObjectBBox: typeof original.getObjectBBox = (core, _kind, s, p, c, cell, cellPara, inner, path) => box(core,
  path?.length ? objectAddressByPath(s, p, path, inner ?? c) : cell !== undefined ? { section: s, steps: [{ para: p, control: c, index: cell }], para: cellPara ?? 0, control: inner ?? 0 } : objectAddress(s, p, c));
export const getPictureProperties: typeof original.getPictureProperties = (core, s, p, c) => pictureProperties(core, objectAddress(s, p, c));
export const getCellPicturePropertiesByPath: typeof original.getCellPicturePropertiesByPath = (core, s, p, path, c) => pictureProperties(core, objectAddressByPath(s, p, path, c));
export const getShapeProperties: typeof original.getShapeProperties = (core, s, p, c) => shapeProperties(core, objectAddress(s, p, c));
export const getCellShapePropertiesByPath: typeof original.getCellShapePropertiesByPath = (core, s, p, path, c) => shapeProperties(core, objectAddressByPath(s, p, path, c));
export const getShapeText: typeof original.getShapeText = (core, s, p, c) => ({ ok: true, text: objectProperties(core, objectAddress(s, p, c)).text ?? '' });
/**
 * 캡션이 없는 그림에 hasCaption 을 켜면 한컴 기본 캡션("그림 N", 아래)을 만든다. captionCharOffset 은 캡션 첫 문단에서
 * 글을 이어 쓸 글자 위치다. 생성과 속성 변경은 같은 편집으로 묶는다.
 */
function setPictureWithCaption(core: HmCore, object: ObjectAddress, props: Record<string, unknown>, current: Record<string, unknown> = { ...pictureProperties(core, object) }) {
  const creating = props.hasCaption === true && !current.hasCaption;
  const patch = objectPatch(objectProperties(core, object), props, { ...current });
  const ops: EditOp[] = [];
  if (creating) ops.push({ op: 'setObjectCaption', object, text: ' ', withNumber: true } as EditOp);
  if (Object.keys(patch).length) ops.push({ op: 'setObjectProperties', object, patch } as EditOp);
  core.transact(ops);
  if (!creating) return { ok: true };
  const list = objectProperties(core, object).caption!.list;
  const steps = [...(object.steps ?? []), { para: object.para, control: object.control, index: list }];
  return { ok: true, captionCharOffset: paraMap(core.paragraph({ section: object.section, steps }, 0)).textLength };
}
export const setPictureProperties: typeof original.setPictureProperties = (core, s, p, c, props) => setPictureWithCaption(core, objectAddress(s, p, c), props);
export const setShapeProperties: typeof original.setShapeProperties = (core, s, p, c, props) => setPictureWithCaption(core, objectAddress(s, p, c), props, { ...shapeProperties(core, objectAddress(s, p, c)) });
export const setCellPicturePropertiesByPath: typeof original.setCellPicturePropertiesByPath = (core, s, p, path, c, props) => { const at = objectAddressByPath(s, p, path, c); return setObjectProperties(core, at, props, { ...pictureProperties(core, at) }); };
export const setCellShapePropertiesByPath: typeof original.setCellShapePropertiesByPath = (core, s, p, path, c, props) => { const at = objectAddressByPath(s, p, path, c); return setObjectProperties(core, at, props, { ...shapeProperties(core, at) }); };
export const deletePictureControl: typeof original.deletePictureControl = (core, s, p, c) => deleteObject(core, objectAddress(s, p, c));
export const deleteShapeControl: typeof original.deleteShapeControl = deletePictureControl;
export const deleteEquationControl: typeof original.deleteEquationControl = deletePictureControl;
export const deleteCellPictureControlByPath: typeof original.deleteCellPictureControlByPath = (core, s, p, path, c) => deleteObject(core, objectAddressByPath(s, p, path, c));
export const deleteEquationControlInCellByPath: typeof original.deleteEquationControlInCellByPath = deleteCellPictureControlByPath;
export const deleteEquationControlInCell: typeof original.deleteEquationControlInCell = (core, s, p, c, cell, para, inner) => deleteObject(core, { section: s, steps: [{ para: p, control: c, index: cell }], para, control: inner });
export const insertPicture: typeof original.insertPicture = (core, s, p, offset, path, bytes, width, height, nw, nh, extension, description, x, y, placement) => {
  const target = pathTarget(s, p, path);
  const at = logicalAddress(core, target.list, target.para, offset);
  const before = core.paragraph(target.list, target.para).controls.map(c => c.index);
  const ops: EditOp[] = [{ op: 'insertPicture', at, bytes: [...bytes], extension, description, width, height,
    naturalWidth: hu(nw), naturalHeight: hu(nh), inline: placement !== 'floating', horzOffset: x, vertOffset: y } as EditOp];
  if (placement === 'floating' && (x !== undefined || y !== undefined)) {
    const control = core.paragraph(target.list, target.para).controls.filter(c => c.offset < at.offset).length;
    ops.push({ op: 'setObjectProperties', object: { ...target.list, para: target.para, control }, patch: { horzRelTo: 'paper', vertRelTo: 'paper' } } as EditOp);
  }
  core.transact(ops);
  return { ...insertedControl(core, at, before), sectionIdx: s, ...(target.list.steps.length ? { cellPath: stepsToPath(target.list.steps, target.para) } : {}) };
};
/** 구역 본문 개체 중 가장 위 z 의 다음 값. 새 개체가 z 를 받지 않으면 모두 같은 z 라 순서 바꾸기가 듣지 않는다. */
function nextZOrder(core: HmCore, section: number): number {
  let top = -1;
  for (let page = 0; page < core.state().pageCount; page++) for (const object of pageObjects(core, page)) {
    if (object.section === section && !object.furniture && !object.steps?.length) top = Math.max(top, object.z);
  }
  return top + 1;
}
export const createShapeControl: typeof original.createShapeControl = (core, params) => {
  const kinds: Record<string, 'rect' | 'ellipse' | 'line' | 'textbox' | 'polygon' | 'arc'> = { rectangle: 'rect', rect: 'rect', ellipse: 'ellipse', line: 'line', textbox: 'textbox', polygon: 'polygon', arc: 'arc' };
  const connectors: Record<string, number> = { 'connector-straight': 0, 'connector-straight-arrow': 1, 'connector-stroke': 3, 'connector-stroke-arrow': 4, 'connector-arc': 6, 'connector-arc-arrow': 7 };
  const connectorKind = connectors[String(params.shapeType)];
  const kind = connectorKind === undefined ? kinds[String(params.shapeType)] : 'line';
  if (!kind) throw unsupported(`createShapeControl.${params.shapeType}`);
  const target = pathTarget(Number(params.sectionIdx ?? 0), Number(params.paraIdx ?? 0), '[]');
  const caret = logicalAddress(core, target.list, target.para, Number(params.charOffset ?? 0));
  const controls = core.paragraph(target.list, target.para).controls;
  // 같은 자리에 먼저 떠 있던 개체 뒤에 넣는다. 앞에 넣으면 이미 돌려준 개체 번호가 하나씩 밀린다.
  let offset = caret.offset;
  for (const c of controls) if (c.offset === offset && c.inline === false) offset += 8;
  const at = { ...caret, offset };
  const before = controls.map(c => c.index);
  const control = controls.filter(c => c.offset < at.offset).length;
  const zOrder = nextZOrder(core, target.list.section);
  const points = kind === 'polygon' && Array.isArray(params.polygonPoints)
    ? (params.polygonPoints as { x: number; y: number }[]).map(p => [Math.round(Number(p.x)), Math.round(Number(p.y))])
    : undefined;
  core.transact([{ op: 'createShape', at, kind, width: Number(params.width), height: Number(params.height), ...(points ? { points } : {}),
    ...(connectorKind === undefined ? {} : { connector: { kind: connectorKind, start: [Number(params.startSubjectID ?? 0), Number(params.startSubjectIndex ?? 0)], end: [Number(params.endSubjectID ?? 0), Number(params.endSubjectIndex ?? 0)] } }),
    inline: params.treatAsChar === true, horzOffset: Number(params.horzOffset ?? 0), vertOffset: Number(params.vertOffset ?? 0), text: params.text } as EditOp,
    { op: 'setObjectProperties', object: { ...target.list, para: target.para, control }, patch: {
      horzRelTo: nativeEnum(params.horzRelTo ?? 'Paper'), vertRelTo: nativeEnum(params.vertRelTo ?? 'Paper'),
      textWrap: nativeEnum(params.textWrap ?? (kind === 'textbox' ? 'InFrontOfText' : 'Square')), zOrder,
      flipHorizontal: params.lineFlipX === true, flipVertical: params.lineFlipY === true } } as EditOp]);
  return insertedControl(core, at, before);
};
export const getControlImageData: typeof original.getControlImageData = (core, s, p, c, path) => new Uint8Array(core.query<{ bytes: number[] }>({ kind: 'pictureData', object: objectAddressByPath(s, p, path, c) }).bytes);
export const getControlImageMime: typeof original.getControlImageMime = (core, s, p, c, path) => core.query<{ mime: string }>({ kind: 'pictureData', object: objectAddressByPath(s, p, path, c) }).mime;

export const movePictureControlByPath: typeof original.movePictureControlByPath = (core, s, fromParent, fromPath, fromControl, toParent, toPath, offset) => {
  const object = objectAddressByPath(s, fromParent, fromPath, fromControl);
  const target = pathTarget(s, toParent, toPath);
  const at = logicalAddress(core, target.list, target.para, offset);
  const receipt = core.transact([{ op: 'relocateObject', object, at } as EditOp]);
  const caret = receipt?.caret;
  if (!caret) throw new Error('옮긴 개체의 위치를 찾을 수 없습니다');
  const list = { section: caret.section, steps: caret.steps ?? [] };
  const info = core.paragraph(list, caret.para);
  const control = info.controls.find(c => c.offset === caret.offset - 8);
  if (!control) throw new Error('옮긴 개체를 찾을 수 없습니다');
  return { ok: true, moved: true, paraIdx: caret.para, controlIdx: control.index,
    cellPath: stepsToPath(list.steps, caret.para), charOffset: wireToLogical(paraMap(info), control.offset) };
};
export const movePictureControl: typeof original.movePictureControl = (core, s, fromPara, fromCi, toPara, offset) =>
  movePictureControlByPath(core, s, fromPara, [], fromCi, toPara, [], offset);

export const changeObjectZOrder: typeof original.changeObjectZOrder = (core, s, p, c, operation) => {
  if (!['front', 'back', 'forward', 'backward'].includes(operation)) throw new RangeError('알 수 없는 개체 순서 명령입니다');
  const unique = new Map<string, PageObject>();
  for (let page = 0; page < core.state().pageCount; page++) for (const object of pageObjects(core, page)) {
    if (object.section === s && !object.furniture && !object.steps?.length) unique.set(`${object.para}:${object.control}`, object);
  }
  const selected = unique.get(`${p}:${c}`);
  if (!selected) throw new Error('순서를 바꿀 개체가 없습니다');
  const ordered = [...unique.values()].filter(o => o.layer === selected.layer).sort((a, b) => a.z - b.z || a.para - b.para || a.control - b.control);
  const index = ordered.indexOf(selected);
  const next = operation === 'front' ? ordered.length - 1 : operation === 'back' ? 0 : Math.max(0, Math.min(ordered.length - 1, index + (operation === 'forward' ? 1 : -1)));
  if (index === next) return { ok: true, zOrder: selected.z };
  ordered.splice(index, 1);
  ordered.splice(next, 0, selected);
  core.transact(ordered.map((object, zOrder) => ({ op: 'setObjectProperties', object: objectAddress(s, object.para, object.control), patch: { zOrder } } as EditOp)));
  return { ok: true, zOrder: next };
};

/** 회전한 그림의 개체 상자는 돌린 그림을 감싸는 틀이다. 선택 핸들은 돌기 전 그림 크기를 틀 가운데에 둔다. */
function drawnBox(core: HmCore, o: PageObject): { x: number; y: number; w: number; h: number } {
  const box = { x: o.x, y: o.y, w: o.width, h: o.height };
  if (o.kind !== 'picture' || !o.rotation) return box;
  const size = objectProperties(core, { section: o.section, steps: o.steps ?? [], para: o.para, control: o.control }).size;
  if (!size) return box;
  return { x: o.x + (o.width - size[0]) / 2, y: o.y + (o.height - size[1]) / 2, w: size[0], h: size[1] };
}

/** 머리말·꼬리말 바로 안의 그림이면 그 머리말·꼬리말 컨트롤 위치. 다른 바탕 개체는 본문 편집 대상이 아니다. */
function headerFooterOf(core: HmCore, o: PageObject): ControlLayoutItem['headerFooter'] | null {
  const step = o.steps?.length === 1 ? o.steps[0] : null;
  if (!o.furniture || o.kind !== 'picture' || !step) return null;
  const kind = core.paragraph({ section: o.section, steps: [] }, step.para).controls.find(c => c.index === step.control)?.kind;
  return kind === 'header' || kind === 'footer' ? { kind, outerParaIdx: step.para, outerControlIdx: step.control } : null;
}

export function getPageControlLayout(core: HmCore, pageNum: number): { controls: ControlLayoutItem[] } {
  const controls: ControlLayoutItem[] = [];
  for (const o of pageObjects(core, pageNum)) {
    // 양식 개체는 개체 선택 대상이 아니다. 클릭은 양식 값 편집(getFormObjectAt)으로 간다.
    if (o.kind === 'form') continue;
    const headerFooter = headerFooterOf(core, o);
    if (o.furniture && !headerFooter) continue;
    const path = headerFooter ? [] : stepsToPath(o.steps ?? [], o.para);
    const type: ControlLayoutItem['type'] = o.kind === 'picture' ? 'image' : o.kind === 'connector' ? 'line' : ['table', 'shape', 'line', 'group', 'ole', 'equation'].includes(o.kind) ? o.kind as ControlLayoutItem['type'] : 'shape';
    const b = drawnBox(core, o);
    controls.push({ type, x: px(b.x), y: px(b.y), w: px(b.w), h: px(b.h), secIdx: o.section,
      paraIdx: path.length ? o.steps![0].para : o.para, controlIdx: o.control,
      ...(headerFooter ? { headerFooter } : {}),
      ...(o.missing ? { missing: true } : {}),
      ...(path.length ? { cellPath: path, cellIdx: o.steps![0].index, cellParaIdx: o.para, innerControlIdx: o.control, outerTableControlIdx: o.steps![0].control } : {}),
      ...(o.line ? { x1: px(o.line[0]), y1: px(o.line[1]), x2: px(o.line[2]), y2: px(o.line[3]) } : {}),
      ...(o.layer === 'behind' ? { wrap: 'behindText' } : o.layer === 'front' ? { wrap: 'inFrontOfText' } : {}),
      plane: o.layer === 'behind' ? 1 : o.layer === 'front' ? 3 : 2, zOrder: o.z, stableIndex: controls.length });
  }
  return { controls };
}

extendBridge({ getShapeBBox, getObjectBBox, getPictureProperties, getCellPicturePropertiesByPath,
  getShapeProperties, getCellShapePropertiesByPath, getShapeText, setPictureProperties, setShapeProperties,
  setCellPicturePropertiesByPath, setCellShapePropertiesByPath, deletePictureControl, deleteShapeControl,
  deleteEquationControl, deleteCellPictureControlByPath, deleteEquationControlInCellByPath, deleteEquationControlInCell,
  insertPicture, createShapeControl, getControlImageData, getControlImageMime, getPageControlLayout,
  movePictureControlByPath, movePictureControl, changeObjectZOrder });
