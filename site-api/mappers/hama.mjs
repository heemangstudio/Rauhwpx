import { checkRoot, defineTable, mapEntries, setOwn } from '../pg-store.mjs';

/**
 * hama.json `{ plans, ledgers }` ↔ hama_plans, hama_ledgers (migrations/002). The file of the old
 * hosted Hama plan is frozen: it is imported as it is and then only read (hama-legacy.mjs), never
 * written. The two maps are independent: the old plan kept a ledger for any key it billed, enrolled or
 * not. The ledger's buckets, call ids and period stay json. The old usage logs are not imported, and
 * hama_usage (002) stays empty.
 */

const DOMAIN = 'hama';

const PLANS = defineTable('hama_plans', {
  key: ['key_id'],
  given: { key_id: 'text' },
  fields: {
    status: ['text', 'status'],
    allowance_usd: ['double', 'allowanceUsd'],
    period_anchor: ['time', 'periodAnchor'],
    enrolled_at: ['time', 'enrolledAt'],
    disabled_at: ['time', 'disabledAt'],
    disabled_reason: ['text', 'disabledReason'],
  },
});

const LEDGERS = defineTable('hama_ledgers', {
  key: ['key_id'],
  given: { key_id: 'text' },
  fields: {
    minutes: ['object', 'minutes'],
    hours: ['object', 'hours'],
    ids: ['object', 'ids'],
    period: ['object', 'period'],
    total_usd: ['double', 'totalUsd'],
    calls: ['int', 'calls'],
    last_call_at: ['time', 'lastCallAt'],
  },
});

export const hamaMapper = Object.freeze({
  domain: DOMAIN,
  tables: [PLANS, LEDGERS],
  toRows(state) {
    checkRoot(DOMAIN, state, ['plans', 'ledgers']);
    return {
      hama_plans: mapEntries(DOMAIN, 'plans', state.plans).map(([keyId, plan]) => PLANS.pack(plan, { key_id: keyId })),
      hama_ledgers: mapEntries(DOMAIN, 'ledgers', state.ledgers).map(([keyId, ledger]) => LEDGERS.pack(ledger, { key_id: keyId })),
    };
  },
  fromRows(rows) {
    const state = { plans: {}, ledgers: {} };
    for (const row of rows.hama_plans) setOwn(state.plans, row.key_id, PLANS.unpack(row));
    for (const row of rows.hama_ledgers) setOwn(state.ledgers, row.key_id, LEDGERS.unpack(row));
    return state;
  },
});
