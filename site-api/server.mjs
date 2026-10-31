import { readFile, readdir, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_AVATAR_BYTES, accountError, accountIdForEmail, createAccountsService, emptyAccountsState } from './accounts.mjs';
import { createFileAvatars, createPostgresAvatars } from './avatars.mjs';
import {
  DEFAULT_PORT,
  resolveAccountConfig,
  resolveAccountsDbPath,
  resolveAvatarDir,
  resolveDataDir,
  resolveDatabaseUrl,
  resolveFeedbackDir,
  resolveFeedbackMaxBytes,
  resolveFeedbackProofKey,
  resolveGiftConfig,
  resolveGiftsDbPath,
  resolveHamaConfig,
  resolveHamaDbPath,
  resolveHamaUsageDir,
  resolveLicenseConfig,
  resolveLicensesDbPath,
  resolveRauConfig,
  resolveRauDbPath,
  resolveUniqueInstallPingKey,
  resolveUniqueInstallsDbPath,
  resolveWaitlistDbPath,
  resolveWebhookLogDbPath,
  resolveDownloadsDbPath,
} from './config.mjs';
import { createDatabase } from './db.mjs';
import {
  DEFAULT_FEEDBACK_PROOF_KEY,
  MAX_FEEDBACK_BODY_BYTES,
  createFeedbackService,
  emptyFeedbackIndex,
  feedbackError,
} from './feedback.mjs';
import { GIFT_PROXY_PREFIX, createGiftsService, emptyGiftsState, parseGiftAmount } from './gifts.mjs';
import { verifyGrobleWebhook } from './groble-webhook.mjs';
import { HAMA_ANTHROPIC_PREFIX, HAMA_OPENAI_PREFIX, createHamaService, emptyHamaState } from './hama.mjs';
import { createHamaProxy } from './hama-proxy.mjs';
import { createFileUsageLog, createPostgresUsageLog } from './hama-usage.mjs';
import { createHeldAlerter } from './held-alert.mjs';
import { createEmailProvider, resendProviderFromEnv } from './license-email.mjs';
import { parseSigningPrivateKey, publicKeyFromPrivate, rawPublicKeyBase64 } from './license-lease.mjs';
import { createLicensesService, emptyLicensesState, licenseError } from './licenses.mjs';
import { accountsMapper } from './mappers/accounts.mjs';
import { downloadsMapper } from './mappers/downloads.mjs';
import { feedbackMapper } from './mappers/feedback.mjs';
import { giftsMapper } from './mappers/gifts.mjs';
import { hamaMapper } from './mappers/hama.mjs';
import { licensesMapper } from './mappers/licenses.mjs';
import { rauMapper } from './mappers/rau.mjs';
import { uniqueInstallsMapper } from './mappers/unique-installs.mjs';
import { waitlistMapper } from './mappers/waitlist.mjs';
import { webhookLogMapper } from './mappers/webhook-log.mjs';
import { renderAccountLoginErrorPage, renderUniqueInstallsPage } from './pages.mjs';
import { createPostgresStore } from './pg-store.mjs';
import { MAX_RAU_BODY_BYTES, createRauService, emptyRauState, rauRateLimited } from './rau.mjs';
import { createRateLimiter } from './rate-limit.mjs';
import { createFileStore } from './store.mjs';
import { createTelegramSender } from './telegram.mjs';
import {
  DEFAULT_UNIQUE_INSTALL_PING_KEY,
  createUniqueInstallsService,
  emptyUniqueInstallsState,
} from './unique-installs.mjs';
import { createWaitlistService, emptyWaitlistState } from './waitlist.mjs';
import { createDownloadsService, emptyDownloadsState } from './downloads.mjs';
import { createWebhookAlerter } from './webhook-alert.mjs';
import { createWebhookLog, emptyWebhookLogState, heldEventDetails, webhookLogEntry } from './webhook-log.mjs';
import { createWorkOSClient } from './workos.mjs';

const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
const MINUTE = 60 * 1000;
const TEN_MINUTES = 10 * MINUTE;
const HOUR = 60 * MINUTE;
const FEEDBACK_PER_IP_PER_HOUR = 20;
// Issue-report bodies one replica holds at once; each can buffer up to MAX_FEEDBACK_BODY_BYTES.
const MAX_FEEDBACK_UPLOADS = 3;
// Groble retries 408/429/5xx for about 44 hours and treats any other 4xx as final.
// Anything that fails before the signature matches answers 503: a stranger loses nothing,
// and a real sale we failed to verify (secret mismatch, missing secret, stripped headers)
// keeps arriving until we fix it. Once the signature matches, the request is Groble's, so
// a stale timestamp (replay) and an unreadable body are final.
const WEBHOOK_REJECT_STATUS = {
  not_configured: 503,
  missing_headers: 503,
  bad_timestamp: 503,
  bad_signature: 503,
  body_too_large: 503,
  timestamp_out_of_window: 401,
  json_invalid: 400,
  payload_invalid: 400,
  store_error: 500,
};
// Rejections that get recorded and alerted. Past this a forger gets 429 and costs no disk write.
const WEBHOOK_REJECTS_PER_IP = 30;
const WEBHOOK_REJECTS_TOTAL = 300;
const RAU_ICON_PATH = fileURLToPath(new URL('./public/rau.png', import.meta.url));

function siteError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rateLimitedError() {
  return siteError('RATE_LIMITED', '요청이 너무 많아요. 잠시 후 다시 시도해 주세요');
}

function bearerToken(req) {
  const match = String(req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

async function readRaw(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw siteError('BODY_TOO_LARGE', '요청 본문이 너무 커요');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readRaw(req, MAX_JSON_BODY_BYTES);
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    throw siteError('JSON_INVALID', '요청 본문을 읽을 수 없어요');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw siteError('JSON_INVALID', '요청 본문을 읽을 수 없어요');
  }
  return parsed;
}

/** Railway 엣지가 덧붙이는 마지막 XFF 홉이 실제 접속 주소다. 첫 홉은 클라이언트가 위조할 수 있다. */
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const hops = forwarded.split(',').map((hop) => hop.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Reads a large upload without destroying the socket on overflow: an oversized body is
 * discarded to its end so the client can still read the 413, unless it runs past twice the
 * limit, which closes the connection.
 */
function readUpload(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * maxBytes) req.destroy();
      else if (size <= maxBytes) chunks.push(chunk);
      else chunks.length = 0;
    });
    req.on('end', () => (size > maxBytes ? reject(feedbackError('too_large', 413)) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
    req.on('close', () => { if (!req.complete) reject(feedbackError('too_large', 413)); });
  });
}

