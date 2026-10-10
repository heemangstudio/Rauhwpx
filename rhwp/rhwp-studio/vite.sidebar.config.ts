import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { liveUsagePlugin } from './sidebar-preview/live-usage-plugin.mjs';
import { rhwpPdfjsAssetsPlugin } from './vite-plugin-pdfjs-assets.mjs';

// Deliberately independent of vite.config.ts: no agent hub, WASM, or PWA plugin.
export default defineConfig({
  // 같은 의존성 폴더를 쓰는 편집기와 작업 트리도 최적화 캐시를 공유하지 않는다.
  cacheDir: resolve(import.meta.dirname, '.run/vite-cache/sidebar'),
  // 그래프를 처음 열 때 의존성을 재최적화하며 기존 모듈 URL을 만료시키지 않는다.
  optimizeDeps: { include: ['d3-force'] },
  plugins: [liveUsagePlugin(), rhwpPdfjsAssetsPlugin()],
  root: resolve(import.meta.dirname, 'sidebar-preview'),
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
      '/src': resolve(import.meta.dirname, 'src'),
      'virtual:pwa-register': resolve(
        import.meta.dirname,
        'src/sidebar-preview/pwa-placeholder.ts',
      ),
    },
  },
  publicDir: resolve(import.meta.dirname, 'public'),
  define: {
    __APP_VERSION__: JSON.stringify(
      JSON.parse(
        readFileSync(
          resolve(import.meta.dirname, '../../package.json'),
          'utf8',
        ),
      ).version,
    ),
  },
  server: {
    host: '127.0.0.1',
    port: 7715,
    strictPort: true,
    fs: { allow: [import.meta.dirname] },
  },
  build: { outDir: '../dist-sidebar', emptyOutDir: true },
});
