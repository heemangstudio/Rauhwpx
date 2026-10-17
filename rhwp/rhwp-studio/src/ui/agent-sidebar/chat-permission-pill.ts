import type { ChatPermissionDecision, ChatPermissionOutcome, ChatPermissionRequest } from '../../agent/types.ts';
import { CHAT_PERMISSION_LABELS as labels, chatPermissionMatchesContext } from '../../agent/chat-permissions.ts';
import './chat-permission-pill.css';
import { createBrowserAccountForm, type BrowserSettingsRequest } from './browser-settings.ts';

interface PermissionPill {
  request: ChatPermissionRequest;
  root: HTMLElement;
  outcome: ChatPermissionOutcome | null;
  responseId: string | null;
  error: string;
  form?: ReturnType<typeof createBrowserAccountForm>;
  /** 로그인 요청에서 고른 방법. 허브의 결과 상태보다 이 표시가 우선한다. */
  choice?: 'shared' | 'self';
  /** 로그인 요청 카드에서 비밀번호 저장 양식을 연 상태. */
  saving?: boolean;
}

function siteHost(origin: string | undefined): string {
  try { return new URL(origin ?? '').hostname; } catch { return origin ?? ''; }
}

export function createChatPermissionController(options: {
  context(): { threadId: string; documentId: string | null };
  respond(requestId: string, decision: ChatPermissionDecision): string;
  requestBrowser?: BrowserSettingsRequest;
  submitBrowserAccount?: (args: Record<string, unknown>) => Promise<unknown>;
  /** 에이전트 탭의 조작권을 가져와 사용자가 직접 로그인하게 연다. */
  signInInTab?: (tabId: string) => Promise<boolean>;
}) {
  const pills = new Map<string, PermissionPill>();
  let connected = true;

  function render(pill: PermissionPill): void {
    const { request, root, outcome } = pill;
    const accountRequest = request;
    const loginRequest = accountRequest.kind === 'browser-use-account' && !accountRequest.accountId;
    const canSave = !!options.submitBrowserAccount;
    const loginChoices = loginRequest && !!accountRequest.origin && !!options.requestBrowser
      && (accountRequest.canShare === true || (!!accountRequest.tabId && !!options.signInInTab) || canSave);
    pill.form?.dispose();
    pill.form = undefined;
    root.replaceChildren();
    root.dataset.status = outcome?.status ?? (pill.responseId ? 'submitting' : 'pending');
    root.setAttribute('aria-label', `${labels[request.capability]} 권한 요청`);
    const label = document.createElement('span');
    label.className = 'ag-permission-label';
    label.textContent = accountRequest.kind ? `${accountRequest.kind === 'browser-save-account' ? '계정 저장' : loginRequest ? '로그인 요청' : '계정 사용'} · ${loginRequest ? siteHost(accountRequest.origin) : accountRequest.accountLabel || accountRequest.origin || ''}` : labels[request.capability];
    const status = document.createElement('span');
    status.className = 'ag-permission-status';
    status.textContent = pill.choice === 'self' && outcome ? '직접 로그인'
      : outcome?.status === 'granted' ? accountRequest.kind === 'browser-save-account' || pill.saving ? '계정 저장됨' : pill.choice === 'shared' ? '로그인 공유됨' : accountRequest.kind === 'browser-use-account' ? '계정 사용 허용됨' : '이 채팅에 허용됨'
      : outcome?.status === 'denied' ? '거절됨'
        : outcome?.status === 'expired' ? '취소됨'
          : pill.responseId ? '확인 중…' : '이 채팅에서 허용';
    if (outcome) {
      root.append(label, status);
      return;
    }
    if ((accountRequest.kind === 'browser-save-account' || loginChoices && pill.saving) && accountRequest.origin && options.submitBrowserAccount && options.requestBrowser) {
      label.textContent = `계정 저장 · ${accountRequest.origin}`;
      root.append(label);
      pill.form = createBrowserAccountForm({
        request: options.requestBrowser,
        submit: options.submitBrowserAccount,
        canSubmit: () => connected && !pill.outcome && !pill.responseId && root.isConnected && chatPermissionMatchesContext(request, options.context()),
        account: { origin: accountRequest.origin, label: accountRequest.accountLabel ?? '', origins: accountRequest.origins },
        requestId: request.requestId,
        complete: () => { pill.outcome = { status: 'granted' }; render(pill); },
        // 로그인 요청에서 연 양식은 취소하면 방법 선택으로 돌아간다.
        cancel: () => { if (pill.saving) { pill.saving = false; render(pill); } else respond(pill, 'deny'); },
      });
      pill.form.element.inert = !connected || pill.responseId !== null;
      root.append(pill.form.element);
      return;
    }
    if (loginChoices) {
      root.append(label);
      const choice = (text: string, title: string, run: () => void) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ag-permission-grant';
        button.title = title;
        button.disabled = !connected || pill.responseId !== null;
        const value = document.createElement('span');
        value.className = 'ag-permission-status';
        value.textContent = pill.responseId === text ? '확인 중…' : text;
        button.append(value);
        button.addEventListener('click', run);
        root.append(button);
      };
      if (accountRequest.canShare) choice('내 로그인 공유', `내 브라우저의 ${siteHost(accountRequest.origin)} 로그인을 에이전트 브라우저에 복사`, () => shareLogin(pill));
      if (accountRequest.tabId && options.signInInTab) choice('직접 로그인', '에이전트 탭을 직접 조작해 로그인', () => signInYourself(pill));
      if (canSave) choice('비밀번호 저장', '이 사이트의 비밀번호를 저장하고 에이전트가 쓰게 허용', () => { if (!pill.outcome && !pill.responseId) { pill.saving = true; render(pill); } });
    }
    const deny = document.createElement('button');
    deny.type = 'button';
    deny.className = 'ag-permission-deny';
    deny.textContent = '×';
    deny.title = '권한 요청 거절';
    deny.setAttribute('aria-label', `${labels[request.capability]} 권한 요청 거절`);
    deny.disabled = !connected || pill.responseId !== null;
    deny.addEventListener('click', () => respond(pill, 'deny'));
    if (loginChoices) root.append(deny);
    else {
      const grant = document.createElement('button');
      grant.type = 'button';
      grant.className = 'ag-permission-grant';
      grant.title = request.reason;
      grant.setAttribute('aria-label', `${labels[request.capability]} 권한을 이 채팅에서 허용. ${request.reason}`);
      grant.disabled = !connected || pill.responseId !== null || (accountRequest.kind === 'browser-save-account') || (accountRequest.kind === 'browser-use-account' && !options.requestBrowser);
      grant.append(label, status);
      grant.addEventListener('click', () => {
        if (accountRequest.kind === 'browser-use-account' && accountRequest.origin && options.requestBrowser) {
          if (!connected || pill.outcome || pill.responseId || !chatPermissionMatchesContext(request, options.context())) return;
          pill.responseId = 'browser-account-use'; render(pill);
          void options.requestBrowser('accounts.approve', { accountId: accountRequest.accountId, requestId: request.requestId, ...(!accountRequest.accountId ? { account: { origin: accountRequest.origin, label: accountRequest.accountLabel ?? accountRequest.origin, origins: accountRequest.origins } } : {}) }).then(() => {
            pill.outcome = { status: 'granted' }; pill.responseId = null; render(pill);
          }).catch(() => { pill.responseId = null; pill.error = '계정 사용을 승인하지 못했습니다. 다시 시도하세요.'; render(pill); });
        } else respond(pill, 'grant');
      });
      root.append(grant, deny);
    }
    if (accountRequest.kind && (!options.requestBrowser || (accountRequest.kind === 'browser-save-account' && !options.submitBrowserAccount))) pill.error = '보안 계정 연결을 사용할 수 없습니다. 설정에서 다시 시도하세요.';
    if (pill.error) {
      const error = document.createElement('span');
      error.className = 'ag-permission-error';
      error.setAttribute('role', 'alert');
      error.textContent = pill.error;
      root.append(error);
    }
  }

  function shareLogin(pill: PermissionPill): void {
    const request = pill.request;
    if (!connected || pill.outcome || pill.responseId || !options.requestBrowser || !chatPermissionMatchesContext(request, options.context())) return;
    pill.error = ''; pill.responseId = '내 로그인 공유'; render(pill);
    void options.requestBrowser('accounts.approve', { requestId: request.requestId, share: true, account: { origin: request.origin, label: request.accountLabel ?? request.origin, origins: request.origins } }).then(() => {
      pill.choice = 'shared'; pill.outcome = { status: 'granted' }; pill.responseId = null; render(pill);
    }).catch(() => { pill.responseId = null; pill.error = '로그인을 공유하지 못했습니다. 내 브라우저에서 로그인했는지 확인하세요.'; render(pill); });
  }

  function signInYourself(pill: PermissionPill): void {
    const request = pill.request;
    if (!connected || pill.outcome || pill.responseId || !request.tabId || !options.signInInTab || !chatPermissionMatchesContext(request, options.context())) return;
    pill.error = ''; pill.responseId = '직접 로그인'; render(pill);
    void options.signInInTab(request.tabId).then((opened) => {
      pill.responseId = null;
      if (!opened) { pill.error = '에이전트 탭을 찾지 못했습니다.'; render(pill); return; }
      // 사용자가 직접 로그인하므로 허브의 요청은 닫는다. 표시는 '직접 로그인'으로 남긴다.
      pill.choice = 'self'; respond(pill, 'deny');
    }).catch(() => { pill.responseId = null; pill.error = '에이전트 탭을 열지 못했습니다.'; render(pill); });
  }

  function respond(pill: PermissionPill, decision: ChatPermissionDecision): void {
    // 화면 밖 문서나 다른 채팅에 남은 버튼은 권한을 보낼 수 없다.
    if (!connected || pill.outcome || pill.responseId || !pill.root.isConnected
      || !chatPermissionMatchesContext(pill.request, options.context())) return;
    pill.error = '';
    pill.responseId = options.respond(pill.request.requestId, decision);
    render(pill);
  }

  return {
    hasRequest: (requestId: string): boolean => pills.has(requestId),
    request(request: ChatPermissionRequest): HTMLElement {
      let pill = pills.get(request.requestId);
      if (!pill) {
        const root = document.createElement('section');
        root.className = 'ag-permission-pill';
        root.dataset.requestId = request.requestId;
        pill = { request, root, outcome: null, responseId: null, error: '' };
        pills.set(request.requestId, pill);
        render(pill);
      }
      return pill.root;
    },
    resolve(requestId: string, outcome: ChatPermissionOutcome): void {
      const pill = pills.get(requestId);
      if (!pill) return;
      pill.outcome = outcome;
      pill.responseId = null;
      pill.error = '';
      render(pill);
    },
    answerResult(result: { requestId: string; responseId: string; ok: boolean; code?: string; message?: string }): void {
      const pill = pills.get(result.requestId);
      if (!pill || pill.outcome || pill.responseId !== result.responseId || result.ok) return;
      pill.responseId = null;
      pill.error = result.code === 'AGENT_BUSY' ? '작업이 끝나면 다시 눌러 주세요.'
        : result.message || '권한 허용 실패 · 다시 시도';
      render(pill);
    },
    rootsForContext(context: { threadId: string; documentId: string | null }): HTMLElement[] {
      return [...pills.values()].filter((pill) => chatPermissionMatchesContext(pill.request, context)).map((pill) => pill.root);
    },
    setConnection(next: boolean): void {
      if (connected === next) return;
      connected = next;
      for (const pill of pills.values()) {
        if (!next) pill.responseId = null;
        render(pill);
      }
    },
    dispose(): void {
      for (const pill of pills.values()) { pill.form?.dispose(); pill.root.remove(); }
      pills.clear();
    },
  };
}
