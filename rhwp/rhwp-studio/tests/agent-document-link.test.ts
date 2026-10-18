// 문서 없는 채팅에 문서 하나 잇기와 문서에서 떼기 — 저장소의 연결(더 늦게 바꾼 사본이 이긴다), 도구 응답 순서,
// 에이전트의 문서 떼기, 만든 문서의 검토 규칙, 홈·파일 메뉴 열기와 지난 채팅의 길 고르기.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

import { createEmptyThread, detachThreadDocument, getThread, linkThreadDocument, listThreads, upsertThread } from '../src/agent/threads.ts';
import type { ChatDocumentDetachRequest, ChatDocumentLinkRequest } from '../src/agent/document-link.ts';
import type { ChatPermissionRequest, SidebarEvent } from '../src/agent/types.ts';
import { opensInNewSession, opensNestedInNavigation, routeUnlinkedThread, settledLinkLoad, type RoutingChat } from '../src/document-session-routing.ts';
import { PendingRequestRegistry } from '../src/agent/pending-requests.ts';

registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: 'export default {};', shortCircuit: true } : next(url, context);
} });
const { AgentBridgeImpl } = await import('../src/agent/bridge.ts');

const mem = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => { mem.set(key, value); },
    removeItem: (key: string) => { mem.delete(key); },
  },
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function storedThread(fields: { documentId?: string | null; docKey?: string | null } = {}) {
  const thread = {
    ...createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'medium', ...fields }),
    messages: [{ role: 'user' as const, text: '자료를 정리해 줘' }],
  };
  upsertThread(thread);
  return getThread(thread.id)!;
}

test('linkThreadDocument links a document-less chat and never replaces a linked document', async () => {
  const thread = storedThread();
  // 같은 밀리초에 만든 두 채팅은 목록 순서가 정해지지 않는다 — 대화 시각을 갈라 둔다.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const other = storedThread();
  const order = listThreads().map((item) => item.id);
  const linked = linkThreadDocument(thread.id, { documentId: 'doc-a', docKey: '보고서.hwpx' });
  assert.equal(linked?.documentId, 'doc-a');
  assert.deepEqual(
    { documentId: getThread(thread.id)?.documentId, docKey: getThread(thread.id)?.docKey },
    { documentId: 'doc-a', docKey: '보고서.hwpx' },
  );
  assert.equal(getThread(thread.id)?.messages.length, 1, 'the conversation stays');
  assert.deepEqual(listThreads().map((item) => item.id), order, 'linking is not chat activity');

  assert.equal(linkThreadDocument(thread.id, { documentId: 'doc-b', docKey: '다른 문서.hwpx' }), null);
  assert.equal(getThread(thread.id)?.documentId, 'doc-a', 'a linked chat keeps its document');
  // 연결 전의 사본을 들고 있던 창이 대화를 저장해도 연결은 남는다.
  upsertThread({ ...thread, messages: [...thread.messages, { role: 'assistant', text: '정리했어요' }] });
  assert.deepEqual(
    { documentId: getThread(thread.id)?.documentId, messages: getThread(thread.id)?.messages.length },
    { documentId: 'doc-a', messages: 2 },
  );
  // 다시 연 채팅이 문서 칩을 세우도록 이은 채팅이라는 표시도 남는다. 문서와 함께 시작한 채팅에는 없다.
  assert.equal(typeof getThread(thread.id)?.documentLinkedAt, 'number', 'a stale copy keeps the link mark');
  assert.equal(storedThread({ documentId: 'doc-x', docKey: 'x.hwpx' }).documentLinkedAt, undefined);
  const legacy = storedThread({ docKey: '이름만 있는 문서.hwp' });
  assert.equal(linkThreadDocument(legacy.id, { documentId: 'doc-c', docKey: 'x.hwpx' }), null, 'a name-only chat already has a document');
  assert.equal(linkThreadDocument('missing-thread', { documentId: 'doc-d', docKey: null }), null);
  assert.equal(getThread(other.id)?.documentId, null);
});

test('a stale copy from a second window cannot replace a newer link', () => {
  const thread = storedThread();
  linkThreadDocument(thread.id, { documentId: 'doc-a', docKey: '보고서.hwpx' });
  // 다른 창은 연결 전 사본에 자기 문서를 적어 저장한다 — 연결을 바꾼 시각이 없다.
  upsertThread({ ...thread, documentId: 'doc-b', docKey: '다른 문서.hwpx', messages: [...thread.messages, { role: 'assistant', text: '이어서' }] });
  assert.deepEqual(
    { documentId: getThread(thread.id)?.documentId, docKey: getThread(thread.id)?.docKey, messages: getThread(thread.id)?.messages.length },
    { documentId: 'doc-a', docKey: '보고서.hwpx', messages: 2 },
  );
});

