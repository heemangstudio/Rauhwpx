import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveLicenseConfig } from '../config.mjs';
import { generateLeaseKeyPair, parseSigningPrivateKey } from '../license-lease.mjs';
import { createLicensesService, emptyLicensesState } from '../licenses.mjs';
import { licensesMapper } from '../mappers/licenses.mjs';
import { webhookLogMapper } from '../mappers/webhook-log.mjs';
import { createPostgresStore } from '../pg-store.mjs';
import { createMemoryStore } from '../store.mjs';
import { uniqueInstallDigest } from '../unique-installs.mjs';
import { createWebhookLog, emptyWebhookLogState, webhookLogEntry } from '../webhook-log.mjs';
import { BASIC_ENV, basicPaid } from './fixtures/groble-basic.mjs';
import { differential, seededRandom } from './helpers/differential.mjs';
import { postgresSuite } from './helpers/postgres.mjs';

const pgSuite = postgresSuite();
const ADMIN = 'admin-token-for-pg-licenses';
const PAIR = generateLeaseKeyPair();
const PAID_AT = '2026-10-20T14:22:11+09:00';
const T0 = Date.parse(PAID_AT);
const DAY = 24 * 60 * 60 * 1000;
const BUYER_ACCOUNT = 'acct_00000000000000000a';
const INSTALL_ID = '22222222-2222-4222-8222-222222222222';

// Shapes follow https://groble.im/help/guides/webhook-events, as in subscriptions.test.mjs.
function annual({ merchantUid, round = 1, paidAt = PAID_AT, ref = 'hama-sub-1', email = 'subscriber@example.com' }) {
  return {
    id: `evt_sp_${merchantUid}`,
    type: 'subscription_payment.completed',
    occurredAt: paidAt,
    data: { object: {
      merchantUid,
      sellerReference: ref,
      buyer: { email },
      content: { id: 'GLJFC9', paymentType: 'SUBSCRIPTION' },
      pricing: { currency: 'KRW', originalAmount: 9900, finalAmount: 9900 },
      payment: { purchasedAt: paidAt },
      subscription: { billingReason: round === 1 ? 'INITIAL' : 'RENEWAL', currentRound: round, nextBillingDate: '2027-10-20', activatedAt: PAID_AT, billingCycleMonths: 12 },
    } },
  };
}

function oneTime({ merchantUid, originalAmount = 9900, email = 'buyer@example.com' }) {
  return {
    id: `evt_${merchantUid}`,
    type: 'payment.completed',
    occurredAt: '2026-10-16T01:00:00+09:00',
    data: { object: {
      merchantUid,
      sellerReference: `ref-${merchantUid}`,
      buyer: { email },
      content: { id: 'uRshdR', paymentType: 'ONE_TIME' },
      pricing: { currency: 'KRW', originalAmount, finalAmount: 9900 },
    } },
  };
}

function refunded(type, merchantUid, refundedAt, { partial = false, amount = 9900 } = {}) {
  return {
    id: `evt_rf_${merchantUid}_${refundedAt}`,
    type,
    occurredAt: refundedAt,
    data: { object: {
      merchantUid,
      pricing: { currency: 'KRW', finalAmount: 9900 },
      refund: { refundedAt, amount, partialRefund: partial, cancelledBy: 'SELLER', reason: '환불 요청' },
    } },
  };
}

function subscriptionEvent(type, fields) {
  return {
    id: `evt_${type}_${fields.at}`,
    type,
    occurredAt: fields.at,
    data: { object: { merchantUid: fields.merchantUid, sellerReference: 'hama-sub-1', buyer: { email: 'subscriber@example.com' }, content: { id: 'GLJFC9' }, ...fields.object } },
  };
}

function world(stores, clock) {
  const config = resolveLicenseConfig({ ...BASIC_ENV, ADMIN_TOKEN: ADMIN });
  const sent = [];
  const ids = seededRandom('webhook-log');
  const webhookLog = createWebhookLog({ store: stores.webhookLog, now: () => clock.now, newId: () => `wh_${ids(4).toString('hex')}` });
  const installs = createMemoryStore({ installs: { [uniqueInstallDigest(INSTALL_ID)]: { os: 'darwin', firstSeenAt: '2026-09-01T00:00:00.000Z' } } });
  const licenses = createLicensesService({
    store: stores.licenses,
    uniqueInstallsStore: installs,
    webhookLog,
    products: config.products,
    signingKey: parseSigningPrivateKey(PAIR.privateKeyPem),
    adminToken: ADMIN,
    grandfatherCutoff: Date.parse('2026-10-10T00:00:00Z'),
    now: () => clock.now,
    random: seededRandom('licenses'),
    accountForEmail: async (email) => (email === 'pro@example.com' ? BUYER_ACCOUNT : null),
    emailProvider: { name: 'test', async send(message) { sent.push(message.to); return { status: 'sent', providerId: `msg_${sent.length}` }; } },
    log: () => {},
  });
  return { stores, licenses, webhookLog, sent };
}

