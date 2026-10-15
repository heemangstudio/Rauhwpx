import assert from 'node:assert/strict';

/** 집중 화면 설정: 좁은 폭에서 채팅 목록 레일이 열리지 않고, 홈에서 연 설정은 닫을 때 집중 화면을 되돌린다. */
export async function checkSettingsFocus({ page, open }) {
  const railOpen = () => page.$eval('.ag-root', (root) => root.classList.contains('ag-compact-rail-open'));
  const hoverLeftEdge = async () => {
    await page.mouse.move(400, 300);
    await page.mouse.move(2, 300, { steps: 6 });
    await new Promise((resolve) => setTimeout(resolve, 450));
  };

  await page.setViewport({ width: 800, height: 900 });
  await open('reset=1&fullscreen=1&width=800');
  await page.waitForFunction(() => document.querySelector('.ag-root').classList.contains('ag-workspace-compact'));
  await hoverLeftEdge();
  assert.equal(await railOpen(), true, 'compact rail opens from the left edge outside settings');
  await page.mouse.move(600, 300);
  await page.evaluate(() => document.querySelector('.ag-workspace-threads-btn').click());
  await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-compact-rail-open'));

  await page.evaluate(() => window.sidebarPreview.eventBus.emit('settings:open', { destination: 'editing' }));
  await page.waitForFunction(() => document.querySelector('.ag-root').classList.contains('ag-settings-open'));
  await hoverLeftEdge();
  assert.equal(await railOpen(), false, 'compact rail stays closed while settings are open');

  await page.evaluate(() => document.querySelector('.ag-workspace-settings-back').click());
  await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-settings-open'));
  await hoverLeftEdge();
  assert.equal(await railOpen(), true, 'compact rail opens again after settings close');

  await open('reset=1&width=800');
  await page.evaluate(() => window.sidebarPreview.eventBus.emit('settings:open', { fullscreen: true, from: 'home' }));
  await page.waitForFunction(() => document.querySelector('.ag-root').classList.contains('ag-fullscreen')
    && document.querySelector('.ag-root').classList.contains('ag-settings-open'));
  await page.evaluate(() => document.querySelector('.ag-workspace-settings-back').click());
  await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-fullscreen'));
  await page.setViewport({ width: 1280, height: 900 });
}
