import test from 'node:test';
import assert from 'node:assert/strict';

import { DocumentDirtyState } from '../src/core/document-dirty-state.ts';
import { EventBus } from '../src/core/event-bus.ts';
import { AutosaveManager, type AutosaveStoreLike } from '../src/recovery/autosave-manager.ts';
import type { AutosaveDraft } from '../src/recovery/autosave-store.ts';

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createStore() {
  const saved: AutosaveDraft[] = [];
  const deleted: string[] = [];
  const store: AutosaveStoreLike = {
    async saveDraft(draft) {
      saved.push({ ...draft, data: new Uint8Array(draft.data) });
    },
    async deleteDraft(id) {
      deleted.push(id);
    },
  };
  return { store, saved, deleted };
}

test('AutosaveManager는 dirty 이벤트 후 현재 문서를 draft로 저장한다', async () => {
  const { store, saved } = createStore();
  const eventBus = new EventBus();
  const manager = new AutosaveManager({
    exportBytes: () => new Uint8Array([1, 2, 3, 4]),
    debounceMs: 0,
    minSaveIntervalMs: 0,
    now: () => 1_000,
    idFactory: () => 'draft-a',
    store,
    logger: { debug() {}, warn() {} },
  });

  manager.connect(eventBus);
  await manager.beginDocument({ fileName: 'a.hwp', sourceFormat: 'hwp' });
  eventBus.emit('document-mutated', 'typing');
  await tick();

  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, 'draft-a');
  assert.equal(saved[0].fileName, 'a.hwp');
  assert.equal(saved[0].sourceFormat, 'hwp');
  assert.equal(saved[0].savedAt, 1_000);
  assert.equal(saved[0].dirtyReason, 'typing');
  assert.deepEqual([...saved[0].data], [1, 2, 3, 4]);
});

test('AutosaveManager scopes draft ownership and heartbeat to the renderer session', async () => {
  const { store, saved } = createStore();
  const heartbeats: Array<{ launchId: string; sessionId: string; instanceId?: string; at: number }> = [];
  store.touchSession = async (owner, at) => {
    heartbeats.push({ ...owner, at });
  };
  const manager = new AutosaveManager({
    exportBytes: () => new Uint8Array([4]),
    schedule: { recoveryEnabled: false, idleEnabled: false },
    now: () => 5_000,
    idFactory: () => 'draft-owned',
    instanceId: 'page-a',
    owner: { launchId: 'launch-a', sessionId: 'window-a' },
    heartbeatIntervalMs: 0,
    store,
    logger: { debug() {}, warn() {} },
  });

  await manager.beginDocument({ fileName: 'owned.hwp', sourceFormat: 'hwp' });
  await manager.flushNow('manual');

  assert.deepEqual(heartbeats.at(-1), {
    launchId: 'launch-a', sessionId: 'window-a', instanceId: 'page-a', at: 5_000,
  });
  // lock 없이 실행한 페이지의 draft 는 instance 를 기록하지 않아 heartbeat 규칙을 따른다.
  assert.equal(saved[0]?.ownerInstanceId, undefined);
  assert.equal(saved[0]?.ownerLaunchId, 'launch-a');
  assert.equal(saved[0]?.ownerSessionId, 'window-a');
  assert.equal(saved[0]?.ownerHeartbeatAt, 5_000);
  manager.dispose();
});

test('AutosaveManager는 clean 전환 시 현재 draft를 삭제한다', async () => {
  const { store, saved, deleted } = createStore();
  const eventBus = new EventBus();
  const dirtyState = new DocumentDirtyState(eventBus);
  const manager = new AutosaveManager({
    exportBytes: () => new Uint8Array([5]),
    debounceMs: 0,
    minSaveIntervalMs: 0,
    idFactory: () => 'draft-clean',
    store,
    logger: { debug() {}, warn() {} },
  });

  manager.connect(eventBus);
  await manager.beginDocument({ fileName: 'clean.hwp', sourceFormat: 'hwp' });
  dirtyState.markDirty('typing');
  await tick();
  assert.equal(saved.length, 1);

  dirtyState.markClean('save');
  await tick();
  assert.deepEqual(deleted, ['draft-clean']);
});

test('AutosaveManager는 새 문서 세션 시작 시 이전 draft를 정리하고 새 id를 사용한다', async () => {
  const { store, saved, deleted } = createStore();
  let nextId = 0;
  const manager = new AutosaveManager({
    exportBytes: () => new Uint8Array([9]),
    debounceMs: 0,
    minSaveIntervalMs: 0,
    idFactory: () => `draft-${++nextId}`,
    store,
    logger: { debug() {}, warn() {} },
  });

  await manager.beginDocument({ fileName: 'old.hwp', sourceFormat: 'hwp' });
  await manager.flushNow('typing');
  assert.equal(saved[0].id, 'draft-1');

  await manager.beginDocument(
    { fileName: 'new.hwp', sourceFormat: 'hwp' },
    { discardPreviousDraft: true },
  );
  await manager.flushNow('typing');

  assert.deepEqual(deleted, ['draft-1']);
  assert.equal(saved[1].id, 'draft-2');
  assert.equal(saved[1].fileName, 'new.hwp');
});

