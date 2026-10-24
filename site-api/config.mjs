import path from 'node:path';

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

/** Issue reports, one directory each plus index.json. */
export function resolveFeedbackDir(env = process.env) {
  return path.join(resolveDataDir(env), 'feedback');
}

export function resolveFeedbackProofKey(env = process.env) {
  return typeof env.RAU_FEEDBACK_PROOF_KEY === 'string' ? env.RAU_FEEDBACK_PROOF_KEY.trim() : '';
}

/** RAU_FEEDBACK_MAX_BYTES caps all stored reports together; undefined means the module default. */
export function resolveFeedbackMaxBytes(env = process.env) {
  const text = typeof env.RAU_FEEDBACK_MAX_BYTES === 'string' ? env.RAU_FEEDBACK_MAX_BYTES.trim() : '';
  if (!text) return undefined;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`RAU_FEEDBACK_MAX_BYTES must be a positive integer: ${text}`);
  return value;
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

/** Groble products: paused one-time lifetime, the 12-month subscription, and Signature Edition. */
export const DEFAULT_ONETIME_PRODUCT_IDS = 'uRshdR';
export const DEFAULT_SUBSCRIPTION_PRODUCT_IDS = 'GLJFC9';
export const DEFAULT_SIGNATURE_PRODUCT_IDS = '8Xy27f';
export const DEFAULT_SIGNATURE_PRICE = 29000;
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

function integerKrw(name, text, fallback) {
  const value = Number(text || fallback);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer (KRW)`);
  return value;
}

/** `id:price` or `id:price:min`, comma-separated. A min alone is not accepted. */
function productPriceOverrides(text) {
  const overrides = new Map();
  if (!text) return overrides;
  for (const part of text.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const [id, priceText, minText] = entry.split(':').map((s) => s.trim());
    const expectedPrice = Number(priceText);
    const minAmount = minText === undefined ? expectedPrice : Number(minText);
    if (!id || !Number.isSafeInteger(expectedPrice) || !Number.isSafeInteger(minAmount)) {
      throw new Error(`GROBLE_PRODUCT_PRICES entry is not id:price[:min]: ${entry}`);
    }
    overrides.set(id, { expectedPrice, minAmount });
  }
  return overrides;
}

/**
 * One row per Groble product. Price checks read this table, so Signature at ₩29,000
 * is not judged against the ₩9,900 yearly price.
 */
export function buildProductCatalog({
  onetimeProductIds,
  subscriptionProductIds,
  signatureProductIds,
  expectedPrice,
  minAmount,
  signatureExpectedPrice,
  signatureMinAmount,
  priceOverrides = new Map(),
}) {
  const groups = [
    ['one-time', 'onetime', onetimeProductIds, expectedPrice, minAmount],
    ['subscription', 'subscription', subscriptionProductIds, expectedPrice, minAmount],
    ['signature', 'signature', signatureProductIds, signatureExpectedPrice, signatureMinAmount],
  ];
  const seen = new Map();
  const products = [];
  for (const [label, kind, ids, price, min] of groups) {
    for (const id of ids) {
      const previous = seen.get(id);
      if (previous) throw new Error(`Groble product ${id} is both ${previous} and ${label}`);
      seen.set(id, label);
      const override = priceOverrides.get(id);
      products.push({
        id,
        kind,
        expectedPrice: override?.expectedPrice ?? price,
        minAmount: override?.minAmount ?? min,
      });
    }
  }
  for (const id of priceOverrides.keys()) {
    if (!seen.has(id)) throw new Error(`GROBLE_PRODUCT_PRICES names ${id}, which is not a configured Groble product`);
  }
  return products;
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
  const price = integerKrw('GROBLE_EXPECTED_PRICE', trimmed(env.GROBLE_EXPECTED_PRICE), 9900);
  const minAmount = integerKrw('GROBLE_MIN_AMOUNT', trimmed(env.GROBLE_MIN_AMOUNT), price);
  const signatureExpectedPrice = integerKrw('GROBLE_SIGNATURE_EXPECTED_PRICE', trimmed(env.GROBLE_SIGNATURE_EXPECTED_PRICE), DEFAULT_SIGNATURE_PRICE);
  const signatureMinAmount = integerKrw('GROBLE_SIGNATURE_MIN_AMOUNT', trimmed(env.GROBLE_SIGNATURE_MIN_AMOUNT), signatureExpectedPrice);
  // GROBLE_CONTENT_ID is the older single-product variable; GROBLE_ONETIME_PRODUCT_IDS wins when both are set.
  const onetimeProductIds = commaList(trimmed(env.GROBLE_ONETIME_PRODUCT_IDS) || trimmed(env.GROBLE_CONTENT_ID), DEFAULT_ONETIME_PRODUCT_IDS);
  const subscriptionProductIds = commaList(trimmed(env.GROBLE_SUBSCRIPTION_PRODUCT_IDS), DEFAULT_SUBSCRIPTION_PRODUCT_IDS);
  const signatureProductIds = commaList(trimmed(env.GROBLE_SIGNATURE_PRODUCT_IDS), DEFAULT_SIGNATURE_PRODUCT_IDS);
  const products = buildProductCatalog({
    onetimeProductIds,
    subscriptionProductIds,
    signatureProductIds,
    expectedPrice: price,
    minAmount,
    signatureExpectedPrice,
    signatureMinAmount,
    priceOverrides: productPriceOverrides(trimmed(env.GROBLE_PRODUCT_PRICES)),
  });
  const paymentGraceDays = positiveNumber('GROBLE_PAYMENT_GRACE_DAYS', trimmed(env.GROBLE_PAYMENT_GRACE_DAYS), DEFAULT_PAYMENT_GRACE_DAYS);
  const paymentFixUrl = trimmed(env.GROBLE_PAYMENT_FIX_URL) || DEFAULT_PAYMENT_FIX_URL;
  if (!/^https:\/\/(?:www\.)?groble\.im\//.test(paymentFixUrl)) throw new Error(`GROBLE_PAYMENT_FIX_URL must be an https://groble.im/ page: ${paymentFixUrl}`);
  return {
    webhookSecret: trimmed(env.GROBLE_WEBHOOK_SECRET),
    webhookSecretPrevious: trimmed(env.GROBLE_WEBHOOK_SECRET_PREVIOUS),
    onetimeProductIds,
    subscriptionProductIds,
    signatureProductIds,
    signatureExpectedPrice,
    signatureMinAmount,
    products,
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
    platforms: commaList(trimmed(env.GIFT_PLATFORMS), 'darwin,win32'),
    maxOutputTokens,
    apiBase: (trimmed(env.OPENROUTER_API_BASE) || DEFAULT_OPENROUTER_API_BASE).replace(/\/+$/, ''),
  };
}
