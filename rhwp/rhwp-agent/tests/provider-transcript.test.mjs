// Provider transcript recorder (RHWP_PROVIDER_TRANSCRIPT_DIR): what reaches
// disk, its bounds, that it stays off by default, and that a recording
// replays into the same adapter events.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PROVIDER_TRANSCRIPT_ENV,
  recordingClaudeSdkSpawner,
  tapProviderProcess,
} from '../provider-transcript.mjs';
import { processTreeSpawnOptions, terminateProcessTree } from '../process-tree.mjs';
import { REPLAY_SESSION_TOKEN, startReplaySession } from './provider-replay/adapters.mjs';
import { parseReplayBundle } from './provider-replay/replay.mjs';
import { ReplayChildProcess } from './provider-replay/replay-process.mjs';

const SESSION_TOKEN = 'session-token-PLANTED0123456789';
const OPENROUTER_KEY = 'sk-or-v1-PLANTEDKEY0123456789abcdef';
const BEARER = 'Bearer PLANTEDBEARER0123456789abcdef';
const KEYED_SECRET = 'plain-looking-value-under-a-secret-key';
const PLANTED = [SESSION_TOKEN, OPENROUTER_KEY, 'PLANTEDBEARER0123456789abcdef', KEYED_SECRET];

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function scripted(records, meta = {}) {
  const bundle = parseReplayBundle([
    {
      kind: 'meta', v: 1, agent: 'pi', transport: 'json', provenance: 'synthetic',
      basis: 'recorder test script', cli: '1.1.0', ...meta,
    },
    { kind: 'spawn' },
    ...records,
  ].map((record) => JSON.stringify(record)).join('\n'));
  return new ReplayChildProcess(bundle.meta, bundle.processes[0]);
}

function readRecordings(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.ndjson')).sort()
    .map((name) => ({ name, text: readFileSync(path.join(dir, name), 'utf8') }));
}

function records(text) {
  return text.trim().split('\n').map((line) => JSON.parse(line));
}

async function closed(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => child.once('close', resolve));
}

test('recording removes planted credentials from argv, stdin, stdout and stderr and keeps every line valid JSON', async (t) => {
  const dir = path.join(tempDir(t, 'rhwp-transcript-'), 'nested', 'recordings');
  const child = scripted([
    { kind: 'expect', end: true },
    { kind: 'out', json: { type: 'session', id: 'pi-session', echo: `token ${SESSION_TOKEN}` } },
    { kind: 'out', json: { type: 'message_end', message: { errorMessage: `402 key ${OPENROUTER_KEY}`, api_key: KEYED_SECRET, nested: { authorization: { scheme: KEYED_SECRET } } } } },
    { kind: 'out', line: `plain text line with ${OPENROUTER_KEY}` },
    { kind: 'err', text: `request failed: Authorization: ${BEARER}\n` },
    { kind: 'exit', code: 1 },
  ]);
  const mcpConfig = JSON.stringify({ mcpServers: { rhwp: { command: 'node', env: { RHWP_AGENT_TOKEN: SESSION_TOKEN, RHWP_WS_URL: 'ws://127.0.0.1:1/mcp' } } } });
  tapProviderProcess(child, {
    agent: 'pi',
    transport: 'json',
    stdin: 'text',
    argv: ['--mode', 'json', '--mcp-config', mcpConfig, `--token=${SESSION_TOKEN}`],
    env: { PATH: '/usr/bin', OPENROUTER_API_KEY: OPENROUTER_KEY, RHWP_AGENT_TOKEN: SESSION_TOKEN },
    secrets: [SESSION_TOKEN],
    cli: '1.1.0',
    hubEnv: { [PROVIDER_TRANSCRIPT_ENV]: dir },
  });
  const stdout = [];
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
  child.stdin.end(`prompt mentioning ${SESSION_TOKEN} and ${OPENROUTER_KEY}`);
  await closed(child);

  assert.match(stdout.join(''), /PLANTEDKEY/, 'the adapter still sees the real output');
  const [recording, ...others] = readRecordings(dir);
  assert.deepEqual(others, []);
  for (const secret of PLANTED) assert.equal(recording.text.includes(secret), false, `${secret} reached disk`);
  const lines = records(recording.text);
  assert.deepEqual(lines.map((line) => line.kind), ['meta', 'spawn', 'in', 'in', 'out', 'out', 'out', 'err', 'exit', 'close']);
  assert.equal(lines[0].provenance, 'recorded');
  assert.equal(lines[0].cli, '1.1.0');
  assert.deepEqual(lines[1].envNames, ['OPENROUTER_API_KEY', 'PATH', 'RHWP_AGENT_TOKEN']);
  const recordedConfig = JSON.parse(lines[1].argv[3]);
  assert.equal(recordedConfig.mcpServers.rhwp.env.RHWP_AGENT_TOKEN, '[redacted]', 'JSON argv stays JSON');
  assert.equal(recordedConfig.mcpServers.rhwp.env.RHWP_WS_URL, 'ws://127.0.0.1:1/mcp');
  assert.equal(lines[5].json.message.api_key, '[redacted]');
  assert.equal(lines[5].json.message.nested.authorization.scheme, '[redacted]');
  assert.equal(lines[6].line.startsWith('plain text line with '), true);
  assert.deepEqual(lines[8], { kind: 'exit', t: lines[8].t, code: 1, signal: null });

  // The recording is itself a replayable bundle.
  const replayed = parseReplayBundle(recording.text, { source: recording.name });
  assert.equal(replayed.processes.length, 1);
});

