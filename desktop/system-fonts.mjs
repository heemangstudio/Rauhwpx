// 사용자가 이미 가진 폰트(OS 폰트 폴더, 한컴오피스/뷰어 설치본)를 찾아 색인한다.
// 폰트를 재배포하지 않고 Studio 렌더러가 id 로 요청해 FontFace 로 올릴 수 있게 한다.
// 파일 전체가 아니라 헤더와 필요한 테이블만 읽고, (경로, 크기, mtime) 단위로 캐시한다.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { replaceFile } from './fs-replace.mjs';

import {
  FONT_EXTENSIONS,
  FONT_SCAN_LIMITS,
  HANCOM_MAP_FILE,
  MAX_FACE_BYTES,
  SYSTEM_FONT_INDEX_VERSION,
  assembleFontIndex,
  createReadSource,
  decodeHancomText,
  decodeNameRecord,
  extractCollectionFace as extractCollectionFaceBytes,
  parseFontSource,
  parseHancomFontList,
  parseNameTable,
  parseSfntFaces,
  pathKey,
} from '../rhwp/rhwp-shared/fonts/font-index-core.mjs';

export { SYSTEM_FONT_INDEX_VERSION, decodeHancomText, decodeNameRecord, parseHancomFontList, parseNameTable, parseSfntFaces };

const CACHE_FORMAT = 2;
const CACHE_FILE = 'system-font-index.json';
const { maxDepth: MAX_DEPTH, maxFiles: MAX_FILES, maxDirs: MAX_DIRS } = FONT_SCAN_LIMITS;
const PARSE_CONCURRENCY = 24;
const HANCOM_FONT_DIR = /^(fonts|ttf|hft)$/i;
const HANCOM_APP = /hancom|한컴|hwp/i;

// ---------------------------------------------------------------------------
// 파일 원본
// ---------------------------------------------------------------------------

function fileSource(handle, size) {
  return createReadSource(size, (offset, length) => readExactly(handle, offset, length));
}

async function readExactly(handle, offset, length) {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
    if (bytesRead === 0) throw new Error(`unexpected end of file at ${offset + filled}`);
    filled += bytesRead;
  }
  return buffer;
}

