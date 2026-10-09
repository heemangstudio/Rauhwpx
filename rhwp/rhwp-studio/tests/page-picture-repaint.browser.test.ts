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
  });
  server.middlewares.use('/repaint-test', (_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Picture repaint test</title>');
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/repaint-test`);
    return await fn(page);
  } finally {
    await browser?.close();
    await server.close();
  }
}

test('a page repaints when the engine reports its pictures decoded, and settles once nothing is pending', { timeout: 30_000 }, async () => {
  const result = await withStudioPage((page) => page.evaluate(async () => {
    const rendererModule = '/src/view/page-renderer.ts';
    const { PageRenderer } = await import(rendererModule);
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const pageInfo = {
      width: 100, height: 100, marginLeft: 10, marginRight: 10, marginTop: 10, marginBottom: 10,
      marginHeader: 5, marginFooter: 5,
    };
    const listeners = new Set<(pending: number) => void>();
    const decoded = (pending: number) => { for (const listener of [...listeners]) listener(pending); };
    // 쪽별로 엔진이 아직 디코드를 기다리는 그림 수
    const waiting = new Map<number, number>();
    const renders: number[] = [];
    const renderer = new PageRenderer({
      getPageInfo: () => pageInfo,
      getPageOverlayImages: () => JSON.stringify({
        hasBehind: false, hasFront: false, behind: [], front: [], imageCount: 1, rawSvgCount: 0,
        flowImageCount: 1, flowRawSvgCount: 0, flowStaticSplitSafe: false,
      }),
      renderPageToCanvasFiltered(pageIdx: number, canvas: HTMLCanvasElement) {
        renders.push(pageIdx);
        canvas.width = 100;
        canvas.height = 100;
        return waiting.get(pageIdx) ?? 0;
      },
      onPictureDecoded(listener: (pending: number) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const mount = (pageIdx: number) => {
      const parent = document.createElement('div');
      document.body.append(parent);
      const canvas = document.createElement('canvas');
      parent.append(canvas);
      renderer.renderPage(pageIdx, canvas, 1, 1, 1, {}, pageInfo);
      return canvas;
    };
    const count = (pageIdx: number) => renders.filter(rendered => rendered === pageIdx).length;

    waiting.set(0, 2);
    mount(0);
    mount(1);
    waiting.set(2, 1);
    const detached = mount(2);
    detached.parentElement!.remove();
    waiting.set(3, 1);
    mount(3);
    renderer.cancelReRender(3);
    const initial = [count(0), count(1), count(2), count(3)];

    // 한 그림이 끝났고 다른 디코드가 남았다 — 끝난 그림을 보여 주되 쪽은 계속 기다린다.
    waiting.set(0, 1);
    decoded(1);
    await wait(250);
    const progress = [count(0), count(1), count(2), count(3)];

    waiting.set(0, 0);
    decoded(0);
    await wait(100);
    const settled = [count(0), count(1), count(2), count(3)];

    decoded(0);
    await wait(1700);
    const afterFallback = [count(0), count(1), count(2), count(3)];
    renderer.dispose();
    return { initial, progress, settled, afterFallback, listeners: listeners.size };
  }));
  assert.deepEqual(result.initial, [1, 1, 1, 1]);
  assert.deepEqual(result.progress, [2, 1, 1, 1], '기다리는 쪽만 다시 그린다');
  assert.deepEqual(result.settled, [3, 1, 1, 1]);
  assert.deepEqual(result.afterFallback, [3, 1, 1, 1], '다 그린 쪽은 알림·fallback 으로 다시 그리지 않는다');
  assert.equal(result.listeners, 0);
});

test('without a decode signal the fallback repaints once, and a reused static layer keeps waiting', { timeout: 30_000 }, async () => {
  const result = await withStudioPage((page) => page.evaluate(async () => {
    const rendererModule = '/src/view/page-renderer.ts';
    const { PageRenderer } = await import(rendererModule);
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    let pending = 1;
    let repaints = 0;
    const renderer = new PageRenderer({});
    renderer.reRenderPageCanvases = () => { repaints += 1; return pending; };
    const parent = document.createElement('div');
    document.body.append(parent);
    const canvas = document.createElement('canvas');
    parent.append(canvas);
    const full = { reuseStaticFlow: false, reuseStaticOverlay: false };

    renderer.scheduleReRender(0, canvas, 1, 1, full);
    await wait(1600);
    const firstFallback = repaints;
    await wait(1600);
    const stillPending = repaints;

    // 텍스트 편집이 정적 층을 그대로 두고 본문만 다시 그렸다. 그 층이 기다리던 그림은 남는다.
    renderer.scheduleReRender(0, canvas, 1, 0, { reuseStaticFlow: false, reuseStaticOverlay: true });
    pending = 0;
    await wait(1600);
    const carried = repaints;
    renderer.dispose();
    return { firstFallback, stillPending, carried };
  }));
  assert.equal(result.firstFallback, 1);
  assert.equal(result.stillPending, 1, '알림 없이 같은 쪽을 계속 다시 그리지 않는다');
  assert.equal(result.carried, 2);
});

test('a detail region waiting on pictures is repainted when they decode, even when its page layers are settled', { timeout: 30_000 }, async () => {
  const result = await withStudioPage((page) => page.evaluate(async () => {
    const rendererModule = '/src/view/page-renderer.ts';
    const { PageRenderer } = await import(rendererModule);
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const pageInfo = {
      width: 100, height: 100, marginLeft: 10, marginRight: 10, marginTop: 10, marginBottom: 10,
      marginHeader: 5, marginFooter: 5,
    };
    const listeners = new Set<(pending: number) => void>();
    const decoded = (pending: number) => { for (const listener of [...listeners]) listener(pending); };
    let regionPending = 1;
    const renderer = new PageRenderer({
      getPageInfo: () => pageInfo,
      renderPageRegionToCanvas(_pageIdx: number, canvas: HTMLCanvasElement) {
        canvas.width = 50;
        canvas.height = 50;
        return regionPending;
      },
      onPictureDecoded(listener: (pending: number) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const repainted: number[] = [];
    renderer.setPageRepaintListener((pageIdx: number) => repainted.push(pageIdx));
    const region = { x: 0, y: 0, width: 50, height: 50 };

    // 쪽 층은 이미 그림을 다 그렸고(재렌더 작업 없음), 더 큰 배율의 detail 영역만 디코드를 기다린다.
    renderer.renderPageRegion(4, document.createElement('canvas'), 2, region);
    regionPending = 0;
    decoded(0);
    await wait(100);
    const afterDecode = [...repainted];

    renderer.renderPageRegion(4, document.createElement('canvas'), 2, region);
    decoded(0);
    await wait(100);
    const afterSettled = [...repainted];
    renderer.dispose();
    return { afterDecode, afterSettled };
  }));
  assert.deepEqual(result.afterDecode, [4]);
  assert.deepEqual(result.afterSettled, [4], '기다리는 그림이 없는 영역은 다시 그리지 않는다');
});

test('flow images the browser cannot display are drawn by the engine flow-static canvas', { timeout: 30_000 }, async () => {
  const result = await withStudioPage((page) => page.evaluate(async () => {
    const rendererModule = '/src/view/page-renderer.ts';
    const { PageRenderer } = await import(rendererModule);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII=';
    const wmf = btoa(String.fromCharCode(0xd7, 0xcd, 0xc6, 0x9a, 0, 0, 0, 0, 0, 0, 0x10, 0x27));

    const renderWith = (mime: string, base64: string) => {
      const kinds: string[] = [];
      const pageInfo = {
        width: 100, height: 100, marginLeft: 10, marginRight: 10, marginTop: 10, marginBottom: 10,
        marginHeader: 5, marginFooter: 5,
      };
      const renderer = new PageRenderer({
        getPageInfo: () => pageInfo,
        getPageOverlayImages: () => JSON.stringify({
          hasBehind: false, hasFront: false, behind: [], front: [], imageCount: 1, rawSvgCount: 0,
          flowImageCount: 1, flowRawSvgCount: 0, flowStaticSplitSafe: true,
        }),
        getPageLayerTree: () => JSON.stringify({ root: { kind: 'leaf', ops: [
          { type: 'image', bbox: { x: 10, y: 10, width: 50, height: 50 }, mime, base64 },
        ] } }),
        renderPageToCanvasFiltered(_page: number, canvas: HTMLCanvasElement, scale: number, kind: string) {
          kinds.push(kind);
          canvas.width = 100 * scale;
          canvas.height = 100 * scale;
          return kind === 'flow-static' ? 1 : 0;
        },
      });
      let scheduledImages = -1;
      const schedule = renderer.scheduleReRender.bind(renderer);
      renderer.scheduleReRender = (...args: unknown[]) => {
        scheduledImages = args[3] as number;
        return schedule(...args);
      };
      const parent = document.createElement('div');
      document.body.append(parent);
      const canvas = document.createElement('canvas');
      parent.append(canvas);
      const rendered = renderer.renderPage(0, canvas, 1, 1, 1, { reason: 'unknown' }, pageInfo);
      const summary = {
        kinds,
        domImageLayer: parent.querySelector('[data-rhwp-flow-image-page="0"]') !== null,
        domImages: parent.querySelectorAll('[data-rhwp-flow-image-page="0"] img').length,
        flowStaticLayer: parent.querySelector('[data-rhwp-layer-kind="flow-static"]') !== null,
        scheduledImages,
        needsVerification: rendered.needsTextEditStaticLayerVerification,
      };
      renderer.dispose();
      parent.remove();
      return summary;
    };
    return { png: renderWith('image/png', png), wmf: renderWith('image/x-wmf', wmf) };
  }));
  assert.deepEqual(result.png, {
    kinds: ['flow-dynamic'],
    domImageLayer: true,
    domImages: 1,
    flowStaticLayer: false,
    scheduledImages: 0,
    needsVerification: false,
  });
  // WMF 를 `<img>` 로 띄우면 빈 칸이다. flow canvas 는 이미 그림을 뺐으므로 엔진이 그린다.
  assert.deepEqual(result.wmf, {
    kinds: ['flow-dynamic', 'flow-static'],
    domImageLayer: false,
    domImages: 0,
    flowStaticLayer: true,
    scheduledImages: 1,
    needsVerification: false,
  });
});

test('after an engine trap, deferred image repaints keep the last painted layers', { timeout: 30_000 }, async () => {
  const result = await withStudioPage((page) => page.evaluate(async () => {
    const rendererModule = '/src/view/page-renderer.ts';
    const trapModule = '/src/core/engine-trap.ts';
    const { PageRenderer } = await import(rendererModule);
    const { EngineTrappedError, engineTrap, reportEngineTrap } = await import(trapModule);
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const parent = document.createElement('div');
    document.body.append(parent);
    const paintedCanvas = (kind?: string) => {
      const canvas = document.createElement('canvas');
      canvas.width = 8;
      canvas.height = 8;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#ff0000';
      context.fillRect(0, 0, 8, 8);
      if (kind) {
        canvas.dataset.rhwpOverlayPage = '0';
        canvas.dataset.rhwpLayerKind = kind;
      }
      parent.append(canvas);
      return canvas;
    };
    const flowStatic = paintedCanvas('flow-static');
    const flow = paintedCanvas();
    const front = paintedCanvas('front');
    const red = (canvas: HTMLCanvasElement) => canvas.getContext('2d')!.getImageData(4, 4, 1, 1).data[0] === 255;

    let renderCalls = 0;
    let uncaught = 0;
    window.addEventListener('error', () => { uncaught += 1; });
    const renderer = new PageRenderer({
      renderPageToCanvasFiltered() {
        renderCalls += 1;
        // guardEngineCalls 가 trap 을 알린 뒤 던지는 것과 같은 순서.
        const error = new WebAssembly.RuntimeError('unreachable');
        reportEngineTrap(error);
        throw error;
      },
      getPageLayerTree() { throw new EngineTrappedError('unreachable'); },
    });
    const policy = { reuseStaticFlow: true, reuseStaticOverlay: false };

    // 엔진 호출이 trap 하면 층을 지우지 않고 그대로 둔다.
    renderer.reRenderPageCanvases(0, flow, 1, policy);
    const afterTrappedCall = {
      trapped: engineTrap() !== null,
      renderCalls,
      flowStaticAttached: flowStatic.isConnected,
      flowStaticRed: red(flowStatic),
      flowRed: red(flow),
      frontRed: red(front),
    };

    // trap 뒤에 도는 fallback 타이머는 엔진을 다시 부르지 않는다.
    renderer.scheduleReRender(0, flow, 1, 1, policy);
    await wait(1600);
    renderer.dispose();
    return {
      afterTrappedCall,
      callsAfterTimers: renderCalls,
      uncaught,
      stillRed: red(flowStatic) && red(flow) && red(front),
    };
  }));
  assert.deepEqual(result.afterTrappedCall, {
    trapped: true,
    renderCalls: 1,
    flowStaticAttached: true,
    flowStaticRed: true,
    flowRed: true,
    frontRed: true,
  });
  assert.equal(result.callsAfterTimers, 1);
  assert.equal(result.uncaught, 0);
  assert.equal(result.stillRed, true);
});
