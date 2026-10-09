import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import WebSocket from 'ws';
import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import { writeFakeCliBin } from './fake-cli-bin.mjs';

const token = 'provider-settings-test';
const launchId = 'provider-settings-launch';

async function connect(url) {
  const socket = new WebSocket(url);
  const frames = [];
  socket.on('message', (data) => frames.push(JSON.parse(String(data))));
  await once(socket, 'open');
  return {
    socket, frames,
    send: (frame) => socket.send(JSON.stringify({ v: 5, ...frame })),
    async next(predicate) {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const index = frames.findIndex(predicate);
        if (index >= 0) return frames.splice(index, 1)[0];
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Missing frame. Received: ${JSON.stringify(frames).slice(-4000)}`);
    },
  };
}

// 실제 codex-cli 0.162 app-server 의 프레임 순서를 흉내 낸다. 압축은 첫 번째만 끝나되 완료 항목
// 없이 턴만 닫고(허브 합성 검증), 두 번째부터는 멈춰 있다(단일 실행·중단 검증).
const FAKE_CODEX_APP_SERVER = `
if (process.argv.includes('--version')) { console.log('codex-cli 0.162.0'); process.exit(0); }
if (process.argv[2] !== 'app-server') process.exit(2);
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.CODEX_HOME;
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
let thread = null;
let buffer = '';
const usage = (threadId, turnId, last) => {
  const b = (n) => ({ totalTokens: n, inputTokens: n, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });
  send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total: b(last), last: b(last), modelContextWindow: 258400 } } });
};
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
function handle(frame) {
  const reply = (result) => send({ id: frame.id, result });
  if (frame.method === 'initialize') return reply({ userAgent: 'fake/0.162.0' });
  if (frame.method === 'experimentalFeature/list') {
    return reply({ data: [{ name: 'default_mode_request_user_input', enabled: true, stage: 'underDevelopment' }], nextCursor: null });
  }
  if (frame.method === 'thread/start') {
    thread = 'thread-fake';
    const dir = path.join(home, 'sessions', '2026', '10', '09');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rollout-2026-10-09T00-00-00-' + thread + '.jsonl'), '{}\\n');
    send({ method: 'thread/started', params: { thread: { id: thread } } });
    return reply({ thread: { id: thread } });
  }
  if (frame.method === 'thread/resume') {
    thread = frame.params.threadId;
    return reply({ thread: { id: thread } });
  }
  if (frame.method === 'turn/start') {
    const turn = 'turn-' + Date.now();
    send({ method: 'turn/started', params: { threadId: thread, turn: { id: turn, status: 'inProgress' } } });
    reply({ turn: { id: turn, status: 'inProgress' } });
    send({ method: 'item/agentMessage/delta', params: { threadId: thread, turnId: turn, delta: 'ok' } });
    usage(thread, turn, 17780);
    send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'completed' } } });
    return;
  }
  if (frame.method === 'thread/compact/start') {
    const counter = path.join(home, 'fake-compactions');
    const count = (Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0) || 0) + 1;
    fs.writeFileSync(counter, String(count));
    reply({});
    const turn = 'compact-' + count;
    send({ method: 'turn/started', params: { threadId: thread, turn: { id: turn, status: 'inProgress' } } });
    send({ method: 'item/started', params: { threadId: thread, turnId: turn, item: { type: 'contextCompaction', id: 'item-' + count } } });
    if (count === 1) send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'completed' } } });
    return;
  }
  if (frame.method === 'turn/interrupt') return reply({});
}
`;

async function fixture(t, { holdStartupDelayMs = 0, fakeCodex = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-provider-settings-'));
  const piRoot = path.join(root, 'pi');
  const packageDir = path.join(piRoot, 'prefix/node_modules/@earendil-works/pi-coding-agent');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
  writeFileSync(path.join(piRoot, 'config.json'), JSON.stringify({
    version: 1, installedVersion: '0.0.0-test', defaultModelId: 'test/reasoning',
    models: [
      { id: 'test/reasoning', name: 'Reasoning', reasoning: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
      { id: 'test/plain', name: 'Plain', reasoning: false, efforts: [], defaultEffort: null },
    ].map((model) => ({ ...model, contextLength: 8192, supportsImages: false, pricing: { prompt: 0, completion: 0 } })),
  }));
  mkdirSync(path.join(piRoot, 'agent'), { recursive: true });
  writeFileSync(path.join(piRoot, 'agent/models.json'), JSON.stringify({ providers: { openrouter: { apiKey: 'fixture-key' } } }));
  writeFakeCliBin(path.join(piRoot, 'prefix/node_modules/.bin'), 'pi', `
    if (process.argv.includes('--version')) { console.log('0.0.0-test'); process.exit(0); }
    const args = process.argv;
    // 실제 pi 처럼 프롬프트는 stdin 에서 읽는다.
    const prompt = require('node:fs').readFileSync(0, 'utf8').trim();
    const userPrompt = prompt.split('<user_request>').at(-1).split('</user_request>')[0].trim();
    if (userPrompt === 'HOLD') {
      const emit = (text) => console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } }));
      setTimeout(() => {
        emit('HOLD_READY');
        let tick = 0;
        setInterval(() => emit('HOLD_TICK:' + (++tick)), 25);
      }, ${holdStartupDelayMs});
    }
    else {
      // Pi 1.1.0 처럼 --session-dir 의 <시각>_<id>.jsonl 을 이어 쓰거나 같은 id 로 새로 만든다.
      const fs = require('node:fs');
      const sessionDir = args[args.indexOf('--session-dir') + 1];
      const session = args[args.indexOf('--session-id') + 1];
      fs.mkdirSync(sessionDir, { recursive: true });
      const existed = fs.readdirSync(sessionDir).some((name) => name.endsWith('_' + session + '.jsonl'));
      if (!existed) {
        fs.writeFileSync(require('node:path').join(sessionDir, Date.now() + '_' + session + '.jsonl'),
          JSON.stringify({ type: 'session', version: 3, id: session, cwd: process.cwd() }) + '\\n');
      }
      console.log(JSON.stringify({ type: 'session', version: 3, id: session, cwd: process.cwd() }));
      if (userPrompt === 'FAIL') {
        console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'provider failed' } }));
      } else {
        const selected = { model: args[args.indexOf('--model') + 1], effort: args.includes('--thinking') ? args[args.indexOf('--thinking') + 1] : null, prompt, session, existed };
        console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: JSON.stringify(selected) } }));
      }
      console.log(JSON.stringify({ type: 'agent_settled' }));
    }
  `);
  const codexEnv = {};
  if (fakeCodex) {
    const fakeBin = path.join(root, 'fake-bin');
    writeFakeCliBin(fakeBin, 'codex', FAKE_CODEX_APP_SERVER);
    const codexSource = path.join(root, 'codex-source');
    mkdirSync(codexSource, { recursive: true });
    writeFileSync(path.join(codexSource, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-key' }));
    Object.assign(codexEnv, {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      CODEX_HOME: codexSource,
      RHWP_CLI_DIR: path.join(root, 'cli'),
    });
  }
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, NODE_ENV: 'test', RHWP_AGENT_PORT: '0', RHWP_AGENT_TOKEN: token,
      RHWP_LAUNCH_ID: launchId, RHWP_WORK_DIR: root, RHWP_PI_DIR: piRoot,
      RHWP_TEMPLATES_DIR: path.join(root, 'templates'), RHWP_AGENT_INSTRUCTIONS_DIR: path.join(root, 'instructions'), ...codexEnv },
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
  const sessionId = 'provider-settings';
  const capabilities = await registerHubSession({ port: ready.port, token, launchId, sessionId });
  const url = `ws://127.0.0.1:${ready.port}/studio?token=${capabilities.studio}&sessionId=${sessionId}&instance=settings-test`;
  const studio = await connect(url);
  t.after(() => studio.socket.close());
  let seq = 0;
  const start = async (selection = {}) => {
    const requestId = `select-${++seq}`;
    studio.send({ type: 'chat-start', requestId, agent: 'pi', model: 'test/reasoning', effort: 'medium',
      threadId: 'thread-settings', documentId: 'document-settings', documentName: 'settings.hwpx', ...selection });
    return studio.next((frame) => frame.requestId === requestId);
  };
  const turn = async (text) => {
    studio.send({ type: 'chat-user-message', text, threadId: 'thread-settings', documentId: 'document-settings' });
    const delta = await studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'text-delta');
    await studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end');
    return JSON.parse(delta.event.text);
  };
  // 응답 본문(가짜 pi 의 JSON)과 turn-end 를 함께 돌려준다. 실패 턴은 본문이 없다.
  const turnWithEnd = async (text) => {
    studio.send({ type: 'chat-user-message', text, threadId: 'thread-settings', documentId: 'document-settings' });
    const end = await studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end');
    const deltaIndex = studio.frames.findIndex((frame) => frame.type === 'agent-event' && frame.event.type === 'text-delta');
    const delta = deltaIndex >= 0 ? studio.frames.splice(deltaIndex, 1)[0] : null;
    return { reply: delta && delta.event.agent === 'pi' ? JSON.parse(delta.event.text) : null, end: end.event };
  };
  return {
    studio, start, turn, turnWithEnd, url, port: ready.port, sessionId, piRoot, diagnostics: () => errors.slice(-4000),
  };
}

