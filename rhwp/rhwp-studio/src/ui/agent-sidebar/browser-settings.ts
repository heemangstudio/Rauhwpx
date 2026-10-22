import './browser-settings.css';
import { confirmSheet } from './sheet.ts';
import { localPasswordsApi, type LocalPasswordAccount } from './browser-local-passwords.ts';
import { createAdblockSettings } from './browser-adblock-settings.ts';
import { createSiteMark } from './site-mark.ts';
import { createIcon, type SidebarIconName } from './icons.ts';
import { createChevron } from '../chevron.ts';
import { CHAT_PERMISSION_LABELS, SECRET_KIND_LABELS, isChatPermissionCapability, readSecretMeta } from '../../agent/chat-permissions.ts';
import type { ChatPermissionScope, SecretMeta } from '../../agent/types.ts';

export type BrowserSettingsRequest = (action: string, args?: Record<string, unknown>) => Promise<unknown>;
/** 저장된 로그인. 실행 중인 브라우저의 저장소(허브 또는 데스크톱 보관함)에서 온다. */
interface Account { profileId?: string; id: string; origin: string; origins?: string[]; label: string; stableIdentity?: string; hasPassword: boolean; agentBlocked?: boolean; sessionStatus?: string; site?: string; }
/**
 * 사이트 목록의 한 줄. 키는 사이트(등록 도메인 출처, 예: https://coupang.com)이고, 하위 호스트만 막은 차단은 그 호스트가 키다.
 * always 는 모든 채팅의 사이트 사용, chat 은 지금 채팅의 사이트 사용, signedIn 은 사용자가 로그인한 흔적이 남은 사이트다.
 */
/** 사이트 사용법 — 에이전트가 사이트(등록 도메인)마다 남긴 짧은 메모. */
export interface SiteRecipe { key: string; site: string; text: string; author: string; updatedAt: number; }
export function readSiteRecipes(value: unknown): SiteRecipe[] | null {
  const list = (value as { recipes?: unknown })?.recipes;
  if (!Array.isArray(list)) return null;
  return list.flatMap((entry) => {
    const item = entry as Partial<SiteRecipe>;
    return typeof item?.key === 'string' && typeof item.site === 'string' && typeof item.text === 'string'
      ? [{ key: item.key, site: item.site, text: item.text, author: String(item.author ?? 'agent'), updatedAt: Number(item.updatedAt) || 0 }] : [];
  });
}
export interface SiteRow { key: string; label: string; source: string; always: boolean; chat: boolean; signedIn: boolean; allowedActions: string[]; blockedActions: string[]; }
const ALL_ACTIONS = ['browse', 'read', 'download', 'research-import', 'website-change', 'account-use'];
/** 차단 편집의 묶음 — 사용자가 고르는 단위. */
const BLOCK_GROUPS: ReadonlyArray<{ label: string; actions: string[] }> = [
  { label: '읽기', actions: ['browse', 'read'] },
  { label: '사이트 변경', actions: ['website-change'] },
  { label: '다운로드', actions: ['download', 'research-import'] },
  { label: '계정 사용', actions: ['account-use'] },
];

function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []; }
function siteKey(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value.replace(/^\./, '')}`).origin; } catch { return null; }
}

/**
 * policy.list 결과를 사이트 줄로 모은다. sites(항상 허용·차단)에 허브가 계산한 siteStatus(지금 채팅·로그인됨)를 겹친다.
 * siteStatus 가 없으면 chatSites·signedIn 목록을 읽는다. 아무 상태도 없는 연구 기본값은 목록에 넣지 않는다.
 */
export function readSiteRows(value: unknown): SiteRow[] {
  const policy = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const rows = new Map<string, SiteRow>();
  const row = (key: string, label?: unknown) => {
    let entry = rows.get(key);
    if (!entry) { entry = { key, label: '', source: 'user', always: false, chat: false, signedIn: false, allowedActions: [], blockedActions: [] }; rows.set(key, entry); }
    if (typeof label === 'string' && label.trim() && !entry.label) entry.label = label.trim();
    return entry;
  };
  for (const site of Array.isArray(policy.sites) ? policy.sites as Record<string, unknown>[] : []) {
    const key = siteKey(site?.origin ?? site?.key); if (!key) continue;
    const entry = row(key, site.domain);
    entry.source = typeof site.source === 'string' ? site.source : 'user';
    entry.allowedActions = [...new Set([...entry.allowedActions, ...strings(site.allowedActions)])];
    entry.blockedActions = [...new Set([...entry.blockedActions, ...strings(site.blockedActions)])];
    entry.always ||= entry.source === 'user' && entry.allowedActions.some(action => action === 'website-change' || action === 'account-use');
  }
  for (const status of Array.isArray(policy.siteStatus) ? policy.siteStatus as Record<string, unknown>[] : []) {
    const key = siteKey(status?.key ?? status?.site ?? status?.origin); if (!key) continue;
    const entry = row(key, status.domain);
    if (typeof status.always === 'boolean') entry.always = status.always;
    entry.chat ||= status.chat === true; entry.signedIn ||= status.signedIn === true;
    // 허브의 blocked 는 [{ origin, actions }] 이다. 하위 호스트만 막은 항목은 sites 에서 따로 줄이 된다.
    if (Array.isArray(status.blocked)) entry.blockedActions = [...new Set((status.blocked as Record<string, unknown>[]).filter(block => siteKey(block?.origin) === key).flatMap(block => strings(block.actions)))];
    else if (Array.isArray(status.blockedActions)) entry.blockedActions = [...new Set(strings(status.blockedActions))];
    if (Array.isArray(status.allowedActions)) entry.allowedActions = [...new Set(strings(status.allowedActions))];
  }
  for (const marker of Array.isArray(policy.signedIn) ? policy.signedIn : []) {
    const key = siteKey(typeof marker === 'string' ? marker : (marker as Record<string, unknown>)?.key ?? (marker as Record<string, unknown>)?.site); if (key) row(key).signedIn = true;
  }
  for (const site of strings(policy.chatSites)) { const key = siteKey(site); if (key) row(key).chat = true; }
  return [...rows.values()]
    .map(entry => ({ ...entry, label: entry.label || siteHost(entry.key) }))
    .filter(entry => entry.always || entry.chat || entry.signedIn || entry.blockedActions.length > 0 || (entry.source === 'user' && entry.allowedActions.length > 0))
    .sort((a, b) => a.label.localeCompare(b.label));
}

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

/** 사이트 권한 칸은 `coupang.com`처럼 주소만 써도 HTTPS 출처로 받는다. 다른 프로토콜은 받지 않는다. */
export function httpsSiteOrigin(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return url.protocol === 'https:' && url.hostname.includes('.') && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

/** 비밀 값은 전용 인증 요청으로만 보내고 저장소와 채팅 메시지에 남기지 않는다. */
export function createBrowserAccountForm(options: {
  submit: (args: Record<string, unknown>) => Promise<unknown>;
  request: BrowserSettingsRequest;
  account?: Partial<Account>;
  requestId?: string;
  canSubmit?(): boolean;
  /** 채팅 요청 카드 안의 짧은 양식: 사이트는 카드 머리에 보이고, 칸은 자리표시 글자로 이름을 단다. */
  variant?: 'card';
  /** 카드의 '항상' 스위치. 저장과 함께 그 범위로 사이트 사용을 허용한다. 설정에서 저장하면 허용은 바뀌지 않는다. */
  scope?(): ChatPermissionScope;
  /** 카드 양식만: Google 등 다른 계정으로 이미 로그인해 저장할 비밀번호가 없다. */
  federated?(): void;
  complete(account?: Account): void;
  cancel(): void;
}) {
  const card = options.variant === 'card';
  const root = node('form', card ? 'ag-browser-account-form ag-request-form' : 'ag-browser-account-form');
  const origin = field('사이트 주소', 'url', options.account?.origin ?? ''); origin.input.required = true;
  const origins = field('함께 사용할 사이트 · 쉼표로 구분', 'text', options.account?.origins?.filter(value => value !== options.account?.origin).join(', ') ?? '');
  if (options.requestId || options.account?.id) origins.input.readOnly = true;
  const label = field('계정 이름', 'text', options.account?.label ?? ''); label.input.required = true;
  const username = field('로그인 아이디', 'text', options.account?.stableIdentity && options.account.stableIdentity !== options.account.id ? options.account.stableIdentity : ''); username.input.required = true;
  const password = field('비밀번호', 'password'); password.input.required = true;
  if (options.requestId || options.account?.id) origin.input.readOnly = true;
  const message = node('p', card ? 'ag-browser-message ag-request-form-message' : 'ag-browser-message'); message.setAttribute('role', 'alert');
  const actions = node('div', card ? 'ag-request-actions' : 'ag-settings-actions');
  const save = node('button', card ? 'ag-request-primary' : 'ag-settings-primary', options.account?.id ? '비밀번호 변경' : '저장'); save.type = 'submit';
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
  root.append(password.root);
  if (card && options.federated) {
    const federated = node('button', 'ag-request-link', 'Google 등으로 로그인함'); federated.type = 'button';
    federated.addEventListener('click', () => { if (disposed || options.canSubmit?.() === false) return; clear(); options.federated!(); });
    root.append(federated);
  }
  root.append(message, actions);
  let disposed = false;
  root.addEventListener('submit', async (event) => {
    event.preventDefault(); if (save.disabled || disposed || options.canSubmit?.() === false) return;
    message.textContent = ''; save.disabled = true;
    try {
      const parsed = new URL(origin.input.value);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('HTTPS 사이트 주소만 입력하세요.');
      const accountOrigins = [...new Set([parsed.origin, ...origins.input.value.split(',').map(value => value.trim()).filter(Boolean)])];
      for (const value of accountOrigins) { const allowed = new URL(value); if (allowed.protocol !== 'https:' || allowed.origin !== value) throw new Error('사이트 주소 확인 필요'); }
      const approval = options.requestId ? { requestId: options.requestId } : await options.request('accounts.request', { origin: parsed.origin, label: label.input.value.trim(), accountId: options.account?.id, origins: accountOrigins, intent: 'save' }) as { requestId: string };
      if (disposed || options.canSubmit?.() === false) return;
      const scope = options.scope?.();
      const result = await options.submit({
        accountRequestId: approval.requestId,
        account: { id: options.account?.id, origin: parsed.origin, label: label.input.value.trim(), stableIdentity: username.input.value, origins: accountOrigins },
        username: username.input.value, password: password.input.value, ...(scope ? { scope } : {}), remember: true, consent: { save: true, use: true },
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
function sessionLabel(account: Account): string { return account.sessionStatus === 'authenticated' ? '로그인됨' : account.sessionStatus === 'signed-out' ? '로그아웃됨' : ''; }
/** 로고 귀퉁이의 점: 로그인됨 · 로그아웃됨. 비밀번호만 저장한 항목에는 점이 없다. */
function presence(account: Account): 'on' | 'off' | null {
  return account.sessionStatus === 'authenticated' ? 'on' : account.sessionStatus === 'signed-out' ? 'off' : null;
}
/** Chrome 쿠키 도메인(.example.com)을 로고용 origin 으로 바꾼다. */
function cookieOrigin(domain: string): string { return `https://${domain.replace(/^\./, '')}`; }

