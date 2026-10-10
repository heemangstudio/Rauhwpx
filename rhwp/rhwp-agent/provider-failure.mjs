/**
 * 프로바이더 실패의 분류·가림·길이 제한. 허브가 Studio 로 보내기 전에 한 번만 거친다.
 *
 * 어댑터는 해석하지 않은 단서(hint)만 붙이고, 해석은 이 모듈의 표가 맡는다:
 *   hint = { source: 'claude'|'codex'|'pi'|'hub', code?, httpStatus?, resetAt?,
 *            terminalReason?, rateLimitRejected? }
 * 결과는 Studio 의 `ProviderFailure` (rhwp-studio/src/agent/types.ts) 와 같은 모양이다.
 *
 * @typedef {'auth_required'|'usage_limit'|'provider_error'|'network'|'process_exited'|'invalid_request'|'unknown'} ProviderFailureClass
 * @typedef {Object} ProviderFailure
 * @property {ProviderFailureClass} class
 * @property {import('./agents/backend.mjs').AgentName} [agent]
 * @property {string} message 가린 뒤 공백을 정리하고 MAX_FAILURE_MESSAGE 이하로 자른 문구
 * @property {string|null} code ≤ 64자 [A-Za-z0-9_.:-]
 * @property {boolean} retryable
 * @property {number|null} resetAt epoch ms. usage_limit 에만, 프로바이더의 구조화된 값에서만 온다.
 */
import { redactDiagnosticText } from './agents/backend.mjs';

export const PROVIDER_FAILURE_CLASSES = Object.freeze([
  'auth_required',
  'usage_limit',
  'provider_error',
  'network',
  'process_exited',
  'invalid_request',
  'unknown',
]);

export const MAX_FAILURE_MESSAGE = 2000;
const MAX_CODE_LENGTH = 64;
/** 분류용 정규식에 넘기는 원문 상한 — 거대한 stderr 가 정규식을 붙잡지 않게 한다. */
const CLASSIFY_TEXT_LIMIT = 16_000;

