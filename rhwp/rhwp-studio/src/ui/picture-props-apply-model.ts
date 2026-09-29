import type { CellPathLike, PictureProperties, ShapeProperties } from '@/core/types';

export type PicturePropsObjectType = 'image' | 'shape' | 'line' | 'group' | 'ole';

export type PicturePropsPatch = Record<string, unknown>;

export interface PicturePropsApplyTargetContext {
  sec: number;
  para: number;
  ci: number;
  headerFooter?: {
    outerParaIdx: number;
    outerControlIdx: number;
  };
  cellPath?: CellPathLike;
  innerControlIdx: number;
}

export type PicturePropsApplyTarget =
  | {
      kind: 'cell-shape';
      sec: number;
      para: number;
      cellPath: CellPathLike;
      innerControlIdx: number;
    }
  | {
      kind: 'body-shape';
      sec: number;
      para: number;
      ci: number;
    }
  | {
      kind: 'header-footer-picture';
      sec: number;
      outerParaIdx: number;
      outerControlIdx: number;
      para: number;
      ci: number;
    }
  | {
      kind: 'cell-picture';
      sec: number;
      para: number;
      cellPath: CellPathLike;
      innerControlIdx: number;
    }
  | {
      kind: 'body-picture';
      sec: number;
      para: number;
      ci: number;
    };

interface RawRotationControl {
  value: string;
  disabled: boolean;
}

interface RawFlipControl {
  value: boolean;
  disabled: boolean;
}

interface RawBoxValues {
  left: string;
  top: string;
  right: string;
  bottom: string;
}

export interface PicturePropsApplyForm {
  common: {
    sizeProtect: boolean;
    width: string;
    height: string;
    treatAsChar: boolean;
    textWrap: string;
    horzRelTo: string;
    horzAlign: string;
    horzOffset: string;
    vertRelTo: string;
    vertAlign: string;
    vertOffset: string;
    restrictInPage: boolean;
    allowOverlap: boolean;
    description: string;
  };
  transform: {
    rotation?: RawRotationControl;
    horzFlip?: RawFlipControl;
    vertFlip?: RawFlipControl;
  };
  outerMargin: {
    left?: string;
    top?: string;
    right?: string;
    bottom?: string;
  };
  caption: {
    present: boolean;
    activeIndex: number;
    size: string;
    gap: string;
    includeMargin: boolean;
  };
  line: {
    color?: string;
    width?: string;
    type?: string;
    end?: string;
    arrowStart?: string;
    arrowEnd?: string;
    arrowStartSize?: string;
    arrowEndSize?: string;
  };
  shapeTextBox: {
    marginLeft?: string;
    marginTop?: string;
    marginRight?: string;
    marginBottom?: string;
    verticalAlign?: string;
  };
  shapeCorner: {
    customChecked: boolean;
    customValue?: string;
    activeIndex: number;
  };
  shapeFill: {
    solidChecked?: boolean;
    gradientChecked?: boolean;
    solidColors?: { face: string; pattern: string };
    patternType?: string;
    gradientType?: string;
    gradientAngle?: string;
    gradientCenterX?: string;
    gradientCenterY?: string;
    gradientBlur?: string;
    transparency?: string;
  };
  shapeShadow: {
    present: boolean;
    activeIndex: number;
    color: string;
    offsetX: string;
    offsetY: string;
  };
  image: {
    scale?: { x: string; y: string };
    crop?: RawBoxValues;
    padding?: RawBoxValues;
    effectControlsPresent: boolean;
    selectedEffect?: string;
    brightness?: string;
    contrast?: string;
    transparency?: string;
  };
}

const HWP_PER_MM = 7200 / 25.4;

function numberOr(raw: string | undefined, fallback: number): number {
  return parseFloat(raw ?? '') || fallback;
}

function integerOr(raw: string | undefined, fallback: number): number {
  return parseInt(raw ?? '') || fallback;
}

function mmToHwp(raw: string | undefined): number {
  return Math.round(numberOr(raw, 0) * HWP_PER_MM);
}

/**
 * [Task #6769] 오프셋 칸의 표시값 — **이 모듈이 서식의 단일 소유자다.**
 *
 * `addChangedOffset` 은 "사용자가 이 칸을 건드렸는가"를 표시값과 견줘 판정한다. 그래서
 * 다이얼로그가 칸을 채우는 서식과 여기 서식이 반드시 같아야 한다 — 갈라지면 판정이 늘
 * "바뀌었다"가 된다. 두 벌을 두고 가드로 묶는 대신, 다이얼로그가 이 함수를 가져다 쓴다.
 */
