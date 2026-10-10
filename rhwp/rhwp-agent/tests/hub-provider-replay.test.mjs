// The real hub (server.mjs) running a replayed Pi: the replay CLI is installed
// as the managed Pi binary, so the hub's own spawning, Studio wiring and
// process-tree cleanup run unchanged. Fixtures are synthetic.
import assert from 'node:assert/strict';
import test from 'node:test';

import { sendFrame } from './hub-harness.mjs';
import {
  agentEvents,
  openStudio,
  processAlive,
  sendChatMessage,
  startChat,
  startReplayPiHub,
  waitUntil,
} from './provider-replay/hub.mjs';

test('a replayed Pi turn streams through the real hub and its stdin reached the CLI', { timeout: 40_000 }, async (t) => {
  const { port, cli } = await startReplayPiHub(t, 'pi/text-turn');
  const studio = await openStudio(t, port, 'replay-text-turn');
  const started = await startChat(studio, 'replay-text-thread', 'pi');
  sendChatMessage(studio, started, 'Summarize the open document please.');

  const turnStart = await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');
  const turnEnd = await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end', 20_000);
  assert.equal(turnEnd.event.stopReason, 'completed');
  assert.equal(turnEnd.event.turnId, turnStart.event.turnId);
  const text = agentEvents(studio, 'text-delta').map((frame) => frame.event.text).join('');
  assert.equal(text, '문단 3개를 확인했습니다.');

  const pid = await waitUntil(() => cli.results()[0]?.pid, 'the replay CLI never started');
  await waitUntil(() => !processAlive(pid), 'the replay CLI is still running');
  const [result, ...more] = cli.results();
  assert.deepEqual(more, []);
  assert.equal(cli.spawnCount(), 1);
  assert.deepEqual(result.unexpected, []);
  assert.equal(result.stdinFrames[0].end, true);
  assert.match(result.stdinFrames[0].text, /Summarize the open document please\./);
  if (process.platform !== 'win32') {
    // Windows Pi cleanup taskkills right after agent_settled, so the replay
    // may not get to write its own exit there.
    assert.deepEqual(result.exit, { code: 0, signal: null });
    assert.deepEqual(result.leftover, []);
  }
});

test('Stop during a replayed Pi turn gives one interrupted turn-end and the hub ends the process', { timeout: 40_000 }, async (t) => {
  const { port, cli } = await startReplayPiHub(t, 'pi/interrupt-race');
  const studio = await openStudio(t, port, 'replay-interrupt');
  const started = await startChat(studio, 'replay-interrupt-thread', 'pi');
  sendChatMessage(studio, started, 'Start a long answer.');
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'text-delta', 20_000);
  const firstPid = await waitUntil(() => cli.results()[0]?.pid, 'the first replay process never started');

  sendFrame(studio, { type: 'chat-interrupt' });
  const interrupted = await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  assert.equal(interrupted.event.stopReason, 'interrupted');

  // The hub's real process-tree cleanup, not the replay, ends the process.
  await waitUntil(() => !processAlive(firstPid), 'the interrupted provider process is still alive');
  if (process.platform !== 'win32') {
    const first = await waitUntil(() => cli.results()[0]?.exit && cli.results()[0], 'no exit was recorded');
    assert.equal(first.killed, true);
    assert.deepEqual(first.exit, { code: null, signal: 'SIGTERM' });
    assert.deepEqual(first.leftover, []);
  }

  sendChatMessage(studio, started, 'Now answer briefly.');
  const second = await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end', 20_000);
  assert.equal(second.event.stopReason, 'completed');
  assert.equal(cli.spawnCount(), 2, 'the next turn ran in a fresh process');
  assert.equal(agentEvents(studio, 'turn-end').length, 2, 'one turn-end per turn');
  const streamed = agentEvents(studio, 'text-delta').map((frame) => frame.event.text).join('');
  assert.doesNotMatch(streamed, /중단 뒤에 도착한/, 'output written after the kill never reaches Studio');
  assert.match(streamed, /두 번째 턴이 끝났습니다\./);
  const secondPid = await waitUntil(() => cli.results()[1]?.pid, 'the second replay process never started');
  await waitUntil(() => !processAlive(secondPid), 'the second replay process is still running');
  const secondResult = cli.results()[1];
  assert.deepEqual(secondResult.unexpected, []);
  if (process.platform !== 'win32') assert.deepEqual(secondResult.leftover, []);
});
