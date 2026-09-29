import test from 'node:test';
import assert from 'node:assert/strict';

import { DocumentDirtyState } from '../src/core/document-dirty-state.ts';
import { EventBus } from '../src/core/event-bus.ts';
import { HostSaveTracker } from '../src/recovery/host-save.ts';

function tracker() {
  const eventBus = new EventBus();
  const documentState = new DocumentDirtyState(eventBus);
  const discarded: string[] = [];
  const saved: string[] = [];
  let fileName = 'a.hwp';
  const hostSave = new HostSaveTracker({
    documentState,
    setFileName: (next) => { fileName = next; },
    emitSaved: () => { saved.push(fileName); },
    discardDraft: async (reason) => { discarded.push(reason); },
  });
  return { documentState, hostSave, discarded, saved };
}

test('edits typed while the host uploads stay dirty with their recovery draft', async () => {
  const { documentState, hostSave, discarded, saved } = tracker();
  documentState.markDirty('typing');
  hostSave.recordExport();
  documentState.markDirty('typing-during-upload');

  assert.deepEqual(await hostSave.complete('uploaded.hwp'), { ok: true, wasDirty: true });
  assert.equal(documentState.isDirty(), true);
  assert.deepEqual(discarded, []);
  assert.deepEqual(saved, ['uploaded.hwp'], 'the host save is still announced');
});

test('a host save of the exported revision marks the document clean and drops its draft', async () => {
  const { documentState, hostSave, discarded } = tracker();
  documentState.markDirty('typing');
  hostSave.recordExport();

  assert.deepEqual(await hostSave.complete(), { ok: true, wasDirty: true });
  assert.equal(documentState.isDirty(), false);
  assert.deepEqual(discarded, ['host-save']);
});

test('hosts that never export through RPC keep the notify-time contract', async () => {
  const { documentState, hostSave, discarded } = tracker();
  documentState.markDirty('typing');
  hostSave.recordExport();
  hostSave.reset();
  documentState.markDirty('typing-in-new-document');

  await hostSave.complete();
  assert.equal(documentState.isDirty(), false);
  assert.deepEqual(discarded, ['host-save']);
});
