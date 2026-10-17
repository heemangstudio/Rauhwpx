// 운영체제별 글꼴 폴더 목록. 데스크톱 main 프로세스와 로컬 허브가 함께 쓴다 (Node 전용, Electron 불필요).
//
// 항목: { os, kind, label, path | glob | bundles | programs, sniff?, maxDepth?, menu? }
//   - path: 그대로 쓰는 경로. glob: 경로 조각마다 `*` 를 폴더 이름과 맞춘다.
//   - bundles (macOS): 이 폴더의 .app (한 단계 아래 업체 폴더 포함) 마다 정해진 하위 경로만 본다.
//     programs (Windows): 이 폴더의 프로그램 폴더마다 바로 아래 Fonts 폴더만 본다. 앱 번들 전체를
//     훑지 않는다. 전용 항목이 있는 앱(한컴·Microsoft·Adobe·LibreOffice)은 건너뛴다.
//   - `~` 는 홈 폴더, `%VAR%` 는 (win32에서) 환경 변수로 바꾼다. 없는 변수가 있으면 항목을 건너뛴다.
//   - kind: hancom(한컴 설치 루트: 안에서 Fonts/TTF/HFT 폴더를 찾는다) · user · system · app
//     (다른 앱이 자기용으로 둔 글꼴). 같은 글꼴이 여러 곳에 있으면 이 순서로 고른다.
//   - sniff: 확장자와 상관없이 첫 4바이트가 SFNT/TTC/WOFF/WOFF2 서명인 파일도 받는다 (숨김·무확장자 캐시).
//   - maxDepth: 이 루트만의 탐색 깊이 (기본은 FONT_SCAN_LIMITS.maxDepth).
//   - menu: 글꼴 메뉴에 넣을지. app 글꼴은 그 앱만 쓰는 사본이라 기본으로 빼고(unlisted),
//     문서가 이름으로 부를 때만 연결한다. 모든 앱에 켜지는 Adobe Fonts 만 menu: true 로 둔다.
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
    menu: true,
  },
  { os: 'darwin', kind: 'app', label: 'Adobe Acrobat', glob: '/Applications/Adobe Acrobat*.app/Contents/Resources/Resource/CIDFont' },
  { os: 'darwin', kind: 'app', label: 'Adobe Acrobat', glob: '/Applications/Adobe Acrobat*.app/Contents/Resources/Resource/Font' },
  { os: 'darwin', kind: 'app', label: 'Adobe Acrobat', glob: '/Applications/Adobe Acrobat*/Adobe Acrobat*.app/Contents/Resources/Resource/CIDFont' },
  { os: 'darwin', kind: 'app', label: 'Adobe Acrobat', glob: '/Applications/Adobe Acrobat*/Adobe Acrobat*.app/Contents/Resources/Resource/Font' },
  { os: 'darwin', kind: 'app', label: 'LibreOffice', path: '/Applications/LibreOffice.app/Contents/Resources/fonts' },
  // Homebrew 글꼴 cask 는 보통 ~/Library/Fonts 로 옮기고 Caskroom 에 링크를 남긴다. 실제 경로가 같으면
  // 먼저 훑은 사용자 폴더 사본만 남는다. 옮기지 않은 cask 도 사용자가 고른 글꼴이라 user 로 둔다.
  { os: 'darwin', kind: 'user', label: 'Homebrew casks', glob: '/opt/homebrew/Caskroom/font-*', maxDepth: 3 },
  { os: 'darwin', kind: 'user', label: 'Homebrew casks', glob: '/usr/local/Caskroom/font-*', maxDepth: 3 },
  { os: 'darwin', kind: 'app', label: 'Homebrew', path: '/opt/homebrew/share/fonts' },
  { os: 'darwin', kind: 'app', label: 'Homebrew', path: '/usr/local/share/fonts' },
  { os: 'darwin', kind: 'app', label: 'MacPorts', path: '/opt/local/share/fonts' },
  { os: 'darwin', kind: 'app', label: 'Blender', glob: '/Applications/Blender*.app/Contents/Resources/*/datafiles/fonts', maxDepth: 1 },
  { os: 'darwin', kind: 'app', label: 'app bundles', bundles: '/Applications' },
  { os: 'darwin', kind: 'app', label: 'app bundles', bundles: '~/Applications' },
  // TeX 글꼴 트리는 크다. 맨 뒤에 훑어 파일 상한에 걸려도 다른 출처가 빠지지 않는다.
  { os: 'darwin', kind: 'app', label: 'TeX Live', glob: '/usr/local/texlive/*/texmf-dist/fonts/opentype', maxDepth: 4 },
  { os: 'darwin', kind: 'app', label: 'TeX Live', glob: '/usr/local/texlive/*/texmf-dist/fonts/truetype', maxDepth: 4 },
  { os: 'darwin', kind: 'app', label: 'TeX Live', path: '/Library/TeX/Root/texmf-dist/fonts/opentype', maxDepth: 4 },
  { os: 'darwin', kind: 'app', label: 'TeX Live', path: '/Library/TeX/Root/texmf-dist/fonts/truetype', maxDepth: 4 },

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
  { os: 'win32', kind: 'app', label: 'Adobe Fonts', path: '%APPDATA%\\Adobe\\CoreSync\\plugins\\livetype', sniff: true, menu: true },
  { os: 'win32', kind: 'app', label: 'LibreOffice', path: '%ProgramFiles%\\LibreOffice\\share\\fonts' },
  {
    os: 'win32',
    kind: 'app',
    label: 'Blender',
    glob: '%ProgramFiles%\\Blender Foundation\\*\\*\\datafiles\\fonts',
    maxDepth: 1,
  },
  { os: 'win32', kind: 'app', label: 'program fonts', programs: '%ProgramFiles%' },
  { os: 'win32', kind: 'app', label: 'program fonts', programs: '%ProgramFiles(x86)%' },
  { os: 'win32', kind: 'app', label: 'TeX Live', glob: '%SystemDrive%\\texlive\\*\\texmf-dist\\fonts\\opentype', maxDepth: 4 },
  { os: 'win32', kind: 'app', label: 'TeX Live', glob: '%SystemDrive%\\texlive\\*\\texmf-dist\\fonts\\truetype', maxDepth: 4 },
  { os: 'win32', kind: 'app', label: 'MiKTeX', path: '%ProgramFiles%\\MiKTeX\\fonts\\opentype', maxDepth: 4 },
  { os: 'win32', kind: 'app', label: 'MiKTeX', path: '%ProgramFiles%\\MiKTeX\\fonts\\truetype', maxDepth: 4 },
  { os: 'win32', kind: 'app', label: 'MiKTeX', path: '%LOCALAPPDATA%\\Programs\\MiKTeX\\fonts\\opentype', maxDepth: 4 },
  { os: 'win32', kind: 'app', label: 'MiKTeX', path: '%LOCALAPPDATA%\\Programs\\MiKTeX\\fonts\\truetype', maxDepth: 4 },

  // ── Linux 등 ──
  { os: 'linux', kind: 'system', label: 'system fonts', path: '/usr/share/fonts' },
  { os: 'linux', kind: 'system', label: 'local fonts', path: '/usr/local/share/fonts' },
  { os: 'linux', kind: 'user', label: 'user fonts', path: '~/.local/share/fonts' },
  { os: 'linux', kind: 'user', label: 'user fonts', path: '~/.fonts' },
  { os: 'linux', kind: 'hancom', label: 'Hancom Office', path: '/opt/hnc' },
  { os: 'linux', kind: 'app', label: 'LibreOffice', path: '/usr/lib/libreoffice/share/fonts' },
  { os: 'linux', kind: 'app', label: 'LibreOffice', glob: '/opt/libreoffice*/share/fonts' },
  { os: 'linux', kind: 'app', label: 'Homebrew', path: '/home/linuxbrew/.linuxbrew/share/fonts' },
  { os: 'linux', kind: 'app', label: 'Homebrew', path: '~/.linuxbrew/share/fonts' },
  { os: 'linux', kind: 'app', label: 'Blender', glob: '/usr/share/blender/*/datafiles/fonts', maxDepth: 1 },
  // 배포판 TeX Live 는 일부 글꼴을 /usr/share/fonts 로 링크한다. 같은 파일은 실제 경로로 한 번만 센다.
  { os: 'linux', kind: 'app', label: 'TeX Live', path: '/usr/share/texlive/texmf-dist/fonts/opentype', maxDepth: 4 },
  { os: 'linux', kind: 'app', label: 'TeX Live', path: '/usr/share/texlive/texmf-dist/fonts/truetype', maxDepth: 4 },
  { os: 'linux', kind: 'app', label: 'TeX Live', glob: '/usr/local/texlive/*/texmf-dist/fonts/opentype', maxDepth: 4 },
  { os: 'linux', kind: 'app', label: 'TeX Live', glob: '/usr/local/texlive/*/texmf-dist/fonts/truetype', maxDepth: 4 },
]);

