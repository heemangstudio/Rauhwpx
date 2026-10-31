import { checkRoot, defineTable, isPlainObject, mapEntries, setOwn, storeMisfit } from '../pg-store.mjs';

/**
 * gifts.json `{ events: { [eventId]: { grants: { [keyId]: grant }, allocations: { [keyId]: usd } } } }`
 * ↔ gift_credit_events, gift_credit_grants, gift_credit_allocations (migrations/002). The gift
 * credits of gifts.mjs, not gift codes. Every event has a row, so an event whose maps are empty
 * survives; has_grants/has_allocations keep an event that has no such map apart from one whose map
 * is empty (events written before per-license amounts have no `allocations`). A map value that is
 * not an object map stays verbatim in the event's `extra`.
 */

const DOMAIN = 'gifts';

const EVENTS = defineTable('gift_credit_events', {
  key: ['event_id'],
  given: { event_id: 'text', has_grants: 'bool', has_allocations: 'bool' },
});

const GRANTS = defineTable('gift_credit_grants', {
  key: ['event_id', 'key_id'],
  group: ['event_id'],
  given: { event_id: 'text' },
  fields: {
    key_id: ['text', 'keyId', { required: true }],
    status: ['text', 'status'],
    name: ['text', 'name'],
    limit_usd: ['double', 'limitUsd'],
    pending_limit_usd: ['double', 'pendingLimitUsd'],
    source: ['text', 'source'],
    device_id: ['text', 'deviceId'],
    openrouter_hash: ['text', 'openrouterHash'],
    openrouter_key: ['text', 'openrouterKey'],
    started_at: ['time', 'startedAt'],
    claimed_at: ['time', 'claimedAt'],
    limit_changed_at: ['time', 'limitChangedAt'],
    revoked_at: ['time', 'revokedAt'],
    revoke_reason: ['text', 'revokeReason'],
  },
});

const ALLOCATIONS = defineTable('gift_credit_allocations', {
  key: ['event_id', 'key_id'],
  group: ['event_id'],
  given: { event_id: 'text', key_id: 'text' },
  fields: { amount_usd: ['double', 'amountUsd'] },
});

function toRows(state) {
  checkRoot(DOMAIN, state, ['events']);
  const rows = { gift_credit_events: [], gift_credit_grants: [], gift_credit_allocations: [] };
  for (const [eventId, event] of mapEntries(DOMAIN, 'events', state.events)) {
    if (!isPlainObject(event)) throw storeMisfit(`gift_credit_events (${eventId}): entry is not an object`);
    const { grants, allocations, ...rest } = event;
    const hasGrants = isPlainObject(grants);
    const hasAllocations = isPlainObject(allocations);
    if (!hasGrants && grants !== undefined) setOwn(rest, 'grants', grants);
    if (!hasAllocations && allocations !== undefined) setOwn(rest, 'allocations', allocations);
    rows.gift_credit_events.push(EVENTS.pack(rest, { event_id: eventId, has_grants: hasGrants, has_allocations: hasAllocations }));
    if (hasGrants) {
      for (const [keyId, grant] of Object.entries(grants)) {
        if (!isPlainObject(grant) || grant.keyId !== keyId) throw storeMisfit(`gift_credit_grants (${eventId}, ${keyId}): not a grant with this keyId`);
        rows.gift_credit_grants.push(GRANTS.pack(grant, { event_id: eventId }));
      }
    }
    if (hasAllocations) {
      for (const [keyId, amount] of Object.entries(allocations)) {
        if (amount === undefined) continue;
        rows.gift_credit_allocations.push(ALLOCATIONS.pack({ amountUsd: amount }, { event_id: eventId, key_id: keyId }));
      }
    }
  }
  return rows;
}

function fromRows(rows) {
  const state = { events: {} };
  for (const row of rows.gift_credit_events) {
    const event = {};
    if (row.has_grants) event.grants = {};
    if (row.has_allocations) event.allocations = {};
    for (const [field, value] of Object.entries(EVENTS.unpack(row))) setOwn(event, field, value);
    setOwn(state.events, row.event_id, event);
  }
  for (const row of rows.gift_credit_grants) setOwn(state.events[row.event_id].grants, row.key_id, GRANTS.unpack(row));
  for (const row of rows.gift_credit_allocations) {
    setOwn(state.events[row.event_id].allocations, row.key_id, ALLOCATIONS.unpack(row).amountUsd);
  }
  return state;
}

export const giftsMapper = Object.freeze({
  domain: DOMAIN,
  tables: [EVENTS, GRANTS, ALLOCATIONS],
  toRows,
  fromRows,
});
