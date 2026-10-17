import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

/** 실제 포인터 입력과 창 크기 변경으로 떠 있는 브라우저가 앱 창 밖으로 나가지 않고 사용자 크기를 잃지 않는지 본다. */
test('떠 있는 브라우저는 던지기·크기 조절·창 축소 뒤에도 앱 창 안에 머물고 저장된 크기를 되찾는다', { timeout: 30_000 }, async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'float-frame-harness', configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/float-frame-harness') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<html><body style="margin:0"><div id="host"></div></body></html>');
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage(); await page.setViewport({ width: 1200, height: 800 });
    await page.goto(`http://127.0.0.1:${address.port}/float-frame-harness`);
    await page.evaluate(async () => {
      localStorage.removeItem('rhwp.browser.float');
      await import('../src/ui/agent-sidebar/workbench-browser.css');
      const { createBrowserPresentation } = await import('../src/ui/agent-sidebar/browser-presentation.ts');
      const panel = document.createElement('section'); panel.className = 'ag-browser';
      const presentation = createBrowserPresentation(panel, () => {}); presentation.mount(document.querySelector<HTMLElement>('#host')!); presentation.present('float');
    });
    const frame = () => page.$eval('.ag-browser-floating', node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, vw: innerWidth, vh: innerHeight }; });
    const settled = () => page.waitForFunction(() => !document.querySelector<HTMLElement>('.ag-browser-floating')!.dataset.gesture);
    const inside = (rect: Awaited<ReturnType<typeof frame>>, gap: number, message: string) => assert.ok(rect.left >= gap && rect.top >= gap && rect.right <= rect.vw - gap && rect.bottom <= rect.vh - gap, `${message}: ${JSON.stringify(rect)}`);

    const start = await frame();
    await page.mouse.move(start.left + 200, start.top + 16); await page.mouse.down();
    await page.mouse.move(start.left + 900, start.top + 500, { steps: 8 });
    inside(await frame(), 0, 'dragging past the window edge never leaves the app window');
    await page.mouse.move(start.left + 1400, start.top + 700, { steps: 3 }); await page.mouse.up();
    await settled();
    inside(await frame(), 12, 'a throw settles inside the 12px edge gap');

    const thrown = await frame();
    await page.mouse.move(thrown.left, thrown.top); await page.mouse.down();
    await page.mouse.move(1, 1, { steps: 6 }); await page.mouse.up();
    const grown = await frame();
    inside(grown, 12, 'corner resize stops at the window gap');
    assert.ok(grown.right === thrown.right && grown.bottom === thrown.bottom, 'the opposite corner stays anchored');

    await page.setViewport({ width: 700, height: 500 });
    await page.waitForFunction(() => document.querySelector('.ag-browser-floating')!.getBoundingClientRect().right <= innerWidth - 12);
    inside(await frame(), 12, 'a smaller window refits the frame');
    await page.setViewport({ width: 1200, height: 800 });
    await page.waitForFunction(width => document.querySelector('.ag-browser-floating')!.getBoundingClientRect().width === width, { timeout: 3_000 }, grown.width).catch(() => undefined);
    const restored = await frame();
    assert.deepEqual({ width: restored.width, height: restored.height }, { width: grown.width, height: grown.height }, 'a temporary shrink keeps the stored size');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('rhwp.browser.float')!)), { left: grown.left, top: grown.top, width: grown.width, height: grown.height });

    // macOS 숨은 제목 막대 아래로만 던져진다. 신호등과 창 드래그 영역이 머리줄을 가리지 않는다.
    await page.evaluate(() => { document.documentElement.style.setProperty('--desktop-titlebar-height', '38px'); dispatchEvent(new Event('resize')); });
    await page.waitForFunction(() => document.querySelector('.ag-browser-floating')!.getBoundingClientRect().top >= 50);
    const titled = await frame();
    await page.mouse.move(titled.left + 200, titled.top + 16); await page.mouse.down();
    await page.mouse.move(titled.left + 200, 0, { steps: 4 }); await page.mouse.move(titled.left + 200, -200, { steps: 2 }); await page.mouse.up();
    await settled();
    assert.equal((await frame()).top, 50, 'a throw toward the title bar stops 12px below it');
  } finally { await browser?.close(); await server.close(); }
});
