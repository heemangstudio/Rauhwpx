import test from 'node:test';
import assert from 'node:assert/strict';

import type { AutosaveDraftSummary } from '../src/recovery/autosave-store.ts';
import {
  offerAutosaveRecovery,
  restoreAutosaveDraft,
  type AutosaveRecoveryOfferDeps,
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

test('restoring a draft keeps it on disk and rewrites it under the live window', async () => {
  const calls: string[] = [];
  await restoreAutosaveDraft(crashed, {
    readDraft: async (id) => ({ ...crashed, id, data: new Uint8Array([1, 2, 3]) }),
    releaseCurrentDocument: () => { calls.push('release-current'); },
    load: async (bytes, fileName, draftId) => { calls.push(`load:${fileName}:${draftId}:${bytes.length}`); },
    markDirty: () => { calls.push('dirty'); },
    flush: async () => { calls.push('flush'); },
    toast: () => {},
  });
  // No delete step exists: the draft stays until the adopted id is overwritten or the
  // document is saved or discarded.
  assert.deepEqual(calls, [
    'release-current',
    'load:보고서 복구본.hwp:crashed-draft:3',
    'dirty',
    'flush',
  ]);
});

test('a draft that disappeared before restore fails without loading anything', async () => {
  let loaded = false;
  await assert.rejects(restoreAutosaveDraft(crashed, {
    readDraft: async () => null,
    releaseCurrentDocument: () => {},
    load: async () => { loaded = true; },
    markDirty: () => {},
    flush: async () => {},
    toast: () => {},
  }), /복구본을 찾지 못했습니다/);
  assert.equal(loaded, false);
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
