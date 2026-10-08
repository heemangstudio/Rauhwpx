import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { sha256Hex, writeVerifiedRecoveryFile } from './cloud-handoff.mjs';

const MAX_CONVERSATIONS = 1024;
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const CHUNK_BYTES = 512 * 1024;
const RESTORABLE_STATES = new Set(['staged', 'queued', 'running', 'suspended']);
const identifier = (value, limit = 160) => (
  typeof value === 'string'
  && value.length >= 1
  && value.length <= limit
  && /^[A-Za-z0-9._:-]+$/.test(value)
);

export function validateConversationSnapshot(value) {
  const createdAt = typeof value?.createdAt === 'string'
    ? value.createdAt
    : Number.isFinite(Number(value?.createdAt)) && Number(value.createdAt) > 0
      ? new Date(Number(value.createdAt)).toISOString()
      : '';
  const expiresAt = typeof value?.expiresAt === 'string'
    ? value.expiresAt
    : Number.isFinite(Number(value?.expiresAt)) && Number(value.expiresAt) > 0
      ? new Date(Number(value.expiresAt)).toISOString()
      : '';
  if (!value || typeof value !== 'object'
    || !identifier(value.id)
    || !identifier(value.sessionId, 128)
    || !identifier(value.documentId, 256)
    || !identifier(value.threadId, 256)
    || !identifier(value.cloudStartId)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isSafeInteger(value.turn) || value.turn < 0
    || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_SNAPSHOT_BYTES
    || typeof value.pendingWork !== 'boolean'
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !Number.isFinite(Date.parse(createdAt))
    || !Number.isFinite(Date.parse(expiresAt))) {
    throw new Error('Cloud conversation snapshot is invalid');
  }
  return { ...Object.fromEntries([
    'id', 'sessionId', 'documentId', 'threadId', 'cloudStartId', 'revision', 'turn',
    'sha256', 'size', 'state', 'pendingWork',
  ].filter((key) => value[key] !== undefined).map((key) => [key, value[key]])), createdAt, expiresAt };
}

export function conversationSnapshotRestorable(snapshot) {
  return RESTORABLE_STATES.has(String(snapshot?.state ?? '').toLowerCase());
}

/** Account-fenced broker discovery for conversations that can be restored to a replacement worker. */
export class CloudConversationRecovery {
  constructor({ store, provider, recoveryDir = null }) {
    this.store = store;
    this.provider = provider;
    this.directory = recoveryDir ? path.join(recoveryDir, 'durable-conversations') : null;
    this.conversations = [];
    this.accountId = null;
    this.generation = 0;
    this.inflight = null;
    this.prefetchInflight = null;
    this.prefetchController = null;
  }

  reset() {
    this.generation += 1;
    this.prefetchController?.abort(new DOMException('Cloud account changed', 'AbortError'));
    this.conversations = [];
    this.accountId = null;
    this.inflight = null;
    this.prefetchInflight = null;
    this.prefetchController = null;
  }

  async refresh({ sessionId = null, assertCurrent = () => {} } = {}) {
    if (this.inflight) return this.inflight;
    const provider = this.provider();
    if (!provider?.listConversations) {
      this.conversations = [];
      return [];
    }
    const generation = this.generation;
    const cacheIdentity = await provider.getLocalCacheIdentity?.();
    const check = async () => {
      assertCurrent();
      if (generation !== this.generation) throw new DOMException('Cloud account changed', 'AbortError');
      if (provider.getLocalCacheIdentity
        && (!cacheIdentity || cacheIdentity !== await provider.getLocalCacheIdentity())) {
        throw new DOMException('Cloud account changed', 'AbortError');
      }
    };
    const task = (async () => {
      const result = await provider.listConversations({ ...(sessionId ? { sessionId } : {}) });
      await check();
      if (!identifier(result?.accountId) || !Array.isArray(result.conversations)
        || result.conversations.length > MAX_CONVERSATIONS) {
        throw new Error('Cloud conversation inbox is invalid');
      }
      const records = await this.store.list();
      await check();
      const incoming = result.conversations.map(validateConversationSnapshot);
      this.conversations = incoming.filter((conversation) => records.some((record) => (
        record.cloudSessionId === conversation.sessionId
        && record.originDocumentId === conversation.documentId
        && record.threadId === conversation.threadId
        && (!record.timeline?.thread?.cloudStartId
          || record.timeline.thread.cloudStartId === conversation.cloudStartId)
      )));
      this.accountId = result.accountId;
      return this.conversations;
    })().catch((error) => {
      if (generation === this.generation && (error.status === 401 || error.status === 403
        || /AUTH_REQUIRED|ACCOUNT_SESSION/.test(error.code ?? ''))) this.reset();
      throw error;
    }).finally(() => {
      if (this.inflight === task) this.inflight = null;
    });
    this.inflight = task;
    return task;
  }

