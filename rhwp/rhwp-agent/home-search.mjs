// 홈 폴더 파일 찾기. 데스크톱 허브(RHWP_HOME_ACCESS=1)에서만 켜집니다.
// 에이전트에는 경로 대신 세션에 묶인 hitId만 건네고, 가져오기는 resolve()로 다시 검증한 경로만 씁니다.
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import crossSpawn from 'cross-spawn';

import { processTreeSpawnOptions, terminateProcessTree } from './process-tree.mjs';

export const HOME_SEARCH_MDFIND = '/usr/bin/mdfind';
export const HOME_SEARCH_TIMEOUT_MS = 5_000;
export const HOME_SEARCH_MAX_STDOUT_BYTES = 1024 * 1024;
export const HOME_SEARCH_MAX_PATHS = 500;
export const HOME_WALK_MAX_DEPTH = 8;
export const HOME_WALK_MAX_ENTRIES = 200_000;
export const HOME_WALK_TIMEOUT_MS = 3_000;
// 폴더 하나를 여는 데 쓰는 시간 상한. macOS 는 답하지 않은 개인정보 보호(TCC) 요청이 있는 폴더(데스크탑 등)를
// 열 때 opendir 가 끝나지 않으므로, 그 폴더만 건너뛰고 나머지를 계속 훑는다.
export const HOME_WALK_DIR_TIMEOUT_MS = 500;
export const HOME_WALK_CACHE_MS = 5 * 60_000;
export const HOME_HIT_TTL_MS = 30 * 60_000;
const MAX_HITS = 10_000;
const MAX_QUERY_WORDS = 8;
const MAX_WORD_CHARS = 64;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const STAT_BATCH = 32;
const TIMED_OUT = Symbol('timed-out');

/** promise 를 ms 안에 기다린다. 넘으면 TIMED_OUT. 멈춘 파일 시스템 호출은 취소할 수 없으므로 버린다. */
function within(promise, ms) {
  if (ms <= 0) return Promise.resolve(TIMED_OUT);
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ms, TIMED_OUT); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
const DEFAULT_FILE_TYPES = Object.freeze([
  'pdf', 'hwp', 'hwpx', 'hml', 'docx', 'pptx', 'xlsx', 'txt', 'md', 'csv', 'json', 'html', 'htm',
  'png', 'jpg', 'jpeg', 'webp',
]);
// 어느 깊이에서든 들어가지 않는 폴더 이름(소문자).
const SKIPPED_SEGMENTS = new Set(['node_modules', '$recycle.bin', 'appdata', 'application data', 'local settings']);
// 홈 바로 아래에서만 막는 앱 데이터 폴더(소문자).
const SKIPPED_TOP_LEVEL = new Set(['library', 'applications', 'appdata']);

export class HomeSearchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'HomeSearchError';
  }
}

function settingsOf(settings) {
  const value = typeof settings === 'function' ? settings() : settings;
  return value && typeof value === 'object' ? value : {};
}

function allowedTypes(settings, requested) {
  const configured = Array.isArray(settings.ingest?.fileTypes) ? settings.ingest.fileTypes : DEFAULT_FILE_TYPES;
  const normalized = new Set(configured
    .map((type) => String(type).toLowerCase().replace(/^\./, ''))
    .filter((type) => /^[a-z0-9]{1,10}$/.test(type)));
  if (!Array.isArray(requested) || requested.length === 0) return [...normalized];
  const wanted = new Set(requested.map((type) => String(type).toLowerCase().replace(/^\./, '')));
  return [...normalized].filter((type) => wanted.has(type));
}

function maxFileBytes(settings) {
  const mb = Number(settings.ingest?.maxFileMb);
  const bounded = Number.isFinite(mb) ? Math.min(100, Math.max(1, mb)) : 100;
  return Math.floor(bounded * 1024 * 1024);
}

