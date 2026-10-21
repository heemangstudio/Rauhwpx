// 채팅 자리 — 화면 밖에서 일을 마친 문서들이 자리를 다 차지해도 새 채팅과 문서 전환이 막히지 않고,
// 닫으면 잃는 것이 있는 문서는 닫지 않는다.
import assert from 'node:assert/strict';
import test from 'node:test';

import { planChatCapacity, type ChatCapacitySession } from '../src/document-session-routing.ts';

const LIMIT = 6;

function session(name: string, fields: Partial<ChatCapacitySession> = {}): ChatCapacitySession & { name: string } {
  return { name, chats: [{}], inUse: false, working: false, holds: false, ...fields };
}

const names = (sessions: Array<{ name: string }>) => sessions.map((entry) => entry.name);

test('finished background documents give up the oldest slot to a new chat beside a working agent', () => {
  const sessions = [
    session('a'), session('b'), session('c'), session('d'), session('e'),
    session('shown', { inUse: true, working: true }),
  ];
  const plan = planChatCapacity(sessions, LIMIT);
  assert.equal(plan.kind, 'room');
  assert.deepEqual(plan.kind === 'room' && names(plan.release), ['a']);
});

test('nothing closes while there is room', () => {
  const plan = planChatCapacity([session('a'), session('shown', { inUse: true, working: true })], LIMIT);
  assert.deepEqual(plan, { kind: 'room', release: [] });
});

test('documents that would lose work stay open and the refusal names them', () => {
  const sessions = [
    session('unsaved', { holds: true }), session('review', { holds: true }), session('b', { working: true }),
    session('c', { working: true }), session('d', { working: true }),
    session('shown', { inUse: true, working: true }),
  ];
  assert.deepEqual(planChatCapacity(sessions, LIMIT), { kind: 'full', working: false });
});

test('a window full of working agents refuses without closing an idle document that would not free a slot', () => {
  const sessions = [
    session('idle', { chats: [] }), session('a', { working: true }), session('b', { working: true }),
    session('c', { working: true }), session('d', { working: true }), session('e', { working: true }),
    session('shown', { inUse: true, working: true }),
  ];
  assert.deepEqual(planChatCapacity(sessions, LIMIT), { kind: 'full', working: true });
});

test('the shown document and the one receiving the chat are never closed', () => {
  const sessions = [
    session('target', { inUse: true, chats: [{}, {}] }), session('a', { working: true }),
    session('b', { working: true }), session('c', { working: true }),
    session('shown', { inUse: true }),
  ];
  assert.deepEqual(planChatCapacity(sessions, LIMIT), { kind: 'full', working: true });
});
