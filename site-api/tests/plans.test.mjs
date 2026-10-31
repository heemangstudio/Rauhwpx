import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { resolveLicenseConfig, resolveRauConfig, retiredEnvNames } from '../config.mjs';
import { heldReasonText } from '../held-alert.mjs';
import { generateLeaseKeyPair, parseSigningPrivateKey, verifyLease } from '../license-lease.mjs';
import { licenseEmail, licenseEmailKind } from '../license-email.mjs';
import { createLicensesService, emptyLicensesState } from '../licenses.mjs';
import { createSiteServer } from '../server.mjs';
import { createMemoryStore } from '../store.mjs';
import { PRODUCTS, planPaid, signedGroblePost } from './fixtures/groble-plans.mjs';

const ADMIN = 'admin-token-for-plan-tests';
const SECRET = 'whsec_test_plans';
const PAIR = generateLeaseKeyPair();
const KEYS = { 'hama-prod-1': PAIR.publicKeyRawBase64 };
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-10-20T14:22:11+09:00');
const MONTH_END = Date.parse('2026-11-20T23:59:59.999+09:00');
const YEAR_END = Date.parse('2027-10-20T23:59:59.999+09:00');
const CLI = fileURLToPath(new URL('../scripts/license-admin.mjs', import.meta.url));
const VENDORS = /Haiku|Claude|DeepSeek|OpenRouter|Anthropic|Basic/i;

function service({ start = T0, products = resolveLicenseConfig({}).products, ...overrides } = {}) {
  let clock = start;
  const sent = [];
  const store = overrides.store ?? createMemoryStore(emptyLicensesState());
  const svc = createLicensesService({
    store,
    signingKey: parseSigningPrivateKey(PAIR.privateKeyPem),
    adminToken: ADMIN,
    products,
    now: () => clock,
    emailProvider: { name: 'test', async send(m) { sent.push(m); return { status: 'sent' }; } },
    log: () => {},
    ...overrides,
  });
  return { svc, sent, store, at: (ms) => { clock = ms; } };
}

async function issued(svc, event) {
  const result = await svc.handleGrobleEvent(event, { idempotencyKey: `i-${event.id}` });
  const ref = event.data.object.sellerReference;
  return { result, key: (await svc.statusByRef(ref)).key };
}

const viewOf = async (svc, key) => (await svc.admin.lookup(ADMIN, { key })).licenses[0];

test('config: the four plan products with their prices and Groble options are the defaults; bad entries fail startup', () => {
  const config = resolveLicenseConfig({});
  assert.deepEqual(config.products.filter((p) => p.plan).map((p) => [p.id, p.plan, p.edition, p.cycleMonths, p.expectedPrice, p.minAmount, p.optionId ?? null]), [
    ['SfYBy5', 'hama', 'basic', 1, 3900, 3900, null],
    ['vdw3HN', 'hama', 'basic', 12, 39000, 39000, '8JF8jD'],
    ['R3n8zG', 'rau', 'rau', 1, 14900, 14900, 't3QJ4b'],
    ['atqjpJ', 'rau', 'rau', 12, 149000, 149000, 'nqSZ94'],
  ]);
  assert.equal(config.rauUpgradeUrl, 'https://heemangstudios.com/pricing.html#rau');
  const custom = resolveLicenseConfig({ GROBLE_RAU_PRODUCTS: 'RauMo1:1:9900:opt_1', GROBLE_PRODUCT_PRICES: 'RauMo1:9900:5000' });
  assert.deepEqual(custom.products.filter((p) => p.plan === 'rau').map((p) => [p.id, p.expectedPrice, p.minAmount, p.optionId]), [['RauMo1', 9900, 5000, 'opt_1']]);
  for (const entry of ['abc:6:100', 'abc:1', 'abc:1:x', 'abc:1:100:bad option', 'abc:1:100:o:extra']) {
    assert.throws(() => resolveLicenseConfig({ GROBLE_HAMA_PRODUCTS: entry }), /GROBLE_HAMA_PRODUCTS entry/, entry);
  }
  assert.throws(() => resolveLicenseConfig({ GROBLE_RAU_PRODUCTS: 'GLJFC9:12:9900' }), /both subscription and rau/);
  assert.throws(() => resolveLicenseConfig({ RAU_UPGRADE_URL: 'http://x.example' }), /RAU_UPGRADE_URL must be an https/);
  assert.throws(() => resolveLicenseConfig({ GROBLE_PAYMENT_GRACE_MAX_DAYS: '30' }), /under a month/);
});

