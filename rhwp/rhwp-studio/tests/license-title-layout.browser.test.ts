/**
 * 체험 알약이 오른쪽에 붙어도 가운데 파일 이름과 겹치지 않아야 한다.
 * macOS 통합 제목 막대는 이름을 창 가운데에 절대 배치하므로, 알약 폭만큼 자리를 비우지
 * 않으면 좁은 창에서 이름이 알약 위로 올라간다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

test('the trial pill leaves room for the centered document title', { timeout: 30_000 }, async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'license-title-harness', configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/license-title') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end(`<!doctype html><html class="desktop-mac desktop-native-menu"><head><style>
          body { margin: 0; }
          #editor-command-search { width: 150px; }
        </style></head><body>
          <div id="menu-bar">
            <span id="editor-document-title">아주 긴 문서 이름이 들어가는 제목입니다</span>
            <button type="button" id="editor-command-search" class="editor-command-search">명령 검색</button>
          </div>
        </body></html>`);
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 600 });
    await page.goto(`http://127.0.0.1:${address.port}/license-title`);
    await page.evaluate(async () => {
      await import('../src/styles/menu-bar.css');
      const now = Date.now();
      (window as any).rhwpDesktop = {
        license: {
          getStatus: async () => ({
            state: 'trial',
            canEdit: true,
            readOnly: false,
            deviceId: '00000000-0000-4000-8000-000000000000',
            trial: { startedAt: now - 60_000, endsAt: now + 60 * 60 * 1000, active: true },
            license: null,
            offline: false,
            pricingUrl: 'https://example.test/pricing',
          }),
          onChange: () => () => {},
          openActivation: () => {},
          openPricing: () => {},
          beginExpirySave: async () => {},
        },
      };
      const { installLicenseGate } = await import('../src/ui/license-gate.ts');
      await installLicenseGate(() => {});
    });
    await page.waitForSelector('#menu-bar .license-pill');
    // ResizeObserver 는 다음 프레임에 돈다. 알약 폭이 자리를 잡은 뒤에 잰다.
    await page.evaluate(() => new Promise<void>((done) => {
      requestAnimationFrame(() => requestAnimationFrame(() => done()));
    }));
    const boxes = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const title = box('#editor-document-title');
      const pill = box('#menu-bar .license-pill');
      const search = box('#editor-command-search');
      return {
        titleRight: title.right,
        titleWidth: title.width,
        pillLeft: pill.left,
        pillRight: pill.right,
        searchLeft: search.left,
      };
    });
    assert.ok(boxes.titleWidth > 40, `title collapsed to ${boxes.titleWidth}px`);
    assert.ok(
      boxes.titleRight <= boxes.pillLeft,
      `title ends at ${boxes.titleRight}px, pill starts at ${boxes.pillLeft}px`,
    );
    assert.ok(boxes.pillRight <= boxes.searchLeft + 1);
  } finally {
    await browser?.close();
    await server.close();
  }
});
