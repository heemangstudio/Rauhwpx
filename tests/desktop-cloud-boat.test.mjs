import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BOAT_SANDBOX_NAME,
  BoatCloud,
  __test as boatTest,
  boatHostEnv,
  boatServerState,
  installBoatStatusCadence,
  isAllowedBoatLink,
  knownHostsPattern,
  monthHours,
  parseHostKeys,
  rewriteKnownHosts,
} from '../desktop/cloud-boat.mjs';
import { CloudCoordinator } from '../desktop/cloud-coordinator.mjs';
import { normalizeCloudProfile } from '../desktop/cloud-profile.mjs';
import { CloudProvisioner, normalizeHostEnv, __test as provisionerTest } from '../desktop/cloud-provisioner.mjs';
import { __test as tunnelTest } from '../desktop/cloud-ssh-tunnel.mjs';

const SERVER_KEY = `ed25519:${generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')}`;
const API_KEY = 'boat_valid_key_123';
const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

function sshBlob(type, extra = randomBytes(32)) {
  const name = Buffer.from(type);
  const nameLength = Buffer.alloc(4);
  nameLength.writeUInt32BE(name.length);
  const extraLength = Buffer.alloc(4);
  extraLength.writeUInt32BE(extra.length);
  return Buffer.concat([nameLength, name, extraLength, extra]).toString('base64');
}

function memoryVault(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, String(value)); return true; },
    delete: async (key) => values.delete(key),
  };
}

async function fakeKeygen(_command, args) {
  if (!args.includes('-t')) throw new Error(`unexpected ssh-keygen call: ${args.join(' ')}`);
  const file = args[args.indexOf('-f') + 1];
  await writeFile(file, 'PRIVATE KEY', { mode: 0o600 });
  await writeFile(`${file}.pub`, `ssh-ed25519 ${sshBlob('ssh-ed25519')} rauhwpx-boat\n`);
  return { stdout: '', stderr: '' };
}

