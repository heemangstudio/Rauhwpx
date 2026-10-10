import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertUndoRedoRestores,
  commandServices,
  documentFingerprint,
  pagesFingerprint,
  startEditEngine,
} from './support/edit-history-env.ts';

// 메뉴·명령·드래그 같은 사용자 조작을 실제 WASM 엔진과 실제 편집 라우터로 실행하고,
// 결과가 이력 한 칸으로 남아 undo 한 번에 정확히 되돌아가는지 확인한다.
// 이력을 우회한 편집은 undo 뒤에도 문서가 그대로라 여기서 실패한다.

const env = await startEditEngine();
test.after(() => env.close());

const [
  { tableCommands }, { pageCommands }, { insertCommands }, { editCommands }, textInput, keyboard,
  { FieldInsertDialog }, { FieldEditDialog }, { HWPJSON_PASTE_MAX_CHARS }, picture, mouse,
] = await Promise.all([
  env.load('/src/command/commands/table.ts'),
  env.load('/src/command/commands/page.ts'),
  env.load('/src/command/commands/insert.ts'),
  env.load('/src/command/commands/edit.ts'),
  env.load('/src/engine/input-handler-text.ts'),
  env.load('/src/engine/input-handler-keyboard.ts'),
  env.load('/src/ui/field-insert-dialog.ts'),
  env.load('/src/ui/field-edit-dialog.ts'),
  env.load('/src/engine/office-html-sanitize.ts'),
  env.load('/src/engine/input-handler-picture.ts'),
  env.load('/src/engine/input-handler-mouse.ts'),
]);

function run(commands: any[], id: string, host: any, params?: Record<string, unknown>, extra = {}): void {
  const command = commands.find((c) => c.id === id);
  assert.ok(command, `${id} 명령이 있어야 한다`);
  command.execute(commandServices(host, extra), params);
}

function quiet<T>(fn: () => T): T {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try { return fn(); } finally { Object.assign(console, { log, warn, error }); }
}

/** 표 하나가 있는 문서와 그 셀 좌표를 만든다. */
function tableDocument(rows: number, cols: number, cells: Record<number, string> = {}) {
  const wasm = env.newDocument();
  const table = wasm.createTableEx({ sectionIdx: 0, paraIdx: 0, charOffset: 0, rowCount: rows, colCount: cols });
  assert.equal(table.ok, true);
  for (const [cellIndex, text] of Object.entries(cells)) {
    wasm.insertTextInCell(0, table.paraIdx, table.controlIdx, Number(cellIndex), 0, 0, text);
  }
  const cellPos = (cellIndex: number, charOffset = 0) => ({
    sectionIndex: 0,
    paragraphIndex: 0,
    charOffset,
    parentParaIndex: table.paraIdx,
    controlIndex: table.controlIdx,
    cellIndex,
    cellParaIndex: 0,
    cellPath: [{ controlIndex: table.controlIdx, cellIndex, cellParaIndex: 0 }],
  });
  const cellText = (cellIndex: number) => {
    const len = wasm.getCellParagraphLength(0, table.paraIdx, table.controlIdx, cellIndex, 0);
    return len > 0 ? wasm.getTextInCell(0, table.paraIdx, table.controlIdx, cellIndex, 0, 0, len) : '';
  };
  return { wasm, table, cellPos, cellText };
}

// ─── 표: 셀 숫자 서식 ─────────────────────────────────────────────

for (const { id, from, to } of [
  { id: 'table:thousand-sep', from: '1234567', to: '1,234,567' },
  { id: 'table:decimal-add', from: '1234567', to: '1234567.0' },
  { id: 'table:decimal-remove', from: '12.34', to: '12.3' },
]) {
  test(`${id} 는 셀 숫자 서식을 undo 한 칸으로 바꾼다`, () => {
    const doc = tableDocument(1, 1, { 0: from });
    const host = env.createHost(doc.wasm);
    host.cursor.moveTo(doc.cellPos(0, from.length));
    const before = documentFingerprint(doc.wasm);
    run(tableCommands, id, host);
    assert.equal(doc.cellText(0), to);
    assertUndoRedoRestores(host, before);
    host.handleUndo();
    assert.equal(doc.cellText(0), from, '서식 전 셀 값이 손상 없이 돌아와야 한다');
    assert.equal(host.history.canUndo(), false, '서식은 이력 한 칸이다');
  });
}

// ─── 표: 블록 계산 ────────────────────────────────────────────────

for (const { id, result } of [
  { id: 'table:block-sum', result: '6' },
  { id: 'table:block-avg', result: '3' },
  { id: 'table:block-product', result: '8' },
]) {
  test(`${id} 는 계산 결과를 셀에 쓰고 undo 한 칸으로 되돌린다`, () => {
    // 한 열 표: 위 두 칸이 2, 4 이고 맨 아래 칸에 결과가 들어간다.
    const doc = tableDocument(3, 1, { 0: '2', 1: '4' });
    const host = env.createHost(doc.wasm);
    host.cursor.moveTo(doc.cellPos(2));
    const before = documentFingerprint(doc.wasm);
    quiet(() => run(tableCommands, id, host));
    assert.equal(doc.cellText(2), result);
    assertUndoRedoRestores(host, before);
  });
}

// ─── 쪽: 다단 설정 · 문단 감추기 ───────────────────────────────────

for (const id of ['page:col-2', 'page:col-left', 'page:col-right']) {
  test(`${id} 다단 설정은 undo 한 칸으로 되돌아간다`, () => {
    const wasm = env.newDocument();
    wasm.insertText(0, 0, 0, '다단 본문');
    const host = env.createHost(wasm);
    const before = documentFingerprint(wasm);
    run(pageCommands, id, host);
    assert.equal(wasm.getColumnDef(0).columnCount, 2);
    assertUndoRedoRestores(host, before);
  });
}

test('page:hide 문단 감추기는 undo 한 칸으로 되돌아간다', () => {
  const wasm = env.newDocument();
  wasm.insertText(0, 0, 0, '감출 쪽 번호');
  const host = env.createHost(wasm);
  const before = documentFingerprint(wasm);
  run(pageCommands, 'page:hide', host);
  assert.equal(wasm.getPageHide(0, 0).exists, true);
  assertUndoRedoRestores(host, before);
  host.handleUndo();
  assert.equal(wasm.getPageHide(0, 0).exists, false);
});

