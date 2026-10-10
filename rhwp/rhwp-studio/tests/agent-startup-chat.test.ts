import assert from 'node:assert/strict';
import test from 'node:test';

import { decideStartupChat, hubChatBusy } from '../src/ui/agent-sidebar/startup-chat.ts';
import type { HubChat } from '../src/agent/bridge.ts';
import type { ChatThread } from '../src/agent/threads.ts';

function thread(id: string, documentId: string | null, docKey: string | null): ChatThread {
  return {
    id,
    title: id,
    titleRequested: true,
    createdAt: 0,
    updatedAt: 0,
    agent: 'claude',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    serviceTier: 'standard',
    workflow: 'direct',
    documentId,
    docKey,
    activeTemplateId: null,
    messages: [{ role: 'user', text: id }],
  };
}

// 최근 대화 순서(listThreads)다 — 제안서의 마지막 채팅은 recent 다.
const threads = [
  thread('recent', 'doc-a', '제안서.hwpx'),
  thread('live', 'doc-a', '제안서.hwpx'),
  thread('notes', 'doc-b', '회의록.hwpx'),
];
const byId = (id: string) => threads.find((item) => item.id === id) ?? null;
const live = (threadId: string, state: Partial<HubChat> = {}): HubChat => ({
  threadId, turnId: 'turn-1', running: true, awaitingUser: false, ...state,
});
const decide = (hub: HubChat | null, documentId: string | null, docKey: string | null) =>
  decideStartupChat({ live: hub, getThread: byId, threads, documentId, docKey });

test('the chat the hub still runs for this document is adopted, not the most recent one', () => {
  assert.deepEqual(decide(live('live'), 'doc-a', '제안서.hwpx'), {
    kind: 'adopt', threadId: 'live', live: live('live'),
  });
  // 질문이나 계획 승인을 기다리는 세션, 유휴 세션도 다시 시작하지 않고 잇는다.
  const waiting = live('live', { running: false, turnId: null, awaitingUser: true });
  assert.equal(decide(waiting, 'doc-a', '제안서.hwpx').kind, 'adopt');
  const idle = live('live', { running: false, turnId: null });
  assert.equal(decide(idle, 'doc-a', '제안서.hwpx').kind, 'adopt');
});

test('without a live chat the last chat of the document is restored', () => {
  assert.deepEqual(decide(null, 'doc-a', '제안서.hwpx'), { kind: 'restore', threadId: 'recent', stopLive: null });
  assert.deepEqual(decide(null, 'doc-c', '예산.hwpx'), { kind: 'restore', threadId: null, stopLive: null });
});

test('a busy chat of a document that is not open yet waits for that document', () => {
  assert.deepEqual(decide(live('notes'), null, null), { kind: 'await-document', live: live('notes') });
});

test('a busy chat of another document on screen is stopped before the restore', () => {
  assert.deepEqual(decide(live('notes'), 'doc-a', '제안서.hwpx'), {
    kind: 'restore', threadId: 'recent', stopLive: live('notes'),
  });
  // 기다리는 질문도 고칠 문서가 없으면 끝낸다.
  const asking = live('notes', { running: false, turnId: null, awaitingUser: true });
  assert.equal(decide(asking, 'doc-c', '예산.hwpx').kind, 'restore');
  assert.deepEqual((decide(asking, 'doc-c', '예산.hwpx') as { stopLive: HubChat | null }).stopLive, asking);
});

test('an idle session of another document is left to the restore and never awaited', () => {
  const idle = live('notes', { running: false, turnId: null });
  assert.equal(hubChatBusy(idle), false);
  assert.deepEqual(decide(idle, 'doc-a', '제안서.hwpx'), { kind: 'restore', threadId: 'recent', stopLive: null });
  assert.deepEqual(decide(idle, null, null), { kind: 'restore', threadId: null, stopLive: null });
});

test('a busy session whose chat is gone from the store is stopped when a document is shown', () => {
  assert.deepEqual(decide(live('deleted'), 'doc-a', '제안서.hwpx'), {
    kind: 'restore', threadId: 'recent', stopLive: live('deleted'),
  });
});
