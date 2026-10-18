import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createLicenseClient, LicenseServerError } from '../desktop/license-client.mjs';
import {
  licenseKeyHash, maskLicenseKey, normalizeLicenseKey,
  PRODUCTION_LICENSE_PUBLIC_KEYS, verifyLease,
} from '../desktop/license-lease.mjs';
import {
  createLicenseManager, EXPIRED_RECHECK_MS, EXPIRY_SAVE_GRACE_MS, LicenseReadOnlyError, PRICING_URL,
  SUBSCRIPTION_OFFLINE_GRACE_MS, TRIAL_DURATION_MS,
} from '../desktop/license-manager.mjs';
import { createMockLicenseServer, DEV_PUBLIC_KEYS, signLease } from './fixtures/license-mock-server.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 16, 0, 0, 0);
const quiet = { warn() {} };

async function setup(t, { enforce = true, publicKeys = DEV_PUBLIC_KEYS } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hama-license-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = { t: T0 };
  const server = createMockLicenseServer({ now: () => clock.t });
  const changes = [];
  const make = () => createLicenseManager({
    statePath: join(dir, 'license.json'),
    client: createLicenseClient({ baseUrl: 'https://keys.test', fetchImpl: server.fetch }),
    publicKeys,
    appVersion: '3.1.0',
    platform: 'darwin',
    enforce,
    now: () => clock.t,
    onChange: (status) => changes.push(status.state),
    log: quiet,
  });
  return { dir, clock, server, changes, manager: make(), make };
}

test('production builds trust only the pinned server key, never the test key', () => {
  assert.equal(Buffer.from(PRODUCTION_LICENSE_PUBLIC_KEYS['hama-prod-1'], 'base64').length, 32);
  const key = 'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE';
  const lease = signLease({ v: 1, kid: 'hama-prod-1', keyHash: licenseKeyHash(key), keyId: 'lic_1', deviceId: 'dev-a', issuedAt: T0, expiresAt: T0 + DAY });
  const opts = { deviceId: 'dev-a', key, keyId: 'lic_1', now: T0 + HOUR };
  assert.equal(verifyLease(lease, opts).reason, 'bad_signature');
  assert.equal(verifyLease(lease, { ...opts, publicKeys: DEV_PUBLIC_KEYS }).ok, true);
});

test('license keys normalize, hash and mask', () => {
  assert.equal(normalizeLicenseKey(' hama-abcde-12345-abcde-12345-ooooo '), 'HAMA-ABCDE-12345-ABCDE-12345-00000');
  assert.equal(normalizeLicenseKey('short'), '');
  assert.equal(normalizeLicenseKey('bad key!*'), '');
  assert.equal(maskLicenseKey('HAMA-ABCDE-12345-ABCDE-12345-0XYZ9'), 'HAMA-…XYZ9');
});

test('lease verification checks signature, device, key and expiry offline', () => {
  const key = 'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE';
  const payload = { v: 1, kid: 'hama-prod-1', keyHash: licenseKeyHash(key), keyId: 'lic_1', deviceId: 'dev-a', issuedAt: T0, expiresAt: T0 + 7 * DAY };
  const lease = signLease(payload);
  const opts = { publicKeys: DEV_PUBLIC_KEYS, deviceId: 'dev-a', key, keyId: 'lic_1', now: T0 + DAY };
  assert.deepEqual(verifyLease(lease, opts).ok, true);
  assert.equal(verifyLease(lease, { ...opts, deviceId: 'dev-b' }).reason, 'wrong_device');
  assert.equal(verifyLease(lease, { ...opts, key: 'HAMA-00000-00000-00000-00000-00000' }).reason, 'wrong_key');
  assert.equal(verifyLease(lease, { ...opts, keyId: 'lic_other' }).reason, 'wrong_key');
  assert.equal(verifyLease(lease, { ...opts, now: T0 + 7 * DAY }).reason, 'expired');
  assert.equal(verifyLease(lease, { ...opts, publicKeys: {} }).reason, 'unknown_kid');
  const [body, sig] = lease.split('.');
  const forged = Buffer.from(JSON.stringify({ ...payload, deviceId: 'dev-b' })).toString('base64url');
  assert.equal(verifyLease(`${forged}.${sig}`, { ...opts, deviceId: 'dev-b' }).reason, 'bad_signature');
  assert.equal(verifyLease(`${body}`, opts).reason, 'malformed');
  const tooLong = signLease({ ...payload, expiresAt: T0 + 30 * DAY });
  assert.equal(verifyLease(tooLong, opts).reason, 'malformed');
});

