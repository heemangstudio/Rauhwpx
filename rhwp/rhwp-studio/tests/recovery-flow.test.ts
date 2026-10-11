import test from 'node:test';
import assert from 'node:assert/strict';

import type { AutosaveDraftSummary } from '../src/recovery/autosave-store.ts';
import type { AutosaveDraft } from '../src/recovery/autosave-store.ts';
import {
  offerAutosaveRecovery,
  planDraftRestore,
  restoreAutosaveDraft,
  type AutosaveRecoveryOfferDeps,
  type AutosaveRestoreDeps,
  type LocatedOriginal,
} from '../src/recovery/recovery-flow.ts';

const crashed: AutosaveDraftSummary = {
  id: 'crashed-draft',
  fileName: '보고서.hwpx',
  sourceFormat: 'hwpx',
  savedAt: 1_000,
  byteLength: 3,
};

function offerDeps(overrides: Partial<AutosaveRecoveryOfferDeps> = {}) {
  const calls: string[] = [];
  let notice: (() => void) | null = null;
  const deps: AutosaveRecoveryOfferDeps = {
    listRecoverable: async () => [crashed],
    hasOpenDocument: () => false,
    notifyAvailable: (open) => {
      calls.push('notice');
      notice = open;
    },
    markOffered: async (ids) => { calls.push(`offered:${ids.join(',')}`); },
    showDialog: async () => {
      calls.push('dialog');
      return { action: 'restore', draftId: crashed.id };
    },
    clearRecoverable: async () => { calls.push('clear'); },
    canReplaceCurrentDocument: async () => {
      calls.push('can-replace');
      return true;
    },
    restore: async (draft) => { calls.push(`restore:${draft.id}`); },
    toast: () => {},
    onRestoreError: (error) => { throw error; },
    ...overrides,
  };
  return { deps, calls, openNotice: () => notice?.() };
}

const handle = {
  name: '보고서.hwpx',
  getFile: async () => new File([], '보고서.hwpx'),
  createWritable: async () => { throw new Error('unused'); },
};

const linked: AutosaveDraft = {
  id: 'linked-draft',
  fileName: '보고서.hwpx',
  sourceFormat: 'hwpx',
  dataFormat: 'hwpx',
  documentId: 'doc-1',
  base: { digest: 'blake3:disk', byteLength: 3, mergeable: true },
  savedAt: 2_000,
  byteLength: 3,
  data: new Uint8Array([1, 2, 3]),
};

function found(digest: string): LocatedOriginal {
  return { kind: 'found', bytes: new Uint8Array([9]), name: '보고서.hwpx', handle, digest };
}

test('restore plans follow the draft link and what is on disk', () => {
  const plan = (draft: Parameters<typeof planDraftRestore>[0], located: LocatedOriginal | null, canMerge = true) => {
    const result = planDraftRestore(draft, located, { canMerge });
    return result.kind === 'detached'
      ? `detached:${result.why}:${result.fileName}`
      : result.kind === 'legacy' ? `legacy:${result.fileName}` : result.kind;
  };
  assert.equal(plan(crashed, null), 'legacy:보고서.hwp');
  assert.equal(plan(linked, found('blake3:disk')), 'reopen-dirty');
  assert.equal(plan(linked, found('blake3:edited')), 'merge-external');
  assert.equal(plan(linked, found('blake3:edited'), false), 'detached:changed:보고서.hwpx');
  assert.equal(
    plan({ ...linked, base: { ...linked.base!, mergeable: false } }, found('blake3:edited')),
    'detached:changed:보고서.hwpx',
  );
  assert.equal(plan(linked, { kind: 'missing' }), 'detached:not-found:보고서.hwpx');
  assert.equal(plan(linked, { kind: 'permission-denied' }), 'detached:permission-denied:보고서.hwpx');
  assert.equal(plan(linked, { kind: 'owned-elsewhere' }), 'blocked');
  assert.equal(plan({ ...linked, base: undefined }, null), 'detached:never-saved:보고서.hwpx');
  // HWPX 로 내보내지 못해 HWP 로 남긴 draft 는 원본에 연결하면 HWPX 파일에 HWP 를 쓰게 된다.
  assert.equal(plan({ ...linked, dataFormat: 'hwp' }, found('blake3:disk')), 'detached:format:보고서.hwp');
});

test('a document that was clean when the engine stopped reopens clean from an unchanged original', () => {
  const kind = (located: LocatedOriginal, cleanAtTrap?: boolean) => planDraftRestore(
    linked, located, { canMerge: true, ...(cleanAtTrap === undefined ? {} : { cleanAtTrap }) },
  ).kind;
  assert.equal(kind(found('blake3:disk'), true), 'reopen-clean');
  assert.equal(kind(found('blake3:disk')), 'reopen-dirty', 'ordinary recovery keeps the draft as changes');
  assert.equal(kind(found('blake3:edited'), true), 'merge-external', 'a changed file is never mistaken for the clean copy');
});

