import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { chatPermissionMatchesContext, readChatPermissionGrants, readChatPermissionRequest } from '../src/agent/chat-permissions.ts';
import { PendingRequestRegistry } from '../src/agent/pending-requests.ts';
import type { ChatPermissionRequest, SidebarEvent } from '../src/agent/types.ts';

registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: 'export default {};', shortCircuit: true } : next(url, context);
} });
const { AgentBridgeImpl } = await import('../src/agent/bridge.ts');
const { assertToolCapability } = await import('../src/agent/tool-executor.ts');

const request: ChatPermissionRequest = {
  requestId: 'permission-1', threadId: 'thread-1', documentId: 'document-1', turnId: 'turn-1',
  agent: 'codex', capability: 'project-edit', reason: '프로젝트 자료를 수정합니다.', createdAt: '2026-10-10T00:00:00Z',
};

function fixture() {
  const frames: Record<string, unknown>[] = [];
  /** 보낸 순간의 직렬화 — 보낸 뒤 프레임 객체에서 지운 필드도 남는다. */
  const wire: string[] = [];
  const events: SidebarEvent[] = [];
  const bridge = Object.assign(Object.create(AgentBridgeImpl.prototype), {
    threadId: request.threadId, documentId: request.documentId, state: 'connected',
    pendingChatPermissionRequests: new Map(), pendingPermissionCancellations: new Map(), requests: new PendingRequestRegistry(),
    chatPermissionGrants: [], requestSeq: 0, turnRunning: false,
    workflow: 'question', phase: 'questioning', permissionProfile: 'safe', capabilityEpoch: 2,
    referenceContext() { return { threadId: this.threadId, documentId: this.documentId }; },
    sendJson(frame: Record<string, unknown>) { frames.push(frame); wire.push(JSON.stringify(frame)); return true; },
    syncEditingLease() {}, emit(event: SidebarEvent) { events.push(event); },
  });
  return { bridge, frames, events, wire };
}

test('permission requests validate known capabilities and exact chat/document identity', () => {
  assert.deepEqual(readChatPermissionRequest(request), request);
  for (const agent of ['claude', 'codex', 'pi']) {
    assert.deepEqual(readChatPermissionRequest({ ...request, agent }), { ...request, agent });
  }
  for (const agent of ['grok', 'cursor', 'opencode', 'unknown']) {
    assert.equal(readChatPermissionRequest({ ...request, agent }), null);
  }
  assert.equal(readChatPermissionRequest({ ...request, capability: 'full-access' }), null);
  assert.equal(readChatPermissionRequest({ ...request, capability: 'document-edit' }), null);
  assert.equal(readChatPermissionRequest({ ...request, documentId: undefined }), null);
  assert.deepEqual(readChatPermissionGrants(['document-edit', 'full-access']), []);
  assert.deepEqual(readChatPermissionGrants(['local-execution', 'local-execution']), ['local-execution']);
  assert.equal(chatPermissionMatchesContext(request, { threadId: 'thread-2', documentId: 'document-1' }), false);
  assert.equal(chatPermissionMatchesContext(request, { threadId: 'thread-1', documentId: 'document-2' }), false);
});

test('grant waits for scoped server confirmation and sends no continuation prompt', () => {
  const { bridge, frames } = fixture();
  bridge.handleMessage({ type: 'chat-permission-requested', request: { ...request, threadId: 'thread-2' } });
  assert.equal(bridge.getPendingChatPermissionRequest(), null);
  bridge.handleMessage({ type: 'chat-permission-requested', request });
  const responseId = bridge.respondChatPermission(request.requestId, 'grant');
  assert.deepEqual(bridge.getChatPermissionGrants(), []);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'chat-permission-response');
  assert.equal(frames[0].responseId, responseId);
  assert.equal(frames[0].threadId, request.threadId);
  assert.equal(frames[0].documentId, request.documentId);
  bridge.handleMessage({ type: 'chat-permission-resolved', requestId: request.requestId,
    threadId: request.threadId, documentId: 'another-document', outcome: { status: 'granted' }, grants: ['project-edit'] });
  assert.deepEqual(bridge.getChatPermissionGrants(), []);
  bridge.handleMessage({ type: 'chat-permission-resolved', requestId: request.requestId,
    threadId: request.threadId, documentId: request.documentId, outcome: { status: 'granted' }, grants: ['project-edit'] });
  assert.deepEqual(bridge.getChatPermissionGrants(), ['project-edit']);
  assert.equal(bridge.getPendingChatPermissionRequest(), null);
  assert.equal(bridge.canStagePendingEdits(), false);
  assert.equal(bridge.writesApplyDirectly(), false);
  assert.equal(frames.length, 1);
});

