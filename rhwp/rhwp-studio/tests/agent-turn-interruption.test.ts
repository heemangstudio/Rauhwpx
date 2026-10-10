// 끊긴 턴(S3) — 허브·앱 재시작, 새로고침, 사라진 세션, 엔진 멈춤으로 끝을 듣지 못한 턴을 가려 이유와
// 함께 정착하고, 이어서 진행할 때 에이전트에게 그 사실을 알린다.
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
  createEmptyThread,
  createPendingUserQuestionDraftSnapshot,
  createTurnMarker,
  getThread,
  latestTurnMarker,
  settleTurnMarker,
  upsertThread,
} = await import('../src/agent/threads.ts');
const {
  INTERRUPTION_LABEL,
  appendContinuationBlock,
  continuationBlock,
  continuationWire,
  currentTurnOwner,
  interruptLatestTurn,
  interruptTurn,
  isInterruptionTurnEnd,
  lostSessionReason,
  markThreadInterrupted,
  reasonFor,
  reconcileInterruptedTurns,
  reconcileThreadOnOpen,
  reviveInterruptedTurn,
  segmentHasExpiredQuestion,
  unresolvedInterruption,
} = await import('../src/agent/turn-interruption.ts');
type ChatThread = import('../src/agent/threads.ts').ChatThread;
type ThreadTurnMessage = import('../src/agent/threads.ts').ThreadTurnMessage;
type TurnOwner = import('../src/agent/threads.ts').TurnOwner;
type UserQuestionInteraction = import('../src/agent/types.ts').UserQuestionInteraction;

const NOW: TurnOwner = { window: 'window-a', app: null, hub: 'hub-2' };

function marker(id: string, startedAt: number, owner?: Partial<TurnOwner>, hubTurnId: string | null = null): ThreadTurnMessage {
  const created = createTurnMarker(startedAt, id);
  if (owner) created.owner = { window: null, app: null, hub: null, ...owner };
  created.hubTurnId = hubTurnId;
  return created;
}

function chat(id: string, ...messages: ChatThread['messages']): ChatThread {
  const thread = createEmptyThread({ agent: 'claude', model: 'default', effort: 'medium', documentId: 'doc', docKey: 'a.hwp' });
  thread.id = id;
  thread.messages.push({ role: 'user', text: '표를 정리해 주세요' }, ...messages);
  thread.updatedAt = 50_000;
  thread.lastActivityAt = 50_000;
  return thread;
}

function question(threadId: string, turnId: string): UserQuestionInteraction {
  return {
    interactionId: `${threadId}-q`,
    providerRequestId: 'request',
    threadId,
    turnId,
    agent: 'claude',
    source: 'native',
    createdAt: '2026-10-10T00:00:00.000Z',
    updatedAt: '2026-10-10T00:00:00.000Z',
    questions: [{
      id: 'range', header: '범위', question: '어느 범위를 나눌까요?', mode: 'single', allowOther: false,
      options: [{ id: 'all', label: '전체', description: '전체 일정' }],
    }],
  };
}

const decided = (decisions: Array<{ threadId: string; markerId: string; reason: string }>) =>
  decisions.map((decision) => `${decision.threadId}/${decision.markerId}:${decision.reason}`);

test('reasons: a different desktop app run is an app restart, a different hub process a hub restart, else a reload', () => {
  assert.equal(reasonFor({ window: 'w', app: 'run-1', hub: 'hub-1' }, { window: 'w', app: 'run-2', hub: 'hub-1' }), 'app-restart');
  // 앱 실행 id 는 데스크톱만 안다 — 웹에서는 허브 프로세스로 가른다.
  assert.equal(reasonFor({ window: 'w', app: null, hub: 'hub-1' }, { window: 'w', app: null, hub: 'hub-2' }), 'hub-restart');
  assert.equal(reasonFor({ window: 'w', app: 'run-1', hub: 'hub-1' }, { window: 'w', app: 'run-1', hub: 'hub-1' }), 'reload');
  assert.equal(reasonFor({ window: 'w', app: null, hub: null }, NOW), 'reload', 'unknown ids read as a reload');
  assert.equal(reasonFor(undefined, NOW), 'reload');
  assert.deepEqual(currentTurnOwner({ windowSessionId: 'w', appLaunchId: null }, 'hub-9'), { window: 'w', app: null, hub: 'hub-9' });
  assert.deepEqual(currentTurnOwner(null, null), { window: null, app: null, hub: null });
});

