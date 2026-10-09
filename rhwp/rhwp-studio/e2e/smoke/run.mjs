/**
 * 스모크 스위트 — 실제 허브와 Vite 를 빈 포트에 띄우고 headless Chrome 하나로 흐름을 차례로 돌린다.
 *
 * 실행: npm run e2e:smoke [-- <흐름 이름 일부>]
 * Chrome 경로: CHROME_PATH 또는 PUPPETEER_EXECUTABLE_PATH (macOS 는 Google Chrome 을 자동으로 찾는다).
 * 흐름마다 새 브라우저 컨텍스트(저장소 분리)와 새 문서를 쓴다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

import {
  ensureChromePath, findAvailablePort, repoRoot, startHub, startVite, stopServer, writeFakePi,
} from '../agent-bench-harness.mjs';
import { loadApp } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] ?? '';
const files = fs.readdirSync(here).filter((name) => /^\d\d-.+\.mjs$/.test(name) && name.includes(filter)).sort();
if (!files.length) throw new Error(`no smoke flow matches "${filter}"`);

const token = 'smoke';
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-smoke-'));
let hub = null;
let vite = null;
let browser = null;
let cleaning = null;

function cleanup() {
  cleaning ??= (async () => {
    await browser?.close().catch(() => {});
    await stopServer(vite);
    await stopServer(hub);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  })();
  return cleaning;
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });
}

const started = performance.now();
let failures = 0;
try {
  ensureChromePath();
  const executablePath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (!executablePath) throw new Error('set CHROME_PATH to a Chrome or Chromium binary');
  const { piRoot, finishTurnPath } = writeFakePi(fixtureRoot);
  const hubPort = await findAvailablePort(5790);
  const vitePort = await findAvailablePort(7790);
  [hub, vite, browser] = await Promise.all([
    startHub({ hubPort, token, fixtureRoot, env: { RHWP_PI_DIR: piRoot }, logName: 'smoke-hub.log' }),
    startVite({ vitePort, hubPort, token, logName: 'smoke-vite.log' }),
    puppeteer.launch({ headless: true, executablePath, protocolTimeout: 30000, args: ['--no-sandbox', '--disable-gpu'] }),
  ]);
  const url = `http://127.0.0.1:${vitePort}`;
  console.log(`smoke: vite ${url}, hub :${hubPort} (${((performance.now() - started) / 1000).toFixed(1)} s)`);

  for (const file of files) {
    const flow = (await import(path.join(here, file))).default;
    const context = await browser.createBrowserContext();
    const t0 = performance.now();
    let error = null;
    try {
      const page = await context.newPage();
      // 네이티브 대화상자는 페이지를 멈춘다. 흐름이 기대하지 않은 대화상자는 실패로 남긴다.
      page.on('dialog', (dialog) => {
        error ??= new Error(`unexpected ${dialog.type()} dialog: ${dialog.message()}`);
        void dialog.dismiss();
      });
      await page.setViewport({ width: 1280, height: 900 });
      await loadApp(page, url);
      await flow.run({ page, context, url, hubPort, token, finishTurnPath });
    } catch (caught) {
      error ??= caught;
    }
    if (error) failures += 1;
    await context.close().catch(() => {});
    const seconds = ((performance.now() - t0) / 1000).toFixed(1).padStart(5);
    console.log(`${error ? 'FAIL' : 'pass'} ${seconds} s  ${flow.name}`);
    if (error) console.log(`       ${String(error.stack || error).split('\n').slice(0, 6).join('\n       ')}`);
  }
} catch (error) {
  failures += 1;
  console.error(`smoke setup failed: ${error.stack || error}`);
  console.error(`logs: ${path.join(repoRoot, 'target', 'smoke-hub.log')}, ${path.join(repoRoot, 'target', 'smoke-vite.log')}`);
} finally {
  await cleanup();
}
console.log(`${failures ? `${failures} failed` : 'all passed'} in ${((performance.now() - started) / 1000).toFixed(1)} s`);
process.exit(failures ? 1 : 0);
