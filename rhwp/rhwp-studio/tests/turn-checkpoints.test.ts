/**
 * "이 작업 전으로 되돌리기" — 요청 하나가 시작한 턴의 첫 쓰기 직전 문서로 되돌린다.
 *
 * 실제 CommandHistory 와 지도(Map)로 스냅샷을 흉내 낸 엔진 위에서 체크포인트 저장소를 돌린다.
 * 승인·직접 확정·사용자 편집은 모두 두 id 스냅샷 명령으로 히스토리에 남는다 (편집기와 같다).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventBus } from '../src/core/event-bus.ts';
import {
  TURN_CHECKPOINT_LIMIT,
  TurnCheckpoints,
  checkTurnRestore,
  isMissingSnapshotError,
  restoreTurn,
  type TurnRestoreGates,
} from '../src/agent/turn-checkpoints.ts';
import { loadCommandHistory } from './command-history-loader.ts';

const CommandHistory = loadCommandHistory();
const THREAD = 'thread-1';
const cursor = { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 };

/** 외부 점유를 세는 실제 히스토리 — 체크포인트가 예산을 얼마나 잡는지 본다. */
class CountingHistory extends CommandHistory {
  external = 0;
  peakExternal = 0;
  override retainExternalSnapshot(count = 1): void {
    this.external += count;
    this.peakExternal = Math.max(this.peakExternal, this.external);
    super.retainExternalSnapshot(count);
  }
  override releaseExternalSnapshot(count = 1): void {
    this.external -= count;
    super.releaseExternalSnapshot(count);
  }
}

/** 문서 하나 — 본문 문단과 문서별 스냅샷 저장소. 다른 문서를 열면 id 가 1 부터 다시 매겨진다. */
function world(initial = ['Hello']) {
  let instance = 1;
  let nextId = 1;
  const snapshots = new Map<number, string[]>();
  const discarded: number[] = [];
  const engine = {
    body: [...initial],
    get documentInstance() { return instance; },
    saveSnapshot() {
      snapshots.set(nextId, [...engine.body]);
      return nextId++;
    },
    restoreSnapshot(id: number) {
      const saved = snapshots.get(id);
      // 실제 엔진처럼 문자열을 던진다 (wasm_api.rs 의 HwpError → JsValue).
      if (!saved) throw `렌더링 오류: 스냅샷 ${id} 없음`;
      engine.body = [...saved];
    },
    discardSnapshot(id: number) {
      discarded.push(id);
      snapshots.delete(id);
    },
  };
  const history = new CountingHistory();
  const bus = new EventBus();
  const store = new TurnCheckpoints({ engine, history: () => history as never, eventBus: bus });

  /** before/after 두 id 를 가진 스냅샷 명령을 히스토리에 기록한다 (이미 바뀐 문서를 채택). */
  const record = (type: string, before: number) => {
    const after = engine.saveSnapshot();
    const command = {
      type,
      execute(target: typeof engine) { target.restoreSnapshot(after); return cursor; },
      undo(target: typeof engine) { target.restoreSnapshot(before); return cursor; },
      mergeWith() { return null; },
      snapshotResourceCount() { return 2; },
      discard(target: typeof engine) { target.discardSnapshot(before); target.discardSnapshot(after); },
    };
    history.recordWithoutExecute(command, engine);
    return command;
  };
  const edit = (type: string, change: () => void) => {
    const before = engine.saveSnapshot();
    change();
    return record(type, before);
  };

  let setSeq = 0;
  /** 에이전트 쓰기 — 히스토리 밖 미리보기. 되돌릴 before 를 들고 있는 set 을 돌려준다. */
  const stage = (text: string) => {
    const before = engine.saveSnapshot();
    engine.body[0] += text;
    return { id: `cs-${++setSeq}`, before };
  };
  /** 승인 — 미리보기를 채택해 적용 항목 하나를 남기고 체크포인트에 알린다. */
  const approve = (set: { id: string; before: number }) => {
    record('snapshot:agentApplyChangeSet', set.before);
    store.settleSet(THREAD, set.id, true);
  };
  /** 거절 — 미리보기를 되돌리고 set 을 버린다 (히스토리 항목 없음). */
  const reject = (set: { id: string; before: number }) => {
    engine.restoreSnapshot(set.before);
    engine.discardSnapshot(set.before);
    store.settleSet(THREAD, set.id, false);
  };
  /** 전체 모드의 쓰기 하나 — 곧바로 적용 항목이 된다. */
  const directWrite = (text: string) => approve(stage(text));
  const userEdit = (text: string) => edit('snapshot:userEdit', () => { engine.body[0] += text; });

  const gates = (overrides: Partial<TurnRestoreGates> = {}) => {
    const applied: number[] = [];
    const value: TurnRestoreGates = {
      engineStopped: () => false,
      documentShown: () => true,
      turnRunning: () => false,
      reviewPending: () => false,
      readOnly: () => false,
      // InputHandler.restoreDocumentSnapshot 처럼 문서 전체를 되돌리고 실행 취소 한 단계를 남긴다.
      apply: (id) => {
        applied.push(id);
        edit('snapshot:agent:restore_turn', () => engine.restoreSnapshot(id));
      },
      ...overrides,
    };
    return { value, applied };
  };
  const restore = (key: string, overrides?: Partial<TurnRestoreGates>) => {
    const g = gates(overrides);
    return { result: restoreTurn(store, THREAD, key, g.value), applied: g.applied };
  };

  return {
    engine,
    history,
    bus,
    store,
    discarded,
    liveSnapshots: () => snapshots.size,
    /** 엔진이 상한을 넘겨 히스토리 몰래 스냅샷을 밀어낸 것처럼 지운다. */
    evictBehindTheStore(id: number) { snapshots.delete(id); },
    replaceDocument(body: string[]) {
      instance += 1;
      nextId = 1;
      snapshots.clear();
      engine.body = [...body];
      bus.emit('document-swapped');
    },
    stage,
    approve,
    reject,
    directWrite,
    userEdit,
    restore,
  };
}

