/**
 * HeemangEngine 전환 검증 공용 도우미 — 기준선(heemangstudio/main)과 후보 작업 트리를 각자 빈 포트에
 * 띄우고 같은 headless Chrome 으로 연다.
 *
 * 환경 변수
 *   HV_BASELINE  기준선 작업 트리 (기본 ../studio-baseline)
 *   HV_CANDIDATE 후보 작업 트리 (기본 이 파일이 있는 작업 트리)
 *   HV_BASELINE_VITE_PORT, HV_CANDIDATE_VITE_PORT  Vite 시작 포트 (기본 8400, 8500 부터 빈 포트)
 *   HV_CANDIDATE_QUERY 후보 앱 URL 의 쿼리 (기본 "?engine=heemang"; 엔진 기본값이 바뀌면 "" 로)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const candidateRoot = path.resolve(process.env.HV_CANDIDATE || path.join(here, '../../../..'));
export const baselineRoot = path.resolve(process.env.HV_BASELINE || path.join(candidateRoot, '..', 'studio-baseline'));
export const outDir = path.join(here, 'out');
export const CANDIDATE_QUERY = process.env.HV_CANDIDATE_QUERY ?? '?engine=heemang';

export const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1 };

const require = (await import('node:module')).createRequire(import.meta.url);
export const puppeteer = (await import(pathToFileURL(require.resolve('puppeteer-core')).href)).default;
export const { PNG } = await import(pathToFileURL(require.resolve('pngjs')).href);
export const pixelmatch = (await import(pathToFileURL(require.resolve('pixelmatch')).href)).default;

const OFFLINE = {
  NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9',
  NO_PROXY: '127.0.0.1,localhost', npm_config_offline: 'true',
};

/** 작업 트리 하나의 허브 + Vite 를 띄운다. 하니스는 그 작업 트리의 것을 쓴다(studioRoot 가 모듈 위치 기준). */
export async function startApp(name, root, portBase) {
  const harness = await import(pathToFileURL(path.join(root, 'rhwp/rhwp-studio/e2e/agent-bench-harness.mjs')).href);
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hv-${name}-`));
  const { piRoot, finishTurnPath } = harness.writeFakePi(fixtureRoot);
  const token = `hv-${name}`;
  const hubPort = await harness.findAvailablePort(portBase);
  const vitePort = await harness.findAvailablePort(Number(process.env[`HV_${name.toUpperCase()}_VITE_PORT`]) || portBase + 2000);
  const hub = await harness.startHub({
    hubPort, token, fixtureRoot, logName: `hv-${name}-hub.log`,
    env: { RHWP_PI_DIR: piRoot, RHWP_CLI_DIR: path.join(fixtureRoot, 'cli'), ...OFFLINE },
  });
  let vite;
  try {
    vite = await harness.startVite({ vitePort, hubPort, token, logName: `hv-${name}-vite.log` });
  } catch (error) {
    await harness.stopServer(hub);
    throw error;
  }
  const query = name === 'candidate' ? CANDIDATE_QUERY : '';
  return {
    name, root, hubPort, vitePort, token, fixtureRoot, finishTurnPath, harness,
    url: `http://127.0.0.1:${vitePort}/${query}`,
    viteLog: path.join(root, 'rhwp/target', `hv-${name}-vite.log`),
    async stop() {
      await harness.stopServer(vite);
      await harness.stopServer(hub);
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    },
  };
}

/** 후보 작업 트리에 rhwp/pkg 가 없으면 Vite 가 @wasm/rhwp.js 를 풀지 못한다 — 사실만 알린다. */
export function pkgStatus(root) {
  return fs.existsSync(path.join(root, 'rhwp/pkg/rhwp_bg.wasm'));
}

export async function launchBrowser() {
  const executablePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return puppeteer.launch({
    headless: true, executablePath, protocolTimeout: 60000,
    args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none', '--disable-lcd-text', '--hide-scrollbars'],
  });
}

/** 새 컨텍스트(저장소 분리) 페이지. 네트워크·콘솔·예외를 모은다. */
export async function newPage(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(VIEWPORT);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  const log = { requests: [], console: [], pageErrors: [] };
  page.on('request', (req) => log.requests.push(req.url()));
  page.on('console', (msg) => { if (['error', 'warning'].includes(msg.type())) log.console.push(`${msg.type()}: ${msg.text()}`.slice(0, 600)); });
  page.on('pageerror', (error) => log.pageErrors.push(String(error?.stack || error).slice(0, 800)));
  page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
  return { page, context, log };
}

export async function waitFor(page, label, predicate, { timeout = 20000, args = [] } = {}) {
  try {
    await page.waitForFunction(predicate, { timeout, polling: 100 }, ...args);
  } catch (error) {
    throw new Error(`timed out waiting for ${label}`, { cause: error });
  }
}

export async function loadApp(page, url) {
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitFor(page, 'app ready', () => window.__wasm && window.__eventBus && window.__dispatcher, { timeout: 60000 });
  return Date.now() - t0;
}

/** 파일 열기와 같은 open-document-bytes 경로로 문서를 연다. 첫 캔버스가 그려질 때까지의 ms 를 돌려준다. */
export async function openDocumentFile(page, filePath) {
  const bytes = [...fs.readFileSync(filePath)];
  const fileName = path.basename(filePath);
  const t0 = Date.now();
  await page.evaluate(async (data, name) => {
    const requestId = crypto.randomUUID();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('open-document-bytes timed out')), 45000);
      const off = window.__eventBus.on('open-document-bytes:done', (payload) => {
        if (payload?.requestId !== requestId) return;
        off(); clearTimeout(timer);
        if (payload.ok) resolve(); else reject(new Error(payload.error || 'open failed'));
      });
      window.__eventBus.emit('open-document-bytes', {
        bytes: new Uint8Array(data), fileName: name, requestId, suppressDialogs: true, skipUnsavedGuard: true,
      });
    });
  }, bytes, fileName);
  await waitFor(page, 'first page painted', inkPredicate, { timeout: 45000, args: [30] });
  return Date.now() - t0;
}

/** 첫 문서 캔버스에 어두운 픽셀이 min 개 이상 있는지. */
export function inkPredicate(min) {
  let ink = 0;
  for (const source of document.querySelectorAll('#scroll-content canvas')) {
    if (!source.width || !source.height) continue;
    const copy = document.createElement('canvas');
    copy.width = Math.min(source.width, 2000); copy.height = Math.min(source.height, 3000);
    const ctx = copy.getContext('2d');
    ctx.drawImage(source, 0, 0);
    const { data } = ctx.getImageData(0, 0, copy.width, copy.height);
    for (let i = 0; i < data.length; i += 8) if (data[i + 3] > 128 && data[i] + data[i + 1] + data[i + 2] < 384) ink += 1;
    if (ink >= min) return true;
  }
  return false;
}

export function rhwpEngineRequests(log) {
  return log.requests.filter((url) => /rhwp_bg\.wasm|\/rhwp\.js(\?|$)|pkg\/rhwp/.test(url));
}

export function ensureOut(sub = '') {
  const dir = path.join(outDir, sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
