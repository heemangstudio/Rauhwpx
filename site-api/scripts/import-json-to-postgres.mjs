#!/usr/bin/env node
// The JSON → Postgres import the server runs on startup, by hand:
//   DATABASE_URL=postgres://... RAU_SITE_DATA=/path/to/data node scripts/import-json-to-postgres.mjs [--dry-run]
// --dry-run does the whole import, checks included, in transactions it rolls back. Both migrate the
// database first. The JSON files are only read.
import { createDatabase } from '../db.mjs';
import { resolveDatabaseUrl, resolveDataDir } from '../config.mjs';
import { importJsonToPostgres } from '../json-import.mjs';

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== '--dry-run');
if (unknown.length) {
  process.stderr.write(`unknown argument ${unknown[0]}\nusage: node scripts/import-json-to-postgres.mjs [--dry-run]\n`);
  process.exit(2);
}
const url = resolveDatabaseUrl(process.env);
if (!url) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(2);
}
const log = (line) => process.stderr.write(`${line}\n`);
const db = createDatabase(url, { applicationName: 'site-api-import', log });
try {
  log(`[site-api] importing from ${resolveDataDir(process.env)}${args.includes('--dry-run') ? ' (dry run)' : ''}`);
  const reports = await importJsonToPostgres(db, process.env, { dryRun: args.includes('--dry-run'), log });
  process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
} catch (error) {
  log(`[site-api] ${error?.message ?? error}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