test('an approved 에이전트 turn restores to the document before its first write, as one undo step', () => {
  const w = world(['Hello']);
  w.store.noteTurnStart(THREAD, 'k1');
  // 첫 쓰기 직전에 찍는다 — 턴 시작이 아니라 실제 쓰기 앞이다.
  w.store.beforeWrite(THREAD, []);
  const set = w.stage(' world');
  w.store.beforeWrite(THREAD, []);
  const more = w.stage('!');
  assert.deepEqual(w.store.status(THREAD, 'k1'), { kind: 'none' }, 'the action waits for the turn to end');
  w.store.endTurn(THREAD, [set.id, more.id]);
  assert.deepEqual(w.store.status(THREAD, 'k1'), { kind: 'none' }, 'and for the review to settle');
  w.approve(set);
  w.approve(more);
  assert.deepEqual(w.store.status(THREAD, 'k1'), { kind: 'ready', laterEdits: false, alreadyRestored: false },
    'two approvals in a row are two own commits — nothing foreign in between');
  assert.equal(w.engine.body[0], 'Hello world!');

  const { result } = w.restore('k1');
  assert.deepEqual(result, { ok: true });
  assert.equal(w.engine.body[0], 'Hello', 'the whole turn is gone');
  assert.deepEqual(w.store.status(THREAD, 'k1'), { kind: 'ready', laterEdits: true, alreadyRestored: true });

  w.history.undo(w.engine);
  assert.equal(w.engine.body[0], 'Hello world!', 'one undo brings the agent\'s work back');
  assert.equal(w.store.status(THREAD, 'k1').kind, 'ready');
  // 되돌린 시점은 다시 쓸 수 있다.
  assert.deepEqual(w.restore('k1').result, { ok: true });
  assert.equal(w.engine.body[0], 'Hello');
});

