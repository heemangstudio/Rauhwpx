/**
 * 허브 거절(chat-error)이 거절한 사용자 메시지의 receipt id 를 hub-error 로 넘기는지 본다.
 * 사이드바의 대기 메시지는 이 id 로 자기 메시지의 거절을 알아보고 대기열에 되돌린다.
 * 소켓 없이 프레임을 바로 넣는다(agent-bridge-view-attach.test.ts 와 같은 구성).
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

/** 브리지가 만드는 표시 층이 쓰는 만큼만 흉내 낸 DOM 요소. */
class FakeElement {
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  className = '';
  hidden = false;
  textContent = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = { add() {}, remove() {} };
  setAttribute() {}
  addEventListener() {}
  removeEventListener() {}
  append(...nodes: FakeElement[]) { for (const node of nodes) this.appendChild(node); }
  appendChild(node: FakeElement) {
    node.parentElement = this;
    this.children.push(node);
    return node;
  }
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

function bridgeWithEvents() {
  const { wasm } = makeEnv(['Hello']);
  const editor = {
    getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    executeOperation: () => {},
    prepareSnapshotCapacity: () => {},
    retainExternalSnapshot: () => {},
    releaseExternalSnapshot: () => {},
  };
  const bridge = new AgentBridgeImpl({
    wasm: wasm as never,
    eventBus: new EventBus(),
    documentState: { isDirty: () => false } as never,
    editor: editor as never,
  }, {
    // 허브 없이 돌린다 — 세션 구성이 오지 않아 소켓을 열지 않는다.
    resolveSessionContext: () => new Promise(() => {}),
  });
  const events: SidebarEvent[] = [];
  bridge.onEvent((event) => events.push(event));
  const frame = (msg: Record<string, unknown>) => (bridge as unknown as { handleFrame(data: string): void })
    .handleFrame(JSON.stringify({ v: AGENT_PROTOCOL_VERSION, ...msg }));
  return { bridge, events, frame };
}

test('a rejected user message carries its receipt id into hub-error', () => {
  const { bridge, events, frame } = bridgeWithEvents();
  frame({ type: 'chat-error', code: 'AGENT_BUSY', message: 'A turn is already in progress.', messageId: 'message-7' });
  const error = events.find((event) => event.type === 'hub-error');
  assert.deepEqual(error, {
    type: 'hub-error',
    code: 'AGENT_BUSY',
    message: 'A turn is already in progress.',
    messageId: 'message-7',
  });
  bridge.dispose();
});

test('a rejection without a receipt id (older hub or plain message) has no messageId', () => {
  const { bridge, events, frame } = bridgeWithEvents();
  frame({ type: 'chat-error', code: 'AGENT_BUSY', message: 'A turn is already in progress.' });
  frame({ type: 'chat-error', code: 'INVALID_REQUEST', message: 'bad', messageId: 42 });
  const errors = events.filter((event) => event.type === 'hub-error');
  assert.equal(errors.length, 2);
  for (const error of errors) assert.equal('messageId' in error, false);
  bridge.dispose();
});

test('a template changed while the hub runs a message travels with the next message instead of a refused frame', () => {
  const { bridge, frame } = bridgeWithEvents();
  frame({ type: 'chat-started', agent: 'claude', sessionId: 's', threadId: 'thread-1', permissionProfile: 'safe', workflow: 'direct', phase: 'direct' });
  const sent: Array<{ type: string; templateId?: string | null; activeTemplateId?: string | null }> = [];
  const internals = bridge as unknown as { state: string; sendJson(frame: unknown): boolean };
  internals.state = 'connected';
  internals.sendJson = (out) => { sent.push(out as (typeof sent)[number]); return true; };
  const types = () => sent.map((out) => out.type);

  void bridge.sendUserMessage('표를 정리해 주세요');
  // 허브는 그 메시지를 돌리지만 turn-start 는 아직 오지 않았다 — 이 틈의 템플릿 바꾸기는 허브가 거절한다.
  bridge.setActiveTemplate(null);
  assert.deepEqual(types(), ['chat-user-message'], 'no template frame for the hub to refuse');
  frame({ type: 'agent-event', event: { type: 'turn-start', agent: 'claude', turnId: 't1' } });
  bridge.setActiveTemplate(null);
  assert.deepEqual(types(), ['chat-user-message'], 'nor while the turn runs');
  frame({ type: 'agent-event', event: { type: 'turn-end', agent: 'claude', turnId: 't1', stopReason: 'end_turn' } });
  void bridge.sendUserMessage('다음 요청');
  const next = sent.at(-1)!;
  assert.equal(next.type, 'chat-user-message');
  assert.equal(next.activeTemplateId, null, 'the next message carries the template the user chose');
  bridge.dispose();
});
