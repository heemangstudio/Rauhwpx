import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { resolveLicenseConfig } from '../config.mjs';
import { licenseEmail, licenseEmailKind } from '../license-email.mjs';
import { generateLeaseKeyPair, parseSigningPrivateKey, verifyLease } from '../license-lease.mjs';
import { createLicensesService, emptyLicensesState, subscriptionEnd } from '../licenses.mjs';
import { createSiteServer } from '../server.mjs';
import { createMemoryStore } from '../store.mjs';

const ADMIN = 'admin-token-for-signature-tests';
const PAIR = generateLeaseKeyPair();
const KEYS = { 'hama-prod-1': PAIR.publicKeyRawBase64 };
const PAID_AT = '2026-10-20T14:22:11+09:00';
const T0 = Date.parse(PAID_AT);
const UPDATES_UNTIL = subscriptionEnd(T0, 36);
const SIG = '8Xy27f';
const CLI = fileURLToPath(new URL('../scripts/license-admin.mjs', import.meta.url));

function completed({
  merchantUid,
  contentId = SIG,
  amount = 29000,
  ref = `ref-${merchantUid}`,
  paymentType = 'ONE_TIME',
  type = 'payment.completed',
} = {}) {
  return {
    id: `evt_${merchantUid}`,
    type,
    occurredAt: PAID_AT,
    data: { object: {
      merchantUid,
      sellerReference: ref,
      buyer: { email: `${merchantUid}@example.com` },
      content: { id: contentId, paymentType },
      pricing: { currency: 'KRW', originalAmount: amount, finalAmount: amount },
      payment: { purchasedAt: PAID_AT },
      ...(type.startsWith('subscription') ? { subscription: { billingReason: 'INITIAL', billingCycleMonths: 12 } } : {}),
    } },
  };
}

function refunded(merchantUid, { partial = false, amount = 29000, refundedAt = '2026-10-21T12:00:00+09:00' } = {}) {
  return {
    id: `evt_r_${merchantUid}_${refundedAt}`,
    type: 'payment.refunded',
    occurredAt: refundedAt,
    data: { object: {
      merchantUid,
      pricing: { currency: 'KRW', originalAmount: 29000, finalAmount: 29000 },
      refund: { amount, partialRefund: partial, refundedAt },
    } },
  };
}

function service() {
  const sent = [];
  const svc = createLicensesService({
    store: createMemoryStore(emptyLicensesState()),
    signingKey: parseSigningPrivateKey(PAIR.privateKeyPem),
    adminToken: ADMIN,
    now: () => T0,
    emailProvider: { name: 'test', async send(message) { sent.push(message); return { status: 'sent' }; } },
    log: () => {},
  });
  return { svc, sent };
}

async function viewOf(svc, key) {
  return (await svc.admin.lookup(ADMIN, { key })).licenses[0];
}

