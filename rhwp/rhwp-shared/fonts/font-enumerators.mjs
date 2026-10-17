// 운영체제가 알고 있는 글꼴 목록에서 카탈로그 폴더 밖에 설치된 글꼴을 찾는다 (Node 전용).
//   - Windows: 글꼴 레지스트리(HKLM·HKCU). 절대 경로 값만 파일 루트로 쓴다. 파일 이름만 있는 값은
//     %WINDIR%\Fonts 기준이라 카탈로그가 이미 다룬다.
//   - Linux 등: fontconfig `fc-list`. 카탈로그 밖 파일의 부모 폴더를 그 폴더만 보는 루트로 쓴다.
// 명령이 없거나 실패하거나 시간 안에 끝나지 않으면 빈 목록이다. 파서는 순수 함수다.
import { execFile } from 'node:child_process';
import path from 'node:path';

import { FONT_EXTENSIONS, pathKey } from './font-index-core.mjs';
import { expandRootPath } from './font-roots.mjs';

export const ENUMERATOR_TIMEOUT_MS = 3000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export const WINDOWS_FONT_REGISTRY_KEYS = Object.freeze([
  { key: 'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', kind: 'user' },
  { key: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', kind: 'system' },
]);

/** 값 줄: 4칸 들여쓰기, 이름, REG_SZ 또는 REG_EXPAND_SZ, 값. 칸 사이는 공백 4개다. */
const REG_VALUE_LINE = /^ {4}(.+?) {4}(REG_SZ|REG_EXPAND_SZ) {4}(.*)$/;
const WINDOWS_ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/])/;

/**
 * `reg query <글꼴 키>` 출력에서 글꼴 값을 읽는다.
 * @returns {Array<{ name: string, type: 'REG_SZ'|'REG_EXPAND_SZ', value: string }>}
 */
export function parseRegQueryFonts(text) {
  const values = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = REG_VALUE_LINE.exec(line);
    if (!match) continue;
    const value = match[3].trim();
    if (value) values.push({ name: match[1].trim(), type: /** @type {'REG_SZ'|'REG_EXPAND_SZ'} */ (match[2]), value });
  }
  return values;
}

function isUnder(target, base, pathApi, platform) {
  const relative = pathApi.relative(pathKey(base, platform), pathKey(target, platform));
  return relative === '' || (!!relative && !relative.startsWith('..') && !pathApi.isAbsolute(relative));
}

function coveredBy(target, covered, pathApi, platform) {
  return covered.some((base) => isUnder(target, base, pathApi, platform));
}

/**
 * 레지스트리 값 가운데 카탈로그 폴더 밖의 절대 경로 글꼴 파일만 루트로 바꾼다.
 * @param {Array<{ kind: 'user'|'system', values: ReturnType<typeof parseRegQueryFonts> }>} sources
 * @param {{ covered?: string[], env?: Record<string, string|undefined> }} options
 */
export function windowsRegistryFontRoots(sources, { covered = [], env = {} } = {}) {
  const pathApi = path.win32;
  const seen = new Set();
  const roots = [];
  for (const { kind, values } of sources) {
    for (const { type, value } of values) {
      const expanded = type === 'REG_EXPAND_SZ' ? expandRootPath(value, { platform: 'win32', env }) : value;
      if (!expanded || !WINDOWS_ABSOLUTE.test(expanded)) continue;
      const file = pathApi.normalize(expanded);
      if (!FONT_EXTENSIONS.has(pathApi.extname(file).toLowerCase())) continue;
      if (coveredBy(file, covered, pathApi, 'win32')) continue;
      const key = pathKey(file, 'win32');
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push({ path: file, kind, label: 'Windows registry' });
    }
  }
  return roots;
}

/** `fc-list --format '%{file}\n'` 출력에서 글꼴 파일 경로를 읽는다. */
export function parseFcListFiles(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/'));
}

/**
 * 카탈로그 폴더 밖 글꼴 파일의 부모 폴더를 루트로 바꾼다. fontconfig 가 파일을 하나하나
 * 알려 주므로 하위 폴더는 보지 않는다 (maxDepth 0).
 */
export function fontconfigFontRoots(files, { covered = [] } = {}) {
  const pathApi = path.posix;
  const seen = new Set();
  const roots = [];
  for (const file of files) {
    const normalized = pathApi.normalize(file);
    if (coveredBy(normalized, covered, pathApi, 'linux')) continue;
    const dir = pathApi.dirname(normalized);
    if (seen.has(dir)) continue;
    seen.add(dir);
    roots.push({ path: dir, kind: 'system', label: 'fontconfig', maxDepth: 0 });
  }
  return roots;
}

/** 출력은 보통 UTF-8 이지만 reg.exe 는 콘솔 코드 페이지(한국어 Windows 는 CP949)로 쓸 수 있다. */
function decodeOutput(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('euc-kr').decode(bytes);
    } catch {
      return Buffer.from(bytes).toString('latin1');
    }
  }
}

/** 명령을 시간 제한 안에서 돌린다. 실패하면 null. */
export function runFontCommand(command, args, { timeoutMs = ENUMERATOR_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(command, args, {
        encoding: 'buffer',
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      }, (error, stdout) => resolve(error ? null : decodeOutput(stdout)));
    } catch {
      resolve(null);
    }
  });
}

/**
 * 이 플랫폼의 운영체제 글꼴 목록에서 카탈로그 밖 루트를 찾는다. 다른 플랫폼이면 빈 배열.
 * @param {{ platform: string, covered: string[], env?: Record<string, string|undefined>,
 *   runCommand?: (command: string, args: string[]) => Promise<string|null> }} options
 */
export async function enumerateOsFontRoots({ platform, covered, env = {}, runCommand = runFontCommand }) {
  if (platform === 'win32') {
    // PATH 에 끼어든 다른 reg 가 아니라 시스템 reg.exe 를 부른다.
    const systemRoot = expandRootPath('%SystemRoot%', { platform, env });
    const reg = systemRoot ? path.win32.join(systemRoot, 'System32', 'reg.exe') : 'reg';
    const sources = await Promise.all(WINDOWS_FONT_REGISTRY_KEYS.map(async ({ key, kind }) => ({
      kind,
      values: parseRegQueryFonts(await runCommand(reg, ['query', key])),
    })));
    return windowsRegistryFontRoots(sources, { covered, env });
  }
  if (platform === 'darwin') return [];
  return fontconfigFontRoots(parseFcListFiles(await runCommand('fc-list', ['--format', '%{file}\\n'])), { covered });
}
