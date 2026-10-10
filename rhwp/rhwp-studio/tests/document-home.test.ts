import test from 'node:test';
import assert from 'node:assert/strict';

import { groupHomeDocuments, sortHomeDocuments, type HomeWorktreeInput } from '../src/home/home-model.ts';
import { healRecentDocuments, relocateByDigest, type DocumentPresence, type HealIo } from '../src/home/home-data.ts';
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

function recordingIo(relocated: Record<string, string | null> = {}): HealIo & { forgotten: string[]; renamed: [string, string][] } {
  const io = {
    forgotten: [] as string[],
    renamed: [] as [string, string][],
    relocate: async (row: RecentDoc) => relocated[row.id] ?? null,
    forget: async (row: RecentDoc) => { io.forgotten.push(row.id); },
    rename: async (row: RecentDoc, fileName: string) => { io.renamed.push([row.id, fileName]); },
  };
  return io;
}

test('지워진 파일은 목록에서 빠지고, 옮겨진 파일은 새 이름으로 남는다', async () => {
  const rows = [
    recent('deleted', '지운 문서.hwp', 1),
    recent('moved', '옮긴 문서.hwp', 2),
    recent('renamed', '옛 이름.hwp', 3),
    recent('unplugged', '외장 디스크.hwp', 4),
    recent('unknown', '확인 못함.hwp', 5),
    recent('browser', '브라우저.hwp', 6),
  ];
  const presence = new Map<string, DocumentPresence>([
    ['deleted', { state: 'missing', source: 'desktop' }],
    ['moved', { state: 'missing', source: 'desktop' }],
    ['renamed', { state: 'present', fileName: '새 이름.hwp', stamp: '1:1', source: 'desktop' }],
    ['unplugged', { state: 'unavailable' }],
    ['unknown', { state: 'unknown' }],
    ['browser', { state: 'missing', source: 'handle' }],
  ]);
  const io = recordingIo({ moved: '보관함의 문서.hwp' });
  const result = await healRecentDocuments(rows, presence, io);

  assert.deepEqual([...result.removed].sort(), ['browser', 'deleted']);
  assert.deepEqual([...result.renamed], [['moved', '보관함의 문서.hwp'], ['renamed', '새 이름.hwp']]);
  assert.deepEqual(io.forgotten.sort(), ['browser', 'deleted']);
  assert.deepEqual(io.renamed, [['moved', '보관함의 문서.hwp'], ['renamed', '새 이름.hwp']]);
});

test('옮겨진 파일은 근처 후보 중 내용 digest 가 같은 파일로만 따라간다', async () => {
  const row = recent('a', '보고서.hwp', 1, 'blake3:same');
  const relocations: string[] = [];
  const io = {
    search: async () => [{ probeId: 'p1', fileName: '보고서.hwp' }, { probeId: 'p2', fileName: '보고서 사본.hwp' }],
    read: async (probeId: string) => new TextEncoder().encode(probeId === 'p2' ? 'same' : 'other'),
    digest: (bytes: Uint8Array) => `blake3:${new TextDecoder().decode(bytes)}`,
    relocate: async (_documentId: string, probeId: string) => { relocations.push(probeId); return '보고서 사본.hwp'; },
  };
  assert.equal(await relocateByDigest(row, io), '보고서 사본.hwp');
  assert.deepEqual(relocations, ['p2'], '내용이 다른 후보는 새 위치로 삼지 않는다');

  const unmatched = { ...io, read: async () => new TextEncoder().encode('other') };
  assert.equal(await relocateByDigest(row, unmatched), null);
  assert.equal(await relocateByDigest({ ...row, sourceDigest: 'sha256:x' }, io), null, 'blake3 digest 가 없으면 찾지 않는다');
});
