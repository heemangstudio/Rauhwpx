// Claude 가 OS 샌드박스 없이는 시작하지 않겠다고 거절한 호스트(Linux 의 bubblewrap·socat 누락 등)에서
// 제한 실행이 앱 MCP 전용 프로필로 이어지는지. 거절 프레임은 실제 CLI 2.1.304 가
// `sandbox.failIfUnavailable` 아래에서 낸 stream-json 출력 그대로다.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  createClaudeSession,
  resetClaudeOsSandboxRefusalForTests,
} from '../agents/claude.mjs';
import { withoutModeBlock } from './mode-block.mjs';

const REFUSAL_TEXT = 'Sandbox required but unavailable: sandbox is enabled but dependencies are missing: bubblewrap (bwrap) not installed, socat not installed · install missing tools (e.g. apt install bubblewrap socat) or run /sandbox for details. Set sandbox.failIfUnavailable=false to allow unsandboxed execution.';

function refusalResult(sessionId) {
  return {
    type: 'result', subtype: 'error_during_execution', duration_ms: 0, duration_api_ms: 0,
    is_error: true, num_turns: 0, stop_reason: null, session_id: sessionId, total_cost_usd: 0,
    modelUsage: {}, permission_denials: [], errors: [REFUSAL_TEXT], result_index: 0,
  };
}

class FakeStream extends EventEmitter {
  chunks = [];

  write(chunk, callback) {
    this.chunks.push(String(chunk));
    callback?.();
    return true;
  }

  end() {}
}

class FakeProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  stdin = new FakeStream();
  exitCode = null;
  signalCode = null;

  constructor(argv) {
    super();
    this.argv = argv;
  }

  kill(signal) {
    queueMicrotask(() => {
      this.signalCode = signal ?? 'SIGTERM';
      this.emit('exit', null, this.signalCode);
      this.emit('close', null, this.signalCode);
    });
    return true;
  }

  emitJson(...events) {
    this.stdout.emit('data', events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  }

  /** 실제 CLI 처럼 거절 result 를 쓰고 stderr 를 남긴 뒤 종료 코드 1 로 끝난다. */
  refuse() {
    this.emitJson(refusalResult(this.sessionId()));
    this.stderr.emit('data', '\nError: sandbox required but unavailable: sandbox is enabled but dependencies are missing\n');
    this.exitCode = 1;
    this.emit('exit', 1, null);
    this.emit('close', 1, null);
  }

  answer(text) {
    const sessionId = this.sessionId();
    this.emitJson(
      { type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-test' },
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text }] } },
      { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: text, session_id: sessionId },
    );
  }

  sessionId() {
    const flag = this.argv.includes('--resume') ? '--resume' : '--session-id';
    return this.argv[this.argv.indexOf(flag) + 1];
  }

  settings() {
    return JSON.parse(this.argv[this.argv.indexOf('--settings') + 1]);
  }

  tools() {
    return this.argv[this.argv.indexOf('--tools') + 1];
  }

  prompts() {
    return this.stdin.chunks.map((line) => withoutModeBlock(JSON.parse(line).message.content[0].text));
  }
}

const baseOpts = {
  rootDir: '/tmp/rhwp',
  isolatedHome: null,
  mcpScriptPath: '/tmp/mcp-stdio.mjs',
  hubPort: 5175,
  token: 'token',
  workflow: 'direct',
  phase: 'implementing',
  permissionProfile: 'safe',
  agentRole: 'chat',
};

function startCliSession(extra = {}, platform = 'linux') {
  const events = [];
  const children = [];
  const session = createClaudeSession({
    ...baseOpts,
    onEvent: (event) => events.push(event),
    ...extra,
  }, {
    platform,
    spawnProcess(_command, argv) {
      const child = new FakeProcess(argv);
      children.push(child);
      return child;
    },
    terminateProcess(proc) { proc.kill('SIGTERM'); },
    waitForExit: () => Promise.resolve(true),
  });
  return { session, events, children };
}

