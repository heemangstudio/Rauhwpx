// 사용자 메시지 거절이 Studio 의 receipt id(messageId)를 되돌리는지 실제 허브로 본다.
// Studio 의 대기 메시지는 이 id 로 자기 메시지의 거절을 알아보고 대기열 맨 앞으로 돌아간다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import WebSocket from 'ws';

import { ALIVE_PI_FIXTURE_SOURCE, writeFakeCliBin } from './fake-cli-bin.mjs';

const TOKEN = 'hub-user-message-receipt-token';
const LAUNCH_ID = 'hub-user-message-receipt-launch';

function waitForLine(stream, predicate, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: stream });
    const timer = setTimeout(() => {
      lines.close();
      reject(new Error('Timed out waiting for process output'));
    }, timeoutMs);
    lines.on('line', (line) => {
      if (!predicate(line)) return;
      clearTimeout(timer);
      lines.close();
      resolve(line);
    });
  });
}

async function openStudio(port, sessionId, role = 'studio') {
  const registration = await fetch(`http://127.0.0.1:${port}/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-Rhwp-Launch-Id': LAUNCH_ID },
  });
  assert.equal(registration.status, 200);
  const socket = new WebSocket(role === 'mcp'
    ? `ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi&role=chat`
    : `ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=page-1`);
  const frames = [];
  const waiters = [];
  socket.on('message', (data) => {
    let frame;
    try { frame = JSON.parse(data.toString()); } catch { return; }
    frames.push(frame);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(frame)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
  });
  await once(socket, 'open');
  return {
    socket,
    frames,
    send(frame) { socket.send(JSON.stringify({ v: 5, ...frame })); },
    /** seen 이후에 온 프레임 중 맞는 첫 프레임. */
    next(predicate, { after = 0, timeoutMs = 10_000 } = {}) {
      const found = frames.slice(after).find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for websocket frame; seen=${JSON.stringify(frames.slice(after))}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = once(socket, 'close');
      socket.close();
      await closed;
    },
  };
}

/**
 * 중지 신호를 무시하는 가짜 Pi — 떠 있음을 알리는 글 한 조각을 내고, 중지 뒤에도 유예 시간 동안
 * 남아 실행 모드 전환(setExecutionMode 가 프로세스 종료를 기다린다)이 그만큼 걸린다.
 */
const STUBBORN_PI_FIXTURE_SOURCE = [
  "if (process.argv.includes('--version')) { console.log('0.0.0-test'); process.exit(0); }",
  "process.on('SIGTERM', () => {});",
  "console.log(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'planning' } }));",
  'setInterval(() => {}, 1000);',
].join('\n');

/** 대답하지 않는 가짜 Pi — 보낸 메시지의 턴은 중지할 때까지 돈다. */
function prepareFakePi(root, fixtureSource = ALIVE_PI_FIXTURE_SOURCE) {
  const packageDir = path.join(root, 'prefix', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const binDir = path.join(root, 'prefix', 'node_modules', '.bin');
  mkdirSync(packageDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
  writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    version: 1,
    installedVersion: '0.0.0-test',
    models: [{
      id: 'mock-model', name: 'Mock model', reasoning: false, supportsImages: false,
      efforts: [], defaultEffort: null, contextLength: 8_192,
      pricing: { prompt: 0, completion: 0 },
    }],
    defaultModelId: 'mock-model',
  }));
  const agentDir = path.join(root, 'agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: { openrouter: { apiKey: 'test-placeholder-key' } },
  }));
  writeFakeCliBin(binDir, 'pi', fixtureSource);
}

async function startHub(t, fixtureSource) {
  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'rhwp-hub-receipt-'));
  const piRoot = path.join(workRoot, 'pi');
  prepareFakePi(piRoot, fixtureSource);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      RHWP_AGENT_PORT: '0',
      RHWP_AGENT_TOKEN: TOKEN,
      RHWP_LAUNCH_ID: LAUNCH_ID,
      RHWP_WORK_DIR: workRoot,
      RHWP_TEMPLATES_DIR: path.join(workRoot, 'templates'),
      RHWP_PI_DIR: piRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    rmSync(workRoot, { recursive: true, force: true });
  });
  const readyLine = await waitForLine(child.stdout, (line) => line.startsWith('RHWP_HUB_READY '));
  return JSON.parse(readyLine.slice('RHWP_HUB_READY '.length)).port;
}

test('a rejected user message echoes its messageId, and the next accepted one starts a turn', { timeout: 40_000 }, async (t) => {
  const port = await startHub(t);
  const studio = await openStudio(port, 'user-message-receipt');
  t.after(() => studio.close());
  await studio.next((frame) => frame.type === 'welcome');

  studio.send({ type: 'chat-start', agent: 'pi', threadId: 'thread-receipt', documentId: 'document-receipt' });
  const started = await studio.next((frame) => frame.type === 'chat-started');
  const scope = { threadId: started.threadId, documentId: started.documentId };

  // A: 턴이 돌기 시작한다(가짜 Pi 는 대답하지 않는다).
  studio.send({ type: 'chat-user-message', ...scope, text: 'First request.' });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');

  // B: 턴이 도는 중에 receipt id 를 실어 보내면 거절이 그 id 를 되돌린다.
  studio.send({ type: 'chat-user-message', ...scope, text: 'Queued follow-up.', messageId: 'm-b', stagedReferenceIds: [] });
  const busy = await studio.next((frame) => frame.type === 'chat-error');
  assert.equal(busy.code, 'AGENT_BUSY');
  assert.equal(busy.messageId, 'm-b');

  // id 없이 보낸 메시지의 거절에는 id 가 없다 — 예전 Studio 가 보는 모양 그대로다.
  const beforeLegacy = studio.frames.length;
  studio.send({ type: 'chat-user-message', ...scope, text: 'Legacy follow-up.' });
  const legacy = await studio.next((frame) => frame.type === 'chat-error', { after: beforeLegacy });
  assert.equal(legacy.code, 'AGENT_BUSY');
  assert.equal('messageId' in legacy, false);

  // 중지한 뒤 C 를 보내면 받아서 새 턴을 시작하고 오류는 없다.
  studio.send({ type: 'chat-interrupt' });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  const beforeC = studio.frames.length;
  studio.send({ type: 'chat-user-message', ...scope, text: 'Send this now.', messageId: 'm-c', stagedReferenceIds: [] });
  const next = await studio.next(
    (frame) => frame.type === 'chat-error' || (frame.type === 'agent-event' && frame.event?.type === 'turn-start'),
    { after: beforeC },
  );
  assert.equal(next.type, 'agent-event', `expected a turn, got ${JSON.stringify(next)}`);
  assert.equal(next.event.type, 'turn-start');
  assert.equal(studio.frames.slice(beforeC).some((frame) => frame.type === 'chat-error'), false);
});

test('a scope rejection also echoes the messageId', { timeout: 40_000 }, async (t) => {
  const port = await startHub(t);
  const studio = await openStudio(port, 'user-message-receipt-scope');
  t.after(() => studio.close());
  await studio.next((frame) => frame.type === 'welcome');
  studio.send({ type: 'chat-start', agent: 'pi', threadId: 'thread-scope', documentId: 'document-scope' });
  const started = await studio.next((frame) => frame.type === 'chat-started');

  studio.send({
    type: 'chat-user-message', threadId: 'another-thread', documentId: started.documentId,
    text: 'Belongs to another chat.', messageId: 'm-stale', stagedReferenceIds: [],
  });
  const rejected = await studio.next((frame) => frame.type === 'chat-error');
  assert.equal(rejected.messageId, 'm-stale');
  assert.notEqual(rejected.code, 'AGENT_BUSY');
});

function implementationPlanArgs() {
  return {
    goal: 'Tidy the document',
    title: 'Tidy plan',
    summary: 'Tidy the headings.',
    assumptions: [],
    decisions: ['Keep the layout'],
    steps: [{ title: 'Tidy headings', details: 'Apply one heading style.' }],
    files: [],
    validation: ['Check the headings'],
    risks: [],
    exclusions: [],
  };
}

test('a message sent while a plan approval switches modes is refused as WORKFLOW_SWITCHING with its messageId', { timeout: 40_000 }, async (t) => {
  // 중지된 Pi 프로세스가 유예 시간 동안 남아 있어 실행 모드 전환이 몇 초 걸린다 — 그 사이에 메시지가 닿는다.
  const port = await startHub(t, STUBBORN_PI_FIXTURE_SOURCE);
  const sessionId = 'user-message-receipt-switch';
  const studio = await openStudio(port, sessionId);
  t.after(() => studio.close());
  await studio.next((frame) => frame.type === 'welcome');
  studio.send({ type: 'chat-start', agent: 'pi', workflow: 'plan', threadId: 'thread-switch', documentId: 'document-switch' });
  const started = await studio.next((frame) => frame.type === 'chat-started');
  const scope = { threadId: started.threadId, documentId: started.documentId };
  studio.send({ type: 'chat-user-message', ...scope, text: 'Plan the tidy-up.' });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');

  const mcp = await openStudio(port, sessionId, 'mcp');
  t.after(() => mcp.close());
  mcp.send({
    type: 'tool-call', id: 1, tool: 'present_implementation_plan', args: implementationPlanArgs(),
    workflow: 'plan', capabilityEpoch: started.capabilityEpoch,
  });
  const ready = await studio.next((frame) => frame.type === 'plan-ready');
  // 프로세스가 떠 있어야 중지 뒤 전환이 그 종료를 기다린다.
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'text-delta');
  studio.send({ type: 'chat-interrupt' });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');

  // 승인은 실행 모드로 바꾸는 전환을 대기열에 넣는다. 그 전환이 끝나기 전에 온 메시지는 전환 중으로 거절된다.
  const before = studio.frames.length;
  studio.send({ type: 'plan-approve', planId: ready.planId });
  studio.send({ type: 'chat-user-message', ...scope, text: 'One more thing.', messageId: 'm-switch', stagedReferenceIds: [] });
  const refused = await studio.next((frame) => frame.type === 'chat-error', { after: before });
  assert.equal(refused.code, 'WORKFLOW_SWITCHING');
  assert.equal(refused.messageId, 'm-switch');
  // 거절된 메시지는 턴을 열지 않는다 — 다음 턴은 승인이 연 구현 턴이다.
  await studio.next((frame) => frame.type === 'implementation-started', { after: before });
});
