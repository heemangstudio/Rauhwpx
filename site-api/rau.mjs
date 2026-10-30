import { licenseError, tokenEquals } from './licenses.mjs';
import { createOpenRouterClient, finite, isKeyLimitReached, usd } from './openrouter.mjs';
import { createRateLimiter } from './rate-limit.mjs';
import { createMemoryStore } from './store.mjs';

/**
 * Hosted Rau-0.1 (the taste learner) for active Pro keys and active Hama plans. The app sends its
 * license lease and a prompt; the server calls the model on OpenRouter with a key of its own, so the
 * app never holds a provider key. Each license gets one OpenRouter key, `hama-rau-<keyId>`, created
 * with `limit` = its plan's cap and `limit_reset: 'monthly'` (UTC calendar month). A license with
 * both plans gets the Hama cap. The server also keeps a per-month ledger from each response's cost and refuses before calling upstream once the
 * month's spend reaches the cap, using whichever of the ledger and OpenRouter's own count is higher.
 *
 * rau.json = { allowances: { [keyId]: { keyId, status: provisioning|active, name, openrouterHash,
 *   openrouterKey, capUsd, period: 'YYYY-MM', limitSetAt, ledger: { [period]: usd }, createdAt } } }
 * `openrouterKey` never leaves the server. Assumes ONE replica: all writes go through one lock.
 */

export const MAX_RAU_PROMPT_BYTES = 48 * 1024;
/** The JSON body may escape every prompt byte (`\u0000` is 6 bytes), so the raw cap is wider than the prompt cap. */
export const MAX_RAU_BODY_BYTES = 6 * MAX_RAU_PROMPT_BYTES + 1024;
export const RAU_CONCURRENCY_PER_LICENSE = 2;
export const RAU_REQUESTS_PER_MINUTE = 20;
const MINUTE = 60 * 1000;
const BALANCE_CACHE_MS = 15 * 1000;
const LEARN_TIMEOUT_MS = 120 * 1000;
const LEDGER_PERIODS_KEPT = 3;

export function emptyRauState() {
  return { allowances: {} };
}

/** A license error whose `extra` fields and `headers` the server adds to the `{ok:false, error}` reply. */
export function rauError(code, status, extra = {}, headers = {}) {
  return Object.assign(licenseError(code, status), { extra, headers });
}

export function rauRateLimited(retryAfterSeconds = 60) {
  return rauError('rate_limited', 429, {}, { 'Retry-After': String(retryAfterSeconds) });
}

