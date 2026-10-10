import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAT_STATUS_LABEL_MAX,
  clearChatStatus,
  deriveChatRunStatus,
  getChatStatus,
  getChatStatusLabel,
  getChatWorkingSince,
  markChatFailed,
  markChatFinished,
  markChatNeedsInput,
  markChatNeedsReview,
  markChatWorking,
  readChatStatuses,
  releaseOwnedLiveStatuses,
  subscribeChatStatus,
} from '../src/agent/chat-status.ts';

const STORAGE_KEY = 'rhwp-agent-chat-status';
const mem = new Map<string, string>();
const storage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => {
    mem.set(k, v);
  },
  removeItem: (k: string) => {
    mem.delete(k);
  },
};

Object.defineProperty(globalThis, 'localStorage', {
  value: storage,
  configurable: true,
});

test('working and finished signals round-trip through shared storage', () => {
  mem.clear();
  markChatWorking('t-1');
  assert.equal(getChatStatus('t-1'), 'working');
  markChatNeedsInput('t-1');
  assert.equal(getChatStatus('t-1'), 'needs-input');
  markChatFinished('t-1');
  assert.equal(getChatStatus('t-1'), 'finished');
  clearChatStatus('t-1');
  assert.equal(getChatStatus('t-1'), null);
});

test('subscribers hear material changes only, not heartbeat rewrites', () => {
  mem.clear();
  let changes = 0;
  const unsubscribe = subscribeChatStatus(() => {
    changes += 1;
  });
  markChatWorking('t-2');
  assert.equal(changes, 1);
  // 같은 상태를 다시 쓰는 건 심장박동과 같다 — 알림이 없어야 한다.
  markChatWorking('t-2');
  assert.equal(changes, 1);
  markChatFinished('t-2');
  assert.equal(changes, 2);
  unsubscribe();
  clearChatStatus('t-2');
  assert.equal(changes, 2);
});

test('a working signal without heartbeats goes dark instead of sticking', () => {
  mem.clear();
  mem.set(STORAGE_KEY, JSON.stringify({
    stale: { status: 'working', updatedAt: Date.now() - 60_000 },
    alive: { status: 'working', updatedAt: Date.now() },
  }));
  assert.equal(getChatStatus('stale'), null);
  assert.equal(getChatStatus('alive'), 'working');
});

test('finished and needs-input dots are tidied away after their TTL', () => {
  mem.clear();
  mem.set(STORAGE_KEY, JSON.stringify({
    old: { status: 'finished', updatedAt: Date.now() - 7 * 60 * 60 * 1000 },
    recent: { status: 'finished', updatedAt: Date.now() },
    'old-plan': { status: 'needs-input', updatedAt: Date.now() - 7 * 60 * 60 * 1000 },
    'recent-plan': { status: 'needs-input', updatedAt: Date.now() },
  }));
  assert.equal(getChatStatus('old'), null);
  assert.equal(getChatStatus('recent'), 'finished');
  assert.equal(getChatStatus('old-plan'), null);
  assert.equal(getChatStatus('recent-plan'), 'needs-input');
});

test('review and failed states round-trip, and a failure keeps its short reason', () => {
  mem.clear();
  markChatNeedsReview('t-review');
  assert.equal(getChatStatus('t-review'), 'needs-review');
  markChatFailed('t-failed', { label: '로그인 필요' });
  assert.equal(getChatStatus('t-failed'), 'failed');
  assert.equal(getChatStatusLabel('t-failed'), '로그인 필요');
  markChatFailed('t-plain');
  assert.equal(getChatStatusLabel('t-plain'), null, 'no reason reads as 오류 in the rail');
  // 긴 이유는 잘리고 말줄임표로 끝난다 — 레일 한 줄을 넘지 않는다.
  markChatFailed('t-long', { label: '가'.repeat(80) });
  const label = getChatStatusLabel('t-long')!;
  assert.equal([...label].length, CHAT_STATUS_LABEL_MAX);
  assert(label.endsWith('…'));
  assert.deepEqual(readChatStatuses().get('t-failed'), { status: 'failed', label: '로그인 필요' });
  // 다른 상태에는 이유가 붙지 않는다.
  markChatFinished('t-failed');
  assert.equal(getChatStatusLabel('t-failed'), null);
});

