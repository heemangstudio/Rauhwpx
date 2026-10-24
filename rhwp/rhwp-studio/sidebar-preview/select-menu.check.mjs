import assert from 'node:assert/strict';

/** 새 대화 기본값 칩의 떠 있는 메뉴: 키보드로 열고 고르면 select 가 change 를 받고, Escape 는 값을 두고 닫는다. */
export async function checkSelectMenu(page, origin) {
  await page.goto(`${origin}/?page=settings&destination=ai-connection&reset=1`, { waitUntil: 'networkidle0' });
  const effort = '.ag-settings-defaults .ag-settings-field:nth-child(3) select';
  await page.waitForSelector(effort);
  await page.$eval(effort, (select) => {
    window.selectMenuEvents = [];
    select.addEventListener('change', () => window.selectMenuEvents.push(select.value));
  });
  const before = await page.$eval(effort, (select) => select.value);
  const openMenu = '.ag-select-menu:not(.ag-leaving)';

  await page.focus(effort);
  await page.keyboard.press('ArrowDown');
  await page.waitForSelector(openMenu);
  const active = () => page.$eval(openMenu, (menu) => document.getElementById(menu.getAttribute('aria-activedescendant'))?.textContent);
  assert.equal(await page.$eval(`${openMenu} [aria-selected="true"]`, (node) => node.classList.contains('ag-active')), true);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.ag-select-menu:not(.ag-leaving)'));
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'SELECT');
  assert.deepEqual(await page.evaluate(() => window.selectMenuEvents), []);

  await page.keyboard.press('Enter');
  await page.waitForSelector(openMenu);
  await page.keyboard.press('Home');
  const first = await active();
  await page.keyboard.press('ArrowUp');
  assert.notEqual(await active(), first, 'ArrowUp from the first item wraps to the last');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.ag-select-menu:not(.ag-leaving)'));
  const after = await page.$eval(effort, (select) => select.value);
  assert.equal(await page.$eval(effort, (select) => select.selectedOptions[0].textContent), first);
  assert.deepEqual(await page.evaluate(() => window.selectMenuEvents), after === before ? [] : [after]);

  // 저장 중에는 select 가 잠기고 메뉴도 열리지 않는다.
  await page.$eval(effort, (select) => { select.disabled = true; });
  await page.click('.ag-settings-defaults .ag-settings-field:nth-child(3)');
  assert.equal(await page.$(openMenu), null);
}
