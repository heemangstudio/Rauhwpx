import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import { HUB_PROTOCOL_VERSION, startHub } from './hub-harness.mjs';
import { authorizeToolCall } from '../planning-state.mjs';
import { filterToolDefinitions } from '../tools.mjs';

/**
 * Pi 백엔드를 허브 안의 가짜로 바꾼다. 받은 프롬프트를 기록하고, 프롬프트의 표시로 턴 끝을 고른다:
 * "Compact now" 는 자동 압축을 끝낸 턴, "Fail turn" 은 실패, "Lose resume" 은 재개 실패,
 * "Hold turn" 은 release 파일이 생길 때까지 턴을 연다.
 */
function fakeProviderPreload(root) {
  const promptLog = path.join(root, 'prompts.jsonl');
  const release = path.join(root, 'release');
  const piUrl = new URL('../agents/pi.mjs', import.meta.url).href;
  const source = `
    import { appendFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
    export function canResumePiSession() { return false; }
    export function createPiSession(opts) {
      let compactions = 0;
      writeFileSync(${JSON.stringify(path.join(root, 'mcp-token'))}, opts.token);
      return {
        getSessionId() { return 'fake-pi-session'; },
        dispose() { return true; },
        interrupt() {},
        sendUserMessage(prompt) {
          appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify(prompt) + '\\n');
          opts.onEvent({ type: 'turn-start', agent: 'pi' });
          const end = (extra = {}) => opts.onEvent({ type: 'turn-end', agent: 'pi', stopReason: 'completed', ...extra });
          if (prompt.includes('Hold turn')) {
            const timer = setInterval(() => {
              if (!existsSync(${JSON.stringify(release)})) return;
              clearInterval(timer);
              rmSync(${JSON.stringify(release)}, { force: true });
              end();
            }, 10);
            return;
          }
          if (prompt.includes('Compact now')) {
            const compactionId = 'auto-' + (++compactions);
            opts.onEvent({ type: 'compaction', agent: 'pi', compactionId, phase: 'started', trigger: 'auto' });
            opts.onEvent({ type: 'compaction', agent: 'pi', compactionId, phase: 'completed', trigger: 'auto' });
          }
          if (prompt.includes('Fail turn')) return end({ stopReason: 'failed' });
          if (prompt.includes('Lose resume')) return end({ resumeLost: true });
          end();
        },
      };
    }
  `;
  writeFileSync(path.join(root, 'loader.mjs'), `
    export async function load(url, context, nextLoad) {
      if (url === ${JSON.stringify(piUrl)}) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(source)} };
      return nextLoad(url, context);
    }
  `);
  const preload = path.join(root, 'preload.mjs');
  writeFileSync(preload, "import { register } from 'node:module'; register(new URL('./loader.mjs', import.meta.url));\n");
  return { preload: pathToFileURL(preload).href, promptLog, release, mcpToken: () => readFileSync(path.join(root, 'mcp-token'), 'utf8') };
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
    send(frame) { socket.send(JSON.stringify({ v: HUB_PROTOCOL_VERSION, ...frame })); },
    next(predicate, timeoutMs = 10_000) {
      const index = buffered.findIndex(predicate);
      if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for a hub frame; buffered=${JSON.stringify(buffered.map((frame) => frame.type))}`));
        }, timeoutMs) };
        waiters.push(waiter);
      });
    },
  };
}

async function fixture(t) {
  const fakeRoot = mkdtempSync(path.join(os.tmpdir(), 'rhwp-document-memory-fake-'));
  t.after(() => rmSync(fakeRoot, { recursive: true, force: true }));
  const fake = fakeProviderPreload(fakeRoot);
  const hub = await startHub(t, {
    fakePi: true,
    nodeArgs: ['--import', fake.preload],
    prefix: 'rhwp-hub-document-memory-',
    env: { NODE_ENV: 'production' },
  });
  const capabilities = await registerHubSession({
    port: hub.port, token: hub.token, launchId: hub.launchId, sessionId: 'memory-owner',
  });
  const studio = bufferedSocket(
    `ws://127.0.0.1:${hub.port}/studio?token=${capabilities.studio}&sessionId=memory-owner`,
    { origin: 'rauhwpx://app' },
  );
  await once(studio.socket, 'open');
  await studio.next((frame) => frame.type === 'welcome');
  t.after(() => studio.socket.terminate());

  const prompts = () => (existsSync(fake.promptLog)
    ? readFileSync(fake.promptLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : []);
  let requestSeq = 0;
  return {
    hub,
    studio,
    capabilities,
    fake,
    async start(threadId, documentId, workflow = 'direct') {
      studio.send({ type: 'chat-start', agent: 'pi', threadId, documentId, documentName: '보고서.hwpx', workflow, force: true });
      return studio.next((frame) => frame.type === 'chat-started');
    },
    async memory(frame) {
      const requestId = `memory-${++requestSeq}`;
      studio.send({ type: 'document-memory-request', requestId, ...frame });
      return studio.next((reply) => reply.type === 'document-memory-result' && reply.requestId === requestId);
    },
    /** 메시지 하나를 보내고 공급자가 받은 프롬프트를 돌려준다. */
    async say(text, extra = {}) {
      const count = prompts().length;
      studio.send({ type: 'chat-user-message', text, ...extra });
      const until = Date.now() + 10_000;
      while (prompts().length === count) {
        if (Date.now() > until) throw new Error(`no prompt for ${text}: ${hub.stderr()}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!text.includes('Hold turn')) await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
      return prompts().at(-1);
    },
    prompts,
  };
}

const hasBlock = (prompt) => prompt.includes('<document_memory ');

test('document memory is sent once per provider session and again after a change, compaction, a failed turn or a lost resume', async (t) => {
  const f = await fixture(t);
  await f.start('thread-1', 'doc-1');

  const added = await f.memory({
    op: 'apply', documentId: 'doc-1', expectedRevision: 0,
    ops: [{ op: 'add', kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용' }],
  });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.memory.entries[0].origin, 'user');
  const changed = await f.studio.next((frame) => frame.type === 'document-memory-changed');
  assert.deepEqual([changed.documentId, changed.key, changed.revision], ['doc-1', added.memory.key, 1]);

  const first = await f.say('첫 질문');
  assert.match(first, /<document_memory revision="1">[\s\S]*\[style, 직접\] 본문은 한다체 사용/);
  assert.equal(hasBlock(await f.say('두 번째 질문')), false, 'an unchanged memory is not sent twice');

  const protect = await f.memory({
    op: 'apply', documentId: 'doc-1', expectedRevision: 1,
    ops: [{ op: 'add', kind: 'protect', subject: '보호.3장', text: '3장 수정 금지', anchor: { quote: '제3장 연구 방법' } }],
  });
  const protectId = protect.changes[0].entryId;
  // Studio has not checked this anchor yet (e.g. the first message after a document switch): hold the note back.
  const unchecked = await f.say('세 번째 질문');
  assert.match(unchecked, /revision="2"/);
  assert.doesNotMatch(unchecked, /3장 수정 금지/, 'an unchecked anchored note is not sent');
  const checked = { documentId: 'doc-1', memoryAnchorRevision: 2 };
  const withMissing = await f.say('세 번째 질문', { ...checked, memoryMissingAnchors: [protectId] });
  assert.match(withMissing, /revision="2"/);
  assert.doesNotMatch(withMissing, /3장 수정 금지/, 'a note whose anchored text is gone is left out');
  assert.match(withMissing, new RegExp(`Omitted .*${protectId}`));
  assert.equal(hasBlock(await f.say('네 번째 질문', { ...checked, memoryMissingAnchors: [protectId] })), false);
  assert.match(await f.say('다섯 번째 질문', checked), /3장 수정 금지/, 'the note returns once its text is back');

  assert.equal(hasBlock(await f.say('Compact now', checked)), false);
  assert.equal(hasBlock(await f.say('압축 뒤 질문', checked)), true, 'compaction drops what the provider was told');

  await f.memory({ op: 'apply', documentId: 'doc-1', ops: [{ op: 'remove', id: protectId }] });
  assert.match(await f.say('Fail turn'), /revision="3"/);
  assert.match(await f.say('실패 뒤 질문'), /revision="3"/, 'a failed turn does not count as delivered');

  assert.equal(hasBlock(await f.say('Lose resume')), false);
  assert.equal(hasBlock(await f.say('재개 실패 뒤 질문')), true, 'a replaced provider session gets the memory again');

  // A new chat on the same document is a new provider session.
  await f.start('thread-2', 'doc-1');
  assert.match(await f.say('새 채팅 질문'), /본문은 한다체 사용/);
  // Another document never sees this memory.
  await f.start('thread-3', 'doc-other');
  assert.equal(hasBlock(await f.say('다른 문서 질문')), false);
});

test('hub-started turns carry document memory too', async (t) => {
  const f = await fixture(t);
  await f.memory({
    op: 'apply', documentId: 'doc-1',
    ops: [{ op: 'add', kind: 'term', subject: '용어.고객', text: "'고객' 대신 '이용자'로 통일" }],
  });
  await f.start('thread-q', 'doc-1', 'question');
  const count = f.prompts().length;
  f.studio.send({ type: 'chat-document-saved', revision: 3, fileName: '보고서.hwpx' });
  const until = Date.now() + 10_000;
  while (f.prompts().length === count && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(f.prompts().at(-1) ?? '', /<document_memory revision="1"[\s\S]*이용자/);
});

test('the agent records memory in 채팅 mode as an explicit note of its turn', async (t) => {
  const f = await fixture(t);
  const started = await f.start('thread-tools', 'doc-tools', 'question');
  await f.say('Hold turn');
  const mcp = bufferedSocket(
    `ws://127.0.0.1:${f.hub.port}/mcp?token=${encodeURIComponent(f.fake.mcpToken())}&sessionId=memory-owner&agent=pi`,
  );
  await once(mcp.socket, 'open');
  t.after(() => mcp.socket.terminate());
  const call = (id, tool, args) => {
    mcp.send({ type: 'tool-call', id, tool, args, workflow: 'question', capabilityEpoch: started.capabilityEpoch });
    return mcp.next((frame) => frame.type === 'tool-result' && frame.id === id);
  };

  const written = await call(1, 'update_document_memory', {
    ops: [{ op: 'add', kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용' }],
    expectedRevision: 0,
  });
  assert.equal(written.ok, true, JSON.stringify(written));
  assert.equal(written.result.revision, 1);
  const changed = await f.studio.next((frame) => frame.type === 'document-memory-changed');
  assert.equal(changed.documentId, 'doc-tools');

  const stale = await call(2, 'update_document_memory', {
    ops: [{ op: 'add', kind: 'fact', subject: '사실.기한', text: '11월 3일 제출' }],
    expectedRevision: 0,
  });
  assert.equal(stale.error?.code, 'MEMORY_REVISION_CONFLICT');

  const read = await call(3, 'read_document_memory', {});
  assert.deepEqual(read.result.entries.map((entry) => entry.text), ['본문은 한다체 사용']);

  const listed = await f.memory({ op: 'list', documentId: 'doc-tools' });
  const [entry] = listed.memory.entries;
  assert.equal(entry.origin, 'explicit');
  assert.equal(entry.source.threadId, 'thread-tools');
  assert.equal(entry.source.kind, 'turn');
  assert.equal(typeof entry.source.turnId, 'string');
  writeFileSync(f.fake.release, '');
  await f.studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
});

test('memory tools are offered in every chat phase and memory writes pass every workflow gate', () => {
  for (const phase of ['direct', 'planning', 'question', 'awaiting-approval', 'implementing']) {
    const names = new Set(filterToolDefinitions(phase).map((definition) => definition.name));
    assert.equal(names.has('read_document_memory'), true, phase);
    assert.equal(names.has('update_document_memory'), true, phase);
  }
  const gates = [
    { workflow: 'question', phase: 'questioning' },
    { workflow: 'plan', phase: 'planning' },
    { workflow: 'plan', phase: 'awaiting-approval' },
    { workflow: 'plan', phase: 'implementing' },
    { workflow: 'direct', phase: 'direct' },
  ];
  for (const gate of gates) {
    assert.equal(authorizeToolCall({
      category: 'memory-write', tool: 'update_document_memory', ...gate,
      expectedEpoch: 7, receivedEpoch: 7, chatPermissionGrants: [],
    }), true, `${gate.workflow}/${gate.phase}`);
  }
  // Subagents and background workers read memory but never write it.
  assert.equal(filterToolDefinitions('doc-researcher').some((definition) => definition.name === 'update_document_memory'), false);
  assert.equal(filterToolDefinitions('copy-layout-worker').some((definition) => definition.name.includes('document_memory')), false);
});
