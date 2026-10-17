import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';

// 사이트 아이콘은 사용자 화면에만 쓴다. 허브가 쿠키 없이 직접 받아 data URI로 바꾸고 출처별로 보관한다.
export const FAVICON_MAX_DATA_URI = 16 * 1024;
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 5;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;
const MAX_CANDIDATES = 4;
const MIME = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon' };
const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/gif', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/ico', 'image/icon', 'application/octet-stream', 'binary/octet-stream']);
const PREFERRED_PIXELS = 32;

/** Only the bytes decide the format. SVG and every non-raster type are rejected. */
export function sniffImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 6) return null;
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return MIME.png;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return MIME.jpeg;
  const head = bytes.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return MIME.gif;
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return MIME.webp;
  if (bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1 && bytes.readUInt16LE(4) > 0) return MIME.ico;
  return null;
}

const contentTypeAccepted = (value) => {
  const type = String(value ?? '').split(';')[0].trim().toLowerCase();
  return !type || ACCEPTED_TYPES.has(type);
};
const dataUriLength = (mime, size) => `data:${mime};base64,`.length + Math.ceil(size / 3) * 4;

// 여러 크기를 담은 ICO는 화면에 맞는 한 장만 남겨 크기 한도 안에 넣는다.
function icoEntries(bytes) {
  const count = bytes.readUInt16LE(4);
  if (bytes.length < 6 + count * 16) return [];
  const entries = [];
  for (let index = 0; index < count; index++) {
    const at = 6 + index * 16;
    const size = bytes.readUInt32LE(at + 8), offset = bytes.readUInt32LE(at + 12);
    if (!size || offset < 6 + count * 16 || offset + size > bytes.length) continue;
    entries.push({ pixels: bytes[at] || 256, header: bytes.subarray(at, at + 12), image: bytes.subarray(offset, offset + size) });
  }
  return entries;
}
const singleIco = (entry) => {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  entry.header.copy(header, 6); header.writeUInt32LE(entry.image.length, 14); header.writeUInt32LE(22, 18);
  return Buffer.concat([header, entry.image]);
};
const pixelRank = (pixels) => pixels >= PREFERRED_PIXELS ? pixels : 1000 + PREFERRED_PIXELS - pixels;

/** Validates fetched or browser-provided bytes and returns a data URI within the display budget, or null. */
export function iconDataUri(bytes, contentType) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES || !contentTypeAccepted(contentType)) return null;
  const mime = sniffImage(bytes);
  if (!mime) return null;
  if (mime === MIME.ico) {
    const entries = icoEntries(bytes);
    if (!entries.length) return null;
    const ordered = entries.length === 1 ? [bytes] : entries.sort((a, b) => pixelRank(a.pixels) - pixelRank(b.pixels)).map(singleIco);
    const fitting = ordered.find((candidate) => dataUriLength(mime, candidate.length) <= FAVICON_MAX_DATA_URI);
    return fitting ? `data:${mime};base64,${fitting.toString('base64')}` : null;
  }
  return dataUriLength(mime, bytes.length) <= FAVICON_MAX_DATA_URI ? `data:${mime};base64,${bytes.toString('base64')}` : null;
}

/** Accepts only base64 raster data URIs. The declared type is checked, the bytes decide the result. */
export function dataUriBytes(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_BYTES * 4 / 3) + 200) return null;
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(?:;[a-z0-9=.+-]+)*;base64,([a-z0-9+/=\s]*)$/i.exec(value);
  if (!match || !match[1].toLowerCase().startsWith('image/') || !contentTypeAccepted(match[1])) return null;
  const bytes = Buffer.from(match[2], 'base64');
  return bytes.length && bytes.length <= MAX_BYTES ? { bytes, contentType: match[1] } : null;
}

const allowedURL = (value, isWorkspace) => {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === 'https:' || url.protocol === 'http:' && isWorkspace?.(url.origin)) return url;
  } catch {}
  return null;
};

/** HTTPS origins only; HTTP stays limited to configured workspace previews. */
export function faviconOrigin(value, isWorkspace) {
  const url = allowedURL(value, isWorkspace);
  return url ? url.origin : null;
}

const sizeOf = (sizes) => {
  const values = String(sizes ?? '').toLowerCase().split(/\s+/).map((entry) => /^(\d{1,4})x(\d{1,4})$/.exec(entry)).filter(Boolean).map((match) => Math.max(Number(match[1]), Number(match[2])));
  return values.length ? values.sort((a, b) => pixelRank(a) - pixelRank(b))[0] : null;
};

/**
 * Orders the page's declared icons (smallest suitable first) and ends with /favicon.ico.
 * Links come from the page the browser loaded; data: URIs pass through for the same byte checks.
 */
