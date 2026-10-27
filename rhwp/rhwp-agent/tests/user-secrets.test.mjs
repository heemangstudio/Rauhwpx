import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBrowserWrappingKeyProvider } from '../browser-auth-store.mjs';
import { createMemorySecretStore } from '../secret-store.mjs';
import { createUserSecretStore } from '../user-secrets.mjs';

const origin = 'https://dashboard.example.com';
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

test('saved secrets keep values only in the vault namespace, match their whole site and carry one agent-use switch', async (t) => {
  const root = await dataDir(t);
  const vault = createMemorySecretStore();
  const store = createUserSecretStore({ dataDir: root, secretStore: vault });
  const saved = await store.save({ label: 'Dashboard key', kind: 'api-key', origins: [origin], value, scope: 'always', threadId: 'chat-a' });
  assert.equal(await vault.get(`usersecret.${saved.id}`), value);
  assert.equal((await readTree(root)).includes(value), false, 'metadata never holds the value');
  assert.deepEqual(await store.agentList('chat-b'), [{ id: saved.id, label: 'Dashboard key', kind: 'api-key', origins: [origin], blocked: false }], 'a saved secret is visible to every chat');
  assert.deepEqual((await store.forSite('https://login.example.com', 'chat-b')).map((secret) => secret.id), [saved.id], 'the same registrable domain matches');
  assert.deepEqual(await store.forSite('https://example.org', 'chat-b'), []);
  assert.equal(await store.resolveValue(saved.id, 'chat-b'), value);

  await store.setBlocked(saved.id, true);
  const reopened = createUserSecretStore({ dataDir: root, secretStore: vault });
  assert.equal((await reopened.get(saved.id)).blocked, true, 'the switch persists');
  await reopened.touch(saved.id);
  assert.deepEqual(await reopened.filledValues({ since: 0 }), [value], 'filled values reload for redaction after a restart');
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

test('reset recovers unreadable metadata, and a chat deleted while its secret is saving keeps no chat value', async (t) => {
  const root = await dataDir(t);
  await fs.writeFile(path.join(root, 'user-secrets.json'), JSON.stringify({ schema: 1, secrets: [{ id: 'not-a-secret-id' }] }));
  const vault = createMemorySecretStore();
  const broken = createUserSecretStore({ dataDir: root, secretStore: vault });
  await assert.rejects(broken.list(), { code: 'SECRET_STORAGE_INVALID' });
  await broken.reset();
  assert.deepEqual(await broken.list(), []);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = createUserSecretStore({ dataDir: root, secretStore: { ...vault, set: async (key, stored) => { await gate; return vault.set(key, stored); } } });
  const saving = slow.save({ label: 'Slow key', kind: 'api-key', origins: [origin], value, scope: 'always', threadId: 'chat-a' });
  const chatSaving = slow.save({ label: 'Chat key', kind: 'api-key', origins: [origin], value, scope: 'chat', threadId: 'chat-a' });
  slow.endChat('chat-a');
  release();
  await saving;
  await assert.rejects(chatSaving, { code: 'SECRET_CHAT_ENDED' });
  assert.deepEqual((await slow.list({ threadId: 'chat-a' })).map((secret) => secret.label), ['Slow key'], 'a saved secret stays; the chat value is gone');
});

test('a secret too long for the Windows credential vault says so, and still saves for this chat', async (t) => {
  const { createBrowserOsSecretStore } = await import('../browser-os-secret-store.mjs');
  const root = await dataDir(t);
  const entries = new Map();
  class AsyncEntry {
    constructor(service, key) { this.id = `${service}\n${key}`; }
    async setSecret(secret) { entries.set(this.id, Uint8Array.from(secret)); }
    async getSecret() { return entries.get(this.id); }
    async deleteCredential() { return entries.delete(this.id); }
  }
  const vault = await createBrowserOsSecretStore({ dataDir: root, platform: 'win32', loadNative: async () => ({ AsyncEntry }) });
  const store = createUserSecretStore({ dataDir: root, secretStore: vault });
  const long = `-----BEGIN PRIVATE KEY-----${'A'.repeat(3000)}`;
  await assert.rejects(
    store.save({ label: 'Deploy key', kind: 'api-key', origins: [origin], value: long, scope: 'always', threadId: 'chat-a' }),
    (error) => error.code === 'SECRET_TOO_LARGE_FOR_VAULT' && /this chat only/.test(error.message),
  );
  const chat = await store.save({ label: 'Deploy key', kind: 'api-key', origins: [origin], value: long, scope: 'chat', threadId: 'chat-a' });
  assert.equal(await store.resolveValue(chat.id, 'chat-a'), long);
  const short = await store.save({ label: 'Short key', kind: 'api-key', origins: [origin], value, scope: 'always', threadId: 'chat-a' });
  assert.equal(await store.resolveValue(short.id, 'chat-b'), value);
});
