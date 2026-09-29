/**
 * 글자 모양 대화상자의 언어별 값 반영 규칙 (DOM 없음).
 *
 * 대화상자는 언어 하나(또는 대표)의 값만 보여 준다. 보여 준 값을 그대로 되돌려
 * 쓰면 한글/영문 장평·자간이 다른 문서에서 설정만 눌러도 모든 언어가 대표 칸의
 * 값으로 평평해진다. 사용자가 실제로 고친 칸만 배열에 반영한다.
 */

export const CHAR_SHAPE_LANG_COUNT = 7;

export type LangArrayKey = 'ratios' | 'spacings' | 'relativeSizes' | 'charOffsets';

const LANG_ARRAY_DEFAULTS: Record<LangArrayKey, number> = {
  ratios: 100,
  spacings: 0,
  relativeSizes: 100,
  charOffsets: 0,
};

/** 상대 크기(%) — 엔진은 u8 배열로 읽으므로 범위를 벗어나면 배열 전체가 버려진다. */
export function clampRelativeSize(value: number): number {
  return Math.max(10, Math.min(250, value));
}

/** 글자 위치(%) — 엔진은 i8 배열로 읽는다. */
export function clampCharOffset(value: number): number {
  return Math.max(-100, Math.min(100, value));
}

/** 그림자 간격(%) — 엔진은 i8 로 잘라 저장한다. */
export function clampShadowOffset(value: number): number {
  return Math.max(-100, Math.min(100, value));
}

/** 표시 칸이 바뀌었는가 — 표시했던 문자열과 입력 문자열을 비교한다. */
export function langFieldTouched(shown: string | undefined, input: string): boolean {
  return shown !== undefined && shown !== input;
}

/**
 * 언어 배열 한 칸(또는 대표면 7칸)에 값을 반영한 새 배열을 돌려준다.
 * `langIndex` 0 = 대표, 1..7 = 한글/영문/한자/일어/외국어/기호/사용자.
 */
export function applyLangArrayEdit(
  current: readonly number[] | undefined,
  key: LangArrayKey,
  langIndex: number,
  value: number,
): number[] {
  if (langIndex <= 0) return Array(CHAR_SHAPE_LANG_COUNT).fill(value) as number[];
  const next = current && current.length === CHAR_SHAPE_LANG_COUNT
    ? [...current]
    : Array(CHAR_SHAPE_LANG_COUNT).fill(LANG_ARRAY_DEFAULTS[key]) as number[];
  next[langIndex - 1] = value;
  return next;
}

/** 언어별 글꼴 이름 편집 — 대표는 7칸 모두, 특정 언어는 그 칸만. */
export function applyLangFontEdit(
  edits: readonly (string | undefined)[],
  langIndex: number,
  name: string,
): (string | undefined)[] {
  if (langIndex <= 0) return Array(CHAR_SHAPE_LANG_COUNT).fill(name) as string[];
  const next = Array.from({ length: CHAR_SHAPE_LANG_COUNT }, (_, i) => edits[i]);
  next[langIndex - 1] = name;
  return next;
}

export type CharShapeFontChange =
  | { kind: 'none' }
  | { kind: 'all'; name: string }
  | { kind: 'perLanguage'; names: string[] };

/**
 * 글꼴 편집을 적용 방식으로 바꾼다.
 * 7칸 모두 같은 이름이면 기존 `fontName`(전 언어) 경로, 일부 언어만 바뀌면
 * 나머지 칸은 원래 글꼴 이름을 유지한 언어별 목록을 만든다.
 */
export function resolveCharShapeFontChange(
  edits: readonly (string | undefined)[],
  originalFamilies: readonly string[] | undefined,
): CharShapeFontChange {
  const original = originalFamilies ?? [];
  const changed = edits.some((name, i) => name !== undefined && name !== (original[i] ?? ''));
  if (!changed) return { kind: 'none' };
  const first = edits[0];
  if (first !== undefined && edits.length === CHAR_SHAPE_LANG_COUNT
    && edits.every(name => name === first)) {
    return { kind: 'all', name: first };
  }
  const names = Array.from({ length: CHAR_SHAPE_LANG_COUNT }, (_, i) =>
    edits[i] ?? original[i] ?? original[0] ?? '');
  return { kind: 'perLanguage', names };
}

/** 두 언어 배열이 같은 값인가 */
export function sameLangArray(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((value, i) => value === right[i]);
}
