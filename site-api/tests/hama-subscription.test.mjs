import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveLicenseConfig } from '../config.mjs';
import { generateLeaseKeyPair } from '../license-lease.mjs';
import { licenseEmail } from '../license-email.mjs';
import { createSiteServer } from '../server.mjs';
import { basicPaid, signedGroblePost } from './fixtures/groble-basic.mjs';

const ADMIN = 'admin-token-for-hama-subscription-tests';
const SECRET = 'whsec_test_hama_subscription';
const PAIR = generateLeaseKeyPair();
const DAY = 24 * 60 * 60 * 1000;
const PAID_AT = '2026-10-20T14:22:11+09:00';
const T0 = Date.parse(PAID_AT);
const MONTH_END = Date.parse('2026-11-20T23:59:59.999+09:00');
const YEAR_END = Date.parse('2027-10-20T23:59:59.999+09:00');
const MONTHLY = 'R3n8zG';
const YEARLY = 'atqjpJ';
const ON = { HAMA_ENABLED: 'true' };

const hamaPaid = (overrides = {}) => basicPaid({
  merchantUid: 'hama_m1',
  ref: 'hama-sub-1',
  email: 'hama@example.com',
  contentId: MONTHLY,
  price: overrides.contentId === YEARLY ? 139000 : 12900,
  cycle: overrides.contentId === YEARLY ? 12 : 1,
  ...overrides,
});

function subscriptionEvent(type, object, occurredAt) {
  return {
    id: `evt_${type}_${occurredAt}`,
    type,
    occurredAt,
    data: { object: {
      merchantUid: `${type}_${occurredAt}`,
      sellerReference: 'hama-sub-1',
      buyer: { email: 'hama@example.com' },
      content: { id: MONTHLY, paymentType: 'SUBSCRIPTION' },
      ...object,
    } },
  };
}

