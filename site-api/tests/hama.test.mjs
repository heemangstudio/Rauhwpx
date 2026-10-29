import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveHamaConfig } from '../config.mjs';
import { createHamaService, emptyHamaState } from '../hama.mjs';
import {
  HOUR, MINUTE, admission, billingPeriod, costFromUsage, normalizeLedger, record, windows,
} from '../hama-ledger.mjs';
import { licenseError } from '../licenses.mjs';
import { generateLeaseKeyPair } from '../license-lease.mjs';
import { createSiteServer } from '../server.mjs';
import { createFileStore } from '../store.mjs';

const ADMIN = 'admin-token-for-hama-tests';
const PAIR = generateLeaseKeyPair();
const T0 = Date.parse('2026-10-30T10:00:00.000Z');
// $15 a month → cap_5h $3, cap_week $7.50, cap_month $15.
const CONFIG = resolveHamaConfig({ HAMA_ENABLED: 'true' });
const PLAN = { status: 'active', allowanceUsd: 15, periodAnchor: '2026-10-01T00:00:00.000Z' };
const iso = (ms) => new Date(ms).toISOString();

function ledgerWith(calls) {
  const entry = normalizeLedger({});
  for (const [at, costUsd, id] of calls) record(entry, { id, costUsd, at }, PLAN);
  return entry;
}

async function tempDir(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-hama-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  return directory;
}

/** A service on a file store with a movable clock; leases are `lease:<keyId>`. */
function service(directory, clock) {
  return createHamaService({
    store: createFileStore(path.join(directory, 'hama.json'), { emptyState: emptyHamaState }),
    authenticate: async (lease) => {
      const match = /^lease:(.+)$/.exec(String(lease));
      if (!match) throw licenseError('unauthorized', 401);
      return { keyId: match[1], deviceId: 'device-a' };
    },
    config: CONFIG,
    adminToken: ADMIN,
    now: () => clock.now,
    log: () => {},
    usageLogDir: path.join(directory, 'hama-usage'),
  });
}

test('5-hour cap: exactly at the limit blocks, one cent under admits', () => {
  assert.equal(admission(ledgerWith([[T0, 2.99, 'a']]), PLAN, CONFIG, T0), null);
  const atCap = ledgerWith([[T0, 2.99, 'a'], [T0 + 1000, 0.01, 'b']]);
  assert.deepEqual(admission(atCap, PLAN, CONFIG, T0 + 2000), { cap: 'cap_5h', resetsAt: T0 + MINUTE + 5 * HOUR });
  const caps = windows(atCap, PLAN, CONFIG, T0 + 2000);
  assert.deepEqual(caps.cap_5h, { usedUsd: 3, limitUsd: 3, resetsAt: T0 + MINUTE + 5 * HOUR });
  assert.equal(caps.cap_week.resetsAt, null);
});

test('spend leaves the 5-hour window minute by minute, and resetsAt is the first admitted instant', () => {
  // $0.50 in each of six minutes = $3.00, at the cap.
  const entry = ledgerWith([0, 1, 2, 3, 4, 5].map((m) => [T0 + m * MINUTE + 30_000, 0.5, `m${m}`]));
  const now = T0 + 6 * MINUTE;
  const blocked = admission(entry, PLAN, CONFIG, now);
  // The oldest minute bucket ends at T0+1min, so it counts until T0+1min+5h.
  assert.deepEqual(blocked, { cap: 'cap_5h', resetsAt: T0 + MINUTE + 5 * HOUR });
  assert.notEqual(admission(entry, PLAN, CONFIG, blocked.resetsAt - 1), null);
  assert.equal(admission(entry, PLAN, CONFIG, blocked.resetsAt), null);
  // Never under-counts: until the bucket's end + 5h, a call in that minute is still in the window.
  for (let m = 0; m <= 6; m += 1) {
    const used = windows(entry, PLAN, CONFIG, T0 + 5 * HOUR + m * MINUTE + MINUTE).cap_5h.usedUsd;
    assert.equal(used, Math.max(0, 3 - 0.5 * (m + 1)), `minute ${m}`);
  }
});

test('weekly cap ages out of the 7-day window by hour, and blocks with its own resetsAt', () => {
  const day = 24 * HOUR;
  // $2.50 on three days = $7.50, the weekly cap; the 5-hour cap is never hit.
  const entry = ledgerWith([[T0, 2.5, 'd0'], [T0 + day, 2.5, 'd1'], [T0 + 2 * day, 2.5, 'd2']]);
  const now = T0 + 2 * day + MINUTE;
  const expected = T0 + HOUR + 7 * day; // first hour bucket's end + 7 days
  assert.deepEqual(admission(entry, PLAN, CONFIG, now), { cap: 'cap_week', resetsAt: expected });
  assert.equal(windows(entry, PLAN, CONFIG, now).cap_week.resetsAt, expected);
  assert.equal(windows(entry, PLAN, CONFIG, expected - 1).cap_week.usedUsd, 7.5);
  assert.equal(windows(entry, PLAN, CONFIG, expected).cap_week.usedUsd, 5);
  assert.equal(admission(entry, PLAN, CONFIG, expected), null);
});

