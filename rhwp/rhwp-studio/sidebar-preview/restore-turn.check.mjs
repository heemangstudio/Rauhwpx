import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * "이 작업 전으로 되돌리기" on the request bubble: it appears once the request's change is accepted,
 * asks before discarding later edits, puts the request back into an empty composer, and a refused
 * restore (evicted checkpoint) explains itself without restoring anything.
 */
export async function checkRestoreTurnPreview(page, origin, artifacts) {
  const REQUEST = '이 문서의 핵심 내용을 검토하고 개선해 주세요.';
  const acceptReview = async (query) => {
    await page.goto(`${origin}/?theme=light&width=480&reset=1&scenario=review&${query}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.sidebarPreview && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
    await page.click('#play');
    await page.waitForSelector('.ag-review-card .ag-approve', { visible: true });
    assert.equal(await page.$('.ag-msg-user .ag-msg-restore'), null, 'no action while the change waits for review');
    await page.click('.ag-review-card .ag-approve');
    await page.waitForFunction(() => window.sidebarPreview.snapshot().pendingChanges === 0);
    await page.waitForSelector('.ag-msg-user .ag-msg-restore');
    // 사이드바 토스트가 대화를 덮지 않게 닫아 둔다.
    for (const close of await page.$$('.rhwp-toast-close')) await close.click().catch(() => {});
    await page.hover('.ag-msg-user');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.ag-msg-user .ag-msg-restore')).opacity === '1');
  };

  // 이후 편집이 있는 요청: 확인을 받은 뒤 되돌리고, 빈 입력칸에 요청을 돌려준다.
  await acceptReview('restore=later');
  assert.equal(await page.$eval('.ag-msg-user .ag-msg-restore', (node) => node.getAttribute('aria-label')), '이 작업 전으로 되돌리기');
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'restore-turn-action.png') });
  await page.click('.ag-msg-user .ag-msg-restore');
  await page.waitForSelector('.ag-sheet-confirm', { visible: true });
  assert.match(await page.$eval('.ag-sheet', (node) => node.textContent), /함께 사라집니다/);
  assert.equal(await page.evaluate(() => window.sidebarPreview.restoreState.calls), 0, 'nothing happens before confirming');
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'restore-turn-confirm.png') });
  await page.click('.ag-sheet-confirm');
  await page.waitForFunction(() => window.sidebarPreview.restoreState.calls === 1);
  await page.waitForFunction(() => [...document.querySelectorAll('.ag-msg-system')]
    .some((node) => node.textContent.includes('이 작업 전으로 되돌렸습니다')));
  assert.equal(await page.$eval('.ag-input', (node) => node.value), REQUEST, 'the request is back in the empty composer');
  // 바로 다시 누르면 이미 되돌린 상태라고만 알린다.
  await page.hover('.ag-msg-user');
  await page.click('.ag-msg-user .ag-msg-restore');
  await page.waitForFunction(() => [...document.querySelectorAll('.rhwp-toast')]
    .some((node) => node.textContent.includes('이미 이 작업 전 상태입니다')));
  assert.equal(await page.evaluate(() => window.sidebarPreview.restoreState.calls), 1);
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'restore-turn-restored.png') });

  // 돌아온 요청은 그대로 다시 보낼 수 있다 — 말풍선에는 사용자가 쓴 글만 보인다.
  await page.click('.ag-send');
  await page.waitForFunction(() => window.sidebarPreview.bridge.isTurnRunning());
  const userBubbles = await page.$$eval('.ag-msg-user-text', (nodes) => nodes.map((node) => node.textContent));
  assert.deepEqual(userBubbles, [REQUEST, REQUEST]);

  // 오래돼 시점이 없는 요청: 버튼은 흐리게 남고, 누르면 까닭만 알린다.
  await acceptReview('restore=evicted');
  assert.equal(await page.$eval('.ag-msg-user .ag-msg-restore', (node) => node.getAttribute('aria-disabled')), 'true');
  await page.click('.ag-msg-user .ag-msg-restore');
  await page.waitForFunction(() => [...document.querySelectorAll('.rhwp-toast')]
    .some((node) => node.textContent.includes('오래된 작업이라 되돌릴 시점이 남아 있지 않아요')));
  assert.equal(await page.$('.ag-sheet-confirm'), null, 'a refusal asks nothing');
  assert.equal(await page.evaluate(() => window.sidebarPreview.restoreState.calls), 0, 'a refused restore calls nothing');
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'restore-turn-evicted.png') });
}

// Run on its own: `node sidebar-preview/restore-turn.check.mjs` (own Vite server and browser profile).
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
  const cacheDir = await mkdtemp(resolve(tmpdir(), 'rauhwpx-restore-turn-check-'));
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
    await checkRestoreTurnPreview(page, origin, artifacts);
    assert.deepEqual(errors, [], 'The restore flow produces no browser errors.');
    console.log(`PASS Restore a request's document changes from its bubble (${resolve(artifacts, 'restore-turn-confirm.png')})`);
  } finally {
    await browser?.close();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
}