function asBuffer(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** 컬렉션의 faceIndex 번째 서브폰트를 독립 SFNT 로 재조립한다 (Buffer 로 돌려준다). */
export async function extractCollectionFace(input, faceIndex, options) {
  return asBuffer(await extractCollectionFaceBytes(input, faceIndex, options));
}

// ---------------------------------------------------------------------------
// 루트 목록
// ---------------------------------------------------------------------------

function splitEnvPaths(value, platform) {
  if (!value) return [];
  const separator = platform === 'win32' ? ';' : ':';
  return String(value).split(separator).map((entry) => entry.trim()).filter(Boolean);
}

async function listDir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function isDirectory(target) {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** 설치 루트 아래에서 Fonts/TTF/HFT 라는 이름의 폴더를 찾는다. */
async function discoverHancomFontDirs(base, pathApi) {
  const found = [];
  const seen = new Set();
  let visited = 0;
  async function walk(dir, depth) {
    if (depth > MAX_DEPTH || visited >= MAX_DIRS) return;
    let real;
    try {
      real = await fs.realpath(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    visited += 1;
    for (const entry of await listDir(dir)) {
      const child = pathApi.join(dir, entry.name);
      const directory = entry.isDirectory() || (entry.isSymbolicLink() && await isDirectory(child));
      if (!directory) continue;
      if (HANCOM_FONT_DIR.test(entry.name)) found.push(child);
      else await walk(child, depth + 1);
    }
  }
  await walk(base, 0);
  return found.sort();
}

/**
 * 플랫폼별 폰트 루트를 나열한다. 한컴 설치본은 installs 로 따로 돌려주고
 * 실제 폰트 폴더 탐색은 호출부가 한다.
 */
export async function defaultFontRoots({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const roots = [];
  const hancomInstalls = [];
  const add = (target, kind) => {
    if (target) roots.push({ path: pathApi.resolve(target), kind });
  };
  if (platform === 'darwin') {
    add('/System/Library/Fonts', 'system');
    add('/System/Library/Fonts/Supplemental', 'system');
    add('/Library/Fonts', 'system');
    const assets = '/System/Library/AssetsV2';
    for (const entry of await listDir(assets)) {
      if (entry.isDirectory() && entry.name.startsWith('com_apple_MobileAsset_Font')) {
        add(pathApi.join(assets, entry.name), 'system');
      }
    }
    add(pathApi.join(home, 'Library/Fonts'), 'user');
    for (const appsDir of ['/Applications', pathApi.join(home, 'Applications')]) {
      for (const entry of await listDir(appsDir)) {
        const name = entry.name.normalize('NFC');
        if (!name.endsWith('.app')) continue;
        const app = pathApi.join(appsDir, entry.name);
        if (HANCOM_APP.test(name)) {
          const shared = pathApi.join(app, 'Contents/Resources/Hnc/Shared');
          hancomInstalls.push(await isDirectory(shared) ? shared : pathApi.join(app, 'Contents/Resources'));
        } else if (/^Microsoft /.test(name)) {
          // Microsoft Office for Mac 은 맑은 고딕 등을 앱 번들 DFonts 에 둔다.
          const dfonts = pathApi.join(app, 'Contents/Resources/DFonts');
          if (await isDirectory(dfonts)) add(dfonts, 'user');
        }
      }
    }
  } else if (platform === 'win32') {
    const windir = env.WINDIR || env.SystemRoot || 'C:\\Windows';
    add(pathApi.join(windir, 'Fonts'), 'system');
    if (env.LOCALAPPDATA) add(pathApi.join(env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'), 'user');
    for (const programFiles of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]) {
      if (programFiles) hancomInstalls.push(pathApi.join(programFiles, 'Hnc'));
    }
  } else {
    add('/usr/share/fonts', 'system');
    add('/usr/local/share/fonts', 'system');
    add(pathApi.join(home, '.local/share/fonts'), 'user');
    add(pathApi.join(home, '.fonts'), 'user');
    hancomInstalls.push('/opt/hnc');
  }
  for (const extra of splitEnvPaths(env.RHWP_FONT_PATH, platform)) add(extra, 'user');
  return { roots: dedupeRoots(roots, platform), hancomInstalls: [...new Set(hancomInstalls)] };
}

function dedupeRoots(roots, platform) {
  const seen = new Set();
  return roots.filter((root) => {
    const key = pathKey(root.path, platform);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// 파일 수집
// ---------------------------------------------------------------------------

async function collectFiles(roots, { platform, pathApi }) {
  const files = [];
  const seenFiles = new Set();
  const seenDirs = new Set();
  const mapFiles = [];
  const errors = [];
  const rootReal = new Map();
  let capped = false;
  for (const root of roots) {
    try {
      rootReal.set(pathKey(await fs.realpath(root.path), platform), root);
    } catch {
      // 존재하지 않는 루트는 아래에서 기록한다.
    }
  }
  const report = [];
  for (const root of roots) {
    const entry = { path: root.path, kind: root.kind, exists: false, fileCount: 0 };
    report.push(entry);
    let info;
    try {
      info = await fs.stat(root.path);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') entry.error = error.message;
      continue;
    }
    entry.exists = true;
    const addFile = async (filePath, stat, knownReal) => {
      if (files.length >= MAX_FILES) {
        capped = true;
        return;
      }
      let real = knownReal;
      if (!real) {
        try {
          real = await fs.realpath(filePath);
        } catch (error) {
          errors.push({ path: filePath, message: `realpath failed: ${error.message}` });
          return;
        }
      }
      const key = pathKey(real, platform);
      if (seenFiles.has(key)) return;
      seenFiles.add(key);
      files.push({ path: filePath, realPath: real, size: stat.size, mtimeMs: stat.mtimeMs, kind: root.kind });
      entry.fileCount += 1;
    };
    if (info.isFile()) {
      if (FONT_EXTENSIONS.has(pathApi.extname(root.path).toLowerCase())) {
        await addFile(root.path, info, null);
      }
      continue;
    }
    const walk = async (dir, depth, dirReal) => {
      if (depth > MAX_DEPTH || capped) return;
      const dirKey = pathKey(dirReal, platform);
      if (seenDirs.has(dirKey)) return;
      seenDirs.add(dirKey);
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (depth === 0) entry.error = error.message;
        else errors.push({ path: dir, message: error.message });
        return;
      }
      for (const child of entries) {
        if (capped) return;
        const childPath = pathApi.join(dir, child.name);
        const symlink = child.isSymbolicLink();
        let isDir = child.isDirectory();
        let isFile = child.isFile();
        let childStat = null;
        if (symlink) {
          try {
            childStat = await fs.stat(childPath);
            isDir = childStat.isDirectory();
            isFile = childStat.isFile();
          } catch {
            continue;
          }
        }
        if (isDir) {
          let childReal = symlink ? null : pathApi.join(dirReal, child.name);
          if (!childReal) {
            try {
              childReal = await fs.realpath(childPath);
            } catch {
              continue;
            }
          }
          const owner = rootReal.get(pathKey(childReal, platform));
          if (owner && owner !== root) continue; // 별도 루트로 등록된 하위 폴더
          await walk(childPath, depth + 1, childReal);
          continue;
        }
        if (!isFile) continue;
        if (root.kind === 'hancom' && HANCOM_MAP_FILE.test(child.name)) {
          mapFiles.push(childPath);
          continue;
        }
        if (!FONT_EXTENSIONS.has(pathApi.extname(child.name).toLowerCase())) continue;
        try {
          childStat ??= await fs.stat(childPath);
        } catch (error) {
          errors.push({ path: childPath, message: error.message });
          continue;
        }
        await addFile(childPath, childStat, symlink ? null : pathApi.join(dirReal, child.name));
      }
    };
    let real;
    try {
      real = await fs.realpath(root.path);
    } catch {
      real = root.path;
    }
    await walk(root.path, 0, real);
  }
  if (capped) errors.push({ path: '*', message: `file cap reached (${MAX_FILES}); remaining fonts skipped` });
  return { files, roots: report, mapFiles, errors };
}

// ---------------------------------------------------------------------------
// 서비스
// ---------------------------------------------------------------------------

function faceId(realPath, faceIndex, size, mtimeMs) {
  return createHash('sha256')
    .update(`${realPath}\u0000${faceIndex}\u0000${size}\u0000${mtimeMs}`)
    .digest('hex')
    .slice(0, 16);
}

async function mapLimit(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

async function parseFontFile(file) {
  const handle = await fs.open(file.path, 'r');
  try {
    return await parseFontSource(fileSource(handle, file.size), path.basename(file.path));
  } finally {
    await handle.close();
  }
}

/**
 * 시스템 폰트 색인 서비스를 만든다.
 * @param {{ cacheDir?: string, log?: (line: string) => void, platform?: string,
 *   env?: Record<string, string|undefined>, home?: string,
 *   roots?: Array<{path: string, kind: 'system'|'user'|'hancom'}>, hancomInstalls?: string[] }} options
 */
export function createSystemFontService(options = {}) {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const cachePath = options.cacheDir ? path.join(options.cacheDir, CACHE_FILE) : null;
  let index = null;
  let facesById = new Map();
  let pending = null;
  let persisted = undefined;

  async function loadPersisted() {
    if (persisted !== undefined) return persisted;
    persisted = null;
    if (!cachePath) return persisted;
    try {
      const data = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      if (data?.format === CACHE_FORMAT && data.platform === platform && data.files && typeof data.files === 'object') {
        persisted = data;
      } else {
        log(`cache ignored (format ${data?.format ?? 'unknown'})`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`cache unreadable, rescanning: ${error.message}`);
    }
    return persisted;
  }

  async function savePersisted(files) {
    if (!cachePath) return;
    const data = { format: CACHE_FORMAT, platform, savedAt: new Date().toISOString(), files };
    persisted = data;
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      const temp = `${cachePath}.${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify(data));
      await replaceFile(temp, cachePath, platform);
    } catch (error) {
      log(`cache write failed: ${error.message}`);
    }
  }

  async function resolveRoots() {
    if (options.roots) {
      return { roots: options.roots, hancomInstalls: options.hancomInstalls ?? [] };
    }
    return defaultFontRoots({ platform, env: options.env ?? process.env, home: options.home ?? os.homedir() });
  }

  async function scan() {
    const started = performance.now();
    const { roots: baseRoots, hancomInstalls } = await resolveRoots();
    const roots = [];
    const installReports = [];
    for (const install of hancomInstalls) {
      if (!(await isDirectory(install))) continue;
      const dirs = await discoverHancomFontDirs(install, pathApi);
      if (dirs.length === 0) {
        installReports.push({ path: install, kind: 'hancom', exists: true, fileCount: 0, error: 'no Fonts/TTF/HFT folder found' });
      }
      for (const dir of dirs) roots.push({ path: dir, kind: 'hancom' });
    }
    roots.push(...baseRoots);
    const collected = await collectFiles(dedupeRoots(roots, platform), { platform, pathApi });
    const errors = [...collected.errors];
    const cache = (await loadPersisted())?.files ?? {};
    const nextCache = {};
    let reused = 0;
    let parsed = 0;
    let undecodable = 0;
    const parsedFiles = new Array(collected.files.length);
    await mapLimit(collected.files, PARSE_CONCURRENCY, async (file, position) => {
      const cacheKey = pathKey(file.realPath, platform);
      const cached = cache[cacheKey];
      let result;
      if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
        result = cached;
        reused += 1;
      } else {
        parsed += 1;
        try {
          const outcome = await parseFontFile(file);
          undecodable += outcome.undecodable ?? 0;
          result = { size: file.size, mtimeMs: file.mtimeMs, type: outcome.type, faces: outcome.faces };
        } catch (error) {
          result = { size: file.size, mtimeMs: file.mtimeMs, type: 'invalid', faces: [], error: error.message };
        }
      }
      nextCache[cacheKey] = result;
      parsedFiles[position] = { file, result };
    });

    const { faces, byId, hancomFaceMap, hftFiles, mapStats } = await assembleFontIndex({
      parsedFiles,
      mapFiles: collected.mapFiles,
      readMapFile: (mapFile) => fs.readFile(mapFile),
      faceId: (file, faceIndex) => faceId(file.realPath, faceIndex, file.size, file.mtimeMs),
      pathApi,
      platform,
      errors,
    });
    const durationMs = Math.round(performance.now() - started);
    const next = {
      version: SYSTEM_FONT_INDEX_VERSION,
      platform,
      scannedAt: new Date().toISOString(),
      durationMs,
      fromCache: parsed === 0 && collected.files.length > 0,
      roots: [...collected.roots, ...installReports],
      faces,
      hancomFaceMap,
      errors,
      stats: {
        files: collected.files.length,
        parsed,
        reused,
        hftFiles: hftFiles.length,
        mapFiles: collected.mapFiles.length,
        undecodableNames: undecodable,
      },
    };
    if (parsed > 0 || Object.keys(cache).length !== collected.files.length) await savePersisted(nextCache);
    index = next;
    facesById = byId;
    logSummary(next, mapStats);
    return next;
  }

  function logSummary(result, mapStats) {
    const perKind = { system: 0, user: 0, hancom: 0 };
    let hangul = 0;
    for (const face of result.faces) {
      perKind[face.source] += 1;
      if (face.hangul) hangul += 1;
    }
    log(`scan ${result.durationMs}ms: ${result.faces.length} faces from ${result.stats.files} files `
      + `(system ${perKind.system}, user ${perKind.user}, hancom ${perKind.hancom}; hangul ${hangul}); `
      + `parsed ${result.stats.parsed}, cache hits ${result.stats.reused}, errors ${result.errors.length}`);
    for (const root of result.roots) {
      if (!root.exists && !root.error) continue;
      log(`  root [${root.kind}] ${root.path}: ${root.fileCount} files${root.error ? ` (${root.error})` : ''}`);
    }
    if (mapStats.entries > 0) {
      log(`  hancom maps: ${mapStats.files} files, ${mapStats.entries} names, `
        + `${mapStats.resolved} resolved, ${mapStats.unresolved} without an installed file`);
    }
    for (const error of result.errors.slice(0, 20)) log(`  error ${error.path}: ${error.message}`);
    if (result.errors.length > 20) log(`  ... ${result.errors.length - 20} more errors`);
  }

  async function list(listOptions = {}) {
    const refresh = listOptions?.refresh === true;
    if (index && !refresh) return index;
    if (pending) return pending;
    pending = scan().finally(() => {
      pending = null;
    });
    return pending;
  }

  async function readFace(id) {
    const started = performance.now();
    if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) throw new Error('invalid font id');
    if (!index) await list();
    const entry = facesById.get(id);
    if (!entry) throw new Error(`unknown font id ${id}`);
    const { face, file } = entry;
    let info;
    try {
      info = await fs.stat(file.path);
    } catch (error) {
      throw staleError(id, `font file is gone (${error.code ?? error.message})`);
    }
    if (info.size !== file.size || info.mtimeMs !== file.mtimeMs) {
      throw staleError(id, 'font file changed since the index was built');
    }
    let bytes;
    const handle = await fs.open(file.path, 'r');
    try {
      if (face.format === 'ttc' || face.format === 'otc') {
        bytes = await extractCollectionFaceBytes(fileSource(handle, file.size), face.faceIndex);
      } else {
        if (file.size > MAX_FACE_BYTES) {
          throw new Error(`too-large: ${file.size} bytes (cap ${MAX_FACE_BYTES})`);
        }
        bytes = await readExactly(handle, 0, file.size);
      }
    } finally {
      await handle.close();
    }
    log(`read ${id} ${face.families[0] ?? '?'} ${file.path}#${face.faceIndex} `
      + `${bytes.length} bytes ${Math.round(performance.now() - started)}ms`);
    // IPC 직렬화는 뷰가 아니라 ArrayBuffer 전체를 복사하므로 공유 풀을 쓰는 버퍼는 떼어 낸다.
    if (bytes.byteOffset !== 0 || bytes.buffer.byteLength !== bytes.byteLength) {
      return new Uint8Array(bytes);
    }
    return new Uint8Array(bytes.buffer, 0, bytes.byteLength);
  }

  return { list, readFace };
}

function staleError(id, detail) {
  const error = new Error(`stale: ${detail} (${id})`);
  error.code = 'stale';
  return error;
}
