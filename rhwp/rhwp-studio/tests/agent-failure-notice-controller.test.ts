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
  appendChild(node: FakeElement) { this.children.push(node); return node; }
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
  value: { createElement: () => new FakeElement(), createElementNS: () => new FakeElement() },
});

const { createFailureNoticeController, createFailureDismissals } = await import('../src/ui/agent-sidebar/failure-notice.ts');
type ChatThread = import('../src/agent/threads.ts').ChatThread;
type ProviderFailure = import('../src/agent/types.ts').ProviderFailure;
type ThreadRetryPayload = import('../src/agent/threads.ts').ThreadRetryPayload;

function thread(id: string): ChatThread {
  return {
    id, title: id, titleRequested: false, createdAt: 0, updatedAt: 0, agent: 'claude', model: 'm', effort: 'medium',
    workflow: 'direct', docKey: null, documentId: null, messages: [],
  } as unknown as ChatThread;
}

function failure(overrides: Partial<ProviderFailure> = {}): ProviderFailure {
  return { class: 'network', agent: 'claude', message: 'stream disconnected', code: null, retryable: true, resetAt: null, ...overrides };
}

interface FakeAutofix {
  ready: boolean;
  created: Array<{ onFixed(): void; request(): { surface: string; attempts?: number } }>;
}

