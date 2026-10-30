import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startHub, waitForPath } from './hub-harness.mjs';
import { applyNodeHostEnv, writeNodeHostShim } from '../npm-cli-launch.mjs';
import {
  installWindowsHideConsole,
  readPeSubsystem,
  resolveWindowsExecutable,
  shouldHideWindow,
} from '../windows-hide-console.cjs';

const GUI = 2;
const CONSOLE = 3;

/** MZ 헤더 + PE 서명 + COFF + 선택적 헤더의 Subsystem 만 채운 최소 PE 이미지. */
function peImage(subsystem) {
  const peOffset = 0x80;
  const image = Buffer.alloc(peOffset + 4 + 20 + 96);
  image.write('MZ', 0, 'latin1');
  image.writeUInt32LE(peOffset, 0x3c);
  image.write('PE\0\0', peOffset, 'latin1');
  image.writeUInt16LE(0x20b, peOffset + 4 + 20);
  image.writeUInt16LE(subsystem, peOffset + 4 + 20 + 68);
  return image;
}

/** 이름별 PE 서브시스템을 가진 가짜 파일 시스템. */
function fakeExecutables(entries) {
  const files = new Map(Object.entries(entries).map(([file, subsystem]) => [file.toLowerCase(), subsystem]));
  return {
    isFile: (file) => files.has(String(file).toLowerCase()),
    readSubsystem: (file) => files.get(String(file).toLowerCase()) ?? null,
  };
}

function fakeChildProcess() {
  const asyncSpawns = [];
  const syncCalls = [];
  class ChildProcess {
    spawn(options) {
      asyncSpawns.push({ ...options });
      return 0;
    }
  }
  return {
    asyncSpawns,
    syncCalls,
    module: {
      ChildProcess,
      spawnSync: (...args) => { syncCalls.push(['spawnSync', ...args]); return { status: 0 }; },
      execFileSync: (...args) => { syncCalls.push(['execFileSync', ...args]); return ''; },
      execSync: (...args) => { syncCalls.push(['execSync', ...args]); return ''; },
    },
  };
}

test('readPeSubsystem tells GUI executables from console executables by their PE header', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-pe-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const gui = path.join(root, 'gui.exe');
  const cli = path.join(root, 'cli.exe');
  const text = path.join(root, 'not-pe.exe');
  await fs.writeFile(gui, peImage(GUI));
  await fs.writeFile(cli, peImage(CONSOLE));
  await fs.writeFile(text, 'echo not a binary');
  assert.equal(readPeSubsystem(gui), GUI);
  assert.equal(readPeSubsystem(cli), CONSOLE);
  assert.equal(readPeSubsystem(text), null);
  assert.equal(readPeSubsystem(path.join(root, 'missing.exe')), null);
});

