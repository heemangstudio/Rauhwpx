import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import { isPublicAddress } from './download-manager.mjs';

export function browserNetworkError(code, message) {
  return Object.assign(new Error(message), { code, retryable: false });
}

/** Exact workspace origins are configuration owned by the hub, never tool arguments. */
export function createBrowserNetworkGuard({ workspaceTargets = [], lookup = dns.lookup } = {}) {
  const allowed = new Set(workspaceTargets.map((entry) => new URL(typeof entry === 'string' ? entry : entry.origin).origin));
  const parse = (value) => {
    let url;
    try { url = new URL(value); } catch { throw browserNetworkError('BROWSER_URL_INVALID', 'Enter a complete HTTPS address.'); }
    if (url.username || url.password) throw browserNetworkError('BROWSER_URL_INVALID', 'Browser addresses cannot contain credentials.');
    if (!['https:', 'http:'].includes(url.protocol)) throw browserNetworkError('BROWSER_URL_BLOCKED', 'Only HTTPS research pages and configured workspace previews can be opened.');
    if (url.protocol !== 'https:' && !allowed.has(url.origin)) throw browserNetworkError('BROWSER_URL_BLOCKED', 'HTTP is available only for a configured workspace preview.');
    return url;
  };
  const resolve = async (value) => {
    const url = parse(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || (!allowed.has(url.origin) && addresses.some(({ address }) => !isPublicAddress(address)))) {
      throw browserNetworkError('BROWSER_ADDRESS_BLOCKED', 'Private, local, and reserved network destinations are blocked. Configure a workspace preview explicitly.');
    }
    return { url, ...addresses[0], port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) };
  };
  return { parse, resolve, isWorkspace: (value) => allowed.has(parse(value).origin) };
}

/** Chromium tunnels through pinned sockets, so a second DNS lookup cannot rebind to the hub. */
export async function createBrowserNetworkProxy(guard, { maxConnections = 128, timeoutMs = 30_000 } = {}) {
  const username = crypto.randomBytes(18).toString('hex');
  const password = crypto.randomBytes(24).toString('hex');
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const sockets = new Set();
  let closed = false;
  const authorize = (request, socket) => {
    if (closed || request.headers['proxy-authorization'] !== authorization) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="HamaEditor"\r\nContent-Length: 0\r\n\r\n');
      return false;
    }
    return true;
  };
  const server = http.createServer(async (request, response) => {
    if (!authorize(request, response.socket)) return;
    try {
      const target = await guard.resolve(request.url);
      if (target.url.protocol !== 'http:') throw browserNetworkError('BROWSER_PROXY_INVALID', 'HTTPS requests must use an encrypted tunnel.');
      const headers = { ...request.headers, host: target.url.host };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const upstream = http.request({ hostname: target.address, port: target.port, method: request.method, path: `${target.url.pathname}${target.url.search}`, headers, timeout: timeoutMs }, (result) => {
        response.writeHead(result.statusCode ?? 502, result.headers);
        result.pipe(response);
      });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      request.on('aborted', () => upstream.destroy());
      request.pipe(upstream);
    } catch { response.writeHead(403); response.end('Blocked browser destination'); }
  });
  server.on('connection', (socket) => {
    if (sockets.size >= maxConnections || closed) { socket.destroy(); return; }
    sockets.add(socket);
    socket.setTimeout(timeoutMs * 2, () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  server.on('connect', async (request, client, head) => {
    if (!authorize(request, client)) return;
    try {
      let target;
      try { target = await guard.resolve(`https://${request.url}/`); }
      catch (failure) {
        // Chromium also uses CONNECT for ws on an explicitly configured HTTP preview.
        const preview = `http://${request.url}/`;
        if (!guard.isWorkspace?.(preview)) throw failure;
        target = await guard.resolve(preview);
      }
      if (closed) { client.destroy(); return; }
      const upstream = net.connect({ host: target.address, port: target.port, family: target.family });
      sockets.add(upstream);
      upstream.setTimeout(timeoutMs * 2, () => upstream.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
      client.on('close', () => upstream.destroy());
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); }
  });
  server.on('upgrade', async (request, client, head) => {
    if (!authorize(request, client)) return;
    try {
      const target = await guard.resolve(request.url.replace(/^ws:/, 'http:'));
      if (closed || target.url.protocol !== 'http:' || request.headers.upgrade?.toLowerCase() !== 'websocket') throw browserNetworkError('BROWSER_PROXY_INVALID', 'Unsupported browser upgrade');
      const upstream = net.connect({ host: target.address, port: target.port, family: target.family });
      sockets.add(upstream);
      upstream.setTimeout(timeoutMs * 2, () => upstream.destroy());
      upstream.once('connect', () => {
        const headers = { ...request.headers, host: target.url.host };
        delete headers['proxy-authorization']; delete headers['proxy-connection'];
        upstream.write(`GET ${target.url.pathname}${target.url.search} HTTP/1.1\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`);
        if (head.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
      client.on('close', () => upstream.destroy());
    } catch { client.destroy(); }
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    settings: { server: `http://127.0.0.1:${server.address().port}`, username, password, bypass: '<-loopback>' },
    async close() {
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
