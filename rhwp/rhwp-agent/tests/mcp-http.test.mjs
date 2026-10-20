// 허브의 HTTP MCP(/mcp-http)를 실제 MCP 클라이언트(Streamable HTTP)로 부른다. 허브 쪽은 가상
// 소켓을 받아 /mcp 프레임으로 답하는 가짜로 대신하고, 도구 목록이 mcp-stdio 와 같은지, 신원·토큰
// 검사, documentId·이미지 경로 가드, 끊긴 연결의 재연결, 세션 정리를 프로세스 밖에서 확인한다.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createMcpHttpEndpoint, MCP_HTTP_PATH } from '../mcp-http.mjs';
import { RHWP_TOOL_RULES } from '../tools.mjs';

const MCP_STDIO = fileURLToPath(new URL('../mcp-stdio.mjs', import.meta.url));
const GOOD_TOKEN = 'scoped-provider-token';
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** /mcp 프레임으로 답하는 가짜 허브와 그 앞의 HTTP 엔드포인트. */
async function startEndpoint(t, { reply = (frame) => ({ ok: true, result: { tool: frame.tool } }), now } = {}) {
  const accepted = [];
  const sockets = [];
  const calls = [];
  const logs = [];
  const endpoint = createMcpHttpEndpoint({
    acceptSocket(identity, sock) {
      if (identity.token !== GOOD_TOKEN || identity.sessionId !== 'window-1') throw new Error('unauthorized');
      accepted.push(identity);
      sockets.push(sock);
      sock.on('message', (data) => {
        const frame = JSON.parse(String(data));
        if (frame.type !== 'tool-call') return;
        calls.push(frame);
        const answer = reply(frame);
        if (answer) sock.send(JSON.stringify({ v: 5, type: 'tool-result', id: frame.id, ...answer }));
      });
    },
    log: (message) => logs.push(message),
    ...(now ? { now } : {}),
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== MCP_HTTP_PATH) {
      res.writeHead(404).end();
      return;
    }
    void endpoint.handle(req, res, url);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    endpoint.closeAll();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { endpoint, port: server.address().port, accepted, sockets, calls, logs };
}

function endpointUrl(port, settings = {}) {
  const url = new URL(`http://127.0.0.1:${port}${MCP_HTTP_PATH}`);
  for (const [key, value] of Object.entries({
    RHWP_AGENT_NAME: 'claude',
    RHWP_SESSION_ID: 'window-1',
    RHWP_AGENT_WORKFLOW: 'direct',
    RHWP_AGENT_PHASE: 'direct',
    RHWP_CAPABILITY_EPOCH: '3',
    ...settings,
  })) url.searchParams.set(key, value);
  return url;
}

async function connect(t, port, { token = GOOD_TOKEN, settings } = {}) {
  const transport = new StreamableHTTPClientTransport(endpointUrl(port, settings), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'mcp-http-test', version: '1' });
  await client.connect(transport);
  t.after(() => client.close());
  return { client, transport };
}

async function listViaStdio(t, env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_STDIO],
    env: { ...process.env, NODE_ENV: 'production', RHWP_AGENT_TOKEN: GOOD_TOKEN, RHWP_WS_URL: 'ws://127.0.0.1:9/mcp', ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'mcp-stdio-parity', version: '1' });
  await client.connect(transport);
  t.after(() => client.close());
  return { tools: (await client.listTools()).tools, instructions: client.getInstructions() };
}