// ─── 개체: 메뉴 조작(정렬·지우기·묶기·회전·대칭) ─────────────────────

const PNG_1PX = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
));


function addShape(wasm: any, offset: number) {
  const shape = wasm.createShapeControl({
    sectionIdx: 0, paraIdx: 0, charOffset: 0,
    width: 6000, height: 4000, horzOffset: 1000 + offset, vertOffset: 1000 + offset,
    shapeType: 'rectangle',
  });
  assert.equal(shape.ok, true);
  return shape;
}

function addPicture(wasm: any) {
  const picture = wasm.insertPicture(0, 0, 0, '', PNG_1PX, 4000, 4000, 1, 1, 'png');
  assert.equal(picture.ok, true);
  return picture;
}

/** 개체를 고른 상태에서 메뉴 명령을 실행하고 undo 한 칸을 확인한다. */
function assertObjectCommandUndoable(
  id: string, wasm: any, select: (host: any) => void, label = '', fingerprint = documentFingerprint,
): void {
  const host = env.createHost(wasm);
  quiet(() => select(host));
  const before = fingerprint(wasm);
  quiet(() => run(insertCommands, id, host));
  const after = fingerprint(wasm);
  assert.notEqual(after, before, `${id} ${label} 편집이 문서를 바꾸지 않았다`);
  quiet(() => host.handleUndo());
  assert.equal(fingerprint(wasm), before, `${id} ${label} undo 가 편집 전 문서를 되살리지 못했다`);
  quiet(() => host.handleRedo());
  assert.equal(fingerprint(wasm), after, `${id} ${label} redo 가 편집 후 문서를 되살리지 못했다`);
}

/** 저장될 내용만 비교한다. */
function savedContent(wasm: any): string {
  return Buffer.from(wasm.exportHwpx()).toString('base64');
}

for (const id of ['insert:arrange-front', 'insert:arrange-back']) {
  test(`${id} 개체 순서 변경은 undo 한 칸이다`, () => {
    const wasm = env.newDocument();
    const first = addShape(wasm, 0);
    const second = addShape(wasm, 500);
    const target = id === 'insert:arrange-front' ? first : second;
    assertObjectCommandUndoable(id, wasm, (host) => host.cursor.enterPictureObjectSelectionDirect(0, target.paraIdx, target.controlIdx, 'shape'));
  });
}

test('insert:picture-delete 는 도형·수식·그림·셀 그림 지우기를 각각 undo 한 칸으로 남긴다', () => {
  const shapeDoc = env.newDocument();
  const shape = addShape(shapeDoc, 0);
  assertObjectCommandUndoable('insert:picture-delete', shapeDoc, (host) =>
    host.cursor.enterPictureObjectSelectionDirect(0, shape.paraIdx, shape.controlIdx, 'shape'));

  const equationDoc = env.newDocument();
  const equation = equationDoc.insertEquation(0, 0, 0, 'a+b', 1000, 0);
  assert.equal(equation.ok, true);
  assertObjectCommandUndoable('insert:picture-delete', equationDoc, (host) =>
    host.cursor.enterPictureObjectSelectionDirect(0, equation.paraIdx, equation.controlIdx, 'equation'), 'equation');

  const pictureDoc = env.newDocument();
  const picture = addPicture(pictureDoc);
  assertObjectCommandUndoable('insert:picture-delete', pictureDoc, (host) =>
    host.cursor.enterPictureObjectSelectionDirect(0, picture.paraIdx, picture.controlIdx, 'image'), 'picture');

  const cellDoc = tableDocument(1, 1);
  const cellPath = [{ controlIndex: cellDoc.table.controlIdx, cellIndex: 0, cellParaIndex: 0 }];
  const cellPicture = cellDoc.wasm.insertPicture(
    0, cellDoc.table.paraIdx, 0, JSON.stringify(cellPath), PNG_1PX, 2000, 2000, 1, 1, 'png', '', undefined, undefined, 'inline',
  );
  assert.equal(cellPicture.ok, true);
  assertObjectCommandUndoable('insert:picture-delete', cellDoc.wasm, (host) =>
    host.cursor.enterPictureObjectSelectionRef({
      sec: 0, ppi: cellDoc.table.paraIdx, ci: cellPicture.controlIdx, type: 'image',
      cellPath: cellPicture.cellPath ?? cellPath,
    }), 'cell', savedContent); // 셀 그림 삭제 직후 엔진이 셀 높이를 다시 재지 않아 화면은 저장 내용으로만 비교한다.
});

test('insert:group-shapes 와 insert:ungroup-shapes 는 각각 undo 한 칸이다', () => {
  const wasm = env.newDocument();
  const first = addShape(wasm, 0);
  const second = addShape(wasm, 3000);
  assertObjectCommandUndoable('insert:group-shapes', wasm, (host) => {
    host.cursor.togglePictureObjectSelection(0, first.paraIdx, first.controlIdx, 'shape');
    host.cursor.togglePictureObjectSelection(0, second.paraIdx, second.controlIdx, 'shape');
  });

  const groupedDoc = env.newDocument();
  const a = addShape(groupedDoc, 0);
  const b = addShape(groupedDoc, 3000);
  const group = groupedDoc.groupShapes(0, [{ paraIdx: a.paraIdx, controlIdx: a.controlIdx }, { paraIdx: b.paraIdx, controlIdx: b.controlIdx }]);
  assert.equal(group.ok, true);
  assertObjectCommandUndoable('insert:ungroup-shapes', groupedDoc, (host) =>
    host.cursor.enterPictureObjectSelectionDirect(0, group.paraIdx, group.controlIdx, 'group'));
});

for (const id of ['insert:rotate-cw', 'insert:flip-horz']) {
  test(`${id} 는 그림과 도형 모두 undo 한 칸이다`, () => {
    const pictureDoc = env.newDocument();
    const picture = addPicture(pictureDoc);
    assertObjectCommandUndoable(id, pictureDoc, (host) =>
      host.cursor.enterPictureObjectSelectionDirect(0, picture.paraIdx, picture.controlIdx, 'image'));
    const shapeDoc = env.newDocument();
    const shape = addShape(shapeDoc, 0);
    assertObjectCommandUndoable(id, shapeDoc, (host) =>
      host.cursor.enterPictureObjectSelectionDirect(0, shape.paraIdx, shape.controlIdx, 'shape'));
  });
}

