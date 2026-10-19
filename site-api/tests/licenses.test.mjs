import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { grobleSignature, verifyGrobleWebhook } from '../groble-webhook.mjs';
import { generateLeaseKeyPair, licenseKeyHash, parseSigningPrivateKey, signLease, verifyLease } from '../license-lease.mjs';
import { createLicensesService, emptyLicensesState, normalizeLicenseKey, KEY_RE } from '../licenses.mjs';
import { createSiteServer } from '../server.mjs';
import { createFileStore, createMemoryStore } from '../store.mjs';
import { uniqueInstallDigest } from '../unique-installs.mjs';

const SECRET = 'whsec_test_current';
const PREVIOUS = 'whsec_test_previous';
const ADMIN = 'admin-token-for-license-tests';
const PAIR = generateLeaseKeyPair();
const KEYS = { 'hama-prod-1': PAIR.publicKeyRawBase64 };
const T0 = Date.parse('2026-10-16T01:00:00+09:00');

function completed({ merchantUid = 'm_1', ref = 'hama-ref-1', amount = 9900, contentId = 'uRshdR', occurredAt = '2026-10-16T01:00:00+09:00', id = `evt_c_${merchantUid}` } = {}) {
  return {
    id,
    type: 'payment.completed',
    version: '2026-04-30',
    occurredAt,
    data: { object: {
      merchantUid,
      ...(ref ? { sellerReference: ref } : {}),
      buyer: { type: 'GUEST', displayName: '구매자', email: 'buyer@example.com', phoneNumber: '01012345678' },
      content: { id: contentId, title: 'HamaEditor for Mac 라이선스', type: 'DOCUMENT', paymentType: 'ONE_TIME', inputMode: 'PAYMENT_WINDOW' },
      pricing: { currency: 'KRW', originalAmount: 9900, optionDiscountAmount: 0, finalAmount: amount, couponDiscountAmount: 9900 - amount },
      paymentMethod: { type: 'CARD' },
      payment: { purchasedAt: occurredAt },
    } },
  };
}

function refunded({ merchantUid = 'm_1', amount = 9900, partial = false, refundedAt = '2026-10-17T10:00:00+09:00', occurredAt = refundedAt } = {}) {
  return {
    id: `evt_r_${merchantUid}_${refundedAt}`,
    type: 'payment.refunded',
    occurredAt,
    data: { object: {
      merchantUid,
      buyer: { email: 'buyer@example.com' },
      content: { id: 'uRshdR', paymentType: 'ONE_TIME' },
      pricing: { currency: 'KRW', originalAmount: 9900, finalAmount: 9900 },
      refund: { amount, currency: 'KRW', partialRefund: partial, cancelledBy: 'BUYER', refundedAt },
    } },
  };
}

function service(overrides = {}) {
  let clock = overrides.start ?? T0;
  const sent = [];
  const svc = createLicensesService({
    store: createMemoryStore(emptyLicensesState()),
    signingKey: parseSigningPrivateKey(PAIR.privateKeyPem),
    adminToken: ADMIN,
    now: () => clock,
    emailProvider: { name: 'test', async send(m) { sent.push(m); return { status: 'sent', providerId: 'x' }; } },
    log: () => {},
    ...overrides,
  });
  return { svc, sent, advance: (ms) => { clock += ms; }, now: () => clock };
}

// ---------------------------------------------------------------- signature