export function displayedMm(hwp: number): string {
  return (hwp / HWP_PER_MM).toFixed(2);
}

/**
 * mm 2자리 표시는 저장 단위를 잃는다 — -1 HWPUNIT 은 `"-0.00"` 으로 보이고 되돌리면
 * `0` 이라 모델의 `-1` 과 달라져, 사용자가 아무것도 안 고쳐도 변경으로 판정됐다.
 * 비교는 표시 정밀도로 정규화해서 한다 — 문자열을 그대로 견주면 같은 값의 다른 표기
 * (`"10"` 과 `"10.00"`, `"-0.00"` 과 `"0.00"`)가 변경으로 잡힌다.
 */
function untouchedMm(raw: string | undefined, current: number): boolean {
  return Number(numberOr(raw, 0).toFixed(2)) === Number(displayedMm(current));
}

/**
 * [Task #6769] 위치 오프셋 전용 — 건드린 칸만 싣고, 크기의 0 클램프는 두지 않는다.
 *
 * `horizontal_offset`/`vertical_offset` 은 도형 변환 지문의 구성 요소라 1 HWPUNIT 만
 * 흔들려도 한컴 원본 렌더링 행렬이 지워진다. 음수 오프셋이 정당하므로 `Math.max(0, ...)`
 * 을 쓰지 않는다.
 */
function addChangedOffset(
  patch: PicturePropsPatch,
  key: string,
  raw: string | undefined,
  current: number,
): void {
  if (untouchedMm(raw, current)) return;
  patch[key] = mmToHwp(raw);
}

/**
 * mm 칸(여백·선 굵기·자르기 등) — 오프셋과 같은 판정으로 건드린 칸만 싣는다.
 * 0.01mm 는 약 2.83 HWPUNIT 이라 표시값을 되돌리면 대부분 ±1 HWPUNIT 어긋난다.
 * 칸이 없으면(탭이 없는 개체) 아무것도 보내지 않는다.
 */
function addChangedMm(
  patch: PicturePropsPatch,
  key: string,
  raw: string | undefined,
  current: number,
  min?: number,
): void {
  if (raw === undefined || untouchedMm(raw, current)) return;
  const value = mmToHwp(raw);
  patch[key] = min === undefined ? value : Math.max(min, value);
}

/** 크기 칸 — 비었거나 0 이하인 값은 개체를 없애므로 쓰지 않는다. */
function addChangedSize(
  patch: PicturePropsPatch,
  key: string,
  raw: string,
  current: number,
): void {
  const mm = parseFloat(raw);
  if (!Number.isFinite(mm) || mm <= 0) return;
  addChangedMm(patch, key, raw, current);
}

function hexToColorRef(hex: string): number {
  const value = hex.replace('#', '');
  const red = parseInt(value.substring(0, 2), 16);
  const green = parseInt(value.substring(2, 4), 16);
  const blue = parseInt(value.substring(4, 6), 16);
  return (blue << 16) | (green << 8) | red;
}

/** HWP ColorRef (BGR u32) → #rrggbb — 다이얼로그가 색 칸을 채우는 서식 */
export function colorRefToHex(color: number): string {
  const blue = (color >> 16) & 0xFF;
  const green = (color >> 8) & 0xFF;
  const red = color & 0xFF;
  return '#' + [red, green, blue].map(v => v.toString(16).padStart(2, '0')).join('');
}

/** 색 칸이 표시값 그대로인가 — ColorRef 상위 바이트(플래그)는 칸에 보이지 않으므로 hex 로 비교한다. */
function sameColor(hex: string, current: number | undefined, fallbackHex: string): boolean {
  const shown = current === undefined ? fallbackHex : colorRefToHex(current);
  return hex.toLowerCase() === shown.toLowerCase();
}

/** 확대 비율 칸의 표시값 (%) */
export function displayedScale(size: number, original: number): string {
  return ((size / original) * 100).toFixed(2);
}

/**
 * 채우기 무늬 선택지 → 엔진 무늬 코드. 모델은 OWPML hatchStyle 순서의 1~6 을 쓰고
 * (1 가로줄, 2 세로줄, 3 역대각선, 4 대각선, 5 십자, 6 X자), 0 이하는 무늬 없음이다.
 */
