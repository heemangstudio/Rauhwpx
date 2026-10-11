// welcome.hubInstanceId: one id per hub process. Studio compares it across
// welcomes to tell a hub restart (new process) from a lost chat session on a
// hub that stayed up, and stores it on each turn marker so a turn cut off while
// the page was away is labelled with the right reason.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import {
  HUB_TEST_TOKEN as TOKEN,
  closeClient,
  openClient,
  sendFrame,
  startHub,
} from './hub-harness.mjs';

async function welcomeFrom(port, sessionId, instance) {
  const studio = await openClient(
    `ws://127.0.0.1:${port}/studio?token=${TOKEN}&sessionId=${sessionId}&instance=${instance}`,
  );
  try {
    return await studio.next((frame) => frame.type === 'welcome');
  } finally {
    await closeClient(studio);
  }
}

test('every studio connection to one hub process sees the same hubInstanceId, and a restarted hub sends a new one', async (t) => {
  const first = await startHub(t, { prefix: 'rhwp-hub-instance-a-' });
  const a = await welcomeFrom(first.port, 'instance-window-a', 'page-1');
  const b = await welcomeFrom(first.port, 'instance-window-b', 'page-1');
  const again = await welcomeFrom(first.port, 'instance-window-a', 'page-2');

  assert.equal(typeof a.hubInstanceId, 'string');
  assert.ok(a.hubInstanceId.length > 0 && a.hubInstanceId.length <= 128, 'the id fits the turn marker owner field');
  assert.equal(b.hubInstanceId, a.hubInstanceId, 'another window on the same hub sees the same process');
  assert.equal(again.hubInstanceId, a.hubInstanceId, 'a reconnect to the same hub sees the same process');
  assert.notEqual(a.hubInstanceId, a.launchId, 'the process id is not the app launch id');
  assert.notEqual(a.hubInstanceId, a.hubSessionId, 'the process id is not the window session');

  // The desktop restarts the hub within one app run with the same launch id.
  const restarted = await startHub(t, { prefix: 'rhwp-hub-instance-b-', launchId: first.launchId });
  const afterRestart = await welcomeFrom(restarted.port, 'instance-window-a', 'page-1');
  assert.equal(afterRestart.launchId, a.launchId, 'the app launch id does not change with the hub process');
  assert.equal(typeof afterRestart.hubInstanceId, 'string');
  assert.notEqual(afterRestart.hubInstanceId, a.hubInstanceId, 'a new hub process sends a new id');
});

test('a hub that shuts down announces it to Studio before it ends the running turns', { timeout: 40_000 }, async (t) => {
  const hub = await startHub(t, { prefix: 'rhwp-hub-shutdown-', fakePi: true });
  const studio = await openClient(
    `ws://127.0.0.1:${hub.port}/studio?token=${TOKEN}&sessionId=shutdown-window&instance=page-1`,
  );
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  sendFrame(studio, { type: 'chat-start', agent: 'pi', threadId: 'thread-shutdown', documentId: 'doc-shutdown' });
  const started = await studio.next((frame) => frame.type === 'chat-started');
  sendFrame(studio, {
    type: 'chat-user-message', threadId: started.threadId, documentId: started.documentId, text: 'Keep working.',
  });
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-start');

  const exited = once(hub.child, 'exit');
  hub.child.kill('SIGTERM');
  await studio.next((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end', 20_000);
  await exited;
  const frames = studio.frames();
  const shutdown = frames.findIndex((frame) => frame.type === 'hub-shutdown');
  const turnEnd = frames.findIndex((frame) => frame.type === 'agent-event' && frame.event?.type === 'turn-end');
  assert.ok(shutdown >= 0, 'Studio hears that the hub is going down');
  assert.ok(shutdown < turnEnd, 'the notice comes before the turn-end the shutdown causes');
});
