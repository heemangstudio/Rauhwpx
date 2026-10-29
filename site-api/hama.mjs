import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  admission,
  billingPeriod,
  finite,
  normalizeLedger,
  record as recordCall,
  usd,
  windows,
} from './hama-ledger.mjs';
import { licenseError, tokenEquals } from './licenses.mjs';
import { createMemoryStore } from './store.mjs';

/**
 * Hama: a hosted plan. The app's Pi harness runs through our proxy, metered per license key against
 * a monthly USD allowance with rolling caps (see hama-ledger.mjs). The app-facing contract is in
 * README.md, "Hama plan".
 *
 * hama.json = { plans: { [keyId]: plan }, ledgers: { [keyId]: ledger } }
 * plan = { status: 'active'|'disabled', allowanceUsd (null = HAMA_MONTHLY_ALLOWANCE_USD), periodAnchor, enrolledAt, disabledAt? }
 * Assumes ONE replica, like licenses.mjs and gifts.mjs: all writes go through one in-process lock.
 */

/** The only hosted Claude model. A constant on purpose: no env or flag can add Sonnet or Opus. */
export const HAMA_CLAUDE_MODEL = 'anthropic/claude-haiku-5.5';
export const HAMA_CLAUDE_API_MODEL = 'claude-haiku-5-5';
export const HAMA_CLAUDE_MODELS = Object.freeze([HAMA_CLAUDE_MODEL]);
export const HAMA_ANTHROPIC_PREFIX = '/v1/hama/anthropic';
export const HAMA_OPENAI_PREFIX = '/v1/hama/openrouter';
export const MAX_HAMA_ALLOWANCE_USD = 1000;
const MAX_USAGE_LOG_BYTES = 4 * 1024 * 1024;
const MAX_USAGE_LIMIT = 1000;

export function emptyHamaState() {
  return { plans: {}, ledgers: {} };
}

function own(map, key) {
  return map && typeof map === 'object' && Object.hasOwn(map, key) ? map[key] : undefined;
}

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/** Usage log file name for a key id: anything outside [A-Za-z0-9_-] becomes `_`. */
export function usageLogName(keyId) {
  return `${String(keyId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || '_'}.jsonl`;
}

/** Admin-set allowance: at least a cent and at most MAX_HAMA_ALLOWANCE_USD, number or numeric string, rounded to cents. */
export function parseHamaAllowance(value) {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  const cents = typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
  if (!(cents > 0) || cents > MAX_HAMA_ALLOWANCE_USD) throw licenseError('allowance_invalid', 400);
  return cents;
}

