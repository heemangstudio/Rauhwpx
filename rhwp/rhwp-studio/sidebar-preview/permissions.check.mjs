import assert from 'node:assert/strict';

/** Fixture-backed production request cards; no provider credentials. */
export async function checkChatPermissions(page, origin, screenshot) {
  async function open(query = '') {
    await page.goto(`${origin}/?reset=1&theme=light&width=480&scenario=permission&${query}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.sidebarPreview && !document.querySelector('.ag-input').disabled);
    await page.type('.ag-input', '요청한 작업을 진행해 줘');
    await page.click('.ag-send');
    await page.waitForSelector('.ag-request-card .ag-request-primary', { visible: true });
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
  assert.equal(await page.$('.ag-request-card'), null, 'document editing never produces a Chat grant card');
  assert.equal(await page.evaluate(() => window.sidebarPreview.bridge.getPendingChatPermissionRequest()), null);
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.bridge.getChatPermissionGrants()), []);
  if (screenshot) await screenshot('permission-document-edit-denied');

  await open();
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning());
  const prefs = await page.evaluate(() => localStorage.getItem('rhwp-agent-prefs'));
  const before = await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent);
  await page.click('.ag-request-card .ag-request-primary');
  await page.waitForSelector('.ag-request-card[data-status="granted"]');
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.bridge.getChatPermissionGrants()), ['project-edit']);
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent), before, 'grant never sends a prompt');
  assert.equal(await page.evaluate(() => localStorage.getItem('rhwp-agent-prefs')), prefs, 'grant does not save preferences');
  assert.equal(await page.evaluate(() => window.sidebarPreview.bridge.getPermissionProfile()), 'safe');
  if (screenshot) await screenshot('permission-granted');
  await page.evaluate(() => window.sidebarPreview.sidebar.startDraftChat());
  assert.equal(await page.$('.ag-request-card'), null, 'new chat hides another chat card');
  await page.type('.ag-input', '새 채팅에서 작업해 줘');
  await page.click('.ag-send');
  await page.waitForSelector('.ag-request-card .ag-request-primary', { visible: true });
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.bridge.getChatPermissionGrants()), [], 'starting another chat drops grants');

  await open('permissionCapability=local-execution&hold=1');
  await page.click('.ag-request-card .ag-request-primary');
  await page.waitForSelector('.ag-request-error');
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.bridge.getChatPermissionGrants()), []);
  assert.equal(await page.$eval('.ag-request-card .ag-request-primary', (button) => button.disabled), false, 'busy grant remains clickable');
  assert.equal(await page.evaluate(() => Boolean(window.sidebarPreview.bridge.getPendingChatPermissionRequest())), true);
  if (screenshot) await screenshot('permission-busy');
  await page.evaluate(() => window.sidebarPreview.finishPermissionTurn());
  await page.click('.ag-request-card .ag-request-primary');
  await page.waitForSelector('.ag-request-card[data-status="granted"]');
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.bridge.getChatPermissionGrants()), ['local-execution']);
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent), 1, 'busy retry never sends a prompt');

  await open();
  await page.click('.ag-request-card .ag-request-close');
  await page.waitForSelector('.ag-request-card[data-status="denied"]');
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.bridge.getChatPermissionGrants()), []);
  assert.equal(await page.evaluate(() => window.sidebarPreview.bridge.getPendingChatPermissionRequest()), null);

  await open('hold=1');
  await page.click('.ag-send');
  await page.waitForSelector('.ag-request-card[data-status="expired"]');
  assert.equal(await page.evaluate(() => window.sidebarPreview.bridge.getPendingChatPermissionRequest()), null);
  assert.equal(await page.$('.ag-request-card .ag-request-primary'), null, 'cancelled request cannot grant');

  // 로그인·인증 코드 넘김: 직접 하기는 탭 제어권을 잡고, 완료는 요청을 닫고 턴을 잇는다.
  await page.goto(`${origin}/?reset=1&theme=light&width=480&scenario=sign-in&handoff=code`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview && !document.querySelector('.ag-input').disabled);
  await page.type('.ag-input', '인증 코드를 입력해야 해');
  await page.click('.ag-send');
  await page.waitForSelector('.ag-request-card[data-kind="browser-code"]', { visible: true });
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning());
  if (screenshot) await screenshot('permission-handoff-code');
  const tabId = await page.evaluate(() => window.sidebarPreview.bridge.getPendingChatPermissionRequest()?.tabId);
  assert.ok(tabId, 'handoff names the browser tab');
  // 작업 공간이 미리 본 탭의 화면과 사이트 아이콘이 카드에 실린다.
  await page.waitForSelector('.ag-request-card[data-kind="browser-code"] .ag-request-thumb img');
  assert.equal(await page.$eval('.ag-request-card[data-kind="browser-code"] .ag-request-head .ag-site-mark', (mark) => mark.dataset.icon), 'true');
  const takeover = await page.$('.ag-request-card[data-kind="browser-code"] .ag-request-secondary');
  await takeover.click();
  await page.waitForFunction(async (id) => (await window.sidebarPreview.bridge.requestBrowser('status')).tabs.some((tab) => tab.tabId === id && tab.controller.held), {}, tabId);
  const sent = await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent);
  await page.waitForSelector('.ag-request-card[data-kind="browser-code"] .ag-request-chip[data-holding="true"]');
  await page.click('.ag-request-card[data-kind="browser-code"] .ag-request-primary');
  await page.waitForSelector('.ag-request-card[data-status="granted"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.ag-msg, .ag-assistant, [class*="assistant"]')].some((node) => node.textContent.includes('이어서 진행합니다')));
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent), sent, 'resuming never sends a user message');
  assert.equal(await page.evaluate(async (id) => (await window.sidebarPreview.bridge.requestBrowser('status')).tabs.some((tab) => tab.tabId === id && tab.controller.held), tabId), false, 'done returns the tab to the agent');
  assert.equal(await page.evaluate(() => window.sidebarPreview.bridge.getPendingChatPermissionRequest()), null);

  await checkRequestScopes(page, origin);
  await checkSecretCards(page, origin, screenshot);
  await checkConcurrentRequests(page, origin, screenshot);
}

async function start(page, origin, query) {
  await page.goto(`${origin}/?reset=1&theme=light&width=480&${query}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview && !document.querySelector('.ag-input').disabled);
  await page.type('.ag-input', '요청한 작업을 진행해 줘');
  await page.click('.ag-send');
  await page.waitForSelector('.ag-request-card .ag-request-primary', { visible: true });
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning());
}

