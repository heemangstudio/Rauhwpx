// 토큰 스트림을 WS 프레임 몇 개로 모으되 순서와 글자를 하나도 잃지 않는지 고정한다.
// 단위 계약(가짜 소켓)과, 실제 허브 + 가짜 Pi 로 토큰 600개를 흘리는 경로를 함께 본다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import WebSocket from 'ws';
import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import { createStudioFrameCoalescer } from '../studio-frame-coalescer.mjs';
import { writeFakeCliBin } from './fake-cli-bin.mjs';

function fakeSocket() {
  return { OPEN: 1, readyState: 1 };
}

function harness(options = {}) {
  const written = [];
  const timers = new Map();
  let nextTimer = 0;
  const coalescer = createStudioFrameCoalescer({
    write: (sock, frame) => {
      written.push(frame);
      return sock.readyState === sock.OPEN;
    },
    setTimer: (fn) => {
      const id = ++nextTimer;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    ...options,
  });
  const tick = () => {
    const due = [...timers.entries()];
    timers.clear();
    for (const [, fn] of due) fn();
  };
  return { coalescer, written, tick };
}

const delta = (text, extra = {}) => ({ v: 1, type: 'agent-event', event: { type: 'text-delta', agent: 'claude', text, ...extra } });

test('consecutive deltas of one stream become one frame when the window ends', () => {
  const { coalescer, written, tick } = harness();
  const sock = fakeSocket();
  const first = delta('안녕', { turnId: 't1' });
  coalescer.pushTextDelta(sock, first);
  coalescer.pushTextDelta(sock, delta('하세', { turnId: 't1' }));
  coalescer.pushTextDelta(sock, delta('요', { turnId: 't1' }));
  assert.equal(written.length, 0);
  tick();
  assert.deepEqual(written.map((frame) => frame.event.text), ['안녕하세요']);
  assert.equal(first.event.text, '안녕', 'the provider event object is not mutated');
});

test('a different stream, another frame, or a flush sends the held text first', () => {
  const { coalescer, written, tick } = harness();
  const sock = fakeSocket();
  coalescer.pushTextDelta(sock, delta('루트 '));
  coalescer.pushTextDelta(sock, delta('하위', { parentTaskId: 'task-1' }));
  coalescer.pushTextDelta(sock, delta(' 더', { parentTaskId: 'task-1' }));
  // sendJson 은 다른 프레임 앞에서 flush 한다.
  coalescer.flush(sock);
  written.push({ type: 'agent-event', event: { type: 'tool-call', callId: 'c1' } });
  coalescer.pushTextDelta(sock, delta('끝'));
  tick();
  assert.deepEqual(written.map((frame) => frame.event.text ?? frame.event.type), ['루트 ', '하위 더', 'tool-call', '끝']);
});

test('a large burst is sent once it reaches the size cap', () => {
  const { coalescer, written } = harness({ maxChars: 10 });
  const sock = fakeSocket();
  for (const text of ['12345', '6789', '0abc', 'd']) coalescer.pushTextDelta(sock, delta(text));
  assert.deepEqual(written.map((frame) => frame.event.text), ['1234567890abc']);
  coalescer.flush(sock);
  assert.deepEqual(written.map((frame) => frame.event.text), ['1234567890abc', 'd']);
});

test('progress snapshots of one task keep only the newest', () => {
  const { coalescer, written, tick } = harness();
  const sock = fakeSocket();
  const progress = (taskId, activity) => ({ v: 1, type: 'agent-event', event: { type: 'task-progress', taskId, activity } });
  coalescer.pushProgress(sock, progress('job', 'a'));
  coalescer.pushProgress(sock, progress('job', 'ab'));
  coalescer.pushProgress(sock, progress('other', 'x'));
  tick();
  assert.deepEqual(written.map((frame) => `${frame.event.taskId}:${frame.event.activity}`), ['job:ab', 'other:x']);
});

test('closed sockets hold nothing', () => {
  const { coalescer, written, tick } = harness();
  const sock = fakeSocket();
  coalescer.pushTextDelta(sock, delta('a'));
  coalescer.discard(sock);
  tick();
  assert.equal(written.length, 0);
  sock.readyState = 3;
  assert.equal(coalescer.pushTextDelta(sock, delta('b')), false);
  tick();
  assert.equal(written.length, 0);
});

test('the hub streams a token burst in few frames, in order, without losing text', { timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-frame-coalescer-'));
  const piRoot = path.join(root, 'pi');
  const packageDir = path.join(piRoot, 'prefix/node_modules/@earendil-works/pi-coding-agent');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
  writeFileSync(path.join(piRoot, 'config.json'), JSON.stringify({
    version: 1, installedVersion: '0.0.0-test', defaultModelId: 'test/plain',
    models: [{
      id: 'test/plain', name: 'Plain', reasoning: false, efforts: [], defaultEffort: null,
      contextLength: 8192, supportsImages: false, pricing: { prompt: 0, completion: 0 },
    }],
  }));
  mkdirSync(path.join(piRoot, 'agent'), { recursive: true });
  writeFileSync(path.join(piRoot, 'agent/models.json'), JSON.stringify({ providers: { openrouter: { apiKey: 'fixture-key' } } }));
  // 토큰 300개, 도구 호출 하나, 토큰 300개를 한꺼번에 흘린다.
  writeFakeCliBin(path.join(piRoot, 'prefix/node_modules/.bin'), 'pi', `
    if (process.argv.includes('--version')) { console.log('0.0.0-test'); process.exit(0); }
    require('node:fs').readFileSync(0, 'utf8');
    const lines = [];
    const emit = (delta) => lines.push(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } }));
    for (let i = 0; i < 300; i += 1) emit('앞' + i + ' ');
    lines.push(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'get_structure', args: {} }));
    lines.push(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'call-1', isError: false, result: { content: [] } }));
    for (let i = 0; i < 300; i += 1) emit('뒤' + i + ' ');
    lines.push(JSON.stringify({ type: 'agent_settled' }));
    process.stdout.write(lines.join('\\n') + '\\n');
  `);
  const token = 'frame-coalescer-test';
  const launchId = 'frame-coalescer-launch';
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, NODE_ENV: 'test', RHWP_AGENT_PORT: '0', RHWP_AGENT_TOKEN: token,
      RHWP_LAUNCH_ID: launchId, RHWP_WORK_DIR: root, RHWP_PI_DIR: piRoot,
      RHWP_TEMPLATES_DIR: path.join(root, 'templates'), RHWP_AGENT_INSTRUCTIONS_DIR: path.join(root, 'instructions') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    rmSync(root, { recursive: true, force: true });
  });
  const lines = createInterface({ input: child.stdout });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Hub startup timed out: ${errors}`)), 20_000);
    lines.on('line', (line) => {
      if (!line.startsWith('RHWP_HUB_READY ')) return;
      clearTimeout(timer);
      lines.close();
      resolve(JSON.parse(line.slice('RHWP_HUB_READY '.length)));
    });
  });
  const sessionId = 'frame-coalescer';
  const capabilities = await registerHubSession({ port: ready.port, token, launchId, sessionId });
  const socket = new WebSocket(`ws://127.0.0.1:${ready.port}/studio?token=${capabilities.studio}&sessionId=${sessionId}&instance=frame-coalescer-test`);
  t.after(() => socket.close());
  const frames = [];
  socket.on('message', (data) => frames.push(JSON.parse(String(data))));
  await once(socket, 'open');
  const send = (frame) => socket.send(JSON.stringify({ v: 5, ...frame }));
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const found = frames.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Missing frame: ${JSON.stringify(frames).slice(-3000)}`);
  };
  send({ type: 'chat-start', requestId: 'start-1', agent: 'pi', model: 'test/plain',
    threadId: 'thread-coalesce', documentId: 'doc-coalesce', documentName: 'coalesce.hwpx' });
  const started = await waitFor((frame) => frame.requestId === 'start-1');
  assert.equal(started.type, 'chat-started', JSON.stringify(started));
  send({ type: 'chat-user-message', text: 'stream', threadId: 'thread-coalesce', documentId: 'doc-coalesce' });
  await waitFor((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end');

  const events = frames.filter((frame) => frame.type === 'agent-event').map((frame) => frame.event);
  const order = events.map((event) => event.type).filter((type) => type !== 'turn-start');
  const toolCall = order.indexOf('tool-call');
  const before = events.filter((event, index) => event.type === 'text-delta' && index < events.findIndex((e) => e.type === 'tool-call'));
  const after = events.filter((event, index) => event.type === 'text-delta' && index > events.findIndex((e) => e.type === 'tool-result'));
  assert.equal(before.map((event) => event.text).join(''), Array.from({ length: 300 }, (_, i) => `앞${i} `).join(''));
  assert.equal(after.map((event) => event.text).join(''), Array.from({ length: 300 }, (_, i) => `뒤${i} `).join(''));
  assert.ok(toolCall > 0 && order.at(-1) === 'turn-end', order.join(','));
  const deltaFrames = events.filter((event) => event.type === 'text-delta').length;
  assert.ok(deltaFrames < 60, `600 tokens arrived in ${deltaFrames} frames`);
});
