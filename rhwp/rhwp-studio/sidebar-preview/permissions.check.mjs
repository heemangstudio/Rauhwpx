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

  // 로그인·인증 코드 넘김: 직접 하기는 탭 제어권을 잡고, 완료는 요청을 닫고 턴을 잇는다.
  await page.goto(`${origin}/?reset=1&theme=light&width=480&scenario=sign-in&handoff=code`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview && !document.querySelector('.ag-input').disabled);
  await page.type('.ag-input', '인증 코드를 입력해야 해');
  await page.click('.ag-send');
  await page.waitForSelector('.ag-permission-pill[data-kind="handoff"]', { visible: true });
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning());
  if (screenshot) await screenshot('permission-handoff-code');
  const tabId = await page.evaluate(() => window.sidebarPreview.bridge.getPendingChatPermissionRequest()?.tabId);
  assert.ok(tabId, 'handoff names the browser tab');
  const [takeover, done] = await page.$$('.ag-permission-pill[data-kind="handoff"] .ag-permission-action');
  await takeover.click();
  await page.waitForFunction(async (id) => (await window.sidebarPreview.bridge.requestBrowser('status')).tabs.some((tab) => tab.tabId === id && tab.controller.held), {}, tabId);
  const sent = await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent);
  await done.click();
  await page.waitForSelector('.ag-permission-pill[data-status="granted"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.ag-msg, .ag-assistant, [class*="assistant"]')].some((node) => node.textContent.includes('이어서 진행합니다')));
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent), sent, 'resuming never sends a user message');
  assert.equal(await page.evaluate(async (id) => (await window.sidebarPreview.bridge.requestBrowser('status')).tabs.some((tab) => tab.tabId === id && tab.controller.held), tabId), false, 'done returns the tab to the agent');
  assert.equal(await page.evaluate(() => window.sidebarPreview.bridge.getPendingChatPermissionRequest()), null);
}
