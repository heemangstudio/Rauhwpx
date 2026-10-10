import test from 'node:test';
import assert from 'node:assert/strict';

import { groupHomeDocuments, sortHomeDocuments, type HomeWorktreeInput } from '../src/home/home-model.ts';
import { healRecentDocuments, inspectAndHeal, judgeOpenFailure, MISSING_CONFIRM_MS, type DocumentPresence, type HealIo } from '../src/home/home-data.ts';
import type { RecentDoc } from '../src/recent/recent-store.ts';

function recent(id: string, fileName: string, openedAt: number, digest = `blake3:${id}`): RecentDoc {
  return { id, documentId: `doc-${id}`, sourceDigest: digest, fileName, sourceFormat: 'hwp', openedAt };
}

function tree(documentId: string, branch: string, primary: boolean, createdAt: number): HomeWorktreeInput {
  return { id: `tree-${documentId}`, documentId, repositoryId: 'repo-1', branch, primary, fileName: '보고서.hwp', createdAt, updatedAt: createdAt };
}

const colorOf = (_repositoryId: string, branch: string) => (branch === 'main' ? '#379cff' : '#e7ae45');

test('작업 트리 사본은 원본 문서 카드 아래로 묶이고 제 카드를 만들지 않는다', () => {
  const rows = [recent('a', '보고서.hwp', 3), recent('copy', '보고서.hwp', 2), recent('b', '회의록.hwp', 1)];
  rows[1] = { ...rows[1]!, documentId: 'doc-copy' };
  const trees = [tree('doc-a', 'main', true, 1), tree('doc-copy', '검토본', false, 2), tree('doc-other', '요약판', false, 3)];
  const documents = groupHomeDocuments(rows, trees, colorOf);

  assert.deepEqual(documents.map((doc) => doc.documentId), ['doc-a', 'doc-b']);
  const [main] = documents;
  assert.equal(main!.branch?.branch, 'main');
  assert.deepEqual(main!.worktrees.map((entry) => [entry.branch, entry.color]), [['검토본', '#e7ae45'], ['요약판', '#e7ae45']]);
  assert.equal(documents[1]!.branch, null, '작업 트리가 없는 문서는 가지 표시가 없다');
});

test('원본이 목록에 없으면 사본이 제 가지 표시와 함께 남는다', () => {
  const rows = [{ ...recent('copy', '보고서.hwp', 2), documentId: 'doc-copy' }];
  const documents = groupHomeDocuments(rows, [tree('doc-a', 'main', true, 1), tree('doc-copy', '검토본', false, 2)], colorOf);
  assert.equal(documents.length, 1);
  assert.equal(documents[0]!.branch?.branch, '검토본');
  assert.equal(documents[0]!.worktrees.length, 0);
});

test('작업 트리가 하나뿐인 문서는 묶지 않는다', () => {
  const documents = groupHomeDocuments([recent('a', '보고서.hwp', 1)], [tree('doc-a', 'main', true, 1)], colorOf);
  assert.equal(documents[0]!.branch, null);
  assert.equal(documents[0]!.worktrees.length, 0);
});

test('정렬은 최근 순(열람 시각)과 이름 순(숫자를 숫자로)을 따른다', () => {
  const documents = groupHomeDocuments([
    recent('a', '보고서 10.hwp', 1),
    recent('b', '보고서 2.hwp', 3),
    recent('c', '가계부.hwp', 2),
  ], [], colorOf);
  assert.deepEqual(sortHomeDocuments(documents, 'recent').map((doc) => doc.fileName), ['보고서 2.hwp', '가계부.hwp', '보고서 10.hwp']);
  assert.deepEqual(sortHomeDocuments(documents, 'name').map((doc) => doc.fileName), ['가계부.hwp', '보고서 2.hwp', '보고서 10.hwp']);
});

function recordingIo(relocated: Record<string, string | null> = {}): HealIo & {
  forgotten: string[];
  updates: [string, { fileName?: string; missingSince?: number | null }][];
} {
  const io = {
    forgotten: [] as string[],
    updates: [] as [string, { fileName?: string; missingSince?: number | null }][],
    relocate: async (row: RecentDoc) => relocated[row.id] ?? null,
    forget: async (row: RecentDoc) => { io.forgotten.push(row.id); },
    update: async (row: RecentDoc, patch: { fileName?: string; missingSince?: number | null }) => { io.updates.push([row.id, patch]); },
  };
  return io;
}

const NOW = 1_000_000_000;