test('retired plan variables never stop the server: their values are ignored and their names logged once', async (t) => {
  const old = {
    GROBLE_BASIC_PRODUCT_IDS: 'SfYBy5:1',
    GROBLE_PRO_MONTHLY_PRICE: 'not-a-number',
    GROBLE_HAMA_PRODUCT_IDS: 'R3n8zG:1,atqjpJ:12',
    GROBLE_HAMA_MONTHLY_PRICE: '12900',
    PRO_UPGRADE_URL: 'http://not-https.example',
    HAMA_ENABLED: 'maybe',
    HAMA_CAP_5H_PCT: '500',
    HAMA_CHEAP_MODELS: 'anthropic/claude-x',
    RAU_REASONING_EFFORT: 'unheard-of',
    RAU_MAX_OUTPUT_TOKENS: '-1',
    RAU_MONTHLY_CAP_USD_BASIC: '0',
    RAU_MODEL: '~deepseek/deepseek-flash-latest',
  };
  assert.deepEqual(resolveLicenseConfig(old).products, resolveLicenseConfig({}).products);
  const rau = resolveRauConfig(old);
  assert.deepEqual([rau.models, rau.allowanceUsd, rau.warnings.length], [['haiku'], 8, 1]);
  assert.deepEqual(retiredEnvNames({ HAMA_OPENROUTER_KEY: 'k' }), [], 'the fallback key name is still read');
  assert.deepEqual(retiredEnvNames({ HAMA_OPENROUTER_KEY: 'k', RAU_OPENROUTER_KEY: 'k2' }), ['HAMA_OPENROUTER_KEY']);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-plans-env-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const lines = [];
  createSiteServer({ RAU_SITE_DATA: directory, ...old }, { log: (line) => lines.push(line), emailProvider: null, alertProvider: null });
  const retired = lines.filter((line) => line.includes('retired variables'));
  assert.equal(retired.length, 1);
  for (const name of Object.keys(old).filter((n) => n !== 'RAU_MODEL')) assert.ok(retired[0].includes(name), name);
  for (const value of ['not-a-number', 'maybe', 'unheard-of', 'deepseek-flash-latest']) assert.ok(!lines.join('\n').includes(value), value);
});

for (const [sku, stored, wire, plan, end, rau] of [
  ['hamaMonthly', 'basic', 'hama', 'monthly', MONTH_END, false],
  ['hamaYearly', 'basic', 'hama', 'annual', YEAR_END, false],
  ['rauMonthly', 'rau', 'rau', 'monthly', MONTH_END, true],
  ['rauYearly', 'rau', 'rau', 'annual', YEAR_END, true],
]) {
  test(`${sku}: a paid ${PRODUCTS[sku].id} issues a ${wire} key stored as ${stored}, ${plan}, with Rau ${rau ? 'on' : 'off'}`, async () => {
    const { svc, store } = service();
    const { result, key } = await issued(svc, planPaid({ sku }));
    assert.deepEqual([result.action, result.expiresAt], ['issued', new Date(end).toISOString()]);
    const view = await viewOf(svc, key);
    assert.deepEqual([view.edition, view.plan, view.productId, view.billingCycleMonths], [wire, plan, PRODUCTS[sku].id, PRODUCTS[sku].months]);
    assert.equal((await store.load()).licenses[view.keyId].edition, stored);
    const lease = await svc.activate({ key, deviceId: 'mac-plan-0001', platform: 'darwin' });
    assert.deepEqual([lease.edition, lease.plan, lease.rau, lease.licenseExpiresAt], [wire, plan, { eligible: rau }, end]);
    const checked = verifyLease(lease.lease, KEYS, { deviceId: 'mac-plan-0001', key, now: T0 });
    assert.deepEqual(Object.keys(checked.payload).sort(), ['deviceId', 'expiresAt', 'issuedAt', 'keyHash', 'keyId', 'kid', 'licenseExpiresAt', 'v'], 'the signed lease format is unchanged');
    assert.deepEqual(await svc.statusByRef(`ref-${sku}`), { status: 'issued', key, licenseExpiresAt: end, edition: wire, plan });
    const who = await svc.authenticateLease(lease.lease, { withRau: true });
    assert.deepEqual(who.rau, rau ? { source: 'plan', ledgerId: view.keyId, anchor: new Date(T0).toISOString() } : null);
  });
}

