import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { createFileAvatars, createPostgresAvatars } from '../avatars.mjs';
import { checkImported, importJsonToPostgres, importMarkers, importSources } from '../json-import.mjs';
import { generateLeaseKeyPair } from '../license-lease.mjs';
import { createPostgresStore } from '../pg-store.mjs';
import { createSiteServer } from '../server.mjs';
import { createFileStore } from '../store.mjs';
import { postgresSuite } from './helpers/postgres.mjs';

const pgSuite = postgresSuite();
const T = '2026-10-31T09:00:00.000Z';
const ACCT_A = 'acct_0123456789abcdef01';
const ACCT_B = 'acct_0123456789abcdef02';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** One file per domain, legacy and odd values included, as the volume holds them. */
const FILES = {
  'licenses.json': {
    // No giftCodeBatches / giftCodes: written before they existed.
    licenses: {
      lic_old: {
        keyId: 'lic_old', key: 'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE', status: 'active', email: 'buyer@example.com',
        devices: { dev_a_0000: { platform: 'darwin', lastSeenAt: 'yesterday' } },
        createdAt: '2026-10-16T01:00:00+09:00', amount: '9900', subscription: null, odd: { nested: [1, null] },
      },
      lic_new: {
        keyId: 'lic_new', key: 'HAMA-FFFFF-GGGGG-HHHHH-JJJJJ-KKKKK', status: 'active', tier: 'beta', deviceLimit: 5,
        devices: {}, createdAt: T, subscription: { status: 'active', cycle: 1 },
      },
    },
    keyIndex: { 'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE': 'lic_old', 'HAMA-FFFFF-GGGGG-HHHHH-JJJJJ-KKKKK': 'lic_new' },
    orders: { m1: { merchantUid: 'm1', keyId: 'lic_old', refunds: 'none', round: 1.5 } },
    refs: { 'hama-pro-1': 'm1' },
    webhookEvents: { idem_1: { at: T, action: 'issued' } },
    grandfathered: { digest_1: 'lic_old' },
  },
  'accounts.json': {
    accounts: {
      [ACCT_A]: {
        id: ACCT_A, workosUserId: 'user_1', email: 'A@example.com', emailLower: 'a@example.com', emailVerified: true,
        name: '하마', nameSource: 'workos', avatar: { rev: 2, type: 'image/png', bytes: PNG.length }, provider: 'google',
        createdAt: T, lastSignInAt: T, devices: { dev_1: { name: 'Mac', platform: 'darwin', appVersion: '2.1.0', addedAt: T, lastSeenAt: T, sessionHash: 'h1' } },
        stats: { agentSessions: 3, documentsEdited: 1, since: T, batches: [] },
      },
      [ACCT_B]: { id: ACCT_B, email: 'b@example.com', emailVerified: false, avatar: null, devices: {}, createdAt: 'yesterday' },
    },
    byWorkosUser: { user_1: ACCT_A },
    byEmail: { 'a@example.com': ACCT_A },
    sessions: { hash_1: { accountId: ACCT_A, deviceId: 'dev_1', createdAt: T, lastUsedAt: T } },
    logins: {},
    grants: {},
  },
  'webhook-log.json': {
    entries: [
      { id: 'wh_1', kind: 'rejected', reason: 'bad_signature', status: 503, verified: false, at: T, headers: { 'x-groble-timestamp': '1' } },
      { id: 'wh_2', kind: 'held', status: 200, verified: true, at: 'yesterday', merchantUid: 'm2', amount: 9900 },
    ],
  },
  'hama.json': {
    plans: { lic_a: { status: 'active', allowanceUsd: null, periodAnchor: '2026-10-15T00:00:00+09:00', enrolledAt: T } },
    ledgers: { lic_a: { minutes: { 29871234: 0.1 }, hours: {}, ids: { msg_1: 1 }, period: null, totalUsd: 0.1, calls: 1, lastCallAt: null } },
  },
  'rau.json': {
    // The earlier Rau-0.1 allowances, plus what the current service writes beside them.
    allowances: { lic_a: { keyId: 'lic_a', status: 'active', capUsd: '2', ledger: { '2026-09': 0.5, '2026-10': 'x' }, createdAt: 'yesterday', lastUsedAt: null } },
    ledgers: { lic_rau: { ids: { msg_1: 1 }, period: { start: T, usedUsd: 0.25, calls: 1 }, totalUsd: 0.25, calls: 1, lastCallAt: T, source: 'plan' } },
    spend: { '2026-10-26': { haiku: { usd: 0.25, calls: 1, inputTokens: 1200, outputTokens: 80, cacheReadTokens: 3e12, cacheWriteTokens: 0, routes: { openrouter: 0.25 } } } },
  },
  'gifts.json': {
    events: {
      'beta-old': { grants: { lic_a: { keyId: 'lic_a', status: 'active', limitUsd: 20, claimedAt: '2026-10-18T10:00:00+09:00', openrouterKey: 'sk-or-v1-test' } } },
      'beta-2026': { grants: {}, allocations: { lic_b: 12.35, lic_c: '7' }, note: 'kept' },
    },
  },
  'waitlist.json': { entries: { 'b@example.com': { email: null }, 'a@example.com': { email: 'A@example.com', joinedAt: '2026-01-01T00:00:00+09:00' } } },
  'unique-installs.json': { installs: { def: { official: 'yes', arch: 7 }, abc: { os: 'darwin', firstSeenAt: T } } },
  'downloads.json': { days: { '2026-11-01': { 'linux-x64|other': null }, '2026-10-31': { 'win-x64|2.1.0': 2.5, 'mac-arm64|latest': 2 } } },
  'feedback/index.json': { reports: [{ id: 'fb_b', receivedAt: T, status: 'new', email: '', attachments: {}, bytes: 900, preview: 'nul\u0000' }] },
};

