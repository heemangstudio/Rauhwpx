import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CLAUDE_AUTH_ENV_KEYS, createCliSetupManager } from '../cli-setup-manager.mjs';
import { parseClaudeSetupTokenOutput } from '../claude-credentials.mjs';
import { createMemorySecretStore } from '../secret-store.mjs';

const TOKEN = `sk-ant-oat01-${'AbCd_-xy9'.repeat(12)}`;
const POLLUTED_ENV = {
  PATH: '/usr/bin',
  ANTHROPIC_API_KEY: 'sk-ant-api03-shell',
  ANTHROPIC_AUTH_TOKEN: 'shell-token',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-shellshellshellshellshell',
  CLAUDE_CODE_USE_BEDROCK: '1',
};

/** What Claude Code draws: cursor moves for spaces and a hard-wrapped token. */
function setupTokenScreen(token, cols = 40) {
  let text = '\x1b[32m✓\x1b[1CLong-lived\x1b[1Cauthentication\x1b[1Ctoken\x1b[1Ccreated!\x1b[0m\r\n\r\n'
    + 'Your\x1b[1COAuth\x1b[1Ctoken\x1b[1C(valid\x1b[1Cfor\x1b[1C1\x1b[1Cyear):\r\n\r\n';
  for (let i = 0; i < token.length; i += cols) text += `\x1b[33m${token.slice(i, i + cols)}\x1b[0m\r\n`;
  return `${text}\r\nStore\x1b[1Cthis\x1b[1Ctoken\x1b[1Csecurely.\r\n`;
}

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write() {} };
  kill() { queueMicrotask(() => this.emit('close', 1)); }
}

