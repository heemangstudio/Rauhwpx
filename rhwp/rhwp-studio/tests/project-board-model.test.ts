import test from 'node:test';
import assert from 'node:assert/strict';

import { applyProjectOps, columnItems } from '../src/agent/project-service.ts';
import { fullDropIndex, keyboardMoveOp, moveOpFor } from '../src/ui/agent-sidebar/project/board-model.ts';
import type { ProjectItem, ProjectSnapshot } from '../src/agent/types.ts';

const SUMMARY = { worktreeId: 'wt-summary', branch: '요약본' };

function note(id: string, column: string, order: number, shared = true): ProjectItem {
  return {
    id, kind: 'note', title: id, column, order, tags: [], pinned: false, summary: '', createdAt: 0, updatedAt: 0,
    addedBy: { kind: 'user' }, bytes: 0, ...(shared ? {} : { origin: SUMMARY }),
  };
}

// a: s1 h1 s2 h2 (h = 다른 작업 공간, 공통만 보이게 거르면 숨는다) / b: h3 s3
function project(): ProjectSnapshot {
  return {
    id: 'p', name: 'p', goal: '', implicit: false, revision: 1,
    columns: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    tags: [], members: [], links: [], graph: { pinned: {} },
    librarian: { state: 'idle', queued: 0, running: 0 }, usage: { files: 0, bytes: 0 },
    items: [
      note('s1', 'a', 0), note('h1', 'a', 1, false), note('s2', 'a', 2), note('h2', 'a', 3, false),
      note('h3', 'b', 0, false), note('s3', 'b', 1),
    ],
  };
}

const sharedOnly = (item: ProjectItem) => !item.origin;
const order = (snapshot: ProjectSnapshot, column: string) => columnItems(snapshot, column).map((item) => item.id);

function apply(snapshot: ProjectSnapshot, op: ReturnType<typeof moveOpFor>): ProjectSnapshot {
  assert.ok(op);
  return applyProjectOps(snapshot, [op]);
}

test('dropping between visible cards keeps hidden cards in place', () => {
  const base = project();
  // b 의 s3 를 보이는 a 카드 s1·s2 사이(보이는 자리 1)에 놓으면 s2 바로 앞에 들어간다.
  const between = apply(base, moveOpFor(base, 's3', 'a', fullDropIndex(base, 's3', 'a', 1, sharedOnly)));
  assert.deepEqual(order(between, 'a'), ['s1', 'h1', 's3', 's2', 'h2']);
  // 보이는 끝에 놓으면 마지막으로 보이는 카드 바로 뒤, 숨은 h2 앞이다.
  const end = apply(base, moveOpFor(base, 's3', 'a', fullDropIndex(base, 's3', 'a', 9, sharedOnly)));
  assert.deepEqual(order(end, 'a'), ['s1', 'h1', 's2', 's3', 'h2']);
});

test('dropping into a column whose cards are all hidden appends', () => {
  const base = project();
  const moved = apply(base, moveOpFor(base, 's1', 'b', fullDropIndex(base, 's1', 'b', 0, (item) => item.id !== 'h3' && item.id !== 's3')));
  assert.deepEqual(order(moved, 'b'), ['h3', 's3', 's1']);
});

test('Alt+arrow moves past the visible neighbor, not a hidden card', () => {
  const base = project();
  const down = apply(base, keyboardMoveOp(base, 's1', 'down', sharedOnly));
  assert.deepEqual(order(down, 'a'), ['h1', 's2', 's1', 'h2']);
  const up = apply(base, keyboardMoveOp(base, 's2', 'up', sharedOnly));
  assert.deepEqual(order(up, 'a'), ['s2', 's1', 'h1', 'h2']);
  assert.equal(keyboardMoveOp(base, 's2', 'down', sharedOnly), null);
  // 옆 열에서는 같은 보이는 높이(두 번째)로: b 에 보이는 카드는 s3 하나라 그 뒤에 놓는다.
  const right = apply(base, keyboardMoveOp(base, 's2', 'right', sharedOnly));
  assert.deepEqual(order(right, 'b'), ['h3', 's3', 's2']);
});

test('without a filter the moves match the unfiltered board', () => {
  const base = project();
  assert.deepEqual(keyboardMoveOp(base, 's1', 'down'), { op: 'move', id: 's1', column: 'a', index: 1 });
  assert.deepEqual(keyboardMoveOp(base, 'h1', 'right'), { op: 'move', id: 'h1', column: 'b', index: 1 });
  assert.equal(fullDropIndex(base, 's3', 'a', 2), 2);
  assert.equal(fullDropIndex(base, 's3', 'a', 99), 4);
});