const FILL_PATTERN_CODES: Record<string, number> = {
  none: -1,
  hline: 1,
  vline: 2,
  dline1: 3,
  dline2: 4,
  cross: 5,
};

/**
 * 엔진 무늬 코드를 선택지 값으로 바꾼다. 선택지에 없는 코드(예: 6 X자)는 ''
 * — 다이얼로그는 빈 선택으로 두고, 사용자가 고르지 않으면 원래 코드를 보존한다.
 */
export function fillPatternOption(code: number | undefined): string {
  if (code === undefined || code <= 0) return 'none';
  const entry = Object.entries(FILL_PATTERN_CODES).find(([, value]) => value === code);
  return entry ? entry[0] : '';
}

/** 캡션 위치 → 3×3 격자 칸 (0:왼위 1:위 2:오위 3:왼 4:중앙 5:오 6:왼아 7:아래 8:오아) */
export function captionGridIndex(direction: string, vertAlign: string): number {
  const col = direction === 'Left' ? 0 : direction === 'Right' ? 2 : 1;
  const row = (direction === 'Left' || direction === 'Right')
    ? (vertAlign === 'Top' ? 0 : vertAlign === 'Bottom' ? 2 : 1)
    : (direction === 'Top' ? 0 : 2);
  return row * 3 + col;
}

function addChanged(
  patch: PicturePropsPatch,
  key: string,
  next: unknown,
  current: unknown,
): void {
  if (next !== current) patch[key] = next;
}

function addAlways(patch: PicturePropsPatch, key: string, value: unknown): void {
  patch[key] = value;
}

function captionFromGrid(index: number): { direction: string; vertAlign: string } {
  const column = index % 3;
  const row = Math.floor(index / 3);
  if (column === 0) {
    return { direction: 'Left', vertAlign: row === 0 ? 'Top' : row === 1 ? 'Center' : 'Bottom' };
  }
  if (column === 2) {
    return { direction: 'Right', vertAlign: row === 0 ? 'Top' : row === 1 ? 'Center' : 'Bottom' };
  }
  return { direction: row <= 1 ? 'Top' : 'Bottom', vertAlign: 'Top' };
}

function appendCommonSize(
  patch: PicturePropsPatch,
  props: PictureProperties,
  form: PicturePropsApplyForm['common'],
): void {
  addChanged(patch, 'sizeProtect', form.sizeProtect, props.sizeProtect ?? false);
  if (form.sizeProtect) return;
  addChangedSize(patch, 'width', form.width, props.width);
  addChangedSize(patch, 'height', form.height, props.height);
}

function appendCommonPosition(
  patch: PicturePropsPatch,
  props: PictureProperties,
  form: PicturePropsApplyForm['common'],
): void {
  addChanged(patch, 'treatAsChar', form.treatAsChar, props.treatAsChar);
  if (form.treatAsChar) return;

  const textWrap = form.horzRelTo === 'TakePlace' ? 'TopAndBottom' : form.textWrap;
  addChanged(patch, 'textWrap', textWrap, props.textWrap);
  if (form.horzRelTo !== 'TakePlace') {
    addChanged(patch, 'horzRelTo', form.horzRelTo, props.horzRelTo);
  }
  addChanged(patch, 'horzAlign', form.horzAlign, props.horzAlign);
  addChangedOffset(patch, 'horzOffset', form.horzOffset, props.horzOffset);
  addChanged(patch, 'vertRelTo', form.vertRelTo, props.vertRelTo);
  addChanged(patch, 'vertAlign', form.vertAlign, props.vertAlign);
  addChangedOffset(patch, 'vertOffset', form.vertOffset, props.vertOffset);
  addChanged(patch, 'restrictInPage', form.restrictInPage, props.restrictInPage ?? true);
  addChanged(patch, 'allowOverlap', form.allowOverlap, props.allowOverlap ?? false);
}

function appendTransform(
  patch: PicturePropsPatch,
  props: Pick<PictureProperties, 'rotationAngle' | 'horzFlip' | 'vertFlip'> | ShapeProperties,
  form: PicturePropsApplyForm['transform'],
): void {
  if (form.rotation && !form.rotation.disabled) {
    addChanged(patch, 'rotationAngle', integerOr(form.rotation.value, 0), props.rotationAngle ?? 0);
  }
  if (form.horzFlip && !form.horzFlip.disabled) {
    addChanged(patch, 'horzFlip', form.horzFlip.value, Boolean(props.horzFlip));
  }
  if (form.vertFlip && !form.vertFlip.disabled) {
    addChanged(patch, 'vertFlip', form.vertFlip.value, Boolean(props.vertFlip));
  }
}

