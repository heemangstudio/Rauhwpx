import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

/** 브라우저 DOM과 타이머를 사용하며 페이지 캡처 응답만 대체한다. */
test('홈에서 캡처를 멈추고 복귀하며 탭 전환 후 이전 이미지를 해제한다', { timeout: 30_000 }, async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'frame-lifetime', configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/frame-lifetime') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<html><head><style>html.document-home-open #host{visibility:hidden}#host{width:800px;height:600px}.ag-browser{height:100%}.ag-browser-surface{height:400px}</style></head><body><div id="host"></div></body></html>');
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${address.port}/frame-lifetime`);
    await page.evaluate(async () => {
      const { createWorkbenchBrowser } = await import('/src/ui/agent-sidebar/workbench-browser.ts');
      const calls: string[] = []; const tabs = ['first', 'second'].map(tabId => ({ tabId, threadId: 'chat', url: 'https://example.com/' + tabId, title: tabId, navigationEpoch: 1, controllerEpoch: 1, controller: { owner: 'agent' }, status: 'ready', runtime: 'chromium' }));
      let hold = false;
      const bridge = { getConnectionState: () => 'connected', onBrowserEvent: () => () => {}, onEvent: () => () => {}, requestBrowser: async (action: string, args: any) => {
        calls.push(action);
        if (action === 'status') return { tabs };
        if (action === 'frame') { if (hold) return {}; return { frame: { frameId: String(calls.length), tabId: args.tabId, navigationEpoch: 1, controllerEpoch: 1, mimeType: 'image/jpeg', data: 'a'.repeat(400_000), width: 1280, height: 800 } }; }
        return {};
      } };
      const view = createWorkbenchBrowser({ bridge, onChat() {}, onDock() {}, onOpenDownload() {} } as any); view.mount(document.querySelector('#host')!); view.setVisible(true);
      (window as any).frameLifetime = { view, calls, hold() { hold = true; } };
    });
    const frameCount = () => page.evaluate(() => (window as any).frameLifetime.calls.filter((call: string) => call === 'frame').length);
    await page.waitForFunction(() => document.querySelector('.ag-browser-frame')?.getAttribute('src')?.startsWith('data:'));
    await page.evaluate(() => document.documentElement.classList.add('document-home-open'));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.ag-browser-frame')!).visibility === 'hidden');
    // 두 번의 정상 유휴 캡처 주기를 지나도 숨긴 페이지는 캡처하지 않는다.
    const hiddenCount = await frameCount(); await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1600)));
    assert.equal(await frameCount(), hiddenCount);
    await page.evaluate(() => document.documentElement.classList.remove('document-home-open'));
    await page.waitForFunction((count: number) => (window as any).frameLifetime.calls.filter((call: string) => call === 'frame').length > count, {}, hiddenCount);
    await page.evaluate(() => { (window as any).frameLifetime.hold(); (window as any).frameLifetime.view.controller.select('second'); });
    assert.equal(await page.$eval('.ag-browser-frame', node => node.hasAttribute('src')), false);
    assert.equal(await page.evaluate(() => (window as any).frameLifetime.view.controller.state.frames.size), 0);
    assert.equal(await page.evaluate(() => (window as any).frameLifetime.view.controller.state.tabs.length), 2);
    assert.equal(await page.evaluate(() => (window as any).frameLifetime.calls.some((call: string) => ['close', 'recover', 'reconnect'].includes(call))), false);
    await page.evaluate(() => (window as any).frameLifetime.view.dispose());
  } finally { await browser?.close(); await server.close(); }
});
