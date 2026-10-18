/**
 * 다른 창의 채팅이 이 창의 문서를 읽는다 — 허브가 보낸 document-read-request 에 이 문서를 연 브리지가
 * 자기 엔진으로 답한다. 저장하지 않은 편집과 검토 대기 편집이 보이고, revision 은 싣지 않으며, 이 채팅의
 * 턴·대기 편집·revision·도구 행에는 닿지 않는다. 실제 브리지를 가짜 엔진에 붙여 프레임으로 검증한다.
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  load(url, context, next) {
    return url.endsWith('.css')
      ? { format: 'module', source: 'export default {};', shortCircuit: true }
      : next(url, context);
  },
});

class FakeElement {
  children: FakeElement[] = [];
  className = '';
  hidden = false;
  textContent = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = { add() {}, remove() {} };
  setAttribute() {}
  addEventListener() {}
  removeEventListener() {}
  append(...nodes: FakeElement[]) { this.children.push(...nodes); }
  appendChild(node: FakeElement) { this.children.push(node); return node; }
  remove() {}
}

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { addEventListener() {}, removeEventListener() {} },
});
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    visibilityState: 'visible',
    createElement: () => new FakeElement(),
    createElementNS: () => new FakeElement(),
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
  },
});

const { AgentBridgeImpl } = await import('../src/agent/bridge.ts');
const { EventBus } = await import('../src/core/event-bus.ts');
const { AGENT_PROTOCOL_VERSION } = await import('../src/agent/types.ts');
const { makeEnv } = await import('./agent-test-env.ts');

const DOC_A = 'doc-a';

interface ReadResponse {
  type: string;
  id: number;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

const structureText = (result: Record<string, unknown>) => (result['mcpContent'] as Array<{ text: string }>)[0].text;

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** 문서 A 를 연 창의 채팅 하나 — 허브 없이 프레임을 직접 넣고 보낸 프레임을 모은다. */
function ownerChat() {
  const env = makeEnv(['Hello']);
  Object.assign(env.wasm, { fileName: '보고서.hwpx', documentDigest: 'blake3:a' });
  let dirty = false;
  const bridge = new AgentBridgeImpl({
    wasm: env.wasm as never,
    eventBus: new EventBus(),
    documentState: { isDirty: () => dirty } as never,
    editor: {
      getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
      executeOperation: () => {},
      prepareSnapshotCapacity: () => {},
      retainExternalSnapshot: () => {},
      releaseExternalSnapshot: () => {},
    } as never,
    view: null,
  }, { resolveSessionContext: () => new Promise(() => {}) });
  const internals = bridge as unknown as {
    documentId: string | null;
    handleFrame(data: string): void;
    sendJson(frame: unknown): boolean;
  };
  internals.documentId = DOC_A;
  const sent: Array<Record<string, unknown>> = [];
  internals.sendJson = (frame) => { sent.push(frame as Record<string, unknown>); return true; };
  const toolEvents: unknown[] = [];
  bridge.onEvent((event) => { if (event.type === 'tool-executed') toolEvents.push(event); });
  const frame = (msg: Record<string, unknown>) => internals.handleFrame(JSON.stringify({ v: AGENT_PROTOCOL_VERSION, ...msg }));
  let readId = 0;
  const routed = async (tool: string, args: Record<string, unknown>, documentId = DOC_A): Promise<ReadResponse> => {
    const id = ++readId;
    frame({ type: 'document-read-request', id, documentId, tool, args });
    await settle();
    const response = sent.find((entry) => entry['type'] === 'document-read-response' && entry['id'] === id);
    assert.ok(response, `${tool} 의 응답이 없다`);
    return response as unknown as ReadResponse;
  };
  let toolId = 0;
  const ownTool = async (tool: string, args: Record<string, unknown>) => {
    const id = ++toolId;
    frame({ type: 'tool-request', id, tool, args, agent: 'claude', turnBound: true, providerTurnId: 'turn-1' });
    await settle();
    return sent.find((entry) => entry['type'] === 'tool-response' && entry['id'] === id);
  };
  return {
    env,
    bridge,
    sent,
    toolEvents,
    frame,
    routed,
    ownTool,
    setDirty: (value: boolean) => { dirty = value; },
    ops: () => bridge.pendingEdits.getChangeSets().reduce((sum, set) => sum + set.ops.length, 0),
  };
}

