import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Studio 소스를 Node 테스트 프로세스 안에서 그대로 불러온다.
 *
 * Vite 개발 서버의 SSR 로더는 모듈마다 소스맵을 만들고 이어 붙이느라 InputHandler 같은 큰
 * 그래프 하나에 CPU 1초 가까이 쓴다. 여기서는 Vite 가 쓰는 것과 같은 oxc 변환(rolldown)으로
 * 파일 하나씩 바꾸고(parameter property 포함), Vite 가 해 주던 해석만 흉내 낸다:
 * `@/`·`@wasm` 별칭, 확장자 없는 상대 import, CSS 는 빈 모듈, `?url`/`?raw`, 속성 없는 JSON,
 * `import.meta.env`. 한 프로세스 안에서는 모듈 인스턴스를 공유한다.
 */
const studioRoot = fileURLToPath(new URL('../../', import.meta.url));
const srcRoot = join(studioRoot, 'src');
const wasmRoot = process.env.RHWP_WASM_PACKAGE_DIR ?? resolve(studioRoot, '../pkg');
const { transformSync } = createRequire(join(studioRoot, 'package.json'))('rolldown/experimental');

const IMPORT_META_ENV = JSON.stringify({ DEV: true, PROD: false, SSR: true, MODE: 'development', BASE_URL: '/' });
const DEFINE = {
  'import.meta.env': IMPORT_META_ENV,
  'import.meta.env.DEV': 'true',
  'import.meta.env.PROD': 'false',
  'import.meta.env.SSR': 'true',
};

function withTsExtension(base: string): string | null {
  if (existsSync(`${base}.ts`)) return `${base}.ts`;
  if (existsSync(join(base, 'index.ts'))) return join(base, 'index.ts');
  return null;
}

let registered = false;

function registerStudioHooks(): void {
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const [path, query] = specifier.split('?');
      const suffix = query ? `?${query}` : '';
      let file: string | null = null;
      if (path === '@wasm/rhwp.js') file = join(wasmRoot, 'rhwp.js');
      else if (path.startsWith('@wasm/')) file = join(wasmRoot, path.slice('@wasm/'.length));
      else if (path.startsWith('@/')) file = withTsExtension(join(srcRoot, path.slice(2))) ?? join(srcRoot, path.slice(2));
      else if (/^\.{1,2}\//.test(path) && context.parentURL?.startsWith('file:')) {
        const base = join(dirname(fileURLToPath(context.parentURL)), path);
        file = /\.[cm]?[jt]s$|\.css$|\.json$|\.wasm$|\.woff2?$|\.ttf$/.test(path) ? base : withTsExtension(base);
      }
      if (file) return { url: pathToFileURL(file).href + suffix, shortCircuit: true };
      if (query) {
        const resolved = nextResolve(path, context);
        return { ...resolved, url: resolved.url + suffix, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context);
      const [fileUrl, query] = url.split('?');
      const file = fileURLToPath(fileUrl);
      if (query === 'url') {
        return { format: 'module', source: `export default ${JSON.stringify(fileUrl)};`, shortCircuit: true };
      }
      if (query === 'raw') {
        return { format: 'module', source: `export default ${JSON.stringify(readFileSync(file, 'utf8'))};`, shortCircuit: true };
      }
      if (file.endsWith('.css')) return { format: 'module', source: 'export default "";', shortCircuit: true };
      if (file.endsWith('.json') && context.importAttributes?.type !== 'json') {
        return { format: 'module', source: `export default ${readFileSync(file, 'utf8')};`, shortCircuit: true };
      }
      if (file.endsWith('.ts') && !/[\\/]node_modules[\\/]/.test(file)) {
        const { code, errors } = transformSync(file, readFileSync(file, 'utf8'), { sourcemap: false, define: DEFINE });
        if (errors.length > 0) {
          throw new Error(`TS 변환 실패 (${file}):\n${errors.map((e: { message?: string }) => e.message ?? String(e)).join('\n')}`);
        }
        return { format: 'module', source: code, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}

/** `/src/...` 경로나 `@wasm/rhwp.js` 같은 별칭으로 Studio 모듈을 불러온다. */
export async function loadStudioModule<T = any>(path: string): Promise<T> {
  registerStudioHooks();
  const specifier = path.startsWith('/') ? pathToFileURL(join(studioRoot, path)).href : path;
  return import(specifier) as Promise<T>;
}

/** 예전 Vite 기반 도우미와 같은 모양. `root` 는 Studio 루트로 고정이다. */
export async function createTestModuleServer(_root?: string) {
  return {
    ssrLoadModule: <T = any>(path: string) => loadStudioModule<T>(path),
    close: async () => {},
  };
}
