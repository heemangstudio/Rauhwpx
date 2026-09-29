// 턴 종료 결과 → 스테이징 처리 규칙의 회귀 고정 (P1.3).
// 성공하지 못한 종료(오류·인터럽트·max_tokens·재연결·사용자 중지)는 어느 권한
// 모드에서도 편집을 버리지 않고 'review' + 중단 표시로 보낸다. 자동 커밋은
// 명시적으로 성공한 unrestricted 턴뿐이다.
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

const { AgentBridgeImpl, turnEndDisposition } = await import('../src/agent/bridge.ts');
const { PendingEditManager } = await import('../src/agent/pending-edits.ts');
const { makeEnv } = await import('./agent-test-env.ts');

test('turnEndDisposition: 명시적 성공 종료만 프로필로 커밋 여부를 가른다', () => {
  for (const stopReason of ['end_turn', 'completed', 'success'] as const) {
    assert.deepEqual(turnEndDisposition({ stopReason }, 'safe', false),
      { succeeded: true, outcome: 'review' });
    assert.deepEqual(turnEndDisposition({ stopReason }, 'unrestricted', false),
      { succeeded: true, outcome: 'commit' });
  }
});

test('turnEndDisposition: 비성공 종료는 어느 모드에서도 review 다', () => {
  const stopped = [
    { stopReason: 'interrupted' },
    { stopReason: 'max_tokens' },
    { stopReason: 'failed', errorMessage: 'boom' },
    { stopReason: 'exited' },
    {}, // 재연결 등 이유를 알 수 없는 종료
    { stopReason: 'end_turn', errorMessage: 'late error' },
  ];
  for (const event of stopped) {
    for (const profile of ['safe', 'unrestricted'] as const) {
      assert.deepEqual(turnEndDisposition(event, profile, false),
        { succeeded: false, outcome: 'review' }, `${profile} ${JSON.stringify(event)}`);
    }
  }
  // 턴 중 프로바이더 오류가 찍혔으면 종료 이유가 completed 여도 성공이 아니다.
  assert.deepEqual(turnEndDisposition({ stopReason: 'completed' }, 'unrestricted', true),
    { succeeded: false, outcome: 'review' });
});

type EndTurnCall = { outcome: string; opts?: { turnStopped?: boolean } };

function bridgeFixture(permissionProfile: 'safe' | 'unrestricted') {
  const bridge = Object.create(AgentBridgeImpl.prototype) as any;
  const endTurnCalls: EndTurnCall[] = [];
  Object.assign(bridge, {
    permissionProfile,
    pendingTurnOpen: false,
    turnRunning: false,
    turnHadError: false,
    activeProviderTurnId: null,
    activeToolRequests: 0,
    activeToolRequestControllers: new Map(),
    editingAgent: null,
    editingLease: { active: false, agent: null, waitingForUser: false },
    editingLeaseListeners: new Set(),
    pendingUserQuestionId: null,
    workflow: 'direct',
    phase: 'direct',
    latestPlan: null,
    planExecutionTurn: null,
    planReview: null,
    listeners: new Set(),
    pendingEdits: {
      beginTurn: () => {},
      endTurn: (outcome: string, opts?: { turnStopped?: boolean }) => {
        endTurnCalls.push({ outcome, opts });
      },
      getChangeSets: () => [],
    },
    executor: { beginTurn: () => {}, endTurn: () => {} },
  });
  return { bridge, endTurnCalls };
}

function runTurn(bridge: any, events: Array<Record<string, unknown>>) {
  bridge.handleAgentEvent({ type: 'turn-start', agent: 'claude', turnId: 'turn-1' });
  assert.equal(bridge.pendingTurnOpen, true, 'turn-start 가 pending 턴을 연다');
  for (const event of events) bridge.handleAgentEvent(event);
}

test('turn-end 매핑: 성공은 safe→review, unrestricted→commit', () => {
  const safe = bridgeFixture('safe');
  runTurn(safe.bridge, [{ type: 'turn-end', agent: 'claude', turnId: 'turn-1', stopReason: 'completed' }]);
  assert.deepEqual(safe.endTurnCalls, [{ outcome: 'review', opts: { turnStopped: false } }]);

  const free = bridgeFixture('unrestricted');
  runTurn(free.bridge, [{ type: 'turn-end', agent: 'claude', turnId: 'turn-1', stopReason: 'completed' }]);
  assert.deepEqual(free.endTurnCalls, [{ outcome: 'commit', opts: { turnStopped: false } }]);
});

