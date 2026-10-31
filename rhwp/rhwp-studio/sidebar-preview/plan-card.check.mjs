// 앱 요금제: 무료면 사이드바가 접힌 채로 있고, 펼치려 하면 요금제 카드가 열린다.
// Pro·기존 라이선스는 문서 홈 위 막대의 Hama 입구로 카드를 연다.
// 결제 링크가 비면 '곧 출시'로 막히고, 결제가 끝나면 다시 불러오지 않고 산 요금제로 에이전트가 열린다.
import assert from 'node:assert/strict';

const sentTexts = (page) => page.evaluate(() => window.sidebarPreview.snapshot().messageTexts);
const visible = (page, selector) => page.evaluate((s) => document.querySelector(s)?.checkVisibility() ?? false, selector);
const cardOpen = (page) => page.waitForSelector('.ag-pricing-card', { visible: true });
const closeCard = async (page) => {
  await page.click('.ag-pricing-close');
  await page.waitForFunction(() => !document.querySelector('.ag-pricing-card'));
};

export async function checkPlanCard({ page, open, screenshot }) {
  // 무료: 사이드바는 접힌 채로 있고, 펼치려 하면 카드만 열린다.
  await open('reset=1&plan=free');
  await page.waitForSelector('.ag-root.ag-pricing-locked.ag-collapsed');
  const collapsed = () => page.$eval('.ag-root', (root) => root.classList.contains('ag-collapsed'));
  await page.$eval('.ag-collapse-tab', (tab) => tab.click());
  await cardOpen(page);
  assert.equal(await collapsed(), true, 'the tab does not expand a locked sidebar');
  // Esc 는 카드를 닫고, 그 뒤의 Esc 는 다시 열지 않는다.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.ag-pricing-card'));
  await page.keyboard.press('Escape');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await page.$('.ag-pricing-card'), null, 'a second Esc leaves the card closed');
  // 집중 화면도 열리지 않는다.
  await page.keyboard.down('Control');
  await page.keyboard.down('Meta');
  await page.keyboard.press('KeyJ');
  await page.keyboard.up('Meta');
  await page.keyboard.up('Control');
  await cardOpen(page);
  assert.equal(await page.$eval('.ag-root', (root) => root.classList.contains('ag-fullscreen')), false, 'no full screen');
  if (await page.$('.ag-pricing-card')) await closeCard(page);

  // 창 이벤트로도 열린다(다른 화면이 모듈을 가져오지 않고 연다).
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('rhwp:open-plan-card', { detail: { focus: 'hama' } })));
  await cardOpen(page);
  await page.waitForSelector('.ag-pricing-col[data-plan="hama"][data-focus="true"]');
  await closeCard(page);

  // 설정의 AI 묶음: 눌러도, 바로 열려고 해도 카드만 열리고 AI 설정은 나오지 않는다.
  await page.evaluate(() => window.sidebarPreview.eventBus.emit('settings:open', { destination: 'editing' }));
  await page.waitForSelector('#ag-settings-tab-ai.ag-settings-ai-locked', { visible: true });
  await page.click('#ag-settings-tab-ai');
  await cardOpen(page);
  assert.equal(await visible(page, '#ag-settings-nav-ai-sections'), false, 'the AI sections stay folded');
  assert.equal(await visible(page, '#ag-settings-pane-ai'), false, 'the AI pane stays closed');
  await closeCard(page);
  await page.evaluate(() => window.sidebarPreview.eventBus.emit('settings:open', { destination: 'ai-connection' }));
  await cardOpen(page);
  assert.equal(await visible(page, '#ag-settings-pane-ai'), false, 'a direct open stays out of AI');
  await closeCard(page);
  await page.$eval('.ag-settings-close', (close) => close.click());
  await page.waitForFunction(() => document.querySelector('.ag-root').classList.contains('ag-collapsed'));

  // 결제: 월간을 누르면 확인 중으로 바뀌고, 끝나면 성공을 잠깐 보인 뒤 닫히며 잠금이 풀린다.
  await page.$eval('.ag-collapse-tab', (tab) => tab.click());
  await cardOpen(page);
  assert.equal(await page.$eval('.ag-pricing-col[data-plan="free"]', (col) => col.dataset.current), 'true');
  const hamaButtons = await page.$$eval('.ag-pricing-col[data-plan="hama"] button', (buttons) => buttons.map((b) => [b.dataset.sku, b.disabled, b.textContent]));
  assert.deepEqual(hamaButtons, [['hamaMonthly', false, '월간'], ['hamaYearly', false, '연간']]);
  assert.match(await page.$eval('.ag-pricing-col[data-plan="hama"] .ag-pricing-price', (row) => row.textContent), /₩12,900.*₩139,000/);
  await page.click('.ag-pricing-col[data-plan="pro"] [data-sku="proMonthly"]');
  await page.waitForSelector('.ag-pricing-card[data-view="waiting"]');
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.plan.checkouts), ['proMonthly']);
  await page.waitForSelector('.ag-pricing-card[data-view="done"]', { timeout: 6000 });
  await page.waitForFunction(() => !document.querySelector('.ag-pricing-card'), { timeout: 4000 });
  await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-pricing-locked'));
  assert.equal(await page.$eval('#agent-sidebar', (root) => root.dataset.tier), 'pro');
  await page.$eval('.ag-collapse-tab', (tab) => tab.click());
  await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-collapsed'));
  await page.type('.ag-input', '표 합계 확인');
  await page.click('.ag-send');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().messageTexts.length === 1);
  assert.equal(await page.$('.ag-pricing-card'), null, 'an unlocked send opens no card');

  // 결제 링크가 비면 Pro 도 '곧 출시'로 막힌다.
  await open('reset=1&plan=free&checkout=off');
  await page.$eval('.ag-collapse-tab', (tab) => tab.click());
  await cardOpen(page);
  const proButtons = await page.$$eval('.ag-pricing-col[data-plan="pro"] button', (buttons) => buttons.map((b) => [b.disabled, b.textContent]));
  assert.deepEqual(proButtons, [[true, '곧 출시']]);
  const closedHama = await page.$$eval('.ag-pricing-col[data-plan="hama"] button', (buttons) => buttons.map((b) => [b.disabled, b.textContent]));
  assert.deepEqual(closedHama, [[true, '곧 출시']]);
  await closeCard(page);

  // Hama 연간을 사면 등급이 hama 가 되고 잠금이 풀린다.
  await open('reset=1&plan=free');
  await page.$eval('.ag-collapse-tab', (tab) => tab.click());
  await cardOpen(page);
  await page.click('.ag-pricing-col[data-plan="hama"] [data-sku="hamaYearly"]');
  await page.waitForSelector('.ag-pricing-card[data-view="waiting"]');
  assert.equal(await page.$eval('.ag-pricing-state-meta', (meta) => meta.textContent), 'Hama · 연간');
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.plan.checkouts), ['hamaYearly']);
  await page.waitForSelector('.ag-pricing-card[data-view="done"]', { timeout: 6000 });
  await page.waitForFunction(() => !document.querySelector('.ag-pricing-card'), { timeout: 4000 });
  assert.equal(await page.$eval('#agent-sidebar', (root) => root.dataset.tier), 'hama');

  // 호스팅 Rau 칩도 요금제 API 가 있으면 페이지 대신 카드를 연다.
  await open('reset=1&plan=legacy&rau=upgrade');
  await page.waitForSelector('.ag-rau-upgrade-chip', { visible: true });
  await page.click('.ag-rau-upgrade-chip .ag-calibration-chip-open');
  await cardOpen(page);
  assert.equal(await visible(page, '.ag-pricing-badge'), true, 'legacy mark');
  await closeCard(page);

  // 요금제 API 가 없으면(웹) 잠그지 않는다.
  await open('reset=1');
  assert.equal(await page.$eval('.ag-root', (root) => root.classList.contains('ag-pricing-locked')), false);

  // 문서 홈의 Hama 입구: Pro·기존 라이선스에만, 누르면 Hama 칸을 짚은 카드.
  const homeEntry = async (tier) => {
    await open(`reset=1&home=1&plan=${tier}`);
    await page.waitForSelector('#document-home .dh-topbar');
    return visible(page, '.plan-hama-entry');
  };
  assert.deepEqual(
    [await homeEntry('free'), await homeEntry('hama'), await homeEntry('legacy'), await homeEntry('pro')],
    [false, false, true, true],
  );
  assert.equal(await visible(page, '.plan-hama-soon'), false, 'Hama checkout is open');
  await page.click('.plan-hama-entry');
  await cardOpen(page);
  await page.waitForSelector('.ag-pricing-col[data-plan="hama"][data-focus="true"]');
  await closeCard(page);
  await open('reset=1&home=1&plan=pro&checkout=off');
  await page.waitForSelector('#document-home .dh-topbar');
  assert.equal(await visible(page, '.plan-hama-soon'), true, 'an empty link reads as coming soon');
}