// The old plan's usage log: read by nothing, so it stays behind.
const USAGE_FILES = { 'hama-usage/lic_a.jsonl': `${JSON.stringify({ at: T, id: 'msg_1', costUsd: 0.01 })}\n` };

async function dataDir(t, files = FILES) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-import-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const write = async (name, content) => {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.writeFile(path.join(directory, name), content);
  };
  for (const [name, state] of Object.entries(files)) await write(name, `${JSON.stringify(state, null, 2)}\n`);
  for (const [name, text] of Object.entries(USAGE_FILES)) await write(name, text);
  await write(`avatars/${ACCT_A}.png`, PNG);
  await write(`avatars/${ACCT_A}.jpg`, 'a stale type a failed prune left'); // not the record's type
  await write('avatars/acct_ffffffffffffffffff.webp', 'an account that is gone');
  await write('feedback/fb_b/log.txt', 'attachments stay files');
  return directory;
}

/** Bytes and mtime of every file under `dir`. */
async function snapshot(dir) {
  const out = {};
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const info = await fs.stat(file);
    out[path.relative(dir, file)] = [createHash('sha256').update(await fs.readFile(file)).digest('hex'), info.mtimeMs];
  }
  return out;
}

async function tableCounts(db) {
  const { rows } = await db.query("SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> 'schema_migrations' ORDER BY tablename");
  const counts = {};
  for (const { tablename } of rows) counts[tablename] = (await db.query(`SELECT count(*)::int AS n FROM "${tablename}"`)).rows[0].n;
  return counts;
}

