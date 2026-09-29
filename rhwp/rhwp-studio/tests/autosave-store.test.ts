import test from 'node:test';
import assert from 'node:assert/strict';

import {
  autosaveInstanceLockName,
  clearAutosaveDrafts,
  deleteAutosaveDraft,
  getAutosaveDraft,
  listAutosaveDrafts,
  listRecoverableAutosaveDrafts,
  markAutosaveDraftsOffered,
  releaseAutosaveSession,
  saveAutosaveDraft,
  touchAutosaveSession,
  type AutosaveDraft,
} from '../src/recovery/autosave-store.ts';

test('autosave store는 IndexedDB가 없으면 메모리 폴백으로 draft를 저장한다', async () => {
  await clearAutosaveDrafts();

  await saveAutosaveDraft({
    id: 'draft-1',
    fileName: '문서.hwp',
    sourceFormat: 'hwp',
    savedAt: 100,
    byteLength: 3,
    data: new Uint8Array([1, 2, 3]),
    dirtyReason: 'typing',
  });

  const loaded = await getAutosaveDraft('draft-1');
  assert.ok(loaded);
  assert.equal(loaded.fileName, '문서.hwp');
  assert.equal(loaded.sourceFormat, 'hwp');
  assert.equal(loaded.byteLength, 3);
  assert.deepEqual([...loaded.data], [1, 2, 3]);

  const listed = await listAutosaveDrafts();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 'draft-1');

  await deleteAutosaveDraft('draft-1');
  assert.equal(await getAutosaveDraft('draft-1'), null);
});

test('live window ownership protects drafts from retention pruning', async () => {
  await clearAutosaveDrafts();
  const now = Date.now();
  const owner = { launchId: 'launch-live', sessionId: 'session-live' };
  await touchAutosaveSession(owner, now);

  for (let index = 0; index < 13; index += 1) {
    await saveAutosaveDraft({
      id: `live-${index}`,
      fileName: `${index}.hwp`,
      sourceFormat: 'hwp',
      savedAt: now + index,
      byteLength: 1,
      data: new Uint8Array([index]),
      ownerLaunchId: owner.launchId,
      ownerSessionId: owner.sessionId,
      ownerHeartbeatAt: now,
    });
  }

  assert.equal((await listAutosaveDrafts()).length, 13);
  assert.equal((await listRecoverableAutosaveDrafts({ now })).length, 0);
  await releaseAutosaveSession(owner.sessionId);
  assert.equal((await listRecoverableAutosaveDrafts({ now: now + 21_000 })).length, 13);
});

test('recovery only returns drafts from dead prior sessions', async () => {
  await clearAutosaveDrafts();
  const now = Date.now();
  const live = { launchId: 'launch-current', sessionId: 'session-current' };
  await touchAutosaveSession(live, now);
  await saveAutosaveDraft({
    id: 'live-draft', fileName: 'live.hwp', sourceFormat: 'hwp', savedAt: now,
    byteLength: 1, data: new Uint8Array([1]), ownerLaunchId: live.launchId,
    ownerSessionId: live.sessionId, ownerHeartbeatAt: now,
  });
  await saveAutosaveDraft({
    id: 'dead-draft', fileName: 'dead.hwp', sourceFormat: 'hwp', savedAt: now - 30_000,
    byteLength: 1, data: new Uint8Array([2]), ownerLaunchId: 'launch-old',
    ownerSessionId: 'session-old', ownerHeartbeatAt: now - 30_000,
  });

  assert.deepEqual(
    (await listRecoverableAutosaveDrafts({ now })).map((draft) => draft.id),
    ['dead-draft'],
  );
  await releaseAutosaveSession(live.sessionId);
});

test('autosave store는 draft 데이터를 복사해서 외부 변경과 분리한다', async () => {
  await clearAutosaveDrafts();
  const data = new Uint8Array([7, 8, 9]);

  await saveAutosaveDraft({
    id: 'draft-copy',
    fileName: 'copy.hwp',
    sourceFormat: 'hwp',
    savedAt: 200,
    byteLength: data.byteLength,
    data,
  });
  data[0] = 99;

  const loaded = await getAutosaveDraft('draft-copy');
  assert.ok(loaded);
  assert.deepEqual([...loaded.data], [7, 8, 9]);

  loaded.data[1] = 88;
  const loadedAgain = await getAutosaveDraft('draft-copy');
  assert.ok(loadedAgain);
  assert.deepEqual([...loadedAgain.data], [7, 8, 9]);
});

function fakeLocks(heldInstances: string[] = []) {
  const held = heldInstances.map((instance) => ({ name: autosaveInstanceLockName(instance) }));
  return {
    async request() { return undefined; },
    async query() { return { held }; },
  };
}

