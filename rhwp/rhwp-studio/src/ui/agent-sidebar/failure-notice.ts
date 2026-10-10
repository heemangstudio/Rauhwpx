/**
 * 실패 알림 — 턴 하나에 하나, 턴이 끝난 자리에 놓인다. 어떤 실패인지 말하고 그 실패에 맞는
 * 조치(로그인 · 설정 · 사용량 · 다시 시도 · 리셋 후 이어서)만 보인다. 프로바이더 문구는
 * '자세히' 아래에만, 텍스트로만 넣는다 (가려졌어도 신뢰하지 않는 입력이다).
 *
 * 알림은 포커스를 가져가지 않고 키 처리기도 달지 않는다 — 입력 중인 컴포저와 문서가 그대로다.
 */
import type {
  AgentName,
  ProviderFailure,
  ProviderFailureOrigin,
  UsageSummary,
} from '../../agent/types.ts';
import type { ChatThread, ThreadFailureMessage, ThreadRetryPayload } from '../../agent/threads.ts';
import { failureDismissKey, resetAtFromLimits } from '../../agent/provider-failure.ts';

export type FailureActionId = 'login' | 'settings' | 'usage' | 'retry' | 'resume' | 'cancel-resume';

export interface FailureAction {
  id: FailureActionId;
  label: string;
  disabled?: boolean;
  /** 비활성 이유 등 보조 설명 */
  title?: string;
}

export interface FailureViewContext {
  agentLabel: string;
  now: number;
  /** 화면에 쓸 리셋 시각 — 실패에 실린 값, 없으면 사용량 보고에서 찾은 값 */
  resetAt: number | null;
  /** 로그인 실패 뒤 이 프로바이더 세션이 새 자격 증명으로 다시 연결됐다 */
  reconnected: boolean;
  /** '다시 시도' 로 할 일이 있다 (보낼 요청이 있거나, 채팅 시작을 다시 할 수 있다) */
  hasRetry: boolean;
  /** 보낼 요청이 저장돼 있다 — '리셋 후 이어서' 의 조건 */
  hasRetryPayload: boolean;
  turnRunning: boolean;
  /** 이 채팅의 가장 최근 실패 알림만 조치를 가진다 */
  isLatest: boolean;
  /** '리셋 후 이어서' 가 걸려 있다 */
  resumeArmed?: boolean;
  /** 리셋 뒤 이어서 보내려 했지만 막혔다 */
  resumeBlocked?: boolean;
  timeZone?: string;
}

export interface FailureView {
  title: string;
  /** 제목 아래 짧은 한 줄 (리셋 시각, 다시 연결됨 등) */
  line: string | null;
  actions: FailureAction[];
  /** '자세히' 아래의 가린 프로바이더 문구 */
  detail: string;
  /** 오래된 알림은 제목만 남긴다 */
  compact: boolean;
}

const RUNNING_TITLE = '작업이 끝난 뒤 다시 시도할 수 있어요';
const CONTEXT_CODES = new Set(['context_window', 'codex:contextWindowExceeded', 'claude:prompt_too_long']);
const MODEL_CODES = new Set(['model_not_found', 'claude:model_not_found']);
const CLEANUP_CODES = new Set(['cleanup_uncertain', 'AGENT_PROCESS_CLEANUP_UNCERTAIN']);

/** 리셋 시각 — 같은 날이면 시:분, 다른 날이면 월·일도 붙인다 (보는 사람의 시간대). */
export function formatResetAt(at: number, now: number, timeZone?: string): string {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const sameDay = day.format(at) === day.format(now);
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone,
    ...(sameDay ? {} : { month: 'long', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  }).format(at);
}

function isPiSetupFailure(failure: ProviderFailure): boolean {
  return failure.code === 'PI_NOT_CONFIGURED' || failure.agent === 'pi';
}