test('a lost session on the same hub process is an agent exit; a new or unknown process is a hub restart', () => {
  assert.equal(lostSessionReason('hub-1', 'hub-1'), 'agent-exit');
  assert.equal(lostSessionReason('hub-1', 'hub-2'), 'hub-restart');
  assert.equal(lostSessionReason(null, 'hub-2'), 'hub-restart');
  assert.equal(lostSessionReason('hub-1', null), 'hub-restart', 'an older hub without the id reads as a restart');
});

test('startup: the adopted chat keeps its running turn, older open turns and this window’s other turns are cut off', () => {
  const adopted = chat('adopted',
    marker('old', 1_000, { window: 'window-a', hub: 'hub-2' }),
    { role: 'user', text: '다시' },
    marker('live', 5_000, { window: 'window-a', hub: 'hub-2' }, 'turn-7'));
  const background = chat('background', marker('bg', 2_000, { window: 'window-a', hub: 'hub-2' }));
  const otherWindow = chat('other-window', marker('foreign', 3_000, { window: 'window-b', hub: 'hub-2' }));
  const olderHub = chat('older-hub', marker('old-hub', 3_000, { window: 'window-b', hub: 'hub-1' }));
  const olderApp = chat('older-app', marker('old-app', 3_000, { window: 'window-b', app: 'run-1', hub: 'hub-2' }));
  const noOwner = chat('no-owner', marker('legacy', 3_000));
  const decisions = reconcileInterruptedTurns(
    [adopted, background, otherWindow, olderHub, olderApp, noOwner],
    { now: { window: 'window-a', app: 'run-2', hub: 'hub-2' }, live: { threadId: 'adopted', turnId: 'turn-7' } },
  );
  assert.deepEqual(decided(decisions).sort(), [
    'adopted/old:reload',
    'background/bg:reload',
    'older-app/old-app:app-restart',
    'older-hub/old-hub:hub-restart',
  ]);
});

test('startup: a live chat on a different hub turn, or with no busy session, is cut off too', () => {
  const thread = chat('t', marker('m', 1_000, { window: 'window-a', hub: 'hub-1' }, 'turn-1'));
  assert.deepEqual(decided(reconcileInterruptedTurns([thread], { now: NOW, live: { threadId: 't', turnId: 'turn-2' } })),
    ['t/m:hub-restart']);
  assert.deepEqual(decided(reconcileInterruptedTurns([thread], { now: NOW, live: null })), ['t/m:hub-restart']);
  // 허브 턴 id 를 모르면 같은 턴으로 본다.
  assert.deepEqual(reconcileInterruptedTurns([thread], { now: NOW, live: { threadId: 't', turnId: null } }), []);
});

test('on open: a working or waiting chat keeps its turn; otherwise the open turn is cut off', () => {
  const thread = chat('t', marker('m', 1_000, { window: 'window-b', hub: 'hub-2' }));
  const open = (status: string | null, live: { threadId: string; turnId: string | null } | null = null) =>
    decided(reconcileThreadOnOpen(thread, { now: NOW, live, status }));
  assert.deepEqual(open('working'), []);
  assert.deepEqual(open('needs-input'), []);
  assert.deepEqual(open(null, { threadId: 't', turnId: null }), [], 'this bridge holds the turn');
  assert.deepEqual(open(null), ['t/m:reload']);
  assert.deepEqual(open('finished'), ['t/m:reload']);
  // 마지막이 아닌 열린 표식은 언제나 끊겼다.
  const twice = chat('t2', marker('a', 1_000), { role: 'user', text: '또' }, marker('b', 2_000));
  assert.deepEqual(decided(reconcileThreadOnOpen(twice, { now: NOW, live: null, status: 'working' })), ['t2/a:reload']);
});

