/**
 * 한 문서의 채팅 둘 — 문서를 고치는 채팅은 한 번에 하나다. 채팅 모드 잠금이 늦어 두 채팅이
 * 함께 쓰기 모드로 일해도, 나중 채팅의 쓰기는 문서에 닿기 전에 DOCUMENT_WRITER_BUSY 로
 * 거절된다. main.ts 처럼 실제 브리지 둘을 가짜 엔진 하나에 붙이고 주인 자리를 맞춘다.
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

/** 오버레이가 만드는 만큼만 흉내 낸 DOM 요소 (화면 없이 돈다). */
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
const { claimDocumentWriter, syncDocumentWriter } = await import('../src/agent/document-writer.ts');
const { makeEnv } = await import('./agent-test-env.ts');

type Bridge = InstanceType<typeof AgentBridgeImpl>;
interface ToolResponse { id: number; ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } }
interface Chat {
  readonly name: string;
  readonly bridge: Bridge;
  readonly versionCommits: string[];
  turnStart(): void;
  turnEnd(): void;
  frame(msg: Record<string, unknown>): void;
  tool(name: string, args?: Record<string, unknown>): Promise<ToolResponse>;
  insert(text: string): Promise<ToolResponse>;
  ops(): number;
  dispose(): void;
}
interface Doc { chats: Chat[]; writer: Chat | null }

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function editorHost() {
  const cursor = { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 };
  return {
    getCursorPosition: () => cursor,
    executeOperation: () => {},
    prepareSnapshotCapacity: () => {},
    retainExternalSnapshot: () => {},
    releaseExternalSnapshot: () => {},
  };
}

/** 문서 하나(가짜 엔진·버스)와, 거기에 main.ts 처럼 채팅을 다는 함수. */
function documentFixture() {
  const env = makeEnv(['Hello']);
  const bus = new EventBus();
  const doc: Doc = { chats: [], writer: null };
  const addChat = (name: string): Chat => {
    const versionCommits: string[] = [];
    let chat: Chat | undefined;
    const bridge = new AgentBridgeImpl({
      wasm: env.wasm as never,
      eventBus: bus,
      documentState: { isDirty: () => false } as never,
      editor: editorHost() as never,
      view: null,
      commitVersion: async (message) => { versionCommits.push(message); },
      claimDocumentWrite: () => chat !== undefined && claimDocumentWriter(doc, chat),
    }, {
      // 허브 없이 돌린다 — 세션 구성이 오지 않아 소켓을 열지 않는다.
      resolveSessionContext: () => new Promise(() => {}),
    });
    const internals = bridge as unknown as {
      handleFrame(data: string): void;
      toolResponses: { drain(): ToolResponse[] };
    };
    const frame = (msg: Record<string, unknown>) => internals.handleFrame(JSON.stringify({ v: AGENT_PROTOCOL_VERSION, ...msg }));
    let toolId = 0;
    const tool = async (tool: string, args: Record<string, unknown> = {}) => {
      const id = ++toolId;
      frame({ type: 'tool-request', id, tool, args, agent: 'claude', turnBound: true, providerTurnId: 'turn-1' });
      await settle();
      const response = internals.toolResponses.drain().find((entry) => entry.id === id);
      assert.ok(response, `${name} 의 ${tool} 응답이 없다`);
      return response;
    };
    const created: Chat = {
      name,
      bridge,
      versionCommits,
      frame,
      tool,
      turnStart: () => frame({ type: 'agent-event', event: { type: 'turn-start', agent: 'claude', turnId: 'turn-1' } }),
      turnEnd: () => frame({ type: 'agent-event', event: { type: 'turn-end', agent: 'claude', turnId: 'turn-1', stopReason: 'end_turn' } }),
      insert: (text) => tool('insert_text', {
        expectedRevision: bridge.getDocumentSelectionIdentity().revision,
        sectionIdx: 0, paraIdx: 0, charOffset: env.body[0]!.length, text,
      }),
      ops: () => bridge.pendingEdits.getChangeSets().reduce((sum, set) => sum + set.ops.length, 0),
      // main.ts disposeChat 처럼 문서에서 떼고 브리지를 닫은 뒤 주인을 다시 맞춘다.
      dispose: () => {
        doc.chats.splice(doc.chats.indexOf(created), 1);
        bridge.dispose();
        syncDocumentWriter(doc);
      },
    };
    chat = created;
    doc.chats.push(created);
    // main.ts installChatAgent 의 notifyChatModeLock 과 같은 자리에서 주인을 맞춘다.
    bridge.onBusyChange(() => syncDocumentWriter(doc, created));
    bridge.pendingEdits.onChange(() => syncDocumentWriter(doc, created));
    bridge.onEvent((event) => {
      if (event.type === 'workflow-changed') syncDocumentWriter(doc, created);
    });
    syncDocumentWriter(doc, created);
    return created;
  };
  return { env, doc, addChat };
}

