// 허브의 Rau-0.1 연결: 턴 끝 학습 → taste-learned 하나(직접 쓰기 + 학습), 되돌리기, 설정 토글,
// 여러 문서의 취향 → AGENTS.md 제안 하나와 확인 표시. 모델은 가짜 runOneShot 이다.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import { HUB_PROTOCOL_VERSION, startHub } from './hub-harness.mjs';

/**
 * 가짜 Pi(채팅 공급자)와 가짜 runOneShot(학습기 모델)을 허브에 끼운다. 학습기 출력은 outputs.json 의
 * 앞에서부터 하나씩 꺼내고, 받은 프롬프트는 learner-prompts.jsonl 에 남긴다.
 */
function fakePreload(root) {
  const promptLog = path.join(root, 'prompts.jsonl');
  const learnerLog = path.join(root, 'learner-prompts.jsonl');
  const outputs = path.join(root, 'outputs.json');
  const release = path.join(root, 'release');
  const aborted = path.join(root, 'learner-aborted');
  const piUrl = new URL('../agents/pi.mjs', import.meta.url).href;
  const oneShotUrl = new URL('../agents/one-shot-llm.mjs', import.meta.url).href;
  const piSource = `
    import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
    export function canResumePiSession() { return false; }
    export function createPiSession(opts) {
      writeFileSync(${JSON.stringify(path.join(root, 'mcp-token'))}, opts.token);
      return {
        getSessionId() { return 'fake-pi-session'; },
        setExecutionMode() {},
        setPermissionProfile() {},
        dispose() { return true; },
        interrupt() {},
        sendUserMessage(prompt) {
          appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify(prompt) + '\\n');
          opts.onEvent({ type: 'turn-start', agent: 'pi' });
          const end = () => {
            if (prompt.includes('Write turn')) opts.onEvent({ type: 'tool-call', agent: 'pi', id: 'write-1', tool: 'mcp__rhwp__insert_text', input: {} });
            opts.onEvent({ type: 'text-delta', agent: 'pi', text: '한다체로 ' });
            opts.onEvent({ type: 'text-delta', agent: 'pi', text: '고쳤습니다.' });
            opts.onEvent({ type: 'turn-end', agent: 'pi', stopReason: 'completed' });
          };
          if (!prompt.includes('Hold turn')) return end();
          const timer = setInterval(() => {
            if (!existsSync(${JSON.stringify(release)})) return;
            clearInterval(timer);
            rmSync(${JSON.stringify(release)}, { force: true });
            end();
          }, 10);
        },
      };
    }
  `;
  const oneShotStub = `
    import { appendFileSync as __append, existsSync as __exists, readFileSync as __read, writeFileSync as __write } from 'node:fs';
    export async function runOneShot(opts) {
      __append(${JSON.stringify(learnerLog)}, JSON.stringify(opts.prompt) + '\\n');
      const queue = __exists(${JSON.stringify(outputs)}) ? JSON.parse(__read(${JSON.stringify(outputs)}, 'utf8')) : [];
      const output = queue.shift() ?? '{"ops":[]}';
      __write(${JSON.stringify(outputs)}, JSON.stringify(queue));
      if (output === '__hang__') {
        await new Promise((resolve) => opts.deps.signal.addEventListener('abort', resolve, { once: true }));
        __write(${JSON.stringify(aborted)}, '1');
        return null;
      }
      const candidate = opts.candidates.find((route) => route.ready);
      if (!candidate) return null;
      const value = opts.parse(output);
      return value == null ? null : { provider: candidate.provider, model: candidate.model, value, output };
    }
  `;
  writeFileSync(path.join(root, 'loader.mjs'), `
    export async function load(url, context, nextLoad) {
      if (url === ${JSON.stringify(piUrl)}) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(piSource)} };
      if (url === ${JSON.stringify(oneShotUrl)}) {
        const original = await nextLoad(url, context);
        const source = String(original.source).replace('export async function runOneShot(', 'async function realRunOneShot(');
        return { ...original, shortCircuit: true, source: source + ${JSON.stringify(oneShotStub)} };
      }
      return nextLoad(url, context);
    }
  `);
  const preload = path.join(root, 'preload.mjs');
  writeFileSync(preload, "import { register } from 'node:module'; register(new URL('./loader.mjs', import.meta.url));\n");
  const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  return {
    preload: pathToFileURL(preload).href,
    release,
    prompts: () => lines(promptLog),
    learnerPrompts: () => lines(learnerLog),
    aborted: () => existsSync(aborted),
    queueOutputs: (...values) => writeFileSync(outputs, JSON.stringify(values)),
    mcpToken: () => readFileSync(path.join(root, 'mcp-token'), 'utf8'),
  };
}

