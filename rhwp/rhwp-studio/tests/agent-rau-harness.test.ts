// 호스팅 Rau 하네스 — 허브 상태 읽기, 피커 항목(열림·잠김·숨김), 기본 하네스, 크레딧 소진 알림.
import assert from 'node:assert/strict';
import test from 'node:test';

import { inactiveRauAgentStatus, rauConnected, readRauAgentStatus } from '../src/agent/rau-agent-status.ts';
import { normalizeAgentPrefs } from '../src/agent/agent-prefs.ts';
import type { ProviderFailure, RauAgentStatus } from '../src/agent/types.ts';
import { failureQueueHold, failureView, type FailureViewContext } from '../src/ui/agent-sidebar/failure-notice.ts';
import {
  rauCreditGauge,
  rauEntry,
  rauIsDefault,
  readHarnessChoice,
  recordHarnessChoice,
} from '../src/ui/agent-sidebar/rau-harness.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 30, 3, 0);
const RESET_ISO = '2026-11-30T15:00:00.000Z';

const frame = (overrides: Record<string, unknown> = {}) => ({
  availability: 'active',
  source: 'plan',
  credits: { allowanceUsd: 8, usedUsd: 2.5, remainingUsd: 5.5, resetsAt: RESET_ISO },
  exhausted: false,
  models: [{ id: 'rau', name: 'Rau', reasoning: true, efforts: ['low', 'high'], defaultEffort: 'high' }],
  defaultModelId: 'rau',
  ready: true,
  ...overrides,
});

const active = (overrides: Record<string, unknown> = {}): RauAgentStatus => readRauAgentStatus(frame(overrides));

test('the hub frame is read defensively: one Rau model, ISO or ms reset, inactive shapes collapse', () => {
  const status = active({
    models: [
      { id: 'anthropic/claude-haiku-5.5', name: 'Haiku 5.5' },
      { id: 'rau', name: 'Something else', reasoning: true, efforts: ['low', 'bogus', 'high'], defaultEffort: 'high' },
    ],
  });
  assert.equal(status.availability, 'active');
  assert.equal(status.source, 'plan');
  assert.deepEqual(status.models.map((model) => [model.id, model.name]), [['rau', 'Rau']]);
  assert.deepEqual(status.models[0]!.efforts, ['low', 'high']);
  assert.deepEqual(status.credits, { allowanceUsd: 8, usedUsd: 2.5, remainingUsd: 5.5, resetsAt: Date.parse(RESET_ISO) });
  assert.equal(rauConnected(status), true);

  assert.equal(active({ credits: { allowanceUsd: 2, usedUsd: 0.5, resetsAt: NOW + DAY }, source: 'trial' }).credits?.resetsAt, NOW + DAY);
  assert.equal(active({ credits: { allowanceUsd: 2, usedUsd: 0.5 } }).credits?.remainingUsd, 1.5);
  // 크레딧을 다 쓰면 exhausted 가 없어도 소진이다.
  assert.equal(active({ credits: { allowanceUsd: 8, usedUsd: 8, remainingUsd: 0 } }).exhausted, true);
  assert.equal(rauConnected(active({ ready: false })), false);
  assert.equal(rauConnected(active({ models: [] })), false);

  assert.equal(readRauAgentStatus({ availability: 'not_eligible' }).availability, 'not_eligible');
  assert.deepEqual(readRauAgentStatus(null), inactiveRauAgentStatus());
  assert.deepEqual(readRauAgentStatus({ availability: 'weird' }), inactiveRauAgentStatus());
});

test('Rau entry: active opens it, any other desktop state shows it locked, web Studio hides it', () => {
  assert.equal(rauEntry(active(), true), 'open');
  assert.equal(rauEntry(active(), false), 'open');
  for (const status of [null, inactiveRauAgentStatus('not_eligible'), inactiveRauAgentStatus('unavailable')]) {
    assert.equal(rauEntry(status, true), 'locked');
    assert.equal(rauEntry(status, false), 'hidden');
  }
});