test('busy or disconnected responses retain a request for explicit retry', async () => {
  const { bridge, events, frames } = fixture();
  bridge.handleMessage({ type: 'chat-permission-requested', request: { ...request, capability: 'local-execution' } });
  const responseId = bridge.respondChatPermission(request.requestId, 'grant');
  bridge.handleMessage({ type: 'chat-permission-response-result', requestId: request.requestId, responseId, ok: false, code: 'AGENT_BUSY' });
  assert.equal(bridge.getPendingChatPermissionRequest()?.requestId, request.requestId);
  bridge.state = 'disconnected';
  bridge.respondChatPermission(request.requestId, 'grant');
  await Promise.resolve();
  assert.equal(events.at(-1)?.type, 'chat-permission-response-result');
  assert.equal(frames.length, 1);
  assert.deepEqual(bridge.getChatPermissionGrants(), []);
  bridge.threadId = 'thread-2';
  bridge.state = 'connected';
  bridge.respondChatPermission(request.requestId, 'grant');
  await Promise.resolve();
  assert.equal(frames.length, 1);
});

test('authoritative snapshots clear grants and invalidate another chat request', () => {
  const { bridge } = fixture();
  bridge.syncChatPermissions({ chatPermissionGrants: [], pendingChatPermissionRequest: request });
  assert.equal(bridge.getPendingChatPermissionRequest()?.requestId, request.requestId);
  bridge.syncChatPermissions({ chatPermissionGrants: ['project-edit'], pendingChatPermissionRequest: null });
  assert.deepEqual(bridge.getChatPermissionGrants(), ['project-edit']);
  bridge.threadId = 'thread-2';
  bridge.syncChatPermissions({ chatPermissionGrants: [], pendingChatPermissionRequest: request });
  assert.deepEqual(bridge.getChatPermissionGrants(), []);
  assert.equal(bridge.getPendingChatPermissionRequest(), null);
});

test('explicit cancellation stays hidden across a stale reconnect snapshot and only denies its captured request', () => {
  const { bridge, frames } = fixture();
  bridge.handleMessage({ type: 'chat-permission-requested', request });
  bridge.cancelChatPermissionRequest();
  bridge.syncChatPermissions({ chatPermissionGrants: [], pendingChatPermissionRequest: request });
  assert.equal(bridge.getPendingChatPermissionRequest(), null);
  assert.equal(frames.at(-1)?.type, 'chat-permission-response');
  assert.equal(frames.at(-1)?.decision, 'deny');
  assert.equal(frames.at(-1)?.requestId, request.requestId);
  assert.equal(frames.at(-1)?.threadId, request.threadId);
  assert.equal(frames.at(-1)?.documentId, request.documentId);
  bridge.syncChatPermissions({ chatPermissionGrants: [], pendingChatPermissionRequest: null });
  assert.equal(bridge.pendingPermissionCancellations.size, 0);
  const next = { ...request, requestId: 'permission-2' };
  bridge.handleMessage({ type: 'chat-permission-requested', request: next });
  assert.equal(bridge.getPendingChatPermissionRequest()?.requestId, next.requestId);
});

test('chat rejects document writes even with stale grants or an implementing phase', () => {
  const stale = { workflow: 'question' as const, phase: 'implementing', activePhase: 'implementing' as const,
    capabilityEpoch: 2, activeCapabilityEpoch: 2,
    chatPermissionGrants: ['document-edit'], activeChatPermissionGrants: ['document-edit'], requestIsActive: () => true };
  assert.throws(() => assertToolCapability('insert_text', stale), { code: 'QUESTION_MODE_READ_ONLY' });
  assert.doesNotThrow(() => assertToolCapability('insert_text', { workflow: 'direct', phase: 'direct' }));
  assert.throws(() => assertToolCapability('insert_text', { workflow: 'plan', phase: 'planning', activePhase: 'planning' }), { code: 'PLAN_MODE_READ_ONLY' });
  const { bridge } = fixture();
  bridge.syncChatPermissions({ chatPermissionGrants: ['document-edit'], pendingChatPermissionRequest: { ...request, capability: 'document-edit' } });
  assert.deepEqual(bridge.getChatPermissionGrants(), []);
  assert.equal(bridge.getPendingChatPermissionRequest(), null);
  bridge.phase = 'implementing';
  assert.equal(bridge.canStagePendingEdits(), false);
});

