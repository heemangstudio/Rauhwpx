import assert from 'node:assert/strict';
import test from 'node:test';

const mem = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => { mem.set(key, value); },
    removeItem: (key: string) => { mem.delete(key); },
  },
  configurable: true,
});

const {
  clearChatStatus,
  getChatStatus,
  getChatStatusLabel,
  markChatFailed,
} = await import('../src/agent/chat-status.ts');
const { createChatAttentionLedger } = await import('../src/agent/chat-attention.ts');
const { createRunStatusController } = await import('../src/ui/agent-sidebar/run-status.ts');
type AttentionNotice = import('../src/agent/chat-attention.ts').AttentionNotice;

/** 사이드바 하나의 사실과 장부 — 각 테스트가 사실을 바꾸고 컨트롤러를 부른다. */
function sidebar(opts: { focused?: boolean } = {}) {
  mem.clear();
  const facts = {
    turnRunning: false,
    question: null as { threadId: string; interactionId: string } | null,
    plan: null as { threadId: string; planId: string } | null,
    review: false,
    seen: null as string | null,
  };
  // 제목 표시를 켠 장부 — 컨트롤러가 알림에 싣는 문구와 문서 이름까지 본다.
  const ledger = createChatAttentionLedger({
    getStatus: getChatStatus,
    windowFocused: () => opts.focused ?? false,
    showDetails: () => true,
  });
  const notices: AttentionNotice[] = [];
  ledger.subscribe({ notice: (notice) => notices.push(notice) });
  let turnSeq = 0;
  const controller = createRunStatusController({
    attention: ledger,
    turnRunning: () => facts.turnRunning,
    pendingQuestion: () => facts.question,
    awaitingPlan: () => facts.plan,
    reviewAwaiting: () => facts.review,
    seenThreadId: () => facts.seen,
    describe: (threadId) => ({ title: `채팅 ${threadId}`, documentName: '사업 제안서.hwpx' }),
    createTurnId: () => `local-${++turnSeq}`,
  });
  const run = (threadId: string, turnId: string) => {
    facts.turnRunning = true;
    controller.turnStarted(threadId, turnId);
  };
  const end = (outcome: 'completed' | 'interrupted' | 'failed', drained = false) => {
    facts.turnRunning = false;
    return controller.turnEnded(outcome, { drained });
  };
  return { facts, ledger, notices, controller, run, end };
}

/** 미뤄 둔 장부 알림이 나간다. */
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test('a turn that ends while nobody watches leaves a green dot and one notice', async () => {
  const s = sidebar();
  s.run('a', 'turn-1');
  assert.equal(getChatStatus('a'), 'working');
  s.end('completed');
  assert.equal(getChatStatus('a'), 'finished');
  await settle();
  assert.deepEqual(s.notices.map((notice) => [notice.key, notice.state, notice.body]), [
    ['turn-1:end', 'finished', '작업을 마쳤습니다 · 사업 제안서.hwpx'],
  ]);
  assert.equal(s.ledger.count(), 1);
});

test('a watched turn, a user stop, and a turn the queue continued leave nothing', async () => {
  const s = sidebar();
  s.facts.seen = 'a';
  s.run('a', 't1');
  s.end('completed');
  assert.equal(getChatStatus('a'), null, 'watched');

  s.facts.seen = null;
  s.run('b', 't2');
  s.end('interrupted');
  assert.equal(getChatStatus('b'), null, 'user stop');

  s.run('c', 't3');
  s.end('completed', true);
  assert.equal(getChatStatus('c'), null, 'the queue sent the next message — the chat is not done');
  await settle();
  assert.deepEqual(s.notices, []);
});

test('a failure reason that follows turn-end in the same flow rides the notice', async () => {
  const s = sidebar();
  s.run('a', 'turn-1');
  s.end('failed');
  // U5 의 turn-failure 는 turn-end 바로 뒤, 같은 흐름에서 온다.
  s.controller.noteTurnFailure({ label: '로그인 필요', summary: 'Claude 로그인이 필요해요' });
  assert.equal(getChatStatus('a'), 'failed');
  assert.equal(getChatStatusLabel('a'), '로그인 필요');
  await settle();
  assert.deepEqual(s.notices.map((notice) => notice.body), ['Claude 로그인이 필요해요 · 사업 제안서.hwpx']);
  // 늦게 온 이유는 레일만 고치고 다시 알리지 않는다.
  s.controller.noteTurnFailure({ label: '사용 한도' });
  await settle();
  assert.equal(getChatStatusLabel('a'), '사용 한도');
  assert.equal(s.notices.length, 1);
});

