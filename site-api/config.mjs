import path from 'node:path';

import { DEFAULT_WORKOS_API_BASE, DEFAULT_WORKOS_CLIENT_ID, WORKOS_PROVIDERS } from './workos.mjs';

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
/** A failed renewal never keeps a key usable longer than this past its expiry, so a monthly key's grace stays under a month. */
export const DEFAULT_PAYMENT_GRACE_MAX_DAYS = 14;
export const DEFAULT_BASIC_PRODUCT_IDS = 'SfYBy5:1,vdw3HN:12';
export const DEFAULT_BASIC_MONTHLY_PRICE = 3900;
export const DEFAULT_BASIC_YEARLY_PRICE = 39000;
export const DEFAULT_HAMA_PRODUCT_IDS = 'R3n8zG:1,atqjpJ:12';
export const DEFAULT_HAMA_MONTHLY_PRICE = 12900;
export const DEFAULT_HAMA_YEARLY_PRICE = 139000;
export const DEFAULT_BASIC_UPGRADE_URL = 'https://heemangstudios.com/pricing.html#basic';
/** Groble's buyer 주문조회 page, where a buyer sees the subscription and pays again. */
export const DEFAULT_PAYMENT_FIX_URL = 'https://groble.im/manage/purchase';

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Basic was called Pro until 2026-10-31. A `*_BASIC_*` variable wins; the old `*_PRO_*` name is still read
 * so a Railway service that only has the old variables keeps its values. Returns `[name, value]` for errors.
 */
function basicEnv(env, basicName, proName) {
  const value = trimmed(env[basicName]);
  if (value) return [basicName, value];
  return [proName, trimmed(env[proName])];
}

