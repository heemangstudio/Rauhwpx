import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import WebSocket from 'ws';

import { ALIVE_PI_FIXTURE_SOURCE, writeFakeCliBin } from './fake-cli-bin.mjs';

const TOKEN = 'hub-user-question-test-token';
const LAUNCH_ID = 'hub-user-question-test-launch';

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

async function waitForPath(filePath, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for path: ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function registerSession(port, sessionId) {
  const registration = await fetch(
    `http://127.0.0.1:${port}/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'X-Rhwp-Launch-Id': LAUNCH_ID,
      },
    },
  );
  assert.equal(registration.status, 200);
  return registration.json();
}

async function openClient(url) {
  const parsedUrl = new URL(url);
  const sessionId = parsedUrl.searchParams.get('sessionId');
  if (sessionId) await registerSession(parsedUrl.port, sessionId);
  const socket = new WebSocket(url);
  const buffered = [];
  const waiters = [];
  socket.on('message', (data) => {
    let frame;
    try { frame = JSON.parse(data.toString()); } catch { return; }
    const index = waiters.findIndex((waiter) => waiter.predicate(frame));
    if (index < 0) {
      buffered.push(frame);
      return;
    }
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(frame);
  });
  await once(socket, 'open');
  return {
    socket,
    next(predicate, timeoutMs = 10_000) {
      const index = buffered.findIndex(predicate);
      if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timeoutError = new Error('Timed out waiting for websocket frame');
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const current = waiters.indexOf(waiter);
          if (current >= 0) waiters.splice(current, 1);
          timeoutError.message += `; buffered=${JSON.stringify(buffered)}`;
          reject(timeoutError);
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

function rejectedUpgrade(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('open', () => reject(new Error('WebSocket upgrade unexpectedly succeeded')));
    socket.once('error', reject);
  });
}

function sendFrame(client, frame) {
  client.socket.send(JSON.stringify({ v: 5, ...frame }));
}

async function closeClient(client) {
  if (!client || client.socket.readyState === WebSocket.CLOSED) return;
  const closed = once(client.socket, 'close');
  client.socket.close();
  await closed;
}

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

async function startHub(t, { fakePi = false, controlledCompletion = false, backendFixture = null } = {}) {
  const workRoot = mkdtempSync(path.join(os.tmpdir(), 'rhwp-hub-user-question-'));
  const piRoot = path.join(workRoot, 'pi');
  const completePi = path.join(workRoot, 'complete-pi');
  if (fakePi) prepareFakePi(piRoot, controlledCompletion ? `
    if (process.argv.includes('--version')) { console.log('0.0.0-test'); process.exit(0); }
    const timer = setInterval(() => {
      if (!require('node:fs').existsSync(${JSON.stringify(completePi)})) return;
      clearInterval(timer);
      require('node:fs').unlinkSync(${JSON.stringify(completePi)});
      console.log(JSON.stringify({ type: 'agent_settled' }));
    }, 20);
  ` : ALIVE_PI_FIXTURE_SOURCE);
  const testPath = process.env.PATH;
  const serverArgs = ['server.mjs'];
  if (backendFixture) {
    const backendUrl = new URL(`../agents/${backendFixture.agent}.mjs`, import.meta.url).href;
    const source = backendFixture.source({ workRoot, completePi });
    const cliSetupUrl = new URL('../cli-setup-manager.mjs', import.meta.url).href;
    const cliSetupRoot = path.join(workRoot, 'cli-setup');
    mkdirSync(cliSetupRoot);
    // 대체한 제공자도 실제 로그인 검사를 거친다. 사용자 로그인 대신 격리한 테스트 키를 쓴다.
    writeFileSync(path.join(cliSetupRoot, 'config.json'), JSON.stringify({ claude: { useLocalLogin: false } }));
    if (backendFixture.agent !== 'pi' && backendFixture.authenticated !== false) {
      writeFileSync(path.join(cliSetupRoot, 'secrets.json'), JSON.stringify({
        [`rhwp.${backendFixture.agent}.api-key`]: 'permission-fixture-api-key',
      }));
    }
    const isolatedSetupSource = `
      export * from ${JSON.stringify(`${cliSetupUrl}?permission-fixture-real`)};
      import { createCliSetupManager as createRealManager } from ${JSON.stringify(`${cliSetupUrl}?permission-fixture-real`)};
      export function createCliSetupManager(options) {
        return createRealManager({
          ...options,
          rootDir: ${JSON.stringify(cliSetupRoot)},
          homeDir: ${JSON.stringify(path.join(workRoot, 'cli-home'))},
          baseEnv: { PATH: process.env.PATH },
          secretStore: null,
          readClaudeLogin: async () => null,
          verifyClaude: async () => 'valid',
        });
      }
    `;
    writeFileSync(path.join(workRoot, 'permission-loader.mjs'), `
      export async function load(url, context, nextLoad) {
        if (url === ${JSON.stringify(backendUrl)}) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(source)} };
        if (url === ${JSON.stringify(cliSetupUrl)}) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(isolatedSetupSource)} };
        return nextLoad(url, context);
      }
    `);
    const preload = path.join(workRoot, 'permission-preload.mjs');
    writeFileSync(preload, "import { register } from 'node:module'; register(new URL('./permission-loader.mjs', import.meta.url));\n");
    serverArgs.unshift('--import', preload);
  }
  const child = spawn(process.execPath, serverArgs, {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      RHWP_AGENT_PORT: '0',
      RHWP_AGENT_TOKEN: TOKEN,
      RHWP_LAUNCH_ID: LAUNCH_ID,
      RHWP_WORK_DIR: workRoot, RHWP_REFERENCES_DIR: path.join(workRoot, 'references'), RHWP_PROJECTS_DIR: path.join(workRoot, 'projects'),
      RHWP_TEMPLATES_DIR: path.join(workRoot, 'templates'),
      ...(fakePi ? { RHWP_PI_DIR: piRoot } : {}),
      PATH: testPath,
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
  const readyLine = await waitForLine(child.stdout, (line) => line.startsWith('RHWP_HUB_READY '));
  const ready = JSON.parse(readyLine.slice('RHWP_HUB_READY '.length));
  return {
    port: ready.port,
    workRoot,
    completePi: () => writeFileSync(completePi, ''),
    stderr: () => stderr,
  };
}

function questionArgs() {
  return {
    questions: [{
      id: 'format',
      header: 'Format',
      question: 'Which format should I use?',
      options: [
        { label: 'Brief', description: 'Keep it compact.' },
        { label: 'Detailed', description: 'Include supporting detail.' },
      ],
    }],
  };
}

test('chat permissions survive reload while document edits remain blocked and reset with a new chat', { timeout: 40_000 }, async (t) => {
  const { port, completePi } = await startHub(t, { fakePi: true, controlledCompletion: true });
  const sessionId = 'chat-permission-scope';
  const url = `ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=permission-page`;
  let studio = await openClient(url);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  sendFrame(studio, { type: 'chat-start', agent: 'pi', workflow: 'question', permissionProfile: 'safe', threadId: 'permission-thread', documentId: 'permission-doc', chatPermissionGrants: ['document-edit'] });
  const started = await studio.next((frame) => frame.type === 'chat-started');
  assert.deepEqual(started.chatPermissionGrants, []);
  sendFrame(studio, { type: 'chat-user-message', text: 'Request a project permission.', threadId: started.threadId, documentId: started.documentId });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');
  let mcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi&role=chat`);
  t.after(() => closeClient(mcp));
  const edit = { tool: 'insert_text', args: { expectedRevision: 1, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'Blocked edit' }, workflow: 'question', capabilityEpoch: started.capabilityEpoch };
  sendFrame(mcp, { type: 'tool-call', id: 101, ...edit, chatPermissionGrants: ['document-edit'] });
  assert.equal((await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 101)).error.code, 'QUESTION_WRITE_BLOCKED');
  sendFrame(mcp, { type: 'tool-call', id: 100, tool: 'request_permission', args: { capability: 'document-edit', reason: 'Apply the requested paragraph edit.' }, workflow: 'question', capabilityEpoch: started.capabilityEpoch });
  assert.equal((await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 100)).error.code, 'INVALID_ARGS');
  sendFrame(mcp, { type: 'tool-call', id: 102, tool: 'request_permission', args: { capability: 'project-edit', reason: 'Save the research project note.' }, workflow: 'question', capabilityEpoch: started.capabilityEpoch });
  const requested = await studio.next((frame) => frame.type === 'chat-permission-requested');
  const pending = await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 102);
  assert.equal(pending.ok, true);
  assert.equal(pending.result.status, 'pending', 'the tool returns before the user responds');
  sendFrame(studio, { type: 'chat-permission-response', requestId: requested.request.requestId, responseId: 'wrong-scope', threadId: 'another-thread', documentId: started.documentId, decision: 'grant' });
  assert.equal((await studio.next((frame) => frame.type === 'chat-permission-response-result' && frame.responseId === 'wrong-scope')).ok, false);
  await closeClient(studio);
  studio = await openClient(url);
  const welcome = await studio.next((frame) => frame.type === 'welcome');
  assert.equal(welcome.session.pendingChatPermissionRequest.requestId, requested.request.requestId);
  const replayed = await studio.next((frame) => frame.type === 'chat-permission-requested');
  assert.equal(replayed.replayed, true);
  const response = { type: 'chat-permission-response', requestId: requested.request.requestId, responseId: 'grant-project', threadId: started.threadId, documentId: started.documentId, decision: 'grant' };
  sendFrame(studio, response);
  assert.equal((await studio.next((frame) => frame.type === 'chat-permission-response-result')).code, 'AGENT_BUSY');
  completePi();
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  sendFrame(studio, response);
  assert.equal((await studio.next((frame) => frame.type === 'chat-permission-response-result')).ok, true);
  const granted = await studio.next((frame) => frame.type === 'chat-permission-resolved');
  assert.equal(granted.outcome.status, 'granted');
  assert.deepEqual(granted.grants, ['project-edit']);
  assert.equal(granted.capabilityEpoch, started.capabilityEpoch);
  sendFrame(studio, response);
  assert.equal((await studio.next((frame) => frame.type === 'chat-permission-response-result')).ok, true, 'duplicate approval is acknowledged');
  sendFrame(studio, { type: 'chat-user-message', text: 'Apply the paragraph edit now.', threadId: started.threadId, documentId: started.documentId });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');
  mcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi&role=chat`);
  sendFrame(mcp, { type: 'tool-call', id: 103, ...edit });
  assert.equal((await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 103)).error.code, 'QUESTION_WRITE_BLOCKED');
  sendFrame(mcp, { type: 'tool-call', id: 104, tool: 'get_structure', args: {}, workflow: 'question', capabilityEpoch: started.capabilityEpoch });
  const forwarded = await studio.next((frame) => frame.type === 'tool-request');
  assert.equal(forwarded.tool, 'get_structure', 'blocked document writes never reach Studio');
  assert.deepEqual(forwarded.chatPermissionGrants, ['project-edit']);
  sendFrame(studio, { type: 'tool-response', id: forwarded.id, ok: true, result: { revision: 1 } });
  assert.equal((await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 104)).ok, true);
  sendFrame(studio, { type: 'chat-interrupt' });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  sendFrame(studio, { type: 'chat-start', agent: 'pi', workflow: 'question', permissionProfile: 'safe', threadId: 'new-permission-thread', documentId: 'permission-doc', force: true });
  const nextChat = await studio.next((frame) => frame.type === 'chat-started');
  assert.deepEqual(nextChat.chatPermissionGrants, []);
  assert.equal(nextChat.pendingChatPermissionRequest, null);
  assert.equal(nextChat.permissionProfile, 'safe');
});

test('local permission waits for idle, keeps its pending request, and preserves the safe profile', { timeout: 40_000 }, async (t) => {
  const { port, completePi } = await startHub(t, { fakePi: true, controlledCompletion: true });
  const sessionId = 'chat-permission-native';
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=native-permission-page`);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  const started = await startRunningChat(studio, 'pi');
  const mcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi&role=chat`);
  t.after(() => closeClient(mcp));
  sendFrame(mcp, { type: 'tool-call', id: 201, tool: 'request_permission', args: { capability: 'local-execution', reason: 'Read local files and run the requested command.' } });
  const requested = await studio.next((frame) => frame.type === 'chat-permission-requested');
  assert.equal((await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 201)).result.status, 'pending');
  const response = { type: 'chat-permission-response', requestId: requested.request.requestId, responseId: 'native-grant', threadId: started.threadId, documentId: started.documentId, decision: 'grant' };
  sendFrame(studio, response);
  assert.equal((await studio.next((frame) => frame.type === 'chat-permission-response-result')).code, 'AGENT_BUSY');
  completePi();
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  sendFrame(studio, response);
  assert.equal((await studio.next((frame) => frame.type === 'chat-permission-response-result')).ok, true);
  const resolved = await studio.next((frame) => frame.type === 'chat-permission-resolved');
  assert.deepEqual(resolved.grants, ['local-execution']);
  sendFrame(studio, { type: 'chat-start', agent: 'pi', threadId: started.threadId, documentId: started.documentId });
  const retained = await studio.next((frame) => frame.type === 'chat-started');
  assert.deepEqual(retained.chatPermissionGrants, ['local-execution']);
  assert.equal(retained.permissionProfile, 'safe');
});

test('failed and interrupted permission reconfiguration restores native authority', { timeout: 40_000 }, async (t) => {
  const { port, completePi, workRoot } = await startHub(t, {
    fakePi: true,
    backendFixture: {
      agent: 'pi',
      source: ({ workRoot: root, completePi: completion }) => `
        import fs from 'node:fs';
        export function createPiSession(opts) {
          let running = false;
          const timer = setInterval(() => {
            if (!fs.existsSync(${JSON.stringify(completion)})) return;
            fs.unlinkSync(${JSON.stringify(completion)});
            running = false;
            opts.onEvent({ type: 'turn-end', agent: 'pi', stopReason: 'completed' });
          }, 10);
          return {
            getSessionId() { return 'permission-transition-fixture'; },
            dispose() { clearInterval(timer); return true; },
            interrupt() {
              if (!running) return;
              running = false;
              opts.onEvent({ type: 'turn-end', agent: 'pi', stopReason: 'interrupted' });
            },
            sendUserMessage() { running = true; opts.onEvent({ type: 'turn-start', agent: 'pi' }); },
            async setExecutionMode(mode) {
              opts.chatPermissionGrants = [...mode.chatPermissionGrants];
              fs.writeFileSync(${JSON.stringify(path.join(root, 'effective-grants.json'))}, JSON.stringify(opts.chatPermissionGrants));
              if (!opts.chatPermissionGrants.includes('local-execution')) return;
              fs.writeFileSync(${JSON.stringify(path.join(root, 'permission-apply-started'))}, '');
              while (!fs.existsSync(${JSON.stringify(path.join(root, 'permission-apply-release'))})) await new Promise((resolve) => setTimeout(resolve, 10));
              if (fs.existsSync(${JSON.stringify(path.join(root, 'permission-apply-fail'))})) throw new Error('Fixture provider reconfiguration failed');
            },
          };
        }
      `,
    },
  });
  const sessionId = 'permission-transition-rollback';
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=transition-page`);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  const started = await startRunningChat(studio, 'pi');
  const mcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi&role=chat`);
  t.after(() => closeClient(mcp));
  sendFrame(mcp, { type: 'tool-call', id: 401, tool: 'request_permission', args: { capability: 'local-execution', reason: 'Perform the requested local command.' } });
  const requested = await studio.next((frame) => frame.type === 'chat-permission-requested');
  await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 401);
  completePi();
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  const response = { type: 'chat-permission-response', requestId: requested.request.requestId, responseId: 'rollback-grant', threadId: started.threadId, documentId: started.documentId, decision: 'grant' };
  const release = path.join(workRoot, 'permission-apply-release');
  const failure = path.join(workRoot, 'permission-apply-fail');
  const applyStarted = path.join(workRoot, 'permission-apply-started');
  const effectiveGrants = () => JSON.parse(readFileSync(path.join(workRoot, 'effective-grants.json'), 'utf8'));
  writeFileSync(release, '');
  writeFileSync(failure, '');
  sendFrame(studio, response);
  const failed = await studio.next((frame) => frame.type === 'chat-permission-response-result');
  assert.equal(failed.ok, false);
  assert.match(failed.message, /Fixture provider reconfiguration failed/);
  assert.deepEqual(effectiveGrants(), []);
  sendFrame(studio, { type: 'chat-start', agent: 'pi', threadId: started.threadId, documentId: started.documentId });
  const unchanged = await studio.next((frame) => frame.type === 'chat-started');
  assert.deepEqual(unchanged.chatPermissionGrants, []);
  assert.equal(unchanged.pendingChatPermissionRequest.requestId, requested.request.requestId);
  rmSync(release);
  rmSync(failure);
  rmSync(applyStarted);
  sendFrame(studio, response);
  await waitForPath(applyStarted);
  assert.deepEqual(effectiveGrants(), ['local-execution']);
  sendFrame(studio, { type: 'chat-interrupt' });
  const cancelled = await studio.next((frame) => frame.type === 'chat-permission-resolved');
  assert.equal(cancelled.outcome.status, 'expired');
  writeFileSync(release, '');
  const interrupted = await studio.next((frame) => frame.type === 'chat-permission-response-result');
  assert.equal(interrupted.code, 'REQUEST_INVALIDATED');
  assert.deepEqual(effectiveGrants(), [], 'an interrupted adapter cannot retain the rejected native grant');
});

test('signed-out legacy provider cannot dispatch a permission request turn', { timeout: 20_000 }, async (t) => {
  const { port } = await startHub(t, {
    backendFixture: {
      agent: 'claude',
      authenticated: false,
      source: () => `
        export function prepareClaudeHome() { return []; }
        export function flushClaudeCredentialMirrors() { return true; }
        export function createClaudeSession() {
          return {
            getSessionId() { return 'signed-out-permission-fixture'; },
            dispose() { return true; },
            sendUserMessage() { throw new Error('A signed-out provider must not receive the prompt'); },
          };
        }
      `,
    },
  });
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=signed-out-permission&instance=signed-out-page`);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  await studio.next((frame) => frame.type === 'agent-setup-status' && frame.statuses?.claude?.authenticated === false);
  sendFrame(studio, { type: 'chat-start', agent: 'claude', threadId: 'signed-out-thread', documentId: 'signed-out-doc' });
  const started = await studio.next((frame) => frame.type === 'chat-started');
  sendFrame(studio, { type: 'chat-user-message', text: 'Request a download permission.', threadId: started.threadId, documentId: started.documentId });
  const denied = await studio.next((frame) => frame.type === 'chat-error');
  assert.equal(denied.code, 'AGENT_AUTH_REQUIRED');
});

