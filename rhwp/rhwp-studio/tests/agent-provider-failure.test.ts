/**
 * 실패 알림은 턴마다 하나다 — 실제 AgentBridgeImpl 에 허브 프레임을 넣고 사이드바로 나가는
 * turn-failure·hub-error 이벤트를 본다. 이전 허브(failure 없음)의 문구도 같은 한 알림이 된다.
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
const { makeEnv } = await import('./agent-test-env.ts');
type SidebarEvent = import('../src/agent/types.ts').SidebarEvent;
type ProviderFailure = import('../src/agent/types.ts').ProviderFailure;

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function chat() {
  const env = makeEnv(['Hello']);
  const cursor = { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 };
  const bridge = new AgentBridgeImpl({
    wasm: env.wasm as never,
    eventBus: new EventBus(),
    documentState: { isDirty: () => false } as never,
    editor: {
      getCursorPosition: () => cursor,
      executeOperation: () => {},
      prepareSnapshotCapacity: () => {},
      retainExternalSnapshot: () => {},
      releaseExternalSnapshot: () => {},
    } as never,
    view: null,
    commitVersion: async () => {},
    claimDocumentWrite: () => true,
  }, {
    // 허브 없이 돈다 — 세션 구성이 오지 않아 소켓을 열지 않는다.
    resolveSessionContext: () => new Promise(() => {}),
  });
  const internals = bridge as unknown as {
    handleFrame(data: string): void;
    messageAwaitingTurn: boolean;
    pendingChatStart: { requestId: string } | null;
    toolResponses: { drain(): Array<{ id: number; ok: boolean }> };
  };
  const events: SidebarEvent[] = [];
  bridge.onEvent((event) => events.push(event));
  const frame = (msg: Record<string, unknown>) => internals.handleFrame(JSON.stringify({ v: AGENT_PROTOCOL_VERSION, ...msg }));
  const agentEvent = (event: Record<string, unknown>) => frame({ type: 'agent-event', event: { agent: 'claude', ...event } });
  const failures = () => events.filter((event): event is Extract<SidebarEvent, { type: 'turn-failure' }> => event.type === 'turn-failure');
  return { env, bridge, internals, events, frame, agentEvent, failures };
}

function failure(overrides: Partial<ProviderFailure> = {}): ProviderFailure {
  return {
    class: 'usage_limit', agent: 'claude', message: "You've hit your limit", code: 'claude:rate_limit',
    retryable: false, resetAt: null, ...overrides,
  };
}

test('two errors and a failed turn-end give exactly one notice, after the turn-end', () => {
  const { bridge, internals, events, agentEvent, failures } = chat();
  internals.messageAwaitingTurn = true;
  agentEvent({ type: 'turn-start', turnId: 'turn-1' });
  agentEvent({ type: 'error', message: 'first', failure: failure({ class: 'network', message: 'first', code: null, retryable: true }) });
  agentEvent({ type: 'error', message: 'second', failure: failure() });
  assert.deepEqual(failures(), [], 'nothing is shown while the turn runs');
  agentEvent({ type: 'turn-end', turnId: 'turn-1', stopReason: 'failed', errorMessage: 'limit', failure: failure() });
  const shown = failures();
  assert.equal(shown.length, 1);
  assert.deepEqual(
    { class: shown[0]!.failure.class, origin: shown[0]!.origin, turnId: shown[0]!.turnId, userInitiated: shown[0]!.userInitiated },
    { class: 'usage_limit', origin: 'turn', turnId: 'turn-1', userInitiated: true },
  );
  const turnEndIndex = events.findIndex((event) => event.type === 'agent' && event.event.type === 'turn-end');
  assert.ok(events.indexOf(shown[0]!) > turnEndIndex, 'the notice follows the turn-end');
  bridge.dispose();
});

test('a hub-started turn is not user-initiated, so it never offers a resend', () => {
  const { bridge, agentEvent, failures } = chat();
  agentEvent({ type: 'turn-start', turnId: 'turn-2' });
  agentEvent({ type: 'turn-end', turnId: 'turn-2', stopReason: 'failed', errorMessage: 'x', failure: failure({ class: 'unknown', retryable: true }) });
  assert.equal(failures()[0]?.userInitiated, false);
  bridge.dispose();
});

test('a user stop with nothing held gives no notice; a held login failure still explains the stop', () => {
  const plain = chat();
  plain.agentEvent({ type: 'turn-start', turnId: 'turn-1' });
  plain.agentEvent({ type: 'turn-end', turnId: 'turn-1', stopReason: 'interrupted' });
  assert.deepEqual(plain.failures(), []);
  plain.bridge.dispose();

  const auth = chat();
  auth.agentEvent({ type: 'turn-start', turnId: 'turn-1' });
  auth.agentEvent({ type: 'error', message: '401', failure: failure({ class: 'auth_required', message: '401', code: 'codex:unauthorized' }) });
  auth.agentEvent({ type: 'turn-end', turnId: 'turn-1', stopReason: 'interrupted' });
  assert.deepEqual(auth.failures().map((event) => event.failure.class), ['auth_required']);
  auth.bridge.dispose();
});

test('a stale turn-end from an older turn produces no notice', () => {
  const { bridge, agentEvent, failures } = chat();
  agentEvent({ type: 'turn-start', turnId: 'turn-new' });
  agentEvent({ type: 'turn-end', turnId: 'turn-old', stopReason: 'failed', errorMessage: 'late', failure: failure() });
  assert.deepEqual(failures(), []);
  assert.equal(bridge.isTurnRunning(), true, 'the newer turn is still running');
  bridge.dispose();
});

test('an error outside a turn is shown at once', () => {
  const { bridge, agentEvent, failures } = chat();
  agentEvent({ type: 'error', message: 'background', failure: failure({ class: 'provider_error', message: 'background', retryable: true }) });
  assert.deepEqual(failures().map((event) => [event.origin, event.failure.class]), [['idle', 'provider_error']]);
  bridge.dispose();
});

test('older hub frames without failure are classified locally, still as one notice', () => {
  const { bridge, agentEvent, failures } = chat();
  agentEvent({ type: 'turn-start', turnId: 'turn-1' });
  agentEvent({ type: 'error', message: 'Invalid API key · Please run /login' });
  agentEvent({ type: 'turn-end', turnId: 'turn-1', stopReason: 'failed', errorMessage: 'Invalid API key · Please run /login' });
  assert.deepEqual(failures().map((event) => event.failure.class), ['auth_required']);

  agentEvent({ type: 'turn-start', turnId: 'turn-2' });
  agentEvent({ type: 'turn-end', turnId: 'turn-2', stopReason: 'failed', errorMessage: 'Bearer abcdefghijklmnop1234 something odd' });
  const last = failures().at(-1)!;
  assert.equal(last.failure.class, 'unknown');
  assert.doesNotMatch(last.failure.message, /abcdefghijklmnop1234/, 'credential shapes are removed from older hub text');

  // 어댑터 단서 모양이 새어 와도 실패로 받지 않는다.
  agentEvent({ type: 'turn-start', turnId: 'turn-3' });
  agentEvent({ type: 'turn-end', turnId: 'turn-3', stopReason: 'failed', errorMessage: 'odd', failure: { source: 'pi', code: 'process_exit' } });
  assert.equal(failures().at(-1)!.failure.class, 'unknown');
  bridge.dispose();
});

test('a successful turn gives no notice', () => {
  const { bridge, agentEvent, failures } = chat();
  agentEvent({ type: 'turn-start', turnId: 'turn-1' });
  agentEvent({ type: 'turn-end', turnId: 'turn-1', stopReason: 'end_turn' });
  assert.deepEqual(failures(), []);
  bridge.dispose();
});

test('a failed turn that already wrote to the document says so', async () => {
  const { env, bridge, internals, frame, agentEvent, failures } = chat();
  internals.messageAwaitingTurn = true;
  agentEvent({ type: 'turn-start', turnId: 'turn-1' });
  frame({
    type: 'tool-request', id: 1, tool: 'insert_text', agent: 'claude', turnBound: true, providerTurnId: 'turn-1',
    args: { expectedRevision: bridge.getDocumentSelectionIdentity().revision, sectionIdx: 0, paraIdx: 0, charOffset: env.body[0]!.length, text: ' world' },
  });
  await settle();
  assert.equal(internals.toolResponses.drain().find((response) => response.id === 1)?.ok, true);
  agentEvent({ type: 'turn-end', turnId: 'turn-1', stopReason: 'exited', failure: failure({ class: 'process_exited', code: null, retryable: true }) });
  assert.equal(failures()[0]?.wroteDocument, true);

  agentEvent({ type: 'turn-start', turnId: 'turn-2' });
  agentEvent({ type: 'turn-end', turnId: 'turn-2', stopReason: 'exited', failure: failure({ class: 'process_exited', code: null, retryable: true }) });
  assert.equal(failures()[1]?.wroteDocument, false, 'each turn starts clean');
  bridge.dispose();
});

test('chat-error: a matched chat start is origin start, a rejected message is origin send, other codes carry no failure', () => {
  const { bridge, internals, events, frame } = chat();
  bridge.startChat('codex', 'gpt-5.6-sol', 'medium');
  const requestId = internals.pendingChatStart!.requestId;
  frame({ type: 'chat-error', requestId, session: null, code: 'AGENT_SPAWN_FAILED', message: 'spawn failed' });
  frame({
    type: 'chat-error', code: 'AGENT_AUTH_REQUIRED', message: 'Claude 로그인이 필요합니다.',
    failure: failure({ class: 'auth_required', message: 'Claude 로그인이 필요합니다.', code: 'AGENT_AUTH_REQUIRED' }),
  });
  frame({ type: 'chat-error', code: 'AGENT_BUSY', message: 'A turn is already in progress.' });
  const hubErrors = events.filter((event): event is Extract<SidebarEvent, { type: 'hub-error' }> => event.type === 'hub-error');
  assert.deepEqual(hubErrors.map((event) => [event.code, event.origin ?? null, event.failure?.class ?? null]), [
    ['AGENT_SPAWN_FAILED', 'start', 'process_exited'],
    ['AGENT_AUTH_REQUIRED', 'send', 'auth_required'],
    ['AGENT_BUSY', null, null],
  ]);
  assert.equal(hubErrors[0]!.failure!.agent, 'codex', 'an older hub start failure is attributed to the starting agent');
  bridge.dispose();
});
