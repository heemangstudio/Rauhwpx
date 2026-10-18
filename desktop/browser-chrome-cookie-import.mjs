import { createDecipheriv, createHash, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { passwordFailure } from './browser-local-password-vault.mjs';
import { chromeKeychainPassword, readChromeDatabase } from './browser-chrome-password-import.mjs';

const ROW_LIMIT = 20_000;
// Microseconds between 1601-01-01 (Windows FILETIME epoch Chrome uses) and 1970-01-01.
const EPOCH_DELTA_US = 11_644_473_600_000_000n;
const SUFFIXES = new Set(['co.kr', 'or.kr', 'go.kr', 'ac.kr', 'ne.kr', 're.kr', 'co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au', 'co.jp', 'ne.jp', 'or.jp', 'com.cn', 'com.br', 'co.nz', 'co.in', 'com.tw', 'com.hk', 'com.sg']);
const SAME_SITE = { 0: 'no_restriction', 1: 'lax', 2: 'strict' };
const DATABASE_MESSAGES = { busyMessage: 'Chrome cookies changed during import. Close Chrome and retry.', unavailableMessage: 'Chrome cookies could not be read. Close Chrome and retry the import.', sqliteMessage: 'This desktop version cannot read Chrome cookie databases.' };

// Same v10 envelope as passwords. Cookie DB version 24+ prefixes the plaintext
// with SHA-256(host_key) to bind each value to its domain.
// https://github.com/chromium/chromium/blob/main/net/extras/sqlite/sqlite_persistent_cookie_store.cc
export function decryptChromeMacCookie(encrypted, key, { hostKey, metaVersion } = {}) {
  const bytes = Buffer.from(encrypted);
  if (bytes.subarray(0, 3).toString('ascii') !== 'v10') throw passwordFailure('BROWSER_CHROME_ENCRYPTION_UNSUPPORTED', 'This Chrome cookie encryption format is unsupported.');
  if (bytes.length <= 3 || (bytes.length - 3) % 16 !== 0) throw passwordFailure('BROWSER_CHROME_COOKIE_INVALID', 'The Chrome cookie record is invalid.');
  let clear; let digest;
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    clear = Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]);
    let value = clear;
    if (metaVersion >= 24) {
      digest = createHash('sha256').update(String(hostKey ?? ''), 'utf8').digest();
      if (clear.length < 32 || !timingSafeEqual(clear.subarray(0, 32), digest)) throw new Error();
      value = clear.subarray(32);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch { throw passwordFailure('BROWSER_CHROME_COOKIE_INVALID', 'The Chrome cookie could not be decrypted.'); }
  finally { clear?.fill(0); digest?.fill(0); }
}

// Chrome stores microseconds since 1601-01-01 UTC; Electron wants Unix seconds. -1 = session cookie.
export function chromeCookieExpiry(expiresUtc) {
  let value;
  try { value = BigInt(expiresUtc ?? 0); } catch { return -1; }
  if (value <= 0n) return -1;
  return Number(value - EPOCH_DELTA_US) / 1e6;
}

