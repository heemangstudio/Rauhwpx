import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

/**
 * The Postgres connection of site-api: one pool for every store, the migration runner and
 * transactions. Used only when DATABASE_URL is set; without it every store stays on its JSON file.
 * The URL and its password never reach a log line.
 */

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const MIGRATION_FILE_RE = /^(\d{3})_([a-z0-9_]+)\.sql$/;
const STATEMENT_TIMEOUT_MS = 30_000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POOL_MAX = 20;
const CONNECT_ATTEMPTS = 10;
const ISOLATION_LEVELS = new Set(['read committed', 'repeatable read', 'serializable']);

const INT8_OID = 20;
const DATE_OID = 1082;
const TIMESTAMPTZ_OID = 1184;
const parseTimestamptz = pg.types.getTypeParser(TIMESTAMPTZ_OID, 'text');

/** int8 as a JS number; a value past Number.MAX_SAFE_INTEGER fails the query instead of rounding. */
export function parseInt8(text) {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error(`int8 value ${text} is past Number.MAX_SAFE_INTEGER`);
  return value;
}

/**
 * int8 → Number, timestamptz → canonical ISO string (what the services store), date → its
 * `YYYY-MM-DD` text. Every other type keeps node-postgres' parser (json → JSON.parse, bytea → Buffer).
 */
const TYPES = {
  getTypeParser(oid, format = 'text') {
    if (format === 'text') {
      if (oid === INT8_OID) return parseInt8;
      if (oid === DATE_OID) return (text) => text;
      if (oid === TIMESTAMPTZ_OID) {
        return (text) => {
          const value = parseTimestamptz(text);
          return value instanceof Date ? value.toISOString() : value;
        };
      }
    }
    return pg.types.getTypeParser(oid, format);
  },
};

/**
 * libpq's `sslmode` on node-postgres: absent, `disable`, `allow` and `prefer` connect without TLS
 * (node-postgres cannot fall back), `require` encrypts without checking the certificate, `verify-ca`
 * checks the chain, `verify-full` the chain and the host name.
 */
export function sslFromMode(mode) {
  switch (mode) {
    case undefined: case null: case '': case 'disable': case 'allow': case 'prefer':
      return false;
    case 'require':
      return { rejectUnauthorized: false };
    case 'verify-ca':
      return { rejectUnauthorized: true, checkServerIdentity: () => undefined };
    case 'verify-full':
      return { rejectUnauthorized: true };
    default:
      throw new Error(`DATABASE_URL has an unknown sslmode: ${mode}`);
  }
}

/** Pool settings from a postgres:// URL. `sslmode` is read here, so node-postgres never reinterprets it. */
export function poolConfig(url, { applicationName = 'site-api', searchPath, max = DEFAULT_POOL_MAX } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must start with postgres:// or postgresql://');
  }
  const ssl = sslFromMode(parsed.searchParams.get('sslmode'));
  parsed.searchParams.delete('sslmode');
  if (searchPath !== undefined && !/^[a-z_][a-z0-9_]*$/.test(searchPath)) throw new Error(`search path ${searchPath} is not a plain schema name`);
  return {
    connectionString: parsed.toString(),
    ssl,
    max,
    application_name: applicationName,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
    // Times come back in ISO form with an offset; date columns as YYYY-MM-DD.
    options: ['-c TimeZone=UTC', '-c DateStyle=ISO,MDY', ...(searchPath ? [`-c search_path=${searchPath}`] : [])].join(' '),
    types: TYPES,
    connectionTimeoutMillis: 10_000,
  };
}

/** A stable signed 64-bit advisory lock key (as text, cast to bigint in SQL) for `name`. */
export function advisoryLockKey(name) {
  return createHash('sha256').update(`site-api:${name}`).digest().readBigInt64BE(0).toString();
}

