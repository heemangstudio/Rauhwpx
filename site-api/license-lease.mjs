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
 *   payload   = base64url(JSON.stringify({ v: 1, kid, keyId, keyHash, deviceId, issuedAt, expiresAt[, licenseExpiresAt] }))
 *   signature = base64url(Ed25519 over the ASCII bytes of the payload segment)
 *
 * issuedAt and expiresAt are epoch milliseconds. licenseExpiresAt (epoch ms) is the end of a
 * subscription key, signed so the app can enforce it offline; lifetime keys omit it, so their
 * leases are unchanged and older apps ignore the field. paymentGraceEndsAt (epoch ms) appears while
 * Groble is retrying a failed renewal: the key works until then. keyHash is the hex SHA-256 of the
 * license key as the app normalizes it (trim, uppercase, no whitespace), so a lease
 * cannot be moved onto another key.
 *
 * Account leases (v2) use the same encoding and signing key, with an account instead of a key:
 *   payload = { v: 2, kid, accountId, deviceId, keyId (primary license or null), tier, plan,
 *               issuedAt, expiresAt[, licenseExpiresAt][, paymentGraceEndsAt] }
 * Each version's verifier rejects the other as malformed.
 */

export const LEASE_VERSION = 1;
export const ACCOUNT_LEASE_VERSION = 2;
export const ACCOUNT_LEASE_TIERS = Object.freeze(['free', 'basic', 'pro', 'legacy', 'hama']);
export const ACCOUNT_LEASE_PLANS = Object.freeze(['monthly', 'annual', 'lifetime']);
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
  licenseExpiresAt = null,
  paymentGraceEndsAt = null,
}, privateKey) {
  const payload = {
    v: LEASE_VERSION,
    kid,
    keyId,
    keyHash: licenseKeyHash(key),
    deviceId,
    issuedAt: now,
    expiresAt: now + ttlMs,
    ...(Number.isSafeInteger(licenseExpiresAt) ? { licenseExpiresAt } : {}),
    ...(Number.isSafeInteger(paymentGraceEndsAt) ? { paymentGraceEndsAt } : {}),
  };
  return signPayload(payload, privateKey);
}

function signPayload(payload, privateKey) {
  const encoded = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = sign(null, Buffer.from(encoded, 'ascii'), privateKey);
  return { lease: `${encoded}.${b64url(signature)}`, payload };
}

/** Splits a lease and parses its payload object; null when it is not one. */
function decodeLease(lease) {
  if (typeof lease !== 'string' || lease.length > MAX_LEASE_CHARS) return null;
  const parts = lease.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return { parts, payload };
}

/** The payload's `v`, or null for anything that is not a lease. Routes v1 and v2 without verifying. */
export function leaseVersion(lease) {
  const v = decodeLease(lease)?.payload.v;
  return Number.isSafeInteger(v) ? v : null;
}

function validTimes({ issuedAt, expiresAt }) {
  return Number.isSafeInteger(issuedAt) && Number.isSafeInteger(expiresAt) && expiresAt > issuedAt
    && expiresAt - issuedAt <= LEASE_TTL_MS + ISSUED_AT_SKEW_MS;
}

/** kid lookup and signature check shared by both versions; null when the signature holds. */
function signatureProblem(parts, kid, publicKeys) {
  const publicKey = publicKeys && Object.hasOwn(publicKeys, kid) ? publicKeys[kid] : null;
  if (!publicKey) return 'unknown_kid';
  let valid = false;
  try {
    valid = verify(null, Buffer.from(parts[0], 'ascii'), parseLeasePublicKey(publicKey), Buffer.from(parts[1], 'base64url'));
  } catch {
    valid = false;
  }
  return valid ? null : 'bad_signature';
}

function timeProblem({ issuedAt, expiresAt }, now) {
  if (issuedAt - ISSUED_AT_SKEW_MS > now) return 'not_yet_valid';
  if (now >= expiresAt) return 'expired';
  return null;
}

