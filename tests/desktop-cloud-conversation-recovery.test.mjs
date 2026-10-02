import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CloudConversationRecovery,
  validateConversationSnapshot,
} from '../desktop/cloud-conversation-recovery.mjs';
import { CloudCoordinator } from '../desktop/cloud-coordinator.mjs';
import { CloudHandoffStore, sha256Hex } from '../desktop/cloud-handoff.mjs';
import { normalizeCloudProfile } from '../desktop/cloud-profile.mjs';

const SERVER_IDENTITY = generateKeyPairSync('ed25519');
const SERVER_KEY = `ed25519:${SERVER_IDENTITY.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')}`;

function snapshot(overrides = {}) {
  return {
    id: `merge_${'a'.repeat(64)}`,
    sessionId: 'cloud-session',
    documentId: 'document-1',
    threadId: 'thread-1',
    cloudStartId: 'cloud-start-1',
    revision: 3,
    turn: 1,
    createdAt: Date.parse('2026-09-08T01:00:00.000Z'),
    expiresAt: Date.parse('2026-10-08T01:00:00.000Z'),
    sha256: 'b'.repeat(64),
    size: 4096,
    state: 'running',
    pendingWork: true,
    ...overrides,
  };
}

async function handoffFixture(t, { state = 'running' } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cloud-conversation-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') });
  const created = await store.create({
    sessionId: 'local-session',
    threadId: 'thread-1',
    documentId: 'document-1',
    documentName: 'source.hwpx',
    documentBytes: Buffer.from('document'),
    timeline: { thread: { cloudStartId: 'cloud-start-1' } },
    provider: 'claude',
    limits: { maxTurns: 100 },
  });
  await store.transition(created.id, 'uploading');
  await store.transition(created.id, 'committing');
  await store.transition(created.id, state, {
    cloudSessionId: 'cloud-session',
    handoffAcceptedAt: '2026-09-08T00:59:00.000Z',
  });
  return { directory, store, created };
}

test('conversation descriptors normalize broker timestamps and reject oversized or unbound values', () => {
  assert.deepEqual(validateConversationSnapshot(snapshot()).createdAt, '2026-09-08T01:00:00.000Z');
  for (const patch of [
    { size: 128 * 1024 * 1024 + 1 },
    { sha256: 'bad' },
    { sessionId: '../other' },
    { expiresAt: 0 },
    { pendingWork: undefined },
  ]) assert.throws(() => validateConversationSnapshot(snapshot(patch)), /invalid/);
});

test('broker conversation discovery is account fenced and bound to the local handoff identity', async (t) => {
  const { store } = await handoffFixture(t);
  let identity = 'account-credential-1';
  let response = { accountId: 'account-1', conversations: [snapshot()] };
  const recovery = new CloudConversationRecovery({
    store,
    provider: () => ({
      getLocalCacheIdentity: async () => identity,
      listConversations: async () => response,
    }),
  });
  assert.equal((await recovery.refresh()).length, 1);
  response = { accountId: 'account-1', conversations: [snapshot({ documentId: 'other-document' })] };
  assert.equal((await recovery.refresh()).length, 0);
  const gate = Promise.withResolvers();
  const pending = new CloudConversationRecovery({
    store,
    provider: () => ({
      getLocalCacheIdentity: async () => identity,
      listConversations: async () => gate.promise,
    }),
  }).refresh();
  identity = 'account-credential-2';
  gate.resolve({ accountId: 'account-1', conversations: [snapshot()] });
  await assert.rejects(pending, { name: 'AbortError' });
});

