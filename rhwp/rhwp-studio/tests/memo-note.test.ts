import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { commandServices, startEditEngine } from './support/edit-history-env.ts';

// 메모(풍선 주석) 넣기·고치기·지우기가 실제 WASM 엔진과 편집 라우터에서 실행 취소 한 칸으로
// 남고, HWP/HWPX 로 저장해 다시 열어도 사용자가 본 메모가 그대로인지 확인한다.

const env = await startEditEngine();
test.after(() => env.close());

const [edits, { memoCommands, memoContextMenuItems, setMemoOverlay }] = await Promise.all([
  env.load('/src/core/memo-edits.ts'),
  env.load('/src/command/commands/memo.ts'),
]);

const SAMPLE = new URL('../../samples/basic/NewYear_s_Day.hwp', import.meta.url);

function open() {
  const wasm = env.openDocument(new Uint8Array(readFileSync(SAMPLE)), 'NewYear_s_Day.hwp');
  const host = env.createHost(wasm);
  return { wasm, host };
}

type Memo = { fieldId: number; text: string; author: string; anchorText: string };

function memos(wasm: any): Memo[] {
  return wasm.getMemoNoteList();
}

function visible(wasm: any): string[] {
  return memos(wasm).map((m) => `${m.author}|${m.anchorText}|${m.text}`).sort();
}

/** 개체·필드가 없는 본문 문단 — 새 메모를 달 자리. */
function plainParagraph(wasm: any): { para: number; text: string } {
  const count = wasm.getParagraphCount(0);
  for (let para = 0; para < count; para++) {
    const len = wasm.getParagraphLength(0, para);
    if (len < 4) continue;
    const text = wasm.getTextRange(0, para, 0, len);
    try {
      const context = wasm.getHyperlinkContext({ section: 0, para, cellPath: [] });
      if (context.text === text && memos(wasm).every((m: any) => m.anchor?.paraIdx !== para)) {
        return { para, text };
      }
    } catch { /* 개체가 있는 문단은 건너뛴다 */ }
  }
  throw new Error('plain paragraph not found');
}

function reload(bytes: Uint8Array, name: string) {
  return env.openDocument(bytes, name);
}

test('메모 넣기는 실행 취소 한 칸이고 HWP/HWPX 저장 뒤에도 남는다', () => {
  const { wasm, host } = open();
  const before = memos(wasm).length;
  assert.equal(before, 9, 'NewYear 에는 메모 9개가 있다');
  const { para, text } = plainParagraph(wasm);
  // 앱은 document-changed/document-mutated 로 수정 표시를 켠다 (document-session.ts).
  let changes = 0;
  host.eventBus.on('document-changed', () => { changes += 1; });
  host.eventBus.on('document-mutated', () => { changes += 1; });
  const fieldId = edits.commitMemoInsert(host, { sectionIdx: 0, paraIdx: para }, 0, 3, '새 메모', '검토자');
  assert.equal(typeof fieldId, 'number');
  const inserted = memos(wasm).find((m) => m.fieldId === fieldId);
  assert.ok(inserted);
  assert.equal(inserted!.text, '새 메모');
  assert.equal(inserted!.anchorText, Array.from(text).slice(0, 3).join(''));
  assert.equal(host.history.canUndo(), true, '수정 기록이 남아야 한다');
  assert.ok(changes > 0, '수정 표시가 켜져야 한다');

  host.handleUndo();
  assert.equal(memos(wasm).length, before, 'undo 하면 새 메모가 없다');
  host.handleRedo();
  assert.equal(memos(wasm).length, before + 1, 'redo 하면 새 메모가 돌아온다');

  const expected = visible(wasm);
  assert.deepEqual(visible(reload(wasm.exportHwp(), 'saved.hwp')), expected, 'HWP 저장본');
  assert.deepEqual(visible(reload(wasm.exportHwpx(), 'saved.hwpx')), expected, 'HWPX 저장본');
});

test('빈 새 메모는 문서와 기록을 바꾸지 않는다', () => {
  const { wasm, host } = open();
  const { para } = plainParagraph(wasm);
  assert.equal(edits.commitMemoInsert(host, { sectionIdx: 0, paraIdx: para }, 0, 3, '  '), null);
  assert.equal(memos(wasm).length, 9);
  assert.equal(host.history.canUndo(), false);
});

