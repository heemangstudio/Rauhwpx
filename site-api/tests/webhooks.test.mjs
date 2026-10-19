import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { EMAIL_ASSET_BASE } from '../email-layout.mjs';
import { grobleSignature } from '../groble-webhook.mjs';
import { createSiteServer } from '../server.mjs';
import { createWebhookAlerter, webhookAlertEmail } from '../webhook-alert.mjs';
import { createWebhookLog, redactWebhookHeaders } from '../webhook-log.mjs';

const SECRET = 'whsec_test_current';
const ADMIN = 'admin-token-for-webhook-tests';
const CLI = fileURLToPath(new URL('../scripts/license-admin.mjs', import.meta.url));
const WEBSITE = fileURLToPath(new URL('../../website/', import.meta.url));

function completed({ merchantUid = 'm_1', originalAmount = 9900 } = {}) {
  return {
    id: `evt_${merchantUid}`,
    type: 'payment.completed',
    occurredAt: '2026-10-16T01:00:00+09:00',
    data: { object: {
      merchantUid,
      sellerReference: `ref-${merchantUid}`,
      buyer: { email: 'buyer@example.com' },
      content: { id: 'uRshdR', paymentType: 'ONE_TIME' },
      pricing: { currency: 'KRW', originalAmount, finalAmount: 9900 },
    } },
  };
}

function alertSink({ send } = {}) {
  const sent = [];
  return {
    sent,
    provider: { name: 'test', async send(message) { sent.push(message); return send ? send(message) : { status: 'sent' }; } },
  };
}