  async #downloadBytes(receipt, { resource, signal, check }) {
    if (!identifier(receipt?.id) || !Number.isSafeInteger(receipt.size)
      || receipt.size < 1 || receipt.size > MAX_SNAPSHOT_BYTES
      || !/^[a-f0-9]{64}$/.test(receipt.sha256)
      || !this.provider()?.downloadConversationChunk) throw new Error('Cloud conversation resource is invalid');
    const bytes = Buffer.alloc(receipt.size);
    for (let index = 0; index < Math.ceil(receipt.size / CHUNK_BYTES); index += 1) {
      signal?.throwIfAborted();
      const result = await this.provider().downloadConversationChunk(receipt.id, index, { resource, signal });
      await check();
      const expected = Math.min(CHUNK_BYTES, receipt.size - index * CHUNK_BYTES);
      const encoded = result?.bytesBase64;
      if (typeof encoded !== 'string' || encoded.length !== 4 * Math.ceil(expected / 3)
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Cloud conversation chunk is invalid');
      const chunk = Buffer.from(encoded, 'base64');
      if (chunk.length !== expected || chunk.toString('base64') !== encoded) {
        throw new Error('Cloud conversation chunk size is invalid');
      }
      chunk.copy(bytes, index * CHUNK_BYTES);
    }
    if (sha256Hex(bytes) !== receipt.sha256) throw new Error('Cloud conversation digest does not match');
    return bytes;
  }