test('permission requests require one provider-stream root ticket for legacy MCP callers', { timeout: 40_000 }, async (t) => {
  const args = { capability: 'downloads', reason: 'Download the attached source.' };
  const { port } = await startHub(t, {
    backendFixture: {
      agent: 'claude',
      source: () => `
        export function prepareClaudeHome() { return []; }
        export function flushClaudeCredentialMirrors() { return true; }
        export function createClaudeSession(opts) {
          return {
            getSessionId() { return 'permission-provenance-fixture'; },
            dispose() { return true; },
            setExecutionMode() {},
            interrupt() { opts.onEvent({ type: 'turn-end', agent: 'claude', stopReason: 'interrupted' }); },
            sendUserMessage(prompt) {
              opts.onEvent({ type: 'turn-start', agent: 'claude' });
              const event = { type: 'tool-call', agent: 'claude', tool: 'mcp__rhwp__request_permission', argsJson: ${JSON.stringify(JSON.stringify(args))} };
              if (prompt.includes('permission-root-ticket') || prompt.includes('permission-ambiguous-ticket')) {
                opts.onEvent({ ...event, callId: 'root-permission-call' });
              }
              if (prompt.includes('permission-child-ticket') || prompt.includes('permission-ambiguous-ticket')) {
                opts.onEvent({ ...event, callId: 'child-permission-call', parentTaskId: 'child-task' });
              }
            },
          };
        }
      `,
    },
  });
  const sessionId = 'permission-root-provenance';
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=provenance-page`);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  await studio.next((frame) => frame.type === 'agent-setup-status' && frame.statuses?.claude?.authenticated === true);
  sendFrame(studio, { type: 'chat-start', agent: 'claude', threadId: 'provenance-thread', documentId: 'provenance-doc' });
  const started = await studio.next((frame) => frame.type === 'chat-started');
  const cases = [
    ['permission-missing-ticket', 'CALLER_SCOPE_UNKNOWN'],
    ['permission-child-ticket', 'ROOT_INTERACTION_REQUIRED'],
    ['permission-ambiguous-ticket', 'CALLER_SCOPE_UNKNOWN'],
    ['permission-root-ticket', null],
  ];
  let id = 501;
  for (const [trigger, expectedError] of cases) {
    sendFrame(studio, { type: 'chat-user-message', text: trigger, threadId: started.threadId, documentId: started.documentId });
    await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');
    const mcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=claude&role=chat`);
    t.after(() => closeClient(mcp));
    sendFrame(mcp, { type: 'tool-call', id, tool: 'request_permission', args });
    const result = await mcp.next((frame) => frame.type === 'tool-result' && frame.id === id);
    if (expectedError) {
      assert.equal(result.ok, false);
      assert.equal(result.error.code, expectedError);
    } else {
      assert.equal(result.ok, true);
      assert.equal(result.result.status, 'pending');
      const requested = await studio.next((frame) => frame.type === 'chat-permission-requested');
      assert.equal(requested.request.capability, 'downloads');
    }
    sendFrame(studio, { type: 'chat-interrupt' });
    await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
    id += 1;
  }
});

