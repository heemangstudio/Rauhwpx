import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDatabase, poolConfig, sslFromMode } from '../db.mjs';
import { canonicalJson, checkRoot, createPostgresStore, defineTable, mapEntries, setOwn, storeMisfit } from '../pg-store.mjs';
import { createFileStore, createMemoryStore } from '../store.mjs';
import { postgresSuite } from './helpers/postgres.mjs';

const pgSuite = postgresSuite();

// A small domain shaped like the real ones: a map of records with a child map per record.
const ITEMS = defineTable('toy_items', {
  key: ['id'],
  fields: {
    id: ['text', 'id', { required: true }],
    name: ['text', 'name'],
    at: ['time', 'at'],
    n: ['double', 'n'],
    count: ['int', 'count'],
    ms: ['epoch', 'ms'],
    on: ['bool', 'on'],
    day: ['date', 'day'],
    meta: ['object', 'meta'],
    tags: ['array', 'tags'],
  },
});
const PARTS = defineTable('toy_parts', {
  key: ['item_id', 'part_id'],
  group: ['item_id'],
  given: { item_id: 'text', part_id: 'text' },
  fields: { label: ['text', 'label'] },
});
const toyMapper = {
  domain: 'toy',
  tables: [ITEMS, PARTS],
  toRows(state) {
    checkRoot('toy', state, ['items']);
    const rows = { toy_items: [], toy_parts: [] };
    for (const [id, item] of mapEntries('toy', 'items', state.items)) {
      if (item?.id !== id) throw storeMisfit(`toy (${id}): id does not match`);
      const { parts, ...rest } = item;
      for (const [partId, part] of Object.entries(parts ?? {})) rows.toy_parts.push(PARTS.pack(part, { item_id: id, part_id: partId }));
      rows.toy_items.push(ITEMS.pack(rest));
    }
    return rows;
  },
  fromRows(rows) {
    const state = { items: {} };
    for (const row of rows.toy_items) setOwn(state.items, row.id, { ...ITEMS.unpack(row), parts: {} });
    for (const row of rows.toy_parts) setOwn(state.items[row.item_id].parts, row.part_id, PARTS.unpack(row));
    return state;
  },
};

const TOY_SQL = `
  DROP TABLE IF EXISTS toy_parts, toy_items, toy_side;
  CREATE TABLE toy_items (
    id text PRIMARY KEY, seq bigint GENERATED ALWAYS AS IDENTITY, name text, at timestamptz,
    n double precision CHECK (n IS NULL OR n < 1000), count integer, ms bigint, "on" boolean, day date,
    meta json, tags json, extra json
  );
  CREATE TABLE toy_parts (
    item_id text NOT NULL REFERENCES toy_items (id) ON DELETE CASCADE, part_id text NOT NULL,
    seq bigint GENERATED ALWAYS AS IDENTITY, label text, extra json, PRIMARY KEY (item_id, part_id)
  );
  CREATE TABLE toy_side (id text PRIMARY KEY);
`;

async function toyDb(t) {
  const db = pgSuite.db(t);
  if (!db) return null;
  await pgSuite.reset();
  await db.query(TOY_SQL);
  return db;
}

const keysOf = (state) => Object.fromEntries(Object.entries(state.items).map(([id, item]) => [id, Object.keys(item.parts)]));

