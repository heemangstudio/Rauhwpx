import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

test('Windows compact menus dispatch commands and return keyboard focus on dismissal', { timeout: 30_000 }, async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'compact-menu-harness', configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/compact-menu') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html class="desktop-windows"><body><div id="menu-bar"><div class="menu-item" data-menu="file"><span class="menu-title">파일</span><div class="menu-dropdown"><div class="md-item" data-cmd="file:open">열기</div><div class="md-item" data-cmd="file:save">저장</div></div></div><button id="editor-command-search">검색</button></div><button id="outside" style="margin-top:200px">바깥</button></body></html>');
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage(); await page.setViewport({ width: 1000, height: 700 });
    await page.goto(`http://127.0.0.1:${address.port}/compact-menu`);
    await page.evaluate(async () => {
      await import('../src/styles/menu-bar.css');
      const { MenuBar } = await import('../src/ui/menu-bar.ts');
      const commands: string[] = [];
      Object.assign(window, { menuCommands: commands });
      new MenuBar(document.querySelector('#menu-bar')!, {} as any,
        { enabledChecker: () => (id: string) => id !== 'file:save', dispatch: (id: string) => commands.push(id) } as any,
        { get: () => undefined } as any);
    });
    const hidden = () => page.$eval('.desktop-document-menus', e => (e as HTMLElement).hidden);
    assert.equal(await hidden(), true);
    await page.click('.desktop-menu-toggle');
    assert.equal(await hidden(), false);
    await page.click('[data-cmd="file:save"]');
    assert.deepEqual(await page.evaluate(() => (window as any).menuCommands), []);
    await page.click('[data-cmd="file:open"]');
    assert.deepEqual(await page.evaluate(() => (window as any).menuCommands), ['file:open']);
    assert.equal(await hidden(), true);
    await page.focus('.desktop-menu-toggle'); await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    assert.equal(await hidden(), true);
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'desktop-menu-toggle');
    await page.click('.desktop-menu-toggle'); await page.click('#outside');
    assert.equal(await hidden(), true);
    await page.click('.desktop-menu-toggle'); await page.click('#editor-command-search');
    assert.equal(await hidden(), true);
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'desktop-menu-toggle');
    await page.evaluate(async () => {
      await import('../src/styles/base.css');
      await import('../src/styles/document-home.css');
      document.body.innerHTML = '<div class="document-home is-shown"><header class="dh-topbar"><span style="flex:1">홈</span><button class="dh-new-chat">새 채팅</button></header></div><div style="position:fixed;right:0;top:0;width:138px;height:38px;z-index:99999"></div>';
      document.querySelector('.dh-new-chat')!.addEventListener('click', () => { document.body.dataset.newChatOpened = 'true'; });
    });
    const button = await page.$('.dh-new-chat');
    assert.ok(button);
    const bounds = await button.boundingBox();
    assert.ok(bounds);
    // 단추 오른쪽 끝도 네이티브 창 단추 아래로 들어가지 않아야 한다.
    await page.mouse.click(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2);
    assert.equal(await page.evaluate(() => document.body.dataset.newChatOpened), 'true');
  } finally { await browser?.close(); await server.close(); }
});
