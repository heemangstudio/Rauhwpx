import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDownloadsService, emptyDownloadsState, kstDay, MAX_KEYS_PER_DAY } from '../downloads.mjs';
import { createFeedbackProof, createFeedbackService, emptyFeedbackIndex } from '../feedback.mjs';
import { downloadsMapper } from '../mappers/downloads.mjs';
import { feedbackMapper } from '../mappers/feedback.mjs';
import { uniqueInstallsMapper } from '../mappers/unique-installs.mjs';
import { waitlistMapper } from '../mappers/waitlist.mjs';
import { createPostgresStore } from '../pg-store.mjs';
import { createMemoryStore } from '../store.mjs';
import { createUniqueInstallProof, createUniqueInstallsService, emptyUniqueInstallsState } from '../unique-installs.mjs';
import { createWaitlistService, emptyWaitlistState } from '../waitlist.mjs';
import { differential, storedAndReloaded } from './helpers/differential.mjs';
import { postgresSuite } from './helpers/postgres.mjs';

const pgSuite = postgresSuite();
const ADMIN = 'admin-token-for-pg-site-stores';
const T0 = Date.parse('2026-10-31T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const INSTALL = '44444444-4444-4444-8444-444444444444';

async function tempDir(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-pg-site-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  return directory;
}

test('waitlist, unique installs and downloads on Postgres match the memory store and reload to the same state', async (t) => {
  const db = pgSuite.db(t);
  if (!db) return;
  await pgSuite.reset();
  const clock = { now: T0 };
  const world = (stores) => ({
    stores,
    waitlist: createWaitlistService({ store: stores.waitlist, now: () => clock.now, adminToken: ADMIN }),
    installs: createUniqueInstallsService({ store: stores.installs, now: () => clock.now }),
    downloads: createDownloadsService({ store: stores.downloads, now: () => clock.now, adminToken: ADMIN }),
  });
  const worlds = {
    memory: world({
      waitlist: createMemoryStore(emptyWaitlistState()),
      installs: createMemoryStore(emptyUniqueInstallsState()),
      downloads: createMemoryStore(emptyDownloadsState()),
    }),
    postgres: world({
      waitlist: createPostgresStore({ db, mapper: waitlistMapper }),
      installs: createPostgresStore({ db, mapper: uniqueInstallsMapper }),
      downloads: createPostgresStore({ db, mapper: downloadsMapper }),
    }),
  };
  const orderOf = (name, state) => {
    if (name === 'waitlist') return Object.keys(state.entries);
    if (name === 'installs') return Object.keys(state.installs);
    return Object.entries(state.days).map(([day, counts]) => [day, Object.keys(counts)]);
  };
  const step = differential(worlds, { orderOf });

  // Waitlist: one entry per lowercased email, the first spelling kept.
  await step('join', (w) => w.waitlist.join({ email: 'Wait@Example.com' }));
  clock.now += 1000;
  await step('join again', (w) => w.waitlist.join({ email: 'wait@example.COM' }));
  await step('join other', (w) => w.waitlist.join({ email: ' second@example.com ' }));
  assert.equal((await step('join invalid', (w) => w.waitlist.join({ email: 'no-at' }))).error.code, 'WAITLIST_EMAIL_INVALID');
  assert.deepEqual((await step('list', (w) => w.waitlist.list(ADMIN))).value.entries.map((e) => e.email), ['Wait@Example.com', 'second@example.com']);
  assert.equal((await step('list forbidden', (w) => w.waitlist.list('nope'))).error.code, 'WAITLIST_FORBIDDEN');

  // Unique installs: official platforms count, a repeat ping does not.
  const ping = (installId, os, arch) => {
    const body = { installId, appVersion: '2.1.0', os, arch };
    return (w) => w.installs.record({ ...body, proof: createUniqueInstallProof(body) });
  };
  assert.equal((await step('install mac', ping(INSTALL, 'darwin', 'arm64'))).value.uniqueInstalls, 1);
  assert.equal((await step('install again', ping(INSTALL, 'darwin', 'arm64'))).value.created, false);
  await step('install linux', ping('55555555-5555-4555-8555-555555555555', 'linux', 'x64'));
  await step('install windows', ping('66666666-6666-4666-a666-666666666666', 'win32', 'x64'));
  assert.equal((await step('bad proof', (w) => w.installs.record({ installId: INSTALL, appVersion: '2.1.0', os: 'darwin', arch: 'arm64', proof: '00' }))).error.code, 'UNIQUE_INSTALL_PROOF_INVALID');
  assert.equal((await step('total', (w) => w.installs.summary())).value.uniqueInstalls, 2);

  // Downloads: counts by KST day and platform|version, `other` past the per-day cap, old days pruned.
  await step('download', (w) => w.downloads.record({ platform: 'mac-arm64', version: 'latest' }));
  await step('download again', (w) => w.downloads.record({ platform: 'mac-arm64', version: 'latest' }));
  await step('download win', (w) => w.downloads.record({ platform: 'win-x64', version: '2.1.0' }));
  clock.now += DAY;
  for (let i = 0; i <= MAX_KEYS_PER_DAY; i += 1) {
    await step(`download version ${i}`, (w) => w.downloads.record({ platform: 'linux-x64', version: `2.1.${i}` }));
  }
  assert.equal((await step('bad platform', (w) => w.downloads.record({ platform: 'amiga', version: 'latest' }))).error.code, 'DOWNLOAD_PLATFORM_INVALID');
  const { value: summary } = await step('summary', (w) => w.downloads.summary(ADMIN, {}));
  assert.equal(summary.total, 3 + MAX_KEYS_PER_DAY + 1);
  clock.now += 401 * DAY;
  await step('download after retention', (w) => w.downloads.record({ platform: 'mac-x64', version: 'latest' }));
  await step('summary after retention', (w) => w.downloads.summary(ADMIN, { days: '400' }));

  // A fresh process loads exactly the state the first one holds.
  const fresh = (mapper) => createPostgresStore({ db, mapper }).read();
  assert.deepStrictEqual(await fresh(waitlistMapper), await worlds.postgres.stores.waitlist.read());
  assert.deepStrictEqual(await fresh(uniqueInstallsMapper), await worlds.postgres.stores.installs.read());
  assert.deepStrictEqual(await fresh(downloadsMapper), await worlds.postgres.stores.downloads.read());
  assert.deepEqual(Object.keys((await fresh(downloadsMapper)).days), [kstDay(clock.now)]);
});

test('the feedback index on Postgres matches the memory store, and attachments and rows stay in step', async (t) => {
  const db = pgSuite.db(t);
  if (!db) return;
  await pgSuite.reset();
  const clock = { now: T0 };
  let n = 0;
  const ids = { memory: 0, postgres: 0 };
  const world = (name, index, dir) => ({
    dir,
    stores: { feedback: index },
    feedback: createFeedbackService({
      dir,
      index,
      now: () => clock.now,
      adminToken: ADMIN,
      maxStorageBytes: 6000,
      newId: () => { ids[name] += 1; return `fb_${clock.now.toString(36)}${String(ids[name]).padStart(12, '0')}`; },
    }),
  });
  const worlds = {
    memory: world('memory', createMemoryStore(emptyFeedbackIndex()), await tempDir(t)),
    postgres: world('postgres', createPostgresStore({ db, mapper: feedbackMapper }), await tempDir(t)),
  };
  const step = differential(worlds, { orderOf: (_name, state) => state.reports.map((r) => r.id) });
  const report = (fields = {}) => {
    n += 1;
    const body = { v: 1, installId: `${String(n).padStart(8, '0')}-4444-4444-8444-444444444444`, createdAt: new Date(clock.now).toISOString(), message: `보고 ${n}`, meta: { appVersion: '2.1.0', os: 'darwin' }, ...fields };
    return { ...body, proof: createFeedbackProof(body) };
  };
  const dirsOf = async (w) => (await fs.readdir(w.dir)).sort();

  const firstBody = report({ log: 'trace', email: 'me@example.com' });
  const { value: first } = await step('submit', (w) => w.feedback.submit(structuredClone(firstBody)));
  const second = report({ createdAt: '2026-10-31T18:00:00+09:00', screenshot: { mime: 'image/png', base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]).toString('base64') } });
  clock.now += 1000;
  const { value: other } = await step('submit with screenshot', (w) => w.feedback.submit(structuredClone(second)));
  const big = report({ chat: 'x'.repeat(6000) });
  assert.equal((await step('storage full', (w) => w.feedback.submit(structuredClone(big)))).error.code, 'storage_full');
  await step('list', (w) => w.feedback.admin.list(ADMIN));
  await step('detail', (w) => w.feedback.admin.detail(ADMIN, other.id));
  await step('attachment', (w) => w.feedback.admin.attachment(ADMIN, { id: other.id, name: 'screenshot' }));
  await step('status seen', (w) => w.feedback.admin.setStatus(ADMIN, { id: first.id, status: 'seen' }));
  assert.equal((await step('status of a missing report', (w) => w.feedback.admin.setStatus(ADMIN, { id: 'fb_missing00000', status: 'seen' }))).error.code, 'not_found');
  await step('delete', (w) => w.feedback.admin.remove(ADMIN, { id: other.id }));
  for (const w of Object.values(worlds)) assert.deepEqual(await dirsOf(w), [first.id]);

  // Leftovers (a crashed upload, a directory no index row lists) and reports past 90 days are pruned.
  clock.now += 10 * DAY;
  const later = report();
  await step('submit later', (w) => w.feedback.submit(structuredClone(later)));
  for (const w of Object.values(worlds)) {
    await fs.mkdir(path.join(w.dir, '.incoming-fb_crashed0000'));
    await fs.mkdir(path.join(w.dir, 'fb_orphan000000'));
  }
  clock.now += 85 * DAY;
  assert.equal((await step('prune', (w) => w.feedback.prune())).value, 1);
  for (const w of Object.values(worlds)) assert.equal((await dirsOf(w)).length, 1);
  await step('list after prune', (w) => w.feedback.admin.list(ADMIN));
  clock.now += 10 * DAY;
  await step('list prunes the rest', (w) => w.feedback.admin.list(ADMIN));
  for (const w of Object.values(worlds)) assert.deepEqual(await dirsOf(w), []);
  const last = report();
  await step('submit after prune', (w) => w.feedback.submit(structuredClone(last)));

  assert.deepStrictEqual(await createPostgresStore({ db, mapper: feedbackMapper }).read(), await worlds.postgres.stores.feedback.read());
});

