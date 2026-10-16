import './browser-settings.css';
import { confirmSheet } from './sheet.ts';
import { localPasswordsApi, type LocalPasswordAccount } from './browser-local-passwords.ts';
import { createAdblockSettings } from './browser-adblock-settings.ts';
import { createSiteMark } from './site-mark.ts';
import { CHAT_PERMISSION_LABELS, SECRET_KIND_LABELS, isChatPermissionCapability, readSecretMeta } from '../../agent/chat-permissions.ts';
import type { SecretMeta } from '../../agent/types.ts';

export type BrowserSettingsRequest = (action: string, args?: Record<string, unknown>) => Promise<unknown>;
interface Account { sourceAccountId?: string; profileId?: string; id: string; origin: string; origins?: string[]; label: string; stableIdentity?: string; hasPassword: boolean; agentReuseApproved: boolean; sessionStatus: string; }
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
  /** 채팅 요청 카드 안의 짧은 양식: 사이트는 카드 머리에 보이고, 칸은 자리표시 글자로 이름을 단다. */
  variant?: 'card';
  complete(account?: Account): void;
  cancel(): void;
}) {
  const card = options.variant === 'card';
  const root = node('form', card ? 'ag-browser-account-form ag-request-form' : 'ag-browser-account-form');
  const origin = field('사이트 주소', 'url', options.account?.origin ?? ''); origin.input.required = true;
  const origins = field('함께 사용할 사이트 · 쉼표로 구분', 'text', options.account?.origins?.filter(value => value !== options.account?.origin).join(', ') ?? '');
  if (options.requestId || options.account?.id) origins.input.readOnly = true;
  const label = field('계정 이름', 'text', options.account?.label ?? ''); label.input.required = true;
  const username = field(options.sessionOnly ? '계정 식별자 · 선택' : '로그인 아이디', 'text', options.account?.stableIdentity && options.account.stableIdentity !== options.account.id ? options.account.stableIdentity : ''); username.input.required = !options.sessionOnly;
  const password = field('비밀번호', 'password'); password.input.required = true;
  if (options.requestId || options.account?.id) origin.input.readOnly = true;
  const remember = node('label', 'ag-browser-check'); const rememberInput = node('input', ''); rememberInput.type = 'checkbox'; rememberInput.checked = true;
  remember.append(rememberInput, document.createTextNode(card ? '다른 채팅에서도 사용 허용' : '앞으로 다른 채팅에서도 이 계정 사용 허용'));
  const message = node('p', card ? 'ag-browser-message ag-request-form-message' : 'ag-browser-message'); message.setAttribute('role', 'alert');
  const actions = node('div', card ? 'ag-request-actions' : 'ag-settings-actions');
  const save = node('button', card ? 'ag-request-primary' : 'ag-settings-primary', options.openSignIn ? '등록 후 로그인 열기' : options.sessionOnly ? '계정 등록' : options.account?.id ? '비밀번호 변경' : '저장'); save.type = 'submit';
  const clear = () => { password.input.value = ''; username.input.value = ''; };
  const cancel = button(card ? '저장 안 함' : '취소', () => { clear(); options.cancel(); });
  if (card) cancel.className = 'ag-request-secondary';
  actions.append(cancel, save);
  if (card) {
    for (const [entry, text] of [[label, '계정 이름'], [username, '로그인 아이디'], [password, '비밀번호']] as const) {
      entry.root.classList.add('ag-request-field'); entry.root.querySelector('.ag-settings-field-label')?.remove();
      entry.input.placeholder = text; entry.input.setAttribute('aria-label', text);
    }
    root.append(label.root, username.root);
  } else root.append(origin.root, origins.root, label.root, username.root);
  if (!options.sessionOnly) root.append(password.root); else rememberInput.disabled = true; root.append(remember, message, actions);
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
    } catch { if (!disposed) message.textContent = card ? '저장하지 못했습니다. 다시 시도하세요.' : '계정을 저장하지 못했습니다. 연결과 사이트 주소를 확인하세요.'; }
    finally { password.input.value = ''; if (!disposed) save.disabled = false; }
  });
  return { element: root, clear() { clear(); password.input.value = ''; }, dispose() { disposed = true; clear(); root.remove(); } };
}

function siteHost(origin: string): string { try { return new URL(origin).hostname; } catch { return origin; } }
function visibleIdentity(account: Account): string { return account.stableIdentity && account.stableIdentity !== account.id ? account.stableIdentity : siteHost(account.origin); }
function accountProvider(account: Account): string {
  const host = siteHost(account.origin).toLowerCase();
  for (const [domain, label] of [['google.com', 'Google'], ['microsoft.com', 'Microsoft'], ['microsoftonline.com', 'Microsoft'], ['live.com', 'Microsoft'], ['github.com', 'GitHub'], ['apple.com', 'Apple'], ['naver.com', 'Naver'], ['kakao.com', 'Kakao']]) {
    if (host === domain || host.endsWith(`.${domain}`)) return label!;
  }
  return host;
}
function sessionLabel(account: Account): string { return ({ authenticated: '로그인됨', saved: '비밀번호 저장됨', 'session-retained': '확인 필요', 'signed-out': '로그아웃됨' } as Record<string, string>)[account.sessionStatus] ?? '확인 필요'; }

