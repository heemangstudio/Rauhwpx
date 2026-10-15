import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PORT,
  resolveLicenseConfig,
  resolveLicensesDbPath,
  resolveUniqueInstallPingKey,
  resolveUniqueInstallsDbPath,
  resolveWaitlistDbPath,
} from './config.mjs';
import { verifyGrobleWebhook } from './groble-webhook.mjs';
import { createEmailProvider } from './license-email.mjs';
import { parseSigningPrivateKey, publicKeyFromPrivate } from './license-lease.mjs';
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

const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
const MINUTE = 60 * 1000;
const TEN_MINUTES = 10 * MINUTE;
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

export function siteRequestListener({ uniqueInstalls, waitlist, licenses, licenseConfig = {}, log = () => {} }) {
  const limiter = createRateLimiter();
  const allowedOrigins = new Set(licenseConfig.allowedOrigins ?? []);
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
      switch (route) {
        case 'POST /v1/groble/webhook': {
          // Groble: 2xx fast, never 3xx/410. Bad signatures get 401 (final failure, no retry);
          // store/config problems get 500/503 so Groble retries for ~44h.
          const rawBody = await readRaw(req, MAX_WEBHOOK_BODY_BYTES);
          const check = verifyGrobleWebhook({
            headers: req.headers,
            rawBody,
            secret: licenseConfig.webhookSecret,
            previousSecret: licenseConfig.webhookSecretPrevious,
          });
          if (!check.ok) {
            log(`[site-api] groble webhook rejected: ${check.reason}`);
            send(check.reason === 'not_configured' ? 503 : 401, { ok: false, error: check.reason });
            return;
          }
          let event;
          try {
            event = JSON.parse(rawBody.toString('utf8'));
          } catch {
            send(400, { ok: false, error: 'json_invalid' });
            return;
          }
          const result = await licenses.handleGrobleEvent(event, { idempotencyKey: check.idempotencyKey });
          log(`[site-api] groble ${event?.type} ${result.duplicate ? 'duplicate' : result.action}`);
          send(200, { ok: true, duplicate: result.duplicate, action: result.action });
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
          send(200, { alg: 'Ed25519', spkiDerBase64: licenseConfig.publicKeyDerBase64 });
          return;
        case 'GET /v1/admin/licenses':
          allow('admin', 120, TEN_MINUTES);
          send(200, await licenses.admin.lookup(bearerToken(req), Object.fromEntries(searchParams)));
          return;
        case 'GET /v1/admin/orders':
          allow('admin', 120, TEN_MINUTES);
          send(200, await licenses.admin.orders(bearerToken(req), Object.fromEntries(searchParams)));
          return;
        case 'POST /v1/admin/licenses/issue':
        case 'POST /v1/admin/licenses/revoke':
        case 'POST /v1/admin/licenses/restore':
        case 'POST /v1/admin/licenses/reset-devices':
        case 'POST /v1/admin/licenses/resend-email':
        case 'POST /v1/admin/orders/release': {
          allow('admin', 120, TEN_MINUTES);
          const action = {
            '/v1/admin/licenses/issue': 'issue',
            '/v1/admin/licenses/revoke': 'revoke',
            '/v1/admin/licenses/restore': 'restore',
            '/v1/admin/licenses/reset-devices': 'resetDevices',
            '/v1/admin/licenses/resend-email': 'resendEmail',
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
        send(status, { ok: false, error: error.code });
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
    licenseConfig.publicKeyDerBase64 = publicKeyFromPrivate(signingKey)
      .export({ format: 'der', type: 'spki' }).toString('base64');
  }
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  const licenses = createLicensesService({
    store: createFileStore(resolveLicensesDbPath(env), { emptyState: emptyLicensesState }),
    uniqueInstallsStore: uniqueInstallsStore,
    signingKey,
    emailProvider: options.emailProvider ?? createEmailProvider(env),
    grobleContentId: licenseConfig.grobleContentId,
    expectedPrice: licenseConfig.expectedPrice,
    minAmount: licenseConfig.minAmount,
    grandfatherCutoff: licenseConfig.grandfatherCutoff,
    grandfatherPlatforms: licenseConfig.grandfatherPlatforms,
    adminToken: licenseConfig.adminToken,
    downloadUrl: licenseConfig.downloadUrl,
    now: options.now,
    log,
  });
  const listener = siteRequestListener({ uniqueInstalls, waitlist, licenses, licenseConfig, log });
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
