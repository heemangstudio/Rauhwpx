import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCliSetupManager, defaultCliSetupRoot } from '../cli-setup-manager.mjs';
import { API_KEY_MAX_BYTES, AUTH_CODE_MAX_BYTES } from '../input-bounds.mjs';
import { createMemorySecretStore } from '../secret-store.mjs';

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  input = '';
  stdin = {
    write: (value = '') => { this.input += String(value); return true; },
    end: (value = '') => { this.input += String(value); },
  };
  killed = false;
  exitCode = null;
  signalCode = null;

  kill(signal = 'SIGTERM') {
    this.killed = true;
    this.signalCode = signal;
    queueMicrotask(() => this.emit('close', null, signal));
    return true;
  }
}

async function tmpRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-setup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function packageBinName(packageName) {
  if (packageName.startsWith('@openai/codex')) return 'codex';
  if (packageName.startsWith('@anthropic-ai/claude-code')) return 'claude';
  return null;
}

function fakeSpawner(prefixDir, platform = process.platform) {
  const calls = [];
  const spawnProcess = (command, argv, options) => {
    const proc = new FakeProcess();
    calls.push({ command, argv, options, proc });
    queueMicrotask(async () => {
      const packageName = argv.at(-1);
      if (typeof packageName === 'string' && packageName.startsWith('@')) {
        const packageDir = path.join(prefixDir, 'node_modules', ...packageName.split('/'));
        await fs.mkdir(packageDir, { recursive: true });
        await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: packageName, version: '1.2.3' }));
        const binName = packageBinName(packageName);
        if (binName) {
          const binPath = path.join(prefixDir, 'node_modules', '.bin', platform === 'win32' ? `${binName}.cmd` : binName);
          await fs.mkdir(path.dirname(binPath), { recursive: true });
          await fs.writeFile(binPath, '');
        }
        proc.stdout.emit('data', 'installed\n');
        proc.emit('close', 0, null);
        return;
      }
      if (argv.includes('--version')) {
        proc.stdout.emit('data', `${path.basename(String(command), '.cmd')} 1.2.3\n`);
        proc.emit('close', 0, null);
        return;
      }
      proc.emit('close', 0, null);
    });
    return proc;
  };
  return { calls, spawnProcess };
}

test('CLI setup root follows the app data directory on each platform', () => {
  assert.equal(defaultCliSetupRoot({ RHWP_CLI_DIR: '/tmp/rhwp-cli' }), path.resolve('/tmp/rhwp-cli'));
  assert.equal(defaultCliSetupRoot({}, 'darwin', '/Users/tester'), '/Users/tester/Library/Application Support/rhwp/cli');
  assert.equal(defaultCliSetupRoot({ APPDATA: 'C:\\data' }, 'win32', 'C:\\Users\\tester'), path.win32.join('C:\\data', 'rhwp', 'cli'));
  assert.equal(defaultCliSetupRoot({}, 'linux', '/home/tester'), '/home/tester/.local/share/rhwp/cli');
});

test('only supported CLI agents can reach setup operations', async (t) => {
  const manager = await createCliSetupManager({ rootDir: await tmpRoot(t) }).init();
  await assert.rejects(() => manager.status('cursor'), (error) => error.code === 'AGENT_SETUP_INVALID');
  await assert.rejects(() => manager.authenticate('grok', 'api-key', 'secret'), (error) => error.code === 'AGENT_SETUP_INVALID');
  assert.throws(() => manager.binPath('opencode'), (error) => error.code === 'AGENT_SETUP_INVALID');
});

test('supported CLIs install into the shared app prefix', async (t) => {
  const rootDir = await tmpRoot(t);
  const { calls, spawnProcess } = fakeSpawner(path.join(rootDir, 'prefix'));
  const manager = await createCliSetupManager({ rootDir, spawnProcess }).init();

  assert.equal((await manager.install('codex')).installed, true);
  assert.equal((await manager.install('claude')).installed, true);
  assert.ok(calls.some((call) => call.argv.some((arg) => /@openai\/codex@latest/.test(arg))));
  assert.ok(calls.some((call) => call.argv.some((arg) => /@anthropic-ai\/claude-code@latest/.test(arg))));
});

test('API keys stay provider-scoped and persist outside the public setup config', async (t) => {
  const rootDir = await tmpRoot(t);
  const manager = await createCliSetupManager({ rootDir, baseEnv: { ANTHROPIC_API_KEY: 'inherited', OPENAI_API_KEY: 'inherited' }, verifyClaude: async () => 'unknown' }).init();
  await manager.authenticate('claude', 'api-key', 'sk-ant-private-1234');

  assert.equal(manager.envFor('claude').ANTHROPIC_API_KEY, 'sk-ant-private-1234');
  assert.equal(manager.envFor('claude').OPENAI_API_KEY, undefined);
  assert.equal(manager.envFor('codex').ANTHROPIC_API_KEY, undefined);
  assert.doesNotMatch(await fs.readFile(path.join(rootDir, 'config.json'), 'utf8'), /sk-ant-private-1234/);
  assert.match(await fs.readFile(path.join(rootDir, 'secrets.json'), 'utf8'), /sk-ant-private-1234/);

  const reloaded = await createCliSetupManager({ rootDir }).init();
  assert.equal((await reloaded.status('claude')).keyTail, '1234');
});

