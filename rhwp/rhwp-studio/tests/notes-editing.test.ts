import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertUndoRedoRestores,
  commandServices,
  documentFingerprint,
  pagesFingerprint,
  startEditEngine,
} from './support/edit-history-env.ts';

// 각주·미주 편집을 실제 엔진과 실제 입력 처리기로 돌린다. 한컴 2022 캡처(heemang-cleanroom
// parity/notes/hancom-note-captures)의 동작: 선택 위 입력·붙여넣기는 되돌리기 한 번(c09d·c09e),
// 캐럿 0 은 번호 앞(c02a), 주석 안 모두 선택은 그 주석만(c02f), 표 셀에서 넣은 주석은 그 셀에 든다(c01).

const env = await startEditEngine();
test.after(() => env.close());

const [{ insertCommands }, textInput, keyboard] = await Promise.all([
  env.load('/src/command/commands/insert.ts'),
  env.load('/src/engine/input-handler-text.ts'),
  env.load('/src/engine/input-handler-keyboard.ts'),
]);

function quiet<T>(fn: () => T): T {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try { return fn(); } finally { Object.assign(console, { log, warn, error }); }
}

const caretStub = { hide() {}, show() {}, hideComposition() {}, beginEraseMotion() {}, endEraseMotion() {} };

function key(name: string, extra: Record<string, unknown> = {}) {
  return {
    key: name, code: name, keyCode: 0, isComposing: false,
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    preventDefault() {}, stopPropagation() {},
    ...extra,
  };
}

const press = (host: any, name: string, extra: Record<string, unknown> = {}) => quiet(() => keyboard.onKeyDown.call(host, key(name, extra)));

function type(host: any, text: string): void {
  host.textarea.value += text;
  quiet(() => textInput.onInput.call(host, { inputType: 'insertText', data: text, isComposing: false }));
}

function compose(host: any, text: string): void {
  quiet(() => {
    textInput.onCompositionStart.call(host);
    host.textarea.value += text;
    textInput.onCompositionUpdate.call(host, { data: text });
    textInput.onCompositionEnd.call(host, { data: text });
  });
}

function clipboardEvent(data: Record<string, string> = {}) {
  const store = { ...data };
  return {
    store,
    preventDefault() {},
    clipboardData: {
      setData(kind: string, value: string) { store[kind] = value; },
      getData(kind: string) { return store[kind] ?? ''; },
    },
  };
}

function insertNote(host: any, kind: 'footnote' | 'endnote' = 'footnote'): void {
  const command = insertCommands.find((c: any) => c.id === `insert:${kind}`);
  quiet(() => command.execute(commandServices(host)));
}

/** '본문입니다' 의 2 자리에 각주를 넣고 noteText 를 친 호스트. 캐럿은 주석 안이다. */
function noteFixture(noteText = '각주내용입니다') {
  const wasm = env.newDocument();
  wasm.insertText(0, 0, 0, '본문입니다');
  const host = env.createHost(wasm);
  Object.assign(host, { caret: caretStub, textareaConsumed: 0, updateSelection() {} });
  host.cursor.moveTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 2 });
  insertNote(host);
  assert.equal(host.cursor.isInFootnote(), true, '넣은 주석으로 들어간다');
  const start = host.cursor.fnCharOffset;
  if (noteText) type(host, noteText);
  host.history.clear(wasm);
  const ref = host.cursor.fnNoteRef();
  const info = () => wasm.getFootnoteInfo(ref.sectionIdx, ref.paraIdx, ref.controlIdx, host.cursor.fnNotePath);
  const select = (from: number, to: number, para = 0) => quiet(() => {
    host.cursor.clearSelection();
    host.cursor.setFnCursorPosition(para, from);
    host.cursor.setFnAnchor();
    host.cursor.setFnCursorPosition(para, to);
  });
  return { wasm, host, start, ref, info, select };
}

function undoSteps(host: any): number {
  let steps = 0;
  while (host.history.canUndo()) {
    quiet(() => host.handleUndo());
    steps++;
  }
  return steps;
}

// ─── 되돌리기 묶음 (한컴 c09a·c09d·c09e) ────────────────────────────

