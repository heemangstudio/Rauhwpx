import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { buildProductCatalog } from './config.mjs';
import {
  MAX_GIFT_CODES_PER_BATCH,
  MAX_GIFT_DURATION_DAYS,
  MAX_GIFT_DURATION_MONTHS,
  generateGiftCode,
  giftCodeEdition,
  giftCodeHash,
  giftCodePrefix,
  maskGiftCode,
  normalizeGiftCode,
} from './gift-codes.mjs';
import { heldReasonText } from './held-alert.mjs';
import { licenseEmail, licenseEmailKind, maskEmail } from './license-email.mjs';
import {
  BETA_LEASE_TTL_MS,
  DEFAULT_LEASE_KID,
  LEASE_TTL_MS,
  licenseKeyHash,
  publicKeyFromPrivate,
  signLease,
  verifyLease,
} from './license-lease.mjs';
import { createMemoryStore } from './store.mjs';
import { uniqueInstallDigest } from './unique-installs.mjs';
import { createWebhookLog, WEBHOOK_LOG_MAX_ENTRIES } from './webhook-log.mjs';

export const DEVICE_LIMIT = 2;
export const BETA_DEVICE_LIMIT = 5;
export const BETA_DEVICE_LIMIT_MAX = 50;
const WEBHOOK_EVENT_RETENTION_MS = 8 * 24 * 60 * 60 * 1000; // Groble retries for ~44h
const KEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
export const KEY_RE = /^HAMA(?:-[0-9A-HJKMNP-TV-Z]{5}){5}$/;
export const REF_RE = /^[A-Za-z0-9\-_.:=~]{1,128}$/; // Groble sellerReference rule
const DEVICE_ID_RE = /^[A-Za-z0-9\-_.:]{8,128}$/;
const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
/** Months one paid subscription round buys when Groble does not say (the GLJFC9 product bills every 12 months). */
export const SUBSCRIPTION_CYCLE_MONTHS = 12;
export const SIGNATURE_UPDATE_MONTHS = 36;
const SIGNATURE_SUPPORT = { channel: 'email', sla: '1_business_day', timezone: 'Asia/Seoul' };
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MAX_EXTEND_YEARS = 10;
const DEFAULT_PAYMENT_GRACE_MAX_MS = 14 * 24 * 60 * 60 * 1000;

export function emptyLicensesState() {
  return { licenses: {}, keyIndex: {}, orders: {}, refs: {}, webhookEvents: {}, grandfathered: {}, giftCodeBatches: {}, giftCodes: {} };
}

export function licenseError(code, status, message = code) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.licenseError = true;
  return error;
}

export function generateLicenseKey(random = randomBytes) {
  const bytes = random(25);
  let out = '';
  for (let i = 0; i < 25; i += 1) out += KEY_ALPHABET[bytes[i] & 31];
  return `HAMA-${out.match(/.{5}/g).join('-')}`;
}

/** Uppercase, strip spaces, accept a missing HAMA- prefix and the usual O/I/L look-alikes. */
export function normalizeLicenseKey(value) {
  if (typeof value !== 'string' || value.length > 64) return '';
  let raw = value.toUpperCase().replace(/[\s-]/g, '');
  if (raw.length === 29 && raw.startsWith('HAMA')) raw = raw.slice(4);
  raw = raw.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (raw.length !== 25) return '';
  const key = `HAMA-${raw.match(/.{5}/g).join('-')}`;
  return KEY_RE.test(key) ? key : '';
}

function newKeyId(random = randomBytes) {
  return `lic_${random(9).toString('hex')}`;
}

export function tokenEquals(given, expected) {
  if (!expected || typeof given !== 'string' || !given) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function str(value, max = 256) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseTime(value) {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : undefined;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

/**
 * End of the KST day `months` calendar months after `ms`. Groble bills a renewal on a KST date
 * (`nextBillingDate`), so a subscription key runs through the whole anniversary day and a same-day
 * renewal lands before it lapses. A day past the target month's end clamps (Feb 29 → Feb 28).
 */
export function subscriptionEnd(ms, months) {
  const kst = new Date(ms + KST_OFFSET_MS);
  const year = kst.getUTCFullYear();
  const month = kst.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(kst.getUTCDate(), lastDay), 23, 59, 59, 999) - KST_OFFSET_MS;
}

/** `YYYY-MM-DD` is the end of that KST day; anything else must be a full ISO-8601 time. */
function parseUntil(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (date) {
    const [year, month, day] = date.slice(1).map(Number);
    const end = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
    if (end.getUTCMonth() !== month - 1 || end.getUTCDate() !== day) return undefined;
    return end.getTime() - KST_OFFSET_MS;
  }
  return /^\d{4}-\d{2}-\d{2}T/.test(text) ? parseTime(text) : undefined;
}

/** End of the KST day `days` days after `ms`, like subscriptionEnd for a term counted in days. */
function daysEnd(ms, days) {
  const kst = new Date(ms + KST_OFFSET_MS);
  return Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + days, 23, 59, 59, 999) - KST_OFFSET_MS;
}

/** A whole number from a JSON number or a digit string (the CLI sends strings), else undefined. */
function wholeNumber(value) {
  if (typeof value === 'string' && /^\d{1,6}$/.test(value.trim())) return Number(value.trim());
  return Number.isSafeInteger(value) ? value : undefined;
}

/** `active` (redeemable), `redeemed`, `revoked`, or `expired` for an unredeemed code past its batch's redeemBy. */
function giftCodeStatusOf(code, batch, nowMs) {
  if (code.status === 'active' && nowMs > (parseTime(batch?.redeemBy) ?? Infinity)) return 'expired';
  return code.status;
}

const GIFT_CODE_STATUSES = ['active', 'redeemed', 'revoked', 'expired'];

/** Subscription keys carry `expiresAt`; every record without it (paid one-time, grandfathered, beta, manual) is lifetime. */
function expiryOf(license) {
  return parseTime(license?.expiresAt) ?? null;
}

/**
 * End of Groble's retry and grace window after a failed renewal, while the subscription is past due.
 * Never more than `maxMs` past the expiry, so a monthly key cannot run on unpaid for another month.
 */
function paymentGraceEndOf(license, maxMs = DEFAULT_PAYMENT_GRACE_MAX_MS) {
  if (license?.subscription?.status !== 'past_due') return null;
  const end = parseTime(license.subscription.paymentGraceEndsAt);
  if (end === undefined) return null;
  const expiry = expiryOf(license);
  return expiry === null ? end : Math.min(end, expiry + maxMs);
}

/** When the key stops working: its paid end, or the end of the payment grace window when that is later. */
function accessEndOf(license, graceMaxMs) {
  const expiry = expiryOf(license);
  if (expiry === null) return null;
  return Math.max(expiry, paymentGraceEndOf(license, graceMaxMs) ?? 0);
}

/** The event's `billingCycleMonths` when it is a whole 1–12, else undefined. */
function eventCycleMonths(object) {
  const months = object?.subscription?.billingCycleMonths;
  return Number.isInteger(months) && months >= 1 && months <= 12 ? months : undefined;
}

/** Months one paid round of this key buys: its own cycle, else the GLJFC9 default. */
function keyCycleMonths(license) {
  const months = license?.billingCycleMonths ?? license?.subscription?.billingCycleMonths;
  return Number.isInteger(months) && months >= 1 && months <= 12 ? months : SUBSCRIPTION_CYCLE_MONTHS;
}

/** A key created by redeeming a gift code: a fixed term that never renews. */
function isGiftKey(license) {
  return license?.source === 'gift_code';
}

/** `lifetime` without an expiry, `monthly` for a 1-month key, else `annual`. A gift key has no billing plan (null). */
export function planOf(license) {
  if (isGiftKey(license)) return null;
  if (expiryOf(license) === null) return 'lifetime';
  return keyCycleMonths(license) === 1 ? 'monthly' : 'annual';
}

/**
 * Stored edition → the name the app and admin views use. Stored records are never rewritten:
 * `pro` (the first name of the BYOK plan) and `basic` (its second, and how new Hama keys are stored)
 * read as 'hama'; `hama` (the old hosted plan) and `rau` read as 'rau'.
 */
const WIRE_EDITIONS = Object.freeze({ pro: 'hama', basic: 'hama', hama: 'rau', rau: 'rau', signature: 'signature' });

export function editionOf(license) {
  const stored = license?.edition;
  return typeof stored === 'string' && Object.hasOwn(WIRE_EDITIONS, stored) ? WIRE_EDITIONS[stored] : undefined;
}

/** Null for a lifetime key, false for a gift key or a cancelled subscription, else true. */
function autoRenewOf(license) {
  if (expiryOf(license) === null) return null;
  return !isGiftKey(license) && license.subscription?.autoRenew !== false;
}

/** Editions sold as a subscription on their own billing cycle. */
function isPlanEdition(edition) {
  return edition === 'basic' || edition === 'pro' || edition === 'hama' || edition === 'rau';
}

/** Active, and before its expiry or inside its payment grace (lifetime keys always). */
function isLive(license, nowMs, graceMaxMs) {
  if (!license || license.status !== 'active') return false;
  const end = accessEndOf(license, graceMaxMs);
  return end === null || nowMs < end;
}

/**
 * Whether a license has hosted Rau: a live key whose edition reads as 'rau', or a live key with an
 * active plan in the frozen hama.json (`legacyPlan`). Every other key (Hama, GLJFC9, lifetime,
 * Signature, beta, grandfathered, manual) needs a Rau plan or the account's trial.
 */
export function rauEntitled(license, nowMs, graceMaxMs, legacyPlan = null) {
  return isLive(license, nowMs, graceMaxMs) && (editionOf(license) === 'rau' || Boolean(legacyPlan));
}

/** `HAMA-ABCDE-•••••-•••••-•••••-VWXYZ`: the first and last groups only. */
export function maskLicenseKey(key) {
  const groups = String(key ?? '').split('-');
  if (groups.length !== 6) return 'HAMA-•••••';
  return [groups[0], groups[1], '•••••', '•••••', '•••••', groups[5]].join('-');
}

/** Account tier by the primary license's rank (see accountEntitlements). */
const RANK_TIERS = { 1: 'hama', 2: 'rau' };
const ACCOUNT_EDITIONS = new Set(['hama', 'rau', 'signature']);

function normalizeState(state) {
  const base = emptyLicensesState();
  const next = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  for (const key of Object.keys(base)) {
    if (!next[key] || typeof next[key] !== 'object' || Array.isArray(next[key])) next[key] = {};
  }
  return next;
}

/** Records written before beta keys have no tier or deviceLimit: they are paid keys on two devices. */
function tierOf(license) {
  return license.tier === 'beta' ? 'beta' : 'paid';
}

function deviceLimitOf(license) {
  return Number.isSafeInteger(license.deviceLimit) && license.deviceLimit > 0 ? license.deviceLimit : DEVICE_LIMIT;
}

function signatureView(license) {
  const prioritySupport = license.edition === 'signature' && license.status === 'active';
  return {
    prioritySupport,
    ...(license.edition ? { edition: editionOf(license) } : {}),
    ...(license.productId && (license.edition === 'signature' || isPlanEdition(license.edition)) ? { productId: license.productId } : {}),
    ...(license.updatesUntil ? { updatesUntil: license.updatesUntil } : {}),
    ...(license.support ? { support: license.support } : {}),
    ...(prioritySupport ? { supportSlaLabel: '1영업일 내 첫 답변' } : {}),
  };
}

function signatureEntitlement(productId, paidMs, updatesUntilMs) {
  return {
    edition: 'signature',
    productId,
    updatesUntil: iso(updatesUntilMs ?? subscriptionEnd(paidMs, SIGNATURE_UPDATE_MONTHS)),
    support: { ...SIGNATURE_SUPPORT },
  };
}

