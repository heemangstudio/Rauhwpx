/**
 * 실제 브리지가 턴 체크포인트를 남기는지 — main.ts 처럼 문서 세션의 저장소를 브리지에 넘기고,
 * 사이드바처럼 turn-start 에 요청을 알린다. 편집기 대역은 실제 CommandHistory 에 기록한다.
 * 에이전트 모드(승인)와 전체 모드(쓰기마다 확정) 모두 "이 작업 전으로 되돌리기"가 턴의 첫
 * 쓰기 전 문서로 돌아가고, 실행 취소 한 번으로 에이전트의 작업이 돌아와야 한다.
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

const { AgentBridgeImpl, DOCUMENT_RESTORED_NOTICE } = await import('../src/agent/bridge.ts');
const { EventBus } = await import('../src/core/event-bus.ts');
const { AGENT_PROTOCOL_VERSION } = await import('../src/agent/types.ts');
const { TurnCheckpoints, restoreTurn } = await import('../src/agent/turn-checkpoints.ts');
const { makeEnv } = await import('./agent-test-env.ts');
const { loadCommandHistory } = await import('./command-history-loader.ts');

const CommandHistory = loadCommandHistory();
const THREAD = 'thread-restore';
const cursor = { sectionIndex: 0, paragraphIndex: 0, charOffset: 0 };

interface ToolResponse { id: number; ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } }

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** 문서 세션 하나와 그 채팅 하나 — main.ts installChatAgent 와 같은 배선. */
function sessionFixture(permissionProfile: 'safe' | 'unrestricted') {
  let savedSnapshots = 0;
  const env = makeEnv(['Hello'], (fake) => {
    Object.defineProperty(fake, 'documentInstance', { value: 7 });
    const save = fake.saveSnapshot as () => number;
    fake.saveSnapshot = () => { savedSnapshots += 1; return save(); };
  });
  const wasm = env.wasm as unknown as {
    saveSnapshot(): number;
    restoreSnapshot(id: number): void;
    discardSnapshot(id: number): void;
  };
  const history = new CommandHistory();
  const bus = new EventBus();
  const store = new TurnCheckpoints({ engine: env.wasm as never, history: () => history as never, eventBus: bus });
  // 편집기 대역: 승인 기록과 예산을 실제 히스토리로 보낸다 (HeadlessEditorHost 와 같은 몫).
  const editor = {
    getCursorPosition: () => cursor,
    executeOperation: (op: { kind: string; command?: unknown }) => {
      if (op.kind === 'record') history.recordWithoutExecute(op.command, wasm);
    },
    prepareSnapshotCapacity: (n: number) => history.prepareSnapshotCapacity(wasm, n),
    retainExternalSnapshot: (n?: number) => history.retainExternalSnapshot(n),
    releaseExternalSnapshot: (n?: number) => history.releaseExternalSnapshot(n),
  };
  const bridge = new AgentBridgeImpl({
    wasm: env.wasm as never,
    eventBus: bus,
    documentState: { isDirty: () => false } as never,
    editor: editor as never,
    view: null,
    turnCheckpoints: store,
  }, {
    // 허브 없이 돌린다 — 세션 구성이 오지 않아 소켓을 열지 않는다.
    resolveSessionContext: () => new Promise(() => {}),
  });
  const internals = bridge as unknown as {
    handleFrame(data: string): void;
    toolResponses: { drain(): ToolResponse[] };
  };
  const frame = (msg: Record<string, unknown>) => internals.handleFrame(JSON.stringify({ v: AGENT_PROTOCOL_VERSION, ...msg }));
  frame({ type: 'chat-started', agent: 'claude', sessionId: 's', threadId: THREAD, permissionProfile, workflow: 'direct', phase: 'direct' });

  // 사이드바처럼 turn-start 에 지금 보이는 스레드의 마지막 요청을 알린다.
  let requestKey: string | null = null;
  let shownThread = THREAD;
  bridge.onEvent((event) => {
    if (event.type === 'agent' && event.event.type === 'turn-start') store.noteTurnStart(shownThread, requestKey);
  });
  let toolId = 0;
  let turn = 0;
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const id = ++toolId;
    frame({ type: 'tool-request', id, tool: name, args, agent: 'claude', turnBound: true, providerTurnId: `turn-${turn}` });
    await settle();
    const response = internals.toolResponses.drain().find((entry) => entry.id === id);
    assert.ok(response?.ok, `${name}: ${JSON.stringify(response)}`);
    return response;
  };
  const revision = () => bridge.getDocumentSelectionIdentity().revision;
  return {
    env,
    history,
    store,
    bridge,
    savedSnapshots: () => savedSnapshots,
    /** 사용자가 요청을 보내고 그 턴이 시작된다. */
    startTurn(key: string) {
      requestKey = key;
      turn += 1;
      frame({ type: 'agent-event', event: { type: 'turn-start', agent: 'claude', turnId: `turn-${turn}` } });
    },
    endTurn() {
      frame({ type: 'agent-event', event: { type: 'turn-end', agent: 'claude', turnId: `turn-${turn}`, stopReason: 'end_turn' } });
    },
    append: (text: string) => tool('insert_text', {
      expectedRevision: revision(), sectionIdx: 0, paraIdx: 0, charOffset: env.body[0]!.length, text,
    }),
    read: () => tool('get_structure', { expectedRevision: revision() }),
    /** main.ts 의 restoreTurn 과 같은 문 — 문서 전체를 되돌리고 실행 취소 한 단계를 남긴다. */
    restore: (key: string) => {
      const result = restoreTurnWithGates(key);
      // main.ts 처럼 되돌린 스레드의 다음 요청에 안내를 붙이고, 되돌리기를 실행 취소하면 거둔다.
      if (result.ok) bridge.noteDocumentRestored(THREAD, () => store.restoreStillApplies(THREAD, key));
      return result;
    },
    /** 허브에 붙은 채팅처럼 나가는 프레임을 모은다. */
    connect() {
      const frames: Array<{ type: string; text?: string; threadId?: string }> = [];
      const internals = bridge as unknown as { state: string; sendJson(frame: unknown): boolean };
      internals.state = 'connected';
      internals.sendJson = (out) => {
        frames.push(out as { type: string; text?: string });
        return true;
      };
      return {
        frames,
        texts: () => frames.filter((out) => out.type === 'chat-user-message').map((out) => out.text),
      };
    },
    /** 한 채팅만 띄우는 호스트의 스레드 전환 — 채팅을 멈추고 다른 스레드로 다시 연다. */
    switchThread(threadId: string, started = true) {
      bridge.stopChat();
      bridge.startChat('claude', undefined, undefined, false, permissionProfile, 'direct', threadId);
      shownThread = threadId;
      if (started) frame({ type: 'chat-started', agent: 'claude', sessionId: `s-${threadId}`, threadId, permissionProfile, workflow: 'direct', phase: 'direct' });
    },
    /** 허브가 방금 보낸 사용자 메시지를 거절한다. */
    reject(code = 'AGENT_BUSY', message = 'A turn is already in progress.') {
      frame({ type: 'chat-error', code, message });
    },
  };
  function restoreTurnWithGates(key: string) {
    return restoreTurn(store, THREAD, key, {
      engineStopped: () => false,
      documentShown: () => true,
      turnRunning: () => bridge.isTurnRunning(),
      reviewPending: () => bridge.pendingEdits.hasPending(),
      readOnly: () => false,
      apply: (snapshotId) => {
        const before = wasm.saveSnapshot();
        wasm.restoreSnapshot(snapshotId);
        const after = wasm.saveSnapshot();
        history.recordWithoutExecute({
          type: 'snapshot:agent:restore_turn',
          execute(target: typeof wasm) { target.restoreSnapshot(after); return cursor; },
          undo(target: typeof wasm) { target.restoreSnapshot(before); return cursor; },
          mergeWith() { return null; },
          snapshotResourceCount() { return 2; },
          discard(target: typeof wasm) { target.discardSnapshot(before); target.discardSnapshot(after); },
        }, wasm);
      },
    });
  }
}

