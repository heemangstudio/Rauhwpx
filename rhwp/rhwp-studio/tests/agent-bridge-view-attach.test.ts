/**
 * 문서 세션 브리지를 화면에서 떼고 붙이기 — 화면 밖에서도 턴·도구·대기 편집이 그대로 돌고,
 * 기록은 헤드리스 편집기로, 표시·편집 잠금은 화면에 붙은 동안만 나가는지 본다.
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

/** 오버레이가 쓰는 만큼만 흉내 낸 DOM 요소. */
class FakeElement {
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  className = '';
  hidden = false;
  textContent = '';
  clientWidth = 800;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = { add() {}, remove() {} };
  setAttribute() {}
  addEventListener() {}
  removeEventListener() {}
  getBoundingClientRect() { return { left: 0, top: 0 }; }
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

const scrollContent = new FakeElement();
const keydownListeners = new Set<unknown>();
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
    getElementById: (id: string) => (id === 'scroll-content' ? scrollContent : null),
    addEventListener: (type: string, listener: unknown) => { if (type === 'keydown') keydownListeners.add(listener); },
    removeEventListener: (type: string, listener: unknown) => { if (type === 'keydown') keydownListeners.delete(listener); },
  },
});

const { AgentBridgeImpl } = await import('../src/agent/bridge.ts');
const { EventBus } = await import('../src/core/event-bus.ts');
const { AGENT_PROTOCOL_VERSION } = await import('../src/agent/types.ts');
const { makeEnv } = await import('./agent-test-env.ts');

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function editorHost(records: string[], selection: boolean) {
  const cursor = { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 };
  return {
    getCursorPosition: () => cursor,
    executeOperation: (op: { kind: string }) => { records.push(op.kind); },
    prepareSnapshotCapacity: () => {},
    retainExternalSnapshot: () => {},
    releaseExternalSnapshot: () => {},
    ...(selection ? { getUserSelectionContext: () => ({ cursor, selection: null }) } : {}),
  };
}

function fixture() {
  const { wasm } = makeEnv(['Hello'], (fake) => {
    // 오버레이가 그릴 수 있도록 rect 프로브를 단다 — 한 쪽 한 줄.
    fake.getSelectionRects = () => [{ pageIndex: 0, x: 10, y: 20, width: 40, height: 12 }];
    fake.getCursorRect = () => ({ pageIndex: 0, x: 50, y: 20, height: 12 });
  });
  const canvasView = {
    getViewportManager: () => ({
      getZoom: () => 1,
      getViewportSize: () => ({ width: 800, height: 600 }),
      getScrollX: () => 0,
      getScrollY: () => 0,
      setScrollTop: () => {},
    }),
    getVirtualScroll: () => ({
      pageCount: 1,
      getPageLeft: () => 0,
      getPageWidth: () => 800,
      getPageOffset: () => 0,
      getPageWindow: () => ({ prefetch: [0] }),
    }),
  };
  const viewRecords: string[] = [];
  const headlessRecords: string[] = [];
  const inputHandler = editorHost(viewRecords, true);
  const headless = editorHost(headlessRecords, false);
  const view = { inputHandler: inputHandler as never, canvasView: canvasView as never };
  const bridge = new AgentBridgeImpl({
    wasm: wasm as never,
    eventBus: new EventBus(),
    documentState: { isDirty: () => false } as never,
    editor: inputHandler as never,
    view,
  }, {
    // 허브 없이 돌린다 — 세션 구성이 오지 않아 소켓을 열지 않는다.
    resolveSessionContext: () => new Promise(() => {}),
  });
  const leases: Array<{ active: boolean }> = [];
  bridge.onEditingLeaseChange((lease) => leases.push(lease));
  const internals = bridge as unknown as {
    handleFrame(data: string): void;
    toolResponses: { drain(): Array<{ id: number; ok: boolean; result?: Record<string, unknown> }> };
  };
  const frame = (msg: Record<string, unknown>) => internals.handleFrame(JSON.stringify({ v: AGENT_PROTOCOL_VERSION, ...msg }));
  let toolId = 0;
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const id = ++toolId;
    frame({ type: 'tool-request', id, tool: name, args, agent: 'claude', turnBound: true, providerTurnId: 'turn-1' });
    await settle();
    const response = internals.toolResponses.drain().find((entry) => entry.id === id);
    assert.ok(response?.ok, `${name} 응답: ${JSON.stringify(response)}`);
    return response.result!;
  };
  const turnStart = () => frame({ type: 'agent-event', event: { type: 'turn-start', agent: 'claude', turnId: 'turn-1' } });
  const turnEnd = () => frame({ type: 'agent-event', event: { type: 'turn-end', agent: 'claude', turnId: 'turn-1', stopReason: 'end_turn' } });
  const insert = (text: string) => tool('insert_text', {
    expectedRevision: bridge.getDocumentSelectionIdentity().revision,
    sectionIdx: 0, paraIdx: 0, charOffset: 5, text,
  });
  const painted = () => scrollContent.children.flatMap((layer) => layer.children)
    .filter((node) => node.className.includes('ag-pending-marker')).length;
  return { bridge, frame, view, headless, viewRecords, headlessRecords, leases, tool, turnStart, turnEnd, insert, painted };
}

