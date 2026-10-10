import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function passwordFailure(code, message) { return Object.assign(new Error(message), { code }); }
export function passwordOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw passwordFailure('BROWSER_PASSWORD_ORIGIN_INVALID', 'Saved passwords require an exact HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw passwordFailure('BROWSER_PASSWORD_ORIGIN_INVALID', 'Saved passwords require an exact HTTPS origin.');
  return url.origin;
}

/** Only Electron main owns this object. Its public list contains no ciphertext or passwords. */
export class LocalBrowserPasswordVault {
  constructor({ dataDir, safeStorage, platform = process.platform }) {
    this.directory = resolve(dataDir);
    this.file = join(this.directory, 'local-passwords.json');
    this.safeStorage = safeStorage;
    this.platform = platform;
    this.records = null;
    this.queue = Promise.resolve();
  }
  async ready() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw passwordFailure('BROWSER_PASSWORD_STORAGE_INVALID', 'The local password directory is invalid.');
      if (this.platform !== 'win32') await chmod(this.directory, 0o700);
      try {
        const info = await lstat(this.file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new Error();
        const state = JSON.parse(await readFile(this.file, 'utf8'));
        if (state.schema !== 1 || !Array.isArray(state.records) || state.records.length > 4096) throw new Error();
        for (const record of state.records) {
          if (!UUID.test(record.id) || passwordOrigin(record.origin) !== record.origin || typeof record.username !== 'string' || typeof record.ciphertext !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.ciphertext)) throw new Error();
        }
        this.records = state.records;
      } catch (error) {
        if (error.code === 'ENOENT') this.records = [];
        else throw passwordFailure('BROWSER_PASSWORD_STORAGE_INVALID', 'The local password vault could not be read.');
      }
    })();
    return this.readyPromise;
  }
  async available() {
    if (this.platform === 'linux' && this.safeStorage?.getSelectedStorageBackend?.() === 'basic_text') return false;
    return !!(this.safeStorage?.isAsyncEncryptionAvailable ? await this.safeStorage.isAsyncEncryptionAvailable() : this.safeStorage?.isEncryptionAvailable?.());
  }
  metadata(record) {
    return { id: record.id, origin: record.origin, origins: [record.origin], username: record.username,
      label: record.username || new URL(record.origin).hostname, source: 'chrome', sourceProfile: record.sourceProfile,
      profileId: 'native', hasPassword: true, agentReuseApproved: true, sessionStatus: 'saved', updatedAt: record.updatedAt };
  }
  async list() {
    await this.ready();
    return { accounts: this.records.map((record) => this.metadata(record)), secureStorageAvailable: await this.available() };
  }
  mutate(operation) {
    const task = this.queue.then(async () => { await this.ready(); return operation(); });
    this.queue = task.catch(() => {});
    return task;
  }
  async persist(records) {
    const temp = join(this.directory, `.passwords-${randomUUID()}.part`);
    try {
      const encoded = JSON.stringify({ schema: 1, records });
      if (Buffer.byteLength(encoded) > 32 * 1024 * 1024) throw passwordFailure('BROWSER_PASSWORD_LIMIT', 'The local password vault exceeds its storage limit.');
      await writeFile(temp, encoded, { flag: 'wx', mode: 0o600 });
      await rename(temp, this.file);
      this.records = records;
    } finally { await unlink(temp).catch(() => {}); }
  }
  async importCredential(credential) {
    return (await this.importCredentials([credential]))[0];
  }
  async importCredentials(credentials) {
    return this.mutate(async () => {
      if (!Array.isArray(credentials) || credentials.length > 4096) throw passwordFailure('BROWSER_PASSWORD_LIMIT', 'The local password import exceeds the account limit.');
      const validated = credentials.map((entry) => {
        const origin = passwordOrigin(entry.origin);
        if (typeof entry.username !== 'string' || typeof entry.password !== 'string' || !entry.password || Buffer.byteLength(entry.username) + Buffer.byteLength(entry.password) > 12 * 1024) throw passwordFailure('BROWSER_PASSWORD_INVALID', 'The saved website account is invalid.');
        return { ...entry, origin };
      });
      if (!await this.available()) throw passwordFailure('BROWSER_PASSWORD_STORAGE_UNAVAILABLE', 'OS password storage is unavailable.');
      const next = [...this.records]; const imported = new Map();
      for (const { origin, username, password, sourceProfile } of validated) {
        const previous = next.find((record) => record.origin === origin && record.username === username);
        if (!previous && next.length >= 4096) throw passwordFailure('BROWSER_PASSWORD_LIMIT', 'The local password vault is full.');
        const id = previous?.id ?? randomUUID();
        let ciphertext;
        try {
          const plaintext = JSON.stringify({ id, origin, username, password });
          ciphertext = (this.safeStorage.encryptStringAsync ? await this.safeStorage.encryptStringAsync(plaintext) : this.safeStorage.encryptString(plaintext)).toString('base64');
        } catch { throw passwordFailure('BROWSER_PASSWORD_STORAGE_UNAVAILABLE', 'OS password storage could not save this account.'); }
        const record = { id, origin, username, ciphertext, sourceProfile: String(sourceProfile ?? '').slice(0, 160), updatedAt: new Date().toISOString() };
        const index = next.findIndex((entry) => entry.id === id);
        if (index >= 0) next[index] = record; else next.push(record);
        imported.set(id, this.metadata(record));
      }
      // Encrypt the whole batch before one atomic replacement. Any error preserves
      // both the prior account metadata and every prior encrypted password.
      await this.persist(next);
      return [...imported.values()];
    });
  }
  async withCredential(id, operation) {
    await this.ready();
    const record = this.records.find((entry) => entry.id === id);
    if (!record) throw passwordFailure('BROWSER_PASSWORD_NOT_FOUND', 'The saved website account no longer exists.');
    if (!await this.available()) throw passwordFailure('BROWSER_PASSWORD_STORAGE_UNAVAILABLE', 'OS password storage is unavailable.');
    let credential;
    try {
      const bytes = Buffer.from(record.ciphertext, 'base64');
      const decrypted = this.safeStorage.decryptStringAsync ? (await this.safeStorage.decryptStringAsync(bytes)).result : this.safeStorage.decryptString(bytes);
      credential = JSON.parse(decrypted);
      if (credential.id !== id || credential.origin !== record.origin || credential.username !== record.username || typeof credential.password !== 'string' || !credential.password) throw new Error();
    } catch { throw passwordFailure('BROWSER_PASSWORD_STORAGE_UNAVAILABLE', 'OS password storage could not unlock this account.'); }
    // Re-check removal after a keychain prompt before releasing the secret to native input.
    if (!this.records.includes(record)) throw passwordFailure('BROWSER_PASSWORD_NOT_FOUND', 'The saved website account was removed.');
    try { return await operation(credential); } finally { credential.password = ''; }
  }
  remove(id) { return this.mutate(async () => { await this.persist(this.records.filter((record) => record.id !== id)); return { removed: true }; }); }
}
