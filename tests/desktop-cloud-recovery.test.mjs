import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CloudCoordinator } from '../desktop/cloud-coordinator.mjs';
import { openCloudDisplay } from '../desktop/cloud-display.mjs';
import { CloudHandoffStore, sha256Hex } from '../desktop/cloud-handoff.mjs';

const key = `ed25519:${generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')}`;
const profile = { mode: 'self-hosted', endpoint: 'https://cloud.example.test', serverPublicKey: key,
  transport: 'tailscale', ssh: { host: 'cloud.example.test', user: 'test', port: 22 } };
const store = () => ({ load: async () => [], list: async () => [], flush: async () => {} });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const waitForAbort = (signal) => new Promise((resolve, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('external cancellation during display retry backoff never rejects an unobserved background loop', async () => {
  const controller = new AbortController();
  const retrying = Promise.withResolvers();
  const connection = await openCloudDisplay({
    displayCapability: async () => ({ kind: 'available', sessionId: 'session-1', streamId: 'stream-1' }),
    setDisplayInterest: async () => {},
    readDisplayFrames: async () => { throw Object.assign(new Error('worker stopped'), { code: 'ECONNRESET' }); },
  }, 'session-1', (event) => {
    if (event.state === 'reconnecting') retrying.resolve();
  }, { signal: controller.signal, retryBaseMs: 5000 });
  await retrying.promise;
  controller.abort();
  // No close handler is attached until the next event-loop turn. Node's test
  // runner reports any unhandled rejection in that interval as a test failure.
  await tick();
  await tick();
  await connection.close();
});

test('shutdown interrupts an indefinitely opening preview before acquiring its writer lock', { timeout: 1000 }, async () => {
  const started = Promise.withResolvers();
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      openDisplay: async (_id, _listener, { signal }) => { started.resolve(); return waitForAbort(signal); },
    }, store: store(),
  });
  const opening = assert.rejects(coordinator.openDisplay('session-1', () => {}), { name: 'AbortError' });
  await started.promise;
  const before = performance.now();
  const result = await coordinator.forceQuitAccountCloud();
  await opening;
  assert.equal(result.lease.owner, 'local');
  assert.ok(performance.now() - before < 250);
  await coordinator.stop();
});

test('shutdown cancels a shared reconnect and the next reconnect remains usable', { timeout: 1000 }, async () => {
  let blocked = true;
  let probes = 0;
  const entered = Promise.withResolvers();
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => profile, isPaired: async () => true,
      health: async (_profile, { signal, timeoutMs }) => {
        probes++;
        assert.equal(timeoutMs, 2000);
        if (!blocked) return { ok: true, serverPublicKey: key };
        entered.resolve();
        return waitForAbort(signal);
      },
    }, store: store(),
  });
  const first = coordinator.reconnectCloud();
  const second = coordinator.reconnectCloud();
  assert.equal(first, second);
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await entered.promise;
  await coordinator.forceQuitAccountCloud();
  await rejected;
  blocked = false;
  assert.equal((await coordinator.reconnectCloud()).link.kind, 'ready');
  assert.equal(probes, 2);
  await coordinator.stop();
});

test('snapshots return immediately while account status is unavailable', { timeout: 1000 }, async () => {
  const pending = Promise.withResolvers();
  const coordinator = new CloudCoordinator({
    client: { loadProfile: async () => null }, store: store(),
    appServers: [{ id: 'raucloud', displayName: 'Raucloud', configuration: () => ({ configured: true }),
      spawn: async () => {}, status: async () => {}, teardown: async () => {}, accountStatus: () => pending.promise }],
  });
  assert.equal((await coordinator.snapshot()).session.kind, 'idle');
  pending.resolve(null);
  await coordinator.stop();
});

test('confirmed shutdown does not wait for a blocked account status refresh', { timeout: 1000 }, async () => {
  const pending = Promise.withResolvers();
  const coordinator = new CloudCoordinator({
    client: { loadProfile: async () => null }, store: store(),
    appServers: [{ id: 'raucloud', displayName: 'Raucloud', configuration: () => ({ configured: true }),
      spawn: async () => {}, status: async () => {}, teardown: async () => {},
      forceQuitAccount: async () => ({ lifecycle: 'idle' }), accountStatus: () => pending.promise }],
  });
  await coordinator.snapshot();
  const before = performance.now();
  assert.equal((await coordinator.forceQuitAccountCloud()).session.kind, 'idle');
  assert.ok(performance.now() - before < 250);
  pending.resolve(null);
  await coordinator.stop();
});