test('saved Railway chat is verified and shown from broker before the worker resumes', async (t) => {
  const { directory, store, created } = await handoffFixture(t);
  const timeline = { thread: { id: 'thread-1', cloudStartId: 'cloud-start-1' },
    messages: [{ id: 'saved-message', text: 'Saved while the worker was running' }] };
  const timelineBytes = Buffer.from(JSON.stringify(timeline));
  const timelineDigest = sha256Hex(timelineBytes);
  const resource = { id: 'resource-1', sha256: timelineDigest, size: timelineBytes.length };
  const archived = Buffer.from(JSON.stringify({
    version: 1,
    session: { id: 'cloud-session', client_document_id: 'document-1', client_thread_id: 'thread-1' },
    rows: { session_resources: [{ session_id: 'cloud-session', kind: 'timeline',
      sha256: timelineDigest, size: timelineBytes.length }] },
    blobs: [resource],
  }));
  const descriptor = snapshot({ sha256: sha256Hex(archived), size: archived.length });
  let downloads = 0;
  const provider = {
    getLocalCacheIdentity: async () => 'account-credential-1',
    listConversations: async () => ({ accountId: 'account-1', conversations: [descriptor] }),
    downloadConversationChunk: async (_id, _index, { resource: isResource }) => {
      downloads += 1;
      return { bytesBase64: (isResource ? timelineBytes : archived).toString('base64') };
    },
  };
  const recovery = new CloudConversationRecovery({ store, recoveryDir: path.join(directory, 'recovery'),
    provider: () => provider });
  await recovery.refresh();
  assert.deepEqual(await recovery.prefetchTimelines(), { attempted: 1, downloaded: 1, failures: [] });
  assert.deepEqual((await store.get(created.id)).timeline, timeline);
  assert.equal(downloads, 2);
  provider.downloadConversationChunk = async () => { throw new Error('worker and broker unavailable'); };
  const reopened = new CloudConversationRecovery({ store: new CloudHandoffStore({ filePath: path.join(directory, 'handoffs.json') }),
    recoveryDir: path.join(directory, 'recovery'), provider: () => provider });
  await reopened.refresh();
  assert.deepEqual(await reopened.prefetchTimelines(), { attempted: 0, downloaded: 0, failures: [] });
});

test('one prefetch drains older saved chats after newer unmatched and cached entries', async (t) => {
  const { directory, store } = await handoffFixture(t);
  const bytesById = new Map();
  const descriptors = [];
  for (let index = 0; index < 10; index += 1) {
    const sessionId = index === 0 ? 'cloud-session' : `cloud-session-${index}`;
    const documentId = index === 0 ? 'document-1' : `document-${index}`;
    const threadId = index === 0 ? 'thread-1' : `thread-${index}`;
    const cloudStartId = index === 0 ? 'cloud-start-1' : `cloud-start-${index}`;
    if (index > 0) {
      const record = await store.create({
        sessionId: `local-session-${index}`, threadId, documentId,
        documentName: `${documentId}.hwpx`, documentBytes: Buffer.from('document'),
        timeline: { thread: { cloudStartId } }, provider: 'claude', limits: { maxTurns: 100 },
      });
      await store.transition(record.id, 'uploading');
      await store.transition(record.id, 'committing');
      await store.transition(record.id, 'running', { cloudSessionId: sessionId });
    }
    const timeline = Buffer.from(JSON.stringify({ thread: { cloudStartId }, messages: [{ id: `saved-${index}` }] }));
    const digest = sha256Hex(timeline);
    const resourceId = `resource-${index}`;
    bytesById.set(resourceId, timeline);
    const archived = Buffer.from(JSON.stringify({
      version: 1,
      session: { id: sessionId, client_document_id: documentId, client_thread_id: threadId },
      rows: { session_resources: [{ session_id: sessionId, kind: 'timeline', sha256: digest, size: timeline.length }] },
      blobs: [{ id: resourceId, sha256: digest, size: timeline.length }],
    }));
    const descriptorId = `snapshot-${index}`;
    bytesById.set(descriptorId, archived);
    descriptors.push(snapshot({ id: descriptorId, sessionId, documentId, threadId, cloudStartId,
      createdAt: Date.parse(`2026-09-${String(index + 1).padStart(2, '0')}T01:00:00.000Z`),
      sha256: sha256Hex(archived), size: archived.length }));
  }
  descriptors.push(snapshot({ id: 'snapshot-unmatched', sessionId: 'other-session',
    documentId: 'other-document', createdAt: Date.parse('2026-09-20T01:00:00.000Z') }));
  const downloaded = [];
  const provider = {
    getLocalCacheIdentity: async () => 'account-credential-1',
    listConversations: async () => ({ accountId: 'account-1', conversations: descriptors }),
    downloadConversationChunk: async (id, _index, { resource }) => {
      if (!resource) downloaded.push(id);
      return { bytesBase64: bytesById.get(id).toString('base64') };
    },
  };
  const recovery = new CloudConversationRecovery({ store, recoveryDir: path.join(directory, 'recovery'),
    provider: () => provider });
  await recovery.refresh();
  assert.deepEqual(await recovery.prefetchTimelines(), { attempted: 10, downloaded: 10, failures: [] });
  assert.equal(downloaded.includes('snapshot-0'), true);
  assert.equal(downloaded.includes('snapshot-unmatched'), false);
  assert.deepEqual(await recovery.prefetchTimelines(), { attempted: 0, downloaded: 0, failures: [] });
});

