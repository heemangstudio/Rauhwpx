// 키 서버 HTTP 클라이언트. 계약은 docs/license-api.md.
//   POST /v1/license/activate   {key, deviceId, appVersion, platform} → 200 {lease, keyId, tier}
//   POST /v1/license/validate   {key, deviceId}                       → 200 {lease, keyId, tier}
//   POST /v1/license/deactivate {key, deviceId}                       → 200 {ok:true}
//   실패: 4xx {error: 'invalid_key' | 'revoked' | 'device_limit' | 'not_activated'}. revoked 는 tier 도 준다.
// tier 는 'paid' | 'beta'. 표시에만 쓰고 권한은 서명한 lease 로만 정한다.
export const DEFAULT_LICENSE_API_BASE = 'https://rau-credits-production.up.railway.app';
export const LICENSE_ERRORS = Object.freeze(['invalid_key', 'revoked', 'device_limit', 'not_activated', 'device_id_invalid', 'server_not_configured', 'grandfather_disabled', 'not_eligible', 'install_id_invalid']);
const REQUEST_TIMEOUT_MS = 10_000;

export class LicenseServerError extends Error {
  constructor(code, message = code, { status = null, tier = null } = {}) {
    super(message);
    this.name = 'LicenseServerError';
    /** invalid_key | revoked | device_limit | not_activated | network | server */
    this.code = code;
    this.status = status;
    /** 서버가 알려 준 키 종류. revoked 에만 온다. */
    this.tier = tier;
  }
}

function tierFrom(body) {
  return body?.tier === 'beta' ? 'beta' : 'paid';
}

export function createLicenseClient({
  baseUrl = DEFAULT_LICENSE_API_BASE,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');

  async function post(path, body) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new LicenseServerError('network', error?.message ?? 'network error');
    }
    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (response.ok) {
      if (!parsed || typeof parsed !== 'object') throw new LicenseServerError('server', 'bad response', { status: response.status });
      return parsed;
    }
    const code = typeof parsed?.error === 'string' && LICENSE_ERRORS.includes(parsed.error) ? parsed.error : null;
    if (code && response.status >= 400 && response.status < 600) {
      throw new LicenseServerError(code, code, { status: response.status, tier: tierFrom(parsed) });
    }
    throw new LicenseServerError('server', `HTTP ${response.status}`, { status: response.status });
  }

  function leaseFrom(body) {
    if (typeof body.lease !== 'string' || !body.lease) throw new LicenseServerError('server', 'response has no lease');
    if (typeof body.keyId !== 'string') throw new LicenseServerError('server', 'response has no keyId');
    return { lease: body.lease, keyId: body.keyId, tier: tierFrom(body) };
  }

  return {
    baseUrl: base,
    publicKey: () => post('/v1/license/public-key'),
    grandfather: (installId) => post('/v1/license/grandfather', { installId }),
    async activate({ key, deviceId, appVersion, platform }) {
      return leaseFrom(await post('/v1/license/activate', { key, deviceId, appVersion, platform }));
    },
    async validate({ key, deviceId }) {
      return leaseFrom(await post('/v1/license/validate', { key, deviceId }));
    },
    async deactivate({ key, deviceId }) {
      await post('/v1/license/deactivate', { key, deviceId });
      return true;
    },
  };
}
