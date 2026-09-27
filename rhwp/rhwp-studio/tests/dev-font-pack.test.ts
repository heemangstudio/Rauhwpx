import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { rhwpDevFontPackPlugin } from '../vite-plugin-dev-font-pack.mjs';

test('dev font pack serves only configured content through immutable opaque URLs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rhwp-dev-font-pack-'));
  const font = join(dir, 'sample.ttf');
  const manifestPath = join(dir, 'fonts.json');
  writeFileSync(font, 'configured font bytes');
  writeFileSync(manifestPath, JSON.stringify([font]));
  const previous = process.env.RHWP_DEV_FONT_PACK;
  process.env.RHWP_DEV_FONT_PACK = manifestPath;
  let route = '';
  let handler: (req: any, res: any) => void = () => {};
  const plugin = rhwpDevFontPackPlugin() as {
    config: () => { define: Record<string, string> };
    configureServer: (server: { middlewares: { use: (prefix: string, handle: typeof handler) => void } }) => void;
  };
  plugin.configureServer({ middlewares: { use(prefix, handle) { route = prefix; handler = handle; } } });
  const server = createServer((req, res) => {
    if (!req.url?.startsWith(route)) { res.writeHead(404).end(); return; }
    req.url = req.url.slice(route.length) || '/';
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  const base = `http://127.0.0.1:${address.port}${route}`;
  try {
    assert.equal(plugin.config().define['import.meta.env.VITE_RHWP_DEV_FONT_PACK'], '"1"');
    const manifest = await (await fetch(`${base}/manifest.json`)).json();
    assert.equal(manifest.fonts.length, 1);
    assert.equal(manifest.fonts[0].name, 'sample.ttf');
    assert.equal(JSON.stringify(manifest).includes(dir), false);
    const file = await fetch(`http://127.0.0.1:${address.port}${manifest.fonts[0].url}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.equal(await file.text(), 'configured font bytes');
    assert.equal((await fetch(`${base}/file/1/${manifest.fonts[0].url.split('/').at(-1)}`)).status, 404);
    assert.equal((await fetch(`${base}/file/%252e%252e/manifest.json`)).status, 404);
  } finally {
    server.close();
    await once(server, 'close');
    if (previous === undefined) delete process.env.RHWP_DEV_FONT_PACK;
    else process.env.RHWP_DEV_FONT_PACK = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
