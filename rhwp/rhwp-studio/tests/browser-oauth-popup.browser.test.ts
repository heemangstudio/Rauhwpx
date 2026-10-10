import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

/** 실제 작업 칸 UI를 사용하고 허브 이벤트와 네이티브 배치만 대체한다. */
test('인증 팝업 완료는 원래 탭의 화면을 복원하고 사용자가 선택한 다른 탭은 유지한다', { timeout: 30_000 }, async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'oauth-ui-fixture', configureServer(vite) { vite.middlewares.use((request, response, next) => {
      if (request.url !== '/oauth-fixture') return next();
      response.setHeader('content-type', 'text/html');
      response.end('<html><body><div id="host" class="ag-root ag-fullscreen" style="width:900px;height:650px"></div></body></html>');
    }); } }],
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${address.port}/oauth-fixture`);
    await page.evaluate(async () => {
      let attached: string | null = null; const callbacks = new Set<(event: any) => void>();
      Object.assign(window, { rhwpDesktop: { browser: {
        async attach(args: { tabId: string }) { attached = args.tabId; },
        async detach(args: { tabId: string }) { if (attached === args.tabId) attached = null; },
        async getState() { return {}; },
      } } });
      const makeTab = (tabId: string, title: string) => ({ tabId, title, nativeTargetId: tabId, runtime: 'native', url: `https://${tabId}.example/`, threadId: 'chat', documentId: null, projectId: null, navigationEpoch: 1, controllerEpoch: 1, controller: { owner: 'human' }, status: 'ready' });
      const tabs = [makeTab('unrelated', 'Other page'), makeTab('opener', 'Sign-in page')]; const popup = makeTab('oauth-popup', 'Sign-in popup');
      const bridge = { getConnectionState: () => 'connected', onBrowserEvent(callback: (event: any) => void) { callbacks.add(callback); return () => callbacks.delete(callback); }, onEvent: () => () => {}, async requestBrowser(action: string) { return action === 'status' ? { tabs } : {}; } };
      const { createWorkbenchBrowser } = await import('../src/ui/agent-sidebar/workbench-browser.ts');
      const { createSidebarWorkbench } = await import('../src/ui/agent-sidebar/workbench.ts');
      let workbench: ReturnType<typeof createSidebarWorkbench> | undefined;
      const view = createWorkbenchBrowser({ bridge: bridge as any, getDestination: () => ({ threadId: 'chat', projectId: null, documentId: null, label: '채팅' }), onCapture() {}, onOpenDownload() {}, onDock() {}, onChat() {}, onChange() { workbench?.setResources(view.descriptors(), view.activeTab()); } });
      workbench = createSidebarWorkbench({ mount(_selected, host) { view.mount(host); view.setVisible(true); }, onSelect() {}, onChat() {}, selectResource(id) { if (id) view.selectTab(id); }, closeResource(id) { view.closeTab(id); } });
      document.querySelector<HTMLElement>('#host')!.append(workbench.element); workbench.select('browser', { recordTab: false });
      Object.assign(window, { oauthUi: { view, workbench, get attached() { return attached; }, open() { for (const callback of callbacks) callback({ type: 'owned_browser_popup', tab: popup, openerTabId: 'opener' }); }, close() { for (const callback of callbacks) callback({ type: 'owned_browser_closed', tabId: popup.tabId, openerTabId: 'opener' }); } } });
    });
    const attached = (tabId: string) => page.waitForFunction(tabId => (window as any).oauthUi.attached === tabId, { timeout: 2000 }, tabId);
    await attached('unrelated'); await page.click('.ag-workbench-tab[data-resource-id="browser:opener"]'); await attached('opener');
    await page.evaluate(() => (window as any).oauthUi.open()); await attached('oauth-popup');
    await page.evaluate(() => (window as any).oauthUi.close()); await attached('opener');
    assert.equal(await page.$eval('.ag-workbench-tab[aria-selected="true"]', node => (node as HTMLElement).dataset.resourceId), 'browser:opener');
    assert.equal(await page.$('.ag-workbench-tab[data-resource-id="browser:oauth-popup"]'), null);
    await page.evaluate(() => (window as any).oauthUi.open()); await attached('oauth-popup');
    await page.click('.ag-workbench-tab[data-resource-id="browser:unrelated"]'); await attached('unrelated');
    await page.evaluate(() => (window as any).oauthUi.close()); await attached('unrelated');
    assert.equal(await page.$eval('.ag-workbench-tab[aria-selected="true"]', node => (node as HTMLElement).dataset.resourceId), 'browser:unrelated');
    await page.evaluate(() => { (window as any).oauthUi.view.dispose(); (window as any).oauthUi.workbench.dispose(); });
  } finally { await browser?.close(); await server.close(); }
});
