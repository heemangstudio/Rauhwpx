/**
 * 문단 모양 대화상자의 단위 변환과 "고친 칸" 판정 (DOM 없음).
 *
 * 엔진은 여백·간격을 0.1px 로 반올림한 px 로 보고하고, 대화상자는 그것을 다시
 * 0.1pt 로 보여 준다. 이 값을 HWPUNIT 로 되돌려 원본과 비교하면 10pt(2000) 여백이
 * 1995 로 돌아와 늘 "바뀜"이 되고, 여러 문단을 선택해 정렬만 바꿔도 캐럿 문단의
 * 여백·들여쓰기·간격이 모든 문단에 찍힌다. 판정은 보여 준 문자열과 입력 문자열을
 * 같은 표시 정밀도로 비교해서 한다.
 */

/** px (96dpi, zoom=1) → pt */
export function pxToPt(px: number): number {
  return px * 72 / 96;
}

/** pt → raw HWPUNIT (2x 저장값) — 여백/들여쓰기 */
export function ptToRaw2x(pt: number): number {
  return Math.round(pt * 100 * 2);
}

/** pt → raw HWPUNIT (1x) — 문단 간격/줄 간격 */
export function ptToRaw(pt: number): number {
  return Math.round(pt * 100);
}

/** 대화상자가 px 값을 pt 칸에 채우는 서식 */
export function formatPtFromPx(px: number): string {
  return pxToPt(px).toFixed(1);
}

function normalizeDisplayed(value: string, digits: number): string {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  return trimmed !== '' && Number.isFinite(parsed) ? parsed.toFixed(digits) : trimmed;
}

/** 두 표시 문자열이 같은 값인가 ("10", "10.0", "10.00" 은 같다) */
export function sameDisplayedNumber(a: string, b: string, digits = 1): boolean {
  return normalizeDisplayed(a, digits) === normalizeDisplayed(b, digits);
}

/**
 * 사용자가 고친 칸이면 입력값을 raw 로 바꿔 돌려주고, 보여 준 값 그대로면 undefined.
 * `shown` 이 없으면(채우지 않은 칸) 고친 것으로 본다.
 */
export function changedRawValue(
  shown: string | undefined,
  input: string,
  toRaw: (value: number) => number,
  digits = 1,
): number | undefined {
  if (shown !== undefined && sameDisplayedNumber(shown, input, digits)) return undefined;
  return toRaw(parseFloat(input) || 0);
}
