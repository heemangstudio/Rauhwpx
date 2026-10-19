// 실제 WASM(rhwp/pkg) + WasmBridge + PendingEditManager — 승인이 op 을 되돌리거나 문서를
// 다시 조판하지 않고 set 의 첫 변이 직전 스냅샷을 before 로 쓰는지, 그 undo 가 기존 경로와
// 같은 문서(텍스트·글자 모양 구간·직렬화 바이트·렌더 트리)로 돌아가는지 본다.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const studio = join(dirname(fileURLToPath(import.meta.url)), '../..');
const src = join(studio, 'src');
const pkg = join(studio, '../pkg');
const binding = pathToFileURL(join(pkg, 'rhwp.js')).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@wasm/rhwp.js') return { url: binding, shortCircuit: true };
    if (/^\.{1,2}\//.test(specifier) && !/\.[cm]?[tj]s$/.test(specifier)) {
      return { url: pathToFileURL(join(dirname(fileURLToPath(context.parentURL)), specifier + '.ts')).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const engine = await import(binding);
engine.initSync({ module: readFileSync(join(pkg, 'rhwp_bg.wasm')) });
const { WasmBridge } = await import(pathToFileURL(join(src, 'core/wasm-bridge.ts')).href);
const { EventBus } = await import(pathToFileURL(join(src, 'core/event-bus.ts')).href);
const { PendingEditManager } = await import(pathToFileURL(join(src, 'agent/pending-edits.ts')).href);

const PARAS = ['가나다라마바사아자', '하나둘셋넷다섯여섯', '봄여름가을겨울'];

/** exact=false 는 공유 스냅샷이 없는 엔진처럼 굴어 기존(되돌림) 승인 경로를 강제한다. */
function setup({ exact = true } = {}) {
  const doc = engine.HwpDocument.createEmpty();
  doc.createBlankDocument();
  PARAS.forEach((text, i) => {
    if (i > 0) doc.splitParagraph(0, i - 1, [...PARAS[i - 1]].length);
    doc.insertText(0, i, 0, text);
  });
  doc.applyCharFormat(0, 1, 0, 3, JSON.stringify({ bold: true }));
  const calls = { refreshLayout: 0, restoreSnapshot: 0 };
  for (const name of Object.keys(calls)) {
    const original = doc[name].bind(doc);
    doc[name] = (...args) => { calls[name]++; return original(...args); };
  }
  const wasm = Object.create(WasmBridge.prototype);
  wasm.doc = doc;
  // 스냅샷 복원 뒤의 외부 그림 주입은 개발 서버 fetch 라 여기서는 끈다
  wasm.populateExternalImagesFromDevServer = async () => {};
  if (!exact) wasm.shareSnapshotExact = undefined;
  const bus = new EventBus();
  const recorded = [];
  const manager = new PendingEditManager({
    wasm,
    eventBus: bus,
    editor: {
      getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
      executeOperation: (op) => { if (op.kind === 'record') recorded.push(op.command); },
      prepareSnapshotCapacity: () => {},
      retainExternalSnapshot: () => {},
      releaseExternalSnapshot: () => {},
    },
    overlay: { setOps: () => {}, clear: () => {} },
  });
  const state = () => {
    const count = wasm.getParagraphCount(0);
    const paras = [];
    for (let p = 0; p < count; p++) {
      const length = wasm.getParagraphLength(0, p);
      paras.push({ text: wasm.getTextRange(0, p, 0, length), runs: wasm.getCharShapeRuns(0, p, 0, length) });
    }
    return {
      paras,
      ir: createHash('sha256').update(doc.exportHwp()).digest('hex'),
      tree: doc.getPageRenderTree(0),
    };
  };
  const reset = () => { calls.refreshLayout = 0; calls.restoreSnapshot = 0; };
  return { doc, wasm, bus, manager, recorded, state, calls, reset };
}

const range = (paraIdx, start, end) => ({
  sectionIdx: 0, startParaIdx: paraIdx, startCharOffset: start, endParaIdx: paraIdx, endCharOffset: end,
});

/** 교체로 시작해 삽입·서식이 이어지는 검토 set 을 만들고 승인한다. */
function approveMixedSet(env) {
  const original = env.state();
  env.manager.beginTurn('claude');
  env.manager.replaceText(range(0, 0, 2), 'XY', 'claude');
  env.manager.insertText('claude', { sectionIdx: 0, paraIdx: 2, charOffset: 0 }, 'Q');
  env.manager.applyCharFormat('claude', range(1, 0, 4), { italic: true });
  env.manager.endTurn('review');
  const preview = env.state();
  const set = env.manager.getChangeSets()[0];
  env.reset();
  assert.equal(env.manager.approve(set.id), true);
  const approveCalls = { ...env.calls };
  assert.deepEqual(env.state(), preview, '승인은 미리보기를 그대로 채택한다');
  assert.equal(env.recorded.length, 1);
  env.recorded[0].undo(env.wasm);
  const undone = env.state();
  env.recorded[0].execute(env.wasm);
  assert.deepEqual(env.state(), preview, 'redo');
  return { original, preview, undone, approveCalls };
}

// 1) 검토 set 승인: 되돌림·복원·재조판 없이 원래 문서로 undo 된다. 기존 경로와 결과가 같다.
{
  const fast = approveMixedSet(setup());
  assert.deepEqual(fast.approveCalls, { refreshLayout: 0, restoreSnapshot: 0 }, '빠른 승인 경로');
  assert.deepEqual(fast.undone, fast.original, '승인 후 undo 는 첫 변이 직전 문서다');
  const slow = approveMixedSet(setup({ exact: false }));
  assert.ok(slow.approveCalls.restoreSnapshot > 0, '기존 경로는 op 을 되돌려 before 를 잡는다');
  assert.deepEqual(slow.preview, fast.preview);
  assert.deepEqual(fast.undone, slow.undone, '두 경로의 undo 결과가 같다');
}

// 2) 전체 모드: 삽입으로 시작하는 쓰기마다의 즉시 확정도 되돌림·재조판이 없다.
{
  const env = setup();
  env.manager.setDirectApply(true);
  env.manager.beginTurn('claude');
  const original = env.state();
  env.manager.insertText('claude', { sectionIdx: 0, paraIdx: 1, charOffset: 2 }, 'Z');
  env.reset();
  assert.equal(env.manager.commitOpen(), true);
  assert.deepEqual(env.calls, { refreshLayout: 0, restoreSnapshot: 0 }, '첫 쓰기 확정');
  const afterFirst = env.state();
  env.manager.applyCharFormat('claude', range(0, 2, 5), { underline: true });
  env.reset();
  assert.equal(env.manager.commitOpen(), true);
  assert.deepEqual(env.calls, { refreshLayout: 0, restoreSnapshot: 0 }, '둘째 쓰기 확정');
  const afterSecond = env.state();
  assert.equal(env.recorded.length, 2);
  env.recorded[1].undo(env.wasm);
  assert.deepEqual(env.state(), afterFirst, '둘째 쓰기만 되돌린다');
  env.recorded[0].undo(env.wasm);
  assert.deepEqual(env.state(), original, '첫 쓰기 전 문서');
  env.recorded[0].execute(env.wasm);
  env.recorded[1].execute(env.wasm);
  assert.deepEqual(env.state(), afterSecond, 'redo');
}

// 3) 사용자 편집이 끼면 기존 경로로 간다 — undo 가 사용자 글자를 지우지 않는다.
{
  const env = setup();
  env.manager.beginTurn('claude');
  env.manager.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 0 }, 'Q');
  env.manager.endTurn('review');
  env.doc.insertText(0, 2, 0, 'U');
  env.bus.emit('document-mutated', 'input-handler-edit');
  env.reset();
  assert.equal(env.manager.approve(env.manager.getChangeSets()[0].id), true);
  assert.equal(env.calls.refreshLayout, 1, '사용자 편집 뒤에는 승인 전에 다시 조판한다');
  assert.ok(env.calls.restoreSnapshot > 0, '기준점을 쓰지 않는다');
  env.recorded[0].undo(env.wasm);
  const paras = env.state().paras.map((p) => p.text);
  assert.deepEqual(paras, [PARAS[0], PARAS[1], `U${PARAS[2]}`]);
}