function checksumOf(sql) {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/** `migrations/NNN_name.sql` in version order. */
export async function readMigrations(dir = MIGRATIONS_DIR) {
  const names = (await fs.readdir(dir)).filter((name) => MIGRATION_FILE_RE.test(name)).sort();
  const migrations = [];
  for (const file of names) {
    const [, version, name] = MIGRATION_FILE_RE.exec(file);
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    migrations.push({ version: Number(version), name, file, sql, checksum: checksumOf(sql) });
  }
  for (let i = 1; i < migrations.length; i += 1) {
    if (migrations[i].version === migrations[i - 1].version) throw new Error(`two migrations share version ${migrations[i].version}`);
  }
  return migrations;
}

/**
 * Applies every migration not yet in `schema_migrations`, one transaction per file, under a
 * session advisory lock so two processes never migrate at once. An applied file whose checksum
 * changed refuses to start. A version the database has but this code does not (a newer deploy
 * rolled back) is left alone. Resolves to the versions applied now.
 */
export async function migrate(pool, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const migrations = await readMigrations(dir);
  const client = await pool.connect();
  const lock = advisoryLockKey('migrations');
  let broken = false;
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [lock]);
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const applied = new Map((await client.query('SELECT version, name, checksum FROM schema_migrations')).rows
        .map((row) => [row.version, row]));
      for (const migration of migrations) {
        const done = applied.get(migration.version);
        if (done && done.checksum !== migration.checksum) {
          throw new Error(`migration ${migration.file} changed after it was applied; add a new migration instead`);
        }
      }
      const known = new Set(migrations.map((m) => m.version));
      for (const version of applied.keys()) {
        if (!known.has(version)) log(`[site-api] database has migration ${version}, which this build does not know`);
      }
      const ran = [];
      for (const migration of migrations) {
        if (applied.has(migration.version)) continue;
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
            [migration.version, migration.name, migration.checksum]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => { broken = true; });
          throw Object.assign(new Error(`migration ${migration.file} failed: ${error.message}`), { cause: error });
        }
        log(`[site-api] applied migration ${migration.file}`);
        ran.push(migration.version);
      }
      return ran;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [lock]).catch(() => { broken = true; });
    }
  } finally {
    client.release(broken || undefined);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `createDatabase(url)` → `{ pool, ready, query, transaction, close }`.
 * - `ready()` connects (bounded retries with backoff) and migrates; memoized, retried after a failure.
 * - `transaction(fn, { isolation, readOnly })` runs `fn(client)` between BEGIN and COMMIT; any
 *   error rolls back. A client whose rollback failed is discarded, never reused.
 */
export function createDatabase(url, {
  applicationName,
  searchPath,
  max,
  migrationsDir = MIGRATIONS_DIR,
  connectAttempts = CONNECT_ATTEMPTS,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const pool = new pg.Pool(poolConfig(url, { applicationName, searchPath, max }));
  // An idle client that loses its connection must not crash the process.
  pool.on('error', (error) => log(`[site-api] idle Postgres connection failed: ${error?.message ?? error}`));
  let readyPromise = null;

  async function connect() {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const client = await pool.connect();
        client.release();
        return;
      } catch (error) {
        if (attempt >= connectAttempts) throw error;
        log(`[site-api] Postgres not reachable (attempt ${attempt}/${connectAttempts}): ${error?.code ?? error?.message ?? error}`);
        await sleep(Math.min(500 * 2 ** (attempt - 1), 5_000));
      }
    }
  }

  function ready() {
    readyPromise ??= (async () => {
      await connect();
      await migrate(pool, { dir: migrationsDir, log });
    })().catch((error) => {
      readyPromise = null;
      throw error;
    });
    return readyPromise;
  }

  async function transaction(fn, { isolation = 'read committed', readOnly = false } = {}) {
    if (!ISOLATION_LEVELS.has(isolation)) throw new Error(`unknown isolation level ${isolation}`);
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}${readOnly ? ' READ ONLY' : ''}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => { broken = true; });
      throw error;
    } finally {
      client.release(broken || undefined);
    }
  }

  let closing = null;
  return {
    pool,
    ready,
    query: (text, values) => pool.query(text, values),
    transaction,
    /** Waits for checked-out clients, then ends the pool. Safe to call more than once. */
    close: () => (closing ??= pool.end()),
  };
}