test('initial payments must match the price and the product\'s one Groble option; each miss is held with a Korean reason', async () => {
  const option = (optionId, unitOriginalPrice) => ({ optionId, quantity: 1, unitOriginalPrice });
  const coupon = planPaid({ sku: 'rauMonthly' });
  coupon.data.object.pricing.finalAmount = 10000;
  const cases = [
    [planPaid({ sku: 'hamaYearly', options: null }), 'missing_option', '결제에 상품 옵션이 빠져 있어요.'],
    [planPaid({ sku: 'rauYearly', options: [] }), 'missing_option'],
    [planPaid({ sku: 'rauMonthly', options: [option('other1', 14900)] }), 'wrong_option:other1', '다른 상품 옵션(other1)의 결제예요.'],
    [planPaid({ sku: 'rauYearly', options: [option('nqSZ94', 149000), option('extra1', 0)] }), 'wrong_option:nqSZ94,extra1'],
    [planPaid({ sku: 'rauYearly', options: [option('nqSZ94', 14900)] }), 'wrong_price:14900', '상품 정가가 14,900원으로 왔어요. 정해 둔 가격과 달라요.'],
    [planPaid({ sku: 'hamaYearly', options: [option('t3QJ4b', 39000)] }), 'wrong_option:t3QJ4b'],
    [planPaid({ sku: 'rauMonthly', price: 12900 }), 'wrong_price:12900'],
    [planPaid({ sku: 'hamaMonthly', price: 3000 }), 'wrong_price:3000'],
    [coupon, 'amount_below_minimum:10000'],
  ];
  for (const [index, [event, reason, text]] of cases.entries()) {
    const { svc } = service();
    const result = await svc.handleGrobleEvent(event, { idempotencyKey: `h${index}` });
    assert.deepEqual([result.action, result.reason], ['held', reason], reason);
    assert.equal((await svc.statusByRef(event.data.object.sellerReference)).status, 'pending');
    if (text) assert.equal(heldReasonText(reason), text);
  }
  // The monthly Hama product has no option on Groble, so whatever options arrive pass.
  const hama = service();
  assert.equal((await hama.svc.handleGrobleEvent(planPaid({ sku: 'hamaMonthly', options: null }), { idempotencyKey: 'ok1' })).action, 'issued');
  // A coupon the owner allows through GROBLE_PRODUCT_PRICES lowers the minimum only.
  const allowed = service({ products: resolveLicenseConfig({ GROBLE_PRODUCT_PRICES: 'R3n8zG:14900:10000' }).products });
  assert.equal((await allowed.svc.handleGrobleEvent(coupon, { idempotencyKey: 'ok2' })).action, 'issued');
  // Releasing a held order still issues the product's plan.
  const held = service();
  await held.svc.handleGrobleEvent(planPaid({ sku: 'rauYearly', options: [] }), { idempotencyKey: 'rel' });
  const released = await held.svc.admin.release(ADMIN, { merchantUid: 'm_rauYearly' });
  assert.deepEqual([released.license.edition, released.license.plan, released.license.expiresAt], ['rau', 'annual', new Date(YEAR_END).toISOString()]);
});