function appendOuterMargin(
  patch: PicturePropsPatch,
  props: PictureProperties,
  form: PicturePropsApplyForm['outerMargin'],
): void {
  addChangedMm(patch, 'outerMarginLeft', form.left, props.outerMarginLeft ?? 0);
  addChangedMm(patch, 'outerMarginRight', form.right, props.outerMarginRight ?? 0);
  addChangedMm(patch, 'outerMarginTop', form.top, props.outerMarginTop ?? 0);
  addChangedMm(patch, 'outerMarginBottom', form.bottom, props.outerMarginBottom ?? 0);
}

function appendCaption(
  patch: PicturePropsPatch,
  props: Partial<PictureProperties>,
  form: PicturePropsApplyForm['caption'],
): void {
  if (!form.present) return;
  const hasCaption = form.activeIndex >= 0 && form.activeIndex !== 4;
  const hadCaption = Boolean(props.hasCaption);
  addChanged(patch, 'hasCaption', hasCaption, hadCaption);
  if (!hasCaption) return;

  // 새로 만드는 캡션은 보이는 값 전부, 기존 캡션은 고친 항목만 보낸다.
  const caption = captionFromGrid(form.activeIndex);
  const positionTouched = !hadCaption || form.activeIndex !== captionGridIndex(
    props.captionDirection ?? 'Bottom', props.captionVertAlign ?? 'Top',
  );
  if (positionTouched) {
    addAlways(patch, 'captionDirection', caption.direction);
    addAlways(patch, 'captionVertAlign', caption.vertAlign);
  }
  if (!hadCaption) {
    addAlways(patch, 'captionWidth', mmToHwp(form.size));
    addAlways(patch, 'captionSpacing', mmToHwp(form.gap));
    addAlways(patch, 'captionIncludeMargin', form.includeMargin);
    return;
  }
  addChangedMm(patch, 'captionWidth', form.size, props.captionWidth ?? 0);
  addChangedMm(patch, 'captionSpacing', form.gap, props.captionSpacing ?? 0);
  addChanged(patch, 'captionIncludeMargin', form.includeMargin, Boolean(props.captionIncludeMargin));
}

function appendBorder(
  patch: PicturePropsPatch,
  props: Pick<PictureProperties, 'borderColor' | 'borderWidth'> | ShapeProperties,
  form: PicturePropsApplyForm['line'],
): void {
  if (form.color !== undefined && !sameColor(form.color, props.borderColor ?? 0, '#000000')) {
    patch.borderColor = hexToColorRef(form.color);
  }
  addChangedMm(patch, 'borderWidth', form.width, props.borderWidth ?? 0);
}

function appendShapeLine(
  patch: PicturePropsPatch,
  props: ShapeProperties,
  form: PicturePropsApplyForm['line'],
  includeArrows: boolean,
): void {
  appendBorder(patch, props, form);
  if (form.type !== undefined) addChanged(patch, 'lineType', integerOr(form.type, 0), props.lineType ?? 1);
  if (form.end !== undefined) addChanged(patch, 'lineEndShape', integerOr(form.end, 0), props.lineEndShape ?? 0);
  if (!includeArrows) return;
  if (form.arrowStart !== undefined) addChanged(patch, 'arrowStart', integerOr(form.arrowStart, 0), props.arrowStart ?? 0);
  if (form.arrowEnd !== undefined) addChanged(patch, 'arrowEnd', integerOr(form.arrowEnd, 0), props.arrowEnd ?? 0);
  if (form.arrowStartSize !== undefined) addChanged(patch, 'arrowStartSize', integerOr(form.arrowStartSize, 0), props.arrowStartSize ?? 0);
  if (form.arrowEndSize !== undefined) addChanged(patch, 'arrowEndSize', integerOr(form.arrowEndSize, 0), props.arrowEndSize ?? 0);
}

