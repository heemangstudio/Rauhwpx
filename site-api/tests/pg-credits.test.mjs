import assert from 'node:assert/strict';
import test from 'node:test';

import { createGiftsService, emptyGiftsState } from '../gifts.mjs';
import { licenseError } from '../licenses.mjs';
import { giftsMapper } from '../mappers/gifts.mjs';
import { rauMapper } from '../mappers/rau.mjs';
import { createPostgresStore } from '../pg-store.mjs';
import { createRauService, emptyRauState } from '../rau.mjs';
import { createMemoryStore } from '../store.mjs';
import { createFakeOpenRouter } from './fixtures/fake-openrouter.mjs';
import { differential, seededRandom, storedAndReloaded } from './helpers/differential.mjs';
import { postgresSuite } from './helpers/postgres.mjs';

const pgSuite = postgresSuite();
const ADMIN = 'admin-token-for-pg-credits';
const PROVISIONING = 'pk-test-pg-credits';
const T0 = Date.parse('2026-10-31T09:00:00.000Z');
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** One fake OpenRouter per world, handing out the same key hashes and keys. */
async function fakeOpenRouter(t) {
  const upstream = createFakeOpenRouter({ provisioningKey: PROVISIONING, random: seededRandom('openrouter') });
  const apiBase = await upstream.listen();
  t.after(() => upstream.close());
  return { upstream, apiBase };
}

const authenticateFrom = (leases) => async (lease) => {
  if (!Object.hasOwn(leases, lease)) throw licenseError('unauthorized', 401);
  return structuredClone(leases[lease]);
};

// rau.json as the earlier Rau-0.1 left it: per-license OpenRouter keys, never read or changed again.
const LEGACY_RAU = {
  allowances: {
    lic_a: { keyId: 'lic_a', status: 'provisioning', name: 'hama-rau-lic_a', capUsd: 2, period: '2026-10', ledger: {}, startedAt: '2026-10-31T00:00:00.000Z' },
    lic_b: { keyId: 'lic_b', status: 'active', capUsd: '2', ledger: { '2026-09': 0.5, '2026-10': 'x' }, createdAt: 'yesterday', lastUsedAt: null, openrouterKey: 'sk-or-v1-test' },
  },
};

