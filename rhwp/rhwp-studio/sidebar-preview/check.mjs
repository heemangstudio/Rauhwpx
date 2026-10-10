/**
 * Minimal sidebar preview smoke: boot, one chat turn, the Agent Focus panel, and backend isolation.
 * Feature checks run only by name: node sidebar-preview/check.mjs workbench changes
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { checkChipAlignment } from './chip-alignment.check.mjs';
import { checkPiModels } from './pi-models.check.mjs';
import { checkSetupTerminal } from './setup-terminal.check.mjs';
import { checkFleetPreview } from './fleet.check.mjs';
import { checkChangesPreview } from './changes.check.mjs';
import { checkWorktrees } from './worktrees.check.mjs';
import { checkPlanPreview } from './plan.check.mjs';
import { checkContextPreview } from './context.check.mjs';
import { checkSessionsPreview } from './sessions.check.mjs';
import { checkDraftChat, checkNewChatWhileRunning, checkChatModeLock, checkNewChatViewMode } from './parallel-chats.check.mjs';
import { checkChatResume } from './chat-resume.check.mjs';
import { checkChatPermissions } from './permissions.check.mjs';
import { checkWorkbench } from './workbench.check.mjs';
import { checkBrowserSettings } from './browser-settings.check.mjs';
import { checkBrowserWorkbench } from './browser-workbench.check.mjs';
import { browserLaunchArgs, findBrowserExecutable } from '../tests/browser-support.ts';

const focusedChecks = {
  'browser-settings': (h) => checkBrowserSettings(h),
  'browser-workbench': (h) => checkBrowserWorkbench(h),
  workbench: (h) => checkWorkbench({ page: h.page, origin: h.origin, screenshot: h.screenshot }),
  changes: (h) => checkChangesPreview(h.page, h.origin, h.artifacts),
  plan: (h) => checkPlanPreview(h.page, h.origin, h.artifacts),
  permissions: (h) => checkChatPermissions(h.page, h.origin, h.screenshot),
  worktrees: (h) => checkWorktrees({ page: h.page, open: h.open, screenshot: h.screenshot }),
  fleet: (h) => checkFleetPreview(h.page, h.origin),
  sessions: (h) => checkSessionsPreview(h.page, h.origin),
  context: (h) => checkContextPreview(h.page, h.origin, h.artifacts),
  resume: (h) => checkChatResume(h.page, h.origin, h.screenshot),
  chip: (h) => checkChipAlignment(h.page, h.origin),
  'pi-models': (h) => checkPiModels(h.page, h.origin),
  'setup-terminal': (h) => checkSetupTerminal(h.page, h.origin),
  'parallel-chats': async (h) => {
    await checkNewChatViewMode(h.page, h.origin);
    await checkDraftChat(h.page, h.origin);
    await checkNewChatWhileRunning(h.page, h.origin);
    await checkChatModeLock(h.page);
  },
};
const requested = process.argv.slice(2);
const unknown = requested.filter((name) => !(name in focusedChecks));
assert.deepEqual(unknown, [], `Unknown checks. Available: ${Object.keys(focusedChecks).join(', ')}`);

const studio = resolve(import.meta.dirname, '..');
const artifacts = resolve(import.meta.dirname, 'artifacts');
const executablePath = findBrowserExecutable();
assert(executablePath, 'Set CHROME_PATH to a Chrome/Chromium executable.');
await mkdir(artifacts, { recursive: true });
// Own server + fresh browser profile: checks do not need or alter a running app/preview.
const cacheDir = await mkdtemp(resolve(tmpdir(), 'hamaeditor-sidebar-check-'));
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
  const forbidden = [];
  await page.exposeFunction('reportSidebarRuntimeError', (message) => errors.push(message));
  await page.evaluateOnNewDocument(() => {
    // Exercise the same missing API as an HTTP LAN/Tailscale origin.
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, writable: true, configurable: true });
    window.addEventListener('error', (event) => window.reportSidebarRuntimeError(event.message));
    window.addEventListener('unhandledrejection', (event) => window.reportSidebarRuntimeError(String(event.reason)));
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('dialog', (dialog) => dialog.accept());
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    const forbiddenPath = /\.(wasm)(\?|$)|\/src\/(main\.ts|agent\/(bridge|tool-executor)\.ts|core\/wasm-bridge\.ts)|\/api\//;
    if ((url.protocol.startsWith('http') && url.origin !== origin) || forbiddenPath.test(url.pathname)) {
      forbidden.push(request.url());
      void request.abort();
    } else void request.continue();
  });
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', ({ url }) => {
    if (!url.startsWith(origin.replace('http:', 'ws:'))) forbidden.push(url);
  });
  async function open(query = '') {
    const params = new URLSearchParams(query);
    if (!params.has('width')) params.set('width', '480');
    await page.goto(`${origin}/?theme=light&${params}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.sidebarPreview);
    if (!query.includes('services=setup')) {
      await page.waitForFunction(() => !document.querySelector('.ag-input').disabled);
    }
  }
  async function screenshot(name) {
    // Capture without resizing the viewport; a resize re-clamps the panel widths mid-check.
    const sidebar = await page.$('.ag-root');
    await sidebar.screenshot({ path: resolve(artifacts, `${name}.png`), captureBeyondViewport: false });
  }
  async function step(name, run) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      await page.screenshot({ path: resolve(artifacts, 'failure.png') });
      throw new Error(`${name}: ${error.message}\nRuntime errors: ${JSON.stringify(errors)}\nBlocked requests: ${JSON.stringify(forbidden)}`, { cause: error });
    }
  }

  if (requested.length) {
    const harness = { page, origin, artifacts, open, screenshot };
    for (const name of requested) await step(name, () => focusedChecks[name](harness));
  } else {
    await step('Sidebar boots and finishes a chat turn', async () => {
      await open('reset=1&scenario=chat');
      await page.click('#play');
      await page.waitForFunction(() => window.sidebarPreview.bridge.isTurnRunning());
      await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning() && document.querySelector('.ag-msg-user'));
    });
    await step('Agent Focus panel opens a view from the surface list', async () => {
      await open('reset=1&fullscreen=1&width=400');
      await page.click('.ag-workspace-panel-btn');
      await page.waitForSelector('.ag-workbench-launcher:not([hidden])', { visible: true });
      await page.keyboard.press('KeyB');
      await page.waitForSelector('.ag-workbench-panel[data-view="board"]:not([hidden])', { visible: true });
    });
  }
  await step('No remote services, document engine, or browser errors', () => {
    assert.deepEqual(forbidden, [], 'No remote services, document engine, or application entry point');
    assert.deepEqual(errors, [], 'No browser errors');
  });
  console.log(`Sidebar checks passed. Artifacts: ${artifacts}`);
} finally {
  const browserProcess = browser?.process();
  await browser?.close();
  // Detached Chrome helpers can retain inherited output pipes after its exit.
  browserProcess?.stdout?.destroy();
  browserProcess?.stderr?.destroy();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