test('a single approval with nothing after it needs no confirmation', () => {
  const w = world(['Hello']);
  w.store.noteTurnStart(THREAD, 'k1');
  w.store.beforeWrite(THREAD, []);
  const set = w.stage(' world');
  w.store.endTurn(THREAD, [set.id]);
  w.approve(set);
  assert.deepEqual(w.store.status(THREAD, 'k1'), { kind: 'ready', laterEdits: false, alreadyRestored: false });
});

test('a rejected turn offers nothing and gives its snapshot back', () => {
  const w = world(['Hello']);
  const before = w.liveSnapshots();
  w.store.noteTurnStart(THREAD, 'k1');
  w.store.beforeWrite(THREAD, []);
  const set = w.stage(' world');
  w.store.endTurn(THREAD, [set.id]);
  assert.ok(w.liveSnapshots() > before);
  w.reject(set);
  assert.deepEqual(w.store.status(THREAD, 'k1'), { kind: 'none' });
  assert.equal(w.liveSnapshots(), before, 'no checkpoint snapshot leaks');
  assert.equal(w.history.external, 0, 'and no budget stays held');
});

test('a turn that never writes takes no snapshot', () => {
  const w = world(['Hello']);
  w.store.noteTurnStart(THREAD, 'k1');
  w.store.endTurn(THREAD, []);
  assert.equal(w.liveSnapshots(), 0);
  assert.equal(w.history.peakExternal, 0);
  assert.deepEqual(w.store.status(THREAD, 'k1'), { kind: 'none' });
});

test('later edits ask for confirmation: after approval, before approval, and not for the turn\'s own commits', () => {
  // 승인 뒤의 사용자 편집
  const after = world(['Hello']);
  after.store.noteTurnStart(THREAD, 'k1');
  after.store.beforeWrite(THREAD, []);
  const set = after.stage(' world');
  after.store.endTurn(THREAD, [set.id]);
  after.approve(set);
  after.userEdit(' typed');
  assert.deepEqual(after.store.status(THREAD, 'k1'), { kind: 'ready', laterEdits: true, alreadyRestored: false });

  // 턴이 끝나고 승인하기 전의 사용자 편집 (드리프트)
  const between = world(['Hello']);
  between.store.noteTurnStart(THREAD, 'k1');
  between.store.beforeWrite(THREAD, []);
  const pending = between.stage(' world');
  between.store.endTurn(THREAD, [pending.id]);
  between.userEdit(' typed');
  between.approve(pending);
  assert.deepEqual(between.store.status(THREAD, 'k1'), { kind: 'ready', laterEdits: true, alreadyRestored: false });

  // 전체 모드: 한 턴의 직접 확정 두 번만 있다
  const direct = world(['Hello']);
  direct.store.noteTurnStart(THREAD, 'k1');
  direct.store.beforeWrite(THREAD, []);
  direct.directWrite(' world');
  direct.store.beforeWrite(THREAD, []);
  direct.directWrite('!');
  direct.store.endTurn(THREAD, []);
  assert.deepEqual(direct.store.status(THREAD, 'k1'), { kind: 'ready', laterEdits: false, alreadyRestored: false });
  assert.deepEqual(direct.restore('k1').result, { ok: true });
  assert.equal(direct.engine.body[0], 'Hello', 'one restore removes both direct writes');

  // 실행 취소도 이후 변경이다
  const undone = world(['Hello']);
  undone.store.noteTurnStart(THREAD, 'k1');
  undone.store.beforeWrite(THREAD, []);
  undone.directWrite(' world');
  undone.store.endTurn(THREAD, []);
  undone.history.undo(undone.engine);
  assert.deepEqual(undone.store.status(THREAD, 'k1'), { kind: 'ready', laterEdits: true, alreadyRestored: false });
});

