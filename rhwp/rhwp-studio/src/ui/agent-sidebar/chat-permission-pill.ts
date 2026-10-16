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
}

function siteHost(origin: string | undefined): string {
  try { return origin ? new URL(origin).hostname : ''; } catch { return origin ?? ''; }
}

export function createChatPermissionController(options: {
  context(): { threadId: string; documentId: string | null };
  respond(requestId: string, decision: ChatPermissionDecision): string;
  requestBrowser?: BrowserSettingsRequest;
  submitBrowserAccount?: (args: Record<string, unknown>) => Promise<unknown>;
  /** 요청한 탭을 보여 주고 사용자가 제어권을 넘겨받는다. */
  takeBrowserControl?: (tabId: string) => Promise<unknown>;
}) {
  const pills = new Map<string, PermissionPill>();
  let connected = true;

  function render(pill: PermissionPill): void {
    const { request, root, outcome } = pill;
    const accountRequest = request;
    const handoff = request.kind === 'browser-sign-in' || request.kind === 'browser-code';
    const host = siteHost(request.origin);
    pill.form?.dispose();
    pill.form = undefined;
    root.replaceChildren();
    root.dataset.status = outcome?.status ?? (pill.responseId ? 'submitting' : 'pending');
    root.setAttribute('aria-label', `${labels[request.capability]} 권한 요청`);
    const label = document.createElement('span');
    label.className = 'ag-permission-label';
    label.textContent = handoff ? `${request.kind === 'browser-code' ? '인증 코드 필요' : '로그인 필요'} · ${host}`
      : accountRequest.kind === 'browser-use-account' ? `계정 사용 · ${[accountRequest.accountLabel, host].filter((value, index, all) => value && all.indexOf(value) === index).join(' · ')}`
        : accountRequest.kind ? `계정 저장 · ${accountRequest.accountLabel || accountRequest.origin || ''}` : labels[request.capability];
    const status = document.createElement('span');
    status.className = 'ag-permission-status';
    status.textContent = outcome?.status === 'granted' ? handoff ? '완료' : accountRequest.kind === 'browser-save-account' ? '계정 저장됨' : accountRequest.kind === 'browser-use-account' ? '허용됨' : '이 채팅에 허용됨'
      : outcome?.status === 'denied' ? handoff ? '닫힘' : '거절됨'
        : outcome?.status === 'expired' ? '취소됨'
          : pill.responseId ? '확인 중…' : accountRequest.kind === 'browser-use-account' ? '에이전트 사용 허용' : '이 채팅에서 허용';
    if (outcome) {
      root.append(label, status);
      return;
    }
    if (handoff) {
      root.dataset.kind = 'handoff';
      const live = () => connected && !pill.outcome && !pill.responseId && root.isConnected && chatPermissionMatchesContext(request, options.context());
      const takeover = actionButton('직접 하기', `${host} 탭을 직접 조작`, !request.tabId || !options.takeBrowserControl, () => {
        if (!live() || !request.tabId) return;
        pill.error = '';
        void options.takeBrowserControl!(request.tabId).catch(() => { pill.error = '탭을 열지 못했습니다.'; render(pill); });
      });
      const done = actionButton('완료', `${host} ${request.kind === 'browser-code' ? '인증 코드 입력' : '로그인'} 완료`, !options.requestBrowser, () => {
        if (!live() || !options.requestBrowser) return;
        pill.responseId = 'browser-handoff-complete'; pill.error = ''; render(pill);
        void options.requestBrowser('accounts.complete', { requestId: request.requestId }).then(() => {
          pill.outcome = { status: 'granted' }; pill.responseId = null; render(pill);
        }).catch(() => { pill.responseId = null; pill.error = '완료하지 못했습니다. 다시 시도하세요.'; render(pill); });
      });
      done.classList.add('ag-permission-done');
      root.append(label, takeover, done, denyButton(pill, `${label.textContent} 닫기`));
      appendError(pill);
      return;
    }
    if (accountRequest.kind === 'browser-save-account' && accountRequest.origin && options.submitBrowserAccount && options.requestBrowser) {
      label.textContent = `계정 저장 · ${accountRequest.origin}`;
      root.append(label);
      pill.form = createBrowserAccountForm({
        request: options.requestBrowser,
        submit: options.submitBrowserAccount,
        canSubmit: () => connected && !pill.outcome && !pill.responseId && root.isConnected && chatPermissionMatchesContext(request, options.context()),
        account: { origin: accountRequest.origin, label: accountRequest.accountLabel ?? '', origins: accountRequest.origins },
        requestId: request.requestId,
        complete: () => { pill.outcome = { status: 'granted' }; render(pill); },
        cancel: () => respond(pill, 'deny'),
      });
      pill.form.element.inert = !connected || pill.responseId !== null;
      root.append(pill.form.element);
      return;
    }
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
    root.append(grant, denyButton(pill, `${labels[request.capability]} 권한 요청 거절`));
    if (accountRequest.kind && (!options.requestBrowser || (accountRequest.kind === 'browser-save-account' && !options.submitBrowserAccount))) pill.error = '보안 계정 연결을 사용할 수 없습니다. 설정에서 다시 시도하세요.';
    appendError(pill);
  }

  function actionButton(text: string, aria: string, disabled: boolean, click: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ag-permission-action';
    button.textContent = text;
    button.setAttribute('aria-label', aria);
    button.disabled = disabled || !connected;
    button.addEventListener('click', click);
    return button;
  }

  function denyButton(pill: PermissionPill, aria: string): HTMLButtonElement {
    const deny = document.createElement('button');
    deny.type = 'button';
    deny.className = 'ag-permission-deny';
    deny.textContent = '×';
    deny.title = '요청 닫기';
    deny.setAttribute('aria-label', aria);
    deny.disabled = !connected || pill.responseId !== null;
    deny.addEventListener('click', () => respond(pill, 'deny'));
    return deny;
  }

  function appendError(pill: PermissionPill): void {
    if (!pill.error) return;
    const error = document.createElement('span');
    error.className = 'ag-permission-error';
    error.setAttribute('role', 'alert');
    error.textContent = pill.error;
    pill.root.append(error);
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