/** A 가 한 턴에 " world" 를 쓰고 끝내 검토 대기 편집을 남긴다. */
async function leaveEditsAwaitingReview(a: Chat) {
  a.turnStart();
  const wrote = await a.insert(' world');
  assert.equal(wrote.ok, true, JSON.stringify(wrote));
  a.turnEnd();
  await settle();
  const [set] = a.bridge.pendingEdits.getChangeSets();
  assert.equal(set?.status, 'awaiting-review');
  return set!;
}

test('a lagging second chat cannot write over another chat\'s staged edits, and writes once they are discarded', async () => {
  const { env, doc, addChat } = documentFixture();
  const a = addChat('A');
  const b = addChat('B');
  const set = await leaveEditsAwaitingReview(a);
  assert.equal(env.body[0], 'Hello world');

  // B 는 모드 잠금이 늦어 아직 에이전트(direct) 모드로 턴을 돈다.
  b.turnStart();
  await settle();
  const refused = await b.insert('!');
  assert.equal(refused.ok, false);
  assert.equal(refused.error?.code, 'DOCUMENT_WRITER_BUSY');
  assert.match(refused.error?.message ?? '', /Do not retry/);
  assert.equal(env.body[0], 'Hello world', '거절된 쓰기는 엔진에 닿지 않는다 — A 의 미리보기 그대로');
  assert.equal(b.ops(), 0, 'B 에는 검토할 편집이 생기지 않는다');
  assert.equal(a.ops(), 1, 'A 의 검토 대기 편집은 그대로다');

  // A 의 편집을 버리면 문서가 풀리고, 같은 턴의 B 가 다음 쓰기로 고친다.
  a.bridge.pendingEdits.reject(set.id);
  await settle();
  assert.equal(env.body[0], 'Hello');
  const wrote = await b.insert('!');
  assert.equal(wrote.ok, true, JSON.stringify(wrote));
  assert.equal(env.body[0], 'Hello!');
  assert.equal(b.ops(), 1);
  a.bridge.dispose();
  b.bridge.dispose();
});

test('the chat that starts holding first keeps the document before it writes anything', async () => {
  const { env, addChat } = documentFixture();
  const a = addChat('A');
  const b = addChat('B');

  // A 는 쓰기 모드로 턴을 시작했을 뿐 아직 아무것도 쓰지 않았다.
  a.turnStart();
  await settle();
  b.turnStart();
  await settle();
  const refused = await b.insert('!');
  assert.equal(refused.error?.code, 'DOCUMENT_WRITER_BUSY', JSON.stringify(refused));
  assert.equal(env.body[0], 'Hello');

  // A 의 턴이 편집 없이 끝나면 문서를 놓는다.
  a.turnEnd();
  await settle();
  const wrote = await b.insert('!');
  assert.equal(wrote.ok, true, JSON.stringify(wrote));
  assert.equal(env.body[0], 'Hello!');

  // 이제 B 가 주인이다 — 새 턴의 A 는 B 의 검토 대기 편집 위에 쓰지 못한다.
  a.turnStart();
  await settle();
  const late = await a.insert('?');
  assert.equal(late.error?.code, 'DOCUMENT_WRITER_BUSY', JSON.stringify(late));
  assert.equal(env.body[0], 'Hello!');
  a.bridge.dispose();
  b.bridge.dispose();
});

test('commit_version from a 전체 chat does not checkpoint another chat\'s preview', async () => {
  const { env, addChat } = documentFixture();
  const a = addChat('A');
  const b = addChat('B');
  await leaveEditsAwaitingReview(a);

  b.frame({ type: 'chat-permission-changed', permissionProfile: 'unrestricted' });
  b.turnStart();
  await settle();
  const refused = await b.tool('commit_version', { message: 'B 체크포인트' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error?.code, 'DOCUMENT_WRITER_BUSY', JSON.stringify(refused));
  assert.deepEqual(b.versionCommits, [], 'A 의 미리보기가 B 의 버전으로 남지 않는다');
  assert.equal(a.ops(), 1);
  assert.equal(env.body[0], 'Hello world');
  a.bridge.dispose();
  b.bridge.dispose();
});

test('closing the chat that holds the document lets the other chat write', async () => {
  const { env, doc, addChat } = documentFixture();
  const a = addChat('A');
  const b = addChat('B');
  await leaveEditsAwaitingReview(a);
  b.turnStart();
  await settle();
  assert.equal((await b.insert('!')).error?.code, 'DOCUMENT_WRITER_BUSY');

  a.dispose();
  assert.deepEqual(doc.chats.map((chat) => chat.name), ['B']);
  const wrote = await b.insert('!');
  assert.equal(wrote.ok, true, JSON.stringify(wrote));
  assert.ok(env.body[0]!.endsWith('!'));
  b.bridge.dispose();
});

test('a chat alone on its document writes as before', async () => {
  const { env, addChat } = documentFixture();
  const only = addChat('A');
  only.turnStart();
  const wrote = await only.insert(' world');
  assert.equal(wrote.ok, true, JSON.stringify(wrote));
  assert.equal(env.body[0], 'Hello world');
  only.bridge.dispose();
});
