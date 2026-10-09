import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  closeBrowser,
  closePage,
  createPage,
  launchBrowser,
  loadApp,
  loadHwpFile,
} from './helpers.mjs';

const SAMPLE = '2025 행정업무운영 편람(최종).hwpx';

function outputPath() {
  const arg = process.argv.find((value) => value.startsWith('--output='));
  return arg?.slice('--output='.length) ?? '';
}

const browser = await launchBrowser();
const page = await createPage(browser, 1280, 900);
try {
  await loadApp(page, '?renderer=canvas2d');
  const loaded = await loadHwpFile(page, SAMPLE);
  const result = await page.evaluate(async (pageCount) => {
    const container = document.querySelector('#scroll-container');
    const virtualScroll = window.__canvasView?.getVirtualScroll?.();
    if (!(container instanceof HTMLElement) || !virtualScroll) {
      throw new Error('long-document viewport is unavailable');
    }

    const startedAt = performance.now();
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      container.scrollTop = virtualScroll.getPageOffset(pageIndex);
      await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
    }
    // 디코드가 끝난 뒤, 최근에 그린 그림을 지키는 시간(1 s)이 지나 예산 정리가 돌 때까지 기다린다.
    const settleStartedAt = performance.now();
    while (window.__wasm.getWebCanvasImageCacheStats().pendingDecodes > 0) {
      if (performance.now() - settleStartedAt > 15000) throw new Error('picture decodes did not settle');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const stats = window.__wasm.getWebCanvasImageCacheStats();
    const activeCanvases = [...container.querySelectorAll('canvas')]
      .filter((canvas) => canvas.width > 0 && canvas.height > 0)
      .length;
    return {
      pageCount,
      scrollAndRenderMs: performance.now() - startedAt,
      activeCanvases,
      stats,
    };
  }, loaded.pageCount);

  // 한컴 PDF(pdf/2025 행정업무운영 편람(최종)-2024.pdf)는 383쪽이다. 현재 조판은 381쪽.
  assert.equal(result.pageCount, 381);
  assert.ok(result.activeCanvases > 0);
  assert.ok(
    result.stats.pictureBytes <= result.stats.pictureBudgetBytes,
    `decoded picture cache exceeds budget: ${JSON.stringify(result.stats)}`,
  );
  assert.equal(result.stats.pendingDecodes, 0);
  assert.equal(result.stats.failedPictures, 0, `pictures failed to decode: ${JSON.stringify(result.stats)}`);
  const report = {
    sample: SAMPLE,
    documentLoadAndInitialRenderMs: loaded.documentLoadAndInitialRenderMs,
    ...result,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  console.log(serialized);
  const output = outputPath();
  if (output) {
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, serialized);
  }
} finally {
  await closePage(page);
  await closeBrowser(browser);
}
