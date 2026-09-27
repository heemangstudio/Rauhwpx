/**
 * 브라우저에서 사용자가 연결한 글꼴 폴더를 색인한다. Worker와 메인 스레드 양쪽에서 돈다.
 *
 * 데스크톱 색인(desktop/system-fonts.mjs)과 같은 공용 코어로 SFNT 헤더·TTC·한컴 목록 파일을
 * 해석하므로 같은 폴더면 같은 face 목록과 한컴 이름 대응이 나온다. 경로는 선택한 폴더 이름부터
 * 시작하는 '/' 구분 상대 경로다. 파일별 파싱 결과는 (경로, 크기, 수정 시각)으로 캐시한다.
 */
import {
  FONT_EXTENSIONS,
  FONT_SCAN_LIMITS,
  HANCOM_MAP_FILE,
  MAX_FACE_BYTES,
  SYSTEM_FONT_INDEX_VERSION,
  assembleFontIndex,
  blobSource,
  extractCollectionFace,
  parseFontSource,
  posixPath,
  type FontIndexFile,
  type ParsedFontFileResult,
} from '../../../rhwp-shared/fonts/font-index-core.mjs';
import type { FontFolderCache } from './font-folder-store.ts';
import type { SystemFontIndex } from './desktop-fonts.ts';

const CACHE_FORMAT = 2;
const PARSE_CONCURRENCY = 8;

// ─── 폴더 원본 ────────────────────────────────────────────────

export interface FolderFileHandleLike {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}

export interface FolderDirectoryHandleLike {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<FolderFileHandleLike | FolderDirectoryHandleLike>;
  getDirectoryHandle(name: string): Promise<FolderDirectoryHandleLike>;
  getFileHandle(name: string): Promise<FolderFileHandleLike>;
  queryPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' }): Promise<PermissionState>;
}

/** Chromium 폴더 핸들 또는 webkitdirectory로 고른 파일 목록 (이번 세션 한정) */
export type FontFolderInput =
  | { kind: 'handle'; handle: FolderDirectoryHandleLike }
  | { kind: 'files'; name: string; files: File[] };

interface FolderFile extends FontIndexFile {
  lastModified: number;
  open(): Promise<File>;
}

interface Collected {
  root: string;
  files: FolderFile[];
  mapFiles: Map<string, () => Promise<File>>;
  errors: Array<{ path: string; message: string }>;
}

function extension(name: string): string {
  const at = name.lastIndexOf('.');
  return at <= 0 ? '' : name.slice(at).toLowerCase();
}

function folderFile(path: string, file: File, open: () => Promise<File>): FolderFile {
  return {
    path,
    realPath: path,
    size: file.size,
    mtimeMs: file.lastModified,
    lastModified: file.lastModified,
    kind: 'user',
    open,
  };
}

async function collectFromHandle(handle: FolderDirectoryHandleLike): Promise<Collected> {
  const collected: Collected = { root: handle.name, files: [], mapFiles: new Map(), errors: [] };
  const { maxDepth, maxFiles, maxDirs } = FONT_SCAN_LIMITS;
  let dirs = 0;
  let capped = false;
  const walk = async (dir: FolderDirectoryHandleLike, path: string, depth: number): Promise<void> => {
    if (depth > maxDepth || capped || dirs >= maxDirs) return;
    dirs += 1;
    const children: Array<FolderFileHandleLike | FolderDirectoryHandleLike> = [];
    try {
      for await (const child of dir.values()) children.push(child);
    } catch (error) {
      collected.errors.push({ path, message: errorText(error) });
      return;
    }
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      if (capped) return;
      const childPath = `${path}/${child.name}`;
      if (child.kind === 'directory') {
        await walk(child, childPath, depth + 1);
        continue;
      }
      const isMap = HANCOM_MAP_FILE.test(child.name);
      if (!isMap && !FONT_EXTENSIONS.has(extension(child.name))) continue;
      if (isMap) {
        collected.mapFiles.set(childPath, () => child.getFile());
        continue;
      }
      if (collected.files.length >= maxFiles) {
        capped = true;
        return;
      }
      try {
        const file = await child.getFile();
        collected.files.push(folderFile(childPath, file, () => child.getFile()));
      } catch (error) {
        collected.errors.push({ path: childPath, message: errorText(error) });
      }
    }
  };
  await walk(handle, handle.name, 0);
  if (capped) collected.errors.push({ path: '*', message: `file cap reached (${maxFiles}); remaining fonts skipped` });
  return collected;
}

function collectFromFiles(name: string, files: readonly File[]): Collected {
  const collected: Collected = { root: name, files: [], mapFiles: new Map(), errors: [] };
  const { maxDepth, maxFiles } = FONT_SCAN_LIMITS;
  const entries = files
    .map(file => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || `${name}/${file.name}` }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const { file, path } of entries) {
    // 폴더 이름/…/파일 : 깊이는 중간 폴더 수
    if (path.split('/').length - 2 > maxDepth) continue;
    if (HANCOM_MAP_FILE.test(file.name)) {
      collected.mapFiles.set(path, async () => file);
      continue;
    }
    if (!FONT_EXTENSIONS.has(extension(file.name))) continue;
    if (collected.files.length >= maxFiles) {
      collected.errors.push({ path: '*', message: `file cap reached (${maxFiles}); remaining fonts skipped` });
      break;
    }
    collected.files.push(folderFile(path, file, async () => file));
  }
  return collected;
}

