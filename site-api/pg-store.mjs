import { advisoryLockKey } from './db.mjs';

/**
 * A state document stored as Postgres rows. One store per domain (licenses, accounts, ...), all on
 * one pool. It has the same contract as the memory and file stores in store.mjs:
 *
 *   read()     → a deep copy of the domain state; callers may mutate it.
 *   update(fn) → runs `fn(state, tx)` exclusively for the domain and saves unless the result has
 *                `dirty: false`; resolves to fn's return value. `tx.query(text, values)` runs on the
 *                update's transaction (for data kept beside the state, like avatar bytes). On a throw
 *                or a failed save nothing is persisted and the next call starts from the last
 *                durable state.
 *
 * Exclusion is an in-process promise chain (one process never queues several pool connections on
 * the same lock) plus `pg_advisory_xact_lock` per domain across processes. `site_store_versions`
 * holds a version per domain that every save bumps. The store caches the last committed state with
 * one serialized snapshot per row; an update reloads every table of the domain only when the version
 * moved (another process wrote), then writes only the rows that changed. read() answers from the
 * cache while the version matches, else reloads in a REPEATABLE READ READ ONLY transaction.
 * Versions only grow.
 *
 * Mapper contract (one per domain, in mappers/):
 *
 *   { domain, tables, toRows(state) → { [table]: row[] }, fromRows({ [table]: row[] }) → state }
 *
 * - `tables` are defineTable() results in foreign-key order, parents first. Deletes run children
 *   first, inserts and updates parents first.
 * - toRows emits each table's rows in the state's own order (JS insertion order; for child tables
 *   grouped by parent). fromRows receives the rows ordered by `seq`, so a map or array comes back in
 *   the order it was written: an updated entry keeps its place, a new or re-added one goes last.
 * - fromRows(toRows(s)) must deep-equal `s` for every state the service can produce and for every
 *   legacy JSON file. Record fields go through table.pack()/table.unpack(), which keep anything
 *   that does not fit its column in the `extra` column. A state the mapper cannot represent
 *   (a missing primary key, an entry that is not an object, an unknown top-level field) throws a
 *   `store_misfit` error, which fails the update and saves nothing.
 * - Both functions are pure: toRows must not change the state, fromRows must not change the rows.
 * - A map that is a pure function of other stored data may be derived in fromRows instead of
 *   stored, after checking every write site keeps it so; toRows then throws when it is not.
 */

const ISO_TIME_RE = /^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISO_DATE_RE = /^[1-9]\d{3}-\d{2}-\d{2}$/;
const INT4_MAX = 2147483647;
const MAX_PARAMS = 60_000;

export function storeMisfit(message) {
  return Object.assign(new Error(message), { code: 'store_misfit' });
}

export function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** `obj[key] = value` that also works for a key named `__proto__`. */
export function setOwn(obj, key, value) {
  if (key === '__proto__') Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  else obj[key] = value;
  return obj;
}

/**
 * Column types and the values that fit them exactly. Anything else is a misfit and stays verbatim
 * in `extra` (json, which keeps NUL characters, unpaired surrogates and key order that text and
 * jsonb would reject or change).
 *   text    a string without NUL and with well-formed Unicode
 *   time    a canonical ISO time (`new Date(x).toISOString() === x`, years 1000–9999) ↔ timestamptz
 *   date    `YYYY-MM-DD` that is a real calendar day ↔ date
 *   epoch   a safe integer (epoch ms) ↔ bigint
 *   int     a safe integer within int4 ↔ integer
 *   double  a finite number (money, fractions) ↔ double precision, never numeric
 *   bool    true/false ↔ boolean
 *   object  a plain object ↔ json
 *   array   an array ↔ json
 * `-0` never fits a number column; like JSON it comes back as 0.
 */
export const COLUMN_TYPES = Object.freeze({
  text: (v) => typeof v === 'string' && !v.includes('\u0000') && v.isWellFormed(),
  time: (v) => typeof v === 'string' && ISO_TIME_RE.test(v) && new Date(v).toISOString() === v,
  date: (v) => typeof v === 'string' && ISO_DATE_RE.test(v) && new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) === v,
  epoch: (v) => Number.isSafeInteger(v) && !Object.is(v, -0),
  int: (v) => Number.isSafeInteger(v) && Math.abs(v) <= INT4_MAX && !Object.is(v, -0),
  double: (v) => typeof v === 'number' && Number.isFinite(v) && !Object.is(v, -0),
  bool: (v) => typeof v === 'boolean',
  object: isPlainObject,
  array: Array.isArray,
});
const JSON_TYPES = new Set(['object', 'array', 'extra']);

