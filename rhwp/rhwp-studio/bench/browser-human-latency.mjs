/** 실제 Electron/허브에서 사람의 클릭 후 화면 표시 지연을 측정한다. VITE_URL 또는 localhost:7700이 필요하다. */
import { fileURLToPath } from 'node:url';
import { findAvailablePort, stopServer } from '../e2e/agent-bench-harness.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createRequire } from 'node:module';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const appUrl = process.env.VITE_URL ?? 'http://127.0.0.1:7700';
const debugPort = await findAvailablePort(9486);
const require = createRequire(`${root}/package.json`);
const electron = require('electron');
const puppeteer = createRequire(`${root}/rhwp/rhwp-studio/package.json`)(
  'puppeteer-core',
);
let paints = 0;
const errors = [];
const server = createServer((req, res) => {
  if (req.url.startsWith('/paint')) {
    paints++;
    res.end('ok');
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.end(
    `<!doctype html><title>Latency fixture</title><style>body{margin:0}button{border:0;width:200px;height:100px;background:rgb(0,0,255);display:block}input{margin:20px;width:250px}main{height:3000px;background:linear-gradient(white,grey)}</style><button id="probe" aria-label="Paint probe"></button><input aria-label="Typing probe"><main>Scroll probe</main><script>let n=0;document.querySelector('button').onclick=()=>{n++;document.querySelector('button').style.background=n%2?'rgb(255,255,0)':'rgb(0,0,255)';requestAnimationFrame(()=>requestAnimationFrame(()=>fetch('/paint?n='+n)))};</script>`,
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const dir = await mkdtemp(path.join(tmpdir(), 'rhwp-browser-latency-'));
const env = {
  ...process.env,
  RHWP_DEV_URL: appUrl,
  RHWP_DESKTOP_USER_DATA: dir,
  RHWP_BROWSER_WORKSPACE_TARGETS: JSON.stringify([origin]),
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electron,
  [
    `${root}/desktop/main.mjs`,
    `--remote-debugging-port=${debugPort}`,
    '--use-mock-keychain',
  ],
  { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
);
child.stderr.resume();
let b;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      b = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${debugPort}`,
        defaultViewport: null,
      });
      break;
    } catch {
      await sleep(100);
    }
  }
  assert.ok(b, 'Electron readiness');
  const target = await b.waitForTarget(
    (t) => t.type() === 'page' && t.url().startsWith(appUrl),
    { timeout: 30000 },
  );
  const p = await target.page();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.waitForFunction(
    () =>
      window.__documentSessions?.attached()?.bridge.getConnectionState() ===
      'connected',
    { timeout: 30000 },
  );
  await p.evaluate(() =>
    localStorage.setItem(
      'rhwp-initial-setup',
      JSON.stringify({ version: 2, completed: true }),
    ),
  );
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForFunction(
    () =>
      window.__documentSessions?.attached()?.bridge.getConnectionState() ===
      'connected',
    { timeout: 30000 },
  );
  await p.evaluate(
    () =>
      new Promise((resolve) => {
        const requestId = crypto.randomUUID();
        const off = window.__eventBus.on('create-new-document:done', (v) => {
          if (v.requestId === requestId) {
            off();
            resolve(v);
          }
        });
        window.__eventBus.emit('create-new-document', {
          skipUnsavedGuard: true,
          requestId,
        });
      }),
  );
  if (process.argv.includes('--managed'))
    await p.evaluate(() =>
      window.__documentSessions
        .attached()
        .bridge.requestBrowser('configure', { mode: 'managed' }),
    );
  const opened = await p.evaluate(async (origin) => {
    const s = window.__documentSessions.attached();
    const result = await s.bridge.requestBrowser('open', { url: origin });
    window.__latencyTabId = result.tab.tabId;
    window.__latencyFrameRequests = 0;
    const request = s.bridge.requestBrowser.bind(s.bridge);
    s.bridge.requestBrowser = (action, args) => {
      if (action === 'frame') window.__latencyFrameRequests++;
      return request(action, args);
    };
    s.sidebar.openWorkbench('browser');
    return { runtime: result.runtime.kind, tabId: result.tab.tabId };
  }, origin);
  await p.waitForSelector('.ag-browser[data-presentation="dock"]', {
    timeout: 20000,
  });
  await p.waitForFunction(
    () =>
      document.querySelector('.ag-browser [role="tab"][aria-selected="true"]'),
    { timeout: 10000 },
  );
  await p.waitForFunction(
    () => !document.documentElement.classList.contains('ag-fs-vt'),
  );
  let guest;
  if (opened.runtime === 'native') {
    const target = await b.waitForTarget(
      (t) => t.type() === 'page' && t.url().startsWith(origin),
      { timeout: 10000 },
    );
    guest = await target.page();
    await p.waitForFunction(
      async () => {
        const s = window.__documentSessions.attached();
        const r = await s.bridge.requestBrowser('status');
        const t = r.tabs.find((t) => t.tabId === window.__latencyTabId);
        return (
          (
            await window.rhwpDesktop.browser.getState({
              tabId: t.nativeTargetId,
            })
          ).mode === 'dock'
        );
      },
      { timeout: 10000 },
    );
  }
  if (opened.runtime === 'chromium')
    await p.waitForFunction(
      () => {
        const i = document.querySelector('.ag-browser-frame');
        return (
          i?.complete &&
          i.naturalWidth > 0 &&
          i.getBoundingClientRect().width > 0
        );
      },
      { timeout: 10000 },
    );
  const geometry = await p.evaluate(() => {
    const surface = document.querySelector('.ag-browser-surface');
    const rect = surface.getBoundingClientRect();
    const image = document.querySelector('.ag-browser-frame');
    const ir = image.getBoundingClientRect();
    return {
      surface: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      image: { x: ir.x, y: ir.y, width: ir.width, height: ir.height },
    };
  });
  const samples = [];
  for (let i = 0; i < 8; i++) {
    const before = paints;
    const start = performance.now();
    if (opened.runtime === 'native') {
      await guest.mouse.click(80, 45);
      const dl = Date.now() + 2500;
      while (paints === before && Date.now() < dl) await sleep(2);
      assert.ok(paints > before, 'native CDP click must reach page');
    } else {
      const coord = await p.evaluate(() => {
        const im = document.querySelector('.ag-browser-frame');
        const r = im.getBoundingClientRect();
        return {
          x: r.x + (80 * r.width) / im.naturalWidth,
          y: r.y + (45 * r.height) / im.naturalHeight,
        };
      });
      await p.mouse.click(coord.x, coord.y);
      await p.waitForFunction(
        (yellow) => {
          const im = document.querySelector('.ag-browser-frame');
          if (!im.complete || !im.naturalWidth) return false;
          const c = document.createElement('canvas');
          c.width = 1;
          c.height = 1;
          const ctx = c.getContext('2d');
          ctx.drawImage(im, 80, 45, 1, 1, 0, 0, 1, 1);
          const a = ctx.getImageData(0, 0, 1, 1).data;
          return yellow ? a[0] > 230 && a[1] > 230 : a[2] > 230 && a[0] < 30;
        },
        { polling: 'raf', timeout: 4000 },
        i % 2 === 0,
      );
    }
    samples.push(Math.round((performance.now() - start) * 10) / 10);
  }
  const frameRequestsDuringBrowsing = await p.evaluate(
    () => window.__latencyFrameRequests,
  );
  if (guest) {
    assert.equal(frameRequestsDuringBrowsing, 0);
    await guest.mouse.click(100, 130);
    await guest.keyboard.type('Fast browser ');
    const cdp = await guest.createCDPSession();
    await cdp.send('Input.imeSetComposition', {
      text: '한',
      selectionStart: 1,
      selectionEnd: 1,
    });
    await cdp.send('Input.insertText', { text: '한글' });
    await cdp.detach();
    assert.equal(
      await guest.$eval('input', (i) => i.value),
      'Fast browser 한글',
    );
    await guest.mouse.wheel({ deltaY: 500 });
    await guest.waitForFunction(() => scrollY > 100);
    await guest.evaluate(() => scrollTo(0, 0));
    await guest.waitForFunction(() => scrollY === 0);
    await p.evaluate(() =>
      document
        .querySelector(
          '.ag-browser [aria-label="페이지·개체·영역에 의견 붙이기"]',
        )
        .click(),
    );
    await p.waitForFunction(
      () =>
        window.__latencyFrameRequests === 1 &&
        document.querySelector('.ag-browser-frame')?.complete &&
        document.querySelector('.ag-browser-frame')?.naturalWidth > 0,
    );
    await p.evaluate(() =>
      document
        .querySelector('.ag-browser-annotation [aria-label="의견 작성 취소"]')
        .click(),
    );
    await p.waitForFunction(async () => {
      const t = window.__latencyTabId;
      const s = await window.__documentSessions
        .attached()
        .bridge.requestBrowser('status');
      const tab = s.tabs.find((v) => v.tabId === t);
      return (
        (
          await window.rhwpDesktop.browser.getState({
            tabId: tab.nativeTargetId,
          })
        ).mode === 'dock'
      );
    });
    assert.equal(
      await guest.$eval('input', (i) => i.value),
      'Fast browser 한글',
    );
  }
  const sortedSamples = [...samples].sort((a, b) => a - b);
  const result = {
    measurement: guest
      ? 'Click to fixture acknowledgment after two animation frames'
      : 'Click to updated displayed screenshot pixel',
    frameRequestsDuringBrowsing,
    nativeTypingImeScrollingAndAnnotation: Boolean(guest),
    runtime: opened.runtime,
    latencyMs: samples,
    medianMs: Math.round((sortedSamples[3] + sortedSamples[4]) * 5) / 10,
    frameRequests: await p.evaluate(() => window.__latencyFrameRequests),
    pageErrors: errors,
  };
  await writeFile(
    process.env.RHWP_BROWSER_LATENCY_OUTPUT ??
      '/tmp/browser-human-latency-result.json',
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  assert.ok(
    result.medianMs < (guest ? 100 : 150),
    `Human browsing must paint below ${guest ? 100 : 150}ms median; observed ${result.medianMs}ms`,
  );
} catch (e) {
  console.log('failure', e.message, 'paints', paints);
  throw e;
} finally {
  b?.disconnect();
  await stopServer(child);
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
}
