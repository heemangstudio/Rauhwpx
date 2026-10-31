import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createHamaService, emptyHamaState } from '../hama.mjs';
import { createFileUsageLog, createPostgresUsageLog } from '../hama-usage.mjs';
import { licenseError } from '../licenses.mjs';
import { hamaMapper } from '../mappers/hama.mjs';
import { createPostgresStore } from '../pg-store.mjs';
import { createMemoryStore } from '../store.mjs';
import { differential, storedAndReloaded } from './helpers/differential.mjs';
import { postgresSuite } from './helpers/postgres.mjs';

const pgSuite = postgresSuite();
const ADMIN = 'admin-token-for-pg-hama';
const T0 = Date.parse('2026-10-31T09:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// lease → who, as accounts.authenticateLease answers for the hama purpose.
const LEASES = {
  admin: { keyId: 'lic_admin', deviceId: 'dev-a', edition: 'basic' },
  paid: { keyId: 'lic_paid', deviceId: 'dev-b', edition: 'hama' },
  stranger: { keyId: 'lic_stranger', deviceId: 'dev-c', edition: 'basic' },
};

async function tempDir(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-pg-hama-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  return directory;
}

function world(store, usageLog, clock, subscriptions) {
  const hama = createHamaService({
    store,
    usageLog,
    authenticate: async (lease) => {
      if (!Object.hasOwn(LEASES, lease)) throw licenseError('unauthorized', 401);
      return LEASES[lease];
    },
    subscriptions: async () => structuredClone(subscriptions.list),
    config: { allowanceUsd: 1, cap5hPct: 20, capWeekPct: 50, capMonthPct: 100, cheapModels: ['deepseek/deepseek-v4.1-flash'] },
    adminToken: ADMIN,
    now: () => clock.now,
    log: () => {},
  });
  return { stores: { hama: store }, hama };
}

const orderOf = (_name, state) => ({ plans: Object.keys(state.plans), ledgers: Object.keys(state.ledgers) });

test('Hama on Postgres answers and stores exactly what the memory store does, usage log included, and reloads to the same state', async (t) => {
  const db = pgSuite.db(t);
  if (!db) return;
  await pgSuite.reset();
  const clock = { now: T0 };
  const subscriptions = { list: [] };
  const fileLog = createFileUsageLog(await tempDir(t));
  const worlds = {
    memory: world(createMemoryStore(emptyHamaState()), fileLog, clock, subscriptions),
    postgres: world(createPostgresStore({ db, mapper: hamaMapper }), createPostgresUsageLog(db), clock, subscriptions),
  };
  const step = differential(worlds, { orderOf });
  const admin = (name, body) => (w) => w.hama.admin[name](ADMIN, body);
  const call = (keyId, fields) => (w) => w.hama.record(keyId, {
    route: 'anthropic', provider: 'anthropic', model: 'claude-haiku-5-5', inputTokens: 1200, outputTokens: 300, costSource: 'tokens', ...fields,
  });

  // Not enrolled, then an admin enrollment with an override and a default one.
  assert.equal((await step('status before enrollment', (w) => w.hama.status('admin'))).error.code, 'hama_not_enrolled');
  assert.equal((await step('bad lease', (w) => w.hama.status('nobody'))).error.code, 'unauthorized');
  await step('enroll with override', admin('enroll', { keyId: 'lic_admin', allowanceUsd: '2.5', periodAnchor: '2026-10-15T00:00:00+09:00' }));
  await step('enroll default', admin('enroll', { keyId: 'lic_other' }));
  await step('enroll invalid', admin('enroll', { keyId: 'lic_other', allowanceUsd: 0 }));
  await step('status', (w) => w.hama.status('admin'));

  // Billed calls: a repeated id is not counted or logged twice; a call without an id always counts.
  await step('call 1', call('lic_admin', { id: 'msg_1', costUsd: 0.12 }));
  assert.equal((await step('call 1 again', call('lic_admin', { id: 'msg_1', costUsd: 0.12 }))).value.duplicate, true);
  clock.now += 60_000;
  await step('call without id', call('lic_admin', { costUsd: 0.000000123, inputTokens: 3.5, route: null }));
  await step('call 2', call('lic_admin', { id: 'msg_2', costUsd: 0.4, at: clock.now - 1000, provider: 'openrouter' }));
  // The 5-hour cap ($0.50 of $2.50) is now spent: Claude waits, cheap models still run.
  const { value: blocked } = await step('status at the cap', (w) => w.hama.status('admin'));
  assert.equal(blocked.blocked.cap, 'cap_5h');
  assert.notEqual((await step('admit claude', (w) => w.hama.admit('admin'))).value.refusal, null);
  assert.equal((await step('admit cheap', (w) => w.hama.admit('admin', { cheap: true }))).value.refusal, null);
  await step('call for a key without a plan', call('lic_stranger', { id: 'gen-x', costUsd: 0.01 }));
  await step('summary', (w) => w.hama.usageSummary('lic_admin'));
  await step('plan active', (w) => w.hama.planActive('lic_admin'));

  // Usage log: newest first, the admin limit, and a key with no entries.
  const { value: usage } = await step('usage', admin('usage', { keyId: 'lic_admin' }));
  assert.deepEqual(usage.entries.map((e) => e.id), ['msg_2', null, 'msg_1']);
  assert.deepEqual((await step('usage limit', admin('usage', { keyId: 'lic_admin', limit: '2' }))).value.entries.map((e) => e.id), ['msg_2', null]);
  await step('usage of a stranger', admin('usage', { keyId: 'lic_stranger' }));
  await step('usage unknown', admin('usage', { keyId: 'lic_none' }));

  // Six hours later the 5-hour window frees up and old minute buckets are pruned on the next call.
  clock.now += 6 * HOUR;
  await step('status after the window', (w) => w.hama.status('admin'));
  await step('call 3', call('lic_admin', { id: 'msg_3', costUsd: 0.05 }));

  // A paid Hama key: principal() syncs it in, a lapsed subscription ends it, a live one lifts it again.
  subscriptions.list = [{ keyId: 'lic_paid', live: true, periodAnchor: '2026-10-20T05:22:11.000Z' }];
  assert.equal((await step('paid key status', (w) => w.hama.status('paid'))).value.plan.status, 'active');
  subscriptions.list[0].live = false;
  await step('subscription ended', (w) => w.hama.syncSubscriptions());
  assert.equal((await step('ended key status', (w) => w.hama.status('paid'))).error.code, 'hama_not_enrolled');
  clock.now += DAY;
  subscriptions.list[0].live = true;
  assert.equal((await step('renewed key status', (w) => w.hama.status('paid'))).value.plan.status, 'active');

  // Admin disable stays through a sync; enrolling lifts it and keeps the anchor and override.
  await step('disable', admin('disable', { keyId: 'lic_admin' }));
  await step('disable again', admin('disable', { keyId: 'lic_admin' }));
  await step('disable unknown', admin('disable', { keyId: 'lic_none' }));
  await step('sync keeps it', (w) => w.hama.syncSubscriptions());
  await step('disabled summary', (w) => w.hama.usageSummary('lic_admin'));
  await step('re-enroll', admin('enroll', { keyId: 'lic_admin', allowanceUsd: null }));
  // A new billing period resets the month's spend.
  clock.now = Date.parse('2026-11-16T00:00:00.000Z');
  await step('call in a new period', call('lic_admin', { id: 'msg_4', costUsd: 0.2 }));
  assert.equal((await step('new period summary', (w) => w.hama.usageSummary('lic_admin'))).value.calls, 1);
  await step('list', admin('list', {}));
  await step('list disabled', admin('list', { status: 'disabled' }));

  // A fresh process loads exactly the state the first one holds, and reads the same usage log.
  const fresh = createPostgresStore({ db, mapper: hamaMapper });
  assert.deepStrictEqual(await fresh.read(), await worlds.postgres.stores.hama.read());
  assert.deepStrictEqual(await createPostgresUsageLog(db).read('lic_admin', 1000), await fileLog.read('lic_admin', 1000));
});

test('Hama usage log on Postgres keeps every entry exactly, misfits and nulls included', async (t) => {
  const db = pgSuite.db(t);
  if (!db) return;
  await pgSuite.reset();
  const file = createFileUsageLog(await tempDir(t));
  const rows = createPostgresUsageLog(db);
  const entries = [
    { at: '2026-10-31T00:00:00.000Z', id: 'msg_a', route: 'anthropic', provider: 'anthropic', model: 'claude-haiku-5-5', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.000001, costSource: 'tokens' },
    { at: '2026-10-31T00:00:01.000Z', id: null, route: null, provider: null, model: null, inputTokens: 1.5, outputTokens: -0, cacheReadTokens: 3e12, cacheWriteTokens: 0, costUsd: 0, costSource: null },
    { at: 'not a time', id: 'nul\u0000id', route: { odd: true }, extra: [1, 2], costUsd: 1e-9 },
  ];
  for (const entry of entries) {
    await file.append('lic_a', entry);
    await rows.append('lic_a', entry);
  }
  await file.append('lic_b', entries[0]);
  await rows.append('lic_b', entries[0]);
  for (const limit of [1, 2, 3, 100]) assert.deepStrictEqual(await rows.read('lic_a', limit), await file.read('lic_a', limit));
  assert.deepStrictEqual(await rows.read('lic_b', 100), [entries[0]]);
  assert.deepStrictEqual(await rows.read('lic_none', 100), []);
});

test('Hama mapper keeps legacy and odd records losslessly, also through Postgres', async (t) => {
  const legacy = {
    plans: {
      lic_a: { status: 'active', allowanceUsd: null, periodAnchor: '2026-10-15T00:00:00+09:00', enrolledAt: '2026-10-15T00:00:00.000Z' },
      lic_b: { status: 'disabled', allowanceUsd: '3', disabledReason: 'admin', note: { by: 'owner' } },
    },
    ledgers: {
      lic_a: { minutes: { 29871234: 0.1 }, hours: {}, ids: { msg_1: T0 }, period: null, totalUsd: 0.1, calls: 1, lastCallAt: null },
      lic_c: { minutes: [], calls: 2.5 },
    },
  };
  const rows = hamaMapper.toRows(legacy);
  assert.deepStrictEqual(hamaMapper.fromRows(JSON.parse(JSON.stringify(rows))), legacy);
  assert.throws(() => hamaMapper.toRows({ ...legacy, extra: {} }), { code: 'store_misfit' });
  assert.throws(() => hamaMapper.toRows({ plans: { lic_a: 'active' }, ledgers: {} }), { code: 'store_misfit' });

  const db = pgSuite.db(t);
  if (!db) return;
  await pgSuite.reset();
  const reloaded = await storedAndReloaded(db, hamaMapper, legacy);
  assert.deepStrictEqual(reloaded, legacy);
  assert.deepStrictEqual(orderOf('hama', reloaded), orderOf('hama', legacy));
});
