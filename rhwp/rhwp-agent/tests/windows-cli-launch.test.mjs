import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildClaudeArgv, createClaudeSession } from '../agents/claude.mjs';
import { createCodexSession } from '../agents/codex.mjs';
import { createPersistentAcpSession } from '../agents/acp-session.mjs';
import { buildPiArgv, createPiSession } from '../agents/pi.mjs';
import {
  applyManagedCliLaunch,
  applyNpmCliLaunch,
  NODE_HOST_PRELOAD_FILE,
  parseNpmCmdShimScript,
  resolveCommandOnPath,
  resolveNpmCliLaunch,
  WINDOWS_CMD_LINE_LIMIT,
  windowsCmdExeCommandLineLength,
  writeNodeHostShim,
} from '../npm-cli-launch.mjs';

const sessionId = '00000000-0000-4000-8000-000000000000';
const claudeOpts = {
  rootDir: '/tmp/Rau workspace',
  isolatedHome: '/tmp/rhwp-home',
  mcpScriptPath: '/tmp/Rau runtime/mcp stdio.mjs',
  mcpRuntimeCommand: '/Applications/Rau App/Rau',
  mcpRuntimeArgs: ['--no-warnings'],
  mcpRuntimeEnv: { ELECTRON_RUN_AS_NODE: '1' },
  hubPort: 5175,
  token: 'a'.repeat(36),
  sessionId: 'studio-thread-42',
  model: 'claude-opus-4-6',
  effort: 'high',
  permissionProfile: 'safe',
  workflow: 'direct',
  phase: 'implementing',
  capabilityEpoch: 1,
  onEvent() {},
};

function writeNpmCmdShim(root, binName, scriptRelPath) {
  const binDir = path.join(root, 'npm-bin');
  mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(root, scriptRelPath);
  mkdirSync(path.dirname(scriptPath), { recursive: true });
  const cmdPath = path.join(binDir, `${binName}.cmd`);
  const relativeFromBin = path.relative(binDir, scriptPath).replace(/\\/g, '\\');
  writeFileSync(scriptPath, [
    'if (process.argv.includes("--version")) {',
    '  console.log("0.0.0-test");',
    '  process.exit(0);',
    '}',
    'console.log(JSON.stringify({ argvLength: process.argv.slice(2).join(" ").length }));',
  ].join('\n'));
  writeFileSync(cmdPath, [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'GOTO :eof',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relativeFromBin}" %*`,
    '',
  ].join('\r\n'));
  return { cmdPath, scriptPath };
}

test('realistic Claude argv exceeds the Windows cmd.exe ceiling through a .cmd shim', () => {
  const argv = buildClaudeArgv(claudeOpts, sessionId, false);
  const length = windowsCmdExeCommandLineLength('claude.cmd', argv);
  assert.ok(
    length > WINDOWS_CMD_LINE_LIMIT,
    `expected cmd.exe line ${length} to exceed ${WINDOWS_CMD_LINE_LIMIT}`,
  );
});

test('Pi node_modules/.bin shims also overflow cmd.exe', () => {
  const pi = [...buildPiArgv({ ...claudeOpts, piRoot: '/tmp/pi', model: 'x' }, sessionId), 'review'];
  assert.ok(
    windowsCmdExeCommandLineLength(
      String.raw`C:\app\prefix\node_modules\.bin\pi.cmd`,
      pi,
      { doubleEscapeMetaChars: true },
    ) > WINDOWS_CMD_LINE_LIMIT,
    'pi .bin shim with caret-escaping should overflow cmd.exe',
  );
});

test('npm cmd-shim parser expands %dp0% to the sibling JS entry', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-npm-cmd-shim-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, scriptPath } = writeNpmCmdShim(
    root, 'claude', path.join('node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
  );
  const parsed = parseNpmCmdShimScript(cmdPath, readFileSync(cmdPath, 'utf8'));
  assert.equal(parsed, scriptPath);
});

test('pnpm-style %~dp0 shim resolves the JS entry', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-pnpm-cmd-shim-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scriptPath = path.join(root, 'claude-code', 'cli.js');
  mkdirSync(path.dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, 'console.log("ok")\n');
  const cmdPath = path.join(root, 'bin', 'claude.cmd');
  mkdirSync(path.dirname(cmdPath), { recursive: true });
  writeFileSync(cmdPath, `@ECHO OFF\r\n"%~dp0\\node" "%~dp0\\..\\claude-code\\cli.js" %*\r\n`);
  assert.equal(parseNpmCmdShimScript(cmdPath, readFileSync(cmdPath, 'utf8')), scriptPath);
});