test('renewals check product and currency only: a missing or changed option still extends the key by its own cycle', async () => {
  const { svc, at } = service();
  const { key } = await issued(svc, planPaid({ sku: 'rauMonthly' }));
  at(Date.parse('2026-11-20T09:00:00+09:00'));
  const renewed = await svc.handleGrobleEvent(planPaid({ sku: 'rauMonthly', merchantUid: 'm_r2', round: 2, options: null, paidAt: '2026-11-20T09:00:00+09:00' }), { idempotencyKey: 'r2' });
  assert.deepEqual([renewed.action, renewed.expiresAt], ['renewed', new Date(Date.parse('2026-12-20T23:59:59.999+09:00')).toISOString()]);
  const changed = await svc.handleGrobleEvent(planPaid({ sku: 'rauMonthly', merchantUid: 'm_r3', round: 3, price: 9900, options: [{ optionId: 'new_opt', quantity: 1, unitOriginalPrice: 9900 }], paidAt: '2026-12-20T09:00:00+09:00' }), { idempotencyKey: 'r3' });
  assert.equal(changed.action, 'renewed');
  assert.equal((await viewOf(svc, key)).expiresAt, new Date(Date.parse('2027-01-20T23:59:59.999+09:00')).toISOString());
  // The cycle still has to match on a renewal.
  const mismatch = await svc.handleGrobleEvent(planPaid({ sku: 'rauMonthly', merchantUid: 'm_r4', round: 4, cycle: 12 }), { idempotencyKey: 'r4' });
  assert.equal(mismatch.reason, 'cycle_mismatch:12');
});

test('a plan event whose billingCycleMonths disagrees with the product is held; an unreadable one uses the product cycle', async () => {
  const { svc } = service();
  const held = await svc.handleGrobleEvent(planPaid({ sku: 'hamaMonthly', cycle: 12 }), { idempotencyKey: 'c1' });
  assert.deepEqual([held.action, held.reason], ['held', 'cycle_mismatch:12']);
  for (const cycle of [null, 0, 13, '1']) {
    const other = service();
    const { result } = await issued(other.svc, planPaid({ sku: 'hamaMonthly', cycle }));
    assert.equal(result.expiresAt, new Date(MONTH_END).toISOString(), `cycle ${cycle}`);
  }
});

test('a monthly renewal sends no key email; payment grace is clamped to GROBLE_PAYMENT_GRACE_MAX_DAYS past the expiry', async () => {
  const { svc, sent, at } = service();
  const { key } = await issued(svc, planPaid({ sku: 'hamaMonthly' }));
  await svc.deliverPendingEmails();
  await svc.activate({ key, deviceId: 'mac-plan-0001' });
  at(Date.parse('2026-11-20T09:00:00+09:00'));
  await svc.handleGrobleEvent(planPaid({ sku: 'hamaMonthly', merchantUid: 'm_r2', round: 2, paidAt: '2026-11-20T09:00:00+09:00' }), { idempotencyKey: 'r2' });
  await svc.deliverPendingEmails();
  assert.equal(sent.length, 1, 'only the first key email');

  const nextEnd = Date.parse('2026-12-20T23:59:59.999+09:00');
  at(nextEnd - DAY);
  const failure = {
    id: 'evt_fail', type: 'subscription_payment.failed', occurredAt: '2026-12-20T14:22:11+09:00',
    data: { object: {
      merchantUid: 'fail_1', sellerReference: 'ref-hamaMonthly', buyer: { email: 'buyer@example.com' },
      content: { id: PRODUCTS.hamaMonthly.id, paymentType: 'SUBSCRIPTION' }, pricing: { currency: 'KRW', finalAmount: 3900 },
      failure: { attemptNumber: 3, isFinal: true, failedAt: '2026-12-20T14:22:11+09:00', gracePeriodEndsAt: '2027-01-20T14:22:11+09:00' },
    } },
  };
  assert.equal((await svc.handleGrobleEvent(failure, { idempotencyKey: 'f1' })).paymentGraceEndsAt, new Date(nextEnd + 14 * DAY).toISOString());
  at(nextEnd + 13 * DAY);
  const lease = await svc.validate({ key, deviceId: 'mac-plan-0001' });
  assert.deepEqual([lease.licenseState, lease.paymentGraceEndsAt], ['payment_failed', nextEnd + 14 * DAY]);
  at(nextEnd + 14 * DAY);
  await assert.rejects(svc.validate({ key, deviceId: 'mac-plan-0001' }), { code: 'expired' });
});