test('hosted Rau on Postgres answers and stores exactly what the memory store does, keeps an old allowances map untouched, and reloads to the same state', async (t) => {
  const db = pgSuite.db(t);
  if (!db) return;
  await pgSuite.reset();
  const clock = { now: T0 };
  const iso = (ms) => new Date(ms).toISOString();
  // lease → principal, as accounts.authenticateLease answers with withRau.
  const leases = {
    plan: { keyId: 'lic_rau', deviceId: 'dev-a', active: true, rau: { source: 'plan', ledgerId: 'lic_rau', anchor: '2026-10-20T05:22:11.000Z' } },
    trial: { keyId: null, deviceId: 'dev-b', active: false, accountId: 'acct_trial', rau: { source: 'trial', ledgerId: 'acct_trial', startedAt: iso(T0 - DAY), endsAt: iso(T0 + 6 * DAY) } },
    hama: { keyId: 'lic_hama', deviceId: 'dev-c', active: true, rau: null },
  };
  // The next learn call's cost, and fields of its billing record to override (id, model, route).
  const next = { costUsd: 0.25, call: {} };
  function world(store) {
    let n = 0;
    const upstream = {
      configured: true,
      routes: [{ id: 'openrouter-haiku', model: 'haiku', via: 'openrouter' }],
      async complete() {
        n += 1;
        return { text: '{"ops":[]}', call: { id: `msg_${n}`, model: 'haiku', route: 'openrouter', inputTokens: 1200, outputTokens: 80, cacheReadTokens: 3e9, cacheWriteTokens: 0, costUsd: next.costUsd, ...next.call } };
      },
    };
    const rau = createRauService({ store, authenticate: authenticateFrom(leases), upstream, config: { allowanceUsd: 8 }, adminToken: ADMIN, now: () => clock.now, log: () => {} });
    return { stores: { rau: store }, rau };
  }
  await storedAndReloaded(db, rauMapper, LEGACY_RAU);
  const worlds = {
    memory: world(createMemoryStore(structuredClone(LEGACY_RAU))),
    postgres: world(createPostgresStore({ db, mapper: rauMapper })),
  };
  const orderOf = (_name, state) => [Object.keys(state.allowances ?? {}), Object.keys(state.ledgers ?? {}), Object.keys(state.spend ?? {})];
  const step = differential(worlds, { orderOf });
  const learn = (lease, prompt = 'Rau-0.1 prompt') => (w) => w.rau.learn(lease, Buffer.from(JSON.stringify({ prompt })));
  /** One learn call billed with `call` as its record's id, model and route. */
  const learnAs = (lease, call) => (w) => {
    next.call = call;
    return learn(lease)(w).finally(() => { next.call = {}; });
  };

  assert.deepEqual((await step('status before any call', (w) => w.rau.status('plan'))).value.usedUsd, 0);
  assert.equal((await step('not eligible', (w) => w.rau.status('hama'))).value.eligible, false);
  assert.equal((await step('learn without Rau', learn('hama'))).error.code, 'rau_plan_required');
  assert.equal((await step('bad prompt', (w) => w.rau.learn('plan', Buffer.from('{"prompt":""}')))).error.code, 'invalid');
  assert.equal((await step('first learn', learn('plan'))).value.text, '{"ops":[]}');
  clock.now += MINUTE;
  next.costUsd = 0.4;
  const billedOnce = (await step('learn with an id', learnAs('plan', { id: 'msg_same_1', model: 'haiku', route: 'anthropic' }))).value.usage.usedUsd;
  assert.equal((await step('the same id again', learnAs('plan', { id: 'msg_same_1', model: 'haiku', route: 'anthropic' }))).value.usage.usedUsd, billedOnce, 'billed once');
  next.costUsd = 0.000000123;
  await step('learn without id', learnAs('plan', { id: undefined, model: undefined, route: null }));
  await step('status', (w) => w.rau.status('plan'));
  await step('usage', (w) => w.rau.usage(leases.plan.rau));

  // The trial spends its $2, then is refused for credits (not for its plan) until its end.
  next.costUsd = 1.5;
  await step('trial learn', learn('trial'));
  next.costUsd = 0.6;
  await step('trial learn over', learn('trial'));
  assert.equal((await step('trial exhausted', learn('trial'))).error.code, 'rau_credits_exhausted');
  clock.now = T0 + 7 * DAY;
  assert.equal((await step('trial over', (w) => w.rau.status('trial'))).value.eligible, false);

  // Weeks and months go by: a new billing month, one call a week until old weeks are pruned (26 kept).
  next.costUsd = 0.01;
  for (let week = 0; week < 28; week += 1) {
    clock.now = T0 + 7 * DAY + week * 7 * DAY;
    await step(`week ${week}`, learnAs('plan', { id: `msg_w${week}`, model: week % 3 ? 'haiku' : 'deepseek', route: week % 2 ? 'openrouter' : 'anthropic' }));
  }
  await step('learn later', learn('plan'));
  await step('admin list', (w) => w.rau.admin.list(ADMIN));
  await step('admin spend', (w) => w.rau.admin.spend(ADMIN, { weeks: '26' }));
  assert.equal((await step('admin spend invalid', (w) => w.rau.admin.spend(ADMIN, { weeks: 27 }))).error.code, 'weeks_invalid');
  assert.equal((await step('admin list forbidden', (w) => w.rau.admin.list('nope'))).error.code, 'forbidden');

  const fresh = await createPostgresStore({ db, mapper: rauMapper }).read();
  assert.deepStrictEqual(fresh, await worlds.postgres.stores.rau.read());
  assert.deepStrictEqual(fresh.allowances, LEGACY_RAU.allowances, 'the old allowances are left as they were');
  assert.equal(Object.keys(fresh.spend).length, 26);
  assert.deepEqual(Object.keys(fresh.ledgers), ['lic_rau', 'acct_trial']);
  const { rows } = await db.query('SELECT max(cache_read_tokens) AS most FROM rau_spend');
  assert.ok(rows[0].most > 2 ** 31, 'token counts past int4 stay in their column');
});