// ─── 접힌 캐럿의 글자 서식(다음 입력 예약) ─────────────────────────────

const caretStub = { hide() {}, show() {}, hideComposition() {}, beginEraseMotion() {}, endEraseMotion() {} };

function textHost(wasm: any) {
  const host = env.createHost(wasm);
  Object.assign(host, { caret: caretStub, textareaConsumed: 0 });
  return host;
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

function bodyText(wasm: any): string {
  return wasm.getTextRange(0, 0, 0, wasm.getParagraphLength(0, 0));
}

for (const { path, input } of [
  { path: '타자', input: type },
  { path: 'IME 확정', input: compose },
]) {
  test(`접힌 캐럿 굵게는 이력 없이 예약되고 다음 ${path} 글자에 실려 undo 한 칸이 된다`, () => {
    const wasm = env.newDocument();
    wasm.insertText(0, 0, 0, '가나');
    const host = textHost(wasm);
    quiet(() => {
      host.cursor.moveTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 1 });
      host.cursor.setAnchor(); // 클릭 직후처럼 anchor 만 있는 접힌 선택
    });
    const before = documentFingerprint(wasm);
    quiet(() => host.applyCharFormat({ bold: true }));
    assert.equal(host.history.canUndo(), false, '예약은 이력에 남지 않는다');
    assert.equal(documentFingerprint(wasm), before, '예약은 문서를 바꾸지 않는다');
    assert.equal(host.getCharPropertiesAtCursor().bold, true, '툴바는 예약 서식을 보여 준다');
    host.cursor.clearSelection(); // 단순 클릭의 mouseup 이 접힌 anchor 를 지운다

    const pagesBefore = pagesFingerprint(wasm);
    input(host, '다');
    assert.equal(bodyText(wasm), '가다나');
    assert.equal(wasm.getCharPropertiesAt(0, 0, 1).bold, true, '입력한 글자가 굵다');
    assert.equal(wasm.getCharPropertiesAt(0, 0, 0).bold, false, '앞 글자는 그대로다');
    assertUndoRedoRestores(host, pagesBefore, path, pagesFingerprint);
    assert.equal(wasm.getCharPropertiesAt(0, 0, 1).bold, true, 'redo 도 서식을 다시 입힌다');
    quiet(() => host.handleUndo());
    assert.equal(bodyText(wasm), '가나');
    assert.equal(host.history.canUndo(), false, '서식 실린 입력은 이력 한 칸이다');
  });
}

test('펼친 선택의 굵게는 바로 적용되고 undo 한 칸이다', () => {
  const wasm = env.newDocument();
  wasm.insertText(0, 0, 0, '가나다');
  const host = textHost(wasm);
  quiet(() => {
    host.cursor.moveTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 });
    host.cursor.setAnchor();
    host.cursor.moveTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 2 });
  });
  const before = pagesFingerprint(wasm);
  quiet(() => host.applyCharFormat({ bold: true }));
  assert.equal(wasm.getCharPropertiesAt(0, 0, 1).bold, true);
  assert.equal(wasm.getCharPropertiesAt(0, 0, 2).bold, false);
  assertUndoRedoRestores(host, before, '', pagesFingerprint);
  quiet(() => host.handleUndo());
  assert.equal(wasm.getCharPropertiesAt(0, 0, 1).bold, false);
});

// ─── 누름틀 넣기 · 고치기 · 지우기 ──────────────────────────────────

/** 대화상자 화면만 건너뛰고 사용자가 확인을 누른 값으로 onApply 를 부른다. */
function answerDialog(Dialog: any, method: string, props: Record<string, unknown>): () => void {
  const original = Dialog.prototype[method];
  Dialog.prototype[method] = function () { this.onApply?.(props); };
  return () => { Dialog.prototype[method] = original; };
}

const FIELD_PROPS = { guide: '이름을 넣으세요', memo: '', name: '이름', editable: true };

function fieldDocument() {
  const wasm = env.newDocument();
  wasm.insertText(0, 0, 0, '앞뒤');
  const field = wasm.insertClickHereField({ sectionIndex: 0, paragraphIndex: 0, charOffset: 1 }, '안내', '', '이름', true);
  assert.equal(field.ok, true);
  const host = textHost(wasm);
  Object.assign(host, { fieldMarker: { hide() {}, show() {} } });
  const inside = { sectionIndex: 0, paragraphIndex: 0, charOffset: 1 }; // 빈 누름틀(안내문 표시) 안
  assert.equal(wasm.getFieldInfoAt(inside).inField, true);
  quiet(() => host.cursor.moveTo(inside));
  return { wasm, host, fieldId: field.fieldId };
}

test('insert:field 누름틀 넣기는 undo 한 칸이고, 엔진이 거부하면 이력을 남기지 않는다', () => {
  const restore = answerDialog(FieldInsertDialog, 'show', FIELD_PROPS);
  try {
    const wasm = env.newDocument();
    wasm.insertText(0, 0, 0, '앞뒤');
    const host = textHost(wasm);
    quiet(() => host.cursor.moveTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 1 }));
    const before = documentFingerprint(wasm);
    quiet(() => run(insertCommands, 'insert:field', host));
    assert.ok(wasm.getFieldList().some((f: any) => f.name === '이름'), '누름틀이 들어간다');
    assertUndoRedoRestores(host, before);

    const refused = env.newDocument();
    refused.insertText(0, 0, 0, '앞뒤');
    refused.insertClickHereField = () => ({ ok: false });
    const refusedHost = textHost(refused);
    quiet(() => run(insertCommands, 'insert:field', refusedHost));
    assert.equal(refusedHost.history.canUndo(), false);
  } finally {
    restore();
  }
});

