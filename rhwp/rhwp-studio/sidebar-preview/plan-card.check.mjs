// 앱 요금제: 무료면 사이드바가 접힌 채로 있고, 펼치려 하면 요금제 카드(무료 / Hama / Rau)가 열린다.
// Hama 는 문서 홈 위 막대의 Rau 입구로 카드를 연다. 체험을 쓸 수 있는 계정은 Rau 칸에서 7일 체험을 시작한다.
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
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('rhwp:open-plan-card', { detail: { focus: 'rau' } })));
  await cardOpen(page);
  await page.waitForSelector('.ag-pricing-col[data-plan="rau"][data-focus="true"]');
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
  assert.deepEqual(await page.$$eval('.ag-pricing-col', (cols) => cols.map((col) => col.dataset.plan)), ['free', 'hama', 'rau']);
  assert.equal(await page.$eval('.ag-pricing-col[data-plan="free"]', (col) => col.dataset.current), 'true');
  const columnText = (plan) => page.$eval(`.ag-pricing-col[data-plan="${plan}"] .ag-pricing-features`, (list) => [...list.children].map((li) => li.textContent));
  assert.deepEqual(await columnText('hama'), ['내 AI 연결']);
  assert.deepEqual(await columnText('rau'), ['Hama의 모든 기능', 'Rau 모드']);
  const cardText = await page.$eval('.ag-pricing-card', (card) => card.textContent);
  assert.doesNotMatch(cardText, /Haiku|Claude|DeepSeek|Codex|OpenRouter/, 'no vendor or model names');
  const rauButtons = await page.$$eval('.ag-pricing-col[data-plan="rau"] button', (buttons) => buttons.map((b) => [b.dataset.sku, b.disabled, b.textContent]));
  assert.deepEqual(rauButtons, [['rauMonthly', false, '월간'], ['rauYearly', false, '연간']], 'no trial without an account API');
  assert.match(await page.$eval('.ag-pricing-col[data-plan="rau"] .ag-pricing-price', (row) => row.textContent), /₩14,900.*₩149,000/);
  assert.match(await page.$eval('.ag-pricing-col[data-plan="hama"] .ag-pricing-price', (row) => row.textContent), /₩3,900.*₩39,000/);
  await page.click('.ag-pricing-col[data-plan="hama"] [data-sku="hamaMonthly"]');
  await page.waitForSelector('.ag-pricing-card[data-view="waiting"]');
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.plan.checkouts), ['hamaMonthly']);
  await page.waitForSelector('.ag-pricing-card[data-view="done"]', { timeout: 6000 });
  await page.waitForFunction(() => !document.querySelector('.ag-pricing-card'), { timeout: 4000 });
  await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-pricing-locked'));
  assert.equal(await page.$eval('#agent-sidebar', (root) => root.dataset.tier), 'hama');
  await page.$eval('.ag-collapse-tab', (tab) => tab.click());
  await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-collapsed'));
  await page.type('.ag-input', '표 합계 확인');
  await page.click('.ag-send');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().messageTexts.length === 1);
  assert.equal(await page.$('.ag-pricing-card'), null, 'an unlocked send opens no card');

  // 결제 링크가 비면 Hama·Rau 모두 '곧 출시'로 막힌다.
  await open('reset=1&plan=free&checkout=off');
  await page.$eval('.ag-collapse-tab', (tab) => tab.click());
  await cardOpen(page);
  for (const plan of ['hama', 'rau']) {
    const closed = await page.$$eval(`.ag-pricing-col[data-plan="${plan}"] button`, (buttons) => buttons.map((b) => [b.disabled, b.textContent]));
    assert.deepEqual(closed, [[true, '곧 출시']], plan);
  }
  await closeCard(page);

  // Rau 연간을 사면 등급이 rau 가 되고 잠금이 풀린다.
  await open('reset=1&plan=free');
  await page.$eval('.ag-collapse-tab', (tab) => tab.click());
  await cardOpen(page);
  await page.click('.ag-pricing-col[data-plan="rau"] [data-sku="rauYearly"]');
  await page.waitForSelector('.ag-pricing-card[data-view="waiting"]');
  assert.equal(await page.$eval('.ag-pricing-state-meta', (meta) => meta.textContent), 'Rau · 연간');
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.plan.checkouts), ['rauYearly']);
  await page.waitForSelector('.ag-pricing-card[data-view="done"]', { timeout: 6000 });
  assert.equal(await page.$eval('.ag-pricing-state-title', (title) => title.textContent), 'Rau를 쓸 수 있어요');
  await page.waitForFunction(() => !document.querySelector('.ag-pricing-card'), { timeout: 4000 });
  assert.equal(await page.$eval('#agent-sidebar', (root) => root.dataset.tier), 'rau');

  // 체험: 쓸 수 있는 계정은 Rau 칸에 체험 단추가 먼저 서고, 누르면 결제처럼 성공을 보이고 닫힌다.
  await open('reset=1&account=free&open=plans&focus=rau');
  await cardOpen(page);
  await page.waitForSelector('.ag-pricing-col[data-plan="rau"][data-focus="true"]');
  assert.deepEqual(
    await page.$$eval('.ag-pricing-col[data-plan="rau"] button', (buttons) => buttons.map((b) => b.textContent)),
    ['7일 무료 체험', '월간', '연간'],
  );
  await screenshot?.('plan-card-trial');
  await page.click('.ag-pricing-col[data-plan="rau"] .ag-pricing-btn-trial');
  await page.waitForSelector('.ag-pricing-card[data-view="done"]', { timeout: 4000 });
  assert.ok((await page.evaluate(() => window.sidebarPreview.account.calls)).includes('startRauTrial'));
  await page.waitForFunction(() => !document.querySelector('.ag-pricing-card'), { timeout: 4000 });
  await page.waitForFunction(() => document.querySelector('#agent-sidebar')?.dataset.tier === 'rau');
  // 체험 중이면 Rau 칸은 '체험 중'과 결제 단추를, Hama 칸은 결제 단추 없이 둔다.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('rhwp:open-plan-card')));
  await cardOpen(page);
  assert.equal(await page.$eval('.ag-pricing-col[data-plan="rau"] .ag-pricing-trial-tag', (tag) => tag.textContent), '체험 중');
  assert.equal(await page.$('.ag-pricing-col[data-plan="rau"] .ag-pricing-btn-trial'), null);
  assert.equal(await page.$('.ag-pricing-col[data-plan="hama"] button'), null);
  await closeCard(page);
  // 체험을 이미 쓴 계정에는 체험 단추가 없다. 서버가 거절하면 그 글을 한 줄로 보인다.
  await open('reset=1&account=trial-ended&open=plans');
  await cardOpen(page);
  assert.equal(await page.$('.ag-pricing-btn-trial'), null);
  await closeCard(page);
  await open('reset=1&account=hama&trialFail=rau_unavailable&open=plans');
  await cardOpen(page);
  await page.click('.ag-pricing-col[data-plan="rau"] .ag-pricing-btn-trial');
  await page.waitForSelector('.ag-pricing-notice:not([hidden])');
  assert.match(await page.$eval('.ag-pricing-notice', (line) => line.textContent), /체험을 시작할 수 없어요/);
  await closeCard(page);

  // 호스팅 Rau 칩도 요금제 API 가 있으면 페이지 대신 카드를 Rau 칸에 맞춰 연다.
  await open('reset=1&plan=hama&rau=upgrade');
  await page.waitForSelector('.ag-rau-upgrade-chip', { visible: true });
  await page.click('.ag-rau-upgrade-chip .ag-calibration-chip-open');
  await cardOpen(page);
  await page.waitForSelector('.ag-pricing-col[data-plan="rau"][data-focus="true"]');
  assert.equal(await page.$eval('.ag-pricing-col[data-plan="hama"]', (col) => col.dataset.current), 'true');
  await closeCard(page);

  // 요금제 API 가 없으면(웹) 잠그지 않는다.
  await open('reset=1');
  assert.equal(await page.$eval('.ag-root', (root) => root.classList.contains('ag-pricing-locked')), false);

  // 문서 홈의 Rau 입구: Hama 에만, 누르면 Rau 칸을 짚은 카드.
  const homeEntry = async (tier) => {
    await open(`reset=1&home=1&plan=${tier}`);
    await page.waitForSelector('#document-home .dh-topbar');
    return visible(page, '.plan-rau-entry');
  };
  assert.deepEqual([await homeEntry('free'), await homeEntry('rau'), await homeEntry('hama')], [false, false, true]);
  assert.equal(await visible(page, '.plan-rau-soon'), false, 'Rau checkout is open');
  await page.click('.plan-rau-entry');
  await cardOpen(page);
  await page.waitForSelector('.ag-pricing-col[data-plan="rau"][data-focus="true"]');
  await closeCard(page);
  await open('reset=1&home=1&plan=hama&checkout=off');
  await page.waitForSelector('#document-home .dh-topbar');
  assert.equal(await visible(page, '.plan-rau-soon'), true, 'an empty link reads as coming soon');
}
