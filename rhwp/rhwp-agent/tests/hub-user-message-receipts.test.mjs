import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import WebSocket from 'ws';

import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import { writeFakeCliBin } from './fake-cli-bin.mjs';

function waitForLine(stream, predicate) {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: stream });
    const timer = setTimeout(() => { lines.close(); reject(new Error('Hub did not become ready')); }, 15_000);
    lines.on('line', (line) => {
      if (!predicate(line)) return;
      clearTimeout(timer);
      lines.close();
      resolve(line);
    });
  });
}

function waitForMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for hub message'));
    }, 10_000);
    function onMessage(data) {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    }
    socket.on('message', onMessage);
  });
}

function send(socket, frame) {
  socket.send(JSON.stringify({ v: 5, ...frame }));
}

async function fixture(t, { synchronousProvider = false } = {}) {
  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'rhwp-message-receipts-'));
  const piRoot = path.join(workRoot, 'pi');
  const packageDir = path.join(piRoot, 'prefix', 'node_modules', '@earendil-works', 'pi-coding-agent');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
  writeFileSync(path.join(piRoot, 'config.json'), JSON.stringify({
    version: 1, installedVersion: '0.0.0-test', defaultModelId: 'mock-model',
    models: [{ id: 'mock-model', name: 'Mock model', reasoning: false, supportsImages: false,
      efforts: [], defaultEffort: null, contextLength: 8_192, pricing: { prompt: 0, completion: 0 } }],
  }));
  mkdirSync(path.join(piRoot, 'agent'), { recursive: true });
  writeFileSync(path.join(piRoot, 'agent', 'models.json'), JSON.stringify({
    providers: { openrouter: { apiKey: 'test-placeholder-key' } },
  }));
  const promptLog = path.join(workRoot, 'prompts.jsonl');
  mkdirSync(path.join(workRoot, 'projects'), { recursive: true });
  writeFileSync(path.join(workRoot, 'projects', 'settings.json'), JSON.stringify({ librarian: { enabled: false } }));
  writeFakeCliBin(path.join(piRoot, 'prefix', 'node_modules', '.bin'), 'pi', [
    "if (process.argv.includes('--version')) { console.log('0.0.0-test'); process.exit(0); }",
    "const fs = require('node:fs'); let prompt = '';",
    "process.stdin.on('data', (data) => { prompt += data; });",
    `process.stdin.on('end', () => fs.appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify(prompt) + '\\n'));`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const token = 'message-receipts-master';
  const launchId = 'message-receipts-launch';
  const serverArgs = ['server.mjs'];
  if (synchronousProvider) {
    const piUrl = new URL('../agents/pi.mjs', import.meta.url).href;
    const providerSource = `
      import { appendFileSync } from 'node:fs';
      export function canResumePiSession() { return false; }
      export function createPiSession(opts) {
        return {
          getSessionId() { return 'synchronous-provider'; },
          dispose() { return true; },
          interrupt() {},
          sendUserMessage(prompt) {
            appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify(prompt) + '\\n');
            opts.onEvent({ type: 'turn-start', agent: 'pi' });
            if (prompt.includes('Fail synchronously')) {
              opts.onEvent({ type: 'turn-end', agent: 'pi', stopReason: 'failed' });
              return;
            }
            opts.onEvent({ type: 'text-delta', agent: 'pi', text: 'Synchronous result' });
            opts.onEvent({ type: 'turn-end', agent: 'pi', stopReason: 'completed' });
          },
        };
      }
    `;
    writeFileSync(path.join(workRoot, 'receipt-loader.mjs'), `
      export async function load(url, context, nextLoad) {
        if (url === ${JSON.stringify(piUrl)}) {
          return { format: 'module', shortCircuit: true, source: ${JSON.stringify(providerSource)} };
        }
        return nextLoad(url, context);
      }
    `);
    const preloadPath = path.join(workRoot, 'receipt-preload.mjs');
    writeFileSync(preloadPath, "import { register } from 'node:module'; register(new URL('./receipt-loader.mjs', import.meta.url));\n");
    serverArgs.unshift('--import', preloadPath);
  }
  const child = spawn(process.execPath, serverArgs, {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, NODE_ENV: 'production', RHWP_AGENT_PORT: '0', RHWP_AGENT_TOKEN: token,
      RHWP_LAUNCH_ID: launchId, RHWP_WORK_DIR: workRoot, RHWP_PI_DIR: piRoot,
      RHWP_REFERENCES_DIR: path.join(workRoot, 'references'),
      RHWP_PROJECTS_DIR: path.join(workRoot, 'projects'),
      RHWP_TEMPLATES_DIR: path.join(workRoot, 'templates'),
      RHWP_AGENT_INSTRUCTIONS_DIR: path.join(workRoot, 'agent-instructions'),
      RHWP_CLI_DIR: path.join(workRoot, 'cli'),
      RHWP_WRITING_STYLE_DIR: path.join(workRoot, 'writing-style'),
      RHWP_SKILLS_DIR: path.join(workRoot, 'skills'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    rmSync(workRoot, { recursive: true, force: true });
  });
  const line = await waitForLine(child.stdout, (value) => value.startsWith('RHWP_HUB_READY '));
  const { port } = JSON.parse(line.slice('RHWP_HUB_READY '.length));
  const capabilities = await registerHubSession({ port, token, launchId, sessionId: 'receipt-owner' });
  const base = `http://127.0.0.1:${port}`;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/studio?token=${capabilities.studio}&sessionId=receipt-owner`, {
    origin: 'rauhwpx://app',
  });
  const welcome = waitForMessage(socket, (msg) => msg.type === 'welcome');
  await once(socket, 'open');
  await welcome;
  t.after(() => socket.terminate());
  const frames = [];
  socket.on('message', (data) => frames.push(JSON.parse(data.toString())));
  async function start(threadId = 'receipt-thread', documentId = 'receipt-document') {
    const started = waitForMessage(socket, (msg) => msg.type === 'chat-started');
    send(socket, { type: 'chat-start', agent: 'pi', threadId, documentId, force: true });
    return started;
  }
  async function stage(threadId, name = 'capture.json') {
    const response = await fetch(`${base}/reference-staging?sessionId=receipt-owner&scopeId=${threadId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${capabilities.reference}`, Origin: 'rauhwpx://app',
        'Content-Type': 'text/plain', 'X-File-Name': name },
      body: JSON.stringify({ name, text: 'Saved local selection context' }),
    });
    assert.equal(response.status, 201, stderr);
    return (await response.json()).staged.id;
  }
  async function discard(threadId, stageId) {
    return fetch(`${base}/reference-staging/${stageId}?sessionId=receipt-owner&scopeId=${threadId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${capabilities.reference}`, Origin: 'rauhwpx://app' },
    });
  }
  function prompts() {
    return existsSync(promptLog) ? readFileSync(promptLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  }
  async function waitForPrompts(count) {
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      if (prompts().length === count) return prompts();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(prompts().length, count, stderr);
  }
  return { socket, frames, start, stage, discard, prompts, waitForPrompts };
}

test('capture batches receive acceptance, retain failed sends and deduplicate retries in the real hub', { timeout: 40_000 }, async (t) => {
  const hub = await fixture(t);
  let session = await hub.start();
  const message = (messageId, extra = {}) => ({
    type: 'chat-user-message', requireAcceptance: true, messageId,
    threadId: session.threadId, documentId: session.documentId, text: 'Inspect these captures', ...extra,
  });
  const receive = (messageId, type) => waitForMessage(hub.socket, (frame) => frame.type === type && frame.messageId === messageId)
    .catch((error) => { throw new Error(`${error.message}: ${JSON.stringify(hub.frames.filter((frame) => frame.messageId === messageId))}`); });

  await t.test('staging alone does not dispatch; explicit send accepts the complete attachment batch', async () => {
    const stageId = await hub.stage(session.threadId);
    assert.equal(hub.prompts().length, 0);
    assert.equal(hub.frames.some((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start'), false);
    const accepted = receive('capture-accepted', 'chat-user-message-accepted');
    send(hub.socket, message('capture-accepted', { stagedReferenceIds: [stageId] }));
    assert.equal((await accepted).messageId, 'capture-accepted');
    const [prompt] = await hub.waitForPrompts(1);
    const ackIndex = hub.frames.findIndex((frame) => frame.type === 'chat-user-message-accepted' && frame.messageId === 'capture-accepted');
    const turnIndex = hub.frames.findIndex((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');
    assert.ok(ackIndex >= 0 && turnIndex > ackIndex, 'acceptance precedes provider events so the user bubble renders first');
    assert.match(prompt, /<message_attachments trust="untrusted-data">/);
    assert.match(prompt, /capture\.json/);
  });

  await t.test('accepted retries replay ready metadata, discard new stages and avoid a second dispatch even while busy', async () => {
    const newStageId = await hub.stage(session.threadId);
    const accepted = receive('capture-accepted', 'chat-user-message-accepted');
    const status = receive('capture-accepted', 'chat-reference-status');
    send(hub.socket, message('capture-accepted', { stagedReferenceIds: [newStageId] }));
    const replay = await status;
    assert.equal(replay.attachments[0].stageId, newStageId);
    assert.equal(replay.attachments[0].status, 'ready');
    assert.equal(replay.attachments[0].file.name, 'capture.json');
    await accepted;
    assert.equal((await hub.discard(session.threadId, newStageId)).status, 404);
    assert.equal(hub.prompts().length, 1);
    const rejected = receive('capture-busy', 'chat-user-message-rejected');
    send(hub.socket, message('capture-busy'));
    assert.equal((await rejected).code, 'AGENT_BUSY');
    const conflict = receive('capture-accepted', 'chat-user-message-rejected');
    send(hub.socket, message('capture-accepted', { text: 'Different request', stagedReferenceIds: [newStageId] }));
    assert.equal((await conflict).code, 'MESSAGE_ID_CONFLICT');
  });

  await t.test('one failed stage rejects the complete batch and allows explicit retry with local copies', async () => {
    session = await hub.start();
    const readyStage = await hub.stage(session.threadId, 'local-a.txt');
    const rejected = receive('capture-partial', 'chat-user-message-rejected');
    send(hub.socket, message('capture-partial', { stagedReferenceIds: [readyStage, 'missing-stage'] }));
    assert.equal((await rejected).code, 'REFERENCE_COMMIT_FAILED');
    assert.equal(hub.prompts().length, 1);
    const stages = await Promise.all([hub.stage(session.threadId, 'local-a.txt'), hub.stage(session.threadId, 'local-b.txt')]);
    const accepted = receive('capture-partial', 'chat-user-message-accepted');
    send(hub.socket, message('capture-partial', { stagedReferenceIds: stages }));
    await accepted;
    const prompts = await hub.waitForPrompts(2);
    assert.match(prompts[1], /local-a\.txt/);
    assert.match(prompts[1], /local-b\.txt/);
  });

  await t.test('document ownership and invalid attachment requests reject with their message id', async () => {
    session = await hub.start('second-thread', 'second-document');
    const stale = receive('capture-stale', 'chat-user-message-rejected');
    send(hub.socket, message('capture-stale', { documentId: 'receipt-document' }));
    assert.equal((await stale).code, 'STALE_DOCUMENT_SCOPE');
    const reused = receive('capture-accepted', 'chat-user-message-rejected');
    send(hub.socket, message('capture-accepted', { stagedReferenceIds: ['missing-stage'] }));
    assert.equal((await reused).code, 'MESSAGE_ID_CONFLICT');
    const invalid = receive('capture-invalid', 'chat-user-message-rejected');
    send(hub.socket, message('capture-invalid', { stagedReferenceIds: ['duplicate', 'duplicate'] }));
    assert.equal((await invalid).code, 'INVALID_REFERENCE_MESSAGE');
    assert.equal(hub.prompts().length, 2);
  });

  await t.test('interrupt settles context preparation and a later retry is not rejected by the stale async turn', async () => {
    const rejected = receive('capture-cancelled', 'chat-user-message-rejected');
    send(hub.socket, message('capture-cancelled'));
    send(hub.socket, { type: 'chat-interrupt' });
    assert.equal((await rejected).code, 'REQUEST_INVALIDATED');
    const accepted = receive('capture-cancelled', 'chat-user-message-accepted');
    send(hub.socket, message('capture-cancelled'));
    await accepted;
    await hub.waitForPrompts(3);
    assert.equal(hub.frames.filter((frame) => frame.type === 'chat-user-message-rejected' && frame.messageId === 'capture-cancelled').length, 1);
  });

  await t.test('legacy messages continue to dispatch without requiring a receipt', async () => {
    session = await hub.start();
    send(hub.socket, { type: 'chat-user-message', text: 'Legacy client message' });
    const prompts = await hub.waitForPrompts(4);
    assert.match(prompts[3], /Legacy client message/);
  });
});

test('synchronous provider completion acknowledges before its events and synchronous failure rejects', { timeout: 20_000 }, async (t) => {
  const hub = await fixture(t, { synchronousProvider: true });
  const session = await hub.start();
  const accepted = waitForMessage(hub.socket, (frame) => frame.type === 'chat-user-message-accepted' && frame.messageId === 'sync-success');
  const completed = waitForMessage(hub.socket, (frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  send(hub.socket, {
    type: 'chat-user-message', requireAcceptance: true, messageId: 'sync-success',
    threadId: session.threadId, documentId: session.documentId, text: 'Complete synchronously',
  });
  await accepted;
  assert.equal((await completed).event.stopReason, 'completed');
  assert.deepEqual(hub.frames.filter((frame) => frame.type === 'chat-user-message-accepted' || frame.type === 'agent-event')
    .map((frame) => frame.type === 'agent-event' ? frame.event.type : frame.type), [
    'chat-user-message-accepted', 'turn-start', 'text-delta', 'turn-end',
  ]);
  const rejected = waitForMessage(hub.socket, (frame) => frame.type === 'chat-user-message-rejected' && frame.messageId === 'sync-failure');
  send(hub.socket, {
    type: 'chat-user-message', requireAcceptance: true, messageId: 'sync-failure',
    threadId: session.threadId, documentId: session.documentId, text: 'Fail synchronously',
  });
  assert.equal((await rejected).code, 'REQUEST_INVALIDATED');
  assert.equal(hub.frames.some((frame) => frame.type === 'chat-user-message-accepted' && frame.messageId === 'sync-failure'), false);
});