test('signature: valid current and previous signatures pass, wrong ones fail', () => {
  const raw = Buffer.from('{"a":1}');
  const ts = String(Math.floor(T0 / 1000));
  const ok = verifyGrobleWebhook({ headers: { 'x-groble-signature': grobleSignature(SECRET, ts, raw), 'x-groble-timestamp': ts }, rawBody: raw, secret: SECRET, nowMs: T0 });
  assert.equal(ok.ok, true);
  assert.equal(ok.matched, 'current');

  const rotated = verifyGrobleWebhook({
    headers: { 'x-groble-signature': grobleSignature('brand-new', ts, raw), 'x-groble-signature-previous': grobleSignature(PREVIOUS, ts, raw), 'x-groble-timestamp': ts },
    rawBody: raw, secret: SECRET, previousSecret: PREVIOUS, nowMs: T0,
  });
  assert.equal(rotated.ok, true);
  assert.equal(rotated.matched, 'previous');

  const bad = verifyGrobleWebhook({ headers: { 'x-groble-signature': grobleSignature('other', ts, raw), 'x-groble-timestamp': ts }, rawBody: raw, secret: SECRET, nowMs: T0 });
  assert.deepEqual(bad, { ok: false, reason: 'bad_signature' });

  const tampered = verifyGrobleWebhook({ headers: { 'x-groble-signature': grobleSignature(SECRET, ts, raw), 'x-groble-timestamp': ts }, rawBody: Buffer.from('{"a":2}'), secret: SECRET, nowMs: T0 });
  assert.equal(tampered.reason, 'bad_signature');

  const otherTs = verifyGrobleWebhook({ headers: { 'x-groble-signature': grobleSignature(SECRET, ts, raw), 'x-groble-timestamp': String(Number(ts) + 1) }, rawBody: raw, secret: SECRET, nowMs: T0 });
  assert.equal(otherTs.reason, 'bad_signature');

  assert.equal(verifyGrobleWebhook({ headers: {}, rawBody: raw, secret: SECRET }).reason, 'missing_headers');
  assert.equal(verifyGrobleWebhook({ headers: {}, rawBody: raw, secret: '' }).reason, 'not_configured');
  assert.equal(verifyGrobleWebhook({ headers: { 'x-groble-signature': 'zz', 'x-groble-timestamp': ts }, rawBody: raw, secret: SECRET, nowMs: T0 }).reason, 'bad_signature');
});

test('timestamp window: ±5 minutes accepted, beyond rejected', () => {
  const raw = Buffer.from('{}');
  const check = (offsetSeconds) => {
    const ts = String(Math.floor(T0 / 1000) + offsetSeconds);
    return verifyGrobleWebhook({ headers: { 'x-groble-signature': grobleSignature(SECRET, ts, raw), 'x-groble-timestamp': ts }, rawBody: raw, secret: SECRET, nowMs: T0 });
  };
  assert.equal(check(-300).ok, true);
  assert.equal(check(300).ok, true);
  assert.equal(check(-301).reason, 'timestamp_out_of_window');
  assert.equal(check(301).reason, 'timestamp_out_of_window');
  const raw2 = Buffer.from('{}');
  assert.equal(verifyGrobleWebhook({ headers: { 'x-groble-signature': grobleSignature(SECRET, 'abc', raw2), 'x-groble-timestamp': 'abc' }, rawBody: raw2, secret: SECRET }).reason, 'bad_timestamp');
});

// ------------------------------------------------------------- webhook logic

test('payment.completed issues exactly one key per merchantUid, idempotent across retries', async () => {
  const { svc, sent } = service();
  const first = await svc.handleGrobleEvent(completed(), { idempotencyKey: 'idem-1' });
  assert.equal(first.action, 'issued');
  const dup = await svc.handleGrobleEvent(completed(), { idempotencyKey: 'idem-1' });
  assert.equal(dup.duplicate, true);
  // A retry carrying a different delivery key still maps to the same merchantUid.
  const retry = await svc.handleGrobleEvent(completed(), { idempotencyKey: 'idem-2' });
  assert.equal(retry.action, 'already_issued');
  assert.equal(retry.keyId, first.keyId);

  const status = await svc.statusByRef('hama-ref-1');
  assert.equal(status.status, 'issued');
  assert.match(status.key, KEY_RE);
  assert.deepEqual(Object.keys(status).sort(), ['key', 'licenseExpiresAt', 'status']);
  assert.equal(status.licenseExpiresAt, null, 'a one-time order is a lifetime key');
  assert.deepEqual(await svc.statusByRef('unknown-ref'), { status: 'pending' });
  await assert.rejects(svc.statusByRef('bad ref!'), { code: 'ref_invalid' });

  await svc.deliverPendingEmails();
  await svc.deliverPendingEmails();
  assert.equal(sent.length, 1, 'key email goes out once');
  assert.equal(sent[0].to, 'buyer@example.com');
  assert.ok(sent[0].text.includes(status.key));
});

test('wrong product or amount is held for review, not issued', async () => {
  const { svc } = service();
  const wrong = await svc.handleGrobleEvent(completed({ merchantUid: 'm_x', contentId: 'other', ref: 'r-x' }), { idempotencyKey: 'a' });
  assert.equal(wrong.action, 'held');
  assert.deepEqual(await svc.statusByRef('r-x'), { status: 'pending' });
  const cheap = await svc.handleGrobleEvent(completed({ merchantUid: 'm_y', amount: 100, ref: 'r-y' }), { idempotencyKey: 'b' });
  assert.equal(cheap.action, 'held');
  const held = await svc.admin.orders(ADMIN, { status: 'held' });
  assert.equal(held.count, 2);
  const released = await svc.admin.release(ADMIN, { merchantUid: 'm_y' });
  assert.equal(released.created, true);
  assert.equal((await svc.statusByRef('r-y')).status, 'issued');
});