test('reopening a chat settles the old turn when its welcome snapshot was skipped', () => {
  const f = fixture();
  try {
    f.bridge.startChat('codex', undefined, undefined, false, 'safe', 'direct', 'resumed-thread');
    f.frame({ type: 'chat-started', agent: 'codex', threadId: 'resumed-thread' });
    f.frame({ type: 'agent-event', event: { type: 'turn-start', agent: 'codex', turnId: 'old-turn' } });
    assert.equal(f.bridge.isTurnRunning(), true);

    // 재연결 직후 보낸 chat-start가 있으므로 welcome은 의도적으로 건너뛴다.
    f.bridge.startChat('codex', undefined, undefined, true, 'safe', 'direct', 'resumed-thread');
    f.frame({ type: 'welcome', session: { agent: 'codex', threadId: 'resumed-thread', status: 'idle' } });
    assert.equal(f.bridge.isTurnRunning(), true);
    f.frame({ type: 'chat-started', agent: 'codex', threadId: 'resumed-thread', status: 'idle', turnId: null });

    assert.equal(f.bridge.isTurnRunning(), false, '새 세션은 사라진 턴의 종료 이벤트를 기다리지 않는다');
    assert.equal(f.bridge.getEditingLease().active, false);
    assert.equal(f.bridge.pendingEdits.getChangeSets().some((set) => set.status === 'open'), false);
  } finally {
    f.bridge.dispose();
  }
});

test('reopening a running chat restores its turn identity and rejects an older turn end', () => {
  const f = fixture();
  try {
    f.bridge.startChat('codex', undefined, undefined, false, 'safe', 'direct', 'resumed-thread');
    f.frame({ type: 'chat-started', agent: 'codex', threadId: 'resumed-thread', status: 'running', turnId: 'resumed-turn' });
    assert.equal(f.bridge.isTurnRunning(), true);
    assert.equal(f.bridge.getEditingLease().active, true);

    f.frame({ type: 'agent-event', event: { type: 'turn-end', agent: 'codex', turnId: 'older-turn', stopReason: 'interrupted' } });
    assert.equal(f.bridge.isTurnRunning(), true, '과거 턴의 종료는 복원된 실행을 끄지 않는다');
    f.frame({ type: 'agent-event', event: { type: 'turn-end', agent: 'codex', turnId: 'resumed-turn', stopReason: 'interrupted' } });
    assert.equal(f.bridge.isTurnRunning(), false);
    assert.equal(f.bridge.getEditingLease().active, false);
  } finally {
    f.bridge.dispose();
  }
});

