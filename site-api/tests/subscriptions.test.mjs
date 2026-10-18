import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { resolveLicenseConfig } from '../config.mjs';
import { grobleSignature } from '../groble-webhook.mjs';
import { generateLeaseKeyPair, parseSigningPrivateKey, verifyLease } from '../license-lease.mjs';
import { createLicensesService, emptyLicensesState, subscriptionEnd } from '../licenses.mjs';
import { createSiteServer } from '../server.mjs';
import { createMemoryStore } from '../store.mjs';

// Payload shapes follow https://groble.im/help/guides/webhook-events (subscription_payment.completed,
// subscription_payment.failed, subscription.cancel_requested, subscription.terminated, read 2026-10-19).

const ADMIN = 'admin-token-for-subscription-tests';
const SECRET = 'whsec_test_subscriptions';
const PAIR = generateLeaseKeyPair();
const KEYS = { 'hama-prod-1': PAIR.publicKeyRawBase64 };
const DAY = 24 * 60 * 60 * 1000;
const PAID_AT = '2026-10-20T14:22:11+09:00';
const T0 = Date.parse(PAID_AT);
// Paid 2026-10-20 KST: the key runs through 2027-10-20 KST, the day Groble bills the renewal.
const FIRST_END = Date.parse('2027-10-20T23:59:59.999+09:00');
const CLI = fileURLToPath(new URL('../scripts/license-admin.mjs', import.meta.url));

function base({ merchantUid, ref = 'hama-sub-1', email = 'subscriber@example.com', contentId = 'GLJFC9', amount = 9900 }) {
  return {
    merchantUid,
    ...(ref ? { sellerReference: ref } : {}),
    buyer: { type: 'MEMBER', displayName: '구독자', email, phoneNumber: '01012345678' },
    content: { id: contentId, title: 'HamaEditor for Mac 연간 라이선스', type: 'SERVICE', paymentType: 'SUBSCRIPTION', inputMode: 'PAYMENT_WINDOW' },
    options: [{ optionId: 'o1', name: '연간', quantity: 1, unitOriginalPrice: 9900, unitDiscountedPrice: 9900, additionalOptions: [], subtotal: 9900 }],
    pricing: { currency: 'KRW', originalAmount: 9900, optionDiscountAmount: 0, finalAmount: amount, couponDiscountAmount: 0 },
  };
}

function paid({ merchantUid = 'sub_m1', round = 1, paidAt = PAID_AT, nextBillingDate = '2027-10-20', ...rest } = {}) {
  return {
    id: `evt_sp_${merchantUid}`,
    type: 'subscription_payment.completed',
    version: '2026-04-30',
    occurredAt: paidAt,
    data: { object: {
      ...base({ merchantUid, ...rest }),
      payment: { purchasedAt: paidAt },
      subscription: {
        billingReason: round === 1 ? 'INITIAL' : 'RENEWAL',
        currentRound: round,
        nextBillingDate,
        status: 'ACTIVE',
        activatedAt: PAID_AT,
        lastBillingSucceededAt: paidAt,
        billingCycleMonths: 12,
      },
    } },
  };
}

function failed({ merchantUid = 'sub_fail_1', attemptNumber = 1, isFinal = false, failedAt = '2027-10-20T14:22:11+09:00', ...rest } = {}) {
  return {
    id: `evt_sf_${merchantUid}_${attemptNumber}`,
    type: 'subscription_payment.failed',
    occurredAt: failedAt,
    data: { object: {
      ...base({ merchantUid, ...rest }),
      subscription: { billingReason: 'RENEWAL', currentRound: 2, nextBillingDate: '2027-10-21', status: isFinal ? 'CANCELLED' : 'PAST_DUE', activatedAt: PAID_AT, lastBillingSucceededAt: PAID_AT, billingCycleMonths: 12 },
      failure: { attemptNumber, isFinal, reason: 'CARD_EXPIRED', failedAt, ...(isFinal ? { gracePeriodEndsAt: '2027-10-30T14:22:11+09:00' } : { nextRetryAt: '2027-10-21T14:22:11+09:00' }) },
    } },
  };
}