const secretSave: ChatPermissionRequest = {
  ...request, requestId: 'secret-1', capability: 'browser', kind: 'secret-save', secretLabel: 'API 키', secretKind: 'api-key',
  origins: ['https://api.example.com'], scopes: ['always', 'chat'],
};
const handoff: ChatPermissionRequest = {
  ...request, requestId: 'handoff-1', capability: 'browser', kind: 'browser-code', origin: 'https://accounts.example.com', tabId: 'tab-1',
};

test('several requests of one chat stay open and resolve one by one', () => {
  const { bridge, events } = fixture();
  bridge.handleMessage({ type: 'chat-permission-requested', request });
  bridge.handleMessage({ type: 'chat-permission-requested', request: handoff });
  bridge.handleMessage({ type: 'chat-permission-requested', request: secretSave });
  assert.deepEqual(bridge.getPendingChatPermissionRequests().map((entry: ChatPermissionRequest) => entry.requestId), ['permission-1', 'handoff-1', 'secret-1']);
  assert.equal(events.filter((event) => event.type === 'chat-permission-resolved').length, 0, 'a new request never expires an earlier one');
  bridge.handleMessage({ type: 'chat-permission-resolved', requestId: handoff.requestId, threadId: handoff.threadId,
    documentId: handoff.documentId, outcome: { status: 'denied' }, grants: [] });
  assert.deepEqual(bridge.getPendingChatPermissionRequests().map((entry: ChatPermissionRequest) => entry.requestId), ['permission-1', 'secret-1']);
  bridge.handleMessage({ type: 'chat-permission-resolved', requestId: request.requestId, threadId: request.threadId,
    documentId: request.documentId, outcome: { status: 'granted' }, grants: [], alwaysGrants: ['project-edit'] });
  assert.deepEqual(bridge.getChatPermissionGrants(), ['project-edit'], 'an always grant counts for this chat');
  assert.deepEqual(bridge.getPendingChatPermissionRequests().map((entry: ChatPermissionRequest) => entry.requestId), ['secret-1']);
});

test('snapshots list every pending request; only requests the hub dropped expire', () => {
  const { bridge, events } = fixture();
  bridge.handleMessage({ type: 'chat-permission-requested', request });
  bridge.handleMessage({ type: 'chat-permission-requested', request: handoff });
  bridge.syncChatPermissions({ chatPermissionGrants: [], pendingChatPermissionRequests: [handoff, secretSave], pendingChatPermissionRequest: request });
  assert.deepEqual(bridge.getPendingChatPermissionRequests().map((entry: ChatPermissionRequest) => entry.requestId).sort(), ['handoff-1', 'secret-1']);
  const resolved = events.filter((event) => event.type === 'chat-permission-resolved');
  assert.deepEqual(resolved.map((event) => event.type === 'chat-permission-resolved' && event.requestId), ['permission-1']);
  assert.equal(events.filter((event) => event.type === 'chat-permission-requested' && event.replayed).length, 2, 'listed requests replay to the cards');
  // 목록이 없는 옛 허브: 브라우저 요청은 허브의 해소를 기다린다.
  bridge.syncChatPermissions({ chatPermissionGrants: [], pendingChatPermissionRequest: null });
  assert.deepEqual(bridge.getPendingChatPermissionRequests().map((entry: ChatPermissionRequest) => entry.requestId).sort(), ['handoff-1', 'secret-1']);
});

test('grants carry only an offered scope', () => {
  const { bridge, frames } = fixture();
  bridge.handleMessage({ type: 'chat-permission-requested', request: { ...request, scopes: ['chat', 'always'] } });
  bridge.respondChatPermission(request.requestId, 'grant', 'always');
  assert.equal(frames.at(-1)?.scope, 'always');
  bridge.handleMessage({ type: 'chat-permission-requested', request: { ...request, requestId: 'permission-2' } });
  bridge.respondChatPermission('permission-2', 'grant', 'always');
  assert.equal(frames.at(-1)?.scope, undefined, 'a request without scope choices never grants always');
  bridge.respondChatPermission(request.requestId, 'deny', 'always');
  assert.equal(frames.at(-1)?.scope, undefined);
});

