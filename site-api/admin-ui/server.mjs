#!/usr/bin/env node
// Local license admin page. Listens on 127.0.0.1 only and forwards a fixed set of admin
// calls to SITE_API_BASE with the admin token added here; the token never reaches the browser.
//   npm --prefix site-api run admin-ui [-- --port 8790]
// Token: ADMIN_TOKEN, else the macOS Keychain item `hamaeditor-license-admin`
// (ADMIN_UI_KEYCHAIN_SERVICE overrides the name). Without either, the page asks for it once.
//
// Every request must name this server in Host (blocks DNS rebinding). API calls also need the
// per-process session token that is embedded in the served page, and a same-origin Origin if any.
// ADMIN_UI_PUBLIC_ORIGIN=https://<host>:<port> also accepts one HTTPS front door such as `tailscale serve`.
import { execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { adminRequest, siteApiBase } from '../scripts/admin-request.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ADMIN_UI_PORT = 8790;
export const DEFAULT_KEYCHAIN_SERVICE = 'hamaeditor-license-admin';
const MAX_BODY_BYTES = 16 * 1024;
const STATIC = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/scene.js': ['scene.js', 'text/javascript; charset=utf-8'],
  '/fonts/galmuri11.woff2': ['fonts/galmuri11.woff2', 'font/woff2'],
  '/fonts/galmuri11-bold.woff2': ['fonts/galmuri11-bold.woff2', 'font/woff2'],
};

/** The only upstream calls the page can make. Bodies and queries are cut down to these fields. */
const ROUTES = {
  'GET /api/betas': { path: '/v1/admin/licenses/betas', fields: [] },
  'GET /api/licenses': { path: '/v1/admin/licenses', fields: ['key', 'keyId', 'email'] },
  'POST /api/issue-beta': { path: '/v1/admin/licenses/issue-beta', fields: ['name', 'devices', 'email', 'note'] },
  'POST /api/revoke': { path: '/v1/admin/licenses/revoke', fields: ['key', 'keyId', 'reason'] },
  'POST /api/restore': { path: '/v1/admin/licenses/restore', fields: ['key', 'keyId'] },
  'POST /api/reset-devices': { path: '/v1/admin/licenses/reset-devices', fields: ['key', 'keyId'] },
};

function pick(source, fields) {
  const out = {};
  for (const field of fields) if (source[field] !== undefined && source[field] !== '') out[field] = source[field];
  return out;
}

