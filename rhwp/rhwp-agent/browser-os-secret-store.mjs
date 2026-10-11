import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const BROWSER_KEY = /^(?:browser\.password\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|browser\.wrapping-key\.v1)$/i;
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function validateKey(key) {
  if (typeof key !== 'string' || !BROWSER_KEY.test(key)) throw failure('BROWSER_SECRET_NAMESPACE_INVALID', 'Only app-owned browser credential keys are supported.');
}

export async function createBrowserOsSecretStore({
  ipcStore, dataDir, platform = process.platform, allowOsKeyring = true,
  loadNative = () => import('@napi-rs/keyring'), timeoutMs = 15_000,
  maxPending = 16, maxSecretBytes = platform === 'win32' ? 2560 : 16 * 1024,
} = {}) {
  if (!dataDir) throw new TypeError('Browser OS credential dataDir is required.');
  const canonicalDir = await fs.realpath(dataDir).catch((error) => {
    if (error.code === 'ENOENT') return path.resolve(dataDir);
    throw error;
  });
  const service = `HamaEditor.owned-browser.v1.${crypto.createHash('sha256').update(canonicalDir).digest('hex').slice(0, 32)}`;
  const available = ipcStore?.available === true || (allowOsKeyring && ['darwin', 'win32', 'linux'].includes(platform));
  let nativePromise;
  let queue = Promise.resolve();
  let pending = 0;

  async function entry(key) {
    if (!nativePromise) nativePromise = Promise.resolve().then(loadNative).then((native) => {
      if (typeof native.AsyncEntry !== 'function') throw new Error('Missing async keyring backend.');
      return native;
    }).catch(() => { nativePromise = undefined; throw failure('BROWSER_SECURE_STORAGE_UNAVAILABLE', 'The operating system credential store is unavailable.'); });
    const native = await nativePromise;
    return new native.AsyncEntry(service, key, platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined);
  }
  function request(operation, key, value) {
    try {
      validateKey(key);
      if (!available) throw failure('BROWSER_SECURE_STORAGE_UNAVAILABLE', 'Secure browser credential storage is unavailable on this hub.');
      if (operation === 'set' && (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > maxSecretBytes)) throw failure('BROWSER_SECRET_SIZE_LIMIT', 'The website credential exceeds the secure store size limit.');
      if (pending >= maxPending) throw failure('BROWSER_SECRET_BUSY', 'The owner credential store is busy. Retry after the pending operation finishes.');
    } catch (error) { return Promise.reject(error); }
    pending += 1;
    const controller = new AbortController();
    let cancelled = false;
    let timer;
    const work = queue.then(async () => {
      if (cancelled) return null;
      if (ipcStore?.available) {
        const result = await ipcStore[operation](key, value);
        if (operation === 'get' && result !== null && result !== undefined && Buffer.byteLength(result, 'utf8') > maxSecretBytes) throw failure('BROWSER_SECRET_SIZE_LIMIT', 'The saved website credential exceeds the secure store size limit.');
        return result;
      }
      const target = await entry(key);
      if (cancelled) return null;
      if (operation === 'set') {
        const bytes = Buffer.from(value, 'utf8');
        try { await target.setSecret(bytes, controller.signal); return true; }
        finally { bytes.fill(0); }
      }
      if (operation === 'delete') return target.deleteCredential(controller.signal);
      const result = await target.getSecret(controller.signal);
      if (result === null || result === undefined) return null;
      const bytes = Buffer.from(result);
      try {
        if (bytes.length > maxSecretBytes) throw failure('BROWSER_SECRET_SIZE_LIMIT', 'The saved website credential exceeds the secure store size limit.');
        return bytes.toString('utf8');
      } finally { bytes.fill(0); }
    });
    queue = work.catch(() => {});
    return new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        cancelled = true; controller.abort();
        reject(failure('BROWSER_SECRET_STORE_TIMEOUT', 'The operating system credential store did not respond. Unlock it and retry.'));
      }, timeoutMs);
      work.then((result) => { if (!cancelled) resolve(result); }, (error) => {
        if (!cancelled) reject(error.code?.startsWith('BROWSER_') ? error : failure('BROWSER_SECURE_STORAGE_UNAVAILABLE', 'The operating system credential store is locked or unavailable.'));
      });
    }).finally(() => { clearTimeout(timer); pending -= 1; });
  }
  return {
    available, backend: ipcStore?.available ? 'owner-ipc' : available ? platform === 'linux' ? 'secret-service' : platform === 'darwin' ? 'keychain' : 'windows-credential-manager' : 'unavailable',
    get: (key) => request('get', key), set: (key, value) => request('set', key, value), delete: (key) => request('delete', key),
    async resetBrowser({ accountIds = [] } = {}) {
      if (ipcStore?.available && typeof ipcStore.resetBrowser === 'function') return ipcStore.resetBrowser();
      if (!Array.isArray(accountIds) || accountIds.length > 1024) throw failure('BROWSER_SECRET_NAMESPACE_INVALID', 'Browser cleanup needs its owned account identities.');
      const keys = accountIds.map((id) => `browser.password.${id}`);
      keys.forEach(validateKey);
      for (const key of keys) await request('delete', key);
      await request('delete', 'browser.wrapping-key.v1');
      return true;
    },
  };
}
