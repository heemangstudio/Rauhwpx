// In-memory test double of the HamaEditor key server (docs/license-api.md).
// The desktop tests use .fetch; `node tests/fixtures/license-mock-server.mjs` serves it on
// http://127.0.0.1:8787 for manual runs (HAMA_LICENSE_API_BASE + HAMA_LICENSE_DEV_PUBLIC_KEY).
import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEV_KEYPAIR = JSON.parse(readFileSync(new URL('./license-dev-keypair.json', import.meta.url), 'utf8'));
export const DEV_PUBLIC_KEYS = Object.freeze({ [DEV_KEYPAIR.kid]: DEV_KEYPAIR.publicKeyBase64 });
const LEASE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function signLease(payload, keypair = DEV_KEYPAIR) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(null, Buffer.from(encoded, 'ascii'), createPrivateKey(keypair.privateKeyPkcs8Pem));
  return `${encoded}.${signature.toString('base64url')}`;
}

const keyHash = (key) => createHash('sha256').update(key, 'utf8').digest('hex');

export function createMockLicenseServer({ keypair = DEV_KEYPAIR, now = Date.now, deviceLimit = 2 } = {}) {
  const licenses = new Map();
  const calls = [];
  let offline = false;

  function issueKey() {
    const raw = randomBytes(10).toString('hex').toUpperCase();
    const key = `HAMA-${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`;
    licenses.set(key, { id: `lic_${licenses.size + 1}`, devices: new Set(), revoked: false });
    return key;
  }

  function lease(key, deviceId) {
    const issuedAt = now();
    return signLease({
      v: 1, kid: keypair.kid, keyId: licenses.get(key).id, keyHash: keyHash(key), deviceId, issuedAt, expiresAt: issuedAt + LEASE_TTL_MS,
    }, keypair);
  }

  function handle(path, body) {
    calls.push({ path, body });
    const license = licenses.get(String(body?.key ?? ''));
    const deviceId = String(body?.deviceId ?? '');
    if (!license) return [404, { error: 'invalid_key' }];
    if (license.revoked) return [403, { error: 'revoked' }];
    if (path === '/v1/license/activate') {
      if (!license.devices.has(deviceId) && license.devices.size >= deviceLimit) return [409, { error: 'device_limit' }];
      license.devices.add(deviceId);
      return [200, { lease: lease(body.key, deviceId) }];
    }
    if (path === '/v1/license/validate') {
      if (!license.devices.has(deviceId)) return [404, { error: 'not_activated' }];
      return [200, { lease: lease(body.key, deviceId) }];
    }
    if (path === '/v1/license/deactivate') {
      license.devices.delete(deviceId);
      return [200, { ok: true }];
    }
    return [404, { error: 'not_found' }];
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
      const [status, payload] = req.method === 'POST' ? server.handle(new URL(req.url, 'http://x').pathname, body) : [405, { error: 'method' }];
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  }).listen(8787, '127.0.0.1', () => {
    console.log(`mock key server on http://127.0.0.1:8787, test key ${key}`);
    console.log(`HAMA_LICENSE_DEV_PUBLIC_KEY=${DEV_KEYPAIR.kid}:${DEV_KEYPAIR.publicKeyBase64}`);
  });
}
