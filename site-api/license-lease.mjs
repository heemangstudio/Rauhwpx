import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';

/**
 * Ed25519-signed activation leases. The desktop app (desktop/license-lease.mjs on
 * feat/license-gate) pins the public key per `kid` and verifies offline; this file is
 * the source of truth for the format and only uses node:crypto.
 *
 *   lease     = `${payload}.${signature}`
 *   payload   = base64url(JSON.stringify({ v: 1, kid, keyId, keyHash, deviceId, issuedAt, expiresAt }))
 *   signature = base64url(Ed25519 over the ASCII bytes of the payload segment)
 *
 * issuedAt and expiresAt are epoch milliseconds. keyHash is the hex SHA-256 of the
 * license key as the app normalizes it (trim, uppercase, no whitespace), so a lease
 * cannot be moved onto another key.
 */

export const LEASE_VERSION = 1;
export const LEASE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Beta keys get a shorter lease so a revoked tester key stops working within 3 days offline. */
export const BETA_LEASE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const DEFAULT_LEASE_KID = 'hama-prod-1';
const ISSUED_AT_SKEW_MS = 10 * 60 * 1000;
const MAX_LEASE_CHARS = 4096;

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

/** The app's normalization: trim, uppercase, drop whitespace. Dashes are kept. */
export function leaseKeyText(key) {
  return String(key ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

export function licenseKeyHash(key) {
  return createHash('sha256').update(leaseKeyText(key), 'utf8').digest('hex');
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

/** Accepts a KeyObject, SPKI PEM, base64 SPKI DER, or the raw 32-byte key in base64 (the app's form). */
export function parseLeasePublicKey(value) {
  if (value && typeof value === 'object') return value;
  const text = typeof value === 'string' ? value.trim() : '';
  let key;
  if (text.includes('-----BEGIN')) {
    key = createPublicKey(text.replace(/\\n/g, '\n'));
  } else {
    const bytes = Buffer.from(text, 'base64');
    key = bytes.length === 32
      ? createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(bytes) }, format: 'jwk' })
      : createPublicKey({ key: bytes, format: 'der', type: 'spki' });
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Lease public key must be Ed25519');
  return key;
}

/** Raw 32-byte Ed25519 public key in base64, the value the app pins. */
export function rawPublicKeyBase64(publicKey) {
  return Buffer.from(parseLeasePublicKey(publicKey).export({ format: 'jwk' }).x, 'base64url').toString('base64');
}

export function generateLeaseKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    privateKeyDerBase64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
    publicKeyDerBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    publicKeyRawBase64: rawPublicKeyBase64(publicKey),
  };
}

export function publicKeyFromPrivate(privateKey) {
  return createPublicKey(privateKey);
}

export function signLease({
  kid = DEFAULT_LEASE_KID,
  keyId,
  key,
  deviceId,
  now = Date.now(),
  ttlMs = LEASE_TTL_MS,
}, privateKey) {
  const payload = {
    v: LEASE_VERSION,
    kid,
    keyId,
    keyHash: licenseKeyHash(key),
    deviceId,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
  const encoded = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = sign(null, Buffer.from(encoded, 'ascii'), privateKey);
  return { lease: `${encoded}.${b64url(signature)}`, payload };
}

/**
 * Verify a lease offline the same way the app does. `publicKeys` maps kid → public key
 * (any form parseLeasePublicKey accepts). Returns `{ ok: true, payload }` or `{ ok: false, reason }`.
 * reason: malformed | unknown_kid | bad_signature | wrong_device | wrong_key | expired | not_yet_valid.
 */
export function verifyLease(lease, publicKeys, { deviceId, key, now = Date.now() } = {}) {
  if (typeof lease !== 'string' || lease.length > MAX_LEASE_CHARS) return { ok: false, reason: 'malformed' };
  const parts = lease.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'malformed' };
  const { v, kid, keyHash, issuedAt, expiresAt } = payload;
  if (v !== LEASE_VERSION || typeof kid !== 'string' || typeof keyHash !== 'string'
    || typeof payload.keyId !== 'string' || typeof payload.deviceId !== 'string'
    || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt
    || expiresAt - issuedAt > LEASE_TTL_MS + ISSUED_AT_SKEW_MS) {
    return { ok: false, reason: 'malformed' };
  }
  const publicKey = publicKeys && Object.hasOwn(publicKeys, kid) ? publicKeys[kid] : null;
  if (!publicKey) return { ok: false, reason: 'unknown_kid' };
  let valid = false;
  try {
    valid = verify(null, Buffer.from(parts[0], 'ascii'), parseLeasePublicKey(publicKey), Buffer.from(parts[1], 'base64url'));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };
  if (deviceId !== undefined && payload.deviceId !== deviceId) return { ok: false, reason: 'wrong_device' };
  if (key !== undefined && keyHash !== licenseKeyHash(key)) return { ok: false, reason: 'wrong_key' };
  if (issuedAt - ISSUED_AT_SKEW_MS > now) return { ok: false, reason: 'not_yet_valid' };
  if (now >= expiresAt) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}
