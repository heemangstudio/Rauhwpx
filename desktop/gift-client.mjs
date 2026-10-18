// 선물 크레딧 HTTP 클라이언트. 키 서버와 같은 주소를 쓰고, 라이선스 lease 로 인증한다.
//   GET  /v1/gift/status (Bearer lease) → {ok, event, eligible, claimed, remainingUsd, usedUsd, claimedAt}
//   POST /v1/gift/claim  (Bearer lease) → {ok, claimed, created, remainingUsd, claimedAt}
//   실패: {ok:false, error: 'unauthorized' 401 | 'not_eligible' 403 | 'event_inactive' 410
//          | 'budget_exhausted' 409 | 'upstream_unavailable' 502}
// Pi 가 쓰는 OpenAI 호환 프록시는 `${baseUrl}/v1/gift/openrouter` 이다.
import { DEFAULT_LICENSE_API_BASE } from './license-client.mjs';

export const GIFT_ERRORS = Object.freeze(['unauthorized', 'not_eligible', 'event_inactive', 'budget_exhausted', 'upstream_unavailable']);
export const GIFT_PROXY_PATH = '/v1/gift/openrouter';
const REQUEST_TIMEOUT_MS = 10_000;

export class GiftServerError extends Error {
  constructor(code, message = code, { status = null } = {}) {
    super(message);
    this.name = 'GiftServerError';
    /** unauthorized | not_eligible | event_inactive | budget_exhausted | upstream_unavailable | network | server */
    this.code = code;
    this.status = status;
  }
}

const isTime = (value) => value === null || typeof value === 'string' || Number.isFinite(value);
const usdOrNull = (value) => (value === null || value === undefined ? null : Number.isFinite(value) ? value : undefined);

function parseEvent(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || !Number.isFinite(raw.amountUsd)
    || typeof raw.active !== 'boolean') return undefined;
  const endsAt = raw.endsAt ?? null;
  if (!isTime(endsAt)) return undefined;
  return { id: raw.id, amountUsd: raw.amountUsd, endsAt, active: raw.active };
}

function parseStatus(body) {
  const event = parseEvent(body.event);
  const remainingUsd = usdOrNull(body.remainingUsd);
  const usedUsd = usdOrNull(body.usedUsd);
  const claimedAt = body.claimedAt ?? null;
  if (body.ok !== true || event === undefined || typeof body.eligible !== 'boolean' || typeof body.claimed !== 'boolean'
    || remainingUsd === undefined || usedUsd === undefined || !isTime(claimedAt)) {
    throw new GiftServerError('server', 'bad gift status response');
  }
  return { event, eligible: body.eligible, claimed: body.claimed, remainingUsd, usedUsd, claimedAt };
}

function parseClaim(body) {
  const claimedAt = body.claimedAt ?? null;
  if (body.ok !== true || body.claimed !== true || !Number.isFinite(body.remainingUsd) || !isTime(claimedAt)) {
    throw new GiftServerError('server', 'bad gift claim response');
  }
  return { claimed: true, created: body.created === true, remainingUsd: body.remainingUsd, claimedAt };
}

export function createGiftClient({
  baseUrl = DEFAULT_LICENSE_API_BASE,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');

  async function request(method, path, lease) {
    if (typeof lease !== 'string' || !lease) throw new GiftServerError('unauthorized');
    const headers = { Accept: 'application/json', Authorization: `Bearer ${lease}` };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        ...(method === 'POST' ? { body: '{}' } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new GiftServerError('network', error?.message ?? 'network error');
    }
    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (response.ok) {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new GiftServerError('server', 'bad response', { status: response.status });
      }
      return parsed;
    }
    // 본문이 없는 401 도 lease 를 받지 않았다는 뜻이다.
    const code = typeof parsed?.error === 'string' && GIFT_ERRORS.includes(parsed.error) ? parsed.error
      : response.status === 401 ? 'unauthorized' : null;
    if (code) throw new GiftServerError(code, code, { status: response.status });
    throw new GiftServerError('server', `HTTP ${response.status}`, { status: response.status });
  }

  return {
    baseUrl: base,
    proxyBaseUrl: `${base}${GIFT_PROXY_PATH}`,
    status: async (lease) => parseStatus(await request('GET', '/v1/gift/status', lease)),
    claim: async (lease) => parseClaim(await request('POST', '/v1/gift/claim', lease)),
  };
}