type AccountKind = 'all' | 'passwords' | 'secrets';
const KIND_FILTERS: ReadonlyArray<{ id: AccountKind; label: string; icon: SidebarIconName }> = [
  { id: 'all', label: '전체', icon: 'apps' },
  { id: 'passwords', label: '저장된 비밀번호', icon: 'key' },
  { id: 'secrets', label: '비밀 값', icon: 'lock' },
];
type AccountItem = { key: string; account: Account; local?: LocalPasswordAccount; secret?: undefined };
type SecretItem = { key: string; secret: SecretMeta; account?: undefined; local?: undefined };
type Item = AccountItem | SecretItem;

function iconButton(icon: SidebarIconName, label: string, run: () => void, focusKey?: string): HTMLButtonElement {
  const result = node('button', 'ag-browser-icon-btn'); result.type = 'button'; result.title = label; result.setAttribute('aria-label', label);
  result.append(createIcon(icon)); result.addEventListener('click', run); if (focusKey) result.dataset.focusKey = focusKey; return result;
}
/** 에이전트 사용 스위치 — 켜 두면 에이전트가 사이트 사용을 받은 곳에서 이 항목을 쓴다. 끄면 그 사이트에서도 쓰지 않는다. */
function agentSwitch(on: boolean, disabled: boolean, toggle: () => void, focusKey: string): HTMLButtonElement {
  const result = node('button', 'ag-browser-switch'); result.type = 'button'; result.setAttribute('role', 'switch');
  result.setAttribute('aria-checked', String(on)); result.setAttribute('aria-label', '에이전트 사용'); result.title = on ? '에이전트 사용' : '에이전트 사용 안 함';
  result.dataset.focusKey = focusKey; result.disabled = disabled; result.append(createIcon('sparkles'), node('span', 'ag-browser-switch-track'));
  result.addEventListener('click', toggle); return result;
}
function emptyState(icon: SidebarIconName, text: string, ...actions: HTMLElement[]): HTMLElement {
  const root = node('div', 'ag-browser-empty-state'); root.append(createIcon(icon, 'ag-browser-empty-glyph'), node('p', 'ag-browser-empty', text), ...actions); return root;
}
/** 화살표·Home·End 로 고르는 라디오 묶음(종류 필터, Chrome 프로필). */
function rovingRadios(group: HTMLElement, radios: HTMLButtonElement[]): void {
  group.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const index = radios.findIndex(radio => radio === document.activeElement); if (index < 0) return;
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? radios.length - 1 : (index + (forward ? 1 : -1) + radios.length) % radios.length;
    event.preventDefault(); radios[next]!.click();
  });
}

let browserSettingsSequence = 0;