/** JSON with object keys sorted at every level: equal data gives equal text whatever its key order. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (typeof value.toJSON === 'function') return canonicalJson(value.toJSON());
  const skip = (v) => v === undefined || typeof v === 'function' || typeof v === 'symbol';
  if (Array.isArray(value)) return `[${value.map((v) => (skip(v) ? 'null' : canonicalJson(v))).join(',')}]`;
  const keys = Object.keys(value).filter((k) => !skip(value[k])).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/**
 * One table of a mapper.
 *   key      primary-key columns (rows are diffed by them)
 *   group    columns of the parent a child row belongs to; order is kept per group (default: whole table)
 *   ordered  false for 1:1 child tables, whose order means nothing
 *   given    { column: type } the mapper fills itself (map keys, parent keys); required
 *   fields   { column: [type, field, { required }?] } taken from the record by pack()
 *   extra    false for a table without an `extra` column (pure index tables)
 *   secretKey  true when the key is a hash or an email, so errors never print it
 * Every table also has `seq bigint GENERATED ALWAYS AS IDENTITY`, which only the store writes.
 */
export function defineTable(name, { key, group = [], ordered = true, given = {}, fields = {}, extra = true, secretKey = false }) {
  const fieldColumns = Object.entries(fields).map(([column, [type, field, options = {}]]) => ({
    column, type, field, required: Boolean(options.required),
  }));
  const types = { ...given };
  for (const { column, type } of fieldColumns) types[column] = type;
  if (extra) types.extra = 'extra';
  for (const [column, type] of Object.entries(types)) {
    if (type !== 'extra' && !Object.hasOwn(COLUMN_TYPES, type)) throw new Error(`${name}.${column}: unknown column type ${type}`);
  }
  const columns = Object.keys(types);
  for (const column of [...key, ...group]) {
    if (!columns.includes(column)) throw new Error(`${name}: key or group column ${column} is not a column`);
  }
  const fieldNames = new Set(fieldColumns.map((c) => c.field));

  function check(column, type, value, required, where) {
    if (value === undefined || value === null || !COLUMN_TYPES[type](value)) {
      if (required) throw storeMisfit(`${name}.${column} (${where()}): ${value === undefined ? 'missing' : 'does not fit'} (${type})`);
      return false;
    }
    return true;
  }

  return {
    name,
    key,
    group,
    ordered,
    columns,
    types,
    /**
     * A record (or null for an index table) plus the given columns → one row. A field that fits its
     * column goes there; an explicit null, or a value that does not fit, stays verbatim in `extra`
     * and the column is NULL; every field without a column goes to `extra` too. `undefined` counts
     * as absent, as in JSON. A required column that does not fit throws.
     */
    pack(record, givenValues = {}) {
      const where = () => (secretKey ? '…' : key.map((c) => String(givenValues[c] ?? record?.[fieldColumns.find((f) => f.column === c)?.field])).join(', '));
      const row = {};
      for (const [column, type] of Object.entries(given)) {
        check(column, type, givenValues[column], true, where);
        row[column] = givenValues[column];
      }
      if (record === null && !extra) return row;
      if (!isPlainObject(record)) throw storeMisfit(`${name} (${where()}): entry is not an object`);
      const rest = {};
      for (const { column, type, field, required } of fieldColumns) {
        const value = record[field];
        const present = Object.hasOwn(record, field) && value !== undefined;
        if (present && check(column, type, value, required, where)) {
          row[column] = value;
        } else {
          if (!present && required) check(column, type, undefined, true, where);
          if (present) setOwn(rest, field, value);
          row[column] = null;
        }
      }
      for (const [field, value] of Object.entries(record)) {
        if (!fieldNames.has(field) && value !== undefined) setOwn(rest, field, value);
      }
      if (!extra && Object.keys(rest).length) throw storeMisfit(`${name} (${where()}): fields ${Object.keys(rest).join(', ')} have no column`);
      if (extra) row.extra = Object.keys(rest).length ? rest : null;
      return row;
    },
    /** The record of a row: every non-NULL field column, then everything in `extra`. */
    unpack(row) {
      const record = {};
      for (const { column, field } of fieldColumns) {
        if (row[column] !== null && row[column] !== undefined) setOwn(record, field, row[column]);
      }
      if (row.extra) for (const [field, value] of Object.entries(row.extra)) setOwn(record, field, value);
      return record;
    },
    keyOf: (row) => JSON.stringify(key.map((c) => row[c] ?? null)),
    describeKey: (row) => (secretKey ? '…' : key.map((c) => String(row[c])).join(', ')),
    groupOf: (row) => JSON.stringify(group.map((c) => row[c] ?? null)),
    textOf: (row) => canonicalJson(columns.map((c) => row[c] ?? null)),
    /** The row a textOf() text stands for, as a fresh object. */
    parse(text) {
      const values = JSON.parse(text);
      const row = {};
      columns.forEach((column, i) => { row[column] = values[i]; });
      return row;
    },
    encode: (column, value) => (value === null || value === undefined ? null : JSON_TYPES.has(types[column]) ? JSON.stringify(value) : value),
  };
}

