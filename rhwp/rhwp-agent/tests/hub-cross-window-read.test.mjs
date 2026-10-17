// 실제 허브로 다른 창 읽기를 확인한다: 다른 Studio 창(studioInstanceId 가 다른 기록)에만 열린 문서는
// 그 창에 document-read-request 로 보내고, 그 창의 document-read-response 만 결과로 받는다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import { HUB_TOKEN, connect, startLiveHub } from './live-hub-fixture.mjs';

const LAUNCH_ID = 'live-hub-launch';

/** instance 창에서 documentId 에 묶인 채팅을 연다. */
async function openWindow(t, hub, { sessionId, instance, documentId }) {
  const capabilities = await registerHubSession({ port: hub.port, token: HUB_TOKEN, launchId: LAUNCH_ID, sessionId });
  const studio = await connect(
    `ws://127.0.0.1:${hub.port}/studio?token=${capabilities.studio}&sessionId=${sessionId}&instance=${instance}`,
    { origin: 'http://127.0.0.1:7700' },
  );
  t.after(() => studio.socket.close());
  studio.send({ type: 'chat-start', requestId: `${sessionId}-start`, agent: 'pi', model: 'test/plain', threadId: `thread-${sessionId}`, documentId, documentName: `${documentId}.hwp` });
  const started = await studio.next((frame) => frame.requestId === `${sessionId}-start`);
  assert.equal(started.type, 'chat-started', JSON.stringify(started));
  return studio;
}

async function holdTurn(t, hub, started) {
  hub.message('HOLD');
  await hub.studio.next((frame) => frame.type === 'agent-event' && frame.event.text === 'HOLD_READY');
  const mcp = await connect(`ws://127.0.0.1:${hub.port}/mcp?token=${HUB_TOKEN}&sessionId=${hub.sessionId}&agent=pi`);
  t.after(() => mcp.socket.close());
  let id = 0;
  const call = (tool, args) => {
    const callId = ++id;
    mcp.send({ type: 'tool-call', id: callId, tool, args, workflow: started.workflow, capabilityEpoch: started.capabilityEpoch });
    return mcp.next((frame) => frame.type === 'tool-result' && frame.id === callId);
  };
  return call;
}

const readRequest = (studio) => studio.next((frame) => frame.type === 'document-read-request');
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

