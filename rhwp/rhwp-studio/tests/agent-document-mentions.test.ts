/**
 * 브리지의 다른 문서 프레임 — 사용자 메시지의 documentMentions 와 tool-request 의 파일 source.
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: 'export default {};', shortCircuit: true } : next(url, context);
} });
const { AgentBridgeImpl } = await import('../src/agent/bridge.ts');

function connectedBridge(extra: Record<string, unknown> = {}) {
  const frames: Record<string, unknown>[] = [];
  const bridge = Object.assign(Object.create(AgentBridgeImpl.prototype), {
    state: 'connected', activeAgent: 'claude', pendingChatStart: null, workflowSwitchPending: false,
    queuedMessages: [], messageReceipts: new Map(), requestSeq: 0, revision: { revision: 7 },
    activeTemplateId: null, phase: 'idle', workflow: 'direct', turnSnapshots: null, capabilityEpoch: 0,
    turnRunning: true, activeToolRequests: 0, activeToolRequestControllers: new Map(), inFlightWrites: new Set(),
    versionCommitInFlight: null, documentId: 'doc-a', frameReceivedAt: 0, disposed: false,
    pendingEdits: { hasPending: () => false },
    referenceContext: () => ({ threadId: 'thread-1', documentId: 'doc-a' }),
    buildTurnSnapshot: () => null, scheduleBusyCheck() {}, emitConnection() {}, syncEditingLease() {},
    commitDirectWrite() {}, notifyToolExecuted() {}, withEditReport: (result: unknown) => result,
    sendJson(frame: Record<string, unknown>) { frames.push(frame); return true; },
    sendToolResponse(frame: Record<string, unknown>) { frames.push(frame); },
    ...extra,
  });
  return { bridge, frames };
}

test('사용자 메시지는 고른 문서를 documentMentions 로 — 겹침 없이 다섯 개까지, open 은 열린 문서만', async () => {
  const { bridge, frames } = connectedBridge();
  const documents = Array.from({ length: 7 }, (_, i) => ({ documentId: `doc-${i}`, title: `문서 ${i}.hwp`, ...(i === 0 ? { open: true as const } : {}) }));
  void bridge.sendUserMessage('@문서 요약', undefined, [], false, undefined, ['item-1'], undefined, [documents[0], ...documents]);
  const frame = frames.find((item) => item['type'] === 'chat-user-message')!;
  assert.deepEqual(frame['mentions'], ['item-1']);
  assert.deepEqual(frame['documentMentions'], [
    { documentId: 'doc-0', title: '문서 0.hwp', open: true },
    ...documents.slice(1, 5).map(({ documentId, title }) => ({ documentId, title })),
  ]);

  frames.length = 0;
  void bridge.sendUserMessage('문서 없이');
  assert.equal(frames.find((item) => item['type'] === 'chat-user-message')!['documentMentions'], undefined);
});

test('tool-request 의 파일 source 는 꼴이 맞을 때만 실행기에 닿는다', async () => {
  const seen: unknown[] = [];
  const { bridge, frames } = connectedBridge({
    executor: { execute: async (_tool: string, _args: unknown, _agent: string, capability: { source?: unknown }) => { seen.push(capability.source); return { ok: true }; } },
  });
  const request = (id: number, source: unknown) => bridge.handleToolRequest({
    id, turnBound: false, tool: 'get_structure', args: { documentId: 'file:h1' }, source,
  });
  const file = { kind: 'file', handle: 'h1', name: '외부.hwp', size: 10, mtimeMs: 5 };
  request(1, file);
  request(2, { ...file, path: '/etc/passwd' });
  request(3, { ...file, size: -1 });
  request(4, { ...file, handle: 'a b' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [file, undefined, undefined, undefined]);
  assert.equal(frames.filter((frame) => frame['type'] === 'tool-response').length, 4);
});