test('a rejected or cancelled API-key login leaves no stored key', async (t) => {
  const rootDir = await tmpRoot(t);
  const stored = new Map();
  let releaseWrite;
  const writeHeld = new Promise((resolve) => { releaseWrite = resolve; });
  const secretStore = {
    available: true,
    async get(key) { return stored.get(key) ?? null; },
    async set(key, value) { if (key === 'rhwp.codex.api-key') await writeHeld; stored.set(key, value); return true; },
    async delete(key) { return stored.delete(key); },
  };
  const manager = await createCliSetupManager({
    rootDir, secretStore, homeDir: rootDir, platform: 'linux', baseEnv: {},
    verifyClaude: async ({ apiKey }) => (apiKey === 'sk-ant-rejected' ? 'invalid' : 'valid'),
  }).init();

  await assert.rejects(() => manager.authenticate('claude', 'api-key', 'sk-ant-rejected'), { code: 'AGENT_KEY_INVALID' });
  assert.equal((await manager.status('claude')).authenticated, false);
  assert.equal(stored.has('rhwp.claude.api-key'), false);

  const abort = new AbortController();
  let committed = false;
  const pending = manager.authenticate('codex', 'api-key', 'sk-cancelled', null, {
    signal: abort.signal, onCommitted: () => { committed = true; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  releaseWrite();
  await assert.rejects(pending, { code: 'AGENT_AUTH_CANCELLED' });
  assert.equal(committed, false);
  assert.equal(stored.has('rhwp.codex.api-key'), false);
  assert.equal(manager.envFor('codex').OPENAI_API_KEY, undefined);
  assert.equal((await manager.status('codex')).authMethod, null);
});

test('vault-backed API keys are bounded and never enter fallback files', async (t) => {
  const rootDir = await tmpRoot(t);
  const secretStore = createMemorySecretStore();
  const manager = await createCliSetupManager({ rootDir, secretStore, verifyClaude: async () => 'unknown' }).init();
  await assert.rejects(
    () => manager.authenticate('codex', 'api-key', 'x'.repeat(API_KEY_MAX_BYTES + 1)),
    (error) => error.code === 'AGENT_KEY_INVALID',
  );
  await manager.authenticate('claude', 'api-key', 'anthropic-only');
  await manager.authenticate('codex', 'api-key', 'openai-only');
  assert.equal(await secretStore.get('rhwp.codex.api-key'), 'openai-only');
  await assert.rejects(fs.access(path.join(rootDir, 'secrets.json')), { code: 'ENOENT' });
  assert.doesNotMatch(await fs.readFile(path.join(rootDir, 'config.json'), 'utf8'), /anthropic-only|openai-only/);
  assert.equal(manager.envFor('claude').ANTHROPIC_API_KEY, 'anthropic-only');
  assert.equal(manager.envFor('claude').OPENAI_API_KEY, undefined);
  assert.equal(manager.envFor('codex').OPENAI_API_KEY, 'openai-only');
  assert.equal(manager.envFor('codex').ANTHROPIC_API_KEY, undefined);
});

test('legacy config keys migrate before their public copy is removed', async (t) => {
  const rootDir = await tmpRoot(t);
  await fs.writeFile(path.join(rootDir, 'config.json'), JSON.stringify({
    claude: { key: 'sk-ant-legacy-1234' },
    codex: { key: 'sk-codex-legacy-5678' },
  }));
  const secretStore = createMemorySecretStore();
  await createCliSetupManager({ rootDir, secretStore }).init();

  assert.equal(await secretStore.get('rhwp.claude.api-key'), 'sk-ant-legacy-1234');
  assert.equal(await secretStore.get('rhwp.codex.api-key'), 'sk-codex-legacy-5678');
  const config = await fs.readFile(path.join(rootDir, 'config.json'), 'utf8');
  assert.doesNotMatch(config, /sk-ant-legacy|sk-codex-legacy/);
  assert.match(config, /"keyTail": "1234"/);
  assert.match(config, /"keyTail": "5678"/);
});

test('Codex OAuth always uses device auth and commits only after a successful exit', async (t) => {
  const rootDir = await tmpRoot(t);
  const calls = [];
  let process;
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess(command, argv, options) {
      process = new FakeProcess();
      calls.push({ command, argv, options });
      return process;
    },
  }).init();
  let committed = false;
  const running = manager.authenticate('codex', 'oauth', undefined, undefined, { onCommitted: () => { committed = true; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.at(-1).argv, ['-c', 'cli_auth_credentials_store=file', 'login', '--device-auth']);
  assert.equal(committed, false);
  process.emit('close', 0, null);
  await running;
  assert.equal(committed, true);
});

test('manual auth codes are bounded before reaching the owned CLI', async (t) => {
  const rootDir = await tmpRoot(t);
  let process;
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess() { process = new FakeProcess(); return process; },
  }).init();
  const running = manager.authenticate('codex', 'oauth');
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => manager.submitAuthCode('codex', 'x'.repeat(AUTH_CODE_MAX_BYTES + 1)),
    (error) => error.code === 'AGENT_AUTH_CODE_INVALID',
  );
  await assert.rejects(() => manager.submitAuthCode('pi', 'code'), (error) => error.code === 'AGENT_SETUP_INVALID');
  assert.equal(process.input, '');
  await manager.submitAuthCode('codex', 'device-code');
  assert.equal(process.input, 'device-code\n');
  process.emit('close', 0, null);
  await running;
});

test('cancel stops an in-flight OAuth login', async (t) => {
  const rootDir = await tmpRoot(t);
  let process;
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess() { process = new FakeProcess(); return process; },
  }).init();
  const pending = manager.authenticate('codex', 'oauth');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await manager.cancel('codex'), true);
  await assert.rejects(pending, /로그인/);
  assert.equal(process.killed, true);
});

test('bundled Claude runtime reports a newer registry release as an update', async (t) => {
  const fetchImpl = async (url) => {
    assert.match(String(url), /claude-code\/latest$/);
    return new Response(JSON.stringify({ version: '2.1.282' }), { status: 200 });
  };
  const manager = await createCliSetupManager({ rootDir: await tmpRoot(t), fetchImpl, bundledClaudeVersion: '2.1.241' }).init();

  const before = await manager.status('claude');
  assert.equal(before.version, '2.1.241');
  assert.equal(before.updateRequired, false);

  const after = await manager.automaticUpdate('claude');
  assert.equal(after.latestVersion, '2.1.282');
  assert.equal(after.updateRequired, true);

  // Codex 는 앱이 관리하는 설치본이 없으면 사용자의 CLI 이므로 확인하지 않는다.
  const codex = await manager.automaticUpdate('codex');
  assert.equal(codex.updateRequired, false);
});

test('Codex terminal login streams CLI output and falls back to the PATH binary', async (t) => {
  const launches = [];
  const manager = await createCliSetupManager({
    rootDir: await tmpRoot(t),
    baseEnv: { PATH: '' },
    createTerminal(options) {
      launches.push(options);
      options.onOutput('Enter this one-time code');
      return { done: Promise.resolve({ code: 0 }), cancel: async () => true, snapshot: () => '', write() {}, resize() {} };
    },
  }).init();
  const frames = [];
  await manager.authenticate('codex', 'oauth', undefined, (entry) => frames.push(entry), { terminal: true });
  assert.equal(launches[0].command, 'codex');
  assert.deepEqual(launches[0].argv, ['-c', 'cli_auth_credentials_store=file', 'login', '--device-auth']);
  assert.ok(frames.some((entry) => entry.terminalReady));
  assert.ok(frames.some((entry) => entry.terminalData === 'Enter this one-time code'));
});

