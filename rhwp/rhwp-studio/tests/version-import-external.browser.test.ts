import { browserExecutable, browserLaunchArgs, requireWasmPackage } from './browser-support.ts';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';

import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { createServer, type ViteDevServer } from 'vite';

const executablePath = browserExecutable();
const studioRoot = fileURLToPath(new URL('../', import.meta.url));
const rhwpRoot = resolve(studioRoot, '..');
const wasmPackageRoot = process.env.RHWP_WASM_PACKAGE_DIR ?? resolve(rhwpRoot, 'pkg');
requireWasmPackage(wasmPackageRoot);
let server: ViteDevServer | null = null;
let browser: Browser | null = null;
let baseUrl = '';

test.before(async () => {
  server = await createServer({
    root: studioRoot,
    configFile: false,
    cacheDir: resolve(studioRoot, 'node_modules/.vite-import-external-browser-test'),
    logLevel: 'silent',
    resolve: {
      alias: {
        '@': resolve(studioRoot, 'src'),
        '@wasm/rhwp.js': resolve(wasmPackageRoot, 'rhwp.js'),
        '@wasm': wasmPackageRoot,
      },
    },
    server: {
      host: '127.0.0.1',
      port: 0,
      hmr: false,
      fs: { allow: [studioRoot, wasmPackageRoot, resolve(rhwpRoot, 'samples')] },
    },
    plugins: [{
      name: 'import-external-test-samples',
      configureServer(vite) {
        vite.middlewares.use('/samples', (request, response, next) => {
          const relative = decodeURIComponent(request.url?.split('?')[0] ?? '').replace(/^\/+/, '');
          if (!relative || relative.includes('..')) return next();
          void readFile(resolve(rhwpRoot, 'samples', relative)).then((bytes) => {
            response.setHeader('Content-Type', 'application/octet-stream');
            response.end(bytes);
          }, () => {
            response.statusCode = 404;
            response.end();
          });
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await puppeteer.launch({ executablePath, headless: true, args: browserLaunchArgs() });
});

test.after(async () => {
  await browser?.close();
  await server?.close();
});

/**
 * v1 은 문단 여덟 개짜리 문서다. 외부 사본은 v1 에서 마지막 문단을 고쳤고, 원본은 그 뒤 첫 문단과 셋째
 * 문단을 고쳐 v2, v3 로 커밋했다. 열린 문서는 v3 다.
 */
async function setUp(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
  await page.evaluate(async () => {
    const [wasmModule, eventModule, dirtyModule, versioning, controllerModule, snapshotModule] = await Promise.all([
      import('/src/core/wasm-bridge.ts'),
      import('/src/core/event-bus.ts'),
      import('/src/core/document-dirty-state.ts'),
      import('/src/versioning/index.ts'),
      import('/src/versioning/controller.ts'),
      import('/src/versioning/snapshot.ts'),
    ]);
    const fileName = 'shift-return.hwp';
    const sample = new Uint8Array(await (await fetch(`/samples/${fileName}`)).arrayBuffer());
    const build = async (lines: string[]): Promise<Uint8Array> => {
      const bridge = new wasmModule.WasmBridge();
      await bridge.initialize();
      bridge.loadDocument(sample, fileName);
      while (bridge.getParagraphCount(0) > 1) bridge.mergeParagraph(0, 1);
      bridge.deleteText(0, 0, 0, bridge.getParagraphLength(0, 0));
      lines.forEach((line, index) => {
        if (index > 0) bridge.splitParagraph(0, index - 1, bridge.getParagraphLength(0, index - 1));
        bridge.insertText(0, index, 0, line);
      });
      return snapshotModule.captureVersionSnapshot(bridge).bytes;
    };
    const original = Array.from({ length: 8 }, (_, index) => `문단 ${index + 1}: 원래 내용으로 쓴 문장입니다.`);
    const v1 = await build(original);
    const external = await build(original.map((line, index) => (index === 7 ? `${line} EXTERNAL` : line)));
    const unrelated = await build(Array.from({ length: 8 }, (_, index) => `Unrelated ${index} lorem ipsum dolor`));

    const wasm = new wasmModule.WasmBridge();
    await wasm.initialize();
    wasm.loadDocument(v1, fileName);
    const store = new versioning.VersionGraphStore({ indexedDB: null });
    const eventBus = new eventModule.EventBus();
    const dirty = new dirtyModule.DocumentDirtyState(eventBus);
    let locked = false;
    const inputHandler = {
      canRedo: () => false,
      prepareSnapshotCapacity: () => undefined,
      replaceContentFromBytes: (bytes: Uint8Array) => { wasm.replaceContentFromBytes(bytes); },
      performUndo: () => undefined,
      discardRedoHistory: () => undefined,
      discardLatestUndoHistory: () => undefined,
      isUserEditingLocked: () => locked,
      setUserEditingLocked: (next: boolean) => { locked = next; },
    };
    const opened: string[] = [];
    const controller = new controllerModule.DocumentVersionController({
      store,
      wasm,
      eventBus,
      documentState: dirty,
      getInputHandler: () => inputHandler as never,
      getDocumentId: () => 'import-document',
      agentBridge: {
        pendingEdits: { hasPending: () => false, onChange: () => () => undefined },
        onEvent: () => () => undefined,
        isTurnRunning: () => false,
        getEditingLease: () => ({ active: false }),
        requestCheckpointTitle: async () => null,
      } as never,
      worktreeHost: {
        ensureOwnership: async () => true,
        canMutate: () => true,
        getStatus: () => ({ isOpen: false, busy: false }),
        open: async (worktree: { branch: string }) => { opened.push(worktree.branch); },
        close: async () => undefined,
        remove: async () => true,
        merge: async () => undefined,
      },
    });
    await controller.documentLoaded();
    await controller.enable();
    const edit = async (paragraph: number, text: string) => {
      wasm.insertText(0, paragraph, 0, text);
      eventBus.emit('document-changed');
      await controller.checkpoint();
    };
    await edit(0, 'LOCAL ');
    await edit(2, 'LATER ');
    const repository = await store.findRepositoryByDocumentId(versioning.documentId('import-document'));
    const commits = await store.listCommits(repository!.id, { limit: 10 });
    const byOrdinal = [...commits].sort((left, right) => left.ordinal - right.ordinal);
    const v2Blob = await store.getBlob(byOrdinal[1].blobId);
    Object.assign(window, {
      __import: {
        controller, store, wasm, snapshot: snapshotModule, versioning, opened, repositoryId: repository!.id,
        files: { external, unrelated, v2: v2Blob!.bytes },
        ids: { v1: byOrdinal[0].id, v2: byOrdinal[1].id, v3: byOrdinal[2].id },
      },
    });
  });
}

async function completeMerge(page: Page): Promise<void> {
  await page.waitForSelector('.merge-resolver-window');
  await page.click('.merge-resolver-header-actions button:first-child');
  await page.evaluate(() => {
    const ids = [...document.querySelectorAll<HTMLButtonElement>('.merge-conflict-item:not(.is-resolved)')]
      .map((node) => node.dataset.conflictId);
    for (const id of ids) {
      [...document.querySelectorAll<HTMLButtonElement>('.merge-conflict-item')]
        .find((node) => node.dataset.conflictId === id)?.click();
      [...document.querySelectorAll<HTMLButtonElement>('.merge-resolution-button')]
        .find((node) => node.textContent?.startsWith('✓'))?.click();
    }
  });
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>('.merge-resolver-footer .merge-primary-button');
    return Boolean(button && !button.disabled);
  }, { timeout: 30_000 });
  await page.click('.merge-resolver-footer .merge-primary-button');
  await page.waitForSelector('.merge-resolver-window', { hidden: true, timeout: 30_000 });
}

test('base detection prefers an identical commit, then the closest ancestor, and asks for an unrelated file', { timeout: 90_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await setUp(page);
    const result = await page.evaluate(async () => {
      const r = (window as any).__import;
      const detect = (bytes: Uint8Array) => r.controller.detectImportBase({ fileName: '받은 문서.hwp', bytes });
      return {
        ids: r.ids,
        exact: await detect(r.files.v2),
        external: await detect(r.files.external),
        unrelated: await detect(r.files.unrelated),
      };
    });
    assert.equal(result.exact.exactCommitId, result.ids.v2);
    assert.equal(result.external.exactCommitId, null);
    assert.equal(result.external.suggestedCommitId, result.ids.v1, 'the copy branched from v1, before both local edits');
    assert.deepEqual(
      new Set(result.external.candidates.map((candidate: { id: string }) => candidate.id)),
      new Set([result.ids.v1, result.ids.v2, result.ids.v3]),
    );
    assert.equal(result.unrelated.suggestedCommitId, null, 'an unrelated file leaves the choice to the user');
    assert.ok(result.unrelated.candidates.length > 0);
  } finally {
    await page.close();
  }
});

test('merging a received copy keeps both sides and records a two-parent merge without a branch', { timeout: 120_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await setUp(page);
    await page.evaluate(() => {
      const r = (window as any).__import;
      void r.controller.importExternal(r.files.external, { fileName: '검토본.hwp', baseCommitId: r.ids.v1 });
    });
    await completeMerge(page);
    const merged = await page.evaluate(async () => {
      const r = (window as any).__import;
      await r.controller.whenIdle();
      const main = await r.store.getBranch(r.repositoryId, 'main');
      const head = await r.store.getCommit(main.target);
      const incoming = await r.store.getCommit(head.parents[1]);
      const refs = await r.store.listRefs(r.repositoryId);
      const text = r.snapshot.captureVersionSnapshot(r.wasm).compareSnapshot.paragraphs
        .map((paragraph: { text: string }) => paragraph.text);
      const view = r.controller.getState().commits;
      return {
        ids: r.ids,
        head: { parents: head.parents, reason: head.reason, merge: head.merge },
        incoming: { parents: incoming.parents, reason: incoming.reason, importedFrom: incoming.importedFrom },
        branchNames: refs.filter((ref: { kind: string }) => ref.kind === 'branch').map((ref: { name: string }) => ref.name),
        text,
        labels: view.filter((commit: { sourceFileName?: string }) => commit.sourceFileName).map((commit: { id: string }) => commit.id),
        mergeHeadId: main.target,
        incomingId: incoming.id,
        drafts: r.controller.getState().mergeDrafts.length,
      };
    });
    assert.equal(merged.head.reason, 'merge');
    assert.equal(merged.head.parents[0], merged.ids.v3);
    assert.equal(merged.head.merge.sourceFileName, '검토본.hwp');
    assert.deepEqual(merged.head.merge.baseCommitIds, [merged.ids.v1]);
    assert.equal(merged.incoming.reason, 'import');
    assert.deepEqual(merged.incoming.parents, [merged.ids.v1]);
    assert.deepEqual(merged.incoming.importedFrom, { fileName: '검토본.hwp' });
    assert.deepEqual(merged.branchNames, ['main']);
    assert.equal(merged.drafts, 0);
    assert.match(merged.text[0], /^LOCAL /);
    assert.match(merged.text[2], /^LATER /);
    assert.match(merged.text[7], / EXTERNAL$/);
    assert.deepEqual(new Set(merged.labels), new Set([merged.mergeHeadId, merged.incomingId]));
  } finally {
    await page.close();
  }
});

test('importing as a branch switches to it, and as a worktree opens it without touching the current branch', { timeout: 90_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await setUp(page);
    const result = await page.evaluate(async () => {
      const r = (window as any).__import;
      await r.controller.importExternal(r.files.external, {
        fileName: '검토본.hwp', baseCommitId: r.ids.v1, branchName: '검토본',
      });
      const afterBranch = r.controller.getState();
      const branch = await r.store.getBranch(r.repositoryId, '검토본');
      const imported = await r.store.getCommit(branch.target);
      const text = r.snapshot.captureVersionSnapshot(r.wasm).compareSnapshot.paragraphs
        .map((paragraph: { text: string }) => paragraph.text);

      await r.controller.switchBranch('main');
      await r.controller.importExternal(r.files.external, {
        fileName: '검토본.hwp', baseCommitId: r.ids.v1, branchName: '검토본-2', openAsWorktree: true,
      });
      const worktrees = await r.store.listWorktrees(r.repositoryId);
      return {
        ids: r.ids,
        activeAfterBranch: afterBranch.activeBranch,
        imported: { parents: imported.parents, reason: imported.reason },
        text,
        activeAfterWorktree: r.controller.getState().activeBranch,
        opened: [...r.opened],
        worktree: worktrees.find((worktree: { branch: string }) => worktree.branch === '검토본-2'),
      };
    });
    assert.equal(result.activeAfterBranch, '검토본');
    assert.equal(result.imported.reason, 'import');
    assert.deepEqual(result.imported.parents, [result.ids.v1]);
    assert.doesNotMatch(result.text[0], /^LOCAL /);
    assert.match(result.text[7], / EXTERNAL$/);
    assert.equal(result.activeAfterWorktree, 'main');
    assert.deepEqual(result.opened, ['검토본-2']);
    assert.equal(result.worktree?.mergeTarget?.name, 'main');
  } finally {
    await page.close();
  }
});
