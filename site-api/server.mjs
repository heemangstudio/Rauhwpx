import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PORT,
  resolveUniqueInstallPingKey,
  resolveUniqueInstallsDbPath,
  resolveWaitlistDbPath,
} from './config.mjs';
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

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) {
      throw siteError('BODY_TOO_LARGE', '요청 본문이 너무 커요');
    }
    chunks.push(chunk);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
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

export function siteRequestListener({ uniqueInstalls, waitlist }) {
  const limiter = createRateLimiter();
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
      const { pathname } = new URL(requestTarget, 'http://127.0.0.1');
      const route = `${req.method} ${pathname}`;
      switch (route) {
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
      send(errorStatus(error), {
        error: error?.code ?? 'SITE_API_FAILED',
        message: error?.message ?? String(error),
      });
    }
  };
}

export function createSiteServer(env = process.env) {
  const uniqueInstalls = createUniqueInstallsService({
    store: createFileStore(resolveUniqueInstallsDbPath(env), {
      emptyState: emptyUniqueInstallsState,
    }),
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
  const listener = siteRequestListener({ uniqueInstalls, waitlist });
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