function sidebar(shown: ChatThread, autofix?: FakeAutofix) {
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
    ...(autofix ? {
      autofix: {
        ready: () => autofix.ready,
        create: (options: FakeAutofix['created'][number]) => {
          autofix.created.push(options);
          const element = new FakeElement();
          element.dataset.action = 'autofix';
          return { element: element as unknown as HTMLButtonElement, phase: () => 'idle' as const, dispose: () => {} };
        },
      },
    } : {}),
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
  // 인라인 프롬프트: 선택 콘텍스트가 그 순간의 문서에 묶인 요청 — 다시 보낼 요청을 남기지 않는다.
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

/** 같은 실패가 다시 시도 뒤에 또 나는 흐름 — 사용자의 다시 시도가 다시 보낸 요청이 또 실패한다. */
function failRetryLoop(h: ReturnType<typeof sidebar>, shown: ChatThread, times: number, kind: Partial<ProviderFailure> = {}) {
  let notice = h.controller.add(failure(kind), { origin: 'turn', turnId: 't0', userInitiated: true });
  for (let index = 1; index <= times; index += 1) {
    h.action(h.drawn.at(-1)!, 'retry')!.click();
    h.controller.noteSend(shown.id, SEND);
    notice = h.controller.add(failure(kind), { origin: 'turn', turnId: `t${index}`, userInitiated: true });
  }
  return notice;
}

test('two failed retries of the same failure turn 다시 시도 into 자동 수정, which retries once fixed', () => {
  const shown = thread('t');
  const autofix: FakeAutofix = { ready: true, created: [] };
  const h = sidebar(shown, autofix);
  h.controller.noteSend(shown.id, SEND);
  failRetryLoop(h, shown, 1);
  assert.ok(h.action(h.drawn.at(-1)!, 'retry'), 'one failed retry still offers 다시 시도');
  assert.equal(h.action(h.drawn.at(-1)!, 'autofix'), null);

  h.action(h.drawn.at(-1)!, 'retry')!.click();
  h.controller.noteSend(shown.id, SEND);
  h.controller.add(failure(), { origin: 'turn', turnId: 't9', userInitiated: true });
  const latest = h.drawn.at(-1)!;
  assert.equal(h.action(latest, 'retry'), null, '자동 수정 takes the retry slot');
  assert.ok(h.action(latest, 'autofix'));
  assert.equal(autofix.created.at(-1)!.request().attempts, 2);

  const before = h.resent.length;
  autofix.created.at(-1)!.onFixed();
  assert.equal(h.resent.length, before + 1, 'after 고침 the failed request is sent again');
});

test('a different failure or a completed turn starts the retry count over', () => {
  const shown = thread('t');
  const autofix: FakeAutofix = { ready: true, created: [] };
  const h = sidebar(shown, autofix);
  h.controller.noteSend(shown.id, SEND);
  failRetryLoop(h, shown, 1);
  h.action(h.drawn.at(-1)!, 'retry')!.click();
  h.controller.noteSend(shown.id, SEND);
  h.controller.add(failure({ class: 'provider_error', code: 'overloaded' }), { origin: 'turn', turnId: 'x', userInitiated: true });
  assert.ok(h.action(h.drawn.at(-1)!, 'retry'), 'a new kind of failure begins with 다시 시도');

  const fresh = sidebar(thread('u'), autofix);
  fresh.controller.noteSend('u', SEND);
  failRetryLoop(fresh, thread('u'), 1);
  fresh.controller.noteSuccess();
  fresh.action(fresh.drawn.at(-1)!, 'retry')!.click();
  fresh.controller.add(failure(), { origin: 'turn', turnId: 'y', userInitiated: true });
  assert.ok(fresh.action(fresh.drawn.at(-1)!, 'retry'), 'a success in between resets the count');
});

test('without autofix (web build or turned off) repeated failures keep 다시 시도', () => {
  for (const autofix of [undefined, { ready: false, created: [] }]) {
    const shown = thread('t');
    const h = sidebar(shown, autofix);
    h.controller.noteSend(shown.id, SEND);
    failRetryLoop(h, shown, 3);
    assert.ok(h.action(h.drawn.at(-1)!, 'retry'));
    assert.equal(h.action(h.drawn.at(-1)!, 'autofix'), null);
    const unknown = h.controller.add(failure({ class: 'unknown' }), { origin: 'turn', turnId: 'u', userInitiated: true });
    assert.ok(unknown);
    assert.equal(h.action(h.drawn.at(-1)!, 'autofix'), null);
  }
});

test('unknown failures and crashed processes offer 자동 수정 right away; user-fixable ones never do', () => {
  const shown = thread('t');
  const h = sidebar(shown, { ready: true, created: [] });
  h.controller.noteSend(shown.id, SEND);
  h.controller.add(failure({ class: 'unknown' }), { origin: 'turn', turnId: 'a', userInitiated: true });
  assert.ok(h.action(h.drawn.at(-1)!, 'autofix'));
  assert.equal(h.action(h.drawn.at(-1)!, 'retry'), null);
  h.controller.add(failure({ class: 'process_exited', code: 'exit_1' }), { origin: 'turn', turnId: 'b', userInitiated: true });
  assert.ok(h.action(h.drawn.at(-1)!, 'autofix'));
  h.controller.add(failure({ class: 'process_exited', code: 'cli_missing', retryable: false }), { origin: 'start', turnId: null, userInitiated: false });
  assert.equal(h.action(h.drawn.at(-1)!, 'autofix'), null, 'a missing CLI goes to settings');
  const auth = failure({ class: 'auth_required', retryable: false, code: 'claude:authentication_failed' });
  failRetryLoop(h, shown, 0, auth);
  assert.equal(h.action(h.drawn.at(-1)!, 'autofix'), null);
});

test('a restored login failure stays a login notice until there is proof of a newer credential, not just a token on disk', async () => {
  const { authNoticeReconnected } = await import('../src/ui/agent-sidebar/failure-notice.ts');
  const failedAt = 1_700_000_000_000;
  // 새로고침 뒤: 이 창의 인증 실패 기억은 비었고, 허브는 Codex 의 auth.json 에 토큰이 있으니 authenticated 라고 한다.
  const hub = { authenticated: true, authVerifiedAt: null as number | null };
  let provenAt: number | null = null;
  const shown = thread('t');
  const stored = JSON.parse(JSON.stringify({
    role: 'system', kind: 'error', text: 'Codex 로그인이 필요해요', agent: 'codex',
    failure: failure({ class: 'auth_required', agent: 'codex', message: 'token revoked', retryable: false }),
    origin: 'turn', turnId: 't1', retry: SEND, at: failedAt,
  })) as import('../src/agent/threads.ts').ThreadFailureMessage;
  shown.messages.push(stored);
  const controller = createFailureNoticeController({
    thread: () => shown,
    persist: () => {},
    persistThread: () => {},
    append: () => {},
    agentLabel: () => 'Codex',
    isTurnRunning: () => false,
    isConnected: () => true,
    reconnected: (_agent, at) => authNoticeReconnected(at, {
      authenticated: hub.authenticated, failing: false, verifiedAt: hub.authVerifiedAt, provenAt,
    }),
    openLogin: () => {},
    openSettings: () => {},
    restartSession: () => {},
    resend: () => true,
    dismissals: createFailureDismissals(() => null),
  });
  const action = (node: FakeElement, id: string) => node.find((element) => element.dataset.action === id);
  const says = (node: FakeElement, text: string) => node.find((element) => element.textContent === text) !== null;

  let node = controller.mount(stored) as unknown as FakeElement;
  assert.ok(action(node, 'login'), 'a token on disk alone does not prove the revoked login came back');
  assert.equal(says(node, '다시 연결됐어요'), false);

  // 실패보다 오래된 확인은 증거가 아니다.
  hub.authVerifiedAt = failedAt - 1;
  provenAt = failedAt - 1;
  node = controller.mount(stored) as unknown as FakeElement;
  assert.ok(action(node, 'login'));

  // 그 뒤에 로그인이 끝났다 — 이제 다시 연결됐고 다시 시도할 수 있다.
  provenAt = failedAt + 5_000;
  node = controller.mount(stored) as unknown as FakeElement;
  assert.equal(action(node, 'login'), null);
  assert.ok(says(node, '다시 연결됐어요'));
  assert.ok(action(node, 'retry'));
});

test('auth recovery evidence: hub verification after the failure counts; unknown failure time trusts only this window', async () => {
  const { authNoticeReconnected } = await import('../src/ui/agent-sidebar/failure-notice.ts');
  assert.equal(authNoticeReconnected(1_000, { authenticated: true, failing: false, verifiedAt: 2_000 }), true);
  assert.equal(authNoticeReconnected(1_000, { authenticated: false, failing: false, verifiedAt: 2_000 }), false);
  assert.equal(authNoticeReconnected(1_000, { authenticated: true, failing: true, provenAt: 2_000 }), false,
    'a provider this window still sees failing is never reconnected');
  // 실패 시각이 없는 옛 알림(at 0)은 허브의 확인 시각과 견줄 수 없다.
  assert.equal(authNoticeReconnected(0, { authenticated: true, failing: false, verifiedAt: 5 }), false);
  assert.equal(authNoticeReconnected(0, { authenticated: true, failing: false, provenAt: 5 }), true);
});
