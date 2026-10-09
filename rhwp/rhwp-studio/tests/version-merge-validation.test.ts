import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

import { mergeResourceDependencyErrors } from '../src/versioning/merge-validation.ts';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

test('merge resource validation rejects every unloaded external image dependency', () => {
  assert.deepEqual(mergeResourceDependencyErrors([
    { basename: 'present.png', loaded: true },
    { basename: 'missing-a.png', loaded: false },
    { originalPath: '/missing/b.jpg', loaded: false },
    { binDataId: 17, loaded: false },
  ]), [
    'Missing referenced image resource: missing-a.png',
    'Missing referenced image resource: /missing/b.jpg',
    'Missing referenced image resource: BinData 17',
  ]);
});

test('merge resource validation accepts embedded or successfully loaded dependencies', () => {
  assert.deepEqual(mergeResourceDependencyErrors([
    { basename: 'embedded.png', loaded: true },
    { key: 'resolved:4', loaded: true },
  ]), []);
});

test('external image dependency reports distinguish valid emptiness from unavailable data', async () => {
  const vite = await createServer({
    root: rootDir,
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    resolve: {
      alias: {
        '@wasm/rhwp.js': resolve(rootDir, '../pkg/rhwp.js'),
        '@wasm': resolve(rootDir, '../pkg'),
        '@': resolve(rootDir, 'src'),
      },
    },
    server: { middlewareMode: true, hmr: false },
  });
  try {
    const { WasmBridge } = await vite.ssrLoadModule('/src/core/wasm-bridge.ts');
    const references = (doc: unknown) => {
      const bridge = Object.create(WasmBridge.prototype);
      bridge.doc = doc;
      return () => bridge.getExternalImageReferences();
    };
    const reporting = (raw: unknown) => references({ getExternalImageReferences: () => raw });

    // 정보를 얻지 못한 경우는 "의존성 없음"으로 바꾸지 않고 실패로 알린다.
    assert.throws(references({}), /사용할 수 없습니다/);
    assert.throws(reporting(5), /형식이 올바르지 않습니다/);
    assert.throws(reporting('not json'), /읽지 못했습니다/);
    assert.throws(reporting('{}'), /형식이 올바르지 않습니다/);
    assert.deepEqual(reporting('[]')(), []);
    assert.deepEqual(
      reporting(JSON.stringify([{ basename: 'a.png', loaded: false }, null, { basename: 'b.png' }]))(),
      [{ basename: 'a.png', loaded: false }],
    );
  } finally {
    await vite.close();
  }
});