test('client maps contract errors and network failures', async () => {
  const server = createMockLicenseServer({ now: () => T0 });
  const client = createLicenseClient({ baseUrl: 'https://keys.test/', fetchImpl: server.fetch });
  await assert.rejects(client.activate({ key: 'HAMA-NOPE0-NOPE0', deviceId: 'device-0', appVersion: '1', platform: 'darwin' }),
    (error) => error instanceof LicenseServerError && error.code === 'invalid_key');
  const key = server.issueKey();
  assert.match((await client.activate({ key, deviceId: 'device-1', appVersion: '1', platform: 'darwin' })).lease, /^[\w-]+\.[\w-]+$/);
  assert.deepEqual(server.calls[1], { path: '/v1/license/activate', body: { key, deviceId: 'device-1', appVersion: '1', platform: 'darwin' } });
  server.setOffline(true);
  await assert.rejects(client.validate({ key, deviceId: 'device-1' }), (error) => error.code === 'network');
  const broken = createLicenseClient({ fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }) });
  await assert.rejects(broken.validate({ key, deviceId: 'device-1' }), (error) => error.code === 'server');
});

test('trial lasts 72 hours from first launch', async (t) => {
  const { manager, clock } = await setup(t);
  let status = await manager.status();
  assert.equal(TRIAL_DURATION_MS, 72 * HOUR);
  assert.equal(status.state, 'trial');
  assert.equal(status.trial.endsAt, T0 + TRIAL_DURATION_MS);
  assert.equal(status.pricingUrl, PRICING_URL);
  await manager.assertCanSave();
  clock.t = T0 + TRIAL_DURATION_MS - 1;
  assert.equal((await manager.status()).state, 'trial');
  clock.t = T0 + TRIAL_DURATION_MS;
  status = await manager.status();
  assert.equal(status.state, 'trial_expired');
  assert.equal(status.readOnly, true);
  await assert.rejects(manager.assertCanSave(), LicenseReadOnlyError);
});

test('the trial start survives a restart', async (t) => {
  const { manager, make, clock } = await setup(t);
  await manager.status();
  clock.t = T0 + TRIAL_DURATION_MS - HOUR;
  const restarted = make();
  const status = await restarted.status();
  assert.equal(status.state, 'trial');
  assert.equal(status.trial.startedAt, T0);
  clock.t = T0 + TRIAL_DURATION_MS;
  assert.equal((await make().status()).state, 'trial_expired');
});

test('a save count left by the old trial rule is ignored', async (t) => {
  const { dir, make, clock } = await setup(t);
  const deviceId = '7f2c4c1e-3b7a-4d2e-9a1b-0c5d6e7f8a9b';
  await writeFile(join(dir, 'license.json'), JSON.stringify({
    v: 1, deviceId, maxSeenAt: T0, trial: { startedAt: T0, saves: 3 }, license: null,
  }));
  clock.t = T0 + DAY;
  const manager = make();
  const status = await manager.status();
  assert.equal(status.state, 'trial');
  assert.equal(status.deviceId, deviceId);
  await manager.assertCanSave();
  const saved = JSON.parse(await readFile(join(dir, 'license.json'), 'utf8'));
  assert.equal('saves' in saved.trial, false);
});

test('winding the clock back does not extend the trial', async (t) => {
  const { manager, make, clock } = await setup(t);
  await manager.status();
  clock.t = T0 + TRIAL_DURATION_MS + HOUR;
  // 1분 주기 확인이 본 가장 늦은 시각을 저장한다.
  assert.equal((await manager.check()).state, 'trial_expired');
  clock.t = T0 + HOUR;
  assert.equal((await manager.status()).state, 'trial_expired');
  assert.equal((await make().status()).state, 'trial_expired', 'a restart keeps the latest time seen');
});

