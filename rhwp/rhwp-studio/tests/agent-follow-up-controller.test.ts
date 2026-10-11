// 대기 메시지 런타임 — 사이드바의 사건(턴 시작·끝, 허브 거절, 채팅 전환)에 따라 언제 보내고 붙잡는지.
// 브리지와 DOM 대신 가짜 띠와 보내기를 쓴다. 사이드바는 setTurnRunning(false) 로 응답 대기를 걷은 뒤
// turnEnded 를 부르므로, 여기서도 턴 끝에는 working 이 거짓이 된다.
import assert from 'node:assert/strict';
import test from 'node:test';

import { HUB_USER_MESSAGE_BUSY, createFollowUpController } from '../src/ui/agent-sidebar/follow-up-controller.ts';
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
    /** 턴 끝 — 보내기로 정한 대기 메시지는 한 마이크로태스크 뒤에 나간다(같은 흐름의 실패 알림이 먼저 붙는다). */
    async end(stopReason = 'end_turn', owner = true, errorMessage?: string) {
      env.running = false;
      env.replyPending = false;
      controller.turnEnded({ stopReason, ...(errorMessage ? { errorMessage } : {}) }, owner);
      await null;
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
  await h.end('end_turn');
  assert.deepEqual(h.sent.map((entry) => entry.item.text), ['A']);
  assert.deepEqual(h.texts(), ['B']);
  await h.dispatched();
  h.start();
  await h.end('max_tokens');
  assert.deepEqual(h.sent.map((entry) => entry.item.text), ['A', 'B'], 'max_tokens completes the turn');
});

test('stop holds the queue; 보내기 sends the head and clears the hold', async () => {
  const h = harness();
  h.start();
  queue(h, 'A', 'B');
  h.controller.noteUserStop();
  await h.end('interrupted');
  assert.equal(h.hold(), 'stopped');
  assert.equal(h.sent.length, 0);
  h.controller.resume();
  assert.deepEqual(h.sent.map((entry) => entry.item.text), ['A']);
  assert.equal(h.hold(), null);
  await h.dispatched();
  h.start();
  await h.end('end_turn');
  assert.deepEqual(h.sent.map((entry) => entry.item.text), ['A', 'B']);
});

