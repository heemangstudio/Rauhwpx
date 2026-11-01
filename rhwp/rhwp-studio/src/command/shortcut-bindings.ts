/**
 * 단축키 바인딩 ID — 사용자 지정 단축키를 저장하고 비교하는 플랫폼 중립 표기.
 *
 * 형식은 `[mod+][alt+][shift+]<키>` 이다. `mod` 는 Windows/Linux 의 Ctrl, macOS 의 Cmd 이며
 * ShortcutDef.ctrl("Ctrl 또는 Meta")과 같은 뜻이다. 글자 키는 영문 소문자로 적는다 —
 * 한글 IME 상태(자모·Process)와 macOS Option 변환은 matchShortcut 의 물리 키(code) 단계가 맞춘다.
 *
 * 이 파일은 DOM·저장소에 기대지 않는 순수 함수만 둔다.
 */

import { defaultShortcuts, type ShortcutDef } from './shortcut-map.ts';
import { chordCommandIds } from './chord-map.ts';
import { formatShortcutLabel, type PlatformKind } from '../engine/navigation-keymap.ts';

export type BindingId = string;

export type ShortcutCategory = 'file' | 'edit' | 'view' | 'insert' | 'format' | 'page' | 'table' | 'tool' | 'help';

export interface ShortcutCommandInfo {
  id: string;
  label: string;
  category: ShortcutCategory;
  /** 바꿀 수 없는 명령이면 그 사유 */
  locked?: string;
  /** 연속 키 표기 (바꿀 수 없음) */
  fixed: string[];
}

export const SHORTCUT_CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  file: '파일',
  edit: '편집',
  view: '보기',
  insert: '입력',
  format: '서식',
  page: '쪽',
  table: '표',
  tool: '도구',
  help: '도움말',
};

const LOCKED_REASON = '앱 메뉴가 쓰는 키라 바꿀 수 없습니다.';

/**
 * 바꿀 수 없는 명령. 네이티브 메뉴 accelerator(되돌리기·다시 실행·모두 선택), 클립보드 이벤트
 * (오려두기·복사·붙이기), 자체 처리기가 있는 문제 보고. 사용자 지정은 런타임에서 무시한다.
 */
export const LOCKED_SHORTCUT_COMMANDS: ReadonlyMap<string, string> = new Map([
  ['edit:undo', LOCKED_REASON],
  ['edit:redo', LOCKED_REASON],
  ['edit:select-all', LOCKED_REASON],
  ['edit:cut', LOCKED_REASON],
  ['edit:copy', LOCKED_REASON],
  ['edit:paste', LOCKED_REASON],
  ['help:report-issue', LOCKED_REASON],
]);

/** 기본 키는 없지만 매개변수 없이 실행되어 단축키를 걸 만한 명령 */
export const SHORTCUT_EXTRA_COMMANDS: readonly string[] = [
  'format:strikethrough',
  'edit:format-paste',
  'format:normal-shape',
  'file:save-as-hwpx',
  'file:print-to-pdf',
  'insert:image',
  'insert:textbox',
  'insert:shape',
  'table:create',
  'view:form-mode',
  'view:toggle-grid',
  'format:align-split',
];

/** 두벌식 자모 → 같은 자리의 영문 소문자 (Shift 쌍자음·이중모음 포함) */
const JAMO_TO_LATIN: Record<string, string> = {
  ㅂ: 'q', ㅈ: 'w', ㄷ: 'e', ㄱ: 'r', ㅅ: 't', ㅛ: 'y', ㅕ: 'u', ㅑ: 'i', ㅐ: 'o', ㅔ: 'p',
  ㅁ: 'a', ㄴ: 's', ㅇ: 'd', ㄹ: 'f', ㅎ: 'g', ㅗ: 'h', ㅓ: 'j', ㅏ: 'k', ㅣ: 'l',
  ㅋ: 'z', ㅌ: 'x', ㅊ: 'c', ㅍ: 'v', ㅠ: 'b', ㅜ: 'n', ㅡ: 'm',
  ㅃ: 'q', ㅉ: 'w', ㄸ: 'e', ㄲ: 'r', ㅆ: 't', ㅒ: 'o', ㅖ: 'p',
};

