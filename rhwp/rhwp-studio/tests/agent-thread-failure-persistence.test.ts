// 실패 알림은 대화와 함께 저장돼 다시 열어도 같은 자리에 남고, 깨진 값은 한계 안으로
// 접히거나 평범한 줄로 남는다. 프로바이더 기록에는 들어가지 않는다.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEmptyThread,
  getThread,
  serializeThreadMessagesForProviderHistory,
  upsertThread,
  type ThreadFailureMessage,
  type ThreadMessage,
} from '../src/agent/threads.ts';

const mem = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
  },
  configurable: true,
});

function storeAndReload(messages: unknown[]): ThreadMessage[] {
  mem.clear();
  const thread = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high' });
  thread.messages.push(...(messages as ThreadMessage[]));
  upsertThread(thread);
  const reloaded = getThread(thread.id);
  assert.ok(reloaded);
  return reloaded.messages;
}

const notice: ThreadFailureMessage = {
  role: 'system',
  kind: 'error',
  text: 'Claude 사용 한도에 도달했어요 · 리셋 오후 3:00',
  agent: 'claude',
  failure: {
    class: 'usage_limit', agent: 'claude', message: "You've hit your limit", code: 'claude:rate_limit',
    retryable: false, resetAt: Date.now() + 60 * 60 * 1000,
  },
  origin: 'turn',
  turnId: 'turn-7',
  retry: { displayText: '/templates 보고서 요약해 줘', requestText: '요약해 줘', skillName: 'summarize-document', skillIcon: 'pencil', afterPartialEdits: true },
  at: 1_790_000_000_000,
};

test('a failure notice round-trips with its failure, origin, turn and retry payload', () => {
  const [user, restored] = storeAndReload([{ role: 'user', text: '요약해 줘' }, notice]);
  assert.equal(user?.role, 'user');
  assert.deepEqual(restored, notice);
});

test('a corrupt failure is bounded, and a broken one falls back to a plain line', () => {
  const corrupt = {
    ...notice,
    failure: {
      class: 'definitely-new-class', agent: 'claude', message: 'x'.repeat(10_000), code: 'bad code!',
      retryable: 'yes', resetAt: 1e20,
    },
    origin: 'elsewhere',
    turnId: 42,
    retry: { displayText: 'a', requestText: 'b'.repeat(200_000) },
    at: -5,
  };
  const [bounded] = storeAndReload([corrupt]) as [ThreadFailureMessage];
  assert.equal(bounded.kind, 'error');
  assert.equal(bounded.failure.class, 'unknown');
  assert.ok(bounded.failure.message.length <= 2000);
  assert.equal(bounded.failure.code, null);
  assert.equal(typeof bounded.failure.retryable, 'boolean');
  assert.equal(bounded.failure.resetAt, null, 'a reset centuries away is dropped');
  assert.equal(bounded.origin, 'turn');
  assert.equal('turnId' in bounded, false);
  assert.equal(bounded.retry, undefined, 'an oversized resend payload is not kept');
  assert.equal(bounded.at, 0);

  const past = storeAndReload([{ ...notice, failure: { ...notice.failure, resetAt: Date.now() - 60_000 } }]) as [ThreadFailureMessage];
  assert.ok(past[0].failure.resetAt !== null, 'a past reset is kept so the notice can say it has passed');

  const [plain] = storeAndReload([{ role: 'system', kind: 'error', text: '알림', failure: null }]);
  assert.deepEqual(plain, { role: 'system', text: '알림' });
});

test('failure notices never enter provider history', () => {
  const messages = storeAndReload([{ role: 'user', text: '요약해 줘' }, notice, { role: 'assistant', text: '요약입니다.' }]);
  assert.deepEqual(serializeThreadMessagesForProviderHistory(messages), [
    { role: 'user', text: '요약해 줘' },
    { role: 'assistant', text: '요약입니다.' },
  ]);
});

test('a retry that already carries the interruption block keeps that mark across a reload', () => {
  const continued: ThreadFailureMessage = {
    ...notice,
    retry: { displayText: '이어서 진행해 주세요.', requestText: '이어서 진행해 주세요.\n\n<turn_interrupted reason="agent-exit">…</turn_interrupted>', continuation: true },
  };
  const [, restored] = storeAndReload([{ role: 'user', text: '이어서 진행해 주세요.' }, continued]);
  assert.equal((restored as ThreadFailureMessage).retry?.continuation, true);
  const forged = storeAndReload([{ ...continued, retry: { ...continued.retry, continuation: 'yes' } }])[0] as ThreadFailureMessage;
  assert.equal(forged.retry?.continuation, undefined, 'only a literal true is kept');
});

test('only the last failure notice of a chat keeps its resend payload when saved or loaded', () => {
  const older: ThreadFailureMessage = { ...notice, turnId: 'turn-1', retry: { displayText: '첫 요청', requestText: '첫 요청 '.repeat(1000) } };
  const newer: ThreadFailureMessage = { ...notice, turnId: 'turn-2', retry: { displayText: '두 번째 요청', requestText: '두 번째 요청' } };
  const restored = storeAndReload([
    { role: 'user', text: '첫 요청' }, older, { role: 'user', text: '두 번째 요청' }, newer, { role: 'assistant', text: '다시 볼게요' },
  ]);
  const notices = restored.filter((message): message is ThreadFailureMessage => message.kind === 'error');
  assert.deepEqual(notices.map((message) => message.turnId), ['turn-1', 'turn-2'], 'both notices stay in the conversation');
  assert.equal(notices[0]!.retry, undefined, 'the earlier notice drops its stored request');
  assert.deepEqual(notices[1]!.retry, newer.retry);
  assert.ok(!JSON.stringify(restored).includes('첫 요청 첫 요청'), 'the dropped request is not stored');
});
