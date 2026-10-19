import { existsSync as fsExistsSync, readFileSync as fsReadFileSync, realpathSync, promises as fsPromises } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const which = require('which');
const escape = require('cross-spawn/lib/util/escape');

/** cmd.exe 가 한 줄에서 받는 명령 길이 상한. CreateProcessW(~32767)보다 훨씬 낮다. */
export const WINDOWS_CMD_LINE_LIMIT = 8191;

const BATCH_EXT = /\.(?:cmd|bat)$/i;
/** npm/pnpm/yarn cmd-shim: node (or %_prog%) plus a quoted JS entry, forwarding %*. */
const NODE_SHIM_INVOCATION = /(?:^|[\s&])(?:node(?:\.exe)?|"(?:[^"\r\n]*[/\\])?node(?:\.exe)?"|"%_prog%")[ \t]+"([^"\r\n]+\.(?:cjs|mjs|js))"[ \t]+%\*/gi;
/** npm cmd-shim for a package `bin` that is itself a native .exe (Claude Code 2.1.30x+). */
const NATIVE_SHIM_INVOCATION = /(?:^|[\s&])"([^"\r\n]+\.exe)"[ \t]+%\*/gi;
const NODE_BIN = /^(?:node|node\.exe)$/i;
/** `@openai/codex` 플랫폼 패키지와 vendor 아래 대상 폴더. bin/codex.js 의 표와 같다. */
const CODEX_WIN32_TARGETS = Object.freeze({
  x64: { package: 'codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
  arm64: { package: 'codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
});

/**
 * cross-spawn 이 `.cmd` 를 `cmd.exe /c` 로 돌릴 때 실제로 붙는 명령 문자열 길이.
 * JSON/공백/따옴표는 `^` 이스케이프 때문에 원문보다 길어진다.
 *
 * @param {string} command
 * @param {readonly string[]} argv
 * @param {{ doubleEscapeMetaChars?: boolean }} [options]
 */
export function windowsCmdExeCommandLine(command, argv, { doubleEscapeMetaChars = false } = {}) {
  const body = [
    escape.command(String(command)),
    ...argv.map((arg) => escape.argument(String(arg), doubleEscapeMetaChars)),
  ].join(' ');
  return `cmd.exe /d /s /c "${body}"`;
}

export function windowsCmdExeCommandLineLength(command, argv, options) {
  return windowsCmdExeCommandLine(command, argv, options).length;
}

export function isNodeBinary(command) {
  return NODE_BIN.test(path.basename(String(command ?? '')));
}

export function nodeHostNeedsShim(platform, nodeCommand) {
  return platform === 'win32' || !isNodeBinary(nodeCommand);
}

export function nodeHostShimFileName(platform) {
  return platform === 'win32' ? 'node.cmd' : 'node';
}

/**
 * @param {string} dir
 * @param {string} nodeCommand
 * @param {{
 *   platform?: string,
 *   mkdir?: typeof fsPromises.mkdir,
 *   writeFile?: typeof fsPromises.writeFile,
 * }} [options]
 * @returns {Promise<string>}
 */
export async function writeNodeHostShim(dir, nodeCommand, {
  platform = 'win32',
  mkdir = fsPromises.mkdir,
  writeFile = fsPromises.writeFile,
} = {}) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, nodeHostShimFileName(platform));
  const exe = String(nodeCommand ?? '').replace(/"/g, '');
  if (platform === 'win32') {
    await writeFile(file, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exe}" %*\r\n`);
  } else {
    await writeFile(file, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${exe}" "$@"\n`, { mode: 0o755 });
  }
  return file;
}

/**
 * @param {{
 *   rootDir: string,
 *   nodeCommand: string,
 *   platform: string,
 *   mkdir?: typeof fsPromises.mkdir,
 *   writeFile?: typeof fsPromises.writeFile,
 * }} options
 * @returns {() => Promise<string | null>}
 */
export function createNodeHost({ rootDir, nodeCommand, platform, mkdir, writeFile }) {
  const nodeHostDir = path.join(rootDir, 'node-host');
  /** @type {Promise<string> | null} */
  let ready = null;
  return async function ensureNodeHost() {
    if (!nodeHostNeedsShim(platform, nodeCommand)) return null;
    ready ??= writeNodeHostShim(nodeHostDir, nodeCommand, { platform, mkdir, writeFile });
    try {
      await ready;
    } catch (error) {
      ready = null;
      throw error;
    }
    return nodeHostDir;
  };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ nodeCommand?: string, shimDir?: string | null, platform?: string }} [options]
 * @returns {NodeJS.ProcessEnv}
 */
export function applyNodeHostEnv(env, { nodeCommand, shimDir, platform = 'win32' } = {}) {
  const next = { ...env };
  const delimiter = platform === 'win32' ? ';' : ':';
  if (shimDir) {
    const current = next.PATH ?? next.Path ?? '';
    next.PATH = current ? `${shimDir}${delimiter}${current}` : shimDir;
    if (platform === 'win32') next.Path = next.PATH;
  }
  if (nodeCommand) next.npm_node_execpath = nodeCommand;
  if (nodeCommand && !isNodeBinary(nodeCommand)) next.ELECTRON_RUN_AS_NODE = '1';
  return next;
}

function expandCmdVars(raw, cmdFile) {
  const dir = path.dirname(path.resolve(cmdFile));
  const dirSlash = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
  return String(raw)
    .replace(/%~dp0/gi, dirSlash)
    .replace(/%dp0%[/\\]?/gi, dirSlash)
    .replace(/\\/g, path.sep);
}

/**
 * npm/pnpm/yarn 이 쓰는 Windows `.cmd` 심에서 Node 엔트리 스크립트 경로를 꺼낸다.
 * node/`%_prog%` 가 `%*` 를 넘기는 호출만 인정하고, 그 스크립트가 실제로 있을 때만
 * 경로를 돌려준다. 그 외 배치 파일은 null — 호출자가 원래 `.cmd` 를 유지한다.
 *
 * @param {string} cmdPath
 * @param {string} contents
 * @param {{ existsSync?: typeof fsExistsSync }} [deps]
 * @returns {string | null}
 */
export function parseNpmCmdShimScript(cmdPath, contents, deps = {}) {
  const existsSync = deps.existsSync ?? fsExistsSync;
  for (const match of String(contents).matchAll(NODE_SHIM_INVOCATION)) {
    const resolved = path.resolve(expandCmdVars(match[1], cmdPath));
    if (resolved !== path.resolve(cmdPath) && existsSync(resolved)) return resolved;
  }
  return null;
}

/**
 * npm 이 네이티브 `.exe` bin 에 만드는 `.cmd` 심에서 실행 파일 경로를 꺼낸다.
 * node.exe 는 제외한다 (스크립트 없는 node 호출은 위 파서의 몫이 아니다).
 *
 * @param {string} cmdPath
 * @param {string} contents
 * @param {{ existsSync?: typeof fsExistsSync }} [deps]
 * @returns {string | null}
 */
export function parseNativeCmdShimExecutable(cmdPath, contents, deps = {}) {
  const existsSync = deps.existsSync ?? fsExistsSync;
  for (const match of String(contents).matchAll(NATIVE_SHIM_INVOCATION)) {
    const resolved = path.resolve(expandCmdVars(match[1], cmdPath));
    if (!isNodeBinary(resolved) && existsSync(resolved)) return resolved;
  }
  return null;
}

/**
 * npm `@openai/codex` 의 bin/codex.js 는 플랫폼 패키지의 codex.exe 를 stdio inherit 로 다시 띄우는
 * 래퍼다. 호스트가 Electron(GUI 서브시스템)이면 물려줄 콘솔이 없어 그 codex.exe 가 보이는 새 콘솔
 * 창을 연다. 래퍼가 하는 일(실행 파일 탐색과 패키지 env)을 여기서 하고 codex.exe 를 바로 띄운다.
 * 래퍼가 아니거나 실행 파일이 없으면 null — 호출자가 node + 스크립트로 띄운다.
 *
 * @param {string} script
 * @param {{ arch?: string, existsSync?: typeof fsExistsSync, readFileSync?: typeof fsReadFileSync }} [deps]
 * @returns {{ command: string, leadingArgs: string[], env: Record<string, string> } | null}
 */
function resolveCodexWrapperLaunch(script, deps = {}) {
  const existsSync = deps.existsSync ?? fsExistsSync;
  const readFileSync = deps.readFileSync ?? fsReadFileSync;
  if (path.basename(script) !== 'codex.js' || path.basename(path.dirname(script)) !== 'bin') return null;
  const packageRoot = path.dirname(path.dirname(script));
  try {
    if (JSON.parse(String(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))).name !== '@openai/codex') return null;
  } catch {
    return null;
  }
  const target = CODEX_WIN32_TARGETS[deps.arch ?? process.arch];
  if (!target) return null;
  // codex.js 는 require.resolve 로 플랫폼 패키지를 찾고(중첩, 그다음 호이스팅), 없으면 자기 vendor 를 쓴다.
  const vendorRoots = [
    path.join(packageRoot, 'node_modules', '@openai', target.package, 'vendor'),
    path.join(packageRoot, '..', target.package, 'vendor'),
    path.join(packageRoot, 'vendor'),
  ];
  for (const vendorRoot of vendorRoots) {
    const executable = path.resolve(vendorRoot, target.triple, 'bin', 'codex.exe');
    if (!existsSync(executable)) continue;
    let managedRoot = packageRoot;
    try { managedRoot = realpathSync(packageRoot); } catch { /* codex.js 와 같은 값을 못 얻으면 경로 그대로 */ }
    return {
      command: executable,
      leadingArgs: [],
      env: { CODEX_MANAGED_PACKAGE_ROOT: managedRoot, CODEX_MANAGED_BY_NPM: '1' },
    };
  }
  return null;
}

