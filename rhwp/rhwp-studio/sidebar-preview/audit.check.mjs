import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { auditScenarios } from '../src/sidebar-preview/audit-scenarios.ts';
import { findBrowserExecutable } from '../tests/browser-support.ts';

const studio = resolve(import.meta.dirname, '..');
const artifacts = resolve(import.meta.dirname, 'artifacts');
const executablePath = findBrowserExecutable();
assert(executablePath, 'Set CHROME_PATH to Chrome/Chromium.');
await mkdir(artifacts, { recursive: true });
const server = await createServer({ configFile: resolve(studio, 'vite.sidebar.config.ts'),
  server: { port: 0, open: false, hmr: false }, logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser;
try {
  browser = await puppeteer.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const errors = [];
  const external = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.dismiss());
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if ((url.protocol.startsWith('http') && url.origin !== origin) || /\.wasm$|\/api\//.test(url.pathname)) {
      external.push(request.url());
      void request.abort();
    } else void request.continue();
  });
  const open = async (params) => {
    await page.goto(`${origin}/?${params}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.auditReady, { timeout: 15000 });
    assert.equal(await page.$eval('body', (node) => node.dataset.auditReady), 'true',
      await page.$eval('#preview-status', (node) => node.textContent));
  };
  for (const scene of auditScenarios) {
    const params = new URLSearchParams({ audit: '1', theme: 'light', width: '480', ...scene.params, auditScene: scene.id });
    await open(params);
    assert.equal(await page.$eval('.audit-scene-current a', (node) => node.firstChild.textContent), scene.title);
    if (scene.id === 'chat-review') assert.ok(await page.evaluate(() => window.sidebarPreview.snapshot().pendingChanges > 0));
    if (scene.id === 'chat-changes-full') {
      assert.deepEqual(await page.evaluate(() => window.sidebarPreview.snapshot().changeEvents), ['set-finalized', 'approved']);
      assert.equal(await page.$eval('.ag-root', (node) => node.classList.contains('ag-review-drawer-open')), true);
    }
    if (scene.params.mode && scene.id.startsWith('mode-')) {
      const labels = { chat: '채팅', plan: '플랜', agent: '에이전트', full: '전체' };
      assert.equal(await page.$eval('.ag-mode-btn', (node) => node.textContent), labels[scene.params.mode]);
    }
    if (scene.id === 'menu-mode') assert.equal(await page.$$eval('.ag-mode.ag-model-open .ag-mode-item', (nodes) => nodes.length), 4);
    if (scene.id === 'plan-run-modes') {
      assert.deepEqual(await page.$$eval('.ag-plan-actions button', (nodes) => nodes.map((node) => node.textContent)),
        ['수정 요청', '전체 접근으로 실행', '에이전트로 실행']);
    }
    // 영역 조각: 스캔 PDF 에서 그린 썸네일·미리보기 테두리·칩이 실제로 나타나야 한다.
    if (scene.id === 'clip-board') {
      await page.waitForFunction(() => document.querySelectorAll('.ag-pcard[data-kind="clip"] .ag-pcard-thumb[data-state="ready"]').length === 2, { timeout: 20000 });
    }
    if (scene.id === 'clip-preview') {
      await page.waitForSelector('.ag-pdf-page[data-page="1"] .ag-clip-box.ag-clip-selected[data-clip="rq7m3kd"]', { timeout: 20000 });
      assert.equal(await page.$eval('.ag-pp-clip-tool', (node) => node.getAttribute('aria-pressed')), 'false');
    }
    if (scene.id === 'clip-chip') {
      await page.waitForFunction(() => document.querySelectorAll('.ag-cite[data-cite-kind="clip"] .ag-clip-thumb[data-state="ready"]').length === 2, { timeout: 20000 });
      // 칩 바로 뒤의 마침표는 칩과 같은 줄에 남는다.
      const sameLine = await page.$$eval('.ag-cite[data-cite-kind="clip"]', (chips) => chips.map((chip) => {
        const next = chip.nextSibling;
        if (next?.nodeType !== Node.TEXT_NODE || !/^[.,]/.test(next.textContent)) return null;
        const range = document.createRange();
        range.setStart(next, 0);
        range.setEnd(next, 1);
        const mark = range.getBoundingClientRect();
        const box = chip.getBoundingClientRect();
        return Math.abs((mark.top + mark.bottom) / 2 - (box.top + box.bottom) / 2) < box.height;
      }).filter((value) => value !== null));
      assert.ok(sameLine.length > 0 && sameLine.every(Boolean), 'punctuation after a clip chip stays on its line');
    }
    if (['chat-empty', 'chat-review', 'chat-changes-full', 'clip-board', 'clip-preview', 'clip-chip',
      'mode-chat', 'mode-plan', 'mode-agent', 'mode-full', 'menu-mode', 'mode-locked', 'plan-run-modes'].includes(scene.id))
      await page.screenshot({ path: resolve(artifacts, `audit-${scene.id}.png`) });
    console.log(`PASS ${scene.id}`);
  }
  await open('audit=1&theme=dark&width=360');
  await page.screenshot({ path: resolve(artifacts, 'audit-dark-narrow.png') });
  await page.click('.audit-scene-current input');
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.audit-scene-current input:checked');
  await page.type('.audit-search', 'browserbase failure');
  assert.equal(await page.$$eval('.audit-scene', (nodes) => nodes.length), 1);
  await page.click('.audit-scene-link');
  await page.waitForFunction(() => new URLSearchParams(location.search).get('auditScene') === 'browserbase-error');
  await page.waitForFunction(() => document.body.dataset.auditReady === 'true');
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().browserbase), 'error');
  await open('audit=1&theme=light');
  const dialogs = await page.$$eval('[data-audit-dialog]', (nodes) => nodes.map((node) => node.dataset.auditDialog));
  for (const dialog of dialogs) {
    await open('audit=1&theme=light');
    await page.evaluate(() => [...document.querySelectorAll('.audit-tabs button')].find((button) => button.textContent === 'Editor dialogs').click());
    await page.evaluate((id) => {
      const button = document.querySelector(`[data-audit-dialog="${id}"]`);
      button.closest('details').open = true;
      button.click();
    }, dialog);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(await page.$eval('#preview-status', (node) => node.textContent.includes('Error')), false);
    if (dialog === dialogs[0]) await page.screenshot({ path: resolve(artifacts, 'audit-dialog.png') });
    console.log(`PASS dialog ${dialog}`);
  }
  assert.deepEqual(errors, [], 'No browser exceptions');
  assert.deepEqual(external, [], 'Fixtures stay local and engine-independent');
  console.log(`Audit passed: ${auditScenarios.length} scenes, ${dialogs.length} dialogs, navigation and persistence.`);
} finally {
  await browser?.close();
  await server.close();
}
