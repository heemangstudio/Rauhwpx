// public/fonts 는 ../assets/fonts 를 가리키는 git 심볼릭 링크다.
// Windows 체크아웃은 심볼릭 링크를 실제 디렉터리로 만들지 못해 링크 대상 경로가 적힌
// 일반 텍스트 파일만 남는다. 그러면 dev 서버의 /fonts/* 요청이 SPA 폴백(index.html)으로
// 흘러 번들 웹폰트 전체가 파싱 실패하고, Windows 에서 빌드된 패키지의 dist/fonts 도
// 같은 텍스트 파일 하나만 실린다 — 가나·키릴 등 번들 폰트가 커버하는 글리프도 tofu.
// 링크가 실체화되지 않았을 때만: dev 서버는 assets/fonts 를 /fonts 아래로 서빙하고,
// 빌드는 assets/fonts 파일들을 dist/fonts 로 복사한다.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

const FONT_MIME = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

/** public/fonts 심볼릭 링크가 실제 디렉터리로 풀렸는지 확인한다. */
function publicFontsMaterialized(publicFontsPath) {
  try {
    return statSync(publicFontsPath).isDirectory();
  } catch {
    return false;
  }
}

export function rhwpLocalFontsPlugin(studioDir) {
  const publicFontsPath = resolve(studioDir, 'public', 'fonts');
  const assetsFontsDir = resolve(studioDir, '..', 'assets', 'fonts');
  if (publicFontsMaterialized(publicFontsPath)) return { name: 'hamaeditor-local-fonts' };
  try {
    if (!statSync(assetsFontsDir).isDirectory()) return { name: 'hamaeditor-local-fonts' };
  } catch {
    return { name: 'hamaeditor-local-fonts' };
  }

  return {
    name: 'hamaeditor-local-fonts',
    configureServer(server) {
      server.middlewares.use('/fonts', (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const pathname = decodeURIComponent(req.url?.split('?')[0] ?? '');
        const relPath = pathname.replace(/^\/+/, '');
        if (!relPath || relPath.includes('..') || relPath.includes('/') || relPath.includes('\\')) {
          res.statusCode = 404;
          return res.end();
        }
        const ext = extname(relPath).toLowerCase();
        if (!FONT_MIME[ext]) { res.statusCode = 404; return res.end(); }
        const full = join(assetsFontsDir, relPath);
        let stat;
        try { stat = statSync(full); } catch { res.statusCode = 404; return res.end(); }
        if (!stat.isFile()) { res.statusCode = 404; return res.end(); }
        res.setHeader('Content-Type', FONT_MIME[ext]);
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(req.method === 'HEAD' ? undefined : readFileSync(full));
      });
    },
    closeBundle() {
      const outDir = resolve(studioDir, 'dist', 'fonts');
      mkdirSync(outDir, { recursive: true });
      for (const entry of readdirSync(assetsFontsDir)) {
        const ext = extname(entry).toLowerCase();
        if (!FONT_MIME[ext]) continue;
        const src = join(assetsFontsDir, entry);
        if (!statSync(src).isFile()) continue;
        copyFileSync(src, join(outDir, basename(entry)));
      }
    },
  };
}