test('lossless columns: fitting values use the column, misfits, nulls and unknown fields stay in extra', () => {
  const record = {
    id: 'a',
    name: 'x\u0000y', // NUL: not a text value
    at: '2026-10-20T14:22:11+09:00', // not canonical
    n: -0,
    count: 2 ** 40, // past int4
    ms: 1.5,
    on: null, // explicit null
    day: '2026-02-30', // not a day
    meta: ['not', 'an', 'object'],
    tags: { not: 'an array' },
    lone: '\ud800',
    missing: undefined,
    ['__proto__']: { polluted: true },
  };
  const row = ITEMS.pack(record);
  for (const column of ['name', 'at', 'n', 'count', 'ms', 'on', 'day', 'meta', 'tags']) assert.equal(row[column], null, column);
  assert.equal(row.id, 'a');
  assert.ok(Object.hasOwn(row.extra, 'on') && row.extra.on === null);
  assert.equal(Object.hasOwn(row.extra, 'missing'), false);
  const back = ITEMS.unpack(JSON.parse(JSON.stringify(row)));
  assert.deepEqual(back, JSON.parse(JSON.stringify(record)));
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(back), Object.prototype);

  const fitting = { id: 'b', name: 'n', at: '2026-10-31T01:02:03.004Z', n: 0.1, count: 3, ms: Date.UTC(2026, 9, 31), on: false, day: '2027-10-20', meta: { a: 1 }, tags: ['t'] };
  const fitRow = ITEMS.pack(fitting);
  assert.equal(fitRow.extra, null);
  assert.equal(fitRow.at, fitting.at);
  assert.deepEqual(ITEMS.unpack(fitRow), fitting);
  // Absent fields stay absent; an empty record keeps only its key.
  assert.deepEqual(ITEMS.unpack(ITEMS.pack({ id: 'c' })), { id: 'c' });

  assert.throws(() => ITEMS.pack({ name: 'no id' }), { code: 'store_misfit' });
  assert.throws(() => ITEMS.pack({ id: 7 }), { code: 'store_misfit' });
  assert.throws(() => ITEMS.pack('not an object'), { code: 'store_misfit' });
  assert.throws(() => PARTS.pack({}, { item_id: 'a' }), { code: 'store_misfit' });
  assert.equal(canonicalJson({ b: 1, a: [undefined, { d: undefined, c: 2 }] }), '{"a":[null,{"c":2}],"b":1}');
});

test('memory and file stores: update saves unless dirty is false, a throw saves nothing, read waits for pending updates', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const store of [createMemoryStore({ n: 0 }), createFileStore(path.join(directory, 's.json'), { emptyState: () => ({ n: 0 }) })]) {
    assert.equal(await store.update((state) => { state.n += 1; return 'one'; }), 'one');
    assert.deepEqual(await store.update((state) => { state.n = 99; return { dirty: false }; }), { dirty: false });
    await assert.rejects(store.update((state) => { state.n = 50; throw new Error('boom'); }), /boom/);
    const pending = store.update(async (state) => { await new Promise((r) => setTimeout(r, 20)); state.n += 1; });
    assert.deepEqual(await store.read(), { n: 2 });
    await pending;
    assert.deepEqual(await store.load(), { n: 2 });
  }
});

test('db: sslmode and the pool config from DATABASE_URL', () => {
  assert.equal(sslFromMode(undefined), false);
  assert.deepEqual(sslFromMode('require'), { rejectUnauthorized: false });
  assert.equal(sslFromMode('verify-full').rejectUnauthorized, true);
  assert.throws(() => sslFromMode('sometimes'), /sslmode/);
  const config = poolConfig('postgresql://u:secret@db.example:5432/app?sslmode=require&application_name=x');
  assert.equal(config.connectionString.includes('sslmode'), false);
  assert.deepEqual(config.ssl, { rejectUnauthorized: false });
  assert.throws(() => poolConfig('mysql://x'), /postgres/);
});

test('db: int8 past the safe range fails, times come back as ISO strings and dates as YYYY-MM-DD', async (t) => {
  const db = pgSuite.db(t);
  if (!db) return;
  await assert.rejects(db.query('SELECT 9007199254740993::bigint AS x'), /MAX_SAFE_INTEGER/);
  const { rows: [row] } = await db.query("SELECT 9007199254740991::bigint AS max, '2026-10-31T01:02:03.004Z'::timestamptz AS at, '2027-10-20'::date AS day");
  assert.deepEqual(row, { max: Number.MAX_SAFE_INTEGER, at: '2026-10-31T01:02:03.004Z', day: '2027-10-20' });
});