function cancelRequested({ requestedAt = '2027-03-01T10:00:00+09:00', ...rest } = {}) {
  return {
    id: `evt_scr_${requestedAt}`,
    type: 'subscription.cancel_requested',
    occurredAt: requestedAt,
    data: { object: {
      ...base({ merchantUid: 'sub_m1', ...rest }),
      subscription: { status: 'CANCELLED', currentRound: 1, nextBillingDate: '2027-10-20', activatedAt: PAID_AT, cancelledAt: requestedAt, price: 9900, currency: 'KRW', billingCycleMonths: 12 },
      cancelRequest: { reason: { code: 'NOT_USED', label: '서비스를 잘 이용하지 않아요', legacyCode: 'ETC' }, detailReason: '이번 학기에는 쓰지 않아요', requestedBy: 'BUYER', requestedAt },
    } },
  };
}

function terminated({ reason = 'PERIOD_END', terminatedAt = '2027-10-20T23:59:59+09:00', ...rest } = {}) {
  return {
    id: `evt_st_${terminatedAt}`,
    type: 'subscription.terminated',
    occurredAt: terminatedAt,
    data: { object: {
      ...base({ merchantUid: 'sub_m1', ...rest }),
      subscription: { status: 'CANCELLED', currentRound: 1, activatedAt: PAID_AT, cancelledAt: '2027-03-01T10:00:00+09:00', price: 9900, currency: 'KRW', billingCycleMonths: 12 },
      cancelledBy: 'BUYER',
      termination: { reason, terminatedAt },
    } },
  };
}

function service(overrides = {}) {
  let clock = overrides.start ?? T0;
  const sent = [];
  const svc = createLicensesService({
    store: overrides.store ?? createMemoryStore(emptyLicensesState()),
    signingKey: parseSigningPrivateKey(PAIR.privateKeyPem),
    adminToken: ADMIN,
    now: () => clock,
    emailProvider: { name: 'test', async send(m) { sent.push(m); return { status: 'sent' }; } },
    log: () => {},
    ...overrides,
  });
  return { svc, sent, at: (ms) => { clock = ms; }, now: () => clock };
}

async function keyFor(svc, ref = 'hama-sub-1') {
  return (await svc.statusByRef(ref)).key;
}

async function licenseOf(svc, key) {
  return (await svc.admin.lookup(ADMIN, { key })).licenses[0];
}

test('subscriptionEnd: same KST date N months later, end of that day, clamped to the month', () => {
  assert.equal(subscriptionEnd(T0, 12), FIRST_END);
  // 00:30 KST is still the previous UTC day; the KST date wins.
  assert.equal(subscriptionEnd(Date.parse('2026-10-20T00:30:00+09:00'), 12), FIRST_END);
  assert.equal(subscriptionEnd(Date.parse('2028-02-29T12:00:00+09:00'), 12), Date.parse('2029-02-28T23:59:59.999+09:00'));
  assert.equal(subscriptionEnd(Date.parse('2026-08-31T12:00:00+09:00'), 6), Date.parse('2027-02-28T23:59:59.999+09:00'));
});

test('config: product ids default to uRshdR (one-time) and GLJFC9 (subscription); env and the old GROBLE_CONTENT_ID override', () => {
  const defaults = resolveLicenseConfig({});
  assert.deepEqual(defaults.onetimeProductIds, ['uRshdR']);
  assert.deepEqual(defaults.subscriptionProductIds, ['GLJFC9']);
  assert.deepEqual(resolveLicenseConfig({ GROBLE_CONTENT_ID: 'old1' }).onetimeProductIds, ['old1']);
  const env = resolveLicenseConfig({ GROBLE_CONTENT_ID: 'old1', GROBLE_ONETIME_PRODUCT_IDS: 'a, b', GROBLE_SUBSCRIPTION_PRODUCT_IDS: 'c' });
  assert.deepEqual(env.onetimeProductIds, ['a', 'b']);
  assert.deepEqual(env.subscriptionProductIds, ['c']);
  assert.throws(() => resolveLicenseConfig({ GROBLE_ONETIME_PRODUCT_IDS: 'x', GROBLE_SUBSCRIPTION_PRODUCT_IDS: 'x' }), /both one-time and subscription/);
});