test('GLJFC9, lifetime and beta keys have no edition and no Rau', async () => {
  const { svc } = service();
  const { key } = await issued(svc, planPaid({ sku: 'hamaYearly', contentId: 'GLJFC9', price: 9900, cycle: null, options: null, ref: 'ref-sub' }));
  const lease = await svc.activate({ key, deviceId: 'mac-sub-0001' });
  assert.deepEqual([lease.edition, lease.plan, lease.rau], [undefined, 'annual', { eligible: false }]);
  const lifetime = await svc.admin.issue(ADMIN, { email: 'old@example.com' });
  const beta = await svc.admin.issueBeta(ADMIN, { name: '테스터' });
  for (const license of [lifetime.license, beta.license]) {
    const answer = await svc.activate({ key: license.key, deviceId: 'mac-old-0001' });
    assert.deepEqual([answer.edition, answer.plan, answer.rau], [undefined, 'lifetime', { eligible: false }]);
  }
});

test('stored editions read by their new names and are never rewritten: pro and basic are Hama, hama and rau are Rau', async () => {
  for (const [stored, wire, rau] of [['pro', 'hama', false], ['basic', 'hama', false], ['hama', 'rau', true], ['rau', 'rau', true]]) {
    const key = 'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE';
    const saved = emptyLicensesState();
    saved.licenses.lic_old = {
      keyId: 'lic_old', key, status: 'active', createdAt: new Date(T0 - 40 * DAY).toISOString(), devices: {}, edition: stored,
      productId: 'R3n8zG', billingCycleMonths: 1, expiresAt: new Date(MONTH_END).toISOString(),
      subscription: { productId: 'R3n8zG', status: 'active', autoRenew: true, activatedAt: '2026-09-20T05:22:11.000Z' },
    };
    saved.keyIndex[key] = 'lic_old';
    const store = createMemoryStore(saved);
    const { svc } = service({ store });
    const lease = await svc.activate({ key, deviceId: 'mac-old-0001', platform: 'darwin' });
    assert.deepEqual([lease.edition, lease.rau], [wire, { eligible: rau }], stored);
    const who = await svc.authenticateLease(lease.lease, { withRau: true });
    assert.deepEqual(who.rau, rau ? { source: 'plan', ledgerId: 'lic_old', anchor: '2026-09-20T05:22:11.000Z' } : null, stored);
    assert.equal((await viewOf(svc, key)).edition, wire);
    assert.equal((await store.load()).licenses.lic_old.edition, stored, 'the stored record is left as written');
  }
});

test('a key with an active plan in the frozen hama.json keeps Rau while it is live', async () => {
  const plans = { lic_enrolled: { periodAnchor: '2026-09-05T00:00:00.000Z' } };
  const { svc, at } = service({ legacyRauPlan: async (keyId) => plans[keyId] ?? null });
  const enrolled = (await svc.admin.issue(ADMIN, { years: 1 })).license;
  plans[enrolled.keyId] = plans.lic_enrolled;
  const other = (await svc.admin.issue(ADMIN, {})).license;
  const lease = await svc.activate({ key: enrolled.key, deviceId: 'mac-legacy-01' });
  assert.deepEqual([lease.edition, lease.rau], [undefined, { eligible: true }]);
  assert.equal((await svc.activate({ key: other.key, deviceId: 'mac-legacy-02' })).rau.eligible, false);
  // The license's own start anchors its months; the plan's anchor is only the last resort.
  assert.equal((await svc.authenticateLease(lease.lease, { withRau: true })).rau.anchor, new Date(T0).toISOString());
  at(Date.parse(enrolled.expiresAt) + 1);
  await assert.rejects(svc.validate({ key: enrolled.key, deviceId: 'mac-legacy-01' }), { code: 'expired' });
  const broken = service({ legacyRauPlan: async () => { throw new Error('unreadable'); } });
  const key = (await broken.svc.admin.issue(ADMIN, {})).license.key;
  assert.equal((await broken.svc.activate({ key, deviceId: 'mac-legacy-03' })).rau.eligible, false, 'an unreadable hama.json fails closed');
});

