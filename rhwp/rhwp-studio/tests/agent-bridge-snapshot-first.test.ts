/**
 * 새로고침 뒤 브리지는 허브의 첫 답(welcome)을 본 다음에야 채팅을 시작한다. 같은 채팅의 턴이
 * 허브에서 살아 있으면 시작 요청을 보내지 않고 그 턴을 그대로 잇는다 — 보내면 허브가 돌던
 * 프로바이더를 내리고 막혀 있던 질문을 만료시킨다.
 *
 * 실제 AgentBridgeImpl 을 가짜 WebSocket 으로 돌려 소켓 열림·프레임 수신을 그대로 거친다.
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

/** 브리지가 여는 소켓. 테스트가 열고, 프레임을 넣고, 끊는다. */
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
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify({ v: AGENT_PROTOCOL_VERSION, ...frame }) });
  }
  drop(code = 1006): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }
  frames(type: string): Array<Record<string, any>> {
    return this.sent.filter((frame) => frame.type === type);
  }
}

/** 대기 편집 오버레이가 만드는 만큼만 흉내 낸 DOM 요소(화면에 붙지 않는 브리지라 그리지 않는다). */
class FakeElement {
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  className = '';
  hidden = false;
  textContent = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = { add() {}, remove() {}, toggle() {} };
  setAttribute() {}
  removeAttribute() {}
  addEventListener() {}
  removeEventListener() {}
  append(...nodes: FakeElement[]) { for (const node of nodes) this.appendChild(node); }
  appendChild(node: FakeElement) {
    node.remove();
    node.parentElement = this;
    this.children.push(node);
    return node;
  }
  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children = parent.children.filter((child) => child !== this);
    this.parentElement = null;
  }
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
    addEventListener() {},
    removeEventListener() {},
    getElementById: () => null,
  },
});

const { AgentBridgeImpl } = await import('../src/agent/bridge.ts');
const { EventBus } = await import('../src/core/event-bus.ts');
const { AGENT_PROTOCOL_VERSION } = await import('../src/agent/types.ts');
const { makeEnv } = await import('./agent-test-env.ts');

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const THREAD = 'thread-live';
const OTHER = 'thread-other';

function question(threadId = THREAD) {
  return {
    interactionId: 'question-1',
    providerRequestId: 'provider-request-1',
    threadId,
    turnId: 'turn-live',
    agent: 'pi',
    source: 'native',
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
    questions: [{
      id: 'detail',
      header: 'Detail',
      question: 'Which detail?',
      mode: 'single',
      allowOther: true,
      options: [
        { id: 'one', label: 'One', description: 'First.' },
        { id: 'two', label: 'Two', description: 'Second.' },
      ],
    }],
  };
}

/** 허브 sessionInfo 모양의 스냅샷. */
function session(overrides: Record<string, unknown> = {}) {
  return {
    agent: 'pi',
    model: 'mock-model',
    effort: null,
    permissionProfile: 'safe',
    serviceTier: 'standard',
    sessionId: 'provider-session-1',
    threadId: THREAD,
    documentId: 'doc-1',
    documentName: '문서.hwpx',
    status: 'running',
    turnId: 'turn-live',
    activeTemplateId: null,
    pendingUserQuestion: null,
    workflow: 'direct',
    phase: 'implementing',
    capabilityEpoch: 1,
    latestPlan: null,
    ...overrides,
  };
}

/** 새로고침된 페이지의 브리지 — 세션 구성은 곧바로 오고, 소켓은 테스트가 연다. */
async function reloadedBridge() {
  /** 턴 체크포인트(U6)에 알린 턴 끝 — 이어 붙인 턴은 끝나지 않았고, 허브가 잃은 턴은 끝났다. */
  const endedTurns: string[] = [];
  FakeSocket.instances = [];
  const { wasm } = makeEnv(['본문']);
  const editor = {
    getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    executeOperation: () => {},
  };
  const bridge = new AgentBridgeImpl({
    wasm: wasm as never,
    eventBus: new EventBus(),
    documentState: { isDirty: () => false } as never,
    editor: editor as never,
    turnCheckpoints: {
      beforeWrite: () => {},
      settleSet: () => {},
      endTurn: (threadId: string) => { endedTurns.push(threadId); },
    } as never,
  }, {
    resolveSessionContext: async () => ({
      launchId: 'launch-1',
      sessionId: 'window-session-1',
      hubUrl: 'ws://127.0.0.1:1',
      hubToken: 'hub-token',
      referenceToken: 'reference-token',
      templateToken: 'template-token',
    }),
  });
  const events: Array<Record<string, any>> = [];
  bridge.onEvent((event) => events.push(event as Record<string, any>));
  let known = false;
  void bridge.hubSessionKnown().then(() => { known = true; });
  await settle();
  const socket = FakeSocket.instances.at(-1);
  assert.ok(socket, '브리지가 허브 소켓을 연다');
  return { bridge, socket, events, endedTurns, isKnown: () => known };
}