function queryWords(query) {
  if (typeof query !== 'string') throw new HomeSearchError('HOME_SEARCH_INVALID', 'query must be a string');
  const words = query.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_QUERY_WORDS)
    .map((word) => word.slice(0, MAX_WORD_CHARS));
  if (words.length === 0) throw new HomeSearchError('HOME_SEARCH_INVALID', 'query must contain a word');
  return words;
}

/** Escape a value for a double-quoted Spotlight query string (`*` stays literal). */
export function escapeMdfindValue(value) {
  return String(value).replace(/[\\"*]/g, (character) => `\\${character}`);
}

/** Every word must hit the display name or the indexed text; the extension must be allowed. */
export function buildMdfindQuery(words, types) {
  const clauses = words.map((word) => {
    const value = escapeMdfindValue(word);
    return `(kMDItemDisplayName == "*${value}*"cd || kMDItemTextContent == "${value}*"cdw)`;
  });
  const extensions = types.map((type) => `kMDItemFSName == "*.${escapeMdfindValue(type)}"c`);
  return `${clauses.join(' && ')} && (${extensions.join(' || ')})`;
}

function foldCase(value, platform) {
  const normalized = value.normalize('NFC');
  return platform === 'linux' ? normalized : normalized.toLowerCase();
}

function insideOrEqual(parent, candidate, platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const relative = pathApi.relative(foldCase(parent, platform), foldCase(candidate, platform));
  return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative));
}

function relativeSegments(rel, platform) {
  return rel.split(platform === 'win32' ? /[\\/]+/ : /\/+/).filter(Boolean);
}

function segmentRejected(segment, index) {
  const lower = segment.normalize('NFC').toLowerCase();
  if (segment.startsWith('.')) return true;
  if (SKIPPED_SEGMENTS.has(lower)) return true;
  if (index === 0 && SKIPPED_TOP_LEVEL.has(lower)) return true;
  return lower.endsWith('.app') || lower.endsWith('.photoslibrary');
}

function base32(bytes) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return output;
}

/**
 * @param {{ home: string, platform?: string, settings: object | (() => object), hmacKey?: string | Buffer,
 *   spawn?: typeof crossSpawn, access?: boolean, now?: () => number,
 *   terminateProcess?: (child: any) => any, mdfindPath?: string, mdfindTimeoutMs?: number }} options
 */
