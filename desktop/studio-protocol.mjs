import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const STUDIO_SCHEME = 'rauhwpx';
export const STUDIO_HOST = 'app';
export const STUDIO_URL = `${STUDIO_SCHEME}://${STUDIO_HOST}/index.html`;

export function resolveDevelopmentUrl({ packaged, rawUrl }) {
  if (packaged || typeof rawUrl !== 'string' || !rawUrl.trim()) return '';
  const url = new URL(rawUrl.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('RHWP_DEV_URL must use http or https');
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('RHWP_DEV_URL must use a loopback host');
  }
  return url.href;
}

export function resolveStudioAsset(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const candidate = resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  const base = resolve(root);
  return candidate === base || candidate.startsWith(`${base}${sep}`) ? candidate : null;
}

// 데스크톱 Studio 문서에 적용하는 CSP. 확장 빌드(viewer.html)는 manifest CSP 를
// 따라가므로 여기엔 영향이 없다. hub 는 ws://127.0.0.1:<port> 로 접속한다.
const STUDIO_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

export function registerStudioScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{
    scheme: STUDIO_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      // V8 코드 캐시로 두 번째 실행부터 번들 JS 파싱·컴파일을 건너뛴다.
      codeCache: true,
    },
  }]);
}

// file:// 응답의 MIME 추정에 기대지 않는다. 특히 .wasm 이 application/wasm 이어야
// WebAssembly.instantiateStreaming 이 내려받는 동안 컴파일한다.
const STUDIO_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

export function studioMimeType(filePath) {
  return STUDIO_MIME[extname(filePath).toLowerCase()] ?? null;
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 시스템 글꼴 face
// ---------------------------------------------------------------------------
// face 를 main 프로세스에 통째로 올려 IPC 로 복사하면 해제한 뒤에도 할당자가 그만큼을 붙들고
// 있다. 앱 프로토콜 응답 본문으로 파일 조각을 흘려보내 main 에는 조각 몇 개만 머문다.
// 주소의 key 는 신뢰한 렌더러에게만 IPC 로 건네므로 IPC 경로와 같은 렌더러만 읽을 수 있다.

const SYSTEM_FONT_PREFIX = '/__system-fonts/';
const FONT_FACE_ID = /^[0-9a-f]{16}$/;

export function systemFontBaseUrl(key) {
  return `${STUDIO_SCHEME}://${STUDIO_HOST}${SYSTEM_FONT_PREFIX}${key}/`;
}

function sameKey(given, key) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * @param {Request} request
 * @param {{ fonts: { openFace(id: string): Promise<{ size: number, chunks(): AsyncIterable<Uint8Array> }> },
 *   key: string, allowOrigin?: string | null }} options
 * @returns {Promise<Response | null>} 글꼴 주소가 아니면 null
 */
export async function serveSystemFont(request, { fonts, key, allowOrigin = null }) {
  const url = new URL(request.url);
  if (url.host !== STUDIO_HOST || !url.pathname.startsWith(SYSTEM_FONT_PREFIX)) return null;
  // 개발 모드 Studio 는 Vite origin 에서 이 주소를 부르므로 그 origin 만 허용한다.
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(allowOrigin ? { 'access-control-allow-origin': allowOrigin, vary: 'Origin' } : {}),
  };
  const [givenKey, id, ...rest] = url.pathname.slice(SYSTEM_FONT_PREFIX.length).split('/');
  if (request.method !== 'GET' || rest.length > 0 || !sameKey(givenKey, key)) {
    return new Response(null, { status: 404, headers });
  }
  if (!FONT_FACE_ID.test(id)) return new Response(null, { status: 400, headers });
  let face;
  try {
    face = await fonts.openFace(id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // stale 은 Studio 가 색인을 다시 받도록 409 로 구분한다.
    const status = /^stale/i.test(message) ? 409 : /unknown/i.test(message) ? 404 : 500;
    return new Response(null, { status, headers });
  }
  return new Response(ReadableStream.from(face.chunks()), {
    status: 200,
    headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': String(face.size) },
  });
}

/**
 * 앱 프로토콜을 단다. root 가 없으면(개발 모드, Studio 는 Vite 가 낸다) 글꼴 주소만 응답한다.
 * @param {{ protocol: Electron.Protocol, net: Electron.Net, root: string | null,
 *   systemFonts: Parameters<typeof serveSystemFont>[1] }} options
 */
export function installStudioProtocol({ protocol, net, root, systemFonts }) {
  const indexPath = root ? resolve(root, 'index.html') : null;
  if (indexPath && !existsSync(indexPath)) {
    throw new Error(`Studio build is missing (${root}). Run npm run build:studio first.`);
  }

  protocol.handle(STUDIO_SCHEME, async (request) => {
    const font = await serveSystemFont(request, systemFonts);
    if (font) return font;
    const url = new URL(request.url);
    if (!root || url.host !== STUDIO_HOST || request.method !== 'GET') {
      return new Response('Not found', { status: 404 });
    }
    const requested = resolveStudioAsset(root, url.pathname);
    if (!requested) return new Response('Forbidden', { status: 403 });
    const file = await isFile(requested)
      ? requested
      : (extname(requested) ? null : indexPath);
    if (!file) return new Response('Not found', { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    const mime = studioMimeType(file);
    if (mime) headers.set('content-type', mime);
    headers.set('content-security-policy', STUDIO_CSP);
    headers.set('x-content-type-options', 'nosniff');
    return new Response(response.body, { status: response.status, headers });
  });
}
