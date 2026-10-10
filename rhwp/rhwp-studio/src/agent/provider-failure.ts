/**
 * 프로바이더 실패를 Studio 쪽에서 다루는 순수 함수 모음.
 *
 * - 허브가 보낸 `failure` 를 검증하고 한계를 씌운다 (readProviderFailure).
 * - `failure` 가 없는 이전 허브의 문구·코드를 분류한다 (legacyProviderFailure).
 * - 한 턴의 error·turn-end 를 실패 알림 하나로 모은다 (createTurnFailureCollector).
 *
 * 노드 테스트와 사이드바 미리보기도 이 모듈을 그대로 쓰므로 상대 경로 import 만 둔다.
 */
import type {
  AgentName,
  AgentStreamEvent,
  ProviderFailure,
  ProviderFailureClass,
  ProviderQuota,
} from './types.ts';

export const PROVIDER_FAILURE_CLASSES: readonly ProviderFailureClass[] = Object.freeze([
  'auth_required',
  'usage_limit',
  'provider_error',
  'network',
  'process_exited',
  'invalid_request',
  'unknown',
]);

export const MAX_FAILURE_MESSAGE = 2000;
/** 리셋 시각으로 받아 줄 미래 한계 — 주간 창보다 넉넉하다. 그 너머는 깨진 값이다. */
const MAX_RESET_AHEAD_MS = 400 * 24 * 60 * 60 * 1000;
const CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const AGENT_NAMES: readonly AgentName[] = ['claude', 'codex', 'pi', 'grok', 'cursor', 'opencode'];

function isAgentName(value: unknown): value is AgentName {
  return typeof value === 'string' && (AGENT_NAMES as readonly string[]).includes(value);
}

function isFailureClass(value: unknown): value is ProviderFailureClass {
  return typeof value === 'string' && (PROVIDER_FAILURE_CLASSES as readonly string[]).includes(value);
}

function capMessage(text: string): string {
  if (text.length <= MAX_FAILURE_MESSAGE) return text;
  let end = MAX_FAILURE_MESSAGE - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xD800 && code <= 0xDBFF) end -= 1;
  return `${text.slice(0, end)}…`;
}

function defaultRetryable(failureClass: ProviderFailureClass, code: string | null): boolean {
  if (failureClass === 'process_exited') {
    return code !== 'cli_missing' && code !== 'cleanup_uncertain' && code !== 'AGENT_PROCESS_CLEANUP_UNCERTAIN';
  }
  return failureClass === 'provider_error' || failureClass === 'network' || failureClass === 'unknown';
}

/** 저장되거나 받은 리셋 시각을 받아들일지 — 지난 값은 그대로 둔다 ('리셋 시각이 지났어요'). */
function readResetAt(value: unknown, now: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  if (value > now + MAX_RESET_AHEAD_MS) return null;
  return Math.round(value);
}

/**
 * 허브(또는 저장된 대화)가 준 실패를 검증한다. 모르는 클래스는 'unknown', 문구는 2000자,
 * 규칙에 맞지 않는 코드는 null 이 된다. 실패 모양이 아니면(어댑터 단서가 새어 온 경우 등) null.
 */
export function readProviderFailure(raw: unknown, agent: AgentName, now = Date.now()): ProviderFailure | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.class !== 'string' || typeof value.message !== 'string') return null;
  const failureClass = isFailureClass(value.class) ? value.class : 'unknown';
  const code = typeof value.code === 'string' && CODE_PATTERN.test(value.code) ? value.code : null;
  return {
    class: failureClass,
    agent: isAgentName(value.agent) ? value.agent : agent,
    message: capMessage(value.message),
    code,
    retryable: typeof value.retryable === 'boolean' ? value.retryable : defaultRetryable(failureClass, code),
    resetAt: failureClass === 'usage_limit' ? readResetAt(value.resetAt, now) : null,
  };
}

/** 이전 허브용 인증 실패 문구 (예전 사이드바의 칩 규칙과 같다). */
const LEGACY_AUTH_TEXT = /\/login|not logged in|log ?in again|oauth token|token (?:has )?expired|invalid api key|authentication|unauthori[sz]ed|\b401\b/i;
const LEGACY_HUB_CODES: Readonly<Record<string, ProviderFailureClass>> = Object.freeze({
  AGENT_AUTH_REQUIRED: 'auth_required',
  PI_NOT_CONFIGURED: 'auth_required',
  AGENT_SPAWN_FAILED: 'process_exited',
  AGENT_PROCESS_CLEANUP_UNCERTAIN: 'process_exited',
});

/** 가리지 않고 보낸 이전 허브의 문구에서 흔한 자격 증명 모양만 지운다. */
function redactLegacyText(text: string): string {
  return text
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, '[redacted]')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s)\]}>"']*/gi, '$1?[redacted]')
    .trim();
}

/** 프로바이더 실패로 보는 허브 chat-error 코드인지. */
export function isProviderHubErrorCode(code: unknown): boolean {
  return typeof code === 'string' && code in LEGACY_HUB_CODES;
}

/**
 * `failure` 를 싣지 않는 이전 허브의 실패를 분류한다: 네 가지 허브 코드와 인증 문구만
 * 알아보고, 나머지는 'unknown' 이다.
 */
export function legacyProviderFailure(agent: AgentName, text: string | null | undefined, code?: string | null): ProviderFailure {
  const message = capMessage(redactLegacyText(String(text ?? '')));
  let failureClass: ProviderFailureClass = 'unknown';
  let failureCode: string | null = null;
  if (code && LEGACY_HUB_CODES[code]) {
    failureClass = LEGACY_HUB_CODES[code];
    failureCode = code;
  } else if (LEGACY_AUTH_TEXT.test(message)) {
    failureClass = 'auth_required';
  }
  return {
    class: failureClass,
    agent,
    message,
    code: failureCode,
    retryable: defaultRetryable(failureClass, failureCode),
    resetAt: null,
  };
}