async function listen(t, env = {}, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-wh-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const logs = [];
  const server = createSiteServer(
    { RAU_SITE_DATA: directory, GROBLE_WEBHOOK_SECRET: SECRET, ADMIN_TOKEN: ADMIN, ...env },
    {
      log: (line) => logs.push(line),
      emailProvider: { name: 'test', async send() { return { status: 'sent' }; } },
      alertProvider: null,
      ...options,
    },
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { origin: `http://127.0.0.1:${server.address().port}`, directory, logs };
}

function post(origin, body, { secret = SECRET, ts = Math.floor(Date.now() / 1000), idem = `idem-${Math.random()}`, headers = {}, sign = true } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return fetch(`${origin}/v1/groble/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(sign ? {
        'X-Groble-Signature': grobleSignature(secret, String(ts), raw),
        'X-Groble-Timestamp': String(ts),
        'X-Groble-Idempotency-Key': idem,
      } : {}),
      ...headers,
    },
    body: raw,
  });
}

async function webhooks(origin, query = '') {
  const res = await fetch(`${origin}/v1/admin/webhooks${query}`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  assert.equal(res.status, 200);
  return (await res.json()).entries;
}

async function waitFor(fn, label) {
  for (let i = 0; i < 100; i += 1) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('bad signature answers 503 so Groble retries, and is recorded and alerted without secrets', async (t) => {
  const alerts = alertSink();
  const { origin } = await listen(t, {}, { alertProvider: alerts.provider });
  const res = await post(origin, completed(), { secret: 'rotated-in-groble', idem: 'idem-bad', ts: 1_800_000_000 });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, error: 'bad_signature' });

  const [entry] = await waitFor(() => webhooks(origin, '?kind=rejected').then((e) => e.length && e), 'record');
  assert.equal(entry.reason, 'bad_signature');
  assert.equal(entry.status, 503);
  assert.equal(entry.verified, false);
  assert.equal(entry.timestamp, '1800000000');
  assert.equal(entry.idempotencyKey, 'idem-bad');
  assert.equal(entry.eventType, 'payment.completed');
  assert.equal(entry.merchantUid, 'm_1');
  assert.ok(Date.parse(entry.at));
  assert.equal(entry.headers['x-groble-signature'], undefined);
  assert.equal(entry.headers['x-groble-timestamp'], '1800000000');

  await waitFor(() => alerts.sent.length, 'alert');
  const [mail] = alerts.sent;
  assert.equal(mail.to, 'management@heemangstudios.com');
  assert.match(mail.subject, /bad_signature/);
  assert.ok(mail.html.includes('>bad_signature</p>'), 'reason sits in the card');
  assert.ok(mail.html.includes('KST · 503'));
  const signature = grobleSignature('rotated-in-groble', '1800000000', JSON.stringify(completed()));
  for (const part of [mail.html, mail.text]) {
    assert.ok(!part.includes(signature) && !part.includes(SECRET) && !part.includes('buyer@example.com'));
  }
});

test('missing secret and missing headers answer 503 and are recorded', async (t) => {
  const unconfigured = await listen(t, { GROBLE_WEBHOOK_SECRET: '' });
  assert.equal((await post(unconfigured.origin, completed())).status, 503);
  assert.equal((await fetch(`${unconfigured.origin}/v1/groble/webhook`)).status, 503);
  const [notConfigured] = await waitFor(() => webhooks(unconfigured.origin).then((e) => e.length && e), 'record');
  assert.equal(notConfigured.reason, 'not_configured');
  await waitFor(() => unconfigured.logs.some((l) => l.includes('webhook alert skipped (RESEND_API_KEY not set): not_configured')), 'skip log');

  const { origin } = await listen(t);
  assert.equal((await fetch(`${origin}/v1/groble/webhook`)).status, 200);
  const res = await post(origin, completed(), { sign: false });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'missing_headers');
  const [missing] = await waitFor(() => webhooks(origin).then((e) => e.length && e), 'record');
  assert.equal(missing.reason, 'missing_headers');
  assert.equal(missing.timestamp, undefined);
});

test('a stale timestamp stays final (401) and a malformed signed body stays 400; both are recorded', async (t) => {
  const { origin } = await listen(t);
  const stale = await post(origin, completed({ merchantUid: 'm_stale' }), { ts: Math.floor(Date.now() / 1000) - 600 });
  assert.equal(stale.status, 401);
  assert.equal((await stale.json()).error, 'timestamp_out_of_window');
  assert.equal((await post(origin, '{not json')).status, 400);
  const notObject = await post(origin, '[]');
  assert.equal(notObject.status, 400);
  assert.equal((await notObject.json()).error, 'payload_invalid');

  const entries = await waitFor(() => webhooks(origin).then((e) => e.length === 3 && e), 'records');
  assert.deepEqual(entries.map((e) => [e.reason, e.status, e.verified]), [
    ['payload_invalid', 400, true],
    ['json_invalid', 400, true],
    ['timestamp_out_of_window', 401, true],
  ]);
  assert.equal(entries[2].merchantUid, 'm_stale');
});

test('an oversized body answers 503 and is recorded', async (t) => {
  const { origin } = await listen(t);
  const res = await post(origin, 'x'.repeat(300 * 1024), { sign: false });
  assert.equal(res.status, 503);
  const [entry] = await waitFor(() => webhooks(origin).then((e) => e.length && e), 'record');
  assert.equal(entry.reason, 'body_too_large');
});

test('every held order is recorded and emailed once; replays and re-deliveries are not emailed again', async (t) => {
  const alerts = alertSink();
  const { origin } = await listen(t, {}, { alertProvider: alerts.provider });
  const ok = await post(origin, completed({ merchantUid: 'm_ok' }));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).action, 'issued');
  const status = await (await fetch(`${origin}/v1/license/by-ref?ref=ref-m_ok`)).json();
  assert.equal(status.status, 'issued');

  const held = await post(origin, completed({ merchantUid: 'm_held', originalAmount: 1000 }), { idem: 'idem-held' });
  assert.equal(held.status, 200);
  assert.equal((await held.json()).action, 'held');
  const [entry] = await waitFor(() => webhooks(origin, '?kind=held').then((e) => e.length && e), 'held record');
  assert.equal(entry.reason, 'wrong_price:1000');
  assert.equal(entry.merchantUid, 'm_held');
  assert.equal(entry.idempotencyKey, 'idem-held');
  assert.deepEqual([entry.action, entry.buyerEmail, entry.amount], ['held', 'buyer@example.com', 9900]);
  assert.deepEqual(await webhooks(origin, '?kind=rejected'), []);

  await waitFor(() => alerts.sent.length === 1, 'held alert');
  const [mail] = alerts.sent;
  assert.equal(mail.to, 'management@heemangstudios.com');
  assert.equal(mail.subject, '[HamaEditor] 주문 보류: m_held');
  for (const part of [mail.html, mail.text]) {
    for (const fact of ['buyer@example.com', 'm_held', '9,900원', 'KST', '1,000원']) assert.ok(part.includes(fact), fact);
    assert.ok(!part.includes(SECRET) && !part.includes('idem-held') && !part.includes('sellerReference'));
  }

  // The same delivery again (deduped) and the same order under a new delivery key: no new email.
  assert.equal((await (await post(origin, completed({ merchantUid: 'm_held', originalAmount: 1000 }), { idem: 'idem-held' })).json()).duplicate, true);
  await post(origin, completed({ merchantUid: 'm_held', originalAmount: 1000 }), { idem: 'idem-held-again' });
  await waitFor(() => webhooks(origin, '?kind=held').then((e) => e.length === 2), 'second held record');
  // A different held order right after still gets its own email.
  await post(origin, completed({ merchantUid: 'm_held_2', originalAmount: 1000 }));
  await waitFor(() => alerts.sent.length === 2, 'second order alert');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(alerts.sent.map((m) => m.subject), ['[HamaEditor] 주문 보류: m_held', '[HamaEditor] 주문 보류: m_held_2']);
  assert.notEqual(alerts.sent[0].idempotencyKey, alerts.sent[1].idempotencyKey);
});

function renewal({ merchantUid, ref = 'hama-unknown', email = 'annual@example.com' }) {
  return {
    id: `evt_${merchantUid}`,
    type: 'subscription_payment.completed',
    occurredAt: '2027-10-20T10:00:00+09:00',
    data: { object: {
      merchantUid,
      sellerReference: ref,
      buyer: { email },
      content: { id: 'GLJFC9', paymentType: 'SUBSCRIPTION' },
      pricing: { currency: 'KRW', originalAmount: 9900, finalAmount: 9900 },
      payment: { purchasedAt: '2027-10-20T10:00:00+09:00' },
      subscription: { billingReason: 'RENEWAL', currentRound: 2 },
    } },
  };
}

test('dashboard attention: held orders until released or applied, other held events until acknowledged, across a restart', async (t) => {
  const first = await listen(t);
  const admin = (path, body) => fetch(`${first.origin}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${ADMIN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (res) => ({ status: res.status, json: await res.json() }));
  assert.equal((await fetch(`${first.origin}/v1/admin/attention`, { headers: { Authorization: 'Bearer nope' } })).status, 403);
  assert.equal((await fetch(`${first.origin}/v1/admin/licenses/customers`)).status, 403);

  const annual = (await admin('/v1/admin/licenses/issue', { email: 'annual@example.com', years: 1 })).json.license;
  await post(first.origin, completed({ merchantUid: 'm_price', originalAmount: 1000 }));
  await post(first.origin, renewal({ merchantUid: 'sub_r2' }));
  await post(first.origin, { id: 'evt_odd', type: 'payment.mystery', occurredAt: '2026-10-16T01:00:00+09:00', data: { object: { merchantUid: 'm_odd' } } });
  await waitFor(() => webhooks(first.origin, '?kind=held').then((e) => e.length === 3), 'held records');

  const items = (await admin('/v1/admin/attention')).json.items;
  const byKind = Object.fromEntries(items.map((i) => [i.orderKind ?? i.type, i]));
  assert.equal(items.length, 3, 'a held order is listed once, as the order');
  assert.deepEqual([byKind.purchase.merchantUid, byKind.purchase.email, byKind.purchase.amount], ['m_price', 'buyer@example.com', 9900]);
  assert.match(byKind.purchase.reasonText, /1,000원/);
  assert.deepEqual(byKind.renewal.candidates.map((c) => c.keyId), [annual.keyId]);
  assert.equal(byKind.event.reason, 'unknown_event_type:payment.mystery');

  assert.equal((await admin('/v1/admin/orders/release', { merchantUid: 'm_price' })).json.created, true);
  const applied = (await admin('/v1/admin/orders/apply-renewal', { merchantUid: 'sub_r2', keyId: annual.keyId })).json;
  assert.ok(applied.license.expiresAt > annual.expiresAt, 'the renewal round extended the existing key');
  assert.equal((await admin('/v1/admin/orders/apply-renewal', { merchantUid: 'sub_r2', keyId: annual.keyId })).json.changed, false);
  assert.deepEqual((await admin('/v1/admin/attention')).json.items.map((i) => i.type), ['event']);
  assert.equal((await admin('/v1/admin/attention/ack', { id: byKind.event.id })).status, 200);
  assert.equal((await admin('/v1/admin/attention/ack', { id: 'wh_missing' })).json.error, 'event_not_found');
  assert.equal((await admin('/v1/admin/attention')).json.count, 0);

  // A held order the owner will not release can be acknowledged too; a restart keeps every dismissal.
  await post(first.origin, completed({ merchantUid: 'm_skip', originalAmount: 1 }));
  await waitFor(() => admin('/v1/admin/attention').then((r) => r.json.count === 1), 'second held order');
  assert.equal((await admin('/v1/admin/attention/ack', { merchantUid: 'm_skip' })).status, 200);
  const second = await listen(t, { RAU_SITE_DATA: first.directory });
  const res = await fetch(`${second.origin}/v1/admin/attention`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  assert.equal((await res.json()).count, 0);
});

test('a hanging or failing alert never delays or breaks the webhook response', async (t) => {
  const hanging = { name: 'test', send: () => new Promise(() => {}) };
  const { origin } = await listen(t, {}, { alertProvider: hanging });
  const res = await post(origin, completed(), { secret: 'wrong' });
  assert.equal(res.status, 503);

  const throwing = await listen(t, {}, { alertProvider: { name: 'test', async send() { throw new Error('resend down'); } } });
  assert.equal((await post(throwing.origin, completed(), { secret: 'wrong' })).status, 503);
  await waitFor(() => throwing.logs.some((l) => l.includes('webhook alert failed for bad_signature: resend down')), 'failure log');
  assert.equal((await post(throwing.origin, completed())).status, 200);
});

test('rejections past the per-IP budget get 429 and are not recorded', async (t) => {
  const { origin } = await listen(t);
  for (let i = 0; i < 30; i += 1) assert.equal((await post(origin, completed(), { secret: 'wrong' })).status, 503);
  assert.equal((await post(origin, completed(), { secret: 'wrong' })).status, 429);
  await waitFor(() => webhooks(origin, '?limit=200').then((e) => e.length === 30), '30 records');
  // Valid deliveries are not throttled by the rejection budget.
  assert.equal((await post(origin, completed())).status, 200);
});

test('alerts: one email per reason per 15 minutes, with the suppressed count in the next one', async () => {
  let clock = Date.parse('2026-10-16T05:00:00Z');
  const alerts = alertSink();
  const alerter = createWebhookAlerter({ provider: alerts.provider, now: () => clock, log: () => {} });
  const at = new Date(clock).toISOString();
  assert.equal((await alerter.notify({ reason: 'bad_signature', status: 503, at })).status, 'sent');
  assert.equal((await alerter.notify({ reason: 'bad_signature', status: 503, at })).status, 'suppressed');
  assert.equal((await alerter.notify({ reason: 'bad_signature', status: 503, at })).status, 'suppressed');
  assert.equal((await alerter.notify({ reason: 'not_configured', status: 503, at })).status, 'sent');
  clock += 15 * 60 * 1000;
  assert.equal((await alerter.notify({ reason: 'bad_signature', status: 503, at })).status, 'sent');
  assert.equal(alerts.sent.length, 3);
  assert.ok(!alerts.sent[0].text.includes('번 더'));
  assert.ok(alerts.sent[2].text.includes('같은 이유가 2번 더 있었어요.'));

  const logs = [];
  const silent = createWebhookAlerter({ provider: null, log: (l) => logs.push(l) });
  assert.equal((await silent.notify({ reason: 'bad_signature', status: 503, at })).status, 'skipped');
  assert.equal(logs.length, 1);
});

test('alert email: final rejections point to the CLI, and every image ships with website/', () => {
  const { subject, html } = webhookAlertEmail({ reason: 'timestamp_out_of_window', status: 401, at: '2026-10-16T05:03:22Z' });
  assert.equal(subject, '[HamaEditor] Groble 웹훅 거부: timestamp_out_of_window');
  assert.ok(html.includes('2026-10-16 14:03:22 KST · 401'));
  assert.ok(html.includes('Groble은 다시 보내지 않아요.'));
  const images = [...html.matchAll(/(?:src|background)="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(images)].sort(), ['banner.png', 'card-stars.png'].map((f) => EMAIL_ASSET_BASE + f));
  for (const url of images) assert.ok(existsSync(`${WEBSITE}assets/email/${url.slice(EMAIL_ASSET_BASE.length)}`));
});

test('webhook log keeps the newest entries within its bound and strips signatures and credentials', async () => {
  const log = createWebhookLog({ maxEntries: 3 });
  for (let i = 0; i < 5; i += 1) await log.record({ kind: i % 2 ? 'held' : 'rejected', reason: `r${i}` });
  const all = await log.list();
  assert.deepEqual(all.entries.map((e) => e.reason), ['r4', 'r3', 'r2']);
  assert.deepEqual((await log.list({ kind: 'held' })).entries.map((e) => e.reason), ['r3']);

  const headers = redactWebhookHeaders({
    'x-groble-signature': 'a'.repeat(64),
    'x-groble-signature-previous': 'b'.repeat(64),
    authorization: 'Bearer x',
    cookie: 'c=1',
    'x-groble-timestamp': '1',
    'x-long': 'y'.repeat(5000),
  });
  assert.deepEqual(Object.keys(headers), ['x-groble-timestamp', 'x-long']);
  assert.equal(headers['x-long'].length, 200);
});

test('CLI: webhooks --rejected and --held list the recorded webhooks with the admin token', async (t) => {
  const { origin } = await listen(t);
  await post(origin, completed({ merchantUid: 'm_forged' }), { secret: 'wrong' });
  await post(origin, completed({ merchantUid: 'm_held', originalAmount: 1 }));
  await waitFor(() => webhooks(origin).then((e) => e.length === 2), 'records');

  const run = (...args) => promisify(execFile)(process.execPath, [CLI, 'webhooks', ...args], {
    env: { ...process.env, SITE_API_BASE: origin, ADMIN_TOKEN: ADMIN },
  });
  const parse = (stdout) => {
    assert.match(stdout, /^200 \{/);
    return JSON.parse(stdout.slice(4));
  };
  const rejected = parse((await run('--rejected')).stdout);
  assert.deepEqual(rejected.entries.map((e) => [e.kind, e.reason, e.merchantUid]), [['rejected', 'bad_signature', 'm_forged']]);
  const held = parse((await run('--held')).stdout);
  assert.deepEqual(held.entries.map((e) => [e.kind, e.merchantUid]), [['held', 'm_held']]);
  assert.equal(parse((await run()).stdout).count, 2);

  const denied = await fetch(`${origin}/v1/admin/webhooks`, { headers: { Authorization: 'Bearer nope' } });
  assert.equal(denied.status, 403);
});