test('when several caps block, the one that frees up last is reported', () => {
  // $15 blocks all three: 5h frees first, the month on Nov 1, the week only on Nov 6.
  const entry = ledgerWith([[T0, 15, 'all']]);
  const blocked = admission(entry, PLAN, CONFIG, T0 + MINUTE);
  assert.deepEqual(blocked, { cap: 'cap_week', resetsAt: T0 + HOUR + 7 * 24 * HOUR });
  const caps = windows(entry, PLAN, CONFIG, T0 + MINUTE);
  assert.equal(caps.cap_month.resetsAt, Date.parse('2026-11-01T00:00:00.000Z'));
  assert.equal(caps.cap_5h.resetsAt, T0 + MINUTE + 5 * HOUR);
});

test('cheap models pass the 5-hour and weekly caps but not the monthly one', () => {
  const capped = ledgerWith([[T0, 7.5, 'x']]);
  assert.equal(admission(capped, PLAN, CONFIG, T0 + MINUTE).cap, 'cap_week');
  assert.equal(admission(capped, PLAN, CONFIG, T0 + MINUTE, { cheap: true }), null);
  const spent = ledgerWith([[T0, 7.5, 'x'], [T0 + 1000, 7.5, 'y']]);
  assert.deepEqual(admission(spent, PLAN, CONFIG, T0 + MINUTE, { cheap: true }),
    { cap: 'cap_month', resetsAt: Date.parse('2026-11-01T00:00:00.000Z') });
});

test('billing periods follow the anchor day, clamped to short months, across leap years', () => {
  const anchor = '2027-01-31T09:00:00.000Z';
  const period = (now) => {
    const p = billingPeriod(anchor, Date.parse(now));
    return [iso(p.start), iso(p.end)];
  };
  assert.deepEqual(period('2027-02-15T00:00:00Z'), ['2027-01-31T09:00:00.000Z', '2027-02-28T09:00:00.000Z']);
  assert.deepEqual(period('2027-02-28T09:00:00Z'), ['2027-02-28T09:00:00.000Z', '2027-03-31T09:00:00.000Z']);
  assert.deepEqual(period('2028-02-10T00:00:00Z'), ['2028-01-31T09:00:00.000Z', '2028-02-29T09:00:00.000Z']);
  assert.deepEqual(period('2027-12-31T08:59:59.999Z'), ['2027-11-30T09:00:00.000Z', '2027-12-31T09:00:00.000Z']);
  assert.deepEqual(period('2027-12-31T09:00:00Z'), ['2027-12-31T09:00:00.000Z', '2028-01-31T09:00:00.000Z']);

  // Spend of the old period does not count after rollover.
  const plan = { ...PLAN, periodAnchor: anchor };
  const entry = normalizeLedger({});
  record(entry, { id: 'feb', costUsd: 15, at: Date.parse('2027-02-27T00:00:00Z') }, plan);
  const before = windows(entry, plan, CONFIG, Date.parse('2027-02-28T08:59:59.999Z'));
  assert.equal(before.cap_month.usedUsd, 15);
  assert.equal(before.cap_month.resetsAt, Date.parse('2027-02-28T09:00:00.000Z'));
  assert.equal(windows(entry, plan, CONFIG, Date.parse('2027-02-28T09:00:00Z')).cap_month.usedUsd, 0);
});

test('a repeated call id is billed once and ids are bounded', () => {
  const entry = normalizeLedger({});
  assert.equal(record(entry, { id: 'msg_1', costUsd: 1, at: T0 }, PLAN).duplicate, false);
  assert.equal(record(entry, { id: 'msg_1', costUsd: 1, at: T0 + 1000 }, PLAN).duplicate, true);
  assert.equal(windows(entry, PLAN, CONFIG, T0 + 2000).cap_5h.usedUsd, 1);
  for (let i = 0; i < 600; i += 1) record(entry, { id: `msg_x${i}`, costUsd: 0, at: T0 + i }, PLAN);
  assert.equal(Object.keys(entry.ids).length, 500);
  assert.equal(entry.calls, 601);
});

