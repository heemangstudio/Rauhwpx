import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { isMainModule, runStandalone } from './standalone.mjs';

/**
 * Hama cap notices in the production sidebar against the preview mock: a 5-hour cap shows the time until it
 * frees up with 저렴한 모델로 계속 (first) and BYOK로 전환, the cheap switch moves this chat to DeepSeek inside
 * Hama and offers 다시 시도, and a month cap offers only BYOK. Light and dark screenshots are saved.
 */
const notices = (page) => page.$$eval('.ag-failure-notice', (nodes) => nodes.map((node) => ({
  title: node.querySelector('.ag-failure-title')?.textContent ?? '',
  line: node.querySelector('.ag-failure-line')?.textContent ?? null,
  actions: [...node.querySelectorAll('.ag-failure-action')].map((button) => button.dataset.action),
})));

async function openHamaFailure(page, origin, { failure, hama, theme }) {
  await page.goto(`${origin}/?theme=${theme}&width=480&reset=1&scenario=error&failure=${failure}&hama=${hama}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview
    && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
  // Hama 하네스로 옮긴다 (피커의 항목 클릭과 같은 길).
  await page.evaluate(() => document.querySelector('.ag-provider-item[data-agent="hama"]').click());
  await page.waitForFunction(() => document.querySelector('.ag-root')?.dataset.agent === 'hama'
    && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
  await page.click('#play');
  await page.waitForFunction(() => document.querySelectorAll('.ag-failure-notice').length >= 1
    && !window.sidebarPreview.bridge.isTurnRunning());
}

async function shot(page, artifacts, name) {
  // 턴이 끝난 뒤 잠깐 남는 편집 표시가 걷힌 뒤 찍는다.
  await new Promise((done) => setTimeout(done, 800));
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, `hama-${name}.png`) });
}

export async function checkHamaCapNotices(page, origin, artifacts) {
  for (const theme of ['light', 'dark']) {
    await openHamaFailure(page, origin, { failure: 'hama-cap', hama: 'cap5h', theme });
    let [notice] = await notices(page);
    assert.equal(notice.title, 'Hama 5시간 사용 한도에 도달했어요');
    assert.match(notice.line, /^3시간 1[12]분 뒤 다시 쓸 수 있어요$/);
    assert.deepEqual(notice.actions, ['hama-cheap', 'byok']);
    await shot(page, artifacts, `cap-5h-${theme}`);

    await page.click('.ag-failure-action[data-action="hama-cheap"]');
    await page.waitForFunction(() => document.querySelector('.ag-llm-name')?.textContent === 'DeepSeek V4.1 Flash');
    [notice] = await notices(page);
    assert.equal(notice.line, 'DeepSeek V4.1 Flash로 바꿨어요');
    assert.deepEqual(notice.actions, ['retry']);
    assert.equal(await page.evaluate(() => document.querySelector('.ag-root').dataset.agent), 'hama', 'the switch stays inside Hama');
    await shot(page, artifacts, `cheap-switched-${theme}`);

    await openHamaFailure(page, origin, { failure: 'hama-month', hama: 'capmonth', theme });
    [notice] = await notices(page);
    assert.equal(notice.title, 'Hama 이번 달 사용량을 모두 썼어요');
    assert.match(notice.line, /에 다시 쓸 수 있어요$/);
    assert.deepEqual(notice.actions, ['byok']);
    await shot(page, artifacts, `cap-month-${theme}`);
  }
}

// Run on its own: `node sidebar-preview/hama.check.mjs` (own Vite server and browser profile).
if (isMainModule(import.meta)) await runStandalone('Hama cap notices', checkHamaCapNotices);