test('reads of a document open only in another window go to that window', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t);
  const other = await openWindow(t, hub, { sessionId: 'window-b', instance: 'other-window', documentId: 'document-b' });
  const started = await hub.start({ workflow: 'plan' });
  const call = await holdTurn(t, hub, started);

  const live = call('get_structure', {});
  const liveRequest = await hub.studio.next((frame) => frame.type === 'tool-request' && frame.tool === 'get_structure');
  hub.studio.send({ type: 'tool-response', id: liveRequest.id, ok: true, result: { revision: 5, lines: [] } });
  assert.equal((await live).ok, true);

  const routed = call('get_structure', { documentId: 'document-b' });
  const request = await readRequest(other);
  assert.deepEqual(request, {
    v: request.v, type: 'document-read-request', id: request.id,
    documentId: 'document-b', tool: 'get_structure', args: { documentId: 'document-b' },
  });
  // 다른 소켓(호출한 창)의 답과 모르는 id 는 버린다.
  hub.studio.send({ type: 'document-read-response', id: request.id, ok: true, result: { name: 'spoofed' } });
  other.send({ type: 'document-read-response', id: request.id + 1000, ok: true, result: { name: 'unknown' } });
  await settle();
  other.send({ type: 'document-read-response', id: request.id, ok: true, result: { revision: 42, documentId: 'document-b', name: 'b.hwp', text: 'unsaved edit' } });
  const result = await routed;
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.result.text, 'unsaved edit');
  assert.equal(hub.studio.frames.some((frame) => frame.type === 'tool-request'), false, 'the caller window never sees the routed read');

  // 그 창의 오류 코드는 그대로 통과한다.
  const failed = call('find_text', { documentId: 'document-b', query: 'x' });
  const failing = await readRequest(other);
  other.send({ type: 'document-read-response', id: failing.id, ok: false, error: { code: 'SOURCE_UNREADABLE', message: 'trap' } });
  assert.equal((await failed).error.code, 'SOURCE_UNREADABLE');

  // 쓰기와 문서 목록은 다른 창으로 가지 않는다.
  assert.equal((await call('apply_edits', { documentId: 'document-b', expectedRevision: 5, edits: [] })).error.code, 'INVALID_ARGS');
  const listed = call('list_documents', { query: '' });
  const listRequest = await hub.studio.next((frame) => frame.type === 'tool-request' && frame.tool === 'list_documents');
  hub.studio.send({ type: 'tool-response', id: listRequest.id, ok: true, result: { documents: [], truncated: false } });
  assert.equal((await listed).ok, true);
  assert.equal(other.frames.some((frame) => frame.type === 'document-read-request'), false);

  // 호출한 창이 DOCUMENT_OPEN_ELSEWHERE 로 답하면 그 사이 열린 창으로 한 번만 다시 보낸다.
  const retried = call('get_outline', { documentId: 'document-c' });
  const callerRequest = await hub.studio.next((frame) => frame.type === 'tool-request' && frame.tool === 'get_outline');
  assert.deepEqual(callerRequest.source, { kind: 'document', documentId: 'document-c' });
  const windowC = await openWindow(t, hub, { sessionId: 'window-c', instance: 'window-c', documentId: 'document-c' });
  hub.studio.send({ type: 'tool-response', id: callerRequest.id, ok: false, error: { code: 'DOCUMENT_OPEN_ELSEWHERE', message: 'elsewhere' } });
  const retryRequest = await readRequest(windowC);
  assert.equal(retryRequest.tool, 'get_outline');
  windowC.send({ type: 'document-read-response', id: retryRequest.id, ok: false, error: { code: 'DOCUMENT_OPEN_ELSEWHERE', message: 'still elsewhere' } });
  assert.equal((await retried).error.code, 'DOCUMENT_OPEN_ELSEWHERE');
  assert.equal(hub.studio.frames.some((frame) => frame.type === 'tool-request'), false, 'only one retry');

  // 호출한 창에도 이 문서가 열려 있으면 그 창의 Studio 가 직접 읽는다.
  await openWindow(t, hub, { sessionId: 'window-a2', instance: 'live-hub-test', documentId: 'document-b' });
  const sameWindow = call('get_text_range', { documentId: 'document-b', sectionIdx: 0, paraIdx: 0 });
  const local = await hub.studio.next((frame) => frame.type === 'tool-request' && frame.tool === 'get_text_range');
  assert.deepEqual(local.source, { kind: 'document', documentId: 'document-b' });
  hub.studio.send({ type: 'tool-response', id: local.id, ok: true, result: { text: 'local' } });
  assert.equal((await sameWindow).result.text, 'local');
  assert.equal(other.frames.some((frame) => frame.type === 'document-read-request'), false);

  // 다른 창의 revision 은 이 채팅의 라이브 revision 이 되지 않는다.
  const planned = await call('present_implementation_plan', {
    goal: 'Update the date', title: 'Date plan', summary: 'Change the cover date', assumptions: [], decisions: ['Keep formatting'],
    steps: [{ title: 'Replace', details: 'Replace the cover date' }], files: [], validation: ['Read it back'], risks: [], exclusions: [],
  });
  assert.equal(planned.ok, true, JSON.stringify(planned.error));
  assert.equal((await hub.studio.next((frame) => frame.type === 'plan-ready')).plan.documentRevision, 5);
});

test('routed reads time out, fail when the window closes and end with the turn', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t, { env: { RHWP_STUDIO_TOOL_TIMEOUT_MS: '1500' } });
  const first = await openWindow(t, hub, { sessionId: 'window-b', instance: 'other-window', documentId: 'document-b' });
  const started = await hub.start();
  const call = await holdTurn(t, hub, started);

  const timedOut = call('get_structure', { documentId: 'document-b' });
  const unanswered = await readRequest(first);
  assert.equal((await timedOut).error.code, 'STUDIO_TIMEOUT');
  // 늦은 답은 버려진다.
  first.send({ type: 'document-read-response', id: unanswered.id, ok: true, result: { late: true } });

  const closing = call('get_outline', { documentId: 'document-b' });
  await readRequest(first);
  first.socket.close();
  assert.equal((await closing).error.code, 'DOCUMENT_OPEN_ELSEWHERE_CLOSED');

  const second = await openWindow(t, hub, { sessionId: 'window-b2', instance: 'other-window-2', documentId: 'document-b' });
  const cancelled = call('get_structure', { documentId: 'document-b' });
  const pending = await readRequest(second);
  hub.studio.send({ type: 'chat-interrupt' });
  assert.equal((await cancelled).error.code, 'NO_ACTIVE_TURN');
  second.send({ type: 'document-read-response', id: pending.id, ok: true, result: { late: true } });
  await settle();
  assert.equal(hub.studio.frames.some((frame) => frame.type === 'tool-request' || frame.type === 'tool-request-cancel'), false);
});
