// Provider replay: the engine contract, and the real adapters driven by the
// committed (synthetic) fixtures through the in-process replay transport.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { startReplaySession } from './provider-replay/adapters.mjs';
import {
  REPLAY_FIXTURE_DIR,
  ReplayBundleError,
  loadReplayBundle,
  parseReplayBundle,
  providerReplayFixture,
} from './provider-replay/replay.mjs';
import { ReplayChildProcess, createReplaySpawner } from './provider-replay/replay-process.mjs';

const SYNTHETIC_META = {
  kind: 'meta', v: 1, agent: 'codex', transport: 'app-server', provenance: 'synthetic',
  basis: 'engine contract test', cli: 'codex-cli 0.0.0-test',
};

function bundle(records, meta = {}) {
  return parseReplayBundle(
    [{ ...SYNTHETIC_META, ...meta }, { kind: 'spawn' }, ...records].map((record) => JSON.stringify(record)).join('\n'),
    { source: 'inline' },
  );
}

function startProcess(records, meta) {
  const parsed = bundle(records, meta);
  const child = new ReplayChildProcess(parsed.meta, parsed.processes[0]);
  const lines = [];
  let buffered = '';
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      lines.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
    }
  });
  const events = [];
  child.on('exit', (code, signal) => events.push(['exit', code, signal]));
  child.on('close', (code, signal) => events.push(['close', code, signal]));
  return { child, lines, events };
}

