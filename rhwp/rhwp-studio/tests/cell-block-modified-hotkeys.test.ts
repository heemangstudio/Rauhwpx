import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestModuleServer } from './support/module-server.ts';

// F5 셀 블록에서 M/S 는 셀 합치기/나누기 단축키지만, Ctrl+S(저장)·Ctrl+Shift+M(양쪽 정렬)·
// Ctrl+M,N 같은 수정자 조합까지 가로채면 저장 대신 셀 나누기가 열린다.
// 실제 입력 처리기의 onKeyDown 을 셀 블록 상태에서 눌러 본다.

const rootDir = fileURLToPath(new URL('..', import.meta.url));
let vite: Awaited<ReturnType<typeof createTestModuleServer>>;
let inputHandlerProto: any;

before(async () => {
  vite = await createTestModuleServer(rootDir);
  inputHandlerProto = (await vite.ssrLoadModule('/src/engine/input-handler.ts')).InputHandler.prototype;
});

after(async () => {
  await vite?.close();
});

function cellBlockHandler(inBlock = true) {
  const dispatched: string[] = [];
  let inCellBlock = inBlock;
  const quiet: any = new Proxy({}, { get: () => () => false });
  const handler: any = Object.create(inputHandlerProto);
  Object.assign(handler, {
    active: true,
    readOnly: false,
    userEditingLocked: false,
    editMode: 'normal',
    eventBus: quiet,
    caret: quiet,
    cellSelectionRenderer: quiet,
    selectionRenderer: quiet,
    imeSession: { isComposing: false },
    textarea: quiet,
    wasm: quiet,
    dispatcher: { dispatch: (id: string) => { dispatched.push(id); return true; } },
    updateCaret() {},
    cursor: new Proxy({
      isInCellSelectionMode: () => inCellBlock,
      exitCellSelectionMode: () => { inCellBlock = false; },
      isInCell: () => true,
      getCellSelectionPhase: () => 1,
      getPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    } as Record<string | symbol, unknown>, { get: (cursor, key) => cursor[key] ?? (() => false) }),
  });
  return { handler, dispatched, inCellBlock: () => inCellBlock };
}

function key(k: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) {
  let prevented = false;
  return {
    event: {
      key: k,
      code: /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : k,
      ctrlKey: Boolean(mods.ctrl),
      shiftKey: Boolean(mods.shift),
      altKey: Boolean(mods.alt),
      metaKey: Boolean(mods.meta),
      isComposing: false,
      keyCode: k.toUpperCase().charCodeAt(0),
      preventDefault() { prevented = true; },
      stopPropagation() {},
    },
    prevented: () => prevented,
  };
}

test('bare M and S in an F5 cell block still merge and split cells', () => {
  for (const [k, id] of [['m', 'table:cell-merge'], ['M', 'table:cell-merge'], ['s', 'table:cell-split'], ['S', 'table:cell-split']]) {
    const { handler, dispatched, inCellBlock } = cellBlockHandler();
    handler.onKeyDown(key(k, { shift: k === k.toUpperCase() }).event);
    assert.deepEqual(dispatched, [id], k);
    assert.equal(inCellBlock(), true, k);
  }
});

test('Ctrl+S in an F5 cell block saves instead of opening 셀 나누기', () => {
  const { handler, dispatched } = cellBlockHandler();
  handler.onKeyDown(key('s', { ctrl: true }).event);
  assert.ok(!dispatched.includes('table:cell-split'), JSON.stringify(dispatched));
  assert.deepEqual(dispatched, ['file:save']);
});

test('Ctrl+Shift+M in an F5 cell block justifies instead of merging cells', () => {
  const { handler, dispatched } = cellBlockHandler();
  handler.onKeyDown(key('M', { ctrl: true, shift: true }).event);
  assert.ok(!dispatched.includes('table:cell-merge'), JSON.stringify(dispatched));
  assert.deepEqual(dispatched, ['format:align-justify']);
});

test('Ctrl+M in an F5 cell block starts the Ctrl+M chord instead of merging cells', () => {
  const { handler, dispatched } = cellBlockHandler();
  handler.onKeyDown(key('m', { ctrl: true }).event);
  assert.deepEqual(dispatched, []);
  assert.equal(handler._pendingChordM, true);
});

test('Alt+S and Cmd+S in an F5 cell block do not split cells', () => {
  for (const mods of [{ alt: true }, { meta: true }]) {
    const { handler, dispatched } = cellBlockHandler();
    handler.onKeyDown(key('s', mods).event);
    assert.ok(!dispatched.includes('table:cell-split'), JSON.stringify({ mods, dispatched }));
  }
});

test('Ctrl+N then M opens the equation editor, in body text and in a cell block', () => {
  for (const inBlock of [false, true]) {
    const { handler, dispatched } = cellBlockHandler(inBlock);
    const first = key('n', { ctrl: true });
    handler.onKeyDown(first.event);
    assert.equal(first.prevented(), true);
    assert.deepEqual(dispatched, []);
    handler.onKeyDown(key('m').event);
    assert.deepEqual(dispatched, ['insert:equation'], String(inBlock));
  }
});

test('Ctrl+N then M opens the equation editor with the Korean IME on', () => {
  const ime = (code: string, mods: { ctrl?: boolean } = {}) => ({
    ...key(code.slice(3).toLowerCase(), mods).event, key: 'Process', code, keyCode: 229,
  });
  for (const second of [key('ㅡ').event, ime('KeyM')]) {
    const { handler, dispatched } = cellBlockHandler(false);
    handler.onKeyDown(ime('KeyN', { ctrl: true }));
    handler.onKeyDown(second);
    assert.deepEqual(dispatched, ['insert:equation'], second.key);
  }
});

test('Ctrl+M then M no longer opens the equation editor', () => {
  const { handler, dispatched } = cellBlockHandler(false);
  handler.onKeyDown(key('m', { ctrl: true }).event);
  handler.onKeyDown(key('m').event);
  assert.ok(!dispatched.includes('insert:equation'), JSON.stringify(dispatched));
});