test('gift credits on Postgres answer and store exactly what the memory store does, and reload to the same state', async (t) => {
  const db = pgSuite.db(t);
  if (!db) return;
  await pgSuite.reset();
  const clock = { now: T0 };
  const leases = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((n) => [n, { keyId: `lic_${n}`, deviceId: `dev-${n}`, tier: 'beta', platform: 'darwin', source: 'own-key' }]));
  leases.paid = { keyId: 'lic_paid', deviceId: 'dev-p', tier: 'paid', platform: 'darwin' };
  async function world(store) {
    const { upstream, apiBase } = await fakeOpenRouter(t);
    const gifts = createGiftsService({
      store,
      authenticate: authenticateFrom(leases),
      config: { provisioningKey: PROVISIONING, eventId: 'beta-2026', amountUsd: 20, totalBudgetUsd: 50, apiBase },
      adminToken: ADMIN,
      now: () => clock.now,
      log: () => {},
    });
    return { stores: { gifts: store }, gifts, upstream };
  }
  const worlds = {
    memory: await world(createMemoryStore(emptyGiftsState())),
    postgres: await world(createPostgresStore({ db, mapper: giftsMapper })),
  };
  const orderOf = (_name, state) => Object.entries(state.events).map(([id, ev]) => [id, Object.keys(ev.grants ?? {}), Object.keys(ev.allocations ?? {})]);
  const step = differential(worlds, { orderOf });
  const both = (fn) => { fn(worlds.memory.upstream); fn(worlds.postgres.upstream); };
  const admin = (name, body) => (w) => w.gifts.admin[name](ADMIN, body);

  await step('status unclaimed', (w) => w.gifts.status('a'));
  assert.equal((await step('paid key', (w) => w.gifts.claim('paid'))).error.code, 'not_eligible');
  // A refused create leaves the event with empty maps, which must survive as they are.
  both((u) => u.failNextCreate(400));
  assert.equal((await step('create refused', (w) => w.gifts.claim('a'))).error.code, 'upstream_unavailable');
  assert.equal((await step('claim', (w) => w.gifts.claim('a'))).value.created, true);
  assert.equal((await step('claim again', (w) => w.gifts.claim('a'))).value.created, false);
  await step('status claimed', (w) => w.gifts.status('a'));
  // Amounts: an allocation before the claim, 0 for no gift, a live limit change, one past the budget.
  await step('allocate b', admin('setAmount', { keyId: 'lic_b', amountUsd: '12.345' }));
  await step('allocate c to zero', admin('setAmount', { keyId: 'lic_c', amountUsd: 0 }));
  assert.equal((await step('c not eligible', (w) => w.gifts.claim('c'))).error.code, 'not_eligible');
  await step('claim b', (w) => w.gifts.claim('b'));
  await step('lower a', admin('setAmount', { keyId: 'lic_a', amountUsd: 5 }));
  assert.equal((await step('over budget', admin('setAmount', { keyId: 'lic_a', amountUsd: 40 }))).error.code, 'budget_exhausted');
  both((u) => u.failNextPatch(400));
  assert.equal((await step('patch refused', admin('setAmount', { keyId: 'lic_a', amountUsd: 6 }))).error.code, 'upstream_unavailable');
  await step('claim d', (w) => w.gifts.claim('d'));
  assert.equal((await step('budget exhausted', (w) => w.gifts.claim('e'))).error.code, 'budget_exhausted');
  // Disable: the key is turned off upstream and the grant is revoked.
  await step('disable a', admin('disable', { keyId: 'lic_a', reason: 'abuse' }));
  await step('disable a again', admin('disable', { keyId: 'lic_a' }));
  assert.equal((await step('disable unknown', admin('disable', { keyId: 'lic_none' }))).error.code, 'gift_not_found');
  await step('status revoked', (w) => w.gifts.status('a'));
  await step('amount of a revoked gift', admin('setAmount', { keyId: 'lic_a', amountUsd: 1 }));
  await step('list', admin('list', {}));
  await step('list active', admin('list', { status: 'active' }));
  await step('betas', (w) => w.gifts.admin.withGifts(ADMIN, { betas: [{ keyId: 'lic_a' }, { keyId: 'lic_b' }, { keyId: 'lic_c' }] }));
  assert.deepEqual(worlds.memory.upstream.calls.map((c) => `${c.method} ${c.path}`), worlds.postgres.upstream.calls.map((c) => `${c.method} ${c.path}`));

  const fresh = createPostgresStore({ db, mapper: giftsMapper });
  assert.deepStrictEqual(await fresh.read(), await worlds.postgres.stores.gifts.read());
});

