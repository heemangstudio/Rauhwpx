/**
 * 문서 기억 앵커: 사용자 메시지를 보내기 직전에 글에 매인 기억의 인용을 엔진에서 찾고, 확인한 기억 리비전과
 * 사라진 것의 id 를 메시지에 싣는다(memoryAnchorRevision · memoryMissingAnchors). 매인 기억이 없으면
 * 엔진 검색을 하지 않는다. 원본 digest 는 파일에서 연 문서만 싣는다.
 *
 * 실제 AgentBridgeImpl 을 가짜 WebSocket 으로 돌린다.
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

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: Array<Record<string, any>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.readyState = FakeSocket.CLOSED; }
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ v: 5, ...frame }) });
  }
  frames(type: string): Array<Record<string, any>> {
    return this.sent.filter((frame) => frame.type === type);
  }
}

class FakeElement {
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = { add() {}, remove() {}, toggle() {} };
  setAttribute() {}
  removeAttribute() {}
  addEventListener() {}
  removeEventListener() {}
  append() {}
  appendChild(node: FakeElement) { return node; }
  remove() {}
}

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeSocket });
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  },
});
Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    visibilityState: 'visible',
    createElement: () => new FakeElement(),
    createElementNS: () => new FakeElement(),
    addEventListener() {},
    removeEventListener() {},
    getElementById: () => null,
  },
});

const { AgentBridgeImpl } = await import('../src/agent/bridge.ts');
const { EventBus } = await import('../src/core/event-bus.ts');
const { makeEnv } = await import('./agent-test-env.ts');

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const entry = (id: string, text: string, quote?: string) => ({
  id, kind: 'protect', subject: `보호.${id}`, text, origin: 'explicit', evidence: 1,
  createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z', confirmedAt: '2026-10-22T00:00:00.000Z',
  ...(quote ? { anchor: { quote } } : {}),
});

async function connectedBridge({ openedFromFile = true }: { openedFromFile?: boolean } = {}) {
  FakeSocket.instances = [];
  const searched: string[] = [];
  const engine = { documentInstance: 1, openedFromFile };
  const { wasm } = makeEnv(['제1장 서론', '제3장  연구\u3000방법'], (fake, body) => {
    fake.searchText = (query: string) => {
      searched.push(query);
      return { found: body.some((text) => text.includes(query)) };
    };
    Object.defineProperty(fake, 'documentDigest', { get: () => 'blake3:abc' });
    Object.defineProperty(fake, 'fileName', { get: () => '보고서.hwpx' });
    Object.defineProperty(fake, 'openedFromFile', { get: () => engine.openedFromFile });
    Object.defineProperty(fake, 'documentInstance', { get: () => engine.documentInstance });
  });
  const eventBus = new EventBus();
  const bridge = new AgentBridgeImpl({
    wasm: wasm as never,
    eventBus,
    documentState: { isDirty: () => false } as never,
    editor: { getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }), executeOperation: () => {} } as never,
  }, {
    resolveSessionContext: async () => ({
      launchId: 'launch-1', sessionId: 'window-1', hubUrl: 'ws://127.0.0.1:1',
      hubToken: 'hub', referenceToken: 'reference', templateToken: 'template',
    }),
  });
  await settle();
  const socket = FakeSocket.instances.at(-1)!;
  socket.open();
  socket.receive({
    type: 'welcome', protocol: 5,
    session: {
      agent: 'pi', model: 'mock-model', effort: null, permissionProfile: 'safe',
      sessionId: 'provider-1', threadId: 'thread-1', documentId: 'doc-1', documentName: '보고서.hwpx',
      status: 'idle', turnId: null, activeTemplateId: null, pendingUserQuestion: null,
      workflow: 'direct', phase: 'direct', capabilityEpoch: 1, latestPlan: null,
    },
  });
  await settle();
  return { bridge, socket, searched, eventBus, engine };
}

/** 소켓마다 이미 답한 요청 — 요청 번호는 브리지마다 새로 센다. */
const answered = new WeakMap<FakeSocket, Set<string>>();

/** 브리지가 보낸 기억 요청에 허브처럼 답한다 (아직 답하지 않은 것 모두). */
function answerMemory(socket: FakeSocket, entries: unknown[], revision = 2) {
  const done = answered.get(socket) ?? new Set<string>();
  answered.set(socket, done);
  const requests = socket.frames('document-memory-request').filter((frame) => !done.has(frame.requestId));
  for (const request of requests) {
    done.add(request.requestId);
    socket.receive({
      type: 'document-memory-result', requestId: request.requestId, ok: true,
      memory: { key: `dm_${request.documentId === 'doc-1' ? 'a' : 'b'}${'0'.repeat(15)}`, revision, entries },
    });
  }
  return requests.at(-1)!;
}


