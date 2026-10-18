import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatContinuationQueue, ChatRequestRegistry } from '../chat-requests.mjs';

const request = (requestId, createdAt) => ({ requestId, createdAt, threadId: 'chat-a', documentId: null });

test('a pending request ends exactly once, by answer, expiry or its time limit', async () => {
  const finished = [];
  const registry = new ChatRequestRegistry({ publish: () => true, finish: (entry, outcome) => finished.push([entry.request.requestId, outcome]) });
  registry.add({ kind: 'generic', request: request('late', '2026-10-16T00:00:02Z'), threadId: 'chat-a', documentId: null });
  registry.add({ kind: 'secret', request: request('early', '2026-10-16T00:00:01Z'), threadId: 'chat-a', documentId: null }, 20);
  assert.deepEqual(registry.snapshot().map((entry) => entry.requestId), ['early', 'late'], 'snapshots follow creation order');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(finished, [['early', { status: 'expired', reason: 'timeout' }]]);
  assert.ok(registry.settle('late', { status: 'granted' }));
  assert.equal(registry.settle('late', { status: 'denied' }), null);
  assert.deepEqual(registry.expire('user-message'), []);
  assert.equal(finished.length, 2);
  assert.throws(() => new ChatRequestRegistry({ publish: () => false, finish: (entry, outcome) => finished.push([entry.request.requestId, outcome]) })
    .add({ kind: 'generic', request: request('unseen', '2026-10-16T00:00:03Z'), threadId: 'chat-a', documentId: null }), { code: 'NO_STUDIO' });
  assert.deepEqual(finished.at(-1), ['unseen', { status: 'expired', reason: 'studio-disconnected' }]);
});

test('continuations for one chat run together and leave other chats queued', () => {
  const queue = new ChatContinuationQueue();
  queue.push({ requestId: 'a1', threadId: 'chat-a', text: 'first' });
  queue.push({ requestId: 'b1', threadId: 'chat-b', text: 'other chat' });
  queue.push({ requestId: 'a2', threadId: 'chat-a', text: 'second' });
  assert.equal(queue.take('chat-a').text, 'first\nsecond');
  assert.equal(queue.take('chat-a'), null);
  assert.equal(queue.take('chat-b').text, 'other chat');
});