/** Public, buyer-safe view used by admin responses. */
function licenseView(license, { includeKey = true } = {}) {
  if (!license) return null;
  return {
    keyId: license.keyId,
    ...(includeKey ? { key: license.key } : {}),
    status: license.status,
    tier: tierOf(license),
    deviceLimit: deviceLimitOf(license),
    name: license.name,
    source: license.source,
    merchantUid: license.merchantUid,
    ref: license.ref,
    email: license.email,
    amount: license.amount,
    occurredAt: license.occurredAt,
    createdAt: license.createdAt,
    revokedAt: license.revokedAt,
    revokeReason: license.revokeReason,
    plan: planOf(license),
    ...signatureView(license),
    ...(isPlanEdition(license.edition) && !isGiftKey(license) ? { billingCycleMonths: keyCycleMonths(license) } : {}),
    expiresAt: license.expiresAt ?? null,
    subscription: license.subscription,
    giftBatchId: license.giftBatchId,
    extensions: license.extensions,
    note: license.note,
    devices: Object.entries(license.devices ?? {}).map(([deviceId, d]) => ({ deviceId, ...d })),
    emailDelivery: license.emailDelivery,
    accountId: license.accountId ?? null,
    linkedBy: license.linkedBy,
    linkedAt: license.linkedAt,
    unlinkedAt: license.unlinkedAt,
  };
}

/** `lifetime`, or for an annual key `active`, `past_due` (renewal failed, still in grace) or `lapsed`. */
function subscriptionStatusOf(license, nowMs, graceMaxMs) {
  if (expiryOf(license) === null) return 'lifetime';
  if (nowMs >= accessEndOf(license, graceMaxMs)) return 'lapsed';
  return paymentGraceEndOf(license, graceMaxMs) === null ? 'active' : 'past_due';
}

/** One paid key for the admin customer list. */
function customerView(license, nowMs, graceMaxMs) {
  const delivery = license.emailDelivery ?? {};
  const graceEnd = paymentGraceEndOf(license, graceMaxMs);
  return {
    keyId: license.keyId,
    key: license.key,
    email: license.email,
    status: license.status,
    source: license.source,
    subscriptionStatus: subscriptionStatusOf(license, nowMs, graceMaxMs),
    plan: planOf(license),
    ...signatureView(license),
    expiresAt: license.expiresAt ?? null,
    autoRenew: autoRenewOf(license),
    paymentGraceEndsAt: graceEnd === null ? null : iso(graceEnd),
    deviceLimit: deviceLimitOf(license),
    devices: Object.entries(license.devices ?? {}).map(([deviceId, d]) => ({ deviceId, platform: d.platform, lastSeenAt: d.lastSeenAt })),
    emailDelivery: license.emailDelivery ? {
      status: delivery.status,
      attempts: delivery.attempts,
      lastAttemptAt: delivery.lastAttemptAt,
      error: delivery.error,
    } : null,
    merchantUid: license.merchantUid,
    amount: license.amount,
    createdAt: license.createdAt,
    revokedAt: license.revokedAt,
  };
}

/**
 * License key service. Every mutation runs exclusively through `store.update` (the atomic file
 * store, or Postgres with a per-domain advisory lock), so concurrent requests never interleave
 * read-modify-write cycles.
 */
