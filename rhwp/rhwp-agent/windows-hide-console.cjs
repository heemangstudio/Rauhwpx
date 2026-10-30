'use strict';

/**
 * Windows 콘솔 창 숨김 기본값.
 *
 * 패키지 앱의 Node 호스트(HamaEditor.exe + ELECTRON_RUN_AS_NODE)는 GUI 서브시스템이라 콘솔이 없다.
 * 그 프로세스가 콘솔 프로그램(cmd, git, codex.exe …)을 stdio 'inherit' 로 띄우면 Windows 가 보이는
 * 새 콘솔 창(Windows Terminal 위임 포함)을 연다. 에이전트가 PowerShell/cmd 에서 `node script.js` 를
 * 부르면 PATH 의 node.cmd 가 이 호스트를 띄우므로, 빌드 스크립트의 execSync(..., { stdio: 'inherit' })
 * 같은 평범한 코드가 창을 띄운다.
 *
 * 이 모듈은 child_process 에 windowsHide 기본값을 건다. 대상이 GUI 서브시스템 실행 파일이면 그대로
 * 둔다(SW_HIDE 로 브라우저·편집기 창이 숨지 않게). detached 스폰도 그대로 둔다(의도적으로 따로 띄운
 * 프로그램). 그 외에는 windowsHide: true — 콘솔이 없는 부모에서도 자식 콘솔이 숨겨진다.
 *
 * node.cmd 와 관리형 CLI 실행은 `--require` 로 이 파일을 먼저 읽는다(module.isPreloading 이면 바로 설치).
 * 허브는 installWindowsHideConsole() 을 직접 부른다. Windows 가 아니면 아무것도 하지 않는다.
 * 이 파일은 node-host 폴더로 그대로 복사되므로 Node 내장 모듈 외에는 불러오지 않는다.
 */

const path = require('path').win32;

const INSTALLED = Symbol.for('rhwp.windowsHideConsole');
const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;

/** PE 헤더의 Subsystem 값(2 = GUI, 3 = 콘솔). PE 가 아니거나 읽지 못하면 null. */
function readPeSubsystem(file, fs = require('fs')) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const dos = Buffer.alloc(64);
    if (fs.readSync(fd, dos, 0, dos.length, 0) < dos.length || dos.readUInt16LE(0) !== 0x5a4d) return null;
    const peOffset = dos.readUInt32LE(0x3c);
    // 'PE\0\0'(4) + COFF 헤더(20) + 선택적 헤더의 Subsystem 위치(68, PE32/PE32+ 공통) + 2
    const pe = Buffer.alloc(4 + 20 + 70);
    if (fs.readSync(fd, pe, 0, pe.length, peOffset) < pe.length || pe.readUInt32LE(0) !== 0x00004550) return null;
    return pe.readUInt16LE(4 + 20 + 68);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* 이미 닫혔다 */ }
    }
  }
}

