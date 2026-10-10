import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { wasmSourceFingerprint } from './wasm-source-fingerprint.mjs';

test('WASM cache fingerprint follows engine build inputs only', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-wasm-fingerprint-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  const commit = (name, contents) => {
    const file = path.join(repo, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', `Update ${name}`);
    return wasmSourceFingerprint(repo);
  };

  try {
    git('init', '-q');
    git('config', 'user.name', 'Cache test');
    git('config', 'user.email', 'cache-test@example.invalid');
    let previous = commit('rhwp/src/lib.rs', 'pub fn engine() {}');
    for (const [name, changes] of [
      ['rhwp/rhwp-studio/src/main.ts', false],
      ['rhwp/tests/issue_1.rs', false],
      ['rhwp/samples/a.hwp', false],
      ['rhwp/pdf/a.pdf', false],
      ['docs/notes.md', false],
      ['rhwp/src/lib.rs', true],
      ['rhwp/src/parser/new.rs', true],
      ['rhwp/Cargo.lock', true],
      ['rhwp/saved/blank2010.hwp', true],
      ['scripts/build-wasm.mjs', true],
    ]) {
      const next = commit(name, `${name} ${Math.random()}`);
      assert.equal(next !== previous, changes, name);
      previous = next;
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