test('Rau is the default only for connected users without another chosen or used harness', () => {
  const fresh = { choice: null, hasChats: false };
  assert.equal(rauIsDefault(active(), fresh), true);
  assert.equal(rauIsDefault(inactiveRauAgentStatus('not_eligible'), fresh), false);
  assert.equal(rauIsDefault(active(), { choice: 'claude', hasChats: false }), false);
  assert.equal(rauIsDefault(active(), { choice: 'rau', hasChats: true }), true);
  assert.equal(rauIsDefault(active(), { choice: null, hasChats: true }), false);
});

test('stored hama choices and prefs read as rau', () => {
  const map = new Map<string, string>([['rhwp-agent-harness-choice', 'hama']]);
  const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
  assert.equal(readHarnessChoice(storage), 'rau');
  recordHarnessChoice('codex', storage);
  assert.equal(readHarnessChoice(storage), 'codex');
  assert.equal(normalizeAgentPrefs({ defaultAgent: 'hama' }).defaultAgent, 'rau');
});

test('the credit gauge reads remaining credit and marks trial and exhaustion', () => {
  assert.deepEqual(rauCreditGauge(active()), {
    percent: 69, remainingUsd: 5.5, allowanceUsd: 8, resetsAt: Date.parse(RESET_ISO), exhausted: false, trial: false,
  });
  const exhausted = rauCreditGauge(active({ source: 'trial', exhausted: true, credits: { allowanceUsd: 2, usedUsd: 2, remainingUsd: 0 } }));
  assert.equal(exhausted?.percent, 0);
  assert.equal(exhausted?.trial, true);
  assert.equal(exhausted?.exhausted, true);
  assert.equal(rauCreditGauge(inactiveRauAgentStatus('not_eligible')), null);
});

const credits = (overrides: Partial<ProviderFailure> = {}): ProviderFailure => ({
  class: 'usage_limit', agent: 'rau', message: `Rau 크레딧을 모두 썼어요.\n429 Rau quota exceeded [rau-credits:${RESET_ISO}]`,
  code: 'rau_credits_exhausted', retryable: false, resetAt: null, ...overrides,
});

function ctx(overrides: Partial<FailureViewContext> = {}): FailureViewContext {
  return {
    agentLabel: 'Rau', now: NOW, resetAt: null, reconnected: false, hasRetry: true, hasRetryPayload: true,
    turnRunning: false, isLatest: true, timeZone: 'Asia/Seoul', ...overrides,
  };
}

const ids = (view: ReturnType<typeof failureView>) => view.actions.map((action) => action.id);

test('exhausted Rau credits name the refill day from the tag and offer the own AI, never a retry', () => {
  const view = failureView(credits(), 'turn', ctx());
  assert.equal(view.title, 'Rau 크레딧을 모두 썼어요');
  assert.equal(view.line, '12월 1일에 다시 채워져요');
  assert.deepEqual(ids(view), ['byok']);
  assert.equal(view.actions[0]!.label, '내 AI로 전환');
  // 코드가 없어도 꼬리표로 알아본다.
  assert.equal(failureView(credits({ code: null }), 'turn', ctx()).title, 'Rau 크레딧을 모두 썼어요');
  // 체험은 다시 채워지지 않으니 업그레이드가 먼저다.
  const trial = failureView(credits(), 'turn', ctx({ rauTrial: true }));
  assert.equal(trial.line, null);
  assert.deepEqual(ids(trial), ['rau-upgrade', 'byok']);
  assert.deepEqual(failureQueueHold(credits(), { agentLabel: 'Rau', resetAt: null, now: NOW }), { reason: 'failed', detail: 'Rau 크레딧 소진' });
});

test('a Rau turn without a live Rau plan offers the upgrade and the own AI', () => {
  const failure: ProviderFailure = {
    class: 'auth_required', agent: 'rau', message: 'rau_plan_required', code: 'RAU_AGENT_NOT_ACTIVE', retryable: false, resetAt: null,
  };
  const view = failureView(failure, 'turn', ctx());
  assert.equal(view.title, 'Rau를 쓸 수 없어요');
  assert.deepEqual(ids(view), ['rau-upgrade', 'byok']);
});