function resolveWindowsCommand(command, deps = {}) {
  const existsSync = deps.existsSync ?? fsExistsSync;
  const whichSync = deps.whichSync ?? ((cmd, opt) => which.sync(cmd, { ...opt, nothrow: true }));
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    if (existsSync(command)) return command;
    if (!path.extname(command)) {
      for (const ext of ['.cmd', '.bat']) {
        const candidate = `${command}${ext}`;
        if (existsSync(candidate)) return candidate;
      }
    }
    return null;
  }
  return whichSync(command, { path: (deps.env ?? process.env).PATH }) ?? null;
}

/**
 * Windows 에서 npm `.cmd` 심을 node + JS 엔트리로 풀어 cmd.exe 8191 상한을 피한다.
 * Codex 래퍼(bin/codex.js)면 그 래퍼가 띄울 플랫폼 codex.exe 로 바로 풀어 콘솔 창을 막는다.
 * 그 외 플랫폼/네이티브 바이너리는 그대로 둔다.
 *
 * @param {string} command
 * @param {{
 *   platform?: NodeJS.Platform,
 *   nodeCommand?: string,
 *   env?: NodeJS.ProcessEnv,
 *   existsSync?: typeof fsExistsSync,
 *   readFileSync?: typeof fsReadFileSync,
 *   whichSync?: Function,
 *   arch?: string,
 * }} [deps]
 * @returns {{ command: string, leadingArgs: string[], env: Record<string, string> }}
 */