const linkState = (id: string) => {
  const thread = getThread(id)!;
  return { documentId: thread.documentId, docKey: thread.docKey, detachedFrom: thread.documentDetachedFrom };
};

test('a chat detaches from its document and links another, and stale copies undo neither', () => {
  const born = storedThread({ documentId: 'doc-a', docKey: '보고서.hwpx' });
  const other = storedThread();
  const detached = detachThreadDocument(born.id);
  assert.deepEqual(linkState(born.id), {
    documentId: null, docKey: null, detachedFrom: { documentId: 'doc-a', docKey: '보고서.hwpx', compact: true },
  }, 'the detached document is remembered once, with its compaction still to ask for');
  assert.equal(getThread(born.id)?.messages.length, 1, 'the conversation stays');
  assert.equal(getThread(born.id)?.lastActivityAt, born.lastActivityAt, 'detaching is not chat activity');
  assert.equal(detachThreadDocument(born.id), null, 'a chat without a document has nothing to detach');
  assert.equal(detachThreadDocument(other.id), null);

  // 문서에 붙어 있던 사본(다른 창)이 답을 저장해도 떼기는 남는다.
  upsertThread({ ...born, messages: [...born.messages, { role: 'assistant', text: '정리했어요' }] });
  assert.deepEqual([getThread(born.id)?.documentId, getThread(born.id)?.messages.length], [null, 2]);

  const relinked = linkThreadDocument(born.id, { documentId: 'doc-b', docKey: '계획서.hwpx' });
  assert.deepEqual(linkState(born.id), { documentId: 'doc-b', docKey: '계획서.hwpx', detachedFrom: undefined });
  assert.ok(relinked!.documentLinkChangedAt! > detached!.documentLinkChangedAt!);
  // 뗀 때의 사본도, 처음 문서의 사본도 다시 이은 문서를 되돌리지 못한다.
  upsertThread({ ...detached!, messages: [...detached!.messages, { role: 'assistant', text: '뗀 뒤 사본' }] });
  assert.equal(getThread(born.id)?.documentId, 'doc-b');
  upsertThread({ ...born, messages: [...born.messages, { role: 'assistant', text: '처음 사본' }] });
  assert.deepEqual(linkState(born.id), { documentId: 'doc-b', docKey: '계획서.hwpx', detachedFrom: undefined });
  assert.equal(getThread(born.id)?.messages.length, 2, 'the newest content still saves');

  // 대화 없이 뗀 채팅은 압축할 것이 없다.
  const quiet = storedThread({ documentId: 'doc-c', docKey: 'c.hwpx' });
  upsertThread({ ...quiet, messages: [{ role: 'assistant', text: '안녕하세요' }] });
  assert.deepEqual(detachThreadDocument(quiet.id)?.documentDetachedFrom, { documentId: 'doc-c', docKey: 'c.hwpx' });

  // 에이전트가 스스로 뗀 채팅은 그 도구 결과가 알렸다 — 다음 시작에 실을 것도, 압축할 것도 없다.
  const byAgent = storedThread({ documentId: 'doc-d', docKey: 'd.hwpx' });
  assert.deepEqual(linkState(detachThreadDocument(byAgent.id, { byAgent: true })!.id),
    { documentId: null, docKey: null, detachedFrom: undefined });
});

test('a detached chat\'s chat-start, resent after a reconnect too, carries the detached document only without one', () => {
  const frames: Record<string, any>[] = [];
  const bridge = Object.assign(Object.create(AgentBridgeImpl.prototype), {
    state: 'connected', awaitingWelcome: false, chatStartSent: false, projectWorktreeBinding: null,
    sendJson(frame: Record<string, any>) { frames.push(frame); return true; },
    // 사이드바의 제공자는 보내는 순간의 스레드에서 뗀 문서를 읽는다.
    chatStartContextProvider: () => ({ history: [], detachedFrom: { documentId: 'doc-a', documentName: '보고서.hwpx' } }),
  }) as any;
  const start = (documentId: string | null, documentName: string | null) => {
    bridge.chatStartSent = false;
    bridge.pendingChatStart = { requestId: `chat-start-${frames.length}`, agent: 'claude', workflow: 'direct', threadId: 'thread-1', documentId, documentName, history: [] };
    bridge.sendPendingChatStart();
    return frames.at(-1)!;
  };
  const detached = start(null, '보고서.hwpx');
  assert.deepEqual([detached.documentId, detached.documentName, detached.detachedFrom],
    [null, null, { documentId: 'doc-a', documentName: '보고서.hwpx' }]);
  assert.equal('detachedFrom' in start('doc-b', '계획서.hwpx'), false, 'a start with a document never carries it');
});

