import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBrowserPolicy } from '../browser-policy.mjs';
import { createBrowserCredentialBroker } from '../browser-credentials.mjs';
import { createBrowserWrappingKeyProvider, createEncryptedBrowserAuthStore } from '../browser-auth-store.mjs';
import { createMemorySecretStore } from '../secret-store.mjs';

const agent = { threadId: 'chat-a', documentId: null, projectId: 'project-a', agentId: 'root', clientId: 'client-a', isHuman: false };
const owner = { ...agent, isHuman: true };
const accountInput = { origin: 'https://accounts.example.test', origins: ['https://accounts.example.test', 'https://docs.example.test'], label: 'School account', stableIdentity: 'stable-account-123' };
const secretInput = { username: 'private-user-fixture', password: 'private-password-fixture' };
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-browser-credentials-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const events = [];
  const policy = createBrowserPolicy({ dataDir });
  const secretStore = options.secretStore ?? createMemorySecretStore();
  const broker = createBrowserCredentialBroker({ dataDir, policy, secretStore, onEvent: (event) => events.push(event), ...options });
  await broker.ready();
  return { dataDir, broker, policy, secretStore, events };
}
async function savedAccount(broker, { actor = agent, humanActor = owner, account = accountInput, use = true } = {}) {
  const request = await broker.requestAccount({ actor, ...account, origins: account.origins });
  const response = await broker.submit({ actor: humanActor, requestId: request.requestId, approval: { approved: true, requestId: request.requestId, actor: humanActor, save: true, use }, account, ...secretInput, remember: true });
  return response.account;
}
function binding(accountId, overrides = {}) {
  return { tabId: 'tab-a', runtimeGeneration: 1, navigationEpoch: 4, controlEpoch: 7, frameId: 'main', origin: accountInput.origin, accountId, ...overrides };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('approved account survives restart and works across chats without sending secrets to events or results', async (t) => {
  const { broker, dataDir, secretStore, events } = await fixture(t);
  const account = await savedAccount(broker);
  assert.equal(account.agentReuseApproved, true);
  const restarted = createBrowserCredentialBroker({ dataDir, secretStore, policy: createBrowserPolicy({ dataDir }) });
  await restarted.ready();
  const other = { ...agent, threadId: 'chat-b', projectId: 'project-b' };
  await restarted.assertBrowserAccess({ actor: other, url: 'https://docs.example.test/private', tab: { profileId: 'default' } });
  const target = binding(account.id);
  const use = await restarted.issueHandle({ actor: other, accountId: account.id, binding: target });
  let filled;
  const result = await restarted.fill({ actor: other, handle: use.handle, binding: target, getBinding: async () => target, fill: async ({ username, password, perform }) => { await perform(async () => { filled = { username, password }; }); return filled; } });
  assert.deepEqual(filled, secretInput);
  assert.deepEqual(result, { filled: true, accountId: account.id });
  const exposed = JSON.stringify({ events, result, accounts: await restarted.listAccounts(), request: use });
  assert.equal(exposed.includes(secretInput.password), false);
  assert.equal(exposed.includes(secretInput.username), false);
  assert.equal((await fs.readFile(path.join(dataDir, 'browser-accounts.json'), 'utf8')).includes(secretInput.password), false);
});

test('secure submission requires exact one-use request consent and scope before vault writes', async (t) => {
  const { broker, secretStore } = await fixture(t);
  const request = await broker.requestAccount({ actor: agent, ...accountInput });
  const input = { actor: owner, requestId: request.requestId, approval: { approved: true, requestId: request.requestId, actor: owner, save: true, use: true }, account: accountInput, ...secretInput };
  await assert.rejects(broker.submit({ ...input, actor: agent }), { code: 'BROWSER_OWNER_REQUIRED' });
  await assert.rejects(broker.submit({ ...input, actor: { ...owner, projectId: 'wrong-project' } }), { code: 'BROWSER_ACCOUNT_CONSENT_REQUIRED' });
  await assert.rejects(broker.submit({ ...input, account: { ...accountInput, origin: 'https://attacker.example.test' } }), { code: 'BROWSER_ACCOUNT_ORIGIN_MISMATCH' });
  assert.equal((await broker.listAccounts()).accounts.length, 0);
  const { account } = await broker.submit(input);
  assert.ok(await secretStore.get(`browser.password.${account.id}`));
  await assert.rejects(broker.submit(input), { code: 'BROWSER_ACCOUNT_REQUEST_EXPIRED' });
});

test('credential handles reject every changed identity, epoch, frame and origin before input', async (t) => {
  const { broker } = await fixture(t);
  const account = await savedAccount(broker);
  const original = binding(account.id);
  for (const override of [
    { tabId: 'tab-b' }, { runtimeGeneration: 2 }, { navigationEpoch: 5 }, { controlEpoch: 8 },
    { frameId: 'foreign-frame' }, { origin: 'https://docs.example.test' }, { accountId: crypto.randomUUID() },
  ]) {
    const use = await broker.issueHandle({ actor: agent, accountId: account.id, binding: original });
    let inputs = 0;
    await assert.rejects(broker.fill({ actor: agent, handle: use.handle, binding: { ...original, ...override }, getBinding: async () => original, fill: async () => { inputs++; } }), { code: 'BROWSER_CREDENTIAL_BINDING_STALE' });
    assert.equal(inputs, 0);
  }
  const use = await broker.issueHandle({ actor: agent, accountId: account.id, binding: original });
  await assert.rejects(broker.fill({ actor: { ...agent, agentId: 'another-agent' }, handle: use.handle, binding: original, getBinding: async () => original, fill: async () => {} }), { code: 'BROWSER_CREDENTIAL_BINDING_STALE' });
});

test('navigation during vault lookup and permission revocation invalidate credential fill', async (t) => {
  const { broker, policy, secretStore } = await fixture(t);
  const account = await savedAccount(broker);
  const target = binding(account.id);
  const use = await broker.issueHandle({ actor: agent, accountId: account.id, binding: target });
  let fills = 0;
  await assert.rejects(broker.fill({ actor: agent, handle: use.handle, binding: target, getBinding: async () => ({ ...target, navigationEpoch: 99 }), fill: async () => { fills++; } }), { code: 'BROWSER_CREDENTIAL_BINDING_STALE' });
  assert.equal(fills, 0);
  const second = await broker.issueHandle({ actor: agent, accountId: account.id, binding: target });
  await policy.update({ actor: owner, operation: 'revoke-account', accountId: account.id });
  await assert.rejects(broker.fill({ actor: agent, handle: second.handle, binding: target, getBinding: async () => target, fill: async () => { fills++; } }), { code: 'BROWSER_CREDENTIAL_HANDLE_EXPIRED' });
  assert.ok(await secretStore.get(`browser.password.${account.id}`));
  await assert.rejects(broker.assertBrowserAccess({ actor: agent, url: accountInput.origin, tab: {} }), { code: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED' });
});

test('session-only human account registration enables retained login without a stored password', async (t) => {
  const { broker, secretStore } = await fixture(t);
  const request = await broker.requestAccount({ actor: owner, intent: 'use', ...accountInput });
  const { account } = await broker.approveAccount({ actor: owner, requestId: request.requestId, approval: { approved: true, requestId: request.requestId, use: true }, account: accountInput });
  assert.equal(account.hasPassword, false);
  assert.equal(account.agentReuseApproved, true);
  assert.equal(await secretStore.get(`browser.password.${account.id}`), null);
  await broker.assertBrowserAccess({ actor: agent, url: 'https://docs.example.test/private', tab: {} });
  const target = binding(account.id);
  const use = await broker.issueHandle({ actor: agent, accountId: account.id, binding: target });
  await assert.rejects(broker.fill({ actor: agent, handle: use.handle, binding: target, getBinding: async () => target, fill: async () => {} }), { code: 'BROWSER_ACCOUNT_PASSWORD_MISSING' });
});

test('sign-out clears shared sessions, revoke retains password, and forget deletes only that account', async (t) => {
  const { broker, secretStore } = await fixture(t);
  const account = await savedAccount(broker);
  await secretStore.set('unrelated-provider', 'provider-fixture');
  const clears = [];
  broker.setSessionClearer(async (request) => { clears.push(request); });
  assert.equal((await broker.signOut({ actor: owner, accountId: account.id })).account.sessionStatus, 'signed-out');
  assert.deepEqual(clears[0].origins, accountInput.origins);
  assert.ok(await secretStore.get(`browser.password.${account.id}`));
  await broker.revokeAccount({ actor: owner, accountId: account.id });
  assert.equal((await broker.listAccounts()).accounts[0].agentReuseApproved, false);
  await broker.forgetAccount({ actor: owner, accountId: account.id });
  assert.equal((await broker.listAccounts()).accounts.length, 0);
  assert.equal(await secretStore.get(`browser.password.${account.id}`), null);
  assert.equal(await secretStore.get('unrelated-provider'), 'provider-fixture');
});

test('cookies, localStorage and IndexedDB checkpoint bytes are encrypted and cannot restore after revocation', async (t) => {
  const { broker, dataDir } = await fixture(t);
  const account = await savedAccount(broker);
  const storageState = { cookies: [{ name: 'session', value: 'private-cookie-fixture', domain: 'docs.example.test', path: '/' }], origins: [{ origin: 'https://docs.example.test', localStorage: [{ name: 'session', value: 'private-localstorage-fixture' }], indexedDB: [{ name: 'session-db', version: 1, stores: [{ name: 'login', records: [{ value: 'private-idb-fixture' }] }] }] }] };
  await broker.saveCheckpoint({ state: storageState });
  const filename = (await fs.readdir(path.join(dataDir, 'browser-auth')))[0];
  const encrypted = await fs.readFile(path.join(dataDir, 'browser-auth', filename), 'utf8');
  for (const value of ['private-cookie-fixture', 'private-localstorage-fixture', 'private-idb-fixture']) assert.equal(encrypted.includes(value), false);
  assert.deepEqual(await broker.restoreCheckpoint(), storageState);
  await broker.revokeAccount({ actor: owner, accountId: account.id });
  assert.equal(await broker.restoreCheckpoint(), null);
  await broker.saveCheckpoint({ state: storageState });
  assert.equal(await broker.restoreCheckpoint(), null);
});

test('standalone account storage fails closed without a vault and supports a separate secure key facility', async (t) => {
  const insecure = await fixture(t, { secretStore: { available: false } });
  await assert.rejects(savedAccount(insecure.broker), { code: 'BROWSER_SECURE_STORAGE_UNAVAILABLE' });
  assert.equal((await insecure.broker.listAccounts()).accounts.length, 0);
  const key = crypto.randomBytes(32);
  const secure = await fixture(t, { secretStore: { available: false }, wrappingKeyProvider: async () => key });
  const account = await savedAccount(secure.broker);
  const passwordArchive = (await fs.readdir(path.join(secure.dataDir, 'browser-credentials')))[0];
  assert.equal((await fs.readFile(path.join(secure.dataDir, 'browser-credentials', passwordArchive), 'utf8')).includes(secretInput.password), false);
  const target = binding(account.id);
  const use = await secure.broker.issueHandle({ actor: agent, accountId: account.id, binding: target });
  await secure.broker.fill({ actor: agent, handle: use.handle, binding: target, getBinding: async () => target, fill: async ({ username, password, perform }) => perform(async () => assert.deepEqual({ username, password }, secretInput)) });
});

test('encrypted auth archive bounds and authentication reject corruption while retaining ciphertext', async (t) => {
  const { dataDir } = await fixture(t);
  const store = createEncryptedBrowserAuthStore({ dataDir, wrappingKeyProvider: async () => Buffer.alloc(32, 1), maxCheckpointBytes: 1024 });
  await assert.rejects(store.saveCheckpoint('oversized', { value: 'x'.repeat(2048) }), { code: 'BROWSER_AUTH_STORAGE_LIMIT' });
  await store.saveCheckpoint('default', { value: 'retained-fixture' });
  const filename = (await fs.readdir(path.join(dataDir, 'browser-auth')))[0];
  const location = path.join(dataDir, 'browser-auth', filename);
  const envelope = JSON.parse(await fs.readFile(location, 'utf8'));
  envelope.tag = Buffer.alloc(16).toString('base64');
  await fs.writeFile(location, JSON.stringify(envelope));
  await assert.rejects(store.restoreCheckpoint('default'), { code: 'BROWSER_AUTH_STORAGE_INVALID' });
  assert.ok(await fs.stat(location));
});

test('standalone wrapping-key file must stay outside browser data and be owner-only', async (t) => {
  const { dataDir } = await fixture(t);
  const inside = path.join(dataDir, 'key');
  await fs.writeFile(inside, crypto.randomBytes(32), { mode: 0o600 });
  await assert.rejects(createBrowserWrappingKeyProvider({ dataDir, keyFile: inside })(), { code: 'BROWSER_INSECURE_KEY_FILE' });
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-browser-key-'));
  t.after(() => fs.rm(outsideDir, { recursive: true, force: true }));
  const outside = path.join(outsideDir, 'key');
  const value = crypto.randomBytes(32);
  await fs.writeFile(outside, value, { mode: 0o600 });
  assert.deepEqual(await createBrowserWrappingKeyProvider({ dataDir, keyFile: outside })(), value);
  if (process.platform !== 'win32') {
    await fs.chmod(outside, 0o644);
    await assert.rejects(createBrowserWrappingKeyProvider({ dataDir, keyFile: outside })(), { code: 'BROWSER_INSECURE_KEY_FILE' });
  }
});

test('unknown retained human sessions block agent reads across cookie subdomains until exact account approval', async (t) => {
  const { broker, dataDir, secretStore } = await fixture(t);
  await broker.registerSessionOrigins({ profileId: 'default', origins: ['https://accounts.example.test'], domains: ['.example.test'], source: 'human' });
  await assert.rejects(broker.assertBrowserAccess({ actor: agent, url: 'https://docs.example.test/private', tab: {} }), { code: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED' });
  await broker.assertBrowserAccess({ actor: owner, url: 'https://docs.example.test/private', tab: {} });
  await broker.assertBrowserAccess({ actor: agent, url: 'https://unrelated.test/public', tab: {} });
  const request = await broker.requestAccount({ actor: owner, intent: 'use', ...accountInput });
  const { account } = await broker.approveAccount({ actor: owner, requestId: request.requestId, approval: { approved: true, requestId: request.requestId, use: true }, account: accountInput });
  await broker.assertBrowserAccess({ actor: agent, url: 'https://docs.example.test/private', tab: {} });
  await assert.rejects(broker.assertBrowserAccess({ actor: agent, url: 'https://other.example.test/private', tab: {} }), { code: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED' });
  const restarted = createBrowserCredentialBroker({ dataDir, secretStore, policy: createBrowserPolicy({ dataDir }) });
  await restarted.ready();
  await restarted.assertBrowserAccess({ actor: { ...agent, projectId: 'project-b' }, url: 'https://docs.example.test/private', tab: {} });
  await restarted.registerSessionOrigins({ profileId: 'default', domains: ['example.test'], source: 'human' });
  assert.equal((await restarted.listAccounts()).accounts[0].sessionApprovalRequired, true);
  await assert.rejects(restarted.assertBrowserAccess({ actor: agent, url: 'https://docs.example.test/private', tab: {} }), { code: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED' });
  await restarted.confirmAccountSession({ actor: owner, accountId: account.id });
  await restarted.assertBrowserAccess({ actor: agent, url: 'https://docs.example.test/private', tab: {} });
});

test('account denial consumes the exact pending request without saving a credential', async (t) => {
  const { broker } = await fixture(t);
  const request = await broker.requestAccount({ actor: agent, ...accountInput });
  await assert.rejects(broker.cancelAccountRequest({ actor: { ...owner, threadId: 'other' }, requestId: request.requestId }), { code: 'BROWSER_ACCOUNT_CONSENT_REQUIRED' });
  await broker.cancelAccountRequest({ actor: owner, requestId: request.requestId });
  assert.equal(await broker.getAccountRequest(request.requestId), null);
  assert.equal((await broker.listAccounts()).accounts.length, 0);
});

test('sign-out and human account switch while the vault is reading cannot fill a stale login', async (t) => {
  for (const operation of ['signout', 'human-session']) {
    const memory = createMemorySecretStore();
    let release;
    let entered;
    const readEntered = new Promise((resolve) => { entered = resolve; });
    const delayedStore = {
      ...memory,
      async get(key) {
        const value = await memory.get(key);
        if (!key.startsWith('browser.password.')) return value;
        entered();
        return new Promise((resolve) => { release = () => resolve(value); });
      },
    };
    const { broker } = await fixture(t, { secretStore: delayedStore });
    const account = await savedAccount(broker);
    broker.setSessionClearer(async () => ({ clearedDomains: ['example.test'], clearedOrigins: accountInput.origins }));
    const target = binding(account.id);
    const use = await broker.issueHandle({ actor: agent, accountId: account.id, binding: target });
    let fills = 0;
    const rejected = assert.rejects(broker.fill({ actor: agent, handle: use.handle, binding: target, getBinding: async () => target, fill: async () => { fills++; } }), {
      code: operation === 'signout' ? 'BROWSER_CREDENTIAL_BINDING_STALE' : 'BROWSER_ACCOUNT_APPROVAL_REQUIRED',
    });
    await readEntered;
    if (operation === 'signout') await broker.signOut({ actor: owner, accountId: account.id });
    else await broker.registerSessionOrigins({ domains: ['example.test'], source: 'human' });
    release();
    await rejected;
    assert.equal(fills, 0);
  }
});

test('checkpoint writing during revocation cannot restore the revoked cookie state', async (t) => {
  const memory = createMemorySecretStore();
  let release;
  let entered;
  const keyEntered = new Promise((resolve) => { entered = resolve; });
  const delayedStore = {
    ...memory,
    async get(key) {
      const value = await memory.get(key);
      if (key !== 'browser.wrapping-key.v1') return value;
      entered();
      return new Promise((resolve) => { release = () => resolve(value); });
    },
  };
  const { broker, dataDir } = await fixture(t, { secretStore: delayedStore });
  const account = await savedAccount(broker);
  const save = broker.saveCheckpoint({ state: { cookies: [{ name: 'session', value: 'revoked-cookie-fixture', domain: 'example.test', path: '/' }], origins: [] } });
  await keyEntered;
  const revoke = broker.revokeAccount({ actor: owner, accountId: account.id });
  release();
  await Promise.all([save, revoke]);
  assert.equal(await broker.restoreCheckpoint(), null);
  const restarted = createBrowserCredentialBroker({ dataDir, secretStore: memory, policy: createBrowserPolicy({ dataDir }) });
  await restarted.ready();
  assert.equal(await restarted.restoreCheckpoint(), null);
  await assert.rejects(restarted.assertBrowserAccess({ actor: agent, url: accountInput.origin, tab: {} }), { code: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED' });
});

test('explicit signed-in account confirmation binds the current human session and retains approval through restart', async (t) => {
  const { broker, dataDir, secretStore } = await fixture(t);
  const request = await broker.requestAccount({ actor: owner, intent: 'use', ...accountInput });
  const { account } = await broker.approveAccount({ actor: owner, requestId: request.requestId, approval: { approved: true, requestId: request.requestId, use: true }, account: accountInput });
  assert.equal(account.sessionStatus, 'session-retained');
  await broker.registerSessionOrigins({ domains: ['example.test'], source: 'human' });
  await assert.rejects(broker.assertBrowserAccess({ actor: agent, url: accountInput.origin, tab: {} }), { code: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED' });
  await assert.rejects(broker.confirmAccountSession({ actor: agent, accountId: account.id }), { code: 'BROWSER_OWNER_REQUIRED' });
  const confirmed = await broker.confirmAccountSession({ actor: owner, accountId: account.id });
  assert.equal(confirmed.account.sessionStatus, 'authenticated');
  assert.equal(confirmed.account.agentReuseApproved, true);
  const state = { cookies: [{ name: 'session', value: 'confirmed-cookie-fixture', domain: '.example.test', path: '/' }], origins: [] };
  await broker.saveCheckpoint({ state });
  const restarted = createBrowserCredentialBroker({ dataDir, secretStore, policy: createBrowserPolicy({ dataDir }) });
  await restarted.ready();
  assert.deepEqual(await restarted.restoreCheckpoint(), state);
  await restarted.assertBrowserAccess({ actor: { ...agent, threadId: 'new-chat', projectId: 'new-project' }, url: 'https://docs.example.test/private', tab: {} });
  assert.equal((await restarted.listAccounts()).accounts[0].stableIdentity, accountInput.stableIdentity);
});

test('browser automation failures cannot disclose credentials through broker error messages', async (t) => {
  const { broker, events } = await fixture(t);
  const account = await savedAccount(broker);
  const target = binding(account.id);
  const use = await broker.issueHandle({ actor: agent, accountId: account.id, binding: target });
  let error;
  try {
    await broker.fill({ actor: agent, handle: use.handle, binding: target, getBinding: async () => target, fill: async ({ username, password }) => {
      throw new Error(`Automation call failed for fill(${username},${password})`);
    } });
  } catch (failure) { error = failure; }
  assert.equal(error.code, 'BROWSER_CREDENTIAL_FILL_FAILED');
  const exposed = JSON.stringify({ events, code: error.code, message: error.message, stack: error.stack });
  assert.equal(exposed.includes(secretInput.username), false);
  assert.equal(exposed.includes(secretInput.password), false);
});

test('revoking an account while its username field is hidden prevents both credential writes', async (t) => {
  const { broker } = await fixture(t);
  const account = await savedAccount(broker);
  const target = binding(account.id);
  const use = await broker.issueHandle({ actor: agent, accountId: account.id, binding: target });
  const waiting = deferred(), visible = deferred();
  const writes = [];
  const fill = assert.rejects(broker.fill({ actor: agent, handle: use.handle, binding: target, getBinding: async () => target,
    fill: async ({ assertAuthorized, perform }) => {
      waiting.resolve();
      await visible.promise;
      await assertAuthorized();
      await perform(async () => { writes.push('username'); });
      await perform(async () => { writes.push('password'); });
    },
  }), { code: 'BROWSER_CREDENTIAL_FILL_FAILED' });
  await waiting.promise;
  await broker.revokeAccount({ actor: owner, accountId: account.id });
  visible.resolve();
  await fill;
  assert.deepEqual(writes, []);
});

test('permission revocation between credential fields prevents the remaining password write', async (t) => {
  const { broker, policy } = await fixture(t);
  const account = await savedAccount(broker);
  const target = binding(account.id);
  const use = await broker.issueHandle({ actor: agent, accountId: account.id, binding: target });
  const firstWritten = deferred(), passwordReady = deferred();
  const writes = [];
  const fill = assert.rejects(broker.fill({ actor: agent, handle: use.handle, binding: target, getBinding: async () => target,
    fill: async ({ perform }) => {
      await perform(async () => { writes.push('username'); });
      firstWritten.resolve();
      await passwordReady.promise;
      await perform(async () => { writes.push('password'); });
    },
  }), { code: 'BROWSER_CREDENTIAL_FILL_FAILED' });
  await firstWritten.promise;
  await policy.update({ actor: owner, operation: 'revoke-account', accountId: account.id });
  passwordReady.resolve();
  await fill;
  assert.deepEqual(writes, ['username']);
});

test('revocation acknowledgement waits for an already-started browser write and blocks further fields', async (t) => {
  const { broker } = await fixture(t);
  const account = await savedAccount(broker);
  const target = binding(account.id);
  const use = await broker.issueHandle({ actor: agent, accountId: account.id, binding: target });
  const writeStarted = deferred(), writeCompletes = deferred();
  const order = [];
  const fill = assert.rejects(broker.fill({ actor: agent, handle: use.handle, binding: target, getBinding: async () => target,
    fill: async ({ perform }) => {
      await perform(async () => { writeStarted.resolve(); await writeCompletes.promise; order.push('username-written'); });
      await perform(async () => { order.push('password-written'); });
    },
  }), { code: 'BROWSER_CREDENTIAL_FILL_FAILED' });
  await writeStarted.promise;
  const revocation = broker.revokeAccount({ actor: owner, accountId: account.id }).then(() => { order.push('revocation-acknowledged'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);
  writeCompletes.resolve();
  await Promise.all([fill, revocation]);
  assert.deepEqual(order, ['username-written', 'revocation-acknowledged']);
});

test('browser cleanup purges only its accounts and encryption keys while preserving provider data and site permissions', { timeout: 5000 }, async (t) => {
  const memory = createMemorySecretStore();
  const phases = [];
  const secretStore = { ...memory, async resetBrowser(args) { phases.push('vault-purge'); return memory.resetBrowser(args); } };
  const { broker, dataDir, policy } = await fixture(t, { secretStore });
  const account = await savedAccount(broker);
  await memory.set('provider-token', 'provider-fixture');
  await fs.writeFile(path.join(dataDir, 'provider-data.json'), 'provider-data-fixture');
  await policy.update({ actor: owner, operation: 'set-default', key: 'browse', enabled: false });
  await policy.update({ actor: owner, operation: 'set-site', origin: 'https://arxiv.org', blockedActions: ['download'] });
  await broker.saveCheckpoint({ state: { cookies: [{ name: 'session', value: 'clear-cookie-fixture', domain: 'example.test', path: '/' }], origins: [] } });
  broker.setDataResetter(async ({ phase }) => {
    phases.push(phase);
    if (phase === 'before') {
      await assert.rejects(broker.saveCheckpoint({ state: { cookies: [], origins: [] } }), { code: 'BROWSER_RESET_INCOMPLETE' });
      await assert.rejects(broker.registerSessionOrigins({ domains: ['example.test'], source: 'human' }), { code: 'BROWSER_RESET_INCOMPLETE' });
    }
  });
  await assert.rejects(broker.resetBrowserData({ actor: agent }), { code: 'BROWSER_OWNER_REQUIRED' });
  assert.equal((await broker.resetBrowserData({ actor: owner })).cleared, true);
  assert.deepEqual(phases, ['before', 'vault-purge', 'after']);
  assert.equal((await broker.listAccounts()).accounts.length, 0);
  assert.equal(await memory.get(`browser.password.${account.id}`), null);
  assert.equal(await memory.get('browser.wrapping-key.v1'), null);
  assert.equal(await memory.get('provider-token'), 'provider-fixture');
  assert.equal(await fs.readFile(path.join(dataDir, 'provider-data.json'), 'utf8'), 'provider-data-fixture');
  await assert.rejects(fs.stat(path.join(dataDir, 'browser-auth')), { code: 'ENOENT' });
  const retained = await policy.list();
  assert.equal(retained.defaults.browse, false);
  assert.ok(retained.sites.find((site) => site.origin === 'https://arxiv.org').blockedActions.includes('download'));
  assert.equal(retained.accounts.length, 0);
  await savedAccount(broker);
  const state = { cookies: [{ name: 'session', value: 'fresh-cookie-fixture', domain: 'example.test', path: '/' }], origins: [] };
  await broker.saveCheckpoint({ state });
  const restarted = createBrowserCredentialBroker({ dataDir, secretStore, policy: createBrowserPolicy({ dataDir }) });
  await restarted.ready();
  assert.deepEqual(await restarted.restoreCheckpoint(), state);
});

test('partial browser cleanup retains account identities, blocks authentication and supports an idempotent restart retry', async (t) => {
  const memory = createMemorySecretStore();
  let fail = true;
  const secretStore = { ...memory, async resetBrowser({ accountIds }) {
    if (fail) { await memory.delete(`browser.password.${accountIds[0]}`); throw new Error('OS store cleanup failed'); }
    return memory.resetBrowser();
  } };
  const { broker, dataDir } = await fixture(t, { secretStore });
  const account = await savedAccount(broker);
  await memory.set('provider-token', 'provider-fixture');
  broker.setDataResetter(async () => {});
  await assert.rejects(broker.resetBrowserData({ actor: owner }), { code: 'BROWSER_RESET_FAILED' });
  assert.equal((await broker.listAccounts()).accounts[0].id, account.id);
  await assert.rejects(broker.assertBrowserAccess({ actor: agent, url: accountInput.origin, tab: {} }), { code: 'BROWSER_RESET_INCOMPLETE' });
  assert.equal(await broker.restoreCheckpoint(), null);
  fail = false;
  const restarted = createBrowserCredentialBroker({ dataDir, secretStore, policy: createBrowserPolicy({ dataDir }) });
  await restarted.ready();
  restarted.setDataResetter(async () => {});
  await restarted.resetBrowserData({ actor: owner });
  assert.equal((await restarted.listAccounts()).accounts.length, 0);
  assert.equal(await memory.get('provider-token'), 'provider-fixture');
  assert.equal(await memory.get('browser.wrapping-key.v1'), null);
});

test('cleanup drains a pending wrapping-key write before vault purge and prevents late authentication archives', async (t) => {
  const memory = createMemorySecretStore();
  const keyRead = deferred(), allowKey = deferred(), resetStarted = deferred();
  const secretStore = { ...memory, async get(key) {
    const value = await memory.get(key);
    if (key !== 'browser.wrapping-key.v1') return value;
    keyRead.resolve();
    await allowKey.promise;
    return value;
  } };
  const { broker, dataDir } = await fixture(t, { secretStore, onEvent: (event) => { if (event.type === 'browser-data-reset-started') resetStarted.resolve(); } });
  await savedAccount(broker);
  broker.setDataResetter(async () => {});
  const checkpoint = assert.rejects(broker.saveCheckpoint({ state: { cookies: [{ name: 'session', value: 'late-cookie-fixture', domain: 'example.test', path: '/' }], origins: [] } }), { code: 'BROWSER_AUTH_RESET' });
  await keyRead.promise;
  const cleanup = broker.resetBrowserData({ actor: owner });
  await resetStarted.promise;
  allowKey.resolve();
  await Promise.all([checkpoint, cleanup]);
  assert.equal(await memory.get('browser.wrapping-key.v1'), null);
  await assert.rejects(fs.stat(path.join(dataDir, 'browser-auth')), { code: 'ENOENT' });
  assert.equal(await broker.restoreCheckpoint(), null);
});