/** Throws unless every own key of `state` is in `known`. */
export function checkRoot(domain, state, known) {
  if (!isPlainObject(state)) throw storeMisfit(`${domain}: state is not an object`);
  const unknown = Object.keys(state).filter((key) => !known.includes(key));
  if (unknown.length) throw storeMisfit(`${domain}: unknown top-level field ${unknown.join(', ')}`);
}

/** The entries of an object map; a value that is not an object map throws. */
export function mapEntries(domain, field, map) {
  if (!isPlainObject(map)) throw storeMisfit(`${domain}.${field} is not an object`);
  return Object.entries(map);
}

function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier ${name}`);
  return `"${name}"`;
}

function chunks(rows, columnCount) {
  const size = Math.max(1, Math.floor(MAX_PARAMS / Math.max(1, columnCount)));
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function valuesClause(rows, columns, encode, values) {
  return rows.map((row) => `(${columns.map((column) => {
    values.push(encode(column, row[column] ?? null));
    return `$${values.length}`;
  }).join(', ')})`).join(', ');
}

async function deleteRows(client, table, rows) {
  const keys = table.key.map(quoteIdent);
  for (const part of chunks(rows, keys.length)) {
    const values = [];
    const tuples = valuesClause(part, table.key, (_column, value) => value, values);
    await client.query(`DELETE FROM ${quoteIdent(table.name)} WHERE (${keys.join(', ')}) IN (${tuples})`, values);
  }
}

/** Insert or update `rows`; `toEnd` also gives an existing row a new `seq`, moving it last. */
async function upsertRows(client, table, rows, { toEnd = false } = {}) {
  const columns = table.columns.map(quoteIdent);
  const updates = table.columns.filter((c) => !table.key.includes(c)).map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`);
  if (toEnd) updates.push('"seq" = DEFAULT');
  const conflict = updates.length ? `DO UPDATE SET ${updates.join(', ')}` : 'DO NOTHING';
  for (const part of chunks(rows, columns.length)) {
    const values = [];
    const tuples = valuesClause(part, table.columns, table.encode, values);
    await client.query(
      `INSERT INTO ${quoteIdent(table.name)} (${columns.join(', ')}) VALUES ${tuples} ON CONFLICT (${table.key.map(quoteIdent).join(', ')}) ${conflict}`,
      values,
    );
  }
}

/** rows by table → Map(table → Map(rowKey → { text, row })), in the given order. */
function indexRows(tables, rowsByTable, domain) {
  if (!rowsByTable || typeof rowsByTable !== 'object') throw storeMisfit(`${domain}: toRows did not return tables`);
  const names = new Set(tables.map((t) => t.name));
  for (const name of Object.keys(rowsByTable)) {
    if (!names.has(name)) throw storeMisfit(`${domain}: toRows returned unknown table ${name}`);
  }
  const index = new Map();
  for (const table of tables) {
    const rows = rowsByTable[table.name] ?? [];
    if (!Array.isArray(rows)) throw storeMisfit(`${domain}: rows of ${table.name} are not an array`);
    const byKey = new Map();
    for (const row of rows) {
      const key = table.keyOf(row);
      if (byKey.has(key)) throw storeMisfit(`${table.name} (${table.describeKey(row)}): two rows share the key`);
      byKey.set(key, { text: table.textOf(row), row });
    }
    index.set(table.name, byKey);
  }
  return index;
}

/**
 * What to write to turn `before` into `after` for one table: deleted rows, rows changed in place,
 * and rows that go last (new ones, and in ordered tables any entry that left its old place, which
 * JS can only do by deleting and re-adding it).
 */
function diffTable(table, before, after) {
  const deletes = [];
  for (const [key, entry] of before) if (!after.has(key)) deletes.push(entry.row);
  const oldIndex = new Map();
  if (table.ordered) {
    const counters = new Map();
    for (const [key, entry] of before) {
      const group = table.groupOf(entry.row);
      const i = counters.get(group) ?? 0;
      counters.set(group, i + 1);
      oldIndex.set(key, i);
    }
  }
  const progress = new Map(); // group → { last: old index of the last kept entry, tail: a row already went last }
  const changed = [];
  const tail = [];
  for (const [key, entry] of after) {
    const old = before.get(key);
    const group = table.ordered ? table.groupOf(entry.row) : '';
    const seen = progress.get(group) ?? { last: -1, tail: false };
    progress.set(group, seen);
    if (!old) {
      tail.push(entry.row);
      seen.tail = true;
      continue;
    }
    if (table.ordered) {
      const i = oldIndex.get(key);
      if (seen.tail || i < seen.last) {
        tail.push(entry.row);
        seen.tail = true;
        continue;
      }
      seen.last = i;
    }
    if (old.text !== entry.text) changed.push(entry.row);
  }
  return { deletes, changed, tail };
}

