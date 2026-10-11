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
const { expectErr, makeEnv } = await import('./agent-test-env.ts');

type ReadArgs = { text?: 'full'; pages?: [number, number] };
type ReadReply = { text: string; truncated?: boolean } | null | Error;

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
  const header = (args: ReadArgs) =>
    `revision ${state.revision} · ${state.pages} pages${args.pages ? ` · pages ${args.pages[0]}-${args.pages[1]}` : ''}`;
  let reply = (args: ReadArgs): ReadReply => ({ text: `${header(args)}\ns0 p0 (2) 본문` });
  const deps = {
    read: (args: ReadArgs) => {
      reads.push(args);
      const answer = reply(args);
      if (answer instanceof Error) throw answer;
      return answer && { revision: state.revision, text: answer.text, truncated: answer.truncated === true };
    },
    documentUnchangedSince: (revision: number) => revision >= state.contentRevision,
    revision: () => state.revision,
    pageCount: () => state.pages,
    activePage: () => state.activePage,
    documentInstance: () => state.instance,
  };
  return {
    state, reads, deps, header,
    replyWith(next: typeof reply) { reply = next; },
    contentEdit() { state.revision += 1; state.contentRevision = state.revision; },
    neutralBump() { state.revision += 1; },
  };
}

const textOf = (built: { snapshot: object } | null) => (built?.snapshot as { text?: string } | undefined)?.text;

test('짧은 문서는 전체를 text:"full" 로 한 번 읽어 싣는다', () => {
  const doc = fakeDocument({ pages: 12 });
  const built = new TurnSnapshots(doc.deps).build();
  assert.deepEqual(doc.reads, [{ text: 'full' }]);
  assert.deepEqual(built, { snapshot: { revision: 100, text: 'revision 100 · 12 pages\ns0 p0 (2) 본문' }, page: null });
});

test('전체 읽기가 잘리거나 넘치면 보고 있는 쪽 전문, 그다음 미리보기, 그래도 넘치면 싣지 않는다', () => {
  const doc = fakeDocument({ pages: 5, activePage: 2 });
  doc.replyWith((args) => {
    if (!args.pages) return { text: '잘린 전체', truncated: true };
    if (args.text === 'full') return { text: 'x'.repeat(SNAPSHOT_MAX_CHARS + 1) };
    return { text: 'revision 100 · 5 pages · pages 2-2\ns0 p7 (40) 미리보기…' };
  });
  const snapshots = new TurnSnapshots(doc.deps);
  assert.deepEqual(snapshots.build(), {
    snapshot: { revision: 100, text: 'revision 100 · 5 pages · pages 2-2\ns0 p7 (40) 미리보기…' }, page: 2,
  });
  assert.deepEqual(doc.reads, [{ text: 'full' }, { pages: [2, 2], text: 'full' }, { pages: [2, 2] }], '읽기는 많아야 세 번');

  doc.replyWith((args) => (args.pages && args.text !== 'full'
    ? { text: '잘린 미리보기', truncated: true }
    : { text: 'x'.repeat(SNAPSHOT_MAX_CHARS + 1) }));
  assert.equal(snapshots.build(), null);

  doc.replyWith(() => ({ text: 'x'.repeat(SNAPSHOT_MAX_CHARS) }));
  assert.equal(textOf(snapshots.build())?.length, SNAPSHOT_MAX_CHARS, '상한까지는 싣는다');
});

test('긴 문서는 전체 읽기를 건너뛰고 보고 있는 쪽만 읽는다', () => {
  const doc = fakeDocument({ pages: 13, activePage: 4 });
  const built = new TurnSnapshots(doc.deps).build();
  assert.deepEqual(doc.reads, [{ pages: [4, 4], text: 'full' }]);
  assert.equal(built?.page, 4);
  assert.match(textOf(built)!, /pages 4-4/);
});

