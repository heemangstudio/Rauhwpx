import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bindNativeFileHandleIdentity,
  createNativeFileHandle,
  locateNativeDocumentFile,
  pickDesktopNativeSaveFile,
  renameNativeDocumentFile,
  subscribeNativeFileMoves,
  type NativeFileMovedEvent,
  type RhwpDesktopApi,
} from '../src/desktop-integration.ts';
import { saveDocumentToFileSystem, type FileSystemWindowLike } from '../src/command/file-system-access.ts';
import { waitForDocumentIoIdle } from '../src/core/document-io-idle.ts';
import { describeSaveError, unreachableFileSaveError } from '../src/command/save-error-message.ts';

// The desktop follows a document that Explorer renamed or moved. The editor must
// then show and keep using the new name, and switching documents must never
// hand one document's save result to another.

function desktopApi(overrides: Partial<RhwpDesktopApi> = {}): RhwpDesktopApi {
  return {
    readNativeFile: async () => ({ name: 'report.hwp', bytes: new Uint8Array() }),
    writeNativeFile: async (_handleId, bytes) => ({ name: 'report.hwp', byteLength: bytes.byteLength }),
    validateNativeSave: async () => {},
    ...overrides,
  };
}

const identity = { documentId: 'document-a', sourceDigest: null };

test('a save the desktop followed to a renamed file reports the new name on every handle for it', async () => {
  const api = desktopApi({
    writeNativeFile: async (_handleId, bytes) => ({ name: '최종 보고서.hwp', byteLength: bytes.byteLength }),
  });
  const current = createNativeFileHandle({ kind: 'file', handleId: 'followed', name: 'report.hwp' }, api);
  // The recent documents list keeps its own handle object for the same file.
  const remembered = createNativeFileHandle({ kind: 'file', handleId: 'followed', name: 'report.hwp' }, api);
  bindNativeFileHandleIdentity(current, identity);

  const result = await saveDocumentToFileSystem({
    blob: new Blob([new Uint8Array([1, 2, 3])]),
    suggestedName: 'report.hwp',
    currentHandle: current,
    windowLike: {} as FileSystemWindowLike,
    forceSaveAs: false,
    saveFormat: 'hwp',
  });

  assert.equal(result.method, 'current-handle');
  assert.equal(result.fileName, '최종 보고서.hwp');
  assert.equal(current.name, '최종 보고서.hwp');
  assert.equal(remembered.name, '최종 보고서.hwp');
});

test('a followed name never changes the extension that picks the save format', async () => {
  const api = desktopApi({
    writeNativeFile: async (_handleId, bytes) => ({ name: 'report.hwpx', byteLength: bytes.byteLength }),
  });
  const handle = createNativeFileHandle({ kind: 'file', handleId: 'format', name: 'report.hwp' }, api);
  bindNativeFileHandleIdentity(handle, identity);
  const writable = await handle.createWritable();
  await writable.write(new Blob([new Uint8Array([1])]));
  await writable.close();
  assert.equal(handle.name, 'report.hwp');
});

test('renaming in the app keeps the same handle, its ownership and its save target', async () => {
  const writes: string[] = [];
  const api = desktopApi({
    renameNativeFile: async (handleId, nextName) => ({
      ok: true as const,
      descriptor: { kind: 'file' as const, handleId, name: nextName },
    }),
    writeNativeFile: async (handleId, bytes, owner) => {
      writes.push(`${handleId}:${owner.documentId}`);
      return { name: 'final.hwp', byteLength: bytes.byteLength };
    },
  });
  const handle = createNativeFileHandle({ kind: 'file', handleId: 'renamed', name: 'report.hwp' }, api);
  bindNativeFileHandleIdentity(handle, identity);

  const renamed = await renameNativeDocumentFile(handle, 'final.hwp');
  assert.equal(renamed, handle);
  assert.equal(handle.name, 'final.hwp');

  const writable = await renamed.createWritable();
  await writable.write(new Blob([new Uint8Array([1])]));
  await writable.close();
  assert.deepEqual(writes, ['renamed:document-a']);
});