function restoreDeps(overrides: Partial<AutosaveRestoreDeps> = {}) {
  const calls: string[] = [];
  const toasts: string[] = [];
  const deps: AutosaveRestoreDeps = {
    readDraft: async (id) => (id === linked.id ? linked : { ...crashed, id, data: new Uint8Array([1, 2, 3]) }),
    locateOriginal: async () => {
      calls.push('locate');
      return { kind: 'found', bytes: new Uint8Array([9]), name: '보고서.hwpx', handle };
    },
    digestOf: () => 'blake3:disk',
    releaseHandle: async () => { calls.push('release-handle'); },
    canMerge: () => true,
    releaseCurrentDocument: () => { calls.push('release-current'); },
    openDraft: async (draft, target) => {
      calls.push(`open:${target.fileName}:${target.documentId}:${target.original ? 'original' : 'detached'}`);
      return 'opened';
    },
    mergeExternal: async () => {
      calls.push('merge');
      return { kind: 'merging', enabledHistory: false, completion: Promise.resolve(true) };
    },
    deleteDraft: async (id) => { calls.push(`delete:${id}`); },
    flush: async () => { calls.push('flush'); },
    toast: (message) => { toasts.push(message); },
    ...overrides,
  };
  return { deps, calls, toasts };
}

test('an unchanged original reopens as itself, dirty, and keeps the draft until it is rewritten', async () => {
  const { deps, calls } = restoreDeps();
  await restoreAutosaveDraft(linked, deps);
  assert.deepEqual(calls, ['locate', 'release-current', 'open:보고서.hwpx:doc-1:original', 'flush']);
});

test('a clean reopen opens the original itself, not the draft, and deletes the draft', async () => {
  const targets: Array<{ clean?: boolean; original: boolean; documentId: string | null }> = [];
  const reports: string[] = [];
  const { deps, calls, toasts } = restoreDeps({
    openDraft: async (_draft, target) => {
      targets.push({ clean: target.clean, original: target.original !== null, documentId: target.documentId });
      calls.push('open');
      return 'opened';
    },
  });
  const outcome = await restoreAutosaveDraft(linked, deps, {
    cleanAtTrap: true,
    report: (result) => reports.push(result.kind === 'opened' ? result.plan : result.kind),
  });
  assert.deepEqual(targets, [{ clean: true, original: true, documentId: 'doc-1' }]);
  assert.deepEqual(calls, ['locate', 'release-current', 'open', 'delete:linked-draft']);
  assert.ok(!calls.includes('flush'), 'nothing re-records a draft for a clean document');
  assert.equal(outcome.kind === 'opened' && outcome.plan, 'reopen-clean');
  assert.deepEqual(reports, ['reopen-clean']);
  assert.deepEqual(toasts, [], 'a report sink replaces the toast');
});

test('an old draft without a document link opens under its own name with a new identity', async () => {
  const { deps, calls } = restoreDeps();
  await restoreAutosaveDraft(crashed, deps);
  assert.deepEqual(calls, ['release-current', 'open:보고서.hwp:null:detached', 'flush']);
});

test('a missing original opens detached but keeps the document id', async () => {
  const { deps, calls } = restoreDeps({ locateOriginal: async () => ({ kind: 'missing' }) });
  await restoreAutosaveDraft(linked, deps);
  assert.deepEqual(calls, ['release-current', 'open:보고서.hwpx:doc-1:detached', 'flush']);
});

test('a document open in another window blocks restore and leaves everything alone', async () => {
  const { deps, calls, toasts } = restoreDeps({
    locateOriginal: async () => ({ kind: 'owned-elsewhere' }),
  });
  await restoreAutosaveDraft(linked, deps);
  assert.deepEqual(calls, []);
  assert.match(toasts[0], /다른 창에서 열려 있습니다/);
});

test('a changed original is merged and the draft is deleted only after the merge completes', async () => {
  let finish!: (done: boolean) => void;
  const completion = new Promise<boolean>((resolve) => { finish = resolve; });
  const { deps, calls, toasts } = restoreDeps({
    digestOf: () => 'blake3:edited',
    mergeExternal: async () => {
      calls.push('merge');
      return { kind: 'merging', enabledHistory: true, completion };
    },
  });
  await restoreAutosaveDraft(linked, deps);
  assert.deepEqual(calls, ['locate', 'release-current', 'merge']);
  assert.match(toasts[0], /외부 변경/);
  assert.match(toasts[0], /버전 기록을 켰습니다/);

  finish(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), 'delete:linked-draft');
});

test('closing the merge without finishing keeps the draft', async () => {
  const { deps, calls } = restoreDeps({
    digestOf: () => 'blake3:edited',
    mergeExternal: async () => ({ kind: 'merging', enabledHistory: false, completion: Promise.resolve(false) }),
  });
  await restoreAutosaveDraft(linked, deps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!calls.some((call) => call.startsWith('delete:')));
});

