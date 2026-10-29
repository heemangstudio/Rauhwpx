import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

/** 실제 포인터로 홈 카드를 고르고 끈다. 데스크톱 끌기 준비·시작·끝은 기록하는 대역이다. */
test('home cards select with Cmd/Ctrl and Shift and drag out as files', { timeout: 60_000 }, async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'home-drag-harness', configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/home-drag-harness') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end(`<!doctype html><html><body>
          <ul id="grid" style="display:flex;gap:20px;list-style:none;padding:20px">
            ${['a', 'b', 'c', 'd'].map((id) => `<li><button class="dh-card" data-drag-key="recent:${id}" style="width:80px;height:100px">${id}</button></li>`).join('')}
            <li><button class="dh-card" id="plain" style="width:80px;height:100px">plain</button></li>
          </ul></body></html>`);
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 400 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${address.port}/home-drag-harness`);
    await page.evaluate(async () => {
      const { createHomeDragOut, dragIconDataUrl } = await import('../src/home/home-drag-out.ts');
      const log: unknown[] = [];
      const grid = document.getElementById('grid')!;
      for (const card of grid.querySelectorAll('button')) {
        card.addEventListener('click', (event) => log.push(['card-click', card.textContent, event.detail === 0 ? 'key' : 'mouse']));
      }
      let release: (() => void) | null = null;
      let tokens = 0;
      const dragOut = createHomeDragOut({
        grid,
        prepare: (keys) => {
          log.push(['prepare', [...keys]]);
          const token = `token-${tokens += 1}`;
          if (!(window as unknown as { holdPrepare?: boolean }).holdPrepare) {
            return Promise.resolve({ token, failed: keys.includes('recent:d') ? ['d.hwp'] : [] });
          }
          return new Promise((resolve) => { release = () => resolve({ token, failed: [] }); });
        },
        start: (token, icon) => {
          log.push(['start', token, icon.startsWith('data:image/png;base64,')]);
          // Windows 처럼 놓은 뒤에 끝을 알리는 데스크톱.
          return Promise.resolve((window as unknown as { finishOnStart?: boolean }).finishOnStart === true);
        },
        end: (token, dropped) => log.push(['end', token, dropped]),
        iconFor: (keys) => dragIconDataUrl({ image: null, format: 'hwpx', count: keys.length }),
        onFailed: (names) => log.push(['failed', [...names]]),
      });
      Object.assign(window, { log, dragOut, releasePrepare: () => release?.() });
    });

    const center = async (selector: string) => {
      const box = await (await page.$(selector))!.boundingBox();
      assert.ok(box);
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const takeLog = () => page.evaluate(() => {
      const target = (window as unknown as { log: unknown[] }).log;
      return target.splice(0, target.length);
    });
    const selected = () => page.evaluate(() => [...document.querySelectorAll('.is-selected')].map((node) => node.textContent));
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    const card = (id: string) => `[data-drag-key="recent:${id}"]`;

    // Cmd/Ctrl 누르기는 카드를 펼치지 않고 고르기만 하고, Shift 는 범위를 고른다.
    await page.keyboard.down(modifier);
    await page.click(card('a'));
    await page.keyboard.up(modifier);
    await page.keyboard.down('Shift');
    await page.click(card('c'));
    await page.keyboard.up('Shift');
    assert.deepEqual(await selected(), ['a', 'b', 'c']);
    assert.deepEqual(await takeLog(), [], 'selection clicks do not reach the card');

    // 고른 카드를 끌면 고른 묶음 전체를 화면 순서로 준비하고, 누른 채라면 끌기를 시작한다.
    let from = await center(card('b'));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, from.y + 10, { steps: 4 });
    await page.waitForFunction(() => (window as unknown as { log: unknown[][] }).log.some((entry) => entry[0] === 'start'));
    await page.mouse.up();
    await page.mouse.move(from.x + 40, from.y + 20);
    assert.deepEqual(await takeLog(), [
      ['prepare', ['recent:a', 'recent:b', 'recent:c']],
      ['start', 'token-1', true],
      ['end', 'token-1', true],
    ]);

    // 고른 묶음 밖의 카드는 그 카드만 끌고, 준비하지 못한 문서는 알린다.
    from = await center(card('d'));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, from.y, { steps: 4 });
    await page.waitForFunction(() => (window as unknown as { log: unknown[][] }).log.some((entry) => entry[0] === 'start'));
    // 홈에 다시 놓은 우리 끌기는 열지 않고 끝낸다.
    assert.equal(await page.evaluate(() => (window as unknown as { dragOut: { consumeDrop(): boolean } }).dragOut.consumeDrop()), true);
    await page.mouse.up();
    assert.deepEqual(await takeLog(), [
      ['prepare', ['recent:d']],
      ['failed', ['d.hwp']],
      ['start', 'token-2', true],
      ['end', 'token-2', true],
    ]);
    assert.equal(await page.evaluate(() => (window as unknown as { dragOut: { consumeDrop(): boolean } }).dragOut.consumeDrop()), false);

    // 준비가 끝나기 전에 놓으면 끌기는 없던 일이고 사본은 바로 지운다. 그 누름은 카드를 펼치지 않는다.
    await page.evaluate(() => { (window as unknown as { holdPrepare: boolean }).holdPrepare = true; });
    from = await center(card('a'));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, from.y, { steps: 4 });
    await page.waitForFunction(() => (window as unknown as { log: unknown[][] }).log.some((entry) => entry[0] === 'prepare'));
    await page.mouse.up();
    await page.evaluate(() => (window as unknown as { releasePrepare(): void }).releasePrepare());
    await page.waitForFunction(() => (window as unknown as { log: unknown[][] }).log.some((entry) => entry[0] === 'end'));
    assert.deepEqual(await takeLog(), [
      ['prepare', ['recent:a', 'recent:b', 'recent:c']],
      ['end', 'token-3', false],
    ]);

    // 몇 픽셀 안의 흔들림은 누르기다. 그냥 누르면 고름이 풀리고 카드는 하던 대로 받는다.
    from = await center(card('b'));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 2, from.y + 1);
    await page.mouse.up();
    assert.deepEqual(await takeLog(), [['card-click', 'b', 'mouse']]);
    assert.deepEqual(await selected(), []);

    // 데스크톱이 끝을 알리면(Windows) 창 밖에 놓아 포인터 이동이 없어도 끌기는 끝나고,
    // 그 뒤 들어오는 다른 앱의 파일은 우리 끌기로 버려지지 않는다. 끌기 뒤 키보드로 누른 카드는 열린다.
    await page.evaluate(() => {
      Object.assign(window, { holdPrepare: false, finishOnStart: true });
    });
    from = await center(card('c'));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, from.y, { steps: 4 });
    await page.waitForFunction(() => (window as unknown as { log: unknown[][] }).log.some((entry) => entry[0] === 'end'));
    assert.equal(await page.evaluate(() => (window as unknown as { dragOut: { outbound: boolean } }).dragOut.outbound), false);
    assert.equal(await page.evaluate(() => (window as unknown as { dragOut: { consumeDrop(): boolean } }).dragOut.consumeDrop()), false);
    // Windows 는 운영체제 끌기 뒤에 click 을 보내지 않는다. 그 사이의 키보드 누르기는 카드에 닿는다.
    await page.focus(card('c'));
    await page.keyboard.press('Enter');
    await page.mouse.up();
    assert.deepEqual(await takeLog(), [
      ['prepare', ['recent:c']],
      ['start', 'token-4', true],
      ['end', 'token-4', true],
      ['card-click', 'c', 'key'],
    ]);

    // 손가락으로 넘기는 몸짓은 문서를 내보내지 않는다.
    const touch = await page.target().createCDPSession();
    from = await center(card('a'));
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
    for (const dx of [5, 10, 20, 30]) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + dx, y: from.y }] });
    }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.deepEqual((await takeLog()).filter((entry) => (entry as unknown[])[0] === 'prepare'), []);

    // 끌 수 없는 카드는 고르지 않는다.
    await page.keyboard.down(modifier);
    await page.click('#plain');
    await page.keyboard.up(modifier);
    assert.deepEqual(await selected(), []);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
