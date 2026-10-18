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
// 개요 줄에서 ref를 꺼낸다. 이름은 따옴표 안, 입력값은 콜론 뒤에 있다.
const lineRef = (observation, match) => { const line = observation.snapshot.outline.split('\n').find(match); assert.ok(line, 'expected outline line'); return { ref: line.match(/\[ref=([^\]]+)\]/)[1], line }; };
const named = (observation, name) => lineRef(observation, (line) => line.includes(`"${name}"`) || line.endsWith(`: ${name}`));
const textboxes = (observation) => observation.snapshot.outline.split('\n').filter((line) => /- textbox(?: |$)/.test(line.trim())).map((line) => ({ ref: line.match(/\[ref=([^\]]+)\]/)[1], line }));
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
async function saveLogin(broker, origin, { username = 'PRIVATE_USERNAME', password = 'PRIVATE_PASSWORD' } = {}) {
  const request = await broker.requestAccount({ actor: agent, origin, label: 'Fixture saved account' });
  return (await broker.saveLogin({ actor: human, requestId: request.requestId, account: { origin, label: 'Fixture saved account' }, username, password })).account;
}
// 여러 사이트를 한 서버로 띄운다. 호스트 이름은 모두 127.0.0.1 로 풀고 Host 머리글로 사이트를 고른다.
async function sites(t, hosts, handler) {
  const f = await fixture(t, handler, true);
  const port = new URL(f.origin).port;
  const origins = Object.fromEntries(hosts.map((host) => [host, `https://${host}:${port}`]));
  return { ...f, origins, lookup: async () => [{ address: '127.0.0.1', family: 4 }] };
}

test('turning a login off during credential readiness prevents each subsequent field write', async (t) => {
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
    const account = await saveLogin(credentialBroker, f.origin);
    await policy.grantSiteAccess({ actor: human, threadId: agent.threadId, origin: f.origin, scope: 'chat' });
    let context;
    const browser = createOwnedBrowserService({ dataDir: f.dataDir, policy, credentialBroker, workspaceTargets: [f.origin], autoInstall: false, runtimeFactory: async (options) => { const runtime = await testRuntime(options); context = runtime.context; return runtime; } });
    f.cleanup(() => browser.close());
    const opened = await browser.request(agent, 'open', { url: f.origin });
    const observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
    const [username, password] = textboxes(observation);
    const filling = browser.request(agent, 'fill-account', { ...refArgs(observation, password), accountId: account.id, usernameRef: username.ref, passwordRef: password.ref });
    const rejected = assert.rejects(filling, (failure) => failure.code?.startsWith('BROWSER_'));
    await eventually(() => waiting);
    await credentialBroker.setLoginBlocked({ actor: human, accountId: account.id, blocked: true });
    const page = context.pages().find((entry) => entry.url().startsWith(f.origin));
    await page.evaluate(() => { document.getElementById('identity').style.display = ''; document.getElementById('secret').style.display = ''; });
    await rejected;
    assert.equal(await page.locator('#secret').inputValue(), '');
    if (hidden === 'username') assert.equal(await page.locator('#identity').inputValue(), '');
  });
});

