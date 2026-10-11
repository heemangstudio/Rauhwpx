import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readBrowserJson, writeBrowserJson } from './browser-policy.mjs';

const KEY_NAME = 'browser.wrapping-key.v1';
const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const MAX_PASSWORD_BYTES = 16 * 1024;
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function storageId(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

export function createBrowserWrappingKeyProvider({ keyFile, dataDir } = {}) {
  return async () => {
    if (!keyFile) throw failure('BROWSER_SECURE_STORAGE_UNAVAILABLE', 'Configure an OS vault or an owner-only wrapping-key file outside browser data.');
    const root = await fs.realpath(dataDir).catch((error) => {
      if (error.code === 'ENOENT') return path.resolve(dataDir);
      throw error;
    });
    const location = await fs.realpath(keyFile);
    const relative = path.relative(root, location);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw failure('BROWSER_INSECURE_KEY_FILE', 'The wrapping key must be outside the browser data directory.');
    }
    const stat = await fs.lstat(keyFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) {
      throw failure('BROWSER_INSECURE_KEY_FILE', 'The wrapping-key file must be an owner-only regular file.');
    }
    const bytes = await fs.readFile(location);
    const key = bytes.length === 32 ? Buffer.from(bytes) : Buffer.from(bytes.toString('utf8').trim(), 'base64');
    bytes.fill(0);
    if (key.length !== 32) throw failure('BROWSER_INSECURE_KEY_FILE', 'The wrapping-key file must contain a 256-bit key.');
    return key;
  };
}

export function createEncryptedBrowserAuthStore({ dataDir, secretStore, wrappingKeyProvider, maxCheckpointBytes = MAX_CHECKPOINT_BYTES } = {}) {
  if (!dataDir) throw new TypeError('Browser auth dataDir is required.');
  let keyPromise;
  let queue = Promise.resolve();
  let paused = false;
  const explicitProvider = wrappingKeyProvider ?? (process.env.RHWP_BROWSER_WRAPPING_KEY_FILE
    ? createBrowserWrappingKeyProvider({ keyFile: process.env.RHWP_BROWSER_WRAPPING_KEY_FILE, dataDir }) : null);

  async function key() {
    if (!keyPromise) keyPromise = (async () => {
      try {
        let value;
        if (explicitProvider) value = await explicitProvider({ purpose: 'owned-browser-auth-v1' });
        else if (secretStore?.available) {
          const stored = await secretStore.get(KEY_NAME);
          if (stored) value = Buffer.from(stored, 'base64');
          else {
            value = crypto.randomBytes(32);
            await secretStore.set(KEY_NAME, value.toString('base64'));
          }
        } else throw failure('BROWSER_SECURE_STORAGE_UNAVAILABLE', 'Configure an OS vault or an owner-only wrapping-key file outside browser data.');
        const result = Buffer.isBuffer(value) || value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value), 'base64');
        if (result.length !== 32) throw failure('BROWSER_SECURE_STORAGE_UNAVAILABLE', 'The secure wrapping key is invalid.');
        return result;
      } catch (error) {
        keyPromise = undefined;
        if (error.code?.startsWith('BROWSER_')) throw error;
        throw failure('BROWSER_SECURE_STORAGE_UNAVAILABLE', 'Secure browser storage is unavailable. Reconnect the owner vault or configure a secure wrapping key.');
      }
    })();
    return keyPromise;
  }

  function location(purpose, id) {
    return path.join(dataDir, purpose === 'password' ? 'browser-credentials' : 'browser-auth', `${storageId(id)}.json`);
  }
  function bound(purpose) { return purpose === 'password' ? MAX_PASSWORD_BYTES : maxCheckpointBytes; }
  function serialize(operation) {
    const task = queue.then(operation, operation);
    queue = task.catch(() => {});
    return task;
  }
  async function put(purpose, id, value) {
    return serialize(async () => {
      if (paused) throw failure('BROWSER_AUTH_RESET', 'Browser authentication storage is being cleared.');
      const wrappingKey = await key();
      if (paused) throw failure('BROWSER_AUTH_RESET', 'Browser authentication storage is being cleared.');
      const plain = Buffer.from(JSON.stringify(value));
      try {
        if (plain.length > bound(purpose)) throw failure('BROWSER_AUTH_STORAGE_LIMIT', 'Browser authentication data exceeds its storage limit.');
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv);
        cipher.setAAD(Buffer.from(`browser:${purpose}:${id}:1`));
        const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
        await writeBrowserJson(location(purpose, id), {
          schema: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'),
        }, Math.ceil(bound(purpose) * 1.4) + 1024);
        return true;
      } finally { plain.fill(0); }
    });
  }
  async function get(purpose, id) {
    const encrypted = await readBrowserJson(location(purpose, id), Math.ceil(bound(purpose) * 1.4) + 1024);
    if (!encrypted) return null;
    if (paused) throw failure('BROWSER_AUTH_RESET', 'Browser authentication storage is being cleared.');
    const wrappingKey = await key();
    if (paused) throw failure('BROWSER_AUTH_RESET', 'Browser authentication storage is being cleared.');
    if (encrypted.schema !== 1 || encrypted.algorithm !== 'aes-256-gcm') throw failure('BROWSER_AUTH_STORAGE_INVALID', 'The encrypted browser authentication archive is invalid.');
    let plain;
    try {
      const iv = Buffer.from(encrypted.iv, 'base64');
      const tag = Buffer.from(encrypted.tag, 'base64');
      const bytes = Buffer.from(encrypted.ciphertext, 'base64');
      if (iv.length !== 12 || tag.length !== 16 || bytes.length > bound(purpose)) throw new Error('Invalid archive.');
      const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, iv);
      decipher.setAAD(Buffer.from(`browser:${purpose}:${id}:1`));
      decipher.setAuthTag(tag);
      plain = Buffer.concat([decipher.update(bytes), decipher.final()]);
      return JSON.parse(plain.toString('utf8'));
    } catch {
      throw failure('BROWSER_AUTH_STORAGE_INVALID', 'The browser authentication archive cannot be decrypted. Existing encrypted data has been preserved.');
    } finally { plain?.fill(0); }
  }
  async function remove(purpose, id) { return serialize(() => fs.rm(location(purpose, id), { force: true })); }
  return {
    available: !!(explicitProvider || secretStore?.available),
    ready: async () => { await key(); return true; },
    saveCheckpoint: (id, value) => put('session', id, value),
    restoreCheckpoint: (id) => get('session', id),
    deleteCheckpoint: (id) => remove('session', id),
    savePassword: (id, value) => put('password', id, value),
    readPassword: (id) => get('password', id),
    deletePassword: (id) => remove('password', id),
    beginReset: async () => { paused = true; await queue; if (keyPromise) await keyPromise.catch(() => {}); },
    endReset: () => { paused = false; },
    clearEncryptedData: () => serialize(async () => {
      await fs.rm(path.join(dataDir, 'browser-auth'), { recursive: true, force: true });
      await fs.rm(path.join(dataDir, 'browser-credentials'), { recursive: true, force: true });
      if (keyPromise) (await keyPromise.catch(() => null))?.fill(0);
      keyPromise = undefined;
    }),
    protection: { passwords: secretStore?.available ? 'os-vault' : 'encrypted-wrapping-key', checkpoints: 'aes-256-gcm', chromiumProfile: 'restricted-plaintext-profile', maxCheckpointBytes },
  };
}