export function createBrowserSettingsPane(options: { request: BrowserSettingsRequest; submit: (args: Record<string, unknown>) => Promise<unknown>; isConnected(): boolean }) {
  const instanceId = `ag-browser-settings-${++browserSettingsSequence}`;
  const element = node('div', 'ag-browser-settings');
  const heading = node('div', 'ag-browser-heading'); heading.append(node('h2', 'ag-settings-section-title', '브라우저'));
  const message = node('p', 'ag-browser-message'); message.setAttribute('role', 'status');
  const refresh = button('', () => void load()); refresh.classList.add('ag-browser-refresh');
  refresh.title = '새로고침'; refresh.setAttribute('aria-label', '새로고침'); refresh.dataset.focusKey = 'refresh';
  refresh.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M19.5 12a7.5 7.5 0 0 0-13-5L4 9m16 6-2.5 2a7.5 7.5 0 0 1-13-5"/></svg>'; heading.append(refresh);
  const navigation = node('div', 'ag-browser-tabs'); navigation.setAttribute('role', 'tablist');
  const body = node('div', 'ag-browser-settings-body');
  /** 고른 항목: 계정은 `a:<id>`, 비밀 값은 `s:<id>`. */
  let selected: string | null = null; let formTitle = ''; let formOrigin: string | undefined;
  let accountKind: AccountKind = 'all'; let accountSearch = ''; let view: 'list' | 'form' | 'import' = 'list';
  let active = 'accounts'; let disposed = false; let generation = 0; let busy = false; let resetFailed = false; let resetConfirming = false;
  let secrets: SecretMeta[] | null = null; let alwaysGrants: string[] = [];
  let recipes: SiteRecipe[] | null = null; let expandedRecipe: string | null = null;
  let accounts: Account[] = []; let secureStorage = false; let sites: SiteRow[] | null = null; let expandedSite: string | null = null; let configuration: Record<string, unknown> = {}; let status: Record<string, unknown> = {};
  let localAccounts: LocalPasswordAccount[] = []; let profiles: { id: string; name: string }[] = [];
  let profileId = ''; let localSupported = false; let localBusy = false; let localFailed = false; let localMessage = ''; let retryLocal: (() => void) | null = null;
  let importStep: 'choose' | 'cookies' = 'choose';
  let cookieSites: { domain: string; count: number }[] | null = null; const cookieChoice = new Set<string>();
  /** 다시 그린 뒤 초점을 돌려줄 컨트롤. 막혀 있으면 다음 그리기까지 기다린다. */
  let focusKey: string | undefined;
  const localApi = localPasswordsApi();
  /** 끊긴 동안에는 허브에 아이콘을 묻지 않는다. */
  const iconRequest = () => options.isConnected() ? options.request : undefined;
  function allAccounts(): Account[] { return [...accounts, ...localAccounts.map(account => ({ ...account, stableIdentity: account.username }))]; }
  let form: ReturnType<typeof createBrowserAccountForm> | null = null;
  const tabs = new Map<string, HTMLButtonElement>();
  for (const [id, label] of [['accounts', '계정'], ['permissions', '권한'], ['configuration', '구성']]) {
    const tab = button(label!, () => { clearForm(); view = 'list'; active = id!; render(); }); tab.setAttribute('role', 'tab'); tab.id = `${instanceId}-tab-${id}`; tab.setAttribute('aria-controls', `${instanceId}-tabpanel`); tabs.set(id!, tab); navigation.append(tab);
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
    catch (error) { const code = (error as { code?: string })?.code; message.textContent = code === 'BROWSER_RESET_REQUIRED' ? '브라우저 계정과 기록 삭제를 다시 실행해 정리를 마치세요.' : code === 'BROWSER_RESET_ACTIVE' ? '다른 창에서 브라우저 데이터를 정리하는 중입니다. 잠시 뒤 다시 시도하세요.' : code === 'BROWSER_SIGN_IN_ACTIVE' ? '별도 Chromium 창에서 로그인을 마치고 해당 계정의 로그인 확인을 누르세요.' : code === 'BROWSER_ACCOUNT_IDENTITY_MISMATCH' ? '별도 로그인 창에서 선택한 계정의 로그인 확인을 누르세요.' : code === 'BROWSER_ACCOUNT_REGISTRATION_REQUIRED' ? '이 사이트의 계정을 먼저 저장하세요.' : code === 'BROWSER_TABS_OPEN' ? '열려 있는 브라우저 탭을 닫은 뒤 실행 방식을 바꾸세요.' : code === 'BROWSER_SECURE_STORAGE_UNAVAILABLE' ? '운영체제 보안 저장소를 사용할 수 없습니다. 브라우저 구성에서 상태를 확인하세요.' : '요청을 완료하지 못했습니다. 연결을 확인하고 다시 시도하세요.'; }
    finally { busy = false; if (!disposed) render(); }
  }
  async function resetBrowser() {
    if (busy || resetConfirming || disposed || !options.isConnected()) return;
    resetConfirming = true;
    const confirmed = await confirmSheet(element, '브라우저 계정과 기록 삭제', '저장된 웹사이트 계정과 비밀번호, 로그인 상태, 쿠키, 방문 기록을 삭제합니다. 다운로드한 PDF, 프로젝트, AI 제공자 인증 정보와 사이트 권한은 유지됩니다.', { confirmLabel: '계정과 기록 삭제', destructive: true });
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
    if (!disposed && !message.textContent) message.textContent = authenticationMethod === 'mac-passkey' ? 'Google Chrome에서 패스키 인증을 마친 뒤 로그인 확인을 누르세요.' : 'Chromium 창에서 로그인을 마친 뒤 로그인 확인을 누르세요.';
  }
  /** 삭제는 항상 확인 시트를 거친다. */
  async function confirmDelete(label: string, detail: string | undefined, run: () => Promise<unknown>) {
    if (!await confirmSheet(element, `${label} 삭제`, detail, { confirmLabel: '삭제', destructive: true }) || disposed) return;
    await run();
  }
  function accountForm(account?: Partial<Account>) {
    if (localApi) return;
    clearForm(); view = 'form'; formOrigin = account?.id ? account.origin : undefined;
    formTitle = account?.id ? '비밀번호 변경' : '비밀번호 추가';
    form = createBrowserAccountForm({ request: options.request, submit: options.submit, canSubmit: options.isConnected, account, complete: (saved) => { if (saved?.id) { accountKind = 'passwords'; accountSearch = ''; selected = `a:${saved.id}`; accounts = [...accounts.filter(account => account.id !== saved.id), saved]; } clearForm(); view = 'list'; void load(); }, cancel: closeFlow });
    render();
    form?.element.querySelector<HTMLInputElement>('input:not([readonly])')?.focus();
  }
  function openImport() {
    clearForm(); view = 'import'; importStep = 'choose'; cookieSites = null; cookieChoice.clear(); localFailed = false; localMessage = ''; retryLocal = null;
    focusKey = 'flow-back'; render();
  }
  function closeFlow() {
    clearForm(); view = 'list'; importStep = 'choose'; cookieSites = null; cookieChoice.clear();
    if (localFailed) { localFailed = false; localMessage = ''; }
    focusKey = 'add'; render();
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
  /** 사이트 로고와 로그인 상태 점. */
  function siteMark(origin: string | undefined, fallback: string | undefined, size: 'row' | 'head', state?: 'on' | 'check' | 'off' | null): HTMLElement {
    const root = node('span', 'ag-browser-mark'); root.dataset.size = size;
    root.append(createSiteMark({ origin, request: iconRequest(), fallback, className: 'ag-browser-provider-mark' }));
    if (state) { const dot = node('span', 'ag-browser-presence'); dot.dataset.state = state; root.append(dot); }
    return root;
  }
  function siteChips(origins: string[]): HTMLElement {
    const list = node('ul', 'ag-browser-site-chips'); list.setAttribute('aria-label', '사이트');
    for (const origin of origins) {
      const chip = node('li', 'ag-browser-site-chip'); chip.title = origin;
      chip.append(createSiteMark({ origin, request: iconRequest(), className: 'ag-site-mark-small' }), node('span', '', siteHost(origin))); list.append(chip);
    }
    return list;
  }
  function items(kind: AccountKind): Item[] {
    const accountItems: Item[] = allAccounts()
      .filter(account => kind === 'all' || (kind === 'passwords' && account.hasPassword))
      .map(account => ({ key: `a:${account.id}`, account, local: localAccounts.find(value => value.id === account.id) }));
    const secretItems: Item[] = kind === 'all' || kind === 'secrets' ? (secrets ?? []).map(secret => ({ key: `s:${secret.id}`, secret })) : [];
    return [...accountItems, ...secretItems];
  }
  function matches(item: Item): boolean {
    const haystack = item.secret
      ? [item.secret.label, SECRET_KIND_LABELS[item.secret.kind], ...item.secret.origins]
      : [item.account.label, item.account.origin, ...(item.account.origins ?? []), visibleIdentity(item.account), accountProvider(item.account)];
    return haystack.join(' ').toLocaleLowerCase().includes(accountSearch.trim().toLocaleLowerCase());
  }
  function render() {
    if (disposed) return;
    const focused = document.activeElement as HTMLElement | null;
    if (!focusKey && focused && element.contains(focused) && focused.dataset.focusKey) focusKey = focused.dataset.focusKey;
    const searchCaret = focused instanceof HTMLInputElement && focused.dataset.focusKey === 'search' ? focused.selectionStart : null;
    for (const [id, tab] of tabs) { tab.setAttribute('aria-selected', String(id === active)); tab.tabIndex = id === active ? 0 : -1; }
    refresh.disabled = busy || localBusy || (!options.isConnected() && !localApi); body.replaceChildren(); body.setAttribute('role', 'tabpanel'); body.setAttribute('aria-labelledby', `${instanceId}-tab-${active}`);
    if (!options.isConnected() && !(active === 'accounts' && localApi)) body.append(node('p', 'ag-browser-empty', '허브에 연결하면 브라우저 설정을 관리할 수 있습니다.'));
    else if (active === 'accounts') renderAccountsTab();
    else renderOtherTabs();
    restoreFocus(searchCaret);
  }
  function renderOtherTabs() {
    if (active === 'permissions') {
      if (!sites) { body.append(node('p', 'ag-browser-empty', '권한을 불러오는 중…')); return; }
      const siteSection = section('사이트');
      const list = node('div', 'ag-browser-sites'); list.setAttribute('role', 'list'); list.setAttribute('aria-label', '사이트');
      if (!sites.length) siteSection.append(node('p', 'ag-browser-empty', '허용하거나 차단한 사이트가 없습니다.'));
      else siteSection.append(list);
      for (const site of sites) list.append(siteRow(site));
      const origin = field('사이트 주소', 'url'); origin.input.placeholder = 'example.com'; origin.input.setAttribute('aria-label', '사이트 주소');
      origin.root.querySelector('.ag-settings-field-label')?.remove(); origin.root.classList.add('ag-browser-site-add-field');
      const siteError = node('p', 'ag-browser-message'); siteError.setAttribute('role', 'alert');
      const addSite = (allow: boolean) => {
        const site = httpsSiteOrigin(origin.input.value);
        if (!site) { siteError.textContent = 'HTTPS 사이트 주소를 입력하세요.'; origin.input.focus(); return; }
        siteError.textContent = '';
        void mutate(allow ? 'sites.allow' : 'policy.update', allow ? { origin: site } : { operation: 'set-site', origin: site, allowedActions: [], blockedActions: ALL_ACTIONS });
      };
      origin.input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addSite(true); } });
      const add = node('div', 'ag-browser-site-add'); const allow = button('허용', () => addSite(true)); const block = button('차단', () => addSite(false));
      for (const control of [allow, block]) control.disabled = busy || !options.isConnected();
      add.append(origin.root, allow, block); siteSection.append(add, siteError);
      if (recipes?.length) {
        const recipeSection = section('사이트 사용법');
        const recipeList = node('div', 'ag-browser-recipes'); recipeList.setAttribute('role', 'list'); recipeList.setAttribute('aria-label', '사이트 사용법');
        for (const recipe of recipes) recipeList.append(recipeRow(recipe));
        recipeSection.append(recipeList);
      }
      const always = alwaysGrants.filter(isChatPermissionCapability);
      if (always.length) {
        const alwaysSection = section('항상 허용한 권한');
        for (const capability of always) action(row(CHAT_PERMISSION_LABELS[capability], '모든 채팅', alwaysSection), '해제', 'permissions.revoke', { capability });
      }
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
  /** 사이트 한 줄: 로고 · 이름 · 상태. 누르면 차단 편집과 허용·해제가 그 아래에 펼쳐진다. */
  function siteRow(site: SiteRow): HTMLElement {
    const item = node('div', 'ag-browser-site'); item.setAttribute('role', 'listitem'); item.dataset.site = site.key;
    const open = expandedSite === site.key;
    const head = node('button', 'ag-browser-site-row'); head.type = 'button'; head.dataset.focusKey = `site:${site.key}`;
    head.setAttribute('aria-expanded', String(open));
    head.addEventListener('click', () => { expandedSite = open ? null : site.key; focusKey = `site:${site.key}`; render(); });
    const states = node('span', 'ag-browser-site-states');
    const blocked = BLOCK_GROUPS.filter(group => group.actions.some(value => site.blockedActions.includes(value))).map(group => group.label);
    for (const [state, on, text, title] of [
      ['always', site.always, '항상 허용', ''], ['chat', site.chat && !site.always, '이 채팅', ''],
      ['signed-in', site.signedIn, '로그인됨', ''], ['blocked', blocked.length > 0, '차단', blocked.join(' · ')],
    ] as const) {
      if (!on) continue;
      const chip = node('span', 'ag-browser-site-state', text); chip.dataset.state = state; if (title) chip.title = title; states.append(chip);
    }
    const name = node('span', 'ag-browser-site-name', site.label); name.title = site.key;
    head.append(siteMark(site.key, site.label, 'row'), name, states, createChevron('ag-browser-site-caret'));
    item.append(head);
    if (!open) return item;
    const detail = node('div', 'ag-browser-site-detail');
    const blocks = node('div', 'ag-browser-site-blocks'); blocks.setAttribute('role', 'group'); blocks.setAttribute('aria-label', '차단');
    blocks.append(node('span', 'ag-browser-site-blocks-label', '차단'));
    for (const group of BLOCK_GROUPS) {
      const pressed = group.actions.some(value => site.blockedActions.includes(value));
      const toggle = node('button', 'ag-browser-site-block', group.label); toggle.type = 'button';
      toggle.setAttribute('aria-pressed', String(pressed)); toggle.dataset.focusKey = `block:${site.key}:${group.label}`;
      toggle.disabled = busy || !options.isConnected();
      toggle.addEventListener('click', () => {
        const blockedActions = pressed ? site.blockedActions.filter(value => !group.actions.includes(value)) : [...new Set([...site.blockedActions, ...group.actions])];
        void mutate('policy.update', { operation: 'set-site', origin: site.key, label: site.label, allowedActions: site.allowedActions.filter(value => !blockedActions.includes(value)), blockedActions });
      });
      blocks.append(toggle);
    }
    const actions = node('div', 'ag-browser-site-actions');
    if (!site.always) action(actions, '허용', 'sites.allow', { origin: site.key });
    if (site.always || site.chat) action(actions, '해제', 'sites.revoke', { origin: site.key });
    if (site.signedIn) action(actions, '로그인 표시 지우기', 'sites.clearSignedIn', { origin: site.key });
    detail.append(blocks, actions); item.append(detail);
    return item;
  }
  /** 사용법 한 줄: 로고 · 사이트 · 메모 앞부분. 누르면 메모 전체를 펼친다. */
  function recipeRow(recipe: SiteRecipe): HTMLElement {
    const item = node('div', 'ag-browser-recipe'); item.setAttribute('role', 'listitem'); item.dataset.site = recipe.key;
    const open = expandedRecipe === recipe.key;
    const head = node('button', 'ag-browser-recipe-row'); head.type = 'button'; head.dataset.focusKey = `recipe:${recipe.key}`;
    head.setAttribute('aria-expanded', String(open)); head.title = recipe.text;
    head.addEventListener('click', () => { expandedRecipe = open ? null : recipe.key; focusKey = `recipe:${recipe.key}`; render(); });
    const copy = node('span', 'ag-browser-recipe-copy');
    copy.append(node('span', 'ag-browser-site-name', recipe.site), node('span', 'ag-browser-recipe-text', recipe.text));
    head.append(siteMark(recipe.key, recipe.site, 'row'), copy);
    const remove = iconButton('trash', '사용법 삭제', () => void confirmDelete(`${recipe.site} 사용법`, undefined, () => mutate('recipes.delete', { site: recipe.key })), `recipe-delete:${recipe.key}`);
    remove.disabled = busy || !options.isConnected();
    item.append(head, remove);
    return item;
  }
  function restoreFocus(searchCaret: number | null) {
    if (!focusKey) return;
    const current = document.activeElement;
    if (current && current !== document.body && !element.contains(current)) { focusKey = undefined; return; }
    const target = element.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`);
    if (!target) { if (!busy && !localBusy) focusKey = undefined; return; }
    if ((target as HTMLButtonElement).disabled) return;
    target.focus({ preventScroll: true }); focusKey = undefined;
    if (target instanceof HTMLInputElement && searchCaret !== null) target.setSelectionRange(searchCaret, searchCaret);
  }
  function renderAccountsTab() {
    if (view === 'form' && form) { flow(formTitle, closeFlow, formOrigin).append(form.element); return; }
    if (view === 'import' && localApi) { renderImport(); return; }
    view = 'list';
    const toolbar = node('div', 'ag-browser-account-toolbar'); body.append(toolbar);
    const searchField = node('label', 'ag-browser-search-field'); searchField.append(createIcon('search'));
    const search = node('input', 'ag-browser-search'); search.type = 'search'; search.placeholder = '검색'; search.value = accountSearch;
    search.setAttribute('aria-label', '계정 검색'); search.dataset.focusKey = 'search'; search.spellcheck = false; search.autocomplete = 'off';
    search.addEventListener('input', () => { accountSearch = search.value; renderWorkspace(); });
    searchField.append(search); toolbar.append(searchField, addMenu());
    if (!localApi && !secureStorage && options.isConnected()) {
      const notice = node('p', 'ag-browser-notice'); notice.append(createIcon('warning'), node('span', '', '보안 저장소를 사용할 수 없어 비밀번호를 저장할 수 없습니다.')); body.append(notice);
    }
    if (accountKind === 'secrets' && !secrets) accountKind = 'all';
    const kinds = node('div', 'ag-browser-account-kinds'); kinds.setAttribute('role', 'radiogroup'); kinds.setAttribute('aria-label', '종류');
    const radios: HTMLButtonElement[] = [];
    for (const kind of KIND_FILTERS) {
      if (kind.id === 'secrets' && !secrets) continue;
      const count = items(kind.id).length;
      const radio = node('button', 'ag-browser-kind'); radio.type = 'button'; radio.setAttribute('role', 'radio');
      radio.setAttribute('aria-checked', String(accountKind === kind.id)); radio.tabIndex = accountKind === kind.id ? 0 : -1;
      radio.setAttribute('aria-label', `${kind.label} ${count}`); radio.title = kind.label; radio.dataset.kind = kind.id; radio.dataset.focusKey = `kind:${kind.id}`;
      radio.append(createIcon(kind.icon), node('span', 'ag-browser-kind-count', String(count)));
      radio.addEventListener('click', () => { if (accountKind === kind.id) return; accountKind = kind.id; selected = null; focusKey = `kind:${kind.id}`; render(); });
      radios.push(radio); kinds.append(radio);
    }
    rovingRadios(kinds, radios); toolbar.prepend(kinds);
    if (localMessage && !localBusy) { const feedback = node('p', 'ag-browser-message', localMessage); feedback.setAttribute('role', localFailed ? 'alert' : 'status'); body.append(feedback); }
    workspace = node('div', 'ag-browser-account-workspace'); body.append(workspace);
    renderWorkspace();
  }
  let workspace: HTMLElement = node('div', 'ag-browser-account-workspace');
  function renderWorkspace() {
    workspace.replaceChildren();
    const visible = items(accountKind).filter(matches);
    if (!visible.some(item => item.key === selected)) selected = visible[0]?.key ?? null;
    if (!visible.length) {
      const kind = KIND_FILTERS.find(entry => entry.id === accountKind)!;
      const actions: HTMLElement[] = [];
      if (!accountSearch.trim() && kind.id !== 'secrets') {
        const add = localApi ? ['Chrome에서 가져오기', 'browserDownload', openImport] as const : ['비밀번호 추가', 'key', () => accountForm()] as const;
        const start = node('button', 'ag-settings-btn'); start.type = 'button'; start.append(createIcon('insert'), node('span', '', add[0])); start.addEventListener('click', add[2]);
        start.disabled = busy || (add[1] === 'browserDownload' ? localBusy : !options.isConnected() || (add[1] === 'key' && !secureStorage)); actions.push(start);
      }
      workspace.append(emptyState(accountSearch.trim() ? 'search' : kind.icon, accountSearch.trim() ? '검색 결과가 없습니다.' : kind.id === 'passwords' ? '저장된 비밀번호가 없습니다.' : kind.id === 'secrets' ? '저장된 비밀 값이 없습니다.' : '저장된 항목이 없습니다.', ...actions));
      return;
    }
    const list = node('div', 'ag-browser-account-list'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', KIND_FILTERS.find(entry => entry.id === accountKind)!.label); workspace.append(list);
    for (const item of visible) {
      const entry = node('div', 'ag-browser-item');
      const choose = node('button', 'ag-browser-account-option'); choose.type = 'button'; choose.dataset.focusKey = `item:${item.key}`;
      choose.setAttribute('aria-pressed', String(item.key === selected));
      choose.addEventListener('click', () => { clearForm(); selected = item.key; renderWorkspace(); workspace.querySelector<HTMLButtonElement>('.ag-browser-account-option[aria-pressed="true"]')?.focus(); });
      const copy = node('span', 'ag-browser-account-copy'); const glyphs = node('span', 'ag-browser-glyphs');
      if (item.secret) {
        choose.dataset.secretId = item.secret.id;
        copy.append(node('strong', '', item.secret.label), node('span', '', [siteHost(item.secret.origins[0] ?? ''), item.secret.origins.length > 1 ? `+${item.secret.origins.length - 1}` : ''].filter(Boolean).join(' ')));
        choose.append(siteMark(item.secret.origins[0], item.secret.label, 'row'), copy);
        glyphs.append(createIcon('lock')); glyphs.title = SECRET_KIND_LABELS[item.secret.kind];
        choose.append(glyphs, node('span', 'ag-sr-only', [SECRET_KIND_LABELS[item.secret.kind], item.secret.blocked ? '에이전트 사용 안 함' : ''].filter(Boolean).join(', ')));
      } else {
        const account = item.account; choose.dataset.accountId = account.id;
        copy.append(node('strong', '', account.label || siteHost(account.origin)), node('span', '', visibleIdentity(account)));
        const state = presence(account);
        choose.append(siteMark(account.origin, accountProvider(account), 'row', state), copy);
        if (account.hasPassword) glyphs.append(createIcon('key'));
        glyphs.title = [sessionLabel(account), account.hasPassword ? '비밀번호 저장됨' : '', account.agentBlocked ? '에이전트 사용 안 함' : ''].filter(Boolean).join(' · ');
        choose.append(glyphs, node('span', 'ag-sr-only', glyphs.title));
      }
      glyphs.setAttribute('aria-hidden', 'true');
      entry.append(choose); list.append(entry);
      if (item.key === selected) entry.append(item.secret ? secretDetail(item.secret) : item.local ? localDetail(item.account, item.local) : accountDetail(item.account));
    }
  }
  function detailHead(details: HTMLElement, mark: HTMLElement, title: string, subtitle: string[], toggle: HTMLElement) {
    const head = node('div', 'ag-browser-detail-head'); const copy = node('div', 'ag-browser-detail-copy');
    copy.append(node('h3', 'ag-browser-detail-title', title));
    const parts = subtitle.filter(Boolean);
    if (parts.length) { const sub = node('p', 'ag-browser-detail-sub'); parts.forEach((part, index) => sub.append(node('span', index === 0 && parts.length > 1 ? 'ag-browser-detail-identity' : '', part))); copy.append(sub); }
    head.append(mark, copy, toggle); details.append(head);
  }
  function accountDetail(account: Account): HTMLElement {
    const details = node('section', 'ag-browser-account-detail'); details.dataset.accountId = account.id; details.setAttribute('aria-label', account.label || siteHost(account.origin));
    const connected = options.isConnected(); const state = presence(account);
    const mark = siteMark(account.origin, accountProvider(account), 'head', state); if (state) mark.title = sessionLabel(account);
    detailHead(details, mark, account.label || siteHost(account.origin), [visibleIdentity(account), sessionLabel(account)],
      agentSwitch(!account.agentBlocked, busy || !connected, () => void mutate('accounts.block', { accountId: account.id, blocked: !account.agentBlocked }), `switch:${account.id}`));
    details.append(siteChips(account.origins?.length ? account.origins : [account.origin]));
    const runtime = (status.runtime ?? {}) as Record<string, unknown>; const signInState = runtime.signIn as { accountId?: string } | null | undefined;
    const actions = node('div', 'ag-browser-detail-actions'); details.append(actions);
    const login = iconButton('signIn', '로그인 열기', () => void signIn(account), 'sign-in');
    login.disabled = busy || !connected || Boolean(signInState) || (account.profileId !== undefined && account.profileId !== 'default'); actions.append(login);
    const passkeys = runtime.passkeys as { supported?: boolean; reason?: string } | undefined;
    if (passkeys) {
      const passkey = iconButton('fingerprint', 'Chrome에서 Mac 패스키 사용', () => void signIn(account, 'mac-passkey'), 'passkey');
      passkey.disabled = login.disabled || !passkeys.supported;
      if (!passkeys.supported) passkey.title = ({ 'macos-required': 'Mac 패스키는 Mac에서 사용할 수 있습니다.', 'macos-13.5-required': 'Mac 패스키를 사용하려면 macOS 13.5 이상이 필요합니다.', 'macos-version-unavailable': 'macOS 버전을 확인하지 못했습니다. 브라우저 설정을 새로고침하세요.', 'signed-chrome-required': 'Mac 패스키를 사용하려면 공식 Google Chrome을 설치하세요.' } as Record<string, string>)[passkeys.reason ?? ''] ?? 'Mac 패스키 사용 가능 여부를 확인하지 못했습니다.';
      actions.append(passkey);
    }
    const pending = signInState?.accountId === account.id;
    const confirm = iconButton('checkCircle', '로그인 확인', () => void mutate('confirm-sign-in', { accountId: account.id }), 'confirm-sign-in');
    confirm.disabled = busy || !connected || Boolean(signInState?.accountId && !pending);
    // 로그인 창이 열려 있으면 확인 버튼이 이름을 달고 다음 할 일로 앞에 선다.
    if (pending) { confirm.classList.add('ag-browser-icon-btn-labeled'); confirm.append(node('span', '', '로그인 확인')); confirm.dataset.pending = 'true'; }
    actions.append(confirm);
    if (!localApi) { const update = iconButton('pencil', '비밀번호 변경', () => accountForm(account), 'change-password'); update.disabled = busy || !connected || !secureStorage; actions.append(update); }
    const signOut = iconButton('signOut', '로그아웃', () => void mutate('accounts.signout', { accountId: account.id }), 'sign-out'); signOut.disabled = busy || !connected; actions.append(signOut);
    const remove = iconButton('trash', '계정 삭제', () => void confirmDelete(account.label || siteHost(account.origin), undefined, () => mutate('accounts.forget', { accountId: account.id })), 'delete');
    remove.classList.add('ag-browser-danger'); remove.disabled = busy || !connected; actions.append(remove);
    return details;
  }
  function localDetail(account: Account, local: LocalPasswordAccount): HTMLElement {
    const details = node('section', 'ag-browser-account-detail'); details.dataset.accountId = account.id; details.setAttribute('aria-label', account.label || siteHost(account.origin));
    const blocked = local.agentBlocked === true;
    detailHead(details, siteMark(account.origin, accountProvider(account), 'head'), account.label || siteHost(account.origin), [local.username || siteHost(account.origin)],
      agentSwitch(!blocked, localBusy, () => void localAction(async () => { await localApi!.block({ id: account.id, blocked: !blocked }); await loadLocal(); return ''; }), `switch:${account.id}`));
    details.append(siteChips(local.origins?.length ? local.origins : [local.origin]));
    const actions = node('div', 'ag-browser-detail-actions'); details.append(actions);
    const source = node('span', 'ag-browser-source');
    if (local.source === 'chrome') { source.title = '가져온 Chrome 프로필'; source.append(createIcon('browserDownload'), node('span', '', local.sourceProfile || 'Chrome')); }
    const remove = iconButton('trash', '비밀번호 삭제', () => void confirmDelete(account.label || siteHost(account.origin), undefined, () => localAction(async () => { await localApi!.remove({ id: account.id }); await loadLocal(); return '삭제했습니다.'; })), 'delete');
    remove.classList.add('ag-browser-danger'); remove.disabled = localBusy; actions.append(source, remove);
    return details;
  }
  function secretDetail(secret: SecretMeta): HTMLElement {
    const details = node('section', 'ag-browser-account-detail'); details.dataset.secretId = secret.id; details.setAttribute('aria-label', secret.label);
    const connected = options.isConnected();
    detailHead(details, siteMark(secret.origins[0], secret.label, 'head'), secret.label, [SECRET_KIND_LABELS[secret.kind], secret.scope === 'chat' ? '이 채팅만' : ''],
      agentSwitch(!secret.blocked, busy || !connected, () => void mutate('secrets.block', { secretId: secret.id, blocked: !secret.blocked }), `switch:${secret.id}`));
    details.append(siteChips(secret.origins));
    const actions = node('div', 'ag-browser-detail-actions'); details.append(actions);
    const used = node('span', 'ag-browser-source'); used.title = '마지막 사용';
    used.append(createIcon('clock'), node('span', '', secret.lastUsedAt ? new Date(secret.lastUsedAt).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }) : '사용 기록 없음'));
    const remove = iconButton('trash', '삭제', () => void confirmDelete(secret.label, '저장한 값을 지웁니다.', () => mutate('secrets.delete', { secretId: secret.id })), 'delete');
    remove.classList.add('ag-browser-danger'); remove.disabled = busy || !connected; actions.append(used, remove);
    return details;
  }
  /** '+' 하나에서 비밀번호 추가 또는 Chrome 가져오기를 고른다. */
  function addMenu(): HTMLElement {
    const root = node('div', 'ag-browser-add');
    const trigger = iconButton('insert', '추가', () => { if (menu.hidden) open(); else close(); }, 'add');
    trigger.classList.add('ag-browser-add-btn'); trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false');
    const menu = node('div', 'ag-browser-add-menu'); menu.setAttribute('role', 'menu'); menu.id = `${instanceId}-add-menu`; menu.hidden = true; trigger.setAttribute('aria-controls', menu.id);
    const entries: Array<{ label: string; icon: SidebarIconName; disabled: boolean; title?: string; run(): void }> = [];
    if (!localApi) entries.push({ label: '비밀번호 추가', icon: 'key', disabled: busy || !secureStorage || !options.isConnected(), title: secureStorage ? undefined : '보안 저장소를 사용할 수 없습니다.', run: () => accountForm() });
    else entries.push({ label: 'Chrome에서 가져오기', icon: 'browserDownload', disabled: localBusy, run: openImport });
    const menuItems = entries.map((entry) => {
      const item = node('button', 'ag-browser-add-item'); item.type = 'button'; item.setAttribute('role', 'menuitem'); item.tabIndex = -1;
      item.disabled = entry.disabled; if (entry.title) item.title = entry.title;
      item.append(createIcon(entry.icon), node('span', '', entry.label)); item.addEventListener('click', () => { close(false); entry.run(); });
      menu.append(item); return item;
    });
    let outside: AbortController | null = null;
    function open() {
      menu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); menuItems.find(item => !item.disabled)?.focus();
      outside = new AbortController();
      document.addEventListener('pointerdown', (event) => { if (!root.contains(event.target as Node)) close(false); }, { capture: true, signal: outside.signal });
    }
    function close(refocus = true) { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); outside?.abort(); outside = null; if (refocus) trigger.focus(); }
    trigger.addEventListener('keydown', (event) => { if (event.key === 'ArrowDown' && menu.hidden) { event.preventDefault(); open(); } });
    menu.addEventListener('keydown', (event) => {
      const enabled = menuItems.filter(item => !item.disabled); const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === 'Tab') close(false);
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && enabled.length) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
        enabled[next]!.focus();
      }
    });
    root.append(trigger, menu); return root;
  }
  /** 양식과 가져오기는 목록 대신 한 화면을 차지하고, 뒤로(Esc)로 목록에 돌아간다. */
  function flow(title: string, back: () => void, origin?: string): HTMLElement {
    const root = node('div', 'ag-browser-flow');
    root.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); back(); } });
    const head = node('div', 'ag-browser-flow-head');
    head.append(iconButton('browserBack', '뒤로', back, 'flow-back'));
    if (origin) head.append(siteMark(origin, undefined, 'row'));
    head.append(node('h3', 'ag-browser-flow-title', title)); root.append(head); body.append(root); return root;
  }
  function renderImport() {
    const back = () => { if (importStep === 'cookies' && !localBusy) { importStep = 'choose'; cookieSites = null; cookieChoice.clear(); focusKey = 'tile:cookies'; render(); } else closeFlow(); };
    const root = flow(importStep === 'cookies' ? 'Chrome 로그인 가져오기' : 'Chrome에서 가져오기', back);
    if (localBusy) root.setAttribute('aria-busy', 'true');
    if (!localSupported && !localBusy && !localFailed) root.append(emptyState('browserDownload', 'Chrome 가져오기는 Mac에서 사용할 수 있습니다.'));
    else if (localSupported && !profiles.length && !localBusy && !localFailed) {
      const retry = button('다시 확인', () => void localAction(async () => { await loadLocal(); return ''; })); retry.dataset.focusKey = 'retry';
      root.append(emptyState('browserDownload', 'Chrome 프로필이 없습니다.', retry));
    } else if (profiles.length) {
      const picker = node('div', 'ag-browser-profiles'); picker.setAttribute('role', 'radiogroup'); picker.setAttribute('aria-label', 'Chrome 프로필');
      const radios = profiles.map((profile) => {
        const radio = node('button', 'ag-browser-profile'); radio.type = 'button'; radio.setAttribute('role', 'radio');
        radio.setAttribute('aria-checked', String(profile.id === profileId)); radio.tabIndex = profile.id === profileId ? 0 : -1; radio.disabled = localBusy || importStep === 'cookies';
        radio.dataset.profileId = profile.id; radio.dataset.focusKey = `profile:${profile.id}`;
        radio.append(node('span', 'ag-browser-profile-avatar', profile.name.slice(0, 1).toLocaleUpperCase()), node('span', '', profile.name));
        radio.addEventListener('click', () => { if (profileId === profile.id) return; profileId = profile.id; cookieSites = null; cookieChoice.clear(); focusKey = `profile:${profile.id}`; render(); });
        picker.append(radio); return radio;
      });
      rovingRadios(picker, radios); root.append(picker);
      if (importStep === 'choose') {
        const tiles = node('div', 'ag-browser-import-tiles');
        const passwords = node('button', 'ag-browser-import-tile'); passwords.type = 'button'; passwords.dataset.focusKey = 'tile:passwords'; passwords.dataset.importKind = 'passwords';
        passwords.title = 'Mac 키체인 접근을 허용하면 이 앱에 암호화해 저장합니다.'; passwords.append(createIcon('key'), node('strong', '', '비밀번호'));
        passwords.disabled = localBusy || !profileId; passwords.addEventListener('click', importPasswords);
        const logins = node('button', 'ag-browser-import-tile'); logins.type = 'button'; logins.dataset.focusKey = 'tile:cookies'; logins.dataset.importKind = 'cookies';
        logins.title = 'Chrome에 로그인한 사이트를 고릅니다.'; logins.append(createIcon('person'), node('strong', '', '로그인'));
        logins.disabled = localBusy || !profileId; logins.addEventListener('click', loadCookieSites);
        tiles.append(passwords, logins); root.append(tiles);
      } else if (cookieSites) renderCookieSites(root, cookieSites);
    }
    if (localMessage && !localBusy) { const feedback = node('p', 'ag-browser-message', localMessage); feedback.setAttribute('role', localFailed ? 'alert' : 'status'); root.append(feedback); }
    if (localFailed && retryLocal) { const retry = button('다시 시도', retryLocal); retry.dataset.focusKey = 'retry'; root.append(retry); }
  }
  function importPasswords() {
    retryLocal = importPasswords;
    void localAction(async () => {
      const result = await localApi!.importProfile({ profileId }); await loadLocal();
      view = 'list'; accountKind = 'passwords'; selected = null; accountSearch = ''; focusKey = 'kind:passwords';
      return `${result.imported}개 가져옴 · ${result.skipped}개 건너뜀${result.unsupported ? ` · ${result.unsupported}개 암호화 방식 지원 안 됨` : ''}`;
    }, '가져오지 못했습니다. Chrome과 키체인 접근 권한을 확인하고 다시 시도하세요.');
  }
  function loadCookieSites() {
    retryLocal = loadCookieSites;
    void localAction(async () => {
      const sites = (await localApi!.cookieSites({ profileId })).sites; cookieChoice.clear();
      if (!sites.length) { cookieSites = null; return '가져올 로그인이 없습니다.'; }
      cookieSites = sites; importStep = 'cookies'; focusKey = 'cookie-all'; return '';
    }, '로그인 목록을 읽지 못했습니다. Chrome과 키체인 접근 권한을 확인하고 다시 시도하세요.');
  }
  function renderCookieSites(parent: HTMLElement, sites: { domain: string; count: number }[]) {
    const root = node('div', 'ag-browser-cookie-import'); parent.append(root);
    const all = node('label', 'ag-browser-cookie-all'); const allInput = node('input', ''); allInput.type = 'checkbox'; allInput.dataset.focusKey = 'cookie-all'; allInput.disabled = localBusy;
    all.append(allInput, node('span', '', '모두 선택'), node('span', 'ag-browser-cookie-total', String(sites.length)));
    const list = node('div', 'ag-browser-cookie-sites'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'Chrome 로그인 사이트');
    const inputs: HTMLInputElement[] = [];
    const importButton = node('button', 'ag-settings-primary ag-browser-cookie-submit'); importButton.type = 'button'; importButton.dataset.focusKey = 'cookie-submit';
    const sync = () => {
      allInput.checked = cookieChoice.size === sites.length; allInput.indeterminate = cookieChoice.size > 0 && cookieChoice.size < sites.length;
      importButton.disabled = localBusy || !cookieChoice.size; importButton.textContent = cookieChoice.size ? `${cookieChoice.size}곳 가져오기` : '가져오기';
    };
    for (const site of sites) {
      const choice = node('label', 'ag-browser-cookie-site'); const input = node('input', ''); input.type = 'checkbox'; input.checked = cookieChoice.has(site.domain); input.disabled = localBusy;
      input.dataset.domain = site.domain; input.dataset.focusKey = `cookie:${site.domain}`;
      input.addEventListener('change', () => { if (input.checked) cookieChoice.add(site.domain); else cookieChoice.delete(site.domain); sync(); });
      const count = node('span', 'ag-browser-cookie-count', String(site.count)); count.title = `쿠키 ${site.count}개`;
      choice.append(input, createSiteMark({ origin: cookieOrigin(site.domain), request: iconRequest(), className: 'ag-site-mark-small' }), node('span', 'ag-browser-cookie-domain', site.domain.replace(/^\./, '')), count);
      inputs.push(input); list.append(choice);
    }
    allInput.addEventListener('change', () => { cookieChoice.clear(); if (allInput.checked) for (const site of sites) cookieChoice.add(site.domain); for (const input of inputs) input.checked = allInput.checked; sync(); });
    importButton.addEventListener('click', importCookies);
    sync(); root.append(all, list, importButton);
  }
  function importCookies() {
    retryLocal = importCookies;
    void localAction(async () => {
      const result = await localApi!.importCookies({ profileId, domains: [...cookieChoice] });
      // 가져온 사이트는 사용자가 로그인한 사이트다. 허브가 로그인됨으로 표시한다.
      if (result.domains.length && options.isConnected()) await options.request('sessions.imported', { domains: result.domains }).catch(() => undefined);
      cookieSites = null; cookieChoice.clear(); importStep = 'choose'; view = 'list'; focusKey = 'add';
      return `${result.domains.length}개 사이트 가져옴${result.skipped ? ` · ${result.skipped}개 건너뜀` : ''}`;
    }, '로그인을 가져오지 못했습니다. Chrome과 키체인 접근 권한을 확인하고 다시 시도하세요.');
  }
  async function loadLocal() {
    if (!localApi) return;
    const [available, saved] = await Promise.all([localApi.listProfiles(), localApi.list()]);
    if (disposed) return;
    profiles = available.profiles; localSupported = available.supported; localAccounts = saved.accounts;
    if (!profiles.some(profile => profile.id === profileId)) profileId = profiles[0]?.id ?? '';
  }
  async function localAction(action: () => Promise<string>, failure = '완료하지 못했습니다. 다시 시도하세요.') {
    if (disposed || localBusy) return; localBusy = true; localFailed = false; localMessage = ''; render();
    try { const result = await action(); if (!disposed) { localMessage = result; retryLocal = null; } }
    catch { if (!disposed) { localFailed = true; localMessage = failure; } }
    finally { localBusy = false; if (!disposed) render(); }
  }
  function readSecrets(result: PromiseSettledResult<unknown>): SecretMeta[] | null {
    return result.status === 'fulfilled' && Array.isArray((result.value as { secrets?: unknown })?.secrets)
      ? ((result.value as { secrets: unknown[] }).secrets.map(readSecretMeta).filter((entry): entry is SecretMeta => entry !== null)) : null;
  }
  async function load() {
    if (disposed || localBusy) return;
    if (localApi) await localAction(async () => { await loadLocal(); return ''; });
    if (!options.isConnected()) { render(); return; } const current = ++generation; message.textContent = '불러오는 중…';
    const results = await Promise.allSettled([options.request('accounts.list'), options.request('policy.list'), options.request('configuration.get'), options.request('status')]);
    // 비밀 값과 항상 허용 목록은 옛 허브에 없다 — 못 읽으면 그 칸만 감춘다.
    const [secretList, permissionList, recipeList] = await Promise.allSettled([options.request('secrets.list'), options.request('permissions.list'), options.request('recipes.list')]);
    if (disposed || generation !== current) return;
    secrets = readSecrets(secretList);
    recipes = recipeList.status === 'fulfilled' ? readSiteRecipes(recipeList.value) : null;
    alwaysGrants = permissionList.status === 'fulfilled' && Array.isArray((permissionList.value as { always?: unknown })?.always)
      ? ((permissionList.value as { always: unknown[] }).always.filter((entry): entry is string => typeof entry === 'string')) : [];
    const [a, p, c, s] = results;
    if (a?.status === 'fulfilled') { const value = a.value as { accounts: Account[]; secureStorageAvailable: boolean }; accounts = value.accounts ?? []; secureStorage = value.secureStorageAvailable === true; }
    if (p?.status === 'fulfilled') sites = readSiteRows(p.value);
    if (c?.status === 'fulfilled') configuration = c.value as Record<string, unknown>;
    if (s?.status === 'fulfilled') status = s.value as Record<string, unknown>;
    message.textContent = results.some(result => result.status === 'rejected') ? '일부 설정을 불러오지 못했습니다. 새로고침으로 다시 확인하세요.' : '';
    render();
  }
  /** 허브의 user-secrets-changed: 비밀 값 목록만 다시 읽는다. */
  async function reloadSecrets() {
    if (disposed || !options.isConnected() || busy) return;
    const current = generation; const [result] = await Promise.allSettled([options.request('secrets.list')]);
    if (disposed || generation !== current || result.status !== 'fulfilled') return;
    secrets = readSecrets(result); if (view === 'list') render();
  }
  /** 허브의 site-recipes-changed: 사용법 목록만 다시 읽는다. */
  async function reloadRecipes() {
    if (disposed || !options.isConnected() || busy) return;
    const current = generation; const [result] = await Promise.allSettled([options.request('recipes.list')]);
    if (disposed || generation !== current || result.status !== 'fulfilled') return;
    recipes = readSiteRecipes(result.value); if (view === 'list' && active === 'permissions') render();
  }
  render();
  return { element, open() { void load(); }, secretsChanged() { void reloadSecrets(); }, recipesChanged() { void reloadRecipes(); }, close() { clearForm(); view = 'list'; generation++; render(); }, setConnected() { clearForm(); generation++; render(); }, dispose() { disposed = true; generation++; clearForm(); element.remove(); } };
}
