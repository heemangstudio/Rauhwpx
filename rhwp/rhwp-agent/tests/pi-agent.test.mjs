import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';

import {
  buildPiArgv,
  buildPiEnv,
  createPiFleetMapper,
  createPiSession,
  formatOpenRouterCreditError,
  formatPiExitError,
  isOpenRouterCreditError,
} from '../agents/pi.mjs';
import { RHWP_TOOL_RULES } from '../tool-rules.mjs';

const baseOpts = {
  rootDir: '/tmp/rhwp',
  mcpScriptPath: '/tmp/mcp-stdio.mjs',
  hubPort: 6201,
  token: 'secret-token',
  isolatedHome: '/tmp/rhwp isolated home',
  sessionId: 'studio-thread-pi',
  piBin: '/pi/prefix/node_modules/.bin/pi',
  piRoot: '/pi',
  model: 'deepseek/deepseek-chat-v3.1',
  effort: 'high',
  reasoning: true,
  permissionProfile: 'safe',
  onEvent() {},
};

class FakeStream extends EventEmitter {
  chunks = [];
  ended = false;

  end(chunk) {
    if (chunk !== undefined) this.chunks.push(String(chunk));
    this.ended = true;
  }
}

class FakeProcess extends EventEmitter {
  stdin = new FakeStream();
  stdout = new FakeStream();
  stderr = new FakeStream();
  exitCode = null;
  signalCode = null;
  signals = [];

  kill(signal) {
    this.signals.push(signal);
    queueMicrotask(() => {
      if (this.signalCode !== null || this.exitCode !== null) return;
      this.signalCode = signal;
      this.emit('exit', null, signal);
    });
    return true;
  }

  /** NDJSON 한 줄씩 흘려보낸다. */
  emitJson(...events) {
    this.stdout.emit('data', events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  }

  exit(code) {
    this.exitOnly(code);
    this.close(code);
  }

  exitOnly(code) {
    this.exitCode = code;
    this.emit('exit', code, null);
  }

  close(code) {
    this.emit('close', code ?? this.exitCode, null);
  }
}

/** 세션을 만들고 스폰 기록/이벤트 배열을 함께 돌려준다. */
function startSession(extra = {}, dependencies = {}) {
  const events = [];
  const spawns = [];
  const opts = { ...baseOpts, ...extra, onEvent: (event) => events.push(event) };
  const session = createPiSession(opts, {
    ...dependencies,
    spawnProcess(command, argv, options) {
      const proc = new FakeProcess();
      spawns.push({ command, argv, options, proc });
      return proc;
    },
  });
  return { session, events, spawns, opts };
}

function types(events) {
  return events.map((event) => event.type);
}

// 아래 NDJSON 리터럴은 실제 pi 0.84 json 모드 출력(프로브 캡처)에서 다듬어 옮겼다.
const SESSION_LINE = {
  type: 'session', version: 3, id: '019ffe74-43ec-7b98-9c93-bf9bd338ec62',
  timestamp: '2026-08-14T04:07:40.268Z', cwd: '/tmp/rhwp',
};

const TOOL_USAGE = {
  input: 111, output: 45, cacheRead: 12, cacheWrite: 0, reasoning: 7, totalTokens: 168,
  cost: { input: 0.000111, output: 0.00009, cacheRead: 0.0000012, cacheWrite: 0, total: 0.0002022 },
};

test('a tool-call turn maps to the unified event sequence and settles', () => {
  const { session, events, spawns } = startSession();
  session.sendUserMessage('probe the document');
  const { proc } = spawns[0];

  proc.emitJson(
    SESSION_LINE,
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'probe' }] } },
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'probe' }] } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Calling the tool. ' },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: '{"messa' },
    },
    {
      type: 'message_end',
      message: {
        role: 'assistant', model: 'mock-1', usage: TOOL_USAGE, stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'call_probe_1', name: 'get_structure', arguments: {} }],
      },
    },
    {
      type: 'tool_execution_start',
      toolCallId: 'call_probe_1', toolName: 'get_structure', args: { sectionIdx: 0 },
    },
    {
      type: 'tool_execution_end',
      toolCallId: 'call_probe_1', toolName: 'get_structure', isError: false,
      result: { content: [{ type: 'text', text: '{"revision":7}' }], details: { revision: 7 } },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '문단 3개를' },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' 확인했습니다.' },
    },
    {
      type: 'message_end',
      message: {
        role: 'assistant', model: 'mock-1', usage: TOOL_USAGE, stopReason: 'stop',
        content: [{ type: 'text', text: '문단 3개를 확인했습니다.' }],
      },
    },
    { type: 'agent_end', messages: [], willRetry: false },
    { type: 'agent_settled' },
  );
  assert.equal(events.some((event) => event.type === 'turn-end'), false, '프로세스 종료 전에는 턴이 열려 있다');

  proc.exit(0);
  assert.deepEqual(types(events), [
    'turn-start', 'session-info', 'text-delta', 'usage',
    'tool-call', 'tool-result', 'text-delta', 'text-delta', 'usage', 'turn-end',
  ]);

  const sessionInfo = events[1];
  assert.equal(sessionInfo.sessionId, SESSION_LINE.id);
  assert.equal(sessionInfo.model, baseOpts.model);
  assert.equal(session.getSessionId(), SESSION_LINE.id);

  const call = events.find((event) => event.type === 'tool-call');
  assert.deepEqual(
    { tool: call.tool, callId: call.callId, argsJson: call.argsJson },
    { tool: 'get_structure', callId: 'call_probe_1', argsJson: '{"sectionIdx":0}' },
  );
  const result = events.find((event) => event.type === 'tool-result');
  assert.equal(result.ok, true);
  assert.match(result.resultPreview, /revision\\":7/);

  assert.deepEqual(events.find((event) => event.type === 'usage'), {
    type: 'usage',
    agent: 'pi',
    model: baseOpts.model,
    usage: { inputTokens: 111, outputTokens: 45, cacheReadTokens: 12, cacheCreationTokens: 0 },
    costUsd: 0.0002022,
  });
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'pi', stopReason: 'completed' });
  session.dispose();
});

