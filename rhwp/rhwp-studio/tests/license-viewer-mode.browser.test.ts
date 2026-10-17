/**
 * 라이선스가 읽기 전용이면 앱은 문서 보기 전용이다. 실제 사이드바(미리보기 고정 데이터)에서
 * 에이전트 단추·메뉴 명령·단축키 어느 길로도 사이드바나 집중 화면이 열리지 않고,
 * 다시 편집할 수 있게 되면 펼쳐 있던 사이드바와 대화가 그대로 돌아오는지 본다.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

let server: any;
let browser: any;
let origin: string;
let cache: string;

test.before(async () => {
  cache = await mkdtemp(resolve(tmpdir(), 'rau-license-viewer-'));
  server = await createServer({
    cacheDir: cache,
    configFile: resolve(import.meta.dirname, '../vite.sidebar.config.ts'),
    server: { port: 0, open: false, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
});

test.after(async () => {
  await browser?.close();
  await server?.close();
  if (cache) await rm(cache, { recursive: true, force: true });
});

test('a license read-only app cannot open the agent and gets it back after activation', { timeout: 120_000 }, async (t) => {
  const context = await browser.createBrowserContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(`${origin}/?reset=1&controls=0&theme=light&scenario=chat`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#agent-sidebar')?.dataset.composerReady === 'true', { timeout: 60_000 });
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map((entry) => entry.name)
      .find((name) => name.includes('/ui/license-viewer-mode.ts'))!;
    (window as any).__viewer = await import(/* @vite-ignore */ url);
  });

  const state = () => page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('#agent-sidebar')!;
    const tab = document.querySelector<HTMLButtonElement>('#icon-toolbar .ag-collapse-tab')!;
    return {
      open: !root.classList.contains('ag-collapsed'),
      focus: document.body.classList.contains('ag-fullscreen-open'),
      tabDisabled: tab.disabled,
      messages: root.querySelectorAll('.ag-msg').length,
    };
  });
  const before = await state();
  assert.equal(before.open, true);

  await page.evaluate(() => (window as any).__viewer.setLicenseViewerMode(true));
  await page.waitForFunction(() => document.querySelector('#agent-sidebar')!.classList.contains('ag-collapsed'));
  // 단추, 네이티브 메뉴 명령, ⌃⌘S·⌃⌘J 를 하나씩 시도한다.
  const attempts: Record<string, () => void> = {
    button: () => document.querySelector<HTMLButtonElement>('#icon-toolbar .ag-collapse-tab')!.click(),
    'menu toggle-sidebar': () => window.dispatchEvent(new CustomEvent('rhwp:agent-command', { detail: { command: 'toggle-sidebar' } })),
    'menu toggle-focus-chat': () => window.dispatchEvent(new CustomEvent('rhwp:agent-command', { detail: { command: 'toggle-focus-chat' } })),
    'shortcut ⌃⌘S': () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS', key: 's', ctrlKey: true, metaKey: true, bubbles: true })),
    'shortcut ⌃⌘J': () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', key: 'j', ctrlKey: true, metaKey: true, bubbles: true })),
  };
  for (const [name, attempt] of Object.entries(attempts)) {
    await page.evaluate(`(${attempt.toString()})()`);
    await new Promise((done) => setTimeout(done, 250));
    const locked = await state();
    assert.equal(locked.open, false, name);
    assert.equal(locked.focus, false, name);
    assert.equal(locked.tabDisabled, true, name);
  }

  await page.evaluate(() => (window as any).__viewer.setLicenseViewerMode(false));
  await page.waitForFunction(() => !document.querySelector('#agent-sidebar')!.classList.contains('ag-collapsed'));
  const restored = await state();
  assert.equal(restored.tabDisabled, false);
  assert.equal(restored.messages, before.messages, 'the conversation is kept');
  assert.deepEqual(errors, []);
});

test('the sidebar comes back after activation even when the document changed while locked', { timeout: 120_000 }, async (t) => {
  const context = await browser.createBrowserContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(`${origin}/?reset=1&controls=0&theme=light&sessions=2`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#agent-sidebar')?.dataset.composerReady === 'true'
    && (window as any).sidebarPreview?.sessions.length === 2, { timeout: 60_000 });
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map((entry) => entry.name)
      .find((name) => name.includes('/ui/license-viewer-mode.ts'))!;
    (window as any).__viewer = await import(/* @vite-ignore */ url);
  });
  const shown = () => page.evaluate(() => {
    const { sessions } = (window as any).sidebarPreview;
    const index = sessions.findIndex((session: any) => session.sidebar.isActive());
    const root = sessions[index].sidebar.root as HTMLElement;
    const tab = document.querySelector<HTMLButtonElement>('#icon-toolbar .ag-collapse-tab')!;
    return { index, open: !root.classList.contains('ag-collapsed'), tabDisabled: tab.disabled };
  });
  assert.deepEqual(await shown(), { index: 0, open: true, tabDisabled: false });

  await page.evaluate(() => (window as any).__viewer.setLicenseViewerMode(true));
  await page.evaluate(() => (window as any).sidebarPreview.attachSession(1));
  await new Promise((done) => setTimeout(done, 250));
  assert.deepEqual(await shown(), { index: 1, open: false, tabDisabled: true });

  await page.evaluate(() => (window as any).__viewer.setLicenseViewerMode(false));
  await new Promise((done) => setTimeout(done, 250));
  assert.deepEqual(await shown(), { index: 1, open: true, tabDisabled: false });
  assert.deepEqual(errors, []);
});
