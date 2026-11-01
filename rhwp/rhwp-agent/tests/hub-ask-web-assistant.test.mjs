// 실제 허브로 ask_chatgpt·ask_claude 의 켜기·채팅 권한·사용 가능 게이트와 도구 카드 결과 전달을 확인한다.
// 이 허브에는 데스크톱 네이티브 브라우저가 없으므로 웹 개발 환경(Studio dev)과 같다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { HUB_TOKEN, connect, startLiveHub } from './live-hub-fixture.mjs';
import { WEB_ASSISTANT_VERIFY_CHAT_KEY, verifyWebAssistant } from '../web-assistant-store.mjs';

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
  // 처음 설정의 작동 확인도 같은 게이트를 지난다.
  await assert.rejects(browserRequest(hub, `${service}.verify`), { code: `${code}_DISABLED` });
  const off = await call(tool, { question: '내가 좋아하는 말투는?' });
  assert.equal(off.error.code, `${code}_DISABLED`);
  // 도구 카드는 허브가 보낸 결과(여기서는 오류)를 그린다.
  const card = await hub.studio.next((frame) => frame.type === 'hub-tool-executed');
  assert.deepEqual([card.tool, card.ok, card.error.code, card.args.question], [tool, false, `${code}_DISABLED`, '내가 좋아하는 말투는?']);

  await assert.rejects(browserRequest(hub, `${service}.configure`, { enabled: 'yes' }), { code: 'INVALID_ARGS' });
  assert.equal((await browserRequest(hub, `${service}.configure`, { enabled: true })).enabled, true);
  // 켜도 이 허브는 앱 안 네이티브 브라우저가 없다(웹 개발·관리형 브라우저).
  assert.equal((await call(tool, { question: 'q' })).error.code, `${code}_UNAVAILABLE`);
  await assert.rejects(browserRequest(hub, `${service}.verify`), { code: `${code}_UNAVAILABLE` });

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

test('the setup check asks one fixed chat and fails on an empty answer', async () => {
  const asked = [];
  const driver = (answer) => ({ ask: async (input) => { asked.push(input); return { chatUrl: 'https://chatgpt.com/c/1', answer }; } });
  const ok = await verifyWebAssistant(driver(`  연결됐어요\n\n${'가'.repeat(400)}`), { sessionId: 's1', code: 'CHATGPT' });
  assert.equal(ok.verified, true);
  assert.equal(ok.chatUrl, 'https://chatgpt.com/c/1');
  assert.ok(ok.answer.startsWith('연결됐어요 가') && ok.answer.length === 200);
  await assert.rejects(verifyWebAssistant(driver('  \n '), { code: 'CLAUDE' }), { code: 'CLAUDE_UI_CHANGED' });
  assert.deepEqual(asked.map((input) => [input.chatKey, input.sessionId]), [[WEB_ASSISTANT_VERIFY_CHAT_KEY, 's1'], [WEB_ASSISTANT_VERIFY_CHAT_KEY, null]]);
});
