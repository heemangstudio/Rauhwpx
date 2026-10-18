import crypto from 'node:crypto';
import path from 'node:path';
import { browserOrigin, readBrowserJson, sameSite, writeBrowserJson } from './browser-policy.mjs';
import { createEncryptedBrowserAuthStore } from './browser-auth-store.mjs';

// 사용자가 에이전트에게 맡기는 비밀(API 키·토큰·비밀번호). 값은 허브 소유 브라우저 도구만 페이지에 입력한다.
// 메타데이터는 브라우저 데이터 폴더에, 값은 금고의 `usersecret.<uuid>` 에 둔다. 평문 대체 저장소는 없다.
// 쓸 수 있는지는 사이트 사용(browser-policy)이 정한다. 비밀마다 남는 것은 "에이전트 사용 끔"(blocked) 하나다.
export const USER_SECRET_KINDS = Object.freeze(['api-key', 'token', 'password', 'other']);
export const USER_SECRET_SCOPES = Object.freeze(['chat', 'always']);
export const MAX_USER_SECRET_BYTES = 4096;
export const MAX_USER_SECRET_ORIGINS = 20;
const MAX_LABEL = 80;
const MAX_SECRETS = 64;
const MAX_CHAT_SECRETS = 32;
const SECRET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function failure(code, message) { return Object.assign(new Error(message), { code }); }
const sameOrigins = (left, right) => left.length === right.length && left.every((origin) => right.includes(origin));

export function isUserSecretId(value) { return typeof value === 'string' && SECRET_ID.test(value); }

export function normalizeSecretOrigins(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_USER_SECRET_ORIGINS) {
    throw failure('SECRET_ORIGIN_INVALID', `Give 1-${MAX_USER_SECRET_ORIGINS} HTTPS website origins for this secret.`);
  }
  return [...new Set(values.map((value) => {
    let origin;
    try { origin = browserOrigin(value); } catch { throw failure('SECRET_ORIGIN_INVALID', 'Secret origins must be exact HTTPS website origins.'); }
    if (!origin.startsWith('https://')) throw failure('SECRET_ORIGIN_INVALID', 'Secret origins must use HTTPS.');
    return origin;
  }))];
}

export function normalizeSecretLabel(value) {
  const label = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!label || label.length > MAX_LABEL || /[\u0000-\u001f\u007f]/.test(label)) throw failure('SECRET_LABEL_INVALID', `Give the secret a label of 1-${MAX_LABEL} characters.`);
  return label;
}

export function normalizeSecretKind(value) {
  if (!USER_SECRET_KINDS.includes(value)) throw failure('SECRET_KIND_INVALID', `The secret kind must be one of ${USER_SECRET_KINDS.join(', ')}.`);
  return value;
}

export function normalizeSecretValue(value) {
  if (typeof value !== 'string' || !value || value.includes('\u0000') || Buffer.byteLength(value, 'utf8') > MAX_USER_SECRET_BYTES) {
    throw failure('SECRET_VALUE_INVALID', `Enter a secret of at most ${MAX_USER_SECRET_BYTES} bytes.`);
  }
  return value;
}

export function normalizeSecretScope(value, fallback = 'chat') {
  const scope = value ?? fallback;
  if (!USER_SECRET_SCOPES.includes(scope)) throw failure('SECRET_SCOPE_INVALID', 'Choose chat or always.');
  return scope;
}

/**
 * @param {{ dataDir: string, secretStore?: { available?: boolean, get: Function, set: Function, delete: Function } | null,
 *   wrappingKeyProvider?: Function, now?: () => number, onChange?: () => void }} options
 */
