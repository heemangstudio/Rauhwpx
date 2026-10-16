import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { WebSocketServer } from 'ws';
import { createMemorySecretStore } from '../secret-store.mjs';
import { key as fixtureKey, cert as fixtureCert } from './fixtures/owned-browser-tls.mjs';
import { createOwnedBrowserService } from '../owned-browser-service.mjs';
import { createBrowserPolicy } from '../browser-policy.mjs';
import { createBrowserCredentialBroker } from '../browser-credentials.mjs';
import { createBrowserDownloads } from '../browser-downloads.mjs';
import { inspectOwnedBrowserRuntime, startOwnedBrowserRuntime, startOwnedBrowserSignIn } from '../owned-browser-runtime.mjs';

const agent = { threadId: 'research-chat', projectId: 'project', agentId: 'researcher' };
const human = { ...agent, clientId: 'window', isHuman: true };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check, timeout = 3000) { const deadline = Date.now() + timeout; do { const value = await check(); if (value) return value; await delay(20); } while (Date.now() < deadline); throw new Error('Expected browser state did not appear'); }
async function fixture(t, handler, secure = false) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-browser-security-'));
  const server = secure ? https.createServer({ key: fixtureKey, cert: fixtureCert }, handler) : http.createServer(handler);
  const connections = new Set();
  const cleanups = [];
  server.on('connection', (socket) => { connections.add(socket); socket.once('close', () => connections.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); for (const socket of connections) socket.destroy(); await new Promise((resolve) => server.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, server, cleanup: (operation) => cleanups.push(operation), origin: `${secure ? 'https' : 'http'}://127.0.0.1:${server.address().port}` };
}
async function needsBrowser(t) { if (!(await inspectOwnedBrowserRuntime()).installed) { t.skip('Install the pinned managed Chromium browser to run runtime security checks.'); return false; } return true; }
const refArgs = (observation, element) => ({ tabId: observation.tab.tabId, snapshotId: observation.snapshot.snapshotId, ref: element.ref, navigationEpoch: observation.tab.navigationEpoch, controllerEpoch: observation.tab.controllerEpoch });
async function testRuntime(options) {
  const runtime = await startOwnedBrowserRuntime(options);
  const newPage = runtime.context.newPage.bind(runtime.context);
  runtime.context.newPage = async () => {
    const page = await newPage();
    const session = await runtime.context.newCDPSession(page);
    await session.send('Security.setIgnoreCertificateErrors', { ignore: true });
    page.once('close', () => { void session.detach().catch(() => {}); });
    return page;
  };
  return runtime;
}
async function approveSession(broker, origin) {
  const account = { origin, origins: [origin], label: 'Fixture account' };
  const request = await broker.requestAccount({ actor: human, ...account, intent: 'use' });
  return (await broker.approveAccount({ actor: human, requestId: request.requestId, approval: { approved: true, requestId: request.requestId, use: true }, account })).account;
}

test('revocation during credential readiness prevents each subsequent secret field write', async (t) => {
  if (!await needsBrowser(t)) return;
  for (const hidden of ['username', 'password']) await t.test(hidden, async (subtest) => {
    let waiting = false;
    const f = await fixture(subtest, (request, response) => {
      if (request.url === '/waiting') { waiting = true; response.end('recorded'); return; }
      response.setHeader('Content-Type', 'text/html');
      response.end(`<input id="identity"><input type="password" id="secret"><script>const identity=document.getElementById('identity');const password=document.getElementById('secret');${hidden === 'username' ? "new MutationObserver(()=>{identity.style.display='none';fetch('/waiting')}).observe(identity,{attributes:true,attributeFilter:['data-rhwp-private-field']});" : "identity.addEventListener('input',()=>{password.style.display='none';fetch('/waiting')});"}</script>`);
    }, true);
    const policy = createBrowserPolicy({ dataDir: f.dataDir });
    const secretStore = createMemorySecretStore();
    const credentialBroker = createBrowserCredentialBroker({ dataDir: f.dataDir, policy, secretStore, wrappingKeyProvider: async () => Buffer.alloc(32, 7) });
    const accountData = { origin: f.origin, origins: [f.origin], label: 'Fixture saved account' };
    const request = await credentialBroker.requestAccount({ actor: agent, ...accountData });
    const account = (await credentialBroker.submit({ actor: human, requestId: request.requestId, approval: { approved: true, requestId: request.requestId, save: true, use: true }, account: accountData, username: 'PRIVATE_USERNAME', password: 'PRIVATE_PASSWORD', remember: true })).account;
    let context;
    const browser = createOwnedBrowserService({ dataDir: f.dataDir, policy, credentialBroker, workspaceTargets: [f.origin], autoInstall: false, runtimeFactory: async (options) => { const runtime = await testRuntime(options); context = runtime.context; return runtime; } });
    f.cleanup(() => browser.close());
    const opened = await browser.request(agent, 'open', { url: f.origin });
    const observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
    const password = observation.snapshot.elements.find((element) => element.sensitive);
    const username = observation.snapshot.elements.find((element) => !element.sensitive);
    const filling = browser.request(agent, 'fill-account', { ...refArgs(observation, password), accountId: account.id, usernameRef: username.ref, passwordRef: password.ref });
    const rejected = assert.rejects(filling, (failure) => failure.code?.startsWith('BROWSER_'));
    await eventually(() => waiting);
    await credentialBroker.revokeAccount({ actor: human, accountId: account.id });
    const page = context.pages().find((entry) => entry.url().startsWith(f.origin));
    await page.evaluate(() => { document.getElementById('identity').style.display = ''; document.getElementById('secret').style.display = ''; });
    await rejected;
    assert.equal(await page.locator('#secret').inputValue(), '');
    if (hidden === 'username') assert.equal(await page.locator('#identity').inputValue(), '');
  });
});

test('approved agent cookie rotation keeps exact nested-path provenance through restart', async (t) => {
  if (!await needsBrowser(t)) return;
  let rotation = 0;
  const f = await fixture(t, (request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/nested/login' || request.url === '/nested/research') response.setHeader('Set-Cookie', `identity=rotation-${rotation++}; HttpOnly; Max-Age=3600; Secure`);
    response.end('<h1>Approved private research</h1>');
  }, true);
  const wrappingKey = Buffer.alloc(32, 9);
  const build = () => { const policy = createBrowserPolicy({ dataDir: f.dataDir }); const credentialBroker = createBrowserCredentialBroker({ dataDir: f.dataDir, policy, wrappingKeyProvider: async () => wrappingKey }); return { credentialBroker, browser: createOwnedBrowserService({ dataDir: f.dataDir, policy, credentialBroker, workspaceTargets: [f.origin], autoInstall: false, runtimeFactory: testRuntime }) }; };
  const first = build(); f.cleanup(() => first.browser.close());
  await first.browser.request(human, 'open', { url: `${f.origin}/nested/login` });
  const account = await approveSession(first.credentialBroker, f.origin);
  const opened = await first.browser.request(agent, 'open', { url: `${f.origin}/nested/research` });
  assert.ok((await first.browser.request(agent, 'snapshot', { tabId: opened.tab.tabId })).snapshot.text.includes('Approved private research'));
  await first.browser.close();
  const second = build(); f.cleanup(() => second.browser.close());
  const reopened = await second.browser.request(agent, 'open', { url: `${f.origin}/nested/research` });
  assert.ok((await second.browser.request(agent, 'snapshot', { tabId: reopened.tab.tabId })).snapshot.text.includes('Approved private research'));
  assert.equal((await second.credentialBroker.listAccounts()).accounts.find((entry) => entry.id === account.id).agentReuseApproved, true);
});

test('private agent requests cannot replace an unapproved human session cookie', async (t) => {
  if (!await needsBrowser(t)) return;
  let loginResponse, context; let replacements = 0;
  const f = await fixture(t, (request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/human-login') { loginResponse = response; response.setHeader('Set-Cookie', 'identity=unapproved-private; Path=/; HttpOnly; Max-Age=3600'); response.write('<h1>Signing in'); return; }
    if (request.url === '/agent-refresh') { replacements++; response.setHeader('Set-Cookie', 'identity=agent-replacement; Path=/; HttpOnly; Max-Age=3600'); }
    response.end('<h1>Research</h1>');
  }, true);
  const policy = createBrowserPolicy({ dataDir: f.dataDir });
  const credentialBroker = createBrowserCredentialBroker({ dataDir: f.dataDir, policy, wrappingKeyProvider: async () => Buffer.alloc(32, 8) });
  const browser = createOwnedBrowserService({ dataDir: f.dataDir, policy, credentialBroker, workspaceTargets: [f.origin], autoInstall: false, runtimeFactory: async options => { const runtime = await testRuntime(options); context = runtime.context; return runtime; } });
  f.cleanup(() => browser.close());
  const original = await browser.request(agent, 'open', { url: f.origin });
  const humanLogin = browser.request(human, 'open', { url: `${f.origin}/human-login` });
  await eventually(() => loginResponse);
  await assert.rejects(browser.request(agent, 'open', { url: `${f.origin}/agent-refresh` }), { code: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED' });
  loginResponse.end('</h1>'); await humanLogin;
  await assert.rejects(browser.request(agent, 'open', { url: `${f.origin}/agent-refresh` }), { code: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED' });
  assert.equal(replacements, 0);
  assert.equal((await context.cookies(f.origin)).find(cookie => cookie.name === 'identity').value, 'unapproved-private');
  assert.equal((await browser.request(agent, 'snapshot', { tabId: original.tab.tabId })).ok, true);
  await approveSession(credentialBroker, f.origin);
  assert.equal((await browser.request(agent, 'open', { url: `${f.origin}/agent-refresh` })).ok, true);
  assert.equal(replacements, 1);
});

test('host-only and domain cookies with the same name retain separate approved provenance', async (t) => {
  if (!await needsBrowser(t)) return;
  const f = await fixture(t, (request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/login') response.setHeader('Set-Cookie', ['identity=host; Path=/; HttpOnly; Max-Age=3600', 'identity=domain; Domain=review.example.test; Path=/; HttpOnly; Max-Age=3600']);
    if (request.url === '/refresh') response.setHeader('Set-Cookie', 'identity=host-refresh; Path=/; HttpOnly; Max-Age=3600');
    response.end('<h1>Approved research</h1>');
  }, true);
  const origin = f.origin.replace('127.0.0.1', 'review.example.test');
  const policy = createBrowserPolicy({ dataDir: f.dataDir });
  const credentialBroker = createBrowserCredentialBroker({ dataDir: f.dataDir, policy, wrappingKeyProvider: async () => Buffer.alloc(32, 5) });
  const browser = createOwnedBrowserService({ dataDir: f.dataDir, policy, credentialBroker, workspaceTargets: [origin], lookup: async () => [{ address: '127.0.0.1', family: 4 }], autoInstall: false, runtimeFactory: testRuntime });
  f.cleanup(() => browser.close());
  await browser.request(human, 'open', { url: `${origin}/login` }); await approveSession(credentialBroker, origin);
  const opened = await browser.request(agent, 'open', { url: `${origin}/refresh` });
  assert.ok((await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId })).snapshot.text.includes('Approved research'));
});

test('human event streams release their header fence so public research can continue', async (t) => {
  if (!await needsBrowser(t)) return;
  let streaming = false;
  const f = await fixture(t, (request, response) => {
    if (request.url === '/events') { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('data: ready\n\n'); streaming = true; return; }
    response.setHeader('Content-Type', 'text/html'); response.end(request.url === '/human' ? '<script>new EventSource("/events")</script><h1>Human page</h1>' : '<h1>Public research</h1>');
  });
  const policy = createBrowserPolicy({ dataDir: f.dataDir });
  const credentialBroker = createBrowserCredentialBroker({ dataDir: f.dataDir, policy, wrappingKeyProvider: async () => Buffer.alloc(32, 4) });
  const browser = createOwnedBrowserService({ dataDir: f.dataDir, policy, credentialBroker, workspaceTargets: [f.origin], autoInstall: false });
  f.cleanup(() => browser.close());
  await browser.request(human, 'open', { url: `${f.origin}/human` }); await eventually(() => streaming);
  const opened = await eventually(async () => { try { return await browser.request(agent, 'open', { url: f.origin }); } catch (failure) { if (failure.code === 'BROWSER_HUMAN_SESSION_PENDING') return false; throw failure; } });
  assert.ok((await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId })).snapshot.text.includes('Public research'));
});

test('a delayed human storage change is not attributed to an agent response', async (t) => {
  if (!await needsBrowser(t)) return;
  let delayedResponse;
  const f = await fixture(t, (request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/human') { response.end('<h1>Human page</h1><script>window.storePrivateSession=()=>{localStorage.setItem("auth","DUMMY_HUMAN_IDENTITY");document.body.dataset.stored="yes"}</script>'); return; }
    if (request.url === '/agent-delayed') { delayedResponse = response; return; }
    response.end('<h1>Research</h1>');
  });
  const policy = createBrowserPolicy({ dataDir: f.dataDir });
  const credentialBroker = createBrowserCredentialBroker({ dataDir: f.dataDir, policy, wrappingKeyProvider: async () => Buffer.alloc(32, 3) });
  let context;
  const browser = createOwnedBrowserService({ dataDir: f.dataDir, policy, credentialBroker, workspaceTargets: [f.origin], autoInstall: false, runtimeFactory: async (options) => { const runtime = await startOwnedBrowserRuntime(options); context = runtime.context; return runtime; } });
  f.cleanup(() => browser.close());
  const humanTab = (await browser.request(human, 'open', {})).tab;
  await browser.request(human, 'navigate', { tabId: humanTab.tabId, navigationEpoch: humanTab.navigationEpoch, controllerEpoch: humanTab.controllerEpoch, url: `${f.origin}/human` });
  const opening = browser.request(agent, 'open', { url: `${f.origin}/agent-delayed` });
  const completed = assert.rejects(opening, { code: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED' });
  await eventually(() => delayedResponse);
  const humanPage = context.pages().find((page) => page.url().endsWith('/human'));
  await humanPage.evaluate(() => window.storePrivateSession());
  delayedResponse.end('<h1>Agent response</h1>'); await completed;
  await assert.rejects(browser.request(agent, 'open', { url: `${f.origin}/private` }), { code: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED' });
  await assert.rejects(credentialBroker.assertBrowserAccess({ actor: agent, url: f.origin }), { code: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED' });
  assert.equal((await credentialBroker.listAccounts()).accounts.length, 0);
});

test('human interaction keeps the owned page readable without approving external credential reuse', async (t) => {
  if (!await needsBrowser(t)) return;
  const f = await fixture(t, (_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<h1>Human page</h1><script>window.storePrivateSession=()=>{localStorage.setItem("auth","DUMMY_HUMAN_IDENTITY");document.body.innerHTML="Private identity"}</script>'); });
  const policy = createBrowserPolicy({ dataDir: f.dataDir });
  const credentialBroker = createBrowserCredentialBroker({ dataDir: f.dataDir, policy, wrappingKeyProvider: async () => Buffer.alloc(32, 2) });
  let context, releaseFrame, frameStarted;
  const ready = new Promise((resolve) => { frameStarted = resolve; });
  const held = new Promise((resolve) => { releaseFrame = resolve; });
  const browser = createOwnedBrowserService({ dataDir: f.dataDir, policy, credentialBroker, workspaceTargets: [f.origin], autoInstall: false, runtimeFactory: async (options) => { const runtime = await startOwnedBrowserRuntime(options); context = runtime.context; return runtime; } });
  f.cleanup(() => browser.close());
  const opened = await browser.request(agent, 'open', { url: f.origin });
  await browser.request(human, 'input', { tabId: opened.tab.tabId, navigationEpoch: opened.tab.navigationEpoch, controllerEpoch: opened.tab.controllerEpoch, type: 'release' });
  const page = context.pages().find((entry) => entry.url().startsWith(f.origin));
  const screenshot = page.screenshot.bind(page);
  page.screenshot = async (options) => { const bytes = await screenshot(options); frameStarted(); await held; return bytes; };
  const pendingFrame = browser.request(agent, 'frame', { tabId: opened.tab.tabId });
  const completed = pendingFrame;
  await ready; await page.evaluate(() => window.storePrivateSession()); releaseFrame(); assert.equal((await completed).ok, true);
  assert.ok((await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId })).snapshot.text.includes('Private identity'));
  await assert.rejects(credentialBroker.assertBrowserAccess({ actor: agent, url: f.origin }), { code: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED' });
});

test('explicit account confirmation permits normal agent storage refresh and encrypted reuse', async (t) => {
  if (!await needsBrowser(t)) return;
  let refresh = 0;
  const f = await fixture(t, (request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(`<h1>Approved research</h1><script>localStorage.setItem('auth','APPROVED_REFRESH_${request.url === '/login' ? 'human' : refresh++}')</script>`); }, true);
  const wrappingKey = Buffer.alloc(32, 1);
  const build = async () => { const policy = createBrowserPolicy({ dataDir: f.dataDir }); const credentialBroker = createBrowserCredentialBroker({ dataDir: f.dataDir, policy, wrappingKeyProvider: async () => wrappingKey }); const browser = createOwnedBrowserService({ dataDir: f.dataDir, policy, credentialBroker, workspaceTargets: [f.origin], autoInstall: false, runtimeFactory: testRuntime }); await browser.restore(); return { credentialBroker, browser }; };
  const first = await build(); f.cleanup(() => first.browser.close());
  await first.browser.request(human, 'open', { url: `${f.origin}/login` });
  const account = await approveSession(first.credentialBroker, f.origin);
  await first.browser.request(human, 'confirm-sign-in', { accountId: account.id });
  const opened = await first.browser.request(agent, 'open', { url: `${f.origin}/refresh` });
  assert.ok((await first.browser.request(agent, 'snapshot', { tabId: opened.tab.tabId })).snapshot.text.includes('Approved research'));
  await first.browser.close();
  const second = await build(); f.cleanup(() => second.browser.close());
  const reopened = await second.browser.request({ ...agent, threadId: 'another-chat', projectId: 'another-project' }, 'open', { url: `${f.origin}/refresh` });
  assert.ok((await second.browser.request({ ...agent, threadId: 'another-chat', projectId: 'another-project' }, 'snapshot', { tabId: reopened.tab.tabId })).snapshot.text.includes('Approved research'));
  assert.equal((await second.credentialBroker.listAccounts()).accounts[0].agentReuseApproved, true);
});

test('browser reset drains its owner and removes only browser profile and account data', async (t) => {
  if (!await needsBrowser(t)) return;
  const f = await fixture(t, (_request, response) => { response.setHeader('Set-Cookie', 'reader=retained; Path=/; Max-Age=3600'); response.end('Research'); });
  const policy = createBrowserPolicy({ dataDir: f.dataDir });
  const secretStore = createMemorySecretStore(); await secretStore.set('provider.secret', 'RETAINED_PROVIDER');
  const credentialBroker = createBrowserCredentialBroker({ dataDir: f.dataDir, policy, secretStore, wrappingKeyProvider: async () => Buffer.alloc(32, 6) });
  const accountData = { origin: 'https://account.example.test', origins: ['https://account.example.test'], label: 'Saved account' };
  const request = await credentialBroker.requestAccount({ actor: agent, ...accountData });
  const account = (await credentialBroker.submit({ actor: human, requestId: request.requestId, approval: { approved: true, requestId: request.requestId, save: true, use: true }, account: accountData, username: 'PRIVATE_USERNAME', password: 'PRIVATE_PASSWORD', remember: true })).account;
  await fs.mkdir(path.join(f.dataDir, 'downloads'), { recursive: true }); await fs.writeFile(path.join(f.dataDir, 'downloads', 'original.pdf'), '%PDF-original');
  const browser = createOwnedBrowserService({ dataDir: f.dataDir, policy, credentialBroker, workspaceTargets: [f.origin], autoInstall: false });
  f.cleanup(() => browser.close());
  const opened = await browser.request(agent, 'open', { url: f.origin });
  await fs.mkdir(path.join(f.dataDir, 'browser', 'binaries'), { recursive: true });
  await fs.writeFile(path.join(f.dataDir, 'browser', 'binaries', 'owned-engine'), 'retained');
  await fs.writeFile(path.join(f.dataDir, 'browser', 'runtime.json'), JSON.stringify({ version: 1, mode: 'managed', headless: true }));
  await assert.rejects(browser.request(agent, 'reset-browser'), { code: 'BROWSER_HUMAN_REQUIRED' });
  const reset = await browser.request(human, 'reset-browser');
  assert.equal(reset.runtime.state, 'idle'); assert.deepEqual(reset.tabs, []);
  await assert.rejects(fs.access(path.join(f.dataDir, 'browser', 'profile')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.dataDir, 'browser', 'binaries', 'owned-engine'), 'utf8'), 'retained');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dataDir, 'browser', 'runtime.json'), 'utf8')).mode, 'managed');
  assert.equal((await credentialBroker.listAccounts()).accounts.length, 0);
  assert.equal(await secretStore.get(`browser.password.${account.id}`), null);
  assert.equal(await secretStore.get('provider.secret'), 'RETAINED_PROVIDER');
  assert.equal(await fs.readFile(path.join(f.dataDir, 'downloads', 'original.pdf'), 'utf8'), '%PDF-original');
  await assert.rejects(browser.request(agent, 'snapshot', { tabId: opened.tab.tabId }), { code: 'BROWSER_TAB_NOT_FOUND' });
  const fresh = await browser.request(agent, 'open', {}); assert.equal(fresh.tab.url, 'about:blank');
});

test('explicit website grants allow forms while secret and device boundaries remain', async (t) => {
  if (!await needsBrowser(t)) return;
  let mutations = 0;
  let searches = 0;
  const fixtureState = await fixture(t, (request, response) => {
    if (request.url.startsWith('/apply?')) mutations++;
    if (request.url.startsWith('/search?')) searches++;
    if (request.method === 'POST') { mutations++; response.end('changed'); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end('<form method="post" action="/commit"><input name="title" value="Draft"><button>Delete saved document</button></form><button onclick="fetch(\'/apply\',{method:\'POST\'})">Confirm</button><form method="get" action="/apply"><input type="hidden" name="delete" value="1"><input name="message" aria-label="Pending change" oninput="fetch(\'/apply?delete=1\')"><button>Apply confirmation</button></form><a href="/apply?delete=1">Commit link</a><form method="get" action="/search"><input name="q" aria-label="Public query" oninput="fetch(\'/apply?action=delete\').catch(()=>document.body.insertAdjacentHTML(\'beforeend\',\'<p>GET blocked</p>\'))"><button>Search</button></form><input id="identity" aria-label="Saved identity"><input type="password"><input id="query" aria-label="Search">');
  });
  const policy = createBrowserPolicy({ dataDir: fixtureState.dataDir });
  await policy.update({ actor: human, operation: 'set-site', origin: fixtureState.origin, allowedActions: ['browse', 'read', 'download', 'website-change'] });
  const broker = { assertBrowserAccess: async () => {}, issueHandle: async () => ({ handle: 'private' }), fill: async ({ fill }) => fill({ username: 'BROKER_PRIVATE_USERNAME', password: 'BROKER_PRIVATE_PASSWORD' }) };
  const browser = createOwnedBrowserService({ dataDir: fixtureState.dataDir, workspaceTargets: [fixtureState.origin], policy, credentialBroker: broker, autoInstall: false });
  fixtureState.cleanup(() => browser.close());
  const opened = await browser.request(agent, 'open', { url: fixtureState.origin });
  const reset = async () => {
    const tab = (await browser.inventory(agent)).tabs.find((row) => row.tabId === opened.tab.tabId);
    await browser.request(agent, 'navigate', { tabId: tab.tabId, navigationEpoch: tab.navigationEpoch, controllerEpoch: tab.controllerEpoch, url: fixtureState.origin });
    return browser.request(agent, 'snapshot', { tabId: tab.tabId });
  };
  for (const [action, name, args] of [['click', 'Delete saved document', {}], ['press', 'Draft', { key: 'Enter' }], ['click', 'Confirm', {}], ['type', 'Pending change', { text: 'changed' }], ['click', 'Commit link', {}]]) {
    const observation = await reset();
    const element = observation.snapshot.elements.find((entry) => entry.name === name || entry.value === name);
    await browser.request(agent, action, { ...refArgs(observation, element), ...args });
  }
  await eventually(() => mutations >= 5);
  let observation = await reset();
  await browser.request(agent, 'type', { ...refArgs(observation, observation.snapshot.elements.find((element) => element.name === 'Public query')), text: 'research' });
  await eventually(() => mutations >= 6);
  observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  await browser.request(agent, 'click', { ...refArgs(observation, observation.snapshot.elements.find((element) => element.tag === 'button' && element.name === 'Search')) });
  assert.equal(searches, 1);
  observation = await reset();
  const username = observation.snapshot.elements.find((element) => element.name === 'Saved identity');
  const password = observation.snapshot.elements.find((element) => element.sensitive);
  await browser.request(agent, 'fill-account', { ...refArgs(observation, password), accountId: 'fixture-account', usernameRef: username.ref, passwordRef: password.ref });
  observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  assert.equal(JSON.stringify(observation).includes('BROKER_PRIVATE_'), false);
  const privateField = observation.snapshot.elements.find((element) => element.tag === 'input' && element.sensitive && element.name === 'Saved identity');
  await browser.request(agent, 'press', { ...refArgs(observation, privateField), key: 'Meta+a' });
  observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  assert.equal(observation.snapshot.selectedText, '');
  for (const key of ['Meta+c', 'MetaLeft+c', 'MetaRight+x', 'ControlLeft+v', 'Shift+Insert', 'Copy', 'Meta+l', 'Control+o', 'F12']) await assert.rejects(browser.request(agent, 'press', { tabId: opened.tab.tabId, navigationEpoch: observation.tab.navigationEpoch, controllerEpoch: observation.tab.controllerEpoch, key }), { code: 'BROWSER_SHORTCUT_BLOCKED' });
  assert.equal(JSON.stringify(await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId })).includes('BROKER_PRIVATE_'), false);
});

test('owned browser website websocket messages work without a separate website-change grant', async (t) => {
  if (!await needsBrowser(t)) return;
  let mutations = 0, context;
  const f = await fixture(t, (_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<form method="get" action="/"><input name="q" oninput="if(window.socket?.readyState===1)window.socket.send(\'delete\')"></form><script>window.socket=new WebSocket(location.origin.replace("http:","ws:")+"/channel");socket.onopen=()=>document.body.insertAdjacentHTML("beforeend","<h1>Ready</h1>");</script>');
  });
  const sockets = new WebSocketServer({ server: f.server, path: '/channel' });
  sockets.on('connection', (socket) => socket.on('message', () => { mutations++; }));
  f.cleanup(() => { for (const socket of sockets.clients) socket.terminate(); sockets.close(); });
  const policy = createBrowserPolicy({ dataDir: f.dataDir });
  const browser = createOwnedBrowserService({ dataDir: f.dataDir, workspaceTargets: [f.origin], policy, autoInstall: false, runtimeFactory: async options => { const runtime = await startOwnedBrowserRuntime(options); context = runtime.context; return runtime; } });
  f.cleanup(() => browser.close());
  const opened = await browser.request(agent, 'open', { url: f.origin });
  await eventually(() => sockets.clients.size > 0);
  const observation = await eventually(async () => { const result = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId }); return result.snapshot.text.includes('Ready') && result; });
  await assert.rejects(browser.request(agent, 'type', { ...refArgs(observation, observation.snapshot.elements[0]), text: 'private document data' }), { code: 'BROWSER_PERMISSION_REQUIRED' });
  await context.pages().find(page => page.url().startsWith(f.origin)).evaluate(() => socket.send('read-query'));
  await eventually(() => mutations === 1);
  assert.equal(sockets.clients.size, 1);
});

test('owned-browser retained sessions remain usable across encrypted restarts after human login', async (t) => {
  if (!await needsBrowser(t)) return;
  const f = await fixture(t, (request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/public') response.setHeader('Set-Cookie', 'reader=ordinary; Path=/; Max-Age=3600; HttpOnly');
    if (request.url === '/human-login') response.setHeader('Set-Cookie', 'identity=human-private; Path=/; Max-Age=3600; HttpOnly');
    response.end('<h1>Public research</h1>');
  });
  const key = crypto.randomBytes(32);
  const build = () => { const policy = createBrowserPolicy({ dataDir: f.dataDir }); const credentialBroker = createBrowserCredentialBroker({ dataDir: f.dataDir, policy, wrappingKeyProvider: async () => key }); return createOwnedBrowserService({ dataDir: f.dataDir, workspaceTargets: [f.origin], policy, credentialBroker, autoInstall: false }); };
  const first = build();
  f.cleanup(() => first.close());
  await first.request(agent, 'open', { url: `${f.origin}/public` }); await first.close();
  const second = build();
  f.cleanup(() => second.close());
  const reopened = await second.request(agent, 'open', { url: `${f.origin}/research` });
  assert.ok((await second.request(agent, 'snapshot', { tabId: reopened.tab.tabId })).snapshot.text.includes('Public research'));
  const humanTab = (await second.request(human, 'open', { url: `${f.origin}/human-login` })).tab;
  assert.equal((await second.request(agent, 'snapshot', { tabId: reopened.tab.tabId })).ok, true);
  await second.request(human, 'close', { tabId: humanTab.tabId, navigationEpoch: humanTab.navigationEpoch, controllerEpoch: humanTab.controllerEpoch });
  await second.close();
  const third = build(); f.cleanup(() => third.close());
  await assert.rejects(third.request(agent, 'open', { url: `${f.origin}/research` }), { code: 'BROWSER_ACCOUNT_APPROVAL_REQUIRED' });
});

test('owned-browser PDF exports require a website grant and stop when their logical tab closes', async (t) => {
  if (!await needsBrowser(t)) return;
  let posted = false;
  const f = await fixture(t, (request, response) => {
    if (request.url === '/pdf/export') {
      let body = ''; request.on('data', (bytes) => { body += bytes; }); request.on('end', () => {
        posted = request.method === 'POST' && body.includes('csrf=fixture');
        response.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="reference.pdf"' }); response.end('%PDF-1.7\nfixture reference\n%%EOF');
      }); return;
    }
    if (request.url === '/pdf/slow') {
      response.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="slow.pdf"' }); response.write('%PDF-1.7\n');
      const timer = setInterval(() => response.write(Buffer.alloc(1024)), 30); response.once('close', () => clearInterval(timer)); return;
    }
    response.setHeader('Content-Type', 'text/html'); response.end('<form method="post" action="/pdf/export"><input type="hidden" name="csrf" value="fixture"><button>Export PDF</button></form><a href="/pdf/slow">Slow PDF</a>');
  });
  const policy = createBrowserPolicy({ dataDir: f.dataDir });
  const downloads = createBrowserDownloads({ dataDir: f.dataDir, timeoutMs: 10_000, authorizeDownload: ({ actor, target }) => browser.ownsTarget(actor, target) });
  const browser = createOwnedBrowserService({ dataDir: f.dataDir, workspaceTargets: [f.origin], policy, downloads, autoInstall: false });
  f.cleanup(async () => { await browser.close(); await downloads.close(); });
  const opened = await browser.request(agent, 'open', { url: f.origin });
  await policy.update({ actor: human, operation: 'set-site', origin: f.origin, allowedActions: ['browse', 'read', 'download'] });
  let observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  await assert.rejects(browser.request(agent, 'click', { ...refArgs(observation, observation.snapshot.elements.find(element => element.tag === 'button')), intent: 'research' }), { code: 'BROWSER_PERMISSION_REQUIRED' });
  assert.equal(posted, false);
  await policy.update({ actor: human, operation: 'set-site', origin: f.origin, allowedActions: ['browse', 'read', 'download', 'website-change'] });
  await browser.request(agent, 'click', { ...refArgs(observation, observation.snapshot.elements.find((element) => element.tag === 'button')), intent: 'research' });
  const exported = await eventually(async () => (await downloads.list(agent)).find((job) => job.state === 'downloaded'));
  assert.equal(posted, true);
  assert.equal(exported.source.url, `${f.origin}/pdf/export`);
  observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  await browser.request(agent, 'click', { ...refArgs(observation, observation.snapshot.elements.find((element) => element.tag === 'a')) });
  const slow = await eventually(async () => (await downloads.list(agent)).find((job) => job.state === 'downloading'));
  const tab = (await browser.inventory(agent)).tabs.find((tab) => tab.tabId === opened.tab.tabId);
  assert.equal(browser.downloadTarget(agent, `${f.origin}/public-file.pdf`).tabId, tab.tabId);
  assert.equal(browser.downloadTarget({ ...agent, projectId: 'other-project' }, `${f.origin}/public-file.pdf`), null);
  assert.equal(browser.downloadTarget(agent, 'https://unrelated.example/file.pdf'), null);
  await browser.request(agent, 'close', { tabId: tab.tabId, navigationEpoch: tab.navigationEpoch, controllerEpoch: tab.controllerEpoch });
  await eventually(async () => (await downloads.list(agent)).find((job) => job.downloadId === slow.downloadId && job.state === 'interrupted'));
  assert.ok((await downloads.list(agent)).find((job) => job.downloadId === exported.downloadId && job.state === 'downloaded'));
});

test('manual sign-in waits for runtime startup and blocks the previous agent owner', async (t) => {
  if (!await needsBrowser(t)) return;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-browser-handoff-'));
  let unblock;
  const barrier = new Promise((resolve) => { unblock = resolve; });
  let manual = false;
  let automaticClosed = false;
  const broker = { listAccounts: async () => ({ accounts: [{ id: 'account', profileId: 'default', origins: ['https://accounts.google.com'] }] }), assertBrowserAccess: async () => {} };
  const browser = createOwnedBrowserService({ dataDir, credentialBroker: broker, autoInstall: false,
    runtimeFactory: async (options) => { await barrier; const runtime = await startOwnedBrowserRuntime(options); const close = runtime.close; runtime.close = async () => { await close(); automaticClosed = true; }; return runtime; },
    signInFactory: async () => { assert.equal(automaticClosed, true); manual = true; return { mode: 'standalone-no-debug', exited: false, close: async () => {} }; },
  });
  t.after(async () => { await browser.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const opening = browser.request(agent, 'open', {});
  await delay(20);
  const signingIn = browser.request(human, 'sign-in', { accountId: 'account' });
  const rejected = assert.rejects(opening, { code: 'BROWSER_SIGN_IN_ACTIVE' });
  unblock(); await signingIn; await rejected;
  assert.equal(manual, true);
  await assert.rejects(browser.request(agent, 'open', {}), { code: 'BROWSER_SIGN_IN_ACTIVE' });
});

test('standalone sign-in has no automation/debug connection and retains the owned profile', async (t) => {
  if (!await needsBrowser(t)) return;
  if (process.platform !== 'darwin' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { t.skip('The standalone sign-in check requires a desktop display.'); return; }
  let observed;
  const f = await fixture(t, (request, response) => {
    if (request.url.startsWith('/evidence')) { observed = new URL(request.url, 'http://fixture').searchParams.get('webdriver'); response.end('recorded'); return; }
    response.setHeader('Content-Type', 'text/html'); response.setHeader('Set-Cookie', 'manualIdentity=retained; Path=/; HttpOnly; Max-Age=3600');
    response.end('<script>fetch("/evidence?webdriver="+navigator.webdriver)</script><h1>Manual account sign-in</h1>');
  });
  const manual = await startOwnedBrowserSignIn({ dataDir: f.dataDir, url: f.origin, autoInstall: false });
  f.cleanup(() => manual.close());
  assert.equal(await eventually(() => observed, 15_000), 'false');
  await manual.close();
  const runtime = await startOwnedBrowserRuntime({ dataDir: f.dataDir, guard: { resolve: async () => ({ address: '127.0.0.1', family: 4, url: new URL(f.origin), port: Number(new URL(f.origin).port) }) }, autoInstall: false });
  f.cleanup(() => runtime.close());
  assert.ok((await runtime.context.cookies(f.origin)).some((cookie) => cookie.name === 'manualIdentity' && cookie.value === 'retained'));
});

test('hostile page prototypes and mirrored credentials cannot leak through browser observations', async (t) => {
  if (!await needsBrowser(t)) return;
  const f = await fixture(t, (_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<title>fixture secret 97531</title><input type="password" aria-label="Password" value="fixture secret 97531"><div>echo:fixture secret 97531</div><a href="/copy?value=fixture+secret+97531">Encoded mirror</a><form action="/search?value=fixture+secret+97531"><input aria-label="Query"></form><script>Element.prototype.matches=()=>false;</script>`);
  });
  const browser = createOwnedBrowserService({ dataDir: f.dataDir, workspaceTargets: [f.origin], autoInstall: false });
  f.cleanup(() => browser.close());
  const opened = await browser.request(agent, 'open', { url: f.origin });
  const observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  assert.equal(observation.snapshot.elements.find(el => el.name === 'Password').sensitive, true);
  for (const secret of ['fixture secret 97531', 'fixture%20secret%2097531', 'fixture+secret+97531']) assert.equal(JSON.stringify(observation).includes(secret), false);
  await assert.rejects(browser.request(agent, 'frame', { tabId: opened.tab.tabId }), { code: 'BROWSER_PASSWORD_CAPTURE_PROTECTED' });
});

test('unapproved origins cannot receive typed document data or disguised export and search submissions', async (t) => {
  if (!await needsBrowser(t)) return;
  let writes = 0;
  const f = await fixture(t, (request, response) => {
    if (request.url !== '/') { writes++; response.end('changed'); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<input aria-label="Notes" oninput="fetch('/leak?d='+encodeURIComponent(this.value))"><form method="post" action="/export-destroy"><input type="hidden" name="mode" value="purge-all"><button>Export PDF</button></form><form action="/search"><input name="q" value="destroy"><button>Search</button></form>`);
  });
  const policy = createBrowserPolicy({ dataDir: f.dataDir });
  const browser = createOwnedBrowserService({ dataDir: f.dataDir, policy, workspaceTargets: [f.origin], autoInstall: false });
  f.cleanup(() => browser.close());
  const opened = await browser.request(agent, 'open', { url: f.origin });
  for (const [action, name, args] of [['type', 'Notes', { text: 'private-document' }], ['click', 'Export PDF', {}], ['click', 'Search', {}]]) {
    const observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
    await assert.rejects(browser.request(agent, action, { ...refArgs(observation, observation.snapshot.elements.find(el => el.name === name)), ...args }), { code: 'BROWSER_PERMISSION_REQUIRED' });
  }
  assert.equal(writes, 0);
  await policy.update({ actor: human, operation: 'set-site', origin: f.origin, allowedActions: ['browse', 'read', 'website-change'] });
  const observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  await browser.request(agent, 'type', { ...refArgs(observation, observation.snapshot.elements.find(el => el.name === 'Notes')), text: 'approved input' });
  await eventually(() => writes === 1);
});

test('saved-account fill bypasses page setters while delivering normal input events', async (t) => {
  if (!await needsBrowser(t)) return;
  const f = await fixture(t, (_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<input aria-label="Identity"><input type="password" aria-label="Password"><script>
      window.setterCalls=0;window.inputs=0;
      const original=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
      Object.defineProperty(HTMLInputElement.prototype,'value',{...original,set(value){setterCalls++;original.set.call(this,value)}});
      document.addEventListener('input',()=>inputs++);
    </script>`);
  });
  let context;
  const credentialBroker = { assertBrowserAccess: async () => {}, issueHandle: async () => ({ handle: 'fixture' }), fill: async ({ fill }) => fill({ username: 'fixture-user', password: 'fixture-broker-secret' }) };
  const browser = createOwnedBrowserService({ dataDir: f.dataDir, credentialBroker, workspaceTargets: [f.origin], autoInstall: false, runtimeFactory: async options => { const runtime = await startOwnedBrowserRuntime(options); context = runtime.context; return runtime; } });
  f.cleanup(() => browser.close());
  const opened = await browser.request(agent, 'open', { url: f.origin });
  const observed = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  const password = observed.snapshot.elements.find(element => element.sensitive);
  const username = observed.snapshot.elements.find(element => element.name === 'Identity');
  await browser.request(agent, 'fill-account', { ...refArgs(observed, password), accountId: 'fixture', passwordRef: password.ref, usernameRef: username.ref });
  const page = context.pages().find(page => page.url().startsWith(f.origin));
  assert.equal(await page.locator('input[type="password"]').inputValue(), 'fixture-broker-secret');
  assert.deepEqual(await page.evaluate(() => ({ setterCalls, inputs })), { setterCalls: 0, inputs: 2 });
  assert.equal(JSON.stringify(await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId })).includes('fixture-broker-secret'), false);
});