function appendShapeTextBox(
  patch: PicturePropsPatch,
  props: ShapeProperties,
  form: PicturePropsApplyForm['shapeTextBox'],
): void {
  // 기본값(510/141)은 다이얼로그가 칸을 채울 때 쓰는 값과 같다.
  addChangedMm(patch, 'tbMarginLeft', form.marginLeft, props.tbMarginLeft ?? 510);
  addChangedMm(patch, 'tbMarginRight', form.marginRight, props.tbMarginRight ?? 510);
  addChangedMm(patch, 'tbMarginTop', form.marginTop, props.tbMarginTop ?? 141);
  addChangedMm(patch, 'tbMarginBottom', form.marginBottom, props.tbMarginBottom ?? 141);
  if (form.verticalAlign !== undefined) {
    addChanged(patch, 'tbVerticalAlign', form.verticalAlign, props.tbVerticalAlign ?? 'Top');
  }
}

function appendShapeCorner(
  patch: PicturePropsPatch,
  props: ShapeProperties,
  form: PicturePropsApplyForm['shapeCorner'],
): void {
  let roundRate = 0;
  if (form.customChecked && form.customValue !== undefined) {
    roundRate = integerOr(form.customValue, 0);
  } else if (form.activeIndex === 1) {
    roundRate = 20;
  } else if (form.activeIndex === 2) {
    roundRate = 50;
  }
  addChanged(patch, 'roundRate', roundRate, props.roundRate ?? 0);
}

function shapeFillType(form: PicturePropsApplyForm['shapeFill']): string {
  if (form.solidChecked) return 'solid';
  if (form.gradientChecked) return 'gradient';
  return 'none';
}

/**
 * 단색 채우기 — 새로 단색으로 바꾸면 보이는 색·무늬를 모두 싣고, 이미 단색이면 고친
 * 항목만 싣는다. 무늬 선택지에 없는 코드는 고르지 않는 한 보존한다.
 */
function appendSolidFill(
  patch: PicturePropsPatch,
  props: ShapeProperties,
  form: PicturePropsApplyForm['shapeFill'],
  switched: boolean,
): void {
  if (!form.solidColors) return;
  if (switched || !sameColor(form.solidColors.face, props.fillBgColor, '#ffffff')) {
    patch.fillBgColor = hexToColorRef(form.solidColors.face);
  }
  if (switched || !sameColor(form.solidColors.pattern, props.fillPatColor, '#000000')) {
    patch.fillPatColor = hexToColorRef(form.solidColors.pattern);
  }
  if (form.patternType === undefined) return;
  const code = FILL_PATTERN_CODES[form.patternType];
  if (code === undefined) return;
  if (switched || form.patternType !== fillPatternOption(props.fillPatType)) {
    patch.fillPatType = code;
  }
}

/**
 * 그러데이션 — 유형 선택지는 아직 엔진 코드와 대응하지 않으므로, 다른 채우기에서
 * 그러데이션으로 바꿀 때만 기본 유형(1)을 보낸다. 기존 원형/원뿔형 유형은 보존한다.
 */
function appendGradientFill(
  patch: PicturePropsPatch,
  props: ShapeProperties,
  form: PicturePropsApplyForm['shapeFill'],
  switched: boolean,
): void {
  if (switched && form.gradientType !== undefined) addAlways(patch, 'gradientType', integerOr(form.gradientType, 1));
  if (form.gradientAngle !== undefined) addChanged(patch, 'gradientAngle', integerOr(form.gradientAngle, 0), props.gradientAngle ?? 0);
  if (form.gradientCenterX !== undefined) addChanged(patch, 'gradientCenterX', integerOr(form.gradientCenterX, 0), props.gradientCenterX ?? 0);
  if (form.gradientCenterY !== undefined) addChanged(patch, 'gradientCenterY', integerOr(form.gradientCenterY, 0), props.gradientCenterY ?? 0);
  if (form.gradientBlur !== undefined) addChanged(patch, 'gradientBlur', integerOr(form.gradientBlur, 0), props.gradientBlur ?? 0);
}

function appendShapeFill(
  patch: PicturePropsPatch,
  props: ShapeProperties,
  form: PicturePropsApplyForm['shapeFill'],
): void {
  // 채우기 탭이 없는 개체(직선 등)는 채우기를 건드리지 않는다.
  if (form.solidChecked === undefined && form.gradientChecked === undefined) return;
  const fillType = shapeFillType(form);
  const currentType = props.fillType ?? 'none';
  addChanged(patch, 'fillType', fillType, currentType);
  const switched = fillType !== currentType;
  if (fillType === 'solid') appendSolidFill(patch, props, form, switched);
  if (fillType === 'gradient') appendGradientFill(patch, props, form, switched);
  if (form.transparency !== undefined && (fillType === 'solid' || fillType === 'gradient')) {
    // 칸은 백분율이라 알파(0~255)를 되돌리면 어긋난다(100 → 39% → 99). 고친 경우만 보낸다.
    const percent = Math.max(0, Math.min(100, integerOr(form.transparency, 0)));
    const shownPercent = Math.round((props.fillAlpha ?? 0) * 100 / 255);
    if (percent !== shownPercent) patch.fillAlpha = Math.round(percent * 255 / 100);
  }
}

