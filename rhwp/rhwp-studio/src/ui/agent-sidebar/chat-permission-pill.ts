import type { ChatPermissionDecision, ChatPermissionOutcome, ChatPermissionRequest } from '../../agent/types.ts';
import { CHAT_PERMISSION_LABELS as labels, chatPermissionMatchesContext, chatPermissionShownInContext } from '../../agent/chat-permissions.ts';
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

type BrowserAccountKind = 'browser-save-account' | 'browser-use-account';

/** 브라우저 계정 요청의 종류. 문서 연결의 open·create 는 계정 요청이 아니다. */
function browserAccountKind(request: ChatPermissionRequest): BrowserAccountKind | null {
  return request.kind === 'browser-save-account' || request.kind === 'browser-use-account' ? request.kind : null;
}

function pillLabel(request: ChatPermissionRequest): string {
  const account = browserAccountKind(request);
  if (account) return `${account === 'browser-save-account' ? '계정 저장' : '계정 사용'} · ${request.accountLabel || request.origin || ''}`;
  if (request.capability === 'document-link') {
    // 문서 연결은 문서 이름만 보인다. 동작은 옆의 상태 문구가 말한다.
    return request.documentName || labels['document-link'];
  }
  return labels[request.capability];
}

/** 화면 읽기용 이름. 문서 연결은 보이는 이름에 없는 요청 종류를 앞에 붙인다. */
function pillName(request: ChatPermissionRequest): string {
  return request.capability === 'document-link' && request.documentName
    ? `${labels['document-link']} ${request.documentName}` : pillLabel(request);
}

function pillStatus(request: ChatPermissionRequest, outcome: ChatPermissionOutcome | null, submitting: boolean): string {
  const account = browserAccountKind(request);
  const documentLink = request.capability === 'document-link';
  if (outcome?.status === 'granted') {
    return account === 'browser-save-account' ? '계정 저장됨'
      : account === 'browser-use-account' ? '계정 사용 허용됨'
        : documentLink ? '연결됨' : '이 채팅에 허용됨';
  }
  if (outcome?.status === 'denied') return '거절됨';
  if (outcome?.status === 'expired') return '취소됨';
  if (submitting) return '확인 중…';
  return documentLink ? '이 채팅에 연결' : '이 채팅에서 허용';
}

export function createChatPermissionController(options: {
  context(): { threadId: string; documentId: string | null };
  respond(requestId: string, decision: ChatPermissionDecision): string;
  requestBrowser?: BrowserSettingsRequest;
  submitBrowserAccount?: (args: Record<string, unknown>) => Promise<unknown>;
  /** 최근 문서를 id 로 잇는 요청에 이름이 없으면 그 문서의 이름을 찾는다. */
  documentName?: (documentId: string) => Promise<string | null>;
}) {
  const pills = new Map<string, PermissionPill>();
  let connected = true;

  function render(pill: PermissionPill): void {
    const { request, root, outcome } = pill;
    const accountKind = browserAccountKind(request);
    const accountRequest = { ...request, kind: accountKind ?? undefined };
    pill.form?.dispose();
    pill.form = undefined;
    root.replaceChildren();
    root.dataset.status = outcome?.status ?? (pill.responseId ? 'submitting' : 'pending');
    root.dataset.capability = request.capability;
    root.setAttribute('aria-label', `${pillName(request)} 권한 요청`);
    const label = document.createElement('span');
    label.className = 'ag-permission-label';
    label.textContent = pillLabel(request);
    const status = document.createElement('span');
    status.className = 'ag-permission-status';
    status.textContent = pillStatus(request, outcome, pill.responseId !== null);
    if (outcome) {
      root.append(label, status);
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
    // 문서 연결의 전체 경로는 화면에 두지 않고 툴팁과 접근성 이름으로만 알린다.
    grant.title = request.capability === 'document-link' ? request.path ?? request.reason : request.reason;
    grant.setAttribute('aria-label', request.capability === 'document-link'
      ? `${pillName(request)}: 이 채팅에 연결. ${request.path ?? request.reason}`
      : `${labels[request.capability]} 권한을 이 채팅에서 허용. ${request.reason}`);
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
    const deny = document.createElement('button');
    deny.type = 'button';
    deny.className = 'ag-permission-deny';
    deny.textContent = '×';
    deny.title = '권한 요청 거절';
    deny.setAttribute('aria-label', `${pillName(request)} 요청 거절`);
    deny.disabled = !connected || pill.responseId !== null;
    deny.addEventListener('click', () => respond(pill, 'deny'));
    root.append(grant, deny);
    if (accountRequest.kind && (!options.requestBrowser || (accountRequest.kind === 'browser-save-account' && !options.submitBrowserAccount))) pill.error = '보안 계정 연결을 사용할 수 없습니다. 설정에서 다시 시도하세요.';
    if (pill.error) {
      const error = document.createElement('span');
      error.className = 'ag-permission-error';
      error.setAttribute('role', 'alert');
      error.textContent = pill.error;
      root.append(error);
    }
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
        const linkDocumentId = request.capability === 'document-link' && !request.documentName ? request.linkDocumentId : undefined;
        if (linkDocumentId && options.documentName) {
          const named = pill;
          void options.documentName(linkDocumentId).then((name) => {
            if (!name || pills.get(request.requestId) !== named) return;
            named.request = { ...named.request, documentName: name };
            render(named);
          }).catch(() => {});
        }
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
      return [...pills.values()].filter((pill) => chatPermissionShownInContext(pill.request, context)).map((pill) => pill.root);
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
