import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sameSite, siteScope } from './browser-site.mjs';
import { retryWindows } from './fs-replace.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function passwordFailure(code, message, details = {}) { return Object.assign(new Error(message), { code, ...details }); }
const optionalTime = (value) => value === undefined || typeof value === 'string' && Number.isFinite(Date.parse(value));
/** 예전 기록의 agentReuseApproved 는 읽기만 한다. 다음 저장부터 agentBlocked 만 남는다. */
function normalizedRecord({ agentReuseApproved: _legacy, ...record }) {
  return { ...record, agentBlocked: record.agentBlocked === true };
}
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
    this.writes = new Map();
  }
  async ready() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw passwordFailure('BROWSER_PASSWORD_STORAGE_INVALID', 'The local password directory is invalid.');
      if (this.platform !== 'win32') await chmod(this.directory, 0o700);
      try {
        // 백신·색인기가 잠깐 쥔 파일(EBUSY/EPERM)은 짧게 다시 읽는다.
        const info = await retryWindows(() => lstat(this.file), this.platform);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new Error();
        const state = JSON.parse(await retryWindows(() => readFile(this.file, 'utf8'), this.platform));
        if (state.schema !== 1 || !Array.isArray(state.records) || state.records.length > 4096) throw new Error();
        for (const record of state.records) {
          if (!UUID.test(record.id) || passwordOrigin(record.origin) !== record.origin || typeof record.username !== 'string' || typeof record.ciphertext !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.ciphertext)
            || [record.agentReuseApproved, record.agentBlocked].some((value) => value !== undefined && typeof value !== 'boolean')
            || !optionalTime(record.blockedAt) || !optionalTime(record.filledAt)) throw new Error();
        }
        this.records = state.records.map(normalizedRecord);
      } catch (error) {
        if (error.code === 'ENOENT') this.records = [];
        else if (typeof error?.code === 'string' && /^E[A-Z0-9]+$/.test(error.code)) {
          // 일시적인 읽기 실패를 영구 손상으로 기억하지 않는다 — 다음 요청이 다시 읽는다.
          this.readyPromise = null;
          throw passwordFailure('BROWSER_PASSWORD_STORAGE_UNAVAILABLE', 'The local password vault could not be read right now. Try again.');
        } else {
          this.unreadable = true;
          throw passwordFailure('BROWSER_PASSWORD_STORAGE_INVALID', 'The local password vault could not be read.');
        }
      }
    })();
    return this.readyPromise;
  }
  async available() {
    if (this.platform === 'linux' && this.safeStorage?.getSelectedStorageBackend?.() === 'basic_text') return false;
    return !!(this.safeStorage?.isAsyncEncryptionAvailable ? await this.safeStorage.isAsyncEncryptionAvailable() : this.safeStorage?.isEncryptionAvailable?.());
  }
  metadata(record) {
    return { id: record.id, origin: record.origin, origins: [record.origin], site: siteScope(record.origin).key, username: record.username,
      label: record.username || new URL(record.origin).hostname, source: 'chrome', sourceProfile: record.sourceProfile,
      profileId: 'native', hasPassword: true, agentBlocked: record.agentBlocked === true, sessionStatus: 'saved', updatedAt: record.updatedAt };
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
      await retryWindows(() => rename(temp, this.file), this.platform);
      const revoked = this.records.filter((record) => !records.includes(record));
      this.records = records;
      // A removal or replacement acknowledges only after writes which already
      // began with the prior credential have finished. No new prior lease can start.
      await Promise.all(revoked.flatMap((record) => [...(this.writes.get(record.id) ?? [])]));
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
        // 에이전트는 사이트 사용 승인으로 이 계정을 쓴다. 다시 가져와도 사용자가 끈 에이전트 사용은 그대로 둔다.
        const record = { id, origin, username, ciphertext, sourceProfile: String(sourceProfile ?? '').slice(0, 160), agentBlocked: previous?.agentBlocked === true,
          ...(previous?.blockedAt ? { blockedAt: previous.blockedAt } : {}), ...(previous?.filledAt ? { filledAt: previous.filledAt } : {}), updatedAt: new Date().toISOString() };
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
  /** 사용자의 설정이나 차단 해제 카드만 이 값을 바꾼다. 끄면 사이트 사용 승인이 있어도 에이전트가 쓰지 못한다. */
  setAgentBlocked(id, blocked) {
    return this.mutate(async () => {
      const index = this.records.findIndex((record) => record.id === id);
      if (index < 0) throw passwordFailure('BROWSER_PASSWORD_NOT_FOUND', 'The saved website account no longer exists.');
      if (typeof blocked !== 'boolean') throw passwordFailure('BROWSER_PASSWORD_INVALID', 'The agent use choice is invalid.');
      const { blockedAt: _previous, ...record } = this.records[index];
      const next = [...this.records]; next[index] = { ...record, agentBlocked: blocked, ...(blocked ? { blockedAt: new Date().toISOString() } : {}) };
      await this.persist(next);
      return this.metadata(next[index]);
    });
  }
  /** 입력한 시각을 남긴다. 다시 시작한 뒤 이 값이 보이는 페이지를 가리는 데 쓴다. */
  markFilled(id) {
    return this.mutate(async () => {
      const index = this.records.findIndex((record) => record.id === id);
      if (index < 0) return;
      const next = [...this.records]; next[index] = { ...next[index], filledAt: new Date().toISOString() };
      await this.persist(next);
    });
  }
  async decrypt(record) {
    if (!await this.available()) throw passwordFailure('BROWSER_PASSWORD_STORAGE_UNAVAILABLE', 'OS password storage is unavailable.');
    try {
      const bytes = Buffer.from(record.ciphertext, 'base64');
      const decrypted = this.safeStorage.decryptStringAsync ? (await this.safeStorage.decryptStringAsync(bytes)).result : this.safeStorage.decryptString(bytes);
      const credential = JSON.parse(decrypted);
      if (credential.id !== record.id || credential.origin !== record.origin || credential.username !== record.username || typeof credential.password !== 'string' || !credential.password) throw new Error();
      return credential;
    } catch { throw passwordFailure('BROWSER_PASSWORD_STORAGE_UNAVAILABLE', 'OS password storage could not unlock this account.'); }
  }
  /** 최근에 입력한 비밀번호들. 입력한 적이 없으면 OS 보관함을 열지 않는다. 열 수 없는 기록은 건너뛴다. */
  async recentPasswords({ maxAgeMs = 7 * 24 * 60 * 60 * 1000, limit = 32 } = {}) {
    await this.ready();
    const since = Date.now() - maxAgeMs;
    const recent = this.records.filter((record) => record.filledAt && Date.parse(record.filledAt) >= since)
      .sort((left, right) => Date.parse(right.filledAt) - Date.parse(left.filledAt)).slice(0, limit);
    const values = [];
    for (const record of recent) { try { values.push((await this.decrypt(record)).password); } catch {} }
    return values;
  }
  /**
   * agent: 허브가 이 계정의 사이트 사용을 확인하고 보낸 grant({ site, scope, grantedAt })가 있어야 한다.
   * 계정 사이트와 grant 사이트가 같아야 하고, 사용자가 이 계정의 에이전트 사용을 껐다면 쓰지 않는다.
   */
  async withCredential(id, operation, { agent = false, grant = null } = {}) {
    await this.ready();
    const record = this.records.find((entry) => entry.id === id);
    if (!record) throw passwordFailure('BROWSER_PASSWORD_NOT_FOUND', 'The saved website account no longer exists.');
    const site = siteScope(record.origin);
    const blocked = () => passwordFailure('BROWSER_SITE_BLOCKED', `The owner turned off agent use of this saved login. Call browser_request_account with kind 'site' for ${record.origin} and end the turn.`, { site: site.domain ?? site.key, origin: record.origin, item: { accountId: id } });
    // Checked before decryption so an unapproved agent request never prompts the OS vault.
    if (agent && record.agentBlocked) throw blocked();
    if (agent && !(grant && typeof grant === 'object' && typeof grant.site === 'string' && ['chat', 'always'].includes(grant.scope) && Number.isFinite(grant.grantedAt))) {
      throw passwordFailure('BROWSER_PERMISSION_REQUIRED', `Using ${site.domain ?? site.key} needs the owner's approval. Call browser_request_account with kind 'site' for ${record.origin} and end the turn.`, { reason: 'account-use', site: site.domain ?? site.key, origin: record.origin });
    }
    // 허브는 페이지 사이트의 사용 승인을 보낸다. 다른 사이트 승인이면 이 계정이 그 페이지 것이 아니다.
    if (agent && !sameSite(/^[a-z][a-z0-9+.-]*:/i.test(grant.site) ? grant.site : `https://${grant.site}`, record.origin)) throw passwordFailure('BROWSER_PASSWORD_ORIGIN_MISMATCH', 'This saved account belongs to a different website.');
    const credential = await this.decrypt(record);
    // 에이전트 사용 끄기와 입력 시각 기록은 기록 객체를 바꾼다. 같은 비밀번호인 동안은 계속 쓸 수 있다.
    const assertCurrent = () => {
      const current = this.records.find((entry) => entry.id === id);
      if (!current || current.ciphertext !== record.ciphertext || current.origin !== record.origin || current.username !== record.username) throw passwordFailure('BROWSER_PASSWORD_NOT_FOUND', 'The saved website account was removed or replaced.');
      if (agent && current.agentBlocked) throw blocked();
    };
    const lease = { assertCurrent, write: async (write) => {
      assertCurrent();
      let finish;
      const settled = new Promise((resolve) => { finish = resolve; });
      let writes = this.writes.get(id);
      if (!writes) { writes = new Set(); this.writes.set(id, writes); }
      writes.add(settled);
      try { return await write(); }
      finally { finish(); writes.delete(settled); if (!writes.size) this.writes.delete(id); }
    } };
    // Re-check removal after the OS prompt and at every async native input boundary.
    try { assertCurrent(); return await operation(credential, lease); } finally { credential.password = ''; }
  }
  remove(id) { return this.mutate(async () => { await this.persist(this.records.filter((record) => record.id !== id)); return { removed: true }; }); }
  clear() {
    const task = this.queue.then(async () => {
      try {
        await this.ready();
      } catch (error) {
        // 읽을 수 없는 금고도 지우기는 된다 — 빈 금고로 덮어쓰면 다시 쓸 수 있다.
        if (!this.unreadable) throw error;
        this.records = [];
      }
      const removed = this.records.length;
      await this.persist([]);
      if (this.unreadable) {
        this.unreadable = false;
        this.readyPromise = Promise.resolve();
      }
      return { removed };
    });
    this.queue = task.catch(() => {});
    return task;
  }
}
