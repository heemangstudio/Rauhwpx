import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

test('retry discards a deleted native tab after refreshing the reset inventory', { timeout: 30_000 }, async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'reset-harness', configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/reset-harness') return next();
        response.setHeader('Content-Type', 'text/html'); response.end('<html><head><style>.ag-browser { height:100% }</style></head><body></body></html>');
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/reset-harness`);
    await page.evaluate(async () => {
      document.body.innerHTML = '<div id="reset-host" style="width:800px;height:600px"></div>';
      const calls: string[] = []; let reset = false;
      const tab = { tabId: 'deleted-tab', scope: 'global', nativeTargetId: 'deleted-target', runtime: 'native', url: 'https://example.com/', title: 'Reset fixture', navigationEpoch: 1, controllerEpoch: 1, controller: { owner: 'human' }, status: 'ready' };
      Object.assign(window, { rhwpDesktop: { browser: {
        onEvent: () => () => {},
        async attach() { throw new Error('Controlled unavailable native target'); },
        async detach() {},
      } } });
      const bridge = { getConnectionState: () => 'connected', onBrowserEvent: () => () => {}, onEvent: () => () => {}, async requestBrowser(action: string) {
        calls.push(action);
        if (action === 'status') return { tabs: reset ? [] : [tab] };
        if (action === 'reconnect') throw new Error('BROWSER_TAB_NOT_FOUND');
        return {};
      } };
      const { createWorkbenchBrowser } = await import('../src/ui/agent-sidebar/workbench-browser.ts');
      const view = createWorkbenchBrowser({ bridge: bridge as any, getDestination: () => ({ threadId: 'chat', projectId: null, documentId: null, label: 'Reset' }), onCapture() {}, onOpenDownload() {}, onDock() {}, onChat() {} });
      view.mount(document.querySelector<HTMLElement>('#reset-host')!); view.setVisible(true);
      Object.assign(window, { resetTest: { view, calls, reset() { reset = true; } } });
    });
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('.ag-browser-error')!.hidden);
    await page.evaluate(() => (window as any).resetTest.reset());
    await page.click('.ag-browser-error button');
    await page.waitForFunction(() => (window as any).resetTest.view.controller.state.tabs.length === 0);
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.ag-browser-error')!.hidden);
    assert.equal(await page.evaluate(() => (window as any).resetTest.calls.includes('reconnect')), false, 'retry must not reconnect the tab deleted by Settings');
    assert.equal(await page.$eval('.ag-browser-placeholder button', node => (node as HTMLButtonElement).hidden), false, 'the empty browser offers a fresh tab');
    await page.evaluate(() => (window as any).resetTest.view.dispose());
  } finally { await browser?.close(); await server.close(); }
});

/** 실제 브라우저 UI와 레이아웃을 사용하고 Electron 연결만 대체한다. */
test('숨긴 부모의 네이티브 페이지를 분리하고 같은 탭을 복원하며 늦은 연결을 취소한다', { timeout: 30_000 }, async t => {
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
      const nativeEvents = new Set<(event: any) => void>();
      let rejectHealth: ((error: Error) => void) | undefined; let holdHealth = false;
      let hold = false; let release: (() => void) | undefined;
      Object.assign(window, { rhwpDesktop: { browser: {
        onEvent(callback: (event: any) => void) { nativeEvents.add(callback); return () => nativeEvents.delete(callback); },
        async attach(args: { tabId: string }) { calls.push({ action: 'attach', ...args }); if (hold) await new Promise<void>(resolve => { release = resolve; }); attached = args.tabId; },
        async detach(args: { tabId: string }) { calls.push({ action: 'detach', tabId: args.tabId }); attached = null; },
        async getState() { if (holdHealth) return new Promise((_resolve, reject) => { rejectHealth = reject; }); return {}; },
      } } });
      const { createWorkbenchBrowser } = await import('../src/ui/agent-sidebar/workbench-browser.ts');
      const tab = { tabId: 'same-tab', scope: 'global', nativeTargetId: 'same-target', runtime: 'native', url: 'https://example.com/retained', title: '자료', navigationEpoch: 3, controllerEpoch: 2, controller: { owner: 'human' }, status: 'ready' };
      const bridge = { getConnectionState: () => 'connected', onBrowserEvent: () => () => {}, onEvent: () => () => {}, async requestBrowser(action: string, args: Record<string, unknown> = {}) {
        calls.push({ action, ...args }); if (action === 'sleep') { attached = null; return { sleeping: true, tab: { ...tab, status: 'sleeping', nativeTargetId: undefined } }; }
        if (action === 'control') {
          if ((window as any).projectionTest.rejectControl) throw new Error('조작권을 옮기지 못했습니다.');
          const current = (window as any).projectionTest.view.controller.tab();
          return { tab: { ...current, controllerEpoch: current.controllerEpoch + 1, controller: args.owner === 'human' ? { owner: 'human', held: true } : { owner: 'human' } } };
        }
        return action === 'status' ? { tabs: [tab] } : {}; } };
      const createView = () => createWorkbenchBrowser({ bridge: bridge as any, getDestination: () => ({ threadId: 'chat', projectId: null, documentId: null, label: '채팅' }), onCapture() {}, onOpenDownload() {}, onDock() {}, onChat() {} });
      const view = createView();
      view.mount(document.querySelector<HTMLElement>('#host')!); view.setVisible(true);
      Object.assign(window, { projectionTest: { view, calls, createView, dropPresentation() { attached = null; for (const callback of nativeEvents) callback({ type: 'presentation', tabId: 'same-tab', mode: 'hidden' }); }, holdHealth() { holdHealth = true; }, get healthStarted() { return !!rejectHealth; }, failHealth() { holdHealth = false; rejectHealth?.(new Error('Presentation hidden by menu')); }, get attached() { return attached; }, hold() { hold = true; }, release() { hold = false; release?.(); } } });
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
    await page.evaluate(() => {
      const harness = (window as any).projectionTest;
      harness.holdHealth();
      harness.view.controller.accept({ tab: { ...harness.view.controller.tab(), navigationEpoch: 4 } });
    });
    await page.waitForFunction(() => (window as any).projectionTest.healthStarted);
    const healthBounds = await page.evaluate(() => (window as any).projectionTest.calls.filter((call: any) => call.action === 'attach').at(-1).bounds.width);
    await page.evaluate(() => { document.querySelector<HTMLElement>('.ag-browser-floating')!.style.width = '640px'; });
    await page.waitForFunction(width => (window as any).projectionTest.calls.filter((call: any) => call.action === 'attach').at(-1).bounds.width > width, { timeout: 2_000 }, healthBounds);
    await page.evaluate(() => { (document.querySelector('.ag-browser-details') as HTMLDetailsElement).open = true; });
    await page.evaluate(() => (window as any).projectionTest.failHealth());
    await page.waitForFunction(() => (window as any).projectionTest.attached === null);
    assert.equal(await page.$eval('.ag-browser-error', node => (node as HTMLElement).hidden), true, 'opening the menu during a paint check must not report a disconnection');
    await page.evaluate(() => { (document.querySelector('.ag-browser-details') as HTMLDetailsElement).open = false; });
    await attached('same-tab');
    await page.evaluate(() => (window as any).projectionTest.view.dock());
    assert.equal(await page.$eval('.ag-browser', node => (node as HTMLElement).dataset.presentation), 'dock', 'fullscreen link focus can return a floating page to the workbench');
    assert.equal(await page.$eval('.ag-browser-floating', node => (node as HTMLElement).hidden), true);
    assert.equal(await page.$eval('.ag-browser-address', node => document.activeElement === node), true, 'docked browser receives keyboard focus');
    await page.evaluate(() => (window as any).projectionTest.dropPresentation());
    await attached('same-tab');
    await page.evaluate(() => {
      (window as any).rhwpDesktop.showContextMenu = async (items: any[]) => { (window as any).projectionTest.menuItems = items; (window as any).projectionTest.nativeMenuOpened = true; return new Promise(resolve => { (window as any).projectionTest.closeNativeMenu = resolve; }); };
    });
    const beforeMenu = await page.evaluate(() => (window as any).projectionTest.calls.filter((call: any) => call.action === 'detach').length);
    await page.click('.ag-browser-details summary');
    await page.waitForFunction(() => (window as any).projectionTest.nativeMenuOpened, { timeout: 1000 });
    assert.equal(await page.evaluate(() => (window as any).projectionTest.attached), 'same-tab', 'native menu keeps the actual page visible');
    assert.equal(await page.evaluate(() => (window as any).projectionTest.calls.filter((call: any) => call.action === 'detach').length), beforeMenu, 'opening the menu never detaches the guest');
    assert.equal(await page.$eval('.ag-browser-details', node => (node as HTMLDetailsElement).open), false, 'desktop menu does not expose the loading placeholder');
    await page.evaluate(() => (window as any).projectionTest.closeNativeMenu(null));
    assert.deepEqual(await page.evaluate(() => (window as any).projectionTest.menuItems.map((item: any) => item.id)), ['popout', 'chat', 'reload', 'sleep']);
    await page.evaluate(() => { (window as any).projectionTest.nativeMenuOpened = false; });
    await page.click('button[aria-label="다운로드 목록"]');
    await page.waitForFunction(() => (window as any).projectionTest.nativeMenuOpened);
    assert.equal(await page.evaluate(() => (window as any).projectionTest.attached), 'same-tab', 'download menu preserves the actual page');
    assert.equal(await page.evaluate(() => (window as any).projectionTest.calls.filter((call: any) => call.action === 'detach').length), beforeMenu, 'download menu never detaches the guest');
    await page.evaluate(() => (window as any).projectionTest.closeNativeMenu(null));
    await page.click('.ag-browser-details summary');
    await page.evaluate(() => (window as any).projectionTest.closeNativeMenu('sleep'));
    await page.waitForFunction(() => (window as any).projectionTest.calls.some((call: any) => call.action === 'sleep'));
    await attached(null);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => (window as any).projectionTest.attached), null, 'manually sleeping selected tab stays asleep');
    assert.equal(await page.$eval('.ag-browser-placeholder strong', node => node.textContent), '탭이 잠들어 있습니다');
    await page.click('.ag-browser-placeholder button[aria-label="탭 깨우기"]');
    await attached('same-tab');


    await page.evaluate(() => { const view = (window as any).projectionTest.view; view.previewAgent(view.controller.tab()); });
    await page.waitForFunction(() => (window as any).projectionTest.calls.some((call: any) => call.action === 'attach' && call.mode === 'dock' && call.interactive === false));
    assert.equal(await page.$eval('.ag-browser', node => (node as HTMLElement).dataset.presentation), 'dock', 'agent control preserves the visible sidebar');
    assert.equal(await page.$eval('.ag-browser-floating', node => (node as HTMLElement).hidden), true, 'docked agent control does not spawn a duplicate float');
    assert.ok(await page.evaluate(() => (window as any).projectionTest.calls.some((call: any) => call.action === 'view' && call.visible === true && call.tabId === 'same-tab')), 'selected sidebar tab is reported to the hub');
    await page.evaluate(() => (window as any).projectionTest.view.endAgentPreview());
    await attached('same-tab');
    assert.equal(await page.$eval('.ag-browser', node => (node as HTMLElement).inert), false, 'ending the agent turn restores sidebar input');
    assert.equal(await page.$eval('.ag-browser', node => (node as HTMLElement).dataset.presentation), 'dock', 'ending the agent turn keeps the page docked');

    await page.evaluate(() => {
      // 긴 대기만 가상 시계로 돌려 실제 프레임과 네이티브 투영 검사는 그대로 실행한다.
      const timers = new Map<number, { at: number; run: () => void }>();
      let now = 0; let nextId = -1;
      const schedule = window.setTimeout.bind(window); const cancel = window.clearTimeout.bind(window);
      window.setTimeout = ((handler: TimerHandler, delay = 0, ...args: any[]) => {
        if (delay < 60_000 || typeof handler !== 'function') return schedule(handler, delay, ...args);
        const id = nextId--; timers.set(id, { at: now + delay, run: () => handler(...args) }); return id;
      }) as typeof window.setTimeout;
      window.clearTimeout = (id?: number) => { if (id !== undefined && timers.delete(id)) return; cancel(id); };
      (window as any).projectionTest.advanceTime = (ms: number) => {
        now += ms;
        for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.run(); }
      };
      const view = (window as any).projectionTest.view;
      view.setVisible(false);
      view.previewAgent({ ...view.controller.tab(), controller: { owner: 'agent' } });
    });
    await page.waitForFunction(() => (window as any).projectionTest.calls.at(-1)?.action === 'attach'
      && (window as any).projectionTest.calls.at(-1)?.interactive === false);
    assert.equal(await page.$eval('.ag-browser-floating', node => (node as HTMLElement).hidden), false, 'agent activity opens the floating preview');
    assert.equal(await page.$eval('.ag-browser-floating .ag-browser-navigation', node => (node as HTMLElement).inert), true, 'preview chrome rejects human input');
    assert.equal(await page.$eval('.ag-browser-surface', node => (node as HTMLElement).inert), true, 'preview page controls reject human input');
    assert.equal(await page.$eval('.ag-browser-address', node => { (node as HTMLElement).focus(); return document.activeElement === node; }), false, 'URL input cannot steal agent control');
    await page.evaluate(() => document.documentElement.classList.add('document-home-open'));
    await attached('same-tab');
    assert.equal(await page.$eval('.ag-browser-floating', node => getComputedStyle(node).visibility), 'visible', 'agent preview remains visible on Home');
    await page.evaluate(() => (window as any).projectionTest.view.controller.refresh());
    assert.equal(await page.$eval('.ag-browser-floating', node => (node as HTMLElement).hidden), false, 'idle browser state preserves the agent preview');
    await page.evaluate(() => (window as any).projectionTest.view.endAgentPreview());
    assert.equal(await page.$eval('.ag-browser-floating', node => (node as HTMLElement).hidden), false, 'turn end keeps the browser visible');
    assert.equal(await page.$eval('.ag-browser-surface', node => (node as HTMLElement).inert), false, 'turn end immediately unlocks the lingering browser');
    assert.equal(await page.$eval('.ag-browser-floating', node => getComputedStyle(node).visibility), 'visible', 'the lingering browser stays visible on Home');
    await attached('same-tab');
    await page.evaluate(() => (window as any).projectionTest.advanceTime(119_999));
    assert.equal(await page.$eval('.ag-browser-floating', node => (node as HTMLElement).hidden), false, 'browser stays visible for two minutes');
    await page.evaluate(() => { const h = (window as any).projectionTest; h.view.previewAgent(h.view.controller.tab()); h.view.endAgentPreview(); h.advanceTime(1); });
    assert.equal(await page.$eval('.ag-browser-floating', node => (node as HTMLElement).hidden), false, 'new agent use resets the idle deadline');
    await page.evaluate(() => (window as any).projectionTest.advanceTime(119_999));
    assert.equal(await page.$eval('.ag-browser-floating', node => (node as HTMLElement).hidden), true, 'two idle minutes collapse the preview');
    await attached(null);
    assert.equal(await page.evaluate(() => (window as any).projectionTest.view.controller.tab().tabId), 'same-tab', 'collapse preserves the browser tab');
    await page.evaluate(() => document.documentElement.classList.remove('document-home-open'));

    await page.evaluate(() => { const h = (window as any).projectionTest; h.view.previewAgent(h.view.controller.tab()); h.view.endAgentPreview(); });
    await page.click('.ag-browser-floating-close');
    await attached(null);
    await page.evaluate(() => { const h = (window as any).projectionTest; h.view.float(); h.advanceTime(120_000); });
    assert.equal(await page.$eval('.ag-browser-floating', node => (node as HTMLElement).hidden), false, 'manual reopen cancels the old idle close');
    await page.click('.ag-browser-floating-close');
    await attached(null);

    await page.evaluate(() => { const h = (window as any).projectionTest; h.view.previewAgent(h.view.controller.tab()); h.view.endAgentPreview(); });
    await page.click('.ag-browser-floating .ag-browser-control');
    await page.waitForFunction(() => (window as any).projectionTest.view.controller.tab().controller.held === true);
    await page.evaluate(() => (window as any).projectionTest.advanceTime(120_000));
    assert.equal(await page.$eval('.ag-browser-floating', node => (node as HTMLElement).hidden), false, 'taking control during the idle grace period cancels automatic hiding');
    await page.click('.ag-browser-floating .ag-browser-control');
    await page.waitForFunction(() => (window as any).projectionTest.view.controller.tab().controller.held !== true);
    await page.click('.ag-browser-floating-close');
    await attached(null);

    // 직접 조작은 같은 게스트를 떼지 않고 입력만 풀며, 거절되면 미리보기 잠금으로 돌아가고, 턴이 끝나도 쓰던 창을 접지 않는다.
    const lastAttach = () => page.evaluate(() => (window as any).projectionTest.calls.filter((call: any) => call.action === 'attach').at(-1));
    const detaches = () => page.evaluate(() => (window as any).projectionTest.calls.filter((call: any) => call.action === 'detach').length);
    const surfaceInert = () => page.$eval('.ag-browser-surface', node => (node as HTMLElement).inert);
    await page.evaluate(() => { document.documentElement.classList.remove('document-home-open'); const view = (window as any).projectionTest.view; view.previewAgent(view.controller.tab()); });
    await page.waitForFunction(() => (window as any).projectionTest.attached === 'same-tab' && (window as any).projectionTest.calls.filter((call: any) => call.action === 'attach').at(-1).interactive === false);
    const detachedBefore = await detaches();
    await page.click('.ag-browser-floating .ag-browser-control');
    assert.equal(await surfaceInert(), false, 'taking control unlocks the page before the hub answers');
    await page.waitForFunction(() => (window as any).projectionTest.calls.some((call: any) => call.action === 'control' && call.owner === 'human'));
    await page.waitForFunction(() => { const call = (window as any).projectionTest.calls.filter((entry: any) => entry.action === 'attach').at(-1); return call.interactive === true && call.focus === true; });
    assert.equal(await detaches(), detachedBefore, 'taking control keeps the attached guest');
    await page.evaluate(() => { const view = (window as any).projectionTest.view; view.previewAgent(view.controller.tab()); });
    assert.equal(await surfaceInert(), false, 'agent reads keep the page the user holds');
    await page.click('.ag-browser-floating .ag-browser-control');
    await page.waitForFunction(() => (window as any).projectionTest.calls.some((call: any) => call.action === 'control' && call.owner === 'agent'));
    await page.waitForFunction(() => (window as any).projectionTest.calls.filter((call: any) => call.action === 'attach').at(-1).interactive === false);
    assert.equal(await surfaceInert(), true, 'returning control restores the agent preview');
    await page.evaluate(() => { (window as any).projectionTest.rejectControl = true; });
    await page.click('.ag-browser-floating .ag-browser-control');
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('.ag-browser-error')!.hidden);
    await page.waitForFunction(() => (window as any).projectionTest.calls.filter((call: any) => call.action === 'attach').at(-1).interactive === false);
    assert.equal(await surfaceInert(), true, 'a rejected transfer rolls back to the agent preview');
    await page.evaluate(() => { (window as any).projectionTest.rejectControl = false; });
    await page.click('.ag-browser-floating .ag-browser-control');
    await page.waitForFunction(() => (window as any).projectionTest.view.controller.tab().controller.held === true);
    await page.evaluate(() => (window as any).projectionTest.view.endAgentPreview());
    assert.equal(await page.$eval('.ag-browser-floating', node => (node as HTMLElement).hidden), false, 'turn end keeps the float the user holds');
    assert.equal((await lastAttach()).interactive, true);
    assert.equal(await surfaceInert(), false);
    await page.click('.ag-browser-floating .ag-browser-control');
    await page.waitForFunction(() => (window as any).projectionTest.view.controller.tab().controller.held !== true);
    assert.equal(await page.$eval('.ag-browser-floating .ag-browser-control', node => (node as HTMLElement).hidden), true, 'the control leaves once neither side is working');
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
      // 라우팅이 끝난 뒤 결과만 기록하고 기본 동작은 막는다. mailto 등이 실제로 메일 앱을 열지 않게 한다.
      const prevented: boolean[] = [];
      const record = (event: Event) => { prevented.push(event.defaultPrevented); event.preventDefault(); };
      document.addEventListener('click', record);
      document.addEventListener('auxclick', record);
      for (const link of host.querySelectorAll('a')) {
        (link.firstElementChild ?? link).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      const events = prevented.splice(0);
      host.querySelector('a')!.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
      const middle = prevented[0];
      document.removeEventListener('click', record);
      document.removeEventListener('auxclick', record);
      host.remove();
      return { opened, events, middle };
    });
    assert.deepEqual(links.opened, ['https://example.com/chat', 'https://example.com/chat']);
    assert.deepEqual(links.events, [true, false, false, false], 'web links route internally while downloads, documents and mail preserve their actions');
    assert.equal(links.middle, true, 'middle click also uses the app browser');
    const resizeBurst = await page.evaluate(async () => {
      const { createBrowserPresentation } = await import('../src/ui/agent-sidebar/browser-presentation.ts');
      const panel = document.createElement('section'); panel.className = 'ag-browser';
      const host = document.createElement('div'); document.body.append(host);
      const presentation = createBrowserPresentation(panel, () => {}); presentation.mount(host); presentation.present('float');
      const floating = panel.closest<HTMLElement>('.ag-browser-floating')!;
      const grip = floating.querySelector<HTMLElement>('.ag-browser-float-edge[data-edge=se]')!;
      grip.setPointerCapture = () => {}; grip.hasPointerCapture = () => false;
      const original = floating.getBoundingClientRect.bind(floating); let reads = 0;
      floating.getBoundingClientRect = () => { reads++; return original(); };
      const before = original();
      grip.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 4, clientX: 0, clientY: 0 }));
      for (let i = 1; i <= 60; i++) grip.dispatchEvent(new PointerEvent('pointermove', { pointerId: 4, clientX: -i, clientY: -i }));
      await new Promise(resolve => requestAnimationFrame(resolve));
      grip.dispatchEvent(new PointerEvent('pointerup', { pointerId: 4, clientX: -80, clientY: -80 }));
      const result = { reads, width: original().width, expected: before.width - 80 };
      presentation.dispose(); host.remove(); return result;
    });
    assert.equal(resizeBurst.width, resizeBurst.expected, 'resize commits the latest pointer position');
    t.diagnostic(`60 pointer moves: ${resizeBurst.reads} synchronous layout reads`);
    assert.ok(resizeBurst.reads <= 3, `resize burst caused ${resizeBurst.reads} synchronous layout reads`);
    await page.evaluate(() => (window as any).projectionTest.view.dispose());
  } finally { await browser?.close(); await server.close(); }
});
