// 계정 서버(site-api /v1/account/*) HTTP 클라이언트. 계약은 /v1/account 라우트 설명(site-api README)과 같다.
//   공개: GET auth/providers, POST auth/start, POST auth/token
//   세션(Authorization: Bearer hes_…): refresh, signout, devices/remove, redeem, claim, profile,
//   PUT·GET avatar, avatar/remove, stats, delete
//   실패: { ok:false, error, ...extra } → AccountServerError(error, status, extra). 연결 실패·시간 초과는 network,
//   코드가 없는 응답은 server.
// 세션 토큰과 로그인 코드는 이 파일 밖으로 기록하지 않는다.
import { DEFAULT_LICENSE_API_BASE } from './license-client.mjs';

const REQUEST_TIMEOUT_MS = 10_000;
const ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

export class AccountServerError extends Error {
  constructor(code, status = null, extra = {}) {
    super(code);
    this.name = 'AccountServerError';
    /** 서버의 error 코드, 또는 network | server */
    this.code = code;
    this.status = status;
    /** 오류와 함께 온 칸(device_limit 의 limit·devices, subscription_active 의 manageUrl 등). */
    this.extra = extra;
  }
}

export function createAccountClient({
  baseUrl = DEFAULT_LICENSE_API_BASE,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');

  async function send(path, { method = 'POST', session = null, json, raw = null, type = null } = {}) {
    const headers = { Accept: 'application/json' };
    if (session) headers.Authorization = `Bearer ${session}`;
    let body;
    if (raw) {
      headers['Content-Type'] = type;
      body = raw;
    } else if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    try {
      return await fetchImpl(`${base}${path}`, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new AccountServerError('network', null, { reason: error?.name ?? 'error' });
    }
  }

  async function errorFrom(response) {
    let parsed = null;
    try { parsed = await response.json(); } catch { parsed = null; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && typeof parsed.error === 'string' && ERROR_CODE_RE.test(parsed.error)) {
      const { ok: _ok, error, ...extra } = parsed;
      return new AccountServerError(error, response.status, extra);
    }
    return new AccountServerError('server', response.status);
  }

  async function call(path, options) {
    const response = await send(path, options);
    if (!response.ok) throw await errorFrom(response);
    let parsed = null;
    try { parsed = await response.json(); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.ok === false) {
      throw new AccountServerError('server', response.status);
    }
    return parsed;
  }

  return {
    baseUrl: base,
    providers: () => call('/v1/account/auth/providers', { method: 'GET' }),
    start: ({ provider, challenge, port, state, loginHint, intent }) => call('/v1/account/auth/start', {
      json: { provider, challenge, port, state, ...(loginHint ? { loginHint } : {}), ...(intent ? { intent } : {}) },
    }),
    token: ({ code, verifier, device, replaceDeviceId }) => call('/v1/account/auth/token', {
      json: { code, verifier, device, ...(replaceDeviceId ? { replaceDeviceId } : {}) },
    }),
    refresh: (session, { appVersion } = {}) => call('/v1/account/refresh', { session, json: { appVersion } }),
    signOut: (session) => call('/v1/account/signout', { session, json: {} }),
    removeDevice: (session, deviceId) => call('/v1/account/devices/remove', { session, json: { deviceId } }),
    redeem: (session, key) => call('/v1/account/redeem', { session, json: { key } }),
    claim: (session, { orderId, email }) => call('/v1/account/claim', { session, json: { orderId, email } }),
    updateProfile: (session, { name }) => call('/v1/account/profile', { session, json: { name } }),
    uploadAvatar: (session, bytes, type) => call('/v1/account/avatar', { method: 'PUT', session, raw: bytes, type }),
    removeAvatar: (session) => call('/v1/account/avatar/remove', { session, json: {} }),
    stats: (session, { batchId, agentSessions, documentsEdited }) => call('/v1/account/stats', {
      session, json: { batchId, agentSessions, documentsEdited },
    }),
    deleteAccount: (session, confirm) => call('/v1/account/delete', { session, json: { confirm } }),
    /** 사진 바이트. 없으면(404 no_avatar) null. */
    async fetchAvatar(session) {
      const response = await send('/v1/account/avatar', { method: 'GET', session });
      if (!response.ok) {
        const error = await errorFrom(response);
        if (error.code === 'no_avatar') return null;
        throw error;
      }
      let bytes;
      try {
        bytes = Buffer.from(await response.arrayBuffer());
      } catch {
        throw new AccountServerError('network', null);
      }
      const type = String(response.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase();
      const rev = Number.parseInt(String(response.headers?.get?.('etag') ?? '').replace(/^W\//, '').replace(/"/g, ''), 10);
      return { bytes, type, rev: Number.isSafeInteger(rev) ? rev : null };
    },
  };
}
