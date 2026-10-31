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

test('hosted Rau on Postgres answers and stores exactly what the memory store does, and reloads to the same state', async (t) => {
  const db = pgSuite.db(t);
  if (!db) return;
  await pgSuite.reset();
  const clock = { now: T0 };
  const leases = {
    basic: { keyId: 'lic_basic', deviceId: 'dev-a', rauPlan: 'basic' },
    hama: { keyId: 'lic_hama', deviceId: 'dev-b', rauPlan: 'hama' },
    lapsed: { keyId: 'lic_lapsed', deviceId: 'dev-c', rauPlan: null },
  };
  async function world(store) {
    const { upstream, apiBase } = await fakeOpenRouter(t);
    upstream.setChatReply('{"ops":[]}');
    upstream.setChatSpend({ credit: 0.0003 });
    const rau = createRauService({
      store,
      authenticate: authenticateFrom(leases),
      config: { provisioningKey: PROVISIONING, apiBase, monthlyCapsUsd: { basic: 0.001, hama: 0.005 } },
      adminToken: ADMIN,
      now: () => clock.now,
      log: () => {},
    });
    return { stores: { rau: store }, rau, upstream };
  }
  const worlds = {
    memory: await world(createMemoryStore(emptyRauState())),
    postgres: await world(createPostgresStore({ db, mapper: rauMapper })),
  };
  const step = differential(worlds, { orderOf: (_name, state) => Object.keys(state.allowances) });
  const both = (fn) => { fn(worlds.memory.upstream); fn(worlds.postgres.upstream); };
  const learn = (lease, prompt = 'Rau-0.1 prompt') => (w) => w.rau.learn(lease, Buffer.from(JSON.stringify({ prompt })));

  assert.equal((await step('status before any call', (w) => w.rau.status('basic'))).value.usedUsd, 0);
  assert.equal((await step('not eligible', learn('lapsed'))).error.code, 'rau_requires_basic');
  assert.equal((await step('bad prompt', (w) => w.rau.learn('basic', Buffer.from('{"prompt":""}')))).error.code, 'invalid');
  // The first call provisions the license's key, then each call adds its cost to the month's ledger.
  assert.equal((await step('first learn', learn('basic'))).value.text, '{"ops":[]}');
  clock.now += MINUTE;
  await step('second learn', learn('basic'));
  await step('status', (w) => w.rau.status('basic'));
  // A provisioning failure OpenRouter certainly did not act on leaves no allowance behind.
  both((u) => u.failNextCreate(400));
  assert.equal((await step('create refused', learn('hama'))).error.code, 'upstream_unavailable');
  await step('hama learn', learn('hama'));
  // Past the cap the ledger refuses before calling upstream.
  both((u) => u.setChatSpend({ credit: 0.0006 }));
  clock.now += MINUTE;
  await step('expensive learn', learn('basic'));
  clock.now += 20 * 1000;
  const { error } = await step('cap reached', learn('basic'));
  assert.equal(error.code, 'rau_cap_reached');
  // A new month sets the key's limit again and starts a new ledger month; old months are kept (last 3).
  for (const month of ['2026-11-02', '2026-12-02', '2027-01-02']) {
    clock.now = Date.parse(`${month}T00:00:00.000Z`);
    both((u) => { for (const k of u.keys.values()) { k.usage = 0; k.byokUsage = 0; } });
    both((u) => u.setChatSpend({ credit: 0.0001 }));
    await step(`learn in ${month}`, learn('basic'));
  }
  // A license that gains the Hama plan gets the Hama cap on its key.
  leases.basic.rauPlan = 'hama';
  await step('cap raised', learn('basic'));
  await step('admin list', (w) => w.rau.admin.list(ADMIN));
  assert.equal(worlds.postgres.upstream.calls.filter((c) => c.method === 'PATCH').length, 4);
  assert.equal((await step('admin list forbidden', (w) => w.rau.admin.list('nope'))).error.code, 'forbidden');
  assert.deepEqual(worlds.memory.upstream.calls.map((c) => `${c.method} ${c.path}`), worlds.postgres.upstream.calls.map((c) => `${c.method} ${c.path}`));

  const fresh = createPostgresStore({ db, mapper: rauMapper });
  assert.deepStrictEqual(await fresh.read(), await worlds.postgres.stores.rau.read());
  assert.deepEqual(Object.keys((await fresh.read()).allowances.lic_basic.ledger), ['2026-11', '2026-12', '2027-01']);
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

  const rau = {
    allowances: {
      lic_a: { keyId: 'lic_a', status: 'provisioning', name: 'hama-rau-lic_a', capUsd: 2, period: '2026-10', ledger: {}, startedAt: '2026-10-31T00:00:00.000Z' },
      lic_b: { keyId: 'lic_b', status: 'active', capUsd: '2', ledger: { '2026-09': 0.5, '2026-10': 'x' }, createdAt: 'yesterday', lastUsedAt: null },
    },
  };
  assert.deepStrictEqual(rauMapper.fromRows(JSON.parse(JSON.stringify(rauMapper.toRows(rau)))), rau);
  assert.throws(() => rauMapper.toRows({ allowances: { lic_a: { keyId: 'lic_z' } } }), { code: 'store_misfit' });

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
});

const isMap = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