test('an account change during chat download cannot replace the local timeline', async (t) => {
  const { directory, store, created } = await handoffFixture(t);
  let identity = 'account-credential-1';
  const archived = Buffer.from(JSON.stringify({ version: 1 }));
  const recovery = new CloudConversationRecovery({ store, recoveryDir: path.join(directory, 'recovery'),
    provider: () => ({
      getLocalCacheIdentity: async () => identity,
      listConversations: async () => ({ accountId: 'account-1', conversations: [snapshot({
        sha256: sha256Hex(archived), size: archived.length,
      })] }),
      downloadConversationChunk: async () => {
        identity = 'account-credential-2';
        return { bytesBase64: archived.toString('base64') };
      },
    }) });
  await recovery.refresh();
  await assert.rejects(recovery.prefetchTimelines(), { name: 'AbortError' });
  assert.deepEqual((await store.get(created.id)).timeline, { thread: { cloudStartId: 'cloud-start-1' } });
});

test('refresh restores a missing known session after provider auth is seeded and keeps its event cursor', async (t) => {
  const { directory, store, created } = await handoffFixture(t);
  await store.patch(created.id, { lastEventSequence: 17 });
  const profile = normalizeCloudProfile({
    mode: 'app-hosted',
    endpoint: 'https://replacement.example/rauhwpx-cloud',
    serverPublicKey: SERVER_KEY,
    sandbox: { providerId: 'raucloud', sandboxId: 'run-2', host: 'replacement.example' },
    provider: 'claude',
  });
  const restoredSession = {
    id: 'cloud-session', status: 'suspended', stateVersion: 9, provider: 'claude',
    suspendedReason: { code: 'WORKER_REPLACED_UNCERTAIN', message: 'Confirm before resuming.' },
    clientContext: { documentId: 'document-1', threadId: 'thread-1' },
    originDocument: { name: 'source.hwpx' },
  };
  let restored = false;
  const calls = [];
  const provider = {
    id: 'raucloud', displayName: 'Raucloud', configuration: () => ({ configured: true }),
    spawn() {}, status: async () => ({ lifecycle: 'ready' }), teardown() {},
    accountStatus: async () => ({ signedIn: true }),
    getLocalCacheIdentity: async () => 'account-credential-1',
    listConversations: async () => ({ accountId: 'account-1', conversations: [snapshot()] }),
  };
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => profile,
      isPaired: async () => true,
      deviceId: async () => 'device-1',
      health: async () => ({ ok: true, serverPublicKey: SERVER_KEY, capabilities: { conversationRestore: true } }),
      sessions: async () => restored ? [restoredSession] : [],
      seedProviderCredentials: async (auth) => { calls.push(['seed', auth.provider]); },
      restoreSession: async (sessionId) => {
        calls.push(['restore', sessionId]);
        restored = true;
        return { session: restoredSession, restored: true, sourceEventSeq: 12, restoredEventSeq: 13 };
      },
      watchSession: async (_id, _after, { signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true });
      }),
    },
    store,
    recoveryDir: path.join(directory, 'recovery'),
    appServers: [provider],
    collectProviderAuth: async () => ({ provider: 'claude', apiKey: 'secret', files: [] }),
  });
  t.after(() => coordinator.stop());
  const result = await coordinator.refresh({ documentId: 'document-1' });
  assert.deepEqual(calls, [['seed', 'claude'], ['restore', 'cloud-session']]);
  assert.equal(result.session.kind, 'suspended');
  assert.equal(result.session.handoffAcceptedAt, '2026-09-08T00:59:00.000Z');
  const record = await store.get(created.id);
  assert.equal(record.lastEventSequence, 12);
  assert.equal(record.destination.endpoint, profile.endpoint);
  assert.equal(record.suspendedCode, 'WORKER_REPLACED_UNCERTAIN');
});

