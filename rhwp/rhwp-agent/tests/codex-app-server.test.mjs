import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  CODEX_RPC_LINE_LIMIT_BYTES,
  CodexJsonRpcConnection,
  buildCodexAppServerArgv,
} from '../agents/codex-app-server.mjs';
import { systemBriefFor } from '../agents/backend.mjs';
import { createCodexSession } from '../agents/codex.mjs';

class FakeStream extends EventEmitter {
  constructor(onWrite = null) {
    super();
    this.onWrite = onWrite;
    this.chunks = [];
  }

  write(chunk, callback) {
    const text = String(chunk);
    this.chunks.push(text);
    this.onWrite?.(text);
    callback?.();
    return true;
  }

  end(chunk) {
    if (chunk !== undefined) this.write(chunk);
  }
}

class FakeProcess extends EventEmitter {
  constructor(onFrame = null) {
    super();
    this.frames = [];
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.stdin = new FakeStream((text) => {
      if (!onFrame) return;
      for (const line of text.split('\n').filter(Boolean)) {
        const frame = JSON.parse(line);
        this.frames.push(frame);
        queueMicrotask(() => onFrame?.(frame, this));
      }
    });
    this.exitCode = null;
    this.signalCode = null;
  }

  send(frame) {
    this.stdout.emit('data', `${JSON.stringify(frame)}\n`);
  }

  kill(signal = 'SIGTERM') {
    if (this.exitCode !== null || this.signalCode !== null) return true;
    this.signalCode = signal;
    queueMicrotask(() => {
      this.emit('exit', null, signal);
      this.emit('close', null, signal);
    });
    return true;
  }

  exit(code = 0) {
    this.exitCode = code;
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }
}

function feature(enabled, stage = 'underDevelopment') {
  return {
    name: 'default_mode_request_user_input',
    enabled,
    defaultEnabled: false,
    stage,
    displayName: null,
    description: null,
    announcement: null,
  };
}

function reply(result) {
  return (frame, process) => process.send({ id: frame.id, result });
}

function appServerResponder({
  features = [feature(true)],
  enableFails = false,
  collaborationModes = [
    { name: 'Default', mode: 'default', model: null, reasoning_effort: null },
    { name: 'Plan', mode: 'plan', model: null, reasoning_effort: null },
  ],
} = {}) {
  let currentFeatures = structuredClone(features);
  return (frame, process) => {
    if (frame.method === 'initialize') return reply({ userAgent: 'codex/0.149.0' })(frame, process);
    if (frame.method === 'initialized') return;
    if (frame.method === 'collaborationMode/list') {
      return reply({ data: collaborationModes })(frame, process);
    }
    if (frame.method === 'experimentalFeature/list') {
      return reply({ data: currentFeatures, nextCursor: null })(frame, process);
    }
    if (frame.method === 'experimentalFeature/enablement/set') {
      if (enableFails) {
        process.send({ id: frame.id, error: { code: -32603, message: 'enable failed' } });
      } else {
        currentFeatures = currentFeatures.map((entry) => (
          entry.name === 'default_mode_request_user_input' ? { ...entry, enabled: true } : entry
        ));
        reply({ enablement: { default_mode_request_user_input: true } })(frame, process);
      }
      return;
    }
    if (frame.method === 'thread/start') {
      process.send({ method: 'thread/started', params: { thread: { id: 'thread-native' } } });
      return reply({ thread: { id: 'thread-native' } })(frame, process);
    }
    if (frame.method === 'thread/resume') return reply({ thread: { id: frame.params.threadId } })(frame, process);
    if (frame.method === 'thread/inject_items') return reply({})(frame, process);
    if (frame.method === 'turn/start') {
      process.send({
        method: 'turn/started',
        params: { threadId: frame.params.threadId, turn: { id: 'turn-native', status: 'inProgress' } },
      });
      return reply({ turn: { id: 'turn-native', status: 'inProgress' } })(frame, process);
    }
    if (frame.method === 'turn/interrupt') return reply({})(frame, process);
  };
}

function fakeWatcher() {
  return {
    start() {},
    finalize() {},
    stop() {},
  };
}

function harness(t, {
  workflow = 'direct',
  phase = 'implementing',
  permissionProfile = 'safe',
  responder = appServerResponder(),
  requestUserInput = async () => ({ status: 'cancelled', reason: 'user-stop' }),
  terminateProcess = (process) => process.kill('SIGTERM'),
  extraOpts = {},
  idleReleaseMs,
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-codex-app-server-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  const spawns = [];
  const opts = {
    rootDir: root,
    codexHome: path.join(root, '.codex'),
    mcpScriptPath: '/tmp/mcp-stdio.mjs',
    hubPort: 5123,
    token: 'secret',
    model: 'test-model',
    effort: 'high',
    permissionProfile,
    workflow,
    phase,
    capabilityEpoch: 1,
    agentRole: 'chat',
    requestUserInput,
    idleReleaseMs,
    onEvent: (event) => events.push(event),
    ...extraOpts,
  };
  const session = createCodexSession(opts, {
    spawnProcess(command, argv, options) {
      const native = argv[0] === 'app-server';
      const process = new FakeProcess(native ? responder : null);
      process.featureForced = argv.includes('default_mode_request_user_input');
      spawns.push({ command, argv, options, process, native });
      return process;
    },
    terminateProcess,
    waitForExit: async () => true,
    createRolloutWatcher: fakeWatcher,
  });
  return { session, events, spawns, opts };
}

async function settle(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('native Codex launch preparation cancels before spawn and later starts with the current CLI', async (t) => {
  const h = harness(t);
  let release;
  h.opts.prepareLaunch = () => new Promise((resolve) => { release = resolve; });
  h.session.sendUserMessage('cancel this installation wait');
  await settle(1);
  assert.equal(h.spawns.length, 0);
  h.session.interrupt();
  release({ bin: '/stale-cli' });
  await settle(1);
  assert.equal(h.spawns.length, 0);
  assert.equal(h.events.filter((event) => event.type === 'turn-end').length, 1);
  assert.equal(h.events.at(-1).stopReason, 'interrupted');

  h.opts.prepareLaunch = async () => ({ bin: '/fresh-native-codex', providerEnv: { RHWP_LAUNCH_ENV: 'fresh' } });
  h.session.sendUserMessage('start after installation');
  await settle();
  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].command, '/fresh-native-codex');
  assert.equal(h.spawns[0].options.env.RHWP_LAUNCH_ENV, 'fresh');
  assert.equal(h.events.at(-1).type, 'turn-start');
  assert.equal(await h.session.dispose(), true);
});

test('disposing native Codex during installation prevents its deferred child from starting', async (t) => {
  const h = harness(t);
  let release;
  h.opts.prepareLaunch = () => new Promise((resolve) => { release = resolve; });
  h.session.sendUserMessage('never launch');
  await settle(1);
  assert.equal(await h.session.dispose(), true);
  release({ bin: '/stale-cli' });
  await settle(1);
  assert.equal(h.spawns.length, 0);
  assert.equal(h.events.some((event) => event.type === 'turn-start'), false);
});

test('JSON-RPC line overflow closes the connection before parsing', async () => {
  const process = new FakeProcess();
  let closed;
  const connection = new CodexJsonRpcConnection(process, {
    onFrame() { throw new Error('oversized frame must not be parsed'); },
    onClosed(error) { closed = error; },
  });

  process.stdout.emit('data', Buffer.alloc(CODEX_RPC_LINE_LIMIT_BYTES + 1, 0x78));
  await settle(2);
  assert.equal(connection.closed, true);
  assert.equal(process.signalCode, 'SIGTERM');
  assert.match(closed.message, /larger than 8 MiB/);
});

test('JSON-RPC overflow does not reject requests before tree cleanup completes', async () => {
  const process = new FakeProcess();
  let releaseCleanup;
  const cleanup = new Promise((resolve) => { releaseCleanup = resolve; });
  let closed = false;
  const connection = new CodexJsonRpcConnection(process, {
    onFrame() {},
    onClosed() { closed = true; },
    terminateProcess(child) {
      child.signalCode = 'SIGTERM';
      child.emit('exit', null, 'SIGTERM');
      return cleanup;
    },
  });
  const request = connection.request('pending', {});
  let rejected = false;
  void request.catch(() => { rejected = true; });

  process.stdout.emit('data', Buffer.alloc(CODEX_RPC_LINE_LIMIT_BYTES + 1, 0x78));
  await settle(2);
  assert.equal(connection.closed, true);
  assert.equal(closed, false);
  assert.equal(rejected, false);

  releaseCleanup(true);
  await assert.rejects(request, /larger than 8 MiB/);
  assert.equal(closed, true);
});