/** Discards an upload we refuse unread so the client can still read the answer; a body past maxBytes closes the connection. */
function discardUpload(req, maxBytes) {
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxBytes) req.destroy();
  });
  req.resume();
}

/** Reads up to `maxBytes`; past it the rest is drained and the answer is null, so the client still reads the reply. */
async function readOrNull(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= maxBytes) chunks.push(chunk);
  }
  return size > maxBytes ? null : Buffer.concat(chunks);
}

function errorStatus(error) {
  if ((error?.licenseError || error?.expose) && Number.isInteger(error.status)) return error.status;
  if (error?.code === 'RATE_LIMITED') return 429;
  if (error?.code === 'BODY_TOO_LARGE') return 413;
  if (error?.code === 'WAITLIST_FORBIDDEN' || error?.code === 'DOWNLOADS_FORBIDDEN') return 403;
  if (error?.code === 'UNIQUE_INSTALLS_CAPACITY_EXCEEDED'
    || error?.code === 'WAITLIST_CAPACITY_EXCEEDED') return 503;
  if (error?.code === 'ERR_INVALID_URL' || error?.code?.endsWith?.('_INVALID')) return 400;
  return 500;
}

function securityHeaders(isHtml) {
  const common = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
  if (!isHtml) return common;
  return {
    ...common,
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY',
  };
}

/** Account routes answer `{ ok:false, error }` for unreadable bodies too. */
async function readAccountJson(req) {
  try {
    return await readJson(req);
  } catch (error) {
    if (error?.code === 'BODY_TOO_LARGE') throw accountError('too_large', 413);
    if (error?.code === 'JSON_INVALID') throw accountError('invalid', 400, { field: 'body' });
    throw error;
  }
}

/**
 * Basic was called Pro until 2026-10-31. An app that sends `X-Hama-Plan-Names: basic` hears the new
 * names; every other client (shipped apps, the website) still hears `edition: 'pro'` and
 * `rau_requires_pro`, the names it matches on.
 */
export const PLAN_NAMES_HEADER = 'x-hama-plan-names';

function acceptsBasicPlanName(req) {
  return String(req.headers?.[PLAN_NAMES_HEADER] ?? '').toLowerCase().split(',').some((name) => name.trim() === 'basic');
}

export function legacyPlanNames(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const out = { ...body };
  if (out.edition === 'basic') out.edition = 'pro';
  if (out.error === 'rau_requires_basic') out.error = 'rau_requires_pro';
  if (out.reason === 'rau_requires_basic') out.reason = 'rau_requires_pro';
  return out;
}

