import assert from 'node:assert/strict';

/** Hama 하네스: 잠긴 항목은 플랜 안내만 열고, 게이지는 Hama 에서만, 기본 하네스는 고른 적 없는 가입자만. */
export async function checkHamaHarness({ page, origin, open, screenshot }) {
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

  // 웹 Studio(데스크톱 아님) — Hama 항목이 없다.
  await open('reset=1');
  await openPicker();
  assert.equal(await shown('.ag-provider-item[data-agent="hama"]'), false, 'web Studio hides Hama');

  // 데스크톱, 라이선스는 있지만 Hama 플랜이 아님(Pro·기존 키) — 사이드바에는 업그레이드 안내가 없다.
  await open('reset=1&hama=notenrolled');
  await openPicker();
  assert.equal(await shown('.ag-provider-item[data-agent="hama"]'), false, 'Pro sees no Hama item');

  // 데스크톱, 라이선스 없음(Free) — 잠긴 항목은 플랜 안내를 열고 하네스를 바꾸지 않는다.
  await open('reset=1&hama=off');
  const before = await agent();
  await openPicker();
  assert.equal(await page.$eval('.ag-provider-item[data-agent="hama"]', (node) => node.dataset.locked), 'true');
  await screenshot('hama-locked');
  await page.click('.ag-provider-item[data-agent="hama"]');
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.planCardRequests), [{ focus: 'hama' }]);
  assert.equal(await agent(), before, 'a locked Hama does not switch the harness');
  assert.equal(await page.evaluate(() => localStorage.getItem('rhwp-agent-harness-choice')), null);

  // Hama 가입자, 고른 적 없음 — 첫 빈 채팅이 Hama 로 열리고 게이지가 보인다.
  await open('reset=1&hama=active');
  await page.waitForFunction(() => document.querySelector('.ag-root').dataset.agent === 'hama');
  assert.equal(await shown('.ag-hama-meter'), true, 'the usage ring shows on Hama');
  await openPicker();
  const rowTops = await page.$$eval('.ag-provider-item:not([hidden])', (items) => new Set(items.map((item) => item.offsetTop)).size);
  assert.equal(rowTops, 1, 'Hama sits on the same row as the other providers');
  assert.equal(await page.$$eval('.ag-hama-usage .ag-hama-usage-row', (rows) => rows.length), 3);
  assert.equal(await shown('.ag-hama-usage'), true);

  // 막힌 창은 꽉 찬 것으로 읽힌다.
  await page.evaluate(() => window.sidebarPreview.setHama('cap5h'));
  await page.waitForSelector('.ag-hama-usage-row[data-cap="cap_5h"][data-blocked="true"]');
  const blocked = await page.$eval('.ag-hama-usage-row[data-cap="cap_5h"]', (row) => ({
    pct: row.querySelector('.ag-hama-usage-pct').textContent,
    reset: row.querySelector('.ag-hama-usage-reset').textContent,
  }));
  assert.equal(blocked.pct, '100%');
  assert.match(blocked.reset, /^3시간 1\d분 후 초기화$/);
  await screenshot('hama-cap5h');

  // BYOK 로 바꾸면 게이지가 사라지고, 그 선택이 남는다.
  await pick('pi');
  assert.equal(await agent(), 'pi');
  assert.equal(await shown('.ag-hama-meter'), false, 'no usage ring on BYOK');
  assert.equal(await page.$eval('.ag-hama-usage', (node) => node.hidden), true, 'no usage group on BYOK');

  // 다시 열어도(같은 저장소) 고른 하네스가 이긴다 — Hama 상태가 다시 와도 바꾸지 않는다.
  await page.goto(`${origin}/?theme=light&width=480&hama=active`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
  await page.evaluate(() => window.sidebarPreview.setHama('active'));
  assert.notEqual(await agent(), 'hama', 'a previous choice keeps its harness');
  assert.equal(await page.evaluate(() => localStorage.getItem('rhwp-agent-harness-choice')), 'pi');
}