test('first subscription payment issues one key that expires a year later, with the expiry in the lease', async () => {
  const { svc, sent } = service();
  const first = await svc.handleGrobleEvent(paid(), { idempotencyKey: 'i1' });
  assert.equal(first.action, 'issued');
  assert.equal(first.expiresAt, new Date(FIRST_END).toISOString());
  const status = await svc.statusByRef('hama-sub-1');
  assert.equal(status.status, 'issued');
  assert.equal(status.licenseExpiresAt, FIRST_END);

  const lease = await svc.activate({ key: status.key, deviceId: 'mac-sub-0001', platform: 'darwin' });
  assert.equal(lease.licenseExpiresAt, FIRST_END);
  assert.equal(lease.autoRenew, true);
  const checked = verifyLease(lease.lease, KEYS, { deviceId: 'mac-sub-0001', key: status.key, now: T0 });
  assert.equal(checked.ok, true);
  assert.equal(checked.payload.licenseExpiresAt, FIRST_END, 'the app can enforce the expiry offline');

  const view = await licenseOf(svc, status.key);
  assert.equal(view.plan, 'annual');
  assert.equal(view.subscription.status, 'active');
  await svc.deliverPendingEmails();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].html.includes('다음 갱신일은 2027년 10월 20일이에요.'));
});

test('a renewal extends the same key from its expiry; a replayed renewal never extends twice', async () => {
  const { svc, sent, at } = service();
  await svc.handleGrobleEvent(paid(), { idempotencyKey: 'i1' });
  const key = await keyFor(svc);
  await svc.deliverPendingEmails();
  at(Date.parse('2027-10-20T09:00:00+09:00'));
  const renewal = paid({ merchantUid: 'sub_m2', round: 2, paidAt: '2027-10-20T09:00:00+09:00', nextBillingDate: '2028-10-20' });
  const extended = await svc.handleGrobleEvent(renewal, { idempotencyKey: 'r1' });
  assert.equal(extended.action, 'renewed');
  const secondEnd = Date.parse('2028-10-20T23:59:59.999+09:00');
  assert.equal(extended.expiresAt, new Date(secondEnd).toISOString());

  // Same delivery again, and Groble's retry with a fresh delivery key: both are no-ops.
  assert.equal((await svc.handleGrobleEvent(renewal, { idempotencyKey: 'r1' })).duplicate, true);
  assert.equal((await svc.handleGrobleEvent(renewal, { idempotencyKey: 'r1-retry' })).action, 'already_renewed');
  const view = await licenseOf(svc, key);
  assert.equal(view.expiresAt, new Date(secondEnd).toISOString());
  assert.equal(view.subscription.currentRound, 2);
  assert.equal((await svc.admin.lookup(ADMIN, { email: 'subscriber@example.com' })).licenses.length, 1, 'no second key');

  await svc.deliverPendingEmails();
  assert.deepEqual(sent.map((m) => m.subject), ['[HamaEditor] Mac 라이선스 키를 보내드려요', '[HamaEditor] Mac 라이선스가 갱신됐어요']);
  assert.equal(sent[1].text, key);
  assert.ok(sent[1].html.includes('2028년 10월 20일'));
});

test('a renewal after the key lapsed extends from now and restores validate', async () => {
  const { svc, at } = service();
  await svc.handleGrobleEvent(paid(), { idempotencyKey: 'i1' });
  const key = await keyFor(svc);
  await svc.activate({ key, deviceId: 'mac-sub-0001' });

  at(FIRST_END + 2 * DAY);
  await assert.rejects(svc.validate({ key, deviceId: 'mac-sub-0001' }), (error) => error.code === 'expired' && error.status === 403 && error.licenseExpiresAt === FIRST_END);

  // Groble's retry succeeds two days late.
  const late = paid({ merchantUid: 'sub_m2', round: 2, paidAt: '2027-10-23T10:00:00+09:00' });
  const renewed = await svc.handleGrobleEvent(late, { idempotencyKey: 'late' });
  assert.equal(renewed.expiresAt, new Date(subscriptionEnd(FIRST_END + 2 * DAY, 12)).toISOString());
  const lease = await svc.validate({ key, deviceId: 'mac-sub-0001' });
  assert.equal(lease.ok, true);
  assert.equal(lease.licenseExpiresAt, Date.parse('2028-10-22T23:59:59.999+09:00'));
});

