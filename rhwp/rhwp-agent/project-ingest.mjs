// 프로젝트 자료 가져오기: 웹 주소, 허브 작업 폴더 파일, 홈 폴더 검색 결과, 텍스트 스냅숏.
// 모든 가져오기는 복사본으로 저장되고(ReferenceStore project 범위), 프로젝트 항목으로 등록됩니다.
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

import { markupToText } from './reference-extractor.mjs';

const MB = 1024 * 1024;
const MAX_TEXT_CHARS = 2_000_000;
const MAX_TITLE_CHARS = 120;
const DEFAULT_FILE_TYPES = Object.freeze([
  'pdf', 'hwp', 'hwpx', 'hml', 'docx', 'pptx', 'xlsx', 'txt', 'md', 'csv', 'json', 'html', 'htm',
  'png', 'jpg', 'jpeg', 'webp',
]);

/** Content-Type → stored extension. `html` means "save a readable .md snapshot". */
export const MIME_EXTENSIONS = Object.freeze({
  'application/pdf': 'pdf',
  'application/x-pdf': 'pdf',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/x-hwp': 'hwp',
  'application/haansofthwp': 'hwp',
  'application/vnd.hancom.hwp': 'hwp',
  'application/hwp+zip': 'hwpx',
  'application/haansofthwpx': 'hwpx',
  'application/vnd.hancom.hwpx': 'hwpx',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
});

const MIME_FOR_EXTENSION = Object.freeze({
  pdf: 'application/pdf',
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  hwp: 'application/x-hwp',
  hwpx: 'application/hwp+zip',
  hml: 'application/xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
});

// Servers often label any download this way; the file name then decides.
const GENERIC_MIMES = new Set([
  'application/octet-stream', 'binary/octet-stream', 'application/download', 'application/x-download',
  'application/force-download', 'application/zip', 'application/x-zip-compressed', 'text/plain',
]);

export class ProjectIngestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'ProjectIngestError';
  }
}

function settingsOf(settings) {
  const value = typeof settings === 'function' ? settings() : settings;
  return value && typeof value === 'object' ? value : {};
}

function ingestLimits(settings) {
  const current = settingsOf(settings);
  const types = new Set((Array.isArray(current.ingest?.fileTypes) ? current.ingest.fileTypes : DEFAULT_FILE_TYPES)
    .map((type) => String(type).toLowerCase().replace(/^\./, '')));
  const mb = Number(current.ingest?.maxFileMb);
  const maxBytes = Math.floor((Number.isFinite(mb) ? Math.min(100, Math.max(1, mb)) : 100) * MB);
  return { types, maxBytes };
}

function extensionOf(name) {
  return path.extname(String(name ?? '')).slice(1).toLowerCase();
}

function assertTypeAllowed(ext, limits, label = ext) {
  if (!ext || !limits.types.has(ext)) {
    throw new ProjectIngestError('PROJECT_INGEST_TYPE', `.${label || '?'} files are not allowed in project settings`);
  }
}

function assertSize(size, limits) {
  if (size <= 0) throw new ProjectIngestError('PROJECT_INGEST_EMPTY', 'The file is empty');
  if (size > limits.maxBytes) {
    throw new ProjectIngestError('PROJECT_INGEST_TOO_LARGE', `The file exceeds the ${Math.round(limits.maxBytes / MB)} MB limit`);
  }
}

function cleanTitle(value, fallback) {
  const text = String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, MAX_TITLE_CHARS)
    .trim();
  return text || fallback;
}

/** Choose the stored extension from the signature, Content-Type, then the file name. */
export function extensionForDownload({ mime, filename, bytes }) {
  const head = Buffer.from(bytes?.subarray?.(0, 512) ?? []);
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  const normalizedMime = String(mime ?? '').split(';', 1)[0].trim().toLowerCase();
  const mapped = MIME_EXTENSIONS[normalizedMime] ?? null;
  const fromName = extensionOf(filename);
  const knownName = Object.hasOwn(MIME_FOR_EXTENSION, fromName) ? fromName : null;
  if (mapped && !GENERIC_MIMES.has(normalizedMime)) return mapped;
  if (knownName) return knownName === 'htm' ? 'html' : knownName;
  if ((!mapped || GENERIC_MIMES.has(normalizedMime))
    && /^\s*(?:<!doctype html|<html[\s>])/i.test(head.toString('latin1'))) return 'html';
  return mapped;
}

function decodeHtml(bytes, charset) {
  const metaCharset = Buffer.from(bytes.subarray(0, 4096)).toString('latin1')
    .match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i)?.[1];
  for (const label of [charset, metaCharset, 'utf-8']) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {}
  }
  return bytes.toString('utf8');
}

function htmlTitle(html) {
  const pick = (pattern) => {
    const match = html.match(pattern)?.[1];
    return match ? markupToText(match).replace(/\s+/g, ' ').trim() : '';
  };
  return pick(/<meta[^>]+property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']*)["']/i)
    || pick(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)
    || pick(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i);
}

