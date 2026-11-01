import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultShortcuts } from '../src/command/shortcut-map.ts';
import { createShortcutService } from '../src/command/effective-shortcuts.ts';
import {
  bindingFromKeyboardEvent,
  bindingToShortcutDef,
  formatBindingLabel,
  parseBindingId,
  reservedReason,
} from '../src/command/shortcut-bindings.ts';
import { createSequenceMatcher } from '../src/command/shortcut-sequence.ts';
import { shortcutToAccelerator } from '../src/desktop-native-menu.ts';
import { formatShortcutLabel } from '../src/engine/navigation-keymap.ts';

function press(key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    code: /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    getModifierState: () => false,
    ...mods,
  } as KeyboardEvent;
}

function matcher(ids: Record<string, string>) {
  let clock = 1000;
  const entries = Object.entries(ids);
  const seq = createSequenceMatcher(() => entries, { timeoutMs: 2000, now: () => clock });
  return { seq, wait: (ms: number) => { clock += ms; } };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test('연속 키 ID 는 둘째 단계부터 Ctrl·Cmd 를 떼고 맞춘다', () => {
  assert.equal(parseBindingId('MOD+K  mod+L shift+h'), 'mod+k l shift+h');
  assert.equal(parseBindingId('f9 a'), 'f9 a');
  for (const bad of ['k l', 'mod+k ,', 'mod+k enter', 'mod+k delete', 'mod+k a b c d', 'mod+k mod+']) {
    assert.equal(parseBindingId(bad), null, bad);
  }
  assert.equal(formatBindingLabel('mod+k l h'), 'Ctrl+K,L,H');
  assert.equal(formatShortcutLabel(formatBindingLabel('mod+k l h'), 'mac'), '⌘K,L,H');
  assert.equal(bindingToShortcutDef('mod+k l h'), null, '한 번의 키 입력 표에 들어가지 않는다');
  assert.equal(shortcutToAccelerator('Ctrl+K,L,H'), undefined, '네이티브 메뉴 accelerator 로 등록하지 않는다');
});

test('기록기는 둘째 단계를 수정자 없이 받고 Cmd 를 눌러도 같은 키로 읽는다', () => {
  assert.deepEqual(bindingFromKeyboardEvent(press('l'), 'mac', { continuation: true }), { kind: 'binding', id: 'l' });
  assert.deepEqual(bindingFromKeyboardEvent(press('l', { metaKey: true }), 'mac', { continuation: true }), { kind: 'binding', id: 'l' });
  assert.deepEqual(
    bindingFromKeyboardEvent(press('Process', { code: 'KeyL', keyCode: 229 }), 'mac', { continuation: true }),
    { kind: 'binding', id: 'l' },
    '한글 입력 상태',
  );
  assert.equal(bindingFromKeyboardEvent(press('l'), 'mac').kind, 'error', '첫 키는 여전히 수정자가 필요하다');
});

test('기본 연속 키의 첫 키로 시작할 수 있지만 기본 연속 키는 덮지 못한다', () => {
  assert.equal(reservedReason('mod+k l h', 'mac'), null);
  assert.match(reservedReason('mod+k h', 'mac') ?? '', /^⌘K,H는 기본 연속 키와 겹칩니다\.$/);
  assert.match(reservedReason('mod+k h x', 'other') ?? '', /기본 연속 키와 겹칩니다/);
  assert.match(reservedReason('mod+c l', 'other') ?? '', /Ctrl\+C는 편집기가 직접 쓰는 키입니다/);
  assert.match(reservedReason('mod+h l', 'mac') ?? '', /브라우저나 운영체제가 먼저/);
});

test('이어 누르면 명령이 실행되고, 첫 키는 기본 연속 키일 때만 편집기에 넘긴다', () => {
  const { seq } = matcher({ 'mod+k l h': 'format:bold', 'mod+j q': 'format:italic' });
  assert.deepEqual(seq.feed(press('k', { metaKey: true })), { kind: 'pending', consume: false });
  assert.deepEqual(seq.feed(press('Meta')), { kind: 'none' }, '수정자만 누르면 상태를 지우지 않는다');
  assert.deepEqual(seq.feed(press('l')), { kind: 'pending', consume: true });
  assert.deepEqual(seq.feed(press('h', { metaKey: true })), { kind: 'match', commandId: 'format:bold' }, 'Cmd 를 눌러도 같다');
  assert.deepEqual(seq.feed(press('h')), { kind: 'none' }, '끝나면 처음부터');
  assert.deepEqual(seq.feed(press('j', { ctrlKey: true })), { kind: 'pending', consume: true });
  assert.deepEqual(seq.feed(press('Process', { code: 'KeyQ', keyCode: 229, isComposing: true })), { kind: 'match', commandId: 'format:italic' });
});

test('이어지지 않는 키와 시간이 지난 키는 가져가지 않는다', () => {
  const { seq, wait } = matcher({ 'mod+k l h': 'format:bold', 'mod+j q': 'format:italic' });
  seq.feed(press('k', { ctrlKey: true }));
  assert.deepEqual(seq.feed(press('h')), { kind: 'none' }, '기본 연속 키 Ctrl+K,H 는 편집기 몫이다');
  seq.feed(press('k', { ctrlKey: true }));
  assert.deepEqual(seq.feed(press('j', { ctrlKey: true })), { kind: 'pending', consume: true }, '끊긴 키가 새 연속 키를 시작한다');
  wait(2001);
  assert.deepEqual(seq.feed(press('q')), { kind: 'none' }, '기다림이 끝나면 글자 입력으로 돌아간다');
  seq.feed(press('j', { ctrlKey: true }));
  seq.reset();
  assert.deepEqual(seq.feed(press('q')), { kind: 'none' });
});

test('연속 키 저장: 앞 단계가 겹치면 묻고, 바꾸면 겹친 키를 모두 뺀다', () => {
  const service = createShortcutService({ storage: memoryStorage(), defaults: defaultShortcuts });
  assert.deepEqual(service.assign('format:bold', 'mod+k l h'), { ok: true });
  assert.deepEqual(service.sequences(), [['mod+k l h', 'format:bold']]);
  assert.equal(service.bindings('format:bold')[0].id, 'mod+k l h');
  assert.equal(service.table().some(([, id]) => id === 'format:bold'), true);

  // 다른 명령의 한 키를 앞 단계로 쓰면 그 키를 짚어 묻는다.
  assert.deepEqual(service.check('format:italic', 'mod+s q', 'other'), { kind: 'conflict', owner: 'file:save', binding: 'mod+s' });
  assert.equal(service.assign('format:italic', 'mod+s q').ok, false);
  assert.deepEqual(service.assign('format:italic', 'mod+s q', { takeFrom: 'file:save' }), { ok: true });
  assert.deepEqual(service.bindings('file:save'), []);

  // 잠긴 명령의 키로는 시작할 수 없다.
  assert.equal(service.check('format:italic', 'mod+z q', 'other').kind, 'locked');

  // 한 키가 연속 키 여럿의 앞 단계면 명령을 모두 알리고 모두 뺀다.
  service.assign('format:underline', 'mod+j a');
  service.assign('format:strikethrough', 'mod+j b');
  assert.deepEqual(service.check('edit:find', 'mod+j', 'other'), {
    kind: 'conflict', owner: 'format:underline', binding: 'mod+j a', owners: ['format:underline', 'format:strikethrough'],
  });
  service.assign('edit:find', 'mod+j', { takeFrom: 'format:underline' });
  assert.equal(service.sequences().some(([id]) => id.startsWith('mod+j ')), false);

  // 저장을 되돌린 명령은 Ctrl+S 를 되찾고, 그 키로 시작하던 연속 키는 빠진다.
  service.resetCommand('file:save');
  assert.equal(service.bindings('file:save')[0].id, 'mod+s');
  assert.equal(service.sequences().some(([id]) => id.startsWith('mod+s ')), false);
});

test('손으로 고친 저장값의 쓸 수 없는 연속 키는 실행 표에 넣지 않는다', () => {
  const storage = memoryStorage();
  storage.setItem('rhwp-shortcuts', JSON.stringify({
    version: 1,
    commands: { 'format:bold': { add: ['mod+k h', 'mod+z q', 'mod+u i'], remove: [] } },
  }));
  const service = createShortcutService({ storage });
  assert.deepEqual(service.sequences(), [['mod+u i', 'format:bold']]);
});