test('a failed index save leaves no report directory behind', async (t) => {
  const db = pgSuite.db(t);
  if (!db) return;
  await pgSuite.reset();
  const dir = await tempDir(t);
  let refuse = false;
  // The save fails after the report's files were written and renamed into place.
  const index = createPostgresStore({ db, mapper: { ...feedbackMapper, toRows: (state) => {
    if (refuse) throw Object.assign(new Error('save refused'), { code: 'save_refused' });
    return feedbackMapper.toRows(state);
  } } });
  const feedback = createFeedbackService({ dir, index });
  const body = { v: 1, installId: INSTALL, createdAt: new Date().toISOString(), message: '첫 보고' };
  const { id } = await feedback.submit({ ...body, proof: createFeedbackProof(body) });
  refuse = true;
  const again = { ...body, message: '두 번째' };
  await assert.rejects(feedback.submit({ ...again, proof: createFeedbackProof(again) }), { code: 'save_refused' });
  assert.deepEqual(await fs.readdir(dir), [id]);
  assert.deepEqual((await index.read()).reports.map((r) => r.id), [id]);
});

test('the small mappers keep legacy and odd records losslessly, also through Postgres, and refuse what they cannot hold', async (t) => {
  const cases = [
    // Keys out of sorted order, so the reload shows it keeps the stored order.
    [waitlistMapper, { entries: { 'b@example.com': { email: null }, 'a@example.com': { email: 'A@example.com', joinedAt: '2026-01-01T00:00:00+09:00' } } }],
    [uniqueInstallsMapper, { installs: { def: { official: 'yes', arch: 7 }, abc: { os: 'darwin', firstSeenAt: '2026-09-01T00:00:00.000Z' } } }],
    [downloadsMapper, { days: { '2026-11-01': { 'linux-x64|other': null }, '2026-10-31': { 'win-x64|2.1.0': 2.5, 'mac-arm64|latest': 2 } } }],
    [feedbackMapper, { reports: [
      { id: 'fb_b', receivedAt: '2026-10-31T00:00:00.000Z', createdAt: '2026-10-31T09:00:00+09:00', status: 'new', email: '', attachments: {}, bytes: 900, preview: 'nul\u0000' },
      { id: 'fb_a', receivedAt: 'yesterday', status: 'archived', attachments: { screenshot: { bytes: 10, type: 'image/png' } }, bytes: 3e9 },
    ] }],
  ];
  for (const [mapper, state] of cases) {
    assert.deepStrictEqual(mapper.fromRows(JSON.parse(JSON.stringify(mapper.toRows(state)))), state, mapper.domain);
  }
  assert.throws(() => downloadsMapper.toRows({ days: { '2026-10-31': {} } }), { code: 'store_misfit' });
  assert.throws(() => downloadsMapper.toRows({ days: { yesterday: { 'mac-arm64|latest': 1 } } }), { code: 'store_misfit' });
  assert.throws(() => feedbackMapper.toRows({ reports: [{ receivedAt: 'x' }] }), { code: 'store_misfit' });
  assert.throws(() => waitlistMapper.toRows({ entries: { a: 'a@example.com' } }), { code: 'store_misfit' });

  const db = pgSuite.db(t);
  if (!db) return;
  await pgSuite.reset();
  const orders = {
    waitlist: (state) => Object.keys(state.entries),
    unique_installs: (state) => Object.keys(state.installs),
    downloads: (state) => Object.entries(state.days).map(([day, counts]) => [day, Object.keys(counts)]),
    feedback: (state) => state.reports.map((report) => report.id),
  };
  for (const [mapper, state] of cases) {
    const reloaded = await storedAndReloaded(db, mapper, state);
    assert.deepStrictEqual(reloaded, state, mapper.domain);
    assert.deepStrictEqual(orders[mapper.domain](reloaded), orders[mapper.domain](state), `${mapper.domain} order`);
  }
});