test('only the five latest turns keep a checkpoint, inside the history budget', () => {
  const w = world(['Hello']);
  for (let i = 1; i <= TURN_CHECKPOINT_LIMIT + 1; i++) {
    w.store.noteTurnStart(THREAD, `k${i}`);
    w.store.beforeWrite(THREAD, []);
    const set = w.stage(` ${i}`);
    w.store.endTurn(THREAD, [set.id]);
    w.approve(set);
  }
  assert.deepEqual(w.store.status(THREAD, 'k1'), { kind: 'blocked', reason: 'evicted' });
  for (let i = 2; i <= TURN_CHECKPOINT_LIMIT + 1; i++) {
    assert.equal(w.store.status(THREAD, `k${i}`).kind, 'ready', `k${i}`);
  }
  assert.ok(w.history.peakExternal <= TURN_CHECKPOINT_LIMIT, `peak external retains ${w.history.peakExternal}`);
  assert.equal(w.history.external, TURN_CHECKPOINT_LIMIT);
  const refused = w.restore('k1');
  assert.deepEqual(refused.result, { ok: false, reason: 'evicted' });
  assert.deepEqual(refused.applied, [], 'an evicted checkpoint changes nothing');

  // 셋째 요청으로 되돌리면 그 뒤 요청들의 편집이 함께 사라진다.
  assert.deepEqual(w.restore('k3').result, { ok: true });
  assert.equal(w.engine.body[0], 'Hello 1 2');
});

test('a checkpoint that holds a preview the user later rejected cannot be restored', () => {
  const w = world(['Hello']);
  w.store.noteTurnStart(THREAD, 'k1');
  w.store.beforeWrite(THREAD, []);
  const first = w.stage(' one');
  w.store.endTurn(THREAD, [first.id]);
  // 둘째 요청은 첫 요청의 미리보기가 검토 대기인 채로 찍는다.
  w.store.noteTurnStart(THREAD, 'k2');
  w.store.beforeWrite(THREAD, [first.id]);
  const second = w.stage(' two');
  w.store.endTurn(THREAD, [first.id, second.id]);
  w.reject(first);
  w.approve(second);
  assert.deepEqual(w.store.status(THREAD, 'k2'), { kind: 'blocked', reason: 'superseded' });
  assert.deepEqual(w.restore('k2').result, { ok: false, reason: 'superseded' });

  // 같은 순서에서 첫 요청을 승인했다면 둘째 요청의 시점은 그대로 쓸 수 있다.
  const kept = world(['Hello']);
  kept.store.noteTurnStart(THREAD, 'k1');
  kept.store.beforeWrite(THREAD, []);
  const one = kept.stage(' one');
  kept.store.endTurn(THREAD, [one.id]);
  kept.store.noteTurnStart(THREAD, 'k2');
  kept.store.beforeWrite(THREAD, [one.id]);
  const two = kept.stage(' two');
  kept.store.endTurn(THREAD, [one.id, two.id]);
  kept.approve(one);
  kept.approve(two);
  assert.equal(kept.store.status(THREAD, 'k2').kind, 'ready');
  assert.equal(kept.store.status(THREAD, 'k1').kind, 'ready');
  assert.deepEqual(kept.restore('k2').result, { ok: true });
  assert.equal(kept.engine.body[0], 'Hello one', 'the first request\'s approved text stays');
});

test('opening another document blocks old checkpoints without discarding the new document\'s ids', () => {
  const w = world(['Hello']);
  w.store.noteTurnStart(THREAD, 'k1');
  w.store.beforeWrite(THREAD, []);
  const set = w.stage(' world');
  w.store.endTurn(THREAD, [set.id]);
  w.approve(set);
  assert.equal(w.store.status(THREAD, 'k1').kind, 'ready');
  const discardedBefore = w.discarded.length;

  w.replaceDocument(['Other']);
  assert.equal(w.history.external, 0, 'the old document\'s retain is released at once');
  assert.equal(w.discarded.length, discardedBefore, 'ids of the old document are never discarded on the new one');
  assert.deepEqual(w.store.status(THREAD, 'k1'), { kind: 'blocked', reason: 'document-replaced' });
  assert.deepEqual(w.restore('k1').result, { ok: false, reason: 'document-replaced' });
  assert.deepEqual(w.engine.body, ['Other']);
});