test('cancel requested: no renewal, the key runs to its expiry and then reports expired', async () => {
  const { svc, at } = service();
  await svc.handleGrobleEvent(paid(), { idempotencyKey: 'i1' });
  const key = await keyFor(svc);
  await svc.activate({ key, deviceId: 'mac-sub-0001' });

  at(Date.parse('2027-03-01T10:00:00+09:00'));
  assert.equal((await svc.handleGrobleEvent(cancelRequested(), { idempotencyKey: 'c1' })).action, 'cancel_recorded');
  const lease = await svc.validate({ key, deviceId: 'mac-sub-0001' });
  assert.equal(lease.licenseExpiresAt, FIRST_END);
  assert.equal(lease.autoRenew, false);

  at(FIRST_END);
  assert.equal((await svc.handleGrobleEvent(terminated(), { idempotencyKey: 't1' })).action, 'termination_recorded');
  await assert.rejects(svc.validate({ key, deviceId: 'mac-sub-0001' }), { code: 'expired' });
  await assert.rejects(svc.activate({ key, deviceId: 'mac-sub-0002' }), { code: 'expired' });
  const view = await licenseOf(svc, key);
  assert.equal(view.status, 'active', 'an ended subscription is expired, not revoked');
  assert.equal(view.subscription.status, 'terminated');
  assert.equal(view.subscription.terminationReason, 'PERIOD_END');
});

test('failed renewal payments change nothing until the expiry; no early revoke', async () => {
  const { svc, at } = service();
  await svc.handleGrobleEvent(paid(), { idempotencyKey: 'i1' });
  const key = await keyFor(svc);
  await svc.activate({ key, deviceId: 'mac-sub-0001' });

  at(Date.parse('2027-10-20T14:30:00+09:00'));
  assert.equal((await svc.handleGrobleEvent(failed(), { idempotencyKey: 'f1' })).action, 'payment_failure_recorded');
  await svc.handleGrobleEvent(failed({ merchantUid: 'sub_fail_3', attemptNumber: 3, isFinal: true, failedAt: '2027-10-20T20:00:00+09:00' }), { idempotencyKey: 'f3' });
  const lease = await svc.validate({ key, deviceId: 'mac-sub-0001' });
  assert.equal(lease.licenseExpiresAt, FIRST_END, 'still valid on the last paid day');
  const view = await licenseOf(svc, key);
  assert.equal(view.subscription.status, 'past_due');
  assert.equal(view.subscription.lastFailure.isFinal, true);

  at(FIRST_END + 1);
  await assert.rejects(svc.validate({ key, deviceId: 'mac-sub-0001' }), { code: 'expired' });
});

test('renewal without our ref matches the one live subscription with the buyer email; otherwise it is held for extend', async () => {
  const { svc, at } = service();
  await svc.handleGrobleEvent(paid(), { idempotencyKey: 'i1' });
  const key = await keyFor(svc);
  at(Date.parse('2027-10-20T09:00:00+09:00'));
  const byEmail = await svc.handleGrobleEvent(paid({ merchantUid: 'sub_m2', round: 2, ref: null }), { idempotencyKey: 'r-mail' });
  assert.equal(byEmail.action, 'renewed');
  assert.equal(byEmail.keyId, (await licenseOf(svc, key)).keyId);

  const stranger = await svc.handleGrobleEvent(paid({ merchantUid: 'sub_x2', round: 2, ref: 'hama-unknown', email: 'other@example.com' }), { idempotencyKey: 'r-x' });
  assert.deepEqual([stranger.action, stranger.reason, stranger.needsReview], ['held', 'renewal_unmatched', true]);
  await assert.rejects(svc.admin.release(ADMIN, { merchantUid: 'sub_x2' }), { code: 'renewal_use_extend' });
  const unmatched = await svc.handleGrobleEvent(cancelRequested({ ref: 'hama-unknown' }), { idempotencyKey: 'c-x' });
  assert.deepEqual([unmatched.action, unmatched.needsReview], ['subscription_unmatched', true]);
});