export function siteRequestListener({
  uniqueInstalls,
  waitlist,
  downloads,
  licenses,
  accounts,
  gifts,
  hama,
  rau,
  feedback,
  licenseConfig = {},
  webhookLog = createWebhookLog(),
  webhookAlerts = createWebhookAlerter({ log: () => {} }),
  heldAlerts = createHeldAlerter({ log: () => {} }),
  storage = 'files',
  log = () => {},
}) {
  const limiter = createRateLimiter();
  let feedbackUploads = 0;
  const allowedOrigins = new Set(licenseConfig.allowedOrigins ?? []);
  // Work that must never delay or fail a response: runs after it is sent.
  const later = (fn) => setImmediate(() => {
    void Promise.resolve().then(fn).catch((error) => log(`[site-api] background task failed: ${error?.stack ?? error}`));
  });
  return async (req, res) => {
    const ip = clientIp(req);
    const planNames = acceptsBasicPlanName(req) ? (body) => body : legacyPlanNames;
    // 웹사이트는 text/plain 으로 보내 preflight 없이 다른 origin 에서 호출한다.
    let cors = {};
    const send = (status, body, headers = {}) => {
      const isHtml = typeof body === 'string';
      res.writeHead(status, {
        'Content-Type': isHtml ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
        ...securityHeaders(isHtml),
        ...cors,
        ...headers,
      });
      res.end(isHtml ? body : JSON.stringify(planNames(body)));
    };
    const allow = (bucket, max, windowMs) => {
      if (limiter.check(`${bucket}:${ip}`, max, windowMs)) return;
      req.resume?.();
      throw rateLimitedError();
    };
    const allowAccount = (bucket, max, windowMs) => {
      if (limiter.check(`${bucket}:${ip}`, max, windowMs)) return;
      req.resume?.();
      throw accountError('rate_limited', 429);
    };
    const rejectWebhook = (reason, { verified = false, rawBody } = {}) => {
      const status = WEBHOOK_REJECT_STATUS[reason] ?? 503;
      log(`[site-api] groble webhook rejected: ${reason} (${status})`);
      if (!limiter.check(`groble-reject:${ip}`, WEBHOOK_REJECTS_PER_IP, TEN_MINUTES)
        || !limiter.check('groble-reject:all', WEBHOOK_REJECTS_TOTAL, TEN_MINUTES)) {
        req.resume?.();
        send(429, { ok: false, error: 'rate_limited' });
        return;
      }
      send(status, { ok: false, error: reason });
      const entry = webhookLogEntry({ kind: 'rejected', reason, status, verified, headers: req.headers, rawBody });
      later(async () => {
        const saved = await webhookLog.record(entry).catch((error) => {
          log(`[site-api] webhook log write failed: ${error?.message ?? error}`);
          return { ...entry, at: new Date().toISOString() };
        });
        await webhookAlerts.notify(saved);
      });
    };
    try {
      const host = req.headers.host;
      if (typeof host === 'string' && host) {
        // Validate the untrusted Host only for request hygiene; routing always
        // uses a fixed loopback base so Host can never control URL parsing.
        new URL(`http://${host}`);
      }
      const requestTarget = typeof req.url === 'string' ? req.url : '/';
      if (!requestTarget.startsWith('/') || requestTarget.startsWith('//')) {
        throw siteError('REQUEST_TARGET_INVALID', '요청 주소가 올바르지 않아요');
      }
      const { pathname, searchParams } = new URL(requestTarget, 'http://127.0.0.1');
      const route = `${req.method} ${pathname}`;
      const feedbackRoute = pathname === '/v1/feedback' || pathname.startsWith('/v1/admin/feedback');
      if (feedbackRoute && !feedback) throw siteError('NOT_FOUND', 'not found');
      if (!feedbackRoute && (pathname.startsWith('/v1/license/') || pathname.startsWith('/v1/admin/') || pathname === '/v1/groble/webhook')) {
        if (!licenses) throw siteError('NOT_FOUND', 'not found');
      }
      if (pathname.startsWith('/v1/gift/') && !gifts) throw siteError('NOT_FOUND', 'not found');
      if ((pathname.startsWith('/v1/rau/') || pathname === '/v1/admin/rau') && !rau) throw siteError('NOT_FOUND', 'not found');
      if (pathname.startsWith(`${GIFT_PROXY_PREFIX}/`)) {
        // Streams its own response (SSE), so it never goes through send().
        allow('gift-proxy', 600, MINUTE);
        try {
          await gifts.handleProxy(req, res, pathname.slice(GIFT_PROXY_PREFIX.length));
        } catch (error) {
          log(`[site-api] gift proxy failed: ${error?.message ?? error}`);
          if (res.headersSent) res.destroy();
          else send(500, { error: { code: 500, message: 'server_error' } });
        }
        return;
      }
      if (pathname.startsWith('/v1/hama/') || pathname === '/v1/admin/hama' || pathname.startsWith('/v1/admin/hama/')) {
        // Hama plan (hama.mjs). Every route is 404 while HAMA_ENABLED is off.
        if (!hama) throw siteError('NOT_FOUND', 'not found');
        if (pathname.startsWith(`${HAMA_ANTHROPIC_PREFIX}/`) || pathname.startsWith(`${HAMA_OPENAI_PREFIX}/`)) {
          // Streams its own response (SSE), so it never goes through send().
          allow('hama-proxy', 600, MINUTE);
          try {
            await hama.proxy.handle(req, res, pathname);
          } catch (error) {
            log(`[site-api] hama proxy failed: ${error?.message ?? error}`);
            if (res.headersSent) res.destroy();
            else send(500, { error: { code: 500, message: 'server_error' } });
          }
          return;
        }
        switch (route) {
          case 'GET /v1/hama/status':
            allow('hama-status', 120, MINUTE);
            req.resume?.();
            send(200, await hama.status(bearerToken(req) || String(req.headers['x-api-key'] ?? '').trim()));
            return;
          case 'GET /v1/admin/hama':
            allow('admin', 120, TEN_MINUTES);
            send(200, await hama.admin.list(bearerToken(req), Object.fromEntries(searchParams)));
            return;
          case 'GET /v1/admin/hama/usage':
            allow('admin', 120, TEN_MINUTES);
            send(200, await hama.admin.usage(bearerToken(req), Object.fromEntries(searchParams)));
            return;
          case 'POST /v1/admin/hama/enroll': {
            allow('admin', 120, TEN_MINUTES);
            const token = bearerToken(req);
            const body = await readJson(req);
            // Only an existing license can be enrolled; the lookup also checks the token.
            const keyId = typeof body?.keyId === 'string' ? body.keyId.trim() : '';
            if (!keyId || !(await licenses.admin.lookup(token, { keyId })).licenses[0]) throw licenseError('invalid_key', 404);
            send(200, await hama.admin.enroll(token, { ...body, keyId }));
            return;
          }
          case 'POST /v1/admin/hama/disable':
            allow('admin', 120, TEN_MINUTES);
            send(200, await hama.admin.disable(bearerToken(req), await readJson(req)));
            return;
          default:
            throw siteError('NOT_FOUND', 'not found');
        }
      }
      if (pathname.startsWith('/v1/account/')) {
        // App routes (no CORS). Every one answers accounts_not_configured until WORKOS_API_KEY is set.
        if (!accounts?.configured) {
          req.resume?.();
          throw accountError('accounts_not_configured', 503);
        }
        switch (route) {
          case 'GET /v1/account/auth/providers':
            allowAccount('account', 300, TEN_MINUTES);
            send(200, accounts.providers());
            return;
          case 'POST /v1/account/auth/start':
            allowAccount('account-start', 20, TEN_MINUTES);
            send(200, await accounts.startLogin(await readAccountJson(req)));
            return;
          case 'GET /v1/account/auth/callback': {
            allowAccount('account-callback', 60, TEN_MINUTES);
            const result = await accounts.callback(Object.fromEntries(searchParams));
            if (!result.redirect) {
              send(400, renderAccountLoginErrorPage());
              return;
            }
            res.writeHead(302, { Location: result.redirect, ...securityHeaders(false) });
            res.end();
            return;
          }
          case 'POST /v1/account/auth/token':
            allowAccount('account-token', 30, TEN_MINUTES);
            send(200, await accounts.token(await readAccountJson(req)));
            return;
          case 'POST /v1/account/refresh':
            allowAccount('account', 300, TEN_MINUTES);
            send(200, await accounts.refresh(bearerToken(req), await readAccountJson(req)));
            return;
          case 'POST /v1/account/signout':
            allowAccount('account', 300, TEN_MINUTES);
            await readAccountJson(req);
            send(200, await accounts.signout(bearerToken(req)));
            return;
          case 'POST /v1/account/devices/remove':
            allowAccount('account', 300, TEN_MINUTES);
            send(200, await accounts.removeDevice(bearerToken(req), await readAccountJson(req)));
            return;
          // Per-account limits live in accounts.mjs; this one only stops floods.
          case 'POST /v1/account/redeem':
            allowAccount('account', 300, TEN_MINUTES);
            send(200, await accounts.redeem(bearerToken(req), await readAccountJson(req)));
            return;
          case 'POST /v1/account/claim':
            allowAccount('account', 300, TEN_MINUTES);
            send(200, await accounts.claim(bearerToken(req), await readAccountJson(req)));
            return;
          case 'POST /v1/account/gift-codes/redeem':
            allowAccount('account', 300, TEN_MINUTES);
            send(200, await accounts.redeemGiftCode(bearerToken(req), await readAccountJson(req)));
            return;
          case 'POST /v1/account/profile':
            allowAccount('account', 300, TEN_MINUTES);
            send(200, await accounts.updateProfile(bearerToken(req), await readAccountJson(req)));
            return;
          case 'PUT /v1/account/avatar': {
            allowAccount('account', 300, TEN_MINUTES);
            // A body declared past twice the cap is refused unread and the connection closes.
            if (Number(req.headers['content-length']) > 2 * MAX_AVATAR_BYTES) {
              discardUpload(req, 2 * MAX_AVATAR_BYTES);
              send(413, { ok: false, error: 'too_large' }, { Connection: 'close' });
              return;
            }
            const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
            let reading = false;
            try {
              send(200, await accounts.setAvatar(bearerToken(req), contentType, () => {
                reading = true;
                return readUpload(req, MAX_AVATAR_BYTES);
              }));
            } catch (error) {
              // Refused before the body was read: drain it so the client still reads the answer.
              if (!reading) discardUpload(req, 2 * MAX_AVATAR_BYTES);
              throw error;
            }
            return;
          }
          case 'GET /v1/account/avatar': {
            allowAccount('account', 300, TEN_MINUTES);
            const avatar = await accounts.getAvatar(bearerToken(req));
            const etag = `"${avatar.rev}"`;
            const headers = { ETag: etag, 'Cache-Control': 'private, no-cache', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
            if (req.headers['if-none-match'] === etag) {
              res.writeHead(304, headers);
              res.end();
              return;
            }
            res.writeHead(200, {
              ...headers,
              'Content-Type': avatar.type,
              'Content-Length': avatar.bytes.length,
              'Content-Security-Policy': "default-src 'none'; sandbox",
            });
            res.end(avatar.bytes);
            return;
          }
          case 'POST /v1/account/avatar/remove':
            allowAccount('account', 300, TEN_MINUTES);
            await readAccountJson(req);
            send(200, await accounts.removeAvatar(bearerToken(req)));
            return;
          case 'POST /v1/account/stats':
            allowAccount('account', 300, TEN_MINUTES);
            send(200, await accounts.recordStats(bearerToken(req), await readAccountJson(req)));
            return;
          case 'POST /v1/account/delete':
            allowAccount('account', 300, TEN_MINUTES);
            send(200, await accounts.deleteAccount(bearerToken(req), await readAccountJson(req)));
            return;
          default:
            throw siteError('NOT_FOUND', 'not found');
        }
      }
      switch (route) {
        case 'GET /v1/admin/accounts':
          allow('admin', 120, TEN_MINUTES);
          if (!accounts) throw siteError('NOT_FOUND', 'not found');
          send(200, await accounts.admin.lookup(bearerToken(req), Object.fromEntries(searchParams)));
          return;
        case 'POST /v1/admin/accounts/unlink':
          allow('admin', 120, TEN_MINUTES);
          send(200, await licenses.admin.unlinkAccount(bearerToken(req), await readJson(req)));
          return;
        case 'POST /v1/admin/accounts/link':
          allow('admin', 120, TEN_MINUTES);
          if (!accounts) throw siteError('NOT_FOUND', 'not found');
          send(200, await accounts.admin.link(bearerToken(req), await readJson(req)));
          return;
        case 'GET /v1/groble/webhook':
          // Deploy check: 404 until this build is live, 503 while the secret is missing.
          if (!licenseConfig.webhookSecret) send(503, { ok: false, error: 'not_configured' });
          else send(200, { ok: true });
          return;
        case 'POST /v1/groble/webhook': {
          // Groble: 2xx fast, never 3xx/410. Rejections follow WEBHOOK_REJECT_STATUS and are
          // recorded and alerted after the response.
          let rawBody;
          try {
            rawBody = await readRaw(req, MAX_WEBHOOK_BODY_BYTES);
          } catch (error) {
            if (error?.code !== 'BODY_TOO_LARGE') throw error;
            rejectWebhook('body_too_large');
            return;
          }
          const check = verifyGrobleWebhook({
            headers: req.headers,
            rawBody,
            secret: licenseConfig.webhookSecret,
            previousSecret: licenseConfig.webhookSecretPrevious,
          });
          if (!check.ok) {
            rejectWebhook(check.reason, { verified: check.reason === 'timestamp_out_of_window', rawBody });
            return;
          }
          let event;
          try {
            event = JSON.parse(rawBody.toString('utf8'));
          } catch {
            rejectWebhook('json_invalid', { verified: true, rawBody });
            return;
          }
          let result;
          try {
            result = await licenses.handleGrobleEvent(event, { idempotencyKey: check.idempotencyKey });
          } catch (error) {
            if (!error?.licenseError) log(`[site-api] groble webhook failed: ${error?.stack ?? error}`);
            rejectWebhook(error?.licenseError ? 'payload_invalid' : 'store_error', { verified: true, rawBody });
            return;
          }
          log(`[site-api] groble ${event?.type} ${result.duplicate ? 'duplicate' : result.action}`);
          // The key is saved either way; a failed sync heals on the key's next Hama call.
          if (hama && result.keyId && !result.duplicate) {
            await hama.syncSubscriptions().catch((error) => log(`[site-api] hama plan sync failed: ${error?.message ?? error}`));
          }
          send(200, { ok: true, duplicate: result.duplicate, action: result.action });
          // Held orders and events we could not use (unknown type, unmatched subscription) stay visible in
          // `webhooks --held` and on the dashboard, and each one is emailed to management.
          if (result.needsReview && !result.duplicate) {
            const entry = webhookLogEntry({
              kind: 'held', reason: result.reason, status: 200, verified: true, headers: req.headers, rawBody,
              details: heldEventDetails(event, result),
            });
            later(async () => {
              const saved = await webhookLog.record(entry).catch((error) => {
                log(`[site-api] webhook log write failed: ${error?.message ?? error}`);
                return { ...entry, at: new Date().toISOString() };
              });
              await heldAlerts.notify(saved);
            });
          }
          setImmediate(() => { void licenses.deliverPendingEmails().catch(() => {}); });
          return;
        }
        case 'OPTIONS /v1/license/by-ref': {
          const origin = req.headers.origin;
          if (typeof origin === 'string' && allowedOrigins.has(origin)) {
            cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
          }
          res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '600' });
          res.end();
          return;
        }
        case 'GET /v1/license/by-ref': {
          const origin = req.headers.origin;
          cors = { Vary: 'Origin' };
          if (typeof origin === 'string' && allowedOrigins.has(origin)) {
            cors['Access-Control-Allow-Origin'] = origin;
          }
          allow('license-by-ref', 120, MINUTE);
          send(200, await licenses.statusByRef(searchParams.get('ref') ?? ''));
          return;
        }
        case 'POST /v1/license/activate':
          allow('license-activate', 20, TEN_MINUTES);
          send(200, await licenses.activate(await readJson(req)));
          return;
        case 'POST /v1/license/validate':
          allow('license-validate', 60, TEN_MINUTES);
          send(200, await licenses.validate(await readJson(req)));
          return;
        case 'POST /v1/license/deactivate':
          allow('license-deactivate', 20, TEN_MINUTES);
          send(200, await licenses.deactivate(await readJson(req)));
          return;
        case 'POST /v1/license/grandfather':
          allow('license-grandfather', 10, TEN_MINUTES);
          send(200, await licenses.grandfather(await readJson(req)));
          return;
        case 'GET /v1/license/public-key':
          cors = { 'Access-Control-Allow-Origin': '*' };
          if (!licenseConfig.publicKeyDerBase64) throw Object.assign(siteError('server_not_configured', 'no signing key'), { licenseError: true, status: 503 });
          send(200, {
            alg: 'Ed25519',
            kid: licenseConfig.signingKeyId,
            rawBase64: licenseConfig.publicKeyRawBase64,
            spkiDerBase64: licenseConfig.publicKeyDerBase64,
          });
          return;
        case 'GET /v1/gift/status':
          allow('gift-status', 120, MINUTE);
          req.resume?.();
          send(200, await gifts.status(bearerToken(req)));
          return;
        case 'POST /v1/gift/claim':
          allow('gift-claim', 20, TEN_MINUTES);
          await readJson(req);
          send(200, await gifts.claim(bearerToken(req)));
          return;
        // Hosted Rau-0.1. Per-license limits live in rau.mjs; these per-IP ones only stop floods.
        case 'GET /v1/rau/status':
          if (!limiter.check(`rau-status:${ip}`, 120, MINUTE)) throw rauRateLimited(60);
          send(200, await rau.status(bearerToken(req)));
          return;
        case 'POST /v1/rau/learn': {
          if (Number(req.headers['content-length']) > 4 * MAX_RAU_BODY_BYTES) {
            discardUpload(req, 4 * MAX_RAU_BODY_BYTES);
            send(400, { ok: false, error: 'invalid', field: 'prompt' }, { Connection: 'close' });
            return;
          }
          if (!limiter.check(`rau-learn:${ip}`, 120, MINUTE)) { req.resume?.(); throw rauRateLimited(60); }
          const raw = await readOrNull(req, MAX_RAU_BODY_BYTES);
          send(200, await rau.learn(bearerToken(req), raw));
          return;
        }
        case 'GET /v1/admin/rau':
          allow('admin', 120, TEN_MINUTES);
          send(200, await rau.admin.list(bearerToken(req)));
          return;
        case 'GET /v1/admin/gifts':
          allow('admin', 120, TEN_MINUTES);
          send(200, await gifts.admin.list(bearerToken(req), Object.fromEntries(searchParams)));
          return;
        case 'POST /v1/admin/gifts/disable':
          allow('admin', 120, TEN_MINUTES);
          send(200, await gifts.admin.disable(bearerToken(req), await readJson(req)));
          return;
        case 'POST /v1/admin/gifts/amount': {
          allow('admin', 120, TEN_MINUTES);
          const token = bearerToken(req);
          const body = await readJson(req);
          if (!gifts) throw siteError('NOT_FOUND', 'not found');
          // Only beta keys get gifts, so an allocation for anything else is a typo.
          const keyId = typeof body?.keyId === 'string' ? body.keyId.trim() : '';
          const found = (await licenses.admin.lookup(token, { keyId })).licenses; // also checks the token
          if (found[0]?.tier !== 'beta') throw licenseError('invalid_key', 404);
          send(200, await gifts.admin.setAmount(token, { keyId, amountUsd: body.amountUsd }));
          return;
        }
        case 'GET /v1/admin/licenses':
          allow('admin', 120, TEN_MINUTES);
          send(200, await licenses.admin.lookup(bearerToken(req), Object.fromEntries(searchParams)));
          return;
        case 'GET /v1/admin/orders':
          allow('admin', 120, TEN_MINUTES);
          send(200, await licenses.admin.orders(bearerToken(req), Object.fromEntries(searchParams)));
          return;
        case 'GET /v1/admin/licenses/signatures':
          allow('admin', 120, TEN_MINUTES);
          send(200, await licenses.admin.signatures(bearerToken(req)));
          return;
        case 'GET /v1/admin/licenses/betas': {
          allow('admin', 120, TEN_MINUTES);
          const token = bearerToken(req);
          const result = await licenses.admin.betas(token);
          send(200, gifts ? await gifts.admin.withGifts(token, result) : result);
          return;
        }
        case 'GET /v1/admin/licenses/customers':
          allow('admin', 120, TEN_MINUTES);
          send(200, await licenses.admin.customers(bearerToken(req)));
          return;
        case 'GET /v1/admin/attention':
          allow('admin', 120, TEN_MINUTES);
          send(200, await licenses.admin.attention(bearerToken(req)));
          return;
        case 'GET /v1/admin/webhooks':
          allow('admin', 120, TEN_MINUTES);
          send(200, await licenses.admin.webhooks(bearerToken(req), Object.fromEntries(searchParams)));
          return;
        case 'GET /v1/admin/gift-codes':
          allow('admin', 120, TEN_MINUTES);
          send(200, await licenses.admin.giftCodes(bearerToken(req), Object.fromEntries(searchParams)));
          return;
        case 'POST /v1/admin/gift-codes/issue':
          allow('admin', 120, TEN_MINUTES);
          send(200, await licenses.admin.issueGiftCodes(bearerToken(req), await readJson(req)));
          return;
        case 'POST /v1/admin/gift-codes/revoke':
          allow('admin', 120, TEN_MINUTES);
          send(200, await licenses.admin.revokeGiftCodes(bearerToken(req), await readJson(req)));
          return;
        case 'POST /v1/admin/licenses/issue':
        case 'POST /v1/admin/licenses/issue-beta':
        case 'POST /v1/admin/licenses/revoke':
        case 'POST /v1/admin/licenses/restore':
        case 'POST /v1/admin/licenses/reset-devices':
        case 'POST /v1/admin/licenses/resend-email':
        case 'POST /v1/admin/licenses/extend':
        case 'POST /v1/admin/licenses/remove-device':
        case 'POST /v1/admin/orders/release':
        case 'POST /v1/admin/orders/apply-renewal':
        case 'POST /v1/admin/attention/ack': {
          allow('admin', 120, TEN_MINUTES);
          const action = {
            '/v1/admin/licenses/issue': 'issue',
            '/v1/admin/licenses/issue-beta': 'issueBeta',
            '/v1/admin/licenses/revoke': 'revoke',
            '/v1/admin/licenses/restore': 'restore',
            '/v1/admin/licenses/reset-devices': 'resetDevices',
            '/v1/admin/licenses/resend-email': 'resendEmail',
            '/v1/admin/licenses/extend': 'extend',
            '/v1/admin/licenses/remove-device': 'removeDevice',
            '/v1/admin/orders/release': 'release',
            '/v1/admin/orders/apply-renewal': 'applyRenewal',
            '/v1/admin/attention/ack': 'ack',
          }[pathname];
          const token = bearerToken(req);
          const body = await readJson(req);
          // issue-beta {giftUsd}: the new key's gift amount, checked before the key exists.
          const giftUsd = action === 'issueBeta' && body?.giftUsd !== undefined && body.giftUsd !== '' && gifts
            ? parseGiftAmount(body.giftUsd) : undefined;
          if (giftUsd !== undefined && !gifts.configured) throw licenseError('event_inactive', 410);
          const result = await licenses.admin[action](token, body);
          if (giftUsd !== undefined && result.license?.keyId) {
            result.gift = (await gifts.admin.setAmount(token, { keyId: result.license.keyId, amountUsd: giftUsd })).gift;
          }
          send(200, result);
          if (action === 'issue' || action === 'release' || action === 'applyRenewal') {
            setImmediate(() => { void licenses.deliverPendingEmails().catch(() => {}); });
          }
          return;
        }
        case 'POST /v1/feedback': {
          // A body declared past twice the cap is refused unread and the connection closes.
          if (Number(req.headers['content-length']) > 2 * MAX_FEEDBACK_BODY_BYTES) throw feedbackError('too_large', 413);
          // Refusals come before the body is buffered; the body is discarded so the client still reads the answer.
          const refuse = feedbackUploads >= MAX_FEEDBACK_UPLOADS ? [503, 'busy']
            : !limiter.check(`feedback:${ip}`, FEEDBACK_PER_IP_PER_HOUR, HOUR) ? [429, 'rate_limited'] : null;
          if (refuse) {
            discardUpload(req, 2 * MAX_FEEDBACK_BODY_BYTES);
            send(refuse[0], { ok: false, error: refuse[1] });
            return;
          }
          feedbackUploads += 1;
          let summary;
          try {
            const raw = await readUpload(req, MAX_FEEDBACK_BODY_BYTES);
            let parsed;
            try {
              parsed = JSON.parse(raw.toString('utf8'));
            } catch {
              throw feedbackError('invalid', 400);
            }
            summary = await feedback.submit(parsed);
          } finally {
            feedbackUploads -= 1;
          }
          log(`[site-api] feedback ${summary.id} (${summary.bytes} bytes)`);
          send(201, { ok: true, id: summary.id });
          later(() => feedback.notify(summary));
          return;
        }
        case 'GET /v1/admin/feedback':
          allow('admin-feedback', 300, TEN_MINUTES);
          send(200, await feedback.admin.list(bearerToken(req)));
          return;
        case 'GET /v1/admin/feedback/report':
          allow('admin-feedback', 300, TEN_MINUTES);
          send(200, await feedback.admin.detail(bearerToken(req), searchParams.get('id')));
          return;
        case 'GET /v1/admin/feedback/attachment': {
          allow('admin-feedback', 300, TEN_MINUTES);
          const file = await feedback.admin.attachment(bearerToken(req), {
            id: searchParams.get('id'),
            name: searchParams.get('name'),
          });
          const ascii = file.fileName.replace(/[^A-Za-z0-9._-]/g, '_');
          res.writeHead(200, {
            'Content-Type': file.contentType,
            'Content-Length': file.bytes.length,
            'Content-Disposition': `${file.inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
            'Content-Security-Policy': "default-src 'none'; sandbox",
            ...securityHeaders(false),
          });
          res.end(file.bytes);
          return;
        }
        case 'POST /v1/admin/feedback/status':
          allow('admin-feedback', 300, TEN_MINUTES);
          send(200, await feedback.admin.setStatus(bearerToken(req), await readJson(req)));
          return;
        case 'POST /v1/admin/feedback/delete':
          allow('admin-feedback', 300, TEN_MINUTES);
          send(200, await feedback.admin.remove(bearerToken(req), await readJson(req)));
          return;
        case 'GET /rau.png':
        case 'GET /favicon.ico':
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=86400',
          });
          res.end(await readFile(RAU_ICON_PATH));
          return;
        case 'GET /healthz':
          send(200, { ok: true, storage });
          return;
        case 'GET /unique-installs':
          allow('unique-install-page', 120, MINUTE);
          send(200, renderUniqueInstallsPage(await uniqueInstalls.summary()));
          return;
        case 'GET /v1/unique-installs':
          cors = { 'Access-Control-Allow-Origin': '*' };
          allow('unique-install-read', 120, MINUTE);
          send(200, await uniqueInstalls.summary());
          return;
        case 'POST /v1/unique-installs':
          allow('unique-install-write', 30, TEN_MINUTES);
          send(200, await uniqueInstalls.record(await readJson(req)));
          return;
        case 'POST /v1/waitlist':
          cors = { 'Access-Control-Allow-Origin': '*' };
          allow('waitlist-write', 10, TEN_MINUTES);
          send(200, await waitlist.join(await readJson(req)));
          return;
        case 'GET /v1/waitlist':
          allow('waitlist-read', 30, TEN_MINUTES);
          send(200, await waitlist.list(bearerToken(req)));
          return;
        // Website download buttons (navigator.sendBeacon, text/plain JSON). Counts only; the IP is used
        // only by the in-memory rate limiter and never stored.
        case 'POST /v1/downloads':
          if (!downloads) throw siteError('NOT_FOUND', 'not found');
          cors = { 'Access-Control-Allow-Origin': '*' };
          allow('downloads-write', 30, TEN_MINUTES);
          send(200, await downloads.record(await readJson(req)));
          return;
        case 'GET /v1/admin/downloads':
          if (!downloads) throw siteError('NOT_FOUND', 'not found');
          allow('admin', 120, TEN_MINUTES);
          send(200, await downloads.summary(bearerToken(req), Object.fromEntries(searchParams)));
          return;
        default:
          send(404, { error: 'NOT_FOUND' });
      }
    } catch (error) {
      if (error?.code === 'NOT_FOUND') {
        send(404, { error: 'NOT_FOUND' });
        return;
      }
      const status = errorStatus(error);
      if (error?.expose) {
        // An unread upload is not drained; the connection closes after the answer.
        send(status, { ok: false, error: error.code, ...(error.field ? { field: error.field } : {}) },
          req.complete ? {} : { Connection: 'close' });
        return;
      }
      if (error?.licenseError) {
        send(status, {
          ok: false,
          error: error.code,
          ...(error.tier ? { tier: error.tier } : {}),
          ...(error.licenseExpiresAt ? { licenseExpiresAt: error.licenseExpiresAt } : {}),
          ...(error.paymentFixUrl ? { paymentFixUrl: error.paymentFixUrl } : {}),
          ...(error.extra ?? {}),
        }, error.headers ?? {});
        return;
      }
      if (status >= 500) log(`[site-api] ${req.method} ${req.url}: ${error?.stack ?? error}`);
      send(status, {
        error: error?.code ?? 'SITE_API_FAILED',
        message: status >= 500 ? '서버 오류가 났어요' : (error?.message ?? String(error)),
      });
    }
  };
}

export function createSiteServer(env = process.env, options = {}) {
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  // With a database every store runs there and never touches its JSON file (feedback attachments
  // stay files in both modes). `options.db` (tests, main) wins over DATABASE_URL.
  const db = options.db !== undefined ? options.db : databaseFromEnv(env, log);
  const domainStore = (mapper, filePath, emptyState) => (db
    ? createPostgresStore({ db, mapper })
    : createFileStore(filePath, { emptyState }));
  const uniqueInstallsStore = domainStore(uniqueInstallsMapper, resolveUniqueInstallsDbPath(env), emptyUniqueInstallsState);
  const uniqueInstalls = createUniqueInstallsService({
    store: uniqueInstallsStore,
    pingKey: resolveUniqueInstallPingKey(env) || DEFAULT_UNIQUE_INSTALL_PING_KEY,
  });
  const waitlist = createWaitlistService({
    store: domainStore(waitlistMapper, resolveWaitlistDbPath(env), emptyWaitlistState),
    adminToken: env.RAU_WAITLIST_ADMIN_TOKEN ?? '',
    telegramBotToken: env.RAU_WAITLIST_TELEGRAM_BOT_TOKEN ?? '',
    telegramChatId: env.RAU_WAITLIST_TELEGRAM_CHAT_ID ?? '',
  });
  const licenseConfig = resolveLicenseConfig(env);
  const downloads = createDownloadsService({
    store: domainStore(downloadsMapper, resolveDownloadsDbPath(env), emptyDownloadsState),
    adminToken: licenseConfig.adminToken,
    now: options.now,
  });
  const signingKey = parseSigningPrivateKey(licenseConfig.signingPrivateKey);
  if (signingKey) {
    const publicKey = publicKeyFromPrivate(signingKey);
    licenseConfig.publicKeyDerBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    licenseConfig.publicKeyRawBase64 = rawPublicKeyBase64(publicKey);
  }
  const accountConfig = resolveAccountConfig(env);
  const accountsStore = domainStore(accountsMapper, resolveAccountsDbPath(env), emptyAccountsState);
  const webhookLog = createWebhookLog({
    store: domainStore(webhookLogMapper, resolveWebhookLogDbPath(env), emptyWebhookLogState),
    now: options.now,
  });
  const alertProvider = options.alertProvider !== undefined ? options.alertProvider : resendProviderFromEnv(env);
  const webhookAlerts = createWebhookAlerter({ provider: alertProvider, now: options.now, log });
  const heldAlerts = createHeldAlerter({ provider: alertProvider, log });
  const licenses = createLicensesService({
    store: domainStore(licensesMapper, resolveLicensesDbPath(env), emptyLicensesState),
    uniqueInstallsStore: uniqueInstallsStore,
    signingKey,
    leaseKid: licenseConfig.signingKeyId,
    emailProvider: options.emailProvider ?? createEmailProvider(env),
    onetimeProductIds: licenseConfig.onetimeProductIds,
    subscriptionProductIds: licenseConfig.subscriptionProductIds,
    signatureProductIds: licenseConfig.signatureProductIds,
    basicProducts: licenseConfig.basicProducts,
    hamaProducts: licenseConfig.hamaProducts,
    products: licenseConfig.products,
    paymentGraceMs: licenseConfig.paymentGraceMs,
    paymentGraceMaxMs: licenseConfig.paymentGraceMaxMs,
    paymentFixUrl: licenseConfig.paymentFixUrl,
    expectedPrice: licenseConfig.expectedPrice,
    minAmount: licenseConfig.minAmount,
    signatureExpectedPrice: licenseConfig.signatureExpectedPrice,
    signatureMinAmount: licenseConfig.signatureMinAmount,
    grandfatherCutoff: licenseConfig.grandfatherCutoff,
    grandfatherPlatforms: licenseConfig.grandfatherPlatforms,
    adminToken: licenseConfig.adminToken,
    downloadUrl: licenseConfig.downloadUrl,
    // Bound late: the Hama service authenticates through this one. With HAMA_ENABLED off no plan is active.
    hamaPlanActive: async (keyId) => hamaService?.planActive(keyId) ?? false,
    accountForEmail: async (emailLower) => accountIdForEmail(await accountsStore.read(), emailLower),
    webhookLog,
    now: options.now,
    log,
  });
  if (accountConfig.apiKey && !signingKey) log('[site-api] WORKOS_API_KEY is set but LICENSE_SIGNING_PRIVATE_KEY is not: accounts stay off');
  const accounts = createAccountsService({
    store: accountsStore,
    licenses,
    workos: accountConfig.apiKey ? createWorkOSClient({
      apiKey: accountConfig.apiKey,
      clientId: accountConfig.clientId,
      apiBase: accountConfig.apiBase,
      redirectUri: accountConfig.redirectUri,
      fetchImpl: options.fetchImpl,
    }) : null,
    signingKey,
    leaseKid: licenseConfig.signingKeyId,
    avatars: db ? createPostgresAvatars(db) : createFileAvatars(resolveAvatarDir(env)),
    // Bound late like hamaPlanActive: the Hama service is created after this one.
    hamaUsage: async (keyId) => (hamaService ? hamaService.usageSummary(keyId) : null),
    syncHamaPlans: async () => hamaService?.syncSubscriptions(),
    providers: accountConfig.providers,
    deviceLimit: accountConfig.deviceLimit,
    adminToken: licenseConfig.adminToken,
    now: options.now,
    log,
  });
  const gifts = createGiftsService({
    store: domainStore(giftsMapper, resolveGiftsDbPath(env), emptyGiftsState),
    authenticate: (lease) => accounts.authenticateLease(lease, { purpose: 'gift' }),
    config: resolveGiftConfig(env),
    adminToken: licenseConfig.adminToken,
    fetchImpl: options.fetchImpl,
    now: options.now,
    log,
  });
  const hamaConfig = resolveHamaConfig(env);
  const hamaService = hamaConfig.enabled ? createHamaService({
    store: domainStore(hamaMapper, resolveHamaDbPath(env), emptyHamaState),
    authenticate: (lease) => accounts.authenticateLease(lease, { purpose: 'hama' }),
    subscriptions: () => licenses.hamaSubscriptions(),
    config: hamaConfig,
    adminToken: licenseConfig.adminToken,
    now: options.now,
    log,
    usageLog: db ? createPostgresUsageLog(db) : createFileUsageLog(resolveHamaUsageDir(env)),
  }) : null;
  const hama = hamaService && {
    ...hamaService,
    proxy: createHamaProxy({ hama: hamaService, config: hamaConfig, fetchImpl: options.fetchImpl, now: options.now, log }),
  };
  const rau = createRauService({
    store: domainStore(rauMapper, resolveRauDbPath(env), emptyRauState),
    // A revoked or expired key still authenticates here, so it hears rau_requires_basic instead of 401.
    authenticate: (lease) => accounts.authenticateLease(lease, { allowInactive: true, withRauPlan: true, purpose: 'rau' }),
    config: resolveRauConfig(env),
    upgradeUrl: licenseConfig.basicUpgradeUrl,
    adminToken: licenseConfig.adminToken,
    fetchImpl: options.fetchImpl,
    now: options.now,
    log,
  });
  const feedback = createFeedbackService({
    dir: resolveFeedbackDir(env),
    index: domainStore(feedbackMapper, path.join(resolveFeedbackDir(env), 'index.json'), emptyFeedbackIndex),
    proofKey: resolveFeedbackProofKey(env) || DEFAULT_FEEDBACK_PROOF_KEY,
    maxStorageBytes: resolveFeedbackMaxBytes(env),
    adminToken: licenseConfig.adminToken,
    now: options.now,
    notify: createTelegramSender({
      botToken: env.RAU_WAITLIST_TELEGRAM_BOT_TOKEN ?? '',
      chatId: env.RAU_WAITLIST_TELEGRAM_CHAT_ID ?? '',
      fetchImpl: options.fetchImpl,
      label: 'feedback',
      log,
    }),
  });
  const listener = siteRequestListener({
    uniqueInstalls, waitlist, downloads, licenses, accounts, gifts, hama, rau, feedback, licenseConfig, webhookLog, webhookAlerts, heldAlerts,
    storage: db ? 'postgres' : 'files',
    log,
  });
  setImmediate(() => { void feedback.prune().catch((error) => log(`[site-api] feedback prune failed: ${error?.message ?? error}`)); });
  // Retry any key email that was queued before a restart.
  setImmediate(() => { void licenses.deliverPendingEmails().catch(() => {}); });
  const server = http.createServer((req, res) => {
    void Promise.resolve(listener(req, res)).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
      }
      if (!res.writableEnded) res.end(JSON.stringify({ error: 'SITE_API_FAILED' }));
    });
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    } else {
      socket.destroy();
    }
  });
  return server;
}

function databaseFromEnv(env, log) {
  const url = resolveDatabaseUrl(env);
  return url ? createDatabase(url, { log }) : null;
}

/**
 * Domains with a Postgres mapping and the JSON files each one replaces. The Hama usage log
 * (`hama-usage/*.jsonl`) goes with the hama domain: every billed call writes the ledger first.
 * Avatars go with accounts; feedback attachments stay files.
 */
function mappedFiles(env) {
  return [
    [licensesMapper.domain, resolveLicensesDbPath(env)],
    [accountsMapper.domain, resolveAccountsDbPath(env)],
    [webhookLogMapper.domain, resolveWebhookLogDbPath(env)],
    [hamaMapper.domain, resolveHamaDbPath(env)],
    [hamaMapper.domain, resolveHamaUsageDir(env), { jsonl: true }],
    [rauMapper.domain, resolveRauDbPath(env)],
    [giftsMapper.domain, resolveGiftsDbPath(env)],
    [waitlistMapper.domain, resolveWaitlistDbPath(env)],
    [uniqueInstallsMapper.domain, resolveUniqueInstallsDbPath(env)],
    [downloadsMapper.domain, resolveDownloadsDbPath(env)],
    [feedbackMapper.domain, path.join(resolveFeedbackDir(env), 'index.json')],
  ];
}

/** Whether `file` is a non-empty file, or with `jsonl` a directory holding a non-empty `*.jsonl`. */
async function holdsData(file, { jsonl = false } = {}) {
  if (!jsonl) {
    const info = await stat(file).catch(() => null);
    return Boolean(info?.isFile() && info.size > 0);
  }
  const names = await readdir(file).catch(() => []);
  for (const name of names.filter((n) => n.endsWith('.jsonl'))) {
    if (await holdsData(path.join(file, name))) return true;
  }
  return false;
}

/**
 * Refuses Postgres mode while a mapped JSON file holds data its domain never got: a DATABASE_URL set
 * before the import would otherwise start every customer from an empty database.
 */
export async function checkImported(db, env = process.env) {
  const { rows } = await db.query('SELECT domain FROM site_store_versions');
  const written = new Set(rows.map((row) => row.domain));
  const missing = [];
  for (const [domain, file, options] of mappedFiles(env)) {
    if (written.has(domain)) continue;
    if (await holdsData(file, options)) missing.push(`${path.relative(resolveDataDir(env), file)}${options?.jsonl ? '/' : ''}`);
  }
  if (missing.length) {
    throw new Error(`DATABASE_URL is set but ${missing.join(', ')} was never imported into Postgres. Import it first, or unset DATABASE_URL to keep the JSON files.`);
  }
}

async function main() {
  const log = (line) => process.stderr.write(`${line}\n`);
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const db = databaseFromEnv(process.env, log);
  if (db) {
    try {
      await db.ready();
      await checkImported(db);
    } catch (error) {
      log(`[site-api] Postgres is not usable: ${error?.message ?? error}`);
      await db.close().catch(() => {});
      process.exit(1);
    }
  }
  const server = createSiteServer(process.env, { db });
  server.listen(port, '0.0.0.0', () => {
    log(`[site-api] listening on 0.0.0.0:${port}${db ? ' with Postgres' : ''}`);
  });
  if (db) {
    // Finish in-flight requests, then end the pool; Railway sends SIGTERM before a redeploy.
    process.once('SIGTERM', () => {
      log('[site-api] SIGTERM: closing');
      setTimeout(() => process.exit(0), 10_000).unref();
      setTimeout(() => server.closeAllConnections?.(), 5_000).unref();
      server.close(() => {
        db.close().catch((error) => log(`[site-api] closing Postgres failed: ${error?.message ?? error}`)).finally(() => process.exit(0));
      });
      server.closeIdleConnections?.();
    });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) await main();