test('parser does not unwrap a .cmd that invokes notnode.exe', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cmd-notnode-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scriptPath = path.join(root, 'entry.js');
  writeFileSync(scriptPath, 'console.log("not node")\n');
  const cmdPath = path.join(root, 'wrapper.cmd');
  writeFileSync(
    cmdPath,
    `@ECHO OFF\r\n"C:\\tools\\notnode.exe" "%~dp0\\entry.js" %*\r\n`,
  );
  assert.equal(parseNpmCmdShimScript(cmdPath, readFileSync(cmdPath, 'utf8')), null);
  const launch = resolveNpmCliLaunch(cmdPath, { platform: 'win32', nodeCommand: process.execPath });
  assert.equal(launch.command, cmdPath);
  assert.deepEqual(launch.leadingArgs, []);
});

test('parser does not unwrap a .cmd that only quotes a .js path', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cmd-quoted-js-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scriptPath = path.join(root, 'helper.js');
  writeFileSync(scriptPath, 'console.log("data")\n');
  const cmdPath = path.join(root, 'wrapper.cmd');
  writeFileSync(cmdPath, [
    '@ECHO OFF',
    `echo using "%~dp0\\helper.js" as data`,
    'copy "%~dp0\\helper.js" "%TEMP%\\out.js"',
    '',
  ].join('\r\n'));
  assert.equal(parseNpmCmdShimScript(cmdPath, readFileSync(cmdPath, 'utf8')), null);
  const launch = resolveNpmCliLaunch(cmdPath, { platform: 'win32', nodeCommand: process.execPath });
  assert.equal(launch.command, cmdPath);
  assert.deepEqual(launch.leadingArgs, []);
  assert.deepEqual(launch.env, {});
});

test('parser does not unwrap a node shim whose JS entry is missing', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cmd-missing-js-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cmdPath = path.join(root, 'claude.cmd');
  writeFileSync(cmdPath, `@ECHO OFF\r\n"%_prog%" "%~dp0\\missing-cli.js" %*\r\n`);
  assert.equal(parseNpmCmdShimScript(cmdPath, readFileSync(cmdPath, 'utf8')), null);
  const launch = resolveNpmCliLaunch(cmdPath, { platform: 'win32', nodeCommand: process.execPath });
  assert.equal(launch.command, cmdPath);
  assert.deepEqual(launch.leadingArgs, []);
});

const CODEX_TARGET = { x64: ['codex-win32-x64', 'x86_64-pc-windows-msvc'], arm64: ['codex-win32-arm64', 'aarch64-pc-windows-msvc'] }[process.arch]
  ?? ['codex-win32-x64', 'x86_64-pc-windows-msvc'];

/** `npm install @openai/codex` on Windows: a Node shim to bin/codex.js plus the hoisted platform package. */
function writeNpmCodexInstall(root, { platformPackage = true } = {}) {
  const modules = path.join(root, 'node_modules');
  const packageRoot = path.join(modules, '@openai', 'codex');
  mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.163.0' }));
  writeFileSync(path.join(packageRoot, 'bin', 'codex.js'), '// spawns the platform codex.exe with stdio: "inherit"\n');
  let exePath = null;
  if (platformPackage) {
    const [pkg, triple] = CODEX_TARGET;
    exePath = path.join(modules, '@openai', pkg, 'vendor', triple, 'bin', 'codex.exe');
    mkdirSync(path.dirname(exePath), { recursive: true });
    writeFileSync(exePath, '');
  }
  const cmdPath = path.join(modules, '.bin', 'codex.cmd');
  mkdirSync(path.dirname(cmdPath), { recursive: true });
  writeFileSync(cmdPath, [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\@openai\\codex\\bin\\codex.js" %*`,
    '',
  ].join('\r\n'));
  return { cmdPath, exePath, packageRoot, scriptPath: path.join(packageRoot, 'bin', 'codex.js') };
}