test('turn-end 매핑: 중단·오류·실패는 어느 모드에서도 review + 중단 표시', () => {
  for (const permissionProfile of ['safe', 'unrestricted'] as const) {
    for (const event of [
      { type: 'turn-end', agent: 'claude', turnId: 'turn-1', stopReason: 'interrupted' },
      { type: 'turn-end', agent: 'claude', turnId: 'turn-1', stopReason: 'max_tokens' },
      { type: 'turn-end', agent: 'claude', turnId: 'turn-1', stopReason: 'failed', errorMessage: 'boom' },
    ]) {
      const { bridge, endTurnCalls } = bridgeFixture(permissionProfile);
      runTurn(bridge, [event]);
      assert.deepEqual(endTurnCalls,
        [{ outcome: 'review', opts: { turnStopped: true } }],
        `${permissionProfile} ${event.stopReason}`);
    }
    // 턴 중 프로바이더 error 이벤트는 종료 이유가 completed 여도 비성공이다.
    const { bridge, endTurnCalls } = bridgeFixture(permissionProfile);
    runTurn(bridge, [
      { type: 'error', agent: 'claude', message: 'provider failure' },
      { type: 'turn-end', agent: 'claude', turnId: 'turn-1', stopReason: 'completed' },
    ]);
    assert.deepEqual(endTurnCalls,
      [{ outcome: 'review', opts: { turnStopped: true } }],
      `${permissionProfile} mid-turn error`);
    // 도구 수준 실패(ok:false tool-result)는 턴을 더럽히지 않는다 — 에이전트가 이미 봤다.
    const tool = bridgeFixture(permissionProfile);
    runTurn(tool.bridge, [
      { type: 'tool-result', agent: 'claude', callId: 'c1', ok: false, resultPreview: 'permission denied' },
      { type: 'tool-result', agent: 'claude', callId: 'c1', ok: false, resultPreview: 'permission denied' },
      { type: 'turn-end', agent: 'claude', turnId: 'turn-1', stopReason: 'end_turn' },
    ]);
    assert.deepEqual(tool.endTurnCalls, [{
      outcome: permissionProfile === 'safe' ? 'review' : 'commit',
      opts: { turnStopped: false },
    }], `${permissionProfile} tool-level failure`);
  }
});

test('결과 불명 종료(재연결·시작 실패)의 기본값도 review + 중단 표시다', () => {
  for (const permissionProfile of ['safe', 'unrestricted'] as const) {
    const { bridge, endTurnCalls } = bridgeFixture(permissionProfile);
    bridge.handleAgentEvent({ type: 'turn-start', agent: 'claude', turnId: 'turn-1' });
    bridge.endPendingTurn();
    assert.deepEqual(endTurnCalls,
      [{ outcome: 'review', opts: { turnStopped: true } }], permissionProfile);
    assert.equal(bridge.pendingTurnOpen, false);
  }
});

// ─── PendingEditManager.endTurn ─────────────────────────────
// 스텁 위에서 실제 메서드를 돌려 set 표시와 되돌림 경로를 본다.

function pendingFixture() {
  const pending = Object.create(PendingEditManager.prototype) as any;
  const set = {
    id: 'cs-1', agent: 'claude' as const, status: 'open' as const,
    ops: [{ id: 'op-1' }], createdAt: 0,
  };
  const calls = { approved: [] as string[], rejected: [] as string[] };
  Object.assign(pending, {
    deps: { wasm: {} },
    open: set,
    sets: [set],
    listeners: new Set(),
    bulkDepth: 0,
    syncOverlay: () => {},
    approve: (id: string) => { calls.approved.push(id); return true; },
    reject: (id: string) => { calls.rejected.push(id); },
  });
  return { pending, set, calls };
}

test('endTurn: 비성공 종료는 set 을 검토 대기로 남기고 중단을 표시한다', () => {
  const { pending, set, calls } = pendingFixture();
  pending.endTurn('review', { turnStopped: true });
  assert.equal(set.status, 'awaiting-review');
  assert.equal(set.turnStopped, true);
  assert.deepEqual(calls.rejected, [], '중단된 턴은 절대 자동 거절하지 않는다');
  assert.deepEqual(calls.approved, []);
});

