import { checkRoot, defineTable, isPlainObject, mapEntries, setOwn, storeMisfit } from '../pg-store.mjs';

/**
 * licenses.json ↔ licenses, license_subscriptions, license_devices, groble_orders, groble_refs,
 * groble_webhook_deliveries, grandfathered_installs, gift_code_batches, gift_codes (migrations/001). `keyIndex` is derived from
 * the license keys: createLicense is its only writer, licenses are never deleted and a key never
 * changes, so toRows refuses a state where it is anything else.
 */

const DOMAIN = 'licenses';
const ROOT = ['licenses', 'keyIndex', 'orders', 'refs', 'webhookEvents', 'grandfathered', 'giftCodeBatches', 'giftCodes'];

const LICENSES = defineTable('licenses', {
  key: ['key_id'],
  fields: {
    key_id: ['text', 'keyId', { required: true }],
    key: ['text', 'key', { required: true }],
    status: ['text', 'status'],
    tier: ['text', 'tier'],
    source: ['text', 'source'],
    edition: ['text', 'edition'],
    product_id: ['text', 'productId'],
    name: ['text', 'name'],
    email: ['text', 'email'],
    merchant_uid: ['text', 'merchantUid'],
    ref: ['text', 'ref'],
    amount: ['double', 'amount'],
    device_limit: ['int', 'deviceLimit'],
    billing_cycle_months: ['int', 'billingCycleMonths'],
    install_digest: ['text', 'installDigest'],
    account_id: ['text', 'accountId'],
    linked_by: ['text', 'linkedBy'],
    linked_at: ['time', 'linkedAt'],
    unlinked_by: ['text', 'unlinkedBy'],
    unlinked_at: ['time', 'unlinkedAt'],
    occurred_at: ['time', 'occurredAt'],
    created_at: ['time', 'createdAt'],
    expires_at: ['time', 'expiresAt'],
    updates_until: ['time', 'updatesUntil'],
    revoked_at: ['time', 'revokedAt'],
    revoke_reason: ['text', 'revokeReason'],
    restored_at: ['time', 'restoredAt'],
    note: ['text', 'note'],
    gift_batch_id: ['text', 'giftBatchId'],
    email_delivery: ['object', 'emailDelivery'],
    support: ['object', 'support'],
    extensions: ['array', 'extensions'],
  },
});

const SUBSCRIPTIONS = defineTable('license_subscriptions', {
  key: ['key_id'],
  ordered: false,
  given: { key_id: 'text' },
  fields: {
    product_id: ['text', 'productId'],
    status: ['text', 'status'],
    auto_renew: ['bool', 'autoRenew'],
    manual: ['bool', 'manual'],
    billing_cycle_months: ['int', 'billingCycleMonths'],
    current_round: ['int', 'currentRound'],
    activated_at: ['time', 'activatedAt'],
    last_paid_at: ['time', 'lastPaidAt'],
    next_billing_date: ['date', 'nextBillingDate'],
    payment_grace_ends_at: ['time', 'paymentGraceEndsAt'],
    cancel_requested_at: ['time', 'cancelRequestedAt'],
    cancel_requested_by: ['text', 'cancelRequestedBy'],
    service_ends_at: ['time', 'serviceEndsAt'],
    terminated_at: ['time', 'terminatedAt'],
    termination_reason: ['text', 'terminationReason'],
    cancelled_by: ['text', 'cancelledBy'],
    last_failure: ['object', 'lastFailure'],
  },
});

const DEVICES = defineTable('license_devices', {
  key: ['key_id', 'device_id'],
  group: ['key_id'],
  given: { key_id: 'text', device_id: 'text' },
  fields: {
    activated_at: ['time', 'activatedAt'],
    last_seen_at: ['time', 'lastSeenAt'],
    app_version: ['text', 'appVersion'],
    platform: ['text', 'platform'],
  },
});