test('permission denials and cancellation leave no grant and plan approval remains required', { timeout: 40_000 }, async (t) => {
  const { port } = await startHub(t, { fakePi: true });
  const sessionId = 'chat-permission-denial';
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=denial-page`);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  const started = await startRunningChat(studio, 'pi');
  const mcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi&role=chat`);
  t.after(() => closeClient(mcp));
  const args = { capability: 'downloads', reason: 'Fetch the source attachment.' };
  sendFrame(mcp, { type: 'tool-call', id: 301, tool: 'request_permission', args, parentTaskId: 'child-task' });
  assert.equal((await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 301)).error.code, 'ROOT_INTERACTION_REQUIRED');
  sendFrame(mcp, { type: 'tool-call', id: 302, tool: 'request_permission', args });
  const requested = await studio.next((frame) => frame.type === 'chat-permission-requested');
  await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 302);
  sendFrame(studio, { type: 'chat-permission-response', requestId: requested.request.requestId, responseId: 'deny-download', threadId: started.threadId, documentId: started.documentId, decision: 'deny' });
  await studio.next((frame) => frame.type === 'chat-permission-response-result');
  const denied = await studio.next((frame) => frame.type === 'chat-permission-resolved');
  assert.equal(denied.outcome.status, 'denied');
  assert.deepEqual(denied.grants, []);
  sendFrame(mcp, { type: 'tool-call', id: 303, tool: 'request_permission', args });
  const second = await studio.next((frame) => frame.type === 'chat-permission-requested');
  await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 303);
  sendFrame(studio, { type: 'chat-interrupt' });
  const expired = await studio.next((frame) => frame.type === 'chat-permission-resolved' && frame.requestId === second.request.requestId);
  assert.equal(expired.outcome.status, 'expired');
  assert.deepEqual(expired.grants, []);
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  sendFrame(studio, { type: 'chat-start', agent: 'pi', workflow: 'plan', force: true, threadId: 'plan-permission-thread', documentId: 'plan-permission-doc' });
  const plan = await studio.next((frame) => frame.type === 'chat-started');
  sendFrame(studio, { type: 'chat-user-message', text: 'Prepare a plan.', threadId: plan.threadId, documentId: plan.documentId });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');
  const planner = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi&role=chat`);
  t.after(() => closeClient(planner));
  sendFrame(planner, { type: 'tool-call', id: 304, tool: 'request_permission', args: { capability: 'document-edit', reason: 'Start implementing before approval.' }, workflow: 'plan', capabilityEpoch: plan.capabilityEpoch });
  assert.equal((await planner.next((frame) => frame.type === 'tool-result' && frame.id === 304)).error.code, 'INVALID_ARGS');
});

function implementationPlanArgs() {
  return {
    goal: 'Implement the requested mode synchronization',
    title: 'Mode synchronization plan',
    summary: 'Keep the provider and UI on the same authoritative phase.',
    assumptions: [],
    decisions: ['Use the hub transition as the authority'],
    steps: [{ title: 'Switch mode', details: 'Apply the confirmed provider mode.' }],
    files: [],
    validation: ['Verify the implementation phase event'],
    risks: [],
    exclusions: [],
  };
}

async function startRunningChat(studio, agent = 'claude') {
  sendFrame(studio, {
    type: 'chat-start',
    agent,
    threadId: 'thread-question',
    documentId: 'document-question',
  });
  const started = await studio.next((frame) => frame.type === 'chat-started');
  sendFrame(studio, {
    type: 'chat-user-message',
    threadId: started.threadId,
    documentId: started.documentId,
    text: 'Wait while a tool asks me one question.',
  });
  await studio.next(
    (frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start',
  );
  return started;
}

test('an explicit unknown workflow is rejected instead of opening Direct mode', { timeout: 40_000 }, async (t) => {
  const { port } = await startHub(t);
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=invalid-workflow&instance=page-1`);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');

  sendFrame(studio, {
    type: 'chat-start',
    agent: 'claude',
    workflow: 'surprise-mode',
    threadId: 'thread-invalid-workflow',
    documentId: 'document-invalid-workflow',
  });
  const error = await studio.next((frame) => frame.type === 'chat-error');
  assert.equal(error.code, 'INVALID_WORKFLOW');
  assert.match(error.message, /Unknown workflow: surprise-mode/);
});

