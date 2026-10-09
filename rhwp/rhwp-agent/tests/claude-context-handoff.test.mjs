// Claude 네이티브 재개·맥락 압축·맥락 사용량. 프레임은 실제 CLI 2.1.295 stream-json 캡처
// (/compact 턴, 없는 세션 --resume) 를 다듬어 옮겼다.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canResumeClaudeSession, createClaudeSession } from '../agents/claude.mjs';

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
    });
    return true;
  }

  emitJson(...events) {
    this.stdout.emit('data', events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  }

  prompt() {
    return this.stdin.chunks.map((line) => JSON.parse(line).message.content[0].text);
  }
}

function startSession(extra = {}) {
  const events = [];
  const children = [];
  const session = createClaudeSession({
    rootDir: '/tmp/rhwp',
    isolatedHome: '/tmp/rhwp-home',
    mcpScriptPath: '/tmp/mcp-stdio.mjs',
    hubPort: 5175,
    token: 'token',
    model: 'claude-haiku-5-5',
    onEvent: (event) => events.push(event),
    ...extra,
  }, {
    spawnProcess(_command, argv) {
      const child = new FakeProcess(argv);
      children.push(child);
      return child;
    },
    terminateProcess(proc) { proc.kill('SIGTERM'); },
  });
  return { session, events, children };
}

