import { createReadStream } from 'node:fs';

import {
  bearerMatchesAny,
  isAllowedStudioOrigin,
  referenceErrorStatus,
  sendJson,
} from './reference-http.mjs';

/**
 * 연구 프로젝트 HTTP API. 인증은 참고 자료 API 와 같다(REFERENCE 용도 capability + Bearer,
 * 허용된 Studio 출처). 세션은 자기에게 묶인 프로젝트(문서가 속한 프로젝트)만 읽고 바꾼다.
 * 설정의 저장 공간 화면을 위해 목록·삭제·휴지통 비우기·합류 대상은 모든 프로젝트에 열려 있다.
 */

const MAX_JSON_BYTES = 64 * 1024;
const MAX_OPS_JSON_BYTES = 12 * 1024 * 1024;
const PROJECT_ID = '(p[a-z2-7]{10})';
const ITEM_ID = '([fnd][a-z2-7]{6})';
const SAFE_MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

export function isProjectPath(pathname) {
  return pathname === '/projects' || pathname.startsWith('/projects/') || pathname === '/project-settings';
}

function httpError(code, message, status = null) {
  const error = new Error(message);
  error.code = code;
  if (status) error.status = status;
  return error;
}

function errorStatus(error) {
  if (Number.isSafeInteger(error?.status)) return error.status;
  switch (error?.code) {
    case 'PROJECT_NOT_FOUND':
    case 'PROJECT_ITEM_NOT_FOUND': return 404;
    case 'PROJECT_FORBIDDEN': return 403;
    case 'PROJECT_REVISION_MISMATCH':
    case 'PROJECT_NOT_BOUND': return 409;
    case 'PROJECT_LIMIT':
    case 'PROJECT_BODY_TOO_LARGE':
    case 'PROJECT_INGEST_TOO_LARGE': return 413;
    case 'PROJECT_INGEST_TYPE': return 415;
    case 'PROJECT_OP_INVALID':
    case 'PROJECT_SETTINGS_INVALID':
    case 'PROJECT_BODY_INVALID':
    case 'PROJECT_INGEST_INVALID':
    case 'PROJECT_INGEST_EMPTY': return 400;
    case 'PROJECT_INGEST_UNAVAILABLE':
    case 'PROJECT_LIBRARIAN_UNAVAILABLE': return 503;
    case 'PROJECT_STORE_CORRUPT': return 500;
    default:
      return String(error?.code ?? '').startsWith('REFERENCE_') ? referenceErrorStatus(error) : 500;
  }
}

async function readJsonBody(req, maximum = MAX_JSON_BYTES) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maximum) {
    throw httpError('PROJECT_BODY_TOO_LARGE', `Request body exceeds ${maximum} bytes`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw httpError('PROJECT_BODY_TOO_LARGE', `Request body exceeds ${maximum} bytes`);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object expected');
    return parsed;
  } catch {
    throw httpError('PROJECT_BODY_INVALID', 'Request body must be a JSON object');
  }
}