test('npm Codex shim launches the platform codex.exe, not the Node wrapper that re-spawns it', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-npm-codex-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, exePath, packageRoot } = writeNpmCodexInstall(root);
  const launched = applyManagedCliLaunch(cmdPath, ['app-server', '--stdio'], {
    platform: 'win32',
    nodeCommand: path.join(root, 'HamaEditor.exe'),
    env: { PATH: '' },
  });
  assert.equal(launched.command, exePath);
  assert.deepEqual(launched.argv, ['app-server', '--stdio']);
  // The env codex.js gives the binary, so it still finds its bundled tools and reports npm ownership.
  assert.equal(launched.env.CODEX_MANAGED_PACKAGE_ROOT, realpathSync(packageRoot));
  assert.equal(launched.env.CODEX_MANAGED_BY_NPM, '1');
});

test('an npm Codex install without its platform binary, or another codex.js, keeps the Node launch', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-npm-codex-fallback-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, scriptPath, packageRoot } = writeNpmCodexInstall(root, { platformPackage: false });
  const nodeCommand = process.execPath;
  assert.deepEqual(resolveNpmCliLaunch(cmdPath, { platform: 'win32', nodeCommand }).leadingArgs, [scriptPath]);
  const [, triple] = CODEX_TARGET;
  mkdirSync(path.join(packageRoot, 'vendor', triple, 'bin'), { recursive: true });
  writeFileSync(path.join(packageRoot, 'vendor', triple, 'bin', 'codex.exe'), '');
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'not-codex' }));
  assert.deepEqual(resolveNpmCliLaunch(cmdPath, { platform: 'win32', nodeCommand }).leadingArgs, [scriptPath]);
});

test('Windows PATH lookup uses the provided env, not process.env', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-cmd-path-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, scriptPath } = writeNpmCmdShim(root, 'claude', 'cli.js');
  const seen = [];
  const launch = resolveNpmCliLaunch('claude', {
    platform: 'win32',
    nodeCommand: process.execPath,
    env: { PATH: 'C:\\custom\\bin' },
    whichSync(command, options) {
      seen.push({ command, options });
      return command === 'claude' ? cmdPath : null;
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].command, 'claude');
  assert.equal(seen[0].options.path, 'C:\\custom\\bin');
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.leadingArgs, [scriptPath]);
});

test('Unix launches stay on the original binary', () => {
  const launch = resolveNpmCliLaunch('claude', { platform: 'linux', nodeCommand: '/usr/bin/node' });
  assert.deepEqual(launch, { command: 'claude', leadingArgs: [], env: {} });
});

test('Windows npm .cmd unwraps to node plus the JS entry, skipping cmd.exe', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-npm-unwrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, scriptPath } = writeNpmCmdShim(
    root, 'claude', path.join('node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
  );
  const nodeCommand = process.execPath;
  const launch = resolveNpmCliLaunch(cmdPath, { platform: 'win32', nodeCommand });
  assert.equal(launch.command, nodeCommand);
  assert.deepEqual(launch.leadingArgs, [scriptPath]);
  assert.match(path.basename(launch.command), /^(?:node|node\.exe)$/i);
  assert.equal(/\.(?:cmd|bat)$/i.test(launch.command), false);

  const argv = buildClaudeArgv(claudeOpts, sessionId, false);
  const launched = applyNpmCliLaunch(cmdPath, argv, { platform: 'win32', nodeCommand });
  assert.equal(launched.command, nodeCommand);
  assert.equal(launched.argv[0], scriptPath);
  assert.equal(launched.argv.includes('--append-system-prompt'), true);
  // cross-spawn only wraps .cmd/.bat. node(.exe) goes through CreateProcessW.
  assert.equal(/\.(?:cmd|bat)$/i.test(launched.command), false);
});

test('Electron host sets ELECTRON_RUN_AS_NODE when unwrapping', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-electron-unwrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, scriptPath } = writeNpmCmdShim(root, 'claude', 'cli.js');
  const launch = resolveNpmCliLaunch(cmdPath, {
    platform: 'win32',
    nodeCommand: path.join(root, 'HamaEditor.exe'),
  });
  assert.equal(launch.command, path.join(root, 'HamaEditor.exe'));
  assert.deepEqual(launch.leadingArgs, [scriptPath]);
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, '1');
});

