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
/** Hama (bring your own AI): monthly ₩3,900 (no option on Groble) and yearly ₩39,000. `id:months:priceKrw[:optionId]`. */
export const DEFAULT_HAMA_PRODUCTS = 'SfYBy5:1:3900,vdw3HN:12:39000:8JF8jD';
/** Rau (hosted AI included): monthly ₩14,900 and yearly ₩149,000. */
export const DEFAULT_RAU_PRODUCTS = 'R3n8zG:1:14900:t3QJ4b,atqjpJ:12:149000:nqSZ94';
export const DEFAULT_RAU_UPGRADE_URL = 'https://heemangstudios.com/pricing.html#rau';
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

const OPTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `GROBLE_HAMA_PRODUCTS` or `GROBLE_RAU_PRODUCTS`: `id:months:priceKrw[:optionId]` entries, months 1
 * (monthly) or 12 (yearly). The price is the list price; with an option id, the paid option must be that one.
 */
export function parsePlanProducts(name, text) {
  const products = [];
  if (!text) return products;
  for (const part of text.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const [id, monthsText, priceText, optionId, extra] = entry.split(':').map((s) => s.trim());
    const months = Number(monthsText);
    const priceKrw = Number(priceText);
    if (!id || extra !== undefined || (months !== 1 && months !== 12) || !Number.isSafeInteger(priceKrw) || priceKrw <= 0
      || (optionId !== undefined && !OPTION_ID_RE.test(optionId))) {
      throw new Error(`${name} entry is not id:months:price[:optionId] with months 1 or 12: ${entry}`);
    }
    products.push({ id, months, priceKrw, ...(optionId ? { optionId } : {}) });
  }
  return products;
}

