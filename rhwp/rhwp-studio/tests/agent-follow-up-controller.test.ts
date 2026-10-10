// 대기 메시지 런타임 — 사이드바의 사건(턴 시작·끝, 허브 거절, 채팅 전환)에 따라 언제 보내고 붙잡는지.
// 브리지와 DOM 대신 가짜 띠와 보내기를 쓴다. 사이드바는 setTurnRunning(false) 로 응답 대기를 걷은 뒤
// turnEnded 를 부르므로, 여기서도 턴 끝에는 working 이 거짓이 된다.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createFollowUpController } from '../src/ui/agent-sidebar/follow-up-controller.ts';
import type { FollowUpStripView } from '../src/ui/agent-sidebar/follow-up-strip.ts';
import type { FollowUpItem, ThreadFollowUps } from '../src/agent/follow-ups.ts';

interface Sent { item: FollowUpItem; resolve(value: string | null): void }

function harness(opts: { errorSeen?: () => boolean } = {}) {
  const thread: { followUps?: ThreadFollowUps } = {};
  const sent: Sent[] = [];
  const unsent: string[] = [];
  const hints: string[] = [];
  let lastView: FollowUpStripView | null = null;
  let editing: string | null = null;
  let interrupts = 0;
  let persists = 0;
  const env = { running: false, replyPending: false, blocked: null as string | null, readOnly: false, plan: false };
  const controller = createFollowUpController<{ id: string }, object>({
    strip: {
      root: {} as HTMLElement,
      render: (view) => { lastView = view; },
      announce: () => {},
      showHint: (message) => { hints.push(message); },
      clearHint: () => {},
      editingText: () => editing,
    },
    thread: () => thread,
    persist: () => { persists += 1; },
    send: (item) => {
      let resolve!: (value: string | null) => void;
      const promise = new Promise<string | null>((done) => { resolve = done; });
      sent.push({ item, resolve });
      env.replyPending = true;
      return { message: { id: item.id }, bubble: {}, sent: promise };
    },
    unsend: (message) => { unsent.push(message.id); },
    interrupt: () => { interrupts += 1; },
    isTurnRunning: () => env.running,
    isWorking: () => env.running || env.replyPending,
    sendBlockedReason: () => env.blocked,
    readOnly: () => env.readOnly,
    turnContext: () => ({ planAwaitingApproval: env.plan, engineTrapped: false, mergeLocked: false }),
    focusComposer: () => {},
    onChange: () => {},
    now: () => 100,
    ...(opts.errorSeen ? { errorSeen: opts.errorSeen } : {}),
  });
  const flush = () => new Promise<void>((done) => setImmediate(done));
  return {
    controller,
    thread,
    sent,
    unsent,
    hints,
    env,
    view: () => lastView,
    interrupts: () => interrupts,
    persists: () => persists,
    setEditingText: (text: string | null) => { editing = text; },
    texts: () => thread.followUps?.items.map((item) => item.text) ?? [],
    hold: () => thread.followUps?.hold?.reason ?? null,
    start() {
      env.running = true;
      controller.turnStarted();
    },
    end(stopReason = 'end_turn', owner = true, errorMessage?: string) {
      env.running = false;
      env.replyPending = false;
      controller.turnEnded({ stopReason, ...(errorMessage ? { errorMessage } : {}) }, owner);
    },
    /** 보낸 대기 메시지를 브리지가 내보냈다(receipt id). */
    async dispatched(index = -1, id = `message-${sent.length}`) {
      sent.at(index)!.resolve(id);
      await flush();
      return id;
    },
    flush,
  };
}

const queue = (h: ReturnType<typeof harness>, ...texts: string[]) => {
  for (const text of texts) assert.ok(h.controller.enqueue({ text }));
};