function titleFor(failure: ProviderFailure, label: string, origin: string): string {
  switch (failure.class) {
    case 'auth_required':
      return isPiSetupFailure(failure) ? 'Pi 연결 설정이 필요해요' : `${label} 로그인이 필요해요`;
    case 'usage_limit':
      return failure.code === 'openrouter_credits' ? 'OpenRouter 크레딧이 부족해요' : `${label} 사용 한도에 도달했어요`;
    case 'provider_error':
      return `${label} 서버가 요청을 처리하지 못했어요`;
    case 'network':
      return `${label}에 연결하지 못했어요`;
    case 'process_exited':
      if (failure.code === 'cli_missing') return `${label} CLI를 찾지 못했어요`;
      if (failure.code && CLEANUP_CODES.has(failure.code)) return `이전 ${label} 프로세스를 정리하지 못했어요`;
      if (failure.code === 'HUB_RESTARTED') return '에이전트 허브가 다시 시작되어 작업이 중단됐어요';
      if (origin === 'start') return `${label} CLI를 시작하지 못했어요`;
      return `${label} 실행이 중간에 멈췄어요`;
    case 'invalid_request':
      if (failure.code && CONTEXT_CODES.has(failure.code)) return `대화가 너무 길어 ${label}가 처리하지 못했어요`;
      if (failure.code === 'PI_MODEL_MISSING') return 'Pi 모델이 선택되지 않았어요';
      if (failure.code && MODEL_CODES.has(failure.code)) return `${label} 모델을 찾지 못했어요`;
      return `${label}가 요청을 거절했어요`;
    default:
      return `${label} 작업 중 오류가 발생했어요`;
  }
}

/** 실패 하나를 알림의 모양으로 — 순수 함수. */
export function failureView(failure: ProviderFailure, origin: string, ctx: FailureViewContext): FailureView {
  const title = titleFor(failure, ctx.agentLabel, origin);
  const detail = failure.message;
  if (!ctx.isLatest) return { title, line: null, actions: [], detail, compact: true };
  const actions: FailureAction[] = [];
  let line: string | null = null;
  const retryAction = (): FailureAction => ({
    id: 'retry',
    label: '다시 시도',
    ...(ctx.turnRunning ? { disabled: true, title: RUNNING_TITLE } : {}),
  });
  let retryAllowed = failure.retryable;
  const settingsCodes = failure.code === 'cli_missing' || failure.code === 'PI_MODEL_MISSING'
    || (failure.code !== null && MODEL_CODES.has(failure.code));
  switch (failure.class) {
    case 'auth_required':
      if (isPiSetupFailure(failure)) {
        actions.push({ id: 'settings', label: '설정 열기' });
      } else if (ctx.reconnected) {
        line = '다시 연결됐어요';
        retryAllowed = true;
      } else {
        actions.push({ id: 'login', label: '로그인' });
      }
      break;
    case 'usage_limit': {
      const credits = failure.code === 'openrouter_credits';
      const future = ctx.resetAt !== null && ctx.resetAt > ctx.now;
      if (ctx.resumeArmed && future) {
        line = `${formatResetAt(ctx.resetAt!, ctx.now, ctx.timeZone)}에 이어서 보낼게요`;
        actions.push({ id: 'cancel-resume', label: '취소' });
        break;
      }
      if (ctx.resumeBlocked) line = '리셋 뒤 이어서 보내지 못했어요';
      else if (!credits) {
        line = ctx.resetAt === null
          ? '리셋 시각을 알 수 없어요'
          : future ? `리셋 ${formatResetAt(ctx.resetAt, ctx.now, ctx.timeZone)}` : '리셋 시각이 지났어요';
      }
      if (future && ctx.hasRetryPayload && !ctx.resumeBlocked) {
        actions.push({
          id: 'resume',
          label: '리셋 후 이어서',
          ...(ctx.turnRunning ? { disabled: true, title: RUNNING_TITLE } : {}),
        });
      }
      actions.push({ id: 'usage', label: '사용량 보기' });
      // 리셋이 지났으면(또는 이어서 보내기가 막혔으면) 바로 다시 보낼 수 있다.
      retryAllowed = ctx.resumeBlocked === true || (ctx.resetAt !== null && !future);
      break;
    }
    case 'process_exited':
      if (failure.code && CLEANUP_CODES.has(failure.code)) line = '앱을 다시 시작한 뒤 계속해 주세요.';
      if (settingsCodes) actions.push({ id: 'settings', label: '설정 열기' });
      break;
    case 'invalid_request':
      if (settingsCodes) actions.push({ id: 'settings', label: '설정 열기' });
      break;
    default:
      break;
  }
  if (retryAllowed && ctx.hasRetry) actions.unshift(retryAction());
  return { title, line, actions, detail, compact: false };
}