/** 브리지의 도구 처리만 떼어 낸 모양 — 편집기의 연결 흐름은 linkDocument 로 흉내 낸다. */
function linkBridge(options: {
  hubReply?: (frame: Record<string, unknown>) => Record<string, unknown>;
  link?: (bridge: any, request: ChatDocumentLinkRequest) => Promise<{ documentId: string; name: string }>;
} = {}) {
  const frames: Record<string, any>[] = [];
  const events: SidebarEvent[] = [];
  const requests: ChatDocumentLinkRequest[] = [];
  const responses: Array<{ id: number; ok: boolean; result?: any; error?: { code: string; message: string } }> = [];
  let revision = 41;
  const bridge = Object.create(AgentBridgeImpl.prototype) as any;
  Object.assign(bridge, {
    state: 'connected', threadId: 'thread-1', documentId: null, documentName: null, activeAgent: 'claude',
    pendingChatStart: null, chatStartSent: false, requestSeq: 0, pendingDocumentLinkId: null, pendingDocumentDetachId: null,
    requests: new PendingRequestRegistry(),
    activeProviderTurnId: 'turn-1', turnRunning: true, activeToolRequests: 0, activeToolRequestControllers: new Map(),
    inFlightWrites: new Set(), versionCommitInFlight: null, workflow: 'direct', phase: 'direct', permissionProfile: 'safe',
    listeners: new Set(), pendingEdits: { setDirectApply: () => {}, commitOpen: () => true },
    revision: { get revision() { return revision; } },
    syncEditingLease() {}, syncProjectWorktreeContext() {},
    emit(event: SidebarEvent) { events.push(event); },
    sendJson(frame: Record<string, any>) {
      frames.push(frame);
      if (frame.type === 'chat-link-document') {
        const reply = options.hubReply?.(frame)
          ?? { type: 'chat-document-linked', requestId: frame.requestId, documentId: frame.documentId, documentName: frame.documentName, projectId: 'project-1' };
        queueMicrotask(() => bridge.handleMessage(reply));
      }
      return true;
    },
    sendToolResponse(frame: any) { frames.push(frame); responses.push(frame); },
    linkDocument: async (request: ChatDocumentLinkRequest) => {
      requests.push(request);
      // 편집기는 문서를 연 뒤 사이드바를 거쳐 허브에 잇는다 — 문서 교체가 revision 을 올린다.
      revision += 1;
      return options.link
        ? options.link(bridge, request)
        : (await bridge.linkChatDocument({ threadId: 'thread-1', documentId: 'doc-new', documentName: '계획서.hwpx' }),
        { documentId: 'doc-new', name: '계획서.hwpx' });
    },
  });
  const call = (id: number, tool: string, args: unknown) => bridge.handleToolRequest({
    id, tool, args, agent: 'claude', providerTurnId: 'turn-1',
  });
  return { bridge, frames, events, requests, responses, call };
}

test('open_document links through the editor, tells the hub first and returns the new revision', async () => {
  const { bridge, frames, events, requests, responses, call } = linkBridge();
  call(1, 'open_document', { documentId: 'doc-recent' });
  await settle();
  await settle();
  assert.deepEqual(requests, [{ target: { kind: 'recent', documentId: 'doc-recent' }, origin: 'agent', threadId: 'thread-1' }]);
  const linkFrame = frames.findIndex((frame) => frame.type === 'chat-link-document');
  const toolFrame = frames.findIndex((frame) => frame.type === 'tool-response');
  assert.ok(linkFrame >= 0 && toolFrame > linkFrame, 'chat-link-document goes out before the tool reply');
  assert.deepEqual(
    { type: frames[linkFrame].type, documentId: frames[linkFrame].documentId, documentName: frames[linkFrame].documentName },
    { type: 'chat-link-document', documentId: 'doc-new', documentName: '계획서.hwpx' },
  );
  assert.deepEqual(responses[0]?.result, { documentId: 'doc-new', name: '계획서.hwpx', revision: 42, linked: true });
  assert.equal(bridge.getDocumentSelectionIdentity().documentId, 'doc-new', 'the chat now writes to the linked document');
  assert.ok(events.some((event) => event.type === 'chat-document-linked' && event.projectId === 'project-1'));
});

