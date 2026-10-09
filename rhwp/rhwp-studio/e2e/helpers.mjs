/**
 * 벤치와 브라우저 통합 테스트가 쓰는 headless Chrome 도우미.
 *
 * Chrome 경로: CHROME_PATH 또는 PUPPETEER_EXECUTABLE_PATH, 없으면 macOS Google Chrome·Linux 시스템 Chrome 을 찾는다.
 * 앱 주소: VITE_URL (기본 http://localhost:7700). 둘 다 이 모듈을 불러올 때 고정된다.
 */
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const VITE_URL = process.env.VITE_URL || 'http://localhost:7700';
const CHROME_PATH = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((candidate) => candidate && existsSync(candidate));
const CANVAS_SELECTOR = '#scroll-container canvas';

export function sampleFetchPath(filename) {
  const parts = String(filename || '').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\\?#\0]/.test(part))) {
    throw new Error(`잘못된 샘플 파일명: ${filename}`);
  }
  return `/samples/${parts.map(encodeURIComponent).join('/')}`;
}

export async function launchBrowser() {
  if (!CHROME_PATH) throw new Error('CHROME_PATH 에 Chrome 또는 Chromium 경로를 지정하세요');
  return puppeteer.launch({
    headless: true,
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
}

export async function createPage(browser, width = 1280, height = 900) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  return page;
}

export async function closePage(page) {
  await page.close();
}

export async function closeBrowser(browser) {
  await browser.close();
}

/** Wait for an observable result; include the named state in failures. */
export async function waitForState(page, label, predicate, ...args) {
  try { await page.waitForFunction(predicate, { timeout: 15000 }, ...args); }
  catch (error) { throw new Error(`Timed out waiting for ${label}: ${error.message}`, { cause: error }); }
}

/** Allow the current layout/paint cycle to complete without a fixed settling delay. */
export async function waitForPaint(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** Vite 개발 서버에서 앱을 열고 엔진 초기화를 기다린다. */
export async function loadApp(page, search = '') {
  await page.goto(`${VITE_URL}${search}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForState(page, 'app ready', () => Boolean(window.__wasm && window.__canvasView));
}

/** 새 빈 문서를 만든다. 미저장 가드는 셋업 단계라 우회한다. */
export async function createNewDocument(page) {
  const result = await page.evaluate(() => new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const off = window.__eventBus.on('create-new-document:done', (payload) => {
      if (payload.requestId !== requestId) return;
      off();
      resolve(payload);
    });
    window.__eventBus.emit('create-new-document', { skipUnsavedGuard: true, requestId });
  }));
  if (!result.ok) throw new Error(result.error || 'New document initialization failed');
  await page.waitForSelector(CANVAS_SELECTOR, { timeout: 10000 });
  await waitForState(page, 'new document input ready', () => Boolean(window.__inputHandler && window.__wasm?.pageCount > 0));
}

/** /samples 의 문서를 엔진에 직접 열고 첫 렌더를 기다린다. */
export async function loadHwpFile(page, filename) {
  const result = await page.evaluate(async (fname, url) => {
    const startedAt = performance.now();
    const response = await fetch(url);
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const info = window.__wasm.loadDocument(new Uint8Array(await response.arrayBuffer()), fname);
    await window.__canvasView?.loadDocument?.();
    return { pageCount: info.pageCount, documentLoadAndInitialRenderMs: performance.now() - startedAt };
  }, filename, sampleFetchPath(filename));
  if (result.error) throw new Error(`파일 로드 실패 (${filename}): ${result.error}`);
  await page.waitForSelector(CANVAS_SELECTOR, { timeout: 10000 });
  await waitForPaint(page);
  return result;
}

/** 브라우저와 앱을 열고 testFn 을 돌린다. 실패하면 종료 코드를 1 로 둔다. */
export async function runTest(title, testFn, { skipLoadApp = false } = {}) {
  console.log(`=== ${title} ===`);
  const browser = await launchBrowser();
  try {
    const page = await createPage(browser);
    if (!skipLoadApp) await loadApp(page);
    await testFn({ page, browser });
  } catch (error) {
    console.error('오류:', error.stack || error);
    process.exitCode = 1;
  } finally {
    await closeBrowser(browser);
  }
}