test('browser reset drains its owner and removes only browser profile and account data', async (t) => {
  if (!await needsBrowser(t)) return;
  const f = await fixture(t, (_request, response) => { response.setHeader('Set-Cookie', 'reader=retained; Path=/; Max-Age=3600'); response.end('Research'); });
  const policy = createBrowserPolicy({ dataDir: f.dataDir });
  const secretStore = createMemorySecretStore(); await secretStore.set('provider.secret', 'RETAINED_PROVIDER');
  const credentialBroker = createBrowserCredentialBroker({ dataDir: f.dataDir, policy, secretStore, wrappingKeyProvider: async () => Buffer.alloc(32, 6) });
  const account = await saveLogin(credentialBroker, 'https://account.example.com');
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
    const element = named(observation, name);
    await browser.request(agent, action, { ...refArgs(observation, element), ...args });
  }
  await eventually(() => mutations >= 5);
  let observation = await reset();
  await browser.request(agent, 'type', { ...refArgs(observation, named(observation, 'Public query')), text: 'research' });
  await eventually(() => mutations >= 6);
  observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  await browser.request(agent, 'click', { ...refArgs(observation, lineRef(observation, (line) => line.includes('button "Search"'))) });
  assert.equal(searches, 1);
  observation = await reset();
  const username = named(observation, 'Saved identity');
  const password = lineRef(observation, (line) => /^- textbox \[ref=[^\]]+\]$/.test(line.trim()));
  await browser.request(agent, 'fill-account', { ...refArgs(observation, password), accountId: 'fixture-account', usernameRef: username.ref, passwordRef: password.ref });
  observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  assert.equal(JSON.stringify(observation).includes('BROKER_PRIVATE_'), false);
  const privateField = named(observation, 'Saved identity');
  assert.match(privateField.line, /: \[masked\]$/);
  await browser.request(agent, 'press', { ...refArgs(observation, privateField), key: 'Meta+a' });
  observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  assert.equal(observation.snapshot.selectedText, undefined);
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
  const observation = await eventually(async () => { const result = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId }); return result.snapshot.outline.includes('Ready') && result; });
  // 입력은 자유롭다. 페이지가 보내는 웹소켓 메시지는 사이트 변경 승인 없이 오간다.
  assert.equal((await browser.request(agent, 'type', { ...refArgs(observation, textboxes(observation)[0]), text: 'query' })).ok, true);
  await context.pages().find(page => page.url().startsWith(f.origin)).evaluate(() => socket.send('read-query'));
  await eventually(() => mutations === 2);
  assert.equal(sockets.clients.size, 1);
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
  await assert.rejects(browser.request(agent, 'click', { ...refArgs(observation, named(observation, 'Export PDF')), intent: 'research' }), { code: 'BROWSER_PERMISSION_REQUIRED' });
  assert.equal(posted, false);
  await policy.update({ actor: human, operation: 'set-site', origin: f.origin, allowedActions: ['browse', 'read', 'download', 'website-change'] });
  await browser.request(agent, 'click', { ...refArgs(observation, named(observation, 'Export PDF')), intent: 'research' });
  const exported = await eventually(async () => (await downloads.list(agent)).find((job) => job.state === 'downloaded'));
  assert.equal(posted, true);
  assert.equal(exported.source.url, `${f.origin}/pdf/export`);
  observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  await browser.request(agent, 'click', { ...refArgs(observation, named(observation, 'Slow PDF')) });
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
    response.end(`<title>fixture-secret-97531</title><input type="password" aria-label="Password" value="fixture-secret-97531"><div>echo:fixture-secret-97531</div><script>Element.prototype.matches=()=>false;</script>`);
  });
  const browser = createOwnedBrowserService({ dataDir: f.dataDir, workspaceTargets: [f.origin], autoInstall: false });
  f.cleanup(() => browser.close());
  const opened = await browser.request(agent, 'open', { url: f.origin });
  const observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  assert.match(named(observation, 'Password').line, /: \[masked\]$/);
  assert.equal(JSON.stringify(observation).includes('fixture-secret-97531'), false);
  await assert.rejects(browser.request(agent, 'frame', { tabId: opened.tab.tabId }), { code: 'BROWSER_PASSWORD_CAPTURE_PROTECTED' });
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
  const password = named(observed, 'Password');
  const username = named(observed, 'Identity');
  await browser.request(agent, 'fill-account', { ...refArgs(observed, password), accountId: 'fixture', passwordRef: password.ref, usernameRef: username.ref });
  const page = context.pages().find(page => page.url().startsWith(f.origin));
  assert.equal(await page.locator('input[type="password"]').inputValue(), 'fixture-broker-secret');
  assert.deepEqual(await page.evaluate(() => ({ setterCalls, inputs })), { setterCalls: 0, inputs: 2 });
  assert.equal(JSON.stringify(await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId })).includes('fixture-broker-secret'), false);
});

