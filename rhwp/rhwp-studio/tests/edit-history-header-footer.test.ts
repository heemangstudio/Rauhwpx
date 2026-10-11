import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertUndoRedoRestores,
  commandServices,
  documentFingerprint,
  startEditEngine,
} from './support/edit-history-env.ts';

// 머리말/꼬리말·각주 편집을 실제 WASM 엔진과 실제 편집 라우터로 실행한다.
// 문서가 undo 한 번에 정확히 돌아가는지와 함께, undo/redo 뒤 커서가 어느 편집 영역
// (본문·머리말·각주)에 있어야 하는지도 확인한다.

const env = await startEditEngine();
test.after(() => env.close());

const [{ pageCommands }, { insertCommands }, textInput, keyboard] = await Promise.all([
  env.load('/src/command/commands/page.ts'),
  env.load('/src/command/commands/insert.ts'),
  env.load('/src/engine/input-handler-text.ts'),
  env.load('/src/engine/input-handler-keyboard.ts'),
]);

function run(commands: any[], id: string, host: any, params?: Record<string, unknown>): void {
  const command = commands.find((c) => c.id === id);
  assert.ok(command, `${id} 명령이 있어야 한다`);
  command.execute(commandServices(host), params);
}

function quiet<T>(fn: () => T): T {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try { return fn(); } finally { Object.assign(console, { log, warn, error }); }
}

/** 본문 한 줄과 '양 쪽' 머리말 한 줄이 있는 문서. */
function headerDocument(headerText = '머리말') {
  const wasm = env.newDocument();
  wasm.insertText(0, 0, 0, '본문');
  wasm.createHeaderFooter(0, true, 0);
  if (headerText) wasm.insertTextInHeaderFooter(0, true, 0, 0, 0, headerText);
  return wasm;
}

function headerParaLength(wasm: any, para = 0): number {
  return JSON.parse(wasm.getHeaderFooterParaInfo(0, true, 0, para)).charCount;
}

/** '양 쪽' 머리말 전체 글자(문단은 줄바꿈으로 잇는다). */
function headerText(wasm: any): string {
  const paras = JSON.parse(wasm.getHeaderFooterParaInfo(0, true, 0, 0)).paraCount;
  const last = paras - 1;
  return wasm.copySelectionInHeaderFooter(0, true, 0, 0, 0, last, headerParaLength(wasm, last)).text;
}

/** 머리말 편집 중인 호스트. 캐럿은 문단 para 의 offset 에 둔다. */
function headerHost(wasm: any, para = 0, offset = 0) {
  const host = env.createHost(wasm);
  quiet(() => {
    host.cursor.enterHeaderFooterMode(true, 0, 0, 0);
    host.cursor.setHfCursorPosition(para, offset);
  });
  return host;
}

function hfCaret(host: any) {
  return {
    inHeader: host.cursor.isInHeaderFooter(),
    para: host.cursor.hfParaIdx,
    offset: host.cursor.hfCharOffset,
  };
}

// ─── 각주·미주 삽입 ────────────────────────────────────────────────

for (const kind of ['footnote', 'endnote'] as const) {
  test(`insert:${kind} 는 undo 한 칸이고 undo 하면 노트 편집을 빠져나와 본문으로 돌아간다`, () => {
    const wasm = env.newDocument();
    wasm.insertText(0, 0, 0, '각주 자리');
    const host = env.createHost(wasm);
    const bodyPos = { sectionIndex: 0, paragraphIndex: 0, charOffset: 2 };
    host.cursor.moveTo(bodyPos);
    const before = documentFingerprint(wasm);
    quiet(() => run(insertCommands, `insert:${kind}`, host));
    assert.equal(host.cursor.isInFootnote(), true, '삽입 뒤 노트 편집으로 들어간다');
    assertUndoRedoRestores(host, before);
    quiet(() => host.handleUndo());
    assert.equal(host.cursor.isInFootnote(), false, 'undo 는 노트 편집을 빠져나온다');
    assert.deepEqual(host.cursor.getPosition(), bodyPos);
  });

  test(`insert:${kind} 실패는 이력도 노트 편집 진입도 남기지 않는다`, () => {
    const wasm = env.newDocument();
    wasm.insertText(0, 0, 0, '각주 자리');
    const method = kind === 'footnote' ? 'insertFootnote' : 'insertEndnote';
    wasm[method] = () => ({ ok: false, paraIdx: 0, controlIdx: 0 });
    const host = env.createHost(wasm);
    const before = documentFingerprint(wasm);
    try { quiet(() => run(insertCommands, `insert:${kind}`, host)); } catch { /* 실패는 호출부로 전파될 수 있다 */ }
    assert.equal(host.history.canUndo(), false, '실패한 삽입은 이력에 남지 않는다');
    assert.equal(host.cursor.isInFootnote(), false, '실패하면 노트 편집으로 들어가지 않는다');
    assert.equal(documentFingerprint(wasm), before);
  });
}

