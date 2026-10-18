import assert from 'node:assert/strict';
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ChromePasswordImporter } from '../desktop/browser-chrome-password-import.mjs';
import { ChromeCookieImporter, chromeCookieExpiry, decryptChromeMacCookie } from '../desktop/browser-chrome-cookie-import.mjs';

const PASSPHRASE = 'fixture-keychain-key';
const NOW_MS = 1_800_000_000_000;
const chromeTime = (unixSeconds) => BigInt(unixSeconds) * 1_000_000n + 11_644_473_600_000_000n;
function encryptCookie(value, hostKey, version) {
  const key = pbkdf2Sync(PASSPHRASE, 'saltysalt', 1003, 16, 'sha1');
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  const clear = Buffer.concat([version >= 24 ? createHash('sha256').update(hostKey).digest() : Buffer.alloc(0), Buffer.from(value, 'utf8')]);
  return Buffer.concat([Buffer.from('v10'), cipher.update(clear), cipher.final()]);
}
async function fixture(t, { version = 24, legacyLocation = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hama-chrome-cookies-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const chrome = join(root, 'Chrome'); const profile = join(chrome, 'Default');
  await mkdir(join(profile, 'Network'), { recursive: true });
  await writeFile(join(chrome, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Test profile' } } } }));
  const db = new DatabaseSync(legacyLocation ? join(profile, 'Cookies') : join(profile, 'Network', 'Cookies'));
  t.after(() => db.close());
  db.exec(`PRAGMA journal_mode = WAL; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, has_expires INTEGER, is_persistent INTEGER)`);
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('version', String(version));
  const insert = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const add = (hostKey, name, value, { expires = 1_900_000_000, secure = 1, httpOnly = 1, sameSite = 1, plain = false } = {}) => insert.run(
    hostKey, name, plain ? value : '', plain ? Buffer.alloc(0) : encryptCookie(value, hostKey, version), '/', expires ? chromeTime(expires) : 0n, secure, httpOnly, sameSite, expires ? 1 : 0, expires ? 1 : 0);
  const passwords = new ChromePasswordImporter({ vault: null, platform: 'darwin', root: chrome });
  const profileId = (await passwords.listProfiles()).profiles[0].id;
  const calls = []; let flushed = 0; let keyReads = 0;
  const host = { session: { cookies: { set: async (details) => { assert.equal(flushed, 0); calls.push({ ...details }); }, flushStore: async () => { flushed++; } } } };
  const importer = new ChromeCookieImporter({ host, profiles: passwords, platform: 'darwin', now: () => NOW_MS, readKey: async () => { keyReads++; return Buffer.from(PASSPHRASE); } });
  return { add, importer, profileId, calls, flushes: () => flushed, keyReads: () => keyReads };
}

test('Chrome cookie decryption handles both meta versions and rejects a foreign host digest', () => {
  const key = pbkdf2Sync(PASSPHRASE, 'saltysalt', 1003, 16, 'sha1');
  assert.equal(decryptChromeMacCookie(encryptCookie('legacy-value', '.example.com', 23), key, { hostKey: '.example.com', metaVersion: 23 }), 'legacy-value');
  assert.equal(decryptChromeMacCookie(encryptCookie('bound-value', '.example.com', 24), key, { hostKey: '.example.com', metaVersion: 24 }), 'bound-value');
  assert.throws(() => decryptChromeMacCookie(encryptCookie('bound-value', '.example.com', 24), key, { hostKey: '.attacker.com', metaVersion: 24 }), { code: 'BROWSER_CHROME_COOKIE_INVALID' });
  assert.throws(() => decryptChromeMacCookie(Buffer.from('v20unsupported'), key, { metaVersion: 24 }), { code: 'BROWSER_CHROME_ENCRYPTION_UNSUPPORTED' });
  assert.equal(chromeCookieExpiry(chromeTime(1_900_000_000)), 1_900_000_000);
  assert.equal(chromeCookieExpiry(Number(chromeTime(1_700_000_000))), 1_700_000_000);
  assert.equal(chromeCookieExpiry(0), -1);
  assert.equal(chromeCookieExpiry(undefined), -1);
});

for (const version of [23, 24]) {
  test(`Chrome cookie import (meta ${version}) sets only selected, live cookies with their exact scope`, async (t) => {
    const { add, importer, profileId, calls, flushes, keyReads } = await fixture(t, { version });
    add('.example.com', 'sid', 'secret-domain-value', { sameSite: 0 });
    add('app.example.com', 'host', 'secret-host-value', { expires: 0, secure: 0, httpOnly: 0, sameSite: -1 });
    add('.example.com', 'old', 'secret-expired-value', { expires: 1_700_000_000 });
    add('.example.com', 'lax', 'secret-lax-none', { secure: 0, sameSite: 0 });
    add('www.naver.co.kr', 'nid', 'secret-naver-value');
    add('.other.invalid', 'other', 'secret-other-value');
    const before = keyReads();
    const listed = await importer.listSites({ profileId });
    assert.equal(keyReads(), before);
    assert.deepEqual(listed, { supported: true, sites: [{ domain: 'example.com', count: 3 }, { domain: 'naver.co.kr', count: 1 }, { domain: 'other.invalid', count: 1 }] });
    const result = await importer.importSites({ profileId, domains: ['example.com', 'naver.co.kr'] });
    assert.deepEqual(result, { imported: 3, skipped: 2, unsupported: 0, domains: ['example.com', 'naver.co.kr'] });
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.equal(keyReads(), before + 1);
    assert.equal(flushes(), 1);
    const byName = Object.fromEntries(calls.map((call) => [call.name, call]));
    assert.deepEqual(Object.keys(byName).sort(), ['host', 'nid', 'sid']);
    assert.deepEqual(byName.sid, { url: 'https://example.com/', name: 'sid', value: 'secret-domain-value', path: '/', secure: true, httpOnly: true, domain: '.example.com', expirationDate: 1_900_000_000, sameSite: 'no_restriction' });
    assert.deepEqual(byName.host, { url: 'http://app.example.com/', name: 'host', value: 'secret-host-value', path: '/', secure: false, httpOnly: false, sameSite: 'unspecified' });
    assert.equal(byName.nid.url, 'https://www.naver.co.kr/');
    assert.equal('domain' in byName.nid, false);
    assert.equal(byName.nid.sameSite, 'lax');
  });
}

test('Chrome cookie import falls back to the legacy store, survives rejected cookies and validates input', async (t) => {
  const { add, importer, profileId, calls, flushes, keyReads } = await fixture(t, { legacyLocation: true });
  add('.example.com', 'plain', 'plain-value', { plain: true });
  add('.example.com', 'rejected', 'rejected-value');
  add('.example.com', 'kept', 'kept-value');
  const set = importer.host.session.cookies.set;
  importer.host.session.cookies.set = async (details) => { if (details.name === 'rejected') throw new Error('Synthetic rejection'); return set(details); };
  assert.deepEqual((await importer.listSites({ profileId })).sites, [{ domain: 'example.com', count: 3 }]);
  await assert.rejects(importer.importSites({ profileId, domains: [] }), { code: 'BROWSER_CHROME_DOMAINS_INVALID' });
  await assert.rejects(importer.importSites({ profileId, domains: ['www.example.com'] }), { code: 'BROWSER_CHROME_DOMAINS_INVALID' });
  await assert.rejects(importer.importSites({ profileId: 'unknown', domains: ['example.com'] }), { code: 'BROWSER_CHROME_PROFILE_INVALID' });
  assert.deepEqual(await importer.importSites({ profileId, domains: ['example.com'] }), { imported: 2, skipped: 1, unsupported: 0, domains: ['example.com'] });
  assert.deepEqual(calls.map((call) => call.value).sort(), ['kept-value', 'plain-value']);
  assert.equal(flushes(), 1);
  assert.equal(keyReads(), 1);
});

test('Chrome cookie import cancels when a reset begins during the keychain prompt', async (t) => {
  const { add, importer, profileId, calls } = await fixture(t);
  add('.example.com', 'sid', 'secret-value');
  importer.readKey = async () => { importer.beginReset(); return Buffer.from(PASSPHRASE); };
  await assert.rejects(importer.importSites({ profileId, domains: ['example.com'] }), { code: 'BROWSER_CHROME_IMPORT_CANCELLED' });
  assert.equal(calls.length, 0);
  importer.endReset();
  const linux = new ChromeCookieImporter({ host: importer.host, profiles: importer.profiles, platform: 'linux' });
  assert.deepEqual(await linux.listSites({ profileId }), { supported: false, sites: [] });
  await assert.rejects(linux.importSites({ profileId, domains: ['example.com'] }), { code: 'BROWSER_CHROME_IMPORT_UNSUPPORTED' });
});
