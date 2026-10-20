// 실제 허브의 /mcp-http 를 Streamable HTTP MCP 클라이언트로 부른다. 도구 호출이 /mcp WebSocket 과
// 같은 신원 검사·턴 묶기·revision 오류·사용자 질문 경로를 지나는지 확인한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  HUB_TEST_LAUNCH_ID as LAUNCH_ID,
  HUB_TEST_TOKEN as TOKEN,
  closeClient,
  openClient,
  registerSession,
  sendFrame,
  startHub,
} from './hub-harness.mjs';

function mcpUrl(port, sessionId, settings = {}) {
  const url = new URL(`http://127.0.0.1:${port}/mcp-http`);
  for (const [key, value] of Object.entries({
    RHWP_AGENT_NAME: 'pi',
    RHWP_AGENT_ROLE: 'chat',
    RHWP_SESSION_ID: sessionId,
    RHWP_AGENT_WORKFLOW: 'direct',
    RHWP_AGENT_PHASE: 'direct',
    ...settings,
  })) url.searchParams.set(key, String(value));
  return url;
}

async function connectMcp(t, port, sessionId, { token = TOKEN, settings } = {}) {
  const client = new Client({ name: 'hub-mcp-http-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl(port, sessionId, settings), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  t.after(() => client.close());
  return client;
}

async function startRunningChat(studio, port) {
  // 허브는 MCP SDK 를 첫 /mcp-http 요청 때 읽는다. 턴을 열기 전에 읽혀 두어 연결 시간을 줄인다.
  await fetch(`http://127.0.0.1:${port}/mcp-http`, { method: 'POST' });
  sendFrame(studio, { type: 'chat-start', agent: 'pi', threadId: 'thread-http', documentId: 'document-http' });
  const started = await studio.next((frame) => frame.type === 'chat-started');
  sendFrame(studio, {
    type: 'chat-user-message', threadId: started.threadId, documentId: started.documentId, text: 'Edit the document.',
  });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');
  return started;
}

/** 세션을 닫아 허브가 공급자 프로세스를 정리하게 한다 — 테스트 허브는 신호로 바로 끝나 자식을 남길 수 있다. */
async function closeSession(port, sessionId) {
  const response = await fetch(`http://127.0.0.1:${port}/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}`, 'X-Rhwp-Launch-Id': LAUNCH_ID },
  });
  assert.equal(response.status, 200);
}

function errorText(result) {
  assert.equal(result.isError, true, JSON.stringify(result));
  return result.content.map((block) => block.text).join('\n');
}

test('hub HTTP MCP writes reach Studio bound to the running turn and report revision conflicts', { timeout: 40_000 }, async (t) => {
  const { port, stderr } = await startHub(t, { fakePi: true, prefix: 'rhwp-hub-mcp-http-' });
  const sessionId = 'mcp-http-window';
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=page-1`);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  const started = await startRunningChat(studio, port);
  const client = await connectMcp(t, port, sessionId, {
    settings: { RHWP_CAPABILITY_EPOCH: started.capabilityEpoch },
  });
  const write = { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'over http' };

  const applied = client.callTool({ name: 'insert_text', arguments: { ...write, expectedRevision: 0 } });
  const forwarded = await studio.next((frame) => frame.type === 'tool-request' && frame.tool === 'insert_text');
  assert.equal(forwarded.turnBound, true);
  assert.equal(forwarded.args.expectedRevision, 0);
  sendFrame(studio, { type: 'tool-response', id: forwarded.id, ok: true, result: { revision: 1 } });
  const result = await applied;
  assert.notEqual(result.isError, true, `${JSON.stringify(result)} ${stderr()}`);
  assert.equal(JSON.parse(result.content[0].text).revision, 1);

  const stale = client.callTool({ name: 'insert_text', arguments: { ...write, expectedRevision: 0 } });
  const staleRequest = await studio.next((frame) => frame.type === 'tool-request' && frame.tool === 'insert_text');
  sendFrame(studio, {
    type: 'tool-response', id: staleRequest.id, ok: false,
    error: { code: 'REVISION_MISMATCH', message: 'expected revision 0 but document is at 1' },
  });
  assert.match(errorText(await stale), /^REVISION_MISMATCH: /);

  // 턴이 끝나면 걸려 있던 쓰기는 NO_ACTIVE_TURN 으로 끝나고 Studio 요청은 취소된다.
  const pending = client.callTool({ name: 'insert_text', arguments: { ...write, expectedRevision: 1 } });
  const held = await studio.next((frame) => frame.type === 'tool-request' && frame.tool === 'insert_text');
  sendFrame(studio, { type: 'chat-interrupt' });
  await studio.next((frame) => frame.type === 'tool-request-cancel' && frame.id === held.id);
  assert.match(errorText(await pending), /^NO_ACTIVE_TURN: /);
  await closeSession(port, sessionId);
});

test('hub HTTP MCP questions wait for the user and return the answer', { timeout: 40_000 }, async (t) => {
  const { port } = await startHub(t, { fakePi: true, prefix: 'rhwp-hub-mcp-http-' });
  const sessionId = 'mcp-http-question';
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=page-1`);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  await startRunningChat(studio, port);
  const client = await connectMcp(t, port, sessionId);
  const question = client.callTool({ name: 'ask_user_question', arguments: {
    questions: [{
      id: 'format', header: 'Format', question: 'Which format?',
      options: [{ label: 'Brief', description: 'Short.' }, { label: 'Detailed', description: 'Long.' }],
    }],
  } });
  const requested = await studio.next((frame) => frame.type === 'user-question-requested');
  assert.equal(requested.interaction.source, 'mcp');
  // 일반 HTTP 응답이 끝날 시간보다 오래 기다려도 답이 그대로 돌아온다.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  sendFrame(studio, {
    type: 'user-question-answer',
    interactionId: requested.interaction.interactionId,
    responseId: 'answer-1',
    answers: { format: { selectedOptionIds: ['option-2'] } },
  });
  const result = await question;
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.content[0].text), {
    status: 'answered',
    answers: { format: { selected: ['Detailed'] } },
  });
  await closeSession(port, sessionId);
});

test('hub HTTP MCP refuses wrong, other-session and stale-identity tokens', { timeout: 40_000 }, async (t) => {
  const { port } = await startHub(t, { fakePi: true, prefix: 'rhwp-hub-mcp-http-' });
  const sessionId = 'mcp-http-auth';
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=page-1`);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  await startRunningChat(studio, port);

  await assert.rejects(connectMcp(t, port, sessionId, { token: 'not-a-hub-token' }));
  const other = await registerSession(port, 'mcp-http-other');
  await assert.rejects(connectMcp(t, port, sessionId, { token: other.capabilities.mcp }), 'another session token');
  await assert.rejects(
    connectMcp(t, port, sessionId, { settings: { RHWP_AGENT_NAME: 'claude' } }),
    'an agent that is not the active provider',
  );
  const unauthorized = await fetch(mcpUrl(port, sessionId), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(unauthorized.status, 401);
  await closeSession(port, sessionId);
});
