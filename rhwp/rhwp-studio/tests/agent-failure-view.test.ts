// 실패 알림이 실패마다 맞는 조치만 내놓는지 — 다시 시도가 소용없는 실패(정리 실패, 로그인 전)에는
// 다시 시도가 없고, 사용 한도는 리셋 시각에 따라 이어서 보내기·다시 시도가 갈린다.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFailureDismissals,
  failureView,
  formatResetAt,
  PARTIAL_EDITS_RETRY_NOTE,
  failureQueueHold,
  retryRequestText,
  retryWire,
  type FailureViewContext,
} from '../src/ui/agent-sidebar/failure-notice.ts';
import type { ProviderFailure } from '../src/agent/types.ts';

const NOW = Date.UTC(2026, 9, 10, 3, 0); // 2026-10-10 12:00 Asia/Seoul
const HOUR = 60 * 60 * 1000;

function failure(overrides: Partial<ProviderFailure>): ProviderFailure {
  return { class: 'unknown', agent: 'claude', message: 'raw provider text', code: null, retryable: true, resetAt: null, ...overrides };
}

function ctx(overrides: Partial<FailureViewContext> = {}): FailureViewContext {
  return {
    agentLabel: 'Claude', now: NOW, resetAt: null, reconnected: false, hasRetry: true, hasRetryPayload: true,
    turnRunning: false, isLatest: true, timeZone: 'Asia/Seoul', ...overrides,
  };
}

const actions = (view: ReturnType<typeof failureView>) => view.actions.map((action) => action.id);

test('login is offered before reconnecting, 다시 시도 after', () => {
  const auth = failure({ class: 'auth_required', retryable: false, code: 'claude:authentication_failed' });
  const before = failureView(auth, 'turn', ctx());
  assert.equal(before.title, 'Claude 로그인이 필요해요');
  assert.deepEqual(actions(before), ['login']);
  const after = failureView(auth, 'turn', ctx({ reconnected: true }));
  assert.equal(after.line, '다시 연결됐어요');
  assert.deepEqual(actions(after), ['retry']);
  const pi = failureView(failure({ class: 'auth_required', agent: 'pi', code: 'PI_NOT_CONFIGURED', retryable: false }), 'start', ctx({ agentLabel: 'Pi' }));
  assert.equal(pi.title, 'Pi 연결 설정이 필요해요');
  assert.deepEqual(actions(pi), ['settings']);
});

test('usage limits follow the reset time: future, passed, or unknown', () => {
  const usage = failure({ class: 'usage_limit', retryable: false, code: 'claude:rate_limit' });
  const future = failureView(usage, 'turn', ctx({ resetAt: NOW + 3 * HOUR }));
  assert.equal(future.title, 'Claude 사용 한도에 도달했어요');
  assert.equal(future.line, '리셋 오후 3:00');
  assert.deepEqual(actions(future), ['resume', 'usage']);
  const passed = failureView(usage, 'turn', ctx({ resetAt: NOW - HOUR }));
  assert.equal(passed.line, '리셋 시각이 지났어요');
  assert.deepEqual(actions(passed), ['retry', 'usage']);
  const unknown = failureView(usage, 'turn', ctx());
  assert.equal(unknown.line, '리셋 시각을 알 수 없어요');
  assert.deepEqual(actions(unknown), ['usage'], 'no resend before the limit is known to have reset');
  const noPayload = failureView(usage, 'turn', ctx({ resetAt: NOW + HOUR, hasRetry: false, hasRetryPayload: false }));
  assert.deepEqual(actions(noPayload), ['usage'], 'nothing to resume without a stored request');
  const armed = failureView(usage, 'turn', ctx({ resetAt: NOW + HOUR, resumeArmed: true }));
  assert.equal(armed.line, '오후 1:00에 이어서 보낼게요');
  assert.deepEqual(actions(armed), ['cancel-resume']);
  const blocked = failureView(usage, 'turn', ctx({ resetAt: NOW - HOUR, resumeBlocked: true }));
  assert.equal(blocked.line, '리셋 뒤 이어서 보내지 못했어요');
  assert.deepEqual(actions(blocked), ['retry', 'usage']);
  const credits = failureView(failure({ class: 'usage_limit', code: 'openrouter_credits', retryable: false }), 'turn', ctx());
  assert.equal(credits.title, 'OpenRouter 크레딧이 부족해요');
  assert.equal(credits.line, null);
});

