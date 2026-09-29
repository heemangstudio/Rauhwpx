import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import puppeteer, { type Browser } from 'puppeteer-core';
import { createServer, type ViteDevServer } from 'vite';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

const studioRoot = fileURLToPath(new URL('../', import.meta.url));
let server: ViteDevServer | null = null;
let browser: Browser | null = null;
let pageUrl = '';

test.before(async () => {
  server = await createServer({
    root: studioRoot,
    configFile: false,
    cacheDir: resolve(studioRoot, 'node_modules/.vite-autosave-store-test'),
    logLevel: 'silent',
    resolve: { alias: { '@': resolve(studioRoot, 'src') } },
    server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  pageUrl = `http://127.0.0.1:${address.port}/tests/fixtures/version-store-idb.html`;
  browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
});

test.after(async () => {
  await browser?.close();
  await server?.close();
});

async function freshPage() {
  assert.ok(browser);
  const page = await browser.newPage();
  await page.goto(pageUrl);
  await page.evaluate(async () => {
    await new Promise<void>((resolveDelete, reject) => {
      const request = indexedDB.deleteDatabase('rhwpStudioAutosave');
      request.onsuccess = () => resolveDelete();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('deleteDatabase was blocked'));
    });
  });
  return page;
}

test('a full disk fails the draft write and the autosave status instead of faking success', { timeout: 30_000 }, async () => {
  const page = await freshPage();
  try {
    const result = await page.evaluate(async () => {
      const store = await import('/src/recovery/autosave-store.ts');
      const { AutosaveManager } = await import('/src/recovery/autosave-manager.ts');
      const draft = {
        id: 'quota', fileName: 'full.hwp', sourceFormat: 'hwp', savedAt: Date.now(),
        byteLength: 3, data: new Uint8Array([1, 2, 3]),
      };
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function put() {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      };
      let directError = '';
      const states: string[] = [];
      try {
        try {
          await store.saveAutosaveDraft(draft, { locks: null });
        } catch (error) {
          directError = (error as DOMException).name;
        }
        const manager = new AutosaveManager({
          exportBytes: () => new Uint8Array([4, 5, 6]),
          schedule: { recoveryEnabled: false, idleEnabled: false },
          retryDelayMs: 60_000,
          logger: { debug() {}, warn() {} },
          onStatus: (status) => states.push(status.state),
        });
        await manager.beginDocument({ fileName: 'full.hwp', sourceFormat: 'hwp' });
        await manager.flushNow('typing');
        manager.dispose();
      } finally {
        IDBObjectStore.prototype.put = originalPut;
      }
      return {
        directError,
        states,
        stored: (await store.listAutosaveDrafts()).map((row) => row.id),
      };
    });
    assert.equal(result.directError, 'QuotaExceededError');
    assert.deepEqual(result.states, ['saving', 'error']);
    assert.deepEqual(result.stored, []);
  } finally {
    await page.close();
  }
});

test('saving, trimming and listing never structured-clone every draft body', { timeout: 30_000 }, async () => {
  const page = await freshPage();
  try {
    const result = await page.evaluate(async () => {
      const store = await import('/src/recovery/autosave-store.ts');
      const scanned: string[] = [];
      const originalGetAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.getAll = function getAll(...args: Parameters<IDBObjectStore['getAll']>) {
        scanned.push(this.name);
        return originalGetAll.apply(this, args);
      };
      try {
        const now = Date.now();
        for (let index = 0; index < 14; index += 1) {
          await store.saveAutosaveDraft({
            id: `draft-${index}`, fileName: `${index}.hwp`, sourceFormat: 'hwp', savedAt: now + index,
            byteLength: 256 * 1024, data: new Uint8Array(256 * 1024).fill(index),
            ownerSessionId: `dead-${index}`, ownerHeartbeatAt: now - 60_000, offeredAt: now,
          }, { now, locks: null });
          await store.markAutosaveDraftsOffered([`draft-${index}`], now);
        }
        const listed = await store.listRecoverableAutosaveDrafts({ now, locks: null });
        const restored = await store.getAutosaveDraft('draft-13');
        return {
          scanned: [...new Set(scanned)].sort(),
          listed: listed.length,
          hasBody: listed.some((row) => 'data' in row),
          restoredByte: restored?.data[0],
          restoredLength: restored?.data.byteLength,
        };
      } finally {
        IDBObjectStore.prototype.getAll = originalGetAll;
      }
    });
    assert.deepEqual(result.scanned, ['draftMeta', 'sessions']);
    assert.equal(result.listed, 12, 'offered drafts above the limit are trimmed');
    assert.equal(result.hasBody, false);
    assert.equal(result.restoredByte, 13);
    assert.equal(result.restoredLength, 256 * 1024);
  } finally {
    await page.close();
  }
});

test('drafts written by the v2 schema are listed and restorable after the upgrade', { timeout: 30_000 }, async () => {
  const page = await freshPage();
  try {
    const result = await page.evaluate(async () => {
      await new Promise<void>((resolveSeed, reject) => {
        const request = indexedDB.open('rhwpStudioAutosave', 2);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('drafts', { keyPath: 'id' });
          request.result.createObjectStore('sessions', { keyPath: 'sessionId' });
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('drafts', 'readwrite');
          tx.objectStore('drafts').put({
            id: 'legacy', fileName: '보고서.hwp', sourceFormat: 'hwp', savedAt: 5, byteLength: 2,
            data: new Uint8Array([7, 8]).buffer, ownerSessionId: 'gone', ownerHeartbeatAt: 5,
          });
          tx.oncomplete = () => { db.close(); resolveSeed(); };
          tx.onerror = () => reject(tx.error);
        };
      });
      const store = await import('/src/recovery/autosave-store.ts');
      const recoverable = await store.listRecoverableAutosaveDrafts({ locks: null });
      const draft = await store.getAutosaveDraft('legacy');
      return {
        recoverable: recoverable.map((row) => [row.id, row.fileName, row.byteLength]),
        bytes: draft ? [...draft.data] : null,
      };
    });
    assert.deepEqual(result.recoverable, [['legacy', '보고서.hwp', 2]]);
    assert.deepEqual(result.bytes, [7, 8]);
  } finally {
    await page.close();
  }
});

