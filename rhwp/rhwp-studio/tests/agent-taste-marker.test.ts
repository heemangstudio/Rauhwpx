import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addStoredTasteHistoryMarker,
  addTasteMarker,
  createEmptyThread,
  createTurnMarker,
  findTasteMarker,
  getThread,
  serializeThreadMessagesForProviderHistory,
  listThreads,
  settleTasteUndo,
  tasteHistoryThreadId,
  upsertThread,
  type ChatThread,
  type ThreadTasteMarker,
} from '../src/agent/threads.ts';
import { readTasteLearned, tasteItemChange } from '../src/agent/taste.ts';
import type { TasteLearned } from '../src/agent/types.ts';

const mem = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
  },
  configurable: true,
});

function learned(overrides: Partial<TasteLearned> = {}): TasteLearned {
  return {
    threadId: 'thread-1',
    turnId: 'hub-turn-1',
    documentId: 'doc-1',
    key: 'dm_abc',
    learnId: 'learn_1',
    items: [
      { op: 'add', entryId: 'mem_a', text: '본문은 한다체 사용', origin: 'learned' },
      { op: 'update', entryId: 'mem_b', text: "'이용자'로 통일", prevText: "'사용자'로 통일", origin: 'learned' },
      { op: 'remove', entryId: 'mem_c', text: '예산표는 월별', origin: 'explicit' },
    ],
    // 저장소의 변경 목록 — Studio 는 읽지 않고 그대로 되돌려 보낸다.
    changes: [
      { op: 'add', entryId: 'mem_a', entry: { id: 'mem_a', updatedAt: '2026-10-22T00:00:00.000Z' } },
      { op: 'update', entryId: 'mem_b', entry: { id: 'mem_b' }, prev: { id: 'mem_b', text: "'사용자'로 통일" } },
      { op: 'remove', entryId: 'mem_c', prev: { id: 'mem_c', text: '예산표는 월별' } },
    ],
    ...overrides,
  };
}

/** 요청 → 턴(허브 턴 id) → 작업 → 답, 그다음 요청과 답이 이미 와 있는 채팅. */
function threadWithTwoTurns(): ChatThread {
  const thread = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high' });
  thread.id = 'thread-1';
  const first = createTurnMarker(1_000, 'turn-local-1');
  first.hubTurnId = 'hub-turn-1';
  const second = createTurnMarker(5_000, 'turn-local-2');
  second.hubTurnId = 'hub-turn-2';
  thread.messages.push(
    { role: 'user', text: '추진 배경을 한다체로 바꿔 줘', agent: 'claude' },
    first,
    { role: 'assistant', kind: 'progress', text: '문단을 고칩니다.', agent: 'claude' },
    { role: 'assistant', text: '바꿨습니다.', agent: 'claude' },
    { role: 'user', text: '표도 정리해 줘', agent: 'claude' },
    second,
    { role: 'assistant', text: '정리했습니다.', agent: 'claude' },
  );
  return thread;
}

function tasteMarkers(thread: ChatThread): ThreadTasteMarker[] {
  return thread.messages.filter((message): message is ThreadTasteMarker =>
    message.kind === 'marker' && message.marker === 'taste');
}

test('a late learn lands right after its own turn, not after later messages', () => {
  const thread = threadWithTwoTurns();
  const marker = addTasteMarker(thread, learned());
  assert.ok(marker);
  assert.deepEqual(thread.messages.map((message) => message.kind === 'marker' ? 'taste' : message.text), [
    '추진 배경을 한다체로 바꿔 줘', '', '문단을 고칩니다.', '바꿨습니다.', 'taste', '표도 정리해 줘', '', '정리했습니다.',
  ]);
  // 턴을 모르는 학습(신호로 돈 학습)은 끝에 놓는다.
  addTasteMarker(thread, learned({ learnId: 'learn_signal', turnId: null }));
  assert.equal(thread.messages.at(-1)?.kind === 'marker' && thread.messages.at(-1)?.marker, 'taste');
});