export function faviconCandidates(pageUrl, links = [], { isWorkspace, fallback = true } = {}) {
  const page = allowedURL(pageUrl, isWorkspace);
  if (!page) return [];
  const ranked = [];
  for (const [index, link] of (Array.isArray(links) ? links : []).slice(0, 16).entries()) {
    const href = typeof link === 'string' ? link : link?.href;
    if (typeof href !== 'string' || !href.trim() || href.length > Math.ceil(MAX_BYTES * 4 / 3) + 200) continue;
    const type = String(link?.type ?? '').toLowerCase();
    if (type.includes('svg')) continue;
    if (/^\s*data:/i.test(href)) { if (dataUriBytes(href.trim())) ranked.push({ url: href.trim(), rank: -1, index }); continue; }
    let url; try { url = new URL(href.trim(), page); } catch { continue; }
    if (!allowedURL(url.href, isWorkspace) || /\.svgz?$/i.test(url.pathname)) continue;
    const touch = /apple-touch-icon/i.test(String(link?.rel ?? ''));
    const pixels = sizeOf(link?.sizes) ?? (touch ? 180 : null);
    ranked.push({ url: url.href, rank: pixels === null ? 500 : pixelRank(pixels), index });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  const result = [...new Set(ranked.map((entry) => entry.url))];
  if (fallback) { const ico = `${page.origin}/favicon.ico`; if (!result.includes(ico)) result.push(ico); }
  return result.slice(0, MAX_CANDIDATES + 1);
}

/** Extracts icon links from the first part of an HTML document. */
export function iconLinksFromHtml(html) {
  const links = [];
  for (const tag of String(html ?? '').slice(0, MAX_BYTES).match(/<link\b[^>]*>/gi) ?? []) {
    const attributes = {};
    for (const match of tag.matchAll(/([a-z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) attributes[match[1].toLowerCase()] = (match[2] ?? match[3] ?? match[4] ?? '').replace(/&amp;/g, '&');
    if (/(?:^|\s)(?:icon|apple-touch-icon|apple-touch-icon-precomposed)(?:\s|$)/i.test(attributes.rel ?? '') && attributes.href) links.push({ href: attributes.href, rel: attributes.rel, sizes: attributes.sizes, type: attributes.type });
    if (links.length >= 16) break;
  }
  return links;
}

/**
 * One pinned GET per hop. Every redirect is resolved through the browser network guard again
 * (public addresses only, HTTP only for configured workspace origins) and through `authorize`, the
 * same site policy the tab's own requests pass. No cookies or credentials are sent.
 */
async function fetchLimited(url, { resolve, authorize, accept, maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS, maxRedirects = MAX_REDIRECTS, isWorkspace }) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  timer.unref?.();
  try {
    let current = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (!allowedURL(current, isWorkspace) || authorize && !await authorize(current)) return null;
      const target = await resolve(current);
      if (abort.signal.aborted) return null;
      const response = await requestOnce(target, accept, abort.signal);
      if (response.status >= 300 && response.status < 400 && response.headers.location) {
        response.body.destroy();
        try { current = new URL(response.headers.location, current).href; } catch { return null; }
        continue;
      }
      if (response.status !== 200 || Number(response.headers['content-length'] ?? 0) > maxBytes) { response.body.destroy(); return null; }
      const chunks = []; let total = 0;
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > maxBytes) { response.body.destroy(); return null; }
        chunks.push(chunk);
      }
      return { bytes: Buffer.concat(chunks), contentType: String(response.headers['content-type'] ?? ''), url: current };
    }
    return null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function requestOnce(target, accept, signal) {
  const { url, address, family } = target;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: url.protocol, hostname, port: target.port ?? (url.port || undefined), path: `${url.pathname}${url.search}`, method: 'GET', agent: false, signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; HamaEditor)', accept },
      lookup: (_hostname, options, callback) => (options?.all ? callback(null, [{ address, family }]) : callback(null, address, family)),
      ...(url.protocol === 'https:' && net.isIP(hostname) === 0 ? { servername: hostname } : {}),
    }, (response) => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response }));
    request.once('error', reject);
    request.end();
  });
}

/**
 * Origin-keyed icon cache under <browser data dir>/favicons (dir 0700, files 0600).
 * `peek` is synchronous for event publishing; `discover` fetches at most once per origin at a time.
 */
