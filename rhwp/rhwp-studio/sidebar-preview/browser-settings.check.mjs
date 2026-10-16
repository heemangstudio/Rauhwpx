import assert from 'node:assert/strict';

/** Production settings against a fixture broker. Secrets remain on the dedicated channel. */
export async function checkBrowserSettings({ page, origin, screenshot }) {
  await page.goto(`${origin}/?reset=1&theme=light&width=560&page=settings&destination=browser`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#ag-settings-pane-browser .ag-browser-account-option', { visible: true });
  /** 이름(글자 또는 aria-label)으로 설정 안의 버튼을 누른다. 아이콘 버튼은 aria-label 로 찾는다. */
  const click = async (text) => page.evaluate((label) => {
    const button = [...document.querySelectorAll('#ag-settings-pane-browser button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label);
    if (!button) throw new Error(`Missing button ${label}`); button.click();
  }, text);
  /** '+' 메뉴를 열고 항목을 고른다. */
  const add = async (label) => {
    await page.click('#ag-settings-pane-browser .ag-browser-add-btn');
    await page.waitForSelector('.ag-browser-add-menu:not([hidden])');
    await page.evaluate((text) => [...document.querySelectorAll('.ag-browser-add-item')].find(item => item.textContent === text).click(), label);
  };
  const detailButton = (label) => page.evaluate((text) => {
    const button = [...document.querySelectorAll('.ag-browser-account-detail button')].find(node => node.getAttribute('aria-label') === text);
    return button ? { disabled: button.disabled, title: button.title } : null;
  }, label);
  const confirmSheetNow = async () => { await page.waitForSelector('.ag-sheet-open .ag-sheet', { visible: true }); await page.click('.ag-sheet-confirm'); await page.waitForFunction(() => !document.querySelector('.ag-sheet-layer')); };
  const independentTabs = await page.evaluate(async () => {
    const { createBrowserSettingsPane } = await import('/src/ui/agent-sidebar/browser-settings.ts');
    const options = { request: async () => ({}), submit: async () => ({}), isConnected: () => false };
    const first = createBrowserSettingsPane(options); const second = createBrowserSettingsPane(options);
    document.body.append(first.element, second.element);
    const selectedTab = first.element.querySelector('[role=tab][aria-selected=true]');
    selectedTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const roots = [first.element, second.element];
    const ids = roots.flatMap(root => [...root.querySelectorAll('[id]')].map(node => node.id));
    const result = {
      unique: ids.length === new Set(ids).size,
      linked: roots.every(root => {
        const panel = root.querySelector('[role=tabpanel]'); const tab = root.querySelector('[role=tab][aria-selected=true]');
        return tab.getAttribute('aria-controls') === panel.id && panel.getAttribute('aria-labelledby') === tab.id;
      }),
      independent: first.element.querySelector('[role=tab][aria-selected=true]').textContent === '승인된 권한'
        && second.element.querySelector('[role=tab][aria-selected=true]').textContent === '계정',
    };
    first.dispose(); second.dispose(); return result;
  });
  assert.deepEqual(independentTabs, { unique: true, linked: true, independent: true }, 'coexisting panes keep independent keyboard navigation and accessibility references');

  // '+' 메뉴와 종류 필터는 키보드로 다룰 수 있다.
  await page.focus('#ag-settings-pane-browser .ag-browser-add-btn');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'menuitem', 'ArrowDown opens the add menu on its first item');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '비밀번호 추가');
  await page.keyboard.press('Escape');
  assert.deepEqual(await page.evaluate(() => ({ hidden: document.querySelector('.ag-browser-add-menu').hidden, back: document.activeElement?.classList.contains('ag-browser-add-btn') })), { hidden: true, back: true }, 'Escape closes the menu and returns focus to +');
  await page.focus('.ag-browser-kind[aria-checked="true"]');
  await page.keyboard.press('ArrowRight');
  assert.deepEqual(await page.evaluate(() => ({ kind: document.querySelector('.ag-browser-kind[aria-checked="true"]').dataset.kind, focused: document.activeElement?.dataset.kind })), { kind: 'sessions', focused: 'sessions' }, 'arrow keys move the kind filter and keep focus on it');
  await page.keyboard.press('Home');

  const before = await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent);
  await add('비밀번호 추가');
  await page.waitForSelector('.ag-browser-flow .ag-browser-account-form');
  assert.equal(await page.$eval('.ag-browser-account-form input[type=password]', input => input.type), 'password');
  assert.equal(await page.$('.ag-browser-account-option'), null, 'the form takes the list\'s place');
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
  await add('계정 연결');
  await page.waitForSelector('.ag-browser-account-form');
  assert.equal(await page.$('.ag-browser-account-form input[type=password]'), null, 'manual sign-in registers an account without collecting a password');
  await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('.ag-browser-account-form input')];
    inputs[0].value = 'https://accounts.google.com'; inputs[1].value = 'https://www.google.com, https://docs.google.com, https://drive.google.com'; inputs[2].value = 'Google 새 로그인'; inputs[3].value = 'google-owner';
  });
  await page.click('.ag-browser-account-form button[type=submit]');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().browser.signIns?.length === 1);
  const signIn = await page.evaluate(() => window.sidebarPreview.snapshot().browser.signIns[0]);
  const savedSession = await page.evaluate(() => window.sidebarPreview.snapshot().browser.accounts.find(account => account.label === 'Google 새 로그인'));
  assert.equal(signIn.accountId, savedSession.id, 'full browser sign-in is bound to the newly approved account');
  assert.equal(savedSession.hasPassword, false);
  assert.deepEqual(savedSession.origins, ['https://accounts.google.com', 'https://www.google.com', 'https://docs.google.com', 'https://drive.google.com']);
  await page.waitForFunction(() => {
    const chosen = document.querySelector('.ag-browser-account-detail');
    const confirm = [...(chosen?.querySelectorAll('button') ?? [])].find(button => button.getAttribute('aria-label') === '로그인 확인');
    return chosen?.textContent.includes('Google 새 로그인') && confirm?.disabled === false && confirm.textContent === '로그인 확인';
  });
  assert.equal(await page.$$eval('.ag-browser-account-detail .ag-browser-site-chip', chips => chips.length), 4, 'every allowed site is shown as a chip');
  const chooseAccount = async (id) => page.evaluate((accountId) => {
    [...document.querySelectorAll('.ag-browser-account-option')].find(button => button.dataset.accountId === accountId).click();
  }, id);
  await chooseAccount('google');
  assert.equal((await detailButton('로그인 확인')).disabled, true, 'another account cannot confirm the pending login');
  await chooseAccount(savedSession.id);
  await click('새로고침');
  await page.waitForFunction((id) => document.querySelector('.ag-browser-account-detail')?.dataset.accountId === id && !document.querySelector('.ag-browser-message')?.textContent.includes('불러오는'), {}, savedSession.id);
  assert.equal(await page.$eval('.ag-browser-account-option[aria-pressed=true]', button => button.dataset.accountId), savedSession.id, 'refresh preserves selected account');
  if (screenshot) await screenshot('browser-settings-sign-in-pending');
  await click('로그인 확인');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().browser.accounts.find(account => account.label === 'Google 새 로그인')?.sessionStatus === 'authenticated');
  await page.waitForFunction((id) => document.querySelector(`.ag-browser-account-option[data-account-id="${id}"] .ag-browser-presence`)?.dataset.state === 'on', {}, savedSession.id);
  const blocked = await page.evaluate(async () => {
    try { await window.sidebarPreview.bridge.requestBrowser('sign-in', { url: 'https://accounts.google.com/' }); return false; }
    catch { return true; }
  });
  assert.equal(blocked, true, 'a URL-only sign-in cannot open an unbound shared profile');
  if (screenshot) await screenshot('browser-settings-sign-in');

  // 에이전트 사용 스위치: 끄면 승인을 철회하고 로그인 열기를 막는다. 다시 켜면 허용한다.
  await page.click('.ag-browser-account-detail [role=switch]');
  await page.waitForFunction((id) => window.sidebarPreview.snapshot().browser.accounts.find(account => account.id === id)?.agentReuseApproved === false, {}, savedSession.id);
  await page.waitForFunction(() => document.querySelector('.ag-browser-account-detail [role=switch]')?.getAttribute('aria-checked') === 'false');
  assert.equal((await detailButton('로그인 열기')).disabled, true, 'revoked account cannot open sign-in');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'switch', 'the switch keeps focus across the refresh');
  await page.click('.ag-browser-account-detail [role=switch]');
  await page.waitForFunction((id) => window.sidebarPreview.snapshot().browser.accounts.find(account => account.id === id)?.agentReuseApproved === true, {}, savedSession.id);
  await chooseAccount('google');
  await click('비밀번호 변경');
  await page.waitForSelector('.ag-browser-flow .ag-browser-account-form');
  await page.focus('.ag-browser-account-form input[type=password]');
  await page.keyboard.type('cancelled-private-password');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#ag-settings-pane-browser .ag-browser-account-option');
  assert.equal(await page.$('.ag-browser-account-form'), null, 'Escape discards the credential form');
  assert.equal(await page.evaluate(() => JSON.stringify(window.sidebarPreview.snapshot()).includes('cancelled-private-password')), false);
  await chooseAccount('google');
  await click('계정 삭제');
  await page.waitForSelector('.ag-sheet-open .ag-sheet', { visible: true });
  await page.click('.ag-sheet-cancel');
  await page.waitForFunction(() => !document.querySelector('.ag-sheet-layer'));
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().browser.accounts.some(account => account.id === 'google')), true, 'cancel keeps the account');
  await click('계정 삭제');
  await confirmSheetNow();
  await page.waitForFunction(() => !window.sidebarPreview.snapshot().browser.accounts.some(account => account.id === 'google'));
  await page.waitForFunction(() => document.querySelector('.ag-browser-account-detail')?.dataset.accountId !== 'google');
  assert.equal(await page.$$('.ag-browser-account-detail').then(rows => rows.length), 1, 'deleting selection shows another saved account');

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
    const { createRequestCardController } = await import('/src/ui/agent-sidebar/request-card.ts');
    let context = { threadId: 'secret-chat', documentId: null }; let ordinary = 0; let secure = 0;
    const controller = createRequestCardController({ context: () => context, respond: () => { ordinary++; return 'ordinary'; }, requestBrowser: async () => ({ requestId: 'pending' }), submitBrowserAccount: async () => { secure++; return {}; } });
    const root = controller.request({ requestId: 'save-pending', threadId: 'secret-chat', documentId: null, turnId: 'turn', agent: 'codex', capability: 'browser', kind: 'browser-save-account', origin: 'https://example.org', accountLabel: 'Private', reason: 'Save requested account', createdAt: new Date().toISOString() });
    document.body.append(root);
    const form = root.querySelector('form'); form.querySelector('input[aria-label="로그인 아이디"]').value = 'user'; form.querySelector('input[type=password]').value = 'pill-private-value';
    context = { threadId: 'other-chat', documentId: null }; form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0)); const blockedOtherChat = secure === 0 && ordinary === 0;
    context = { threadId: 'secret-chat', documentId: null }; form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0)); const dedicated = secure === 1 && ordinary === 0 && !root.querySelector('input[type=password]');
    controller.dispose();
    return { blockedOtherChat, dedicated };
  });
  assert.equal(pillChecks.blockedOtherChat, true, 'a hidden account request cannot submit from another chat');
  assert.equal(pillChecks.dedicated, true, 'account card uses secure submission and removes secret fields after success');
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



  // Many-account fixture exercises the production pane and its real selection/search controls.
  await page.goto(`${origin}/?reset=1&controls=0&fullscreen=1&theme=light&page=settings&destination=browser`, { waitUntil: 'networkidle0' });
  await page.evaluate(async () => {
    const { createBrowserSettingsPane } = await import('/src/ui/agent-sidebar/browser-settings.ts');
    const providers = ['https://accounts.google.com', 'https://login.microsoftonline.com', 'https://github.com', 'https://nid.naver.com', 'https://research.example.org'];
    const accounts = Array.from({ length: 20 }, (_, i) => ({ id: `many-${i}`, profileId: 'default', origin: providers[i % providers.length], label: `연구 계정 ${String(i + 1).padStart(2, '0')}`, stableIdentity: i === 19 ? `many-${i}` : `researcher${i + 1}@example.org`, hasPassword: i % 3 === 0, agentReuseApproved: true, sessionStatus: 'authenticated' }));
    accounts.push({ id: 'password-only', profileId: 'default', origin: 'https://archive.example.org', label: '자료실 비밀번호', stableIdentity: 'archive-reader', hasPassword: true, agentReuseApproved: true, sessionStatus: 'saved' });
    const pane = createBrowserSettingsPane({ isConnected: () => true, submit: async () => ({}), request: async (action) => {
      if (action === 'accounts.list') return { accounts, secureStorageAvailable: true };
      if (action === 'policy.list') return { defaults: { browse: true, download: true, researchImport: true }, sites: [] };
      if (action === 'status') return { runtime: { state: 'ready' } };
      return {};
    } });
    document.querySelector('#ag-settings-pane-browser').replaceChildren(pane.element); pane.open();
  });
  await page.waitForFunction(() => document.querySelectorAll('.ag-browser-account-option').length === 21);
  const kind = (id) => page.click(`.ag-browser-kind[data-kind="${id}"]`);
  await kind('sessions');
  assert.equal(await page.$$('.ag-browser-account-option').then(rows => rows.length), 20);
  assert.equal(await page.$('.ag-browser-account-option[data-account-id="password-only"]'), null, 'password-only entries do not masquerade as connected sessions');
  assert.equal(await page.$eval('.ag-browser-account-list', node => node.scrollHeight > node.clientHeight), true, '20 accounts use an independently scrolling list');
  await page.type('.ag-browser-search', 'GitHub');
  assert.equal(await page.$$('.ag-browser-account-option').then(rows => rows.length), 4, 'search matches the provider of every account');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('ag-browser-search')), true, 'typing keeps focus in search');
  await page.$eval('.ag-browser-search', node => { node.value = ''; node.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.type('.ag-browser-search', 'researcher3@');
  assert.equal(await page.$$('.ag-browser-account-option').then(rows => rows.length), 1, 'search matches account identity');
  await page.$eval('.ag-browser-search', node => { node.value = 'missing'; node.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.$$('.ag-browser-account-option').then(rows => rows.length), 0, 'empty search does not leave a stale detail selection');
  assert.deepEqual(await page.evaluate(() => ({ detail: !!document.querySelector('.ag-browser-account-detail'), empty: document.querySelector('.ag-browser-empty-state')?.textContent })), { detail: false, empty: '검색 결과가 없습니다.' });
  await page.$eval('.ag-browser-search', node => { node.value = ''; node.dispatchEvent(new Event('input', { bubbles: true })); node.blur(); });
  assert.equal(await page.$eval('.ag-browser-account-list', node => node.textContent.includes('many-19')), false, 'internal account IDs stay out of provider identities');
  if (screenshot) await screenshot('browser-settings-20-accounts');
  await page.evaluate(() => { const theme = document.querySelector('#theme'); theme.value = 'dark'; theme.dispatchEvent(new Event('change', { bubbles: true })); });
  if (screenshot) await screenshot('browser-settings-20-accounts-dark');
  await page.evaluate(() => { const theme = document.querySelector('#theme'); theme.value = 'light'; theme.dispatchEvent(new Event('change', { bubbles: true })); });
  await kind('passwords');
  await page.click('.ag-browser-account-option[data-account-id="password-only"]');
  assert.equal(await page.$eval('.ag-browser-account-detail', node => node.dataset.accountId), 'password-only', 'password-only record remains manageable in the password list');
  if (screenshot) await screenshot('browser-settings-passwords');
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  if (screenshot) await screenshot('browser-settings-accounts-narrow');
  const overflow = await page.$eval('.ag-browser-settings', node => node.scrollWidth > node.clientWidth + 1);
  assert.equal(overflow, false, 'account settings fit the narrow app viewport');

  const nativeChecks = await page.evaluate(async () => {
    const { createBrowserSettingsPane } = await import('/src/ui/agent-sidebar/browser-settings.ts');
    let supported = false; let profiles = []; let accounts = []; let fail = false; let imported = 0; let removed = []; let hold = false; let releaseImport; let profileReads = 0;
    const approvals = []; const cookieImports = [];
    window.rhwpDesktop = { browser: { passwords: {
      listProfiles: async () => { profileReads++; return { supported, profiles }; },
      list: async () => ({ accounts, secureStorageAvailable: true }),
      importProfile: async ({ profileId }) => {
        if (fail) { fail = false; throw new Error('fixture denial'); }
        if (hold) await new Promise(resolve => { releaseImport = resolve; });
        imported++; accounts = [{ id: 'local-fixture', origin: 'https://fixture.example', origins: ['https://fixture.example'], username: 'fixture-reader', label: 'Fixture account', source: 'chrome', sourceProfile: profileId, profileId: 'native', hasPassword: true, agentReuseApproved: true, sessionStatus: 'saved', updatedAt: '' }];
        return { imported: 1, skipped: 2, unsupported: 3 };
      },
      approve: async ({ id, approved }) => { approvals.push({ id, approved }); accounts = accounts.map(account => account.id === id ? { ...account, agentReuseApproved: approved } : account); return accounts[0]; },
      remove: async ({ id }) => { removed.push(id); accounts = []; return { removed: true }; },
      cookieSites: async () => ({ supported: true, sites: [{ domain: '.fixture.example', count: 4 }, { domain: 'other.example', count: 1 }] }),
      importCookies: async ({ profileId, domains }) => { cookieImports.push({ profileId, domains }); return { imported: 4, skipped: 0, unsupported: 0, domains }; },
    } } };
    let hubCalls = 0;
    const pane = createBrowserSettingsPane({ isConnected: () => false, request: async () => { hubCalls++; return {}; }, submit: async () => { throw new Error('unexpected secret submission'); } });
    document.querySelector('#ag-settings-pane-browser').replaceChildren(pane.element);
    const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
    const buttons = () => [...pane.element.querySelectorAll('button')];
    const named = (label) => buttons().find(button => button.textContent === label || button.getAttribute('aria-label') === label);
    const click = (label) => { const button = named(label); if (!button) throw new Error(label); button.click(); };
    const openImport = () => { pane.element.querySelector('.ag-browser-add-btn').click(); click('Chrome에서 가져오기'); };
    pane.open(); await settle();
    const noManualSecretForm = !named('비밀번호 추가') && !named('비밀번호 변경');
    openImport();
    const unsupported = !pane.element.querySelector('.ag-browser-profiles') && pane.element.textContent.includes('Mac에서');
    supported = true; pane.open(); await settle();
    const empty = pane.element.textContent.includes('프로필이 없습니다');
    profiles = [{ id: 'Profile 1', name: 'Fixture profile' }]; click('다시 확인'); await settle();
    fail = true; pane.element.querySelector('[data-import-kind=passwords]').click(); await settle();
    const retry = pane.element.querySelector('[role=alert]')?.textContent.includes('다시 시도') && named('다시 시도') && !pane.element.querySelector('[data-import-kind=passwords]').disabled;
    hold = true; click('다시 시도'); await settle();
    const loading = pane.element.querySelector('.ag-browser-flow[aria-busy=true]') !== null && pane.element.querySelector('.ag-browser-profile').disabled;
    const readsBeforeReopen = profileReads; pane.open(); await settle();
    const noOverlappingRefresh = readsBeforeReopen === profileReads;
    releaseImport(); await settle();
    const partial = pane.element.textContent.includes('1개 가져옴 · 2개 건너뜀 · 3개 암호화 방식 지원 안 됨');
    const backToPasswords = pane.element.querySelector('.ag-browser-kind[aria-checked=true]')?.dataset.kind === 'passwords';
    const metadata = pane.element.querySelector('.ag-browser-account-detail')?.textContent.includes('fixture-reader') && pane.element.textContent.includes('Profile 1');
    pane.element.querySelector('.ag-browser-account-detail [role=switch]').click(); await settle();
    const switchedOff = pane.element.querySelector('.ag-browser-account-detail [role=switch]').getAttribute('aria-checked') === 'false';
    openImport(); pane.element.querySelector('[data-import-kind=cookies]').click(); await settle();
    const siteLogos = pane.element.querySelectorAll('.ag-browser-cookie-site .ag-site-mark').length;
    const submit = pane.element.querySelector('.ag-browser-cookie-submit'); const submitBlocked = submit.disabled;
    pane.element.querySelector('.ag-browser-cookie-site input').click();
    const submitReady = !submit.disabled; submit.click(); await settle();
    const cookieResult = pane.element.textContent.includes('1개 사이트 가져옴') && !pane.element.querySelector('.ag-browser-flow');
    await pane.element.querySelector('.ag-browser-kind[data-kind=passwords]')?.click();
    click('비밀번호 삭제'); await settle();
    document.querySelector('.ag-sheet-confirm')?.click(); for (let i = 0; i < 6; i++) { await new Promise(resolve => setTimeout(resolve, 0)); await settle(); }
    const deleted = !pane.element.querySelector('[data-account-id="local-fixture"]');
    pane.dispose(); delete window.rhwpDesktop;
    return { noManualSecretForm, noOverlappingRefresh, unsupported, empty, retry: Boolean(retry), partial, backToPasswords, loading, metadata, approvals, switchedOff, siteLogos, submitBlocked, submitReady, cookieImports, cookieResult, imported, removed, deleted, hubCalls };
  });
  assert.deepEqual(nativeChecks, { noManualSecretForm: true, noOverlappingRefresh: true, unsupported: true, empty: true, retry: true, partial: true, backToPasswords: true, loading: true, metadata: true, approvals: [{ id: 'local-fixture', approved: false }], switchedOff: true, siteLogos: 2, submitBlocked: true, submitReady: true, cookieImports: [{ profileId: 'Profile 1', domains: ['.fixture.example'] }], cookieResult: true, imported: 1, removed: ['local-fixture'], deleted: true, hubCalls: 0 }, 'local password controls import metadata, recover from denial, import chosen sign-ins and delete through the native API while offline');

  const passkeyChecks = await page.evaluate(async () => {
    const { createBrowserSettingsPane } = await import('/src/ui/agent-sidebar/browser-settings.ts');
    let supported = false; const signIns = [];
    window.rhwpDesktop = { browser: { passwords: { listProfiles: async () => ({ supported: true, profiles: [] }), list: async () => ({ accounts: [], secureStorageAvailable: true }) } } };
    const pane = createBrowserSettingsPane({ isConnected: () => true, submit: async () => ({}), request: async (action, args) => {
      if (action === 'accounts.list') return { accounts: [{ id: 'passkey-fixture', origin: 'https://fixture.example', label: 'Fixture', hasPassword: false, agentReuseApproved: true, sessionStatus: 'authenticated' }], secureStorageAvailable: true };
      if (action === 'status') return { runtime: { passkeys: { supported, reason: 'signed-chrome-required', provider: 'Google Chrome', requiresUserVerification: true } } };
      if (action === 'sign-in') signIns.push(args);
      return {};
    } });
    document.querySelector('#ag-settings-pane-browser').replaceChildren(pane.element);
    const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
    const passkey = () => [...pane.element.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Chrome에서 Mac 패스키 사용');
    pane.open(); await settle();
    const unavailable = passkey()?.disabled === true;
    const noPasswordChange = ![...pane.element.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === '비밀번호 변경');
    const installChrome = passkey()?.title.includes('공식 Google Chrome을 설치');
    supported = true; pane.open(); await settle();
    passkey().click(); await settle();
    const chromeInstruction = pane.element.querySelector('.ag-browser-message').textContent.includes('Google Chrome');
    pane.dispose(); delete window.rhwpDesktop; return { unavailable, noPasswordChange, installChrome, chromeInstruction, signIns };
  });
  assert.deepEqual(passkeyChecks, { unavailable: true, noPasswordChange: true, installChrome: true, chromeInstruction: true, signIns: [{ accountId: 'passkey-fixture', url: 'https://fixture.example', authenticationMethod: 'mac-passkey' }] }, 'Mac passkey action works only when installed Chrome handoff is available and explains why otherwise');

  const linkedSessionChecks = await page.evaluate(async () => {
    const { createBrowserSettingsPane } = await import('/src/ui/agent-sidebar/browser-settings.ts');
    const source = { id: 'source-default', profileId: 'default', origin: 'https://fixture.example', label: 'Source account', hasPassword: false, agentReuseApproved: true, sessionStatus: 'authenticated' };
    const counterpart = { ...source, id: 'native-session', sourceAccountId: source.id, profileId: 'native' };
    let brokerAccounts = [source]; let confirmed = 0;
    window.rhwpDesktop = { browser: { passwords: {
      listProfiles: async () => ({ supported: true, profiles: [] }),
      list: async () => ({ accounts: [{ ...source, id: 'imported-password', profileId: 'native', sourceAccountId: source.id, username: 'fixture-reader', source: 'chrome', sourceProfile: 'Fixture', hasPassword: true, sessionStatus: 'saved' }], secureStorageAvailable: true }),
    } } };
    const pane = createBrowserSettingsPane({ isConnected: () => true, submit: async () => { throw new Error('unexpected secret form'); }, request: async (action) => {
      if (action === 'accounts.list') return { accounts: brokerAccounts, secureStorageAvailable: true };
      if (action === 'status') return { runtime: { passkeys: { supported: true } } };
      if (action === 'confirm-sign-in') { confirmed++; brokerAccounts = [source, counterpart]; }
      return {};
    } });
    document.querySelector('#ag-settings-pane-browser').replaceChildren(pane.element);
    const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
    const named = (label) => [...pane.element.querySelectorAll('.ag-browser-account-detail button')].find(button => button.getAttribute('aria-label') === label);
    const kind = (id) => pane.element.querySelector(`.ag-browser-kind[data-kind=${id}]`).click();
    pane.open(); await settle(); kind('sessions'); named('로그인 확인').click(); await settle();
    const oneSource = pane.element.querySelectorAll('.ag-browser-account-option').length === 1 && pane.element.querySelector('.ag-browser-account-detail').dataset.accountId === source.id;
    const sessionCount = pane.element.querySelector('.ag-browser-kind[data-kind=sessions]').getAttribute('aria-label');
    const signInAvailable = [named('로그인 열기'), named('Chrome에서 Mac 패스키 사용')].every(button => button && !button.disabled);
    const noSecretForm = !pane.element.querySelector('input[type=password]') && !named('비밀번호 변경');
    brokerAccounts = [counterpart]; pane.open(); await settle();
    const orphanVisible = pane.element.querySelector('.ag-browser-account-option')?.dataset.accountId === counterpart.id;
    const orphanManagement = Boolean(named('계정 삭제')) && !named('비밀번호 삭제');
    kind('passwords');
    const importedVisible = pane.element.querySelector('.ag-browser-account-option')?.dataset.accountId === 'imported-password';
    pane.dispose(); delete window.rhwpDesktop;
    return { confirmed, oneSource, sessionCount, signInAvailable, noSecretForm, orphanVisible, orphanManagement, importedVisible };
  });
  assert.deepEqual(linkedSessionChecks, { confirmed: 1, oneSource: true, sessionCount: '연결된 계정 1', signInAvailable: true, noSecretForm: true, orphanVisible: true, orphanManagement: true, importedVisible: true }, 'confirmed native sessions share the source card while orphan sessions and imported passwords remain manageable');

  // 데스크톱 보관함 미리보기: '+' → Chrome에서 가져오기 → 로그인 → 고른 사이트만 가져온다.
  await page.setViewport({ width: 1300, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${origin}/?reset=1&controls=0&width=380&theme=light&page=settings&destination=browser&vault=1`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.ag-browser-account-option[data-account-id="local-kosis"]', { visible: true });
  await add('Chrome에서 가져오기');
  await page.waitForSelector('.ag-browser-profile');
  await page.click('.ag-browser-profile[data-profile-id="Profile 1"]');
  await page.click('[data-import-kind=cookies]');
  await page.waitForSelector('.ag-browser-cookie-site input');
  await page.click('.ag-browser-cookie-all input');
  if (screenshot) await screenshot('browser-settings-vault-cookies');
  await page.click('.ag-browser-cookie-submit');
  await page.waitForFunction(() => !document.querySelector('.ag-browser-flow'));
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.localPasswords.snapshot().cookieImports), [{ profileId: 'Profile 1', domains: ['.naver.com', 'www.data.go.kr'] }], 'select-all imports every listed site of the chosen profile');

  // 저장한 비밀 값과 항상 허용한 권한: 메타데이터만 보이고, 철회·허용·삭제·해제가 허브에 닿는다.
  await page.goto(`${origin}/?reset=1&controls=0&fullscreen=1&theme=light&page=settings&destination=browser&always=downloads`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#ag-settings-pane-browser .ag-browser-account-option', { visible: true });
  await page.waitForSelector('#ag-settings-pane-browser .ag-browser-account-option .ag-site-mark[data-icon="true"]');
  await page.click('#ag-settings-pane-browser .ag-browser-kind[data-kind="secrets"]');
  await page.waitForSelector('.ag-browser-account-option[data-secret-id="secret-kosis"]');
  await page.click('.ag-browser-account-option[data-secret-id="secret-kosis"]');
  await page.click('.ag-browser-account-detail[data-secret-id="secret-kosis"] [role=switch]');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().secrets.find((secret) => secret.id === 'secret-kosis')?.approved === false);
  await page.waitForFunction(() => document.querySelector('.ag-browser-account-detail[data-secret-id="secret-kosis"] [role=switch]')?.getAttribute('aria-checked') === 'false');
  await page.click('.ag-browser-account-detail[data-secret-id="secret-kosis"] [role=switch]');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().secrets.find((secret) => secret.id === 'secret-kosis')?.approved === true);
  await page.click('.ag-browser-account-option[data-secret-id="secret-notion"]');
  await click('삭제');
  await page.waitForSelector('.ag-sheet-open .ag-sheet', { visible: true });
  await page.click('.ag-sheet-cancel');
  await page.waitForFunction(() => !document.querySelector('.ag-sheet-layer'));
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().secrets.length), 2, 'cancel keeps the secret');
  await click('삭제');
  await confirmSheetNow();
  await page.waitForFunction(() => window.sidebarPreview.snapshot().secrets.every((secret) => secret.id !== 'secret-notion'));
  await page.waitForFunction(() => !document.querySelector('.ag-browser-account-option[data-secret-id="secret-notion"]'));
  if (screenshot) await screenshot('browser-settings-secrets');
  // 다른 곳(채팅 카드, 다른 창)에서 바뀐 비밀 값은 허브의 user-secrets-changed 로 바로 반영된다.
  await page.evaluate(() => window.sidebarPreview.bridge.requestBrowser('secrets.delete', { secretId: 'secret-kosis' }));
  await page.waitForFunction(() => !document.querySelector('.ag-browser-account-option[data-secret-id="secret-kosis"]') && document.querySelector('.ag-browser-kind[data-kind="secrets"]')?.getAttribute('aria-label') === '비밀 값 0');
  await click('승인된 권한');
  await page.waitForFunction(() => [...document.querySelectorAll('#ag-settings-pane-browser h3')].some((title) => title.textContent === '항상 허용한 권한'));
  await click('해제');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().alwaysGrants.length === 0);
  await page.waitForFunction(() => ![...document.querySelectorAll('#ag-settings-pane-browser h3')].some((title) => title.textContent === '항상 허용한 권한'));
}