/** 숫자·문장 부호 키 → 물리 키 code. macOS Option 변환(≠ 등)도 이 code 로 맞춘다. */
const PUNCTUATION_CODES: Record<string, string> = {
  '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', ';': 'Semicolon',
  "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash', '`': 'Backquote',
};
const CODE_TO_PUNCTUATION: Record<string, string> = Object.fromEntries(
  Object.entries(PUNCTUATION_CODES).map(([key, code]) => [code, key]),
);

const NAMED_KEYS = new Set(['enter', 'delete', 'insert']);
const NAMED_KEY_LABELS: Record<string, string> = { enter: 'Enter', delete: 'Delete', insert: 'Insert' };

function isFunctionKey(key: string): boolean {
  return /^f([1-9]|1[0-2])$/.test(key);
}

function isAllowedKey(key: string): boolean {
  return /^[a-z0-9]$/.test(key)
    || key in PUNCTUATION_CODES
    || key === '+'
    || isFunctionKey(key)
    || NAMED_KEYS.has(key);
}

interface BindingParts { mod: boolean; alt: boolean; shift: boolean; key: string }

function joinBinding({ mod, alt, shift, key }: BindingParts): BindingId {
  return `${mod ? 'mod+' : ''}${alt ? 'alt+' : ''}${shift ? 'shift+' : ''}${key}`;
}

function splitBinding(id: string): BindingParts | null {
  let rest = id;
  const parts: BindingParts = { mod: false, alt: false, shift: false, key: '' };
  for (;;) {
    const match = /^(mod|alt|shift)\+(?=.)/.exec(rest);
    if (!match) break;
    const name = match[1] as 'mod' | 'alt' | 'shift';
    if (parts[name]) return null;
    parts[name] = true;
    rest = rest.slice(match[0].length);
  }
  parts.key = rest;
  return parts;
}

/**
 * 저장소나 사용자 입력에서 온 값을 바인딩 ID 로 검증하고 수정자 순서를 맞춘다.
 * 허용하지 않는 키·중복 수정자·빈 값은 null.
 */
export function parseBindingId(raw: unknown): BindingId | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().toLowerCase();
  if (!text || text.length > 32) return null;
  // 수정자는 순서와 상관없이 받아 정규 순서로 다시 적는다.
  const tokens = text === '+' ? ['+']
    : text.endsWith('++') ? [...text.slice(0, -2).split('+'), '+']
    : text.split('+');
  const parts: BindingParts = { mod: false, alt: false, shift: false, key: '' };
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const name = tokens[i];
    if (name !== 'mod' && name !== 'alt' && name !== 'shift') return null;
    if (parts[name]) return null;
    parts[name] = true;
  }
  parts.key = tokens[tokens.length - 1] ?? '';
  // Shift+= 는 US 배열에서 `+` 글리프로 들어온다. 기본 표의 Shift `+` 행과 같은 ID 로 맞춘다.
  if (parts.key === '+' && parts.shift) parts.key = '=';
  if (!isAllowedKey(parts.key)) return null;
  // 기록기와 같은 규칙 — Ctrl·Alt 없이(Shift 만 있어도) 쓸 수 있는 키는 F1~F12 뿐이다.
  // 손으로 고친 저장값의 'a'·'shift+q' 가 글자 입력을 가로채지 않게 한다.
  if (!parts.mod && !parts.alt && !isFunctionKey(parts.key)) return null;
  return joinBinding(parts);
}

/**
 * 기본 단축키 행(ShortcutDef)의 바인딩 ID. 자모 행과 물리 키 code 행은 영문 쌍둥이와 같은 ID 로 모인다.
 * Shift 를 누른 `+` 행은 US 배열의 Shift+= 와 같은 ID(`shift+=`)로 적어, 기록기가 code 로 읽은 값과 맞춘다.
 */
