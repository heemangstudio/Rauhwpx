import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyProjectOps,
  columnItems,
  createProjectStore,
  ProjectRequestError,
  type ProjectService,
} from '../src/agent/project-service.ts';
import type { ProjectItem, ProjectOp, ProjectOpsResult, ProjectSnapshot } from '../src/agent/types.ts';
import {
  keyboardMoveOp,
  moveOpFor,
  removeColumnOp,
} from '../src/ui/agent-sidebar/project/board-model.ts';

function note(id: string, column: string, order: number): ProjectItem {
  return {
    id, kind: 'note', title: id, column, order, tags: [], pinned: false, summary: '',
    createdAt: order, updatedAt: order, addedBy: { kind: 'user' }, bytes: 10,
  };
}

function project(revision = 1): ProjectSnapshot {
  return {
    id: 'pabcdefghij', name: '연구', goal: '', implicit: false, revision,
    columns: [{ id: 'inbox', name: '수집함' }, { id: 'review', name: '검토 중' }, { id: 'key', name: '핵심' }],
    tags: [], members: [],
    items: [note('na', 'inbox', 0), note('nb', 'inbox', 1), note('nc', 'inbox', 2), note('nd', 'review', 0), note('ne', 'review', 1)],
    links: [], graph: { pinned: {} },
    librarian: { state: 'idle', queued: 0, running: 0 }, usage: { files: 0, bytes: 0 },
  };
}

const ids = (snapshot: ProjectSnapshot, column: string) => columnItems(snapshot, column).map((item) => item.id);

test('board moves place the card at the drop index and renumber both columns', () => {
  const start = project();
  const op = moveOpFor(start, 'nb', 'review', 1);
  assert.deepEqual(op, { op: 'move', id: 'nb', column: 'review', index: 1 });
  const moved = applyProjectOps(start, [op!]);
  assert.deepEqual(ids(moved, 'review'), ['nd', 'nb', 'ne']);
  assert.deepEqual(ids(moved, 'inbox'), ['na', 'nc']);
  assert.deepEqual(columnItems(moved, 'inbox').map((item) => item.order), [0, 1]);
  // 원본 스냅샷은 그대로다.
  assert.deepEqual(ids(start, 'inbox'), ['na', 'nb', 'nc']);
});

test('a drop back onto its own slot produces no operation', () => {
  assert.equal(moveOpFor(project(), 'nb', 'inbox', 1), null);
});

test('Alt+arrow moves keep height across columns and stop at the edges', () => {
  const start = project();
  assert.deepEqual(keyboardMoveOp(start, 'nc', 'left'), null);
  assert.deepEqual(keyboardMoveOp(start, 'nc', 'right'), { op: 'move', id: 'nc', column: 'review', index: 2 });
  assert.deepEqual(keyboardMoveOp(start, 'nb', 'up'), { op: 'move', id: 'nb', column: 'inbox', index: 0 });
  assert.equal(keyboardMoveOp(start, 'nc', 'down'), null);
});

test('removing a column sends its items to the end of the first column', () => {
  const start = project();
  const op = removeColumnOp(start, 'review')!;
  const next = applyProjectOps(start, [op]);
  assert.deepEqual(next.columns.map((column) => column.id), ['inbox', 'key']);
  assert.deepEqual(ids(next, 'inbox'), ['na', 'nb', 'nc', 'nd', 'ne']);
  assert.equal(removeColumnOp({ ...start, columns: [start.columns[0]] }, 'inbox'), null);
});

function fakeService(handler: (ops: ProjectOp[]) => Promise<ProjectOpsResult>): ProjectService {
  return { applyOps: (_projectId: string, ops: ProjectOp[]) => handler(ops) } as unknown as ProjectService;
}

test('optimistic edits stay visible until the server snapshot catches up', async () => {
  let resolve!: (result: ProjectOpsResult) => void;
  const store = createProjectStore({
    service: fakeService(() => new Promise((done) => { resolve = done; })),
    reconcileDelayMs: 60_000,
  });
  store.replace(project(5));
  const pending = store.edit([{ op: 'move', id: 'na', column: 'key', index: 0 }]);
  assert.deepEqual(ids(store.get()!, 'key'), ['na']);
  assert.deepEqual(ids(store.confirmed()!, 'key'), []);

  // 다른 사람의 변경(revision 6)이 먼저 와도 내 편집은 위에 남는다.
  const other = applyProjectOps(project(6), [{ op: 'rename', id: 'nd', name: '새 이름' }]);
  store.applyEvent({ type: 'project-changed', projectId: other.id, revision: 6, project: { ...other, revision: 6 } });
  assert.deepEqual(ids(store.get()!, 'key'), ['na']);
  assert.equal(store.get()!.items.find((item) => item.id === 'nd')!.title, '새 이름');

  resolve({ revision: 7, applied: 1, created: {}, unresolvedLinks: [] });
  await pending;
  assert.equal(store.pendingCount(), 1, 'ack revision 7 is not in the confirmed snapshot yet');

  // 늦게 온 옛 스냅샷은 무시한다.
  store.applyEvent({ type: 'project-changed', projectId: other.id, revision: 4, project: project(4) });
  assert.equal(store.confirmed()!.revision, 6);

  const server = applyProjectOps(other, [{ op: 'move', id: 'na', column: 'key', index: 0 }]);
  store.applyEvent({ type: 'project-changed', projectId: server.id, revision: 7, project: { ...server, revision: 7 } });
  assert.equal(store.pendingCount(), 0);
  assert.deepEqual(ids(store.get()!, 'key'), ['na']);
  store.dispose();
});

test('a rejected edit reverts the view and rethrows', async () => {
  const store = createProjectStore({
    service: fakeService(async () => { throw new ProjectRequestError('PROJECT_OP_INVALID', '안 됩니다', 400); }),
  });
  store.replace(project());
  const seen: string[][] = [];
  store.subscribe((snapshot) => seen.push(ids(snapshot!, 'key')));
  await assert.rejects(store.edit([{ op: 'move', id: 'na', column: 'key' }]), /안 됩니다/);
  assert.deepEqual(seen, [['na'], []]);
  assert.equal(store.pendingCount(), 0);
  store.dispose();
});

test('librarian status updates item state without bumping the revision', () => {
  const store = createProjectStore();
  const base = project(3);
  const file = { ...note('fa', 'inbox', 3), kind: 'file' } as unknown as Record<string, unknown>;
  Object.assign(file, { librarian: { status: 'queued' }, locked: {}, status: 'ready' });
  store.replace({ ...base, items: [...base.items, file as unknown as ProjectItem] });
  assert.equal(store.applyEvent({
    type: 'project-librarian-status', projectId: base.id, state: 'running', queued: 0, running: 1,
    items: [{ id: 'fa', status: 'running' }],
  }), true);
  const item = store.get()!.items.find((entry) => entry.id === 'fa')!;
  assert.equal(item.kind === 'file' && item.librarian.status, 'running');
  assert.equal(store.get()!.librarian.state, 'running');
  assert.equal(store.get()!.revision, 3);
  assert.equal(store.applyEvent({ type: 'chat-started' }), false);
  store.dispose();
});
