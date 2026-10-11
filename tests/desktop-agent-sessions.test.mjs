import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_EXTRA_AGENT_SESSIONS_PER_WINDOW,
  SessionManager,
} from '../desktop/session-manager.mjs';

function fakeWindow(id) {
  let destroyed = false;
  const webContents = { id, isDestroyed: () => destroyed };
  return {
    webContents,
    isDestroyed: () => destroyed,
    destroy() { destroyed = true; },
  };
}

function setup({ register } = {}) {
  let next = 0;
  const registered = [];
  const closed = [];
  const manager = new SessionManager({
    launchId: 'launch-1',
    createId: () => `session-${++next}`,
    getHubContext: async () => ({ hubUrl: 'ws://127.0.0.1:34567' }),
    getSessionCapabilities: async (sessionId) => {
      registered.push(sessionId);
      await register?.(sessionId);
      return {
        studio: `${sessionId}:studio`,
        reference: `${sessionId}:reference`,
        template: `${sessionId}:template`,
      };
    },
    closeHubSession: async (sessionId) => { closed.push(sessionId); },
  });
  return { manager, registered, closed };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('an extra agent session resolves only for the window that created it', async () => {
  const { manager, registered } = setup();
  const first = fakeWindow(1);
  const second = fakeWindow(2);
  manager.addWindow(first);
  manager.addWindow(second);

  const extra = manager.addAgentSession(first.webContents);
  const context = await manager.contextForSender(first.webContents, extra);
  assert.equal(context.sessionId, extra);
  assert.equal(context.hubToken, `${extra}:studio`);
  assert.deepEqual(registered, [extra]);

  await assert.rejects(manager.contextForSender(second.webContents, extra), /does not own/);
  await assert.rejects(manager.contextForSender(first.webContents, 'session-2'), /does not own/);
  assert.equal(await manager.releaseAgentSession(second.webContents, extra), false);
  // The window session itself is unchanged.
  assert.equal((await manager.contextForSender(first.webContents)).sessionId, 'session-1');
});

test('releasing an extra session closes it on the hub and stops resolving it', async () => {
  const { manager, closed } = setup();
  const window = fakeWindow(1);
  manager.addWindow(window);
  const extra = manager.addAgentSession(window.webContents);

  assert.equal(await manager.releaseAgentSession(window.webContents, extra), true);
  assert.deepEqual(closed, [extra]);
  await assert.rejects(manager.contextForSender(window.webContents, extra), /does not own/);
  assert.equal(await manager.releaseAgentSession(window.webContents, extra), false);
  assert.deepEqual(closed, [extra]);
});

test('closing a window closes all of its extra sessions on the hub', async () => {
  const { manager, closed } = setup();
  const window = fakeWindow(1);
  const other = fakeWindow(2);
  manager.addWindow(window);
  manager.addWindow(other);
  const extras = [
    manager.addAgentSession(window.webContents),
    manager.addAgentSession(window.webContents),
  ];
  const otherExtra = manager.addAgentSession(other.webContents);

  window.destroy();
  assert.equal(manager.removeWindow(window), true);
  await settle();
  assert.deepEqual(closed.sort(), [...extras].sort());
  assert.equal((await manager.contextForSender(other.webContents, otherExtra)).sessionId, otherExtra);
});

test('a registration that finishes after release closes the session again', async () => {
  let finishRegistration;
  const { manager, closed } = setup({
    register: () => new Promise((resolve) => { finishRegistration = resolve; }),
  });
  const window = fakeWindow(1);
  manager.addWindow(window);
  const extra = manager.addAgentSession(window.webContents);

  const pending = manager.contextForSender(window.webContents, extra);
  await settle();
  manager.releaseAgentSessions(window);
  finishRegistration();
  await assert.rejects(pending, /released/);
  await settle();
  assert.deepEqual(closed, [extra, extra]);
});

test('one window cannot take every hub session', () => {
  const { manager } = setup();
  const window = fakeWindow(1);
  manager.addWindow(window);
  for (let i = 0; i < MAX_EXTRA_AGENT_SESSIONS_PER_WINDOW; i++) {
    manager.addAgentSession(window.webContents);
  }
  assert.throws(() => manager.addAgentSession(window.webContents), /too many agent sessions/);
});