function sameSecret(given, expected) {
  if (typeof given !== 'string' || !given) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** macOS Keychain through `security`, always with an argument list, never a shell string. */
export function createKeychain({ service = DEFAULT_KEYCHAIN_SERVICE, run = promisify(execFile) } = {}) {
  return {
    service,
    async read() {
      if (process.platform !== 'darwin') return '';
      try {
        const { stdout } = await run('security', ['find-generic-password', '-s', service, '-w']);
        return stdout.trim();
      } catch {
        return '';
      }
    },
    async save(token) {
      if (process.platform !== 'darwin') throw new Error('keychain_unavailable');
      await run('security', ['add-generic-password', '-U', '-s', service, '-a', 'admin', '-w', token]);
    },
  };
}

export function createAdminUiServer({
  port = DEFAULT_ADMIN_UI_PORT,
  base = siteApiBase(),
  envToken = process.env.ADMIN_TOKEN ?? '',
  keychain = createKeychain({ service: process.env.ADMIN_UI_KEYCHAIN_SERVICE || DEFAULT_KEYCHAIN_SERVICE }),
  fetchImpl = fetch,
  session = randomBytes(32).toString('base64url'),
  publicOrigin = process.env.ADMIN_UI_PUBLIC_ORIGIN ?? '',
} = {}) {
  const extra = parsePublicOrigin(publicOrigin);
  let token = envToken.trim();
  let tokenSource = token ? 'env' : null;
  let keychainChecked = false;

  async function currentToken() {
    if (!token && !keychainChecked) {
      keychainChecked = true;
      token = await keychain.read();
      if (token) tokenSource = 'keychain';
    }
    return token;
  }

  // `port` may be 0 in tests; the real port is known once listening.
  const listeningPort = () => server.address()?.port ?? port;
  const loopbackHosts = () => [`127.0.0.1:${listeningPort()}`, `localhost:${listeningPort()}`];
  const hosts = () => new Set([...loopbackHosts(), ...(extra ? [extra.host] : [])]);
  const origins = () => new Set([...loopbackHosts().map((h) => `http://${h}`), ...(extra ? [extra.origin] : [])]);

  function send(res, status, body, headers = {}) {
    const json = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(json);
  }

  async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw Object.assign(new Error('body_too_large'), { status: 413 });
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Object.assign(new Error('json_invalid'), { status: 400 });
    return parsed;
  }

  async function handle(req, res) {
    if (!hosts().has(String(req.headers.host ?? ''))) return send(res, 421, { ok: false, error: 'bad_host' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /' || route === 'GET /index.html') {
      const html = (await readFile(path.join(DIR, 'index.html'), 'utf8')).replace('__SESSION__', session);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      return res.end(html);
    }
    if (route === 'GET /favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(await readFile(path.join(DIR, file)));
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { ok: false, error: 'not_found' });

    const origin = req.headers.origin;
    if (origin !== undefined && !origins().has(origin)) {
      return send(res, 403, { ok: false, error: 'bad_origin' });
    }
    if (!sameSecret(req.headers['x-admin-session'], session)) return send(res, 403, { ok: false, error: 'bad_session' });

    if (route === 'GET /api/state') {
      await currentToken();
      return send(res, 200, { ok: true, tokenSource, upstream: base });
    }
    if (route === 'POST /api/token') {
      const value = String((await readJson(req)).token ?? '').trim();
      if (!value || value.length > 512) return send(res, 400, { ok: false, error: 'token_invalid' });
      await keychain.save(value);
      token = value;
      tokenSource = 'keychain';
      return send(res, 200, { ok: true, tokenSource });
    }

    const target = ROUTES[route];
    if (!target) return send(res, 404, { ok: false, error: 'not_found' });
    if (!(await currentToken())) return send(res, 401, { ok: false, error: 'token_missing' });
    const input = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readJson(req);
    const fields = pick(input, target.fields);
    const upstream = await adminRequest({
      base,
      token,
      method: req.method,
      path: target.path,
      ...(req.method === 'GET' ? { query: fields } : { body: fields }),
      fetchImpl,
    });
    return send(res, upstream.status, upstream.json ?? { ok: false, error: 'upstream_invalid' });
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (res.headersSent) return res.end();
      const status = Number.isInteger(error?.status) ? error.status : error instanceof SyntaxError ? 400 : 502;
      send(res, status, { ok: false, error: status === 502 ? 'upstream_unreachable' : (error?.message ?? 'failed') });
    });
  });
  return server;
}

/** One extra HTTPS origin, e.g. a `tailscale serve` front door. Anything else is refused at startup. */
function parsePublicOrigin(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value.replace(/\/$/, '')) {
    throw new Error(`ADMIN_UI_PUBLIC_ORIGIN must be a bare https origin: ${value}`);
  }
  return { host: url.host, origin: url.origin };
}

function portFromArgs(argv, env) {
  const index = argv.indexOf('--port');
  const value = Number(index >= 0 ? argv[index + 1] : env.PORT || DEFAULT_ADMIN_UI_PORT);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) throw new Error(`invalid port: ${value}`);
  return value;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = portFromArgs(process.argv.slice(2), process.env);
  createAdminUiServer({ port }).listen(port, '127.0.0.1', () => {
    process.stdout.write(`license admin on http://127.0.0.1:${port} → ${siteApiBase()}\n`);
  });
}