async function waitUntil(predicate, message = 'condition did not settle') {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

const SID = 'ed1bc6b8-dd8c-42d8-8b62-61d1b6509333';
const MODEL_USAGE = {
  'claude-haiku-5-5': {
    inputTokens: 1191, outputTokens: 54, cacheReadInputTokens: 3148, cacheCreationInputTokens: 3765,
    costUSD: 0.0009, contextWindow: 1_000_000, maxOutputTokens: 128_000,
  },
};

test('a resumed session compacts on request and maps the CLI compaction frames', async () => {
  const { session, events, children } = startSession({ resumeSessionId: SID });
  assert.equal(session.getSessionId(), SID);
  assert.equal(session.compactionSupport, 'manual');

  // 보통 턴: 첫 스폰부터 --resume, 슬래시 명령은 꺼져 있다. 루트 호출의 사용량이 맥락 크기다.
  session.sendUserMessage('hello');
  await waitUntil(() => children.length === 1);
  const first = children[0];
  assert.equal(first.argv[first.argv.indexOf('--resume') + 1], SID);
  assert.ok(first.argv.includes('--disable-slash-commands'));
  first.emitJson(
    { type: 'system', subtype: 'init', session_id: SID, model: 'claude-haiku-5-5' },
    {
      type: 'assistant', parent_tool_use_id: null,
      message: { id: 'm1', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 2, cache_creation_input_tokens: 3765, cache_read_input_tokens: 3148, output_tokens: 4 } },
    },
    {
      // 서브에이전트 호출의 사용량은 루트 맥락이 아니다.
      type: 'assistant', parent_tool_use_id: 'toolu-sub',
      message: { id: 'm2', content: [], usage: { input_tokens: 90_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    },
    { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'OK', modelUsage: MODEL_USAGE },
  );
  await waitUntil(() => events.some((event) => event.type === 'turn-end'));
  assert.deepEqual(events.filter((event) => event.type === 'context-usage').at(-1), {
    type: 'context-usage', agent: 'claude', usedTokens: 6915, maxTokens: 1_000_000, autoCompact: true,
  });

  // 수동 압축: 슬래시 명령을 켠 스폰에 "/compact" 만 보낸다.
  events.length = 0;
  session.compact();
  await waitUntil(() => children.length === 2);
  const compact = children[1];
  assert.equal(compact.argv.includes('--disable-slash-commands'), false);
  assert.equal(compact.argv[compact.argv.indexOf('--resume') + 1], SID);
  assert.deepEqual(compact.prompt(), ['/compact']);
  compact.emitJson(
    { type: 'system', subtype: 'status', status: 'compacting', session_id: SID, uuid: 'd3072a36' },
    { type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: SID, uuid: '011b5760' },
    { type: 'system', subtype: 'init', session_id: SID, model: 'claude-haiku-5-5' },
    {
      type: 'system', subtype: 'compact_boundary', session_id: SID, uuid: '035439be',
      compact_metadata: { trigger: 'manual', pre_tokens: 7032, post_tokens: 989, duration_ms: 838 },
    },
    { type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' }, isReplay: true },
    { type: 'result', subtype: 'success', is_error: false, stop_reason: null, num_turns: 0, modelUsage: MODEL_USAGE },
  );
  await waitUntil(() => events.some((event) => event.type === 'turn-end'));
  const compactions = events.filter((event) => event.type === 'compaction');
  assert.deepEqual(compactions, [
    { type: 'compaction', agent: 'claude', compactionId: 'claude:d3072a36', phase: 'started', trigger: 'manual', beforeTokens: 6915 },
    {
      type: 'compaction', agent: 'claude', compactionId: 'claude:d3072a36', phase: 'completed', trigger: 'manual',
      beforeTokens: 7032, afterTokens: 989,
    },
  ]);
  // 압축 뒤에는 압축 전 사용량(6915)이 되살아나지 않는다. post_tokens 는 시스템 프롬프트를 빼고
  // 세므로 맥락 크기로 내지 않는다 — 다음 루트 호출이 실제 값을 낸다.
  assert.equal(events.some((event) => event.type === 'context-usage'), false);
  assert.equal(events.at(-1).type, 'turn-end');
  assert.equal(events.at(-1).stopReason, 'success');
  assert.equal(events.some((event) => event.type === 'text-delta'), false);
  await session.dispose();
});

test('a resumed conversation missing from the store retries once on a fresh session with the full transcript', async () => {
  const { session, events, children } = startSession({ resumeSessionId: '11111111-2222-4333-8444-555555555555' });
  session.sendUserMessage('delta only', { resumeFallbackText: 'full transcript' });
  await waitUntil(() => children.length === 1);
  children[0].emitJson({
    type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, stop_reason: null,
    session_id: '11111111-2222-4333-8444-555555555555', modelUsage: {},
    errors: ['No conversation found with session ID: 11111111-2222-4333-8444-555555555555'],
  });
  await waitUntil(() => children.length === 2, 'the turn was not retried');
  const retry = children[1];
  assert.equal(retry.argv.includes('--resume'), false);
  const freshId = retry.argv[retry.argv.indexOf('--session-id') + 1];
  assert.notEqual(freshId, '11111111-2222-4333-8444-555555555555');
  assert.deepEqual(retry.prompt(), ['full transcript']);
  retry.emitJson(
    { type: 'system', subtype: 'init', session_id: freshId, model: 'claude-haiku-5-5' },
    { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'ok', modelUsage: MODEL_USAGE },
  );
  await waitUntil(() => events.some((event) => event.type === 'turn-end'));
  assert.equal(events.filter((event) => event.type === 'turn-start').length, 1);
  const turnEnds = events.filter((event) => event.type === 'turn-end');
  assert.equal(turnEnds.length, 1);
  assert.equal(turnEnds[0].resumeLost, true);
  assert.equal(turnEnds[0].errorMessage, undefined);
  assert.equal(session.getSessionId(), freshId);
  await session.dispose();
});

test('canResume finds the session transcript under the isolated Claude config', async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'rhwp-claude-resume-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const projectDir = path.join(home, '.claude', 'projects', '-private-tmp-rhwp-work');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, `${SID}.jsonl`), '{}\n');
  assert.equal(await canResumeClaudeSession({ isolatedHome: home }, SID), true);
  assert.equal(await canResumeClaudeSession({ isolatedHome: home }, '22222222-2222-4222-8222-222222222222'), false);
  assert.equal(await canResumeClaudeSession({ isolatedHome: home }, '../escape'), false);
});