test('plan discussion retains review, revisions check freshness, and execution reports real progress', { timeout: 40_000 }, async (t) => {
  const { port } = await startHub(t, { fakePi: true });
  const sessionId = 'typed-plan-approval';
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=page-1`);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  sendFrame(studio, {
    type: 'chat-start',
    agent: 'pi',
    workflow: 'plan',
    threadId: 'thread-typed-plan-approval',
    documentId: 'document-typed-plan-approval',
  });
  const started = await studio.next((frame) => frame.type === 'chat-started');
  assert.equal(started.workflow, 'plan');
  assert.equal(started.phase, 'planning');

  sendFrame(studio, {
    type: 'chat-user-message',
    threadId: started.threadId,
    documentId: started.documentId,
    text: 'Prepare the implementation plan.',
  });
  await studio.next(
    (frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start',
  );

  const mcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi&role=chat`);
  t.after(() => closeClient(mcp));
  sendFrame(mcp, {
    type: 'tool-call',
    id: 31,
    tool: 'present_implementation_plan',
    args: implementationPlanArgs(),
    workflow: 'plan',
    capabilityEpoch: started.capabilityEpoch,
  });
  const ready = await studio.next((frame) => frame.type === 'plan-ready');
  const planResult = await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 31);
  assert.equal(planResult.ok, true);
  assert.equal(ready.phase, 'awaiting-approval');

  // A Studio frame cannot forge the internal document-save transition lock
  // and revise a plan while the provider turn that presented it is active.
  sendFrame(studio, {
    type: 'plan-request-changes',
    planId: ready.planId,
    feedback: 'This must wait until the current turn settles.',
    sessionStatusOverride: 'idle',
  });
  const busy = await studio.next(
    (frame) => frame.type === 'chat-error' && frame.code === 'AGENT_BUSY',
  );
  assert.match(busy.message, /agent is idle/i);

  sendFrame(studio, { type: 'chat-interrupt' });
  await studio.next(
    (frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end',
  );

  sendFrame(studio, {
    type: 'chat-user-message', threadId: started.threadId, documentId: started.documentId,
    text: 'Why did you choose this approach?',
  });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');
  const discussion = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi&role=chat`);
  t.after(() => closeClient(discussion));
  sendFrame(discussion, { type: 'tool-call', id: 32, tool: 'get_structure', args: {}, workflow: 'plan', capabilityEpoch: ready.capabilityEpoch });
  const read = await studio.next((frame) => frame.type === 'tool-request' && frame.tool === 'get_structure');
  assert.equal(read.phase, 'awaiting-approval', 'ordinary discussion must preserve the reviewable plan');
  sendFrame(studio, { type: 'tool-response', id: read.id, ok: true, result: { revision: 4, paragraphs: [] } });
  assert.equal((await discussion.next((frame) => frame.type === 'tool-result' && frame.id === 32)).ok, true);
  sendFrame(discussion, { type: 'tool-call', id: 33, tool: 'present_implementation_plan', args: {
    ...implementationPlanArgs(), changeSummary: 'Clarified the document target.',
    sources: [{ title: 'Attached research', fileId: 'reference-1', chunkId: 'chunk-2' }],
  }, workflow: 'plan', capabilityEpoch: ready.capabilityEpoch });
  const revised = await studio.next((frame) => frame.type === 'plan-ready' && frame.planId !== ready.planId);
  assert.equal(revised.plan.revision, 2);
  assert.equal(revised.plan.previousPlanId, ready.planId);
  assert.equal(revised.plan.documentRevision, 4);
  assert.equal(revised.plan.sources[0].chunkId, 'chunk-2');
  assert.equal((await discussion.next((frame) => frame.type === 'tool-result' && frame.id === 33)).ok, true);
  sendFrame(studio, { type: 'chat-interrupt' });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  sendFrame(studio, { type: 'plan-approve', planId: revised.planId, documentRevision: 5 });
  await studio.next((frame) => frame.type === 'chat-error' && frame.code === 'STALE_PLAN_DOCUMENT');

  sendFrame(studio, {
    type: 'chat-user-message',
    threadId: started.threadId,
    documentId: started.documentId,
    text: 'implement the plan',
    documentRevision: 4,
  });
  const approved = await studio.next((frame) => frame.type === 'plan-approved');
  const implementing = await studio.next((frame) => frame.type === 'implementation-started');
  assert.equal(approved.planId, revised.planId);
  assert.equal(approved.phase, 'switching');
  assert.equal(implementing.planId, revised.planId);
  assert.equal(implementing.phase, 'implementing');
  assert.equal(implementing.latestPlan.execution.steps[0].status, 'pending');
  const turn = await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');
  const executor = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi&role=chat`);
  t.after(() => closeClient(executor));
  sendFrame(executor, { type: 'tool-call', id: 34, tool: 'update_todos', args: {
    planId: revised.planId, todos: [{ id: 'step-1', content: 'Check the target paragraph', status: 'in-progress', note: 'Checking the target paragraph.' }],
  }, workflow: 'plan', capabilityEpoch: implementing.capabilityEpoch });
  const progress = await studio.next((frame) => frame.type === 'plan-progress' && frame.latestPlan?.execution?.steps[0]?.status === 'in-progress');
  assert.equal(progress.latestPlan.execution.status, 'running');
  assert.equal((await executor.next((frame) => frame.type === 'tool-result' && frame.id === 34)).ok, true);
  sendFrame(studio, { type: 'chat-interrupt' });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  await studio.next((frame) => frame.type === 'plan-progress' && frame.latestPlan?.execution?.status === 'interrupted');
  sendFrame(studio, { type: 'chat-plan-execution-result', planId: revised.planId, turnId: turn.event.turnId, status: 'completed' });
  await studio.next((frame) => frame.type === 'chat-error' && frame.code === 'PLAN_EXECUTION_FAILED');
});