async function waitUntil(predicate, message = 'condition did not settle') {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

const turnEnds = (events) => events.filter((event) => event.type === 'turn-end');

function assertMcpOnly(child) {
  assert.equal(child.tools(), '', 'no native tool is exposed without the OS sandbox');
  assert.deepEqual(child.settings().sandbox, { enabled: false });
  assert.deepEqual(child.settings().permissions.allow, ['mcp__rhwp__*']);
  for (const tool of ['Bash', 'Write', 'Edit', 'Read', 'Agent']) {
    assert.ok(child.argv[child.argv.indexOf('--disallowedTools') + 1].split(',').includes(tool), tool);
  }
}

test('a host whose Claude sandbox cannot start keeps working through app MCP tools', async (t) => {
  resetClaudeOsSandboxRefusalForTests();
  t.after(resetClaudeOsSandboxRefusalForTests);
  const { session, events, children } = startCliSession();

  session.sendUserMessage('표 제목을 굵게 해 줘');
  await waitUntil(() => children.length === 1 && children[0].stdin.chunks.length === 1);
  const refused = children[0];
  assert.equal(refused.settings().sandbox.failIfUnavailable, true, 'safe mode asks for the OS sandbox first');
  refused.refuse();

  await waitUntil(() => children.length === 2 && children[1].stdin.chunks.length === 1, 'the turn is retried');
  const fallback = children[1];
  assertMcpOnly(fallback);
  assert.deepEqual(fallback.prompts(), ['표 제목을 굵게 해 줘'], 'the same message is sent again');
  fallback.answer('굵게 바꿨어요.');

  await waitUntil(() => turnEnds(events).length === 1);
  assert.equal(events.filter((event) => event.type === 'turn-start').length, 1, 'the hub sees one turn');
  assert.equal(events.some((event) => event.type === 'error'), false, 'no sandbox failure reaches Studio');
  assert.equal(turnEnds(events)[0].failure, undefined);
  assert.deepEqual(
    events.filter((event) => event.type === 'text-delta').map((event) => event.text),
    ['굵게 바꿨어요.'],
    'the fallback answer reaches Studio',
  );

  // 다음 턴과 새 세션은 거절을 다시 겪지 않고 처음부터 MCP 전용으로 시작한다.
  session.sendUserMessage('다음 문단도');
  await waitUntil(() => children.length === 3 && children[2].stdin.chunks.length === 1);
  assertMcpOnly(children[2]);
  children[2].answer('네.');
  await waitUntil(() => turnEnds(events).length === 2);
  assert.equal(await session.dispose(), true);

  const next = startCliSession({ workflow: 'plan', phase: 'planning' });
  next.session.sendUserMessage('계획만 세워 줘');
  await waitUntil(() => next.children.length === 1 && next.children[0].stdin.chunks.length === 1);
  assertMcpOnly(next.children[0]);
  next.children[0].answer('계획입니다.');
  await waitUntil(() => turnEnds(next.events).length === 1);
  assert.equal(await next.session.dispose(), true);
});

test('full mode and granted local execution keep native tools after a sandbox refusal', async (t) => {
  resetClaudeOsSandboxRefusalForTests();
  t.after(resetClaudeOsSandboxRefusalForTests);
  const safe = startCliSession();
  safe.session.sendUserMessage('hello');
  await waitUntil(() => safe.children.length === 1 && safe.children[0].stdin.chunks.length === 1);
  safe.children[0].refuse();
  await waitUntil(() => safe.children.length === 2 && safe.children[1].stdin.chunks.length === 1);
  safe.children[1].answer('hi');
  await waitUntil(() => turnEnds(safe.events).length === 1);
  assert.equal(await safe.session.dispose(), true);

  const full = startCliSession({ permissionProfile: 'unrestricted' });
  full.session.sendUserMessage('run the script');
  await waitUntil(() => full.children.length === 1 && full.children[0].stdin.chunks.length === 1);
  assert.match(full.children[0].tools(), /Bash/);
  assert.deepEqual(full.children[0].settings(), {});
  full.children[0].answer('done');
  await waitUntil(() => turnEnds(full.events).length === 1);
  assert.equal(await full.session.dispose(), true);
});

test('a refusal that the MCP-only profile cannot avoid is reported once instead of looping', async (t) => {
  resetClaudeOsSandboxRefusalForTests();
  t.after(resetClaudeOsSandboxRefusalForTests);
  // 관리 정책이 샌드박스를 강제하면 MCP 전용 프로필도 거절된다 — 다시 보내지 않고 실패로 알린다.
  const { session, events, children } = startCliSession();
  session.sendUserMessage('hello');
  await waitUntil(() => children.length === 1 && children[0].stdin.chunks.length === 1);
  children[0].refuse();
  await waitUntil(() => children.length === 2 && children[1].stdin.chunks.length === 1);
  children[1].refuse();
  await waitUntil(() => turnEnds(events).length === 1);
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 2, 'no third spawn');
  const end = turnEnds(events)[0];
  assert.match(end.errorMessage, /Sandbox required but unavailable/);
  assert.equal(end.failure?.source, 'claude');

  // Windows 는 처음부터 MCP 전용이라 같은 거절도 다시 보내지 않는다.
  resetClaudeOsSandboxRefusalForTests();
  const windows = startCliSession({}, 'win32');
  windows.session.sendUserMessage('hello');
  await waitUntil(() => windows.children.length === 1 && windows.children[0].stdin.chunks.length === 1);
  assertMcpOnly(windows.children[0]);
  windows.children[0].refuse();
  await waitUntil(() => turnEnds(windows.events).length === 1);
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(windows.children.length, 1);
  assert.equal(await session.dispose(), true);
  assert.equal(await windows.session.dispose(), true);
});