test('confirmed idle Railway worker shows saved conversation and waits for explicit Resume', async (t) => {
  const { directory, store, created } = await handoffFixture(t, { state: 'queued' });
  const profile = normalizeCloudProfile({
    mode: 'app-hosted', endpoint: 'https://gone.example/rauhwpx-cloud', serverPublicKey: SERVER_KEY,
    sandbox: { providerId: 'raucloud', sandboxId: 'run-gone', host: 'gone.example' }, provider: 'claude',
  });
  const provider = {
    id: 'raucloud', displayName: 'Raucloud', configuration: () => ({ configured: true }),
    spawn() {}, status: async () => ({ lifecycle: 'idle' }), teardown() {},
    accountStatus: async () => ({ signedIn: true }),
    getLocalCacheIdentity: async () => 'account-credential-1',
    listConversations: async () => ({ accountId: 'account-1', conversations: [snapshot({ state: 'queued' })] }),
  };
  await store.patch(created.id, {
    destination: {
      endpoint: profile.endpoint,
      serverPublicKey: profile.serverPublicKey,
      mode: 'app-hosted',
      sandboxId: profile.sandbox.sandboxId,
      sandboxProvider: profile.sandbox.providerId,
      protocolVersion: 2,
      runtimeVersion: null,
    },
  });
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => profile, isPaired: async () => false,
      putProviderAuth: async (provider, auth) => {
        calls.push({ provider, imported: Boolean(auth.secrets?.ANTHROPIC_API_KEY) });
        return { imported: true };
      },
      command: async (_sessionId, type, body) => {
        calls.push({ type, expectedVersion: body.expectedVersion });
        return { session: { id: 'cloud-session', status: 'queued', stateVersion: 7 } };
      },
    }, store, recoveryDir: path.join(directory, 'recovery'),
    appServers: [provider],
    collectImportedAuth: async () => ({ secrets: { ANTHROPIC_API_KEY: 'saved-login' }, files: {} }),
  });
  t.after(() => coordinator.stop());
  const calls = [];
  coordinator.spawnAppServer = async (options) => {
    calls.push(options);
    await store.patch(created.id, { serverVersion: 9 });
    return { restored: true };
  };
  const [first, second] = await Promise.all([
    coordinator.reconcileContinuity({ reason: 'resume' }),
    coordinator.reconcileContinuity({ reason: 'online' }),
  ]);
  assert.equal(first.session.kind, 'suspended');
  assert.equal(second.session.kind, 'suspended');
  assert.equal(first.session.code, 'WORKER_REPLACED_UNCERTAIN');
  assert.equal(first.session.lastSavedAt, '2026-09-08T01:00:00.000Z');
  assert.deepEqual(calls, []);
  await coordinator.command({ sessionId: 'cloud-session', command: 'resume', expectedVersion: first.session.version });
  assert.deepEqual(calls, [
    { selectedProvider: 'claude' },
    { provider: 'claude', imported: true },
    { type: 'session.resume', expectedVersion: 9 },
  ]);
});