test('migrations: applied once, an edited applied file refuses to start', async (t) => {
  const db = pgSuite.db(t);
  if (!db) return;
  const { rows } = await db.query('SELECT version, name FROM schema_migrations ORDER BY version');
  assert.deepEqual(rows[0], { version: 1, name: 'licenses_accounts' });
  const schema = `${pgSuite.schema}_mig`;
  await db.query(`CREATE SCHEMA ${schema}`);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-migrations-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
  });
  await fs.writeFile(path.join(dir, '001_first.sql'), 'CREATE TABLE first (a integer);');
  const open = () => createDatabase(pgSuite.url, { searchPath: schema, migrationsDir: dir, log: () => {} });
  const a = open();
  const b = open();
  await Promise.all([a.ready(), b.ready()]); // two processes at once: the advisory lock serializes them
  await Promise.all([a.close(), b.close()]);
  const { rows: applied } = await db.query(`SELECT version FROM ${schema}.schema_migrations`);
  assert.deepEqual(applied, [{ version: 1 }]);
  await fs.writeFile(path.join(dir, '001_first.sql'), 'CREATE TABLE first (a integer, b integer);');
  const edited = open();
  await assert.rejects(edited.ready(), /changed after it was applied/);
  await edited.close();
});

test('postgres store: a reload equals the state, only changed rows are written, order survives', async (t) => {
  const db = await toyDb(t);
  if (!db) return;
  const store = createPostgresStore({ db, mapper: toyMapper });
  assert.deepEqual(await store.read(), { items: {} });
  await store.update((state) => {
    for (const id of ['a', 'b', 'c']) state.items[id] = { id, name: id.toUpperCase(), at: '2026-10-31T00:00:00.000Z', parts: {} };
    state.items.a.parts.p1 = { label: 'a1' };
    state.items.b.parts.p1 = { label: 'b1' };
    state.items.a.parts.p2 = { label: 'a2' }; // after b's part: order is kept per item
    state.items.c.meta = { s: 'nul\u0000', lone: '\udc00' };
  });
  const xmin = async () => Object.fromEntries((await db.query('SELECT id, xmin::text AS x FROM toy_items')).rows.map((r) => [r.id, r.x]));
  const before = await xmin();
  await store.update((state) => { state.items.b.name = 'B2'; });
  const after = await xmin();
  assert.equal(after.a, before.a);
  assert.equal(after.c, before.c);
  assert.notEqual(after.b, before.b);

  // A deleted and re-added entry moves last, like a JS object; an updated one keeps its place.
  await store.update((state) => {
    const { a } = state.items;
    delete state.items.a;
    state.items.a = a;
    state.items.d = { id: 'd', parts: { z: { label: 'z' }, y: { label: 'y' } } };
    state.items.b.parts.p2 = { label: 'b2' };
  });
  await store.update((state) => {
    const { p1 } = state.items.b.parts;
    delete state.items.b.parts.p1;
    state.items.b.parts.p1 = p1;
    state.items.a.parts.p1.label = 'a1 changed';
  });
  const expected = await store.read();
  assert.deepEqual(Object.keys(expected.items), ['b', 'c', 'a', 'd']);
  assert.deepEqual(keysOf(expected), { b: ['p2', 'p1'], c: [], a: ['p1', 'p2'], d: ['z', 'y'] });
  assert.equal(expected.items.c.meta.s, 'nul\u0000');
  assert.equal(expected.items.c.meta.lone, '\udc00');

  const fresh = createPostgresStore({ db, mapper: toyMapper });
  const reloaded = await fresh.read();
  assert.deepEqual(reloaded, expected);
  assert.deepEqual(Object.keys(reloaded.items), Object.keys(expected.items));
  assert.deepEqual(Object.entries(keysOf(reloaded)), Object.entries(keysOf(expected)));
  // A delete removes its children too, and the version only moves on a real change.
  const { rows: [{ version }] } = await db.query("SELECT version FROM site_store_versions WHERE domain = 'toy'");
  await store.update((state) => { state.items.b.name = 'B2'; }); // same value
  await store.update(() => ({ dirty: false }));
  assert.equal((await db.query("SELECT version FROM site_store_versions WHERE domain = 'toy'")).rows[0].version, version);
  await store.update((state) => { delete state.items.a; });
  assert.deepEqual((await db.query("SELECT part_id FROM toy_parts WHERE item_id = 'a'")).rows, []);
  assert.deepEqual(await fresh.read(), await store.read());
});