test('linking a document with version history tells the hub its repository, like chat-start', async () => {
  const { bridge, frames } = linkBridge();
  bridge.projectWorktreeBinding = {
    documentId: 'doc-new', repositoryId: 'repo-1',
    current: { id: 'wt-main', branch: 'main', primary: true },
    worktrees: [{ id: 'wt-main', branch: 'main', primary: true, documentId: 'doc-new' }],
  };
  await bridge.linkChatDocument({ threadId: 'thread-1', documentId: 'doc-new', documentName: '계획서.hwpx' });
  const frame = frames.find((entry) => entry.type === 'chat-link-document');
  assert.equal(frame?.repositoryId, 'repo-1');
  assert.deepEqual(frame?.worktree, { id: 'wt-main', branch: 'main', primary: true });
  assert.equal(frame?.worktrees?.[0]?.documentId, 'doc-new');
});

test('a hub refusal reaches the agent as THREAD_ALREADY_LINKED and bad arguments never open anything', async () => {
  const refused = linkBridge({
    hubReply: (frame) => ({ type: 'chat-error', requestId: frame.requestId, code: 'THREAD_ALREADY_LINKED', message: 'already linked' }),
  });
  refused.call(1, 'create_document', { name: '회의록' });
  await settle();
  await settle();
  assert.deepEqual(refused.requests[0]?.target, { kind: 'new', name: '회의록' });
  assert.equal(refused.responses[0]?.ok, false);
  assert.equal(refused.responses[0]?.error?.code, 'THREAD_ALREADY_LINKED');

  const invalid = linkBridge();
  invalid.call(1, 'open_document', { documentId: 'doc-a', path: '/tmp/a.hwpx' });
  invalid.call(2, 'create_document', { name: '   ' });
  await settle();
  assert.deepEqual(invalid.requests, []);
  assert.deepEqual(invalid.responses.map((response) => response.error?.code), ['INVALID_ARGS', 'INVALID_NAME']);
});

test('detach_document hands the call to the editor, which tells the hub before the bridge closes', async () => {
  const detaches: ChatDocumentDetachRequest[] = [];
  let hubReply: (frame: Record<string, any>) => Record<string, unknown> = (frame) => ({
    type: 'chat-document-detached', requestId: frame.requestId, threadId: frame.threadId, documentId: frame.documentId,
  });
  const { bridge, frames, responses, call } = linkBridge();
  bridge.documentId = 'doc-old';
  const send = bridge.sendJson;
  bridge.sendJson = (frame: Record<string, any>) => {
    if (frame.type === 'chat-detach-document') queueMicrotask(() => bridge.handleMessage(hubReply(frame)));
    return send.call(bridge, frame);
  };
  // 편집기는 채팅을 옮기기 직전에 허브에 알린다. 그 뒤 이 브리지는 닫혀 도구 응답을 보내지 않는다.
  bridge.detachDocument = async (request: ChatDocumentDetachRequest) => {
    detaches.push(request);
    await bridge.detachChatDocument({ threadId: 'thread-1', callId: request.callId });
  };
  call(7, 'detach_document', {});
  await settle();
  await settle();
  assert.deepEqual(detaches, [{ threadId: 'thread-1', callId: 7 }]);
  const detach = frames.find((frame) => frame.type === 'chat-detach-document');
  assert.deepEqual(
    { threadId: detach?.threadId, documentId: detach?.documentId, callId: detach?.callId },
    { threadId: 'thread-1', documentId: 'doc-old', callId: 7 },
  );
  assert.equal(bridge.getDocumentSelectionIdentity().documentId, null, 'the chat no longer writes to the old document');
  assert.ok(frames.indexOf(detach!) < frames.findIndex((frame) => frame.type === 'tool-response'));

  // 허브가 거절하면 그 이유가 에이전트에게 간다 — 편집기는 옮기지 않고 되돌린다.
  bridge.documentId = 'doc-old';
  hubReply = (frame) => ({ type: 'chat-error', requestId: frame.requestId, requestType: 'chat-detach-document', code: 'REQUEST_INVALIDATED', message: 'no call' });
  call(8, 'detach_document', {});
  await settle();
  await settle();
  assert.deepEqual(responses.at(-1)?.error, { code: 'DETACH_FAILED', message: 'no call' });
  assert.equal(bridge.getDocumentSelectionIdentity().documentId, 'doc-old');
});

