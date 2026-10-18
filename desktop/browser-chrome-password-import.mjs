import { execFile } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rm, open } from 'node:fs/promises';
import { createWriteStream, constants } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { passwordFailure, passwordOrigin } from './browser-local-password-vault.mjs';

// Chromium's macOS KeychainKeyProvider uses v10, PBKDF2-SHA1/1003 and AES-128-CBC.
// https://github.com/chromium/chromium/blob/main/components/os_crypt/async/browser/keychain_key_provider.mm
// https://github.com/chromium/chromium/blob/main/components/os_crypt/async/common/encryptor.cc
export function decryptChromeMacPassword(encrypted, key) {
  const bytes = Buffer.from(encrypted);
  if (bytes.subarray(0, 3).toString('ascii') !== 'v10') throw passwordFailure('BROWSER_CHROME_ENCRYPTION_UNSUPPORTED', 'This Chrome password encryption format is unsupported.');
  if (bytes.length <= 3 || (bytes.length - 3) % 16 !== 0) throw passwordFailure('BROWSER_CHROME_PASSWORD_INVALID', 'The Chrome password record is invalid.');
  let clear;
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    clear = Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]);
    return new TextDecoder('utf-8', { fatal: true }).decode(clear);
  } catch { throw passwordFailure('BROWSER_CHROME_PASSWORD_INVALID', 'The Chrome password could not be decrypted.'); }
  finally { clear?.fill(0); }
}

export function chromeKeychainPassword() {
  return new Promise((resolve, reject) => {
    // No shell, environment export, console or hub IPC ever receives this output.
    execFile('/usr/bin/security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome'], { encoding: 'buffer', maxBuffer: 4096, timeout: 120_000, windowsHide: true }, (error, stdout) => {
      if (error || !stdout?.length) { stdout?.fill(0); reject(passwordFailure('BROWSER_CHROME_KEYCHAIN_DENIED', 'Chrome password access was cancelled or denied.')); return; }
      // security appends one newline; preserve any other passphrase whitespace.
      resolve(stdout.subarray(0, stdout[stdout.length - 1] === 10 ? stdout.length - 1 : stdout.length));
    });
  });
}

async function sourceInfo(file) {
  try {
    const info = await lstat(file, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256n * 1024n * 1024n) throw new Error();
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function copyReadonly(file, destination) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await pipeline(handle.createReadStream({ autoClose: false }), createWriteStream(destination, { flags: 'wx', mode: 0o600 })); }
  finally { await handle.close(); }
}
// Reads a private WAL-consistent copy; `read(db)` only ever sees the snapshot.
export async function readChromeDatabase(file, read, { busyMessage = 'Chrome passwords changed during import. Close Chrome and retry.', unavailableMessage = 'Chrome passwords could not be read. Close Chrome and retry the import.', sqliteMessage = 'This desktop version cannot read Chrome password databases.' } = {}) {
  let sqlite;
  try { sqlite = await import('node:sqlite'); } catch { throw passwordFailure('BROWSER_CHROME_SQLITE_UNAVAILABLE', sqliteMessage); }
  let directory; let snapshot;
  try {
    // Opening the original WAL database readOnly can create its -shm index.
    // Read file bytes only; SQLite opens the private copy and includes its WAL.
    for (let attempt = 0; attempt < 3; attempt++) {
      directory = await mkdtemp(join(tmpdir(), 'hama-chrome-db-'));
      const before = await Promise.all([sourceInfo(file), sourceInfo(`${file}-wal`)]);
      if (!before[0]) throw new Error();
      await copyReadonly(file, join(directory, 'snapshot.sqlite'));
      if (before[1]) await copyReadonly(`${file}-wal`, join(directory, 'snapshot.sqlite-wal'));
      const after = await Promise.all([sourceInfo(file), sourceInfo(`${file}-wal`)]);
      if (before.every((value, index) => value === after[index])) break;
      await rm(directory, { recursive: true, force: true }); directory = null;
    }
    if (!directory) throw passwordFailure('BROWSER_CHROME_DATABASE_BUSY', busyMessage);
    snapshot = new sqlite.DatabaseSync(join(directory, 'snapshot.sqlite'), { enableLoadExtension: false });
    snapshot.exec('PRAGMA query_only = ON');
    return await read(snapshot);
  } catch (error) {
    if (error.code?.startsWith('BROWSER_')) throw error;
    throw passwordFailure('BROWSER_CHROME_DATABASE_UNAVAILABLE', unavailableMessage);
  } finally { snapshot?.close(); if (directory) await rm(directory, { recursive: true, force: true }); }
}
function loginRows(file) {
  return readChromeDatabase(file, (db) => {
    const rows = db.prepare('SELECT origin_url, signon_realm, username_value, password_value FROM logins WHERE blacklisted_by_user = 0 LIMIT 4097').all();
    if (rows.length > 4096) throw passwordFailure('BROWSER_CHROME_IMPORT_LIMIT', 'This Chrome profile exceeds the password import limit.');
    return rows;
  });
}

