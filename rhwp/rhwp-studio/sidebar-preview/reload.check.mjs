import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNING_CHAT = 'preview-chat-schedule';
const OTHER_TEXT = '현장 인터뷰 일정\n다시 확인';

/**
 * A reload while the hub still runs the window's chat: the sidebar re-adopts that chat instead of
 * restarting it. The fixture bridge counts every start, stop and interrupt the sidebar sends.
 */
export async function checkReloadPreview(page, origin, artifacts) {
  async function open(reload) {
    await page.goto(`${origin}/?reset=1&theme=light&width=480&chats=sample&reload=${reload}`, {
      waitUntil: 'networkidle0',
    });
    await page.waitForFunction(() => window.sidebarPreview);
    await page.waitForFunction((id) => window.sidebarPreview.sidebar.currentThreadId() === id, {}, RUNNING_CHAT);
  }
  const counts = () => page.evaluate(() => {
    const { chatStarts, stops, interrupts } = window.sidebarPreview.snapshot();
    return { starts: chatStarts.length, stops, interrupts };
  });

  await open('running');
  await page.waitForSelector('.ag-send.ag-stop');
  assert.deepEqual(await counts(), { starts: 0, stops: 0, interrupts: 0 }, 'the running chat is adopted, not restarted');
  assert.deepEqual(await page.evaluate(() => ({
    running: window.sidebarPreview.bridge.isTurnRunning(),
    request: document.querySelector('.ag-msg-user')?.textContent ?? '',
    pending: !document.querySelector('.ag-turn-pending')?.hidden,
    systemLines: [...document.querySelectorAll('.ag-msg-system')].map((node) => node.textContent),
  })), {
    running: true,
    request: '추진 일정 표의 날짜를 분기별로 정리해 주세요.',
    pending: true,
    systemLines: [],
  });
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'reload-running.png') });
  // The adopted turn is a real turn: Stop ends it.
  await page.click('.ag-send.ag-stop');
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning());
  assert.equal((await counts()).interrupts, 1);

  await open('question');
  await page.waitForSelector('.ag-user-question[data-inactive="false"]');
  assert.deepEqual(await counts(), { starts: 0, stops: 0, interrupts: 0 }, 'the waiting chat is adopted, not restarted');
  assert.deepEqual(await page.evaluate(() => {
    const input = document.querySelector('.ag-input');
    return {
      step: document.querySelector('.ag-question-step')?.textContent,
      value: input.value,
      label: input.getAttribute('aria-label'),
      anchored: Boolean(document.querySelector('.ag-messages > .ag-question-timeline-anchor')),
      back: Boolean(document.querySelector('.ag-question-back:not(:disabled)')),
    };
  }), {
    step: '2/2',
    value: OTHER_TEXT,
    label: '현재 질문의 직접 답변',
    anchored: true,
    back: true,
  });
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'reload-question.png') });
  // The restored draft answers the question the running turn waits on.
  await page.click('.ag-question-next');
  await page.waitForSelector('.ag-question-history');
  assert.equal((await counts()).starts, 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { createServer } = await import('vite');
  const { default: puppeteer } = await import('puppeteer-core');
  const { browserLaunchArgs, findBrowserExecutable } = await import('../tests/browser-support.ts');
  const studio = resolve(import.meta.dirname, '..');
  const artifacts = resolve(import.meta.dirname, 'artifacts');
  const executablePath = findBrowserExecutable();
  assert(executablePath, 'Set CHROME_PATH to a Chrome/Chromium executable.');
  await mkdir(artifacts, { recursive: true });
  const cacheDir = await mkdtemp(resolve(tmpdir(), 'rauhwpx-sidebar-reload-'));
  const server = await createServer({
    cacheDir,
    configFile: resolve(studio, 'vite.sidebar.config.ts'),
    server: { port: 0, open: false, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath, headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await checkReloadPreview(page, `http://127.0.0.1:${server.httpServer.address().port}`, artifacts);
    assert.deepEqual(errors, [], 'No browser errors');
    console.log(`PASS Reload re-adopts the live chat. Screenshots: ${artifacts}`);
  } finally {
    const browserProcess = browser?.process();
    await browser?.close();
    browserProcess?.stdout?.destroy();
    browserProcess?.stderr?.destroy();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
}
