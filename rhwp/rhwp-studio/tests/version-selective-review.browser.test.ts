import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import puppeteer, { type Browser } from 'puppeteer-core';
import { createServer, type ViteDevServer } from 'vite';
import { browserExecutable, browserLaunchArgs, requireWasmPackage } from './browser-support.ts';

const studioRoot = fileURLToPath(new URL('../', import.meta.url));
const wasmPackageRoot = process.env.RHWP_WASM_PACKAGE_DIR ?? resolve(studioRoot, '../pkg');
requireWasmPackage(wasmPackageRoot);
let server: ViteDevServer | null = null;
let browser: Browser | null = null;
let baseUrl = '';

test.before(async () => {
  server = await createServer({
    root: studioRoot,
    configFile: false,
    cacheDir: resolve(studioRoot, 'node_modules/.vite-selective-review-browser-test'),
    logLevel: 'silent',
    resolve: { alias: {
      '@': resolve(studioRoot, 'src'),
      '@wasm/rhwp.js': resolve(wasmPackageRoot, 'rhwp.js'),
      '@wasm': wasmPackageRoot,
    } },
    server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [studioRoot, wasmPackageRoot] } },
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

test('review accepts an inserted image while rejecting an unrelated text edit', { timeout: 120_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
    const baselineEvidence = process.env.SELECTIVE_REVIEW_BASELINE_EVIDENCE === '1';
    for (const format of baselineEvidence ? ['hwp'] as const : ['hwp', 'hwpx'] as const) {
      const setup = await page.evaluate(async ({ format, baselineEvidence }) => {
        const [{ WasmBridge }, merge, { buildMergeManifest }, versions, snapshots] = await Promise.all([
          import('/src/core/wasm-bridge.ts'),
          import('/src/merge/index.ts'),
          import('/src/merge/manifest.ts'),
          import('/src/versioning/index.ts'),
          import('/src/versioning/snapshot.ts'),
        ]);
        const wasm = new WasmBridge();
        await wasm.initialize();
        wasm.createNewDocument();
        wasm.insertParagraph(0, 0);
        wasm.insertText(0, 0, 0, 'IMAGE ANCHOR');
        wasm.insertText(0, 1, 0, 'BASE TEXT');
        const fileName = `selective-review.${format}`;
        const exportBytes = () => format === 'hwp' ? wasm.exportHwp() : wasm.exportHwpx();
        const base = exportBytes();
        wasm.loadDocument(base, fileName);
        wasm.insertText(0, 1, 0, 'LOCAL ');
        const current = exportBytes();
        wasm.loadDocument(base, fileName);
        wasm.insertText(0, 1, 0, 'REMOTE ');
        const png = new Uint8Array(await (await fetch('/icons/icon-128.png')).arrayBuffer());
        const picture = wasm.insertPicture(0, 0, 0, '', png, 6000, 6000, 1, 1, 'png');
        if (!picture.ok) throw new Error(`Image insertion failed: ${JSON.stringify(picture)}`);
        const incoming = exportBytes();

        const worker = new merge.MergeWorkerClient();
        const repositoryId = versions.repositoryId(`selective-${format}`);
        const manifests = await (async () => {
          const make = async (bytes: Uint8Array, commit: string, parents: any[] = []) => {
            wasm.loadDocument(bytes, fileName);
            return buildMergeManifest(repositoryId, versions.commitId(commit),
              snapshots.captureVersionSnapshot(wasm).compareSnapshot, Date.now(), parents,
              await worker.buildDocumentManifest(bytes));
          };
          const baseManifest = await make(base, `base-${format}`);
          return {
            base: baseManifest,
            current: await make(current, `current-${format}`, [baseManifest]),
            incoming: await make(incoming, `incoming-${format}`, [baseManifest]),
          };
        })();
        const analysis = await worker.analyzeDocument(base, current, incoming, { review: true, manifests });
        const imageUnit = analysis.conflicts.find((unit) => unit.position?.paragraph === 0);
        const textUnit = analysis.conflicts.find((unit) => unit.position?.paragraph === 1);
        const separate = Boolean(imageUnit && textUnit && imageUnit.id !== textUnit.id);
        if (!separate && !baselineEvidence) {
          throw new Error(`Expected separate image and text review units: ${JSON.stringify(analysis.conflicts.map((unit) => ({ id: unit.id, position: unit.position, incoming: unit.incoming })))}`);
        }
        const now = Date.now();
        const draft = {
          id: `selective-${format}`, repositoryId,
          targetBranch: 'main', sourceBranch: 'source', baseCommitIds: [`base-${format}`],
          currentHead: `current-${format}`, sourceHead: `incoming-${format}`,
          targetBranchRevision: 1, sourceBranchRevision: 1, mode: 'diverged' as const,
          analysisVersion: analysis.analysisVersion, conflicts: analysis.conflicts,
          resolutions: {}, automaticResult: analysis.result, manualAssetBlobIds: [],
          history: [], historyIndex: 0, createdAt: now, updatedAt: now,
        };
        const resolver = new merge.MergeResolverWindow();
        resolver.open({
          draft, analysis, sourceBranch: 'source', currentBranch: 'main', mode: 'diverged',
          documents: {
            base: { bytes: base, fileName, label: 'Base' },
            current: { bytes: current, fileName, label: 'Current' },
            incoming: { bytes: incoming, fileName, label: 'Incoming' },
          },
          canDeleteSource: false,
          materialize: async ({ resolutions, signal }) => {
            const output = await worker.materializeDocument(base, current, incoming, resolutions,
              { review: true, manifests, signal });
            return { tree: analysis.result,
              document: { bytes: output.bytes, fileName, label: 'Result' },
              validation: { valid: true, errors: [], checks: {
                parsed: true, exported: true, reloaded: true, structurallyValid: true, format,
              } },
            };
          },
          saveDraft: async () => undefined,
          discardDraft: async () => undefined,
          complete: async (application) => { (window as any).__selectiveApplication = application; return {}; },
          finalizeSourceDisposition: async () => undefined,
        });
        Object.assign(window, { __selectiveWasm: wasm, __selectiveWorker: worker });
        return { imageId: imageUnit?.id ?? '', textId: textUnit?.id ?? '', count: analysis.conflicts.length, separate };
      }, { format, baselineEvidence });
      await page.waitForSelector('.merge-resolver-window');
      const screenshotDir = process.env.SELECTIVE_REVIEW_SCREENSHOT_DIR;
      if (screenshotDir) {
        await page.waitForFunction(() => {
          const pane = document.querySelector<HTMLElement>('.merge-preview-pane[data-role="incoming"]');
          const status = pane?.querySelector('.merge-preview-status')?.textContent ?? '';
          const canvas = pane?.querySelector('canvas');
          return status.includes('Incoming /') && Boolean(canvas && canvas.width > 100);
        });
        await mkdir(screenshotDir, { recursive: true });
        await page.screenshot({ path: resolve(screenshotDir, baselineEvidence ? `${format}-baseline.png` : `${format}-before.png`) });
      }
      if (baselineEvidence) {
        assert.equal(setup.separate, false, 'baseline should show the atomic review choice');
        assert.equal(setup.count, 1);
        return;
      }
      assert.ok(setup.count >= 2);
      await page.evaluate(({ imageId, textId }) => {
        const choose = (id: string, label: string) => {
          const item = [...document.querySelectorAll<HTMLButtonElement>('.merge-conflict-item')]
            .find((node) => node.dataset.conflictId === id);
          if (!item) throw new Error(`Missing review item ${id}`);
          item.click();
          const button = [...document.querySelectorAll<HTMLButtonElement>('.merge-resolution-button')]
            .find((node) => node.textContent?.startsWith(label));
          if (!button) throw new Error(`Missing ${label} choice for ${id}`);
          button.click();
        };
        choose(imageId, '✓');
        choose(textId, '✕');
      }, setup);
      await page.waitForFunction(() => {
        const button = document.querySelector<HTMLButtonElement>('.merge-resolver-footer .merge-primary-button');
        const pane = document.querySelector<HTMLElement>('.merge-preview-pane[data-role="result"]');
        const status = pane?.querySelector('.merge-preview-status')?.textContent ?? '';
        const canvas = pane?.querySelector('canvas');
        return Boolean(button && !button.disabled && status.includes('Result /') && canvas && canvas.width > 100);
      });
      if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `${format}-after.png`) });
      await page.click('.merge-resolver-footer .merge-primary-button');
      await page.waitForSelector('.merge-resolver-window', { hidden: true });
      const result = await page.evaluate(async () => {
        const application = (window as any).__selectiveApplication;
        const wasm = (window as any).__selectiveWasm;
        const worker = (window as any).__selectiveWorker;
        const bytes = application.materialized.document.bytes as Uint8Array;
        const fileName = application.materialized.document.fileName as string;
        const first = new (wasm.constructor)();
        const second = new (wasm.constructor)();
        try {
          await Promise.all([first.initialize(), second.initialize()]);
          first.loadDocument(bytes, fileName);
          const once = fileName.endsWith('.hwp') ? first.exportHwp() : first.exportHwpx();
          second.loadDocument(once, fileName);
          const twice = fileName.endsWith('.hwp') ? second.exportHwp() : second.exportHwpx();
          const { captureVersionSnapshot } = await import('/src/versioning/snapshot.ts');
          const snapshot = captureVersionSnapshot(second).compareSnapshot;
          return {
            texts: snapshot.paragraphs.map((paragraph) => paragraph.text),
            controls: snapshot.controls.map((control) => control.type),
            onceBytes: once.byteLength,
            twiceBytes: twice.byteLength,
            resolutions: application.resolutions,
          };
        } finally {
          first.releaseDocument();
          second.releaseDocument();
          worker.dispose();
          wasm.releaseDocument();
        }
      });
      assert.ok(result.texts.some((text) => text.includes('LOCAL BASE TEXT')), `${format}: local text missing`);
      assert.ok(result.texts.every((text) => !text.includes('REMOTE')), `${format}: rejected text remained`);
      assert.ok(result.controls.some((type) => /picture|image/i.test(type)), `${format}: accepted image missing`);
      assert.ok(result.onceBytes > 0 && result.twiceBytes > 0, `${format}: roundtrip export failed`);
      assert.equal((result.resolutions as Record<string, { kind: string }>)[setup.imageId]?.kind, 'incoming');
      assert.equal((result.resolutions as Record<string, { kind: string }>)[setup.textId]?.kind, 'current');
    }
  } finally {
    await page.close();
  }
});