export function bindingIdOf(def: ShortcutDef): BindingId | null {
  let key = def.key.toLowerCase();
  if (JAMO_TO_LATIN[key]) key = JAMO_TO_LATIN[key];
  else if (def.code && /^Key[A-Z]$/.test(def.code) && !/^[a-z]$/.test(key)) key = def.code.slice(3).toLowerCase();
  if (key === '+' && def.shift) key = '=';
  if (!isAllowedKey(key)) return null;
  return joinBinding({ mod: !!def.ctrl, alt: !!def.alt, shift: !!def.shift, key });
}

/** 사용자 바인딩 ID → 매칭용 ShortcutDef. 글자는 code 없이(matchShortcut 이 KeyX 를 만든다), 숫자·부호는 code 를 함께. */
export function bindingToShortcutDef(id: BindingId): ShortcutDef | null {
  const canonical = parseBindingId(id);
  if (!canonical) return null;
  const parts = splitBinding(canonical);
  if (!parts) return null;
  const def: ShortcutDef = { key: parts.key };
  if (/^[0-9]$/.test(parts.key)) def.code = `Digit${parts.key}`;
  else if (PUNCTUATION_CODES[parts.key]) def.code = PUNCTUATION_CODES[parts.key];
  if (parts.mod) def.ctrl = true;
  if (parts.shift) def.shift = true;
  if (parts.alt) def.alt = true;
  return def;
}

function keyLabel(key: string): string {
  return NAMED_KEY_LABELS[key] ?? key.toUpperCase();
}

/** 'mod+shift+b' → 'Ctrl+Shift+B'. 화면에는 formatShortcutLabel() 을 한 번 더 거쳐 보인다. */
export function formatBindingLabel(id: BindingId): string {
  const parts = splitBinding(id);
  if (!parts) return id;
  return [
    ...(parts.mod ? ['Ctrl'] : []),
    ...(parts.alt ? ['Alt'] : []),
    ...(parts.shift ? ['Shift'] : []),
    keyLabel(parts.key),
  ].join('+');
}

/** 표기의 수정자 이름·기호 → 바인딩 수정자. 긴 이름을 먼저 본다(control 이 ctrl 보다 앞). */
const LABEL_MODIFIERS: readonly [RegExp, 'mod' | 'alt' | 'shift'][] = [
  [/^(control|ctrl|command|cmd|meta|mod|⌘|⌃)/, 'mod'],
  [/^(option|opt|alt|⌥)/, 'alt'],
  [/^(shift|⇧)/, 'shift'],
];

/**
 * 사람이 적은 키 표기를 바인딩 ID 로 읽는다 — 'Ctrl+Shift+B'·'ctrl+b'·'ctrlb'·'⇧⌘B'·'Alt F4'.
 * 수정자 없이 쓸 수 없는 키('b')나 빈 키('ctrl+')는 null. 검색 칸의 키 표기를 정확히 맞추는 데 쓴다.
 */
export function bindingIdFromLabel(text: string): BindingId | null {
  let rest = text.trim().toLowerCase().replace(/\s+/g, '+');
  const parts: BindingParts = { mod: false, alt: false, shift: false, key: '' };
  for (let matched = true; matched;) {
    matched = false;
    for (const [pattern, name] of LABEL_MODIFIERS) {
      const match = pattern.exec(rest);
      // 수정자 뒤에 키가 남아야 한다 — 'ctrl+shift' 의 shift 는 키다(그래서 null).
      if (!match || rest.length === match[0].length) continue;
      parts[name] = true;
      rest = rest.slice(match[0].length);
      // 이름 뒤의 + 는 구분자다. 'ctrl+' 처럼 구분자로 끝나면 아직 키를 적지 않은 것이다.
      // 기호(⌘ 등) 뒤의 + 는 키 자체다(⌘+ = Cmd 와 +).
      if (/^[a-z]/.test(match[0]) && rest === '+') return null;
      if (rest.length > 1 && rest.startsWith('+')) rest = rest.slice(1);
      matched = true;
      break;
    }
  }
  parts.key = rest;
  return parseBindingId(joinBinding(parts));
}

