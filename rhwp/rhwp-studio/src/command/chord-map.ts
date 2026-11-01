/**
 * 연속 키(chord) 단축키 표 — Ctrl+K,? / Ctrl+M,? / Ctrl+N,? / Alt+V,? / Ctrl+G,?
 *
 * 입력 처리기(input-handler-keyboard.ts)가 두 번째 키를 이 표로 찾고, 단축키 설정은
 * 같은 표로 고정 단축키 이름(Ctrl+M,N)을 보인다. 이 기본 연속 키는 사용자가 바꾸지 못한다.
 * 사용자가 만드는 연속 키는 shortcut-sequence.ts 가 처리한다.
 */

/** 코드 단축키 → 커맨드 ID 매핑 (Ctrl+K,? 형태) */
export const chordMapK: Record<string, string> = {
  h: 'insert:hyperlink',
  ㅗ: 'insert:hyperlink', // 한글 IME 상태
  b: 'insert:bookmark',
  ㅠ: 'insert:bookmark', // 한글 IME 상태
  n: 'format:para-num-shape',
  ㅜ: 'format:para-num-shape', // 한글 IME 상태
};

/** 코드 단축키 → 커맨드 ID 매핑 (Ctrl+M,? 형태)
 *
 * 한컴 표준은 Ctrl+N으로 chord를 시작하지만 Chrome에서 reserved shortcut
 * (새 창)이라 JS로 차단 불가하여 Ctrl+M으로 변경 (PR #786 후속 정정).
 */
export const chordMapM: Record<string, string | [string, Record<string, unknown>]> = {
  n: 'insert:footnote',
  ㅜ: 'insert:footnote', // 한글 IME
  e: 'insert:endnote',
  ㄷ: 'insert:endnote', // 한글 IME
  s: 'page:hide',
  ㄴ: 'page:hide', // 한글 IME
  // 글자 색 chord (한컴 Ctrl+M,? 정합 — 검정/빨강/파랑/자주/초록/노랑/청록/흰색)
  k: ['format:text-color', { color: '#000000' }],
  ㅏ: ['format:text-color', { color: '#000000' }], // 한글 IME
  r: ['format:text-color', { color: '#FF0000' }],
  ㄱ: ['format:text-color', { color: '#FF0000' }], // 한글 IME
  b: ['format:text-color', { color: '#0000FF' }],
  ㅠ: ['format:text-color', { color: '#0000FF' }], // 한글 IME
  d: ['format:text-color', { color: '#800080' }],
  ㅇ: ['format:text-color', { color: '#800080' }], // 한글 IME
  g: ['format:text-color', { color: '#008000' }],
  ㅎ: ['format:text-color', { color: '#008000' }], // 한글 IME
  y: ['format:text-color', { color: '#FFFF00' }],
  ㅛ: ['format:text-color', { color: '#FFFF00' }], // 한글 IME
  c: ['format:text-color', { color: '#008080' }],
  ㅊ: ['format:text-color', { color: '#008080' }], // 한글 IME
  w: ['format:text-color', { color: '#FFFFFF' }],
  ㅈ: ['format:text-color', { color: '#FFFFFF' }], // 한글 IME
};

/** 코드 단축키 → 커맨드 ID 매핑 (Ctrl+N,? 형태)
 *
 * 한컴과 같은 Ctrl+N,M 수식. 데스크톱 앱(Electron)에는 Ctrl+N을 쓰는 메뉴가 없어
 * 편집기가 받는다. 일반 Chrome 탭에서는 브라우저가 새 창으로 가로챈다.
 */
export const chordMapN: Record<string, string> = {
  m: 'insert:equation',
  ㅡ: 'insert:equation', // 한글 IME
};

/** chordMapM 항목을 dispatch 한다 (색상 chord 는 params 동반). */
export function dispatchChordM(
  dispatcher: { dispatch: (id: string, params?: Record<string, unknown>) => boolean },
  entry: string | [string, Record<string, unknown>],
): void {
  if (Array.isArray(entry)) {
    dispatcher.dispatch(entry[0], entry[1]);
  } else {
    dispatcher.dispatch(entry);
  }
}

/** 코드 단축키 → 커맨드 ID 매핑 (Alt+V,? 형태 — 보기 메뉴) */
export const chordMapV: Record<string, string> = {
  t: 'view:border-transparent',
  ㅅ: 'view:border-transparent', // 한글 IME
};

/** 코드 단축키 → 커맨드 ID 매핑 (Ctrl+G,? 형태 — 보기/조판 메뉴) */
export const chordMapG: Record<string, string> = {
  c: 'view:ctrl-mark',        // 조판 부호
  ㅊ: 'view:ctrl-mark',       // 한글 IME
  t: 'view:para-mark',        // 문단 부호
  ㅅ: 'view:para-mark',       // 한글 IME
  p: 'view:zoom-fit-page',    // 쪽 맞춤
  ㅍ: 'view:zoom-fit-page',   // 한글 IME
  w: 'view:zoom-fit-width',   // 폭 맞춤
  ㅈ: 'view:zoom-fit-width',  // 한글 IME
  q: 'view:zoom-100',         // 100%
  ㅂ: 'view:zoom-100',        // 한글 IME
};

/** 첫 키 표기와 두 번째 키 표. 순서가 고정 단축키 표시 순서다. */
const CHORD_TABLES: ReadonlyArray<readonly [string, Record<string, string | [string, Record<string, unknown>]>]> = [
  ['Ctrl+K', chordMapK],
  ['Ctrl+M', chordMapM],
  ['Ctrl+N', chordMapN],
  ['Ctrl+G', chordMapG],
  ['Alt+V', chordMapV],
];

/** 기본 연속 키의 첫 키(바인딩 ID)와 두 번째 키 표. 사용자 연속 키가 기본 연속 키를 덮지 못하게 본다. */
export const CHORD_STARTER_TABLES: ReadonlyMap<string, Record<string, string | [string, Record<string, unknown>]>> = new Map([
  ['mod+k', chordMapK],
  ['mod+m', chordMapM],
  ['mod+n', chordMapN],
  ['mod+g', chordMapG],
  ['alt+v', chordMapV],
]);

function chordCommandId(entry: string | [string, Record<string, unknown>]): string {
  return Array.isArray(entry) ? entry[0] : entry;
}

/** 명령에 걸린 연속 키 표기 (예: ['Ctrl+M,N']). 한글 IME 쌍둥이는 영문 키 하나로 센다. */
export function chordLabelsFor(commandId: string): string[] {
  const labels: string[] = [];
  for (const [prefix, table] of CHORD_TABLES) {
    for (const [second, entry] of Object.entries(table)) {
      if (!/^[a-z]$/.test(second) || chordCommandId(entry) !== commandId) continue;
      labels.push(`${prefix},${second.toUpperCase()}`);
    }
  }
  return labels;
}

/** 연속 키로 실행되는 명령 ID 전체 (중복 없음, 표 순서). */
export function chordCommandIds(): string[] {
  const ids = new Set<string>();
  for (const [, table] of CHORD_TABLES) {
    for (const entry of Object.values(table)) ids.add(chordCommandId(entry));
  }
  return [...ids];
}
