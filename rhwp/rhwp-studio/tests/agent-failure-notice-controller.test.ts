// 사이드바 하나의 실패 알림 묶음 — 알림이 어느 채팅에 남는지, 어떤 전송이 '다시 시도' 할 요청을
// 남기는지, 걸어 둔 '리셋 후 이어서' 가 언제 거둬지는지. 화면 없이 도는 최소 DOM 으로 본다.
import assert from 'node:assert/strict';
import test from 'node:test';

/** 알림이 만드는 만큼만 흉내 낸 DOM 요소. */
class FakeElement {
  children: FakeElement[] = [];
  className = '';
  textContent = '';
  hidden = false;
  disabled = false;
  type = '';
  title = '';
  dataset: Record<string, string> = {};
  connected = false;
  private listeners = new Map<string, Array<() => void>>();
  private classes = new Set<string>();
  classList = {
    add: (name: string) => { this.classes.add(name); },
    remove: (name: string) => { this.classes.delete(name); },
    contains: (name: string) => this.classes.has(name) || this.className.split(/\s+/).includes(name),
  };
  get isConnected(): boolean { return this.connected; }
  setAttribute() {}
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  click() { for (const listener of this.listeners.get('click') ?? []) listener(); }
  append(...nodes: FakeElement[]) { this.children.push(...nodes); }
  replaceWith(next: FakeElement) { next.connected = this.connected; this.connected = false; }
  find(predicate: (node: FakeElement) => boolean): FakeElement | null {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const found = child.find(predicate);
      if (found) return found;
    }
    return null;
  }
}

Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { createElement: () => new FakeElement() },
});

const { createFailureNoticeController, createFailureDismissals } = await import('../src/ui/agent-sidebar/failure-notice.ts');
type ChatThread = import('../src/agent/threads.ts').ChatThread;
type ProviderFailure = import('../src/agent/types.ts').ProviderFailure;
type ThreadRetryPayload = import('../src/agent/threads.ts').ThreadRetryPayload;

function thread(id: string): ChatThread {
  return {
    id, title: id, titleRequested: false, createdAt: 0, updatedAt: 0, agent: 'claude', model: 'm', effort: 'medium',
    serviceTier: 'standard', workflow: 'direct', docKey: null, documentId: null, messages: [],
  } as unknown as ChatThread;
}

function failure(overrides: Partial<ProviderFailure> = {}): ProviderFailure {
  return { class: 'network', agent: 'claude', message: 'stream disconnected', code: null, retryable: true, resetAt: null, ...overrides };
}

function sidebar(shown: ChatThread) {
  const drawn: FakeElement[] = [];
  const saved: string[] = [];
  const resent: ThreadRetryPayload[] = [];
  let persisted = 0;
  const controller = createFailureNoticeController({
    thread: () => shown,
    persist: () => { persisted += 1; },
    persistThread: (target) => { saved.push(target.id); },
    append: (node) => {
      const element = node as unknown as FakeElement;
      element.connected = true;
      drawn.push(element);
    },
    agentLabel: () => 'Claude',
    isTurnRunning: () => false,
    isConnected: () => true,
    reconnected: () => false,
    openLogin: () => {},
    openSettings: () => {},
    restartSession: () => {},
    resend: (retry) => { resent.push(retry); return true; },
    resumeGraceMs: 0,
    dismissals: createFailureDismissals(() => null),
  });
  const action = (node: FakeElement, id: string) => node.find((element) => element.dataset.action === id);
  return { controller, drawn, saved, resent, persisted: () => persisted, action };
}

/** 리셋까지의 여유 — 첫 렌더의 Intl 로캘 적재가 끝나기 전에 리셋이 지나지 않을 만큼. */
const RESET_IN_MS = 500;
const SEND = { displayText: '표로 정리해 주세요', requestText: '표로 정리해 주세요' };