test('a site access approval lets its chat sign in with the saved account and submit website changes there', async (t) => {
  if (!await needsBrowser(t)) return;
  const posts = [];
  const f = await fixture(t, (request, response) => {
    if (request.method === 'POST') { posts.push(request.url); response.writeHead(303, { Location: '/home' }); response.end(); return; }
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/home') { response.end('<form method="post" action="/orders"><button>Place order</button></form>'); return; }
    response.end('<form method="post" action="/login"><input name="id" aria-label="Identity"><input name="pw" type="password" aria-label="Password"><button>Sign in</button></form>');
  });
  const policy = createBrowserPolicy({ dataDir: f.dataDir });
  const credentialBroker = { assertBrowserAccess: async () => {}, issueHandle: async () => ({ handle: 'fixture' }), fill: async ({ fill }) => fill({ username: 'fixture-user', password: 'fixture-broker-secret' }) };
  const browser = createOwnedBrowserService({ dataDir: f.dataDir, policy, credentialBroker, workspaceTargets: [f.origin], autoInstall: false });
  f.cleanup(() => browser.close());
  const opened = await browser.request(agent, 'open', { url: `${f.origin}/home` });
  let observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  // 승인 전(또는 거절 뒤)에는 사이트 변경이 막힌다.
  await assert.rejects(browser.request(agent, 'click', refArgs(observation, named(observation, 'Place order'))), { code: 'BROWSER_PERMISSION_REQUIRED', reason: 'website-change', request: { tool: 'browser_request_account', args: { kind: 'site', origin: f.origin } } });
  assert.deepEqual(posts, [], 'a POST form click is refused before any request');

  await policy.grantSiteAccess({ actor: human, threadId: agent.threadId, origin: f.origin, scope: 'chat' });
  await browser.request(agent, 'navigate', { tabId: opened.tab.tabId, url: f.origin, navigationEpoch: observation.tab.navigationEpoch, controllerEpoch: observation.tab.controllerEpoch });
  observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  await browser.request(agent, 'fill-account', { ...refArgs(observation, named(observation, 'Password')), accountId: 'fixture', usernameRef: named(observation, 'Identity').ref, passwordRef: named(observation, 'Password').ref });
  observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  await browser.request(agent, 'click', refArgs(observation, named(observation, 'Sign in')));
  observation = await eventually(async () => { const next = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId }); return next.snapshot.outline.includes('Place order') && next; });
  await browser.request(agent, 'click', refArgs(observation, named(observation, 'Place order')));
  await eventually(() => posts.includes('/orders'));
  assert.deepEqual(posts, ['/login', '/orders']);

  // 다른 채팅의 에이전트는 이 승인을 쓰지 못한다.
  const otherAgent = { ...agent, threadId: 'other-chat', agentId: 'other' };
  const otherTab = await browser.request(otherAgent, 'open', { url: `${f.origin}/home` });
  const otherObservation = await browser.request(otherAgent, 'snapshot', { tabId: otherTab.tab.tabId });
  await assert.rejects(browser.request(otherAgent, 'click', refArgs(otherObservation, named(otherObservation, 'Place order'))), { code: 'BROWSER_PERMISSION_REQUIRED' });
  assert.deepEqual(posts, ['/login', '/orders']);
});