export function createPostgresStore({ db, mapper }) {
  const { domain, tables } = mapper;
  if (typeof domain !== 'string' || !domain) throw new Error('mapper.domain is required');
  if (new Set(tables.map((t) => t.name)).size !== tables.length) throw new Error(`${domain}: two tables share a name`);
  const lockKey = advisoryLockKey(`store:${domain}`);
  const selects = new Map(tables.map((table) => [table.name,
    `SELECT ${table.columns.map(quoteIdent).join(', ')} FROM ${quoteIdent(table.name)} ORDER BY "seq"`]));
  let chain = Promise.resolve();
  // { version, state, rows: Map(table → Map(rowKey → { text, row })) } of the last committed state.
  let cache = null;

  async function readVersion(client) {
    const { rows } = await client.query('SELECT version FROM site_store_versions WHERE domain = $1', [domain]);
    return rows[0]?.version ?? 0;
  }

  function snapshot(version, rows) {
    const rowsByTable = {};
    for (const table of tables) rowsByTable[table.name] = [...rows.get(table.name).values()].map((entry) => entry.row);
    return { version, state: mapper.fromRows(rowsByTable), rows };
  }

  async function load(client) {
    const version = await readVersion(client);
    const rowsByTable = {};
    for (const table of tables) rowsByTable[table.name] = (await client.query(selects.get(table.name))).rows;
    return snapshot(version, indexRows(tables, rowsByTable, domain));
  }

  /** Writes the difference and bumps the version. Resolves to the new snapshot, or null when no row changed. */
  async function save(client, base, state) {
    const next = indexRows(tables, mapper.toRows(state), domain);
    const plans = tables.map((table) => diffTable(table, base.rows.get(table.name), next.get(table.name)));
    if (plans.every((p) => !p.deletes.length && !p.changed.length && !p.tail.length)) return null;
    for (let i = tables.length - 1; i >= 0; i -= 1) {
      if (plans[i].deletes.length) await deleteRows(client, tables[i], plans[i].deletes);
    }
    for (let i = 0; i < tables.length; i += 1) {
      if (plans[i].changed.length) await upsertRows(client, tables[i], plans[i].changed);
      if (plans[i].tail.length) await upsertRows(client, tables[i], plans[i].tail, { toEnd: true });
    }
    const { rows } = await client.query(
      `INSERT INTO site_store_versions (domain, version) VALUES ($1, 1)
       ON CONFLICT (domain) DO UPDATE SET version = site_store_versions.version + 1, updated_at = now()
       RETURNING version`,
      [domain],
    );
    // The cache keeps its own parsed copy of every row, never the caller's objects.
    for (const table of tables) {
      const old = base.rows.get(table.name);
      for (const [key, entry] of next.get(table.name)) {
        const kept = old.get(key);
        next.get(table.name).set(key, kept && kept.text === entry.text ? kept : { text: entry.text, row: table.parse(entry.text) });
      }
    }
    return snapshot(rows[0].version, next);
  }

  async function runUpdate(fn) {
    await db.ready();
    let committed = null;
    const result = await db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey]);
      const version = await readVersion(client);
      const base = cache && cache.version === version ? cache : await load(client);
      const state = structuredClone(base.state);
      const value = await fn(state, { query: (text, values) => client.query(text, values) });
      committed = base;
      if (value?.dirty !== false) committed = (await save(client, base, state)) ?? base;
      return value;
    });
    cache = committed;
    return result;
  }

  return {
    domain,
    update(fn) {
      const run = chain.then(() => runUpdate(fn));
      chain = run.then(() => undefined, () => undefined);
      return run;
    },
    async read() {
      await chain;
      await db.ready();
      const { rows } = await db.query('SELECT version FROM site_store_versions WHERE domain = $1', [domain]);
      const version = rows[0]?.version ?? 0;
      if (cache && cache.version === version) return structuredClone(cache.state);
      const loaded = await db.transaction(load, { isolation: 'repeatable read', readOnly: true });
      if (!cache || loaded.version > cache.version) cache = loaded;
      return structuredClone(loaded.state);
    },
  };
}