test('cancel_requested only records; full refund revokes; partial refund does not', async () => {
  const { svc } = service();
  const issued = await svc.handleGrobleEvent(completed(), { idempotencyKey: 'c1' });
  const cancel = await svc.handleGrobleEvent({ id: 'evt_cr', type: 'payment.cancel_requested', occurredAt: '2026-10-16T05:00:00+09:00', data: { object: { merchantUid: 'm_1', cancelRequest: { requestedBy: 'BUYER', requestedAt: '2026-10-16T05:00:00+09:00', detailReason: '실수로 결제했어요 죄송합니다' } } } }, { idempotencyKey: 'cr1' });
  assert.equal(cancel.action, 'cancel_request_recorded');
  assert.equal((await svc.statusByRef('hama-ref-1')).status, 'issued');

  const partial = await svc.handleGrobleEvent(refunded({ amount: 4000, partial: true, refundedAt: '2026-10-16T06:00:00+09:00' }), { idempotencyKey: 'p1' });
  assert.equal(partial.action, 'partial_refund_recorded');
  assert.equal((await svc.statusByRef('hama-ref-1')).status, 'issued');

  const full = await svc.handleGrobleEvent(refunded(), { idempotencyKey: 'r1' });
  assert.equal(full.action, 'revoked');
  assert.equal(full.keyId, issued.keyId);
  assert.deepEqual(await svc.statusByRef('hama-ref-1'), { status: 'revoked' });
  const lookup = await svc.admin.lookup(ADMIN, { merchantUid: 'm_1' });
  assert.equal(lookup.licenses[0].status, 'revoked');
  assert.equal(lookup.orders[0].cancelRequests.length, 1);
  assert.equal(lookup.orders[0].refunds.length, 2);
});

test('partial refunds that add up to the full amount revoke', async () => {
  const { svc } = service();
  await svc.handleGrobleEvent(completed(), { idempotencyKey: 'c' });
  await svc.handleGrobleEvent(refunded({ amount: 4900, partial: true, refundedAt: '2026-10-16T06:00:00+09:00' }), { idempotencyKey: 'p1' });
  const second = await svc.handleGrobleEvent(refunded({ amount: 5000, partial: true, refundedAt: '2026-10-18T06:00:00+09:00' }), { idempotencyKey: 'p2' });
  assert.equal(second.action, 'revoked');
});

test('out-of-order: a refund that arrives before its completion means no key is ever issued', async () => {
  const { svc, sent } = service();
  const early = await svc.handleGrobleEvent(refunded({ refundedAt: '2026-10-16T02:00:00+09:00' }), { idempotencyKey: 'r' });
  assert.equal(early.action, 'refund_recorded_no_key');
  const late = await svc.handleGrobleEvent(completed({ occurredAt: '2026-10-16T01:00:00+09:00' }), { idempotencyKey: 'c' });
  assert.equal(late.action, 'refunded_before_completed');
  assert.deepEqual(await svc.statusByRef('hama-ref-1'), { status: 'revoked' });
  await svc.deliverPendingEmails();
  assert.equal(sent.length, 0);
  const order = (await svc.admin.orders(ADMIN, {})).orders[0];
  assert.equal(order.lastEventAt, new Date('2026-10-16T02:00:00+09:00').toISOString(), 'lastEventAt follows occurredAt, not arrival');
});

test('unknown event types are acknowledged, ignored and flagged for review', async () => {
  const { svc } = service();
  const r = await svc.handleGrobleEvent({ id: 'e', type: 'subscription.cancel_withdrawn', data: { object: { merchantUid: 'x' } } }, { idempotencyKey: 'k' });
  assert.equal(r.action, 'ignored_event_type');
  assert.equal(r.reason, 'unknown_event_type:subscription.cancel_withdrawn');
  assert.equal(r.needsReview, true);
  const replay = await svc.handleGrobleEvent({ id: 'e', type: 'subscription.cancel_withdrawn', data: { object: { merchantUid: 'x' } } }, { idempotencyKey: 'k' });
  assert.equal(replay.duplicate, true);
});

// ---------------------------------------------------------------- devices

