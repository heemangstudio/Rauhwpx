import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultShortcuts, matchShortcut, type ShortcutDef } from '../src/command/shortcut-map.ts';
import {
  bindingFromKeyboardEvent,
  bindingIdFromLabel,
  bindingIdOf,
  bindingToShortcutDef,
  configurableCommandIds,
  formatBindingLabel,
  LOCKED_SHORTCUT_COMMANDS,
  parseBindingId,
  reservedReason,
  shortcutCategoryOf,
  SHORTCUT_EXTRA_COMMANDS,
} from '../src/command/shortcut-bindings.ts';
import { chordLabelsFor } from '../src/command/chord-map.ts';
import { shortcutToAccelerator } from '../src/desktop-native-menu.ts';
import { formatShortcutLabel } from '../src/engine/navigation-keymap.ts';

function key(input: Partial<KeyboardEvent> & { keyCode?: number; isComposing?: boolean; altGraph?: boolean }): KeyboardEvent {
  return {
    key: input.key ?? '',
    code: input.code ?? '',
    shiftKey: input.shiftKey ?? false,
    ctrlKey: input.ctrlKey ?? false,
    metaKey: input.metaKey ?? false,
    altKey: input.altKey ?? false,
    keyCode: input.keyCode ?? 0,
    isComposing: input.isComposing ?? false,
    getModifierState: (modifier: string) => modifier === 'AltGraph' && Boolean(input.altGraph),
  } as unknown as KeyboardEvent;
}

test('바인딩 ID 는 수정자 순서를 맞추고 허용하지 않는 키를 버린다', () => {
  assert.equal(parseBindingId('shift+mod+B'), 'mod+shift+b');
  assert.equal(parseBindingId(' alt+F10 '), 'alt+f10');
  assert.equal(parseBindingId('mod+='), 'mod+=');
  assert.equal(parseBindingId('mod++'), 'mod++');
  // US 배열의 Shift+= 는 `+` 글리프로 들어온다 — 같은 ID 로 모은다.
  assert.equal(parseBindingId('mod+shift++'), 'mod+shift+=');
  // 수정자 없이(또는 Shift 만으로) 쓸 수 있는 키는 F1~F12 뿐 — 글자 입력을 가로채지 않는다.
  assert.equal(parseBindingId('f8'), 'f8');
  assert.equal(parseBindingId('shift+f8'), 'shift+f8');
  for (const bad of ['', 'ctrl+b', 'mod+mod+b', 'mod+arrowleft', 'mod+space', 'mod+tab', 'mod+f13', 'mod+',
    'a', 'q', 'shift+q', '+', '=', '1', 'shift+1', 'enter', 'delete', 42, null, {}]) {
    assert.equal(parseBindingId(bad), null, String(bad));
  }
});

test('기본 표의 자모·물리 키 쌍둥이는 영문 바인딩 하나로 모인다', () => {
  assert.equal(bindingIdOf({ key: 'b', code: 'KeyB', alt: true, shift: true }), 'alt+shift+b');
  assert.equal(bindingIdOf({ key: 'ㅠ', alt: true, shift: true }), 'alt+shift+b');
  assert.equal(bindingIdOf({ key: 'ㄴ', ctrl: true, shift: true }), 'mod+shift+s');
  assert.equal(bindingIdOf({ key: 'ㅃ', ctrl: true, shift: true }), 'mod+shift+q');
  assert.equal(bindingIdOf({ key: 'f6' }), 'f6');
  assert.equal(bindingIdOf({ key: 'enter', ctrl: true, alt: true }), 'mod+alt+enter');

  // 모든 자모 행은 같은 명령의 영문 행과 같은 ID 다 — 자모 행만 따로 남는 바인딩이 없다.
  // 예외: 글자 모양의 Alt+ㄹ 행은 두벌식에서 F 자리라 영문 Alt+L 의 쌍둥이가 아니다(한글 IME Alt+F 로만 동작).
  // 기본 동작을 바꾸지 않으려고 표는 그대로 두고, 그 행은 별도 바인딩 alt+f 로 드러낸다. 새 예외는 여기서 걸린다.
  const knownStrayJamo = new Set(['format:char-shape alt+f']);
  const latinIds = new Set(defaultShortcuts
    .filter(([def]) => /^[a-z]$/.test(def.key))
    .map(([def, cmd]) => `${cmd} ${bindingIdOf(def)}`));
  const stray: string[] = [];
  for (const [def, cmd] of defaultShortcuts) {
    const id = bindingIdOf(def);
    assert.ok(id, `기본 행 ${JSON.stringify(def)} 의 바인딩 ID`);
    if (/^[ㄱ-ㅣ]$/.test(def.key) && !latinIds.has(`${cmd} ${id}`)) stray.push(`${cmd} ${id}`);
  }
  assert.deepEqual(stray, [...knownStrayJamo]);
});

