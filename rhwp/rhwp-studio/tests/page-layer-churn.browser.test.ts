import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

type BrowserPage = Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>['newPage']>>;

/** alias 없는 Vite 로 Studio 모듈을 띄운 빈 페이지에서 fn 을 실행한다. */
async function withStudioPage<T>(fn: (page: BrowserPage) => Promise<T>): Promise<T> {
  const server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'layer-churn-test-page',
      // Vite 의 SPA fallback 보다 먼저 둬서 앱 index.html 대신 빈 페이지를 띄운다.
      configureServer(viteServer) {
        viteServer.middlewares.use('/layer-churn-test', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><title>Page layer churn test</title>');
        });
      },
    }],
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/layer-churn-test`);
    return await fn(page);
  } finally {
    await browser?.close();
    await server.close();
  }
}

test('typing on a page with body images keeps its image layer without re-reading overlay or layer-tree JSON', { timeout: 30_000 }, async () => {
  const result = await withStudioPage((page) => page.evaluate(async () => {
    const rendererModule = '/src/view/page-renderer.ts';
    const { PageRenderer } = await import(rendererModule);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII=';
    const pageInfo = {
      width: 100, height: 100, marginLeft: 10, marginRight: 10, marginTop: 10, marginBottom: 10,
      marginHeader: 5, marginFooter: 5,
    };
    let treeReads = 0;
    let overlayReads = 0;
    const renderer = new PageRenderer({
      getPageInfo: () => pageInfo,
      getPageOverlayImages: () => {
        overlayReads += 1;
        return JSON.stringify({
          hasBehind: false, hasFront: false, behind: [], front: [], imageCount: 1, rawSvgCount: 0,
          flowImageCount: 1, flowRawSvgCount: 0, flowStaticSplitSafe: true,
        });
      },
      getPageLayerTree: () => {
        treeReads += 1;
        return JSON.stringify({ root: { kind: 'leaf', ops: [
          { type: 'image', bbox: { x: 10, y: 10, width: 50, height: 50 }, mime: 'image/png', base64: png },
        ] } });
      },
      renderPageToCanvasFiltered(_page: number, canvas: HTMLCanvasElement, scale: number) {
        canvas.width = 100 * scale;
        canvas.height = 100 * scale;
      },
    });
    const parent = document.createElement('div');
    document.body.append(parent);
    const canvas = document.createElement('canvas');
    parent.append(canvas);
    const imageLayer = () => parent.querySelector('[data-rhwp-flow-image-page="0"]');
    const shownImages = () => parent.querySelectorAll('[data-rhwp-flow-image-page="0"] img').length;
    try {
      renderer.renderPage(0, canvas, 1, 1, 1, { reason: 'unknown' }, pageInfo);
      const first = { treeReads, overlayReads, layer: imageLayer(), images: shownImages() };

      for (let key = 0; key < 5; key++) {
        // CanvasView 는 키 입력마다 문서 revision 을 올리고 renderer 에 알린다.
        renderer.invalidateDocumentRevision();
        renderer.renderPage(0, canvas, 1, 1, 1, { reason: 'text-edit', allowStaticOverlayReuse: true }, pageInfo);
      }
      const typed = { treeReads, overlayReads, sameLayer: imageLayer() === first.layer, images: shownImages() };

      // 입력이 멈춘 뒤의 검증 렌더는 요약과 그림을 새로 읽어 층을 다시 만든다.
      renderer.renderPage(0, canvas, 1, 1, 1, { reason: 'unknown' }, pageInfo);
      const verified = { treeReads, overlayReads, newLayer: imageLayer() !== first.layer, images: shownImages() };
      return {
        first: { treeReads: first.treeReads, overlayReads: first.overlayReads, images: first.images },
        typed,
        verified,
      };
    } finally {
      renderer.dispose();
      parent.remove();
    }
  }));
  assert.deepEqual(result.first, { treeReads: 1, overlayReads: 1, images: 1 });
  assert.deepEqual(result.typed, { treeReads: 1, overlayReads: 1, sameLayer: true, images: 1 },
    '텍스트 편집 렌더는 그림 base64 를 담은 요약/트리를 다시 읽지 않고 같은 그림 층을 쓴다');
  assert.deepEqual(result.verified, { treeReads: 2, overlayReads: 2, newLayer: true, images: 1 });
});

test('overlay canvases dropped by a re-render or page release give back their backing stores', { timeout: 30_000 }, async () => {
  const result = await withStudioPage((page) => page.evaluate(async () => {
    const rendererModule = '/src/view/page-renderer.ts';
    const { PageRenderer } = await import(rendererModule);
    const pageInfo = {
      width: 100, height: 100, marginLeft: 10, marginRight: 10, marginTop: 10, marginBottom: 10,
      marginHeader: 5, marginFooter: 5,
    };
    const renderer = new PageRenderer({
      getPageInfo: () => pageInfo,
      getPageOverlayImages: () => JSON.stringify({
        hasBehind: true, hasFront: true, behind: [], front: [], imageCount: 0, rawSvgCount: 0,
        flowImageCount: 0, flowRawSvgCount: 0, flowStaticSplitSafe: false,
      }),
      getPageLayerTree: () => JSON.stringify({ root: { kind: 'leaf', ops: [] } }),
      renderPageToCanvasFiltered(_page: number, canvas: HTMLCanvasElement, scale: number, kind: string) {
        canvas.width = 100 * scale;
        canvas.height = 100 * scale;
        if (kind !== 'flow') {
          const context = canvas.getContext('2d')!;
          context.fillStyle = '#00ff00';
          context.fillRect(0, 0, canvas.width, canvas.height);
        }
      },
    });
    const parent = document.createElement('div');
    document.body.append(parent);
    const canvas = document.createElement('canvas');
    parent.append(canvas);
    const overlays = () => Array.from(parent.querySelectorAll<HTMLCanvasElement>('canvas[data-rhwp-overlay-page="0"]'));
    const describe = (list: HTMLCanvasElement[]) => list.map((layer) => ({
      kind: layer.dataset.rhwpLayerKind,
      attached: layer.isConnected,
      size: `${layer.width}x${layer.height}`,
    }));
    const green = (layer: HTMLCanvasElement) =>
      layer.getContext('2d')!.getImageData(50, 50, 1, 1).data[1] === 255;
    try {
      renderer.renderPage(0, canvas, 2, 2, 1, { reason: 'unknown' }, pageInfo);
      const first = overlays();

      // 텍스트 편집 렌더는 같은 층을 그대로 쓴다 — 그린 내용도 남아 있어야 한다.
      renderer.renderPage(0, canvas, 2, 2, 1, { reason: 'text-edit', allowStaticOverlayReuse: true }, pageInfo);
      const reused = overlays();
      const reuse = {
        sameLayers: reused.length === first.length && reused.every((layer, index) => layer === first[index]),
        painted: reused.every(green),
      };

      // 전체 새로고침은 층을 새로 만든다. 떼어 낸 옛 층은 backing store 를 바로 비운다.
      renderer.renderPage(0, canvas, 2, 2, 1, { reason: 'unknown' }, pageInfo);
      const second = overlays();
      const refreshed = { dropped: describe(first), current: describe(second), painted: second.every(green) };

      // 쪽을 화면에서 내릴 때도 같다.
      renderer.removePageLayers(parent, 0);
      return { reuse, refreshed, released: describe(second) };
    } finally {
      renderer.dispose();
      parent.remove();
    }
  }));
  assert.deepEqual(result.reuse, { sameLayers: true, painted: true });
  const kinds = ['background', 'behind', 'front'];
  assert.deepEqual(result.refreshed.dropped, kinds.map((kind) => ({ kind, attached: false, size: '0x0' })));
  assert.deepEqual(result.refreshed.current, kinds.map((kind) => ({ kind, attached: true, size: '200x200' })));
  assert.equal(result.refreshed.painted, true);
  assert.deepEqual(result.released, kinds.map((kind) => ({ kind, attached: false, size: '0x0' })));
});

test('the first render of an engine-drawn body image reads the layer tree once for paint and prefetch', { timeout: 30_000 }, async () => {
  const result = await withStudioPage((page) => page.evaluate(async () => {
    const rendererModule = '/src/view/page-renderer.ts';
    const { PageRenderer } = await import(rendererModule);
    // WMF 는 `<img>` 로 못 띄워 엔진 flow-static canvas 가 그리고, 비동기 디코드 재렌더도 건다.
    const wmf = btoa(String.fromCharCode(0xd7, 0xcd, 0xc6, 0x9a, 0, 0, 0, 0, 0, 0, 0x10, 0x27));
    const pageInfo = {
      width: 100, height: 100, marginLeft: 10, marginRight: 10, marginTop: 10, marginBottom: 10,
      marginHeader: 5, marginFooter: 5,
    };
    let treeReads = 0;
    let repaints = 0;
    const renderer = new PageRenderer({
      getPageInfo: () => pageInfo,
      getPageOverlayImages: () => JSON.stringify({
        hasBehind: false, hasFront: false, behind: [], front: [], imageCount: 1, rawSvgCount: 0,
        flowImageCount: 1, flowRawSvgCount: 0, flowStaticSplitSafe: true,
      }),
      getPageLayerTree: () => {
        treeReads += 1;
        return JSON.stringify({ root: { kind: 'leaf', ops: [
          { type: 'image', bbox: { x: 10, y: 10, width: 50, height: 50 }, mime: 'image/x-wmf', base64: wmf },
        ] } });
      },
      renderPageToCanvasFiltered(_page: number, canvas: HTMLCanvasElement, scale: number, kind: string) {
        if (kind === 'flow-static' && canvas.isConnected) repaints += 1;
        canvas.width = 100 * scale;
        canvas.height = 100 * scale;
      },
    });
    const parent = document.createElement('div');
    document.body.append(parent);
    const canvas = document.createElement('canvas');
    parent.append(canvas);
    try {
      renderer.renderPage(0, canvas, 1, 1, 1, { reason: 'unknown' }, pageInfo);
      await new Promise(resolve => setTimeout(resolve, 0));
      const afterPrefetchPlan = { treeReads, engineLayer: parent.querySelector('[data-rhwp-layer-kind="flow-static"]') !== null };
      // 미리 디코드할 수 없는 그림이므로 fallback 시점에 한 번 다시 그린다.
      await new Promise(resolve => setTimeout(resolve, 1600));
      return { afterPrefetchPlan, repaints, treeReads };
    } finally {
      renderer.dispose();
      parent.remove();
    }
  }));
  assert.deepEqual(result.afterPrefetchPlan, { treeReads: 1, engineLayer: true },
    '첫 렌더가 읽은 트리로 prefetch 계획도 세운다');
  assert.equal(result.repaints, 1);
  assert.equal(result.treeReads, 1);
});
