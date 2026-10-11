// mcp-stdio.mjs 를 실제 MCP 클라이언트로 띄우고 가짜 허브 WS 에 붙여, 프레임 크기·동시 호출
// 상한, 사용자 질문의 무기한 대기, 로그의 자격 증명 가림, 도구 계약을 프로세스 밖에서 확인한다.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketServer } from 'ws';
import { HUB_CAPABILITY_AUDIENCES, issueScopedHubToken } from '../hub-session-registry.mjs';
import { RHWP_TOOL_RULES, TOOL_DEFINITIONS, toolAnnotations } from '../tools.mjs';

const MCP_STDIO = fileURLToPath(new URL('../mcp-stdio.mjs', import.meta.url));
// 180 초 호출 타임아웃만 50 ms 로 줄이는 가짜 시계. 다른 타이머는 그대로 둔다.
const SHORT_CALL_TIMEOUT = 'data:text/javascript,'
  + 'const real=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...rest)=>real(fn,ms===180000?50:ms,...rest);';
const QUESTION_ARGS = {
  questions: [{
    id: 'q1', header: 'Pick', question: 'Pick one',
    options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }],
  }],
};

async function fakeHub(t) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const calls = [];
  const connections = [];
  let socket = null;
  wss.on('connection', (ws, request) => {
    socket = ws;
    connections.push(request);
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === 'tool-call') calls.push(frame);
    });
  });
  t.after(() => new Promise((resolve) => {
    for (const client of wss.clients) client.terminate();
    wss.close(resolve);
  }));
  return {
    port: wss.address().port,
    calls,
    connections,
    reply: (frame) => socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame)),
    async waitFor(predicate, label) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`timed out waiting for ${label}`);
    },
  };
}

async function startClient(t, hub, { wsUrl = `ws://127.0.0.1:${hub.port}/mcp`, execArgv = [] } = {}) {
  const sessionId = 'stdio-window';
  const token = issueScopedHubToken('master-token', sessionId, {
    generation: 7,
    audience: HUB_CAPABILITY_AUDIENCES.MCP,
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...execArgv, MCP_STDIO],
    env: { ...process.env, NODE_ENV: 'production', RHWP_AGENT_TOKEN: token, RHWP_WS_URL: wsUrl, RHWP_AGENT_NAME: 'codex' },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', (chunk) => { stderr += chunk; });
  const client = new Client({ name: 'mcp-stdio-tenancy', version: '1' });
  await client.connect(transport);
  t.after(() => client.close());
  return { client, token, sessionId, stderr: () => stderr };
}

function errorText(result) {
  assert.equal(result.isError, true, JSON.stringify(result));
  return result.content.map((block) => block.text).join('\n');
}

test('mcp stdio recovers its scoped session, sends protocol v5 identity, and keeps credentials out of logs', { timeout: 15_000 }, async (t) => {
  const hub = await fakeHub(t);
  const { token, stderr } = await startClient(t, hub, {
    wsUrl: `ws://user:url-password@127.0.0.1:${hub.port}/mcp?leak=query-secret`,
  });
  await hub.waitFor(() => hub.connections.length > 0 && /connected to hub/.test(stderr()), 'hub connection');

  const url = new URL(hub.connections[0].url, `ws://127.0.0.1:${hub.port}`);
  assert.equal(url.pathname, '/mcp');
  assert.equal(url.searchParams.get('token'), token);
  assert.equal(url.searchParams.get('sessionId'), 'stdio-window');
  assert.equal(url.searchParams.get('agent'), 'codex');
  assert.match(stderr(), /session=stdio-window/);
  assert.doesNotMatch(stderr(), /query-secret|url-password|token=|user:/);
  assert.ok(!stderr().includes(token));
});

test('MCP client refuses hub frames over 8 MiB instead of buffering them', { timeout: 20_000 }, async (t) => {
  const hub = await fakeHub(t);
  const { client } = await startClient(t, hub);
  const pending = client.callTool({ name: 'get_document_info', arguments: {} });
  await hub.waitFor(() => hub.calls.length === 1, 'tool call');
  const oversized = JSON.stringify({
    v: 5, type: 'tool-result', id: hub.calls[0].id, ok: true, result: { text: 'x'.repeat(8 * 1024 * 1024) },
  });
  hub.reply(oversized);
  assert.match(errorText(await pending), /HUB_UNAVAILABLE/);

  // 상한 아래 프레임은 새 연결로 그대로 받는다.
  const next = client.callTool({ name: 'get_document_info', arguments: {} });
  await hub.waitFor(() => hub.calls.length === 2, 'second tool call');
  hub.reply({ v: 5, type: 'tool-result', id: hub.calls[1].id, ok: true, result: { text: 'small' } });
  const result = await next;
  assert.notEqual(result.isError, true, JSON.stringify(result));
});

test('MCP client rejects the 65th concurrent tool call', { timeout: 20_000 }, async (t) => {
  const hub = await fakeHub(t);
  const { client } = await startClient(t, hub);
  const held = Array.from({ length: 64 }, () => client.callTool({ name: 'get_document_info', arguments: {} }));
  await hub.waitFor(() => hub.calls.length === 64, '64 in-flight calls');
  assert.match(errorText(await client.callTool({ name: 'get_document_info', arguments: {} })), /TOO_MANY_INFLIGHT_CALLS/);
  assert.equal(hub.calls.length, 64);
  for (const call of hub.calls) hub.reply({ v: 5, type: 'tool-result', id: call.id, ok: true, result: {} });
  await Promise.all(held);
});

test('MCP user questions outlive the ordinary tool-call timeout', { timeout: 20_000 }, async (t) => {
  const hub = await fakeHub(t);
  const { client } = await startClient(t, hub, { execArgv: ['--import', SHORT_CALL_TIMEOUT] });

  // 일반 도구는 (줄인) 타임아웃에 걸린다.
  assert.match(errorText(await client.callTool({ name: 'get_document_info', arguments: {} })), /TOOL_TIMEOUT/);

  const question = client.callTool({ name: 'ask_user_question', arguments: QUESTION_ARGS });
  await hub.waitFor(() => hub.calls.some((call) => call.tool === 'ask_user_question'), 'question call');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const call = hub.calls.find((entry) => entry.tool === 'ask_user_question');
  hub.reply({ v: 5, type: 'tool-result', id: call.id, ok: true, result: { answers: [{ id: 'q1', selected: ['A'] }] } });
  const result = await question;
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.match(result.content[0].text, /"selected"/);
});

test('MCP server sends the shared tool rules once and annotates every tool by category', { timeout: 15_000 }, async (t) => {
  const hub = await fakeHub(t);
  const { client } = await startClient(t, hub);
  assert.equal(client.getInstructions(), RHWP_TOOL_RULES);
  const categories = new Map(TOOL_DEFINITIONS.map((definition) => [definition.name, definition.category]));
  const { tools } = await client.listTools();
  assert.ok(tools.length > 20);
  for (const tool of tools) {
    const category = categories.get(tool.name);
    assert.ok(category, tool.name);
    assert.deepEqual(tool.annotations, toolAnnotations(category), tool.name);
    if (category === 'document-write') assert.equal(tool.annotations.destructiveHint, false, tool.name);
  }
});