  prefetchTimelines({ assertCurrent = () => {}, onDownloaded = () => {}, onFailure = () => {} } = {}) {
    if (this.prefetchInflight) return this.prefetchInflight;
    if (!this.directory || !this.provider()?.downloadConversationChunk) return Promise.resolve({ attempted: 0, downloaded: 0, failures: [] });
    const generation = this.generation;
    const accountId = this.accountId;
    const controller = new AbortController();
    this.prefetchController = controller;
    const task = (async () => {
      const provider = this.provider();
      const cacheIdentity = await provider.getLocalCacheIdentity?.();
      const check = async (snapshotId = null) => {
        assertCurrent();
        controller.signal.throwIfAborted();
        if (generation !== this.generation || accountId !== this.accountId
          || snapshotId && !this.conversations.some((entry) => entry.id === snapshotId)
          || provider.getLocalCacheIdentity && (!cacheIdentity
            || cacheIdentity !== await provider.getLocalCacheIdentity())) {
          throw new DOMException('Cloud account changed', 'AbortError');
        }
      };
      const records = await this.store.list();
      await check();
      let attempted = 0;
      let downloaded = 0;
      const failures = [];
      const latest = [...this.conversations]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      for (const descriptor of latest) {
        const record = records.find((entry) => entry.cloudSessionId === descriptor.sessionId
          && entry.originDocumentId === descriptor.documentId && entry.threadId === descriptor.threadId);
        if (!record) continue;
        const cached = record.conversationTimelineArchive;
        if (cached?.snapshotId === descriptor.id && cached?.accountId === accountId
          && cached?.cacheIdentity === cacheIdentity && cached.path && cached.sha256) {
          const bytes = await readFile(cached.path).catch(() => null);
          if (bytes && sha256Hex(bytes) === cached.sha256) continue;
        }
        attempted += 1;
        try {
          const snapshotBytes = await this.#downloadBytes(descriptor, {
            resource: false, signal: controller.signal, check: () => check(descriptor.id),
          });
          const snapshot = JSON.parse(snapshotBytes.toString('utf8'));
          if (snapshot?.version !== 1 || snapshot.session?.id !== descriptor.sessionId
            || snapshot.session?.client_document_id !== descriptor.documentId
            || snapshot.session?.client_thread_id !== descriptor.threadId
            || !Array.isArray(snapshot.rows?.session_resources) || !Array.isArray(snapshot.blobs)) {
            throw new Error('Cloud conversation identity does not match');
          }
          const savedEventSequence = Number(snapshot.session.next_event_seq) - 1;
          if (Number.isSafeInteger(savedEventSequence)
            && savedEventSequence < Number(record.lastEventSequence ?? 0)) continue;
          const timelineResource = snapshot.rows.session_resources.find((entry) => (
            entry.session_id === descriptor.sessionId && entry.kind === 'timeline'
          ));
          const resourceReceipt = snapshot.blobs.find((entry) => entry.sha256 === timelineResource?.sha256
            && entry.size === timelineResource?.size);
          if (!resourceReceipt) throw new Error('Cloud conversation timeline is missing');
          const timelineBytes = await this.#downloadBytes(resourceReceipt, {
            resource: true, signal: controller.signal, check: () => check(descriptor.id),
          });
          const timeline = JSON.parse(timelineBytes.toString('utf8'));
          if (timeline?.thread?.cloudStartId !== descriptor.cloudStartId) {
            throw new Error('Cloud conversation timeline identity does not match');
          }
          const filePath = path.join(this.directory,
            sha256Hex(Buffer.from(`${accountId}:${descriptor.id}:${resourceReceipt.sha256}`)), 'timeline.json');
          await writeVerifiedRecoveryFile({ filePath, bytes: timelineBytes,
            expectedDigest: resourceReceipt.sha256 });
          await check(descriptor.id);
          let applied = false;
          await this.store.patch(record.id, (latest) => {
            if (generation !== this.generation || accountId !== this.accountId) {
              throw new DOMException('Cloud account changed', 'AbortError');
            }
            if (latest.cloudSessionId !== descriptor.sessionId
              || latest.originDocumentId !== descriptor.documentId || latest.threadId !== descriptor.threadId) {
              throw new DOMException('Cloud conversation changed', 'AbortError');
            }
            if ((latest.timelineDigest !== record.timelineDigest
                && latest.timelineDigest !== resourceReceipt.sha256)
              || (Number.isSafeInteger(savedEventSequence)
                && savedEventSequence < Number(latest.lastEventSequence ?? 0))) return {};
            applied = true;
            return { timeline, timelineDigest: resourceReceipt.sha256, timelineSize: timelineBytes.length,
              timelineRecoveryPath: filePath,
              conversationTimelineArchive: {
                snapshotId: descriptor.id, accountId, cacheIdentity, path: filePath,
                sha256: resourceReceipt.sha256, size: timelineBytes.length,
              } };
          });
          await check(descriptor.id);
          if (!applied) continue;
          downloaded += 1;
          onDownloaded(descriptor);
        } catch (error) {
          await check();
          failures.push({ sessionId: descriptor.sessionId, error });
          onFailure(descriptor, error);
        }
      }
      return { attempted, downloaded, failures };
    })().finally(() => {
      if (this.prefetchInflight === task) this.prefetchInflight = null;
      if (this.prefetchController === controller) this.prefetchController = null;
    });
    this.prefetchInflight = task;
    return task;
  }
}
