// 프로바이더 실패 분류를 실제 어댑터로 확인한다: 각 replay fixture 가 진짜 claude/codex/pi
// 어댑터를 돌리고, 나온 이벤트를 허브의 makeBackendEventHandler 와 같은 정규화
// (normalizeProviderFailureEvent)에 통과시켜 Studio 가 받을 turn-end.failure 를 본다.
// Fixture 는 synthetic 이다 (provenance 는 각 파일의 meta 에 있다).
import assert from 'node:assert/strict';
import test from 'node:test';

import { readFileSync } from 'node:fs';

import { normalizeProviderFailureEvent } from '../provider-failure.mjs';
import { REPLAY_SESSION_TOKEN, startReplaySession } from './provider-replay/adapters.mjs';
import { parseReplayBundle, providerReplayFixture } from './provider-replay/replay.mjs';

const SECRETS = [REPLAY_SESSION_TOKEN, 'sk-or-v1-replayPlaceholderKey0123456789'];

/** 허브가 하는 그대로 이벤트를 차례로 정규화한다 (턴 시작에서 모은 실패를 비운다). */
function hubView(events, agent) {
  let held = null;
  let running = false;
  const out = [];
  for (const raw of events) {
    if (raw.type === 'turn-start') {
      held = null;
      running = true;
    }
    if (raw.type !== 'error' && raw.type !== 'turn-end') {
      out.push(raw);
      continue;
    }
    const normalized = normalizeProviderFailureEvent(raw, { agent, held, running, secrets: SECRETS });
    held = normalized.held;
    out.push(normalized.event);
    if (raw.type === 'turn-end') running = false;
  }
  return out;
}

async function replayTurn(t, fixture) {
  const run = startReplaySession(fixture, { t });
  await run.runTurn('replay prompt');
  await run.replay.settled();
  run.replay.assertConsumed();
  const agent = run.bundle.meta.agent;
  const events = hubView(run.events, agent);
  const turnEnds = events.filter((event) => event.type === 'turn-end');
  assert.equal(turnEnds.length, 1, 'exactly one turn-end');
  return { run, events, end: turnEnds[0] };
}

function assertNoSecret(events) {
  const text = JSON.stringify(events);
  assert.doesNotMatch(text, /REPLAYSECRET/, 'no planted secret reaches Studio');
  assert.equal(text.includes(REPLAY_SESSION_TOKEN), false, 'the MCP session token never reaches Studio');
}

test('claude/auth-failure: auth_required, and the error text is not drawn as an answer', { timeout: 20_000 }, async (t) => {
  const { events, end } = await replayTurn(t, 'claude/auth-failure');
  assert.equal(end.failure.class, 'auth_required');
  assert.equal(end.failure.code, 'claude:authentication_failed');
  assert.equal(end.failure.retryable, false);
  assert.deepEqual(
    events.filter((event) => event.type === 'text-delta').map((event) => event.text),
    [],
    'the synthetic API-error message produces no assistant bubble',
  );
});