const URL_QUERY = /(https?:\/\/[^\s?#]+)[?#][^\s)\]}>"']*/gi;

/** 실패 문구 전용 가림: 공용 가림 + 모든 URL 쿼리·프래그먼트 제거 + 공백 정리 + 길이 제한. */
export function redactFailureText(text, secrets = []) {
  const redacted = redactDiagnosticText(text, secrets).replace(URL_QUERY, '$1?[redacted]');
  const normalized = redacted
    .replace(/\r\n?/g, '\n')
    // 제어 문자는 줄바꿈만 남긴다.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]+/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return capText(normalized, MAX_FAILURE_MESSAGE);
}

function capText(text, max) {
  if (text.length <= max) return text;
  let end = max - 1;
  // 서로게이트 쌍을 가르지 않는다.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xD800 && code <= 0xDBFF) end -= 1;
  return `${text.slice(0, end)}…`;
}

function sanitizeCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.slice(0, MAX_CODE_LENGTH);
  return /^[A-Za-z0-9_.:-]+$/.test(code) ? code : null;
}

const CLASS_DEFAULT_MESSAGE = Object.freeze({
  auth_required: '프로바이더 로그인이 필요합니다.',
  usage_limit: '프로바이더 사용 한도에 도달했습니다.',
  provider_error: '프로바이더 서버가 요청을 처리하지 못했습니다.',
  network: '프로바이더에 연결하지 못했습니다.',
  process_exited: '에이전트 실행이 중간에 멈췄습니다.',
  invalid_request: '프로바이더가 요청을 거절했습니다.',
  unknown: '에이전트 작업이 실패했습니다.',
});

/** 클래스별 기본 문구 — 프로바이더가 이유를 남기지 않은 실패에 쓴다. */
export function defaultFailureMessage(failureClass) {
  return CLASS_DEFAULT_MESSAGE[failureClass] ?? CLASS_DEFAULT_MESSAGE.unknown;
}

function retryableFor(failureClass, code) {
  if (failureClass === 'process_exited') {
    return code !== 'cli_missing' && code !== 'cleanup_uncertain' && code !== 'AGENT_PROCESS_CLEANUP_UNCERTAIN';
  }
  return failureClass === 'provider_error' || failureClass === 'network' || failureClass === 'unknown';
}

// ── 구조화된 단서 표 ─────────────────────────────────────────────

const CLAUDE_CODES = Object.freeze({
  authentication_failed: 'auth_required',
  oauth_org_not_allowed: 'auth_required',
  account_on_hold: 'auth_required',
  verification_required: 'auth_required',
  cloud_credential_error: 'auth_required',
  billing_error: 'usage_limit',
  overloaded: 'provider_error',
  server_error: 'provider_error',
  invalid_request: 'invalid_request',
  model_not_found: 'invalid_request',
});

const CODEX_CODES = Object.freeze({
  unauthorized: 'auth_required',
  usageLimitExceeded: 'usage_limit',
  sessionBudgetExceeded: 'usage_limit',
  serverOverloaded: 'provider_error',
  internalServerError: 'provider_error',
  rateLimitExceeded: 'provider_error',
  flexUnavailable: 'provider_error',
  httpConnectionFailed: 'network',
  responseStreamConnectionFailed: 'network',
  responseStreamDisconnected: 'network',
  responseTooManyFailedAttempts: 'network',
  contextWindowExceeded: 'invalid_request',
  badRequest: 'invalid_request',
  cyberPolicy: 'invalid_request',
  misalignmentPolicyViolation: 'invalid_request',
  tooManyDenials: 'invalid_request',
  sandboxError: 'invalid_request',
});

/** 어댑터가 공통으로 쓰는 코드 — 접두사 없이 그대로 남는다. */
const SHARED_CODES = Object.freeze({
  process_exit: 'process_exited',
  cli_missing: 'process_exited',
  cleanup_uncertain: 'process_exited',
  openrouter_credits: 'usage_limit',
  PI_MODEL_MISSING: 'invalid_request',
});

/** 프로바이더 실패로 보는 허브 chat-error 코드. 나머지(AGENT_BUSY 등)는 평범한 허브 오류다. */
export const PROVIDER_HUB_ERROR_CODES = Object.freeze({
  AGENT_AUTH_REQUIRED: 'auth_required',
  PI_NOT_CONFIGURED: 'auth_required',
  AGENT_SPAWN_FAILED: 'process_exited',
  AGENT_PROCESS_CLEANUP_UNCERTAIN: 'process_exited',
});

/**
 * Codex `codexErrorInfo` 는 문자열이거나 `{ httpConnectionFailed: { httpStatusCode } }`
 * 같은 한 키짜리 객체다. 이름과 HTTP 상태를 꺼낸다.
 */
export function readCodexErrorInfo(info) {
  if (typeof info === 'string' && info) return { code: info, httpStatus: null };
  if (info && typeof info === 'object' && !Array.isArray(info)) {
    const [key] = Object.keys(info);
    if (!key) return null;
    const status = Number(info[key]?.httpStatusCode);
    return { code: key, httpStatus: Number.isInteger(status) && status > 0 ? status : null };
  }
  return null;
}

// ── 문구 패턴 ───────────────────────────────────────────────────

const AUTH_TEXT = /\/login|not logged in|log ?in again|oauth token|token (?:has )?expired|invalid api key|authentication|unauthori[sz]ed|\b401\b|invalid x-api-key|no auth credentials|incorrect api key/i;
const USAGE_TEXT = /usage limit|hit your (?:usage |session |weekly )?limit|limit reached|quota exceeded|insufficient[_ ]quota|credit balance is too low|out of credits|insufficient credits|requires more credits|payment required|\b402\b/i;
const NETWORK_TEXT = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|network error|connection (?:error|refused|reset|closed)|timed? out|stream disconnected/i;
const PROVIDER_TEXT = /overloaded|\b5\d\d\b|server error|internal error|service unavailable|rate.?limit|too many requests|\b429\b|capacity/i;
const CONTEXT_TEXT = /prompt is too long|context (?:length|window)|maximum context/i;
const MODEL_TEXT = /model\b.*\bnot (?:found|available)|model_not_found/i;
const INVALID_TEXT = /invalid[_ ]request|\b40[04]\b|\b413\b/i;
/** 허브·어댑터가 직접 쓰는 정리 실패 문구 (영문 고정 문구). */
const CLEANUP_TEXT = /cleanup (?:could not be confirmed|remains unconfirmed)|could not be confirmed stopped/i;
const CLI_MISSING_TEXT = /\bENOENT\b|command not found|is not recognized as an internal or external command/i;
/** Claude 레거시 사용 한도 문구의 `…|<epoch 초>` 꼬리 — 유일하게 모호하지 않은 문구 속 시각. */
const CLAUDE_EPOCH_SUFFIX = /\|(\d{10})(?!\d)/;

function textClass(text) {
  if (AUTH_TEXT.test(text)) return { class: 'auth_required', code: null };
  if (USAGE_TEXT.test(text)) return { class: 'usage_limit', code: null };
  if (NETWORK_TEXT.test(text)) return { class: 'network', code: null };
  if (CONTEXT_TEXT.test(text)) return { class: 'invalid_request', code: 'context_window' };
  if (PROVIDER_TEXT.test(text)) return { class: 'provider_error', code: null };
  if (MODEL_TEXT.test(text)) return { class: 'invalid_request', code: 'model_not_found' };
  if (INVALID_TEXT.test(text)) return { class: 'invalid_request', code: null };
  return null;
}

function httpClass(status, text) {
  if (status === 401 || status === 403) return 'auth_required';
  if (status === 402) return 'usage_limit';
  if (status === 429) return USAGE_TEXT.test(text) ? 'usage_limit' : 'provider_error';
  if (status >= 500 && status <= 599) return 'provider_error';
  if (status === 400 || status === 404 || status === 413) return 'invalid_request';
  return null;
}

function validResetAt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

/** 프로바이더 이름 → 이 프로바이더의 구조화된 코드 표. */
function structuredClass(hint) {
  const code = typeof hint?.code === 'string' ? hint.code : null;
  if (!code) return null;
  if (SHARED_CODES[code]) return { class: SHARED_CODES[code], code };
  if (hint.source === 'claude') {
    if (code === 'rate_limit') {
      return { class: hint.rateLimitRejected ? 'usage_limit' : 'provider_error', code: `claude:${code}` };
    }
    if (CLAUDE_CODES[code]) return { class: CLAUDE_CODES[code], code: `claude:${code}` };
    return { class: null, code: `claude:${code}` };
  }
  if (hint.source === 'codex') {
    let failureClass = CODEX_CODES[code] ?? null;
    // 연결 실패에 실린 HTTP 상태가 인증·한도를 말하면 그쪽이 맞다.
    if (failureClass === 'network' && (hint.httpStatus === 401 || hint.httpStatus === 403)) failureClass = 'auth_required';
    else if (failureClass === 'network' && hint.httpStatus === 429) failureClass = 'provider_error';
    return { class: failureClass, code: `codex:${code}` };
  }
  if (hint.source === 'hub' && PROVIDER_HUB_ERROR_CODES[code]) {
    return { class: PROVIDER_HUB_ERROR_CODES[code], code };
  }
  return { class: null, code: `${hint.source ?? 'provider'}:${code}` };
}

/**
 * 실패 하나를 분류한다. 우선순위: 구조화된 단서 표 → 허브 코드 표 → HTTP 상태 → 문구 패턴 →
 * 출처 기본값. 결과의 `message` 는 이미 가려져 있다.
 *
 * @param {{ agent?: string, message?: unknown, hint?: any, origin?: 'error'|'turn-end'|'hub', stopReason?: string }} input
 * @param {{ secrets?: Array<string|null|undefined> }} [options]
 * @returns {ProviderFailure}
 */
export function classifyProviderFailure({ agent, message, hint = null, origin = 'error', stopReason } = {}, { secrets = [] } = {}) {
  const raw = String(message ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').slice(0, CLASSIFY_TEXT_LIMIT);
  let resolved = structuredClass(hint);
  let failureClass = resolved?.class ?? null;
  let code = resolved?.code ?? null;
  if (hint?.source === 'claude' && hint.terminalReason === 'prompt_too_long' && !failureClass) {
    failureClass = 'invalid_request';
    code = 'claude:prompt_too_long';
  }
  // 프로세스 종료 단서라도 문구가 로그인·한도를 말하면 그 조치가 먼저다.
  if (failureClass === 'process_exited' && code === 'process_exit') {
    if (AUTH_TEXT.test(raw)) failureClass = 'auth_required';
    else if (USAGE_TEXT.test(raw)) failureClass = 'usage_limit';
    else if (MODEL_TEXT.test(raw)) {
      failureClass = 'invalid_request';
      code = 'model_not_found';
    } else if (CLI_MISSING_TEXT.test(raw)) code = 'cli_missing';
    else if (CLEANUP_TEXT.test(raw)) code = 'cleanup_uncertain';
  }
  if (!failureClass && CLEANUP_TEXT.test(raw)) {
    failureClass = 'process_exited';
    code ??= 'cleanup_uncertain';
  }
  const status = Number(hint?.httpStatus);
  if (!failureClass && Number.isInteger(status)) {
    failureClass = httpClass(status, raw);
    if (failureClass) code ??= `http_${status}`;
  }
  if (!failureClass) {
    const matched = textClass(raw);
    if (matched) {
      failureClass = matched.class;
      code ??= matched.code;
    }
  }
  if (!failureClass) {
    failureClass = (code === 'process_exit' || (origin === 'turn-end' && stopReason === 'exited'))
      ? 'process_exited'
      : 'unknown';
  }
  if (failureClass === 'process_exited' && code === 'process_exit') code = null;
  let resetAt = null;
  if (failureClass === 'usage_limit') {
    resetAt = validResetAt(hint?.resetAt);
    if (resetAt === null && (agent === 'claude' || hint?.source === 'claude')) {
      const suffix = raw.match(CLAUDE_EPOCH_SUFFIX);
      if (suffix) resetAt = Number(suffix[1]) * 1000;
    }
  }
  const safeCode = sanitizeCode(code);
  const text = redactFailureText(raw, secrets);
  return {
    class: failureClass,
    ...(agent ? { agent } : {}),
    message: text || defaultFailureMessage(failureClass),
    code: safeCode,
    retryable: retryableFor(failureClass, safeCode),
    resetAt,
  };
}

/**
 * Codex RateLimitSnapshot 에서 다 쓴 창(usedPercent ≥ 100)의 리셋 시각.
 * 여러 창이 모두 다 찼다면 전부 풀려야 다시 쓸 수 있으므로 가장 늦은 시각이다.
 */
export function codexResetAtFromSnapshot(snapshot, now = Date.now()) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  let latest = null;
  for (const key of ['primary', 'secondary']) {
    const window = snapshot[key];
    if (!window || Number(window.usedPercent) < 100) continue;
    let resetAt = Number(window.resetsAt);
    if (!Number.isFinite(resetAt) || resetAt <= 0) continue;
    // 프로토콜은 epoch 초를 보낸다. ms 로 온 값도 받아 둔다.
    if (resetAt < 1e12) resetAt *= 1000;
    if (resetAt <= now) continue;
    latest = latest === null ? resetAt : Math.max(latest, resetAt);
  }
  return latest;
}

/** 한 턴의 실패를 합친다: 먼저 온, 알려진 클래스가 이긴다. 알 수 없음은 뒤의 알려진 클래스로 바뀐다. */
export function mergeTurnFailure(held, next) {
  if (!held) return next ?? null;
  if (!next) return held;
  if (held.class === 'unknown' && next.class !== 'unknown') return next;
  return held;
}

/**
 * chat-error 코드 중 프로바이더 실패만 분류한다. 나머지 코드는 null — Studio 가 평범한
 * 허브 오류 줄로 그린다.
 */
export function failureForHubError(code, error, agent, secrets = []) {
  if (typeof code !== 'string' || !PROVIDER_HUB_ERROR_CODES[code]) return null;
  const message = typeof error?.message === 'string' ? error.message : typeof error === 'string' ? error : '';
  const failure = classifyProviderFailure({
    agent: agent ?? undefined,
    message,
    hint: { source: 'hub', code },
    origin: 'hub',
  }, { secrets });
  if (code === 'AGENT_SPAWN_FAILED' && CLI_MISSING_TEXT.test(message)) {
    return { ...failure, code: 'cli_missing', retryable: false };
  }
  return failure;
}

/** 이 턴을 실패로 보는 종료 이유. max_tokens·refusal 같은 정상 종료 이유는 실패가 아니다. */
const FAILED_STOP_REASONS = new Set(['failed', 'exited', 'error']);

/**
 * 프로바이더의 `error`·`turn-end` 하나를 Studio 로 보낼 모양으로 바꾼다 (허브의
 * makeBackendEventHandler 가 쓰는 그대로).
 * - error: 분류해 가린 문구와 `failure` 를 싣는다. 턴이 진행 중이면 그 턴의 실패로 모은다.
 * - turn-end: 사용자가 멈추지 않은 실패한 턴이면, 모은 실패와 합친 `failure` 하나를 싣고
 *   errorMessage 를 가린다. 이유 없이 실패했고 모은 것도 없으면 클래스 기본 문구를 싣는다
 *   (이전 Studio 에도 한 줄은 남게). 성공한 턴과 사용자 중단에서는 단서를 떼어 낸다.
 *
 * @param {any} evt 어댑터 이벤트 (failure 는 단서)
 * @param {{ agent?: string, held?: ProviderFailure|null, running?: boolean, secrets?: Array<string|null|undefined> }} state
 * @returns {{ event: any, held: ProviderFailure|null, failure: ProviderFailure|null }}
 */
export function normalizeProviderFailureEvent(evt, { agent, held = null, running = false, secrets = [] } = {}) {
  const eventAgent = evt.agent ?? agent;
  if (evt.type === 'error') {
    const failure = classifyProviderFailure({
      agent: eventAgent, message: evt.message, hint: evt.failure, origin: 'error',
    }, { secrets });
    return {
      event: { ...evt, message: failure.message, failure },
      held: running ? mergeTurnFailure(held, failure) : held,
      failure,
    };
  }
  if (evt.type !== 'turn-end') return { event: evt, held, failure: null };
  const { failure: hint, ...turnEnd } = evt;
  const errorText = typeof evt.errorMessage === 'string' ? evt.errorMessage : '';
  if (typeof evt.errorMessage !== 'string') delete turnEnd.errorMessage;
  if (evt.stopReason === 'interrupted' || (!errorText && !FAILED_STOP_REASONS.has(evt.stopReason))) {
    return { event: turnEnd, held, failure: null };
  }
  const own = classifyProviderFailure({
    agent: eventAgent, message: errorText, hint, origin: 'turn-end', stopReason: evt.stopReason,
  }, { secrets });
  const failure = mergeTurnFailure(held, own);
  if (errorText) turnEnd.errorMessage = own.message;
  else if (!held) turnEnd.errorMessage = failure.message;
  return { event: { ...turnEnd, failure }, held, failure };
}