test('resuming a saved USER_PAUSED session seeds login when Railway starts a replacement worker', async (t) => {
  const { directory, store, created } = await handoffFixture(t);
  await store.transition(created.id, 'suspended', { suspendedCode: 'USER_PAUSED' });
  const profile = normalizeCloudProfile({
    mode: 'app-hosted', endpoint: 'https://gone.example/rauhwpx-cloud', serverPublicKey: SERVER_KEY,
    sandbox: { providerId: 'raucloud', sandboxId: 'run-gone', host: 'gone.example' }, provider: 'claude',
  });
  await store.patch(created.id, {
    serverVersion: 5,
    destination: { endpoint: profile.endpoint, serverPublicKey: profile.serverPublicKey,
      mode: 'app-hosted', sandboxId: profile.sandbox.sandboxId,
      sandboxProvider: profile.sandbox.providerId, protocolVersion: 2, runtimeVersion: null },
  });
  const calls = [];
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => profile,
      isPaired: async () => false,
      putProviderAuth: async (provider, auth) => {
        calls.push({ provider, imported: Boolean(auth.secrets?.ANTHROPIC_API_KEY) });
        return { imported: true };
      },
      command: async (_sessionId, type, body) => {
        calls.push({ type, expectedVersion: body.expectedVersion });
        return { session: { id: 'cloud-session', status: 'queued', stateVersion: 12 } };
      },
    }, store, recoveryDir: path.join(directory, 'recovery'),
    appServers: [{ id: 'raucloud', displayName: 'Raucloud', configuration: () => ({ configured: true }),
      status: async () => ({ lifecycle: 'idle' }), spawn() {}, teardown() {},
      accountStatus: async () => ({ signedIn: true }),
      getLocalCacheIdentity: async () => 'account-credential-1',
      listConversations: async () => ({ accountId: 'account-1',
        conversations: [snapshot({ state: 'suspended' })] }) }],
    collectImportedAuth: async () => ({ secrets: { ANTHROPIC_API_KEY: 'saved-login' }, files: {} }),
  });
  t.after(() => coordinator.stop());
  coordinator.spawnAppServer = async () => {
    calls.push({ restored: true });
    await store.patch(created.id, { serverVersion: 12 });
  };
  const recovered = await coordinator.reconcileContinuity({ reason: 'online' });
  assert.equal(recovered.session.kind, 'suspended');
  assert.equal(recovered.session.code, 'WORKER_REPLACED_UNCERTAIN');
  assert.equal(recovered.session.lastSavedAt, '2026-09-08T01:00:00.000Z');
  assert.equal((await store.get(created.id)).serverVersion, 5);
  assert.deepEqual(calls, []);
  await coordinator.command({ sessionId: 'cloud-session', command: 'resume', expectedVersion: 2 });
  assert.deepEqual(calls, [
    { restored: true },
    { provider: 'claude', imported: true },
    { type: 'session.resume', expectedVersion: 12 },
  ]);
});

test('Resume against an existing Railway worker keeps the caller version check', async (t) => {
  const { directory, store, created } = await handoffFixture(t);
  await store.transition(created.id, 'suspended');
  const profile = normalizeCloudProfile({
    mode: 'app-hosted', endpoint: 'https://worker.example/rauhwpx-cloud', serverPublicKey: SERVER_KEY,
    sandbox: { providerId: 'raucloud', sandboxId: 'run-ready', host: 'worker.example' }, provider: 'claude',
  });
  await store.patch(created.id, {
    suspendedCode: 'USER_PAUSED',
    destination: { endpoint: profile.endpoint, serverPublicKey: profile.serverPublicKey,
      mode: 'app-hosted', sandboxId: profile.sandbox.sandboxId,
      sandboxProvider: profile.sandbox.providerId, protocolVersion: 2, runtimeVersion: null },
  });
  let receivedVersion;
  const coordinator = new CloudCoordinator({
    client: { loadProfile: async () => profile, isPaired: async () => true,
      command: async (_sessionId, _type, body) => {
        receivedVersion = body.expectedVersion;
        throw Object.assign(new Error('stale version'), { code: 'VERSION_CONFLICT', status: 409 });
      } },
    store, recoveryDir: path.join(directory, 'recovery'),
    appServers: [{ id: 'raucloud', displayName: 'Raucloud', configuration: () => ({ configured: true }),
      spawn() {}, teardown() {}, status: async () => ({ lifecycle: 'ready' }),
      accountStatus: async () => ({ signedIn: true }) }],
  });
  t.after(() => coordinator.stop());
  await assert.rejects(coordinator.command({ sessionId: 'cloud-session', command: 'resume',
    expectedVersion: 1 }), { code: 'VERSION_CONFLICT' });
  assert.equal(receivedVersion, 1);
});