test('cleanup failures and a missing CLI never offer 다시 시도', () => {
  const cleanup = failureView(failure({ class: 'process_exited', code: 'cleanup_uncertain', retryable: false }), 'turn', ctx());
  assert.equal(cleanup.title, '이전 Claude 프로세스를 정리하지 못했어요');
  assert.equal(cleanup.line, '앱을 다시 시작한 뒤 계속해 주세요.');
  assert.deepEqual(actions(cleanup), []);
  const hubCleanup = failureView(failure({ class: 'process_exited', code: 'AGENT_PROCESS_CLEANUP_UNCERTAIN', retryable: false }), 'send', ctx());
  assert.deepEqual(actions(hubCleanup), []);
  const missing = failureView(failure({ class: 'process_exited', code: 'cli_missing', retryable: false }), 'turn', ctx());
  assert.equal(missing.title, 'Claude CLI를 찾지 못했어요');
  assert.deepEqual(actions(missing), ['settings']);
});

test('retryable failures offer 다시 시도 only with something to resend, disabled while a turn runs', () => {
  const exited = failure({ class: 'process_exited', retryable: true });
  assert.deepEqual(actions(failureView(exited, 'turn', ctx())), ['retry']);
  assert.deepEqual(actions(failureView(exited, 'turn', ctx({ hasRetry: false, hasRetryPayload: false }))), []);
  const running = failureView(exited, 'turn', ctx({ turnRunning: true }));
  assert.equal(running.actions[0]?.disabled, true);
  assert.equal(running.actions[0]?.title, '작업이 끝난 뒤 다시 시도할 수 있어요');
  const start = failureView(failure({ class: 'process_exited', code: 'AGENT_SPAWN_FAILED' }), 'start', ctx({ hasRetryPayload: false }));
  assert.equal(start.title, 'Claude CLI를 시작하지 못했어요');
  assert.deepEqual(actions(start), ['retry']);
  const context = failureView(failure({ class: 'invalid_request', code: 'codex:contextWindowExceeded', retryable: false }), 'turn', ctx({ agentLabel: 'Codex' }));
  assert.equal(context.title, '대화가 너무 길어 Codex가 처리하지 못했어요');
  assert.deepEqual(actions(context), []);
});

test('only the newest notice keeps actions; older ones keep the title only', () => {
  const view = failureView(failure({ class: 'network' }), 'turn', ctx({ isLatest: false }));
  assert.equal(view.compact, true);
  assert.deepEqual(view.actions, []);
  assert.equal(view.title, 'Claude에 연결하지 못했어요');
});

test('formatResetAt shows the time on the same day and the date on another day, in the viewer time zone', () => {
  assert.equal(formatResetAt(NOW + 3 * HOUR, NOW, 'Asia/Seoul'), '오후 3:00');
  assert.equal(formatResetAt(NOW + 45 * HOUR, NOW, 'Asia/Seoul'), '10월 12일 오전 9:00');
  // 같은 순간도 다른 시간대에서는 날짜가 바뀐다 (UTC 03:00 → 다음 날 아님).
  assert.equal(formatResetAt(NOW + 22 * HOUR, NOW, 'UTC'), '10월 11일 오전 1:00');
});

test('a resend after a turn that wrote to the document asks the agent to re-read first', () => {
  assert.equal(retryRequestText({ displayText: 'a', requestText: '표를 정리해 줘' }), '표를 정리해 줘');
  const partial = retryRequestText({ displayText: 'a', requestText: '표를 정리해 줘', afterPartialEdits: true });
  assert.ok(partial.startsWith('표를 정리해 줘'));
  assert.ok(partial.endsWith(PARTIAL_EDITS_RETRY_NOTE));
  // 로그인·사용 한도처럼 턴 도중 끊긴 실패가 아니면 처음 요청에 안내만 붙인다.
  const auth = retryWire({ displayText: 'a', requestText: '표를 정리해 줘', afterPartialEdits: true },
    failure({ class: 'auth_required' }), { stagedAwaitingReview: false, questionExpired: false });
  assert.deepEqual(auth, { displayText: 'a', requestText: partial });
});