test('a move reported by the desktop renames the handles before the editor hears about it', () => {
  let deliver: ((event: NativeFileMovedEvent) => void) | undefined;
  let disposed = 0;
  const api = desktopApi({
    onNativeFileMoved: (callback) => {
      deliver = callback;
      return () => { disposed += 1; };
    },
  });
  const handle = createNativeFileHandle({ kind: 'file', handleId: 'moved', name: 'report.hwp' }, api);
  const seen: Array<{ event: NativeFileMovedEvent; handleName: string }> = [];
  const dispose = subscribeNativeFileMoves((event) => seen.push({ event, handleName: handle.name }), { rhwpDesktop: api });

  deliver!({ handleId: 'moved', name: 'report (final).hwp', previousName: 'report.hwp' });
  assert.deepEqual(seen, [{
    event: { handleId: 'moved', name: 'report (final).hwp', previousName: 'report.hwp' },
    handleName: 'report (final).hwp',
  }]);
  dispose();
  assert.equal(disposed, 1);
});

test('returning to the window asks where the document is and reports a vanished file', async () => {
  let state: 'present' | 'missing' = 'present';
  const api = desktopApi({
    locateNativeFile: async () => ({ name: state === 'present' ? 'draft.hwp' : 'draft.hwp', state }),
  });
  const handle = createNativeFileHandle({ kind: 'file', handleId: 'located', name: 'report.hwp' }, api);

  assert.deepEqual(await locateNativeDocumentFile(handle), { name: 'draft.hwp', state: 'present' });
  assert.equal(handle.name, 'draft.hwp');
  state = 'missing';
  assert.deepEqual(await locateNativeDocumentFile(handle), { name: 'draft.hwp', state: 'missing' });
  assert.equal(await locateNativeDocumentFile(null), null);
});

test('Save As opens in the folder of the document being edited', async () => {
  const picks: unknown[] = [];
  const api = desktopApi({
    pickNativeSaveFile: async (options) => {
      picks.push(options);
      return null;
    },
  });
  const current = createNativeFileHandle({ kind: 'file', handleId: 'current-document', name: 'report.hwp' }, api);
  assert.equal(await pickDesktopNativeSaveFile({ suggestedName: 'report.hwpx' }, { rhwpDesktop: api }, current), null);
  assert.equal(await pickDesktopNativeSaveFile({ suggestedName: 'new.hwpx' }, { rhwpDesktop: api }, null), null);
  assert.deepEqual(picks, [
    { suggestedName: 'report.hwpx', extension: 'hwpx', handleId: 'current-document' },
    { suggestedName: 'new.hwpx', extension: 'hwpx' },
  ]);
});

test('a missing or unreachable original is told apart from other save failures and explained in Korean', () => {
  const missing = new Error("Error invoking remote method 'desktop:native-file-write': Error: This document was moved or deleted after it was opened and could not be found. Nothing was written; save it under a different name.");
  const unplugged = new Error("Error invoking remote method 'desktop:native-file-write': Error: The drive or network folder that holds this document is not available. Nothing was written; reconnect it, or save under a different name.");
  assert.equal(unreachableFileSaveError(missing), 'missing');
  assert.equal(unreachableFileSaveError(unplugged), 'unavailable');
  assert.equal(unreachableFileSaveError(new Error('This document changed on disk after it was opened. Reopen it before saving.')), null);
  assert.match(describeSaveError(missing), /다른 이름으로 저장/);
  assert.match(describeSaveError(unplugged), /다시 연결/);
});

test('switching documents waits for a save that started while a document was loading', async () => {
  const order: string[] = [];
  let saving = false;
  let saveDone: (() => void) | undefined;
  let loads = 1;
  let loadDone: (() => void) | undefined;
  const loadIdle = new Promise<void>((resolve) => { loadDone = resolve; });

  const idle = waitForDocumentIoIdle({
    whenSavesIdle: async () => {
      if (!saving) return;
      await new Promise<void>((resolve) => { saveDone = resolve; });
    },
    isSaving: () => saving,
    pendingLoads: () => loads,
    whenLoadsIdle: () => loadIdle,
  }).then(() => order.push('switch'));

  // Ctrl+S lands while the load is still running.
  await Promise.resolve();
  saving = true;
  loads = 0;
  loadDone!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, [], 'the switch must not run while the save is in flight');

  order.push('save-finished');
  saving = false;
  saveDone!();
  await idle;
  assert.deepEqual(order, ['save-finished', 'switch']);
});