function decodeUploadName(header) {
  const raw = String(header ?? '');
  if (!raw) return '';
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function contentDisposition(kind, name, fileKind) {
  const inline = fileKind === 'pdf' || fileKind === 'image';
  const encoded = encodeURIComponent(name).replaceAll('%20', ' ');
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * @param {{
 *   projectStore: any, referenceStore: any, settingsStore: any, librarian?: any,
 *   tokens: string[], session: {projectId: string|null, documentId: string|null, documentName?: string|null,
 *     labels?: {current: object|null, auto: object|null}} | null,
 *   homeAccess?: boolean, platform?: string,
 *   onBindingChanged?: (projectId: string|null) => void|Promise<void>,
 * }} options
 */
export function createProjectHttpHandler({
  projectStore,
  referenceStore,
  settingsStore,
  librarian = null,
  tokens,
  session,
  homeAccess = false,
  platform = process.platform,
  onBindingChanged = null,
}) {
  const boundProjectId = session?.projectId ?? null;
  const documentId = session?.documentId ?? null;
  // 작업 공간 표시: 이 세션의 작업 공간이 'current' 이고, 새로 올린 파일은 auto 표시를 받는다.
  const labels = session?.labels ?? null;

  /** 세션이 다룰 수 있는 프로젝트인가 — 묶인 프로젝트 또는 세션 문서가 속한 프로젝트. */
  const assertOwned = (projectId) => {
    if (!boundProjectId && !documentId) {
      throw httpError('PROJECT_NOT_BOUND', 'Start a chat to open its research project');
    }
    const documentProject = documentId ? projectStore.projectIdForDocument(documentId) : null;
    if (projectId !== boundProjectId && projectId !== documentProject) {
      throw httpError('PROJECT_FORBIDDEN', 'This project is not open in this session');
    }
    if (!projectStore.hasProject(projectId)) throw httpError('PROJECT_NOT_FOUND', 'Project was not found');
    return projectId;
  };
  const assertExists = (projectId) => {
    if (!projectStore.hasProject(projectId)) throw httpError('PROJECT_NOT_FOUND', 'Project was not found');
    return projectId;
  };
  const assertSessionDocument = (requested) => {
    if (!documentId || requested !== documentId) {
      throw httpError('PROJECT_FORBIDDEN', 'Only the document open in this session can join or leave a project');
    }
    return documentId;
  };
  const fileScopes = (projectId, item) => [item.scope === 'global'
    ? { scope: 'global', scopeId: 'global' }
    : { scope: 'project', scopeId: projectId }];
  const fileItem = async (projectId, itemId) => {
    const item = await projectStore.getItem(projectId, itemId);
    if (item.kind !== 'file') throw httpError('PROJECT_ITEM_NOT_FOUND', `${itemId} is not a file`);
    return item;
  };
  const settingsPayload = () => ({
    settings: settingsStore.get(),
    capabilities: { homeAccess: homeAccess === true, platform },
  });

  return async function handleProjectHttp(req, res, url) {
    if (!isProjectPath(url.pathname)) return false;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    if (origin && !isAllowedStudioOrigin(origin)) {
      req.resume?.();
      const message = 'Project API accepts only local Studio origins';
      sendJson(res, 403, { status: 'error', message, error: { code: 'PROJECT_ORIGIN_DENIED', message } });
      return true;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'Authorization, Content-Type, X-File-Name',
        'access-control-max-age': '600',
      });
      res.end();
      return true;
    }
    if (!bearerMatchesAny(req, tokens)) {
      req.resume?.();
      const message = 'A valid bearer token is required';
      sendJson(res, 401, { status: 'error', message, error: { code: 'PROJECT_UNAUTHORIZED', message } }, origin);
      return true;
    }
    const reply = (status, body) => {
      sendJson(res, status, body, origin);
      return true;
    };
    const { pathname } = url;
    const method = req.method;
    try {
      if (pathname === '/project-settings') {
        if (method === 'GET') return reply(200, settingsPayload());
        if (method === 'PUT') {
          const body = await readJsonBody(req);
          await settingsStore.save(body.settings ?? body);
          return reply(200, settingsPayload());
        }
        throw httpError('PROJECT_METHOD_NOT_ALLOWED', 'Method not allowed', 405);
      }
      if (pathname === '/projects') {
        if (method === 'GET') return reply(200, { projects: await projectStore.list() });
        if (method === 'POST') {
          const body = await readJsonBody(req);
          const joining = body.documentId === undefined || body.documentId === null
            ? null
            : assertSessionDocument(body.documentId);
          const project = await projectStore.createProject({
            name: body.name,
            documentId: joining,
            documentName: session?.documentName ?? null,
          });
          if (joining) await onBindingChanged?.(project.id);
          return reply(201, { project: joining ? await projectStore.get(project.id) : project });
        }
        throw httpError('PROJECT_METHOD_NOT_ALLOWED', 'Method not allowed', 405);
      }
      if (pathname === '/projects/current' && method === 'GET') {
        const projectId = boundProjectId ?? (documentId ? projectStore.projectIdForDocument(documentId) : null);
        if (!projectId) throw httpError('PROJECT_NOT_BOUND', 'Start a chat to open its research project');
        return reply(200, { project: await projectStore.get(projectId) });
      }

      let match = new RegExp(`^/projects/${PROJECT_ID}$`).exec(pathname);
      if (match) {
        const projectId = match[1];
        if (method === 'GET') {
          assertOwned(projectId);
          return reply(200, { project: await projectStore.get(projectId, { trash: url.searchParams.get('trash') === '1' }) });
        }
        if (method === 'DELETE') {
          assertExists(projectId);
          const result = await projectStore.deleteProject(projectId);
          if (projectId === boundProjectId) await onBindingChanged?.(null);
          return reply(200, result);
        }
        throw httpError('PROJECT_METHOD_NOT_ALLOWED', 'Method not allowed', 405);
      }

      match = new RegExp(`^/projects/${PROJECT_ID}/(ops|undo|join|leave|rename|librarian|trash/empty)$`).exec(pathname);
      if (match && method === 'POST') {
        const [, projectId, action] = match;
        if (action === 'join') {
          assertExists(projectId);
          const body = await readJsonBody(req);
          const joined = await projectStore.join(projectId, assertSessionDocument(body.documentId), {
            name: session?.documentName ?? null,
          });
          await onBindingChanged?.(joined.projectId);
          return reply(200, { projectId, merged: joined.merged, project: await projectStore.get(projectId) });
        }
        if (action === 'trash/empty') {
          assertExists(projectId);
          return reply(200, await projectStore.emptyTrash(projectId));
        }
        assertOwned(projectId);
        if (action === 'ops') {
          const body = await readJsonBody(req, MAX_OPS_JSON_BYTES);
          const result = await projectStore.applyOps(projectId, {
            ops: body.ops,
            actor: { kind: 'user' },
            expectedRevision: body.expectedRevision,
            labels,
          });
          return reply(200, result);
        }
        if (action === 'undo') {
          const body = await readJsonBody(req);
          return reply(200, await projectStore.undo(projectId, { activityId: body.activityId, actor: { kind: 'user' } }));
        }
        if (action === 'rename') {
          const body = await readJsonBody(req);
          return reply(200, { project: await projectStore.renameProject(projectId, body.name) });
        }
        if (action === 'leave') {
          const body = await readJsonBody(req);
          const left = await projectStore.leave(projectId, assertSessionDocument(body.documentId));
          await onBindingChanged?.(left.projectId);
          return reply(200, { projectId: left.projectId, project: await projectStore.get(left.projectId) });
        }
        if (action === 'librarian') {
          if (!librarian) throw httpError('PROJECT_LIBRARIAN_UNAVAILABLE', 'The librarian is unavailable');
          const body = await readJsonBody(req);
          if (body.itemId !== undefined) await projectStore.getItem(projectId, body.itemId);
          let status;
          if (body.action === 'pause') status = librarian.pause(projectId);
          else if (body.action === 'resume') status = librarian.resume(projectId);
          else if (body.action === 'retry') status = await librarian.retry(projectId, body.itemId);
          else throw httpError('PROJECT_OP_INVALID', 'action must be pause, resume, or retry');
          return reply(200, { librarian: status });
        }
      }

      match = new RegExp(`^/projects/${PROJECT_ID}/activity$`).exec(pathname);
      if (match && method === 'GET') {
        const projectId = assertOwned(match[1]);
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const entries = await projectStore.listActivity(projectId, {
          limit: Number.isSafeInteger(limit) ? limit : 50,
          before: url.searchParams.get('before'),
        });
        return reply(200, { entries });
      }

      match = new RegExp(`^/projects/${PROJECT_ID}/notes/${ITEM_ID}$`).exec(pathname);
      if (match && method === 'GET') {
        const projectId = assertOwned(match[1]);
        return reply(200, await projectStore.readNote(projectId, match[2]));
      }

      match = new RegExp(`^/projects/${PROJECT_ID}/files$`).exec(pathname);
      if (match && method === 'POST') {
        const projectId = assertOwned(match[1]);
        const maxBytes = (settingsStore.get().ingest?.maxFileMb ?? 100) * 1024 * 1024;
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          throw httpError('PROJECT_INGEST_TOO_LARGE', `Files are limited to ${maxBytes / (1024 * 1024)} MB in project settings`);
        }
        const column = url.searchParams.get('column');
        const file = await referenceStore.addStream({
          stream: req,
          name: decodeUploadName(req.headers['x-file-name']),
          mimeType: req.headers['content-type'],
          contentLength: req.headers['content-length'],
          scope: 'project',
          scopeId: projectId,
        });
        const item = await projectStore.addFileItem(projectId, {
          fileId: file.id,
          scope: 'project',
          source: { kind: 'upload' },
          ...(column ? { column } : {}),
          addedBy: { kind: 'user' },
          ...(labels?.auto ? { origin: labels.auto } : {}),
        });
        return reply(201, { item });
      }

      match = new RegExp(`^/projects/${PROJECT_ID}/files/${ITEM_ID}/(blob|text|chunks/(c\\d{1,7}))$`).exec(pathname);
      if (match && method === 'GET') {
        const projectId = assertOwned(match[1]);
        const item = await fileItem(projectId, match[2]);
        const scopes = fileScopes(projectId, item);
        if (match[3] === 'blob') {
          const blob = await referenceStore.openBlob({ fileId: item.fileId, scopes });
          const mimeType = SAFE_MIME.test(blob.mimeType) ? blob.mimeType : 'application/octet-stream';
          res.writeHead(200, {
            'content-type': mimeType,
            'content-length': String(blob.size),
            'content-disposition': contentDisposition(blob.kind, item.originalName ?? blob.name, item.fileKind),
            'cache-control': 'no-store, private',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "sandbox; default-src 'none'",
            ...(origin ? {
              'access-control-allow-origin': origin,
              'access-control-expose-headers': 'Content-Disposition, Content-Length',
              vary: 'Origin',
            } : {}),
          });
          const stream = createReadStream(blob.path);
          stream.on('error', () => res.destroy());
          stream.pipe(res);
          return true;
        }
        if (match[3] === 'text') {
          const page = Number(url.searchParams.get('page') ?? 1);
          const text = await referenceStore.readPageText({
            fileId: item.fileId,
            scopes,
            page: Number.isSafeInteger(page) ? page : 1,
          });
          return reply(200, {
            page: text.page,
            pageCount: text.pageCount,
            paged: text.paged,
            text: text.text,
            chunks: text.chunks,
            truncated: text.truncated,
          });
        }
        const chunk = await referenceStore.readChunk({ fileId: item.fileId, chunkId: match[4], scopes, maxChars: 20_000 });
        return reply(200, { chunkId: chunk.chunkId, page: chunk.page, start: chunk.start, end: chunk.end, text: chunk.text });
      }

      throw httpError(
        match || /^\/projects\//.test(pathname) ? 'PROJECT_METHOD_NOT_ALLOWED' : 'PROJECT_NOT_FOUND',
        'Unknown project route',
        404,
      );
    } catch (error) {
      try { req.resume?.(); } catch {}
      const message = String(error?.message ?? error);
      if (!res.headersSent) {
        sendJson(res, errorStatus(error), {
          status: 'error',
          message,
          error: { code: error?.code ?? 'PROJECT_REQUEST_FAILED', message },
        }, origin);
      } else {
        res.destroy();
      }
      return true;
    }
  };
}

