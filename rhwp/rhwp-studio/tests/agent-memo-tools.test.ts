import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startEditEngine } from './support/edit-history-env.ts';

// 에이전트 메모 도구(list_memos/set_memo)를 실제 WASM 엔진과 대기 편집
// 관리자로 돌린다. 에이전트 모드에서는 검토 대기로 남고, 거절하면 문서가 그대로이며, 승인하면
// 저장본까지 남는다.

const env = await startEditEngine();
test.after(() => env.close());

const [{ AgentToolExecutor }, { PendingEditManager }, { RevisionTracker }, { EventBus }] = await Promise.all([
  env.load('/src/agent/tool-executor.ts'),
  env.load('/src/agent/pending-edits.ts'),
  env.load('/src/agent/revision.ts'),
  env.load('/src/core/event-bus.ts'),
]);

const SAMPLE = new URL('../../samples/basic/NewYear_s_Day.hwp', import.meta.url);

function setup() {
  const wasm = env.openDocument(new Uint8Array(readFileSync(SAMPLE)), 'NewYear_s_Day.hwp');
  const bus = new EventBus();
  const revision = new RevisionTracker(bus);
  const editor = {
    executeOperation: (op: { operation?: (w: unknown) => unknown }) => { op.operation?.(wasm); },
    getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    getSelection: () => null,
    prepareSnapshotCapacity: () => {},
    retainExternalSnapshot: () => {},
    releaseExternalSnapshot: () => {},
  };
  const pending = new PendingEditManager({
    wasm, eventBus: bus, editor, overlay: { setOps: () => {}, clear: () => {} },
  });
  const executor = new AgentToolExecutor({
    wasm, editor, documentState: { isDirty: () => false }, revision, pending,
  });
  const call = (tool: string, args: Record<string, unknown> = {}) =>
    executor.execute(tool, { expectedRevision: revision.revision, ...args }, 'claude') as Promise<any>;
  return { wasm, pending, revision, call };
}

/** 메모가 없는 첫 본문 문단 (개체 없는 글자 4자 이상). */
function plainParagraph(wasm: any): number {
  const anchored = new Set(wasm.getMemoNoteList().map((m: any) => m.anchor?.paraIdx));
  for (let para = 0; para < wasm.getParagraphCount(0); para++) {
    if (anchored.has(para) || wasm.getParagraphLength(0, para) < 4) continue;
    try {
      const text = wasm.getTextRange(0, para, 0, wasm.getParagraphLength(0, para));
      if (wasm.getHyperlinkContext({ section: 0, para, cellPath: [] }).text === text) return para;
    } catch { /* 개체 문단 */ }
  }
  throw new Error('plain paragraph not found');
}

const texts = (wasm: any) => wasm.getMemoNoteList().map((m: any) => m.text).sort();

test('list_memos returns every memo body with its anchor', async () => {
  const { call, revision } = setup();
  const result = await call('list_memos');
  assert.equal(result.revision, revision.revision);
  assert.equal(result.memos.length, 9);
  for (const memo of result.memos) {
    assert.ok(memo.text.length > 0, 'memo body');
    assert.equal(typeof memo.fieldId, 'number');
    assert.ok(memo.anchor && memo.anchor.endOffset >= memo.anchor.startOffset);
  }
});

test('set_memo insert stays staged for review; reject removes it and approve keeps it through save', async () => {
  for (const outcome of ['reject', 'approve'] as const) {
    const { wasm, pending, call } = setup();
    const before = texts(wasm);
    pending.beginTurn('claude');
    const paraIdx = plainParagraph(wasm);
    const inserted = await call('set_memo', { op: 'insert', sectionIdx: 0, paraIdx, startOffset: 0, endOffset: 3, text: '검토할 메모', render: 'crop' });
    assert.equal(typeof inserted.fieldId, 'number');
    assert.equal(pending.hasPending(), true, 'the memo waits for review');
    assert.deepEqual(pending.pendingMemoFieldIds(), [inserted.fieldId]);
    pending.endTurn('review');
    const [set] = pending.getChangeSets();
    if (outcome === 'reject') {
      pending.reject(set.id);
      assert.deepEqual(texts(wasm), before, 'rejecting leaves no memo behind');
    } else {
      assert.equal(pending.approve(set.id), true);
      const after = texts(wasm);
      assert.ok(after.includes('검토할 메모'));
      assert.equal(wasm.getMemoNoteList().find((m: any) => m.fieldId === inserted.fieldId)?.author, 'Claude', 'the agent signs its memo');
      assert.deepEqual(texts(env.openDocument(wasm.exportHwp(), 'a.hwp')), after, 'HWP save');
      assert.deepEqual(texts(env.openDocument(wasm.exportHwpx(), 'a.hwpx')), after, 'HWPX save');
    }
    assert.equal(pending.hasPending(), false);
  }
});

test('set_memo edit and delete are staged and reverted exactly on reject', async () => {
  const { wasm, pending, call } = setup();
  const before = wasm.getMemoNoteList();
  const [first, second] = before;
  pending.beginTurn('claude');
  await call('set_memo', { op: 'edit', fieldId: first.fieldId, text: '고친 메모\n둘째 줄' });
  await call('set_memo', { op: 'delete', fieldId: second.fieldId });
  const now = wasm.getMemoNoteList();
  assert.equal(now.length, before.length - 1);
  assert.equal(now.find((m: any) => m.fieldId === first.fieldId)?.text, '고친 메모\n둘째 줄');
  pending.endTurn('review');
  pending.reject(pending.getChangeSets()[0].id);
  assert.deepEqual(wasm.getMemoNoteList(), before, 'author, time, body and anchor all come back');
});

test('memo writes check the revision and the memo id', async () => {
  const { call, revision } = setup();
  await assert.rejects(
    call('set_memo', { op: 'delete', fieldId: 1, expectedRevision: revision.revision - 1 }),
    (error: any) => error.code === 'REVISION_MISMATCH',
  );
  await assert.rejects(call('set_memo', { op: 'edit', fieldId: 999999, text: 'x' }), (error: any) => error.code === 'MEMO_NOT_FOUND');
  await assert.rejects(
    call('set_memo', { op: 'insert', sectionIdx: 0, paraIdx: 0, startOffset: 2, endOffset: 2, text: 'x' }),
    (error: any) => error.code === 'INVALID_ARGS',
  );
});

test('in 전체 mode set_memo commits right away', async () => {
  const { wasm, pending, call } = setup();
  pending.setDirectApply(true);
  pending.beginTurn('claude');
  const paraIdx = plainParagraph(wasm);
  await call('set_memo', { op: 'insert', sectionIdx: 0, paraIdx, startOffset: 0, endOffset: 2, text: '바로 들어간 메모' });
  pending.endTurn('commit');
  assert.equal(pending.hasPending(), false);
  assert.deepEqual(pending.pendingMemoFieldIds(), []);
  assert.ok(texts(wasm).includes('바로 들어간 메모'));
});
