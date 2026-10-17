// 운영체제별 글꼴 폴더 목록. 데스크톱 main 프로세스와 로컬 허브가 함께 쓴다 (Node 전용, Electron 불필요).
//
// 항목: { os, kind, label, path | glob, sniff?, maxDepth? }
//   - path: 그대로 쓰는 경로. glob: 경로 조각마다 `*` 를 폴더 이름과 맞춘다.
//   - `~` 는 홈 폴더, `%VAR%` 는 (win32에서) 환경 변수로 바꾼다. 없는 변수가 있으면 항목을 건너뛴다.
//   - kind: hancom(한컴 설치 루트: 안에서 Fonts/TTF/HFT 폴더를 찾는다) · user · system · app
//     (다른 앱이 자기용으로 둔 글꼴). 같은 글꼴이 여러 곳에 있으면 이 순서로 고른다.
//   - sniff: 확장자와 상관없이 첫 4바이트가 SFNT/TTC 서명인 파일도 받는다 (숨김·무확장자 캐시).
//   - maxDepth: 이 루트만의 탐색 깊이 (기본은 FONT_SCAN_LIMITS.maxDepth).
// 없는 폴더는 조용히 건너뛴다. 권한이 막힌 폴더도 오류 없이 건너뛴다.
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** @type {ReadonlyArray<import('./font-roots.d.mts').FontRootEntry>} */
export const FONT_ROOT_CATALOG = Object.freeze([
  // ── macOS ──
  { os: 'darwin', kind: 'system', label: 'macOS', path: '/System/Library/Fonts' },
  { os: 'darwin', kind: 'system', label: 'macOS supplemental', path: '/System/Library/Fonts/Supplemental' },
  { os: 'darwin', kind: 'system', label: 'Library fonts', path: '/Library/Fonts' },
  { os: 'darwin', kind: 'system', label: 'Apple app fonts', path: '/Library/Application Support/Apple/Fonts' },
  { os: 'darwin', kind: 'system', label: 'macOS downloadable fonts', glob: '/System/Library/AssetsV2/com_apple_MobileAsset_Font*' },
  {
    os: 'darwin',
    kind: 'system',
    label: 'macOS preinstalled fonts',
    glob: '/System/Library/AssetsV2/PreinstalledAssetsV2/InstallWithOs/com_apple_MobileAsset_Font*',
  },
  // 옆의 Subsets 폴더는 일부 글리프만 담은 부분 글꼴이라 넣지 않는다.
  {
    os: 'darwin',
    kind: 'system',
    label: 'macOS font services',
    path: '/System/Library/PrivateFrameworks/FontServices.framework/Versions/A/Resources/Fonts/ApplicationSupport',
  },
  { os: 'darwin', kind: 'user', label: 'user fonts', path: '~/Library/Fonts' },
  // Microsoft Office for Mac 은 맑은 고딕 등을 앱 번들 DFonts 에 둔다. Windows 판과 같은 판본이라
  // 시스템 사본보다 먼저 고르도록 user 로 둔다.
  { os: 'darwin', kind: 'user', label: 'Microsoft Office', glob: '/Applications/Microsoft *.app/Contents/Resources/DFonts' },
  { os: 'darwin', kind: 'user', label: 'Microsoft Office', glob: '~/Applications/Microsoft *.app/Contents/Resources/DFonts' },
  // Office 클라우드 글꼴은 그룹 컨테이너 안에 있어 읽으면 다른 앱 데이터 접근 확인 창이 뜰 수 있다. 넣지 않는다.
  {
    os: 'darwin',
    kind: 'app',
    label: 'Adobe Fonts',
    path: '~/Library/Application Support/Adobe/CoreSync/plugins/livetype',
    sniff: true,
  },
  { os: 'darwin', kind: 'app', label: 'Adobe Acrobat', glob: '/Applications/Adobe Acrobat*.app/Contents/Resources/Resource/CIDFont' },
  { os: 'darwin', kind: 'app', label: 'Adobe Acrobat', glob: '/Applications/Adobe Acrobat*.app/Contents/Resources/Resource/Font' },
  { os: 'darwin', kind: 'app', label: 'Adobe Acrobat', glob: '/Applications/Adobe Acrobat*/Adobe Acrobat*.app/Contents/Resources/Resource/CIDFont' },
  { os: 'darwin', kind: 'app', label: 'Adobe Acrobat', glob: '/Applications/Adobe Acrobat*/Adobe Acrobat*.app/Contents/Resources/Resource/Font' },
  { os: 'darwin', kind: 'app', label: 'LibreOffice', path: '/Applications/LibreOffice.app/Contents/Resources/fonts' },

  // ── Windows ──
  { os: 'win32', kind: 'system', label: 'Windows', path: '%WINDIR%\\Fonts' },
  { os: 'win32', kind: 'system', label: 'Windows', path: '%SystemRoot%\\Fonts' },
  { os: 'win32', kind: 'user', label: 'user fonts', path: '%LOCALAPPDATA%\\Microsoft\\Windows\\Fonts' },
  { os: 'win32', kind: 'hancom', label: 'Hancom Office', path: '%ProgramFiles%\\Hnc' },
  { os: 'win32', kind: 'hancom', label: 'Hancom Office', path: '%ProgramFiles(x86)%\\Hnc' },
  { os: 'win32', kind: 'hancom', label: 'Hancom Office', path: '%ProgramW6432%\\Hnc' },
  { os: 'win32', kind: 'hancom', label: 'Hancom Office', path: '%CommonProgramFiles%\\Hnc' },
  { os: 'win32', kind: 'hancom', label: 'Hancom Office', path: '%CommonProgramFiles(x86)%\\Hnc' },
  { os: 'win32', kind: 'app', label: 'Microsoft Office', path: '%ProgramFiles%\\Microsoft Office\\root\\vfs\\Fonts\\private' },
  { os: 'win32', kind: 'app', label: 'Microsoft Office', path: '%ProgramFiles(x86)%\\Microsoft Office\\root\\vfs\\Fonts\\private' },
  {
    os: 'win32',
    kind: 'app',
    label: 'Microsoft Office cloud fonts',
    path: '%LOCALAPPDATA%\\Microsoft\\FontCache\\4\\CloudFonts',
    sniff: true,
  },
  { os: 'win32', kind: 'app', label: 'Adobe Fonts', path: '%APPDATA%\\Adobe\\CoreSync\\plugins\\livetype', sniff: true },
  { os: 'win32', kind: 'app', label: 'LibreOffice', path: '%ProgramFiles%\\LibreOffice\\share\\fonts' },

  // ── Linux 등 ──
  { os: 'linux', kind: 'system', label: 'system fonts', path: '/usr/share/fonts' },
  { os: 'linux', kind: 'system', label: 'local fonts', path: '/usr/local/share/fonts' },
  { os: 'linux', kind: 'user', label: 'user fonts', path: '~/.local/share/fonts' },
  { os: 'linux', kind: 'user', label: 'user fonts', path: '~/.fonts' },
  { os: 'linux', kind: 'hancom', label: 'Hancom Office', path: '/opt/hnc' },
  { os: 'linux', kind: 'app', label: 'LibreOffice', path: '/usr/lib/libreoffice/share/fonts' },
  { os: 'linux', kind: 'app', label: 'LibreOffice', glob: '/opt/libreoffice*/share/fonts' },
]);