test('the native user-input transport retries a sandbox refusal with MCP-only SDK options', async (t) => {
  resetClaudeOsSandboxRefusalForTests();
  t.after(resetClaudeOsSandboxRefusalForTests);
  const events = [];
  const optionsByQuery = [];
  const prompts = [];
  let closeCalls = 0;
  const queryAgent = ({ prompt, options }) => {
    optionsByQuery.push(options);
    const refusing = options.settings.sandbox?.enabled === true;
    const query = (async function* () {
      for await (const message of prompt) {
        prompts.push(withoutModeBlock(message.message.content[0].text));
        if (refusing) {
          // The SDK yields the CLI's error result, then rejects the iterator.
          yield refusalResult(options.sessionId ?? options.resume);
          throw new Error(`Claude Code returned an error result: ${REFUSAL_TEXT}`);
        }
        yield { type: 'system', subtype: 'init', session_id: options.sessionId ?? options.resume, model: 'claude-test' };
        yield { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'done' };
      }
    })();
    query.close = () => { closeCalls += 1; };
    return query;
  };
  const session = createClaudeSession({
    ...baseOpts,
    requestUserInput: async () => ({ status: 'cancelled', reason: 'user-stop' }),
    onEvent: (event) => events.push(event),
  }, {
    platform: 'linux',
    queryAgent,
    spawnProcess() { throw new Error('legacy transport should not spawn'); },
  });

  session.sendUserMessage('문서를 요약해 줘');
  await waitUntil(() => turnEnds(events).length === 1);
  assert.equal(optionsByQuery.length, 2);
  assert.equal(optionsByQuery[0].settings.sandbox.failIfUnavailable, true);
  assert.deepEqual(optionsByQuery[1].settings.sandbox, { enabled: false });
  assert.deepEqual(optionsByQuery[1].tools, ['AskUserQuestion']);
  assert.ok(optionsByQuery[1].disallowedTools.includes('Bash'));
  assert.deepEqual(prompts, ['문서를 요약해 줘', '문서를 요약해 줘']);
  assert.equal(events.some((event) => event.type === 'error'), false);
  assert.equal(turnEnds(events)[0].failure, undefined);
  assert.equal(events.filter((event) => event.type === 'turn-start').length, 1);
  assert.ok(closeCalls >= 2);
  assert.equal(await session.dispose(), true);
});

