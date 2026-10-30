// 호스팅 Rau-0.1 업그레이드: 거절이 오면 입력창 위 칩, 닫으면 다시 실행해도 그 거절에는 안 뜬다.
// 칩의 업그레이드는 페이지를 열고 칩을 걷는다. 설정 → AI → Rau-0.1 의 Pro 줄은 자격대로 보인다.
import assert from 'node:assert/strict';

const chipVisible = (page) => page.$eval('.ag-rau-upgrade-chip', (node) => node.checkVisibility());

export async function checkRauUpgrade({ page, open, screenshot }) {
  await open('reset=1&rau=upgrade');
  await page.waitForSelector('.ag-rau-upgrade-chip', { visible: true });
  assert.equal(await page.$eval('.ag-rau-upgrade-chip', (node) => node.textContent), 'Rau-0.1 호스팅은 Pro·Hama에서 써요월 ₩3,900');
  if (screenshot) await screenshot('rau-upgrade-chip');
  await page.click('.ag-rau-upgrade-chip .ag-calibration-chip-close');
  assert.equal(await chipVisible(page), false);

  // 같은 거절은 다시 열어도 띄우지 않는다.
  await open('rau=upgrade');
  assert.equal(await chipVisible(page), false, 'a dismissed refusal stays dismissed');

  await open('reset=1&rau=free');
  assert.equal(await chipVisible(page), false, 'no refusal, no chip');
  await page.click('#rau-upgrade');
  await page.waitForSelector('.ag-rau-upgrade-chip', { visible: true });
  await page.click('.ag-rau-upgrade-chip .ag-calibration-chip-open');
  await page.waitForFunction(() => document.querySelector('#preview-status')?.value?.includes('Upgrade page placeholder'));
  assert.equal(await chipVisible(page), false, 'opening the page settles the chip');

  // 설정의 Pro 줄: Pro 가 아니면 업그레이드 단추, Pro 면 켜짐.
  const proRow = async () => {
    await page.evaluate(() => window.sidebarPreview.eventBus.emit('settings:open', { destination: 'ai-custom' }));
    await page.waitForSelector('.ag-taste-pro-row', { visible: true });
    return page.$eval('.ag-taste-pro-row', (row) => ({
      text: row.textContent,
      upgrade: row.querySelector('.ag-settings-btn')?.checkVisibility() ?? false,
    }));
  };
  const free = await proRow();
  assert.equal(free.upgrade, true);
  assert.match(free.text, /월 ₩3,900 · 연 ₩39,000/);
  if (screenshot) await screenshot('rau-settings-free');
  await open('reset=1&rau=pro');
  const pro = await proRow();
  assert.deepEqual([pro.upgrade, pro.text.includes('켜짐')], [false, true]);
}
