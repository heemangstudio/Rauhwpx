import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UPDATE_RESTART_KEY_PREFIX,
  UPDATE_RESTART_TTL_MS,
  orderUpdateRestore,
  takeUpdateRestartRecord,
  updateRestartKind,
  writeUpdateRestartRecords,
  type UpdateRestartRecord,
} from '../src/recovery/update-restart.ts';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
  };
}

function record(overrides: Partial<UpdateRestartRecord> = {}): UpdateRestartRecord {
  return {
    kind: 'draft',
    draftId: 'draft-1',
    activeThreadId: 'thread-1',
    pendingAgentOps: 0,
    hasFile: true,
    readOnly: false,
    savedAt: 1_000,
    ...overrides,
  };
}

test('dirty documents, never-saved documents and worktrees each reopen their own way', () => {
  assert.equal(updateRestartKind({ managedWorktree: false, dirty: true, hasFile: true }), 'draft');
  assert.equal(updateRestartKind({ managedWorktree: false, dirty: true, hasFile: false }), 'draft');
  assert.equal(updateRestartKind({ managedWorktree: false, dirty: false, hasFile: true }), 'file');
  // 편집하지 않은 새 문서는 파일이 없어 복구본으로만 다시 열 수 있다.
  assert.equal(updateRestartKind({ managedWorktree: false, dirty: false, hasFile: false }), 'copy');
  assert.equal(updateRestartKind({ managedWorktree: true, dirty: true, hasFile: false }), 'worktree');
});

test('a relaunched window reads each document record once', () => {
  const storage = memoryStorage();
  assert.equal(writeUpdateRestartRecords(storage, new Map([['doc-a', record()], ['doc-b', record({ kind: 'copy', hasFile: false })]]), 1_000), true);

  assert.deepEqual(takeUpdateRestartRecord(storage, 'doc-a', 2_000), record());
  assert.equal(takeUpdateRestartRecord(storage, 'doc-a', 2_000), null);
  assert.equal(takeUpdateRestartRecord(storage, 'doc-b', 2_000)?.kind, 'copy');
  assert.equal(storage.values.size, 0);
});

test('stale or malformed records are never used and are swept on the next restart', () => {
  const storage = memoryStorage({
    [`${UPDATE_RESTART_KEY_PREFIX}old`]: JSON.stringify(record({ savedAt: 0 })),
    [`${UPDATE_RESTART_KEY_PREFIX}broken`]: '{',
    unrelated: 'kept',
  });
  const now = UPDATE_RESTART_TTL_MS + 1;
  assert.equal(takeUpdateRestartRecord(storage, 'old', now), null);
  storage.setItem(`${UPDATE_RESTART_KEY_PREFIX}old`, JSON.stringify(record({ savedAt: 0 })));

  writeUpdateRestartRecords(storage, new Map([['fresh', record({ savedAt: now })]]), now);
  assert.deepEqual([...storage.values.keys()].sort(), [`${UPDATE_RESTART_KEY_PREFIX}fresh`, 'unrelated']);
});

test('restore opens background documents first, the visible one last, and worktrees after files', () => {
  const ids = (entries: Array<{ id: string; kind: UpdateRestartRecord['kind']; active: boolean }>) => (
    orderUpdateRestore(entries).map((entry) => entry.id)
  );
  assert.deepEqual(ids([
    { id: 'shown', kind: 'file', active: true },
    { id: 'tree', kind: 'worktree', active: false },
    { id: 'edited', kind: 'draft', active: false },
    { id: 'new', kind: 'copy', active: false },
  ]), ['edited', 'new', 'shown', 'tree']);
  assert.deepEqual(ids([
    { id: 'shown-tree', kind: 'worktree', active: true },
    { id: 'tree', kind: 'worktree', active: false },
    { id: 'edited', kind: 'draft', active: false },
  ]), ['edited', 'tree', 'shown-tree']);
});