test('a secret travels only on its own frame and never in events or the retained frame', async () => {
  const { bridge, frames, wire, events } = fixture();
  const value = 'sk-test-secret-value';
  assert.equal((await bridge.submitSecret({ requestId: secretSave.requestId, label: 'API 키', value, scope: 'always' })).code, 'REQUEST_INVALIDATED');
  bridge.handleMessage({ type: 'chat-permission-requested', request: secretSave });
  const pending = bridge.submitSecret({ requestId: secretSave.requestId, label: ' API 키 ', value, scope: 'chat' });
  const sent = JSON.parse(wire.at(-1)!);
  assert.equal(sent.type, 'secret-submit');
  assert.deepEqual({ ...sent, responseId: 'x' }, { v: sent.v, type: 'secret-submit', responseId: 'x', requestId: 'secret-1',
    threadId: request.threadId, documentId: request.documentId, label: 'API 키', value, scope: 'chat' });
  assert.equal('value' in frames.at(-1)!, false, 'the frame object drops the value after sending');
  bridge.handleMessage({ type: 'secret-submit-result', responseId: sent.responseId, ok: true,
    secret: { id: 's1', label: 'API 키', kind: 'api-key', origins: ['https://api.example.com'], scope: 'chat', blocked: false,
      createdAt: '2026-10-16T00:00:00Z', lastUsedAt: null, value } });
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes(value), false, 'result metadata never echoes a value');
  assert.equal(JSON.stringify(events).includes(value), false);
  bridge.state = 'disconnected';
  assert.equal((await bridge.submitSecret({ requestId: secretSave.requestId, label: 'API 키', value, scope: 'always' })).code, 'DISCONNECTED');
  assert.equal(wire.length, 1);
});

test('secret save requests read their metadata', () => {
  assert.deepEqual(readChatPermissionRequest({ ...secretSave, capability: undefined }), secretSave);
  assert.equal(readChatPermissionRequest({ ...secretSave, scopes: ['forever'] })?.scopes, undefined);
});

const site = {
  ...request, requestId: 'site-1', capability: 'browser', kind: 'browser-site-access', origin: 'https://www.coupang.com',
  origins: ['https://coupang.com'], siteDomain: 'coupang.com', scopes: ['chat', 'always'],
};

test('a site card lists the site logins and secrets by name and the blocks it lifts', () => {
  const read = readChatPermissionRequest({ ...site,
    logins: [{ id: 'l1', label: 'Coupang', username: 'andy@hama.kr', agentBlocked: true, password: 'never-read' }],
    secrets: [{ id: 's1', label: 'API 키', kind: 'api-key', value: 'never-read' }], blocked: ['download', 'download'], item: { accountId: 'l1' } });
  assert.deepEqual(read?.logins, [{ id: 'l1', label: 'Coupang', detail: 'andy@hama.kr', blocked: true }]);
  assert.deepEqual(read?.secrets, [{ id: 's1', label: 'API 키', secretKind: 'api-key' }]);
  assert.deepEqual(read?.blocked, ['download']);
  assert.deepEqual(read?.item, { accountId: 'l1' });
  assert.equal(read?.siteDomain, 'coupang.com');
  assert.equal(JSON.stringify(read).includes('never-read'), false, 'value-looking fields never reach the card');
});

test('a replayed legacy account or secret use request becomes a site card', () => {
  const account = readChatPermissionRequest({ ...request, requestId: 'old-account', capability: 'browser', kind: 'browser-use-account',
    origin: 'https://accounts.google.com', origins: ['https://accounts.google.com'], accountId: 'google', accountLabel: 'Google 연구' });
  assert.equal(account?.kind, 'browser-site-access');
  assert.deepEqual(account?.logins, [{ id: 'google', label: 'Google 연구' }]);
  assert.deepEqual(account?.scopes, ['chat', 'always']);
  const secret = readChatPermissionRequest({ ...request, requestId: 'old-secret', capability: undefined, kind: 'secret-use',
    secretId: 'secret-notion', secretLabel: 'Notion API 키', secretKind: 'api-key', origins: ['https://www.notion.so'] });
  assert.equal(secret?.kind, 'browser-site-access');
  assert.equal(secret?.origin, 'https://www.notion.so');
  assert.deepEqual(secret?.secrets, [{ id: 'secret-notion', label: 'Notion API 키', secretKind: 'api-key' }]);
  assert.equal(readChatPermissionRequest({ ...request, capability: 'browser', kind: 'secret-use' }), null, 'a legacy secret use without a secret id is rejected');
  // 옛 허브의 사이트 카드는 계정 하나를 accountId·accountLabel 로 보냈다.
  assert.deepEqual(readChatPermissionRequest({ ...site, accountId: 'coupang', accountLabel: 'andy@hama.kr' })?.logins, [{ id: 'coupang', label: 'andy@hama.kr' }]);
});