/**
 * Verify a lease offline the same way the app does. `publicKeys` maps kid → public key
 * (any form parseLeasePublicKey accepts). Returns `{ ok: true, payload }` or `{ ok: false, reason }`.
 * reason: malformed | unknown_kid | bad_signature | wrong_device | wrong_key | expired | not_yet_valid.
 */
export function verifyLease(lease, publicKeys, { deviceId, key, now = Date.now() } = {}) {
  const decoded = decodeLease(lease);
  if (!decoded) return { ok: false, reason: 'malformed' };
  const { parts, payload } = decoded;
  const { v, kid, keyHash } = payload;
  if (v !== LEASE_VERSION || typeof kid !== 'string' || typeof keyHash !== 'string'
    || typeof payload.keyId !== 'string' || typeof payload.deviceId !== 'string' || !validTimes(payload)) {
    return { ok: false, reason: 'malformed' };
  }
  const signed = signatureProblem(parts, kid, publicKeys);
  if (signed) return { ok: false, reason: signed };
  if (deviceId !== undefined && payload.deviceId !== deviceId) return { ok: false, reason: 'wrong_device' };
  if (key !== undefined && keyHash !== licenseKeyHash(key)) return { ok: false, reason: 'wrong_key' };
  const timing = timeProblem(payload, now);
  return timing ? { ok: false, reason: timing } : { ok: true, payload };
}

/** Signs an account lease (v2). `ttlMs` is 7 days, or 3 days when the primary license is a beta key. */
export function signAccountLease({
  kid = DEFAULT_LEASE_KID,
  accountId,
  deviceId,
  keyId = null,
  tier = 'free',
  plan = null,
  now = Date.now(),
  ttlMs = LEASE_TTL_MS,
  licenseExpiresAt = null,
  paymentGraceEndsAt = null,
}, privateKey) {
  return signPayload({
    v: ACCOUNT_LEASE_VERSION,
    kid,
    accountId,
    deviceId,
    keyId,
    tier,
    plan,
    issuedAt: now,
    expiresAt: now + ttlMs,
    ...(Number.isSafeInteger(licenseExpiresAt) ? { licenseExpiresAt } : {}),
    ...(Number.isSafeInteger(paymentGraceEndsAt) ? { paymentGraceEndsAt } : {}),
  }, privateKey);
}

function validAccountPayload(payload) {
  const optionalTime = (value) => value === undefined || Number.isSafeInteger(value);
  return payload.v === ACCOUNT_LEASE_VERSION
    && typeof payload.kid === 'string'
    && typeof payload.accountId === 'string' && payload.accountId !== ''
    && typeof payload.deviceId === 'string' && payload.deviceId !== ''
    && (payload.keyId === null || typeof payload.keyId === 'string')
    && ACCOUNT_LEASE_TIERS.includes(payload.tier)
    && (payload.plan === null || ACCOUNT_LEASE_PLANS.includes(payload.plan))
    && validTimes(payload)
    && optionalTime(payload.licenseExpiresAt)
    && optionalTime(payload.paymentGraceEndsAt);
}

/**
 * Verify an account lease (v2). Same rules as verifyLease, with the account in place of the key.
 * reason: malformed | unknown_kid | bad_signature | wrong_device | wrong_account | expired | not_yet_valid.
 */
export function verifyAccountLease(lease, publicKeys, { deviceId, accountId, now = Date.now() } = {}) {
  const decoded = decodeLease(lease);
  if (!decoded || !validAccountPayload(decoded.payload)) return { ok: false, reason: 'malformed' };
  const { parts, payload } = decoded;
  const signed = signatureProblem(parts, payload.kid, publicKeys);
  if (signed) return { ok: false, reason: signed };
  if (deviceId !== undefined && payload.deviceId !== deviceId) return { ok: false, reason: 'wrong_device' };
  if (accountId !== undefined && payload.accountId !== accountId) return { ok: false, reason: 'wrong_account' };
  const timing = timeProblem(payload, now);
  return timing ? { ok: false, reason: timing } : { ok: true, payload };
}
