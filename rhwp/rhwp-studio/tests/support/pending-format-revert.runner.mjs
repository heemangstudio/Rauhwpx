// 실제 HeemangEngine(hm-wasm) + WasmBridge + PendingEditManager — 혼합 서식 문단에 건 에이전트 서식의
// 거절과 승인 후 undo 가 글자마다 원래 모양으로 돌아오는지 본다.
import assert from 'node:assert/strict';
import { startEditEngine } from './edit-history-env.ts';

const env = await startEditEngine();
const { EventBus } = await env.load('/src/core/event-bus.ts');
const { PendingEditManager } = await env.load('/src/agent/pending-edits.ts');

const TEXT = '가나다라마바사아자';
const wasm = env.newDocument();
wasm.insertText(0, 0, 0, TEXT);
wasm.applyCharFormat(0, 0, 0, 3, JSON.stringify({ bold: true }));

const recorded = [];
const manager = new PendingEditManager({
  wasm,
  eventBus: new EventBus(),
  editor: {
    getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    executeOperation: (op) => { if (op.kind === 'record') recorded.push(op.command); },
    prepareSnapshotCapacity: () => {},
    retainExternalSnapshot: () => {},
    releaseExternalSnapshot: () => {},
  },
  overlay: { setOps: () => {}, clear: () => {} },
});

const length = [...TEXT].length;
const marks = () => Array.from({ length }, (_, i) => (wasm.getCharPropertiesAt(0, 0, i).bold ? 'B' : '.')).join('');
const runs = () => wasm.getCharShapeRuns(0, 0, 0, length);
const range = () => ({ sectionIdx: 0, startParaIdx: 0, startCharOffset: 0, endParaIdx: 0, endCharOffset: length });

assert.equal(marks(), 'BBB......');
const original = runs();

const rejected = manager.applyCharFormat('claude', range(), { bold: false });
assert.equal(marks(), '.........');
manager.reject(rejected.changeSetId);
assert.equal(marks(), 'BBB......', '거절');
assert.deepEqual(runs(), original);

const approved = manager.applyCharFormat('claude', range(), { bold: false });
assert.equal(manager.approve(approved.changeSetId), true);
assert.equal(marks(), '.........');
assert.equal(recorded.length, 1);
recorded[0].undo(wasm);
assert.equal(marks(), 'BBB......', '승인 후 undo');
assert.deepEqual(runs(), original);
recorded[0].execute(wasm);
assert.equal(marks(), '.........', 'redo');

console.log('PENDING_FORMAT_REVERT_OK');