export function registrableDomain(host) {
  const name = String(host ?? '').toLowerCase().replace(/^\./, '');
  if (!name || name === 'localhost' || name.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return name;
  const labels = name.split('.');
  if (labels.length <= 2) return name;
  return labels.slice(SUFFIXES.has(labels.slice(-2).join('.')) ? -3 : -2).join('.');
}

function cookieRows(file, { full = false } = {}) {
  return readChromeDatabase(file, (db) => {
    const statement = db.prepare(full
      ? 'SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, has_expires, is_persistent FROM cookies LIMIT 20001'
      : 'SELECT host_key, expires_utc, is_persistent FROM cookies LIMIT 20001');
    // expires_utc exceeds Number.MAX_SAFE_INTEGER for current dates.
    statement.setReadBigInts(true);
    const rows = statement.all();
    if (rows.length > ROW_LIMIT) throw passwordFailure('BROWSER_CHROME_IMPORT_LIMIT', 'This Chrome profile exceeds the cookie import limit.');
    const meta = full ? db.prepare("SELECT value FROM meta WHERE key = 'version'").get() : null;
    return { version: Number.parseInt(meta?.value ?? '0', 10) || 0, rows };
  }, DATABASE_MESSAGES);
}

function expired(row, nowSeconds) {
  const expiry = chromeCookieExpiry(row.expires_utc);
  return Number(row.is_persistent ?? 1) !== 0 && expiry >= 0 && expiry <= nowSeconds;
}

export class ChromeCookieImporter {
  constructor({ host, profiles, platform = process.platform, readKey = chromeKeychainPassword, readRows = cookieRows, now = Date.now }) {
    this.host = host; this.profiles = profiles; this.platform = platform; this.readKey = readKey; this.readRows = readRows; this.now = now;
    this.generation = 0;
  }
  beginReset() { this.generation++; this.resetting = true; }
  endReset() { this.resetting = false; }
  async cookieFile(profileId) {
    const profile = this.profiles?.profiles?.get(profileId);
    if (!profile) throw passwordFailure('BROWSER_CHROME_PROFILE_INVALID', 'Choose a current Chrome profile before importing.');
    const info = await lstat(profile.path).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink() || await realpath(profile.path) !== profile.path) throw passwordFailure('BROWSER_CHROME_PROFILE_INVALID', 'The selected Chrome profile changed.');
    // Chrome 96+ moved the cookie store under Network/; older profiles keep it at the root.
    for (const parts of [['Network', 'Cookies'], ['Cookies']]) {
      const file = join(profile.path, ...parts);
      let exists;
      try {
        if (parts.length > 1) { const parent = await lstat(join(profile.path, parts[0])); if (!parent.isDirectory() || parent.isSymbolicLink()) throw passwordFailure('BROWSER_CHROME_DATABASE_UNAVAILABLE', 'The Chrome cookie database is invalid.'); }
        exists = await lstat(file);
      } catch (error) { if (error.code === 'ENOENT') continue; if (error.code?.startsWith('BROWSER_')) throw error; throw passwordFailure('BROWSER_CHROME_DATABASE_UNAVAILABLE', 'The Chrome cookie database is invalid.'); }
      if (!exists.isFile() || exists.isSymbolicLink()) throw passwordFailure('BROWSER_CHROME_DATABASE_UNAVAILABLE', 'The Chrome cookie database is invalid.');
      return file;
    }
    return null;
  }
  async listSites({ profileId } = {}) {
    if (this.platform !== 'darwin') return { supported: false, sites: [] };
    const file = await this.cookieFile(profileId);
    if (!file) return { supported: true, sites: [] };
    const { rows } = await this.readRows(file, { full: false });
    const nowSeconds = this.now() / 1000; const counts = new Map();
    for (const row of rows) {
      if (typeof row.host_key !== 'string' || expired(row, nowSeconds)) continue;
      const domain = registrableDomain(row.host_key);
      if (domain) counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
    const sites = [...counts].map(([domain, count]) => ({ domain, count }));
    return { supported: true, sites: sites.sort((a, b) => b.count - a.count || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0)) };
  }
  async importSites({ profileId, domains } = {}) {
    if (this.platform !== 'darwin') throw passwordFailure('BROWSER_CHROME_IMPORT_UNSUPPORTED', 'Chrome profile import is available on macOS.');
    if (this.resetting) throw passwordFailure('BROWSER_NATIVE_RESET_ACTIVE', 'Browser data is being removed. Retry the import when it finishes.');
    if (this.importing) throw passwordFailure('BROWSER_CHROME_IMPORT_ACTIVE', 'A Chrome cookie import is already running.');
    if (!Array.isArray(domains) || !domains.length || domains.length > 500 || !domains.every((domain) => typeof domain === 'string' && domain.length <= 253 && /^[a-z0-9.:[\]-]+$/.test(domain) && registrableDomain(domain) === domain)) {
      throw passwordFailure('BROWSER_CHROME_DOMAINS_INVALID', 'Choose the sites to import.');
    }
    const selected = new Set(domains);
    this.importing = true;
    const generation = this.generation;
    let passphrase; let key;
    try {
      const file = await this.cookieFile(profileId);
      const result = { imported: 0, skipped: 0, unsupported: 0, domains: [] };
      if (!file) return result;
      const { version, rows } = await this.readRows(file, { full: true });
      const nowSeconds = this.now() / 1000;
      const candidates = [];
      for (const row of rows) {
        if (typeof row.host_key !== 'string' || !selected.has(registrableDomain(row.host_key))) continue;
        if (expired(row, nowSeconds)) { result.skipped++; continue; }
        const encrypted = Buffer.from(row.encrypted_value ?? []);
        if (encrypted.length && encrypted.subarray(0, 3).toString('ascii') !== 'v10') { result.unsupported++; continue; }
        candidates.push({ row, encrypted: encrypted.length ? encrypted : null });
      }
      if (candidates.some(({ encrypted }) => encrypted)) {
        passphrase = await this.readKey();
        key = pbkdf2Sync(passphrase, 'saltysalt', 1003, 16, 'sha1');
      }
      const cancelled = () => generation !== this.generation || this.resetting;
      if (cancelled()) throw passwordFailure('BROWSER_CHROME_IMPORT_CANCELLED', 'The Chrome import was cancelled because browser data was removed.');
      const imported = new Set();
      for (const { row, encrypted } of candidates) {
        let details;
        try {
          if (encrypted && encrypted.length > 8 * 1024) throw new Error();
          const value = encrypted ? decryptChromeMacCookie(encrypted, key, { hostKey: row.host_key, metaVersion: version }) : row.value;
          const { host_key: hostKey, name, path } = row;
          const hostname = hostKey.replace(/^\./, '');
          if (typeof name !== 'string' || typeof value !== 'string' || !(name || value) || name.length + value.length > 4096) throw new Error();
          if (/[\x00-\x1f\x7f;=]/.test(name) || /[\x00-\x1f\x7f;]/.test(value) || !/^[a-z0-9.:[\]_-]+$/i.test(hostname)) throw new Error();
          if (typeof path !== 'string' || !path.startsWith('/') || /[\x00-\x1f\x7f;]/.test(path) || path.length > 1024) throw new Error();
          const secure = Number(row.is_secure) !== 0;
          const sameSite = SAME_SITE[Number(row.samesite)] ?? 'unspecified';
          if (sameSite === 'no_restriction' && !secure) throw new Error();
          const expiry = Number(row.is_persistent) !== 0 ? chromeCookieExpiry(row.expires_utc) : -1;
          const urlHost = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
          details = {
            url: `${secure ? 'https' : 'http'}://${urlHost}${path}`, name, value, path, secure, httpOnly: Number(row.is_httponly) !== 0,
            // Host-only cookies omit domain so Electron keeps their exact-host scope.
            ...(hostKey.startsWith('.') ? { domain: hostKey } : {}),
            ...(expiry >= 0 ? { expirationDate: expiry } : {}),
            sameSite,
          };
        } catch { result.skipped++; continue; }
        if (cancelled()) throw passwordFailure('BROWSER_CHROME_IMPORT_CANCELLED', 'The Chrome import was cancelled because browser data was removed.');
        try { await this.host.session.cookies.set(details); result.imported++; imported.add(registrableDomain(row.host_key)); }
        catch { result.skipped++; }
        finally { details.value = ''; }
      }
      await this.host.session.cookies.flushStore();
      // Counts and domains only; cookie names and values never leave this method.
      result.domains = [...imported].sort();
      return result;
    } finally { passphrase?.fill?.(0); key?.fill(0); this.importing = false; }
  }
}
