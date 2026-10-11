// 버전 기록 컨트롤러의 데이터 손실 방지 계약.
//
// 실제 DocumentVersionController·VersionGraphStore·WASM 문서를 브라우저에서 돌리고, 입력 처리기와
// 에이전트 브리지만 가짜로 둔다.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { createServer, type ViteDevServer } from 'vite';
import { browserExecutable, browserLaunchArgs, requireWasmPackage } from './browser-support.ts';

const studioRoot = fileURLToPath(new URL('../', import.meta.url));
const rhwpRoot = resolve(studioRoot, '..');
const wasmPackageRoot = process.env.RHWP_WASM_PACKAGE_DIR ?? resolve(rhwpRoot, 'pkg');
requireWasmPackage(wasmPackageRoot);
let server: ViteDevServer | null = null;
let browser: Browser | null = null;
let page: Page | null = null;

test.before(async () => {
  server = await createServer({
    root: studioRoot,
    configFile: false,
    cacheDir: resolve(studioRoot, 'node_modules/.vite-version-data-loss-test'),
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
      name: 'version-data-loss-sample',
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
  browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/version-store-idb.html`);
  // 시나리오마다 새 문서·저장소·컨트롤러를 만든다.
  await page.evaluate(async () => {
    const [{ WasmBridge }, { EventBus }, { DocumentDirtyState }, versions, { DocumentVersionController }] = await Promise.all([
      import('/src/core/wasm-bridge.ts'),
      import('/src/core/event-bus.ts'),
      import('/src/core/document-dirty-state.ts'),
      import('/src/versioning/index.ts'),
      import('/src/versioning/controller.ts'),
    ]);
    const sample = new Uint8Array(await (await fetch('/samples/shift-return.hwp')).arrayBuffer());
    (globalThis as any).versionHarness = async (documentId: string) => {
      const wasm = new WasmBridge();
      await wasm.initialize();
      wasm.loadDocument(sample.slice(), 'shift-return.hwp');
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
        performUndo() {},
        replaceContentFromBytes(bytes: Uint8Array) {
          wasm.loadDocument(bytes, 'shift-return.hwp');
          eventBus.emit('document-changed');
        },
      };
      let currentId = documentId;
      const controller = new DocumentVersionController({
        store, wasm, eventBus, documentState: dirty,
        getInputHandler: () => inputHandler as never,
        getDocumentId: () => currentId,
        agentBridge,
      });
      return {
        wasm, eventBus, dirty, store, controller, versions,
        setDocumentId(next: string) { currentId = next; },
        text: () => wasm.getTextRange(0, 0, 0, wasm.getParagraphLength(0, 0)),
        edit(text: string) {
          wasm.insertText(0, 0, 0, text);
          dirty.markDirty('typing');
          eventBus.emit('document-mutated');
        },
        async dispose() {
          controller.dispose();
          await store.close();
          wasm.releaseDocument();
        },
      };
    };
  });
});

test.after(async () => {
  await browser?.close();
  await server?.close();
});

test('version history refuses to adopt an unsaved document as its disk baseline', { timeout: 30_000 }, async () => {
  const result = await page!.evaluate(async () => {
    const h = await (globalThis as any).versionHarness('unsaved-baseline');
    try {
      h.edit('UNSAVED ');
      const error = await h.controller.enable().then(
        () => null,
        (e: Error & { cause?: { code?: string } }) => e.cause?.code ?? String(e.message),
      );
      const repository = await h.store.findRepositoryByDocumentId(h.versions.documentId('unsaved-baseline'));
      return { error, created: repository !== null && repository !== undefined };
    } finally {
      await h.dispose();
    }
  });
  assert.equal(result.error, 'SAVE_REQUIRED');
  assert.equal(result.created, false);
});

test('a restore or adopt whose commit fails puts the edited document back', { timeout: 30_000 }, async () => {
  const results = await page!.evaluate(async () => {
    const outcomes: Array<Record<string, unknown>> = [];
    for (const action of ['restore', 'adopt']) {
      const h = await (globalThis as any).versionHarness(`rollback-${action}`);
      try {
        await h.controller.enable();
        const base = h.controller.getState().commits[0].id;
        h.edit('SECOND ');
        await h.controller.checkpoint('second');
        h.edit('UNSAVED ');
        const edited = h.text();
        // 되돌릴 버전을 기록하는 마지막 커밋만 실패시킨다.
        const createCheckpoint = h.store.createCheckpoint.bind(h.store);
        h.store.createCheckpoint = async (input: { reason?: string }) => {
          if (input.reason === 'restore' || input.reason === action) throw new Error('quota exceeded');
          return createCheckpoint(input);
        };
        const error = await h.controller[action](base).then(() => null, (e: Error) => String(e.message));
        outcomes.push({ action, error, kept: h.text() === edited, dirty: h.dirty.isDirty() });
      } finally {
        await h.dispose();
      }
    }
    return outcomes;
  });
  for (const outcome of results) {
    assert.match(String(outcome.error), /quota exceeded/, String(outcome.action));
    assert.equal(outcome.kept, true, `${outcome.action} must restore the edited text`);
    assert.equal(outcome.dirty, true, `${outcome.action} must keep the document dirty`);
  }
});

test('whenIdle also waits for version work queued while it was settling', { timeout: 30_000 }, async () => {
  const result = await page!.evaluate(async () => {
    const h = await (globalThis as any).versionHarness('idle-queue');
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    try {
      await h.controller.enable();
      h.edit('ONE ');
      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
      let second: Promise<void> | null = null;
      const createCheckpoint = h.store.createCheckpoint.bind(h.store);
      h.store.createCheckpoint = async (input: unknown) => {
        if (!second) {
          // 첫 커밋이 저장소에 쓰는 동안 다음 버전 작업이 큐에 들어온다.
          second = h.controller.renameBranch('queued-probe', 'renamed').catch(() => undefined);
          await firstGate;
        }
        return createCheckpoint(input);
      };
      // 뒤에 들어온 작업만 저장소 읽기에서 붙잡는다.
      const getBranch = h.store.getBranch.bind(h.store);
      h.store.getBranch = async (repositoryId: unknown, name: string) => {
        if (name === 'queued-probe') await secondGate;
        return getBranch(repositoryId, name);
      };
      const first = h.controller.checkpoint('one');
      let idleSettled = false;
      const idle = h.controller.whenIdle().then(() => { idleSettled = true; });
      while (!second) await tick();
      releaseFirst();
      await first;
      for (let i = 0; i < 5; i += 1) await tick();
      const settledWhileQueued = idleSettled;
      releaseSecond();
      await Promise.all([idle, second]);
      return { settledWhileQueued, settledAfter: idleSettled };
    } finally {
      await h.dispose();
    }
  });
  assert.equal(result.settledWhileQueued, false, 'document replacement must not start while version work is queued');
  assert.equal(result.settledAfter, true);
});

test('switching documents refreshes version state for the new document', { timeout: 30_000 }, async () => {
  const result = await page!.evaluate(async () => {
    const h = await (globalThis as any).versionHarness('context-a');
    try {
      await h.controller.enable();
      const before = h.controller.getState();
      h.setDocumentId('context-b');
      h.eventBus.emit('document-context-changed');
      await new Promise((resolve) => setTimeout(resolve, 0));
      await h.controller.whenIdle();
      const after = h.controller.getState();
      return { before: [before.documentId, before.enabled], after: [after.documentId, after.enabled, after.commits.length] };
    } finally {
      await h.dispose();
    }
  });
  assert.deepEqual(result.before, ['context-a', true]);
  assert.deepEqual(result.after, ['context-b', false, 0], 'history of the previous document must not stay attached');
});

test('disposing a controller leaves a shared version store open', { timeout: 30_000 }, async () => {
  const result = await page!.evaluate(async () => {
    const h = await (globalThis as any).versionHarness('shared-store');
    let closes = 0;
    const close = h.store.close.bind(h.store);
    h.store.close = async () => { closes += 1; return close(); };
    await h.controller.enable();
    h.controller.dispose();
    const closesAfterDispose = closes;
    const stillReadable = await h.store.findRepositoryByDocumentId(h.versions.documentId('shared-store'));
    await h.store.close();
    h.wasm.releaseDocument();
    return { closesAfterDispose, stillReadable: Boolean(stillReadable) };
  });
  assert.equal(result.closesAfterDispose, 0);
  assert.equal(result.stillReadable, true);
});
