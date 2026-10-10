import assert from 'node:assert/strict';
import test from 'node:test';
import type { CompareDocumentSnapshot } from '../src/compare/types.ts';
import {
  clearHistory,
  getHistoryPayload,
  listHistoryMeta,
  saveHistoryIrSnapshot,
} from '../src/history/idb-store.ts';

test('memory history stores serialized snapshots without sharing caller objects', async () => {
  await clearHistory();
  const snapshot: CompareDocumentSnapshot = {
    meta: { name: '긴 문서😀', sectionCount: 1, pageCount: 1 },
    paragraphs: [{
      section: 0,
      paragraph: 0,
      sectionPage: 1,
      globalIndex: 0,
      stableId: 'stable-1',
      text: '원본 텍스트😀',
      normalizedText: '원본 텍스트😀',
      controlCount: 0,
      signature: 'signature',
      isAnchorCandidate: true,
    }],
    controls: [],
  };
  const expectedJson = JSON.stringify(snapshot);
  const saved = await saveHistoryIrSnapshot('메모리', 'long.hwpx', snapshot);

  snapshot.paragraphs[0].text = '호출자가 변경한 텍스트';
  const payload = await getHistoryPayload(saved.id);

  assert.equal(saved.byteLength, Buffer.byteLength(expectedJson, 'utf8'));
  assert.equal(payload?.kind, 'ir');
  if (payload?.kind === 'ir') {
    assert.equal(payload.snapshot.paragraphs[0].text, '원본 텍스트😀');
    assert.notEqual(payload.snapshot, snapshot);
  }
  await clearHistory();
});

test('memory history drops the oldest snapshots once their total size passes the cap', async () => {
  await clearHistory();
  const large = (text: string): CompareDocumentSnapshot => ({
    meta: { name: 'large', sectionCount: 1, pageCount: 1 },
    paragraphs: [],
    controls: [],
    text,
  } as CompareDocumentSnapshot);
  const first = await saveHistoryIrSnapshot('first', 'long.hwpx', large('a'.repeat(17 * 1024 * 1024)));
  const second = await saveHistoryIrSnapshot('second', 'long.hwpx', large('b'.repeat(17 * 1024 * 1024)));

  assert.deepEqual((await listHistoryMeta()).map((row) => row.id), [second.id]);
  assert.equal(await getHistoryPayload(first.id), null);
  assert.equal((await getHistoryPayload(second.id))?.kind, 'ir');
  await clearHistory();
});
