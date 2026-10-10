import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import puppeteer, { type Browser, type Page } from 'puppeteer-core';
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
    cacheDir: resolve(studioRoot, 'node_modules/.vite-rebrand-import-test'),
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

type Fixture = typeof import('./fixtures/rebrand-storage.ts');
type Importer = typeof import('../src/core/rebrand-storage-import.ts');

/** Each step runs in a freshly loaded page so store modules re-read IndexedDB like a new launch. */
async function step<T>(page: Page, run: (fixture: Fixture, importer: Importer) => Promise<T>): Promise<T> {
  await page.goto(pageUrl);
  return page.evaluate(async (source) => {
    const fixture = await import('/tests/fixtures/rebrand-storage.ts');
    const importer = await import('/src/core/rebrand-storage-import.ts');
    // eslint-disable-next-line no-new-func
    return new Function('fixture', 'importer', `return (${source})(fixture, importer);`)(fixture, importer);
  }, run.toString()) as Promise<T>;
}

async function seedBothGenerations(page: Page) {
  await step(page, (fixture) => fixture.reset());
  // What 2.0.11 wrote during its day, under its own names.
  await step(page, async (fixture) => {
    await fixture.writeGeneration('2011', 'doc-2011');
    await fixture.moveToRebrandedNames();
    localStorage.setItem('hamaeditor-settings', '{"theme":{"mode":"light"}}');
    localStorage.setItem('hamaeditor-agent-sidebar-width-v3', '612');
    localStorage.setItem('hamaeditor-agent-doc-order', '["id:doc-2011"]');
  });
  // What 2.0.10 already had under the original names.
  await step(page, async (fixture) => {
    await fixture.writeGeneration('2010', 'doc-2010');
    localStorage.setItem('rhwp-settings', '{"theme":{"mode":"dark"}}');
    localStorage.setItem('rhwp-agent-doc-order', '["id:doc-2010"]');
  });
}

test('2.0.11 chats, drafts, recent files, versions and settings join the original stores', { timeout: 60_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  await seedBothGenerations(page);

  await step(page, (_fixture, importer) => importer.runRebrandedStorageImport());
  const merged = await step(page, (fixture) => fixture.readCanonical());

  assert.deepEqual(merged.threads, [
    { id: 'thread-2010', documentId: 'doc-2010' },
    { id: 'thread-2011', documentId: 'doc-2011' },
  ]);
  assert.deepEqual(merged.drafts, ['draft-2010', 'draft-2011']);
  assert.ok(merged.recoverable.includes('draft-2011'), '2.0.11 unsaved work is offered for recovery');
  assert.deepEqual(merged.recent, ['doc-2010', 'doc-2011']);
  assert.deepEqual(merged.repositories, { 'doc-2010': 1, 'doc-2011': 1 });
  // An existing 2.0.10 value wins; values only 2.0.11 had are added; lists are joined.
  assert.equal(merged.settings, '{"theme":{"mode":"dark"}}');
  assert.equal(merged.sidebarWidth, '612');
  assert.deepEqual(merged.docOrder, ['id:doc-2010', 'id:doc-2011']);

  // The 2.0.11 source stays; a chat deleted after the import does not come back.
  const names = await step(page, (fixture) => fixture.databaseNames());
  assert.ok(names.includes('hamaeditorAgentThreads') && names.includes('hamaeditorVersionGraph'));
  await step(page, (fixture) => fixture.removeImportedThread());
  await step(page, (_fixture, importer) => importer.runRebrandedStorageImport());
  const afterDelete = await step(page, (fixture) => fixture.readCanonical());
  assert.deepEqual(afterDelete.threads.map((thread) => thread.id), ['thread-2010']);
  await page.close();
});

test('a desktop dump of the 2.0.11 profile attaches same-file chats and history to the 2.0.10 document', { timeout: 60_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  await seedBothGenerations(page);

  // The desktop app hands Studio a dump of the other profile plus aliases from merged bookmarks.
  const outcome = await step(page, async (_fixture, importer) => {
    const dump = await importer.dumpRebrandedStorage();
    if (!dump) throw new Error('no 2.0.11 storage found');
    for (const name of ['hamaeditorAgentThreads', 'hamaeditorAutosave', 'hamaeditorRecent', 'hamaeditorVersionGraph']) {
      await new Promise((resolve) => { indexedDB.deleteDatabase(name).onsuccess = resolve; });
    }
    for (const key of Object.keys(localStorage)) if (key.startsWith('hamaeditor')) localStorage.removeItem(key);
    const result = await importer.importRebrandedStorage(dump, {
      documentIdAliases: { 'doc-2011': 'doc-2010-same-file' },
    });
    return { failures: result.failures, repositories: result.repositories };
  });
  assert.deepEqual(outcome, { failures: [], repositories: 1 });

  const merged = await step(page, (fixture) => fixture.readCanonical());
  assert.deepEqual(merged.threads, [
    { id: 'thread-2010', documentId: 'doc-2010' },
    { id: 'thread-2011', documentId: 'doc-2010-same-file' },
  ]);
  assert.deepEqual(merged.repositories, { 'doc-2010': 1, 'doc-2010-same-file': 1 });
  assert.deepEqual(merged.drafts, ['draft-2010', 'draft-2011']);
  await page.close();
});