test('a message names the anchored notes whose quote is gone from the live document', async () => {
  const f = await connectedBridge();
  // The bridge reads the chat document's memory as soon as it connects, before any message.
  const request = answerMemory(f.socket, [
    entry('mem_aaaaaaaaaaaa', '3장 수정 금지', '제3장  연구\u3000방법'),
    entry('mem_bbbbbbbbbbbb', '부록 표 유지', '부록 A 조사표'),
    entry('mem_cccccccccccc', '본문은 한다체 사용'),
  ]);
  assert.equal(request.documentId, 'doc-1');
  assert.equal(request.documentDigest, 'blake3:abc', 'a document opened from a file carries its digest');
  await settle();

  void f.bridge.sendUserMessage('첫 메시지');
  await settle();
  const [first] = f.socket.frames('chat-user-message');
  assert.equal(first!.memoryAnchorRevision, 2);
  // A quote with a double space and U+3000 is still found exactly.
  assert.deepEqual(first!.memoryMissingAnchors, ['mem_bbbbbbbbbbbb']);
  assert.deepEqual(f.searched.sort(), ['부록 A 조사표', '제3장  연구\u3000방법']);
  f.bridge.dispose();
});

test('the first message after the chat switches documents carries that document\'s anchor check', async () => {
  const f = await connectedBridge();
  answerMemory(f.socket, [entry('mem_cccccccccccc', '본문은 한다체 사용')]);
  await settle();
  f.bridge.startChat('pi', 'mock-model', undefined, true, 'safe', 'direct', 'thread-2', 'doc-2', '계획.hwpx', []);
  const start = f.socket.frames('chat-start').at(-1)!;
  f.socket.receive({ type: 'chat-started', requestId: start.requestId, agent: 'pi', threadId: 'thread-2', documentId: 'doc-2', documentName: '계획.hwpx' });
  await settle();
  const request = answerMemory(f.socket, [entry('mem_dddddddddddd', '부록 표 유지', '부록 A 조사표')], 7);
  assert.equal(request.documentId, 'doc-2');
  await settle();

  void f.bridge.sendUserMessage('새 문서의 첫 메시지');
  await settle();
  const message = f.socket.frames('chat-user-message').at(-1)!;
  assert.equal(message.documentId, 'doc-2');
  assert.equal(message.memoryAnchorRevision, 7);
  assert.deepEqual(message.memoryMissingAnchors, ['mem_dddddddddddd']);
  f.bridge.dispose();
});

test('new and template documents never send a source digest', async () => {
  const f = await connectedBridge({ openedFromFile: false });
  const request = answerMemory(f.socket, []);
  assert.equal('documentDigest' in request, false);
  assert.equal('documentFileName' in request, false);
  f.bridge.startChat('pi', 'mock-model', undefined, true, 'safe', 'direct', 'thread-2', 'doc-2', '새 문서.hwpx', []);
  const start = f.socket.frames('chat-start').at(-1)!;
  assert.equal('documentDigest' in start, false);
  f.bridge.dispose();
});

test('anchor searches are reused until the document or a quote changes', async () => {
  const f = await connectedBridge();
  answerMemory(f.socket, []);
  await settle();
  const notes = [entry('mem_aaaaaaaaaaaa', '3장 수정 금지', '제3장  연구\u3000방법'), entry('mem_bbbbbbbbbbbb', '부록 표 유지', '부록 A 조사표')];
  assert.deepEqual(f.bridge.missingDocumentMemoryAnchors(notes), ['mem_bbbbbbbbbbbb']);
  assert.deepEqual(f.bridge.missingDocumentMemoryAnchors(notes), ['mem_bbbbbbbbbbbb']);
  assert.equal(f.searched.length, 2, 'the same document state is searched once per quote');

  // A memory revision that changes one quote searches only the new quote.
  const edited = [notes[0]!, entry('mem_bbbbbbbbbbbb', '부록 표 유지', '제1장 서론')];
  assert.deepEqual(f.bridge.missingDocumentMemoryAnchors(edited), []);
  assert.deepEqual(f.searched.slice(2), ['제1장 서론']);

  // A document edit invalidates every result.
  f.eventBus.emit('document-changed');
  await settle();
  f.bridge.missingDocumentMemoryAnchors(edited);
  assert.equal(f.searched.length, 5);
  // So does another document in the same engine.
  f.engine.documentInstance += 1;
  f.bridge.missingDocumentMemoryAnchors(edited);
  assert.equal(f.searched.length, 7);
  f.bridge.dispose();
});

test('without anchored notes nothing is searched and nothing is reported missing', async () => {
  const f = await connectedBridge();
  answerMemory(f.socket, [entry('mem_cccccccccccc', '본문은 한다체 사용')]);
  await settle();
  void f.bridge.sendUserMessage('첫 메시지');
  await settle();
  const message = f.socket.frames('chat-user-message').at(-1)!;
  assert.equal('memoryMissingAnchors' in message, false);
  assert.equal(message.memoryAnchorRevision, 2);
  assert.deepEqual(f.searched, []);
  f.bridge.dispose();
});