export function createHamaService({
  store = createMemoryStore(emptyHamaState()),
  authenticate,
  config = {},
  adminToken = '',
  now = Date.now,
  log = (line) => process.stderr.write(`${line}\n`),
  usageLogDir,
} = {}) {
  const settings = {
    allowanceUsd: 15,
    cap5hPct: 20,
    capWeekPct: 50,
    capMonthPct: 100,
    cheapModels: [],
    maxOutputTokens: 16000,
    ...config,
  };

  let mutation = Promise.resolve();
  function withLock(fn) {
    const result = mutation.then(fn, fn);
    mutation = result.then(() => undefined, () => undefined);
    return result;
  }
  function normalize(state) {
    const next = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
    for (const field of ['plans', 'ledgers']) {
      if (!next[field] || typeof next[field] !== 'object' || Array.isArray(next[field])) next[field] = {};
    }
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

  const effectivePlan = (plan) => ({ ...plan, allowanceUsd: finite(plan.allowanceUsd) ?? settings.allowanceUsd });

  /** Contract `caps` + `blocked` for one key at `now`. */
  function capsView(plan, ledger, at = now()) {
    const w = windows(ledger, effectivePlan(plan), settings, at);
    const caps = {};
    for (const cap of ['cap_5h', 'cap_week', 'cap_month']) {
      caps[cap] = { usedUsd: w[cap].usedUsd, limitUsd: w[cap].limitUsd, resetsAt: iso(w[cap].resetsAt) };
    }
    const blocking = admission(ledger, effectivePlan(plan), settings, at);
    const cheapAvailable = settings.cheapModels.length > 0 && !admission(ledger, effectivePlan(plan), settings, at, { cheap: true });
    return {
      period: w.period,
      caps,
      blocked: blocking ? { cap: blocking.cap, resetsAt: iso(blocking.resetsAt), cheapAvailable } : null,
    };
  }

  /** Lease → active plan. 401 unauthorized for a bad lease, 403 hama_not_enrolled without an active plan. */
  async function principal(lease) {
    if (typeof authenticate !== 'function') throw licenseError('unauthorized', 401);
    const who = await authenticate(lease);
    const state = await read();
    const plan = own(state.plans, who.keyId);
    if (!plan || plan.status !== 'active') throw licenseError('hama_not_enrolled', 403);
    return { who, plan, ledger: own(state.ledgers, who.keyId) };
  }

  function models() {
    return {
      default: HAMA_CLAUDE_MODEL,
      claude: [...HAMA_CLAUDE_MODELS],
      cheap: [...settings.cheapModels],
      maxOutputTokens: settings.maxOutputTokens,
    };
  }

  async function status(lease) {
    const { plan, ledger } = await principal(lease);
    const view = capsView(plan, ledger);
    return {
      ok: true,
      plan: {
        status: plan.status,
        allowanceUsd: effectivePlan(plan).allowanceUsd,
        periodStart: iso(view.period.start),
        periodEnd: iso(view.period.end),
      },
      caps: view.caps,
      blocked: view.blocked,
      models: models(),
      endpoints: { anthropic: HAMA_ANTHROPIC_PREFIX, openai: HAMA_OPENAI_PREFIX },
    };
  }

  /**
   * Checks a lease and its caps before a proxied call. Returns {keyId, deviceId, refusal}, where
   * refusal is null or {cap, resetsAt (ISO)}. Throws the same errors as status.
   */
  async function admit(lease, { cheap = false } = {}) {
    const { who, plan, ledger } = await principal(lease);
    const blocked = admission(ledger, effectivePlan(plan), settings, now(), { cheap });
    return {
      keyId: who.keyId,
      deviceId: who.deviceId,
      refusal: blocked ? { cap: blocked.cap, resetsAt: iso(blocked.resetsAt) } : null,
    };
  }

  // ------------------------------------------------------------- usage log

  const logPath = (keyId) => path.join(usageLogDir, usageLogName(keyId));
  const rotatedPath = (keyId) => logPath(keyId).replace(/\.jsonl$/, '.1.jsonl');

  /**
   * One JSON line per billed call. Past MAX_USAGE_LOG_BYTES the file becomes `<key>.1.jsonl` (one
   * generation kept). Appends run one at a time so a rotation never races another write.
   */
  let appending = Promise.resolve();
  function appendUsage(keyId, line) {
    if (!usageLogDir) return Promise.resolve();
    const run = appending.then(async () => {
      await fs.mkdir(usageLogDir, { recursive: true });
      const file = logPath(keyId);
      const size = await fs.stat(file).then((s) => s.size, () => 0);
      if (size > MAX_USAGE_LOG_BYTES) await fs.rename(file, rotatedPath(keyId));
      await fs.appendFile(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    });
    appending = run.catch(() => {});
    return run;
  }

  async function readUsage(keyId, limit) {
    if (!usageLogDir) return [];
    const lines = [];
    for (const file of [logPath(keyId), rotatedPath(keyId)]) {
      const text = await fs.readFile(file, 'utf8').catch(() => '');
      const parsed = text.split('\n').filter(Boolean).reverse().map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      lines.push(...parsed);
      if (lines.length >= limit) break;
    }
    return lines.slice(0, limit);
  }

  /**
   * Bills one finished (or cut off) call. Idempotent on `call.id`: a repeated id returns
   * {duplicate: true} and is neither counted nor logged again. The ledger is saved before returning.
   */
  async function record(keyId, call) {
    const at = finite(call?.at) ?? now();
    const costUsd = usd(Math.max(0, finite(call?.costUsd) ?? 0));
    const result = await mutate((state) => {
      const plan = own(state.plans, keyId);
      const ledger = normalizeLedger(own(state.ledgers, keyId));
      state.ledgers[keyId] = ledger;
      const outcome = recordCall(ledger, { id: call?.id, costUsd, at }, { periodAnchor: plan?.periodAnchor ?? at });
      return outcome.duplicate ? { dirty: false, value: outcome } : { value: outcome };
    });
    if (result.duplicate) return result;
    const line = {
      at: iso(at),
      id: typeof call?.id === 'string' ? call.id : null,
      route: call?.route ?? null,
      provider: call?.provider ?? null,
      model: call?.model ?? null,
      inputTokens: finite(call?.inputTokens) ?? 0,
      outputTokens: finite(call?.outputTokens) ?? 0,
      cacheReadTokens: finite(call?.cacheReadTokens) ?? 0,
      cacheWriteTokens: finite(call?.cacheWriteTokens) ?? 0,
      costUsd,
      costSource: call?.costSource ?? null,
    };
    await appendUsage(keyId, line).catch((error) => log(`[site-api] hama usage log for ${keyId} failed: ${error?.message ?? error}`));
    return { duplicate: false, costUsd };
  }

  // ----------------------------------------------------------------- admin

  function requireAdmin(token) {
    if (!tokenEquals(token, adminToken)) throw licenseError('forbidden', 403);
  }
  function keyIdOf(body) {
    const keyId = typeof body?.keyId === 'string' ? body.keyId.trim() : '';
    if (!keyId || keyId.length > 128) throw licenseError('key_id_required', 400);
    return keyId;
  }
  function planView(keyId, plan, ledger) {
    const view = capsView(plan, ledger);
    const l = normalizeLedger(structuredClone(ledger ?? {}));
    return {
      keyId,
      status: plan.status,
      allowanceUsd: effectivePlan(plan).allowanceUsd,
      allowanceOverride: finite(plan.allowanceUsd) !== null,
      periodAnchor: plan.periodAnchor,
      periodStart: iso(view.period.start),
      periodEnd: iso(view.period.end),
      enrolledAt: plan.enrolledAt ?? null,
      disabledAt: plan.disabledAt ?? null,
      caps: view.caps,
      blocked: view.blocked,
      totalUsd: l.totalUsd,
      calls: l.calls,
      lastCallAt: l.lastCallAt,
    };
  }

  const admin = {
    async list(token, { status: wanted } = {}) {
      requireAdmin(token);
      const state = await read();
      const plans = Object.entries(state.plans)
        .filter(([, plan]) => !wanted || plan.status === wanted)
        .map(([keyId, plan]) => planView(keyId, plan, own(state.ledgers, keyId)))
        .sort((a, b) => String(b.enrolledAt).localeCompare(String(a.enrolledAt)));
      return {
        ok: true,
        defaults: {
          allowanceUsd: settings.allowanceUsd,
          cap5hPct: settings.cap5hPct,
          capWeekPct: settings.capWeekPct,
          capMonthPct: settings.capMonthPct,
        },
        models: models(),
        count: plans.length,
        plans,
      };
    },
    /**
     * Enrolls a key, or re-activates and updates one. allowanceUsd: a per-key override (omit to keep
     * the current one, null to follow HAMA_MONTHLY_ALLOWANCE_USD). periodAnchor: ISO time the monthly
     * periods start from (default: kept, or now for a new plan).
     */
    async enroll(token, body) {
      requireAdmin(token);
      const keyId = keyIdOf(body);
      let allowance;
      if (body?.allowanceUsd === null || body?.allowanceUsd === '') allowance = null;
      else if (body?.allowanceUsd !== undefined) allowance = parseHamaAllowance(body.allowanceUsd);
      let anchor;
      if (body?.periodAnchor !== undefined && body?.periodAnchor !== null && body?.periodAnchor !== '') {
        const ms = Date.parse(String(body.periodAnchor));
        if (!Number.isFinite(ms)) throw licenseError('period_anchor_invalid', 400);
        anchor = new Date(ms).toISOString();
      }
      const at = new Date(now()).toISOString();
      const view = await mutate((state) => {
        const existing = own(state.plans, keyId);
        const plan = {
          status: 'active',
          allowanceUsd: allowance !== undefined ? allowance : (finite(existing?.allowanceUsd) ?? null),
          periodAnchor: anchor ?? existing?.periodAnchor ?? at,
          enrolledAt: existing?.enrolledAt ?? at,
        };
        billingPeriod(plan.periodAnchor, now()); // throws on a broken stored anchor
        state.plans[keyId] = plan;
        return { value: planView(keyId, plan, own(state.ledgers, keyId)) };
      });
      log(`[site-api] hama plan for ${keyId} active ($${view.allowanceUsd})`);
      return { ok: true, plan: view };
    },
    async disable(token, body) {
      requireAdmin(token);
      const keyId = keyIdOf(body);
      const view = await mutate((state) => {
        const plan = own(state.plans, keyId);
        if (!plan) throw licenseError('hama_not_found', 404);
        if (plan.status === 'disabled') return { dirty: false, value: planView(keyId, plan, own(state.ledgers, keyId)) };
        plan.status = 'disabled';
        plan.disabledAt = new Date(now()).toISOString();
        return { value: planView(keyId, plan, own(state.ledgers, keyId)) };
      });
      log(`[site-api] hama plan for ${keyId} disabled`);
      return { ok: true, plan: view };
    },
    /** The plan view plus the newest `limit` usage log entries (default 100, at most 1000). */
    async usage(token, { keyId: rawKeyId, limit } = {}) {
      requireAdmin(token);
      const keyId = keyIdOf({ keyId: rawKeyId });
      const state = await read();
      const plan = own(state.plans, keyId);
      if (!plan) throw licenseError('hama_not_found', 404);
      const n = Math.min(MAX_USAGE_LIMIT, Math.max(1, Math.floor(finite(limit) ?? 100)));
      return { ok: true, plan: planView(keyId, plan, own(state.ledgers, keyId)), entries: await readUsage(keyId, n) };
    },
  };

  return { status, admit, record, models, admin, config: settings };
}
