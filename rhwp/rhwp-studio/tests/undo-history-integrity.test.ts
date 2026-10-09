import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

// 되돌리기가 사용자가 보지 않은 내용을 지우거나 되살리지 않아야 한다.
// node --test 는 engine 모듈의 확장자 없는 import 를 풀지 못하므로, 실제 메서드 본문을
// 잘라 가짜 의존성 위에서 실행한다.

const handlerSource = readFileSync(new URL('../src/engine/input-handler.ts', import.meta.url), 'utf8');
const historySource = readFileSync(new URL('../src/engine/history.ts', import.meta.url), 'utf8');

function undoRedoHandlers() {
  const start = handlerSource.indexOf('  /** Undo 처리 */');
  const next = handlerSource.indexOf('  private restoreEditContextAfterHistory(');
  const end = handlerSource.lastIndexOf('  /**', next);
  assert.ok(start >= 0 && end > start, 'handleUndo/handleRedo 본문을 찾지 못했다');
  const methods = stripTypeScriptTypes(`class Handlers {\n${handlerSource.slice(start, end)}\n}`);
  return new Function(`${methods}\nreturn Handlers;`)();
}

function historyClass() {
  const body = historySource.replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '');
  return new Function('NO_TEXT_MUTATION_EFFECTS', `${stripTypeScriptTypes(body)}\nreturn CommandHistory;`)(
    Object.freeze({}),
  );
}

function handlerFixture(composing: boolean) {
  const Handlers = undoRedoHandlers();
  const calls: string[] = [];
  const handler = Object.assign(new Handlers(), {
    isComposing: composing,
    wasm: {},
    finalizeCompositionBeforeCursorMove() {
      calls.push('finalize');
      this.isComposing = false;
    },
    flushDeferredPaginationIfNeeded(reason: string) { calls.push(`flush:${reason}`); },
    history: {
      undo() { calls.push('undo'); return null; },
      redo() { calls.push('redo'); return null; },
    },
  });
  return { handler, calls };
}

test('도구상자 되돌리기/다시 실행은 살아 있는 IME 조합을 먼저 확정한다', () => {
  // 도구상자 버튼은 mousedown 에서 preventDefault 해 textarea 포커스를 유지하므로
  // compositionend 가 오지 않는다. 조합을 두고 undo 하면 옛 anchor 가 이동한 문서의
  // 실제 글자를 덮어쓴다.
  const undo = handlerFixture(true);
  undo.handler.handleUndo();
  assert.deepEqual(undo.calls, ['finalize', 'flush:before-undo', 'undo']);

  const redo = handlerFixture(true);
  redo.handler.handleRedo();
  assert.deepEqual(redo.calls, ['finalize', 'flush:before-redo', 'redo']);
});

test('조합이 없으면 되돌리기는 IME 세션을 건드리지 않는다', () => {
  // finalizeCompositionBeforeCursorMove 는 조합이 없을 때 iOS anchor·textarea 버퍼를 정리한다.
  // 키보드 Ctrl+Z 마다 그 부수 효과가 돌면 안 된다.
  const undo = handlerFixture(false);
  undo.handler.handleUndo();
  assert.deepEqual(undo.calls, ['flush:before-undo', 'undo']);
  const redo = handlerFixture(false);
  redo.handler.handleRedo();
  assert.deepEqual(redo.calls, ['flush:before-redo', 'redo']);
});

/** SnapshotCommand 와 같은 before/after 공유 규칙을 따르는 가짜 스냅샷 저장소와 명령. */
function snapshotWorld() {
  const store = new Map<number, string>();
  let nextId = 1;
  const wasm = {
    doc: '',
    saveSnapshot() { store.set(nextId, wasm.doc); return nextId++; },
    shareSnapshot(id: number) { const shared = nextId++; store.set(shared, store.get(id)!); return shared; },
    restoreSnapshot(id: number) { wasm.doc = store.get(id)!; },
    discardSnapshot(id: number) { store.delete(id); },
  };
  class FakeSnapshotCommand {
    beforeId: number | null = null;
    afterId: number | null = null;
    edit: (doc: string) => string;
    constructor(edit: (doc: string) => string) { this.edit = edit; }
    execute(target: typeof wasm) {
      if (this.afterId !== null) { target.restoreSnapshot(this.afterId); return {}; }
      if (this.beforeId === null) this.beforeId = target.saveSnapshot();
      target.doc = this.edit(target.doc);
      this.afterId = target.saveSnapshot();
      return {};
    }
    undo(target: typeof wasm) { target.restoreSnapshot(this.beforeId!); return {}; }
    mergeWith() { return null; }
    reuseCurrentSnapshot(target: typeof wasm, id: number) {
      if (this.beforeId === null) this.beforeId = target.shareSnapshot(id);
    }
    currentSnapshotId() { return this.afterId; }
    undoSnapshotId() { return this.beforeId; }
    snapshotResourceCount() { return (this.beforeId === null ? 0 : 1) + (this.afterId === null ? 0 : 1); }
  }
  return { wasm, FakeSnapshotCommand };
}

function rejectAfterPasteThenUndoDelete(invalidate: boolean): string {
  const CommandHistory = historyClass();
  const { wasm, FakeSnapshotCommand } = snapshotWorld();
  const history = new CommandHistory();
  wasm.doc = 'body [agent]';
  // 에이전트 텍스트가 스테이징된 문서에 붙여넣기 — 마지막 스냅샷에 에이전트 텍스트가 들어 있다.
  history.execute(new FakeSnapshotCommand((doc: string) => `${doc} pasted`), wasm);
  // 거절은 히스토리 밖에서 문서를 바꾼다.
  wasm.doc = wasm.doc.replace(' [agent]', '');
  if (invalidate) history.invalidateCurrentSnapshot();
  history.execute(new FakeSnapshotCommand((doc: string) => doc.replace(' pasted', '')), wasm);
  history.undo(wasm);
  return wasm.doc;
}

test('히스토리 밖 변이 뒤의 스냅샷 명령은 옛 스냅샷을 before 로 공유하지 않는다', () => {
  // 공유 후보를 비우지 않으면 undo 가 거절한 에이전트 텍스트를 추적 안 되는 본문으로 되살린다.
  assert.equal(rejectAfterPasteThenUndoDelete(false), 'body [agent] pasted');
  assert.equal(rejectAfterPasteThenUndoDelete(true), 'body pasted');
});

test('InputHandler 는 히스토리 밖 document-mutated 마다 공유 스냅샷을 버린다', () => {
  assert.match(
    handlerSource,
    /eventBus\.on\('document-mutated', \(reason\) => \{\s*if \(reason !== 'input-handler-edit'\) this\.history\.invalidateCurrentSnapshot\(\);\s*\}\);/,
  );
  // 히스토리를 거친 편집은 'input-handler-edit' 로만 알린다 — 그 경로가 공유 후보를 지우면 안 된다.
  const afterEdit = handlerSource.match(/emit\('document-mutated', 'input-handler-edit'\)/g) ?? [];
  assert.ok(afterEdit.length >= 1);
});