export type RecordResult =
  | { kind: 'ignore' }
  | { kind: 'pending'; preview: string }
  | { kind: 'cancel' }
  | { kind: 'clear' }
  | { kind: 'binding'; id: BindingId }
  | { kind: 'error'; message: string };

const MODIFIER_KEYS = new Set(['control', 'shift', 'alt', 'meta', 'os', 'hyper', 'super']);
const IGNORED_KEYS = new Set(['capslock', 'fn', 'fnlock', 'numlock', 'scrolllock']);

export const SHORTCUT_ERROR_NEEDS_MODIFIER = 'Ctrl이나 Alt와 함께 누르세요. F1~F12는 혼자 써도 됩니다.';
export const SHORTCUT_ERROR_UNSUPPORTED = '이 키는 단축키로 쓸 수 없습니다.';
export const SHORTCUT_ERROR_CTRL_META = 'Control과 Command를 함께 쓰는 조합은 지원하지 않습니다.';

/** 물리 키 code → 바인딩 키. 매핑이 없으면 null. */
function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (CODE_TO_PUNCTUATION[code]) return CODE_TO_PUNCTUATION[code];
  if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase();
  if (code === 'Enter' || code === 'NumpadEnter') return 'enter';
  if (code === 'Delete') return 'delete';
  if (code === 'Insert') return 'insert';
  return null;
}

/**
 * 단축키 기록기 — 키 입력 하나를 바인딩 ID 로 바꾼다.
 * IME 조합 중(isComposing)은 무시하고, key 가 Process·자모·Option 기호이거나 keyCode 229 이면 code 로 읽는다.
 */
export function bindingFromKeyboardEvent(e: KeyboardEvent, platform: PlatformKind): RecordResult {
  if (e.isComposing) return { kind: 'ignore' };
  const rawKey = e.key ?? '';
  const lower = rawKey.toLowerCase();
  if (lower === 'altgraph' || e.getModifierState?.('AltGraph')) {
    return { kind: 'error', message: SHORTCUT_ERROR_UNSUPPORTED };
  }
  if (lower === 'escape' || lower === 'esc') return { kind: 'cancel' };

  if (platform === 'mac' && e.ctrlKey && e.metaKey) {
    return { kind: 'error', message: SHORTCUT_ERROR_CTRL_META };
  }
  const mod = e.ctrlKey || e.metaKey;
  const alt = e.altKey;
  const shift = e.shiftKey;

  if (IGNORED_KEYS.has(lower)) return { kind: 'ignore' };
  if (MODIFIER_KEYS.has(lower)) {
    const prefix = [...(mod ? ['Ctrl'] : []), ...(alt ? ['Alt'] : []), ...(shift ? ['Shift'] : [])];
    return { kind: 'pending', preview: formatShortcutLabel(`${prefix.map(name => `${name}+`).join('')}…`, platform) };
  }
  if (!mod && !alt && !shift && (lower === 'backspace' || lower === 'delete')) return { kind: 'clear' };

  let key: string | null = null;
  const fromCode = e.keyCode === 229 || rawKey === 'Process' || rawKey === 'Dead' || rawKey === 'Unidentified';
  if (!fromCode) {
    if (/^[a-z]$/.test(lower)) key = lower;
    else if (isFunctionKey(lower) || NAMED_KEYS.has(lower)) key = lower;
    // Shift 를 누른 숫자·부호 키는 글리프(!, + 등)가 배열마다 달라 물리 키로 읽는다.
    else if (!shift && (/^[0-9]$/.test(lower) || lower in PUNCTUATION_CODES || lower === '+')) key = lower;
  }
  if (!key) key = keyFromCode(e.code ?? '');
  if (!key) return { kind: 'error', message: SHORTCUT_ERROR_UNSUPPORTED };

  if (!isFunctionKey(key) && !mod && !alt) return { kind: 'error', message: SHORTCUT_ERROR_NEEDS_MODIFIER };
  return { kind: 'binding', id: joinBinding({ mod, alt, shift, key }) };
}

