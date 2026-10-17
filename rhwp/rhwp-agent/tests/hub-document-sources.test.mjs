// 실제 허브로 다른 문서 목록(list_documents), 경로 읽기 동의, file: 핸들 내용 경로, @ 문서 언급을 확인한다.
import assert from 'node:assert/strict';
import { realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import { HUB_TOKEN, connect, startLiveHub } from './live-hub-fixture.mjs';

const LAUNCH_ID = 'live-hub-launch';

/** 다른 Studio 창에서 document-b 에 묶인 채팅을 연다. */
async function openOtherWindow(t, hub, documentId = 'document-b') {
  const sessionId = 'live-hub-other-window';
  const capabilities = await registerHubSession({ port: hub.port, token: HUB_TOKEN, launchId: LAUNCH_ID, sessionId });
  const studio = await connect(
    `ws://127.0.0.1:${hub.port}/studio?token=${capabilities.studio}&sessionId=${sessionId}&instance=other-window`,
    { origin: 'http://127.0.0.1:7700' },
  );
  t.after(() => studio.socket.close());
  studio.send({ type: 'chat-start', requestId: 'other-start', agent: 'pi', model: 'test/plain', threadId: 'thread-other', documentId, documentName: 'b.hwp' });
  const started = await studio.next((frame) => frame.requestId === 'other-start');
  assert.equal(started.type, 'chat-started', JSON.stringify(started));
  return { sessionId, capabilities, studio };
}

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
  return { mcp, call };
}

function contentUrl(hub, handle, sessionId = hub.sessionId) {
  return `http://127.0.0.1:${hub.port}/document-sources/${encodeURIComponent(handle)}/content?sessionId=${sessionId}`;
}

test('list_documents marks other-window documents and appends project members', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t);
  await openOtherWindow(t, hub);
  const started = await hub.start();
  const { call } = await holdTurn(t, hub, started);

  const listed = call('list_documents', { query: '' });
  const request = await hub.studio.next((frame) => frame.type === 'tool-request' && frame.tool === 'list_documents');
  assert.equal(request.source, undefined);
  hub.studio.send({
    type: 'tool-response', id: request.id, ok: true,
    result: {
      documents: [
        { documentId: 'document-b', name: 'b.hwp', format: 'hwp', openedAt: '2026-10-01T00:00:00.000Z', state: 'closed' },
        { documentId: 'document-c', name: 'c.hwpx', format: 'hwpx', openedAt: '2026-10-02T00:00:00.000Z', state: 'closed' },
      ],
      truncated: false,
      revision: 99,
    },
  });
  const result = (await listed).result;
  assert.deepEqual(result.documents.map((entry) => [entry.documentId, entry.state, entry.project ?? false]), [
    ['document-b', 'open-elsewhere', false],
    ['document-c', 'closed', false],
    // 이 채팅 문서는 자기 프로젝트의 구성원이다.
    ['document-live', 'open', true],
  ]);
  assert.equal(result.truncated, false);
});