test('문서가 없거나 읽을 수 없거나 보고 있는 쪽을 모르면 스냅샷 없이 보낸다', () => {
  const empty = fakeDocument({ pages: 0 });
  assert.equal(new TurnSnapshots(empty.deps).build(), null);
  assert.deepEqual(empty.reads, [], '문서가 없으면 읽지 않는다');

  const unreadable = fakeDocument();
  unreadable.replyWith(() => null);
  assert.equal(new TurnSnapshots(unreadable.deps).build(), null);
  const throwing = fakeDocument();
  throwing.replyWith(() => new Error('engine trapped'));
  assert.equal(new TurnSnapshots(throwing.deps).build(), null);
  const noPages = fakeDocument();
  noPages.deps.pageCount = () => { throw new Error('문서가 로드되지 않았습니다'); };
  assert.equal(new TurnSnapshots(noPages.deps).build(), null);

  const long = fakeDocument({ pages: 40, activePage: null });
  assert.equal(new TurnSnapshots(long.deps).build(), null);
  const stale = fakeDocument({ pages: 40, activePage: 40 });
  assert.equal(new TurnSnapshots(stale.deps).build(), null, '쪽 수를 벗어난 활성 쪽은 쓰지 않는다');
  assert.deepEqual(stale.reads, []);
});

test('에이전트가 본 상태 그대로면 unchanged 만, 내용이 바뀌면 새 본문을 싣는다', () => {
  const doc = fakeDocument();
  const snapshots = new TurnSnapshots(doc.deps);
  const first = snapshots.build()!;
  assert.ok(textOf(snapshots.build()), '보내지 못한 스냅샷은 본 것으로 치지 않는다');
  snapshots.markSent(first);

  doc.neutralBump(); // 턴 끝 자동 커밋 같은 내용 불변 bump
  const reads = doc.reads.length;
  assert.deepEqual(snapshots.build(), { snapshot: { revision: 101, unchanged: true }, page: null });
  assert.equal(doc.reads.length, reads, 'unchanged 는 문서를 읽지 않는다');

  doc.contentEdit(); // 사용자 편집
  assert.deepEqual(snapshots.build()?.snapshot, { revision: 102, text: 'revision 102 · 3 pages\ns0 p0 (2) 본문' });
});

test('쪽 블록 뒤 다른 쪽을 보고 있으면, 문서가 그대로여도 그 쪽을 현재 revision 으로 싣는다', () => {
  const doc = fakeDocument({ pages: 40, activePage: 3 });
  const snapshots = new TurnSnapshots(doc.deps);
  const first = snapshots.build()!;
  assert.equal(first.page, 3);
  snapshots.markSent(first);

  doc.neutralBump();
  doc.state.activePage = 17; // 사용자가 17쪽으로 스크롤하고 "이 쪽"을 묻는다
  const moved = snapshots.build()!;
  assert.deepEqual(moved, { snapshot: { revision: 101, text: `${doc.header({ pages: [17, 17] })}\ns0 p0 (2) 본문` }, page: 17 });
  assert.deepEqual(doc.reads.at(-1), { pages: [17, 17], text: 'full' }, '긴 문서라 전체 읽기는 다시 시도하지 않는다');
  snapshots.markSent(moved);
  assert.deepEqual(snapshots.build(), { snapshot: { revision: 101, unchanged: true }, page: 17 }, '같은 쪽이면 unchanged');

  doc.state.activePage = null; // 보고 있는 쪽을 모르면 unchanged 로 둔다
  assert.deepEqual(snapshots.build()?.snapshot, { revision: 101, unchanged: true });

  // 그 쪽이 상한을 넘으면 블록 없이 보낸다 — unchanged 는 예전 쪽을 가리키게 된다.
  doc.state.activePage = 30;
  doc.replyWith(() => ({ text: 'x'.repeat(SNAPSHOT_MAX_CHARS + 1) }));
  assert.equal(snapshots.build(), null);
});

test('문서 전체를 보낸 뒤에는 스크롤해도 unchanged 다', () => {
  const doc = fakeDocument({ pages: 3, activePage: 0 });
  const snapshots = new TurnSnapshots(doc.deps);
  snapshots.markSent(snapshots.build()!);
  doc.state.activePage = 2;
  assert.deepEqual(snapshots.build(), { snapshot: { revision: 100, unchanged: true }, page: null });
});