function editFieldGuide() {
  const restore = answerDialog(FieldEditDialog, 'showWith', { ...FIELD_PROPS, guide: '새 안내문' });
  try {
    const doc = fieldDocument();
    const before = documentFingerprint(doc.wasm);
    quiet(() => run(editCommands, 'field:edit', doc.host));
    assert.equal(doc.wasm.getClickHereProps(doc.fieldId).guide, '새 안내문');
    return { ...doc, before };
  } finally {
    restore();
  }
}

test('field:edit 누름틀 고치기는 이력 한 칸으로 남는다', () => {
  const { host } = editFieldGuide();
  assert.equal(host.history.canUndo(), true, '고치기는 되돌리기 이력에 들어간다');
  quiet(() => host.handleUndo());
  assert.equal(host.history.canUndo(), false, '이력은 한 칸이다');
});

// 엔진의 restoreSnapshot 이 updateClickHereProps 로 바뀐 안내문을 되돌리지 않는다.
test('field:edit 를 undo 하면 이전 안내문이 돌아온다', { todo: 'restoreSnapshot 이 누름틀 속성 변경을 되돌리지 않는다' }, () => {
  const { wasm, host, fieldId, before } = editFieldGuide();
  assertUndoRedoRestores(host, before);
  quiet(() => host.handleUndo());
  assert.equal(wasm.getClickHereProps(fieldId).guide, '안내');
});

test('누름틀 지우기(removeCurrentField)는 undo 한 칸이다', () => {
  const { wasm, host } = fieldDocument();
  const before = documentFingerprint(wasm);
  quiet(() => host.removeCurrentField());
  assert.equal(wasm.getFieldInfoAt({ sectionIndex: 0, paragraphIndex: 0, charOffset: 1 }).inField, false);
  assertUndoRedoRestores(host, before);
});

// ─── 외부 붙여넣기(한글 문서모델 · HTML) ─────────────────────────────

const HWPJSON_MODEL = readFileSync(new URL('../../samples/hwpjson/clipboard-model.json', import.meta.url), 'utf8');
const PASTED_MODEL_TEXT = '공개 클립보드 표본';

function hangulClipboardHtml(model: string): string {
  return `<html><body><p>HTML 본문</p></body></html><!--[data-hwpjson] ${model} -->`;
}

function paste(host: any, data: Record<string, string>): void {
  const store = { ...data };
  quiet(() => keyboard.onPaste.call(host, {
    preventDefault() {},
    clipboardData: { getData: (type: string) => store[type] ?? '', setData() {} },
  }));
}

/** '가나다라' 에서 '나다' 를 고른 호스트. */
function selectedBody() {
  const wasm = env.newDocument();
  wasm.insertText(0, 0, 0, '가나다라');
  const host = textHost(wasm);
  quiet(() => {
    host.cursor.moveTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 1 });
    host.cursor.setAnchor();
    host.cursor.moveTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 3 });
  });
  const selection = () => {
    const ordered = host.cursor.getSelectionOrdered();
    return ordered ? [ordered.start.charOffset, ordered.end.charOffset] : null;
  };
  return { wasm, host, selection };
}

test('한글 문서모델 붙여넣기는 선택 지우기와 붙여넣기를 undo 한 칸으로 묶는다', () => {
  const { wasm, host } = selectedBody();
  const before = documentFingerprint(wasm);
  paste(host, { 'text/html': hangulClipboardHtml(HWPJSON_MODEL), 'text/plain': 'HTML 본문' });
  assert.equal(bodyText(wasm), `가${PASTED_MODEL_TEXT}라`);
  assertUndoRedoRestores(host, before);
  quiet(() => host.handleUndo());
  assert.equal(bodyText(wasm), '가나다라');
  assert.equal(host.history.canUndo(), false);
});

test('문서모델을 엔진이 거부하면 그 시도는 흔적 없이 되돌리고 HTML 붙여넣기 한 칸만 남는다', () => {
  const { wasm, host } = selectedBody();
  const before = documentFingerprint(wasm);
  paste(host, { 'text/html': hangulClipboardHtml('{"ro": 깨진 모델'), 'text/plain': 'HTML 본문' });
  assert.equal(bodyText(wasm), '가HTML 본문라', '선택은 HTML 내용으로 한 번만 바뀐다');
  quiet(() => host.handleUndo());
  assert.equal(documentFingerprint(wasm), before);
  assert.equal(host.history.canUndo(), false, '실패한 문서모델 시도는 이력에 남지 않는다');
});

test('HTML 붙여넣기가 실패하면 문서와 선택이 그대로이고 이력도 없다', () => {
  const { wasm, host, selection } = selectedBody();
  wasm.pasteHtml = () => JSON.stringify({ ok: false, error: '거절' });
  const before = documentFingerprint(wasm);
  paste(host, { 'text/html': '<p>HTML 본문</p>' });
  assert.equal(documentFingerprint(wasm), before);
  assert.deepEqual(selection(), [1, 3], '선택이 남아 있다');
  assert.equal(host.history.canUndo(), false);
});

test('한도를 넘는 문서모델은 엔진에 넘기지 않는다', () => {
  const { wasm, host } = selectedBody();
  let modelCalls = 0;
  wasm.pasteHwpJson = () => { modelCalls++; return JSON.stringify({ ok: false }); };
  const oversized = `{"ro":"${'x'.repeat(HWPJSON_PASTE_MAX_CHARS)}"}`;
  paste(host, { 'text/html': hangulClipboardHtml(oversized), 'text/plain': 'HTML 본문' });
  assert.equal(modelCalls, 0);
});

test('표 칸 안에서는 문서모델 대신 HTML 경로로 붙여넣고 undo 한 칸이다', () => {
  const doc = tableDocument(1, 1, { 0: '칸' });
  const host = textHost(doc.wasm);
  let modelCalls = 0;
  const pasteHwpJson = doc.wasm.pasteHwpJson.bind(doc.wasm);
  doc.wasm.pasteHwpJson = (...args: unknown[]) => { modelCalls++; return pasteHwpJson(...args); };
  quiet(() => host.cursor.moveTo(doc.cellPos(0, 1)));
  const before = documentFingerprint(doc.wasm);
  paste(host, { 'text/html': hangulClipboardHtml(HWPJSON_MODEL), 'text/plain': 'HTML 본문' });
  assert.equal(modelCalls, 0);
  assert.match(doc.cellText(0), /HTML 본문/);
  assertUndoRedoRestores(host, before);
});

