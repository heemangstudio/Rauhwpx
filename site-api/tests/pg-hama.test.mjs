import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createLegacyRauPlans } from '../hama-legacy.mjs';
import { hamaMapper } from '../mappers/hama.mjs';
import { createPostgresStore } from '../pg-store.mjs';
import { createFileStore } from '../store.mjs';
import { storedAndReloaded } from './helpers/differential.mjs';
import { postgresSuite } from './helpers/postgres.mjs';

const pgSuite = postgresSuite();
const T0 = Date.parse('2026-10-31T09:00:00.000Z');

const orderOf = (state) => ({ plans: Object.keys(state.plans), ledgers: Object.keys(state.ledgers) });

// A hama.json as the old hosted Hama plan left it: admin enrollments, a paid key's plan, an ended one.
const FROZEN = {
  plans: {
    lic_admin: { status: 'active', allowanceUsd: 2.5, periodAnchor: '2026-10-15T00:00:00+09:00', enrolledAt: '2026-10-15T00:00:00.000Z' },
    lic_paid: { status: 'active', allowanceUsd: null, periodAnchor: '2026-10-20T05:22:11.000Z', enrolledAt: '2026-10-20T05:22:11.000Z' },
    lic_ended: { status: 'disabled', allowanceUsd: null, periodAnchor: '2026-10-01T00:00:00.000Z', disabledAt: '2026-10-30T00:00:00.000Z', disabledReason: 'subscription_ended' },
    lic_anchorless: { status: 'active' },
  },
  ledgers: {
    lic_admin: { minutes: {}, hours: { 491000: 0.12 }, ids: { msg_1: T0 }, period: { start: '2026-10-15T00:00:00.000Z', usedUsd: 0.12, calls: 1 }, totalUsd: 0.12, calls: 1, lastCallAt: '2026-10-31T09:00:00.000Z' },
    lic_stranger: { minutes: {}, hours: {}, ids: {}, period: null, totalUsd: 0.01, calls: 1, lastCallAt: null },
  },
};

const PROBES = ['lic_admin', 'lic_paid', 'lic_ended', 'lic_anchorless', 'lic_stranger', 'lic_none', '__proto__', 'constructor', ''];

async function answers(legacyRauPlan) {
  return Object.fromEntries(await Promise.all(PROBES.map(async (keyId) => [keyId, await legacyRauPlan(keyId)])));
}

test('the frozen hama.json grants the same Rau plans from its file and from Postgres, and nothing writes it', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-pg-hama-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const file = path.join(directory, 'hama.json');
  const text = JSON.stringify(FROZEN, null, 2);
  await fs.writeFile(file, text);
  const empty = () => ({ plans: {}, ledgers: {} });

  const fromFile = await answers(createLegacyRauPlans(createFileStore(file, { emptyState: empty })));
  assert.deepEqual(fromFile, {
    lic_admin: { periodAnchor: '2026-10-15T00:00:00+09:00' },
    lic_paid: { periodAnchor: '2026-10-20T05:22:11.000Z' },
    lic_ended: null,
    lic_anchorless: { periodAnchor: null },
    lic_stranger: null,
    lic_none: null,
    ['__proto__']: null,
    constructor: null,
    '': null,
  });
  assert.equal(await fs.readFile(file, 'utf8'), text, 'the file is never rewritten');
  assert.deepEqual(await fs.readdir(directory), ['hama.json']);
  // Without the file nothing is granted, and nothing is created.
  const missing = path.join(directory, 'none', 'hama.json');
  assert.deepEqual(Object.values(await answers(createLegacyRauPlans(createFileStore(missing, { emptyState: empty })))).filter(Boolean), []);
  await assert.rejects(fs.stat(path.dirname(missing)), { code: 'ENOENT' });

  const db = pgSuite.db(t);
  if (!db) return;
  await pgSuite.reset();
  const store = () => createPostgresStore({ db, mapper: hamaMapper });
  assert.deepEqual(Object.values(await answers(createLegacyRauPlans(store()))).filter(Boolean), [], 'an empty database grants nothing');
  await storedAndReloaded(db, hamaMapper, FROZEN);
  const version = async () => (await db.query("SELECT version FROM site_store_versions WHERE domain = 'hama'")).rows[0].version;
  const before = await version();
  assert.deepEqual(await answers(createLegacyRauPlans(store())), fromFile);
  assert.equal(await version(), before, 'reads never bump the version');
});

test('the legacy reader reads once and retries a failed read', async () => {
  let reads = 0;
  let fail = true;
  const store = {
    async read() {
      reads += 1;
      if (fail) throw new Error('volume not mounted');
      return structuredClone(FROZEN);
    },
  };
  const legacyRauPlan = createLegacyRauPlans(store);
  await assert.rejects(legacyRauPlan('lic_admin'), /volume not mounted/);
  fail = false;
  assert.deepEqual(await legacyRauPlan('lic_admin'), { periodAnchor: '2026-10-15T00:00:00+09:00' });
  assert.equal(await legacyRauPlan('lic_ended'), null);
  assert.equal(reads, 2);
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
  assert.deepStrictEqual(orderOf(reloaded), orderOf(legacy));
});