test('the import moves every domain into Postgres exactly, once, and leaves the JSON files untouched', async (t) => {
  const db = pgSuite.db(t);
  if (!db) return;
  await pgSuite.reset();
  const directory = await dataDir(t);
  const env = { RAU_SITE_DATA: directory };
  const before = await snapshot(directory);
  await assert.rejects(checkImported(db, env), /licenses\.json, accounts\.json, webhook-log\.json, hama\.json, .*was never imported/);

  const lines = [];
  const reports = await importJsonToPostgres(db, env, { log: (line) => lines.push(line) });
  assert.deepEqual(reports.map((r) => [r.domain, r.status]), importSources(env).map((s) => [s.mapper.domain, 'imported']));
  await checkImported(db, env);

  // Every store reads back its file. licenses.json lacks two maps its mapper cannot leave out: they come back empty,
  // as the service reads them; accounts.json lacks trialEmails, which its mapper keeps missing.
  for (const source of importSources(env)) {
    const fromFile = await createFileStore(source.file, { emptyState: source.emptyState }).read();
    const expected = source.mapper.domain === 'licenses' ? { ...fromFile, giftCodeBatches: {}, giftCodes: {} } : fromFile;
    const actual = await createPostgresStore({ db, mapper: source.mapper }).read();
    assert.deepStrictEqual(actual, JSON.parse(JSON.stringify(expected)), source.mapper.domain);
  }
  // Map order survives: the waitlist was written b, a.
  assert.deepEqual(Object.keys((await createPostgresStore({ db, mapper: importSources(env)[6].mapper }).read()).entries), ['b@example.com', 'a@example.com']);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM hama_usage')).rows[0].n, 0);
  // The record's picture only.
  assert.deepEqual(await createPostgresAvatars(db).get(ACCT_A, 'image/png'), await createFileAvatars(path.join(directory, 'avatars')).get(ACCT_A, 'image/png'));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM account_avatars')).rows[0].n, 1);

  const markers = await importMarkers(db);
  assert.deepEqual(markers.licenses.tables, { licenses: 2, license_subscriptions: 1, license_devices: 1, groble_orders: 1, groble_refs: 1, groble_webhook_deliveries: 1, grandfathered_installs: 1, gift_code_batches: 0, gift_codes: 0 });
  assert.deepEqual(markers.hama.tables, { hama_plans: 1, hama_ledgers: 1 });
  assert.equal(markers.accounts.tables.account_avatars, 1);
  assert.equal(markers.accounts.skippedAvatars, 2);
  assert.ok(lines.includes('[site-api] JSON import hama: wrote hama_plans 1, hama_ledgers 1 from hama.json'), lines.join('\n'));
  assert.ok(lines.some((line) => /^\[site-api\] JSON import accounts: wrote .*account_avatars 1 from accounts\.json \(2 unreferenced pictures skipped\)$/.test(line)), lines.join('\n'));
  // Log lines carry counts, never contents.
  for (const secret of ['buyer@example.com', 'HAMA-AAAAA', 'sk-or-v1-test', 'hash_1', 'A@example.com']) assert.ok(!lines.join('\n').includes(secret), secret);

  // Rerun (a restart) and two processes at once: nothing is written again.
  const counts = await tableCounts(db);
  const other = await pgSuite.otherProcess(t);
  const reruns = await Promise.all([importJsonToPostgres(db, env), importJsonToPostgres(other, env)]);
  for (const rerun of reruns) assert.ok(rerun.every((r) => r.status === 'held'), JSON.stringify(rerun));
  assert.deepEqual(await tableCounts(db), counts);
  assert.deepEqual(await snapshot(directory), before);

  // The counts behind the admin token.
  const pair = generateLeaseKeyPair();
  const server = createSiteServer({ RAU_SITE_DATA: directory, ADMIN_TOKEN: 'admin-import', LICENSE_SIGNING_PRIVATE_KEY: pair.privateKeyDerBase64 }, { db, log: () => {}, alertProvider: null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); return new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/v1/admin/storage`)).status, 403);
  const storage = await (await fetch(`${origin}/v1/admin/storage`, { headers: { Authorization: 'Bearer admin-import' } })).json();
  assert.equal(storage.storage, 'postgres');
  assert.deepEqual(storage.imports, markers);
});

test('a dry run checks everything and writes nothing', async (t) => {
  const db = pgSuite.db(t);
  if (!db) return;
  await pgSuite.reset();
  const directory = await dataDir(t);
  const reports = await importJsonToPostgres(db, { RAU_SITE_DATA: directory }, { dryRun: true });
  assert.ok(reports.every((r) => r.status === 'dry-run'));
  assert.equal(reports.find((r) => r.domain === 'hama').tables.hama_plans, 1);
  assert.ok(Object.values(await tableCounts(db)).every((n) => n === 0));

  // The CLI runs the same code.
  const url = new URL(pgSuite.url);
  url.searchParams.set('options', `-c TimeZone=UTC -c DateStyle=ISO,MDY -c search_path=${pgSuite.schema}`);
  const cli = path.join(import.meta.dirname, '..', 'scripts', 'import-json-to-postgres.mjs');
  const { stdout } = await promisify(execFile)(process.execPath, [cli, '--dry-run'], {
    env: { ...process.env, DATABASE_URL: url.toString(), RAU_SITE_DATA: directory },
  }).catch((error) => { throw new Error(`${error.message}\n${error.stderr}`); });
  assert.deepEqual(JSON.parse(stdout).map((r) => r.status), reports.map(() => 'dry-run'));
  assert.ok(Object.values(await tableCounts(db)).every((n) => n === 0));
});

test('a count mismatch rolls the domain back and refuses to start; empty and held domains are left alone', async (t) => {
  const db = pgSuite.db(t);
  if (!db) return;
  await pgSuite.reset();
  const directory = await dataDir(t);
  const env = { RAU_SITE_DATA: directory };
  const before = await snapshot(directory);
  // A write that loses a row (a trigger standing in for a faulty save): the count cannot match.
  await db.query(`CREATE FUNCTION import_test_drop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER import_test_drop BEFORE INSERT ON hama_plans FOR EACH ROW EXECUTE FUNCTION import_test_drop()`);
  await assert.rejects(importJsonToPostgres(db, env), (error) => {
    assert.equal(error.code, 'json_import_failed');
    assert.match(error.message, /^JSON import of hama rolled back: hama_plans has 1 JSON records but 0 rows\. Unset DATABASE_URL/);
    return true;
  });
  // Domains before it are in; hama and everything after it are not.
  const markers = await importMarkers(db);
  assert.deepEqual(Object.keys(markers).sort(), ['accounts', 'licenses', 'webhook_log']);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM hama_ledgers')).rows[0].n, 0);
  await assert.rejects(checkImported(db, env), /hama\.json, rau\.json/);
  assert.deepEqual(await snapshot(directory), before);

  // A file the mapper cannot hold refuses with its reason and writes nothing.
  // A write that changes a value: the counts match, the read-back does not.
  await db.query(`CREATE OR REPLACE FUNCTION import_test_drop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.status := 'disabled'; RETURN NEW; END $$`);
  await assert.rejects(importJsonToPostgres(db, env), /^Error: JSON import of hama rolled back: the rows read back differ from the JSON\./);
  await db.query('DROP TRIGGER import_test_drop ON hama_plans; DROP FUNCTION import_test_drop()');
  await fs.writeFile(path.join(directory, 'rau.json'), JSON.stringify({ allowances: { lic_a: { keyId: 'lic_z' } } }));
  await assert.rejects(importJsonToPostgres(db, env), /JSON import of rau rolled back: the JSON does not fit the tables \(.*keyId/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM rau_allowances')).rows[0].n, 0);
  assert.equal((await importMarkers(db)).hama.tables.hama_plans, 1); // the rerun got past hama

  // A domain a server already wrote is never overwritten; an empty data directory imports nothing.
  await db.query("INSERT INTO site_store_versions (domain, version) VALUES ('rau', 3)");
  const reports = await importJsonToPostgres(db, env);
  assert.equal(reports.find((r) => r.domain === 'rau').status, 'held');
  assert.equal(reports.find((r) => r.domain === 'gifts').status, 'imported');
  await checkImported(db, env);
  await pgSuite.reset();
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-import-empty-'));
  t.after(() => fs.rm(empty, { recursive: true, force: true }));
  assert.ok((await importJsonToPostgres(db, { RAU_SITE_DATA: empty })).every((r) => r.status === 'empty'));
  assert.deepEqual(await importMarkers(db), {});
});
