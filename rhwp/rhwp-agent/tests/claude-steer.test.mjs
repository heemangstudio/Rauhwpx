// 지금 보내기(steer): 도는 Claude 턴에 메시지를 끼워 넣어도 프로세스를 내리지 않고, 끼워 넣은 메시지가
// 끝날 때까지 턴을 연다. 이벤트 모양은 실제 CLI(2.1.307) stream-json 캡처를 따른다 — uuid 를 실은 사용자
// 입력은 command_lifecycle(queued → started → completed)을 내고, 도는 루프의 다음 도구 경계에 끼워지거나
// (같은 result) 그 뒤에 따로 돈다(또 하나의 result).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createClaudeSession } from '../agents/claude.mjs';

const baseOpts = {
  rootDir: '/tmp/rhwp',
  isolatedHome: '/tmp/rhwp-home',
  mcpScriptPath: '/tmp/mcp-stdio.mjs',
  hubPort: 5175,
  token: 'token',
  model: 'test-model',
  onEvent() {},
};

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
  kills = 0;

  kill(signal) {
    this.kills += 1;
    queueMicrotask(() => {
      this.signalCode = signal ?? 'SIGTERM';
      this.emit('exit', null, this.signalCode);
    });
    return true;
  }

  emitJson(...events) {
    this.stdout.emit('data', events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  }

  /** stdin 으로 받은 사용자 입력 줄. */
  userLines() {
    return this.stdin.chunks.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }
}

function startSession(events) {
  let child;
  const session = createClaudeSession(
    { ...baseOpts, onEvent: (event) => events.push(event) },
    { spawnProcess() { child = new FakeProcess(); return child; }, terminateProcess(proc) { proc.kill('SIGTERM'); } },
  );
  session.sendUserMessage('go');
  return { session, child: () => child };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const turnEnds = (events) => events.filter((event) => event.type === 'turn-end');
const lifecycle = (uuid, state) => ({ type: 'command_lifecycle', command_uuid: uuid, state, uuid: `${uuid}-${state}` });
const RESULT = { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'done' };

test('a steered message rides the running process and keeps the turn open until it completes', async () => {
  const events = [];
  const { session, child } = startSession(events);
  await tick();

  assert.equal(session.steer('표도 하나 넣어 줘'), true);
  const steered = child().userLines().at(-1);
  assert.equal(steered.message.content[0].text, '표도 하나 넣어 줘');
  assert.equal(typeof steered.uuid, 'string');

  // CLI 가 받았지만 아직 돌지 않았다 — 앞 루프의 result 는 턴의 끝이 아니다.
  child().emitJson(lifecycle(steered.uuid, 'queued'), RESULT);
  await tick();
  assert.equal(turnEnds(events).length, 0, 'the turn must stay open for the steered message');
  assert.equal(child().kills, 0, 'steering must not stop the provider process');

  // 끼워 넣은 메시지가 따로 돌고 제 result 를 낸다.
  child().emitJson(
    lifecycle(steered.uuid, 'started'),
    { type: 'assistant', message: { content: [{ type: 'text', text: '표를 넣었습니다.' }] } },
    lifecycle(steered.uuid, 'completed'),
    RESULT,
  );
  for (let i = 0; i < 20 && turnEnds(events).length === 0; i++) await tick();
  assert.equal(turnEnds(events).length, 1);
  assert.ok(events.some((event) => event.type === 'text-delta' && event.text.includes('표를 넣었습니다.')));
  await session.dispose();
});

test('a steered message folded into the running loop settles with that loop result', async () => {
  const events = [];
  const { session, child } = startSession(events);
  await tick();
  assert.equal(session.steer('끝에 요약도'), true);
  const { uuid } = child().userLines().at(-1);
  // 다음 도구 경계에 끼워져 같은 result 로 끝났다.
  child().emitJson(lifecycle(uuid, 'queued'), lifecycle(uuid, 'started'), lifecycle(uuid, 'completed'), RESULT);
  for (let i = 0; i < 20 && turnEnds(events).length === 0; i++) await tick();
  assert.equal(turnEnds(events).length, 1);
  await session.dispose();
});

test('steering keeps a running background subagent alive', async () => {
  const events = [];
  const { session, child } = startSession(events);
  await tick();
  child().emitJson({
    type: 'system', subtype: 'task_started', task_id: 'task-a', tool_use_id: 'toolu-1',
    description: '2쪽 정리', subagent_type: 'doc-editor', task_type: 'local_agent', prompt: 'p',
  });
  assert.equal(session.steer('2쪽은 건너뛰어'), true);
  const { uuid } = child().userLines().at(-1);
  child().emitJson(lifecycle(uuid, 'queued'), lifecycle(uuid, 'started'), lifecycle(uuid, 'completed'), RESULT);
  await tick();
  assert.equal(turnEnds(events).length, 0, 'the subagent is still running');
  assert.equal(child().kills, 0);
  await session.dispose();
});

test('steer is refused when no turn is running', async () => {
  const events = [];
  const session = createClaudeSession(
    { ...baseOpts, onEvent: (event) => events.push(event) },
    { spawnProcess: () => new FakeProcess(), terminateProcess(proc) { proc.kill('SIGTERM'); } },
  );
  assert.equal(session.steer('hello'), false);
  await session.dispose();
});
