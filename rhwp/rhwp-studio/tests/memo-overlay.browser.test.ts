import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

// 실제 Studio 에서 메모 풍선·앵커 강조·보기 토글·풍선 고치기·Ctrl+K,M 넣기를 사용자 조작으로
// 확인하고, 저장본을 다시 열어 바뀐 메모가 남는지 본다.

const studioRoot = fileURLToPath(new URL('../', import.meta.url));
const sample = resolve(studioRoot, '../samples/basic/NewYear_s_Day.hwp');
// RHWP_MEMO_SCREENSHOTS=<dir> 이면 화면을 남긴다.
const artifacts = process.env.RHWP_MEMO_SCREENSHOTS;

type MemoView = { count: number; highlights: number; texts: string[] };

test('메모 풍선 표시·보기 토글·고치기·Ctrl+K,M 넣기가 저장본까지 남는다', { timeout: 180_000 }, async () => {
  // 실제 vite 설정을 쓰되 허브는 다른 포트로 띄워 다른 작업 트리와 겹치지 않게 한다.
  process.env.RHWP_AGENT_PORT ??= '0';
  const server = await createServer({
    root: studioRoot,
    configFile: resolve(studioRoot, 'vite.config.ts'),
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({
      executablePath: browserExecutable(),
      headless: true,
      args: browserLaunchArgs(),
      defaultViewport: { width: 1600, height: 1000 },
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'load' });
    // 문서 홈이 그려진 뒤에야 파일 입력 change 처리가 붙는다.
    await page.waitForFunction(() => document.body.innerText.includes('최근 문서'), { timeout: 60_000 });
    const input = await page.$('#file-input');
    await (input as any).uploadFile(sample);
    await page.waitForFunction(
      () => document.querySelectorAll('.memo-balloon').length === 9
        && !(document.querySelector('#document-home') as HTMLElement | null)?.checkVisibility(),
      { timeout: 90_000 },
    );

    const view = (): Promise<MemoView> => page.evaluate(() => ({
      count: document.querySelectorAll('.memo-balloon').length,
      highlights: document.querySelectorAll('.memo-anchor-highlight').length,
      texts: [...document.querySelectorAll('.memo-balloon-body')].map((el) => el.textContent ?? ''),
    }));
    const shown = await view();
    assert.equal(shown.count, 9, '풍선 9개');
    assert.ok(shown.highlights >= 9, '앵커 강조가 메모마다 있다');
    assert.ok(shown.texts.every((text) => text.length > 0), '풍선마다 본문이 보인다');
    if (artifacts) {
      mkdirSync(artifacts, { recursive: true });
      await page.screenshot({ path: resolve(artifacts, 'newyear-memos.png') });
    }

    // 보기 › 메모 끄기/켜기
    const toggle = () => page.evaluate(() => {
      (document.querySelector('.md-item[data-cmd="view:memo"]') as HTMLElement).click();
    });
    await toggle();
    await page.waitForFunction(() => document.querySelectorAll('.memo-balloon').length === 0);
    assert.equal((await view()).highlights, 0, '메모를 끄면 강조도 사라진다');
    await toggle();
    await page.waitForFunction(() => document.querySelectorAll('.memo-balloon').length === 9);

    // 풍선 본문을 눌러 고치고 Ctrl+Enter 로 확정
    await page.evaluate(() => document.querySelector('.memo-balloon')!.scrollIntoView({ block: 'center' }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    await page.click('.memo-balloon .memo-balloon-body');
    await page.waitForSelector('.memo-balloon-editing .memo-balloon-body');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.type('브라우저에서 고친 메모');
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
    await page.waitForFunction(
      () => [...document.querySelectorAll('.memo-balloon-body')].some((el) => el.textContent === '브라우저에서 고친 메모'),
    );

    // 캐럿이 놓인 낱말에 Ctrl+K,M 으로 새 메모 (선택한 채 Ctrl+K 는 하이퍼링크 대화상자다)
    await page.evaluate(async () => {
      const { getMemoOverlay } = await import('/src/command/commands/memo.ts');
      const ih = (getMemoOverlay() as any).deps.getInputHandler();
      const list = (getMemoOverlay() as any).deps.wasm.getMemoNoteList();
      const used = new Set(list.map((m: any) => m.anchor?.paraIdx));
      const wasm = (getMemoOverlay() as any).deps.wasm;
      let para = -1;
      let offset = -1;
      for (let p = 0; p < wasm.getParagraphCount(0) && para < 0; p++) {
        if (!used.has(p) && wasm.getParagraphLength(0, p) >= 4) {
          try {
            const ctx = wasm.getHyperlinkContext({ section: 0, para: p, cellPath: [] });
            const i = [...ctx.text].findIndex((ch: string) => /\S/.test(ch));
            if (ctx.text.length >= 4 && i >= 0) { para = p; offset = i + 1; }
          } catch { /* 개체 문단 */ }
        }
      }
      if (para < 0) throw new Error('no paragraph');
      ih.moveCursorTo({ sectionIndex: 0, paragraphIndex: para, charOffset: offset });
      ih.focus();
    });
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyK');
    await page.keyboard.up('Control');
    await page.keyboard.press('KeyM');
    await page.waitForSelector('.memo-balloon-draft .memo-balloon-body', { timeout: 10_000 });
    await page.keyboard.type('새로 넣은 메모');
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
    await page.waitForFunction(() => document.querySelectorAll('.memo-balloon').length === 10);
    if (artifacts) await page.screenshot({ path: resolve(artifacts, 'newyear-edited.png') });

    // HWP·HWPX 로 저장해 다시 열기
    const reopened = await page.evaluate(async () => {
      const { getMemoOverlay } = await import('/src/command/commands/memo.ts');
      const { WasmBridge } = await import('/src/core/wasm-bridge.ts');
      const wasm = (getMemoOverlay() as any).deps.wasm;
      const texts = (bridge: any) => bridge.getMemoNoteList().map((m: any) => m.text).sort();
      const out: Record<string, string[]> = {};
      for (const [name, bytes] of [['a.hwp', wasm.exportHwp()], ['a.hwpx', wasm.exportHwpx()]] as const) {
        const bridge = new WasmBridge();
        (bridge as any).initialized = true;
        bridge.loadDocument(bytes, name);
        out[name] = texts(bridge);
      }
      return { before: texts(wasm), ...out };
    });
    assert.ok(reopened.before.includes('브라우저에서 고친 메모'));
    assert.ok(reopened.before.includes('새로 넣은 메모'));
    assert.deepEqual(reopened['a.hwp'], reopened.before, 'HWP 저장본');
    assert.deepEqual(reopened['a.hwpx'], reopened.before, 'HWPX 저장본');
  } finally {
    await browser?.close();
    await server.close();
  }
});
