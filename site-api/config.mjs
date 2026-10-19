import path from 'node:path';

import { DEFAULT_GIFT_PLATFORMS } from './gifts.mjs';

export const DEFAULT_PORT = 5180;
export const RAILWAY_DATA_DIR = '/data';

/** Railway 볼륨은 /data. 로컬은 현재 디렉터리. */
export function resolveDataDir(env = process.env) {
  const explicit = typeof env.RAU_SITE_DATA === 'string' ? env.RAU_SITE_DATA.trim() : '';
  if (explicit) return explicit;
  return env.RAILWAY_ENVIRONMENT ? RAILWAY_DATA_DIR : '.';
}

export function resolveUniqueInstallsDbPath(env = process.env) {
  return path.join(resolveDataDir(env), 'unique-installs.json');
}

export function resolveWaitlistDbPath(env = process.env) {
  return path.join(resolveDataDir(env), 'waitlist.json');
}

export function resolveUniqueInstallPingKey(env = process.env) {
  return typeof env.RAU_UNIQUE_INSTALL_PING_KEY === 'string'
    ? env.RAU_UNIQUE_INSTALL_PING_KEY.trim()
    : '';
}

export function resolveLicensesDbPath(env = process.env) {
  return path.join(resolveDataDir(env), 'licenses.json');
}

export function resolveDownloadsDbPath(env = process.env) {
  return path.join(resolveDataDir(env), 'downloads.json');
}

export function resolveWebhookLogDbPath(env = process.env) {
  return path.join(resolveDataDir(env), 'webhook-log.json');
}

export const DEFAULT_LICENSE_ALLOWED_ORIGINS = [
  'https://heemangstudios.com',
  'https://www.heemangstudios.com',
  'https://heemangstudio.github.io',
];

/** Groble products: the one-time lifetime license and the 12-month auto-renewing subscription. */
export const DEFAULT_ONETIME_PRODUCT_IDS = 'uRshdR';
export const DEFAULT_SUBSCRIPTION_PRODUCT_IDS = 'GLJFC9';
/**
 * After a failed renewal Groble retries once a day for 3 days, then keeps the subscription for a 7-day
 * grace period (groble.im/legal/refund 제6조 제13항). Keys stay usable this long past their expiry
 * when the failure event carries no grace end of its own.
 */