const ORDERS = defineTable('groble_orders', {
  key: ['merchant_uid'],
  fields: {
    merchant_uid: ['text', 'merchantUid', { required: true }],
    status: ['text', 'status'],
    kind: ['text', 'kind'],
    source: ['text', 'source'],
    key_id: ['text', 'keyId'],
    ref: ['text', 'ref'],
    email: ['text', 'email'],
    content_id: ['text', 'contentId'],
    amount: ['double', 'amount'],
    original_amount: ['double', 'originalAmount'],
    coupon_code: ['text', 'couponCode'],
    billing_cycle_months: ['int', 'billingCycleMonths'],
    round: ['int', 'round'],
    hold_reason: ['text', 'holdReason'],
    released_hold_reason: ['text', 'releasedHoldReason'],
    created_at: ['time', 'createdAt'],
    purchased_at: ['time', 'purchasedAt'],
    completed_at: ['time', 'completedAt'],
    completed_event_id: ['text', 'completedEventId'],
    last_event_at: ['time', 'lastEventAt'],
    acked_at: ['time', 'ackedAt'],
    grant_from: ['time', 'grantFrom'],
    grant_to: ['time', 'grantTo'],
    refunded_at: ['time', 'refundedAt'],
    refunds: ['array', 'refunds'],
    cancel_requests: ['array', 'cancelRequests'],
  },
});

const REFS = defineTable('groble_refs', { key: ['ref'], given: { ref: 'text', merchant_uid: 'text' }, extra: false });

const DELIVERIES = defineTable('groble_webhook_deliveries', {
  key: ['idempotency_key'],
  given: { idempotency_key: 'text' },
  fields: {
    received_at: ['time', 'receivedAt'],
    type: ['text', 'type'],
    event_id: ['text', 'eventId'],
    merchant_uid: ['text', 'merchantUid'],
    action: ['text', 'action'],
  },
});

const GRANDFATHERED = defineTable('grandfathered_installs', {
  key: ['install_digest'],
  given: { install_digest: 'text', key_id: 'text' },
  extra: false,
});

const GIFT_BATCHES = defineTable('gift_code_batches', {
  key: ['batch_id'],
  fields: {
    batch_id: ['text', 'batchId', { required: true }],
    plan: ['text', 'plan'],
    duration_months: ['int', 'durationMonths'],
    duration_days: ['int', 'durationDays'],
    count: ['int', 'count'],
    note: ['text', 'note'],
    redeem_by: ['time', 'redeemBy'],
    created_at: ['time', 'createdAt'],
  },
});

const GIFT_CODES = defineTable('gift_codes', {
  key: ['code_hash'],
  secretKey: true,
  fields: {
    code_hash: ['text', 'codeHash', { required: true }],
    batch_id: ['text', 'batchId'],
    prefix: ['text', 'prefix'],
    status: ['text', 'status'],
    created_at: ['time', 'createdAt'],
    redeemed_at: ['time', 'redeemedAt'],
    account_id: ['text', 'accountId'],
    key_id: ['text', 'keyId'],
    revoked_at: ['time', 'revokedAt'],
    revoke_reason: ['text', 'revokeReason'],
  },
});