test('settling: interrupted with the reason, ended at the last activity, the question archived in the turn, the queue held', () => {
  const m = marker('m', 10_000, { window: 'window-a', hub: 'hub-1' }, 'turn-1');
  const thread = chat('t', m, {
    role: 'assistant', kind: 'activity', activityId: 'act', text: '도구 호출', status: 'completed',
    startedAt: 11_000, completedAt: 20_000, tools: [],
  });
  thread.lastActivityAt = 30_000;
  thread.pendingUserQuestion = createPendingUserQuestionDraftSnapshot(question('t', 'turn-1'));
  thread.followUps = { items: [{ id: 'f1', text: '그다음', createdAt: 1 }] };
  const result = interruptTurn(thread, m, 'hub-restart', 9_999_999, { foldText: () => '중단됨 · 20초' });
  assert.equal(m.outcome, 'interrupted');
  assert.equal(m.endedAt, 30_000, 'downtime after the last save is not counted');
  assert.deepEqual(m.interruption, { reason: 'hub-restart', at: 9_999_999 });
  assert.equal(m.text, '중단됨 · 20초');
  assert.ok(result.questionExpired);
  assert.equal(thread.pendingUserQuestion, undefined);
  const card = thread.messages.at(-1);
  assert.equal(card?.kind, 'user-question');
  assert.ok(segmentHasExpiredQuestion(thread.messages, 'm'), 'the expired card sits in the cut-off turn');
  assert.deepEqual(thread.followUps?.hold && { reason: thread.followUps.hold.reason, detail: thread.followUps.hold.detail },
    { reason: 'interrupted', detail: INTERRUPTION_LABEL['hub-restart'] });
  // 끝 시각은 시작보다 앞서지도, 지금보다 늦지도 않다.
  const early = marker('e', 80_000);
  const fresh = chat('t2', early);
  fresh.lastActivityAt = 1_000;
  interruptTurn(fresh, early, 'reload', 90_000);
  assert.equal(early.endedAt, 80_000);
  assert.equal(early.text, '중단됨');
});

test('revive: the same live hub turn restores the open marker, another turn does not', () => {
  const m = marker('m', 1_000, { window: 'window-a' }, 'turn-1');
  const thread = chat('t', m);
  interruptTurn(thread, m, 'reload', 5_000);
  assert.equal(reviveInterruptedTurn(thread, 'turn-2'), null);
  assert.equal(m.outcome, 'interrupted');
  assert.equal(reviveInterruptedTurn(thread, 'turn-1'), m);
  assert.equal(m.endedAt, null);
  assert.equal(m.outcome, null);
  assert.equal(m.interruption, undefined);
  // 이미 이어 간 끊김은 되돌리지 않는다.
  interruptTurn(thread, m, 'reload', 6_000);
  m.interruption!.resolution = 'resumed';
  assert.equal(reviveInterruptedTurn(thread, 'turn-1'), null);
});

test('revive: a turn the engine trap cut off stays cut off while the hub still runs it', () => {
  const m = marker('m', 1_000, { window: 'window-a' }, 'turn-1');
  const thread = chat('t', m);
  interruptTurn(thread, m, 'engine-trap', 5_000);
  assert.equal(reviveInterruptedTurn(thread, 'turn-1'), null);
  assert.equal(m.outcome, 'interrupted');
  assert.equal(m.interruption?.reason, 'engine-trap');
});

test('continuation block names the reason, the staged edits and an expired question only when it applies', () => {
  const staged = continuationBlock('hub-restart', { stagedAwaitingReview: true, questionExpired: false });
  assert.ok(staged.startsWith('<turn_interrupted reason="hub-restart">'));
  assert.ok(staged.endsWith('</turn_interrupted>'));
  assert.match(staged, /agent hub restarted/);
  assert.match(staged, /still shown to the user as a preview/);
  assert.doesNotMatch(staged, /question to the user expired/);
  assert.match(staged, /Re-read the parts of the document/);
  const lost = continuationBlock('reload', { stagedAwaitingReview: false, questionExpired: true });
  assert.match(lost, /may no longer be in the document/);
  assert.match(lost, /question to the user expired unanswered/);
  assert.match(lost, /editor page was reloaded/);
  // 복원 안내(U6)가 앞에 붙어도 블록은 끝에 남는다.
  const decorated = appendContinuationBlock('[문서 상태] 되돌림\n\n표를 정리해 주세요', 'engine-trap', { stagedAwaitingReview: false, questionExpired: false });
  assert.ok(decorated.startsWith('[문서 상태]'));
  assert.ok(decorated.endsWith('</turn_interrupted>'));
  assert.deepEqual(continuationWire('agent-exit', { stagedAwaitingReview: false, questionExpired: false }).displayText, '이어서 진행해 주세요.');
  assert.equal(isInterruptionTurnEnd({ type: 'turn-end', interruption: 'hub-restart' }), true);
  assert.equal(isInterruptionTurnEnd({ type: 'turn-end' }), false);
});