function errorText(result) {
  assert.equal(result.isError, true, JSON.stringify(result));
  return result.content.map((block) => block.text).join('\n');
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('HTTP MCP lists exactly the tools, schemas, annotations and rules that mcp-stdio lists', { timeout: 30_000 }, async (t) => {
  const { port } = await startEndpoint(t);
  for (const settings of [
    { RHWP_AGENT_WORKFLOW: 'direct', RHWP_AGENT_PHASE: 'direct' },
    { RHWP_AGENT_WORKFLOW: 'question', RHWP_AGENT_PHASE: 'questioning', RHWP_PROJECT_WRITES: '0' },
    { RHWP_AGENT_WORKFLOW: 'plan', RHWP_AGENT_PHASE: 'planning', RHWP_REQUESTABLE_TOOLS: '1', RHWP_DOCUMENT_LINK: '1' },
  ]) {
    const { client } = await connect(t, port, { settings });
    const http = { tools: (await client.listTools()).tools, instructions: client.getInstructions() };
    const stdio = await listViaStdio(t, { RHWP_SESSION_ID: 'window-1', RHWP_AGENT_NAME: 'claude', ...settings });
    assert.equal(http.instructions, RHWP_TOOL_RULES);
    assert.equal(http.instructions, stdio.instructions);
    assert.ok(http.tools.length > 20);
    assert.deepEqual(http.tools, stdio.tools, `tool list for ${settings.RHWP_AGENT_WORKFLOW}`);
  }
});

test('HTTP MCP forwards calls with the provider identity and reconnects after the hub retires a socket', { timeout: 20_000 }, async (t) => {
  const hub = await startEndpoint(t);
  const { client } = await connect(t, hub.port);
  await waitFor(() => hub.accepted.length === 1, 'eager hub connection');
  assert.deepEqual(hub.accepted[0], {
    token: GOOD_TOKEN,
    sessionId: 'window-1',
    agent: 'claude',
    role: 'chat',
    workerJobId: null,
    workflow: 'direct',
    capabilityEpoch: '3',
    maxPayload: 8 * 1024 * 1024,
  });

  const first = await client.callTool({ name: 'get_document_info', arguments: {} });
  assert.notEqual(first.isError, true, JSON.stringify(first));
  assert.deepEqual(JSON.parse(first.content[0].text), { tool: 'get_document_info' });
  assert.equal(hub.calls[0].workflow, 'direct');
  assert.equal(hub.calls[0].capabilityEpoch, '3');

  // 턴이 끝나면 허브가 소켓을 4003 으로 닫는다. 다음 호출은 새 소켓으로 다시 인증해 붙는다.
  hub.sockets[0].close(4003, 'provider turn settled');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await client.callTool({ name: 'get_text_range', arguments: { sectionIdx: 0, paraIdx: 0 } });
  assert.notEqual(second.isError, true, JSON.stringify(second));
  assert.equal(hub.accepted.length, 2);
  assert.equal(hub.calls.length, 2);
});

test('HTTP MCP reports hub errors such as a stale revision as tool errors', { timeout: 20_000 }, async (t) => {
  const hub = await startEndpoint(t, {
    reply: (frame) => (frame.args.expectedRevision === 4
      ? { ok: true, result: { revision: 5 } }
      : { ok: false, error: { code: 'REVISION_MISMATCH', message: 'document is at revision 5' } }),
  });
  const { client } = await connect(t, hub.port);
  const write = { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x' };
  const ok = await client.callTool({ name: 'insert_text', arguments: { ...write, expectedRevision: 4 } });
  assert.deepEqual(JSON.parse(ok.content[0].text), { revision: 5 });
  const stale = await client.callTool({ name: 'insert_text', arguments: { ...write, expectedRevision: 3 } });
  assert.equal(errorText(stale), 'REVISION_MISMATCH: document is at revision 5');
});

test('HTTP MCP refuses a wrong token, a foreign session token, browser origins and sessionless requests', { timeout: 20_000 }, async (t) => {
  const hub = await startEndpoint(t);
  await assert.rejects(connect(t, hub.port, { token: 'wrong-token' }));
  await assert.rejects(connect(t, hub.port, { settings: { RHWP_SESSION_ID: 'window-2' } }));
  assert.equal(hub.endpoint.sessionCount(), 0);

  const { transport } = await connect(t, hub.port);
  const sessionId = transport.sessionId;
  assert.ok(sessionId);
  const url = endpointUrl(hub.port);
  const list = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} });
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
  };
  const stolen = await fetch(url, {
    method: 'POST', body: list,
    headers: { ...headers, authorization: 'Bearer another-token', 'mcp-session-id': sessionId },
  });
  assert.equal(stolen.status, 401);
  const fromPage = await fetch(url, {
    method: 'POST', body: list,
    headers: { ...headers, authorization: `Bearer ${GOOD_TOKEN}`, 'mcp-session-id': sessionId, origin: 'https://example.com' },
  });
  assert.equal(fromPage.status, 403);
  const sessionless = await fetch(url, {
    method: 'POST', body: list, headers: { ...headers, authorization: `Bearer ${GOOD_TOKEN}` },
  });
  assert.equal(sessionless.status, 400);
  const unknown = await fetch(url, {
    method: 'POST', body: list,
    headers: { ...headers, authorization: `Bearer ${GOOD_TOKEN}`, 'mcp-session-id': 'not-a-session' },
  });
  assert.equal(unknown.status, 404);
});