test('activation unlocks saving after the trial, and settings show a masked key', async (t) => {
  const { manager, server, clock, changes } = await setup(t);
  await manager.status();
  clock.t = T0 + 3 * DAY;
  assert.equal((await manager.status()).state, 'trial_expired');
  const key = server.issueKey();
  const result = await manager.activate(key.toLowerCase());
  assert.equal(result.ok, true);
  assert.equal(result.status.state, 'licensed');
  assert.equal(result.status.license.maskedKey, maskLicenseKey(key));
  assert.equal(result.status.license.leaseExpiresAt, clock.t + 7 * DAY);
  assert.equal(server.calls.at(-1).body.platform, 'darwin');
  assert.equal(server.calls.at(-1).body.appVersion, '3.1.0');
  assert.deepEqual(changes.at(-1), 'licensed');
  await manager.assertCanSave();
});

test('activation errors come back as user-facing messages', async (t) => {
  const { manager, server, make, clock } = await setup(t);
  assert.equal((await manager.activate('???')).code, 'invalid_format');
  assert.equal((await manager.activate('HAMA-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE')).code, 'invalid_key');
  const key = server.issueKey();
  server.revoke(key);
  const revoked = await manager.activate(key);
  assert.equal(revoked.code, 'revoked');
  assert.match(revoked.message, /해지/);
  const key2 = server.issueKey();
  // Two other devices already hold the key.
  server.handle('/v1/license/activate', { key: key2, deviceId: 'mac-0001' });
  server.handle('/v1/license/activate', { key: key2, deviceId: 'mac-0002' });
  const limited = await manager.activate(key2);
  assert.equal(limited.code, 'device_limit');
  assert.match(limited.message, /다른 기기.*비활성화/);
  server.setOffline(true);
  assert.equal((await make().activate(key2)).code, 'network');
  void clock;
});

test('checks every 24 hours renew the lease; offline grace lasts 7 days', async (t) => {
  const { manager, server, clock } = await setup(t);
  const key = server.issueKey();
  await manager.activate(key);
  const calls = server.calls.length;
  clock.t += 12 * HOUR;
  await manager.check();
  assert.equal(server.calls.length, calls, 'no network call before 24 hours');
  clock.t += 13 * HOUR;
  let status = await manager.check();
  assert.equal(server.calls.at(-1).path, '/v1/license/validate');
  assert.equal(status.license.leaseExpiresAt, clock.t + 7 * DAY);
  const renewedAt = clock.t;
  server.setOffline(true);
  clock.t = renewedAt + 6 * DAY;
  status = await manager.check();
  assert.equal(status.state, 'licensed');
  assert.equal(status.offline, true);
  clock.t = renewedAt + 7 * DAY;
  status = await manager.check();
  assert.equal(status.state, 'lease_expired');
  await assert.rejects(manager.assertCanSave(), LicenseReadOnlyError);
  server.setOffline(false);
  status = await manager.check();
  assert.equal(status.state, 'licensed');
  assert.equal(status.offline, false);
});

test('an annual key shows its renewal date; a lifetime key shows none', async (t) => {
  const { manager, server } = await setup(t);
  const renewsAt = T0 + 365 * DAY;
  let status = (await manager.activate(server.issueKey({ licenseExpiresAt: renewsAt }))).status;
  assert.equal(status.state, 'licensed');
  assert.equal(status.license.licenseExpiresAt, renewsAt);
  assert.equal(status.license.autoRenew, true);
  assert.equal(status.license.graceEndsAt, null);
  status = (await manager.activate(server.issueKey())).status;
  assert.equal(status.license.licenseExpiresAt, null);
  assert.equal(status.license.autoRenew, null);
});