test('restore refuses in gate order and changes nothing while refused', () => {
  const w = world(['Hello']);
  w.store.noteTurnStart(THREAD, 'k1');
  w.store.beforeWrite(THREAD, []);
  w.directWrite(' world');
  w.store.endTurn(THREAD, []);
  const cases: Array<[Partial<TurnRestoreGates>, string]> = [
    [{ engineStopped: () => true, turnRunning: () => true }, 'engine'],
    [{ documentShown: () => false, turnRunning: () => true }, 'hidden'],
    [{ turnRunning: () => true, reviewPending: () => true }, 'running'],
    [{ reviewPending: () => true, readOnly: () => true }, 'review-pending'],
    [{ readOnly: () => true }, 'read-only'],
  ];
  const open = { engineStopped: () => false, documentShown: () => true, turnRunning: () => false,
    reviewPending: () => false, readOnly: () => false };
  assert.deepEqual(checkTurnRestore(w.store, THREAD, 'k1', open), { ok: true });
  assert.deepEqual(checkTurnRestore(w.store, THREAD, 'k1', { ...open, turnRunning: () => true }), { ok: false, reason: 'running' });
  assert.equal(w.engine.body[0], 'Hello world', 'checking changes nothing');
  for (const [overrides, reason] of cases) {
    const { result, applied } = w.restore('k1', overrides);
    assert.deepEqual(result, { ok: false, reason });
    assert.deepEqual(applied, [], `${reason}: nothing applied`);
    assert.equal(w.engine.body[0], 'Hello world');
  }
  const failed = w.restore('k1', { apply: () => { throw new Error('boom'); } });
  assert.deepEqual(failed.result, { ok: false, reason: 'failed', error: 'boom' });
  assert.equal(w.store.status(THREAD, 'k1').kind, 'ready', 'a failed apply leaves the checkpoint usable');
});

test('a request with no checkpoint in this page (reloaded, adopted, or trap-reopened) offers nothing', () => {
  const w = world(['Hello']);
  assert.deepEqual(w.store.status(THREAD, 'from-before-reload'), { kind: 'none' });
  const { result, applied } = w.restore('from-before-reload');
  assert.deepEqual(result, { ok: false, reason: 'unavailable' });
  assert.deepEqual(applied, []);
});

test('a plan\'s implementation turn binds to the request that produced it', () => {
  const w = world(['Hello']);
  // 구상 턴: 쓰지 않는다.
  w.store.noteTurnStart(THREAD, 'k1');
  w.store.endTurn(THREAD, []);
  assert.equal(w.liveSnapshots(), 0);
  // 승인으로 허브가 시작한 실행 턴 — 새 메시지가 없어 같은 요청에 묶인다.
  w.store.noteTurnStart(THREAD, 'k1');
  w.store.beforeWrite(THREAD, []);
  const set = w.stage(' planned');
  w.store.endTurn(THREAD, [set.id]);
  w.approve(set);
  // 같은 요청의 다음 턴은 같은 기록에 쌓이고, 시점은 처음 쓰기 전 그대로다.
  w.store.noteTurnStart(THREAD, 'k1');
  w.store.beforeWrite(THREAD, []);
  w.directWrite(' more');
  w.store.endTurn(THREAD, []);
  assert.equal(w.store.status(THREAD, 'k1').kind, 'ready');
  assert.deepEqual(w.restore('k1').result, { ok: true });
  assert.equal(w.engine.body[0], 'Hello');
});

test('when the history cannot make room the capture is skipped instead of overflowing the engine store', () => {
  const w = world(['Hello']);
  // 다른 외부 점유가 예산(98)을 다 쓰고 있다 — 체크포인트가 하나 더 잡으면 엔진이 남의 스냅샷을 밀어낸다.
  w.history.retainExternalSnapshot(98);
  const before = w.liveSnapshots();
  w.store.noteTurnStart(THREAD, 'k1');
  w.store.beforeWrite(THREAD, []);
  assert.equal(w.liveSnapshots(), before, 'no snapshot was saved');
  w.directWrite(' world');
  w.store.endTurn(THREAD, []);
  assert.deepEqual(w.store.status(THREAD, 'k1'), { kind: 'blocked', reason: 'capture-failed' });
});

