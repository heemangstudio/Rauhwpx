import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { flushClaudeCredentialMirrors, prepareClaudeHome } from '../agents/claude.mjs';
import { MAX_CREDENTIAL_MIRROR_BYTES } from '../credential-mirror.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-claude-home-seed-'));
  const profile = path.join(root, 'profile');
  mkdirSync(profile, { recursive: true });
  const isolatedHome = path.join(root, 'record', 'home');
  t.after(() => {
    try { flushClaudeCredentialMirrors(isolatedHome); } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { configPath: path.join(profile, '.claude.json'), isolatedHome };
}

test('a ~/.claude.json above the mirror limit does not fail session home preparation', (t) => {
  const { configPath, isolatedHome } = fixture(t);
  // Heavy Claude Code users accumulate per-project history in this file.
  const projects = {};
  const count = Math.ceil((MAX_CREDENTIAL_MIRROR_BYTES * 1.5) / 512);
  for (let index = 0; index < count; index += 1) {
    projects[`C:/Users/사용자/project-${index}`] = { history: 'x'.repeat(512) };
  }
  writeFileSync(configPath, JSON.stringify({ hasCompletedOnboarding: true, projects }));

  const mirrors = prepareClaudeHome(isolatedHome, { configPath });
  assert.deepEqual(mirrors, []);
  assert.equal(existsSync(path.join(isolatedHome, '.claude.json')), false);
  // Re-registration after a login (refreshSessionCredentials) also survives.
  assert.deepEqual(prepareClaudeHome(isolatedHome, { configPath }), []);
});

test('a truncated isolated .claude.json is not copied back over the host config', (t) => {
  const { configPath, isolatedHome } = fixture(t);
  const original = '{"hasCompletedOnboarding":true,"theme":"dark"}';
  writeFileSync(configPath, original);
  const target = path.join(isolatedHome, '.claude.json');

  for (const broken of ['', '{"hasCompletedOnboarding":true,"the']) {
    prepareClaudeHome(isolatedHome, { configPath });
    assert.equal(readFileSync(target, 'utf8'), original);
    writeFileSync(target, broken);
    assert.equal(flushClaudeCredentialMirrors(isolatedHome), true);
    assert.equal(readFileSync(configPath, 'utf8'), original);
  }

  prepareClaudeHome(isolatedHome, { configPath });
  writeFileSync(target, '{"hasCompletedOnboarding":true,"theme":"light"}');
  assert.equal(flushClaudeCredentialMirrors(isolatedHome), true);
  assert.equal(readFileSync(configPath, 'utf8'), '{"hasCompletedOnboarding":true,"theme":"light"}');
});