/** 이벤트에 실린 실패를 읽고, 없으면 이전 허브 규칙으로 분류한다. */
export function failureFromEvent(
  event: Extract<AgentStreamEvent, { type: 'error' | 'turn-end' }>,
): ProviderFailure | null {
  const parsed = readProviderFailure(event.failure, event.agent);
  if (parsed) return parsed;
  const text = event.type === 'error' ? event.message : event.errorMessage;
  return text ? legacyProviderFailure(event.agent, text) : null;
}

export interface TurnFailureResult {
  failure: ProviderFailure;
  turnId: string | null;
  userInitiated: boolean;
}

export interface TurnFailureCollector {
  /** 턴이 시작됐다. userInitiated 는 사용자가 보낸 메시지가 연 턴인지다. */
  beginTurn(turnId: string | null, userInitiated: boolean): void;
  /**
   * error 이벤트 하나. 턴이 돌거나 메시지가 턴을 기다리는 중(holding)이면 모아 두고 null,
   * 아니면 지금 보일 실패를 돌려준다.
   */
  observeError(event: Extract<AgentStreamEvent, { type: 'error' }>, holding: boolean): ProviderFailure | null;
  /**
   * 턴이 끝났다 — 이 턴의 실패 하나 또는 null. 상태는 비워진다. messageAwaitingTurn 은 보낸 메시지가
   * 턴을 기다리던 중인지다: 어댑터가 turn-start 없이 바로 실패를 끝내면(턴을 열지 못한 메시지)
   * 그 메시지가 연 턴으로 본다. 붙잡은 허브 턴(기다리던 메시지 없음)은 그대로 사용자 턴이 아니다.
   */
  endTurn(event: Extract<AgentStreamEvent, { type: 'turn-end' }>, messageAwaitingTurn?: boolean): TurnFailureResult | null;
  /** chat-error 등으로 기다림이 끝났을 때 모아 둔 실패 하나를 내놓고 비운다. */
  flush(): ProviderFailure | null;
}

/** 한 턴의 error 들과 turn-end 를 실패 알림 하나로 모은다. */
export function createTurnFailureCollector(): TurnFailureCollector {
  let held: ProviderFailure[] = [];
  let turnId: string | null = null;
  let userInitiated = false;
  /** 이 턴의 turn-start 를 봤다 */
  let began = false;
  const firstHeld = (): ProviderFailure | null =>
    held.find((failure) => failure.class !== 'unknown') ?? held[0] ?? null;
  const reset = () => {
    held = [];
    turnId = null;
    userInitiated = false;
    began = false;
  };
  return {
    beginTurn(nextTurnId, initiated) {
      held = [];
      turnId = nextTurnId;
      userInitiated = initiated;
      began = true;
    },
    observeError(event, holding) {
      const failure = failureFromEvent(event);
      if (!failure) return null;
      if (holding) {
        held.push(failure);
        return null;
      }
      return failure;
    },
    endTurn(event, messageAwaitingTurn = false) {
      const eventTurnId = typeof event.turnId === 'string' ? event.turnId : turnId;
      const initiated = began ? userInitiated : messageAwaitingTurn;
      const pending = firstHeld();
      reset();
      // 허브가 사라져 Studio 가 만든 중단(interruption)은 별도 줄이 맡는다.
      if ((event as { interruption?: unknown }).interruption) return null;
      let failure: ProviderFailure | null = null;
      if (event.stopReason === 'interrupted') {
        // 사용자가 멈춘 것 자체는 실패가 아니다. 다만 그 전에 로그인·한도 실패가 났다면
        // 턴이 왜 아무것도 못 했는지 알려 준다.
        failure = pending && (pending.class === 'auth_required' || pending.class === 'usage_limit') ? pending : null;
      } else {
        failure = readProviderFailure(event.failure, event.agent)
          ?? pending
          ?? (event.errorMessage ? legacyProviderFailure(event.agent, event.errorMessage) : null);
      }
      return failure ? { failure, turnId: eventTurnId, userInitiated: initiated } : null;
    },
    flush() {
      const failure = firstHeld();
      held = [];
      return failure;
    },
  };
}

/**
 * 사용량 보고에서 다 쓴 창(percent ≥ 100)의 미래 리셋 시각. 여러 창이 다 찼다면 모두
 * 풀려야 다시 쓸 수 있으므로 가장 늦은 시각이다.
 */
export function resetAtFromLimits(
  limits: Partial<Record<'claude' | 'codex', ProviderQuota>> | null | undefined,
  agent: AgentName,
  now = Date.now(),
): number | null {
  if (agent !== 'claude' && agent !== 'codex') return null;
  const quota = limits?.[agent];
  if (!quota) return null;
  let latest: number | null = null;
  for (const window of [quota.session, quota.week]) {
    if (!window || typeof window.percent !== 'number' || window.percent < 100) continue;
    const resetAt = window.resetsAt;
    if (typeof resetAt !== 'number' || !Number.isFinite(resetAt) || resetAt <= now) continue;
    latest = latest === null ? resetAt : Math.max(latest, resetAt);
  }
  return latest;
}

/** 닫은 알림을 기억하는 키 — 채팅·클래스·문구가 같으면 같은 알림이다. */
export function failureDismissKey(threadId: string, failure: Pick<ProviderFailure, 'class' | 'message'>): string {
  return `${threadId}\u0000${failure.class}\u0000${failure.message}`;
}
