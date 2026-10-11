import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { createOwnedBrowserService } from '../owned-browser-service.mjs';
import { createBrowserPolicy } from '../browser-policy.mjs';
import { createBrowserCredentialBroker } from '../browser-credentials.mjs';

const origin = 'https://site.example';
const actor = { isHuman: true, clientId: 'editor', sessionId: 'editor', threadId: 'research', agentId: 'owner' };
const account = { id: 'approved-site', profileId: 'default', origins: [origin], agentReuseApproved: true, sessionStatus: 'saved' };
const cookie = (name, domain, value) => ({ name, domain, value, path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' });

async function harness(t, { failSignIn = false, protectedAutofill = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-native-passkey-handoff-'));
  const checkpoints = new Map();
  const launches = [];
  const imports = [];
  const confirmations = [];
  let clearSession;
  const bindings = [];
  const pages = [];
  let shielded = false;
  let nativeStorage = { cookies: [cookie('oldSession', 'site.example', 'before')], origins: [] };
  if (protectedAutofill) nativeStorage.origins = [{ origin: 'https://unrelated.example', localStorage: [{ name: 'keep', value: 'retained-private' }], indexedDB: [{ name: 'retained-database' }] }];
  const signedInStorage = { cookies: [cookie('siteSession', 'site.example', 'after'), cookie('unrelatedSession', 'unrelated.example', 'private-unrelated')],
    origins: [{ origin, localStorage: [{ name: 'sessionFlag', value: 'approved' }] }, { origin: 'https://unrelated.example', localStorage: [{ name: 'unrelatedFlag', value: 'private' }] }] };
  const nativeAdapter = {
    async bind(value) { bindings.push(value); }, async control() {},
    async inventory() { return pages.map((page) => ({ nativeTargetId: page.target, passwordProtected: shielded, tabId: bindings.find((entry) => entry.targetId === page.target)?.tabId })); },
  };
  if (protectedAutofill) Object.assign(nativeAdapter, {
    async passwordFill() { shielded = true; return { completed: true }; },
    async passwordStorageState() { return shielded ? { cookies: structuredClone(nativeStorage.cookies), origins: [] } : null; },
    async importSession({ origins, state, reload }) {
      assert.deepEqual(origins, [origin]);
      assert.ok(state.cookies.every((entry) => entry.domain === 'site.example'));
      assert.ok(state.origins.every((entry) => entry.origin === origin));
      imports.push({ kind: 'main', state: structuredClone(state) });
      nativeStorage = { cookies: [...nativeStorage.cookies.filter((entry) => entry.domain !== 'site.example'), ...state.cookies],
        origins: [...nativeStorage.origins.filter((entry) => !origins.includes(entry.origin)), ...state.origins] };
      if (reload) for (const page of pages) if (origins.includes(new URL(page.url()).origin)) await page.reload();
    },
  });
  const newNativePage = () => {
    let url = 'about:blank'; let closed = false;
    const frame = { url: () => url };
    const page = Object.assign(new EventEmitter(), { target: `native-target-${pages.length}`, navigations: [],
      authenticated: false, url: () => url, isClosed: () => closed, mainFrame: () => frame, frames: () => [frame],
      async goto(destination) { url = destination; page.navigations.push(destination); page.authenticated = nativeStorage.cookies.some((entry) => entry.name === 'siteSession'); },
      async reload() { await page.goto(url); }, async title() { return 'Fixture site'; }, async evaluate() { return 'complete'; },
      async routeWebSocket() { if (shielded) throw new Error('Protected native JS binding denied'); }, async close() { closed = true; page.emit('close'); } });
    pages.push(page); return page;
  };
  const contextFor = (kind) => Object.assign(new EventEmitter(), {
    async storageState() { if (kind === 'native' && shielded) throw new Error('Raw protected storage denied'); return structuredClone(kind === 'native' ? nativeStorage : signedInStorage); },
    async setStorageState(state) { if (kind === 'native' && shielded) throw new Error('Protected session requires a scoped main import'); imports.push({ kind, state: structuredClone(state) }); if (kind === 'native') nativeStorage = structuredClone(state); },
    async route() {}, pages: () => kind === 'native' ? pages.filter((page) => !page.isClosed()) : [],
    async newPage() { assert.equal(kind, 'native'); return newNativePage(); },
    async newCDPSession(page) { return { async send() { return { targetInfo: { targetId: page.target } }; }, async detach() {} }; },
  });
  const browser = createOwnedBrowserService({ dataDir, nativeAdapter, lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    runtimeFactory: async ({ nativeAdapter: selected }) => {
      const kind = selected ? 'native' : 'chrome'; launches.push(kind);
      return { kind, browser: new EventEmitter(), context: contextFor(kind), async close() {} };
    },
    signInFactory: async (settings) => {
      assert.equal(settings.authenticationMethod, 'mac-passkey');
      if (failSignIn) throw Object.assign(new Error('Controlled Chrome launch failure'), { code: 'BROWSER_SIGN_IN_START_FAILED' });
      return { mode: 'standalone-no-debug', provider: 'chrome', authenticationMethod: 'mac-passkey', exited: false, async close() {} };
    },
    credentialBroker: {
      async listAccounts() { return { accounts: [account] }; }, setSessionClearer(clearer) { clearSession = clearer; },
      async registerSessionOrigins() {}, async assertBrowserAccess() {},
      async saveCheckpoint({ profileId, state }) { checkpoints.set(profileId, structuredClone(state)); },
      async restoreCheckpoint({ profileId }) { return checkpoints.get(profileId) ?? null; },
      async deleteCheckpoint({ profileId }) { checkpoints.delete(profileId); },
      async confirmAccountSession(settings) { confirmations.push(settings); return { account: { ...account, sessionStatus: 'authenticated' } }; },
    },
  });
  t.after(async () => { await browser.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const opened = await browser.request(actor, 'open', { url: `${origin}/research` });
  return { browser, opened, nativeAdapter, clearSession: (...args) => clearSession(...args), launches, imports, confirmations, pages, bindings, storage: () => nativeStorage };
}

test('Mac passkey confirmation returns approved website authentication to the retained native guest', async (t) => {
  const f = await harness(t);
  const before = f.opened.tab;
  const handoff = await f.browser.request(actor, 'sign-in', { accountId: account.id, url: `${origin}/login`, authenticationMethod: 'mac-passkey' });
  assert.equal(handoff.runtime.state, 'sign-in');
  await assert.rejects(f.browser.request({ threadId: 'research', agentId: 'owner' }, 'open', {}), { code: 'BROWSER_SIGN_IN_ACTIVE' });
  const confirmed = await f.browser.request(actor, 'confirm-sign-in', { accountId: account.id });
  assert.equal(confirmed.runtime.mode, 'native');
  assert.equal(confirmed.runtime.kind, 'native');
  assert.deepEqual(f.launches, ['native', 'chrome', 'native']);
  assert.equal(f.confirmations[0].additionalProfileId, 'native');
  const retained = (await f.browser.inventory(actor)).tabs.find((tab) => tab.tabId === before.tabId);
  assert.equal(retained.nativeTargetId, before.nativeTargetId);
  assert.equal(retained.status, 'ready');
  assert.equal(retained.profileId, 'native');
  assert.equal(retained.threadId, before.threadId);
  assert.equal(f.storage().cookies.some((entry) => entry.name === 'siteSession'), true);
  assert.equal(f.storage().cookies.some((entry) => entry.name === 'oldSession'), false);
  assert.equal(f.storage().cookies.some((entry) => entry.name === 'unrelatedSession'), false);
  assert.deepEqual(f.storage().origins.map((entry) => entry.origin), [origin]);
  assert.equal(f.pages[0].authenticated, true, 'the retained page must reload after the imported session');
  assert.ok(retained.controllerEpoch > before.controllerEpoch);
});

test('native session counterpart preserves the original login account and shares revocation and signout cleanup', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-native-session-account-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const policy = createBrowserPolicy({ dataDir });
  const broker = createBrowserCredentialBroker({ dataDir, policy, wrappingKeyProvider: async () => Buffer.alloc(32, 1) });
  await broker.ready();
  const requested = await broker.requestAccount({ actor, origin, origins: [origin], label: 'Fixture website' });
  const { account: original } = await broker.approveAccount({ actor, requestId: requested.requestId, approval: { approved: true, requestId: requested.requestId, use: true } });
  const result = await broker.confirmAccountSession({ actor, accountId: original.id, additionalProfileId: 'native' });
  assert.equal(result.account.id, original.id);
  assert.equal(result.account.profileId, 'default');
  assert.equal(result.additionalAccount.profileId, 'native');
  assert.equal(result.additionalAccount.sourceAccountId, original.id);
  assert.equal(result.additionalAccount.hasPassword, false);
  const second = await broker.confirmAccountSession({ actor, accountId: original.id, additionalProfileId: 'native' });
  assert.equal(second.additionalAccount.id, result.additionalAccount.id);
  assert.equal((await broker.listAccounts()).accounts.length, 2);
  const agent = { threadId: 'other-chat', agentId: 'other-owner' };
  await broker.assertBrowserAccess({ actor: agent, url: origin, tab: { profileId: 'native' } });
  const state = { cookies: [cookie('siteSession', 'site.example', 'approved')], origins: [] };
  await broker.saveCheckpoint({ profileId: 'native', state });
  assert.ok(await broker.restoreCheckpoint({ profileId: 'native' }));
  await broker.revokeAccount({ actor, accountId: original.id });
  await assert.rejects(broker.assertBrowserAccess({ actor: agent, url: origin, tab: { profileId: 'native' } }), { code: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED' });
  assert.equal(await broker.restoreCheckpoint({ profileId: 'native' }), null);
  const cleared = [];
  broker.setSessionClearer(async ({ profileId, origins }) => { cleared.push(profileId); return { clearedOrigins: origins }; });
  await broker.signOut({ actor, accountId: original.id });
  assert.deepEqual(cleared.sort(), ['default', 'native']);
  assert.ok((await broker.listAccounts()).accounts.every((entry) => entry.sessionStatus === 'signed-out'));
  await broker.forgetAccount({ actor, accountId: original.id });
  assert.equal((await broker.listAccounts()).accounts.length, 0);
});

test('a failed Mac passkey browser launch restores the previous native mode and retained guest', async (t) => {
  const f = await harness(t, { failSignIn: true });
  const before = f.opened.tab;
  await assert.rejects(f.browser.request(actor, 'sign-in', { accountId: account.id, url: `${origin}/login`, authenticationMethod: 'mac-passkey' }), { code: 'BROWSER_SIGN_IN_START_FAILED' });
  const inventory = await f.browser.inventory(actor);
  assert.equal(inventory.runtime.mode, 'native');
  assert.equal(inventory.runtime.state, 'ready');
  const retained = inventory.tabs.find((tab) => tab.tabId === before.tabId);
  assert.equal(retained.status, 'ready');
  assert.equal(retained.nativeTargetId, before.nativeTargetId);
  assert.equal(f.confirmations.length, 0);
  assert.equal(f.storage().cookies.find((entry) => entry.name === 'oldSession')?.value, 'before');
});


test('passkey return after protected native autofill preserves unrelated origin storage without raw reads', async (t) => {
  const f = await harness(t, { protectedAutofill: true });
  await f.nativeAdapter.passwordFill();
  await f.browser.request(actor, 'sign-in', { accountId: account.id, url: `${origin}/login`, authenticationMethod: 'mac-passkey' });
  const confirmed = await f.browser.request(actor, 'confirm-sign-in', { accountId: account.id });
  assert.equal(confirmed.runtime.mode, 'native');
  assert.equal(f.pages[0].authenticated, true);
  assert.equal(f.imports.filter((entry) => entry.kind === 'main').length, 1);
  const unrelated = f.storage().origins.find((entry) => entry.origin === 'https://unrelated.example');
  assert.equal(unrelated.localStorage[0].value, 'retained-private');
  assert.equal(unrelated.indexedDB[0].name, 'retained-database');
  assert.equal(f.storage().cookies.some((entry) => entry.name === 'unrelatedSession'), false);
});


test('native signout after protected autofill clears only the linked approved website', async (t) => {
  const f = await harness(t, { protectedAutofill: true });
  await f.nativeAdapter.passwordFill();
  await f.browser.request(actor, 'sign-in', { accountId: account.id, url: `${origin}/login`, authenticationMethod: 'mac-passkey' });
  await f.browser.request(actor, 'confirm-sign-in', { accountId: account.id });
  assert.deepEqual(await f.clearSession({ profileId: 'native', origins: [origin] }), { clearedOrigins: [origin] });
  assert.equal(f.storage().cookies.length, 0);
  assert.deepEqual(f.storage().origins.map((entry) => entry.origin), ['https://unrelated.example']);
  assert.equal(f.storage().origins[0].localStorage[0].value, 'retained-private');
});


test('protected native partial checkpoints preserve encrypted origin storage through broker restart and honor explicit clearing', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-partial-native-checkpoint-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const policy = createBrowserPolicy({ dataDir });
  const options = { dataDir, policy, wrappingKeyProvider: async () => Buffer.alloc(32, 7) };
  const broker = createBrowserCredentialBroker(options);
  await broker.ready();
  const requested = await broker.requestAccount({ actor, origin, origins: [origin], label: 'Fixture checkpoint website' });
  const { account: original } = await broker.approveAccount({ actor, requestId: requested.requestId, approval: { approved: true, requestId: requested.requestId, use: true } });
  await broker.confirmAccountSession({ actor, accountId: original.id, additionalProfileId: 'native' });
  const savedOrigins = [{ origin, localStorage: [{ name: 'approved-token', value: 'encrypted-token' }], indexedDB: [{ name: 'approved-cache', version: 1, stores: [] }] }];
  await broker.saveCheckpoint({ profileId: 'native', state: { cookies: [cookie('session', 'site.example', 'before')], origins: savedOrigins } });
  await broker.saveCheckpoint({ profileId: 'native', state: { cookies: [cookie('session', 'site.example', 'after')], origins: [], originsComplete: false } });
  const restarted = createBrowserCredentialBroker(options);
  await restarted.ready();
  const restored = await restarted.restoreCheckpoint({ profileId: 'native' });
  assert.deepEqual(restored.origins, savedOrigins);
  assert.equal(restored.cookies[0].value, 'after');
  assert.equal('originsComplete' in restored, false);
  await assert.rejects(restarted.saveCheckpoint({ profileId: 'default', state: { cookies: [], origins: [], originsComplete: false } }), { code: 'BROWSER_AUTH_CHECKPOINT_INVALID' });
  await restarted.saveCheckpoint({ profileId: 'native', state: { cookies: [], origins: [] } });
  assert.deepEqual((await restarted.restoreCheckpoint({ profileId: 'native' })).origins, []);
  await restarted.saveCheckpoint({ profileId: 'native', state: { cookies: [], origins: savedOrigins } });
  await restarted.revokeAccount({ actor, accountId: original.id });
  await restarted.saveCheckpoint({ profileId: 'native', state: { cookies: [], origins: [], originsComplete: false } });
  assert.equal(await restarted.restoreCheckpoint({ profileId: 'native' }), null);
});

async function seededNativeCheckpoint(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-native-checkpoint-race-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const policy = createBrowserPolicy({ dataDir });
  const broker = createBrowserCredentialBroker({ dataDir, policy, wrappingKeyProvider: async () => Buffer.alloc(32, 6) });
  await broker.ready();
  const requested = await broker.requestAccount({ actor, origin, origins: [origin], label: 'Checkpoint cleanup fixture' });
  const { account } = await broker.approveAccount({ actor, requestId: requested.requestId, approval: { approved: true, requestId: requested.requestId, use: true } });
  await broker.confirmAccountSession({ actor, accountId: account.id, additionalProfileId: 'native' });
  await broker.saveCheckpoint({ profileId: 'native', state: { cookies: [], origins: [{ origin, localStorage: [{ name: 'old-authentication', value: 'must-not-return' }] }] } });
  broker.setSessionClearer(async ({ origins }) => ({ clearedOrigins: origins }));
  return { broker, policy, account };
}

test('partial native checkpoint saves cannot retain authentication across account cleanup', async (t) => {
  for (const action of ['signOut', 'revokeAccount', 'forgetAccount']) await t.test(action, async (t) => {
    const { broker, policy, account } = await seededNativeCheckpoint(t);
    const list = policy.list;
    let reads = 0; let armed = true;
    policy.list = async () => {
      // First read validates the old encrypted archive; the second is the final save proof.
      if (armed && ++reads === 2) { armed = false; await broker[action]({ actor, accountId: account.id }); }
      return list();
    };
    await assert.rejects(broker.saveCheckpoint({ profileId: 'native', state: { cookies: [], origins: [], originsComplete: false } }), { code: 'BROWSER_AUTH_CHECKPOINT_INVALIDATED' });
    assert.equal(await broker.restoreCheckpoint({ profileId: 'native' }), null);
  });
});

test('pending native session cleanup blocks both checkpoint saves and archive restoration before account versions change', async (t) => {
  const { broker, account } = await seededNativeCheckpoint(t);
  let release; let started;
  const blocked = new Promise((resolve) => { release = resolve; });
  const clearing = new Promise((resolve) => { started = resolve; });
  broker.setSessionClearer(async ({ origins }) => { started(); await blocked; return { clearedOrigins: origins }; });
  const signOut = broker.signOut({ actor, accountId: account.id });
  await clearing;
  try {
    await assert.rejects(broker.saveCheckpoint({ profileId: 'native', state: { cookies: [], origins: [], originsComplete: false } }), { code: 'BROWSER_AUTH_CHECKPOINT_INVALIDATED' });
    assert.equal(await broker.restoreCheckpoint({ profileId: 'native' }), null);
  } finally { release(); await signOut; }
  assert.equal(await broker.restoreCheckpoint({ profileId: 'native' }), null);
});