/**
 * 실패한 턴 뒤 대기열을 붙잡는 이유와 짧은 설명 (대기열 줄: `{detail} · 작업이 오류로 끝나…`).
 * 허브 재시작은 끊긴 작업이다. 사용 한도는 아는 리셋 시각을 함께 적는다.
 */
export function failureQueueHold(
  failure: ProviderFailure,
  ctx: { agentLabel: string; resetAt: number | null; now: number; timeZone?: string },
): { reason: 'failed' | 'interrupted'; detail?: string } {
  const label = ctx.agentLabel;
  switch (failure.class) {
    case 'auth_required':
      return { reason: 'failed', detail: isPiSetupFailure(failure) ? 'Pi 설정 필요' : `${label} 로그인 필요` };
    case 'usage_limit': {
      if (failure.code === 'openrouter_credits') return { reason: 'failed', detail: 'OpenRouter 크레딧 부족' };
      const future = ctx.resetAt !== null && ctx.resetAt > ctx.now;
      return {
        reason: 'failed',
        detail: future ? `사용 한도 · 리셋 ${formatResetAt(ctx.resetAt!, ctx.now, ctx.timeZone)}` : '사용 한도',
      };
    }
    case 'provider_error':
      return { reason: 'failed', detail: `${label} 서버 오류` };
    case 'network':
      return { reason: 'failed', detail: `${label} 연결 실패` };
    case 'process_exited':
      if (failure.code === 'HUB_RESTARTED') return { reason: 'interrupted', detail: '허브 재시작' };
      if (failure.code && CLEANUP_CODES.has(failure.code)) return { reason: 'failed', detail: '프로세스 정리 실패' };
      if (failure.code === 'cli_missing') return { reason: 'failed', detail: `${label} CLI 없음` };
      return { reason: 'failed', detail: `${label} 실행 중단` };
    case 'invalid_request':
      return { reason: 'failed', detail: failure.code && CONTEXT_CODES.has(failure.code) ? '대화 길이 초과' : '요청 거절' };
    default:
      return { reason: 'failed' };
  }
}

/** 이전 시도가 문서를 고친 뒤 끊겼을 때 다시 보내는 요청에 덧붙이는 안내 (에이전트가 읽는다). */
export const PARTIAL_EDITS_RETRY_NOTE = '(이전 시도가 중간에 끊겨 문서 편집 일부가 이미 반영됐을 수 있습니다. 먼저 문서를 다시 읽고, 이미 반영된 편집은 반복하지 마세요.)';

/**
 * '다시 시도' 가 프로바이더에 보낼 본문. 실패한 시도가 문서를 고쳤다면 처음 요청을 그대로
 * 되풀이하지 않고 다시 읽으라는 안내를 붙인다 — 이어서 진행(S3)이 들어오면 이 한 곳이 바뀐다.
 */