test('a failed turn of another chat is stored in that chat, not drawn in the one being shown', () => {
  const shown = thread('shown');
  const owner = thread('owner');
  const { controller, drawn, saved, persisted } = sidebar(shown);
  controller.noteSend(owner.id, SEND);
  const notice = controller.add(failure(), { origin: 'turn', turnId: 't1', userInitiated: true }, owner);
  assert.deepEqual(owner.messages, [notice], 'the notice belongs to the chat whose turn failed');
  assert.deepEqual(shown.messages, [], 'the shown chat is untouched');
  assert.deepEqual(drawn, [], 'nothing is drawn into the shown chat');
  assert.deepEqual(saved, ['owner']);
  assert.equal(persisted(), 0);
  assert.equal(notice.retry?.requestText, SEND.requestText, 'the owner chat keeps its own resend');

  // 주인이 보이는 채팅이면 평소처럼 그린다.
  const own = controller.add(failure(), { origin: 'turn', turnId: 't2', userInitiated: true }, shown);
  assert.deepEqual(shown.messages, [own]);
  assert.equal(drawn.length, 1);
});

test('an inline-prompt send leaves nothing to resend, not even the previous composer request', () => {
  const shown = thread('t');
  const { controller, drawn, action } = sidebar(shown);
  controller.noteSend(shown.id, SEND);
  // 인라인 프롬프트: 선택 맥락이 그 순간의 문서에 묶인 요청 — 다시 보낼 요청을 남기지 않는다.
  controller.noteSend(shown.id, null);
  const notice = controller.add(failure(), { origin: 'turn', turnId: 't1', userInitiated: true });
  assert.equal(notice.retry, undefined);
  assert.equal(action(drawn[0]!, 'retry'), null, 'no 다시 시도 for an inline send');
});

test('a plan approval or plan-change send cancels an armed 리셋 후 이어서', async () => {
  const shown = thread('t');
  const { controller, drawn, resent, action } = sidebar(shown);
  controller.noteSend(shown.id, SEND);
  controller.add(
    failure({ class: 'usage_limit', message: "You've hit your limit", retryable: false, resetAt: Date.now() + RESET_IN_MS }),
    { origin: 'turn', turnId: 't1', userInitiated: true },
  );
  action(drawn[0]!, 'resume')!.click();
  // 계획 승인·수정은 noteSend 를 거치지 않는 이 채팅의 전송이다.
  controller.clearLastSend();
  await new Promise((resolve) => setTimeout(resolve, RESET_IN_MS + 400));
  assert.deepEqual(resent, [], 'the armed resume does not fire after another send in this chat');

  // 거두지 않았다면 리셋 뒤 한 번 보낸다 (같은 조건의 대조).
  const other = sidebar(thread('u'));
  other.controller.noteSend('u', SEND);
  other.controller.add(
    failure({ class: 'usage_limit', message: "You've hit your limit", retryable: false, resetAt: Date.now() + RESET_IN_MS }),
    { origin: 'turn', turnId: 't1', userInitiated: true },
  );
  other.action(other.drawn[0]!, 'resume')!.click();
  await new Promise((resolve) => setTimeout(resolve, RESET_IN_MS + 400));
  assert.deepEqual(other.resent.map((retry) => retry.requestText), [SEND.requestText]);
  controller.dispose();
  other.controller.dispose();
});

test('only the newest failure notice keeps the request to resend; the newest still resends it', () => {
  const shown = thread('t');
  const { controller, drawn, resent, action } = sidebar(shown);
  controller.noteSend(shown.id, SEND);
  const first = controller.add(failure(), { origin: 'turn', turnId: 't1', userInitiated: true });
  assert.equal(first.retry?.requestText, SEND.requestText);
  const second = controller.add(failure({ message: 'second disconnect' }), { origin: 'turn', turnId: 't2', userInitiated: true });
  assert.equal(first.retry, undefined, 'an earlier notice no longer carries its resend payload');
  assert.equal(second.retry?.requestText, SEND.requestText);
  action(drawn.at(-1)!, 'retry')!.click();
  assert.deepEqual(resent.map((retry) => retry.requestText), [SEND.requestText]);
});