test('records are bounded: a 100 KiB line is cut and a full file ends with truncated', async (t) => {
  const dir = tempDir(t, 'rhwp-transcript-bounds-');
  const long = 'x'.repeat(100 * 1024);
  const child = scripted([
    { kind: 'out', json: { type: 'message_update', delta: long, keep: 'short' } },
    { kind: 'exit', code: 0 },
  ]);
  tapProviderProcess(child, { agent: 'pi', transport: 'json', hubEnv: { [PROVIDER_TRANSCRIPT_ENV]: dir } });
  let delivered = '';
  child.stdout.on('data', (chunk) => { delivered += chunk; });
  child.stdin.end('prompt');
  await closed(child);
  assert.ok(delivered.length > 100 * 1024, 'the adapter still receives the whole line');
  const lines = records(readRecordings(dir)[0].text);
  const out = lines.find((line) => line.kind === 'out');
  assert.ok(out.truncatedBytes > 30 * 1024);
  assert.equal(out.json.keep, 'short');
  assert.ok(out.json.delta.length < 64 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 64 * 1024);

  const capped = tempDir(t, 'rhwp-transcript-cap-');
  const chatty = scripted([
    ...Array.from({ length: 200 }, (_, index) => ({ kind: 'out', json: { type: 'message_update', index, text: 'y'.repeat(100) } })),
    { kind: 'exit', code: 0 },
  ]);
  tapProviderProcess(chatty, {
    agent: 'pi', transport: 'json', hubEnv: { [PROVIDER_TRANSCRIPT_ENV]: capped }, limits: { maxFileBytes: 4096 },
  });
  let count = 0;
  chatty.stdout.on('data', (chunk) => { count += String(chunk).split('\n').filter(Boolean).length; });
  chatty.stdin.end('prompt');
  await closed(chatty);
  assert.equal(count, 200, 'recording stops, the process does not');
  const { text } = readRecordings(capped)[0];
  assert.ok(Buffer.byteLength(text) <= 4096);
  const cappedLines = records(text);
  assert.equal(cappedLines.at(-1).kind, 'truncated');
  assert.ok(cappedLines.length > 5);
});

test('recording is off unless the variable names an absolute directory', async (t) => {
  const dir = tempDir(t, 'rhwp-transcript-off-');
  for (const hubEnv of [{}, { [PROVIDER_TRANSCRIPT_ENV]: '' }, { [PROVIDER_TRANSCRIPT_ENV]: 'relative/dir' }]) {
    const child = scripted([{ kind: 'expect', end: true }, { kind: 'exit', code: 0 }]);
    const { write } = child.stdin;
    const { push } = child.stdout;
    assert.equal(tapProviderProcess(child, { agent: 'pi', transport: 'json', hubEnv }), child);
    assert.equal(child.stdin.write, write, 'stdin is untouched');
    assert.equal(child.stdout.push, push, 'stdout is untouched');
    child.stdin.end('prompt');
    await closed(child);
  }
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(existsSync(path.join(process.cwd(), 'relative')), false);
  assert.equal(recordingClaudeSdkSpawner({ hubEnv: {} }), undefined, 'the SDK keeps its own spawn');
});

