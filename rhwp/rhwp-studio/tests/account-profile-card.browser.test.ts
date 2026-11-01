import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

test('home account opens an anchored card, dismisses, and stays inside a resized window', { timeout: 30_000 }, async () => {
  const server = await createServer({
    configFile: false, root: resolve(import.meta.dirname, '..'),
    resolve: { alias: { '@': resolve(import.meta.dirname, '../src') } },
    optimizeDeps: { noDiscovery: true, entries: [] },
    server: { host: '127.0.0.1', port: 0, open: false }, logLevel: 'error',
  });
  server.middlewares.use('/profile-test', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head></head><body></body></html>');
  });
  await server.listen();
  const browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 700 });
    const address = server.httpServer!.address() as { port: number };
    await page.goto(`http://127.0.0.1:${address.port}/profile-test`);
    await page.evaluate(async () => {
      const { mountAccountButton } = await import('/src/ui/account/account-button.ts');
      document.body.replaceChildren();
      const slot = document.createElement('div');
      slot.style.cssText = 'position:fixed;right:24px;top:40px';
      const outside = document.createElement('button');
      outside.id = 'outside';
      outside.textContent = 'Home';
      document.body.append(slot, outside);
      const store = {
        api: {}, status: () => null, avatar: () => null,
        subscribe: () => () => {}, dispose() {},
      };
      mountAccountButton(slot, {
        store: store as any, plan: null,
        openSettings: () => { document.body.dataset.settingsOpened = 'true'; },
      });
    });
    await page.click('.acct-button');
    await page.waitForSelector('.acct-profile-card.acct-page-open');
    const geometry = await page.evaluate(() => {
      const anchor = document.querySelector('.acct-button')!.getBoundingClientRect();
      const card = document.querySelector('.acct-profile-card')!.getBoundingClientRect();
      return { width: card.width, height: card.height, top: card.top, bottom: anchor.bottom };
    });
    assert.ok(geometry.width < 450 && geometry.height > geometry.width);
    assert.ok(geometry.top >= geometry.bottom);
    assert.equal(await page.$eval('.acct-button', e => e.getAttribute('aria-expanded')), 'true');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.acct-page-open'));
    assert.equal(await page.$eval('.acct-button', e => e.getAttribute('aria-expanded')), 'false');
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'acct-button');
    await page.click('.acct-button');
    await page.waitForSelector('.acct-profile-card.acct-page-open');
    await page.click('#outside');
    await page.waitForFunction(() => !document.querySelector('.acct-page-open'));
    await page.click('.acct-button');
    await page.waitForSelector('.acct-profile-card.acct-page-open');
    await page.setViewport({ width: 320, height: 480 });
    await page.waitForFunction(() => {
      const rect = document.querySelector('.acct-page-open')!.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    });
    assert.equal(await page.$eval('.acct-profile-card.acct-page-open .acct-scroll', e => e.scrollWidth > e.clientWidth), false);
    await page.click('.acct-page-open .acct-card-settings');
    await page.waitForFunction(() => !document.querySelector('.acct-page-open'));
    assert.equal(await page.evaluate(() => document.body.dataset.settingsOpened), 'true');
  } finally {
    await browser.close();
    await server.close();
  }
});

test('cancelling a yearly plan goes through Groble and comes back as a plan that ends', { timeout: 30_000 }, async () => {
  const server = await createServer({
    configFile: false, root: resolve(import.meta.dirname, '..'),
    resolve: { alias: { '@': resolve(import.meta.dirname, '../src') } },
    optimizeDeps: { noDiscovery: true, entries: [] },
    server: { host: '127.0.0.1', port: 0, open: false }, logLevel: 'error',
  });
  server.middlewares.use('/profile-test', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head></head><body></body></html>');
  });
  await server.listen();
  const browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 900 });
    const address = server.httpServer!.address() as { port: number };
    await page.goto(`http://127.0.0.1:${address.port}/profile-test`);
    await page.evaluate(async () => {
      const { createMockAccount } = await import('/src/sidebar-preview/mock-account.ts');
      const { createAccountStore } = await import('/src/ui/account/account-store.ts');
      const { mountAccountButton } = await import('/src/ui/account/account-button.ts');
      const mock = createMockAccount('annual', { report: () => {}, hold: false })!;
      const counts = { refresh: 0, manage: 0 };
      // Groble 에서 해지가 끝난 것처럼: 창에 돌아와 다시 받을 때 웹훅이 이미 왔다.
      const api = {
        ...mock.api,
        openManage: async () => { counts.manage += 1; },
        refresh: async () => {
          counts.refresh += 1;
          if (counts.manage > 0) mock.setScenario('cancelled');
          return { ok: true };
        },
      };
      (window as any).counts = counts;
      const store = createAccountStore(api as any);
      await api.getStatus();
      document.body.replaceChildren();
      const slot = document.createElement('div');
      slot.style.cssText = 'position:fixed;right:24px;top:40px';
      document.body.append(slot);
      mountAccountButton(slot, { store, plan: null });
    });
    const text = (selector: string) => page.$eval(selector, (e) => (e as HTMLElement).innerText);
    const hidden = (selector: string) => page.$eval(selector, (e) => (e as HTMLElement).offsetParent === null);
    const clickText = (label: string) => page.evaluate((wanted) => {
      const target = [...document.querySelectorAll<HTMLButtonElement>('.acct-page-open button')].find((b) => b.textContent === wanted && b.offsetParent);
      if (!target) throw new Error(`no button ${wanted}`);
      target.click();
    }, label);
    await page.waitForSelector('.acct-button');
    await page.waitForFunction(() => document.querySelector('.acct-button-label')?.textContent !== '로그인');
    await page.click('.acct-button');
    await page.waitForSelector('.acct-profile-card.acct-page-open');
    assert.match(await text('.acct-plan-term'), /에 갱신$/);
    assert.equal(await page.$('.acct-plan-name .acct-badge'), null);
    assert.equal(await hidden('.acct-manage'), true);

    await clickText('구독 관리');
    assert.equal(await hidden('.acct-manage'), false);
    await clickText('구독 해지');
    assert.match(await text('.acct-manage-text'), /^취소해도 .+까지는 사용 가능합니다$/);
    await clickText('돌아가기');
    assert.equal(await page.evaluate(() => (window as any).counts.manage), 0, 'going back opens nothing');
    await clickText('구독 해지');
    await clickText('Groble에서 해지');
    await page.waitForFunction(() => (window as any).counts.manage === 1);
    await page.waitForFunction(() => document.querySelector('.acct-manage-text')?.textContent?.includes('표시됩니다'));
    assert.match(await text('.acct-plan-term'), /에 갱신$/, 'still renewing until Groble reports the cancel');

    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => /까지$/.test(document.querySelector('.acct-plan-term')?.textContent ?? ''));
    assert.equal(await text('.acct-plan-name .acct-badge'), '해지됨');
    assert.equal(await hidden('.acct-manage'), true);

    // 해지한 뒤의 구독 관리는 바로 Groble 을 연다.
    await clickText('구독 관리');
    await page.waitForFunction(() => (window as any).counts.manage === 2);
    assert.equal(await hidden('.acct-manage'), true);
    const refreshes = await page.evaluate(() => (window as any).counts.refresh);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    assert.equal(await page.evaluate(() => (window as any).counts.refresh), refreshes, 'no more refreshes after the cancel arrived');
  } finally {
    await browser.close();
    await server.close();
  }
});
