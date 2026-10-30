import assert from 'node:assert/strict';

/** Hama 하네스: 잠긴 항목은 플랜 안내만 열고, 사용량은 설정에만, 기본 하네스는 고른 적 없는 가입자만. */
export async function checkHamaHarness({ page, origin, open, screenshot }) {
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
  assert.equal(await shown('.ag-provider .ag-hama-badge'), true);
  await openPicker();
  const rowTops = await page.$$eval('.ag-provider-item:not([hidden])', (items) => new Set(items.map((item) => item.offsetTop)).size);
  assert.equal(rowTops, 1, 'Hama sits on the same row as the other providers');
  await page.setViewport({ width: 320, height: 900 });
  const narrow = await page.$$eval('.ag-provider-item:not([hidden])', (items) => {
    const menu = items[0].parentElement.getBoundingClientRect();
    return { rows: new Set(items.map((item) => item.offsetTop)).size, fits: items.every((item) => item.getBoundingClientRect().right <= menu.right + 0.5) };
  });
  assert.deepEqual(narrow, { rows: 1, fits: true }, 'the row holds at the narrowest sidebar');
  await page.setViewport(viewport);
  const panelText = await page.$eval('.ag-config-panel', (panel) => panel.textContent);
  assert.doesNotMatch(panelText, /사용량|5시간/, 'the picker shows no usage');
  assert.equal(await page.$('.ag-provider svg circle'), null, 'no usage ring next to the logo');

  // 사용량은 설정의 사용량 탭에 있다. 막힌 창은 0% 남음으로 읽힌다.
  await open('hama=active&page=settings&destination=ai-usage');
  await page.waitForSelector('.ag-settings-quota-card[data-provider="hama"]', { visible: true });
  assert.equal(await page.$$eval('.ag-settings-quota-card[data-provider="hama"] .ag-settings-quota-meter', (rows) => rows.length), 3);
  await page.evaluate(() => window.sidebarPreview.setHama('cap5h'));
  await page.waitForFunction(() => document
    .querySelector('.ag-settings-quota-card[data-provider="hama"] [data-cap="cap_5h"] .ag-settings-quota-caption')
    ?.textContent === '5시간: 0% 남음');
  const blockedReset = await page.$eval('.ag-settings-quota-card[data-provider="hama"] [data-cap="cap_5h"] .ag-settings-usage-updated', (node) => node.textContent);
  assert.match(blockedReset, /^3시간 후 리셋$/);
  await screenshot('hama-settings-usage');

  // 플랜이 없으면 카드도 없다.
  await open('reset=1&hama=notenrolled&page=settings&destination=ai-usage');
  await page.waitForSelector('.ag-settings-quota-card[data-provider="claude"]', { visible: true });
  assert.equal(await page.$('.ag-settings-quota-card[data-provider="hama"]'), null);

  // BYOK 를 고르면 그 선택이 남는다.
  await open('hama=active');
  await pick('pi');
  assert.equal(await agent(), 'pi');

  // 다시 열어도(같은 저장소) 고른 하네스가 이긴다 — Hama 상태가 다시 와도 바꾸지 않는다.
  await page.goto(`${origin}/?theme=light&width=480&hama=active`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
  await page.evaluate(() => window.sidebarPreview.setHama('active'));
  assert.notEqual(await agent(), 'hama', 'a previous choice keeps its harness');
  assert.equal(await page.evaluate(() => localStorage.getItem('rhwp-agent-harness-choice')), 'pi');
}