test('unwrapped Claude spawn actually starts with a cmd.exe-overflowing argv', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-unwrap-spawn-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, scriptPath } = writeNpmCmdShim(root, 'claude', 'cli.js');
  // 실제 세션처럼 서브에이전트 정의는 파일로 넘긴다 — 인라인 JSON 이면 CreateProcess 상한(32,767자)을 넘는다.
  const argv = buildClaudeArgv(claudeOpts, sessionId, false, { agentsPath: path.join(root, 'rhwp-agents.json') });
  assert.ok(windowsCmdExeCommandLineLength(cmdPath, argv) > WINDOWS_CMD_LINE_LIMIT);
  // 실제 상한은 CreateProcess 의 32,767자다. 25,000자 예산은 사용자 경로가 길어질 여유를 남긴다.
  assert.ok(argv.reduce((total, arg) => total + arg.length + 3, 0) < 25_000);
  const launched = applyNpmCliLaunch(cmdPath, argv, {
    platform: 'win32',
    nodeCommand: process.execPath,
  });
  assert.equal(launched.argv[0], scriptPath);

  const child = nodeSpawn(launched.command, launched.argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const { code } = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ code: exitCode }));
  });
  assert.equal(code, 0, stderr || stdout);
  const payload = JSON.parse(stdout.trim());
  assert.ok(payload.argvLength > 8000);
});

class FakeStream extends EventEmitter {
  chunks = [];
  write(chunk, callback) {
    this.chunks.push(String(chunk));
    callback?.();
    return true;
  }
  pipe(dest) { return dest; }
  end() {}
}

class FakeProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  stdin = new FakeStream();
  exitCode = null;
  signalCode = null;
  kill() { return true; }
}

test('createClaudeSession unwraps a Windows .cmd bin before spawn', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-claude-session-unwrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, scriptPath } = writeNpmCmdShim(root, 'claude', 'cli.js');
  const spawns = [];
  const events = [];
  const session = createClaudeSession({
    ...claudeOpts,
    claudeBin: cmdPath,
    onEvent: (event) => events.push(event),
  }, {
    platform: 'win32',
    nodeCommand: process.execPath,
    spawnProcess(command, argv, options) {
      const proc = new FakeProcess();
      spawns.push({ command, argv, options, proc });
      return proc;
    },
    terminateProcess() { return true; },
    waitForExit: async () => true,
    closeGraceMs: 1,
  });
  t.after(() => session.dispose());
  session.sendUserMessage('review');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, process.execPath);
  assert.equal(spawns[0].argv[0], scriptPath);
  assert.equal(spawns[0].argv.includes('--append-system-prompt'), true);
  assert.equal(/\.(?:cmd|bat)$/i.test(spawns[0].command), false);
  assert.equal(events.some((event) => event.type === 'turn-start'), true);
});

async function waitUntil(predicate, message = 'condition did not settle') {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test('native Claude SDK launch unwraps Windows .cmd and merges Electron env', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-claude-sdk-unwrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, scriptPath } = writeNpmCmdShim(root, 'claude', 'cli.js');
  const electronBin = path.join(root, 'HamaEditor.exe');
  const events = [];
  const sdkOptions = [];
  const session = createClaudeSession({
    ...claudeOpts,
    claudeBin: cmdPath,
    agentRole: 'chat',
    requestUserInput: async () => ({ status: 'cancelled', reason: 'user-stop' }),
    onEvent: (event) => events.push(event),
  }, {
    platform: 'win32',
    nodeCommand: electronBin,
    queryAgent({ prompt, options }) {
      sdkOptions.push(options);
      const query = (async function* () {
        for await (const _message of prompt) {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: options.sessionId ?? options.resume,
            model: 'claude-test',
          };
          yield { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'done' };
        }
      })();
      query.close = () => {};
      return query;
    },
    spawnProcess() { throw new Error('legacy transport should not spawn'); },
    terminateProcess() { return true; },
    waitForExit: async () => true,
    closeGraceMs: 1,
  });
  t.after(() => session.dispose());
  session.sendUserMessage('review');
  await waitUntil(() => events.some((event) => event.type === 'turn-end'));
  assert.equal(sdkOptions.length, 1);
  assert.equal(sdkOptions[0].pathToClaudeCodeExecutable, scriptPath);
  assert.equal(sdkOptions[0].env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(/\.(?:cmd|bat)$/i.test(sdkOptions[0].pathToClaudeCodeExecutable), false);
});