test('다른 창의 get_structure 에 이 문서의 지금 내용으로 revision 없이 답한다', async () => {
  const chat = ownerChat();
  const response = await chat.routed('get_structure', { documentId: DOC_A });
  assert.equal(response.ok, true, JSON.stringify(response));
  const result = response.result!;
  assert.equal(result['documentId'], DOC_A);
  assert.equal(result['name'], '보고서.hwpx');
  assert.equal(result['revision'], undefined);
  assert.equal(result['digest'], 'blake3:a');
  assert.equal(result['dirty'], false);
  assert.equal(result['pendingReview'], undefined);
  const text = structureText(result);
  assert.match(text.split('\n')[0], /^document "보고서\.hwpx" · /);
  assert.match(text, /Hello/);
  chat.bridge.dispose();
});

test('이 채팅의 턴이 도는 중에도 답하고, 저장하지 않은 편집과 검토 대기 편집이 보이며, 이 채팅에는 닿지 않는다', async () => {
  const chat = ownerChat();
  chat.frame({ type: 'agent-event', event: { type: 'turn-start', agent: 'claude', turnId: 'turn-1' } });
  await settle();
  const wrote = await chat.ownTool('insert_text', {
    expectedRevision: chat.bridge.getDocumentSelectionIdentity().revision,
    sectionIdx: 0, paraIdx: 0, charOffset: 5, text: ' world',
  });
  assert.equal(wrote?.['ok'], true, JSON.stringify(wrote));
  chat.setDirty(true);
  const revision = chat.bridge.getDocumentSelectionIdentity().revision;
  const ops = chat.ops();
  const toolEvents = chat.toolEvents.length;

  const structure = await chat.routed('get_structure', { documentId: DOC_A });
  assert.equal(structure.ok, true, JSON.stringify(structure));
  assert.equal(structure.result!['dirty'], true);
  assert.equal(structure.result!['pendingReview'], true);
  assert.match(structureText(structure.result!).split('\n')[0], /^document "보고서\.hwpx" \(unsaved edits\) \(includes edits awaiting review\) · /);
  const range = await chat.routed('get_text_range', { documentId: DOC_A, sectionIdx: 0, paraIdx: 0 });
  assert.equal(range.result!['text'], 'Hello world');
  assert.equal(range.result!['revision'], undefined);
  assert.equal(range.result!['dirty'], undefined, 'dirty 는 문서를 훑는 읽기에만 싣는다');

  assert.equal(chat.toolEvents.length, toolEvents, '이 창에 도구 행을 남기지 않는다');
  assert.equal(chat.ops(), ops, '대기 편집은 그대로다');
  assert.equal(chat.bridge.getDocumentSelectionIdentity().revision, revision);
  assert.equal(chat.bridge.isTurnRunning(), true);
  assert.equal(chat.env.body[0], 'Hello world');
  chat.bridge.dispose();
});

test('쓰기·list_documents·다른 문서·어긋난 프레임은 제 코드로 거절하고, id 가 없으면 답하지 않는다', async () => {
  const chat = ownerChat();
  const write = await chat.routed('insert_text', {
    documentId: DOC_A, expectedRevision: 1, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x',
  });
  assert.equal(write.error?.code, 'INVALID_ARGS');
  assert.equal(chat.env.body[0], 'Hello');
  assert.equal(chat.ops(), 0);
  assert.equal((await chat.routed('list_documents', { documentId: DOC_A })).error?.code, 'INVALID_ARGS');
  assert.equal((await chat.routed('get_document_info', { documentId: DOC_A })).error?.code, 'INVALID_ARGS');
  assert.equal((await chat.routed('get_structure', { documentId: DOC_A, sinceRevision: 1 })).error?.code, 'INVALID_ARGS');
  assert.equal((await chat.routed('get_structure', { documentId: 'doc-b' }, 'doc-b')).error?.code, 'SOURCE_NOT_FOUND');
  assert.equal((await chat.routed('get_structure', { documentId: 'doc-b' })).error?.code, 'INVALID_ARGS', 'args 와 프레임의 documentId 가 달라도 거절한다');
  assert.equal((await chat.routed('get_structure', [] as never)).error?.code, 'INVALID_ARGS');

  const before = chat.sent.length;
  chat.frame({ type: 'document-read-request', documentId: DOC_A, tool: 'get_structure', args: { documentId: DOC_A } });
  chat.frame({ type: 'document-read-request', id: { n: 7 }, documentId: DOC_A, tool: 'get_structure', args: { documentId: DOC_A } });
  await settle();
  assert.equal(chat.sent.length, before);
  chat.frame({ type: 'document-read-request', id: 'hub-read-1', documentId: DOC_A, tool: 'get_outline', args: { documentId: DOC_A } });
  await settle();
  assert.equal(chat.sent.at(-1)?.['id'], 'hub-read-1', '문자열 id 도 그대로 돌려준다');
  assert.equal(chat.toolEvents.length, 0);
  chat.bridge.dispose();
});
