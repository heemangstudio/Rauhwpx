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
