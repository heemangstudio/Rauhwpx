/**
 * 번호 유형 코드와 글머리표(Bullet) 프리셋
 * 한컴 coreEngine.js 리소스 기준
 */

// ─────────────────────────────────────────────────
// 번호 유형 코드 (Numbering Type)
// ─────────────────────────────────────────────────

/** 번호 매기기 유형 코드 */
export const enum NumberingType {
  /** 1, 2, 3, 4 ... */
  ARABIC = 0,
  /** ①, ②, ③ ... */
  CIRCLED = 1,
  /** I, II, III, IV ... */
  ROMAN_UPPER = 2,
  /** i, ii, iii, iv ... */
  ROMAN_LOWER = 3,
  /** A, B, C, D ... */
  ALPHA_UPPER = 4,
  /** a, b, c, d ... */
  ALPHA_LOWER = 5,
  /** ㉮, ㉯, ㉰ ... */
  KOREAN_CIRCLED = 7,
  /** 가, 나, 다, 라 ... */
  KOREAN_ALPHA = 8,
  /** ①, ②, ③ ... (한국식) */
  KOREAN_CIRCLED_NUM = 9,
  /** ㄱ, ㄴ, ㄷ ... */
  KOREAN_CONSONANT = 10,
}

// ─────────────────────────────────────────────────
// 글머리표 (Bullet) 프리셋 — 22종
// ─────────────────────────────────────────────────

export interface BulletPreset {
  /** 프리셋 이름 */
  name: string;
  /** 글머리표 문자 (HWP 저장용, PUA 코드 포함) */
  char: string;
  /** 브라우저 표시용 Unicode 문자 */
  displayChar: string;
}

/** 글머리표 프리셋 18종 */
export const BULLET_PRESETS: BulletPreset[] = [
  // 일반 글머리표 1-18
  // char: HWP 저장용 (PUA), displayChar: 브라우저 표시용 (Unicode)
  { name: '●', char: '\uF06C', displayChar: '●' },
  { name: '•', char: '\uF09F', displayChar: '•' },
  { name: '■', char: '\uF06E', displayChar: '■' },
  { name: '▪', char: '\uF0A7', displayChar: '▪' },
  { name: '◆', char: '\uF075', displayChar: '◆' },
  { name: '⬥', char: '\uF077', displayChar: '⬥' },
  { name: '▶', char: '\u25B6', displayChar: '▶' },
  { name: '◯', char: '\u25EF', displayChar: '◯' },
  { name: '□', char: '\u25A1', displayChar: '□' },
  { name: '◇', char: '\u25C7', displayChar: '◇' },
  { name: '▷', char: '\u25B7', displayChar: '▷' },
  { name: '◉', char: '\uF0A4', displayChar: '◉' },
  { name: '☑', char: '\uF0FE', displayChar: '☑' },
  { name: '✓', char: '\uF0FC', displayChar: '✓' },
  { name: '★', char: '\uF0AB', displayChar: '★' },
  { name: '❖', char: '\uF076', displayChar: '❖' },
  { name: '☞', char: '\uF046', displayChar: '☞' },
  { name: '❍', char: '\u274D', displayChar: '❍' },
];