test('activation: 2 devices per key, re-activation is free, deactivate frees a slot, revoked blocks', async () => {
  const { svc, now } = service();
  await svc.handleGrobleEvent(completed(), { idempotencyKey: 'c' });
  const { key } = await svc.statusByRef('hama-ref-1');

  const a = await svc.activate({ key, deviceId: 'device-aaaa', appVersion: '3.1.0', platform: 'darwin' });
  assert.equal(a.ok, true);
  assert.equal(a.devicesUsed, 1);
  // Groble keys carry no tier or deviceLimit, like every record written before beta keys existed.
  assert.equal(a.tier, 'paid');
  assert.equal(a.deviceLimit, 2);
  await svc.activate({ key: key.toLowerCase().replace(/-/g, ' '), deviceId: 'device-bbbb' });
  assert.equal((await svc.activate({ key, deviceId: 'device-aaaa' })).devicesUsed, 2, 're-activating an existing device does not use a slot');
  await assert.rejects(svc.activate({ key, deviceId: 'device-cccc' }), { code: 'device_limit', status: 409 });

  const v = await svc.validate({ key, deviceId: 'device-aaaa' });
  assert.equal(verifyLease(v.lease, KEYS, { deviceId: 'device-aaaa', key, now: now() }).ok, true);
  await assert.rejects(svc.validate({ key, deviceId: 'device-cccc' }), { code: 'not_activated' });

  assert.equal((await svc.deactivate({ key, deviceId: 'device-bbbb' })).removed, true);
  assert.equal((await svc.activate({ key, deviceId: 'device-cccc' })).devicesUsed, 2);

  await assert.rejects(svc.activate({ key: 'HAMA-00000-00000-00000-00000-00000', deviceId: 'device-aaaa' }), { code: 'invalid_key', status: 404 });
  await assert.rejects(svc.activate({ key: 'nonsense', deviceId: 'device-aaaa' }), { code: 'invalid_key' });
  await assert.rejects(svc.activate({ key, deviceId: 'x' }), { code: 'device_id_invalid' });

  await svc.handleGrobleEvent(refunded(), { idempotencyKey: 'r' });
  await assert.rejects(svc.validate({ key, deviceId: 'device-aaaa' }), { code: 'revoked', status: 403 });
  await assert.rejects(svc.activate({ key, deviceId: 'device-dddd' }), { code: 'revoked' });
});

test('concurrent activations never exceed the device limit', async () => {
  const { svc } = service();
  await svc.handleGrobleEvent(completed(), { idempotencyKey: 'c' });
  const { key } = await svc.statusByRef('hama-ref-1');
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) => svc.activate({ key, deviceId: `device-${i}xxxx` })),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'device_limit'));
});

// ------------------------------------------------------------------- leases

test('lease: signed Ed25519, 7-day expiry, device-bound, tamper-evident', async () => {
  const key = parseSigningPrivateKey(PAIR.privateKeyDerBase64);
  const licenseKey = 'HAMA-ABCDE-FGHJK-MNPQR-STVWX-YZ012';
  const { lease, payload } = signLease({ keyId: 'lic_1', key: licenseKey, deviceId: 'device-aaaa', now: T0 }, key);
  assert.equal(payload.kid, 'hama-prod-1');
  assert.equal(payload.expiresAt - payload.issuedAt, 7 * 24 * 3600 * 1000);
  assert.equal(payload.keyHash, licenseKeyHash(licenseKey));
  assert.equal(verifyLease(lease, { 'hama-prod-1': PAIR.publicKeyPem }, { deviceId: 'device-aaaa', key: licenseKey, now: T0 + 1000 }).ok, true);
  assert.equal(verifyLease(lease, KEYS, { key: ` ${licenseKey.toLowerCase()} `, now: T0 }).ok, true, 'the app normalizes case and whitespace');
  assert.equal(verifyLease(lease, KEYS, { deviceId: 'device-bbbb', now: T0 }).reason, 'wrong_device');
  assert.equal(verifyLease(lease, KEYS, { key: 'HAMA-00000-00000-00000-00000-00000', now: T0 }).reason, 'wrong_key');
  assert.equal(verifyLease(lease, KEYS, { now: T0 + 7 * 24 * 3600 * 1000 }).reason, 'expired');
  assert.equal(verifyLease(lease, { 'hama-prod-2': PAIR.publicKeyRawBase64 }, { now: T0 }).reason, 'unknown_kid');
  const other = generateLeaseKeyPair();
  assert.equal(verifyLease(lease, { 'hama-prod-1': other.publicKeyRawBase64 }, { now: T0 }).reason, 'bad_signature');
  const [body, sig] = lease.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), expiresAt: payload.issuedAt + 1000 })).toString('base64url');
  assert.equal(verifyLease(`${forged}.${sig}`, KEYS, { now: T0 }).reason, 'bad_signature');
  assert.equal(verifyLease('garbage', KEYS).reason, 'malformed');
});

