import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';

/**
 * Ed25519-signed activation leases.
 *
 * A lease is `${base64url(JSON payload)}.${base64url(signature)}`. The payload is
 * `{ v: 1, keyId, deviceId, issuedAt, expiresAt }` with ISO-8601 UTC timestamps.
 * The desktop app pins the public key and calls `verifyLease` offline, so this
 * file only uses node:crypto and can be copied into the app unchanged.
 */

export const LEASE_VERSION = 1;
export const LEASE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

/** Accepts PKCS#8 PEM, or base64/base64url of the PKCS#8 DER (handy for one-line env vars). */
export function parseSigningPrivateKey(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  const key = text.includes('-----BEGIN')
    ? createPrivateKey(text.replace(/\\n/g, '\n'))
    : createPrivateKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('LICENSE_SIGNING_PRIVATE_KEY must be an Ed25519 key');
  }
  return key;
}

/** Accepts SPKI PEM, or base64 of the SPKI DER. */
export function parseLeasePublicKey(value) {
  if (value && typeof value === 'object') return value;
  const text = typeof value === 'string' ? value.trim() : '';
  const key = text.includes('-----BEGIN')
    ? createPublicKey(text.replace(/\\n/g, '\n'))
    : createPublicKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Lease public key must be Ed25519');
  return key;
}

export function generateLeaseKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    privateKeyDerBase64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
    publicKeyDerBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

export function publicKeyFromPrivate(privateKey) {
  return createPublicKey(privateKey);
}

export function signLease({ keyId, deviceId, now = Date.now(), ttlMs = LEASE_TTL_MS }, privateKey) {
  const payload = {
    v: LEASE_VERSION,
    keyId,
    deviceId,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = sign(null, body, privateKey);
  return { lease: `${b64url(body)}.${b64url(signature)}`, payload };
}

/**
 * Verify a lease offline. Returns `{ ok: true, payload }` or `{ ok: false, reason }`.
 * reason: 'malformed' | 'bad_signature' | 'wrong_device' | 'expired' | 'not_yet_valid'.
 */
export function verifyLease(lease, publicKey, { deviceId, now = Date.now(), clockSkewMs = 5 * 60 * 1000 } = {}) {
  if (typeof lease !== 'string' || lease.length > 4096) return { ok: false, reason: 'malformed' };
  const parts = lease.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  let body;
  let signature;
  let payload;
  try {
    body = Buffer.from(parts[0], 'base64url');
    signature = Buffer.from(parts[1], 'base64url');
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  let valid = false;
  try {
    valid = signature.length === 64 && verify(null, body, parseLeasePublicKey(publicKey), signature);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };
  if (!payload || payload.v !== LEASE_VERSION || typeof payload.keyId !== 'string'
    || typeof payload.deviceId !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  if (deviceId !== undefined && payload.deviceId !== deviceId) return { ok: false, reason: 'wrong_device' };
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return { ok: false, reason: 'malformed' };
  if (issuedAt - clockSkewMs > now) return { ok: false, reason: 'not_yet_valid' };
  if (expiresAt <= now) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}