// ─── 양식 개체 값(체크박스 · 라디오 · 콤보 · 입력 칸) ────────────────────

const FORM_BYTES = readFileSync(new URL('../../samples/form-01.hwp', import.meta.url));
// form-01.hwp: 문단 2 체크박스(켜짐), 4 콤보(봄·여름·가을·겨울), 6 라디오, 8 입력 칸

/** 오버레이가 쓰는 만큼만 흉내 낸 DOM 요소. */
class FakeElement {
  style: Record<string, string> = {};
  className = '';
  textContent = '';
  value = '';
  type = '';
  children: FakeElement[] = [];
  listeners: Record<string, Array<(e: any) => void>> = {};
  addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener() {}
  fire(type: string, event: Record<string, unknown> = {}) {
    for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {}, ...event });
  }
  appendChild(child: FakeElement) { this.children.push(child); return child; }
  contains() { return true; }
  remove() {}
  focus() {}
  select() {}
}

function formHost() {
  const wasm = env.openDocument(FORM_BYTES, 'form-01.hwp');
  const host = textHost(wasm);
  let overlay: FakeElement | null = null;
  Object.assign(host, {
    editMode: 'form',
    container: { querySelector: () => null, appendChild: (el: FakeElement) => { overlay = el; } },
    viewportManager: { getZoom: () => 1 },
    virtualScroll: { getPageOffset: () => 0, getPageLeftResolved: () => 0 },
    formOverlay: null,
  });
  const value = (para: number) => wasm.getFormObjectInfo(0, para, 0);
  return { wasm, host, value, overlay: () => overlay };
}

function clickForm(host: any, para: number, ci: number, formType: string, extra: Record<string, unknown> = {}) {
  const info = host.wasm.getFormObjectInfo(0, para, ci);
  quiet(() => host.handleFormObjectClick({
    found: true, sec: 0, para, ci, formType, value: info.value, text: info.text,
    bbox: { x: 0, y: 0, w: 100, h: 20 }, ...extra,
  }, 0, 1));
}

function withFakeDocument<T>(run: () => T): T {
  const saved = { document: (globalThis as any).document, raf: (globalThis as any).requestAnimationFrame };
  Object.assign(globalThis, {
    document: { createElement: () => new FakeElement(), addEventListener() {}, removeEventListener() {} },
    requestAnimationFrame: () => 0,
  });
  try { return run(); } finally {
    Object.assign(globalThis, { document: saved.document, requestAnimationFrame: saved.raf });
  }
}

test('양식 체크박스 클릭은 양식 모드에서도 undo 한 칸이다', () => {
  const { wasm, host, value } = formHost();
  const before = documentFingerprint(wasm);
  clickForm(host, 2, 0, 'CheckBox');
  assert.equal(value(2).value, 0);
  assertUndoRedoRestores(host, before);
  quiet(() => host.handleUndo());
  assert.equal(value(2).value, 1);
});

test('라디오 클릭은 같은 그룹의 해제와 선택을 undo 한 칸으로 되돌리고, 이미 켜진 라디오 재클릭은 이력을 남기지 않는다', () => {
  const { wasm, host } = formHost();
  // 같은 문단에 같은 그룹 라디오를 하나 더 만들고 첫 번째를 켠다.
  wasm.copySelection(0, 6, 0, 6, 0);
  wasm.pasteInternal(0, 6, 0);
  assert.equal(wasm.getFormObjectInfo(0, 6, 1).formType, 'RadioButton');
  wasm.setFormValue(0, 6, 0, JSON.stringify({ value: 1 }));
  const radios = () => [0, 1].map((ci) => wasm.getFormObjectInfo(0, 6, ci).value);

  const before = documentFingerprint(wasm);
  clickForm(host, 6, 1, 'RadioButton');
  assert.deepEqual(radios(), [0, 1]);
  assertUndoRedoRestores(host, before);
  quiet(() => host.handleUndo());
  assert.deepEqual(radios(), [1, 0], 'undo 한 번이 그룹 전체를 되돌린다');
  assert.equal(host.history.canUndo(), false);

  clickForm(host, 6, 0, 'RadioButton');
  assert.equal(host.history.canUndo(), false, '값이 그대로인 클릭은 기록하지 않는다');
});

test('콤보 항목 선택은 undo 한 칸이다', () => withFakeDocument(() => {
  const { wasm, host, value, overlay } = formHost();
  const before = documentFingerprint(wasm);
  clickForm(host, 4, 0, 'ComboBox');
  const row = overlay()!.children.find((el) => el.textContent === '여름');
  assert.ok(row);
  quiet(() => row!.fire('mousedown'));
  assert.equal(value(4).text, '여름');
  assertUndoRedoRestores(host, before);
}));

test('입력 칸 Enter 확정은 undo 한 칸이고, Escape 는 blur 가 뒤따라도 취소된다', () => withFakeDocument(() => {
  const { wasm, host, value, overlay } = formHost();
  const before = documentFingerprint(wasm);
  clickForm(host, 8, 0, 'Edit');
  const input = overlay()!;
  input.value = '홍길동';
  quiet(() => { input.fire('keydown', { key: 'Enter' }); input.fire('blur'); });
  assert.equal(value(8).text, '홍길동');
  assertUndoRedoRestores(host, before);
  quiet(() => host.handleUndo());
  assert.equal(host.history.canUndo(), false, 'Enter 뒤 blur 가 두 번째 기록을 만들지 않는다');

  const cancelled = formHost();
  const cancelledBefore = documentFingerprint(cancelled.wasm);
  clickForm(cancelled.host, 8, 0, 'Edit');
  const cancelledInput = cancelled.overlay()!;
  cancelledInput.value = '버릴 값';
  quiet(() => { cancelledInput.fire('keydown', { key: 'Escape' }); cancelledInput.fire('blur'); });
  assert.equal(documentFingerprint(cancelled.wasm), cancelledBefore);
  assert.equal(cancelled.host.history.canUndo(), false);
}));

// ─── 버전 내용으로 바꾸기 ─────────────────────────────────────────