async function tmpRoot(t, label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `rhwp-claude-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function terminalLogin(output, { code = 0, onSpec } = {}) {
  let input = '';
  return {
    get input() { return input; },
    createTerminal(spec) {
      onSpec?.(spec);
      return {
        done: (async () => {
          for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
          spec.onOutput(output);
          return { code };
        })(),
        snapshot: () => '',
        write: (value) => { input += value; },
        resize() {},
        cancel: async () => true,
      };
    },
  };
}

test('the setup-token parser reads wrapped tokens and rejects partial ones', () => {
  assert.equal(parseClaudeSetupTokenOutput(`Your OAuth token:\n${TOKEN.slice(0, 50)}\n${TOKEN.slice(50)}\n\nStore this token`)?.token, TOKEN);
  assert.equal(parseClaudeSetupTokenOutput(`${TOKEN}\n\nexport CLAUDE_CODE_OAUTH_TOKEN=<token>`)?.token, TOKEN);
  assert.equal(parseClaudeSetupTokenOutput('sk-ant-oat01-short'), null);
  assert.equal(parseClaudeSetupTokenOutput('Paste code here if prompted >'), null);
});

test('in-app Claude login stores a setup-token that every Claude child receives', async (t) => {
  const rootDir = await tmpRoot(t, 'login');
  const secretStore = createMemorySecretStore();
  let spec;
  const login = terminalLogin(setupTokenScreen(TOKEN), { onSpec: (value) => { spec = value; } });
  const manager = createCliSetupManager({
    rootDir,
    homeDir: rootDir,
    platform: 'darwin',
    baseEnv: POLLUTED_ENV,
    secretStore,
    createTerminal: login.createTerminal,
    verifyClaude: async () => 'valid',
    readClaudeLogin: async () => null,
  });
  await manager.init();
  const running = manager.authenticate('claude', 'oauth', undefined, undefined, { terminal: true });
  while (!spec) await new Promise((resolve) => setImmediate(resolve));
  manager.submitAuthCode('claude', 'browser-code');
  const status = await running;

  assert.deepEqual(spec.argv, ['setup-token']);
  for (const key of CLAUDE_AUTH_ENV_KEYS) assert.equal(spec.env[key], undefined, key);
  assert.equal(spec.env.HOME, rootDir);
  assert.equal(login.input, 'browser-code\n');
  assert.equal(status.authenticated, true);
  assert.equal(status.authSource, 'app');
  assert.equal(typeof status.authVerifiedAt, 'number');
  assert.equal(await secretStore.get('rhwp.claude.oauth-token'), TOKEN);
  const env = manager.envFor('claude');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  for (const key of CLAUDE_AUTH_ENV_KEYS.filter((key) => key !== 'CLAUDE_CODE_OAUTH_TOKEN')) {
    assert.equal(env[key], undefined, key);
  }
  assert.deepEqual(await readdir(path.join(rootDir, 'claude-login')), []);

  const reloaded = createCliSetupManager({
    rootDir, homeDir: rootDir, platform: 'darwin', baseEnv: {}, secretStore, readClaudeLogin: async () => null,
  });
  await reloaded.init();
  assert.equal(reloaded.envFor('claude').CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
});

test('a login that prints no token fails without storing anything', async (t) => {
  const rootDir = await tmpRoot(t, 'login-fail');
  const secretStore = createMemorySecretStore();
  const manager = createCliSetupManager({
    rootDir,
    secretStore,
    createTerminal: terminalLogin('Error: account on hold\r\n', { code: 1 }).createTerminal,
    readClaudeLogin: async () => null,
  });
  await manager.init();
  await assert.rejects(
    manager.authenticate('claude', 'oauth', undefined, undefined, { terminal: true }),
    (error) => error.code === 'AGENT_AUTH_FAILED' && /account on hold/.test(error.message),
  );
  assert.equal(await secretStore.get('rhwp.claude.oauth-token'), null);
  assert.equal((await manager.status('claude')).authenticated, false);
});

test('Windows logins redirect the profile and secure storage into the run folder', async (t) => {
  const rootDir = await tmpRoot(t, 'login-win');
  let loginEnv;
  const manager = createCliSetupManager({
    rootDir,
    homeDir: rootDir,
    platform: 'win32',
    baseEnv: { PATH: 'C:\\bin', USERPROFILE: 'C:\\Users\\tester' },
    secretStore: createMemorySecretStore(),
    verifyClaude: async () => 'unknown',
    readClaudeLogin: async () => null,
    spawnProcess: (_command, argv, options) => {
      loginEnv = options.env;
      assert.deepEqual(argv, ['setup-token']);
      const proc = new FakeProcess();
      queueMicrotask(() => {
        proc.stdout.emit('data', `Your OAuth token (valid for 1 year):\n\n${TOKEN}\n\nStore this token securely.\n`);
        proc.emit('close', 0);
      });
      return proc;
    },
  });
  await manager.init();
  const status = await manager.authenticate('claude', 'oauth');
  assert.equal(loginEnv.USERPROFILE, loginEnv.HOME);
  assert.equal(loginEnv.CLAUDE_CONFIG_DIR, path.join(loginEnv.HOME, '.claude'));
  assert.equal(loginEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR, loginEnv.CLAUDE_CONFIG_DIR);
  assert.equal(status.authSource, 'app');
  assert.equal(status.authVerifiedAt, null, 'an offline check still keeps the new token');
});

test('a rejected credential falls through to the next working source', async (t) => {
  const rootDir = await tmpRoot(t, 'verify');
  const secretStore = createMemorySecretStore();
  await secretStore.set('rhwp.claude.oauth-token', TOKEN);
  const localToken = 'sk-ant-oat01-terminal-login-access';
  const verdicts = new Map([[TOKEN, 'invalid'], [localToken, 'valid']]);
  let online = true;
  const manager = createCliSetupManager({
    rootDir,
    secretStore,
    readClaudeLogin: async () => ({
      source: 'keychain',
      text: JSON.stringify({ claudeAiOauth: { accessToken: localToken, expiresAt: Date.now() + 3_600_000 } }),
    }),
    verifyClaude: async ({ token }) => (online ? verdicts.get(token) : 'unknown'),
  });
  await manager.init();
  assert.equal((await manager.status('claude')).authSource, 'app');

  online = false;
  assert.equal(await manager.verifyAuth('claude', { force: true }), 'unknown');
  assert.equal((await manager.status('claude')).authSource, 'app', 'offline checks never sign out');

  online = true;
  assert.equal(await manager.verifyAuth('claude', { force: true }), 'valid', 'the terminal login is checked right after');
  assert.equal(await secretStore.get('rhwp.claude.oauth-token'), null);
  const status = await manager.status('claude');
  assert.equal(status.authSource, 'local');
  assert.equal(typeof status.authVerifiedAt, 'number');
  assert.equal(manager.envFor('claude').CLAUDE_CODE_OAUTH_TOKEN, localToken);
});

test('a terminal login about to expire is not handed to new sessions', async (t) => {
  const rootDir = await tmpRoot(t, 'local-expiry');
  const manager = createCliSetupManager({
    rootDir,
    readClaudeLogin: async () => ({
      source: 'file',
      text: JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-nearly-expired', expiresAt: Date.now() + 60_000 } }),
    }),
  });
  await manager.init();
  const status = await manager.status('claude');
  assert.equal(status.authenticated, false);
  assert.equal(manager.envFor('claude').CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('logging out forgets app credentials and stops reusing the terminal login', async (t) => {
  const rootDir = await tmpRoot(t, 'logout');
  const secretStore = createMemorySecretStore();
  await secretStore.set('rhwp.claude.oauth-token', TOKEN);
  const readClaudeLogin = async () => ({
    source: 'file',
    text: JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-terminal', expiresAt: Date.now() + 3_600_000 } }),
  });
  const manager = createCliSetupManager({ rootDir, secretStore, readClaudeLogin });
  await manager.init();
  const status = await manager.disconnect('claude');
  assert.equal(status.authenticated, false);
  assert.equal(await secretStore.get('rhwp.claude.oauth-token'), null);
  assert.equal(manager.envFor('claude').CLAUDE_CODE_OAUTH_TOKEN, undefined);

  const reloaded = createCliSetupManager({ rootDir, secretStore, readClaudeLogin });
  await reloaded.init();
  assert.equal((await reloaded.status('claude')).authenticated, false, 'logout survives a restart');
});