/** 프로세스 정리가 늦게 끝나는 호스트 — 재시도가 정리를 기다리는 동안 사용자가 움직일 틈을 연다. */
function startSlowCleanupSession(extra = {}) {
  const events = [];
  const children = [];
  const releases = [];
  const session = createClaudeSession({
    ...baseOpts,
    onEvent: (event) => events.push(event),
    ...extra,
  }, {
    platform: 'linux',
    spawnProcess(_command, argv) {
      const child = new FakeProcess(argv);
      children.push(child);
      return child;
    },
    terminateProcess(proc) {
      return new Promise((resolve) => releases.push(() => { proc.kill('SIGTERM'); resolve(true); }));
    },
    waitForExit: (proc) => new Promise((resolve) => {
      if (proc.signalCode || proc.exitCode !== null) resolve(true);
      else proc.once('exit', () => resolve(true));
    }),
  });
  const releaseAll = () => { while (releases.length) releases.shift()(); };
  return { session, events, children, releaseAll };
}

async function drain(releaseAll, rounds = 40) {
  for (let i = 0; i < rounds; i++) {
    releaseAll();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('stopping during the sandbox retry and sending again never replays the stopped message', async (t) => {
  resetClaudeOsSandboxRefusalForTests();
  t.after(resetClaudeOsSandboxRefusalForTests);
  const { session, events, children, releaseAll } = startSlowCleanupSession();
  session.sendUserMessage('첫 번째 요청');
  await waitUntil(() => children.length === 1 && children[0].stdin.chunks.length === 1);
  children[0].refuse();
  // 재시도가 이전 프로세스 정리를 기다리는 동안 사용자가 멈추고 곧바로 새 글을 보낸다.
  session.interrupt();
  session.sendUserMessage('두 번째 요청');
  await drain(releaseAll);
  await waitUntil(() => children.length >= 2 && children.at(-1).stdin.chunks.length >= 1, 'the new message is dispatched');
  await drain(releaseAll);
  const prompts = children.slice(1).flatMap((child) => child.prompts());
  assert.deepEqual(prompts, ['두 번째 요청'], 'only the new message reaches Claude');
  assertMcpOnly(children.at(-1));
  children.at(-1).answer('네.');
  await drain(releaseAll);
  await waitUntil(() => turnEnds(events).length === 2);
  assert.equal(turnEnds(events)[0].stopReason, 'interrupted');
  assert.equal(turnEnds(events)[1].failure, undefined);
  const disposed = session.dispose();
  await drain(releaseAll);
  assert.equal(await disposed, true);
});

test('closing the chat while the sandbox retry waits does not spawn Claude again', async (t) => {
  resetClaudeOsSandboxRefusalForTests();
  t.after(resetClaudeOsSandboxRefusalForTests);
  const { session, children, releaseAll } = startSlowCleanupSession();
  session.sendUserMessage('hello');
  await waitUntil(() => children.length === 1 && children[0].stdin.chunks.length === 1);
  children[0].refuse();
  const disposed = session.dispose();
  await drain(releaseAll);
  await disposed;
  await drain(releaseAll);
  assert.equal(children.length, 1);
});

test('a resumed conversation keeps its Claude session through the sandbox retry', async (t) => {
  resetClaudeOsSandboxRefusalForTests();
  t.after(resetClaudeOsSandboxRefusalForTests);
  const SID = 'ed1bc6b8-dd8c-42d8-8b62-61d1b6509333';
  const { session, events, children } = startCliSession({ resumeSessionId: SID });
  session.sendUserMessage('이어서 해 줘');
  await waitUntil(() => children.length === 1 && children[0].stdin.chunks.length === 1);
  assert.equal(children[0].argv[children[0].argv.indexOf('--resume') + 1], SID);
  children[0].refuse();
  await waitUntil(() => children.length === 2 && children[1].stdin.chunks.length === 1);
  assert.equal(children[1].argv[children[1].argv.indexOf('--resume') + 1], SID, 'the same conversation is resumed');
  assert.equal(children[1].argv.includes('--session-id'), false);
  assertMcpOnly(children[1]);
  assert.deepEqual(children[1].prompts(), ['이어서 해 줘']);
  children[1].answer('이어서 했어요.');
  await waitUntil(() => turnEnds(events).length === 1);
  assert.equal(turnEnds(events)[0].resumeLost, undefined, 'the hub keeps the native history');
  assert.equal(session.getSessionId(), SID);
  assert.equal(await session.dispose(), true);
});

test('a manual compaction refused by the sandbox is retried as the same compaction', async (t) => {
  resetClaudeOsSandboxRefusalForTests();
  t.after(resetClaudeOsSandboxRefusalForTests);
  const SID = 'ed1bc6b8-dd8c-42d8-8b62-61d1b6509333';
  const { session, events, children } = startCliSession({ resumeSessionId: SID });
  session.compact({ instructions: '표 작업만 남겨 줘' });
  await waitUntil(() => children.length === 1 && children[0].stdin.chunks.length === 1);
  assert.equal(children[0].argv.includes('--disable-slash-commands'), false);
  children[0].refuse();
  await waitUntil(() => children.length === 2 && children[1].stdin.chunks.length === 1);
  assertMcpOnly(children[1]);
  assert.equal(children[1].argv.includes('--disable-slash-commands'), false, '/compact stays available');
  assert.deepEqual(children[1].stdin.chunks.map((line) => JSON.parse(line).message.content[0].text), ['/compact 표 작업만 남겨 줘']);
  children[1].answer('Compacted.');
  await waitUntil(() => turnEnds(events).length === 1);
  assert.equal(turnEnds(events)[0].failure, undefined);
  assert.equal(await session.dispose(), true);
});

test('stopping the native transport during its sandbox retry never replays the stopped message', async (t) => {
  resetClaudeOsSandboxRefusalForTests();
  t.after(resetClaudeOsSandboxRefusalForTests);
  const events = [];
  const prompts = [];
  const closeReleases = [];
  const queryAgent = ({ prompt, options }) => {
    const refusing = options.settings.sandbox?.enabled === true;
    const query = (async function* () {
      for await (const message of prompt) {
        prompts.push(withoutModeBlock(message.message.content[0].text));
        if (refusing) {
          yield refusalResult(options.sessionId ?? options.resume);
          throw new Error(`Claude Code returned an error result: ${REFUSAL_TEXT}`);
        }
        yield { type: 'system', subtype: 'init', session_id: options.sessionId ?? options.resume, model: 'claude-test' };
        yield { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'done' };
      }
    })();
    // close() 가 늦게 끝난다 — 재시도가 SDK 정리를 기다리는 동안 사용자가 움직인다.
    query.close = () => new Promise((resolve) => closeReleases.push(resolve));
    return query;
  };
  const session = createClaudeSession({
    ...baseOpts,
    requestUserInput: async () => ({ status: 'cancelled', reason: 'user-stop' }),
    onEvent: (event) => events.push(event),
  }, {
    platform: 'linux',
    queryAgent,
    spawnProcess() { throw new Error('legacy transport should not spawn'); },
  });
  const releaseAll = () => { while (closeReleases.length) closeReleases.shift()(); };
  session.sendUserMessage('첫 번째 요청');
  await waitUntil(() => prompts.length === 1 && closeReleases.length === 1, 'the refused query is closing');
  session.interrupt();
  session.sendUserMessage('두 번째 요청');
  await drain(releaseAll, 60);
  await waitUntil(() => turnEnds(events).length === 2, 'the new message completes');
  await drain(releaseAll);
  assert.deepEqual(prompts, ['첫 번째 요청', '두 번째 요청']);
  assert.equal(turnEnds(events)[0].stopReason, 'interrupted');
  assert.equal(turnEnds(events)[1].failure, undefined);
  const disposed = session.dispose();
  await drain(releaseAll);
  await disposed;
});

/** 모델이 Bash 를 한 번 부르고, 그 결과(오류)를 받은 뒤 답하는 턴. 출력은 실제 CLI 2.1.304 의 결과 모양이다. */
function bashTurn(child, output, answer) {
  const sessionId = child.sessionId();
  child.emitJson(
    { type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-test' },
    {
      type: 'assistant', parent_tool_use_id: null,
      message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'cat note.txt' } }] },
    },
    {
      type: 'user', parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', is_error: true, content: output }] },
    },
    { type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'text', text: answer }] } },
    { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: answer, session_id: sessionId },
  );
}

