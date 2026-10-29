// 실제 HeemangEngine(hm-wasm) 두 문서 + 페이지 퍼사드 + 세션별 CommandHistory + HeadlessEditorHost.
// 화면이 B 로 옮겨 간 동안 A 의 에이전트 편집이 A 의 히스토리에 쌓이고, A 로 돌아와 undo 하면
// A 만 되돌아가는지 본다. InputHandler 는 DOM 이 필요해 여기서는 그 히스토리 호출 경로
// (history.execute/undo(facade))를 그대로 흉내 낸다.
import assert from 'node:assert/strict';
import { startEditEngine } from './edit-history-env.ts';

const engine = await startEditEngine();
const { WasmBridge } = await engine.load('/src/core/wasm-bridge.ts');
const { createAttachableFacade } = await engine.load('/src/core/attachable-facade.ts');
const { InsertTextCommand } = await engine.load('/src/engine/command.ts');
const { HeadlessEditorHost } = await engine.load('/src/engine/headless-editor-host.ts');
const { CommandHistory, EventBus } = engine;

function bridge(text) {
  const wasm = engine.newDocument();
  wasm.insertText(0, 0, 0, text);
  return wasm;
}
const text = (wasm) => wasm.getTextRange(0, 0, 0, wasm.getParagraphLength(0, 0));
const at = (charOffset) => ({ sectionIndex: 0, paragraphIndex: 0, charOffset });

// ── 문서 인스턴스 번호는 페이지의 모든 브리지에서 유일하다 ──
const a = bridge('가나다');
const b = bridge('ABC');
const empty = new WasmBridge();
const instances = [a.documentInstance, b.documentInstance, empty.documentInstance];
assert.equal(new Set(instances).size, 3, `인스턴스 번호가 겹친다: ${instances}`);
empty.releaseDocument();
assert.ok(!instances.includes(empty.documentInstance), '문서를 내리면 어느 브리지와도 겹치지 않는 번호가 된다');

// ── A 를 보고 있다: 사용자가 퍼사드로 입력한다 (InputHandler 경로) ──
const page = createAttachableFacade(a, { stickyKeys: ['onFileNameChanged', 'onExternalImagesInjected'] });
const wasm = page.facade;
const stateA = { history: new CommandHistory(), cursor: null };
const stateB = { history: new CommandHistory(), cursor: null };
stateA.history.execute(new InsertTextCommand(at(3), '라'), wasm);
assert.equal(text(a), '가나다라');

// ── B 로 옮긴다: A 는 백그라운드, 에이전트가 A 에 쓴다 ──
stateA.cursor = at(4);
page.retarget(b);
const busA = new EventBus();
const eventsA = [];
busA.on('document-mutated', (reason) => eventsA.push(`mutated:${reason}`));
busA.on('document-changed', () => eventsA.push('changed'));
const hostA = new HeadlessEditorHost({ wasm: a, eventBus: busA, state: stateA });
hostA.executeOperation({
  kind: 'snapshot',
  operationType: 'agentTest',
  operation: (w) => {
    w.insertText(0, 0, 0, '마');
    return at(1);
  },
  meta: { origin: 'agent' },
});
assert.equal(text(a), '마가나다라');
assert.deepEqual(eventsA, ['mutated:input-handler-edit', 'changed']);
assert.deepEqual(hostA.getCursorPosition(), at(1));

// 사용자는 B 를 B 의 히스토리로 편집한다
stateB.history.execute(new InsertTextCommand(at(3), 'D'), wasm);
assert.equal(text(b), 'ABCD');

// ── A 로 돌아온다: A 의 히스토리 undo 는 A 만 되돌린다 ──
page.retarget(a);
assert.ok(stateA.history.undo(wasm));
assert.equal(text(a), '가나다라', '에이전트 스냅샷 편집 undo');
assert.ok(stateA.history.undo(wasm));
assert.equal(text(a), '가나다', '사용자 입력 undo');
assert.ok(stateA.history.redo(wasm));
assert.equal(text(a), '가나다라');
assert.equal(text(b), 'ABCD', 'B 는 그대로다');

// ── 다른 문서의 브리지로 부르면 그 문서에 손대지 않고 이력을 버린다 ──
assert.equal(stateA.history.undo(b), null);
assert.equal(text(b), 'ABCD');
assert.equal(stateA.history.canUndo(), false);
assert.equal(stateA.history.canRedo(), false);

// ── 캐럿은 문서 범위 안으로 맞춘다 ──
stateA.cursor = { sectionIndex: 0, paragraphIndex: 7, charOffset: 99 };
assert.deepEqual(hostA.getCursorPosition(), at(text(a).length), '사라진 문단 → 마지막 문단 끝');
stateA.cursor = {
  sectionIndex: 0, paragraphIndex: 0, charOffset: 2,
  parentParaIndex: 0, controlIndex: 5, cellIndex: 0, cellParaIndex: 0,
};
assert.deepEqual(hostA.getCursorPosition(), at(0), '사라진 셀 안 캐럿은 바깥 문단 처음으로 간다');
hostA.dispose();

console.log('DOCUMENT_SESSION_SWITCH_OK');