function savedVersion(text: string): Uint8Array {
  const wasm = env.newDocument();
  wasm.insertText(0, 0, 0, text);
  return wasm.exportHwpx();
}

test('버전 내용 바꾸기는 undo 한 칸이고 콜백은 각 복원 뒤에 돈다', () => {
  const wasm = env.openDocument(savedVersion('지금 문서'), '보고서.hwpx');
  const handle = { name: '보고서.hwpx' };
  wasm.currentFileHandle = handle;
  const host = textHost(wasm);
  const seen: string[] = [];
  const before = documentFingerprint(wasm);
  quiet(() => host.replaceContentFromBytes(savedVersion('지난 버전'), {
    afterUndo: () => seen.push(`undo:${bodyText(wasm)}`),
    afterRedo: () => seen.push(`redo:${bodyText(wasm)}`),
  }));
  assert.equal(bodyText(wasm), '지난 버전');
  assert.equal(wasm.fileName, '보고서.hwpx', '파일 이름은 그대로다');
  assert.equal(wasm.currentFileHandle, handle, '저장할 파일 바인딩도 그대로다');
  assertUndoRedoRestores(host, before);
  assert.deepEqual(seen, ['undo:지금 문서', 'redo:지난 버전']);
  quiet(() => host.handleUndo());
  assert.equal(host.history.canUndo(), false, '바꾸기는 이력 한 칸이다');
});

// ─── 개체 드래그 · 방향키 크기 조절 ─────────────────────────────────
// 쪽 0 이 화면 (0,0) 에 배율 1 로 놓인 것으로 두어 client 좌표가 곧 쪽 px 이다.
// 드래그 상태는 mousedown 처리기가 만드는 것과 같은 값으로 채우고, 종료는 실제 처리기를 부른다.

function pointer(clientX: number, clientY: number, extra: Record<string, unknown> = {}) {
  return { clientX, clientY, button: 0, detail: 1, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
    target: { closest: () => null }, preventDefault() {}, stopPropagation() {}, ...extra };
}

function withPointer<T>(run: () => T): T {
  const saved = ['document', 'requestAnimationFrame', 'cancelAnimationFrame'].map((k) => (globalThis as any)[k]);
  Object.assign(globalThis, {
    document: { createElement: () => new FakeElement(), addEventListener() {}, removeEventListener() {} },
    requestAnimationFrame: (fn: () => void) => { fn(); return 0; },
    cancelAnimationFrame() {},
  });
  try { return run(); } finally {
    Object.assign(globalThis, { document: saved[0], requestAnimationFrame: saved[1], cancelAnimationFrame: saved[2] });
  }
}

function pointerHost(wasm: any) {
  const host = textHost(wasm);
  const scrollContent = { clientWidth: 2000, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  Object.assign(host, {
    container: {
      style: {}, clientWidth: 5000, clientHeight: 5000, scrollTop: 0,
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      querySelector: () => scrollContent,
    },
    viewportManager: { getZoom: () => 1 },
    virtualScroll: {
      getPageAtPoint: () => 0, getPageOffset: () => 0, getPageWidth: () => 800, getPageLeftResolved: () => 0,
      getTotalHeight: () => 5000,
    },
    selectionRenderer: { clear() {} },
    gridStepMm: 3,
  });
  return host;
}

/** mousedown 의 핸들 판정이 만드는 리사이즈 상태. */
function beginResize(host: any, ref: any, dir: string, start: { x: number; y: number }) {
  const bbox = host.findPictureBbox(ref);
  const props = host.getObjectProperties(ref);
  host.isPictureResizeDragging = true;
  host.pictureResizeState = {
    dir, ref: { ...ref },
    origWidth: props.width, origHeight: props.height,
    origHorzOffset: props.horzOffset, origVertOffset: props.vertOffset,
    rotationAngle: props.rotationAngle ?? 0,
    startClientX: start.x, startClientY: start.y,
    pageIndex: bbox.pageIndex, bbox: { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h },
  };
}

/** mousedown 의 회전 핸들 판정이 만드는 회전 상태(시작점은 개체 중심의 오른쪽). */
function beginRotate(host: any, ref: any) {
  const bbox = host.findPictureBbox(ref);
  const props = host.getObjectProperties(ref);
  const center = { x: bbox.x + bbox.w / 2, y: bbox.y + bbox.h / 2 };
  host.isPictureRotateDragging = true;
  host.pictureRotateState = {
    ref: { ...ref }, origAngle: props.rotationAngle ?? 0,
    centerX: center.x, centerY: center.y, startAngle: 0,
    pageIndex: bbox.pageIndex, bbox: { x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h },
    finalAngle: props.rotationAngle ?? 0,
  };
  return center;
}

function assertObjectEditUndoable(host: any, act: () => void, label: string, fingerprint = documentFingerprint): void {
  const before = fingerprint(host.wasm);
  withPointer(() => quiet(act));
  const after = fingerprint(host.wasm);
  assert.notEqual(after, before, `${label}: 문서가 바뀌어야 한다`);
  quiet(() => host.handleUndo());
  assert.equal(fingerprint(host.wasm), before, `${label}: undo 한 번이 정확히 되돌린다`);
  assert.equal(host.history.canUndo(), false, `${label}: 이력 한 칸이다`);
  quiet(() => host.handleRedo());
  assert.equal(fingerprint(host.wasm), after, `${label}: redo 가 다시 적용한다`);
}

function selectedPicture() {
  const wasm = env.newDocument();
  const pic = addPicture(wasm);
  const host = pointerHost(wasm);
  const ref = { sec: 0, ppi: pic.paraIdx, ci: pic.controlIdx, type: 'image' };
  quiet(() => host.cursor.enterPictureObjectSelectionRef(ref));
  return { wasm, host, ref };
}

test('회전 핸들 드래그는 undo 한 칸이다', () => {
  const { host, ref } = selectedPicture();
  assertObjectEditUndoable(host, () => {
    const c = beginRotate(host, ref);
    picture.finishPictureRotateDrag.call(host, pointer(c.x, c.y + 50)); // 중심 아래로 90°
    assert.equal(host.getObjectProperties(ref).rotationAngle, 90);
  }, '회전', pagesFingerprint); // 회전각 기록은 화면을 되돌리지만 저장 바이트의 변환 행렬까지는 아니다
  quiet(() => host.handleUndo());
  assert.equal(host.getObjectProperties(ref).rotationAngle, 0);
});

test('그림 핸들 리사이즈 드래그는 undo 한 칸이다', () => {
  const { host, ref } = selectedPicture();
  assertObjectEditUndoable(host, () => {
    const bbox = host.findPictureBbox(ref);
    const corner = { x: bbox.x + bbox.w, y: bbox.y + bbox.h };
    beginResize(host, ref, 'se', corner);
    picture.finishPictureResizeDrag.call(host, pointer(corner.x + 40, corner.y + 20));
  }, '단일 리사이즈');
});

test('여러 개체를 함께 리사이즈한 드래그도 undo 한 칸이다', () => {
  const wasm = env.newDocument();
  const a = addShape(wasm, 0);
  const b = addShape(wasm, 3000);
  const host = pointerHost(wasm);
  const refs = [a, b].map((s) => ({ sec: 0, ppi: s.paraIdx, ci: s.controlIdx, type: 'shape' }));
  quiet(() => refs.forEach((r) => host.cursor.togglePictureObjectSelection(r)));
  assertObjectEditUndoable(host, () => {
    const boxes = refs.map((r) => host.findPictureBbox(r));
    const minX = Math.min(...boxes.map((x) => x.x)); const minY = Math.min(...boxes.map((x) => x.y));
    const maxX = Math.max(...boxes.map((x) => x.x + x.w)); const maxY = Math.max(...boxes.map((x) => x.y + x.h));
    const multiRefs = refs.map((r, i) => {
      const p = host.getObjectProperties(r);
      return { ...r, origWidth: p.width, origHeight: p.height, origHorzOffset: p.horzOffset, origVertOffset: p.vertOffset, bboxX: boxes[i].x, bboxY: boxes[i].y };
    });
    host.isPictureResizeDragging = true;
    host.pictureResizeState = {
      dir: 'se', ref: multiRefs[0], origWidth: Math.round((maxX - minX) * 75), origHeight: Math.round((maxY - minY) * 75),
      startClientX: maxX, startClientY: maxY, pageIndex: boxes[0].pageIndex,
      bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY }, rotationAngle: 0, multiRefs,
    };
    picture.finishPictureResizeDrag.call(host, pointer(maxX + 30, maxY + 30));
  }, '다중 리사이즈');
});

