/**
 * Hama usage accounting for one license key. Pure: no I/O, every function takes `now`/`at`.
 *
 * entry = {
 *   minutes: { [minuteIndex]: usd },  spend per UTC minute, kept for the 5-hour window
 *   hours:   { [hourIndex]: usd },    spend per UTC hour, kept for the 7-day window
 *   period:  { start: ISO, usedUsd }, running total of the current billing period
 *   ids:     { [callId]: ms },        recent call ids, so a call is never billed twice
 *   totalUsd, calls, lastCallAt
 * }
 * A bucket counts as if all its spend happened at its END, so a trailing window keeps it a little
 * longer than the exact spend would stay: windows may over-count by one bucket, never under-count.
 */

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const FIVE_HOURS = 5 * HOUR;
export const WEEK = 7 * DAY;
export const CAP_NAMES = ['cap_5h', 'cap_week', 'cap_month'];
// Call ids are kept a day; duplicates come from retries and double reports within minutes.
const ID_TTL_MS = DAY;
export const MAX_RECENT_IDS = 500;
const MAX_ID_LENGTH = 128;

/** Haiku 5.5 list prices in USD per million tokens. Prompts past longContextTokens bill every rate × longContextMultiplier. */
export const HAIKU_PRICES = Object.freeze({
  inputPerMTok: 0.10,
  outputPerMTok: 0.50,
  cacheReadPerMTok: 0.01,
  cacheWrite5mPerMTok: 0.125,
  cacheWrite1hPerMTok: 0.20,
  longContextTokens: 100_000,
  longContextMultiplier: 5,
});

/** Round to a micro-dollar so float sums never drift across a cap. */
export function usd(value) {
  return Math.round(value * 1e6) / 1e6;
}

export function finite(value) {
  const n = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(n) ? n : null;
}

const count = (value) => Math.max(0, Math.floor(finite(value) ?? 0));

/**
 * Cost of one call from its token counts. `cacheWrite5mTokens`/`cacheWrite1hTokens` are the TTL
 * breakdown of cache writes; the long-context rate applies when the whole prompt (input + cache
 * reads + cache writes) is past the threshold.
 */
