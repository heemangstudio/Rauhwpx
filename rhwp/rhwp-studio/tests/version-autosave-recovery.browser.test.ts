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
    cacheDir: resolve(studioRoot, 'node_modules/.vite-autosave-recovery-browser-test'),
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
      name: 'autosave-recovery-test-samples',
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
 * 기준(B)에서 디스크(D)는 앞에, 자동 저장본(R)은 뒤에 글을 더한다. 페이지에 D 를 연 컨트롤러를
 * 만들고, priorHistory 면 B 와 다른 내용으로 버전 기록을 미리 켜 둔다.
 */
async function setUp(page: Page, priorHistory: boolean): Promise<void> {
  await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
  await page.evaluate(async (withHistory) => {
    const [wasmModule, eventModule, dirtyModule, versioning, controllerModule, snapshotModule] = await Promise.all([
      import('/src/core/wasm-bridge.ts'),
      import('/src/core/event-bus.ts'),
      import('/src/core/document-dirty-state.ts'),
      import('/src/versioning/index.ts'),
      import('/src/versioning/controller.ts'),
      import('/src/versioning/snapshot.ts'),
    ]);
    const fileName = 'shift-return.hwp';
    const wasm = new wasmModule.WasmBridge();
    await wasm.initialize();
    wasm.loadDocument(new Uint8Array(await (await fetch(`/samples/${fileName}`)).arrayBuffer()), fileName);
    const base = snapshotModule.captureVersionSnapshot(wasm);
    wasm.insertText(0, 0, 0, 'OLDER:');
    const older = snapshotModule.captureVersionSnapshot(wasm);
    wasm.loadDocument(base.bytes, fileName);
    wasm.insertText(0, 0, wasm.getParagraphLength(0, 0), ':DRAFT');
    const draft = snapshotModule.captureVersionSnapshot(wasm);
    wasm.loadDocument(base.bytes, fileName);
    wasm.insertText(0, 0, 0, 'DISK:');
    const disk = snapshotModule.captureVersionSnapshot(wasm);
    wasm.loadDocument(disk.bytes, fileName);

    const store = new versioning.VersionGraphStore({ indexedDB: null });
    if (withHistory) {
      await store.createRepository({
        documentId: versioning.documentId('recovered-document'),
        lastSavedFingerprint: older.fingerprint,
        initial: {
          bytes: older.bytes,
          compareSnapshot: older.compareSnapshot,
          contentFingerprint: older.fingerprint,
          title: 'Older',
          titleOrigin: 'manual',
          titleRevision: 0,
          author: { kind: 'user', label: 'Browser test' },
        },
      });
    }
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
    const controller = new controllerModule.DocumentVersionController({
      store,
      wasm,
      eventBus,
      documentState: dirty,
      getInputHandler: () => inputHandler as never,
      getDocumentId: () => 'recovered-document',
      agentBridge: {
        pendingEdits: { hasPending: () => false, onChange: () => () => undefined },
        onEvent: () => () => undefined,
        isTurnRunning: () => false,
        getPermissionProfile: () => 'safe',
        getActiveAgent: () => null,
        requestCheckpointTitle: async () => null,
      } as never,
    });
    await controller.documentLoaded();
    Object.assign(window, {
      __recovery: {
        controller, store, wasm, dirty, snapshot: snapshotModule, versioning,
        input: { draftId: 'draft-1234abcd-5678', baseBytes: base.bytes, draftBytes: draft.bytes },
        fingerprints: { base: base.fingerprint, disk: disk.fingerprint, draft: draft.fingerprint },
        completions: [] as boolean[],
      },
    });
  }, priorHistory);
}

async function recover(page: Page): Promise<{ enabledHistory: boolean }> {
  return page.evaluate(async () => {
    const r = (window as any).__recovery;
    const result = await r.controller.recoverAutosaveDraft(r.input);
    void result.completion.then((done: boolean) => r.completions.push(done));
    return { enabledHistory: result.enabledHistory };
  });
}

