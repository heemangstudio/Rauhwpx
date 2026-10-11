import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';
import { rhwpPdfjsAssetsPlugin } from '../vite-plugin-pdfjs-assets.mjs';

test('download disclosure keeps unassigned files accessible for opening and import recovery', { timeout: 30_000 }, async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
    resolve: { preserveSymlinks: true },
    optimizeDeps: { exclude: ['pdfjs-dist'] },
    plugins: [rhwpPdfjsAssetsPlugin(), { name: 'download-inbox-harness', configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/inbox-harness') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><div class="ag-wdocs" style="width:500px"></div></body></html>');
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
    page.setDefaultTimeout(10_000);
    await page.goto(`http://127.0.0.1:${address.port}/inbox-harness`);
    await page.evaluate(async () => {
      const { createBrowserDownloadInbox } = await import('../src/ui/agent-sidebar/browser-download-inbox.ts');
      await import('../src/ui/agent-sidebar/workbench-documents.css');
      const job = { downloadId: 'unassigned', state: 'downloaded' as const, filename: 'guideline.pdf', size: 1024, target: {} };
      let jobs = [job, { ...job, downloadId: 'assigned', target: { projectId: 'project' } }];
      let failImport = true;
      const imported: string[] = [];
      const bridge = {
        requestBrowser: async () => ({ downloads: jobs }),
        onBrowserEvent: () => () => {},
        readBrowserDownload: async (id: string) => id === 'invalid' ? new Blob(['invalid']) :
          (await fetch('/src/sidebar-preview/fixtures/research-guideline.pdf')).blob(),
        importBrowserDownload: async () => {
          if (failImport) throw new Error('Import unavailable');
          const moved = { ...job, inboxMovedAt: new Date().toISOString() };
          jobs = jobs.filter(entry => entry.downloadId !== job.downloadId);
          return moved;
        },
      } as unknown as Parameters<typeof createBrowserDownloadInbox>[0]['bridge'];
      const inbox = createBrowserDownloadInbox({ bridge, getProjectId: () => 'project', onImported: job => imported.push(job.downloadId) });
      document.querySelector('.ag-wdocs')!.append(inbox.root);
      await inbox.refresh();
      Object.assign(window, { inboxTest: { inbox, job, imported, allowImport() { failImport = false; } } });
    });
    assert.equal(await page.$eval('details', element => element.open), false);
    assert.equal(await page.$eval('.ag-download-inbox-count', element => element.textContent), '1');
    assert.equal(await page.$eval('.ag-download-inbox-row', element => element.checkVisibility()), false);
    await page.focus('summary');
    await page.keyboard.press('Enter');
    await page.click('[aria-label="받은 파일 열기"]');
    await page.waitForFunction('document.querySelector("canvas").width > 1 || !document.querySelector("[role=status]").hidden');
    assert.equal(await page.$eval('[role="status"]', element => (element as HTMLElement).hidden), true,
      await page.$eval('[role="status"]', element => element.textContent ?? ''));
    await page.click('[aria-label="받은 PDF 닫기"]');
    assert.equal(await page.$eval('.ag-download-inbox-viewer', element => (element as HTMLElement).hidden), true);
    await page.click('[aria-label="현재 프로젝트로 이동"]');
    await page.waitForFunction('document.querySelector("[role=status]").textContent === "Import unavailable"');
    assert.equal(await page.$eval('[role="status"]', element => element.checkVisibility()), true);
    await page.evaluate('inboxTest.allowImport()');
    await page.click('[aria-label="현재 프로젝트로 이동"]');
    await page.waitForFunction('inboxTest.imported.length === 1');
    assert.equal(await page.$eval('.ag-download-inbox-count', element => element.textContent), '0');
    assert.equal(await page.$('.ag-download-inbox-row'), null);
    assert.equal(await page.$eval('details', element => element.hidden), true, 'empty inbox takes no space');
    await page.evaluate('inboxTest.inbox.root.open = false');
    await page.evaluate('inboxTest.inbox.open({ ...inboxTest.job, downloadId: "invalid" })');
    assert.equal(await page.$eval('details', element => element.open), true, 'external open reveals the disclosure');
    assert.equal(await page.$eval('[role="status"]', element => element.checkVisibility()), true);
    assert.match(await page.$eval('[role="status"]', element => element.textContent ?? ''), /PDF/);
    await page.evaluate('inboxTest.inbox.dispose()');
  } finally {
    await browser?.close();
    await server.close();
  }
});
