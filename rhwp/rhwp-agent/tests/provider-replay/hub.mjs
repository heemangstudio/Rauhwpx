/**
 * Hub-level replay helpers: the real `server.mjs` (see `../hub-harness.mjs`)
 * with the replay CLI installed as its managed Pi binary, and a Studio
 * socket to drive chats with.
 */
import assert from 'node:assert/strict';

import {
  HUB_TEST_TOKEN,
  closeClient,
  openClient,
  sendFrame,
  startHub,
} from '../hub-harness.mjs';
import { providerReplayFixture } from './replay.mjs';
import { installReplayCli } from './replay-cli.mjs';

/**
 * Start the hub with `fixture` (a fixture name or an absolute bundle path)
 * replayed as Pi. `cli.results()` reads what each replay process saw.
 * Other options go to `startHub` (for example `env`, `piApiKey`).
 */
export async function startReplayPiHub(t, fixture, options = {}) {
  const bundlePath = fixture.endsWith('.ndjson') ? fixture : providerReplayFixture(fixture);
  let cli = null;
  const hub = await startHub(t, {
    prefix: 'rhwp-hub-provider-replay-',
    ...options,
    fakePi: ({ binDir }) => {
      cli = installReplayCli(binDir, 'pi', bundlePath);
      return null;
    },
  });
  return { ...hub, cli };
}

/** Open a Studio socket for `sessionId`, closed after the test, past its welcome frame. */
export async function openStudio(t, port, sessionId, { token = HUB_TEST_TOKEN } = {}) {
  const studio = await openClient(`ws://127.0.0.1:${port}/studio?token=${token}&sessionId=${encodeURIComponent(sessionId)}&instance=page-1`);
  t.after(() => closeClient(studio));
  await studio.next((frame) => frame.type === 'welcome');
  return studio;
}

/** Start a chat and resolve with its `chat-started` frame. */
export async function startChat(studio, threadId, agent = 'pi') {
  sendFrame(studio, { type: 'chat-start', agent, threadId, documentId: `${threadId}-doc` });
  return studio.next((frame) => frame.type === 'chat-started');
}

export function sendChatMessage(studio, started, text) {
  sendFrame(studio, { type: 'chat-user-message', threadId: started.threadId, documentId: started.documentId, text });
}

/** Every `agent-event` frame received so far, optionally of one event type. */
export function agentEvents(studio, type) {
  return studio.frames().filter((frame) => frame.type === 'agent-event' && (!type || frame.event?.type === type));
}

/** Poll `predicate` until it returns a truthy value, which is returned. */
export async function waitUntil(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