test('기억한 revision 은 reset 과 문서 인스턴스 교체에서 사라진다', () => {
  const doc = fakeDocument();
  const snapshots = new TurnSnapshots(doc.deps);
  snapshots.markSent(snapshots.build()!);
  assert.equal(snapshots.agentIsCurrent(), true);

  snapshots.reset(); // 새 채팅·세션 교체
  assert.equal(snapshots.agentIsCurrent(), false);
  const afterReset = snapshots.build()!;
  assert.ok(textOf(afterReset));

  snapshots.markSent(afterReset);
  doc.state.instance = 2; // 다른 문서를 열었다 — revision 이 우연히 이어져도 본 적 없는 문서다
  assert.equal(snapshots.agentIsCurrent(), false);
  assert.ok(textOf(snapshots.build()));
});

test('도구 결과는 본 상태를 그 revision 까지 잇고, 문서 revision 이 아닌 값은 무시한다', () => {
  const doc = fakeDocument();
  const snapshots = new TurnSnapshots(doc.deps);
  snapshots.noteToolResult({ revision: 100 });
  assert.equal(snapshots.agentIsCurrent(), false, '보낸 스냅샷 없이는 이을 상태가 없다');
  snapshots.markSent(snapshots.build()!);

  doc.contentEdit(); // 에이전트 자신의 쓰기
  assert.equal(snapshots.agentIsCurrent(), false);
  snapshots.noteToolResult({ revision: 3 }); // 템플릿 revision
  snapshots.noteToolResult({ revision: 999 });
  snapshots.noteToolResult({ applied: 1 });
  assert.equal(snapshots.agentIsCurrent(), false);
  snapshots.noteToolResult({ revision: 101, applied: 1 });
  assert.equal(snapshots.agentIsCurrent(), true);
  assert.deepEqual(snapshots.build()?.snapshot, { revision: 101, unchanged: true });
});

// ─── 실제 실행기 ─────────────────────────────────────────

function realExecutor(body: string[]) {
  const h = makeEnv(body);
  const executor = new AgentToolExecutor({
    wasm: h.wasm as never,
    editor: { getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }), getSelection: () => null } as never,
    documentState: { isDirty: () => false } as never,
    revision: h.revision,
    pending: h.pending,
    loadTemplateBytes: async () => new Uint8Array(),
  });
  const snapshots = new TurnSnapshots({
    read: (args) => executor.structureSnapshot(args),
    documentUnchangedSince: (revision) => executor.documentUnchangedSince(revision),
    revision: () => h.revision.revision,
    pageCount: () => (h.wasm as { pageCount: number }).pageCount,
    activePage: () => 0,
    documentInstance: () => undefined,
  });
  return { h, executor, snapshots };
}

test('실제 실행기: 본문은 get_structure 도구 결과 그대로이고, 그 revision 으로 첫 쓰기가 통과한 뒤 unchanged 가 된다', async () => {
  const { h, executor, snapshots } = realExecutor(['표지 2025. 10.', '본문 문단']);
  const first = snapshots.build()!;
  const tool = await executor.execute('get_structure', { text: 'full' }, 'claude') as { mcpContent: Array<{ text: string }> };
  assert.equal(textOf(first), tool.mcpContent[0].text);
  assert.match(textOf(first)!, /표지 2025\. 10\./);
  snapshots.markSent(first);

  // 턴: 읽지 않고 스냅샷 revision 으로 바로 쓴다.
  h.pending.beginTurn('claude');
  assert.equal(snapshots.agentIsCurrent(), true);
  const write = await executor.execute('insert_text', {
    expectedRevision: first.snapshot.revision, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: '>',
  }, 'claude') as { revision: number };
  snapshots.noteToolResult(write);
  h.pending.endTurn('commit');
  assert.equal(h.body[0], '>표지 2025. 10.');
  assert.deepEqual(snapshots.build()?.snapshot, { revision: h.revision.revision, unchanged: true });

  await Promise.resolve();
  h.bus.emit('document-changed'); // 사용자 편집 — 저널에 없는 bump
  const fresh = snapshots.build()!;
  assert.ok(textOf(fresh) && fresh.snapshot.revision === h.revision.revision);
});

