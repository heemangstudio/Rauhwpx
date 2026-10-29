// 개발자가 명시한 글꼴·한컴 변환표만 이 개발 서버에서 읽는다.
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { initSync, fileFamilyNames } from './vendor/hm-wasm/hm_wasm.js';

export function heemangFontsPlugin(studioDir) {
  const manifest = process.env.RHWP_HEEMANG_FONT_ASSETS;
  if (!manifest) return { name: 'heemang-fonts' };
  const paths = JSON.parse(readFileSync(manifest, 'utf8'));
  if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !isAbsolute(p) || !/\.(ttf|otf|ttc|hft|dat)$/i.test(p))) throw new Error('RHWP_HEEMANG_FONT_ASSETS must list absolute font/table paths');
  // hftinfo와 FontMap은 HFT 파일보다 먼저 등록한다.
  paths.sort((a, b) => Number(!/\.dat$/i.test(a)) - Number(!/\.dat$/i.test(b)));
  initSync({ module: readFileSync(resolve(studioDir, 'vendor/hm-wasm/hm_wasm_bg.wasm')) });
  const assets = paths.map((p, i) => {
    const fd = openSync(p, 'r');
    try {
      const size = fstatSync(fd).size;
      const file = { size, read(offset, length) {
        const bytes = Buffer.alloc(length);
        return bytes.subarray(0, readSync(fd, bytes, 0, length, offset));
      } };
      return {
        name: basename(p), url: `/__heemang-fonts/${i}`, size,
        families: /\.dat$/i.test(p) ? [] : JSON.parse(fileFamilyNames(file)),
      };
    } finally {
      closeSync(fd);
    }
  });
  return {
    name: 'heemang-fonts',
    config: () => ({ define: { 'import.meta.env.VITE_HEEMANG_FONT_ASSETS': JSON.stringify('1') } }),
    configureServer(server) {
      server.middlewares.use('/__heemang-fonts', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
        if (req.url === '/manifest.json') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(assets));
          return;
        }
        const index = /^\/(\d+)$/.exec(req.url ?? '')?.[1];
        if (index === undefined || !paths[Number(index)]) { res.statusCode = 404; res.end(); return; }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(readFileSync(paths[Number(index)]));
      });
    },
  };
}
