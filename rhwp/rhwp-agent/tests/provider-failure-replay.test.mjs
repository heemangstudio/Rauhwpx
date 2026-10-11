// 프로바이더 실패 분류를 실제 어댑터로 확인한다: 각 replay fixture 가 진짜 claude/codex/pi
// 어댑터를 돌리고, 나온 이벤트를 허브의 makeBackendEventHandler 와 같은 정규화
// (normalizeProviderFailureEvent)에 통과시켜 Studio 가 받을 turn-end.failure 를 본다.
// Fixture 는 synthetic 이다 (provenance 는 각 파일의 meta 에 있다).
import assert from 'node:assert/strict';
import test from 'node:test';

import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { createClaudeSession } from '../agents/claude.mjs';
import { createPiSession } from '../agents/pi.mjs';
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

/** fixture 의 레코드를 바꾼 변형 번들 — meta.basis 에 무엇을 바꿨는지 덧붙인다. */
function fixtureVariant(fixture, change, mapRecords) {
  const lines = readFileSync(providerReplayFixture(fixture), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const meta = { ...lines[0], basis: `${lines[0].basis} Variant: ${change}` };
  return parseReplayBundle([meta, ...mapRecords(lines.slice(1))].map((record) => JSON.stringify(record)).join('\n'), {
    source: `${fixture}+variant`,
  });
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

test('claude: a usage-limit API error followed by a crash without a result stays a usage limit, with its text', { timeout: 20_000 }, async (t) => {
  // 한도 오류 메시지(말풍선으로 그리지 않는다) 뒤 result 없이 프로세스가 죽었다 — 종료가 이유를 덮으면
  // "You've hit your limit" 이 어디에도 남지 않고 '실행이 멈췄어요' 로 보인다.
  const bundle = fixtureVariant('claude/usage-limit', 'the CLI exits with code 1 instead of sending the result.', (records) => {
    const at = records.findIndex((record) => record.json?.type === 'result');
    return [...records.slice(0, at), { kind: 'err', text: 'unrelated stderr line\n' }, { kind: 'exit', code: 1 }];
  });
  const { events, end } = await replayTurn(t, bundle);
  assert.equal(end.stopReason, 'exited');
  assert.equal(end.failure.class, 'usage_limit');
  assert.equal(end.failure.code, 'claude:rate_limit');
  assert.equal(end.failure.resetAt, 4102444800 * 1000);
  assert.match(end.failure.message, /You've hit your limit/);
  const errors = events.filter((event) => event.type === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /You've hit your limit/, 'older Studios see the reason too');
  assert.deepEqual(events.filter((event) => event.type === 'text-delta'), []);
});

test('claude: extra usage keeps a rejected subscription window from being read as a usage limit', { timeout: 20_000 }, async (t) => {
  // 추가 사용량으로 넘어간 계정은 매 턴 status 'rejected' + overageStatus 'allowed' 를 받는다. 그 턴의 429 는
  // 일시적인 제한이다 — 5시간 뒤 리셋을 기다리게 하지 않고 다시 시도를 준다.
  const bundle = fixtureVariant('claude/usage-limit', 'extra usage is active (overageStatus allowed, isUsingOverage) and the API answers a transient 429.', (records) => records.map((record) => {
    if (record.json?.type === 'rate_limit_event') {
      const { overageDisabledReason: _reason, ...info } = record.json.rate_limit_info;
      return { ...record, json: { ...record.json, rate_limit_info: { ...info, overageStatus: 'allowed', isUsingOverage: true } } };
    }
    if (record.json?.type === 'assistant') {
      return { ...record, json: { ...record.json, message: { ...record.json.message, content: [{ type: 'text', text: 'API Error: 429 rate_limit_error' }] } } };
    }
    if (record.json?.type === 'result') return { ...record, json: { ...record.json, result: 'API Error: 429 rate_limit_error' } };
    return record;
  }));
  const { end } = await replayTurn(t, bundle);
  assert.equal(end.failure.class, 'provider_error');
  assert.equal(end.failure.retryable, true);
  assert.equal(end.failure.resetAt, null);
});

test('claude SDK: an auth API error followed by a transport failure stays a login failure, with its text', { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-claude-sdk-fail-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const frames = [
    { type: 'system', subtype: 'init', session_id: 'sdk-auth-crash', model: 'claude-test' },
    {
      type: 'assistant', error: 'authentication_failed', parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Invalid API key · Please run /login' }] },
    },
  ];
  const queryAgent = () => {
    let step = 0;
    return {
      [Symbol.asyncIterator]() { return this; },
      next() {
        const frame = frames[step++];
        if (frame) return Promise.resolve({ value: frame, done: false });
        return Promise.reject(new Error('Claude Code process exited with code 1'));
      },
      async close() {},
    };
  };
  const events = [];
  const session = createClaudeSession({
    rootDir: path.join(root, 'work'),
    isolatedHome: path.join(root, 'home'),
    mcpScriptPath: path.join(root, 'mcp-stdio.mjs'),
    hubPort: 5199,
    token: REPLAY_SESSION_TOKEN,
    permissionProfile: 'safe',
    agentRole: 'chat',
    requestUserInput: async () => ({ status: 'cancelled', reason: 'user-stop' }),
    onEvent: (event) => events.push(event),
  }, {
    queryAgent,
    closeGraceMs: 50,
    flushCredentialMirrors: () => {},
    spawnProcess() { throw new Error('the SDK transport must not fall back to the legacy CLI'); },
  });
  t.after(() => session.dispose());
  session.sendUserMessage('hello');
  const deadline = Date.now() + 5_000;
  while (!events.some((event) => event.type === 'turn-end') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const view = hubView(events, 'claude');
  const end = view.find((event) => event.type === 'turn-end');
  assert.ok(end, `a turn-end; got ${JSON.stringify(events.map((event) => event.type))}`);
  assert.equal(end.failure.class, 'auth_required');
  assert.equal(end.failure.code, 'claude:authentication_failed');
  assert.match(end.failure.message, /Invalid API key/);
  assert.deepEqual(view.filter((event) => event.type === 'text-delta'), []);
});

test('pi: a missing CLI is reported once, as cli_missing (설정 열기), not as a retryable unknown error', { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-pi-enoent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Node 가 실행 파일을 찾지 못하면 자식 프로세스는 'error'(ENOENT) 뒤 'close' 를 낸다.
  const spawnProcess = () => {
    const proc = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.pid = undefined;
    proc.exitCode = null;
    proc.signalCode = null;
    proc.kill = () => false;
    setImmediate(() => {
      proc.emit('error', Object.assign(new Error('spawn /opt/missing/pi ENOENT'), { code: 'ENOENT' }));
      proc.stdout.end();
      proc.stderr.end();
      proc.emit('close', -2, null);
    });
    return proc;
  };
  const events = [];
  const session = createPiSession({
    rootDir: root,
    piBin: '/opt/missing/pi',
    piRoot: path.join(root, 'pi'),
    model: 'mock-model',
    token: REPLAY_SESSION_TOKEN,
    hubPort: 5199,
    mcpScriptPath: path.join(root, 'mcp-stdio.mjs'),
    openRouterApiKey: 'sk-or-v1-replayPlaceholderKey0123456789',
    permissionProfile: 'safe',
    onEvent: (event) => events.push(event),
  }, { spawnProcess, terminateProcess: async () => true, waitForExit: async () => true, closeGraceMs: 50 });
  t.after(() => session.dispose());
  session.sendUserMessage('hello');
  const deadline = Date.now() + 5_000;
  while (!events.some((event) => event.type === 'turn-end') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  const view = hubView(events, 'pi');
  const errors = view.filter((event) => event.type === 'error');
  const ends = view.filter((event) => event.type === 'turn-end');
  assert.equal(errors.length, 1, 'one error line, not one from the spawn error and another at settle');
  assert.equal(ends.length, 1);
  assert.deepEqual(
    [ends[0].failure.class, ends[0].failure.code, ends[0].failure.retryable],
    ['process_exited', 'cli_missing', false],
  );
  assertNoSecret(view);
});

test('pi: an OpenRouter 403 (moderation) is a refused request, not a login problem', { timeout: 20_000 }, async (t) => {
  const bundle = fixtureVariant('pi/auth-401', 'OpenRouter answers 403 because the input was flagged by moderation.', (records) => records.map((record) => {
    if (record.json?.type === 'message_end' && record.json.message?.stopReason === 'error') {
      return { ...record, json: { ...record.json, message: { ...record.json.message, errorMessage: '403 openai/gpt-x requires moderation on OpenRouter. Your input was flagged for "harassment".' } } };
    }
    return record;
  }));
  const { events, end } = await replayTurn(t, bundle);
  assert.equal(end.failure.class, 'invalid_request');
  assert.equal(end.failure.retryable, false);
  assert.equal(events.filter((event) => event.type === 'error').length, 1);
});