test('a draft chat has no hub session to tell — its first chat-start carries the document', async () => {
  const { bridge, frames } = linkBridge();
  bridge.activeAgent = null;
  bridge.pendingChatStart = { threadId: 'thread-1', documentId: null, documentName: null };
  bridge.chatStartSent = false;
  assert.equal(await bridge.linkChatDocument({ threadId: 'thread-1', documentId: 'doc-a', documentName: 'a.hwpx' }), null);
  assert.equal(bridge.pendingChatStart.documentId, 'doc-a');
  assert.equal(frames.length, 0);
  // 다른 채팅의 연결은 이 브리지의 문서를 바꾸지 않는다.
  assert.equal(await bridge.linkChatDocument({ threadId: 'thread-2', documentId: 'doc-b', documentName: 'b.hwpx' }), null);
  assert.equal(bridge.getDocumentSelectionIdentity().documentId, 'doc-a');
});

/** 쓰기 하나를 돌리고 그 쓰기가 바로 확정됐는지(실행 취소 한 단계) 본다. */
async function writeOnce(state: { threadId: string; permissionProfile: 'safe' | 'unrestricted'; createdBy: string | null; workflow?: string; phase?: string }) {
  const log: string[] = [];
  const responses: any[] = [];
  const bridge = Object.create(AgentBridgeImpl.prototype) as any;
  Object.assign(bridge, {
    threadId: state.threadId, activeProviderTurnId: 'turn-1', turnRunning: true,
    activeToolRequests: 0, activeToolRequestControllers: new Map(), inFlightWrites: new Set(), versionCommitInFlight: null,
    workflow: state.workflow ?? 'direct', phase: state.phase ?? 'direct', permissionProfile: state.permissionProfile,
    activeAgent: 'claude', listeners: new Set(),
    documentCreatedBy: () => state.createdBy,
    pendingEdits: {
      setDirectApply: (on: boolean) => { log.push(`direct:${on}`); },
      commitOpen: () => { log.push('commitOpen'); return true; },
    },
    executor: { execute: async () => ({ revision: 2 }) },
    syncEditingLease() {}, sendJson: () => true,
    sendToolResponse(frame: any) { responses.push(frame); },
  });
  bridge.handleToolRequest({ id: 1, tool: 'insert_text', args: {}, agent: 'claude', providerTurnId: 'turn-1' });
  await settle();
  bridge.handleToolRequest({ id: 2, tool: 'commit_version', args: { message: '정리' }, agent: 'claude', providerTurnId: 'turn-1' });
  await settle();
  return { direct: log.includes('commitOpen'), commit: responses.find((frame) => frame.id === 2) };
}

test('in 에이전트 mode the chat that created a document writes to it directly; opened documents stay staged', async () => {
  const created = await writeOnce({ threadId: 'thread-1', permissionProfile: 'safe', createdBy: 'thread-1' });
  assert.equal(created.direct, true, 'each write to the created document commits as its own undo step');
  assert.equal(created.commit.error?.code, 'COMMIT_REQUIRES_FULL_ACCESS', 'version commits still need 전체 mode');

  const opened = await writeOnce({ threadId: 'thread-1', permissionProfile: 'safe', createdBy: null });
  assert.equal(opened.direct, false, 'an opened document keeps the review step');
  const otherChat = await writeOnce({ threadId: 'thread-2', permissionProfile: 'safe', createdBy: 'thread-1' });
  assert.equal(otherChat.direct, false, 'another chat on the created document still stages');
  const planning = await writeOnce({ threadId: 'thread-1', permissionProfile: 'safe', createdBy: 'thread-1', workflow: 'plan', phase: 'planning' });
  assert.equal(planning.direct, false, 'plan mode before approval does not write');
});

