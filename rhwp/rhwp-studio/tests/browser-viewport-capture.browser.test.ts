import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

/** 실제 컴포넌트의 이미지 첨부와 입력을 확인하고 허브와 네이티브 배치만 대체한다. */
test('현재 화면을 한 번 첨부하고 캡처 중에도 브라우저 입력과 배치를 유지한다', { timeout: 30_000 }, async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'viewport-capture', configureServer(vite) { vite.middlewares.use((request, response, next) => {
      if (request.url !== '/viewport-capture') return next();
      response.setHeader('Content-Type', 'text/html'); response.end('<html><style>body{margin:0}#host{width:800px;height:650px}.ag-browser{height:100%}</style><div id="host"></div><div id="attachment" style="width:160px;height:30px;margin:20px"></div></html>');
    }); } }] });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage(); page.setDefaultTimeout(5000); await page.setViewport({ width: 1000, height: 800, deviceScaleFactor: 2 });
    await page.goto(`http://127.0.0.1:${address.port}/viewport-capture`);
    await page.evaluate(async () => {
      const calls: Array<{ action: string; args?: any }> = []; let attached: string | null = null; let release: (() => void) | undefined; let nativeEvent: ((event: any) => void) | undefined;
      Object.assign(window, { rhwpDesktop: { browser: {
        async attach(args: any) { calls.push({ action: 'attach', args }); attached = args.tabId; },
        async detach(args: any) { calls.push({ action: 'detach', args }); attached = null; }, async getState() { return {}; }, onEvent(callback: any) { nativeEvent = callback; return () => {}; },
      } } });
      const tab = { tabId: 'tab', nativeTargetId: 'target', runtime: 'native', zoomFactor: 1, url: 'https://fixture.invalid/long', title: 'Viewport source', navigationEpoch: 1, controllerEpoch: 1, controller: { owner: 'agent' }, status: 'ready' };
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 500;
      const context = canvas.getContext('2d')!; context.fillStyle = '#1c8844'; context.fillRect(0, 0, 640, 500);
      const bridge = { getConnectionState: () => 'connected', onBrowserEvent: () => () => {}, onEvent: () => () => {}, async requestBrowser(action: string, args: any) {
        calls.push({ action, args });
        if (action === 'status') return { tabs: [tab] };
        if (action === 'capture') {
          await new Promise<void>(resolve => { release = resolve; });
          return { capture: { source: { url: tab.url, title: tab.title }, viewport: { width: 640, height: 500, scrollX: 0, scrollY: 9000 }, mode: 'page',
            screenshot: { mimeType: 'image/png', data: canvas.toDataURL('image/png').split(',')[1], width: 640, height: 500 } } };
        }
        return {};
      } };
      const { createWorkbenchBrowser } = await import('../src/ui/agent-sidebar/workbench-browser.ts'); const drafts: any[] = [];
      const view = createWorkbenchBrowser({ bridge: bridge as any, getDestination: () => ({ threadId: 'chat', projectId: null, documentId: null }), onCapture: draft => { drafts.push(draft); return document.querySelector<HTMLElement>('#attachment')!; }, onOpenDownload() {}, onDock() {}, onChat() {} });
      view.mount(document.querySelector<HTMLElement>('#host')!); view.setVisible(true);
      (window as any).captureTest = { view, calls, drafts, get attached() { return attached; }, release: () => release?.(), emit: (event: any) => nativeEvent?.(event) };
    });
    await page.waitForFunction(() => (window as any).captureTest.attached === 'tab');
    await page.click('[aria-label="현재 화면을 캡처해 채팅에 첨부"]');
    await page.waitForFunction(() => (window as any).captureTest.calls.some((call: any) => call.action === 'capture'));
    assert.equal(await page.evaluate(() => (window as any).captureTest.attached), 'tab');
    const surface = await page.$eval('.ag-browser-surface', node => node.getBoundingClientRect().toJSON());
    await page.mouse.move(surface.x + 100, surface.y + 100); await page.mouse.wheel({ deltaY: 300 });
    await page.waitForFunction(() => (window as any).captureTest.calls.some((call: any) => call.action === 'input' && call.args.type === 'wheel'));
    await page.evaluate(() => (window as any).captureTest.release());
    await page.waitForFunction(() => (window as any).captureTest.drafts.length === 1);
    // 첨부 피드백이 저장을 지연시키지 않고 완료되면 동작을 해제한다.
    await page.waitForFunction(() => document.querySelector('#attachment')!.getAnimations().length > 0);
    await page.waitForFunction(() => document.querySelector('#attachment')!.getAnimations().length === 0);
    const saved = await page.evaluate(async () => {
      const fixture = (window as any).captureTest; const draft = fixture.drafts[0]; const image = await createImageBitmap(draft.files[0]);
      return { mode: draft.mode, thread: draft.destination.threadId, width: image.width, height: image.height, captures: fixture.calls.filter((call: any) => call.action === 'capture').length,
        detach: fixture.calls.filter((call: any) => call.action === 'detach').length, blocked: fixture.calls.some((call: any) => call.action === 'attach' && call.args.interactive === false),
        scroll: document.querySelector('.ag-browser-surface')!.scrollTop };
    });
    assert.deepEqual(saved, { mode: 'page', thread: 'chat', width: 640, height: 500, captures: 1, detach: 0, blocked: false, scroll: 0 });
    await page.click('[aria-label="브라우저 추가 메뉴"]');
    await page.click('.ag-browser-menu [aria-label="새로고침"]');
    await page.waitForFunction(() => (window as any).captureTest.calls.some((call: any) => call.action === 'navigate' && call.args.direction === 'reload'));
    await page.waitForFunction(() => (window as any).captureTest.attached === 'tab');
    await page.evaluate(() => (window as any).captureTest.view.float());
    await page.click('.ag-browser-floating-chrome [aria-label="현재 화면을 캡처해 채팅에 첨부"]');
    await page.waitForFunction(() => (window as any).captureTest.calls.filter((call: any) => call.action === 'capture').length === 2);
    await page.evaluate(() => (window as any).captureTest.release());
    await page.waitForFunction(() => (window as any).captureTest.drafts.length === 2);
    assert.equal(await page.$eval('.ag-browser', node => (node as HTMLElement).dataset.presentation), 'float', 'capture leaves the floating page open');
    await page.evaluate(() => {
      (window as any).captureTest.emit({ type: 'presentation-command', tabId: 'tab', command: 'capture' });
    });
    await page.waitForFunction(() => (window as any).captureTest.calls.filter((call: any) => call.action === 'capture').length === 3);
    await page.evaluate(() => (window as any).captureTest.release());
    await page.waitForFunction(() => (window as any).captureTest.drafts.length === 3);
    assert.equal(await page.$eval('.ag-browser', node => (node as HTMLElement).dataset.presentation), 'float', 'a separate-window capture command does not dock or hide its page');
    await page.evaluate(() => (document.querySelector('[aria-label="별도 창으로 열기"]') as HTMLButtonElement).click());
    await page.waitForFunction(() => (window as any).captureTest.calls.some((call: any) => call.action === 'attach' && call.args.mode === 'popout'));
    await page.waitForFunction(() => (document.querySelector('.ag-browser') as HTMLElement).dataset.presentation === 'hidden');
    await page.evaluate(() => {
      const fixture = (window as any).captureTest;
      fixture.view.setVisible(true);
      fixture.emit({ type: 'presentation-command', tabId: 'tab', command: 'capture' });
    });
    await page.waitForFunction(() => (window as any).captureTest.calls.filter((call: any) => call.action === 'capture').length === 4);
    await page.evaluate(() => (window as any).captureTest.release());
    await page.waitForFunction(() => (window as any).captureTest.drafts.length === 4);
    assert.equal(await page.evaluate(() => (window as any).captureTest.calls.filter((call: any) => call.action === 'attach').at(-1).args.mode), 'popout', 'workbench refresh and capture preserve native popup ownership');
    await page.evaluate(() => (window as any).captureTest.view.dispose());
  } finally { await browser?.close(); await server.close(); }
});