export function resolveNpmCliLaunch(command, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const nodeCommand = deps.nodeCommand ?? process.execPath;
  const requested = String(command ?? '');
  if (platform !== 'win32') return { command: requested, leadingArgs: [], env: {} };

  const resolved = resolveWindowsCommand(requested, deps);
  if (!resolved || !BATCH_EXT.test(resolved)) {
    return { command: resolved ?? requested, leadingArgs: [], env: {} };
  }

  let contents = '';
  try {
    contents = String((deps.readFileSync ?? fsReadFileSync)(resolved, 'utf8'));
  } catch {
    return { command: resolved, leadingArgs: [], env: {} };
  }
  const script = parseNpmCmdShimScript(resolved, contents, deps);
  if (!script) {
    // 네이티브 .exe 를 감싼 심은 exe 를 직접 띄운다. cmd.exe 를 거치면 8191 상한에 걸리고
    // Agent SDK 는 .cmd 를 spawn 하지 못한다 (EINVAL).
    const native = parseNativeCmdShimExecutable(resolved, contents, deps);
    return { command: native ?? resolved, leadingArgs: [], env: {} };
  }
  const codex = resolveCodexWrapperLaunch(script, deps);
  if (codex) return codex;

  return {
    command: nodeCommand,
    leadingArgs: [script],
    env: isNodeBinary(nodeCommand) ? {} : { ELECTRON_RUN_AS_NODE: '1' },
  };
}