test('주석 넣기와 이어 친 글은 되돌리기 두 번이고, 되돌리면 주석 안 캐럿·본문 넣은 자리로 돌아간다', () => {
  const wasm = env.newDocument();
  wasm.insertText(0, 0, 0, '본문입니다');
  const host = env.createHost(wasm);
  Object.assign(host, { caret: caretStub, textareaConsumed: 0 });
  host.cursor.moveTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 2 });
  const before = documentFingerprint(wasm);
  insertNote(host);
  const start = host.cursor.fnCharOffset;
  type(host, 'abc');
  quiet(() => host.handleUndo());
  assert.equal(host.cursor.isInFootnote(), true, '첫 되돌리기는 글만 지우고 주석에 머문다');
  assert.equal(host.cursor.fnCharOffset, start);
  quiet(() => host.handleUndo());
  assert.equal(host.cursor.isInFootnote(), false);
  assert.equal(host.cursor.getPosition().charOffset, 2);
  assert.equal(documentFingerprint(wasm), before);
  quiet(() => host.handleRedo());
  assert.equal(host.cursor.isInFootnote(), true, '다시 하면 새 주석 안으로 들어간다');
  assert.equal(host.cursor.fnCharOffset, start);
});

for (const [name, act, expected] of [
  ['타자', (host: any) => type(host, 'X'), 'X'],
  ['이어 친 타자', (host: any) => { type(host, 'X'); type(host, 'Y'); type(host, 'Z'); }, 'XYZ'],
  ['IME', (host: any) => compose(host, '한'), '한'],
  ['Enter', (host: any) => press(host, 'Enter'), '\n'],
  ['붙여넣기', (host: any) => quiet(() => keyboard.onPaste.call(host, clipboardEvent({ 'text/plain': '붙임' }))), '붙임'],
] as const) {
  test(`주석 선택 위 ${name}: 선택 바꾸기가 되돌리기 한 번이다`, () => {
    const f = noteFixture();
    f.select(f.start + 2, f.start + 5);
    const before = documentFingerprint(f.wasm);
    act(f.host);
    const text = f.info().noteText;
    assert.equal(text, `각주${expected}니다`);
    const after = documentFingerprint(f.wasm);
    assert.equal(undoSteps(f.host), 1, '선택 지우기와 입력은 한 칸이다');
    assert.equal(documentFingerprint(f.wasm), before);
    assert.equal(f.host.cursor.isInFootnote(), true);
    quiet(() => f.host.handleRedo());
    assert.equal(documentFingerprint(f.wasm), after, '다시 하기는 입력까지 되살린다');
  });
}

test('주석 선택 지우기는 되돌리기 한 번이고 되돌리면 선택이 돌아온다', () => {
  const f = noteFixture();
  f.select(f.start + 2, f.start + 5);
  const before = documentFingerprint(f.wasm);
  press(f.host, 'Delete');
  assert.equal(f.info().noteText, '각주니다');
  assertUndoRedoRestores(f.host, before);
  quiet(() => f.host.handleUndo());
  const selection = f.host.cursor.getFootnoteSelectionOrdered();
  assert.deepEqual([selection?.start.charOffset, selection?.end.charOffset], [f.start + 2, f.start + 5]);
});

// ─── 클립보드 (한컴 c08c) ───────────────────────────────────────────

test('주석 안 복사·오려 두기는 주석 선택을 담고, 붙여넣기는 주석 안에 서식째 들어간다', () => {
  const f = noteFixture();
  f.select(f.start, f.start + 2);
  const copy = clipboardEvent();
  quiet(() => keyboard.onCopy.call(f.host, copy));
  assert.equal(copy.store['text/plain'], '각주');
  assert.equal(f.host.history.canUndo(), false, '복사는 이력을 남기지 않는다');
  const bodyBefore = f.wasm.getTextRange(0, 0, 0, 5);

  const cut = clipboardEvent();
  f.select(f.start + 2, f.start + 4);
  quiet(() => keyboard.onCut.call(f.host, cut));
  assert.equal(cut.store['text/plain'], '내용');
  assert.equal(f.info().noteText, '각주입니다');

  quiet(() => f.host.cursor.setFnCursorPosition(0, f.info().lengths[0]));
  quiet(() => keyboard.onPaste.call(f.host, clipboardEvent({ 'text/plain': cut.store['text/plain'], 'text/html': cut.store['text/html'] })));
  assert.equal(f.info().noteText, '각주입니다내용');
  assert.equal(f.wasm.getTextRange(0, 0, 0, 5), bodyBefore, '본문은 그대로다');
  assert.equal(undoSteps(f.host), 2, '오려 두기와 붙여넣기가 한 칸씩이다');
});

