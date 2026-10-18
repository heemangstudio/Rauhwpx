import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PORT,
  resolveGiftConfig,
  resolveGiftsDbPath,
  resolveLicenseConfig,
  resolveLicensesDbPath,
  resolveUniqueInstallPingKey,
  resolveUniqueInstallsDbPath,
  resolveWaitlistDbPath,
  resolveWebhookLogDbPath,
} from './config.mjs';
import { GIFT_PROXY_PREFIX, createGiftsService, emptyGiftsState } from './gifts.mjs';
import { verifyGrobleWebhook } from './groble-webhook.mjs';
import { createEmailProvider, resendProviderFromEnv } from './license-email.mjs';
import { parseSigningPrivateKey, publicKeyFromPrivate, rawPublicKeyBase64 } from './license-lease.mjs';
import { createLicensesService, emptyLicensesState } from './licenses.mjs';
import { renderUniqueInstallsPage } from './pages.mjs';
import { createRateLimiter } from './rate-limit.mjs';
import { createFileStore } from './store.mjs';
import {
  DEFAULT_UNIQUE_INSTALL_PING_KEY,
  createUniqueInstallsService,
  emptyUniqueInstallsState,
} from './unique-installs.mjs';
import { createWaitlistService, emptyWaitlistState } from './waitlist.mjs';
import { createWebhookAlerter } from './webhook-alert.mjs';
import { createWebhookLog, emptyWebhookLogState, webhookLogEntry } from './webhook-log.mjs';

const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
const MINUTE = 60 * 1000;
const TEN_MINUTES = 10 * MINUTE;
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

