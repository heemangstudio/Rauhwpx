// In-memory test double of the HamaEditor key server (docs/license-api.md).
// The desktop tests use .fetch; `node tests/fixtures/license-mock-server.mjs` serves it on
// http://127.0.0.1:8787 for manual runs (HAMA_LICENSE_API_BASE + HAMA_LICENSE_DEV_PUBLIC_KEY).
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { normalizeLicenseKey, licenseKeyHash } from '../../desktop/license-lease.mjs';

// 테스트마다 메모리에서 생성한다. 개인키는 저장하거나 커밋하지 않는다.
const pair = generateKeyPairSync('ed25519');
export const DEV_KEYPAIR = {
  kid: 'hama-prod-1',
  publicKeyBase64: Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'),
  privateKey: pair.privateKey,
};
export const DEV_PUBLIC_KEYS = Object.freeze({ [DEV_KEYPAIR.kid]: DEV_KEYPAIR.publicKeyBase64 });
const LEASE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export function signLease(payload, keypair = DEV_KEYPAIR) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return `${body.toString('base64url')}.${sign(null, Buffer.from(body.toString('base64url'), 'ascii'), keypair.privateKey).toString('base64url')}`;
}

export function createMockLicenseServer({ keypair = DEV_KEYPAIR, now = Date.now, deviceLimit = 2, eligibleInstallId = null } = {}) {
  const licenses = new Map();
  const calls = [];
  let offline = false;

  function issueKey() {
    const raw = Array.from(randomBytes(25), n => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[n & 31]).join('');
    const key = `HAMA-${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}-${raw.slice(20, 25)}`;
    licenses.set(key, { id: `lic_${licenses.size + 1}`, devices: new Set(), revoked: false });
    return key;
  }

  function lease(key, deviceId) {
    const issuedAt = now();
    return signLease({
      v: 1, kid: keypair.kid, keyId: licenses.get(key).id, keyHash: licenseKeyHash(key), deviceId, issuedAt, expiresAt: issuedAt + LEASE_TTL_MS,
    }, keypair);
  }

  let grandfatherKey;
  function handle(path, body) {
    calls.push({ path, body });
    if (path === '/v1/license/public-key') return [200, { alg: 'Ed25519', kid: keypair.kid, rawBase64: keypair.publicKeyBase64, spkiDerBase64: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }];
    if (path === '/v1/license/grandfather') {
      if (!eligibleInstallId) return [403, { ok: false, error: 'grandfather_disabled' }];
      if (body.installId !== eligibleInstallId) return [403, { ok: false, error: 'not_eligible' }];
      const created = !grandfatherKey;
      grandfatherKey ??= issueKey();
      return [200, { ok: true, key: grandfatherKey, created }];
    }
    if (!/^[A-Za-z0-9\-_.:]{8,128}$/.test(body.deviceId ?? '')) return [400, { ok: false, error: 'device_id_invalid' }];
    const normalizedKey = normalizeLicenseKey(body?.key);
    const license = licenses.get(normalizedKey);
    const deviceId = String(body?.deviceId ?? '');
    if (!license) return [404, { ok: false, error: 'invalid_key' }];
    if (path === '/v1/license/deactivate') {
      const removed = license.devices.delete(deviceId);
      return [200, { ok: true, removed, devicesUsed: license.devices.size, deviceLimit }];
    }
    if (license.revoked) return [403, { ok: false, error: 'revoked' }];
    if (path === '/v1/license/activate') {
      if (!license.devices.has(deviceId) && license.devices.size >= deviceLimit) return [409, { ok: false, error: 'device_limit' }];
      license.devices.add(deviceId);
      return [200, { ok: true, lease: lease(normalizedKey, deviceId), keyId: license.id, expiresAt: now() + LEASE_TTL_MS, devicesUsed: license.devices.size, deviceLimit }];
    }
    if (path === '/v1/license/validate') {
      if (!license.devices.has(deviceId)) return [404, { ok: false, error: 'not_activated' }];
      return [200, { ok: true, lease: lease(normalizedKey, deviceId), keyId: license.id, expiresAt: now() + LEASE_TTL_MS, devicesUsed: license.devices.size, deviceLimit }];
    }
    return [404, { ok: false, error: 'not_found' }];
  }

  async function fetch(url, init = {}) {
    if (offline) throw new TypeError('fetch failed');
    const [status, body] = handle(new URL(url).pathname, JSON.parse(init.body ?? '{}'));
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }

  return {
    fetch,
    handle,
    issueKey,
    calls,
    revoke(key) { licenses.get(key).revoked = true; },
    devices(key) { return [...licenses.get(key).devices]; },
    setOffline(value) { offline = value; },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createMockLicenseServer();
  const key = server.issueKey();
  createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* empty */ }
      const [status, payload] = ['POST', 'GET'].includes(req.method) ? server.handle(new URL(req.url, 'http://x').pathname, body) : [405, { ok: false, error: 'method' }];
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  }).listen(8787, '127.0.0.1', () => {
    console.log(`mock key server on http://127.0.0.1:8787, test key ${key}`);
    console.log(`HAMA_LICENSE_DEV_PUBLIC_KEY=${DEV_KEYPAIR.kid}:${DEV_KEYPAIR.publicKeyBase64}`);
  });
}