test('an older original store is upgraded by its own module before 2.0.11 drafts join it', { timeout: 60_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  await step(page, (fixture) => fixture.reset());
  await step(page, async (fixture) => {
    await fixture.writeGeneration('2011', 'doc-2011');
    await fixture.moveToRebrandedNames();
  });
  await step(page, (fixture) => fixture.writeVersion2Autosave());

  await step(page, (_fixture, importer) => importer.runRebrandedStorageImport());

  assert.deepEqual(await step(page, (fixture) => fixture.listDraftIds()), ['draft-2007', 'draft-2011']);
  await page.close();
});

test('a store that fails stays retryable while records already merged are never added again', { timeout: 60_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  await step(page, (fixture) => fixture.reset());
  await step(page, async (fixture) => {
    await fixture.writeGeneration('2011', 'doc-2011');
    await fixture.moveToRebrandedNames();
    await fixture.bumpRebrandedVersion('hamaeditorAutosave', 9);
  });

  const first = await step(page, async (_fixture, importer) => {
    const dump = await importer.dumpRebrandedStorage();
    const result = await importer.importRebrandedStorage(dump!);
    return { complete: result.complete, failures: result.failures, ledger: result.ledger };
  });
  assert.equal(first.complete, false);
  assert.ok(first.failures.some((failure) => failure.startsWith('rhwpStudioAutosave')), 'a version the build cannot read is a failure');
  assert.deepEqual(await step(page, (fixture) => fixture.canonicalThreadIds()), ['thread-2011']);

  // The user deletes the imported chat; the next attempt retries only what failed.
  await step(page, (fixture) => fixture.deleteCanonicalThread('thread-2011'));
  const second = await page.evaluate(async (ledger) => {
    const importer = await import('/src/core/rebrand-storage-import.ts');
    const dump = await importer.dumpRebrandedStorage();
    const result = await importer.importRebrandedStorage(dump!, { ledger });
    return { complete: result.complete, records: result.records };
  }, first.ledger);
  assert.deepEqual(second, { complete: false, records: 0 });
  assert.deepEqual(await step(page, (fixture) => fixture.canonicalThreadIds()), []);
  await page.close();
});

test('one record that cannot be stored is skipped and the rest of its store still joins', { timeout: 60_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  await step(page, (fixture) => fixture.reset());
  const result = await step(page, async (_fixture, importer) => {
    const recent = (id: string) => ({
      id, documentId: `doc-${id}`, sourceDigest: `sha256:${id}`, fileName: `${id}.hwpx`, sourceFormat: 'hwpx', openedAt: 1,
    });
    const outcome = await importer.importRebrandedStorage({
      localStorage: [],
      databases: [{
        name: 'hamaeditorRecent',
        version: 2,
        stores: [{
          name: 'recent', keyPath: 'id', autoIncrement: false, indexes: [],
          records: [
            { key: 'broken', value: { ...recent('broken'), handle: () => undefined } },
            { key: 'kept', value: recent('kept') },
          ],
        }],
      }],
    });
    return { complete: outcome.complete, records: outcome.records, skipped: outcome.skipped.length };
  });
  assert.deepEqual(result, { complete: true, records: 1, skipped: 1 });
  assert.deepEqual(await step(page, (fixture) => fixture.listRecentIds()), ['kept']);
  await page.close();
});