let browserSettingsSequence = 0;

export function createBrowserSettingsPane(options: { request: BrowserSettingsRequest; submit: (args: Record<string, unknown>) => Promise<unknown>; isConnected(): boolean }) {
  const instanceId = `ag-browser-settings-${++browserSettingsSequence}`;
  const element = node('div', 'ag-browser-settings');
  const heading = node('div', 'ag-browser-heading'); heading.append(node('h2', 'ag-settings-section-title', '브라우저'));
  const message = node('p', 'ag-browser-message'); message.setAttribute('role', 'status');
  const refresh = button('', () => void load()); refresh.classList.add('ag-browser-refresh');
  refresh.title = '새로고침'; refresh.setAttribute('aria-label', '새로고침');
  refresh.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M19.5 12a7.5 7.5 0 0 0-13-5L4 9m16 6-2.5 2a7.5 7.5 0 0 1-13-5"/></svg>'; heading.append(refresh);
  const navigation = node('div', 'ag-browser-tabs'); navigation.setAttribute('role', 'tablist');
  const body = node('div', 'ag-browser-settings-body');
  let selectedAccountId: string | null = null; let formTitle = '';
  let accountKind = 'sessions'; let accountSearch = ''; let providerFilter = '';
  let active = 'accounts'; let disposed = false; let generation = 0; let busy = false; let resetFailed = false; let resetConfirming = false;
  let secrets: SecretMeta[] | null = null; let alwaysGrants: string[] = [];
  let accounts: Account[] = []; let secureStorage = false; let policy: Policy | null = null; let configuration: Record<string, unknown> = {}; let status: Record<string, unknown> = {};
  let localAccounts: LocalPasswordAccount[] = []; let profiles: { id: string; name: string }[] = [];
  let profileId = ''; let localSupported = false; let localBusy = false; let localFailed = false; let localMessage = '';
  let cookieSites: { domain: string; count: number }[] | null = null; const cookieChoice = new Set<string>();
  const localApi = localPasswordsApi();
  /** 끊긴 동안에는 허브에 아이콘을 묻지 않는다. */
  const iconRequest = () => options.isConnected() ? options.request : undefined;
  function managedAccounts(): Account[] {
    const ids = new Set(accounts.map(account => account.id));
    return accounts.filter(account => !(account.profileId === 'native' && !account.hasPassword && account.sourceAccountId && ids.has(account.sourceAccountId)));
  }
  function allAccounts(): Account[] { return [...managedAccounts(), ...localAccounts.map(account => ({ ...account, stableIdentity: account.username }))]; }
  let form: ReturnType<typeof createBrowserAccountForm> | null = null;
  const tabs = new Map<string, HTMLButtonElement>();
  for (const [id, label] of [['accounts', '계정'], ['permissions', '승인된 권한'], ['configuration', '구성']]) {
    const tab = button(label!, () => { clearForm(); active = id!; render(); }); tab.setAttribute('role', 'tab'); tab.id = `${instanceId}-tab-${id}`; tab.setAttribute('aria-controls', `${instanceId}-tabpanel`); tabs.set(id!, tab); navigation.append(tab);
  }
  body.id = `${instanceId}-tabpanel`;
  navigation.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const ids = [...tabs.keys()]; const index = ids.indexOf(active);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
    event.preventDefault(); tabs.get(ids[next]!)?.click(); tabs.get(ids[next]!)?.focus();
  });
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
  async function signIn(account: Account, authenticationMethod?: 'mac-passkey') {
    await mutate('sign-in', { accountId: account.id, url: account.origin, ...(authenticationMethod ? { authenticationMethod } : {}) });
    if (!disposed && !message.textContent) message.textContent = authenticationMethod === 'mac-passkey' ? '별도로 열린 Google Chrome에서 Mac 패스키 인증을 마친 뒤 이 계정의 로그인 확인을 누르세요.' : '별도로 열린 Chromium 창에서 로그인과 추가 인증을 마친 뒤 이 계정의 로그인 확인을 누르세요.';
  }
  function accountForm(account?: Partial<Account>, sessionOnly = false, openSignIn = false) {
    if (localApi && !sessionOnly) return;
    clearForm(); formTitle = account?.id ? '비밀번호 변경' : openSignIn ? '계정 연결' : sessionOnly ? '계정 연결' : '비밀번호 추가'; form = createBrowserAccountForm({ request: options.request, submit: options.submit, canSubmit: options.isConnected, account, sessionOnly, openSignIn, complete: (saved) => { if (saved?.id) { accountKind = saved.sessionStatus === 'saved' ? 'passwords' : 'sessions'; providerFilter = ''; accountSearch = ''; selectedAccountId = saved.id; accounts = [...accounts.filter(account => account.id !== saved.id), saved]; } clearForm(); if (openSignIn && saved?.id) void signIn(saved); else void load(); }, cancel: () => { clearForm(); render(); } }); render();
  }
  function section(title: string, description?: string) {
    const root = node('section', 'ag-browser-section'); root.append(node('h3', 'ag-settings-section-title', title));
    if (description) root.append(node('p', 'ag-browser-empty', description));
    body.append(root); return root;
  }
  function row(title: string, detail: string, target: HTMLElement = body) {
    const root = node('div', 'ag-browser-row'); const copy = node('div', 'ag-browser-row-copy'); copy.append(node('strong', '', title), node('span', '', detail));
    const actions = node('div', 'ag-browser-row-actions'); root.append(copy, actions); target.append(root); return actions;
  }
  function action(actions: HTMLElement, label: string, name: string, args: Record<string, unknown>) { const b = button(label, () => void mutate(name, args)); b.disabled = busy || !options.isConnected(); actions.append(b); }
  function render() {
    if (disposed) return;
    for (const [id, tab] of tabs) { tab.setAttribute('aria-selected', String(id === active)); tab.tabIndex = id === active ? 0 : -1; }
    refresh.disabled = busy || localBusy || (!options.isConnected() && !localApi); body.replaceChildren(); body.setAttribute('role', 'tabpanel'); body.setAttribute('aria-labelledby', `${instanceId}-tab-${active}`);
    if (!options.isConnected() && !(active === 'accounts' && localApi)) { body.append(node('p', 'ag-browser-empty', '허브에 연결하면 브라우저 설정을 관리할 수 있습니다.')); return; }
    if (active === 'accounts') {
      const toolbar = node('div', 'ag-browser-account-toolbar'); body.append(toolbar);
      const search = node('input', 'ag-settings-input ag-browser-search'); search.type = 'search'; search.placeholder = '계정 검색'; search.value = accountSearch; search.setAttribute('aria-label', '계정 검색');
      search.addEventListener('input', () => { clearForm(); accountSearch = search.value; renderAccounts(); });
      const filter = node('select', 'ag-settings-select'); filter.setAttribute('aria-label', '계정 제공자');
      const all = node('option', '', '모든 제공자'); all.value = ''; filter.append(all);
      for (const provider of [...new Set(allAccounts().map(accountProvider))].sort()) { const option = node('option', '', provider); option.value = provider; filter.append(option); }
      filter.value = providerFilter; filter.addEventListener('change', () => { clearForm(); providerFilter = filter.value; renderAccounts(); });
      filter.hidden = accountKind === 'secrets';
      const connect = button('계정 연결', () => accountForm(undefined, true, true)); connect.disabled = busy || !options.isConnected();
      const add = button('비밀번호 추가', () => accountForm()); add.title = '비밀번호 저장'; add.disabled = busy || !secureStorage || !options.isConnected();
      toolbar.append(search, filter, connect); if (!localApi) toolbar.append(add);
      if (!localApi && !secureStorage && options.isConnected()) body.append(node('p', 'ag-browser-empty', '보안 저장소를 사용할 수 없어 비밀번호를 저장할 수 없습니다.'));
      const kindBar = node('div', 'ag-browser-account-kinds'); kindBar.setAttribute('role', 'group'); kindBar.setAttribute('aria-label', '계정 종류');
      if (accountKind === 'secrets' && !secrets) accountKind = 'sessions';
      for (const [kind, label] of [['sessions', '연결된 계정'], ['passwords', '저장된 비밀번호'], ...(secrets ? [['secrets', '비밀 값']] : [])]) {
        const count = kind === 'secrets' ? secrets!.length : allAccounts().filter(account => kind === 'sessions' ? account.sessionStatus !== 'saved' : account.hasPassword).length;
        const choose = button(`${label} ${count}`, () => { clearForm(); accountKind = kind!; selectedAccountId = null; render(); }); choose.setAttribute('aria-pressed', String(accountKind === kind)); kindBar.append(choose);
      }
      body.append(kindBar);
      if (accountKind === 'passwords') renderLocalImport();
      const workspace = node('div', 'ag-browser-account-workspace'); body.append(workspace);
      function renderAccounts() {
        workspace.replaceChildren();
        if (accountKind === 'secrets') { renderSecrets(workspace); return; }
        const visible = allAccounts().filter(account => (accountKind === 'sessions' ? account.sessionStatus !== 'saved' : account.hasPassword)
          && (!providerFilter || accountProvider(account) === providerFilter)
          && [account.label, account.origin, visibleIdentity(account), accountProvider(account)].join(' ').toLocaleLowerCase().includes(accountSearch.toLocaleLowerCase()));
        if (!visible.some(account => account.id === selectedAccountId)) selectedAccountId = visible[0]?.id ?? null;
        const list = node('div', 'ag-browser-account-list'); list.setAttribute('aria-label', accountKind === 'sessions' ? '연결된 계정' : '저장된 비밀번호'); workspace.append(list);
        if (!visible.length) list.append(node('p', 'ag-browser-empty', accountSearch || providerFilter ? '검색 결과가 없습니다.' : accountKind === 'sessions' ? '연결된 계정이 없습니다.' : '저장된 비밀번호가 없습니다.'));
        for (const account of visible) {
          const choose = button('', () => { clearForm(); selectedAccountId = account.id; renderAccounts(); workspace.querySelector<HTMLButtonElement>('.ag-browser-account-option[aria-pressed="true"]')?.focus(); });
          choose.classList.add('ag-browser-account-option'); choose.dataset.accountId = account.id; choose.setAttribute('aria-pressed', String(account.id === selectedAccountId));
          const copy = node('span', 'ag-browser-account-copy'); copy.append(node('strong', '', account.label || account.origin), node('span', '', `${accountProvider(account)} · ${visibleIdentity(account)}`));
          const mark = createSiteMark({ origin: account.origin, request: iconRequest(), fallback: accountProvider(account), className: 'ag-browser-provider-mark' });
          choose.append(mark, copy, node('span', 'ag-browser-account-status', accountKind === 'passwords' ? '비밀번호' : sessionLabel(account))); list.append(choose);
        }
        const details = node('section', 'ag-browser-account-detail'); workspace.append(details);
        if (form) { details.append(node('h3', 'ag-settings-section-title', formTitle), form.element); return; }
        const account = visible.find(account => account.id === selectedAccountId); if (!account) return;
        details.dataset.accountId = account.id;
        const header = node('div', 'ag-browser-account-header'); header.append(node('h3', 'ag-settings-section-title', account.label || siteHost(account.origin)), node('p', 'ag-browser-empty', `${accountProvider(account)} · ${sessionLabel(account)}`)); details.append(header);
        row('사이트', account.origin, details);
        if (account.stableIdentity && account.stableIdentity !== account.id) row('아이디', account.stableIdentity, details);
        if ((account.origins?.length ?? 0) > 1) {
          const sites = node('details', 'ag-browser-account-sites'); sites.append(node('summary', '', `사용 가능한 사이트 ${account.origins!.length}`), node('p', 'ag-browser-empty', account.origins!.join(' · '))); details.append(sites);
        }
        if (localApi && localAccounts.some(value => value.id === account.id)) {
          const local = localAccounts.find(value => value.id === account.id);
          row('가져온 프로필', local?.sourceProfile || 'Chrome', details);
          const actions = node('div', 'ag-browser-detail-actions'); details.append(actions);
          details.append(node('p', 'ag-browser-empty', '로그인 페이지의 입력란을 선택하면 저장된 계정을 고를 수 있습니다.'));
          const approved = local?.agentReuseApproved === true;
          const consent = row('에이전트 사용', approved ? '허용됨' : '허용 안 함', details);
          const toggle = button(approved ? '허용 철회' : '허용', () => void localAction(async () => { await localApi.approve({ id: account.id, approved: !approved }); await loadLocal(); return ''; }));
          toggle.disabled = localBusy; consent.append(toggle);
          const remove = button('비밀번호 삭제', () => void localAction(async () => { await localApi.remove({ id: account.id }); await loadLocal(); return '가져온 비밀번호를 삭제했습니다.'; }));
          remove.disabled = localBusy; remove.classList.add('ag-browser-reset'); actions.append(remove);
          return;
        }
        const runtime = (status.runtime ?? {}) as Record<string, unknown>; const signInState = runtime.signIn as { accountId?: string } | null | undefined;
        const loginActions = node('div', 'ag-browser-detail-actions'); details.append(loginActions);
        const login = button('로그인 열기', () => void signIn(account)); login.disabled = busy || Boolean(signInState) || !account.agentReuseApproved || (account.profileId !== undefined && account.profileId !== 'default'); loginActions.append(login);
        const passkeys = runtime.passkeys as { supported?: boolean; reason?: string } | undefined;
        if (passkeys?.supported) {
          const passkey = button('Chrome에서 Mac 패스키 사용', () => void signIn(account, 'mac-passkey'));
          passkey.disabled = login.disabled; loginActions.append(passkey);
        } else if (passkeys) {
          const reason = ({ 'macos-required': 'Mac 패스키는 Mac에서 사용할 수 있습니다.', 'macos-13.5-required': 'Mac 패스키를 사용하려면 macOS 13.5 이상이 필요합니다.', 'macos-version-unavailable': 'macOS 버전을 확인하지 못했습니다. 브라우저 설정을 새로고침하세요.', 'signed-chrome-required': 'Mac 패스키를 사용하려면 공식 Google Chrome을 설치하세요.' } as Record<string, string>)[passkeys.reason ?? ''];
          details.append(node('p', 'ag-browser-empty', reason ?? 'Mac 패스키 사용 가능 여부를 확인하지 못했습니다. 브라우저 설정을 새로고침하세요.'));
        }
        const confirm = button('로그인 확인', () => void mutate('confirm-sign-in', { accountId: account.id })); confirm.disabled = busy || Boolean(signInState?.accountId && signInState.accountId !== account.id); loginActions.append(confirm);
        if (signInState?.accountId === account.id) details.append(node('p', 'ag-browser-empty', '별도 창에서 로그인을 마친 뒤 로그인 확인을 누르세요.'));
        const passwordActions = row('비밀번호', account.hasPassword ? '저장됨' : '없음', details);
        if (!localApi) { const update = button('비밀번호 변경', () => accountForm(account)); update.disabled = busy || !secureStorage; passwordActions.append(update); }
        const accessActions = row('계정 사용', account.agentReuseApproved ? '허용됨' : '승인 철회됨', details);
        action(accessActions, account.agentReuseApproved ? '사용 승인 철회' : '사용 허용', account.agentReuseApproved ? 'accounts.revoke' : 'accounts.approve', { accountId: account.id });
        const management = node('div', 'ag-browser-account-management'); details.append(management);
        action(management, '로그아웃', 'accounts.signout', { accountId: account.id }); action(management, '계정 삭제', 'accounts.forget', { accountId: account.id }); management.lastElementChild?.classList.add('ag-browser-reset');
      }
      renderAccounts();
    } else if (active === 'permissions') {
      if (!policy) { body.append(node('p', 'ag-browser-empty', '권한을 불러오는 중…')); return; }
      const defaults = section('기본 연구 권한');
      for (const [key, label] of [['browse', '공개 연구 페이지 읽기'], ['download', '연구 자료 다운로드'], ['researchImport', '다운로드한 자료를 프로젝트에 추가']]) {
        const root = node('label', 'ag-browser-check'); const input = node('input', ''); input.type = 'checkbox'; input.checked = policy.defaults[key as keyof Policy['defaults']]; input.disabled = busy;
        input.addEventListener('change', () => void mutate('policy.update', { operation: 'set-default', key, enabled: input.checked })); root.append(input, document.createTextNode(label!)); defaults.append(root);
      }
      const always = alwaysGrants.filter(isChatPermissionCapability);
      if (always.length) {
        const alwaysSection = section('항상 허용한 권한');
        for (const capability of always) action(row(CHAT_PERMISSION_LABELS[capability], '모든 채팅', alwaysSection), '해제', 'permissions.revoke', { capability });
      }
      const accountPermissions = section('계정 사용 승인', '각 계정에 등록된 사이트에서 적용됩니다.');
      if (!managedAccounts().length) accountPermissions.append(node('p', 'ag-browser-empty', '등록된 계정이 없습니다.'));
      for (const account of managedAccounts()) {
        const actions = row(account.label || account.origin, `${accountProvider(account)} · ${visibleIdentity(account)} · ${account.agentReuseApproved ? '허용됨' : '승인 철회됨'}`, accountPermissions);
        action(actions, account.agentReuseApproved ? '사용 승인 철회' : '사용 허용', account.agentReuseApproved ? 'accounts.revoke' : 'accounts.approve', { accountId: account.id });
      }
      const sitePermissions = section('사이트 권한');
      if (!policy.sites.length) sitePermissions.append(node('p', 'ag-browser-empty', '등록된 사이트 권한이 없습니다.'));
      for (const site of policy.sites) {
        const blocked = site.blockedActions.includes('browse'); const actions = row(site.label || site.origin, `${site.origin} · ${blocked ? '차단됨' : [...new Set(site.allowedActions.map(value => permissionLabels[value] ?? value))].join(' · ') || '기본 정책'}`, sitePermissions);
        action(actions, blocked ? '읽기·다운로드 허용' : '사이트 차단', 'policy.update', { operation: 'set-site', origin: site.origin, label: site.label, allowedActions: [...site.allowedActions.filter(value => !['browse', 'read', 'download', 'research-import'].includes(value)), ...(blocked ? ['browse', 'read', 'download', 'research-import'] : [])], blockedActions: [...site.blockedActions.filter(value => !['browse', 'read', 'download', 'research-import'].includes(value)), ...(blocked ? [] : ['browse', 'read', 'download', 'research-import'])] });
        for (const operation of site.allowedActions.filter(value => !['browse', 'read', 'download', 'research-import'].includes(value))) {
          action(actions, `${operation === 'website-change' ? '웹사이트 변경' : operation === 'account-use' ? '계정 사용' : operation} 승인 철회`, 'policy.update', { operation: 'set-site', origin: site.origin, label: site.label, allowedActions: site.allowedActions.filter(value => value !== operation), blockedActions: [...new Set([...site.blockedActions, operation])] });
        }
      }
      const newSite = section('사이트 권한 추가');
      const origin = field('사이트 주소', 'url'); origin.input.placeholder = 'https://example.com'; newSite.append(origin.root);
      const addSite = (allow: boolean) => { try { const url = new URL(origin.input.value); if (url.protocol !== 'https:' || url.origin !== origin.input.value.replace(/\/$/, '')) throw new Error(); void mutate('policy.update', { operation: 'set-site', origin: url.origin, allowedActions: allow ? ['browse', 'read', 'download', 'research-import'] : [], blockedActions: allow ? [] : ['browse', 'read', 'download', 'research-import'] }); } catch { message.textContent = 'HTTPS 사이트 주소를 입력하세요.'; } };
      const actions = node('div', 'ag-settings-actions'); actions.append(button('사이트 허용', () => addSite(true)), button('사이트 차단', () => addSite(false))); newSite.append(actions);
    } else {
      const runtime = (status.runtime ?? {}) as Record<string, unknown>; const readiness = (runtime.readiness ?? {}) as Record<string, unknown>;
      const adblock = createAdblockSettings(); if (adblock) body.append(adblock);
      const downloadsSection = section('다운로드');
      const downloads = (configuration.downloads ?? {}) as Record<string, unknown>; row('다운로드 저장소', String(downloads.directory ?? downloads.path ?? '앱의 다운로드 저장소'), downloadsSection);
      const limit = field('파일당 다운로드 한도 · MB', 'number', String(Math.round(Number(downloads.maxFileBytes ?? 104857600) / 1048576)));
      limit.input.min = '1'; limit.input.max = '512'; limit.input.step = '1'; downloadsSection.append(limit.root);
      const searchSection = section('검색');
      const searchLabel = node('label', 'ag-settings-field'); searchLabel.append(node('span', 'ag-settings-field-label', '기본 검색 엔진'));
      const searchEngine = node('select', 'ag-settings-select'); searchEngine.setAttribute('aria-label', '기본 검색 엔진');
      for (const [value, label] of [['duckduckgo', 'DuckDuckGo'], ['google', 'Google'], ['bing', 'Bing'], ['naver', 'Naver']]) { const option = node('option', '', label); option.value = value!; searchEngine.append(option); }
      searchEngine.value = String(configuration.searchEngine ?? 'google'); searchLabel.append(searchEngine); searchSection.append(searchLabel);
      const memorySection = section('메모리 절약');
      const sleepLabel = node('label', 'ag-settings-field'); sleepLabel.append(node('span', 'ag-settings-field-label', '사용하지 않는 탭 잠자기'));
      const sleepTime = node('select', 'ag-settings-select'); sleepTime.setAttribute('aria-label', '탭 잠자기 시간');
      for (const [value, label] of [['0', '사용 안 함'], ['1', '1분'], ['5', '5분'], ['15', '15분'], ['30', '30분'], ['60', '1시간']]) { const option = node('option', '', label); option.value = value!; sleepTime.append(option); }
      sleepTime.value = String((configuration.performance as Record<string, unknown> | undefined)?.idleMinutes ?? 15); sleepLabel.append(sleepTime); memorySection.append(sleepLabel);
      memorySection.append(node('p', 'ag-browser-empty', '잠든 탭은 다시 열면 깨어납니다. 작성 중인 폼과 재생·다운로드 중인 페이지는 유지합니다.'));
      const displaySection = section('브라우저 표시');
      const preview = (configuration.preview ?? {}) as Record<string, unknown>;
      const mode = node('label', 'ag-settings-field'); mode.append(node('span', 'ag-settings-field-label', '브라우저 표시'));
      const select = node('select', 'ag-settings-select');
      for (const [value, label] of [['docked', '작업 공간'], ['floating', '떠 있는 창'], ['popout', '별도 창']]) { const option = node('option', '', label); option.value = value!; select.append(option); }
      select.value = String(preview.mode ?? 'docked'); mode.append(select); displaySection.append(mode);
      const autoImport = node('input', ''); autoImport.type = 'checkbox'; autoImport.checked = downloads.autoImport !== false;
      const autoLabel = node('label', 'ag-browser-check'); autoLabel.append(autoImport, document.createTextNode('다운로드한 자료를 앱에 자동 추가')); downloadsSection.append(autoLabel);
      const reduced = node('input', ''); reduced.type = 'checkbox'; reduced.checked = preview.reducedMotion === true;
      const reducedLabel = node('label', 'ag-browser-check'); reducedLabel.append(reduced, document.createTextNode('브라우저 움직임 줄이기')); displaySection.append(reducedLabel);
      const apply = button('구성 저장', () => { const mb = Number(limit.input.value); if (!Number.isInteger(mb) || mb < 1 || mb > 512) { message.textContent = '다운로드 한도는 1~512 MB로 입력하세요.'; return; } void mutate('configuration.update', { searchEngine: searchEngine.value, downloads: { maxFileBytes: mb * 1048576, autoImport: autoImport.checked }, preview: { mode: select.value, reducedMotion: reduced.checked }, performance: { idleMinutes: Number(sleepTime.value) } }); });
      apply.disabled = busy; body.append(apply);
      const executionSection = node('details', 'ag-browser-execution'); executionSection.append(node('summary', '', '고급 브라우저 설정')); body.append(executionSection);
      const diagnostics = node('p', 'ag-browser-empty', String(readiness.message ?? readiness.reason ?? '')); if (diagnostics.textContent) executionSection.append(diagnostics);
      const actions = node('div', 'ag-settings-actions'); action(actions, '브라우저 준비', 'install', {}); action(actions, '진단 새로고침', 'status', {}); executionSection.append(actions);
      const runtimeMode = node('label', 'ag-settings-field'); runtimeMode.append(node('span', 'ag-settings-field-label', '실행 브라우저'));
      const runtimeSelect = node('select', 'ag-settings-select'); for (const [value, label] of [['managed', '로컬 Chromium'], ['native', '앱 내 브라우저']]) { const option = node('option', '', label); option.value = value!; runtimeSelect.append(option); } runtimeSelect.value = runtime.kind === 'native' ? 'native' : 'managed'; runtimeMode.append(runtimeSelect); executionSection.append(runtimeMode);
      executionSection.append(button('실행 방식 적용', () => void mutate('configure', { mode: runtimeSelect.value, headless: true })));
      const cleanup = node('section', 'ag-browser-cleanup'); cleanup.append(node('h3', 'ag-settings-section-title', '브라우저 데이터 삭제'));
      cleanup.append(node('p', 'ag-browser-empty', '앱을 제거하기 전에 저장된 웹사이트 로그인과 방문 기록을 정리할 수 있습니다.'));
      const reset = button(resetFailed ? '계정과 기록 삭제 다시 시도' : '브라우저 계정과 기록 삭제', () => void resetBrowser()); reset.disabled = busy || !options.isConnected(); reset.classList.add('ag-browser-reset'); cleanup.append(reset); body.append(cleanup);

    }
  }
  function renderSecrets(workspace: HTMLElement) {
    const visible = (secrets ?? []).filter(secret => [secret.label, SECRET_KIND_LABELS[secret.kind], ...secret.origins].join(' ').toLocaleLowerCase().includes(accountSearch.toLocaleLowerCase()));
    if (!visible.some(secret => secret.id === selectedAccountId)) selectedAccountId = visible[0]?.id ?? null;
    const list = node('div', 'ag-browser-account-list'); list.setAttribute('aria-label', '비밀 값'); workspace.append(list);
    if (!visible.length) list.append(node('p', 'ag-browser-empty', accountSearch ? '검색 결과가 없습니다.' : '저장된 비밀 값이 없습니다.'));
    for (const secret of visible) {
      const choose = button('', () => { selectedAccountId = secret.id; render(); workspace.ownerDocument.querySelector<HTMLButtonElement>(`.ag-browser-account-option[data-secret-id="${CSS.escape(secret.id)}"]`)?.focus(); });
      choose.classList.add('ag-browser-account-option'); choose.dataset.secretId = secret.id; choose.setAttribute('aria-pressed', String(secret.id === selectedAccountId));
      const copy = node('span', 'ag-browser-account-copy');
      copy.append(node('strong', '', secret.label), node('span', '', [SECRET_KIND_LABELS[secret.kind], siteHost(secret.origins[0] ?? ''), secret.origins.length > 1 ? `외 ${secret.origins.length - 1}곳` : ''].filter(Boolean).join(' · ')));
      choose.append(createSiteMark({ origin: secret.origins[0], request: iconRequest(), className: 'ag-browser-provider-mark' }), copy, node('span', 'ag-browser-account-status', secret.approved ? '허용됨' : '허용 안 함'));
      list.append(choose);
    }
    const details = node('section', 'ag-browser-account-detail'); workspace.append(details);
    const secret = visible.find(entry => entry.id === selectedAccountId); if (!secret) return;
    details.dataset.secretId = secret.id;
    details.append(node('h3', 'ag-settings-section-title', secret.label));
    row('종류', `${SECRET_KIND_LABELS[secret.kind]} · ${secret.scope === 'chat' ? '이 채팅만' : '저장됨'}`, details);
    const sites = node('div', 'ag-browser-secret-sites'); sites.setAttribute('aria-label', '입력할 수 있는 사이트');
    for (const origin of secret.origins) { const item = node('span', 'ag-browser-secret-site'); item.append(createSiteMark({ origin, request: iconRequest(), className: 'ag-site-mark-small' }), node('span', '', siteHost(origin))); sites.append(item); }
    const sitesRow = node('div', 'ag-browser-row'); const sitesCopy = node('div', 'ag-browser-row-copy'); sitesCopy.append(node('strong', '', '사이트'), sites); sitesRow.append(sitesCopy); details.append(sitesRow);
    row('마지막 사용', secret.lastUsedAt ? new Date(secret.lastUsedAt).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }) : '없음', details);
    const consent = row('에이전트 사용', secret.approved ? '허용됨' : '허용 안 함', details);
    if (secret.approved) action(consent, '허용 철회', 'secrets.revoke', { secretId: secret.id });
    const management = node('div', 'ag-browser-account-management'); details.append(management);
    const remove = button('삭제', () => void (async () => {
      if (!await confirmSheet(element, `${secret.label} 삭제`, '저장한 값을 지웁니다.', { confirmLabel: '삭제', destructive: true })) return;
      await mutate('secrets.delete', { secretId: secret.id });
    })());
    remove.disabled = busy || !options.isConnected(); remove.classList.add('ag-browser-reset'); management.append(remove);
  }
  function renderLocalImport() {
    const root = node('section', 'ag-browser-local-import'); body.append(root);
    root.append(node('h3', 'ag-settings-section-title', 'Chrome에서 가져오기'));
    if (!localApi) { root.append(node('p', 'ag-browser-empty', '데스크톱 앱에서 Chrome 비밀번호를 가져올 수 있습니다.')); return; }
    if (localBusy) root.setAttribute('aria-busy', 'true');
    if (localSupported && profiles.length) {
      const label = node('label', 'ag-browser-import-picker'); label.append(node('span', 'ag-settings-field-label', 'Chrome 프로필'));
      const select = node('select', 'ag-settings-select');
      for (const profile of profiles) { const option = node('option', '', profile.name); option.value = profile.id; select.append(option); }
      select.value = profileId; select.disabled = localBusy; select.addEventListener('change', () => { profileId = select.value; cookieSites = null; cookieChoice.clear(); render(); }); label.append(select); root.append(label);
      const importButton = button(localBusy ? '가져오는 중…' : '비밀번호 가져오기', () => void localAction(async () => {
        const result = await localApi.importProfile({ profileId }); await loadLocal();
        return `${result.imported}개 가져옴 · ${result.skipped}개 건너뜀${result.unsupported ? ` · ${result.unsupported}개 암호화 방식 지원 안 됨` : ''}`;
      })); importButton.disabled = localBusy; root.append(importButton);
      root.append(node('p', 'ag-browser-empty', 'Mac 키체인 접근을 허용하면 이 앱에 암호화해 저장합니다.'));
      renderCookieImport(root);
    } else if (!localBusy && !localFailed) root.append(node('p', 'ag-browser-empty', localSupported ? '가져올 Chrome 프로필이 없습니다.' : 'Chrome 비밀번호 가져오기는 Mac에서 사용할 수 있습니다.'));
    const feedback = node('p', 'ag-browser-message', localMessage); feedback.setAttribute('role', localFailed ? 'alert' : 'status'); root.append(feedback);
    if (localFailed || (localSupported && !profiles.length)) { const retry = button('다시 확인', () => void localAction(async () => { await loadLocal(); return ''; })); retry.disabled = localBusy; root.append(retry); }
  }
  function renderCookieImport(parent: HTMLElement) {
    if (!localApi) return;
    const root = node('section', 'ag-browser-cookie-import'); parent.append(root);
    root.append(node('h3', 'ag-settings-section-title', 'Chrome 로그인 가져오기'));
    if (!cookieSites) {
      const load = button('사이트 불러오기', () => void localAction(async () => { cookieSites = (await localApi.cookieSites({ profileId })).sites; cookieChoice.clear(); return cookieSites.length ? '' : '가져올 로그인이 없습니다.'; }));
      load.disabled = localBusy || !profileId; root.append(load); return;
    }
    const list = node('div', 'ag-browser-cookie-sites'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'Chrome 로그인 사이트');
    for (const site of cookieSites) {
      const choice = node('label', 'ag-browser-check'); const input = node('input', ''); input.type = 'checkbox'; input.checked = cookieChoice.has(site.domain); input.disabled = localBusy;
      input.addEventListener('change', () => { if (input.checked) cookieChoice.add(site.domain); else cookieChoice.delete(site.domain); importButton.disabled = localBusy || !cookieChoice.size; });
      choice.append(input, document.createTextNode(`${site.domain} · ${site.count}`)); list.append(choice);
    }
    const importButton = button('가져오기', () => void localAction(async () => {
      const result = await localApi.importCookies({ profileId, domains: [...cookieChoice] });
      // 가져온 사이트 세션은 사용자가 고른 것이므로 허브가 사용자 변경으로 격리하지 않게 알린다.
      if (result.domains.length && options.isConnected()) await options.request('sessions.imported', { domains: result.domains }).catch(() => undefined);
      cookieSites = null; cookieChoice.clear();
      return `${result.domains.length}개 사이트 가져옴${result.skipped ? ` · ${result.skipped}개 건너뜀` : ''}`;
    }));
    importButton.classList.add('ag-settings-primary'); importButton.disabled = localBusy || !cookieChoice.size;
    root.append(list, importButton);
  }
  async function loadLocal() {
    if (!localApi) return;
    const [available, saved] = await Promise.all([localApi.listProfiles(), localApi.list()]);
    if (disposed) return;
    profiles = available.profiles; localSupported = available.supported; localAccounts = saved.accounts;
    if (!profiles.some(profile => profile.id === profileId)) profileId = profiles[0]?.id ?? '';
  }
  async function localAction(action: () => Promise<string>) {
    if (disposed || localBusy) return; localBusy = true; localFailed = false; localMessage = '처리 중…'; render();
    try { const result = await action(); if (!disposed) localMessage = result; }
    catch { if (!disposed) { localFailed = true; localMessage = '완료하지 못했습니다. Chrome과 키체인 접근 권한을 확인하고 다시 시도하세요.'; } }
    finally { localBusy = false; if (!disposed) render(); }
  }
  async function load() {
    if (disposed || localBusy) return;
    if (localApi) await localAction(async () => { await loadLocal(); return ''; });
    if (!options.isConnected()) { render(); return; } const current = ++generation; message.textContent = '불러오는 중…';
    const results = await Promise.allSettled([options.request('accounts.list'), options.request('policy.list'), options.request('configuration.get'), options.request('status')]);
    // 비밀 값과 항상 허용 목록은 옛 허브에 없다 — 못 읽으면 그 칸만 감춘다.
    const [secretList, permissionList] = await Promise.allSettled([options.request('secrets.list'), options.request('permissions.list')]);
    if (disposed || generation !== current) return;
    secrets = secretList.status === 'fulfilled' && Array.isArray((secretList.value as { secrets?: unknown })?.secrets)
      ? ((secretList.value as { secrets: unknown[] }).secrets.map(readSecretMeta).filter((entry): entry is SecretMeta => entry !== null)) : null;
    alwaysGrants = permissionList.status === 'fulfilled' && Array.isArray((permissionList.value as { always?: unknown })?.always)
      ? ((permissionList.value as { always: unknown[] }).always.filter((entry): entry is string => typeof entry === 'string')) : [];
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