test('사용자 바인딩은 영문·한글 IME·Process·macOS Option 입력에서 모두 맞는다', () => {
  const table: [ShortcutDef, string][] = [
    [bindingToShortcutDef('mod+shift+b')!, 'x:bold'],
    [bindingToShortcutDef('alt+=')!, 'x:equal'],
    [bindingToShortcutDef('mod+1')!, 'x:digit'],
  ];
  const match = (input: Partial<KeyboardEvent>, platform: 'mac' | 'other' = 'other') => matchShortcut(key(input), table, platform);
  assert.equal(match({ key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true }), 'x:bold');
  assert.equal(match({ key: 'ㅠ', code: 'KeyB', ctrlKey: true, shiftKey: true }), 'x:bold');
  assert.equal(match({ key: 'Process', code: 'KeyB', ctrlKey: true, shiftKey: true }), 'x:bold');
  assert.equal(match({ key: 'b', code: 'KeyB', metaKey: true, shiftKey: true }, 'mac'), 'x:bold');
  assert.equal(match({ key: '=', code: 'Equal', altKey: true }), 'x:equal');
  assert.equal(match({ key: '≠', code: 'Equal', altKey: true }, 'mac'), 'x:equal');
  assert.equal(match({ key: '1', code: 'Digit1', ctrlKey: true }), 'x:digit');
  // 수정자가 다르면 맞지 않는다.
  assert.equal(match({ key: 'b', code: 'KeyB', ctrlKey: true }), null);
  assert.equal(match({ key: 'B', code: 'KeyB', shiftKey: true }), null);
});

test('바인딩 표기는 Electron accelerator 로 바꿀 수 있다', () => {
  const samples: Array<[string, string, string]> = [
    ['mod+shift+b', 'Ctrl+Shift+B', 'CmdOrCtrl+Shift+B'],
    ['mod+alt+a', 'Ctrl+Alt+A', 'CmdOrCtrl+Alt+A'],
    ['mod+1', 'Ctrl+1', 'CmdOrCtrl+1'],
    ['mod+=', 'Ctrl+=', 'CmdOrCtrl+='],
    ['alt+\\', 'Alt+\\', 'Alt+\\'],
    ['mod+`', 'Ctrl+`', 'CmdOrCtrl+`'],
    ['mod++', 'Ctrl++', 'CmdOrCtrl+Plus'],
    ['f6', 'F6', 'F6'],
    ['alt+f10', 'Alt+F10', 'Alt+F10'],
    ['mod+enter', 'Ctrl+Enter', 'CmdOrCtrl+Enter'],
    ['alt+delete', 'Alt+Delete', 'Alt+Delete'],
    ['mod+alt+insert', 'Ctrl+Alt+Insert', 'CmdOrCtrl+Alt+Insert'],
  ];
  for (const [id, label, accelerator] of samples) {
    assert.equal(formatBindingLabel(id), label, id);
    assert.equal(shortcutToAccelerator(formatBindingLabel(id)), accelerator, id);
  }
});

test('부호 키 바인딩은 다른 배열에서 영문 글자가 들어온 키를 가로채지 않는다', () => {
  const table: [ShortcutDef, string][] = [
    ...defaultShortcuts,
    [bindingToShortcutDef('mod+.')!, 'x:period'],
    [bindingToShortcutDef('mod+;')!, 'x:semicolon'],
    [bindingToShortcutDef('alt+=')!, 'x:equal'],
  ];
  const match = (input: Partial<KeyboardEvent>, platform: 'mac' | 'other' = 'other') => matchShortcut(key(input), table, platform);
  // Dvorak: Ctrl+V 는 key 'v', code Period. 붙이기가 그대로 브라우저에 가야 한다.
  assert.equal(match({ key: 'v', code: 'Period', ctrlKey: true }), null);
  assert.equal(match({ key: 'V', code: 'Period', ctrlKey: true, shiftKey: true }), null);
  // AZERTY: Ctrl+M 은 key 'm', code Semicolon. 연속 키 첫 키로 남아야 한다.
  assert.equal(match({ key: 'm', code: 'Semicolon', ctrlKey: true }), null);
  // 글리프가 맞으면 어느 배열에서나, 글자가 아닌 글리프면 물리 키로 맞는다.
  assert.equal(match({ key: '.', code: 'KeyE', ctrlKey: true }), 'x:period');
  assert.equal(match({ key: '.', code: 'Period', ctrlKey: true }), 'x:period');
  assert.equal(match({ key: 'ю', code: 'Period', ctrlKey: true }), 'x:period');
  assert.equal(match({ key: '≠', code: 'Equal', altKey: true }, 'mac'), 'x:equal');
});

