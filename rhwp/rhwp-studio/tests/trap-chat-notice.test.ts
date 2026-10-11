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

const { createEmptyThread, createTurnMarker, getThread, latestTurnMarker, upsertThread } = await import('../src/agent/threads.ts');
const { markThreadInterruptedByEngineTrap } = await import('../src/recovery/trap-chat-notice.ts');

function workingChat() {
  const thread = createEmptyThread({ agent: 'codex', model: 'default', effort: 'medium', documentId: 'doc-1', docKey: 'a.hwp' });
  thread.messages.push(
    { role: 'user', text: '표를 정리해 주세요' },
    createTurnMarker(1_000, 'turn-1'),
    { role: 'assistant', text: '표를 읽는 중입니다', kind: 'progress' },
  );
  thread.followUps = { items: [{ id: 'f1', text: '다음 표도', createdAt: 1 }] };
  upsertThread(thread);
  return thread;
}

test('a chat stopped by an engine trap opens with its last turn cut off for that reason', async () => {
  const thread = workingChat();

  await markThreadInterruptedByEngineTrap(thread.id);

  const stored = getThread(thread.id);
  assert.ok(stored);
  const marker = latestTurnMarker(stored.messages);
  assert.equal(marker?.outcome, 'interrupted');
  assert.equal(marker?.interruption?.reason, 'engine-trap');
  assert.equal(marker?.interruption?.resolution, undefined, 'the user has not continued yet');
  assert.equal(stored.followUps?.hold?.detail, '문서 엔진 멈춤', 'queued messages wait with the reason');
  assert.equal(stored.documentId, 'doc-1', 'the chat still belongs to its document');
});

test('a chat shown in an open sidebar is marked through that sidebar, not the store', async () => {
  const thread = workingChat();
  const calls: string[] = [];
  await markThreadInterruptedByEngineTrap(thread.id, (id) => (id === thread.id
    ? { markInterrupted: (reason) => { calls.push(reason); return true; } }
    : null));
  assert.deepEqual(calls, ['engine-trap']);
  assert.equal(latestTurnMarker(getThread(thread.id)!.messages)?.outcome, null, 'the store copy is left to the sidebar');
});

test('marking a chat that no longer exists does nothing', async () => {
  await markThreadInterruptedByEngineTrap('missing-thread');
  assert.equal(getThread('missing-thread'), null);
});
