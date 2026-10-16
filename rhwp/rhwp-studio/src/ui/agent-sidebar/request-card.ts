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
};

const capabilityTitles: Record<ChatPermissionCapability, string> = {
  'project-edit': '프로젝트를 수정하려고 합니다',
  downloads: '파일을 내려받으려고 합니다',
  browser: '브라우저를 사용하려고 합니다',
  'local-execution': '로컬 파일과 명령을 실행하려고 합니다',
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

/** 정착한 카드 한 줄의 이름. */
function settledLabel(request: ChatPermissionRequest): string {
  const host = siteHost(requestOrigin(request));
  switch (request.kind) {
    case 'browser-sign-in': return `${host} 로그인`;
    case 'browser-code': return `${host} 인증 코드`;
    case 'browser-use-account': return `${request.accountLabel || host} 계정 사용`;
    case 'browser-save-account': return `${host} 계정 저장`;
    case 'secret-save':
    case 'secret-use': return secretName(request);
    default: return labels[request.capability];
  }
}

function title(request: ChatPermissionRequest): string {
  switch (request.kind) {
    case 'browser-sign-in': return '로그인이 필요합니다';
    case 'browser-code': return '인증 코드가 필요합니다';
    case 'browser-use-account': return '저장된 계정으로 로그인할까요?';
    case 'browser-save-account': return '이 계정을 저장할까요?';
    case 'secret-save': return secretTitles[request.secretKind ?? 'other']!;
    case 'secret-use': return `저장된 ${SECRET_KIND_LABELS[request.secretKind ?? 'other']}를 사용할까요?`;
    default: return capabilityTitles[request.capability];
  }
}

/** 모든 카드가 같은 두 이름을 쓴다. 비밀 값의 '항상'은 금고에 보관, '이 채팅'은 이 채팅 동안만 기억한다. */
function scopeLabel(scope: ChatPermissionScope): string {
  return scope === 'always' ? '항상' : '이 채팅';
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
      case 'browser-use-account':
        browserAction(card, 'browser-account-use', 'accounts.approve', {
          accountId: request.accountId, requestId: request.requestId,
          ...(card.scope ? { scope: card.scope } : {}),
          ...(!request.accountId && request.origin ? { account: { origin: request.origin, label: request.accountLabel ?? request.origin, origins: request.origins } } : {}),
        }, '계정 사용을 승인하지 못했습니다.');
        return;
      case 'secret-use':
        browserAction(card, 'secret-use', 'secrets.approve', {
          requestId: request.requestId, secretId: request.secretId, ...(card.scope ? { scope: card.scope } : {}),
        }, '사용을 승인하지 못했습니다.');
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
      head.append(createSiteMark({ origin, request: options.requestBrowser }), el('span', 'ag-request-host', siteHost(origin)));
    }
    const close = el('button', 'ag-request-close');
    close.type = 'button';
    close.title = '닫기';
    close.setAttribute('aria-label', `${settledLabel(request)} 요청 닫기`);
    close.append(createIcon('close'));
    close.disabled = !connected || card.responseId !== null;
    close.dataset.focusKey = 'close';
    close.addEventListener('click', () => respond(card, 'deny'));
    head.append(close);
    return head;
  }

  function scopeControl(card: RequestCard): HTMLElement | null {
    const scopes = card.request.scopes;
    if (!scopes || scopes.length < 2) return null;
    const group = el('div', 'ag-request-scope');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', '허용 범위');
    const buttons: HTMLButtonElement[] = [];
    for (const scope of scopes) {
      const option = el('button', 'ag-request-scope-option', scopeLabel(scope));
      option.type = 'button';
      option.setAttribute('role', 'radio');
      option.dataset.scope = scope;
      const checked = card.scope === scope;
      option.setAttribute('aria-checked', String(checked));
      option.tabIndex = checked ? 0 : -1;
      option.disabled = !connected || card.responseId !== null;
      option.addEventListener('click', () => {
        card.scope = scope;
        for (const other of buttons) {
          const on = other.dataset.scope === scope;
          other.setAttribute('aria-checked', String(on));
          other.tabIndex = on ? 0 : -1;
        }
      });
      buttons.push(option);
      group.append(option);
    }
    group.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const index = buttons.findIndex((button) => button.dataset.scope === card.scope);
      const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
      const next = buttons[(index + step + buttons.length) % buttons.length]!;
      next.click();
      next.focus();
    });
    return group;
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

  function identityRow(lead: HTMLElement, name: string, detail: string): HTMLElement {
    const row = el('div', 'ag-request-identity');
    const copy = el('div', 'ag-request-identity-copy');
    copy.append(el('strong', '', name), el('span', '', detail));
    row.append(lead, copy);
    return row;
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
      case 'browser-use-account': {
        const avatar = el('span', 'ag-request-avatar', (request.accountLabel || host || '?').slice(0, 1).toLocaleUpperCase());
        nodes.push(identityRow(avatar, request.accountLabel || host, host));
        nodes.push(scopeControl(card));
        actions.append(deny(), primary(card, '허용', `${request.accountLabel || host} 계정 사용 허용`, !options.requestBrowser));
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
        nodes.push(originList(card), fields.form, scopeControl(card));
        actions.append(deny(), primary(card, '저장', `${secretName(request)} 저장`));
        break;
      }
      case 'secret-use': {
        const mark = el('span', 'ag-request-mark');
        mark.append(createIcon('key'));
        nodes.push(identityRow(mark, secretName(request), SECRET_KIND_LABELS[request.secretKind ?? 'other']), originList(card), scopeControl(card));
        actions.append(deny(), primary(card, '허용', `${secretName(request)} 사용 허용`, !options.requestBrowser));
        break;
      }
      default:
        nodes.push(scopeControl(card));
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
          scope: request.scopes?.[0] ?? null, holding: false, frameId: '', decision: 'grant' };
        cards.set(request.requestId, card);
        render(card);
      } else if (card.outcome) {
        Object.assign(card, { request, outcome: null, responseId: null, error: '', retry: null, scope: card.scope ?? request.scopes?.[0] ?? null });
        render(card);
      } else {
        const tabChanged = card.request.tabId !== request.tabId;
        card.request = request;
        if (tabChanged) render(card);
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
        const frame = state?.frame && state.tab && !state.tab.passwordProtected ? state.frame.frameId : '';
        const held = state?.tab?.controller.held === true;
        const chip = card.root.querySelector<HTMLElement>('.ag-request-chip');
        if (frame === card.frameId && chip?.dataset.holding === String(card.holding || held)) continue;
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