// ─── 머리말/꼬리말 만들기 · 마당 · 지우기 ────────────────────────────

test('page:header-create 는 머리말 생성을 undo 한 칸으로 남기고 undo 하면 본문으로 돌아간다', () => {
  const wasm = env.newDocument();
  wasm.insertText(0, 0, 0, '본문');
  const host = env.createHost(wasm);
  const before = documentFingerprint(wasm);
  quiet(() => run(pageCommands, 'page:header-create', host));
  assert.equal(host.cursor.isInHeaderFooter(), true);
  assert.equal(JSON.parse(wasm.getHeaderFooter(0, true, 0)).exists, true);
  assertUndoRedoRestores(host, before);
  quiet(() => host.handleUndo());
  assert.equal(host.cursor.isInHeaderFooter(), false, 'undo 는 머리말 편집을 빠져나온다');
  assert.equal(JSON.parse(wasm.getHeaderFooter(0, true, 0)).exists, false);
});

test('page:apply-hf-template 는 마당 적용을 undo 한 칸으로 남기고, 실패하면 이력을 남기지 않는다', () => {
  const wasm = headerDocument();
  const host = env.createHost(wasm);
  const before = documentFingerprint(wasm);
  quiet(() => run(pageCommands, 'page:apply-hf-template', host, { isHeader: 'true', applyTo: '0', templateId: '1' }));
  assertUndoRedoRestores(host, before);

  const failing = headerDocument();
  failing.applyHfTemplate = () => ({ ok: false });
  const failingHost = env.createHost(failing);
  const failingBefore = documentFingerprint(failing);
  quiet(() => run(pageCommands, 'page:apply-hf-template', failingHost, { isHeader: 'true', applyTo: '0', templateId: '1' }));
  assert.equal(failingHost.history.canUndo(), false, '실패한 마당 적용은 이력에 남지 않는다');
  assert.equal(documentFingerprint(failing), failingBefore);
});

test('page:headerfooter-delete 는 머리말 삭제를 undo 한 칸으로 남긴다', () => {
  const wasm = headerDocument();
  const host = env.createHost(wasm);
  quiet(() => host.cursor.enterHeaderFooterMode(true, 0, 0, 0));
  const before = documentFingerprint(wasm);
  quiet(() => run(pageCommands, 'page:headerfooter-delete', host));
  assert.equal(JSON.parse(wasm.getHeaderFooter(0, true, 0)).exists, false);
  assertUndoRedoRestores(host, before);
});

for (const id of ['page:hide-headerfooter', 'page:hide-current']) {
  test(`${id} 감추기는 이력에 남지 않지만 문서 변경은 알린다`, () => {
    const wasm = headerDocument();
    const host = env.createHost(wasm);
    if (id === 'page:hide-headerfooter') quiet(() => host.cursor.enterHeaderFooterMode(true, 0, 0, 0));
    const page = quiet(() => wasm.renderPageSvg(0));
    let changed = 0;
    host.eventBus.on('document-changed', () => { changed++; });
    quiet(() => run(pageCommands, id, host));
    assert.notEqual(wasm.renderPageSvg(0), page, '감춘 머리말은 화면에서 사라진다');
    assert.equal(host.history.canUndo(), false, '세션 상태라 이력에 남기지 않는다');
    assert.ok(changed > 0, '저장 표시를 위해 문서 변경을 알린다');
  });
}

// ─── 머리말 필드 삽입 ──────────────────────────────────────────────