function ownedDraft(id: string, owner: Partial<AutosaveDraft>, savedAt = Date.now()): AutosaveDraft {
  return {
    id, fileName: `${id}.hwp`, sourceFormat: 'hwp', savedAt, byteLength: 1, data: new Uint8Array([1]),
    ...owner,
  };
}

test('a reloaded page does not hide the dead page draft behind the shared sessionId', async () => {
  await clearAutosaveDrafts();
  const now = Date.now();
  // The reloaded tab reuses sessionId "tab" from sessionStorage and heartbeats as page-2.
  await touchAutosaveSession({ launchId: 'launch', sessionId: 'tab', instanceId: 'page-2' }, now);
  await saveAutosaveDraft(ownedDraft('before-reload', {
    ownerLaunchId: 'launch', ownerSessionId: 'tab', ownerInstanceId: 'page-1', ownerHeartbeatAt: now - 1_000,
  }), { now, locks: null });

  assert.deepEqual(
    (await listRecoverableAutosaveDrafts({ now, locks: fakeLocks(['page-2']) })).map((draft) => draft.id),
    ['before-reload'],
    'page-1 no longer holds its lock, so its draft is recoverable at once',
  );
  await releaseAutosaveSession('tab');
});

test('owner locks decide liveness over heartbeats a hidden window let go stale', async () => {
  await clearAutosaveDrafts();
  const now = Date.now();
  await saveAutosaveDraft(ownedDraft('throttled-live', {
    ownerSessionId: 'hidden-window', ownerInstanceId: 'page-live', ownerHeartbeatAt: now - 5 * 60_000,
  }), { now, locks: null });
  await saveAutosaveDraft(ownedDraft('crashed', {
    ownerSessionId: 'crashed-window', ownerInstanceId: 'page-crashed', ownerHeartbeatAt: now,
  }), { now, locks: null });
  await saveAutosaveDraft(ownedDraft('legacy-dead', {
    ownerSessionId: 'old-window', ownerHeartbeatAt: now - 60_000,
  }), { now, locks: null });

  assert.deepEqual(
    (await listRecoverableAutosaveDrafts({ now, locks: fakeLocks(['page-live']) }))
      .map((draft) => draft.id).sort(),
    ['crashed', 'legacy-dead'],
  );
});

test('without Web Locks a heartbeat from another page instance does not keep a draft alive', async () => {
  await clearAutosaveDrafts();
  const now = Date.now();
  await touchAutosaveSession({ launchId: 'launch', sessionId: 'tab', instanceId: 'page-2' }, now);
  await saveAutosaveDraft(ownedDraft('stale-page', {
    ownerSessionId: 'tab', ownerInstanceId: 'page-1', ownerHeartbeatAt: now - 60_000,
  }), { now, locks: null });
  await saveAutosaveDraft(ownedDraft('current-page', {
    ownerSessionId: 'tab', ownerInstanceId: 'page-2', ownerHeartbeatAt: now - 60_000,
  }), { now, locks: null });

  assert.deepEqual(
    (await listRecoverableAutosaveDrafts({ now, locks: null })).map((draft) => draft.id),
    ['stale-page'],
  );
  await releaseAutosaveSession('tab');
});

test('retention keeps crash drafts the user has not been shown yet', async () => {
  await clearAutosaveDrafts();
  const now = Date.now();
  for (let index = 0; index < 14; index += 1) {
    await saveAutosaveDraft(ownedDraft(`unseen-${index}`, {
      ownerSessionId: `dead-${index}`, ownerHeartbeatAt: now - 60_000,
    }, now - 1_000 + index), { now, locks: null });
  }
  assert.equal((await listAutosaveDrafts()).length, 14, 'never-offered drafts are not trimmed at 12');

  await markAutosaveDraftsOffered((await listAutosaveDrafts()).map((draft) => draft.id), now);
  await saveAutosaveDraft(
    ownedDraft('fresh', { ownerSessionId: 'live', ownerHeartbeatAt: now }),
    { now, locks: null },
  );
  const remaining = (await listAutosaveDrafts()).map((draft) => draft.id);
  assert.equal(remaining.length, 12);
  assert.ok(remaining.includes('fresh'));
  for (const oldest of ['unseen-0', 'unseen-1', 'unseen-2']) assert.ok(!remaining.includes(oldest));
});

test('draft listing returns metadata only and restore reads the bytes by id', async () => {
  await clearAutosaveDrafts();
  await saveAutosaveDraft(ownedDraft('with-bytes', {}), { locks: null });
  const [summary] = await listAutosaveDrafts();
  assert.equal(summary.id, 'with-bytes');
  assert.equal('data' in summary, false);
  assert.equal(summary.byteLength, 1);
  assert.deepEqual([...(await getAutosaveDraft('with-bytes'))!.data], [1]);
});
