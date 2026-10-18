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
const ORIGIN = 'https://accounts.example.com';
const accountInput = { origin: ORIGIN, label: 'School account', stableIdentity: 'stable-account-123' };
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
async function savedAccount(broker, { actor = agent, humanActor = owner, account = accountInput } = {}) {
  const request = await broker.requestAccount({ actor, origin: account.origin, label: account.label });
  return (await broker.saveLogin({ actor: humanActor, requestId: request.requestId, account, ...secretInput })).account;
}
const allowSite = (policy, scope = 'always', origin = ORIGIN) => policy.grantSiteAccess({ actor: owner, threadId: agent.threadId, origin, scope });
function binding(accountId, overrides = {}) {
  return { tabId: 'tab-a', runtimeGeneration: 1, navigationEpoch: 4, controlEpoch: 7, frameId: 'main', origin: ORIGIN, accountId, ...overrides };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('a saved login fills on its whole site in every chat once the site is allowed, without secrets in events or results', async (t) => {
  const { broker, policy, dataDir, secretStore, events } = await fixture(t);
  const account = await savedAccount(broker);
  assert.deepEqual([account.site, account.agentBlocked], ['example.com', false]);
  await assert.rejects(broker.issueHandle({ actor: agent, accountId: account.id, binding: binding(account.id) }), { code: 'BROWSER_PERMISSION_REQUIRED', reason: 'account-use' });
  await allowSite(policy);
  const restarted = createBrowserCredentialBroker({ dataDir, secretStore, policy: createBrowserPolicy({ dataDir }) });
  await restarted.ready();
  const other = { ...agent, threadId: 'chat-b', projectId: 'project-b' };
  const target = binding(account.id, { origin: 'https://login.example.com' });
  const use = await restarted.issueHandle({ actor: other, accountId: account.id, binding: target });
  let filled;
  const result = await restarted.fill({ actor: other, handle: use.handle, binding: target, getBinding: async () => target, fill: async ({ username, password, perform }) => { await perform(async () => { filled = { username, password }; }); } });
  assert.deepEqual(filled, secretInput);
  assert.deepEqual(result, { filled: true, accountId: account.id });
  await assert.rejects(restarted.issueHandle({ actor: other, accountId: account.id, binding: binding(account.id, { origin: 'https://example.org' }) }), { code: 'BROWSER_ACCOUNT_ORIGIN_MISMATCH' });
  const exposed = JSON.stringify({ events, result, accounts: await restarted.listAccounts(), request: use });
  assert.equal(exposed.includes(secretInput.password), false);
  assert.equal(exposed.includes(secretInput.username), false);
  assert.equal((await fs.readFile(path.join(dataDir, 'browser-accounts.json'), 'utf8')).includes(secretInput.password), false);
});

test('saving a login needs the owner, the asking chat, the same site and a live request', async (t) => {
  const { broker, secretStore } = await fixture(t);
  const request = await broker.requestAccount({ actor: agent, origin: ORIGIN, label: 'School' });
  const input = { actor: owner, requestId: request.requestId, account: accountInput, ...secretInput };
  await assert.rejects(broker.saveLogin({ ...input, actor: agent }), { code: 'BROWSER_OWNER_REQUIRED' });
  await assert.rejects(broker.saveLogin({ ...input, actor: { ...owner, projectId: 'wrong-project' } }), { code: 'BROWSER_ACCOUNT_CONSENT_REQUIRED' });
  await assert.rejects(broker.saveLogin({ ...input, account: { ...accountInput, origin: 'https://attacker.example.org' } }), { code: 'BROWSER_ACCOUNT_ORIGIN_MISMATCH' });
  assert.equal((await broker.listAccounts()).accounts.length, 0);
  const { account } = await broker.saveLogin({ ...input, account: { ...accountInput, origin: 'https://www.example.com' } });
  assert.equal(account.origin, 'https://www.example.com', 'any host of the same site');
  assert.ok(await secretStore.get(`browser.password.${account.id}`));
  await assert.rejects(broker.saveLogin(input), { code: 'BROWSER_ACCOUNT_REQUEST_EXPIRED' });
});

test('repeated requests for the same chat and site return the pending card', async (t) => {
  const { broker, events } = await fixture(t);
  const first = await broker.requestAccount({ actor: agent, origin: 'https://www.example.com', kind: 'site', logins: [{ id: crypto.randomUUID(), label: 'andy', origin: ORIGIN, source: 'hub' }] });
  const again = await broker.requestAccount({ actor: agent, origin: 'https://login.example.com', kind: 'site' });
  assert.equal(again.requestId, first.requestId);
  assert.equal(again.duplicate, true);
  assert.deepEqual([first.site, first.origins, first.scopes, first.accountLabel], ['example.com', ['https://example.com'], ['chat', 'always'], 'andy']);
  const other = await broker.requestAccount({ actor: { ...agent, threadId: 'chat-b' }, origin: ORIGIN, kind: 'site' });
  assert.notEqual(other.requestId, first.requestId);
  const blocked = await broker.requestAccount({ actor: { ...agent, threadId: 'chat-c' }, origin: ORIGIN, kind: 'site', blocked: ['download'] });
  assert.deepEqual(blocked.scopes, ['always'], 'lifting a block is saved for every chat');
  assert.equal(events.filter((event) => event.type === 'browser-account-request').length, 3);
  await assert.rejects(broker.requestAccount({ actor: agent, origin: ORIGIN, kind: 'sign-in' }), { code: 'BROWSER_TAB_REQUIRED' });
});

test('credential handles reject every changed identity, epoch, frame and origin before input', async (t) => {
  const { broker, policy } = await fixture(t);
  const account = await savedAccount(broker);
  await allowSite(policy);
  const original = binding(account.id);
  for (const override of [
    { tabId: 'tab-b' }, { runtimeGeneration: 2 }, { navigationEpoch: 5 }, { controlEpoch: 8 },
    { frameId: 'foreign-frame' }, { origin: 'https://docs.example.com' }, { accountId: crypto.randomUUID() },
  ]) {
    const use = await broker.issueHandle({ actor: agent, accountId: account.id, binding: original });
    let inputs = 0;
    await assert.rejects(broker.fill({ actor: agent, handle: use.handle, binding: { ...original, ...override }, getBinding: async () => original, fill: async () => { inputs++; } }), { code: 'BROWSER_CREDENTIAL_BINDING_STALE' });
    assert.equal(inputs, 0);
  }
  const use = await broker.issueHandle({ actor: agent, accountId: account.id, binding: original });
  await assert.rejects(broker.fill({ actor: { ...agent, agentId: 'another-agent' }, handle: use.handle, binding: original, getBinding: async () => original, fill: async () => {} }), { code: 'BROWSER_CREDENTIAL_BINDING_STALE' });
});

test('navigation during vault lookup, a turned-off login and a revoked site each stop credential fill', async (t) => {
  const { broker, policy, secretStore } = await fixture(t);
  const account = await savedAccount(broker);
  await allowSite(policy);
  const target = binding(account.id);
  const use = await broker.issueHandle({ actor: agent, accountId: account.id, binding: target });
  let fills = 0;
  await assert.rejects(broker.fill({ actor: agent, handle: use.handle, binding: target, getBinding: async () => ({ ...target, navigationEpoch: 99 }), fill: async () => { fills++; } }), { code: 'BROWSER_CREDENTIAL_BINDING_STALE' });
  const second = await broker.issueHandle({ actor: agent, accountId: account.id, binding: target });
  await broker.setLoginBlocked({ actor: owner, accountId: account.id, blocked: true });
  await assert.rejects(broker.fill({ actor: agent, handle: second.handle, binding: target, getBinding: async () => target, fill: async () => { fills++; } }), { code: 'BROWSER_CREDENTIAL_HANDLE_EXPIRED' });
  await assert.rejects(broker.issueHandle({ actor: agent, accountId: account.id, binding: target }), { code: 'BROWSER_SITE_BLOCKED' });
  assert.ok(await secretStore.get(`browser.password.${account.id}`), 'turning a login off keeps its password');
  await broker.setLoginBlocked({ actor: owner, accountId: account.id, blocked: false });
  const third = await broker.issueHandle({ actor: agent, accountId: account.id, binding: target });
  await policy.revokeSiteAccess({ actor: owner, origin: ORIGIN });
  await assert.rejects(broker.fill({ actor: agent, handle: third.handle, binding: target, getBinding: async () => target, fill: async () => { fills++; } }), { code: 'BROWSER_CREDENTIAL_HANDLE_EXPIRED' });
  assert.equal(fills, 0);
});

test('sign-out clears the site session and its marker, and forget deletes only that login', async (t) => {
  const { broker, policy, secretStore } = await fixture(t);
  const account = await savedAccount(broker);
  await secretStore.set('unrelated-provider', 'provider-fixture');
  await policy.markSignedIn({ profileId: 'default', origin: 'https://docs.example.com', source: 'owner-form' });
  const clears = [];
  broker.setSessionClearer(async (request) => { clears.push(request); });
  assert.equal((await broker.signOut({ actor: owner, accountId: account.id })).account.sessionStatus, 'signed-out');
  assert.deepEqual(clears.map((entry) => [entry.profileId, entry.origins]), [['default', [ORIGIN]]]);
  assert.equal((await policy.list()).signedIn.length, 0, 'the site marker is cleared without a reset');
  assert.ok(await secretStore.get(`browser.password.${account.id}`));
  await broker.forgetAccount({ actor: owner, accountId: account.id });
  assert.equal((await broker.listAccounts()).accounts.length, 0);
  assert.equal(await secretStore.get(`browser.password.${account.id}`), null);
  assert.equal(await secretStore.get('unrelated-provider'), 'provider-fixture');
});

test('checkpoints are encrypted storage that survives login changes, and sign-out removes them', async (t) => {
  const { broker, dataDir } = await fixture(t);
  const account = await savedAccount(broker);
  const storageState = { cookies: [{ name: 'session', value: 'private-cookie-fixture', domain: 'docs.example.com', path: '/' }], origins: [{ origin: 'https://docs.example.com', localStorage: [{ name: 'session', value: 'private-localstorage-fixture' }], indexedDB: [{ name: 'session-db', version: 1, stores: [{ name: 'login', records: [{ value: 'private-idb-fixture' }] }] }] }] };
  await broker.saveCheckpoint({ state: storageState });
  const filename = (await fs.readdir(path.join(dataDir, 'browser-auth')))[0];
  const encrypted = await fs.readFile(path.join(dataDir, 'browser-auth', filename), 'utf8');
  for (const value of ['private-cookie-fixture', 'private-localstorage-fixture', 'private-idb-fixture']) assert.equal(encrypted.includes(value), false);
  assert.deepEqual(await broker.restoreCheckpoint(), storageState);
  await broker.setLoginBlocked({ actor: owner, accountId: account.id, blocked: true });
  assert.deepEqual(await broker.restoreCheckpoint(), storageState, 'turning a login off leaves the profile alone');
  broker.setSessionClearer(async () => ({}));
  await broker.signOut({ actor: owner, accountId: account.id });
  assert.equal(await broker.restoreCheckpoint(), null);
});

test('standalone account storage fails closed without a vault and supports a separate secure key facility', async (t) => {
  const insecure = await fixture(t, { secretStore: { available: false } });
  await assert.rejects(savedAccount(insecure.broker), { code: 'BROWSER_SECURE_STORAGE_UNAVAILABLE' });
  assert.equal((await insecure.broker.listAccounts()).accounts.length, 0);
  const key = crypto.randomBytes(32);
  const secure = await fixture(t, { secretStore: { available: false }, wrappingKeyProvider: async () => key });
  const account = await savedAccount(secure.broker);
  await allowSite(secure.policy);
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

test('a finished sign-in handoff belongs to its chat and cannot be replayed', async (t) => {
  const { broker } = await fixture(t);
  const origin = 'https://login.example.com';
  const request = await broker.requestAccount({ actor: agent, tabId: 'tab-a', origin, label: 'Login', reason: 'Sign in', kind: 'sign-in' });
  assert.equal(request.kind, 'browser-sign-in');
  await assert.rejects(broker.completeHandoff({ actor: { ...owner, threadId: 'other' }, requestId: request.requestId }), { code: 'BROWSER_ACCOUNT_CONSENT_REQUIRED' });
  assert.deepEqual(await broker.completeHandoff({ actor: owner, requestId: request.requestId }).then(({ origin: done, site }) => [done, site]), [origin, 'example.com']);
  await assert.rejects(broker.completeHandoff({ actor: owner, requestId: request.requestId }), { code: 'BROWSER_ACCOUNT_REQUEST_EXPIRED' });
  const site = await broker.requestAccount({ actor: agent, origin, kind: 'site' });
  await assert.rejects(broker.completeHandoff({ actor: owner, requestId: site.requestId }), { code: 'BROWSER_ACCOUNT_REQUEST_INVALID' });
});

test('account denial consumes the exact pending request without saving a credential', async (t) => {
  const { broker } = await fixture(t);
  const request = await broker.requestAccount({ actor: agent, origin: ORIGIN });
  await assert.rejects(broker.cancelAccountRequest({ actor: { ...owner, threadId: 'other' }, requestId: request.requestId }), { code: 'BROWSER_ACCOUNT_CONSENT_REQUIRED' });
  await broker.cancelAccountRequest({ actor: owner, requestId: request.requestId });
  assert.equal(await broker.getAccountRequest(request.requestId), null);
  assert.equal((await broker.listAccounts()).accounts.length, 0);
});

test('sign-out or turning the login off while the vault is reading cannot fill a stale login', async (t) => {
  for (const operation of ['signout', 'block']) {
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
    const { broker, policy } = await fixture(t, { secretStore: delayedStore });
    const account = await savedAccount(broker);
    await allowSite(policy);
    broker.setSessionClearer(async () => ({ clearedOrigins: [ORIGIN] }));
    const target = binding(account.id);
    const use = await broker.issueHandle({ actor: agent, accountId: account.id, binding: target });
    let fills = 0;
    const rejected = assert.rejects(broker.fill({ actor: agent, handle: use.handle, binding: target, getBinding: async () => target, fill: async () => { fills++; } }),
      (error) => ['BROWSER_CREDENTIAL_BINDING_STALE', 'BROWSER_SITE_BLOCKED'].includes(error.code));
    await readEntered;
    if (operation === 'signout') await broker.signOut({ actor: owner, accountId: account.id });
    else await broker.setLoginBlocked({ actor: owner, accountId: account.id, blocked: true });
    release();
    await rejected;
    assert.equal(fills, 0);
  }
});

test('checkpoint writing during sign-out cannot restore the cleared cookie state', async (t) => {
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
  broker.setSessionClearer(async () => ({}));
  const save = broker.saveCheckpoint({ state: { cookies: [{ name: 'session', value: 'cleared-cookie-fixture', domain: 'example.com', path: '/' }], origins: [] } });
  await keyEntered;
  const signOut = broker.signOut({ actor: owner, accountId: account.id });
  release();
  await Promise.allSettled([save, signOut]);
  assert.equal(await broker.restoreCheckpoint(), null);
  const restarted = createBrowserCredentialBroker({ dataDir, secretStore: memory, policy: createBrowserPolicy({ dataDir }) });
  await restarted.ready();
  assert.equal(await restarted.restoreCheckpoint(), null);
});

test('a confirmed full-browser sign-in marks the site as signed in for each profile that holds the session', async (t) => {
  const { broker, policy } = await fixture(t);
  const account = await savedAccount(broker);
  await assert.rejects(broker.confirmAccountSession({ actor: agent, accountId: account.id }), { code: 'BROWSER_OWNER_REQUIRED' });
  const confirmed = await broker.confirmAccountSession({ actor: owner, accountId: account.id, additionalProfileId: 'native' });
  assert.equal(confirmed.account.sessionStatus, 'authenticated');
  assert.deepEqual((await policy.list()).signedIn.map((marker) => [marker.profileId, marker.key, marker.source]).sort(), [['default', 'https://example.com', 'handoff'], ['native', 'https://example.com', 'handoff']]);
  const cleared = [];
  broker.setSessionClearer(async ({ profileId }) => { cleared.push(profileId); return {}; });
  await broker.signOut({ actor: owner, accountId: account.id });
  assert.deepEqual(cleared.sort(), ['default', 'native']);
});

test('browser automation failures cannot disclose credentials through broker error messages', async (t) => {
  const { broker, policy, events } = await fixture(t);
  const account = await savedAccount(broker);
  await allowSite(policy);
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

test('turning a login off while its username field is hidden prevents both credential writes', async (t) => {
  const { broker, policy } = await fixture(t);
  const account = await savedAccount(broker);
  await allowSite(policy);
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
  await broker.setLoginBlocked({ actor: owner, accountId: account.id, blocked: true });
  visible.resolve();
  await fill;
  assert.deepEqual(writes, []);
});

test('revoking the site between credential fields prevents the remaining password write', async (t) => {
  const { broker, policy } = await fixture(t);
  const account = await savedAccount(broker);
  await allowSite(policy, 'chat');
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
  await policy.revokeSiteAccess({ actor: owner, origin: ORIGIN });
  passwordReady.resolve();
  await fill;
  assert.deepEqual(writes, ['username']);
});

test('turning a login off waits for an already-started browser write and blocks further fields', async (t) => {
  const { broker, policy } = await fixture(t);
  const account = await savedAccount(broker);
  await allowSite(policy);
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
  const blocking = broker.setLoginBlocked({ actor: owner, accountId: account.id, blocked: true }).then(() => { order.push('block-acknowledged'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);
  writeCompletes.resolve();
  await Promise.all([fill, blocking]);
  assert.deepEqual(order, ['username-written', 'block-acknowledged']);
});

test('browser cleanup purges logins, encryption keys and signed-in markers while keeping provider data, sites and blocks', { timeout: 5000 }, async (t) => {
  const memory = createMemorySecretStore();
  const phases = [];
  const secretStore = { ...memory, async resetBrowser(args) { phases.push('vault-purge'); return memory.resetBrowser(args); } };
  const { broker, dataDir, policy } = await fixture(t, { secretStore });
  const account = await savedAccount(broker);
  await memory.set('provider-token', 'provider-fixture');
  await fs.writeFile(path.join(dataDir, 'provider-data.json'), 'provider-data-fixture');
  await policy.update({ actor: owner, operation: 'set-site', origin: 'https://arxiv.org', blockedActions: ['download'] });
  await allowSite(policy);
  await policy.markSignedIn({ profileId: 'default', origin: ORIGIN, source: 'owner-form' });
  await broker.saveCheckpoint({ state: { cookies: [{ name: 'session', value: 'clear-cookie-fixture', domain: 'example.com', path: '/' }], origins: [] } });
  broker.setDataResetter(async ({ phase }) => {
    phases.push(phase);
    if (phase === 'before') await assert.rejects(broker.saveCheckpoint({ state: { cookies: [], origins: [] } }), { code: 'BROWSER_RESET_INCOMPLETE' });
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
  assert.ok(retained.sites.find((site) => site.origin === 'https://arxiv.org' && site.source === 'user').blockedActions.includes('download'));
  assert.ok(retained.sites.some((site) => site.origin === 'https://example.com'), 'site access stays');
  assert.deepEqual(retained.signedIn, []);
  await savedAccount(broker);
  const state = { cookies: [{ name: 'session', value: 'fresh-cookie-fixture', domain: 'example.com', path: '/' }], origins: [] };
  await broker.saveCheckpoint({ state });
  const restarted = createBrowserCredentialBroker({ dataDir, secretStore, policy: createBrowserPolicy({ dataDir }) });
  await restarted.ready();
  assert.deepEqual(await restarted.restoreCheckpoint(), state);
});

test('partial browser cleanup retains login identities, blocks credential use and supports an idempotent restart retry', async (t) => {
  const memory = createMemorySecretStore();
  let fail = true;
  const secretStore = { ...memory, async resetBrowser({ accountIds }) {
    if (fail) { await memory.delete(`browser.password.${accountIds[0]}`); throw new Error('OS store cleanup failed'); }
    return memory.resetBrowser();
  } };
  const { broker, dataDir, policy } = await fixture(t, { secretStore });
  const account = await savedAccount(broker);
  await allowSite(policy);
  await memory.set('provider-token', 'provider-fixture');
  broker.setDataResetter(async () => {});
  await assert.rejects(broker.resetBrowserData({ actor: owner }), { code: 'BROWSER_RESET_FAILED' });
  assert.equal((await broker.listAccounts()).accounts[0].id, account.id);
  await assert.rejects(broker.issueHandle({ actor: agent, accountId: account.id, binding: binding(account.id) }), { code: 'BROWSER_RESET_INCOMPLETE' });
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
  const checkpoint = assert.rejects(broker.saveCheckpoint({ state: { cookies: [{ name: 'session', value: 'late-cookie-fixture', domain: 'example.com', path: '/' }], origins: [] } }), { code: 'BROWSER_AUTH_RESET' });
  await keyRead.promise;
  const cleanup = broker.resetBrowserData({ actor: owner });
  await resetStarted.promise;
  allowKey.resolve();
  await Promise.all([checkpoint, cleanup]);
  assert.equal(await memory.get('browser.wrapping-key.v1'), null);
  await assert.rejects(fs.stat(path.join(dataDir, 'browser-auth')), { code: 'ENOENT' });
  assert.equal(await broker.restoreCheckpoint(), null);
});

test('tab sleep preferences persist and reject invalid or agent configuration changes', async (t) => {
  const { broker, dataDir, secretStore, policy } = await fixture(t);
  assert.equal((await broker.getConfiguration()).performance.idleMinutes, 15);
  assert.equal((await broker.getConfiguration()).searchEngine, 'google');
  for (const searchEngine of ['duckduckgo', 'google', 'bing', 'naver']) { await broker.updateConfiguration({ actor: owner, searchEngine }); assert.equal((await broker.getConfiguration()).searchEngine, searchEngine); }
  await assert.rejects(broker.updateConfiguration({ actor: owner, searchEngine: 'invalid' }), { code: 'BROWSER_CONFIGURATION_INVALID' });
  await broker.updateConfiguration({ actor: owner, performance: { idleMinutes: 1 } });
  const restarted = createBrowserCredentialBroker({ dataDir, secretStore, policy });
  assert.equal((await restarted.getConfiguration()).performance.idleMinutes, 1);
  assert.equal((await restarted.getConfiguration()).searchEngine, 'naver');
  for (const idleMinutes of [-1, 1.5, 1441]) await assert.rejects(broker.updateConfiguration({ actor: owner, performance: { idleMinutes } }), { code: 'BROWSER_CONFIGURATION_INVALID' });
  await assert.rejects(broker.updateConfiguration({ actor: agent, performance: { idleMinutes: 0 } }));
  assert.equal((await broker.getConfiguration()).performance.idleMinutes, 1);
  await broker.updateConfiguration({ actor: owner, performance: { idleMinutes: 0 } });
  assert.equal((await broker.getConfiguration()).performance.idleMinutes, 0);
});