test('the same learn is kept once and a second learn of the same turn joins its divider', () => {
  const thread = threadWithTwoTurns();
  addTasteMarker(thread, learned());
  assert.equal(addTasteMarker(thread, learned()), null, 'a re-sent frame adds nothing');
  const merged = addTasteMarker(thread, learned({
    learnId: 'learn_2',
    items: [{ op: 'add', entryId: 'mem_d', text: '표 제목은 굵게', origin: 'learned' }],
    changes: [{ op: 'add', entryId: 'mem_d' }],
  }));
  assert.ok(merged);
  const markers = tasteMarkers(thread);
  assert.equal(markers.length, 1);
  assert.deepEqual(markers[0]!.items.map((item) => item.entryId), ['mem_a', 'mem_b', 'mem_c', 'mem_d']);
  assert.equal(markers[0]!.changes.length, 4);
  assert.equal(addTasteMarker(thread, learned({ learnId: 'learn_2' })), null, 'the merged learn is known too');
  assert.equal(findTasteMarker(thread.messages, 'learn_2'), markers[0]);
});

test('undo state and the opaque changes survive persistence, so undo still works after a reload', () => {
  mem.clear();
  const thread = threadWithTwoTurns();
  const marker = addTasteMarker(thread, learned())!;
  assert.ok(settleTasteUndo(marker, { reverted: ['mem_a'], skipped: ['mem_b', 'mem_unknown'] }));
  assert.equal(settleTasteUndo(marker, { reverted: ['mem_a'], skipped: [] }), false, 'nothing new to record');
  upsertThread(thread);
  const restored = findTasteMarker(getThread('thread-1')!.messages, 'learn_1')!;
  assert.deepEqual(restored.undone, ['mem_a']);
  assert.deepEqual(restored.stale, ['mem_b']);
  assert.deepEqual(restored.changes, learned().changes);
  assert.deepEqual(restored.items, learned().items);
  assert.equal(restored.turnId, 'hub-turn-1');
});

test('malformed stored taste dividers and items are dropped on load', () => {
  mem.clear();
  const valid = learned();
  localStorage.setItem('rhwp-agent-threads', JSON.stringify([{
    id: 'stored-taste', title: 't', titleRequested: true, createdAt: 1, updatedAt: 2,
    agent: 'claude', model: 'sonnet', effort: 'high',
    messages: [
      { role: 'user', text: 'hi', agent: 'claude' },
      {
        role: 'system', kind: 'marker', marker: 'taste', text: '', learnId: 'learn_ok', documentId: 'doc-1', key: 'dm_abc',
        items: [...valid.items, { op: 'rename', entryId: 'mem_x', text: 'x', origin: 'learned' }, { op: 'add', text: 'no id', origin: 'learned' }],
        changes: valid.changes, undone: ['mem_a', 7],
      },
      { role: 'system', kind: 'marker', marker: 'taste', text: '', learnId: 'learn_no_changes', documentId: 'doc-1', key: 'k', items: valid.items },
      { role: 'system', kind: 'marker', marker: 'taste', text: '', learnId: 'learn_no_items', documentId: 'doc-1', key: 'k', items: [{}], changes: [] },
      { role: 'system', kind: 'marker', marker: 'taste', text: '', documentId: 'doc-1', key: 'k', items: valid.items, changes: [] },
    ],
  }]));
  const restored = getThread('stored-taste')!;
  const markers = tasteMarkers(restored);
  assert.deepEqual(markers.map((marker) => marker.learnId), ['learn_ok']);
  assert.deepEqual(markers[0]!.items.map((item) => item.entryId), ['mem_a', 'mem_b', 'mem_c']);
  assert.deepEqual(markers[0]!.changes, valid.changes);
  assert.deepEqual(markers[0]!.undone, ['mem_a']);
});

test('taste dividers never reach provider history', () => {
  const thread = threadWithTwoTurns();
  const before = serializeThreadMessagesForProviderHistory(thread.messages);
  addTasteMarker(thread, learned());
  assert.deepEqual(serializeThreadMessagesForProviderHistory(thread.messages), before);
});

test('a taste-learned frame with no readable item is ignored', () => {
  const frame = { ...learned(), items: [{ op: 'add', entryId: '', text: 'x', origin: 'learned' }] } as unknown as Record<string, unknown>;
  assert.equal(readTasteLearned(frame), null);
  const ok = readTasteLearned({ ...learned(), turnId: 42 } as unknown as Record<string, unknown>);
  assert.equal(ok?.turnId, null);
  assert.equal('proposal' in (ok ?? {}), false, 'AGENTS.md proposals are gone');
});