test('a changed failure reason is a material change subscribers hear', () => {
  mem.clear();
  let changes = 0;
  const unsubscribe = subscribeChatStatus(() => { changes += 1; });
  markChatFailed('t-reason');
  markChatFailed('t-reason');
  assert.equal(changes, 1);
  markChatFailed('t-reason', { label: '사용 한도' });
  assert.equal(changes, 2);
  unsubscribe();
});

test('closing a page releases only the live states it wrote', () => {
  mem.clear();
  markChatWorking('mine-working');
  markChatNeedsInput('mine-input');
  markChatNeedsReview('mine-review');
  markChatFinished('mine-finished');
  markChatFailed('mine-failed', { label: '중단됨' });
  // 다른 페이지가 쓴 상태 — 이 페이지는 손대지 않는다.
  const stored = JSON.parse(mem.get(STORAGE_KEY)!);
  stored['other-working'] = { status: 'working', updatedAt: Date.now(), startedAt: Date.now() };
  stored['other-review'] = { status: 'needs-review', updatedAt: Date.now() };
  mem.set(STORAGE_KEY, JSON.stringify(stored));

  releaseOwnedLiveStatuses(['mine-review', 'other-review']);
  assert.equal(getChatStatus('mine-review'), null);
  assert.equal(getChatStatus('other-review'), 'needs-review');
  assert.equal(getChatStatus('mine-working'), 'working', 'only the named threads');

  releaseOwnedLiveStatuses();
  assert.equal(getChatStatus('mine-working'), null);
  assert.equal(getChatStatus('mine-input'), null);
  assert.equal(getChatStatus('mine-finished'), 'finished', 'unread outcomes survive a closed page');
  assert.equal(getChatStatus('mine-failed'), 'failed');
  assert.equal(getChatStatus('other-working'), 'working');
  assert.equal(getChatStatus('other-review'), 'needs-review');
});

test('blocking states do not go stale like a working light', () => {
  mem.clear();
  const minuteAgo = Date.now() - 60_000;
  mem.set(STORAGE_KEY, JSON.stringify({
    review: { status: 'needs-review', updatedAt: minuteAgo },
    input: { status: 'needs-input', updatedAt: minuteAgo },
    working: { status: 'working', updatedAt: minuteAgo, startedAt: minuteAgo },
  }));
  assert.equal(getChatStatus('review'), 'needs-review');
  assert.equal(getChatStatus('input'), 'needs-input');
  assert.equal(getChatStatus('working'), null);
});

test('a working light keeps its start time across rewrites', () => {
  mem.clear();
  const started = Date.now() - 5_000;
  mem.set(STORAGE_KEY, JSON.stringify({ t: { status: 'working', updatedAt: Date.now(), startedAt: started } }));
  markChatWorking('t');
  assert.equal(getChatWorkingSince('t'), started);
  markChatNeedsInput('t');
  markChatWorking('t');
  assert.notEqual(getChatWorkingSince('t'), started, 'a new working spell starts again');
});

test('one state per chat: input over working over review over an unread outcome', () => {
  const cases: Array<[Parameters<typeof deriveChatRunStatus>[0], ReturnType<typeof deriveChatRunStatus>]> = [
    [{ needsInput: true, working: true, reviewPending: true, unreadOutcome: 'finished' }, 'needs-input'],
    [{ needsInput: false, working: true, reviewPending: true, unreadOutcome: 'failed' }, 'working'],
    [{ needsInput: false, working: false, reviewPending: true, unreadOutcome: 'failed' }, 'needs-review'],
    [{ needsInput: false, working: false, reviewPending: false, unreadOutcome: 'failed' }, 'failed'],
    [{ needsInput: false, working: false, reviewPending: false, unreadOutcome: 'finished' }, 'finished'],
    [{ needsInput: false, working: false, reviewPending: false, unreadOutcome: null }, null],
  ];
  for (const [input, expected] of cases) assert.equal(deriveChatRunStatus(input), expected, JSON.stringify(input));
});

test('statuses written by an older build are still read, unknown ones are dropped', () => {
  mem.clear();
  mem.set(STORAGE_KEY, JSON.stringify({
    old: { status: 'finished', updatedAt: Date.now() },
    future: { status: 'archived', updatedAt: Date.now() },
  }));
  assert.equal(getChatStatus('old'), 'finished');
  assert.equal(getChatStatus('future'), null);
  clearChatStatus('old');
  assert.equal(getChatStatus('old'), null);
});