test('a normal end sends the head, and the next item waits for that turn to end normally', async () => {
  const h = harness();
  h.start();
  queue(h, 'A', 'B');
  assert.deepEqual(h.texts(), ['A', 'B']);
  assert.ok(h.persists() > 0, 'every queue change is persisted');
  h.end('end_turn');
  assert.deepEqual(h.sent.map((entry) => entry.item.text), ['A']);
  assert.deepEqual(h.texts(), ['B']);
  await h.dispatched();
  h.start();
  h.end('max_tokens');
  assert.deepEqual(h.sent.map((entry) => entry.item.text), ['A', 'B'], 'max_tokens completes the turn');
});

test('stop holds the queue; 보내기 sends the head and clears the hold', async () => {
  const h = harness();
  h.start();
  queue(h, 'A', 'B');
  h.controller.noteUserStop();
  h.end('interrupted');
  assert.equal(h.hold(), 'stopped');
  assert.equal(h.sent.length, 0);
  h.controller.resume();
  assert.deepEqual(h.sent.map((entry) => entry.item.text), ['A']);
  assert.equal(h.hold(), null);
  await h.dispatched();
  h.start();
  h.end('end_turn');
  assert.deepEqual(h.sent.map((entry) => entry.item.text), ['A', 'B']);
});

test('an interruption the user did not ask for, a failure and an error event hold with their reason', () => {
  for (const [end, reason] of [
    [(h: ReturnType<typeof harness>) => h.end('interrupted'), 'interrupted'],
    [(h: ReturnType<typeof harness>) => h.end('exited', true, '허브가 다시 시작되어 작업이 중단됐습니다.'), 'failed'],
    [(h: ReturnType<typeof harness>) => { h.controller.agentError(); h.end('end_turn'); }, 'failed'],
  ] as const) {
    const h = harness();
    h.start();
    queue(h, 'A');
    end(h);
    assert.equal(h.hold(), reason);
    assert.equal(h.sent.length, 0);
  }
});

test('send now while running stops the turn and sends that item first; the rest stays unheld', async () => {
  const h = harness();
  h.start();
  queue(h, 'A', 'B', 'C');
  const urgent = h.thread.followUps!.items[2]!;
  h.controller.sendNow(urgent.id);
  assert.equal(h.interrupts(), 1);
  assert.deepEqual(h.texts(), ['C', 'A', 'B']);
  h.end('interrupted');
  assert.deepEqual(h.sent.map((entry) => entry.item.text), ['C']);
  assert.deepEqual(h.texts(), ['A', 'B']);
  assert.equal(h.hold(), null);
  // 그 뒤의 중지는 나중의 뜻이 이긴다.
  await h.dispatched();
  h.start();
  h.controller.sendNow(h.thread.followUps!.items[0]!.id);
  h.controller.noteUserStop();
  h.end('interrupted');
  assert.equal(h.hold(), 'stopped');
  assert.equal(h.sent.length, 1);
});

test('send now before the turn opens waits for that turn to end, whatever the outcome', () => {
  const h = harness();
  h.env.replyPending = true; // 보냈지만 turn-start 전
  queue(h, 'A', 'B');
  h.controller.sendNow(h.thread.followUps!.items[1]!.id);
  assert.equal(h.interrupts(), 0, 'a turn that has not opened is never interrupted');
  h.start();
  h.end('failed');
  assert.deepEqual(h.sent.map((entry) => entry.item.text), ['B']);
});

test('a rejected queue send goes back to the head with a busy hold that the next normal end releases', async () => {
  const h = harness();
  h.start();
  queue(h, 'A', 'B');
  h.end('end_turn');
  const messageId = await h.dispatched();
  assert.equal(h.controller.hubError({ code: 'AGENT_BUSY', messageId: 'someone-else' }), false);
  assert.equal(h.controller.hubError({ code: 'AGENT_BUSY', messageId }), true);
  assert.deepEqual(h.unsent, [h.sent[0]!.item.id]);
  assert.deepEqual(h.texts(), ['A', 'B']);
  assert.equal(h.hold(), 'busy');
  // 허브가 먼저 연 턴이 정상으로 끝나면 다시 간다.
  h.start();
  h.end('end_turn');
  assert.deepEqual(h.sent.map((entry) => entry.item.text), ['A', 'A']);
  assert.equal(h.hold(), null);
});