test('reconnect restores plan progress and prior review rejection survives a queued follow-up', { timeout: 40_000 }, async (t) => {
  const { port, completePi } = await startHub(t, { fakePi: true, controlledCompletion: true });
  const studioUrl = `ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=plan-reconnect&instance=plan-page`;
  const mcpUrl = `ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=plan-reconnect&agent=pi&role=chat`;
  const studio = await openClient(studioUrl);
  await studio.next((frame) => frame.type === 'welcome');
  sendFrame(studio, { type: 'chat-start', agent: 'pi', workflow: 'plan', threadId: 'plan-thread', documentId: 'plan-doc' });
  const started = await studio.next((frame) => frame.type === 'chat-started');
  sendFrame(studio, { type: 'chat-user-message', text: 'Draft the plan.', threadId: 'plan-thread', documentId: 'plan-doc' });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');
  const planner = await openClient(mcpUrl);
  t.after(() => closeClient(planner));
  sendFrame(planner, { type: 'tool-call', id: 1, tool: 'present_implementation_plan', args: implementationPlanArgs(),
    workflow: 'plan', capabilityEpoch: started.capabilityEpoch });
  const ready = await studio.next((frame) => frame.type === 'plan-ready');
  await planner.next((frame) => frame.type === 'tool-result' && frame.id === 1);
  sendFrame(studio, { type: 'chat-interrupt' });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  // 승인 시 고른 실행 권한: 잘못된 값은 승인 자체를 거절하고, 올바른 값은 구현 전환 전에 적용된다.
  sendFrame(studio, { type: 'plan-approve', planId: ready.planId, permissionProfile: 'everything' });
  await studio.next((frame) => frame.type === 'chat-error' && frame.code === 'INVALID_PERMISSION_PROFILE');
  sendFrame(studio, { type: 'chat-plan-approve', planId: ready.planId, permissionProfile: 'unrestricted' });
  const approvalFrames = [];
  do {
    approvalFrames.push(await studio.next((frame) => ['plan-approved', 'chat-permission-changed', 'implementation-started'].includes(frame.type)));
  } while (approvalFrames.at(-1).type !== 'implementation-started');
  assert.deepEqual(approvalFrames.map((frame) => frame.type), ['plan-approved', 'chat-permission-changed', 'implementation-started']);
  assert.equal(approvalFrames[1].permissionProfile, 'unrestricted');
  const implementing = approvalFrames[2];
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');
  const executor = await openClient(mcpUrl);
  t.after(() => closeClient(executor));
  await closeClient(studio);
  sendFrame(executor, { type: 'tool-call', id: 2, tool: 'update_todos',
    args: { planId: ready.planId, todos: [{ id: 'step-1', content: 'Replace the paragraph', status: 'completed' }] },
    workflow: 'plan', capabilityEpoch: implementing.capabilityEpoch });
  assert.equal((await executor.next((frame) => frame.type === 'tool-result' && frame.id === 2)).ok, true);
  const settled = once(executor.socket, 'close');
  completePi();
  await settled;

  const reconnected = await openClient(studioUrl);
  t.after(() => closeClient(reconnected));
  const frames = [];
  do { frames.push(await reconnected.next(() => true)); } while (frames.at(-1).type !== 'welcome');
  const progressIndex = frames.findIndex((frame) => frame.type === 'plan-progress');
  const endIndex = frames.findIndex((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  assert.ok(progressIndex >= 0 && endIndex > progressIndex, 'authoritative progress must precede terminal replay');
  assert.equal(frames[progressIndex].latestPlan.execution.status, 'awaiting-review');
  assert.equal(frames[progressIndex].latestPlan.execution.steps[0].status, 'completed');
  assert.equal(frames[endIndex].event.stopReason, 'completed');
  const reviewedTurnId = frames[endIndex].event.turnId;
  sendFrame(reconnected, { type: 'chat-plan-execution-result', planId: ready.planId,
    turnId: reviewedTurnId, status: 'awaiting-review' });
  await reconnected.next((frame) => frame.type === 'plan-progress' && frame.latestPlan.execution.status === 'awaiting-review');

  // Studio's editing lease remains idle until turn-start. A user can reject
  // the previous turn's edits just after dispatching this follow-up message.
  sendFrame(reconnected, { type: 'chat-user-message', text: 'Explain the changes.', threadId: 'plan-thread', documentId: 'plan-doc' });
  sendFrame(reconnected, { type: 'chat-plan-execution-result', planId: ready.planId,
    turnId: reviewedTurnId, status: 'blocked' });
  const blocked = await reconnected.next((frame) => frame.type === 'plan-progress' && frame.latestPlan.execution.status === 'blocked');
  assert.equal(blocked.latestPlan.execution.steps[0].status, 'pending');
  const followup = await reconnected.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');
  completePi();
  await reconnected.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  const followupResult = await reconnected.next((frame) => frame.type === 'plan-progress' && frame.latestPlan.execution.status === 'blocked');
  assert.equal(followupResult.latestPlan.execution.steps[0].status, 'pending', 'discussion cannot restore rolled-back work');
  sendFrame(reconnected, { type: 'chat-plan-execution-result', planId: ready.planId,
    turnId: followup.event.turnId, status: 'completed' });
  await reconnected.next((frame) => frame.type === 'chat-error' && frame.code === 'PLAN_EXECUTION_FAILED');
});

test('direct MCP questions survive Studio reload and settle atomically', { timeout: 40_000 }, async (t) => {
  const { port, stderr } = await startHub(t, { fakePi: true });
  const studioUrl = `ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=question-session`;
  const studio = await openClient(`${studioUrl}&instance=page-1`);
  await studio.next((frame) => frame.type === 'welcome');
  await startRunningChat(studio, 'pi');

  const mcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=question-session&agent=pi&role=chat`);
  t.after(() => closeClient(mcp));
  sendFrame(mcp, {
    type: 'tool-call', id: 17, tool: 'ask_user_question', args: questionArgs(), workflow: 'direct',
  });
  const requested = await studio.next((frame) => frame.type === 'user-question-requested');
  assert.equal(requested.interaction.source, 'mcp');
  assert.equal(requested.interaction.questions[0].options[1].id, 'option-2');

  const busyMcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=question-session&agent=pi&role=chat`);
  t.after(() => closeClient(busyMcp));
  sendFrame(busyMcp, {
    type: 'tool-call', id: 18, tool: 'ask_user_question', args: {
      questions: [{
        id: 'tone', header: 'Tone', question: 'Which tone?',
        options: [
          { label: 'Neutral', description: 'Use a neutral tone.' },
          { label: 'Warm', description: 'Use a warm tone.' },
        ],
      }],
    }, workflow: 'direct',
  });
  const busy = await busyMcp.next((frame) => frame.type === 'tool-result' && frame.id === 18);
  assert.equal(busy.ok, false);
  assert.equal(busy.error.code, 'INTERACTION_ALREADY_PENDING');

  await closeClient(studio);
  const reloaded = await openClient(`${studioUrl}&instance=page-2`);
  t.after(() => closeClient(reloaded));
  const welcome = await reloaded.next((frame) => frame.type === 'welcome');
  assert.equal(welcome.session.pendingUserQuestion.interactionId, requested.interaction.interactionId);
  const replay = await reloaded.next((frame) => frame.type === 'user-question-requested');
  assert.equal(replay.replayed, true);
  assert.equal(replay.interaction.interactionId, requested.interaction.interactionId);

  sendFrame(reloaded, {
    type: 'user-question-answer',
    interactionId: requested.interaction.interactionId,
    responseId: 'response-invalid',
    answers: { format: { selectedOptionIds: ['unknown'] } },
  });
  const invalid = await reloaded.next((frame) => frame.type === 'user-question-answer-result' && frame.responseId === 'response-invalid');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'INVALID_USER_QUESTION_ANSWER');

  const answer = {
    type: 'user-question-answer',
    interactionId: requested.interaction.interactionId,
    responseId: 'response-valid',
    answers: { format: { selectedOptionIds: ['option-2'] } },
  };
  sendFrame(reloaded, answer);
  const acknowledged = await reloaded.next((frame) => frame.type === 'user-question-answer-result' && frame.responseId === 'response-valid');
  const resolved = await reloaded.next((frame) => frame.type === 'user-question-resolved');
  const toolResult = await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 17);
  assert.equal(acknowledged.ok, true);
  assert.deepEqual(resolved.outcome, {
    status: 'answered',
    answers: { format: { selectedOptionIds: ['option-2'] } },
  });
  assert.deepEqual(toolResult, {
    v: 5,
    type: 'tool-result',
    id: 17,
    ok: true,
    result: {
      status: 'answered',
      answers: { format: { selected: ['Detailed'] } },
    },
  });

  sendFrame(reloaded, answer);
  const replayedReceipt = await reloaded.next((frame) => frame.type === 'user-question-answer-result' && frame.responseId === 'response-valid');
  assert.deepEqual(replayedReceipt, acknowledged);
  assert.doesNotMatch(stderr(), /response-valid|option-2/);
});

