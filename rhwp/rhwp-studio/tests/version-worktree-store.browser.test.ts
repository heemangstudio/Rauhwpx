import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

test('IndexedDB workspaces survive close/reopen, reject concurrent claims, and preserve source history', { timeout: 30_000 }, async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false,
    logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/version-store-idb.html`);
    const observer = await browser.newPage();
    await observer.goto(`http://127.0.0.1:${address.port}/tests/fixtures/version-store-idb.html`);
    await observer.evaluate(async () => {
      const v = await import('/src/versioning/index.ts');
      const events: string[] = [];
      (window as unknown as { worktreeEvents: string[] }).worktreeEvents = events;
      new v.VersionGraphStore().subscribe((id) => events.push(id));
    });
    const result = await page.evaluate(async () => {
      const v = await import('/src/versioning/index.ts');
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(v.VERSION_DATABASE_NAME);
        request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
      });
      const initialBytes = new Uint8Array([1]);
      const initial = { bytes: initialBytes, contentFingerprint: v.fingerprintBytes(initialBytes),
        compareSnapshot: { meta: { name: 'browser', sectionCount: 0, pageCount: 0 }, paragraphs: [], controls: [] },
        title: 'Initial', titleRevision: 0, titleOrigin: 'manual' as const, author: { kind: 'user' as const, label: 'Tester' } };
      const store = new v.VersionGraphStore();
      const graph = await store.createRepository({ documentId: v.documentId('primary'), lastSavedFingerprint: initial.contentFingerprint, initial });
      const primary = await store.ensurePrimaryWorktree({ repositoryId: graph.repository.id, documentId: graph.repository.documentId,
        branch: graph.branch.name, fileName: 'primary.hwpx', sourceFormat: 'hwpx' });
      const otherStore = new v.VersionGraphStore();
      const events: string[] = [];
      const unsubscribe = otherStore.subscribe((id) => events.push(id));
      const create = { repositoryId: graph.repository.id, branch: graph.branch.name, fileName: 'draft.hwpx', sourceFormat: 'hwpx',
        expectedRepositoryRevision: graph.repository.revision, expectedBranchRevision: graph.branch.revision };
      const outcomes = await Promise.allSettled([
        store.createWorktree({ ...create, documentId: v.documentId('draft'), forkName: v.branchName('draft') }),
        otherStore.createWorktree({ ...create, documentId: v.documentId('other'), forkName: v.branchName('other') }),
      ]);
      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const draft = fulfilled[0].value;
      const saved = await store.saveWorktree({ id: draft.id, expectedRevision: draft.revision,
        bytes: new Uint8Array([7, 8, 9]), savedFingerprint: v.fingerprintBytes(new Uint8Array([7, 8, 9])) });
      await store.close();
      await otherStore.close();
      const reopened = new v.VersionGraphStore();
      const restored = (await reopened.findWorktreeByDocumentId(draft.documentId))!;
      const restoredBytes = (await reopened.getBlob(restored.blobId))!.bytes;
      const repository = (await reopened.getRepository(graph.repository.id))!;
      const collection = await reopened.collectGarbage(repository.id, repository.revision);
      const afterGc = await reopened.getBlob(restored.blobId);
      const portable = await reopened.exportRepositorySnapshot(repository.id, { activeBranch: primary.branch });
      let occupied = false;
      const current = (await reopened.getRepository(repository.id))!;
      try {
        await reopened.switchWorktreeBranch({ id: restored.id, expectedRevision: restored.revision, branch: primary.branch,
          expectedRepositoryRevision: current.revision, expectedBranchRevision: graph.branch.revision });
      } catch (error) { occupied = error instanceof v.VersionError && error.code === 'BRANCH_OCCUPIED'; }
      await reopened.deleteWorktree({ id: restored.id, expectedRevision: restored.revision });
      const sourceBranch = await reopened.getBranch(repository.id, restored.branch);
      const sourceCommit = await reopened.getCommit(restored.baseCommitId);
      const primaryAfter = await reopened.getWorktree(primary.id);
      const missing = await reopened.findWorktreeByDocumentId(restored.documentId);
      unsubscribe();
      await reopened.close();
      return { winners: fulfilled.length, revision: restored.revision, expectedRevision: saved.revision,
        bytes: [...restoredBytes], afterGc: Boolean(afterGc), portableContainsWorkingBlob: portable.blobs.some((blob) => blob.id === saved.blobId),
        occupied, sourceExists: Boolean(sourceBranch && sourceCommit), primarySaved: primaryAfter!.savedFingerprint,
        expectedPrimarySaved: primary.savedFingerprint, removed: missing === null, notifications: events.length,
        gcRemoved: collection.removedCommits };
    });
    await observer.waitForFunction(() => (window as unknown as { worktreeEvents: string[] }).worktreeEvents.length > 0,
      { timeout: 5_000 });
    assert.equal(result.winners, 1);
    assert.equal(result.revision, result.expectedRevision);
    assert.deepEqual(result.bytes, [7, 8, 9]);
    assert.equal(result.afterGc, true);
    assert.equal(result.portableContainsWorkingBlob, false);
    assert.equal(result.occupied, true);
    assert.equal(result.sourceExists, true);
    assert.equal(result.primarySaved, result.expectedPrimarySaved);
    assert.equal(result.removed, true);
    assert.ok(result.notifications >= 3);
  } finally { await browser?.close(); await server.close(); }
});
