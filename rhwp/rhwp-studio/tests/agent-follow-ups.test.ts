// 대기 메시지의 순수 전이 — 언제 보내고 언제 붙잡는지, 대기열을 어떻게 고치고 저장본을 어떻게 읽는지.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FOLLOW_UP_LIMIT,
  createFollowUpId,
  decideAfterTurn,
  edit,
  enqueue,
  followUpTurnOutcome,
  hold,
  holdFollowUps,
  isStranded,
  moveToHead,
  normalizeFollowUps,
  release,
  releaseFollowUps,
  remove,
  requeueHead,
  type FollowUpItem,
  type FollowUpTurnContext,
  type ThreadFollowUps,
} from '../src/agent/follow-ups.ts';

const item = (id: string, text = `글 ${id}`): FollowUpItem => ({ id, text, createdAt: 1 });
const queueOf = (...ids: string[]): ThreadFollowUps => ({ items: ids.map((id) => item(id)) });
const ctx = (overrides: Partial<FollowUpTurnContext> = {}): FollowUpTurnContext => ({
  sendNowId: null,
  planAwaitingApproval: false,
  engineTrapped: false,
  mergeLocked: false,
  editingId: null,
  ...overrides,
});

test('a normal turn end sends only the head, and an empty queue does nothing', () => {
  assert.deepEqual(decideAfterTurn(queueOf('a', 'b'), 'normal', ctx()), { kind: 'dispatch', itemId: 'a' });
  assert.deepEqual(decideAfterTurn(undefined, 'normal', ctx()), { kind: 'none' });
  assert.deepEqual(decideAfterTurn({ items: [] }, 'stopped', ctx()), { kind: 'none' });
});

test('stopped, failed and interrupted turn ends hold the queue with that reason', () => {
  for (const outcome of ['stopped', 'failed', 'interrupted'] as const) {
    assert.deepEqual(decideAfterTurn(queueOf('a'), outcome, ctx()), { kind: 'hold', reason: outcome });
  }
});

test('plan approval, an engine trap and the merge lock hold a normal end; editing defers it', () => {
  assert.deepEqual(decideAfterTurn(queueOf('a'), 'normal', ctx({ planAwaitingApproval: true })), { kind: 'hold', reason: 'plan-approval' });
  assert.deepEqual(decideAfterTurn(queueOf('a'), 'normal', ctx({ engineTrapped: true })),
    { kind: 'hold', reason: 'failed', detail: '문서 엔진 멈춤' });
  assert.deepEqual(decideAfterTurn(queueOf('a'), 'normal', ctx({ mergeLocked: true })), { kind: 'hold', reason: 'blocked' });
  assert.deepEqual(decideAfterTurn(queueOf('a'), 'normal', ctx({ editingId: 'a' })), { kind: 'defer' });
});

test('send now dispatches its item even from a held queue', () => {
  const held = hold(queueOf('a', 'b'), 'stopped', undefined, 5);
  assert.deepEqual(decideAfterTurn(held, 'send-now', ctx({ sendNowId: 'b' })), { kind: 'dispatch', itemId: 'b' });
  // 걸어 둔 항목이 사라졌으면 사용자가 멈춘 턴으로 본다.
  assert.deepEqual(decideAfterTurn(queueOf('a'), 'send-now', ctx({ sendNowId: 'gone' })), { kind: 'hold', reason: 'stopped' });
});

test('a hold that needs the user is never drained by a normal end, but busy releases itself', () => {
  for (const reason of ['stopped', 'failed', 'interrupted', 'plan-approval', 'blocked', 'rejected'] as const) {
    assert.deepEqual(decideAfterTurn(hold(queueOf('a'), reason), 'normal', ctx()), { kind: 'none' }, reason);
  }
  assert.deepEqual(decideAfterTurn(hold(queueOf('a'), 'busy'), 'normal', ctx()), { kind: 'dispatch', itemId: 'a' });
  // busy 뒤의 미심쩍은 끝은 그 이유로 바꿔 붙잡는다.
  assert.deepEqual(decideAfterTurn(hold(queueOf('a'), 'busy'), 'failed', ctx()), { kind: 'hold', reason: 'failed' });
});

test('turn ends classify like the UI turn outcome: unknown stop reasons complete, interruptions and errors hold', () => {
  const end = (event: { stopReason?: string; errorMessage?: string }, extra: Partial<Parameters<typeof followUpTurnOutcome>[1]> = {}) =>
    followUpTurnOutcome(event, { errorSeen: false, userStopRequested: false, sendNowId: null, ...extra });
  assert.equal(end({ stopReason: 'end_turn' }), 'normal');
  assert.equal(end({ stopReason: 'completed' }), 'normal');
  assert.equal(end({ stopReason: 'max_tokens' }), 'normal', 'max_tokens counts as completed, as in turnOutcomeFor');
  assert.equal(end({}), 'normal');
  assert.equal(end({ stopReason: 'interrupted' }), 'interrupted');
  assert.equal(end({ stopReason: 'interrupted' }, { userStopRequested: true }), 'stopped');
  // 중지가 정상 종료·실패와 엇갈려도 사용자는 멈추라고 했다.
  assert.equal(end({ stopReason: 'end_turn' }, { userStopRequested: true }), 'stopped');
  assert.equal(end({ stopReason: 'end_turn', errorMessage: 'boom' }, { userStopRequested: true }), 'stopped');
  assert.equal(end({ stopReason: 'end_turn' }, { interruptionReason: 'hub-restart', userStopRequested: true }), 'interrupted');
  assert.equal(end({ stopReason: 'exited', errorMessage: '허브가 다시 시작됐습니다' }), 'failed');
  assert.equal(end({ stopReason: 'failed' }), 'failed');
  assert.equal(end({ stopReason: 'end_turn', errorMessage: 'boom' }), 'failed');
  assert.equal(end({ stopReason: 'end_turn' }, { errorSeen: true }), 'failed');
  assert.equal(end({ stopReason: 'interrupted' }, { sendNowId: 'a', userStopRequested: true }), 'send-now');
});