async function setup(t, env = ON, { dir, clock = { now: T0 } } = {}) {
  const directory = dir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-hama-sub-'));
  if (!dir) t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const sent = [];
  const server = createSiteServer({
    RAU_SITE_DATA: directory,
    GROBLE_WEBHOOK_SECRET: SECRET,
    ADMIN_TOKEN: ADMIN,
    LICENSE_SIGNING_PRIVATE_KEY: PAIR.privateKeyDerBase64,
    OPENROUTER_PROVISIONING_KEY: 'test-provisioning-key',
    ...env,
  }, {
    log: () => {},
    emailProvider: { name: 'test', async send(m) { sent.push(m); return { status: 'sent' }; } },
    alertProvider: null,
    now: () => clock.now,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); return new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, headers = {}) => fetch(`${origin}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const adminHeaders = { Authorization: `Bearer ${ADMIN}` };
  const admin = (route, body) => post(route, body, adminHeaders).then((r) => r.json());
  const adminGet = (route) => fetch(`${origin}${route}`, { headers: adminHeaders }).then((r) => r.json());
  const webhook = async (event) => (await signedGroblePost(origin, SECRET, event)).json();
  const auth = (lease) => ({ headers: { Authorization: `Bearer ${lease}` } });
  return {
    clock,
    sent,
    directory,
    origin,
    admin,
    adminGet,
    webhook,
    byRef: (ref = 'hama-sub-1') => fetch(`${origin}/v1/license/by-ref?ref=${ref}`).then((r) => r.json()),
    activate: (key, deviceId = 'mac-hama-0001') => post('/v1/license/activate', { key, deviceId, platform: 'darwin' }).then((r) => r.json()),
    validate: (key, deviceId = 'mac-hama-0001') => post('/v1/license/validate', { key, deviceId }).then((r) => r.json()),
    hamaStatus: (lease) => fetch(`${origin}/v1/hama/status`, auth(lease)),
    rauStatus: (lease) => fetch(`${origin}/v1/rau/status`, auth(lease)).then((r) => r.json()),
    planInFile: async (keyId) => JSON.parse(await fs.readFile(path.join(directory, 'hama.json'), 'utf8').catch(() => '{}')).plans?.[keyId],
    plans: async () => (await adminGet('/v1/admin/hama')).plans,
  };
}

/** A paid monthly Hama key, activated on one device. */
async function bought(s, event = hamaPaid()) {
  assert.equal((await s.webhook(event)).action, 'issued');
  const { key } = await s.byRef();
  const active = await s.activate(key);
  assert.equal(active.ok, true, JSON.stringify(active));
  return { key, keyId: active.keyId, lease: active.lease, active };
}

test('config: the real product ids and prices are the defaults, env overrides them, and a product on two lists fails startup', () => {
  const config = resolveLicenseConfig({});
  assert.deepEqual(config.basicProducts, [{ id: 'SfYBy5', months: 1 }, { id: 'vdw3HN', months: 12 }]);
  assert.deepEqual(config.hamaProducts, [{ id: MONTHLY, months: 1 }, { id: YEARLY, months: 12 }]);
  const row = (c, id) => {
    const p = c.products.find((x) => x.id === id);
    return [p.kind, p.edition, p.cycleMonths, p.expectedPrice, p.minAmount];
  };
  assert.deepEqual(row(config, 'SfYBy5'), ['subscription', 'basic', 1, 3900, 3900]);
  assert.deepEqual(row(config, 'vdw3HN'), ['subscription', 'basic', 12, 39000, 39000]);
  assert.deepEqual(row(config, MONTHLY), ['subscription', 'hama', 1, 12900, 12900]);
  assert.deepEqual(row(config, YEARLY), ['subscription', 'hama', 12, 139000, 139000]);

  const custom = resolveLicenseConfig({ GROBLE_HAMA_PRODUCT_IDS: 'abc:1,def:12', GROBLE_HAMA_MONTHLY_PRICE: '14900', GROBLE_HAMA_MONTHLY_MIN_AMOUNT: '10000', GROBLE_HAMA_YEARLY_PRICE: '149000' });
  assert.deepEqual(custom.hamaProducts.map((p) => p.id), ['abc', 'def']);
  assert.equal(custom.products.some((p) => p.id === MONTHLY), false);
  assert.deepEqual(row(custom, 'abc').slice(3), [14900, 10000]);
  assert.deepEqual(row(custom, 'def').slice(3), [149000, 149000]);

  assert.throws(() => resolveLicenseConfig({ GROBLE_HAMA_PRODUCT_IDS: 'SfYBy5:1' }), /both basic and hama/);
  assert.throws(() => resolveLicenseConfig({ GROBLE_HAMA_PRODUCT_IDS: 'abc:6' }), /GROBLE_HAMA_PRODUCT_IDS entry is not id:1 or id:12/);
});

test('a monthly payment issues a Hama key, enrolls it at once, and the key gets the hosted plan and Rau at the Hama cap', async (t) => {
  const s = await setup(t);
  const { key, keyId, lease, active } = await bought(s);

  const plan = await s.planInFile(keyId);
  assert.deepEqual([plan.status, plan.allowanceUsd, plan.periodAnchor], ['active', null, new Date(T0).toISOString()]);
  assert.deepEqual(await s.byRef(), { status: 'issued', key, licenseExpiresAt: MONTH_END, edition: 'hama', plan: 'monthly' });
  assert.deepEqual([active.edition, active.plan, active.rau, active.licenseExpiresAt], ['hama', 'monthly', { eligible: true }, MONTH_END]);

  const hama = await s.hamaStatus(lease);
  assert.equal(hama.status, 200);
  const body = await hama.json();
  assert.deepEqual([body.plan.status, body.plan.allowanceUsd, body.plan.periodStart], ['active', 15, new Date(T0).toISOString()]);
  const rau = await s.rauStatus(lease);
  assert.deepEqual([rau.eligible, rau.capUsd], [true, 5]);

  const customers = await s.adminGet('/v1/admin/licenses/customers');
  assert.deepEqual([customers.customers[0].edition, customers.customers[0].productId, customers.customers[0].plan], ['hama', MONTHLY, 'monthly']);
});

test('a yearly payment runs 12 months and keeps monthly billing periods from the first payment', async (t) => {
  const s = await setup(t);
  const { key, keyId, active } = await bought(s, hamaPaid({ contentId: YEARLY }));
  assert.deepEqual([active.edition, active.plan, active.licenseExpiresAt], ['hama', 'annual', YEAR_END]);
  assert.equal((await s.planInFile(keyId)).status, 'active');
  s.clock.now = T0 + 45 * DAY;
  const { plan } = await (await s.hamaStatus((await s.validate(key)).lease)).json();
  assert.equal(plan.periodStart, new Date(Date.parse('2026-11-20T05:22:11.000Z')).toISOString());
});

test('a renewal extends the same key by its own cycle and leaves the plan and its ledger alone', async (t) => {
  const s = await setup(t);
  const { key, keyId } = await bought(s);
  const before = await s.planInFile(keyId);
  s.clock.now = Date.parse('2026-11-20T09:00:00+09:00');
  const renewed = await s.webhook(hamaPaid({ merchantUid: 'hama_m2', round: 2, paidAt: '2026-11-20T09:00:00+09:00' }));
  assert.equal(renewed.action, 'renewed');
  const lease = await s.validate(key);
  assert.equal(lease.licenseExpiresAt, Date.parse('2026-12-20T23:59:59.999+09:00'));
  assert.deepEqual(await s.planInFile(keyId), before);
  assert.equal(s.sent.length, 1, 'a monthly renewal sends no second key email');
});

test('a cancel keeps the plan until the paid month ends, then enrollment ends and a late renewal brings it back', async (t) => {
  const s = await setup(t);
  const { key, keyId } = await bought(s);

  await s.webhook(subscriptionEvent('subscription.cancel_requested', { cancelRequest: { requestedAt: '2026-10-25T10:00:00+09:00', requestedBy: 'BUYER' } }, '2026-10-25T10:00:00+09:00'));
  assert.equal((await s.planInFile(keyId)).status, 'active');
  s.clock.now = MONTH_END - DAY;
  // Leases last 7 days, so this one outlives the key: the refusals below come from the key's end.
  const { lease } = await s.validate(key);
  assert.equal((await s.hamaStatus(lease)).status, 200);
  assert.equal((await s.rauStatus(lease)).capUsd, 5);

  s.clock.now = MONTH_END + 1;
  assert.equal((await s.hamaStatus(lease)).status, 401);
  const rau = await s.rauStatus(lease);
  assert.deepEqual([rau.eligible, rau.reason], [false, 'rau_requires_pro']);
  const ended = (await s.plans()).find((p) => p.keyId === keyId);
  assert.deepEqual([ended.status, ended.disabledReason], ['disabled', 'subscription_ended']);

  // A re-payment after the lapse: the key is live again and so is its plan, before anyone asks.
  const paidAt = new Date(MONTH_END + 2 * DAY).toISOString();
  s.clock.now = MONTH_END + 2 * DAY;
  assert.equal((await s.webhook(hamaPaid({ merchantUid: 'hama_m2', round: 2, paidAt }))).action, 'renewed');
  const back = await s.planInFile(keyId);
  assert.deepEqual([back.status, back.disabledReason, back.disabledAt], ['active', undefined, undefined]);
  assert.equal(back.periodAnchor, new Date(T0).toISOString(), 'billing months keep their first anchor');
  const fresh = await s.validate(key);
  assert.equal((await s.hamaStatus(fresh.lease)).status, 200);
});

test('a failed renewal keeps the plan through the payment grace like Pro, and a termination ends it at the paid end', async (t) => {
  const s = await setup(t);
  const { key, keyId } = await bought(s);
  s.clock.now = MONTH_END - DAY;
  const failedAt = '2026-11-20T10:00:00+09:00';
  const failure = { attemptNumber: 3, isFinal: true, failedAt, gracePeriodEndsAt: '2026-12-20T10:00:00+09:00' };
  await s.webhook(subscriptionEvent('subscription_payment.failed', { failure }, failedAt));
  // Groble names a grace end 30 days out; the key stops 14 days after its expiry.
  s.clock.now = MONTH_END + 13 * DAY;
  const renewedLease = await s.validate(key);
  assert.deepEqual([renewedLease.licenseState, renewedLease.rau.eligible], ['payment_failed', true]);
  assert.equal((await s.hamaStatus(renewedLease.lease)).status, 200);
  assert.equal((await s.plans()).find((p) => p.keyId === keyId).status, 'active');

  s.clock.now = MONTH_END + 14 * DAY;
  assert.equal((await s.hamaStatus(renewedLease.lease)).status, 401);
  assert.equal((await s.plans()).find((p) => p.keyId === keyId).status, 'disabled');

  // Termination takes the grace away: the plan ends with the paid month.
  const other = await setup(t);
  const second = await bought(other);
  other.clock.now = MONTH_END - DAY;
  const { lease } = await other.validate(second.key);
  await other.webhook(subscriptionEvent('subscription_payment.failed', { failure }, failedAt));
  await other.webhook(subscriptionEvent('subscription.terminated', { termination: { terminatedAt: failedAt, reason: 'PAYMENT_FAILED' } }, failedAt));
  other.clock.now = MONTH_END + 1;
  assert.equal((await other.hamaStatus(lease)).status, 401);
  assert.equal((await other.plans()).find((p) => p.keyId === second.keyId).status, 'disabled');
});

test('a full refund revokes the key and ends the plan at once', async (t) => {
  const s = await setup(t);
  const { keyId, lease } = await bought(s);
  const at = '2026-10-21T10:00:00+09:00';
  const refunded = await s.webhook(subscriptionEvent('subscription_payment.refunded', {
    merchantUid: 'hama_m1',
    pricing: { currency: 'KRW', finalAmount: 12900 },
    refund: { refundedAt: at, amount: 12900, partialRefund: false },
  }, at));
  assert.equal(refunded.action, 'revoked');
  const plan = await s.planInFile(keyId);
  assert.deepEqual([plan.status, plan.disabledReason], ['disabled', 'subscription_ended']);
  assert.equal((await s.hamaStatus(lease)).status, 401);
});

test('an admin revoke ends the plan, and a restore brings it back on the next call', async (t) => {
  const s = await setup(t);
  const { keyId, lease } = await bought(s);
  await s.admin('/v1/admin/licenses/revoke', { keyId, reason: 'test' });
  assert.equal((await s.hamaStatus(lease)).status, 401);
  assert.deepEqual((await s.plans()).map((p) => p.disabledReason), ['subscription_ended']);

  assert.equal((await s.admin('/v1/admin/licenses/restore', { keyId })).ok, true);
  assert.equal((await s.hamaStatus(lease)).status, 200);
  assert.equal((await s.planInFile(keyId)).status, 'active');
});

test('wrong price, cycle or event type is held with no key and no plan; release issues the Hama key and enrolls it', async (t) => {
  const s = await setup(t);
  assert.equal((await s.webhook(hamaPaid({ price: 3900 }))).action, 'held');
  assert.deepEqual(await s.byRef(), { status: 'pending' });
  assert.deepEqual(await s.plans(), []);
  const held = await s.adminGet('/v1/admin/orders?status=held');
  assert.equal(held.orders[0].holdReason, 'wrong_price:3900');

  const released = await s.admin('/v1/admin/orders/release', { merchantUid: 'hama_m1' });
  assert.deepEqual([released.license.edition, released.license.plan, released.license.expiresAt], ['hama', 'monthly', new Date(MONTH_END).toISOString()]);
  const active = await s.activate(released.license.key);
  assert.equal((await s.hamaStatus(active.lease)).status, 200, 'a released key enrolls itself on its first call');

  const other = await setup(t);
  await other.webhook(hamaPaid({ contentId: YEARLY, price: 12900 }));
  await other.webhook(hamaPaid({ merchantUid: 'hama_c', ref: 'hama-sub-c', cycle: 12 }));
  const reasons = (await other.adminGet('/v1/admin/orders?status=held')).orders.map((o) => o.holdReason).sort();
  assert.deepEqual(reasons, ['cycle_mismatch:12', 'wrong_price:12900']);
  assert.deepEqual(await other.plans(), []);

  // Groble documents payment.completed for one-time products only, so one on a subscription product is held.
  const third = await setup(t);
  const oneTime = await third.webhook({ ...hamaPaid(), type: 'payment.completed' });
  assert.deepEqual([oneTime.action, (await third.byRef()).status], ['held', 'pending']);
  assert.deepEqual(await third.plans(), []);
});

test('an admin disable holds against later syncs and renewals until the admin enrolls the key again', async (t) => {
  const s = await setup(t);
  const { key, keyId } = await bought(s);
  const disabled = await s.admin('/v1/admin/hama/disable', { keyId });
  assert.deepEqual([disabled.plan.status, disabled.plan.disabledReason], ['disabled', 'admin']);

  s.clock.now = Date.parse('2026-11-20T09:00:00+09:00');
  await s.webhook(hamaPaid({ merchantUid: 'hama_m2', round: 2, paidAt: '2026-11-20T09:00:00+09:00' }));
  assert.equal((await s.plans()).find((p) => p.keyId === keyId).status, 'disabled');
  const { lease } = await s.validate(key);
  const refused = await s.hamaStatus(lease);
  assert.deepEqual([refused.status, (await refused.json()).error], [403, 'hama_not_enrolled']);

  assert.equal((await s.admin('/v1/admin/hama/enroll', { keyId })).plan.status, 'active');
  assert.equal((await s.hamaStatus(lease)).status, 200);
});

test('a key bought while HAMA_ENABLED is off still has Rau at the Hama cap, and enrolls itself once Hama is on', async (t) => {
  const off = await setup(t, {});
  const { keyId, lease, active } = await bought(off);
  assert.equal(active.rau.eligible, true);
  assert.deepEqual([(await off.rauStatus(lease)).capUsd, (await off.hamaStatus(lease)).status], [5, 404]);
  assert.equal(await off.planInFile(keyId), undefined);

  const on = await setup(t, ON, { dir: off.directory });
  assert.equal((await on.hamaStatus(lease)).status, 200);
  assert.equal((await on.planInFile(keyId)).periodAnchor, new Date(T0).toISOString());
});

test('a Pro key never enters the Hama plan, and an admin-enrolled manual key is left to the admin', async (t) => {
  const s = await setup(t);
  await s.webhook(basicPaid({ contentId: 'SfYBy5', price: 3900, cycle: 1, ref: 'hama-sub-pro' }));
  const pro = await s.activate((await s.byRef('hama-sub-pro')).key, 'mac-pro-00001');
  const refused = await s.hamaStatus(pro.lease);
  assert.deepEqual([refused.status, (await refused.json()).error], [403, 'hama_not_enrolled']);
  assert.equal((await s.rauStatus(pro.lease)).capUsd, 2);

  const manual = await s.admin('/v1/admin/licenses/issue', {});
  assert.equal((await s.admin('/v1/admin/hama/enroll', { keyId: manual.license.keyId })).plan.status, 'active');
  await bought(s);
  const plans = await s.plans();
  assert.deepEqual(plans.map((p) => p.status), ['active', 'active']);
  assert.equal(plans.some((p) => p.keyId === pro.keyId), false);
});

test('Hama key email names the plan, and a Groble purchase sends it', async (t) => {
  const mail = licenseEmail({ key: 'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', kind: 'hama', expiresAt: YEAR_END, cycleMonths: 12 });
  assert.equal(mail.subject, '[HamaEditor] Hama 라이선스 키를 보내드려요');
  assert.ok(mail.html.includes('Hama를 구독해 주셔서 고마워요.'));
  assert.ok(mail.html.includes('매년 자동으로 갱신돼요. 다음 갱신일은 2027년 10월 20일이에요.'));

  const s = await setup(t);
  await bought(s);
  for (let i = 0; i < 200 && s.sent.length === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.sent[0]?.subject, '[HamaEditor] Hama 라이선스 키를 보내드려요');
});