test('reload: a start queued before the socket opens is held until the welcome', async () => {
  const f = await reloadedBridge();
  // 사이드바가 마지막 채팅을 복원하며 강제 시작을 요청한다(허브 답 전).
  f.bridge.startChat('pi', 'mock-model', '', true, 'safe', 'direct', THREAD, 'doc-1', '문서.hwpx', []);
  f.socket.open();
  assert.deepEqual(f.socket.frames('chat-start'), [], '소켓이 열리자마자 시작 요청을 보내지 않는다');
  assert.equal(f.isKnown(), false);
  f.bridge.dispose();
});

test('reload: a welcome that shows the same chat running is adopted without a start', async () => {
  const f = await reloadedBridge();
  f.bridge.startChat('pi', 'mock-model', '', true, 'safe', 'direct', THREAD, 'doc-1', '문서.hwpx', []);
  f.socket.open();
  f.socket.receive({ type: 'welcome', protocol: 5, session: session({ pendingUserQuestion: question() }) });
  await settle();

  assert.deepEqual(f.socket.frames('chat-start'), [], '살아 있는 같은 채팅을 다시 시작하지 않는다');
  assert.deepEqual(f.socket.frames('chat-stop'), []);
  assert.equal(f.bridge.isTurnRunning(), true);
  assert.equal(f.bridge.getPendingUserQuestion()?.interactionId, 'question-1');
  assert.deepEqual(f.bridge.getHubChat(), {
    threadId: THREAD, turnId: 'turn-live', running: true, awaitingUser: true,
  });
  const started = f.events.filter((event) => event.type === 'chat-started');
  assert.equal(started.length, 1);
  assert.equal(started[0]!.threadId, THREAD);
  assert.equal(f.isKnown(), true, '허브의 첫 답을 반영하면 시작 채팅을 고를 수 있다');

  // 허브가 따로 재생하는 질문도 이어 붙인 세션의 것이다 — 그대로 받는다.
  const before = f.events.length;
  f.socket.receive({ type: 'user-question-requested', interaction: question(), replayed: true });
  assert.equal(f.events.slice(before).filter((event) => event.type === 'user-question-requested').length, 1);
  // 이어 붙인 뒤의 새 시작 요청(다른 채팅 열기)은 평소대로 바로 나간다.
  f.bridge.startChat('pi', 'mock-model', '', true, 'safe', 'direct', OTHER, 'doc-1', '문서.hwpx', []);
  assert.equal(f.socket.frames('chat-start').length, 1);
  f.bridge.dispose();
});

test('reload: a plan awaiting approval in the same chat is adopted too', async () => {
  const f = await reloadedBridge();
  f.bridge.startChat('pi', 'mock-model', '', true, 'safe', 'plan', THREAD, 'doc-1', '문서.hwpx', []);
  f.socket.open();
  f.socket.receive({
    type: 'welcome', protocol: 5,
    session: session({ status: 'idle', turnId: null, workflow: 'plan', phase: 'awaiting-approval' }),
  });
  assert.deepEqual(f.socket.frames('chat-start'), []);
  assert.equal(f.bridge.getHubChat()?.awaitingUser, true);
  f.bridge.dispose();
});