test('live hub applies model/effort/provider changes after a turn and preserves the thread on reconnect', { timeout: 40_000 }, async (t) => {
  const { studio, start, turn, url } = await fixture(t);
  const first = await start();
  assert.equal(first.type, 'chat-started');
  assert.equal((await turn('Remember the word orchard.')).effort, 'medium');
  const history = [{ role: 'user', text: 'Remember the word orchard.' }, { role: 'assistant', text: 'orchard' }];
  const effort = await start({ effort: 'high', history });
  assert.equal(effort.effort, 'high');
  const reply = await turn('What word did I ask you to remember?');
  assert.equal(reply.effort, 'high');
  assert.match(reply.prompt, /reopened_chat_history/);
  assert.match(reply.prompt, /orchard/);
  const plain = await start({ model: 'test/plain', effort: '', history });
  assert.equal(plain.effort, null);
  const plainReply = await turn('Continue.');
  assert.equal(plainReply.model, 'openrouter/test/plain');
  assert.equal(plainReply.effort, null);
  const codex = await start({ agent: 'codex', model: 'gpt-5.6-luna', effort: 'low', history });
  assert.equal(codex.agent, 'codex');
  assert.equal(codex.threadId, first.threadId);
  const claude = await start({ agent: 'claude', model: 'claude-opus-5-6', effort: 'high', history });
  assert.equal(claude.model, 'claude-opus-5-6');
  const back = await start({ history });
  assert.equal(back.agent, 'pi');
  assert.match((await turn('Continue again.')).prompt, /orchard/);
  // Burst starts are serialized at the hub, and replies carry their own identity.
  for (let i = 0; i < 3; i++) studio.send({ type: 'chat-start', requestId: `burst-${i}`, agent: 'pi', model: 'test/reasoning',
    effort: ['low', 'medium', 'high'][i], threadId: first.threadId, documentId: first.documentId, history });
  for (let i = 0; i < 3; i++) assert.equal((await studio.next((frame) => frame.requestId === `burst-${i}`)).effort, ['low', 'medium', 'high'][i]);
  studio.socket.close();
  await once(studio.socket, 'close');
  const reconnected = await connect(url);
  t.after(() => reconnected.socket.close());
  const welcome = await reconnected.next((frame) => frame.type === 'welcome');
  assert.equal(welcome.session.model, 'test/reasoning');
  assert.equal(welcome.session.effort, 'high');
  assert.equal(welcome.session.threadId, first.threadId);
});