test('thinking deltas stay out of the transcript', () => {
  const { session, events, spawns } = startSession();
  session.sendUserMessage('explain');
  const { proc } = spawns[0];

  proc.emitJson(
    SESSION_LINE,
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Let me think. ' },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: '답은 42입니다.' },
    },
    { type: 'agent_settled' },
  );
  proc.exit(0);

  assert.deepEqual(
    events.filter((event) => event.type === 'text-delta').map((event) => event.text),
    ['답은 42입니다.'],
  );
  session.dispose();
});

test('a 401 turn exits 0 but ends as failed with the API message', () => {
  const { session, events, spawns } = startSession();
  session.sendUserMessage('say hi');
  const { proc } = spawns[0];

  const errorMessage = '401: {"message":"Incorrect API key provided: test.","code":"invalid_api_key"}';
  const zeroUsage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  proc.emitJson(
    SESSION_LINE,
    { type: 'agent_start' },
    { type: 'turn_start' },
    {
      type: 'message_end',
      message: {
        role: 'assistant', content: [], model: 'mock-1', usage: zeroUsage,
        stopReason: 'error', errorMessage,
      },
    },
    { type: 'agent_end', messages: [], willRetry: false },
    { type: 'agent_settled' },
  );
  proc.exit(0);

  // 토큰도 비용도 0 인 턴은 사용량으로 기록하지 않는다.
  assert.deepEqual(events.filter((event) => event.type === 'usage'), []);
  assert.deepEqual(events.find((event) => event.type === 'error'), {
    type: 'error', agent: 'pi', message: errorMessage,
  });
  assert.deepEqual(events.at(-1), {
    type: 'turn-end', agent: 'pi', stopReason: 'failed', errorMessage,
  });
  session.dispose();
});