test('provider MCP writes are bound to one exact running turn', { timeout: 40_000 }, async (t) => {
  const { port, stderr } = await startHub(t, { fakePi: true });
  const sessionId = 'mcp-turn-ownership';
  const studio = await openClient(
    `ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=page-1`,
  );
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  const started = await startRunningChat(studio, 'pi');
  const mcp = await openClient(
    `ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi&role=chat`,
  );
  t.after(() => closeClient(mcp));
  const writeArgs = {
    expectedRevision: 0,
    sectionIdx: 0,
    paraIdx: 0,
    charOffset: 0,
    text: 'must stay inside the owning turn',
  };

  sendFrame(mcp, {
    type: 'tool-call', id: 61, tool: 'insert_text', args: writeArgs,
    workflow: 'direct', capabilityEpoch: started.capabilityEpoch,
  });
  const forwarded = await studio.next(
    (frame) => frame.type === 'tool-request' && frame.tool === 'insert_text',
  );
  assert.equal(forwarded.turnBound, true);
  assert.equal(typeof forwarded.providerTurnId, 'string');
  const mcpClosed = once(mcp.socket, 'close');
  sendFrame(studio, { type: 'chat-interrupt' });
  const cancelled = await studio.next(
    (frame) => frame.type === 'tool-request-cancel' && frame.id === forwarded.id,
  );
  assert.equal(cancelled.providerTurnId, forwarded.providerTurnId);
  const invalidated = await mcp.next(
    (frame) => frame.type === 'tool-result' && frame.id === 61,
  );
  assert.equal(invalidated.ok, false, stderr());
  assert.equal(invalidated.error.code, 'NO_ACTIVE_TURN');
  const [closeCode] = await mcpClosed;
  assert.equal(closeCode, 4003, 'the settled turn permanently retires its MCP socket');

  // A late Studio response cannot be rebound to the settled or a future turn.
  sendFrame(studio, {
    type: 'tool-response', id: forwarded.id, ok: true, result: { revision: 1 },
  });
  await assert.rejects(
    mcp.next((frame) => frame.type === 'tool-result' && frame.id === 61, 300),
    /Timed out waiting for websocket frame/,
  );

  const idleMcp = await openClient(
    `ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi&role=chat`,
  );
  const [idleCloseCode] = await once(idleMcp.socket, 'close');
  assert.equal(idleCloseCode, 4003, 'a socket opened between turns is never eligible later');
  await assert.rejects(
    studio.next((frame) => frame.type === 'tool-request' && frame.tool === 'insert_text', 300),
    /Timed out waiting for websocket frame/,
  );
});

