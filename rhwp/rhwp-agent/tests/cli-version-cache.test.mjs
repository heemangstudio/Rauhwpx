import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCliVersionCache } from '../cli-version-cache.mjs';

test('a CLI version is read once per binary, failures are retried, and an updated binary is read again', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-cli-version-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'claude');
  await fs.writeFile(bin, '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });
  const cache = createCliVersionCache();
  let runs = 0;
  let output = { ok: false, stdout: '' };
  const run = async () => { runs += 1; return output; };

  assert.equal((await cache.probe(bin, run)).ok, false);
  output = { ok: true, stdout: '1.0.0\n' };
  const [first, second] = await Promise.all([cache.probe(bin, run), cache.probe(bin, run)]);
  assert.equal(first.stdout, '1.0.0\n');
  assert.equal(second.stdout, '1.0.0\n');
  assert.equal(runs, 2, 'the failure is not remembered and concurrent probes share one run');

  await fs.writeFile(bin, '#!/bin/sh\necho 1.1.0 # updated\n', { mode: 0o755 });
  output = { ok: true, stdout: '1.1.0\n' };
  assert.equal((await cache.probe(bin, run)).stdout, '1.1.0\n');
  assert.equal(runs, 3);
});