test('page:insert-field-pagenum 은 필드만 undo 로 지우고 머리말 편집 위치를 지킨다', () => {
  const wasm = headerDocument('머리말');
  const host = headerHost(wasm, 0, 2);
  const before = documentFingerprint(wasm);
  quiet(() => run(pageCommands, 'page:insert-field-pagenum', host));
  const afterCaret = hfCaret(host);
  assert.equal(afterCaret.inHeader, true);
  assert.ok(afterCaret.offset > 2, '캐럿은 필드 뒤로 간다');
  assertUndoRedoRestores(host, before);
  assert.deepEqual(hfCaret(host), afterCaret, 'redo 뒤 캐럿은 필드 뒤 머리말 안이다');
  quiet(() => host.handleUndo());
  assert.equal(headerText(wasm), '머리말', 'undo 는 필드만 지운다');
  assert.deepEqual(hfCaret(host), { inHeader: true, para: 0, offset: 2 }, 'undo 뒤에도 머리말 편집 위치에 남는다');
  assert.equal(host.history.canUndo(), false);
});

test('page:insert-field-pagenum 이 실패하면 이력을 남기지 않는다', () => {
  const wasm = headerDocument('머리말');
  wasm.insertFieldInHf = () => ({ ok: false, charOffset: 0, insertedAt: 0, insertedLength: 0 });
  const host = headerHost(wasm, 0, 2);
  quiet(() => run(pageCommands, 'page:insert-field-pagenum', host));
  assert.equal(host.history.canUndo(), false);
});

// ─── 머리말·각주 안 입력 (타자·IME·Backspace·Delete·Enter·문단 병합) ─────────

const caretStub = {
  hide() {}, show() {}, hideComposition() {}, beginEraseMotion() {}, endEraseMotion() {},
};

function key(name: string, extra: Record<string, unknown> = {}) {
  return {
    key: name, code: name, keyCode: 0, isComposing: false,
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    preventDefault() {}, stopPropagation() {},
    ...extra,
  };
}

/** 사용자가 키를 누른 것처럼 실제 onKeyDown 을 돌린다. */
function press(host: any, name: string): void {
  quiet(() => keyboard.onKeyDown.call(host, key(name)));
}

/** textarea 에 글자가 들어온 것처럼 실제 onInput 을 돌린다. */
function type(host: any, text: string): void {
  host.textarea.value += text;
  quiet(() => textInput.onInput.call(host, { inputType: 'insertText', data: text, isComposing: false }));
}

/** IME 조합 한 번(시작 → 갱신 → 확정)을 실제 조합 처리기로 돌린다. */
function compose(host: any, text: string): void {
  quiet(() => {
    textInput.onCompositionStart.call(host);
    host.textarea.value += text;
    textInput.onCompositionUpdate.call(host, { data: text });
    textInput.onCompositionEnd.call(host, { data: text });
  });
}

type Region = 'header' | 'footnote';

/**
 * 두 문단짜리 머리말 또는 각주를 만들고 그 안을 편집 중인 호스트를 돌려준다.
 * 첫 문단에는 astral 문자('😀')를 넣고, 둘째 문단은 가운데 정렬로 문단 모양을 달리한다.
 */
function regionFixture(region: Region) {
  const wasm = env.newDocument();
  wasm.insertText(0, 0, 0, '본문');
  const host = env.createHost(wasm);
  Object.assign(host, { caret: caretStub, textareaConsumed: 0 });
  if (region === 'header') {
    wasm.createHeaderFooter(0, true, 0);
    wasm.insertTextInHeaderFooter(0, true, 0, 0, 0, '머리😀말');
    wasm.splitParagraphInHeaderFooter(0, true, 0, 0, 4);
    wasm.insertTextInHeaderFooter(0, true, 0, 1, 0, '둘째');
    wasm.applyParaFormatInHf(0, true, 0, 1, JSON.stringify({ alignment: 'center' }));
    const at = (para: number, offset: number) => quiet(() => {
      if (!host.cursor.isInHeaderFooter()) host.cursor.enterHeaderFooterMode(true, 0, 0, 0);
      host.cursor.setHfCursorPosition(para, offset);
    });
    const where = () => ({ inRegion: host.cursor.isInHeaderFooter(), para: host.cursor.hfParaIdx, offset: host.cursor.hfCharOffset });
    return { wasm, host, at, where, start: 0, firstLength: 4 };
  }
  const note = wasm.insertFootnote(0, 0, 2);
  const info = wasm.getNoteEditInfo(0, note.paraIdx, note.controlIdx);
  const start = info.charOffset; // 각주 번호 뒤 첫 편집 위치
  wasm.insertTextInFootnote(0, note.paraIdx, note.controlIdx, 0, start, '각주😀글');
  wasm.splitParagraphInFootnote(0, note.paraIdx, note.controlIdx, 0, start + 4);
  wasm.insertTextInFootnote(0, note.paraIdx, note.controlIdx, 1, 0, '둘째');
  wasm.applyParaFormatInFootnote(0, note.paraIdx, note.controlIdx, 1, JSON.stringify({ alignment: 'center' }));
  const at = (para: number, offset: number) => quiet(() => {
    if (!host.cursor.isInFootnote()) {
      host.cursor.moveTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 2 });
      host.cursor.enterFootnoteMode(0, note.paraIdx, note.controlIdx, info.footnoteIndex ?? 0, info.pageNum ?? 0);
    }
    host.cursor.setFnCursorPosition(para, offset);
  });
  const where = () => ({ inRegion: host.cursor.isInFootnote(), para: host.cursor.fnInnerParaIdx, offset: host.cursor.fnCharOffset });
  const texts = () => wasm.getFootnoteInfo(0, note.paraIdx, note.controlIdx).texts;
  return { wasm, host, at, where, start, firstLength: [...texts()[0]].length, note };
}