test('AutosaveManager는 쉴 때 자동저장 간격 전에는 draft를 저장하지 않는다', async () => {
  const { store, saved } = createStore();
  const eventBus = new EventBus();
  const manager = new AutosaveManager({
    exportBytes: () => new Uint8Array([1]),
    schedule: {
      recoveryEnabled: false,
      idleEnabled: true,
      idleDelayMs: 20,
    },
    idFactory: () => 'draft-idle',
    store,
    logger: { debug() {}, warn() {} },
  });

  manager.connect(eventBus);
  await manager.beginDocument({ fileName: 'idle.hwp', sourceFormat: 'hwp' });
  eventBus.emit('document-mutated', 'typing');
  await tick();

  assert.equal(saved.length, 0);
  await sleep(25);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].dirtyReason, 'typing');
});

test('AutosaveManager는 복구용 주기 저장을 별도 타이머로 예약한다', async () => {
  const { store, saved } = createStore();
  const eventBus = new EventBus();
  const manager = new AutosaveManager({
    exportBytes: () => new Uint8Array([2]),
    schedule: {
      recoveryEnabled: true,
      recoveryIntervalMs: 20,
      idleEnabled: false,
    },
    idFactory: () => 'draft-recovery',
    store,
    logger: { debug() {}, warn() {} },
  });

  manager.connect(eventBus);
  await manager.beginDocument({ fileName: 'recovery.hwp', sourceFormat: 'hwp' });
  eventBus.emit('document-mutated', 'typing');
  await tick();

  assert.equal(saved.length, 0);
  await sleep(25);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].dirtyReason, 'recovery-interval');
});

test('AutosaveManager는 저장 상태 콜백을 보낸다', async () => {
  const { store } = createStore();
  const states: string[] = [];
  const manager = new AutosaveManager({
    exportBytes: () => new Uint8Array([3, 4]),
    schedule: {
      recoveryEnabled: false,
      idleEnabled: false,
    },
    idFactory: () => 'draft-status',
    store,
    logger: { debug() {}, warn() {} },
    onStatus(status) {
      states.push(status.state);
      if (status.state === 'saved') {
        assert.equal(status.byteLength, 2);
      }
    },
  });

  await manager.beginDocument({ fileName: 'status.hwp', sourceFormat: 'hwp' });
  await manager.flushNow('manual');

  assert.deepEqual(states, ['saving', 'saved']);
});

test('AutosaveManager는 저장 진행 중 discard가 끼어들면 저장 완료로 부활한 draft를 재삭제한다', async () => {
  const ops: string[] = [];
  let signalSaveEntered: () => void = () => {};
  const saveEntered = new Promise<void>((resolve) => {
    signalSaveEntered = resolve;
  });
  let resolveSave: () => void = () => {};
  const store: AutosaveStoreLike = {
    async saveDraft(draft) {
      signalSaveEntered();
      await new Promise<void>((resolve) => {
        resolveSave = resolve;
      });
      ops.push(`save:${draft.id}`);
    },
    async deleteDraft(id) {
      ops.push(`delete:${id}`);
    },
  };
  const manager = new AutosaveManager({
    exportBytes: () => new Uint8Array([1]),
    schedule: { recoveryEnabled: false, idleEnabled: false },
    idFactory: () => 'draft-race',
    store,
    logger: { debug() {}, warn() {} },
  });

  await manager.beginDocument({ fileName: 'race.hwp', sourceFormat: 'hwp' });
  const flushPromise = manager.flushNow('typing');
  await saveEntered; // 저장이 IndexedDB put 대기 중인 시점
  const discardPromise = manager.discardCurrentDraft('host-save');
  await discardPromise;
  resolveSave(); // put 완료 — draft 부활 시점
  await flushPromise;

  // discard 후 완료된 저장은 draft를 부활시키므로 반드시 재삭제되어야 한다
  assert.deepEqual(ops, ['delete:draft-race', 'save:draft-race', 'delete:draft-race']);
});