export function createUserSecretStore({ dataDir, secretStore = null, wrappingKeyProvider, now = Date.now, onChange = () => {} } = {}) {
  if (!dataDir) throw new TypeError('User secret dataDir is required.');
  const filePath = path.join(dataDir, 'user-secrets.json');
  // 금고가 없을 때만 소유자 전용 래핑 키(RHWP_BROWSER_WRAPPING_KEY_FILE)로 AES-GCM 보관한다.
  const authStore = createEncryptedBrowserAuthStore({ dataDir, secretStore: null, wrappingKeyProvider });
  /** @type {{ schema: 2, secrets: Array<Record<string, any>> }} */
  let state;
  let queue = Promise.resolve();
  /** 이 채팅에만 둔 비밀: id → { meta, value, threadId }. 허브 메모리에만 있고, 넘치면 오래된 것부터 버린다. */
  const chatSecrets = new Map();
  /** 금고에서 값이 사라진 영구 비밀 — 다음 request_secret 은 다시 입력받는다. */
  const missingValues = new Set();
  /** 채팅을 지울 때마다 오른다. 지우기 전에 시작한 "이 채팅" 저장이 지운 채팅에 값을 되살리지 못하게 한다. */
  const chatEpochs = new Map();
  const chatEpoch = (threadId) => chatEpochs.get(threadId) ?? 0;
  const chatEnded = () => failure('SECRET_CHAT_ENDED', 'The chat ended before this secret was saved.');
  let readyPromise = (async () => {
    const stored = await readBrowserJson(filePath);
    if (!stored) { state = { schema: 2, secrets: [] }; return; }
    if (![1, 2].includes(stored.schema) || !Array.isArray(stored.secrets) || stored.secrets.length > MAX_SECRETS) throw failure('SECRET_STORAGE_INVALID', 'Saved secret metadata cannot be read.');
    for (const entry of stored.secrets) {
      if (!isUserSecretId(entry.id)) throw failure('SECRET_STORAGE_INVALID', 'Saved secret metadata cannot be read.');
      entry.label = normalizeSecretLabel(entry.label);
      entry.kind = normalizeSecretKind(entry.kind);
      entry.origins = normalizeSecretOrigins(entry.origins);
      // 스키마 1 의 비밀별 승인은 버린다. 사용은 이제 사이트 사용을 따른다.
      delete entry.approved;
      entry.blocked = entry.blocked === true;
    }
    state = { schema: 2, secrets: stored.secrets };
  })();

  function serialized(operation) {
    const execute = async () => { await readyPromise; return operation(); };
    const task = queue.then(execute, execute);
    queue = task.catch(() => {});
    return task;
  }
  function changed() { try { onChange(); } catch {} }
  const vaultKey = (id) => `usersecret.${id}`;
  const vaultAvailable = () => secretStore?.available === true;
  async function writeValue(id, value) {
    if (vaultAvailable()) {
      try { await secretStore.set(vaultKey(id), value); return; }
      catch { throw failure('SECRET_STORAGE_UNAVAILABLE', 'The secure vault could not save this secret.'); }
    }
    if (authStore.available) {
      try { await authStore.saveSecret(id, { value }); return; }
      catch { throw failure('SECRET_STORAGE_UNAVAILABLE', 'The secure vault could not save this secret.'); }
    }
    throw failure('SECRET_STORAGE_UNAVAILABLE', 'Secure storage is unavailable. Keep the secret for this chat only.');
  }
  async function readValue(id) {
    try {
      if (vaultAvailable()) return await secretStore.get(vaultKey(id));
      if (authStore.available) return (await authStore.readSecret(id))?.value ?? null;
    } catch { throw failure('SECRET_STORAGE_UNAVAILABLE', 'The secure vault could not read this secret. Unlock it and retry.'); }
    throw failure('SECRET_STORAGE_UNAVAILABLE', 'The secure vault is unavailable.');
  }
  async function deleteValue(id) {
    if (vaultAvailable()) {
      try { await secretStore.delete(vaultKey(id)); }
      catch { throw failure('SECRET_STORAGE_UNAVAILABLE', 'The secure vault could not remove this secret.'); }
    }
    if (authStore.available) await authStore.deleteSecret(id);
  }
  async function persist(next) {
    await writeBrowserJson(filePath, next);
    state = next;
  }
  const persisted = (id) => state?.secrets.find((entry) => entry.id === id) ?? null;
  function publicMeta(entry, scope) {
    return { id: entry.id, label: entry.label, kind: entry.kind, origins: [...entry.origins], scope, blocked: entry.blocked === true,
      createdAt: entry.createdAt, lastUsedAt: entry.lastUsedAt ?? null, filledAt: entry.filledAt ?? null };
  }
  /** 이 채팅에서 볼 수 있는 비밀의 원본 기록. 다른 채팅의 "이 채팅" 비밀은 없는 것으로 본다. */
  function lookup(id, threadId) {
    const saved = persisted(id);
    if (saved) return { entry: saved, scope: 'always' };
    const chat = chatSecrets.get(id);
    if (chat && (!threadId || chat.threadId === threadId)) return { entry: chat.meta, scope: 'chat', threadId: chat.threadId };
    return null;
  }
  const visible = (threadId) => [...state.secrets.map((entry) => ({ entry, scope: 'always' })),
    ...[...chatSecrets.values()].filter((chat) => !threadId || chat.threadId === threadId).map((chat) => ({ entry: chat.meta, scope: 'chat' }))];
  function updateEntry(id, patch) {
    const chat = chatSecrets.get(id);
    if (chat) { Object.assign(chat.meta, patch); return Promise.resolve(); }
    if (!persisted(id)) return Promise.resolve();
    return persist({ ...state, secrets: state.secrets.map((entry) => entry.id === id ? { ...entry, ...patch } : entry) });
  }

  return {
    ready: () => readyPromise,
    /** 사람용 목록: 영구 비밀과, threadId 를 주면 그 채팅의 비밀. 값은 없다. */
    async list({ threadId } = {}) {
      await readyPromise;
      return visible(threadId).map(({ entry, scope }) => publicMeta(entry, scope));
    },
    /** 에이전트용 목록(browser_status). 값과 시각 없이, 쓸 수 있는지는 서버가 사이트 사용으로 덧붙인다. */
    async agentList(threadId) {
      await readyPromise;
      return visible(threadId ?? '\u0000').map(({ entry }) => ({ id: entry.id, label: entry.label, kind: entry.kind, origins: [...entry.origins], blocked: entry.blocked === true }));
    },
    /** 이 사이트(같은 등록 도메인)에서 쓸 수 있는 비밀. 사이트 카드의 비밀 줄이 된다. */
    async forSite(origin, threadId) {
      await readyPromise;
      return visible(threadId ?? '\u0000').filter(({ entry }) => entry.origins.some((value) => sameSite(value, origin))).map(({ entry, scope }) => publicMeta(entry, scope));
    },
    async get(id, threadId) {
      await readyPromise;
      const found = lookup(id, threadId);
      return found ? { ...publicMeta(found.entry, found.scope), valueMissing: found.scope === 'always' && missingValues.has(id) } : null;
    },
    async findMatch({ label, origins, threadId }) {
      await readyPromise;
      const wanted = normalizeSecretOrigins(origins);
      const name = normalizeSecretLabel(label);
      const match = visible(threadId ?? '\u0000').find(({ entry }) => entry.label === name && sameOrigins(entry.origins, wanted));
      return match ? { ...publicMeta(match.entry, match.scope), valueMissing: match.scope === 'always' && missingValues.has(match.entry.id) } : null;
    },
    vaultAvailable: () => vaultAvailable() || authStore.available,
    /** 사용자가 카드에 입력한 값을 저장한다. always 는 금고에 남기고, chat 은 그 채팅의 허브 메모리에만 둔다. */
    save({ id, label, kind, origins, value, scope, threadId }) {
      const normalized = { label: normalizeSecretLabel(label), kind: normalizeSecretKind(kind), origins: normalizeSecretOrigins(origins), value: normalizeSecretValue(value), scope: normalizeSecretScope(scope, 'always') };
      if (id !== undefined && id !== null && !isUserSecretId(id)) return Promise.reject(failure('SECRET_NOT_FOUND', 'The secret to replace no longer exists.'));
      if (!threadId) return Promise.reject(failure('SECRET_SCOPE_INVALID', 'A secret needs the chat that requested it.'));
      const epoch = chatEpoch(threadId);
      const live = () => chatEpoch(threadId) === epoch;
      return serialized(async () => {
        if (normalized.scope === 'chat' && !live()) throw chatEnded();
        const secretId = id ?? crypto.randomUUID();
        const previous = persisted(secretId);
        const previousChat = chatSecrets.get(secretId);
        if (id && !previous && !previousChat) throw failure('SECRET_NOT_FOUND', 'The secret to replace no longer exists.');
        const createdAt = previous?.createdAt ?? previousChat?.meta.createdAt ?? new Date(now()).toISOString();
        const meta = { id: secretId, label: normalized.label, kind: normalized.kind, origins: normalized.origins, createdAt,
          lastUsedAt: previous?.lastUsedAt ?? null, blocked: previous?.blocked ?? previousChat?.meta.blocked ?? false };
        if (normalized.scope === 'always') {
          if (!previous && state.secrets.length >= MAX_SECRETS) throw failure('SECRET_LIMIT', 'Too many saved secrets. Delete one in Browser settings.');
          await writeValue(secretId, normalized.value);
          try { await persist({ ...state, secrets: state.secrets.filter((entry) => entry.id !== secretId).concat(meta) }); }
          catch (error) { if (!previous) await deleteValue(secretId).catch(() => {}); throw error; }
          chatSecrets.delete(secretId);
          missingValues.delete(secretId);
        } else {
          if (previous) {
            await persist({ ...state, secrets: state.secrets.filter((entry) => entry.id !== secretId) });
            await deleteValue(secretId).catch(() => {});
            missingValues.delete(secretId);
          }
          if (!live()) throw chatEnded();
          // 채팅 비밀은 32 개까지 둔다. 넘치면 가장 오래 전에 넣은 것부터 버린다.
          chatSecrets.delete(secretId);
          while (chatSecrets.size >= MAX_CHAT_SECRETS) chatSecrets.delete(chatSecrets.keys().next().value);
          chatSecrets.set(secretId, { meta, value: normalized.value, threadId });
        }
        changed();
        return publicMeta(normalized.scope === 'always' ? persisted(secretId) : meta, normalized.scope);
      });
    },
    /** 비밀 하나의 에이전트 사용을 끄거나 켠다. */
    setBlocked(id, blocked) {
      if (typeof blocked !== 'boolean') return Promise.reject(failure('SECRET_INVALID', 'Choose whether the agent may use this secret.'));
      return serialized(async () => {
        const found = lookup(id);
        if (!found) throw failure('SECRET_NOT_FOUND', 'The secret no longer exists.');
        await updateEntry(id, { blocked });
        changed();
        const current = lookup(id);
        return publicMeta(current.entry, current.scope);
      });
    },
    remove(id) {
      return serialized(async () => {
        const found = lookup(id);
        if (!found) throw failure('SECRET_NOT_FOUND', 'The secret no longer exists.');
        if (found.scope === 'chat') chatSecrets.delete(id);
        else {
          await deleteValue(id);
          await persist({ ...state, secrets: state.secrets.filter((entry) => entry.id !== id) });
          missingValues.delete(id);
        }
        changed();
        return { deleted: true, secretId: id };
      });
    },
    /** 입력 직전에만 값을 꺼낸다. 사이트 사용과 끔 여부는 허브가 이미 확인했다. 채팅 비밀은 그 채팅에서만 보인다. */
    async resolveValue(id, threadId) {
      await readyPromise;
      const found = lookup(id, threadId);
      if (!found) throw failure('SECRET_NOT_FOUND', 'The secret no longer exists.');
      if (found.scope === 'chat') return chatSecrets.get(id).value;
      const value = await readValue(id);
      if (typeof value !== 'string' || !value) {
        missingValues.add(id);
        throw failure('SECRET_VALUE_UNAVAILABLE', `The saved value is gone. Call request_secret with secretId ${id} so the user can enter it again, then end your turn.`);
      }
      missingValues.delete(id);
      return value;
    },
    /** 페이지에 넣었다. 다음 허브 시작에도 관찰에서 가리도록 filledAt 을 남긴다. */
    touch(id) {
      return serialized(async () => {
        const at = new Date(now()).toISOString();
        await updateEntry(id, { lastUsedAt: at, filledAt: now() });
      }).then(changed, () => {});
    },
    /** since 뒤에 페이지에 넣은 영구 비밀의 값. 허브가 다시 시작한 뒤 관찰을 가리는 데만 쓴다. */
    async filledValues({ since = 0, limit = 64 } = {}) {
      await readyPromise;
      const values = [];
      for (const entry of state.secrets.filter((item) => (item.filledAt ?? 0) >= since).slice(-limit)) {
        try { const value = await readValue(entry.id); if (typeof value === 'string' && value) values.push(value); } catch {}
      }
      return values;
    },
    /** 채팅을 지우면 그 채팅의 "이 채팅" 비밀을 버린다. */
    endChat(threadId) {
      if (!threadId) return;
      chatEpochs.set(threadId, chatEpoch(threadId) + 1);
      let removed = false;
      for (const [id, chat] of chatSecrets) if (chat.threadId === threadId) { chatSecrets.delete(id); removed = true; }
      if (removed) changed();
    },
    /** 브라우저 데이터 초기화: 금고 값과 메타데이터를 모두 지운다. */
    reset() {
      // 메타데이터를 읽지 못해도 초기화는 끝나야 한다. 아는 값만 지우고 빈 목록으로 다시 시작한다.
      const run = async () => {
        const known = await readyPromise.then(() => state.secrets.map((entry) => entry.id), () => []);
        for (const id of known) await deleteValue(id);
        await persist({ schema: 2, secrets: [] });
        readyPromise = Promise.resolve();
        for (const chat of chatSecrets.values()) chatEpochs.set(chat.threadId, chatEpoch(chat.threadId) + 1);
        chatSecrets.clear(); missingValues.clear();
        changed();
        return { cleared: true };
      };
      const task = queue.then(run, run);
      queue = task.catch(() => {});
      return task;
    },
  };
}