function defaultIsFile(file) {
  try {
    return require('fs').statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * libuv 의 Windows 실행 파일 탐색(search_path)을 따라 간다: 경로가 있으면 cwd 기준 그 위치만,
 * 이름만 있으면 cwd 다음 PATH 순서. 확장자가 있으면 그대로 먼저, 이어서 .com, .exe 를 붙인다.
 * 못 찾으면 null.
 */
function resolveWindowsExecutable(file, { cwd, pathValue, isFile = defaultIsFile } = {}) {
  const name = String(file ?? '').replace(/^"(.*)"$/, '$1');
  if (!name) return null;
  const base = cwd || process.cwd();
  const candidates = (target) => [
    ...(path.extname(target) ? [target] : []),
    `${target}.com`,
    `${target}.exe`,
  ];
  const dirs = /[\\/]/.test(name) || path.isAbsolute(name)
    ? [null]
    : [base, ...String(pathValue ?? '').split(';').map((dir) => dir.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)];
  for (const dir of dirs) {
    const target = dir === null ? path.resolve(base, name) : path.resolve(base, dir, name);
    for (const candidate of candidates(target)) {
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 스폰 하나에 windowsHide 를 켤지. 이미 켰거나 detached 면 건드리지 않는다. 대상이 GUI 서브시스템
 * .exe 로 확인될 때만 그대로 둔다 — 찾지 못한 대상은 콘솔로 보고 숨긴다(cmd/셸 래퍼 포함).
 *
 * @param {{ file?: string, cwd?: string, pathValue?: string, detached?: boolean, windowsHide?: boolean }} spawn
 * @param {{ isFile?: (file: string) => boolean, readSubsystem?: (file: string) => number | null }} [deps]
 */
function shouldHideWindow(spawn, deps = {}) {
  if (!spawn || spawn.windowsHide === true || spawn.detached === true) return false;
  const executable = resolveWindowsExecutable(spawn.file, {
    cwd: spawn.cwd, pathValue: spawn.pathValue, isFile: deps.isFile,
  });
  if (executable && /\.(?:exe|com)$/i.test(executable)) {
    const subsystem = (deps.readSubsystem ?? readPeSubsystem)(executable);
    if (subsystem === IMAGE_SUBSYSTEM_WINDOWS_GUI) return false;
  }
  return true;
}

function envPath(env) {
  if (!env || typeof env !== 'object') return undefined;
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  return key === undefined ? undefined : env[key];
}

function envPairsPath(pairs) {
  if (!Array.isArray(pairs)) return undefined;
  const entry = pairs.find((pair) => typeof pair === 'string' && /^path=/i.test(pair));
  return entry === undefined ? undefined : entry.slice(5);
}

/**
 * child_process 에 windowsHide 기본값을 건다. 비동기 스폰(spawn/exec/execFile/fork)은 모두
 * ChildProcess.prototype.spawn 의 정규화된 옵션을 지나므로 그 한 곳을 감싼다. 동기 스폰은 공개
 * spawnSync/execFileSync/execSync 를 감싸 옵션 사본에 windowsHide 를 얹는다. 프리로드는 사용자 코드보다
 * 먼저 돌아 ESM 의 `import { execSync } from 'node:child_process'` 도 감싼 함수를 본다. 허브처럼 나중에
 * 설치하면 이미 묶인 ESM 이름은 그대로다(syncBuiltinESMExports 는 다른 내장 모듈까지 바꾸므로 부르지 않는다).
 *
 * @param {{
 *   platform?: string,
 *   childProcess?: any,
 *   env?: NodeJS.ProcessEnv,
 *   isFile?: (file: string) => boolean,
 *   readSubsystem?: (file: string) => number | null,
 * }} [options]
 * @returns {boolean} 이번 호출에서 새로 설치했는지
 */
function installWindowsHideConsole({
  platform = process.platform,
  childProcess = require('child_process'),
  env = process.env,
  isFile,
  readSubsystem,
} = {}) {
  if (platform !== 'win32' || !childProcess || childProcess[INSTALLED]) return false;
  const deps = { isFile, readSubsystem };
  const decide = (spawn) => {
    try {
      return shouldHideWindow(spawn, deps);
    } catch {
      return !spawn?.detached && spawn?.windowsHide !== true;
    }
  };

  const proto = childProcess.ChildProcess && childProcess.ChildProcess.prototype;
  if (proto && typeof proto.spawn === 'function') {
    const originalSpawn = proto.spawn;
    proto.spawn = function spawn(options) {
      if (options && typeof options === 'object' && decide({
        file: options.file,
        cwd: options.cwd,
        pathValue: envPairsPath(options.envPairs) ?? envPath(env),
        detached: options.detached,
        windowsHide: options.windowsHide,
      })) {
        // normalizeSpawnArguments 가 호출마다 새로 만든 내부 객체다.
        options.windowsHide = true;
      }
      return originalSpawn.call(this, options);
    };
  }

  const shellFile = (shell, spawnEnv) => (typeof shell === 'string' && shell
    ? shell
    : (spawnEnv?.ComSpec ?? spawnEnv?.COMSPEC ?? env.ComSpec ?? 'cmd.exe'));
  // 사용자 옵션 객체는 바꾸지 않고 사본에 windowsHide 를 얹는다. 잘못된 인자는 Node 가 그대로 거절하게 둔다.
  const hiddenOptions = (file, options, { shell = false } = {}) => {
    if (options != null && typeof options !== 'object') return options;
    const current = options ?? {};
    const spawnEnv = current.env ?? env;
    if (!decide({
      file: shell || current.shell ? shellFile(current.shell, spawnEnv) : file,
      cwd: current.cwd,
      pathValue: envPath(spawnEnv),
      detached: current.detached,
      windowsHide: current.windowsHide,
    })) return options;
    return { ...current, windowsHide: true };
  };
  // spawnSync(file, args?, options?) / execFileSync(file, args?, options?) 의 인자 모양을 Node 와 같게 푼다.
  const wrapFileSync = (original) => function wrapped(file, args, options, ...rest) {
    if (Array.isArray(args) || args == null) {
      return original.call(this, file, args, hiddenOptions(file, options), ...rest);
    }
    if (typeof args === 'object') return original.call(this, file, hiddenOptions(file, args), options, ...rest);
    return original.call(this, file, args, options, ...rest);
  };
  if (typeof childProcess.spawnSync === 'function') childProcess.spawnSync = wrapFileSync(childProcess.spawnSync);
  if (typeof childProcess.execFileSync === 'function') childProcess.execFileSync = wrapFileSync(childProcess.execFileSync);
  if (typeof childProcess.execSync === 'function') {
    const originalExecSync = childProcess.execSync;
    // execSync 는 언제나 셸(cmd.exe 또는 options.shell)을 띄운다.
    childProcess.execSync = function execSync(command, options, ...rest) {
      return originalExecSync.call(this, command, hiddenOptions(null, options, { shell: true }), ...rest);
    };
  }
  try {
    Object.defineProperty(childProcess, INSTALLED, { value: true });
  } catch {
    childProcess[INSTALLED] = true;
  }
  return true;
}

module.exports = {
  installWindowsHideConsole,
  readPeSubsystem,
  resolveWindowsExecutable,
  shouldHideWindow,
};

// node.cmd / 관리형 CLI 가 `--require` 로 읽을 때만 바로 설치한다. 일반 require/import 는 부작용이 없다.
if (module.isPreloading === true) installWindowsHideConsole();