test('Codex ChatGPT login in auth.json counts as signed in', async (t) => {
  const codexHome = await tmpRoot(t);
  const manager = await createCliSetupManager({ rootDir: await tmpRoot(t), baseEnv: { CODEX_HOME: codexHome } }).init();
  assert.equal((await manager.status('codex')).authenticated, false);
  await fs.writeFile(path.join(codexHome, 'auth.json'), JSON.stringify({ tokens: { refresh_token: 'r' } }));
  const signedIn = await manager.status('codex');
  assert.equal(signedIn.authenticated, true);
  assert.equal(signedIn.authMethod, 'oauth');
});

test('a CLI that cannot be spawned fails its run instead of crashing the hub', async (t) => {
  const rootDir = await tmpRoot(t);
  let throwSynchronously = false;
  const spawnProcess = () => {
    if (throwSynchronously) throw Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' });
    // Without an 'error' listener, this emit is an uncaught exception that ends the hub.
    const proc = new EventEmitter();
    process.nextTick(() => {
      // A real pre-spawn EACCES leaves no PID and records the negative libuv exit code.
      proc.exitCode = -13;
      proc.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
    });
    return proc;
  };
  const manager = await createCliSetupManager({
    rootDir, spawnProcess, homeDir: rootDir, platform: 'linux', baseEnv: {}, bundledClaudeVersion: '2.1.0',
  }).init();
  const bin = manager.binPath('claude');
  await fs.mkdir(path.dirname(bin), { recursive: true });
  await fs.writeFile(bin, '');

  const status = await manager.status('claude');
  assert.equal(status.installed, true);
  // 관리형 CLI 가 있으면 그것이 실행되므로, 확인에 실패해도 번들 버전으로 바꿔 알리지 않는다.
  assert.equal(status.version, null);
  await assert.rejects(
    () => manager.install('claude'),
    (error) => error.code === 'AGENT_INSTALL_FAILED' && /EACCES/.test(error.message),
  );

  throwSynchronously = true;
  assert.equal((await manager.status('claude')).version, null);
  await assert.rejects(
    () => manager.install('codex'),
    (error) => error.code === 'AGENT_INSTALL_FAILED' && /EMFILE/.test(error.message),
  );
});

test('a transient secret-store failure at startup is retried instead of dropping the API key', async (t) => {
  const rootDir = await tmpRoot(t);
  const stored = new Map([['rhwp.claude.api-key', 'sk-ant-api-retry-1234']]);
  let failures = 1;
  const secretStore = {
    available: true,
    async get(key) {
      if (failures > 0) {
        failures -= 1;
        throw Object.assign(new Error('Secure secret storage did not respond.'), { code: 'SECRET_STORE_TIMEOUT' });
      }
      return stored.get(key) ?? null;
    },
    async set(key, value) { stored.set(key, value); return true; },
    async delete(key) { return stored.delete(key); },
  };
  const manager = await createCliSetupManager({ rootDir, secretStore, homeDir: rootDir, platform: 'linux', baseEnv: {} }).init();
  assert.equal(manager.envFor('claude').ANTHROPIC_API_KEY, undefined);

  const status = await manager.status('claude');
  assert.equal(status.authenticated, true);
  assert.equal(status.authMethod, 'api-key');
  assert.equal(manager.envFor('claude').ANTHROPIC_API_KEY, 'sk-ant-api-retry-1234');
});

test('a failed legacy-key migration keeps the key and does not abort startup', async (t) => {
  const rootDir = await tmpRoot(t);
  const configPath = path.join(rootDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ claude: { key: 'sk-ant-legacy-9999' } }));
  const secretStore = {
    available: true,
    async get() { return null; },
    async set() {
      throw Object.assign(new Error('A Secret Service or KWallet system keyring is required.'), { code: 'SECRET_STORE_FAILED' });
    },
    async delete() { return false; },
  };
  const manager = await createCliSetupManager({ rootDir, secretStore, homeDir: rootDir, platform: 'linux', baseEnv: {} }).init();

  assert.equal(manager.envFor('claude').ANTHROPIC_API_KEY, 'sk-ant-legacy-9999');
  assert.match(await fs.readFile(configPath, 'utf8'), /sk-ant-legacy-9999/);
  assert.equal((await manager.status('claude')).authMethod, 'api-key');
});

test('an expired terminal Claude login is not reported as usable, even with a refresh token', async (t) => {
  // Sessions receive the access token directly, and refreshing it would write
  // to the user's own Claude profile. The app asks for its own login instead.
  const homeDir = await tmpRoot(t);
  let clock = Date.now();
  const manager = await createCliSetupManager({ rootDir: await tmpRoot(t), homeDir, platform: 'linux', baseEnv: {}, now: () => clock }).init();
  const credentialFile = path.join(homeDir, '.claude', '.credentials.json');
  await fs.mkdir(path.dirname(credentialFile), { recursive: true });

  await fs.writeFile(credentialFile, JSON.stringify({ claudeAiOauth: { accessToken: 'access', refreshToken: 'refresh', expiresAt: clock + 3_600_000 } }));
  const live = await manager.status('claude');
  assert.equal(live.authenticated, true);
  assert.equal(live.authSource, 'local');

  await fs.writeFile(credentialFile, JSON.stringify({ claudeAiOauth: { accessToken: 'access', refreshToken: 'refresh', expiresAt: clock - 60_000 } }));
  // A recent terminal login is reused for a while; the next re-read sees the expiry.
  clock += 16 * 60_000;
  const expired = await manager.status('claude');
  assert.equal(expired.authenticated, false);
  assert.equal(expired.authMethod, null);
});

test('installs share the prefix one at a time and report installing until they finish', async (t) => {
  const rootDir = await tmpRoot(t);
  const { calls, spawnProcess: spawnFake } = fakeSpawner(path.join(rootDir, 'prefix'));
  let active = 0;
  let peak = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const spawnProcess = (command, argv, options) => {
    if (!argv.includes('install')) return spawnFake(command, argv, options);
    active += 1;
    peak = Math.max(peak, active);
    const proc = new FakeProcess();
    void gate.then(() => spawnFake(command, argv, options).once('close', (code) => {
      active -= 1;
      proc.emit('close', code, null);
    }));
    return proc;
  };
  const manager = await createCliSetupManager({ rootDir, spawnProcess }).init();

  const codex = manager.install('codex');
  const claude = manager.install('claude');
  const duplicate = manager.install('codex');
  assert.equal((await manager.status('claude')).installing, true);
  release();
  const [codexDone, claudeDone] = await Promise.all([codex, claude, duplicate]);
  assert.equal(peak, 1);
  assert.equal(calls.filter((call) => call.argv.includes('install')).length, 2);
  assert.equal(codexDone.installing, false);
  assert.equal(claudeDone.installing, false);
});