test('a turn whose end was missed is closed by the next turn of the same chat', () => {
  const w = world(['Hello']);
  w.store.noteTurnStart(THREAD, 'k1');
  w.store.beforeWrite(THREAD, []);
  // turn-end 를 놓쳤다. 다음 요청의 턴이 시작한다.
  w.store.noteTurnStart(THREAD, 'k2');
  w.store.beforeWrite(THREAD, []);
  w.directWrite(' world');
  w.store.endTurn(THREAD, []);
  assert.deepEqual(w.store.status(THREAD, 'k1'), { kind: 'none' });
  assert.equal(w.store.status(THREAD, 'k2').kind, 'ready');
  assert.equal(w.history.external, 1, 'the abandoned checkpoint is released');
});

test('closing the document session releases every checkpoint', () => {
  const w = world(['Hello']);
  w.store.noteTurnStart(THREAD, 'k1');
  w.store.beforeWrite(THREAD, []);
  w.directWrite(' world');
  w.store.endTurn(THREAD, []);
  const notifications: number[] = [];
  w.store.subscribe(() => notifications.push(1));
  w.store.dispose();
  assert.equal(w.history.external, 0);
  assert.deepEqual(w.store.status(THREAD, 'k1'), { kind: 'none' });
  w.bus.emit('document-swapped');
  assert.deepEqual(notifications, [], 'a disposed store stays quiet');
});

test('a hub turn bound to a request the hub then refused moves to the request before it', () => {
  // 앞 요청 k1 이 문서를 고쳤다.
  const w = world(['Hello']);
  w.store.noteTurnStart(THREAD, 'k1');
  w.store.beforeWrite(THREAD, []);
  w.directWrite(' one');
  w.store.endTurn(THREAD, []);
  // 대기 메시지 k2 를 보낸 사이 허브가 스스로 턴을 열었다 — 그 turn-start 는 마지막 말풍선 k2 에 묶인다.
  w.store.noteTurnStart(THREAD, 'k2');
  // 허브가 k2 를 거절해 말풍선이 걷혔다.
  w.store.rebindTurn(THREAD, 'k2', 'k1');
  w.store.beforeWrite(THREAD, []);
  w.directWrite(' two');
  w.store.endTurn(THREAD, []);
  assert.deepEqual(w.store.status(THREAD, 'k2'), { kind: 'none' }, 'nothing points at the removed bubble');
  assert.equal(w.store.status(THREAD, 'k1').kind, 'ready');
  assert.equal(w.history.external, 1, 'one checkpoint, the earlier one, holds the budget');
  assert.deepEqual(w.restore('k1').result, { ok: true });
  assert.equal(w.engine.body[0], 'Hello', 'the hub turn\'s work goes with the request it continued');

  // 앞 요청에 기록이 없으면(쓰지 않았다) 이 턴의 기록이 그 요청의 것이 된다 — 이미 찍었어도 그대로다.
  const moved = world(['Hello']);
  moved.store.noteTurnStart(THREAD, 'k2');
  moved.store.beforeWrite(THREAD, []);
  moved.directWrite(' two');
  moved.store.rebindTurn(THREAD, 'k2', 'k1');
  moved.store.endTurn(THREAD, []);
  assert.deepEqual(moved.store.status(THREAD, 'k2'), { kind: 'none' });
  assert.equal(moved.store.status(THREAD, 'k1').kind, 'ready');
  assert.deepEqual(moved.restore('k1').result, { ok: true });
  assert.equal(moved.engine.body[0], 'Hello');

  // 남은 요청이 없으면 기록과 스냅샷을 버린다.
  const orphan = world(['Hello']);
  orphan.store.noteTurnStart(THREAD, 'k2');
  orphan.store.beforeWrite(THREAD, []);
  orphan.store.rebindTurn(THREAD, 'k2', null);
  orphan.directWrite(' two');
  orphan.store.endTurn(THREAD, []);
  assert.deepEqual(orphan.store.status(THREAD, 'k2'), { kind: 'none' });
  assert.equal(orphan.history.external, 0, 'no checkpoint is left pinned');
});

