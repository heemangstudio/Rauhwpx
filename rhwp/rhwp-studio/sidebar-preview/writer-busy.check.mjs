import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A write refused because another chat of the same document is editing it: the turn ends
 * with one failed tool row and the model's explanation, and nothing claims the document changed.
 */
export async function checkWriterBusyPreview(page, origin, artifacts) {
  await page.goto(`${origin}/?theme=light&width=480&reset=1&scenario=writer-busy`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
  await page.click('#play');
  await page.waitForFunction(() => window.sidebarPreview.bridge.isTurnRunning());
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning()
    && document.querySelector('.ag-msg-assistant')?.textContent.includes('다시 요청해 주세요'));
  await page.click('.ag-activity-toggle');
  await page.waitForSelector('.ag-tool-row .ag-tool-status.ag-err', { visible: true });
  const rows = await page.$$eval('.ag-tool-row', (nodes) => nodes.map((row) => ({
    tool: row.dataset.tool,
    failed: Boolean(row.querySelector('.ag-tool-status.ag-err')),
  })));
  assert.deepEqual(rows.filter((row) => row.failed).length, 1, `one refused write: ${JSON.stringify(rows)}`);
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'writer-busy.png') });
}

// Run on its own: `node sidebar-preview/writer-busy.check.mjs` (own Vite server and browser profile).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [{ createServer }, { default: puppeteer }, { browserLaunchArgs, findBrowserExecutable }] = await Promise.all([
    import('vite'),
    import('puppeteer-core'),
    import('../tests/browser-support.ts'),
  ]);
  const studio = resolve(import.meta.dirname, '..');
  const artifacts = resolve(import.meta.dirname, 'artifacts');
  const executablePath = findBrowserExecutable();
  assert(executablePath, 'Set CHROME_PATH to a Chrome/Chromium executable.');
  await mkdir(artifacts, { recursive: true });
  const cacheDir = await mkdtemp(resolve(tmpdir(), 'hamaeditor-writer-busy-check-'));
  const server = await createServer({
    cacheDir,
    configFile: resolve(studio, 'vite.sidebar.config.ts'),
    server: { port: 0, open: false, hmr: false },
    logLevel: 'error',
  });
  let browser;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await puppeteer.launch({ executablePath, headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await checkWriterBusyPreview(page, origin, artifacts);
    assert.deepEqual(errors, [], 'The writer-busy turn produces no browser errors.');
    console.log(`PASS Refused write while another chat edits the document (${resolve(artifacts, 'writer-busy.png')})`);
  } finally {
    await browser?.close();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
}