test('a startup failure reports the stderr reason without the session token', () => {
  const { session, events, spawns } = startSession();
  session.sendUserMessage('go');
  const { proc } = spawns[0];

  proc.stderr.emit(
    'data',
    'Error: Model "nope/nope" not found. Use --list-models to see available models.\n'
      + 'token=secret-token\nUsage: pi [options]\n',
  );
  proc.exit(1);

  const error = events.find((event) => event.type === 'error');
  assert.match(error.message, /Pi 실행이 중단되었습니다 \(code 1\)/);
  assert.match(error.message, /Model "nope\/nope" not found/);
  assert.doesNotMatch(error.message, /secret-token/);
  assert.doesNotMatch(error.message, /^Usage:/m);
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'pi', stopReason: 'exited' });
  session.dispose();
});

test('formatPiExitError redacts key-shaped strings and falls back without stderr', () => {
  assert.match(
    formatPiExitError('401 sk-or-v1-0123456789abcdef bad key', 1, null, ''),
    /\[redacted\] bad key/,
  );
  assert.equal(
    formatPiExitError('', null, 'SIGKILL', 'tok'),
    'Pi 실행이 중단되었습니다 (signal SIGKILL). Pi가 오류 설명을 제공하지 않았습니다.',
  );
});

test('OpenRouter 402 blocks a Pi turn with the empty-credit copy', () => {
  assert.equal(isOpenRouterCreditError('OpenRouter 402 Payment Required'), true);
  assert.equal(
    formatOpenRouterCreditError('HTTP 402: insufficient credits'),
    'OpenRouter 크레딧이 부족합니다.',
  );
  assert.match(
    formatPiExitError('402 Payment Required: out of credits', 1, null, ''),
    /OpenRouter 크레딧이 부족합니다/,
  );
});

test('interrupt kills the child and closes the turn once', () => {
  const { session, events, spawns } = startSession();
  session.sendUserMessage('long task');
  const { proc } = spawns[0];
  proc.emitJson(SESSION_LINE, {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'thinking slowly' },
  });

  session.interrupt();
  assert.deepEqual(proc.signals, ['SIGTERM']);
  const ends = events.filter((event) => event.type === 'turn-end');
  assert.deepEqual(ends, [{ type: 'turn-end', agent: 'pi', stopReason: 'interrupted' }]);

  // 뒤늦게 도착한 종료 이벤트가 턴을 다시 닫지 않는다.
  proc.exit(0);
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 1);
  session.dispose();
});

test('interrupt discards an unterminated Pi terminal frame', async () => {
  const { session, events, spawns } = startSession({}, {
    terminateProcess: async () => true,
    waitForExit: async () => true,
  });
  session.sendUserMessage('interrupt before the terminal frame is drained');
  const { proc } = spawns[0];
  proc.stdout.emit('data', JSON.stringify({ type: 'agent_settled' }));

  session.interrupt();
  proc.exit(0);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    events.filter((event) => event.type === 'turn-end'),
    [{ type: 'turn-end', agent: 'pi', stopReason: 'interrupted' }],
  );
  assert.equal(await session.dispose(), true);
});

test('exit grace without close discards an unterminated Pi terminal frame', async () => {
  const { session, events, spawns } = startSession({}, {
    closeGraceMs: 5,
    terminateProcess: async () => null,
    waitForExit: async () => true,
  });
  session.sendUserMessage('leader exits while a descendant retains stdout');
  const { proc } = spawns[0];
  proc.stdout.emit('data', JSON.stringify({ type: 'agent_settled' }));
  proc.exitOnly(0);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'pi', stopReason: 'exited' });
  assert.equal(await session.dispose(), false);
});

test('exit grace without close rejects a newline-terminated Pi terminal frame', async () => {
  const { session, events, spawns } = startSession({}, {
    closeGraceMs: 5,
    terminateProcess: async () => null,
    waitForExit: async () => true,
  });
  session.sendUserMessage('terminal frame arrives but stdout never closes');
  const { proc } = spawns[0];
  proc.emitJson({ type: 'agent_settled' });
  proc.exitOnly(0);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(
    events.some((event) => event.type === 'turn-end' && event.stopReason === 'completed'),
    false,
  );
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'pi', stopReason: 'exited' });
  assert.equal(await session.dispose(), false);
});

