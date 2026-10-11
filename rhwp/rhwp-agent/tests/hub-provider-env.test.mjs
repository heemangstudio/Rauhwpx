// 프로바이더 CLI 는 허브의 마스터 토큰·실행 id·소유자 연결 정보를 물려받지 않는다.
// 물려받으면 에이전트의 Bash 도구가 허브 HTTP 엔드포인트(POST /sessions/:id 의 다른 세션
// 능력, /shutdown, /healthz 세션 목록)를 마스터 권한으로 부를 수 있다. MCP 서버는 자기
// 세션 범위 토큰을 설정으로 따로 받아 그대로 허브에 붙는다.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { writeFakeCliBin } from './fake-cli-bin.mjs';
import {
  HUB_TEST_LAUNCH_ID,
  HUB_TEST_TOKEN,
  closeClient,
  openClient,
  sendFrame,
  startHub,
  waitForPath,
} from './hub-harness.mjs';
import { withoutHubPrivateEnv } from '../process-tree.mjs';
import { createCliSetupManager } from '../cli-setup-manager.mjs';

const DEV_TOKEN = 'hub-dev-master-PLANTED0123';

/**
 * A Claude CLI for the Agent SDK transport: it answers the SDK's control
 * requests, starts the rhwp MCP server from `--mcp-config` the way Claude Code
 * does (its own environment plus the config's `env`), calls one tool through
 * it and writes what it saw to `reportPath`.
 */
function fakeClaudeSource(reportPath) {
  return `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { createInterface } = require('node:readline');
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('2.1.235 (Claude Code)'); process.exit(0); }
if (argv[0] && !argv[0].startsWith('-')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
const valueOf = (flag) => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined; };
const sessionId = valueOf('--session-id') || valueOf('--resume') || 'fake-claude-session';
const emit = (frame) => process.stdout.write(JSON.stringify({ session_id: sessionId, ...frame }) + '\\n');
const rhwpEnv = (env) => Object.fromEntries(Object.entries(env).filter(([name]) => name.toUpperCase().startsWith('RHWP_')));
const raw = valueOf('--mcp-config');
const server = raw ? JSON.parse(raw.trim().startsWith('{') ? raw : fs.readFileSync(raw, 'utf8')).mcpServers.rhwp : null;

async function callTool() {
  const mcp = spawn(server.command, server.args || [], { env: { ...process.env, ...(server.env || {}) }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  createInterface({ input: mcp.stdout }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  let nextId = 1;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
  });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.235' } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\\n');
  const response = await rpc('tools/call', { name: 'get_document_info', arguments: {} });
  mcp.kill('SIGTERM');
  return response;
}

async function runTurn() {
  emit({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-5', tools: [], mcp_servers: [{ name: 'rhwp', status: 'connected' }] });
  const tool = await callTool();
  fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({
    provider: rhwpEnv(process.env),
    mcpConfigToken: server.env.RHWP_AGENT_TOKEN,
    tool,
  }));
  emit({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'checked' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'checked', num_turns: 1,
    modelUsage: { 'claude-sonnet-4-5': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 } } });
}

let queue = Promise.resolve();
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type === 'control_request') {
    const response = message.request?.subtype === 'initialize'
      ? { commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models: [], account: {} }
      : {};
    process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } }) + '\\n');
    return;
  }
  if (message.type === 'user') queue = queue.then(runTurn);
});
lines.on('close', () => setTimeout(() => process.exit(0), 200));
process.on('SIGTERM', () => process.exit(0));
`;
}