test('config prices each Groble product, and Signature defaults to 8Xy27f at 29000', () => {
  const defaults = resolveLicenseConfig({});
  assert.deepEqual(defaults.signatureProductIds, [SIG]);
  const byId = Object.fromEntries(defaults.products.map((product) => [product.id, product]));
  assert.deepEqual(byId.uRshdR, { id: 'uRshdR', kind: 'onetime', expectedPrice: 9900, minAmount: 9900 });
  assert.deepEqual(byId.GLJFC9, { id: 'GLJFC9', kind: 'subscription', expectedPrice: 9900, minAmount: 9900 });
  assert.deepEqual(byId[SIG], { id: SIG, kind: 'signature', expectedPrice: 29000, minAmount: 29000 });

  const yearlyCoupon = resolveLicenseConfig({ GROBLE_MIN_AMOUNT: '1000' });
  assert.equal(yearlyCoupon.products.find((product) => product.id === 'GLJFC9').minAmount, 1000);
  assert.equal(yearlyCoupon.products.find((product) => product.id === SIG).minAmount, 29000);

  const overridden = resolveLicenseConfig({ GROBLE_PRODUCT_PRICES: '8Xy27f:28000:27000,GLJFC9:9900' });
  assert.equal(overridden.products.find((product) => product.id === SIG).expectedPrice, 28000);
  assert.equal(overridden.products.find((product) => product.id === SIG).minAmount, 27000);
  assert.equal(overridden.products.find((product) => product.id === 'uRshdR').expectedPrice, 9900);

  assert.throws(() => resolveLicenseConfig({ GROBLE_SIGNATURE_PRODUCT_IDS: 'GLJFC9' }), /both subscription and signature/);
  assert.throws(() => resolveLicenseConfig({ GROBLE_SIGNATURE_PRODUCT_IDS: 'uRshdR' }), /both one-time and signature/);
  assert.throws(() => resolveLicenseConfig({ GROBLE_PRODUCT_PRICES: 'missing:29000' }), /not a configured Groble product/);
  assert.throws(() => resolveLicenseConfig({ GROBLE_SIGNATURE_EXPECTED_PRICE: '29,000' }), /GROBLE_SIGNATURE_EXPECTED_PRICE/);
});

test('Signature payment.completed issues a lifetime key and does not uplift other keys', async () => {
  const { svc, sent } = service();
  const issued = await svc.handleGrobleEvent(completed({ merchantUid: 'sig1' }), { idempotencyKey: 's1' });
  assert.equal(issued.action, 'issued');
  assert.equal(issued.expiresAt, undefined);
  const again = await svc.handleGrobleEvent(completed({ merchantUid: 'sig1' }), { idempotencyKey: 's2' });
  assert.equal(again.action, 'already_issued');

  const status = await svc.statusByRef('ref-sig1');
  const view = await viewOf(svc, status.key);
  assert.equal(status.licenseExpiresAt, null);
  assert.equal(status.edition, 'signature');
  assert.equal(status.prioritySupport, true);
  assert.equal(status.updatesUntil, UPDATES_UNTIL);
  assert.equal(view.plan, 'lifetime');
  assert.equal(view.edition, 'signature');
  assert.equal(view.productId, SIG);
  assert.equal(view.expiresAt, null);
  assert.equal(Date.parse(view.updatesUntil), UPDATES_UNTIL);
  assert.deepEqual(view.support, { channel: 'email', sla: '1_business_day', timezone: 'Asia/Seoul' });
  assert.equal(view.prioritySupport, true);
  assert.equal(view.supportSlaLabel, '1영업일 내 첫 답변');
  assert.equal((await svc.admin.signatures(ADMIN)).count, 1);

  const cheap = await svc.handleGrobleEvent(completed({ merchantUid: 'sig_cheap', amount: 9900 }), { idempotencyKey: 'cheap' });
  assert.equal(cheap.action, 'held');
  assert.equal(cheap.reason, 'wrong_price:9900');
  const legacyPrice = await svc.handleGrobleEvent(completed({ merchantUid: 'old_price', contentId: 'uRshdR', amount: 29000 }), { idempotencyKey: 'old-price' });
  assert.equal(legacyPrice.reason, 'wrong_price:29000');

  const legacy = await svc.handleGrobleEvent(completed({ merchantUid: 'old1', contentId: 'uRshdR', amount: 9900, ref: 'ref-old' }), { idempotencyKey: 'old' });
  assert.equal(legacy.action, 'issued');
  const legacyView = await viewOf(svc, (await svc.statusByRef('ref-old')).key);
  assert.equal(legacyView.edition, undefined);
  assert.equal(legacyView.prioritySupport, false);
  assert.equal(legacyView.plan, 'lifetime');
  assert.equal(legacyView.expiresAt, null);

  const yearly = await svc.handleGrobleEvent(completed({
    merchantUid: 'year1',
    contentId: 'GLJFC9',
    amount: 9900,
    paymentType: 'SUBSCRIPTION',
    type: 'subscription_payment.completed',
    ref: 'ref-year',
  }), { idempotencyKey: 'year' });
  assert.equal(yearly.action, 'issued');
  const yearlyView = await viewOf(svc, (await svc.statusByRef('ref-year')).key);
  assert.equal(yearlyView.edition, undefined);
  assert.equal(yearlyView.prioritySupport, false);
  assert.equal(yearlyView.plan, 'annual');
  assert.equal(yearlyView.expiresAt !== null, true);

  const beta = await svc.admin.issueBeta(ADMIN, { name: '테스터' });
  assert.equal(beta.license.edition, undefined);
  assert.equal(beta.license.prioritySupport, false);
  const manual = await svc.admin.issue(ADMIN, { email: 'manual@example.com' });
  assert.equal(manual.license.edition, undefined);
  assert.equal(manual.license.prioritySupport, false);

  const listed = await svc.admin.signatures(ADMIN);
  assert.deepEqual(listed.signatures.map((row) => row.email), ['sig1@example.com']);
  const orders = await svc.admin.orders(ADMIN, { contentId: SIG });
  assert.ok(orders.orders.every((order) => order.contentId === SIG));
  assert.equal(orders.orders.some((order) => order.merchantUid === 'sig1'), true);

  await svc.deliverPendingEmails();
  const mail = sent.find((message) => message.to === 'sig1@example.com');
  assert.equal(licenseEmailKind(view), 'signature');
  assert.match(mail.subject, /Signature/);
  assert.match(mail.html, /우선 지원 · 1영업일/);
  assert.doesNotMatch(mail.html, /평생/);
  assert.equal(mail.text, status.key);
  const card = mail.html.slice(mail.html.indexOf('<!-- card'), mail.html.indexOf('<!-- CTA'));
  assert.match(card, /업데이트 약속은 2029년 10월 20일까지예요/);
  const frame = mail.html.slice(mail.html.indexOf('<!-- card'), mail.html.lastIndexOf('</table>', mail.html.indexOf('<!-- CTA')));
  assert.equal(frame.includes('2029'), false);
  assert.ok(frame.includes(status.key));
});

