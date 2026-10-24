/**
 * 토큰 사용량 표기와 눈금 — 화면 모듈은 CSS 를 들여오므로 숫자 규칙만 여기 두고 직접 검증한다.
 */

const UNITS = ['', 'K', 'M', 'B', 'T'] as const;

function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/** 77.9B, 1.27B, 461K, 980 — 유효숫자 세 자리. 반올림으로 1000 이 되면 다음 단위로 올린다. */
export function formatCompact(value: number): string {
  let n = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (n < 1000) return String(Math.round(n));
  let unit = 0;
  while (n >= 1000 && unit < UNITS.length - 1) {
    n /= 1000;
    unit += 1;
  }
  const digits = n >= 100 ? 0 : n >= 10 ? 1 : 2;
  let text = n.toFixed(digits);
  if (Number(text) >= 1000 && unit < UNITS.length - 1) {
    unit += 1;
    text = (Number(text) / 1000).toFixed(2);
  }
  return `${trimZeros(text)}${UNITS[unit]}`;
}

/** 0 부터 max 를 덮는 1·2·2.5·5 × 10ⁿ 간격 눈금. max 가 0 이면 [0, 1]. */
export function niceTicks(max: number, target = 4): number[] {
  if (!(max > 0) || !Number.isFinite(max)) return [0, 1];
  const raw = max / Math.max(1, target);
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
  const ticks: number[] = [];
  for (let i = 0; ticks.length === 0 || ticks[ticks.length - 1]! < max; i++) ticks.push(i * step);
  return ticks;
}

/** 'YYYY-MM-DD' → '7월 27일'. 형식이 다르면 그대로. */
export function formatDayLabel(date: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
  return match ? `${Number(match[1])}월 ${Number(match[2])}일` : date;
}