// -------------------------------------------------------------- grandfather

test('grandfathering: one free key per Mac install first seen before the cutoff', async () => {
  const before = '22222222-2222-4222-8222-222222222222';
  const after = '33333333-3333-4333-8333-333333333333';
  const windows = '44444444-4444-4444-8444-444444444444';
  const installs = createMemoryStore({ installs: {
    [uniqueInstallDigest(before)]: { official: true, firstSeenAt: '2026-10-01T00:00:00.000Z', os: 'darwin', arch: 'arm64' },
    [uniqueInstallDigest(after)]: { official: true, firstSeenAt: '2026-10-20T00:00:00.000Z', os: 'darwin', arch: 'arm64' },
    [uniqueInstallDigest(windows)]: { official: true, firstSeenAt: '2026-10-01T00:00:00.000Z', os: 'win32', arch: 'x64' },
  } });
  const { svc } = service({ uniqueInstallsStore: installs, grandfatherCutoff: Date.parse('2026-10-16T00:00:00+09:00') });
  const first = await svc.grandfather({ installId: before.toUpperCase() });
  assert.equal(first.created, true);
  assert.match(first.key, KEY_RE);
  const again = await svc.grandfather({ installId: before });
  assert.equal(again.created, false);
  assert.equal(again.key, first.key, 'one key per install');
  await assert.rejects(svc.grandfather({ installId: after }), { code: 'not_eligible' });
  await assert.rejects(svc.grandfather({ installId: windows }), { code: 'not_eligible' });
  await assert.rejects(svc.grandfather({ installId: '55555555-5555-4555-8555-555555555555' }), { code: 'not_eligible' });
  await assert.rejects(svc.grandfather({ installId: 'nope' }), { code: 'install_id_invalid' });
  assert.equal((await svc.activate({ key: first.key, deviceId: 'mac-device-1' })).ok, true);

  const { svc: off } = service({ uniqueInstallsStore: installs });
  await assert.rejects(off.grandfather({ installId: before }), { code: 'grandfather_disabled' });
});

// -------------------------------------------------------------------- admin

test('admin: manual backfill issue, later webhook does not duplicate, lookup, revoke, restore', async () => {
  const { svc, sent } = service();
  await assert.rejects(svc.admin.issue('wrong', {}), { code: 'forbidden' });
  await assert.rejects(createLicensesService({ adminToken: '' }).admin.issue('', {}), { code: 'forbidden' });

  const manual = await svc.admin.issue(ADMIN, { email: 'early@example.com', merchantUid: 'm_early', note: 'paid before webhook', sendEmail: true });
  assert.equal(manual.created, true);
  const again = await svc.admin.issue(ADMIN, { merchantUid: 'm_early' });
  assert.equal(again.created, false);
  assert.equal(again.license.keyId, manual.license.keyId);

  const late = await svc.handleGrobleEvent(completed({ merchantUid: 'm_early', ref: 'r-early' }), { idempotencyKey: 'late' });
  assert.equal(late.action, 'already_issued');
  assert.equal((await svc.statusByRef('r-early')).key, manual.license.key);
  await svc.deliverPendingEmails();
  assert.equal(sent.length, 1);

  const byEmail = await svc.admin.lookup(ADMIN, { email: 'EARLY@example.com' });
  assert.equal(byEmail.licenses.length, 1);
  await svc.admin.revoke(ADMIN, { key: manual.license.key, reason: 'test' });
  await assert.rejects(svc.activate({ key: manual.license.key, deviceId: 'device-aaaa' }), { code: 'revoked' });
  await svc.admin.restore(ADMIN, { keyId: manual.license.keyId });
  assert.equal((await svc.activate({ key: manual.license.key, deviceId: 'device-aaaa' })).ok, true);

  // A refund webhook for a manually backfilled order still revokes it.
  const r = await svc.handleGrobleEvent(refunded({ merchantUid: 'm_early' }), { idempotencyKey: 'rr' });
  assert.equal(r.action, 'revoked');
});

