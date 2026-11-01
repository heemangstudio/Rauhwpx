import { licenseError, tokenEquals } from './licenses.mjs';
import {
  RAU_TRIAL_ALLOWANCE_USD,
  SPEND_WEEKS_KEPT,
  addSpend,
  finite,
  normalizeLedger,
  periodCalls,
  periodOf,
  periodUsed,
  recordCall,
  spendReport,
  usd,
} from './rau-ledger.mjs';
import { createRateLimiter } from './rate-limit.mjs';
import { createMemoryStore } from './store.mjs';

/**
 * Hosted Rau: Rau-0.1, the taste learner (`learn`), for Rau keys, keys with an active plan in the
 * frozen hama.json, and accounts in their trial. The app sends its lease; the server calls the model
 * through rau-upstream.mjs with keys of its own, so the app never holds a provider key.
 *
 * Each principal has one ledger (rau-ledger.mjs): a Rau license spends RAU_MONTHLY_ALLOWANCE_USD each
 * month from its anchor, a trial RAU_TRIAL_ALLOWANCE_USD over its 7 days. A call is refused before
 * upstream once the period's spend reaches the allowance, so the last admitted call may overshoot by
 * its own cost (and calls in flight together by theirs).
 *
 * State = { ledgers: { [principalId]: ledger }, spend: { [weekStart]: { [model]: row } } }, in rau.json
 * or the rau tables (mappers/rau.mjs). An old `allowances` field (per-license OpenRouter keys of the
 * previous Rau-0.1) is left as it is and never read. Every write runs exclusively through
 * `store.update`; upstream calls happen between updates, never inside one.
 */

export const MAX_RAU_PROMPT_BYTES = 48 * 1024;
/** The JSON body may escape every prompt byte (`\u0000` is 6 bytes), so the raw cap is wider than the prompt cap. */
export const MAX_RAU_BODY_BYTES = 6 * MAX_RAU_PROMPT_BYTES + 1024;
export const RAU_LEARN_CONCURRENCY = 2;
export const RAU_LEARN_PER_MINUTE = 20;
export const RAU_LEARN_MAX_TOKENS = 2000;
export const RAU_LEARN_MODEL = 'rau-0.1';
const MINUTE = 60 * 1000;
const LEARN_TIMEOUT_MS = 2 * MINUTE;

export function emptyRauState() {
  return { ledgers: {}, spend: {} };
}

/** A license error whose `extra` fields and `headers` the server adds to the `{ok:false, error}` reply. */
export function rauError(code, status, extra = {}, headers = {}) {
  return Object.assign(licenseError(code, status), { extra, headers });
}

export function rauRateLimited(retryAfterSeconds = 60) {
  return rauError('rate_limited', 429, {}, { 'Retry-After': String(retryAfterSeconds) });
}

function own(map, key) {
  return map && typeof map === 'object' && typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : undefined;
}

const isoOf = (ms) => new Date(ms).toISOString();

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

