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
  const manager = await createCliSetupManager({ rootDir, baseEnv: { ANTHROPIC_API_KEY: 'inherited', OPENAI_API_KEY: 'inherited' } }).init();
  await manager.authenticate('claude', 'api-key', 'sk-ant-private-1234');

  assert.equal(manager.envFor('claude').ANTHROPIC_API_KEY, 'sk-ant-private-1234');
  assert.equal(manager.envFor('claude').OPENAI_API_KEY, undefined);
  assert.equal(manager.envFor('codex').ANTHROPIC_API_KEY, undefined);
  assert.doesNotMatch(await fs.readFile(path.join(rootDir, 'config.json'), 'utf8'), /sk-ant-private-1234/);
  assert.match(await fs.readFile(path.join(rootDir, 'secrets.json'), 'utf8'), /sk-ant-private-1234/);

  const reloaded = await createCliSetupManager({ rootDir }).init();
  assert.equal((await reloaded.status('claude')).keyTail, '1234');
});

test('vault-backed API keys are bounded and never enter fallback files', async (t) => {
  const rootDir = await tmpRoot(t);
  const secretStore = createMemorySecretStore();
  const manager = await createCliSetupManager({ rootDir, secretStore }).init();
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
  assert.deepEqual(calls.at(-1).argv, ['login', '--device-auth']);
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
    createTerminal(options) {
      launches.push(options);
      options.onOutput('Enter this one-time code');
      return { done: Promise.resolve({ code: 0 }), cancel: async () => true, snapshot: () => '', write() {}, resize() {} };
    },
  }).init();
  const frames = [];
  await manager.authenticate('codex', 'oauth', undefined, (entry) => frames.push(entry), { terminal: true });
  assert.equal(launches[0].command, 'codex');
  assert.deepEqual(launches[0].argv, ['login', '--device-auth']);
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
    process.nextTick(() => proc.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })));
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
  assert.equal(status.version, '2.1.0');
  await assert.rejects(
    () => manager.install('claude'),
    (error) => error.code === 'AGENT_INSTALL_FAILED' && /EACCES/.test(error.message),
  );

  throwSynchronously = true;
  assert.equal((await manager.status('claude')).version, '2.1.0');
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

test('an expired Claude access token counts as signed in only while a refresh token exists', async (t) => {
  const homeDir = await tmpRoot(t);
  const manager = await createCliSetupManager({ rootDir: await tmpRoot(t), homeDir, platform: 'linux', baseEnv: {} }).init();
  const credentialFile = path.join(homeDir, '.claude', '.credentials.json');
  await fs.mkdir(path.dirname(credentialFile), { recursive: true });
  const expiresAt = Date.now() - 60_000;

  await fs.writeFile(credentialFile, JSON.stringify({ claudeAiOauth: { accessToken: 'access', refreshToken: 'refresh', expiresAt } }));
  const refreshable = await manager.status('claude');
  assert.equal(refreshable.authenticated, true);
  assert.equal(refreshable.authMethod, 'oauth');

  await fs.writeFile(credentialFile, JSON.stringify({ claudeAiOauth: { accessToken: 'access', expiresAt } }));
  const expired = await manager.status('claude');
  assert.equal(expired.authenticated, false);
  assert.equal(expired.authMethod, null);
});
