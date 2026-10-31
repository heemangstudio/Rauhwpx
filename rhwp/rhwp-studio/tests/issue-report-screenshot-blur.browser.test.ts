import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

// 전체 화면 채팅 위의 프로젝트 보드: 편집 용지는 채팅 뒤에 깔려 있고, 파일 이름은 보드 카드에만 보인다.
const CARDS = Array.from({ length: 8 }, (_, index) => `<div class="card">research-notes-${index}.pdf<br>firmness sample ${index}</div>`).join('');
const HARNESS = `<html><head><meta charset="utf-8"><style>
body { margin: 0; font: 13px/1.4 sans-serif; color: #111; background: #fff; }
#scroll-container { position: absolute; left: 0; top: 0; width: 1000px; height: 700px; overflow: auto; }
#scroll-container canvas { display: block; margin: 20px auto; background: #fff; }
.chat { position: absolute; left: 0; top: 0; width: 620px; height: 700px; background: #fafafa; padding: 16px; box-sizing: border-box; }
.chat h1 { font-size: 20px; margin: 0 0 12px; }
.composer { position: absolute; left: 16px; right: 16px; bottom: 16px; height: 80px; border: 1px solid #999; padding: 8px; }
.board { position: absolute; left: 620px; top: 0; width: 380px; height: 700px; padding: 12px; box-sizing: border-box; background: #fff; }
.card { border: 1px solid #ccc; margin: 0 0 8px; padding: 6px 8px; }
</style></head><body>
<div id="scroll-container"><div id="scroll-content"><canvas width="600" height="800"></canvas></div></div>
<div class="chat"><h1>Literature assignment chat</h1>${'<p>Summarize the apple firmness measurements in the attached papers.</p>'.repeat(6)}
<div class="composer">Draft question about chapter three of the novel</div></div>
<div class="board">${CARDS}</div>
</body></html>`;

/** 실제 흐림 코드를 브라우저 화면 캡처에 돌리고, 글자가 있던 모든 칸이 알아볼 수 없게 됐는지 잰다. */
test('문제 보고 스크린숏 흐림은 편집 화면이 아니어도 창의 어떤 글자도 남기지 않는다', { timeout: 60_000 }, async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'issue-report-blur-harness', configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/issue-report-blur-harness') return next();
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(HARNESS);
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen(); const location = server.httpServer!.address(); assert.ok(location && typeof location !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage(); await page.setViewport({ width: 1000, height: 700 });
    await page.goto(`http://127.0.0.1:${location.port}/issue-report-blur-harness`);
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas')!;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#000';
      ctx.font = '14px sans-serif';
      for (let line = 0; line < 40; line++) ctx.fillText(`page text line ${line} of the document body`, 40, 40 + line * 18);
    });
    // 메인의 capturePage 대신 같은 창을 PNG 로 찍는다.
    const png = Buffer.from(await page.screenshot({ type: 'png' })).toString('base64');
    const result = await page.evaluate(async (base64: string) => {
      const { prepareScreenshot, reportBlurRects } = await import('/src/ui/issue-report/screenshot.ts');
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const prepared = await prepareScreenshot(bytes, reportBlurRects(), window.innerWidth);
      const pixels = async (blob: Blob) => {
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      };
      const sharp = await pixels(prepared.sharp);
      const blurred = await pixels(prepared.blurred);
      // 칸마다 이웃 픽셀 밝기 차의 합(글자의 가장자리). 글자가 남으면 흐린 뒤에도 크게 남는다.
      const tile = 40;
      const energy = (image: ImageData, x0: number, y0: number) => {
        let sum = 0;
        for (let y = y0; y < Math.min(y0 + tile, image.height); y++) {
          for (let x = x0 + 1; x < Math.min(x0 + tile, image.width); x++) {
            const at = (y * image.width + x) * 4;
            const left = at - 4;
            sum += Math.abs(image.data[at] - image.data[left]) + Math.abs(image.data[at + 1] - image.data[left + 1]) + Math.abs(image.data[at + 2] - image.data[left + 2]);
          }
        }
        return sum;
      };
      const kept: Array<{ x: number; y: number; ratio: number }> = [];
      let textTiles = 0;
      for (let y = 0; y < sharp.height; y += tile) {
        for (let x = 0; x < sharp.width; x += tile) {
          const before = energy(sharp, x, y);
          if (before < 20_000) continue;
          textTiles += 1;
          const ratio = energy(blurred, x, y) / before;
          if (ratio > 0.35) kept.push({ x, y, ratio: Number(ratio.toFixed(2)) });
        }
      }
      return { hasBlur: prepared.hasBlur, textTiles, kept, width: sharp.width };
    }, png);
    assert.equal(result.hasBlur, true);
    assert.ok(result.textTiles > 20, `fixture should have text across the window: ${result.textTiles}`);
    assert.deepEqual(result.kept, [], `tiles that still show text detail: ${JSON.stringify(result.kept)}`);
  } finally {
    await browser?.close();
    await server.close();
  }
});