test('a sandbox that starts but cannot run commands moves the next turn to app MCP tools', async (t) => {
  resetClaudeOsSandboxRefusalForTests();
  t.after(resetClaudeOsSandboxRefusalForTests);
  // 다른 Seatbelt 안에서 허브가 돌면 시작 검사는 통과하고 Bash 만 매번 실패한다 (macOS 27 에서 확인).
  const { session, events, children } = startCliSession();
  session.sendUserMessage('메모 파일을 읽어 줘');
  await waitUntil(() => children.length === 1 && children[0].stdin.chunks.length === 1);
  const sandboxed = children[0];
  assert.equal(sandboxed.settings().sandbox.enabled, true);
  bashTurn(sandboxed, 'Exit code 71\nsandbox-exec: sandbox_apply: Operation not permitted', '명령을 실행하지 못했어요.');
  await waitUntil(() => turnEnds(events).length === 1);
  assert.equal(children.length, 1, 'the finished turn is not replayed');
  assert.equal(turnEnds(events)[0].failure, undefined);
  const sessionId = sandboxed.sessionId();

  session.sendUserMessage('그럼 문서만 고쳐 줘');
  await waitUntil(() => children.length === 2 && children[1].stdin.chunks.length === 1, 'the next turn respawns Claude');
  assertMcpOnly(children[1]);
  assert.equal(children[1].argv[children[1].argv.indexOf('--resume') + 1], sessionId, 'the same conversation continues');
  assert.deepEqual(children[1].prompts(), ['그럼 문서만 고쳐 줘']);
  children[1].answer('고쳤어요.');
  await waitUntil(() => turnEnds(events).length === 2);
  assert.equal(await session.dispose(), true);
});

