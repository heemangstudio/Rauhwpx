/**
 * 허브가 돌고 있는 PC의 설치 글꼴을 브라우저 Studio에 내준다.
 *
 * 데스크톱 앱과 같은 색인기(desktop/system-fonts.mjs)로 OS·Office·한컴 글꼴 폴더를 훑어,
 * 브라우저가 폴더 선택이나 권한 요청 없이 데스크톱과 같은 글꼴을 쓰게 한다.
 *   GET /fonts/index          → SystemFontIndex (JSON)
 *   GET /fonts/faces/<id>     → face 바이트 (TTC face는 단독 SFNT로 추출)
 * 참고자료와 같은 세션 capability(REFERENCE)와 로컬 Studio origin만 받는다. 색인에 있는
 * face id만 읽으며 임의 경로는 받지 않는다.
 */
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { isAllowedStudioOrigin } from './reference-http.mjs';

const FACE_ID = /^[0-9a-f]{16}$/;

export function isFontPath(pathname) {
  return pathname === '/fonts/index' || pathname.startsWith('/fonts/faces/');
}

function corsHeaders(origin) {
  return origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
}

function sendJson(res, status, body, origin) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...corsHeaders(origin),
  });
  res.end(JSON.stringify(body));
}

/**
 * @param {{
 *   authenticate: (req: import('node:http').IncomingMessage, url: URL) => unknown,
 *   loadService?: () => Promise<{
 *     list(options?: { refresh?: boolean }): Promise<unknown>,
 *     openFace(id: string): Promise<{ size: number, chunks(): AsyncIterable<Uint8Array> }>,
 *   }>,
 *   log?: (line: string) => void,
 * }} options
 */
export function createFontHttpHandler({ authenticate, loadService = loadDesktopFontService, log = () => {} }) {
  let service = null;
  const getService = () => {
    service ??= loadService().catch((error) => {
      service = null;
      throw error;
    });
    return service;
  };

  return async function handleFontHttp(req, res, url) {
    if (!isFontPath(url.pathname)) return false;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    if (origin && !isAllowedStudioOrigin(origin)) {
      sendJson(res, 403, { status: 'forbidden' });
      return true;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...corsHeaders(origin),
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'Authorization',
        'access-control-max-age': '600',
      });
      res.end();
      return true;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { status: 'method-not-allowed' }, origin);
      return true;
    }
    try {
      authenticate(req, url);
    } catch {
      sendJson(res, 401, { status: 'unauthorized' }, origin);
      return true;
    }

    let fonts;
    try {
      fonts = await getService();
    } catch (error) {
      log(`font index unavailable: ${error instanceof Error ? error.message : String(error)}`);
      sendJson(res, 503, { status: 'unavailable' }, origin);
      return true;
    }

    if (url.pathname === '/fonts/index') {
      try {
        const index = await fonts.list({ refresh: url.searchParams.get('refresh') === '1' });
        sendJson(res, 200, index, origin);
      } catch (error) {
        log(`font scan failed: ${error instanceof Error ? error.message : String(error)}`);
        sendJson(res, 500, { status: 'error' }, origin);
      }
      return true;
    }

    const id = decodeURIComponent(url.pathname.slice('/fonts/faces/'.length));
    if (!FACE_ID.test(id)) {
      sendJson(res, 400, { status: 'invalid-id' }, origin);
      return true;
    }
    let face;
    try {
      face = await fonts.openFace(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // stale은 Studio가 색인을 다시 받도록 409로 구분한다.
      const status = /^stale/i.test(message) ? 409 : /unknown/i.test(message) ? 404 : 500;
      sendJson(res, status, { status: status === 409 ? 'stale' : 'error', message }, origin);
      return true;
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': face.size,
      'cache-control': 'no-store, private',
      'x-content-type-options': 'nosniff',
      ...corsHeaders(origin),
    });
    // 큰 글꼴을 통째로 들지 않도록 조각으로 흘려보낸다. 도중에 실패하면 응답을 끊는다.
    try {
      await pipeline(face.chunks(), res);
    } catch (error) {
      if (error?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        log(`font read failed ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return true;
  };
}

/** 허브를 다시 띄울 때 글꼴 파일을 모두 다시 파싱하지 않도록 파일별 파싱 결과를 사용자 폴더에 둔다. */
export function defaultFontCacheDir(env = process.env, platform = process.platform, home = os.homedir()) {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  if (env.RHWP_FONT_CACHE_DIR) return platformPath.resolve(env.RHWP_FONT_CACHE_DIR);
  if (platform === 'darwin') return platformPath.join(home, 'Library', 'Application Support', 'rhwp', 'fonts');
  if (platform === 'win32') {
    return platformPath.join(env.APPDATA || platformPath.join(home, 'AppData', 'Roaming'), 'rhwp', 'fonts');
  }
  return platformPath.join(env.XDG_DATA_HOME || platformPath.join(home, '.local', 'share'), 'rhwp', 'fonts');
}

/** 저장소나 데스크톱 패키지 안에서만 색인기가 있다. 없으면 503으로 알린다. */
async function loadDesktopFontService() {
  const { createSystemFontService } = await import(new URL('../../desktop/system-fonts.mjs', import.meta.url).href);
  return createSystemFontService({
    cacheDir: defaultFontCacheDir(),
    log: (line) => console.log(`[rhwp-agent] fonts: ${line}`),
  });
}
