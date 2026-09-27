import assert from 'node:assert/strict';
import test from 'node:test';

import { createCheckpointMirror } from '../src/cloud/checkpoint-mirror.ts';
import { isTerminalCheckpointError } from '../src/cloud/desktop-cloud.ts';
import type { CloudCheckpointPayload } from '../src/cloud/types.ts';

const checkpoint: CloudCheckpointPayload = {
  sessionId: 'session-a',
  documentId: 'document-a',
  kind: 'turn',
  fileName: 'document.hwpx',
  bytes: new Uint8Array([1]),
  byteLength: 1,
  sha256: 'a'.repeat(64),
  revision: 2,
  turn: 1,
  operationId: 'operation-a',
};

test('failed checkpoint application retries autonomously and applies the boundary exactly once', async () => {
  let downloads = 0;
  let applications = 0;
  const mirror = createCheckpointMirror({
    download: async () => {
      downloads += 1;
      return checkpoint;
    },
    apply: async () => {
      applications += 1;
      if (applications === 1) throw new Error('disk unavailable');
    },
    retryBaseMs: 1,
    retryMaxMs: 2,
  });

  const first = mirror.mirror('session-a', 'operation-a');
  assert.equal(mirror.mirror('session-a', 'operation-a'), first);
  await first;
  await mirror.mirror('session-a', 'operation-a');

  assert.equal(downloads, 2);
  assert.equal(applications, 2);
});

test('a rejected operation does not poison a later boundary in the same session', async () => {
  const applications: string[] = [];
  let failedA = false;
  const mirror = createCheckpointMirror({
    download: async (_sessionId, operationId) => ({
      ...checkpoint,
      operationId: operationId ?? 'reconnect',
      revision: operationId === 'operation-b' ? 3 : 2,
    }),
    apply: async (value) => {
      if (value.operationId === 'operation-a' && !failedA) {
        failedA = true;
        throw new Error('A failed');
      }
      applications.push(value.operationId);
    },
    retryBaseMs: 20,
    retryMaxMs: 20,
  });

  const operationA = mirror.mirror('session-a', 'operation-a');
  await new Promise((resolve) => setTimeout(resolve, 1));
  const operationB = mirror.mirror('session-a', 'operation-b');
  await operationB;
  mirror.mirror('session-a', 'operation-a');
  await operationA;

  assert.deepEqual(applications, ['operation-b']);
});

test('changing pinned servers invalidates in-flight and completed mirror state', async () => {
  const firstDownload = Promise.withResolvers<CloudCheckpointPayload>();
  let downloads = 0;
  const applied: string[] = [];
  const mirror = createCheckpointMirror({
    download: async () => {
      downloads += 1;
      return downloads === 1
        ? firstDownload.promise
        : { ...checkpoint, documentId: 'document-b', revision: 1 };
    },
    apply: async (value) => { applied.push(value.documentId ?? 'archive-only'); },
    retryBaseMs: 1,
    retryMaxMs: 1,
  });

  const stale = mirror.mirror('shared-session', 'shared-operation');
  while (downloads === 0) await Promise.resolve();
  mirror.reset();
  const fresh = mirror.mirror('shared-session', 'shared-operation');
  firstDownload.resolve(checkpoint);
  await assert.rejects(stale, { name: 'AbortError' });
  await fresh;

  assert.deepEqual(applied, ['document-b']);
  assert.equal(downloads, 2);
});

test('reset and dispose cancel old-profile retries without applying stale work', async () => {
  let applications = 0;
  let downloads = 0;
  const mirror = createCheckpointMirror({
    download: async () => {
      downloads += 1;
      throw new Error('offline');
    },
    apply: async () => { applications += 1; },
    retryBaseMs: 20,
    retryMaxMs: 20,
  });
  const stale = mirror.mirror('session-a', 'operation-a');
  await new Promise((resolve) => setTimeout(resolve, 1));
  mirror.reset();
  await assert.rejects(stale, { name: 'AbortError' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(downloads, 1);
  assert.equal(applications, 0);

  const pending = mirror.mirror('session-a', 'operation-b');
  await new Promise((resolve) => setTimeout(resolve, 1));
  mirror.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(mirror.mirror('session-a', 'operation-c'), { name: 'AbortError' });
});

test('merge recovery mirrors distinct operations at one revision but suppresses replay and older revisions', async () => {
  const applied: string[] = [];
  let current = 'operation-a';
  const mirror = createCheckpointMirror({
    allowSameRevisionOperations: true,
    download: async (_sessionId, operationId) => ({ ...checkpoint, operationId: operationId ?? current,
      revision: operationId === 'older' ? 1 : 2 }),
    apply: (value) => { applied.push(value.operationId); },
  });
  await mirror.mirror('session-a', 'operation-a');
  current = 'operation-b';
  await mirror.mirror('session-a', 'operation-b');
  await mirror.mirror('session-a', 'operation-a');
  await mirror.mirror('session-a', 'operation-b');
  await mirror.mirror('session-a', 'reconnect');
  await mirror.mirror('session-a', 'older');
  assert.deepEqual(applied, ['operation-a', 'operation-b']);
  mirror.dispose();
});

test('a non-retryable download failure settles once and leaves the next fetch to the caller', async () => {
  let downloads = 0;
  const resting = Object.assign(new Error('boat 서버가 정지되어 있습니다.'), { code: 'BOAT_SERVER_STOPPED' });
  const mirror = createCheckpointMirror({
    download: async () => {
      downloads += 1;
      if (downloads === 1) throw resting;
      return checkpoint;
    },
    apply: () => {},
    retryable: (error) => (error as { code?: string }).code !== 'BOAT_SERVER_STOPPED',
    retryBaseMs: 1,
    retryMaxMs: 2,
  });

  await assert.rejects(mirror.mirror('session-a', 'reconnect'), resting);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(downloads, 1);
  assert.equal(mirror.hasPending('session-a'), false);
  await mirror.mirror('session-a', 'reconnect');
  assert.equal(downloads, 2);
  assert.equal(mirror.hasRevision('session-a'), true);
});

test('a missing checkpoint stops the mirror, while a resting VM or a dropped connection keeps it asking', async () => {
  let downloads = 0;
  const missing = { name: 'BoatError', message: 'Cloud 체크포인트를 찾지 못했습니다.', code: 'CHECKPOINT_NOT_FOUND', retryable: false };
  const mirror = createCheckpointMirror({
    download: async () => {
      downloads += 1;
      throw missing;
    },
    apply: () => {},
    retryable: (error) => !isTerminalCheckpointError(error),
    retryBaseMs: 1,
    retryMaxMs: 2,
  });

  await assert.rejects(mirror.mirror('session-a', 'reconnect'), (error) => error === missing);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(downloads, 1);
  assert.equal(isTerminalCheckpointError({ code: 'BOAT_SERVER_STOPPED', retryable: false }), false);
  assert.equal(isTerminalCheckpointError(new TypeError('fetch failed')), false);
});