test('an interruption the user did not ask for, a failure and an error event hold with their reason', async () => {
  for (const [end, reason] of [
    [(h: ReturnType<typeof harness>) => h.end('interrupted'), 'interrupted'],
    [(h: ReturnType<typeof harness>) => h.end('exited', true, '허브가 다시 시작되어 작업이 중단됐습니다.'), 'failed'],
    [(h: ReturnType<typeof harness>) => { h.controller.agentError(); return h.end('end_turn'); }, 'failed'],
  ] as const) {
    const h = harness();
    h.start();
    queue(h, 'A');
    await end(h);
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
  await h.end('interrupted');
  assert.deepEqual(h.sent.map((entry) => entry.item.text), ['C']);
  assert.deepEqual(h.texts(), ['A', 'B']);
  assert.equal(h.hold(), null);
  // 그 뒤의 중지는 나중의 뜻이 이긴다.
  await h.dispatched();
  h.start();
  h.controller.sendNow(h.thread.followUps!.items[0]!.id);
  h.controller.noteUserStop();
  await h.end('interrupted');
  assert.equal(h.hold(), 'stopped');
  assert.equal(h.sent.length, 1);
});

test('send now before the turn opens waits for that turn to end, whatever the outcome', async () => {
  const h = harness();
  h.env.replyPending = true; // 보냈지만 turn-start 전
  queue(h, 'A', 'B');
  h.controller.sendNow(h.thread.followUps!.items[1]!.id);
  assert.equal(h.interrupts(), 0, 'a turn that has not opened is never interrupted');
  h.start();
  await h.end('failed');
  assert.deepEqual(h.sent.map((entry) => entry.item.text), ['B']);
});

test('a rejected queue send goes back to the head with a busy hold that the next normal end releases', async () => {
  const h = harness();
  h.start();
  queue(h, 'A', 'B');
  await h.end('end_turn');
  const messageId = await h.dispatched();
  assert.equal(h.controller.hubError({ code: 'AGENT_BUSY', messageId: 'someone-else' }), false);
  assert.equal(h.controller.hubError({ code: 'AGENT_BUSY', messageId }), true);
  assert.deepEqual(h.unsent, [h.sent[0]!.item.id]);
  assert.deepEqual(h.texts(), ['A', 'B']);
  assert.equal(h.hold(), 'busy');
  // 허브가 먼저 연 턴이 정상으로 끝나면 다시 간다.
  h.start();
  await h.end('end_turn');
  assert.deepEqual(h.sent.map((entry) => entry.item.text), ['A', 'A']);
  assert.equal(h.hold(), null);
});

test('other rejection codes hold as rejected with the code', async () => {
  const h = harness();
  h.start();
  queue(h, 'A');
  await h.end('end_turn');
  const messageId = await h.dispatched();
  assert.equal(h.controller.hubError({ code: 'STALE_CHAT_SCOPE', messageId }), true);
  assert.deepEqual(h.thread.followUps?.hold, { reason: 'rejected', code: 'STALE_CHAT_SCOPE', at: 100 });
  h.start();
  await h.end('end_turn');
  assert.equal(h.sent.length, 1, 'a rejected hold needs the user');
});

test('an older hub without messageId is matched only by its busy user-message refusal before the turn opens', async () => {
  const before = harness();
  before.start();
  queue(before, 'A');
  await before.end('end_turn');
  await before.dispatched();
  assert.equal(before.controller.hubError({ code: 'INVALID_REQUEST', message: 'chat-user-message requires text' }), false);
  assert.equal(before.controller.hubError({ code: 'AGENT_BUSY', message: HUB_USER_MESSAGE_BUSY }), true);
  assert.equal(before.hold(), 'busy');

  const after = harness();
  after.start();
  queue(after, 'A');
  await after.end('end_turn');
  await after.dispatched();
  after.start();
  assert.equal(after.controller.hubError({ code: 'AGENT_BUSY', message: HUB_USER_MESSAGE_BUSY }), false,
    'a turn already opened for it');
});

test('a settings change refused while the queued message waits for its turn does not send that message twice', async () => {
  // 대기 메시지를 보낸 뒤 turn-start 전의 틈: 허브는 이미 그 메시지를 돌리고 있다. 그 틈에 바꾼 템플릿·모드·
  // 권한·Fast·모델은 id 없는 AGENT_BUSY 로 거절된다 — 받아들인 대기 메시지의 거절이 아니다.
  for (const message of [
    'Templates can only change between turns.',
    'Workflow can only change while the agent is idle',
    'Permissions can only change between turns.',
    'Service tier can only change between turns.',
    'Provider settings can only change between turns.',
  ]) {
    const h = harness();
    h.start();
    queue(h, 'A');
    await h.end('end_turn');
    await h.dispatched();
    assert.equal(h.controller.hubError({ code: 'AGENT_BUSY', message }), false, message);
    assert.deepEqual(h.unsent, [], `${message}: the accepted message stays in the chat`);
    assert.deepEqual(h.texts(), [], `${message}: and does not return to the queue`);
    // 사이드바는 허브 오류 뒤 브리지 상태로 응답 대기를 걷고 정착한다.
    h.env.replyPending = false;
    h.controller.settle();
    // 허브가 받아 둔 그 메시지의 턴이 열리고 정상으로 끝난다.
    h.start();
    await h.end('end_turn');
    assert.deepEqual(h.sent.map((entry) => entry.item.text), ['A'], `${message}: sent once`);
  }
});

test('a message the bridge drops goes back to the head, held as interrupted', async () => {
  const h = harness();
  h.start();
  queue(h, 'A', 'B');
  await h.end('end_turn');
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
  await h.end('end_turn', false);
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

test('plan approval holds; editing defers the drain until the edit closes', async () => {
  const plan = harness();
  plan.start();
  queue(plan, 'A');
  plan.env.plan = true;
  await plan.end('end_turn');
  assert.equal(plan.hold(), 'plan-approval');

  const h = harness();
  h.start();
  queue(h, 'A', 'B');
  const first = h.thread.followUps!.items[0]!;
  h.controller.startEdit(first.id);
  assert.equal(h.view()?.editingId, first.id);
  await h.end('end_turn');
  assert.equal(h.sent.length, 0, 'the item being edited is not sent');
  assert.equal(h.hold(), null);
  h.controller.commitEdit(first.id, 'A 고침', true);
  assert.deepEqual(h.sent.map((entry) => entry.item.text), ['A 고침']);
});

test('switching chats holds the queue as stopped and reopening holds it as interrupted', async () => {
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
  await reopened.end('end_turn');
  assert.equal(reopened.sent.length, 0, 'a reopened queue never auto-sends');
});

test('leaving before the bridge sent a queued message puts it back in the queue', async () => {
  const h = harness();
  h.start();
  queue(h, 'A', 'B');
  await h.end('end_turn');
  assert.deepEqual(h.texts(), ['B']);
  h.controller.detach();
  assert.deepEqual(h.unsent, [h.sent[0]!.item.id]);
  assert.deepEqual(h.texts(), ['A', 'B']);
  assert.equal(h.hold(), 'stopped');
});

test('leaving in the gap after a queued send puts the accepted message back when the switch stops the chat', async () => {
  const h = harness();
  h.start();
  queue(h, 'A', 'B');
  await h.end('end_turn');
  await h.dispatched();
  // 허브는 A 를 받아 돌리지만 turn-start 는 아직 오지 않았다. 이 전환이 채팅을 멈추면 A 도 사라진다.
  h.controller.detach('stopped', { chatStops: true });
  assert.deepEqual(h.unsent, [h.sent[0]!.item.id], 'the bubble of the killed message is taken out');
  assert.deepEqual(h.texts(), ['A', 'B'], 'A is back at the head');
  assert.equal(h.hold(), 'stopped');

  // 채팅을 멈추지 않는 전환(이어 가기)은 받아들인 메시지를 그대로 둔다.
  const kept = harness();
  kept.start();
  queue(kept, 'A');
  await kept.end('end_turn');
  await kept.dispatched();
  kept.controller.detach('stopped', { chatStops: false });
  assert.deepEqual(kept.unsent, []);
  assert.deepEqual(kept.texts(), []);

  // 턴이 이미 열린 메시지는 그 턴(중단)과 함께 대화에 남는다.
  const opened = harness();
  opened.start();
  queue(opened, 'A');
  await opened.end('end_turn');
  await opened.dispatched();
  opened.start();
  opened.controller.detach('stopped', { chatStops: true });
  assert.deepEqual(opened.unsent, []);
  assert.deepEqual(opened.texts(), []);
});

test('a busy hold does not outlive the chat: leaving or reopening holds it until the user sends', async () => {
  const busyHold = async () => {
    const h = harness();
    h.start();
    queue(h, 'A');
    await h.end('end_turn');
    const messageId = await h.dispatched();
    assert.equal(h.controller.hubError({ code: 'AGENT_BUSY', messageId }), true);
    h.env.replyPending = false;
    h.controller.settle();
    assert.equal(h.hold(), 'busy');
    return h;
  };
  // 떠날 때(창 닫기·새로고침)
  const closed = await busyHold();
  closed.controller.detach('interrupted');
  assert.equal(closed.hold(), 'interrupted');
  closed.controller.attach();
  closed.start();
  await closed.end('end_turn');
  assert.equal(closed.sent.length, 1, 'an unrelated later turn does not send it');

  // 저장된 busy 붙잡음을 다시 열 때
  const reopened = harness();
  reopened.thread.followUps = { items: [{ id: 'x', text: 'X', createdAt: 1 }], hold: { reason: 'busy', at: 1 } };
  reopened.controller.attach();
  assert.equal(reopened.hold(), 'interrupted');
  reopened.start();
  await reopened.end('end_turn');
  assert.equal(reopened.sent.length, 0, 'a reopened busy queue never auto-sends');
});

test('a stop that loses the race to a normal end still holds the queue', async () => {
  const h = harness();
  h.start();
  queue(h, 'A');
  h.controller.noteUserStop();
  // 허브가 중지를 받기 전에 정상 종료를 보냈다.
  await h.end('end_turn');
  assert.equal(h.sent.length, 0, 'nothing is sent right after the user pressed stop');
  assert.equal(h.hold(), 'stopped');
});

test('S3 and U5 can relabel a hold, release it and read a snapshot', async () => {
  const h = harness();
  h.start();
  queue(h, 'A', 'B');
  await h.end('exited', true, '허브가 다시 시작되어 작업이 중단됐습니다.');
  h.controller.hold('interrupted', '허브 재시작');
  assert.deepEqual(h.controller.snapshot(), { count: 2, hold: { reason: 'interrupted', detail: '허브 재시작', at: 100 } });
  // 이어 가기 메시지를 보낸 바로 뒤에 푼다 — 그 턴의 정상 종료가 맨 앞을 보낸다.
  h.env.replyPending = true;
  h.controller.release();
  assert.equal(h.hold(), null);
  h.start();
  await h.end('end_turn');
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

test('a live turn re-adopted after reload releases the queue and drains at its normal end', async () => {
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
  await h.end('end_turn', false);
  assert.deepEqual(h.sent.map((entry) => entry.item.text), ['X']);
});

test('the eleventh item is refused with a hint and read-only chats cannot change the queue', async () => {
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

test('with the sidebar shared error flag, the queue reads the same error state as the turn fold', async () => {
  let sidebarErrorSeen = false;
  const failed = harness({ errorSeen: () => sidebarErrorSeen });
  failed.start();
  queue(failed, 'A');
  sidebarErrorSeen = true;
  await failed.end('end_turn');
  assert.equal(failed.hold(), 'failed', 'an error event seen by the sidebar holds the queue');
  assert.equal(failed.sent.length, 0);

  sidebarErrorSeen = false;
  const clean = harness({ errorSeen: () => sidebarErrorSeen });
  clean.start();
  queue(clean, 'A');
  await clean.end('end_turn');
  assert.deepEqual(clean.sent.map((entry) => entry.item.text), ['A'], 'no error: the head is sent');
});

test('re-adopting a live turn after a reload keeps holds the user must release', async () => {
  // 새로고침 전에 사용자가 멈춘 대기열 — 그 뒤 입력기로 보낸 턴이 돌던 중에 새로고침했다.
  const stopped = harness();
  stopped.thread.followUps = { items: [{ id: 'fu-1', text: '대기 A', createdAt: 1 }], hold: { reason: 'stopped', at: 1 } };
  stopped.controller.attach();
  stopped.env.running = true;
  stopped.controller.adoptLiveTurn();
  assert.equal(stopped.hold(), 'stopped', 'a user stop survives the re-adoption');
  await stopped.end('end_turn', false);
  assert.equal(stopped.sent.length, 0, 'the adopted turn ending normally does not send a queue the user stopped');

  // 엔진 멈춤(S7)으로 끊어 둔 대기열: 다시 잡은 턴이 끝나도 그 이유가 남고, 보내지 않는다.
  for (const stopReason of ['interrupted', 'end_turn']) {
    const trapped = harness();
    trapped.thread.followUps = {
      items: [{ id: 'fu-1', text: '대기 A', createdAt: 1 }],
      hold: { reason: 'interrupted', detail: '문서 엔진 멈춤', at: 1 },
    };
    trapped.controller.attach();
    trapped.env.running = true;
    trapped.controller.adoptLiveTurn({ revivedDetail: null });
    await trapped.end(stopReason, false);
    assert.equal(trapped.sent.length, 0, `${stopReason}: nothing is sent after an engine trap`);
    assert.equal(trapped.thread.followUps?.hold?.detail, '문서 엔진 멈춤', `${stopReason}: the trap reason stays on the hold`);
  }

  // 부팅 정리가 먼저 '새로고침'으로 끊었던 바로 그 턴을 되살렸으면 그 붙잡음은 풀린다.
  const revived = harness();
  revived.thread.followUps = {
    items: [{ id: 'fu-1', text: '대기 A', createdAt: 1 }],
    hold: { reason: 'interrupted', detail: '새로고침', at: 1 },
  };
  revived.controller.attach();
  revived.env.running = true;
  revived.controller.adoptLiveTurn({ revivedDetail: '새로고침' });
  assert.equal(revived.hold(), null);
  await revived.end('end_turn', false);
  assert.deepEqual(revived.sent.map((entry) => entry.item.text), ['대기 A']);
});

test('a chat-start failure reason on the hold is not replaced when the bridge drops the queued message', async () => {
  const h = harness();
  h.thread.followUps = {
    items: [{ id: 'fu-1', text: 'A', createdAt: 1 }, { id: 'fu-2', text: 'B', createdAt: 2 }],
    hold: { reason: 'interrupted', at: 1 },
  };
  // 허브 재시작 뒤 붙잡음 줄의 보내기 — 브리지는 메시지를 채팅 시작 뒤에 둔다.
  h.controller.resume();
  assert.equal(h.sent.length, 1);
  // 채팅 시작 실패: 브리지가 둔 메시지를 null 로 끝낸 뒤 허브 오류를 알린다 — 사이드바는 그 이유로 붙잡는다.
  assert.equal(h.controller.hubError({ code: 'AGENT_SPAWN_FAILED', message: 'spawn failed' }), false);
  h.controller.hold('failed', 'Claude CLI 없음');
  h.env.replyPending = false;
  h.controller.settle();
  h.sent[0]!.resolve(null);
  await h.flush();
  assert.deepEqual(h.texts(), ['A', 'B'], 'the dropped message is back at the head');
  assert.deepEqual(h.unsent, ['fu-1']);
  assert.deepEqual(h.thread.followUps?.hold, { reason: 'failed', detail: 'Claude CLI 없음', at: 100 },
    'the strip keeps saying why the chat could not start');
});

test('a stop pressed while a queued message waits for its turn holds the rest as stopped', async () => {
  const h = harness();
  h.start();
  queue(h, 'A', 'B');
  await h.end('end_turn');
  await h.dispatched();
  // A 를 보냈고 허브가 아직 그 턴을 열지 않았다. 사용자가 중지를 누른다.
  h.controller.noteUserStop();
  h.start();
  await h.end('interrupted');
  assert.equal(h.hold(), 'stopped', 'the stop is the user\'s, not an interruption');
  assert.deepEqual(h.texts(), ['B']);

  // 브리지가 그 메시지를 아예 버렸으면(턴이 오지 않는다) 되돌린 대기열도 '멈춤'이고, 그 중지는 다음 턴에 남지 않는다.
  const dropped = harness();
  dropped.start();
  queue(dropped, 'A', 'B');
  await dropped.end('end_turn');
  dropped.controller.noteUserStop();
  dropped.sent[0]!.resolve(null);
  dropped.env.replyPending = false; // 버린 메시지는 응답을 기다리지 않는다
  await dropped.flush();
  assert.equal(dropped.hold(), 'stopped');
  assert.deepEqual(dropped.texts(), ['A', 'B']);
  dropped.controller.resume();
  await dropped.dispatched();
  dropped.start();
  await dropped.end('end_turn');
  assert.deepEqual(dropped.sent.map((entry) => entry.item.text), ['A', 'A', 'B'], 'the next turn is not treated as stopped');
});