function toRows(state) {
  checkRoot(DOMAIN, state, ROOT);
  const rows = {
    licenses: [],
    license_subscriptions: [],
    license_devices: [],
    groble_orders: [],
    groble_refs: [],
    groble_webhook_deliveries: [],
    grandfathered_installs: [],
    gift_code_batches: [],
    gift_codes: [],
  };
  const derivedIndex = new Map();
  for (const [keyId, license] of mapEntries(DOMAIN, 'licenses', state.licenses)) {
    if (!isPlainObject(license) || license.keyId !== keyId) throw storeMisfit(`licenses (${keyId}): not a license with this keyId`);
    const { devices, subscription, ...rest } = license;
    if (isPlainObject(devices)) {
      for (const [deviceId, device] of Object.entries(devices)) {
        rows.license_devices.push(DEVICES.pack(device, { key_id: keyId, device_id: deviceId }));
      }
    } else if (devices === undefined) {
      // createLicense always sets it, so an absent map cannot be told from an empty one.
      throw storeMisfit(`licenses (${keyId}): devices is missing`);
    } else {
      setOwn(rest, 'devices', devices);
    }
    if (isPlainObject(subscription)) rows.license_subscriptions.push(SUBSCRIPTIONS.pack(subscription, { key_id: keyId }));
    else if (subscription !== undefined) setOwn(rest, 'subscription', subscription);
    rows.licenses.push(LICENSES.pack(rest));
    derivedIndex.set(license.key, keyId);
  }
  const keyIndex = mapEntries(DOMAIN, 'keyIndex', state.keyIndex);
  if (keyIndex.length !== derivedIndex.size || keyIndex.some(([key, keyId]) => derivedIndex.get(key) !== keyId)) {
    throw storeMisfit('licenses.keyIndex is not the index of the license keys');
  }
  for (const [merchantUid, order] of mapEntries(DOMAIN, 'orders', state.orders)) {
    if (!isPlainObject(order) || order.merchantUid !== merchantUid) throw storeMisfit(`groble_orders (${merchantUid}): not an order with this merchantUid`);
    rows.groble_orders.push(ORDERS.pack(order));
  }
  for (const [ref, merchantUid] of mapEntries(DOMAIN, 'refs', state.refs)) {
    rows.groble_refs.push(REFS.pack(null, { ref, merchant_uid: merchantUid }));
  }
  for (const [key, entry] of mapEntries(DOMAIN, 'webhookEvents', state.webhookEvents)) {
    rows.groble_webhook_deliveries.push(DELIVERIES.pack(entry, { idempotency_key: key }));
  }
  for (const [digest, keyId] of mapEntries(DOMAIN, 'grandfathered', state.grandfathered)) {
    rows.grandfathered_installs.push(GRANDFATHERED.pack(null, { install_digest: digest, key_id: keyId }));
  }
  for (const [batchId, batch] of mapEntries(DOMAIN, 'giftCodeBatches', state.giftCodeBatches)) {
    if (!isPlainObject(batch) || batch.batchId !== batchId) throw storeMisfit(`gift_code_batches (${batchId}): not a batch with this batchId`);
    rows.gift_code_batches.push(GIFT_BATCHES.pack(batch));
  }
  for (const [codeHash, code] of mapEntries(DOMAIN, 'giftCodes', state.giftCodes)) {
    if (!isPlainObject(code) || code.codeHash !== codeHash) throw storeMisfit('gift_codes (…): not a code with this codeHash');
    rows.gift_codes.push(GIFT_CODES.pack(code));
  }
  return rows;
}

function fromRows(rows) {
  const state = { licenses: {}, keyIndex: {}, orders: {}, refs: {}, webhookEvents: {}, grandfathered: {}, giftCodeBatches: {}, giftCodes: {} };
  for (const row of rows.licenses) {
    const license = LICENSES.unpack(row);
    if (!Object.hasOwn(license, 'devices')) license.devices = {};
    setOwn(state.licenses, row.key_id, license);
    setOwn(state.keyIndex, row.key, row.key_id);
  }
  for (const row of rows.license_subscriptions) state.licenses[row.key_id].subscription = SUBSCRIPTIONS.unpack(row);
  for (const row of rows.license_devices) {
    const { devices } = state.licenses[row.key_id];
    if (!isPlainObject(devices)) throw storeMisfit(`licenses (${row.key_id}): device rows for a devices value that is not a map`);
    setOwn(devices, row.device_id, DEVICES.unpack(row));
  }
  for (const row of rows.groble_orders) setOwn(state.orders, row.merchant_uid, ORDERS.unpack(row));
  for (const row of rows.groble_refs) setOwn(state.refs, row.ref, row.merchant_uid);
  for (const row of rows.groble_webhook_deliveries) setOwn(state.webhookEvents, row.idempotency_key, DELIVERIES.unpack(row));
  for (const row of rows.grandfathered_installs) setOwn(state.grandfathered, row.install_digest, row.key_id);
  for (const row of rows.gift_code_batches) setOwn(state.giftCodeBatches, row.batch_id, GIFT_BATCHES.unpack(row));
  for (const row of rows.gift_codes) setOwn(state.giftCodes, row.code_hash, GIFT_CODES.unpack(row));
  return state;
}

export const licensesMapper = Object.freeze({
  domain: DOMAIN,
  tables: [LICENSES, SUBSCRIPTIONS, DEVICES, ORDERS, REFS, DELIVERIES, GRANDFATHERED, GIFT_BATCHES, GIFT_CODES],
  toRows,
  fromRows,
});
