import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

// 실제 설정·계정·요금제 UI를 쓰되 결제와 계정 응답만 미리보기 대역으로 검증한다.
test('setup gates provider connection by account and plan, and resumes after checkout', { timeout: 90_000 }, async () => {
  const server = await createServer({
    configFile: resolve(import.meta.dirname, '../vite.sidebar.config.ts'),
    server: { port: 0, open: false }, logLevel: 'error',
  });
  await server.listen();
  const browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
  try {
    const artifacts = resolve(import.meta.dirname, '../sidebar-preview/artifacts');
    await mkdir(artifacts, { recursive: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 800 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const address = server.httpServer!.address() as { port: number };
    const step = (name: string) => page.waitForSelector(`.rhwp-setup-dialog[data-step="${name}"]`, { visible: true });
    const start = async (account: string) => {
      await page.goto(`http://127.0.0.1:${address.port}/?reset=1&initial-setup=1&account=${account}`);
      await step('theme');
      await page.click('.rhwp-setup-dot[aria-label="시작 방법"]');
      await step('welcome');
    };
    const finished = async () => {
      await page.waitForSelector('.rhwp-setup-overlay', { hidden: true });
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('rhwp-initial-setup')!).completed), true);
    };

    await start('signed-out');
    await page.screenshot({ path: resolve(artifacts, 'setup-paths.png') });
    assert.equal(await page.$('.rhwp-setup-dot[aria-label="AI 연결"]'), null);
    await page.click('[data-path="free"]');
    await finished();

    await start('signed-out');
    await page.click('[data-path="ai"]');
    await step('account');
    assert.equal(await page.$('.rhwp-setup-dot[aria-label="요금제"]'), null);
    assert.equal(await page.$('.rhwp-setup-dot[aria-label="AI 연결"]'), null);
    await page.click('.rhwp-setup-primary');
    await finished();

    await start('free');
    await page.click('[data-path="ai"]');
    await step('plans');
    assert.equal(await page.$('.rhwp-setup-dot[aria-label="AI 연결"]'), null);
    await page.click('.rhwp-setup-plans .rhwp-setup-upgrade-action');
    await page.waitForSelector('.ag-pricing-card', { visible: true });
    await page.click('.ag-pricing-close');
    await finished();

    await start('basic');
    await page.click('[data-path="ai"]');
    await step('models');
    await page.click('.rhwp-setup-primary');
    await finished();

    await start('hama');
    await page.click('[data-path="ai"]');
    await step('models');
    await page.click('.rhwp-setup-primary');
    await step('hama');
    await page.screenshot({ path: resolve(artifacts, 'setup-hama-introduction.png') });
    await page.click('.rhwp-setup-primary');
    await finished();

    await start('free');
    await page.click('[data-path="ai"]');
    await step('plans');
    await page.click('.rhwp-setup-plans .rhwp-setup-upgrade-action');
    await page.waitForSelector('.ag-pricing-card', { visible: true });
    // 이 페이지의 결제는 네트워크 요청 없는 mock-plan 이다.
    await page.click('.ag-pricing-col[data-plan="hama"] .ag-pricing-btn-primary');
    await step('models');
    await page.click('.rhwp-setup-primary');
    await step('hama');
    await page.click('.rhwp-setup-primary');
    await finished();
  } finally {
    await browser.close();
    await server.close();
  }
});
