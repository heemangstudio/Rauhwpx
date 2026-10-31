import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { resolveLicenseConfig, resolveRauConfig } from '../config.mjs';
import { generateLeaseKeyPair, parseSigningPrivateKey, verifyLease } from '../license-lease.mjs';
import { licenseEmail } from '../license-email.mjs';
import { createLicensesService, emptyLicensesState } from '../licenses.mjs';
import { createSiteServer } from '../server.mjs';
import { createMemoryStore } from '../store.mjs';
import { BASIC_ENV, BASIC_MONTHLY_ID, BASIC_PRODUCTS, BASIC_YEARLY_ID, basicPaid, signedGroblePost } from './fixtures/groble-basic.mjs';

const ADMIN = 'admin-token-for-pro-tests';
const SECRET = 'whsec_test_pro';
const PAIR = generateLeaseKeyPair();
const KEYS = { 'hama-prod-1': PAIR.publicKeyRawBase64 };
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-20T14:22:11+09:00');
const MONTH_END = Date.parse('2026-11-20T23:59:59.999+09:00');
const YEAR_END = Date.parse('2027-10-20T23:59:59.999+09:00');
const CLI = fileURLToPath(new URL('../scripts/license-admin.mjs', import.meta.url));

function service(overrides = {}) {
  let clock = overrides.start ?? T0;
  const sent = [];
  const svc = createLicensesService({
    store: createMemoryStore(emptyLicensesState()),
    signingKey: parseSigningPrivateKey(PAIR.privateKeyPem),
    adminToken: ADMIN,
    basicProducts: BASIC_PRODUCTS,
    now: () => clock,
    emailProvider: { name: 'test', async send(m) { sent.push(m); return { status: 'sent' }; } },
    log: () => {},
    ...overrides,
  });
  return { svc, sent, at: (ms) => { clock = ms; } };
}

async function issued(svc, event, ref = 'hama-pro-1') {
  const result = await svc.handleGrobleEvent(event, { idempotencyKey: `i-${event.id}` });
  return { result, key: (await svc.statusByRef(ref)).key };
}

const viewOf = async (svc, key) => (await svc.admin.lookup(ADMIN, { key })).licenses[0];

function failed({ gracePeriodEndsAt, failedAt = '2026-11-20T14:22:11+09:00', contentId = BASIC_MONTHLY_ID, ref = 'hama-pro-1' } = {}) {
  return {
    id: `evt_fail_${failedAt}`,
    type: 'subscription_payment.failed',
    occurredAt: failedAt,
    data: { object: {
      merchantUid: `fail_${failedAt}`,
      sellerReference: ref,
      buyer: { email: 'pro@example.com' },
      content: { id: contentId, paymentType: 'SUBSCRIPTION' },
      pricing: { currency: 'KRW', finalAmount: 3900 },
      subscription: { billingReason: 'RENEWAL', currentRound: 2, status: 'PAST_DUE' },
      failure: { attemptNumber: 3, isFinal: true, reason: 'CARD_EXPIRED', failedAt, ...(gracePeriodEndsAt ? { gracePeriodEndsAt } : {}) },
    } },
  };
}