test('처음 못 찾은 파일은 흐리게 남기고, 시간이 지나 다시 확인해도 없을 때만 뺀다', async () => {
  const rows = [
    recent('first', '처음 못 찾음.hwp', 1),
    { ...recent('recent', '방금 못 찾음.hwp', 2), missingSince: NOW - 60_000 },
    { ...recent('confirmed', '오래 없음.hwp', 3), missingSince: NOW - MISSING_CONFIRM_MS },
    recent('browser', '브라우저.hwp', 4),
    recent('unplugged', '외장 디스크.hwp', 5),
    recent('unknown', '확인 못함.hwp', 6),
  ];
  const presence = new Map<string, DocumentPresence>([
    ['first', { state: 'missing', source: 'desktop' }],
    ['recent', { state: 'missing', source: 'desktop' }],
    ['confirmed', { state: 'missing', source: 'desktop' }],
    ['browser', { state: 'missing', source: 'handle' }],
    ['unplugged', { state: 'unavailable' }],
    ['unknown', { state: 'unknown' }],
  ]);
  const io = recordingIo();
  const result = await healRecentDocuments(rows, presence, io, NOW);

  assert.deepEqual([...result.removed], ['confirmed']);
  assert.deepEqual([...result.stale].sort(), ['browser', 'first', 'recent']);
  assert.deepEqual(io.forgotten, ['confirmed']);
  // 처음 못 찾은 시각은 처음 한 번만 남긴다.
  assert.deepEqual(io.updates, [['first', { missingSince: NOW }], ['browser', { missingSince: NOW }]]);
});

test('옮겨지거나 이름이 바뀐 파일은 새 이름으로 남고 못 찾은 표시가 지워진다', async () => {
  const rows = [
    { ...recent('moved', '옮긴 문서.hwp', 1), missingSince: NOW - MISSING_CONFIRM_MS * 2 },
    recent('renamed', '옛 이름.hwp', 2),
    { ...recent('back', '돌아옴.hwp', 3), missingSince: NOW - 1000 },
  ];
  const presence = new Map<string, DocumentPresence>([
    ['moved', { state: 'missing', source: 'desktop' }],
    ['renamed', { state: 'present', fileName: '새 이름.hwp', stamp: '1:1', source: 'desktop' }],
    ['back', { state: 'present', fileName: '돌아옴.hwp', stamp: '1:1', source: 'handle' }],
  ]);
  const io = recordingIo({ moved: '보관함의 문서.hwp' });
  const result = await healRecentDocuments(rows, presence, io, NOW);

  assert.equal(result.removed.size, 0, '옮겨진 파일은 오래 못 찾았어도 지우지 않는다');
  assert.deepEqual([...result.renamed], [['moved', '보관함의 문서.hwp'], ['renamed', '새 이름.hwp']]);
  assert.deepEqual(io.updates, [
    ['moved', { fileName: '보관함의 문서.hwp', missingSince: null }],
    ['renamed', { fileName: '새 이름.hwp', missingSince: null }],
    ['back', { missingSince: null }],
  ]);
});

test('겹친 정리는 앞 정리가 끝난 뒤에 차례로 돈다', async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow: HealIo = {
    relocate: async () => { order.push('first:start'); await gate; order.push('first:end'); return null; },
    forget: async () => {},
    update: async () => {},
  };
  const fast: HealIo = {
    relocate: async () => { order.push('second'); return null; },
    forget: async () => {},
    update: async () => {},
  };
  const row = recent('a', '보고서.hwp', 1);
  const missing = async () => new Map<string, DocumentPresence>([[row.id, { state: 'missing', source: 'desktop' }]]);
  const first = inspectAndHeal([row], slow, missing);
  const second = inspectAndHeal([row], fast, missing);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ['first:start'], '앞 정리가 끝나기 전에는 다음 정리가 옮겨진 곳을 찾지 않는다');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);
});

test('카드를 열다 파일이 없으면 홈의 확인과 같은 규칙으로 흐리게 두었다가 뺀다', () => {
  assert.deepEqual(judgeOpenFailure({}, 'missing', 1, NOW), { forget: false, missingSince: NOW }, '처음은 흐리게 두고 시각을 남긴다');
  assert.deepEqual(judgeOpenFailure({ missingSince: NOW - 1000 }, 'missing', 2, NOW), { forget: false, missingSince: NOW - 1000 });
  assert.deepEqual(judgeOpenFailure({ missingSince: NOW - MISSING_CONFIRM_MS }, 'missing', 1, NOW), { forget: true });
  assert.deepEqual(judgeOpenFailure({}, 'failed', 1, NOW), { forget: false }, '읽지 못한 파일은 한 번으로 빼지 않는다');
  assert.deepEqual(judgeOpenFailure({}, 'failed', 2, NOW), { forget: true });
});