test('the hub terminating a recorded process is recorded as await-kill before its exit', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t, 'rhwp-transcript-kill-');
  const child = tapProviderProcess(spawn(process.execPath, ['-e', `
    process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
    setInterval(() => {}, 1000);
  `], { ...processTreeSpawnOptions(), stdio: ['pipe', 'pipe', 'pipe'] }), {
    agent: 'codex', transport: 'app-server', hubEnv: { [PROVIDER_TRANSCRIPT_ENV]: dir },
  });
  child.stdout.resume();
  child.stderr.resume();
  await new Promise((resolve) => child.stdout.once('data', resolve));
  const done = new Promise((resolve) => child.once('close', resolve));
  assert.equal(await terminateProcessTree(child, { graceMs: 2_000 }), true);
  await done;
  const kinds = records(readRecordings(dir)[0].text).map((line) => line.kind);
  assert.deepEqual(kinds.slice(-4), ['out', 'await-kill', 'exit', 'close']);
});

test('the SDK recording spawner taps a real CLI process and drains its stderr', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t, 'rhwp-transcript-sdk-');
  const spawnRecorded = recordingClaudeSdkSpawner({ secrets: [SESSION_TOKEN], cli: '2.1.296', hubEnv: { [PROVIDER_TRANSCRIPT_ENV]: dir } });
  const child = spawnRecorded({
    command: process.execPath,
    args: ['-e', `
      process.stderr.write('e'.repeat(256 * 1024));
      process.stdin.on('data', (chunk) => {
        process.stdout.write(JSON.stringify({ type: 'control_response', echo: String(chunk).trim() }) + '\\n');
        process.exit(0);
      });
    `],
    cwd: process.cwd(),
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-PLANTEDSDKKEY0123456789' },
  });
  child.stdout.on('data', () => {});
  child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'r1', token: SESSION_TOKEN })}\n`);
  const [code] = await new Promise((resolve) => child.once('close', (...args) => resolve(args)));
  assert.equal(code, 0, 'a full stderr pipe would have blocked the CLI');
  const { text } = readRecordings(dir)[0];
  assert.equal(text.includes(SESSION_TOKEN), false);
  assert.equal(text.includes('PLANTEDSDKKEY'), false);
  const lines = records(text);
  assert.equal(lines[0].transport, 'sdk');
  assert.ok(lines.some((line) => line.kind === 'in' && line.json?.type === 'control_request'));
  assert.ok(lines.some((line) => line.kind === 'out' && line.json?.type === 'control_response'));
  assert.ok(lines.some((line) => line.kind === 'err'));
});

async function driveInterruptRace(run) {
  run.session.sendUserMessage('first turn');
  await run.waitForEvent((event) => event.type === 'text-delta');
  run.session.interrupt();
  await run.turnEnd(1);
  await run.replay.settled();
  await run.runTurn('second turn');
  await run.replay.settled();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

for (const [fixture, cliVersion] of [['pi/interrupt-race', '1.1.0'], ['codex/app-server-interrupt-race', 'codex-cli 0.149.0']]) {
  test(`a ${fixture} session recorded by the adapter's own tap replays into the same events`, { timeout: 30_000 }, async (t) => {
    const dir = tempDir(t, 'rhwp-transcript-roundtrip-');
    const plain = startReplaySession(fixture, { t });
    await driveInterruptRace(plain);

    process.env[PROVIDER_TRANSCRIPT_ENV] = dir;
    let recorded;
    try {
      recorded = startReplaySession(fixture, { t, opts: { providerCliVersion: cliVersion } });
      await driveInterruptRace(recorded);
      await recorded.close();
    } finally {
      delete process.env[PROVIDER_TRANSCRIPT_ENV];
    }
    assert.deepEqual(recorded.events, plain.events, 'recording does not change what the adapter emits');

    const files = readRecordings(dir);
    assert.equal(files.length, 2, 'one file per provider process');
    const joined = files.map((file) => file.text).join('');
    assert.equal(joined.includes(REPLAY_SESSION_TOKEN), false);
    const bundle = parseReplayBundle(joined, { source: `${fixture} (recorded)` });
    assert.equal(bundle.meta.provenance, 'recorded');
    assert.equal(bundle.meta.cli, cliVersion);
    assert.ok(records(files[0].text).some((line) => line.kind === 'await-kill'), 'the interrupt is in the recording');

    const replayed = startReplaySession(bundle, { t });
    await driveInterruptRace(replayed);
    replayed.replay.assertConsumed();
    assert.deepEqual(replayed.events, recorded.events);
  });
}
