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

async function harness(t, { failSignIn = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-native-passkey-handoff-'));
  const checkpoints = new Map();
  const launches = [];
  const imports = [];
  const confirmations = [];
  const bindings = [];
  const pages = [];
  let nativeStorage = { cookies: [cookie('oldSession', 'site.example', 'before')], origins: [] };
  const signedInStorage = { cookies: [cookie('siteSession', 'site.example', 'after'), cookie('unrelatedSession', 'unrelated.example', 'private-unrelated')],
    origins: [{ origin, localStorage: [{ name: 'sessionFlag', value: 'approved' }] }, { origin: 'https://unrelated.example', localStorage: [{ name: 'unrelatedFlag', value: 'private' }] }] };
  const nativeAdapter = {
    async bind(value) { bindings.push(value); }, async control() {},
    async inventory() { return pages.map((page) => ({ nativeTargetId: page.target, tabId: bindings.find((entry) => entry.targetId === page.target)?.tabId })); },
  };
  const newNativePage = () => {
    let url = 'about:blank'; let closed = false;
    const frame = { url: () => url };
    const page = Object.assign(new EventEmitter(), { target: `native-target-${pages.length}`, navigations: [],
      authenticated: false, url: () => url, isClosed: () => closed, mainFrame: () => frame, frames: () => [frame],
      async goto(destination) { url = destination; page.navigations.push(destination); page.authenticated = nativeStorage.cookies.some((entry) => entry.name === 'siteSession'); },
      async reload() { await page.goto(url); }, async title() { return 'Fixture site'; }, async evaluate() { return 'complete'; },
      async routeWebSocket() {}, async close() { closed = true; page.emit('close'); } });
    pages.push(page); return page;
  };
  const contextFor = (kind) => Object.assign(new EventEmitter(), {
    async storageState() { return structuredClone(kind === 'native' ? nativeStorage : signedInStorage); },
    async setStorageState(state) { imports.push({ kind, state: structuredClone(state) }); if (kind === 'native') nativeStorage = structuredClone(state); },
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
      async listAccounts() { return { accounts: [account] }; }, setSessionClearer() {},
      async registerSessionOrigins() {}, async assertBrowserAccess() {},
      async saveCheckpoint({ profileId, state }) { checkpoints.set(profileId, structuredClone(state)); },
      async restoreCheckpoint({ profileId }) { return checkpoints.get(profileId) ?? null; },
      async deleteCheckpoint({ profileId }) { checkpoints.delete(profileId); },
      async confirmAccountSession(settings) { confirmations.push(settings); return { account: { ...account, sessionStatus: 'authenticated' } }; },
    },
  });
  t.after(async () => { await browser.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const opened = await browser.request(actor, 'open', { url: `${origin}/research` });
  return { browser, opened, launches, imports, confirmations, pages, bindings, storage: () => nativeStorage };
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