const regionEdits: Array<{ name: string; caret: (f: ReturnType<typeof regionFixture>) => [number, number]; act: (host: any) => void }> = [
  { name: '타자', caret: (f) => [0, f.start + 1], act: (host) => type(host, '가') },
  { name: 'IME 확정', caret: (f) => [0, f.start + 1], act: (host) => compose(host, '한') },
  { name: 'Backspace 로 astral 문자 지우기', caret: (f) => [0, f.start + 3], act: (host) => press(host, 'Backspace') },
  { name: 'Delete 로 astral 문자 지우기', caret: (f) => [0, f.start + 2], act: (host) => press(host, 'Delete') },
  { name: 'Enter 문단 나누기', caret: (f) => [0, f.start + 1], act: (host) => press(host, 'Enter') },
  { name: 'Backspace 문단 병합', caret: () => [1, 0], act: (host) => press(host, 'Backspace') },
  { name: 'Delete 문단 병합', caret: (f) => [0, f.start + 4], act: (host) => press(host, 'Delete') },
];

for (const region of ['header', 'footnote'] as const) {
  for (const edit of regionEdits) {
    test(`${region === 'header' ? '머리말' : '각주'} ${edit.name}: undo 한 칸이고 편집 영역에 머문다`, () => {
      const f = regionFixture(region);
      f.at(...edit.caret(f));
      const caretBefore = f.where();
      const before = documentFingerprint(f.wasm);
      edit.act(f.host);
      const after = documentFingerprint(f.wasm);
      assert.notEqual(after, before, '편집이 문서를 바꿔야 한다');
      quiet(() => f.host.handleUndo());
      assert.equal(documentFingerprint(f.wasm), before, 'undo 한 번이 글자·문단 모양까지 정확히 되돌린다');
      assert.equal(f.host.history.canUndo(), false, '편집 하나는 이력 한 칸이다');
      assert.deepEqual(f.where(), caretBefore, 'undo 뒤 캐럿은 편집 전 자리로 돌아간다');
      quiet(() => f.host.handleRedo());
      assert.equal(documentFingerprint(f.wasm), after);
      assert.equal(f.where().inRegion, true, 'redo 뒤에도 편집 영역에 머문다');
    });
  }
}

test('각주 마지막 문단 끝 Delete 는 지울 것이 없으면 이력을 남기지 않는다', () => {
  const f = regionFixture('footnote');
  const last = f.wasm.getFootnoteInfo(0, f.note!.paraIdx, f.note!.controlIdx).texts[1];
  f.at(1, [...last].length);
  const before = documentFingerprint(f.wasm);
  press(f.host, 'Delete');
  assert.equal(f.host.history.canUndo(), false);
  assert.equal(documentFingerprint(f.wasm), before);
});

// ─── 머리말 선택 범위 편집 ────────────────────────────────────────