test('에이전트: an approved turn restores to the text before its first write, and undo brings it back', async () => {
  const s = sessionFixture('safe');
  s.startTurn('request-1');
  await s.append(' world');
  await s.append('!');
  assert.equal(s.env.body[0], 'Hello world!');
  s.endTurn();
  await settle();
  assert.equal(s.store.status(THREAD, 'request-1').kind, 'none', 'nothing to restore while the edits wait for review');

  const refused = s.restore('request-1');
  assert.deepEqual(refused, { ok: false, reason: 'review-pending' });
  assert.equal(s.env.body[0], 'Hello world!');

  for (const set of s.bridge.pendingEdits.getChangeSets()) s.bridge.pendingEdits.approve(set.id);
  await settle();
  assert.deepEqual(s.store.status(THREAD, 'request-1'), { kind: 'ready', laterEdits: false, alreadyRestored: false });

  assert.deepEqual(s.restore('request-1'), { ok: true });
  assert.equal(s.env.body[0], 'Hello');
  s.history.undo(s.env.wasm);
  assert.equal(s.env.body[0], 'Hello world!', 'undo brings the agent\'s work back');
  s.history.redo(s.env.wasm);
  assert.equal(s.env.body[0], 'Hello');
  s.bridge.dispose();
});

test('전체: two writes in one turn are one restore point, counted as the turn\'s own commits', async () => {
  const s = sessionFixture('unrestricted');
  s.startTurn('request-1');
  await s.append(' world');
  await s.append('!');
  s.endTurn();
  await settle();
  assert.equal(s.bridge.pendingEdits.hasPending(), false, '전체 writes never wait for review');
  assert.deepEqual(s.store.status(THREAD, 'request-1'), { kind: 'ready', laterEdits: false, alreadyRestored: false },
    'both direct commits belong to the turn');

  assert.deepEqual(s.restore('request-1'), { ok: true });
  assert.equal(s.env.body[0], 'Hello');
  s.history.undo(s.env.wasm);
  assert.equal(s.env.body[0], 'Hello world!');
  s.bridge.dispose();
});

