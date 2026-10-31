import { checkRoot, defineTable, storeMisfit } from '../pg-store.mjs';

/** webhook-log.json `{ entries: [...] }` ↔ webhook_log, one row per entry in array order (migrations/001). */

const DOMAIN = 'webhook_log';

const ENTRIES = defineTable('webhook_log', {
  key: ['id'],
  fields: {
    id: ['text', 'id', { required: true }],
    kind: ['text', 'kind'],
    reason: ['text', 'reason'],
    status: ['int', 'status'],
    verified: ['bool', 'verified'],
    logged_at: ['time', 'at'],
    acked_at: ['time', 'ackedAt'],
    groble_timestamp: ['text', 'timestamp'],
    idempotency_key: ['text', 'idempotencyKey'],
    event_type: ['text', 'eventType'],
    event_id: ['text', 'eventId'],
    merchant_uid: ['text', 'merchantUid'],
    action: ['text', 'action'],
    buyer_email: ['text', 'buyerEmail'],
    amount: ['double', 'amount'],
    headers: ['object', 'headers'],
  },
});

export const webhookLogMapper = Object.freeze({
  domain: DOMAIN,
  tables: [ENTRIES],
  toRows(state) {
    checkRoot(DOMAIN, state, ['entries']);
    if (!Array.isArray(state.entries)) throw storeMisfit('webhook_log.entries is not an array');
    return { webhook_log: Array.from(state.entries, (entry) => ENTRIES.pack(entry)) };
  },
  fromRows(rows) {
    return { entries: rows.webhook_log.map((row) => ENTRIES.unpack(row)) };
  },
});
