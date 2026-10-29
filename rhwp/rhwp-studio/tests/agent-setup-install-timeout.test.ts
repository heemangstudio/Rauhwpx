/**
 * 프로바이더 설치 요청은 허브가 진행 프레임을 보내는 동안 클라이언트에서 먼저 끝나지 않는다.
 * 예전에는 허브의 설치 제한과 같은 10분에 null 로 끝나 '설치 실패' 를 띄운 뒤, 허브의 완료 방송에 뒤집혔다.
 * 답이 없을 때는 다시 읽은 허브 상태로 결과를 정한다.
 * 소켓 없이 프레임을 바로 넣는다(agent-bridge-hub-error.test.ts 와 같은 구성).
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { mock } from 'node:test';

registerHooks({
  load(url, context, next) {
    return url.endsWith('.css')
      ? { format: 'module', source: 'export default {};', shortCircuit: true }
      : next(url, context);
  },
});

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
const { installOutcomeFromStatus, PendingRequestRegistry } = await import('../src/agent/pending-requests.ts');
const { makeEnv } = await import('./agent-test-env.ts');

const MINUTE = 60_000;

function connectedBridge() {
  const { wasm } = makeEnv(['Hello']);
  const bridge = new AgentBridgeImpl({
    wasm: wasm as never,
    eventBus: new EventBus(),
    documentState: { isDirty: () => false } as never,
    editor: {
      getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
      executeOperation: () => {},
      prepareSnapshotCapacity: () => {},
      retainExternalSnapshot: () => {},
      releaseExternalSnapshot: () => {},
    } as never,
  }, { resolveSessionContext: () => new Promise(() => {}) });
  const sent: Array<{ type: string; requestId?: string }> = [];
  const internals = bridge as unknown as { state: string; sendJson(frame: unknown): boolean; handleFrame(data: string): void };
  internals.state = 'connected';
  internals.sendJson = (frame) => { sent.push(frame as (typeof sent)[number]); return true; };
  const frame = (msg: Record<string, unknown>) => internals.handleFrame(JSON.stringify({ v: AGENT_PROTOCOL_VERSION, ...msg }));
  return { bridge, sent, frame };
}

test('설치가 진행 프레임을 보내는 동안에는 10분을 넘겨도 설치 요청이 끝나지 않고 허브의 답을 받는다', async (t) => {
  const { bridge, sent, frame } = connectedBridge();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled: unknown = 'pending';
  void bridge.installAgent('codex').then((value) => { settled = value; });
  const requestId = sent.find((out) => out.type === 'agent-setup-install')?.requestId;
  assert.ok(requestId);

  // 대기열에서 오래 기다린 뒤 설치가 시작돼 진행 프레임이 이어진다 — 모두 합쳐 30분.
  t.mock.timers.tick(14 * MINUTE);
  for (let minute = 0; minute < 16; minute += 1) {
    frame({ type: 'agent-setup-progress', requestId, agent: 'codex', state: 'installing', phase: 'downloading', activity: true });
    t.mock.timers.tick(MINUTE);
  }
  await Promise.resolve();
  assert.equal(settled, 'pending', '진행 중인 설치를 클라이언트가 먼저 실패로 끝내지 않는다');

  frame({ type: 'agent-setup-status', requestId, statuses: { codex: { installed: true, available: true } } });
  await Promise.resolve();
  assert.notEqual(settled, 'pending');
  assert.equal((settled as Record<string, { installed: boolean }>).codex.installed, true);
  bridge.dispose();
});

test('진행 프레임도 답도 없는 설치 요청은 상한 뒤 null 로 끝난다(대기를 잃지 않는다)', async (t) => {
  const { bridge } = connectedBridge();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled: unknown = 'pending';
  void bridge.installAgent('claude').then((value) => { settled = value; });
  t.mock.timers.tick(60 * MINUTE);
  await Promise.resolve();
  assert.equal(settled, null);
  bridge.dispose();
});

test('touch 는 대기 중인 요청의 시간 제한을 처음부터 다시 잰다', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const registry = new PendingRequestRegistry();
    let value: unknown = 'pending';
    void registry.create('install-1', 1_000).then((result) => { value = result; });
    mock.timers.tick(900);
    assert.equal(registry.touch('install-1'), true);
    mock.timers.tick(900);
    await Promise.resolve();
    assert.equal(value, 'pending');
    mock.timers.tick(200);
    await Promise.resolve();
    assert.equal(value, null);
    assert.equal(registry.size, 0);
    assert.equal(registry.touch('install-1'), false, '끝난 요청은 다시 살리지 않는다');
  } finally {
    mock.timers.reset();
  }
});

test('설치 답이 없으면 다시 읽은 상태로 결과를 정한다 — 아직 설치 중이면 실패로 보이지 않는다', () => {
  assert.equal(installOutcomeFromStatus({ installing: true, installed: false, updateRequired: false }), 'installing');
  assert.equal(installOutcomeFromStatus({ installing: false, installed: true, updateRequired: false }), 'installed');
  assert.equal(installOutcomeFromStatus({ installing: false, installed: true, updateRequired: true }), 'failed');
  assert.equal(installOutcomeFromStatus({ installing: false, installed: false, updateRequired: false }), 'failed');
  assert.equal(installOutcomeFromStatus(null), 'failed', '상태도 못 읽으면 실패로 알린다');
});