test('a rejected turn leaves no action, and a read-only turn takes no snapshot', async () => {
  const s = sessionFixture('safe');
  s.startTurn('request-1');
  await s.read();
  s.endTurn();
  await settle();
  assert.equal(s.savedSnapshots(), 0, 'a turn that only reads costs nothing');
  assert.equal(s.store.status(THREAD, 'request-1').kind, 'none');

  s.startTurn('request-2');
  await s.append(' world');
  s.endTurn();
  await settle();
  for (const set of s.bridge.pendingEdits.getChangeSets()) s.bridge.pendingEdits.reject(set.id);
  await settle();
  assert.equal(s.env.body[0], 'Hello');
  assert.deepEqual(s.store.status(THREAD, 'request-2'), { kind: 'none' });
  assert.equal(s.history.hasSnapshotCapacity(98), true, 'the rejected turn holds no budget');
  s.bridge.dispose();
});

test('a later turn makes the earlier restore ask for confirmation, and a running turn refuses', async () => {
  const s = sessionFixture('unrestricted');
  s.startTurn('request-1');
  await s.append(' one');
  s.endTurn();
  await settle();
  s.startTurn('request-2');
  await s.append(' two');
  assert.equal(s.store.status(THREAD, 'request-2').kind, 'none', 'the running request offers nothing yet');
  assert.deepEqual(s.restore('request-1'), { ok: false, reason: 'running' });
  assert.equal(s.env.body[0], 'Hello one two');
  s.endTurn();
  await settle();
  assert.deepEqual(s.store.status(THREAD, 'request-1'), { kind: 'ready', laterEdits: true, alreadyRestored: false });
  assert.deepEqual(s.store.status(THREAD, 'request-2'), { kind: 'ready', laterEdits: false, alreadyRestored: false });
  assert.deepEqual(s.restore('request-1'), { ok: true });
  assert.equal(s.env.body[0], 'Hello', 'restoring the first request drops the later one too');
  s.bridge.dispose();
});

test('a chat-start failure closes the turn so its checkpoint settles', async () => {
  const s = sessionFixture('unrestricted');
  s.startTurn('request-1');
  await s.append(' world');
  // 허브가 프로바이더 교체에 실패했다 — 그 턴의 turn-end 는 오지 않는다.
  (s.bridge as unknown as { pendingChatStart: unknown }).pendingChatStart = { requestId: 'restart' };
  (s.bridge as unknown as { handleFrame(data: string): void }).handleFrame(JSON.stringify({
    v: AGENT_PROTOCOL_VERSION, type: 'chat-error', code: 'BACKEND_SWITCH_FAILED', message: 'failed',
  }));
  await settle();
  assert.equal(s.store.status(THREAD, 'request-1').kind, 'ready', 'the committed write can be restored');
  s.bridge.dispose();
});

test('the next request after a restore tells the agent the document was restored, once', async () => {
  const s = sessionFixture('unrestricted');
  s.startTurn('request-1');
  await s.append(' world');
  s.endTurn();
  await settle();
  assert.deepEqual(s.restore('request-1'), { ok: true });

  // 허브로 나가는 프레임을 받아 본다 (연결된 채팅처럼).
  const frames: Array<{ type: string; text?: string }> = [];
  let online = false;
  const internals = s.bridge as unknown as { state: string; sendJson(frame: unknown): boolean };
  internals.state = 'connected';
  internals.sendJson = (frame) => {
    if (online) frames.push(frame as { type: string; text?: string });
    return online;
  };
  // 보내지 못한 메시지는 안내를 쓰지 않는다 — 다음에 실제로 나가는 메시지가 가져간다.
  void s.bridge.sendUserMessage('다시 해 주세요');
  online = true;
  void s.bridge.sendUserMessage('다시 해 주세요');
  void s.bridge.sendUserMessage('그리고 이것도');
  await settle();
  const texts = frames.filter((frame) => frame.type === 'chat-user-message').map((frame) => frame.text);
  assert.deepEqual(texts, [`${DOCUMENT_RESTORED_NOTICE}\n\n다시 해 주세요`, '그리고 이것도']);
  s.bridge.dispose();
});