export function createLicensesService({
  store = createMemoryStore(emptyLicensesState()),
  uniqueInstallsStore,
  now = Date.now,
  random = randomBytes,
  signingKey = null,
  leaseKid = DEFAULT_LEASE_KID,
  emailProvider,
  onetimeProductIds = ['uRshdR'],
  subscriptionProductIds = ['GLJFC9'],
  signatureProductIds = ['8Xy27f'],
  paymentGraceMs = 10 * 24 * 60 * 60 * 1000,
  paymentGraceMaxMs = DEFAULT_PAYMENT_GRACE_MAX_MS,
  paymentFixUrl = 'https://groble.im/manage/purchase',
  expectedPrice = 9900,
  minAmount = expectedPrice,
  signatureExpectedPrice = 29000,
  signatureMinAmount = signatureExpectedPrice,
  hamaProducts = [],
  rauProducts = [],
  products,
  grandfatherCutoff = undefined,
  grandfatherPlatforms = ['darwin'],
  adminToken = '',
  downloadUrl = 'https://heemangstudios.com/',
  // keyId → `{ periodAnchor }` of an active plan in the frozen hama.json, else null. Read-only.
  legacyRauPlan = async () => null,
  // A read of the accounts store (never its update lock): the account a verified buyer email belongs to, or null.
  accountForEmail = async () => null,
  webhookLog = createWebhookLog({ now }),
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const catalog = new Map((products ?? buildProductCatalog({
    onetimeProductIds,
    subscriptionProductIds,
    signatureProductIds,
    expectedPrice,
    minAmount,
    signatureExpectedPrice,
    signatureMinAmount,
    hamaProducts,
    rauProducts,
  })).map((product) => [product.id, product]));
  const graceEndOf = (license) => paymentGraceEndOf(license, paymentGraceMaxMs);
  const accessEnd = (license) => accessEndOf(license, paymentGraceMaxMs);
  // Groble's buyer page, for a key that renews or lapses there. Lifetime and gift keys have none.
  const fixUrlOf = (license) => (expiryOf(license) === null || isGiftKey(license) ? null : paymentFixUrl);

  /** `fn` runs alone on the store and returns `{ value, dirty }`; the state is saved unless `dirty` is false. */
  async function mutate(fn) {
    const result = await store.update((state) => fn(normalizeState(state)));
    return result?.value ?? result;
  }

  async function read() {
    return normalizeState(await store.read());
  }

  function createLicense(state, fields) {
    let key;
    do key = generateLicenseKey(random); while (state.keyIndex[key]);
    let keyId;
    do keyId = newKeyId(random); while (state.licenses[keyId]);
    const license = {
      keyId,
      key,
      status: 'active',
      createdAt: new Date(now()).toISOString(),
      devices: {},
      ...fields,
    };
    for (const k of Object.keys(license)) if (license[k] === undefined) delete license[k];
    state.licenses[keyId] = license;
    state.keyIndex[key] = keyId;
    return license;
  }

  function queueEmail(license) {
    if (!license.email) {
      license.emailDelivery = { status: 'no_address' };
      return;
    }
    license.emailDelivery = { status: 'pending', queuedAt: new Date(now()).toISOString() };
  }

  function revoke(license, reason) {
    if (license.status === 'revoked') return false;
    license.status = 'revoked';
    license.revokedAt = new Date(now()).toISOString();
    license.revokeReason = reason;
    return true;
  }

  /** The license ↔ account link lives on the license record. */
  function linkLicense(license, accountId, linkedBy) {
    license.accountId = accountId;
    license.linkedAt = new Date(now()).toISOString();
    license.linkedBy = linkedBy;
    delete license.unlinkedAt;
    delete license.unlinkedBy;
  }

  function findLicense(state, { key, keyId, merchantUid, ref } = {}) {
    if (keyId && Object.hasOwn(state.licenses, keyId)) return state.licenses[keyId];
    const normalized = normalizeLicenseKey(key);
    if (normalized && state.keyIndex[normalized]) return state.licenses[state.keyIndex[normalized]];
    if (merchantUid && state.orders[merchantUid]?.keyId) return state.licenses[state.orders[merchantUid].keyId];
    if (typeof ref === 'string' && Object.hasOwn(state.refs, ref)) return findLicense(state, { merchantUid: state.refs[ref] });
    return undefined;
  }

  /** A ref belongs to the first order that claimed it, so a later order can never take over a buyer's success page. */
  function linkRef(state, ref, merchantUid) {
    if (ref && !state.refs[ref]) state.refs[ref] = merchantUid;
  }

  function pruneWebhookEvents(state) {
    const cutoff = now() - WEBHOOK_EVENT_RETENTION_MS;
    for (const [id, entry] of Object.entries(state.webhookEvents)) {
      if ((parseTime(entry?.receivedAt) ?? 0) < cutoff) delete state.webhookEvents[id];
    }
  }

  // ---------------------------------------------------------------- Groble
  //
  // Event names and fields follow https://groble.im/help/guides/webhook-events (read 2026-10-19).
  // One-time orders (`payment.*`, ONE_TIME products) issue lifetime keys. Subscription products
  // (`subscription_payment.*`, `subscription.*`) issue one key on the INITIAL round with
  // `expiresAt`, and every RENEWAL round extends that same key. A subscription is found by its
  // `sellerReference` (the success-page ref, the same on every round); `merchantUid` is new each round.

  function priceProblem(object, product, { renewal = false } = {}) {
    const finalAmount = num(object?.pricing?.finalAmount);
    const originalAmount = num(object?.pricing?.originalAmount);
    if (str(object?.pricing?.currency, 8) && object.pricing.currency !== 'KRW') return 'wrong_currency';
    if (finalAmount === undefined) return 'missing_amount';
    // A renewal bills the price frozen at signup, so a later price change must not hold old subscribers.
    if (renewal) return finalAmount > 0 ? null : `amount_below_minimum:${finalAmount}`;
    if (originalAmount !== undefined && originalAmount !== product.expectedPrice) return `wrong_price:${originalAmount}`;
    if (finalAmount < product.minAmount) return `amount_below_minimum:${finalAmount}`;
    return null;
  }

  /**
   * A Hama or Rau product sold through a Groble option must be paid as exactly that option: Groble's
   * subscription events carry one option with quantity 1. Its list price, when present, must be the product's.
   */
  function optionProblem(object, product) {
    if (!product.optionId) return null;
    const options = Array.isArray(object?.options) ? object.options : [];
    if (options.length === 0) return 'missing_option';
    const ids = options.map((option) => str(option?.optionId, 64) ?? 'missing');
    if (options.length !== 1 || ids[0] !== product.optionId) return `wrong_option:${ids.join(',')}`;
    const listPrice = num(options[0]?.unitOriginalPrice);
    if (listPrice !== undefined && listPrice !== product.expectedPrice) return `wrong_price:${listPrice}`;
    return null;
  }

  function checkPurchase(object, { subscription = false, renewal = false } = {}) {
    const contentId = str(object?.content?.id, 128);
    const paymentType = str(object?.content?.paymentType, 32);
    const product = contentId ? catalog.get(contentId) : undefined;
    if (!product) return `wrong_product:${contentId ?? 'missing'}`;
    if (subscription !== (product.kind === 'subscription')) return `wrong_product:${contentId}`;
    const expectedType = product.kind === 'subscription' ? 'SUBSCRIPTION' : 'ONE_TIME';
    if (paymentType && paymentType !== expectedType) return `wrong_payment_type:${paymentType}`;
    // A Hama or Rau product bills on its own cycle. An event that names another one is held instead of
    // trusted, so a monthly buyer can never get a year; a missing or unreadable field uses the product's.
    const eventMonths = eventCycleMonths(object);
    if (product.cycleMonths && eventMonths !== undefined && eventMonths !== product.cycleMonths) return `cycle_mismatch:${eventMonths}`;
    // A renewal checks product and currency only, so a later price or option change never holds old subscribers.
    if (!renewal) {
      const option = optionProblem(object, product);
      if (option) return option;
    }
    return priceProblem(object, product, { renewal });
  }

  /** Months the round buys: a Hama or Rau product's own cycle, else the event's, else 12 (GLJFC9). */
  function orderCycleMonths(object) {
    const product = catalog.get(str(object?.content?.id, 128) ?? '');
    return product?.cycleMonths ?? eventCycleMonths(object) ?? SUBSCRIPTION_CYCLE_MONTHS;
  }

  /** Hama and Rau keys carry the stored edition ('basic' or 'rau'), product and cycle on the record itself. */
  function planEntitlement(product, months) {
    return isPlanEdition(product?.edition) ? { edition: product.edition, productId: product.id, billingCycleMonths: months } : {};
  }

  /** Create or update the order record of one paid round. */
  function recordOrder(state, event, object, kind) {
    const merchantUid = object.merchantUid;
    const ref = str(object.sellerReference, 128);
    const email = str(object?.buyer?.email, 254);
    const order = state.orders[merchantUid] ?? { merchantUid, createdAt: new Date(now()).toISOString() };
    state.orders[merchantUid] = order;
    Object.assign(order, {
      ...(kind ? { kind } : {}),
      ref: order.ref ?? (ref && REF_RE.test(ref) ? ref : undefined),
      email: order.email ?? email,
      contentId: str(object?.content?.id, 128),
      amount: num(object?.pricing?.finalAmount),
      originalAmount: num(object?.pricing?.originalAmount),
      couponCode: str(object?.pricing?.coupon?.code, 64),
      purchasedAt: str(object?.payment?.purchasedAt, 64),
      completedAt: event.occurredAt,
      completedEventId: str(event.id, 128),
      ...(kind ? {
        billingCycleMonths: orderCycleMonths(object),
        round: Number.isSafeInteger(object?.subscription?.currentRound) ? object.subscription.currentRound : undefined,
      } : {}),
    });
    for (const k of Object.keys(order)) if (order[k] === undefined) delete order[k];
    // The first round claims the ref; renewals carry the same ref and leave the mapping alone.
    if (kind !== 'renewal') linkRef(state, order.ref, merchantUid);
    return order;
  }

  function hold(order, reason) {
    order.status = 'held';
    order.holdReason = reason;
    delete order.ackedAt; // a newly held round shows on the dashboard again
    log(`[site-api] groble order ${order.merchantUid} held: ${reason}`);
    return { action: 'held', reason, needsReview: true };
  }

  /** When a round was paid: Groble's purchase time, else the event time, else now. */
  function paidAtOf(order) {
    return parseTime(order.purchasedAt) ?? parseTime(order.completedAt) ?? now();
  }

  /** License fields for a subscription key issued from its first paid round. */
  function subscriptionStart(order, object = {}) {
    const paidMs = paidAtOf(order);
    const expiresMs = subscriptionEnd(paidMs, order.billingCycleMonths ?? SUBSCRIPTION_CYCLE_MONTHS);
    order.grantFrom = iso(paidMs);
    order.grantTo = iso(expiresMs);
    const sub = object.subscription ?? {};
    const subscription = {
      productId: order.contentId,
      status: 'active',
      autoRenew: true,
      billingCycleMonths: order.billingCycleMonths ?? SUBSCRIPTION_CYCLE_MONTHS,
      activatedAt: str(sub.activatedAt, 64) ?? order.purchasedAt ?? order.completedAt,
      lastPaidAt: iso(paidMs),
      currentRound: order.round,
      nextBillingDate: str(sub.nextBillingDate, 16),
    };
    for (const k of Object.keys(subscription)) if (subscription[k] === undefined) delete subscription[k];
    return { expiresAt: iso(expiresMs), subscription };
  }

  /** The subscription key a renewal, failure, cancel or termination belongs to. */
  function findSubscriptionLicense(state, object) {
    const ref = str(object.sellerReference, 128);
    if (ref && state.refs[ref]) {
      const license = findLicense(state, { merchantUid: state.refs[ref] });
      if (license?.subscription) return license;
    }
    // A buyer who reached Groble without our ref (the store page itself) still renews: match the
    // one live subscription key with the buyer's email for this product, and only when there is one.
    const email = str(object?.buyer?.email, 254)?.toLowerCase();
    if (ref || !email) return undefined;
    const contentId = str(object?.content?.id, 128);
    const matches = Object.values(state.licenses).filter((l) => l.subscription
      && l.email?.toLowerCase() === email
      && (!contentId || !l.subscription.productId || l.subscription.productId === contentId)
      && l.subscription.status !== 'terminated');
    return matches.length === 1 ? matches[0] : undefined;
  }

  function attachToIssued(state, order, email, event, buyerAccountId) {
    const license = state.licenses[order.keyId];
    if (license) {
      license.ref = license.ref ?? order.ref;
      license.email = license.email ?? email;
      license.amount = license.amount ?? order.amount;
      license.occurredAt = license.occurredAt ?? event.occurredAt;
      if (buyerAccountId && !license.accountId && license.status !== 'revoked') linkLicense(license, buyerAccountId, 'purchase');
    }
    return { action: 'already_issued', keyId: order.keyId };
  }

  /**
   * One-time `payment.completed` or the INITIAL round of a subscription: one key per merchantUid.
   * `buyerAccountId` is the verified account of the buyer's email; the new key is linked to it.
   */
  function onCompleted(state, event, object, { subscription = false, buyerAccountId = null } = {}) {
    const order = recordOrder(state, event, object, subscription ? 'subscription' : undefined);
    const email = str(object?.buyer?.email, 254);
    // Already issued (webhook retry with a new delivery key, or a manual backfill). Attach data only.
    if (order.keyId) return attachToIssued(state, order, email, event, buyerAccountId);
    // Refund arrived before the completion (Groble does not guarantee order). Never issue.
    if (order.status === 'refunded') return { action: 'refunded_before_completed' };
    const problem = checkPurchase(object, { subscription });
    if (problem) return hold(order, problem);
    const product = catalog.get(order.contentId);
    const license = createLicense(state, {
      source: 'groble',
      merchantUid: order.merchantUid,
      ref: order.ref,
      email,
      amount: order.amount,
      occurredAt: event.occurredAt,
      ...(subscription ? subscriptionStart(order, object) : {}),
      ...(subscription ? planEntitlement(product, order.billingCycleMonths) : {}),
      ...(product?.kind === 'signature' ? signatureEntitlement(product.id, paidAtOf(order)) : {}),
    });
    if (buyerAccountId) linkLicense(license, buyerAccountId, 'purchase');
    queueEmail(license);
    order.status = 'issued';
    order.keyId = license.keyId;
    delete order.holdReason;
    return { action: 'issued', keyId: license.keyId, ...(license.expiresAt ? { expiresAt: license.expiresAt } : {}) };
  }

  /**
   * A RENEWAL round extends the same key by one billing cycle from its current expiry, or from the
   * payment when it already lapsed. The round's merchantUid is recorded, so a replay never extends twice.
   */
  function onRenewal(state, event, object) {
    const order = recordOrder(state, event, object, 'renewal');
    if (order.keyId) return { action: 'already_renewed', keyId: order.keyId };
    if (order.status === 'refunded') return { action: 'refunded_before_completed' };
    const problem = checkPurchase(object, { subscription: true, renewal: true });
    if (problem) return hold(order, problem);
    const license = findSubscriptionLicense(state, object);
    if (!license) return hold(order, 'renewal_unmatched');
    if (license.status === 'revoked') return hold(order, 'renewal_for_revoked_key');
    return applyRenewal(license, order, object);
  }

  /** Extend `license` by the paid renewal round `order`, as a matched webhook or an admin does. */
  function applyRenewal(license, order, object = {}) {
    // A late renewal (a retry or re-payment after the key lapsed) starts the new year on the day it was paid.
    const paidMs = paidAtOf(order);
    const from = Math.max(expiryOf(license) ?? paidMs, paidMs);
    // Each round buys the key's own cycle: a monthly key gains a month, an annual key a year.
    const to = subscriptionEnd(from, keyCycleMonths(license));
    license.expiresAt = iso(to);
    order.status = 'renewed';
    order.keyId = license.keyId;
    order.grantFrom = iso(from);
    order.grantTo = iso(to);
    delete order.holdReason;
    const sub = license.subscription;
    // A renewal paid after a cancel request means the subscription is running again.
    if (!sub.cancelRequestedAt || paidMs > (parseTime(sub.cancelRequestedAt) ?? 0)) {
      sub.status = 'active';
      sub.autoRenew = true;
    }
    sub.lastPaidAt = iso(paidMs);
    if (order.round !== undefined) sub.currentRound = order.round;
    const nextBillingDate = str(object?.subscription?.nextBillingDate, 16);
    if (nextBillingDate) sub.nextBillingDate = nextBillingDate;
    delete sub.lastFailure;
    delete sub.paymentGraceEndsAt;
    // A monthly key keeps its key, so it gets no key email every month; Groble sends the receipt.
    if (license.email && keyCycleMonths(license) !== 1) license.emailDelivery = { status: 'pending', queuedAt: new Date(now()).toISOString(), renewal: true };
    return { action: 'renewed', keyId: license.keyId, expiresAt: license.expiresAt };
  }

  function unmatched(type) {
    return { action: 'subscription_unmatched', reason: `subscription_unmatched:${type}`, needsReview: true };
  }

  /**
   * A failed renewal keeps the key fully usable through Groble's retry and grace window: until
   * `failure.gracePeriodEndsAt` when the event carries it (the final attempt does), else the key's
   * expiry plus `paymentGraceMs`. `subscription.terminated` or the window's end stops it; a paid retry
   * renews as usual.
   */
  function onPaymentFailed(state, event, object) {
    const license = findSubscriptionLicense(state, object);
    if (!license) return unmatched('subscription_payment.failed');
    const failure = object?.failure ?? {};
    const failedAt = str(failure.failedAt, 64) ?? event.occurredAt;
    const sub = license.subscription;
    if ((parseTime(failedAt) ?? 0) > (parseTime(sub.lastPaidAt) ?? 0) && sub.status !== 'terminated') {
      sub.status = 'past_due';
      sub.lastFailure = {
        merchantUid: object.merchantUid,
        attemptNumber: Number.isSafeInteger(failure.attemptNumber) ? failure.attemptNumber : undefined,
        isFinal: failure.isFinal === true,
        reason: str(failure.reason, 64),
        failedAt,
        nextRetryAt: str(failure.nextRetryAt, 64),
        gracePeriodEndsAt: str(failure.gracePeriodEndsAt, 64),
      };
      for (const k of Object.keys(sub.lastFailure)) if (sub.lastFailure[k] === undefined) delete sub.lastFailure[k];
      const fromEvent = parseTime(failure.gracePeriodEndsAt);
      const base = expiryOf(license) ?? now();
      const derived = Math.max(parseTime(sub.paymentGraceEndsAt) ?? 0, base + paymentGraceMs);
      // Groble's window or ours, but never more than paymentGraceMaxMs past the expiry.
      sub.paymentGraceEndsAt = iso(Math.min(fromEvent ?? derived, base + paymentGraceMaxMs));
    }
    return { action: 'payment_failure_recorded', keyId: license.keyId, paymentGraceEndsAt: sub.paymentGraceEndsAt };
  }

  /** Auto-renewal is off; the key still runs to its expiry. */
  function onSubscriptionCancelRequested(state, event, object) {
    const license = findSubscriptionLicense(state, object);
    if (!license) return unmatched('subscription.cancel_requested');
    const sub = license.subscription;
    const request = object?.cancelRequest ?? {};
    sub.autoRenew = false;
    // A past-due subscription keeps its payment grace until Groble terminates it.
    if (sub.status !== 'terminated' && sub.status !== 'past_due') sub.status = 'cancel_requested';
    sub.cancelRequestedAt = str(request.requestedAt, 64) ?? str(object?.subscription?.cancelledAt, 64) ?? event.occurredAt;
    sub.cancelRequestedBy = str(request.requestedBy, 16);
    sub.serviceEndsAt = str(object.serviceEndsAt, 64);
    for (const k of Object.keys(sub)) if (sub[k] === undefined) delete sub[k];
    return { action: 'cancel_recorded', keyId: license.keyId };
  }

  /** The subscription ended on Groble's side. No more renewals; the key still runs to its expiry. */
  function onSubscriptionTerminated(state, event, object) {
    const license = findSubscriptionLicense(state, object);
    if (!license) return unmatched('subscription.terminated');
    const sub = license.subscription;
    sub.status = 'terminated';
    sub.autoRenew = false;
    sub.terminatedAt = str(object?.termination?.terminatedAt, 64) ?? event.occurredAt;
    sub.terminationReason = str(object?.termination?.reason, 64);
    sub.cancelledBy = str(object.cancelledBy, 16);
    for (const k of Object.keys(sub)) if (sub[k] === undefined) delete sub[k];
    return { action: 'termination_recorded', keyId: license.keyId };
  }

  function onCancelRequested(state, event, object) {
    const merchantUid = object.merchantUid;
    const order = state.orders[merchantUid] ?? { merchantUid, createdAt: new Date(now()).toISOString(), status: 'unknown' };
    state.orders[merchantUid] = order;
    order.cancelRequests = Array.isArray(order.cancelRequests) ? order.cancelRequests : [];
    const requestedAt = str(object?.cancelRequest?.requestedAt, 64) ?? event.occurredAt;
    if (!order.cancelRequests.some((r) => r.requestedAt === requestedAt)) {
      order.cancelRequests.push({
        requestedAt,
        occurredAt: event.occurredAt,
        requestedBy: str(object?.cancelRequest?.requestedBy, 16),
        detailReason: str(object?.cancelRequest?.detailReason, 500),
      });
    }
    return { action: 'cancel_request_recorded' };
  }

  /**
   * A full refund of a subscription round takes back the time that round bought. Once every paid
   * round of the key is refunded, the key is revoked like a refunded one-time order.
   */
  function refundRound(state, order, refundedAt) {
    const license = state.licenses[order.keyId];
    const granted = (parseTime(order.grantTo) ?? 0) - (parseTime(order.grantFrom) ?? 0);
    const expiry = expiryOf(license);
    if (expiry !== null && granted > 0) license.expiresAt = iso(expiry - granted);
    const paidRoundLeft = Object.values(state.orders).some((o) => o !== order && o.keyId === license.keyId
      && o.grantTo && o.status !== 'refunded');
    if (!paidRoundLeft) revoke(license, `groble_refund:${refundedAt}`);
    return { action: paidRoundLeft ? 'round_refunded' : 'revoked', keyId: license.keyId, expiresAt: license.expiresAt };
  }

  function onRefunded(state, event, object) {
    const merchantUid = object.merchantUid;
    const order = state.orders[merchantUid] ?? { merchantUid, createdAt: new Date(now()).toISOString(), status: 'unknown' };
    state.orders[merchantUid] = order;
    order.refunds = Array.isArray(order.refunds) ? order.refunds : [];
    const refund = object?.refund ?? {};
    const refundedAt = str(refund.refundedAt, 64) ?? event.occurredAt;
    // Groble: dedupe partial refunds on merchantUid + refund.refundedAt.
    if (!order.refunds.some((r) => r.refundedAt === refundedAt)) {
      order.refunds.push({
        refundedAt,
        occurredAt: event.occurredAt,
        amount: num(refund.amount),
        partialRefund: refund.partialRefund === true,
        cancelledBy: str(refund.cancelledBy, 16),
        reason: str(refund.reason, 500),
      });
    }
    const paid = num(object?.pricing?.finalAmount) ?? order.amount;
    const refundedTotal = order.refunds.reduce((sum, r) => sum + (r.amount ?? 0), 0);
    const full = order.refunds.some((r) => !r.partialRefund) || (paid !== undefined && paid > 0 && refundedTotal >= paid);
    if (!full) return { action: 'partial_refund_recorded', refundedTotal };
    if (order.status === 'refunded') return { action: 'refund_already_recorded', keyId: order.keyId };
    order.status = 'refunded';
    order.refundedAt = refundedAt;
    const license = order.keyId ? state.licenses[order.keyId] : undefined;
    if (license && order.grantTo) return refundRound(state, order, refundedAt);
    if (license) revoke(license, `groble_refund:${refundedAt}`);
    return { action: license ? 'revoked' : 'refund_recorded_no_key', keyId: license?.keyId };
  }

  const GROBLE_HANDLERS = {
    'payment.completed': (state, event, object, context) => onCompleted(state, event, object, context),
    'payment.cancel_requested': onCancelRequested,
    'payment.refunded': onRefunded,
    'subscription_payment.completed': (state, event, object, context) => (object?.subscription?.billingReason === 'RENEWAL'
      ? onRenewal(state, event, object)
      : onCompleted(state, event, object, { ...context, subscription: true })),
    'subscription_payment.refunded': onRefunded,
    'subscription_payment.failed': onPaymentFailed,
    'subscription.cancel_requested': onSubscriptionCancelRequested,
    'subscription.terminated': onSubscriptionTerminated,
  };

  function issuesKey(type, object) {
    return type === 'payment.completed'
      || (type === 'subscription_payment.completed' && object?.subscription?.billingReason !== 'RENEWAL');
  }

  /** The verified account of the buyer's email, or null. Never fails the webhook. */
  async function buyerAccount(object) {
    const email = str(object?.buyer?.email, 254)?.toLowerCase();
    if (!email) return null;
    const accountId = await Promise.resolve().then(() => accountForEmail(email)).catch((error) => {
      log(`[site-api] account lookup for a purchase failed: ${error?.message ?? error}`);
      return null;
    });
    return accountId ?? null;
  }

  /**
   * Process one verified Groble event. Returns a small summary (never buyer data). An event we
   * cannot use (unknown type, unmatched subscription, held order) still answers 200 so Groble
   * stops retrying, and carries `needsReview` so the server records it in the webhook log.
   */
  async function handleGrobleEvent(event, { idempotencyKey } = {}) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw licenseError('webhook_payload_invalid', 400);
    }
    const type = str(event.type, 64);
    const object = event?.data?.object;
    // Read before the lock: the accounts store belongs to another service.
    const buyerAccountId = issuesKey(type, object) ? await buyerAccount(object) : null;
    return mutate(async (state) => {
      pruneWebhookEvents(state);
      const dedupeKey = idempotencyKey || (event.id ? `event:${event.id}` : '');
      if (dedupeKey && state.webhookEvents[dedupeKey]) {
        return { dirty: false, value: { duplicate: true, action: state.webhookEvents[dedupeKey].action } };
      }
      let result;
      const handler = Object.hasOwn(GROBLE_HANDLERS, type ?? '') ? GROBLE_HANDLERS[type] : null;
      if (!handler) {
        log(`[site-api] groble event type not handled: ${type ?? 'missing'}`);
        result = { action: 'ignored_event_type', reason: `unknown_event_type:${type ?? 'missing'}`, needsReview: true };
      } else if (!object || typeof object !== 'object' || !str(object.merchantUid, 128)) {
        result = { action: 'ignored_missing_merchant_uid', reason: 'missing_merchant_uid', needsReview: true };
      } else {
        object.merchantUid = str(object.merchantUid, 128);
        const occurredMs = parseTime(event.occurredAt) ?? now();
        result = handler(state, event, object, { buyerAccountId });
        const order = state.orders[object.merchantUid];
        const last = parseTime(order?.lastEventAt);
        if (order && (last === undefined || occurredMs > last)) order.lastEventAt = new Date(occurredMs).toISOString();
      }
      if (dedupeKey) {
        state.webhookEvents[dedupeKey] = {
          receivedAt: new Date(now()).toISOString(),
          type,
          eventId: str(event.id, 128),
          merchantUid: str(object?.merchantUid, 128),
          action: result.action,
        };
      }
      return { value: { duplicate: false, ...result } };
    });
  }

  // --------------------------------------------------------------- email

  // One delivery pass at a time: webhooks that land during a pass schedule exactly one more,
  // so the same pending email is never sent by two overlapping passes.
  let delivering = null;
  let deliverAgain = false;

  /** Send every queued key email. Safe to call repeatedly; never throws. */
  async function deliverPendingEmails() {
    if (!emailProvider) return [];
    if (delivering) {
      deliverAgain = true;
      return delivering;
    }
    delivering = (async () => {
      let results = [];
      do {
        deliverAgain = false;
        results = results.concat(await deliverPendingPass());
      } while (deliverAgain);
      return results;
    })().finally(() => { delivering = null; });
    return delivering;
  }

  async function deliverPendingPass() {
    const state = await read();
    const pending = Object.values(state.licenses).filter((l) => l.emailDelivery?.status === 'pending' && l.email);
    const results = [];
    for (const license of pending) {
      const message = licenseEmail({
        key: license.key,
        kind: licenseEmailKind(license),
        downloadUrl,
        expiresAt: expiryOf(license),
        autoRenew: autoRenewOf(license) !== false,
        cycleMonths: keyCycleMonths(license),
        updatesUntil: parseTime(license.updatesUntil) ?? null,
      });
      let outcome;
      try {
        outcome = await emailProvider.send({ to: license.email, ...message, idempotencyKey: `license-${license.keyId}-${license.emailDelivery?.queuedAt ?? ''}` });
      } catch (error) {
        outcome = { status: 'failed', error: String(error?.message ?? error).slice(0, 200) };
      }
      await mutate(async (s) => {
        const current = s.licenses[license.keyId];
        if (!current || current.emailDelivery?.status !== 'pending') return { dirty: false };
        const attempts = (current.emailDelivery.attempts ?? 0) + 1;
        current.emailDelivery = {
          ...current.emailDelivery,
          status: outcome.status === 'failed' && attempts < 3 ? 'pending' : outcome.status,
          provider: emailProvider.name,
          attempts,
          lastAttemptAt: new Date(now()).toISOString(),
          ...(outcome.providerId ? { providerId: outcome.providerId } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
        };
        return {};
      }).catch(() => {});
      log(`[site-api] license email ${outcome.status} for ${license.keyId} (${maskEmail(license.email)})`);
      results.push({ keyId: license.keyId, status: outcome.status });
    }
    return results;
  }

  // ------------------------------------------------------- success page

  async function statusByRef(ref) {
    if (typeof ref !== 'string' || !REF_RE.test(ref)) throw licenseError('ref_invalid', 400);
    const state = await read();
    const merchantUid = state.refs[ref];
    const order = merchantUid ? state.orders[merchantUid] : undefined;
    const license = order?.keyId ? state.licenses[order.keyId] : undefined;
    if (license?.status === 'active') {
      return {
        status: 'issued',
        key: license.key,
        licenseExpiresAt: expiryOf(license),
        ...(isPlanEdition(license.edition) ? { edition: editionOf(license), plan: planOf(license) } : {}),
        ...(license.edition === 'signature' ? {
          edition: 'signature',
          prioritySupport: true,
          updatesUntil: parseTime(license.updatesUntil) ?? null,
        } : {}),
      };
    }
    if (license?.status === 'revoked' || order?.status === 'refunded') return { status: 'revoked' };
    return { status: 'pending' };
  }

  // ------------------------------------------------------- app endpoints

  function requireSigningKey() {
    if (!signingKey) throw licenseError('server_not_configured', 503, 'LICENSE_SIGNING_PRIVATE_KEY is not set');
  }

  function parseDevice(body) {
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim() : '';
    if (!DEVICE_ID_RE.test(deviceId)) throw licenseError('device_id_invalid', 400);
    return deviceId;
  }

  function lookupActive(state, rawKey) {
    const key = normalizeLicenseKey(rawKey);
    const license = key ? state.licenses[state.keyIndex[key]] : undefined;
    if (!license) throw licenseError('invalid_key', 404);
    if (license.status === 'revoked') throw Object.assign(licenseError('revoked', 403), { tier: tierOf(license) });
    const end = accessEnd(license);
    if (end !== null && now() >= end) {
      throw Object.assign(licenseError('expired', 403), { tier: tierOf(license), licenseExpiresAt: expiryOf(license), paymentFixUrl: fixUrlOf(license) ?? undefined });
    }
    return license;
  }

  /** The key's active plan in the frozen hama.json, or null. A store that cannot be read leaves the key's other entitlements in place. */
  async function legacyPlanOf(license) {
    return Promise.resolve().then(() => legacyRauPlan(license.keyId)).catch((error) => {
      log(`[site-api] legacy hama plan of ${license.keyId} unreadable: ${error?.message ?? error}`);
      return null;
    }).then((plan) => plan ?? null);
  }

  /**
   * The Rau principal of a license, or null: its ledger is the key's own, billed in monthly periods
   * from the subscription's first payment, else the key's creation, else the legacy plan's anchor.
   */
  function rauPrincipalOf(license, legacyPlan) {
    if (!rauEntitled(license, now(), paymentGraceMaxMs, legacyPlan)) return null;
    const anchor = parseTime(license.subscription?.activatedAt) ?? parseTime(license.createdAt) ?? parseTime(legacyPlan?.periodAnchor) ?? now();
    return { source: 'plan', ledgerId: license.keyId, anchor: iso(anchor) };
  }

  async function rauFor(license) {
    return rauPrincipalOf(license, await legacyPlanOf(license));
  }

  /** `submittedKey` is what the app sent; the lease's keyHash is over the app's normalization of it. */
  function leaseResponse(license, deviceId, submittedKey, rau) {
    const licenseExpiresAt = expiryOf(license);
    const paymentGraceEndsAt = graceEndOf(license);
    const { lease, payload } = signLease({
      kid: leaseKid,
      keyId: license.keyId,
      key: submittedKey,
      deviceId,
      now: now(),
      ttlMs: tierOf(license) === 'beta' ? BETA_LEASE_TTL_MS : LEASE_TTL_MS,
      licenseExpiresAt,
      paymentGraceEndsAt,
    }, signingKey);
    return {
      ok: true,
      lease,
      keyId: license.keyId,
      tier: tierOf(license),
      expiresAt: payload.expiresAt,
      // The key's own end (null = lifetime). The lease's `expiresAt` above is only the offline window.
      licenseExpiresAt,
      autoRenew: autoRenewOf(license),
      // `payment_failed`: Groble could not charge the renewal. The key works until `paymentGraceEndsAt`;
      // the buyer fixes the payment on `paymentFixUrl`.
      licenseState: paymentGraceEndsAt === null ? 'active' : 'payment_failed',
      paymentGraceEndsAt,
      ...(fixUrlOf(license) ? { paymentFixUrl } : {}),
      devicesUsed: Object.keys(license.devices).length,
      deviceLimit: deviceLimitOf(license),
      ...(license.edition === 'signature' ? {
        edition: 'signature',
        prioritySupport: license.status === 'active',
        updatesUntil: parseTime(license.updatesUntil) ?? null,
      } : {}),
      ...(isPlanEdition(license.edition) ? { edition: editionOf(license) } : {}),
      plan: planOf(license),
      // Hosted Rau (Rau-0.1) answers live Rau keys and keys with an active legacy plan.
      // A license lease never carries the account's trial.
      rau: { eligible: rau !== null },
    };
  }

  async function activate(body) {
    requireSigningKey();
    const deviceId = parseDevice(body);
    return mutate(async (state) => {
      const license = lookupActive(state, body?.key);
      license.devices = license.devices ?? {};
      const stamp = new Date(now()).toISOString();
      const existing = license.devices[deviceId];
      if (!existing && Object.keys(license.devices).length >= deviceLimitOf(license)) {
        throw licenseError('device_limit', 409);
      }
      license.devices[deviceId] = {
        activatedAt: existing?.activatedAt ?? stamp,
        lastSeenAt: stamp,
        appVersion: str(body?.appVersion, 32),
        platform: str(body?.platform, 32),
      };
      return { value: leaseResponse(license, deviceId, body.key, await rauFor(license)) };
    });
  }

  async function validate(body) {
    requireSigningKey();
    const deviceId = parseDevice(body);
    return mutate(async (state) => {
      const license = lookupActive(state, body?.key);
      const device = license.devices?.[deviceId];
      if (!device) throw licenseError('not_activated', 404);
      device.lastSeenAt = new Date(now()).toISOString();
      return { value: leaseResponse(license, deviceId, body.key, await rauFor(license)) };
    });
  }

  async function deactivate(body) {
    const deviceId = parseDevice(body);
    return mutate(async (state) => {
      const key = normalizeLicenseKey(body?.key);
      const license = key ? state.licenses[state.keyIndex[key]] : undefined;
      if (!license) throw licenseError('invalid_key', 404);
      const removed = Boolean(license.devices?.[deviceId]);
      if (removed) delete license.devices[deviceId];
      return { dirty: removed, value: { ok: true, removed, tier: tierOf(license), devicesUsed: Object.keys(license.devices ?? {}).length, deviceLimit: deviceLimitOf(license) } };
    });
  }

  let leasePublicKeys;

  /**
   * Check a lease the app presents as a bearer token: our own signature, not expired, the
   * license still active, the device still activated and the key unchanged. Read-only.
   * Returns `{ keyId, deviceId, platform, source, tier, edition, active }`; anything else is
   * `unauthorized` (401). `allowInactive` also answers for a revoked or expired key (`active: false`),
   * so hosted Rau can tell such a key to upgrade; the lease itself must still be ours and unexpired.
   * `withRau` adds `rau`: the key's Rau principal `{ source: 'plan', ledgerId, anchor }`, or null.
   */
  async function authenticateLease(lease, { allowInactive = false, withRau = false } = {}) {
    if (!signingKey) throw licenseError('unauthorized', 401);
    leasePublicKeys ??= { [leaseKid]: publicKeyFromPrivate(signingKey) };
    const checked = verifyLease(lease, leasePublicKeys, { now: now() });
    if (!checked.ok) throw licenseError('unauthorized', 401);
    const { keyId, deviceId, keyHash } = checked.payload;
    const state = await read();
    const license = Object.hasOwn(state.licenses, keyId) ? state.licenses[keyId] : undefined;
    const device = license?.devices && Object.hasOwn(license.devices, deviceId) ? license.devices[deviceId] : undefined;
    if (!license || !device || licenseKeyHash(license.key) !== keyHash) throw licenseError('unauthorized', 401);
    const end = accessEnd(license);
    const active = license.status === 'active' && !(end !== null && now() >= end);
    if (!active && !allowInactive) throw licenseError('unauthorized', 401);
    return {
      keyId,
      deviceId,
      platform: device.platform,
      source: license.source,
      tier: tierOf(license),
      edition: editionOf(license) ?? null,
      active,
      ...(withRau ? { rau: await rauFor(license) } : {}),
    };
  }

  // ------------------------------------------------------------ accounts

  /**
   * Licenses linked to an account, each with what ranks it: live = active and before its access end
   * (lifetime keys always), rank 2 for a key with Rau, 1 for every other key (Hama, GLJFC9, lifetime,
   * Signature, beta, grandfathered, manual).
   */
  async function linkedOf(state, accountId) {
    const nowMs = now();
    const linked = Object.values(state.licenses).filter((license) => license.accountId === accountId);
    return Promise.all(linked.map(async (license) => {
      const end = accessEnd(license);
      const live = isLive(license, nowMs, paymentGraceMaxMs);
      const rau = live ? rauPrincipalOf(license, await legacyPlanOf(license)) : null;
      return { license, live, end, rau, rank: rau ? 2 : 1, subscribed: isPlanEdition(license.edition) };
    }));
  }

  /**
   * Primary first: highest rank, then a Hama or Rau subscription (so the account shows the plan it pays
   * for, not a beta or lifetime key), then latest access end (lifetime last forever), then oldest.
   */
  function byPrimary(a, b) {
    if (a.rank !== b.rank) return b.rank - a.rank;
    if (a.subscribed !== b.subscribed) return a.subscribed ? -1 : 1;
    const endA = a.end ?? Infinity;
    const endB = b.end ?? Infinity;
    if (endA !== endB) return endB > endA ? 1 : -1;
    return String(a.license.createdAt).localeCompare(String(b.license.createdAt));
  }

  async function liveLinked(accountId) {
    return (await linkedOf(await read(), accountId)).filter((entry) => entry.live).sort(byPrimary);
  }

  function accountEditionOf(license) {
    const edition = editionOf(license);
    return ACCOUNT_EDITIONS.has(edition) ? edition : null;
  }

  function accountLicenseView({ license, live }, primaryKeyId) {
    const expiry = expiryOf(license);
    let status = 'active';
    if (license.status === 'revoked') status = 'revoked';
    else if (!live) status = 'expired';
    else if (graceEndOf(license) !== null) status = 'past_due';
    return {
      keyId: license.keyId,
      maskedKey: maskLicenseKey(license.key),
      tier: tierOf(license),
      edition: accountEditionOf(license),
      plan: planOf(license),
      status,
      expiresAt: expiry,
      autoRenew: autoRenewOf(license),
      primary: license.keyId === primaryKeyId,
      linkedBy: license.linkedBy ?? null,
      linkedAt: parseTime(license.linkedAt) ?? null,
    };
  }

  function licensesListOf(entries, primaryKeyId) {
    return [...entries]
      .sort((a, b) => (b.license.keyId === primaryKeyId) - (a.license.keyId === primaryKeyId)
        || String(b.license.createdAt).localeCompare(String(a.license.createdAt)))
      .map((entry) => accountLicenseView(entry, primaryKeyId));
  }

  /**
   * What an account's licenses entitle it to now. `plan` and `licenses` go to the app (accounts.mjs adds
   * `plan.rau` and lifts the tier during a trial); `primary` carries the fields the account lease signs;
   * `rau` is the best live Rau license's principal, or null.
   */
  async function accountEntitlements(accountId) {
    const entries = await linkedOf(await read(), accountId);
    const live = entries.filter((entry) => entry.live).sort(byPrimary);
    const top = live[0];
    const license = top?.license;
    const expiry = license ? expiryOf(license) : null;
    const graceEnd = license ? graceEndOf(license) : null;
    const tier = top ? RANK_TIERS[top.rank] : 'free';
    return {
      tier,
      primary: license ? {
        keyId: license.keyId,
        beta: tierOf(license) === 'beta',
        plan: planOf(license),
        licenseExpiresAt: expiry,
        paymentGraceEndsAt: graceEnd,
      } : null,
      plan: {
        tier,
        keyId: license?.keyId ?? null,
        edition: license ? accountEditionOf(license) : null,
        plan: license ? planOf(license) : null,
        expiresAt: expiry,
        autoRenew: license ? autoRenewOf(license) : null,
        paymentFailed: graceEnd !== null,
        paymentGraceEndsAt: graceEnd,
        manageUrl: license ? fixUrlOf(license) : null,
      },
      licenses: licensesListOf(entries, license?.keyId ?? null),
      rau: live.find((entry) => entry.rau)?.rau ?? null,
    };
  }

  /** Every license linked to the account, primary first, then newest. */
  async function accountLicensesView(accountId) {
    return (await accountEntitlements(accountId)).licenses;
  }

  /**
   * Links every license bought with this (verified) email that has no account yet. Revoked keys and
   * keys an admin unlinked stay out. Returns how many were linked.
   */
  async function linkByEmail(emailLower, accountId) {
    const email = typeof emailLower === 'string' ? emailLower.trim().toLowerCase() : '';
    if (!email || !accountId) return 0;
    return mutate((state) => {
      let count = 0;
      for (const license of Object.values(state.licenses)) {
        if (license.accountId || license.status === 'revoked' || license.unlinkedBy === 'admin') continue;
        if (license.email?.toLowerCase() !== email) continue;
        linkLicense(license, accountId, 'email');
        count += 1;
      }
      return { dirty: count > 0, value: count };
    });
  }

  /** The shared checks of redeem and claim: a revoked key or another account's key is refused. */
  function linkForAccount(license, accountId, linkedBy) {
    if (license.status === 'revoked') throw licenseError('revoked', 403);
    if (license.accountId && license.accountId !== accountId) throw licenseError('key_linked_elsewhere', 409);
    const alreadyLinked = license.accountId === accountId;
    if (!alreadyLinked) linkLicense(license, accountId, linkedBy);
    return { dirty: !alreadyLinked, value: { alreadyLinked, keyId: license.keyId } };
  }

  /** Links a key the user typed. Resolves to `{ alreadyLinked, keyId }`. */
  async function redeemForAccount(accountId, rawKey) {
    const key = normalizeLicenseKey(rawKey);
    if (!key) throw licenseError('invalid_format', 400);
    return mutate((state) => {
      const license = Object.hasOwn(state.keyIndex, key) ? state.licenses[state.keyIndex[key]] : undefined;
      if (!license) throw licenseError('invalid_key', 404);
      return linkForAccount(license, accountId, 'redeem');
    });
  }

  /**
   * Links the key of a Groble order bought with another email: the order number and the buyer email
   * must both match, and anything else is order_not_found so neither can be probed. A held order has
   * no key yet (order_not_ready).
   */
  async function claimForAccount(accountId, { orderId, email } = {}) {
    const merchantUid = str(orderId, 128);
    const buyer = str(email, 254)?.toLowerCase();
    return mutate((state) => {
      const order = merchantUid && Object.hasOwn(state.orders, merchantUid) ? state.orders[merchantUid] : undefined;
      if (!order || !buyer || order.email?.toLowerCase() !== buyer) throw licenseError('order_not_found', 404);
      const license = order.keyId ? state.licenses[order.keyId] : undefined;
      if (!license) throw order.status === 'held' ? licenseError('order_not_ready', 409) : licenseError('order_not_found', 404);
      return linkForAccount(license, accountId, 'claim');
    });
  }

  /**
   * Redeems a gift code for an account in one mutation: a new key with the batch's stored edition
   * (`plan`), running from now for the batch's term and linked to the account, and the code marked
   * redeemed. A Rau key's credits run monthly from its creation, like any Rau key without a
   * subscription. The same account again gets the same key back (`alreadyRedeemed`). Resolves to
   * `{ alreadyRedeemed, keyId, edition }`, the edition by its current name.
   */
  async function redeemGiftCode(accountId, rawCode) {
    const code = normalizeGiftCode(rawCode);
    if (!code) throw licenseError('invalid_format', 400);
    const hash = giftCodeHash(code);
    return mutate((state) => {
      const record = Object.hasOwn(state.giftCodes, hash) ? state.giftCodes[hash] : undefined;
      const batch = record && Object.hasOwn(state.giftCodeBatches, record.batchId) ? state.giftCodeBatches[record.batchId] : undefined;
      if (!record || !batch) throw licenseError('invalid_code', 404);
      if (record.status === 'redeemed') {
        if (record.accountId !== accountId) throw licenseError('code_redeemed', 409);
        return { dirty: false, value: { alreadyRedeemed: true, keyId: record.keyId, edition: giftPlanName(batch) } };
      }
      const nowMs = now();
      const status = giftCodeStatusOf(record, batch, nowMs);
      if (status === 'revoked') throw licenseError('code_revoked', 410);
      if (status === 'expired') throw licenseError('code_expired', 410);
      const expiresMs = batch.durationMonths ? subscriptionEnd(nowMs, batch.durationMonths) : daysEnd(nowMs, batch.durationDays);
      const license = createLicense(state, {
        source: 'gift_code',
        edition: batch.plan,
        expiresAt: iso(expiresMs),
        giftBatchId: batch.batchId,
      });
      linkLicense(license, accountId, 'gift_code');
      Object.assign(record, { status: 'redeemed', redeemedAt: iso(nowMs), accountId, keyId: license.keyId });
      return { value: { alreadyRedeemed: false, keyId: license.keyId, edition: giftPlanName(batch) } };
    });
  }

  function giftCodeView(record, batch, nowMs) {
    return {
      // An opaque id for admin views and revoke: the SHA-256 cannot give the code back.
      codeHash: record.codeHash,
      maskedCode: maskGiftCode(record.prefix),
      status: giftCodeStatusOf(record, batch, nowMs),
      createdAt: record.createdAt,
      redeemedAt: record.redeemedAt ?? null,
      accountId: record.accountId ?? null,
      keyId: record.keyId ?? null,
      revokedAt: record.revokedAt ?? null,
    };
  }

  /** A batch's plan by its current name: `hama` or `rau` (the batch stores the edition its keys get). */
  function giftPlanName(batch) {
    return editionOf({ edition: batch.plan }) ?? batch.plan;
  }

  /** A batch with its plan by name, its code counts by status and, filtered by `status`, its masked codes. */
  function giftBatchView(state, batch, nowMs, status) {
    const codes = Object.values(state.giftCodes)
      .filter((record) => record.batchId === batch.batchId)
      .map((record) => giftCodeView(record, batch, nowMs));
    const counts = Object.fromEntries(GIFT_CODE_STATUSES.map((name) => [name, codes.filter((c) => c.status === name).length]));
    return { ...batch, plan: giftPlanName(batch), counts, codes: status ? codes.filter((c) => c.status === status) : codes };
  }

  /**
   * `{ plan, durationMonths | durationDays, count, note?, redeemBy? }` checked; plan and term have no
   * defaults. `plan` is `hama` or `rau` (`basic` and `pro` still mean Hama) and comes back as the
   * edition to store.
   */
  function parseGiftIssue(body) {
    if (body?.plan === undefined || body.plan === null || body.plan === '') throw licenseError('plan_required', 400);
    const edition = giftCodeEdition(body.plan);
    if (!edition) throw licenseError('plan_invalid', 400);
    const hasMonths = body?.durationMonths !== undefined && body.durationMonths !== null;
    const hasDays = body?.durationDays !== undefined && body.durationDays !== null;
    if (hasMonths && hasDays) throw licenseError('duration_conflict', 400);
    if (!hasMonths && !hasDays) throw licenseError('duration_required', 400);
    const term = {};
    if (hasMonths) {
      const months = wholeNumber(body.durationMonths);
      if (!(months >= 1 && months <= MAX_GIFT_DURATION_MONTHS)) throw licenseError('duration_invalid', 400);
      term.durationMonths = months;
    } else {
      const days = wholeNumber(body.durationDays);
      if (!(days >= 1 && days <= MAX_GIFT_DURATION_DAYS)) throw licenseError('duration_invalid', 400);
      term.durationDays = days;
    }
    const count = wholeNumber(body?.count);
    if (!(count >= 1 && count <= MAX_GIFT_CODES_PER_BATCH)) throw licenseError('count_invalid', 400);
    let redeemBy;
    if (body?.redeemBy !== undefined && body.redeemBy !== null && body.redeemBy !== '') {
      const until = parseUntil(body.redeemBy);
      if (until === undefined || until <= now()) throw licenseError('redeem_by_invalid', 400);
      redeemBy = iso(until);
    }
    return { plan: edition, ...term, count, note: str(body?.note, 500), redeemBy };
  }

  /** A live subscription Groble will charge again: auto-renewal on and not terminated. */
  function renewsAutomatically(license) {
    const end = accessEnd(license);
    if (license.status !== 'active' || end === null || now() >= end) return false;
    return autoRenewOf(license) === true && license.subscription?.status !== 'terminated';
  }

  /**
   * Frees every license of a deleted account; its email links them to the next account again.
   * `refuseActiveSubscription` checks first, in the same lock: an auto-renewing live subscription
   * is 409 subscription_active with Groble's buyer page, and nothing changes.
   */
  async function unlinkAccount(accountId, { refuseActiveSubscription = false } = {}) {
    return mutate((state) => {
      const linked = Object.values(state.licenses).filter((license) => license.accountId === accountId);
      if (refuseActiveSubscription && linked.some(renewsAutomatically)) {
        throw Object.assign(licenseError('subscription_active', 409), { extra: { manageUrl: paymentFixUrl } });
      }
      const at = new Date(now()).toISOString();
      for (const license of linked) {
        delete license.accountId;
        delete license.linkedAt;
        delete license.linkedBy;
        license.unlinkedAt = at;
        license.unlinkedBy = 'delete';
      }
      return { dirty: linked.length > 0, value: linked.length };
    });
  }

  /**
   * The principal of an account lease for a hosted service, the same shape as authenticateLease plus
   * `accountId`. The license is chosen now by purpose: `gift` a live beta key, `rau` the best live Rau
   * key; else the primary. Without a live license, `allowInactive` answers `{ keyId: null, active: false }`;
   * otherwise 401. `withRau` adds the chosen key's Rau principal (accounts.mjs adds the trial).
   */
  async function authenticateAccount(accountId, { deviceId, platform, purpose, allowInactive = false, withRau = false } = {}) {
    const live = await liveLinked(accountId);
    const choices = {
      gift: () => live.find((entry) => tierOf(entry.license) === 'beta'),
      rau: () => live.find((entry) => entry.rau),
    };
    const chosen = (Object.hasOwn(choices, purpose) ? choices[purpose]() : undefined) ?? live[0];
    if (!chosen && !allowInactive) throw licenseError('unauthorized', 401);
    const license = chosen?.license;
    return {
      keyId: license?.keyId ?? null,
      deviceId,
      platform,
      source: license?.source ?? null,
      tier: license ? tierOf(license) : 'paid',
      edition: license ? editionOf(license) ?? null : null,
      active: Boolean(chosen),
      accountId,
      ...(withRau ? { rau: chosen?.rau ?? null } : {}),
    };
  }

  // -------------------------------------------------------- grandfather

  async function grandfather(body) {
    if (grandfatherCutoff === undefined) throw licenseError('grandfather_disabled', 403);
    const installId = typeof body?.installId === 'string' ? body.installId.trim().toLowerCase() : '';
    if (!INSTALL_ID_RE.test(installId)) throw licenseError('install_id_invalid', 400);
    const digest = uniqueInstallDigest(installId);
    const installs = (await uniqueInstallsStore?.read())?.installs ?? {};
    const install = installs[digest];
    const firstSeen = parseTime(install?.firstSeenAt);
    const eligible = install && firstSeen !== undefined && firstSeen < grandfatherCutoff
      && (!grandfatherPlatforms.length || grandfatherPlatforms.includes(install.os));
    return mutate(async (state) => {
      const existingId = state.grandfathered[digest];
      if (existingId && state.licenses[existingId]) {
        const license = state.licenses[existingId];
        if (license.status === 'revoked') throw licenseError('revoked', 403);
        return { dirty: false, value: { ok: true, key: license.key, created: false } };
      }
      if (!eligible) throw licenseError('not_eligible', 403);
      const license = createLicense(state, {
        source: 'grandfather',
        installDigest: digest,
        occurredAt: install.firstSeenAt,
        amount: 0,
      });
      state.grandfathered[digest] = license.keyId;
      return { value: { ok: true, key: license.key, created: true } };
    });
  }

  // -------------------------------------------------------------- admin

  /** `{years}` (1..10) or `{until}` (YYYY-MM-DD = end of that KST day, or ISO-8601). */
  function parseTerm(body, { allowNone = false } = {}) {
    const hasYears = body?.years !== undefined && body.years !== true;
    const hasUntil = body?.until !== undefined && body.until !== true;
    if (hasYears && hasUntil) throw licenseError('term_conflict', 400);
    if (hasUntil) {
      const until = parseUntil(body.until);
      if (until === undefined) throw licenseError('until_invalid', 400);
      return { until };
    }
    if (hasYears) {
      const years = typeof body.years === 'string' ? Number(body.years) : body.years;
      if (!Number.isInteger(years) || years < 1 || years > MAX_EXTEND_YEARS) throw licenseError('years_invalid', 400);
      return { years };
    }
    if (body?.years === true || body?.until === true) throw licenseError('term_invalid', 400);
    return allowNone ? null : { years: 1 };
  }

  /** Live annual keys with the held renewal's buyer email, for the dashboard's key picker. */
  function renewalCandidates(state, order) {
    const email = order.email?.toLowerCase();
    if (!email) return [];
    return Object.values(state.licenses)
      .filter((l) => tierOf(l) === 'paid' && l.status !== 'revoked' && expiryOf(l) !== null && l.email?.toLowerCase() === email)
      .sort((a, b) => String(b.expiresAt).localeCompare(String(a.expiresAt)))
      .slice(0, 5)
      .map((l) => ({ keyId: l.keyId, key: l.key, expiresAt: l.expiresAt }));
  }

  function requireAdmin(token) {
    if (!tokenEquals(token, adminToken)) throw licenseError('forbidden', 403);
  }

  const admin = {
    async issue(token, body) {
      requireAdmin(token);
      const email = str(body?.email, 254);
      if (email && !EMAIL_RE.test(email)) throw licenseError('email_invalid', 400);
      const merchantUid = str(body?.merchantUid, 128);
      const ref = str(body?.ref, 128);
      if (ref && !REF_RE.test(ref)) throw licenseError('ref_invalid', 400);
      const sendEmail = body?.sendEmail === true;
      if (body?.edition !== undefined && body.edition !== 'signature') throw licenseError('edition_invalid', 400);
      const signature = body?.edition === 'signature';
      // `years` or `until` makes a subscription key (a backfilled subscription order); neither means lifetime.
      const term = parseTerm(body, { allowNone: true });
      if (signature && term) throw licenseError('term_conflict', 400);
      let updatesUntilMs;
      if (signature && body?.updatesUntil !== undefined && body.updatesUntil !== true) {
        updatesUntilMs = parseUntil(body.updatesUntil);
        if (updatesUntilMs === undefined) throw licenseError('until_invalid', 400);
      }
      return mutate(async (state) => {
        if (merchantUid && state.orders[merchantUid]?.keyId) {
          const license = state.licenses[state.orders[merchantUid].keyId];
          return { dirty: false, value: { ok: true, created: false, license: licenseView(license) } };
        }
        if (merchantUid && state.orders[merchantUid]?.status === 'refunded') {
          throw licenseError('order_refunded', 409);
        }
        if (ref && state.refs[ref] && state.refs[ref] !== merchantUid) throw licenseError('ref_taken', 409);
        const license = createLicense(state, {
          source: 'manual',
          merchantUid,
          ref,
          email,
          amount: num(body?.amount),
          note: str(body?.note, 500),
          occurredAt: str(body?.occurredAt, 64),
          ...(term ? {
            expiresAt: iso(term.until ?? subscriptionEnd(now(), 12 * term.years)),
            subscription: { productId: subscriptionProductIds[0], status: 'active', autoRenew: true, manual: true },
          } : {}),
          ...(signature ? signatureEntitlement(str(body?.productId, 128) ?? signatureProductIds[0], now(), updatesUntilMs) : {}),
        });
        if (sendEmail) queueEmail(license);
        else license.emailDelivery = { status: 'manual' };
        if (merchantUid) {
          const order = state.orders[merchantUid] ?? { merchantUid, createdAt: license.createdAt };
          state.orders[merchantUid] = order;
          Object.assign(order, { status: 'issued', keyId: license.keyId, source: order.source ?? 'manual' });
          if (ref) order.ref = order.ref ?? ref;
          if (email) order.email = order.email ?? email;
          delete order.holdReason;
        }
        if (ref) state.refs[ref] = merchantUid ?? `manual:${license.keyId}`;
        if (ref && !merchantUid) {
          state.orders[`manual:${license.keyId}`] = { merchantUid: `manual:${license.keyId}`, status: 'issued', keyId: license.keyId, ref, source: 'manual' };
        }
        return { value: { ok: true, created: true, license: licenseView(license) } };
      });
    },
    /** Beta-tester key: same format and flow as a paid key, more devices, shorter lease, never emailed. */
    async issueBeta(token, body) {
      requireAdmin(token);
      const name = str(body?.name, 100);
      if (!name) throw licenseError('name_required', 400);
      const email = str(body?.email, 254);
      if (email && !EMAIL_RE.test(email)) throw licenseError('email_invalid', 400);
      let deviceLimit = BETA_DEVICE_LIMIT;
      if (body?.devices !== undefined) {
        const devices = typeof body.devices === 'string' && body.devices.trim() ? Number(body.devices) : body.devices;
        if (!Number.isInteger(devices)) throw licenseError('devices_invalid', 400);
        deviceLimit = Math.min(BETA_DEVICE_LIMIT_MAX, Math.max(1, devices));
      }
      return mutate(async (state) => {
        const license = createLicense(state, {
          source: 'beta',
          tier: 'beta',
          name,
          email,
          deviceLimit,
          amount: 0,
          note: str(body?.note, 500),
        });
        license.emailDelivery = { status: 'manual' };
        return { value: { ok: true, created: true, license: licenseView(license) } };
      });
    },
    async betas(token) {
      requireAdmin(token);
      const state = await read();
      const list = Object.values(state.licenses)
        .filter((l) => tierOf(l) === 'beta')
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map((l) => ({
          keyId: l.keyId,
          key: l.key,
          name: l.name,
          status: l.status,
          deviceLimit: deviceLimitOf(l),
          devicesUsed: Object.keys(l.devices ?? {}).length,
          devices: Object.entries(l.devices ?? {}).map(([deviceId, d]) => ({ deviceId, platform: d.platform, lastSeenAt: d.lastSeenAt })),
          createdAt: l.createdAt,
          revokedAt: l.revokedAt,
        }));
      return { ok: true, count: list.length, betas: list };
    },
    async lookup(token, query) {
      requireAdmin(token);
      const state = await read();
      let matches = [];
      const direct = findLicense(state, query);
      if (direct) matches = [direct];
      else if (query.email) {
        const needle = query.email.trim().toLowerCase();
        matches = Object.values(state.licenses).filter((l) => l.email?.toLowerCase() === needle);
      } else if (query.ref && state.refs[query.ref]) {
        const license = findLicense(state, { merchantUid: state.refs[query.ref] });
        if (license) matches = [license];
      }
      const orders = matches.map((l) => (l.merchantUid ? state.orders[l.merchantUid] : undefined)).filter(Boolean);
      if (query.merchantUid && state.orders[query.merchantUid] && !orders.includes(state.orders[query.merchantUid])) {
        orders.push(state.orders[query.merchantUid]);
      }
      return { ok: true, licenses: matches.map((l) => licenseView(l)), orders };
    },
    async signatures(token) {
      requireAdmin(token);
      const state = await read();
      const list = Object.values(state.licenses)
        .filter((l) => l.edition === 'signature')
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map((l) => ({
          email: l.email,
          keyId: l.keyId,
          key: l.key,
          edition: 'signature',
          createdAt: l.createdAt,
          updatesUntil: l.updatesUntil,
          status: l.status,
          prioritySupport: l.status === 'active',
        }));
      return { ok: true, count: list.length, signatures: list };
    },
    async orders(token, { status, contentId } = {}) {
      requireAdmin(token);
      const state = await read();
      const list = Object.values(state.orders)
        .filter((o) => !status || o.status === status)
        .filter((o) => !contentId || o.contentId === contentId)
        .sort((a, b) => String(b.lastEventAt ?? b.createdAt).localeCompare(String(a.lastEventAt ?? a.createdAt)))
        .slice(0, 200);
      return { ok: true, count: list.length, orders: list };
    },
    /** Rejected and held Groble webhooks, newest first. */
    async webhooks(token, { kind, limit } = {}) {
      requireAdmin(token);
      if (kind && kind !== 'rejected' && kind !== 'held') throw licenseError('kind_invalid', 400);
      return webhookLog.list({ kind, limit });
    },
    async release(token, body) {
      requireAdmin(token);
      const merchantUid = str(body?.merchantUid, 128);
      return mutate(async (state) => {
        const order = merchantUid ? state.orders[merchantUid] : undefined;
        if (!order) throw licenseError('order_not_found', 404);
        if (order.keyId) return { dirty: false, value: { ok: true, created: false, license: licenseView(state.licenses[order.keyId]) } };
        if (order.status === 'refunded') throw licenseError('order_refunded', 409);
        // A held renewal belongs to an existing key: `extend` that key instead of issuing a new one.
        if (order.kind === 'renewal') throw licenseError('renewal_use_extend', 409);
        const license = createLicense(state, {
          source: 'groble',
          merchantUid,
          ref: order.ref,
          email: order.email,
          amount: order.amount,
          occurredAt: order.completedAt,
          note: `released from hold: ${order.holdReason ?? ''}`.trim(),
          ...(order.kind === 'subscription' ? subscriptionStart(order) : {}),
          ...(order.kind === 'subscription' ? planEntitlement(catalog.get(order.contentId), order.billingCycleMonths ?? SUBSCRIPTION_CYCLE_MONTHS) : {}),
          ...(catalog.get(order.contentId)?.kind === 'signature'
            ? signatureEntitlement(order.contentId, paidAtOf(order))
            : {}),
        });
        queueEmail(license);
        order.status = 'issued';
        order.keyId = license.keyId;
        order.releasedHoldReason = order.holdReason;
        delete order.holdReason;
        return { value: { ok: true, created: true, license: licenseView(license) } };
      });
    },
    async revoke(token, body) {
      requireAdmin(token);
      return mutate(async (state) => {
        const license = findLicense(state, body ?? {});
        if (!license) throw licenseError('invalid_key', 404);
        const changed = revoke(license, `admin:${str(body?.reason, 200) ?? 'manual'}`);
        return { dirty: changed, value: { ok: true, changed, license: licenseView(license) } };
      });
    },
    async restore(token, body) {
      requireAdmin(token);
      return mutate(async (state) => {
        const license = findLicense(state, body ?? {});
        if (!license) throw licenseError('invalid_key', 404);
        license.status = 'active';
        license.restoredAt = new Date(now()).toISOString();
        return { value: { ok: true, license: licenseView(license) } };
      });
    },
    async resetDevices(token, body) {
      requireAdmin(token);
      return mutate(async (state) => {
        const license = findLicense(state, body ?? {});
        if (!license) throw licenseError('invalid_key', 404);
        license.devices = {};
        return { value: { ok: true, license: licenseView(license) } };
      });
    },
    /**
     * Extend a subscription key: `years` from its expiry (or from now when it lapsed), or set it to
     * `until`. Lifetime keys have nothing to extend. A Signature key is lifetime; years or until on it conflicts.
     * Every extension is kept on the license.
     */
    async extend(token, body) {
      requireAdmin(token);
      const term = parseTerm(body);
      return mutate(async (state) => {
        const license = findLicense(state, body ?? {});
        if (!license) throw licenseError('invalid_key', 404);
        if (license.edition === 'signature') {
          if (body?.years !== undefined || body?.until !== undefined) throw licenseError('term_conflict', 400);
          throw licenseError('lifetime_key', 409);
        }
        const before = expiryOf(license);
        if (before === null) throw licenseError('lifetime_key', 409);
        const to = term.until ?? subscriptionEnd(Math.max(before, now()), 12 * term.years);
        license.expiresAt = iso(to);
        license.extensions = Array.isArray(license.extensions) ? license.extensions : [];
        license.extensions.push({
          at: new Date(now()).toISOString(),
          from: iso(before),
          to: license.expiresAt,
          ...(term.years ? { years: term.years } : {}),
          note: str(body?.note, 200),
        });
        return { value: { ok: true, previousExpiresAt: iso(before), license: licenseView(license) } };
      });
    },
    /** Frees a key from its account. The owner's email no longer links it back on its own; `linkAccount` or a redeem does. */
    async unlinkAccount(token, body) {
      requireAdmin(token);
      return mutate(async (state) => {
        const license = findLicense(state, { keyId: str(body?.keyId, 64), key: body?.key });
        if (!license) throw licenseError('invalid_key', 404);
        const changed = Boolean(license.accountId);
        if (changed) {
          delete license.accountId;
          delete license.linkedAt;
          delete license.linkedBy;
          license.unlinkedAt = new Date(now()).toISOString();
          license.unlinkedBy = 'admin';
        }
        return { dirty: changed, value: { ok: true, changed, license: licenseView(license) } };
      });
    },
    /** Links a key to an account the caller checked exists, moving it from any other account. */
    async linkAccount(token, body) {
      requireAdmin(token);
      const accountId = str(body?.accountId, 64);
      if (!accountId) throw licenseError('account_not_found', 404);
      return mutate(async (state) => {
        const license = findLicense(state, { keyId: str(body?.keyId, 64), key: body?.key });
        if (!license) throw licenseError('invalid_key', 404);
        const previousAccountId = license.accountId ?? null;
        linkLicense(license, accountId, 'admin');
        return { value: { ok: true, previousAccountId, license: licenseView(license) } };
      });
    },
    /** Free one device slot without touching the key's other devices. */
    async removeDevice(token, body) {
      requireAdmin(token);
      const deviceId = str(body?.deviceId, 128);
      return mutate(async (state) => {
        const license = findLicense(state, { key: body?.key, keyId: str(body?.keyId, 64) });
        if (!license) throw licenseError('invalid_key', 404);
        if (!deviceId || !license.devices || !Object.hasOwn(license.devices, deviceId)) throw licenseError('device_not_found', 404);
        delete license.devices[deviceId];
        return { value: { ok: true, license: licenseView(license) } };
      });
    },
    /** Paid (non-beta) keys, newest first, with their devices, term and email delivery. */
    async customers(token) {
      requireAdmin(token);
      const state = await read();
      const nowMs = now();
      const list = Object.values(state.licenses)
        .filter((l) => tierOf(l) === 'paid')
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map((l) => customerView(l, nowMs, paymentGraceMaxMs));
      return { ok: true, count: list.length, customers: list };
    },
    /**
     * What needs the owner: held orders (release, or extend the buyer's key for a held renewal) and
     * held webhook events that hold no order (unmatched subscription events, unknown types).
     * Both stay until handled or acknowledged with `ack`.
     */
    async attention(token) {
      requireAdmin(token);
      const state = await read();
      const time = (value) => iso(parseTime(value) ?? 0);
      const items = [];
      for (const order of Object.values(state.orders)) {
        if (order.status !== 'held' || order.ackedAt) continue;
        const renewal = order.kind === 'renewal';
        items.push({
          type: 'order',
          merchantUid: order.merchantUid,
          orderKind: renewal ? 'renewal' : order.kind === 'subscription' ? 'subscription' : 'purchase',
          reason: order.holdReason,
          reasonText: heldReasonText(order.holdReason),
          email: order.email,
          amount: order.amount,
          at: time(order.lastEventAt ?? order.completedAt ?? order.createdAt),
          ...(renewal ? { candidates: renewalCandidates(state, order) } : {}),
        });
      }
      const { entries } = await webhookLog.list({ kind: 'held', limit: WEBHOOK_LOG_MAX_ENTRIES });
      for (const entry of entries) {
        if (entry.ackedAt) continue;
        // A held order is shown once, as the order. Entries from before `action` was logged fall back to the order lookup.
        if (entry.action === 'held' || (entry.action === undefined && entry.merchantUid && state.orders[entry.merchantUid])) continue;
        items.push({
          type: 'event',
          id: entry.id,
          eventType: entry.eventType,
          merchantUid: entry.merchantUid,
          reason: entry.reason,
          reasonText: heldReasonText(entry.reason),
          email: entry.buyerEmail,
          amount: entry.amount,
          at: time(entry.at),
        });
      }
      items.sort((a, b) => b.at.localeCompare(a.at));
      return { ok: true, count: items.length, items };
    },
    /** `{id}` acknowledges a held webhook event, `{merchantUid}` a held order the owner will not release. */
    async ack(token, body) {
      requireAdmin(token);
      const id = str(body?.id, 64);
      if (id) {
        if (!(await webhookLog.ack(id))) throw licenseError('event_not_found', 404);
        return { ok: true };
      }
      const merchantUid = str(body?.merchantUid, 128);
      return mutate(async (state) => {
        const order = merchantUid ? state.orders[merchantUid] : undefined;
        if (order?.status !== 'held') throw licenseError('event_not_found', 404);
        order.ackedAt = new Date(now()).toISOString();
        return { value: { ok: true } };
      });
    },
    /** Apply a held renewal round to the buyer's existing annual key, exactly as a matched webhook would. */
    async applyRenewal(token, body) {
      requireAdmin(token);
      const merchantUid = str(body?.merchantUid, 128);
      return mutate(async (state) => {
        const order = merchantUid ? state.orders[merchantUid] : undefined;
        if (!order) throw licenseError('order_not_found', 404);
        if (order.kind !== 'renewal') throw licenseError('not_a_renewal', 409);
        if (order.keyId) return { dirty: false, value: { ok: true, changed: false, license: licenseView(state.licenses[order.keyId]) } };
        if (order.status === 'refunded') throw licenseError('order_refunded', 409);
        const license = findLicense(state, { key: body?.key, keyId: str(body?.keyId, 64) });
        if (!license || tierOf(license) !== 'paid') throw licenseError('invalid_key', 404);
        if (license.status === 'revoked') throw licenseError('license_revoked', 409);
        const before = expiryOf(license);
        if (before === null) throw licenseError('lifetime_key', 409);
        license.subscription ??= { productId: order.contentId, status: 'active', autoRenew: true };
        order.releasedHoldReason = order.holdReason;
        delete order.ackedAt;
        applyRenewal(license, order);
        // Later rounds with the same ref now find this key on their own.
        linkRef(state, order.ref, order.merchantUid);
        return { value: { ok: true, changed: true, previousExpiresAt: iso(before), license: licenseView(license) } };
      });
    },
    /**
     * Issues one batch of gift codes. The answer is the only place the plaintext codes ever appear;
     * the state keeps their SHA-256 and display prefix.
     */
    async issueGiftCodes(token, body) {
      requireAdmin(token);
      const fields = parseGiftIssue(body);
      return mutate(async (state) => {
        let batchId;
        do batchId = `gcb_${random(9).toString('hex')}`; while (Object.hasOwn(state.giftCodeBatches, batchId));
        const createdAt = new Date(now()).toISOString();
        const batch = { batchId, ...fields, createdAt };
        for (const k of Object.keys(batch)) if (batch[k] === undefined) delete batch[k];
        state.giftCodeBatches[batchId] = batch;
        const codes = [];
        while (codes.length < fields.count) {
          const code = generateGiftCode(random);
          const codeHash = giftCodeHash(code);
          if (Object.hasOwn(state.giftCodes, codeHash)) continue;
          state.giftCodes[codeHash] = { codeHash, batchId, prefix: giftCodePrefix(code), status: 'active', createdAt };
          codes.push(code);
        }
        log(`[site-api] gift code batch ${batchId}: ${codes.length} ${giftPlanName(batch)} codes issued`);
        return { value: { ok: true, batch: giftBatchView(state, batch, now()), codes } };
      });
    },
    /** Batches newest first with counts and masked codes; `batchId` picks one, `status` filters the codes. */
    async giftCodes(token, { batchId, status } = {}) {
      requireAdmin(token);
      if (status && !GIFT_CODE_STATUSES.includes(status)) throw licenseError('status_invalid', 400);
      const state = await read();
      const nowMs = now();
      const batches = Object.values(state.giftCodeBatches)
        .filter((batch) => !batchId || batch.batchId === batchId)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map((batch) => giftBatchView(state, batch, nowMs, status));
      return { ok: true, count: batches.length, batches };
    },
    /**
     * `{ batchId }` revokes every unredeemed code of a batch, `{ code }` or `{ codeHash }` one code. A
     * redeemed code is 409 code_redeemed with its keyId: revoke that key instead.
     */
    async revokeGiftCodes(token, body) {
      requireAdmin(token);
      const batchId = str(body?.batchId, 64);
      const hasCode = body?.code !== undefined && body.code !== null && body.code !== '';
      const hasHash = body?.codeHash !== undefined && body.codeHash !== null && body.codeHash !== '';
      if ([Boolean(batchId), hasCode, hasHash].filter(Boolean).length !== 1) throw licenseError('target_required', 400);
      const code = hasCode ? normalizeGiftCode(body.code) : '';
      if (hasCode && !code) throw licenseError('invalid_format', 400);
      if (hasHash && !(typeof body.codeHash === 'string' && /^[0-9a-f]{64}$/.test(body.codeHash))) throw licenseError('invalid_format', 400);
      const hash = code ? giftCodeHash(code) : hasHash ? body.codeHash : null;
      const reason = str(body?.reason, 200);
      return mutate(async (state) => {
        let targets;
        if (batchId) {
          if (!Object.hasOwn(state.giftCodeBatches, batchId)) throw licenseError('batch_not_found', 404);
          targets = Object.values(state.giftCodes).filter((record) => record.batchId === batchId && record.status === 'active');
        } else {
          const record = Object.hasOwn(state.giftCodes, hash) ? state.giftCodes[hash] : undefined;
          if (!record) throw licenseError('invalid_code', 404);
          if (record.status === 'redeemed') throw Object.assign(licenseError('code_redeemed', 409), { extra: { keyId: record.keyId } });
          targets = record.status === 'active' ? [record] : [];
        }
        const at = new Date(now()).toISOString();
        for (const record of targets) Object.assign(record, { status: 'revoked', revokedAt: at, ...(reason ? { revokeReason: reason } : {}) });
        const batch = state.giftCodeBatches[batchId ?? state.giftCodes[hash].batchId];
        return { dirty: targets.length > 0, value: { ok: true, changed: targets.length, batch: giftBatchView(state, batch, now()) } };
      });
    },
    async resendEmail(token, body) {
      requireAdmin(token);
      const result = await mutate(async (state) => {
        const license = findLicense(state, body ?? {});
        if (!license) throw licenseError('invalid_key', 404);
        const email = str(body?.email, 254);
        if (email) {
          if (!EMAIL_RE.test(email)) throw licenseError('email_invalid', 400);
          license.email = email;
        }
        if (!license.email) throw licenseError('email_missing', 400);
        license.emailDelivery = { status: 'pending', queuedAt: new Date(now()).toISOString(), resend: true };
        return { value: { ok: true, keyId: license.keyId } };
      });
      return { ...result, delivery: await deliverPendingEmails() };
    },
  };

  return {
    handleGrobleEvent,
    deliverPendingEmails,
    statusByRef,
    activate,
    validate,
    deactivate,
    grandfather,
    authenticateLease,
    accountEntitlements,
    accountLicensesView,
    linkByEmail,
    redeemForAccount,
    claimForAccount,
    redeemGiftCode,
    unlinkAccount,
    authenticateAccount,
    admin,
  };
}