test('방향키 크기 조절은 undo 한 칸이다', () => {
  const { host } = selectedPicture();
  assertObjectEditUndoable(host, () => picture.resizeSelectedPicture.call(host, 'ArrowRight'), '방향키');
});

test('여러 그림 리사이즈가 중간에 실패하면 앞서 바뀐 그림까지 원래대로 되돌리고 이력을 남기지 않는다', () => {
  const wasm = env.newDocument();
  const pics = [addPicture(wasm), addPicture(wasm)];
  const host = pointerHost(wasm);
  const refs = pics.map((p) => ({ sec: 0, ppi: p.paraIdx, ci: p.controlIdx, type: 'image' }));
  quiet(() => refs.forEach((r) => host.cursor.togglePictureObjectSelection(r)));
  const before = documentFingerprint(wasm);
  const setPictureProperties = wasm.setPictureProperties.bind(wasm);
  let calls = 0;
  wasm.setPictureProperties = (...args: unknown[]) => {
    if (++calls === 2) throw new Error('두 번째 그림을 엔진이 거부했다');
    return setPictureProperties(...args);
  };
  withPointer(() => quiet(() => {
    const boxes = refs.map((r) => host.findPictureBbox(r));
    const minX = Math.min(...boxes.map((x) => x.x)); const minY = Math.min(...boxes.map((x) => x.y));
    const maxX = Math.max(...boxes.map((x) => x.x + x.w)); const maxY = Math.max(...boxes.map((x) => x.y + x.h));
    const multiRefs = refs.map((r, i) => {
      const p = host.getObjectProperties(r);
      return { ...r, origWidth: p.width, origHeight: p.height, origHorzOffset: p.horzOffset, origVertOffset: p.vertOffset, bboxX: boxes[i].x, bboxY: boxes[i].y };
    });
    host.isPictureResizeDragging = true;
    host.pictureResizeState = {
      dir: 'se', ref: multiRefs[0], origWidth: Math.round((maxX - minX) * 75), origHeight: Math.round((maxY - minY) * 75),
      startClientX: maxX, startClientY: maxY, pageIndex: boxes[0].pageIndex,
      bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY }, rotationAngle: 0, multiRefs,
    };
    picture.finishPictureResizeDrag.call(host, pointer(maxX + 30, maxY + 30));
  }));
  assert.equal(calls, 2, '첫 그림은 바뀌고 두 번째에서 실패했다');
  assert.equal(documentFingerprint(wasm), before, '정리가 첫 그림까지 원래대로 돌린다');
  assert.equal(host.history.canUndo(), false);
});

function lineGeometry(host: any, ref: any) {
  const p = host.getObjectProperties(ref);
  return [p.horzOffset, p.vertOffset, p.width, p.height];
}