test('a live window keeps its draft; closing it makes the draft recoverable at once', { timeout: 30_000 }, async () => {
  const owner = await freshPage();
  const observer = await freshPage();
  try {
    const stored = await owner.evaluate(async () => {
      const store = await import('/src/recovery/autosave-store.ts');
      const { AutosaveManager } = await import('/src/recovery/autosave-manager.ts');
      const manager = new AutosaveManager({
        exportBytes: () => new Uint8Array([1, 2]),
        schedule: { recoveryEnabled: false, idleEnabled: false },
        idFactory: () => 'owned-draft',
        // Same sessionId as the observer, as after a reload or a duplicated tab.
        owner: { launchId: 'launch', sessionId: 'tab' },
        heartbeatIntervalMs: 0,
        locks: store.defaultAutosaveLocks(),
        logger: { debug() {}, warn() {} },
      });
      await manager.beginDocument({ fileName: 'live.hwp', sourceFormat: 'hwp' });
      await manager.flushNow('typing');
      (window as unknown as { keep: unknown }).keep = manager;
      return (await store.listAutosaveDrafts()).map((row) => [row.id, Boolean(row.ownerInstanceId)]);
    });
    assert.deepEqual(stored, [['owned-draft', true]], 'the draft records the lock-holding instance');
    const listRecoverable = () => observer.evaluate(async () => {
      const store = await import('/src/recovery/autosave-store.ts');
      // Far in the future: every heartbeat is stale, so only the owner lock can keep the draft.
      const rows = await store.listRecoverableAutosaveDrafts({ now: Date.now() + 60 * 60_000 });
      return rows.map((row) => row.id);
    });
    assert.deepEqual(await listRecoverable(), [], 'the owner page still holds its lock');
    await owner.close();
    // The browser drops a closed page's locks asynchronously, so page.close() can resolve
    // a moment before the lock manager sees it. No heartbeat has to expire, though.
    const deadline = Date.now() + 5_000;
    let recoverable = await listRecoverable();
    while (recoverable.length === 0 && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      recoverable = await listRecoverable();
    }
    assert.deepEqual(recoverable, ['owned-draft']);
  } finally {
    if (!owner.isClosed()) await owner.close();
    await observer.close();
  }
});