test('provider launch waits while npm replaces a managed executable', async (t) => {
  const rootDir = await tmpRoot(t);
  const { spawnProcess: spawnFake } = fakeSpawner(path.join(rootDir, 'prefix'));
  let releaseInstall;
  const gate = new Promise((resolve) => { releaseInstall = resolve; });
  t.after(() => releaseInstall());
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess(command, argv, options) {
      if (!argv.includes('install')) return spawnFake(command, argv, options);
      const process = new FakeProcess();
      void gate.then(() => spawnFake(command, argv, options).once('close', (code) => process.emit('close', code, null)));
      return process;
    },
  }).init();
  const installation = manager.install('claude');
  let prepared = false;
  const preparing = manager.prepareLaunch('claude').then((launch) => { prepared = true; return launch; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prepared, false, 'launch must not use the transient missing .bin target');
  releaseInstall();
  await installation;
  const launch = await preparing;
  assert.equal(launch.bin, manager.binPath('claude'));
  launch.release();
});

test('npm cannot replace the prefix between launch reservation and synchronous spawn', async (t) => {
  const rootDir = await tmpRoot(t);
  const { calls, spawnProcess } = fakeSpawner(path.join(rootDir, 'prefix'));
  const manager = await createCliSetupManager({ rootDir, spawnProcess }).init();
  const launch = await manager.prepareLaunch('claude');
  t.after(() => launch.release());
  const installing = manager.install('codex');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call.argv.includes('install')).length, 0);
  launch.release();
  launch.release();
  assert.equal((await installing).installed, true);
  assert.equal(calls.filter((call) => call.argv.includes('install')).length, 1);
});

test('an installer timeout quarantines the prefix when its process tree cannot be stopped', async (t) => {
  const rootDir = await tmpRoot(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let installs = 0;
  let installerStarted;
  const started = new Promise((resolve) => { installerStarted = resolve; });
  const manager = await createCliSetupManager({
    rootDir, baseEnv: {}, readClaudeLogin: async () => null,
    spawnProcess() {
      installs += 1;
      installerStarted();
      const process = new FakeProcess();
      if (installs === 1) process.kill = () => true;
      else queueMicrotask(() => process.emit('close', 0, null));
      return process;
    },
  }).init();
  const first = manager.install('claude').catch((error) => error);
  const second = manager.install('codex').catch((error) => error);
  await started;
  assert.equal(installs, 1);
  t.mock.timers.tick(10 * 60_000);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(4_000);
  await new Promise((resolve) => setImmediate(resolve));
  const firstResult = await first;
  const secondResult = await second;
  assert.equal(installs, 1, 'another npm process must not mutate a prefix still owned by the timed-out installer');
  assert.equal(firstResult.code, 'AGENT_INSTALL_CLEANUP_UNCERTAIN');
  assert.equal(secondResult.code, 'AGENT_INSTALL_CLEANUP_UNCERTAIN');
  await assert.rejects(() => manager.prepareLaunch('claude'), { code: 'AGENT_INSTALL_CLEANUP_UNCERTAIN' });
});

test('on Windows an app-installed Codex is checked and signed in as a hidden codex.exe, never through its Node wrapper', async (t) => {
  const rootDir = await tmpRoot(t);
  const modules = path.join(rootDir, 'prefix', 'node_modules');
  const codexPackage = path.join(modules, '@openai', 'codex');
  await fs.mkdir(path.join(codexPackage, 'bin'), { recursive: true });
  await fs.writeFile(path.join(codexPackage, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
  await fs.writeFile(path.join(codexPackage, 'bin', 'codex.js'), '');
  const [platformPackage, triple] = process.arch === 'arm64'
    ? ['codex-win32-arm64', 'aarch64-pc-windows-msvc']
    : ['codex-win32-x64', 'x86_64-pc-windows-msvc'];
  const exePath = path.join(modules, '@openai', platformPackage, 'vendor', triple, 'bin', 'codex.exe');
  await fs.mkdir(path.dirname(exePath), { recursive: true });
  await fs.writeFile(exePath, '');
  await fs.mkdir(path.join(modules, '.bin'), { recursive: true });
  await fs.writeFile(path.join(modules, '.bin', 'codex.cmd'),
    '@ECHO off\r\nSET "_prog=node"\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\@openai\\codex\\bin\\codex.js" %*\r\n');
  const calls = [];
  const spawnProcess = (command, argv, options) => {
    const proc = new FakeProcess();
    calls.push({ command, argv, options, proc });
    if (argv.includes('--version')) queueMicrotask(() => { proc.stdout.emit('data', 'codex-cli 0.163.0\n'); proc.emit('close', 0, null); });
    return proc;
  };
  const manager = await createCliSetupManager({ rootDir, spawnProcess, platform: 'win32', fetchImpl: async () => new Response('{}') }).init();

  assert.equal((await manager.status('codex')).version, '0.163.0');
  const login = manager.authenticate('codex', 'oauth');
  await new Promise((resolve) => setImmediate(resolve));
  calls.at(-1).proc.emit('close', 1, null);
  await assert.rejects(login, (error) => error.code === 'AGENT_AUTH_FAILED');

  assert.deepEqual(calls.map((call) => call.argv), [['--version'], ['-c', 'cli_auth_credentials_store=file', 'login', '--device-auth']]);
  for (const call of calls) {
    assert.equal(call.command, path.resolve(exePath));
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.env.CODEX_MANAGED_BY_NPM, '1');
  }
});

test('Codex version output is parsed to its semantic version', async (t) => {
  const rootDir = await tmpRoot(t);
  const binDir = path.join(rootDir, 'prefix', 'node_modules', '.bin');
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, 'codex'), '');
  const spawnProcess = () => {
    const proc = new FakeProcess();
    queueMicrotask(() => { proc.stdout.emit('data', 'codex-cli 0.159.0\n'); proc.emit('close', 0, null); });
    return proc;
  };
  const fetchImpl = async () => new Response(JSON.stringify({ version: '0.159.0' }), { status: 200 });
  const manager = await createCliSetupManager({ rootDir, spawnProcess, fetchImpl, platform: 'linux' }).init();

  const status = await manager.automaticUpdate('codex');
  assert.equal(status.version, '0.159.0');
  assert.equal(status.updateRequired, false);
});