test('gift and Rau mappers keep legacy shapes losslessly, also through Postgres, and refuse what they cannot hold', async (t) => {
  const gifts = {
    events: {
      // Written before per-license amounts: no allocations map at all.
      'beta-old': { grants: { lic_a: { keyId: 'lic_a', status: 'active', limitUsd: 20, claimedAt: '2026-10-18T10:00:00+09:00', openrouterKey: 'sk-or-v1-test' } } },
      'beta-2026': { grants: {}, allocations: { lic_b: 12.35, lic_c: '7', lic_d: null }, note: 'kept' },
      'odd': { grants: [], allocations: null },
      'bare': {},
    },
  };
  assert.deepStrictEqual(giftsMapper.fromRows(JSON.parse(JSON.stringify(giftsMapper.toRows(gifts)))), gifts);
  assert.throws(() => giftsMapper.toRows({ events: { e: { grants: { lic_a: { keyId: 'lic_b' } } } } }), { code: 'store_misfit' });
  assert.throws(() => giftsMapper.toRows({ events: { e: 'x' } }), { code: 'store_misfit' });

  const rau = structuredClone(LEGACY_RAU);
  // What the current service writes over it, odd records included: a NUL, a time that is not canonical, a count past int4.
  const current = {
    ...structuredClone(LEGACY_RAU),
    ledgers: {
      lic_rau: { ids: { msg_1: T0 }, period: { start: '2026-10-20T05:22:11.000Z', end: '2026-11-20T05:22:11.000Z', usedUsd: 0.25, calls: 1 }, totalUsd: 0.25, calls: 1, lastCallAt: '2026-10-31T09:00:00.000Z', source: 'plan' },
      acct_trial: { ids: {}, period: null, totalUsd: 0, calls: 0, lastCallAt: null, source: 'trial\u0000', note: 'kept' },
    },
    spend: {
      '2026-10-26': { haiku: { usd: 0.25, calls: 1, inputTokens: 1200, outputTokens: 80, cacheReadTokens: 3e12, cacheWriteTokens: 0, routes: { openrouter: 0.25 } }, unknown: { usd: '1', calls: 2.5 } },
    },
  };
  const fresh = { ledgers: {}, spend: {} };
  for (const state of [rau, current, fresh, { allowances: {} }]) {
    assert.deepStrictEqual(rauMapper.fromRows(JSON.parse(JSON.stringify(rauMapper.toRows(state)))), state);
  }
  assert.deepStrictEqual(rauMapper.fromRows(Object.fromEntries(rauMapper.tables.map((table) => [table.name, []]))), fresh, 'a new database reads as the empty state');
  assert.throws(() => rauMapper.toRows({ allowances: { lic_a: { keyId: 'lic_z' } } }), { code: 'store_misfit' });
  assert.throws(() => rauMapper.toRows({ ledgers: {}, spend: { '2026-10-26': {} } }), { code: 'store_misfit' });
  assert.throws(() => rauMapper.toRows({ ledgers: {}, spend: { 'last week': { haiku: { usd: 1 } } } }), { code: 'store_misfit' });
  assert.throws(() => rauMapper.toRows({ ledgers: { lic_a: 'x' }, spend: {} }), { code: 'store_misfit' });
  assert.throws(() => rauMapper.toRows({ ledgers: {}, spend: {}, allowance: {} }), { code: 'store_misfit' });

  const db = pgSuite.db(t);
  if (!db) return;
  await pgSuite.reset();
  const giftsBack = await storedAndReloaded(db, giftsMapper, gifts);
  assert.deepStrictEqual(giftsBack, gifts);
  const eventOrder = (state) => Object.entries(state.events).map(([id, ev]) => [id, isMap(ev.grants) ? Object.keys(ev.grants) : null, isMap(ev.allocations) ? Object.keys(ev.allocations) : null]);
  assert.deepStrictEqual(eventOrder(giftsBack), eventOrder(gifts));
  const rauBack = await storedAndReloaded(db, rauMapper, rau);
  assert.deepStrictEqual(rauBack, rau);
  assert.deepStrictEqual(Object.keys(rauBack.allowances.lic_b.ledger), ['2026-09', '2026-10']);
  const currentBack = await storedAndReloaded(db, rauMapper, current);
  assert.deepStrictEqual(currentBack, current);
  assert.deepStrictEqual([Object.keys(currentBack.ledgers), Object.keys(currentBack.spend['2026-10-26'])], [['lic_rau', 'acct_trial'], ['haiku', 'unknown']]);
  assert.deepStrictEqual(await storedAndReloaded(db, rauMapper, fresh), fresh);
});

const isMap = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
