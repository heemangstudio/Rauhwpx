import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { generateLeaseKeyPair } from '../license-lease.mjs';
import { checkImported, createSiteServer } from '../server.mjs';
import { PRO_ENV, proPaid, signedGroblePost } from './fixtures/groble-pro.mjs';
import { postgresSuite } from './helpers/postgres.mjs';

const pgSuite = postgresSuite();
const ADMIN = 'admin-token-for-pg-server';
const SECRET = 'whsec_test_pg_server';
const PAIR = generateLeaseKeyPair();

async function listen(t, db, directory) {
  const server = createSiteServer({
    RAU_SITE_DATA: directory,
    GROBLE_WEBHOOK_SECRET: SECRET,
    ADMIN_TOKEN: ADMIN,
    RAU_WAITLIST_ADMIN_TOKEN: ADMIN,
    LICENSE_SIGNING_PRIVATE_KEY: PAIR.privateKeyDerBase64,
    ...PRO_ENV,
  }, { db, log: () => {}, alertProvider: null, emailProvider: { name: 'test', async send() { return { status: 'sent' }; } } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); return new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function tempDir(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-pg-server-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  return directory;
}

test('server with a database: licenses and the webhook log live in Postgres, the rest stays on files', async (t) => {
  const db = pgSuite.db(t);
  if (!db) return;
  await pgSuite.reset();
  const directory = await tempDir(t);
  const origin = await listen(t, db, directory);
  assert.deepEqual(await (await fetch(`${origin}/healthz`)).json(), { ok: true, storage: 'postgres' });

  const bought = await (await signedGroblePost(origin, SECRET, proPaid())).json();
  assert.equal(bought.action, 'issued');
  const { key } = await (await fetch(`${origin}/v1/license/by-ref?ref=hama-pro-1`)).json();
  const activated = await fetch(`${origin}/v1/license/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, deviceId: 'device-pg-0001', platform: 'darwin', appVersion: '2.1.0' }),
  });
  assert.equal(activated.status, 200);
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
  assert.equal((await fetch(`${origin}/v1/waitlist`, { method: 'POST', body: JSON.stringify({ email: 'wait@example.com' }) })).status, 200);

  const { rows } = await db.query('SELECT (SELECT count(*) FROM licenses) AS licenses, (SELECT count(*) FROM license_devices) AS devices, (SELECT count(*) FROM webhook_log) AS log');
  assert.deepEqual(rows[0], { licenses: 1, devices: 1, log: 1 });
  // Mapped domains never touch their files; unmapped ones still use theirs.
  assert.deepEqual((await fs.readdir(directory)).sort(), ['waitlist.json']);

  // Another process on the same database answers from what this one wrote.
  const other = await listen(t, await pgSuite.otherProcess(t), await tempDir(t));
  assert.equal((await (await fetch(`${other}/v1/license/by-ref?ref=hama-pro-1`)).json()).key, key);
  const customers = await (await fetch(`${other}/v1/admin/licenses/customers`, { headers: admin })).json();
  assert.deepEqual(customers.customers.map((c) => c.devices.length), [1]);
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
});