// 4) 이 set 뒤에 다른 set 의 op 이 남아 있으면 기존 경로로 간다 — 그 미리보기를 지우지 않는다.
{
  const env = setup();
  env.manager.beginTurn('claude');
  env.manager.insertText('claude', { sectionIdx: 0, paraIdx: 0, charOffset: 0 }, 'A');
  env.manager.endTurn('review');
  env.manager.beginTurn('claude');
  env.manager.insertText('claude', { sectionIdx: 0, paraIdx: 2, charOffset: 0 }, 'B');
  env.manager.endTurn('review');
  const [first, second] = env.manager.getChangeSets();
  env.reset();
  assert.equal(env.manager.approve(first.id), true);
  assert.ok(env.calls.restoreSnapshot > 0, '나중 set 이 남아 기준점을 쓰지 않는다');
  env.recorded[0].undo(env.wasm);
  assert.deepEqual(env.state().paras.map((p) => p.text), [PARAS[0], PARAS[1], `B${PARAS[2]}`]);
  env.recorded[0].execute(env.wasm);
  env.manager.reject(second.id);
  assert.deepEqual(env.state().paras.map((p) => p.text), [`A${PARAS[0]}`, PARAS[1], PARAS[2]]);
}

// 5) 스냅샷을 남기지 않는 일괄 교체(replace_all)로 시작한 set 도 배치 시작 문서를 before 로 쓴다.
{
  const env = setup();
  const original = env.state();
  env.manager.beginTurn('claude');
  env.manager.replaceTextBatch([
    { range: range(2, 2, 4), text: '여름!' },
    { range: range(0, 0, 2), text: 'XY' },
  ], 'claude');
  env.manager.endTurn('review');
  const preview = env.state();
  env.reset();
  assert.equal(env.manager.approve(env.manager.getChangeSets()[0].id), true);
  assert.deepEqual(env.calls, { refreshLayout: 0, restoreSnapshot: 0 }, '일괄 교체 승인');
  env.recorded[0].undo(env.wasm);
  assert.deepEqual(env.state(), original);
  env.recorded[0].execute(env.wasm);
  assert.deepEqual(env.state(), preview);
}