test('키 표기를 바인딩 ID 로 읽는다', () => {
  assert.equal(bindingIdFromLabel('Ctrl+Shift+B'), 'mod+shift+b');
  assert.equal(bindingIdFromLabel('ctrl+s'), 'mod+s');
  assert.equal(bindingIdFromLabel('ctrls'), 'mod+s');
  assert.equal(bindingIdFromLabel('Ctrl S'), 'mod+s');
  assert.equal(bindingIdFromLabel('⇧⌘B'), 'mod+shift+b');
  assert.equal(bindingIdFromLabel('⌥⌘A'), 'mod+alt+a');
  assert.equal(bindingIdFromLabel('Alt+F4'), 'alt+f4');
  assert.equal(bindingIdFromLabel('F6'), 'f6');
  assert.equal(bindingIdFromLabel('Ctrl++'), 'mod++');
  assert.equal(bindingIdFromLabel('Ctrl+,'), 'mod+,');
  assert.equal(bindingIdFromLabel('⌘+'), 'mod++');
  for (const partial of ['ctrl', 'ctrl+', 'ctrl+sh', 'ctrl+shift', 'b', 'shift+b', '굵게', '']) {
    assert.equal(bindingIdFromLabel(partial), null, partial);
  }
});

test('쉼표 키 표기는 macOS 에서도 연속 키로 잘리지 않는다', () => {
  assert.equal(formatShortcutLabel(formatBindingLabel('mod+,'), 'mac'), '⌘,');
  assert.equal(formatShortcutLabel(formatBindingLabel('mod+shift+,'), 'mac'), '⇧⌘,');
  assert.equal(formatShortcutLabel(formatBindingLabel('alt+,'), 'mac'), '⌥,');
  assert.equal(formatShortcutLabel('Ctrl+M,K', 'mac'), '⌘M,K');
  assert.equal(formatShortcutLabel('Alt+V,T', 'mac'), '⌥V,T');
  assert.equal(formatShortcutLabel('Ctrl+,', 'other'), 'Ctrl+,');
  assert.equal(shortcutToAccelerator(formatShortcutLabel(formatBindingLabel('mod+,'), 'mac')), 'CmdOrCtrl+,');
});

test('기록기는 한글 IME·keyCode 229·Option 입력을 물리 키로 읽는다', () => {
  assert.deepEqual(bindingFromKeyboardEvent(key({ key: 'ㅠ', code: 'KeyB', ctrlKey: true }), 'other'), { kind: 'binding', id: 'mod+b' });
  assert.deepEqual(bindingFromKeyboardEvent(key({ key: 'b', code: 'KeyB', ctrlKey: true, keyCode: 229 }), 'other'), { kind: 'binding', id: 'mod+b' });
  assert.deepEqual(bindingFromKeyboardEvent(key({ key: 'Process', code: 'KeyB', ctrlKey: true, shiftKey: true }), 'other'), { kind: 'binding', id: 'mod+shift+b' });
  assert.deepEqual(bindingFromKeyboardEvent(key({ key: '∫', code: 'KeyB', altKey: true }), 'mac'), { kind: 'binding', id: 'alt+b' });
  assert.deepEqual(bindingFromKeyboardEvent(key({ key: 'b', code: 'KeyB', metaKey: true }), 'mac'), { kind: 'binding', id: 'mod+b' });
  // Shift 를 누른 부호는 글리프 대신 물리 키로 적는다.
  assert.deepEqual(bindingFromKeyboardEvent(key({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }), 'other'), { kind: 'binding', id: 'mod+shift+=' });
  assert.deepEqual(bindingFromKeyboardEvent(key({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }), 'other'), { kind: 'binding', id: 'mod+shift+1' });
  assert.deepEqual(bindingFromKeyboardEvent(key({ key: 'F8', code: 'F8' }), 'other'), { kind: 'binding', id: 'f8' });
});

