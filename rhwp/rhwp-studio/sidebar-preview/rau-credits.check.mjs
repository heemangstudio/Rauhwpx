import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { isMainModule, runStandalone } from './standalone.mjs';

/**
 * 호스팅 Rau 크레딧 소진 알림: 다 쓴 Rau 로 보내면 다시 채워지는 날과 내 AI로 전환만 보이고, 체험이면 업그레이드가
 * 먼저 온다. Light and dark screenshots are saved.
 */
const notices = (page) => page.$$eval('.ag-failure-notice', (nodes) => nodes.map((node) => ({
  title: node.querySelector('.ag-failure-title')?.textContent ?? '',
  line: node.querySelector('.ag-failure-line')?.textContent ?? null,
  actions: [...node.querySelectorAll('.ag-failure-action')].map((button) => button.dataset.action),
})));

async function sendOnRau(page, origin, { mode, theme }) {
  await page.goto(`${origin}/?theme=${theme}&width=480&reset=1&rauAgent=${mode}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview
    && document.querySelector('.ag-root')?.dataset.agent === 'rau'
    && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
  // 크레딧은 그대로 두고 소진만 켠다(체험 표시를 지키려고).
  await page.evaluate(() => {
    const preview = window.sidebarPreview;
    preview.setRauAgentStatus({ ...preview.bridge.rauAgentStatus(), exhausted: true });
  });
  await page.click('#play');
  await page.waitForFunction(() => document.querySelectorAll('.ag-failure-notice').length >= 1
    && !window.sidebarPreview.bridge.isTurnRunning());
}

async function shot(page, artifacts, name) {
  await new Promise((done) => setTimeout(done, 800));
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, `rau-${name}.png`) });
}

export async function checkRauCreditNotices(page, origin, artifacts) {
  for (const theme of ['light', 'dark']) {
    await sendOnRau(page, origin, { mode: 'exhausted', theme });
    let [notice] = await notices(page);
    assert.equal(notice.title, 'Rau 크레딧을 모두 썼어요');
    assert.match(notice.line, /^\d+월 \d+일에 다시 채워져요$/);
    assert.deepEqual(notice.actions, ['byok']);
    await shot(page, artifacts, `credits-${theme}`);

    await sendOnRau(page, origin, { mode: 'trial', theme });
    [notice] = await notices(page);
    assert.equal(notice.line, null);
    assert.deepEqual(notice.actions, ['rau-upgrade', 'byok']);
    await page.click('.ag-failure-action[data-action="rau-upgrade"]');
    assert.deepEqual(await page.evaluate(() => window.sidebarPreview.planCardRequests), [{ focus: 'rau' }]);
    await shot(page, artifacts, `credits-trial-${theme}`);
  }
}

// Run on its own: `node sidebar-preview/rau-credits.check.mjs` (own Vite server and browser profile).
if (isMainModule(import.meta)) await runStandalone('Rau credit notices', checkRauCreditNotices);