test('an annual key: the server saying expired locks at once, and a renewal unlocks on the next check', async (t) => {
  const { manager, make, server, clock } = await setup(t);
  const expiresAt = T0 + 30 * DAY;
  const key = server.issueKey({ licenseExpiresAt: expiresAt });
  await manager.activate(key);
  clock.t = expiresAt - HOUR;
  assert.equal((await manager.check({ force: true })).state, 'licensed');

  clock.t = expiresAt + 2 * HOUR;
  let status = await manager.check();
  assert.equal(status.state, 'expired', 'online past the expiry: no offline grace');
  assert.equal(status.readOnly, true);
  assert.equal(status.license.licenseExpiresAt, expiresAt);
  await assert.rejects(manager.assertCanSave(), /기간이 끝나 읽기 전용/);
  assert.equal(await manager.currentLease(), null);
  // The state survives a restart, even offline.
  server.setOffline(true);
  assert.equal((await make().status()).state, 'expired');
  server.setOffline(false);

  // Renewed on the server: the hourly recheck picks it up without the user doing anything.
  server.setLicenseExpiry(key, expiresAt + 365 * DAY);
  const calls = server.calls.length;
  clock.t += EXPIRED_RECHECK_MS / 2;
  assert.equal((await manager.check()).state, 'expired');
  assert.equal(server.calls.length, calls, 'no recheck within the hour');
  clock.t += EXPIRED_RECHECK_MS / 2;
  status = await manager.check();
  assert.equal(status.state, 'licensed');
  assert.equal(status.license.licenseExpiresAt, expiresAt + 365 * DAY);
  await manager.assertCanSave();
});

test('an annual key offline past its expiry keeps working for the 7-day grace, then expires', async (t) => {
  const { manager, server, clock } = await setup(t);
  const expiresAt = T0 + 30 * DAY;
  const key = server.issueKey({ licenseExpiresAt: expiresAt, autoRenew: false });
  await manager.activate(key);
  // Last successful check right before the expiry: the lease runs 7 days from here.
  clock.t = expiresAt - 1;
  await manager.check({ force: true });
  server.setOffline(true);

  clock.t = expiresAt + 3 * DAY;
  let status = await manager.check();
  assert.equal(status.state, 'licensed');
  assert.equal(status.offline, true);
  assert.equal(status.license.autoRenew, false);
  assert.equal(status.license.graceEndsAt, expiresAt - 1 + 7 * DAY);
  assert.ok(status.license.graceEndsAt <= expiresAt + SUBSCRIPTION_OFFLINE_GRACE_MS);
  await manager.assertCanSave();

  clock.t = expiresAt + 7 * DAY;
  status = await manager.check();
  assert.equal(status.state, 'expired');
  await assert.rejects(manager.assertCanSave(), LicenseReadOnlyError);
});

test('the grace never passes 7 days after the expiry, even with a lease signed later', async (t) => {
  const { dir, make, server, clock } = await setup(t);
  const expiresAt = T0 + 30 * DAY;
  const key = server.issueKey();
  const deviceId = '0b9c6f7e-3f7a-4d8e-9a51-2f1c3d4e5f60';
  const issuedAt = expiresAt + 5 * DAY;
  const lease = signLease({ v: 1, kid: 'hama-prod-1', keyId: 'lic_1', keyHash: licenseKeyHash(key), deviceId, issuedAt, expiresAt: issuedAt + 7 * DAY, licenseExpiresAt: expiresAt });
  await writeFile(join(dir, 'license.json'), JSON.stringify({ v: 1, deviceId, maxSeenAt: issuedAt, trial: { startedAt: T0 }, license: { key, keyId: 'lic_1', tier: 'paid', lease, lastCheckAt: issuedAt } }));
  server.setOffline(true);
  clock.t = expiresAt + 6 * DAY;
  assert.equal((await make().status()).state, 'licensed');
  clock.t = expiresAt + SUBSCRIPTION_OFFLINE_GRACE_MS;
  assert.equal((await make().status()).state, 'expired', 'the lease is still valid, the 7-day grace is not');
});

test('activating an expired annual key says so', async (t) => {
  const { manager, server } = await setup(t);
  const key = server.issueKey({ licenseExpiresAt: T0 - DAY });
  const result = await manager.activate(key);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'expired');
  assert.match(result.message, /기간이 끝난 라이선스 키/);
});

test('a refunded (revoked) key turns the app read-only at the next check', async (t) => {
  const { manager, server, clock } = await setup(t);
  const key = server.issueKey();
  await manager.activate(key);
  server.revoke(key);
  clock.t += 25 * HOUR;
  const status = await manager.check();
  assert.equal(status.state, 'revoked');
  assert.equal(status.readOnly, true);
  await assert.rejects(manager.assertCanSave(), /해지/);
  const fresh = server.issueKey();
  assert.equal((await manager.activate(fresh)).status.state, 'licensed');
});