test('a refused navigation leaves the tab on its page and names the site to ask for', async (t) => {
  if (!await needsBrowser(t)) return;
  const f = await sites(t, ['www.shopfixture.com', 'mail.privatefixture.com'], (request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.headers.host.startsWith('mail.')) { response.end('<title>Inbox</title><h1>Private inbox</h1>'); return; }
    if (request.url === '/go') { response.writeHead(302, { Location: `https://mail.privatefixture.com:${request.headers.host.split(':')[1]}/inbox` }); response.end(); return; }
    response.end(`<title>Shop</title><h1>Shop home</h1><a href="https://mail.privatefixture.com:${request.headers.host.split(':')[1]}/inbox">Inbox</a>`);
  });
  const shop = f.origins['www.shopfixture.com'], mail = f.origins['mail.privatefixture.com'];
  const policy = createBrowserPolicy({ dataDir: f.dataDir });
  let context;
  const browser = createOwnedBrowserService({ dataDir: f.dataDir, policy, workspaceTargets: [shop, mail], lookup: f.lookup, autoInstall: false, runtimeFactory: async (options) => { const runtime = await testRuntime(options); context = runtime.context; return runtime; } });
  f.cleanup(() => browser.close());
  const opened = await browser.request(agent, 'open', { url: `${shop}/` });
  await context.addCookies([{ name: 'session', value: 'owner', domain: 'mail.privatefixture.com', path: '/', secure: true }]);
  await policy.markSignedIn({ profileId: 'default', origin: mail, source: 'owner-form' });
  await browser.refreshSites();
  let observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  const refused = await browser.request(agent, 'navigate', { tabId: opened.tab.tabId, url: `${mail}/inbox`, navigationEpoch: observation.tab.navigationEpoch, controllerEpoch: observation.tab.controllerEpoch }).catch((error) => error);
  assert.deepEqual([refused.code, refused.reason, refused.site, refused.request], ['BROWSER_PERMISSION_REQUIRED', 'signed-in', 'privatefixture.com', { tool: 'browser_request_account', args: { kind: 'site', origin: mail } }]);
  observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  assert.ok(observation.snapshot.outline.includes('Shop home'), 'no chrome-error page');
  assert.equal(new URL(observation.tab.url).host, new URL(shop).host);
  const link = await browser.request(agent, 'click', refArgs(observation, named(observation, 'Inbox'))).catch((error) => error);
  assert.equal(link.reason, 'signed-in', 'a link click to the signed-in site is refused the same way');
  observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  assert.ok(observation.snapshot.outline.includes('Shop home'));
  // 리디렉트로 도착한 로그인 사이트도 같은 판정을 받는다. 요청은 이미 나갔으므로 performed 다.
  const redirected = await browser.request(agent, 'open', { url: `${shop}/go` }).catch((error) => error);
  assert.deepEqual([redirected.reason, redirected.site, redirected.performed], ['signed-in', 'privatefixture.com', true]);
  await policy.grantSiteAccess({ actor: human, threadId: agent.threadId, origin: mail, scope: 'chat' });
  await browser.request(agent, 'navigate', { tabId: opened.tab.tabId, url: `${mail}/inbox`, navigationEpoch: observation.tab.navigationEpoch, controllerEpoch: observation.tab.controllerEpoch });
  assert.ok((await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId })).snapshot.outline.includes('Private inbox'));
});

test('redirects after a permitted change inherit it, while a block on the landing site still wins and reports the change as performed', async (t) => {
  if (!await needsBrowser(t)) return;
  let orders = 0;
  const f = await sites(t, ['www.shopfixture.com', 'pg.payfixture.com'], (request, response) => {
    const port = request.headers.host.split(':')[1];
    if (request.method === 'POST') { orders++; response.writeHead(303, { Location: `https://pg.payfixture.com:${port}/receipt` }); response.end(); return; }
    response.setHeader('Content-Type', 'text/html');
    if (request.headers.host.startsWith('pg.')) { response.end('<title>Receipt</title><h1>Payment receipt</h1>'); return; }
    response.end('<title>Checkout</title><form method="post" action="/order"><button>Pay</button></form>');
  });
  const shop = f.origins['www.shopfixture.com'], pg = f.origins['pg.payfixture.com'];
  const policy = createBrowserPolicy({ dataDir: f.dataDir });
  let context;
  const browser = createOwnedBrowserService({ dataDir: f.dataDir, policy, workspaceTargets: [shop, pg], lookup: f.lookup, autoInstall: false, runtimeFactory: async (options) => { const runtime = await testRuntime(options); context = runtime.context; return runtime; } });
  f.cleanup(() => browser.close());
  await policy.grantSiteAccess({ actor: human, threadId: agent.threadId, origin: shop, scope: 'chat' });
  const opened = await browser.request(agent, 'open', { url: `${shop}/checkout` });
  // 결제 사이트는 로그인한 사이트라서 바로 열면 거절된다. 허용된 주문 POST 의 303 홉으로는 이어받는다.
  await context.addCookies([{ name: 'pg', value: 'owner', domain: 'pg.payfixture.com', path: '/', secure: true }]);
  await policy.markSignedIn({ profileId: 'default', origin: pg, source: 'owner-form' });
  await browser.refreshSites();
  let observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  const paid = await browser.request(agent, 'click', refArgs(observation, named(observation, 'Pay')));
  assert.equal(paid.ok, true);
  assert.equal(new URL(paid.url).host, new URL(pg).host);
  assert.equal(orders, 1);
  await browser.request(agent, 'navigate', { tabId: opened.tab.tabId, url: `${shop}/checkout`, navigationEpoch: paid.navigationEpoch, controllerEpoch: observation.tab.controllerEpoch });
  await policy.update({ actor: human, operation: 'set-site', origin: pg, blockedActions: ['browse', 'read'] });
  observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  const blocked = await browser.request(agent, 'click', refArgs(observation, named(observation, 'Pay'))).catch((error) => error);
  assert.deepEqual([blocked.code, blocked.site, blocked.performed], ['BROWSER_SITE_BLOCKED', 'payfixture.com', true], 'the order already reached the shop; do not resubmit blindly');
  assert.equal(orders, 2);
  // 3xx 홉은 이미 열렸다. 막힌 페이지는 읽을 수 없고, 같은 탭으로 다시 돌아갈 수 있다.
  await assert.rejects(browser.request(agent, 'snapshot', { tabId: opened.tab.tabId }), { code: 'BROWSER_SITE_BLOCKED' });
  const tab = (await browser.inventory(agent)).tabs.find((entry) => entry.tabId === opened.tab.tabId);
  await browser.request(agent, 'navigate', { tabId: tab.tabId, url: `${shop}/checkout`, navigationEpoch: tab.navigationEpoch, controllerEpoch: tab.controllerEpoch });
  assert.ok((await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId })).snapshot.outline.includes('Pay'));
});

