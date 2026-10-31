// 호스팅 Rau-0.1 업그레이드: 거절이 오면 입력창 위 칩, 닫으면 다시 실행해도 그 거절에는 안 뜬다.
// 칩의 업그레이드는 페이지를 열고 칩을 걷는다. (자격·크레딧은 설정 → AI → 사용량: rau-harness.check.mjs)
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
}
