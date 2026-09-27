import assert from 'node:assert/strict';
import test from 'node:test';
import { VersionMaintenance } from '../src/versioning/maintenance.ts';
import { repositoryId } from '../src/versioning/types.ts';
import type { VersionGraphStore } from '../src/versioning/store.ts';
import { CapturedSnapshotCommand } from '../src/engine/captured-snapshot-command.ts';

function fixture() {
  let readers = 0;
  let collected = 0;
  let backfilled = 0;
  const locks = { async request(_name: string, options: LockOptions, callback: (lock: object | null) => Promise<void>) {
    if (options.mode === 'shared') {
      readers++;
      try { await callback({}); } finally { readers--; }
    } else await callback(readers ? null : {});
  } } as unknown as LockManager;
  const store = {
    getRepository: async () => ({ id: repositoryId('test'), revision: 7 }),
    backfillObjectSizes: async () => { backfilled++; return { processed: 0, hasMore: false }; },
    collectGarbage: async (_id: string, revision: number) => {
      assert.equal(revision, 7); collected++;
      return { hasMore: false };
    },
  } as unknown as VersionGraphStore;
  return { store, locks, counts: () => ({ collected, backfilled }) };
}

test('shared history ownership prevents collection until every command is discarded', async () => {
  const f = fixture();
  const maintenance = new VersionMaintenance(f.store, { locks: f.locks, enqueue: (operation) => operation(), delayMs: 60_000 });
  try {
    const first = await maintenance.retainHistory(repositoryId('test'));
    const second = await maintenance.retainHistory(repositoryId('test'));
    maintenance.schedule(repositoryId('test'));
    await maintenance.runPending();
    assert.equal(f.counts().collected, 0);
    first(); first();
    await maintenance.runPending();
    assert.equal(f.counts().collected, 0);
    second();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await maintenance.runPending();
    assert.equal(f.counts().collected, 1);
  } finally { maintenance.dispose(); }
});

test('maintenance failures are reported separately and missing locks defer deletion', async () => {
  const f = fixture();
  const errors: unknown[] = [];
  const maintenance = new VersionMaintenance(f.store, { locks: null, enqueue: (operation) => operation(), onError: (error) => errors.push(error), delayMs: 60_000 });
  try {
    maintenance.schedule(repositoryId('test'));
    await maintenance.runPending();
    assert.deepEqual(f.counts(), { collected: 0, backfilled: 1 });
    f.store.backfillObjectSizes = async () => { throw new Error('quota'); };
    maintenance.schedule(repositoryId('test'));
    await maintenance.runPending();
    assert.equal(errors.length, 1);
  } finally { maintenance.dispose(); }
});

test('snapshot history releases its retained resources exactly once on discard', () => {
  let released = 0;
  const point = { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 };
  const command = new CapturedSnapshotCommand('merge', point, point, 1, 2, { afterDiscard: () => released++ });
  const wasm = { restoreSnapshot: () => {}, discardSnapshot: () => {} } as never;
  command.undo(wasm);
  command.execute(wasm);
  assert.equal(released, 0);
  command.discard(wasm);
  command.discard(wasm);
  assert.equal(released, 1);
});