test('beta keys: per-key device limit, 3-day lease, revoke and restore, listed for the admin', async () => {
  const { svc, sent, now, advance } = service();
  await svc.admin.issue(ADMIN, { email: 'paid@example.com', sendEmail: true });
  await assert.rejects(svc.admin.issueBeta('wrong', { name: '홍길동' }), { code: 'forbidden' });
  await assert.rejects(svc.admin.betas('wrong'), { code: 'forbidden' });
  await assert.rejects(svc.admin.issueBeta(ADMIN, {}), { code: 'name_required' });
  await assert.rejects(svc.admin.issueBeta(ADMIN, { name: 'x', devices: 'many' }), { code: 'devices_invalid' });
  assert.equal((await svc.admin.issueBeta(ADMIN, { name: 'x' })).license.deviceLimit, 5);
  assert.equal((await svc.admin.issueBeta(ADMIN, { name: 'x', devices: 99 })).license.deviceLimit, 50);
  assert.equal((await svc.admin.issueBeta(ADMIN, { name: 'x', devices: '0' })).license.deviceLimit, 1);

  const issued = await svc.admin.issueBeta(ADMIN, { name: '홍길동', email: 'tester@example.com', devices: 3 });
  const { key, keyId, tier, name } = issued.license;
  assert.match(key, KEY_RE);
  assert.deepEqual({ tier, name }, { tier: 'beta', name: '홍길동' });

  for (const [i, platform] of ['darwin', 'win32', 'darwin'].entries()) {
    const r = await svc.activate({ key, deviceId: `beta-device-${i}`, platform });
    assert.deepEqual({ tier: r.tier, devicesUsed: r.devicesUsed, deviceLimit: r.deviceLimit }, { tier: 'beta', devicesUsed: i + 1, deviceLimit: 3 });
    const lease = verifyLease(r.lease, KEYS, { deviceId: `beta-device-${i}`, key, now: now() });
    assert.equal(lease.payload.expiresAt - lease.payload.issuedAt, 3 * 24 * 3600 * 1000);
  }
  await assert.rejects(svc.activate({ key, deviceId: 'beta-device-3' }), { code: 'device_limit', status: 409 });

  const list = await svc.admin.betas(ADMIN);
  const entry = list.betas.find((b) => b.keyId === keyId);
  assert.equal(entry.devicesUsed, 3);
  assert.deepEqual(entry.devices.map((d) => d.platform), ['darwin', 'win32', 'darwin']);
  assert.equal(list.count, 4, 'the paid key is not listed');

  await svc.deliverPendingEmails();
  assert.deepEqual(sent.map((m) => m.to), ['paid@example.com'], 'beta keys are never emailed');

  await svc.admin.revoke(ADMIN, { key, reason: 'beta over' });
  await assert.rejects(svc.validate({ key, deviceId: 'beta-device-0' }), { code: 'revoked', status: 403, tier: 'beta' });
  await svc.admin.restore(ADMIN, { key });
  advance(1000);
  assert.equal((await svc.validate({ key, deviceId: 'beta-device-0' })).ok, true);
});

test('normalizeLicenseKey tolerates case, spaces and O/I look-alikes', () => {
  assert.equal(normalizeLicenseKey('hama abcde fghjk mnpqr stvwx yz012'), 'HAMA-ABCDE-FGHJK-MNPQR-STVWX-YZ012');
  assert.equal(normalizeLicenseKey('HAMA-OOOOO-IIIII-LLLLL-00000-11111'), 'HAMA-00000-11111-11111-00000-11111');
  assert.equal(normalizeLicenseKey('HAMA-UUUUU-00000-00000-00000-00000'), '');
  assert.equal(normalizeLicenseKey(42), '');
  assert.equal(normalizeLicenseKey('HAMAB-CDEFG-HJKMN-PQRST-VWXYZ'), 'HAMA-HAMAB-CDEFG-HJKMN-PQRST-VWXYZ', 'a key body that starts with HAMA keeps it');
});

test('a lease issued for a key typed loosely still verifies against what the app sent', async () => {
  const { svc, now } = service();
  await svc.handleGrobleEvent(completed(), { idempotencyKey: 'c' });
  const { key } = await svc.statusByRef('hama-ref-1');
  const typed = ` ${key.toLowerCase()} `;
  const a = await svc.activate({ key: typed, deviceId: 'device-aaaa' });
  assert.equal(verifyLease(a.lease, KEYS, { deviceId: 'device-aaaa', key: typed, now: now() }).ok, true);
  assert.equal(verifyLease(a.lease, KEYS, { deviceId: 'device-aaaa', key, now: now() }).ok, true);
});