/** Readable markdown snapshot of an HTML page: chrome stripped, headings and list items kept. */
export function htmlToSnapshot(html, { url } = {}) {
  const source = String(html ?? '');
  const title = htmlTitle(source);
  let body = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|canvas|form|nav|header|footer|aside|button|select)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, ' ');
  const main = body.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i)?.[1]
    ?? body.match(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/i)?.[1];
  if (main && main.replace(/<[^>]+>/g, '').trim().length > 200) body = main;
  body = body
    .replace(/<h([1-6])\b[^>]*>/gi, (_match, level) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<\/li\s*>/gi, '')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(?:p|div|section|tr|table|blockquote|pre)\b[^>]*>/gi, '\n');
  const text = markupToText(body)
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const header = [`# ${title || url || '웹 페이지'}`, ''];
  if (url) header.push(`원문: ${url}`, '');
  return { title, markdown: `${header.join('\n')}\n${text}\n` };
}

async function readRegularFile(realPath, limits) {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await fs.open(realPath, fsConstants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ProjectIngestError('PROJECT_INGEST_PATH', 'Only regular files can be imported');
    assertSize(stat.size, limits);
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new ProjectIngestError('PROJECT_INGEST_CHANGED', 'The file changed while it was read');
      offset += bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/** Resolve `candidate` inside one of `allowedRoots` with no symlink anywhere below the root. */
export async function resolveAllowedPath(candidate, allowedRoots) {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) {
    throw new ProjectIngestError('PROJECT_INGEST_PATH', 'A file path is required');
  }
  const roots = [];
  for (const root of Array.isArray(allowedRoots) ? allowedRoots : []) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) continue;
    try { roots.push({ lexical: path.resolve(root), real: await fs.realpath(root) }); } catch {}
  }
  if (roots.length === 0) throw new ProjectIngestError('PROJECT_INGEST_PATH', 'No import folder is available');
  for (const root of roots) {
    const lexical = path.resolve(root.lexical, candidate);
    const base = within(root.lexical, lexical) ? root.lexical : within(root.real, lexical) ? root.real : null;
    if (!base) continue;
    const relative = path.relative(base, lexical);
    let real;
    try {
      const link = await fs.lstat(lexical);
      if (link.isSymbolicLink()) throw new ProjectIngestError('PROJECT_INGEST_PATH', 'Symbolic links cannot be imported');
      real = await fs.realpath(lexical);
    } catch (error) {
      if (error instanceof ProjectIngestError) throw error;
      throw new ProjectIngestError('PROJECT_INGEST_NOT_FOUND', 'The file does not exist');
    }
    if (!within(root.real, real) || path.relative(root.real, real) !== relative) {
      throw new ProjectIngestError('PROJECT_INGEST_PATH', 'The path leaves the allowed folder through a link');
    }
    return real;
  }
  throw new ProjectIngestError('PROJECT_INGEST_PATH', 'Only files in the chat work folder or downloads can be imported');
}

function addedByOf(actor) {
  const kind = ['user', 'agent', 'librarian'].includes(actor?.kind) ? actor.kind : 'agent';
  return {
    kind,
    ...(typeof actor?.threadId === 'string' ? { threadId: actor.threadId } : {}),
    ...(typeof actor?.agent === 'string' ? { agent: actor.agent } : {}),
  };
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return undefined;
  return tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 20);
}

/**
 * @param {{ referenceStore: any, projectStore: any, settings: object | (() => object),
 *   fetchPublic: (url: string, options?: object) => Promise<any>, homeSearch?: any,
 *   logger?: ((message: string) => void) | { info?: (message: string) => void } }} deps
 */