test('a full Signature refund revokes the key and drops priority support', async () => {
  const { svc } = service();
  await svc.handleGrobleEvent(completed({ merchantUid: 'sig_refund', ref: 'ref-refund' }), { idempotencyKey: 'rf1' });
  const key = (await svc.statusByRef('ref-refund')).key;
  const partial = await svc.handleGrobleEvent(refunded('sig_refund', { partial: true, amount: 1000, refundedAt: '2026-10-21T10:00:00+09:00' }), { idempotencyKey: 'rf-part' });
  assert.equal(partial.action, 'partial_refund_recorded');
  assert.equal((await viewOf(svc, key)).status, 'active');
  const full = await svc.handleGrobleEvent(refunded('sig_refund', { refundedAt: '2026-10-21T11:00:00+09:00' }), { idempotencyKey: 'rf-full' });
  assert.equal(full.action, 'revoked');
  const view = await viewOf(svc, key);
  assert.equal(view.status, 'revoked');
  assert.equal(view.edition, 'signature');
  assert.equal(view.prioritySupport, false);
  assert.equal(view.supportSlaLabel, undefined);
});

test('activate reports Signature fields outside the signed lease', async () => {
  const { svc } = service();
  await svc.handleGrobleEvent(completed({ merchantUid: 'sig_act', ref: 'ref-act' }), { idempotencyKey: 'act' });
  const key = (await svc.statusByRef('ref-act')).key;
  const lease = await svc.activate({ key, deviceId: 'device-sig-1', platform: 'win32' });
  assert.equal(lease.licenseExpiresAt, null);
  assert.equal(lease.edition, 'signature');
  assert.equal(lease.prioritySupport, true);
  assert.equal(lease.updatesUntil, UPDATES_UNTIL);
  const checked = verifyLease(lease.lease, KEYS, { deviceId: 'device-sig-1', key, now: T0 });
  assert.equal(checked.ok, true);
  assert.equal(checked.payload.licenseExpiresAt, undefined);
  assert.equal('edition' in checked.payload, false);
  assert.equal('updatesUntil' in checked.payload, false);
});