test('config: GROBLE_BASIC_PRODUCT_IDS id:months with Basic prices, overrides, and products in two lists fail startup', () => {
  assert.deepEqual(resolveLicenseConfig({}).basicProducts, [{ id: 'SfYBy5', months: 1 }, { id: 'vdw3HN', months: 12 }]);
  const config = resolveLicenseConfig(BASIC_ENV);
  const monthly = config.products.find((p) => p.id === BASIC_MONTHLY_ID);
  const yearly = config.products.find((p) => p.id === BASIC_YEARLY_ID);
  assert.deepEqual([monthly.kind, monthly.edition, monthly.cycleMonths, monthly.expectedPrice, monthly.minAmount], ['subscription', 'basic', 1, 3900, 3900]);
  assert.deepEqual([yearly.cycleMonths, yearly.expectedPrice, yearly.minAmount], [12, 39000, 39000]);
  const priced = resolveLicenseConfig({ ...BASIC_ENV, GROBLE_BASIC_MONTHLY_PRICE: '4900', GROBLE_BASIC_YEARLY_MIN_AMOUNT: '30000', GROBLE_PRODUCT_PRICES: `${BASIC_MONTHLY_ID}:5900:5000` });
  assert.deepEqual([priced.products.find((p) => p.id === BASIC_MONTHLY_ID).expectedPrice, priced.products.find((p) => p.id === BASIC_MONTHLY_ID).minAmount], [5900, 5000]);
  assert.equal(priced.products.find((p) => p.id === BASIC_YEARLY_ID).minAmount, 30000);
  assert.throws(() => resolveLicenseConfig({ GROBLE_BASIC_PRODUCT_IDS: 'GLJFC9:12' }), /both subscription and basic/);
  assert.throws(() => resolveLicenseConfig({ GROBLE_BASIC_PRODUCT_IDS: 'abc' }), /id:1 or id:12/);
  assert.throws(() => resolveLicenseConfig({ GROBLE_BASIC_PRODUCT_IDS: 'abc:6' }), /id:1 or id:12/);
  assert.equal(resolveLicenseConfig({}).basicUpgradeUrl, 'https://heemangstudios.com/pricing.html#basic');
  assert.throws(() => resolveLicenseConfig({ PRO_UPGRADE_URL: 'http://x.example' }), /PRO_UPGRADE_URL must be an https/);
  assert.throws(() => resolveLicenseConfig({ BASIC_UPGRADE_URL: 'http://x.example' }), /BASIC_UPGRADE_URL must be an https/);
  assert.equal(resolveLicenseConfig({}).paymentGraceMaxMs, 14 * DAY);
  assert.throws(() => resolveLicenseConfig({ GROBLE_PAYMENT_GRACE_MAX_DAYS: '30' }), /under a month/);
});

test('a monthly Basic key runs one month, carries edition, product and cycle, and the app sees plan and Rau eligibility', async () => {
  const { svc, sent } = service();
  const { result, key } = await issued(svc, basicPaid());
  assert.deepEqual([result.action, result.expiresAt], ['issued', new Date(MONTH_END).toISOString()]);
  const view = await viewOf(svc, key);
  assert.deepEqual([view.edition, view.productId, view.billingCycleMonths, view.plan], ['basic', BASIC_MONTHLY_ID, 1, 'monthly']);

  const lease = await svc.activate({ key, deviceId: 'mac-pro-0001', platform: 'darwin' });
  assert.deepEqual([lease.edition, lease.plan, lease.rau, lease.licenseExpiresAt], ['basic', 'monthly', { eligible: true }, MONTH_END]);
  const checked = verifyLease(lease.lease, KEYS, { deviceId: 'mac-pro-0001', key, now: T0 });
  assert.equal(checked.ok, true);
  assert.deepEqual(Object.keys(checked.payload).sort(), ['deviceId', 'expiresAt', 'issuedAt', 'keyHash', 'keyId', 'kid', 'licenseExpiresAt', 'v'], 'the signed lease format is unchanged');
  assert.deepEqual(await svc.statusByRef('hama-pro-1'), { status: 'issued', key, licenseExpiresAt: MONTH_END, edition: 'basic', plan: 'monthly' });

  await svc.deliverPendingEmails();
  assert.equal(sent[0].subject, '[HamaEditor] Basic 라이선스 키를 보내드려요');
  assert.ok(sent[0].html.includes('매달 자동으로 갱신돼요. 다음 갱신일은 2026년 11월 20일이에요.'));
});

test('a Basic event without a readable billingCycleMonths uses the product cycle, never 12 months', async () => {
  for (const cycle of [null, 0, 13, '1']) {
    const { svc } = service();
    const { result } = await issued(svc, basicPaid({ cycle }));
    assert.equal(result.expiresAt, new Date(MONTH_END).toISOString(), `cycle ${cycle}`);
  }
});

