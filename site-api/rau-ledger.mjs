/**
 * Hosted Rau accounting. Pure: no I/O, every function takes `now`/`at`.
 *
 * A principal is one ledger: a Rau license (`source: 'plan'`, ledger id = keyId, monthly periods from
 * its anchor, RAU_MONTHLY_ALLOWANCE_USD each) or an account's trial (`source: 'trial'`, ledger id =
 * accountId, one period from its start to its end, RAU_TRIAL_ALLOWANCE_USD).
 *
 * ledger = {
 *   source: 'plan' | 'trial',
 *   period: { start: ISO, end: ISO, usedUsd, calls },  running totals of the current period
 *   ids: { [callId]: ms },                               recent call ids, so a call is never billed twice
 *   totalUsd, calls, lastCallAt
 * }
 * spend = { [weekStart 'YYYY-MM-DD', the UTC Monday]: { [model]: { usd, calls, inputTokens, outputTokens,
 *   cacheReadTokens, cacheWriteTokens, routes: { [route]: usd } } } }, the newest SPEND_WEEKS_KEPT weeks.
 */

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;
export const RAU_TRIAL_DAYS = 7;
export const RAU_TRIAL_ALLOWANCE_USD = 2;
export const SPEND_WEEKS_KEPT = 26;
// Call ids are kept a day; duplicates come from retries and double reports within minutes.
const ID_TTL_MS = DAY;
export const MAX_RECENT_IDS = 500;
const MAX_ID_LENGTH = 128;

/**
 * USD per million tokens of the models hosted Rau runs. Haiku 4.5 is Anthropic's list price on both
 * routes (no long-context rate). DeepSeek is billed by OpenRouter's reported cost; this row is the
 * conservative fallback for deepseek-v4.1-flash on DeepInfra (cache writes cost as input).
 */
export const RAU_PRICES = Object.freeze({
  haiku: Object.freeze({ inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.10, cacheWrite5mPerMTok: 1.25, cacheWrite1hPerMTok: 2 }),
  deepseek: Object.freeze({ inputPerMTok: 0.14, outputPerMTok: 0.42, cacheReadPerMTok: 0.0042, cacheWrite5mPerMTok: 0.14, cacheWrite1hPerMTok: 0.14 }),
});

/** Round to a nano-dollar so float sums never drift across an allowance, while a cheap call keeps its exact cost. */
export function usd(value) {
  return Math.round(value * 1e9) / 1e9;
}

export function finite(value) {
  const n = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(n) ? n : null;
}

const count = (value) => Math.max(0, Math.floor(finite(value) ?? 0));
const iso = (ms) => new Date(ms).toISOString();

/** Cost of one call from its token counts at `prices` (a RAU_PRICES row). */
export function costFromUsage(usage, prices) {
  const raw = count(usage?.inputTokens) * prices.inputPerMTok
    + count(usage?.outputTokens) * prices.outputPerMTok
    + count(usage?.cacheReadTokens) * prices.cacheReadPerMTok
    + count(usage?.cacheWrite5mTokens) * prices.cacheWrite5mPerMTok
    + count(usage?.cacheWrite1hTokens) * prices.cacheWrite1hPerMTok;
  return usd(raw / 1e6);
}

/**
 * The monthly billing period containing `now`. Periods start on the anchor's day of month and time
 * of day (UTC), clamped to the month's last day: a Jan 31 anchor gives Feb 28 (29), then Mar 31.
 */
export function billingPeriod(anchor, now) {
  const a = new Date(anchor);
  if (!Number.isFinite(a.getTime())) throw new Error('billing anchor is not a time');
  const startOf = (k) => {
    const first = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + k, 1));
    const y = first.getUTCFullYear();
    const m = first.getUTCMonth();
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return Date.UTC(y, m, Math.min(a.getUTCDate(), lastDay),
      a.getUTCHours(), a.getUTCMinutes(), a.getUTCSeconds(), a.getUTCMilliseconds());
  };
  const n = new Date(now);
  let k = (n.getUTCFullYear() - a.getUTCFullYear()) * 12 + (n.getUTCMonth() - a.getUTCMonth());
  while (startOf(k) > now) k -= 1;
  while (startOf(k + 1) <= now) k += 1;
  return { start: startOf(k), end: startOf(k + 1) };
}

/**
 * The period of a principal at `now` (epoch ms): `{ start, end }`. A plan runs monthly from its
 * anchor; a trial is one period from its start to its end.
 */