test('enqueue refuses the eleventh item and can put an item at the head', () => {
  let q: ThreadFollowUps = { items: [] };
  for (let index = 0; index < FOLLOW_UP_LIMIT; index += 1) {
    const next = enqueue(q, item(`i${index}`));
    assert.notEqual(next, 'full');
    q = next as ThreadFollowUps;
  }
  assert.equal(enqueue(q, item('overflow')), 'full');
  const head = enqueue(queueOf('a'), item('urgent'), { atHead: true });
  assert.deepEqual((head as ThreadFollowUps).items.map((entry) => entry.id), ['urgent', 'a']);
});

test('busy never replaces a hold that needs the user; a later specific reason does', () => {
  const stopped = hold(queueOf('a'), 'stopped', undefined, 1);
  assert.equal(hold(stopped, 'busy', undefined, 2).hold?.reason, 'stopped');
  const relabeled = hold(stopped, 'interrupted', { detail: '허브 재시작' }, 3);
  assert.deepEqual(relabeled.hold, { reason: 'interrupted', detail: '허브 재시작', at: 3 });
  assert.equal(hold({ items: [] }, 'stopped').hold, undefined, 'an empty queue is never held');
  assert.equal(release(stopped).hold, undefined);
});

test('editing, removing, moving and requeueing keep the queue consistent', () => {
  const q = hold(queueOf('a', 'b', 'c'), 'stopped', undefined, 1);
  assert.deepEqual(edit(q, 'b', '  고친 글 ').items[1], { id: 'b', text: '고친 글', createdAt: 1 });
  assert.deepEqual(edit(q, 'b', '   ').items.map((entry) => entry.id), ['a', 'c'], 'empty text removes the item');
  const skill: ThreadFollowUps = { items: [{ id: 's', text: '요약', skillName: 'summarize-document', createdAt: 1 }] };
  assert.deepEqual(edit(skill, 's', '').items, [{ id: 's', text: '', skillName: 'summarize-document', createdAt: 1 }],
    'a skill-only item survives an empty edit');
  assert.deepEqual(moveToHead(q, 'c').items.map((entry) => entry.id), ['c', 'a', 'b']);
  assert.equal(moveToHead(q, 'c').hold?.reason, 'stopped');
  const last = remove(remove(remove(q, 'a'), 'b'), 'c');
  assert.deepEqual(last, { items: [] }, 'removing the last item drops the hold');
  assert.deepEqual(requeueHead(queueOf('b'), item('a')).items.map((entry) => entry.id), ['a', 'b']);
  assert.deepEqual(requeueHead(queueOf('a', 'b'), item('a')).items.map((entry) => entry.id), ['a', 'b'], 'no duplicate');
});

test('a queue is stranded only when nothing will drain it', () => {
  const idle = { inFlight: false, sendNowId: null, working: false, drainDeferred: false };
  assert.equal(isStranded(queueOf('a'), idle), true);
  assert.equal(isStranded(hold(queueOf('a'), 'stopped'), idle), false);
  assert.equal(isStranded(queueOf('a'), { ...idle, inFlight: true }), false);
  assert.equal(isStranded(queueOf('a'), { ...idle, sendNowId: 'a' }), false);
  assert.equal(isStranded(queueOf('a'), { ...idle, working: true }), false);
  assert.equal(isStranded(queueOf('a'), { ...idle, drainDeferred: true }), false);
  assert.equal(isStranded({ items: [] }, idle), false);
});

test('normalize keeps valid items, drops malformed ones and an itemless hold', () => {
  assert.equal(normalizeFollowUps(undefined), undefined);
  assert.equal(normalizeFollowUps({ items: [], hold: { reason: 'stopped', at: 1 } }), undefined);
  assert.deepEqual(normalizeFollowUps({
    items: [
      { id: 'a', text: '본문', skillName: 'Bad Name', skillIcon: 'chart', createdAt: 'x' },
      { id: 'b', text: '', skillName: 'summarize-document', skillIcon: 'chart', createdAt: 2 },
      { id: 'c', text: 42 },
    ],
    hold: { reason: 'rejected', code: 'INVALID_REQUEST', at: 3 },
  }), {
    items: [
      { id: 'a', text: '본문', createdAt: 0 },
      { id: 'b', text: '', skillName: 'summarize-document', skillIcon: 'chart', createdAt: 2 },
    ],
    hold: { reason: 'rejected', code: 'INVALID_REQUEST', at: 3 },
  });
});

test('stored threads not open in a sidebar can be held and released in place', () => {
  const thread: { followUps?: ThreadFollowUps } = { followUps: queueOf('a') };
  assert.equal(holdFollowUps(thread, 'interrupted', '앱 재시작', 9), true);
  assert.deepEqual(thread.followUps?.hold, { reason: 'interrupted', detail: '앱 재시작', at: 9 });
  assert.equal(releaseFollowUps(thread), true);
  assert.equal(thread.followUps?.hold, undefined);
  assert.equal(holdFollowUps({}, 'interrupted'), false, 'a thread without a queue is untouched');
});

test('follow-up ids are unique without crypto.randomUUID', () => {
  const crypto = globalThis.crypto;
  const original = crypto.randomUUID;
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true, writable: true });
  try {
    const ids = new Set(Array.from({ length: 50 }, () => createFollowUpId()));
    assert.equal(ids.size, 50);
    for (const id of ids) assert.match(id, /^fu-/);
  } finally {
    Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true, writable: true });
  }
});