test('busy and invalid provider changes leave the active turn intact', { timeout: 40_000 }, async (t) => {
  const { studio, start, diagnostics } = await fixture(t, { holdStartupDelayMs: 250 });
  await start();
  studio.send({ type: 'chat-user-message', text: 'HOLD', threadId: 'thread-settings', documentId: 'document-settings' });
  const active = await studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-start');
  const busy = await start({ effort: 'high' });
  assert.equal(busy.code, 'AGENT_BUSY');
  assert.equal(busy.session.status, 'running');
  assert.equal(busy.session.effort, 'medium');
  const invalid = await start({ agent: 'invalid' });
  assert.equal(invalid.code, 'INVALID_REQUEST');
  assert.equal(invalid.session.status, 'running');
  const diagnostic = () => JSON.stringify({
    frames: studio.frames.filter((frame) => frame.type === 'agent-event').slice(-8).map((frame) => ({
      ...frame, event: { ...frame.event, ...(frame.event.text ? { text: frame.event.text.slice(-800) } : {}) },
    })), stderr: diagnostics(),
  });
  // turn-start precedes spawning the CLI. Prove both startup rejection and
  // rejection against an actually running process, not merely hub status.
  const ready = await studio.next((frame) => frame.type === 'agent-event'
    && (frame.event.type === 'turn-end' || frame.event.type === 'error' || frame.event.text === 'HOLD_READY'));
  assert.equal(ready.event.text, 'HOLD_READY', `HOLD fixture failed to start: ${JSON.stringify(ready)} ${diagnostic()}`);
  const runningBusy = await start({ effort: 'high' });
  assert.equal(runningBusy.code, 'AGENT_BUSY');
  assert.equal(runningBusy.session.turnId, active.event.turnId);
  const runningInvalid = await start({ agent: 'invalid' });
  assert.equal(runningInvalid.code, 'INVALID_REQUEST');
  assert.equal(runningInvalid.session.turnId, active.event.turnId);
  // Require a heartbeat produced after both rejections, not one buffered earlier.
  for (let index = studio.frames.length - 1; index >= 0; index--) {
    if (studio.frames[index].event?.text?.startsWith('HOLD_TICK:')) studio.frames.splice(index, 1);
  }
  const alive = await studio.next((frame) => frame.type === 'agent-event'
    && (frame.event.type === 'turn-end' || frame.event.type === 'error' || frame.event.text?.startsWith('HOLD_TICK:')));
  assert.match(alive.event.text ?? '', /^HOLD_TICK:/, `HOLD process stopped: ${JSON.stringify(alive)} ${diagnostic()}`);
  assert.deepEqual(studio.frames.filter((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end'), [],
    `Active provider ended after rejected settings: ${diagnostic()}`);
  studio.send({ type: 'chat-interrupt' });
  const stopped = await studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end');
  assert.equal(stopped.event.turnId, active.event.turnId);
  assert.equal(stopped.event.stopReason, 'interrupted');
  assert.equal((await start({ effort: 'high' })).effort, 'high');
});

test('changing settings retains a reviewable plan and its permission mode', { timeout: 40_000 }, async (t) => {
  const { studio, start, port, sessionId } = await fixture(t);
  const first = await start({ workflow: 'plan', permissionProfile: 'unrestricted' });
  studio.send({ type: 'chat-user-message', text: 'HOLD', threadId: first.threadId, documentId: first.documentId });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-start');
  const mcp = await connect(`ws://127.0.0.1:${port}/mcp?token=${token}&sessionId=${sessionId}&agent=pi`);
  t.after(() => mcp.socket.close());
  mcp.send({ type: 'tool-call', id: 1, tool: 'present_implementation_plan', workflow: 'plan', capabilityEpoch: first.capabilityEpoch,
    args: { goal: 'Retain context', title: 'Settings plan', summary: 'Continue the existing plan', assumptions: [], decisions: ['Keep the thread'],
      steps: [{ title: 'Continue', details: 'Use the selected provider' }], files: [], validation: ['Check context'], risks: [], exclusions: [] } });
  const presented = await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 1);
  assert.equal(presented.ok, true);
  studio.send({ type: 'chat-interrupt' });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end');
  const changed = await start({ workflow: 'plan', permissionProfile: 'unrestricted', effort: 'high' });
  assert.equal(changed.type, 'chat-started');
  assert.equal(changed.phase, 'awaiting-approval');
  assert.equal(changed.latestPlan.title, 'Settings plan');
  assert.equal(changed.permissionProfile, 'unrestricted');
  assert.ok(changed.capabilityEpoch > first.capabilityEpoch);
});

test('a provider resumes its native session with only unseen messages and falls back to the full transcript', { timeout: 60_000 }, async (t) => {
  const { start, turnWithEnd, piRoot } = await fixture(t);
  const history = [{ role: 'user', text: 'Remember the word orchard.' }, { role: 'assistant', text: 'orchard' }];
  assert.equal((await start()).resumed, false);
  const first = await turnWithEnd('Remember the word orchard.');
  const cursor = first.end.providerSessionId;
  assert.equal(cursor, first.reply.session);

  // 모델이 바뀌어도 같은 Pi 세션을 이어 받고, 본 적 있는 대화는 다시 보내지 않는다.
  const changed = await start({ model: 'test/plain', effort: '', history, providerSessionId: cursor, handoffHistory: [] });
  assert.equal(changed.resumed, true);
  assert.equal(changed.compaction, 'auto-only');
  const resumed = await turnWithEnd('Which word?');
  assert.equal(resumed.reply.session, cursor);
  assert.equal(resumed.reply.existed, true);
  assert.doesNotMatch(resumed.reply.prompt, /reopened_chat_history/);
  assert.equal(resumed.end.providerSessionId, cursor);

  // 다른 공급자를 거쳐 돌아오면 그 사이의 메시지만 받는다.
  await start({ agent: 'codex', model: 'gpt-5.6-luna', effort: 'low', history });
  const codexTurns = [{ role: 'user', text: 'Codex question' }, { role: 'assistant', text: 'Codex answer' }];
  const back = await start({ history: [...history, ...codexTurns], providerSessionId: cursor, handoffHistory: codexTurns });
  assert.equal(back.resumed, true);
  const backReply = await turnWithEnd('Continue.');
  assert.equal(backReply.reply.session, cursor);
  assert.match(backReply.reply.prompt, /Codex answer/);
  assert.doesNotMatch(backReply.reply.prompt, /orchard/);

  // 저장소에 없는 커서는 받지 않고 전체 기록으로 새 세션을 연다.
  const missing = await start({ effort: 'high', history, providerSessionId: 'missing-cursor', handoffHistory: [] });
  assert.equal(missing.resumed, false);
  const missingReply = await turnWithEnd('Which word?');
  assert.notEqual(missingReply.reply.session, 'missing-cursor');
  assert.match(missingReply.reply.prompt, /orchard/);

  // 첫 턴이 실패해도 부트스트랩 기록은 다음 턴까지 남는다.
  await start({ effort: 'low', history });
  const failed = await turnWithEnd('FAIL');
  assert.equal(failed.end.stopReason, 'failed');
  assert.equal(failed.end.providerSessionId, undefined);
  assert.match((await turnWithEnd('Which word?')).reply.prompt, /orchard/);

  // chat-start 때는 있던 세션 파일이 턴 직전에 사라지면, 같은 턴이 전체 기록으로 새 세션을 연다.
  assert.equal((await start({ effort: 'medium', history, providerSessionId: cursor, handoffHistory: [] })).resumed, true);
  const sessions = path.join(piRoot, 'sessions');
  for (const name of readdirSync(sessions)) if (name.endsWith(`_${cursor}.jsonl`)) rmSync(path.join(sessions, name));
  const lost = await turnWithEnd('Which word?');
  assert.match(lost.reply.prompt, /orchard/);
  assert.equal(lost.end.resumeLost, true);
  assert.notEqual(lost.end.providerSessionId, cursor);
  assert.equal(lost.end.providerSessionId, lost.reply.session);
});

test('manual compaction is single-flight, completes without a native signal and fails on interrupt', { timeout: 60_000 }, async (t) => {
  const { studio, start, turnWithEnd, url } = await fixture(t, { fakeCodex: true });
  const compact = (requestId) => studio.send({ type: 'chat-compact', requestId, threadId: 'thread-settings' });
  const reply = (requestId) => studio.next((frame) => frame.requestId === requestId);
  const compactionEvents = () => studio.frames.filter((frame) => frame.type === 'agent-event' && frame.event.type === 'compaction')
    .map((frame) => frame.event);

  compact('no-session');
  assert.equal((await reply('no-session')).code, 'NO_SESSION');
  assert.equal((await start()).compaction, 'auto-only');
  compact('pi');
  assert.equal((await reply('pi')).code, 'COMPACTION_UNSUPPORTED');

  const codex = await start({ agent: 'codex', model: 'gpt-5.6-luna', effort: 'low' });
  assert.equal(codex.compaction, 'manual');
  compact('empty');
  assert.equal((await reply('empty')).code, 'NOTHING_TO_COMPACT');
  const first = await turnWithEnd('hello');
  assert.equal(first.end.providerSessionId, 'thread-fake');

  // 공급자는 contextCompaction 시작만 알리고 완료 항목 없이 턴을 닫는다 → 허브가 completed 를 만든다.
  compact('one');
  const accepted = await reply('one');
  assert.equal(accepted.type, 'chat-compact-accepted');
  const end = await studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end');
  assert.equal(end.event.providerSessionId, 'thread-fake');
  const events = compactionEvents();
  assert.deepEqual(events.map(({ phase, trigger, compactionId }) => [phase, trigger, compactionId]), [
    ['started', 'manual', accepted.compactionId],
    ['completed', 'manual', accepted.compactionId],
  ]);
  assert.equal(events[0].beforeTokens, 17780);
  assert.ok(events.every((event) => event.turnId === end.event.turnId));
  studio.frames.length = 0;

  // 두 번째 압축은 멈춰 있다: 같은 동안의 요청은 거절되고, 중단하면 한 번 실패로 닫힌다.
  compact('two');
  const second = await reply('two');
  assert.equal(second.type, 'chat-compact-accepted');
  await studio.next((frame) => frame.type === 'agent-event' && frame.event.type === 'compaction' && frame.event.phase === 'started');
  compact('busy');
  assert.equal((await reply('busy')).code, 'AGENT_BUSY');
  studio.send({ type: 'chat-user-message', text: 'meanwhile', threadId: 'thread-settings', documentId: 'document-settings' });
  assert.equal((await studio.next((frame) => frame.type === 'chat-error')).code, 'AGENT_BUSY');
  // 다시 붙은 Studio 는 진행 중인 압축을 welcome 에서 본다.
  studio.socket.close();
  await once(studio.socket, 'close');
  const reattached = await connect(url);
  t.after(() => reattached.socket.close());
  const welcome = await reattached.next((frame) => frame.type === 'welcome');
  assert.equal(welcome.session.compaction, 'manual');
  assert.equal(welcome.session.compactionInFlight.compactionId, second.compactionId);
  // 첫 압축 뒤 실제 호출이 아직 없으므로 압축 전 사용량을 다시 보여 주지 않는다.
  assert.equal(welcome.session.contextUsage, null);
  reattached.send({ type: 'chat-interrupt' });
  const interrupted = await reattached.next((frame) => frame.type === 'agent-event' && frame.event.type === 'turn-end');
  assert.equal(interrupted.event.stopReason, 'interrupted');
  assert.equal(interrupted.event.providerSessionId, undefined);
  const failed = reattached.frames.filter((frame) => frame.type === 'agent-event' && frame.event.type === 'compaction')
    .map((frame) => frame.event);
  assert.deepEqual(failed.map(({ phase, compactionId }) => [phase, compactionId]), [['failed', second.compactionId]]);
  assert.match(failed[0].message, /중단/);
});