function bufferedSocket(url, options) {
  const socket = new WebSocket(url, options);
  const buffered = [];
  const waiters = [];
  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    const index = waiters.findIndex((waiter) => waiter.predicate(frame));
    if (index < 0) {
      buffered.push(frame);
      return;
    }
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  });
  return {
    socket,
    buffered,
    send(frame) { socket.send(JSON.stringify({ v: HUB_PROTOCOL_VERSION, ...frame })); },
    next(predicate, timeoutMs = 10_000) {
      const index = buffered.findIndex(predicate);
      if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for a hub frame; buffered=${JSON.stringify(buffered.map((frame) => (/error/.test(frame.type) ? frame : frame.type)))}`));
        }, timeoutMs) };
        waiters.push(waiter);
      });
    },
  };
}

const learnedStyle = JSON.stringify({ ops: [{ op: 'add', kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용', userCandidate: true }] });
const isTurnEnd = (frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end';

/** 가짜 Pi·학습기를 끼운 허브와 Studio 창 하나. */
async function startTasteHub(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-hub-taste-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fake = fakePreload(root);
  for (const dir of ['instructions', 'style', 'skills', 'cli', 'memory']) mkdirSync(path.join(root, dir));
  const hub = await startHub(t, {
    fakePi: true,
    nodeArgs: ['--import', fake.preload],
    prefix: 'rhwp-hub-taste-learner-',
    env: {
      NODE_ENV: 'production',
      RHWP_TASTE_LEARNER: '1',
      RHWP_AGENT_INSTRUCTIONS_DIR: path.join(root, 'instructions'),
      RHWP_WRITING_STYLE_DIR: path.join(root, 'style'),
      RHWP_SKILLS_DIR: path.join(root, 'skills'),
      RHWP_CLI_DIR: path.join(root, 'cli'),
      RHWP_DOCUMENT_MEMORY_DIR: path.join(root, 'memory'),
    },
  });
  const capabilities = await registerHubSession({ port: hub.port, token: hub.token, launchId: hub.launchId, sessionId: 'taste-owner' });
  const studio = bufferedSocket(`ws://127.0.0.1:${hub.port}/studio?token=${capabilities.studio}&sessionId=taste-owner`, { origin: 'rauhwpx://app' });
  await once(studio.socket, 'open');
  await studio.next((frame) => frame.type === 'welcome');
  t.after(() => studio.socket.terminate());
  let seq = 0;
  const request = (frame, type) => {
    const requestId = `r-${++seq}`;
    studio.send({ ...frame, requestId });
    return studio.next((reply) => reply.type === type && reply.requestId === requestId);
  };
  const start = (threadId, documentId, extra = {}) => {
    studio.send({ type: 'chat-start', agent: 'pi', threadId, documentId, documentName: `${documentId}.hwpx`, workflow: 'direct', force: true, ...extra });
    return studio.next((frame) => frame.type === 'chat-started');
  };
  const say = (text) => {
    studio.send({ type: 'chat-user-message', text });
    return studio.next(isTurnEnd);
  };
  return { hub, root, fake, studio, request, start, say };
}

test('Rau-0.1 learns at turn end, shows one marker per turn, undoes, honours the toggle and proposes one AGENTS.md line', async (t) => {
  const { hub, root, fake, studio, request, start, say } = await startTasteHub(t);

  assert.deepEqual((await request({ type: 'taste-settings-request' }, 'taste-settings')).settings, { enabled: true });

  // 1. 에이전트가 턴 중에 기억을 쓰고, 학습기도 배운다 → 표시 하나.
  const started = await start('thread-1', 'doc-1');
  fake.queueOutputs(learnedStyle);
  studio.send({ type: 'chat-user-message', text: 'Hold turn 3장은 건드리지 말고 한다체로 써 줘' });
  const until = Date.now() + 10_000;
  while (!existsSync(path.join(root, 'mcp-token')) || fake.prompts().length === 0) {
    if (Date.now() > until) throw new Error(`no turn: ${hub.stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const mcp = bufferedSocket(`ws://127.0.0.1:${hub.port}/mcp?token=${encodeURIComponent(fake.mcpToken())}&sessionId=taste-owner&agent=pi`);
  await once(mcp.socket, 'open');
  t.after(() => mcp.socket.terminate());
  mcp.send({
    type: 'tool-call', id: 1, tool: 'update_document_memory', workflow: 'direct', capabilityEpoch: started.capabilityEpoch,
    args: { ops: [{ op: 'add', kind: 'protect', subject: '보호.3장', text: '3장 수정 금지' }], expectedRevision: 0 },
  });
  assert.equal((await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 1)).ok, true);
  writeFileSync(fake.release, '');
  const turnEnd = await studio.next(isTurnEnd);
  const learned = await studio.next((frame) => frame.type === 'taste-learned');
  assert.equal(learned.threadId, 'thread-1');
  assert.equal(learned.turnId, turnEnd.event.turnId);
  assert.deepEqual(learned.items.map((item) => [item.op, item.text, item.origin]), [
    ['add', '3장 수정 금지', 'explicit'],
    ['add', '본문은 한다체 사용', 'learned'],
  ]);
  const [learnerPrompt] = fake.learnerPrompts();
  assert.match(learnerPrompt, /한다체로 써 줘/);
  assert.match(learnerPrompt, /한다체로 고쳤습니다/, 'the root answer is captured from text deltas');

  // 2. 되돌리기 — 학습기 결과가 아닌 직접 쓰기 하나만. 다른 문서의 키는 거절하고, 변경 목록은 허브가 남긴 것을 쓴다.
  const mismatch = await request({
    type: 'taste-undo', learnId: learned.learnId, documentId: 'doc-1', key: 'dm_aaaaaaaaaaaaaaaa',
    changes: learned.changes, entryId: learned.items[0].entryId,
  }, 'taste-undo-result');
  assert.deepEqual([mismatch.ok, mismatch.error?.code], [false, 'MEMORY_KEY_MISMATCH']);
  const undone = await request({
    type: 'taste-undo', learnId: learned.learnId, documentId: 'doc-1', key: learned.key,
    changes: [], entryId: learned.items[0].entryId,
  }, 'taste-undo-result');
  assert.deepEqual([undone.ok, undone.reverted, undone.skipped], [true, [learned.items[0].entryId], []]);
  await studio.next((frame) => frame.type === 'document-memory-changed' && frame.documentId === 'doc-1');
  const listed = await request({ type: 'document-memory-request', op: 'list', documentId: 'doc-1' }, 'document-memory-result');
  assert.deepEqual(listed.memory.entries.map((entry) => entry.text), ['본문은 한다체 사용']);

  // 3. 두 번째 문서에서 같은 취향 → AGENTS.md 제안 하나.
  await start('thread-2', 'doc-2');
  fake.queueOutputs(learnedStyle);
  await say('여기도 한다체로 써 줘');
  const draftFrame = await studio.next((frame) => frame.type === 'agent-instructions-draft');
  const second = await studio.next((frame) => frame.type === 'taste-learned');
  assert.equal(draftFrame.draft.requestedBy, 'Rau-0.1');
  assert.match(draftFrame.draft.content, /## Rau-0\.1\n- 본문은 한다체 사용/);
  assert.match(draftFrame.draft.reason, /2개 문서/);
  assert.deepEqual(second.proposal, { draftId: draftFrame.draft.id });

  // 4. 제안이 기다리는 동안 다른 문서가 같은 취향을 배워도 두 번째 제안은 없다.
  await start('thread-3', 'doc-3');
  fake.queueOutputs(learnedStyle);
  await say('이 문서도 한다체');
  const third = await studio.next((frame) => frame.type === 'taste-learned');
  assert.equal(third.proposal, undefined);
  assert.equal(studio.buffered.some((frame) => frame.type === 'agent-instructions-draft'), false);

  // 5. 제안이 기다리는 동안 사용자가 AGENTS.md 를 고쳐도, 확인하면 그 위에 줄을 붙이고 취향 항목들을 promoted 로 적는다.
  const current = await request({ type: 'agent-instructions-request' }, 'agent-instructions');
  const edited = await request({
    type: 'agent-instructions-save', content: '# 내 지시\n- 짧게 답하기\n', expectedRevision: current.status.revision,
  }, 'agent-instructions');
  assert.equal(edited.status.revision, current.status.revision + 1);
  studio.send({ type: 'agent-instructions-draft-confirm', requestId: 'confirm', draftId: draftFrame.draft.id, confirmationToken: draftFrame.draft.confirmationToken });
  const saved = await studio.next((frame) => frame.type === 'agent-instructions' && frame.requestId === 'confirm');
  assert.match(saved.status.content, /^# 내 지시\n- 짧게 답하기\n\n## Rau-0\.1\n- 본문은 한다체 사용/);
  const deadline = Date.now() + 5_000;
  let promoted = [];
  while (Date.now() < deadline) {
    const doc1 = await request({ type: 'document-memory-request', op: 'list', documentId: 'doc-1' }, 'document-memory-result');
    promoted = doc1.memory.entries.filter((entry) => entry.promoted === true);
    if (promoted.length) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(promoted.length, 1);

  // 6. 끄면 다음 턴에 학습기를 부르지 않는다.
  const off = await request({ type: 'taste-settings-set', enabled: false }, 'taste-settings');
  assert.deepEqual(off.settings, { enabled: false });
  const before = fake.learnerPrompts().length;
  await say('한다체 말고 합니다체로 바꿔 줘');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fake.learnerPrompts().length, before);
  assert.equal(studio.buffered.some((frame) => frame.type === 'taste-learned'), false);
});

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('Rau-0.1 waits for review after a safe-mode write, learns plan feedback, and stops with the hub', { timeout: 60_000 }, async (t) => {
  const { hub, fake, studio, start, say } = await startTasteHub(t);
  const at = new Date().toISOString();

  // 1. 안전 모드에서 문서를 고친 턴은 턴 끝에 배우지 않고, 수락과 고쳐 쓰기가 온 뒤 한 번 배운다.
  await start('thread-w', 'doc-w');
  fake.queueOutputs(learnedStyle);
  const turnEnd = await say('Write turn 회의 안내 문단을 써 줘');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fake.learnerPrompts().length, 0, 'no run while the edits wait for review');
  const turnId = turnEnd.event.turnId;
  studio.send({ type: 'chat-review-signal', threadId: 'thread-w', turnId, documentId: 'doc-w', signals: [{ kind: 'accepted', at, after: '회의는 화요일에 열립니다.' }] });
  studio.send({ type: 'chat-review-signal', threadId: 'thread-w', turnId, documentId: 'doc-w', signals: [{ kind: 'rewritten', at, after: '참석해 주시기 바랍니다.', userText: '참석 바란다.' }] });
  const learned = await studio.next((frame) => frame.type === 'taste-learned', 15_000);
  assert.equal(fake.learnerPrompts().length, 1, 'one learner call for the turn, the accept and the rewrite');
  assert.match(fake.learnerPrompts()[0], /회의 안내 문단을 써 줘[^]*회의는 화요일에 열립니다[^]*참석 바란다/);
  assert.deepEqual([learned.threadId, learned.turnId], ['thread-w', turnId]);
  assert.deepEqual(learned.items.map((item) => item.text), ['본문은 한다체 사용']);

  // 2. 플랜 수정 요청의 글도 그 턴의 사용자 글로 배운다.
  const plan = await start('thread-p', 'doc-p', { workflow: 'plan' });
  const prompts = fake.prompts().length;
  studio.send({ type: 'chat-user-message', text: 'Hold turn 회의 안내 계획을 세워 줘' });
  await waitFor(() => fake.prompts().length > prompts, 'plan turn');
  const mcp = bufferedSocket(`ws://127.0.0.1:${hub.port}/mcp?token=${encodeURIComponent(fake.mcpToken())}&sessionId=taste-owner&agent=pi`);
  await once(mcp.socket, 'open');
  t.after(() => mcp.socket.terminate());
  mcp.send({
    type: 'tool-call', id: 1, tool: 'present_implementation_plan', workflow: 'plan', capabilityEpoch: plan.capabilityEpoch,
    args: { goal: '회의 안내', title: '안내 계획', summary: '안내 문단을 쓴다', assumptions: [], decisions: ['한 문단'],
      steps: [{ title: '쓰기', details: '안내 문단을 쓴다' }], files: [], validation: ['다시 읽기'], risks: [], exclusions: [] },
  });
  const planResult = await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 1);
  assert.equal(planResult.ok, true, JSON.stringify(planResult));
  const ready = await studio.next((frame) => frame.type === 'plan-ready');
  writeFileSync(fake.release, '');
  await studio.next(isTurnEnd);
  await waitFor(() => fake.learnerPrompts().length === 2, 'plan turn learned');
  studio.send({ type: 'chat-plan-request-changes', planId: ready.planId, feedback: '합니다체 말고 한다체로 다시 짜 줘' });
  await studio.next(isTurnEnd);
  await waitFor(() => fake.learnerPrompts().length === 3, 'plan feedback learned');
  assert.match(fake.learnerPrompts()[2], /"user_message":"합니다체 말고 한다체로 다시 짜 줘"/);

  // 3. 허브가 내려가면 도는 학습을 끊는다.
  await start('thread-s', 'doc-s');
  fake.queueOutputs('__hang__');
  await say('끝나지 않는 학습');
  await waitFor(() => fake.learnerPrompts().length === 4, 'hanging run');
  hub.child.kill('SIGTERM');
  await once(hub.child, 'exit');
  assert.equal(fake.aborted(), true, `shutdown aborts the running learner call: ${hub.stderr().slice(-3000)}`);
});
