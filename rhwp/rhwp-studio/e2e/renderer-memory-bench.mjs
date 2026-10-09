// 긴 그림 문서의 렌더러 메모리를 단계별로 잰다.
//
// 사용: VITE_URL=http://127.0.0.1:7700 node e2e/renderer-memory-bench.mjs --mode=headless
//   [--sample=<samples 경로>] [--dpr=2] [--zoom=3] [--zoom-pages=24] [--output=<json>]
// 렌더러 프로세스 phys_footprint(macOS footprint), JS 힙, WASM 선형 메모리, DOM canvas 픽셀,
// 엔진 그림 캐시 통계를 문서 로드 → 전체 스크롤 → 확대 스크롤 순서로 기록한다.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { closeBrowser, launchBrowser, loadApp, sampleFetchPath } from './helpers.mjs';

function arg(name, fallback) {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const SAMPLE = arg('sample', '2025 행정업무운영 편람(최종).hwp');
const DPR = Number(arg('dpr', '2'));
const ZOOM = Number(arg('zoom', '3'));
const ZOOM_PAGES = Number(arg('zoom-pages', '24'));
const MiB = 1024 * 1024;

function footprintBytes(pid) {
  try {
    const out = execFileSync('footprint', ['-p', String(pid), '--noCategories', '-f', 'bytes'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = out.match(/phys_footprint:\s+(\d+)\s+B/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function rendererPids(browser) {
  const session = await browser.target().createCDPSession();
  try {
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    return processInfo.filter((info) => info.type === 'renderer').map((info) => info.id);
  } finally {
    await session.detach().catch(() => {});
  }
}

async function settle(page, ms) {
  await page.evaluate((delay) => new Promise((resolve) => setTimeout(resolve, delay)), ms);
}

async function measure(browser, page, cdp, label) {
  await cdp.send('HeapProfiler.collectGarbage');
  await settle(page, 400);
  const pids = await rendererPids(browser);
  const footprints = pids.map((pid) => ({ pid, bytes: footprintBytes(pid) }))
    .filter((entry) => entry.bytes !== null);
  const renderer = footprints.reduce((best, entry) => (entry.bytes > (best?.bytes ?? -1) ? entry : best), null);
  const { metrics } = await cdp.send('Performance.getMetrics');
  const metric = (name) => metrics.find((entry) => entry.name === name)?.value ?? 0;
  const inPage = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll('canvas')];
    const canvasPixels = canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0);
    const pool = window.__canvasView?.canvasPool;
    let imageCache = null;
    try {
      imageCache = window.__wasm.getWebCanvasImageCacheStats();
    } catch {
      imageCache = null;
    }
    return {
      wasmBytes: window.__wasmMemory?.buffer?.byteLength ?? null,
      domCanvases: canvases.filter((canvas) => canvas.width > 0 && canvas.height > 0).length,
      domCanvasPixels: canvasPixels,
      poolRetainedBytes: pool?.retainedBackingBytes ?? null,
      domImages: document.querySelectorAll('#scroll-content img').length,
      imageCache,
    };
  });
  const row = {
    label,
    rendererMiB: renderer ? +(renderer.bytes / MiB).toFixed(1) : null,
    jsHeapMiB: +(metric('JSHeapUsedSize') / MiB).toFixed(1),
    wasmMiB: inPage.wasmBytes === null ? null : +(inPage.wasmBytes / MiB).toFixed(1),
    domCanvases: inPage.domCanvases,
    domCanvasMiB: +((inPage.domCanvasPixels * 4) / MiB).toFixed(1),
    poolRetainedMiB: inPage.poolRetainedBytes === null ? null : +(inPage.poolRetainedBytes / MiB).toFixed(1),
    domImages: inPage.domImages,
    imageCache: inPage.imageCache,
  };
  console.log(JSON.stringify(row));
  return row;
}

async function scrollPages(page, indices) {
  return page.evaluate(async (pages) => {
    const container = document.querySelector('#scroll-container');
    const virtualScroll = window.__canvasView?.getVirtualScroll?.();
    if (!(container instanceof HTMLElement) || !virtualScroll) throw new Error('viewport unavailable');
    const startedAt = performance.now();
    for (const pageIndex of pages) {
      container.scrollTop = virtualScroll.getPageOffset(pageIndex);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    return performance.now() - startedAt;
  }, indices);
}

const browser = await launchBrowser();
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: DPR });
await page.evaluateOnNewDocument(() => {
  const capture = (result) => {
    const instance = result?.instance ?? result;
    const memory = instance?.exports?.memory;
    if (memory instanceof WebAssembly.Memory && !window.__wasmMemory) window.__wasmMemory = memory;
    return result;
  };
  const streaming = WebAssembly.instantiateStreaming;
  if (streaming) WebAssembly.instantiateStreaming = (...args) => streaming(...args).then(capture);
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = (...args) => instantiate(...args).then(capture);
});
const cdp = await page.createCDPSession();
await cdp.send('Performance.enable');
const rows = [];
try {
  await loadApp(page, '?renderer=canvas2d');
  rows.push(await measure(browser, page, cdp, 'app'));

  const loaded = await page.evaluate(async ({ fname, url }) => {
    const startedAt = performance.now();
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const info = window.__wasm.loadDocument(bytes, fname);
    await window.__canvasView.loadDocument();
    return { pageCount: info.pageCount, loadMs: Math.round(performance.now() - startedAt) };
  }, { fname: path.basename(SAMPLE), url: sampleFetchPath(SAMPLE) });
  await settle(page, 2500);
  rows.push(await measure(browser, page, cdp, 'loaded'));

  const all = Array.from({ length: loaded.pageCount }, (_, index) => index);
  const scrollMs = await scrollPages(page, all);
  await settle(page, 2500);
  rows.push(await measure(browser, page, cdp, 'scrolled-100%'));

  await scrollPages(page, [0]);
  await page.evaluate((zoom) => window.__canvasView.viewportManager.setZoom(zoom), ZOOM);
  await settle(page, 1500);
  const zoomed = Array.from({ length: Math.min(ZOOM_PAGES, loaded.pageCount) }, (_, index) => index);
  const zoomScrollMs = await scrollPages(page, zoomed);
  await settle(page, 2500);
  rows.push(await measure(browser, page, cdp, `scrolled-${Math.round(ZOOM * 100)}%`));

  const report = {
    sample: SAMPLE,
    dpr: DPR,
    pageCount: loaded.pageCount,
    loadMs: loaded.loadMs,
    scrollMs: Math.round(scrollMs),
    zoomScrollMs: Math.round(zoomScrollMs),
    rows,
  };
  const output = arg('output', '');
  if (output) {
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify({ ...report, rows: undefined }));
} finally {
  await page.close().catch(() => {});
  await closeBrowser(browser);
}