async function ticks(count = 6) {
  for (let index = 0; index < count; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function send(child, frame) {
  child.stdin.write(`${JSON.stringify(frame)}\n`);
}

function problemsOf(child) {
  return [...child.run.leftover(), ...child.run.unexpected.map((frame) => JSON.stringify(frame)), ...child.run.errors];
}

test('expect blocks until the adapter writes a matching frame; others are reported as unexpected', async () => {
  const { child, lines } = startProcess([
    { kind: 'expect', json: { method: 'ping', params: { n: 1 } } },
    { kind: 'out', json: { id: '$in.id', result: 'pong' } },
  ]);
  await ticks();
  assert.deepEqual(lines, []);

  send(child, { id: 6, method: 'other' });
  send(child, { id: 7, method: 'ping', params: { n: 2 } });
  await ticks();
  assert.deepEqual(lines, [], 'a frame that only partly matches must not release the step');

  send(child, { id: 8, method: 'ping', params: { n: 1, extra: true } });
  await ticks();
  assert.deepEqual(lines, [{ id: 8, result: 'pong' }]);
  assert.equal(typeof lines[0].id, 'number', 'a numeric JSON-RPC id stays a number');
  assert.deepEqual(child.run.unexpected, [{ id: 6, method: 'other' }, { id: 7, method: 'ping', params: { n: 2 } }]);
});

test('captures and $in substitution keep their JSON types', async () => {
  const { child, lines } = startProcess([
    { kind: 'expect', json: { method: 'turn/start' }, capture: { thread: 'params.threadId', count: 'params.count', flags: 'params.flags' } },
    { kind: 'out', json: { id: '$in.id', result: { thread: '$cap.thread', count: '$cap.count', flags: '$cap.flags', literal: 'kept' } } },
    { kind: 'expect', json: { method: 'turn/interrupt', params: { threadId: '$cap.thread' } } },
    { kind: 'out', json: { id: '$in.id', result: {} } },
  ]);
  send(child, { id: 3, method: 'turn/start', params: { threadId: 'thread-9', count: 2, flags: [true, null] } });
  await ticks();
  assert.deepEqual(lines, [{ id: 3, result: { thread: 'thread-9', count: 2, flags: [true, null], literal: 'kept' } }]);

  send(child, { id: 4, method: 'turn/interrupt', params: { threadId: 'thread-other' } });
  await ticks();
  assert.equal(lines.length, 1, 'a captured value is matched exactly');
  send(child, { id: 5, method: 'turn/interrupt', params: { threadId: 'thread-9' } });
  await ticks();
  assert.deepEqual(lines[1], { id: 5, result: {} });
});

test('recorded ids are remapped to the live ids in later responses', async () => {
  const parsed = parseReplayBundle([
    { kind: 'meta', v: 1, agent: 'claude', transport: 'sdk', provenance: 'recorded', cli: '2.1.296 (Claude Code)' },
    { kind: 'spawn', t: 0 },
    { kind: 'in', t: 1, json: { request_id: 'recorded-init', type: 'control_request', request: { subtype: 'initialize', hooks: null } } },
    { kind: 'out', t: 2, json: { type: 'control_response', response: { subtype: 'success', request_id: 'recorded-init', response: {} } } },
    { kind: 'in', t: 3, json: { id: 1, method: 'initialize', params: {} } },
    { kind: 'out', t: 4, json: { id: 1, result: { ok: true } } },
  ].map((record) => JSON.stringify(record)).join('\n'));
  const child = new ReplayChildProcess(parsed.meta, parsed.processes[0]);
  const lines = [];
  child.stdout.on('data', (chunk) => lines.push(...String(chunk).trim().split('\n').map((line) => JSON.parse(line))));

  send(child, { request_id: 'live-7f3', type: 'control_request', request: { subtype: 'initialize', hooks: {} } });
  await ticks();
  assert.equal(lines[0].response.request_id, 'live-7f3');
  send(child, { id: 41, method: 'initialize', params: { other: 1 } });
  await ticks();
  assert.deepEqual(lines[1], { id: 41, result: { ok: true } });
  assert.deepEqual(child.run.unexpected, []);
});

test('ignoreOutbound frames are tolerated while other unexpected frames fail the replay', async () => {
  const parsed = bundle([{ kind: 'expect', json: { method: 'work' } }], { ignoreOutbound: [{ method: 'keepalive' }] });
  const spawner = createReplaySpawner(parsed);
  const child = spawner.spawnProcess('codex', ['app-server']);
  send(child, { method: 'keepalive', params: { at: 1 } });
  send(child, { method: 'work' });
  await ticks();
  spawner.assertConsumed();

  send(child, { method: 'surprise' });
  await ticks();
  assert.throws(() => spawner.assertConsumed(), /unexpected frame \{"method":"surprise"\}/);
});

test('await-kill releases on kill and later output is still played', async () => {
  const { child, lines, events } = startProcess([
    { kind: 'out', json: { n: 1 } },
    { kind: 'await-kill' },
    { kind: 'out', json: { n: 2, late: true } },
    { kind: 'exit', signal: 'SIGTERM' },
  ]);
  await ticks();
  assert.deepEqual(lines, [{ n: 1 }]);
  assert.deepEqual(events, []);
  assert.equal(child.kill('SIGTERM'), true);
  await child.exited;
  await ticks();
  assert.deepEqual(lines, [{ n: 1 }, { n: 2, late: true }]);
  assert.deepEqual(events, [['exit', null, 'SIGTERM'], ['close', null, 'SIGTERM']]);
  assert.deepEqual(problemsOf(child), []);
});

test('a kill the script does not expect ends the process and leaves the rest as leftover', async () => {
  const { child, events } = startProcess([
    { kind: 'expect', json: { method: 'never' } },
    { kind: 'out', json: { n: 1 } },
    { kind: 'exit', code: 0 },
  ]);
  child.kill('SIGTERM');
  await child.exited;
  await ticks();
  assert.deepEqual(events, [['exit', null, 'SIGTERM'], ['close', null, 'SIGTERM']]);
  assert.match(child.run.leftover().join('\n'), /expect .*never/);
});

test('a kill racing a process that is already exiting on its own lets it finish', async () => {
  const { child, lines, events } = startProcess([
    { kind: 'out', json: { type: 'agent_settled' } },
    { kind: 'out', json: { tail: true } },
    { kind: 'exit', code: 0 },
  ]);
  await ticks(1);
  child.kill('SIGTERM');
  await child.exited;
  await ticks();
  assert.deepEqual(lines, [{ type: 'agent_settled' }, { tail: true }]);
  assert.deepEqual(events, [['exit', 0, null], ['close', 0, null]]);
  assert.deepEqual(problemsOf(child), []);
});

test('exit without close emits only exit until a recorded close arrives', async () => {
  const { child, lines, events } = startProcess([
    { kind: 'exit', code: 0, close: false },
    { kind: 'out', json: { afterExit: true } },
    { kind: 'sleep', ms: 0 },
    { kind: 'close' },
  ]);
  await child.exited;
  assert.deepEqual(events, [['exit', 0, null]]);
  await ticks(10);
  assert.deepEqual(lines, [{ afterExit: true }]);
  assert.deepEqual(events, [['exit', 0, null], ['close', 0, null]]);

  const open = startProcess([{ kind: 'exit', code: 0, close: false }]);
  await open.child.exited;
  await ticks(10);
  assert.deepEqual(open.events, [['exit', 0, null]], 'a descendant still holds the pipes');
});

test('a stdin write after exit raises EPIPE on stdin', async () => {
  const { child } = startProcess([{ kind: 'exit', code: 1 }]);
  await child.exited;
  const error = await new Promise((resolve) => {
    child.stdin.once('error', resolve);
    child.stdin.write('{"type":"user"}\n');
  });
  assert.equal(error.code, 'EPIPE');
});

test('truncated, unlabelled and malformed bundles are refused', () => {
  const line = (record) => JSON.stringify(record);
  assert.throws(
    () => parseReplayBundle([line(SYNTHETIC_META), line({ kind: 'spawn' }), line({ kind: 'truncated', t: 9 })].join('\n')),
    ReplayBundleError,
  );
  const { basis: _basis, ...unlabelled } = SYNTHETIC_META;
  assert.throws(() => parseReplayBundle([line(unlabelled), line({ kind: 'spawn' })].join('\n')), /basis/);
  assert.throws(
    () => parseReplayBundle([line(SYNTHETIC_META), line({ kind: 'spawn' }), '{"kind":"out","json":{"broken"'].join('\n')),
    /<inline>:3: not valid JSON/,
  );
  assert.throws(() => parseReplayBundle(line(SYNTHETIC_META)), /at least one spawn/);
});

test('every committed fixture is labelled synthetic or recorded and names its basis', () => {
  const names = readdirSync(REPLAY_FIXTURE_DIR, { recursive: true })
    .filter((name) => String(name).endsWith('.ndjson'));
  assert.ok(names.length >= 15, `expected the starter fixtures, found ${names.length}`);
  for (const name of names) {
    const loaded = loadReplayBundle(path.join(REPLAY_FIXTURE_DIR, String(name)));
    assert.ok(['synthetic', 'recorded'].includes(loaded.meta.provenance), name);
    if (loaded.meta.provenance === 'synthetic') assert.ok(loaded.meta.basis.length > 20, name);
    assert.equal(String(name).split(path.sep)[0], loaded.meta.agent, `${name} lives under its agent`);
  }
});

const SINGLE_TURN_FIXTURES = [
  ['pi/text-turn', { stopReason: 'completed' }],
  ['pi/credits-402', { failed: true }],
  ['pi/auth-401', { failed: true }],
  ['pi/retry-then-success', {}],
  ['pi/crash-mid-turn', { stopReason: 'exited' }],
  ['claude/auth-failure', { failed: true }],
  ['claude/usage-limit', { failed: true }],
  ['claude/crash-mid-turn', { stopReason: 'exited' }],
  ['codex/app-server-auth', { failed: true }],
  ['codex/app-server-usage-limit', { failed: true }],
  ['codex/app-server-retry-then-success', { stopReason: 'completed' }],
  ['codex/app-server-crash', { stopReason: 'exited' }],
  ['codex/exec-usage-limit', { failed: true }],
];

for (const [name, expected] of SINGLE_TURN_FIXTURES) {
  test(`fixture ${name} replays cleanly through the real adapter`, { timeout: 20_000 }, async (t) => {
    const run = startReplaySession(name, { t });
    const end = await run.runTurn('replay prompt');
    await run.replay.settled();
    run.replay.assertConsumed();
    assert.equal(run.events.filter((event) => event.type === 'turn-end').length, 1, 'exactly one turn-end');
    if (expected.stopReason) assert.equal(end.stopReason, expected.stopReason);
    if (expected.failed) assert.ok(end.errorMessage, 'a failed turn carries its reason');
    const written = JSON.stringify(run.replay.spawns.map((spawn) => spawn.process.run.stdinFrames));
    assert.match(written, /replay prompt/, 'the prompt reached the CLI');
  });
}

const INTERRUPT_RACES = [
  ['pi/interrupt-race', 'completed'],
  ['claude/interrupt-race', 'end_turn'],
  ['codex/app-server-interrupt-race', 'completed'],
];

for (const [name, nextStop] of INTERRUPT_RACES) {
  test(`${name}: stop wins, late output is dropped and the next turn runs in a fresh process`, { timeout: 20_000 }, async (t) => {
    const run = startReplaySession(name, { t });
    run.session.sendUserMessage('first turn');
    await run.waitForEvent((event) => event.type === 'text-delta');
    const interruptedAt = run.events.length;
    run.session.interrupt();
    const first = await run.turnEnd(1);
    assert.equal(first.stopReason, 'interrupted');
    // Let the killed process play its late output and exit before checking.
    await run.replay.settled();
    await ticks(10);
    const afterStop = run.events.slice(interruptedAt);
    assert.deepEqual(
      afterStop.filter((event) => /^(text-delta|tool-|task-|turn-end)/.test(event.type)).map((event) => event.type),
      ['turn-end'],
      'only the interrupted turn-end follows the stop',
    );

    const second = await run.runTurn('second turn');
    assert.equal(second.stopReason, nextStop);
    await run.replay.settled();
    assert.equal(run.replay.spawns.length, 2, 'the next turn spawns a fresh process');
    assert.equal(run.events.filter((event) => event.type === 'turn-end').length, 2);
    assert.ok(!run.events.some((event) => event.type === 'text-delta' && /중단 뒤에 도착한/.test(event.text)));
    run.replay.assertConsumed();

    if (name.startsWith('codex/')) {
      const interrupt = run.replay.spawns[0].process.run.stdinFrames.find((frame) => frame.method === 'turn/interrupt');
      assert.deepEqual(interrupt?.params, { threadId: 'thread-replay-1', turnId: 'turn-replay-1' });
    }
  });
}

test("meta.terminate 'fail' drives the unproven-cleanup path", { timeout: 20_000 }, async (t) => {
  const text = readFileSync(providerReplayFixture('pi/text-turn'), 'utf8').split('\n');
  const meta = { ...JSON.parse(text[0]), terminate: 'fail' };
  const failing = parseReplayBundle([JSON.stringify(meta), ...text.slice(1)].join('\n'), { source: 'pi/text-turn+terminate-fail' });
  const run = startReplaySession(failing, { t });
  await run.runTurn('first');
  await run.replay.settled();
  await ticks(10);
  const second = await run.runTurn('second');
  assert.equal(second.stopReason, 'failed');
  assert.ok(run.events.some((event) => event.type === 'error' && /cleanup remains unconfirmed/.test(event.message)));
  assert.equal(run.replay.spawns.length, 1, 'no new process is started after an unproven cleanup');
});

test('the real Agent SDK runs over a replay process through spawnClaudeCodeProcess', { timeout: 20_000 }, async (t) => {
  // Synthetic: the smallest initialize response the SDK 0.3.281 accepts.
  // Real SDK replays should come from a recording.
  const sdkBundle = parseReplayBundle([
    {
      kind: 'meta', v: 1, agent: 'claude', transport: 'sdk', provenance: 'synthetic', cli: '2.1.296 (Claude Code)',
      basis: '@anthropic-ai/claude-agent-sdk 0.3.281 control protocol: control_request initialize answered by control_response success with response.request_id',
    },
    { kind: 'spawn' },
    { kind: 'expect', json: { type: 'control_request', request: { subtype: 'initialize' } } },
    { kind: 'out', json: { type: 'control_response', response: { subtype: 'success', request_id: '$in.request_id', response: { commands: [], agents: [], models: [], account: {} } } } },
    { kind: 'expect', json: { type: 'user', message: { role: 'user' } } },
    { kind: 'out', json: { type: 'system', subtype: 'init', session_id: 'sdk-replay-session', model: 'claude-sonnet-4-5', mcp_servers: [{ name: 'rhwp', status: 'connected' }], tools: [] } },
    { kind: 'out', json: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SDK 경로로 답했습니다.' } }, parent_tool_use_id: null, session_id: 'sdk-replay-session' } },
    { kind: 'out', json: { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'SDK 경로로 답했습니다.', stop_reason: 'end_turn', session_id: 'sdk-replay-session', usage: {}, modelUsage: {}, permission_denials: [] } },
    { kind: 'expect', end: true },
    { kind: 'exit', code: 0 },
  ].map((record) => JSON.stringify(record)).join('\n'), { source: 'inline-sdk' });
  const run = startReplaySession(sdkBundle, { t });
  const end = await run.runTurn('sdk prompt');
  await run.replay.settled();
  run.replay.assertConsumed();
  assert.equal(end.stopReason, 'end_turn');
  assert.deepEqual(
    run.events.filter((event) => event.type === 'text-delta').map((event) => event.text),
    ['SDK 경로로 답했습니다.'],
  );
  assert.equal(run.replay.spawns[0].process.run.stdinFrames[0].request.subtype, 'initialize');
  assert.equal(run.events.find((event) => event.type === 'session-info')?.sessionId, 'sdk-replay-session');
});