function commaList(text, fallback) {
  return (text || fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

function integerKrw(name, text, fallback) {
  const value = Number(text || fallback);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer (KRW)`);
  return value;
}

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

/** `GROBLE_BASIC_PRODUCT_IDS` or `GROBLE_HAMA_PRODUCT_IDS`: `id:months` entries, months 1 (monthly) or 12 (yearly). */
export function parsePlanProducts(name, text) {
  const products = [];
  if (!text) return products;
  for (const part of text.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const [id, monthsText, extra] = entry.split(':').map((s) => s.trim());
    const months = Number(monthsText);
    if (!id || extra !== undefined || (months !== 1 && months !== 12)) {
      throw new Error(`${name} entry is not id:1 or id:12: ${entry}`);
    }
    products.push({ id, months });
  }
  return products;
}

export function buildProductCatalog({
  onetimeProductIds,
  subscriptionProductIds,
  signatureProductIds,
  basicProducts = [],
  expectedPrice,
  minAmount,
  signatureExpectedPrice,
  signatureMinAmount,
  basicMonthlyPrice = DEFAULT_BASIC_MONTHLY_PRICE,
  basicMonthlyMinAmount = basicMonthlyPrice,
  basicYearlyPrice = DEFAULT_BASIC_YEARLY_PRICE,
  basicYearlyMinAmount = basicYearlyPrice,
  hamaProducts = [],
  hamaMonthlyPrice = DEFAULT_HAMA_MONTHLY_PRICE,
  hamaMonthlyMinAmount = hamaMonthlyPrice,
  hamaYearlyPrice = DEFAULT_HAMA_YEARLY_PRICE,
  hamaYearlyMinAmount = hamaYearlyPrice,
  priceOverrides = new Map(),
}) {
  const groups = [
    ['one-time', 'onetime', onetimeProductIds, expectedPrice, minAmount],
    ['subscription', 'subscription', subscriptionProductIds, expectedPrice, minAmount],
    ['signature', 'signature', signatureProductIds, signatureExpectedPrice, signatureMinAmount],
  ];
  const seen = new Map();
  const products = [];
  const add = (label, product) => {
    const previous = seen.get(product.id);
    if (previous) throw new Error(`Groble product ${product.id} is both ${previous} and ${label}`);
    seen.set(product.id, label);
    const override = priceOverrides.get(product.id);
    products.push({
      ...product,
      expectedPrice: override?.expectedPrice ?? product.expectedPrice,
      minAmount: override?.minAmount ?? product.minAmount,
    });
  };
  for (const [label, kind, ids, price, min] of groups) {
    for (const id of ids) add(label, { id, kind, expectedPrice: price, minAmount: min });
  }
  // Basic and Hama products are subscriptions with their own billing cycle; it wins over the event's.
  const plans = [
    ['basic', basicProducts, basicMonthlyPrice, basicMonthlyMinAmount, basicYearlyPrice, basicYearlyMinAmount],
    ['hama', hamaProducts, hamaMonthlyPrice, hamaMonthlyMinAmount, hamaYearlyPrice, hamaYearlyMinAmount],
  ];
  for (const [edition, list, monthlyPrice, monthlyMin, yearlyPrice, yearlyMin] of plans) {
    for (const { id, months } of list) {
      add(edition, {
        id,
        kind: 'subscription',
        edition,
        cycleMonths: months,
        expectedPrice: months === 12 ? yearlyPrice : monthlyPrice,
        minAmount: months === 12 ? yearlyMin : monthlyMin,
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
  const [basicProductsName, basicProductsText] = basicEnv(env, 'GROBLE_BASIC_PRODUCT_IDS', 'GROBLE_PRO_PRODUCT_IDS');
  const basicProducts = parsePlanProducts(basicProductsName, basicProductsText || DEFAULT_BASIC_PRODUCT_IDS);
  const hamaProducts = parsePlanProducts('GROBLE_HAMA_PRODUCT_IDS', trimmed(env.GROBLE_HAMA_PRODUCT_IDS) || DEFAULT_HAMA_PRODUCT_IDS);
  const basicMonthlyPrice = integerKrw(...basicEnv(env, 'GROBLE_BASIC_MONTHLY_PRICE', 'GROBLE_PRO_MONTHLY_PRICE'), DEFAULT_BASIC_MONTHLY_PRICE);
  const basicYearlyPrice = integerKrw(...basicEnv(env, 'GROBLE_BASIC_YEARLY_PRICE', 'GROBLE_PRO_YEARLY_PRICE'), DEFAULT_BASIC_YEARLY_PRICE);
  const hamaMonthlyPrice = integerKrw('GROBLE_HAMA_MONTHLY_PRICE', trimmed(env.GROBLE_HAMA_MONTHLY_PRICE), DEFAULT_HAMA_MONTHLY_PRICE);
  const hamaYearlyPrice = integerKrw('GROBLE_HAMA_YEARLY_PRICE', trimmed(env.GROBLE_HAMA_YEARLY_PRICE), DEFAULT_HAMA_YEARLY_PRICE);
  const products = buildProductCatalog({
    onetimeProductIds,
    subscriptionProductIds,
    signatureProductIds,
    basicProducts,
    expectedPrice: price,
    minAmount,
    signatureExpectedPrice,
    signatureMinAmount,
    basicMonthlyPrice,
    basicMonthlyMinAmount: integerKrw(...basicEnv(env, 'GROBLE_BASIC_MONTHLY_MIN_AMOUNT', 'GROBLE_PRO_MONTHLY_MIN_AMOUNT'), basicMonthlyPrice),
    basicYearlyPrice,
    basicYearlyMinAmount: integerKrw(...basicEnv(env, 'GROBLE_BASIC_YEARLY_MIN_AMOUNT', 'GROBLE_PRO_YEARLY_MIN_AMOUNT'), basicYearlyPrice),
    hamaProducts,
    hamaMonthlyPrice,
    hamaMonthlyMinAmount: integerKrw('GROBLE_HAMA_MONTHLY_MIN_AMOUNT', trimmed(env.GROBLE_HAMA_MONTHLY_MIN_AMOUNT), hamaMonthlyPrice),
    hamaYearlyPrice,
    hamaYearlyMinAmount: integerKrw('GROBLE_HAMA_YEARLY_MIN_AMOUNT', trimmed(env.GROBLE_HAMA_YEARLY_MIN_AMOUNT), hamaYearlyPrice),
    priceOverrides: productPriceOverrides(trimmed(env.GROBLE_PRODUCT_PRICES)),
  });
  const paymentGraceDays = positiveNumber('GROBLE_PAYMENT_GRACE_DAYS', trimmed(env.GROBLE_PAYMENT_GRACE_DAYS), DEFAULT_PAYMENT_GRACE_DAYS);
  const paymentGraceMaxDays = positiveNumber('GROBLE_PAYMENT_GRACE_MAX_DAYS', trimmed(env.GROBLE_PAYMENT_GRACE_MAX_DAYS), DEFAULT_PAYMENT_GRACE_MAX_DAYS);
  if (paymentGraceMaxDays >= 28) throw new Error(`GROBLE_PAYMENT_GRACE_MAX_DAYS must stay under a month (< 28): ${paymentGraceMaxDays}`);
  const paymentFixUrl = trimmed(env.GROBLE_PAYMENT_FIX_URL) || DEFAULT_PAYMENT_FIX_URL;
  if (!/^https:\/\/(?:www\.)?groble\.im\//.test(paymentFixUrl)) throw new Error(`GROBLE_PAYMENT_FIX_URL must be an https://groble.im/ page: ${paymentFixUrl}`);
  const [upgradeUrlName, upgradeUrlText] = basicEnv(env, 'BASIC_UPGRADE_URL', 'PRO_UPGRADE_URL');
  const basicUpgradeUrl = upgradeUrlText || DEFAULT_BASIC_UPGRADE_URL;
  if (!/^https:\/\//.test(basicUpgradeUrl)) throw new Error(`${upgradeUrlName} must be an https:// page: ${basicUpgradeUrl}`);
  return {
    webhookSecret: trimmed(env.GROBLE_WEBHOOK_SECRET),
    webhookSecretPrevious: trimmed(env.GROBLE_WEBHOOK_SECRET_PREVIOUS),
    onetimeProductIds,
    subscriptionProductIds,
    signatureProductIds,
    signatureExpectedPrice,
    signatureMinAmount,
    products,
    basicProducts,
    hamaProducts,
    paymentGraceMs: paymentGraceDays * 24 * 60 * 60 * 1000,
    paymentGraceMaxMs: paymentGraceMaxDays * 24 * 60 * 60 * 1000,
    paymentFixUrl,
    basicUpgradeUrl,
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

export function resolveHamaDbPath(env = process.env) {
  return path.join(resolveDataDir(env), 'hama.json');
}

/** Per-license JSONL usage logs of the Hama plan. */
export function resolveHamaUsageDir(env = process.env) {
  return path.join(resolveDataDir(env), 'hama-usage');
}

export const DEFAULT_ANTHROPIC_API_BASE = 'https://api.anthropic.com';
export const DEFAULT_HAMA_CHEAP_MODELS = 'deepseek/deepseek-v4.1-flash';
const HAMA_REASONING_EFFORTS = ['low', 'high', 'max'];
const HAMA_PRICE_FIELDS = [
  'inputPerMTok', 'outputPerMTok', 'cacheReadPerMTok', 'cacheWrite5mPerMTok', 'cacheWrite1hPerMTok',
  'longContextTokens', 'longContextMultiplier',
];

function hamaPercent(name, text, fallback) {
  const value = positiveNumber(name, text, fallback);
  if (value > 100) throw new Error(`${name} must be at most 100: ${text}`);
  return value;
}

function apiBase(name, text, fallback) {
  const value = (text || fallback).replace(/\/+$/, '');
  let url;
  try { url = new URL(value); } catch { url = null; }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new Error(`${name} must be an http(s) URL: ${value}`);
  return value;
}

/**
 * Hama plan settings. HAMA_ENABLED turns the routes on; the upstream keys can arrive later (calls
 * answer 503 until one is set). The hosted Claude model is a code constant in hama.mjs, so nothing
 * here can add Sonnet or Opus; HAMA_CHEAP_MODELS refuses Claude ids for the same reason.
 */
export function resolveHamaConfig(env = process.env) {
  const enabledText = trimmed(env.HAMA_ENABLED).toLowerCase();
  if (enabledText && !['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off'].includes(enabledText)) {
    throw new Error(`HAMA_ENABLED must be true or false: ${env.HAMA_ENABLED}`);
  }
  const cheapModels = commaList(trimmed(env.HAMA_CHEAP_MODELS), DEFAULT_HAMA_CHEAP_MODELS);
  for (const model of cheapModels) {
    if (/^anthropic\//i.test(model) || /claude/i.test(model)) throw new Error(`HAMA_CHEAP_MODELS must not name a Claude model: ${model}`);
  }
  const cheapReasoningEffort = trimmed(env.HAMA_CHEAP_REASONING_EFFORT).toLowerCase() || 'high';
  if (!HAMA_REASONING_EFFORTS.includes(cheapReasoningEffort)) {
    throw new Error(`HAMA_CHEAP_REASONING_EFFORT must be one of ${HAMA_REASONING_EFFORTS.join(', ')}: ${cheapReasoningEffort}`);
  }
  const maxOutputTokens = positiveNumber('HAMA_MAX_OUTPUT_TOKENS', trimmed(env.HAMA_MAX_OUTPUT_TOKENS), 16000);
  if (!Number.isSafeInteger(maxOutputTokens)) throw new Error('HAMA_MAX_OUTPUT_TOKENS must be an integer');
  const pricesText = trimmed(env.HAMA_PRICES);
  let prices = {};
  if (pricesText) {
    try { prices = JSON.parse(pricesText); } catch { prices = null; }
    if (!prices || typeof prices !== 'object' || Array.isArray(prices)) throw new Error('HAMA_PRICES must be a JSON object');
    for (const [field, value] of Object.entries(prices)) {
      if (!HAMA_PRICE_FIELDS.includes(field)) throw new Error(`HAMA_PRICES has an unknown field: ${field}`);
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`HAMA_PRICES.${field} must be a number ≥ 0`);
    }
  }
  return {
    enabled: ['1', 'true', 'yes', 'on'].includes(enabledText),
    allowanceUsd: positiveNumber('HAMA_MONTHLY_ALLOWANCE_USD', trimmed(env.HAMA_MONTHLY_ALLOWANCE_USD), 15),
    cap5hPct: hamaPercent('HAMA_CAP_5H_PCT', trimmed(env.HAMA_CAP_5H_PCT), 20),
    capWeekPct: hamaPercent('HAMA_CAP_WEEK_PCT', trimmed(env.HAMA_CAP_WEEK_PCT), 50),
    capMonthPct: hamaPercent('HAMA_CAP_MONTH_PCT', trimmed(env.HAMA_CAP_MONTH_PCT), 100),
    cheapModels,
    cheapReasoningEffort,
    maxOutputTokens,
    prices,
    anthropicKey: trimmed(env.ANTHROPIC_API_KEY),
    anthropicBase: apiBase('ANTHROPIC_API_BASE', trimmed(env.ANTHROPIC_API_BASE), DEFAULT_ANTHROPIC_API_BASE),
    openrouterKey: trimmed(env.HAMA_OPENROUTER_KEY),
    openrouterBase: apiBase('OPENROUTER_API_BASE', trimmed(env.OPENROUTER_API_BASE), DEFAULT_OPENROUTER_API_BASE),
  };
}

export function resolveRauDbPath(env = process.env) {
  return path.join(resolveDataDir(env), 'rau.json');
}

export const DEFAULT_RAU_MODEL = 'deepseek/deepseek-v4.1-flash';
/** OpenRouter's `reasoning.effort` values. */
export const RAU_REASONING_EFFORTS = Object.freeze(['xhigh', 'high', 'medium', 'low', 'minimal', 'none']);

/**
 * Hosted Rau-0.1 from env. It runs when the OpenRouter management key is set, unless
 * RAU_ENABLED turns it off. The model is a pinned OpenRouter id: a `~` alias (`~deepseek/...-latest`)
 * can move to a pricier model on its own, so it is refused at startup.
 */
export function resolveRauConfig(env = process.env) {
  const enabledText = trimmed(env.RAU_ENABLED).toLowerCase();
  if (enabledText && !['1', '0', 'true', 'false', 'on', 'off'].includes(enabledText)) {
    throw new Error(`RAU_ENABLED must be true or false: ${env.RAU_ENABLED}`);
  }
  const model = trimmed(env.RAU_MODEL) || DEFAULT_RAU_MODEL;
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i.test(model)) {
    throw new Error(`RAU_MODEL must be a pinned OpenRouter model id like ${DEFAULT_RAU_MODEL}: ${model}`);
  }
  const reasoningEffort = trimmed(env.RAU_REASONING_EFFORT).toLowerCase() || 'low';
  if (!RAU_REASONING_EFFORTS.includes(reasoningEffort)) {
    throw new Error(`RAU_REASONING_EFFORT must be one of ${RAU_REASONING_EFFORTS.join(', ')}: ${env.RAU_REASONING_EFFORT}`);
  }
  const maxOutputTokens = positiveNumber('RAU_MAX_OUTPUT_TOKENS', trimmed(env.RAU_MAX_OUTPUT_TOKENS), 2000);
  if (!Number.isSafeInteger(maxOutputTokens)) throw new Error('RAU_MAX_OUTPUT_TOKENS must be an integer');
  return {
    enabled: !['0', 'false', 'off'].includes(enabledText),
    provisioningKey: trimmed(env.OPENROUTER_PROVISIONING_KEY),
    model,
    reasoningEffort,
    maxOutputTokens,
    monthlyCapsUsd: {
      basic: positiveNumber(...basicEnv(env, 'RAU_MONTHLY_CAP_USD_BASIC', 'RAU_MONTHLY_CAP_USD_PRO'), 2),
      hama: positiveNumber('RAU_MONTHLY_CAP_USD_HAMA', trimmed(env.RAU_MONTHLY_CAP_USD_HAMA), 5),
    },
    apiBase: (trimmed(env.OPENROUTER_API_BASE) || DEFAULT_OPENROUTER_API_BASE).replace(/\/+$/, ''),
  };
}

/** Postgres URL; set, every store with a Postgres mapping runs there instead of its JSON file. */
export function resolveDatabaseUrl(env = process.env) {
  return trimmed(env.DATABASE_URL);
}

export function resolveAccountsDbPath(env = process.env) {
  return path.join(resolveDataDir(env), 'accounts.json');
}

/** Profile pictures, one file per account. */
export function resolveAvatarDir(env = process.env) {
  return path.join(resolveDataDir(env), 'avatars');
}

export const DEFAULT_ACCOUNT_AUTH_REDIRECT_URI = 'https://rau-credits-production.up.railway.app/v1/account/auth/callback';
export const DEFAULT_ACCOUNT_AUTH_PROVIDERS = 'email,google';
export const DEFAULT_ACCOUNT_DEVICE_LIMIT = 5;

/**
 * Account system from env. The routes answer accounts_not_configured until WORKOS_API_KEY is set; every
 * other value has a default and fails startup when it is unusable, so a typo never ships silently.
 */
export function resolveAccountConfig(env = process.env) {
  const redirectUri = trimmed(env.ACCOUNT_AUTH_REDIRECT_URI) || DEFAULT_ACCOUNT_AUTH_REDIRECT_URI;
  let redirect;
  try { redirect = new URL(redirectUri); } catch { redirect = null; }
  const loopback = redirect?.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname);
  if (!redirect || (redirect.protocol !== 'https:' && !loopback)) {
    throw new Error(`ACCOUNT_AUTH_REDIRECT_URI must be an https URL: ${redirectUri}`);
  }
  const providers = commaList(trimmed(env.ACCOUNT_AUTH_PROVIDERS), DEFAULT_ACCOUNT_AUTH_PROVIDERS);
  for (const id of providers) {
    if (!Object.hasOwn(WORKOS_PROVIDERS, id) || !WORKOS_PROVIDERS[id]) {
      throw new Error(`ACCOUNT_AUTH_PROVIDERS names a provider without a WorkOS connection: ${id}`);
    }
  }
  const limitText = trimmed(env.ACCOUNT_DEVICE_LIMIT);
  const deviceLimit = limitText ? Number(limitText) : DEFAULT_ACCOUNT_DEVICE_LIMIT;
  if (!Number.isInteger(deviceLimit) || deviceLimit < 1 || deviceLimit > 20) {
    throw new Error(`ACCOUNT_DEVICE_LIMIT must be an integer from 1 to 20: ${limitText}`);
  }
  return {
    apiKey: trimmed(env.WORKOS_API_KEY),
    clientId: trimmed(env.WORKOS_CLIENT_ID) || DEFAULT_WORKOS_CLIENT_ID,
    apiBase: apiBase('WORKOS_API_BASE', trimmed(env.WORKOS_API_BASE), DEFAULT_WORKOS_API_BASE),
    redirectUri,
    providers: [...new Set(providers)],
    deviceLimit,
  };
}
