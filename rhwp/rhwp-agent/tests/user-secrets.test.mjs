import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBrowserWrappingKeyProvider } from '../browser-auth-store.mjs';
import { createMemorySecretStore } from '../secret-store.mjs';
import { createUserSecretStore } from '../user-secrets.mjs';

const origin = 'https://dashboard.example.test';
const value = 'sk-user-secret-fixture-31415';

async function dataDir(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-user-secrets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function readTree(root) {
  let text = '';
  for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) text += await fs.readFile(path.join(entry.parentPath ?? entry.path, entry.name), 'utf8');
  }
  return text;
}

test('saved secrets keep values only in the vault namespace and approvals follow their scope', async (t) => {
  const root = await dataDir(t);
  const vault = createMemorySecretStore();
  const store = createUserSecretStore({ dataDir: root, secretStore: vault });
  const saved = await store.save({ label: 'Dashboard key', kind: 'api-key', origins: [origin], value, scope: 'always', threadId: 'chat-a' });
  assert.equal(await vault.get(`usersecret.${saved.id}`), value);
  assert.equal((await readTree(root)).includes(value), false, 'metadata never holds the value');
  assert.deepEqual(await store.agentList('chat-a'), [{ id: saved.id, label: 'Dashboard key', kind: 'api-key', origins: [origin], approved: true }]);
  assert.equal((await store.agentList('chat-b'))[0].approved, false, 'another chat needs its own approval');
  await assert.rejects(store.resolveValue(saved.id, 'chat-b'), { code: 'SECRET_APPROVAL_REQUIRED' });
  assert.equal(await store.resolveValue(saved.id, 'chat-a'), value);

  // 이 채팅 승인은 채팅이 끝나면 사라진다. 영구 승인은 다시 열어도 남는다.
  store.endChat('chat-a');
  assert.equal(await store.isApproved(saved.id, 'chat-a'), false);
  await store.approve({ id: saved.id, scope: 'always', threadId: 'chat-b' });
  const reopened = createUserSecretStore({ dataDir: root, secretStore: vault });
  assert.equal(await reopened.isApproved(saved.id, 'chat-c'), true);
  await reopened.revoke(saved.id);
  assert.equal(await reopened.isApproved(saved.id, 'chat-b'), false);

  await reopened.remove(saved.id);
  assert.equal(await vault.get(`usersecret.${saved.id}`), null);
  assert.deepEqual(await reopened.list(), []);
});

test('without a vault only chat secrets exist, kept in memory, and a vault key file encrypts the fallback', async (t) => {
  const root = await dataDir(t);
  const store = createUserSecretStore({ dataDir: root, secretStore: null });
  assert.equal(store.vaultAvailable(), false);
  await assert.rejects(store.save({ label: 'Dashboard key', kind: 'api-key', origins: [origin], value, scope: 'always', threadId: 'chat-a' }), { code: 'SECRET_STORAGE_UNAVAILABLE' });
  const chat = await store.save({ label: 'Dashboard key', kind: 'api-key', origins: [origin], value, scope: 'chat', threadId: 'chat-a' });
  assert.equal(chat.scope, 'chat');
  assert.equal(await store.get(chat.id, 'chat-b'), null, 'a chat secret is invisible to other chats');
  assert.equal((await readTree(root)).includes(value), false, 'chat secrets never touch disk');
  store.endChat('chat-a');
  assert.equal(await store.get(chat.id, 'chat-a'), null);

  const keyRoot = await dataDir(t);
  const keyFile = path.join(keyRoot, 'wrapping.key');
  await fs.writeFile(keyFile, crypto.randomBytes(32), { mode: 0o600 });
  const encrypted = createUserSecretStore({ dataDir: root, secretStore: null, wrappingKeyProvider: createBrowserWrappingKeyProvider({ keyFile, dataDir: root }) });
  const saved = await encrypted.save({ label: 'Token', kind: 'token', origins: [origin], value, scope: 'always', threadId: 'chat-a' });
  assert.equal((await readTree(root)).includes(value), false, 'the fallback archive is encrypted');
  assert.equal(await encrypted.resolveValue(saved.id, 'chat-a'), value);
  await encrypted.reset();
  assert.deepEqual(await encrypted.list(), []);
  await assert.rejects(encrypted.resolveValue(saved.id, 'chat-a'), { code: 'SECRET_NOT_FOUND' });
});

test('reset recovers unreadable metadata, and a chat that ends while its secret is saving gets no grant', async (t) => {
  const root = await dataDir(t);
  await fs.writeFile(path.join(root, 'user-secrets.json'), JSON.stringify({ schema: 1, secrets: [{ id: 'not-a-secret-id' }] }));
  const vault = createMemorySecretStore();
  const broken = createUserSecretStore({ dataDir: root, secretStore: vault });
  await assert.rejects(broken.list(), { code: 'SECRET_STORAGE_INVALID' });
  await broken.reset();
  assert.deepEqual(await broken.list(), []);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowVault = { ...vault, set: async (key, stored) => { await gate; return vault.set(key, stored); } };
  const store = createUserSecretStore({ dataDir: root, secretStore: slowVault });
  const saving = store.save({ label: 'Dashboard key', kind: 'api-key', origins: [origin], value, scope: 'always', threadId: 'chat-a' });
  store.endChat('chat-a');
  release();
  const saved = await saving;
  assert.equal(await store.isApproved(saved.id, 'chat-a'), false, 'the ended chat cannot use it without asking again');
});