/**
 * bare 명령 이름을 env.PATH 에서 절대 경로로 찾는다. 이미 경로 구분자를 포함한
 * 값은 존재할 때만 절대 경로로 돌려준다. 못 찾으면 null — 호출자가 폴백을 고른다.
 * Agent SDK 처럼 PATH 를 스스로 탐색하지 않는 스폰 소비자가 spawn 과 같은
 * 바이너리를 가리키게 하는 공용 해석기다.
 *
 * @param {string} command
 * @param {{ env?: NodeJS.ProcessEnv, existsSync?: typeof fsExistsSync, whichSync?: Function }} [deps]
 * @returns {string | null}
 */
export function resolveCommandOnPath(command, deps = {}) {
  const existsSync = deps.existsSync ?? fsExistsSync;
  const whichSync = deps.whichSync ?? ((cmd, opt) => which.sync(cmd, { ...opt, nothrow: true }));
  const requested = String(command ?? '');
  if (!requested) return null;
  if (path.isAbsolute(requested) || requested.includes('/') || requested.includes('\\')) {
    const resolved = path.resolve(requested);
    return existsSync(resolved) ? resolved : null;
  }
  return whichSync(requested, { path: (deps.env ?? process.env).PATH }) ?? null;
}

/**
 * @param {string} command
 * @param {readonly string[]} argv
 * @param {Parameters<typeof resolveNpmCliLaunch>[1]} [deps]
 */
export function applyNpmCliLaunch(command, argv, deps) {
  const launch = resolveNpmCliLaunch(command, deps);
  return {
    command: launch.command,
    argv: [...launch.leadingArgs, ...argv],
    env: launch.env,
  };
}

/**
 * Windows 관리형 CLI 스폰 계약: Node-host PATH 를 붙인 뒤 npm `.cmd` 를 unwrap 한다.
 *
 * @param {string} command
 * @param {readonly string[]} argv
 * @param {Parameters<typeof resolveNpmCliLaunch>[1] & {
 *   env?: NodeJS.ProcessEnv,
 *   shimDir?: string | null,
 * }} [deps]
 */
export function applyManagedCliLaunch(command, argv, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const nodeCommand = deps.nodeCommand ?? process.execPath;
  const env = deps.env;
  const resolvedEnv = deps.shimDir
    ? applyNodeHostEnv(env ?? {}, { nodeCommand, shimDir: deps.shimDir, platform })
    : env;
  const launched = applyNpmCliLaunch(command, argv, {
    ...deps,
    platform,
    nodeCommand,
    ...(resolvedEnv !== undefined ? { env: resolvedEnv } : {}),
  });
  if (resolvedEnv !== undefined) {
    return {
      command: launched.command,
      argv: launched.argv,
      env: { ...resolvedEnv, ...launched.env },
    };
  }
  const extra = launched.env;
  if (!extra || Object.keys(extra).length === 0) {
    return { command: launched.command, argv: launched.argv, env: undefined };
  }
  return {
    command: launched.command,
    argv: launched.argv,
    env: { ...process.env, ...extra },
  };
}