test('HTTP MCP rejects documentId on write tools before the hub sees the call', { timeout: 20_000 }, async (t) => {
  const hub = await startEndpoint(t);
  const { client } = await connect(t, hub.port);
  const write = await client.callTool({ name: 'insert_text', arguments: {
    expectedRevision: 1, sectionIdx: 0, paraIdx: 0, text: 'x', documentId: 'document-other',
  } });
  assert.match(errorText(write), /^INVALID_ARGS: documentId is read-only; writes target the live document$/);
  assert.equal(hub.calls.length, 0);
  const read = await client.callTool({ name: 'get_structure', arguments: { documentId: 'document-other' } });
  assert.notEqual(read.isError, true, JSON.stringify(read));
  assert.equal(hub.calls[0].args.documentId, 'document-other');
});

test('HTTP MCP insert_image reads files only inside the session image roots', { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-mcp-http-image-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'rhwp-mcp-http-outside-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  writeFileSync(path.join(root, 'inside.png'), PNG_1X1);
  writeFileSync(path.join(outside, 'outside.png'), PNG_1X1);
  const hub = await startEndpoint(t);
  const { client } = await connect(t, hub.port, { settings: { RHWP_IMAGE_ROOTS: root } });
  const base = { expectedRevision: 1, sectionIdx: 0, paraIdx: 0, charOffset: 0 };

  const refused = await client.callTool({ name: 'insert_image', arguments: { ...base, imagePath: path.join(outside, 'outside.png') } });
  assert.match(errorText(refused), /^INVALID_ARGS: imagePath must be inside an approved readable root/);
  assert.equal(hub.calls.length, 0, 'a refused path never reaches the hub');

  const inserted = await client.callTool({ name: 'insert_image', arguments: { ...base, imagePath: path.join(root, 'inside.png') } });
  assert.notEqual(inserted.isError, true, JSON.stringify(inserted));
  assert.equal(hub.calls.length, 1);
  assert.equal(hub.calls[0].args.imageBase64, PNG_1X1.toString('base64'));
  assert.equal(hub.calls[0].args.imagePath, undefined, 'the hub gets bytes, not the local path');
});

test('HTTP MCP sessions close on DELETE and after sitting idle', { timeout: 20_000 }, async (t) => {
  let clock = 1_000;
  const hub = await startEndpoint(t, { now: () => clock });
  const first = await connect(t, hub.port);
  const second = await connect(t, hub.port);
  assert.equal(hub.endpoint.sessionCount(), 2);

  await first.transport.terminateSession();
  await waitFor(() => hub.endpoint.sessionCount() === 1, 'DELETE disposal');

  // 열린 GET 스트림이 없는 세션도 TTL 전에는 남는다.
  await second.client.callTool({ name: 'get_document_info', arguments: {} });
  hub.endpoint.sweepIdleSessions();
  assert.equal(hub.endpoint.sessionCount(), 1);
  await second.transport.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  clock += 31 * 60 * 1000;
  hub.endpoint.sweepIdleSessions();
  assert.equal(hub.endpoint.sessionCount(), 0);
  await waitFor(() => hub.sockets.every((sock) => sock.readyState === 3), 'hub sockets closed');
});