test('argv carries the model, thinking level, session and system brief', () => {
  const argv = buildPiArgv({ ...baseOpts, workflow: 'direct', phase: 'implementing' }, 'sess-1');
  assert.deepEqual(argv.slice(0, 6), [
    '--mode', 'json', '--model', 'openrouter/deepseek/deepseek-chat-v3.1', '--thinking', 'high',
  ]);
  assert.equal(argv[argv.indexOf('--session-dir') + 1], path.join('/pi', 'sessions'));
  assert.equal(argv[argv.indexOf('--session-id') + 1], 'sess-1');
  assert.match(argv[argv.indexOf('--system-prompt') + 1], /rhwp MCP tools/);
  assert.ok(argv.includes('--no-context-files'));
  assert.equal(argv[argv.indexOf('--exclude-tools') + 1], 'bash');
  assert.equal(argv.includes('--append-system-prompt'), false);
  // 사용자 전역 스킬 대신 동기화된 rhwp 스킬만 싣는다.
  assert.ok(argv.includes('--no-skills'));
  assert.equal(argv[argv.indexOf('--skill') + 1], path.join('/pi', 'agent', 'skills'));
});

test('every mode adds the read-only search built-ins without replacing the default set', () => {
  for (const mode of [
    { workflow: 'direct', permissionProfile: 'safe' },
    { workflow: 'direct', permissionProfile: 'unrestricted' },
    { workflow: 'question', phase: 'questioning' },
    { workflow: 'plan', phase: 'planning' },
    { workflow: 'plan', phase: 'implementing' },
    { toolProfile: 'copy-layout-worker' },
  ]) {
    const argv = buildPiArgv({ ...baseOpts, ...mode }, 'sess-1', {});
    // `+이름` 만 쓰는 형식이어야 확장 도구가 살아남는다 (이름만 나열하면 허용 목록이 된다).
    const tools = argv[argv.indexOf('--tools') + 1].split(',');
    assert.ok(tools.every((entry) => entry.startsWith('+')), JSON.stringify(mode));
    assert.deepEqual(tools.filter((entry) => ['+grep', '+find', '+ls'].includes(entry)).length, 3);
    assert.equal(tools.includes('+tool_search'), false);
  }
});

test('the core loadout enables tool_search and reaches the extension through the env', () => {
  const argv = buildPiArgv(baseOpts, 'sess-1', { RHWP_PI_LOADOUT: 'core' });
  assert.ok(argv[argv.indexOf('--tools') + 1].split(',').includes('+tool_search'));
  assert.equal(buildPiEnv(baseOpts, { RHWP_PI_LOADOUT: 'core' }).RHWP_PI_LOADOUT, 'core');
  assert.equal(buildPiEnv(baseOpts, { RHWP_PI_LOADOUT: 'bogus' }).RHWP_PI_LOADOUT, 'full');
  assert.equal(buildPiEnv({ ...baseOpts, piLoadout: 'core' }, {}).RHWP_PI_LOADOUT, 'core');
});

test('the system prompt follows the mode and an explicit override replaces it', () => {
  const promptOf = (opts) => {
    const argv = buildPiArgv({ ...baseOpts, ...opts }, 'sess-1', {});
    return argv[argv.indexOf('--system-prompt') + 1];
  };
  const prompts = [
    promptOf({ workflow: 'question', phase: 'questioning' }),
    promptOf({ workflow: 'plan', phase: 'planning' }),
    promptOf({ workflow: 'direct', permissionProfile: 'safe' }),
    promptOf({ workflow: 'direct', permissionProfile: 'unrestricted' }),
    promptOf({ workflow: 'plan', phase: 'implementing', permissionProfile: 'safe' }),
    promptOf({ workflow: 'plan', phase: 'implementing', permissionProfile: 'unrestricted' }),
  ];
  assert.equal(new Set(prompts).size, prompts.length);
  for (const prompt of prompts) {
    assert.doesNotMatch(prompt, /expert coding assistant/);
    assert.ok(prompt.includes(RHWP_TOOL_RULES));
  }
  assert.equal(promptOf({ systemPromptOverride: 'AUTONOMOUS TEMPLATE WORKER' }), 'AUTONOMOUS TEMPLATE WORKER');
});

