import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import puppeteer, { type Page } from 'puppeteer-core';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

// 하마는 기본으로 꺼져 있고, 편집 설정의 '하마' 스위치를 끄고 적용하면 새로고침 없이 사라지며,
// 그 값이 저장되어 다시 열어도 꺼진 채이고, 다시 켜면 돌아온다.
test('하마 설정은 기본으로 꺼져 있고, 끄고 켜면 입력기의 하마가 바로 사라지고 돌아오며 저장된다', { timeout: 60_000 }, async () => {
  const server = await createServer({
    configFile: resolve(import.meta.dirname, '../vite.sidebar.config.ts'),
    server: { port: 0, open: false }, logLevel: 'error',
  });
  await server.listen();
  const browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
  try {
    const page = await browser.newPage();
    const address = server.httpServer!.address() as { port: number };
    const ready = () => page.waitForFunction(
      () => document.querySelector<HTMLElement>('#agent-sidebar')?.dataset.composerReady === 'true',
      { timeout: 20_000 },
    );
    await page.goto(`http://127.0.0.1:${address.port}/?reset=1&page=settings&destination=editing`);
    await ready();
    const toggle = 'input[role="switch"][aria-label="하마"]';
    await page.waitForSelector(toggle);

    const initial = await state(page, toggle);
    assert.deepEqual(initial, { checked: false, hama: false, stored: null }, '처음에는 꺼져 있고 하마가 없다');

    await page.click(toggle);
    await clickApply(page);
    await page.waitForSelector('.ag-composer .ag-hama-perch .ag-hama canvas');
    assert.deepEqual(await state(page, toggle), { checked: true, hama: true, stored: true });

    await page.click(toggle);
    await clickApply(page);
    await page.waitForFunction(() => !document.querySelector('.ag-composer .ag-hama'));
    const off = await state(page, toggle);
    assert.deepEqual(off, { checked: false, hama: false, stored: false }, '끄고 적용하면 새로고침 없이 사라지고 저장된다');

    await page.reload();
    await ready();
    await page.waitForSelector(toggle);
    assert.deepEqual(await state(page, toggle), { checked: false, hama: false, stored: false }, '다시 열어도 꺼져 있다');

    await page.click(toggle);
    await clickApply(page);
    await page.waitForSelector('.ag-composer .ag-hama-perch .ag-hama canvas');
    assert.deepEqual(await state(page, toggle), { checked: true, hama: true, stored: true }, '다시 켜면 돌아온다');
  } finally {
    await browser.close();
    await server.close();
  }
});

async function state(page: Page, toggle: string) {
  return page.evaluate((selector: string) => {
    const raw = localStorage.getItem('rhwp-settings');
    const stored = raw ? JSON.parse(raw).view?.showHama ?? null : null;
    return {
      checked: document.querySelector<HTMLInputElement>(selector)!.checked,
      hama: document.querySelectorAll('.ag-composer .ag-hama').length === 1,
      stored,
    };
  }, toggle);
}

async function clickApply(page: Page): Promise<void> {
  await page.evaluate(() => {
    const apply = Array.from(document.querySelectorAll<HTMLButtonElement>('.ag-settings-apply-footer button'))
      .find((button) => button.textContent === '적용');
    if (!apply || apply.disabled) throw new Error('적용 버튼을 누를 수 없다');
    apply.click();
  });
}