export function retryRequestText(retry: ThreadRetryPayload): string {
  return retry.afterPartialEdits ? `${retry.requestText}\n\n${PARTIAL_EDITS_RETRY_NOTE}` : retry.requestText;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface FailureNoticeHandlers {
  onAction(id: FailureActionId): void;
  /** × 로 접었다 (true) 또는 '다시 보기' 로 폈다 (false) */
  onDismissChange(dismissed: boolean): void;
  onDetailToggle?(open: boolean): void;
}

export interface FailureNoticeOptions {
  dismissed: boolean;
  agent: AgentName;
  /** 다시 보낼 요청이 이전 시도의 편집을 알린다 */
  retryAfterPartialEdits?: boolean;
  /** 다시 그릴 때 '자세히' 를 펼친 채로 둔다 */
  detailOpen?: boolean;
}

/** 알림 DOM. 같은 자리에서 다시 그릴 수 있게 루트 하나를 돌려준다. */
export function createFailureNotice(view: FailureView, options: FailureNoticeOptions, handlers: FailureNoticeHandlers): HTMLElement {
  const root = el('div', `ag-msg ag-failure-notice ag-${options.agent}`);
  root.setAttribute('role', 'status');
  if (view.compact || options.dismissed) root.classList.add('ag-failure-notice-compact');
  const head = el('div', 'ag-failure-head');
  head.append(el('span', 'ag-failure-title', view.title));
  root.append(head);
  if (options.dismissed) {
    root.classList.add('ag-failure-notice-dismissed');
    const reopen = el('button', 'ag-failure-link', '다시 보기');
    reopen.type = 'button';
    reopen.addEventListener('click', () => handlers.onDismissChange(false));
    head.append(reopen);
    return root;
  }
  if (view.compact) return root;
  const close = el('button', 'ag-failure-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', '알림 닫기');
  close.addEventListener('click', () => handlers.onDismissChange(true));
  head.append(close);
  if (view.line) root.append(el('div', 'ag-failure-line', view.line));
  const actions = el('div', 'ag-failure-actions');
  for (const action of view.actions) {
    const button = el('button', 'ag-hub-retry-btn ag-failure-action', action.label);
    button.type = 'button';
    button.dataset.action = action.id;
    if (action.disabled) button.disabled = true;
    if (action.title) button.title = action.title;
    else if (action.id === 'retry' && options.retryAfterPartialEdits) {
      button.title = '이전 시도의 편집이 일부 반영됐을 수 있어 문서를 다시 읽도록 함께 알려요';
    }
    button.addEventListener('click', () => {
      if (button.disabled) return;
      handlers.onAction(action.id);
    });
    actions.append(button);
  }
  const detail = el('pre', 'ag-failure-detail', view.detail);
  detail.hidden = options.detailOpen !== true;
  if (view.detail) {
    const toggle = el('button', 'ag-failure-link ag-failure-detail-toggle', detail.hidden ? '자세히' : '접기');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', detail.hidden ? 'false' : 'true');
    toggle.addEventListener('click', () => {
      detail.hidden = !detail.hidden;
      toggle.textContent = detail.hidden ? '자세히' : '접기';
      toggle.setAttribute('aria-expanded', detail.hidden ? 'false' : 'true');
      handlers.onDetailToggle?.(!detail.hidden);
    });
    actions.append(toggle);
  }
  root.append(actions, detail);
  return root;
}

const DISMISSALS_KEY = 'rhwp-agent-failure-dismissals';
const MAX_DISMISSALS = 200;

/**
 * 닫은 알림 기억 — 창 세션 동안 (sessionStorage). 저장소가 막혀도 이 페이지 안에서는
 * 메모리로 기억한다.
 */
export function createFailureDismissals(storage: () => Storage | null = () => {
  try { return window.sessionStorage; } catch { return null; }
}) {
  let memory: string[] | null = null;
  const read = (): string[] => {
    if (memory) return memory;
    try {
      const raw = storage()?.getItem(DISMISSALS_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      memory = Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : [];
    } catch {
      memory = [];
    }
    return memory;
  };
  const write = (keys: string[]) => {
    memory = keys.slice(-MAX_DISMISSALS);
    try { storage()?.setItem(DISMISSALS_KEY, JSON.stringify(memory)); } catch { /* 메모리로만 기억한다 */ }
  };
  return {
    has(threadId: string, failure: Pick<ProviderFailure, 'class' | 'message'>): boolean {
      return read().includes(failureDismissKey(threadId, failure));
    },
    set(threadId: string, failure: Pick<ProviderFailure, 'class' | 'message'>, dismissed: boolean): void {
      const key = failureDismissKey(threadId, failure);
      const keys = read().filter((entry) => entry !== key);
      if (dismissed) keys.push(key);
      write(keys);
    },
  };
}

/** 저장된 알림 한 줄 — 이전 Studio 가 읽는 문구 (`제목 · 둘째 줄`). */
export function failureSummaryText(view: Pick<FailureView, 'title' | 'line'>): string {
  return view.line ? `${view.title} · ${view.line}` : view.title;
}

export interface FailureNoticeControllerDeps {
  /** 이 사이드바가 보여 주는 채팅 */
  thread(): ChatThread;
  persist(): void;
  /** 대화 끝(진행 표시 앞)에 붙인다 */
  append(node: HTMLElement): void;
  agentLabel(agent: AgentName): string;
  isTurnRunning(): boolean;
  isConnected(): boolean;
  /** 로그인 실패 뒤 이 프로바이더가 새 자격 증명으로 다시 연결됐다 */
  reconnected(agent: AgentName): boolean;
  openLogin(agent: AgentName): void;
  openSettings(): void;
  /** 채팅 시작이 실패했을 때의 다시 시도 */
  restartSession(): void;
  /** 저장된 요청을 컴포저와 같은 길로 다시 보낸다. 지금 보낼 수 없으면 false. */
  resend(retry: ThreadRetryPayload): boolean;
  now?: () => number;
  /** 리셋 시각 뒤 이어서 보내기까지의 여유 (시계 차이) */
  resumeGraceMs?: number;
  /** 이어서 보낼 때 연결이 끊겨 있으면 다시 연결되기를 기다리는 한도 */
  connectWaitMs?: number;
  dismissals?: ReturnType<typeof createFailureDismissals>;
}

export interface FailureNoticeInput {
  origin: ProviderFailureOrigin;
  turnId: string | null;
  /** 사용자가 보낸 메시지로 시작한 턴 (허브가 연 턴은 다시 보낼 요청이 없다) */
  userInitiated: boolean;
  /** 실패한 턴이 문서를 고쳤다 */
  wroteDocument?: boolean;
  /** 다시 보낼 요청을 두지 않는다 (거절된 대기 메시지는 이미 대기열 맨 앞에 돌아가 있다). */
  noRetry?: boolean;
}

type SendPayload = Omit<ThreadRetryPayload, 'afterPartialEdits'>;

interface ArmedResume {
  message: ThreadFailureMessage;
  timer: ReturnType<typeof setTimeout> | null;
  awaitingConnection: boolean;
}

/** setTimeout 의 최대 지연 (~24.8일) — 그보다 먼 리셋은 그 시점에 다시 잰다. */
const MAX_TIMER_DELAY = 2_147_483_647;

/**
 * 사이드바 하나의 실패 알림: 마지막 전송 요청 기억, 알림 추가·복원·다시 그리기, 닫기 기억,
 * 리셋 후 이어서 보내기 타이머 (창이 살아 있는 동안만, 저장하지 않는다).
 */
export function createFailureNoticeController(deps: FailureNoticeControllerDeps) {
  const now = deps.now ?? (() => Date.now());
  const grace = deps.resumeGraceMs ?? 30_000;
  const connectWait = deps.connectWaitMs ?? 120_000;
  const dismissals = deps.dismissals ?? createFailureDismissals();
  let lastSend: (SendPayload & { threadId: string }) | null = null;
  let limits: UsageSummary['limits'] | null = null;
  const nodes = new Map<ThreadFailureMessage, HTMLElement>();
  /** 이 페이지에서 만든 알림 — 사용량 보고에서 찾은 리셋 시각을 써 넣어도 되는 것 */
  const live = new WeakSet<ThreadFailureMessage>();
  const blocked = new WeakSet<ThreadFailureMessage>();
  const detailOpen = new WeakSet<ThreadFailureMessage>();
  /** 채팅 시작을 이미 다시 시도한 알림 — 같은 실패가 다시 오면 새 알림이 생긴다. */
  const restarted = new WeakSet<ThreadFailureMessage>();
  const resumes = new Map<string, ArmedResume>();

  function latestIn(thread: ChatThread): ThreadFailureMessage | null {
    for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
      const message = thread.messages[index]!;
      if (message.role === 'user') return null;
      if (message.kind === 'error') return message;
    }
    return null;
  }

  function resolvedResetAt(message: ThreadFailureMessage): number | null {
    if (message.failure.class !== 'usage_limit') return null;
    if (message.failure.resetAt !== null) return message.failure.resetAt;
    if (!live.has(message)) return null;
    const fromLimits = resetAtFromLimits(limits, message.failure.agent, now());
    if (fromLimits !== null) {
      message.failure.resetAt = fromLimits;
      deps.persist();
    }
    return fromLimits;
  }

  function viewFor(message: ThreadFailureMessage, thread: ChatThread, isLatest: boolean): FailureView {
    return failureView(message.failure, message.origin, {
      agentLabel: deps.agentLabel(message.failure.agent),
      now: now(),
      resetAt: resolvedResetAt(message),
      reconnected: message.failure.class === 'auth_required' && deps.reconnected(message.failure.agent),
      hasRetry: message.origin === 'start' ? !restarted.has(message) : Boolean(message.retry),
      hasRetryPayload: Boolean(message.retry),
      turnRunning: deps.isTurnRunning(),
      isLatest,
      resumeArmed: resumes.get(thread.id)?.message === message,
      resumeBlocked: blocked.has(message),
    });
  }

  function render(message: ThreadFailureMessage): HTMLElement {
    const thread = deps.thread();
    const view = viewFor(message, thread, latestIn(thread) === message);
    return createFailureNotice(view, {
      dismissed: dismissals.has(thread.id, message.failure),
      agent: message.failure.agent,
      retryAfterPartialEdits: message.retry?.afterPartialEdits === true,
      detailOpen: detailOpen.has(message),
    }, {
      onAction: (id) => act(message, id),
      onDismissChange: (dismissed) => {
        dismissals.set(thread.id, message.failure, dismissed);
        rerender(message);
      },
      onDetailToggle: (open) => {
        if (open) detailOpen.add(message);
        else detailOpen.delete(message);
      },
    });
  }

  function rerender(message: ThreadFailureMessage): void {
    const node = nodes.get(message);
    if (!node) return;
    if (!node.isConnected) {
      nodes.delete(message);
      return;
    }
    const next = render(message);
    node.replaceWith(next);
    nodes.set(message, next);
  }

  function refresh(): void {
    for (const message of [...nodes.keys()]) rerender(message);
  }

  function cancelResume(threadId: string): void {
    const armed = resumes.get(threadId);
    if (!armed) return;
    if (armed.timer) clearTimeout(armed.timer);
    resumes.delete(threadId);
  }

  function attemptResume(threadId: string, armed: ArmedResume): void {
    cancelResume(threadId);
    const { message } = armed;
    const sent = deps.thread().id === threadId && message.retry !== undefined && deps.resend(message.retry);
    if (!sent) blocked.add(message);
    refresh();
  }

  function scheduleResume(threadId: string, armed: ArmedResume, at: number): void {
    const delay = Math.max(0, at - now());
    armed.timer = setTimeout(() => {
      if (resumes.get(threadId) !== armed) return;
      if (now() < at) {
        scheduleResume(threadId, armed, at);
        return;
      }
      if (deps.isConnected()) {
        attemptResume(threadId, armed);
        return;
      }
      // 연결이 돌아오기를 잠시 기다린다. 끝내 돌아오지 않으면 다시 시도 버튼으로 남긴다.
      armed.awaitingConnection = true;
      armed.timer = setTimeout(() => {
        if (resumes.get(threadId) !== armed) return;
        resumes.delete(threadId);
        blocked.add(armed.message);
        refresh();
      }, connectWait);
    }, Math.min(delay, MAX_TIMER_DELAY));
  }

  function arm(message: ThreadFailureMessage): void {
    const thread = deps.thread();
    const resetAt = resolvedResetAt(message);
    if (resetAt === null || !message.retry || resetAt <= now()) return;
    cancelResume(thread.id);
    blocked.delete(message);
    const armed: ArmedResume = { message, timer: null, awaitingConnection: false };
    resumes.set(thread.id, armed);
    scheduleResume(thread.id, armed, resetAt + grace);
    refresh();
  }

  function retryNow(message: ThreadFailureMessage): void {
    const thread = deps.thread();
    cancelResume(thread.id);
    if (message.origin === 'start') {
      restarted.add(message);
      deps.restartSession();
      refresh();
      return;
    }
    if (!message.retry) return;
    blocked.delete(message);
    deps.resend(message.retry);
    refresh();
  }

  function act(message: ThreadFailureMessage, id: FailureActionId): void {
    switch (id) {
      case 'login':
        deps.openLogin(message.failure.agent);
        break;
      case 'settings':
      case 'usage':
        deps.openSettings();
        break;
      case 'retry':
        retryNow(message);
        break;
      case 'resume':
        arm(message);
        break;
      case 'cancel-resume':
        cancelResume(deps.thread().id);
        refresh();
        break;
    }
  }

  return {
    /** 사용자가 이 채팅에서 요청을 보냈다 — 실패하면 다시 보낼 요청이다. 걸린 이어서 보내기는 취소된다. */
    noteSend(threadId: string, payload: SendPayload): void {
      lastSend = {
        threadId,
        displayText: payload.displayText,
        requestText: payload.requestText,
        ...(payload.skillName ? { skillName: payload.skillName } : {}),
        ...(payload.skillName && payload.skillIcon ? { skillIcon: payload.skillIcon } : {}),
      };
      cancelResume(threadId);
      refresh();
    },
    /** 계획 승인·수정처럼 다시 보내면 안 되는 전송 뒤 */
    clearLastSend(): void {
      lastSend = null;
    },
    /** 실패 하나를 이 채팅의 대화 끝에 알림으로 남긴다. */
    add(failure: ProviderFailure, input: FailureNoticeInput): ThreadFailureMessage {
      const thread = deps.thread();
      const sendable = !input.noRetry && (input.origin === 'send' || (input.origin === 'turn' && input.userInitiated));
      const base = sendable && lastSend?.threadId === thread.id ? lastSend : null;
      const retry: ThreadRetryPayload | undefined = base
        ? {
          displayText: base.displayText,
          requestText: base.requestText,
          ...(base.skillName ? { skillName: base.skillName } : {}),
          ...(base.skillIcon ? { skillIcon: base.skillIcon } : {}),
          ...(input.wroteDocument ? { afterPartialEdits: true } : {}),
        }
        : undefined;
      const message: ThreadFailureMessage = {
        role: 'system',
        kind: 'error',
        text: '',
        agent: failure.agent,
        failure: { ...failure },
        origin: input.origin,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(retry ? { retry } : {}),
        at: now(),
      };
      live.add(message);
      // 새 실패가 오면 걸려 있던 이어서 보내기는 거둔다.
      cancelResume(thread.id);
      thread.messages.push(message);
      message.text = failureSummaryText(viewFor(message, thread, true));
      deps.persist();
      const node = render(message);
      nodes.set(message, node);
      deps.append(node);
      refresh();
      return message;
    },
    /** 저장된 알림을 다시 그린다 (대화 복원). */
    mount(message: ThreadFailureMessage): HTMLElement {
      const node = render(message);
      nodes.set(message, node);
      return node;
    },
    /** 이 실패 뒤 대기열을 붙잡을 이유 (사용 한도는 아는 리셋 시각 포함). */
    queueHold(message: ThreadFailureMessage): ReturnType<typeof failureQueueHold> {
      return failureQueueHold(message.failure, {
        agentLabel: deps.agentLabel(message.failure.agent),
        resetAt: resolvedResetAt(message),
        now: now(),
      });
    },
    /** 대화를 갈아 끼웠다 — 그려 둔 알림을 잊는다. */
    forgetNodes(): void {
      nodes.clear();
    },
    refresh,
    setLimits(next: UsageSummary['limits'] | null | undefined): void {
      limits = next ?? null;
      refresh();
    },
    connectionChanged(connected: boolean): void {
      if (!connected) return;
      for (const [threadId, armed] of [...resumes]) {
        if (!armed.awaitingConnection) continue;
        if (armed.timer) clearTimeout(armed.timer);
        attemptResume(threadId, armed);
      }
    },
    dispose(): void {
      for (const threadId of [...resumes.keys()]) cancelResume(threadId);
      nodes.clear();
    },
  };
}

export type FailureNoticeController = ReturnType<typeof createFailureNoticeController>;
