import { checkRoot, defineTable, isPlainObject, mapEntries, setOwn, storeMisfit } from '../pg-store.mjs';

/**
 * rau.json ↔ rau_roots, rau_ledgers, rau_spend (migrations/003) and rau_allowances (migrations/002).
 *
 * - `ledgers: { [principalId]: ledger }` → rau_ledgers, one row per Rau license (keyId) or trial
 *   (accountId). The running period and the recent call ids stay json.
 * - `spend: { [UTC Monday]: { [model]: row } }` → rau_spend, one row per week and model. A week exists
 *   only through its models: addSpend always adds one to the week it creates and pruning drops whole
 *   weeks, so an empty week cannot be stored and is refused.
 * - `allowances` (the per-license OpenRouter keys of the earlier Rau-0.1) → rau_allowances, one row per
 *   license with the monthly ledger as json. The service never reads or changes it.
 * - rau_roots says which of the three maps the state holds: a file of the earlier Rau-0.1 has only
 *   `allowances`, the current service always writes `ledgers` and `spend`. Without its row (a new
 *   database) the state is the service's empty one, `{ ledgers: {}, spend: {} }`.
 */

const DOMAIN = 'rau';
const ROOT = ['allowances', 'ledgers', 'spend'];

const ROOTS = defineTable('rau_roots', {
  key: ['id'],
  given: { id: 'text', has_allowances: 'bool', has_ledgers: 'bool', has_spend: 'bool' },
  extra: false,
});

const ALLOWANCES = defineTable('rau_allowances', {
  key: ['key_id'],
  fields: {
    key_id: ['text', 'keyId', { required: true }],
    status: ['text', 'status'],
    name: ['text', 'name'],
    openrouter_hash: ['text', 'openrouterHash'],
    openrouter_key: ['text', 'openrouterKey'],
    cap_usd: ['double', 'capUsd'],
    period: ['text', 'period'],
    ledger: ['object', 'ledger'],
    started_at: ['time', 'startedAt'],
    created_at: ['time', 'createdAt'],
    limit_set_at: ['time', 'limitSetAt'],
    last_used_at: ['time', 'lastUsedAt'],
  },
});

const LEDGERS = defineTable('rau_ledgers', {
  key: ['principal_id'],
  given: { principal_id: 'text' },
  fields: {
    source: ['text', 'source'],
    period: ['object', 'period'],
    ids: ['object', 'ids'],
    total_usd: ['double', 'totalUsd'],
    calls: ['int', 'calls'],
    last_call_at: ['time', 'lastCallAt'],
  },
});

// Token counts are bigint columns; `epoch` is the safe-integer ↔ bigint type.
const SPEND = defineTable('rau_spend', {
  key: ['week', 'model'],
  group: ['week'],
  given: { week: 'date', model: 'text' },
  fields: {
    usd: ['double', 'usd'],
    calls: ['int', 'calls'],
    input_tokens: ['epoch', 'inputTokens'],
    output_tokens: ['epoch', 'outputTokens'],
    cache_read_tokens: ['epoch', 'cacheReadTokens'],
    cache_write_tokens: ['epoch', 'cacheWriteTokens'],
    routes: ['object', 'routes'],
  },
});

function toRows(state) {
  checkRoot(DOMAIN, state, ROOT);
  const has = (field) => state[field] !== undefined;
  const rows = {
    rau_roots: [ROOTS.pack(null, { id: DOMAIN, has_allowances: has('allowances'), has_ledgers: has('ledgers'), has_spend: has('spend') })],
    rau_allowances: [],
    rau_ledgers: [],
    rau_spend: [],
  };
  if (has('allowances')) {
    for (const [keyId, allowance] of mapEntries(DOMAIN, 'allowances', state.allowances)) {
      if (!isPlainObject(allowance) || allowance.keyId !== keyId) throw storeMisfit(`rau_allowances (${keyId}): not an allowance with this keyId`);
      rows.rau_allowances.push(ALLOWANCES.pack(allowance));
    }
  }
  if (has('ledgers')) {
    for (const [principalId, ledger] of mapEntries(DOMAIN, 'ledgers', state.ledgers)) {
      rows.rau_ledgers.push(LEDGERS.pack(ledger, { principal_id: principalId }));
    }
  }
  if (has('spend')) {
    for (const [week, models] of mapEntries(DOMAIN, 'spend', state.spend)) {
      if (!isPlainObject(models)) throw storeMisfit(`rau_spend (${week}): models are not an object`);
      const entries = Object.entries(models).filter(([, row]) => row !== undefined);
      if (!entries.length) throw storeMisfit(`rau_spend (${week}): a week without models`);
      for (const [model, row] of entries) rows.rau_spend.push(SPEND.pack(row, { week, model }));
    }
  }
  return rows;
}

function fromRows(rows) {
  const root = rows.rau_roots[0] ?? { has_allowances: false, has_ledgers: true, has_spend: true };
  const state = {};
  if (root.has_allowances) state.allowances = {};
  if (root.has_ledgers) state.ledgers = {};
  if (root.has_spend) state.spend = {};
  const into = (field, table) => {
    if (!state[field]) throw storeMisfit(`${table} rows for a state without ${field}`);
    return state[field];
  };
  for (const row of rows.rau_allowances) setOwn(into('allowances', 'rau_allowances'), row.key_id, ALLOWANCES.unpack(row));
  for (const row of rows.rau_ledgers) setOwn(into('ledgers', 'rau_ledgers'), row.principal_id, LEDGERS.unpack(row));
  for (const row of rows.rau_spend) {
    const spend = into('spend', 'rau_spend');
    if (!Object.hasOwn(spend, row.week)) setOwn(spend, row.week, {});
    setOwn(spend[row.week], row.model, SPEND.unpack(row));
  }
  return state;
}

export const rauMapper = Object.freeze({
  domain: DOMAIN,
  tables: [ROOTS, ALLOWANCES, LEDGERS, SPEND],
  toRows,
  fromRows,
});