test('argv omits thinking for non-reasoning models and never doubles the provider prefix', () => {
  const argv = buildPiArgv(
    { ...baseOpts, reasoning: false, model: 'openrouter/moonshotai/kimi-k2' },
    'sess-1',
  );
  assert.equal(argv[argv.indexOf('--model') + 1], 'openrouter/moonshotai/kimi-k2');
  assert.equal(argv.includes('--thinking'), false);
});

test('pi gets its own subagent fleet instructions', () => {
  for (const mode of [
    { workflow: 'direct', phase: 'implementing' },
    { workflow: 'plan', phase: 'implementing' },
  ]) {
    const argv = buildPiArgv({ ...baseOpts, ...mode }, 'sess-1');
    const brief = argv[argv.indexOf('--system-prompt') + 1];
    assert.doesNotMatch(brief, /Workflow tool/, mode.phase);
    assert.match(brief, /subagent_spawn/, mode.phase);
    assert.match(brief, /role=doc-editor/, mode.phase);
    assert.match(brief, /subagent_wait/, mode.phase);
    assert.match(brief, /ONE apply_edits call/, mode.phase);
  }
});

test('planning phases exclude the built-in write and shell tools', () => {
  for (const phase of ['planning', 'awaiting-approval', 'switching']) {
    const argv = buildPiArgv({ ...baseOpts, workflow: 'plan', phase }, 'sess-1');
    assert.equal(argv[argv.indexOf('--exclude-tools') + 1], 'bash,edit,write', phase);
    assert.match(argv[argv.indexOf('--system-prompt') + 1], /플랜 \(plan\) mode|implementation mode/);
  }
  const implementing = buildPiArgv({ ...baseOpts, workflow: 'plan', phase: 'implementing' }, 'x');
  assert.equal(implementing[implementing.indexOf('--exclude-tools') + 1], 'bash');
  assert.match(implementing[implementing.indexOf('--system-prompt') + 1], /implementation mode/);

  const unrestricted = buildPiArgv({
    ...baseOpts,
    workflow: 'plan',
    phase: 'implementing',
    permissionProfile: 'unrestricted',
  }, 'x');
  assert.equal(unrestricted.includes('--exclude-tools'), false);
});

test('the child env is built from scratch without ambient provider keys', () => {
  const sourceEnv = {
    PATH: '/usr/bin',
    HOME: '/Users/tester',
    OPENROUTER_API_KEY: 'sk-or-v1-leak',
    ANTHROPIC_API_KEY: 'sk-ant-leak',
    GEMINI_API_KEY: 'leak',
    AWS_SECRET_ACCESS_KEY: 'leak',
  };
  const env = buildPiEnv({ ...baseOpts, workflow: 'plan', phase: 'planning', capabilityEpoch: 4 }, sourceEnv);

  assert.equal(Object.keys(env).some((name) => /API_KEY|SECRET/.test(name)), false);
  assert.deepEqual(env.PATH, '/usr/bin');
  assert.equal(env.PI_CODING_AGENT_DIR, path.join('/pi', 'agent'));
  assert.equal(env.PI_OFFLINE, '1');
  assert.equal(env.HOME, '/tmp/rhwp isolated home');
  assert.equal(env.USERPROFILE, '/tmp/rhwp isolated home');
  assert.equal(env.RHWP_SESSION_ID, 'studio-thread-pi');
  assert.equal(env.RHWP_WS_URL, 'ws://127.0.0.1:6201/mcp');
  assert.equal(env.RHWP_HUB_HTTP, 'http://127.0.0.1:6201');
  assert.equal(env.RHWP_AGENT_NAME, 'pi');
  assert.equal(env.RHWP_AGENT_TOKEN, 'secret-token');
  assert.equal(env.RHWP_ROOT_DIR, '/tmp/rhwp');
  assert.equal(env.RHWP_PERMISSION_PROFILE, 'safe');
  assert.equal(env.RHWP_TOOL_PROFILE, 'planning');
  assert.equal(env.RHWP_AGENT_WORKFLOW, 'plan');
  assert.equal(env.RHWP_AGENT_PHASE, 'planning');
  assert.equal(env.RHWP_CAPABILITY_EPOCH, '4');
  assert.equal(env.RHWP_PI_BIN, baseOpts.piBin);
  assert.equal(env.RHWP_PI_MODEL, baseOpts.model);
  assert.equal(env.RHWP_PI_EFFORT, 'high');
  assert.equal(env.RHWP_PI_REASONING, '1');
  assert.equal(env.RHWP_PI_SESSION_DIR, path.join('/pi', 'sessions'));

  assert.equal(buildPiEnv({ ...baseOpts }, sourceEnv).RHWP_TOOL_PROFILE, 'direct');
  assert.equal(
    buildPiEnv({ ...baseOpts, workflow: 'plan', phase: 'implementing' }, sourceEnv).RHWP_TOOL_PROFILE,
    'implementing',
  );
});