test('endTurn: 성공 commit 은 승인하고 중단 표시를 남기지 않는다', () => {
  const { pending, set, calls } = pendingFixture();
  pending.endTurn('commit');
  assert.deepEqual(calls.approved, ['cs-1']);
  assert.deepEqual(calls.rejected, []);
  assert.equal(set.turnStopped, undefined);
});

test('endTurn: commit 승인이 실패해도 되돌리지 않고 검토 대기로 다시 알린다', () => {
  const { pending, calls } = pendingFixture();
  pending.approve = () => false;
  const events: string[] = [];
  pending.onChange((e: { type: string }) => events.push(e.type));
  pending.endTurn('commit');
  assert.deepEqual(calls.rejected, [], '성공한 턴의 편집은 사용자 거절로만 되돌린다');
  assert.deepEqual(events, ['set-finalized', 'set-finalized']);
});

test('endTurn: 전체 접근 자동 커밋의 스냅샷 저장이 실패하면 편집은 문서와 검토 카드에 남는다', async () => {
  let failSnapshots = false;
  let restores = 0;
  const h = makeEnv(['첫 문단', '둘째 문단'], (wasm) => {
    const save = wasm['saveSnapshot'] as () => number;
    const restore = wasm['restoreSnapshot'] as (id: number) => void;
    wasm['saveSnapshot'] = () => {
      if (failSnapshots) throw new Error('snapshot store exhausted');
      return save();
    };
    wasm['restoreSnapshot'] = (id: number) => { restores++; restore(id); };
  });
  const events: string[] = [];
  h.pending.onChange((e) => events.push(e.type));
  h.pending.beginTurn('claude');
  await h.call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 4, text: ' 추가' });
  await h.call('insert_text', { sectionIdx: 0, paraIdx: 1, charOffset: 0, text: '앞 ' });
  failSnapshots = true;
  h.pending.endTurn('commit');

  assert.deepEqual(h.body, ['첫 문단 추가', '앞 둘째 문단'], '성공한 턴의 편집이 되돌려지면 안 된다');
  assert.equal(restores, 0);
  const sets = h.pending.getChangeSets();
  assert.equal(sets.length, 1);
  assert.equal(sets[0].status, 'awaiting-review');
  assert.equal(sets[0].ops.length, 2);
  assert.ok(!events.includes('rejected'));
  assert.equal(events.at(-1), 'set-finalized', '실패 알림 뒤 검토 카드가 다시 잡힌다');
  // 저장소가 회복되면 사용자가 그대로 승인할 수 있다.
  failSnapshots = false;
  assert.equal(h.pending.approve(sets[0].id), true);
  assert.deepEqual(h.body, ['첫 문단 추가', '앞 둘째 문단']);
});

test('approve 실패: 검토로 돌아간 set 의 드리프트 op 스냅샷을 해제하지 않는다', async () => {
  let failSnapshots = false;
  const discarded: number[] = [];
  const h = makeEnv(['첫 문단 본문', '둘째 문단'], (wasm) => {
    const save = wasm['saveSnapshot'] as () => number;
    const discard = wasm['discardSnapshot'] as (id: number) => void;
    wasm['saveSnapshot'] = () => {
      if (failSnapshots) throw new Error('snapshot store exhausted');
      return save();
    };
    wasm['discardSnapshot'] = (id: number) => { discarded.push(id); discard(id); };
  });
  h.pending.beginTurn('claude');
  await h.call('replace_range', {
    sectionIdx: 0, startParaIdx: 0, startCharOffset: 0, endParaIdx: 0, endCharOffset: 2, text: '머리',
  });
  await h.call('insert_text', { sectionIdx: 0, paraIdx: 1, charOffset: 0, text: '앞 ' });
  h.pending.endTurn('review');
  // 사용자가 교체된 글자를 고쳐 replace op 이 드리프트된다.
  h.body[0] = '고친 문단 본문';
  h.bus.emit('document-mutated', 'user-edit');
  failSnapshots = true;
  const [set] = h.pending.getChangeSets();
  assert.equal(h.pending.approve(set.id), false);

  const [kept] = h.pending.getChangeSets();
  assert.equal(kept.status, 'awaiting-review');
  const held = kept.ops.flatMap((op) => (op.kind === 'replace' && op.snapshotId != null ? [op.snapshotId] : []));
  assert.equal(held.length, 1);
  assert.deepEqual(discarded.filter((id) => held.includes(id)), [], '검토 대기 op 이 가리키는 스냅샷은 살아 있어야 한다');
});

// ─── 허브 재시작: welcome session:null ──────────────────────

