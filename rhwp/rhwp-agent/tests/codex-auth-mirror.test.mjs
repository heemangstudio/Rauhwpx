import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { flushCodexCredentialMirror, prepareCodexHome, validateCodexAuth } from '../agents/codex.mjs';

// Windows without symlink privilege (no Developer Mode) falls back to a copy.
const windowsCopyDeps = {
  platform: 'win32',
  symlink() {
    throw Object.assign(new Error('symlinks require elevation'), { code: 'EPERM' });
  },
};

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-codex-auth-mirror-'));
  const sourceHome = path.join(root, 'profile', '.codex');
  mkdirSync(sourceHome, { recursive: true });
  const authPath = path.join(sourceHome, 'auth.json');
  const codexHome = path.join(root, 'record', 'home', '.codex');
  t.after(() => {
    try { flushCodexCredentialMirror(codexHome); } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { authPath, codexHome, mirrorAuth: path.join(codexHome, 'auth.json') };
}

const LOGIN = JSON.stringify({ tokens: { access_token: 'a1', refresh_token: 'r1' } });
const REFRESHED = JSON.stringify({ tokens: { access_token: 'a2', refresh_token: 'r2' } });

test('a turn holding the pre-login auth path keeps the copy registered after login', (t) => {
  const { authPath, codexHome, mirrorAuth } = fixture(t);
  // The chat opened before `codex login`: no source credential yet.
  assert.equal(prepareCodexHome(codexHome, undefined, windowsCopyDeps), null);
  assert.equal(existsSync(mirrorAuth), false);

  // Login lands; the hub re-registers the session's copy mirror.
  writeFileSync(authPath, LOGIN);
  assert.equal(prepareCodexHome(codexHome, authPath, windowsCopyDeps)?.mode, 'copy');
  assert.equal(readFileSync(mirrorAuth, 'utf8'), LOGIN);

  // The next turn still carries the value captured at session start.
  prepareCodexHome(codexHome, undefined, windowsCopyDeps);
  assert.equal(readFileSync(mirrorAuth, 'utf8'), LOGIN);
  assert.equal(readFileSync(authPath, 'utf8'), LOGIN);
});

test('an auth path getter picks up a login between two turns', (t) => {
  const { authPath, codexHome, mirrorAuth } = fixture(t);
  let current;
  const getter = () => current;
  prepareCodexHome(codexHome, getter, windowsCopyDeps);
  assert.equal(existsSync(mirrorAuth), false);

  writeFileSync(authPath, LOGIN);
  current = authPath;
  prepareCodexHome(codexHome, getter, windowsCopyDeps);
  assert.equal(readFileSync(mirrorAuth, 'utf8'), LOGIN);
});

test('logout still removes the copied credential', (t) => {
  const { authPath, codexHome, mirrorAuth } = fixture(t);
  writeFileSync(authPath, LOGIN);
  prepareCodexHome(codexHome, authPath, windowsCopyDeps);
  assert.equal(existsSync(mirrorAuth), true);
  rmSync(authPath);
  prepareCodexHome(codexHome, undefined, windowsCopyDeps);
  assert.equal(existsSync(mirrorAuth), false);
});

test('copyback never installs an empty or truncated auth.json over the real login', (t) => {
  const { authPath, codexHome, mirrorAuth } = fixture(t);
  writeFileSync(authPath, LOGIN);

  // Session close after the child was hard-killed mid refresh.
  for (const broken of ['', '{"tokens":{"access_token":"a2","refresh_tok']) {
    prepareCodexHome(codexHome, authPath, windowsCopyDeps);
    writeFileSync(mirrorAuth, broken);
    assert.equal(flushCodexCredentialMirror(codexHome), true);
    assert.equal(readFileSync(authPath, 'utf8'), LOGIN);
  }

  // The next turn re-prepares the home over a broken copy.
  prepareCodexHome(codexHome, authPath, windowsCopyDeps);
  writeFileSync(mirrorAuth, '');
  prepareCodexHome(codexHome, authPath, windowsCopyDeps);
  assert.equal(readFileSync(authPath, 'utf8'), LOGIN);
  assert.equal(readFileSync(mirrorAuth, 'utf8'), LOGIN);

  // A complete refresh is still copied back.
  writeFileSync(mirrorAuth, REFRESHED);
  assert.equal(flushCodexCredentialMirror(codexHome), true);
  assert.equal(readFileSync(authPath, 'utf8'), REFRESHED);
});

test('Codex auth validation accepts whole JSON objects only', () => {
  assert.equal(validateCodexAuth(Buffer.from(LOGIN)), true);
  assert.equal(validateCodexAuth(Buffer.from(`${String.fromCharCode(0xfeff)}${LOGIN}`)), true);
  assert.equal(validateCodexAuth(Buffer.from(JSON.stringify({ OPENAI_API_KEY: 'sk-x' }))), true);
  for (const bad of ['', '   ', '{}', '[]', 'null', '{"tokens":']) {
    assert.equal(validateCodexAuth(Buffer.from(bad)), false, bad);
  }
});
