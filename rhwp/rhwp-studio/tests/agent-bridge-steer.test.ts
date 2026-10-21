// 지금 보내기(끼어들기)로 끊긴 턴은 편집 검토를 띄우지 않고, 끼어든 메시지의 턴이 끝날 때 한 번 띄운다.
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

function fixture() {
  const bridge = Object.create(AgentBridgeImpl.prototype) as any;
  const reviews: string[] = [];
  let begun = 0;
  Object.assign(bridge, {
    workflow: 'direct', phase: 'direct', permissionProfile: 'safe', activeProviderTurnId: null,
    pendingTurnOpen: false, steerInterruptRequested: false, steerCarryOver: false,
    planExecutionTurn: null, pendingUserQuestion: null, pendingQuestionCancellation: null,
    pendingChatPermissionRequests: new Map(), pendingPermissionCancellations: new Map(), chatPermissionGrants: [],
    activeToolRequestControllers: new Map(), inFlightWrites: new Set(), versionCommitInFlight: null,
    canStagePendingEdits: () => true, syncEditingLease: () => {}, emit: () => {}, sendJson: () => true,
    executor: { beginTurn: () => {}, endTurn: () => {} },
    pendingEdits: {
      setDirectApply: () => {},
      beginTurn: () => { begun++; },
      endTurn: (outcome: string) => { reviews.push(outcome); },
      getChangeSets: () => [],
    },
  });
  const start = (turnId: string) => bridge.handleAgentEvent({ type: 'turn-start', agent: 'claude', turnId });
  const end = (turnId: string, stopReason: string) => bridge.handleAgentEvent({ type: 'turn-end', agent: 'claude', turnId, stopReason });
  return { bridge, reviews, start, end, begun: () => begun };
}

test('a steering interrupt carries the open edit turn into the steered turn and reviews once at its end', () => {
  const { bridge, reviews, start, end, begun } = fixture();
  start('turn-1');
  bridge.interrupt({ steer: true });
  end('turn-1', 'interrupted');
  assert.deepEqual(reviews, [], 'the steered stop must not raise the review');
  assert.equal(bridge.pendingTurnOpen, true, 'edits stay staged in the open turn');
  start('turn-2');
  assert.equal(begun(), 1, 'the steered turn continues the same edit set');
  end('turn-2', 'end_turn');
  assert.deepEqual(reviews, ['review']);
  assert.equal(bridge.pendingTurnOpen, false);
});

test('a steer whose message never opens a turn hands the edits to review', () => {
  const { bridge, reviews, start, end } = fixture();
  start('turn-1');
  bridge.interrupt({ steer: true });
  end('turn-1', 'interrupted');
  bridge.releaseSteerCarryOver();
  assert.deepEqual(reviews, ['review']);
  assert.equal(bridge.pendingTurnOpen, false);
});

test('a plain stop still reviews at the stopped turn end', () => {
  const { bridge, reviews, start, end } = fixture();
  start('turn-1');
  bridge.interrupt();
  end('turn-1', 'interrupted');
  assert.deepEqual(reviews, ['review']);
});