test('an idle replacement preserves edits from the lost turn for review', async () => {
  const f = fixture();
  try {
    f.bridge.startChat('claude', undefined, undefined, false, 'safe', 'direct', 'resumed-thread');
    f.frame({ type: 'chat-started', agent: 'claude', threadId: 'resumed-thread' });
    f.turnStart();
    await f.insert(' world');
    f.bridge.startChat('claude', undefined, undefined, true, 'safe', 'direct', 'resumed-thread');
    f.frame({ type: 'chat-started', agent: 'claude', threadId: 'resumed-thread', status: 'idle', turnId: null });

    const [set] = f.bridge.pendingEdits.getChangeSets();
    assert.equal(set.status, 'awaiting-review');
    assert.equal(set.turnStopped, true);
    assert.equal(set.ops.length, 1, '문서에 적용한 편집은 복원 과정에서 버리지 않는다');
    assert.equal(f.bridge.isBusy(), true, '종료된 턴의 검토는 사용자가 마무리한다');
  } finally {
    f.bridge.dispose();
  }
});

test('detached bridge runs the turn against the headless editor and never locks or paints the view', async () => {
  const f = fixture();
  f.bridge.detachView(f.headless);
  assert.equal(f.bridge.isViewAttached(), false);

  f.turnStart();
  assert.equal(f.bridge.getEditingLease().active, false, '화면 밖 턴은 보이는 편집기를 잠그지 않는다');
  assert.equal(f.leases.some((lease) => lease.active), false);

  const selection = await f.tool('get_selection');
  assert.equal(selection.hasSelection, false);
  assert.equal(selection.visible, false);

  await f.insert(' world');
  f.turnEnd();
  const [set] = f.bridge.pendingEdits.getChangeSets();
  assert.equal(set?.status, 'awaiting-review');
  assert.equal(f.painted(), 0, '화면 밖 대기 편집은 캔버스에 그리지 않는다');

  assert.equal(f.bridge.pendingEdits.approve(set.id), true);
  assert.deepEqual(f.headlessRecords, ['record'], '승인 기록은 세션 히스토리(헤드리스 편집기)로 간다');
  assert.deepEqual(f.viewRecords, [], '보이는 편집기의 히스토리에는 남지 않는다');
  f.bridge.dispose();
});

test('attaching repaints the pending set and restores the lease; detaching removes both', async () => {
  const f = fixture();
  f.bridge.detachView(f.headless);
  f.turnStart();
  await f.insert(' world');
  assert.equal(f.painted(), 0);

  f.bridge.attachView(f.view);
  assert.ok(f.painted() > 0, '다시 붙으면 그동안 쌓인 대기 편집을 그린다');
  assert.equal(keydownListeners.size, 1);
  assert.equal(f.leases.at(-1)?.active, true, '붙을 때 이 문서의 턴 잠금을 다시 알린다');
  const selection = await f.tool('get_selection');
  assert.ok(selection.cursor, '붙은 동안은 사용자 커서를 읽는다');

  f.bridge.detachView(f.headless);
  assert.equal(scrollContent.children.length, 0, '떼면 표시 층을 DOM 에서 걷는다');
  assert.equal(keydownListeners.size, 0);
  assert.equal(f.leases.at(-1)?.active, false, '떼면 보이는 편집기의 잠금을 푼다');
  f.bridge.dispose();
});

test('busy covers the turn and the review that follows, and clears once the review settles', async () => {
  const f = fixture();
  const changes: boolean[] = [];
  f.bridge.onBusyChange((busy) => changes.push(busy));
  assert.equal(f.bridge.isBusy(), false);

  f.turnStart();
  await f.insert(' world');
  assert.equal(f.bridge.isBusy(), true);
  f.turnEnd();
  await settle();
  assert.equal(f.bridge.isBusy(), true, '턴이 끝나도 검토 대기 편집이 있으면 바쁘다');
  assert.deepEqual(changes, [true], '턴 종료와 검토 대기 사이에 한가함을 흘리지 않는다');

  const [set] = f.bridge.pendingEdits.getChangeSets();
  f.bridge.pendingEdits.reject(set.id);
  await settle();
  assert.equal(f.bridge.isBusy(), false);
  assert.deepEqual(changes, [true, false]);
  f.bridge.dispose();
});
