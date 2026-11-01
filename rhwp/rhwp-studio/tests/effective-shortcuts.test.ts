import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultShortcuts, matchShortcut, type ShortcutDef } from '../src/command/shortcut-map.ts';
import {
  createShortcutService,
  shortcutLabelFor,
  windowStorageListener,
  type ShortcutService,
} from '../src/command/effective-shortcuts.ts';
import { SHORTCUT_OVERRIDES_KEY, type ShortcutStorage } from '../src/command/shortcut-overrides.ts';

type Platform = 'mac' | 'other';

function key(input: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: input.key ?? '',
    code: input.code ?? '',
    shiftKey: input.shiftKey ?? false,
    ctrlKey: input.ctrlKey ?? false,
    metaKey: input.metaKey ?? false,
    altKey: input.altKey ?? false,
  } as KeyboardEvent;
}

function memoryStorage(initial?: string): ShortcutStorage & { value(): string | null; writes: number } {
  let stored: string | null = initial ?? null;
  const storage = {
    writes: 0,
    getItem: (k: string) => (k === SHORTCUT_OVERRIDES_KEY ? stored : null),
    setItem: (k: string, v: string) => { if (k === SHORTCUT_OVERRIDES_KEY) { stored = v; storage.writes += 1; } },
    removeItem: (k: string) => { if (k === SHORTCUT_OVERRIDES_KEY) { stored = null; storage.writes += 1; } },
    value: () => stored,
  };
  return storage;
}

function serviceWith(storage = memoryStorage()): { service: ShortcutService; storage: ReturnType<typeof memoryStorage> } {
  return { service: createShortcutService({ storage, listen: () => () => {} }), storage };
}

function match(service: ShortcutService, input: Partial<KeyboardEvent>, platform: Platform = 'other'): string | null {
  return matchShortcut(key(input), service.table(), platform);
}

/** 기본 행 하나를 실제 키 입력처럼 만든다 (영문 행은 물리 키 code 까지). */
function eventFor(def: ShortcutDef): Partial<KeyboardEvent> {
  const latin = /^[a-z]$/.test(def.key);
  return {
    key: def.key,
    code: def.code ?? (latin ? `Key${def.key.toUpperCase()}` : ''),
    ctrlKey: !!def.ctrl,
    shiftKey: !!def.shift,
    altKey: !!def.alt,
  };
}

function assertDefaultMatching(service: ShortcutService): void {
  for (const [def] of defaultShortcuts) {
    for (const platform of ['other', 'mac'] as const) {
      const event = key(eventFor(def));
      assert.equal(
        matchShortcut(event, service.table(), platform),
        matchShortcut(event, defaultShortcuts, platform),
        `${JSON.stringify(def)} on ${platform}`,
      );
    }
  }
}

const ctrlShiftB = { key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true };

test('사용자 지정이 없으면 실제 표는 기본 표와 같다', () => {
  const { service } = serviceWith();
  assert.deepEqual(service.table(), defaultShortcuts);
  assert.equal(service.customizedCount(), 0);
  assertDefaultMatching(service);
});

test('더한 단축키는 영문·한글 IME·Process·macOS Cmd 에서 동작한다', () => {
  const { service } = serviceWith();
  assert.equal(match(service, ctrlShiftB), null);
  assert.deepEqual(service.assign('format:bold', 'mod+shift+b'), { ok: true });
  assert.equal(match(service, ctrlShiftB), 'format:bold');
  assert.equal(match(service, { key: 'ㅠ', code: 'KeyB', ctrlKey: true, shiftKey: true }), 'format:bold');
  assert.equal(match(service, { key: 'Process', code: 'KeyB', ctrlKey: true, shiftKey: true }), 'format:bold');
  assert.equal(match(service, { key: 'b', code: 'KeyB', metaKey: true, shiftKey: true }, 'mac'), 'format:bold');
  // 기본 키는 그대로 남는다.
  assert.equal(match(service, { key: 'b', code: 'KeyB', ctrlKey: true }), 'format:bold');
  assert.equal(service.isCustomized('format:bold'), true);
  assert.equal(service.customizedCount(), 1);
});