test('profile replacement awaits display cleanup even when shutdown already started it', async () => {
  const closing = Promise.withResolvers();
  const release = Promise.withResolvers();
  let activated = false;
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => null,
      saveProfile: async () => { activated = true; },
      saveServerMode: async () => 'self-hosted',
      openDisplay: async () => ({ capability: { kind: 'available' },
        close: async () => { closing.resolve(); await release.promise; } }),
    }, store: store(),
  });
  await coordinator.openDisplay('session-1', () => {});
  const changing = coordinator.saveProfile({ host: 'cloud.tailnet.ts.net', sshUser: 'test', serverPublicKey: key });
  await closing.promise;
  await tick();
  assert.equal(activated, false);
  release.resolve();
  await changing;
  assert.equal(activated, true);
  await coordinator.stop();
});

test('background recovery keeps a failed banner stable and restores the connection when health returns', async () => {
  let healthy = false;
  const events = [];
  const coordinator = new CloudCoordinator({
    client: { loadProfile: async () => profile, isPaired: async () => true,
      health: async () => { if (!healthy) throw new Error('offline'); return { ok: true, serverPublicKey: key }; } },
    store: store(),
  });
  coordinator.on('event', (event) => events.push(event.type));
  await coordinator.reconnectCloud();
  events.length = 0;
  assert.equal((await coordinator.reconnectCloud({ background: true })).link.kind, 'failed');
  assert.equal(events.includes('cloud-link-reconnecting'), false);
  healthy = true;
  assert.equal((await coordinator.reconnectCloud({ background: true })).link.kind, 'ready');
  await coordinator.stop();
});

test('healthy server with a lost session offers recovery instead of claiming the chat is connected', async () => {
  const records = [{ id: 'handoff-1', cloudSessionId: 'session-lost', state: 'running',
    threadId: 'current-chat', originDocumentId: 'doc-1', createdAt: new Date().toISOString(),
    destination: { endpoint: profile.endpoint, serverPublicKey: key, mode: profile.mode } }];
  const coordinator = new CloudCoordinator({
    client: { loadProfile: async () => profile, isPaired: async () => true,
      health: async () => ({ ok: true, serverPublicKey: key }), sessions: async () => [] },
    store: { ...store(), list: async () => records },
  });
  assert.equal((await coordinator.reconnectCloud()).link.kind, 'failed');
  const result = await coordinator.snapshot({ threadId: 'current-chat', documentId: 'doc-1' });
  assert.equal(result.session.sessionId, 'session-lost');
  assert.equal(result.lease.owner, 'cloud', 'ownership is retained until explicit restart or shutdown');
  await coordinator.stop();
});

test('chat selection stays on its thread while the document lease remains with its owner', async () => {
  const records = ['chat-newer', 'chat-current'].map((threadId, index) => ({
    id: `handoff-${index}`, cloudSessionId: `session-${index}`, threadId,
    originDocumentId: 'shared-document', originSessionId: 'window-1', state: 'running',
    documentName: 'shared.hwpx', revision: 1, serverVersion: 1, limits: {},
    createdAt: `2026-09-0${2 - index}T00:00:00.000Z`, timeline: { thread: { id: threadId } },
  }));
  const coordinator = new CloudCoordinator({
    client: { loadProfile: async () => null }, store: { ...store(), list: async () => records },
  });
  const result = await coordinator.snapshot({ documentId: 'shared-document', threadId: 'chat-current' });
  assert.equal(result.session.threadId, 'chat-current');
  assert.equal(result.timeline.thread.id, 'chat-current');
  assert.equal(result.lease.sessionId, 'session-0');
  const threadOnly = await coordinator.snapshot({ threadId: 'chat-current' });
  assert.equal(threadOnly.session.threadId, 'chat-current');
  assert.equal(threadOnly.timeline.thread.id, 'chat-current');
  const unrelated = await coordinator.snapshot({ documentId: 'shared-document', threadId: 'new-chat' });
  assert.equal(unrelated.session.kind, 'idle');
  assert.equal(unrelated.timeline, null);
  assert.equal(unrelated.lease.sessionId, 'session-0');
  await coordinator.stop();
});

test('reconnect discovers the existing remote chat without selecting an unrelated session', async () => {
  const remote = { id: 'remote-1', status: 'running', stateVersion: 4,
    clientContext: { threadId: 'current-chat', documentId: 'doc-1' }, originDocument: { name: 'doc.hwpx' } };
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => profile, isPaired: async () => true,
      health: async () => ({ ok: true, serverPublicKey: key }), sessions: async () => [remote],
      watchSession: async (_id, _after, { signal }) => waitForAbort(signal),
    }, store: store(),
  });
  await coordinator.reconnectCloud();
  assert.equal((await coordinator.snapshot({ documentId: 'doc-1', threadId: 'current-chat' })).session.sessionId, 'remote-1');
  assert.equal((await coordinator.snapshot({ documentId: 'another-doc', threadId: 'another-chat' })).session.kind, 'idle');
  await coordinator.stop();
});