/** 고른 범위가 응답에 실리고, 항상 허용은 설정의 목록에 남는다. */
async function checkRequestScopes(page, origin) {
  await start(page, origin, 'scenario=permission');
  await page.click('.ag-request-scope-option[data-scope="always"]');
  await page.click('.ag-request-card .ag-request-primary');
  await page.waitForSelector('.ag-request-card[data-status="granted"]');
  const snapshot = await page.evaluate(() => window.sidebarPreview.snapshot());
  assert.equal(snapshot.permissionResponses.at(-1).scope, 'always');
  assert.deepEqual(snapshot.alwaysGrants, ['project-edit']);

  await start(page, origin, 'scenario=secret-use');
  await page.click('.ag-request-card .ag-request-primary');
  await page.waitForSelector('.ag-request-card[data-status="granted"]');
  const approval = (await page.evaluate(() => window.sidebarPreview.snapshot())).requestActions.at(-1);
  assert.equal(approval.action, 'secrets.approve');
  assert.equal(approval.scope, 'chat', 'the first offered scope is the default');
}

/** 비밀 값은 submitSecret 의 인자로만 나가고 화면·저장소·메시지·스냅샷 어디에도 남지 않는다. */
async function checkSecretCards(page, origin, screenshot) {
  const secret = 'fixture-secret-value-4815162342';
  const leaks = () => page.evaluate((value) => {
    const inputs = [...document.querySelectorAll('input, textarea')].map((node) => node.value).join('\n');
    const storage = [localStorage, sessionStorage].map((store) => Object.keys(store).map((key) => store.getItem(key)).join('\n')).join('\n');
    return {
      dom: document.documentElement.outerHTML.includes(value),
      inputs: inputs.includes(value),
      storage: storage.includes(value),
      snapshot: JSON.stringify(window.sidebarPreview.snapshot()).includes(value),
    };
  }, secret);
  const clean = { dom: false, inputs: false, storage: false, snapshot: false };

  // 실패하면 입력란이 비고 값은 어디에도 남지 않는다.
  await start(page, origin, 'scenario=secret&requestFail=1');
  await page.type('.ag-request-secret input', secret);
  await page.click('.ag-request-card .ag-request-primary');
  await page.waitForSelector('.ag-request-error');
  assert.equal(await page.$eval('.ag-request-secret input', (input) => input.value), '', 'failed submit clears the value');
  assert.deepEqual(await leaks(), clean);

  // 거절해도 입력한 값을 지운다.
  await start(page, origin, 'scenario=secret');
  await page.type('.ag-request-secret input', secret);
  await page.click('.ag-request-card .ag-request-close');
  await page.waitForSelector('.ag-request-card[data-status="denied"]');
  assert.deepEqual(await leaks(), clean);

  await start(page, origin, 'scenario=secret');
  await page.evaluate(() => {
    const bridge = window.sidebarPreview.bridge; const submit = bridge.submitSecret.bind(bridge);
    window.secretPayloads = [];
    bridge.submitSecret = (args) => { window.secretPayloads.push({ ...args }); return submit(args); };
  });
  await page.$eval('.ag-request-form input[aria-label="이름"]', (input) => { input.value = ''; });
  await page.type('.ag-request-form input[aria-label="이름"]', '데이터 포털 키');
  await page.type('.ag-request-secret input', secret);
  assert.equal(await page.$eval('.ag-request-secret input', (input) => input.type), 'password', 'the value is masked');
  await page.click('.ag-request-reveal');
  assert.equal(await page.$eval('.ag-request-secret input', (input) => input.type), 'text');
  await page.click('.ag-request-scope-option[data-scope="chat"]');
  await page.focus('.ag-request-secret input');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.ag-request-card[data-status="granted"]');
  const payloads = await page.evaluate(() => window.secretPayloads.splice(0));
  assert.equal(payloads.length, 1, 'the value goes out once, on the dedicated channel');
  assert.equal(payloads[0].value, secret);
  assert.equal(payloads[0].label, '데이터 포털 키');
  assert.equal(payloads[0].scope, 'chat');
  assert.deepEqual(await leaks(), clean);
  const sent = await page.evaluate(() => window.sidebarPreview.snapshot());
  assert.deepEqual(sent.secretSubmissions.map(({ label, scope, valueLength }) => ({ label, scope, valueLength })),
    [{ label: '데이터 포털 키', scope: 'chat', valueLength: secret.length }]);
  if (screenshot) await screenshot('permission-secret-saved');
}