test('postgres store: a throw, a misfit or a failed write saves nothing and keeps the cache', async (t) => {
  const db = await toyDb(t);
  if (!db) return;
  const store = createPostgresStore({ db, mapper: toyMapper });
  await store.update((state) => { state.items.a = { id: 'a', n: 1, parts: {} }; });
  const durable = await store.read();
  // Changed behind the store's back without a version bump: only a reload would see it.
  await db.query("UPDATE toy_items SET name = 'reloaded'");

  await assert.rejects(store.update(async (state, tx) => {
    await tx.query("INSERT INTO toy_side (id) VALUES ('rolled back')");
    state.items.a.n = 2;
    throw new Error('boom');
  }), /boom/);
  await assert.rejects(store.update((state) => { state.items.b = { id: 'not b', parts: {} }; }), { code: 'store_misfit' });
  // The CHECK (n < 1000) fails inside Postgres, after the cache was cloned.
  await assert.rejects(store.update((state) => { state.items.a.n = 5000; state.items.x = { id: 'x', parts: {} }; }), /check constraint/);
  // The failed updates kept the cache: no reload, and none of their changes.
  assert.deepEqual(await store.read(), durable);
  assert.deepEqual(await createPostgresStore({ db, mapper: toyMapper }).read(), { items: { a: { ...durable.items.a, name: 'reloaded' } } });
  assert.deepEqual((await db.query('SELECT id FROM toy_side')).rows, []);
  // The next update starts from the durable state.
  assert.equal(await store.update((state) => state.items.a.n), 1);

  // fn's return value comes back; tx writes commit with the state.
  const value = await store.update(async (state, tx) => {
    await tx.query("INSERT INTO toy_side (id) VALUES ('kept')");
    state.items.a.n = 3;
    return { value: 'v' };
  });
  assert.deepEqual(value, { value: 'v' });
  assert.deepEqual((await db.query('SELECT id FROM toy_side')).rows, [{ id: 'kept' }]);
});

test('postgres store: two processes see each other\'s writes and their updates never interleave', async (t) => {
  const db = await toyDb(t);
  if (!db) return;
  const other = await pgSuite.otherProcess(t);
  const a = createPostgresStore({ db, mapper: toyMapper });
  const b = createPostgresStore({ db: other, mapper: toyMapper });
  await a.update((state) => { state.items.c = { id: 'c', count: 0, parts: {} }; });
  assert.equal((await b.read()).items.c.count, 0);
  await b.update((state) => { state.items.c.count += 1; state.items.c.parts.from_b = { label: 'b' }; });
  // a's cache is stale now: its read and its next update reload.
  assert.equal((await a.read()).items.c.count, 1);
  const bump = (store) => store.update(async (state) => {
    const seen = state.items.c.count;
    await new Promise((r) => setTimeout(r, 2));
    state.items.c.count = seen + 1;
  });
  await Promise.all(Array.from({ length: 20 }, (_, i) => bump(i % 2 ? a : b)));
  const final = await a.read();
  assert.equal(final.items.c.count, 21);
  assert.deepEqual(await b.read(), final);
  assert.deepEqual(await createPostgresStore({ db, mapper: toyMapper }).read(), final);
});
