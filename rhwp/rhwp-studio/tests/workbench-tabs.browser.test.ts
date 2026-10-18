import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

/** 실제 작업 칸 DOM을 사용하며 브라우저 탭 수명만 로컬 자료로 대체한다. */
test('workbench tabs keep selection, close and pointer reordering separate', { timeout: 45_000 }, async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'workbench-tabs-harness', configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/tabs-harness') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html class="desktop-mac"><body><div id="mount" class="ag-root ag-fullscreen" style="width:640px;height:400px;--ag-text:#222;--ag-text-secondary:#666;--ag-active:#ddd;--ag-hover:#eee;--ag-bg:#fff;--ag-font:system-ui"></div></body></html>');
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 600 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${address.port}/tabs-harness`);
    await page.evaluate(async () => {
      const { createSidebarWorkbench } = await import('../src/ui/agent-sidebar/workbench.ts');
      const resources = [1, 2, 3].map(n => ({ id: `browser:g${n}`, title: 'Google', dirty: false, kind: 'browser' as const, view: 'browser' as const }));
      let activeId: string | null = 'browser:g3';
      const closed: string[] = [];
      const selected: string[] = [];
      const view = createSidebarWorkbench({
        mount(_view, host) { host.textContent = 'Page content'; },
        onSelect() {}, onChat() { view.select(null); },
        selectResource(id) { activeId = id; selected.push(id!); view.setResources(resources, activeId); },
        closeResource(id) {
          closed.push(id); resources.splice(resources.findIndex(resource => resource.id === id), 1);
          if (activeId === id) activeId = resources[0]?.id ?? null;
          view.setResources(resources, activeId);
        },
      });
      document.querySelector('#mount')!.append(view.element);
      view.select('browser', { recordTab: false }); view.setResources(resources, activeId);
      Object.assign(window, { tabsTest: { view, resources, closed, selected, refresh() { view.setResources(resources, activeId); } } });
    });
    const tab = (id: string) => `.ag-workbench-tab[data-resource-id="browser:${id}"]`;
    const row = (id: string) => `.ag-workbench-tab-row:has(${tab(id)})`;
    const order = () => page.$$eval('.ag-workbench-tab', tabs => tabs.map(tab => (tab as HTMLElement).dataset.resourceId ?? (tab as HTMLElement).dataset.view));
    const selected = () => page.$eval('.ag-workbench-tab[aria-selected=true]', tab => (tab as HTMLElement).dataset.resourceId);
    async function point(selector: string) {
      const bounds = await page.$eval(selector, element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; });
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    }
    async function startDrag(id: string, targetId: string, end: 'left' | 'right') {
      const from = await point(tab(id));
      const target = await page.$eval(row(targetId), element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right }; });
      await page.mouse.move(from.x, from.y); await page.mouse.down();
      await page.mouse.move(end === 'right' ? target.right - 1 : target.left + 1, from.y, { steps: 12 });
    }
    await startDrag('g1', 'g3', 'right');
    await page.mouse.up();
    assert.deepEqual(await order(), ['browser:g2', 'browser:g3', 'browser:g1'], 'first tab can move to the end');
    assert.equal(await selected(), 'browser:g1');
    await startDrag('g1', 'g2', 'left'); await page.mouse.up();
    assert.deepEqual(await order(), ['browser:g1', 'browser:g2', 'browser:g3'], 'last tab can move to the beginning');
    await page.click(tab('g3'));
    await startDrag('g1', 'g3', 'right');
    await page.evaluate(() => (window as any).tabsTest.refresh());
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.deepEqual(await order(), ['browser:g1', 'browser:g2', 'browser:g3'], 'Escape restores the order even after an inventory update');
    assert.equal(await selected(), 'browser:g3', 'releasing a cancelled drag does not select the dragged tab');
    await startDrag('g1', 'g3', 'right');
    await page.evaluate(() => document.querySelector('.ag-workbench-tabs')!.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })));
    await page.mouse.up();
    assert.deepEqual(await order(), ['browser:g1', 'browser:g2', 'browser:g3'], 'pointer cancellation restores the order');
    assert.equal(await selected(), 'browser:g3', 'pointer cancellation preserves the active page');
    await startDrag('g1', 'g3', 'right');
    await page.evaluate(() => document.querySelector('.ag-workbench-tabs')!.releasePointerCapture(1));
    const releasePoint = await point(tab('g3'));
    await page.mouse.move(releasePoint.x, releasePoint.y); await page.mouse.up();
    assert.deepEqual(await order(), ['browser:g1', 'browser:g2', 'browser:g3'], 'losing pointer capture cancels rather than committing the reorder');
    assert.equal(await selected(), 'browser:g3');
    await page.focus(tab('g1')); await page.keyboard.press('Enter');
    assert.equal(await selected(), 'browser:g1', 'ordinary keyboard activation still works after cancellation');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('ag-workbench-tab-close')), true, 'selected tab exposes its close button to keyboard focus');
    await page.keyboard.press('Enter');
    assert.deepEqual(await order(), ['browser:g2', 'browser:g3'], 'the first tab can be closed from the keyboard');
    assert.deepEqual(await page.evaluate(() => (window as any).tabsTest.closed), ['browser:g1']);
    await page.evaluate(() => { document.querySelector<HTMLElement>('#mount')!.style.width = '300px'; });
    await page.setViewport({ width: 390, height: 600 });
    await startDrag('g2', 'g3', 'right'); await page.mouse.up();
    assert.deepEqual(await order(), ['browser:g3', 'browser:g2'], 'narrow headers still allow dragging the first tab to the end');
    await startDrag('g2', 'g3', 'left'); await page.mouse.up();
    assert.deepEqual(await order(), ['browser:g2', 'browser:g3'], 'dragging back restores the first tab in a narrow header');
    await page.focus(tab('g2'));
    await page.keyboard.down('Alt'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Alt');
    assert.deepEqual(await order(), ['browser:g3', 'browser:g2'], 'keyboard reordering shares the pointer order');
    await page.keyboard.down('Alt'); await page.keyboard.press('ArrowLeft'); await page.keyboard.up('Alt');
    await page.hover(row('g2'));
    const close = await point(`${row('g2')} .ag-workbench-tab-close`);
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.classList.contains('ag-workbench-tab-close'), close);
    assert.equal(hit, true, 'the first close target stays distinct and clickable in a narrow header');
    await page.mouse.click(close.x, close.y);
    assert.deepEqual(await order(), ['browser:g3']);
    assert.deepEqual(await page.evaluate(() => (window as any).tabsTest.closed), ['browser:g1', 'browser:g2'], 'pointer close removes only the requested first tab');
    await page.evaluate(() => { const state = (window as any).tabsTest; state.view.select('board'); state.view.select('documents'); });
    await page.click('.ag-workbench-tab[data-view="board"]');
    assert.equal(await page.$eval('.ag-workbench-panel[data-view="board"]', panel => (panel as HTMLElement).hidden), false, 'other panels still select normally');
    assert.deepEqual(await page.evaluate(() => (window as any).tabsTest.closed), ['browser:g1', 'browser:g2'], 'selecting other panels does not close browser tabs');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
});

test('wide browser panes keep the chat header out of tab pointer targets', { timeout: 30_000 }, async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'workspace-tabs-harness', configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/workspace-tabs-harness') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html class="desktop-mac"><body><aside class="ag-root ag-fullscreen ag-rail-collapsed ag-workbench-open ag-review-collapsed" style="--ag-review-w:1060px;--ag-workspace-lead-inset:80px;--ag-text:#222;--ag-text-secondary:#666;--ag-bg:#fff;--ag-font:system-ui"><div class="ag-stage"><header class="ag-workspace-bar"><div class="ag-workspace-leading">Hama</div><div class="ag-workspace-title"></div><div class="ag-workspace-document-context"><span class="ag-workspace-chat-title">A long conversation title</span><span class="ag-workspace-document-name">document.hwpx</span></div><div class="ag-workspace-trailing"><span class="ag-workspace-agent-context">Codex</span></div></header></div></aside></body></html>');
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage(); await page.setViewport({ width: 1536, height: 900 });
    await page.goto(`http://127.0.0.1:${address.port}/workspace-tabs-harness`);
    await page.evaluate(async () => {
      await import('../src/ui/agent-sidebar/agent-sidebar.css');
      const { createSidebarWorkbench } = await import('../src/ui/agent-sidebar/workbench.ts');
      const resources = [1, 2, 3].map(n => ({ id: `browser:g${n}`, title: 'Google', dirty: false, kind: 'browser' as const, view: 'browser' as const }));
      let active = resources[2].id;
      const view = createSidebarWorkbench({ mount(_view, host) { host.textContent = 'Page'; }, onSelect() {}, onChat() {},
        selectResource(id) { active = id!; view.setResources(resources, active); },
        closeResource(id) { resources.splice(resources.findIndex(row => row.id === id), 1); active = resources[0]?.id ?? ''; view.setResources(resources, active); },
      });
      document.querySelector('.ag-stage')!.append(view.element); view.select('browser', { recordTab: false }); view.setResources(resources, active);
    });
    for (const railCollapsed of [true, false]) {
      await page.evaluate(collapsed => document.querySelector('.ag-root')!.classList.toggle('ag-rail-collapsed', collapsed), railCollapsed);
      for (const id of ['g1', 'g2']) {
        const selector = `.ag-workbench-tab[data-resource-id="browser:${id}"]`;
        assert.equal(await page.$eval(selector, node => { const r = node.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('[role="tab"]') === node; }), true, 'first two tabs receive pointer input next to a narrow chat header');
        await page.click(selector);
        assert.equal(await page.$eval(selector, node => node.getAttribute('aria-selected')), 'true');
      }
    }
    const row = '.ag-workbench-tab-row:has([data-resource-id="browser:g1"])';
    await page.hover(row); await page.click(`${row} .ag-workbench-tab-close`);
    assert.equal(await page.$('[data-resource-id="browser:g1"]'), null, 'the first close button is reachable too');
    // Windows 창 단추를 모사해 실제 탭·모서리 조작부가 가려지지 않는지 확인한다.
    await page.evaluate(async () => {
      await import('../src/styles/menu-bar.css');
      document.documentElement.className = 'desktop-windows';
      const corner = document.createElement('div');
      corner.className = 'ag-workspace-corner';
      corner.innerHTML = '<button class="ag-workspace-icon-btn">환경</button><button class="ag-workspace-icon-btn">축소</button><button class="ag-workspace-icon-btn">작업 칸</button>';
      document.querySelector('.ag-stage')!.append(corner);
      const caption = document.createElement('div');
      caption.id = 'native-caption';
      caption.style.cssText = 'position:fixed;right:0;top:0;width:138px;height:38px;z-index:99999';
      document.body.append(caption);
    });
    for (const width of [900, 1300, 1536]) {
      await page.setViewport({ width, height: 900 });
      for (const fullscreen of [false, true]) {
        await page.evaluate(({width, fullscreen}) => {
          document.documentElement.classList.toggle('desktop-fullscreen', fullscreen);
          document.querySelector<HTMLElement>('#native-caption')!.hidden = fullscreen;
          const root = document.querySelector<HTMLElement>('.ag-root')!;
          root.classList.toggle('ag-workspace-compact', width < 1000);
          root.style.setProperty('--ag-review-w', width < 1000 ? '560px' : '660px');
        }, {width, fullscreen});
        for (const selector of ['.ag-workspace-corner button', '.ag-workbench-tab']) {
          assert.equal(await page.$$eval(selector, nodes => nodes.every(node => {
            const r = node.getBoundingClientRect();
            const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return r.width > 0 && r.right <= innerWidth && (hit === node || node.contains(hit));
          })), true, 'window controls must not cover workspace controls or browser tabs at ' + width);
        }
      }
    }

  } finally { await browser?.close(); await server.close(); }
});
