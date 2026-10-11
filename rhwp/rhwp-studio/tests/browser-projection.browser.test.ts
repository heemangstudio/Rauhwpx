import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

/** 실제 브라우저 UI와 레이아웃을 사용하고 Electron 연결만 대체한다. */
test('숨긴 부모의 네이티브 페이지를 분리하고 같은 탭을 복원하며 늦은 연결을 취소한다', { timeout: 30_000 }, async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'projection-harness', configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/projection-harness') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<html><head><style>html.document-home-open #host { visibility:hidden } #host { width:800px;height:600px } .ag-browser { height:100% }</style></head><body><div id="host"></div></body></html>');
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/projection-harness`);
    await page.evaluate(async () => {
      const calls: Array<{ action: string; tabId?: string }> = [];
      let attached: string | null = null;
      let hold = false; let release: (() => void) | undefined;
      Object.assign(window, { rhwpDesktop: { browser: {
        async attach(args: { tabId: string }) { calls.push({ action: 'attach', ...args }); if (hold) await new Promise<void>(resolve => { release = resolve; }); attached = args.tabId; },
        async detach(args: { tabId: string }) { calls.push({ action: 'detach', tabId: args.tabId }); attached = null; },
        async getState() { return {}; },
      } } });
      const { createWorkbenchBrowser } = await import('../src/ui/agent-sidebar/workbench-browser.ts');
      const tab = { tabId: 'same-tab', scope: 'global', nativeTargetId: 'same-target', runtime: 'native', url: 'https://example.com/retained', title: '자료', navigationEpoch: 3, controllerEpoch: 2, controller: { owner: 'human' }, status: 'ready' };
      const bridge = { getConnectionState: () => 'connected', onBrowserEvent: () => () => {}, onEvent: () => () => {}, async requestBrowser(action: string) { calls.push({ action }); return action === 'status' ? { tabs: [tab] } : {}; } };
      const createView = () => createWorkbenchBrowser({ bridge: bridge as any, getDestination: () => ({ threadId: 'chat', projectId: null, documentId: null, label: '채팅' }), onCapture() {}, onOpenDownload() {}, onDock() {}, onChat() {} });
      const view = createView();
      view.mount(document.querySelector<HTMLElement>('#host')!); view.setVisible(true);
      Object.assign(window, { projectionTest: { view, calls, createView, get attached() { return attached; }, hold() { hold = true; }, release() { hold = false; release?.(); } } });
    });
    const attached = (value: string | null) => page.waitForFunction(value => (window as any).projectionTest.attached === value, { timeout: 2000 }, value);
    await attached('same-tab');
    const bounds = await page.$eval('.ag-browser-surface', node => node.getBoundingClientRect().width);
    await page.evaluate(() => document.documentElement.classList.add('document-home-open'));
    assert.equal(await page.$eval('.ag-browser-surface', node => node.getBoundingClientRect().width), bounds, 'Home preserves the browser layout');
    await attached(null);
    await page.evaluate(() => document.documentElement.classList.remove('document-home-open'));
    await attached('same-tab');
    await page.evaluate(() => { document.querySelector<HTMLElement>('#host')!.style.display = 'none'; });
    await attached(null);
    await page.evaluate(() => { (window as any).projectionTest.hold(); document.querySelector<HTMLElement>('#host')!.style.display = ''; });
    await page.waitForFunction(() => (window as any).projectionTest.calls.filter((call: any) => call.action === 'attach').length === 3);
    await page.evaluate(() => document.documentElement.classList.add('document-home-open'));
    await page.evaluate(() => (window as any).projectionTest.release());
    await attached(null);
    await page.evaluate(() => document.documentElement.classList.remove('document-home-open'));
    await attached('same-tab');
    await page.evaluate(() => (window as any).projectionTest.view.setVisible(false));
    await attached(null);
    await page.evaluate(() => { (window as any).projectionTest.hold(); (window as any).projectionTest.view.setVisible(true); });
    await page.waitForFunction(() => (window as any).projectionTest.calls.filter((call: any) => call.action === 'attach').length === 5);
    await page.evaluate(() => document.documentElement.classList.add('document-home-open'));
    await page.evaluate(() => document.documentElement.classList.remove('document-home-open'));
    await page.evaluate(() => (window as any).projectionTest.release());
    await attached('same-tab');
    await page.waitForFunction(() => (window as any).projectionTest.calls.filter((call: any) => call.action === 'attach').length === 6);
    await page.evaluate(() => (window as any).projectionTest.view.float());
    await page.waitForFunction(() => (window as any).projectionTest.calls.filter((call: any) => call.action === 'attach').length === 7);
    const floating = await page.$eval('.ag-browser-floating', node => node.getBoundingClientRect().toJSON());
    await page.evaluate(() => document.documentElement.classList.add('document-home-open'));
    await attached(null);
    assert.equal(await page.$eval('.ag-browser-floating', node => getComputedStyle(node).visibility), 'hidden', 'Home hides the entire floating browser shell');
    assert.equal(await page.$eval('.ag-browser-move', node => { (node as HTMLElement).focus(); return document.activeElement === node; }), false, 'Home removes floating controls from keyboard focus');
    await page.evaluate(() => document.documentElement.classList.remove('document-home-open'));
    await attached('same-tab');
    assert.equal(await page.$eval('.ag-browser', node => (node as HTMLElement).dataset.presentation), 'float');
    assert.deepEqual(await page.$eval('.ag-browser-floating', node => node.getBoundingClientRect().toJSON()), floating, 'returning from Home preserves floating coordinates');
    assert.equal(await page.$eval('.ag-browser-floating', node => getComputedStyle(node).visibility), 'visible');
    const calls = await page.evaluate(() => (window as any).projectionTest.calls);
    assert.equal(calls.filter((call: any) => call.action === 'attach').length, 8, 'each restore attaches once and a cancelled attach is replaced');
    assert.ok(calls.filter((call: any) => call.action === 'attach' || call.action === 'detach').every((call: any) => call.tabId === 'same-tab'));
    assert.ok(!calls.some((call: any) => ['open', 'close', 'reconnect'].includes(call.action)), 'visibility preserves the runtime page');
    await page.evaluate(() => (window as any).projectionTest.view.dock());
    assert.equal(await page.$eval('.ag-browser', node => (node as HTMLElement).dataset.presentation), 'dock', 'fullscreen link focus can return a floating page to the workbench');
    assert.equal(await page.$eval('.ag-browser-floating', node => (node as HTMLElement).hidden), true);
    assert.equal(await page.$eval('.ag-browser-address', node => document.activeElement === node), true, 'docked browser receives keyboard focus');
    await page.evaluate(() => {
      const view = (window as any).projectionTest.view;
      view.setVisible(false);
      view.previewAgent({ ...view.controller.tab(), controller: { owner: 'agent' } });
    });
    await page.waitForFunction(() => (window as any).projectionTest.calls.at(-1)?.action === 'attach'
      && (window as any).projectionTest.calls.at(-1)?.interactive === false);
    assert.equal(await page.$eval('.ag-browser-floating', node => (node as HTMLElement).hidden), false, 'agent activity opens the floating preview');
    assert.equal(await page.$eval('.ag-browser-floating', node => (node as HTMLElement).inert), true, 'preview chrome rejects human input');
    assert.equal(await page.$eval('.ag-browser', node => (node as HTMLElement).inert), true, 'preview page controls reject human input');
    assert.equal(await page.$eval('.ag-browser-address', node => { (node as HTMLElement).focus(); return document.activeElement === node; }), false, 'URL input cannot steal agent control');
    await page.evaluate(() => document.documentElement.classList.add('document-home-open'));
    await attached('same-tab');
    assert.equal(await page.$eval('.ag-browser-floating', node => getComputedStyle(node).visibility), 'visible', 'agent preview remains visible on Home');
    await page.evaluate(() => (window as any).projectionTest.view.controller.refresh());
    assert.equal(await page.$eval('.ag-browser-floating', node => (node as HTMLElement).hidden), false, 'idle browser state preserves the agent preview');
    await page.evaluate(() => (window as any).projectionTest.view.endAgentPreview());
    assert.equal(await page.$eval('.ag-browser-floating', node => (node as HTMLElement).hidden), true, 'turn end collapses immediately');
    await attached(null);
    assert.equal(await page.evaluate(() => (window as any).projectionTest.view.controller.tab().tabId), 'same-tab', 'collapse preserves the browser tab');
    const handoff = await page.evaluate(async () => {
      const harness = (window as any).projectionTest;
      document.documentElement.classList.remove('document-home-open');
      harness.view.float();
      const snapshot = harness.view.suspendShared();
      await snapshot.ready;
      const hidden = document.querySelector<HTMLElement>('.ag-browser-floating')!.hidden;
      harness.view.dispose();
      const next = harness.createView();
      next.mount(document.querySelector<HTMLElement>('#host')!);
      const restored = await next.restoreShared(snapshot.tabId);
      next.dock();
      const result = { restored, hidden, tabId: next.controller.tab().tabId, mode: next.element.dataset.presentation,
        opened: harness.calls.some((call: any) => call.action === 'open') };
      next.dispose(); return result;
    });
    assert.deepEqual(handoff, { restored: true, hidden: true, tabId: 'same-tab', mode: 'dock', opened: false }, 'document handoff preserves the shared browser page instead of opening or reloading it');
    const links = await page.evaluate(async () => {
      const { routeChatBrowserLinks } = await import('../src/ui/agent-sidebar/chat-browser-links.ts');
      const host = document.createElement('div');
      host.innerHTML = '<a href="https://example.com/chat"><span>웹 자료</span></a><a href="https://example.com/file" download>파일</a><span class="ag-md-artifact-card"><a href="https://example.com/document">문서</a></span><a href="mailto:test@example.com">메일</a>';
      document.body.append(host);
      const opened: string[] = [];
      routeChatBrowserLinks(host, async url => { opened.push(url); }, error => { throw error; });
      const events = [...host.querySelectorAll('a')].map(link => {
        const event = new MouseEvent('click', { bubbles: true, cancelable: true });
        (link.firstElementChild ?? link).dispatchEvent(event);
        return event.defaultPrevented;
      });
      const middle = new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true });
      host.querySelector('a')!.dispatchEvent(middle);
      host.remove();
      return { opened, events, middle: middle.defaultPrevented };
    });
    assert.deepEqual(links.opened, ['https://example.com/chat', 'https://example.com/chat']);
    assert.deepEqual(links.events, [true, false, false, false], 'web links route internally while downloads, documents and mail preserve their actions');
    assert.equal(links.middle, true, 'middle click also uses the app browser');
    await page.evaluate(() => (window as any).projectionTest.view.dispose());
  } finally { await browser?.close(); await server.close(); }
});