// 6) 열린 set 이 없을 때(전체 모드의 확정 직후) 바깥 배치 안의 중첩 배치가 실패해도 바깥 배치의
//    롤백 스냅샷은 살아 있어야 한다 — 바깥 배치가 실패하면 문서가 배치 이전으로 돌아간다.
{
  const env = setup();
  env.manager.setDirectApply(true);
  env.manager.beginTurn('claude');
  env.manager.insertText('claude', { sectionIdx: 0, paraIdx: 1, charOffset: 0 }, 'Z');
  assert.equal(env.manager.commitOpen(), true);
  const beforeBatch = env.state();
  assert.throws(() => env.manager.runAtomicBatch(() => {
    assert.throws(() => env.manager.replaceTextBatch([
      { range: range(0, 0, 2), text: 'XY' },
      { range: range(99, 0, 2), text: 'bad' },
    ], 'claude'));
    env.manager.insertText('claude', { sectionIdx: 0, paraIdx: 2, charOffset: 0 }, 'K');
    throw new Error('batch item failed');
  }), /batch item failed/);
  assert.deepEqual(env.state().paras, beforeBatch.paras, '바깥 배치 롤백이 문서를 배치 이전으로 되돌린다');
  assert.equal(env.manager.hasPending(), false);
}

console.log('PENDING_APPROVE_FAST_PATH_OK');