// npm 11 cmd-shim for Claude Code 2.1.30x, whose package bin is a native claude.exe.
function writeNativeExeCmdShim(root) {
  const binDir = path.join(root, 'prefix', 'node_modules', '.bin');
  const exePath = path.join(root, 'prefix', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(path.dirname(exePath), { recursive: true });
  writeFileSync(exePath, '');
  const cmdPath = path.join(binDir, 'claude.cmd');
  writeFileSync(cmdPath, [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '"%dp0%\\..\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
    '',
  ].join('\r\n'));
  return { cmdPath, exePath };
}

test('Windows npm .cmd around a native exe launches the exe directly, skipping cmd.exe', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-native-cmd-shim-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, exePath } = writeNativeExeCmdShim(root);
  const argv = buildClaudeArgv(claudeOpts, sessionId, true);
  const launched = applyManagedCliLaunch(cmdPath, argv, {
    platform: 'win32',
    nodeCommand: path.join(root, 'HamaEditor.exe'),
    env: { PATH: '' },
  });
  assert.equal(launched.command, exePath);
  assert.deepEqual(launched.argv, argv);
  assert.equal(launched.env.ELECTRON_RUN_AS_NODE, undefined);
});

test('a Claude shim whose native exe npm pruned ends the turn as a missing CLI, not through cmd.exe', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-native-cmd-pruned-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, exePath } = writeNativeExeCmdShim(root);
  // 다른 CLI 의 npm install 이 패키지를 지우고 .bin/claude.cmd 만 남긴 prefix.
  rmSync(path.dirname(path.dirname(exePath)), { recursive: true, force: true });
  const events = [];
  const session = createClaudeSession({
    ...claudeOpts,
    rootDir: root,
    claudeBin: cmdPath,
    onEvent: (event) => events.push(event),
  }, { platform: 'win32', nodeCommand: path.join(root, 'HamaEditor.exe'), closeGraceMs: 10 });
  t.after(() => session.dispose());
  session.sendUserMessage('hello');
  // 실제 spawn 이 실패하고 정리까지 끝나야 턴이 닫힌다.
  for (let waited = 0; !events.some((event) => event.type === 'turn-end') && waited < 10_000; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const end = events.find((event) => event.type === 'turn-end');
  assert.equal(end?.failure?.code, 'cli_missing', JSON.stringify(events));
  const error = events.find((event) => event.type === 'error');
  assert.match(error.message, /ENOENT/);
  assert.doesNotMatch(error.message, /EINVAL|ENAMETOOLONG/);
});

test('native Claude SDK launch points at the exe behind a Windows npm .cmd', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-claude-sdk-native-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, exePath } = writeNativeExeCmdShim(root);
  const events = [];
  const sdkOptions = [];
  const session = createClaudeSession({
    ...claudeOpts,
    claudeBin: cmdPath,
    agentRole: 'chat',
    requestUserInput: async () => ({ status: 'cancelled', reason: 'user-stop' }),
    onEvent: (event) => events.push(event),
  }, {
    platform: 'win32',
    nodeCommand: path.join(root, 'HamaEditor.exe'),
    queryAgent({ prompt, options }) {
      sdkOptions.push(options);
      const query = (async function* () {
        for await (const _message of prompt) {
          yield { type: 'system', subtype: 'init', session_id: options.sessionId ?? options.resume, model: 'claude-test' };
          yield { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'done' };
        }
      })();
      query.close = () => {};
      return query;
    },
    spawnProcess() { throw new Error('legacy transport should not spawn'); },
    terminateProcess() { return true; },
    waitForExit: async () => true,
    closeGraceMs: 1,
  });
  t.after(() => session.dispose());
  session.sendUserMessage('review');
  await waitUntil(() => events.some((event) => event.type === 'turn-end'));
  assert.equal(sdkOptions.length, 1);
  assert.equal(sdkOptions[0].pathToClaudeCodeExecutable, exePath);
});

/** A Claude SDK fake that starts the CLI through the hub's spawn hook, then settles one turn. */
function spawningClaudeQuery(sdkOptions, { onClose = () => {} } = {}) {
  return ({ prompt, options }) => {
    sdkOptions.push(options);
    const query = (async function* () {
      for await (const _message of prompt) {
        options.spawnClaudeCodeProcess?.({
          command: 'C:\\managed\\claude.exe',
          args: ['--output-format', 'stream-json'],
          cwd: options.cwd,
          env: options.env,
          signal: new AbortController().signal,
        });
        yield { type: 'system', subtype: 'init', session_id: options.sessionId ?? options.resume, model: 'claude-test' };
        yield { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: 'done' };
      }
    })();
    query.close = onClose;
    return query;
  };
}