test('URL provider and parent-task spoofing cannot bypass root question correlation', { timeout: 40_000 }, async (t) => {
  const { port } = await startHub(t, { fakePi: true });
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=question-loss&instance=page-1`);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  await startRunningChat(studio, 'pi');

  const subagent = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=question-loss&agent=pi&role=chat`);
  sendFrame(subagent, {
    type: 'tool-call', id: 20, tool: 'ask_user_question', args: questionArgs(),
    workflow: 'direct', parentTaskId: 'child-task',
  });
  const rejected = await subagent.next((frame) => frame.type === 'tool-result' && frame.id === 20);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'ROOT_INTERACTION_REQUIRED');
  await closeClient(subagent);

  assert.equal(
    await rejectedUpgrade(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=question-loss&agent=codex&role=chat`),
    401,
  );
});

test('a legitimate Pi root question expires on disconnect or a missing Studio', { timeout: 40_000 }, async (t) => {
  const { port } = await startHub(t, { fakePi: true });
  const sessionId = 'question-pi-disconnect';
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=page-1`);
  await studio.next((frame) => frame.type === 'welcome');
  await startRunningChat(studio, 'pi');
  const registration = await registerSession(port, sessionId);

  const mcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${registration.capabilities.mcp}&sessionId=${sessionId}&agent=pi&role=chat`);
  sendFrame(mcp, {
    type: 'tool-call', id: 22, tool: 'ask_user_question', args: questionArgs(), workflow: 'direct',
  });
  const requested = await studio.next((frame) => frame.type === 'user-question-requested');
  await closeClient(mcp);
  const resolved = await studio.next((frame) => (
    frame.type === 'user-question-resolved'
      && frame.interactionId === requested.interaction.interactionId
  ));
  assert.deepEqual(resolved.outcome, { status: 'expired', reason: 'provider-disconnected' });

  await closeClient(studio);
  const disconnected = await openClient(`ws://127.0.0.1:${port}/mcp?token=${registration.capabilities.mcp}&sessionId=${sessionId}&agent=pi&role=chat`);
  t.after(() => closeClient(disconnected));
  sendFrame(disconnected, {
    type: 'tool-call', id: 23, tool: 'ask_user_question', args: questionArgs(), workflow: 'direct',
  });
  const unavailable = await disconnected.next((frame) => frame.type === 'tool-result' && frame.id === 23);
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error.code, 'NO_STUDIO');
});

