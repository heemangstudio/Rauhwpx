import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import puppeteer, { type Browser } from 'puppeteer-core';
import { createServer, type ViteDevServer } from 'vite';
import { browserExecutable, browserLaunchArgs, requireWasmPackage } from './browser-support.ts';

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
    cacheDir: resolve(studioRoot, 'node_modules/.vite-version-save-baseline-test'),
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
      name: 'version-save-baseline-sample',
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
  browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
});

test.after(async () => {
  await browser?.close();
  await server?.close();
});

test('linked worktrees checkpoint creation, persist local edits and protect occupied branches', { timeout: 45_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
    const result = await page.evaluate(async () => {
      const [{ WasmBridge }, { EventBus }, { DocumentDirtyState }, versions, { DocumentVersionController }, snapshots] = await Promise.all([
        import('/src/core/wasm-bridge.ts'), import('/src/core/event-bus.ts'),
        import('/src/core/document-dirty-state.ts'), import('/src/versioning/index.ts'),
        import('/src/versioning/controller.ts'), import('/src/versioning/snapshot.ts'),
      ]);
      const response = await fetch('/samples/shift-return.hwp');
      const wasm = new WasmBridge();
      await wasm.initialize();
      wasm.loadDocument(new Uint8Array(await response.arrayBuffer()), 'shift-return.hwp');
      const eventBus = new EventBus();
      const dirty = new DocumentDirtyState(eventBus);
      const store = new versions.VersionGraphStore({ indexedDB: null });
      const opened: import('/src/versioning/types.ts').VersionWorktree[] = [];
      let writable = true;
      const controller = new DocumentVersionController({
        store, wasm, eventBus, documentState: dirty, getDocumentId: () => 'worktree-primary',
        getInputHandler: () => ({
          canRedo: () => false,
          prepareSnapshotCapacity() {},
          replaceContentFromBytes(bytes: Uint8Array) { wasm.loadDocument(bytes, 'shift-return.hwp'); eventBus.emit('document-changed'); },
        }) as never,
        agentBridge: {
          pendingEdits: { hasPending: () => false, onChange: () => () => undefined },
          onEvent: () => () => undefined, isTurnRunning: () => false,
          getEditingLease: () => ({ active: false, agent: 'codex' as const }),
          requestCheckpointTitle: async () => null,
        },
        worktreeHost: {
          ensureOwnership: async () => writable, canMutate: () => writable,
          getStatus: () => ({ isOpen: true, busy: false }),
          open: async (worktree) => { opened.push(worktree); await controller.persistWorktree(); },
          close: async () => { await controller.persistWorktree(); },
          remove: async () => false, merge: async () => {},
        },
      });
      try {
        await controller.documentLoaded();
        await controller.enable();
        wasm.insertText(0, 0, 0, 'CHECKPOINT ');
        dirty.markDirty('typing'); eventBus.emit('document-mutated');
        const createdFingerprint = snapshots.fingerprintVersionContent(wasm);
        await controller.createWorktree('main', 'experiment');
        const fork = opened[0]!;
        const repo = (await store.findRepositoryByDocumentId(versions.documentId('worktree-primary')))!;
        const sourceHead = (await store.getBranch(repo.id, versions.branchName('main')))!;
        const createdCommit = (await store.getCommit(sourceHead.target))!;
        let occupiedSwitch = false;
        try { await controller.switchBranch('experiment'); } catch { occupiedSwitch = true; }
        let occupiedDelete = false;
        try { await controller.deleteBranch('experiment'); } catch { occupiedDelete = true; }
        await controller.removeWorktree(fork.id);
        const cancelledRemovalPreserved = Boolean(await store.getWorktree(fork.id));
        wasm.insertText(0, 0, 0, 'LOCAL ');
        dirty.markDirty('typing'); eventBus.emit('document-mutated');
        await controller.persistWorktree();
        const primary = (await store.findWorktreeByDocumentId(versions.documentId('worktree-primary')))!;
        const persisted = (await store.getBlob(primary.blobId))!;
        const probe = new WasmBridge(); await probe.initialize(); probe.loadDocument(persisted.bytes, 'shift-return.hwp');
        const persistedFingerprint = snapshots.fingerprintVersionContent(probe);
        probe.dispose();
        const secondaryWasm = new WasmBridge(); await secondaryWasm.initialize();
        secondaryWasm.loadDocument((await store.getBlob(fork.blobId))!.bytes, fork.fileName);
        const secondaryBus = new EventBus();
        const secondaryDirty = new DocumentDirtyState(secondaryBus);
        const secondary = new DocumentVersionController({
          store, wasm: secondaryWasm, eventBus: secondaryBus, documentState: secondaryDirty,
          getDocumentId: () => fork.documentId, getInputHandler: () => ({ canRedo: () => false }) as never,
          agentBridge: {
            pendingEdits: { hasPending: () => false, onChange: () => () => undefined },
            onEvent: () => () => undefined, isTurnRunning: () => false,
            getEditingLease: () => ({ active: false, agent: 'codex' as const }), requestCheckpointTitle: async () => null,
          },
        });
        let secondarySaved = false;
        let reopenedDirty = false;
        let primaryBaselineUnchanged = false;
        try {
          await secondary.documentLoaded();
          secondaryWasm.insertText(0, 0, 0, 'SECONDARY ');
          secondaryDirty.markDirty('typing'); secondaryBus.emit('document-mutated');
          await secondary.persistWorktree();
          secondaryDirty.markClean('reopen-initializes-clean');
          await secondary.documentLoaded();
          reopenedDirty = secondaryDirty.isDirty();
          await secondary.saveManagedWorktree();
          const savedSecondary = (await store.getWorktree(fork.id))!;
          secondarySaved = !secondaryDirty.isDirty()
            && savedSecondary.savedFingerprint === snapshots.fingerprintVersionContent(secondaryWasm);
          primaryBaselineUnchanged = (await store.getWorktree(primary.id))!.savedFingerprint === primary.savedFingerprint;
        } finally { secondary.dispose(); secondaryWasm.dispose(); }
        const ownerSnapshot = (await store.getWorktree(primary.id))!;
        writable = false;
        dirty.markClean('read-only-save');
        eventBus.emit('document-saved', { reason: 'save' });
        await controller.whenIdle();
        const readOnlySavePreserved = (await store.getWorktree(primary.id))!.revision === ownerSnapshot.revision;
        let ownershipDenied = false;
        try { await controller.checkpoint('denied'); } catch { ownershipDenied = true; }
        const currentFingerprint = snapshots.fingerprintVersionContent(wasm);
        writable = true;
        dirty.markClean('disk-save'); eventBus.emit('document-saved', { reason: 'save' });
        await controller.whenIdle();
        const beforeDiskReopen = (await store.getWorktree(primary.id))!;
        const preservedHead = (await store.getBranch(repo.id, versions.branchName('main')))!.target;
        wasm.insertText(0, 0, 0, 'EXTERNAL DISK ');
        dirty.markClean('disk-open');
        await controller.documentLoaded({ fromDisk: true });
        const reopened = (await store.getWorktree(primary.id))!;
        const externalDiskAdopted = !dirty.isDirty()
          && reopened.savedFingerprint === snapshots.fingerprintVersionContent(wasm)
          && reopened.baseCommitId === beforeDiskReopen.baseCommitId
          && (await store.getBranch(repo.id, versions.branchName('main')))!.target === preservedHead;
        wasm.insertText(0, 0, 0, 'LOCAL DRAFT ');
        dirty.markDirty('typing'); eventBus.emit('document-mutated'); await controller.persistWorktree();
        const localDraft = (await store.getWorktree(primary.id))!;
        wasm.insertText(0, 0, 0, 'OTHER DISK '); dirty.markClean('disk-open');
        await controller.documentLoaded({ fromDisk: true });
        const protectedDraft = (await store.getWorktree(primary.id))!;
        const dirtyDraftPreserved = protectedDraft.blobId === localDraft.blobId
          && protectedDraft.savedFingerprint === localDraft.savedFingerprint && dirty.isDirty();
        return {
          externalDiskAdopted, dirtyDraftPreserved,
          readOnlySavePreserved, secondarySaved, reopenedDirty, primaryBaselineUnchanged,
          distinctDocument: fork.documentId !== primary.documentId,
          sameRepository: fork.repositoryId === primary.repositoryId,
          createdFingerprint, checkpointFingerprint: createdCommit.contentFingerprint,
          mergeTarget: fork.mergeTarget?.name, branch: fork.branch,
          occupiedSwitch, occupiedDelete, cancelledRemovalPreserved,
          persistedFingerprint, currentFingerprint,
          independentSavedBaseline: primary.savedFingerprint !== persistedFingerprint,
          ownershipDenied, worktreeCount: controller.getState().worktrees.length,
        };
      } finally { controller.dispose(); await store.close(); wasm.dispose(); }
    });
    assert.equal(result.externalDiskAdopted, true);
    assert.equal(result.dirtyDraftPreserved, true);
    assert.equal(result.readOnlySavePreserved, true);
    assert.equal(result.secondarySaved, true);
    assert.equal(result.reopenedDirty, true);
    assert.equal(result.primaryBaselineUnchanged, true);
    assert.equal(result.distinctDocument, true);
    assert.equal(result.sameRepository, true);
    assert.equal(result.createdFingerprint, result.checkpointFingerprint);
    assert.equal(result.branch, 'experiment');
    assert.equal(result.mergeTarget, 'main');
    assert.equal(result.occupiedSwitch, true);
    assert.equal(result.occupiedDelete, true);
    assert.equal(result.cancelledRemovalPreserved, true);
    assert.equal(result.persistedFingerprint, result.currentFingerprint);
    assert.equal(result.independentSavedBaseline, true);
    assert.equal(result.ownershipDenied, true);
    assert.equal(result.worktreeCount, 2);
  } finally { await page.close(); }
});


