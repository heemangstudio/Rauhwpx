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

const { createEmptyThread, getThread, upsertThread } = await import('../src/agent/threads.ts');
const { ENGINE_TRAP_INTERRUPTED_NOTICE, markThreadInterruptedByEngineTrap } = await import('../src/recovery/trap-chat-notice.ts');

test('a chat stopped by an engine trap shows why when it is opened again', async () => {
  const thread = createEmptyThread({ agent: 'codex', model: 'default', effort: 'medium', documentId: 'doc-1', docKey: 'a.hwp' });
  thread.messages.push({ role: 'user', text: '표를 정리해 주세요' }, { role: 'assistant', text: '표를 읽는 중입니다' });
  upsertThread(thread);

  await markThreadInterruptedByEngineTrap(thread.id);

  const stored = getThread(thread.id);
  assert.ok(stored);
  assert.deepEqual(stored.messages.map((message) => message.role), ['user', 'assistant', 'system']);
  assert.equal(stored.messages.at(-1)?.text, ENGINE_TRAP_INTERRUPTED_NOTICE);
  assert.equal(stored.documentId, 'doc-1', 'the chat still belongs to its document');
});

test('marking a chat that no longer exists does nothing', async () => {
  await markThreadInterruptedByEngineTrap('missing-thread');
  assert.equal(getThread('missing-thread'), null);
});
