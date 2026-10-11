import './browser-settings.css';
import { confirmSheet } from './sheet.ts';

export type BrowserSettingsRequest = (action: string, args?: Record<string, unknown>) => Promise<unknown>;
interface Account { profileId?: string; id: string; origin: string; origins?: string[]; label: string; stableIdentity?: string; hasPassword: boolean; agentReuseApproved: boolean; sessionStatus: string; }
interface Site { id: string; origin: string; label?: string; source: string; allowedActions: string[]; blockedActions: string[]; }
const permissionLabels: Record<string, string> = { browse: '읽기', read: '읽기', download: '다운로드', 'research-import': '자료 추가', 'website-change': '웹사이트 변경', 'account-use': '계정 사용' };
interface Policy { defaults: { browse: boolean; download: boolean; researchImport: boolean }; sites: Site[]; }

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag); element.className = cls;
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(label: string, action: () => void): HTMLButtonElement {
  const result = node('button', 'ag-settings-btn', label); result.type = 'button'; result.addEventListener('click', action); return result;
}
function field(label: string, type = 'text', value = '') {
  const root = node('label', 'ag-settings-field'); root.append(node('span', 'ag-settings-field-label', label));
  const input = node('input', 'ag-settings-input'); input.type = type; input.value = value;
  input.autocomplete = type === 'password' ? 'new-password' : 'off'; input.spellcheck = false; root.append(input); return { root, input };
}

/** 비밀 값은 전용 인증 요청으로만 보내고 저장소와 채팅 메시지에 남기지 않는다. */
export function createBrowserAccountForm(options: {
  submit: (args: Record<string, unknown>) => Promise<unknown>;
  request: BrowserSettingsRequest;
  account?: Partial<Account>;
  requestId?: string;
  sessionOnly?: boolean;
  openSignIn?: boolean;
  canSubmit?(): boolean;
  complete(account?: Account): void;
  cancel(): void;
}) {
  const root = node('form', 'ag-browser-account-form');
  const origin = field('사이트 주소', 'url', options.account?.origin ?? ''); origin.input.required = true;
  const origins = field('함께 사용할 사이트 · 쉼표로 구분', 'text', options.account?.origins?.filter(value => value !== options.account?.origin).join(', ') ?? '');
  if (options.requestId || options.account?.id) origins.input.readOnly = true;
  const label = field('계정 이름', 'text', options.account?.label ?? ''); label.input.required = true;
  const username = field(options.sessionOnly ? '계정 식별자 · 선택' : '로그인 아이디', 'text', options.account?.stableIdentity ?? ''); username.input.required = !options.sessionOnly;
  const password = field('비밀번호', 'password'); password.input.required = true;
  if (options.requestId || options.account?.id) origin.input.readOnly = true;
  const remember = node('label', 'ag-browser-check'); const rememberInput = node('input', ''); rememberInput.type = 'checkbox'; rememberInput.checked = true;
  remember.append(rememberInput, document.createTextNode('앞으로 다른 채팅에서도 이 계정 사용 허용'));
  const message = node('p', 'ag-browser-message'); message.setAttribute('role', 'alert');
  const actions = node('div', 'ag-settings-actions');
  const save = node('button', 'ag-settings-primary', options.openSignIn ? '등록 후 로그인 열기' : options.sessionOnly ? '계정 등록' : options.account?.id ? '비밀번호 변경' : '저장'); save.type = 'submit';
  const clear = () => { password.input.value = ''; username.input.value = ''; };
  actions.append(button('취소', () => { clear(); options.cancel(); }), save);
  root.append(origin.root, origins.root, label.root, username.root); if (!options.sessionOnly) root.append(password.root); else rememberInput.disabled = true; root.append(remember, message, actions);
  let disposed = false;
  root.addEventListener('submit', async (event) => {
    event.preventDefault(); if (save.disabled || disposed || options.canSubmit?.() === false) return;
    message.textContent = ''; save.disabled = true;
    try {
      const parsed = new URL(origin.input.value);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('HTTPS 사이트 주소만 입력하세요.');
      const accountOrigins = [...new Set([parsed.origin, ...origins.input.value.split(',').map(value => value.trim()).filter(Boolean)])];
      for (const value of accountOrigins) { const allowed = new URL(value); if (allowed.protocol !== 'https:' || allowed.origin !== value) throw new Error('사이트 주소 확인 필요'); }
      const approval = options.requestId ? { requestId: options.requestId } : await options.request('accounts.request', { origin: parsed.origin, label: label.input.value.trim(), accountId: options.account?.id, origins: accountOrigins, intent: options.sessionOnly ? 'use' : 'save' }) as { requestId: string };
      if (disposed || options.canSubmit?.() === false) return;
      if (options.sessionOnly) {
        const result = await options.request('accounts.approve', { requestId: approval.requestId, account: { origin: parsed.origin, label: label.input.value.trim(), origins: accountOrigins, ...(username.input.value ? { stableIdentity: username.input.value } : {}) } });
        clear(); if (!disposed) options.complete((result as { account?: Account }).account); return;
      }
      const result = await options.submit({
        accountRequestId: approval.requestId,
        account: { id: options.account?.id, origin: parsed.origin, label: label.input.value.trim(), stableIdentity: username.input.value, origins: accountOrigins },
        username: username.input.value, password: password.input.value, remember: rememberInput.checked, consent: { save: true, use: rememberInput.checked },
      });
      clear(); if (!disposed) options.complete((result as { account?: Account }).account);
    } catch { if (!disposed) message.textContent = '계정을 저장하지 못했습니다. 연결과 사이트 주소를 확인하세요.'; }
    finally { password.input.value = ''; if (!disposed) save.disabled = false; }
  });
  return { element: root, dispose() { disposed = true; clear(); root.remove(); } };
}