test('an outside interruption reads 중단됨 and is not an error', async () => {
  const s = sidebar();
  s.run('a', 'turn-1');
  s.end('interrupted');
  s.controller.noteTurnFailure({ interrupted: true });
  assert.equal(getChatStatus('a'), 'failed');
  assert.equal(getChatStatusLabel('a'), '중단됨');
  await settle();
  assert.deepEqual(s.notices.map((notice) => notice.body), ['작업이 중단됐습니다 · 사업 제안서.hwpx']);
});

test('a failure of a turn the user watched leaves no mark', async () => {
  const s = sidebar();
  s.facts.seen = 'a';
  s.run('a', 'turn-1');
  s.end('failed');
  s.controller.noteTurnFailure({ label: '서버 오류' });
  await settle();
  assert.equal(getChatStatus('a'), null);
  assert.deepEqual(s.notices, []);
});

test('review outranks the outcome and notifies once for the turn', async () => {
  const s = sidebar();
  s.run('a', 'turn-1');
  s.facts.review = true;
  s.controller.reviewFinalized('a');
  assert.equal(getChatStatus('a'), 'working', 'still running');
  s.end('completed');
  assert.equal(getChatStatus('a'), 'needs-review');
  await settle();
  assert.deepEqual(s.notices.map((notice) => notice.state), ['needs-review']);
  // 검토가 끝나면 보지 않은 완료로 돌아가지만 같은 턴이라 다시 알리지 않는다.
  s.facts.review = false;
  s.controller.sync();
  assert.equal(getChatStatus('a'), 'finished');
  await settle();
  assert.equal(s.notices.length, 1);
});

test('questions and plan approval wait for input; answering returns to work', async () => {
  const s = sidebar();
  s.run('a', 'turn-1');
  s.facts.question = { threadId: 'a', interactionId: 'q1' };
  s.controller.sync();
  assert.equal(getChatStatus('a'), 'needs-input');
  await settle();
  s.facts.question = null;
  s.controller.sync();
  assert.equal(getChatStatus('a'), 'working');
  await settle();
  s.facts.question = { threadId: 'a', interactionId: 'q2' };
  s.controller.sync();
  await settle();
  assert.deepEqual(s.notices.map((notice) => notice.key), ['turn-1:input:q1', 'turn-1:input:q2']);

  s.facts.question = null;
  s.facts.plan = { threadId: 'a', planId: 'plan-1' };
  s.end('completed');
  assert.equal(getChatStatus('a'), 'needs-input', 'a plan awaiting approval outranks the finish');
  await settle();
  assert.equal(s.notices.at(-1)!.key, 'turn-1:input:plan:plan-1');
  assert.equal(s.notices.at(-1)!.body, '계획 승인을 기다립니다 · 사업 제안서.hwpx');
  // 승인하면 걷힌다 — 보지 않은 계획 턴의 완료가 남는다.
  s.facts.plan = null;
  s.controller.sync();
  assert.equal(getChatStatus('a'), 'finished');
});

test('seeing a chat clears its outcome and badge but not what it still waits for', async () => {
  const s = sidebar();
  s.run('a', 't1');
  s.end('completed');
  s.run('b', 't2');
  s.facts.review = true;
  s.controller.reviewFinalized('b');
  s.end('failed');
  await settle();
  assert.equal(s.ledger.count(), 2);
  s.facts.seen = 'a';
  s.controller.markSeen();
  assert.equal(getChatStatus('a'), null);
  s.facts.seen = 'b';
  s.controller.markSeen();
  assert.equal(getChatStatus('b'), 'needs-review', 'review waits for an answer');
  assert.equal(s.ledger.count(), 0);
  // 검토가 끝나도 이미 본 실패는 되살아나지 않는다.
  s.facts.review = false;
  s.controller.sync();
  assert.equal(getChatStatus('b'), null);
});

test('an outcome cleared in another window is not written back', async () => {
  const s = sidebar();
  s.run('a', 't1');
  s.end('completed');
  clearChatStatus('a'); // 다른 창이 열어 봤다
  s.controller.storeChanged();
  s.controller.sync();
  assert.equal(getChatStatus('a'), null);
});