test('only same-site writes during an agent action need site access; page loads, GraphQL reads and cross-site telemetry do not', async (t) => {
  if (!await needsBrowser(t)) return;
  const hits = { cart: 0, telemetry: 0, graphql: 0, collect: 0 };
  const f = await sites(t, ['www.shopfixture.com', 'stats.trackerfixture.com'], (request, response) => {
    const port = request.headers.host.split(':')[1];
    const pathName = new URL(request.url, 'https://fixture').pathname.slice(1);
    if (pathName in hits) { hits[pathName]++; response.setHeader('Access-Control-Allow-Origin', '*'); response.end('{}'); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<title>Shop</title><h1>Kettles</h1>
      <button onclick="fetch('/cart',{method:'POST',body:'kettle'})">Add to cart</button>
      <button onclick="fetch('/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'query { items }'})})">Load more</button>
      <button onclick="fetch('https://stats.trackerfixture.com:${port}/collect',{method:'POST',mode:'no-cors',body:'x'})">Track</button>
      <script>fetch('/telemetry',{method:'POST',body:'load'})</script>`);
  });
  const shop = f.origins['www.shopfixture.com'], stats = f.origins['stats.trackerfixture.com'];
  const policy = createBrowserPolicy({ dataDir: f.dataDir });
  const browser = createOwnedBrowserService({ dataDir: f.dataDir, policy, workspaceTargets: [shop, stats], lookup: f.lookup, autoInstall: false, runtimeFactory: testRuntime });
  f.cleanup(() => browser.close());
  const opened = await browser.request(agent, 'open', { url: `${shop}/` });
  await eventually(() => hits.telemetry === 1);
  const click = async (name) => { const observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId }); return browser.request(agent, 'click', refArgs(observation, named(observation, name))).catch((error) => error); };
  const refused = await click('Add to cart');
  assert.deepEqual([refused.code, refused.reason, refused.performed], ['BROWSER_PERMISSION_REQUIRED', 'website-change', false]);
  assert.equal(hits.cart, 0);
  assert.equal((await click('Load more')).ok, true);
  assert.equal(hits.graphql, 1);
  const tracked = await click('Track');
  assert.equal(tracked.ok, true);
  assert.deepEqual(tracked.dropped?.map((entry) => entry.origin), [stats], 'cross-site writes without the page site\'s access are dropped and listed');
  assert.equal(hits.collect, 0);
  await policy.grantSiteAccess({ actor: human, threadId: agent.threadId, origin: shop, scope: 'chat' });
  assert.equal((await click('Add to cart')).ok, true);
  await eventually(() => hits.cart === 1);
  assert.equal((await click('Track')).dropped, undefined);
  await eventually(() => hits.collect === 1);
});

test('a filled password stays masked in every tab, not just the one it was typed into', async (t) => {
  if (!await needsBrowser(t)) return;
  const password = `fixture-global-${crypto.randomUUID()}`;
  const f = await fixture(t, (request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/echo') { response.end(`<title>Profile</title><p>Saved password: ${password}</p>`); return; }
    response.end('<form method="post" action="/login"><input aria-label="Identity"><input type="password" aria-label="Password"></form>');
  });
  const reported = [];
  const credentialBroker = { issueHandle: async () => ({ handle: 'fixture' }), fill: async ({ fill }) => fill({ username: 'fixture-user', password }) };
  const browser = createOwnedBrowserService({ dataDir: f.dataDir, credentialBroker, workspaceTargets: [f.origin], autoInstall: false, onFilledValue: (value) => reported.push(value) });
  f.cleanup(() => browser.close());
  const opened = await browser.request(agent, 'open', { url: f.origin });
  const observed = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  await browser.request(agent, 'fill-account', { ...refArgs(observed, named(observed, 'Password')), accountId: 'fixture', usernameRef: named(observed, 'Identity').ref, passwordRef: named(observed, 'Password').ref });
  assert.deepEqual(reported, [password], 'the hub learns the value so it can scrub tool results');
  const other = await browser.request(agent, 'open', { url: `${f.origin}/echo` });
  const view = await browser.request(agent, 'snapshot', { tabId: other.tab.tabId, text: true });
  assert.equal(JSON.stringify(view).includes(password), false);
  assert.match(view.snapshot.text, /Saved password: \[masked\]/);
});

test('an owner form sign-in marks the site, an owner GET visit or the agent\'s own cookies never do', async (t) => {
  if (!await needsBrowser(t)) return;
  const f = await sites(t, ['www.memberfixture.com'], (request, response) => {
    if (request.method === 'POST') { response.writeHead(303, { Location: '/home', 'Set-Cookie': 'session=owner; Path=/; Secure; HttpOnly' }); response.end(); return; }
    response.setHeader('Content-Type', 'text/html');
    response.setHeader('Set-Cookie', 'pref=dark; Path=/; Secure');
    if (request.url === '/home') { response.end('<title>Home</title><h1>Member home</h1>'); return; }
    response.end('<title>Login</title><form method="post" action="/login"><input name="id" aria-label="Identity"><button>Sign in</button></form>');
  });
  const site = f.origins['www.memberfixture.com'];
  const policy = createBrowserPolicy({ dataDir: f.dataDir });
  const browser = createOwnedBrowserService({ dataDir: f.dataDir, policy, workspaceTargets: [site], lookup: f.lookup, autoInstall: false, runtimeFactory: testRuntime });
  f.cleanup(() => browser.close());
  await browser.request(agent, 'open', { url: `${site}/` });
  const ownerTab = (await browser.request(human, 'open', { url: `${site}/` })).tab;
  await browser.refreshSites();
  assert.equal((await browser.request(agent, 'open', { url: `${site}/home` })).ok, true, 'cookies from GET visits never gate');
  assert.deepEqual((await policy.list()).signedIn, []);
  const observation = await browser.request(human, 'snapshot', { tabId: ownerTab.tabId });
  await browser.request(human, 'click', refArgs(observation, named(observation, 'Sign in')));
  await eventually(async () => (await policy.list()).signedIn.some((marker) => marker.key === 'https://memberfixture.com' && marker.source === 'owner-form'));
  await browser.refreshSites();
  const refused = await browser.request(agent, 'open', { url: `${site}/home` }).catch((error) => error);
  assert.equal(refused.reason, 'signed-in');
  assert.equal((await browser.request(agent, 'snapshot', { tabId: ownerTab.tabId })).ok, true, 'the owner\'s shared tab stays readable');
  await policy.grantSiteAccess({ actor: human, threadId: agent.threadId, origin: site, scope: 'chat' });
  assert.equal((await browser.request(agent, 'open', { url: `${site}/home` })).ok, true);
});