export function createBrowserSettingsPane(options: { request: BrowserSettingsRequest; submit: (args: Record<string, unknown>) => Promise<unknown>; isConnected(): boolean }) {
  const element = node('div', 'ag-browser-settings');
  const heading = node('div', 'ag-browser-heading'); heading.append(node('h2', 'ag-settings-section-title', '브라우저'));
  const message = node('p', 'ag-browser-message'); message.setAttribute('role', 'status');
  const refresh = button('새로고침', () => void load()); heading.append(refresh);
  const navigation = node('div', 'ag-browser-tabs'); navigation.setAttribute('role', 'tablist');
  const body = node('div', 'ag-browser-settings-body');
  let active = 'accounts'; let disposed = false; let generation = 0; let busy = false; let resetFailed = false; let resetConfirming = false;
  let accounts: Account[] = []; let secureStorage = false; let policy: Policy | null = null; let configuration: Record<string, unknown> = {}; let status: Record<string, unknown> = {};
  let form: ReturnType<typeof createBrowserAccountForm> | null = null;
  const tabs = new Map<string, HTMLButtonElement>();
  for (const [id, label] of [['accounts', '계정'], ['permissions', '승인된 권한'], ['configuration', '구성']]) {
    const tab = button(label!, () => { clearForm(); active = id!; render(); }); tab.setAttribute('role', 'tab'); tabs.set(id!, tab); navigation.append(tab);
  }
  element.append(heading, navigation, message, body);
  function clearForm() { form?.dispose(); form = null; }
  async function mutate(action: string, args: Record<string, unknown> = {}) {
    if (busy || !options.isConnected()) return; busy = true; message.textContent = ''; render();
    try { await options.request(action, args); await load(); }
    catch (error) { const code = (error as { code?: string })?.code; message.textContent = code === 'BROWSER_RESET_REQUIRED' ? '브라우저 계정과 기록 삭제를 다시 실행해 정리를 마치세요.' : code === 'BROWSER_RESET_ACTIVE' ? '다른 창에서 브라우저 데이터를 정리하는 중입니다. 잠시 뒤 다시 시도하세요.' : code === 'BROWSER_SIGN_IN_ACTIVE' ? '별도 Chromium 창에서 로그인을 마치고 해당 계정의 로그인 확인을 누르세요.' : code === 'BROWSER_ACCOUNT_IDENTITY_MISMATCH' ? '별도 로그인 창에서 선택한 계정의 로그인 확인을 누르세요.' : code === 'BROWSER_ACCOUNT_REGISTRATION_REQUIRED' ? '기본 프로필에 이 사이트의 계정을 등록하고 사용을 허용한 뒤 로그인하세요.' : code === 'BROWSER_TABS_OPEN' ? '열려 있는 브라우저 탭을 닫은 뒤 실행 방식을 바꾸세요.' : code === 'BROWSER_SECURE_STORAGE_UNAVAILABLE' ? '운영체제 보안 저장소를 사용할 수 없습니다. 브라우저 구성에서 상태를 확인하세요.' : '요청을 완료하지 못했습니다. 연결을 확인하고 다시 시도하세요.'; }
    finally { busy = false; if (!disposed) render(); }
  }
  async function resetBrowser() {
    if (busy || resetConfirming || disposed || !options.isConnected()) return;
    resetConfirming = true;
    const confirmed = await confirmSheet(element, '브라우저 계정과 기록 삭제', '저장된 웹사이트 계정과 비밀번호, 로그인 상태, 쿠키, 방문 기록을 삭제합니다. 다운로드한 PDF, 프로젝트, AI 제공자 인증 정보와 연구 권한 설정은 유지됩니다.', { confirmLabel: '계정과 기록 삭제', destructive: true });
    resetConfirming = false;
    if (!confirmed || disposed || !options.isConnected()) return;
    busy = true; resetFailed = false; message.textContent = '브라우저 계정과 기록을 삭제하는 중…'; render();
    try {
      const result = await options.request('reset-browser', {});
      if ((result as { ok?: boolean })?.ok === false) throw new Error('Reset incomplete');
      if (disposed) return;
      clearForm(); accounts = []; await load();
      if (!disposed) message.textContent = '브라우저 계정과 기록을 삭제했습니다.';
    } catch (error) {
      if (!disposed) { await load(); resetFailed = true; const code = (error as { code?: string })?.code; message.textContent = code === 'BROWSER_RESET_ACTIVE' ? '다른 창에서 브라우저 데이터를 정리하는 중입니다. 잠시 뒤 다시 시도하세요.' : code === 'BROWSER_RESET_UNAVAILABLE' ? '브라우저 정리 서비스를 사용할 수 없습니다. 허브 연결을 확인하고 다시 시도하세요.' : '브라우저 계정과 기록을 모두 삭제하지 못했습니다. 다시 시도하세요.'; }
    } finally { busy = false; if (!disposed) render(); }
  }
  async function signIn(account: Account) {
    await mutate('sign-in', { accountId: account.id, url: account.origin });
    if (!message.textContent) message.textContent = '별도로 열린 Chromium 창에서 로그인과 추가 인증을 마친 뒤 이 계정의 로그인 확인을 누르세요.';
  }
  function accountForm(account?: Partial<Account>, sessionOnly = false, openSignIn = false) {
    clearForm(); form = createBrowserAccountForm({ request: options.request, submit: options.submit, canSubmit: options.isConnected, account, sessionOnly, openSignIn, complete: (saved) => { clearForm(); if (openSignIn && saved?.id) void signIn(saved); else void load(); }, cancel: () => { clearForm(); render(); } }); render();
  }
  function row(title: string, detail: string) {
    const root = node('div', 'ag-browser-row'); const copy = node('div', 'ag-browser-row-copy'); copy.append(node('strong', '', title), node('span', '', detail));
    const actions = node('div', 'ag-browser-row-actions'); root.append(copy, actions); body.append(root); return actions;
  }
  function action(actions: HTMLElement, label: string, name: string, args: Record<string, unknown>) { const b = button(label, () => void mutate(name, args)); b.disabled = busy || !options.isConnected(); actions.append(b); }
  function render() {
    if (disposed) return;
    for (const [id, tab] of tabs) { tab.setAttribute('aria-selected', String(id === active)); tab.tabIndex = id === active ? 0 : -1; }
    refresh.disabled = busy || !options.isConnected(); body.replaceChildren(); body.setAttribute('role', 'tabpanel');
    if (!options.isConnected()) { body.append(node('p', 'ag-browser-empty', '허브에 연결하면 브라우저 설정을 관리할 수 있습니다.')); return; }
    if (active === 'accounts') {
      const accountActions = node('div', 'ag-browser-account-actions'); body.append(accountActions);
      const add = button('계정 추가', () => accountForm()); add.disabled = busy || !secureStorage; accountActions.append(add);
      if (!secureStorage) body.append(node('p', 'ag-browser-empty', '보안 저장소를 사용할 수 없습니다. 브라우저 구성에서 상태를 확인하세요.'));
      if (form) { body.append(form.element); return; }
      const retain = button('로그인한 계정 등록', () => accountForm(undefined, true)); retain.disabled = busy; accountActions.append(retain);
      const googleSignIn = button('Google 계정 연결', () => accountForm({ origin: 'https://accounts.google.com', origins: ['https://accounts.google.com', 'https://www.google.com', 'https://docs.google.com', 'https://drive.google.com'], label: 'Google' }, true, true)); googleSignIn.disabled = busy; accountActions.append(googleSignIn);
      const runtime = (status.runtime ?? {}) as Record<string, unknown>;
      const signInState = runtime.signIn as { accountId?: string } | null | undefined;
      if (signInState?.accountId) body.append(node('p', 'ag-browser-empty', `${accounts.find(account => account.id === signInState.accountId)?.label ?? '선택한 계정'}의 별도 Chromium 창에서 로그인한 뒤 로그인 확인을 누르세요.`));
      if (!accounts.length) body.append(node('p', 'ag-browser-empty', '저장된 계정이 없습니다.'));
      for (const account of accounts) {
        const actions = row(account.label || account.origin, `${account.origin} · ${account.agentReuseApproved ? '자동 사용 허용' : '사용 승인 철회'} · ${({ authenticated: '로그인됨', saved: '비밀번호 저장됨', 'session-retained': '로그인 확인 필요', 'signed-out': '로그아웃됨' } as Record<string, string>)[account.sessionStatus] ?? '로그인 상태 확인 필요'}`);
        const login = button('로그인 열기', () => void signIn(account)); login.disabled = busy || Boolean(signInState) || !account.agentReuseApproved || (account.profileId !== undefined && account.profileId !== 'default'); actions.append(login);
        const confirm = button('로그인 확인', () => void mutate('confirm-sign-in', { accountId: account.id })); confirm.disabled = busy || Boolean(signInState?.accountId && signInState.accountId !== account.id); actions.append(confirm);
        const update = button('비밀번호 변경', () => accountForm(account)); update.disabled = busy || !secureStorage; actions.append(update);
        action(actions, account.agentReuseApproved ? '사용 승인 철회' : '사용 허용', account.agentReuseApproved ? 'accounts.revoke' : 'accounts.approve', { accountId: account.id });
        action(actions, '로그아웃', 'accounts.signout', { accountId: account.id });
        action(actions, '계정 삭제', 'accounts.forget', { accountId: account.id });
      }
    } else if (active === 'permissions') {
      if (!policy) { body.append(node('p', 'ag-browser-empty', '권한을 불러오는 중…')); return; }
      for (const [key, label] of [['browse', '공개 연구 페이지 읽기'], ['download', '연구 자료 다운로드'], ['researchImport', '다운로드한 자료를 프로젝트에 추가']]) {
        const root = node('label', 'ag-browser-check'); const input = node('input', ''); input.type = 'checkbox'; input.checked = policy.defaults[key as keyof Policy['defaults']]; input.disabled = busy;
        input.addEventListener('change', () => void mutate('policy.update', { operation: 'set-default', key, enabled: input.checked })); root.append(input, document.createTextNode(label!)); body.append(root);
      }
      if (accounts.length) body.append(node('h3', 'ag-settings-section-title', '계정 사용 승인'));
      for (const account of accounts) {
        const actions = row(account.label || account.origin, `${(account.origins ?? [account.origin]).join(' · ')} · ${account.agentReuseApproved ? '다른 채팅에서도 사용 허용' : '사용 승인 철회'}`);
        action(actions, account.agentReuseApproved ? '사용 승인 철회' : '사용 허용', account.agentReuseApproved ? 'accounts.revoke' : 'accounts.approve', { accountId: account.id });
      }
      body.append(node('h3', 'ag-settings-section-title', '사이트 권한'));
      for (const site of policy.sites) {
        const blocked = site.blockedActions.includes('browse'); const actions = row(site.label || site.origin, `${site.origin} · ${blocked ? '차단됨' : [...new Set(site.allowedActions.map(value => permissionLabels[value] ?? value))].join(' · ') || '기본 정책'}`);
        action(actions, blocked ? '읽기·다운로드 허용' : '사이트 차단', 'policy.update', { operation: 'set-site', origin: site.origin, label: site.label, allowedActions: [...site.allowedActions.filter(value => !['browse', 'read', 'download', 'research-import'].includes(value)), ...(blocked ? ['browse', 'read', 'download', 'research-import'] : [])], blockedActions: [...site.blockedActions.filter(value => !['browse', 'read', 'download', 'research-import'].includes(value)), ...(blocked ? [] : ['browse', 'read', 'download', 'research-import'])] });
        for (const operation of site.allowedActions.filter(value => !['browse', 'read', 'download', 'research-import'].includes(value))) {
          action(actions, `${operation === 'website-change' ? '웹사이트 변경' : operation === 'account-use' ? '계정 사용' : operation} 승인 철회`, 'policy.update', { operation: 'set-site', origin: site.origin, label: site.label, allowedActions: site.allowedActions.filter(value => value !== operation), blockedActions: [...new Set([...site.blockedActions, operation])] });
        }
      }
      const origin = field('사이트 주소', 'url'); origin.input.placeholder = 'https://example.com'; body.append(origin.root);
      const addSite = (allow: boolean) => { try { const url = new URL(origin.input.value); if (url.protocol !== 'https:' || url.origin !== origin.input.value.replace(/\/$/, '')) throw new Error(); void mutate('policy.update', { operation: 'set-site', origin: url.origin, allowedActions: allow ? ['browse', 'read', 'download', 'research-import'] : [], blockedActions: allow ? [] : ['browse', 'read', 'download', 'research-import'] }); } catch { message.textContent = 'HTTPS 사이트 주소를 입력하세요.'; } };
      const actions = node('div', 'ag-settings-actions'); actions.append(button('사이트 허용', () => addSite(true)), button('사이트 차단', () => addSite(false))); body.append(actions);
    } else {
      const runtime = (status.runtime ?? {}) as Record<string, unknown>; const readiness = (runtime.readiness ?? {}) as Record<string, unknown>;
      row('브라우저 상태', ({ ready: '준비됨', stopped: '중지됨', starting: '시작 중', 'sign-in': '별도 창에서 로그인 중', error: '연결 확인 필요' } as Record<string, string>)[String(runtime.state)] ?? '확인 필요'); row('실행 방식', runtime.kind === 'native' ? '앱 내 브라우저' : '로컬 Chromium'); row('로그인 프로필', String(configuration.profileId ?? runtime.profile ?? '기본 프로필'));
      const downloads = (configuration.downloads ?? {}) as Record<string, unknown>; row('다운로드 저장소', String(downloads.directory ?? downloads.path ?? '허브의 관리형 다운로드 저장소'));
      const limit = field('파일당 다운로드 한도 · MB', 'number', String(Math.round(Number(downloads.maxFileBytes ?? 104857600) / 1048576)));
      limit.input.min = '1'; limit.input.max = '512'; limit.input.step = '1'; body.append(limit.root);
      const preview = (configuration.preview ?? {}) as Record<string, unknown>;
      const mode = node('label', 'ag-settings-field'); mode.append(node('span', 'ag-settings-field-label', '브라우저 표시'));
      const select = node('select', 'ag-settings-select');
      for (const [value, label] of [['docked', '작업 공간'], ['floating', '떠 있는 창'], ['popout', '별도 창']]) { const option = node('option', '', label); option.value = value!; select.append(option); }
      select.value = String(preview.mode ?? 'docked'); mode.append(select); body.append(mode);
      const autoImport = node('input', ''); autoImport.type = 'checkbox'; autoImport.checked = downloads.autoImport !== false;
      const autoLabel = node('label', 'ag-browser-check'); autoLabel.append(autoImport, document.createTextNode('다운로드한 자료를 앱에 자동 추가')); body.append(autoLabel);
      const reduced = node('input', ''); reduced.type = 'checkbox'; reduced.checked = preview.reducedMotion === true;
      const reducedLabel = node('label', 'ag-browser-check'); reducedLabel.append(reduced, document.createTextNode('브라우저 움직임 줄이기')); body.append(reducedLabel);
      const apply = button('구성 저장', () => { const mb = Number(limit.input.value); if (!Number.isInteger(mb) || mb < 1 || mb > 512) { message.textContent = '다운로드 한도는 1~512 MB로 입력하세요.'; return; } void mutate('configuration.update', { downloads: { maxFileBytes: mb * 1048576, autoImport: autoImport.checked }, preview: { mode: select.value, reducedMotion: reduced.checked } }); });
      apply.disabled = busy; body.append(apply);
      const security = (configuration.security ?? {}) as Record<string, unknown>;
      row('비밀번호 저장', security.passwords === 'os-vault' ? '운영체제 보안 저장소' : security.passwords === 'encrypted-wrapping-key' ? '암호화된 로컬 저장소' : '보안 저장소 확인 필요');
      const google = (configuration.googleSignIn ?? {}) as Record<string, unknown>;
      row('Google 로그인', google.status === 'requires-compatibility-validation' ? '브라우저에서 직접 로그인 후 확인' : google.status === 'not-verified' ? '로그인 확인 필요' : google.status === 'full-browser-available' ? '브라우저에서 직접 로그인 가능' : String(google.status ?? '브라우저에서 직접 로그인'));
      const diagnostics = node('p', 'ag-browser-empty', String(readiness.message ?? readiness.reason ?? '')); body.append(diagnostics);
      const actions = node('div', 'ag-settings-actions'); action(actions, '브라우저 준비', 'install', {}); action(actions, '진단 새로고침', 'status', {}); body.append(actions);
      const runtimeMode = node('label', 'ag-settings-field'); runtimeMode.append(node('span', 'ag-settings-field-label', '실행 브라우저'));
      const runtimeSelect = node('select', 'ag-settings-select'); for (const [value, label] of [['managed', '로컬 Chromium'], ['native', '앱 내 브라우저']]) { const option = node('option', '', label); option.value = value!; runtimeSelect.append(option); } runtimeSelect.value = runtime.kind === 'native' ? 'native' : 'managed'; runtimeMode.append(runtimeSelect); body.append(runtimeMode);
      body.append(button('실행 방식 적용', () => void mutate('configure', { mode: runtimeSelect.value, headless: true })));
      const cleanup = node('section', 'ag-browser-cleanup'); cleanup.append(node('h3', 'ag-settings-section-title', '브라우저 데이터 삭제'));
      cleanup.append(node('p', 'ag-browser-empty', '앱을 제거하기 전에 저장된 웹사이트 로그인과 방문 기록을 정리할 수 있습니다.'));
      const reset = button(resetFailed ? '계정과 기록 삭제 다시 시도' : '브라우저 계정과 기록 삭제', () => void resetBrowser()); reset.disabled = busy || !options.isConnected(); reset.classList.add('ag-browser-reset'); cleanup.append(reset); body.append(cleanup);

    }
  }
  async function load() {
    if (disposed || !options.isConnected()) { render(); return; } const current = ++generation; message.textContent = '불러오는 중…';
    const results = await Promise.allSettled([options.request('accounts.list'), options.request('policy.list'), options.request('configuration.get'), options.request('status')]);
    if (disposed || generation !== current) return;
    const [a, p, c, s] = results;
    if (a?.status === 'fulfilled') { const value = a.value as { accounts: Account[]; secureStorageAvailable: boolean }; accounts = value.accounts ?? []; secureStorage = value.secureStorageAvailable === true; }
    if (p?.status === 'fulfilled') policy = p.value as Policy;
    if (c?.status === 'fulfilled') configuration = c.value as Record<string, unknown>;
    if (s?.status === 'fulfilled') status = s.value as Record<string, unknown>;
    message.textContent = results.some(result => result.status === 'rejected') ? '일부 설정을 불러오지 못했습니다. 새로고침으로 다시 확인하세요.' : '';
    render();
  }
  render();
  return { element, open() { void load(); }, close() { clearForm(); generation++; render(); }, setConnected() { clearForm(); generation++; render(); }, dispose() { disposed = true; generation++; clearForm(); element.remove(); } };
}
