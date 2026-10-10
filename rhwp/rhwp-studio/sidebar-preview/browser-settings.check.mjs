import assert from 'node:assert/strict';

/** Production settings against a fixture broker. Secrets remain on the dedicated channel. */
export async function checkBrowserSettings({ page, origin, screenshot }) {
  await page.goto(`${origin}/?reset=1&theme=light&width=560&page=settings&destination=browser`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#ag-settings-pane-browser .ag-browser-row', { visible: true });
  const click = async (text) => page.evaluate((label) => {
    const button = [...document.querySelectorAll('#ag-settings-pane-browser button')].find(node => node.textContent === label);
    if (!button) throw new Error(`Missing button ${label}`); button.click();
  }, text);
  const before = await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent);
  await click('계정 추가');
  await page.waitForSelector('.ag-browser-account-form');
  assert.equal(await page.$eval('.ag-browser-account-form input[type=password]', input => input.type), 'password');
  await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('.ag-browser-account-form input')];
    inputs[0].value = 'https://example.com/path'; inputs[2].value = '연구 계정'; inputs[3].value = 'researcher'; inputs[4].value = 'fixture-private-password';
  });
  await page.click('.ag-browser-account-form button[type=submit]');
  await page.waitForFunction(() => document.querySelector('.ag-browser-account-form .ag-browser-message')?.textContent.includes('저장하지 못'));
  assert.equal(await page.$eval('.ag-browser-account-form input[type=password]', input => input.value), '', 'failed submission clears password');
  await page.evaluate(() => { document.querySelector('.ag-browser-account-form input[type=url]').value = 'https://example.com'; document.querySelector('.ag-browser-account-form input[type=password]').value = 'fixture-private-password'; });
  await page.click('.ag-browser-account-form button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('.ag-browser-account-form') && document.querySelector('#ag-settings-pane-browser').textContent.includes('연구 계정'));
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent), before, 'saving account never sends chat text');
  assert.equal(await page.evaluate(() => JSON.stringify(window.sidebarPreview.snapshot()).includes('fixture-private-password')), false, 'snapshot never retains secret');
  assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => String(value).includes('fixture-private-password'))), false, 'secret never enters localStorage');
  if (screenshot) await screenshot('browser-settings-accounts');
  await click('Google 계정 연결');
  await page.waitForSelector('.ag-browser-account-form');
  assert.equal(await page.$('.ag-browser-account-form input[type=password]'), null, 'manual sign-in registers an account without collecting a password');
  await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('.ag-browser-account-form input')];
    inputs[2].value = 'Google 새 로그인'; inputs[3].value = 'google-owner';
  });
  await page.click('.ag-browser-account-form button[type=submit]');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().browser.signIns?.length === 1);
  const signIn = await page.evaluate(() => window.sidebarPreview.snapshot().browser.signIns[0]);
  const savedSession = await page.evaluate(() => window.sidebarPreview.snapshot().browser.accounts.find(account => account.label === 'Google 새 로그인'));
  assert.equal(signIn.accountId, savedSession.id, 'full browser sign-in is bound to the newly approved account');
  assert.equal(savedSession.hasPassword, false);
  assert.deepEqual(savedSession.origins, ['https://accounts.google.com', 'https://www.google.com', 'https://docs.google.com', 'https://drive.google.com']);
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.ag-browser-row')];
    const chosen = rows.find(row => row.textContent.includes('Google 새 로그인'));
    const other = rows.find(row => row.textContent.includes('Google 연구'));
    return [...chosen.querySelectorAll('button')].find(button => button.textContent === '로그인 확인')?.disabled === false
      && [...other.querySelectorAll('button')].find(button => button.textContent === '로그인 확인')?.disabled === true;
  });
  if (screenshot) await screenshot('browser-settings-sign-in-pending');
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.ag-browser-row')].find(row => row.textContent.includes('Google 새 로그인'));
    [...row.querySelectorAll('button')].find(button => button.textContent === '로그인 확인').click();
  });
  await page.waitForFunction(() => window.sidebarPreview.snapshot().browser.accounts.find(account => account.label === 'Google 새 로그인')?.sessionStatus === 'authenticated');
  const blocked = await page.evaluate(async () => {
    try { await window.sidebarPreview.bridge.requestBrowser('sign-in', { url: 'https://accounts.google.com/' }); return false; }
    catch { return true; }
  });
  assert.equal(blocked, true, 'a URL-only sign-in cannot open an unbound shared profile');
  if (screenshot) await screenshot('browser-settings-sign-in');

  await click('승인된 권한');
  await page.waitForSelector('.ag-browser-settings-body .ag-browser-check input');
  await page.click('.ag-browser-settings-body .ag-browser-check input');
  await page.waitForFunction(() => !document.querySelector('.ag-browser-settings-body .ag-browser-check input').checked);
  await click('새로고침');
  await page.waitForFunction(() => !document.querySelector('.ag-browser-message')?.textContent.includes('불러오는'));
  assert.equal(await page.$eval('.ag-browser-settings-body .ag-browser-check input', input => input.checked), false, 'revoked default survives refresh');
  if (screenshot) await screenshot('browser-settings-permissions');
  await click('구성');
  await page.waitForSelector('.ag-browser-settings-body input[type=number]');
  await page.$eval('.ag-browser-settings-body input[type=number]', input => { input.value = '32'; });
  await click('구성 저장');
  await page.waitForFunction(() => document.querySelector('.ag-browser-settings-body input[type=number]')?.value === '32' && !document.querySelector('.ag-browser-message')?.textContent.includes('불러오는'));
  await click('새로고침');
  await page.waitForFunction(() => !document.querySelector('.ag-browser-message')?.textContent.includes('불러오는'));
  assert.equal(await page.$eval('.ag-browser-settings-body input[type=number]', input => input.value), '32');
  if (screenshot) await screenshot('browser-settings-configuration');
  const pillChecks = await page.evaluate(async () => {
    const { createChatPermissionController } = await import('/src/ui/agent-sidebar/chat-permission-pill.ts');
    let context = { threadId: 'secret-chat', documentId: null }; let ordinary = 0; let secure = 0;
    const controller = createChatPermissionController({ context: () => context, respond: () => { ordinary++; return 'ordinary'; }, requestBrowser: async () => ({ requestId: 'pending' }), submitBrowserAccount: async () => { secure++; return {}; } });
    const root = controller.request({ requestId: 'save-pending', threadId: 'secret-chat', documentId: null, turnId: 'turn', agent: 'codex', capability: 'browser', kind: 'browser-save-account', origin: 'https://example.org', accountLabel: 'Private', reason: 'Save requested account', createdAt: new Date().toISOString() });
    document.body.append(root);
    const form = root.querySelector('form'); const inputs = [...form.querySelectorAll('input')]; inputs[3].value = 'user'; inputs[4].value = 'pill-private-value';
    context = { threadId: 'other-chat', documentId: null }; form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0)); const blockedOtherChat = secure === 0 && ordinary === 0;
    context = { threadId: 'secret-chat', documentId: null }; form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0)); const dedicated = secure === 1 && ordinary === 0 && !root.querySelector('input[type=password]');
    controller.dispose();
    return { blockedOtherChat, dedicated };
  });
  assert.equal(pillChecks.blockedOtherChat, true, 'a hidden account request cannot submit from another chat');
  assert.equal(pillChecks.dedicated, true, 'account pill uses secure submission and removes secret fields after success');
  const policyBeforeReset = await page.evaluate(() => window.sidebarPreview.snapshot().browser.defaults);
  const messagesBeforeReset = await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent);
  await click('브라우저 계정과 기록 삭제');
  await page.waitForSelector('.ag-sheet-open .ag-sheet[role=alertdialog]', { visible: true });
  assert.match(await page.$eval('.ag-sheet-message', element => element.textContent), /다운로드한 PDF, 프로젝트, AI 제공자 인증 정보/);
  if (screenshot) await screenshot('browser-settings-reset-confirm');
  await page.click('.ag-sheet-cancel');
  await page.waitForFunction(() => !document.querySelector('.ag-sheet-layer'));
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().browser.resetCount), 0, 'cancel never invokes browser cleanup');
  await page.evaluate(() => {
    const original = window.sidebarPreview.bridge.requestBrowser.bind(window.sidebarPreview.bridge); let failOnce = true;
    window.sidebarPreview.bridge.requestBrowser = (action, args) => {
      if (action === 'reset-browser' && failOnce) { failOnce = false; return Promise.reject(new Error('fixture cleanup interrupted')); }
      return original(action, args);
    };
  });
  await click('브라우저 계정과 기록 삭제'); await page.waitForSelector('.ag-sheet-open .ag-sheet[role=alertdialog]', { visible: true }); await page.click('.ag-sheet-confirm');
  await page.waitForFunction(() => document.querySelector('.ag-browser-message')?.textContent.includes('모두 삭제하지 못'));
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().browser.resetCount), 0);
  await page.waitForFunction(() => !document.querySelector('.ag-sheet-layer'));
  await click('계정과 기록 삭제 다시 시도'); await page.waitForSelector('.ag-sheet-open .ag-sheet[role=alertdialog]', { visible: true }); await page.click('.ag-sheet-confirm');
  await page.waitForFunction(() => document.querySelector('.ag-browser-message')?.textContent.includes('삭제했습니다'));
  const reset = await page.evaluate(() => window.sidebarPreview.snapshot().browser);
  assert.equal(reset.resetCount, 1); assert.equal(reset.accounts.length, 0); assert.equal(reset.tabs.length, 0); assert.equal(reset.signIns.length, 0);
  assert.deepEqual(reset.defaults, policyBeforeReset, 'research policy is retained by browser cleanup');
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent), messagesBeforeReset, 'cleanup never sends an ordinary chat prompt');
  const agentReset = await page.evaluate(async () => {
    const { createPreviewBrowser } = await import('/src/sidebar-preview/mock-browser.ts');
    const browser = createPreviewBrowser(() => {}, () => 'agent-chat', () => null);
    try { await browser.requestAsAgent('reset-browser'); return { rejected: false }; }
    catch (error) { return { rejected: error.code === 'BROWSER_HUMAN_REQUIRED', accounts: browser.snapshot().accounts.length, resetCount: browser.snapshot().resetCount }; }
  });
  assert.deepEqual(agentReset, { rejected: true, accounts: 1, resetCount: 0 }, 'agent actor cannot reset browser data');
  if (screenshot) await screenshot('browser-settings-reset');


}