test('reload: an idle snapshot of the same chat still gets exactly one start', async () => {
  const f = await reloadedBridge();
  f.bridge.startChat('pi', 'mock-model', '', true, 'safe', 'direct', THREAD, 'doc-1', '문서.hwpx', []);
  f.socket.open();
  f.socket.receive({ type: 'welcome', protocol: 5, session: session({ status: 'idle', turnId: null }) });
  const starts = f.socket.frames('chat-start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0]!.threadId, THREAD);
  assert.equal(starts[0]!.force, true);
  assert.equal(f.bridge.getHubChat(), null, '시작 요청의 답을 기다리는 동안은 붙든 채팅이 없다');
  f.bridge.dispose();
});

test('reload: a start for another chat replaces the snapshot and ignores its replayed question', async () => {
  const f = await reloadedBridge();
  f.bridge.startChat('pi', 'mock-model', '', true, 'safe', 'direct', THREAD, 'doc-1', '문서.hwpx', []);
  f.socket.open();
  f.socket.receive({
    type: 'welcome', protocol: 5,
    session: session({ threadId: OTHER, pendingUserQuestion: question(OTHER) }),
  });
  const starts = f.socket.frames('chat-start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0]!.threadId, THREAD);
  assert.equal(f.bridge.isTurnRunning(), false, '바뀔 세션의 턴을 이 채팅의 것으로 잇지 않는다');
  const before = f.events.length;
  f.socket.receive({ type: 'user-question-requested', interaction: question(OTHER), replayed: true });
  assert.deepEqual(
    f.events.slice(before).filter((event) => event.type === 'user-question-requested'),
    [],
    '바뀔 세션의 재생 질문은 띄우지 않는다',
  );
  assert.equal(f.bridge.getPendingUserQuestion(), null);
  f.bridge.dispose();
});

test('reload: with no start queued, the welcome hands the live chat to the sidebar', async () => {
  const f = await reloadedBridge();
  f.socket.open();
  await settle();
  assert.equal(f.isKnown(), false, '소켓이 열린 것만으로는 허브의 답을 모른다');
  f.socket.receive({ type: 'welcome', protocol: 5, session: session() });
  await settle();
  assert.equal(f.isKnown(), true);
  assert.deepEqual(f.bridge.getHubChat(), {
    threadId: THREAD, turnId: 'turn-live', running: true, awaitingUser: false,
  });
  assert.deepEqual(f.socket.frames('chat-start'), []);
  f.bridge.dispose();
});

test('the first answer is known when the first attempt fails without a welcome', async () => {
  const f = await reloadedBridge();
  f.socket.drop();
  await settle();
  assert.equal(f.isKnown(), true, '허브가 내려가 있으면 시작 복원을 붙잡지 않는다');
  assert.equal(f.bridge.getHubChat(), null);
  f.bridge.dispose();
});

test('re-selecting the template the adopted session already uses sends nothing', async () => {
  const f = await reloadedBridge();
  f.socket.open();
  f.socket.receive({ type: 'welcome', protocol: 5, session: session({ activeTemplateId: 'template-1' }) });
  f.bridge.setActiveTemplate('template-1');
  assert.deepEqual(f.socket.frames('chat-template-set'), [], '돌던 턴에 같은 템플릿을 다시 걸지 않는다(AGENT_BUSY)');
  f.bridge.setActiveTemplate('template-2');
  assert.deepEqual(f.socket.frames('chat-template-set').map((frame) => frame.templateId), ['template-2']);
  f.bridge.dispose();
});

test('a reconnect on the same page still delivers a start that was in flight', async () => {
  const f = await reloadedBridge();
  f.socket.open();
  f.socket.receive({ type: 'welcome', protocol: 5, session: null });
  f.bridge.startChat('pi', 'mock-model', '', true, 'safe', 'direct', THREAD, 'doc-1', '문서.hwpx', []);
  assert.equal(f.socket.frames('chat-start').length, 1);
  // 응답 전에 소켓이 끊겼다 — 다음 소켓의 welcome 이 시작 요청을 다시 보낸다.
  f.socket.drop();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await settle();
  const next = FakeSocket.instances.at(-1)!;
  assert.notEqual(next, f.socket);
  next.open();
  assert.deepEqual(next.frames('chat-start'), []);
  next.receive({ type: 'welcome', protocol: 5, session: session({ status: 'idle', turnId: null }) });
  assert.equal(next.frames('chat-start').length, 1);
  f.bridge.dispose();
});

test('an adopted live turn stays open for restore checkpoints; a turn the hub lost is closed', async () => {
  const f = await reloadedBridge();
  f.bridge.startChat('pi', 'mock-model', '', true, 'safe', 'direct', THREAD, 'doc-1', '문서.hwpx', []);
  f.socket.open();
  f.socket.receive({ type: 'welcome', protocol: 5, session: session() });
  assert.deepEqual(f.endedTurns, [], '이어 붙인 턴은 끝난 것으로 기록하지 않는다');

  // 허브가 다시 떠 세션이 없다 — 이어 붙였던 턴은 끝났다.
  f.socket.drop();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await settle();
  const next = FakeSocket.instances.at(-1)!;
  next.open();
  next.receive({ type: 'welcome', protocol: 5, session: null });
  assert.equal(f.bridge.isTurnRunning(), false);
  assert.ok(f.endedTurns.includes(THREAD), '허브가 잃은 턴의 체크포인트 기록을 닫는다');
  f.bridge.dispose();
});

test('a turn that ended while the page was away is closed when the snapshot is idle', async () => {
  const f = await reloadedBridge();
  f.socket.open();
  f.socket.receive({ type: 'welcome', protocol: 5, session: session() });
  assert.deepEqual(f.endedTurns, []);
  f.socket.drop();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await settle();
  const next = FakeSocket.instances.at(-1)!;
  next.open();
  next.receive({ type: 'welcome', protocol: 5, session: session({ status: 'idle', turnId: null }) });
  assert.equal(f.bridge.isTurnRunning(), false);
  assert.ok(f.endedTurns.includes(THREAD));
  f.bridge.dispose();
});
