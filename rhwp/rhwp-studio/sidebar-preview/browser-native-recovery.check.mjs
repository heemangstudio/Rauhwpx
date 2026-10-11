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
  assert.deepEqual(await page.evaluate(() => window.nativeRecovery.restoreRequests), [true, true, true], 'the retry button performs explicit page recovery while automatic reconnect remains bounded');
  assert.equal(await page.evaluate(() => window.nativeRecovery.view.controller.tab().controller.owner), 'agent', 'presentation recovery preserves controller ownership');
  await page.evaluate(() => {
    const state = window.nativeRecovery;
    state.health = 'ready'; state.reloads = 0; state.probes = 0; state.healthTimers = new Map();
    const setTimeout = window.setTimeout.bind(window); const clearTimeout = window.clearTimeout.bind(window); let token = 900000;
    window.setTimeout = (callback, delay, ...args) => { if (delay !== 15000) return setTimeout(callback, delay, ...args); const id = ++token; state.healthTimers.set(id, callback); return id; };
    window.clearTimeout = id => { if (!state.healthTimers.delete(id)) clearTimeout(id); };
    window.rhwpDesktop.browser.getState = async () => { state.probes++; return { presentationHealth: state.health, navigationEpoch: 2 }; };
    window.rhwpDesktop.browser.reload = async () => { state.reloads++; };
    state.fireHealthTimer = () => { const entry = state.healthTimers.entries().next().value; if (entry) { state.healthTimers.delete(entry[0]); entry[1](); } };
    state.view.setVisible(false);
  });
  await page.waitForFunction(() => window.nativeRecovery.view.element.dataset.presentation === 'hidden');
  await page.evaluate(() => window.nativeRecovery.view.setVisible(true));
  await page.waitForFunction(() => window.nativeRecovery.probes === 1);
  assert.equal(await page.evaluate(() => window.nativeRecovery.reloads), 0, 'healthy reopening repaints without navigating');
  await page.evaluate(() => { window.nativeRecovery.health = 'loading'; window.nativeRecovery.view.setVisible(false); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => window.nativeRecovery.view.setVisible(true));
  await page.waitForFunction(() => window.nativeRecovery.healthTimers.size === 1);
  await page.evaluate(() => { for (let index = 0; index < 10; index++) window.dispatchEvent(new Event('resize')); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => { const state = window.nativeRecovery; state.staleTimer = state.healthTimers.values().next().value; state.probesBeforeNavigation = state.probes; state.view.controller.tab().navigationEpoch++; window.dispatchEvent(new Event('resize')); });
  await page.waitForFunction(() => window.nativeRecovery.probes > window.nativeRecovery.probesBeforeNavigation && window.nativeRecovery.healthTimers.size === 1);
  await page.evaluate(() => window.nativeRecovery.staleTimer());
  assert.equal(await page.evaluate(() => window.nativeRecovery.reloads), 0, 'a navigation supersedes the old loading watchdog');
  await page.evaluate(() => window.nativeRecovery.fireHealthTimer());
  await page.waitForFunction(() => window.nativeRecovery.reloads === 1 && window.nativeRecovery.healthTimers.size === 1);
  await page.evaluate(() => window.nativeRecovery.fireHealthTimer());
  await page.waitForFunction(() => !window.nativeRecovery.view.element.querySelector('.ag-browser-error').hidden);
  assert.equal(await page.evaluate(() => window.nativeRecovery.reloads), 1, 'a stalled reopen gets one fallback and then stops');
  await page.evaluate(() => { window.nativeRecovery.view.setVisible(false); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => { window.nativeRecovery.view.setVisible(true); });
  await page.waitForFunction(() => window.nativeRecovery.healthTimers.size === 1);
  await page.evaluate(() => {
    const state = window.nativeRecovery; const original = state.view.controller.tab();
    state.view.controller.state.tabs.push({ ...original, tabId: 'newer-tab', nativeTargetId: 'newer-target' });
    state.view.controller.select('newer-tab');
    state.fireHealthTimer();
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => window.nativeRecovery.reloads), 1, 'a newer selected tab cancels the previous recovery');
  await page.evaluate(() => { window.nativeRecovery.view.dispose(); delete window.rhwpDesktop; });
}
