/**
 * 한글을 자모 단위로 찾는 데 쓰는 순수 함수.
 *
 * 입력기는 글자를 조합하면서 'ㅅ → 새 → 샐 → 새로' 처럼 값을 바꾸므로, 음절이 아니라 자모로 견줘야
 * 치는 동안 결과가 끊기지 않는다.
 */

const CHOSEONG = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNGSEONG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const JONGSEONG = ['', ...'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ'];

/** 두 번 눌러 만드는 겹자모. 'ㄱㅗ' 를 친 순간 '과' 도 맞도록 풀어서 견준다. */
const COMPOUND_JAMO: Record<string, string> = {
  ㅘ: 'ㅗㅏ', ㅙ: 'ㅗㅐ', ㅚ: 'ㅗㅣ', ㅝ: 'ㅜㅓ', ㅞ: 'ㅜㅔ', ㅟ: 'ㅜㅣ', ㅢ: 'ㅡㅣ',
  ㄳ: 'ㄱㅅ', ㄵ: 'ㄴㅈ', ㄶ: 'ㄴㅎ', ㄺ: 'ㄹㄱ', ㄻ: 'ㄹㅁ', ㄼ: 'ㄹㅂ', ㄽ: 'ㄹㅅ', ㄾ: 'ㄹㅌ', ㄿ: 'ㄹㅍ', ㅀ: 'ㄹㅎ', ㅄ: 'ㅂㅅ',
};

const SYLLABLE_START = 0xac00;
const SYLLABLE_END = 0xd7a3;

function syllableIndex(char: string): number | null {
  const code = char.codePointAt(0) ?? 0;
  return code >= SYLLABLE_START && code <= SYLLABLE_END ? code - SYLLABLE_START : null;
}

/** '새로' → 'ㅅㅐㄹㅗ', '과' → 'ㄱㅗㅏ'. 한글이 아닌 글자는 그대로 둔다. */
export function decomposeHangul(text: string): string {
  let out = '';
  for (const char of text) {
    const index = syllableIndex(char);
    const jamo = index === null
      ? char
      : CHOSEONG[Math.floor(index / 588)] + JUNGSEONG[Math.floor(index / 28) % 21] + JONGSEONG[index % 28];
    for (const part of jamo) out += COMPOUND_JAMO[part] ?? part;
  }
  return out;
}

/** '새로만들기' → 'ㅅㄹㅁㄷㄱ'. 한글이 아닌 글자는 그대로 둔다. */
export function hangulInitials(text: string): string {
  let out = '';
  for (const char of text) {
    const index = syllableIndex(char);
    out += index === null ? char : CHOSEONG[Math.floor(index / 588)];
  }
  return out;
}

/** 'ㅅㄹ' 처럼 자음만 친 검색어인지 본다. */
export function isInitialsQuery(text: string): boolean {
  return /^[ㄱ-ㅎ]+$/.test(text);
}