test('a later order cannot take over another buyer\'s ref', async () => {
  const { svc } = service();
  await svc.handleGrobleEvent(completed({ merchantUid: 'm_victim', ref: 'shared-ref' }), { idempotencyKey: 'a' });
  const victimKey = (await svc.statusByRef('shared-ref')).key;
  await svc.handleGrobleEvent(completed({ merchantUid: 'm_other', ref: 'shared-ref' }), { idempotencyKey: 'b' });
  assert.equal((await svc.statusByRef('shared-ref')).key, victimKey);
  await assert.rejects(svc.admin.issue(ADMIN, { ref: 'shared-ref' }), { code: 'ref_taken' });
});

test('overlapping email deliveries send each key once', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sent = [];
  const { svc } = service({
    emailProvider: { name: 'test', async send(m) { sent.push(m.to); await gate; return { status: 'sent' }; } },
  });
  await svc.handleGrobleEvent(completed(), { idempotencyKey: 'c' });
  const first = svc.deliverPendingEmails();
  const second = svc.deliverPendingEmails();
  release();
  await Promise.all([first, second]);
  assert.equal(sent.length, 1);
});

test('email: no RESEND_API_KEY logs and skips without failing', async () => {
  const { createEmailProvider } = await import('../license-email.mjs');
  const provider = createEmailProvider({});
  assert.equal(provider.name, 'log');
  const { svc } = service({ emailProvider: { name: 'log', async send() { return { status: 'skipped' }; } } });
  await svc.handleGrobleEvent(completed(), { idempotencyKey: 'c' });
  const [result] = await svc.deliverPendingEmails();
  assert.equal(result.status, 'skipped');
  const lookup = await svc.admin.lookup(ADMIN, { merchantUid: 'm_1' });
  assert.equal(lookup.licenses[0].emailDelivery.status, 'skipped');
});

// ------------------------------------------------------------ HTTP end to end