test('a beta key shows its tier, keeps it across restarts, and ends with the beta message', async (t) => {
  const { dir, manager, make, server, clock } = await setup(t);
  const key = server.issueKey({ tier: 'beta' });
  let status = (await manager.activate(key)).status;
  assert.equal(status.state, 'licensed');
  assert.equal(status.license.tier, 'beta');
  assert.equal(status.license.leaseExpiresAt, T0 + 3 * DAY, 'beta leases last 3 days');
  assert.equal((await make().status()).license.tier, 'beta', 'the tier survives a restart');

  // 해지된 베타 키는 오프라인이어도 lease 가 끝나는 3일 뒤에 잠긴다.
  server.setOffline(true);
  clock.t = T0 + 3 * DAY;
  assert.equal((await make().check()).state, 'lease_expired');
  server.setOffline(false);
  server.revoke(key);
  const relaunched = make();
  status = await relaunched.check({ force: true });
  assert.equal(status.state, 'revoked');
  assert.equal(status.license.lastError, '베타 테스트 기간이 끝나 키가 해지되었어요.');
  await assert.rejects(relaunched.assertCanSave(), /베타 테스트 기간이 끝나/);

  // A state file written before tiers existed reads as a paid key.
  const saved = JSON.parse(await readFile(join(dir, 'license.json'), 'utf8'));
  delete saved.license.tier;
  await writeFile(join(dir, 'license.json'), JSON.stringify(saved));
  assert.equal((await make().status()).license.tier, 'paid');
});

test('deactivate frees the device slot; offline deactivate keeps the license', async (t) => {
  const { manager, server, clock, make } = await setup(t);
  const key = server.issueKey();
  await manager.activate(key);
  const { deviceId } = await manager.status();
  assert.deepEqual(server.devices(key), [deviceId]);
  server.setOffline(true);
  const offline = await manager.deactivate();
  assert.equal(offline.ok, false);
  assert.equal(offline.status.state, 'licensed');
  server.setOffline(false);
  const done = await manager.deactivate();
  assert.equal(done.ok, true);
  assert.deepEqual(server.devices(key), []);
  assert.equal(done.status.license, null);
  assert.equal(done.status.state, 'trial_expired', 'deactivating does not return to the trial');
  clock.t += HOUR;
  assert.equal((await make().status()).state, 'trial_expired');
});

test('a server that forgot this device drops the lease and asks to re-activate', async (t) => {
  const { manager, server, clock } = await setup(t);
  const key = server.issueKey();
  await manager.activate(key);
  const { deviceId } = await manager.status();
  server.handle('/v1/license/deactivate', { key, deviceId });
  clock.t += 3 * DAY;
  const status = await manager.check();
  assert.equal(status.state, 'needs_activation');
  assert.match(status.license.lastError, /활성화/);
});

test('a tampered state file cannot fake a license', async (t) => {
  const { manager, dir, make, clock } = await setup(t);
  await manager.status();
  const path = join(dir, 'license.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.license = { key: 'HAMA-AAAAA-BBBBB-CCCCC-DDDDD-00000', lease: 'eyJ2IjoxfQ.AAAA', lastCheckAt: T0 };
  await writeFile(path, JSON.stringify(saved));
  clock.t = T0 + 3 * DAY;
  const status = await make().status();
  assert.equal(status.state, 'needs_activation');
  assert.equal(status.canEdit, false);
});

test('a corrupt state file starts a fresh state instead of crashing', async (t) => {
  const { dir, make } = await setup(t);
  await writeFile(join(dir, 'license.json'), '{not json');
  assert.equal((await make().status()).state, 'trial');
});

test('unenforced builds (development runs) never block saving', async (t) => {
  const { manager, clock } = await setup(t, { enforce: false });
  clock.t = T0 + 30 * DAY;
  const status = await manager.status();
  assert.equal(status.state, 'unenforced');
  await manager.assertCanSave();
});

test('the schedule runs a launch check and re-checks time boundaries for the 24-hour window', async (t) => {
  const { manager, server, clock } = await setup(t);
  const key = server.issueKey();
  await manager.activate(key);
  let tick = null;
  manager.start({ setIntervalImpl: (fn) => { tick = fn; return 1; }, clearIntervalImpl: () => {} });
  await manager.check();
  clock.t += 25 * HOUR;
  const before = server.calls.length;
  tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await manager.status();
  assert.equal(server.calls.length, before + 1);
  manager.stop();
});

test('eligible installs receive and activate a grandfather key, then renew normally', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hama-grandfather-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const installId = 'bc9e318c-adb1-4a32-92cc-dbd1bf353b00';
  const server = createMockLicenseServer({ now: () => T0, eligibleInstallId: installId });
  const manager = createLicenseManager({
    statePath: join(dir, 'license.json'),
    client: createLicenseClient({ fetchImpl: server.fetch }),
    publicKeys: DEV_PUBLIC_KEYS, now: () => T0, log: quiet,
    existingInstallId: async () => installId,
  });
  assert.equal((await manager.check()).state, 'licensed');
  assert.equal(server.calls[0].path, '/v1/license/grandfather');
  assert.equal(server.calls[1].path, '/v1/license/public-key');
  assert.equal(server.calls[2].path, '/v1/license/activate');
  await manager.check({ force: true });
  assert.equal(server.calls.at(-1).path, '/v1/license/validate');
});

