// 허브의 Rau-0.1 연결: 턴 끝 학습 → taste-learned 하나, 되돌리기, 설정 토글,
// 여러 문서의 취향 → 기억 승격과 <user_memory> 싣기(Rau 요금제만). 모델과 자격은 가짜 HostedRau 이다.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import { HUB_PROTOCOL_VERSION, startHub } from './hub-harness.mjs';

/**
 * 가짜 Claude(채팅 공급자)와 가짜 호스팅 Rau(학습기 모델)을 허브에 끼운다. BYOK(pi) 채팅은 배우지 않으므로
 * 채팅은 Claude 로 연다. 학습기 출력은 outputs.json 의
 * 앞에서부터 하나씩 꺼내고, 받은 프롬프트는 learner-prompts.jsonl 에 남긴다.
 */
function fakePreload(root) {
  const promptLog = path.join(root, 'prompts.jsonl');
  const learnerLog = path.join(root, 'learner-prompts.jsonl');
  const outputs = path.join(root, 'outputs.json');
  const release = path.join(root, 'release');
  const aborted = path.join(root, 'learner-aborted');
  const eligibility = path.join(root, 'eligibility');
  const claudeUrl = new URL('../agents/claude.mjs', import.meta.url).href;
  const hostedUrl = new URL('../rau-hosted.mjs', import.meta.url).href;
  const cliSetupUrl = new URL('../cli-setup-manager.mjs', import.meta.url).href;
  // 허브는 Claude 채팅 전에 CLI 로그인을 확인한다. 가짜 Claude 는 이 기계의 로그인과 상관없이 로그인된 것으로 둔다.
  const cliSetupStub = `
    export function createCliSetupManager(...args) {
      const manager = realCreateCliSetupManager(...args);
      return { ...manager, authStatus: async () => ({ authenticated: true }) };
    }
  `;
  const claudeStub = `
    import { appendFileSync as __fakeAppend, existsSync as __fakeExists, rmSync as __fakeRm, writeFileSync as __fakeWrite } from 'node:fs';
    export async function canResumeClaudeSession() { return false; }
    export function createClaudeSession(opts) {
      __fakeWrite(${JSON.stringify(path.join(root, 'mcp-token'))}, opts.token);
      return {
        getSessionId() { return 'fake-claude-session'; },
        setExecutionMode() {},
        setPermissionProfile() {},
        dispose() { return true; },
        interrupt() {},
        sendUserMessage(prompt) {
          __fakeAppend(${JSON.stringify(promptLog)}, JSON.stringify(prompt) + '\\n');
          opts.onEvent({ type: 'turn-start', agent: 'claude' });
          const end = () => {
            if (prompt.includes('Write turn')) opts.onEvent({ type: 'tool-call', agent: 'claude', id: 'write-1', tool: 'mcp__rhwp__insert_text', input: {} });
            opts.onEvent({ type: 'text-delta', agent: 'claude', text: '한다체로 ' });
            opts.onEvent({ type: 'text-delta', agent: 'claude', text: '고쳤습니다.' });
            opts.onEvent({ type: 'turn-end', agent: 'claude', stopReason: 'completed' });
          };
          if (!prompt.includes('Hold turn')) return end();
          const timer = setInterval(() => {
            if (!__fakeExists(${JSON.stringify(release)})) return;
            clearInterval(timer);
            __fakeRm(${JSON.stringify(release)}, { force: true });
            end();
          }, 10);
        },
      };
    }
  `;
  const hostedStub = `
    import { appendFileSync as __append, existsSync as __exists, readFileSync as __read, writeFileSync as __write } from 'node:fs';
    const __eligibility = () => (__exists(${JSON.stringify(eligibility)}) ? __read(${JSON.stringify(eligibility)}, 'utf8').trim() : 'active');
    export function createHostedRau() { return {
      usable: () => true,
      unusableCode: () => null,
      cachedEligibility: __eligibility,
      eligibility: async () => __eligibility(),
      onEligibilityChange: () => () => {},
      async learn(prompt, { signal } = {}) {
      __append(${JSON.stringify(learnerLog)}, JSON.stringify(prompt) + '\\n');
      const queue = __exists(${JSON.stringify(outputs)}) ? JSON.parse(__read(${JSON.stringify(outputs)}, 'utf8')) : [];
      const output = queue.shift() ?? '{"ops":[]}';
      __write(${JSON.stringify(outputs)}, JSON.stringify(queue));
      if (output === '__hang__') {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        __write(${JSON.stringify(aborted)}, '1');
        return null;
      }
      return { ok: true, text: output, model: 'rau-0.1' };
    } }; }
  `;
  writeFileSync(path.join(root, 'loader.mjs'), `
    export async function load(url, context, nextLoad) {
      if (url === ${JSON.stringify(claudeUrl)}) {
        const original = await nextLoad(url, context);
        const source = String(original.source)
          .replace('export function createClaudeSession(', 'function realCreateClaudeSession(')
          .replace('export async function canResumeClaudeSession(', 'async function realCanResumeClaudeSession(');
        return { ...original, shortCircuit: true, source: source + ${JSON.stringify(claudeStub)} };
      }
      if (url === ${JSON.stringify(cliSetupUrl)}) {
        const original = await nextLoad(url, context);
        const source = String(original.source).replace('export function createCliSetupManager(', 'function realCreateCliSetupManager(');
        return { ...original, shortCircuit: true, source: source + ${JSON.stringify(cliSetupStub)} };
      }
      if (url === ${JSON.stringify(hostedUrl)}) {
        const original = await nextLoad(url, context);
        const source = String(original.source).replace('export function createHostedRau(', 'function realCreateHostedRau(');
        return { ...original, shortCircuit: true, source: source + ${JSON.stringify(hostedStub)} };
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
    setEligibility: (value) => writeFileSync(eligibility, value),
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
async function startTasteHub(t, { prepare } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-hub-taste-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fake = fakePreload(root);
  for (const dir of ['instructions', 'style', 'skills', 'cli', 'memory']) mkdirSync(path.join(root, dir));
  await prepare?.(root);
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
  await studio.next((frame) => frame.type === 'style-learn-status');
  t.after(() => studio.socket.terminate());
  let seq = 0;
  const request = (frame, type) => {
    const requestId = `r-${++seq}`;
    studio.send({ ...frame, requestId });
    return studio.next((reply) => reply.type === type && reply.requestId === requestId);
  };
  const start = (threadId, documentId, extra = {}) => {
    studio.send({ type: 'chat-start', agent: 'claude', threadId, documentId, documentName: `${documentId}.hwpx`, workflow: 'direct', force: true, ...extra });
    return studio.next((frame) => frame.type === 'chat-started');
  };
  const say = (text) => {
    studio.send({ type: 'chat-user-message', text });
    return studio.next(isTurnEnd);
  };
  return { hub, root, fake, studio, request, start, say };
}

test('Rau-0.1 learns at turn end, undoes, escalates a two-document habit into 기억, gates <user_memory> on the Rau plan and honours the toggle', async (t) => {
  const { hub, fake, studio, request, start, say } = await startTasteHub(t);

  const auto = { enabled: true, provider: 'auto', model: null, effort: null };
  assert.deepEqual((await request({ type: 'taste-settings-request' }, 'taste-settings')).settings, auto);
  const initialMemory = await request({ type: 'user-memory-request', op: 'list' }, 'user-memory-result');
  assert.deepEqual([initialMemory.ok, initialMemory.memory.rules, initialMemory.memory.availability, initialMemory.memory.available, initialMemory.memory.legacy],
    [true, [], 'active', true, null]);

  // 1. 학습기가 턴에서 배운다 → 표시 하나. 에이전트는 기억을 쓰지 않는다.
  await start('thread-1', 'doc-1');
  fake.queueOutputs(JSON.stringify({ ops: [
    { op: 'add', kind: 'protect', subject: '보호.3장', text: '3장 수정 금지' },
    { op: 'add', kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용', userCandidate: true },
  ] }));
  studio.send({ type: 'chat-user-message', text: 'Hold turn 앞으로 3장은 건드리지 말고 한다체로 써 줘' });
  const until = Date.now() + 10_000;
  while (fake.prompts().length === 0) {
    if (Date.now() > until) throw new Error(`no turn: ${hub.stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  writeFileSync(fake.release, '');
  const turnEnd = await studio.next(isTurnEnd);
  const learned = await studio.next((frame) => frame.type === 'taste-learned');
  assert.equal(learned.threadId, 'thread-1');
  assert.equal(learned.turnId, turnEnd.event.turnId);
  assert.deepEqual(learned.items.map((item) => [item.op, item.text, item.origin, item.change, item.tier]), [
    ['add', '3장 수정 금지', 'learned', 'new', 'document'],
    ['add', '본문은 한다체 사용', 'learned', 'new', 'document'],
  ]);
  assert.deepEqual(learned.items[1].strength, { from: 0, to: 1 });
  const [learnerPrompt] = fake.learnerPrompts();
  assert.match(learnerPrompt, /한다체로 써 줘/);
  assert.match(learnerPrompt, /한다체로 고쳤습니다/, 'the root answer is captured from text deltas');

  // 2. 되돌리기 — 표시의 항목 하나만. 다른 문서의 키는 거절하고, 변경 목록은 허브가 남긴 것을 쓴다.
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

  // 3. 두 번째 문서에서 같은 습관 → 기억 승격. AGENTS.md 제안은 없다. 두 문서의 메모는 규칙으로 접힌다.
  await start('thread-2', 'doc-2');
  fake.queueOutputs(learnedStyle);
  await say('여기도 한다체로 써 줘');
  const second = await studio.next((frame) => frame.type === 'taste-learned');
  assert.deepEqual(second.items.map((item) => [item.tier, item.change, item.text]), [['account', 'escalated', '본문은 한다체 사용']]);
  assert.equal('proposal' in second, false);
  const broadcast = await studio.next((frame) => frame.type === 'user-memory' && frame.memory.rules.length === 1);
  assert.deepEqual(broadcast.memory.rules.map((rule) => [rule.kind, rule.text, rule.strength, rule.documents]), [['style', '본문은 한다체 사용', 2, 2]]);
  await studio.next((frame) => frame.type === 'document-memory-changed' && frame.documentId === 'doc-1');
  const doc1 = await request({ type: 'document-memory-request', op: 'list', documentId: 'doc-1' }, 'document-memory-result');
  assert.deepEqual(doc1.memory.entries, [], 'doc-1\'s note folded into the rule');
  assert.equal(studio.buffered.some((frame) => /^agent-instructions-draft/.test(frame.type)), false);
  assert.equal(fake.learnerPrompts().length, 2);

  // 4. Rau 요금제면 다음 턴에 <user_memory> 가 AGENTS.md 와 문서 기억 사이에 한 번 실린다.
  await start('thread-3', 'doc-3');
  await request({ type: 'document-memory-request', op: 'apply', documentId: 'doc-3', ops: [{ op: 'add', kind: 'term', subject: '용어.고객', text: "'고객' 대신 '이용자'" }] }, 'document-memory-result');
  await say('표를 하나 넣어 줘');
  const withMemory = fake.prompts().at(-1);
  const order = ['<app_agents_md', '<user_memory revision=', '<document_memory revision='].map((tag) => withMemory.indexOf(tag));
  assert.ok(order.every((index) => index >= 0) && order[0] < order[1] && order[1] < order[2], `memory blocks in order: ${order}`);
  assert.match(withMemory, /<user_memory[^>]*>[\s\S]*\[STYLE, 강도 2\] 본문은 한다체 사용[\s\S]*<\/user_memory>/);
  await say('한 줄 더');
  assert.doesNotMatch(fake.prompts().at(-1), /<user_memory/, 'the same memory is not sent twice to one provider session');

  // 5. Hama·무료로 바뀌면 비었다고 한 번 알리고, 그 뒤로는 싣지 않는다. Rau 탭의 쓸 수 있음도 바뀐다.
  fake.setEligibility('not_eligible');
  await say('또 한 줄');
  assert.match(fake.prompts().at(-1), /<user_memory[^>]*>[\s\S]*No user habits apply now\.[\s\S]*<\/user_memory>/);
  assert.doesNotMatch(fake.prompts().at(-1), /본문은 한다체 사용/);
  await say('마지막 줄');
  assert.doesNotMatch(fake.prompts().at(-1), /<user_memory/);
  const gated = await request({ type: 'user-memory-request', op: 'list' }, 'user-memory-result');
  assert.deepEqual([gated.memory.availability, gated.memory.available, gated.memory.rules.length], ['not_eligible', false, 1]);
  fake.setEligibility('active');

  // 6. Rau 탭의 되돌리기 — 승격을 되돌리면 접혔던 문서 메모가 돌아온다.
  const escalation = gated.memory.events.find((event) => event.kind === 'escalated');
  assert.equal(escalation.undoable, true);
  const reverted = await request({ type: 'user-memory-request', op: 'undo', eventId: escalation.id }, 'user-memory-result');
  assert.deepEqual([reverted.ok, reverted.memory.rules, reverted.memory.retired[0]?.reason], [true, [], 'undone']);
  await studio.next((frame) => frame.type === 'document-memory-changed' && frame.documentId === 'doc-1');
  const back = await request({ type: 'document-memory-request', op: 'list', documentId: 'doc-1' }, 'document-memory-result');
  assert.deepEqual(back.memory.entries.map((entry) => entry.text), ['본문은 한다체 사용']);
  const stale = await request({ type: 'user-memory-request', op: 'undo', eventId: escalation.id }, 'user-memory-result');
  assert.deepEqual([stale.ok, stale.error?.code], [false, 'USER_MEMORY_UNDO_STALE']);
  const added = await request({ type: 'user-memory-request', op: 'add', rule: { kind: 'term', text: "'고객' 대신 '이용자'" } }, 'user-memory-result');
  assert.deepEqual(added.memory.rules.map((rule) => [rule.origin, rule.strength]), [['user', 3]]);

  // 7. 끄면 다음 턴에 학습기를 부르지 않는다.
  const off = await request({ type: 'taste-settings-set', enabled: false }, 'taste-settings');
  assert.deepEqual(off.settings, { ...auto, enabled: false });
  const before = fake.learnerPrompts().length;
  await say('한다체 말고 합니다체로 바꿔 줘');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fake.learnerPrompts().length, before);
  assert.equal(studio.buffered.some((frame) => frame.type === 'taste-learned'), false);

  // 8. 공급자·모델·추론을 고른다. 잘못된 값은 거절하고 설정을 그대로 둔다.
  const chosen = await request({ type: 'taste-settings-set', provider: 'pi', model: 'qwen/qwen3-max', effort: 'high' }, 'taste-settings');
  assert.deepEqual(chosen.settings, { enabled: false, provider: 'auto', model: null, effort: null });
  const rejected = await request({ type: 'taste-settings-set', provider: 'openai' }, 'taste-settings');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'TASTE_SETTINGS_INVALID');
  assert.deepEqual(rejected.settings, chosen.settings);
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
  const mcp = bufferedSocket(`ws://127.0.0.1:${hub.port}/mcp?token=${encodeURIComponent(fake.mcpToken())}&sessionId=taste-owner&agent=claude`);
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

  // 3. 허브가 내려가면 도는 학습을 끊는다. Windows 의 SIGTERM 은 강제 종료라 종료 처리가 돌지 않는다.
  if (process.platform === 'win32') return;
  await start('thread-s', 'doc-s');
  fake.queueOutputs('__hang__');
  await say('끝나지 않는 학습');
  await waitFor(() => fake.learnerPrompts().length === 4, 'hanging run');
  hub.child.kill('SIGTERM');
  await once(hub.child, 'exit');
  assert.equal(fake.aborted(), true, `shutdown aborts the running learner call: ${hub.stderr().slice(-3000)}`);
});

