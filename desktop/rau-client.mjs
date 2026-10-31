// 호스팅 Rau-0.1 HTTP 클라이언트. 키 서버와 같은 주소를 쓰고, 라이선스 lease 로 인증한다.
//   POST /v1/rau/learn  (Bearer lease) {prompt}  → {ok, text, model, usage:{usedUsd, capUsd, remainingUsd, resetsAt}}
//   GET  /v1/rau/status (Bearer lease)           → {ok, eligible, reason, upgradeUrl, capUsd, usedUsd, remainingUsd, resetsAt}
//   실패: {ok:false, error: 'unauthorized' 401 | 'rau_requires_basic' 403 (+upgradeUrl, 예전 서버는 'rau_requires_pro')
//          | 'rau_cap_reached' 402 (+capUsd, usedUsd, resetsAt) | 'rate_limited' 429
//          | 'upstream_unavailable' 502 | 'rau_not_configured' 503}
// lease 는 메인 프로세스 밖으로 나가지 않는다. 허브와 Studio 는 결과와 오류 코드만 받는다.
import { DEFAULT_LICENSE_API_BASE, PLAN_NAMES_HEADERS } from './license-client.mjs';
import { PRICING_URL } from './license-manager.mjs';

export const RAU_ERRORS = Object.freeze([
  'unauthorized', 'rau_requires_basic', 'rau_cap_reached', 'rate_limited', 'upstream_unavailable', 'rau_not_configured',
]);
/** Basic(또는 Hama)이 아니라는 거절. 예전 서버는 rau_requires_pro 로 답한다. 받은 코드는 rau_requires_basic 으로 맞춘다. */
export const RAU_REQUIRES_BASIC_CODES = Object.freeze(['rau_requires_basic', 'rau_requires_pro']);
const requiresBasicCode = (value) => (RAU_REQUIRES_BASIC_CODES.includes(value) ? 'rau_requires_basic' : value);
/** 서버가 받는 프롬프트 한도. 넘으면 보내지 않고 내 계정 경로로 넘긴다. */
export const RAU_PROMPT_MAX_BYTES = 48 * 1024;
/** 학습 한 번은 모델 호출이라 느리다. 허브의 IPC 대기(RAU_SOURCE_TIMEOUT_MS)보다 짧게 둔다. */
export const RAU_LEARN_TIMEOUT_MS = 90_000;
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
    this.capUsd = details.capUsd ?? null;
    this.usedUsd = details.usedUsd ?? null;
    this.resetsAt = details.resetsAt ?? null;
  }
}

/** 서버가 준 업그레이드 주소는 우리 사이트나 Groble 의 https 페이지일 때만 쓴다. */
export function upgradeUrlFrom(value) {
  if (typeof value !== 'string') return PRICING_URL;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && UPGRADE_HOSTS.has(url.hostname) ? url.href : PRICING_URL;
  } catch {
    return PRICING_URL;
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

const usd = (value) => (Number.isFinite(value) ? value : null);

function usageFrom(body) {
  return {
    capUsd: usd(body?.capUsd),
    usedUsd: usd(body?.usedUsd),
    remainingUsd: usd(body?.remainingUsd),
    resetsAt: resetsAtFrom(body?.resetsAt),
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
    const headers = { Accept: 'application/json', Authorization: `Bearer ${lease}`, ...PLAN_NAMES_HEADERS };
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
    const error = requiresBasicCode(parsed?.error);
    const code = typeof error === 'string' && RAU_ERRORS.includes(error) ? error
      : response.status === 401 ? 'unauthorized' : null;
    if (!code) throw new RauServerError('server', `HTTP ${response.status}`, { status: response.status });
    throw new RauServerError(code, code, {
      status: response.status,
      ...(code === 'rau_requires_basic' ? { upgradeUrl: upgradeUrlFrom(parsed?.upgradeUrl) } : {}),
      ...(code === 'rau_cap_reached' ? usageFrom(parsed) : {}),
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
    async status(lease) {
      const body = await request('GET', '/v1/rau/status', lease, undefined, statusTimeoutMs);
      return {
        eligible: body.eligible === true,
        reason: requiresBasicCode(body.reason) === 'rau_requires_basic' ? 'rau_requires_basic' : null,
        upgradeUrl: upgradeUrlFrom(body.upgradeUrl),
        ...usageFrom(body),
      };
    },
  };
}