function fakeClaudeProcess() {
  return Object.assign(new EventEmitter(), {
    pid: 4321,
    exitCode: null,
    signalCode: null,
    killed: false,
    stdin: Object.assign(new EventEmitter(), { write() { return true; }, end() {} }),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill() { return true; },
  });
}

// Windows 의 SDK close() 는 claude.exe 리더만 끝낸다. 도는 Bash 도구의 bash → ping 같은 자손은 허브
// 종료 뒤에도 남았다(live: 창 닫기 중 ping -n 30). 허브가 띄운 CLI 가 유예 안에 끝나지 않으면 트리째 끝낸다.
test('Windows Claude SDK sessions own the CLI process and end its tree when it outlives close', async (t) => {
  const events = [];
  const sdkOptions = [];
  const spawns = [];
  const terminated = [];
  const proc = fakeClaudeProcess();
  const session = createClaudeSession({
    ...claudeOpts,
    agentRole: 'chat',
    requestUserInput: async () => ({ status: 'cancelled', reason: 'user-stop' }),
    onEvent: (event) => events.push(event),
  }, {
    platform: 'win32',
    queryAgent: spawningClaudeQuery(sdkOptions),
    spawnSdkProcess(command, args, options) {
      spawns.push({ command, args, options });
      return proc;
    },
    spawnProcess() { throw new Error('legacy transport should not spawn'); },
    terminateProcess(child) {
      terminated.push(child);
      child.exitCode = 1;
      child.emit('exit', 1, null);
      return true;
    },
    waitForExit: async () => true,
    closeGraceMs: 5,
  });
  session.sendUserMessage('run the long shell command');
  await waitUntil(() => events.some((event) => event.type === 'turn-end'));
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, 'C:\\managed\\claude.exe');
  assert.equal(spawns[0].options.windowsHide, true);
  assert.equal(spawns[0].options.detached, undefined);
  assert.deepEqual(spawns[0].options.stdio, ['pipe', 'pipe', 'pipe']);

  assert.equal(await session.dispose(), true);
  assert.deepEqual(terminated, [proc]);
});

test('Windows Claude SDK close leaves a CLI that exits on its own to the SDK', async (t) => {
  const events = [];
  const sdkOptions = [];
  const terminated = [];
  const proc = fakeClaudeProcess();
  const session = createClaudeSession({
    ...claudeOpts,
    agentRole: 'chat',
    requestUserInput: async () => ({ status: 'cancelled', reason: 'user-stop' }),
    onEvent: (event) => events.push(event),
  }, {
    platform: 'win32',
    queryAgent: spawningClaudeQuery(sdkOptions, {
      onClose() {
        // stdin EOF 에 스스로 끝나는 CLI.
        proc.exitCode = 0;
        proc.emit('exit', 0, null);
      },
    }),
    spawnSdkProcess: () => proc,
    spawnProcess() { throw new Error('legacy transport should not spawn'); },
    terminateProcess(child) { terminated.push(child); return true; },
    waitForExit: async () => true,
    closeGraceMs: 1_000,
  });
  session.sendUserMessage('hello');
  await waitUntil(() => events.some((event) => event.type === 'turn-end'));
  assert.equal(await session.dispose(), true);
  assert.deepEqual(terminated, []);
});

test('Claude SDK sessions off Windows keep the SDK spawn', async (t) => {
  const events = [];
  const sdkOptions = [];
  const session = createClaudeSession({
    ...claudeOpts,
    agentRole: 'chat',
    requestUserInput: async () => ({ status: 'cancelled', reason: 'user-stop' }),
    onEvent: (event) => events.push(event),
  }, {
    platform: 'darwin',
    queryAgent: spawningClaudeQuery(sdkOptions),
    spawnSdkProcess() { throw new Error('the SDK spawns the CLI itself off Windows'); },
    spawnProcess() { throw new Error('legacy transport should not spawn'); },
    terminateProcess() { return true; },
    waitForExit: async () => true,
    closeGraceMs: 1,
  });
  t.after(() => session.dispose());
  session.sendUserMessage('hello');
  await waitUntil(() => events.some((event) => event.type === 'turn-end'));
  assert.equal(sdkOptions[0].spawnClaudeCodeProcess, undefined);
});

test('managed launch without env does not replace process.env with an empty object', () => {
  const launched = applyManagedCliLaunch('claude', ['--version'], {
    platform: 'linux',
    nodeCommand: '/usr/bin/node',
  });
  assert.equal(launched.command, 'claude');
  assert.deepEqual(launched.argv, ['--version']);
  assert.equal(launched.env, undefined);
});

