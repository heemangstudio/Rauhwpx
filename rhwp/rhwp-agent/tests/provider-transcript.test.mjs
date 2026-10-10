// Provider transcript recorder (RHWP_PROVIDER_TRANSCRIPT_DIR): what reaches
// disk, its bounds, that it stays off by default, and that a recording
// replays into the same adapter events.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createClaudeSession } from '../agents/claude.mjs';
import {
  PROVIDER_TRANSCRIPT_ENV,
  recordingClaudeSdkSpawner,
  tapProviderProcess,
} from '../provider-transcript.mjs';
import { processTreeSpawnOptions, terminateProcessTree } from '../process-tree.mjs';
import { REPLAY_SESSION_TOKEN, startReplaySession } from './provider-replay/adapters.mjs';
import { installReplayCli } from './provider-replay/replay-cli.mjs';
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

test('stderr is redacted per line, so a secret split across pipe chunks never reaches disk', { timeout: 20_000 }, async (t) => {
  const dir = tempDir(t, 'rhwp-transcript-stderr-');
  // A key-shaped secret straddling the 64 KiB pipe read, a Bearer header and a
  // session token written in two writes each; the last line has no newline.
  const STRADDLE_KEY = 'sk-ant-api03-STRADDLEKEY0123456789abcdef';
  const SPLIT_BEARER = 'PLANTEDSPLITBEARER0123456789abcdef';
  const child = tapProviderProcess(spawn(process.execPath, ['-e', `
    const write = (text) => new Promise((resolve) => process.stderr.write(text, resolve));
    const pause = () => new Promise((resolve) => setTimeout(resolve, 60));
    (async () => {
      await write('x'.repeat(65536 - 13) + ' ' + ${JSON.stringify(STRADDLE_KEY)} + '\\n');
      await pause();
      await write('request failed: Authorization: Bearer ');
      await pause();
      await write(${JSON.stringify(SPLIT_BEARER)} + '\\n');
      await pause();
      await write('session ' + ${JSON.stringify(SESSION_TOKEN.slice(0, 12))});
      await pause();
      await write(${JSON.stringify(SESSION_TOKEN.slice(12))});
    })();
  `], { ...processTreeSpawnOptions(), stdio: ['pipe', 'pipe', 'pipe'] }), {
    agent: 'codex',
    transport: 'exec',
    secrets: [SESSION_TOKEN],
    hubEnv: { [PROVIDER_TRANSCRIPT_ENV]: dir },
    // Large enough that the record cap never hides a leak.
    limits: { maxRecordBytes: 256 * 1024 },
  });
  let delivered = '';
  child.stderr.on('data', (chunk) => { delivered += chunk; });
  child.stdout.resume();
  child.stdin.end();
  await closed(child);

  assert.ok(delivered.includes(SPLIT_BEARER) && delivered.includes(SESSION_TOKEN), 'the adapter still sees the real stderr');
  const { text } = readRecordings(dir)[0];
  for (const fragment of ['STRADDLEKEY0123456789abcdef', SPLIT_BEARER, SESSION_TOKEN, SESSION_TOKEN.slice(12)]) {
    assert.equal(text.includes(fragment), false, `${fragment} reached disk`);
  }
  const err = records(text).filter((line) => line.kind === 'err');
  assert.equal(err.length, 3, 'one record per stderr line');
  assert.ok(err[0].text.startsWith('xxx') && err[0].text.endsWith('[redacted]\n'));
  assert.match(err[1].text, /^request failed: Authorization: .*\[redacted\]\n$/);
  assert.equal(err[2].text, 'session [redacted]', 'the unterminated rest is flushed at close');
});