test('the selected vault key is passed only when the Pi session explicitly provides it', () => {
  const env = buildPiEnv({ ...baseOpts, openRouterApiKey: 'sk-or-v1-vault' }, { PATH: '/usr/bin' });
  assert.equal(env.OPENROUTER_API_KEY, 'sk-or-v1-vault');
});

test('the prompt goes through stdin, which is closed right after, never through argv', () => {
  const { session, spawns } = startSession();
  session.sendUserMessage('문서를 정리해 줘');
  const { command, argv, options, proc } = spawns[0];

  assert.equal(command, baseOpts.piBin);
  assert.equal(argv.includes('문서를 정리해 줘'), false);
  assert.deepEqual(proc.stdin.chunks, ['문서를 정리해 줘']);
  assert.equal(proc.stdin.ended, true);
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(options.cwd, baseOpts.rootDir);
  assert.equal(options.detached, process.platform !== 'win32');
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.HOME, baseOpts.isolatedHome);
  assert.equal(options.env.USERPROFILE, baseOpts.isolatedHome);
  assert.equal(options.env.RHWP_SESSION_ID, baseOpts.sessionId);
  session.dispose();
});

test('prompts starting with a dash or @ reach Pi verbatim', () => {
  for (const prompt of ['--help 문단을 지워 줘', '@notes.md 요약해 줘']) {
    const { session, spawns } = startSession();
    session.sendUserMessage(prompt);
    assert.equal(spawns[0].argv.includes(prompt), false);
    assert.deepEqual(spawns[0].proc.stdin.chunks, [prompt]);
    session.dispose();
  }
});

test('a stdin EPIPE from an early Pi exit settles the turn without throwing', () => {
  const { session, events, spawns } = startSession();
  session.sendUserMessage('x'.repeat(200_000));
  const { proc } = spawns[0];
  proc.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  proc.stderr.emit('data', 'No API key found for openrouter\n');
  proc.exit(1);
  const ends = events.filter((event) => event.type === 'turn-end');
  assert.deepEqual(ends.map((event) => event.stopReason), ['exited']);
  session.dispose();
});

test('a mode switch waits for the running child to exit', async () => {
  const { session, opts, spawns } = startSession({}, {
    terminateProcess: async () => true,
    waitForExit: async () => true,
  });
  session.sendUserMessage('go');
  const { proc } = spawns[0];
  proc.emitJson({ type: 'agent_settled' });

  await assert.rejects(
    session.setExecutionMode({ workflow: 'plan', phase: 'planning', capabilityEpoch: 2 }),
    /only change between turns/,
  );
  proc.exit(0);
  await session.setExecutionMode({ workflow: 'plan', phase: 'implementing', capabilityEpoch: 3 });
  assert.deepEqual(
    [opts.workflow, opts.phase, opts.capabilityEpoch],
    ['plan', 'implementing', 3],
  );

  session.sendUserMessage('approved kickoff');
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1].argv[spawns[1].argv.indexOf('--exclude-tools') + 1], 'bash');
  assert.equal(spawns[1].options.env.RHWP_AGENT_PHASE, 'implementing');
  assert.equal(spawns[1].argv[spawns[1].argv.indexOf('--session-id') + 1], session.getSessionId());
  session.dispose();
});