test('other rejection codes hold as rejected with the code', async () => {
  const h = harness();
  h.start();
  queue(h, 'A');
  h.end('end_turn');
  const messageId = await h.dispatched();
  assert.equal(h.controller.hubError({ code: 'STALE_CHAT_SCOPE', messageId }), true);
  assert.deepEqual(h.thread.followUps?.hold, { reason: 'rejected', code: 'STALE_CHAT_SCOPE', at: 100 });
  h.start();
  h.end('end_turn');
  assert.equal(h.sent.length, 1, 'a rejected hold needs the user');
});

test('an older hub without messageId is matched only by AGENT_BUSY before the turn opens', async () => {
  const before = harness();
  before.start();
  queue(before, 'A');
  before.end('end_turn');
  await before.dispatched();
  assert.equal(before.controller.hubError({ code: 'INVALID_REQUEST' }), false);
  assert.equal(before.controller.hubError({ code: 'AGENT_BUSY' }), true);
  assert.equal(before.hold(), 'busy');

  const after = harness();
  after.start();
  queue(after, 'A');
  after.end('end_turn');
  await after.dispatched();
  after.start();
  assert.equal(after.controller.hubError({ code: 'AGENT_BUSY' }), false, 'a turn already opened for it');
});

test('a message the bridge drops goes back to the head, held as interrupted', async () => {
  const h = harness();
  h.start();
  queue(h, 'A', 'B');
  h.end('end_turn');
  h.sent[0]!.resolve(null);
  await h.flush();
  assert.deepEqual(h.unsent, [h.sent[0]!.item.id]);
  assert.deepEqual(h.texts(), ['A', 'B']);
  assert.equal(h.hold(), 'interrupted');
});

test('a turn end this chat did not own, or an unobserved end, holds instead of sending', async () => {
  const h = harness();
  h.start();
  queue(h, 'A');
  h.end('end_turn', false);
  assert.equal(h.sent.length, 0);
  assert.equal(h.hold(), 'interrupted');

  // 연결이 다시 맞춰지며 턴이 끝난 것을 알게 된 경우: 정착 지점이 붙잡는다.
  const resync = harness();
  resync.start();
  queue(resync, 'A');
  resync.env.running = false;
  resync.controller.settle();
  assert.equal(resync.hold(), 'interrupted');
});

test('plan approval holds; editing defers the drain until the edit closes', () => {
  const plan = harness();
  plan.start();
  queue(plan, 'A');
  plan.env.plan = true;
  plan.end('end_turn');
  assert.equal(plan.hold(), 'plan-approval');

  const h = harness();
  h.start();
  queue(h, 'A', 'B');
  const first = h.thread.followUps!.items[0]!;
  h.controller.startEdit(first.id);
  assert.equal(h.view()?.editingId, first.id);
  h.end('end_turn');
  assert.equal(h.sent.length, 0, 'the item being edited is not sent');
  assert.equal(h.hold(), null);
  h.controller.commitEdit(first.id, 'A 고침', true);
  assert.deepEqual(h.sent.map((entry) => entry.item.text), ['A 고침']);
});

test('switching chats holds the queue as stopped and reopening holds it as interrupted', () => {
  const h = harness();
  h.start();
  queue(h, 'A', 'B');
  const editingId = h.thread.followUps!.items[1]!.id;
  h.controller.startEdit(editingId);
  h.setEditingText('B 고치는 중');
  h.controller.detach();
  assert.equal(h.hold(), 'stopped');
  assert.deepEqual(h.texts(), ['A', 'B 고치는 중'], 'an open edit is saved');

  const reopened = harness();
  reopened.thread.followUps = { items: [{ id: 'x', text: 'X', createdAt: 1 }] };
  reopened.controller.attach();
  assert.equal(reopened.hold(), 'interrupted');
  reopened.start();
  reopened.end('end_turn');
  assert.equal(reopened.sent.length, 0, 'a reopened queue never auto-sends');
});

