import assert from 'node:assert/strict';

/** 실제 프로덕션 화면에서 네이티브 IPC 실패와 허브 재연결을 재현한다. 게스트는 fixture다. */
export async function checkNativeBrowserRecovery({ page, origin }) {
  await page.goto(`${origin}/?reset=1&controls=0&scenario=chat`, { waitUntil: 'networkidle0' });
  await page.evaluate(async () => {
    const { createWorkbenchBrowser } = await import('/src/ui/agent-sidebar/workbench-browser.ts');
    const tab = { tabId: 'logical-tab', nativeTargetId: 'obsolete-target', runtime: 'native', runtimeGeneration: 1, url: 'https://example.org/', title: 'Retained page', navigationEpoch: 2, controllerEpoch: 3, controller: { owner: 'agent' }, status: 'ready' };
    const runtime = { kind: 'native', state: 'ready', generation: 1, runtimeId: 'fixture' };
    const state = { attach: [], reconnect: 0, restoreRequests: [], fail: false, retry: true };
    window.nativeRecovery = state;
    window.rhwpDesktop = { browser: {
      async attach(args) { state.attach.push(args); if (state.fail || state.retry) { state.retry = false; throw new Error("Error invoking remote method 'desktop:browser-attach': Error: Native browser tab is unavailable"); } },
      async detach() {}, onEvent() { return () => {}; },
    } };
    const bridge = { getConnectionState: () => 'connected', onBrowserEvent: () => () => {}, onEvent: () => () => {},
      async requestBrowser(action, args = {}) {
        if (action === 'reconnect') { state.reconnect++; state.restoreRequests.push(args.restore === true); tab.nativeTargetId = 'retained-target'; tab.runtimeGeneration = 2; return { tab: { ...tab }, runtime: { ...runtime, generation: 2 } }; }
        if (action === 'status') return { tabs: [{ ...tab }], runtime: { ...runtime, generation: tab.runtimeGeneration } };
        return {};
      },
    };
    const view = createWorkbenchBrowser({ bridge, getDestination: () => ({}), onCapture() {}, onOpenDownload() {}, onDock() {}, onChat() {} });
    const mount = document.createElement('div'); mount.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;background:white'; document.body.append(mount);
    view.element.style.cssText = 'width:100%;height:100%'; view.mount(mount); view.setVisible(true);
    state.view = view;
  });
  await page.waitForFunction(() => window.nativeRecovery.attach.length === 2 && window.nativeRecovery.reconnect === 1);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await page.evaluate(() => window.nativeRecovery.attach.map((args) => ({ tabId: args.tabId, interactive: args.interactive }))), [{ tabId: 'logical-tab', interactive: true }, { tabId: 'logical-tab', interactive: true }]);
  assert.equal(await page.$eval('.ag-browser-error', (node) => node.hidden), true);
  await page.evaluate(() => { window.nativeRecovery.fail = true; window.nativeRecovery.view.controller.state.tabs[0].runtimeGeneration++; window.dispatchEvent(new Event('resize')); });
  await page.waitForFunction(() => window.nativeRecovery.attach.length === 4 && !window.nativeRecovery.view.element.querySelector('.ag-browser-error').hidden);
  await page.evaluate(() => { for (let index = 0; index < 20; index++) window.dispatchEvent(new Event('resize')); return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  assert.equal(await page.evaluate(() => window.nativeRecovery.attach.length), 4, 'failed recovery stops until the user retries');
  assert.equal(await page.$eval('.ag-browser-error', (node) => node.textContent.includes('desktop:browser-attach')), false, 'terminal failure uses an actionable message');
  await page.evaluate(() => { window.nativeRecovery.fail = false; window.nativeRecovery.view.element.querySelector('.ag-browser-error button').click(); });
  await page.waitForFunction(() => window.nativeRecovery.attach.length >= 5 && window.nativeRecovery.view.element.querySelector('.ag-browser-error').hidden);
  assert.deepEqual(await page.evaluate(() => window.nativeRecovery.restoreRequests), [false, false, true], 'the retry button performs explicit page recovery while automatic reconnect remains bounded');
  assert.equal(await page.evaluate(() => window.nativeRecovery.view.controller.tab().controller.owner), 'agent', 'presentation recovery preserves controller ownership');
  await page.evaluate(() => { window.nativeRecovery.view.dispose(); delete window.rhwpDesktop; });
}