/** The lease the app sends: `Authorization: Bearer <lease>`, or `x-api-key: <lease>`. */
export function leaseOf(req) {
  const bearer = String(req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
  return String(req.headers['x-api-key'] ?? '').trim() || bearer;
}

export function createRauService({
  store = createMemoryStore(emptyRauState()),
  // lease → principal with `rau`: `{ source: 'plan', ledgerId, anchor }`, `{ source: 'trial', ledgerId,
  // startedAt, endsAt }` or null. Throws 401 unauthorized for a lease that is not ours.
  authenticate,
  upstream = { configured: false, complete: async () => ({ failed: true }) },
  config = {},
  upgradeUrl = 'https://heemangstudios.com/pricing.html#rau',
  adminToken = '',
  now = Date.now,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const enabled = config.enabled ?? true;
  const allowanceUsd = usd(config.allowanceUsd ?? 8);
  const configured = Boolean(enabled && upstream?.configured);

  function normalize(state) {
    const next = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
    for (const field of ['ledgers', 'spend']) {
      if (!next[field] || typeof next[field] !== 'object' || Array.isArray(next[field])) next[field] = {};
    }
    return next;
  }
  /** `fn` runs alone on the store and returns `{ value, dirty }`; the state is saved unless `dirty` is false. */
  async function mutate(fn) {
    const result = await store.update((state) => fn(normalize(state)));
    return result?.value ?? result;
  }
  async function read() {
    return normalize(await store.read());
  }

  const allowanceOf = (source) => (source === 'trial' ? RAU_TRIAL_ALLOWANCE_USD : allowanceUsd);

  /** What clients see of their credits: a whole percent, 0 only when nothing is left. Dollars stay on the server. */
  function remainingPercent(allowance, used) {
    const remaining = allowance - used;
    if (!(allowance > 0) || remaining <= 0) return 0;
    return Math.min(100, Math.ceil(Math.round((remaining / allowance) * 1e8) / 1e6));
  }

  /**
   * Where a principal stands now: its period, allowance and spend. Null when it has no Rau now: no
   * principal or a trial outside its 7 days. A spent trial still stands (remaining 0) until its end, so
   * it is refused for credits, not for its plan.
   */
  function standing(principal, state, at = now()) {
    if (!principal?.ledgerId || (principal.source !== 'plan' && principal.source !== 'trial')) return null;
    let period;
    try { period = periodOf(principal, at); } catch { return null; }
    if (!(at >= period.start && at < period.end)) return null;
    const allowance = allowanceOf(principal.source);
    const used = periodUsed(own(state.ledgers, principal.ledgerId), period);
    return {
      source: principal.source,
      ledgerId: principal.ledgerId,
      period,
      allowanceUsd: allowance,
      usedUsd: used,
      remainingUsd: usd(Math.max(0, allowance - used)),
    };
  }

  async function who(lease) {
    if (typeof authenticate !== 'function') throw rauError('unauthorized', 401);
    return authenticate(lease);
  }

  /**
   * The current period of a principal for the account page: `{ remainingPercent, resetsAt (epoch ms) }`,
   * or null outside it. Read-only.
   */
  async function usage(principal) {
    const s = standing(principal, await read());
    return s ? { remainingPercent: remainingPercent(s.allowanceUsd, s.usedUsd), resetsAt: s.period.end } : null;
  }

  async function status(lease) {
    const principal = await who(lease);
    if (!configured) throw rauError('rau_not_configured', 503);
    const s = standing(principal.rau, await read());
    if (!s) {
      return {
        ok: true, eligible: false, source: null, reason: 'rau_plan_required', upgradeUrl,
        remainingPercent: null, resetsAt: null,
      };
    }
    return {
      ok: true, eligible: true, source: s.source, reason: null, upgradeUrl,
      remainingPercent: remainingPercent(s.allowanceUsd, s.usedUsd), resetsAt: isoOf(s.period.end),
    };
  }

  /**
   * Bills one finished call to the principal's ledger and the weekly spend. Idempotent on
   * `call.id`: a repeated id returns `{ duplicate: true }` and counts nowhere. Saved before it resolves.
   */
  async function record(principal, call) {
    const at = finite(call?.at) ?? now();
    return mutate((state) => {
      const ledger = normalizeLedger(own(state.ledgers, principal.ledgerId));
      state.ledgers[principal.ledgerId] = ledger;
      const outcome = recordCall(ledger, { id: call?.id, costUsd: call?.costUsd, at, source: principal.source }, principal.period);
      if (outcome.duplicate) return { dirty: false, value: outcome };
      addSpend(state.spend, {
        at,
        model: call?.model,
        route: call?.route,
        costUsd: outcome.costUsd,
        inputTokens: call?.inputTokens,
        outputTokens: call?.outputTokens,
        cacheReadTokens: call?.cacheReadTokens,
        cacheWriteTokens: call?.cacheWriteTokens,
      });
      return { value: { ...outcome, usedUsd: periodUsed(ledger, principal.period) } };
    });
  }

  // ----------------------------------------------------------- Rau-0.1

  const perPrincipal = createRateLimiter({ now });
  const inFlight = new Map();

  /** `raw` is the request body (null when it ran past MAX_RAU_BODY_BYTES). */
  async function learn(lease, raw) {
    const principal = await who(lease);
    if (!configured) throw rauError('rau_not_configured', 503);
    const s = standing(principal.rau, await read());
    if (!s) throw rauError('rau_plan_required', 403, { upgradeUrl });
    const prompt = parseRauPrompt(raw);
    if (!perPrincipal.check(s.ledgerId, RAU_LEARN_PER_MINUTE, MINUTE)) throw rauRateLimited(60);
    if ((inFlight.get(s.ledgerId) ?? 0) >= RAU_LEARN_CONCURRENCY) throw rauRateLimited(5);
    inFlight.set(s.ledgerId, (inFlight.get(s.ledgerId) ?? 0) + 1);
    try {
      if (s.usedUsd >= s.allowanceUsd) {
        throw rauError('rau_credits_exhausted', 402, { resetsAt: isoOf(s.period.end) });
      }
      const answer = await upstream.complete({
        max_tokens: RAU_LEARN_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }, { timeoutMs: LEARN_TIMEOUT_MS });
      if (answer.failed) throw rauError('upstream_unavailable', 502);
      const billed = await record(s, answer.call);
      const used = usd(Math.max(s.usedUsd, billed.usedUsd ?? s.usedUsd));
      return {
        ok: true,
        text: answer.text,
        model: RAU_LEARN_MODEL,
        usage: { remainingPercent: remainingPercent(s.allowanceUsd, used), resetsAt: isoOf(s.period.end) },
      };
    } finally {
      const left = (inFlight.get(s.ledgerId) ?? 1) - 1;
      if (left > 0) inFlight.set(s.ledgerId, left);
      else inFlight.delete(s.ledgerId);
    }
  }

  // ----------------------------------------------------------------- admin

  function requireAdmin(token) {
    if (!tokenEquals(token, adminToken)) throw rauError('forbidden', 403);
  }

  const admin = {
    /** Every ledger, most recently used first: its period's spend against its allowance. No keys or emails. */
    async list(token) {
      requireAdmin(token);
      const at = now();
      const ledgers = Object.entries((await read()).ledgers).map(([principalId, stored]) => {
        const ledger = normalizeLedger(structuredClone(stored));
        const source = ledger.source === 'trial' ? 'trial' : 'plan';
        const allowance = allowanceOf(source);
        const period = ledger.period ? { start: Date.parse(ledger.period.start), end: Date.parse(ledger.period.end) } : null;
        const current = Boolean(period && at >= period.start && at < period.end);
        const used = current ? periodUsed(ledger, period) : 0;
        return {
          principalId,
          source,
          allowanceUsd: allowance,
          usedUsd: used,
          remainingUsd: usd(Math.max(0, allowance - used)),
          periodCalls: current ? periodCalls(ledger, period) : 0,
          periodEnd: current ? isoOf(period.end) : null,
          totalUsd: ledger.totalUsd,
          calls: ledger.calls,
          lastCallAt: ledger.lastCallAt,
        };
      });
      ledgers.sort((x, y) => String(y.lastCallAt).localeCompare(String(x.lastCallAt)));
      return {
        ok: true,
        configured,
        models: upstream?.routes ?? [],
        allowanceUsd,
        trialAllowanceUsd: RAU_TRIAL_ALLOWANCE_USD,
        count: ledgers.length,
        ledgers,
      };
    },
    /** Spend per week and model for the last `weeks` weeks (1–26, default 8), with totals. */
    async spend(token, { weeks } = {}) {
      requireAdmin(token);
      const n = weeks === undefined || weeks === '' ? 8 : Number(weeks);
      if (!Number.isInteger(n) || n < 1 || n > SPEND_WEEKS_KEPT) throw rauError('weeks_invalid', 400);
      return { ok: true, ...spendReport((await read()).spend, { weeks: n, now: now() }) };
    },
  };

  return { configured, status, usage, learn, admin };
}
