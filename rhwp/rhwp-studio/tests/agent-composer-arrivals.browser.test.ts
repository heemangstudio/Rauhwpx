import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';
// The preview checks are shared with `npm run test:sidebar` and run alone with node.
import { checkTypingGuard } from '../sidebar-preview/typing-guard.check.mjs';
import { checkDelayedStatus } from '../sidebar-preview/delayed-status.check.mjs';

// Mount the production sidebar; the bridge is the explicitly labeled preview fixture.
// Real keystrokes, IME composition and timers drive every case (see the two check files).
const artifacts = resolve(import.meta.dirname, '../sidebar-preview/artifacts');
let server: any, browser: any, origin: string, cache: string;
test.before(async () => {
  await mkdir(artifacts, { recursive: true });
  cache = await mkdtemp(resolve(tmpdir(), 'rau-composer-arrivals-'));
  server = await createServer({
    cacheDir: cache,
    configFile: resolve(import.meta.dirname, '../vite.sidebar.config.ts'),
    server: { port: 0, open: false, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await puppeteer.launch({
    executablePath: browserExecutable(),
    headless: true,
    args: browserLaunchArgs(),
  });
});
test.after(async () => {
  await browser?.close();
  await server?.close();
  if (cache) await rm(cache, { recursive: true, force: true });
});

async function newPage(t: any) {
  const context = await browser.createBrowserContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, [], 'Uncaught browser errors'));
  await page.setViewport({ width: 1280, height: 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  return page;
}

test('a question or plan column arriving while the user types waits without taking focus, text, composition or digits', async (t) => {
  await checkTypingGuard(await newPage(t), origin, artifacts);
});

test('connection, chat-start, ring and rail statuses wait 400 ms, never blink, and the lock keeps the composer focused', async (t) => {
  await checkDelayedStatus(await newPage(t), origin, artifacts);
});
