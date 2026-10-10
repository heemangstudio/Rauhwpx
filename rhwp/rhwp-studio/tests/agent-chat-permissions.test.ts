import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { chatPermissionMatchesContext, readChatPermissionGrants, readChatPermissionRequest } from '../src/agent/chat-permissions.ts';
import type { ChatPermissionRequest, SidebarEvent } from '../src/agent/types.ts';

registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: 'export default {};', shortCircuit: true } : next(url, context);
} });
const { AgentBridgeImpl } = await import('../src/agent/bridge.ts');
const { assertToolCapability } = await import('../src/agent/tool-executor.ts');

const request: ChatPermissionRequest = {
  requestId: 'permission-1', threadId: 'thread-1', documentId: 'document-1', turnId: 'turn-1',
  agent: 'codex', capability: 'document-edit', reason: '문서의 문장을 수정합니다.', createdAt: '2026-10-10T00:00:00Z',
};

function fixture() {
  const frames: Record<string, unknown>[] = [];
  const events: SidebarEvent[] = [];
  const bridge = Object.assign(Object.create(AgentBridgeImpl.prototype), {
    threadId: request.threadId, documentId: request.documentId, state: 'connected',
    pendingChatPermissionRequest: null, chatPermissionGrants: [], requestSeq: 0, turnRunning: false,
    workflow: 'question', phase: 'questioning', permissionProfile: 'safe', capabilityEpoch: 2,
    referenceContext() { return { threadId: this.threadId, documentId: this.documentId }; },
    sendJson(frame: Record<string, unknown>) { frames.push(frame); return true; },
    syncEditingLease() {}, emit(event: SidebarEvent) { events.push(event); },
  });
  return { bridge, frames, events };
}

test('permission requests validate known capabilities and exact chat/document identity', () => {
  assert.deepEqual(readChatPermissionRequest(request), request);
  assert.equal(readChatPermissionRequest({ ...request, capability: 'full-access' }), null);
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
    threadId: request.threadId, documentId: 'another-document', outcome: { status: 'granted' }, grants: ['document-edit'] });
  assert.deepEqual(bridge.getChatPermissionGrants(), []);
  bridge.handleMessage({ type: 'chat-permission-resolved', requestId: request.requestId,
    threadId: request.threadId, documentId: request.documentId, outcome: { status: 'granted' }, grants: ['document-edit'] });
  assert.deepEqual(bridge.getChatPermissionGrants(), ['document-edit']);
  assert.equal(bridge.getPendingChatPermissionRequest(), null);
  assert.equal(bridge.canStagePendingEdits(), true);
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
  bridge.syncChatPermissions({ chatPermissionGrants: ['document-edit'], pendingChatPermissionRequest: null });
  assert.deepEqual(bridge.getChatPermissionGrants(), ['document-edit']);
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
  assert.equal(bridge.pendingPermissionCancellation, null);
  const next = { ...request, requestId: 'permission-2' };
  bridge.handleMessage({ type: 'chat-permission-requested', request: next });
  assert.equal(bridge.getPendingChatPermissionRequest()?.requestId, next.requestId);
});

test('question document writes require both grants, current turn, and current epoch; plan approval still gates writes', () => {
  const capability = { workflow: 'question' as const, capabilityEpoch: 2, activeCapabilityEpoch: 2,
    chatPermissionGrants: ['document-edit' as const], activeChatPermissionGrants: ['document-edit' as const], requestIsActive: () => true };
  assert.doesNotThrow(() => assertToolCapability('insert_text', capability));
  for (const change of [{ chatPermissionGrants: [] }, { activeChatPermissionGrants: [] },
    { requestIsActive: () => false }, { capabilityEpoch: 1 }, { activeCapabilityEpoch: null }]) {
    assert.throws(() => assertToolCapability('insert_text', { ...capability, ...change }), { code: 'QUESTION_MODE_READ_ONLY' });
  }
  assert.throws(() => assertToolCapability('insert_text', { ...capability, workflow: 'plan', phase: 'planning', activePhase: 'planning' }), { code: 'PLAN_MODE_READ_ONLY' });
});