test('states written elsewhere survive, and closing keeps outcomes and pending notices', async () => {
  const s = sidebar();
  // S3 가 시작할 때 남긴 중단 — 이 사이드바가 다른 채팅을 다뤄도 지우지 않는다.
  markChatFailed('stored', { label: '중단됨' });
  s.run('a', 't1');
  s.end('completed');
  s.run('b', 't2');
  s.facts.question = { threadId: 'b', interactionId: 'q' };
  s.controller.sync();
  assert.equal(getChatStatus('stored'), 'failed');
  // 바쁜 채로 닫힌다(문서를 닫음): 살아 있는 점은 걷히고 결과는 남는다. 미뤄 둔 알림은 나가지만,
  // 함께 사라진 질문은 답할 수 없으니 알리지 않는다.
  s.controller.dispose();
  assert.equal(getChatStatus('b'), null);
  assert.equal(getChatStatus('a'), 'finished');
  assert.equal(getChatStatus('stored'), 'failed');
  await settle();
  assert.deepEqual(s.notices.map((notice) => notice.threadId), ['a']);
});

test('turnEnded tells whether it closed a running turn', () => {
  const s = sidebar();
  assert.equal(s.end('failed'), false, 'no turn ran');
  s.run('a', 't1');
  assert.equal(s.end('failed'), true);
});

test('a provider failure reads as a short rail reason', async () => {
  const { failureRailLabel } = await import('../src/ui/agent-sidebar/failure-notice.ts');
  const failure = (cls: string, code: string | null = null, agent = 'claude') => ({
    class: cls, agent, message: 'x', code, retryable: false, resetAt: null,
  }) as Parameters<typeof failureRailLabel>[0];
  assert.deepEqual([
    failureRailLabel(failure('auth_required')),
    failureRailLabel(failure('auth_required', 'PI_NOT_CONFIGURED', 'pi')),
    failureRailLabel(failure('usage_limit')),
    failureRailLabel(failure('usage_limit', 'openrouter_credits', 'pi')),
    failureRailLabel(failure('provider_error')),
    failureRailLabel(failure('network')),
    failureRailLabel(failure('process_exited')),
    failureRailLabel(failure('process_exited', 'cli_missing')),
    failureRailLabel(failure('invalid_request', 'context_window')),
    failureRailLabel(failure('unknown')),
  ], ['로그인 필요', '설정 필요', '사용 한도', '크레딧 부족', '서버 오류', '연결 실패', '실행 중단', 'CLI 없음', '대화 길이 초과', '오류']);
});

test('a failed turn whose end sent the next queued message leaves no failure while the chat keeps working', async () => {
  const s = sidebar();
  s.run('bg', 'turn-1');
  // 지금 보내기로 걸어 둔 대기 메시지가 실패한 턴 끝에서 나갔다 — 채팅은 그 메시지로 이어진다.
  s.end('failed', true);
  s.controller.noteTurnFailure({ label: '사용 한도', summary: 'Claude 사용 한도에 도달했어요' });
  await settle();
  assert.equal(getChatStatus('bg'), null, 'the rail does not show a failure for a chat that moved on');
  assert.equal(s.notices.length, 0, 'no failure notification');
  s.run('bg', 'turn-2');
  assert.equal(getChatStatus('bg'), 'working');
});

test('a queued message the hub rejects after a drained turn end leaves the hidden chat failed with its reason', async () => {
  const s = sidebar();
  s.run('bg', 'turn-1');
  s.end('completed', true);
  await settle();
  assert.equal(getChatStatus('bg'), null);
  // 그 대기 메시지를 허브가 받지 않았다(로그인 필요) — 대기열이 붙잡힌 채 채팅이 멈췄다.
  assert.equal(s.controller.turnEnded('failed', { drained: false }), false, 'no turn is running any more');
  s.controller.followUpRejected({ label: '로그인 필요', summary: 'Claude 로그인이 필요해요' });
  await settle();
  assert.equal(getChatStatus('bg'), 'failed');
  assert.equal(getChatStatusLabel('bg'), '로그인 필요');
  assert.deepEqual(s.notices.map((notice) => [notice.key, notice.state]), [['turn-1:end', 'failed']]);

  // 그 사이 새 턴이 열렸으면(허브가 바빠 거절) 아무것도 남기지 않는다.
  const busy = sidebar();
  busy.run('bg2', 'turn-1');
  busy.end('completed', true);
  busy.run('bg2', 'turn-2');
  busy.controller.followUpRejected({ label: '로그인 필요' });
  await settle();
  assert.equal(getChatStatus('bg2'), 'working');
  assert.equal(busy.notices.length, 0);
});
