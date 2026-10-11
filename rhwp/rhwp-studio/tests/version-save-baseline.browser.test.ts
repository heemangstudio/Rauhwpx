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

test('edits made while a save was writing are never recorded as the saved baseline', { timeout: 30_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
    const result = await page.evaluate(async () => {
      const [{ WasmBridge }, { EventBus }, { DocumentDirtyState }, versions, { DocumentVersionController }, snapshots] = await Promise.all([
        import('/src/core/wasm-bridge.ts'),
        import('/src/core/event-bus.ts'),
        import('/src/core/document-dirty-state.ts'),
        import('/src/versioning/index.ts'),
        import('/src/versioning/controller.ts'),
        import('/src/versioning/snapshot.ts'),
      ]);
      const response = await fetch('/samples/shift-return.hwp');
      const wasm = new WasmBridge();
      await wasm.initialize();
      wasm.loadDocument(new Uint8Array(await response.arrayBuffer()), 'shift-return.hwp');
      const eventBus = new EventBus();
      const dirty = new DocumentDirtyState(eventBus);
      const store = new versions.VersionGraphStore({ indexedDB: null });
      const agentBridge = {
        pendingEdits: { hasPending: () => false, onChange: () => () => undefined },
        onEvent: () => () => undefined,
        isTurnRunning: () => false,
        getEditingLease: () => ({ active: false, agent: 'codex' as const }),
        requestCheckpointTitle: async () => null,
      };
      const inputHandler = {
        canRedo: () => false,
        prepareSnapshotCapacity() {},
        replaceContentFromBytes(bytes: Uint8Array) {
          wasm.loadDocument(bytes, 'shift-return.hwp');
          eventBus.emit('document-changed');
        },
      };
      const controller = new DocumentVersionController({
        store, wasm, eventBus, documentState: dirty,
        getInputHandler: () => inputHandler as never,
        getDocumentId: () => 'save-baseline',
        agentBridge,
      });
      const lastSaved = async () => (await store.findRepositoryByDocumentId(
        versions.documentId('save-baseline'),
      ))?.lastSavedFingerprint;
      const saved = () => eventBus.emit('document-saved', { reason: 'save' });
      try {
        await controller.enable();
        const baseline = await lastSaved();

        // The file received the pre-edit bytes; this edit landed while they were written.
        wasm.insertText(0, 0, 0, 'LATE ');
        dirty.markDirty('typing-during-save');
        eventBus.emit('document-mutated');
        saved();
        await controller.whenIdle();
        const afterDirtySave = await lastSaved();

        // Restoring a checkpoint of those unsaved edits must leave them dirty.
        await controller.checkpoint('late edits');
        const lateCommit = controller.getState().commits[0]!;
        wasm.insertText(0, 0, 0, 'MORE ');
        dirty.markDirty('typing');
        eventBus.emit('document-mutated');
        await controller.restore(lateCommit.id);
        const dirtyAfterRestore = dirty.isDirty();

        // A save with no concurrent edits still records the live content.
        dirty.markClean('save');
        saved();
        await controller.whenIdle();
        return {
          baselineKept: afterDirtySave === baseline,
          dirtyAfterRestore,
          cleanSaveRecorded: await lastSaved() === snapshots.captureVersionSnapshot(wasm).fingerprint,
        };
      } finally {
        controller.dispose();
        await store.close();
        wasm.releaseDocument();
      }
    });
    assert.equal(result.baselineKept, true);
    assert.equal(result.dirtyAfterRestore, true);
    assert.equal(result.cleanSaveRecorded, true);
  } finally {
    await page.close();
  }
});

test('enabling history after unsaved edits records the saved content, not the edits', { timeout: 30_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
    const result = await page.evaluate(async () => {
      const [{ WasmBridge }, { EventBus }, { DocumentDirtyState }, versions, { DocumentVersionController }, snapshots] = await Promise.all([
        import('/src/core/wasm-bridge.ts'),
        import('/src/core/event-bus.ts'),
        import('/src/core/document-dirty-state.ts'),
        import('/src/versioning/index.ts'),
        import('/src/versioning/controller.ts'),
        import('/src/versioning/snapshot.ts'),
      ]);
      const bytes = new Uint8Array(await (await fetch('/samples/shift-return.hwp')).arrayBuffer());
      const wasm = new WasmBridge();
      await wasm.initialize();
      wasm.loadDocument(bytes, 'shift-return.hwp');
      const savedFingerprint = snapshots.fingerprintVersionContent(wasm);
      const savedText = wasm.getTextRange(0, 0, 0, 200);
      const eventBus = new EventBus();
      const dirty = new DocumentDirtyState(eventBus);
      const store = new versions.VersionGraphStore({ indexedDB: null });
      const controller = new DocumentVersionController({
        store, wasm, eventBus, documentState: dirty,
        getInputHandler: () => null,
        getDocumentId: () => 'enable-after-edit',
        agentBridge: {
          pendingEdits: { hasPending: () => false, onChange: () => () => undefined },
          onEvent: () => () => undefined,
          isTurnRunning: () => false,
          getEditingLease: () => ({ active: false, agent: 'codex' as const }),
          requestCheckpointTitle: async () => null,
        },
      });
      try {
        await controller.documentLoaded();
        wasm.insertText(0, 0, 0, 'UNSAVED ');
        dirty.markDirty('typing');
        eventBus.emit('document-mutated');
        await controller.enable();
        const head = await store.getCommit(controller.getState().commits[0]!.id);
        const snapshot = head ? await store.getCompareSnapshot(head.compareSnapshotId) : null;
        return {
          headIsSaved: head?.contentFingerprint === savedFingerprint,
          snapshotText: snapshot?.snapshot.paragraphs[0]?.text ?? null,
          savedText,
          liveText: wasm.getTextRange(0, 0, 0, 200),
          dirty: controller.getState().dirty,
        };
      } finally {
        controller.dispose();
        await store.close();
        wasm.releaseDocument();
      }
    });
    assert.equal(result.headIsSaved, true);
    assert.equal(result.snapshotText, result.savedText);
    assert.ok(result.liveText.startsWith('UNSAVED '));
    assert.equal(result.dirty, true);
  } finally {
    await page.close();
  }
});