test('주석 표시가 든 본문 조각을 주석에 붙이면 표시는 버리고 글만 들어간다', () => {
  const f = noteFixture('');
  const ref = f.ref;
  const markers = () => f.wasm.listNotes().length;
  assert.equal(markers(), 1);
  // 본문 '본문[각주]입니다' 를 통째로 엔진 조각에 담는다.
  f.wasm.copySelection(0, 0, 0, 0, f.wasm.getLogicalLength(0, 0));
  const before = f.info().paraCount;
  quiet(() => f.host.replaceFootnoteSelection(null, { operationType: 'pasteInFootnote', paste: true, allowCollapsed: true }));
  const info = f.wasm.getFootnoteInfo(ref.sectionIdx, ref.paraIdx, ref.controlIdx);
  assert.equal(info.paraCount, before);
  assert.match(info.noteText, /본문입니다/);
  assert.equal(markers(), 1, '주석 안에 주석이 생기지 않는다');
});

// ─── 캐럿 경계 (한컴 c02a·c02c·c02e·c02f) ────────────────────────────

test('주석 캐럿 0 은 번호 앞이다: Home·처음으로 가고, 그 앞에 친 글은 번호 앞에 들어간다', () => {
  const f = noteFixture('abc');
  assert.ok(f.start >= 1, '새 주석의 캐럿은 번호 뒤다');
  assert.deepEqual(f.info().numbers, [{ fnParaIndex: 0, charOffset: 0 }]);
  press(f.host, 'Home');
  assert.equal(f.host.cursor.fnCharOffset, 0, 'Home 은 번호 앞으로 간다');
  press(f.host, 'ArrowLeft');
  assert.equal(f.host.cursor.fnCharOffset, 0, '번호 앞에서 왼쪽은 그대로다');
  press(f.host, 'Backspace');
  assert.equal(f.host.history.canUndo(), false, '번호 앞 Backspace 는 아무것도 하지 않는다');
  type(f.host, 'X');
  assert.equal(f.info().units[0][0], 'X');
  assert.deepEqual(f.info().numbers, [{ fnParaIndex: 0, charOffset: 1 }], '번호는 그대로 남는다');
});

test('주석 마지막 문단 끝 Delete·오른쪽은 그대로이고, 번호 앞 Enter 는 번호를 둘째 문단으로 내린다', () => {
  const f = noteFixture('abc');
  const end = f.info().lengths[0];
  quiet(() => f.host.cursor.setFnCursorPosition(0, end));
  press(f.host, 'Delete');
  press(f.host, 'ArrowRight');
  assert.equal(f.host.history.canUndo(), false);
  assert.equal(f.host.cursor.fnCharOffset, end);
  quiet(() => f.host.cursor.setFnCursorPosition(0, 0));
  press(f.host, 'Enter');
  const info = f.info();
  assert.equal(info.paraCount, 2);
  assert.equal(info.lengths[0], 0);
  assert.deepEqual(info.numbers, [{ fnParaIndex: 1, charOffset: 0 }]);
  assert.deepEqual([f.host.cursor.fnInnerParaIdx, f.host.cursor.fnCharOffset], [1, 0]);
});

test('주석 안 모두 선택은 그 주석의 문단만 고르고, 지우면 번호 없는 빈 문단이 남는다', () => {
  const f = noteFixture('abc');
  press(f.host, 'Enter');
  type(f.host, 'def');
  quiet(() => keyboard.handleSelectAll.call(f.host));
  assert.equal(f.host.cursor.getSelection(), null, '본문은 고르지 않는다');
  const selection = f.host.cursor.getFootnoteSelectionOrdered();
  assert.deepEqual(selection?.start, { fnParaIdx: 0, charOffset: 0 });
  assert.deepEqual(selection?.end, { fnParaIdx: 1, charOffset: 3 });
  press(f.host, 'Delete');
  const info = f.info();
  assert.equal(info.paraCount, 1);
  assert.deepEqual(info.lengths, [0]);
  assert.deepEqual(info.numbers, []);
});

