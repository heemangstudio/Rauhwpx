import type {
  BrowserFrame, BrowserTab, ChatPermissionCapability, ChatPermissionDecision, ChatPermissionOutcome, ChatPermissionRequest,
  ChatPermissionScope, SecretSubmitResult,
} from '../../agent/types.ts';
import { CHAT_PERMISSION_LABELS as labels, SECRET_KIND_LABELS, chatPermissionMatchesContext } from '../../agent/chat-permissions.ts';
import './request-card.css';
import { createBrowserAccountForm, type BrowserSettingsRequest } from './browser-settings.ts';
import { createIcon, type SidebarIconName } from './icons.ts';
import { createSiteMark, siteHost } from './site-mark.ts';

/** 에이전트의 요청 하나 — 대화 흐름에 놓이는 카드. 정착하면 한 줄로 접힌다. */
interface RequestCard {
  request: ChatPermissionRequest;
  root: HTMLElement;
  outcome: ChatPermissionOutcome | null;
  /** 보낸 응답을 기다리는 동안의 표식. 허브 응답 id 이거나 로컬 동작 이름. */
  responseId: string | null;
  error: string;
  retry: (() => void) | null;
  scope: ChatPermissionScope | null;
  /** 사용자가 탭을 넘겨받았다. */
  holding: boolean;
  frameId: string;
  /** 허브가 거절한 응답을 다시 보낼 때 쓴다. */
  decision: ChatPermissionDecision;
  form?: ReturnType<typeof createBrowserAccountForm>;
  secret?: SecretFields;
}

interface SecretFields {
  form: HTMLFormElement;
  label: HTMLInputElement;
  value: HTMLInputElement;
  reveal: HTMLButtonElement;
}

export interface RequestCardOptions {
  context(): { threadId: string; documentId: string | null };
  respond(requestId: string, decision: ChatPermissionDecision, scope?: ChatPermissionScope): string;
  requestBrowser?: BrowserSettingsRequest;
  submitBrowserAccount?: (args: Record<string, unknown>) => Promise<unknown>;
  submitSecret?: (args: { requestId: string; label: string; value: string; scope: ChatPermissionScope }) => Promise<SecretSubmitResult>;
  /** 요청한 탭을 보여 주고 사용자가 제어권을 넘겨받는다. */
  takeBrowserControl?: (tabId: string) => Promise<unknown>;
  /** 작업 공간이 이미 가진 그 탭의 상태와 마지막 화면. 카드는 화면을 따로 요청하지 않는다. */
  browserTab?: (tabId: string) => { tab: BrowserTab | null; frame: BrowserFrame | null };
}

const capabilityIcons: Record<ChatPermissionCapability, SidebarIconName> = {
  'project-edit': 'folder',
  downloads: 'browserDownload',
  browser: 'browser',
  'local-execution': 'terminal',
  'other-documents': 'document',
};

const capabilityTitles: Record<ChatPermissionCapability, string> = {
  'project-edit': '프로젝트를 수정하려고 합니다',
  downloads: '파일을 내려받으려고 합니다',
  browser: '브라우저를 사용하려고 합니다',
  'local-execution': '로컬 파일과 명령을 실행하려고 합니다',
  'other-documents': '다른 문서를 읽으려고 합니다',
};