export function createHomeSearch({
  home,
  platform = process.platform,
  settings,
  hmacKey = crypto.randomBytes(32),
  spawn = crossSpawn,
  access = process.env.RHWP_HOME_ACCESS === '1',
  now = Date.now,
  terminateProcess = terminateProcessTree,
  mdfindPath = HOME_SEARCH_MDFIND,
  mdfindTimeoutMs = HOME_SEARCH_TIMEOUT_MS,
  openDir = (dir) => fs.opendir(dir),
} = {}) {
  if (!home || !path.isAbsolute(home)) throw new Error('createHomeSearch requires an absolute home');
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const hits = new Map();
  let realHomePromise = null;
  let walkCache = null;
  // 아직 끝나지 않은 opendir. 같은 폴더를 다시 열어 스레드 풀을 더 묶지 않고, 끝나면 다음 검색에서 다시 연다.
  const pendingOpens = new Map();

  const realHome = () => {
    realHomePromise ??= fs.realpath(home).catch((error) => {
      realHomePromise = null;
      throw error;
    });
    return realHomePromise;
  };

  const isAvailable = () => access === true && settingsOf(settings).ingest?.homeSearch !== false;

  const assertAvailable = () => {
    if (!isAvailable()) {
      throw new HomeSearchError('HOME_ACCESS_DISABLED', 'Home folder search is only available in the desktop app with home search enabled');
    }
  };

  const excludedRoots = (current, homeRoot) => (Array.isArray(current.ingest?.excludedFolders)
    ? current.ingest.excludedFolders : [])
    .map((entry) => String(entry ?? '').trim())
    .filter((entry) => entry === '~' || entry.startsWith('~/') || entry.startsWith('~\\'))
    .map((entry) => pathApi.resolve(homeRoot, entry.slice(1).replace(/^[\\/]+/, '') || '.'))
    .filter((root) => root !== pathApi.resolve(homeRoot));

  /** Shared gate for search results and hitId resolution. */
  async function validateCandidate(candidate, { types, maxBytes, excluded, homeRoot }) {
    if (typeof candidate !== 'string' || !pathApi.isAbsolute(candidate) || candidate.includes('\0')) return null;
    const lexical = pathApi.resolve(candidate);
    if (!insideOrEqual(homeRoot, lexical, platform)) return null;
    const lexicalRel = pathApi.relative(homeRoot, lexical);
    if (!lexicalRel) return null;
    let real;
    let info;
    try {
      const link = await fs.lstat(lexical);
      if (link.isSymbolicLink() || !link.isFile()) return null;
      real = await fs.realpath(lexical);
      info = await fs.stat(real);
    } catch {
      return null;
    }
    if (!info.isFile() || info.size <= 0 || info.size > maxBytes) return null;
    if (!insideOrEqual(homeRoot, real, platform)) return null;
    const rel = pathApi.relative(homeRoot, real);
    // A symlinked ancestor makes the canonical path differ from the lexical one.
    if (!rel || foldCase(rel, platform) !== foldCase(lexicalRel, platform)) return null;
    const segments = relativeSegments(rel, platform);
    if (segments.some(segmentRejected)) return null;
    if (excluded.some((root) => insideOrEqual(root, real, platform))) return null;
    const name = segments.at(-1).normalize('NFC');
    const ext = pathApi.extname(name).slice(1).toLowerCase();
    if (!types.includes(ext)) return null;
    return {
      realPath: real,
      name,
      homePath: `~/${segments.map((segment) => segment.normalize('NFC')).join('/')}`,
      size: info.size,
      mtime: Math.round(info.mtimeMs),
      ext,
    };
  }

  function hitIdFor(realPath, sessionKey) {
    const digest = crypto.createHmac('sha256', hmacKey)
      .update(String(sessionKey)).update('\0').update(realPath)
      .digest();
    return `h${base32(digest).slice(0, 20)}`;
  }

  function rememberHit(realPath, sessionKey) {
    const at = now();
    for (const [id, entry] of hits) {
      if (entry.expiresAt > at && hits.size < MAX_HITS) break;
      hits.delete(id);
    }
    const hitId = hitIdFor(realPath, sessionKey);
    hits.delete(hitId);
    hits.set(hitId, { realPath, sessionKey: String(sessionKey), expiresAt: at + HOME_HIT_TTL_MS });
    return hitId;
  }

  function runMdfind(words, types, homeRoot) {
    return new Promise((resolve) => {
      const query = buildMdfindQuery(words, types);
      let child;
      try {
        child = spawn(mdfindPath, ['-0', '-onlyin', homeRoot, query], {
          ...processTreeSpawnOptions(platform),
          shell: false,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        resolve({ paths: [], complete: false, failed: true });
        return;
      }
      const chunks = [];
      let bytes = 0;
      let separators = 0;
      let truncated = false;
      let settled = false;
      const finish = (failed) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        const parts = text.split('\0');
        // Without a closing NUL the last path may be cut mid-write.
        if (!text.endsWith('\0')) parts.pop();
        const paths = parts.filter(Boolean);
        resolve({
          paths: paths.slice(0, HOME_SEARCH_MAX_PATHS),
          complete: !truncated && !failed && paths.length <= HOME_SEARCH_MAX_PATHS,
          failed: failed && paths.length === 0,
        });
      };
      const stop = () => {
        truncated = true;
        try { void Promise.resolve(terminateProcess(child)).catch(() => {}); } catch {}
        finish(false);
      };
      const timer = setTimeout(() => {
        try { void Promise.resolve(terminateProcess(child)).catch(() => {}); } catch {}
        finish(true);
      }, mdfindTimeoutMs);
      child.stdout?.on('data', (chunk) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const room = HOME_SEARCH_MAX_STDOUT_BYTES - bytes;
        chunks.push(buffer.subarray(0, Math.max(0, room)));
        bytes += buffer.length;
        if (bytes >= HOME_SEARCH_MAX_STDOUT_BYTES) {
          stop();
          return;
        }
        for (const byte of buffer) if (byte === 0) separators += 1;
        if (separators > HOME_SEARCH_MAX_PATHS) stop();
      });
      child.stdout?.on('error', () => {});
      child.once('error', () => finish(true));
      child.once('close', (code) => finish(code !== 0));
    });
  }

  async function walkHome(homeRoot, types, current) {
    const key = `${homeRoot}\0${[...types].sort().join(',')}\0${JSON.stringify(current.ingest?.excludedFolders ?? [])}`;
    if (walkCache && walkCache.key === key && now() - walkCache.at < HOME_WALK_CACHE_MS) return walkCache;
    const excluded = excludedRoots(current, homeRoot);
    const wanted = new Set(types);
    const files = [];
    const deadline = now() + HOME_WALK_TIMEOUT_MS;
    let entries = 0;
    let complete = true;
    const queue = [{ dir: homeRoot, depth: 0 }];
    while (queue.length > 0) {
      if (now() > deadline || entries >= HOME_WALK_MAX_ENTRIES) {
        complete = false;
        break;
      }
      const { dir, depth } = queue.shift();
      if (pendingOpens.has(dir)) {
        complete = false;
        continue;
      }
      const opening = Promise.resolve().then(() => openDir(dir));
      opening.catch(() => {});
      const handle = await within(opening, Math.min(HOME_WALK_DIR_TIMEOUT_MS, deadline - now())).catch(() => null);
      if (!handle) continue;
      if (handle === TIMED_OUT) {
        complete = false;
        pendingOpens.set(dir, opening);
        void opening.then((late) => late?.close?.()).catch(() => {}).finally(() => pendingOpens.delete(dir));
        continue;
      }
      try {
        for await (const entry of handle) {
          entries += 1;
          if (entries >= HOME_WALK_MAX_ENTRIES || now() > deadline) {
            complete = false;
            break;
          }
          const full = pathApi.join(dir, entry.name);
          if (segmentRejected(entry.name, depth)) continue;
          if (entry.isDirectory()) {
            if (depth + 1 >= HOME_WALK_MAX_DEPTH) {
              complete = false;
              continue;
            }
            if (excluded.some((root) => insideOrEqual(root, full, platform))) continue;
            queue.push({ dir: full, depth: depth + 1 });
          } else if (entry.isFile()) {
            const ext = pathApi.extname(entry.name).slice(1).toLowerCase();
            if (wanted.has(ext)) files.push({ path: full, name: entry.name.normalize('NFC') });
          }
        }
      } catch {
        // 읽는 중 사라진 폴더는 건너뜁니다.
      } finally {
        await handle.close().catch(() => {});
      }
    }
    walkCache = { key, at: now(), files, complete };
    return walkCache;
  }

  async function candidatePaths(words, types, homeRoot, current) {
    if (platform === 'darwin') {
      const found = await runMdfind(words, types, homeRoot);
      if (!found.failed) return { paths: found.paths, complete: found.complete, nameOnly: false };
    }
    const walked = await walkHome(homeRoot, types, current);
    const folded = words.map((word) => word.toLowerCase());
    const paths = [];
    for (const file of walked.files) {
      const name = file.name.toLowerCase();
      if (folded.every((word) => name.includes(word))) paths.push(file.path);
      if (paths.length >= HOME_SEARCH_MAX_PATHS) break;
    }
    return { paths, complete: walked.complete && paths.length < HOME_SEARCH_MAX_PATHS, nameOnly: true };
  }

  const api = {
    get available() {
      return isAvailable();
    },

    /** @returns {Promise<{hits: {hitId: string, name: string, homePath: string, size: number, mtime: number, ext: string}[], complete: boolean}>} */
    async find({ query, types, limit, sessionKey } = {}) {
      assertAvailable();
      if (typeof sessionKey !== 'string' || !sessionKey) {
        throw new HomeSearchError('HOME_SEARCH_INVALID', 'sessionKey is required');
      }
      const words = queryWords(query);
      const current = settingsOf(settings);
      const allowed = allowedTypes(current, types);
      if (allowed.length === 0) return { hits: [], complete: true };
      const max = Math.min(MAX_LIMIT, Math.max(1, Number.isInteger(limit) ? limit : DEFAULT_LIMIT));
      const homeRoot = await realHome();
      const gate = {
        types: allowed,
        maxBytes: maxFileBytes(current),
        excluded: excludedRoots(current, homeRoot),
        homeRoot,
      };
      const found = await candidatePaths(words, allowed, homeRoot, current);
      const { paths } = found;
      let { complete } = found;
      const accepted = [];
      const seen = new Set();
      // 검사도 멈춘 폴더 안의 경로에서 끝나지 않을 수 있다 — 시간 안에 답한 후보만 쓴다.
      const deadline = now() + HOME_WALK_TIMEOUT_MS;
      for (let index = 0; index < paths.length; index += STAT_BATCH) {
        const batch = await Promise.all(paths.slice(index, index + STAT_BATCH)
          .map(async (candidate) => {
            const hit = await within(validateCandidate(candidate, gate), deadline - now());
            if (hit !== TIMED_OUT) return hit;
            complete = false;
            return null;
          }));
        for (const hit of batch) {
          if (!hit || seen.has(hit.realPath)) continue;
          seen.add(hit.realPath);
          accepted.push(hit);
        }
      }
      const folded = words.map((word) => word.toLowerCase());
      const nameScore = (hit) => folded.filter((word) => hit.name.toLowerCase().includes(word)).length;
      accepted.sort((a, b) => nameScore(b) - nameScore(a) || b.mtime - a.mtime);
      return {
        hits: accepted.slice(0, max).map((hit) => ({
          hitId: rememberHit(hit.realPath, sessionKey),
          name: hit.name,
          homePath: hit.homePath,
          size: hit.size,
          mtime: hit.mtime,
          ext: hit.ext,
        })),
        complete: complete && accepted.length <= max,
      };
    },

    /** Re-validate a hit from this session and return its canonical path. */
    async resolve(hitId, sessionKey) {
      return (await api.resolveHit(hitId, sessionKey)).realPath;
    },

    /** resolve() plus display fields: `{ realPath, homePath, name, size, ext }`. */
    async resolveHit(hitId, sessionKey) {
      assertAvailable();
      const entry = typeof hitId === 'string' ? hits.get(hitId) : undefined;
      if (!entry || typeof sessionKey !== 'string' || entry.sessionKey !== sessionKey
        || hitIdFor(entry.realPath, sessionKey) !== hitId) {
        throw new HomeSearchError('HOME_HIT_INVALID', 'Unknown hitId; run find_home_files again in this chat');
      }
      if (entry.expiresAt <= now()) {
        hits.delete(hitId);
        throw new HomeSearchError('HOME_HIT_EXPIRED', 'This hitId expired; run find_home_files again');
      }
      const current = settingsOf(settings);
      const homeRoot = await realHome();
      const hit = await validateCandidate(entry.realPath, {
        types: allowedTypes(current),
        maxBytes: maxFileBytes(current),
        excluded: excludedRoots(current, homeRoot),
        homeRoot,
      });
      if (!hit || hit.realPath !== entry.realPath) {
        throw new HomeSearchError('HOME_HIT_UNAVAILABLE', 'The file is gone, changed, or no longer allowed');
      }
      return { realPath: hit.realPath, homePath: hit.homePath, name: hit.name, size: hit.size, ext: hit.ext };
    },
  };
  return api;
}