test('values under camelCase and prefixed secret keys and JWTs are redacted while token counts stay', async (t) => {
  const dir = tempDir(t, 'rhwp-transcript-keys-');
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwbGFudGVkLXVzZXIifQ.c2lnbmF0dXJlLXBsYW50ZWQtand0';
  const planted = {
    authToken: 'planted-auth-token-value',
    sessionToken: 'planted-session-token-value',
    oauthToken: 'planted-oauth-token-value',
    githubToken: 'planted-github-token-value',
    anthropicApiKey: 'planted-anthropic-api-key',
    'x-api-key': 'planted-x-api-key-value',
    clientSecret: 'planted-client-secret-value',
    privateKey: 'planted-private-key-value',
    credentials: { user: 'planted-credential-user' },
  };
  const child = scripted([
    { kind: 'expect', end: true },
    { kind: 'out', json: { type: 'auth_status', ...planted, nested: [{ refreshToken: 'planted-refresh-token-value' }] } },
    { kind: 'out', json: { type: 'message_end', note: `signed in with ${JWT}` } },
    { kind: 'out', line: `token header ${JWT} done` },
    // Usage counters as Claude, Codex and Pi report them.
    { kind: 'out', json: { type: 'result', usage: { input_tokens: 812, output_tokens: 64, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 }, modelUsage: { 'claude-sonnet-4-5': { inputTokens: 812, outputTokens: 64 } } } },
    { kind: 'out', json: { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } } },
    { kind: 'out', json: { type: 'message_end', message: { usage: { input: 7, output: 8, totalTokens: 15 }, stopReason: 'stop' } } },
    { kind: 'exit', code: 0 },
  ]);
  tapProviderProcess(child, { agent: 'pi', transport: 'json', hubEnv: { [PROVIDER_TRANSCRIPT_ENV]: dir } });
  child.stdout.resume();
  child.stdin.end('prompt');
  await closed(child);

  const { text } = readRecordings(dir)[0];
  for (const secret of [...Object.values(planted).filter((value) => typeof value === 'string'), 'planted-credential-user', 'planted-refresh-token-value', JWT, 'c2lnbmF0dXJlLXBsYW50ZWQtand0']) {
    assert.equal(text.includes(secret), false, `${secret} reached disk`);
  }
  const out = records(text).filter((line) => line.kind === 'out');
  assert.equal(out[0].json.authToken, '[redacted]');
  assert.equal(out[0].json.credentials.user, '[redacted]');
  assert.equal(out[0].json.type, 'auth_status', 'other values stay readable');
  assert.equal(out[1].json.note, 'signed in with [redacted]');
  assert.equal(out[2].line, 'token header [redacted] done');
  assert.deepEqual(out[3].json.usage, { input_tokens: 812, output_tokens: 64, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 });
  assert.deepEqual(out[3].json.modelUsage, { 'claude-sonnet-4-5': { inputTokens: 812, outputTokens: 64 } });
  assert.deepEqual(out[4].json.usage, { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 });
  assert.deepEqual(out[5].json.message, { usage: { input: 7, output: 8, totalTokens: 15 }, stopReason: 'stop' });
});

test('spawn records are capped like the others and stay replayable', async (t) => {
  const dir = tempDir(t, 'rhwp-transcript-spawn-cap-');
  const child = scripted([{ kind: 'expect', end: true }, { kind: 'exit', code: 0 }]);
  tapProviderProcess(child, {
    agent: 'pi',
    transport: 'json',
    argv: ['--mode', 'json', '--append-system-prompt', 'brief '.repeat(20_000)],
    hubEnv: { [PROVIDER_TRANSCRIPT_ENV]: dir },
  });
  child.stdin.end('prompt');
  await closed(child);
  const { text } = readRecordings(dir)[0];
  const spawnRecord = records(text).find((line) => line.kind === 'spawn');
  assert.ok(Buffer.byteLength(JSON.stringify(spawnRecord)) <= 64 * 1024);
  assert.ok(spawnRecord.truncatedBytes > 50 * 1024);
  assert.deepEqual(spawnRecord.argv.slice(0, 3), ['--mode', 'json', '--append-system-prompt']);
  assert.equal('text' in spawnRecord, false, 'no stray text field');
  assert.equal(parseReplayBundle(text).processes.length, 1);
});