test('a turn that ends after the chat moved to another thread still settles its own checkpoint', async () => {
  const s = sessionFixture('unrestricted');
  s.startTurn('request-1');
  await s.append(' world');
  s.connect();
  // 턴이 도는 동안 다른 채팅을 열었다 — 브리지는 허브의 turn-end 를 기다리는 사이 새 스레드로 옮겨 간다.
  s.switchThread('thread-other', false);
  s.endTurn();
  await settle();
  assert.deepEqual(s.store.status(THREAD, 'request-1'), { kind: 'ready', laterEdits: false, alreadyRestored: false },
    'the late end closes the record of the thread the turn ran in');

  // turn-end 가 끝내 오지 않아도 다음 스레드의 턴이 시작되면 앞 턴의 기록을 닫는다.
  const lost = sessionFixture('unrestricted');
  lost.startTurn('request-1');
  await lost.append(' world');
  lost.connect();
  lost.switchThread('thread-other');
  lost.startTurn('request-2');
  await settle();
  assert.equal(lost.store.status(THREAD, 'request-1').kind, 'ready');
  s.bridge.dispose();
  lost.bridge.dispose();
});

test('the restored notice goes only to the restored thread and is dropped when the chat moves on', async () => {
  const s = sessionFixture('unrestricted');
  s.startTurn('request-1');
  await s.append(' world');
  s.endTurn();
  await settle();
  const out = s.connect();
  // 다른 스레드의 요청을 되돌린 안내는 이 스레드의 메시지에 붙지 않는다.
  s.bridge.noteDocumentRestored('thread-elsewhere');
  void s.bridge.sendUserMessage('이 채팅의 요청');
  await settle();
  assert.deepEqual(out.texts(), ['이 채팅의 요청']);
  out.frames.length = 0;
  assert.deepEqual(s.restore('request-1'), { ok: true });
  s.switchThread('thread-other');
  void s.bridge.sendUserMessage('다른 채팅의 요청');
  s.switchThread(THREAD);
  void s.bridge.sendUserMessage('돌아와서 보낸 요청');
  await settle();
  assert.deepEqual(out.texts(), ['다른 채팅의 요청', '돌아와서 보낸 요청']);
  s.bridge.dispose();
});

test('a refused message gives the restored notice back to the next one', async () => {
  const s = sessionFixture('unrestricted');
  s.startTurn('request-1');
  await s.append(' world');
  s.endTurn();
  await settle();
  const out = s.connect();
  assert.deepEqual(s.restore('request-1'), { ok: true });
  void s.bridge.sendUserMessage('다시 해 주세요');
  await settle();
  s.reject();
  void s.bridge.sendUserMessage('다시 해 주세요');
  void s.bridge.sendUserMessage('그리고 이것도');
  await settle();
  assert.deepEqual(out.texts(), [
    `${DOCUMENT_RESTORED_NOTICE}\n\n다시 해 주세요`,
    `${DOCUMENT_RESTORED_NOTICE}\n\n다시 해 주세요`,
    '그리고 이것도',
  ]);
  s.bridge.dispose();
});

test('undoing the restore withdraws the notice', async () => {
  const s = sessionFixture('unrestricted');
  s.startTurn('request-1');
  await s.append(' world');
  s.endTurn();
  await settle();
  const out = s.connect();
  assert.deepEqual(s.restore('request-1'), { ok: true });
  s.history.undo(s.env.wasm);
  assert.equal(s.env.body[0], 'Hello world');
  void s.bridge.sendUserMessage('이어서 해 주세요');
  await settle();
  assert.deepEqual(out.texts(), ['이어서 해 주세요'], 'the agent\'s edits are back, so nothing was restored');
  s.bridge.dispose();
});

test('a typed plan approval is sent as typed, and the notice waits for the next message', async () => {
  const s = sessionFixture('unrestricted');
  s.startTurn('request-1');
  await s.append(' world');
  s.endTurn();
  await settle();
  const out = s.connect();
  assert.deepEqual(s.restore('request-1'), { ok: true });
  void s.bridge.sendUserMessage('계획을 실행해 주세요.');
  void s.bridge.sendUserMessage('표도 고쳐 주세요');
  await settle();
  assert.deepEqual(out.texts(), ['계획을 실행해 주세요.', `${DOCUMENT_RESTORED_NOTICE}\n\n표도 고쳐 주세요`],
    'the hub must read the approval phrase alone');
  s.bridge.dispose();
});