test('기본 키를 지우면 영문·자모·Option 쌍둥이가 모두 멈춘다', () => {
  const { service } = serviceWith();
  const altShiftB = [
    { key: 'B', code: 'KeyB', altKey: true, shiftKey: true },
    { key: 'ㅠ', code: 'KeyB', altKey: true, shiftKey: true },
    { key: '∫', code: 'KeyB', altKey: true, shiftKey: true },
  ];
  for (const input of altShiftB) assert.equal(match(service, input, 'mac'), 'format:bold');
  assert.deepEqual(service.remove('format:bold', 'alt+shift+b'), { ok: true });
  for (const input of altShiftB) {
    assert.equal(match(service, input, 'mac'), null, input.key);
    assert.equal(match(service, input, 'other'), null, input.key);
  }
  assert.equal(match(service, { key: 'b', code: 'KeyB', ctrlKey: true }), 'format:bold');
  assert.equal(match(service, { key: 'ㅠ', code: 'KeyB', ctrlKey: true }), 'format:bold');

  service.remove('format:bold', 'mod+b');
  assert.equal(match(service, { key: 'b', code: 'KeyB', ctrlKey: true }), null);
  assert.equal(match(service, { key: 'ㅠ', code: 'KeyB', ctrlKey: true }), null);
  assert.deepEqual(service.bindings('format:bold'), []);
});

test('다른 명령의 키는 충돌로 알리고, 바꾸기를 고르면 한 번에 옮긴다', () => {
  const { service, storage } = serviceWith();
  assert.deepEqual(service.check('format:bold', 'mod+s', 'other'), { kind: 'conflict', owner: 'file:save' });
  const writes = storage.writes;
  assert.equal(service.assign('format:bold', 'mod+s').ok, false);
  assert.equal(storage.writes, writes, '충돌을 고르지 않으면 쓰지 않는다');
  assert.equal(match(service, { key: 's', code: 'KeyS', ctrlKey: true }), 'file:save');

  assert.deepEqual(service.assign('format:bold', 'mod+s', { takeFrom: 'file:save' }), { ok: true });
  assert.equal(storage.writes, writes + 1, '한 번에 쓴다');
  assert.equal(match(service, { key: 's', code: 'KeyS', ctrlKey: true }), 'format:bold');
  assert.equal(match(service, { key: 'ㄴ', code: 'KeyS', ctrlKey: true }), 'format:bold');
  assert.ok(!service.bindings('file:save').some(binding => binding.id === 'mod+s'));
  assert.equal(service.ownerOf('mod+s'), 'format:bold');
  // 다른 이름으로 저장(Ctrl+Shift+S)은 건드리지 않는다.
  assert.equal(match(service, { key: 'S', code: 'KeyS', ctrlKey: true, shiftKey: true }), 'file:save-as');

  // 저장을 기본값으로 되돌리면 Ctrl+S 를 되찾는다.
  assert.deepEqual(service.resetCommand('file:save'), { ok: true });
  assert.equal(match(service, { key: 's', code: 'KeyS', ctrlKey: true }), 'file:save');
  assert.ok(!service.bindings('format:bold').some(binding => binding.id === 'mod+s'));
});

test('사용자 추가 키를 가져오면 원래 명령의 추가 키가 지워진다', () => {
  const { service } = serviceWith();
  service.assign('format:italic', 'mod+shift+9');
  assert.deepEqual(service.check('format:bold', 'mod+shift+9', 'other'), { kind: 'conflict', owner: 'format:italic' });
  service.assign('format:bold', 'mod+shift+9', { takeFrom: 'format:italic' });
  assert.equal(match(service, { key: '(', code: 'Digit9', ctrlKey: true, shiftKey: true }), 'format:bold');
  assert.equal(service.isCustomized('format:italic'), false);
});

test('예약 키와 고정 명령은 거절한다', () => {
  const { service, storage } = serviceWith();
  assert.equal(service.check('format:bold', 'mod+c', 'other').kind, 'reserved');
  assert.equal(service.check('format:bold', 'alt+v', 'other').kind, 'reserved');
  assert.deepEqual(service.check('format:bold', 'mod+z', 'other'), { kind: 'locked', owner: 'edit:undo' });
  assert.deepEqual(service.check('format:bold', 'mod+a', 'other'), { kind: 'locked', owner: 'edit:select-all' });
  assert.equal(service.assign('format:bold', 'mod+z', { takeFrom: 'edit:undo' }).ok, false);
  assert.equal(service.assign('edit:undo', 'mod+shift+u').ok, false);
  assert.equal(service.remove('edit:undo', 'mod+z').ok, false);
  assert.equal(storage.value(), null);
  assert.equal(match(service, { key: 'z', code: 'KeyZ', ctrlKey: true }), 'edit:undo');
  assert.equal(match(service, { key: 'U', code: 'KeyU', ctrlKey: true, shiftKey: true }), null);
  // 자기 기본 키는 예약 목록에 있어도 되살릴 수 있다 (macOS Cmd+H 찾아 바꾸기).
  service.remove('edit:find-replace', 'mod+h');
  assert.equal(service.check('edit:find-replace', 'mod+h', 'mac').kind, 'ok');
  assert.equal(service.check('format:bold', 'mod+h', 'mac').kind, 'reserved');
  // 이미 가진 키
  assert.deepEqual(service.check('format:bold', 'mod+b', 'other'), { kind: 'same' });
});