test('occupied branch undo locks editing and verifies fallback compensation when redo is lost', { timeout: 45_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
    const result = await page.evaluate(async () => {
      const [{ WasmBridge }, { EventBus }, { DocumentDirtyState }, versions, { DocumentVersionController }, snapshots] = await Promise.all([
        import('/src/core/wasm-bridge.ts'), import('/src/core/event-bus.ts'),
        import('/src/core/document-dirty-state.ts'), import('/src/versioning/index.ts'),
        import('/src/versioning/controller.ts'), import('/src/versioning/snapshot.ts'),
      ]);
      const wasm = new WasmBridge(); await wasm.initialize();
      wasm.loadDocument(new Uint8Array(await (await fetch('/samples/shift-return.hwp')).arrayBuffer()), 'shift-return.hwp');
      const eventBus = new EventBus(); const dirty = new DocumentDirtyState(eventBus);
      const store = new versions.VersionGraphStore({ indexedDB: null });
      let locked = false;
      let priorBytes: Uint8Array | null = null;
      let undoHook: (() => void) | undefined;
      let replacementCount = 0;
      let fallbackDiscarded = false;
      const handler = {
        canRedo: () => false, prepareSnapshotCapacity() {},
        isUserEditingLocked: () => locked, setUserEditingLocked(value: boolean) { locked = value; },
        replaceContentFromBytes(bytes: Uint8Array, options?: { afterUndo?: () => void }) {
          replacementCount++;
          if (options) { priorBytes = snapshots.captureVersionSnapshot(wasm).bytes; undoHook = options.afterUndo; }
          wasm.loadDocument(bytes, 'shift-return.hwp'); eventBus.emit('document-changed');
        },
        performUndo() { wasm.loadDocument(priorBytes!, 'shift-return.hwp'); eventBus.emit('document-changed'); undoHook?.(); },
        performRedo() {}, // Simulate missing redo; reconciliation must verify then use exact bytes.
        discardLatestUndoHistory() { fallbackDiscarded = true; },
      };
      const controller = new DocumentVersionController({
        store, wasm, eventBus, documentState: dirty, getDocumentId: () => 'branch-history',
        getInputHandler: () => handler as never,
        agentBridge: {
          pendingEdits: { hasPending: () => false, onChange: () => () => undefined },
          onEvent: () => () => undefined, isTurnRunning: () => false,
          getEditingLease: () => ({ active: false, agent: 'codex' as const }), requestCheckpointTitle: async () => null,
        },
        worktreeHost: {
          ensureOwnership: async () => true, canMutate: () => true,
          getStatus: () => ({ isOpen: true, busy: false }),
          open: async () => {}, close: async () => {}, remove: async () => false, merge: async () => {},
        },
      });
      try {
        await controller.enable(); const initial = controller.getState().commits[0]!.id;
        wasm.insertText(0, 0, 0, 'ORIGINAL '); dirty.markDirty('typing'); eventBus.emit('document-mutated');
        await controller.checkpoint('original');
        await controller.createBranch('second', initial);
        await controller.createWorktree('main');
        const expected = snapshots.fingerprintVersionContent(wasm);
        let release!: () => void; let entered!: () => void;
        const paused = new Promise<void>((resolve) => { release = resolve; });
        const attempted = new Promise<void>((resolve) => { entered = resolve; });
        const originalSwitch = store.switchWorktreeBranch.bind(store);
        store.switchWorktreeBranch = async (input) => { entered(); await paused; return originalSwitch(input); };
        handler.performUndo();
        await attempted;
        const lockedDuringCAS = locked;
        release(); await controller.whenIdle();
        const restored = snapshots.fingerprintVersionContent(wasm);
        const primary = (await store.findWorktreeByDocumentId(versions.documentId('branch-history')))!;
        return { lockedDuringCAS, unlockedAfter: !locked, expected, restored,
          activeBranch: controller.getState().activeBranch, persistedBranch: primary.branch,
          fallbackDiscarded, replacementCount };
      } finally { controller.dispose(); await store.close(); wasm.dispose(); }
    });
    assert.equal(result.lockedDuringCAS, true);
    assert.equal(result.unlockedAfter, true);
    assert.equal(result.restored, result.expected);
    assert.equal(result.activeBranch, 'second');
    assert.equal(result.persistedBranch, 'second');
    assert.equal(result.fallbackDiscarded, true);
    assert.ok(result.replacementCount >= 2);
  } finally { await page.close(); }
});

