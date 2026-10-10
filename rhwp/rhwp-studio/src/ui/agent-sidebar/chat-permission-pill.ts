import type { ChatPermissionDecision, ChatPermissionOutcome, ChatPermissionRequest } from '../../agent/types.ts';
import { CHAT_PERMISSION_LABELS as labels, chatPermissionMatchesContext } from '../../agent/chat-permissions.ts';
import './chat-permission-pill.css';

interface PermissionPill {
  request: ChatPermissionRequest;
  root: HTMLElement;
  outcome: ChatPermissionOutcome | null;
  responseId: string | null;
  error: string;
}

export function createChatPermissionController(options: {
  context(): { threadId: string; documentId: string | null };
  respond(requestId: string, decision: ChatPermissionDecision): string;
}) {
  const pills = new Map<string, PermissionPill>();
  let connected = true;

  function render(pill: PermissionPill): void {
    const { request, root, outcome } = pill;
    root.replaceChildren();
    root.dataset.status = outcome?.status ?? (pill.responseId ? 'submitting' : 'pending');
    root.setAttribute('aria-label', `${labels[request.capability]} 권한 요청`);
    const label = document.createElement('span');
    label.className = 'ag-permission-label';
    label.textContent = labels[request.capability];
    const status = document.createElement('span');
    status.className = 'ag-permission-status';
    status.textContent = outcome?.status === 'granted' ? '이 채팅에 허용됨'
      : outcome?.status === 'denied' ? '거절됨'
        : outcome?.status === 'expired' ? '취소됨'
          : pill.responseId ? '확인 중…' : '이 채팅에서 허용';
    if (outcome) {
      root.append(label, status);
      return;
    }
    const grant = document.createElement('button');
    grant.type = 'button';
    grant.className = 'ag-permission-grant';
    grant.title = request.reason;
    grant.setAttribute('aria-label', `${labels[request.capability]} 권한을 이 채팅에서 허용. ${request.reason}`);
    grant.disabled = !connected || pill.responseId !== null;
    grant.append(label, status);
    grant.addEventListener('click', () => respond(pill, 'grant'));
    const deny = document.createElement('button');
    deny.type = 'button';
    deny.className = 'ag-permission-deny';
    deny.textContent = '×';
    deny.title = '권한 요청 거절';
    deny.setAttribute('aria-label', `${labels[request.capability]} 권한 요청 거절`);
    deny.disabled = grant.disabled;
    deny.addEventListener('click', () => respond(pill, 'deny'));
    root.append(grant, deny);
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
      for (const pill of pills.values()) pill.root.remove();
      pills.clear();
    },
  };
}
