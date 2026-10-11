import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARCHIVE_CONFIRM_PAUSE_MS,
  saveArchiveConfirmChoice,
  setArchiveConfirmEnabled,
  shouldConfirmArchive,
} from '../src/ui/agent-sidebar/archive-confirm.ts';

function memoryStorage() {
  const mem = new Map<string, string>();
  return {
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => void mem.set(key, value),
  };
}

test('archive confirmation pauses for five hours and then asks again', () => {
  const storage = memoryStorage();
  assert.equal(shouldConfirmArchive(0, storage), true);
  saveArchiveConfirmChoice('pause', 1_000, storage);
  assert.equal(shouldConfirmArchive(1_000 + ARCHIVE_CONFIRM_PAUSE_MS - 1, storage), false);
  assert.equal(shouldConfirmArchive(1_000 + ARCHIVE_CONFIRM_PAUSE_MS, storage), true);
});

test('never asking again sticks until the settings switch turns it back on', () => {
  const storage = memoryStorage();
  saveArchiveConfirmChoice('never', 0, storage);
  assert.equal(shouldConfirmArchive(Number.MAX_SAFE_INTEGER, storage), false);
  setArchiveConfirmEnabled(true, storage);
  assert.equal(shouldConfirmArchive(0, storage), true);
  storage.setItem('rhwp-archive-confirm', '{broken');
  assert.equal(shouldConfirmArchive(0, storage), true);
});
