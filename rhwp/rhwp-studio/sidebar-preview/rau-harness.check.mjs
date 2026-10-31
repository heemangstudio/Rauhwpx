import assert from 'node:assert/strict';

/** 호스팅 Rau 하네스: 잠긴 항목은 요금제 카드만 열고, 크레딧은 설정에만, 기본 하네스는 고른 적 없는 사용자만. */
export async function checkRauHarness({ page, origin, open, screenshot }) {
  const viewport = page.viewport();
  const agent = () => page.$eval('.ag-root', (root) => root.dataset.agent);
  const shown = (selector) => page.$eval(selector, (node) => node.checkVisibility());
  const openPicker = async () => {
    await page.click('.ag-provider .ag-model-trigger');
    await page.waitForSelector('.ag-config-panel.ag-open');
  };
  const pick = async (name) => {
    if (!(await page.$('.ag-config-panel.ag-open'))) await openPicker();
    await page.click(`.ag-provider-item[data-agent="${name}"]`);
  };

  // 웹 Studio(데스크톱 아님) — Rau 항목이 없다.
  await open('reset=1');
  await openPicker();
  assert.equal(await shown('.ag-provider-item[data-agent="rau"]'), false, 'web Studio hides Rau');

  // 데스크톱, 무료·Hama 요금제 — 잠긴 항목은 요금제 카드의 Rau 칸을 열고 하네스를 바꾸지 않는다.
  await open('reset=1&rauAgent=noteligible');
  const before = await agent();
  await openPicker();
  assert.equal(await page.$eval('.ag-provider-item[data-agent="rau"]', (node) => node.dataset.locked), 'true');
  await screenshot('rau-locked');
  await page.click('.ag-provider-item[data-agent="rau"]');
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.planCardRequests), [{ focus: 'rau' }]);
  assert.equal(await agent(), before, 'a locked Rau does not switch the harness');
  assert.equal(await page.evaluate(() => localStorage.getItem('rhwp-agent-harness-choice')), null);

  // Rau 를 쓸 수 있고 고른 적 없음 — 첫 빈 채팅이 Rau 로 열린다.
  await open('reset=1&rauAgent=active');
  await page.waitForFunction(() => document.querySelector('.ag-root').dataset.agent === 'rau');
  assert.equal(await shown('.ag-provider .ag-provider-icon-mask[data-agent="rau"]'), true);
  await openPicker();
  await page.setViewport({ width: 320, height: 900 });
  const narrow = await page.$$eval('.ag-provider-item:not([hidden])', (items) => {
    const menu = items[0].parentElement.getBoundingClientRect();
    return { rows: new Set(items.map((item) => item.offsetTop)).size, fits: items.every((item) => item.getBoundingClientRect().right <= menu.right + 0.5) };
  });
  assert.deepEqual(narrow, { rows: 1, fits: true }, 'the row holds at the narrowest sidebar');
  await page.setViewport(viewport);
  const panelText = await page.$eval('.ag-config-panel', (panel) => panel.textContent);
  assert.doesNotMatch(panelText, /사용량|크레딧/, 'the picker shows no usage');

  // 크레딧은 설정의 사용량 탭에 있다.
  await open('rauAgent=active&page=settings&destination=ai-usage');
  const caption = '.ag-settings-quota-card[data-provider="rau"] .ag-settings-quota-caption';
  await page.waitForSelector(caption, { visible: true });
  assert.equal(await page.$eval(caption, (node) => node.textContent), '$8.00 중 $5.20 남음');
  assert.match(await page.$eval('.ag-settings-quota-card[data-provider="rau"] .ag-settings-usage-updated', (node) => node.textContent), /^\d+월 \d+일 초기화$/);
  await screenshot('rau-settings-usage');
  await page.evaluate(() => window.sidebarPreview.setRauAgent('trial'));
  await page.waitForFunction(() => document
    .querySelector('.ag-settings-quota-card[data-provider="rau"] .ag-settings-row-detail')?.textContent === '무료 체험');
  await screenshot('rau-settings-usage-trial');

  // 쓸 수 없으면 카드도 없다.
  await open('reset=1&rauAgent=noteligible&page=settings&destination=ai-usage');
  await page.waitForSelector('.ag-settings-quota-card[data-provider="claude"]', { visible: true });
  assert.equal(await page.$('.ag-settings-quota-card[data-provider="rau"]'), null);

  // BYOK 를 고르면 그 선택이 남는다.
  await open('rauAgent=active');
  await pick('pi');
  assert.equal(await agent(), 'pi');

  // 다시 열어도(같은 저장소) 고른 하네스가 이긴다 — Rau 상태가 다시 와도 바꾸지 않는다.
  await page.goto(`${origin}/?theme=light&width=480&rauAgent=active`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
  await page.evaluate(() => window.sidebarPreview.setRauAgent('active'));
  assert.notEqual(await agent(), 'rau', 'a previous choice keeps its harness');
  assert.equal(await page.evaluate(() => localStorage.getItem('rhwp-agent-harness-choice')), 'pi');
}
