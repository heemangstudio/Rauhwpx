import { checkRoot, defineTable, isPlainObject, mapEntries, setOwn, storeMisfit } from '../pg-store.mjs';

/**
 * rau.json `{ allowances: { [keyId]: allowance } }` ↔ rau_allowances (migrations/002), one row per
 * license. The monthly ledger (`{ 'YYYY-MM': usd }`, the last few months) stays json.
 */

const DOMAIN = 'rau';

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

export const rauMapper = Object.freeze({
  domain: DOMAIN,
  tables: [ALLOWANCES],
  toRows(state) {
    checkRoot(DOMAIN, state, ['allowances']);
    return {
      rau_allowances: mapEntries(DOMAIN, 'allowances', state.allowances).map(([keyId, allowance]) => {
        if (!isPlainObject(allowance) || allowance.keyId !== keyId) throw storeMisfit(`rau_allowances (${keyId}): not an allowance with this keyId`);
        return ALLOWANCES.pack(allowance);
      }),
    };
  },
  fromRows(rows) {
    const state = { allowances: {} };
    for (const row of rows.rau_allowances) setOwn(state.allowances, row.key_id, ALLOWANCES.unpack(row));
    return state;
  },
});