test('key email: Hama names the own-AI connection, Rau the own-AI connection and Rau mode with no included AI; neither names a model or vendor', () => {
  for (const [edition, kind] of [['pro', 'hama'], ['basic', 'hama'], ['hama', 'rau'], ['rau', 'rau']]) {
    assert.equal(licenseEmailKind({ edition, source: 'groble' }), kind, edition);
    assert.equal(licenseEmailKind({ edition, source: 'groble', emailDelivery: { resend: true } }), 'resend');
  }
  const hama = licenseEmail({ key: 'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', kind: 'hama', expiresAt: YEAR_END, cycleMonths: 12 });
  assert.equal(hama.subject, '[HamaEditor] Hama 라이선스 키를 보내드려요');
  for (const text of ['Hama를 구독해 주셔서 고마워요.', '내 AI 연결', '기기 2대', '매년 자동으로 갱신돼요.']) assert.ok(hama.html.includes(text), text);
  const rau = licenseEmail({ key: 'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', kind: 'rau', expiresAt: MONTH_END, cycleMonths: 1 });
  assert.equal(rau.subject, '[HamaEditor] Rau 라이선스 키를 보내드려요');
  for (const text of ['Rau를 구독해 주셔서 고마워요.', '내 AI 연결', 'Rau 모드', '기기 2대', '매달 자동으로 갱신돼요.']) assert.ok(rau.html.includes(text), text);
  for (const text of ['AI 포함', '크레딧']) assert.ok(!rau.html.includes(text), text);
  for (const mail of [hama, rau]) assert.doesNotMatch(`${mail.subject}\n${mail.html}`, VENDORS);
});

test('HTTP: a Rau purchase, the app answers in the new names with or without the old header, the customers view and the CLI line', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-plans-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const sent = [];
  const server = createSiteServer(
    { RAU_SITE_DATA: directory, GROBLE_WEBHOOK_SECRET: SECRET, ADMIN_TOKEN: ADMIN, LICENSE_SIGNING_PRIVATE_KEY: PAIR.privateKeyDerBase64 },
    { log: () => {}, emailProvider: { name: 'test', async send(m) { sent.push(m); return { status: 'sent' }; } }, alertProvider: null, now: () => T0 },
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await (await signedGroblePost(origin, SECRET, planPaid({ sku: 'rauMonthly' }))).json()).action, 'issued');
  const byRef = await (await fetch(`${origin}/v1/license/by-ref?ref=ref-rauMonthly`)).json();
  assert.deepEqual([byRef.status, byRef.edition, byRef.plan], ['issued', 'rau', 'monthly']);
  const act = await (await fetch(`${origin}/v1/license/activate`, { method: 'POST', body: JSON.stringify({ key: byRef.key, deviceId: 'mac-http-01' }) })).json();
  assert.deepEqual([act.ok, act.edition, act.plan, act.rau], [true, 'rau', 'monthly', { eligible: true }]);
  const old = await (await fetch(`${origin}/v1/license/validate`, { method: 'POST', headers: { 'X-Hama-Plan-Names': 'basic' }, body: JSON.stringify({ key: byRef.key, deviceId: 'mac-http-01' }) })).json();
  assert.equal(old.edition, 'rau', 'the retired plan-names header changes nothing');
  const customers = await (await fetch(`${origin}/v1/admin/licenses/customers`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json();
  assert.deepEqual([customers.customers[0].plan, customers.customers[0].edition], ['monthly', 'rau']);
  for (let i = 0; i < 50 && sent.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent[0]?.subject, '[HamaEditor] Rau 라이선스 키를 보내드려요');

  const run = (...args) => promisify(execFile)(process.execPath, [CLI, ...args], { env: { ...process.env, SITE_API_BASE: origin, ADMIN_TOKEN: ADMIN } });
  const shown = await run('lookup', '--key', byRef.key);
  assert.match(shown.stdout, new RegExp(`${byRef.key} rau monthly · active · 2026-11-20까지 · 자동 갱신`));
});