test('account-tier items keep their change, strength and event ids; older items derive the change from op', () => {
  const frame = {
    ...learned(),
    items: [
      { op: 'update', entryId: 'rule_1', text: '본문은 한다체', origin: 'learned', change: 'escalated', tier: 'account', kind: 'style', strength: { from: 2, to: 9 }, eventIds: ['ev_1', 7] },
      { op: 'add', entryId: 'mem_x', text: 'x', origin: 'learned', change: 'bogus' },
    ],
  } as unknown as Record<string, unknown>;
  const items = readTasteLearned(frame)!.items;
  assert.equal(items[0]!.change, 'escalated');
  assert.equal(items[0]!.tier, 'account');
  assert.deepEqual(items[0]!.strength, { from: 2, to: 5 }, 'strength stays within 0..5');
  assert.deepEqual(items[0]!.eventIds, ['ev_1']);
  assert.equal(items[1]!.change, undefined, 'an unknown change is dropped');
  assert.deepEqual(
    [{ op: 'add' }, { op: 'update' }, { op: 'remove' }].map((item) => tasteItemChange(item as never)),
    ['new', 'updated', 'retired'],
  );
});

/** 문서 하나에 묶인 대화 한 번짜리 채팅 — 최근 활동 순서는 at 이 정한다. */
function storedChat(id: string, documentId: string | null, at: number): ChatThread {
  const thread = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high', documentId });
  thread.id = id;
  thread.updatedAt = at;
  thread.lastActivityAt = at;
  thread.messages.push({ role: 'user', text: '요청', agent: 'claude' }, { role: 'assistant', text: '답', agent: 'claude' });
  return thread;
}

function seedChats(...threads: ChatThread[]): void {
  mem.clear();
  localStorage.setItem('rhwp-agent-threads', JSON.stringify(threads));
}

const historyLearn = (documentId: string, learnId = 'learn_history') => {
  const { threadId: _t, turnId: _u, proposal: _p, ...rest } = learned({ documentId, learnId });
  return rest;
};

test('a history learn goes to the visible chat when it belongs to that document', () => {
  seedChats(storedChat('visible', 'doc-1', 1_000), storedChat('newer', 'doc-1', 9_000));
  assert.equal(tasteHistoryThreadId('doc-1', 'visible'), 'visible');
});

test('a background document\'s history learn goes to its own latest chat, never the visible chat of another document', () => {
  seedChats(storedChat('visible', 'doc-other', 9_000), storedChat('old', 'doc-1', 1_000), storedChat('latest', 'doc-1', 5_000));
  assert.equal(tasteHistoryThreadId('doc-1', 'visible'), 'latest');
  assert.equal(tasteHistoryThreadId('doc-1', null), 'latest');
});

test('a document with no chat gets no history divider and no chat is created', () => {
  seedChats(storedChat('visible', 'doc-other', 9_000));
  const empty = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high', documentId: 'doc-1' });
  assert.equal(tasteHistoryThreadId('doc-1', 'visible'), null);
  assert.equal(tasteHistoryThreadId('doc-1', empty.id), null, 'an empty draft of that document is not a chat');
  assert.equal(addStoredTasteHistoryMarker('missing', historyLearn('doc-1')), false);
  assert.deepEqual(listThreads().map((thread) => thread.id), ['visible']);
});

test('a history divider is stored at the end of the chat, once per learn, and survives a reload', () => {
  const thread = threadWithTwoTurns();
  thread.documentId = 'doc-1';
  seedChats(thread);
  assert.equal(addStoredTasteHistoryMarker('thread-1', historyLearn('doc-1')), true);
  assert.equal(addStoredTasteHistoryMarker('thread-1', historyLearn('doc-1')), false, 'the same learn is kept once');
  const restored = getThread('thread-1')!;
  const marker = restored.messages.at(-1) as ThreadTasteMarker;
  assert.equal(marker.marker, 'taste');
  assert.equal(marker.learnId, 'learn_history');
  assert.equal(marker.turnId, null);
  assert.deepEqual(marker.items, learned().items);
  assert.deepEqual(marker.changes, learned().changes);
  assert.equal(tasteMarkers(restored).length, 1);
});