test('managed launch without env still injects ELECTRON_RUN_AS_NODE onto process.env', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-managed-inherit-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, scriptPath } = writeNpmCmdShim(root, 'claude', 'cli.js');
  const electron = path.join(root, 'HamaEditor.exe');
  const launched = applyManagedCliLaunch(cmdPath, ['--version'], {
    platform: 'win32',
    nodeCommand: electron,
  });
  assert.equal(launched.command, electron);
  assert.deepEqual(launched.argv, [scriptPath, '--version']);
  assert.equal(launched.env.ELECTRON_RUN_AS_NODE, '1');
  const pathKey = Object.keys(launched.env).find((key) => key.toLowerCase() === 'path');
  assert.equal(launched.env[pathKey], process.env.PATH);
});

test('managed launch prepends the Node-host PATH and unwraps a .cmd', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-managed-launch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, scriptPath } = writeNpmCmdShim(root, 'codex', 'cli.js');
  const electron = path.join(root, 'HamaEditor.exe');
  const shimDir = path.join(root, 'node-host');
  await writeNodeHostShim(shimDir, electron, { platform: 'win32' });
  // win32 계약은 Windows 경로로 프리로드를 알린다. Linux/macOS CI 에서는 그 경로를 디스크의 사본으로 잇는다.
  const preloadCopy = path.join(shimDir, NODE_HOST_PRELOAD_FILE);
  const preload = path.win32.join(shimDir, NODE_HOST_PRELOAD_FILE);
  const launched = applyManagedCliLaunch(cmdPath, ['exec', '--json'], {
    platform: 'win32',
    nodeCommand: electron,
    env: { PATH: 'C:\\Windows\\System32' },
    shimDir,
    existsSync: (file) => existsSync(file === preload ? preloadCopy : file),
  });
  assert.equal(launched.command, electron);
  // 콘솔 없는 Electron 호스트는 node-host 의 콘솔 숨김 프리로드를 먼저 읽는다.
  assert.deepEqual(launched.argv, ['--require', preload, scriptPath, 'exec', '--json']);
  assert.deepEqual(
    readFileSync(preloadCopy),
    readFileSync(new URL('../windows-hide-console.cjs', import.meta.url)),
  );
  assert.equal(launched.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(launched.env.npm_node_execpath, electron);
  assert.equal(launched.env.PATH.startsWith(`${shimDir};`), true);
  assert.equal(/\.(?:cmd|bat)$/i.test(launched.command), false);
});

test('managed Electron launch skips a missing console-hide preload instead of failing to start', () => {
  const electron = 'C:\\Apps\\HamaEditor.exe';
  const launched = applyManagedCliLaunch(electron, ['C:\\cli\\npm-cli.js', 'install'], {
    platform: 'win32',
    nodeCommand: electron,
    env: { PATH: '', ELECTRON_RUN_AS_NODE: '1', RHWP_NODE_PRELOAD: 'C:\\gone\\rhwp-hide-console.cjs' },
    existsSync: (file) => file === electron,
  });
  assert.deepEqual(launched.argv, ['C:\\cli\\npm-cli.js', 'install']);
});

// Pi 는 자식 env 를 화이트리스트로 줄인다. 허브가 알린 node-host 프리로드는 그래도 붙는다.
test('managed Electron launch with an allowlisted env still loads the hub console-hide preload', (t) => {
  const electron = 'C:\\Apps\\HamaEditor.exe';
  const preload = 'C:\\cli\\node-host\\rhwp-hide-console.cjs';
  const previous = process.env.RHWP_NODE_PRELOAD;
  process.env.RHWP_NODE_PRELOAD = preload;
  t.after(() => {
    if (previous === undefined) delete process.env.RHWP_NODE_PRELOAD;
    else process.env.RHWP_NODE_PRELOAD = previous;
  });
  const launched = applyManagedCliLaunch(electron, ['C:\\pi\\cli.js', '--mode', 'json'], {
    platform: 'win32',
    nodeCommand: electron,
    env: { PATH: '', ELECTRON_RUN_AS_NODE: '1' },
    existsSync: (file) => file === electron || file === preload,
  });
  assert.deepEqual(launched.argv, ['--require', preload, 'C:\\pi\\cli.js', '--mode', 'json']);
  assert.equal(launched.env.RHWP_NODE_PRELOAD, undefined);
});