test('먼저 도는 처리기가 가져가는 키는 다른 명령에 걸 수 없고, 그 키의 기본 명령만 되살린다', () => {
  const { service } = serviceWith();
  for (const id of ['alt+delete', 'alt+shift+delete', 'mod+]', 'mod+[']) {
    assert.equal(service.check('format:bold', id, 'other').kind, 'reserved', id);
    assert.equal(service.assign('format:bold', id).ok, false, id);
  }
  service.remove('table:delete-row-col', 'alt+delete');
  assert.equal(service.check('table:delete-row-col', 'alt+delete', 'other').kind, 'ok');
  service.remove('format:font-size-increase', 'mod+]');
  assert.equal(service.check('format:font-size-increase', 'mod+]', 'other').kind, 'ok');
});

test('수정자 없는 키는 저장값에 있어도 쓰지 않고 지정도 거절한다', () => {
  const raw = JSON.stringify({
    version: 1,
    commands: { 'format:bold': { add: ['a', 'shift+q', '+', 'mod+shift+b'] } },
  });
  const { service } = serviceWith(memoryStorage(raw));
  assert.equal(match(service, { key: 'a', code: 'KeyA' }), null);
  assert.equal(match(service, { key: 'Q', code: 'KeyQ', shiftKey: true }), null);
  assert.equal(match(service, ctrlShiftB), 'format:bold');
  assert.deepEqual(service.bindings('format:bold').filter(binding => binding.source === 'user'), [{ id: 'mod+shift+b', source: 'user' }]);
  assert.equal(service.assign('format:italic', 'q').ok, false);
  assert.equal(service.check('format:italic', 'shift+q', 'other').kind, 'reserved');
});

test('손으로 고친 저장값이 고정 명령의 키나 예약 키를 더해도 그 키는 원래대로 동작한다', () => {
  const raw = JSON.stringify({
    version: 1,
    commands: {
      'format:bold': { add: ['mod+z', 'mod+shift+b'] },
      'format:italic': { add: ['mod+k', 'mod+a'] },
    },
  });
  const { service } = serviceWith(memoryStorage(raw));
  assert.equal(match(service, { key: 'z', code: 'KeyZ', ctrlKey: true }), 'edit:undo');
  assert.equal(match(service, { key: 'a', code: 'KeyA', ctrlKey: true }), 'edit:select-all');
  // Ctrl+K 는 연속 키 첫 키라 표에 없어야 한다.
  assert.equal(match(service, { key: 'k', code: 'KeyK', ctrlKey: true }), null);
  assert.equal(match(service, ctrlShiftB), 'format:bold');
  assert.deepEqual(service.bindings('format:bold').map(binding => binding.id).filter(id => id === 'mod+z'), []);
  assert.equal(service.isCustomized('format:italic'), false);
  assert.deepEqual([...service.conflicts()], []);
});

test('기본 표에는 두 명령이 함께 가진 키가 없다', () => {
  const { service } = serviceWith();
  assert.deepEqual([...service.conflicts()], []);
  // 같은 키를 두 명령에 더한 손수 고친 저장값은 충돌로 드러난다.
  const hand = serviceWith(memoryStorage(JSON.stringify({
    version: 1,
    commands: { 'format:bold': { add: ['mod+shift+9'] }, 'format:italic': { add: ['mod+shift+9'] } },
  }))).service;
  assert.deepEqual([...hand.conflicts()], [['mod+shift+9', ['format:bold', 'format:italic']]]);
});

test('같은 저장소로 만든 새 서비스는 같은 표를 쓴다', () => {
  const { service, storage } = serviceWith();
  service.assign('format:bold', 'mod+shift+b');
  service.remove('format:italic', 'mod+i');
  service.assign('format:strikethrough', 'mod+shift+x');
  const reopened = serviceWith(storage).service;
  assert.deepEqual(reopened.table(), service.table());
  assert.equal(match(reopened, { key: 'X', code: 'KeyX', ctrlKey: true, shiftKey: true }), 'format:strikethrough');
  assert.equal(match(reopened, { key: 'i', code: 'KeyI', ctrlKey: true }), null);
  assert.deepEqual(JSON.parse(storage.value()!), {
    version: 1,
    commands: {
      'format:bold': { add: ['mod+shift+b'], remove: [] },
      'format:italic': { add: [], remove: ['mod+i'] },
      'format:strikethrough': { add: ['mod+shift+x'], remove: [] },
    },
  });
});

