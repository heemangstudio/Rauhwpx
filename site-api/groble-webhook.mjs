import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Groble webhook signature check, per https://www.groble.im/help/guides/webhook (read 2026-10-16):
 *   X-Groble-Signature = HEX(HMAC-SHA256(secret, `${X-Groble-Timestamp}.${raw_body}`))
 *   X-Groble-Timestamp = Unix seconds, accept ±5 minutes
 *   X-Groble-Signature-Previous = same, with the previous secret, for 24h after a rotation
 */
export const GROBLE_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export function grobleSignature(secret, timestamp, rawBody) {
  return createHmac('sha256', String(secret))
    .update(`${timestamp}.`, 'utf8')
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8'))
    .digest('hex');
}

function hexEqual(candidate, expectedHex) {
  if (typeof candidate !== 'string') return false;
  const trimmed = candidate.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(trimmed)) return false;
  const left = Buffer.from(trimmed, 'hex');
  const right = Buffer.from(expectedHex, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function header(headers, name) {
  const value = headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Returns { ok: true, timestamp, idempotencyKey, matched: 'current'|'previous' } or
 * { ok: false, reason: 'not_configured'|'missing_headers'|'bad_timestamp'|'timestamp_out_of_window'|'bad_signature' }.
 * Signatures are checked before the timestamp window so an attacker learns nothing about timing.
 */
export function verifyGrobleWebhook({ headers, rawBody, secret, previousSecret, nowMs = Date.now() }) {
  if (!secret) return { ok: false, reason: 'not_configured' };
  const signature = header(headers, 'x-groble-signature');
  const signaturePrevious = header(headers, 'x-groble-signature-previous');
  const timestamp = header(headers, 'x-groble-timestamp');
  if (typeof timestamp !== 'string' || (!signature && !signaturePrevious)) {
    return { ok: false, reason: 'missing_headers' };
  }
  const ts = timestamp.trim();
  if (!/^\d{1,13}$/.test(ts)) return { ok: false, reason: 'bad_timestamp' };

  // Groble signs the current secret into X-Groble-Signature and, during a rotation, the old one
  // into X-Groble-Signature-Previous. We accept any header matching any secret we hold, because
  // after rotating in Groble the env var may still hold the old secret for a while.
  const secrets = [['current', secret]];
  if (previousSecret) secrets.push(['previous', previousSecret]);
  let matched = null;
  for (const [label, value] of secrets) {
    const expected = grobleSignature(value, ts, rawBody);
    if (hexEqual(signature, expected) || hexEqual(signaturePrevious, expected)) {
      matched = label;
      break;
    }
  }
  if (!matched) return { ok: false, reason: 'bad_signature' };

  const seconds = Number(ts);
  if (Math.abs(nowMs / 1000 - seconds) > GROBLE_TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_window' };
  }
  const idempotencyKey = header(headers, 'x-groble-idempotency-key');
  return {
    ok: true,
    timestamp: seconds,
    idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey.trim().slice(0, 200) : '',
    matched,
  };
}