test('기록기는 수정자만·수정자 없는 키·취소·지우기·조합 중 입력을 가른다', () => {
  const pending = bindingFromKeyboardEvent(key({ key: 'Control', code: 'ControlLeft', ctrlKey: true, shiftKey: true }), 'other');
  assert.deepEqual(pending, { kind: 'pending', preview: 'Ctrl+Shift+…' });
  assert.deepEqual(bindingFromKeyboardEvent(key({ key: 'Meta', code: 'MetaLeft', metaKey: true }), 'mac'), { kind: 'pending', preview: '⌘…' });
  assert.equal(bindingFromKeyboardEvent(key({ key: 'b', code: 'KeyB' }), 'other').kind, 'error');
  assert.equal(bindingFromKeyboardEvent(key({ key: 'B', code: 'KeyB', shiftKey: true }), 'other').kind, 'error');
  assert.equal(bindingFromKeyboardEvent(key({ key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true }), 'other').kind, 'error');
  assert.equal(bindingFromKeyboardEvent(key({ key: ' ', code: 'Space', ctrlKey: true }), 'other').kind, 'error');
  assert.deepEqual(bindingFromKeyboardEvent(key({ key: 'Escape', code: 'Escape' }), 'other'), { kind: 'cancel' });
  assert.deepEqual(bindingFromKeyboardEvent(key({ key: 'Backspace', code: 'Backspace' }), 'other'), { kind: 'clear' });
  assert.deepEqual(bindingFromKeyboardEvent(key({ key: 'Delete', code: 'Delete' }), 'other'), { kind: 'clear' });
  assert.deepEqual(bindingFromKeyboardEvent(key({ key: 'ㅠ', code: 'KeyB', ctrlKey: true, isComposing: true }), 'other'), { kind: 'ignore' });
});

test('기록기는 macOS Ctrl+Cmd 와 AltGr 조합을 거절한다', () => {
  const ctrlMeta = bindingFromKeyboardEvent(key({ key: 'b', code: 'KeyB', ctrlKey: true, metaKey: true }), 'mac');
  assert.equal(ctrlMeta.kind, 'error');
  assert.match((ctrlMeta as { message: string }).message, /Control과 Command/);
  assert.equal(bindingFromKeyboardEvent(key({ key: 'ą', code: 'KeyA', ctrlKey: true, altKey: true, altGraph: true }), 'other').kind, 'error');
  assert.equal(bindingFromKeyboardEvent(key({ key: 'AltGraph', code: 'AltRight' }), 'other').kind, 'error');
});

test('예약 키는 편집기·브라우저 사유를 알려 준다', () => {
  assert.match(reservedReason('mod+c', 'other') ?? '', /^Ctrl\+C는 편집기가 직접 쓰는 키입니다\.$/);
  assert.match(reservedReason('mod+k', 'mac') ?? '', /^⌘K는 편집기가/);
  assert.match(reservedReason('mod+n', 'other') ?? '', /^Ctrl\+N는 편집기가 직접 쓰는 키입니다\.$/);
  assert.match(reservedReason('mod+t', 'other') ?? '', /브라우저나 운영체제가 먼저/);
  assert.match(reservedReason('mod+h', 'mac') ?? '', /브라우저나 운영체제가 먼저/);
  assert.equal(reservedReason('mod+h', 'other'), null);
  assert.equal(reservedReason('mod+shift+b', 'other'), null);
  // 단축키 표보다 먼저 도는 처리기가 가져가는 키 — 표 밖 Alt+Delete 단어 지우기, 셀 안 Ctrl+[ / ] 수준 바꾸기.
  for (const id of ['alt+delete', 'alt+shift+delete', 'mod+[', 'mod+]']) {
    assert.match(reservedReason(id, 'other') ?? '', /편집기가 직접 쓰는 키/, id);
  }
});

test('설정에 보일 명령은 기본 표·연속 키·추가 명령·고정 명령을 한 번씩 담는다', () => {
  const ids = configurableCommandIds();
  assert.equal(new Set(ids).size, ids.length);
  for (const [, cmd] of defaultShortcuts) assert.ok(ids.includes(cmd), cmd);
  for (const cmd of SHORTCUT_EXTRA_COMMANDS) assert.ok(ids.includes(cmd), cmd);
  for (const cmd of LOCKED_SHORTCUT_COMMANDS.keys()) assert.ok(ids.includes(cmd), cmd);
  assert.ok(ids.includes('insert:footnote'));
  assert.ok(ids.includes('view:border-transparent'));
  // 매개변수가 필요한 글자 색 연속 키는 뺀다.
  assert.ok(!ids.includes('format:text-color'));
  assert.ok(!ids.includes('table:block-sum'), 'Ctrl+Shift+S 죽은 행은 표에서 빠졌다');
});

test('연속 키 표기와 분류', () => {
  assert.deepEqual(chordLabelsFor('insert:footnote'), ['Ctrl+M,N']);
  assert.deepEqual(chordLabelsFor('insert:equation'), ['Ctrl+N,M']);
  assert.deepEqual(chordLabelsFor('view:zoom-100'), ['Ctrl+G,Q']);
  assert.deepEqual(chordLabelsFor('view:border-transparent'), ['Alt+V,T']);
  assert.deepEqual(chordLabelsFor('format:bold'), []);
  assert.equal(shortcutCategoryOf('field:edit'), 'edit');
  assert.equal(shortcutCategoryOf('hyperlink:open'), 'insert');
  assert.equal(shortcutCategoryOf('tool:spell'), 'tool');
  assert.equal(shortcutCategoryOf('help:report-issue'), 'help');
});