test('a downloaded public key cannot replace the pinned key', async (t) => {
  const { manager, server } = await setup(t, { publicKeys: { 'hama-prod-1': 'untrusted' } });
  const result = await manager.activate(server.issueKey());
  assert.equal(result.code, 'bad_lease');
  assert.equal(server.calls.length, 1);
  assert.equal((await manager.status()).state, 'trial');
});

test('trial deadline broadcasts read-only even without a license or network check', async (t) => {
  const { manager, clock, changes } = await setup(t);
  await manager.load();
  let tick;
  manager.start({ setIntervalImpl: fn => { tick = fn; return 1; }, clearIntervalImpl() {} });
  await manager.status();
  clock.t += TRIAL_DURATION_MS;
  tick();
  await manager.status();
  assert.equal(changes.at(-1), 'trial_expired');
  manager.stop();
});

class FakeLicenseWindow {
  static opened = 0;
  constructor() { FakeLicenseWindow.opened += 1; }
  webContents = { setWindowOpenHandler() {}, on() {} };
  isDestroyed() { return false; }
  once() {}
  on() {}
  show() {}
  focus() {}
  loadURL() { return Promise.resolve(); }
}

async function hostFor(manager) {
  const { installLicenseHost } = await import('../desktop/license-host.mjs');
  const handlers = new Map();
  FakeLicenseWindow.opened = 0;
  const host = installLicenseHost({
    ipcMain: { handle(channel, fn) { handlers.set(channel, fn); } },
    BrowserWindow: FakeLicenseWindow, shell: {}, manager,
    isTrustedStudioEvent: () => true, log: quiet,
  });
  return { host, invoke: (channel, sender) => handlers.get(channel)({ sender }) };
}

test('native saves never use up the trial; only the 72-hour deadline ends it', async (t) => {
  const { manager, clock } = await setup(t);
  const { host } = await hostFor(manager);
  await assert.rejects(host.save(async () => { throw new Error('disk full'); }), /disk full/);
  const written = [];
  const saves = await Promise.allSettled(Array.from({ length: 20 }, (_, n) => host.save(async () => { written.push(n); })));
  assert.equal(written.length, 20);
  assert.ok(saves.every((save) => save.status === 'fulfilled'));
  assert.equal((await manager.status()).state, 'trial');
  assert.equal(FakeLicenseWindow.opened, 0);
  clock.t = T0 + TRIAL_DURATION_MS;
  await assert.rejects(host.save(async () => { written.push('late'); }), (error) => error.code === 'LICENSE_READ_ONLY');
  assert.equal(written.includes('late'), false);
  assert.equal(FakeLicenseWindow.opened, 1, 'a refused save opens activation');
});

