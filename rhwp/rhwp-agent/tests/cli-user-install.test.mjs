import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCliSetupManager } from '../cli-setup-manager.mjs';

test('Windows per-user install and login work without Node on PATH or writable global npm directories', { skip: process.platform !== 'win32', timeout: 60_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-user-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = path.join(root, 'fixture');
  const rootDir = path.join(root, 'cli');
  const home = path.join(root, 'home');
  const nodeCommand = process.env.RHWP_TEST_NODE_HOST || process.execPath;
  await fs.mkdir(fixture);
  await fs.mkdir(home);
  await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({
    name: 'fixture-cli', version: '1.2.3', bin: { codex: 'cli.js', claude: 'cli.js' },
    scripts: { postinstall: 'node postinstall.js' },
  }));
  await fs.writeFile(path.join(fixture, 'postinstall.js'), "require('node:fs').writeFileSync('postinstall-ok', process.execPath)");
  await fs.writeFile(path.join(fixture, 'cli.js'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  if (!fs.existsSync(path.join(__dirname, 'postinstall-ok'))) process.exit(2);
  console.log('fixture-cli 1.2.3');
} else if (process.argv.includes('login')) {
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { refresh_token: 'fixture' } }));
} else if (process.argv.includes('setup-token')) {
  console.log('Your OAuth token: sk-ant-oat01-' + 'a'.repeat(80));
  if (process.stdin.isTTY) process.stdin.once('data', () => process.exit(0));
} else process.exit(3);
`);
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const baseEnv = {
    SystemRoot: systemRoot, ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'),
    PATH: path.join(systemRoot, 'System32'), PATHEXT: '.COM;.EXE;.BAT;.CMD',
    TEMP: root, TMP: root, USERPROFILE: home, HOME: home, APPDATA: home,
    CODEX_HOME: path.join(home, '.codex'),
    npm_config_global: 'true', npm_config_prefix: path.join(root, 'not-a-directory'),
    npm_config_cache: path.join(root, 'not-a-directory'),
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_registry: 'http://127.0.0.1:1',
  };
  await fs.writeFile(path.join(root, 'not-a-directory'), 'must remain unchanged');
  const launches = [];
  const manager = await createCliSetupManager({
    rootDir, nodeCommand, baseEnv, homeDir: home,
    readClaudeLogin: async () => null, verifyClaude: async () => 'valid',
    spawnProcess(command, argv, options) {
      launches.push({ command, argv, options });
      // Run the real bundled npm offline, substituting only the downloaded package.
      const args = argv.map((arg) => /^@(openai\/codex|anthropic-ai\/claude-code)@latest$/.test(arg) ? fixture : arg);
      if (argv.includes('install')) args.push('--install-links=true');
      return spawn(command, args, options);
    },
  }).init();
  for (const agent of ['codex', 'claude']) {
    assert.equal((await manager.install(agent)).version, '1.2.3');
    assert.equal((await manager.authenticate(agent, 'oauth')).authenticated, true);
    assert.equal((await manager.authenticate(agent, 'oauth', undefined, (frame) => {
      if (frame.terminalData?.includes('sk-ant-oat01-')) manager.terminalInput(agent, '\r');
    }, { terminal: true })).authenticated, true);
  }
  assert.equal(await fs.readFile(path.join(manager.prefixDir, 'node_modules', 'fixture-cli', 'postinstall-ok'), 'utf8'), nodeCommand);
  assert.equal(await fs.readFile(path.join(root, 'not-a-directory'), 'utf8'), 'must remain unchanged');
  // npm 은 앱 폴더 안의 설치별 캐시를 쓰고, 설치가 끝나면 그 캐시는 남지 않는다.
  const cacheDirs = launches.filter(({ argv }) => argv.includes('install')).map(({ argv }) => argv[argv.indexOf('--cache') + 1]);
  assert.equal(cacheDirs.length, 2);
  for (const cacheDir of cacheDirs) {
    assert.ok(path.resolve(cacheDir).startsWith(path.resolve(rootDir) + path.sep));
    await assert.rejects(fs.stat(cacheDir), { code: 'ENOENT' });
  }
  assert.ok(launches.every(({ options }) => options.windowsHide === true));
  assert.equal(baseEnv.PATH, path.join(systemRoot, 'System32'));
});

test('a failed install keeps the npm log its error message points to, while its cache is removed', { timeout: 60_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-install-log-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rootDir = path.join(root, 'cli');
  const baseEnv = {
    ...process.env,
    TEMP: root, TMP: root,
    npm_config_audit: 'false', npm_config_fund: 'false',
    // 닿지 않는 레지스트리로 실제 번들 npm 을 빠르게 실패시킨다.
    npm_config_registry: 'http://127.0.0.1:1', npm_config_fetch_retries: '0',
  };
  const launches = [];
  const manager = await createCliSetupManager({
    rootDir, baseEnv, homeDir: root,
    readClaudeLogin: async () => null, verifyClaude: async () => 'unknown',
    fetchImpl: async () => { throw new Error('offline'); },
    spawnProcess(command, argv, options) { launches.push(argv); return spawn(command, argv, options); },
  }).init();
  const error = await manager.install('codex').then(() => null, (failure) => failure);
  assert.equal(error?.code, 'AGENT_INSTALL_FAILED');
  const logFile = String(error.message).match(/complete log of this run can be found in:\s*(\S+\.log)/)?.[1];
  assert.ok(logFile, `npm names its debug log: ${error.message}`);
  assert.ok((await fs.stat(logFile)).isFile(), 'the log the user is pointed to still exists');
  const install = launches.find((argv) => argv.includes('install'));
  await assert.rejects(fs.stat(install[install.indexOf('--cache') + 1]), { code: 'ENOENT' });
});
