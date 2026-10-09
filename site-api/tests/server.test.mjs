import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSiteServer } from '../server.mjs';
import { createRateLimiter } from '../rate-limit.mjs';
import { createFileStore, syncDirectory } from '../store.mjs';
import { createUniqueInstallProof, uniqueInstallDigest } from '../unique-installs.mjs';

const ADMIN = 'admin-token-for-tests';
const MAC_ID = '11111111-1111-4111-8111-111111111111';

async function tempDir(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'site-api-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function listen(t, env) {
  const server = createSiteServer(env);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return { port, origin: `http://127.0.0.1:${port}` };
}

function rawHttpRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(request));
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

test('existing volume files are served unchanged and new records are appended', async (t) => {
  const directory = await tempDir(t);
  const existingInstall = {
    official: true,
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    appVersion: '2.0.9',
    os: 'win32',
    arch: 'x64',
  };
  const existingSignup = { email: 'first@example.com', joinedAt: '2026-10-01T00:00:00.000Z' };
  await fs.writeFile(path.join(directory, 'unique-installs.json'), JSON.stringify({
    installs: { ['a'.repeat(64)]: existingInstall },
  }));
  await fs.writeFile(path.join(directory, 'waitlist.json'), JSON.stringify({
    entries: { 'first@example.com': existingSignup },
  }));
  const { origin } = await listen(t, { RAU_SITE_DATA: directory, RAU_WAITLIST_ADMIN_TOKEN: ADMIN });

  assert.equal((await fetch(`${origin}/v1/unique-installs`).then((res) => res.json())).uniqueInstalls, 1);
  const ping = { installId: MAC_ID, appVersion: '2.0.10', os: 'darwin', arch: 'arm64' };
  const recorded = await fetch(`${origin}/v1/unique-installs`, {
    method: 'POST',
    body: JSON.stringify({ ...ping, proof: createUniqueInstallProof(ping) }),
  });
  assert.deepEqual(await recorded.json(), { uniqueInstalls: 2, created: true, official: true });

  const joined = await fetch(`${origin}/v1/waitlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ email: 'second@example.com' }),
  });
  assert.equal(joined.status, 200);
  const listed = await fetch(`${origin}/v1/waitlist`, {
    headers: { Authorization: `Bearer ${ADMIN}` },
  }).then((res) => res.json());
  assert.equal(listed.count, 2);
  assert.deepEqual(listed.entries[0], existingSignup);

  const installs = JSON.parse(await fs.readFile(path.join(directory, 'unique-installs.json'), 'utf8'));
  assert.deepEqual(installs.installs['a'.repeat(64)], existingInstall);
  assert.equal(installs.installs[uniqueInstallDigest(MAC_ID)].official, true);
  const signups = JSON.parse(await fs.readFile(path.join(directory, 'waitlist.json'), 'utf8'));
  assert.deepEqual(Object.keys(signups.entries).sort(), ['first@example.com', 'second@example.com']);
});

test('health, icon and malformed requests answer without crashing the listener', async (t) => {
  const { port, origin } = await listen(t, { RAU_SITE_DATA: await tempDir(t) });
  const malformed = await rawHttpRequest(
    port,
    'GET /healthz HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n',
  );
  assert.match(malformed, /^HTTP\/1\.1 400 /);
  const healthy = await fetch(`${origin}/healthz`);
  assert.deepEqual(await healthy.json(), { ok: true });
  const icon = await fetch(`${origin}/favicon.ico`);
  assert.equal(icon.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${origin}/unknown`)).status, 404);
  const oversized = await fetch(`${origin}/v1/waitlist`, {
    method: 'POST',
    body: JSON.stringify({ email: 'x@example.com', pad: 'x'.repeat(70_000) }),
  });
  assert.equal(oversized.status, 413);
});

test('spoofed X-Forwarded-For hops cannot evade the waitlist throttle', async (t) => {
  const { origin } = await listen(t, { RAU_SITE_DATA: await tempDir(t) });
  const join = (i) => fetch(`${origin}/v1/waitlist`, {
    method: 'POST',
    headers: { 'X-Forwarded-For': `198.51.100.${i}, 203.0.113.7` },
    body: JSON.stringify({ email: `user${i}@example.com` }),
  });
  for (let i = 0; i < 10; i += 1) assert.equal((await join(i)).status, 200);
  const blocked = await join(99);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('access-control-allow-origin'), '*');
  assert.equal((await blocked.json()).error, 'RATE_LIMITED');
});

test('rate limiter refuses a new key when cleanup cannot free capacity', () => {
  let clock = 1_000;
  const limiter = createRateLimiter({ now: () => clock, maxKeys: 2 });
  assert.equal(limiter.check('first', 5, 1_000), true);
  assert.equal(limiter.check('second', 5, 1_000), true);
  assert.equal(limiter.check('third', 5, 1_000), false);
  assert.equal(limiter.check('first', 5, 1_000), true);

  clock = 2_001;
  assert.equal(limiter.check('third', 5, 1_000), true);
});

test('file store atomically round-trips state and rejects oversized snapshots', async (t) => {
  const directory = await tempDir(t);
  const filePath = path.join(directory, 'state.json');
  const store = createFileStore(filePath, { emptyState: () => ({ entries: {} }) });
  assert.deepEqual(await store.load(), { entries: {} });
  const expected = { entries: { a: { joinedAt: '2026-10-01T00:00:00.000Z' } } };
  await store.save(expected);
  assert.deepEqual(await store.load(), expected);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(filePath)).mode & 0o077, 0);
  }
  await assert.rejects(
    () => store.save({ entries: {}, padding: 'x'.repeat(8 * 1024 * 1024) }),
    /8 MiB/,
  );
  assert.deepEqual(await store.load(), expected);
  assert.deepEqual(await fs.readdir(directory), ['state.json']);
});

test('file store rejects when the directory entry cannot be synced', async (t) => {
  const directory = await tempDir(t);
  const failure = Object.assign(new Error('simulated directory I/O failure'), { code: 'EIO' });
  const store = createFileStore(path.join(directory, 'state.json'), {
    emptyState: () => ({}),
    syncDirectoryImpl: async () => { throw failure; },
  });
  await assert.rejects(() => store.save({}), (error) => error === failure);
});

test('directory fsync ignores only explicit unsupported errors', async () => {
  for (const code of ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']) {
    await syncDirectory('/unused', {
      openImpl: async () => ({
        sync: async () => { throw Object.assign(new Error(code), { code }); },
        close: async () => {},
      }),
      platform: 'linux',
    });
  }
  for (const code of ['EACCES', 'EISDIR', 'EPERM']) {
    await syncDirectory('/unused', {
      openImpl: async () => { throw Object.assign(new Error(code), { code }); },
      platform: 'win32',
    });
  }
  for (const code of ['EIO', 'ENOSPC', 'EPERM']) {
    let closed = false;
    await assert.rejects(
      () => syncDirectory('/unused', {
        openImpl: async () => ({
          sync: async () => { throw Object.assign(new Error(code), { code }); },
          close: async () => { closed = true; },
        }),
        platform: 'linux',
      }),
      (error) => error.code === code,
    );
    assert.equal(closed, true);
  }
});