export function periodOf(principal, now) {
  if (principal?.source === 'trial') return { start: Date.parse(principal.startedAt), end: Date.parse(principal.endsAt) };
  return billingPeriod(principal?.anchor ?? now, now);
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** Repairs a stored ledger in place (or makes a new one) so every field has its type. */
export function normalizeLedger(entry) {
  const next = plainObject(entry);
  next.ids = plainObject(next.ids);
  if (!next.period || typeof next.period.start !== 'string') next.period = null;
  next.totalUsd = finite(next.totalUsd) ?? 0;
  next.calls = count(next.calls);
  if (typeof next.lastCallAt !== 'string') next.lastCallAt = null;
  return next;
}

/** What the ledger spent in `period` (`{ start }` epoch ms); 0 when its running period is another one. */
export function periodUsed(entry, period) {
  const current = entry?.period;
  if (!current || Date.parse(current.start) !== period.start) return 0;
  return usd(Math.max(0, finite(current.usedUsd) ?? 0));
}

/** Calls the ledger made in `period`. */
export function periodCalls(entry, period) {
  const current = entry?.period;
  return current && Date.parse(current.start) === period.start ? count(current.calls) : 0;
}

/**
 * Adds one call's cost to `period` (the one it was admitted in). `id` (provider message or generation
 * id) makes it idempotent: a seen id returns `{ duplicate: true }` and changes nothing. A call that
 * finishes after a newer period already started counts toward the totals only.
 */
export function recordCall(entry, { id, costUsd, at, source }, period) {
  normalizeLedger(entry);
  for (const [seenId, seen] of Object.entries(entry.ids)) {
    if (!(seen > at - ID_TTL_MS)) delete entry.ids[seenId];
  }
  const key = typeof id === 'string' && id ? id.slice(0, MAX_ID_LENGTH) : null;
  if (key && Object.hasOwn(entry.ids, key)) return { duplicate: true };
  const cost = usd(Math.max(0, finite(costUsd) ?? 0));
  if (source) entry.source = source;
  const runningStart = entry.period ? Date.parse(entry.period.start) : -Infinity;
  if (period.start > runningStart) entry.period = { start: iso(period.start), end: iso(period.end), usedUsd: 0, calls: 0 };
  if (period.start >= runningStart) {
    entry.period.usedUsd = usd((finite(entry.period.usedUsd) ?? 0) + cost);
    entry.period.calls = count(entry.period.calls) + 1;
  }
  if (key) {
    entry.ids[key] = at;
    const ids = Object.entries(entry.ids);
    if (ids.length > MAX_RECENT_IDS) {
      ids.sort((a, b) => a[1] - b[1]);
      for (const [old] of ids.slice(0, ids.length - MAX_RECENT_IDS)) delete entry.ids[old];
    }
  }
  entry.totalUsd = usd(entry.totalUsd + cost);
  entry.calls += 1;
  entry.lastCallAt = iso(at);
  return { duplicate: false, costUsd: cost };
}

/** `YYYY-MM-DD` of the UTC Monday that starts the week of `ms`. */
export function weekOf(ms) {
  const d = new Date(ms);
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return iso(monday).slice(0, 10);
}

const SPEND_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

/** Adds one billed call to the weekly spend by model, and drops weeks past SPEND_WEEKS_KEPT. Mutates `spend`. */
export function addSpend(spend, { at, model, route, costUsd, ...tokens }) {
  const week = weekOf(at);
  const weekEntry = plainObject(spend[week]);
  spend[week] = weekEntry;
  const name = typeof model === 'string' && model ? model : 'unknown';
  const row = plainObject(weekEntry[name]);
  weekEntry[name] = row;
  const cost = Math.max(0, finite(costUsd) ?? 0);
  row.usd = usd((finite(row.usd) ?? 0) + cost);
  row.calls = count(row.calls) + 1;
  for (const field of SPEND_FIELDS) row[field] = count(row[field]) + count(tokens[field]);
  row.routes = plainObject(row.routes);
  const routeName = typeof route === 'string' && route ? route : 'unknown';
  row.routes[routeName] = usd((finite(row.routes[routeName]) ?? 0) + cost);
  for (const old of Object.keys(spend).sort().slice(0, -SPEND_WEEKS_KEPT)) delete spend[old];
}

function emptyRow() {
  return { usd: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, routes: {} };
}

function addRow(target, row) {
  target.usd = usd(target.usd + (finite(row?.usd) ?? 0));
  target.calls += count(row?.calls);
  for (const field of SPEND_FIELDS) target[field] += count(row?.[field]);
  for (const [route, value] of Object.entries(plainObject(row?.routes))) {
    target.routes[route] = usd((target.routes[route] ?? 0) + (finite(value) ?? 0));
  }
}

/**
 * The last `weeks` weeks (this one included), newest first, each with its spend per model and its
 * total, plus the totals over them per model. Weeks without calls are listed with zeros.
 */
export function spendReport(spend, { weeks = 8, now }) {
  const list = [];
  const totals = { usd: 0, calls: 0, models: {} };
  const thisWeek = Date.parse(`${weekOf(now)}T00:00:00Z`);
  for (let i = 0; i < weeks; i += 1) {
    const week = iso(thisWeek - i * WEEK).slice(0, 10);
    const stored = plainObject(spend?.[week]);
    const models = {};
    let weekUsd = 0;
    let weekCalls = 0;
    for (const [model, row] of Object.entries(stored).sort(([a], [b]) => a.localeCompare(b))) {
      const view = emptyRow();
      addRow(view, row);
      models[model] = view;
      weekUsd = usd(weekUsd + view.usd);
      weekCalls += view.calls;
      totals.models[model] ??= emptyRow();
      addRow(totals.models[model], view);
    }
    totals.usd = usd(totals.usd + weekUsd);
    totals.calls += weekCalls;
    list.push({ week, usd: weekUsd, calls: weekCalls, models });
  }
  return { weeks: list, totals };
}
