// HamaEditor 라이선스 lease: 키 서버가 Ed25519 로 서명하고, 앱이 내장 공개키로 오프라인 검증한다.
//
// 형식: <payload>.<signature>
//   payload   = base64url(JSON.stringify({ v, kid, keyId, keyHash, deviceId, issuedAt, expiresAt[, licenseExpiresAt] }))
//   signature = base64url(Ed25519(payload 문자열의 ASCII 바이트))
// issuedAt, expiresAt 는 epoch 밀리초. expiresAt = issuedAt + 7일 (오프라인 유예).
// licenseExpiresAt 은 연간 구독 키가 끝나는 시각(epoch 밀리초). 평생 키의 lease 에는 없다.
// keyHash = sha256(정규화한 라이선스 키) 의 hex. 다른 키에 lease 를 옮겨 붙이지 못하게 한다.
// 계약 전체는 docs/license-api.md 에 있다.
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

export const LEASE_VERSION = 1;
export const LEASE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 서버와 앱 시계가 조금 어긋나도 막 발급한 lease 를 받는다. */
const ISSUED_AT_SKEW_MS = 10 * 60 * 1000;
const MAX_LEASE_CHARS = 4096;

/**
 * 출시 빌드가 믿는 공개키. kid → raw 32바이트 Ed25519 공개키(base64).
 * 키 서버(GET /v1/license/public-key 의 rawBase64)와 같은 값이다. 개인키는 서버에만 있다.
 */
export const PRODUCTION_LICENSE_PUBLIC_KEYS = Object.freeze({
  'hama-prod-1': 'UH46oBHmV639T/ubZNdW+S3q6EywftOp3zZVfuzEVtM=',
});

export function normalizeLicenseKey(raw) {
  if (typeof raw !== 'string' || raw.length > 64) return '';
  let value = raw.toUpperCase().replace(/[\s-]/g, '');
  if (value.startsWith('HAMA')) value = value.slice(4);
  value = value.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (value.length !== 25) return '';
  const key = `HAMA-${value.match(/.{5}/g).join('-')}`;
  return /^HAMA(?:-[0-9A-HJKMNP-TV-Z]{5}){5}$/.test(key) ? key : '';
}

export function licenseKeyHash(key) {
  const normalized = normalizeLicenseKey(key);
  if (!normalized) throw new Error('invalid license key');
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function maskLicenseKey(key) {
  const normalized = normalizeLicenseKey(key);
  if (!normalized) return '';
  return `${normalized.slice(0, 5)}…${normalized.slice(-4)}`;
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function publicKeyObject(rawBase64) {
  const raw = Buffer.from(String(rawBase64), 'base64');
  if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: base64url(raw) }, format: 'jwk' });
}

const keyCache = new Map();
function cachedPublicKey(rawBase64) {
  let key = keyCache.get(rawBase64);
  if (!key) {
    key = publicKeyObject(rawBase64);
    keyCache.set(rawBase64, key);
  }
  return key;
}