test('a database the desktop could not read keeps the import open while the rest joins', { timeout: 60_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  await step(page, (fixture) => fixture.reset());
  const result = await step(page, async (_fixture, importer) => {
    const thread = (id: string) => ({
      id, title: id, createdAt: 1, updatedAt: 2, agent: 'claude', model: 'sonnet', effort: 'high',
      messages: [{ role: 'user', text: id }],
    });
    const outcome = await importer.importRebrandedStorage(importer.assembleRebrandedChunks([
      { kind: 'localStorage', entries: [] },
      {
        kind: 'database', name: 'hamaeditorAgentThreads', version: 1,
        stores: [{ name: 'threads', keyPath: 'id', autoIncrement: false, indexes: [] }],
      },
      { kind: 'records', database: 'hamaeditorAgentThreads', store: 'threads', records: [{ key: 'thread-ok', value: thread('thread-ok') }] },
      { kind: 'skipped', database: 'hamaeditorAgentThreads', store: 'threads', key: 'thread-huge', reason: 'too large' },
      { kind: 'error', database: 'hamaeditorAutosave', message: 'reader stopped' },
    ]));
    return {
      complete: outcome.complete,
      failed: outcome.failures.some((failure) => failure.startsWith('rhwpStudioAutosave')),
      threadLedger: outcome.ledger['rhwpAgentThreads/threads']?.slice().sort(),
    };
  });
  assert.deepEqual(result, { complete: false, failed: true, threadLedger: ['"thread-huge"', '"thread-ok"@2'] });
  assert.deepEqual(await step(page, (fixture) => fixture.canonicalThreadIds()), ['thread-ok']);
  await page.close();
});

test('a full Local Storage cannot make a deleted chat come back on the next load', { timeout: 60_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  await step(page, (fixture) => fixture.reset());
  await step(page, async (fixture) => {
    await fixture.writeGeneration('2011', 'doc-2011');
    await fixture.moveToRebrandedNames();
  });

  await step(page, async (fixture, importer) => {
    fixture.fillMarkerQuota();
    await importer.runRebrandedStorageImport();
  });
  assert.deepEqual(await step(page, (fixture) => fixture.canonicalThreadIds()), ['thread-2011']);
  await step(page, (fixture) => fixture.deleteCanonicalThread('thread-2011'));

  await step(page, async (fixture, importer) => {
    fixture.fillMarkerQuota();
    await importer.runRebrandedStorageImport();
  });
  assert.deepEqual(await step(page, (fixture) => fixture.canonicalThreadIds()), []);
  await page.close();
});

test('2.0.11 data in an older format is upgraded by the store module instead of being refused', { timeout: 60_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  await step(page, (fixture) => fixture.reset());
  // A 2.0.11 profile whose autosave database still has the version 2 layout (no metadata store).
  await step(page, (fixture) => fixture.writeVersion2Autosave('hamaeditorAutosave', 'draft-old-format'));

  await step(page, (_fixture, importer) => importer.runRebrandedStorageImport());

  assert.deepEqual(await step(page, (fixture) => fixture.listDraftIds()), ['draft-old-format']);
  assert.ok(!(await step(page, (fixture) => fixture.databaseNames())).some((name) => name.startsWith('rhwpRebrandStaging')));
  await page.close();
});

test('a chat that changed in 2.0.11 after it was imported is refreshed, but never brought back once deleted', { timeout: 60_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  await step(page, (fixture) => fixture.reset());
  const outcome = await step(page, async (fixture, importer) => {
    const dumpWith = (updatedAt: number, text: string) => importer.assembleRebrandedChunks([
      {
        kind: 'database', name: 'hamaeditorAgentThreads', version: 1,
        stores: [{ name: 'threads', keyPath: 'id', autoIncrement: false, indexes: [] }],
      },
      {
        kind: 'records', database: 'hamaeditorAgentThreads', store: 'threads', records: [{
          key: 'thread-2011',
          value: {
            id: 'thread-2011', title: 'chat', createdAt: 1, updatedAt, agent: 'claude', model: 'sonnet', effort: 'high',
            messages: [{ role: 'user', text }],
          },
        }],
      },
    ]);
    const readText = async () => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const request = indexedDB.open('rhwpAgentThreads');
        request.onsuccess = () => resolve(request.result);
      });
      const row = await new Promise<{ messages: Array<{ text: string }> } | undefined>((resolve) => {
        const request = db.transaction('threads').objectStore('threads').get('thread-2011');
        request.onsuccess = () => resolve(request.result);
      });
      db.close();
      return row?.messages.at(-1)?.text ?? null;
    };
    const first = await importer.importRebrandedStorage(dumpWith(100, 'first'));
    const refreshed = await importer.importRebrandedStorage(dumpWith(200, 'continued in 2.0.11'), { ledger: first.ledger });
    const afterRefresh = await readText();
    await fixture.deleteCanonicalThread('thread-2011');
    await importer.importRebrandedStorage(dumpWith(300, 'even later'), { ledger: refreshed.ledger });
    return { afterRefresh, afterDelete: await readText() };
  });
  assert.deepEqual(outcome, { afterRefresh: 'continued in 2.0.11', afterDelete: null });
  await page.close();
});