test('natural Pi leader exit retains tree cleanup result for delayed disposal', async () => {
  let finishTermination;
  let finishTreeWait;
  let terminationCalls = 0;
  const termination = new Promise((resolve) => { finishTermination = resolve; });
  const treeWait = new Promise((resolve) => { finishTreeWait = resolve; });
  const { session, spawns } = startSession({}, {
    terminateProcess() {
      terminationCalls += 1;
      return termination;
    },
    waitForExit: () => treeWait,
  });
  session.sendUserMessage('finish while a descendant owns stdout');
  const { proc } = spawns[0];
  proc.emitJson({ type: 'agent_settled' });
  proc.exitOnly(0);

  let settled = false;
  const disposed = session.dispose().then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(terminationCalls, 1);
  finishTermination(true);
  finishTreeWait(false);
  assert.equal(await disposed, false);
  assert.equal(await session.dispose(), false);
});

test('a follow-up waits for prior tree cleanup before spawning', async () => {
  let finishTermination;
  let finishTreeWait;
  const termination = new Promise((resolve) => { finishTermination = resolve; });
  const treeWait = new Promise((resolve) => { finishTreeWait = resolve; });
  const { session, events, spawns } = startSession({}, {
    terminateProcess: () => termination,
    waitForExit: () => treeWait,
  });

  session.sendUserMessage('first turn');
  spawns[0].proc.emitJson({ type: 'agent_settled' });
  spawns[0].proc.exit(0);
  session.sendUserMessage('follow-up');

  assert.equal(spawns.length, 1, 'the follow-up must not overlap the prior process tree');
  assert.equal(events.filter((event) => event.type === 'turn-start').length, 1);

  finishTermination(true);
  finishTreeWait(true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(spawns.length, 2);
  assert.deepEqual(spawns[1].proc.stdin.chunks, ['follow-up']);
  assert.equal(events.filter((event) => event.type === 'turn-start').length, 2);

  spawns[1].proc.emitJson({ type: 'agent_settled' });
  spawns[1].proc.exit(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event.type === 'turn-end').length, 2);
  assert.equal(await session.dispose(), true);
});

test('an unconfirmed prior cleanup fails the queued Pi turn closed', async () => {
  const { session, events, spawns } = startSession({}, {
    terminateProcess: async () => true,
    waitForExit: async () => false,
  });

  session.sendUserMessage('first turn');
  spawns[0].proc.emitJson({ type: 'agent_settled' });
  spawns[0].proc.exit(0);
  session.sendUserMessage('follow-up');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(spawns.length, 1);
  assert.equal(
    events.filter((event) => event.type === 'turn-start').length,
    1,
    'an unproven process tree must not reopen provider/MCP turn authority',
  );
  assert.match(events.findLast((event) => event.type === 'error').message, /cleanup could not be confirmed/);
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'pi', stopReason: 'exited' });
  assert.equal(await session.dispose(), false);
});

test('a Windows Pi terminal tail without newline drains before unavailable cleanup quarantine', async () => {
  const { session, events, spawns } = startSession({}, {
    platform: 'win32',
    terminateProcess: async () => null,
    waitForExit: async () => true,
  });
  session.sendUserMessage('first');
  spawns[0].proc.stdout.emit('data', JSON.stringify({ type: 'agent_settled' }));
  spawns[0].proc.exit(0);
  await new Promise((resolve) => setImmediate(resolve));

  session.sendUserMessage('must not spawn');
  assert.equal(spawns.length, 1);
  assert.equal(
    events.filter((event) => event.type === 'turn-start').length,
    1,
    'quarantined cleanup must fail before advertising another provider turn',
  );
  assert.match(events.findLast((event) => event.type === 'error').message, /cleanup remains unconfirmed/);
  assert.deepEqual(events.at(-1), { type: 'turn-end', agent: 'pi', stopReason: 'failed' });
  assert.equal(await session.dispose(), false);
});