interface ShapeShadowProps {
  shadowType?: number;
  shadowColor?: number;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
}

/** 그림자 간격 칸은 mm 1자리로 표시된다. */
function untouchedShadowOffset(raw: string, current: number): boolean {
  return Number(numberOr(raw, 0).toFixed(1)) === Number((current / HWP_PER_MM).toFixed(1));
}

/** 그림자 — 새로 켜면 보이는 값 전부, 이미 켜져 있으면 고친 항목만, 끌 때는 종류만. */
function appendShapeShadow(
  patch: PicturePropsPatch,
  props: ShapeProperties & ShapeShadowProps,
  form: PicturePropsApplyForm['shapeShadow'],
): void {
  if (!form.present) return;
  const currentType = props.shadowType ?? 0;
  const shadowType = form.activeIndex > 0 ? form.activeIndex : 0;
  addChanged(patch, 'shadowType', shadowType, currentType);
  if (shadowType === 0) return;
  const enabling = currentType === 0;
  if (enabling || !sameColor(form.color, props.shadowColor, '#b2b2b2')) {
    patch.shadowColor = hexToColorRef(form.color);
  }
  if (enabling || !untouchedShadowOffset(form.offsetX, props.shadowOffsetX ?? 0)) {
    patch.shadowOffsetX = mmToHwp(form.offsetX);
  }
  if (enabling || !untouchedShadowOffset(form.offsetY, props.shadowOffsetY ?? 0)) {
    patch.shadowOffsetY = mmToHwp(form.offsetY);
  }
}

function appendOlePatch(
  patch: PicturePropsPatch,
  props: PictureProperties,
  shapeProps: ShapeProperties,
  form: PicturePropsApplyForm,
): void {
  appendOuterMargin(patch, props, form.outerMargin);
  appendCaption(patch, props, form.caption);
  appendShapeLine(patch, shapeProps, form.line, false);
}

function appendNonOleShapePatch(
  patch: PicturePropsPatch,
  shapeProps: ShapeProperties,
  form: PicturePropsApplyForm,
): void {
  appendShapeTextBox(patch, shapeProps, form.shapeTextBox);
  appendTransform(patch, shapeProps, form.transform);
  appendShapeLine(patch, shapeProps, form.line, true);
  appendShapeCorner(patch, shapeProps, form.shapeCorner);
  appendShapeFill(patch, shapeProps, form.shapeFill);
  appendShapeShadow(patch, shapeProps, form.shapeShadow);
}

/** 확대 비율 칸이 표시값 그대로인가 */
function untouchedScale(raw: string, size: number, original: number): boolean {
  return Number(numberOr(raw, 0).toFixed(2)) === Number(displayedScale(size, original));
}

/**
 * 확대 비율 — 고친 비율 칸만 크기로 환산한다. 기본 탭에서 입력한 폭/높이가 이미
 * 패치에 있으면 비율 칸(그대로 남은 표시값)이 그것을 덮지 않는다.
 */
function appendImageScale(
  patch: PicturePropsPatch,
  props: PictureProperties,
  form: PicturePropsApplyForm,
): void {
  if (form.common.sizeProtect || !form.image.scale) return;
  const { x, y } = form.image.scale;
  if (!('width' in patch) && props.originalWidth > 0 && !untouchedScale(x, props.width, props.originalWidth)) {
    const scaleX = Math.max(1, Math.min(1000, numberOr(x, 100)));
    addChanged(patch, 'width', Math.round(props.originalWidth * scaleX / 100), props.width);
  }
  if (!('height' in patch) && props.originalHeight > 0 && !untouchedScale(y, props.height, props.originalHeight)) {
    const scaleY = Math.max(1, Math.min(1000, numberOr(y, 100)));
    addChanged(patch, 'height', Math.round(props.originalHeight * scaleY / 100), props.height);
  }
}