test('admin issue --edition signature matches a webhook key, and a term conflicts', async () => {
  const { svc } = service();
  const issued = await svc.admin.issue(ADMIN, { edition: 'signature', email: 'backfill@example.com', sendEmail: true });
  assert.equal(issued.license.edition, 'signature');
  assert.equal(issued.license.productId, SIG);
  assert.equal(Date.parse(issued.license.updatesUntil), UPDATES_UNTIL);
  assert.equal(issued.license.expiresAt, null);
  const dated = await svc.admin.issue(ADMIN, { edition: 'signature', email: 'dated@example.com', updatesUntil: '2029-01-15' });
  assert.equal(Date.parse(dated.license.updatesUntil), Date.parse('2029-01-15T23:59:59.999+09:00'));
  await assert.rejects(svc.admin.issue(ADMIN, { edition: 'signature', years: 1 }), { code: 'term_conflict' });
  await assert.rejects(svc.admin.issue(ADMIN, { edition: 'nope' }), { code: 'edition_invalid' });

  const held = await svc.handleGrobleEvent(completed({ merchantUid: 'sig_hold', amount: 1000, ref: 'ref-hold' }), { idempotencyKey: 'hold' });
  assert.equal(held.reason, 'wrong_price:1000');
  const released = await svc.admin.release(ADMIN, { merchantUid: 'sig_hold' });
  assert.equal(released.license.edition, 'signature');
  assert.equal(released.license.productId, SIG);
});

test('Signature email copy names the edition and keeps the key card to the key', () => {
  const updatesUntil = UPDATES_UNTIL;
  const { subject, text, html } = licenseEmail({ key: 'HAMA-ABCDE-FGHJK-MNPQR-STVWX-YZ012', kind: 'signature', updatesUntil });
  assert.match(subject, /Signature/);
  assert.match(html, /우선 지원 · 1영업일/);
  assert.equal(text, 'HAMA-ABCDE-FGHJK-MNPQR-STVWX-YZ012');
  assert.doesNotMatch(html, /평생/);
  assert.equal(licenseEmailKind({ edition: 'signature', source: 'groble', emailDelivery: { resend: true } }), 'signature');
  assert.equal(licenseEmailKind({ source: 'groble', emailDelivery: { resend: true } }), 'resend');
});

test('CLI signatures lists Signature keys', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-sig-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const server = createSiteServer(
    { RAU_SITE_DATA: directory, ADMIN_TOKEN: ADMIN, LICENSE_SIGNING_PRIVATE_KEY: PAIR.privateKeyPem },
    { log: () => {}, emailProvider: { name: 'test', async send() { return { status: 'sent' }; } }, alertProvider: null },
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const run = (...args) => promisify(execFile)(process.execPath, [CLI, ...args], {
    env: { ...process.env, SITE_API_BASE: origin, ADMIN_TOKEN: ADMIN },
  });
  const issued = await run('issue', '--edition', 'signature', '--email', 'cli-sig@example.com');
  assert.match(issued.stdout, /signature · active · 우선지원 1영업일 · 업데이트 약속 ~/);
  const listed = await run('signatures');
  assert.match(listed.stdout, /cli-sig@example.com/);
  assert.match(listed.stdout, /우선지원 1영업일/);
  const beta = await run('beta', '--name', '베타');
  assert.doesNotMatch(beta.stdout, /signature ·/);
  const after = await run('signatures');
  assert.match(after.stdout, /cli-sig@example.com/);
  assert.equal((after.stdout.match(/signature ·/g) ?? []).length, 1);
});