/** '머리말입니다' 머리말에서 [2, 5) 를 선택한 호스트. */
function headerSelectionFixture() {
  const wasm = headerDocument('머리말입니다');
  const host = headerHost(wasm, 0, 5);
  Object.assign(host, { caret: caretStub, textareaConsumed: 0 });
  const point = (charOffset: number) => ({ sectionIdx: 0, isHeader: true, applyTo: 0, paraIdx: 0, charOffset });
  const select = () => quiet(() => host.cursor.selectHeaderFooterRange(point(2), point(5), host.cursor.hfPreviewPage));
  select();
  const selection = () => {
    const ordered = host.cursor.getHeaderFooterSelectionOrdered();
    return ordered ? [ordered.start.charOffset, ordered.end.charOffset] : null;
  };
  return { wasm, host, select, selection };
}

function clipboardEvent(data: Record<string, string> = {}) {
  const store = { ...data };
  return {
    store,
    preventDefault() {},
    clipboardData: {
      setData(type: string, value: string) { store[type] = value; },
      getData(type: string) { return store[type] ?? ''; },
    },
  };
}

for (const { name, act, expected } of [
  { name: 'Delete', act: (host: any) => press(host, 'Delete'), expected: '머리다' },
  { name: '타자', act: (host: any) => type(host, '가'), expected: '머리가다' },
  { name: 'IME', act: (host: any) => compose(host, '한'), expected: '머리한다' },
  { name: '붙여넣기', act: (host: any) => quiet(() => keyboard.onPaste.call(host, clipboardEvent({ 'text/plain': '붙임' }))), expected: '머리붙임다' },
]) {
  test(`머리말 선택 위 ${name}: 선택 치환이 undo 한 칸이다`, () => {
    const f = headerSelectionFixture();
    const before = documentFingerprint(f.wasm);
    act(f.host);
    assert.equal(headerText(f.wasm), expected);
    if (name !== 'IME') assertUndoRedoRestores(f.host, before, name);
    quiet(() => f.host.handleUndo());
    assert.equal(headerText(f.wasm), '머리말입니다');
    assert.equal(f.host.history.canUndo(), false, '선택 삭제와 입력은 한 칸으로 묶인다');
    assert.equal(f.host.cursor.isInHeaderFooter(), true);
    if (name === 'Delete') assert.deepEqual(f.selection(), [2, 5], '선택 삭제 undo 는 선택을 되살린다');
  });
}

// 조합 시작 때 찍힌 snapshot 이 확정 글자를 담지 못해 redo 가 '머리다' 로 돌아간다.
test('머리말 선택 위 IME: redo 는 확정한 글자까지 되살린다', { todo: 'redo 가 조합 시작 시점 snapshot 을 복원해 확정 글자를 잃는다' }, () => {
  const f = headerSelectionFixture();
  compose(f.host, '한');
  quiet(() => f.host.handleUndo());
  quiet(() => f.host.handleRedo());
  assert.equal(headerText(f.wasm), '머리한다');
});

test('머리말 선택 복사는 이력을 남기지 않고, 잘라내기는 undo 한 칸이다', () => {
  const f = headerSelectionFixture();
  const copy = clipboardEvent();
  quiet(() => keyboard.onCopy.call(f.host, copy));
  assert.equal(copy.store['text/plain'], '말입니');
  assert.equal(f.host.history.canUndo(), false);

  const before = documentFingerprint(f.wasm);
  const cut = clipboardEvent();
  quiet(() => keyboard.onCut.call(f.host, cut));
  assert.equal(cut.store['text/plain'], '말입니');
  assert.equal(headerText(f.wasm), '머리다');
  assertUndoRedoRestores(f.host, before);
});

test('머리말 부분 글자 서식은 undo 한 칸이고 redo 뒤에도 같은 선택을 유지한다', () => {
  const f = headerSelectionFixture();
  const before = documentFingerprint(f.wasm);
  quiet(() => f.host.applyCharFormat({ bold: true }));
  assert.equal(f.wasm.getCharPropertiesInHeaderFooter(0, true, 0, 0, 3).bold, true);
  assert.equal(f.wasm.getCharPropertiesInHeaderFooter(0, true, 0, 0, 0).bold, false, '선택 밖은 그대로다');
  assertUndoRedoRestores(f.host, before);
  assert.deepEqual(f.selection(), [2, 5], 'redo 뒤 선택이 그대로 남는다');
  assert.equal(f.host.cursor.isInHeaderFooter(), true);
});