function appendImageBox(
  patch: PicturePropsPatch,
  values: RawBoxValues | undefined,
  keys: readonly [string, string, string, string],
  current: readonly [number, number, number, number],
): void {
  if (!values) return;
  addChangedMm(patch, keys[0], values.left, current[0], 0);
  addChangedMm(patch, keys[1], values.top, current[1], 0);
  addChangedMm(patch, keys[2], values.right, current[2], 0);
  addChangedMm(patch, keys[3], values.bottom, current[3], 0);
}

function appendImageEffects(
  patch: PicturePropsPatch,
  props: PictureProperties,
  form: PicturePropsApplyForm['image'],
): void {
  if (form.effectControlsPresent && form.selectedEffect !== undefined) {
    const effect = form.selectedEffect === 'Original' ? 'RealPic' : form.selectedEffect;
    addChanged(patch, 'effect', effect, props.effect ?? 'RealPic');
  }
  if (form.brightness !== undefined) {
    const brightness = Math.max(-100, Math.min(100, integerOr(form.brightness, 0)));
    addChanged(patch, 'brightness', brightness, props.brightness ?? 0);
  }
  if (form.contrast !== undefined) {
    const contrast = Math.max(-100, Math.min(100, integerOr(form.contrast, 0)));
    addChanged(patch, 'contrast', contrast, props.contrast ?? 0);
  }
  if (form.transparency !== undefined) {
    const transparency = Math.max(0, Math.min(100, integerOr(form.transparency, 0)));
    addChanged(patch, 'transparency', transparency, props.transparency ?? 0);
  }
}

function appendImagePatch(
  patch: PicturePropsPatch,
  props: PictureProperties,
  form: PicturePropsApplyForm,
): void {
  appendTransform(patch, props, form.transform);
  appendOuterMargin(patch, props, form.outerMargin);
  appendCaption(patch, props, form.caption);
  appendBorder(patch, props, form.line);
  appendImageScale(patch, props, form);
  appendImageBox(
    patch,
    form.image.crop,
    ['cropLeft', 'cropTop', 'cropRight', 'cropBottom'],
    [props.cropLeft ?? 0, props.cropTop ?? 0, props.cropRight ?? 0, props.cropBottom ?? 0],
  );
  appendImageBox(
    patch,
    form.image.padding,
    ['paddingLeft', 'paddingTop', 'paddingRight', 'paddingBottom'],
    [props.paddingLeft ?? 0, props.paddingTop ?? 0, props.paddingRight ?? 0, props.paddingBottom ?? 0],
  );
  appendImageEffects(patch, props, form.image);
}

export function buildPicturePropsPatch(
  objectType: PicturePropsObjectType,
  props: PictureProperties,
  shapeProps: ShapeProperties | null,
  form: PicturePropsApplyForm,
): PicturePropsPatch {
  const patch: PicturePropsPatch = {};
  appendCommonSize(patch, props, form.common);
  appendCommonPosition(patch, props, form.common);
  addChanged(patch, 'description', form.common.description, props.description);

  if (objectType === 'image') {
    appendImagePatch(patch, props, form);
  } else if (shapeProps) {
    if (objectType === 'ole') appendOlePatch(patch, props, shapeProps, form);
    else appendNonOleShapePatch(patch, shapeProps, form);
  }
  return patch;
}

export function resolvePicturePropsApplyTarget(
  objectType: PicturePropsObjectType,
  context: PicturePropsApplyTargetContext,
): PicturePropsApplyTarget {
  if (objectType !== 'image') {
    if (context.cellPath) {
      return {
        kind: 'cell-shape',
        sec: context.sec,
        para: context.para,
        cellPath: context.cellPath,
        innerControlIdx: context.innerControlIdx,
      };
    }
    return {
      kind: 'body-shape',
      sec: context.sec,
      para: context.para,
      ci: context.ci,
    };
  }

  if (context.headerFooter) {
    return {
      kind: 'header-footer-picture',
      sec: context.sec,
      outerParaIdx: context.headerFooter.outerParaIdx,
      outerControlIdx: context.headerFooter.outerControlIdx,
      para: context.para,
      ci: context.ci,
    };
  }
  if (context.cellPath) {
    return {
      kind: 'cell-picture',
      sec: context.sec,
      para: context.para,
      cellPath: context.cellPath,
      innerControlIdx: context.innerControlIdx,
    };
  }
  return {
    kind: 'body-picture',
    sec: context.sec,
    para: context.para,
    ci: context.ci,
  };
}