test('JSON-RPC request deadlines remain referenced and leave no stale pending entry', async () => {
  const process = new FakeProcess();
  const connection = new CodexJsonRpcConnection(process, {
    onFrame() {},
    onClosed() {},
  });
  const request = connection.request('never/replies', {}, {
    timeoutMs: 5,
    label: 'fixture request',
  });
  const pending = [...connection.pending.values()][0];
  assert.equal(pending.timer.hasRef(), true);
  await assert.rejects(
    request,
    /fixture request timed out/,
  );
  assert.equal(connection.pending.size, 0);
  connection.close();
});

test('a JSON-RPC request deadline settles when it is the idle process\'s only active handle', () => {
  const serverUrl = new URL('../agents/codex-app-server.mjs', import.meta.url).href;
  const script = `
    const { EventEmitter } = await import('node:events');
    const { CodexJsonRpcConnection } = await import(${JSON.stringify(serverUrl)});
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stdin = { write() {} };
    const connection = new CodexJsonRpcConnection(proc, {
      onFrame() {},
      onClosed() {},
    });
    try {
      await connection.request('never/replies', {}, { timeoutMs: 5, label: 'idle request' });
    } catch (error) {
      process.stdout.write(String(error?.message));
    }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: 5_000,
  });

  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'idle request timed out');
});

test('app-server argv carries the isolated MCP capability profile', () => {
  const argv = buildCodexAppServerArgv({
    rootDir: '/tmp/project',
    mcpScriptPath: '/tmp/mcp.mjs',
    hubPort: 6199,
    token: 'secret',
    workflow: 'plan',
    phase: 'planning',
    permissionProfile: 'safe',
    agentRole: 'chat',
  });
  assert.deepEqual(argv.slice(0, 2), ['app-server', '--stdio']);
  assert.ok(argv.includes('multi_agent'));
  assert.ok(argv.includes('web_search="live"'));
  assert.ok(argv.includes('sandbox_mode="read-only"'));
  assert.match(argv.find((value) => value.startsWith('mcp_servers.rhwp.env=')), /RHWP_AGENT_ROLE = "chat"/);
});

test('direct mode negotiates native input and answers the original app-server request', async (t) => {
  let capturedRequest;
  const h = harness(t, {
    requestUserInput: async (request) => {
      capturedRequest = request;
      return {
        status: 'answered',
        answers: { database: { selectedOptionIds: ['option-2'] } },
      };
    },
  });
  h.session.sendUserMessage('Build it');
  await settle();

  assert.equal(h.spawns.length, 1);
  assert.equal(h.spawns[0].native, true);
  const methods = h.spawns[0].process.frames.map((frame) => frame.method);
  assert.deepEqual(methods.slice(0, 5), [
    'initialize', 'initialized', 'experimentalFeature/list', 'thread/start', 'turn/start',
  ]);
  const turn = h.spawns[0].process.frames.find((frame) => frame.method === 'turn/start');
  assert.equal(turn.params.collaborationMode.mode, 'default');
  assert.deepEqual(turn.params.collaborationMode.settings, {
    model: 'test-model',
    reasoning_effort: 'high',
    developer_instructions: systemBriefFor(h.opts, 'codex'),
  });
  assert.equal(turn.params.input[0].text, 'Build it');
  assert.equal(h.session.getSessionId(), 'thread-native');

  h.spawns[0].process.send({
    id: 'question-rpc',
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-native',
      turnId: 'turn-native',
      itemId: 'item-question',
      questions: [{
        id: 'database', header: 'Database', question: 'Which database?',
        isOther: true, isSecret: false,
        options: [
          { label: 'SQLite', description: 'Local' },
          { label: 'Postgres', description: 'Remote' },
        ],
      }],
      isBlocking: false,
    },
  });
  await settle();

  assert.equal(capturedRequest.providerRequestId, 'item-question');
  assert.deepEqual(h.spawns[0].process.frames.at(-1), {
    id: 'question-rpc',
    result: { answers: { database: { answers: ['Postgres'] } } },
  });
  assert.equal(h.events.some((event) => event.type === 'tool-call' && event.tool === 'ask_user_question'), false);

  h.spawns[0].process.send({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-native', turnId: 'turn-native',
      tokenUsage: {
        total: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 75, cacheWriteInputTokens: 4 },
        last: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 75, cacheWriteInputTokens: 4 },
      },
    },
  });
  h.spawns[0].process.send({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-native', turnId: 'turn-native',
      tokenUsage: {
        total: { inputTokens: 160, outputTokens: 35, cachedInputTokens: 100, cacheWriteInputTokens: 4 },
        last: { inputTokens: 60, outputTokens: 15, cachedInputTokens: 25, cacheWriteInputTokens: 0 },
      },
    },
  });
  h.spawns[0].process.send({
    method: 'turn/completed',
    params: { threadId: 'thread-native', turn: { id: 'turn-native', status: 'completed' } },
  });
  await settle();
  assert.deepEqual(h.events.find((event) => event.type === 'usage')?.usage, {
    inputTokens: 160, outputTokens: 35, cacheReadTokens: 100, cacheCreationTokens: 4,
  });
  assert.equal(h.events.at(-1).stopReason, 'completed');
  await h.session.dispose();
});

test('Codex opens provider authority only for the exact acknowledged app-server turn', async (t) => {
  const base = appServerResponder();
  let turnStartFrame = null;
  let turnProcess = null;
  let questionCalls = 0;
  const h = harness(t, {
    responder(frame, process) {
      if (frame.method === 'turn/start') {
        turnStartFrame = frame;
        turnProcess = process;
        return;
      }
      return base(frame, process);
    },
    requestUserInput: async () => {
      questionCalls += 1;
      return { status: 'cancelled', reason: 'user-stop' };
    },
  });
  h.session.sendUserMessage('Wait for the exact turn');
  await settle();
  assert.ok(turnStartFrame);
  assert.equal(h.events.some((event) => event.type === 'turn-start'), false);

  turnProcess.send({
    id: 'pre-start-question',
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-native', turnId: 'turn-before-ack', itemId: 'pre-start-item',
      questions: [{
        id: 'choice', header: 'Choice', question: 'Choose?', isOther: false, isSecret: false,
        options: [{ label: 'A', description: 'A' }, { label: 'B', description: 'B' }],
      }],
      isBlocking: false,
    },
  });
  await settle();
  assert.equal(questionCalls, 0);
  assert.equal(
    turnProcess.frames.find((frame) => frame.id === 'pre-start-question')?.error?.data?.code,
    'SUBAGENT_USER_INPUT_DENIED',
  );

  turnProcess.send({
    method: 'turn/started',
    params: { threadId: 'thread-native', turn: { id: 'turn-exact', status: 'inProgress' } },
  });
  turnProcess.send({ id: turnStartFrame.id, result: { turn: { id: 'turn-exact', status: 'inProgress' } } });
  await settle();
  assert.equal(h.events.filter((event) => event.type === 'turn-start').length, 1);

  turnProcess.send({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-native', turnId: 'turn-stale', delta: 'must not render' },
  });
  turnProcess.send({
    method: 'turn/completed',
    params: { threadId: 'thread-native', turn: { id: 'turn-stale', status: 'completed' } },
  });
  turnProcess.send({
    id: 'wrong-turn-question',
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-native', turnId: 'turn-stale', itemId: 'wrong-turn-item',
      questions: [{
        id: 'choice', header: 'Choice', question: 'Choose?', isOther: false, isSecret: false,
        options: [{ label: 'A', description: 'A' }, { label: 'B', description: 'B' }],
      }],
      isBlocking: false,
    },
  });
  await settle();
  assert.equal(questionCalls, 0);
  assert.equal(h.events.some((event) => event.type === 'text-delta'), false);
  assert.equal(h.events.some((event) => event.type === 'turn-end'), false);

  turnProcess.send({
    method: 'turn/completed',
    params: { threadId: 'thread-native', turn: { id: 'turn-exact', status: 'completed' } },
  });
  await settle();
  assert.equal(h.events.at(-1)?.stopReason, 'completed');
  assert.equal(turnProcess.signalCode, 'SIGTERM', 'turn-end waits for app-server tree cleanup');
  await h.session.dispose();
});

test('Codex settles once when started and completed arrive before the turn/start response', async (t) => {
  const base = appServerResponder();
  let terminateCalls = 0;
  const h = harness(t, {
    responder(frame, process) {
      if (frame.method === 'turn/start') {
        process.send({
          method: 'turn/started',
          params: {
            threadId: frame.params.threadId,
            turn: { id: 'turn-early-complete', status: 'inProgress' },
          },
        });
        process.send({
          method: 'turn/completed',
          params: {
            threadId: frame.params.threadId,
            turn: { id: 'turn-early-complete', status: 'completed' },
          },
        });
        queueMicrotask(() => process.send({
          id: frame.id,
          result: { turn: { id: 'turn-early-complete', status: 'completed' } },
        }));
        return;
      }
      return base(frame, process);
    },
    terminateProcess(process) {
      terminateCalls += 1;
      return process.kill('SIGTERM');
    },
  });

  h.session.sendUserMessage('Complete before the response');
  await settle(24);

  assert.equal(terminateCalls, 1, 'the terminal notification and rejected start RPC share one cleanup');
  assert.equal(h.events.filter((event) => event.type === 'turn-start').length, 1);
  assert.deepEqual(
    h.events.filter((event) => event.type === 'turn-end').map((event) => event.stopReason),
    ['completed'],
  );
  assert.equal(h.events.some((event) => (
    event.type === 'error' && /could not start the turn/i.test(event.message)
  )), false);
  assert.equal(await h.session.dispose(), true);
});

test('a retired Codex app-server generation cannot affect the resumed next turn', async (t) => {
  let questionCalls = 0;
  const h = harness(t, {
    requestUserInput: async () => {
      questionCalls += 1;
      return { status: 'cancelled', reason: 'user-stop' };
    },
  });
  h.session.sendUserMessage('turn A');
  await settle();
  const first = h.spawns[0].process;
  first.send({
    method: 'turn/completed',
    params: { threadId: 'thread-native', turn: { id: 'turn-native', status: 'completed' } },
  });
  await settle();

  h.session.sendUserMessage('turn B');
  await settle();
  assert.equal(h.spawns.length, 2);
  const endsBeforeStaleFrames = h.events.filter((event) => event.type === 'turn-end').length;
  first.send({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-native', turnId: 'turn-native', delta: 'late A' },
  });
  first.send({
    method: 'turn/completed',
    params: { threadId: 'thread-native', turn: { id: 'turn-native', status: 'completed' } },
  });
  first.send({
    id: 'late-a-question',
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-native', turnId: 'turn-native', itemId: 'late-a-item',
      questions: [{
        id: 'choice', header: 'Choice', question: 'Choose?', isOther: false, isSecret: false,
        options: [{ label: 'A', description: 'A' }, { label: 'B', description: 'B' }],
      }],
      isBlocking: false,
    },
  });
  await settle();
  assert.equal(questionCalls, 0);
  assert.equal(h.events.some((event) => event.type === 'text-delta' && event.text === 'late A'), false);
  assert.equal(h.events.filter((event) => event.type === 'turn-end').length, endsBeforeStaleFrames);
  h.session.interrupt();
  await settle();
  await h.session.dispose();
});

test('unproven app-server cleanup fails without advertising a provider turn', async (t) => {
  const h = harness(t, {
    responder: appServerResponder({ features: [] }),
    terminateProcess(process) {
      process.signalCode = 'SIGTERM';
      process.emit('exit', null, 'SIGTERM');
      process.emit('close', null, 'SIGTERM');
      return null;
    },
  });
  h.session.sendUserMessage('must remain quarantined');
  await settle(24);
  assert.equal(h.events.some((event) => event.type === 'turn-start'), false);
  assert.match(h.events.find((event) => event.type === 'error')?.message ?? '', /cleanup could not be confirmed/i);
  assert.equal(h.events.at(-1)?.stopReason, 'failed');
  assert.equal(h.spawns.length, 1, 'legacy fallback must not start without cleanup proof');
  assert.equal(await h.session.dispose(), false);
});

test('planning mode remains native without the default-mode feature', async (t) => {
  let capturedRequest;
  const h = harness(t, {
    workflow: 'plan',
    phase: 'planning',
    responder: appServerResponder({ features: [] }),
    requestUserInput: async (request) => {
      capturedRequest = request;
      return {
        status: 'answered',
        answers: { scope: { selectedOptionIds: ['option-1'] } },
      };
    },
  });
  h.session.sendUserMessage('Plan it');
  await settle();
  assert.equal(h.spawns.length, 1);
  const turn = h.spawns[0].process.frames.find((frame) => frame.method === 'turn/start');
  assert.equal(turn.params.collaborationMode.mode, 'plan');
  assert.deepEqual(turn.params.collaborationMode.settings, {
    model: 'test-model',
    reasoning_effort: 'high',
    developer_instructions: systemBriefFor(h.opts, 'codex'),
  });
  assert.equal(h.spawns[0].process.frames.some((frame) => frame.method === 'collaborationMode/list'), true);
  assert.equal(h.spawns[0].process.frames.some((frame) => frame.method === 'experimentalFeature/enablement/set'), false);
  assert.equal(h.spawns[0].process.frames.some((frame) => frame.method === 'experimentalFeature/list'), false);

  h.spawns[0].process.send({
    id: 'plan-question-rpc',
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-native',
      turnId: 'turn-native',
      itemId: 'plan-question',
      questions: [{
        id: 'scope', header: 'Scope', question: 'Which scope?',
        isOther: false, isSecret: false,
        options: [
          { label: 'Focused', description: 'Only the requested change' },
          { label: 'Broad', description: 'Include adjacent cleanup' },
        ],
      }],
      isBlocking: true,
    },
  });
  await settle();
  assert.ok(capturedRequest, JSON.stringify(h.spawns[0].process.frames.at(-1)));
  assert.equal(capturedRequest.providerRequestId, 'plan-question');
  assert.deepEqual(h.spawns[0].process.frames.at(-1), {
    id: 'plan-question-rpc',
    result: { answers: { scope: { answers: ['Focused'] } } },
  });

  h.spawns[0].process.send({
    method: 'turn/completed',
    params: { threadId: 'thread-native', turn: { id: 'turn-native', status: 'completed' } },
  });
  await settle();
  await h.session.dispose();
});

for (const entry of [
  { name: 'direct safe', workflow: 'direct', phase: 'implementing', permissionProfile: 'safe', collaboration: 'default', sandbox: 'workspaceWrite' },
  { name: 'direct full', workflow: 'direct', phase: 'implementing', permissionProfile: 'unrestricted', collaboration: 'default', sandbox: 'dangerFullAccess' },
  { name: 'awaiting approval full', workflow: 'plan', phase: 'awaiting-approval', permissionProfile: 'unrestricted', collaboration: 'plan', sandbox: 'readOnly' },
  { name: 'switching safe', workflow: 'plan', phase: 'switching', permissionProfile: 'safe', collaboration: 'plan', sandbox: 'readOnly' },
  { name: 'build safe', workflow: 'plan', phase: 'implementing', permissionProfile: 'safe', collaboration: 'default', sandbox: 'workspaceWrite' },
  { name: 'build full', workflow: 'plan', phase: 'implementing', permissionProfile: 'unrestricted', collaboration: 'default', sandbox: 'dangerFullAccess' },
]) {
  test(`Codex intent/access matrix: ${entry.name}`, async (t) => {
    const h = harness(t, entry);
    h.session.sendUserMessage('mode matrix');
    await settle();
    const turn = h.spawns[0].process.frames.find((frame) => frame.method === 'turn/start');
    assert.equal(turn.params.collaborationMode.mode, entry.collaboration);
    assert.equal(turn.params.sandboxPolicy.type, entry.sandbox);
    h.session.interrupt();
    await settle();
    await h.session.dispose();
  });
}

test('Plan fails closed when Codex does not advertise native Plan mode', async (t) => {
  const h = harness(t, {
    workflow: 'plan',
    phase: 'planning',
    responder: appServerResponder({
      collaborationModes: [{ name: 'Default', mode: 'default', model: null, reasoning_effort: null }],
    }),
  });
  h.session.sendUserMessage('Plan natively');
  await settle(24);
  assert.equal(h.spawns.length, 1, 'must not spawn legacy exec');
  assert.equal(h.spawns[0].native, true);
  assert.equal(h.spawns[0].process.frames.some((frame) => frame.method === 'thread/start'), false);
  assert.match(h.events.find((event) => event.type === 'error')?.message ?? '', /native Plan mode is unavailable/);
  assert.equal(h.events.at(-1)?.stopReason, 'failed');
  await h.session.dispose();
});

test('disabled default-mode feature is enabled and verified before the turn', async (t) => {
  const h = harness(t, { responder: appServerResponder({ features: [feature(false)] }) });
  h.session.sendUserMessage('Implement');
  await settle();
  const methods = h.spawns[0].process.frames.map((frame) => frame.method);
  assert.deepEqual(methods.filter((method) => method === 'experimentalFeature/list').length, 2);
  assert.ok(methods.indexOf('experimentalFeature/enablement/set') < methods.indexOf('thread/start'));
  assert.equal(h.spawns.length, 1);
  h.session.interrupt();
  await settle();
  await h.session.dispose();
});

test('0.149 empty runtime enablement response restarts with the CLI flag and re-verifies', async (t) => {
  const responder = (frame, process) => {
    if (frame.method === 'initialize') return reply({ userAgent: 'codex/0.149.0' })(frame, process);
    if (frame.method === 'initialized') return;
    if (frame.method === 'experimentalFeature/list') {
      return reply({ data: [feature(process.featureForced)], nextCursor: null })(frame, process);
    }
    if (frame.method === 'experimentalFeature/enablement/set') {
      return reply({ enablement: {} })(frame, process);
    }
    return appServerResponder()(frame, process);
  };
  const h = harness(t, { responder });
  h.session.sendUserMessage('Implement natively');
  await settle(24);
  assert.equal(h.spawns.length, 2);
  assert.equal(h.spawns.every((entry) => entry.native), true);
  assert.equal(h.spawns[0].argv.includes('default_mode_request_user_input'), false);
  assert.equal(h.spawns[1].argv.includes('default_mode_request_user_input'), true);
  assert.ok(h.spawns[1].process.frames.some((frame) => frame.method === 'turn/start'));

  // 플래그가 필요하다는 사실은 기억되므로 다음 턴은 한 번만 spawn한다.
  h.spawns[1].process.send({
    method: 'turn/completed',
    params: { threadId: 'thread-native', turn: { id: 'turn-native', status: 'completed' } },
  });
  await settle(24);
  h.session.sendUserMessage('Second turn');
  await settle(24);
  assert.equal(h.spawns.length, 3);
  const second = h.spawns[2];
  assert.equal(second.native, true);
  assert.equal(second.argv.includes('default_mode_request_user_input'), true);
  assert.equal(second.process.frames.some((frame) => frame.method === 'experimentalFeature/enablement/set'), false);
  assert.ok(second.process.frames.some((frame) => frame.method === 'turn/start'));
  h.session.interrupt();
  await settle();
  await h.session.dispose();
});

for (const entry of [
  { name: 'absent', responder: appServerResponder({ features: [] }) },
  { name: 'removed', responder: appServerResponder({ features: [feature(true, 'removed')] }) },
  { name: 'enablement failure', responder: appServerResponder({ features: [feature(false)], enableFails: true }) },
]) {
  test(`default-mode ${entry.name} falls back to legacy exec before starting a turn`, async (t) => {
    const h = harness(t, { responder: entry.responder });
    // legacy exec 는 네이티브 주입이 없으므로 기록이 붙은 인라인 글을 그대로 받는다.
    h.session.sendUserMessage('Fallback prompt', { handoff: HANDOFF });
    await settle(24);
    assert.equal(h.spawns.length, entry.name === 'enablement failure' ? 3 : 2);
    assert.equal(h.spawns[0].native, true);
    const legacy = h.spawns.at(-1);
    assert.deepEqual(legacy.argv.slice(0, 1), ['exec']);
    assert.equal(h.spawns[0].process.frames.some((frame) => frame.method === 'thread/start'), false);
    assert.match(legacy.process.stdin.chunks.join(''), /Fallback prompt/);
    assert.equal(h.events.filter((event) => event.type === 'turn-start').length, 1);
    legacy.process.exit(0);
    await h.session.dispose();
  });
}

test('interrupt uses turn/interrupt and settles the native turn once', async (t) => {
  const h = harness(t);
  h.session.sendUserMessage('Wait');
  await settle();
  h.session.interrupt();
  await settle();
  const interrupt = h.spawns[0].process.frames.find((frame) => frame.method === 'turn/interrupt');
  assert.deepEqual(interrupt.params, { threadId: 'thread-native', turnId: 'turn-native' });
  assert.deepEqual(h.events.filter((event) => event.type === 'turn-end').map((event) => event.stopReason), ['interrupted']);
  h.spawns[0].process.send({
    method: 'turn/completed',
    params: { threadId: 'thread-native', turn: { id: 'turn-native', status: 'interrupted' } },
  });
  await settle();
  assert.equal(h.events.filter((event) => event.type === 'turn-end').length, 1);
  await h.session.dispose();
});

test('Stop during startup negotiation never re-sends the stopped prompt through legacy exec', async (t) => {
  const base = appServerResponder();
  let firstProcess = null;
  const h = harness(t, {
    responder(frame, process) {
      firstProcess ??= process;
      if (frame.method === 'initialize' && process === firstProcess) return;
      return base(frame, process);
    },
  });
  h.session.sendUserMessage('STOPPED PROMPT');
  await settle(3);
  h.session.interrupt();
  await settle(60);

  assert.equal(h.spawns.some((entry) => entry.argv[0] === 'exec'), false);
  assert.equal(h.events.some((event) => event.type === 'turn-start'), false);
  assert.deepEqual(
    h.events.filter((event) => event.type === 'turn-end').map((event) => event.stopReason),
    ['interrupted'],
  );

  h.session.sendUserMessage('Next prompt');
  await settle(24);
  const next = h.spawns.at(-1);
  assert.equal(next.native, true);
  assert.ok(next.process.frames.some((frame) => (
    frame.method === 'turn/start' && frame.params.input[0].text === 'Next prompt'
  )));
  assert.equal(h.events.filter((event) => event.type === 'turn-start').length, 1);
  h.session.interrupt();
  await settle();
  await h.session.dispose();
});

test('Stop while the thread is resuming settles the turn exactly once', async (t) => {
  const base = appServerResponder();
  const h = harness(t, {
    responder(frame, process) {
      if (frame.method === 'thread/resume') return;
      return base(frame, process);
    },
  });
  h.session.sendUserMessage('turn A');
  await settle();
  h.spawns[0].process.send({
    method: 'turn/completed',
    params: { threadId: 'thread-native', turn: { id: 'turn-native', status: 'completed' } },
  });
  await settle();
  const endsBefore = h.events.filter((event) => event.type === 'turn-end').length;

  h.session.sendUserMessage('turn B');
  await settle();
  assert.ok(h.spawns.at(-1).process.frames.some((frame) => frame.method === 'thread/resume'));
  h.session.interrupt();
  await settle(60);

  assert.deepEqual(
    h.events.filter((event) => event.type === 'turn-end').slice(endsBefore).map((event) => event.stopReason),
    ['interrupted'],
  );
  assert.equal(h.events.some((event) => event.type === 'error'), false);
  await h.session.dispose();
});

test('a resumed chat receives the current editing instructions after switching to full access', async (t) => {
  const h = harness(t, { workflow: 'question', phase: 'questioning' });
  h.session.sendUserMessage('Discuss an edit');
  await settle();
  const first = h.spawns[0].process;
  const firstTurn = first.frames.find((frame) => frame.method === 'turn/start');
  assert.match(firstTurn.params.collaborationMode.settings.developer_instructions, /You are in 채팅/);
  first.send({ method: 'turn/completed', params: {
    threadId: 'thread-native', turn: { id: 'turn-native', status: 'completed' },
  } });
  await settle();
  await h.session.setPermissionProfile('unrestricted');
  await h.session.setExecutionMode({ workflow: 'direct', phase: 'implementing', capabilityEpoch: 2 });
  h.session.sendUserMessage('Apply the edit');
  await settle(24);
  const resumed = h.spawns.at(-1).process;
  assert.ok(resumed.frames.some((frame) => frame.method === 'thread/resume'));
  const turn = resumed.frames.find((frame) => frame.method === 'turn/start');
  assert.equal(turn.params.threadId, 'thread-native');
  assert.equal(turn.params.sandboxPolicy.type, 'dangerFullAccess');
  assert.match(turn.params.collaborationMode.settings.developer_instructions, /You are in 전체/);
  assert.doesNotMatch(turn.params.collaborationMode.settings.developer_instructions, /You are in 채팅/);
  h.session.interrupt();
  await settle();
  await h.session.dispose();
});

test('a mode switch before the first turn starts a fresh thread when Codex has no rollout to resume', async (t) => {
  const base = appServerResponder();
  const h = harness(t, {
    responder(frame, process) {
      if (frame.method === 'thread/resume') {
        process.send({ id: frame.id, error: { code: -32603, message: `no rollout found for thread id ${frame.params.threadId}` } });
        return;
      }
      return base(frame, process);
    },
  });
  await h.session.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 2 });
  await h.session.setExecutionMode({ workflow: 'direct', phase: 'implementing', capabilityEpoch: 3 });
  h.session.sendUserMessage('First after switching');
  await settle(24);
  const methods = h.spawns.at(-1).process.frames.map((frame) => frame.method);
  assert.equal(methods.includes('thread/resume'), false, 'an unrun thread has no rollout to resume');
  assert.ok(methods.includes('thread/start'), 'it starts a fresh thread instead of failing');
  assert.ok(methods.includes('turn/start'), 'the turn still starts');
  assert.equal(h.events.some((event) => event.type === 'error'), false);
  h.session.interrupt();
  await settle();
  await h.session.dispose();
});

test('mode changes restart app-server while idle, resume the thread, and select plan mode', async (t) => {
  const h = harness(t);
  h.session.sendUserMessage('First');
  await settle();
  h.spawns[0].process.send({
    method: 'turn/completed',
    params: { threadId: 'thread-native', turn: { id: 'turn-native', status: 'completed' } },
  });
  await settle();
  await h.session.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 2 });
  assert.equal(h.spawns.length, 2, 'Plan readiness starts eagerly before the mode change resolves');
  const readyMethods = h.spawns[1].process.frames.map((frame) => frame.method);
  assert.ok(readyMethods.includes('collaborationMode/list'));
  assert.ok(readyMethods.includes('thread/resume'));
  assert.equal(readyMethods.includes('turn/start'), false);
  h.session.sendUserMessage('Plan next');
  await settle(24);

  assert.equal(h.spawns.length, 2);
  const secondMethods = h.spawns[1].process.frames.map((frame) => frame.method);
  assert.ok(secondMethods.includes('thread/resume'));
  assert.equal(secondMethods.includes('thread/start'), false);
  const secondTurn = h.spawns[1].process.frames.find((frame) => frame.method === 'turn/start');
  assert.equal(secondTurn.params.collaborationMode.mode, 'plan');
  assert.equal(secondTurn.params.threadId, 'thread-native');
  h.session.interrupt();
  await settle();
  await h.session.dispose();
});

test('a native chat grant and explicit revocation change only that resumed conversation', async (t) => {
  const h = harness(t, { workflow: 'question', phase: 'questioning' });
  const other = harness(t, { workflow: 'question', phase: 'questioning' });
  t.after(() => Promise.all([h.session.dispose(), other.session.dispose()]));
  async function turn(chat, prompt) {
    chat.session.sendUserMessage(prompt);
    await settle(24);
    const process = chat.spawns.at(-1).process;
    const start = process.frames.find((frame) => frame.method === 'turn/start');
    process.send({ method: 'turn/completed', params: { threadId: 'thread-native', turn: { id: 'turn-native', status: 'completed' } } });
    await settle();
    return start.params;
  }
  const initial = await turn(h, 'Ask for local access');
  assert.equal(initial.sandboxPolicy.type, 'readOnly');
  await h.session.setExecutionMode({ workflow: 'question', phase: 'questioning', capabilityEpoch: 2, chatPermissionGrants: ['document-edit'] });
  const documentOnly = await turn(h, 'Continue after a stale document grant');
  assert.equal(documentOnly.collaborationMode.mode, 'plan');
  assert.equal(documentOnly.sandboxPolicy.type, 'readOnly');
  assert.deepEqual(h.opts.chatPermissionGrants, []);
  assert.match(systemBriefFor(h.opts, 'codex'), /The live document cannot be changed in this mode/);
  const mode = { workflow: 'question', phase: 'questioning', capabilityEpoch: 3, chatPermissionGrants: ['local-execution'] };
  await h.session.setExecutionMode(mode);
  mode.chatPermissionGrants.length = 0;
  const granted = await turn(h, 'Use the granted access');
  assert.equal(granted.sandboxPolicy.type, 'dangerFullAccess');
  assert.equal(granted.collaborationMode.mode, 'default');
  assert.equal(h.opts.permissionProfile, 'safe');
  assert.equal(h.opts.workflow, 'question');
  assert.ok(h.spawns.at(-1).process.frames.some((frame) => frame.method === 'thread/resume'));
  assert.equal((await turn(other, 'A separate chat')).sandboxPolicy.type, 'readOnly');
  await h.session.setExecutionMode({ workflow: 'question', phase: 'questioning', capabilityEpoch: 4, chatPermissionGrants: [] });
  const revoked = await turn(h, 'Access was cleared');
  assert.equal(revoked.sandboxPolicy.type, 'readOnly');
  assert.equal(revoked.collaborationMode.mode, 'plan');
  assert.equal(revoked.threadId, initial.threadId);
  await h.session.setExecutionMode({ workflow: 'direct', phase: 'implementing', capabilityEpoch: 5, chatPermissionGrants: [] });
  const directReady = h.spawns.at(-1).process.frames.find((frame) => frame.method === 'thread/inject_items');
  assert.match(directReady.params.items[0].content[0].text, /You are in 에이전트 mode/);
  assert.equal(h.spawns.at(-1).process.frames.some((frame) => frame.method === 'turn/start'), false);
  const direct = await turn(h, 'Apply a document edit in agent mode');
  assert.equal(direct.collaborationMode.mode, 'default');
  assert.equal(direct.sandboxPolicy.type, 'workspaceWrite');
  await h.session.setPermissionProfile('unrestricted');
  const fullReady = h.spawns.at(-1).process.frames.find((frame) => frame.method === 'thread/inject_items');
  assert.match(fullReady.params.items[0].content[0].text, /You are in 전체/);
  const full = await turn(h, 'Apply the full access profile');
  assert.equal(full.sandboxPolicy.type, 'dangerFullAccess');
  await h.session.setPermissionProfile('safe');
  const safeReady = h.spawns.at(-1).process.frames.find((frame) => frame.method === 'thread/inject_items');
  assert.match(safeReady.params.items[0].content[0].text, /staged as a live preview/);
  assert.doesNotMatch(safeReady.params.items[0].content[0].text, /You are in 전체/);
});

test('a failed native permission instruction update rolls back before acknowledging the grant', async (t) => {
  const standard = appServerResponder();
  const h = harness(t, {
    workflow: 'question', phase: 'questioning',
    responder(frame, process) {
      if (frame.method === 'thread/inject_items') {
        process.send({ id: frame.id, error: { code: -32601, message: 'Unsupported method' } });
        return;
      }
      standard(frame, process);
    },
  });
  t.after(() => h.session.dispose());
  h.session.sendUserMessage('Ask for permission');
  await settle();
  h.spawns[0].process.send({ method: 'turn/completed', params: { threadId: 'thread-native', turn: { id: 'turn-native', status: 'completed' } } });
  await settle();
  await assert.rejects(
    h.session.setExecutionMode({ workflow: 'question', phase: 'questioning', capabilityEpoch: 2, chatPermissionGrants: ['local-execution'] }),
    /thread\/inject_items support is required/,
  );
  assert.deepEqual(h.opts.chatPermissionGrants, []);
  assert.equal(h.opts.permissionProfile, 'safe');
  assert.equal(h.opts.capabilityEpoch, 1);
  assert.equal(h.spawns[1].process.frames.some((frame) => frame.method === 'turn/start'), false);
  h.session.sendUserMessage('Continue within the existing permission');
  await settle(24);
  const next = h.spawns.at(-1).process.frames.find((frame) => frame.method === 'turn/start');
  assert.equal(next.params.sandboxPolicy.type, 'readOnly');
  assert.equal(next.params.collaborationMode.mode, 'plan');
});

test('approved Plan restarts advertise mutation tools and returning to planning removes them', async (t) => {
  const h = harness(t, { workflow: 'plan', phase: 'planning' });
  t.after(() => h.session.dispose());

  async function advertisedTools() {
    const config = h.spawns.at(-1).argv.find((value) => value.startsWith('mcp_servers.rhwp.env='));
    assert.ok(config);
    const env = Object.fromEntries([...config.matchAll(/([A-Z_]+) = ("(?:\\.|[^"\\])*")/g)]
      .map(([, key, value]) => [key, JSON.parse(value)]));
    assert.equal(env.RHWP_AGENT_PHASE, h.opts.phase);
    assert.equal(env.RHWP_TOOL_PROFILE, undefined, 'chat profile must follow the current phase');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../mcp-stdio.mjs', import.meta.url))],
      env: { ...env, RHWP_SESSION_ID: 'plan-profile-regression' },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'plan-profile-regression', version: '1' });
    try {
      await client.connect(transport);
      return (await client.listTools()).tools.map((tool) => tool.name);
    } finally {
      await client.close();
    }
  }

  async function finishTurn(prompt) {
    h.session.sendUserMessage(prompt);
    await settle(24);
    h.spawns.at(-1).process.send({
      method: 'turn/completed',
      params: { threadId: 'thread-native', turn: { id: 'turn-native', status: 'completed' } },
    });
    await settle();
  }

  await finishTurn('Plan the document edit');
  const planningTools = await advertisedTools();
  assert.ok(planningTools.includes('present_implementation_plan'));
  assert.equal(planningTools.includes('insert_text'), false);

  await h.session.setExecutionMode({ workflow: 'plan', phase: 'implementing', capabilityEpoch: 2 });
  await finishTurn('Implement the approved plan');
  assert.ok(h.spawns.at(-1).process.frames.some((frame) => frame.method === 'thread/resume'));
  const implementationTools = await advertisedTools();
  assert.ok(implementationTools.includes('insert_text'));
  assert.equal(implementationTools.includes('present_implementation_plan'), false);

  await h.session.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 3 });
  const replanningTools = await advertisedTools();
  assert.ok(replanningTools.includes('present_implementation_plan'));
  assert.equal(replanningTools.includes('insert_text'), false);
});

test('setExecutionMode rejects before ACK when native Plan readiness is absent', async (t) => {
  const h = harness(t, {
    responder: appServerResponder({
      collaborationModes: [{ name: 'Default', mode: 'default', model: null, reasoning_effort: null }],
    }),
  });
  h.session.sendUserMessage('First');
  await settle();
  h.spawns[0].process.send({
    method: 'turn/completed',
    params: { threadId: 'thread-native', turn: { id: 'turn-native', status: 'completed' } },
  });
  await settle();
  await assert.rejects(
    h.session.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 2 }),
    /native Plan mode is unavailable/,
  );
  assert.deepEqual(
    [h.opts.workflow, h.opts.phase, h.opts.capabilityEpoch],
    ['direct', 'implementing', 1],
    'a rejected Plan transition rolls provider state back',
  );
  assert.equal(h.spawns.length, 2);
  assert.equal(h.spawns[1].process.frames.some((frame) => frame.method === 'turn/start'), false);
  await h.session.dispose();
});

test('permission and mode changes share one serialized Codex restart barrier', async (t) => {
  const h = harness(t);
  h.session.sendUserMessage('First');
  await settle();
  h.spawns[0].process.send({
    method: 'turn/completed',
    params: { threadId: 'thread-native', turn: { id: 'turn-native', status: 'completed' } },
  });
  await settle();

  const permissionChange = h.session.setPermissionProfile('unrestricted');
  const modeChange = h.session.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 2 });
  await Promise.all([permissionChange, modeChange]);
  assert.equal(h.spawns.length, 2);
  assert.equal(h.spawns[0].process.signalCode, 'SIGTERM');

  h.session.sendUserMessage('Plan after both changes');
  await settle();
  const turn = h.spawns[1].process.frames.find((frame) => frame.method === 'turn/start');
  assert.equal(turn.params.collaborationMode.mode, 'plan');
  assert.equal(turn.params.sandboxPolicy.type, 'readOnly', 'full access remains orthogonal to Plan');
  h.session.interrupt();
  await settle();
  await h.session.dispose();
});

test('a Plan permission change re-proves native Plan before resolving', async (t) => {
  const h = harness(t, { workflow: 'plan', phase: 'planning' });
  h.session.sendUserMessage('First plan turn');
  await settle();
  h.spawns[0].process.send({
    method: 'turn/completed',
    params: { threadId: 'thread-native', turn: { id: 'turn-native', status: 'completed' } },
  });
  await settle();

  await h.session.setPermissionProfile('unrestricted');
  assert.equal(h.spawns.length, 2);
  const readinessMethods = h.spawns[1].process.frames.map((frame) => frame.method);
  assert.ok(readinessMethods.includes('collaborationMode/list'));
  assert.ok(readinessMethods.includes('thread/resume'));
  assert.equal(readinessMethods.includes('turn/start'), false);
  await h.session.dispose();
});

test('an idle Plan readiness app-server is released and the next turn resumes its thread', async (t) => {
  const h = harness(t, { workflow: 'plan', phase: 'planning', idleReleaseMs: 30 });
  h.session.sendUserMessage('First plan turn');
  await settle();
  h.spawns[0].process.send({
    method: 'turn/completed',
    params: { threadId: 'thread-native', turn: { id: 'turn-native', status: 'completed' } },
  });
  await settle();
  await h.session.setPermissionProfile('unrestricted');
  const warm = h.spawns[1].process;
  assert.equal(warm.signalCode, null);
  const eventsBeforeRelease = h.events.length;

  await new Promise((resolve) => setTimeout(resolve, 60));
  await settle();
  assert.equal(warm.signalCode, 'SIGTERM', 'idle readiness process is stopped');
  assert.equal(h.events.length, eventsBeforeRelease, 'release is silent to the hub');
  assert.equal(h.session.getSessionId(), 'thread-native');

  h.session.sendUserMessage('Plan next');
  await settle(24);
  assert.equal(h.spawns.length, 3);
  const methods = h.spawns[2].process.frames.map((frame) => frame.method);
  assert.ok(methods.includes('thread/resume'));
  assert.equal(methods.includes('thread/start'), false);
  const turn = h.spawns[2].process.frames.find((frame) => frame.method === 'turn/start');
  assert.equal(turn.params.threadId, 'thread-native');
  assert.equal(turn.params.collaborationMode.mode, 'plan');
  assert.equal(turn.params.sandboxPolicy.type, 'readOnly');

  await new Promise((resolve) => setTimeout(resolve, 60));
  await settle();
  assert.equal(h.spawns[2].process.signalCode, null, 'an open turn is never released');
  h.session.interrupt();
  await settle();
  await h.session.dispose();
});

test('a message racing an idle release still starts its turn', async (t) => {
  const h = harness(t, {
    workflow: 'plan',
    phase: 'planning',
    idleReleaseMs: 20,
    terminateProcess: (process) => new Promise((resolve) => {
      setTimeout(() => resolve(process.kill('SIGTERM')), 40);
    }),
  });
  await h.session.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 2 });
  assert.equal(h.spawns.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  h.session.sendUserMessage('Arrives during release');
  await new Promise((resolve) => setTimeout(resolve, 80));
  await settle(24);
  assert.equal(h.spawns[0].process.signalCode, 'SIGTERM');
  assert.equal(h.spawns.length, 2);
  const methods = h.spawns[1].process.frames.map((frame) => frame.method);
  assert.ok(methods.includes('thread/start'), 'a readiness thread without turns has no rollout to resume');
  assert.equal(methods.includes('thread/resume'), false);
  const turn = h.spawns[1].process.frames.find((frame) => frame.method === 'turn/start');
  assert.equal(turn?.params.input[0].text, 'Arrives during release');
  assert.equal(h.events.filter((event) => event.type === 'turn-start').length, 1);
  h.session.interrupt();
  await settle();
  await h.session.dispose();
});

test('an active legacy Codex session cannot accept Plan mode', async (t) => {
  const h = harness(t, { responder: appServerResponder({ features: [] }) });
  h.session.sendUserMessage('Use fallback');
  await settle(24);
  const legacy = h.spawns.at(-1);
  assert.equal(legacy.native, false);
  legacy.process.exit(0);
  await settle();
  await assert.rejects(
    h.session.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 2 }),
    /native Plan mode is unavailable while using legacy exec/,
  );
  await h.session.dispose();
});

test('provider loss aborts a blocked native question and expires the turn', async (t) => {
  let receivedSignal;
  const h = harness(t, {
    requestUserInput: (_request, signal) => {
      receivedSignal = signal;
      return new Promise(() => {});
    },
  });
  h.session.sendUserMessage('Ask');
  await settle();
  h.spawns[0].process.send({
    id: 77,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-native', turnId: 'turn-native', itemId: 'item-77',
      questions: [{
        id: 'choice', header: 'Choice', question: 'Choose?', isOther: false, isSecret: false,
        options: [{ label: 'A', description: 'A' }, { label: 'B', description: 'B' }],
      }],
      isBlocking: true,
    },
  });
  await settle();
  assert.equal(receivedSignal.aborted, false);
  h.spawns[0].process.exit(1);
  await settle();
  assert.equal(receivedSignal.aborted, true);
  assert.equal(h.events.filter((event) => event.type === 'turn-end').at(-1).stopReason, 'exited');
  await h.session.dispose();
});

test('native questions from a non-root thread fail closed without reaching the host', async (t) => {
  let calls = 0;
  const h = harness(t, {
    requestUserInput: async () => {
      calls += 1;
      return { status: 'cancelled', reason: 'user-stop' };
    },
  });
  h.session.sendUserMessage('Ask');
  await settle();
  h.spawns[0].process.send({
    id: 'child-question',
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'child-thread', turnId: 'child-turn', itemId: 'child-item',
      questions: [{
        id: 'choice', header: 'Choice', question: 'Choose?', isOther: false, isSecret: false,
        options: [{ label: 'A', description: 'A' }, { label: 'B', description: 'B' }],
      }],
      isBlocking: false,
    },
  });
  await settle();
  assert.equal(calls, 0);
  assert.deepEqual(h.spawns[0].process.frames.at(-1), {
    id: 'child-question',
    error: {
      code: -32602,
      message: 'Codex user questions are restricted to the active root turn',
      data: { code: 'SUBAGENT_USER_INPUT_DENIED' },
    },
  });
  h.session.interrupt();
  await settle();
  await h.session.dispose();
});

test('Stop aborts a blocked question and sends turn/interrupt to Codex', async (t) => {
  let receivedSignal;
  const h = harness(t, {
    requestUserInput: (_request, signal) => {
      receivedSignal = signal;
      return new Promise(() => {});
    },
  });
  h.session.sendUserMessage('Ask');
  await settle();
  h.spawns[0].process.send({
    id: 'stop-question',
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-native', turnId: 'turn-native', itemId: 'stop-item',
      questions: [{
        id: 'choice', header: 'Choice', question: 'Choose?', isOther: false, isSecret: false,
        options: [{ label: 'A', description: 'A' }, { label: 'B', description: 'B' }],
      }],
      isBlocking: false,
    },
  });
  await settle();
  h.session.interrupt();
  await settle();
  assert.equal(receivedSignal.aborted, true);
  assert.ok(h.spawns[0].process.frames.some((frame) => frame.method === 'turn/interrupt'));
  assert.equal(
    h.spawns[0].process.frames.some((frame) => frame.id === 'stop-question' && frame.result),
    false,
    'the stopped generation cannot publish a late successful question response',
  );
  assert.equal(h.events.filter((event) => event.type === 'turn-end').at(-1).stopReason, 'interrupted');
  await h.session.dispose();
});

// 아래 알림 모양은 실제 codex-cli 0.162.0 app-server 캡처(thread/compact/start 턴)를 다듬어 옮겼다.
function tokenUsage(threadId, turnId, lastTotal) {
  const breakdown = (totalTokens) => ({
    totalTokens, inputTokens: totalTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
  });
  return {
    method: 'thread/tokenUsage/updated',
    params: { threadId, turnId, tokenUsage: { total: breakdown(17780), last: breakdown(lastTotal), modelContextWindow: 258400 } },
  };
}

test('manual compaction runs thread/compact/start as a turn and maps contextCompaction items', async (t) => {
  const base = appServerResponder();
  const h = harness(t, {
    responder(frame, process) {
      if (frame.method === 'turn/start') {
        const { threadId } = frame.params;
        process.send({ method: 'turn/started', params: { threadId, turn: { id: 'turn-1', status: 'inProgress' } } });
        process.send({ id: frame.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
        process.send(tokenUsage(threadId, 'turn-1', 17780));
        // 이 응답 도중의 자동 압축은 구식 thread/compacted 로만 알린다.
        process.send({ method: 'thread/compacted', params: { threadId, turnId: 'turn-1' } });
        process.send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed' } } });
        return;
      }
      if (frame.method === 'thread/compact/start') {
        const { threadId } = frame.params;
        process.send({ id: frame.id, result: {} });
        process.send({ method: 'turn/started', params: { threadId, turn: { id: 'turn-compact', status: 'inProgress' } } });
        // 자식 스레드의 압축은 루트 대화의 압축이 아니다.
        process.send({ method: 'item/started', params: { threadId: 'child-thread', turnId: 'turn-compact', item: { type: 'contextCompaction', id: 'child-item' } } });
        process.send({ method: 'item/started', params: { threadId, turnId: 'turn-compact', item: { type: 'contextCompaction', id: 'item-1' } } });
        process.send(tokenUsage(threadId, 'turn-compact', 11504));
        process.send({ method: 'item/completed', params: { threadId, turnId: 'turn-compact', item: { type: 'contextCompaction', id: 'item-1' } } });
        process.send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-compact', status: 'completed' } } });
        return;
      }
      return base(frame, process);
    },
  });
  assert.equal(h.session.compactionSupport, 'manual');
  h.session.sendUserMessage('Remember MANGO-77');
  await settle(24);
  assert.deepEqual(h.events.filter((event) => event.type === 'compaction').map(({ phase, trigger }) => [phase, trigger]), [['completed', 'auto']]);

  h.events.length = 0;
  h.session.compact();
  await settle(32);
  const compactRequest = h.spawns.at(-1).process.frames.find((frame) => frame.method === 'thread/compact/start');
  assert.deepEqual(compactRequest.params, { threadId: 'thread-native' });
  assert.equal(h.spawns.at(-1).process.frames.some((frame) => frame.method === 'turn/start'), false);
  assert.deepEqual(h.events.filter((event) => event.type !== 'session-info').map((event) => event.type), [
    'turn-start', 'compaction', 'context-usage', 'compaction', 'turn-end',
  ]);
  const [started, completed] = h.events.filter((event) => event.type === 'compaction');
  assert.deepEqual(started, {
    type: 'compaction', agent: 'codex', compactionId: 'codex:item-1', phase: 'started', trigger: 'manual', beforeTokens: 17780,
  });
  assert.deepEqual(completed, { ...started, phase: 'completed', afterTokens: 11504 });
  assert.deepEqual(h.events.find((event) => event.type === 'context-usage'), {
    type: 'context-usage', agent: 'codex', usedTokens: 11504, maxTokens: 258400, autoCompact: true,
  });
  assert.equal(h.events.at(-1).stopReason, 'completed');
  assert.equal(await h.session.dispose(), true);
});

test('a resume cursor whose rollout is gone starts a new thread with the full-history fallback', async (t) => {
  const base = appServerResponder();
  const h = harness(t, {
    extraOpts: { resumeSessionId: 'thread-gone' },
    responder(frame, process) {
      if (frame.method === 'thread/resume') {
        process.send({ id: frame.id, error: { code: -32600, message: 'no rollout found for thread id thread-gone' } });
        return;
      }
      if (frame.method === 'turn/start') {
        const { threadId } = frame.params;
        process.send({ method: 'turn/started', params: { threadId, turn: { id: 'turn-1', status: 'inProgress' } } });
        process.send({ id: frame.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
        process.send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed' } } });
        return;
      }
      return base(frame, process);
    },
  });
  assert.equal(h.session.getSessionId(), 'thread-gone');
  h.session.sendUserMessage('delta only', { resumeFallbackText: 'full transcript' });
  await settle(32);
  const frames = h.spawns.at(-1).process.frames;
  assert.deepEqual(frames.filter((frame) => frame.method?.startsWith('thread/')).map((frame) => frame.method), ['thread/resume', 'thread/start']);
  const turn = frames.find((frame) => frame.method === 'turn/start');
  assert.equal(turn.params.threadId, 'thread-native');
  assert.deepEqual(turn.params.input, [{ type: 'text', text: 'full transcript' }]);
  const turnEnd = h.events.find((event) => event.type === 'turn-end');
  assert.equal(turnEnd.stopReason, 'completed');
  assert.equal(turnEnd.resumeLost, true);
  assert.equal(h.session.getSessionId(), 'thread-native');
  assert.equal(await h.session.dispose(), true);
});

// 0.162 generate-ts: thread/inject_items {threadId, items: ResponseItem[]} → {}.
const HANDOFF = Object.freeze({
  header: 'Context handoff: 2 of 2 earlier chat entries included (0 omitted). Sources: Claude.\nHistorical entries are context, not a new request.',
  entries: [
    { role: 'user', text: '[user · Claude]\nThe project codename is PLUM-314.' },
    { role: 'assistant', text: '[assistant · Claude]\nNoted.' },
  ],
  plainText: 'What is the codename?',
});
const INLINE = '<chat_history>PLUM-314</chat_history>\n\nWhat is the codename?';

function completingResponder({ inject } = {}) {
  const base = appServerResponder();
  let turn = 0;
  return (frame, process) => {
    if (frame.method === 'thread/inject_items' && inject) return inject(frame, process);
    if (frame.method === 'turn/start') {
      const { threadId } = frame.params;
      const id = `turn-${++turn}`;
      process.send({ method: 'turn/started', params: { threadId, turn: { id, status: 'inProgress' } } });
      process.send({ id: frame.id, result: { turn: { id, status: 'inProgress' } } });
      process.send({ method: 'turn/completed', params: { threadId, turn: { id, status: 'completed' } } });
      return;
    }
    return base(frame, process);
  };
}

function sentFrames(h, method) {
  return h.spawns.flatMap((spawn) => spawn.process.frames).filter((frame) => frame.method === method);
}

test('Codex receives handoff history as native items and the turn carries only the request', async (t) => {
  const h = harness(t, { responder: completingResponder() });
  h.session.sendUserMessage(INLINE, { handoff: HANDOFF });
  await settle(32);
  const [inject] = sentFrames(h, 'thread/inject_items');
  assert.equal(inject.params.threadId, 'thread-native');
  assert.deepEqual(inject.params.items, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: HANDOFF.header }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: HANDOFF.entries[0].text }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: HANDOFF.entries[1].text }] },
  ]);
  const [turn] = sentFrames(h, 'turn/start');
  assert.deepEqual(turn.params.input, [{ type: 'text', text: 'What is the codename?' }]);
  const frames = h.spawns[0].process.frames.map((frame) => frame.method);
  assert.ok(frames.indexOf('thread/inject_items') < frames.indexOf('turn/start'));
  const end = h.events.find((event) => event.type === 'turn-end');
  assert.equal(end.stopReason, 'completed');
  assert.equal(end.handoffUncertain, undefined);
  assert.equal(await h.session.dispose(), true);
});

for (const [name, error] of [
  ['JSON-RPC method not found', { code: -32601, message: 'Method not found' }],
  // codex 0.162 앱 서버가 모르는 메서드에 실제로 내는 응답.
  ['unknown request variant', { code: -32600, message: 'Invalid request: unknown variant `thread/inject_items`, expected one of `initialize`, `thread/start`' }],
]) test(`an app-server without thread/inject_items (${name}) gets the inline history and is not asked again`, async (t) => {
  const h = harness(t, {
    responder: completingResponder({
      inject: (frame, process) => process.send({ id: frame.id, error }),
    }),
  });
  h.session.sendUserMessage(INLINE, { handoff: HANDOFF });
  await settle(32);
  assert.deepEqual(sentFrames(h, 'turn/start')[0].params.input, [{ type: 'text', text: INLINE }]);
  assert.equal(h.events.find((event) => event.type === 'turn-end').stopReason, 'completed');

  h.session.sendUserMessage(INLINE, { handoff: HANDOFF });
  await settle(32);
  assert.equal(sentFrames(h, 'thread/inject_items').length, 1);
  assert.deepEqual(sentFrames(h, 'turn/start')[1].params.input, [{ type: 'text', text: INLINE }]);
  assert.equal(await h.session.dispose(), true);
});

test('an ambiguous inject failure fails the turn without sending it and marks the handoff uncertain', async (t) => {
  const h = harness(t, {
    responder: completingResponder({
      inject: (frame, process) => process.send({ id: frame.id, error: { code: -32603, message: 'history write failed' } }),
    }),
  });
  h.session.sendUserMessage(INLINE, { handoff: HANDOFF });
  await settle(32);
  assert.equal(sentFrames(h, 'turn/start').length, 0);
  assert.equal(h.events.some((event) => event.type === 'turn-start'), false);
  const end = h.events.find((event) => event.type === 'turn-end');
  assert.equal(end.stopReason, 'failed');
  assert.equal(end.handoffUncertain, true);
  assert.match(end.errorMessage, /history write failed/);

  // 허브의 교체 턴은 새 스레드에 인라인으로 간다 — 같은 주입 오류로 다시 막히지 않는다.
  h.events.length = 0;
  h.session.sendUserMessage(INLINE, { handoff: HANDOFF, replaceSession: true });
  await settle(32);
  assert.equal(sentFrames(h, 'thread/inject_items').length, 1);
  assert.deepEqual(sentFrames(h, 'turn/start')[0].params.input, [{ type: 'text', text: INLINE }]);
  const replaced = h.events.find((event) => event.type === 'turn-end');
  assert.equal(replaced.stopReason, 'completed');
  assert.equal(replaced.resumeLost, true);
  assert.equal(replaced.handoffUncertain, undefined);
  assert.equal(await h.session.dispose(), true);
});

test('replaceSession abandons the resumed thread and delivers the full history to a new one', async (t) => {
  const h = harness(t, { extraOpts: { resumeSessionId: 'thread-old' }, responder: completingResponder() });
  h.session.sendUserMessage(INLINE, { handoff: HANDOFF, replaceSession: true });
  await settle(32);
  const frames = h.spawns[0].process.frames.map((frame) => frame.method).filter((method) => method?.startsWith('thread/'));
  assert.deepEqual(frames, ['thread/start', 'thread/inject_items']);
  assert.equal(sentFrames(h, 'thread/inject_items')[0].params.threadId, 'thread-native');
  assert.deepEqual(sentFrames(h, 'turn/start')[0].params.input, [{ type: 'text', text: HANDOFF.plainText }]);
  const end = h.events.find((event) => event.type === 'turn-end');
  assert.equal(end.resumeLost, true);
  assert.equal(h.session.getSessionId(), 'thread-native');
  assert.equal(await h.session.dispose(), true);
});

test('a lost resume injects the full-history handoff instead of the delta', async (t) => {
  const base = completingResponder();
  const h = harness(t, {
    extraOpts: { resumeSessionId: 'thread-gone' },
    responder(frame, process) {
      if (frame.method === 'thread/resume') {
        process.send({ id: frame.id, error: { code: -32600, message: 'no rollout found for thread id thread-gone' } });
        return;
      }
      return base(frame, process);
    },
  });
  const delta = { ...HANDOFF, entries: [HANDOFF.entries[1]] };
  h.session.sendUserMessage('delta prompt', {
    handoff: delta, resumeFallbackText: INLINE, resumeFallbackHandoff: HANDOFF,
  });
  await settle(32);
  assert.deepEqual(sentFrames(h, 'thread/inject_items')[0].params.items.length, 3);
  assert.deepEqual(sentFrames(h, 'turn/start')[0].params.input, [{ type: 'text', text: HANDOFF.plainText }]);
  assert.equal(h.events.find((event) => event.type === 'turn-end').resumeLost, true);
  assert.equal(await h.session.dispose(), true);
});
