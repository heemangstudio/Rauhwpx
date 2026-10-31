import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findSecrets } from './check-secrets.mjs';

const SCRIPT = fileURLToPath(new URL('./check-secrets.mjs', import.meta.url));
const alnum = (n) => randomBytes(n).toString('base64').replace(/[^A-Za-z0-9]/g, 'x').slice(0, n);

// Real-shaped keys, built here so none is ever a literal in the repository.
const REAL = {
  'OpenRouter key': `sk-or-v1-${randomBytes(32).toString('hex')}`,
  'Anthropic key': [`sk-ant-api03-${alnum(93)}AA`, `sk-ant-oat01-${alnum(95)}`, `sk-ant-admin01-${alnum(80)}`],
  'OpenAI-style key': [`sk-proj-${alnum(48)}_${alnum(40)}`, `sk-${alnum(48)}`],
  'WorkOS key': [`sk_${alnum(75)}`, `sk_test_${alnum(48)}`, `sk_live_${alnum(48)}`],
};

test('real-shaped keys are caught; short fake tokens and ordinary words are not', () => {
  for (const [name, values] of Object.entries(REAL)) {
    for (const value of [values].flat()) {
      assert.deepEqual(findSecrets(`const key = '${value}';`).map((f) => f.name), [name], value.slice(0, 16));
      assert.deepEqual(findSecrets(`Authorization: Bearer ${value}`).map((f) => f.match), [value]);
    }
  }
  for (const text of ['sk-ant-oat01-token', 'sk-or-v1-leak', 'sk-or-v1-REPLAYSECRET0123456789abcdef',
    'sk-ant-api03-STRADDLEKEY0123456789abcdef', `task-${alnum(40)}`, `desk-${alnum(40)}`, "'task-progress'",
    'sk_test_fake', 'sk_live_short123', `disk_${alnum(48)}`, `risk_test_${alnum(48)}`]) {
    assert.deepEqual(findSecrets(text), [], text);
  }
});

test('the scanner fails on a tracked key-shaped literal without printing it, and passes a clean repository', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'check-secrets-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    writeFileSync(path.join(dir, 'clean.mjs'), "const fake = 'sk-or-v1-leak';\n");
    git('add', '.');
    const clean = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stderr);

    const key = REAL['OpenRouter key'];
    writeFileSync(path.join(dir, 'leak.mjs'), `export const KEY = '${key}';\n`);
    writeFileSync(path.join(dir, 'workos.env'), `WORKOS_API_KEY=${REAL['WorkOS key'][0]}\n`);
    writeFileSync(path.join(dir, 'untracked.mjs'), `export const KEY = '${REAL['OpenAI-style key'][0]}';\n`);
    git('add', 'leak.mjs', 'workos.env');
    const leaked = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
    assert.equal(leaked.status, 1);
    assert.match(leaked.stderr, /^leak\.mjs:1: OpenRouter key$/m);
    assert.match(leaked.stderr, /^workos\.env:1: WorkOS key$/m);
    assert.doesNotMatch(leaked.stderr, /untracked/, 'only tracked files are scanned');
    assert.ok(!leaked.stderr.includes(key) && !leaked.stdout.includes(key), 'the literal is never printed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('this repository has no key-shaped literals', () => {
  const run = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});