/** 예전 말투 맞추기가 남긴 폴더 — 원고 하나와 추가 지침. */
function writeLegacyStyle(root) {
  const dir = path.join(root, 'style');
  mkdirSync(path.join(dir, 'sources'), { recursive: true });
  const bytes = Buffer.from('저는 보고서를 한다체로 씁니다. 회의는 화요일에 연다.', 'utf8');
  const id = crypto.createHash('sha256').update(bytes).digest('hex');
  const storedName = `01-${id}.txt`;
  writeFileSync(path.join(dir, 'sources', storedName), bytes);
  writeFileSync(path.join(dir, 'style.md'), '# 말투\n');
  writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ language: 'ko', updatedAt: '2026-10-01T00:00:00.000Z' }));
  writeFileSync(path.join(dir, 'additional-instruction.md'), '문장은 짧게 쓴다.\n');
  writeFileSync(path.join(dir, 'sources.json'), JSON.stringify({ version: 1, files: [{ id, sha256: id, storedName, name: '예전 원고.txt', type: 'text/plain', size: bytes.length, addedAt: '2026-10-01T00:00:00.000Z' }] }));
}

test('문체 학습 replaces 말투 맞추기: the legacy instruction moves to AGENTS.md, uploads and the old samples learn into 기억', { timeout: 60_000 }, async (t) => {
  const { root, fake, studio, request } = await startTasteHub(t, { prepare: writeLegacyStyle });
  const connected = await studio.next((frame) => frame.type === 'user-memory');
  assert.deepEqual([connected.memory.legacy, connected.memory.availability], [{ files: 1 }, 'active']);
  assert.equal(studio.buffered.some((frame) => /^writing-style-/.test(frame.type)), false, 'no 말투 맞추기 frames');
  const instructions = await request({ type: 'agent-instructions-request' }, 'agent-instructions');
  assert.match(instructions.status.content, /## 말투 지침\n문장은 짧게 쓴다\./);

  // 올린 파일 → 진행 → 결과(모든 창). 규칙이 기억에 들어간다.
  const invalid = await request({ type: 'style-learn-start', files: [] }, 'style-learn-error');
  assert.equal(invalid.code, 'INVALID_FILES');
  fake.queueOutputs(JSON.stringify({ rules: [{ kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용', evidence: ['이번 분기 매출은 늘었다', '원인은 신규 고객이다'] }] }));
  const text = '이번 분기 매출은 늘었다. 원인은 신규 고객이다.';
  studio.send({ type: 'style-learn-start', requestId: 'upload-1', files: [{ name: '보고서.txt', type: 'text/plain', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') }] });
  const running = await studio.next((frame) => frame.type === 'style-learn-status' && frame.job);
  assert.deepEqual(running.job.files, ['보고서.txt']);
  const progress = await studio.next((frame) => frame.type === 'style-learn-progress' && frame.stage === 'extracting' && frame.completed === 1);
  assert.deepEqual(progress.found, [{ kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용' }]);
  const result = await studio.next((frame) => frame.type === 'style-learn-result' && frame.requestId === 'upload-1');
  assert.deepEqual(result.summary.new.map((item) => [item.subject, item.strength]), [['문체.종결', { from: 0, to: 1 }]]);
  assert.deepEqual(result.memory.rules.map((rule) => [rule.origin, rule.uploads]), [['upload', 1]]);
  assert.match(fake.learnerPrompts().at(-1), /"file_text":"이번 분기 매출은 늘었다/);
  await studio.next((frame) => frame.type === 'style-learn-status' && frame.job === null);
  const status = await request({ type: 'style-learn-status-request' }, 'style-learn-status');
  assert.equal(status.job, null);

  // 예전 원고로 배우기 — 성공하면 폴더를 지우고 legacy 가 사라진다.
  fake.queueOutputs(JSON.stringify({ rules: [{ kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용', evidence: ['보고서를 한다체로 씁니다', '회의는 화요일에 연다'] }] }));
  studio.send({ type: 'style-learn-legacy', requestId: 'legacy-1', accept: true });
  const legacyResult = await studio.next((frame) => frame.type === 'style-learn-result' && frame.requestId === 'legacy-1');
  assert.deepEqual(legacyResult.summary.reinforced.map((item) => item.strength), [{ from: 1, to: 2 }]);
  assert.equal(legacyResult.memory.legacy, null);
  assert.equal(existsSync(path.join(root, 'style')), false, 'the old folder is deleted after a successful learn');
  const again = await request({ type: 'style-learn-legacy', accept: false }, 'style-learn-error');
  assert.equal(again.code, 'INVALID_FILES', 'nothing is left to import');
});