test('readPeSubsystem reads the real Windows shell and Explorer binaries', (t) => {
  if (process.platform !== 'win32') { t.skip('Windows binaries only'); return; }
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  assert.equal(readPeSubsystem(path.join(system32, 'cmd.exe')), CONSOLE);
  assert.equal(readPeSubsystem(process.execPath), CONSOLE);
  assert.equal(readPeSubsystem(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe')), GUI);
});

test('executable lookup follows libuv: cwd first, then PATH, appending .com and .exe', () => {
  const fake = fakeExecutables({
    'C:\\work\\git.exe': CONSOLE,
    'C:\\tools\\git.exe': CONSOLE,
    'C:\\tools\\code.cmd': CONSOLE,
    'C:\\apps\\viewer.exe': GUI,
  });
  const lookup = (file) => resolveWindowsExecutable(file, {
    cwd: 'C:\\work', pathValue: 'C:\\tools;"C:\\apps"', isFile: fake.isFile,
  });
  assert.equal(lookup('git'), 'C:\\work\\git.exe');
  assert.equal(lookup('viewer'), 'C:\\apps\\viewer.exe');
  assert.equal(lookup('code.cmd'), 'C:\\tools\\code.cmd');
  assert.equal(lookup('C:\\apps\\viewer.exe'), 'C:\\apps\\viewer.exe');
  assert.equal(lookup('missing'), null);
});

test('console targets are hidden while GUI apps, detached launches and hidden spawns keep their options', () => {
  const fake = fakeExecutables({
    'C:\\Windows\\System32\\cmd.exe': CONSOLE,
    'C:\\Program Files\\Git\\cmd\\git.exe': CONSOLE,
    'C:\\Program Files\\Browser\\browser.exe': GUI,
  });
  const pathValue = 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd;C:\\Program Files\\Browser';
  const decide = (spawn) => shouldHideWindow({ cwd: 'C:\\work', pathValue, ...spawn }, fake);
  assert.equal(decide({ file: 'C:\\Windows\\System32\\cmd.exe' }), true);
  assert.equal(decide({ file: 'git' }), true);
  // 찾지 못한 대상은 콘솔로 본다.
  assert.equal(decide({ file: 'rg' }), true);
  assert.equal(decide({ file: 'browser' }), false);
  assert.equal(decide({ file: 'git', detached: true }), false);
  assert.equal(decide({ file: 'git', windowsHide: true }), false);
});

test('installWindowsHideConsole defaults async and sync console spawns to windowsHide on Windows', () => {
  const fake = fakeExecutables({
    'C:\\Windows\\System32\\cmd.exe': CONSOLE,
    'C:\\bin\\git.exe': CONSOLE,
    'C:\\bin\\browser.exe': GUI,
  });
  const cp = fakeChildProcess();
  const env = { PATH: 'C:\\Windows\\System32;C:\\bin', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  assert.equal(installWindowsHideConsole({
    platform: 'win32', childProcess: cp.module, env, ...fake,
  }), true);

  // 비동기 스폰은 Node 가 정규화한 옵션으로 ChildProcess.prototype.spawn 을 지난다.
  const child = new cp.module.ChildProcess();
  child.spawn({ file: 'git', args: ['git', 'status'], envPairs: ['Path=C:\\bin'], stdio: 'inherit', windowsHide: false });
  child.spawn({ file: 'browser', args: ['browser'], envPairs: ['PATH=C:\\bin'], windowsHide: false });
  child.spawn({ file: 'git', args: ['git'], envPairs: ['PATH=C:\\bin'], detached: true, windowsHide: false });
  assert.deepEqual(cp.asyncSpawns.map((options) => options.windowsHide), [true, false, false]);

  const userOptions = { stdio: 'inherit' };
  cp.module.spawnSync('git', ['status'], userOptions);
  cp.module.spawnSync('git', { cwd: 'C:\\work' });
  cp.module.execFileSync('browser', ['https://example.test'], { stdio: 'ignore' });
  cp.module.execSync('npm run build', { stdio: 'inherit' });
  cp.module.execSync('dir');
  assert.deepEqual(cp.syncCalls, [
    ['spawnSync', 'git', ['status'], { stdio: 'inherit', windowsHide: true }],
    ['spawnSync', 'git', { cwd: 'C:\\work', windowsHide: true }, undefined],
    ['execFileSync', 'browser', ['https://example.test'], { stdio: 'ignore' }],
    ['execSync', 'npm run build', { stdio: 'inherit', windowsHide: true }],
    ['execSync', 'dir', { windowsHide: true }],
  ]);
  // 호출자가 넘긴 옵션 객체는 바꾸지 않는다.
  assert.deepEqual(userOptions, { stdio: 'inherit' });
  // 두 번 설치해도 한 번만 감싼다.
  assert.equal(installWindowsHideConsole({ platform: 'win32', childProcess: cp.module, env, ...fake }), false);
});

test('installWindowsHideConsole leaves child_process alone off Windows', () => {
  const cp = fakeChildProcess();
  const { spawn } = cp.module.ChildProcess.prototype;
  const { spawnSync: originalSpawnSync } = cp.module;
  assert.equal(installWindowsHideConsole({ platform: 'darwin', childProcess: cp.module }), false);
  assert.equal(cp.module.ChildProcess.prototype.spawn, spawn);
  assert.equal(cp.module.spawnSync, originalSpawnSync);
});

const SPAWN_HIDE_PROBE = fileURLToPath(new URL('./fixtures/spawn-hide-probe.cjs', import.meta.url));

/** npm 이 node_modules\.bin 에 만드는 cmd-shim 그대로다. `"%_prog%"` 는 따옴표 친 `"node"` 다. */
async function writeNpmStyleCmdShim(binDir, name, relativeScript) {
  await fs.mkdir(binDir, { recursive: true });
  const file = path.join(binDir, `${name}.cmd`);
  await fs.writeFile(file, [
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
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relativeScript}" %*`,
    '',
  ].join('\r\n'));
  return file;
}

// 에이전트가 PowerShell/cmd 에서 `node build.js` 를 부르거나, 프로젝트의 node_modules\.bin\*.cmd(`"node"`)와
// Pi 하위 에이전트의 pi.cmd 가 돌면 PATH 의 node.cmd 가 콘솔 없는 Electron 호스트를 띄운다. 그 스크립트가
// 콘솔 프로그램을 stdio 'inherit' 로 띄우면 보이는 새 콘솔 창이 열렸다(live probe). 따옴표 친 이름으로 불린
// node.cmd 는 %~dp0 이 현재 폴더라 프리로드를 못 찾고 호스트가 아예 뜨지 않았다. 부르는 모양마다 스크립트가
// 돌고, 자식 스폰이 OS 에 windowsHide 플래그를 달고 내려가며, 작업 폴더의 같은 이름 파일은 읽지 않는지 본다.
test('node.cmd runs the script with the console-hide preload however it is invoked', async (t) => {
  if (process.platform !== 'win32') { t.skip('cmd.exe only'); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-node-host-hide-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const shimDir = path.join(root, '홍길동', 'node-host');
  const nodeCmd = await writeNodeHostShim(shimDir, process.execPath, { platform: 'win32' });
  const project = path.join(root, 'project (x86)');
  const script = path.join(project, 'node_modules', 'probe', 'cli.cjs');
  await fs.mkdir(path.dirname(script), { recursive: true });
  await fs.writeFile(script, `
const { spawns } = require(${JSON.stringify(SPAWN_HIDE_PROBE)});
const child = require('child_process').spawn(process.env.ComSpec, ['/d', '/c', 'exit 0'], { stdio: 'inherit' });
child.on('exit', () => process.stdout.write(JSON.stringify({ args: process.argv.slice(2), hidden: spawns.map((s) => s.windowsHide) })));
`);
  await writeNpmStyleCmdShim(path.join(project, 'node_modules', '.bin'), 'probe', '..\\probe\\cli.cjs');
  // 작업 폴더에 `node` 항목과 같은 이름의 프리로드가 있어도 node.cmd 는 자기 폴더의 사본만 읽는다.
  await fs.mkdir(path.join(project, 'node'));
  await fs.writeFile(path.join(project, 'rhwp-hide-console.cjs'), "process.stdout.write('PLANTED');\n");

  const { RHWP_NODE_HOST: _host, RHWP_NODE_PRELOAD: _preload, ...baseEnv } = process.env;
  const hostEnv = applyNodeHostEnv(baseEnv, { nodeCommand: process.execPath, shimDir, platform: 'win32' });
  // Pi 처럼 env 를 줄이는 호출자도 있다 — node.cmd 는 허브가 알린 경로 없이도 프리로드를 찾는다.
  delete hostEnv.RHWP_NODE_PRELOAD;
  const run = (commandLine) => spawnSync('cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
    cwd: project, env: hostEnv, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 30_000,
  });
  for (const [commandLine, args] of [
    [`node "${script}" plain`, ['plain']],
    ['node_modules\\.bin\\probe.cmd npm "b c" "x)y"', ['npm', 'b c', 'x)y']],
    [`"${nodeCmd}" "${script}" absolute`, ['absolute']],
  ]) {
    const result = run(commandLine);
    assert.equal(result.status, 0, `${commandLine}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), { args, hidden: [true] }, commandLine);
  }
  // 호스트의 종료 코드가 그대로 돌아온다.
  assert.equal(run('node -e "process.exit(7)"').status, 7);
});

// 패키지 앱의 허브는 콘솔 없는 Electron-as-node 다. 허브 안의 서드파티 코드(cross-spawn, node-pty, MCP SDK,
// Playwright)가 windowsHide 없이 콘솔 프로그램을 띄워도 숨겨지는 것은 허브 기동의 기본값 덕분이다.
test('the real hub defaults console spawns that omit windowsHide to hidden', async (t) => {
  if (process.platform !== 'win32') { t.skip('Windows only'); return; }
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-hub-hide-'));
  const out = path.join(dataRoot, 'probe.json');
  try {
    await startHub(t, {
      nodeArgs: ['--require', SPAWN_HIDE_PROBE],
      env: {
        RHWP_TEST_HUB_SPAWN_PROBE: out,
        // 허브가 쓰는 사용자 폴더를 모두 임시 폴더로 돌린다.
        RHWP_CLI_DIR: path.join(dataRoot, 'cli'),
        RHWP_PI_DIR: path.join(dataRoot, 'pi'),
        RHWP_AGENT_INSTRUCTIONS_DIR: path.join(dataRoot, 'instructions'),
        RHWP_SKILLS_DIR: path.join(dataRoot, 'skills'),
        RHWP_WRITING_STYLE_DIR: path.join(dataRoot, 'writing-style'),
        RHWP_DOCUMENT_MEMORY_DIR: path.join(dataRoot, 'document-memory'),
      },
    });
    await waitForPath(out);
    assert.deepEqual(JSON.parse(await fs.readFile(out, 'utf8')), [true]);
  } finally {
    // startHub 의 정리(허브 종료) 뒤에 돈다.
    t.after(() => fs.rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  }
});
