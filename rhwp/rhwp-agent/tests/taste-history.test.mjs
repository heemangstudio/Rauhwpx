// 기록에서 배우기 허브 처리: 짝 거르기, 문서 기억 키, 한 문서에 한 번에 하나, 자동 요청의 설정, 학습기 결과.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createTasteHistoryHandler } from '../taste-history.mjs';

const pair = (minute, extra = {}) => ({
  kind: 'history',
  at: `2026-10-22T01:${String(minute).padStart(2, '0')}:00.000Z`,
  after: '모두 참석해 주시기 바랍니다.',
  userText: '모두 참석해 주기 바란다.',
  ...extra,
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness({ available = true, enabled = true, learn } = {}) {
  const calls = [];
  const keys = [];
  const handler = createTasteHistoryHandler({
    learner: {
      learnHistory: async (input) => {
        calls.push(input);
        return learn ? learn(input) : { learnId: 'learn_1', key: input.key, items: [{ op: 'add', entryId: 'mem_aaaaaaaaaaaa', text: '본문은 한다체 사용', origin: 'learned' }], changes: [{ op: 'add', entryId: 'mem_aaaaaaaaaaaa' }], provider: 'claude' };
      },
    },
    resolveKey: (record, documentId, msg) => {
      keys.push({ documentId, repositoryId: msg.repositoryId ?? null });
      return msg.repositoryId ? `repo-${msg.repositoryId}` : `doc-${documentId}`;
    },
    available: () => available,
    enabled: () => enabled,
    threadId: (record) => record.threadId,
  });
  return { handler, calls, keys };
}

test('짝은 history 만 검토 신호 규칙으로 걸러 오래된 것부터 학습기에 넘기고, 문서 기억 키로 묶는다', async () => {
  const h = harness();
  const reply = await h.handler.handle({ threadId: 'th1' }, {
    documentId: 'doc-1',
    repositoryId: 'r1',
    pairs: [
      pair(5),
      pair(1, { userText: '참석해 주기 바란다.' }),
      { kind: 'rewritten', at: pair(2).at, after: 'a', userText: 'b' },
      { kind: 'history', at: pair(3).at, after: '짝 없는 글' },
      pair(4, { after: '가'.repeat(900) }),
    ],
  });
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  assert.deepEqual([reply.learnId, reply.key, reply.items.length, reply.changes.length], ['learn_1', 'repo-r1', 1, 1]);
  // 학습기에 넘긴 짝만 받았다고 답한다 — 걸러 낸 짝(2, 3번)은 Studio 가 '이미 보냄'으로 남기지 않는다.
  assert.deepEqual(reply.accepted, [0, 1, 4]);
  assert.deepEqual(h.keys, [{ documentId: 'doc-1', repositoryId: 'r1' }]);
  const [input] = h.calls;
  assert.deepEqual([input.documentId, input.key, input.threadId], ['doc-1', 'repo-r1', 'th1']);
  assert.deepEqual(input.signals.map((signal) => signal.at.slice(14, 16)), ['01', '04', '05']);
  assert.equal([...input.signals[1].after].length, 600, '긴 글은 600자로 자른다');

  for (const pairs of [[], Array.from({ length: 21 }, (_, i) => pair(i % 60)), [{ kind: 'rewritten', at: pair(1).at, after: 'a', userText: 'b' }], 'x']) {
    const bad = await h.handler.handle({}, { documentId: 'doc-1', pairs });
    assert.equal(bad.error?.code, 'TASTE_HISTORY_INVALID');
  }
  assert.equal((await h.handler.handle({}, { documentId: '', pairs: [pair(1)] })).error?.code, 'TASTE_HISTORY_INVALID');
  assert.equal(h.calls.length, 1);
  // 20개까지는 받아 모두 넘긴다 (학습기 프롬프트가 싣는 수와 같다).
  const full = await h.handler.handle({}, { documentId: 'doc-2', pairs: Array.from({ length: 20 }, (_, i) => pair(i)) });
  assert.equal(full.accepted.length, 20);
  assert.equal(h.calls[1].signals.length, 20);
});

test('한 문서(같은 기억 키)에는 한 번에 하나만 받고, 끝나면 다시 받는다', async () => {
  const gate = deferred();
  const h = harness({ learn: async (input) => { await gate.promise; return { learnId: 'learn_x', key: input.key, items: [], changes: [], provider: 'claude' }; } });
  const first = h.handler.handle({}, { documentId: 'doc-1', repositoryId: 'r1', pairs: [pair(1)] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await h.handler.handle({}, { documentId: 'doc-1', pairs: [pair(2)] })).error?.code, 'TASTE_HISTORY_BUSY');
  // 같은 저장소를 나누는 작업 공간 사본도 같은 기억이다.
  assert.equal((await h.handler.handle({}, { documentId: 'doc-1-copy', repositoryId: 'r1', pairs: [pair(2)] })).error?.code, 'TASTE_HISTORY_BUSY');
  gate.resolve();
  assert.equal((await first).ok, true);
  assert.equal((await h.handler.handle({}, { documentId: 'doc-1', pairs: [pair(3)] })).ok, true);
  assert.equal(h.calls.length, 2);
});

test('자동 요청은 대화에서 배우기를 따르고, 학습기를 쓸 수 없거나 모델이 답하지 않으면 실패로 답한다', async () => {
  const off = harness({ enabled: false });
  assert.equal((await off.handler.handle({}, { documentId: 'doc-1', pairs: [pair(1)], auto: true })).error?.code, 'TASTE_DISABLED');
  assert.equal((await off.handler.handle({}, { documentId: 'doc-1', pairs: [pair(1)] })).ok, true, '시트에서 누른 요청은 설정과 상관없이 돈다');

  const unavailable = harness({ available: false });
  assert.equal((await unavailable.handler.handle({}, { documentId: 'doc-1', pairs: [pair(1)] })).error?.code, 'TASTE_UNAVAILABLE');
  assert.equal(unavailable.calls.length, 0);

  const silent = harness({ learn: (input) => ({ learnId: 'learn_y', key: input.key, items: [], changes: [] }) });
  const reply = await silent.handler.handle({}, { documentId: 'doc-1', pairs: [pair(1)] });
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'TASTE_HISTORY_NO_RESULT');
  // 실패한 요청도 자리를 놓는다.
  assert.equal((await silent.handler.handle({}, { documentId: 'doc-1', pairs: [pair(1)] })).error.code, 'TASTE_HISTORY_NO_RESULT');
});

test('학습기가 닫히는 중이면(TASTE_CLOSED) 실패로 답하고 자리를 놓는다', async () => {
  const h = harness({ learn: () => { throw Object.assign(new Error('The taste learner is closed'), { code: 'TASTE_CLOSED' }); } });
  const reply = await h.handler.handle({}, { documentId: 'doc-1', pairs: [pair(1)] });
  assert.deepEqual([reply.ok, reply.error.code, reply.accepted], [false, 'TASTE_CLOSED', []]);
  assert.equal((await h.handler.handle({}, { documentId: 'doc-1', pairs: [pair(1)] })).error.code, 'TASTE_CLOSED');
});