test('claude: an API-error message without an erroring result still fails the turn with its text', { timeout: 20_000 }, async (t) => {
  // claude/auth-failure 를 바꿔 result 가 is_error 없이 끝나게 한다 — 말풍선을 거른 오류 문구가 사라지면 안 된다.
  const lines = readFileSync(providerReplayFixture('claude/auth-failure'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const meta = { ...lines[0], basis: `${lines[0].basis} Variant: assistant error overloaded, result without is_error.` };
  const records = lines.slice(1).map((record) => {
    if (record.json?.type === 'assistant') {
      return { ...record, json: { ...record.json, error: 'overloaded', message: { ...record.json.message, content: [{ type: 'text', text: 'API Error: 529 Overloaded' }] } } };
    }
    if (record.json?.type === 'result') {
      const { api_error_status: _status, ...result } = record.json;
      return { ...record, json: { ...result, is_error: false, stop_reason: 'end_turn', result: '' } };
    }
    return record;
  });
  const bundle = parseReplayBundle([meta, ...records].map((record) => JSON.stringify(record)).join('\n'), { source: 'claude/auth-failure+overloaded' });
  const { events, end } = await replayTurn(t, bundle);
  assert.equal(end.errorMessage, 'API Error: 529 Overloaded');
  assert.equal(end.failure.class, 'provider_error');
  assert.equal(end.failure.code, 'claude:overloaded');
  assert.deepEqual(events.filter((event) => event.type === 'text-delta'), []);
});

test('claude/usage-limit: usage_limit with the rejected window reset, not the wall-clock text', { timeout: 20_000 }, async (t) => {
  const { end } = await replayTurn(t, 'claude/usage-limit');
  assert.equal(end.failure.class, 'usage_limit');
  assert.equal(end.failure.resetAt, 4102444800 * 1000);
  assert.match(end.failure.message, /resets 3pm/, 'the provider text stays readable under details');
});

test('claude/crash-mid-turn: process_exited, retryable, no secret', { timeout: 20_000 }, async (t) => {
  const { events, end } = await replayTurn(t, 'claude/crash-mid-turn');
  assert.equal(end.stopReason, 'exited');
  assert.equal(end.failure.class, 'process_exited');
  assert.equal(end.failure.retryable, true);
  assertNoSecret(events);
});

test('codex/app-server-auth: auth_required from codexErrorInfo', { timeout: 20_000 }, async (t) => {
  const { end } = await replayTurn(t, 'codex/app-server-auth');
  assert.equal(end.failure.class, 'auth_required');
  assert.equal(end.failure.code, 'codex:unauthorized');
});

test('codex/app-server-usage-limit: usage_limit with resetAt from the exhausted window', { timeout: 20_000 }, async (t) => {
  const { events, end } = await replayTurn(t, 'codex/app-server-usage-limit');
  assert.equal(end.failure.class, 'usage_limit');
  assert.equal(end.failure.code, 'codex:usageLimitExceeded');
  assert.equal(end.failure.resetAt, 4102444800 * 1000);
  assert.equal(events.filter((event) => event.type === 'error').length, 1, 'the error notification is reported once');
});

test('codex/app-server-retry-then-success: a retried stream error is silent and the turn completes', { timeout: 20_000 }, async (t) => {
  const { events, end } = await replayTurn(t, 'codex/app-server-retry-then-success');
  assert.equal(end.stopReason, 'completed');
  assert.equal(end.failure, undefined);
  assert.deepEqual(events.filter((event) => event.type === 'error'), []);
});

test('codex/app-server-crash: process_exited, no secret', { timeout: 20_000 }, async (t) => {
  const { events, end } = await replayTurn(t, 'codex/app-server-crash');
  assert.equal(end.failure.class, 'process_exited');
  assertNoSecret(events);
});

test('codex/exec-usage-limit: usage_limit from legacy text, with no guessed reset time', { timeout: 20_000 }, async (t) => {
  const { end } = await replayTurn(t, 'codex/exec-usage-limit');
  assert.equal(end.failure.class, 'usage_limit');
  assert.equal(end.failure.resetAt, null);
});

test('pi/credits-402: usage_limit with the OpenRouter credits code and the key removed', { timeout: 20_000 }, async (t) => {
  const { events, end } = await replayTurn(t, 'pi/credits-402');
  assert.equal(end.failure.class, 'usage_limit');
  assert.equal(end.failure.code, 'openrouter_credits');
  assert.equal(events.filter((event) => event.type === 'error').length, 1);
  assertNoSecret(events);
});

test('pi/auth-401: auth_required', { timeout: 20_000 }, async (t) => {
  const { end } = await replayTurn(t, 'pi/auth-401');
  assert.equal(end.stopReason, 'failed');
  assert.equal(end.failure.class, 'auth_required');
});

test('pi/retry-then-success: a transient error Pi retried itself ends as a success', { timeout: 20_000 }, async (t) => {
  const { events, end } = await replayTurn(t, 'pi/retry-then-success');
  assert.equal(end.stopReason, 'completed');
  assert.equal(end.errorMessage, undefined);
  assert.equal(end.failure, undefined);
  assert.deepEqual(events.filter((event) => event.type === 'error'), []);
  assert.equal(
    events.filter((event) => event.type === 'text-delta').map((event) => event.text).join(''),
    '재시도 후 완료했습니다.',
  );
});

test('pi/crash-mid-turn: process_exited, no secret', { timeout: 20_000 }, async (t) => {
  const { events, end } = await replayTurn(t, 'pi/crash-mid-turn');
  assert.equal(end.failure.class, 'process_exited');
  assert.equal(end.failure.retryable, true);
  assertNoSecret(events);
});

for (const fixture of ['pi/interrupt-race', 'claude/interrupt-race', 'codex/app-server-interrupt-race']) {
  test(`${fixture}: Stop gives one interrupted turn-end with no failure and nothing after it`, { timeout: 20_000 }, async (t) => {
    const run = startReplaySession(fixture, { t });
    run.session.sendUserMessage('first turn');
    await run.waitForEvent((event) => event.type === 'text-delta');
    const stoppedAt = run.events.length;
    run.session.interrupt();
    await run.turnEnd(1);
    await run.replay.settled();
    for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve));
    const afterStop = hubView(run.events, run.bundle.meta.agent).slice(stoppedAt);
    assert.deepEqual(
      afterStop.filter((event) => event.type !== 'usage').map((event) => event.type),
      ['turn-end'],
      'nothing but the interrupted turn-end follows the stop',
    );
    assert.equal(afterStop.find((event) => event.type === 'turn-end').stopReason, 'interrupted');
    assert.equal(afterStop.find((event) => event.type === 'turn-end').failure, undefined);
  });
}