export function buildProductCatalog({
  onetimeProductIds,
  subscriptionProductIds,
  signatureProductIds,
  expectedPrice,
  minAmount,
  signatureExpectedPrice,
  signatureMinAmount,
  hamaProducts = [],
  rauProducts = [],
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
  // Hama and Rau products are subscriptions with their own billing cycle; it wins over the event's.
  // Hama keys are stored as edition 'basic' (stored 'hama' already means the old hosted plan, now Rau).
  const plans = [['hama', 'basic', hamaProducts], ['rau', 'rau', rauProducts]];
  for (const [plan, edition, list] of plans) {
    for (const { id, months, priceKrw, optionId } of list) {
      add(plan, {
        id,
        kind: 'subscription',
        plan,
        edition,
        cycleMonths: months,
        expectedPrice: priceKrw,
        minAmount: priceKrw,
        ...(optionId ? { optionId } : {}),
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
  const hamaProducts = parsePlanProducts('GROBLE_HAMA_PRODUCTS', trimmed(env.GROBLE_HAMA_PRODUCTS) || DEFAULT_HAMA_PRODUCTS);
  const rauProducts = parsePlanProducts('GROBLE_RAU_PRODUCTS', trimmed(env.GROBLE_RAU_PRODUCTS) || DEFAULT_RAU_PRODUCTS);
  const products = buildProductCatalog({
    onetimeProductIds,
    subscriptionProductIds,
    signatureProductIds,
    expectedPrice: price,
    minAmount,
    signatureExpectedPrice,
    signatureMinAmount,
    hamaProducts,
    rauProducts,
    priceOverrides: productPriceOverrides(trimmed(env.GROBLE_PRODUCT_PRICES)),
  });
  const paymentGraceDays = positiveNumber('GROBLE_PAYMENT_GRACE_DAYS', trimmed(env.GROBLE_PAYMENT_GRACE_DAYS), DEFAULT_PAYMENT_GRACE_DAYS);
  const paymentGraceMaxDays = positiveNumber('GROBLE_PAYMENT_GRACE_MAX_DAYS', trimmed(env.GROBLE_PAYMENT_GRACE_MAX_DAYS), DEFAULT_PAYMENT_GRACE_MAX_DAYS);
  if (paymentGraceMaxDays >= 28) throw new Error(`GROBLE_PAYMENT_GRACE_MAX_DAYS must stay under a month (< 28): ${paymentGraceMaxDays}`);
  const paymentFixUrl = trimmed(env.GROBLE_PAYMENT_FIX_URL) || DEFAULT_PAYMENT_FIX_URL;
  if (!/^https:\/\/(?:www\.)?groble\.im\//.test(paymentFixUrl)) throw new Error(`GROBLE_PAYMENT_FIX_URL must be an https://groble.im/ page: ${paymentFixUrl}`);
  const rauUpgradeUrl = trimmed(env.RAU_UPGRADE_URL) || DEFAULT_RAU_UPGRADE_URL;
  if (!/^https:\/\//.test(rauUpgradeUrl)) throw new Error(`RAU_UPGRADE_URL must be an https:// page: ${rauUpgradeUrl}`);
  return {
    webhookSecret: trimmed(env.GROBLE_WEBHOOK_SECRET),
    webhookSecretPrevious: trimmed(env.GROBLE_WEBHOOK_SECRET_PREVIOUS),
    onetimeProductIds,
    subscriptionProductIds,
    signatureProductIds,
    signatureExpectedPrice,
    signatureMinAmount,
    products,
    hamaProducts,
    rauProducts,
    paymentGraceMs: paymentGraceDays * 24 * 60 * 60 * 1000,
    paymentGraceMaxMs: paymentGraceMaxDays * 24 * 60 * 60 * 1000,
    paymentFixUrl,
    rauUpgradeUrl,
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

/**
 * The old hosted Hama plan's store. Frozen: it is never written again and is read only for plans that
 * were active when it froze; such a key keeps Rau while its license is live.
 */
export function resolveHamaDbPath(env = process.env) {
  return path.join(resolveDataDir(env), 'hama.json');
}

export const DEFAULT_ANTHROPIC_API_BASE = 'https://api.anthropic.com';

function apiBase(name, text, fallback) {
  const value = (text || fallback).replace(/\/+$/, '');
  let url;
  try { url = new URL(value); } catch { url = null; }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new Error(`${name} must be an http(s) URL: ${value}`);
  return value;
}

/**
 * Variables earlier plans read. They are ignored now; startup logs the names of those still set (never
 * their values), so the owner can delete them on Railway. Every `HAMA_*` name is retired except
 * HAMA_OPENROUTER_KEY, the fallback name of RAU_OPENROUTER_KEY.
 */
const RETIRED_ENV = [
  'GROBLE_BASIC_PRODUCT_IDS', 'GROBLE_BASIC_MONTHLY_PRICE', 'GROBLE_BASIC_MONTHLY_MIN_AMOUNT',
  'GROBLE_BASIC_YEARLY_PRICE', 'GROBLE_BASIC_YEARLY_MIN_AMOUNT',
  'GROBLE_PRO_PRODUCT_IDS', 'GROBLE_PRO_MONTHLY_PRICE', 'GROBLE_PRO_MONTHLY_MIN_AMOUNT',
  'GROBLE_PRO_YEARLY_PRICE', 'GROBLE_PRO_YEARLY_MIN_AMOUNT',
  'GROBLE_HAMA_PRODUCT_IDS', 'GROBLE_HAMA_MONTHLY_PRICE', 'GROBLE_HAMA_MONTHLY_MIN_AMOUNT',
  'GROBLE_HAMA_YEARLY_PRICE', 'GROBLE_HAMA_YEARLY_MIN_AMOUNT',
  'BASIC_UPGRADE_URL', 'PRO_UPGRADE_URL',
  'RAU_MONTHLY_CAP_USD_BASIC', 'RAU_MONTHLY_CAP_USD_PRO', 'RAU_MONTHLY_CAP_USD_HAMA',
  'RAU_REASONING_EFFORT', 'RAU_MAX_OUTPUT_TOKENS',
];

/** Names of retired variables that are set, sorted. HAMA_OPENROUTER_KEY counts only while RAU_OPENROUTER_KEY overrides it. */
export function retiredEnvNames(env = process.env) {
  const names = new Set(RETIRED_ENV.filter((name) => trimmed(env[name])));
  for (const name of Object.keys(env)) {
    if (!name.startsWith('HAMA_') || !trimmed(env[name])) continue;
    if (name === 'HAMA_OPENROUTER_KEY' && !trimmed(env.RAU_OPENROUTER_KEY)) continue;
    names.add(name);
  }
  return [...names].sort();
}

export function resolveRauDbPath(env = process.env) {
  return path.join(resolveDataDir(env), 'rau.json');
}

/** The models hosted Rau can run, in the order RAU_MODEL lists them. */
export const RAU_MODEL_NAMES = Object.freeze(['haiku', 'deepseek']);
export const DEFAULT_RAU_MODELS = Object.freeze(['haiku']);
/** The one OpenRouter provider DeepSeek runs on; `provider.only` with no fallbacks keeps its price known. */
export const DEFAULT_RAU_DEEPSEEK_PROVIDER = 'deepinfra';
export const DEFAULT_RAU_MONTHLY_ALLOWANCE_USD = 8;

/**
 * Hosted Rau (the Rau agent and Rau-0.1) from env. RAU_MODEL is an ordered comma list of `haiku` and
 * `deepseek`: the first runs every call, the rest are fallbacks. An old pinned OpenRouter id (it has a
 * `/`) is ignored with a warning, so a variable left from the previous setup never stops the server.
 * `warnings` are logged once at startup. Hosted Rau runs when it is not turned off and the chosen
 * models have at least one upstream key.
 */
export function resolveRauConfig(env = process.env) {
  const enabledText = trimmed(env.RAU_ENABLED).toLowerCase();
  if (enabledText && !['1', '0', 'true', 'false', 'on', 'off'].includes(enabledText)) {
    throw new Error(`RAU_ENABLED must be true or false: ${env.RAU_ENABLED}`);
  }
  const warnings = [];
  const modelText = trimmed(env.RAU_MODEL).toLowerCase();
  let models = [...DEFAULT_RAU_MODELS];
  if (modelText.includes('/')) {
    warnings.push(`RAU_MODEL holds a retired OpenRouter model id and is ignored; using ${models.join(',')}`);
  } else if (modelText) {
    models = [...new Set(commaList(modelText, ''))];
    const unknown = models.find((name) => !RAU_MODEL_NAMES.includes(name));
    if (unknown !== undefined || models.length === 0) {
      throw new Error(`RAU_MODEL must be a comma list of ${RAU_MODEL_NAMES.join(', ')}: ${env.RAU_MODEL}`);
    }
  }
  const deepseekProvider = trimmed(env.RAU_DEEPSEEK_PROVIDER).toLowerCase() || DEFAULT_RAU_DEEPSEEK_PROVIDER;
  if (!/^[a-z0-9][a-z0-9._/-]{0,63}$/.test(deepseekProvider)) {
    throw new Error(`RAU_DEEPSEEK_PROVIDER must be an OpenRouter provider slug: ${env.RAU_DEEPSEEK_PROVIDER}`);
  }
  return {
    enabled: !['0', 'false', 'off'].includes(enabledText),
    models,
    deepseekProvider,
    allowanceUsd: positiveNumber('RAU_MONTHLY_ALLOWANCE_USD', trimmed(env.RAU_MONTHLY_ALLOWANCE_USD), DEFAULT_RAU_MONTHLY_ALLOWANCE_USD),
    openrouterKey: trimmed(env.RAU_OPENROUTER_KEY) || trimmed(env.HAMA_OPENROUTER_KEY),
    openrouterBase: apiBase('OPENROUTER_API_BASE', trimmed(env.OPENROUTER_API_BASE), DEFAULT_OPENROUTER_API_BASE),
    anthropicKey: trimmed(env.ANTHROPIC_API_KEY),
    anthropicBase: apiBase('ANTHROPIC_API_BASE', trimmed(env.ANTHROPIC_API_BASE), DEFAULT_ANTHROPIC_API_BASE),
    warnings,
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