test('subscription holds: wrong product or price is held; a released subscription order still gets its expiry', async () => {
  const { svc } = service();
  const wrong = await svc.handleGrobleEvent(paid({ merchantUid: 'sub_w', ref: 'r-w', contentId: 'uRshdR' }), { idempotencyKey: 'w' });
  assert.deepEqual([wrong.action, wrong.reason], ['held', 'wrong_product:uRshdR']);
  const cheap = await svc.handleGrobleEvent(paid({ merchantUid: 'sub_c', ref: 'r-c', amount: 100 }), { idempotencyKey: 'c' });
  assert.equal(cheap.reason, 'amount_below_minimum:100');
  const released = await svc.admin.release(ADMIN, { merchantUid: 'sub_c' });
  assert.equal(released.license.plan, 'annual');
  assert.equal(released.license.expiresAt, new Date(FIRST_END).toISOString());
  // A one-time order for the subscription product is held too.
  const oneTimeOnSub = await svc.handleGrobleEvent({ id: 'e', type: 'payment.completed', occurredAt: PAID_AT, data: { object: { ...base({ merchantUid: 'ot', ref: 'r-ot' }), content: { id: 'GLJFC9', paymentType: 'ONE_TIME' } } } }, { idempotencyKey: 'ot' });
  assert.equal(oneTimeOnSub.reason, 'wrong_product:GLJFC9');
});

test('refunding a renewal round takes back its year; refunding every round revokes', async () => {
  const { svc, at } = service();
  await svc.handleGrobleEvent(paid(), { idempotencyKey: 'i1' });
  const key = await keyFor(svc);
  at(Date.parse('2027-10-20T09:00:00+09:00'));
  await svc.handleGrobleEvent(paid({ merchantUid: 'sub_m2', round: 2 }), { idempotencyKey: 'r2' });
  const refund = (merchantUid, refundedAt) => ({
    id: `evt_srf_${merchantUid}`,
    type: 'subscription_payment.refunded',
    occurredAt: refundedAt,
    data: { object: {
      ...base({ merchantUid, ref: null }),
      refund: { amount: 9900, currency: 'KRW', partialRefund: false, cancelledBy: 'BUYER', refundedAt },
      subscription: { refundedRound: 2, currentRound: 2, status: 'ACTIVE', billingCycleMonths: 12 },
    } },
  });
  const round = await svc.handleGrobleEvent(refund('sub_m2', '2027-10-21T10:00:00+09:00'), { idempotencyKey: 'rf2' });
  assert.equal(round.action, 'round_refunded');
  assert.equal(round.expiresAt, new Date(FIRST_END).toISOString());
  const all = await svc.handleGrobleEvent(refund('sub_m1', '2027-10-21T11:00:00+09:00'), { idempotencyKey: 'rf1' });
  assert.equal(all.action, 'revoked');
  assert.equal((await licenseOf(svc, key)).status, 'revoked');
});