/** 전용 카탈로그 항목이나 한컴 설치 탐색이 이미 다루는 앱, 그리고 이 앱 자신 */
const COVERED_APP = /^(microsoft|adobe|libreoffice|blender|hamaeditor|rauhwpx)|hancom|한컴|hwp/i;
/** Windows 프로그램 폴더 중 글꼴 폴더를 찾지 않을 곳 (OS 구성 요소, 전용 항목이 있는 앱, TeX) */
const COVERED_PROGRAM = /^(microsoft|windows|common files|internet explorer|hnc|libreoffice|blender foundation|adobe|miktex|texlive)/i;
const BUNDLE_FONT_DIR = /^fonts$/i;

/**
 * .app 마다 Contents/Resources/fonts(대소문자 무관) 하나만 본다. 앱 안의 보조 앱
 * (Contents/Library, Contents/Applications 의 .app) 도 같은 자리만 본다. Electron·Chromium 의
 * 내부 자원(app.asar, Resources/app/…의 아이콘·KaTeX 글꼴)과 Frameworks 는 이 자리에 없어
 * 저절로 빠진다.
 */
async function probeAppBundles(base, pathApi, listDir) {
  const apps = [];
  for (const name of (await listDir(base)).sort()) {
    if (/\.app$/i.test(name)) apps.push(pathApi.join(base, name));
    else {
      for (const child of (await listDir(pathApi.join(base, name))).sort()) {
        if (/\.app$/i.test(child)) apps.push(pathApi.join(base, name, child));
      }
    }
  }
  const resourcesFonts = async (app, found) => {
    const contents = pathApi.join(app, 'Contents');
    const parts = await listDir(contents);
    const label = pathApi.basename(app).replace(/\.app$/i, '').normalize('NFC');
    if (parts.includes('Resources')) {
      const resources = pathApi.join(contents, 'Resources');
      for (const name of (await listDir(resources)).sort()) {
        if (BUNDLE_FONT_DIR.test(name)) found.push({ path: pathApi.join(resources, name), label });
      }
    }
    return { contents, parts };
  };
  const perApp = await Promise.all(apps.map(async (app) => {
    const found = [];
    if (COVERED_APP.test(pathApi.basename(app).normalize('NFC'))) return found;
    const { contents, parts } = await resourcesFonts(app, found);
    for (const nest of ['Library', 'Applications']) {
      if (!parts.includes(nest)) continue;
      for (const child of (await listDir(pathApi.join(contents, nest))).sort()) {
        if (/\.app$/i.test(child)) await resourcesFonts(pathApi.join(contents, nest, child), found);
      }
    }
    return found;
  }));
  return perApp.flat();
}