test('a Linux sandbox without user namespaces is detected from its bubblewrap error', async (t) => {
  resetClaudeOsSandboxRefusalForTests();
  t.after(resetClaudeOsSandboxRefusalForTests);
  const { session, events, children } = startCliSession();
  session.sendUserMessage('run it');
  await waitUntil(() => children.length === 1 && children[0].stdin.chunks.length === 1);
  bashTurn(children[0], [{ type: 'text', text: 'Exit code 1\nbwrap: setting up uid map: Permission denied' }], 'failed');
  await waitUntil(() => turnEnds(events).length === 1);
  session.sendUserMessage('again');
  await waitUntil(() => children.length === 2 && children[1].stdin.chunks.length === 1);
  assertMcpOnly(children[1]);
  children[1].answer('ok');
  await waitUntil(() => turnEnds(events).length === 2);
  assert.equal(await session.dispose(), true);
});

test('an ordinary permission error from the user command keeps the sandboxed tools', async (t) => {
  resetClaudeOsSandboxRefusalForTests();
  t.after(resetClaudeOsSandboxRefusalForTests);
  const { session, events, children } = startCliSession();
  session.sendUserMessage('지워 줘');
  await waitUntil(() => children.length === 1 && children[0].stdin.chunks.length === 1);
  // 샌드박스가 쓰기 밖을 막은 것은 정상 동작이다 — 샌드박스를 버릴 이유가 아니다.
  bashTurn(children[0], 'Exit code 1\nrm: /etc/hosts: Operation not permitted', '지울 수 없는 위치예요.');
  await waitUntil(() => turnEnds(events).length === 1);
  session.sendUserMessage('다른 걸 해 줘');
  await waitUntil(() => children.length === 2 && children[1].stdin.chunks.length === 1);
  assert.equal(children[1].settings().sandbox.enabled, true, 'the next turn still runs native tools in the sandbox');
  assert.match(children[1].tools(), /Bash/);
  children[1].answer('네.');
  await waitUntil(() => turnEnds(events).length === 2);
  assert.equal(await session.dispose(), true);
});
