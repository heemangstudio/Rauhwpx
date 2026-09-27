// 명시적으로 설정한 로컬 서체만 개발 서버의 같은 출처로 전달한다.
// 폰트 원본과 경로 목록은 저장소 밖에 두고, 브라우저에는 파일명과 해시 URL만 노출한다.
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute } from 'node:path';

const ROUTE = '/__dev-font-pack';
const MAX_FACE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_FACES = 64;

function configuredFaces(manifestPath) {
  if (!isAbsolute(manifestPath)) throw new Error('RHWP_DEV_FONT_PACK must be an absolute JSON path');
  const paths = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_FACES) {
    throw new Error(`RHWP_DEV_FONT_PACK must list 1–${MAX_FACES} font paths`);
  }
  let totalBytes = 0;
  const seen = new Set();
  return paths.map((requestedPath, index) => {
    if (typeof requestedPath !== 'string' || !isAbsolute(requestedPath)) {
      throw new Error(`RHWP_DEV_FONT_PACK entry ${index} must be an absolute font path`);
    }
    const file = realpathSync(requestedPath);
    if (seen.has(file)) throw new Error(`Duplicate font path in RHWP_DEV_FONT_PACK: ${index}`);
    seen.add(file);
    if (!['.ttf', '.otf'].includes(extname(file).toLowerCase())) {
      throw new Error(`Unsupported font extension in RHWP_DEV_FONT_PACK: ${index}`);
    }
    const stat = statSync(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FACE_BYTES) {
      throw new Error(`Font exceeds the Studio per-face import limit: ${index}`);
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('RHWP_DEV_FONT_PACK exceeds the Studio 128 MiB aggregate import limit');
    }
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    return {
      file,
      name: basename(file),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      hash,
      url: `${ROUTE}/file/${index}/${hash}`,
    };
  });
}

export function rhwpDevFontPackPlugin() {
  const manifestPath = process.env.RHWP_DEV_FONT_PACK;
  if (!manifestPath) return { name: 'rhwp-dev-font-pack' };
  const faces = configuredFaces(manifestPath);
  return {
    name: 'rhwp-dev-font-pack',
    apply: 'serve',
    config() {
      return { define: { 'import.meta.env.VITE_RHWP_DEV_FONT_PACK': JSON.stringify('1') } };
    },
    configureServer(server) {
      server.middlewares.use(ROUTE, (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const pathname = req.url?.split('?')[0];
        if (pathname === '/manifest.json') {
          const body = JSON.stringify({ version: 1, fonts: faces.map(({ name, size, url }) => ({ name, size, url })) });
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(req.method === 'HEAD' ? undefined : body);
          return;
        }
        const match = /^\/file\/(\d{1,2})\/([a-f0-9]{64})$/.exec(pathname ?? '');
        const face = match && faces[Number(match[1])];
        if (!face || match[2] !== face.hash) {
          res.statusCode = 404;
          res.end();
          return;
        }
        let current;
        try {
          current = statSync(face.file);
        } catch {
          res.statusCode = 410;
          res.end('Configured font file is no longer available');
          return;
        }
        if (current.size !== face.size || current.mtimeMs !== face.mtimeMs) {
          res.statusCode = 409;
          res.end('Font file changed; restart the dev server');
          return;
        }
        res.setHeader('Content-Type', extname(face.file).toLowerCase() === '.otf' ? 'font/otf' : 'font/ttf');
        res.setHeader('Content-Length', face.size);
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (req.method === 'HEAD') { res.end(); return; }
        createReadStream(face.file).on('error', () => res.destroy()).pipe(res);
      });
    },
  };
}
