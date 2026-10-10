import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

/** 실제 DOM 스크롤과 이미지 저장을 확인하며 네이티브 게스트 연결과 허브 응답만 대체한다. */
test('캡처한 긴 페이지를 스크롤해 개체를 고르고 원본 픽셀을 저장하며 취소하면 게스트를 복원한다', { timeout: 30_000 }, async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'frozen-selection', configureServer(vite) { vite.middlewares.use((request, response, next) => {
      if (request.url !== '/frozen-selection') return next();
      response.setHeader('Content-Type', 'text/html'); response.end('<html><style>body{margin:0}#host{width:800px;height:650px}.ag-browser{height:100%}</style><div id="host"></div></html>');
    }); } }] });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage(); page.setDefaultTimeout(5000); await page.setViewport({ width: 1000, height: 800, deviceScaleFactor: 2 });
    await page.goto(`http://127.0.0.1:${address.port}/frozen-selection`);
    await page.evaluate(async () => {
      const calls: Array<{ action: string; args?: any }> = [];
      let attached: string | null = null; let hold = false; let resolveFreeze: (() => void) | undefined; let sequence = 0;
      Object.assign(window, { rhwpDesktop: { browser: {
        async attach(args: any) { calls.push({ action: 'attach', args }); attached = args.tabId; },
        async detach(args: any) { calls.push({ action: 'detach', args }); attached = null; }, async getState() { return {}; },
      } } });
      const tab = { tabId: 'tab', nativeTargetId: 'target', runtime: 'native', zoomFactor: 1.5, url: 'https://fixture.invalid/long', title: 'Frozen source', navigationEpoch: 1, controllerEpoch: 1, controller: { owner: 'human' }, status: 'ready' };
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 3500;
      const context = canvas.getContext('2d')!; context.fillStyle = 'white'; context.fillRect(0, 0, 640, 3500);
      context.fillStyle = '#1c8844'; context.fillRect(60, 2800, 220, 70);
      const element = { elementId: 'original', tag: 'button', role: 'button', name: 'Original button', text: 'Original button', depth: 4, rect: { x: 60, y: 2800, width: 220, height: 70 } };
      let frozen: any = null;
      const bridge = { getConnectionState: () => 'connected', onBrowserEvent: () => () => {}, onEvent: () => () => {}, async requestBrowser(action: string, args: any) {
        calls.push({ action, args });
        if (action === 'status') return { tabs: [tab] };
        if (action === 'freeze') {
          if (hold) await new Promise<void>(resolve => { resolveFreeze = resolve; });
          frozen = { freezeId: `freeze-${++sequence}`, expiresAt: Date.now() + 300_000, source: { url: tab.url, title: tab.title, timestamp: new Date().toISOString() }, viewport: { width: 640, height: 500, deviceScaleFactor: 2, scrollX: 0, scrollY: 0 }, elements: [structuredClone(element)],
            frame: { frameId: `frozen-${sequence}`, tabId: tab.tabId, navigationEpoch: 1, controllerEpoch: 1, mimeType: 'image/png', data: canvas.toDataURL('image/png').split(',')[1], width: 640, height: 3500, deviceScaleFactor: 1, scrollX: 0, scrollY: 0 } };
          return { frozen, tab };
        }
        if (action === 'capture') return { capture: { source: frozen.source, viewport: frozen.viewport, element: frozen.elements[0], rect: frozen.elements[0].rect, screenshot: { mimeType: frozen.frame.mimeType, data: frozen.frame.data, width: 640, height: 3500, clip: frozen.elements[0].rect } } };
        if (action === 'release-freeze') frozen = null;
        return {};
      } };
      const { createWorkbenchBrowser } = await import('../src/ui/agent-sidebar/workbench-browser.ts');
      const drafts: any[] = [];
      const view = createWorkbenchBrowser({ bridge: bridge as any, getDestination: () => ({ threadId: 'chat', projectId: null, documentId: null }), onCapture: draft => drafts.push(draft), onOpenDownload() {}, onDock() {}, onChat() {} });
      view.mount(document.querySelector<HTMLElement>('#host')!); view.setVisible(true);
      (window as any).frozenTest = { view, calls, drafts, get attached() { return attached; }, changeLive() { element.text = 'Changed live button'; canvas.getContext('2d')!.fillStyle = 'red'; canvas.getContext('2d')!.fillRect(60, 2800, 220, 70); }, hold() { hold = true; }, release() { hold = false; resolveFreeze?.(); } };
    });
    await page.waitForFunction(() => (window as any).frozenTest.attached === 'tab');
    await page.click('[aria-label="페이지·개체·영역에 의견 붙이기"]');
    await page.waitForFunction(() => document.querySelector<HTMLImageElement>('.ag-browser-frame')!.naturalHeight === 3500);
    await page.waitForFunction(() => (window as any).frozenTest.attached === null);
    await page.click('.ag-browser-annotation-modes button:nth-child(2)');
    const surface = await page.$eval('.ag-browser-surface', node => node.getBoundingClientRect().toJSON());
    await page.mouse.move(surface.x + 80, surface.y + 100); await page.mouse.wheel({ deltaY: 3100 });
    await page.waitForFunction(() => document.querySelector('.ag-browser-surface')!.scrollTop > 3000);
    const target = await page.$eval('.ag-browser-frame', node => { const r = node.getBoundingClientRect(); return { x: r.x + 170 * r.width / 640, y: r.y + 2835 * r.height / 3500 }; });
    await page.mouse.move(target.x, target.y);
    assert.equal(await page.$eval('.ag-browser-hover', node => (node as HTMLElement).hidden), false);
    await page.mouse.click(target.x, target.y);
    assert.equal(await page.$eval('.ag-browser-selection:not(.ag-browser-hover)', node => (node as HTMLElement).hidden), false);
    await page.evaluate(() => (window as any).frozenTest.changeLive());
    await page.click('[aria-label="의견과 자료를 선택한 채팅에 첨부"]');
    await page.waitForFunction(() => (window as any).frozenTest.drafts.length === 1);
    const saved = await page.evaluate(async () => {
      const draft = (window as any).frozenTest.drafts[0]; const image = await createImageBitmap(draft.files[0]);
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      return { text: draft.evidence.element.text, width: image.width, height: image.height, pixel: Array.from(context.getImageData(110, 35, 1, 1).data), inputs: (window as any).frozenTest.calls.filter((call: any) => call.action === 'input') };
    });
    assert.deepEqual(saved, { text: 'Original button', width: 220, height: 70, pixel: [28, 136, 68, 255], inputs: [] });
    await page.waitForFunction(() => (window as any).frozenTest.attached === 'tab');
    await page.evaluate(() => (window as any).frozenTest.hold());
    await page.click('[aria-label="페이지·개체·영역에 의견 붙이기"]');
    await page.waitForFunction(() => (window as any).frozenTest.attached === null);
    await page.keyboard.press('Escape'); await page.evaluate(() => (window as any).frozenTest.release());
    await page.waitForFunction(() => (window as any).frozenTest.calls.filter((call: any) => call.action === 'release-freeze').length === 2);
    await page.waitForFunction(() => (window as any).frozenTest.attached === 'tab');
    assert.equal(await page.$eval('.ag-browser-surface', node => node.classList.contains('ag-browser-frozen')), false);
    assert.equal(await page.$eval('.ag-browser-frame', node => node.hasAttribute('src')), false);
    await page.evaluate(() => (window as any).frozenTest.view.dispose());
  } finally { await browser?.close(); await server.close(); }
});
