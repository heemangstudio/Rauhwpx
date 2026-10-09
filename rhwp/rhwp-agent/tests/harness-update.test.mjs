import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fetchLatestPackage, updatePrefixAtomically } from '../harness-update.mjs';

test('registry HTTP failures cancel their unread response bodies', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { status: 503 });

  await assert.rejects(
    fetchLatestPackage(async () => response, '@scope/package'),
    /registry HTTP 503/,
  );
  assert.equal(cancelled, true);
});

test('registry metadata is consumed through a 64 KiB response bound', async () => {
  await assert.rejects(
    fetchLatestPackage(
      async () => new Response(Buffer.alloc(64 * 1024 + 1), { status: 200 }),
      '@scope/package',
    ),
    (error) => error.code === 'RESPONSE_BODY_TOO_LARGE',
  );
});

test('bounded registry metadata still validates and normalizes semver', async () => {
  const result = await fetchLatestPackage(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      version: 'v1.2.3',
      dist: { tarball: 'https://registry.test/package.tgz', integrity: 'sha512-example' },
    }),
  }), 'package');
  assert.deepEqual(result, {
    version: '1.2.3',
    tarball: 'https://registry.test/package.tgz',
    integrity: 'sha512-example',
  });
});

test('a pinned version is fetched by exact version and must come back as that version', async () => {
  const urls = [];
  const registry = (version) => async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ version, dist: { tarball: 'https://registry.test/p.tgz' } }) };
  };
  assert.equal((await fetchLatestPackage(registry('1.1.0'), '@scope/package', 1_000, '1.1.0')).version, '1.1.0');
  assert.equal(urls[0], 'https://registry.npmjs.org/@scope%2Fpackage/1.1.0');
  await assert.rejects(fetchLatestPackage(registry('2.0.0'), '@scope/package', 1_000, '1.1.0'), /returned 2\.0\.0/);
  await fetchLatestPackage(registry('2.0.0'), '@scope/package');
  assert.equal(urls.at(-1), 'https://registry.npmjs.org/@scope%2Fpackage/latest');
});

test('an uncertain installer keeps its staging prefix for the live process', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-update-cleanup-'));
  const prefixDir = path.join(root, 'prefix');
  await fs.mkdir(prefixDir);
  const error = new Error('installer tree survived');
  error.processCleanupUncertain = true;

  await assert.rejects(updatePrefixAtomically({
    prefixDir,
    label: 'test',
    async install(stagingDir) {
      await fs.writeFile(path.join(stagingDir, 'still-in-use'), 'x');
      throw error;
    },
    async verify() {},
  }), /installer tree survived/);

  const retained = (await fs.readdir(root)).find((entry) => entry.startsWith('prefix.update-test-'));
  assert.ok(retained);
  assert.equal(await fs.readFile(path.join(root, retained, 'still-in-use'), 'utf8'), 'x');
  await fs.rm(root, { recursive: true, force: true });
});