async function graph(page: Page) {
  return page.evaluate(async () => {
    const r = (window as any).__recovery;
    const repository = await r.store.findRepositoryByDocumentId(r.versioning.documentId('recovered-document'));
    const commits = await r.store.listCommits(repository.id, { limit: 50 });
    const main = await r.store.getBranch(repository.id, 'main');
    const recovery = await r.store.getBranch(repository.id, '복구 draft-12');
    const head = commits.find((commit: any) => commit.id === main.target);
    const relation = await r.store.getMergeRelation(repository.id, main.target, recovery.target);
    const byId = new Map(commits.map((commit: any) => [commit.id, commit]));
    return {
      count: commits.length,
      headTitle: head.title,
      headFingerprint: head.contentFingerprint,
      headParents: head.parents,
      lastSaved: repository.lastSavedFingerprint,
      mergeBaseFingerprints: relation.baseCommitIds.map((id: string) => (byId.get(id) as any)?.contentFingerprint),
      fingerprints: r.fingerprints,
      dirty: r.dirty.isDirty(),
      completions: [...r.completions],
    };
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
  }, { timeout: 20_000 });
  await page.click('.merge-resolver-footer .merge-primary-button');
  await page.waitForSelector('.merge-resolver-window', { hidden: true });
}

test('a draft whose file changed on disk merges against the draft base and stays unsaved', { timeout: 90_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await setUp(page, false);
    assert.deepEqual(await recover(page), { enabledHistory: true });
    await page.waitForSelector('.merge-resolver-window');
    const opened = await graph(page);
    // B(자동 저장 기준) → D(외부 변경), B → R(자동 저장된 변경). 병합 기준은 B 다.
    assert.equal(opened.count, 3);
    assert.equal(opened.headTitle, '외부 변경');
    assert.equal(opened.headFingerprint, opened.fingerprints.disk);
    assert.equal(opened.lastSaved, opened.fingerprints.disk);
    assert.deepEqual(opened.mergeBaseFingerprints, [opened.fingerprints.base]);
    assert.equal(opened.dirty, false);

    // 병합하지 않고 닫으면 draft 를 남긴다. 다시 복구해도 커밋을 중복으로 만들지 않는다.
    await page.click('.merge-close-button');
    await page.waitForSelector('.merge-resolver-window', { hidden: true });
    assert.deepEqual((await graph(page)).completions, [false]);
    assert.deepEqual(await recover(page), { enabledHistory: false });
    assert.equal((await graph(page)).count, 3);

    await completeMerge(page);
    const merged = await graph(page);
    assert.deepEqual(merged.completions, [false, true]);
    assert.equal(merged.dirty, true, 'the merged result is unsaved until the user saves');
    assert.equal(merged.lastSaved, merged.fingerprints.disk);
    const text = await page.evaluate(() => {
      const r = (window as any).__recovery;
      return r.snapshot.captureVersionSnapshot(r.wasm).compareSnapshot.paragraphs[0]?.text as string;
    });
    assert.match(text, /^DISK:/);
    assert.match(text, /:DRAFT$/);
  } finally {
    await page.close();
  }
});

test('existing history that moved past the draft base still merges against that base', { timeout: 90_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await setUp(page, true);
    assert.deepEqual(await recover(page), { enabledHistory: false });
    await page.waitForSelector('.merge-resolver-window');
    const opened = await graph(page);
    assert.equal(opened.headTitle, '외부 변경');
    assert.equal(opened.headParents.length, 2, 'the disk commit also descends from the draft base');
    assert.equal(opened.dirty, false, 'the open document is the disk file, so it is clean until the merge');
    assert.deepEqual(opened.mergeBaseFingerprints, [opened.fingerprints.base]);
    await completeMerge(page);
    assert.deepEqual((await graph(page)).completions, [true]);
  } finally {
    await page.close();
  }
});
