/**
 * OpenRouter calls of gift credits (gifts.mjs): the provisioning API (`/keys`) with the management
 * key, and per-key calls with a key we created. Hosted Rau calls OpenRouter in rau-proxy.mjs.
 * Keys created here never leave the server.
 */

const UPSTREAM_TIMEOUT_MS = 15 * 1000;
const MAX_UPSTREAM_JSON_BYTES = 16 * 1024 * 1024;
const MAX_KEY_LIST_PAGES = 50;

export function upstreamFailure(code, { definite = false, status } = {}) {
  const error = new Error(code);
  error.code = code;
  error.definite = definite; // true: OpenRouter answered and certainly did not act
  error.status = status;
  return error;
}

export function finite(value) {
  const n = Number(value);
  return value !== null && value !== undefined && Number.isFinite(n) ? n : null;
}

/** Round to a cent-safe precision so float sums never drift past a budget or cap. */
export function usd(value) {
  return Math.round(value * 1e6) / 1e6;
}

export async function readBounded(stream, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Only a key's own spending limit. A 402 for the owner's account balance is something else.
 * OpenRouter answers 402 or 403 with `metadata.limit_source: 'openrouter_key_limit'`, or a
 * 403 "Key limit exceeded" message.
 */
export function isKeyLimitReached(status, body) {
  const source = body?.error?.metadata?.limit_source;
  if (status === 402) return source === 'openrouter_key_limit';
  return status === 403 && (source === 'openrouter_key_limit' || /key limit exceeded/i.test(String(body?.error?.message ?? '')));
}

export function createOpenRouterClient({
  apiBase = 'https://openrouter.ai/api/v1',
  provisioningKey = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  /** One JSON call. Answers `{status, ok, body}`; only a network failure throws (`upstream_network`). */
  async function json(url, { method = 'GET', key = provisioningKey, body, timeout = timeoutMs, headers = {} } = {}) {
    let response;
    try {
      response = await fetchImpl(url.startsWith('http') ? url : `${apiBase}${url}`, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw upstreamFailure('upstream_network');
    }
    const raw = response.body ? await readBounded(response.body, MAX_UPSTREAM_JSON_BYTES).catch(() => null) : Buffer.alloc(0);
    let parsed = null;
    try { parsed = raw && raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { parsed = null; }
    return { status: response.status, ok: response.ok, body: parsed };
  }

  /**
   * POST /keys → 201 {key, data:{hash,...}}. include_byok_in_limit makes calls billed to the owner's
   * provider key (BYOK) count toward the limit, so OpenRouter enforces the cap. `limitReset` is
   * null (a one-time limit) or 'daily' | 'weekly' | 'monthly' (OpenRouter resets at UTC midnight).
   */
  async function createKey(name, limit, { limitReset = null } = {}) {
    const { status, ok, body } = await json('/keys', {
      method: 'POST',
      body: { name, limit, limit_reset: limitReset, include_byok_in_limit: true },
    });
    const key = body?.key;
    const hash = body?.data?.hash;
    if (!ok || typeof key !== 'string' || !key || typeof hash !== 'string' || !hash) {
      throw upstreamFailure('upstream_create_failed', { definite: status >= 400 && status < 500, status });
    }
    return { key, hash };
  }

  /** PATCH /keys/{hash}. Answers `{ok, status}`; a network failure reads as `{ok:false}`. */
  async function patchKey(hash, body) {
    return json(`/keys/${encodeURIComponent(hash)}`, { method: 'PATCH', body }).catch(() => ({ ok: false }));
  }

  /** Delete keys named `name` left behind by a crashed create. Their secret was never stored, so nobody can use them. */
  async function removeOrphans(name) {
    for (let page = 0; page < MAX_KEY_LIST_PAGES; page += 1) {
      const { ok, body } = await json(`/keys?include_disabled=true&offset=${page * 100}`);
      if (!ok || !Array.isArray(body?.data)) throw upstreamFailure('upstream_list_failed');
      for (const candidate of body.data) {
        if (candidate?.name !== name || typeof candidate?.hash !== 'string') continue;
        const removed = await json(`/keys/${encodeURIComponent(candidate.hash)}`, { method: 'DELETE' });
        if (!removed.ok && removed.status !== 404) throw upstreamFailure('upstream_delete_failed');
      }
      if (body.data.length < 100) return;
    }
    throw upstreamFailure('upstream_list_failed');
  }

  /** GET /key with a created key → its `data` (limit, usage, byok_usage, limit_remaining, usage_monthly, ...). */
  async function keyInfo(key) {
    const { ok, body } = await json('/key', { key });
    if (!ok || !body?.data || typeof body.data !== 'object') throw upstreamFailure('upstream_key_failed');
    return body.data;
  }

  return { apiBase, json, createKey, patchKey, removeOrphans, keyInfo };
}
