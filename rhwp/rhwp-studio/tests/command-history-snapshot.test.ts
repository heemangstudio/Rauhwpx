import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/event-bus.ts';
import { PendingEditManager } from '../src/agent/pending-edits.ts';

// 에이전트 원자적 배치가 잡는 되돌림 스냅샷은 이력 밖 점유로 등록했다가 성공·예외 뒤에 반환한다.

test('원자적 배치 스냅샷은 성공·예외 뒤에 점유를 반환한다', () => {
  let nextId = 0;
  let held = 0;
  let prepared = 0;
  const snapshots = new Set<number>();
  const wasm = {
    documentDigest: 'test-document',
    saveSnapshot: () => {
      assert.equal(prepared, nextId + 1, 'capacity is reserved before snapshot allocation');
      const id = ++nextId;
      snapshots.add(id);
      return id;
    },
    restoreSnapshot: (id: number) => { assert.ok(snapshots.has(id)); },
    discardSnapshot: (id: number) => { assert.equal(snapshots.delete(id), true); },
    refreshLayout: () => {},
  };
  const manager = new PendingEditManager({
    wasm: wasm as never,
    eventBus: new EventBus(),
    editor: {
      getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
      prepareSnapshotCapacity: (count: number) => { prepared += count; },
      retainExternalSnapshot: () => { held++; },
      releaseExternalSnapshot: () => { held--; },
    } as never,
    overlay: { clear() {}, setOps() {} } as never,
  });
  manager.beginTurn('claude');

  assert.equal(manager.runAtomicBatch(() => {
    assert.equal(held, 1);
    assert.equal(snapshots.size, 1);
    return 42;
  }), 42);
  assert.equal(prepared, 1);
  assert.equal(held, 0);
  assert.equal(snapshots.size, 0);

  assert.throws(() => manager.runAtomicBatch(() => {
    assert.equal(held, 1);
    assert.equal(snapshots.size, 1);
    throw new Error('verification failed');
  }), /verification failed/);
  assert.equal(prepared, 2);
  assert.equal(held, 0);
  assert.equal(snapshots.size, 0);

  manager.dispose();
  assert.equal(held, 0);
  assert.equal(snapshots.size, 0);
});
