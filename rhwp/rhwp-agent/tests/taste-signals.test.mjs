// 취향 학습 신호 버퍼: chat-review-signal 프레임 검증, 문서별 상한, 꺼내기·엿보기, 구독.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTasteSignalBuffer, normalizeReviewSignalFrame } from '../taste-signals.mjs';

const at = '2026-10-22T00:00:00.000Z';
const frame = (signals, extra = {}) => ({ v: 1, type: 'chat-review-signal', threadId: 'th1', documentId: 'doc-1', turnId: 'turn-1', signals, ...extra });

test('프레임 틀이 틀리면 통째로 버리고, 신호는 하나씩 걸러 모르는 종류·잘못된 형식을 뺀다', () => {
  assert.equal(normalizeReviewSignalFrame(frame([{ kind: 'accepted', at, after: 'x' }], { documentId: '' })), null);
  assert.equal(normalizeReviewSignalFrame(frame([{ kind: 'accepted', at, after: 'x' }], { threadId: 7 })), null);
  assert.equal(normalizeReviewSignalFrame(frame([])), null);
  assert.equal(normalizeReviewSignalFrame(frame(Array.from({ length: 21 }, () => ({ kind: 'accepted', at, after: 'x' })))), null);

  const result = normalizeReviewSignalFrame(frame([
    { kind: 'accepted', at, before: '고객', after: '이용자', paraIdx: 3 },
    { kind: 'liked', at, after: 'x' },
    { kind: 'accepted', at: 'yesterday', after: 'x' },
    { kind: 'accepted', at, after: 42 },
    { kind: 'accepted', at, after: 'x', paraIdx: -1 },
    { kind: 'rewritten', at, after: '에이전트 글' },
    { kind: 'rejected', at },
    { kind: 'undone', at, turnId: 'turn-0' },
    { kind: 'rewritten', at, after: '가'.repeat(700), userText: '사용자 글' },
  ]));
  assert.deepEqual(result.signals.map((s) => s.kind), ['accepted', 'undone', 'rewritten']);
  assert.deepEqual(result.signals[0], { kind: 'accepted', at, before: '고객', after: '이용자', paraIdx: 3, turnId: 'turn-1' });
  assert.equal(result.signals[1].turnId, 'turn-0', '신호 자신의 턴이 프레임 턴보다 앞선다');
  assert.equal([...result.signals[2].after].length, 600);
});

test('문서마다 최근 신호만 남기고, 꺼내면 비우고, 엿보기는 남겨 둔다', () => {
  const buffer = createTasteSignalBuffer({ perDocument: 5 });
  for (let i = 0; i < 4; i++) {
    buffer.ingest(frame([{ kind: 'accepted', at, after: `a${i}` }, { kind: 'rejected', at, after: `r${i}` }]));
  }
  buffer.ingest(frame([{ kind: 'accepted', at, after: 'other' }], { documentId: 'doc-2' }));
  assert.deepEqual(buffer.peekSignals('doc-1').map((s) => s.after), ['r1', 'a2', 'r2', 'a3', 'r3']);
  assert.equal(buffer.peekSignals('doc-1')[0].threadId, 'th1');
  assert.equal(buffer.takeSignals('doc-1').length, 5);
  assert.deepEqual(buffer.takeSignals('doc-1'), []);
  assert.equal(buffer.peekSignals('doc-2').length, 1);
});

test('새 신호가 쌓이면 구독자에게 문서와 요약을 알리고, 버린 프레임은 알리지 않는다', () => {
  const buffer = createTasteSignalBuffer({ maxDocuments: 2 });
  const calls = [];
  const off = buffer.onReviewSignals((documentId, info) => calls.push([documentId, info]));
  buffer.ingest(frame([{ kind: 'rewritten', at, after: '에이전트 글', userText: '사용자 글' }, { kind: 'undone', at }]));
  buffer.ingest(frame([{ kind: 'liked', at }]));
  buffer.ingest({ ...frame([{ kind: 'accepted', at, after: 'x' }]), documentId: null });
  assert.deepEqual(calls, [['doc-1', { threadId: 'th1', turnId: 'turn-1', count: 2, kinds: ['rewritten', 'undone'], buffered: 2 }]]);
  off();
  buffer.ingest(frame([{ kind: 'accepted', at, after: 'x' }], { documentId: 'doc-2' }));
  buffer.ingest(frame([{ kind: 'accepted', at, after: 'y' }], { documentId: 'doc-3' }));
  assert.equal(calls.length, 1);
  assert.deepEqual(buffer.peekSignals('doc-1'), [], '문서 수 상한을 넘으면 가장 오래된 문서부터 버린다');
});