test('a Basic event whose billingCycleMonths disagrees with the product is held as cycle_mismatch; release uses the product cycle', async () => {
  const { svc } = service();
  const held = await svc.handleGrobleEvent(basicPaid({ cycle: 12 }), { idempotencyKey: 'm1' });
  assert.deepEqual([held.action, held.reason], ['held', 'cycle_mismatch:12']);
  assert.equal((await svc.statusByRef('hama-pro-1')).status, 'pending');
  const attention = await svc.admin.attention(ADMIN);
  assert.equal(attention.items[0].reasonText, '결제 주기(12개월)가 상품의 주기와 맞지 않아요.');

  const released = await svc.admin.release(ADMIN, { merchantUid: 'pro_m1' });
  assert.deepEqual([released.license.edition, released.license.plan, released.license.expiresAt], ['basic', 'monthly', new Date(MONTH_END).toISOString()]);

  // A yearly product named monthly by the event is held the same way.
  const other = service();
  assert.equal((await other.svc.handleGrobleEvent(basicPaid({ contentId: BASIC_YEARLY_ID, cycle: 1 }), { idempotencyKey: 'm2' })).reason, 'cycle_mismatch:1');
});

test('a monthly renewal extends the same key by one month, held when its cycle disagrees, with no monthly key email', async () => {
  const { svc, sent, at } = service();
  const { key } = await issued(svc, basicPaid());
  await svc.deliverPendingEmails();
  at(Date.parse('2026-11-20T09:00:00+09:00'));
  const mismatch = await svc.handleGrobleEvent(basicPaid({ merchantUid: 'pro_m2', round: 2, cycle: 12, paidAt: '2026-11-20T09:00:00+09:00' }), { idempotencyKey: 'r0' });
  assert.equal(mismatch.reason, 'cycle_mismatch:12');
  const renewed = await svc.handleGrobleEvent(basicPaid({ merchantUid: 'pro_m3', round: 2, cycle: null, paidAt: '2026-11-20T09:00:00+09:00' }), { idempotencyKey: 'r1' });
  assert.deepEqual([renewed.action, renewed.expiresAt], ['renewed', new Date(Date.parse('2026-12-20T23:59:59.999+09:00')).toISOString()]);
  assert.equal((await viewOf(svc, key)).plan, 'monthly');
  await svc.deliverPendingEmails();
  assert.equal(sent.length, 1, 'only the first key email');
});

test('a yearly Basic key runs 12 months and is labeled annual', async () => {
  const { svc } = service();
  const { result, key } = await issued(svc, basicPaid({ contentId: BASIC_YEARLY_ID }));
  assert.equal(result.expiresAt, new Date(YEAR_END).toISOString());
  const view = await viewOf(svc, key);
  assert.deepEqual([view.edition, view.plan, view.billingCycleMonths], ['basic', 'annual', 12]);
  const lease = await svc.activate({ key, deviceId: 'mac-pro-0002' });
  assert.deepEqual([lease.plan, lease.rau.eligible], ['annual', true]);
});

test('GLJFC9 is unchanged: no edition, 12-month fallback without the field, annual plan and no Rau', async () => {
  const { svc } = service();
  const event = basicPaid({ contentId: 'GLJFC9', price: 9900, cycle: null, ref: 'hama-sub-1' });
  const { result, key } = await issued(svc, event, 'hama-sub-1');
  assert.equal(result.expiresAt, new Date(YEAR_END).toISOString());
  const view = await viewOf(svc, key);
  assert.deepEqual([view.edition, view.plan], [undefined, 'annual']);
  const lease = await svc.activate({ key, deviceId: 'mac-sub-0001' });
  assert.deepEqual([lease.edition, lease.plan, lease.rau], [undefined, 'annual', { eligible: false }]);
  const lifetime = await svc.admin.issue(ADMIN, { email: 'old@example.com' });
  assert.equal(lifetime.license.plan, 'lifetime');
  const lifetimeLease = await svc.activate({ key: lifetime.license.key, deviceId: 'mac-old-0001' });
  assert.deepEqual([lifetimeLease.plan, lifetimeLease.rau], ['lifetime', { eligible: false }]);
});

