// The real hub (server.mjs) classifies, redacts and merges provider failures before
// they reach Studio. The replay CLI stands in for Pi through the hub's real binary
// lookup, so spawning, the adapter and the hub wiring all run unchanged. Fixtures
// are synthetic.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentEvents,
  openStudio,
  sendChatMessage,
  startChat,
  startReplayPiHub,
} from './provider-replay/hub.mjs';
import { sendFrame } from './hub-harness.mjs';

const turnEndFrame = (frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end';

async function runPiTurn(t, fixture, sessionId) {
  const hub = await startReplayPiHub(t, fixture);
  const studio = await openStudio(t, hub.port, sessionId);
  const started = await startChat(studio, `${sessionId}-thread`, 'pi');
  sendChatMessage(studio, started, 'Check the document please.');
  const turnStart = await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start', 20_000);
  const turnEnd = await studio.next(turnEndFrame, 20_000);
  // Give the hub a moment to send anything it would send after the turn-end.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return { hub, studio, turnStart, turnEnd };
}

test('a usage-limit turn reaches Studio as one classified turn-end with no secret', { timeout: 40_000 }, async (t) => {
  const { studio, turnStart, turnEnd } = await runPiTurn(t, 'pi/credits-402', 'failure-credits');
  assert.equal(agentEvents(studio, 'turn-end').length, 1, 'exactly one turn-end');
  assert.equal(turnEnd.event.turnId, turnStart.event.turnId);
  assert.equal(turnEnd.event.stopReason, 'failed');
  assert.deepEqual(
    { class: turnEnd.event.failure.class, code: turnEnd.event.failure.code, retryable: turnEnd.event.failure.retryable },
    { class: 'usage_limit', code: 'openrouter_credits', retryable: false },
  );
  assert.equal(turnEnd.event.failure.agent, 'pi');
  assert.ok(turnEnd.event.failure.message.length <= 2000);
  const errors = agentEvents(studio, 'error');
  assert.equal(errors.length, 1, 'the failure is reported once, not once per attempt');
  assert.equal(errors[0].event.failure.class, 'usage_limit');
  const everything = JSON.stringify(studio.frames());
  assert.doesNotMatch(everything, /REPLAYSECRET/, 'the provider key planted in the error text never reaches Studio');
  assert.equal(everything.includes('test-placeholder-key'), false);
});

test('a retry Pi recovered from itself ends completed with no error frame', { timeout: 40_000 }, async (t) => {
  const { studio, turnEnd } = await runPiTurn(t, 'pi/retry-then-success', 'failure-retry');
  assert.equal(turnEnd.event.stopReason, 'completed');
  assert.equal(turnEnd.event.failure, undefined);
  assert.equal(turnEnd.event.errorMessage, undefined);
  assert.deepEqual(agentEvents(studio, 'error'), []);
  assert.equal(agentEvents(studio, 'text-delta').map((frame) => frame.event.text).join(''), '재시도 후 완료했습니다.');
});

test('a Pi crash mid-turn is a retryable process exit with the stderr secret removed', { timeout: 40_000 }, async (t) => {
  const { studio, turnEnd } = await runPiTurn(t, 'pi/crash-mid-turn', 'failure-crash');
  assert.equal(turnEnd.event.stopReason, 'exited');
  assert.equal(turnEnd.event.failure.class, 'process_exited');
  assert.equal(turnEnd.event.failure.retryable, true);
  assert.doesNotMatch(JSON.stringify(studio.frames()), /REPLAYSECRET/);
});

test('Pi without finished setup is refused at chat start as an auth failure', { timeout: 40_000 }, async (t) => {
  const hub = await startReplayPiHub(t, 'pi/text-turn', { piApiKey: null });
  const studio = await openStudio(t, hub.port, 'failure-pi-setup');
  sendFrame(studio, { type: 'chat-start', agent: 'pi', threadId: 'pi-setup-thread', documentId: 'pi-setup-doc', requestId: 'start-1' });
  const rejected = await studio.next((frame) => frame.type === 'chat-error', 20_000);
  assert.equal(rejected.code, 'PI_NOT_CONFIGURED');
  assert.equal(rejected.requestId, 'start-1');
  assert.equal(rejected.failure.class, 'auth_required');
  assert.equal(rejected.failure.agent, 'pi');
  assert.equal(rejected.failure.retryable, false);
  assert.equal(rejected.message, rejected.failure.message);
  assert.equal(hub.cli.spawnCount(), 0, 'no provider process was started');
});
