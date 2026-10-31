/**
 * The only outbound calls of the account system: WorkOS AuthKit (User Management).
 * https://workos.com/docs/reference/user-management
 *
 * The API key is the `client_secret` of the code exchange and the bearer of user deletion. It, the
 * codes WorkOS sends and full email addresses never reach a log line.
 */

export const DEFAULT_WORKOS_API_BASE = 'https://api.workos.com';
export const DEFAULT_WORKOS_CLIENT_ID = 'client_01M66W83D02NGE62TDVKR8PW8S';
const TIMEOUT_MS = 10_000;

/**
 * App provider id → WorkOS `provider`. `email` is the AuthKit hosted page (Magic Auth is enabled
 * in the dashboard). `kakao` is the hook for a later connection: it stays null, so listing it in
 * ACCOUNT_AUTH_PROVIDERS fails startup until it maps to one. Any other id is unknown and fails startup too.
 */
export const WORKOS_PROVIDERS = Object.freeze({
  email: 'authkit',
  google: 'GoogleOAuth',
  kakao: null,
});

/** WorkOS `authentication_method` → app provider id; anything else signed in through the AuthKit page. */
const METHOD_PROVIDERS = { GoogleOAuth: 'google', MagicAuth: 'email', Password: 'email' };

export function workosError(code, status) {
  return Object.assign(new Error(code), { code, status });
}

/** `a…@example.com`: enough to tell users apart in a log line. */
export function maskedEmail(email) {
  const [local, domain] = String(email ?? '').split('@');
  return domain ? `${local.slice(0, 1)}…@${domain}` : '…';
}

export function createWorkOSClient({
  apiKey,
  clientId = DEFAULT_WORKOS_CLIENT_ID,
  apiBase = DEFAULT_WORKOS_API_BASE,
  redirectUri,
  fetchImpl = fetch,
}) {
  const base = apiBase.replace(/\/+$/, '');

  /** The AuthKit authorize URL for one login; `state` is our login id. */
  function authorizeUrl({ provider, state, loginHint }) {
    const url = new URL(`${base}/user_management/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('provider', WORKOS_PROVIDERS[provider]);
    url.searchParams.set('state', state);
    if (loginHint) url.searchParams.set('login_hint', loginHint);
    return url.toString();
  }

  async function call(path, init) {
    try {
      return await fetchImpl(`${base}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw workosError('workos_unreachable', 502);
    }
  }

  /**
   * Exchanges an authorization code. Resolves to `{ workosUserId, email, emailVerified, firstName,
   * lastName, provider }`; `provider` is the app id of the method WorkOS reports, else null.
   * A refused code is `invalid_grant` (400), anything else unexpected `workos_failed` (502).
   */
  async function authenticateWithCode(code) {
    const res = await call('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: apiKey, grant_type: 'authorization_code', code }),
    });
    const body = await res.json().catch(() => null);
    if (res.status >= 400 && res.status < 500) throw workosError('invalid_grant', 400);
    const user = body?.user;
    if (!res.ok || typeof user?.id !== 'string' || typeof user.email !== 'string') throw workosError('workos_failed', 502);
    return {
      workosUserId: user.id,
      email: user.email,
      emailVerified: user.email_verified === true,
      firstName: typeof user.first_name === 'string' ? user.first_name : '',
      lastName: typeof user.last_name === 'string' ? user.last_name : '',
      provider: METHOD_PROVIDERS[body.authentication_method] ?? null,
    };
  }

  /** Deletes a WorkOS user. Resolves true on success or when the user is already gone. */
  async function deleteUser(workosUserId) {
    const res = await call(`/user_management/users/${encodeURIComponent(workosUserId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    await res.arrayBuffer().catch(() => {});
    if (res.ok || res.status === 404) return true;
    throw workosError('workos_failed', res.status);
  }

  return { authorizeUrl, authenticateWithCode, deleteUser };
}