/** 목록 파일이나 HFT가 있으면 한컴 설치 폴더로 본다. 한컴 이름 대응은 한컴 face에만 붙는다. */
function folderKind(collected: Collected): 'hancom' | 'user' {
  return collected.mapFiles.size > 0 || collected.files.some(file => extension(file.path) === '.hft')
    ? 'hancom'
    : 'user';
}

// ─── face id ─────────────────────────────────────────────────

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;
const encoder = new TextEncoder();

/** 데스크톱과 같은 16자리 hex id. (상대 경로, face, 크기, 수정 시각)이 같으면 같은 id다. */
export function folderFaceId(path: string, faceIndex: number, size: number, lastModified: number): string {
  let hash = FNV_OFFSET;
  for (const byte of encoder.encode(`${path}\u0000${faceIndex}\u0000${size}\u0000${lastModified}`)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

// ─── 색인기 ───────────────────────────────────────────────────

export interface FontFolderIndexer {
  index(input: FontFolderInput, options?: { refresh?: boolean }): Promise<SystemFontIndex>;
  read(id: string): Promise<Uint8Array>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function staleError(id: string, detail: string): Error {
  return Object.assign(new Error(`stale: ${detail} (${id})`), { code: 'stale' });
}

async function mapLimit<T>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await work(items[index]!, index);
    }
  }));
}

export function createFontFolderIndexer(options: { cache?: FontFolderCache | null } = {}): FontFolderIndexer {
  const cache = options.cache ?? null;
  let current: { input: FontFolderInput; index: SystemFontIndex; byId: Map<string, { face: SystemFontIndex['faces'][number]; file: FolderFile }> } | null = null;
  let pending: Promise<SystemFontIndex> | null = null;

  async function scan(input: FontFolderInput): Promise<SystemFontIndex> {
    const started = now();
    const collected = input.kind === 'handle'
      ? await collectFromHandle(input.handle)
      : collectFromFiles(input.name, input.files);
    const kind = folderKind(collected);
    for (const file of collected.files) file.kind = kind;
    const errors = [...collected.errors];
    const cacheKey = `folder:${collected.root}`;
    const cached = (await cache?.load(cacheKey))?.files ?? {};
    const nextCache: Record<string, ParsedFontFileResult> = {};
    let parsed = 0;
    let reused = 0;
    const parsedFiles: Array<{ file: FolderFile; result: ParsedFontFileResult }> = new Array(collected.files.length);
    await mapLimit(collected.files, PARSE_CONCURRENCY, async (file, position) => {
      const hit = cached[file.path];
      let result: ParsedFontFileResult;
      if (hit && hit.size === file.size && hit.mtimeMs === file.mtimeMs) {
        result = hit;
        reused += 1;
      } else {
        parsed += 1;
        try {
          const outcome = await parseFontSource(blobSource(await file.open()), posixPath.basename(file.path));
          result = { size: file.size, mtimeMs: file.mtimeMs, type: outcome.type, faces: outcome.faces };
        } catch (error) {
          result = { size: file.size, mtimeMs: file.mtimeMs, type: 'invalid', faces: [], error: errorText(error) };
        }
      }
      nextCache[file.path] = result;
      parsedFiles[position] = { file, result };
    });

    const assembled = await assembleFontIndex({
      parsedFiles,
      mapFiles: Array.from(collected.mapFiles.keys()),
      readMapFile: async (path) => new Uint8Array(await (await collected.mapFiles.get(path)!()).arrayBuffer()),
      faceId: (file, faceIndex) => folderFaceId(file.path, faceIndex, file.size, file.mtimeMs),
      pathApi: posixPath,
      platform: 'browser',
      errors,
    });
    if (cache && (parsed > 0 || Object.keys(cached).length !== collected.files.length)) {
      await cache.save(cacheKey, { format: CACHE_FORMAT, files: nextCache });
    }
    const index: SystemFontIndex = {
      version: SYSTEM_FONT_INDEX_VERSION,
      platform: 'browser',
      scannedAt: new Date().toISOString(),
      durationMs: Math.round(now() - started),
      fromCache: parsed === 0 && collected.files.length > 0,
      roots: [{ path: collected.root, kind, exists: true, fileCount: collected.files.length }],
      faces: assembled.faces,
      hancomFaceMap: assembled.hancomFaceMap,
      errors,
    };
    current = { input, index, byId: assembled.byId };
    return index;
  }

  return {
    index(input, indexOptions = {}) {
      if (current && current.input === input && !indexOptions.refresh) return Promise.resolve(current.index);
      if (pending && !indexOptions.refresh) return pending;
      const run = scan(input).finally(() => {
        if (pending === run) pending = null;
      });
      pending = run;
      return run;
    },
    async read(id) {
      if (!/^[0-9a-f]{16}$/.test(id)) throw new Error('invalid font id');
      const entry = current?.byId.get(id);
      if (!entry) throw new Error(`unknown font id ${id}`);
      const { face, file } = entry;
      let blob: File;
      try {
        blob = await file.open();
      } catch (error) {
        throw staleError(id, `font file is gone (${errorText(error)})`);
      }
      if (blob.size !== file.size || blob.lastModified !== file.lastModified) {
        throw staleError(id, 'font file changed since the index was built');
      }
      if (face.format === 'ttc' || face.format === 'otc') {
        return extractCollectionFace(blobSource(blob), face.faceIndex);
      }
      if (blob.size > MAX_FACE_BYTES) throw new Error(`too-large: ${blob.size} bytes (cap ${MAX_FACE_BYTES})`);
      return new Uint8Array(await blob.arrayBuffer());
    },
  };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