test('a changed original that cannot be merged is released and opened detached', async () => {
  const { deps, calls } = restoreDeps({ digestOf: () => 'blake3:edited', canMerge: () => false });
  await restoreAutosaveDraft(linked, deps);
  assert.deepEqual(calls, ['locate', 'release-handle', 'release-current', 'open:보고서.hwpx:doc-1:detached', 'flush']);
});

test('a draft that disappeared before restore fails without loading anything', async () => {
  const { deps, calls } = restoreDeps({ readDraft: async () => null });
  await assert.rejects(restoreAutosaveDraft(crashed, deps), /자동 저장본을 찾지 못했습니다/);
  assert.deepEqual(calls, []);
});

test('a relaunch that already opened a document offers recovery instead of skipping it', async () => {
  const { deps, calls, openNotice } = offerDeps({ hasOpenDocument: () => true });
  await offerAutosaveRecovery(deps);
  assert.deepEqual(calls, ['notice']);

  openNotice();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [
    'notice',
    'offered:crashed-draft',
    'dialog',
    'can-replace',
    'restore:crashed-draft',
  ]);
});

test('cancelling the unsaved-changes prompt leaves the current document and the draft alone', async () => {
  const { deps, calls } = offerDeps({ canReplaceCurrentDocument: async () => false });
  await offerAutosaveRecovery(deps);
  assert.deepEqual(calls, ['offered:crashed-draft', 'dialog']);
});

test('empty drafts are never offered', async () => {
  const { deps, calls } = offerDeps({
    listRecoverable: async () => [{ ...crashed, byteLength: 0 }],
  });
  await offerAutosaveRecovery(deps);
  assert.deepEqual(calls, []);
});

test('a read-only document with no file reopens clean from its copy, and the copy is not offered again', async () => {
  const neverSaved: AutosaveDraft = { ...linked, base: undefined };
  const targets: Array<{ clean?: boolean; original: boolean }> = [];
  const { deps, calls } = restoreDeps({
    readDraft: async () => neverSaved,
    openDraft: async (_draft, target) => {
      targets.push({ clean: target.clean, original: target.original !== null });
      calls.push('open');
      return 'opened';
    },
  });
  const outcome = await restoreAutosaveDraft(neverSaved, deps, { cleanAtTrap: true, readOnly: true, report: () => {} });
  assert.deepEqual(targets, [{ clean: true, original: false }], 'opened clean, not as unsaved changes');
  assert.deepEqual(calls, ['release-current', 'open', 'delete:linked-draft']);
  assert.ok(outcome.kind === 'opened' && outcome.detached === 'never-saved');

  // 고칠 수 있던 문서는 지금처럼 저장하지 않은 문서로 연다.
  targets.length = 0;
  calls.length = 0;
  await restoreAutosaveDraft(neverSaved, deps, { cleanAtTrap: true, report: () => {} });
  assert.deepEqual(targets, [{ clean: undefined, original: false }]);
  assert.deepEqual(calls, ['release-current', 'open', 'flush']);
});

test('while the engine is stopped the startup offer opens, restores and deletes nothing', async () => {
  let stopped = true;
  const routed: string[] = [];
  const { deps, calls } = offerDeps({
    engineStopped: () => stopped,
    onEngineStopped: () => { routed.push('trap-recovery'); },
    showDialog: async () => {
      calls.push('dialog');
      return { action: 'delete-all' };
    },
  });
  await offerAutosaveRecovery(deps);
  assert.deepEqual(calls, [], 'the copies the next 문서 복구 needs stay where they are');

  // 엔진이 멈추기 전에 띄운 안내의 복구를 멈춘 뒤에 누르면 문서 복구로 안내한다.
  stopped = false;
  const notice = offerDeps({
    hasOpenDocument: () => true,
    engineStopped: () => stopped,
    onEngineStopped: () => { routed.push('trap-recovery'); },
  });
  await offerAutosaveRecovery(notice.deps);
  stopped = true;
  notice.openNotice();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notice.calls, ['notice']);
  assert.deepEqual(routed, ['trap-recovery']);
});

test('a trap while the recovery dialog is open cancels the choice made in it', async () => {
  for (const action of ['delete-all', 'restore'] as const) {
    let stopped = false;
    const { deps, calls } = offerDeps({
      engineStopped: () => stopped,
      showDialog: async () => {
        calls.push('dialog');
        stopped = true;
        return action === 'restore' ? { action, draftId: crashed.id } : { action };
      },
    });
    await offerAutosaveRecovery(deps);
    assert.deepEqual(calls, ['offered:crashed-draft', 'dialog'], `${action} is not carried out on a stopped engine`);
  }
});
