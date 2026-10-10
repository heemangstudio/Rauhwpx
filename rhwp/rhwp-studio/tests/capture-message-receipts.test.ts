import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({ load(url, context, next) {
  return url.endsWith('.css') ? { format: 'module', source: 'export default {};', shortCircuit: true } : next(url, context);
} });
const { AgentBridgeImpl } = await import('../src/agent/bridge.ts');

function connectedBridge() {
  const frames: Record<string, unknown>[] = [];
  const bridge = Object.assign(Object.create(AgentBridgeImpl.prototype), {
    state: 'connected', activeAgent: 'pi', pendingChatStart: null, workflowSwitchPending: false,
    queuedMessages: [], messageReceipts: new Map(), requestSeq: 0, revision: { revision: 7 },
    activeTemplateId: null, phase: 'idle', workflow: 'direct', turnSnapshots: null,
    turnRunning: false, activeToolRequests: 0, pendingUserQuestion: null, disposed: false,
    pendingEdits: { hasPending: () => false },
    referenceContext: () => ({ threadId: 'thread-1', documentId: 'document-1' }),
    buildTurnSnapshot: () => null, scheduleBusyCheck() {}, emitConnection() {},
    sendJson(frame: Record<string, unknown>) { frames.push(frame); return true; },
  });
  return { bridge, frames };
}

test('capture send waits for its accepted receipt while legacy sends keep their socket receipt', async () => {
  const { bridge, frames } = connectedBridge();
  let settled = false;
  const pending = bridge.sendUserMessage('comment', undefined, ['stage-1'], true, undefined, [],
    { requireAcceptance: true, messageId: 'capture-stable' }).then((id: string | null) => { settled = true; return id; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(frames[0].messageId, 'capture-stable');
  assert.equal(frames[0].requireAcceptance, true);
  bridge.handleMessage({ type: 'chat-user-message-accepted', messageId: 'unrelated' });
  await Promise.resolve();
  assert.equal(settled, false);
  bridge.handleMessage({ type: 'chat-user-message-accepted', messageId: 'capture-stable' });
  assert.equal(await pending, 'capture-stable');
  assert.equal(bridge.messageReceipts.size, 0);
  assert.match(await bridge.sendUserMessage('legacy', undefined, [], true), /^message-/);
});

test('rejected, cancelled, and disconnected capture sends preserve a failed receipt for retry', async () => {
  for (const outcome of ['rejected', 'cancelled', 'disconnected']) {
    const { bridge } = connectedBridge();
    const controller = new AbortController();
    const pending = bridge.sendUserMessage('comment', undefined, ['stage-1'], true, controller.signal, [],
      { requireAcceptance: true, messageId: 'capture-retry' });
    if (outcome === 'rejected') bridge.handleMessage({ type: 'chat-user-message-rejected', messageId: 'capture-retry' });
    if (outcome === 'cancelled') controller.abort();
    if (outcome === 'disconnected') bridge.setState('disconnected');
    assert.equal(await pending, null, outcome);
    assert.equal(bridge.messageReceipts.size, 0, outcome);
    assert.equal(bridge.isBusy(), false, `${outcome} clears busy immediately`);
    assert.equal(bridge.isTurnRunning(), false, outcome);
  }
});


test('concurrent duplicate capture IDs cannot replace an outstanding acceptance receipt', async () => {
  const { bridge, frames } = connectedBridge();
  const options = { requireAcceptance: true, messageId: 'capture-same' };
  const first = bridge.sendUserMessage('comment', undefined, ['stage-1'], true, undefined, [], options);
  assert.equal(await bridge.sendUserMessage('comment', undefined, ['stage-2'], true, undefined, [], options), null);
  assert.equal(frames.length, 1);
  bridge.handleMessage({ type: 'chat-user-message-accepted', messageId: options.messageId });
  assert.equal(await first, options.messageId);
});