test('createCodexSession unwraps a Windows .cmd bin before spawn', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-codex-session-unwrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, scriptPath } = writeNpmCmdShim(root, 'codex', 'cli.js');
  const spawns = [];
  const events = [];
  const session = createCodexSession({
    ...claudeOpts,
    codexBin: cmdPath,
    codexHome: path.join(root, '.codex'),
    onEvent: (event) => events.push(event),
  }, {
    platform: 'win32',
    nodeCommand: process.execPath,
    spawnProcess(command, argv, options) {
      const proc = new FakeProcess();
      spawns.push({ command, argv, options, proc });
      return proc;
    },
    terminateProcess() { return true; },
    waitForExit: async () => true,
    closeGraceMs: 1,
    createRolloutWatcher() {
      return { drain() {}, stop() {} };
    },
  });
  t.after(() => session.dispose());
  session.sendUserMessage('review');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, process.execPath);
  assert.equal(spawns[0].argv[0], scriptPath);
  assert.equal(spawns[0].argv.includes('exec'), true);
  assert.equal(/\.(?:cmd|bat)$/i.test(spawns[0].command), false);
  assert.equal(events.some((event) => event.type === 'turn-start'), true);
});

test('createCodexSession runs an app-installed Codex as codex.exe, hidden', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-codex-session-native-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, exePath } = writeNpmCodexInstall(root);
  const spawns = [];
  const session = createCodexSession({
    ...claudeOpts,
    codexBin: cmdPath,
    codexHome: path.join(root, '.codex'),
  }, {
    platform: 'win32',
    nodeCommand: path.join(root, 'HamaEditor.exe'),
    spawnProcess(command, argv, options) {
      const proc = new FakeProcess();
      spawns.push({ command, argv, options, proc });
      return proc;
    },
    terminateProcess() { return true; },
    waitForExit: async () => true,
    closeGraceMs: 1,
    createRolloutWatcher() {
      return { drain() {}, stop() {} };
    },
  });
  t.after(() => session.dispose());
  session.sendUserMessage('review');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, exePath);
  assert.equal(spawns[0].argv.includes('exec'), true);
  assert.equal(spawns[0].options.windowsHide, true);
  assert.equal(spawns[0].options.env.CODEX_MANAGED_BY_NPM, '1');
});

test('createPiSession unwraps a Windows .cmd bin before spawn', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-pi-session-unwrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { cmdPath, scriptPath } = writeNpmCmdShim(root, 'pi', 'cli.js');
  const spawns = [];
  const events = [];
  const session = createPiSession({
    ...claudeOpts,
    piBin: cmdPath,
    piRoot: root,
    model: 'x',
    onEvent: (event) => events.push(event),
  }, {
    platform: 'win32',
    nodeCommand: process.execPath,
    spawnProcess(command, argv, options) {
      const proc = new FakeProcess();
      spawns.push({ command, argv, options, proc });
      return proc;
    },
    terminateProcess() { return true; },
    waitForExit: async () => true,
    closeGraceMs: 1,
  });
  t.after(() => session.dispose());
  session.sendUserMessage('review');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, process.execPath);
  assert.equal(spawns[0].argv[0], scriptPath);
  assert.equal(/\.(?:cmd|bat)$/i.test(spawns[0].command), false);
  assert.equal(events.some((event) => event.type === 'turn-start'), true);
});

test('resolveCommandOnPath resolves a bare name through env.PATH', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rhwp-path-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Windows는 PATHEXT 확장자가 있어야 실행 파일로 찾는다. 대소문자는 PATHEXT 표기를 따른다.
  const windows = process.platform === 'win32';
  const bin = path.join(dir, windows ? 'claude.cmd' : 'claude');
  writeFileSync(bin, windows ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const resolved = resolveCommandOnPath('claude', { env: { PATH: dir } });
  if (windows) assert.equal(resolved?.toLowerCase(), bin.toLowerCase());
  else assert.equal(resolved, bin);
});

test('resolveCommandOnPath returns null for an unknown name and nulls a missing path', () => {
  assert.equal(resolveCommandOnPath('rhwp-definitely-missing-cli', { env: { PATH: os.tmpdir() } }), null);
  assert.equal(resolveCommandOnPath('/nonexistent/claude', {}), null);
});

test('resolveCommandOnPath keeps an existing absolute path', () => {
  assert.equal(resolveCommandOnPath(process.execPath, {}), process.execPath);
});