test('지운 기본 키를 다시 지정하면 사용자 추가가 남지 않는다', () => {
  const { service, storage } = serviceWith();
  service.remove('format:bold', 'mod+b');
  assert.equal(service.isCustomized('format:bold'), true);
  service.assign('format:bold', 'mod+b');
  assert.equal(service.isCustomized('format:bold'), false);
  assert.equal(storage.value(), null);
  assert.deepEqual(service.bindings('format:bold').map(binding => binding.source), ['default', 'default']);
});

test('명령 하나·전체 되돌리기는 모든 기본 행의 매칭을 되살린다', () => {
  const { service, storage } = serviceWith();
  service.assign('format:bold', 'mod+s', { takeFrom: 'file:save' });
  service.remove('format:bold', 'alt+shift+b');
  service.remove('view:zoom-in', 'mod+shift+=');
  service.assign('format:italic', 'f8');
  assert.equal(match(service, { key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }), null);

  service.resetCommand('format:bold');
  service.resetCommand('file:save');
  service.resetCommand('view:zoom-in');
  service.resetCommand('format:italic');
  assert.equal(storage.value(), null);
  assertDefaultMatching(service);

  service.assign('format:bold', 'mod+s', { takeFrom: 'file:save' });
  service.remove('edit:find', 'mod+f');
  assert.equal(service.customizedCount(), 3);
  assert.deepEqual(service.resetAll(), { ok: true });
  assert.equal(service.customizedCount(), 0);
  assert.equal(storage.value(), null);
  assertDefaultMatching(service);
});

test('깨진 저장값은 기본값으로 읽고, 다음 저장이 덮어쓴다', () => {
  for (const broken of ['{nope', '"text"', '[1,2]', 'null', '{"version":1,"commands":7}']) {
    const { service, storage } = serviceWith(memoryStorage(broken));
    assert.deepEqual(service.table(), defaultShortcuts, broken);
    assert.equal(service.readOnly(), false);
    service.assign('format:bold', 'mod+shift+b');
    assert.deepEqual(JSON.parse(storage.value()!).commands, { 'format:bold': { add: ['mod+shift+b'], remove: [] } });
  }
});

test('더 새 버전이 저장한 값이면 읽기 전용으로 기본값을 쓰고 저장소를 건드리지 않는다', () => {
  const raw = JSON.stringify({ version: 2, commands: { 'format:bold': { add: ['mod+shift+b'], remove: [] } }, extra: true });
  const { service, storage } = serviceWith(memoryStorage(raw));
  assert.equal(service.readOnly(), true);
  assert.deepEqual(service.table(), defaultShortcuts);
  assert.equal(service.assign('format:bold', 'mod+shift+b').ok, false);
  assert.equal(service.remove('format:bold', 'mod+b').ok, false);
  assert.equal(service.resetCommand('format:bold').ok, false);
  assert.equal(service.resetAll().ok, false);
  assert.equal(storage.value(), raw);
  assert.equal(storage.writes, 0);
  assert.equal(match(service, ctrlShiftB), null);
});

test('잘못된 ID 는 하나씩 버리고, 모르는 명령은 저장소에 남기되 쓰지 않는다', () => {
  const raw = JSON.stringify({
    version: 1,
    commands: {
      'format:bold': { add: ['mod+shift+b', 'ctrl+x', 'mod+arrowleft', 'MOD+SHIFT+B', 7], remove: ['bogus'] },
      'nope:cmd': { add: ['mod+shift+9'], remove: [] },
      'format:italic': { add: ['mod+i'], remove: ['mod+i'] },
      'format:underline': 'broken',
    },
  });
  const { service, storage } = serviceWith(memoryStorage(raw));
  assert.deepEqual(service.bindings('format:bold').filter(binding => binding.source === 'user'), [{ id: 'mod+shift+b', source: 'user' }]);
  assert.equal(match(service, ctrlShiftB), 'format:bold');
  assert.equal(match(service, { key: '(', code: 'Digit9', ctrlKey: true, shiftKey: true }), null);
  // 자기 기본 키를 더하고 지운 항목은 "지우지 않음"으로 정리된다.
  assert.equal(service.isCustomized('format:italic'), false);
  assert.equal(match(service, { key: 'i', code: 'KeyI', ctrlKey: true }), 'format:italic');

  service.assign('format:strikethrough', 'mod+shift+x');
  const saved = JSON.parse(storage.value()!);
  assert.deepEqual(saved.commands['nope:cmd'], { add: ['mod+shift+9'], remove: [] });
  assert.deepEqual(saved.commands['format:bold'], { add: ['mod+shift+b'], remove: [] });
  assert.equal('format:italic' in saved.commands, false);
});