/**
 * 편집기가 직접 처리하는 키 (연속 키 첫 키·클립보드·찾기 등). 단축키 표보다 먼저 도는 처리기가 가져가므로
 * 다른 명령에 걸면 어떤 자리에서는 듣지 않는다.
 * - Alt+Delete·Alt+Shift+Delete: 표 밖에서는 다음 단어 지우기 (표 안의 줄/칸 지우기 기본 키는 그 명령만 되살린다).
 * - Ctrl+[ / Ctrl+]: 표 셀 안에서는 셀 문단 수준 바꾸기 (글꼴 크기 기본 키는 그 명령만 되살린다).
 */
const EDITOR_RESERVED = new Set([
  'mod+c', 'mod+x', 'mod+v', 'mod+shift+v', 'mod+k', 'mod+m', 'mod+n', 'mod+g', 'alt+v',
  'mod+/', 'mod+shift+/', 'f3', 'f5', 'mod+insert', 'shift+insert', 'shift+delete',
  'alt+delete', 'alt+shift+delete', 'mod+[', 'mod+]',
]);
/** 브라우저나 운영체제가 먼저 가져가는 키 */
const BROWSER_RESERVED = new Set([
  'mod+t', 'mod+w', 'mod+q', 'mod+r',
  'mod+shift+n', 'mod+shift+t', 'mod+shift+w', 'mod+shift+r', 'mod+shift+i', 'mod+shift+j', 'mod+shift+c',
  'f11', 'f12', 'alt+f4', 'mod+alt+delete',
]);
const MAC_BROWSER_RESERVED = new Set(['mod+h']);

/** 이 키를 단축키로 쓸 수 없는 이유. 쓸 수 있으면 null. */
export function reservedReason(id: BindingId, platform: PlatformKind): string | null {
  const label = formatShortcutLabel(formatBindingLabel(id), platform);
  if (EDITOR_RESERVED.has(id)) return `${label}는 편집기가 직접 쓰는 키입니다.`;
  if (BROWSER_RESERVED.has(id) || (platform === 'mac' && MAC_BROWSER_RESERVED.has(id))) {
    return `${label}는 브라우저나 운영체제가 먼저 가져가는 키입니다.`;
  }
  return null;
}

/** 명령 ID 접두사로 설정 화면의 분류를 정한다. field → 편집, hyperlink → 입력. */
export function shortcutCategoryOf(commandId: string): ShortcutCategory {
  const prefix = commandId.slice(0, commandId.indexOf(':'));
  switch (prefix) {
    case 'file': return 'file';
    case 'edit':
    case 'field': return 'edit';
    case 'view': return 'view';
    case 'insert':
    case 'hyperlink': return 'insert';
    case 'format': return 'format';
    case 'page': return 'page';
    case 'table': return 'table';
    case 'help': return 'help';
    default: return 'tool';
  }
}

/** 매개변수가 필요해 단축키로 실행할 수 없는 연속 키 명령 */
const CHORD_EXCLUDED = new Set(['format:text-color']);

/** 단축키 설정에 보일 명령 — 기본 표 ∪ 연속 키 ∪ 추가 명령 ∪ 고정 명령 (중복 없음). */
export function configurableCommandIds(): string[] {
  const ids = new Set<string>();
  for (const [, commandId] of defaultShortcuts) ids.add(commandId);
  for (const commandId of chordCommandIds()) if (!CHORD_EXCLUDED.has(commandId)) ids.add(commandId);
  for (const commandId of SHORTCUT_EXTRA_COMMANDS) ids.add(commandId);
  for (const commandId of LOCKED_SHORTCUT_COMMANDS.keys()) ids.add(commandId);
  return [...ids];
}
