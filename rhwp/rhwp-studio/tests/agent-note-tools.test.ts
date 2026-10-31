/**
 * list_footnotes / insert_footnote / edit_footnote — 실제 HeemangEngine 위에서 표 셀·글상자 주석 목록,
 * 번호 뒤에 들어가는 새 주석 글, 다른 가운데만 바꿔 앞부분 서식을 지키는 주석 편집을 본다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startEditEngine } from './support/edit-history-env.ts';

const env = await startEditEngine();
test.after(() => env.close());

const [{ EventBus }, { PendingEditManager }, { AgentToolExecutor }, { RevisionTracker }] = await Promise.all([
  env.load('/src/core/event-bus.ts'),
  env.load('/src/agent/pending-edits.ts'),
  env.load('/src/agent/tool-executor.ts'),
  env.load('/src/agent/revision.ts'),
]);

const NUMBER_UNIT = '\u{FFFC}';

function open(name: string) {
  const wasm = env.openDocument(new Uint8Array(readFileSync(new URL(`../../samples/${name}`, import.meta.url))), name);
  const eventBus = new EventBus();
  const revision = new RevisionTracker(eventBus);
  const editor = {
    getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    getSelection: () => null,
    executeOperation: (op: { operation?: (w: unknown) => void }) => op.operation?.(wasm),
    prepareSnapshotCapacity: () => {},
    retainExternalSnapshot: () => {},
    releaseExternalSnapshot: () => {},
  };
  const pending = new PendingEditManager({ wasm, eventBus, editor, overlay: { setOps: () => {}, clear: () => {} } });
  const executor = new AgentToolExecutor({ wasm, editor, documentState: { isDirty: () => false }, revision, pending });
  const call = (tool: string, args: Record<string, unknown> = {}): Promise<any> =>
    executor.execute(tool, { expectedRevision: revision.revision, ...args }, 'claude');
  return { wasm, pending, call };
}

test('list_footnotes 는 표 셀·글상자 주석까지 종류와 cellPath 로 주고, 그 주소로 edit_footnote 가 고치고 거절로 돌아온다', async () => {
  const tbox = open('footnote-tbox-01.hwp');
  const boxed = (await tbox.call('list_footnotes')).notes;
  assert.deepEqual(boxed.map((n: any) => [n.kind, n.sourceType, n.text, n.cellPath?.length ?? 0]), [
    ['footnote', 'shape', '글상자 내부 각주', 1],
    ['footnote', 'body', '일반 문단내 각주', 0],
  ]);

  const h = open('endnote-01.hwp');
  const listed = (await h.call('list_footnotes')).notes;
  assert.ok(listed.length > 0 && listed.every((n: any) => n.kind === 'endnote'));
  const cell = listed.find((n: any) => n.sourceType === 'table');
  assert.equal(cell?.text, '세 번째 미주는 표안에 넣었습니다.');
  assert.ok(cell.cellPath?.length);
  const textOf = async () => (await h.call('list_footnotes')).notes.find((n: any) => n.number === cell.number).text;

  const edit = await h.call('edit_footnote', {
    sectionIdx: cell.sectionIdx, paraIdx: cell.paraIdx, controlIdx: cell.controlIdx, cellPath: cell.cellPath,
    text: '세 번째 미주는 표 안에 넣었습니다.',
  });
  assert.equal(edit.kind, 'endnote');
  assert.equal(await textOf(), '세 번째 미주는 표 안에 넣었습니다.');
  h.pending.reject(edit.changeSetId);
  assert.equal(await textOf(), '세 번째 미주는 표안에 넣었습니다.');

  // 새 주석 글은 번호 칸 뒤에 들어간다.
  const inserted = await h.call('insert_footnote', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: '새 각주' });
  const info = h.wasm.getFootnoteInfo(0, inserted.anchor.paraIdx, inserted.anchor.controlIdx);
  assert.equal(info.noteText, '새 각주');
  assert.equal(info.units[0][0], NUMBER_UNIT);
});

test('edit_footnote 로 끝 단어만 바꾸면 굵게 한 첫 단어와 번호가 남고, 거절하면 원래 글로 돌아온다', async () => {
  const h = open('footnote-tbox-01.hwp');
  const note = (await h.call('list_footnotes')).notes.find((n: any) => n.sourceType === 'body');
  const at = [note.sectionIdx, note.paraIdx, note.controlIdx] as const;
  const start = h.wasm.getFootnoteInfo(...at).textStart.charOffset;
  h.wasm.applyCharFormatInFootnote(...at, 0, start, start + 2, JSON.stringify({ bold: true })); // "일반"
  const boldAt = (offset: number) => h.wasm.getCharPropertiesInFootnote(...at, 0, offset).bold === true;
  assert.ok(boldAt(start + 1));

  const edit = await h.call('edit_footnote', { sectionIdx: at[0], paraIdx: at[1], controlIdx: at[2], text: '일반 문단내 주석' });
  const info = h.wasm.getFootnoteInfo(...at);
  assert.equal(info.noteText, '일반 문단내 주석');
  assert.equal(info.units[0][0], NUMBER_UNIT, '번호 칸이 그대로 맨 앞이다');
  assert.ok(boldAt(start + 1), '바꾸지 않은 첫 단어의 굵게가 남는다');
  assert.ok(!boldAt(start + 8), '바꾼 끝 단어는 굵게가 아니다');

  h.pending.reject(edit.changeSetId);
  assert.equal(h.wasm.getFootnoteInfo(...at).noteText, '일반 문단내 각주');
  assert.ok(boldAt(start + 1));
});