function welcomeFixture(opts: { turnRunning: boolean; activeAgent: 'claude' | null; threadId?: string }) {
  const { bridge, endTurnCalls } = bridgeFixture('safe');
  const events: any[] = [];
  const leases: Array<{ active: boolean }> = [];
  Object.assign(bridge, {
    reconnectAttempt: 0,
    state: 'connected',
    pendingChatStart: null,
    threadId: opts.threadId ?? 't1',
    documentId: 'doc-1',
    activeAgent: opts.activeAgent,
    selectedAgent: 'claude',
    editingAgent: 'claude',
    pendingUserQuestion: null,
    pendingQuestionAnswer: null,
    pendingQuestionCancellation: null,
    activeTemplateId: null,
    activeTemplate: null,
    workflowSwitchPending: false,
    workflowBeforeSwitch: null,
    capabilityEpoch: null,
    userEditedSincePlanningNotify: false,
    pendingPlanExecutionResult: null,
    queuedMessages: [],
    clearPendingQuestionCancellation() { this.pendingQuestionCancellation = null; },
  });
  bridge.listeners.add((e: any) => events.push(e));
  bridge.onEditingLeaseChange((lease: { active: boolean }) => leases.push(lease));
  if (opts.turnRunning) bridge.handleAgentEvent({ type: 'turn-start', agent: 'claude', turnId: 'turn-1' });
  events.length = 0;
  return { bridge, endTurnCalls, events, leases };
}

test('welcome session:null 은 턴이 돌던 채팅의 진행·편집 잠금·열린 편집 턴을 푼다', () => {
  const { bridge, endTurnCalls, events, leases } = welcomeFixture({ turnRunning: true, activeAgent: 'claude' });
  assert.equal(bridge.getEditingLease().active, true, '턴 중에는 문서 교체가 막힌다');
  bridge.handleMessage({ type: 'welcome', session: null });

  assert.equal(bridge.isTurnRunning(), false);
  assert.equal(bridge.activeProviderTurnId, null);
  assert.equal(bridge.pendingTurnOpen, false);
  assert.equal(bridge.getActiveAgent(), null, '다음 메시지가 chat-start 로 새 세션을 연다');
  assert.deepEqual(endTurnCalls, [{ outcome: 'review', opts: { turnStopped: true } }], '편집은 되돌리지 않고 검토로 남긴다');
  assert.equal(leases.at(-1)?.active, false);
  const turnEnd = events.find((e) => e.type === 'agent' && e.event.type === 'turn-end');
  assert.ok(turnEnd, '사이드바가 스트림·도구 행을 마무리할 turn-end 가 온다');
  assert.equal(turnEnd.event.agent, 'claude');
  assert.equal(turnEnd.event.stopReason, 'exited');
  assert.match(turnEnd.event.errorMessage, /허브/);
});

test('welcome session:null 은 유휴 에이전트 채팅도 새 세션을 열게 하되 turn-end 는 만들지 않는다', () => {
  const { bridge, endTurnCalls, events } = welcomeFixture({ turnRunning: false, activeAgent: 'claude' });
  bridge.handleMessage({ type: 'welcome', session: null });
  assert.equal(bridge.getActiveAgent(), null);
  assert.deepEqual(endTurnCalls, []);
  assert.ok(!events.some((e) => e.type === 'agent'));
});

test('welcome session:null 은 복원만 된 스레드(시작 전)를 건드리지 않는다', () => {
  const { bridge, events } = welcomeFixture({ turnRunning: false, activeAgent: null });
  bridge.workflow = 'plan';
  bridge.phase = 'awaiting-approval';
  bridge.handleMessage({ type: 'welcome', session: null });
  assert.equal(bridge.workflow, 'plan');
  assert.equal(bridge.phase, 'awaiting-approval');
  assert.deepEqual(events, []);
});

test('다른 스레드의 살아 있는 세션 welcome 은 여전히 무시한다', () => {
  const { bridge, endTurnCalls, events } = welcomeFixture({ turnRunning: true, activeAgent: 'claude' });
  bridge.handleMessage({ type: 'welcome', session: { agent: 'codex', threadId: 'other', status: 'running', turnId: 'x' } });
  assert.equal(bridge.isTurnRunning(), true);
  assert.equal(bridge.getActiveAgent(), 'claude');
  assert.deepEqual(endTurnCalls, []);
  assert.deepEqual(events, []);
});
