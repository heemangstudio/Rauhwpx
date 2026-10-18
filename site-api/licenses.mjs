import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

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
import { createWebhookLog } from './webhook-log.mjs';

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

export function emptyLicensesState() {
  return { licenses: {}, keyIndex: {}, orders: {}, refs: {}, webhookEvents: {}, grandfathered: {} };
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
    note: license.note,
    devices: Object.entries(license.devices ?? {}).map(([deviceId, d]) => ({ deviceId, ...d })),
    emailDelivery: license.emailDelivery,
  };
}

/**
 * License key service. Every mutation runs under one in-process lock and saves
 * the whole state through the atomic file store, so concurrent requests never
 * interleave read-modify-write cycles. Assumes ONE Railway replica.
 */
export function createLicensesService({
  store = createMemoryStore(emptyLicensesState()),
  uniqueInstallsStore,
  now = Date.now,
  random = randomBytes,
  signingKey = null,
  leaseKid = DEFAULT_LEASE_KID,
  emailProvider,
  grobleContentId = 'uRshdR',
  expectedPrice = 9900,
  minAmount = expectedPrice,
  grandfatherCutoff = undefined,
  grandfatherPlatforms = ['darwin'],
  adminToken = '',
  downloadUrl = 'https://heemangstudios.com/',
  webhookLog = createWebhookLog({ now }),
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  let mutation = Promise.resolve();
  function withLock(fn) {
    const result = mutation.then(fn, fn);
    mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  async function mutate(fn) {
    return withLock(async () => {
      const state = normalizeState(await store.load());
      const result = await fn(state);
      if (result?.dirty !== false) await store.save(state);
      return result?.value ?? result;
    });
  }

  async function read() {
    await mutation.catch(() => {});
    return normalizeState(await store.load());
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

  function findLicense(state, { key, keyId, merchantUid } = {}) {
    if (keyId && state.licenses[keyId]) return state.licenses[keyId];
    const normalized = normalizeLicenseKey(key);
    if (normalized && state.keyIndex[normalized]) return state.licenses[state.keyIndex[normalized]];
    if (merchantUid && state.orders[merchantUid]?.keyId) return state.licenses[state.orders[merchantUid].keyId];
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

  function checkPurchase(object) {
    const contentId = str(object?.content?.id, 128);
    const paymentType = str(object?.content?.paymentType, 32);
    const finalAmount = num(object?.pricing?.finalAmount);
    const originalAmount = num(object?.pricing?.originalAmount);
    if (grobleContentId && contentId !== grobleContentId) return `wrong_product:${contentId ?? 'missing'}`;
    if (paymentType && paymentType !== 'ONE_TIME') return `wrong_payment_type:${paymentType}`;
    if (str(object?.pricing?.currency, 8) && object.pricing.currency !== 'KRW') return 'wrong_currency';
    if (finalAmount === undefined) return 'missing_amount';
    if (originalAmount !== undefined && originalAmount !== expectedPrice) return `wrong_price:${originalAmount}`;
    if (finalAmount < minAmount) return `amount_below_minimum:${finalAmount}`;
    return null;
  }

  function onCompleted(state, event, object, occurredMs) {
    const merchantUid = object.merchantUid;
    const ref = str(object.sellerReference, 128);
    const email = str(object?.buyer?.email, 254);
    const order = state.orders[merchantUid] ?? { merchantUid, createdAt: new Date(now()).toISOString() };
    state.orders[merchantUid] = order;
    Object.assign(order, {
      ref: order.ref ?? (ref && REF_RE.test(ref) ? ref : undefined),
      email: order.email ?? email,
      contentId: str(object?.content?.id, 128),
      amount: num(object?.pricing?.finalAmount),
      originalAmount: num(object?.pricing?.originalAmount),
      couponCode: str(object?.pricing?.coupon?.code, 64),
      purchasedAt: str(object?.payment?.purchasedAt, 64),
      completedAt: event.occurredAt,
      completedEventId: str(event.id, 128),
    });
    for (const k of Object.keys(order)) if (order[k] === undefined) delete order[k];
    linkRef(state, order.ref, merchantUid);

    if (order.keyId) {
      // Already issued (webhook retry with a new delivery key, or a manual backfill). Attach data only.
      const license = state.licenses[order.keyId];
      if (license) {
        license.ref = license.ref ?? order.ref;
        license.email = license.email ?? email;
        license.amount = license.amount ?? order.amount;
        license.occurredAt = license.occurredAt ?? event.occurredAt;
      }
      return { action: 'already_issued', keyId: order.keyId };
    }
    if (order.status === 'refunded') {
      // Refund arrived before the completion (Groble does not guarantee order). Never issue.
      return { action: 'refunded_before_completed' };
    }
    const problem = checkPurchase(object);
    if (problem) {
      order.status = 'held';
      order.holdReason = problem;
      log(`[site-api] groble order ${merchantUid} held: ${problem}`);
      return { action: 'held', reason: problem };
    }
    const license = createLicense(state, {
      source: 'groble',
      merchantUid,
      ref: order.ref,
      email,
      amount: order.amount,
      occurredAt: event.occurredAt,
    });
    queueEmail(license);
    order.status = 'issued';
    order.keyId = license.keyId;
    delete order.holdReason;
    return { action: 'issued', keyId: license.keyId };
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
    order.status = 'refunded';
    order.refundedAt = refundedAt;
    const license = order.keyId ? state.licenses[order.keyId] : undefined;
    if (license) revoke(license, `groble_refund:${refundedAt}`);
    return { action: license ? 'revoked' : 'refund_recorded_no_key', keyId: license?.keyId };
  }

  /** Process one verified Groble event. Returns a small summary (never buyer data). */
  async function handleGrobleEvent(event, { idempotencyKey } = {}) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw licenseError('webhook_payload_invalid', 400);
    }
    const type = str(event.type, 64);
    const object = event?.data?.object;
    return mutate(async (state) => {
      pruneWebhookEvents(state);
      const dedupeKey = idempotencyKey || (event.id ? `event:${event.id}` : '');
      if (dedupeKey && state.webhookEvents[dedupeKey]) {
        return { dirty: false, value: { duplicate: true, action: state.webhookEvents[dedupeKey].action } };
      }
      let result;
      const handled = ['payment.completed', 'payment.cancel_requested', 'payment.refunded'];
      if (!handled.includes(type)) {
        result = { action: 'ignored_event_type' };
      } else if (!object || typeof object !== 'object' || !str(object.merchantUid, 128)) {
        result = { action: 'ignored_missing_merchant_uid' };
      } else {
        object.merchantUid = str(object.merchantUid, 128);
        const occurredMs = parseTime(event.occurredAt) ?? now();
        if (type === 'payment.completed') result = onCompleted(state, event, object, occurredMs);
        else if (type === 'payment.cancel_requested') result = onCancelRequested(state, event, object);
        else result = onRefunded(state, event, object);
        const order = state.orders[object.merchantUid];
        const last = parseTime(order.lastEventAt);
        if (last === undefined || occurredMs > last) order.lastEventAt = new Date(occurredMs).toISOString();
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
      const message = licenseEmail({ key: license.key, kind: licenseEmailKind(license), downloadUrl });
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
    if (license?.status === 'active') return { status: 'issued', key: license.key };
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
    return license;
  }

  /** `submittedKey` is what the app sent; the lease's keyHash is over the app's normalization of it. */
  function leaseResponse(license, deviceId, submittedKey) {
    const { lease, payload } = signLease({
      kid: leaseKid,
      keyId: license.keyId,
      key: submittedKey,
      deviceId,
      now: now(),
      ttlMs: tierOf(license) === 'beta' ? BETA_LEASE_TTL_MS : LEASE_TTL_MS,
    }, signingKey);
    return {
      ok: true,
      lease,
      keyId: license.keyId,
      tier: tierOf(license),
      expiresAt: payload.expiresAt,
      devicesUsed: Object.keys(license.devices).length,
      deviceLimit: deviceLimitOf(license),
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
      return { value: leaseResponse(license, deviceId, body.key) };
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
      return { value: leaseResponse(license, deviceId, body.key) };
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
   * Returns `{ keyId, deviceId, platform, source }`; anything else is `unauthorized` (401).
   */
  async function authenticateLease(lease) {
    if (!signingKey) throw licenseError('unauthorized', 401);
    leasePublicKeys ??= { [leaseKid]: publicKeyFromPrivate(signingKey) };
    const checked = verifyLease(lease, leasePublicKeys, { now: now() });
    if (!checked.ok) throw licenseError('unauthorized', 401);
    const { keyId, deviceId, keyHash } = checked.payload;
    const state = await read();
    const license = Object.hasOwn(state.licenses, keyId) ? state.licenses[keyId] : undefined;
    const device = license?.devices && Object.hasOwn(license.devices, deviceId) ? license.devices[deviceId] : undefined;
    if (!license || license.status !== 'active' || !device || licenseKeyHash(license.key) !== keyHash) {
      throw licenseError('unauthorized', 401);
    }
    return { keyId, deviceId, platform: device.platform, source: license.source };
  }

  // -------------------------------------------------------- grandfather

  async function grandfather(body) {
    if (grandfatherCutoff === undefined) throw licenseError('grandfather_disabled', 403);
    const installId = typeof body?.installId === 'string' ? body.installId.trim().toLowerCase() : '';
    if (!INSTALL_ID_RE.test(installId)) throw licenseError('install_id_invalid', 400);
    const digest = uniqueInstallDigest(installId);
    const installs = (await uniqueInstallsStore?.load())?.installs ?? {};
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
    async orders(token, { status } = {}) {
      requireAdmin(token);
      const state = await read();
      const list = Object.values(state.orders)
        .filter((o) => !status || o.status === status)
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
        const license = createLicense(state, {
          source: 'groble',
          merchantUid,
          ref: order.ref,
          email: order.email,
          amount: order.amount,
          occurredAt: order.completedAt,
          note: `released from hold: ${order.holdReason ?? ''}`.trim(),
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
    admin,
  };
}