test('AutosaveManager는 discard 없는 정상 flush에서는 draft를 삭제하지 않는다', async () => {
  const { store, saved, deleted } = createStore();
  const manager = new AutosaveManager({
    exportBytes: () => new Uint8Array([6]),
    schedule: { recoveryEnabled: false, idleEnabled: false },
    idFactory: () => 'draft-plain',
    store,
    logger: { debug() {}, warn() {} },
  });

  await manager.beginDocument({ fileName: 'plain.hwp', sourceFormat: 'hwp' });
  await manager.flushNow('typing');

  assert.equal(saved.length, 1);
  assert.deepEqual(deleted, []);
});

test('AutosaveManager는 대기 중인 저장이 없으면 설정 변경만으로 draft를 저장하지 않는다', async () => {
  const { store, saved } = createStore();
  const manager = new AutosaveManager({
    exportBytes: () => new Uint8Array([7]),
    schedule: {
      recoveryEnabled: true,
      recoveryIntervalMs: 5,
      idleEnabled: true,
      idleDelayMs: 5,
    },
    idFactory: () => 'draft-settings',
    store,
    logger: { debug() {}, warn() {} },
  });

  await manager.beginDocument({ fileName: 'settings.hwp', sourceFormat: 'hwp' });
  manager.updateSchedule({ idleDelayMs: 1, recoveryIntervalMs: 1 });
  await sleep(10);

  assert.equal(saved.length, 0);
});

test('a failed draft write reports an error and retries while the document sits idle', async () => {
  const states: string[] = [];
  const attempts: string[] = [];
  let failures = 2;
  const store: AutosaveStoreLike = {
    async saveDraft(draft) {
      attempts.push(draft.id);
      if (failures > 0) {
        failures -= 1;
        throw new DOMException('disk full', 'QuotaExceededError');
      }
    },
    async deleteDraft() {},
  };
  const manager = new AutosaveManager({
    exportBytes: () => new Uint8Array([1]),
    schedule: { recoveryEnabled: false, idleEnabled: false },
    idFactory: () => 'draft-retry',
    retryDelayMs: 2,
    store,
    logger: { debug() {}, warn() {} },
    onStatus: (status) => states.push(status.state),
  });

  await manager.beginDocument({ fileName: 'retry.hwp', sourceFormat: 'hwp' });
  await manager.flushNow('typing');
  assert.deepEqual(states, ['saving', 'error']);
  await sleep(100);
  assert.deepEqual(attempts, ['draft-retry', 'draft-retry', 'draft-retry']);
  assert.deepEqual(states, ['saving', 'error', 'saving', 'error', 'saving', 'saved']);
  manager.dispose();
});

test('a recovered draft keeps its id and is never deleted before a rewrite succeeds', async () => {
  const ops: string[] = [];
  let failNext = true;
  const store: AutosaveStoreLike = {
    async saveDraft(draft) {
      if (failNext) {
        failNext = false;
        throw new Error('write failed');
      }
      ops.push(`save:${draft.id}`);
    },
    async deleteDraft(id) {
      ops.push(`delete:${id}`);
    },
  };
  const manager = new AutosaveManager({
    exportBytes: () => new Uint8Array([1]),
    schedule: { recoveryEnabled: false, idleEnabled: false },
    idFactory: () => 'fresh-id',
    retryDelayMs: 60_000,
    store,
    logger: { debug() {}, warn() {} },
  });

  await manager.beginDocument({ fileName: 'crashed.hwp', sourceFormat: 'hwp', draftId: 'recovered' });
  await manager.flushNow('autosave-recovered');
  assert.deepEqual(ops, [], 'a failed rewrite leaves the recovered draft in place');
  await manager.flushNow('typing');
  assert.deepEqual(ops, ['save:recovered']);
  assert.equal(manager.getCurrentDraftId(), 'recovered');
  manager.dispose();
});

test('drafts carry the page instance only once its owner lock is held', async () => {
  const { store, saved } = createStore();
  const requested: string[] = [];
  let released = false;
  const locks = {
    async request(name: string, callback: () => unknown) {
      requested.push(name);
      await callback();
      released = true;
      return undefined;
    },
    async query() { return { held: [] }; },
  };
  const manager = new AutosaveManager({
    exportBytes: () => new Uint8Array([1]),
    schedule: { recoveryEnabled: false, idleEnabled: false },
    idFactory: () => 'draft-locked',
    instanceId: 'page-1',
    owner: { launchId: 'launch', sessionId: 'window' },
    heartbeatIntervalMs: 0,
    locks,
    store,
    logger: { debug() {}, warn() {} },
  });

  await manager.beginDocument({ fileName: 'locked.hwp', sourceFormat: 'hwp' });
  await manager.flushNow('typing');
  assert.deepEqual(requested, ['rhwp-autosave-owner:page-1']);
  assert.equal(saved[0]?.ownerInstanceId, 'page-1');
  assert.equal(released, false, 'the lock is held for the page lifetime');
  manager.dispose();
  await tick();
  assert.equal(released, true);
});