test('background continuity leaves idle and ended conversations cold', async (t) => {
  for (const descriptor of [
    snapshot({ pendingWork: false }),
    snapshot({ state: 'completed', pendingWork: false }),
  ]) {
    const { directory, store, created } = await handoffFixture(t);
    const profile = normalizeCloudProfile({
      mode: 'app-hosted', endpoint: 'https://gone.example/rauhwpx-cloud', serverPublicKey: SERVER_KEY,
      sandbox: { providerId: 'raucloud', sandboxId: 'run-gone', host: 'gone.example' }, provider: 'claude',
    });
    await store.patch(created.id, {
      destination: {
        endpoint: profile.endpoint, serverPublicKey: profile.serverPublicKey, mode: 'app-hosted',
        sandboxId: profile.sandbox.sandboxId, sandboxProvider: profile.sandbox.providerId,
        protocolVersion: 2, runtimeVersion: null,
      },
    });
    const provider = {
      id: 'raucloud', displayName: 'Raucloud', configuration: () => ({ configured: true }),
      spawn() {}, teardown() {},
      status: async () => ({ lifecycle: 'idle' }), accountStatus: async () => ({ signedIn: true }),
      getLocalCacheIdentity: async () => 'account-credential-1',
      listConversations: async () => ({ accountId: 'account-1', conversations: [descriptor] }),
    };
    const coordinator = new CloudCoordinator({
      client: { loadProfile: async () => profile, isPaired: async () => false },
      store, recoveryDir: path.join(directory, 'recovery'),
      appServers: [provider],
    });
    t.after(() => coordinator.stop());
    coordinator.spawnAppServer = async () => assert.fail('idle history must not allocate a worker');
    const result = await coordinator.reconcileContinuity({ reason: 'wake' });
    assert.equal(result.session.kind, descriptor.state === 'completed' ? 'running' : 'suspended');
  }
});

test('explicit follow-up restores an idle conversation before uploading attachments', async (t) => {
  const { directory, store, created } = await handoffFixture(t);
  const profile = normalizeCloudProfile({
    mode: 'app-hosted', endpoint: 'https://gone.example/rauhwpx-cloud', serverPublicKey: SERVER_KEY,
    sandbox: { providerId: 'raucloud', sandboxId: 'run-gone', host: 'gone.example' }, provider: 'claude',
  });
  await store.patch(created.id, {
    destination: {
      endpoint: profile.endpoint, serverPublicKey: profile.serverPublicKey, mode: 'app-hosted',
      sandboxId: profile.sandbox.sandboxId, sandboxProvider: profile.sandbox.providerId,
      protocolVersion: 2, runtimeVersion: null,
    },
  });
  const order = [];
  const provider = {
    id: 'raucloud', displayName: 'Raucloud', configuration: () => ({ configured: true }),
    spawn() {}, teardown() {},
    status: async () => ({ lifecycle: 'idle' }), accountStatus: async () => ({ signedIn: true }),
    getLocalCacheIdentity: async () => 'account-credential-1',
    listConversations: async () => ({
      accountId: 'account-1', conversations: [snapshot({ pendingWork: false })],
    }),
  };
  const coordinator = new CloudCoordinator({
    client: {
      loadProfile: async () => profile,
      isPaired: async () => false,
      uploadBlob: async ({ bytes }) => { order.push('upload'); return { blobId: 'blob-new', size: bytes.length }; },
      command: async () => { order.push('command'); return { messageId: 'message-1', status: 'queued' }; },
    },
    store, recoveryDir: path.join(directory, 'recovery'), appServers: [provider],
  });
  t.after(() => coordinator.stop());
  coordinator.spawnAppServer = async () => { order.push('spawn'); return {}; };
  await coordinator.command({
    sessionId: 'cloud-session', command: 'queue-message', message: 'Use the attachment', messageId: 'message-1',
    attachments: [{ id: 'attachment-1', name: 'note.txt', mimeType: 'text/plain', size: 4, bytes: Buffer.from('note') }],
  });
  assert.deepEqual(order, ['spawn', 'upload', 'command']);
});
