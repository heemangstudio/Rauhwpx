import assert from 'node:assert/strict';
import test, { after, afterEach, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestModuleServer } from './support/module-server.ts';

// 사용자 지정 단축키가 실제 입력 처리기(InputHandler.onKeyDown)까지 닿는지 본다.
// 입력 처리기의 단축키 경로(Ctrl·Alt·기능 키·하위 모드)가 기본 표 대신 실제 표를 읽어야 통과한다.

const rootDir = fileURLToPath(new URL('..', import.meta.url));
let vite: Awaited<ReturnType<typeof createTestModuleServer>>;
let inputHandlerProto: any;
let shortcuts: any;

before(async () => {
  vite = await createTestModuleServer(rootDir);
  inputHandlerProto = (await vite.ssrLoadModule('/src/engine/input-handler.ts')).InputHandler.prototype;
  shortcuts = (await vite.ssrLoadModule('/src/command/effective-shortcuts.ts')).shortcuts;
});

afterEach(() => {
  shortcuts?.resetAll();
});

after(async () => {
  await vite?.close();
});

function editorHandler(options: { inFootnote?: boolean; readOnly?: boolean; cellBlock?: boolean } = {}) {
  const dispatched: string[] = [];
  let inCellBlock = Boolean(options.cellBlock);
  const quiet: any = new Proxy({}, { get: () => () => false });
  const handler: any = Object.create(inputHandlerProto);
  Object.assign(handler, {
    active: true,
    readOnly: Boolean(options.readOnly),
    userEditingLocked: false,
    editMode: 'normal',
    eventBus: quiet,
    caret: quiet,
    cellSelectionRenderer: quiet,
    selectionRenderer: quiet,
    imeSession: { isComposing: false },
    textarea: quiet,
    wasm: quiet,
    // 셀 블록 안에서 실행된 명령은 '@cell' 을 붙여 적는다 — 블록을 푼 뒤 실행되면 붙지 않는다.
    dispatcher: { dispatch: (id: string) => { dispatched.push(inCellBlock ? `${id}@cell` : id); return true; } },
    updateCaret() {},
    resetTextareaBuffer() {},
    cursor: new Proxy({
      isInCellSelectionMode: () => inCellBlock,
      exitCellSelectionMode: () => { inCellBlock = false; },
      isInCell: () => Boolean(options.cellBlock),
      isInFootnote: () => Boolean(options.inFootnote),
      hasSelection: () => false,
      getPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    } as Record<string | symbol, unknown>, { get: (cursor, key) => cursor[key] ?? (() => false) }),
  });
  return { handler, dispatched };
}

function key(k: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean; keyCode?: number } = {}, code?: string) {
  let prevented = false;
  return {
    event: {
      key: k,
      code: code ?? (/^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : k),
      ctrlKey: Boolean(mods.ctrl),
      shiftKey: Boolean(mods.shift),
      altKey: Boolean(mods.alt),
      metaKey: Boolean(mods.meta),
      isComposing: false,
      keyCode: mods.keyCode ?? k.toUpperCase().charCodeAt(0),
      getModifierState: () => false,
      preventDefault() { prevented = true; },
      stopPropagation() {},
    },
    prevented: () => prevented,
  };
}

function press(k: string, mods: Parameters<typeof key>[1] = {}, code?: string, options?: Parameters<typeof editorHandler>[0]) {
  const { handler, dispatched } = editorHandler(options);
  const { event, prevented } = key(k, mods, code);
  handler.onKeyDown(event);
  return { dispatched, prevented: prevented() };
}

test('기본 표 그대로면 Ctrl+B 는 굵게, Ctrl+Shift+B 는 아무것도 하지 않는다', () => {
  assert.deepEqual(press('b', { ctrl: true }).dispatched, ['format:bold']);
  assert.deepEqual(press('B', { ctrl: true, shift: true }).dispatched, []);
});