function errorStatus(error) {
  if (error?.licenseError && Number.isInteger(error.status)) return error.status;
  if (error?.code === 'RATE_LIMITED') return 429;
  if (error?.code === 'BODY_TOO_LARGE') return 413;
  if (error?.code === 'WAITLIST_FORBIDDEN') return 403;
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

export function siteRequestListener({
  uniqueInstalls,
  waitlist,
  licenses,
  gifts,
  licenseConfig = {},
  webhookLog = createWebhookLog(),
  webhookAlerts = createWebhookAlerter({ log: () => {} }),
  log = () => {},
}) {
  const limiter = createRateLimiter();
  const allowedOrigins = new Set(licenseConfig.allowedOrigins ?? []);
  // Work that must never delay or fail a response: runs after it is sent.
  const later = (fn) => setImmediate(() => {
    void Promise.resolve().then(fn).catch((error) => log(`[site-api] background task failed: ${error?.stack ?? error}`));
  });
  return async (req, res) => {
    const ip = clientIp(req);
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
      res.end(isHtml ? body : JSON.stringify(body));
    };
    const allow = (bucket, max, windowMs) => {
      if (limiter.check(`${bucket}:${ip}`, max, windowMs)) return;
      req.resume?.();
      throw rateLimitedError();
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
      if (pathname.startsWith('/v1/license/') || pathname.startsWith('/v1/admin/') || pathname === '/v1/groble/webhook') {
        if (!licenses) throw siteError('NOT_FOUND', 'not found');
      }
      if (pathname.startsWith('/v1/gift/') && !gifts) throw siteError('NOT_FOUND', 'not found');
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
      switch (route) {
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
          send(200, { ok: true, duplicate: result.duplicate, action: result.action });
          // Held orders and events we could not use (unknown type, unmatched subscription) stay visible in `webhooks --held`.
          if (result.needsReview && !result.duplicate) {
            const entry = webhookLogEntry({ kind: 'held', reason: result.reason, status: 200, verified: true, headers: req.headers, rawBody });
            later(() => webhookLog.record(entry));
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
        case 'GET /v1/admin/gifts':
          allow('admin', 120, TEN_MINUTES);
          send(200, await gifts.admin.list(bearerToken(req), Object.fromEntries(searchParams)));
          return;
        case 'POST /v1/admin/gifts/disable':
          allow('admin', 120, TEN_MINUTES);
          send(200, await gifts.admin.disable(bearerToken(req), await readJson(req)));
          return;
        case 'GET /v1/admin/licenses':
          allow('admin', 120, TEN_MINUTES);
          send(200, await licenses.admin.lookup(bearerToken(req), Object.fromEntries(searchParams)));
          return;
        case 'GET /v1/admin/orders':
          allow('admin', 120, TEN_MINUTES);
          send(200, await licenses.admin.orders(bearerToken(req), Object.fromEntries(searchParams)));
          return;
        case 'GET /v1/admin/licenses/betas':
          allow('admin', 120, TEN_MINUTES);
          send(200, await licenses.admin.betas(bearerToken(req)));
          return;
        case 'GET /v1/admin/webhooks':
          allow('admin', 120, TEN_MINUTES);
          send(200, await licenses.admin.webhooks(bearerToken(req), Object.fromEntries(searchParams)));
          return;
        case 'POST /v1/admin/licenses/issue':
        case 'POST /v1/admin/licenses/issue-beta':
        case 'POST /v1/admin/licenses/revoke':
        case 'POST /v1/admin/licenses/restore':
        case 'POST /v1/admin/licenses/reset-devices':
        case 'POST /v1/admin/licenses/resend-email':
        case 'POST /v1/admin/licenses/extend':
        case 'POST /v1/admin/orders/release': {
          allow('admin', 120, TEN_MINUTES);
          const action = {
            '/v1/admin/licenses/issue': 'issue',
            '/v1/admin/licenses/issue-beta': 'issueBeta',
            '/v1/admin/licenses/revoke': 'revoke',
            '/v1/admin/licenses/restore': 'restore',
            '/v1/admin/licenses/reset-devices': 'resetDevices',
            '/v1/admin/licenses/resend-email': 'resendEmail',
            '/v1/admin/licenses/extend': 'extend',
            '/v1/admin/orders/release': 'release',
          }[pathname];
          const token = bearerToken(req);
          const body = await readJson(req);
          const result = await licenses.admin[action](token, body);
          send(200, result);
          if (action === 'issue' || action === 'release') {
            setImmediate(() => { void licenses.deliverPendingEmails().catch(() => {}); });
          }
          return;
        }
        case 'GET /rau.png':
        case 'GET /favicon.ico':
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=86400',
          });
          res.end(await readFile(RAU_ICON_PATH));
          return;
        case 'GET /healthz':
          send(200, { ok: true });
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
        default:
          send(404, { error: 'NOT_FOUND' });
      }
    } catch (error) {
      if (error?.code === 'NOT_FOUND') {
        send(404, { error: 'NOT_FOUND' });
        return;
      }
      const status = errorStatus(error);
      if (error?.licenseError) {
        send(status, {
          ok: false,
          error: error.code,
          ...(error.tier ? { tier: error.tier } : {}),
          ...(error.licenseExpiresAt ? { licenseExpiresAt: error.licenseExpiresAt } : {}),
          ...(error.paymentFixUrl ? { paymentFixUrl: error.paymentFixUrl } : {}),
        });
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
  const uniqueInstallsStore = createFileStore(resolveUniqueInstallsDbPath(env), {
    emptyState: emptyUniqueInstallsState,
  });
  const uniqueInstalls = createUniqueInstallsService({
    store: uniqueInstallsStore,
    pingKey: resolveUniqueInstallPingKey(env) || DEFAULT_UNIQUE_INSTALL_PING_KEY,
  });
  const waitlist = createWaitlistService({
    store: createFileStore(resolveWaitlistDbPath(env), {
      emptyState: emptyWaitlistState,
    }),
    adminToken: env.RAU_WAITLIST_ADMIN_TOKEN ?? '',
    telegramBotToken: env.RAU_WAITLIST_TELEGRAM_BOT_TOKEN ?? '',
    telegramChatId: env.RAU_WAITLIST_TELEGRAM_CHAT_ID ?? '',
  });
  const licenseConfig = resolveLicenseConfig(env);
  const signingKey = parseSigningPrivateKey(licenseConfig.signingPrivateKey);
  if (signingKey) {
    const publicKey = publicKeyFromPrivate(signingKey);
    licenseConfig.publicKeyDerBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    licenseConfig.publicKeyRawBase64 = rawPublicKeyBase64(publicKey);
  }
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  const webhookLog = createWebhookLog({
    store: createFileStore(resolveWebhookLogDbPath(env), { emptyState: emptyWebhookLogState }),
    now: options.now,
  });
  const webhookAlerts = createWebhookAlerter({
    provider: options.alertProvider !== undefined ? options.alertProvider : resendProviderFromEnv(env),
    now: options.now,
    log,
  });
  const licenses = createLicensesService({
    store: createFileStore(resolveLicensesDbPath(env), { emptyState: emptyLicensesState }),
    uniqueInstallsStore: uniqueInstallsStore,
    signingKey,
    leaseKid: licenseConfig.signingKeyId,
    emailProvider: options.emailProvider ?? createEmailProvider(env),
    onetimeProductIds: licenseConfig.onetimeProductIds,
    subscriptionProductIds: licenseConfig.subscriptionProductIds,
    paymentGraceMs: licenseConfig.paymentGraceMs,
    paymentFixUrl: licenseConfig.paymentFixUrl,
    expectedPrice: licenseConfig.expectedPrice,
    minAmount: licenseConfig.minAmount,
    grandfatherCutoff: licenseConfig.grandfatherCutoff,
    grandfatherPlatforms: licenseConfig.grandfatherPlatforms,
    adminToken: licenseConfig.adminToken,
    downloadUrl: licenseConfig.downloadUrl,
    webhookLog,
    now: options.now,
    log,
  });
  const gifts = createGiftsService({
    store: createFileStore(resolveGiftsDbPath(env), { emptyState: emptyGiftsState }),
    authenticate: (lease) => licenses.authenticateLease(lease),
    config: resolveGiftConfig(env),
    adminToken: licenseConfig.adminToken,
    fetchImpl: options.fetchImpl,
    now: options.now,
    log,
  });
  const listener = siteRequestListener({ uniqueInstalls, waitlist, licenses, gifts, licenseConfig, webhookLog, webhookAlerts, log });
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  createSiteServer().listen(port, '0.0.0.0', () => {
    process.stderr.write(`[site-api] listening on 0.0.0.0:${port}\n`);
  });
}
