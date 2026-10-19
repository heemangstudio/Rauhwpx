/**
 * 체험 자동 저장은 끝나기 5초 전에 시작하지만, 잠금과 체험 끝 카드는 실제로 끝나는 순간에만
 * 와야 한다. 예전에는 저장을 시작할 때 카드까지 띄워 5초를 남기고 읽기 전용이 됐다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

test('the trial card waits for the real end while the final save starts early', { timeout: 30_000 }, async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'license-trial-end-harness', configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/license-trial-end') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end(`<!doctype html><html class="desktop-mac desktop-native-menu"><head><style>body { margin: 0; }</style></head><body>
          <div id="menu-bar">
            <span id="editor-document-title">문서</span>
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
    await page.goto(`http://127.0.0.1:${address.port}/license-trial-end`);
    await page.evaluate(async () => {
      await import('../src/styles/menu-bar.css');
      const end = Date.now() + 3_000;
      (window as any).__licenseSaves = [] as number[];
      (window as any).rhwpDesktop = {
        license: {
          getStatus: async () => ({
            state: 'trial',
            canEdit: true,
            readOnly: false,
            deviceId: '00000000-0000-4000-8000-000000000000',
            trial: { startedAt: end - 72 * 60 * 60 * 1000, endsAt: end, active: true },
            license: null,
            offline: false,
            pricingUrl: 'https://example.test/pricing',
          }),
          onChange: () => () => {},
          openActivation: () => {},
          openPricing: () => {},
          beginExpirySave: async () => ({ ok: true, until: null }),
        },
      };
      const { installLicenseGate } = await import('../src/ui/license-gate.ts');
      await installLicenseGate(() => {}, {
        hasUnsavedWork: () => true,
        saveBeforeLock: async () => {
          (window as any).__licenseSaves.push(end - Date.now());
          return { failed: 0 };
        },
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const before = await page.evaluate(() => ({
      banner: Boolean(document.querySelector('.trial-ended-overlay')),
      saves: (window as any).__licenseSaves as number[],
      pill: document.querySelector('#menu-bar .license-pill')?.textContent ?? '',
    }));
    assert.equal(before.banner, false, 'trial card appeared while the trial still had time');
    assert.ok(before.saves.length >= 1, 'the final save did not start early');
    assert.ok(before.saves[0] > 0, 'the final save started after the trial ended');

    await page.waitForSelector('.trial-ended-overlay', { timeout: 5_000 });
    const after = await page.evaluate(() => ({
      pill: document.querySelector('#menu-bar .license-pill')?.textContent ?? '',
    }));
    assert.match(after.pill, /체험 끝/);
  } finally {
    await browser?.close();
    await server.close();
  }
});