/** 설치하면 버전이 바뀌는 가짜 npm/CLI. --version 실행 횟수와 npm 캐시 폴더를 기록한다. */
function versionedCli(rootDir, platform = process.platform) {
  const prefixDir = path.join(rootDir, 'prefix');
  const state = { installed: null, nextVersion: '1.0.0', installCode: 0, failVersion: false, versionRuns: 0, cacheDirs: [] };
  const binFile = path.join(prefixDir, 'node_modules', '.bin', platform === 'win32' ? 'claude.cmd' : 'claude');
  async function writeInstall(version) {
    const packageDir = path.join(prefixDir, 'node_modules', '@anthropic-ai', 'claude-code');
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version }));
    await fs.mkdir(path.dirname(binFile), { recursive: true });
    await fs.writeFile(binFile, `rem ${version}\n`);
    state.installed = version;
  }
  const spawnProcess = (command, argv) => {
    const proc = new FakeProcess();
    state.calls = [...(state.calls ?? []), argv];
    queueMicrotask(async () => {
      if (argv.includes('install')) {
        // 진짜 npm 처럼 --cache 폴더에 tarball 을 남긴다.
        const cacheDir = argv[argv.indexOf('--cache') + 1];
        state.cacheDirs.push(cacheDir);
        await fs.mkdir(path.join(cacheDir, '_cacache', 'content-v2'), { recursive: true });
        await fs.writeFile(path.join(cacheDir, '_cacache', 'content-v2', 'tarball'), 'x'.repeat(4096));
        await state.beforeInstall?.();
        if (state.installCode === 0) await writeInstall(state.nextVersion);
        else proc.stderr.emit('data', 'npm ERR! network\n');
        proc.emit('close', state.installCode, null);
        return;
      }
      if (argv.includes('--version')) {
        state.versionRuns += 1;
        // true 면 계속, 숫자면 그 횟수만큼 실패한다.
        if (state.failVersion) {
          if (typeof state.failVersion === 'number') state.failVersion -= 1;
          proc.stderr.emit('data', 'spawn UNKNOWN\n');
          proc.emit('close', 1, null);
          return;
        }
        proc.stdout.emit('data', `${state.installed} (Claude Code)\n`);
        proc.emit('close', 0, null);
        return;
      }
      proc.emit('close', 0, null);
    });
    return proc;
  };
  return { state, spawnProcess, writeInstall };
}

function versionedManager(rootDir, cli, options = {}) {
  return createCliSetupManager({
    rootDir,
    spawnProcess: cli.spawnProcess,
    baseEnv: { CODEX_HOME: path.join(rootDir, 'codex-home') },
    readClaudeLogin: async () => null,
    verifyClaude: async () => 'unknown',
    fetchImpl: async () => { throw new Error('offline'); },
    ...options,
  }).init();
}

test('status reuses the managed CLI version until the installed files change', async (t) => {
  const rootDir = await tmpRoot(t);
  const cli = versionedCli(rootDir);
  const manager = await versionedManager(rootDir, cli);

  assert.equal((await manager.install('claude')).version, '1.0.0');
  const runsAfterInstall = cli.state.versionRuns;
  // 메시지마다·Studio 연결마다 부르는 상태 확인은 CLI 를 다시 띄우지 않는다. 동시에 들어온 확인도 한 번만 띄운다.
  for (let i = 0; i < 5; i += 1) assert.equal((await manager.status('claude')).version, '1.0.0');
  await Promise.all([manager.status('claude'), manager.status('claude')]);
  assert.equal(cli.state.versionRuns, runsAfterInstall);

  // 앱 밖에서 설치 파일이 바뀌면(크기·수정 시각) 다시 확인해 새 버전을 보여 준다.
  await cli.writeInstall('1.0.10');
  assert.equal((await manager.status('claude')).version, '1.0.10');
  assert.equal(cli.state.versionRuns, runsAfterInstall + 1);

  // 앱의 업데이트는 끝나자마자 새 버전을 알린다.
  cli.state.nextVersion = '2.0.0';
  assert.equal((await manager.install('claude')).version, '2.0.0');
  assert.equal((await manager.status('claude')).version, '2.0.0');
});

test('a concurrent status check during an install never keeps the pre-install version', async (t) => {
  const rootDir = await tmpRoot(t);
  const cli = versionedCli(rootDir);
  const manager = await versionedManager(rootDir, cli);
  await manager.install('claude');
  cli.state.nextVersion = '3.0.0';
  const [during, installed] = await Promise.all([manager.status('claude'), manager.install('claude')]);
  assert.equal(during.version, '1.0.0');
  assert.equal(installed.version, '3.0.0');
  assert.equal((await manager.status('claude')).version, '3.0.0');
});

test('a failed version probe is retried on the next status check', async (t) => {
  const rootDir = await tmpRoot(t);
  const cli = versionedCli(rootDir);
  await cli.writeInstall('1.0.0');
  cli.state.failVersion = true;
  const manager = await versionedManager(rootDir, cli);

  const failed = await manager.status('claude');
  assert.equal(failed.installed, true);
  assert.notEqual(failed.version, '1.0.0');
  cli.state.failVersion = false;
  assert.equal((await manager.status('claude')).version, '1.0.0');
});

test('a login completed mid-session is seen by the next status check without probing the CLI again', async (t) => {
  const rootDir = await tmpRoot(t);
  const codexHome = path.join(rootDir, 'codex-home');
  const cli = versionedCli(rootDir);
  await cli.writeInstall('1.0.0');
  const manager = await versionedManager(rootDir, cli);

  assert.equal((await manager.status('claude')).authenticated, false);
  assert.equal((await manager.status('codex')).authenticated, false);
  await manager.authenticate('claude', 'api-key', 'sk-ant-test-key');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'auth.json'), JSON.stringify({ tokens: { refresh_token: 'r' } }));
  const runs = cli.state.versionRuns;

  assert.equal((await manager.status('claude')).authenticated, true);
  assert.equal((await manager.status('codex')).authenticated, true);
  assert.equal(cli.state.versionRuns, runs);
});