test('Ctrl+Shift+B 를 굵게에 더하고 Ctrl+B 를 지우면 입력 처리기가 그대로 따른다', () => {
  assert.deepEqual(shortcuts.assign('format:bold', 'mod+shift+b'), { ok: true });
  assert.deepEqual(shortcuts.remove('format:bold', 'mod+b'), { ok: true });

  const added = press('B', { ctrl: true, shift: true });
  assert.deepEqual(added.dispatched, ['format:bold']);
  assert.equal(added.prevented, true);
  // 한글 IME 상태에서도 같은 자리의 키로 동작한다.
  assert.deepEqual(press('ㅠ', { ctrl: true, shift: true }, 'KeyB').dispatched, ['format:bold']);
  assert.deepEqual(press('b', { ctrl: true }).dispatched, []);
  assert.deepEqual(press('ㅠ', { ctrl: true }, 'KeyB').dispatched, []);
});

test('Alt 조합과 기능 키 경로도 실제 표를 읽는다', () => {
  assert.deepEqual(press('l', { alt: true }).dispatched, ['format:char-shape']);
  shortcuts.remove('format:char-shape', 'alt+l');
  assert.deepEqual(press('l', { alt: true }).dispatched, []);

  assert.deepEqual(press('F8', {}, 'F8').dispatched, []);
  shortcuts.assign('format:italic', 'f8');
  assert.deepEqual(press('F8', {}, 'F8').dispatched, ['format:italic']);
});

test('Ctrl+S 를 굵게로 옮기면 저장 대신 굵게가 실행된다', () => {
  assert.deepEqual(press('s', { ctrl: true }).dispatched, ['file:save']);
  shortcuts.assign('format:bold', 'mod+s', { takeFrom: 'file:save' });
  assert.deepEqual(press('s', { ctrl: true }).dispatched, ['format:bold']);
  shortcuts.resetCommand('file:save');
  assert.deepEqual(press('s', { ctrl: true }).dispatched, ['file:save']);
});

test('각주 안 하위 모드 단축키도 실제 표를 읽는다', () => {
  // 각주 안에서는 허용 목록의 명령만 받는다. 굵게는 허용 목록에 있다.
  shortcuts.assign('format:bold', 'mod+shift+b');
  shortcuts.remove('format:bold', 'mod+b');
  const footnote = { inFootnote: true };
  const added = press('B', { ctrl: true, shift: true }, undefined, footnote);
  assert.deepEqual(added.dispatched, ['format:bold']);
});

test('한글 IME 가 keyCode 229 로 보낸 Ctrl 조합도 사용자 지정 키를 실행한다', () => {
  // IME 블록은 실제 표에 맞는 키가 없을 때만 키를 삼킨다.
  const ime = { ctrl: true, shift: true, keyCode: 229 };
  assert.deepEqual(press('Process', ime, 'KeyB').dispatched, []);
  shortcuts.assign('format:bold', 'mod+shift+b');
  assert.deepEqual(press('Process', ime, 'KeyB').dispatched, ['format:bold']);
});

test('읽기 전용 문서에서도 사용자 지정한 보기 명령 키는 동작한다', () => {
  const readOnly = { readOnly: true };
  assert.deepEqual(press('F9', {}, 'F9', readOnly).dispatched, []);
  shortcuts.assign('view:toggle-grid', 'f9');
  assert.deepEqual(press('F9', {}, 'F9', readOnly).dispatched, ['view:toggle-grid']);
  // 편집 명령은 읽기 전용에서 여전히 막힌다.
  shortcuts.assign('format:bold', 'f8');
  const blocked = press('F8', {}, 'F8', readOnly);
  assert.deepEqual(blocked.dispatched, []);
  assert.equal(blocked.prevented, true);
});

test('모양 복사를 Alt+C 밖의 키로 옮겨도 셀 블록 안에서 실행된다', () => {
  const cellBlock = { cellBlock: true };
  assert.deepEqual(press('c', { alt: true }, 'KeyC', cellBlock).dispatched, ['edit:format-copy@cell']);
  shortcuts.remove('edit:format-copy', 'alt+c');
  shortcuts.assign('edit:format-copy', 'f8');
  shortcuts.assign('edit:format-copy', 'mod+shift+9');
  assert.deepEqual(press('F8', {}, 'F8', cellBlock).dispatched, ['edit:format-copy@cell']);
  assert.deepEqual(press('(', { ctrl: true, shift: true }, 'Digit9', cellBlock).dispatched, ['edit:format-copy@cell']);
});