test('migration: existing records without expiresAt stay lifetime, and one-time and free keys are still issued lifetime', async () => {
  // Shape of the production file before this change: one paid order, a manual test key, a beta key, a grandfathered key.
  const legacy = {
    licenses: {
      lic_paid: { keyId: 'lic_paid', key: 'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', status: 'active', source: 'groble', merchantUid: 'm_old', amount: 9900, createdAt: '2026-10-17T00:00:00.000Z', devices: {} },
      lic_test: { keyId: 'lic_test', key: 'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-FFFFF', status: 'active', source: 'manual', createdAt: '2026-10-16T00:00:00.000Z', devices: {} },
      lic_beta: { keyId: 'lic_beta', key: 'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-GGGGG', status: 'active', source: 'beta', tier: 'beta', deviceLimit: 5, createdAt: '2026-10-16T00:00:00.000Z', devices: {} },
    },
    keyIndex: {
      'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE': 'lic_paid',
      'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-FFFFF': 'lic_test',
      'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-GGGGG': 'lic_beta',
    },
    orders: { m_old: { merchantUid: 'm_old', status: 'issued', keyId: 'lic_paid' } },
    refs: {},
    webhookEvents: {},
    grandfathered: {},
  };
  const installId = '11111111-2222-4333-8444-555555555555';
  const { uniqueInstallDigest } = await import('../unique-installs.mjs');
  const installs = createMemoryStore({ installs: { [uniqueInstallDigest(installId)]: { os: 'darwin', firstSeenAt: '2026-10-01T00:00:00.000Z' } } });
  const { svc, at } = service({ store: createMemoryStore(legacy), uniqueInstallsStore: installs, grandfatherCutoff: Date.parse('2026-10-10T00:00:00Z') });
  at(Date.parse('2040-01-01T00:00:00Z'));
  for (const key of Object.keys(legacy.keyIndex)) {
    const lease = await svc.activate({ key, deviceId: 'mac-legacy-01' });
    assert.equal(lease.licenseExpiresAt, null, `${key} is lifetime`);
    assert.equal(lease.autoRenew, null);
    const { payload } = verifyLease(lease.lease, KEYS, { now: Date.parse('2040-01-01T00:00:00Z') });
    assert.equal('licenseExpiresAt' in payload, false, 'lifetime leases keep the old payload');
    assert.equal((await licenseOf(svc, key)).plan, 'lifetime');
  }
  const free = await svc.grandfather({ installId });
  assert.equal((await svc.activate({ key: free.key, deviceId: 'mac-legacy-02' })).licenseExpiresAt, null);
  const beta = await svc.admin.issueBeta(ADMIN, { name: '테스터' });
  assert.equal(beta.license.plan, 'lifetime');
  const oneTime = await svc.handleGrobleEvent({ id: 'e1', type: 'payment.completed', occurredAt: PAID_AT, data: { object: { ...base({ merchantUid: 'm_new', ref: 'r-new' }), content: { id: 'uRshdR', paymentType: 'ONE_TIME' } } } }, { idempotencyKey: 'n1' });
  assert.equal(oneTime.action, 'issued');
  assert.equal((await svc.statusByRef('r-new')).licenseExpiresAt, null);
});

test('admin extend: --years from expiry or now, --until a KST date, lifetime keys refused, every extension kept', async () => {
  const { svc, at } = service();
  await svc.handleGrobleEvent(paid(), { idempotencyKey: 'i1' });
  const key = await keyFor(svc);
  const one = await svc.admin.extend(ADMIN, { key, years: '1', note: 'support' });
  assert.equal(one.previousExpiresAt, new Date(FIRST_END).toISOString());
  assert.equal(one.license.expiresAt, new Date(Date.parse('2028-10-20T23:59:59.999+09:00')).toISOString());
  const byRef = await svc.admin.extend(ADMIN, { ref: 'hama-sub-1', until: '2030-01-31' });
  assert.equal(byRef.license.expiresAt, new Date(Date.parse('2030-01-31T23:59:59.999+09:00')).toISOString());
  assert.equal(byRef.license.extensions.length, 2);
  at(Date.parse('2031-05-05T12:00:00+09:00'));
  const lapsed = await svc.admin.extend(ADMIN, { key, years: 1 });
  assert.equal(lapsed.license.expiresAt, new Date(Date.parse('2032-05-05T23:59:59.999+09:00')).toISOString());

  for (const bad of [{ years: 0 }, { years: 11 }, { years: 'x' }, { until: '2030-02-30' }, { until: 'soon' }, { years: 1, until: '2030-01-01' }]) {
    await assert.rejects(svc.admin.extend(ADMIN, { key, ...bad }), { status: 400 }, JSON.stringify(bad));
  }
  const lifetime = await svc.admin.issue(ADMIN, { note: 'lifetime' });
  await assert.rejects(svc.admin.extend(ADMIN, { key: lifetime.license.key, years: 1 }), { code: 'lifetime_key' });
  await assert.rejects(svc.admin.extend('nope', { key, years: 1 }), { code: 'forbidden' });
  const backfill = await svc.admin.issue(ADMIN, { merchantUid: 'sub_missed', email: 'late@example.com', years: '1' });
  assert.equal(backfill.license.plan, 'annual');
});