function orderOf(name, state) {
  if (name === 'licenses') {
    return {
      licenses: Object.keys(state.licenses),
      devices: Object.values(state.licenses).map((l) => Object.keys(l.devices ?? {})),
      orders: Object.keys(state.orders),
      refs: Object.keys(state.refs),
      webhookEvents: Object.keys(state.webhookEvents),
      giftCodeBatches: Object.keys(state.giftCodeBatches),
      giftCodes: Object.keys(state.giftCodes),
    };
  }
  return state.entries.map((e) => e.id);
}

test('licenses on Postgres answer and store exactly what the memory store does, and reload to the same state', async (t) => {
  const db = pgSuite.db(t);
  if (!db) return;
  await pgSuite.reset();
  const clock = { now: T0 };
  const worlds = {
    memory: world({ licenses: createMemoryStore(emptyLicensesState()), webhookLog: createMemoryStore(emptyWebhookLogState()) }, clock),
    postgres: world({
      licenses: createPostgresStore({ db, mapper: licensesMapper }),
      webhookLog: createPostgresStore({ db, mapper: webhookLogMapper }),
    }, clock),
  };
  const step = differential(worlds, { orderOf });
  const event = (body, idempotencyKey) => (w) => w.licenses.handleGrobleEvent(structuredClone(body), { idempotencyKey });
  const admin = (name, body) => (w) => w.licenses.admin[name](ADMIN, body);

  // Purchases: an annual subscription (and a retried delivery), a Pro monthly key linked to the buyer's account.
  assert.equal((await step('annual purchase', event(annual({ merchantUid: 'sub_m1' }), 'idem-1'))).value.action, 'issued');
  assert.equal((await step('retried delivery', event(annual({ merchantUid: 'sub_m1' }), 'idem-1'))).value.duplicate, true);
  await step('pro purchase', event(basicPaid({ merchantUid: 'pro_m1' }), 'idem-2'));
  const { value: { key } } = await step('success page', (w) => w.licenses.statusByRef('hama-sub-1'));
  const { value: { key: proKey } } = await step('pro success page', (w) => w.licenses.statusByRef('hama-pro-1'));

  // Devices: two fit, the third is refused, validate, deactivate.
  const device = (n) => ({ key, deviceId: `device-${n}-0000`, appVersion: '2.1.0', platform: 'darwin' });
  const { value: activated } = await step('activate 1', (w) => w.licenses.activate(device(1)));
  await step('activate 2', (w) => w.licenses.activate(device(2)));
  assert.equal((await step('activate 3', (w) => w.licenses.activate(device(3)))).error.code, 'device_limit');
  clock.now += DAY;
  await step('validate', (w) => w.licenses.validate(device(1)));
  await step('deactivate', (w) => w.licenses.deactivate(device(2)));
  await step('lease', (w) => w.licenses.authenticateLease(activated.lease, { withRauPlan: true }));

  // Renewal, a failed renewal payment, a cancel request, a refunded round.
  clock.now = Date.parse('2027-10-20T15:00:00+09:00');
  assert.equal((await step('renewal', event(annual({ merchantUid: 'sub_m2', round: 2, paidAt: '2027-10-20T14:22:11+09:00' }), 'idem-3'))).value.action, 'renewed');
  await step('failed payment', event(subscriptionEvent('subscription_payment.failed', {
    at: '2027-10-21T14:22:11+09:00',
    merchantUid: 'sub_fail_1',
    object: { failure: { attemptNumber: 1, isFinal: false, reason: 'CARD_EXPIRED', failedAt: '2027-10-21T14:22:11+09:00', nextRetryAt: '2027-10-22T14:22:11+09:00' } },
  }), 'idem-4'));
  await step('cancel requested', event(subscriptionEvent('subscription.cancel_requested', {
    at: '2027-11-01T10:00:00+09:00',
    merchantUid: 'sub_m1',
    object: { cancelRequest: { requestedBy: 'BUYER', requestedAt: '2027-11-01T10:00:00+09:00' }, serviceEndsAt: '2028-10-20T23:59:59+09:00' },
  }), 'idem-5'));
  assert.equal((await step('round refund', event(refunded('subscription_payment.refunded', 'sub_m2', '2027-11-02T10:00:00+09:00'), 'idem-6'))).value.action, 'round_refunded');

  // A one-time key and its refund; a held order (wrong price) and its release.
  await step('one-time purchase', event(oneTime({ merchantUid: 'ot_1' }), 'idem-7'));
  await step('partial refund', event(refunded('payment.refunded', 'ot_1', '2027-11-03T10:00:00+09:00', { partial: true, amount: 1000 }), 'idem-8'));
  assert.equal((await step('full refund', event(refunded('payment.refunded', 'ot_1', '2027-11-04T10:00:00+09:00'), 'idem-9'))).value.action, 'revoked');
  assert.equal((await step('held purchase', event(oneTime({ merchantUid: 'ot_held', originalAmount: 5000 }), 'idem-10'))).value.action, 'held');
  await step('unknown event', event({ id: 'evt_x', type: 'payment.mystery', data: { object: { merchantUid: 'm_x' } } }, 'idem-11'));
  await step('attention', (w) => w.licenses.admin.attention(ADMIN));
  await step('release', admin('release', { merchantUid: 'ot_held' }));
  await step('second held purchase', event(oneTime({ merchantUid: 'ot_held2', originalAmount: 5000 }), 'idem-10b'));
  await step('ack held order', admin('ack', { merchantUid: 'ot_held2' }));
  // A held renewal nobody could match, applied by the owner to the annual key.
  await step('held renewal', event(annual({ merchantUid: 'sub_m3', round: 3, ref: 'other-ref', paidAt: '2027-11-05T10:00:00+09:00' }), 'idem-12'));
  await step('apply renewal', admin('applyRenewal', { merchantUid: 'sub_m3', key }));

  // Admin keys and operations.
  await step('issue lifetime', admin('issue', { email: 'gift@example.com', merchantUid: 'manual_1', ref: 'gift-ref', note: '선물', sendEmail: true }));
  await step('issue annual', admin('issue', { email: 'annual@example.com', years: 1 }));
  await step('issue signature', admin('issue', { email: 'sig@example.com', edition: 'signature', ref: 'sig-ref' }));
  await step('issue beta', admin('issueBeta', { name: '베타', email: 'beta@example.com', devices: 3 }));
  await step('issue taken ref', admin('issue', { ref: 'gift-ref', merchantUid: 'other' }));
  await step('revoke', admin('revoke', { key: proKey, reason: 'test' }));
  await step('restore', admin('restore', { key: proKey }));
  await step('extend', admin('extend', { key, years: 2, note: 'goodwill' }));
  await step('extend lifetime', admin('extend', { merchantUid: 'manual_1', years: 1 }));
  await step('remove device', admin('removeDevice', { key, deviceId: 'device-1-0000' }));
  await step('activate again', (w) => w.licenses.activate(device(4)));
  await step('reset devices', admin('resetDevices', { key }));
  await step('resend email', admin('resendEmail', { key, email: 'new@example.com' }));
  await step('deliver emails', (w) => w.licenses.deliverPendingEmails());

  // Account links.
  await step('link by email', (w) => w.licenses.linkByEmail('gift@example.com', 'acct_00000000000000000b'));
  await step('redeem', (w) => w.licenses.redeemForAccount('acct_00000000000000000c', key));
  await step('redeem elsewhere', (w) => w.licenses.redeemForAccount('acct_00000000000000000d', key));
  await step('claim taken', (w) => w.licenses.claimForAccount('acct_00000000000000000d', { orderId: 'sub_m1', email: 'SUBSCRIBER@example.com' }));
  assert.equal((await step('claim', (w) => w.licenses.claimForAccount('acct_00000000000000000d', { orderId: 'ot_held', email: 'BUYER@example.com' }))).ok, true);
  await step('admin unlink', admin('unlinkAccount', { key }));
  await step('admin link', admin('linkAccount', { key, accountId: 'acct_00000000000000000d' }));
  await step('entitlements', (w) => w.licenses.accountEntitlements('acct_00000000000000000d'));
  await step('unlink account', (w) => w.licenses.unlinkAccount(BUYER_ACCOUNT, { refuseActiveSubscription: true }));
  await step('grandfather', (w) => w.licenses.grandfather({ installId: INSTALL_ID }));
  await step('grandfather again', (w) => w.licenses.grandfather({ installId: INSTALL_ID }));

  // Gift codes: two batches, a redeem and its repeat, another account, then revokes.
  const { value: { codes: basicCodes, batch: basicBatch } } = await step('issue gift codes', admin('issueGiftCodes', { plan: 'basic', durationMonths: 3, count: 3, note: '선물' }));
  const { value: { codes: hamaCodes } } = await step('issue gift codes in days', admin('issueGiftCodes', { plan: 'hama', durationDays: 14, count: 2, redeemBy: '2028-12-31' }));
  await step('redeem gift code', (w) => w.licenses.redeemGiftCode('acct_00000000000000000e', basicCodes[0]));
  assert.equal((await step('redeem gift code again', (w) => w.licenses.redeemGiftCode('acct_00000000000000000e', basicCodes[0]))).value.alreadyRedeemed, true);
  assert.equal((await step('redeem gift code elsewhere', (w) => w.licenses.redeemGiftCode('acct_00000000000000000f', basicCodes[0]))).error.code, 'code_redeemed');
  await step('redeem hama gift code', (w) => w.licenses.redeemGiftCode('acct_00000000000000000f', hamaCodes[0]));
  await step('revoke gift code', admin('revokeGiftCodes', { code: basicCodes[1] }));
  await step('revoke gift batch', admin('revokeGiftCodes', { batchId: basicBatch.batchId }));
  await step('list gift codes', (w) => w.licenses.admin.giftCodes(ADMIN, {}));

  // The webhook log beside it.
  const entry = webhookLogEntry({ kind: 'rejected', reason: 'bad_signature', status: 503, verified: false, headers: { 'x-groble-timestamp': '1790000000', 'user-agent': 'forger' }, rawBody: Buffer.from('{"type":"x\\u0000"}') });
  const { value: logged } = await step('log rejected', (w) => w.webhookLog.record(entry));
  await step('log held', (w) => w.webhookLog.record(webhookLogEntry({ kind: 'held', reason: 'unknown_event_type:payment.mystery', status: 200, verified: true, headers: {}, rawBody: null, details: { action: 'ignored_event_type' } })));
  await step('ack log', (w) => w.webhookLog.ack(logged.id));
  await step('list log', (w) => w.webhookLog.list({}));

  // Every admin read.
  for (const name of ['customers', 'betas', 'signatures', 'orders', 'attention']) await step(name, (w) => w.licenses.admin[name](ADMIN, {}));
  await step('lookup', admin('lookup', { email: 'subscriber@example.com' }));
  await step('hama subscriptions', (w) => w.licenses.hamaSubscriptions());
  // Webhook deliveries older than 8 days are pruned on the next write.
  clock.now += 9 * DAY;
  await step('prune deliveries', event(oneTime({ merchantUid: 'ot_2' }), 'idem-13'));
  assert.deepEqual(worlds.memory.sent, worlds.postgres.sent);

  // A fresh process loads exactly the state the first one holds.
  const fresh = createPostgresStore({ db, mapper: licensesMapper });
  assert.deepStrictEqual(await fresh.read(), await worlds.postgres.stores.licenses.read());
  assert.deepStrictEqual(await createPostgresStore({ db, mapper: webhookLogMapper }).read(), await worlds.postgres.stores.webhookLog.read());
  // A NUL from a forged body is kept verbatim, as the JSON file keeps it.
  assert.equal((await fresh.read()).webhookEvents['idem-13'].action, 'issued');
  assert.equal((await worlds.postgres.stores.webhookLog.read()).entries[0].eventType, 'x\u0000');
});

test('licenses mapper keeps a legacy record losslessly and refuses a keyIndex that is not derived', () => {
  const legacy = {
    ...emptyLicensesState(),
    licenses: {
      lic_old: {
        keyId: 'lic_old', key: 'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', status: 'active', devices: { dev_a_0000: { lastSeenAt: 'yesterday' } },
        createdAt: '2026-10-16T01:00:00+09:00', amount: '9900', subscription: null, odd: { nested: [1, null] },
      },
    },
    keyIndex: { 'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE': 'lic_old' },
    orders: { m1: { merchantUid: 'm1', refunds: 'none', round: 1.5 } },
  };
  const rows = licensesMapper.toRows(legacy);
  assert.deepStrictEqual(licensesMapper.fromRows(JSON.parse(JSON.stringify(rows))), legacy);
  assert.throws(() => licensesMapper.toRows({ ...legacy, keyIndex: {} }), { code: 'store_misfit' });
  assert.throws(() => licensesMapper.toRows({ ...legacy, extra: {} }), { code: 'store_misfit' });
});