test('다시 시도 after a turn that wrote and then died mid-turn continues instead of repeating the request', () => {
  const retry = { displayText: '표를 정리해 줘', requestText: '표를 정리해 줘', afterPartialEdits: true };
  for (const kind of ['process_exited', 'network', 'provider_error'] as const) {
    const wire = retryWire(retry, failure({ class: kind }), { stagedAwaitingReview: true, questionExpired: false });
    assert.equal(wire.displayText, '이어서 진행해 주세요.', kind);
    assert.ok(wire.requestText.startsWith('이어서 진행해 주세요.\n\n<turn_interrupted reason="agent-exit">'), kind);
    assert.ok(!wire.requestText.includes('표를 정리해 줘'), `${kind}: the original request is not sent again`);
    assert.match(wire.requestText, /still shown to the user as a preview/);
    assert.ok(wire.requestText.trimEnd().endsWith('</turn_interrupted>'));
  }
  // 아무것도 고치지 않은 실패는 처음 요청 그대로 다시 보낸다.
  const clean = retryWire({ displayText: '표를 정리해 줘', requestText: '표를 정리해 줘' },
    failure({ class: 'process_exited' }), { stagedAwaitingReview: false, questionExpired: false });
  assert.deepEqual(clean, { displayText: '표를 정리해 줘', requestText: '표를 정리해 줘' });
});

test('a failed turn holds the queue as failed with a short class label', () => {
  const hold = failureQueueHold(failure({ class: 'process_exited' }), { agentLabel: 'Claude', resetAt: null, now: NOW });
  assert.deepEqual(hold, { reason: 'failed', detail: 'Claude 실행 중단' });
});

test('dismissals are remembered per chat, class and text, and survive a storage that throws', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } as unknown as Storage;
  const first = createFailureDismissals(() => storage);
  const network = failure({ class: 'network', message: 'stream disconnected' });
  first.set('thread-1', network, true);
  const reloaded = createFailureDismissals(() => storage);
  assert.equal(reloaded.has('thread-1', network), true);
  assert.equal(reloaded.has('thread-2', network), false, 'another chat');
  assert.equal(reloaded.has('thread-1', { ...network, message: 'other text' }), false);
  reloaded.set('thread-1', network, false);
  assert.equal(createFailureDismissals(() => storage).has('thread-1', network), false);

  const broken = createFailureDismissals(() => { throw new Error('blocked'); });
  broken.set('thread-1', network, true);
  assert.equal(broken.has('thread-1', network), true, 'kept in memory for the page');
});

test('a resend knows its request already carries the interruption block by a flag, never by the text', () => {
  const ctx = { stagedAwaitingReview: false, questionExpired: false };
  // 사용자가 그 글자를 직접 썼다 — Studio 가 만든 이어서 진행이 아니다.
  const typed = retryWire({ displayText: '<turn_interrupted> 태그를 설명해 줘', requestText: '<turn_interrupted> 태그를 설명해 줘' },
    failure({ class: 'network' }), ctx);
  assert.notEqual(typed.continuation, true, 'typed text that looks like the block is not a continuation');
  // 턴 도중 끊긴 실패의 다시 시도는 이어서 진행을 새로 만든다.
  const resumed = retryWire({ displayText: '표를 정리해 줘', requestText: '표를 정리해 줘', afterPartialEdits: true },
    failure({ class: 'network' }), ctx);
  assert.equal(resumed.continuation, true);
  // 그 이어서 진행이 또 실패해 저장된 요청을 다시 보낸다 — 이미 블록을 실었다.
  const again = retryWire({ displayText: resumed.displayText, requestText: resumed.requestText, continuation: true },
    failure({ class: 'auth_required' }), ctx);
  assert.equal(again.continuation, true);
  assert.equal(again.requestText, resumed.requestText);
});