test('after an engine trap, version history stops calling the engine but still keeps the worktree copy', { timeout: 45_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
    const result = await page.evaluate(async () => {
      const [{ WasmBridge }, { EventBus }, { DocumentDirtyState }, versions, { DocumentVersionController }, snapshots, hash, trap] = await Promise.all([
        import('/src/core/wasm-bridge.ts'), import('/src/core/event-bus.ts'),
        import('/src/core/document-dirty-state.ts'), import('/src/versioning/index.ts'),
        import('/src/versioning/controller.ts'), import('/src/versioning/snapshot.ts'),
        import('/src/versioning/hash.ts'), import('/src/core/engine-trap.ts'),
      ]);
      const wasm = new WasmBridge(); await wasm.initialize();
      wasm.loadDocument(new Uint8Array(await (await fetch('/samples/shift-return.hwp')).arrayBuffer()), 'shift-return.hwp');
      const eventBus = new EventBus(); const dirty = new DocumentDirtyState(eventBus);
      const store = new versions.VersionGraphStore({ indexedDB: null });
      const controller = new DocumentVersionController({
        store, wasm, eventBus, documentState: dirty, getDocumentId: () => 'trap-doc',
        getInputHandler: () => ({ canRedo: () => false, prepareSnapshotCapacity() {} }) as never,
        agentBridge: {
          pendingEdits: { hasPending: () => false, onChange: () => () => undefined },
          onEvent: () => () => undefined, isTurnRunning: () => false,
          getEditingLease: () => ({ active: false, agent: 'codex' as const }), requestCheckpointTitle: async () => null,
        },
        worktreeHost: {
          ensureOwnership: async () => true, canMutate: () => true,
          getStatus: () => ({ isOpen: true, busy: false }),
          open: async () => {}, close: async () => {}, remove: async () => false, merge: async () => {},
        },
      });
      const unhandled: string[] = [];
      window.addEventListener('unhandledrejection', (event) => {
        unhandled.push(String((event.reason as Error)?.message ?? event.reason));
      });
      try {
        await controller.documentLoaded();
        await controller.enable();
        wasm.insertText(0, 0, 0, 'BEFORE TRAP ');
        dirty.markDirty('typing'); eventBus.emit('document-mutated');
        const atTrap = snapshots.fingerprintVersionContent(wasm);

        // 엔진이 멈춘 뒤 엔진에 쪽 수를 묻는지 센다 (멈춘 엔진은 EngineTrappedError 로 거절한다).
        let engineReadsAfterTrap = 0;
        const pageCount = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(wasm), 'pageCount')!.get!;
        Object.defineProperty(wasm, 'pageCount', {
          configurable: true,
          get() {
            if (trap.engineTrap()) engineReadsAfterTrap += 1;
            return pageCount.call(this);
          },
        });
        // 갱신이 저장소를 읽는 사이 엔진이 멈춘다.
        const findRepository = store.findRepositoryByDocumentId.bind(store);
        let armed = true;
        store.findRepositoryByDocumentId = async (...args: Parameters<typeof findRepository>) => {
          const found = await findRepository(...args);
          if (armed) {
            armed = false;
            trap.reportEngineTrap(new WebAssembly.RuntimeError('unreachable'));
          }
          return found;
        };
        let refreshError = '';
        await controller.refresh().catch((error: Error) => { refreshError = error.message; });
        eventBus.emit('document-context-changed');
        await controller.refresh();
        await controller.whenIdle();
        let checkpointError = '';
        try { await controller.checkpoint('after the trap'); } catch (error) { checkpointError = (error as Error).message; }
        // 다시 불러오기 전(pagehide)의 작업 공간 저장은 내보내기만 써서 멈춘 엔진에서도 남는다.
        await controller.persistWorktree();
        const worktree = (await store.findWorktreeByDocumentId(versions.documentId('trap-doc')))!;
        const persisted = (await store.getBlob(worktree.blobId))!;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          trapped: Boolean(trap.engineTrap()),
          refreshError,
          engineReadsAfterTrap,
          blockedReason: controller.getState().mutationBlockedReason,
          checkpointError,
          worktreeKeptTrapContent: hash.fingerprintBytes(persisted.bytes) === atTrap,
          unhandled,
        };
      } finally { controller.dispose(); await store.close(); }
    });
    assert.equal(result.trapped, true);
    assert.equal(result.refreshError, '', 'a refresh caught by the trap ends quietly');
    assert.equal(result.engineReadsAfterTrap, 0, 'nothing asks the stopped engine for the document');
    assert.deepEqual(result.unhandled, [], 'no stopped-engine error escapes');
    assert.match(result.blockedReason ?? '', /문서 복구/, 'history actions are blocked with the recovery path');
    assert.match(result.checkpointError, /문서 복구/, 'a checkpoint is refused before it touches the engine');
    assert.equal(result.worktreeKeptTrapContent, true, 'the worktree still records the content at the trap');
  } finally { await page.close(); }
});