test('메모 고치기와 지우기는 각각 실행 취소된다', () => {
  const { wasm, host } = open();
  const first = memos(wasm)[0];

  assert.equal(edits.commitMemoEdit(host, wasm, first.fieldId, '고친 본문\n둘째 줄'), true);
  assert.equal(memos(wasm)[0].text, '고친 본문\n둘째 줄');
  host.handleUndo();
  assert.equal(memos(wasm)[0].text, first.text, 'undo 하면 원래 본문');
  host.handleRedo();
  assert.equal(memos(wasm)[0].text, '고친 본문\n둘째 줄');
  assert.equal(edits.commitMemoEdit(host, wasm, first.fieldId, '고친 본문\n둘째 줄'), false, '같은 글은 기록하지 않는다');

  const command = memoCommands.find((c: any) => c.id === 'memo:delete');
  command.execute(commandServices(host), { fieldId: first.fieldId });
  assert.equal(memos(wasm).length, 8);
  assert.ok(memos(wasm).every((m) => m.fieldId !== first.fieldId));
  host.handleUndo();
  assert.equal(memos(wasm).length, 9, 'undo 하면 지운 메모가 돌아온다');

  const expected = visible(wasm);
  assert.deepEqual(visible(reload(wasm.exportHwp(), 'saved.hwp')), expected, 'HWP 저장본');
  assert.deepEqual(visible(reload(wasm.exportHwpx(), 'saved.hwpx')), expected, 'HWPX 저장본');
});

test('모든 메모 지우기는 한 칸으로 되돌아간다', () => {
  const { wasm, host } = open();
  assert.equal(edits.commitMemoDeleteAll(host), 9);
  assert.equal(memos(wasm).length, 0);
  assert.equal(memos(reload(wasm.exportHwp(), 'saved.hwp')).length, 0, '저장본에도 메모가 없다');
  host.handleUndo();
  assert.equal(memos(wasm).length, 9);
});

function caretInto(host: any, memo: any) {
  host.cursor.moveTo({ sectionIndex: 0, paragraphIndex: memo.anchor.paraIdx, charOffset: memo.anchor.startCharIdx + 1 });
}

test('우클릭 메뉴는 그 메모를 항목에 싣고, 메뉴를 닫은 뒤 팔레트의 지우기는 캐럿의 메모를 지운다', () => {
  const { wasm, host } = open();
  const [a, b] = memos(wasm) as any[];
  const services = commandServices(host);
  // 메모 A 앵커를 우클릭해 메뉴를 만들고, 고르지 않고 닫는다.
  const items = memoContextMenuItems(a.fieldId);
  assert.deepEqual(items.map((item: any) => [item.commandId, item.params]), [
    ['memo:edit', { fieldId: a.fieldId }],
    ['memo:delete', { fieldId: a.fieldId }],
  ]);
  // 캐럿을 메모 B 앵커에 두고 팔레트에서 메모 지우기.
  caretInto(host, b);
  const del = memoCommands.find((c: any) => c.id === 'memo:delete');
  del.execute(services);
  assert.ok(memos(wasm).some((m) => m.fieldId === a.fieldId), 'A 는 남는다');
  assert.ok(memos(wasm).every((m) => m.fieldId !== b.fieldId), 'B 가 지워진다');
  // 메뉴 항목으로 고르면 우클릭한 A 가 지워진다.
  del.execute(services, items[1].params);
  assert.ok(memos(wasm).every((m) => m.fieldId !== a.fieldId));
});

test('메모가 달린 낱말에서 메모 넣기는 새 풍선 대신 그 메모를 고친다', () => {
  const { wasm, host } = open();
  const [a] = memos(wasm) as any[];
  const calls: string[] = [];
  setMemoOverlay({
    openDraft: () => calls.push('draft'),
    openEditor: (id: number) => calls.push(`edit:${id}`),
  });
  try {
    caretInto(host, a);
    host.canEditHyperlink = () => true;
    memoCommands.find((c: any) => c.id === 'insert:memo-note').execute(commandServices(host));
    assert.deepEqual(calls, [`edit:${a.fieldId}`]);
  } finally {
    setMemoOverlay(null);
  }
});

test('겹치는 범위는 넣기 전에 사유를 알려 준다', () => {
  const { wasm } = open();
  const [a] = memos(wasm) as any[];
  const path = { sectionIdx: 0, paraIdx: a.anchor.paraIdx };
  assert.match(wasm.checkMemoNoteRange(path, a.anchor.startCharIdx, a.anchor.startCharIdx + 2), /겹치는/);
  assert.equal(wasm.checkMemoNoteRange(path, 0, 2), '', '앵커 앞 글자에는 달 수 있다');
});