for (const via of ['finishLineEndpointDrag', 'onMouseUp']) {
  test(`직선 끝점 드래그는 ${via} 로 끝나도 undo 한 칸이다`, () => {
    const wasm = env.newDocument();
    const line = wasm.createShapeControl({
      sectionIdx: 0, paraIdx: 0, charOffset: 0, width: 6000, height: 3000, horzOffset: 1000, vertOffset: 1000, shapeType: 'line',
    });
    assert.equal(line.ok, true);
    const host = pointerHost(wasm);
    const ref = { sec: 0, ppi: line.paraIdx, ci: line.controlIdx, type: 'line' };
    quiet(() => host.cursor.enterPictureObjectSelectionRef(ref));
    const original = lineGeometry(host, ref);
    withPointer(() => quiet(() => {
      const bbox = host.findPictureBbox(ref);
      host.isLineEndpointDragging = true;
      host.lineEndpointState = {
        ref, endpoint: 'end', pageIndex: bbox.pageIndex, pageLeft: 0, pageOffset: 0, zoom: 1,
        orig: { sx: Math.round(bbox.x1 * 75), sy: Math.round(bbox.y1 * 75), ex: Math.round(bbox.x2 * 75), ey: Math.round(bbox.y2 * 75) },
      };
      const drop = pointer(bbox.x2 + 60, bbox.y2 + 40);
      mouse.onMouseMove.call(host, drop);
      if (via === 'onMouseUp') mouse.onMouseUp.call(host, drop);
      else mouse.finishLineEndpointDrag.call(host);
    }));
    const dragged = lineGeometry(host, ref);
    assert.ok(dragged[2] > original[2] + 3000, '끝점이 끌려 직선이 길어졌다');
    assert.equal(host.isLineEndpointDragging, false);
    quiet(() => host.handleUndo());
    assert.equal(host.history.canUndo(), false, '끝점 드래그는 이력 한 칸이다');
    // 시작 끝점을 화면 px(0.1 px 단위)에서 되읽어 HWPUNIT 몇 단위의 오차가 남는다.
    lineGeometry(host, ref).forEach((v, i) => assert.ok(Math.abs(v - original[i]) <= 8, `undo 뒤 직선이 제자리다 (${v} vs ${original[i]})`));
    quiet(() => host.handleRedo());
    assert.deepEqual(lineGeometry(host, ref), dragged);
  });
}

test('도형 클릭이 맨 앞으로 올리는 순서 변경은 undo 한 칸이다', () => {
  const wasm = env.newDocument();
  wasm.insertText(0, 0, 0, '본문');
  const lower = wasm.createShapeControl({
    sectionIdx: 0, paraIdx: 0, charOffset: 0, width: 6000, height: 3000, horzOffset: 1000, vertOffset: 1000, shapeType: 'line',
  });
  addShape(wasm, 4000);
  const host = pointerHost(wasm);
  const ref = { sec: 0, ppi: lower.paraIdx, ci: lower.controlIdx, type: 'line' };
  assertObjectEditUndoable(host, () => {
    const bbox = host.findPictureBbox(ref);
    mouse.onClick.call(host, pointer((bbox.x1 + bbox.x2) / 2, (bbox.y1 + bbox.y2) / 2));
    assert.equal(host.cursor.isInPictureObjectSelection(), true, '클릭한 직선이 선택된다');
  }, '클릭 순서 변경');
});

// ─── 꼬리말 그림 드래그 ───────────────────────────────────────────

let footerPictureBytes: Uint8Array | null = null;

/** 꼬리말에 떠 있는 그림이 있는 한 쪽짜리 문서(hwp3-sample.hwp 의 본문을 비웠다). */
function footerPictureDocument() {
  if (!footerPictureBytes) {
    const source = quiet(() => env.openDocument(readFileSync(new URL('../../samples/hwp3-sample.hwp', import.meta.url)), 'hwp3-sample.hwp'));
    const last = source.getParagraphCount(0) - 1;
    source.deleteRange(0, 0, source.getParagraphLength(0, 0), last, source.getParagraphLength(0, last));
    // 글자처럼 취급하는 그림은 끌어 옮길 수 없으므로 떠 있는 그림으로 바꿔 둔다.
    const hit = source.getPageControlLayout(0).controls.find((c: any) => c.type === 'image' && c.headerFooter);
    source.setHeaderFooterPictureProperties(
      hit.secIdx, hit.headerFooter.outerParaIdx, hit.headerFooter.outerControlIdx, hit.paraIdx, hit.controlIdx, { treatAsChar: false },
    );
    footerPictureBytes = source.exportHwpx();
  }
  const wasm = quiet(() => env.openDocument(footerPictureBytes!, 'footer-picture.hwpx'));
  const hit = wasm.getPageControlLayout(0).controls.find((c: any) => c.type === 'image' && c.headerFooter);
  assert.ok(hit, '꼬리말 그림이 있어야 한다');
  const ref = { sec: hit.secIdx, ppi: hit.paraIdx, ci: hit.controlIdx, type: 'image', headerFooter: hit.headerFooter };
  const host = pointerHost(wasm);
  quiet(() => host.cursor.enterPictureObjectSelectionRef(ref));
  return { wasm, host, ref };
}

test('꼬리말 그림 이동·리사이즈·회전·방향키는 각각 undo 한 칸이고 꼬리말 그림을 되돌린다', () => {
  // 꼬리말 안 문단·컨트롤 번호는 본문과 다른 번호 공간이다. 본문 경로로 되돌리면 실패하거나
  // 같은 번호의 본문 개체를 건드려 아래 비교가 깨진다.
  const cases: Array<[string, (host: any, ref: any) => void, typeof documentFingerprint]> = [
    ['이동', (host, ref) => {
      const b = host.findPictureBbox(ref);
      const from = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      assert.equal(picture.startPictureMoveDrag.call(host, pointer(from.x, from.y), ref, b, b.pageIndex, from.x, from.y), true);
      picture.finishPictureMoveDrag.call(host, pointer(from.x - 40, from.y - 30));
    }, documentFingerprint],
    ['리사이즈', (host, ref) => {
      const b = host.findPictureBbox(ref);
      beginResize(host, ref, 'se', { x: b.x + b.w, y: b.y + b.h });
      picture.finishPictureResizeDrag.call(host, pointer(b.x + b.w + 30, b.y + b.h + 10));
    }, documentFingerprint],
    ['회전', (host, ref) => {
      const c = beginRotate(host, ref);
      picture.finishPictureRotateDrag.call(host, pointer(c.x, c.y + 50));
    }, pagesFingerprint],
    ['방향키', (host) => picture.resizeSelectedPicture.call(host, 'ArrowDown'), documentFingerprint],
  ];
  for (const [label, act, fingerprint] of cases) {
    const { host, ref } = footerPictureDocument();
    const original = JSON.stringify(host.getObjectProperties(ref));
    assertObjectEditUndoable(host, () => act(host, ref), `꼬리말 ${label}`, fingerprint);
    quiet(() => host.handleUndo());
    assert.equal(JSON.stringify(host.getObjectProperties(ref)), original, `꼬리말 ${label}: 그림 속성이 돌아온다`);
  }
});
