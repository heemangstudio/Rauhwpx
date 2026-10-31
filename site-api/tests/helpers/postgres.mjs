import { randomBytes } from 'node:crypto';
import { after, before } from 'node:test';

import pg from 'pg';

import { createDatabase, poolConfig } from '../../db.mjs';

/**
 * One throwaway schema per test file in the database from SITE_API_TEST_DATABASE_URL, migrated,
 * dropped after the file. `npm test` (scripts/test.mjs) provides a local cluster when the variable
 * is unset. Without a database every test that asks for one skips, unless SITE_API_REQUIRE_POSTGRES=1,
 * which fails the file instead.
 *
 *   const pgSuite = postgresSuite();
 *   test('...', async (t) => { const db = pgSuite.db(t); if (!db) return; await pgSuite.reset(); ... });
 */
export function postgresSuite() {
  const url = process.env.SITE_API_TEST_DATABASE_URL?.trim() ?? '';
  const required = process.env.SITE_API_REQUIRE_POSTGRES === '1';
  const schema = `site_api_test_${process.pid}_${randomBytes(4).toString('hex')}`;
  let db = null;

  async function admin(sql) {
    const client = new pg.Client(poolConfig(url));
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  before(async () => {
    if (!url) {
      if (required) throw new Error('SITE_API_REQUIRE_POSTGRES=1 but SITE_API_TEST_DATABASE_URL is not set');
      return;
    }
    await admin(`CREATE SCHEMA ${schema}`);
    db = createDatabase(url, { searchPath: schema, applicationName: 'site-api-test', log: () => {} });
    await db.ready();
  });

  after(async () => {
    if (!url) return;
    await db?.close();
    await admin(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });

  return {
    schema,
    url,
    /** The migrated database, or null after `t.skip` when there is none. */
    db(t) {
      if (db) return db;
      t.skip('no Postgres: set SITE_API_TEST_DATABASE_URL or install initdb/pg_ctl and run npm test');
      return null;
    },
    /** A second pool on the same schema, as another server process would have. Closed after the test. */
    async otherProcess(t) {
      const other = createDatabase(url, { searchPath: schema, applicationName: 'site-api-test-2', log: () => {} });
      t.after(() => other.close());
      await other.ready();
      return other;
    },
    /** Empties every table the migrations created, so each test starts from a fresh database. */
    async reset() {
      const { rows } = await db.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> 'schema_migrations'",
        [schema],
      );
      if (rows.length) await db.query(`TRUNCATE ${rows.map((row) => row.tablename).join(', ')} RESTART IDENTITY CASCADE`);
    },
  };
}