/** 한 채팅의 요청 여럿이 따로 보이고 따로 정착하며, 재연결 뒤에도 열린 채로 남는다. */
async function checkConcurrentRequests(page, origin, screenshot) {
  await start(page, origin, 'scenario=requests');
  await page.waitForFunction(() => document.querySelectorAll('.ag-request-card[data-status="pending"]').length === 3);
  await page.evaluate(() => window.sidebarPreview.reconnect());
  await page.waitForFunction(() => window.sidebarPreview.bridge.getConnectionState() === 'connected');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await page.$$eval('.ag-request-card[data-status="pending"]', (cards) => cards.length), 3, 'cards survive a reconnect while the hub still lists them');
  assert.equal(await page.$$eval('.ag-request-card', (cards) => cards.length), 3, 'replayed requests reuse their cards');
  await page.click('.ag-request-card[data-kind="secret-use"] .ag-request-primary');
  await page.waitForSelector('.ag-request-card[data-kind="secret-use"][data-status="granted"]');
  assert.deepEqual(await page.$$eval('.ag-request-card', (cards) => cards.map((card) => `${card.dataset.kind}:${card.dataset.status}`)),
    ['permission:pending', 'secret-use:granted', 'browser-code:pending']);
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning());
  await page.click('.ag-request-card[data-kind="permission"] .ag-request-close');
  await page.waitForSelector('.ag-request-card[data-kind="permission"][data-status="denied"]');
  const pending = await page.evaluate(() => window.sidebarPreview.snapshot().pendingRequests.map((request) => request.kind));
  assert.deepEqual(pending, ['browser-code'], 'each card resolves only its own request');
  assert.equal(await page.$eval('.ag-request-card[data-kind="browser-code"]', (card) => card.dataset.status), 'pending');
  if (screenshot) await screenshot('permission-concurrent');
  await page.evaluate(() => window.sidebarPreview.expireRequests());
  await page.waitForSelector('.ag-request-card[data-kind="browser-code"][data-status="expired"]');
}