/** Windows 프로그램 폴더마다 바로 아래 Fonts 폴더만 본다. */
async function probeProgramFolders(base, pathApi, listDir) {
  const names = (await listDir(base)).sort().filter((name) => !COVERED_PROGRAM.test(name));
  const perProgram = await Promise.all(names.map(async (name) => {
    const program = pathApi.join(base, name);
    return (await listDir(program))
      .filter((child) => BUNDLE_FONT_DIR.test(child))
      .map((child) => ({ path: pathApi.join(program, child), label: name }));
  }));
  return perProgram.flat();
}

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
 * @returns {Promise<{ roots: Array<{ path: string, kind: string, label: string, sniff?: boolean, maxDepth?: number,
 *   unlisted?: boolean }>,
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
  const list = listDir ?? listDirNames;
  // 항목마다 폴더를 읽는 일은 나란히 하고, 결과는 카탈로그 순서대로 모은다 (순서가 곧 우선순위다).
  const expanded = await Promise.all(catalog.map(async (entry) => {
    if (entry.os !== os) return null;
    const pattern = expandRootPath(entry.glob ?? entry.path ?? entry.bundles ?? entry.programs, { platform, env, home });
    if (!pattern) return null;
    if (entry.bundles) return probeAppBundles(pattern, pathApi, list);
    if (entry.programs) return probeProgramFolders(pattern, pathApi, list);
    return entry.glob ? expandGlob(pattern, pathApi, list) : [pattern];
  }));
  catalog.forEach((entry, position) => {
    const targets = expanded[position];
    if (!targets) return;
    const unlisted = entry.menu === false || (entry.kind === 'app' && entry.menu !== true);
    for (const item of targets) {
      const target = typeof item === 'string' ? item : item.path;
      const label = typeof item === 'string' ? entry.label : `${entry.label}: ${item.label}`;
      const resolved = pathApi.resolve(target);
      if (entry.kind === 'hancom') {
        installs.push({ path: resolved, label: entry.label });
        continue;
      }
      roots.push({
        path: resolved,
        kind: entry.kind,
        label,
        ...(entry.sniff ? { sniff: true } : {}),
        ...(Number.isInteger(entry.maxDepth) ? { maxDepth: entry.maxDepth } : {}),
        // 번들 안 글꼴 폴더는 얕다. 하위 폴더 하나까지만 본다.
        ...(entry.bundles || entry.programs ? { maxDepth: 1 } : {}),
        ...(unlisted ? { unlisted: true } : {}),
      });
    }
  });
  return { roots, installs };
}