test('cost: list prices per token kind, and the long-context rate past 100K prompt tokens', () => {
  assert.equal(costFromUsage({ inputTokens: 100_000 }), 0.01);
  assert.equal(costFromUsage({ outputTokens: 1_000_000 }), 0.5);
  assert.equal(costFromUsage({ cacheReadTokens: 100_000 }), 0.001);
  assert.equal(costFromUsage({ cacheWrite5mTokens: 100_000 }), 0.0125);
  assert.equal(costFromUsage({ cacheWrite1hTokens: 100_000 }), 0.02);
  assert.equal(costFromUsage({ inputTokens: 100_000, outputTokens: 1000 }), 0.0105);
  // 100_001 prompt tokens (input + cache read): every rate × 5 ($0.0075005, kept to the micro-dollar).
  assert.equal(costFromUsage({ inputTokens: 1, cacheReadTokens: 100_000, outputTokens: 1000 }), 0.007501);
});

test('service: status shape, idempotent recording across a restart, usage log and admin views', async (t) => {
  const directory = await tempDir(t);
  const clock = { now: T0 };
  let hama = service(directory, clock);

  await assert.rejects(hama.status('nope'), { code: 'unauthorized', status: 401 });
  await assert.rejects(hama.status('lease:lic_a'), { code: 'hama_not_enrolled', status: 403 });
  await assert.rejects(hama.admin.enroll('wrong', { keyId: 'lic_a' }), { code: 'forbidden' });
  await hama.admin.enroll(ADMIN, { keyId: 'lic_a', periodAnchor: '2026-10-15T00:00:00Z' });

  const fresh = await hama.status('lease:lic_a');
  assert.deepEqual(fresh, {
    ok: true,
    plan: { status: 'active', allowanceUsd: 15, periodStart: '2026-10-15T00:00:00.000Z', periodEnd: '2026-11-15T00:00:00.000Z' },
    caps: {
      cap_5h: { usedUsd: 0, limitUsd: 3, resetsAt: null },
      cap_week: { usedUsd: 0, limitUsd: 7.5, resetsAt: null },
      cap_month: { usedUsd: 0, limitUsd: 15, resetsAt: '2026-11-15T00:00:00.000Z' },
    },
    blocked: null,
    models: {
      default: 'anthropic/claude-haiku-5.5',
      claude: ['anthropic/claude-haiku-5.5'],
      cheap: ['deepseek/deepseek-v4.1-flash', 'qwen/qwen3.8-flash'],
      maxOutputTokens: 16000,
    },
    endpoints: { anthropic: '/v1/hama/anthropic', openai: '/v1/hama/openrouter' },
  });

  const call = { id: 'msg_dup', route: 'anthropic', provider: 'anthropic', model: 'claude-haiku-5-5', inputTokens: 10, outputTokens: 5, costUsd: 3, costSource: 'price_table' };
  assert.deepEqual(await hama.record('lic_a', call), { duplicate: false, costUsd: 3 });
  // A restart reads the same file: the id is still known.
  hama = service(directory, clock);
  assert.deepEqual(await hama.record('lic_a', call), { duplicate: true });

  clock.now = T0 + MINUTE;
  const capped = await hama.status('lease:lic_a');
  assert.equal(capped.caps.cap_5h.usedUsd, 3);
  assert.deepEqual(capped.blocked, { cap: 'cap_5h', resetsAt: iso(T0 + MINUTE + 5 * HOUR), cheapAvailable: true });
  assert.deepEqual(await hama.admit('lease:lic_a'), { keyId: 'lic_a', deviceId: 'device-a', refusal: { cap: 'cap_5h', resetsAt: iso(T0 + MINUTE + 5 * HOUR) } });
  assert.equal((await hama.admit('lease:lic_a', { cheap: true })).refusal, null);

  const usage = await hama.admin.usage(ADMIN, { keyId: 'lic_a' });
  assert.equal(usage.entries.length, 1);
  assert.deepEqual(usage.entries[0], {
    at: iso(T0), id: 'msg_dup', route: 'anthropic', provider: 'anthropic', model: 'claude-haiku-5-5',
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 3, costSource: 'price_table',
  });
  assert.equal(usage.plan.totalUsd, 3);
  assert.equal(usage.plan.calls, 1);

  // A per-key allowance raises every cap; disabling ends access but keeps the ledger.
  await hama.admin.enroll(ADMIN, { keyId: 'lic_a', allowanceUsd: '30' });
  assert.equal((await hama.status('lease:lic_a')).blocked, null);
  const listed = await hama.admin.list(ADMIN);
  assert.equal(listed.count, 1);
  assert.equal(listed.plans[0].caps.cap_5h.limitUsd, 6);
  assert.equal(listed.plans[0].periodAnchor, '2026-10-15T00:00:00.000Z');
  await hama.admin.disable(ADMIN, { keyId: 'lic_a' });
  await assert.rejects(hama.status('lease:lic_a'), { code: 'hama_not_enrolled', status: 403 });
  await assert.rejects(hama.admin.enroll(ADMIN, { keyId: 'lic_a', allowanceUsd: -1 }), { code: 'allowance_invalid' });
  await assert.rejects(hama.admin.disable(ADMIN, { keyId: 'lic_none' }), { code: 'hama_not_found' });
});

