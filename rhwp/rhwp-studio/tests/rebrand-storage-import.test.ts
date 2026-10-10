import assert from 'node:assert/strict';
import test from 'node:test';

import { runRebrandedStorageImport } from '../src/core/rebrand-storage-import.ts';

test('the editor still loads when the desktop never hands over the 2.0.11 storage', async () => {
  let finished = false;
  (globalThis as { rhwpDesktop?: unknown }).rhwpDesktop = {
    takeRebrandImport: () => new Promise(() => {}),
    finishRebrandImport: async () => { finished = true; },
  };
  try {
    const started = Date.now();
    await runRebrandedStorageImport({ timeoutMs: 50 });
    assert.ok(Date.now() - started < 2000, 'boot continues after the import timeout');
    assert.equal(finished, false, 'nothing is reported as imported');
  } finally {
    delete (globalThis as { rhwpDesktop?: unknown }).rhwpDesktop;
  }
});
