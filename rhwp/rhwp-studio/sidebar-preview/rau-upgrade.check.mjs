// 호스팅 Rau-0.1 업그레이드: 거절이 오면 입력창 위 칩, 닫으면 다시 실행해도 그 거절에는 안 뜬다.
// 칩의 업그레이드는 페이지를 열고 칩을 걷는다. 설정 → AI → Rau-0.1 의 Rau 줄은 자격과 크레딧대로 보인다.
import assert from 'node:assert/strict';

const chipVisible = (page) => page.$eval('.ag-rau-upgrade-chip', (node) => node.checkVisibility());

export async function checkRauUpgrade({ page, open, screenshot }) {
  await open('reset=1&rau=upgrade');
  await page.waitForSelector('.ag-rau-upgrade-chip', { visible: true });
  assert.equal(await page.$eval('.ag-rau-upgrade-chip', (node) => node.textContent), 'Rau 모드는 Rau 요금제에서 써요월 ₩14,900');
  if (screenshot) await screenshot('rau-upgrade-chip');
  await page.click('.ag-rau-upgrade-chip .ag-calibration-chip-close');
  assert.equal(await chipVisible(page), false);

  // 같은 거절은 다시 열어도 띄우지 않는다.
  await open('rau=upgrade');
  assert.equal(await chipVisible(page), false, 'a dismissed refusal stays dismissed');

  await open('reset=1&rau=free');
  assert.equal(await chipVisible(page), false, 'no refusal, no chip');
  await page.$eval('#rau-upgrade', (button) => button.click());
  await page.waitForSelector('.ag-rau-upgrade-chip', { visible: true });
  await page.click('.ag-rau-upgrade-chip .ag-calibration-chip-open');
  await page.waitForFunction(() => document.querySelector('#preview-status')?.value?.includes('Upgrade page placeholder'));
  assert.equal(await chipVisible(page), false, 'opening the page settles the chip');

  // 설정의 Rau 줄: Rau 가 아니면 값과 업그레이드 단추, Rau 면 남은 크레딧, 체험이면 체험, 다 쓰면 소진.
  const rauRow = async () => {
    await page.evaluate(() => window.sidebarPreview.eventBus.emit('settings:open', { destination: 'ai-custom' }));
    await page.waitForSelector('.ag-taste-rau-row', { visible: true });
    return page.$eval('.ag-taste-rau-row', (row) => ({
      text: row.textContent,
      upgrade: row.querySelector('.ag-settings-btn')?.checkVisibility() ?? false,
    }));
  };
  const free = await rauRow();
  assert.equal(free.upgrade, true);
  assert.match(free.text, /^Rau월 ₩14,900 · 연 ₩149,000/);
  if (screenshot) await screenshot('rau-settings-free');
  await open('reset=1&rau=rau');
  const plan = await rauRow();
  assert.equal(plan.upgrade, false);
  assert.match(plan.text, /\$5\.20 남음 · \d+월 \d+일 초기화/);
  await open('reset=1&rau=trial');
  assert.match((await rauRow()).text, /무료 체험 · \$1\.35 남음 · \d+월 \d+일까지/);
  await open('reset=1&rau=exhausted');
  assert.match((await rauRow()).text, /\d+월 \d+일까지 크레딧 소진/);
}
