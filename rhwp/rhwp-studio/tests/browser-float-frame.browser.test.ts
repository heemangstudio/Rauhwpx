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

    // 입력 잠금 중에도 모든 테두리로 크기를 바꾸고 반대편은 고정한다.
    for (const locked of [false, true]) for (const edge of ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']) {
      await page.evaluate(async ({ locked }) => {
        (window as any).resizePresentation?.dispose();
        document.querySelector('.ag-browser-floating')?.remove();
        localStorage.removeItem('rhwp.browser.float');
        const { createBrowserPresentation } = await import('../src/ui/agent-sidebar/browser-presentation.ts');
        const panel = document.createElement('section'); panel.className = 'ag-browser';
        const view = createBrowserPresentation(panel, () => {}); view.mount(document.querySelector<HTMLElement>('#host')!); view.present('float'); view.position(300, 220); view.setPreviewLock(locked);
        (window as any).resizePresentation = view;
      }, { locked });
      const before = await frame();
      const handle = await page.$eval(`.ag-browser-float-edge[data-edge=${edge}]`, el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      const dx = edge.includes('w') ? -35 : edge.includes('e') ? 35 : 0;
      const dy = edge.includes('n') ? -25 : edge.includes('s') ? 25 : 0;
      await page.mouse.move(handle.x, handle.y); await page.mouse.down(); await page.mouse.move(handle.x + dx, handle.y + dy, { steps: 5 }); await page.mouse.up();
      const after = await frame();
      assert.equal(after.width, before.width + Math.abs(dx), `${edge} resizes horizontally, locked=${locked}`);
      assert.equal(after.height, before.height + Math.abs(dy), `${edge} resizes vertically, locked=${locked}`);
      assert.equal(edge.includes('w') ? after.right : after.left, edge.includes('w') ? before.right : before.left, 'opposite horizontal edge stays anchored');
      assert.equal(edge.includes('n') ? after.bottom : after.top, edge.includes('n') ? before.bottom : before.top, 'opposite vertical edge stays anchored');
    }
    const beforeLoss = await frame();
    await page.evaluate(() => (window as any).resizePresentation.setPreviewLock(false));
    await page.mouse.move(beforeLoss.right, beforeLoss.top + 100); await page.mouse.down(); await page.mouse.move(beforeLoss.right - 60, beforeLoss.top + 100, { steps: 4 });
    await page.evaluate(() => { const edge = document.querySelector<HTMLElement>('.ag-browser-float-edge[data-edge=e]')!; for (let id = 1; id < 10; id++) if (edge.hasPointerCapture(id)) edge.releasePointerCapture(id); });
    await page.mouse.up();
    assert.equal((await frame()).width, beforeLoss.width - 60, 'losing pointer capture keeps the last resized frame');
    await page.evaluate(() => dispatchEvent(new Event('resize')));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal((await frame()).width, beforeLoss.width - 60, 'the interrupted size remains saved');
    const beforeBlur = await frame();
    await page.mouse.move(beforeBlur.right, beforeBlur.top + 100); await page.mouse.down(); await page.mouse.move(beforeBlur.right + 40, beforeBlur.top + 100);
    await page.evaluate(() => dispatchEvent(new Event('blur'))); await page.mouse.up();
    assert.equal((await frame()).width, beforeBlur.width + 40, 'window focus loss preserves the current size and ends the gesture');
    const beforeEscape = await frame();
    await page.mouse.move(beforeEscape.right, beforeEscape.top + 100); await page.mouse.down(); await page.mouse.move(beforeEscape.right + 30, beforeEscape.top + 100);
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.equal((await frame()).width, beforeEscape.width, 'Escape explicitly cancels resizing');

  } finally { await browser?.close(); await server.close(); }
});
