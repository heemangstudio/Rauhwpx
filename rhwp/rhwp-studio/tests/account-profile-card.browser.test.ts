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
