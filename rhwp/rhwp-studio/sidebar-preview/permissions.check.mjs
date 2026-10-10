import assert from 'node:assert/strict';

/** Fixture-backed production pill interactions; no provider credentials. */
export async function checkChatPermissions(page, origin, screenshot) {
  async function open(query = '') {
    await page.goto(`${origin}/?reset=1&theme=light&width=480&scenario=permission&${query}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.sidebarPreview && !document.querySelector('.ag-input').disabled);
    await page.type('.ag-input', '요청한 작업을 진행해 줘');
    await page.click('.ag-send');
    await page.waitForSelector('.ag-permission-grant', { visible: true });
    assert.equal(await page.$$eval('.ag-tool-label', (labels) => labels.some((label) => label.textContent === '권한 요청')), true);
    assert.equal(await page.$$eval('.ag-tool-outcome-text', (results) => results.some((result) => result.textContent === '허용 대기')), true);
  }
  await page.goto(`${origin}/?reset=1&theme=light&width=480&scenario=permission&permissionCapability=document-edit`,
    { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview && !document.querySelector('.ag-input').disabled);
  await page.type('.ag-input', '문서 편집 권한을 요청해 줘');
  await page.click('.ag-send');
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning()
    && window.sidebarPreview.snapshot().messagesSent === 1
    && document.querySelector('.ag-tool-row'));
  assert.equal(await page.$('.ag-permission-pill'), null, 'document editing never produces a Chat grant pill');
  assert.equal(await page.evaluate(() => window.sidebarPreview.bridge.getPendingChatPermissionRequest()), null);
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.bridge.getChatPermissionGrants()), []);
  if (screenshot) await screenshot('permission-document-edit-denied');

  await open();
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning());
  const prefs = await page.evaluate(() => localStorage.getItem('rhwp-agent-prefs'));
  const before = await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent);
  await page.click('.ag-permission-grant');
  await page.waitForSelector('.ag-permission-pill[data-status="granted"]');
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.bridge.getChatPermissionGrants()), ['project-edit']);
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent), before, 'grant never sends a prompt');
  assert.equal(await page.evaluate(() => localStorage.getItem('rhwp-agent-prefs')), prefs, 'grant does not save preferences');
  assert.equal(await page.evaluate(() => window.sidebarPreview.bridge.getPermissionProfile()), 'safe');
  if (screenshot) await screenshot('permission-granted');
  await page.evaluate(() => window.sidebarPreview.sidebar.startDraftChat());
  assert.equal(await page.$('.ag-permission-pill'), null, 'new chat hides another chat pill');
  await page.type('.ag-input', '새 채팅에서 작업해 줘');
  await page.click('.ag-send');
  await page.waitForSelector('.ag-permission-grant', { visible: true });
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.bridge.getChatPermissionGrants()), [], 'starting another chat drops grants');

  await open('permissionCapability=local-execution&hold=1');
  await page.click('.ag-permission-grant');
  await page.waitForSelector('.ag-permission-error');
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.bridge.getChatPermissionGrants()), []);
  assert.equal(await page.$eval('.ag-permission-grant', (button) => button.disabled), false, 'busy grant remains clickable');
  assert.equal(await page.evaluate(() => Boolean(window.sidebarPreview.bridge.getPendingChatPermissionRequest())), true);
  if (screenshot) await screenshot('permission-busy');
  await page.evaluate(() => window.sidebarPreview.finishPermissionTurn());
  await page.click('.ag-permission-grant');
  await page.waitForSelector('.ag-permission-pill[data-status="granted"]');
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.bridge.getChatPermissionGrants()), ['local-execution']);
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent), 1, 'busy retry never sends a prompt');

  await open();
  await page.click('.ag-permission-deny');
  await page.waitForSelector('.ag-permission-pill[data-status="denied"]');
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.bridge.getChatPermissionGrants()), []);
  assert.equal(await page.evaluate(() => window.sidebarPreview.bridge.getPendingChatPermissionRequest()), null);

  await open('hold=1');
  await page.click('.ag-send');
  await page.waitForSelector('.ag-permission-pill[data-status="expired"]');
  assert.equal(await page.evaluate(() => window.sidebarPreview.bridge.getPendingChatPermissionRequest()), null);
  assert.equal(await page.$('.ag-permission-grant'), null, 'cancelled request cannot grant');
}