test('leaving before the bridge sent a queued message puts it back in the queue', () => {
  const h = harness();
  h.start();
  queue(h, 'A', 'B');
  h.end('end_turn');
  assert.deepEqual(h.texts(), ['B']);
  h.controller.detach();
  assert.deepEqual(h.unsent, [h.sent[0]!.item.id]);
  assert.deepEqual(h.texts(), ['A', 'B']);
  assert.equal(h.hold(), 'stopped');
});

test('S3 and U5 can relabel a hold, release it and read a snapshot', async () => {
  const h = harness();
  h.start();
  queue(h, 'A', 'B');
  h.end('exited', true, '허브가 다시 시작되어 작업이 중단됐습니다.');
  h.controller.hold('interrupted', '허브 재시작');
  assert.deepEqual(h.controller.snapshot(), { count: 2, hold: { reason: 'interrupted', detail: '허브 재시작', at: 100 } });
  // 이어 가기 메시지를 보낸 바로 뒤에 푼다 — 그 턴의 정상 종료가 맨 앞을 보낸다.
  h.env.replyPending = true;
  h.controller.release();
  assert.equal(h.hold(), null);
  h.start();
  h.end('end_turn');
  assert.deepEqual(h.sent.map((entry) => entry.item.text), ['A']);

  const empty = harness();
  empty.controller.hold('failed', '사용 한도');
  assert.deepEqual(empty.controller.snapshot(), { count: 0, hold: null });

  // 아무것도 보내지 않은 채 풀면 다음 정착 지점이 다시 붙잡는다.
  const idle = harness();
  idle.thread.followUps = { items: [{ id: 'x', text: 'X', createdAt: 1 }], hold: { reason: 'failed', at: 1 } };
  idle.controller.release();
  idle.controller.settle();
  assert.equal(idle.hold(), 'interrupted');
});

test('a live turn re-adopted after reload releases the queue and drains at its normal end', () => {
  const h = harness();
  h.thread.followUps = { items: [{ id: 'x', text: 'X', createdAt: 1 }] };
  h.controller.attach();
  assert.equal(h.hold(), 'interrupted');
  h.env.running = true;
  h.controller.adoptLiveTurn();
  assert.equal(h.hold(), null);
  h.controller.settle();
  assert.equal(h.hold(), null, 'a running adopted turn keeps the queue unheld');
  // 다시 잡은 턴은 이 페이지에서 turn-start 를 보지 못했다.
  h.end('end_turn', false);
  assert.deepEqual(h.sent.map((entry) => entry.item.text), ['X']);
});

test('the eleventh item is refused with a hint and read-only chats cannot change the queue', () => {
  const h = harness();
  h.start();
  for (let index = 0; index < 10; index += 1) queue(h, `글 ${index}`);
  assert.equal(h.controller.enqueue({ text: '넘침' }), null);
  assert.deepEqual(h.hints, ['대기 메시지는 10개까지 둘 수 있어요']);
  h.env.readOnly = true;
  const head = h.thread.followUps!.items[0]!.id;
  h.controller.removeItem(head);
  h.controller.sendNow(head);
  assert.equal(h.texts().length, 10);
  assert.equal(h.interrupts(), 0);
});

test('with the sidebar shared error flag, the queue reads the same error state as the turn fold', () => {
  let sidebarErrorSeen = false;
  const failed = harness({ errorSeen: () => sidebarErrorSeen });
  failed.start();
  queue(failed, 'A');
  sidebarErrorSeen = true;
  failed.end('end_turn');
  assert.equal(failed.hold(), 'failed', 'an error event seen by the sidebar holds the queue');
  assert.equal(failed.sent.length, 0);

  sidebarErrorSeen = false;
  const clean = harness({ errorSeen: () => sidebarErrorSeen });
  clean.start();
  queue(clean, 'A');
  clean.end('end_turn');
  assert.deepEqual(clean.sent.map((entry) => entry.item.text), ['A'], 'no error: the head is sent');
});