test('a checkpoint the engine no longer has is refused as evicted instead of failing on every click', () => {
  const w = world(['Hello']);
  w.store.noteTurnStart(THREAD, 'k1');
  // 체크포인트가 찍는 스냅샷 id 를 본다.
  const save = w.engine.saveSnapshot;
  let checkpointId = -1;
  w.engine.saveSnapshot = () => (checkpointId = save());
  w.store.beforeWrite(THREAD, []);
  w.engine.saveSnapshot = save;
  w.directWrite(' world');
  w.store.endTurn(THREAD, []);
  assert.equal(w.store.status(THREAD, 'k1').kind, 'ready');
  w.evictBehindTheStore(checkpointId);

  const first = w.restore('k1');
  assert.deepEqual(first.result, { ok: false, reason: 'evicted' });
  assert.equal(w.engine.body[0], 'Hello world', 'the document is unchanged');
  assert.deepEqual(w.store.status(THREAD, 'k1'), { kind: 'blocked', reason: 'evicted' });
  assert.equal(w.history.external, 0, 'the lost checkpoint no longer holds budget');
  const second = w.restore('k1');
  assert.deepEqual(second.result, { ok: false, reason: 'evicted' });
  assert.deepEqual(second.applied, [], 'the next click explains without trying again');
});

test('a restore stays in effect through later edits until it is undone', () => {
  const w = world(['Hello']);
  w.store.noteTurnStart(THREAD, 'k1');
  w.store.beforeWrite(THREAD, []);
  w.directWrite(' world');
  w.store.endTurn(THREAD, []);
  assert.deepEqual(w.restore('k1').result, { ok: true });
  assert.equal(w.store.restoreStillApplies(THREAD, 'k1'), true);
  w.userEdit(' typed');
  assert.equal(w.store.restoreStillApplies(THREAD, 'k1'), true, 'typing after the restore keeps it');
  w.history.undo(w.engine);
  w.history.undo(w.engine);
  assert.equal(w.engine.body[0], 'Hello world');
  assert.equal(w.store.restoreStillApplies(THREAD, 'k1'), false, 'undoing the restore brings the agent\'s work back');
  w.history.redo(w.engine);
  assert.equal(w.store.restoreStillApplies(THREAD, 'k1'), true, 'redo restores it again');
});

test('the real engine\'s refusal for a missing snapshot is recognized', async (t) => {
  const pkg = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'pkg');
  if (!existsSync(join(pkg, 'rhwp_bg.wasm'))) {
    t.skip('rhwp/pkg 의 WASM 빌드가 필요하다 (wasm-pack build --target web)');
    return;
  }
  const engine = await import(pathToFileURL(join(pkg, 'rhwp.js')).href);
  engine.initSync({ module: readFileSync(join(pkg, 'rhwp_bg.wasm')) });
  const doc = engine.HwpDocument.createEmpty();
  doc.createBlankDocument();
  const kept = doc.saveSnapshot();
  const gone = doc.saveSnapshot();
  doc.discardSnapshot(gone);
  let refusal: unknown = null;
  try {
    doc.restoreSnapshot(gone);
  } catch (error) {
    refusal = error;
  }
  assert.notEqual(refusal, null, 'restoring a discarded snapshot throws');
  assert.equal(isMissingSnapshotError(refusal, gone), true, String(refusal));
  assert.equal(isMissingSnapshotError(refusal, kept), false, 'another id is not mistaken for it');
  assert.equal(isMissingSnapshotError(new Error('The editor snapshot store is full'), gone), false);
  doc.free?.();
});
