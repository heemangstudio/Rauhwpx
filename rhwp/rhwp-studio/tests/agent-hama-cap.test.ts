// Hama 한도 알림과 Hama 상태 읽기 — 5시간·주간 한도는 남은 시간과 싼 모델(먼저)·BYOK 를, 이번 달 한도는
// 리셋 시각과 BYOK 만 보인다. Hama 가 연결인지는 서버가 살아 있는 플랜이라고 답했을 때만 참이다.
import assert from 'node:assert/strict';
import test from 'node:test';

import { failureView, hamaCountdownLine, type FailureViewContext } from '../src/ui/agent-sidebar/failure-notice.ts';
import { hamaConnected, readHamaStatus } from '../src/agent/hama-status.ts';
import type { ProviderFailure } from '../src/agent/types.ts';

const NOW = Date.UTC(2026, 9, 30, 3, 0);
const HOUR = 3_600_000;
const CHEAP = { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' };

const cap = (code: string, resetAt: number): ProviderFailure => ({
  class: 'usage_limit', agent: 'hama', message: 'Hama quota exceeded', code, retryable: false, resetAt,
});

function ctx(overrides: Partial<FailureViewContext> = {}): FailureViewContext {
  return {
    agentLabel: 'Hama', now: NOW, resetAt: null, reconnected: false, hasRetry: true, hasRetryPayload: true,
    turnRunning: false, isLatest: true, timeZone: 'Asia/Seoul', hamaCheapModel: CHEAP, ...overrides,
  };
}

const ids = (view: ReturnType<typeof failureView>) => view.actions.map((action) => action.id);

test('a 5-hour cap counts down and offers the cheap model first, then BYOK', () => {
  const resetAt = NOW + 3 * HOUR + 12 * 60_000;
  const view = failureView(cap('hama_cap_5h', resetAt), 'turn', ctx({ resetAt }));
  assert.equal(view.title, 'Hama 5시간 사용 한도에 도달했어요');
  assert.equal(view.line, '3시간 12분 뒤 다시 쓸 수 있어요');
  assert.deepEqual(ids(view), ['hama-cheap', 'byok']);
  assert.equal(view.countdownAt, resetAt);

  // 싼 모델로 바꾼 뒤에는 다시 보내기만 남는다.
  const switched = failureView(cap('hama_cap_5h', resetAt), 'turn', ctx({ resetAt, hamaSwitchedTo: CHEAP.name }));
  assert.equal(switched.line, 'DeepSeek V4.1 Flash로 바꿨어요');
  assert.deepEqual(ids(switched), ['retry']);

  // 싼 모델이 없으면 BYOK 만, 리셋이 지났으면 다시 시도가 앞에 선다.
  assert.deepEqual(ids(failureView(cap('hama_cap_week', resetAt), 'turn', ctx({ resetAt, hamaCheapModel: null }))), ['byok']);
  const passed = failureView(cap('hama_cap_5h', NOW - 1), 'turn', ctx({ resetAt: NOW - 1 }));
  assert.equal(passed.line, '지금 다시 쓸 수 있어요');
  assert.deepEqual(ids(passed), ['retry', 'byok']);
});

test('a month cap shows only the reset time and BYOK', () => {
  const resetAt = NOW + 9 * 24 * HOUR;
  const view = failureView(cap('hama_cap_month', resetAt), 'turn', ctx({ resetAt }));
  assert.equal(view.title, 'Hama 이번 달 사용량을 모두 썼어요');
  assert.match(view.line ?? '', /^11월 8일 .+에 다시 쓸 수 있어요$/);
  assert.deepEqual(ids(view), ['byok']);
});

test('the countdown reads hours and minutes, then minutes', () => {
  assert.equal(hamaCountdownLine(NOW + 2 * HOUR, NOW), '2시간 뒤 다시 쓸 수 있어요');
  assert.equal(hamaCountdownLine(NOW + 90_000, NOW), '2분 뒤 다시 쓸 수 있어요');
});

test('Hama is connected only for an active plan; not enrolled (Pro included) and unknown shapes are not', () => {
  const active = readHamaStatus({
    availability: 'active',
    plan: { status: 'active', allowanceUsd: 15, periodStart: NOW - 21 * 24 * HOUR, periodEnd: NOW + 9 * 24 * HOUR },
    caps: { cap_5h: { usedUsd: 1, limitUsd: 3, resetsAt: null } },
    blocked: null,
    models: [
      { id: 'anthropic/claude-haiku-5.5', name: 'Haiku 5.5', reasoning: true, efforts: ['low', 'medium', 'high'] },
      { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', reasoning: true },
      { id: CHEAP.id, name: CHEAP.name },
    ],
    defaultModelId: 'anthropic/claude-sonnet-5.5',
    cheapModelIds: [CHEAP.id, 'anthropic/claude-opus-5.5'],
    ready: true,
  });
  assert.equal(hamaConnected(active), true);
  assert.deepEqual(active.models.map((model) => model.id), ['anthropic/claude-haiku-5.5', CHEAP.id]);
  assert.equal(active.defaultModelId, 'anthropic/claude-haiku-5.5');
  assert.deepEqual(active.cheapModelIds, [CHEAP.id]);
  assert.equal(active.caps?.cap_week, null);

  const notEnrolled = readHamaStatus({ availability: 'not_enrolled', plan: null, caps: null, models: [], ready: true });
  assert.equal(notEnrolled.availability, 'not_enrolled');
  assert.equal(hamaConnected(notEnrolled), false);
  assert.equal(readHamaStatus(null).availability, 'unavailable');
  assert.equal(hamaConnected({ ...active, ready: false }), false);
});