/** 서명을 확인하지 않고 payload 만 읽는다. 검증 전 값은 믿지 말 것. */
export function decodeLeaseUnverified(lease) {
  if (typeof lease !== 'string' || lease.length > MAX_LEASE_CHARS) return null;
  const parts = lease.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

/**
 * lease 를 검증한다. 성공하면 { ok: true, payload }, 아니면 { ok: false, reason }.
 * reason: malformed | unknown_kid | bad_signature | wrong_device | wrong_key | expired | not_yet_valid
 */
export function verifyLease(lease, {
  publicKeys = PRODUCTION_LICENSE_PUBLIC_KEYS,
  deviceId,
  key,
  keyId,
  now = Date.now(),
} = {}) {
  const payload = decodeLeaseUnverified(lease);
  if (!payload) return { ok: false, reason: 'malformed' };
  const { v, kid, keyHash, issuedAt, expiresAt } = payload;
  if (v !== LEASE_VERSION || typeof kid !== 'string' || typeof keyHash !== 'string'
    || typeof payload.deviceId !== 'string' || !Number.isSafeInteger(issuedAt)
    || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt
    || expiresAt - issuedAt > LEASE_TTL_MS) {
    return { ok: false, reason: 'malformed' };
  }
  const rawKey = Object.hasOwn(publicKeys, kid) ? publicKeys[kid] : null;
  if (typeof rawKey !== 'string' || !rawKey) return { ok: false, reason: 'unknown_kid' };
  const [encodedPayload, encodedSignature] = lease.split('.');
  let valid = false;
  try {
    valid = verifySignature(
      null,
      Buffer.from(encodedPayload, 'ascii'),
      cachedPublicKey(rawKey),
      Buffer.from(encodedSignature, 'base64url'),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };
  if (deviceId !== undefined && payload.deviceId !== deviceId) return { ok: false, reason: 'wrong_device' };
  if (key !== undefined) {
    let expected = null;
    try { expected = licenseKeyHash(key); } catch { expected = null; }
    if (keyHash !== expected) return { ok: false, reason: 'wrong_key' };
  }
  if (keyId !== undefined && payload.keyId !== keyId) return { ok: false, reason: 'wrong_key' };
  if (issuedAt - ISSUED_AT_SKEW_MS > now) return { ok: false, reason: 'not_yet_valid' };
  if (now >= expiresAt) return { ok: false, reason: 'expired', payload };
  return { ok: true, payload };
}

// 계정 lease(v2). 같은 서명 키와 kid 로 서명한다. 계약은 site-api/license-lease.mjs 의 signAccountLease 와 같다.
//   payload = { v: 2, kid, accountId, deviceId, keyId, tier, plan, issuedAt, expiresAt[, licenseExpiresAt][, paymentGraceEndsAt] }
// keyId 는 계정의 대표 라이선스(없으면 null), tier 는 'free' | 'pro' | 'legacy' | 'hama'. v1 검증은 v2 를, v2 검증은 v1 을 받지 않는다.
export const ACCOUNT_LEASE_VERSION = 2;
export const ACCOUNT_TIERS = Object.freeze(['free', 'pro', 'legacy', 'hama']);
const ACCOUNT_PLANS = new Set(['monthly', 'annual', 'lifetime']);

function optionalEpoch(value) {
  return value === undefined || value === null || Number.isSafeInteger(value);
}

/**
 * 계정 lease 를 검증한다. 성공하면 { ok: true, payload }, 아니면 { ok: false, reason }(만료면 payload 도).
 * reason: malformed | unknown_kid | bad_signature | wrong_device | wrong_account | expired | not_yet_valid
 */
export function verifyAccountLease(lease, {
  publicKeys = PRODUCTION_LICENSE_PUBLIC_KEYS,
  deviceId,
  accountId,
  now = Date.now(),
} = {}) {
  const payload = decodeLeaseUnverified(lease);
  if (!payload) return { ok: false, reason: 'malformed' };
  const { v, kid, issuedAt, expiresAt } = payload;
  if (v !== ACCOUNT_LEASE_VERSION || typeof kid !== 'string' || typeof payload.accountId !== 'string' || !payload.accountId
    || typeof payload.deviceId !== 'string' || !(payload.keyId === null || typeof payload.keyId === 'string')
    || !ACCOUNT_TIERS.includes(payload.tier) || !(payload.plan === null || ACCOUNT_PLANS.has(payload.plan))
    || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt
    || expiresAt - issuedAt > LEASE_TTL_MS
    || !optionalEpoch(payload.licenseExpiresAt) || !optionalEpoch(payload.paymentGraceEndsAt)) {
    return { ok: false, reason: 'malformed' };
  }
  const rawKey = Object.hasOwn(publicKeys, kid) ? publicKeys[kid] : null;
  if (typeof rawKey !== 'string' || !rawKey) return { ok: false, reason: 'unknown_kid' };
  const [encodedPayload, encodedSignature] = lease.split('.');
  let valid = false;
  try {
    valid = verifySignature(
      null,
      Buffer.from(encodedPayload, 'ascii'),
      cachedPublicKey(rawKey),
      Buffer.from(encodedSignature, 'base64url'),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };
  if (deviceId !== undefined && payload.deviceId !== deviceId) return { ok: false, reason: 'wrong_device' };
  if (accountId !== undefined && payload.accountId !== accountId) return { ok: false, reason: 'wrong_account' };
  if (issuedAt - ISSUED_AT_SKEW_MS > now) return { ok: false, reason: 'not_yet_valid' };
  if (now >= expiresAt) return { ok: false, reason: 'expired', payload };
  return { ok: true, payload };
}
