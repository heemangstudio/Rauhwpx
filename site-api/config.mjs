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

export function resolveLicensesDbPath(env = process.env) {
  return path.join(resolveDataDir(env), 'licenses.json');
}

export function resolveWebhookLogDbPath(env = process.env) {
  return path.join(resolveDataDir(env), 'webhook-log.json');
}

export const DEFAULT_LICENSE_ALLOWED_ORIGINS = [
  'https://heemangstudios.com',
  'https://www.heemangstudios.com',
  'https://heemangstudio.github.io',
];

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
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
  return {
    webhookSecret: trimmed(env.GROBLE_WEBHOOK_SECRET),
    webhookSecretPrevious: trimmed(env.GROBLE_WEBHOOK_SECRET_PREVIOUS),
    grobleContentId: trimmed(env.GROBLE_CONTENT_ID) || 'uRshdR',
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

function commaList(text, fallback) {
  return (text || fallback).split(',').map((s) => s.trim()).filter(Boolean);
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
    platforms: commaList(trimmed(env.GIFT_PLATFORMS), 'darwin'),
    maxOutputTokens,
    apiBase: (trimmed(env.OPENROUTER_API_BASE) || DEFAULT_OPENROUTER_API_BASE).replace(/\/+$/, ''),
  };
}