test('a permission request still closes when the chat gets a document while it waits', () => {
  const request: ChatPermissionRequest = {
    requestId: 'permission-1', threadId: 'thread-1', documentId: null, turnId: 'turn-1', agent: 'codex',
    capability: 'project-edit', reason: '자료를 저장합니다', createdAt: '2026-10-17T00:00:00Z',
  };
  const events: SidebarEvent[] = [];
  const bridge = Object.assign(Object.create(AgentBridgeImpl.prototype), {
    threadId: 'thread-1', documentId: null, state: 'connected',
    pendingChatPermissionRequests: new Map(), pendingPermissionCancellations: new Map(),
    chatPermissionGrants: [], requestSeq: 0, turnRunning: false,
    referenceContext() { return { threadId: this.threadId, documentId: this.documentId }; },
    sendJson: () => true, syncEditingLease() {}, emit(event: SidebarEvent) { events.push(event); },
  });
  bridge.handleMessage({ type: 'chat-permission-requested', request });
  // 사용자가 문서 선택으로 이었다. 허브는 기다리던 요청을 그 요청의 문서(null)로 끝낸다.
  bridge.documentId = 'doc-user';
  bridge.handleMessage({ type: 'chat-permission-resolved', requestId: 'permission-1', threadId: 'thread-1', documentId: null,
    outcome: { status: 'expired', reason: 'document-linked' }, grants: [] });
  assert.equal(bridge.getPendingChatPermissionRequest(), null);
  assert.ok(events.some((event) => event.type === 'chat-permission-resolved' && event.requestId === 'permission-1'));
});

function chat(state: { unlinked: boolean; active: boolean; busy: boolean; threadId?: string | null }): RoutingChat {
  return {
    sidebar: {
      isUnlinkedChat: () => state.unlinked,
      hasActiveUnlinkedChat: () => state.unlinked && state.active,
      currentThreadId: () => state.threadId ?? null,
    },
    bridge: { isBusy: () => state.busy },
  };
}

const idle = { linking: false, busy: false, managedWorktree: false, readOnlyDirty: false };

test('home and File opens leave a working document-less chat in its own session', () => {
  const empty = (chats: RoutingChat[]) => ({ wasm: { hasLoadedDocument: () => false }, chats });
  assert.equal(opensInNewSession(empty([chat({ unlinked: true, active: false, busy: true })]), idle), true, 'a running turn keeps its session');
  assert.equal(opensInNewSession(empty([chat({ unlinked: true, active: true, busy: false })]), idle), true, 'a chat in use keeps its session');
  assert.equal(opensInNewSession(empty([chat({ unlinked: true, active: false, busy: false })]), idle), false, 'a restored or draft chat makes room');
  assert.equal(opensInNewSession(empty([chat({ unlinked: true, active: true, busy: true })]), { ...idle, linking: true }), false,
    'the document linked into the chat opens in its session');
  const loaded = { wasm: { hasLoadedDocument: () => true }, chats: [] };
  assert.equal(opensInNewSession(loaded, idle), false);
  assert.equal(opensInNewSession(loaded, { ...idle, busy: true }), true);
});

test('an old document-less chat continues without looking for a document to move to', () => {
  const holder = chat({ unlinked: true, active: false, busy: false, threadId: 'old-chat' });
  const loaded = { wasm: { hasLoadedDocument: () => true }, chats: [] as RoutingChat[] };
  assert.deepEqual(routeUnlinkedThread(loaded, 'old-chat', [holder]), { kind: 'holder', chat: holder });
  assert.deepEqual(routeUnlinkedThread(loaded, 'old-chat', []), { kind: 'new-session' });
  assert.deepEqual(routeUnlinkedThread({ wasm: { hasLoadedDocument: () => false }, chats: [] }, 'old-chat', []), { kind: 'in-place' });
});

test('an outside open during a link waits for it, and only the link\'s own load is linked', () => {
  assert.equal(opensNestedInNavigation({ navigationRunning: 1, linking: false }), true, 'a library move opens inside itself');
  assert.equal(opensNestedInNavigation({ navigationRunning: 1, linking: true }), false, 'an open during a link queues behind it');
  assert.equal(opensNestedInNavigation({ navigationRunning: 0, linking: false }), false);

  assert.deepEqual(settledLinkLoad({ created: true, documentId: 'doc-new' }, 'doc-new'), { documentId: 'doc-new', created: true });
  assert.equal(settledLinkLoad({ created: true, documentId: 'doc-new' }, 'doc-user'), null,
    'another open replaced the document — it is not the chat\'s created document');
  assert.equal(settledLinkLoad({ created: false, documentId: null }, 'doc-user'), null);
  assert.equal(settledLinkLoad({ created: false, documentId: 'doc-a' }, null), null);
});