test('저장에 실패하면 메모리와 알림을 그대로 둔다', () => {
  const failing: ShortcutStorage = {
    getItem: () => null,
    setItem: () => { throw new Error('QuotaExceededError'); },
    removeItem: () => { throw new Error('QuotaExceededError'); },
  };
  const service = createShortcutService({ storage: failing, listen: () => () => {} });
  let notified = 0;
  service.subscribe(() => { notified += 1; });
  const result = service.assign('format:bold', 'mod+shift+b');
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /저장하지 못했습니다/);
  assert.equal(notified, 0);
  assert.equal(match(service, ctrlShiftB), null);
  assert.equal(service.isCustomized('format:bold'), false);
});

test('다른 창의 저장은 storage 이벤트로 따라가고 구독자에게 external 로 알린다', () => {
  const storage = memoryStorage();
  let onExternal: (() => void) | null = null;
  let stopped = false;
  const service = createShortcutService({
    storage,
    listen: (callback) => { onExternal = callback; return () => { stopped = true; }; },
  });
  const sources: string[] = [];
  service.subscribe(source => sources.push(source));

  service.assign('format:bold', 'mod+shift+b');
  assert.deepEqual(sources, ['local']);

  // 다른 창이 같은 저장소에 쓴다.
  const other = createShortcutService({ storage, listen: () => () => {} });
  other.resetAll();
  other.assign('format:italic', 'mod+shift+b', { takeFrom: 'format:bold' });
  assert.equal(match(service, ctrlShiftB), 'format:bold', '이벤트 전에는 이전 표');
  onExternal!();
  assert.deepEqual(sources, ['local', 'external']);
  assert.equal(match(service, ctrlShiftB), 'format:italic');

  service.dispose();
  assert.equal(stopped, true);
});

test('단축키 표기는 사용자 지정을 따른다', () => {
  const { service } = serviceWith();
  const bold = { shortcutLabel: 'Ctrl+B' };
  assert.equal(shortcutLabelFor('format:bold', bold, service), 'Ctrl+B');
  assert.equal(shortcutLabelFor('format:strikethrough', {}, service), undefined);
  service.assign('format:bold', 'mod+shift+b');
  assert.equal(shortcutLabelFor('format:bold', bold, service), 'Ctrl+Shift+B');
  service.remove('format:bold', 'mod+shift+b');
  assert.equal(shortcutLabelFor('format:bold', bold, service), 'Ctrl+B');
  service.remove('format:bold', 'mod+b');
  assert.equal(shortcutLabelFor('format:bold', bold, service), 'Alt+Shift+B');
  service.remove('format:bold', 'alt+shift+b');
  assert.equal(shortcutLabelFor('format:bold', bold, service), null);

  // 키가 하나도 남지 않은 명령도 연속 키·메뉴 안 한 글자 키는 그대로 보인다.
  service.remove('view:zoom-100', 'mod+0');
  assert.equal(shortcutLabelFor('view:zoom-100', { shortcutLabel: 'Ctrl+0' }, service), 'Ctrl+G,Q');
  service.assign('format:italic', 'f8');
  assert.equal(shortcutLabelFor('format:italic', { shortcutLabel: 'Ctrl+I' }, service), 'F8');
  // 고정 명령은 언제나 원래 표기
  assert.equal(shortcutLabelFor('edit:undo', { shortcutLabel: 'Ctrl+Z' }, service), 'Ctrl+Z');
});

test('창의 storage 이벤트는 단축키 키와 저장소 비우기에만 반응한다', () => {
  const handlers = new Set<(event: Event) => void>();
  const target = {
    addEventListener: (type: string, fn: (event: Event) => void) => { if (type === 'storage') handlers.add(fn); },
    removeEventListener: (type: string, fn: (event: Event) => void) => { if (type === 'storage') handlers.delete(fn); },
  } as unknown as Window;
  let calls = 0;
  const stop = windowStorageListener(() => { calls += 1; }, target);
  const fire = (key: string | null) => { for (const fn of handlers) fn({ key } as unknown as Event); };
  fire('rhwp-settings');
  fire('rhwp-shortcuts-backup');
  assert.equal(calls, 0);
  fire(SHORTCUT_OVERRIDES_KEY);
  assert.equal(calls, 1);
  fire(null);
  assert.equal(calls, 2);
  stop();
  assert.equal(handlers.size, 0);
  fire(SHORTCUT_OVERRIDES_KEY);
  assert.equal(calls, 2);
});