async function listen(t, env, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-sub-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const server = createSiteServer(
    { RAU_SITE_DATA: directory, GROBLE_WEBHOOK_SECRET: SECRET, ADMIN_TOKEN: ADMIN, LICENSE_SIGNING_PRIVATE_KEY: PAIR.privateKeyDerBase64, ...env },
    { log: () => {}, emailProvider: { name: 'test', async send() { return { status: 'sent' }; } }, alertProvider: null, ...options },
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function signedPost(origin, body, idem = `idem-${Math.random()}`) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return fetch(`${origin}/v1/groble/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Groble-Signature': grobleSignature(SECRET, ts, raw), 'X-Groble-Timestamp': ts, 'X-Groble-Idempotency-Key': idem },
    body: raw,
  });
}

test('HTTP: subscription webhooks, expired validate, unknown events held in the webhook log, CLI extend', async (t) => {
  let clock = T0;
  const origin = await listen(t, {}, { now: () => clock });
  assert.equal((await (await signedPost(origin, paid())).json()).action, 'issued');
  const { key, licenseExpiresAt } = await (await fetch(`${origin}/v1/license/by-ref?ref=hama-sub-1`)).json();
  assert.equal(licenseExpiresAt, FIRST_END);
  const post = (route, body) => fetch(`${origin}${route}`, { method: 'POST', body: JSON.stringify(body) });
  const act = await (await post('/v1/license/activate', { key, deviceId: 'mac-http-01' })).json();
  assert.deepEqual([act.ok, act.licenseExpiresAt, act.autoRenew], [true, FIRST_END, true]);

  clock = FIRST_END + DAY;
  const expired = await post('/v1/license/validate', { key, deviceId: 'mac-http-01' });
  assert.equal(expired.status, 403);
  assert.deepEqual(await expired.json(), { ok: false, error: 'expired', tier: 'paid', licenseExpiresAt: FIRST_END });

  // Groble's planned 해지 철회 event (or any new type) answers 200 so it is not retried, and lands in `webhooks --held`.
  const unknown = await signedPost(origin, { id: 'evt_new', type: 'subscription.cancel_withdrawn', occurredAt: PAID_AT, data: { object: { merchantUid: 'sub_m1', sellerReference: 'hama-sub-1' } } }, 'idem-unknown');
  assert.equal(unknown.status, 200);
  assert.equal((await unknown.json()).action, 'ignored_event_type');
  const run = (...args) => promisify(execFile)(process.execPath, [CLI, ...args], { env: { ...process.env, SITE_API_BASE: origin, ADMIN_TOKEN: ADMIN } });
  let held;
  for (let i = 0; i < 50 && !held?.count; i += 1) {
    held = JSON.parse((await run('webhooks', '--held')).stdout.slice(4));
    if (!held.count) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(held.entries.map((e) => [e.reason, e.eventType]), [['unknown_event_type:subscription.cancel_withdrawn', 'subscription.cancel_withdrawn']]);

  const extended = await run('extend', key, '--years', '1');
  assert.match(extended.stdout, /^200 \{/);
  assert.match(extended.stdout, /annual · active · 2028-10-21까지/);
  const shown = await run('lookup', '--key', key);
  assert.match(shown.stdout, new RegExp(`${key} annual · active · 2028-10-21까지 · 자동 갱신`));
  assert.equal((await post('/v1/license/validate', { key, deviceId: 'mac-http-01' })).status, 200, 'extension restores access on the next check');
  await assert.rejects(run('extend'), (error) => error.code === 2 && /extend <key\|ref>/.test(error.stderr));
});