const secretTitles: Record<string, string> = {
  'api-key': 'API 키가 필요합니다',
  token: '토큰이 필요합니다',
  password: '비밀번호가 필요합니다',
  other: '비밀 값이 필요합니다',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isHandoff(request: ChatPermissionRequest): boolean {
  return request.kind === 'browser-sign-in' || request.kind === 'browser-code';
}

function requestOrigin(request: ChatPermissionRequest): string | undefined {
  return request.origin ?? request.origins?.[0];
}

function secretName(request: ChatPermissionRequest): string {
  return request.secretLabel || SECRET_KIND_LABELS[request.secretKind ?? 'other'];
}

/** 사이트 사용 카드가 덮는 사이트 이름 — 등록 도메인, 없으면 호스트. */
function siteName(request: ChatPermissionRequest): string {
  return request.siteDomain || siteHost(requestOrigin(request));
}

/** 사용자가 막거나 꺼 둔 것을 다시 켜는 사이트 카드. 모든 채팅에 적용되므로 '항상'으로만 허용한다. */
function liftsBlock(request: ChatPermissionRequest): boolean {
  return request.kind === 'browser-site-access' && (Boolean(request.blocked?.length) || Boolean(request.item));
}

/** 카드가 고르게 하는 범위. 첫 값이 기본이다. 계정 저장 카드는 옛 허브가 범위를 빼도 고르게 한다. */
function offeredScopes(request: ChatPermissionRequest): ChatPermissionScope[] | undefined {
  if (liftsBlock(request)) return ['always'];
  return request.scopes ?? (request.kind === 'browser-save-account' ? ['always', 'chat'] : undefined);
}

const blockedActionLabels: Record<string, string> = {
  browse: '읽기', read: '읽기', 'website-change': '사이트 변경', download: '다운로드', 'research-import': '다운로드', 'account-use': '계정 사용',
};

/** 정착한 카드 한 줄의 이름. */
function settledLabel(request: ChatPermissionRequest): string {
  const host = request.siteDomain || siteHost(requestOrigin(request));
  switch (request.kind) {
    case 'browser-sign-in': return `${host} 로그인`;
    case 'browser-code': return `${host} 인증 코드`;
    case 'browser-site-access': return `${host} 사용`;
    case 'browser-save-account': return `${host} 계정 저장`;
    case 'secret-save': return secretName(request);
    default: return labels[request.capability];
  }
}

function title(request: ChatPermissionRequest): string {
  switch (request.kind) {
    case 'browser-sign-in': return '로그인이 필요합니다';
    case 'browser-code': return '인증 코드가 필요합니다';
    case 'browser-site-access': return liftsBlock(request) ? '차단을 풀고 허용할까요?' : '이 사이트 사용을 허용할까요?';
    case 'browser-save-account': return '이 계정을 저장할까요?';
    case 'secret-save': return secretTitles[request.secretKind ?? 'other']!;
    default: return capabilityTitles[request.capability];
  }
}

export function createRequestCardController(options: RequestCardOptions) {
  const cards = new Map<string, RequestCard>();
  let connected = true;

  const live = (card: RequestCard) => connected && !card.outcome && !card.responseId && card.root.isConnected
    && chatPermissionMatchesContext(card.request, options.context());

  function fail(card: RequestCard, message: string, retry: (() => void) | null): void {
    card.responseId = null;
    card.error = message;
    card.retry = retry;
    clearSecret(card);
    render(card);
  }

  function settle(card: RequestCard, outcome: ChatPermissionOutcome): void {
    card.outcome = outcome;
    card.responseId = null;
    card.error = '';
    card.retry = null;
    disposeInputs(card);
    render(card);
  }

  function clearSecret(card: RequestCard): void {
    if (!card.secret) return;
    card.secret.value.value = '';
    card.secret.value.type = 'password';
  }

  function disposeInputs(card: RequestCard): void {
    card.form?.dispose();
    card.form = undefined;
    if (card.secret) { clearSecret(card); card.secret.form.remove(); card.secret = undefined; }
  }

  /** 응답을 보내기 전 공통 확인 — 화면 밖 문서나 다른 채팅에 남은 카드는 응답할 수 없다. */
  function begin(card: RequestCard, marker: string): boolean {
    if (!live(card)) return false;
    card.error = '';
    card.retry = null;
    card.responseId = marker;
    render(card);
    return true;
  }

  function respond(card: RequestCard, decision: ChatPermissionDecision): void {
    if (!live(card)) return;
    card.error = '';
    card.retry = null;
    if (decision === 'deny') { clearSecret(card); card.form?.clear(); }
    card.decision = decision;
    card.responseId = options.respond(card.request.requestId, decision, decision === 'grant' ? card.scope ?? undefined : undefined);
    render(card);
  }

  function browserAction(card: RequestCard, marker: string, action: string, args: Record<string, unknown>, failure: string): void {
    if (!options.requestBrowser || !begin(card, marker)) return;
    void options.requestBrowser(action, args).then(() => {
      if (!card.outcome) settle(card, { status: 'granted' });
    }).catch(() => {
      if (!card.outcome) fail(card, failure, () => browserAction(card, marker, action, args, failure));
    });
  }

  function grant(card: RequestCard): void {
    const { request } = card;
    switch (request.kind) {
      case 'browser-site-access':
        // 차단을 푸는 카드는 모든 채팅에 적용된다. 허브는 카드에 보인 차단만 푼다.
        browserAction(card, 'browser-site-access', 'sites.approve', {
          requestId: request.requestId, scope: liftsBlock(request) ? 'always' : card.scope ?? 'chat',
        }, liftsBlock(request) ? '차단을 풀지 못했습니다.' : '사이트 사용을 허용하지 못했습니다.');
        return;
      case 'browser-sign-in':
      case 'browser-code':
        browserAction(card, 'browser-handoff-complete', 'accounts.complete', { requestId: request.requestId }, '완료를 전달하지 못했습니다.');
        return;
      case 'secret-save':
        card.secret?.form.requestSubmit();
        return;
      default:
        respond(card, 'grant');
    }
  }

  function takeover(card: RequestCard): void {
    const tabId = card.request.tabId;
    if (!tabId || !options.takeBrowserControl || !live(card)) return;
    card.error = '';
    card.retry = null;
    void options.takeBrowserControl(tabId).then(() => {
      card.holding = true;
      // 탭이 화면을 넘겨받는다. 다시 그린 단추로 초점을 되돌리면 좁은 집중 화면에서 방금 연 서랍이 닫힌다.
      if (card.root.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      if (!card.outcome) render(card);
    }).catch(() => {
      if (!card.outcome) fail(card, '탭을 열지 못했습니다.', () => takeover(card));
    });
  }

  async function submitSecret(card: RequestCard): Promise<void> {
    const fields = card.secret;
    if (!fields || !options.submitSecret) return;
    const label = fields.label.value.trim();
    const value = fields.value.value;
    // 값은 이 함수의 지역 변수로만 넘기고 입력란은 곧바로 비운다.
    clearSecret(card);
    if (!label || !value) {
      card.error = !label ? '이름을 입력하세요.' : '값을 입력하세요.';
      card.retry = null;
      render(card);
      (label ? fields.value : fields.label).focus();
      return;
    }
    if (!begin(card, 'secret-submit')) return;
    let result: SecretSubmitResult;
    try {
      result = await options.submitSecret({ requestId: card.request.requestId, label, value, scope: card.scope ?? 'always' });
    } catch {
      result = { ok: false };
    }
    if (card.outcome) return;
    if (result.ok) settle(card, { status: 'granted' });
    else fail(card, result.code === 'DISCONNECTED' ? '연결되면 다시 입력하세요.' : '저장하지 못했습니다. 다시 입력하세요.', null);
  }

  function header(card: RequestCard): HTMLElement {
    const { request } = card;
    const head = el('div', 'ag-request-head');
    const origin = requestOrigin(request);
    if (!request.kind || !origin) {
      const mark = el('span', 'ag-request-mark');
      mark.append(createIcon(request.kind?.startsWith('secret') ? 'key' : capabilityIcons[request.capability]));
      head.append(mark, el('span', 'ag-request-host', request.kind ? siteHost(origin) || '요청' : '권한 요청'));
    } else {
      head.append(createSiteMark({ origin, request: options.requestBrowser }), el('span', 'ag-request-host', siteName(request)));
    }
    const close = el('button', 'ag-request-close');
    close.type = 'button';
    close.title = '닫기';
    close.setAttribute('aria-label', `${settledLabel(request)} 요청 닫기`);
    close.append(createIcon('close'));
    close.disabled = !connected || card.responseId !== null;
    close.dataset.focusKey = 'close';
    close.addEventListener('click', () => respond(card, 'deny'));
    const scope = scopeToggle(card);
    if (scope) head.append(scope);
    head.append(close);
    return head;
  }

  /** 허용 범위 — 머리줄 오른쪽의 작은 '항상' 스위치. 끄면 이 채팅에만 적용된다. 차단을 푸는 카드는 켠 채로 잠근다. */
  function scopeToggle(card: RequestCard): HTMLElement | null {
    const scopes = offeredScopes(card.request);
    if (!scopes?.includes('always')) return null;
    const locked = scopes.length < 2;
    if (locked && !liftsBlock(card.request)) return null;
    const other = scopes.find((scope) => scope !== 'always') ?? 'always';
    const toggle = el('button', 'ag-request-scope');
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', '항상 허용');
    toggle.dataset.focusKey = 'scope';
    toggle.disabled = !connected || card.responseId !== null || locked;
    if (locked) {
      toggle.dataset.locked = 'true';
      toggle.dataset.scope = 'always';
      toggle.setAttribute('aria-checked', 'true');
      toggle.title = '차단 해제는 모든 채팅에 적용';
      toggle.append(el('span', 'ag-request-scope-label', '항상'), el('span', 'ag-request-switch'));
      return toggle;
    }
    const sync = () => {
      const on = card.scope === 'always';
      toggle.setAttribute('aria-checked', String(on));
      toggle.dataset.scope = card.scope ?? other;
      toggle.title = on ? '모든 채팅에 적용' : '이 채팅에만 적용';
    };
    toggle.append(el('span', 'ag-request-scope-label', '항상'), el('span', 'ag-request-switch'));
    toggle.addEventListener('click', () => { card.scope = card.scope === 'always' ? other : 'always'; sync(); });
    sync();
    return toggle;
  }

  function button(text: string, className: string, aria: string, disabled: boolean, click: () => void, icon?: SidebarIconName): HTMLButtonElement {
    const node = el('button', className);
    node.type = 'button';
    node.append(el('span', '', text));
    if (icon) node.append(createIcon(icon));
    node.setAttribute('aria-label', aria);
    node.disabled = disabled || !connected;
    node.addEventListener('click', click);
    return node;
  }

  function primary(card: RequestCard, text: string, aria: string, disabled = false): HTMLButtonElement {
    const node = button(text, 'ag-request-primary', aria, disabled || card.responseId !== null, () => grant(card));
    node.dataset.focusKey = 'primary';
    if (card.responseId) {
      node.dataset.busy = 'true';
      node.prepend(el('span', 'ag-request-spinner'));
    }
    return node;
  }

  function errorRow(card: RequestCard): HTMLElement | null {
    if (!card.error) return null;
    const row = el('div', 'ag-request-error');
    row.setAttribute('role', 'alert');
    row.append(createIcon('warning'), el('span', 'ag-request-error-text', card.error));
    if (card.retry) {
      const retry = el('button', 'ag-request-retry', '다시 시도');
      retry.type = 'button';
      retry.disabled = !connected;
      const run = card.retry;
      retry.addEventListener('click', run);
      row.append(retry);
    }
    return row;
  }

  function preview(card: RequestCard): HTMLElement {
    const { request } = card;
    const state = request.tabId ? options.browserTab?.(request.tabId) : undefined;
    const holding = card.holding || state?.tab?.controller.held === true;
    const chip = el('span', 'ag-request-chip');
    chip.dataset.holding = String(holding);
    if (!holding) chip.append(el('span', 'ag-request-pulse'));
    chip.append(document.createTextNode(holding ? '직접 제어 중' : '에이전트 대기 중'));
    const frame = state?.frame && state.tab && !state.tab.passwordProtected ? state.frame : null;
    card.frameId = frame?.frameId ?? '';
    if (!frame) {
      const row = el('div', 'ag-request-status');
      row.append(chip);
      return row;
    }
    const thumb = el('div', 'ag-request-thumb');
    const image = el('img', 'ag-request-thumb-image');
    image.alt = `${siteHost(requestOrigin(request))} 화면`;
    image.draggable = false;
    image.src = `data:${frame.mimeType};base64,${frame.data}`;
    thumb.append(image, chip);
    return thumb;
  }

  function secretFields(card: RequestCard): SecretFields {
    if (card.secret) return card.secret;
    const form = el('form', 'ag-request-form');
    form.noValidate = true;
    const label = el('input', 'ag-request-input');
    label.type = 'text';
    label.maxLength = 80;
    label.value = card.request.secretLabel ?? '';
    label.placeholder = '이름';
    label.setAttribute('aria-label', '이름');
    label.autocomplete = 'off';
    label.spellcheck = false;
    const field = el('div', 'ag-request-secret');
    const value = el('input', 'ag-request-input');
    value.type = 'password';
    value.placeholder = SECRET_KIND_LABELS[card.request.secretKind ?? 'other'];
    value.setAttribute('aria-label', SECRET_KIND_LABELS[card.request.secretKind ?? 'other']);
    value.autocomplete = 'new-password';
    value.spellcheck = false;
    value.setAttribute('autocapitalize', 'off');
    value.setAttribute('data-1p-ignore', 'true');
    value.setAttribute('data-lpignore', 'true');
    const reveal = el('button', 'ag-request-reveal');
    reveal.type = 'button';
    const paintReveal = () => {
      const shown = value.type === 'text';
      reveal.replaceChildren(createIcon(shown ? 'eyeOff' : 'eye'));
      reveal.setAttribute('aria-pressed', String(shown));
      reveal.setAttribute('aria-label', shown ? '값 숨기기' : '값 보기');
      reveal.title = shown ? '숨기기' : '보기';
    };
    reveal.addEventListener('click', () => { value.type = value.type === 'password' ? 'text' : 'password'; paintReveal(); value.focus(); });
    paintReveal();
    field.append(value, reveal);
    form.append(label, field);
    form.addEventListener('submit', (event) => { event.preventDefault(); void submitSecret(card); });
    // 칸이 둘이라 Enter 가 저절로 제출되지 않는다. 한글 조합 중의 Enter 는 조합만 끝낸다.
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing && event.target instanceof HTMLInputElement) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    card.secret = { form, label, value, reveal };
    return card.secret;
  }

  function originList(card: RequestCard): HTMLElement | null {
    const origins = card.request.origins ?? [];
    if (origins.length < 2) return null;
    const list = el('div', 'ag-request-origins');
    list.setAttribute('aria-label', '사용할 사이트');
    for (const origin of origins) {
      const item = el('span', 'ag-request-origin');
      item.append(createSiteMark({ origin, request: options.requestBrowser, className: 'ag-site-mark-small' }), el('span', '', siteHost(origin)));
      list.append(item);
    }
    return list;
  }

  /** 사이트 사용 카드의 차단 줄 — 승인하면 풀릴 동작. */
  function blockedBanner(request: ChatPermissionRequest): HTMLElement | null {
    const actions = [...new Set((request.blocked ?? []).map((action) => blockedActionLabels[action] ?? action))];
    if (!actions.length) return null;
    const row = el('div', 'ag-request-blocked');
    row.append(createIcon('shield'), el('span', '', `${actions.join(' · ')} 차단됨`));
    return row;
  }

  /** 이 사이트에서 함께 쓸 저장된 로그인과 비밀 값. 꺼 둔 항목은 '꺼짐'으로 보이고, 카드가 가리킨 항목만 승인하면 다시 켜진다. */
  function siteItems(request: ChatPermissionRequest): HTMLElement | null {
    const items = [
      ...(request.logins ?? []).map((item) => ({ item, icon: 'person' as const })),
      ...(request.secrets ?? []).map((item) => ({ item, icon: 'key' as const })),
    ];
    if (!items.length) return null;
    const list = el('ul', 'ag-request-items');
    list.setAttribute('aria-label', '함께 쓸 항목');
    const shown = items.length > 3 ? items.slice(0, 2) : items;
    for (const { item, icon } of shown) {
      const row = el('li', 'ag-request-item');
      row.append(createIcon(icon), el('span', 'ag-request-item-label', item.label));
      if (item.detail) row.append(el('span', 'ag-request-item-detail', item.detail));
      if (item.blocked) { row.dataset.blocked = 'true'; row.append(el('span', 'ag-request-item-off', '꺼짐')); }
      list.append(row);
    }
    if (shown.length < items.length) list.append(el('li', 'ag-request-item ag-request-item-more', `외 ${items.length - shown.length}개`));
    return list;
  }

  function render(card: RequestCard): void {
    const { request, root, outcome } = card;
    const focused = root.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focusKey : undefined;
    root.dataset.kind = request.kind ?? 'permission';
    root.dataset.status = outcome?.status ?? (card.responseId ? 'submitting' : 'pending');
    if (outcome) {
      root.dataset.settled = 'true';
      const status = outcome.status === 'granted' ? '완료' : outcome.status === 'denied' ? '닫음' : '만료됨';
      const origin = requestOrigin(request);
      const lead = origin && request.kind ? createSiteMark({ origin, request: options.requestBrowser, className: 'ag-site-mark-small' }) : el('span', 'ag-request-mark ag-request-mark-small');
      if (!lead.classList.contains('ag-site-mark')) lead.append(createIcon(outcome.status === 'granted' ? 'check' : 'close'));
      root.setAttribute('aria-label', `${settledLabel(request)} ${status}`);
      root.replaceChildren(lead, el('span', 'ag-request-done-label', settledLabel(request)), el('span', 'ag-request-done-status', status));
      return;
    }
    delete root.dataset.settled;
    const heading = title(request);
    root.setAttribute('aria-label', heading);
    const titleNode = el('h4', 'ag-request-title', heading);
    titleNode.title = request.reason;
    const nodes: Array<HTMLElement | null> = [header(card), titleNode];
    const host = siteHost(requestOrigin(request));
    let actions: HTMLElement | null = el('div', 'ag-request-actions');
    const deny = (text = '거절') => {
      const node = button(text, 'ag-request-secondary', `${settledLabel(request)} 거절`, card.responseId !== null, () => respond(card, 'deny'));
      node.dataset.focusKey = 'secondary';
      return node;
    };
    switch (request.kind) {
      case 'browser-sign-in':
      case 'browser-code': {
        nodes.push(preview(card));
        const holding = card.holding || (request.tabId ? options.browserTab?.(request.tabId)?.tab?.controller.held === true : false);
        const control = button(holding ? '탭 보기' : request.kind === 'browser-code' ? '직접 입력' : '직접 하기', 'ag-request-secondary',
          `${host} 탭을 직접 조작`, !request.tabId || !options.takeBrowserControl || card.responseId !== null, () => takeover(card), holding ? undefined : 'external');
        control.dataset.focusKey = 'takeover';
        actions.append(control, primary(card, '완료', `${host} ${request.kind === 'browser-code' ? '인증 코드 입력' : '로그인'} 완료`, !options.requestBrowser));
        break;
      }
      case 'browser-site-access': {
        // 쓸 로그인·비밀 값은 이름만 한 줄씩 보인다. 값은 카드에 오지 않는다.
        const lifting = liftsBlock(request);
        nodes.push(blockedBanner(request), siteItems(request));
        actions.append(deny(), primary(card, lifting ? '차단 해제' : '허용', `${siteName(request)} ${lifting ? '차단 해제' : '사용 허용'}`, !options.requestBrowser));
        break;
      }
      case 'browser-save-account': {
        if (request.origin && options.submitBrowserAccount && options.requestBrowser) {
          card.form ??= createBrowserAccountForm({
            request: options.requestBrowser,
            submit: options.submitBrowserAccount,
            variant: 'card',
            canSubmit: () => live(card),
            account: { origin: request.origin, label: request.accountLabel ?? '', origins: request.origins },
            requestId: request.requestId,
            scope: () => card.scope ?? 'always',
            federated: () => browserAction(card, 'browser-federated', 'accounts.federated', { requestId: request.requestId, scope: card.scope ?? 'chat' }, '로그인 상태를 전달하지 못했습니다.'),
            complete: () => settle(card, { status: 'granted' }),
            cancel: () => respond(card, 'deny'),
          });
          card.form.element.inert = !connected || card.responseId !== null;
          nodes.push(card.form.element);
          actions = null;
        } else {
          card.error ||= '보안 계정 저장을 사용할 수 없습니다.';
          actions.append(deny('저장 안 함'));
        }
        break;
      }
      case 'secret-save': {
        if (!options.submitSecret) {
          card.error ||= '보안 저장소를 사용할 수 없습니다.';
          actions.append(deny());
          break;
        }
        const fields = secretFields(card);
        fields.form.inert = !connected || card.responseId !== null;
        nodes.push(originList(card), fields.form);
        actions.append(deny(), primary(card, '저장', `${secretName(request)} 저장`));
        break;
      }
      default:
        actions.append(deny(), primary(card, '허용', `${labels[request.capability]} 권한 허용. ${request.reason}`));
    }
    nodes.push(errorRow(card), actions);
    root.replaceChildren(...nodes.filter((node): node is HTMLElement => node !== null));
    if (focused) root.querySelector<HTMLElement>(`[data-focus-key="${focused}"]`)?.focus();
  }

  return {
    hasRequest: (requestId: string): boolean => cards.has(requestId),
    /** 같은 요청이 다시 오면(재연결·채팅 재시작) 허브가 아직 열어 둔 것이다 — 정착한 카드도 다시 연다. */
    request(request: ChatPermissionRequest): HTMLElement {
      let card = cards.get(request.requestId);
      if (!card) {
        const root = el('section', 'ag-request-card');
        root.dataset.requestId = request.requestId;
        card = { request, root, outcome: null, responseId: null, error: '', retry: null,
          scope: offeredScopes(request)?.[0] ?? null, holding: false, frameId: '', decision: 'grant' };
        cards.set(request.requestId, card);
        render(card);
      } else if (card.outcome) {
        Object.assign(card, { request, outcome: null, responseId: null, error: '', retry: null, scope: card.scope ?? offeredScopes(request)?.[0] ?? null });
        render(card);
      } else {
        // 허브가 같은 사이트 요청을 다시 보내며 항목이나 차단을 바꿨을 수 있다.
        const siteState = (entry: ChatPermissionRequest) => JSON.stringify([entry.logins, entry.secrets, entry.blocked, entry.item]);
        const changed = card.request.tabId !== request.tabId || siteState(card.request) !== siteState(request);
        card.request = request;
        if (changed) render(card);
      }
      return card.root;
    },
    resolve(requestId: string, outcome: ChatPermissionOutcome): void {
      const card = cards.get(requestId);
      if (!card) return;
      settle(card, outcome);
    },
    answerResult(result: { requestId: string; responseId: string; ok: boolean; code?: string; message?: string }): void {
      const card = cards.get(result.requestId);
      if (!card || card.outcome || card.responseId !== result.responseId || result.ok) return;
      const decision = card.decision;
      fail(card, result.code === 'AGENT_BUSY' ? '작업이 끝나면 다시 시도하세요.'
        : result.code === 'DISCONNECTED' ? '연결되면 다시 시도하세요.'
          : result.message || '전달하지 못했습니다.', () => respond(card, decision));
    },
    rootsForContext(context: { threadId: string; documentId: string | null }): HTMLElement[] {
      return [...cards.values()].filter((card) => chatPermissionMatchesContext(card.request, context)).map((card) => card.root);
    },
    /** 작업 공간의 탭이나 화면이 바뀌었다 — 넘김 카드의 미리보기만 고친다. */
    browserChanged(): void {
      for (const card of cards.values()) {
        if (card.outcome || !isHandoff(card.request) || !card.root.isConnected || !card.request.tabId) continue;
        const state = options.browserTab?.(card.request.tabId);
        const frame = state?.frame && state.tab && !state.tab.passwordProtected ? state.frame : null;
        const held = state?.tab?.controller.held === true;
        const chip = card.root.querySelector<HTMLElement>('.ag-request-chip');
        const sameHold = chip?.dataset.holding === String(card.holding || held);
        if ((frame?.frameId ?? '') === card.frameId && sameHold) continue;
        // 새 화면만 왔으면 그림만 바꾼다. 카드를 다시 만들면 누르는 중인 버튼이 사라져 클릭이 빠진다.
        const image = card.root.querySelector<HTMLImageElement>('.ag-request-thumb-image');
        if (frame && image && card.frameId && sameHold) {
          image.src = `data:${frame.mimeType};base64,${frame.data}`;
          card.frameId = frame.frameId;
          continue;
        }
        render(card);
      }
    },
    setConnection(next: boolean): void {
      if (connected === next) return;
      connected = next;
      for (const card of cards.values()) {
        if (!next) {
          // 끊기면 보낸 응답의 결과를 알 수 없다. 입력한 비밀 값도 남기지 않는다.
          card.responseId = null;
          clearSecret(card);
          card.form?.clear();
        }
        render(card);
      }
    },
    dispose(): void {
      for (const card of cards.values()) { disposeInputs(card); card.root.remove(); }
      cards.clear();
    },
  };
}
