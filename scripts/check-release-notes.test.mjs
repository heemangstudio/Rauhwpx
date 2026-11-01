import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MIN_RELEASE_NOTES, releaseNotesProblem } from './check-release-notes.mjs';

const SCRIPT = fileURLToPath(new URL('./check-release-notes.mjs', import.meta.url));

test('a release needs at least one non-empty note for its version', () => {
  assert.equal(MIN_RELEASE_NOTES, 1);
  assert.equal(releaseNotesProblem('3.1.0', { '3.1.0': { added: ['a'] } }), null);
  assert.equal(releaseNotesProblem('3.1.0', { '3.1.0': { fixed: ['a'] } }), null);
  assert.match(releaseNotesProblem('3.1.0', { '3.1.0': { added: [], fixed: [] } }), /0 entries; at least 1/);
  assert.match(releaseNotesProblem('3.1.0', { '3.1.0': { added: ['a'], fixed: ['  '] } }), /1 empty entry/);
  assert.match(releaseNotesProblem('3.1.0', { '3.0.9': { added: ['a'] } }), /No release notes for 3\.1\.0/);
  assert.match(releaseNotesProblem('3.1.0', { '3.1.0': ['a'] }), /No release notes for 3\.1\.0/);
});

test('the release check reads the studio notes and fails a version without them', () => {
  const missing = spawnSync(process.execPath, [SCRIPT, '0.0.0-missing'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No release notes for 0\.0\.0-missing/);
  const present = spawnSync(process.execPath, [SCRIPT, '3.0.10'], { encoding: 'utf8' });
  assert.equal(present.status, 0, present.stderr);
});
