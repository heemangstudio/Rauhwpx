import { randomUUID } from 'node:crypto';

import { createMemoryStore } from './store.mjs';

/**
 * Rejected and held Groble webhooks, newest last, in their own store (webhook-log.json, or the
 * webhook_log table) so a flood of forged requests never rewrites the licenses. Bounded by entry
 * count and per-entry size.
 */
export const WEBHOOK_LOG_MAX_ENTRIES = 200;
const MAX_HEADERS = 30;
const MAX_HEADER_VALUE = 200;
const MAX_HEADER_BYTES = 2048;
// Never stored: the signatures themselves and anything that could carry a credential.
const DROPPED_HEADERS = new Set([
  'x-groble-signature',
  'x-groble-signature-previous',
  'authorization',
  'proxy-authorization',
  'cookie',
]);

export function emptyWebhookLogState() {
  return { entries: [] };
}

function clip(value, max) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function headerValue(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Request headers minus signatures and credentials, capped in count and total size. */
export function redactWebhookHeaders(headers = {}) {
  const out = {};
  let bytes = 0;
  for (const [name, raw] of Object.entries(headers)) {
    if (Object.keys(out).length >= MAX_HEADERS) break;
    const key = name.toLowerCase();
    if (DROPPED_HEADERS.has(key)) continue;
    const value = String(Array.isArray(raw) ? raw.join(', ') : raw).slice(0, MAX_HEADER_VALUE);
    bytes += key.length + value.length;
    if (bytes > MAX_HEADER_BYTES) break;
    out[key] = value;
  }
  return out;
}

/** Event type, id and merchantUid when the body is JSON. For unverified requests these are only claims. */
export function webhookBodySummary(rawBody) {
  if (!rawBody?.length) return {};
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {};
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return {};
  return {
    eventType: clip(event.type, 64),
    eventId: clip(event.id, 128),
    merchantUid: clip(event.data?.object?.merchantUid, 128),
  };
}

/**
 * What the dashboard and the held alert show for a verified event the server held: the outcome
 * (`held` = an order now waiting in `orders`), the buyer email and the paid amount.
 */
export function heldEventDetails(event, result) {
  const object = event?.data?.object;
  const amount = object?.pricing?.finalAmount;
  return {
    action: clip(result?.action, 64),
    buyerEmail: clip(object?.buyer?.email, 254),
    amount: typeof amount === 'number' && Number.isFinite(amount) ? amount : undefined,
  };
}

/**
 * One log entry from the raw request. `verified` says whether the signature matched.
 * `details` (verified held events only) comes from heldEventDetails.
 */
export function webhookLogEntry({ kind, reason, status, verified, headers, rawBody, details = {} }) {
  const entry = {
    kind,
    reason,
    status,
    verified,
    timestamp: clip(headerValue(headers, 'x-groble-timestamp'), 32),
    idempotencyKey: clip(headerValue(headers, 'x-groble-idempotency-key'), 200),
    ...webhookBodySummary(rawBody),
    ...details,
    headers: redactWebhookHeaders(headers),
  };
  for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
  return entry;
}

export function createWebhookLog({
  store = createMemoryStore(emptyWebhookLogState()),
  now = Date.now,
  maxEntries = WEBHOOK_LOG_MAX_ENTRIES,
  newId = () => `wh_${randomUUID().slice(0, 8)}`,
} = {}) {
  const entriesOf = (state) => (Array.isArray(state?.entries) ? state.entries : []);

  /** `fn(state)` runs alone on the store with `state.entries` an array; only `{ entries }` is kept. */
  async function mutate(fn) {
    const result = await store.update((state) => {
      const entries = entriesOf(state);
      for (const key of Object.keys(state)) delete state[key];
      state.entries = entries;
      return fn(state);
    });
    return result.value;
  }

  return {
    /** Append one entry and drop the oldest past `maxEntries`. */
    record(entry) {
      return mutate((state) => {
        let id;
        // Ids are the row key in Postgres, so a repeat (1 in 2^32 per entry) draws again.
        do id = newId(); while (state.entries.some((e) => e?.id === id));
        const saved = { id, at: new Date(now()).toISOString(), ...entry };
        state.entries = [...state.entries, saved].slice(-maxEntries);
        return { value: saved };
      });
    },
    /** Mark one entry as reviewed so the dashboard stops showing it. Resolves to the entry, or null. */
    ack(id) {
      return mutate((state) => {
        const entry = typeof id === 'string' ? state.entries.find((e) => e.id === id) : undefined;
        if (!entry) return { dirty: false, value: null };
        if (entry.ackedAt) return { dirty: false, value: entry };
        entry.ackedAt = new Date(now()).toISOString();
        return { value: entry };
      });
    },
    /** Newest first. `kind` is 'rejected' or 'held'; omit it for both. */
    async list({ kind, limit } = {}) {
      const max = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), maxEntries);
      const entries = entriesOf(await store.read())
        .filter((e) => !kind || e.kind === kind)
        .reverse()
        .slice(0, max);
      return { ok: true, count: entries.length, entries };
    },
  };
}