/** 프로젝트/문서가 없어도 쓸 수 있는 소유자 다운로드함. 모든 바이트 요청에 Bearer 인증을 확인한다. */
export function isBrowserDownloadsPath(pathname) {
  return pathname === '/browser-downloads' || pathname.startsWith('/browser-downloads/');
}

export function createBrowserDownloadsHttpHandler({ downloads, tokens, actor, canImportProject = null }) {
  return async function handleBrowserDownloadsHttp(req, res, url) {
    if (!isBrowserDownloadsPath(url.pathname)) return false;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    if (origin && !isAllowedStudioOrigin(origin)) {
      req.resume?.();
      sendJson(res, 403, { status: 'error', error: { code: 'BROWSER_DOWNLOAD_ORIGIN_DENIED', message: 'Studio origin is required' } });
      return true;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
        'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'Authorization, Content-Type' });
      res.end(); return true;
    }
    if (!bearerMatchesAny(req, tokens)) {
      req.resume?.();
      sendJson(res, 401, { status: 'error', error: { code: 'BROWSER_DOWNLOAD_UNAUTHORIZED', message: 'A valid bearer token is required' } }, origin);
      return true;
    }
    const currentActor = typeof actor === 'function' ? actor() : actor;
    const reply = (status, body) => { sendJson(res, status, body, origin); return true; };
    try {
      if (url.pathname === '/browser-downloads' && req.method === 'GET') {
        return reply(200, { downloads: await downloads.list(currentActor) });
      }
      const match = /^\/browser-downloads\/(bd_[a-f0-9]{32})(?:\/(bytes|cancel|retry|import))?$/.exec(url.pathname);
      if (!match) return reply(404, { status: 'error', error: { code: 'BROWSER_DOWNLOAD_NOT_FOUND', message: 'Download was not found' } });
      const [, downloadId, action] = match;
      if (req.method === 'GET' && !action) return reply(200, { job: await downloads.get({ downloadId, actor: currentActor }) });
      if (req.method === 'GET' && action === 'bytes') {
        const { bytes, filename, mimeType } = await downloads.readBytes({ downloadId, actor: currentActor });
        const mime = mimeType === 'application/pdf' ? 'application/pdf' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': mime, 'content-length': bytes.length, 'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
          'content-disposition': contentDisposition(null, filename, mime === 'application/pdf' ? 'pdf' : 'other'),
          ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}) });
        res.end(bytes); return true;
      }
      if (req.method === 'POST' && ['cancel', 'retry', 'import'].includes(action)) {
        const body = await readJsonBody(req);
        if (action === 'import' && canImportProject && !await canImportProject(body.projectId, currentActor)) {
          throw httpError('PROJECT_FORBIDDEN', 'Project is not available to this session');
        }
        const method = action === 'import' ? 'importDownload' : action;
        const job = await downloads[method]({ downloadId, actor: currentActor, ...(action === 'import' ? { projectId: body.projectId } : {}) });
        return reply(200, { job });
      }
      return reply(405, { status: 'error', error: { code: 'BROWSER_DOWNLOAD_METHOD', message: 'Method not allowed' } });
    } catch (error) {
      const status = error?.code === 'BROWSER_DOWNLOAD_NOT_FOUND' ? 404
        : error?.code === 'BROWSER_DOWNLOAD_FORBIDDEN' ? 403
          : ['BROWSER_DOWNLOAD_NOT_READY', 'BROWSER_DOWNLOAD_ALREADY_IMPORTED', 'BROWSER_DOWNLOAD_RETRY_SOURCE'].includes(error?.code) ? 409
            : errorStatus(error);
      return reply(status, { status: 'error', error: { code: error?.code ?? 'BROWSER_DOWNLOAD_FAILED', message: 'Download action failed' } });
    }
  };
}
