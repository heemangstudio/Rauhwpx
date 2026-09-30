// 턴 스냅샷 — 사용자 메시지에 싣는 문서 읽기의 범위 선택, unchanged 판정, 브리지 전송 순서를 고정한다.
// 잘못된 unchanged 는 모델이 낡은 좌표로 쓰게 만들므로, 에이전트가 본 문서 상태를 잇는 조건을 함께 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// bridge.ts 는 오버레이 css 를 함께 들여온다 — node 테스트에서는 빈 모듈로 대체한다.
registerHooks({
  load(url, context, nextLoad) {
    if (/\.css$/.test(url)) return { format: 'module', source: 'export default {};', shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { AgentBridgeImpl } = await import('../src/agent/bridge.ts');
const { AgentToolExecutor } = await import('../src/agent/tool-executor.ts');
const { SNAPSHOT_MAX_CHARS, TurnSnapshots } = await import('../src/agent/turn-snapshot.ts');
const { makeEnv } = await import('./agent-test-env.ts');

type ReadArgs = { pages?: [number, number]; text?: string };
type ReadReply = { text: string; truncated?: boolean } | Error;

/** 가짜 문서 — contentRevision 은 내용이 마지막으로 바뀐 직후의 revision 이다. */
function fakeDocument(opts: { pages?: number; activePage?: number | null } = {}) {
  const state = {
    revision: 100,
    contentRevision: 100,
    instance: 1,
    pages: opts.pages ?? 3,
    activePage: opts.activePage === undefined ? 0 : opts.activePage,
  };
  const reads: ReadArgs[] = [];
  let reply = (args: ReadArgs): ReadReply => ({
    text: `revision ${state.revision} · ${state.pages} pages${args.pages ? ` · pages ${args.pages[0]}-${args.pages[1]}` : ''}\ns0 p0 (2) 본문`,
  });
  let gate: Promise<void> = Promise.resolve();
  const deps = {
    execute: async (tool: string, args: unknown) => {
      assert.equal(tool, 'get_structure');
      reads.push(args as ReadArgs);
      await gate;
      const answer = reply(args as ReadArgs);
      if (answer instanceof Error) throw answer;
      return {
        revision: state.revision,
        pageCount: state.pages,
        truncated: answer.truncated === true,
        mcpContent: [{ type: 'text', text: answer.text }],
      };
    },
    documentUnchangedSince: (revision: number) => revision >= state.contentRevision,
    revision: () => state.revision,
    pageCount: () => state.pages,
    activePage: () => state.activePage,
    documentInstance: () => state.instance,
  };
  return {
    state, reads, deps,
    replyWith(next: typeof reply) { reply = next; },
    /** 다음 읽기들을 붙잡아 두고, 풀어 주는 함수를 돌려준다. */
    holdReads() {
      let release = () => {};
      gate = new Promise<void>((resolve) => { release = resolve; });
      return release;
    },
    contentEdit() { state.revision += 1; state.contentRevision = state.revision; },
    neutralBump() { state.revision += 1; },
  };
}

test('짧은 문서는 전체를 text:"full" 로 한 번 읽어 싣는다', async () => {
  const doc = fakeDocument({ pages: 12 });
  const snapshot = await new TurnSnapshots(doc.deps).build('claude');
  assert.deepEqual(doc.reads, [{ text: 'full' }]);
  assert.deepEqual(snapshot, { revision: 100, text: 'revision 100 · 12 pages\ns0 p0 (2) 본문' });
});

test('전체 읽기가 잘리거나 넘치면 보고 있는 쪽 전문, 그다음 미리보기, 그래도 넘치면 싣지 않는다', async () => {
  const doc = fakeDocument({ pages: 5, activePage: 2 });
  doc.replyWith((args) => {
    if (!args.pages) return { text: '잘린 전체', truncated: true };
    if (args.text === 'full') return { text: 'x'.repeat(SNAPSHOT_MAX_CHARS + 1) };
    return { text: 'revision 100 · 5 pages · pages 2-2\ns0 p7 (40) 미리보기…' };
  });
  const snapshots = new TurnSnapshots(doc.deps);
  assert.deepEqual(await snapshots.build('claude'), {
    revision: 100, text: 'revision 100 · 5 pages · pages 2-2\ns0 p7 (40) 미리보기…',
  });
  assert.deepEqual(doc.reads, [{ text: 'full' }, { pages: [2, 2], text: 'full' }, { pages: [2, 2] }]);

  doc.replyWith((args) => (args.pages && args.text !== 'full'
    ? { text: '잘린 미리보기', truncated: true }
    : { text: 'x'.repeat(SNAPSHOT_MAX_CHARS + 1) }));
  assert.equal(await snapshots.build('claude'), null);

  doc.replyWith(() => ({ text: 'x'.repeat(SNAPSHOT_MAX_CHARS) }));
  assert.equal((await snapshots.build('claude') as { text: string }).text.length, SNAPSHOT_MAX_CHARS, '상한까지는 싣는다');
});

test('긴 문서는 전체 읽기를 건너뛰고 보고 있는 쪽만 읽는다', async () => {
  const doc = fakeDocument({ pages: 13, activePage: 4 });
  const snapshot = await new TurnSnapshots(doc.deps).build('claude');
  assert.deepEqual(doc.reads, [{ pages: [4, 4], text: 'full' }]);
  assert.match((snapshot as { text: string }).text, /pages 4-4/);
});

test('문서가 없거나 읽기가 실패하거나 보고 있는 쪽을 모르면 스냅샷 없이 보낸다', async () => {
  const empty = fakeDocument({ pages: 0 });
  assert.equal(await new TurnSnapshots(empty.deps).build('claude'), null);
  assert.deepEqual(empty.reads, [], '문서가 없으면 읽지 않는다');

  const failing = fakeDocument();
  failing.replyWith(() => new Error('engine trapped'));
  assert.equal(await new TurnSnapshots(failing.deps).build('claude'), null);

  const throwing = fakeDocument();
  throwing.deps.pageCount = () => { throw new Error('문서가 로드되지 않았습니다'); };
  assert.equal(await new TurnSnapshots(throwing.deps).build('claude'), null);

  // 끝나지 않는 읽기는 시간 상한에서 포기한다.
  const hanging = fakeDocument();
  const release = hanging.holdReads();
  assert.equal(await new TurnSnapshots(hanging.deps, 5).build('claude'), null);
  release();

  const long = fakeDocument({ pages: 40, activePage: null });
  assert.equal(await new TurnSnapshots(long.deps).build('claude'), null);
  const stale = fakeDocument({ pages: 40, activePage: 40 });
  assert.equal(await new TurnSnapshots(stale.deps).build('claude'), null, '쪽 수를 벗어난 활성 쪽은 쓰지 않는다');
  assert.deepEqual(stale.reads, []);
});

test('에이전트가 본 상태 그대로면 unchanged 만, 내용이 바뀌면 새 본문을 싣는다', async () => {
  const doc = fakeDocument();
  const snapshots = new TurnSnapshots(doc.deps);
  const first = await snapshots.build('claude');
  assert.ok(first && 'text' in first);
  assert.ok('text' in (await snapshots.build('claude'))!, '보내지 못한 스냅샷은 본 것으로 치지 않는다');
  snapshots.markSent(first);

  doc.neutralBump(); // 턴 끝 자동 커밋 같은 내용 불변 bump
  const reads = doc.reads.length;
  assert.deepEqual(await snapshots.build('claude'), { revision: 101, unchanged: true });
  assert.equal(doc.reads.length, reads, 'unchanged 는 문서를 읽지 않는다');

  doc.contentEdit(); // 사용자 편집
  const fresh = await snapshots.build('claude');
  assert.deepEqual(fresh, { revision: 102, text: 'revision 102 · 3 pages\ns0 p0 (2) 본문' });
});

test('기억한 revision 은 reset 과 문서 인스턴스 교체에서 사라진다', async () => {
  const doc = fakeDocument();
  const snapshots = new TurnSnapshots(doc.deps);
  snapshots.markSent((await snapshots.build('claude'))!);
  assert.equal(snapshots.agentIsCurrent(), true);

  snapshots.reset(); // 새 채팅·세션 교체
  assert.equal(snapshots.agentIsCurrent(), false);
  const afterReset = await snapshots.build('claude');
  assert.ok(afterReset && 'text' in afterReset);

  snapshots.markSent(afterReset);
  doc.state.instance = 2; // 다른 문서를 열었다 — revision 이 우연히 이어져도 본 적 없는 문서다
  assert.equal(snapshots.agentIsCurrent(), false);
  assert.ok('text' in (await snapshots.build('claude'))!);
});

test('도구 결과는 본 상태를 그 revision 까지 잇고, 문서 revision 이 아닌 값은 무시한다', async () => {
  const doc = fakeDocument();
  const snapshots = new TurnSnapshots(doc.deps);
  snapshots.noteToolResult({ revision: 100 });
  assert.equal(snapshots.agentIsCurrent(), false, '보낸 스냅샷 없이는 이을 상태가 없다');
  snapshots.markSent((await snapshots.build('claude'))!);

  doc.contentEdit(); // 에이전트 자신의 쓰기
  assert.equal(snapshots.agentIsCurrent(), false);
  snapshots.noteToolResult({ revision: 3 }); // 템플릿 revision
  snapshots.noteToolResult({ revision: 999 });
  snapshots.noteToolResult({ applied: 1 });
  assert.equal(snapshots.agentIsCurrent(), false);
  snapshots.noteToolResult({ revision: 101, applied: 1 });
  assert.equal(snapshots.agentIsCurrent(), true);
  assert.deepEqual(await snapshots.build('claude'), { revision: 101, unchanged: true });
});

test('실제 실행기: 본문은 get_structure 도구 결과 그대로이고, 그 revision 으로 첫 쓰기가 통과한 뒤 unchanged 가 된다', async () => {
  const h = makeEnv(['표지 2025. 10.', '본문 문단']);
  const executor = new AgentToolExecutor({
    wasm: h.wasm as never,
    inputHandler: { getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }), getSelection: () => null } as never,
    documentState: { isDirty: () => false } as never,
    revision: h.revision,
    pending: h.pending,
  });
  const snapshots = new TurnSnapshots({
    execute: (tool, args, agent) => executor.execute(tool, args, agent),
    documentUnchangedSince: (revision) => executor.documentUnchangedSince(revision),
    revision: () => h.revision.revision,
    pageCount: () => (h.wasm as { pageCount: number }).pageCount,
    activePage: () => 0,
    documentInstance: () => undefined,
  });

  const first = await snapshots.build('claude');
  assert.ok(first && 'text' in first);
  const tool = await executor.execute('get_structure', { text: 'full' }, 'claude') as { mcpContent: Array<{ text: string }> };
  assert.equal(first.text, tool.mcpContent[0].text);
  assert.match(first.text, /표지 2025\. 10\./);
  snapshots.markSent(first);

  // 턴: 읽지 않고 스냅샷 revision 으로 바로 쓴다.
  h.pending.beginTurn('claude');
  assert.equal(snapshots.agentIsCurrent(), true);
  const write = await executor.execute('insert_text', {
    expectedRevision: first.revision, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: '>',
  }, 'claude') as { revision: number };
  snapshots.noteToolResult(write);
  h.pending.endTurn('commit');
  assert.equal(h.body[0], '>표지 2025. 10.');
  assert.deepEqual(await snapshots.build('claude'), { revision: h.revision.revision, unchanged: true });

  await Promise.resolve();
  h.bus.emit('document-changed'); // 사용자 편집 — 저널에 없는 bump
  const fresh = await snapshots.build('claude');
  assert.ok(fresh && 'text' in fresh && fresh.revision === h.revision.revision);
});

// ─── 브리지 전송 경로 ─────────────────────────────────────

function bridgeFixture(doc = fakeDocument(), overrides: Record<string, unknown> = {}) {
  const bridge = Object.create(AgentBridgeImpl.prototype) as any;
  const frames: any[] = [];
  Object.assign(bridge, {
    state: 'connected', requestSeq: 0, pendingChatStart: null, chatStartSent: false,
    activeAgent: 'claude', selectedAgent: 'claude', selectedModel: null, selectedEffort: null,
    editingAgent: 'claude', permissionProfile: 'unrestricted', serviceTier: 'standard',
    workflow: 'direct', phase: 'direct',
    threadId: 'thread-1', documentId: 'doc-1', documentName: 'a.hwpx', activeTemplateId: null,
    revision: { get revision() { return doc.state.revision; } },
    chatHistory: [], queuedMessages: [], workflowSwitchPending: false,
    turnRunning: false, turnHadError: false, pendingTurnOpen: false,
    activeProviderTurnId: null, interruptedProviderTurnId: null,
    activeToolRequests: 0, activeToolRequestControllers: new Map(),
    pendingUserQuestion: null, pendingQuestionCancellation: null, planExecutionTurn: null,
    pendingInterrupt: false,
    turnSnapshots: new TurnSnapshots(doc.deps),
    sendJson: (frame: unknown) => { frames.push(structuredClone(frame)); return true; },
    sendToolResponse: (frame: unknown) => { frames.push(structuredClone(frame)); },
    emit: () => {},
    syncEditingLease() {}, finishWorkflowSwitch() {}, syncWorkflowState() {}, resetWorkflowState() {},
    clearPendingQuestionCancellation() {}, notifyPlanningDocumentSaved() {},
    abortProviderToolRequests() {}, abortActiveToolRequests() {},
    workflowState: () => ({ workflow: 'direct', phase: 'direct', capabilityEpoch: 1, latestPlan: null }),
    ...overrides,
  });
  const userMessages = () => frames.filter((frame) => frame.type === 'chat-user-message');
  const acknowledgeStart = () => {
    const start = frames.findLast((frame) => frame.type === 'chat-start');
    bridge.handleMessage({
      type: 'chat-started', requestId: start.requestId, agent: start.agent, threadId: start.threadId, sessionId: 'provider-session',
    });
  };
  return { bridge, frames, doc, userMessages, acknowledgeStart };
}

test('사용자 메시지 프레임이 스냅샷을 싣고, 문서가 그대로인 후속 메시지는 unchanged 만 싣는다', async () => {
  const { bridge, doc, userMessages } = bridgeFixture();
  await bridge.sendUserMessage('표지 날짜를 2026. 10. 로 바꿔줘');
  assert.deepEqual(userMessages()[0].documentSnapshot, { revision: 100, text: 'revision 100 · 3 pages\ns0 p0 (2) 본문' });
  assert.equal(userMessages()[0].documentRevision, 100);

  doc.neutralBump();
  await bridge.sendUserMessage('좋아, 다음');
  assert.deepEqual(userMessages()[1].documentSnapshot, { revision: 101, unchanged: true });

  // 스냅샷을 못 만들어도 메시지는 나간다.
  doc.contentEdit();
  doc.replyWith(() => new Error('읽기 실패'));
  await bridge.sendUserMessage('그래도 보낸다');
  assert.equal(userMessages()[2].text, '그래도 보낸다');
  assert.equal('documentSnapshot' in userMessages()[2], false);
});

test('대기열에 있던 메시지는 실제로 보내는 순간의 문서로 스냅샷을 만든다', async () => {
  const { bridge, doc, frames, userMessages, acknowledgeStart } = bridgeFixture(fakeDocument(), { activeAgent: null });
  const sent = bridge.sendUserMessage('연결되면 보내줘');
  assert.deepEqual(frames.map((frame) => frame.type), ['chat-start']);
  assert.deepEqual(doc.reads, [], '대기 중에는 문서를 읽지 않는다');

  doc.contentEdit(); // 대기하는 사이 사용자가 문서를 고쳤다
  acknowledgeStart();
  await sent;
  assert.equal(userMessages().length, 1);
  assert.deepEqual(userMessages()[0].documentSnapshot, { revision: 101, text: 'revision 101 · 3 pages\ns0 p0 (2) 본문' });
  assert.equal(userMessages()[0].documentRevision, 101);
});

test('스냅샷을 만드는 동안 뒤따른 메시지도 보낸 순서대로 나가고, 그 사이 중지한 메시지는 나가지 않는다', async () => {
  const { bridge, doc, userMessages } = bridgeFixture();
  let release = doc.holdReads();
  const first = bridge.sendUserMessage('첫째');
  const second = bridge.sendUserMessage('둘째');
  const third = bridge.sendUserMessage('셋째', undefined, [], true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(userMessages(), [], '첫 메시지의 스냅샷을 기다리는 동안 아무것도 앞지르지 않는다');
  release();
  assert.deepEqual(await Promise.all([first, second, third]), [null, null, 'message-1']);
  assert.deepEqual(userMessages().map((frame) => frame.text), ['첫째', '둘째', '셋째']);
  assert.deepEqual(userMessages().map((frame) => 'text' in frame.documentSnapshot), [true, false, false]);

  doc.contentEdit();
  release = doc.holdReads();
  const stopped = bridge.sendUserMessage('중지될 메시지', undefined, [], true);
  bridge.stopChat();
  release();
  assert.equal(await stopped, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(userMessages().length, 3);
});

test('도구 결과는 실행 직전까지 최신이던 루트 에이전트의 것만 본 상태를 잇는다', async () => {
  const doc = fakeDocument();
  const result: { current: () => unknown } = { current: () => ({ revision: doc.state.revision }) };
  const { bridge, userMessages } = bridgeFixture(doc, {
    turnRunning: true, activeProviderTurnId: 'turn-1',
    executor: { execute: async () => result.current() },
  });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const request = (id: number, extra: Record<string, unknown> = {}) => {
    bridge.handleToolRequest({ id, tool: 'apply_edits', args: {}, agent: 'claude', providerTurnId: 'turn-1', ...extra });
    return settle();
  };
  await bridge.sendUserMessage('고쳐줘');

  // 에이전트의 쓰기 → 턴 끝 커밋: 다음 메시지는 다시 읽히지 않는다.
  result.current = () => { doc.contentEdit(); return { revision: doc.state.revision, applied: 1 }; };
  await request(1);
  doc.neutralBump();
  await bridge.sendUserMessage('다음');
  assert.deepEqual(userMessages()[1].documentSnapshot, { revision: 102, unchanged: true });

  // 사용자 편집을 건너뛴 부분 읽기는 본 상태를 잇지 못한다 — 보지 못한 변경이 unchanged 로 덮이면 안 된다.
  doc.contentEdit();
  result.current = () => ({ revision: doc.state.revision });
  await request(2);
  await bridge.sendUserMessage('또 다음');
  assert.equal(userMessages()[2].documentSnapshot.revision, 103);
  assert.ok('text' in userMessages()[2].documentSnapshot);

  // 서브에이전트(parentTaskId)와 턴 밖 작업자(turnBound:false)의 쓰기는 루트가 본 것이 아니다.
  result.current = () => { doc.contentEdit(); return { revision: doc.state.revision, applied: 1 }; };
  await request(3, { parentTaskId: 'sa-1' });
  await request(4, { turnBound: false });
  await bridge.sendUserMessage('편대 뒤');
  assert.equal(userMessages()[3].documentSnapshot.revision, 105);
  assert.ok('text' in userMessages()[3].documentSnapshot);
});

test('프로바이더 맥락이 끊길 수 있는 지점마다 기억을 버려 문서가 그대로여도 본문을 다시 싣는다', async () => {
  const { bridge, userMessages, acknowledgeStart } = bridgeFixture();
  const sendsFresh = async (label: string) => {
    await bridge.sendUserMessage(label);
    assert.ok('text' in userMessages().at(-1).documentSnapshot, label);
  };
  await sendsFresh('첫 메시지');
  await bridge.sendUserMessage('그대로');
  assert.deepEqual(userMessages().at(-1).documentSnapshot, { revision: 100, unchanged: true });

  // 성공한 턴 끝은 기억을 지키고, 중단된 턴 끝은 버린다.
  bridge.handleAgentEvent({ type: 'turn-end', agent: 'claude', stopReason: 'end_turn' });
  await bridge.sendUserMessage('성공 뒤');
  assert.deepEqual(userMessages().at(-1).documentSnapshot, { revision: 100, unchanged: true });
  bridge.handleAgentEvent({ type: 'turn-end', agent: 'claude', stopReason: 'interrupted' });
  await sendsFresh('중단 뒤');

  bridge.handleMessage({ type: 'chat-error', code: 'AGENT_BUSY', message: 'A turn is already in progress.' });
  await sendsFresh('거절 뒤');

  // 모델·프로바이더 변경: 허브가 새 세션을 띄운다.
  bridge.startChat('codex', 'gpt-5.6-luna', 'low');
  const queued = bridge.sendUserMessage('새 세션');
  acknowledgeStart();
  await queued;
  assert.ok('text' in userMessages().at(-1).documentSnapshot);

  bridge.stopChat();
  assert.equal(bridge.turnSnapshots.agentIsCurrent(), false);
});

test('계획 승인 대기 중에 보낸 스냅샷은 본 것으로 치지 않는다', async () => {
  // 허브가 그 메시지를 승인으로 처리하면 스냅샷은 프로바이더에 닿지 않는다.
  const { bridge, userMessages } = bridgeFixture(fakeDocument(), { workflow: 'plan', phase: 'awaiting-approval' });
  await bridge.sendUserMessage('승인');
  assert.ok('text' in userMessages()[0].documentSnapshot);
  bridge.phase = 'implementing';
  await bridge.sendUserMessage('이어서');
  assert.ok('text' in userMessages()[1].documentSnapshot);
});