export class ChromePasswordImporter {
  constructor({ vault, platform = process.platform, root = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome'), readKey = chromeKeychainPassword, readRows = loginRows }) {
    this.vault = vault; this.platform = platform; this.root = root; this.readKey = readKey; this.readRows = readRows;
    this.profiles = new Map();
    this.generation = 0;
  }
  beginReset() { this.generation++; this.resetting = true; }
  endReset() { this.resetting = false; }
  async listProfiles() {
    if (this.platform !== 'darwin') return { supported: false, profiles: [] };
    let state;
    try {
      const file = join(this.root, 'Local State');
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error();
      state = JSON.parse(await readFile(file, 'utf8'));
    } catch { return { supported: true, profiles: [] }; }
    const profiles = [];
    const root = await realpath(this.root);
    for (const [directory, value] of Object.entries(state.profile?.info_cache ?? {}).slice(0, 100)) {
      if (!/^(Default|Profile [0-9]+)$/.test(directory)) continue;
      try {
        const path = join(root, directory);
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) continue;
        let profile = [...this.profiles.values()].find((entry) => entry.path === path);
        if (!profile) { profile = { id: randomUUID(), path, name: String(value.name || directory).slice(0, 160) }; this.profiles.set(profile.id, profile); }
        profiles.push({ id: profile.id, name: profile.name });
      } catch {}
    }
    return { supported: true, profiles };
  }
  async importProfile({ profileId } = {}) {
    if (this.platform !== 'darwin') throw passwordFailure('BROWSER_CHROME_IMPORT_UNSUPPORTED', 'Chrome profile import is available on macOS.');
    if (this.resetting) throw passwordFailure('BROWSER_NATIVE_RESET_ACTIVE', 'Browser data is being removed. Retry the import when it finishes.');
    if (this.importing) throw passwordFailure('BROWSER_CHROME_IMPORT_ACTIVE', 'A Chrome password import is already running.');
    const profile = this.profiles.get(profileId);
    if (!profile) throw passwordFailure('BROWSER_CHROME_PROFILE_INVALID', 'Choose a current Chrome profile before importing.');
    this.importing = true;
    const generation = this.generation;
    let passphrase; let key;
    try {
      if (!await this.vault.available()) throw passwordFailure('BROWSER_PASSWORD_STORAGE_UNAVAILABLE', 'OS password storage is unavailable.');
      const info = await lstat(profile.path);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(profile.path) !== profile.path) throw passwordFailure('BROWSER_CHROME_PROFILE_INVALID', 'The selected Chrome profile changed.');
      const rows = [];
      // Chrome stores profile and Google-account passwords in separate databases.
      // Account-store rows follow profile rows, so an exact duplicate uses the
      // account-store credential deterministically in the atomic vault batch.
      for (const name of ['Login Data', 'Login Data For Account']) {
        const file = join(profile.path, name);
        let exists;
        try { exists = await lstat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!exists.isFile() || exists.isSymbolicLink()) throw passwordFailure('BROWSER_CHROME_DATABASE_UNAVAILABLE', 'The Chrome password database is invalid.');
        rows.push(...await this.readRows(file));
        if (rows.length > 4096) throw passwordFailure('BROWSER_CHROME_IMPORT_LIMIT', 'This Chrome profile exceeds the password import limit.');
      }
      const supported = rows.filter((row) => Buffer.from(row.password_value ?? []).subarray(0, 3).toString('ascii') === 'v10');
      const result = { imported: 0, skipped: 0, unsupported: rows.length - supported.length };
      if (!supported.length) return result;
      passphrase = await this.readKey();
      key = pbkdf2Sync(passphrase, 'saltysalt', 1003, 16, 'sha1');
      const credentials = [];
      for (const row of supported) {
        let origin; let password;
        try {
          if (typeof row.username_value !== 'string' || row.password_value.length > 12 * 1024 + 32) throw new Error();
          origin = passwordOrigin(row.origin_url);
          if (passwordOrigin(row.signon_realm) !== origin) throw new Error();
          password = decryptChromeMacPassword(row.password_value, key);
          if (!password) throw new Error();
          if (Buffer.byteLength(row.username_value) + Buffer.byteLength(password) > 12 * 1024) throw new Error();
        } catch { result.skipped++; continue; }
        // Only OS-encrypted records are written. The importer returns counts, never secrets.
        credentials.push({ origin, username: row.username_value, password, sourceProfile: profile.name });
      }
      try {
        if (generation !== this.generation || this.resetting) throw passwordFailure('BROWSER_CHROME_IMPORT_CANCELLED', 'The Chrome import was cancelled because browser data was removed.');
        result.imported = (await this.vault.importCredentials(credentials)).length; return result;
      }
      finally { for (const credential of credentials) credential.password = ''; }
    } finally { passphrase?.fill?.(0); key?.fill(0); this.importing = false; }
  }
}
