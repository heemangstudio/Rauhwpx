// 호스팅 Rau HTTP 클라이언트. 키 서버와 같은 주소를 쓰고, 계정 lease 로 인증한다.
//   GET  /v1/rau/status (Bearer lease)           → {ok, eligible, source, reason, upgradeUrl, allowanceUsd, usedUsd,
//                                                    remainingUsd, resetsAt(ISO), agent:{baseUrl, model, contextWindow, maxOutputTokens}}
//   POST /v1/rau/learn  (Bearer lease) {prompt}  → {ok, text, model, usage:{allowanceUsd, usedUsd, remainingUsd, resetsAt}}
//   실패: {ok:false, error: 'unauthorized' 401 | 'rau_plan_required' 403 (+upgradeUrl)
//          | 'rau_credits_exhausted' 402 (+allowanceUsd, usedUsd, resetsAt) | 'rate_limited' 429
//          | 'upstream_unavailable' 502 | 'rau_not_configured' 503}
// status 는 Rau 에이전트(rau-agent-host.mjs)와 Studio 의 rau:status 가 같이 쓰고, learn 은 Rau-0.1 학습이 쓴다.
// lease 는 메인 프로세스 밖으로 나가지 않는다(Rau 에이전트에 줄 때만 rau-agent-host.mjs 가 넘긴다).
import { DEFAULT_LICENSE_API_BASE } from './license-client.mjs';

export const RAU_ERRORS = Object.freeze([
  'unauthorized', 'rau_plan_required', 'rau_credits_exhausted', 'rate_limited', 'upstream_unavailable', 'rau_not_configured',
]);
/** Rau 요금제나 체험이 없을 때 보여 주는 요금제 페이지. */
export const RAU_UPGRADE_URL = 'https://heemangstudios.com/pricing.html#rau';
/** 서버가 받는 프롬프트 한도. 넘으면 보내지 않고 내 계정 경로로 넘긴다. */
export const RAU_PROMPT_MAX_BYTES = 48 * 1024;
/** 학습 한 번은 모델 호출이라 느리다. 허브의 IPC 대기(RAU_SOURCE_TIMEOUT_MS)보다 짧게 둔다. */
export const RAU_LEARN_TIMEOUT_MS = 90_000;
/** Rau 에이전트의 서버 경로. 다른 경로는 받지 않는다. */
export const RAU_AGENT_PATH = '/v1/rau/agent';
const STATUS_TIMEOUT_MS = 10_000;
const UPGRADE_HOSTS = new Set(['heemangstudios.com', 'www.heemangstudios.com', 'groble.im', 'www.groble.im']);

export class RauServerError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = 'RauServerError';
    /** RAU_ERRORS 의 하나, 또는 too_large | network | server */
    this.code = code;
    this.status = details.status ?? null;
    this.upgradeUrl = details.upgradeUrl ?? null;
    this.allowanceUsd = details.allowanceUsd ?? null;
    this.usedUsd = details.usedUsd ?? null;
    this.resetsAt = details.resetsAt ?? null;
  }
}

/** 서버가 준 업그레이드 주소는 우리 사이트나 Groble 의 https 페이지일 때만 쓴다. */
export function upgradeUrlFrom(value) {
  if (typeof value !== 'string') return RAU_UPGRADE_URL;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && UPGRADE_HOSTS.has(url.hostname) ? url.href : RAU_UPGRADE_URL;
  } catch {
    return RAU_UPGRADE_URL;
  }
}

/** 초기화 시각. epoch ms 나 ISO 문자열을 받아 epoch ms 로. 없거나 틀리면 null. */
export function resetsAtFrom(value) {
  if (Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const usd = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
const positiveInt = (value, max) => (Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : null);

function usageFrom(body) {
  return {
    allowanceUsd: usd(body?.allowanceUsd),
    usedUsd: usd(body?.usedUsd),
    remainingUsd: usd(body?.remainingUsd),
    resetsAt: resetsAtFrom(body?.resetsAt),
  };
}

/** status 답의 agent 칸. 경로는 /v1/rau/agent 만, 모델은 'rau' 만 받는다. 틀리면 null. */
function agentFrom(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.baseUrl !== RAU_AGENT_PATH || (value.model !== undefined && value.model !== 'rau')) return null;
  return {
    baseUrl: RAU_AGENT_PATH,
    model: 'rau',
    contextWindow: positiveInt(value.contextWindow, 1_000_000),
    maxOutputTokens: positiveInt(value.maxOutputTokens, 64_000),
  };
}

export function createRauClient({
  baseUrl = DEFAULT_LICENSE_API_BASE,
  fetchImpl = globalThis.fetch,
  learnTimeoutMs = RAU_LEARN_TIMEOUT_MS,
  statusTimeoutMs = STATUS_TIMEOUT_MS,
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');

  async function request(method, path, lease, body, timeoutMs) {
    if (typeof lease !== 'string' || !lease) throw new RauServerError('unauthorized');
    const headers = { Accept: 'application/json', Authorization: `Bearer ${lease}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new RauServerError('network', error?.message ?? 'network error');
    }
    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (response.ok && parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.ok === true) return parsed;
    if (response.ok) throw new RauServerError('server', 'bad response', { status: response.status });
    const error = parsed?.error;
    const code = typeof error === 'string' && RAU_ERRORS.includes(error) ? error
      : response.status === 401 ? 'unauthorized' : null;
    if (!code) throw new RauServerError('server', `HTTP ${response.status}`, { status: response.status });
    throw new RauServerError(code, code, {
      status: response.status,
      ...(code === 'rau_plan_required' ? { upgradeUrl: upgradeUrlFrom(parsed?.upgradeUrl) } : {}),
      ...(code === 'rau_credits_exhausted' ? usageFrom(parsed) : {}),
    });
  }

  return {
    baseUrl: base,
    async learn(lease, prompt) {
      if (typeof prompt !== 'string' || !prompt) throw new RauServerError('server', 'empty prompt');
      if (Buffer.byteLength(prompt, 'utf8') > RAU_PROMPT_MAX_BYTES) throw new RauServerError('too_large');
      const body = await request('POST', '/v1/rau/learn', lease, { prompt }, learnTimeoutMs);
      if (typeof body.text !== 'string') throw new RauServerError('server', 'response has no text');
      return {
        text: body.text,
        model: typeof body.model === 'string' ? body.model : null,
        usage: usageFrom(body.usage),
      };
    },
    /**
     * 자격과 크레딧. eligible 이 아니면 source·사용량은 null 이다. agent 는 Rau 에이전트가 쓰는 경로(없거나 틀리면 null).
     * 시각은 epoch ms.
     */
    async status(lease) {
      const body = await request('GET', '/v1/rau/status', lease, undefined, statusTimeoutMs);
      const eligible = body.eligible === true;
      return {
        eligible,
        source: eligible && (body.source === 'plan' || body.source === 'trial') ? body.source : null,
        reason: eligible ? null : 'rau_plan_required',
        upgradeUrl: upgradeUrlFrom(body.upgradeUrl),
        ...(eligible ? usageFrom(body) : { allowanceUsd: null, usedUsd: null, remainingUsd: null, resetsAt: null }),
        agent: eligible ? agentFrom(body.agent) : null,
      };
    },
  };
}
