import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ActivityStamp, idleReport, readLastActivity } from '../src/activity.mjs';
import { AuthService } from '../src/auth.mjs';
import { BlobStore } from '../src/blob-store.mjs';
import { openDatabase } from '../src/database.mjs';
import { createCloudHttpHandler } from '../src/http-server.mjs';
import { SessionStore } from '../src/session-store.mjs';

const cloudRoot = path.resolve(import.meta.dirname, '..');

async function fixture(t, { now = () => Date.now(), onActivity = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-cloud-idle-'));
  const database = openDatabase(path.join(root, 'cloud.sqlite3'));
  const blobStore = new BlobStore(database, { root: path.join(root, 'objects'), now });
  const sessionStore = new SessionStore(database, blobStore, { now, onActivity });
  database.prepare(`INSERT INTO devices(id, name, created_at, last_seen_at) VALUES ('device', 'Mac', 1, 1)`).run();
  t.after(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, database, blobStore, sessionStore };
}

function insertSession(database, id, {
  status,
  protocolVersion = 2,
  phase = 'idle',
  roomStatus = protocolVersion === 2 ? 'active' : 'legacy',
  controls = {},
  updatedAt = 1,
}) {
  database.prepare(`
    INSERT INTO sessions(
      id, origin_device_id, provider, goal, status, origin_name, origin_sha256, origin_size,
      max_duration_seconds, max_turns, expires_at, created_at, updated_at,
      protocol_version, room_status, execution_phase
    ) VALUES (?, 'device', 'codex', 'Goal', ?, 'doc.hwpx', ?, 1, 3600, 10, 9999999999999, 1, ?, ?, ?, ?)
  `).run(id, status, 'a'.repeat(64), updatedAt, protocolVersion, roomStatus, phase);
  for (const [column, value] of Object.entries(controls)) {
    database.prepare(`UPDATE sessions SET ${column} = ? WHERE id = ?`).run(value, id);
  }
}

function insertUpload(database, id, updatedAt) {
  database.prepare(`
    INSERT INTO uploads(id, device_id, sha256, size, name, kind, temp_path, status, created_at, updated_at)
    VALUES (?, 'device', ?, 10, 'doc.hwpx', 'document', '/tmp/none.part', 'uploading', ?, ?)
  `).run(id, id.padEnd(64, '0'), updatedAt, updatedAt);
}

test('activity stamp writes mtime at most once per throttle window and recreates a missing file', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-cloud-stamp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = Date.parse('2026-09-27T10:00:00.000Z');
  const stamp = new ActivityStamp(root, { now: () => now });
  assert.equal(readLastActivity(root), null);
  assert.equal(stamp.touch(), true);
  assert.equal(readLastActivity(root).getTime(), now);
  const first = now;
  now += 29_999;
  assert.equal(stamp.touch(), false);
  assert.equal(readLastActivity(root).getTime(), first);
  now += 1;
  assert.equal(stamp.touch(), true);
  assert.equal(readLastActivity(root).getTime(), now);
  assert.equal((await fs.readFile(stamp.filename)).length, 0);
  await fs.rm(stamp.filename);
  now += 30_000;
  assert.equal(stamp.touch(), true);
  assert.equal(readLastActivity(root).getTime(), now);
});

