import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';
import { rhwpPdfjsAssetsPlugin } from '../vite-plugin-pdfjs-assets.mjs';

test('resource tabs retain drafts, defer hidden loads, reconcile project scope and restore only the active resource', { timeout: 45_000 }, async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [rhwpPdfjsAssetsPlugin(), { name: 'documents-harness', configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/documents-harness') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><div id="mount" style="height:600px;width:600px"></div></body></html>');
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${address.port}/documents-harness`);
    await page.evaluate(async () => {
      const { createWorkbenchDocuments } = await import('../src/ui/agent-sidebar/workbench-documents.ts');
      const { createProjectStore, normalizeProjectSnapshot } = await import('../src/agent/project-service.ts');
      const items = Array.from({ length: 10 }, (_, n) => ({
        id: `n${n}`, kind: 'note', title: `Note ${n}`, column: null, order: n, tags: [], pinned: false,
        summary: '', createdAt: n, updatedAt: n, addedBy: { kind: 'user' }, bytes: 10,
      }));
      const project = normalizeProjectSnapshot({ id: 'test-project', name: 'Project', revision: 1, items })!;
      const store = createProjectStore();
      store.replace(project);
      const calls: string[] = [];
      const writes: unknown[] = [];
      let settle: (() => void) | null = null;
      const service = {
        async note(scope: string, id: string) {
          calls.push(`${scope}/${id}`);
          if (id === 'n9') await new Promise<void>(resolve => { settle = resolve; });
          return { body: `Body ${id}`, id };
        },
        async applyOps(scope: string, ops: unknown) { writes.push([scope, ops]); return {}; },
      };
      const client = { store, service } as unknown as Parameters<typeof createWorkbenchDocuments>[0]['client'];
      const view = createWorkbenchDocuments({ client });
      document.querySelector('#mount')!.append(view.element);
      const state = { view, store, project, calls, writes, settle: () => settle?.(), recreate() {
        view.dispose();
        state.view = createWorkbenchDocuments({ client });
        document.querySelector('#mount')!.append(state.view.element);
      } };
      Object.assign(window, { documentsTest: state });
      await view.open({ itemId: 'n0' });
      await view.open({ itemId: 'n1' });
    });
    const run = <T>(body: string): Promise<T> => page.evaluate(code => Function(`return (${code})()` )(), body) as Promise<T>;
    assert.deepEqual(await run('() => documentsTest.calls'), [], 'hidden tabs should not fetch');
    await run('async () => { documentsTest.view.setVisible(true); }');
    await page.waitForSelector('.ag-wdocs-panel:not([hidden]) .ag-pp-note');
    assert.deepEqual(await run('() => documentsTest.calls'), ['test-project/n1']);
    await run('async () => { await documentsTest.view.open({ itemId: "n0" }); await documentsTest.view.open({ itemId: "n0" }); }');
    assert.equal(await run('() => documentsTest.view.tabCount'), 2);
    assert.deepEqual(await run('() => documentsTest.calls'), ['test-project/n1', 'test-project/n0']);
    await page.click('.ag-wdocs-panel:not([hidden]) [aria-label="노트 편집"]');
    await page.$eval('.ag-wdocs-panel:not([hidden]) textarea', textarea => {
      (textarea as HTMLTextAreaElement).value = 'Unsaved draft';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await run('async () => { await documentsTest.view.open({ itemId: "n1" }); await documentsTest.view.open({ itemId: "n0" }); }');
    assert.equal(await page.$eval('.ag-wdocs-panel:not([hidden]) textarea', textarea => (textarea as HTMLTextAreaElement).value), 'Unsaved draft');
    await page.click('.ag-wdocs-tab-row.ag-wdocs-dirty .ag-wdocs-close');
    assert.equal(await run('() => documentsTest.view.tabCount'), 2);
    assert.deepEqual(await run('() => documentsTest.writes'), [], 'closing a draft must never autosave');
    await page.click('.ag-wdocs-notice [aria-label="노트 계속 편집"]');
    await page.click('.ag-wdocs-tab-row.ag-wdocs-dirty .ag-wdocs-close');
    await page.click('.ag-wdocs-notice [aria-label="변경 버리고 닫기"]');
    assert.equal(await run('() => documentsTest.view.tabCount'), 1);
    assert.equal(await page.$eval('[role="tab"][aria-selected="true"]', tab => tab.textContent), 'Note 1');

    await run('async () => { await documentsTest.view.open({ itemId: "n2" }); await documentsTest.view.open({ itemId: "n3" }); }');
    await page.focus('[role="tab"][aria-selected="true"]');
    await page.keyboard.press('Home');
    assert.equal(await page.$eval('[role="tab"][aria-selected="true"]', tab => tab.getAttribute('aria-label')), '자료 목록');
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.$eval('[role="tab"][aria-selected="true"]', tab => tab.textContent), 'Note 2');
    await page.keyboard.press('Delete');
    assert.equal(await page.$eval('[role="tab"][aria-selected="true"]', tab => tab.textContent), 'Note 3', 'closing chooses the right adjacent tab');

    await run('() => { documentsTest.calls.length = 0; documentsTest.recreate(); }');
    assert.equal(await run('() => documentsTest.view.tabCount'), 2);
    assert.deepEqual(await run('() => documentsTest.calls'), []);
    await run('() => documentsTest.view.setVisible(true)');
    await page.waitForSelector('.ag-wdocs-panel:not([hidden]) .ag-pp-note');
    assert.deepEqual(await run('() => documentsTest.calls'), ['test-project/n3'], 'restore loads only selected resource');

    await run('async () => { for (let n = 4; n <= 8; n++) await documentsTest.view.open({ itemId: `n${n}` }); await documentsTest.view.open({ itemId: "n0" }); await documentsTest.view.open({ itemId: "n2" }); }');
    assert.equal(await run('() => documentsTest.view.tabCount'), 8);
    assert.match(await page.$eval('.ag-wdocs-notice', element => element.textContent ?? ''), /8개/);
    await run('() => { documentsTest.store.replace({ ...documentsTest.project, items: documentsTest.project.items.filter(item => item.id !== "n0") }); }');
    assert.equal(await run('() => documentsTest.view.tabCount'), 7);
    await run('() => { void documentsTest.view.open({ itemId: "n9" }); }');
    await page.waitForFunction('documentsTest.calls.includes("test-project/n9")');
    await run('() => { documentsTest.store.replace({ ...documentsTest.project, id: "another-project", items: [] }); documentsTest.settle(); }');
    await page.waitForFunction('documentsTest.view.tabCount === 0');
    assert.equal(await page.$('.ag-pp-note'), null, 'a late note response cannot repopulate the rebound project');
    await page.evaluate(async () => {
      const { citationProjectFixture, createCitationService, CITATION_FIXTURE_IDS } = await import('../src/sidebar-preview/mock-citations.ts');
      const { createProjectStore } = await import('../src/agent/project-service.ts');
      const state = (window as unknown as { documentsTest: { view: { setClient(client: unknown): void; open(request: { itemId: string; anchor?: string }): Promise<void>; }; } }).documentsTest;
      const project = citationProjectFixture();
      const service = createCitationService(project);
      const calls: string[] = [];
      const fileBlob = service.fileBlob;
      service.fileBlob = (scope, id) => { calls.push(id); return fileBlob(scope, id); };
      const store = createProjectStore();
      store.replace(project);
      Object.assign(window, { pdfTest: { ids: CITATION_FIXTURE_IDS, calls } });
      state.view.setClient({ store, service });
      await state.view.open({ itemId: CITATION_FIXTURE_IDS.guideline, anchor: 'p2' });
    });
    await page.waitForSelector('.ag-wdocs-panel:not([hidden]) .ag-pdf-canvas');
    await page.click('.ag-wdocs-panel:not([hidden]) [aria-label="확대"]');
    await page.waitForFunction(`document.querySelector('.ag-wdocs-panel:not([hidden]) .ag-pdf-page')?.offsetWidth > 600`);
    const pdfState = await page.$eval('.ag-wdocs-panel:not([hidden]) .ag-pdf', pdf => ({
      width: (pdf.querySelector('.ag-pdf-page') as HTMLElement).offsetWidth,
      scroll: pdf.scrollTop,
    }));
    await run('async () => { await documentsTest.view.open({ itemId: pdfTest.ids.scan, anchor: "p1" }); }');
    await page.waitForSelector('.ag-wdocs-panel:not([hidden]) .ag-pdf-canvas');
    assert.equal(await page.$$eval('.ag-wdocs-panel[hidden] .ag-pdf-canvas', elements => elements.length), 0, 'hidden PDFs release canvases');
    await run('async () => { await documentsTest.view.open({ itemId: pdfTest.ids.guideline }); }');
    await page.waitForSelector('.ag-wdocs-panel:not([hidden]) .ag-pdf-canvas');
    const restoredPdf = await page.$eval('.ag-wdocs-panel:not([hidden]) .ag-pdf', pdf => ({
      width: (pdf.querySelector('.ag-pdf-page') as HTMLElement).offsetWidth,
      scroll: pdf.scrollTop,
    }));
    assert.equal(restoredPdf.width, pdfState.width, 'PDF zoom survives switching resources');
    assert.ok(Math.abs(restoredPdf.scroll - pdfState.scroll) < 2, 'PDF scroll survives switching resources');
    const countBeforeClip = await run<number>('() => documentsTest.view.tabCount');
    await run('async () => { await documentsTest.view.open({ itemId: pdfTest.ids.chartClip }); }');
    assert.equal(await run('() => documentsTest.view.tabCount'), countBeforeClip, 'clips reuse their source PDF tab');
    assert.equal(await run('() => pdfTest.calls.filter(id => id === pdfTest.ids.guideline).length'), 1, 'reopening a PDF does not reload bytes');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