test('payment grace is clamped to GROBLE_PAYMENT_GRACE_MAX_DAYS past the expiry, from the event and from the fallback', async () => {
  const { svc, at } = service();
  const { key } = await issued(svc, basicPaid());
  await svc.activate({ key, deviceId: 'mac-pro-0001' });
  at(MONTH_END - DAY);
  // Groble names a grace end 30 days out; the key stops 14 days after its expiry.
  const recorded = await svc.handleGrobleEvent(failed({ gracePeriodEndsAt: '2026-12-20T14:22:11+09:00' }), { idempotencyKey: 'f1' });
  assert.equal(recorded.paymentGraceEndsAt, new Date(MONTH_END + 14 * DAY).toISOString());
  at(MONTH_END + 13 * DAY);
  const lease = await svc.validate({ key, deviceId: 'mac-pro-0001' });
  assert.deepEqual([lease.licenseState, lease.paymentGraceEndsAt, lease.rau.eligible], ['payment_failed', MONTH_END + 14 * DAY, true]);
  at(MONTH_END + 14 * DAY);
  await assert.rejects(svc.validate({ key, deviceId: 'mac-pro-0001' }), { code: 'expired' });

  // A GLJFC9 key with a 20-day fallback grace and a 7-day cap stops after 7.
  const other = service({ paymentGraceMs: 20 * DAY, paymentGraceMaxMs: 7 * DAY });
  const { key: annualKey } = await issued(other.svc, basicPaid({ contentId: 'GLJFC9', price: 9900, cycle: 12, ref: 'hama-sub-2' }), 'hama-sub-2');
  other.at(YEAR_END - DAY);
  const fallback = await other.svc.handleGrobleEvent(failed({ contentId: 'GLJFC9', ref: 'hama-sub-2', failedAt: '2027-10-20T14:22:11+09:00' }), { idempotencyKey: 'f2' });
  assert.equal(fallback.paymentGraceEndsAt, new Date(YEAR_END + 7 * DAY).toISOString());
  assert.equal((await viewOf(other.svc, annualKey)).subscription.paymentGraceEndsAt, new Date(YEAR_END + 7 * DAY).toISOString());
});

test('Basic key email copy', () => {
  const mail = licenseEmail({ key: 'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', kind: 'basic', expiresAt: YEAR_END, cycleMonths: 12 });
  assert.equal(mail.subject, '[HamaEditor] Basic 라이선스 키를 보내드려요');
  assert.ok(mail.html.includes('Basic을 구독해 주셔서 고마워요.'));
  assert.ok(mail.html.includes('매년 자동으로 갱신돼요. 다음 갱신일은 2027년 10월 20일이에요.'));
  assert.equal(mail.text, 'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE');
});

