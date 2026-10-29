// 앱 요금제: 무료면 보내기가 요금제 카드를 열고 아무것도 보내지 않는다. ↑ 단추는 무료·Pro 에 보이고 Hama 에는 없다.
// 결제 링크가 비면 '곧 출시'로 막히고, 결제가 끝나면 다시 불러오지 않고 에이전트가 열린다.
import assert from 'node:assert/strict';

const sentTexts = (page) => page.evaluate(() => window.sidebarPreview.snapshot().messageTexts);
const visible = (page, selector) => page.evaluate((s) => document.querySelector(s)?.checkVisibility() ?? false, selector);
const cardOpen = (page) => page.waitForSelector('.ag-pricing-card', { visible: true });
const closeCard = async (page) => {
  await page.click('.ag-pricing-close');
  await page.waitForFunction(() => !document.querySelector('.ag-pricing-card'));
};

export async function checkPlanCard({ page, open, screenshot }) {
  // 무료: 글을 써서 보내도, Enter 를 눌러도 카드만 열린다.
  await open('reset=1&plan=free');
  await page.waitForSelector('.ag-root.ag-pricing-locked');
  assert.equal(await page.$eval('.ag-input', (input) => input.placeholder), 'Pro에서 쓸 수 있어요');
  if (screenshot) await screenshot('plan-free-locked');
  await page.type('.ag-input', '표 합계 확인');
  await page.click('.ag-send');
  await cardOpen(page);
  assert.deepEqual(await sentTexts(page), [], 'a locked send sends nothing');
  assert.equal(await page.$eval('.ag-input', (input) => input.value), '표 합계 확인', 'the draft stays');
  await closeCard(page);
  await page.focus('.ag-input');
  await page.keyboard.press('Enter');
  await cardOpen(page);
  assert.deepEqual(await sentTexts(page), [], 'Enter sends nothing');
  await closeCard(page);
  assert.equal(await visible(page, '.ag-pricing-upgrade'), true, 'arrow on free');

  // 창 이벤트로도 열린다(다른 화면이 모듈을 가져오지 않고 연다).
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('rhwp:open-plan-card', { detail: { focus: 'hama' } })));
  await cardOpen(page);
  await page.waitForSelector('.ag-pricing-col[data-plan="hama"][data-focus="true"]');
  await closeCard(page);

  // 결제: 월간을 누르면 확인 중으로 바뀌고, 끝나면 성공을 잠깐 보인 뒤 닫히며 잠금이 풀린다.
  await page.click('.ag-pricing-upgrade');
  await cardOpen(page);
  assert.equal(await page.$eval('.ag-pricing-col[data-plan="free"]', (col) => col.dataset.current), 'true');
  assert.equal(await page.$eval('.ag-pricing-col[data-plan="hama"] button', (b) => [b.disabled, b.textContent].join()), 'true,곧 출시');
  await page.click('.ag-pricing-col[data-plan="pro"] [data-sku="proMonthly"]');
  await page.waitForSelector('.ag-pricing-card[data-view="waiting"]');
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.plan.checkouts), ['proMonthly']);
  await page.waitForSelector('.ag-pricing-card[data-view="done"]', { timeout: 6000 });
  await page.waitForFunction(() => !document.querySelector('.ag-pricing-card'), { timeout: 4000 });
  await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-pricing-locked'));
  assert.equal(await page.$eval('#agent-sidebar', (root) => root.dataset.tier), 'pro');
  assert.equal(await visible(page, '.ag-pricing-upgrade'), true, 'arrow on pro');
  await page.click('.ag-send');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().messageTexts.length === 1);
  assert.equal(await page.$('.ag-pricing-card'), null, 'an unlocked send opens no card');

  // 결제 링크가 비면 Pro 도 '곧 출시'로 막힌다.
  await open('reset=1&plan=free&checkout=off');
  await page.click('.ag-pricing-upgrade');
  await cardOpen(page);
  const proButtons = await page.$$eval('.ag-pricing-col[data-plan="pro"] button', (buttons) => buttons.map((b) => [b.disabled, b.textContent]));
  assert.deepEqual(proButtons, [[true, '곧 출시']]);
  await closeCard(page);

  // 호스팅 Rau 칩도 요금제 API 가 있으면 페이지 대신 카드를 연다.
  await open('reset=1&plan=legacy&rau=upgrade');
  await page.waitForSelector('.ag-rau-upgrade-chip', { visible: true });
  await page.click('.ag-rau-upgrade-chip .ag-calibration-chip-open');
  await cardOpen(page);
  assert.equal(await visible(page, '.ag-pricing-badge'), true, 'legacy mark');
  await closeCard(page);

  // Hama 에는 ↑ 단추가 없고, 요금제 API 가 없으면(웹) 잠금도 단추도 없다.
  await open('reset=1&plan=hama');
  assert.equal(await visible(page, '.ag-pricing-upgrade'), false, 'no arrow on hama');
  await open('reset=1');
  assert.equal(await visible(page, '.ag-pricing-upgrade'), false, 'no arrow without a plan API');
  assert.equal(await page.$eval('.ag-root', (root) => root.classList.contains('ag-pricing-locked')), false);
}