test('Windows Pi terminal cleanup starts live, drains buffered output, and allows another turn', async () => {
  let cleanupCalls = 0;
  const { session, events, spawns } = startSession({}, {
    platform: 'win32',
    terminateProcess(proc) {
      assert.equal(proc.exitCode, null);
      assert.equal(proc.signalCode, null);
      cleanupCalls += 1;
      return true;
    },
    waitForExit: async () => true,
  });

  session.sendUserMessage('first');
  spawns[0].proc.emitJson(
    { type: 'agent_settled' },
    {
      type: 'message_end',
      message: { role: 'assistant', model: 'buffered-model', usage: TOOL_USAGE, content: [] },
    },
  );
  assert.equal(cleanupCalls, 1);
  assert.equal(events.some((event) => event.type === 'usage' && event.model === baseOpts.model), true);
  spawns[0].proc.exit(0);
  await new Promise((resolve) => setImmediate(resolve));

  session.sendUserMessage('second');
  assert.equal(spawns.length, 2);
  const disposing = session.dispose();
  spawns[1].proc.exit(0);
  assert.equal(await disposing, true);
});

test('Pi fleet events preserve child terminal status and Pi identity', () => {
  const events = [];
  const mapper = createPiFleetMapper((event) => events.push(event));
  for (const [callId, id, name] of [
    ['spawn-ok', 'sa-1', 'Edit'],
    ['spawn-fail', 'sa-2', 'Research'],
  ]) {
    mapper.onToolStart({ toolCallId: callId, toolName: 'subagent_spawn', args: { name } });
    mapper.onToolEnd({
      toolCallId: callId,
      toolName: 'subagent_spawn',
      result: { details: { id } },
    });
  }
  mapper.onToolStart({
    toolCallId: 'wait', toolName: 'subagent_wait', args: { ids: ['sa-1', 'sa-2'] },
  });
  mapper.onToolEnd({
    toolCallId: 'wait',
    toolName: 'subagent_wait',
    result: { details: { records: [
      { id: 'sa-1', status: 'completed' },
      { id: 'sa-2', status: 'failed' },
    ] } },
  });
  assert.deepEqual(events.filter((event) => event.type === 'task-end'), [
    { type: 'task-end', agent: 'pi', taskId: 'spawn-ok', status: 'completed' },
    { type: 'task-end', agent: 'pi', taskId: 'spawn-fail', status: 'failed' },
  ]);
});

test('an aborted wait leaves its fleet card running until final cleanup', () => {
  const events = [];
  const mapper = createPiFleetMapper((event) => events.push(event));
  mapper.onToolStart({ toolCallId: 'spawn', toolName: 'subagent_spawn', args: { name: 'Research' } });
  mapper.onToolEnd({
    toolCallId: 'spawn', toolName: 'subagent_spawn', result: { details: { id: 'sa-1' } },
  });
  mapper.onToolStart({ toolCallId: 'wait', toolName: 'subagent_wait', args: { ids: ['sa-1'] } });
  mapper.onToolEnd({
    toolCallId: 'wait', toolName: 'subagent_wait', isError: true,
    result: { content: [{ type: 'text', text: 'Wait aborted. Subagents keep running.' }] },
  });
  assert.equal(events.some((event) => event.type === 'task-end'), false);
  mapper.finalize('stopped');
  assert.equal(events.at(-1).status, 'stopped');
});

test('Pi fleet metadata is bounded before it reaches Studio', () => {
  const events = [];
  const mapper = createPiFleetMapper((event) => events.push(event));
  mapper.onToolStart({
    toolCallId: 'spawn',
    toolName: 'subagent_spawn',
    args: { name: 'n'.repeat(5_000), role: 'r'.repeat(5_000) },
  });
  assert.equal(events[0].title.length, 160);
  assert.equal(events[0].role.length, 64);
});

test('a failed Pi cancellation marks the affected fleet card failed', () => {
  const events = [];
  const mapper = createPiFleetMapper((event) => events.push(event));
  mapper.onToolStart({ toolCallId: 'spawn', toolName: 'subagent_spawn', args: { name: 'Edit' } });
  mapper.onToolEnd({
    toolCallId: 'spawn', toolName: 'subagent_spawn', result: { details: { id: 'sa-1' } },
  });
  mapper.onToolStart({ toolCallId: 'cancel', toolName: 'subagent_cancel', args: { ids: ['sa-1'] } });
  mapper.onToolEnd({ toolCallId: 'cancel', toolName: 'subagent_cancel', isError: true, result: {} });
  assert.equal(events.at(-1).status, 'failed');
});
