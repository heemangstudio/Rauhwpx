// 대기열(U1)과 실패 알림(U5)이 한 턴 끝을 함께 다룰 때 — 실패한 턴의 알림은 그 턴의 요청을 다시 보내고
// 그 턴의 자리에 선다. 대기열이 그 턴 끝에서 다음 메시지를 보내도, 허브가 받지 않아 되돌린 메시지가 있어도.
// 사이드바(index.ts)처럼 대기 메시지의 보내기는 기록에 말풍선을 남기고 마지막 전송을 알리며, 되돌리기는
// 그 전송을 잊는다. 브리지처럼 turn-failure 는 turn-end 바로 뒤 같은 흐름에서 온다.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createFollowUpController } from '../src/ui/agent-sidebar/follow-up-controller.ts';
import { createFailureDismissals, createFailureNoticeController } from '../src/ui/agent-sidebar/failure-notice.ts';
import type { ChatThread, ThreadMessage } from '../src/agent/threads.ts';
import type { ProviderFailure } from '../src/agent/types.ts';

class FakeElement {
  children: FakeElement[] = [];
  className = '';
  textContent = '';
  hidden = false;
  type = '';
  title = '';
  disabled = false;
  dataset: Record<string, string> = {};
  isConnected = true;
  classList = { add() {}, remove() {}, toggle() {} };
  setAttribute() {}
  addEventListener() {}
  append(...nodes: FakeElement[]) { this.children.push(...nodes); }
  replaceWith() {}
}
Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new FakeElement() } });

const usageLimit: ProviderFailure = {
  class: 'usage_limit', agent: 'claude', message: 'limit reached', code: null, retryable: false, resetAt: null,
};
const network: ProviderFailure = {
  class: 'network', agent: 'claude', message: 'socket hang up', code: null, retryable: true, resetAt: null,
};

function sidebar() {
  const thread = { id: 't1', messages: [] as ThreadMessage[] } as unknown as ChatThread;
  const store = new Map<string, string>();
  const notices = createFailureNoticeController({
    thread: () => thread,
    persist: () => {},
    persistThread: () => {},
    append: () => {},
    agentLabel: () => 'Claude',
    isTurnRunning: () => env.running,
    isConnected: () => true,
    reconnected: () => false,
    openLogin: () => {},
    openSettings: () => {},
    restartSession: () => {},
    resend: () => true,
    dismissals: createFailureDismissals(() => ({
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    }) as unknown as Storage),
    now: () => 1_000,
  });
  const env = { running: false, replyPending: false };
  const receipts: Array<(id: string | null) => void> = [];
  const followUps = createFollowUpController<ThreadMessage, object>({
    strip: { root: {} as HTMLElement, render: () => {}, announce: () => {}, showHint: () => {}, clearHint: () => {}, editingText: () => null },
    thread: () => thread,
    persist: () => {},
    // sendComposedMessage: 기록·말풍선을 남기고 마지막 전송을 알린 뒤 브리지에 넘긴다.
    send: (item) => {
      const message: ThreadMessage = { role: 'user', text: item.text };
      thread.messages.push(message);
      notices.noteSend(thread.id, { displayText: item.text, requestText: item.text }, message);
      env.replyPending = true;
      return { message, bubble: {}, sent: new Promise<string | null>((resolve) => receipts.push(resolve)) };
    },
    // unrecordUserMessage: 기록에서 걷고, 그 전송을 다시 보낼 요청으로 삼지 않는다.
    unsend: (message) => {
      thread.messages.splice(thread.messages.indexOf(message), 1);
      notices.forgetSend(message);
    },
    interrupt: () => {},
    isTurnRunning: () => env.running,
    isWorking: () => env.running || env.replyPending,
    sendBlockedReason: () => null,
    readOnly: () => false,
    turnContext: () => ({ planAwaitingApproval: false, engineTrapped: false, mergeLocked: false }),
    focusComposer: () => {},
    onChange: () => {},
    now: () => 100,
  });
  /** 입력기로 보낸 요청 — 기록과 마지막 전송. */
  const compose = (text: string) => {
    const message: ThreadMessage = { role: 'user', text };
    thread.messages.push(message);
    notices.noteSend(thread.id, { displayText: text, requestText: text }, message);
    env.replyPending = true;
  };
  const turnStart = () => {
    env.running = true;
    env.replyPending = false;
    followUps.turnStarted();
  };
  /** 턴 끝 — 브리지는 turn-end 를 알린 뒤 같은 흐름에서 그 턴의 실패를 알린다. */
  const turnEnd = (event: { stopReason: string }, failure: ProviderFailure | null) => {
    env.running = false;
    followUps.turnEnded(event, true);
    if (!failure) return null;
    const notice = notices.add(failure, { origin: 'turn', turnId: 'turn-1', userInitiated: true });
    const hold = notices.queueHold(notice);
    followUps.hold(hold.reason, hold.detail);
    return notice;
  };
  const transcript = () => thread.messages.map((message) => (message.role === 'user' ? message.text : message.kind));
  return { thread, notices, followUps, env, receipts, compose, turnStart, turnEnd, transcript };
}

const flush = () => new Promise<void>((done) => setImmediate(done));

test('a failed turn keeps its own retry and its place when send-now drains the next message at its end', async () => {
  const s = sidebar();
  s.compose('M1 원래 요청');
  s.turnStart();
  assert.ok(s.followUps.enqueue({ text: 'M2 대기 메시지' }));
  // Ctrl/⌘+Enter — 턴을 멈추고 M2 부터 보낸다. 멈추기 전에 사용 한도 오류가 이미 났다.
  s.followUps.sendNowHead();
  const notice = s.turnEnd({ stopReason: 'interrupted' }, usageLimit)!;
  await flush();
  assert.equal(notice.retry?.displayText, 'M1 원래 요청', 'the notice retries the request of the turn that failed');
  assert.deepEqual(s.transcript(), ['M1 원래 요청', 'error', 'M2 대기 메시지'],
    'the notice sits where that turn ended, before the message the queue sent next');
  assert.equal(s.thread.followUps, undefined, 'the user asked for M2: it is sent and nothing is left held');
});

test('a message the hub bounced is not the retry of the hub turn that failed meanwhile', async () => {
  const s = sidebar();
  s.compose('M1');
  s.turnStart();
  assert.ok(s.followUps.enqueue({ text: '거절될 요청' }));
  s.turnEnd({ stopReason: 'end_turn' }, null);
  await flush();
  assert.deepEqual(s.transcript(), ['M1', '거절될 요청'], 'the normal end sent the queued message');
  s.receipts[0]!('message-2');
  await flush();
  // 허브가 스스로 연 턴의 turn-start 가 그 메시지의 거절보다 먼저 온다.
  s.turnStart();
  assert.equal(s.followUps.hubError({ code: 'AGENT_BUSY', messageId: 'message-2' }), true);
  assert.deepEqual(s.transcript(), ['M1'], 'the bounced message left the conversation');
  // 그 허브 턴이 실패한다.
  const notice = s.turnEnd({ stopReason: 'failed' }, network)!;
  await flush();
  assert.equal(notice.retry, undefined, 'the bounced message is back in the queue — not a second way to send it');
  assert.deepEqual(s.thread.followUps?.items.map((item) => item.text), ['거절될 요청']);
});
