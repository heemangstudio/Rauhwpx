import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';

// PDF 미리보기(pdf-viewer.ts)가 쓰는 pdfjs-dist 의 CMap·표준 글꼴을 같은 출처의
// /pdfjs/cmaps/, /pdfjs/standard_fonts/ 로 낸다. 개발 서버는 node_modules 에서 바로
// 읽고, 빌드는 dist 에 그대로 복사한다. 외부 CDN 을 쓰지 않으므로 CSP 를 넓히지 않는다.
const FOLDERS = ['cmaps', 'standard_fonts'];

function pdfjsRoot() {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve('pdfjs-dist/package.json'));
}

export function rhwpPdfjsAssetsPlugin() {
  let root = '';
  return {
    name: 'rhwp-pdfjs-assets',
    configResolved() {
      root = pdfjsRoot();
    },
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const path = decodeURIComponent((req.url ?? '').split('?')[0] ?? '').replace(/^\/+/, '');
        const [folder] = path.split('/');
        if (!FOLDERS.includes(folder)) return next();
        const base = resolve(root, folder);
        const file = resolve(root, path);
        if (!file.startsWith(`${base}${sep}`)) {
          res.statusCode = 403;
          res.end();
          return;
        }
        try {
          if (!statSync(file).isFile()) return next();
        } catch {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const folder of FOLDERS) {
        const dir = join(root, folder);
        for (const name of readdirSync(dir)) {
          const file = join(dir, name);
          if (!statSync(file).isFile()) continue;
          this.emitFile({ type: 'asset', fileName: `pdfjs/${folder}/${name}`, source: readFileSync(file) });
        }
      }
    },
  };
}
