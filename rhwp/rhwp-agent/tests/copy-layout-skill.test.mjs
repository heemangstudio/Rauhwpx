import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { projectSkillMarkdown } from '../skills.mjs';

const markdownUrl = new URL('../skills/copy-layout/SKILL.md', import.meta.url);
const helperTestUrl = new URL('./copy-layout-helper.test.py', import.meta.url);

test('bundled copy-layout skill is a valid explicit slash-command skill', () => {
  const parsed = projectSkillMarkdown(readFileSync(markdownUrl, 'utf8'), 'copy-layout');
  assert.equal(parsed.name, 'copy-layout');
});

test('copy-layout helper runs without site packages and defers only an intermediate page-count mismatch', (t) => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const availability = spawnSync(python, ['-S', '-c', 'import sys'], { encoding: 'utf8' });
  if (availability.error?.code === 'ENOENT') {
    t.skip('Python is unavailable');
    return;
  }
  assert.equal(availability.status, 0, availability.stderr || availability.stdout);
  const result = spawnSync(python, ['-S', fileURLToPath(helperTestUrl)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const count = /Ran (\d+) tests/.exec(result.stderr);
  assert.ok(count, result.stderr);
  assert.ok(Number(count[1]) >= 31, `expected at least 31 helper tests, got ${count[1]}`);
  assert.match(result.stderr, /OK/);
});
