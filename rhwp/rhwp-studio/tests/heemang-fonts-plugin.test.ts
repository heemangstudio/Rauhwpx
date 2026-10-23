import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { heemangFontsPlugin } from '../vite-plugin-heemang-fonts.mjs';

test('font manifest exposes size and families while opaque URLs serve only allowed files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heemang-fonts-'));
  const previous = process.env.RHWP_HEEMANG_FONT_ASSETS;
  try {
    const font = fileURLToPath(new URL('../../../tests/fixtures/fonts/NotoSansKRWebFixture.ttf', import.meta.url));
    const table = join(dir, 'FontMap.dat');
    writeFileSync(table, new Uint8Array([1, 2, 3]));
    const manifest = join(dir, 'manifest.json');
    writeFileSync(manifest, JSON.stringify([font, table]));
    process.env.RHWP_HEEMANG_FONT_ASSETS = manifest;
    const plugin = heemangFontsPlugin(fileURLToPath(new URL('../', import.meta.url)));
    let middleware;
    plugin.configureServer({ middlewares: { use(prefix, handler) {
      assert.equal(prefix, '/__heemang-fonts');
      middleware = handler;
    } } });
    function request(url: string, method = 'GET') {
      const response = {
        statusCode: 200, body: undefined as string | Buffer | undefined,
        headers: new Map<string, string>(),
        setHeader(name: string, value: string) { this.headers.set(name, value); },
        end(body?: string | Buffer) { this.body = body; },
      };
      middleware({ url, method }, response);
      return response;
    }
    const response = request('/manifest.json');
    const assets = JSON.parse(response.body as string);
    assert.deepEqual(assets[0], { name: 'FontMap.dat', url: '/__heemang-fonts/0', size: 3, families: [] });
    assert.equal(assets[1].size, statSync(font).size);
    assert.ok(assets[1].families.some((name: string) => name.includes('Noto Sans KR')));
    assert.deepEqual(request('/1').body, readFileSync(font));
    assert.deepEqual(request('/0').body, Buffer.from([1, 2, 3]));
    for (const path of ['/2', '/../FontMap.dat', '/%2e%2e/FontMap.dat', '/1/extra', '/1?path=other']) {
      assert.equal(request(path).statusCode, 404, path);
    }
    assert.equal(request('/1', 'POST').statusCode, 405);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  } finally {
    if (previous === undefined) delete process.env.RHWP_HEEMANG_FONT_ASSETS;
    else process.env.RHWP_HEEMANG_FONT_ASSETS = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