export function createFaviconCache({ dir, resolve, isWorkspace, now = Date.now, ttlMs = TTL_MS, missTtlMs = MISS_TTL_MS, maxEntries = MAX_ENTRIES, timeoutMs = TIMEOUT_MS } = {}) {
  if (!dir || typeof resolve !== 'function') throw new TypeError('Favicon cache needs a directory and a network guard');
  const memory = new Map();
  const inflight = new Map();
  let generation = 0;
  let writes = Promise.resolve();
  const fileFor = (origin) => path.join(dir, `${crypto.createHash('sha256').update(origin).digest('hex').slice(0, 40)}.json`);
  const fresh = (entry) => entry && now() - entry.fetchedAt < (entry.icon ? ttlMs : missTtlMs);
  const valid = (icon) => icon === null || typeof icon === 'string' && icon.startsWith('data:image/') && icon.length <= FAVICON_MAX_DATA_URI && !!dataUriBytes(icon);

  async function read(origin) {
    const cached = memory.get(origin);
    if (cached) return fresh(cached) ? cached : null;
    try {
      const stored = JSON.parse(await fs.readFile(fileFor(origin), 'utf8'));
      if (stored?.v !== 1 || stored.origin !== origin || !Number.isFinite(stored.fetchedAt) || !valid(stored.icon)) return null;
      const entry = { icon: stored.icon, fetchedAt: stored.fetchedAt };
      if (!fresh(entry)) return null;
      memory.set(origin, entry);
      return entry;
    } catch { return null; }
  }

  function write(origin, icon, ownGeneration) {
    if (ownGeneration !== generation) return Promise.resolve();
    const entry = { icon, fetchedAt: now() };
    memory.set(origin, entry);
    if (memory.size > maxEntries) memory.delete(memory.keys().next().value);
    writes = writes.catch(() => {}).then(async () => {
      if (ownGeneration !== generation) return;
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.chmod(dir, 0o700).catch(() => {});
      const file = fileFor(origin), temp = `${file}.${crypto.randomBytes(6).toString('hex')}.part`;
      await fs.writeFile(temp, JSON.stringify({ v: 1, origin, icon, fetchedAt: entry.fetchedAt }), { mode: 0o600, flag: 'wx' });
      if (ownGeneration !== generation) { await fs.rm(temp, { force: true }); return; }
      await fs.rename(temp, file);
      await evict();
    }).catch(() => {});
    return writes;
  }

  async function evict() {
    const names = (await fs.readdir(dir)).filter((name) => /^[a-f0-9]{40}\.json$/.test(name));
    if (names.length <= maxEntries) return;
    const stats = await Promise.all(names.map(async (name) => ({ name, mtime: (await fs.stat(path.join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })));
    stats.sort((a, b) => a.mtime - b.mtime);
    for (const { name } of stats.slice(0, names.length - maxEntries)) await fs.rm(path.join(dir, name), { force: true });
  }

  async function firstIcon(candidates, authorize) {
    let attempts = 0;
    for (const candidate of candidates) {
      if (/^data:/i.test(candidate)) {
        const decoded = dataUriBytes(candidate);
        const icon = decoded && iconDataUri(decoded.bytes, decoded.contentType);
        if (icon) return icon;
        continue;
      }
      if (attempts++ >= MAX_CANDIDATES) break;
      const fetched = await fetchLimited(candidate, { resolve, authorize, isWorkspace, timeoutMs, accept: 'image/png,image/x-icon,image/webp,image/gif,image/jpeg;q=0.9,*/*;q=0.1' });
      const icon = fetched && iconDataUri(fetched.bytes, fetched.contentType);
      if (icon) return icon;
    }
    return null;
  }

  function once(origin, work) {
    if (inflight.has(origin)) return inflight.get(origin);
    const ownGeneration = generation;
    const task = (async () => {
      const cached = await read(origin);
      if (cached) return cached.icon;
      const icon = await work();
      await write(origin, icon, ownGeneration);
      return ownGeneration === generation ? icon : null;
    })().catch(() => null).finally(() => inflight.delete(origin));
    inflight.set(origin, task);
    return task;
  }

  return {
    /** Memory only: string, null for a known miss, undefined when unknown. */
    peek(origin) { const entry = memory.get(origin); return entry && fresh(entry) ? entry.icon : undefined; },
    /** Cached icon without network access: string, null for a known miss, undefined when unknown. */
    async get(origin) { if (!origin) return undefined; return (await read(origin))?.icon; },
    /** Icons declared by a page the browser loaded. `authorize(url)` applies the tab's site policy to every hop. */
    discover(origin, candidates, { authorize } = {}) {
      if (!origin || !Array.isArray(candidates) || !candidates.length) return Promise.resolve(null);
      return once(origin, () => firstIcon(candidates, authorize));
    },
    /** First-party lookup for an origin the user already works with: /favicon.ico, then the home page's links. */
    discoverOrigin(origin) {
      if (faviconOrigin(origin, isWorkspace) !== origin) return Promise.resolve(null);
      return once(origin, async () => {
        const fallback = await firstIcon([`${origin}/favicon.ico`]);
        if (fallback) return fallback;
        const page = await fetchLimited(`${origin}/`, { resolve, isWorkspace, timeoutMs, accept: 'text/html,application/xhtml+xml' });
        if (!page || !/^(?:text\/html|application\/xhtml\+xml)\b/i.test(page.contentType)) return null;
        return firstIcon(faviconCandidates(page.url, iconLinksFromHtml(page.bytes.toString('utf8')), { isWorkspace, fallback: false }));
      });
    },
    /** Stops pending writes from landing and forgets memory. Browser cleanup removes the directory. */
    async clear() {
      generation++;
      memory.clear();
      await Promise.allSettled([...inflight.values()]);
      await writes.catch(() => {});
    },
  };
}
