import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createLicenseClient, LicenseServerError } from '../desktop/license-client.mjs';
import {
  licenseKeyHash, maskLicenseKey, normalizeLicenseKey,
  productionPublicKeysProvisioned, verifyLease,
} from '../desktop/license-lease.mjs';
import {
  createLicenseManager, LicenseReadOnlyError, PRICING_URL, TRIAL_DURATION_MS,
} from '../desktop/license-manager.mjs';
import { createMockLicenseServer, DEV_PUBLIC_KEYS, signLease } from './fixtures/license-mock-server.mjs';

const UNCONFIGURED_PUBLIC_KEYS = { 'hama-prod-1': 'REPLACE_TEST_PUBLIC_KEY' };
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

test('placeholder public keys disable activation until provisioned', () => {
  assert.equal(productionPublicKeysProvisioned(UNCONFIGURED_PUBLIC_KEYS), false);
  assert.equal(productionPublicKeysProvisioned(DEV_PUBLIC_KEYS), true);
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
  assert.equal(verifyLease(lease, { ...opts, publicKeys: UNCONFIGURED_PUBLIC_KEYS }).reason, 'unknown_kid');
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

test('trial lasts 48 hours from first launch', async (t) => {
  const { manager, clock } = await setup(t);
  let status = await manager.status();
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

test('trial ends after 3 saved edits and survives a restart', async (t) => {
  const { manager, make, clock } = await setup(t);
  await manager.recordSave();
  await manager.recordSave();
  assert.equal((await manager.status()).trial.savesLeft, 1);
  const restarted = make();
  clock.t += HOUR;
  assert.equal((await restarted.status()).trial.savesUsed, 2);
  await restarted.recordSave();
  const status = await restarted.status();
  assert.equal(status.state, 'trial_expired');
  await assert.rejects(restarted.assertCanSave(), (error) => error.code === 'LICENSE_READ_ONLY');
});

test('winding the clock back does not extend the trial', async (t) => {
  const { manager, clock } = await setup(t);
  await manager.status();
  clock.t = T0 + TRIAL_DURATION_MS + HOUR;
  assert.equal((await manager.status()).state, 'trial_expired');
  clock.t = T0 + HOUR;
  assert.equal((await manager.status()).state, 'trial_expired');
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
  await manager.recordSave();
  assert.equal((await manager.status()).state, 'licensed');
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
  // Two other Macs already hold the key.
  server.handle('/v1/license/activate', { key: key2, deviceId: 'mac-0001' });
  server.handle('/v1/license/activate', { key: key2, deviceId: 'mac-0002' });
  const limited = await manager.activate(key2);
  assert.equal(limited.code, 'device_limit');
  assert.match(limited.message, /2대/);
  server.setOffline(true);
  assert.equal((await make().activate(key2)).code, 'network');
  void clock;
});

test('activation is refused while the production public key is a placeholder', async (t) => {
  const { manager, server } = await setup(t, { publicKeys: UNCONFIGURED_PUBLIC_KEYS });
  const result = await manager.activate(server.issueKey());
  assert.equal(result.code, 'not_configured');
  assert.equal(result.status.activationAvailable, false);
  assert.equal(server.calls.length, 0);
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

test('deactivate frees the device slot; offline deactivate keeps the license', async (t) => {
  const { manager, server, clock } = await setup(t);
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
  clock.t += 3 * DAY;
  assert.equal((await manager.status()).state, 'trial_expired');
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
  clock.t += 48 * HOUR;
  tick();
  await manager.status();
  assert.equal(changes.at(-1), 'trial_expired');
  manager.stop();
});

test('concurrent native saves consume exactly three trial saves; failed writes consume none', async (t) => {
  const { installLicenseHost } = await import('../desktop/license-host.mjs');
  const { manager } = await setup(t);
  class Window {
    webContents = { setWindowOpenHandler() {}, on() {} };
    isDestroyed() { return false; }
    once() {}
    on() {}
    show() {}
    focus() {}
    loadURL() { return Promise.resolve(); }
  }
  const host = installLicenseHost({
    ipcMain: { handle() {} }, BrowserWindow: Window, shell: {}, manager,
    isTrustedStudioEvent: () => true, log: quiet,
  });
  await assert.rejects(host.save(async () => { throw new Error('disk full'); }), /disk full/);
  assert.equal((await manager.status()).trial.savesUsed, 0);
  const written = [];
  const saves = await Promise.allSettled([1, 2, 3, 4].map(n => host.save(async () => { written.push(n); })));
  assert.deepEqual(written, [1, 2, 3]);
  assert.equal(saves[3].status, 'rejected');
  assert.equal(saves[3].reason.code, 'LICENSE_READ_ONLY');
  assert.equal((await manager.status()).trial.savesUsed, 3);
});