export const DEFAULT_PAYMENT_GRACE_DAYS = 10;
/** Groble's buyer 주문조회 page, where a buyer sees the subscription and pays again. */
export const DEFAULT_PAYMENT_FIX_URL = 'https://groble.im/manage/purchase';

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function commaList(text, fallback) {
  return (text || fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

/** License settings from env. Parsing errors throw at startup so a typo never ships silently. */
export function resolveLicenseConfig(env = process.env) {
  const origins = trimmed(env.LICENSE_ALLOWED_ORIGINS);
  const cutoffText = trimmed(env.GRANDFATHER_CUTOFF);
  let grandfatherCutoff;
  if (cutoffText) {
    grandfatherCutoff = Date.parse(cutoffText);
    if (!Number.isFinite(grandfatherCutoff)) {
      throw new Error(`GRANDFATHER_CUTOFF is not an ISO-8601 time: ${cutoffText}`);
    }
  }
  const price = Number(trimmed(env.GROBLE_EXPECTED_PRICE) || 9900);
  const minAmount = Number(trimmed(env.GROBLE_MIN_AMOUNT) || price);
  if (!Number.isSafeInteger(price) || !Number.isSafeInteger(minAmount)) {
    throw new Error('GROBLE_EXPECTED_PRICE and GROBLE_MIN_AMOUNT must be integers (KRW)');
  }
  // GROBLE_CONTENT_ID is the older single-product variable; GROBLE_ONETIME_PRODUCT_IDS wins when both are set.
  const onetimeProductIds = commaList(trimmed(env.GROBLE_ONETIME_PRODUCT_IDS) || trimmed(env.GROBLE_CONTENT_ID), DEFAULT_ONETIME_PRODUCT_IDS);
  const subscriptionProductIds = commaList(trimmed(env.GROBLE_SUBSCRIPTION_PRODUCT_IDS), DEFAULT_SUBSCRIPTION_PRODUCT_IDS);
  const overlap = onetimeProductIds.filter((id) => subscriptionProductIds.includes(id));
  if (overlap.length) throw new Error(`Groble product ${overlap.join(', ')} is both one-time and subscription`);
  const paymentGraceDays = positiveNumber('GROBLE_PAYMENT_GRACE_DAYS', trimmed(env.GROBLE_PAYMENT_GRACE_DAYS), DEFAULT_PAYMENT_GRACE_DAYS);
  const paymentFixUrl = trimmed(env.GROBLE_PAYMENT_FIX_URL) || DEFAULT_PAYMENT_FIX_URL;
  if (!/^https:\/\/(?:www\.)?groble\.im\//.test(paymentFixUrl)) throw new Error(`GROBLE_PAYMENT_FIX_URL must be an https://groble.im/ page: ${paymentFixUrl}`);
  return {
    webhookSecret: trimmed(env.GROBLE_WEBHOOK_SECRET),
    webhookSecretPrevious: trimmed(env.GROBLE_WEBHOOK_SECRET_PREVIOUS),
    onetimeProductIds,
    subscriptionProductIds,
    paymentGraceMs: paymentGraceDays * 24 * 60 * 60 * 1000,
    paymentFixUrl,
    expectedPrice: price,
    minAmount,
    signingPrivateKey: trimmed(env.LICENSE_SIGNING_PRIVATE_KEY),
    signingKeyId: trimmed(env.LICENSE_SIGNING_KEY_ID) || 'hama-prod-1',
    adminToken: trimmed(env.ADMIN_TOKEN),
    grandfatherCutoff,
    grandfatherPlatforms: (trimmed(env.GRANDFATHER_PLATFORMS) || 'darwin').split(',').map((s) => s.trim()).filter(Boolean),
    allowedOrigins: origins ? origins.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_LICENSE_ALLOWED_ORIGINS,
    downloadUrl: trimmed(env.LICENSE_DOWNLOAD_URL) || 'https://heemangstudios.com/',
  };
}

export function resolveGiftsDbPath(env = process.env) {
  return path.join(resolveDataDir(env), 'gifts.json');
}

export const DEFAULT_OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

function positiveNumber(name, text, fallback) {
  if (!text) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number: ${text}`);
  return value;
}

/**
 * Gift credit event from env. The event exists only when both the provisioning key and the
 * event id are set; otherwise every gift route answers event_inactive.
 */
export function resolveGiftConfig(env = process.env) {
  const endsText = trimmed(env.GIFT_ENDS_AT);
  let endsAt;
  if (endsText) {
    endsAt = Date.parse(endsText);
    if (!Number.isFinite(endsAt)) throw new Error(`GIFT_ENDS_AT is not an ISO-8601 time: ${endsText}`);
  }
  const maxOutputTokens = positiveNumber('GIFT_MAX_OUTPUT_TOKENS', trimmed(env.GIFT_MAX_OUTPUT_TOKENS), 32000);
  if (!Number.isSafeInteger(maxOutputTokens)) throw new Error('GIFT_MAX_OUTPUT_TOKENS must be an integer');
  return {
    provisioningKey: trimmed(env.OPENROUTER_PROVISIONING_KEY),
    eventId: trimmed(env.GIFT_EVENT_ID),
    amountUsd: positiveNumber('GIFT_AMOUNT_USD', trimmed(env.GIFT_AMOUNT_USD), 20),
    endsAt,
    totalBudgetUsd: positiveNumber('GIFT_TOTAL_BUDGET_USD', trimmed(env.GIFT_TOTAL_BUDGET_USD), undefined),
    modelPrefixes: commaList(trimmed(env.GIFT_MODEL_PREFIXES), 'anthropic/'),
    platforms: commaList(trimmed(env.GIFT_PLATFORMS), DEFAULT_GIFT_PLATFORMS.join(',')),
    maxOutputTokens,
    apiBase: (trimmed(env.OPENROUTER_API_BASE) || DEFAULT_OPENROUTER_API_BASE).replace(/\/+$/, ''),
  };
}