test('idle report counts only working sessions and live uploads as busy', async (t) => {
  const { root, database } = await fixture(t);
  const now = Date.parse('2026-09-27T10:00:00.000Z');
  assert.deepEqual(idleReport(database, { dataDirectory: root, now }), {
    ok: true, busy: false, runningSessions: 0, queuedSessions: 0, activeUploads: 0,
    lastActivityAt: null, idleSeconds: 0,
  });

  // A warm conversation waiting for its next message or a user decision lets the host stop.
  insertSession(database, 'warm', { status: 'running', phase: 'idle' });
  insertSession(database, 'plan', { status: 'running', phase: 'awaiting-plan-approval' });
  insertSession(database, 'question', { status: 'running', phase: 'awaiting-question-answer' });
  insertSession(database, 'effect', { status: 'running', phase: 'awaiting-external-effect-approval' });
  insertSession(database, 'asleep', { status: 'suspended', phase: 'sleeping' });
  insertSession(database, 'paused', { status: 'suspended', phase: 'waiting' });
  insertSession(database, 'staged', { status: 'staged' });
  insertSession(database, 'done', { status: 'completed', roomStatus: 'archived' });
  insertUpload(database, 'stalled', now - 5 * 60 * 1000 - 1);
  await fs.writeFile(path.join(root, 'activity.stamp'), '');
  const last = new Date(now - 125_500);
  await fs.utimes(path.join(root, 'activity.stamp'), last, last);
  assert.deepEqual(idleReport(database, { dataDirectory: root, now }), {
    ok: true, busy: false, runningSessions: 0, queuedSessions: 0, activeUploads: 0,
    lastActivityAt: last.toISOString(), idleSeconds: 125,
  });

  const busyCases = [
    ['working', { status: 'running', phase: 'working' }],
    ['redirecting', { status: 'running', phase: 'redirecting' }],
    ['finishing-turn', { status: 'running', phase: 'waiting' }],
    ['sleep-in-flight', { status: 'running', phase: 'sleeping', controls: { sleep_requested_at: now } }],
    ['pause-in-flight', { status: 'running', phase: 'idle', controls: { pause_requested_at: now } }],
    ['takeover-in-flight', { status: 'running', phase: 'awaiting-question-answer', controls: { takeover_requested_at: now } }],
    ['provider-restart', { status: 'running', phase: 'idle', controls: { configuration_restart_requested_at: now } }],
    ['legacy', { status: 'running', protocolVersion: 1 }],
  ];
  for (const [id, input] of busyCases) {
    insertSession(database, id, input);
    const report = idleReport(database, { dataDirectory: root, now });
    assert.equal(report.busy, true, id);
    assert.equal(report.runningSessions, 1, id);
    database.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  insertSession(database, 'queued', { status: 'queued', phase: 'waiting' });
  insertUpload(database, 'live', now - 60_000);
  assert.deepEqual(idleReport(database, { dataDirectory: root, now }), {
    ok: true, busy: true, runningSessions: 0, queuedSessions: 1, activeUploads: 1,
    lastActivityAt: last.toISOString(), idleSeconds: 125,
  });
});

test('store transitions mark activity but worker progress and idle sleep do not', async (t) => {
  const touched = [];
  const now = Date.parse('2026-09-27T10:00:00.000Z');
  const { database, sessionStore } = await fixture(t, { now: () => now, onActivity: (id) => touched.push(id) });
  insertSession(database, 'room', { status: 'queued', phase: 'waiting' });
  assert.equal(sessionStore.claimNextSession(2).id, 'room');
  assert.deepEqual(touched, ['room']);

  sessionStore.appendEvents('room', [{ type: 'agent.progress', payload: { status: 'running' } }]);
  assert.deepEqual(touched, ['room']);

  database.prepare(`UPDATE sessions SET execution_phase = 'idle', last_presence_at = 1 WHERE id = 'room'`).run();
  assert.deepEqual(sessionStore.requestIdleSleeps(), ['room']);
  assert.deepEqual(touched, ['room']);
  sessionStore.acknowledgeSleep('room');
  assert.equal(sessionStore.getSession('room').status, 'suspended');
  assert.deepEqual(touched, ['room']);

  insertSession(database, 'next', { status: 'queued', phase: 'waiting' });
  sessionStore.suspend('next', { code: 'LOW_DISK', message: 'test' });
  assert.deepEqual(touched, ['room', 'next']);
});

test('authenticated writes mark activity while reads, refresh, and health do not', async (t) => {
  const { root, database, blobStore, sessionStore } = await fixture(t);
  const auth = new AuthService(database);
  let touches = 0;
  const pair = generateKeyPairSync('ed25519');
  const identity = {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    serverPublicKey: `ed25519:${pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')}`,
    serverId: 'test-server',
  };
  const server = http.createServer(createCloudHttpHandler({
    auth, blobStore, sessionStore, identity,
    config: { basePath: '/rauhwpx-cloud', maxRunningSessions: 2, maxQueuedSessions: 20, browserOrigins: [], dataDirectory: root },
    logger: { error() {}, info() {} },
    vault: { list: () => [], get: () => null },
    activity: { touch: () => { touches += 1; } },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/rauhwpx-cloud`;
  const request = (route, { method = 'GET', token, body } = {}) => fetch(`${base}${route}`, {
    method,
    headers: {
      'X-Rauhwpx-Request-Nonce': randomBytes(24).toString('base64url'),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const pairing = auth.createPairingCode();
  const tokens = await (await request('/v1/pairing/redeem', {
    method: 'POST', body: { code: pairing.code, deviceName: 'Mac' },
  })).json();
  assert.equal((await request('/v1/health')).status, 200);
  assert.equal((await request('/v1/profile', { token: tokens.accessToken })).status, 200);
  assert.equal((await request('/v1/sessions', { token: tokens.accessToken })).status, 200);
  const refreshed = await request('/v1/token/refresh', {
    method: 'POST', body: { refreshToken: tokens.refreshToken },
  });
  assert.equal(refreshed.status, 200);
  const { accessToken } = await refreshed.json();
  assert.equal((await request('/v1/pairing', { method: 'POST', token: 'ra_at_invalid' })).status, 401);
  assert.equal(touches, 0);

  assert.equal((await request('/v1/pairing', {
    method: 'POST', token: accessToken, body: { deviceName: 'Phone' },
  })).status, 201);
  assert.equal(touches, 1);
});

test('idle CLI prints the host idle report as one JSON line', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rauhwpx-cloud-idle-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const database = openDatabase(path.join(root, 'cloud.sqlite3'));
  database.prepare(`INSERT INTO devices(id, name, created_at, last_seen_at) VALUES ('device', 'Mac', 1, 1)`).run();
  insertSession(database, 'working', { status: 'running', phase: 'working' });
  insertSession(database, 'waiting', { status: 'running', phase: 'awaiting-question-answer' });
  database.close();
  await fs.writeFile(path.join(root, 'activity.stamp'), '');

  const result = spawnSync(process.execPath, [path.join(cloudRoot, 'src/cli.mjs'), 'idle', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, RAUHWpx_DATA_DIR: root, RAUHWpx_PROVIDER_CLI_DIR: path.join(root, 'provider-cli') },
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const report = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(report), [
    'ok', 'busy', 'runningSessions', 'queuedSessions', 'activeUploads', 'lastActivityAt', 'idleSeconds',
  ]);
  assert.equal(report.ok, true);
  assert.equal(report.busy, true);
  assert.equal(report.runningSessions, 1);
  assert.equal(report.queuedSessions, 0);
  assert.match(report.lastActivityAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(Number.isSafeInteger(report.idleSeconds) && report.idleSeconds >= 0);
});
