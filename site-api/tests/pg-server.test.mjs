import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDatabase } from '../db.mjs';
import { createFeedbackProof } from '../feedback.mjs';
import { generateLeaseKeyPair } from '../license-lease.mjs';
import { createLicensesService } from '../licenses.mjs';
import { hamaMapper } from '../mappers/hama.mjs';
import { licensesMapper } from '../mappers/licenses.mjs';
import { createPostgresStore } from '../pg-store.mjs';
import { checkImported } from '../json-import.mjs';
import { createSiteServer } from '../server.mjs';
import { createUniqueInstallProof } from '../unique-installs.mjs';
import { planPaid, signedGroblePost } from './fixtures/groble-plans.mjs';
import { postgresSuite } from './helpers/postgres.mjs';

const pgSuite = postgresSuite();
const ADMIN = 'admin-token-for-pg-server';
const SECRET = 'whsec_test_pg_server';
const PAIR = generateLeaseKeyPair();

async function listen(t, db, directory, log = () => {}) {
  const server = createSiteServer({
    RAU_SITE_DATA: directory,
    GROBLE_WEBHOOK_SECRET: SECRET,
    ADMIN_TOKEN: ADMIN,
    RAU_WAITLIST_ADMIN_TOKEN: ADMIN,
    LICENSE_SIGNING_PRIVATE_KEY: PAIR.privateKeyDerBase64,
    // Turns hosted Rau on; no test here calls upstream.
    RAU_OPENROUTER_KEY: 'sk-or-test-pg-server',
  }, { db, log, alertProvider: null, emailProvider: { name: 'test', async send() { return { status: 'sent' }; } } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

/** A lifetime key written straight to the licenses tables, as an admin issue would. */
async function issueLifetimeKey(db) {
  const licenses = createLicensesService({ store: createPostgresStore({ db, mapper: licensesMapper }), adminToken: ADMIN, log: () => {} });
  return (await licenses.admin.issue(ADMIN, {})).license;
}

/** The import of a frozen hama.json: one write of the whole file into the hama tables. */
async function importLegacyHama(db, plans) {
  await createPostgresStore({ db, mapper: hamaMapper }).update((state) => {
    state.plans = plans;
    state.ledgers = Object.fromEntries(Object.keys(plans).map((keyId) => [keyId, { ids: {}, period: null, totalUsd: 0.25, calls: 3, lastCallAt: '2026-10-30T00:00:00.000Z' }]));
  });
}

const hamaVersion = async (db) => (await db.query("SELECT version FROM site_store_versions WHERE domain = 'hama'")).rows[0]?.version ?? 0;

async function tempDir(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-pg-server-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  return directory;
}

test('server with a database: every store lives in Postgres, only feedback attachments are files', async (t) => {
  const db = pgSuite.db(t);
  if (!db) return;
  await pgSuite.reset();
  const directory = await tempDir(t);
  // A lifetime key with an active plan in the imported hama.json.
  const legacy = await issueLifetimeKey(db);
  await importLegacyHama(db, { [legacy.keyId]: { status: 'active', allowanceUsd: null, periodAnchor: '2026-10-15T00:00:00.000Z', enrolledAt: '2026-10-15T00:00:00.000Z' } });
  const origin = await listen(t, db, directory);
  assert.deepEqual(await (await fetch(`${origin}/healthz`)).json(), { ok: true, storage: 'postgres' });

  const bought = await (await signedGroblePost(origin, SECRET, planPaid({ sku: 'rauMonthly' }))).json();
  assert.equal(bought.action, 'issued');
  const { key } = await (await fetch(`${origin}/v1/license/by-ref?ref=ref-rauMonthly`)).json();
  const activate = (body) => fetch(`${origin}/v1/license/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'darwin', appVersion: '2.1.0', ...body }),
  });
  const activated = await activate({ key, deviceId: 'device-pg-0001' });
  assert.equal(activated.status, 200);
  const { keyId, lease, rau } = await activated.json();
  assert.equal(rau.eligible, true);
  const status = await (await fetch(`${origin}/v1/rau/status`, { headers: { Authorization: `Bearer ${lease}` } })).json();
  assert.deepEqual([status.eligible, status.source, status.remainingPercent], [true, 'plan', 100]);
  // The frozen plan grants Rau from the hama tables.
  assert.equal((await (await activate({ key: legacy.key, deviceId: 'device-pg-legacy' })).json()).rau.eligible, true);
  // A forged webhook is answered, then recorded after the response.
  const forged = await fetch(`${origin}/v1/groble/webhook`, { method: 'POST', body: '{}', headers: { 'X-Groble-Signature': 'v1=00', 'X-Groble-Timestamp': '1' } });
  assert.equal(forged.status, 503);
  const admin = { Authorization: `Bearer ${ADMIN}` };
  let rejected = [];
  for (let i = 0; i < 50 && !rejected.length; i += 1) {
    rejected = (await (await fetch(`${origin}/v1/admin/webhooks?kind=rejected`, { headers: admin })).json()).entries;
    if (!rejected.length) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(rejected.length, 1);
  const post = (route, body, headers = {}) => fetch(`${origin}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post('/v1/waitlist', { email: 'wait@example.com' })).status, 200);
  const ping = { installId: '33333333-3333-4333-8333-333333333333', appVersion: '2.1.0', os: 'darwin', arch: 'arm64' };
  assert.equal((await (await post('/v1/unique-installs', { ...ping, proof: createUniqueInstallProof(ping) })).json()).created, true);
  assert.equal((await post('/v1/downloads', { platform: 'mac-arm64', version: 'latest' })).status, 200);
  const report = { v: 1, installId: ping.installId, createdAt: new Date().toISOString(), message: '저장이 안 돼요', log: 'trace' };
  const submitted = await (await post('/v1/feedback', { ...report, proof: createFeedbackProof(report) })).json();
  assert.equal(submitted.ok, true);

  const { rows } = await db.query(`SELECT (SELECT count(*) FROM licenses) AS licenses, (SELECT count(*) FROM license_devices) AS devices,
    (SELECT count(*) FROM webhook_log) AS log, (SELECT count(*) FROM waitlist_entries) AS waitlist, (SELECT count(*) FROM unique_installs) AS installs,
    (SELECT count(*) FROM download_counts) AS downloads, (SELECT count(*) FROM feedback_reports) AS feedback, (SELECT count(*) FROM hama_plans) AS hama`);
  assert.deepEqual(rows[0], { licenses: 2, devices: 2, log: 1, waitlist: 1, installs: 1, downloads: 1, feedback: 1, hama: 1 });
  assert.equal(await hamaVersion(db), 1, 'the hama tables are only read');
  // No store touches its JSON file; a report's attachments are the only files.
  assert.deepEqual(await fs.readdir(directory), ['feedback']);
  assert.deepEqual(await fs.readdir(path.join(directory, 'feedback')), [submitted.id]);

  // Another process on the same database answers from what this one wrote.
  const other = await listen(t, await pgSuite.otherProcess(t), await tempDir(t));
  assert.equal((await (await fetch(`${other}/v1/license/by-ref?ref=ref-rauMonthly`)).json()).key, key);
  const customers = await (await fetch(`${other}/v1/admin/licenses/customers`, { headers: admin })).json();
  assert.deepEqual(customers.customers.map((c) => [c.keyId, c.devices.length]).sort(), [[keyId, 1], [legacy.keyId, 1]].sort());
  assert.deepEqual((await (await fetch(`${other}/v1/waitlist`, { headers: admin })).json()).entries.map((e) => e.email), ['wait@example.com']);
  const validated = await fetch(`${other}/v1/license/validate`, { method: 'POST', body: JSON.stringify({ key: legacy.key, deviceId: 'device-pg-legacy' }) });
  assert.equal((await validated.json()).rau.eligible, true);
});

test('activate and validate read the frozen Hama plan inside the licenses update without stalling, even on a pool of two connections', async (t) => {
  const main = pgSuite.db(t);
  if (!main) return;
  await pgSuite.reset();
  // A licenses update holds one connection while its first read of the hama tables takes the other;
  // waitlist, download and Rau reads compete for the same two. A stall would end in the 10 s connect
  // timeout, which the licenses service logs as an unreadable Hama plan.
  const keys = [await issueLifetimeKey(main), await issueLifetimeKey(main), await issueLifetimeKey(main)];
  await importLegacyHama(main, { [keys[0].keyId]: { status: 'active', periodAnchor: '2026-10-15T00:00:00.000Z' }, [keys[1].keyId]: { status: 'disabled', disabledReason: 'admin' } });
  const db = createDatabase(pgSuite.url, { searchPath: pgSuite.schema, max: 2, applicationName: 'site-api-test-two', log: () => {} });
  t.after(() => db.close());
  const logs = [];
  const origin = await listen(t, db, await tempDir(t), (line) => logs.push(line));
  const post = async (route, body, headers = {}) => {
    const res = await fetch(`${origin}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { route, status: res.status, body: await res.json() };
  };
  const devices = keys.flatMap((license, k) => [0, 1].map((n) => ({ key: license.key, deviceId: `device-pg-pool-${k}${n}`, platform: 'darwin', appVersion: '2.1.0' })));

  const answers = await Promise.all([
    ...devices.map((device) => post('/v1/license/activate', device)),
    ...Array.from({ length: 6 }, (_, i) => [
      post('/v1/waitlist', { email: `pool${i}@example.com` }),
      post('/v1/downloads', { platform: 'mac-arm64', version: 'latest' }),
    ]).flat(),
  ]);
  assert.deepEqual(answers.filter((answer) => answer.status !== 200), []);
  assert.deepEqual(logs.filter((line) => line.includes('unreadable')), []);
  // Only the active plan grants Rau; a disabled one and a key without a plan do not.
  assert.deepEqual(answers.slice(0, devices.length).map((answer) => answer.body.rau.eligible), [true, true, false, false, false, false]);
  const validated = await Promise.all(devices.map((device) => post('/v1/license/validate', device)));
  assert.deepEqual(validated.map((answer) => [answer.status, answer.body.rau.eligible]), [[200, true], [200, true], [200, false], [200, false], [200, false], [200, false]]);
  assert.equal(await hamaVersion(db), 1, 'the hama tables are only read');
});

test('startup refuses Postgres while a mapped JSON file was never imported', async (t) => {
  const db = pgSuite.db(t);
  if (!db) return;
  await pgSuite.reset();
  const directory = await tempDir(t);
  await checkImported(db, { RAU_SITE_DATA: directory });
  await fs.writeFile(path.join(directory, 'licenses.json'), '{"licenses":{}}');
  await fs.writeFile(path.join(directory, 'webhook-log.json'), '');
  await assert.rejects(checkImported(db, { RAU_SITE_DATA: directory }), /licenses\.json was never imported/);
  await db.query("INSERT INTO site_store_versions (domain, version) VALUES ('licenses', 1)");
  await checkImported(db, { RAU_SITE_DATA: directory });

  // The other stores and the feedback index. The old Hama usage logs are read by nothing and never block.
  await fs.mkdir(path.join(directory, 'feedback', 'fb_leftover0000'), { recursive: true });
  await fs.mkdir(path.join(directory, 'hama-usage'));
  await fs.writeFile(path.join(directory, 'hama-usage', 'lic_a.jsonl'), '{"at":"2026-10-31T00:00:00.000Z"}\n');
  await checkImported(db, { RAU_SITE_DATA: directory });
  await fs.writeFile(path.join(directory, 'hama.json'), '{"plans":{},"ledgers":{}}');
  await fs.writeFile(path.join(directory, 'feedback', 'index.json'), '{"reports":[]}');
  await fs.writeFile(path.join(directory, 'gifts.json'), '{"events":{}}');
  await assert.rejects(checkImported(db, { RAU_SITE_DATA: directory }), (error) => {
    assert.match(error.message, /hama\.json, gifts\.json, feedback\/index\.json was never imported/);
    return true;
  });
  await db.query("INSERT INTO site_store_versions (domain, version) VALUES ('hama', 1), ('gifts', 1), ('feedback', 1)");
  await checkImported(db, { RAU_SITE_DATA: directory });
});
