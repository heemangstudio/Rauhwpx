import crypto from 'node:crypto';
import path from 'node:path';
import { browserOrigin, readBrowserJson, writeBrowserJson } from './browser-policy.mjs';
import { createEncryptedBrowserAuthStore } from './browser-auth-store.mjs';

// 사용자가 에이전트에게 맡기는 비밀(API 키·토큰·비밀번호). 값은 허브 소유 브라우저 도구만 페이지에 입력한다.
// 메타데이터는 브라우저 데이터 폴더에, 값은 금고의 `usersecret.<uuid>` 에 둔다. 평문 대체 저장소는 없다.
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
    throw failure('SECRET_ORIGIN_INVALID', `Give 1-${MAX_USER_SECRET_ORIGINS} exact HTTPS website origins for this secret.`);
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
  /** @type {{ schema: 1, secrets: Array<Record<string, any>> }} */
  let state;
  let queue = Promise.resolve();
  /** 이 채팅에만 둔 비밀: id → { meta, value, threadId }. 허브 메모리에만 있다. */
  const chatSecrets = new Map();
  /** 채팅별 사용 승인: threadId → Set<secretId>. */
  const chatGrants = new Map();
  /** 금고에서 값이 사라진 영구 비밀 — 다음 request_secret 은 다시 입력받는다. */
  const missingValues = new Set();
  /** 채팅이 끝날 때마다 오른다. 끝나기 전에 시작한 저장·승인이 끝난 채팅에 권한을 되살리지 못하게 한다. */
  const chatEpochs = new Map();
  const chatEpoch = (threadId) => chatEpochs.get(threadId) ?? 0;
  const chatEnded = () => failure('SECRET_CHAT_ENDED', 'The chat ended before this secret was approved.');
  let readyPromise = (async () => {
    const stored = await readBrowserJson(filePath);
    if (!stored) { state = { schema: 1, secrets: [] }; return; }
    if (stored.schema !== 1 || !Array.isArray(stored.secrets) || stored.secrets.length > MAX_SECRETS) throw failure('SECRET_STORAGE_INVALID', 'Saved secret metadata cannot be read.');
    for (const entry of stored.secrets) {
      if (!isUserSecretId(entry.id)) throw failure('SECRET_STORAGE_INVALID', 'Saved secret metadata cannot be read.');
      entry.label = normalizeSecretLabel(entry.label);
      entry.kind = normalizeSecretKind(entry.kind);
      entry.origins = normalizeSecretOrigins(entry.origins);
      entry.approved = entry.approved === true;
    }
    state = stored;
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
  const grantsFor = (threadId) => {
    if (!threadId) return null;
    let grants = chatGrants.get(threadId);
    if (!grants) { grants = new Set(); chatGrants.set(threadId, grants); }
    return grants;
  };
  /** approved: 영구 승인이거나, threadId 를 주면 그 채팅에서 쓸 수 있는지. */
  function publicMeta(entry, scope, threadId) {
    return { id: entry.id, label: entry.label, kind: entry.kind, origins: [...entry.origins], scope,
      approved: (scope === 'always' && entry.approved === true) || chatGrants.get(threadId)?.has(entry.id) === true,
      createdAt: entry.createdAt, lastUsedAt: entry.lastUsedAt ?? null };
  }
  /** 이 채팅에서 볼 수 있는 비밀의 원본 기록. 다른 채팅의 "이 채팅" 비밀은 없는 것으로 본다. */
  function lookup(id, threadId) {
    const saved = persisted(id);
    if (saved) return { entry: saved, scope: 'always' };
    const chat = chatSecrets.get(id);
    if (chat && (!threadId || chat.threadId === threadId)) return { entry: chat.meta, scope: 'chat', threadId: chat.threadId };
    return null;
  }
  function isApproved(id, threadId) {
    const found = lookup(id, threadId);
    if (!found) return false;
    return (found.scope === 'always' && found.entry.approved === true) || chatGrants.get(threadId)?.has(id) === true;
  }

  return {
    ready: () => readyPromise,
    /** 사람용 목록: 영구 비밀과, threadId 를 주면 그 채팅의 비밀. 값은 없다. */
    async list({ threadId } = {}) {
      await readyPromise;
      return [...state.secrets.map((entry) => publicMeta(entry, 'always', threadId)),
        ...[...chatSecrets.values()].filter((chat) => !threadId || chat.threadId === threadId).map((chat) => publicMeta(chat.meta, 'chat', threadId))];
    },
    /** 에이전트용 목록(browser_status). 값과 생성 시각 없이 이 채팅의 사용 가능 여부만 준다. */
    async agentList(threadId) {
      await readyPromise;
      const visible = [...state.secrets, ...[...chatSecrets.values()].filter((chat) => chat.threadId === threadId).map((chat) => chat.meta)];
      return visible.map((entry) => ({ id: entry.id, label: entry.label, kind: entry.kind, origins: [...entry.origins], approved: isApproved(entry.id, threadId) }));
    },
    async get(id, threadId) {
      await readyPromise;
      const found = lookup(id, threadId);
      return found ? { ...publicMeta(found.entry, found.scope, threadId), valueMissing: found.scope === 'always' && missingValues.has(id) } : null;
    },
    async findMatch({ label, origins, threadId }) {
      await readyPromise;
      const wanted = normalizeSecretOrigins(origins);
      const name = normalizeSecretLabel(label);
      const candidates = [...state.secrets.map((entry) => ({ entry, scope: 'always' })),
        ...[...chatSecrets.values()].filter((chat) => chat.threadId === threadId).map((chat) => ({ entry: chat.meta, scope: 'chat' }))];
      const match = candidates.find(({ entry }) => entry.label === name && sameOrigins(entry.origins, wanted));
      return match ? { ...publicMeta(match.entry, match.scope, threadId), valueMissing: match.scope === 'always' && missingValues.has(match.entry.id) } : null;
    },
    isApproved: async (id, threadId) => { await readyPromise; return isApproved(id, threadId); },
    vaultAvailable: () => vaultAvailable() || authStore.available,
    /** 사용자가 카드에 입력한 값을 저장하고 이 채팅에 사용을 승인한다. */
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
        const meta = { id: secretId, label: normalized.label, kind: normalized.kind, origins: normalized.origins, createdAt, lastUsedAt: previous?.lastUsedAt ?? null };
        if (normalized.scope === 'always') {
          if (!previous && state.secrets.length >= MAX_SECRETS) throw failure('SECRET_LIMIT', 'Too many saved secrets. Delete one in Browser settings.');
          await writeValue(secretId, normalized.value);
          try { await persist({ ...state, secrets: state.secrets.filter((entry) => entry.id !== secretId).concat({ ...meta, approved: previous?.approved === true }) }); }
          catch (error) { if (!previous) await deleteValue(secretId).catch(() => {}); throw error; }
          chatSecrets.delete(secretId);
          missingValues.delete(secretId);
        } else {
          if (!previousChat && chatSecrets.size >= MAX_CHAT_SECRETS) throw failure('SECRET_LIMIT', 'Too many secrets are kept for open chats.');
          if (previous) {
            await persist({ ...state, secrets: state.secrets.filter((entry) => entry.id !== secretId) });
            await deleteValue(secretId).catch(() => {});
            missingValues.delete(secretId);
          }
          if (!live()) throw chatEnded();
          chatSecrets.set(secretId, { meta, value: normalized.value, threadId });
        }
        if (live()) grantsFor(threadId).add(secretId);
        changed();
        return publicMeta(normalized.scope === 'always' ? persisted(secretId) : meta, normalized.scope, threadId);
      });
    },
    /** always 는 영구 승인(영구 비밀만), chat 은 이 채팅에서만. */
    approve({ id, scope, threadId }) {
      const epoch = chatEpoch(threadId);
      return serialized(async () => {
        const found = lookup(id, threadId);
        if (!found) throw failure('SECRET_NOT_FOUND', 'The secret no longer exists.');
        const normalizedScope = normalizeSecretScope(scope, 'chat');
        if (normalizedScope === 'chat' && chatEpoch(threadId) !== epoch) throw chatEnded();
        if (normalizedScope === 'always' && found.scope === 'always' && found.entry.approved !== true) {
          await persist({ ...state, secrets: state.secrets.map((entry) => entry.id === id ? { ...entry, approved: true } : entry) });
        }
        if (threadId && chatEpoch(threadId) === epoch) grantsFor(threadId).add(id);
        changed();
        const current = lookup(id, threadId);
        return publicMeta(current.entry, current.scope, threadId);
      });
    },
    revoke(id) {
      return serialized(async () => {
        const found = lookup(id);
        if (!found) throw failure('SECRET_NOT_FOUND', 'The secret no longer exists.');
        for (const grants of chatGrants.values()) grants.delete(id);
        if (found.scope === 'always' && found.entry.approved) await persist({ ...state, secrets: state.secrets.map((entry) => entry.id === id ? { ...entry, approved: false } : entry) });
        changed();
        const current = lookup(id);
        return publicMeta(current.entry, current.scope);
      });
    },
    remove(id) {
      return serialized(async () => {
        const found = lookup(id);
        if (!found) throw failure('SECRET_NOT_FOUND', 'The secret no longer exists.');
        for (const grants of chatGrants.values()) grants.delete(id);
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
    /** 입력 직전에만 값을 꺼낸다. 승인과 범위를 다시 확인한다. */
    async resolveValue(id, threadId) {
      await readyPromise;
      const found = lookup(id, threadId);
      if (!found) throw failure('SECRET_NOT_FOUND', 'The secret no longer exists.');
      if (!isApproved(id, threadId)) throw failure('SECRET_APPROVAL_REQUIRED', `Call request_secret with secretId ${id} and end your turn.`);
      if (found.scope === 'chat') return chatSecrets.get(id).value;
      const value = await readValue(id);
      if (typeof value !== 'string' || !value) {
        missingValues.add(id);
        throw failure('SECRET_VALUE_UNAVAILABLE', `The saved value is gone. Call request_secret with secretId ${id} so the user can enter it again, then end your turn.`);
      }
      missingValues.delete(id);
      return value;
    },
    touch(id) {
      return serialized(async () => {
        const at = new Date(now()).toISOString();
        const chat = chatSecrets.get(id);
        if (chat) { chat.meta.lastUsedAt = at; return; }
        if (persisted(id)) await persist({ ...state, secrets: state.secrets.map((entry) => entry.id === id ? { ...entry, lastUsedAt: at } : entry) });
      }).then(changed, () => {});
    },
    /** 채팅이 끝나면 그 채팅의 승인과 "이 채팅" 비밀을 버린다. */
    endChat(threadId) {
      if (!threadId) return;
      chatEpochs.set(threadId, chatEpoch(threadId) + 1);
      chatGrants.delete(threadId);
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
        await persist({ schema: 1, secrets: [] });
        readyPromise = Promise.resolve();
        for (const threadId of chatGrants.keys()) chatEpochs.set(threadId, chatEpoch(threadId) + 1);
        chatSecrets.clear(); chatGrants.clear(); missingValues.clear();
        changed();
        return { cleared: true };
      };
      const task = queue.then(run, run);
      queue = task.catch(() => {});
      return task;
    },
  };
}