test('path reads need consent, mint session file handles and serve their bytes', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t, { env: { RHWP_HOME_ACCESS: '1' } });
  const other = await openOtherWindow(t, hub);
  const started = await hub.start();
  const { call } = await holdTurn(t, hub, started);
  const file = path.join(realpathSync(hub.root), '외부 문서.hwp');
  writeFileSync(file, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]));

  const denied = (await call('list_documents', { path: file })).error;
  assert.equal(denied.code, 'PERMISSION_REQUIRED');
  assert.match(denied.message, /request_permission with capability "other-documents"/);
  assert.equal((await call('get_structure', { documentId: 'file:AAAAAAAAAAAAAAAAAAAAAA' })).error.code, 'SOURCE_NOT_FOUND');

  // 허브만 확인하는 권한이라 턴 중에도 실행 모드 전환 없이 바로 부여된다.
  assert.equal((await call('request_permission', { capability: 'other-documents', reason: 'Read the contract the user named.' })).result.status, 'pending');
  const requested = await hub.studio.next((frame) => frame.type === 'chat-permission-requested');
  hub.studio.send({ type: 'chat-permission-response', requestId: requested.request.requestId, responseId: 'grant-other-documents', threadId: started.threadId, documentId: started.documentId, decision: 'grant' });
  const granted = await hub.studio.next((frame) => frame.type === 'chat-permission-response-result');
  assert.equal(granted.ok, true, JSON.stringify(granted));
  assert.deepEqual((await hub.studio.next((frame) => frame.type === 'chat-permission-resolved')).grants, ['other-documents']);
  // 공급자 모드를 바꾸는 권한은 여전히 턴이 끝나야 한다.
  await call('request_permission', { capability: 'local-execution', reason: 'Run a local converter.' });
  const busy = await hub.studio.next((frame) => frame.type === 'chat-permission-requested');
  hub.studio.send({ type: 'chat-permission-response', requestId: busy.request.requestId, responseId: 'grant-local', threadId: started.threadId, documentId: started.documentId, decision: 'grant' });
  assert.equal((await hub.studio.next((frame) => frame.type === 'chat-permission-response-result')).code, 'AGENT_BUSY');

  assert.equal((await call('list_documents', { path: file }, { parentTaskId: 'task-1' })).error.code, 'ROOT_INTERACTION_REQUIRED');
  assert.equal((await call('list_documents', { path: path.join(hub.root, 'notes.txt') })).error.code, 'PATH_REJECTED');
  const listed = (await call('list_documents', { path: file })).result.documents;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, '외부 문서.hwp');
  assert.equal(listed[0].size, 8);
  assert.equal(listed[0].state, 'closed');
  const documentId = listed[0].documentId;
  const handle = documentId.slice('file:'.length);
  assert.match(documentId, /^file:[A-Za-z0-9_-]{22}$/);

  const read = call('get_structure', { documentId });
  const request = await hub.studio.next((frame) => frame.type === 'tool-request' && frame.tool === 'get_structure');
  assert.equal(request.args.documentId, documentId);
  assert.deepEqual({ ...request.source, mtimeMs: 0 }, { kind: 'file', handle, name: '외부 문서.hwp', size: 8, mtimeMs: 0 });
  hub.studio.send({ type: 'tool-response', id: request.id, ok: true, result: { documentId, name: '외부 문서.hwp', lines: [] } });
  assert.equal((await read).ok, true);

  // 같은 세션의 template capability 로만 바이트를 받는다.
  const auth = { Authorization: `Bearer ${hub.capabilities.template}`, Origin: 'http://127.0.0.1:7700' };
  const response = await fetch(contentUrl(hub, handle), { headers: auth });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4]);
  assert.equal((await fetch(contentUrl(hub, handle))).status, 401);
  assert.equal((await fetch(contentUrl(hub, 'BBBBBBBBBBBBBBBBBBBBBB'), { headers: auth })).status, 404);
  const foreignSession = await fetch(contentUrl(hub, handle, other.sessionId), {
    headers: { ...auth, Authorization: `Bearer ${other.capabilities.template}` },
  });
  assert.equal(foreignSession.status, 404, 'another session cannot use this handle');

  // 파일이 바뀌면 다음 읽기의 source 크기·시각이 따라간다.
  writeFileSync(file, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 9, 9]));
  const reread = call('get_outline', { documentId });
  const changed = await hub.studio.next((frame) => frame.type === 'tool-request' && frame.tool === 'get_outline');
  assert.equal(changed.source.size, 6);
  hub.studio.send({ type: 'tool-response', id: changed.id, ok: true, result: { nodes: [] } });
  await reread;

  truncateSync(file, 24 * 1024 * 1024 + 1);
  assert.equal((await fetch(contentUrl(hub, handle), { headers: auth })).status, 413);
  assert.equal((await call('find_text', { documentId, query: 'x' })).error.code, 'SOURCE_UNREADABLE');
  rmSync(file);
  assert.equal((await fetch(contentUrl(hub, handle), { headers: auth })).status, 404);
  assert.equal((await call('find_text', { documentId, query: 'x' })).error.code, 'SOURCE_NOT_FOUND');
});

test('path reads are desktop only and need no grant in 전체 mode', { timeout: 60_000 }, async (t) => {
  const web = await startLiveHub(t);
  const webStarted = await web.start({ permissionProfile: 'unrestricted' });
  const webCalls = await holdTurn(t, web, webStarted);
  assert.equal((await webCalls.call('list_documents', { path: path.join(web.root, 'a.hwp') })).error.code, 'PATH_UNAVAILABLE');

  const desktop = await startLiveHub(t, { env: { RHWP_HOME_ACCESS: '1' } });
  const started = await desktop.start({ permissionProfile: 'unrestricted' });
  const { call } = await holdTurn(t, desktop, started);
  const file = path.join(realpathSync(desktop.root), 'full.hwpx');
  writeFileSync(file, 'PK');
  const listed = await call('list_documents', { path: file });
  assert.equal(listed.ok, true, JSON.stringify(listed.error));
  assert.match(listed.result.documents[0].documentId, /^file:/);
});

test('@-mentioned documents reach the prompt with their state, also without project content', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t);
  await openOtherWindow(t, hub);
  await hub.start();
  const prompt = await hub.promptOf('두 문서를 비교해 줘', {
    documentMentions: [
      { documentId: 'document-a', title: 'a.hwpx', open: true },
      { documentId: 'document-b', title: 'b.hwp' },
      { documentId: 'document-z', title: 'z.hwp', open: false },
      { documentId: 'document-a', title: 'duplicate' },
      { documentId: 42, title: 'invalid' },
    ],
  });
  assert.doesNotMatch(prompt, /<research_project/);
  const block = /<mentioned_documents trust="untrusted-data">\n(.*)\n<\/mentioned_documents>/.exec(prompt);
  assert.ok(block, prompt);
  assert.deepEqual(JSON.parse(block[1]).documents, [
    { documentId: 'document-a', title: 'a.hwpx', state: 'open' },
    { documentId: 'document-b', title: 'b.hwp', state: 'open-elsewhere' },
    { documentId: 'document-z', title: 'z.hwp', state: 'closed' },
  ]);
});