test('only the first message after an interruption carries the block; the origin decides the resolution', () => {
  const m = marker('m', 1_000);
  const thread = chat('t', m);
  interruptTurn(thread, m, 'hub-restart', 5_000);
  // 사이드바의 보내기 길: 걸려 있으면 블록을 붙이고, 나간 뒤 resolution 을 남긴다.
  const send = (text: string, origin: 'composer' | 'resume') => {
    const pending = unresolvedInterruption(thread);
    const request = pending ? appendContinuationBlock(text, pending.reason, { stagedAwaitingReview: false, questionExpired: false }) : text;
    if (pending) pending.marker.interruption!.resolution = origin === 'resume' ? 'resumed' : 'superseded';
    thread.messages.push({ role: 'user', text });
    return request;
  };
  const first = send('표 머리글도 고쳐 주세요', 'composer');
  assert.match(first, /<turn_interrupted reason="hub-restart">/);
  assert.equal(m.interruption?.resolution, 'superseded');
  assert.equal(send('그리고 저장', 'composer'), '그리고 저장');
  const n = marker('n', 6_000);
  thread.messages.push(n);
  interruptTurn(thread, n, 'reload', 7_000);
  send('이어서 진행해 주세요.', 'resume');
  assert.equal(n.interruption?.resolution, 'resumed');
});

test('engine trap: the latest turn is cut off, a user-stopped or reload settle takes the more specific reason', () => {
  mem.clear();
  const running = chat('trap-running', marker('r', 1_000, { window: 'window-a' }));
  running.followUps = { items: [{ id: 'f', text: '다음', createdAt: 1 }] };
  upsertThread(running);
  assert.ok(markThreadInterrupted('trap-running', 'engine-trap', { now: 60_000 }));
  const stored = latestTurnMarker(getThread('trap-running')!.messages)!;
  assert.equal(stored.outcome, 'interrupted');
  assert.deepEqual(stored.interruption, { reason: 'engine-trap', at: 60_000 });
  assert.equal(getThread('trap-running')!.followUps?.hold?.detail, '문서 엔진 멈춤');

  // 트랩 페이지가 멈춘 턴(사용자 중지로 정착), 또는 부팅 정리가 '새로고침'으로 정착한 턴.
  const stopped = chat('trap-stopped', marker('s', 1_000));
  settleTurnMarker(latestTurnMarker(stopped.messages)!, { endedAt: 3_000, outcome: 'interrupted' });
  upsertThread(stopped);
  assert.ok(markThreadInterrupted('trap-stopped', 'engine-trap', { now: 70_000 }));
  assert.equal(latestTurnMarker(getThread('trap-stopped')!.messages)!.interruption?.reason, 'engine-trap');
  assert.equal(latestTurnMarker(getThread('trap-stopped')!.messages)!.endedAt, 3_000, 'the settled end stays');

  // 끝까지 간 턴과 이미 이어 간 끊김은 그대로다.
  const done = chat('trap-done', marker('d', 1_000));
  settleTurnMarker(latestTurnMarker(done.messages)!, { endedAt: 3_000, outcome: 'completed' });
  upsertThread(done);
  assert.equal(markThreadInterrupted('trap-done', 'engine-trap'), false);
  assert.equal(markThreadInterrupted('missing', 'engine-trap'), false);

  // 표식 없이 남은 옛 턴: 마지막 요청 바로 뒤에 끊긴 표식을 만든다.
  const legacy = chat('trap-legacy', { role: 'assistant', text: '표를 읽는 중입니다' });
  upsertThread(legacy);
  assert.ok(markThreadInterrupted('trap-legacy', 'engine-trap', { now: 80_000 }));
  const messages = getThread('trap-legacy')!.messages;
  assert.deepEqual(messages.map((message) => message.kind ?? message.role), ['user', 'turn', 'assistant']);
  assert.equal(latestTurnMarker(messages)!.interruption?.reason, 'engine-trap');
});

test('interruptLatestTurn leaves a resolved interruption alone', () => {
  const m = marker('m', 1_000);
  const thread = chat('t', m);
  interruptTurn(thread, m, 'reload', 2_000);
  m.interruption!.resolution = 'superseded';
  assert.equal(interruptLatestTurn(thread, 'engine-trap', 3_000), null);
  assert.equal(m.interruption?.reason, 'reload');
});

test('continuing a plan implementation whose approval was lost asks for a plan of the remaining steps', () => {
  const replan = continuationBlock('hub-restart', { stagedAwaitingReview: false, questionExpired: false, replanning: true });
  assert.match(replan, /approval did not survive the interruption/);
  assert.match(replan, /present a plan for the remaining steps for the user to approve/);
  assert.doesNotMatch(replan, /continue the user's last request from where you stopped/,
    'it does not tell a planning session to carry on editing');
  const same = continuationBlock('hub-restart', { stagedAwaitingReview: false, questionExpired: false });
  assert.doesNotMatch(same, /approval did not survive/);
  assert.match(same, /continue the user's last request from where you stopped/);
});
