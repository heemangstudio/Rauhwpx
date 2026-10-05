import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';
import { createNewDocument, waitForPaint, waitForState } from '../e2e/helpers.mjs';

// Full running editor and WASM. Only the operating-system print boundary is intercepted.
test(
  'live editor preserves text and saved output through resize, undo, formatting and print',
  { timeout: 90000 },
  async (t) => {
    const cache = await mkdtemp(resolve(tmpdir(), 'rau-live-review-'));
    const server = await createServer({
      cacheDir: cache,
      configFile: resolve(import.meta.dirname, '../vite.config.ts'),
      server: { port: 0, open: false, hmr: false },
      logLevel: 'error',
    });
    let browser: any;
    t.after(async () => {
      await browser?.close();
      await server.close();
      await rm(cache, { recursive: true, force: true });
    });
    await server.listen();
    browser = await puppeteer.launch({
      executablePath: browserExecutable(),
      headless: true,
      args: browserLaunchArgs(),
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(
      `http://127.0.0.1:${(server.httpServer!.address() as any).port}/`,
    );
    await page.waitForFunction(
      () => Boolean((window as any).__wasm && (window as any).__eventBus),
      { timeout: 30000 },
    );
    await waitForState(page, 'owned hub connected', () =>
      (window as any).__agentBridge?.getConnectionState?.() === 'connected',
    );
    await page.click('#document-new-action');
    await page.waitForFunction(
      () =>
        !(
          document.querySelector('#document-empty-state') as HTMLElement
        ).checkVisibility() && Boolean((window as any).__inputHandler),
      { timeout: 30000 },
    );
    const ax = await page.accessibility.snapshot({ interestingOnly: false });
    function find(node: any, role: string, name: string): boolean {
      return (
        (node?.role === role && node?.name === name) ||
        node?.children?.some((child: any) => find(child, role, name)) ||
        false
      );
    }
    for (const [role, name] of [
      ['menubar', '주 메뉴'],
      ['main', '문서 편집 영역'],
      ['region', '문서 페이지'],
      ['textbox', '문서 편집 입력'],
    ])
      assert(find(ax, role, name), `${role}: ${name}`);
    for (const [id, name] of [
      ['style-name', '스타일'],
      ['font-lang', '언어'],
      ['font-name', '글꼴'],
      ['font-size', '크기'],
      ['linespacing-select', '줄 간격'],
    ])
      assert.equal(
        await page.$eval(`#${id}`, (el: HTMLElement) =>
          el.getAttribute('aria-label'),
        ),
        name,
      );
    const caret = await page.evaluate(() => {
      const w = window as any,
        r = w.__wasm.getCursorRect(0, 0, 0),
        v = w.__canvasView,
        z = v.viewportManager.getZoom(),
        content = document
          .querySelector('#scroll-content')!
          .getBoundingClientRect();
      return {
        x:
          content.left +
          v.virtualScroll.getPageLeftResolved(
            r.pageIndex,
            document.querySelector('#scroll-content')!.clientWidth,
          ) +
          r.x * z +
          2,
        y:
          content.top +
          v.virtualScroll.getPageOffset(r.pageIndex) +
          r.y * z +
          (r.height * z) / 2,
      };
    });
    await page.mouse.click(caret.x, caret.y);
    const marker = 'Live regression review marker';
    await page.keyboard.type(marker);
    const text = () =>
      page.evaluate(() =>
        (window as any).__wasm.getTextRange(
          0,
          0,
          0,
          (window as any).__wasm.getParagraphLength(0, 0),
        ),
      );
    await page.waitForFunction(
      (marker: string) =>
        (window as any).__wasm
          .getTextRange(
            0,
            0,
            0,
            (window as any).__wasm.getParagraphLength(0, 0),
          )
          .includes(marker),
      {},
      marker,
    );
    await page.keyboard.down('Control');
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
    await page.waitForFunction(
      (marker: string) =>
        !(window as any).__wasm
          .getTextRange(
            0,
            0,
            0,
            (window as any).__wasm.getParagraphLength(0, 0),
          )
          .includes(marker),
      {},
      marker,
    );
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press('z');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await page.waitForFunction(
      (marker: string) =>
        (window as any).__wasm
          .getTextRange(
            0,
            0,
            0,
            (window as any).__wasm.getParagraphLength(0, 0),
          )
          .includes(marker),
      {},
      marker,
    );
    // Reuse the same pooled canvas while closing and opening the real sidebar.
    await page.evaluate(() => {
      (window as any).reviewCanvas = document.querySelector(
        '#scroll-content canvas',
      );
    });
    for (const width of [1100, 1440]) {
      await page.setViewport({ width, height: 1000 });
      await page.waitForFunction(() => {
        const w = window as any,
          c = w.reviewCanvas;
        if (!c?.isConnected) return false;
        return (
          Math.abs(
            c.getBoundingClientRect().left -
              document.querySelector('#scroll-content')!.getBoundingClientRect()
                .left -
              w.__canvasView.virtualScroll.getPageLeftResolved(
                0,
                document.querySelector('#scroll-content')!.clientWidth,
              ),
          ) < 1
        );
      });
      assert((await text()).includes(marker));
    }
    if (await page.$('.ag-collapse-tab')) {
      for (let i = 0; i < 2; i++) {
        await page.click('.ag-collapse-tab');
        await page.waitForFunction(
          () => !document.body.classList.contains('ag-sidebar-animating'),
        );
        await waitForPaint(page);
        assert.equal(
          await page.evaluate(() => {
            const w = window as any,
              c = w.reviewCanvas;
            return (
              c.isConnected &&
              Math.abs(
                c.getBoundingClientRect().left -
                  document
                    .querySelector('#scroll-content')!
                    .getBoundingClientRect().left -
                  w.__canvasView.virtualScroll.getPageLeftResolved(
                    0,
                    document.querySelector('#scroll-content')!.clientWidth,
                  ),
              ) < 1
            );
          }),
          true,
        );
      }
    }
    // Exercise the actual toolbar command and document history.
    await page.$eval('#linespacing-select', (el: HTMLSelectElement) =>
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
    );
    await page.waitForSelector('#linespacing-select');
    const custom = await page.evaluateHandle(
      () =>
        document.querySelector('#linespacing-select')!.previousElementSibling,
    );
    await (custom as any).asElement().focus();
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.type('300');
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () =>
        (window as any).__wasm.getParaPropertiesAt(0, 0).lineSpacing === 300,
    );
    assert.equal(
      await page.$eval(
        '#linespacing-select',
        (el: HTMLSelectElement) => el.value,
      ),
      '300',
    );
    await page.focus('[aria-label="문서 편집 입력"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    for (const [value, expected] of [
      ['0.5', 100],
      ['12', 1200],
    ] as const) {
      await page.focus('#font-size');
      await page.$eval('#font-size', (el: HTMLInputElement) => el.select());
      await page.keyboard.type(value);
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        (expected: number) =>
          (window as any).__wasm.getCharPropertiesAt(0, 0, 0).fontSize ===
          expected,
        {},
        expected,
      );
    }
    const bytes = await page.evaluate(() =>
      Array.from((window as any).__wasm.exportHwpx()),
    );
    const reopened = await page.evaluate(async (bytes: number[]) => {
      const doc = (
        window as any
      ).__wasm.doc.constructor.fromTrustedLocalFileBytes(new Uint8Array(bytes));
      try {
        return doc.getTextRange(0, 0, 0, doc.getParagraphLength(0, 0), false);
      } finally {
        doc.free();
      }
    }, bytes);
    assert.equal(reopened.split(marker).length - 1, 1);
    const before = await page.evaluate(() => {
      const w = window as any;
      return {
        name: w.__wasm.fileName,
        dirty: w.__documentState.isDirty(),
        text: w.__wasm.getTextRange(0, 0, 0, w.__wasm.getParagraphLength(0, 0)),
        title: document.title,
      };
    });
    await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLIFrameElement.prototype,
        'contentWindow',
      )!;
      (window as any).reviewPrints = [];
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
        ...descriptor,
        get() {
          const win = descriptor.get!.call(this);
          if (win && (this as HTMLIFrameElement).id === 'rhwp-print-surface')
            win.print = () => {
              (window as any).reviewPrints.push({
                title: document.title,
                dialog: !!document
                  .querySelector('.dialog-pdf-print')
                  ?.checkVisibility(),
                svg: win.document.querySelectorAll('svg').length,
              });
              if ((window as any).reviewPrintFails)
                throw new Error('review print failure');
            };
          return win;
        },
      });
    });
    const print = async () => {
      await page.click('#menu-bar > .menu-item');
      await page.click('[data-cmd="file:print-to-pdf"]');
    };
    await print();
    await page.waitForSelector('.dialog-pdf-print', { visible: true });
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => !document.querySelector('.dialog-pdf-print'),
    );
    assert.deepEqual(
      await page.evaluate(() => (window as any).reviewPrints),
      [],
    );
    await print();
    await page.waitForSelector('.dialog-pdf-print', { visible: true });
    await page.click('.dialog-btn-primary');
    await page.waitForFunction(
      () =>
        (window as any).reviewPrints.length === 1 &&
        !document.querySelector('#rhwp-print-surface'),
      { timeout: 15000 },
    );
    const printed = await page.evaluate(() => (window as any).reviewPrints[0]);
    assert.equal(printed.dialog, false);
    assert(printed.svg > 0);
    assert.equal(printed.title, before.name.replace(/\.[^.]+$/, ''));
    assert.deepEqual(
      await page.evaluate(() => {
        const w = window as any;
        return {
          name: w.__wasm.fileName,
          dirty: w.__documentState.isDirty(),
          text: w.__wasm.getTextRange(
            0,
            0,
            0,
            w.__wasm.getParagraphLength(0, 0),
          ),
          title: document.title,
        };
      }),
      before,
    );
    await page.evaluate(() => {
      (window as any).reviewPrintFails = true;
    });
    await print();
    await page.waitForSelector('.dialog-pdf-print', { visible: true });
    await page.click('.dialog-btn-primary');
    await page.waitForFunction(
      () =>
        (window as any).reviewPrints.length === 2 &&
        !document.querySelector('#rhwp-print-surface'),
    );
    assert.deepEqual(
      await page.evaluate(() => {
        const w = window as any;
        return {
          name: w.__wasm.fileName,
          dirty: w.__documentState.isDirty(),
          text: w.__wasm.getTextRange(
            0,
            0,
            0,
            w.__wasm.getParagraphLength(0, 0),
          ),
          title: document.title,
        };
      }),
      before,
    );
    assert.match(
      await page.$eval('body', (el: HTMLElement) => el.textContent!),
      /review print failure/,
    );
    // The shared helper must wait for this document's initialization, not an old canvas.
    await createNewDocument(page);
    assert.equal((await text()).includes(marker), false);
    assert.deepEqual(errors, []);
  },
);