test('Esc 는 주석을 닫지 않고 선택만 푼다. Shift+Esc 는 새 주석의 표시 뒤로 나간다', () => {
  const f = noteFixture('abc');
  f.select(f.start, f.start + 2);
  press(f.host, 'Escape');
  assert.equal(f.host.cursor.isInFootnote(), true);
  assert.equal(f.host.cursor.getFootnoteSelectionOrdered(), null);
  press(f.host, 'Escape');
  assert.equal(f.host.cursor.isInFootnote(), true);
  press(f.host, 'Escape', { shiftKey: true });
  assert.equal(f.host.cursor.isInFootnote(), false);
  assert.equal(f.host.cursor.getPosition().charOffset, 3, '표시(2) 바로 뒤');
  // 있던 주석에 다시 들어가 닫으면 표시 앞이다.
  quiet(() => f.host.cursor.enterNoteMode(f.ref));
  press(f.host, 'Escape', { shiftKey: true });
  assert.equal(f.host.cursor.getPosition().charOffset, 2);
});

test('주석 안 선택에 굵게를 주면 되돌리기 한 번이고 선택 밖은 그대로다', () => {
  const f = noteFixture('abcdef');
  f.select(f.start, f.start + 3);
  // 새 글자 모양은 되돌린 뒤에도 모양 표에 남으므로 쪽 그림으로 비교한다.
  const before = pagesFingerprint(f.wasm);
  quiet(() => f.host.applyCharFormat({ bold: true }));
  const { sectionIdx, paraIdx, controlIdx } = f.ref;
  assert.equal(f.wasm.getCharPropertiesInFootnote(sectionIdx, paraIdx, controlIdx, 0, f.start).bold, true);
  assert.equal(f.wasm.getCharPropertiesInFootnote(sectionIdx, paraIdx, controlIdx, 0, f.start + 4).bold, false);
  assertUndoRedoRestores(f.host, before, '', pagesFingerprint);
  assert.equal(f.host.cursor.isInFootnote(), true);
});

// ─── 표 셀 안 주석 (한컴 c01: 셀에서 넣은 주석은 그 셀에 든다) ───────────────

test('표 셀에서 넣은 각주는 그 셀에 들고, 들어가 편집하고 되돌릴 수 있다', () => {
  const wasm = env.newDocument();
  wasm.insertText(0, 0, 0, '앞');
  const table = wasm.createTable(0, 0, 1, 1, 2);
  const cellPos = {
    sectionIndex: 0, paragraphIndex: 0, charOffset: 0, parentParaIndex: table.paraIdx, controlIndex: table.controlIdx,
    cellIndex: 1, cellParaIndex: 0, cellPath: [{ controlIndex: table.controlIdx, cellIndex: 1, cellParaIndex: 0 }],
  };
  wasm.insertTextInCellByPath(0, table.paraIdx, JSON.stringify(cellPos.cellPath), 0, '셀');
  const host = env.createHost(wasm);
  Object.assign(host, { caret: caretStub, textareaConsumed: 0 });
  host.cursor.moveTo({ ...cellPos, charOffset: 1 });
  const before = documentFingerprint(wasm);
  insertNote(host);
  assert.equal(host.cursor.isInFootnote(), true);
  assert.deepEqual(host.cursor.fnCellPath, cellPos.cellPath);
  type(host, '셀 각주');
  const notes = wasm.listNotes();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].sourceType, 'table');
  assert.equal(notes[0].noteText, '셀 각주');
  assert.equal(wasm.getTextInCellByPath(0, table.paraIdx, JSON.stringify(cellPos.cellPath), 0, 1), '셀');
  press(host, 'Escape', { shiftKey: true });
  assert.equal(host.cursor.isInFootnote(), false);
  assert.deepEqual(host.cursor.getPosition().cellPath, cellPos.cellPath, '셀 안 표시 뒤로 나온다');
  assert.equal(host.cursor.getPosition().charOffset, 2);
  assert.equal(undoSteps(host), 2);
  assert.equal(documentFingerprint(wasm), before);
});

test('주석·머리말 안에서는 각주·미주를 넣지 않는다', () => {
  const f = noteFixture('abc');
  const count = f.wasm.listNotes().length;
  insertNote(f.host, 'endnote');
  assert.equal(f.wasm.listNotes().length, count);
  const command = insertCommands.find((c: any) => c.id === 'insert:footnote');
  assert.equal(command.canExecute({ hasDocument: true, inNote: true }), false);
  assert.equal(command.canExecute({ hasDocument: true, inHeaderFooter: true }), false);
  assert.equal(command.canExecute({ hasDocument: true, inNote: false, inHeaderFooter: false }), true);
});