export function createProjectIngest({
  referenceStore,
  projectStore,
  settings,
  fetchPublic,
  homeSearch,
  logger,
} = {}) {
  const log = typeof logger === 'function' ? logger : (message) => logger?.info?.(message);

  async function store({ projectId, bytes, name, ext, source, column, tags, actor, title }) {
    if (typeof projectId !== 'string' || !projectId) {
      throw new ProjectIngestError('PROJECT_INGEST_INVALID', 'projectId is required');
    }
    const fileName = `${cleanTitle(path.basename(name, path.extname(name)), 'file')}.${ext}`;
    const mimeType = MIME_FOR_EXTENSION[ext] ?? 'application/octet-stream';
    const file = await referenceStore.addBuffer({
      bytes,
      name: fileName,
      mimeType,
      scope: 'project',
      scopeId: projectId,
    });
    const item = await projectStore.addFileItem(projectId, {
      fileId: file.id,
      scope: 'project',
      title: title ? `${cleanTitle(title, 'file')}.${ext}` : fileName,
      originalName: fileName,
      mimeType,
      size: bytes.length,
      source,
      ...(typeof column === 'string' && column ? { column } : {}),
      ...(normalizeTags(tags) ? { tags: normalizeTags(tags) } : {}),
      addedBy: addedByOf(actor),
    });
    log(`project-ingest: ${source.kind} → ${projectId}/${item?.id ?? file.id} (${bytes.length} B)`);
    return { item };
  }

  return {
    async importUrl({ projectId, url, name, column, tags, actor } = {}) {
      if (typeof fetchPublic !== 'function') throw new ProjectIngestError('PROJECT_INGEST_UNAVAILABLE', 'Web import is unavailable');
      const limits = ingestLimits(settings);
      const fetched = await fetchPublic(String(url ?? ''), { maxBytes: limits.maxBytes });
      assertSize(fetched.size ?? fetched.bytes.length, limits);
      const ext = extensionForDownload({ mime: fetched.mime, filename: fetched.filename, bytes: fetched.bytes });
      const source = {
        kind: 'web',
        url: fetched.source ?? String(url),
        ...(fetched.finalUrl && fetched.finalUrl !== fetched.source ? { finalUrl: fetched.finalUrl } : {}),
      };
      if (ext === 'html') {
        if (!['html', 'htm', 'md'].some((type) => limits.types.has(type))) assertTypeAllowed('html', limits);
        const { title, markdown } = htmlToSnapshot(decodeHtml(fetched.bytes, fetched.charset), {
          url: fetched.finalUrl ?? source.url,
        });
        const bytes = Buffer.from(markdown, 'utf8');
        const fallback = new URL(fetched.finalUrl ?? source.url).hostname;
        return store({
          projectId, bytes, ext: 'md', source, column, tags, actor,
          name: `${cleanTitle(name ? path.basename(name, path.extname(name)) : title, fallback)}.md`,
        });
      }
      if (!ext) throw new ProjectIngestError('PROJECT_INGEST_TYPE', `Unsupported content type ${fetched.mime || '(none)'}`);
      assertTypeAllowed(ext, limits);
      const base = name || fetched.filename || new URL(fetched.finalUrl ?? source.url).hostname;
      return store({ projectId, bytes: fetched.bytes, ext, source, column, tags, actor, name: `${path.basename(base, path.extname(base))}.${ext}` });
    },

    async importPath({ projectId, path: filePath, allowedRoots, name, column, tags, actor } = {}) {
      const limits = ingestLimits(settings);
      const real = await resolveAllowedPath(filePath, allowedRoots);
      const ext = extensionOf(real);
      assertTypeAllowed(ext, limits);
      const bytes = await readRegularFile(real, limits);
      return store({
        projectId, bytes, ext, column, tags, actor,
        name: path.basename(real),
        title: name ? path.basename(name, path.extname(name)) : undefined,
        source: { kind: 'workspace' },
      });
    },

    async importHomeHit({ projectId, hitId, sessionKey, name, column, tags, actor } = {}) {
      if (!homeSearch?.available) {
        throw new ProjectIngestError('PROJECT_INGEST_UNAVAILABLE', 'Home folder import is only available in the desktop app');
      }
      const limits = ingestLimits(settings);
      const resolved = typeof homeSearch.resolveHit === 'function'
        ? await homeSearch.resolveHit(hitId, sessionKey)
        : { realPath: await homeSearch.resolve(hitId, sessionKey) };
      const ext = extensionOf(resolved.realPath);
      assertTypeAllowed(ext, limits);
      const bytes = await readRegularFile(resolved.realPath, limits);
      return store({
        projectId, bytes, ext, column, tags, actor,
        name: path.basename(resolved.realPath),
        title: name ? path.basename(name, path.extname(name)) : undefined,
        source: { kind: 'home', ...(resolved.homePath ? { homePath: resolved.homePath } : {}) },
      });
    },

    async importText({ projectId, text, url, name, column, tags, actor } = {}) {
      const limits = ingestLimits(settings);
      if (typeof text !== 'string' || !text.trim()) throw new ProjectIngestError('PROJECT_INGEST_EMPTY', 'text is required');
      if (text.length > MAX_TEXT_CHARS) throw new ProjectIngestError('PROJECT_INGEST_TOO_LARGE', 'text is too long');
      let sourceUrl;
      if (url !== undefined && url !== null && url !== '') {
        try {
          const parsed = new URL(String(url));
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
          parsed.username = '';
          parsed.password = '';
          sourceUrl = parsed.href;
        } catch {
          throw new ProjectIngestError('PROJECT_INGEST_INVALID', 'url must be an http(s) URL');
        }
      }
      const requestedExt = extensionOf(name);
      const ext = requestedExt === 'txt' ? 'txt' : 'md';
      assertTypeAllowed(ext, limits);
      const title = cleanTitle(path.basename(String(name ?? ''), path.extname(String(name ?? ''))), sourceUrl ? new URL(sourceUrl).hostname : '메모');
      const body = sourceUrl && !text.includes(sourceUrl) ? `원문: ${sourceUrl}\n\n${text}` : text;
      const bytes = Buffer.from(body.endsWith('\n') ? body : `${body}\n`, 'utf8');
      assertSize(bytes.length, limits);
      return store({
        projectId, bytes, ext, column, tags, actor,
        name: `${title}.${ext}`,
        source: { kind: 'text', ...(sourceUrl ? { url: sourceUrl } : {}) },
      });
    },
  };
}