/** UTC calendar month of `ms`, e.g. `2026-10`. OpenRouter's monthly limit resets on the same boundary. */
export function rauPeriod(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Next 1st of the month, 00:00 UTC. */
export function rauResetsAt(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function own(map, key) {
  return map && typeof map === 'object' && Object.hasOwn(map, key) ? map[key] : undefined;
}

/** `{prompt}` as JSON, the prompt a non-empty string of at most MAX_RAU_PROMPT_BYTES UTF-8 bytes. */
export function parseRauPrompt(raw) {
  if (raw === null) throw rauError('invalid', 400, { field: 'prompt' });
  let body;
  try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { throw rauError('invalid', 400, { field: 'body' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw rauError('invalid', 400, { field: 'body' });
  const { prompt } = body;
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt, 'utf8') > MAX_RAU_PROMPT_BYTES) {
    throw rauError('invalid', 400, { field: 'prompt' });
  }
  return prompt;
}

/**
 * What one response cost against the key's limit: OpenRouter's `usage.cost` (credits), plus the
 * provider's own charge when the call ran on a BYOK key, which the limit also counts.
 */
function costOf(usage) {
  const credit = finite(usage?.cost) ?? 0;
  const byok = usage?.is_byok === true ? finite(usage?.cost_details?.upstream_inference_cost) ?? 0 : 0;
  return Math.max(0, credit + byok);
}

/** This month's spend as OpenRouter counts it, from GET /key. */
function upstreamUsed(data) {
  const counts = [];
  const monthly = finite(data?.usage_monthly);
  if (monthly !== null) counts.push(monthly + (data.include_byok_in_limit === false ? 0 : finite(data?.byok_usage_monthly) ?? 0));
  const limit = finite(data?.limit);
  const remaining = finite(data?.limit_remaining);
  if (limit !== null && remaining !== null) counts.push(limit - remaining);
  return counts.length ? Math.max(0, ...counts) : 0;
}

export function createRauService({
  store = createMemoryStore(emptyRauState()),
  authenticate,
  config = {},
  upgradeUrl = 'https://heemangstudios.com/pricing.html#pro',
  adminToken = '',
  fetchImpl = globalThis.fetch,
  now = Date.now,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const {
    enabled = true,
    provisioningKey = '',
    model = 'deepseek/deepseek-v4.1-flash',
    reasoningEffort = 'low',
    maxOutputTokens = 2000,
    monthlyCapsUsd = { pro: 2, hama: 5 },
    apiBase = 'https://openrouter.ai/api/v1',
  } = config;
  const configured = Boolean(enabled && provisioningKey);
  const caps = { pro: usd(monthlyCapsUsd.pro), hama: usd(monthlyCapsUsd.hama) };
  const openrouter = createOpenRouterClient({ apiBase, provisioningKey, fetchImpl });

  let mutation = Promise.resolve();
  function withLock(fn) {
    const result = mutation.then(fn, fn);
    mutation = result.then(() => undefined, () => undefined);
    return result;
  }
  function normalize(state) {
    const next = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
    if (!next.allowances || typeof next.allowances !== 'object' || Array.isArray(next.allowances)) next.allowances = {};
    return next;
  }
  async function mutate(fn) {
    return withLock(async () => {
      const state = normalize(await store.load());
      const result = await fn(state);
      if (result?.dirty !== false) await store.save(state);
      return result?.value ?? result;
    });
  }
  async function read() {
    await mutation.catch(() => {});
    return normalize(await store.load());
  }

  function usageView(usedUsd, capUsd, nowMs = now()) {
    const used = usd(Math.max(0, usedUsd));
    return { usedUsd: used, capUsd, remainingUsd: usd(Math.max(0, capUsd - used)), resetsAt: new Date(rauResetsAt(nowMs)).toISOString() };
  }
  function capReached(usedUsd, capUsd) {
    const view = usageView(usedUsd, capUsd);
    return rauError('rau_cap_reached', 402, { capUsd: view.capUsd, usedUsd: view.usedUsd, resetsAt: view.resetsAt });
  }

  async function principal(lease) {
    if (typeof authenticate !== 'function') throw rauError('unauthorized', 401);
    const who = await authenticate(lease);
    // Not eligible: the cap an upgrade to Pro would buy.
    return { ...who, eligible: Boolean(who.rauPlan), capUsd: caps[who.rauPlan ?? 'pro'] };
  }

  // ------------------------------------------------------------ allowance

  const balances = new Map();
  async function upstreamMonthUsed(allowance) {
    const cached = balances.get(allowance.keyId);
    if (cached && now() - cached.at < BALANCE_CACHE_MS) return cached.value;
    const value = upstreamUsed(await openrouter.keyInfo(allowance.openrouterKey));
    balances.set(allowance.keyId, { at: now(), value });
    return value;
  }

  /** This month's spend: the higher of our ledger and OpenRouter's count. OpenRouter not answering leaves the ledger. */
  async function periodUsed(allowance, period) {
    const ledger = finite(own(allowance.ledger, period)) ?? 0;
    const upstream = await upstreamMonthUsed(allowance).catch(() => 0);
    return Math.max(ledger, upstream);
  }

  // One allowance change per license at a time, so parallel calls create one key and PATCH once.
  const preparing = new Map();
  function ensureAllowance(keyId, capUsd) {
    const previous = preparing.get(keyId);
    const run = (previous ? previous.catch(() => {}) : Promise.resolve()).then(() => prepare(keyId, capUsd));
    preparing.set(keyId, run);
    const clear = () => { if (preparing.get(keyId) === run) preparing.delete(keyId); };
    run.then(clear, clear);
    return run;
  }

  async function prepare(keyId, capUsd) {
    const name = `hama-rau-${keyId}`;
    const period = rauPeriod(now());
    const reserved = await mutate((state) => {
      const existing = own(state.allowances, keyId);
      if (existing?.status === 'active') return { dirty: false, value: { existing: { ...existing } } };
      state.allowances[keyId] = {
        keyId,
        status: 'provisioning',
        name,
        capUsd,
        period,
        ledger: existing?.ledger ?? {},
        startedAt: new Date(now()).toISOString(),
      };
      // A provisioning record seen here is a crash between create and save.
      return { value: { stale: existing?.status === 'provisioning' } };
    });

    if (!reserved.existing) {
      let created;
      try {
        if (reserved.stale) await openrouter.removeOrphans(name);
        created = await openrouter.createKey(name, capUsd, { limitReset: 'monthly' });
      } catch (error) {
        log(`[site-api] rau key for ${keyId} not created: ${error?.code ?? 'error'}${error?.status ? ` (${error.status})` : ''}`);
        if (error?.definite) {
          await mutate((state) => {
            if (own(state.allowances, keyId)?.status !== 'provisioning') return { dirty: false };
            delete state.allowances[keyId];
            return {};
          }).catch(() => {});
        }
        throw rauError('upstream_unavailable', 502);
      }
      const at = new Date(now()).toISOString();
      log(`[site-api] rau allowance created for ${keyId}`);
      return mutate((state) => {
        const a = state.allowances[keyId];
        Object.assign(a, { status: 'active', openrouterHash: created.hash, openrouterKey: created.key, createdAt: at, limitSetAt: at });
        return { value: { ...a } };
      });
    }

    // A new month or a changed cap (a new price, or the license gained or lost its Hama plan): set the key's limit once. This also re-asserts the monthly
    // reset in case OpenRouter dropped it. A failed PATCH is retried on the next call; the ledger
    // guard holds the cap meanwhile.
    const allowance = reserved.existing;
    if (allowance.period === period && allowance.capUsd === capUsd) return allowance;
    const patched = await openrouter.patchKey(allowance.openrouterHash, { limit: capUsd, limit_reset: 'monthly', include_byok_in_limit: true });
    if (!patched.ok) {
      log(`[site-api] rau limit for ${keyId} not set: ${patched.status ?? 'network'}`);
      return allowance;
    }
    balances.delete(keyId);
    return mutate((state) => {
      const a = own(state.allowances, keyId);
      Object.assign(a, { period, capUsd, limitSetAt: new Date(now()).toISOString() });
      return { value: { ...a } };
    });
  }

  /** Add one response's cost to this month's ledger (or raise it to `atLeast`) and keep the last few months. */
  async function recordSpend(keyId, period, { add = 0, atLeast = 0 } = {}) {
    return mutate((state) => {
      const a = own(state.allowances, keyId);
      if (!a) return { dirty: false, value: Math.max(add, atLeast) };
      a.ledger = a.ledger && typeof a.ledger === 'object' ? a.ledger : {};
      a.ledger[period] = usd(Math.max((finite(a.ledger[period]) ?? 0) + add, atLeast));
      for (const old of Object.keys(a.ledger).sort().slice(0, -LEDGER_PERIODS_KEPT)) delete a.ledger[old];
      a.lastUsedAt = new Date(now()).toISOString();
      return { value: a.ledger[period] };
    });
  }

  // ---------------------------------------------------------------- routes

  async function status(lease) {
    const who = await principal(lease);
    if (!configured) throw rauError('rau_not_configured', 503);
    const usage = usageView(0, who.capUsd);
    if (!who.eligible) {
      return { ok: true, eligible: false, reason: 'rau_requires_pro', upgradeUrl, capUsd: who.capUsd, usedUsd: null, remainingUsd: null, resetsAt: usage.resetsAt };
    }
    const allowance = own((await read()).allowances, who.keyId);
    const used = allowance?.status === 'active' ? await periodUsed(allowance, rauPeriod(now())) : 0;
    const view = usageView(used, who.capUsd);
    return { ok: true, eligible: true, reason: null, upgradeUrl, capUsd: who.capUsd, usedUsd: view.usedUsd, remainingUsd: view.remainingUsd, resetsAt: view.resetsAt };
  }

  const perLicense = createRateLimiter({ now });
  const inFlight = new Map();

  /** `raw` is the request body (null when it ran past MAX_RAU_BODY_BYTES). */
  async function learn(lease, raw) {
    const who = await principal(lease);
    if (!configured) throw rauError('rau_not_configured', 503);
    if (!who.eligible) throw rauError('rau_requires_pro', 403, { upgradeUrl });
    const prompt = parseRauPrompt(raw);
    if (!perLicense.check(who.keyId, RAU_REQUESTS_PER_MINUTE, MINUTE)) throw rauRateLimited(60);
    if ((inFlight.get(who.keyId) ?? 0) >= RAU_CONCURRENCY_PER_LICENSE) throw rauRateLimited(5);
    inFlight.set(who.keyId, (inFlight.get(who.keyId) ?? 0) + 1);
    try {
      return await run(who.keyId, who.capUsd, prompt);
    } finally {
      const left = (inFlight.get(who.keyId) ?? 1) - 1;
      if (left > 0) inFlight.set(who.keyId, left);
      else inFlight.delete(who.keyId);
    }
  }

  async function run(keyId, capUsd, prompt) {
    const allowance = await ensureAllowance(keyId, capUsd);
    const period = rauPeriod(now());
    const used = await periodUsed(allowance, period);
    if (used >= capUsd) throw capReached(used, capUsd);

    let answer;
    try {
      answer = await openrouter.json('/chat/completions', {
        method: 'POST',
        key: allowance.openrouterKey,
        timeout: LEARN_TIMEOUT_MS,
        headers: { 'HTTP-Referer': 'https://heemangstudios.com/', 'X-Title': 'HamaEditor Rau-0.1' },
        body: {
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxOutputTokens,
          reasoning: { effort: reasoningEffort },
          stream: false,
          usage: { include: true },
        },
      });
    } catch {
      throw rauError('upstream_unavailable', 502);
    } finally {
      balances.delete(keyId);
    }
    if (isKeyLimitReached(answer.status, answer.body)) {
      // The key still has a lower old limit because its PATCH failed: the next call asks again, and
      // filling the ledger now would hold the raised cap shut for the rest of the month.
      if (allowance.capUsd < capUsd) throw rauError('upstream_unavailable', 502);
      // OpenRouter's own limit is spent: fill the ledger so the next call stops before upstream.
      const full = Math.max(used, capUsd);
      await recordSpend(keyId, period, { atLeast: full });
      throw capReached(full, capUsd);
    }
    const text = answer.body?.choices?.[0]?.message?.content;
    if (!answer.ok || typeof text !== 'string') {
      log(`[site-api] rau learn for ${keyId} failed upstream: ${answer.status}`);
      throw rauError('upstream_unavailable', 502);
    }
    const cost = costOf(answer.body.usage);
    const ledger = await recordSpend(keyId, period, { add: cost });
    return {
      ok: true,
      text,
      model: typeof answer.body.model === 'string' ? answer.body.model : model,
      usage: usageView(Math.max(used + cost, ledger), capUsd),
    };
  }

  // ----------------------------------------------------------------- admin

  const admin = {
    /** Every allowance without its key, with this month's spend (the live count when OpenRouter answers). */
    async list(token) {
      if (!tokenEquals(token, adminToken)) throw rauError('forbidden', 403);
      const period = rauPeriod(now());
      const allowances = await Promise.all(Object.values((await read()).allowances).map(async (a) => {
        const { openrouterKey: _secret, ...rest } = a;
        const usedUsd = a.status === 'active' ? usd(await periodUsed(a, period)) : null;
        return { ...rest, usedUsd, remainingUsd: usedUsd === null ? null : usd(Math.max(0, a.capUsd - usedUsd)) };
      }));
      allowances.sort((x, y) => String(y.lastUsedAt ?? y.createdAt).localeCompare(String(x.lastUsedAt ?? x.createdAt)));
      return {
        ok: true,
        configured,
        model,
        reasoningEffort,
        period,
        capsUsd: caps,
        resetsAt: new Date(rauResetsAt(now())).toISOString(),
        count: allowances.length,
        allowances,
      };
    },
  };

  return { configured, status, learn, admin };
}