/** boat API의 필요한 부분만 흉내 낸 로컬 서버. 상태 전이는 GET 폴링마다 한 걸음씩 진행된다. */
async function startFakeBoat(t, options = {}) {
  const state = {
    tokens: new Map([[API_KEY, 'owner@example.com']]),
    requests: [],
    sandboxes: new Map(),
    idempotency: new Map(),
    deletions: new Map(),
    limits: { canStart: true, accessTier: 'standard', sandboxPlanKey: 'box_20', billingStatus: 'active' },
    trial: false,
    trialRefusalCode: 'trial_auto_stop_required',
    trialRefusalMessage: undefined,
    billingRequiredOnResume: false,
    claimPolls: [],
    claimCount: 0,
    reclaims: 0,
    rotations: 0,
    assertion: 'eyJhbGciOiJub25lIn0.assertion-body.signature',
    failNextCreateAfterCommit: false,
    hostKeys: [{ type: 'ssh-ed25519', key: sshBlob('ssh-ed25519') }],
    apiHostKey: null,
    ipCounter: 10,
    getsToReady: 2,
    getsToArchive: 2,
    /** What the installed boat-idle.sh --probe prints: cli | api | none, or null for no line. */
    selfStop: 'cli',
    ...options,
  };
  let origin = '';
  const newIp = () => `203.0.113.${state.ipCounter++}`;
  const newId = () => `bx_${Array.from(randomBytes(8), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('')}`;
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const fail = (res, status, code, message = code) => send(res, status, {
    ok: false, type: 'sandbox.error', status, code, message, error: { code, message, status }, requestId: 'req_test',
  });
  const oauthFail = (res, status, error) => send(res, status, { error });
  const view = (sandbox) => ({
    id: sandbox.id,
    name: sandbox.name,
    state: sandbox.state,
    type: sandbox.type,
    ip: sandbox.ip,
    sshEndpoint: sandbox.sshEndpoint ?? null,
    createdAt: sandbox.createdAt,
    snapshotAvailable: sandbox.snapshotAvailable,
    desktopAvailable: false,
    error: sandbox.error ?? null,
  });
  const addSandbox = (patch = {}) => {
    const sandbox = {
      id: newId(),
      name: BOAT_SANDBOX_NAME,
      state: 'provisioning',
      type: 'default',
      ip: null,
      createdAt: '2026-09-27T09:00:00.000Z',
      snapshotAvailable: false,
      ttlSeconds: null,
      gets: 0,
      resumes: 0,
      keys: [],
      ...patch,
    };
    if (['ready', 'idle', 'running'].includes(sandbox.state) && !sandbox.ip) sandbox.ip = newIp();
    state.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  };
  const advance = (sandbox) => {
    sandbox.gets += 1;
    if (['init', 'provisioning', 'provisioned', 'cloning'].includes(sandbox.state) && sandbox.gets >= state.getsToReady) {
      sandbox.state = 'ready';
      sandbox.ip = newIp();
    }
    if (sandbox.state === 'archiving' && sandbox.gets >= state.getsToArchive) {
      sandbox.state = 'archived';
      sandbox.ip = null;
      sandbox.snapshotAvailable = true;
    }
  };
  const usable = (sandbox) => ['ready', 'idle', 'running'].includes(sandbox.state);
  const trialRefuses = (ttl) => state.trial && (ttl === null || ttl === undefined || ttl > 7200);

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://fake.boat');
    let body = null;
    if (raw) {
      body = String(req.headers['content-type']).includes('json')
        ? JSON.parse(raw)
        : Object.fromEntries(new URLSearchParams(raw));
    }
    state.requests.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, raw, body });
    const route = `${req.method} ${url.pathname}`;

    if (route === 'POST /api/boat/agent/identity') {
      state.claimCount += 1;
      return send(res, 200, {
        claim_token: `clm_test_${state.claimCount}`,
        claim: {
          user_code: '123456',
          verification_uri: `${origin}/api/boat/agent/identity/claim?claim_attempt_token=cat_${state.claimCount}`,
          expires_in: 600,
          interval: 5,
        },
      });
    }
    if (route === 'POST /api/boat/agent/identity/claim') {
      if (!String(body?.claim_token ?? '').startsWith('clm_test_')) return oauthFail(res, 400, 'invalid_claim_token');
      state.reclaims += 1;
      return send(res, 200, {
        claim: {
          user_code: '654321',
          verification_uri: `${origin}/api/boat/agent/identity/claim?claim_attempt_token=re_${state.reclaims}`,
          expires_in: 600,
          interval: 5,
        },
      });
    }
    if (route === 'POST /api/boat/oauth2/token') {
      if (body.grant_type === 'urn:workos:agent-auth:grant-type:claim') {
        const outcome = state.claimPolls.shift() ?? 'pending';
        if (outcome === 'pending') return oauthFail(res, 400, 'authorization_pending');
        if (outcome === 'slow_down') return oauthFail(res, 400, 'slow_down');
        if (outcome === 'expired') return oauthFail(res, 400, 'expired_token');
        const token = `boat_email_${state.claimCount}_${state.reclaims}`;
        state.tokens.set(token, 'signer@example.com');
        return send(res, 200, {
          access_token: token, token_type: 'Bearer', expires_in: 3600, identity_assertion: state.assertion,
        });
      }
      if (body.grant_type === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
        if (body.assertion !== state.assertion || body.resource !== `${origin}/api/v1/`) {
          return oauthFail(res, 400, 'invalid_grant');
        }
        for (const [token, email] of state.tokens) if (email === 'signer@example.com') state.tokens.delete(token);
        state.rotations += 1;
        const token = `boat_rotated_${state.rotations}`;
        state.tokens.set(token, 'signer@example.com');
        return send(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 3600 });
      }
      return oauthFail(res, 400, 'unsupported_grant_type');
    }
    if (route === 'POST /api/boat/oauth2/revoke') return send(res, 200, {});

    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const email = state.tokens.get(token);
    if (!email) return fail(res, 401, 'unauthorized', 'Unauthorized');

    if (route === 'POST /api/boat/billing/checkout') {
      return send(res, 200, { url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    }
    if (route === 'GET /api/v1/me') return send(res, 200, { ok: true, type: 'user.info', user: { email, login: 'owner' } });
    if (route === 'GET /api/v1/limits') return send(res, 200, { ok: true, type: 'limits.info', ...state.limits });
    if (route === 'GET /api/v1/sandboxes') {
      return send(res, 200, { ok: true, type: 'sandbox.list', sandboxes: [...state.sandboxes.values()].map(view) });
    }
    if (route === 'POST /api/v1/sandboxes') {
      if (trialRefuses(body?.ttlSeconds)) return fail(res, 400, state.trialRefusalCode, state.trialRefusalMessage);
      const key = req.headers['idempotency-key'];
      if (key && state.idempotency.has(key)) {
        const prior = state.idempotency.get(key);
        if (prior.raw !== raw) return fail(res, 409, 'idempotency_key_reused');
        const sandbox = state.sandboxes.get(prior.id);
        return send(res, 202, { ok: true, type: 'sandbox.created', status: 'provisioning', ttlSeconds: sandbox.ttlSeconds, sandbox: view(sandbox) });
      }
      // 실제 boat 처럼 생성 요청의 name 은 무시하고 날짜 이름을 붙인다.
      const sandbox = addSandbox({ name: 'Box 2026-09-27 09:00', type: body.type, ttlSeconds: body.ttlSeconds });
      if (key) state.idempotency.set(key, { id: sandbox.id, raw });
      if (state.failNextCreateAfterCommit) {
        state.failNextCreateAfterCommit = false;
        return fail(res, 503, 'http_503');
      }
      return send(res, 202, { ok: true, type: 'sandbox.created', status: 'provisioning', ttlSeconds: sandbox.ttlSeconds, sandbox: view(sandbox) });
    }
    const deletion = /^\/api\/v1\/deletion-operations\/(bdop_[a-f0-9]{32})$/.exec(url.pathname);
    if (deletion && req.method === 'GET') {
      const operation = state.deletions.get(deletion[1]);
      if (!operation) return fail(res, 404, 'not_found');
      operation.status = operation.status === 'pending' ? 'processing' : 'completed';
      if (operation.status === 'completed') operation.completedAt = new Date().toISOString();
      return send(res, 200, { ok: true, type: 'deletion.operation', operation });
    }
    const match = /^\/api\/v1\/sandboxes\/(bx_[a-z0-9]{8})(?:\/(\w+))?$/.exec(url.pathname);
    if (!match) return fail(res, 404, 'not_found');
    const [, id, action = ''] = match;
    const sandbox = state.sandboxes.get(id);
    if (!sandbox) return fail(res, 404, 'not_found');
    if (req.method === 'GET' && !action) {
      if (sandbox.state === 'cancelled') {
        state.sandboxes.delete(id);
        return send(res, 200, { ok: true, type: 'sandbox.info', sandbox: { id, state: 'cancelled', error: 'no capacity' } });
      }
      advance(sandbox);
      return send(res, 200, { ok: true, type: 'sandbox.info', sandbox: view(sandbox) });
    }
    if (req.method === 'PATCH' && !action) {
      if ('ttlSeconds' in body && trialRefuses(body.ttlSeconds)) return fail(res, 400, state.trialRefusalCode, state.trialRefusalMessage);
      if ('ttlSeconds' in body) sandbox.ttlSeconds = body.ttlSeconds;
      if (typeof body.name === 'string') sandbox.name = body.name;
      return send(res, 200, { ok: true, type: 'sandbox.info', sandbox: view(sandbox) });
    }
    if (req.method === 'DELETE' && !action) {
      if (req.headers['x-ascii-confirm-delete'] !== id) return fail(res, 409, 'confirmation_required');
      state.sandboxes.delete(id);
      const operation = {
        id: `bdop_${randomBytes(16).toString('hex')}`,
        kind: 'sandbox',
        targetId: id,
        reason: 'explicit',
        status: 'pending',
        attemptCount: 0,
        requestedAt: new Date().toISOString(),
        completedAt: null,
      };
      state.deletions.set(operation.id, operation);
      return send(res, 202, { ok: true, type: 'sandbox.deleting', operation });
    }
    if (req.method === 'POST' && action === 'resume') {
      if (state.billingRequiredOnResume) return fail(res, 402, 'billing_required');
      if (trialRefuses(body?.ttlSeconds)) return fail(res, 400, state.trialRefusalCode, state.trialRefusalMessage);
      if (!['archived', 'error'].includes(sandbox.state)) return fail(res, 409, 'resume_failed');
      Object.assign(sandbox, { state: 'provisioning', gets: 0, ip: null, ttlSeconds: body?.ttlSeconds ?? sandbox.ttlSeconds });
      sandbox.resumes += 1;
      return send(res, 202, { ok: true, type: 'sandbox.resuming', id, status: 'resuming', sandbox: view(sandbox) });
    }
    if (req.method === 'POST' && action === 'stop') {
      if (sandbox.state !== 'archived') Object.assign(sandbox, { state: 'archiving', gets: 0 });
      return send(res, 202, { ok: true, type: 'sandbox.stopping', id, status: 'archiving', sandbox: view(sandbox) });
    }
    if (req.method === 'POST' && action === 'sshkey') {
      if (!usable(sandbox)) return fail(res, 409, 'boat_starting');
      sandbox.keys.push(body.key);
      const hostKey = state.apiHostKey ?? state.hostKeys[0];
      return send(res, 200, {
        ok: true, type: 'ssh_key.configured', success: true, machineIp: sandbox.ip, sshUser: 'user',
        sshEndpoint: sandbox.sshEndpoint ?? null, hostKey: `${hostKey.type} ${hostKey.key}`,
      });
    }
    if (req.method === 'POST' && action === 'commands') {
      if (!usable(sandbox)) return fail(res, 409, 'boat_starting');
      let stdout = '';
      if (body.command.includes('/etc/ssh/ssh_host_')) {
        stdout = state.hostKeys.map((entry) => `${entry.type} ${entry.key} root@boat\n`).join('');
      } else if (body.command.includes('boat-idle.sh') && state.selfStop) {
        stdout = `rauhwpx-boat-self-stop ${state.selfStop}\n`;
      }
      return send(res, 200, { ok: true, type: 'command.finished', success: true, exitCode: 0, stdout, stderr: '', timedOut: false });
    }
    if (req.method === 'GET' && action === 'usage') {
      return send(res, 200, { ok: true, type: 'sandbox.usage', sandboxId: id, seconds: 45_000, dollars: 0.45, running: usable(sandbox) });
    }
    return fail(res, 404, 'not_found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  origin = `http://127.0.0.1:${server.address().port}`;
  const requests = (method, pattern) => state.requests.filter((entry) => (
    entry.method === method && (typeof pattern === 'string' ? entry.path === pattern : pattern.test(entry.path))
  ));
  return { state, origin, addSandbox, requests };
}

async function makeBoat(t, fake, overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rauhwpx-boat-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = { now: Date.parse('2026-09-27T10:00:00Z') };
  const vault = overrides.vault ?? memoryVault();
  const knownHostsPath = path.join(dir, 'ssh-known-hosts');
  const boat = new BoatCloud({
    vault,
    origin: fake.origin,
    dataDir: dir,
    knownHostsPath,
    runProcess: fakeKeygen,
    probeSsh: async () => true,
    now: () => clock.now,
    sleep: async (ms) => { clock.now += ms; },
    random: () => 0.5,
    openExternal: async () => {},
    ...overrides,
  });
  return { boat, vault, dir, clock, knownHostsPath };
}

function fakeClient({ profile = null, paired = false } = {}) {
  let current = profile ? normalizeCloudProfile(profile) : null;
  let isPaired = paired;
  const calls = { health: 0, sessions: 0, saved: [], activated: [], redeemed: 0, putAuth: [], commands: [] };
  return {
    calls,
    loadProfile: async () => current,
    isPaired: async () => isPaired,
    loadServerMode: async () => null,
    saveServerMode: async (mode) => mode,
    deviceId: async () => 'device-1',
    health: async (override) => {
      calls.health += 1;
      return { ok: true, protocolVersion: 1, serverPublicKey: (override ?? current).serverPublicKey };
    },
    sessions: async () => { calls.sessions += 1; return []; },
    command: async (sessionId, type) => { calls.commands.push({ sessionId, type }); return {}; },
    redeemPairingCode: async () => {
      calls.redeemed += 1;
      return { credentials: { accessToken: 'access', refreshToken: 'refresh', device: { id: 'device-1' } } };
    },
    activateProfile: async (next, options) => {
      calls.activated.push({ profile: next, options });
      current = normalizeCloudProfile(next);
      isPaired = true;
      return current;
    },
    saveProfile: async (next) => {
      calls.saved.push(next);
      current = normalizeCloudProfile(next);
      return current;
    },
    forgetProfile: async () => { current = null; isPaired = false; return true; },
    putProviderAuth: async (provider) => { calls.putAuth.push(provider); return { ok: true }; },
  };
}

const store = () => ({ load: async () => [], list: async () => [], get: async () => null, flush: async () => {} });

function boatProfile(sandboxId, host = '198.51.100.7', keyPath = '/tmp/rauhwpx-boat-key') {
  return {
    mode: 'self-hosted',
    name: 'boat',
    ssh: { host, user: 'user', port: 22, keyPath },
    transport: 'ssh-tunnel',
    serverPublicKey: SERVER_KEY,
    boat: { sandboxId, machine: 'default', createdAt: '2026-09-27T09:00:00.000Z' },
  };
}

async function eventually(check, { attempts = 200 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition was not reached');
}

test('boat helpers map states, hours, links and host env', () => {
  assert.equal(boatServerState('idle'), 'running');
  assert.equal(boatServerState('provisioning'), 'waking');
  assert.equal(boatServerState('archiving'), 'stopping');
  assert.equal(boatServerState('archived'), 'stopped');
  assert.equal(boatServerState('cancelled'), 'missing');
  assert.equal(monthHours(45_000), 12.5);
  assert.equal(monthHours(null), null);
  assert.equal(isAllowedBoatLink('https://boat.dev/dashboard'), true);
  assert.equal(isAllowedBoatLink('https://checkout.stripe.com/c/pay/cs_1', { kind: 'checkout' }), true);
  assert.equal(isAllowedBoatLink('https://checkout.stripe.com/c/pay/cs_1', { kind: 'dashboard' }), false);
  assert.equal(isAllowedBoatLink('https://evil.example/boat.dev'), false);
  assert.equal(isAllowedBoatLink('http://boat.dev/dashboard'), false);
  assert.deepEqual(boatHostEnv({ sandboxId: 'bx_23456789' }), {
    RAUHWpx_HOST_KIND: 'boat',
    RAUHWpx_BOAT_SANDBOX_ID: 'bx_23456789',
    RAUHWpx_BOAT_IDLE_MINUTES: '30',
    RAUHWpx_BOAT_USER: 'user',
  });
});

test('boat profiles are ssh-tunnel self-hosted profiles with a boat id', () => {
  const profile = normalizeCloudProfile(boatProfile('bx_23456789'));
  assert.equal(profile.id, 'boat:bx_23456789');
  assert.equal(profile.transport, 'ssh-tunnel');
  assert.equal(profile.ssh.useTailscaleSsh, false);
  assert.deepEqual(profile.boat, {
    sandboxId: 'bx_23456789', machine: 'default', createdAt: '2026-09-27T09:00:00.000Z', autoStop: 'timer',
  }, 'a profile without verified self-stop tooling keeps the timer');
  assert.equal(normalizeCloudProfile(JSON.parse(JSON.stringify(profile))).boat.sandboxId, 'bx_23456789');
  const idle = normalizeCloudProfile({ ...boatProfile('bx_23456789'), boat: { sandboxId: 'bx_23456789', autoStop: 'idle' } });
  assert.equal(normalizeCloudProfile(JSON.parse(JSON.stringify(idle))).boat.autoStop, 'idle', 'the capability persists');
  assert.throws(() => normalizeCloudProfile({ ...boatProfile('bx_23456789'), boat: { sandboxId: 'bx_BAD' } }), /sandbox id/);
  assert.throws(() => normalizeCloudProfile({ ...boatProfile('bx_23456789'), boat: { sandboxId: 'bx_23456789', machine: 'large' } }), /machine/);
  assert.throws(() => normalizeCloudProfile({
    ...boatProfile('bx_23456789'),
    transport: 'public-https',
    endpoint: 'https://cloud.example/rauhwpx-cloud',
  }), /SSH tunnel/);
});

test('provisioner passes validated boat host env to every install path', () => {
  const hostEnv = normalizeHostEnv(boatHostEnv({ sandboxId: 'bx_23456789', idleMinutes: 45 }), { transport: 'ssh-tunnel' });
  const plain = provisionerTest.installRemoteCommand({ channel: 'stable', transport: 'ssh-tunnel', hostEnv });
  assert.match(plain, /RAUHWpx_HOST_KIND=boat RAUHWpx_BOAT_SANDBOX_ID=bx_23456789 RAUHWpx_BOAT_IDLE_MINUTES=45 RAUHWpx_BOAT_USER=user bash -s$/);
  const bundled = provisionerTest.bundledInstallRemoteCommand({
    channel: 'stable', transport: 'ssh-tunnel', assetArchitecture: 'amd64', hostEnv,
  });
  assert.match(bundled, /RAUHWpx_BOAT_SANDBOX_ID=bx_23456789 .*RAUHWpx_RELEASE_URL=/);
  const reuse = provisionerTest.existingInstallRemoteCommand({ transport: 'ssh-tunnel', hostEnv });
  assert.match(reuse, /rauhwpx-boat-idle\.timer/);
  assert.ok(reuse.indexOf('rauhwpx-boat.env') < reuse.indexOf('pairing create'));
  assert.doesNotMatch(provisionerTest.existingInstallRemoteCommand({ transport: 'ssh-tunnel' }), /boat/);
  assert.doesNotMatch(provisionerTest.installRemoteCommand({ channel: 'stable', transport: 'ssh-tunnel' }), /BOAT/);

  for (const bad of [
    { RAUHWpx_HOST_KIND: 'boat', RAUHWpx_BOAT_SANDBOX_ID: 'bx_2345678;rm' },
    { RAUHWpx_HOST_KIND: 'boat', RAUHWpx_BOAT_SANDBOX_ID: 'bx_23456789', RAUHWpx_BOAT_IDLE_MINUTES: '0x1e' },
    { RAUHWpx_HOST_KIND: 'boat', RAUHWpx_BOAT_SANDBOX_ID: 'bx_23456789', RAUHWpx_BOAT_IDLE_MINUTES: 1 },
    { RAUHWpx_HOST_KIND: 'boat', RAUHWpx_BOAT_SANDBOX_ID: 'bx_23456789', RAUHWpx_BOAT_USER: 'user $(id)' },
    { RAUHWpx_HOST_KIND: 'boat', RAUHWpx_BOAT_SANDBOX_ID: 'bx_23456789', PATH: '/tmp' },
    { RAUHWpx_HOST_KIND: 'vps' },
    { RAUHWpx_BOAT_SANDBOX_ID: 'bx_23456789' },
  ]) {
    assert.throws(() => normalizeHostEnv(bad, { transport: 'ssh-tunnel' }), JSON.stringify(bad));
  }
  assert.throws(() => normalizeHostEnv(boatHostEnv({ sandboxId: 'bx_23456789' }), { transport: 'tailscale' }), /SSH tunnel/);
});

test('the reuse probe accepts the installer env file and rejects another sandbox', { skip: spawnSync('bash', ['-c', 'true']).status !== 0 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rauhwpx-boat-probe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const hostEnv = normalizeHostEnv(boatHostEnv({ sandboxId: 'bx_23456789' }), { transport: 'ssh-tunnel' });
  const cases = {
    installer: 'RAUHWpx_BOAT_SANDBOX_ID=bx_23456789\nRAUHWpx_BOAT_IDLE_MINUTES=30\nRAUHWpx_BOAT_USER=user\n',
    quoted: 'BOAT_SANDBOX_ID="bx_23456789"\nBOAT_IDLE_MINUTES=\'30\'\nBOAT_USER=user\n',
    other: 'RAUHWpx_BOAT_SANDBOX_ID=bx_99999999\nRAUHWpx_BOAT_IDLE_MINUTES=30\nRAUHWpx_BOAT_USER=user\n',
  };
  const results = {};
  for (const [name, contents] of Object.entries(cases)) {
    const file = path.join(dir, `${name}.env`);
    await writeFile(file, contents);
    const lines = provisionerTest.boatConfigProbe(hostEnv, file).filter((line) => !line.includes('systemctl'));
    const script = `sudo() { shift; "$@"; }; set -eu; ${lines.join('; ')}; echo MATCH`;
    results[name] = spawnSync('bash', ['-c', script], { encoding: 'utf8' }).stdout.trim();
  }
  assert.deepEqual(results, { installer: 'MATCH', quoted: 'MATCH', other: '' });
});

test('email sign-in handles pending, slow_down, expiry re-claim, success and restart', async (t) => {
  const fake = await startFakeBoat(t);
  const { boat, vault, clock } = await makeBoat(t, fake);
  const challenge = await boat.startEmailSignIn('signer@example.com');
  assert.equal(challenge.userCode, '123456');
  assert.equal(challenge.intervalSeconds, 5);
  assert.match(challenge.verificationUri, /claim_attempt_token=cat_1$/);
  assert.equal(JSON.stringify(challenge).includes('clm_'), false, 'claim token never leaves main');

  fake.state.claimPolls.push('pending', 'slow_down', 'expired');
  assert.deepEqual(await boat.pollSignIn(challenge.claimId), { status: 'pending' });
  assert.deepEqual(await boat.pollSignIn(challenge.claimId), { status: 'pending' }, 'polls inside the interval wait locally');
  assert.equal(fake.requests('POST', '/api/boat/oauth2/token').length, 1);
  clock.now += 5_000;
  assert.deepEqual(await boat.pollSignIn(challenge.claimId), { status: 'pending' });
  clock.now += 5_000;
  assert.deepEqual(await boat.pollSignIn(challenge.claimId), { status: 'pending' }, 'slow_down adds five seconds');
  assert.equal(fake.requests('POST', '/api/boat/oauth2/token').length, 2);
  clock.now += 5_000;
  assert.deepEqual(await boat.pollSignIn(challenge.claimId), { status: 'expired' });

  const renewed = await boat.startEmailSignIn('signer@example.com');
  assert.equal(fake.state.claimCount, 1, 'an expired code re-claims instead of registering again');
  assert.equal(fake.state.reclaims, 1);
  assert.equal(renewed.userCode, '654321');
  assert.notEqual(renewed.claimId, challenge.claimId);
  assert.deepEqual(await boat.pollSignIn(challenge.claimId), { status: 'expired' });

  fake.state.claimPolls.push('success');
  assert.deepEqual(await boat.pollSignIn(renewed.claimId), { status: 'connected' });
  assert.deepEqual(await boat.accountSnapshot(), {
    connected: true, method: 'email', email: 'signer@example.com', canStart: true, trial: false,
  });
  const stored = vault.values.get('cloud.boat.account');
  assert.match(stored, /boat_email_1_1/);

  const restarted = new BoatCloud({
    vault, origin: fake.origin, dataDir: '/unused', knownHostsPath: '/unused/known', now: () => clock.now,
  });
  assert.equal((await restarted.accountSnapshot()).connected, true, 'the account survives a restart');
});

test('email tokens refresh with the identity assertion before expiry and after a 401', async (t) => {
  const fake = await startFakeBoat(t);
  const { boat, clock } = await makeBoat(t, fake);
  const challenge = await boat.startEmailSignIn('signer@example.com');
  fake.state.claimPolls.push('success');
  assert.equal((await boat.pollSignIn(challenge.claimId)).status, 'connected');

  clock.now += 3_590_000;
  await boat.me();
  const refreshes = fake.requests('POST', '/api/boat/oauth2/token')
    .filter((entry) => entry.body.grant_type === 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].body.assertion, fake.state.assertion);
  assert.equal(refreshes[0].body.resource, `${fake.origin}/api/v1/`);
  assert.equal(fake.requests('GET', '/api/v1/me').at(-1).headers.authorization, 'Bearer boat_rotated_1');

  // boat revoked the live key (for example after a rotation elsewhere): one refresh, then retry.
  fake.state.tokens.delete('boat_rotated_1');
  await boat.me();
  assert.equal(fake.requests('GET', '/api/v1/me').at(-1).headers.authorization, 'Bearer boat_rotated_2');
  assert.equal((await boat.accountSnapshot()).connected, true);

  fake.state.assertion = 'eyJrotated.elsewhere.sig';
  fake.state.tokens.delete('boat_rotated_2');
  await assert.rejects(boat.me(), { code: 'BOAT_AUTH_INVALID' });
  assert.equal((await boat.accountSnapshot()).connected, false);
});

test('API key connection validates the key and never retries a bad one', async (t) => {
  const fake = await startFakeBoat(t);
  const { boat } = await makeBoat(t, fake);
  await assert.rejects(boat.connectApiKey('boat_wrong_key_1'), (error) => (
    error.code === 'BOAT_AUTH_INVALID' && error.message === 'API 키가 올바르지 않습니다.'
  ));
  await assert.rejects(boat.connectApiKey('short'), { code: 'BOAT_AUTH_INVALID' });
  assert.equal(fake.requests('GET', '/api/v1/me').length, 1);
  const account = await boat.connectApiKey(` ${API_KEY} `);
  assert.deepEqual(account, { connected: true, method: 'api-key', email: 'owner@example.com', canStart: true, trial: false });
});

test('create is idempotent across a lost response and never makes a second VM', async (t) => {
  const fake = await startFakeBoat(t, { failNextCreateAfterCommit: true });
  const { boat } = await makeBoat(t, fake);
  await boat.connectApiKey(API_KEY);
  const sandbox = await boat.createSandbox({ machine: 'default', idempotencyKey: 'c0ffee00-1111-4222-8333-444455556666' });
  const creates = fake.requests('POST', '/api/v1/sandboxes');
  assert.equal(creates.length, 2);
  assert.equal(fake.state.sandboxes.size, 1);
  assert.equal(sandbox.id, [...fake.state.sandboxes.keys()][0]);
  assert.ok(creates.every((entry) => entry.headers['idempotency-key'] === 'c0ffee00-1111-4222-8333-444455556666'));
  assert.equal(creates[0].raw, creates[1].raw);
  assert.deepEqual(creates[0].body, { name: 'Rauhwpx Cloud', type: 'default', ttlSeconds: 7200 });
  assert.equal('noEnv' in creates[0].body, false);
});

test('ensureRunning handles ready, archived, archiving, missing, billing and failed VMs', async (t) => {
  const fake = await startFakeBoat(t);
  const { boat } = await makeBoat(t, fake);
  await boat.connectApiKey(API_KEY);

  const ready = fake.addSandbox({ state: 'ready' });
  assert.equal((await boat.ensureRunning(ready.id)).resumed, false);
  assert.equal(fake.requests('POST', `/api/v1/sandboxes/${ready.id}/resume`).length, 0);

  const archived = fake.addSandbox({ state: 'archived', snapshotAvailable: true });
  const woke = await boat.ensureRunning(archived.id);
  assert.equal(woke.resumed, true);
  assert.equal(woke.sandbox.state, 'ready');
  const resumes = fake.requests('POST', `/api/v1/sandboxes/${archived.id}/resume`);
  assert.equal(resumes.length, 1);
  assert.deepEqual(resumes[0].body, { ttlSeconds: null });

  const archiving = fake.addSandbox({ state: 'archiving', snapshotAvailable: true });
  const seen = [];
  const after = await boat.ensureRunning(archiving.id, { onState: (sandbox) => seen.push(sandbox.state) });
  assert.equal(after.resumed, true);
  assert.deepEqual(seen.slice(0, 2), ['archiving', 'archived']);
  assert.equal(fake.requests('POST', `/api/v1/sandboxes/${archiving.id}/resume`).length, 1);

  const cancelled = fake.addSandbox({ state: 'cancelled' });
  await assert.rejects(boat.ensureRunning(cancelled.id), { code: 'BOAT_SERVER_MISSING' });
  await assert.rejects(boat.ensureRunning('bx_zzzzzzzz'), { code: 'BOAT_SERVER_MISSING' });

  const stopped = fake.addSandbox({ state: 'archived', snapshotAvailable: true });
  await assert.rejects(boat.ensureRunning(stopped.id, { allowResume: false }), { code: 'BOAT_SERVER_STOPPED' });
  fake.state.billingRequiredOnResume = true;
  await assert.rejects(boat.ensureRunning(stopped.id), (error) => (
    error.code === 'BOAT_BILLING_REQUIRED' && error.message === 'boat 요금제가 필요합니다.'
  ));
  fake.state.billingRequiredOnResume = false;

  const broken = fake.addSandbox({ state: 'error', snapshotAvailable: false, error: 'disk failed' });
  await assert.rejects(boat.ensureRunning(broken.id), { code: 'BOAT_SERVER_FAILED' });
});

test('trial accounts fall back to a two-hour auto-stop on resume and after setup', async (t) => {
  const fake = await startFakeBoat(t, { trial: true });
  const { boat } = await makeBoat(t, fake);
  await boat.connectApiKey(API_KEY);
  const sandbox = fake.addSandbox({ state: 'archived', snapshotAvailable: true });
  await boat.ensureRunning(sandbox.id);
  assert.deepEqual(fake.requests('POST', `/api/v1/sandboxes/${sandbox.id}/resume`).map((entry) => entry.body), [
    { ttlSeconds: null },
    { ttlSeconds: 7200 },
  ]);
  await boat.setAutoStop(sandbox.id, null);
  assert.deepEqual(fake.requests('PATCH', `/api/v1/sandboxes/${sandbox.id}`).map((entry) => entry.body).filter((body) => 'ttlSeconds' in body), [
    { ttlSeconds: null },
    { ttlSeconds: 7200 },
  ]);
  assert.equal(fake.state.sandboxes.get(sandbox.id).ttlSeconds, 7200);
});

test('known trial limits cap auto-stop up front, and unknown auto-stop refusals still fall back', async (t) => {
  const fake = await startFakeBoat(t, { trial: true });
  fake.state.limits = { ...fake.state.limits, accessTier: 'trial', sandboxPlanKey: 'trial' };
  const { boat } = await makeBoat(t, fake);
  await boat.connectApiKey(API_KEY);
  const sandbox = fake.addSandbox({ state: 'archived', snapshotAvailable: true });
  await boat.ensureRunning(sandbox.id);
  assert.deepEqual(fake.requests('POST', `/api/v1/sandboxes/${sandbox.id}/resume`).map((entry) => entry.body), [
    { ttlSeconds: 7200 },
  ], 'a trial account never asks for an auto-stop it cannot have');

  const other = await startFakeBoat(t, { trial: true });
  other.state.trialRefusalCode = 'invalid_ttl';
  other.state.trialRefusalMessage = 'Trial sandboxes must auto-stop within 2 hours';
  const { boat: unknownBoat } = await makeBoat(t, other);
  await unknownBoat.connectApiKey(API_KEY);
  const resting = other.addSandbox({ state: 'archived', snapshotAvailable: true });
  await unknownBoat.ensureRunning(resting.id);
  assert.deepEqual(other.requests('POST', `/api/v1/sandboxes/${resting.id}/resume`).map((entry) => entry.body), [
    { ttlSeconds: null },
    { ttlSeconds: 7200 },
  ]);
});

test('host keys are read through the commands API and pinned, replacing stale lines', async (t) => {
  const fake = await startFakeBoat(t);
  const { boat, knownHostsPath } = await makeBoat(t, fake);
  await boat.connectApiKey(API_KEY);
  const sandbox = fake.addSandbox({ state: 'ready' });
  const newIp = sandbox.ip;
  const salt = randomBytes(20);
  const hashed = `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(newIp).digest('base64')}`;
  await writeFile(knownHostsPath, [
    `198.51.100.1 ssh-ed25519 ${sshBlob('ssh-ed25519')} rauhwpx-boat:${sandbox.id}`,
    `${newIp} ssh-rsa ${sshBlob('ssh-rsa')}`,
    `${hashed} ssh-ed25519 ${sshBlob('ssh-ed25519')}`,
    `other.example ssh-ed25519 ${sshBlob('ssh-ed25519')}`,
    '',
  ].join('\n'));

  const ssh = await boat.prepareSsh(sandbox.id);
  assert.deepEqual({ host: ssh.host, port: ssh.port, user: ssh.user }, { host: newIp, port: 22, user: 'user' });
  assert.equal(ssh.keyPath, boat.sshKeyPath);
  assert.match(fake.state.sandboxes.get(sandbox.id).keys[0], /^ssh-ed25519 [A-Za-z0-9+/=]+ rauhwpx-boat$/);
  const newPin = `${newIp} ssh-ed25519 ${fake.state.hostKeys[0].key} rauhwpx-boat:${sandbox.id}`;
  let lines = (await readFile(knownHostsPath, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 3, 'the old address stays pinned until the profile moves');
  assert.match(lines[0], /^198\.51\.100\.1 /);
  assert.match(lines[1], /^other\.example /);
  assert.equal(lines[2], newPin);
  assert.equal(await boat.hasPin(sandbox.id, ssh), true);
  await boat.prunePins(sandbox.id, ssh);
  lines = (await readFile(knownHostsPath, 'utf8')).trim().split('\n');
  assert.deepEqual(lines.slice(1), [newPin]);
  assert.match(lines[0], /^other\.example /);
  if (process.platform !== 'win32') {
    assert.equal((await stat(knownHostsPath)).mode & 0o777, 0o600);
    assert.equal((await stat(boat.sshKeyPath)).mode & 0o777, 0o600);
  }

  assert.equal(knownHostsPattern('203.0.113.9', 22001), '[203.0.113.9]:22001');
  assert.equal(knownHostsPattern('2001:db8::1', 22), '2001:db8::1');
  fake.state.sandboxes.get(sandbox.id).sshEndpoint = '192.0.2.44:22001';
  const forwarded = await boat.prepareSsh(sandbox.id);
  assert.deepEqual([forwarded.host, forwarded.port], ['192.0.2.44', 22001]);
  await boat.prunePins(sandbox.id, forwarded);
  const pinned = await readFile(knownHostsPath, 'utf8');
  assert.match(pinned, /^\[192\.0\.2\.44\]:22001 ssh-ed25519 /m);
  assert.doesNotMatch(pinned, new RegExp(`^${newIp.replaceAll('.', '\\.')} `, 'm'), 'the previous address is unpinned');

  fake.state.apiHostKey = { type: 'ssh-ed25519', key: sshBlob('ssh-ed25519') };
  await assert.rejects(boat.prepareSsh(sandbox.id), { code: 'BOAT_HOST_KEY_UNVERIFIED' });

  await boat.removePins(sandbox.id);
  assert.doesNotMatch(await readFile(knownHostsPath, 'utf8'), /rauhwpx-boat:/);
  assert.deepEqual(parseHostKeys(`ssh-ed25519 ${sshBlob('ssh-rsa')}\nnot a key\n`), [], 'the blob type must match');
  assert.equal(rewriteKnownHosts('@revoked 203.0.113.10 ssh-ed25519 AAAA\n', {
    sandboxId: sandbox.id, pattern: '203.0.113.10', keys: [],
  }), '@revoked 203.0.113.10 ssh-ed25519 AAAA\n');
});

test('ssh-keygen creates a private ed25519 identity', { skip: spawnSync('ssh-keygen', ['-?']).error ? 'ssh-keygen unavailable' : false }, async (t) => {
  const fake = await startFakeBoat(t);
  const { boat } = await makeBoat(t, fake, { runProcess: undefined });
  const identity = await boat.ensureSshIdentity();
  assert.match(identity.publicKey, /^ssh-ed25519 [A-Za-z0-9+/=]+ rauhwpx-boat$/);
  if (process.platform !== 'win32') assert.equal((await stat(identity.privateKeyPath)).mode & 0o777, 0o600);
  assert.equal((await boat.ensureSshIdentity()).publicKey, identity.publicKey, 'the key is reused');
});

test('deleting a VM sends the confirmation header and polls the deletion operation', async (t) => {
  const fake = await startFakeBoat(t);
  const { boat } = await makeBoat(t, fake);
  await boat.connectApiKey(API_KEY);
  const sandbox = fake.addSandbox({ state: 'ready' });
  const result = await boat.deleteSandbox(sandbox.id);
  assert.equal(result.completed, true);
  assert.equal(result.operation.status, 'completed');
  const [request] = fake.requests('DELETE', `/api/v1/sandboxes/${sandbox.id}`);
  assert.equal(request.headers['x-ascii-confirm-delete'], sandbox.id);
  assert.equal(fake.requests('GET', /^\/api\/v1\/deletion-operations\//).length, 2);
  assert.deepEqual(await boat.deleteSandbox(sandbox.id), { completed: true, operation: null }, 'a missing VM is already gone');
});

test('status cadence refreshes only while wanted', () => {
  const ticks = [];
  let wanted = false;
  let refreshes = 0;
  const stop = installBoatStatusCadence({
    isWanted: () => wanted,
    refresh: () => { refreshes += 1; },
    setIntervalImpl: (callback) => { ticks.push(callback); return { unref() {} }; },
    clearIntervalImpl: () => {},
  });
  ticks[0]();
  wanted = true;
  ticks[0]();
  stop();
  ticks[0]();
  assert.equal(refreshes, 1);
});

test('background paths report a stopped boat VM and never resume it; user intent does', async (t) => {
  const fake = await startFakeBoat(t);
  const { boat, clock } = await makeBoat(t, fake);
  await boat.connectApiKey(API_KEY);
  const sandbox = fake.addSandbox({ state: 'archived', snapshotAvailable: true });
  const client = fakeClient({ profile: boatProfile(sandbox.id), paired: true });
  const coordinator = new CloudCoordinator({ client, store: store(), recoveryDir: '/unused', boat });
  t.after(() => coordinator.stop());
  await coordinator.start();
  await eventually(async () => (await coordinator.snapshot()).boat?.server?.state === 'stopped');

  for (const reason of ['startup', 'unlock', 'resume', 'online', 'cadence']) {
    await coordinator.reconcileContinuity({ reason });
  }
  await coordinator.reconnectCloud({ background: true });
  await coordinator.reconnectCloud();
  await coordinator.refresh();
  await coordinator.prewarmAppServer({ reason: 'keep-warm' });
  await coordinator.refreshBoatStatus({ force: true });
  clock.now += 60_000;

  assert.equal(fake.requests('POST', /\/resume$/).length, 0, 'background paths never resume');
  assert.equal(client.calls.health, 0, 'no tunnel is dialed to a stopped VM');
  assert.equal(client.calls.sessions, 0);
  const quiet = await coordinator.snapshot();
  assert.equal(quiet.boat.server.state, 'stopped');
  assert.equal(quiet.boat.server.monthHours, 12.5);
  assert.equal(quiet.link.kind, 'ready');

  const events = [];
  coordinator.on('event', (event) => events.push(event));
  await coordinator.command({ sessionId: 'session_12345678', command: 'pause' });
  assert.equal(fake.requests('POST', /\/resume$/).length, 1, 'sending in a Cloud session wakes the VM');
  assert.deepEqual(client.calls.commands.map((entry) => entry.type), ['session.pause']);
  assert.ok(events.some((event) => event.type === 'boat-changed' && event.state === 'waking'));
  const running = await coordinator.snapshot();
  assert.equal(running.boat.server.state, 'running');
  assert.equal(running.link.kind, 'ready');
  const woken = fake.state.sandboxes.get(sandbox.id);
  assert.equal(running.profile.profile.host, woken.ip, 'the new address is saved');
  assert.equal(client.calls.activated.length, 0, 'the device stays paired');
  assert.equal(client.calls.redeemed, 0);
  assert.equal(client.calls.saved.length, 1);

  await coordinator.command({ sessionId: 'session_12345678', command: 'resume' });
  assert.equal(fake.requests('POST', /\/resume$/).length, 1, 'a running VM is not resumed again');
  assert.equal(fake.requests('POST', /\/sshkey$/).length, 1, 'a pinned machine is not re-registered');
});

test('a VM that stops itself while connected turns the failed link check into a quiet stopped state', async (t) => {
  const fake = await startFakeBoat(t);
  const { boat } = await makeBoat(t, fake);
  await boat.connectApiKey(API_KEY);
  const sandbox = fake.addSandbox({ state: 'ready' });
  // Setup left this address pinned, so startup trusts it without re-registering.
  await boat.pinHostKeys({ sandboxId: sandbox.id, host: sandbox.ip, keys: fake.state.hostKeys });
  const client = fakeClient({ profile: boatProfile(sandbox.id, sandbox.ip), paired: true });
  let reachable = true;
  client.health = async (override) => {
    client.calls.health += 1;
    if (!reachable) throw Object.assign(new Error('SSH tunnel exited with 255'), { code: 'SSH_TUNNEL_UNAVAILABLE', retryable: true });
    return { ok: true, protocolVersion: 1, serverPublicKey: (override ?? await client.loadProfile()).serverPublicKey };
  };
  const coordinator = new CloudCoordinator({ client, store: store(), recoveryDir: '/unused', boat });
  t.after(() => coordinator.stop());
  await coordinator.start();
  await eventually(async () => (await coordinator.snapshot()).boat?.server?.state === 'running');

  // The in-VM idle timer archived it; the next heal only reads boat state.
  Object.assign(fake.state.sandboxes.get(sandbox.id), { state: 'archived', ip: null, snapshotAvailable: true });
  reachable = false;
  const healed = await coordinator.reconnectCloud();
  assert.equal(healed.boat.server.state, 'stopped');
  assert.equal(healed.link.kind, 'ready');
  assert.equal(fake.requests('POST', /\/resume$/).length, 0);
  const probes = client.calls.health;
  await coordinator.reconcileContinuity({ reason: 'cadence' });
  await coordinator.reconnectCloud({ background: true });
  assert.equal(client.calls.health, probes, 'no further tunnel attempts while stopped');
});

test('boat stop and explicit wake report their transitions', async (t) => {
  const fake = await startFakeBoat(t, { getsToArchive: 1 });
  const { boat } = await makeBoat(t, fake);
  await boat.connectApiKey(API_KEY);
  const sandbox = fake.addSandbox({ state: 'ready' });
  const client = fakeClient({ profile: boatProfile(sandbox.id, sandbox.ip), paired: true });
  const coordinator = new CloudCoordinator({ client, store: store(), recoveryDir: '/unused', boat });
  t.after(() => coordinator.stop());
  const stopping = await coordinator.boatStop();
  assert.equal(stopping.boat.server.state, 'stopping');
  assert.equal(fake.requests('POST', `/api/v1/sandboxes/${sandbox.id}/stop`).length, 1);
  await coordinator.boatRefresh();
  assert.equal((await coordinator.snapshot()).boat.server.state, 'stopped');

  const woke = await coordinator.boatWake();
  assert.equal(woke.boat.server.state, 'running');
  assert.equal(fake.requests('POST', `/api/v1/sandboxes/${sandbox.id}/resume`).length, 1);
});

test('setup creates the VM, installs with boat host env, pairs and imports every login', async (t) => {
  const fake = await startFakeBoat(t);
  const { boat, vault, knownHostsPath } = await makeBoat(t, fake);
  await boat.connectApiKey(API_KEY);
  const client = fakeClient();
  const provisionCalls = [];
  const provisioner = {
    provision: async (ssh, options) => {
      provisionCalls.push({ ssh, options });
      options.onLine('Installing podman');
      options.onLine('RAUHWpx_RECEIPT={"pairingCode":"ABCD-EFGH-JKLM"}');
      return {
        endpoint: 'http://127.0.0.1:7740/rauhwpx-cloud',
        serverPublicKey: SERVER_KEY,
        pairingCode: 'ABCD-EFGH-JKLM',
        transport: 'ssh-tunnel',
      };
    },
  };
  const coordinator = new CloudCoordinator({
    client,
    store: store(),
    recoveryDir: '/unused',
    provisioner,
    boat,
    collectImportedAuth: async (provider) => (provider === 'pi'
      ? null
      : { secrets: {}, files: { [`.${provider}/auth.json`]: '{"token":"x"}' } }),
  });
  t.after(() => coordinator.stop());
  const stages = [];
  const details = [];
  coordinator.on('event', (event) => {
    if (event.type === 'boat-setup-progress') stages.push(event.stage);
  });
  coordinator.on('event', async (event) => {
    if (event.type === 'boat-changed') details.push((await coordinator.snapshot()).boat?.setup?.detail ?? null);
  });

  const snapshot = await coordinator.boatSetup({ machine: 'default' });
  assert.deepEqual([...new Set(stages)], ['creating', 'starting', 'installing', 'pairing', 'credentials', 'done']);
  assert.equal(fake.requests('POST', '/api/v1/sandboxes').length, 1);
  const [sandbox] = fake.state.sandboxes.values();
  // boat 가 생성 이름을 무시하므로 만든 뒤 이름을 바꿔 다른 Mac 이 찾을 수 있어야 한다.
  assert.equal(sandbox.name, BOAT_SANDBOX_NAME);
  assert.equal((await boat.findRauhwpxSandbox())?.id, sandbox.id);
  assert.equal(provisionCalls.length, 1);
  const [{ ssh, options }] = provisionCalls;
  assert.deepEqual({ host: ssh.host, port: ssh.port, user: ssh.user }, { host: sandbox.ip, port: 22, user: 'user' });
  assert.equal(ssh.keyPath, boat.sshKeyPath);
  assert.equal(options.transport, 'ssh-tunnel');
  assert.deepEqual(options.hostEnv, boatHostEnv({ sandboxId: sandbox.id }));
  assert.match(await readFile(knownHostsPath, 'utf8'), new RegExp(`rauhwpx-boat:${sandbox.id}`));
  assert.equal(client.calls.redeemed, 1);
  assert.equal(client.calls.activated.length, 1);
  assert.equal(client.calls.activated[0].profile.boat.sandboxId, sandbox.id);
  assert.equal(client.calls.activated[0].profile.id, `boat:${sandbox.id}`);
  assert.deepEqual(client.calls.putAuth, ['claude', 'codex']);
  const [probe] = fake.requests('POST', `/api/v1/sandboxes/${sandbox.id}/commands`)
    .filter((entry) => entry.body.command.includes('--probe'));
  assert.match(probe.body.command, /sudo -n \/bin\/bash "\$f" --probe/, 'self-stop tooling is verified after install');
  assert.equal(snapshot.profile.profile.boat.autoStop, undefined, 'the UI profile stays minimal');
  assert.equal(client.calls.activated[0].profile.boat.autoStop, 'idle');
  assert.deepEqual(fake.requests('PATCH', `/api/v1/sandboxes/${sandbox.id}`).map((entry) => entry.body).filter((body) => 'ttlSeconds' in body), [{ ttlSeconds: null }]);
  assert.deepEqual(snapshot.boat.setup.importedProviders, ['claude', 'codex']);
  assert.equal(snapshot.boat.setup.stage, 'done');
  assert.equal(snapshot.boat.setup.error, null);
  assert.equal(snapshot.boat.server.sandboxId, sandbox.id);
  assert.equal(snapshot.boat.server.machineLabel, '4 vCPU · 8 GB');
  assert.equal(snapshot.boat.server.region, 'EU');
  assert.equal(snapshot.boat.server.idleStopMinutes, 30);
  assert.equal(snapshot.boat.server.autoStop, 'idle');
  assert.equal(snapshot.boat.server.timerHours, null);
  assert.equal(snapshot.profile.profile.boat.sandboxId, sandbox.id);
  assert.equal(vault.values.has('cloud.boat.setup'), false, 'the setup journal is cleared');
  assert.ok(details.every((detail) => !detail || !/RAUHWpx_RECEIPT|ABCD-EFGH/.test(detail)), 'receipts never reach the renderer');
  assert.equal(JSON.stringify(snapshot).includes(API_KEY), false);
});

test('a second Mac adopts the existing VM, and an interrupted setup resumes after a restart', async (t) => {
  const fake = await startFakeBoat(t);
  const { boat, vault } = await makeBoat(t, fake);
  await boat.connectApiKey(API_KEY);
  const existing = fake.addSandbox({ state: 'archived', snapshotAvailable: true, type: 'default' });
  fake.addSandbox({ name: 'Other work', state: 'ready' });
  let failInstall = true;
  const provisioner = {
    provision: async () => {
      if (failInstall) throw new Error('ssh exited with 255: connection closed');
      return { endpoint: 'http://127.0.0.1:7740/rauhwpx-cloud', serverPublicKey: SERVER_KEY, pairingCode: 'ABCD-EFGH-JKLM', transport: 'ssh-tunnel' };
    },
  };
  const firstClient = fakeClient();
  const first = new CloudCoordinator({ client: firstClient, store: store(), recoveryDir: '/unused', provisioner, boat });
  await assert.rejects(first.boatSetup({ machine: 'default' }), (error) => (
    error.code === 'BOAT_SETUP_FAILED' && error.message === 'boat 서버를 준비하지 못했습니다.'
  ));
  const failed = await first.snapshot();
  assert.equal(failed.boat.setup.stage, 'installing');
  assert.equal(failed.boat.setup.error.title, 'boat 서버를 준비하지 못했습니다');
  assert.match(failed.boat.setup.error.detail, /connection closed/);
  assert.equal(fake.requests('POST', '/api/v1/sandboxes').length, 0, 'the existing VM is adopted, not duplicated');
  assert.deepEqual(fake.requests('POST', `/api/v1/sandboxes/${existing.id}/resume`).map((entry) => entry.body), [{ ttlSeconds: 7200 }]);
  await first.stop();

  const restartedBoat = new BoatCloud({
    vault,
    origin: fake.origin,
    dataDir: path.dirname(boat.sshKeyPath).replace(/\/boat$/, ''),
    knownHostsPath: path.join(path.dirname(boat.sshKeyPath), '..', 'ssh-known-hosts'),
    runProcess: fakeKeygen,
    probeSsh: async () => true,
    sleep: async () => {},
  });
  const secondClient = fakeClient();
  const second = new CloudCoordinator({ client: secondClient, store: store(), recoveryDir: '/unused', provisioner, boat: restartedBoat });
  t.after(() => second.stop());
  await second.start();
  const restored = await second.snapshot();
  assert.equal(restored.boat.setup.stage, 'installing');
  assert.ok(restored.boat.setup.error, 'the interrupted stage is shown with a retry');
  failInstall = false;
  const done = await second.boatSetup({ machine: 'default' });
  assert.equal(done.boat.setup.stage, 'done');
  assert.equal(done.boat.server.sandboxId, existing.id);
  assert.equal(fake.requests('POST', '/api/v1/sandboxes').length, 0);
  assert.equal(secondClient.calls.activated[0].profile.boat.sandboxId, existing.id);
});

test('setup refuses to start without a plan and disconnect can delete the VM', async (t) => {
  const fake = await startFakeBoat(t);
  const { boat, vault } = await makeBoat(t, fake);
  await boat.connectApiKey(API_KEY);
  fake.state.limits = { ...fake.state.limits, canStart: false, accessTier: 'trial', sandboxPlanKey: 'trial' };
  const client = fakeClient();
  const coordinator = new CloudCoordinator({ client, store: store(), recoveryDir: '/unused', provisioner: {}, boat });
  t.after(() => coordinator.stop());
  await assert.rejects(coordinator.boatSetup({ machine: 'default' }), { code: 'BOAT_BILLING_REQUIRED' });
  const blocked = await coordinator.snapshot();
  assert.equal(blocked.boat.account.canStart, false);
  assert.equal(blocked.boat.account.trial, true);
  assert.equal(blocked.boat.setup, null);
  assert.equal(fake.requests('POST', '/api/v1/sandboxes').length, 0);

  const opened = [];
  const linked = new CloudCoordinator({
    client: fakeClient(),
    store: store(),
    recoveryDir: '/unused',
    boat: new BoatCloud({
      vault, origin: fake.origin, dataDir: '/unused', knownHostsPath: '/unused/known',
      openExternal: async (url) => { opened.push(url); },
    }),
  });
  t.after(() => linked.stop());
  assert.deepEqual(await linked.boatOpenLink({ kind: 'checkout' }), { opened: true });
  assert.deepEqual(await linked.boatOpenLink({ kind: 'api-keys' }), { opened: true });
  assert.deepEqual(opened, ['https://checkout.stripe.com/c/pay/cs_test_1', `${fake.origin}/dashboard?tab=api-keys`]);
  await assert.rejects(linked.boatOpenLink({ kind: 'verification', claimId: 'unknown' }), { code: 'BOAT_LINK_UNAVAILABLE' });

  const sandbox = fake.addSandbox({ state: 'ready' });
  const owned = fakeClient({ profile: boatProfile(sandbox.id, sandbox.ip), paired: true });
  const deleting = new CloudCoordinator({ client: owned, store: store(), recoveryDir: '/unused', boat });
  t.after(() => deleting.stop());
  const after = await deleting.boatDisconnect({ deleteServer: true });
  assert.equal(fake.state.sandboxes.has(sandbox.id), false);
  assert.equal(fake.requests('DELETE', `/api/v1/sandboxes/${sandbox.id}`)[0].headers['x-ascii-confirm-delete'], sandbox.id);
  assert.equal(await owned.loadProfile(), null);
  assert.equal(after.boat.account.connected, false);
  assert.equal(after.boat.server, null);
  assert.equal(vault.values.has('cloud.boat.account'), false);
});

test('only an explicit reconnect resumes a stopped VM; the IPC defaults to automatic', async (t) => {
  const fake = await startFakeBoat(t);
  const { boat } = await makeBoat(t, fake);
  await boat.connectApiKey(API_KEY);
  const sandbox = fake.addSandbox({ state: 'archived', snapshotAvailable: true });
  const client = fakeClient({ profile: boatProfile(sandbox.id), paired: true });
  const coordinator = new CloudCoordinator({ client, store: store(), recoveryDir: '/unused', boat });
  t.after(() => coordinator.stop());
  await coordinator.start();
  await eventually(async () => (await coordinator.snapshot()).boat?.server?.state === 'stopped');

  await coordinator.reconnectCloud({ userIntent: false });
  assert.equal(fake.requests('POST', /\/resume$/).length, 0, 'an automatic reconnect never resumes');
  const woke = await coordinator.reconnectCloud({ userIntent: true });
  assert.equal(fake.requests('POST', /\/resume$/).length, 1);
  assert.equal(woke.boat.server.state, 'running');

  const main = await readFile(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const preload = await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  assert.match(main, /cloud:reconnect-link'[\s\S]*?reconnectCloud\(\{\s*userIntent: payload\?\.explicit === true,\s*\}\)/);
  assert.match(preload, /cloudReconnectLink: \(payload\) => ipcRenderer\.invoke\('cloud:reconnect-link', \{\s*explicit: payload\?\.explicit === true,/);
  assert.match(preload, /cloudDownloadCheckpoint: \(payload\) => boatCall\('cloud:download-checkpoint', payload\)/);
});

test('a stream that fails because the VM stopped itself goes quiet instead of reconnecting', async (t) => {
  const fake = await startFakeBoat(t);
  const { boat } = await makeBoat(t, fake);
  await boat.connectApiKey(API_KEY);
  const sandbox = fake.addSandbox({ state: 'ready' });
  await boat.pinHostKeys({ sandboxId: sandbox.id, host: sandbox.ip, keys: fake.state.hostKeys });
  const client = fakeClient({ profile: boatProfile(sandbox.id, sandbox.ip), paired: true });
  client.sessions = async () => [{ id: 'session_12345678', status: 'running' }];
  let failStream = null;
  client.watchSession = (_sessionId, _after, { signal }) => new Promise((_resolve, reject) => {
    failStream = reject;
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  const coordinator = new CloudCoordinator({ client, store: store(), recoveryDir: '/unused', boat });
  t.after(() => coordinator.stop());
  await coordinator.start();
  await eventually(async () => (await coordinator.snapshot()).boat?.server?.state === 'running');
  await coordinator.reconnectCloud();
  await eventually(() => failStream !== null);

  const events = [];
  coordinator.on('event', (event) => events.push(event.type));
  Object.assign(fake.state.sandboxes.get(sandbox.id), { state: 'archived', ip: null, snapshotAvailable: true });
  const probes = client.calls.health;
  failStream(Object.assign(new Error('SSH tunnel disconnected'), { code: 'SSH_TUNNEL_UNAVAILABLE', retryable: true }));
  await eventually(async () => (await coordinator.snapshot()).boat.server.state === 'stopped');
  const quiet = await coordinator.snapshot();
  assert.equal(quiet.link.kind, 'ready');
  assert.ok(events.includes('remote-session-stream-error'));
  assert.equal(events.includes('cloud-link-reconnecting'), false, 'a stopped VM is not a broken link');
  assert.equal(client.calls.health, probes, 'nothing dials the stopped VM');
  assert.equal(fake.requests('POST', /\/resume$/).length, 0);
});

test('only a checkpoint fetch the user asked for wakes a stopped VM', async (t) => {
  const fake = await startFakeBoat(t);
  const { boat } = await makeBoat(t, fake);
  await boat.connectApiKey(API_KEY);
  const sandbox = fake.addSandbox({ state: 'archived', snapshotAvailable: true });
  const client = fakeClient({ profile: boatProfile(sandbox.id), paired: true });
  client.downloadCheckpoint = async (_sessionId, { operationId }) => ({
    name: 'doc.hwpx', bytes: Buffer.from('doc'), size: 3, sha256: 'a'.repeat(64), revision: 2, turn: 1,
    boundaryOperation: operationId ?? 'op_latest', boundaryKind: 'turn',
  });
  const coordinator = new CloudCoordinator({ client, store: store(), recoveryDir: '/unused', boat });
  t.after(() => coordinator.stop());
  await coordinator.start();
  await eventually(async () => (await coordinator.snapshot()).boat?.server?.state === 'stopped');

  const reads = fake.requests('GET', `/api/v1/sandboxes/${sandbox.id}`).length;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(coordinator.downloadCheckpoint({ sessionId: 'session_12345678' }), (error) => (
      error.code === 'BOAT_SERVER_STOPPED' && error.message === 'boat 서버가 정지되어 있습니다.'
    ));
  }
  assert.equal(fake.requests('GET', `/api/v1/sandboxes/${sandbox.id}`).length, reads, 'a known stop answers without boat calls');
  assert.equal(fake.requests('POST', /\/resume$/).length, 0);
  assert.equal(client.calls.health, 0);

  // 미러의 재시도처럼 operation id 가 있어도 사용자가 누르지 않은 요청은 깨우지 않는다.
  await assert.rejects(
    coordinator.downloadCheckpoint({ sessionId: 'session_12345678', operationId: 'op_merge' }),
    (error) => error.code === 'BOAT_SERVER_STOPPED',
  );
  assert.equal(fake.requests('POST', /\/resume$/).length, 0);

  const merged = await coordinator.downloadCheckpoint({
    sessionId: 'session_12345678', operationId: 'op_merge', explicit: true,
  });
  assert.equal(merged.operationId, 'op_merge');
  assert.equal(fake.requests('POST', /\/resume$/).length, 1, 'a merge the user asked for wakes the VM');
  const latest = await coordinator.downloadCheckpoint({ sessionId: 'session_12345678' });
  assert.equal(latest.operationId, 'op_latest', 'a running VM serves the mirror');
});

test('without self-stop tooling setup and every wake keep a four-hour boat auto-stop', async (t) => {
  const fake = await startFakeBoat(t, { selfStop: 'none' });
  const { boat } = await makeBoat(t, fake);
  await boat.connectApiKey(API_KEY);
  const client = fakeClient();
  const provisioner = {
    provision: async () => ({
      endpoint: 'http://127.0.0.1:7740/rauhwpx-cloud', serverPublicKey: SERVER_KEY, pairingCode: 'ABCD-EFGH-JKLM', transport: 'ssh-tunnel',
    }),
  };
  const coordinator = new CloudCoordinator({
    client, store: store(), recoveryDir: '/unused', provisioner, boat,
    collectImportedAuth: async (provider) => (provider === 'claude' ? { secrets: {}, files: { '.claude/x.json': '{}' } } : null),
  });
  t.after(() => coordinator.stop());
  const done = await coordinator.boatSetup({ machine: 'default' });
  const [sandbox] = fake.state.sandboxes.values();
  assert.deepEqual(fake.requests('PATCH', `/api/v1/sandboxes/${sandbox.id}`).map((entry) => entry.body).filter((body) => 'ttlSeconds' in body), [{ ttlSeconds: 14400 }]);
  assert.equal(client.calls.activated[0].profile.boat.autoStop, 'timer');
  assert.equal(done.boat.server.autoStop, 'timer');
  assert.equal(done.boat.server.timerHours, 4);

  Object.assign(fake.state.sandboxes.get(sandbox.id), { state: 'archived', ip: null, snapshotAvailable: true });
  await coordinator.boatRefresh();
  await coordinator.command({ sessionId: 'session_12345678', command: 'pause' });
  assert.equal(fake.requests('POST', '/api/v1/sandboxes')[0].body.ttlSeconds, 7200, 'setup has its own bound');
  assert.deepEqual(fake.requests('POST', `/api/v1/sandboxes/${sandbox.id}/resume`).map((entry) => entry.body), [
    { ttlSeconds: 14400 },
  ], 'a later wake keeps the timer');

  fake.state.limits = { ...fake.state.limits, accessTier: 'trial', sandboxPlanKey: 'trial' };
  await coordinator.boatRefresh();
  assert.equal((await coordinator.snapshot()).boat.server.timerHours, 2, 'trial accounts are capped at two hours');
});

test('a credentials retry wakes the paired VM first, and a fresh attempt gets its own start time', async (t) => {
  const fake = await startFakeBoat(t);
  const { boat } = await makeBoat(t, fake);
  await boat.connectApiKey(API_KEY);
  const client = fakeClient();
  let importFails = true;
  const resumesAtImport = [];
  client.putProviderAuth = async (provider) => {
    if (importFails) throw new Error('Cloud rejected the login');
    resumesAtImport.push(fake.requests('POST', /\/resume$/).length);
    client.calls.putAuth.push(provider);
    return { ok: true };
  };
  let installs = 0;
  const provisioner = {
    provision: async () => {
      installs += 1;
      return { endpoint: 'http://127.0.0.1:7740/rauhwpx-cloud', serverPublicKey: SERVER_KEY, pairingCode: 'ABCD-EFGH-JKLM', transport: 'ssh-tunnel' };
    },
  };
  const coordinator = new CloudCoordinator({
    client, store: store(), recoveryDir: '/unused', provisioner, boat,
    collectImportedAuth: async (provider) => (provider === 'pi' ? null : { secrets: {}, files: { [`.${provider}/auth.json`]: '{}' } }),
  });
  t.after(() => coordinator.stop());
  await assert.rejects(coordinator.boatSetup({ machine: 'default' }), { code: 'BOAT_SETUP_FAILED' });
  const failed = (await coordinator.snapshot()).boat.setup;
  assert.equal(failed.stage, 'credentials', 'copying no login at all is a setup error');
  assert.match(failed.error.detail, /claude: .*rejected/);
  assert.equal(fake.requests('PATCH', /\/api\/v1\/sandboxes\//).filter((entry) => 'ttlSeconds' in entry.body).length, 0);

  const [sandbox] = fake.state.sandboxes.values();
  Object.assign(fake.state.sandboxes.get(sandbox.id), { state: 'archived', ip: null, snapshotAvailable: true });
  importFails = false;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const starts = [];
  coordinator.on('event', async (event) => {
    if (event.type === 'boat-setup-progress') starts.push((await coordinator.snapshot()).boat.setup.startedAt);
  });
  const done = await coordinator.boatSetup({ machine: 'default' });
  assert.equal(done.boat.setup.stage, 'done');
  assert.deepEqual(done.boat.setup.importedProviders, ['claude', 'codex']);
  assert.equal(installs, 1, 'the retry does not reinstall or re-pair');
  assert.equal(client.calls.redeemed, 1);
  const resumes = fake.requests('POST', `/api/v1/sandboxes/${sandbox.id}/resume`);
  assert.equal(resumes.length, 1);
  assert.deepEqual(resumesAtImport, [1, 1], 'the stopped VM is resumed before the logins are copied');
  assert.ok(Date.parse(done.boat.setup.startedAt) > Date.parse(failed.startedAt), 'each attempt reports its own start');
  assert.ok(starts.length && starts.every((value) => value === done.boat.setup.startedAt));
});

test('a wake that fails offline settles to an error, and a never-read VM is not reported stopped', async (t) => {
  const fake = await startFakeBoat(t);
  let offline = false;
  const { boat } = await makeBoat(t, fake, {
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/resume')) offline = true;
      if (offline) throw new TypeError('fetch failed');
      return fetch(url, init);
    },
  });
  await boat.connectApiKey(API_KEY);
  const sandbox = fake.addSandbox({ state: 'archived', snapshotAvailable: true });
  const client = fakeClient({ profile: boatProfile(sandbox.id), paired: true });
  const coordinator = new CloudCoordinator({ client, store: store(), recoveryDir: '/unused', boat });
  t.after(() => coordinator.stop());
  const unread = await coordinator.snapshot();
  assert.equal(unread.boat.server.state, 'error');
  assert.equal(unread.boat.server.message, '상태를 확인하지 못했습니다.');

  await assert.rejects(coordinator.command({ sessionId: 'session_12345678', command: 'pause' }), { code: 'BOAT_UNAVAILABLE' });
  const settled = await coordinator.snapshot();
  assert.equal(settled.boat.server.state, 'error', 'the wake does not stay waking');
  assert.equal(settled.boat.server.message, 'boat에 연결하지 못했습니다.');
});

test('boat profiles never trust a first-seen SSH host key', async (t) => {
  const boatArgs = tunnelTest.sshTunnelArguments(normalizeCloudProfile(boatProfile('bx_23456789')), '/tmp/known', 40001);
  assert.ok(boatArgs.includes('StrictHostKeyChecking=yes'));
  const vpsArgs = tunnelTest.sshTunnelArguments(normalizeCloudProfile({
    ...boatProfile('bx_23456789'), boat: undefined, name: 'VPS',
  }), '/tmp/known', 40001);
  assert.ok(vpsArgs.includes('StrictHostKeyChecking=accept-new'));

  const dir = await mkdtemp(path.join(tmpdir(), 'rauhwpx-boat-strict-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const preflights = [];
  const provisioner = new CloudProvisioner({
    spawnImpl: (_command, args) => {
      preflights.push(args.find((arg) => arg.startsWith('StrictHostKeyChecking=')));
      throw new Error('stop after preflight');
    },
    installerPath: path.join(dir, 'install.sh'),
    knownHostsPath: path.join(dir, 'known'),
    retrySleep: async () => {},
  });
  const ssh = { host: '203.0.113.20', user: 'user', port: 22, useTailscaleSsh: false };
  await assert.rejects(provisioner.provision(ssh, { transport: 'ssh-tunnel', hostEnv: boatHostEnv({ sandboxId: 'bx_23456789' }) }));
  await assert.rejects(provisioner.provision(ssh, { transport: 'ssh-tunnel' }));
  assert.deepEqual(preflights, ['StrictHostKeyChecking=yes', 'StrictHostKeyChecking=accept-new']);

  // A wake pins the new address before the profile moves and drops the old pin only afterwards.
  const fake = await startFakeBoat(t);
  const { boat, knownHostsPath } = await makeBoat(t, fake);
  await boat.connectApiKey(API_KEY);
  const sandbox = fake.addSandbox({ state: 'archived', snapshotAvailable: true });
  await boat.pinHostKeys({ sandboxId: sandbox.id, host: '198.51.100.7', keys: fake.state.hostKeys });
  const client = fakeClient({ profile: boatProfile(sandbox.id, '198.51.100.7'), paired: true });
  const pinsAtSave = [];
  const save = client.saveProfile;
  client.saveProfile = async (next) => {
    pinsAtSave.push(await readFile(knownHostsPath, 'utf8'));
    return save(next);
  };
  const coordinator = new CloudCoordinator({ client, store: store(), recoveryDir: '/unused', boat });
  t.after(() => coordinator.stop());
  await coordinator.command({ sessionId: 'session_12345678', command: 'pause' });
  const woken = fake.state.sandboxes.get(sandbox.id).ip;
  assert.match(pinsAtSave[0], /^198\.51\.100\.7 /m, 'the old pin survives until the new address is saved');
  assert.match(pinsAtSave[0], new RegExp(`^${woken.replaceAll('.', '\\.')} `, 'm'), 'the new address is pinned before any dial');
  const after = await readFile(knownHostsPath, 'utf8');
  assert.doesNotMatch(after, /^198\.51\.100\.7 /m);
  assert.equal(await boat.hasPin(sandbox.id, { host: woken }), true);
});

test('boat-idle.sh --probe reports the self-stop tool the idle timer would use', {
  skip: process.platform === 'win32' || spawnSync('bash', ['-c', 'true']).status !== 0,
}, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rauhwpx-boat-idle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  await mkdir(path.join(home, '.local', 'bin'), { recursive: true });
  await mkdir(bin);
  const stub = async (name, body) => {
    await writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(path.join(bin, name), 0o755);
  };
  await stub('flock', 'exit 0');
  await stub('curl', 'exit 0');
  await stub('timeout', 'shift; exec "$@"');
  await stub('runuser', 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"');
  await stub('getent', `echo "user:x:1000:1000::${home}:/bin/bash"`);
  await stub('rauhwpx-cloud', 'exit 99');
  await stub('node', 'exit 99');
  const envFile = path.join(dir, 'boat.env');
  const source = await readFile(new URL('../cloud/install/boat-idle.sh', import.meta.url), 'utf8');
  const script = path.join(dir, 'boat-idle.sh');
  await writeFile(script, source
    .replace('ENV_FILE=/etc/rauhwpx-boat.env', `ENV_FILE=${envFile}`)
    .replace('CLOUD_CLI=/usr/local/bin/rauhwpx-cloud', `CLOUD_CLI=${bin}/rauhwpx-cloud`)
    .replace('NODE=/opt/rauhwpx-node/bin/node', `NODE=${bin}/node`));
  const probe = () => {
    const result = spawnSync('bash', [script, '--probe'], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin` },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const parse = (stdout) => {
    const match = /^rauhwpx-boat-self-stop (cli|api|none)$/m.exec(stdout);
    return match && match[1] !== 'none' ? 'idle' : 'timer';
  };
  assert.match(boatTest.SELF_STOP_COMMAND, /boat-idle\.sh.*--probe/);

  assert.equal(probe(), 'rauhwpx-boat-self-stop none', 'no env file means the timer would never stop');
  await writeFile(envFile, 'RAUHWpx_BOAT_SANDBOX_ID=bx_23456789\nRAUHWpx_BOAT_IDLE_MINUTES=30\nRAUHWpx_BOAT_USER=user\n');
  assert.equal(probe(), 'rauhwpx-boat-self-stop none');
  await writeFile(path.join(home, '.profile'), 'export ASCII_TOKEN=ascii_token_1234567890\nexport BOAT_ID=bx_23456789\n');
  assert.equal(probe(), 'rauhwpx-boat-self-stop api');
  await writeFile(path.join(home, '.local', 'bin', 'boat'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(home, '.local', 'bin', 'boat'), 0o755);
  assert.equal(probe(), 'rauhwpx-boat-self-stop cli');
  assert.equal(parse(probe()), 'idle');
  await writeFile(path.join(home, '.profile'), 'export BOAT_ID=bx_99999999\n');
  assert.equal(probe(), 'rauhwpx-boat-self-stop none', 'a forked machine does not stop the configured one');
  assert.equal(parse(probe()), 'timer');
});