test('a provider started by the hub gets neither the hub token, launch id nor owner wiring, and its MCP server still connects', {
  timeout: 60_000,
  skip: process.platform === 'win32' && 'the Agent SDK spawns the CLI directly and cannot run a .cmd fake',
}, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-hub-provider-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binDir = path.join(root, 'bin');
  const reportPath = path.join(root, 'report.json');
  mkdirSync(path.join(root, 'cli'), { recursive: true });
  // An app-managed Claude API key (the pre-keychain config file), so the hub lets the turn start.
  // The hub checks it against Anthropic at boot; offline the check is inconclusive and keeps it.
  writeFileSync(path.join(root, 'cli', 'config.json'), JSON.stringify({ claude: { key: 'test-placeholder-claude-key' } }));
  const offline = path.join(root, 'offline-anthropic.mjs');
  writeFileSync(offline, `const fetch = globalThis.fetch;
globalThis.fetch = (url, init) => String(url?.url ?? url).startsWith('https://api.anthropic.com/')
  ? Promise.reject(new Error('offline test')) : fetch(url, init);
`);
  writeFakeCliBin(binDir, 'claude', fakeClaudeSource(reportPath));

  const hub = await startHub(t, {
    prefix: 'rhwp-hub-provider-env-',
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      RHWP_CLI_DIR: path.join(root, 'cli'),
      RHWP_AGENT_DEV_TOKEN: DEV_TOKEN,
      RHWP_OWNER_PID: String(process.pid),
      RHWP_SECRET_BROKER: 'ipc',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(offline).href}`.trim(),
    },
  });
  const sessionId = 'provider-env-window';
  const studio = await openClient(
    `ws://127.0.0.1:${hub.port}/studio?token=${HUB_TEST_TOKEN}&sessionId=${sessionId}&instance=page-1`,
  );
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  sendFrame(studio, {
    type: 'chat-start', agent: 'claude', model: 'claude-sonnet-4-5', workflow: 'direct',
    threadId: 'thread-provider-env', documentId: 'doc-provider-env',
  });
  const started = await studio.next((frame) => frame.type === 'chat-started' || frame.type === 'error', 20_000);
  assert.equal(started.type, 'chat-started', JSON.stringify(started));
  sendFrame(studio, {
    type: 'chat-user-message', threadId: started.threadId, documentId: started.documentId, text: 'Check the document.',
  });

  // The provider's MCP server reaches this window with its own scoped token.
  const request = await studio.next((frame) => frame.type === 'tool-request' && frame.tool === 'get_document_info', 30_000);
  sendFrame(studio, { type: 'tool-response', id: request.id, ok: true, result: { revision: 7, pageCount: 1 } });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end', 30_000);
  await waitForPath(reportPath);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));

  for (const name of ['RHWP_AGENT_TOKEN', 'RHWP_AGENT_DEV_TOKEN', 'RHWP_LAUNCH_ID', 'RHWP_OWNER_PID', 'RHWP_SECRET_BROKER']) {
    assert.equal(name in report.provider, false, `${name} is not in the provider's environment: ${hub.stderr()}`);
  }
  const leaked = JSON.stringify(report.provider);
  for (const secret of [HUB_TEST_TOKEN, HUB_TEST_LAUNCH_ID, DEV_TOKEN]) {
    assert.equal(leaked.includes(secret), false, 'no hub secret under any other name');
  }
  assert.equal(report.provider.RHWP_SESSION_ID, sessionId, 'the session id the CLI needs is still there');
  assert.equal(typeof report.mcpConfigToken, 'string');
  assert.notEqual(report.mcpConfigToken, HUB_TEST_TOKEN, 'the MCP server gets a scoped token, not the master token');
  assert.equal(report.tool.error, undefined, JSON.stringify(report.tool));
  assert.match(JSON.stringify(report.tool.result), /pageCount/, 'the tool call went through the hub to Studio');

  // The master token never authenticates a request carrying a provider's token.
  const owner = await fetch(`http://127.0.0.1:${hub.port}/sessions/other-window`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${report.mcpConfigToken}`, 'X-Rhwp-Launch-Id': HUB_TEST_LAUNCH_ID },
  });
  assert.equal(owner.status, 401);
});

test('CLI setup children (login, version checks, npm installs) start without the hub secrets', async () => {
  const baseEnv = {
    PATH: '/usr/bin',
    HOME: '/home/user',
    RHWP_AGENT_TOKEN: 'MASTER',
    rhwp_agent_dev_token: 'DEV',
    RHWP_LAUNCH_ID: 'LAUNCH',
    RHWP_OWNER_PID: '1',
    RHWP_OWNER_IPC: '1',
    RHWP_SECRET_BROKER: 'ipc',
    RHWP_WORK_DIR: '/work',
  };
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cli-setup-env-'));
  try {
    const manager = createCliSetupManager({ rootDir: root, baseEnv, readClaudeLogin: async () => null });
    for (const agent of ['claude', 'codex']) {
      const env = manager.envFor(agent);
      assert.deepEqual(Object.keys(env).filter((name) => name.toUpperCase().startsWith('RHWP_')), ['RHWP_WORK_DIR'], agent);
      assert.equal(env.PATH, '/usr/bin');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(withoutHubPrivateEnv(baseEnv), { PATH: '/usr/bin', HOME: '/home/user', RHWP_WORK_DIR: '/work' });
});
