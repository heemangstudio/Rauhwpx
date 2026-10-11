import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { inspectMacPasskeyBrowser, macPasskeyCapability, startOwnedBrowserSignIn, startOwnedBrowserRuntime } from '../owned-browser-runtime.mjs';
import { createBrowserNetworkGuard } from '../owned-browser-network.mjs';

test('Mac passkey capability requires a supported OS and verified Chrome browser entitlement', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-chrome-inspection-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executablePath = path.join(root, 'Contents', 'MacOS', 'Google Chrome');
  await fs.mkdir(path.dirname(executablePath), { recursive: true });
  await fs.writeFile(executablePath, '', { mode: 0o700 });
  const calls = [];
  const inspect = (version, entitlement = true, signed = true) => inspectMacPasskeyBrowser({ platform: 'darwin', locations: [root], runFile: async (file, args) => {
    calls.push({ file, args });
    if (file.endsWith('sw_vers')) return { stdout: version };
    if (args.includes('--verify')) { if (!signed) throw new Error('Wrong signature'); return { stdout: '' }; }
    return { stdout: entitlement ? '<key>com.apple.developer.web-browser.public-key-credential</key><true/>' : '<dict/>' };
  } });
  assert.equal((await inspect('13.4')).reason, 'macos-13.5-required');
  assert.equal((await inspect('15.5', true, false)).supported, false);
  assert.equal((await inspect('15.5', false)).supported, false);
  const supported = await inspect('15.5');
  assert.equal(supported.executablePath, executablePath);
  assert.equal(supported.supported, true);
  assert.equal(JSON.stringify(macPasskeyCapability(supported)).includes(root), false);
  assert.ok(calls.some(({ args }) => args.includes('-R') && args.some((value) => value.includes('EQHXZ8M8AV'))));
});

test('Mac passkey handoff launches only signed Chrome in an owned profile without automation or mock keychain', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-chrome-handoff-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let spawnCall;
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const signIn = await startOwnedBrowserSignIn({ dataDir, url: 'https://site.example/login', authenticationMethod: 'mac-passkey',
    inspectPasskeyBrowser: async () => ({ supported: true, executablePath: '/signed-chrome' }),
    spawnProcess: (file, args, options) => {
      spawnCall = { file, args, options };
      queueMicrotask(() => child.emit('spawn'));
      return child;
    } });
  assert.equal(spawnCall.file, '/signed-chrome');
  assert.ok(spawnCall.args.includes(`--user-data-dir=${path.join(dataDir, 'browser', 'chrome-profile')}`));
  assert.equal(spawnCall.args.some((value) => /mock-keychain|password-store|remote-debugging|enable-automation/.test(value)), false);
  assert.equal(spawnCall.options.shell, false);
  assert.equal(signIn.authenticationMethod, 'mac-passkey');
  assert.equal(signIn.provider, 'chrome');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'browser', 'managed-provider.json'), 'utf8')), { version: 1, provider: 'chrome' });
  child.emit('exit', 0);
  await signIn.close();
  await assert.rejects(startOwnedBrowserSignIn({ dataDir, url: 'https://site.example/', authenticationMethod: 'mac-passkey',
    inspectPasskeyBrowser: async () => ({ supported: false }), spawnProcess: () => { throw new Error('Must not spawn'); } }), { code: 'BROWSER_MAC_PASSKEY_UNAVAILABLE' });
});

test('managed reopening uses the signed Chrome profile and removes Playwright mock-keychain defaults', async (t) => {
  const chrome = await inspectMacPasskeyBrowser();
  if (!chrome.supported) { t.skip('Signed Chrome with Mac passkey entitlement is unavailable'); return; }
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-chrome-reopen-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dataDir, 'browser'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'browser', 'managed-provider.json'), JSON.stringify({ version: 1, provider: 'chrome' }));
  const { chromium } = await import('playwright');
  const launch = chromium.launchPersistentContext;
  let actual;
  let closed = false;
  chromium.launchPersistentContext = async (profileDir, options) => {
    actual = { profileDir, options };
    return { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, browser: () => null, close: async () => { closed = true; } };
  };
  t.after(() => { chromium.launchPersistentContext = launch; });
  const runtime = await startOwnedBrowserRuntime({ dataDir, guard: createBrowserNetworkGuard(), autoInstall: false });
  assert.equal(actual.profileDir, path.join(dataDir, 'browser', 'chrome-profile'));
  assert.equal(actual.options.executablePath, chrome.executablePath);
  assert.ok(actual.options.ignoreDefaultArgs.includes('--use-mock-keychain'));
  assert.ok(actual.options.ignoreDefaultArgs.includes('--password-store=basic'));
  assert.equal(runtime.kind, 'chrome');
  await runtime.close();
  assert.equal(closed, true);
});

test('real signed Chrome handoff retains local fixture authentication after managed reopening', { skip: process.env.RHWP_TEST_MAC_PASSKEY_HANDOFF !== '1' ? 'Run explicitly on a Mac with signed Chrome; may ask for Chrome Safe Storage access' : false, timeout: 45_000 }, async (t) => {
  assert.equal((await inspectMacPasskeyBrowser()).supported, true);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-chrome-cookie-handoff-'));
  let serveLogin;
  const served = new Promise((resolve) => { serveLogin = resolve; });
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/login') {
      response.setHeader('Set-Cookie', 'fixtureAuth=private-fixture; Path=/; HttpOnly; Max-Age=3600');
      response.on('finish', serveLogin);
      response.end('<!doctype html><title>App-owned Chrome fixture</title><h1>Local fixture session</h1>');
    } else response.end(`<title>Fixture reuse</title><h1>${request.headers.cookie?.includes('fixtureAuth=private-fixture') ? 'Authenticated fixture' : 'Missing fixture authentication'}</h1>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let signIn;
  let runtime;
  t.after(async () => { await signIn?.close(); await runtime?.close(); await new Promise((resolve) => server.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  signIn = await startOwnedBrowserSignIn({ dataDir, url: `${origin}/login`, authenticationMethod: 'mac-passkey', autoInstall: false });
  await Promise.race([served, new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('Chrome did not load the controlled fixture')), 12_000); timer.unref(); })]);
  await signIn.close();
  signIn = null;
  runtime = await startOwnedBrowserRuntime({ dataDir, guard: createBrowserNetworkGuard({ workspaceTargets: [origin] }), headless: true, autoInstall: false });
  const page = await runtime.context.newPage();
  await page.goto(`${origin}/reuse`);
  assert.equal(await page.locator('h1').innerText(), 'Authenticated fixture');
  const stored = await runtime.context.storageState();
  assert.ok(stored.cookies.some((cookie) => cookie.name === 'fixtureAuth' && cookie.httpOnly));
  assert.equal(runtime.kind, 'chrome');
});
