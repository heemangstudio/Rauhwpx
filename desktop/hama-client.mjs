// Hama 플랜 HTTP 클라이언트. 키 서버와 같은 주소를 쓰고, 라이선스 lease 로 인증한다.
//   GET /v1/hama/status (Bearer lease) → {ok, plan, caps, blocked, models, endpoints}
//   실패: 401 unauthorized | 403 hama_not_enrolled (Hama 플랜이 아닌 모든 라이선스, Basic 포함)
//         | 404 Hama 가 꺼진 서버(not_configured)
// 플랜·한도·모델은 서버만 정한다. 앱은 라이선스 등급으로 Hama 를 짐작하지 않는다.
import { DEFAULT_LICENSE_API_BASE } from './license-client.mjs';

export const HAMA_ERRORS = Object.freeze(['unauthorized', 'hama_not_enrolled']);
const STATUS_TIMEOUT_MS = 10_000;

export class HamaServerError extends Error {
  constructor(code, message = code, { status = null } = {}) {
    super(message);
    this.name = 'HamaServerError';
    /** unauthorized | hama_not_enrolled | not_configured | network | server */
    this.code = code;
    this.status = status;
  }
}

export function createHamaClient({
  baseUrl = DEFAULT_LICENSE_API_BASE,
  fetchImpl = globalThis.fetch,
  timeoutMs = STATUS_TIMEOUT_MS,
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');

  async function status(lease) {
    if (typeof lease !== 'string' || !lease) throw new HamaServerError('unauthorized');
    let response;
    try {
      response = await fetchImpl(`${base}/v1/hama/status`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${lease}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new HamaServerError('network', error?.message ?? 'network error');
    }
    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (response.ok) {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.ok !== true) {
        throw new HamaServerError('server', 'bad hama status response', { status: response.status });
      }
      return parsed;
    }
    if (response.status === 404) throw new HamaServerError('not_configured', 'hama is off', { status: 404 });
    const code = typeof parsed?.error === 'string' && HAMA_ERRORS.includes(parsed.error) ? parsed.error
      : response.status === 401 ? 'unauthorized' : null;
    if (code) throw new HamaServerError(code, code, { status: response.status });
    throw new HamaServerError('server', `HTTP ${response.status}`, { status: response.status });
  }

  return { baseUrl: base, status };
}
