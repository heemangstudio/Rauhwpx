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
async function reloadedBridge(options: { interruptTurnsOnFirstWelcome?: string[] } = {}) {
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
    ...options,
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
  // 다른 템플릿도 이어 붙인 턴이 도는 동안에는 보내지 않는다 — 허브가 거절한다. 턴이 끝난 뒤에는 보낸다.
  f.bridge.setActiveTemplate('template-2');
  assert.deepEqual(f.socket.frames('chat-template-set'), []);
  f.socket.receive({ type: 'agent-event', event: { type: 'turn-end', agent: 'pi', turnId: 'turn-live', stopReason: 'end_turn' } });
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

// ─── 엔진 trap 복구: 멈추지 못한 턴 (S7) ──────────────────────
// 엔진이 멈춘 페이지는 일하던 채팅을 멈추고 다시 불러온다. 그때 허브 연결이 끊겨 있었으면 멈춤이
// 닿지 않아, 다시 불러온 페이지의 첫 welcome 이 그 턴을 아직 돈다고 알린다.

test('trap reload: the same chat still running is adopted and then stopped once', async () => {
  const f = await reloadedBridge({ interruptTurnsOnFirstWelcome: [THREAD] });
  f.bridge.startChat('pi', 'mock-model', '', true, 'safe', 'direct', THREAD, 'doc-1', '문서.hwpx', []);
  f.socket.open();
  f.socket.receive({ type: 'welcome', protocol: 5, session: session() });
  await settle();
  assert.deepEqual(f.socket.frames('chat-start'), [], 'the live chat is adopted, not restarted');
  assert.equal(f.socket.frames('chat-interrupt').length, 1, 'and the turn the trapped page meant to stop is stopped');

  // 다음 재연결의 welcome 은 다시 멈추지 않는다 — 사용자가 이어서 진행한 턴일 수 있다.
  f.socket.receive({ type: 'welcome', protocol: 5, session: session({ turnId: 'turn-resumed' }) });
  await settle();
  assert.equal(f.socket.frames('chat-interrupt').length, 1);
  f.bridge.dispose();
});

test('trap reload: with no start queued, the adopted interrupted turn is stopped too', async () => {
  const f = await reloadedBridge({ interruptTurnsOnFirstWelcome: [THREAD] });
  f.socket.open();
  f.socket.receive({ type: 'welcome', protocol: 5, session: session() });
  await settle();
  assert.equal(f.socket.frames('chat-interrupt').length, 1);
  f.bridge.dispose();
});

test('trap reload: a running turn of a chat that was not interrupted keeps running', async () => {
  const other = await reloadedBridge({ interruptTurnsOnFirstWelcome: [OTHER] });
  other.socket.open();
  other.socket.receive({ type: 'welcome', protocol: 5, session: session() });
  await settle();
  assert.deepEqual(other.socket.frames('chat-interrupt'), []);
  assert.equal(other.bridge.isTurnRunning(), true);
  other.bridge.dispose();

  // 다른 채팅을 여는 시작 요청이 스냅샷을 바꾸면, 바뀔 세션의 턴은 이 채팅이 멈추지 않는다.
  const replaced = await reloadedBridge({ interruptTurnsOnFirstWelcome: [OTHER] });
  replaced.bridge.startChat('pi', 'mock-model', '', true, 'safe', 'direct', THREAD, 'doc-1', '문서.hwpx', []);
  replaced.socket.open();
  replaced.socket.receive({ type: 'welcome', protocol: 5, session: session({ threadId: OTHER }) });
  await settle();
  assert.equal(replaced.socket.frames('chat-start').length, 1);
  assert.deepEqual(replaced.socket.frames('chat-interrupt'), []);
  replaced.bridge.dispose();

  const plain = await reloadedBridge();
  plain.socket.open();
  plain.socket.receive({ type: 'welcome', protocol: 5, session: session() });
  await settle();
  assert.deepEqual(plain.socket.frames('chat-interrupt'), [], 'an ordinary reload keeps the running turn');
  plain.bridge.dispose();
});

// ─── welcome 전후의 허브 동기화 ──────────────────────────────
// 소켓이 열린 뒤 welcome 이 오기 전에는 허브가 이 채팅의 세션을 가졌는지 모른다. 그 틈의 메시지·멈춤과,
// 허브가 답 없이 받는 템플릿 선택이 허브의 상태와 어긋나지 않아야 한다.

/** 소켓을 끊고 브리지가 여는 다음 소켓을 돌려준다. */
async function reconnect(f: Awaited<ReturnType<typeof reloadedBridge>>, from: FakeSocket = f.socket): Promise<FakeSocket> {
  const count = FakeSocket.instances.length;
  from.drop();
  const deadline = Date.now() + 5_000;
  while (FakeSocket.instances.length === count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const next = FakeSocket.instances.at(-1)!;
  assert.notEqual(next, from, '브리지가 다시 연결한다');
  return next;
}

const idle = (overrides: Record<string, unknown> = {}) => session({ status: 'idle', turnId: null, phase: 'direct', ...overrides });
const turnStart = (turnId: string) => ({ type: 'agent-event', event: { type: 'turn-start', agent: 'pi', turnId } });
const turnEnd = (turnId: string, stopReason = 'end_turn') => ({ type: 'agent-event', event: { type: 'turn-end', agent: 'pi', turnId, stopReason } });

test('a template cleared after a message carried it reaches the hub', async () => {
  const f = await reloadedBridge();
  f.socket.open();
  f.socket.receive({ type: 'welcome', protocol: 5, session: idle() });
  f.socket.receive(turnStart('t1'));
  f.bridge.setActiveTemplate('template-1'); // 턴 중 — 허브가 거절하므로 보내지 않는다.
  assert.deepEqual(f.socket.frames('chat-template-set'), []);
  f.socket.receive(turnEnd('t1'));
  void f.bridge.sendUserMessage('표를 정리해 주세요');
  await settle();
  // 허브는 메시지가 실은 템플릿을 답 없이 건다.
  assert.equal(f.socket.frames('chat-user-message')[0]!.activeTemplateId, 'template-1');
  f.socket.receive(turnStart('t2'));
  f.socket.receive(turnEnd('t2'));
  f.bridge.setActiveTemplate(null);
  assert.deepEqual(
    f.socket.frames('chat-template-set').map((frame) => frame.templateId),
    [null],
    '칩을 지우면 허브의 템플릿도 지운다 — 다음 계획 승인·저장 알림의 턴이 지운 템플릿을 쓰지 않는다',
  );
  f.bridge.dispose();
});

test('a template choice the hub has not confirmed survives a reconnect', async () => {
  const f = await reloadedBridge();
  f.socket.open();
  f.socket.receive({ type: 'welcome', protocol: 5, hubInstanceId: 'hub-1', session: session({ activeTemplateId: 'template-1' }) });
  await settle();
  // 턴이 도는 동안 칩을 지웠다 — 허브는 아직 template-1 을 쓴다.
  f.bridge.setActiveTemplate(null);
  assert.deepEqual(f.socket.frames('chat-template-set'), []);
  const next = await reconnect(f);
  next.open();
  next.receive({ type: 'welcome', protocol: 5, hubInstanceId: 'hub-1', session: session({ activeTemplateId: 'template-1' }) });
  await settle();
  assert.equal(f.bridge.getActiveTemplate(), null, 'the welcome does not bring back the template the user removed');
  next.receive(turnEnd('turn-live'));
  void f.bridge.sendUserMessage('다음 요청');
  await settle();
  assert.deepEqual(next.frames('chat-user-message').map((frame) => frame.activeTemplateId), [null]);

  // 쉬는 동안 고른 템플릿도 허브의 답 전에 소켓이 끊기면(프레임을 잃었다) 다음 welcome 이 덮지 않는다.
  next.receive(turnStart('t2'));
  next.receive(turnEnd('t2'));
  f.bridge.setActiveTemplate('template-2');
  assert.deepEqual(next.frames('chat-template-set').map((frame) => frame.templateId), ['template-2']);
  const third = await reconnect(f, next);
  third.open();
  third.receive({ type: 'welcome', protocol: 5, hubInstanceId: 'hub-1', session: idle({ activeTemplateId: null }) });
  await settle();
  void f.bridge.sendUserMessage('또 다른 요청');
  await settle();
  assert.deepEqual(third.frames('chat-user-message').map((frame) => frame.activeTemplateId), ['template-2']);
  f.bridge.dispose();
});

test('the template a lost session used still travels with the next message to the new session', async () => {
  const f = await reloadedBridge();
  f.socket.open();
  f.socket.receive({ type: 'welcome', protocol: 5, hubInstanceId: 'hub-1', session: idle({ activeTemplateId: 'template-1' }) });
  await settle();
  // 허브가 다시 떴다 — 세션과 그 템플릿이 사라졌지만 사이드바의 칩은 template-1 을 보인다.
  const next = await reconnect(f);
  next.open();
  next.receive({ type: 'welcome', protocol: 5, hubInstanceId: 'hub-2', session: null });
  await settle();
  void f.bridge.sendUserMessage('이어서 해 주세요');
  await settle();
  const start = next.frames('chat-start')[0];
  assert.ok(start, '새 세션을 연다');
  next.receive({ type: 'chat-started', requestId: start.requestId, agent: 'pi', threadId: THREAD, sessionId: 's2', permissionProfile: 'safe', serviceTier: 'standard', workflow: 'direct', phase: 'direct' });
  await settle();
  assert.deepEqual(next.frames('chat-user-message').map((frame) => frame.activeTemplateId), ['template-1']);
  f.bridge.dispose();
});

for (const action of ['approve', 'request-changes'] as const) {
  test(`a template picked during a planning turn is set before the plan ${action === 'approve' ? 'is approved' : 'is sent back'}`, async () => {
    const f = await reloadedBridge();
    f.socket.open();
    f.socket.receive({ type: 'welcome', protocol: 5, session: session({ turnId: 'tp', workflow: 'plan', phase: 'planning' }) });
    await settle();
    f.bridge.setActiveTemplate('template-1');
    f.socket.receive(turnEnd('tp'));
    // 승인·수정 요청은 메시지 없이 다음 턴을 연다 — 그 턴보다 템플릿이 먼저 허브에 닿아야 한다.
    if (action === 'approve') f.bridge.approvePlan('plan-1');
    else f.bridge.requestPlanChanges('plan-1', '표 하나를 더 넣어 주세요');
    const order = f.socket.sent
      .filter((frame) => frame.type !== 'chat-start')
      .map((frame) => frame.type === 'chat-template-set' ? `template:${frame.templateId}` : frame.type);
    assert.deepEqual(order, ['template:template-1', action === 'approve' ? 'chat-plan-approve' : 'chat-plan-request-changes']);
    // 허브가 받았다고 답하면 다음 승인은 다시 보내지 않는다.
    f.socket.receive({ type: 'chat-template-changed', template: {
      id: 'template-1', name: '보고서', originalName: '보고서.hwpx', format: 'hwpx', size: 1, revision: 1,
    } });
    assert.equal(f.bridge.getActiveTemplate()?.id, 'template-1');
    f.bridge.approvePlan('plan-1');
    assert.equal(f.socket.frames('chat-template-set').length, 1);
    f.bridge.dispose();
  });
}

test('a stop between the socket opening and the welcome is the user’s stop, not a cut-off turn', async () => {
  const f = await reloadedBridge();
  f.socket.open();
  f.socket.receive({ type: 'welcome', protocol: 5, hubInstanceId: 'hub-1', session: session() });
  await settle();
  const next = await reconnect(f);
  next.open();
  f.events.length = 0;
  f.bridge.stopChat(); // 그 틈에 다른 채팅을 열거나 초안을 시작했다.
  assert.equal(f.bridge.isTurnRunning(), false, '허브가 아직 모르는 멈춤은 여기서 턴을 닫는다');
  next.receive({ type: 'welcome', protocol: 5, hubInstanceId: 'hub-1', session: session() });
  await settle();
  assert.deepEqual(next.sent.map((frame) => frame.type), ['chat-stop']);
  assert.deepEqual(
    f.events.filter((event) => event.type === 'agent').map((event) => event.event),
    [],
    'no agent-exit turn-end for the user’s own stop',
  );
  // 허브가 세션을 내리며 보내는 진짜 끝 하나만 사이드바에 닿는다.
  next.receive(turnEnd('turn-live', 'interrupted'));
  await settle();
  const ends = f.events.filter((event) => event.type === 'agent' && event.event.type === 'turn-end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0]!.event.interruption, undefined);
  f.bridge.dispose();
});

test('a message sent after the socket reopens waits for the welcome of a restarted hub and opens a new session', async () => {
  const f = await reloadedBridge();
  f.socket.open();
  f.socket.receive({ type: 'welcome', protocol: 5, hubInstanceId: 'hub-1', session: idle() });
  await settle();
  // 사용 한도 리셋 뒤 다시 보내기 같은 연결 복구 계기는 connection(connected) 를 듣는다 — welcome 보다 먼저 온다.
  let sendOnConnect = true;
  let receipt: Promise<string | null> | null = null;
  f.bridge.onEvent((event) => {
    if (event.type === 'connection' && event.state === 'connected' && sendOnConnect) {
      sendOnConnect = false;
      receipt = f.bridge.sendUserMessage('다시 보낼 요청', undefined, [], true);
    }
  });
  const next = await reconnect(f);
  next.open();
  assert.ok(receipt, '연결 복구 계기가 보냈다');
  assert.deepEqual(next.frames('chat-user-message'), [], 'nothing goes to the hub before its welcome');
  assert.equal(f.bridge.isBusy(), true, 'the waiting message keeps the chat busy');
  next.receive({ type: 'welcome', protocol: 5, hubInstanceId: 'hub-2', session: null });
  await settle();
  assert.deepEqual(next.frames('chat-user-message'), [], 'the restarted hub has no session for it yet');
  const start = next.frames('chat-start')[0];
  assert.ok(start, 'the message opens a new session');
  assert.equal(start.threadId, THREAD);
  next.receive({ type: 'chat-started', requestId: start.requestId, agent: 'pi', threadId: THREAD, sessionId: 's2', permissionProfile: 'safe', serviceTier: 'standard', workflow: 'direct', phase: 'direct' });
  await settle();
  const sent = next.frames('chat-user-message');
  assert.deepEqual(sent.map((frame) => frame.text), ['다시 보낼 요청']);
  assert.equal(await receipt, sent[0]!.messageId, 'the sender learns its message went out');
  f.bridge.dispose();
});

test('a message sent after the socket reopens goes to the same hub right after its welcome', async () => {
  const f = await reloadedBridge();
  f.socket.open();
  f.socket.receive({ type: 'welcome', protocol: 5, hubInstanceId: 'hub-1', session: idle() });
  await settle();
  const next = await reconnect(f);
  next.open();
  const receipt = f.bridge.sendUserMessage('다음 요청', undefined, [], true);
  assert.deepEqual(next.frames('chat-user-message'), []);
  next.receive({ type: 'welcome', protocol: 5, hubInstanceId: 'hub-1', session: idle() });
  await settle();
  assert.deepEqual(next.frames('chat-start'), [], 'the live session takes it');
  assert.deepEqual(next.frames('chat-user-message').map((frame) => frame.text), ['다음 요청']);
  assert.ok(await receipt);
  f.bridge.dispose();
});

test('reload: the sidebar reopening the live chat before a late welcome adopts its turn', async () => {
  const f = await reloadedBridge();
  // 시작 채팅 고르기가 welcome 을 기다리다 시간이 다 됐거나 사용자가 먼저 그 채팅을 열었다 — 채팅 열기는 멈춘 뒤 시작한다.
  f.bridge.stopChat();
  f.bridge.startChat('pi', 'mock-model', '', true, 'safe', 'direct', THREAD, 'doc-1', '문서.hwpx', []);
  f.socket.open();
  f.socket.receive({ type: 'welcome', protocol: 5, hubInstanceId: 'hub-1', session: session({ pendingUserQuestion: question() }) });
  await settle();
  assert.deepEqual(f.socket.sent.map((frame) => frame.type), [], 'neither chat-stop nor chat-start kills the running turn');
  assert.equal(f.bridge.isTurnRunning(), true);
  assert.equal(f.bridge.getPendingUserQuestion()?.interactionId, 'question-1', 'its question stays open');
  f.bridge.dispose();
});
