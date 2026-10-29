// 실제 허브로 ask_chatgpt·ask_claude 의 켜기·채팅 권한·사용 가능 게이트와 도구 카드 결과 전달을 확인한다.
// 이 허브에는 데스크톱 네이티브 브라우저가 없으므로 웹 개발 환경(Studio dev)과 같다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { HUB_TOKEN, connect, startLiveHub } from './live-hub-fixture.mjs';

async function holdTurn(t, hub, started) {
  hub.message('HOLD');
  await hub.studio.next((frame) => frame.type === 'agent-event' && frame.event.text === 'HOLD_READY');
  const mcp = await connect(`ws://127.0.0.1:${hub.port}/mcp?token=${HUB_TOKEN}&sessionId=${hub.sessionId}&agent=pi`);
  t.after(() => mcp.socket.close());
  let id = 0;
  const call = async (tool, args, extra = {}) => {
    const callId = ++id;
    mcp.send({ type: 'tool-call', id: callId, tool, args, workflow: started.workflow, capabilityEpoch: started.capabilityEpoch, ...extra });
    return mcp.next((frame) => frame.type === 'tool-result' && frame.id === callId);
  };
  return { call };
}

let browserRequestId = 0;
async function browserRequest(hub, action, args = {}) {
  const requestId = `chatgpt-${++browserRequestId}`;
  hub.studio.send({ type: 'browser-request', requestId, action, args });
  const frame = await hub.studio.next((entry) => entry.type === 'browser-response' && entry.requestId === requestId);
  if (frame.error) throw Object.assign(new Error(frame.error.message), frame.error);
  return frame.result;
}

for (const [service, tool, code] of [['chatgpt', 'ask_chatgpt', 'CHATGPT'], ['claude', 'ask_claude', 'CLAUDE']]) test(`${tool} is off by default, asks once per chat and is unavailable without the desktop browser`, { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t);
  const started = await hub.start();
  const { call } = await holdTurn(t, hub, started);

  assert.deepEqual(await browserRequest(hub, `${service}.status`), { enabled: false, available: false, projectUrl: null, signedIn: null });
  const off = await call(tool, { question: '내가 좋아하는 말투는?' });
  assert.equal(off.error.code, `${code}_DISABLED`);
  // 도구 카드는 허브가 보낸 결과(여기서는 오류)를 그린다.
  const card = await hub.studio.next((frame) => frame.type === 'hub-tool-executed');
  assert.deepEqual([card.tool, card.ok, card.error.code, card.args.question], [tool, false, `${code}_DISABLED`, '내가 좋아하는 말투는?']);

  await assert.rejects(browserRequest(hub, `${service}.configure`, { enabled: 'yes' }), { code: 'INVALID_ARGS' });
  assert.equal((await browserRequest(hub, `${service}.configure`, { enabled: true })).enabled, true);
  // 켜도 이 허브는 앱 안 네이티브 브라우저가 없다(웹 개발·관리형 브라우저).
  assert.equal((await call(tool, { question: 'q' })).error.code, `${code}_UNAVAILABLE`);

  // 채팅 권한은 허브만 확인하므로 턴 중에도 바로 부여된다. 하위 작업은 쓸 수 없다.
  assert.equal((await call('request_permission', { capability: service, reason: 'Check the preferred tone.' })).result.status, 'pending');
  const requested = await hub.studio.next((frame) => frame.type === 'chat-permission-requested');
  assert.equal(requested.request.capability, service);
  assert.deepEqual(requested.request.scopes, ['chat', 'always']);
  hub.studio.send({ type: 'chat-permission-response', requestId: requested.request.requestId, responseId: `grant-${service}`, threadId: started.threadId, documentId: started.documentId, decision: 'grant' });
  assert.equal((await hub.studio.next((frame) => frame.type === 'chat-permission-response-result')).ok, true);
  assert.deepEqual((await hub.studio.next((frame) => frame.type === 'chat-permission-resolved')).grants, [service]);
  assert.equal((await call('request_permission', { capability: service, reason: 'again' })).result.status, 'granted');
  assert.equal((await call(tool, { question: 'q' }, { parentTaskId: 'task-1' })).error.code, 'ROOT_INTERACTION_REQUIRED');
  assert.equal((await call(tool, { question: 'q' })).error.code, `${code}_UNAVAILABLE`);

  assert.equal((await browserRequest(hub, `${service}.configure`, { enabled: false })).enabled, false);
  assert.equal((await call(tool, { question: 'q' })).error.code, `${code}_DISABLED`);
});
