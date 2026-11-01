import assert from 'node:assert/strict';
import { isMainModule, runStandalone } from './standalone.mjs';

export async function checkUpdateAll(page, origin) {
  await page.goto(`${origin}/?reset=1`, { waitUntil: 'networkidle0' });
  await page.evaluate(async () => {
    const { createUpdateHippo } = await import('/src/ui/update-hippo/update-hippo.ts');
    const { createDevUpdatesApi } = await import('/src/ui/update-hippo/dev-updates-mock.ts');
    const listeners = new Set();
    let state = { runId: null, phase: 'idle', restartAt: null, items: ['app', 'claude', 'codex'].map(id => ({
      id, fromVersion: '1.0.0', targetVersion: '2.0.0', status: 'available', message: null,
    })) };
    const calls = { start: 0, later: 0 };
    const push = (patch) => { state = { ...state, ...patch }; listeners.forEach(listener => listener(state)); };
    const hippo = createUpdateHippo({ ...createDevUpdatesApi('available'),
      getAllState: async () => state,
      onAllState: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      updateAll: async () => { calls.start++; push({ phase: 'updating', items: state.items.map(item => ({ ...item, status: 'running' })) }); return state; },
      later: async () => { calls.later++; push({ phase: 'deferred' }); },
    }, {
      // The home offers the one-click sign to paid users only.
      status: () => ({ signedIn: true, tier: 'rau', agentUnlocked: true }),
      subscribe: () => () => {},
    });
    hippo.element.id = 'update-all-check';
    Object.assign(hippo.element.style, { position: 'fixed', zIndex: '2000' });
    document.body.append(hippo.element);
    window.updateAllCheck = { calls, push, dispose: () => hippo.dispose() };
  });
  const button = '#update-all-check [data-action="update-all"]';
  await page.waitForSelector(button, { visible: true });
  assert.match(await page.$eval('#update-all-check .uh-text', node => node.textContent), /HamaEditor.*Claude.*Codex/);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  await page.click(button);
  await page.waitForFunction(() => {
    const hippo = document.getElementById('update-all-check');
    return hippo?.dataset.frame === 'dip' && /translateY\([1-9]/.test(hippo.querySelector('.uh-rig').style.transform);
  }, { polling: 'raf', timeout: 2000 });
  await page.waitForFunction(() => document.getElementById('update-all-check').dataset.frame === 'idle'
    && !document.querySelector('#update-all-check .uh-rig').style.transform,
    { polling: 'raf', timeout: 3000 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  assert.equal(await page.evaluate(() => window.updateAllCheck.calls.start), 1);
  assert.equal(await page.$(button), null, 'no duplicate start action during the run');
  const bounds = await page.$eval('#update-all-check', node => {
    const banner = node.querySelector('.uh-board').getBoundingClientRect();
    const clip = node.getBoundingClientRect();
    return { top: banner.top - 3, clipTop: clip.top };
  });
  assert.ok(bounds.top >= bounds.clipTop, `progress banner is clipped: ${JSON.stringify(bounds)}`);
  await page.evaluate(() => window.updateAllCheck.push({ phase: 'countdown', restartAt: Date.now() + 5000 }));
  await page.waitForSelector('#update-all-check [data-action="later"]', { visible: true });
  await page.click('#update-all-check [data-action="later"]');
  assert.equal(await page.evaluate(() => window.updateAllCheck.calls.later), 1);
  await page.waitForSelector(button, { visible: true });
  assert.equal(await page.$eval(button, node => node.getAttribute('aria-label')), '재시작');
  await page.evaluate(() => window.updateAllCheck.push({ phase: 'failed', items: [
    { id: 'claude', targetVersion: '2.0.0', status: 'failed', message: 'network unavailable' },
    { id: 'codex', targetVersion: '2.0.0', status: 'done', message: null },
  ] }));
  assert.match(await page.$eval('#update-all-check .uh-text', node => node.textContent), /Claude.*실패.*Codex.*완료.*network unavailable/);
  assert.equal(await page.$eval(button, node => node.getAttribute('aria-label')), '실패한 항목 다시 시도');
  await page.evaluate(() => window.updateAllCheck.dispose());
}
if (isMainModule(import.meta)) await runStandalone('One-click updates', checkUpdateAll);