test('the first recording of a hub process prunes the oldest transcripts beyond the directory budget', async (t) => {
  const dir = tempDir(t, 'rhwp-transcript-prune-');
  const old = Date.now() / 1000 - 3_600;
  const transcripts = Array.from({ length: 5 }, (_, index) => `pi-json-2026-10-0${index + 1}T00-00-00-000Z-1-${index + 1}.ndjson`);
  transcripts.forEach((name, index) => {
    writeFileSync(path.join(dir, name), 'x'.repeat(100));
    utimesSync(path.join(dir, name), old + index, old + index);
  });
  // Files the recorder did not name are never touched, however old.
  writeFileSync(path.join(dir, 'notes.txt'), 'keep');
  writeFileSync(path.join(dir, 'fixture.ndjson'), 'keep');
  utimesSync(path.join(dir, 'notes.txt'), old - 100, old - 100);
  utimesSync(path.join(dir, 'fixture.ndjson'), old - 100, old - 100);

  const record = async (limits) => {
    const child = scripted([{ kind: 'expect', end: true }, { kind: 'exit', code: 0 }]);
    tapProviderProcess(child, { agent: 'pi', transport: 'json', hubEnv: { [PROVIDER_TRANSCRIPT_ENV]: dir }, limits });
    child.stdin.end('prompt');
    await closed(child);
  };
  await record({ maxDirFiles: 3, maxDirBytes: 250 });
  const left = readdirSync(dir).sort();
  assert.deepEqual(left.filter((name) => transcripts.includes(name)), transcripts.slice(3), 'the two newest within 250 bytes stay');
  assert.ok(left.includes('notes.txt') && left.includes('fixture.ndjson'));
  assert.equal(left.filter((name) => name.endsWith('.ndjson') && !transcripts.includes(name) && name !== 'fixture.ndjson').length, 1, 'the new recording was written');

  // Once per hub process: a later recording in the same directory does not prune again.
  await record({ maxDirFiles: 1, maxDirBytes: 1 });
  assert.deepEqual(readdirSync(dir).filter((name) => transcripts.includes(name)), transcripts.slice(3));
});