test('a save received before the deadline is written even if it runs after it', async (t) => {
  const { manager, clock } = await setup(t);
  const { host } = await hostFor(manager);
  await manager.status();
  clock.t = T0 + TRIAL_DURATION_MS - 1000;
  const written = [];
  let finishFirst;
  const first = host.save(() => new Promise((resolve) => { finishFirst = () => { written.push('first'); resolve(); }; }));
  const second = host.save(async () => { written.push('second'); });
  await new Promise((resolve) => setImmediate(resolve));
  clock.t = T0 + TRIAL_DURATION_MS + 1000;
  finishFirst();
  await Promise.all([first, second]);
  assert.deepEqual(written, ['first', 'second']);
  await assert.rejects(host.save(async () => { written.push('after'); }), LicenseReadOnlyError);
  assert.deepEqual(written, ['first', 'second']);
});

test('the expiry auto-save gets one short grace window for the window that asked', async (t) => {
  const { manager, make, clock } = await setup(t);
  const { host, invoke } = await hostFor(manager);
  const studio = { id: 'studio' };
  const other = { id: 'other' };
  assert.equal((await invoke('license:begin-expiry-save', studio)).ok, false, 'no grace while the trial runs');
  // 잠자기에서 깨어 기한을 한참 넘긴 뒤
  clock.t = T0 + TRIAL_DURATION_MS + 5 * HOUR;
  assert.equal((await invoke('license:begin-expiry-save', studio)).ok, true);
  await host.save(async () => {}, { sender: studio });
  await assert.rejects(host.save(async () => {}, { sender: other }), LicenseReadOnlyError);
  await assert.rejects(host.save(async () => {}), LicenseReadOnlyError);
  clock.t += EXPIRY_SAVE_GRACE_MS;
  await assert.rejects(host.save(async () => {}, { sender: studio }), LicenseReadOnlyError);
  const relaunched = await hostFor(make());
  assert.equal((await relaunched.invoke('license:begin-expiry-save', studio)).ok, false, 'a restart does not reopen it');
  await assert.rejects(relaunched.host.save(async () => {}, { sender: studio }), LicenseReadOnlyError);
});

test('a key revoked while the app runs gets one grace save for that lock, and only once', async (t) => {
  const { manager, server, clock, make } = await setup(t);
  const { host, invoke } = await hostFor(manager);
  const studio = { id: 'studio' };
  const key = server.issueKey();
  await manager.activate(key);
  assert.equal((await invoke('license:begin-expiry-save', studio)).ok, false, 'no grace while licensed');
  server.revoke(key);
  clock.t += 25 * HOUR;
  assert.equal((await manager.check()).state, 'revoked');
  await assert.rejects(host.save(async () => {}), LicenseReadOnlyError, 'ordinary saves are refused');
  assert.equal((await invoke('license:begin-expiry-save', studio)).ok, true);
  const written = [];
  await host.save(async () => { written.push('dirty file'); }, { sender: studio });
  assert.deepEqual(written, ['dirty file']);
  await assert.rejects(host.save(async () => {}, { sender: { id: 'other' } }), LicenseReadOnlyError);
  clock.t += EXPIRY_SAVE_GRACE_MS;
  await assert.rejects(host.save(async () => {}, { sender: studio }), LicenseReadOnlyError);
  assert.equal((await invoke('license:begin-expiry-save', studio)).ok, false, 'the same lock cannot reopen it');
  const relaunched = await hostFor(make());
  assert.equal((await relaunched.invoke('license:begin-expiry-save', studio)).ok, false, 'a restart has no lock transition');
  await assert.rejects(relaunched.host.save(async () => {}, { sender: studio }), LicenseReadOnlyError);
});

test('a save received before a revocation lands is still written', async (t) => {
  const { manager, server, clock } = await setup(t);
  const { host } = await hostFor(manager);
  const key = server.issueKey();
  await manager.activate(key);
  server.revoke(key);
  clock.t += 25 * HOUR;
  let finish;
  const written = [];
  const first = host.save(() => new Promise((resolve) => { finish = () => { written.push('first'); resolve(); }; }));
  const second = host.save(async () => { written.push('second'); });
  await new Promise((resolve) => setImmediate(resolve));
  clock.t += 1000;
  await manager.check();
  finish();
  await Promise.all([first, second]);
  assert.deepEqual(written, ['first', 'second']);
  await assert.rejects(host.save(async () => {}), LicenseReadOnlyError);
});