test('config: hosted Claude cannot be widened through env, and bad values fail at startup', () => {
  assert.equal(resolveHamaConfig({}).enabled, false);
  assert.throws(() => resolveHamaConfig({ HAMA_CHEAP_MODELS: 'deepseek/deepseek-v4.1-flash,anthropic/claude-sonnet-5.5' }), /Claude/);
  assert.throws(() => resolveHamaConfig({ HAMA_CAP_5H_PCT: '0' }), /HAMA_CAP_5H_PCT/);
  assert.throws(() => resolveHamaConfig({ HAMA_ENABLED: 'maybe' }), /HAMA_ENABLED/);
  assert.throws(() => resolveHamaConfig({ HAMA_PRICES: '{"inputPerMTok":-1}' }), /HAMA_PRICES/);
  assert.deepEqual(resolveHamaConfig({ HAMA_PRICES: '{"inputPerMTok":0.2}' }).prices, { inputPerMTok: 0.2 });
});

test('HTTP: status needs a lease on an enrolled key, admin enrolls only existing licenses, 404 when off', async (t) => {
  const directory = await tempDir(t);
  const start = async (env) => {
    const server = createSiteServer({ RAU_SITE_DATA: directory, LICENSE_SIGNING_PRIVATE_KEY: PAIR.privateKeyDerBase64, ADMIN_TOKEN: ADMIN, ...env },
      { log: () => {}, emailProvider: null });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections?.(); return new Promise((resolve) => server.close(resolve)); });
    return `http://127.0.0.1:${server.address().port}`;
  };
  const off = await start({});
  assert.equal((await fetch(`${off}/v1/hama/status`)).status, 404);
  assert.equal((await fetch(`${off}/v1/admin/hama`, { headers: { Authorization: `Bearer ${ADMIN}` } })).status, 404);

  const origin = await start({ HAMA_ENABLED: 'true' });
  const post = (route, body, headers = {}) => fetch(`${origin}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const admin = (route, body) => post(route, body, { Authorization: `Bearer ${ADMIN}` });
  const { license } = await (await admin('/v1/admin/licenses/issue', { note: 'hama test' })).json();
  const { lease } = await (await post('/v1/license/activate', { key: license.key, deviceId: 'device-mac-aaaaaaaa', appVersion: '2.1.0', platform: 'darwin' })).json();

  const unauthorized = await fetch(`${origin}/v1/hama/status`, { headers: { Authorization: 'Bearer not-a-lease' } });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { ok: false, error: 'unauthorized' });
  const notEnrolled = await fetch(`${origin}/v1/hama/status`, { headers: { Authorization: `Bearer ${lease}` } });
  assert.equal(notEnrolled.status, 403);
  assert.deepEqual(await notEnrolled.json(), { ok: false, error: 'hama_not_enrolled' });

  assert.equal((await admin('/v1/admin/hama/enroll', { keyId: 'lic_missing' })).status, 404);
  assert.equal((await post('/v1/admin/hama/enroll', { keyId: license.keyId }, { Authorization: 'Bearer wrong' })).status, 403);
  const enrolled = await (await admin('/v1/admin/hama/enroll', { keyId: license.keyId })).json();
  assert.equal(enrolled.plan.status, 'active');

  // Pi's Anthropic client sends the lease as x-api-key.
  const status = await fetch(`${origin}/v1/hama/status`, { headers: { 'x-api-key': lease } });
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(body.plan.allowanceUsd, 15);
  assert.equal(body.models.default, 'anthropic/claude-haiku-5.5');

  const listed = await (await fetch(`${origin}/v1/admin/hama`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json();
  assert.equal(listed.plans[0].keyId, license.keyId);
  const usage = await fetch(`${origin}/v1/admin/hama/usage?keyId=${license.keyId}`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  assert.deepEqual((await usage.json()).entries, []);
  await admin('/v1/admin/hama/disable', { keyId: license.keyId });
  assert.equal((await fetch(`${origin}/v1/hama/status`, { headers: { 'x-api-key': lease } })).status, 403);
});