test('a failed rebuild is retryable after the old profile has been removed; duplicate clicks share one rebuild', async () => {
  const sandbox = { providerId: 'raucloud', sandboxId: 'run-1', host: 'worker.example.test', region: 'test', createdAt: new Date().toISOString() };
  let current = { ...profile, mode: 'app-hosted', sandbox };
  let spawnCalls = 0;
  let teardownCalls = 0;
  let deadWorkerRequests = 0;
  const provider = {
    id: 'raucloud', displayName: 'Raucloud', configuration: () => ({ configured: true }),
    accountStatus: async () => null,
    forceQuitAccount: async () => ({ lifecycle: 'idle', status: 'stopped' }),
    status: async () => ({ lifecycle: 'ready' }),
    teardown: async () => { teardownCalls++; return { removed: true }; },
    spawn: async () => {
      spawnCalls++;
      if (spawnCalls === 1) throw new Error('temporary provisioning failure');
      return { sandbox, receipt: { endpoint: 'https://worker.example.test', serverPublicKey: key, pairingCode: 'ABCD' } };
    },
  };
  const coordinator = new CloudCoordinator({
    client: {
      loadServerMode: async () => 'app-hosted', saveServerMode: async (mode) => mode,
      loadProfile: async () => current, isPaired: async () => true,
      forgetProfile: async () => { current = null; },
      activateProfile: async (next) => { current = next; },
      redeemPairingCode: async () => ({ credentials: { device: {} } }),
      health: async () => ({ ok: true, serverPublicKey: key }),
      sessions: async () => { deadWorkerRequests++; return []; },
    }, store: store(), appServers: [provider],
  });
  await coordinator.start();
  const first = coordinator.recreateCloud();
  assert.equal(coordinator.recreateCloud(), first);
  assert.equal((await first).link.kind, 'failed');
  assert.equal(current, null);
  assert.equal((await coordinator.snapshot()).link.canRecreate, true);
  const result = await coordinator.recreateCloud();
  assert.equal(result.link.kind, 'ready');
  assert.equal(spawnCalls, 2);
  assert.equal(teardownCalls, 0);
  assert.equal(deadWorkerRequests, 0);
  await coordinator.stop();
});

const destination = { endpoint: profile.endpoint, serverPublicKey: key, mode: profile.mode, protocolVersion: 1 };
const LIVE_PATHS = Object.freeze({
  uploading: [],
  running: ['committing', 'running'],
  suspended: ['committing', 'running', 'suspended'],
  completed: ['committing', 'running', 'completed'],
  downloaded: ['committing', 'running', 'completed', 'downloading', 'downloaded'],
});
const hang = async (_id, _after, { signal }) => { await waitForAbort(signal).catch(() => {}); };
const settle = async () => { for (let turn = 0; turn < 25; turn += 1) await new Promise((resolve) => setImmediate(resolve)); };