test('HTTP: Basic webhook, activate JSON, customers plan and the CLI lookup line', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-pro-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const server = createSiteServer(
    { RAU_SITE_DATA: directory, GROBLE_WEBHOOK_SECRET: SECRET, ADMIN_TOKEN: ADMIN, LICENSE_SIGNING_PRIVATE_KEY: PAIR.privateKeyDerBase64, ...BASIC_ENV },
    { log: () => {}, emailProvider: { name: 'test', async send() { return { status: 'sent' }; } }, alertProvider: null, now: () => T0 },
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await (await signedGroblePost(origin, SECRET, basicPaid())).json()).action, 'issued');
  const { key } = await (await fetch(`${origin}/v1/license/by-ref?ref=hama-pro-1`)).json();
  const act = await (await fetch(`${origin}/v1/license/activate`, { method: 'POST', body: JSON.stringify({ key, deviceId: 'mac-http-01' }) })).json();
  assert.deepEqual([act.ok, act.edition, act.plan, act.rau], [true, 'pro', 'monthly', { eligible: true }], 'an app without the plan-names header still hears pro');
  const named = await (await fetch(`${origin}/v1/license/validate`, { method: 'POST', headers: { 'X-Hama-Plan-Names': 'basic' }, body: JSON.stringify({ key, deviceId: 'mac-http-01' }) })).json();
  assert.deepEqual([named.ok, named.edition], [true, 'basic']);
  const byRef = await (await fetch(`${origin}/v1/license/by-ref?ref=hama-pro-1`, { headers: { 'X-Hama-Plan-Names': 'basic' } })).json();
  assert.equal(byRef.edition, 'basic');
  const customers = await (await fetch(`${origin}/v1/admin/licenses/customers`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json();
  assert.deepEqual([customers.customers[0].plan, customers.customers[0].edition], ['monthly', 'basic']);

  const run = (...args) => promisify(execFile)(process.execPath, [CLI, ...args], { env: { ...process.env, SITE_API_BASE: origin, ADMIN_TOKEN: ADMIN } });
  const shown = await run('lookup', '--key', key);
  assert.match(shown.stdout, new RegExp(`${key} basic monthly · active · 2026-11-20까지 · 자동 갱신`));
});

test('the old GROBLE_PRO_* and RAU_MONTHLY_CAP_USD_PRO variables still apply until the BASIC names are set', () => {
  const old = resolveLicenseConfig({ GROBLE_PRO_PRODUCT_IDS: 'OldMo1:1', GROBLE_PRO_MONTHLY_PRICE: '4900', PRO_UPGRADE_URL: 'https://x.example/old' });
  const product = old.products.find((p) => p.id === 'OldMo1');
  assert.deepEqual([product.edition, product.expectedPrice, old.basicUpgradeUrl], ['basic', 4900, 'https://x.example/old']);
  const both = resolveLicenseConfig({ GROBLE_PRO_PRODUCT_IDS: 'OldMo1:1', GROBLE_BASIC_PRODUCT_IDS: 'NewMo1:1' });
  assert.deepEqual([both.products.some((p) => p.id === 'OldMo1'), both.products.some((p) => p.id === 'NewMo1')], [false, true]);
  assert.equal(resolveRauConfig({ RAU_MONTHLY_CAP_USD_PRO: '3' }).monthlyCapsUsd.basic, 3);
  assert.equal(resolveRauConfig({ RAU_MONTHLY_CAP_USD_PRO: '3', RAU_MONTHLY_CAP_USD_BASIC: '4' }).monthlyCapsUsd.basic, 4);
});

test('a key stored as pro before the rename reads as basic and keeps Rau', async () => {
  const { svc } = service();
  const { key } = await issued(svc, basicPaid());
  const state = await svc.admin.lookup(ADMIN, { key });
  const keyId = state.licenses[0].keyId;
  const store = createMemoryStore(emptyLicensesState());
  const saved = emptyLicensesState();
  saved.licenses[keyId] = { keyId, key, status: 'active', createdAt: new Date(T0).toISOString(), devices: {}, edition: 'pro', productId: BASIC_MONTHLY_ID, billingCycleMonths: 1, expiresAt: new Date(MONTH_END).toISOString() };
  saved.keyIndex[key] = keyId;
  await store.save(saved);
  const legacy = service({ store }).svc;
  const lease = await legacy.activate({ key, deviceId: 'mac-old-0001', platform: 'darwin' });
  assert.deepEqual([lease.edition, lease.rau], ['basic', { eligible: true }]);
  assert.equal((await legacy.authenticateLease(lease.lease, { withRauPlan: true })).rauPlan, 'basic');
  assert.equal((await viewOf(legacy, key)).edition, 'basic');
  assert.equal((await store.load()).licenses[keyId].edition, 'pro', 'the stored record is left as written');
});