async function tempDir(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-lic-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function listen(t, env, options = {}) {
  const server = createSiteServer(env, { log: () => {}, emailProvider: { name: 'test', async send() { return { status: 'sent' }; } }, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function signedPost(origin, event, { secret = SECRET, ts = Math.floor(Date.now() / 1000), idem = `idem-${Math.random()}` } = {}) {
  const raw = JSON.stringify(event);
  return fetch(`${origin}/v1/groble/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Groble-Signature': grobleSignature(secret, String(ts), raw),
      'X-Groble-Timestamp': String(ts),
      'X-Groble-Idempotency-Key': idem,
    },
    body: raw,
    redirect: 'manual',
  });
}

test('HTTP: webhook → by-ref → activate → validate, with CORS, persistence and admin auth', async (t) => {
  const directory = await tempDir(t);
  const env = {
    RAU_SITE_DATA: directory,
    GROBLE_WEBHOOK_SECRET: SECRET,
    LICENSE_SIGNING_PRIVATE_KEY: PAIR.privateKeyDerBase64,
    ADMIN_TOKEN: ADMIN,
  };
  const origin = await listen(t, env);

  const forged = await signedPost(origin, completed(), { secret: 'attacker' });
  assert.equal(forged.status, 503);
  const stale = await signedPost(origin, completed(), { ts: Math.floor(Date.now() / 1000) - 600 });
  assert.equal(stale.status, 401);

  const ok = await signedPost(origin, completed(), { idem: 'same' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).action, 'issued');
  const dup = await signedPost(origin, completed(), { idem: 'same' });
  assert.equal(dup.status, 200);
  assert.equal((await dup.json()).duplicate, true);

  const byRef = await fetch(`${origin}/v1/license/by-ref?ref=hama-ref-1`, { headers: { Origin: 'https://heemangstudios.com' } });
  assert.equal(byRef.headers.get('access-control-allow-origin'), 'https://heemangstudios.com');
  const body = await byRef.json();
  assert.equal(body.status, 'issued');
  assert.ok(!JSON.stringify(body).includes('buyer@example.com'));
  const evil = await fetch(`${origin}/v1/license/by-ref?ref=hama-ref-1`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const preflight = await fetch(`${origin}/v1/license/by-ref`, { method: 'OPTIONS', headers: { Origin: 'https://heemangstudio.github.io' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://heemangstudio.github.io');

  const act = await fetch(`${origin}/v1/license/activate`, { method: 'POST', body: JSON.stringify({ key: body.key, deviceId: 'mac-0001', appVersion: '3.1.0', platform: 'darwin' }) });
  const actBody = await act.json();
  assert.equal(act.status, 200);
  const pub = await (await fetch(`${origin}/v1/license/public-key`)).json();
  assert.equal(pub.spkiDerBase64, PAIR.publicKeyDerBase64);
  assert.equal(pub.kid, 'hama-prod-1');
  assert.equal(pub.rawBase64, PAIR.publicKeyRawBase64);
  assert.equal(verifyLease(actBody.lease, { [pub.kid]: pub.rawBase64 }, { deviceId: 'mac-0001', key: body.key }).ok, true);

  await fetch(`${origin}/v1/license/activate`, { method: 'POST', body: JSON.stringify({ key: body.key, deviceId: 'mac-0002' }) });
  const third = await fetch(`${origin}/v1/license/activate`, { method: 'POST', body: JSON.stringify({ key: body.key, deviceId: 'mac-0003' }) });
  assert.equal(third.status, 409);
  assert.deepEqual(await third.json(), { ok: false, error: 'device_limit' });
  const invalid = await fetch(`${origin}/v1/license/validate`, { method: 'POST', body: JSON.stringify({ key: 'HAMA-00000-00000-00000-00000-00000', deviceId: 'mac-0001' }) });
  assert.deepEqual(await invalid.json(), { ok: false, error: 'invalid_key' });

  const noAuth = await fetch(`${origin}/v1/admin/licenses?merchantUid=m_1`);
  assert.equal(noAuth.status, 403);
  const withAuth = await fetch(`${origin}/v1/admin/licenses?merchantUid=m_1`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  assert.equal((await withAuth.json()).licenses[0].devices.length, 2);

  // Refund over HTTP revokes, and the data survives a restart.
  assert.equal((await (await signedPost(origin, refunded())).json()).action, 'revoked');
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'licenses.json'), 'utf8'));
  assert.equal(Object.values(saved.licenses)[0].status, 'revoked');
  const origin2 = await listen(t, env);
  const after = await fetch(`${origin2}/v1/license/validate`, { method: 'POST', body: JSON.stringify({ key: body.key, deviceId: 'mac-0001' }) });
  assert.deepEqual(await after.json(), { ok: false, error: 'revoked', tier: 'paid' });

  // Existing endpoints still work alongside.
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  assert.equal((await fetch(`${origin}/v1/unique-installs`)).status, 200);
});

test('HTTP: beta keys are issued and listed only with the admin token', async (t) => {
  const directory = await tempDir(t);
  const origin = await listen(t, { RAU_SITE_DATA: directory, LICENSE_SIGNING_PRIVATE_KEY: PAIR.privateKeyDerBase64, ADMIN_TOKEN: ADMIN });
  const post = (headers) => fetch(`${origin}/v1/admin/licenses/issue-beta`, { method: 'POST', headers, body: JSON.stringify({ name: '홍길동', devices: 3 }) });
  assert.equal((await post({})).status, 403);
  assert.equal((await fetch(`${origin}/v1/admin/licenses/betas`)).status, 403);
  const issued = await (await post({ Authorization: `Bearer ${ADMIN}` })).json();
  assert.equal(issued.license.deviceLimit, 3);
  const listed = await (await fetch(`${origin}/v1/admin/licenses/betas`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json();
  assert.equal(listed.betas[0].key, issued.license.key);
  const act = await (await fetch(`${origin}/v1/license/activate`, { method: 'POST', body: JSON.stringify({ key: issued.license.key, deviceId: 'win-0001', platform: 'win32' }) })).json();
  assert.deepEqual({ tier: act.tier, deviceLimit: act.deviceLimit }, { tier: 'beta', deviceLimit: 3 });
});

test('HTTP: webhook without a configured secret answers 503 (Groble retries), never 3xx/410', async (t) => {
  const directory = await tempDir(t);
  const origin = await listen(t, { RAU_SITE_DATA: directory });
  const res = await signedPost(origin, completed());
  assert.equal(res.status, 503);
  const activate = await fetch(`${origin}/v1/license/activate`, { method: 'POST', body: JSON.stringify({ key: 'HAMA-00000-00000-00000-00000-00000', deviceId: 'mac-0001' }) });
  assert.equal(activate.status, 503);
});

test('file store: concurrent webhook deliveries for different orders are all persisted', async (t) => {
  const directory = await tempDir(t);
  const store = createFileStore(path.join(directory, 'licenses.json'), { emptyState: emptyLicensesState });
  const { svc } = service({ store });
  await Promise.all(Array.from({ length: 25 }, (_, i) => svc.handleGrobleEvent(completed({ merchantUid: `m_${i}`, ref: `ref-${i}` }), { idempotencyKey: `k${i}` })));
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'licenses.json'), 'utf8'));
  assert.equal(Object.keys(saved.licenses).length, 25);
  assert.equal(Object.keys(saved.orders).length, 25);
  const leftovers = (await fs.readdir(directory)).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});