for (const stopType of ['chat-interrupt', 'chat-stop']) {
  test(`${stopType} cancels an active question`, { timeout: 40_000 }, async (t) => {
    const { port } = await startHub(t, { fakePi: true });
    const sessionId = `question-${stopType}`;
    const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=page-1`);
    t.after(() => closeClient(studio));
    await studio.next((frame) => frame.type === 'welcome');
    await startRunningChat(studio, 'pi');

    const mcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi&role=chat`);
    t.after(() => closeClient(mcp));
    sendFrame(mcp, {
      type: 'tool-call', id: 31, tool: 'ask_user_question', args: questionArgs(), workflow: 'direct',
    });
    const requested = await studio.next((frame) => frame.type === 'user-question-requested');
    sendFrame(studio, { type: stopType });

    const resolved = await studio.next((frame) => (
      frame.type === 'user-question-resolved'
        && frame.interactionId === requested.interaction.interactionId
    ));
    const toolResult = await mcp.next((frame) => frame.type === 'tool-result' && frame.id === 31);
    assert.deepEqual(resolved.outcome, { status: 'cancelled', reason: 'user-stop' });
    assert.equal(toolResult.ok, false);
    assert.equal(toolResult.error.code, 'USER_QUESTION_CANCELLED');
  });
}

test('hub shutdown expires an active question before closing transports', { timeout: 40_000 }, async (t) => {
  const { port } = await startHub(t, { fakePi: true });
  const sessionId = 'question-hub-shutdown';
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=page-1`);
  await studio.next((frame) => frame.type === 'welcome');
  await startRunningChat(studio, 'pi');

  const mcp = await openClient(`ws://127.0.0.1:${port}/mcp?token=${TOKEN}&sessionId=${sessionId}&agent=pi&role=chat`);
  sendFrame(mcp, {
    type: 'tool-call', id: 41, tool: 'ask_user_question', args: questionArgs(), workflow: 'direct',
  });
  const requested = await studio.next((frame) => frame.type === 'user-question-requested');
  const response = await fetch(`http://127.0.0.1:${port}/shutdown`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'x-rhwp-launch-id': 'hub-user-question-test-launch',
    },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'prepared');

  const resolved = await studio.next((frame) => (
    frame.type === 'user-question-resolved'
      && frame.interactionId === requested.interaction.interactionId
  ));
  assert.deepEqual(resolved.outcome, { status: 'expired', reason: 'hub-restarted' });
  await Promise.allSettled([closeClient(studio), closeClient(mcp)]);
});
