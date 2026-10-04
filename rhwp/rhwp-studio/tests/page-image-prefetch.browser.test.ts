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
  server.middlewares.use('/prefetch-test', (_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Image prefetch test</title>');
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/prefetch-test`);
    return await fn(page);
  } finally {
    await browser?.close();
    await server.close();
  }
}

test('page invalidation and fallback release prefetch work without stale repaints', { timeout: 30_000 }, async () => {
  const result = await withStudioPage((page) => page.evaluate(async () => {
    const prefetchModule = '/src/view/image-prefetch.ts';
    const { ImagePrefetcher } = await import(prefetchModule);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII=';
    // Exercise native decode and event settlement before substituting stalled decoders.
    await new ImagePrefetcher().prefetch([`data:image/png;base64,${png}`], new AbortController().signal);

    const rendererModule = '/src/view/page-renderer.ts';
    const { PageRenderer } = await import(rendererModule);
    const images: Array<{ src: string; onload: (() => void) | null; onerror: (() => void) | null }> = [];
    const NativeImage = window.Image;
    window.Image = class {
      src = '';
      onload = null;
      onerror = null;
      constructor() { images.push(this); }
      decode() { return new Promise(() => {}); }
      removeAttribute() { this.src = ''; }
    } as unknown as typeof Image;
    // GIF 는 엔진이 HtmlImageElement 로 비동기 로드한다. bbox 가 mime 앞에 오는 실제 필드 순서.
    const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    let reads = 0;
    let repaints = 0;
    const renderer = new PageRenderer({ getPageLayerTree() {
      reads += 1;
      return JSON.stringify({ root: { kind: 'leaf', ops: Array.from({ length: 20 }, (_, index) => ({
        type: 'image', bbox: { x: 0, y: 0, width: 1, height: 1 }, mime: 'image/gif', base64: gif + ' '.repeat(index),
      })) } });
    } });
    renderer.reRenderPageCanvases = () => { repaints += 1; };
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const schedule = (revision: number) => renderer.scheduleReRender(0, canvas, 1, 20, 0, {
      retrySignature: String(revision), reuseStaticFlow: false, reuseStaticOverlay: false,
    });
    try {
      for (let revision = 0; revision < 100; revision++) {
        schedule(revision);
        renderer.invalidateDocumentRevision();
      }
      await Promise.resolve();
      const cancelledBeforeStart = { reads, decoders: images.length };

      schedule(100);
      await Promise.resolve();
      const activeDecoders = images.length;
      const lateOnLoad = images[0].onload!;
      renderer.invalidateDocumentRevision();
      lateOnLoad();
      await Promise.resolve();
      const cancelledAfterStart = { repaints, retained: images.filter(image => image.src).length };

      schedule(101);
      await new Promise(resolve => setTimeout(resolve, 1600));
      const fallback = { repaints, retained: images.filter(image => image.src).length, decoders: images.length };
      schedule(102);
      await Promise.resolve();
      renderer.dispose();
      return {
        cancelledBeforeStart, activeDecoders, cancelledAfterStart, fallback,
        retainedAfterDispose: images.filter(image => image.src).length,
      };
    } finally {
      renderer.dispose();
      window.Image = NativeImage;
    }
  }));
  assert.deepEqual(result.cancelledBeforeStart, { reads: 0, decoders: 0 });
  assert.equal(result.activeDecoders, 4);
  assert.deepEqual(result.cancelledAfterStart, { repaints: 0, retained: 0 });
  assert.deepEqual(result.fallback, { repaints: 1, retained: 0, decoders: 8 });
  assert.equal(result.retainedAfterDispose, 0);
});

test('a job cancelled before decode re-arms only its fallback, and a settled page stays settled', { timeout: 30_000 }, async () => {
  const result = await withStudioPage((page) => page.evaluate(async () => {
    const rendererModule = '/src/view/page-renderer.ts';
    const { PageRenderer } = await import(rendererModule);
    const images: unknown[] = [];
    const NativeImage = window.Image;
    window.Image = class {
      src = '';
      onload = null;
      onerror = null;
      constructor() { images.push(this); }
      decode() { return new Promise(() => {}); }
      removeAttribute() { this.src = ''; }
    } as unknown as typeof Image;
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII=';
    const wmf = btoa(String.fromCharCode(0xd7, 0xcd, 0xc6, 0x9a, 0, 0, 0, 0, 0, 0, 0x10, 0x27));
    const tree = (mime: string, base64: string) => JSON.stringify({ root: { kind: 'leaf', ops: [
      { type: 'image', bbox: { x: 0, y: 0, width: 1, height: 1 }, mime, base64 },
    ] } });
    const policy = { retrySignature: 'same', reuseStaticFlow: false, reuseStaticOverlay: false };

    const track = (json: string) => {
      const counts = { reads: 0, repaints: 0 };
      const renderer = new PageRenderer({ getPageLayerTree() { counts.reads += 1; return json; } });
      renderer.reRenderPageCanvases = () => { counts.repaints += 1; };
      const canvas = document.createElement('canvas');
      document.body.append(canvas);
      const schedule = () => renderer.scheduleReRender(0, canvas, 1, 1, 0, policy);
      return { renderer, counts, schedule };
    };

    try {
      // 새로고침(cancelAll) 이 디코드 도중 작업을 끊은 뒤 같은 내용으로 다시 그린다.
      const gifPage = track(tree('image/gif', gif));
      gifPage.schedule();
      await Promise.resolve();
      const started = { ...gifPage.counts, decoders: images.length };
      gifPage.renderer.cancelAll();
      gifPage.schedule();
      await Promise.resolve();
      const rearmed = { ...gifPage.counts, decoders: images.length };
      await wait(1600);
      const afterFallback = { ...gifPage.counts };
      gifPage.schedule();
      await wait(1600);
      const afterSettled = { ...gifPage.counts };
      gifPage.renderer.dispose();

      // 엔진이 동기로 그린 PNG 만 있는 쪽은 다시 그리지 않는다.
      const pngPage = track(tree('image/png', png));
      pngPage.schedule();
      await wait(1600);
      const pngOnly = { ...pngPage.counts };
      pngPage.renderer.dispose();

      // WMF 는 엔진이 SVG 로 바꿔 비동기로 로드한다. 첫 paint 직후가 아니라 fallback 에서 다시 그린다.
      const wmfPage = track(tree('image/x-wmf', wmf));
      wmfPage.schedule();
      await wait(100);
      const wmfEarly = { ...wmfPage.counts };
      await wait(1500);
      const wmfLate = { ...wmfPage.counts };
      wmfPage.renderer.dispose();

      return { started, rearmed, afterFallback, afterSettled, pngOnly, wmfEarly, wmfLate };
    } finally {
      window.Image = NativeImage;
    }
  }));
  assert.deepEqual(result.started, { reads: 1, repaints: 0, decoders: 1 });
  assert.deepEqual(result.rearmed, { reads: 1, repaints: 0, decoders: 1 },
    '같은 내용의 재시도는 트리를 다시 읽거나 디코드를 새로 걸지 않는다');
  assert.deepEqual(result.afterFallback, { reads: 1, repaints: 1 });
  assert.deepEqual(result.afterSettled, { reads: 1, repaints: 1 }, '끝난 key 는 다시 걸지 않는다');
  assert.deepEqual(result.pngOnly, { reads: 1, repaints: 0 });
  assert.deepEqual(result.wmfEarly, { reads: 1, repaints: 0 });
  assert.deepEqual(result.wmfLate, { reads: 1, repaints: 1 });
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
    const policy = { retrySignature: 'x', reuseStaticFlow: true, reuseStaticOverlay: false };

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
    renderer.scheduleReRender(0, flow, 1, 1, 1, policy);
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
