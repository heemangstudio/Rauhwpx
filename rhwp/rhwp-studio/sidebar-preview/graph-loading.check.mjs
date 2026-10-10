import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createServer, resolveConfig } from 'vite';
import puppeteer from 'puppeteer-core';
import { browserLaunchArgs, findBrowserExecutable } from '../tests/browser-support.ts';

const studio = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(resolve(tmpdir(), 'rauhwpx-graph-loading-'));
const artifacts = resolve(import.meta.dirname, 'artifacts');
const servers = [];
let browser;
const originalSkipHub = process.env.RHWP_SKIP_AGENT_HUB;
process.env.RHWP_SKIP_AGENT_HUB = '1';
try {
  // Keep the production configs' relative cache locations, inside a disposable run.
  // If both configs share a cache again, the second optimizer replaces the first.
  async function start(config) {
    const configFile = resolve(studio, config);
    const resolved = await resolveConfig({ configFile }, 'serve');
    const cacheDir = resolve(temp, relative(studio, resolved.cacheDir));
    const cachePath = relative(temp, cacheDir);
    assert(!isAbsolute(cachePath) && cachePath !== '..' && !cachePath.startsWith(`..${sep}`),
      'Vite caches must stay inside the checkout, including linked node_modules.');
    const server = await createServer({
      configFile, cacheDir,
      server: { port: 0, open: false, hmr: false },
      logLevel: 'error',
      plugins: [{
        name: 'graph-test-page',
        configureServer(server) {
          server.middlewares.use('/__graph_test', (_req, response) => {
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><body><button id="open">Open graph</button></body></html>');
          });
        },
      }],
    });
    servers.push(server);
    await server.listen();
    return { origin: `http://127.0.0.1:${server.httpServer.address().port}`, cacheDir };
  }
  const main = await start('vite.config.ts');
  browser = await puppeteer.launch({ executablePath: findBrowserExecutable(), headless: true, args: browserLaunchArgs() });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const runtimeErrors = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  async function prepare() {
    await page.goto(`${main.origin}/__graph_test`);
    await page.evaluate(async () => {
      const [{ createProjectGraph }, { sampleProject }] = await Promise.all([
        import('/src/ui/agent-sidebar/project/project-graph.ts'),
        import('/src/sidebar-preview/mock-projects.ts'),
      ]);
      window.graphErrors = [];
      const graph = createProjectGraph({ store: {}, openPreview() {}, announce(message) { window.graphErrors.push(message); } });
      graph.element.style.cssText = 'width:900px;height:700px';
      document.body.append(graph.element);
      document.querySelector('#open').onclick = () => { graph.update(sampleProject()); graph.setActive(true); };
    });
  }
  await prepare();
  const sidebar = await start('vite.sidebar.config.ts');
  assert.notEqual(main.cacheDir, sidebar.cacheDir, 'Studio and sidebar must not share optimized dependencies.');
  const preview = await browser.newPage();
  await preview.goto(`${sidebar.origin}/?reset=1&project=graph`, { waitUntil: 'networkidle0' });
  await preview.waitForFunction(() => document.querySelector('.ag-pgraph')?.graphStats.ticks > 0);
  await page.bringToFront();
  await page.click('#open');
  await page.waitForFunction(() => document.querySelector('.ag-pgraph')?.graphStats.ticks > 0);
  assert.deepEqual(await page.evaluate(() => window.graphErrors), []);
  await mkdir(artifacts, { recursive: true });
  await preview.screenshot({ path: resolve(artifacts, 'graph-loading.png') });

  // A failed import must still surface an error; an explicit reload obtains a fresh module map.
  let rejectImport = true;
  let failedRequests = 0;
  await page.setCacheEnabled(false);
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (rejectImport && new URL(request.url()).pathname.endsWith('/d3-force.js')) {
      failedRequests++;
      void request.respond({ status: 504, contentType: 'text/plain', body: 'Outdated Optimize Dep' });
    } else void request.continue();
  });
  await prepare();
  await page.bringToFront();
  await page.click('#open');
  await page.waitForFunction(() => window.graphErrors.some((message) => message.includes('그래프를 불러오지 못했습니다')));
  assert(failedRequests > 0);
  rejectImport = false;
  await prepare();
  await page.bringToFront();
  await page.click('#open');
  await page.waitForFunction(() => document.querySelector('.ag-pgraph')?.graphStats.ticks > 0);
  assert.deepEqual(await page.evaluate(() => window.graphErrors), []);
  assert.deepEqual(runtimeErrors, []);
  console.log(JSON.stringify({ main: main.origin, sidebar: sidebar.origin, graphAfterSecondOptimizer: 'rendered', importFailure: 'reported', explicitReload: 'recovered' }));
} finally {
  if (originalSkipHub === undefined) delete process.env.RHWP_SKIP_AGENT_HUB;
  else process.env.RHWP_SKIP_AGENT_HUB = originalSkipHub;
  await browser?.close();
  for (const server of servers.reverse()) await server.close();
  await rm(temp, { recursive: true, force: true });
}