/** darwin·win32 밖의 플랫폼은 linux 항목을 쓴다. */
function catalogOs(platform) {
  return platform === 'darwin' || platform === 'win32' ? platform : 'linux';
}

function lookupEnv(env, name, platform) {
  if (Object.hasOwn(env, name)) return env[name];
  if (platform !== 'win32') return undefined;
  // Windows 환경 변수 이름은 대소문자를 가리지 않는다.
  const lower = name.toLowerCase();
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : env[key];
}

/** `~` 와 `%VAR%` 를 푼다. 비어 있거나 없는 변수가 있으면 null. */
export function expandRootPath(target, { platform, env = {}, home }) {
  let value = String(target);
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    if (!home) return null;
    value = home + value.slice(1);
  }
  if (platform === 'win32') {
    let missing = false;
    value = value.replace(/%([^%]+)%/g, (_, name) => {
      const resolved = lookupEnv(env, name, platform);
      if (!resolved) missing = true;
      return resolved ?? '';
    });
    if (missing) return null;
  }
  return value;
}

function wildcardRegExp(segment) {
  const escaped = segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

async function listDirNames(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const names = [];
    for (const entry of entries) {
      if (entry.isDirectory()) names.push(entry.name);
      else if (entry.isSymbolicLink()) {
        try {
          if ((await fs.stat(path.join(dir, entry.name))).isDirectory()) names.push(entry.name);
        } catch {
          // 끊어진 링크
        }
      }
    }
    return names;
  } catch {
    return [];
  }
}

/** 경로 조각의 `*` 를 실제 폴더 이름으로 펼친다. 맞는 폴더가 없으면 빈 배열. */
export async function expandGlob(pattern, pathApi, listDir = listDirNames) {
  const parsed = pathApi.parse(pattern);
  const segments = pattern.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  let bases = [parsed.root || '.'];
  for (const segment of segments) {
    if (!segment.includes('*')) {
      bases = bases.map((base) => pathApi.join(base, segment));
      continue;
    }
    const matcher = wildcardRegExp(segment);
    const next = [];
    for (const base of bases) {
      for (const name of (await listDir(base)).sort()) {
        if (matcher.test(name.normalize('NFC'))) next.push(pathApi.join(base, name));
      }
    }
    bases = next;
    if (bases.length === 0) break;
  }
  return bases;
}

/**
 * 카탈로그를 이 플랫폼의 루트 목록으로 바꾼다. hancom 항목은 설치 루트(installs)로 따로 돌려준다.
 * @returns {Promise<{ roots: Array<{ path: string, kind: string, label: string, sniff?: boolean, maxDepth?: number }>,
 *   installs: Array<{ path: string, label: string }> }>}
 */
export async function expandFontRootCatalog({
  platform,
  env = {},
  home,
  catalog = FONT_ROOT_CATALOG,
  listDir,
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const os = catalogOs(platform);
  const roots = [];
  const installs = [];
  for (const entry of catalog) {
    if (entry.os !== os) continue;
    const pattern = expandRootPath(entry.glob ?? entry.path, { platform, env, home });
    if (!pattern) continue;
    const targets = entry.glob ? await expandGlob(pattern, pathApi, listDir) : [pattern];
    for (const target of targets) {
      const resolved = pathApi.resolve(target);
      if (entry.kind === 'hancom') {
        installs.push({ path: resolved, label: entry.label });
        continue;
      }
      roots.push({
        path: resolved,
        kind: entry.kind,
        label: entry.label,
        ...(entry.sniff ? { sniff: true } : {}),
        ...(Number.isInteger(entry.maxDepth) ? { maxDepth: entry.maxDepth } : {}),
      });
    }
  }
  return { roots, installs };
}