test('installs keep no npm download cache, whether they succeed or fail', async (t) => {
  const rootDir = await tmpRoot(t);
  const cli = versionedCli(rootDir);
  const manager = await versionedManager(rootDir, cli);

  assert.equal((await manager.install('claude')).version, '1.0.0');
  cli.state.installCode = 1;
  cli.state.nextVersion = '2.0.0';
  await assert.rejects(manager.install('claude'), (error) => error.code === 'AGENT_INSTALL_FAILED');
  // 실패한 업데이트는 설치된 CLI 를 그대로 둔다.
  assert.equal((await manager.status('claude')).version, '1.0.0');

  assert.equal(new Set(cli.state.cacheDirs).size, 2);
  for (const cacheDir of cli.state.cacheDirs) {
    assert.ok(path.resolve(cacheDir).startsWith(path.resolve(rootDir) + path.sep), 'npm cache stays inside the app folder');
    await assert.rejects(fs.stat(cacheDir), { code: 'ENOENT' });
  }
});

test('startup removes the old shared npm cache and abandoned install caches but keeps a recent one', async (t) => {
  const rootDir = await tmpRoot(t);
  const nowMs = 1_800_000_000_000;
  const legacy = path.join(rootDir, 'npm-cache', '_cacache', 'content-v2');
  const abandoned = path.join(rootDir, 'npm-cache-runs', `${nowMs - 60 * 60 * 1000}-old`);
  const recent = path.join(rootDir, 'npm-cache-runs', `${nowMs - 60 * 1000}-running`);
  for (const dir of [legacy, abandoned, recent]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'tarball'), 'x');
  }
  await createCliSetupManager({ rootDir, now: () => nowMs, readClaudeLogin: async () => null }).init();

  await assert.rejects(fs.stat(path.join(rootDir, 'npm-cache')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(abandoned), { code: 'ENOENT' });
  assert.ok((await fs.stat(path.join(recent, 'tarball'))).isFile(), 'another hub may still be installing with it');
});

test('install confirms the new CLI version before reporting completion', async (t) => {
  const rootDir = await tmpRoot(t);
  const cli = versionedCli(rootDir);
  const manager = await versionedManager(rootDir, cli);
  await manager.install('claude');
  cli.state.nextVersion = '2.0.0';
  let probesAtDone = 0;
  const before = cli.state.versionRuns;
  const installed = await manager.install('claude', ({ state }) => {
    if (state === 'done') probesAtDone = cli.state.versionRuns;
  });
  assert.equal(installed.version, '2.0.0');
  assert.ok(probesAtDone > before, 'completion must follow the new binary probe');
});


test('status keeps the installed version while npm temporarily removes the binary', async (t) => {
  const rootDir = await tmpRoot(t);
  const cli = versionedCli(rootDir);
  const manager = await versionedManager(rootDir, cli);
  await manager.install('claude');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let removed;
  const ready = new Promise(resolve => { removed = resolve; });
  cli.state.beforeInstall = async () => {
    await fs.rm(manager.binPath('claude'));
    removed();
    await gate;
  };
  cli.state.nextVersion = '2.0.0';
  const installing = manager.install('claude');
  try {
    await ready;
    const during = await manager.status('claude');
    assert.equal(during.installing, true);
    assert.equal(during.installed, true);
    assert.equal(during.version, '1.0.0');
  } finally { release(); await installing; }
  assert.equal((await manager.status('claude')).version, '2.0.0');
});

/**
 * 사용자 npm 설정을 따르는 가짜 npm. 진짜 npm 처럼 명령줄 값이 npm_config_* 환경 변수보다 우선한다.
 * ignore-scripts·omit=optional 이면 플랫폼 바이너리 없이 실행되지 않는 자리표시 파일만 남기고,
 * save=false 면 package.json 을 갱신하지 않아 다음 설치가 목록에 없는 패키지를 지운다(prune).
 */
function npmConfigAwareCli(rootDir) {
  const prefixDir = path.join(rootDir, 'prefix');
  const modules = path.join(prefixDir, 'node_modules');
  const manifestFile = path.join(prefixDir, 'package.json');
  const binFile = (name) => path.join(modules, '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
  const installs = [];
  const setting = (argv, env, name) => {
    const arg = argv.find((value) => value === `--${name}` || value.startsWith(`--${name}=`));
    if (arg) return arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : 'true';
    return env?.[`npm_config_${name.replace(/-/g, '_')}`];
  };
  const spawnProcess = (command, argv, options) => {
    const proc = new FakeProcess();
    queueMicrotask(async () => {
      if (argv.includes('install')) {
        installs.push(argv);
        const packageName = argv.at(-1).replace(/@latest$/, '');
        const env = options.env;
        const runsScripts = setting(argv, env, 'ignore-scripts') !== 'true';
        const optional = (setting(argv, env, 'include') ?? '').includes('optional')
          || !(setting(argv, env, 'omit') ?? '').includes('optional');
        const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8').catch(() => '{}'));
        const dependencies = { ...manifest.dependencies };
        if (setting(argv, env, 'save') !== 'false') {
          dependencies[packageName] = '^1.2.3';
          await fs.mkdir(prefixDir, { recursive: true });
          await fs.writeFile(manifestFile, JSON.stringify({ dependencies }));
        }
        for (const other of ['@anthropic-ai/claude-code', '@openai/codex']) {
          if (other === packageName || dependencies[other]) continue;
          await fs.rm(path.join(modules, ...other.split('/')), { recursive: true, force: true });
          await fs.rm(binFile(packageBinName(other)), { force: true });
        }
        const packageDir = path.join(modules, ...packageName.split('/'));
        await fs.mkdir(packageDir, { recursive: true });
        await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: packageName, version: '1.2.3' }));
        const bin = binFile(packageBinName(packageName));
        await fs.mkdir(path.dirname(bin), { recursive: true });
        await fs.writeFile(bin, runsScripts && optional ? 'rem runnable\n' : 'rem placeholder\n');
        proc.emit('close', 0, null);
        return;
      }
      if (argv.includes('--version')) {
        const name = path.basename(String(command)).replace(/\.(?:cmd|exe)$/i, '');
        const text = await fs.readFile(binFile(name), 'utf8').catch(() => '');
        if (text.includes('runnable')) {
          proc.stdout.emit('data', `${name} 1.2.3\n`);
          proc.emit('close', 0, null);
        } else {
          proc.stderr.emit('data', 'Error: Missing optional dependency\n');
          proc.emit('close', 1, null);
        }
        return;
      }
      proc.emit('close', 0, null);
    });
    return proc;
  };
  return { spawnProcess, installs };
}

