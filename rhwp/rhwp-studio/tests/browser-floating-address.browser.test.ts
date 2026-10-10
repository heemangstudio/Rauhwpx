import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

/** 실제 뷰·컨트롤러·DOM을 사용하고 허브와 네이티브 연결만 대체한다. */
test('떠 있는 주소창은 같은 탭을 탐색하고 입력 취소와 다른 탭을 보존한다', { timeout: 30_000 }, async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'floating-address-harness', configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/floating-address-harness') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<html><body style="margin:0;background:#eee"><div id="host" style="width:900px;height:600px"></div></body></html>');
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen(); const location = server.httpServer!.address(); assert.ok(location && typeof location !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage(); await page.setViewport({ width: 1100, height: 800 });
    await page.goto(`http://127.0.0.1:${location.port}/floating-address-harness`);
    await page.evaluate(async () => {
      const calls: Array<{ action: string; args: Record<string, unknown> }> = [];
      const makeTab = (tabId: string, url: string) => ({ tabId, nativeTargetId: `target-${tabId}`, runtime: 'native', url, title: tabId, navigationEpoch: 1, controllerEpoch: 2, controller: { owner: 'human' }, status: 'ready' });
      const tabs = [makeTab('selected', 'https://example.com/first'), makeTab('retained', 'https://example.org/other')];
      Object.assign(window, { rhwpDesktop: { browser: { async attach() {}, async detach() {}, async getState() { return {}; } } } });
      const { createWorkbenchBrowser } = await import('../src/ui/agent-sidebar/workbench-browser.ts');
      const bridge = { getConnectionState: () => 'connected', onBrowserEvent: () => () => {}, onEvent: () => () => {}, async requestBrowser(action: string, args: Record<string, unknown> = {}) {
        calls.push({ action, args });
        if (action === 'navigate' && args.url) { const tab = tabs.find(tab => tab.tabId === args.tabId)!; tab.url = String(args.url); tab.navigationEpoch++; return { tab: { ...tab } }; }
        return action === 'status' ? { tabs: tabs.map(tab => ({ ...tab })) } : {};
      } };
      const view = createWorkbenchBrowser({ bridge: bridge as any, getDestination: () => ({ threadId: 'fixture', projectId: null, documentId: null, label: 'Fixture' }), onCapture() {}, onOpenDownload() {}, onDock() {}, onChat() {} });
      view.mount(document.querySelector<HTMLElement>('#host')!); view.float();
      Object.assign(window, { addressTest: { view, calls, tabs } });
    });
    const input = '.ag-browser-floating-chrome .ag-browser-address';
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('.ag-browser-floating-chrome .ag-browser-address')?.value === 'https://example.com/first');
    await page.click(input); await page.$eval(input, node => { (node as HTMLInputElement).value = 'draft search'; });
    await page.evaluate(async () => { const fixture = (window as any).addressTest; fixture.tabs[0].url = 'https://example.com/redirected'; fixture.tabs[0].navigationEpoch++; await fixture.view.controller.refresh(); });
    assert.equal(await page.$eval(input, node => (node as HTMLInputElement).value), 'draft search', 'async navigation does not overwrite an address being edited');
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval(input, node => (node as HTMLInputElement).value), 'https://example.com/redirected');
    assert.equal(await page.$eval('.ag-browser-floating', node => (node as HTMLElement).hidden), false, 'Escape cancels editing without hiding the floating browser');
    const enter = async (value: string) => { await page.click(input); await page.$eval(input, (node, value) => { (node as HTMLInputElement).value = value; }, value); await page.keyboard.press('Enter'); };
    await enter('example.com/next');
    await page.waitForFunction(() => (window as any).addressTest.tabs[0].url === 'https://example.com/next');
    await enter('compact browser search');
    await page.waitForFunction(() => (window as any).addressTest.tabs[0].url === 'https://www.google.com/search?q=compact%20browser%20search');
    const state = await page.evaluate(() => { const fixture = (window as any).addressTest; return { calls: fixture.calls, tabs: fixture.view.controller.state.tabs }; });
    assert.equal(state.tabs.length, 2); assert.equal(state.tabs[1].url, 'https://example.org/other');
    assert.ok(state.calls.filter((call: any) => call.action === 'navigate').every((call: any) => call.args.tabId === 'selected'));
    assert.ok(!state.calls.some((call: any) => ['open', 'close'].includes(call.action)));
    for (const width of [320, 640]) {
      await page.$eval('.ag-browser-floating', (node, width) => { (node as HTMLElement).style.width = `${width}px`; }, width);
      const layout = await page.$eval(input, node => { const rect = node.getBoundingClientRect(); const chrome = node.closest('header')!.getBoundingClientRect(); const surface = document.querySelector('.ag-browser-surface')!.getBoundingClientRect(); return { width: rect.width, within: rect.left >= chrome.left && rect.right <= chrome.right, clear: surface.top >= rect.bottom }; });
      assert.ok(layout.width > 100 && layout.within && layout.clear, 'address stays usable and outside the native page at each floating width');
      if (process.env.RHWP_BROWSER_ADDRESS_SCREENSHOTS) await (await page.$('.ag-browser-floating'))!.screenshot({ path: `${process.env.RHWP_BROWSER_ADDRESS_SCREENSHOTS}/floating-address-${width}.png` });
    }
    await page.click('.ag-browser-floating-dock');
    assert.equal(await page.$eval('.ag-browser-toolbar .ag-browser-address', node => (node as HTMLInputElement).value), 'https://www.google.com/search?q=compact%20browser%20search');
    await page.evaluate(() => { const fixture = (window as any).addressTest; fixture.view.selectTab('browser:retained'); });
    assert.equal(await page.$eval('.ag-browser-toolbar .ag-browser-address', node => (node as HTMLInputElement).value), 'https://example.org/other');
    await page.evaluate(() => (window as any).addressTest.view.dispose());
  } finally { await browser?.close(); await server.close(); }
});