export function costFromUsage(usage, prices = HAIKU_PRICES) {
  const input = count(usage?.inputTokens);
  const output = count(usage?.outputTokens);
  const read = count(usage?.cacheReadTokens);
  const write5m = count(usage?.cacheWrite5mTokens);
  const write1h = count(usage?.cacheWrite1hTokens);
  const prompt = input + read + write5m + write1h;
  const scale = prompt > prices.longContextTokens ? prices.longContextMultiplier : 1;
  const raw = input * prices.inputPerMTok
    + output * prices.outputPerMTok
    + read * prices.cacheReadPerMTok
    + write5m * prices.cacheWrite5mPerMTok
    + write1h * prices.cacheWrite1hPerMTok;
  return usd((raw * scale) / 1e6);
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

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** Repairs a stored entry in place (or makes a new one) so every field has its type. */
export function normalizeLedger(entry) {
  const next = plainObject(entry);
  next.minutes = plainObject(next.minutes);
  next.hours = plainObject(next.hours);
  next.ids = plainObject(next.ids);
  if (!next.period || typeof next.period.start !== 'string') next.period = null;
  next.totalUsd = finite(next.totalUsd) ?? 0;
  next.calls = count(next.calls);
  if (typeof next.lastCallAt !== 'string') next.lastCallAt = null;
  return next;
}

function prune(entry, at) {
  for (const key of Object.keys(entry.minutes)) {
    if ((Number(key) + 1) * MINUTE + FIVE_HOURS <= at) delete entry.minutes[key];
  }
  for (const key of Object.keys(entry.hours)) {
    if ((Number(key) + 1) * HOUR + WEEK <= at) delete entry.hours[key];
  }
  for (const [id, seen] of Object.entries(entry.ids)) {
    if (!(seen > at - ID_TTL_MS)) delete entry.ids[id];
  }
}

/**
 * Adds one call's cost. `id` (provider message or generation id) makes it idempotent: a seen id
 * returns {duplicate: true} and changes nothing. Mutates and returns nothing else.
 */
export function record(entry, { id, costUsd, at }, { periodAnchor } = {}) {
  normalizeLedger(entry);
  prune(entry, at);
  const key = typeof id === 'string' && id ? id.slice(0, MAX_ID_LENGTH) : null;
  if (key && Object.hasOwn(entry.ids, key)) return { duplicate: true };
  const cost = Math.max(0, finite(costUsd) ?? 0);

  const minute = Math.floor(at / MINUTE);
  const hour = Math.floor(at / HOUR);
  entry.minutes[minute] = usd((finite(entry.minutes[minute]) ?? 0) + cost);
  entry.hours[hour] = usd((finite(entry.hours[hour]) ?? 0) + cost);
  const period = billingPeriod(periodAnchor ?? at, at);
  const start = new Date(period.start).toISOString();
  if (entry.period?.start !== start) entry.period = { start, usedUsd: 0 };
  entry.period.usedUsd = usd((finite(entry.period.usedUsd) ?? 0) + cost);

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
  entry.lastCallAt = new Date(at).toISOString();
  return { duplicate: false, costUsd: usd(cost) };
}

/** Spend of a trailing window from buckets of `size` ms, and when it drops back under `limit`. */
function trailing(buckets, size, window, limit, now) {
  const live = [];
  for (const [key, value] of Object.entries(buckets)) {
    const expires = (Number(key) + 1) * size + window;
    const amount = finite(value) ?? 0;
    if (expires > now && amount > 0) live.push([expires, amount]);
  }
  let used = usd(live.reduce((sum, [, amount]) => sum + amount, 0));
  if (used < limit) return { usedUsd: used, resetsAt: null };
  live.sort((a, b) => a[0] - b[0]);
  const total = used;
  for (const [expires, amount] of live) {
    used = usd(used - amount);
    if (used < limit) return { usedUsd: total, resetsAt: expires };
  }
  // A zero limit never frees up within the window; report the window's own length.
  return { usedUsd: total, resetsAt: now + window };
}

/** Cap limits in USD for a plan: percentages of its monthly allowance. */
export function capLimits(plan, config) {
  const allowance = finite(plan?.allowanceUsd) ?? config.allowanceUsd;
  return {
    cap_5h: usd((allowance * config.cap5hPct) / 100),
    cap_week: usd((allowance * config.capWeekPct) / 100),
    cap_month: usd((allowance * config.capMonthPct) / 100),
  };
}

/**
 * The contract's `caps` object at `now` (resetsAt as epoch ms here; the service formats ISO).
 * cap_5h/cap_week resetsAt is null while under the cap; cap_month resetsAt is always the period end.
 */
export function windows(entry, plan, config, now) {
  const e = normalizeLedger(structuredClone(entry ?? {}));
  const limits = capLimits(plan, config);
  const fiveHours = trailing(e.minutes, MINUTE, FIVE_HOURS, limits.cap_5h, now);
  const week = trailing(e.hours, HOUR, WEEK, limits.cap_week, now);
  const period = billingPeriod(plan?.periodAnchor ?? now, now);
  const periodUsed = e.period && Date.parse(e.period.start) === period.start ? usd(finite(e.period.usedUsd) ?? 0) : 0;
  return {
    cap_5h: { usedUsd: fiveHours.usedUsd, limitUsd: limits.cap_5h, resetsAt: fiveHours.resetsAt },
    cap_week: { usedUsd: week.usedUsd, limitUsd: limits.cap_week, resetsAt: week.resetsAt },
    cap_month: { usedUsd: periodUsed, limitUsd: limits.cap_month, resetsAt: period.end },
    period,
  };
}

/**
 * null when a new call may start, else the blocking cap and when the call may start again. Claude
 * calls are held by every cap; cheap models only by cap_month. A window at or over its limit blocks.
 * With several caps blocking, the one that frees up last is reported.
 */
export function admission(entry, plan, config, now, { cheap = false } = {}) {
  const caps = windows(entry, plan, config, now);
  let blocked = null;
  for (const cap of cheap ? ['cap_month'] : CAP_NAMES) {
    const w = caps[cap];
    if (w.usedUsd < w.limitUsd) continue;
    if (!blocked || w.resetsAt > blocked.resetsAt) blocked = { cap, resetsAt: w.resetsAt };
  }
  return blocked;
}