test('a user npm config that skips scripts, optional packages or saving still installs runnable CLIs side by side', async (t) => {
  const rootDir = await tmpRoot(t);
  const cli = npmConfigAwareCli(rootDir);
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess: cli.spawnProcess,
    baseEnv: {
      npm_config_ignore_scripts: 'true', npm_config_omit: 'optional', npm_config_save: 'false',
      CODEX_HOME: path.join(rootDir, 'codex-home'),
    },
    readClaudeLogin: async () => null,
    fetchImpl: async () => { throw new Error('offline'); },
  }).init();

  const claude = await manager.install('claude');
  assert.equal(claude.installed, true);
  assert.equal(claude.version, '1.2.3');
  const codex = await manager.install('codex');
  assert.equal(codex.installed, true);
  assert.equal(codex.version, '1.2.3');
  const after = await manager.status('claude');
  assert.equal(after.installed, true, 'installing Codex must not prune the Claude CLI');
  assert.equal(after.version, '1.2.3');
  assert.equal(cli.installs.length, 2);
});

test('installing one CLI keeps another that an older build installed without saving it to the prefix package.json', async (t) => {
  const rootDir = await tmpRoot(t);
  const cli = npmConfigAwareCli(rootDir);
  const prefixDir = path.join(rootDir, 'prefix');
  // 예전 빌드(--save 없음, 사용자 save=false)가 남긴 prefix: Claude 는 설치됐지만 package.json 에는 없다.
  const claudeDir = path.join(prefixDir, 'node_modules', '@anthropic-ai', 'claude-code');
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(path.join(claudeDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.3' }));
  const claudeBin = path.join(prefixDir, 'node_modules', '.bin', process.platform === 'win32' ? 'claude.cmd' : 'claude');
  await fs.mkdir(path.dirname(claudeBin), { recursive: true });
  await fs.writeFile(claudeBin, 'rem runnable\n');
  await fs.writeFile(path.join(prefixDir, 'package.json'), JSON.stringify({ name: 'prefix', dependencies: {} }));
  const manager = await createCliSetupManager({
    rootDir,
    spawnProcess: cli.spawnProcess,
    baseEnv: { CODEX_HOME: path.join(rootDir, 'codex-home') },
    readClaudeLogin: async () => null,
    fetchImpl: async () => { throw new Error('offline'); },
  }).init();

  assert.equal((await manager.install('codex')).installed, true);
  const claude = await manager.status('claude');
  assert.equal(claude.installed, true, 'installing Codex must not prune the Claude CLI');
  const manifest = JSON.parse(await fs.readFile(path.join(prefixDir, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['@anthropic-ai/claude-code'], '^2.1.3');
  assert.ok(manifest.dependencies['@openai/codex']);
});

test('a Windows Claude shim left behind after npm removed its package reads as not installed and is not launched', async (t) => {
  const rootDir = await tmpRoot(t);
  const binDir = path.join(rootDir, 'prefix', 'node_modules', '.bin');
  await fs.mkdir(binDir, { recursive: true });
  // npm 11 cmd-shim for Claude Code's native claude.exe; the package folder itself is gone.
  await fs.writeFile(path.join(binDir, 'claude.cmd'), [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
    '"%dp0%\\..\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*', '',
  ].join('\r\n'));
  const { spawnProcess } = fakeSpawner(path.join(rootDir, 'prefix'), 'win32');
  const manager = await createCliSetupManager({
    rootDir, spawnProcess, platform: 'win32', readClaudeLogin: async () => null,
    fetchImpl: async () => { throw new Error('offline'); },
  }).init();

  const status = await manager.status('claude');
  assert.equal(status.installed, false);
  const launch = await manager.prepareLaunch('claude');
  t.after(() => launch.release());
  assert.equal(launch.bin, null);
});

test('npm finishing without a runnable CLI fails the install instead of reporting it installed', async (t) => {
  const rootDir = await tmpRoot(t);
  const cli = versionedCli(rootDir);
  const manager = await versionedManager(rootDir, cli);
  cli.state.failVersion = true;

  await assert.rejects(manager.install('claude'), (error) => error.code === 'AGENT_INSTALL_FAILED' && /spawn UNKNOWN/.test(error.detail));
  const failed = await manager.status('claude');
  assert.equal(failed.installed, false);
  assert.equal(failed.version, null);
  assert.equal(failed.updateRequired, false);

  // 설정을 고쳐 다시 설치하면 정상으로 돌아온다.
  cli.state.failVersion = false;
  cli.state.nextVersion = '1.0.1';
  const fixed = await manager.install('claude');
  assert.equal(fixed.installed, true);
  assert.equal(fixed.version, '1.0.1');
});

test('a managed CLI whose version check fails is not reported as the bundled runtime or as outdated', async (t) => {
  const rootDir = await tmpRoot(t);
  const cli = versionedCli(rootDir);
  cli.state.nextVersion = '2.1.311';
  const options = {
    bundledClaudeVersion: '2.1.241',
    fetchImpl: async () => new Response(JSON.stringify({ version: '2.1.311' }), { status: 200 }),
  };
  const manager = await versionedManager(rootDir, cli, options);
  assert.equal((await manager.install('claude')).version, '2.1.311');
  assert.equal((await manager.automaticUpdate('claude')).updateRequired, false);

  // 파일 지문이 바뀐 뒤(백신 검사·외부 갱신) 확인이 실패해도 마지막으로 확인한 버전을 유지한다.
  const later = new Date(Date.now() + 60_000);
  await fs.utimes(manager.binPath('claude'), later, later);
  cli.state.failVersion = true;
  const status = await manager.status('claude');
  assert.equal(status.installed, true);
  assert.equal(status.version, '2.1.311');
  assert.equal(status.updateRequired, false);

  // 확인한 적 없는 새 허브도 실행 파일이 있으면 번들 버전을 내세우지 않는다.
  const fresh = await versionedManager(rootDir, cli, options);
  const freshStatus = await fresh.status('claude');
  assert.equal(freshStatus.installed, true);
  assert.equal(freshStatus.version, null);
  assert.equal(freshStatus.updateRequired, false);

  // 한 번만 실패하는 확인은 같은 상태 확인 안에서 다시 실행해 바로 버전을 얻는다.
  cli.state.failVersion = 1;
  const retried = await fresh.status('claude');
  assert.equal(retried.version, '2.1.311');
});

test('a failed update started from Settings does not fail an unrelated provider launch', async (t) => {
  const rootDir = await tmpRoot(t);
  const cli = versionedCli(rootDir);
  const manager = await versionedManager(rootDir, cli);
  await manager.install('claude');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  cli.state.beforeInstall = () => gate;
  cli.state.installCode = 1;
  const updating = manager.install('claude').catch((error) => error);
  await new Promise((resolve) => setImmediate(resolve));
  const preparing = manager.prepareLaunch('claude');
  release();
  assert.equal((await updating).code, 'AGENT_INSTALL_FAILED');
  const launch = await preparing;
  assert.equal(launch.bin, manager.binPath('claude'));
  launch.release();
});

test('a Claude credential file caught mid-rewrite keeps the terminal login until it is really gone', async (t) => {
  const homeDir = await tmpRoot(t);
  const manager = await createCliSetupManager({ rootDir: await tmpRoot(t), homeDir, platform: 'linux', baseEnv: {} }).init();
  const credentialFile = path.join(homeDir, '.claude', '.credentials.json');
  await fs.mkdir(path.dirname(credentialFile), { recursive: true });
  const live = JSON.stringify({ claudeAiOauth: { accessToken: 'access', expiresAt: Date.now() + 3_600_000 } });
  await fs.writeFile(credentialFile, live);
  assert.equal((await manager.status('claude')).authSource, 'local');

  // Claude Code 가 파일을 비우고 다시 쓰는 순간이나 쓰다 만 JSON 을 읽어도 로그인은 그대로다.
  for (const partial of ['', '{"claudeAiOauth":{"accessTo']) {
    await fs.writeFile(credentialFile, partial);
    await manager.refreshAuth('claude');
    const during = await manager.authStatus('claude');
    assert.equal(during.authenticated, true, JSON.stringify(partial));
    assert.equal(during.authSource, 'local');
  }

  // 토큰이 없는 파일과 지워진 파일은 로그아웃이다.
  await fs.writeFile(credentialFile, '{}');
  await manager.refreshAuth('claude');
  assert.equal((await manager.authStatus('claude')).authenticated, false);
  await fs.writeFile(credentialFile, live);
  await manager.refreshAuth('claude');
  assert.equal((await manager.authStatus('claude')).authenticated, true);
  await fs.rm(credentialFile);
  await manager.refreshAuth('claude');
  assert.equal((await manager.authStatus('claude')).authenticated, false);
});

test('a Claude login reader that throws once (file lock) does not sign the user out', async (t) => {
  let fail = false;
  const manager = await createCliSetupManager({
    rootDir: await tmpRoot(t), platform: 'linux', baseEnv: {},
    readClaudeLogin: async () => {
      if (fail) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return { source: 'file', text: JSON.stringify({ claudeAiOauth: { accessToken: 'access', expiresAt: Date.now() + 3_600_000 } }) };
    },
  }).init();
  assert.equal((await manager.authStatus('claude')).authenticated, true);
  fail = true;
  await manager.refreshAuth('claude');
  assert.equal((await manager.authStatus('claude')).authenticated, true);
  assert.equal(manager.envFor('claude').CLAUDE_CODE_OAUTH_TOKEN, 'access');
});

test('a Codex auth.json caught empty or half-written while Codex rewrites it still counts as signed in', async (t) => {
  const codexHome = await tmpRoot(t);
  const authFile = path.join(codexHome, 'auth.json');
  const signedIn = JSON.stringify({ tokens: { refresh_token: 'r' } });
  let clock = 1_800_000_000_000;
  let sleeps = 0;
  let duringSleep = null;
  const manager = await createCliSetupManager({
    rootDir: await tmpRoot(t),
    baseEnv: { CODEX_HOME: codexHome },
    now: () => clock,
    sleep: async () => { sleeps += 1; await duringSleep?.(); },
  }).init();

  // 파일이 없으면 기다리지 않고 곧바로 로그아웃으로 본다.
  assert.equal((await manager.authStatus('codex')).authenticated, false);
  assert.equal(sleeps, 0);

  // 빈 파일이 잠시 뒤 채워지면 로그인으로 본다.
  await fs.writeFile(authFile, '');
  duringSleep = () => fs.writeFile(authFile, signedIn);
  assert.equal((await manager.authStatus('codex')).authenticated, true);
  assert.equal(sleeps, 1);

  // 다시 읽어도 깨져 있으면 방금 확인한 로그인을 잠시 유지한다.
  duringSleep = null;
  await fs.writeFile(authFile, '{"tokens":');
  assert.equal((await manager.authStatus('codex')).authenticated, true);
  // 유예 시간이 지나도 계속 깨져 있으면 더는 로그인으로 보지 않는다.
  clock += 5 * 60_000;
  assert.equal((await manager.authStatus('codex')).authenticated, false);

  await fs.writeFile(authFile, signedIn);
  assert.equal((await manager.authStatus('codex')).authenticated, true);
  await fs.rm(authFile);
  assert.equal((await manager.authStatus('codex')).authenticated, false);
});

test('a proxy 403 during verification keeps the stored Claude app token; an Anthropic 401 drops it', async (t) => {
  const TOKEN = `sk-ant-oat01-${'AbCd_-xy9'.repeat(12)}`;
  const secretStore = createMemorySecretStore({ 'rhwp.claude.oauth-token': TOKEN });
  let reply = () => new Response('<html>Forbidden by proxy</html>', { status: 403, headers: { 'content-type': 'text/html' } });
  const manager = await createCliSetupManager({
    rootDir: await tmpRoot(t), platform: 'linux', baseEnv: {}, secretStore,
    readClaudeLogin: async () => null,
    fetchImpl: async () => reply(),
  }).init();
  assert.equal((await manager.status('claude')).authSource, 'app');

  assert.equal(await manager.verifyAuth('claude', { force: true }), 'unknown');
  assert.equal(await secretStore.get('rhwp.claude.oauth-token'), TOKEN);
  assert.equal(manager.envFor('claude').CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.equal((await manager.status('claude')).authSource, 'app');

  reply = () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid token' } }), { status: 401 });
  assert.equal(await manager.verifyAuth('claude', { force: true }), 'invalid');
  assert.equal(await secretStore.get('rhwp.claude.oauth-token'), null);
  assert.equal((await manager.status('claude')).authenticated, false);
});