test('스냅샷 읽기는 템플릿 매핑 게이트를 열지 않는다 — 템플릿 이식에는 에이전트 자신의 읽기가 필요하다', async (t) => {
  const { h, executor, snapshots } = realExecutor(['본문 문단']);
  const template = {
    id: 'tpl-1', name: '양식', originalName: '양식.hwpx', format: 'hwpx', size: 1, pageCount: 1, sectionCount: 1,
    contentHash: 'x', revision: 1, createdAt: '', updatedAt: '',
  } as const;
  // 템플릿 쪽은 이미 읽은 것으로 둔다 — 게이트에 남은 조건은 문서 읽기뿐이다.
  Object.assign(executor as unknown as Record<string, unknown>, {
    templateWasm: { releaseDocument() {} }, templateBytes: new Uint8Array(), templateKey: 'tpl-1:1', templateInspectionKey: 'tpl-1:1',
  });
  t.after(() => executor.dispose());
  const apply = () => executor.execute('template_apply_section_layout', {
    expectedRevision: h.revision.revision, templateRevision: 1, mappings: [],
  }, 'claude', { workflow: 'direct', template });

  assert.ok(textOf(snapshots.build()), '문서 전체 스냅샷을 만들었다');
  await expectErr(apply(), 'TEMPLATE_MAPPING_REQUIRED');

  await executor.execute('get_structure', {}, 'claude');
  const passed = await expectErr(apply(), 'INVALID_ARGS');
  assert.match(passed.message, /mappings must contain at least one section mapping/, '에이전트의 읽기 뒤에는 게이트를 지난다');
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
    messageReceipts: new Map(), awaitingAcceptanceId: null,
    turnRunning: false, turnHadError: false, pendingTurnOpen: false, userEditedSincePlanningNotify: false,
    activeProviderTurnId: null, interruptedProviderTurnId: null,
    activeToolRequests: 0, activeToolRequestControllers: new Map(), inFlightWrites: new Set(), versionCommitInFlight: null,
    pendingUserQuestion: null, pendingQuestionCancellation: null,
    pendingChatPermissionRequest: null, pendingPermissionCancellation: null, chatPermissionGrants: [], planExecutionTurn: null,
    pendingInterrupt: false,
    turnSnapshots: new TurnSnapshots(doc.deps),
    sendJson: (frame: unknown) => { frames.push(structuredClone(frame)); return true; },
    sendToolResponse: (frame: unknown) => { frames.push(structuredClone(frame)); },
    emit: () => {},
    syncEditingLease() {}, finishWorkflowSwitch() {}, syncWorkflowState() {}, resetWorkflowState() {},
    clearPendingQuestionCancellation() {},
    abortProviderToolRequests() {}, abortActiveToolRequests() {},
    workflowState: () => ({ workflow: 'direct', phase: 'direct', capabilityEpoch: 1, latestPlan: null }),
    // 전체 모드: 쓰기 도구마다 열린 set 을 바로 확정한다.
    pendingEdits: { setDirectApply() {}, commitOpen: () => true },
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
  const sent = bridge.sendUserMessage('표지 날짜를 2026. 10. 로 바꿔줘');
  assert.equal(userMessages().length, 1, '프레임은 그 자리에서 나간다');
  await sent;
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

test('구상 중 대기한 메시지는 chat-document-saved 보다 먼저 나간다 — 허브가 알림 턴을 먼저 열면 메시지가 AGENT_BUSY 로 사라진다', async () => {
  for (const trigger of ['chat-started', 'workflow-changed'] as const) {
    const { bridge, frames, acknowledgeStart } = bridgeFixture(fakeDocument(), {
      workflow: 'plan', phase: 'planning', ...(trigger === 'chat-started' ? { activeAgent: null } : { workflowSwitchPending: true }),
      finishWorkflowSwitch() { this.workflowSwitchPending = false; },
    });
    const sent = bridge.sendUserMessage('이 부분도 계획에 넣어줘');
    bridge.userEditedSincePlanningNotify = true; // 사용자가 구상 중에 문서를 고쳤다
    if (trigger === 'chat-started') acknowledgeStart();
    else bridge.handleMessage({ type: 'workflow-changed', workflow: 'plan', phase: 'planning' });
    assert.deepEqual(
      frames.map((frame) => frame.type).filter((type) => type !== 'chat-start'),
      ['chat-user-message', 'chat-document-saved'],
      trigger,
    );
    await sent;
  }
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

  // 턴 밖 작업자(turnBound:false)의 쓰기는 루트가 본 것이 아니다.
  result.current = () => { doc.contentEdit(); return { revision: doc.state.revision, applied: 1 }; };
  await request(3, { turnBound: false });
  await bridge.sendUserMessage('작업자 뒤');
  assert.equal(userMessages()[3].documentSnapshot.revision, 104);
  assert.ok('text' in userMessages()[3].documentSnapshot);
});

test('서브에이전트가 돈 턴 뒤의 메시지는 새 본문을 싣는다 — Claude·Codex 는 표시 없이, Pi 는 표시를 달고 온다', async () => {
  const cases: Array<{ label: string; fleet: (h: ReturnType<typeof turnHarness>) => Promise<void> }> = [
    {
      // Claude: task-start 뒤 서브에이전트가 루트 MCP 소켓으로 쓴다 (도구 요청에 표시 없음).
      label: 'claude',
      fleet: async (h) => {
        h.event({ type: 'task-start', agent: 'claude', taskId: 't1', title: 'doc-editor', taskKind: 'agent' });
        await h.write();
        h.event({ type: 'task-end', agent: 'claude', taskId: 't1', status: 'completed' });
      },
    },
    {
      // Codex: 롤아웃 워처가 늦게 알려 쓰기가 먼저 이어진 뒤에 task 이벤트가 온다.
      label: 'codex',
      fleet: async (h) => {
        await h.write();
        h.event({ type: 'task-progress', agent: 'codex', taskId: 't2', activity: 'tool' });
      },
    },
    {
      // 표시가 붙은 스트림 이벤트만 있는 경우.
      label: 'tagged event',
      fleet: async (h) => {
        await h.write();
        h.event({ type: 'tool-call', agent: 'codex', callId: 'c1', tool: 'apply_edits', argsJson: '{}', parentTaskId: 't3' });
      },
    },
    {
      // Pi: 자식 소켓의 요청이 parentTaskId 를 달고 온다 (task 이벤트 없이도).
      label: 'pi',
      fleet: async (h) => {
        await h.write({ parentTaskId: 'sa-1', agent: 'pi' });
      },
    },
  ];
  for (const { label, fleet } of cases) {
    const h = turnHarness();
    await h.bridge.sendUserMessage('페이지마다 나눠서 고쳐줘');
    await fleet(h);
    await h.write(); // 같은 턴의 루트 쓰기도 더는 잇지 않는다
    h.endTurn();
    await h.bridge.sendUserMessage('다음');
    const next = h.userMessages().at(-1).documentSnapshot;
    assert.ok('text' in next, `${label}: 서브에이전트 쓰기 뒤에는 새 본문`);
    assert.equal(next.revision, h.doc.state.revision, label);

    // 다음 턴은 다시 평소대로 잇는다.
    h.startTurn();
    await h.write();
    h.endTurn();
    await h.bridge.sendUserMessage('또 다음');
    assert.deepEqual(h.userMessages().at(-1).documentSnapshot, { revision: h.doc.state.revision, unchanged: true }, label);
  }
});

/** 턴 이벤트와 도구 요청을 흘려 넣는 브리지 — 쓰기는 문서 내용을 바꾸고 새 revision 을 돌려준다. */
function turnHarness() {
  const doc = fakeDocument();
  let turn = 0;
  const { bridge, userMessages } = bridgeFixture(doc, {
    executor: { execute: async () => { doc.contentEdit(); return { revision: doc.state.revision, applied: 1 }; } },
    // 스테이징·계획 수명주기는 이 경로와 무관하다.
    beginPendingTurn() {}, endPendingTurn() {}, beginPlanExecutionTurn() {},
  });
  let id = 0;
  const h = {
    doc, bridge, userMessages,
    event: (event: Record<string, unknown>) => bridge.handleAgentEvent(event),
    startTurn: () => h.event({ type: 'turn-start', agent: 'claude', turnId: `turn-${++turn}` }),
    endTurn: () => h.event({ type: 'turn-end', agent: 'claude', stopReason: 'end_turn', turnId: `turn-${turn}` }),
    write: async (extra: Record<string, unknown> = {}) => {
      bridge.handleToolRequest({
        id: ++id, tool: 'apply_edits', args: {}, agent: 'claude', providerTurnId: `turn-${turn}`, ...extra,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
  h.startTurn();
  return h;
}

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
