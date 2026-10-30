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
import { checkSelectMenu } from './select-menu.check.mjs';
import { checkMarkdownEditor } from './markdown-editor.check.mjs';
import { checkSetupTerminal } from './setup-terminal.check.mjs';
import { checkUpdateAll } from './update-all.check.mjs';
import { checkProviderUpdates } from './provider-updates.check.mjs';
import { checkInitialSetupUpdateHippo } from './initial-setup-update.check.mjs';
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
import { checkWorkspaceBrand } from './workspace-brand.check.mjs';
import { checkBrowserSettings } from './browser-settings.check.mjs';
import { checkBrowserWorkbench } from './browser-workbench.check.mjs';
import { checkNativeBrowserRecovery } from './browser-native-recovery.check.mjs';
import { checkCaptureSend } from './capture-send.check.mjs';
import { checkDocumentMentions } from './document-mentions.check.mjs';
import { checkDocumentLink } from './document-link.check.mjs';
import { checkDocumentDetach } from './document-detach.check.mjs';
import { checkDocumentNameWriter } from './document-name-writer.check.mjs';
import { checkDocumentMemory } from './document-memory.check.mjs';
import { checkInstructionsCard, checkTaste, checkTasteHistory } from './taste.check.mjs';
import { checkRauUpgrade } from './rau-upgrade.check.mjs';
import { checkPlanCard } from './plan-card.check.mjs';
import { checkChatScrollRail } from './chat-scroll-rail.check.mjs';
import { browserLaunchArgs, findBrowserExecutable } from '../tests/browser-support.ts';

import { checkComposerSendPath, checkFollowUpGap, checkFollowUpQueue } from './queue.check.mjs';
import { checkSteerSendNow } from './steer.check.mjs';
import { checkReloadPreview } from './reload.check.mjs';
import { checkWriterBusyPreview } from './writer-busy.check.mjs';
import { checkTypingGuard } from './typing-guard.check.mjs';
import { checkDelayedStatus } from './delayed-status.check.mjs';
import { checkRestoreTurnPreview } from './restore-turn.check.mjs';
import { checkFailureNotices } from './failures.check.mjs';
import { checkHamaCapNotices } from './hama.check.mjs';
import { checkAttention } from './attention.check.mjs';
import { checkInterruptionPreview } from './interruption.check.mjs';
import { checkAdoptionPreview } from './adoption.check.mjs';

const focusedChecks = {
  'capture-send': (h) => checkCaptureSend(h),
  'document-mentions': (h) => checkDocumentMentions(h),
  'document-link': (h) => checkDocumentLink(h),
  'document-detach': (h) => checkDocumentDetach(h),
  'document-name-writer': (h) => checkDocumentNameWriter(h),
  'document-memory': (h) => checkDocumentMemory(h),
  taste: (h) => checkTaste(h),
  'taste-history': (h) => checkTasteHistory(h),
  'rau-upgrade': (h) => checkRauUpgrade(h),
  'plan-card': (h) => checkPlanCard(h),
  'instructions-card': (h) => checkInstructionsCard(h),
  'scroll-rail': (h) => checkChatScrollRail(h),
  'focus-composer': async ({ page, open }) => {
    await open('reset=1&fullscreen=1');
    const startNewChat = async () => {
      if (await page.$eval('.ag-root', (root) => root.classList.contains('ag-rail-collapsed'))) {
        await page.click('.ag-workspace-threads-btn');
        await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-rail-collapsed'));
      }
      await page.click('.ag-threads-new');
      await page.waitForFunction(() => document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
    };
    await startNewChat();
    const layout = () => page.evaluate(() => {
      const chat = document.querySelector('.ag-chat-page').getBoundingClientRect();
      const composer = document.querySelector('.ag-composer').getBoundingClientRect();
      const greeting = document.querySelector('.ag-focus-greeting');
      return {
        gapBelow: Math.round(chat.bottom - composer.bottom),
        greeting: greeting.checkVisibility() ? greeting.textContent : '',
      };
    });
    const centered = await layout();
    assert(centered.gapBelow > 200, `centered composer leaves ${centered.gapBelow}px below`);
    assert(centered.greeting.includes('사업 제안서'), `greeting shows the document: ${centered.greeting}`);
    await page.type('.ag-input', '요약해 줘');
    await page.click('.ag-send');
    await page.waitForSelector('.ag-msg-user');
    await page.waitForFunction(() =>
      document.querySelector('.ag-composer').getAnimations().every((tween) => tween.playState !== 'running'));
    const sent = await layout();
    assert(sent.gapBelow < 40, `sent composer leaves ${sent.gapBelow}px below`);
    assert.equal(sent.greeting, '');
    await startNewChat();
    assert((await layout()).gapBelow > 200, 'a new chat centers the composer again');
  },
  queue: async (h) => {
    await checkComposerSendPath(h.page, h.origin, h.artifacts);
    await checkFollowUpQueue(h.page, h.origin, h.artifacts);
    await checkFollowUpGap(h.page, h.origin, h.artifacts);
    await checkSteerSendNow(h.page, h.origin, h.artifacts);
  },
  reload: (h) => checkReloadPreview(h.page, h.origin, h.artifacts),
  'writer-busy': (h) => checkWriterBusyPreview(h.page, h.origin, h.artifacts),
  typing: (h) => checkTypingGuard(h.page, h.origin, h.artifacts),
  status: (h) => checkDelayedStatus(h.page, h.origin, h.artifacts),
  restore: (h) => checkRestoreTurnPreview(h.page, h.origin, h.artifacts),
  failures: (h) => checkFailureNotices(h.page, h.origin, h.artifacts),
  hama: (h) => checkHamaCapNotices(h.page, h.origin, h.artifacts),
  attention: (h) => checkAttention(h.page, h.origin, h.artifacts),
  interruption: (h) => checkInterruptionPreview(h.page, h.origin, h.artifacts),
  adoption: (h) => checkAdoptionPreview(h.page, h.origin, h.artifacts),

  'browser-settings': (h) => checkBrowserSettings(h),
  'browser-workbench': (h) => checkBrowserWorkbench(h),
  'browser-native-recovery': (h) => checkNativeBrowserRecovery(h),
  workbench: (h) => checkWorkbench({ page: h.page, origin: h.origin, screenshot: h.screenshot }),
  'workspace-brand': (h) => checkWorkspaceBrand(h.page, h.origin, h.screenshot),
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
  'select-menu': (h) => checkSelectMenu(h.page, h.origin),
  'markdown-editor': (h) => checkMarkdownEditor(h.page, h.origin, h.artifacts),
  'setup-terminal': (h) => checkSetupTerminal(h.page, h.origin),
  'update-all': (h) => checkUpdateAll(h.page, h.origin),
  'provider-updates': (h) => checkProviderUpdates(h.page, h.origin),
  'setup-update-hippo': (h) => checkInitialSetupUpdateHippo(h.page, h.origin),
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
      await page.waitForFunction(() => document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
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
    await step('Chat list stays clickable after the reference library closes', async () => {
      await open('reset=1');
      await page.click('.ag-references-btn');
      await page.waitForSelector('.ag-root.ag-references-open');
      await page.click('.ag-references-close');
      await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-references-open'));
      await page.click('.ag-header .ag-threads-btn');
      await page.waitForSelector('.ag-root.ag-threads-open .ag-threads-page', { visible: true });
      await page.click('.ag-threads-page input');
      await page.waitForFunction(() => document.activeElement?.closest('.ag-threads-page'), { timeout: 5000 });
      await page.click('.ag-threads-page .ag-threads-close');
      await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-threads-open'), { timeout: 5000 });
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
