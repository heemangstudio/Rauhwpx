import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { browserLaunchArgs, findBrowserExecutable } from '../tests/browser-support.ts';

const studio = resolve(import.meta.dirname, '..');
export const artifacts = resolve(import.meta.dirname, 'artifacts');

/** True when node was asked to run this very check file (not when check.mjs imports it). */
export function isMainModule(meta) {
  return Boolean(process.argv[1]) && meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

/**
 * Runs one exported preview check alone: its own Vite server on an ephemeral port and a
 * fresh headless Chrome profile, like check.mjs. Fails on uncaught browser errors.
 */
export async function runStandalone(name, check) {
  const executablePath = findBrowserExecutable();
  assert(executablePath, 'Set CHROME_PATH to a Chrome/Chromium executable.');
  await mkdir(artifacts, { recursive: true });
  const cacheDir = await mkdtemp(resolve(tmpdir(), 'rauhwpx-sidebar-standalone-'));
  const server = await createServer({
    cacheDir,
    configFile: resolve(studio, 'vite.sidebar.config.ts'),
    server: { port: 0, open: false, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath, headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('dialog', (dialog) => dialog.accept());
    try {
      await check(page, origin, artifacts);
    } catch (error) {
      await page.screenshot({ path: resolve(artifacts, 'failure.png') }).catch(() => {});
      throw new Error(`${name}: ${error.message}\nRuntime errors: ${JSON.stringify(errors)}`, { cause: error });
    }
    assert.deepEqual(errors, [], 'No browser errors');
    console.log(`PASS ${name}`);
  } finally {
    const browserProcess = browser?.process();
    await browser?.close();
    browserProcess?.stdout?.destroy();
    browserProcess?.stderr?.destroy();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
}
