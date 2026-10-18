// One authenticated call to the deployed admin API. Shared by license-admin.mjs and admin-ui/server.mjs.
export const DEFAULT_SITE_API_BASE = 'https://rau-credits-production.up.railway.app';
const TIMEOUT_MS = 15_000;

export function siteApiBase(env = process.env) {
  return (env.SITE_API_BASE || DEFAULT_SITE_API_BASE).replace(/\/+$/, '');
}

/** GET with `query` as the query string, or POST `body` as JSON. Resolves to `{ status, ok, text, json }`. */
export async function adminRequest({ base, token, method = 'GET', path, query, body, fetchImpl = fetch }) {
  const qs = query ? new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString() : '';
  const res = await fetchImpl(`${base}${path}${qs ? `?${qs}` : ''}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, text, json };
}