async function eventually(check, { timeoutMs = 4_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('The expected state was not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function collect(coordinator) {
  const events = [];
  coordinator.on('event', (event) => events.push(event));
  return events;
}

function nextEvent(coordinator, type) {
  return new Promise((resolve) => {
    const listener = (event) => {
      if (event.type !== type) return;
      coordinator.off('event', listener);
      resolve(event);
    };
    coordinator.on('event', listener);
  });
}

/** A real handoff store in a temp directory; coordinators stop before the directory goes. */
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-coordinator-recovery-'));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const coordinators = [];
  t.after(async () => {
    for (const coordinator of coordinators) await coordinator.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    store,
    recoveryDir: path.join(directory, 'recovery'),
    coordinator(options) {
      const coordinator = new CloudCoordinator({
        store, provisioner: {}, recoveryDir: path.join(directory, 'recovery'), ...options,
      });
      coordinators.push(coordinator);
      return coordinator;
    },
    async handoff({
      state = 'running', cloudSessionId = 'cloud-session-1', id, documentId = 'document-1',
      threadId = 'thread-1', patch = null, target = destination,
    } = {}) {
      const created = await store.create({
        startId: id, sessionId: 'desktop-1', threadId, documentId, documentName: 'source.hwpx',
        documentBytes: Buffer.from('document'), provider: 'codex', limits: { maxTurns: 100 }, destination: target,
      });
      await store.transition(created.id, 'uploading');
      for (const step of LIVE_PATHS[state]) {
        await store.transition(created.id, step, step === 'committing' ? {} : { cloudSessionId, serverVersion: 2 });
      }
      if (patch) await store.patch(created.id, patch);
      return store.get(created.id);
    },
  };
}

function startPayload(startId) {
  const text = 'Continue this document';
  const now = Date.now();
  return {
    startId, agent: 'codex', threadId: 'thread-send', documentId: 'document-send',
    initialMessage: { id: 'msg-start', text, attachmentReferenceIds: [] },
    document: { fileName: 'send.hwpx', bytes: Buffer.from('document to send') },
    timeline: {
      schema: 'rauhwpx.cloud.timeline', version: 1, exportedAt: new Date(now).toISOString(),
      thread: {
        id: 'thread-send', title: 'Task', createdAt: now, updatedAt: now, agent: 'codex',
        model: 'gpt-5.6', effort: 'high', messages: [{ role: 'user', text, messageId: 'msg-start' }],
      },
    },
  };
}

test('a server purge of a suspended conversation expires it and closes its stream', async (t) => {
  const f = await fixture(t);
  const record = await f.handoff({ state: 'suspended', patch: { lastEventSequence: 8 } });
  let streamSignal = null;
  const coordinator = f.coordinator({
    client: {
      loadProfile: async () => profile,
      isPaired: async () => true,
      watchSession: async (_id, after, { signal, onEvent }) => {
        streamSignal = signal;
        assert.equal(after, 8);
        // Like the real client, a handler failure fails the stream.
        await onEvent({ sequence: 9, type: 'session.purged', payload: { status: 'purged' } });
        await waitForAbort(signal).catch(() => {});
      },
    },
  });
  const events = collect(coordinator);
  await coordinator.start();

  // A purged conversation has nothing left to stream.
  const expired = await eventually(async () => {
    const latest = await f.store.get(record.id);
    return latest.state === 'expired' && streamSignal?.aborted ? latest : null;
  });
  assert.equal(expired.lastEventSequence, 9);
  assert.equal(events.some((event) => event.type === 'session-stream-error'), false);
  await coordinator.dismissSession({ sessionId: 'cloud-session-1' });
  assert.equal(await f.store.get(record.id), null, 'an expired conversation can be dismissed');
});

test('events that can never apply are stepped over so later events still arrive', async (t) => {
  const f = await fixture(t);
  const record = await f.handoff({ state: 'running', patch: { lastEventSequence: 8 } });
  const coordinator = f.coordinator({
    client: {
      loadProfile: async () => profile,
      isPaired: async () => true,
      session: async (id) => ({ id, status: 'completed', persistent: false }),
      downloadTimeline: async () => ({ timeline: { schema: 'rauhwpx.cloud.timeline' }, sha256: 'a'.repeat(64), size: 2 }),
      watchSession: async (_id, _after, { signal, onEvent }) => {
        for (const event of [
          { sequence: 9, type: 'boundary.committed', payload: { kind: 'turn', operationId: 'op-bad', turnNumber: 1, revision: 0 } },
          { sequence: 10, type: 'session.completed', payload: { status: 'completed', stateVersion: 4 } },
          { sequence: 11, type: 'session.resumed', payload: { status: 'running', stateVersion: 5 } },
          { sequence: 12, type: 'session.updated', payload: { status: 'completed', stateVersion: 6 } },
        ]) await onEvent(event);
        await waitForAbort(signal).catch(() => {});
      },
    },
  });
  const events = collect(coordinator);
  await coordinator.start();

  const latest = await eventually(async () => {
    const current = await f.store.get(record.id);
    return current.lastEventSequence === 12 ? current : null;
  });
  assert.equal(latest.state, 'completed');
  assert.equal(latest.serverVersion, 6);
  assert.equal(latest.pendingTurnBoundary ?? null, null);
  assert.deepEqual(events.filter((event) => event.type === 'session-event-rejected').map((event) => ({
    sequence: event.sequence, eventType: event.eventType, code: event.code,
  })), [
    { sequence: 9, eventType: 'boundary.committed', code: 'CLOUD_EVENT_INVALID' },
    { sequence: 11, eventType: 'session.resumed', code: 'HANDOFF_TRANSITION_INVALID' },
  ]);
  assert.equal(events.some((event) => event.type === 'session-stream-error'), false);
});

test('a turn boundary queued behind a newer command receipt is still archived', async (t) => {
  const f = await fixture(t);
  // A pause command already returned eventSeq 11 while events 9 and 10 were still in the stream.
  const record = await f.handoff({
    state: 'running',
    patch: {
      lastEventSequence: 11,
      queuedMessages: [{ id: 'message-1', text: 'Use the totals', state: 'queued', serverQueued: true, retryPending: false }],
    },
  });
  const checkpoint = Buffer.from('document after turn three');
  let downloads = 0;
  const ready = Promise.withResolvers();
  let deliver = null;
  const coordinator = f.coordinator({
    client: {
      loadProfile: async () => profile,
      isPaired: async () => true,
      downloadCheckpoint: async (_id, { operationId }) => {
        downloads += 1;
        return {
          bytes: checkpoint, sha256: sha256Hex(checkpoint), size: checkpoint.length, name: 'source.hwpx',
          revision: 5, turn: 3, boundaryOperation: operationId, boundaryKind: 'turn',
        };
      },
      watchSession: async (_id, _after, { signal, onEvent }) => {
        deliver = onEvent;
        ready.resolve();
        await waitForAbort(signal).catch(() => {});
      },
    },
  });
  await coordinator.start();
  await ready.promise;
  const boundary = {
    sequence: 10, type: 'boundary.committed',
    payload: { kind: 'turn', operationId: 'op-turn-3', turnNumber: 3, revision: 5 },
  };
  await deliver(boundary);

  const synced = await eventually(async () => {
    const current = await f.store.get(record.id);
    return current.lastSyncedRevision === 5 ? current : null;
  });
  assert.equal(synced.pendingTurnBoundary, null);
  assert.deepEqual(synced.turnArchives.map(({ operationId, revision }) => ({ operationId, revision })), [
    { operationId: 'op-turn-3', revision: 5 },
  ]);
  await deliver(boundary);
  await deliver({ sequence: 9, type: 'message.accepted', payload: { messageId: 'message-1', status: 'delivered' } });
  await settle();
  const latest = await f.store.get(record.id);
  assert.equal(downloads, 1, 'a replayed boundary is not downloaded again');
  assert.equal(latest.queuedMessages[0].state, 'accepted', 'a late acceptance still moves the message forward');
  assert.equal(latest.lastEventSequence, 11);
});

function restoringWorld({ listConversations, restoreSession }) {
  let current = null;
  const calls = { teardown: 0, restored: [] };
  const sandbox = {
    providerId: 'raucloud', sandboxId: 'run-2', host: 'worker.example.test', region: 'test',
    createdAt: new Date().toISOString(),
  };
  const conversation = (sessionId, documentId, threadId) => ({
    id: `merge_${sessionId}`, sessionId, documentId, threadId, cloudStartId: 'cloud-start-1',
    revision: 3, turn: 1, createdAt: Date.now() - 60_000, expiresAt: Date.now() + 86_400_000,
    sha256: 'b'.repeat(64), size: 4096, state: 'running', pendingWork: true,
  });
  const provider = {
    id: 'raucloud', displayName: 'Raucloud', configuration: () => ({ configured: true }),
    accountStatus: async () => ({ signedIn: true }),
    getLocalCacheIdentity: async () => 'account-credential-1',
    listConversations: listConversations ?? (async () => ({
      accountId: 'account-1',
      conversations: [
        conversation('cloud-session-a', 'document-a', 'thread-a'),
        conversation('cloud-session-b', 'document-b', 'thread-b'),
      ],
    })),
    spawn: async () => ({
      sandbox, receipt: { endpoint: 'https://worker.example.test/rauhwpx-cloud', serverPublicKey: key, pairingCode: 'ABCD' },
    }),
    status: async () => ({ lifecycle: 'ready' }),
    teardown: async () => { calls.teardown += 1; return { removed: true }; },
  };
  const client = {
    loadProfile: async () => current,
    isPaired: async () => current != null,
    loadPendingAppSandbox: async () => null,
    savePendingAppSandbox: async () => {},
    clearPendingAppSandbox: async () => {},
    redeemPairingCode: async () => ({ credentials: { device: {} } }),
    health: async () => ({ ok: true, serverPublicKey: key, capabilities: { conversationRestore: true } }),
    activateProfile: async (next) => { current = next; },
    saveServerMode: async (mode) => mode,
    sessions: async () => [],
    restoreSession: async (sessionId) => {
      await restoreSession(sessionId);
      calls.restored.push(sessionId);
      return { session: { id: sessionId, status: 'running', stateVersion: 3 }, sourceEventSeq: 4, restoredEventSeq: 5 };
    },
    watchSession: hang,
  };
  return { provider, client, calls };
}

test('one conversation that fails to restore neither blocks the others nor tears down the new worker', async (t) => {
  const f = await fixture(t);
  const failing = await f.handoff({ cloudSessionId: 'cloud-session-a', documentId: 'document-a', threadId: 'thread-a' });
  const healthy = await f.handoff({ cloudSessionId: 'cloud-session-b', documentId: 'document-b', threadId: 'thread-b' });
  const world = restoringWorld({
    restoreSession: async (sessionId) => {
      if (sessionId === 'cloud-session-a') {
        throw Object.assign(new Error('Saved conversation was purged'), { status: 404, code: 'CONVERSATION_SNAPSHOT_NOT_FOUND' });
      }
    },
  });
  const coordinator = f.coordinator({ client: world.client, appServers: [world.provider] });
  const events = collect(coordinator);

  const snapshot = await coordinator.spawnAppServer({});
  assert.equal(snapshot.server.lifecycle, 'ready');
  assert.equal(world.calls.teardown, 0, 'the worker the profile now points to stays up');
  assert.deepEqual(world.calls.restored, ['cloud-session-b']);
  assert.equal((await f.store.get(healthy.id)).restoredAt != null, true);
  const failed = await f.store.get(failing.id);
  assert.equal(failed.errorCode, 'CONVERSATION_SNAPSHOT_NOT_FOUND');
  assert.deepEqual(events.filter((event) => event.type === 'cloud-conversation-restore-failed')
    .map((event) => event.sessionId), ['cloud-session-a']);
});

test('a broker outage right after activation defers restore instead of failing the new worker', async (t) => {
  const f = await fixture(t);
  await f.handoff({ cloudSessionId: 'cloud-session-a', documentId: 'document-a', threadId: 'thread-a' });
  const world = restoringWorld({
    listConversations: async () => {
      throw Object.assign(new Error('Raucloud is unavailable'), { code: 'RAUCLOUD_UNAVAILABLE', retryable: true });
    },
    restoreSession: async () => {},
  });
  const coordinator = f.coordinator({ client: world.client, appServers: [world.provider] });
  const events = collect(coordinator);

  const snapshot = await coordinator.spawnAppServer({});
  assert.equal(snapshot.server.lifecycle, 'ready');
  assert.equal(world.calls.teardown, 0);
  assert.ok(events.some((event) => event.type === 'conversation-restore-deferred'));
  assert.equal(events.some((event) => event.type === 'sandbox-provision-failed'), false);
});

test('a transient restore failure during reconnect keeps retrying instead of asking to discard', async (t) => {
  const f = await fixture(t);
  const appProfile = { ...profile, mode: 'app-hosted', sandbox: { providerId: 'raucloud', sandboxId: 'run-2' } };
  await f.handoff({
    cloudSessionId: 'cloud-session-a', documentId: 'document-a', threadId: 'thread-a',
    target: { ...destination, mode: 'app-hosted', sandboxId: 'run-2', sandboxProvider: 'raucloud' },
  });
  const world = restoringWorld({
    restoreSession: async () => {
      throw Object.assign(new Error('Raucloud is unavailable'), { code: 'RAUCLOUD_UNAVAILABLE', retryable: true });
    },
  });
  await world.client.activateProfile(appProfile);
  const coordinator = f.coordinator({ client: world.client, appServers: [world.provider] });

  const snapshot = await coordinator.reconnectCloud();
  assert.equal(snapshot.link.kind, 'failed');
  assert.equal(snapshot.link.reason, 'network');
});

function resultWorld(confirm) {
  const result = Buffer.from('finished document');
  const timeline = Buffer.from('{"schema":"rauhwpx.cloud.timeline"}');
  const confirmations = [];
  return {
    confirmations,
    client: {
      loadProfile: async () => profile,
      isPaired: async () => true,
      session: async (sessionId) => ({ id: sessionId, status: 'completed', result: { id: sessionId } }),
      downloadTimeline: async () => ({
        bytes: timeline, sha256: sha256Hex(timeline), size: timeline.length, timeline: { schema: 'rauhwpx.cloud.timeline' },
      }),
      downloadResult: async () => ({ bytes: result, sha256: sha256Hex(result), size: result.length, name: 'source.hwpx' }),
      confirmResultDownloaded: async (resultId, receipt) => {
        confirmations.push({ resultId, sha256: receipt.sha256, size: receipt.size });
        await confirm(resultId, confirmations.length);
        return { status: 'purged' };
      },
      watchSession: hang,
    },
    digest: sha256Hex(result),
  };
}

const lostResponse = () => Object.assign(new Error('Cloud request timed out'), { code: 'ETIMEDOUT', retryable: true });

test('resolving a result while its confirmation is retrying still confirms it and lets it close', async (t) => {
  const f = await fixture(t);
  const record = await f.handoff({ state: 'completed' });
  const world = resultWorld(async (_id, attempt) => { if (attempt === 1) throw lostResponse(); });
  const coordinator = f.coordinator({ client: world.client });

  await coordinator.downloadResult({ sessionId: 'cloud-session-1' });
  assert.equal((await f.store.get(record.id)).state, 'downloading');
  await coordinator.recordResolution(record.id, { action: 'replace', path: '/tmp/source.hwpx', conflict: false });

  const downloaded = await eventually(async () => {
    const current = await f.store.get(record.id);
    return current.state === 'downloaded' ? current : null;
  });
  assert.equal(downloaded.recoveryPath, null);
  assert.deepEqual(world.confirmations.at(-1), { resultId: 'cloud-session-1', sha256: world.digest, size: 17 });
  await coordinator.dismissSession({ sessionId: 'cloud-session-1' });
  assert.equal(await f.store.get(record.id), null);
});

test('a missing local result reopens the download instead of retrying confirmation forever', async (t) => {
  const f = await fixture(t);
  const record = await f.handoff({ state: 'completed' });
  const world = resultWorld(async () => { throw lostResponse(); });
  const coordinator = f.coordinator({ client: world.client });
  const resetting = nextEvent(coordinator, 'result-recovery-reset');

  await coordinator.downloadResult({ sessionId: 'cloud-session-1' });
  await rm(path.join(f.recoveryDir, record.id), { recursive: true, force: true });

  await resetting;
  const reset = await f.store.get(record.id);
  assert.equal(reset.state, 'completed');
  assert.equal(reset.recoveryPath, null);
  assert.equal(world.confirmations.length, 1, 'no confirmation is sent for bytes that no longer exist');
});

test('a confirmation the server rejects for good finishes the download locally', async (t) => {
  const f = await fixture(t);
  const immediate = await f.handoff({ state: 'completed', cloudSessionId: 'cloud-session-x', documentId: 'document-x' });
  const recovered = await f.handoff({ state: 'completed', cloudSessionId: 'cloud-session-y', documentId: 'document-y' });
  const gone = () => Object.assign(new Error('Session was not found'), { status: 404, code: 'SESSION_NOT_FOUND' });
  const world = resultWorld(async (resultId, attempt) => {
    if (resultId === 'cloud-session-x' || attempt > 2) throw gone();
    throw lostResponse();
  });
  const coordinator = f.coordinator({ client: world.client });
  const events = collect(coordinator);

  await coordinator.downloadResult({ sessionId: 'cloud-session-x' });
  assert.equal((await f.store.get(immediate.id)).state, 'downloaded');
  await coordinator.downloadResult({ sessionId: 'cloud-session-y' });
  await eventually(() => events.filter((event) => event.type === 'result-confirmation-abandoned').length === 2);
  const finished = await f.store.get(recovered.id);
  assert.equal(finished.state, 'downloaded');
  assert.match(finished.confirmationError, /not found/);
  assert.equal(world.confirmations.length, 3);
});

test('a reconnect during a send does not start a second upload of the same handoff', async (t) => {
  const f = await fixture(t);
  const gate = Promise.withResolvers();
  const uploading = Promise.withResolvers();
  let uploads = 0;
  const coordinator = f.coordinator({
    client: {
      loadProfile: async () => profile,
      isPaired: async () => true,
      health: async () => ({ ok: true, serverPublicKey: key }),
      sessions: async () => [],
      assertTransferReady: async () => ({ profile, health: { protocolVersion: 1, version: '2.0.0' } }),
      transfer: async () => {
        uploads += 1;
        uploading.resolve();
        await gate.promise;
        return { id: 'cloud-transfer-1', status: 'queued', stateVersion: 1 };
      },
      watchSession: hang,
    },
  });
  const events = collect(coordinator);

  const sending = coordinator.transfer(startPayload('startsingle1'), { originSessionId: 'desktop-1' });
  await uploading.promise;
  // A link heal re-schedules transfer recovery for every uploading record.
  assert.equal((await coordinator.reconnectCloud()).link.kind, 'ready');
  const repeated = coordinator.transfer(startPayload('startsingle1'), { originSessionId: 'desktop-1' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(uploads, 1);

  gate.resolve();
  await sending;
  assert.equal((await repeated).session.sessionId, 'cloud-transfer-1');
  assert.equal((await f.store.get('startsingle1')).state, 'queued');
  assert.equal(uploads, 1);
  assert.equal(events.some((event) => event.type === 'session-transfer-failed'), false);
});

test('failed turn autosync backs off instead of retrying every second', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  await f.handoff({
    state: 'running',
    patch: { pendingTurnBoundary: { operationId: 'op-turn-7', turnNumber: 2, revision: 7 } },
  });
  let downloads = 0;
  const coordinator = f.coordinator({
    client: {
      loadProfile: async () => profile,
      isPaired: async () => true,
      downloadCheckpoint: async () => {
        downloads += 1;
        throw Object.assign(new Error('worker unreachable'), { code: 'ECONNRESET', retryable: true });
      },
      watchSession: async (_id, _after, { signal, onReconnect }) => {
        await onReconnect();
        await waitForAbort(signal).catch(() => {});
      },
    },
  });
  const events = collect(coordinator);
  await coordinator.start();
  await settle();
  assert.equal(downloads, 1);

  for (const [waitMs, attempts] of [[1_000, 2], [2_000, 3], [4_000, 4], [8_000, 5]]) {
    t.mock.timers.tick(waitMs - 1);
    await settle();
    assert.equal(downloads, attempts - 1, `no retry before ${waitMs} ms`);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(downloads, attempts);
  }
  assert.equal(events.filter((event) => event.type === 'turn-autosync-error').length, 5);
  t.mock.timers.reset();
});

test('a finished handoff drops a boundary whose checkpoint the server already purged', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  const record = await f.handoff({
    state: 'downloaded',
    patch: { pendingTurnBoundary: { operationId: 'op-turn-7', turnNumber: 2, revision: 7 } },
  });
  let downloads = 0;
  let streamSignal = null;
  const coordinator = f.coordinator({
    client: {
      loadProfile: async () => profile,
      isPaired: async () => true,
      downloadCheckpoint: async () => {
        downloads += 1;
        throw Object.assign(new Error('A stable checkpoint was not found'), { status: 404, code: 'CHECKPOINT_NOT_FOUND' });
      },
      watchSession: async (_id, _after, { signal, onReconnect }) => {
        streamSignal = signal;
        await onReconnect();
        await waitForAbort(signal).catch(() => {});
      },
    },
  });
  const abandoned = nextEvent(coordinator, 'artifact-sync-abandoned');
  await coordinator.start();
  await abandoned;

  assert.equal((await f.store.get(record.id)).pendingTurnBoundary, null);
  assert.equal(streamSignal.aborted, true, 'nothing is left to fetch, so the stream closes');
  t.mock.timers.tick(10 * 60_000);
  await settle();
  assert.equal(downloads, 1);
  t.mock.timers.reset();
});

test('quit stops waiting for a provisioning run that never finishes', { timeout: 5_000 }, async (t) => {
  const f = await fixture(t);
  let flushes = 0;
  const flush = f.store.flush.bind(f.store);
  f.store.flush = () => { flushes += 1; return flush(); };
  const installing = Promise.withResolvers();
  const coordinator = f.coordinator({
    stopTimeoutMs: 50,
    client: { loadProfile: async () => null },
    provisioner: { provision: () => { installing.resolve(); return new Promise(() => {}); } },
  });
  const events = collect(coordinator);
  void coordinator.provision({ profile: { host: 'cloud.tailnet.ts.net', sshUser: 'test', serverPublicKey: key } })
    .catch(() => {});
  await installing.promise;

  const before = performance.now();
  await coordinator.stop();
  assert.ok(performance.now() - before < 1_000);
  assert.equal(flushes, 1);
  assert.ok(events.find((event) => event.type === 'coordinator-stop-timeout')?.pending >= 1);
});

test('quit ends a pause-boundary poll instead of waiting out its five minutes', { timeout: 5_000 }, async (t) => {
  const f = await fixture(t);
  let polls = 0;
  const polling = Promise.withResolvers();
  const coordinator = f.coordinator({
    client: {
      loadProfile: async () => profile,
      session: async (id) => {
        polls += 1;
        if (polls >= 2) polling.resolve();
        return { id, status: 'running', stateVersion: 2 };
      },
      command: async (id) => ({ session: { id, status: 'running', stateVersion: 2, pauseRequested: true } }),
    },
  });
  const draft = assert.rejects(coordinator.prepareEditDraft({ sessionId: 'cloud-session-1' }), { code: 'COORDINATOR_STOPPED' });
  await polling.promise;

  const before = performance.now();
  await coordinator.stop();
  await draft;
  assert.ok(performance.now() - before < 1_000);
});

test('startup continues with an unreadable handoff store and reports it', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rauhwpx-unreadable-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let failing = true;
  const store = new CloudHandoffStore({
    filePath: path.join(directory, 'handoffs.json'),
    sleep: async () => {},
    readFile: async () => {
      if (failing) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
  });
  const coordinator = new CloudCoordinator({ client: { loadProfile: async () => null }, store });
  const events = collect(coordinator);
  // Cloud IPC waits on start(), so an unreadable store must not reject it.
  const snapshot = await coordinator.start();
  assert.ok(snapshot);
  assert.ok(events.some((event) => event.type === 'handoff-store-unreadable'));
  failing = false;
  await coordinator.snapshot();
  assert.deepEqual(await store.list(), [], 'the store loads once the read succeeds');
  await coordinator.stop();
});
