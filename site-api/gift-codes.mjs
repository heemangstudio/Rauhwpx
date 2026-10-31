import { createHash, randomBytes } from 'node:crypto';

/**
 * Gift code format helpers. A code is `GIFT-XXXX-XXXX-XXXX-XXXX`: 16 Crockford base32 characters
 * carrying 80 random bits. The server keeps only the SHA-256 of the normalized code and its first
 * group (`GIFT-XXXX`) for display; the plaintext exists once, in the issue answer. The issue and
 * redeem logic lives in licenses.mjs, so a redeem and the license it creates are one mutation.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
export const GIFT_CODE_RE = /^GIFT(?:-[0-9A-HJKMNP-TV-Z]{4}){4}$/;
/** Editions a gift code can grant: the two the server sells on a billing cycle. */
export const GIFT_CODE_PLANS = ['basic', 'hama'];
export const MAX_GIFT_CODES_PER_BATCH = 1000;
export const MAX_GIFT_DURATION_MONTHS = 120;
export const MAX_GIFT_DURATION_DAYS = 3660;

export function generateGiftCode(random = randomBytes) {
  const bytes = random(10);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return `GIFT-${out.match(/.{4}/g).join('-')}`;
}

/** Uppercase, strip spaces and dashes, accept a missing GIFT- prefix and the usual O/I/L look-alikes. '' when it cannot be a code. */
export function normalizeGiftCode(value) {
  if (typeof value !== 'string' || value.length > 64) return '';
  let raw = value.toUpperCase().replace(/[\s-]/g, '');
  if (raw.length === 20 && raw.startsWith('GIFT')) raw = raw.slice(4);
  raw = raw.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (raw.length !== 16) return '';
  const code = `GIFT-${raw.match(/.{4}/g).join('-')}`;
  return GIFT_CODE_RE.test(code) ? code : '';
}

/** SHA-256 hex of a normalized code: the only form the server stores. */
export function giftCodeHash(code) {
  return createHash('sha256').update(code).digest('hex');
}

/** `GIFT-ABCD`: the first group, kept for display. */
export function giftCodePrefix(code) {
  return code.slice(0, 9);
}

/** `GIFT-ABCD-••••-••••-••••` from a stored prefix. */
export function maskGiftCode(prefix) {
  return `${prefix}-••••-••••-••••`;
}