test('a Claude SDK failure shows the same stderr tail with and without recording', {
  timeout: 60_000,
  skip: process.platform === 'win32' && 'the Agent SDK spawns the CLI directly and cannot run the .cmd replay launcher',
}, async (t) => {
  const root = tempDir(t, 'rhwp-transcript-sdk-tail-');
  const bundlePath = path.join(root, 'sdk-crash.ndjson');
  writeFileSync(bundlePath, [
    {
      kind: 'meta', v: 1, agent: 'claude', transport: 'sdk', provenance: 'synthetic', cli: '2.1.296 (Claude Code)',
      basis: '@anthropic-ai/claude-agent-sdk 0.3.281: initialize handshake, then the CLI writes stderr and exits 1 mid-turn (ProcessTransport getProcessExitError appends ". stderr: <tail>")',
    },
    { kind: 'spawn' },
    { kind: 'expect', json: { type: 'control_request', request: { subtype: 'initialize' } } },
    { kind: 'out', json: { type: 'control_response', response: { subtype: 'success', request_id: '$in.request_id', response: { commands: [], agents: [], models: [], account: {} } } } },
    { kind: 'expect', json: { type: 'user', message: { role: 'user' } } },
    { kind: 'out', json: { type: 'system', subtype: 'init', session_id: 'sdk-tail-session', model: 'claude-sonnet-4-5', mcp_servers: [{ name: 'rhwp', status: 'connected' }], tools: [] } },
    { kind: 'err', text: 'API Error: Connection error.\n' },
    { kind: 'err', text: '    at streamRequest (file:///replay/cli.js:1:1)\n' },
    { kind: 'exit', code: 1 },
  ].map((record) => JSON.stringify(record)).join('\n'));

  const failureMessage = async (label, recordingDir) => {
    const work = path.join(root, label);
    mkdirSync(path.join(work, 'root'), { recursive: true });
    mkdirSync(path.join(work, 'home'), { recursive: true });
    const cli = installReplayCli(path.join(work, 'bin'), 'claude', bundlePath);
    const events = [];
    let turnEnded;
    const ended = new Promise((resolve) => { turnEnded = resolve; });
    const session = createClaudeSession({
      rootDir: path.join(work, 'root'),
      isolatedHome: path.join(work, 'home'),
      mcpScriptPath: path.join(work, 'mcp-stdio.mjs'),
      hubPort: 5199,
      token: REPLAY_SESSION_TOKEN,
      sessionId: `sdk-tail-${label}`,
      permissionProfile: 'safe',
      claudeBin: cli.binPath,
      model: 'claude-sonnet-4-5',
      agentRole: 'chat',
      requestUserInput: async () => ({ status: 'cancelled', reason: 'user-stop' }),
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'turn-end') turnEnded();
      },
    }, { closeGraceMs: 500, flushCredentialMirrors: () => {} });
    if (recordingDir) process.env[PROVIDER_TRANSCRIPT_ENV] = recordingDir;
    try {
      session.sendUserMessage('sdk prompt');
      await ended;
    } finally {
      delete process.env[PROVIDER_TRANSCRIPT_ENV];
      await session.dispose();
    }
    return events.filter((event) => event.type === 'error').map((event) => event.message);
  };

  const plain = await failureMessage('plain', null);
  assert.equal(plain.length, 1);
  assert.match(plain[0], /exited with code 1\. stderr: API Error: Connection error\.\n {4}at streamRequest/);
  const recordingDir = path.join(root, 'recordings');
  const recorded = await failureMessage('recorded', recordingDir);
  assert.deepEqual(recorded, plain, 'recording does not change the error the user sees');
  const [file] = readRecordings(recordingDir);
  assert.ok(records(file.text).some((line) => line.kind === 'err' && line.text === 'API Error: Connection error.\n'));
});

test('a session recorded on Windows replays on another platform, where the adapter does not kill after the terminal frame', { timeout: 30_000 }, async (t) => {
  const dir = tempDir(t, 'rhwp-transcript-windows-');
  process.env[PROVIDER_TRANSCRIPT_ENV] = dir;
  let windows;
  try {
    // The Pi adapter as on Windows: it ends the process right after agent_settled.
    windows = startReplaySession('pi/text-turn', { t, dependencies: { platform: 'win32' } });
    const end = await windows.runTurn('first');
    assert.equal(end.stopReason, 'completed');
    await windows.replay.settled();
    await windows.close();
  } finally {
    delete process.env[PROVIDER_TRANSCRIPT_ENV];
  }
  assert.deepEqual(windows.replay.spawns[0].process.killSignals, ['SIGTERM'], 'the Windows adapter terminated the process');
  const [file] = readRecordings(dir);
  const recorded = records(file.text);
  assert.equal(recorded[0].platform, 'win32');
  const kinds = recorded.map((line) => line.kind);
  assert.ok(kinds.indexOf('await-kill') > recorded.findIndex((line) => line.json?.type === 'agent_settled'));

  const bundle = parseReplayBundle(file.text, { source: 'pi/text-turn (recorded on win32)' });
  for (const platform of ['linux', 'win32']) {
    const replayed = startReplaySession(bundle, { t, dependencies: { platform } });
    const end = await replayed.runTurn('second', { timeoutMs: 5_000 });
    assert.equal(end.stopReason, 'completed', platform);
    await replayed.replay.settled();
    replayed.replay.assertConsumed();
    assert.deepEqual(replayed.events.filter((event) => event.type === 'text-delta'), windows.events.filter((event) => event.type === 'text-delta'));
  }
});
