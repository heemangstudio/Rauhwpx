import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { getMainFileMatchers } from 'app-builder-lib/out/fileMatcher.js';

import { normalizeArchivePath } from './desktop-package-paths.mjs';
import { verifyKeyringBinding } from './verify-keyring-binding.mjs';

test('ASAR listings use one archive namespace on Windows and POSIX', () => {
  assert.equal(normalizeArchivePath('\\desktop\\main.mjs'), '/desktop/main.mjs');
  assert.equal(
    normalizeArchivePath('\\rhwp\\rhwp-studio\\dist\\assets\\rhwp_bg-test.wasm'),
    '/rhwp/rhwp-studio/dist/assets/rhwp_bg-test.wasm',
  );
  assert.equal(normalizeArchivePath('/desktop/main.mjs'), '/desktop/main.mjs');
});

test('packaging an installed development checkout excludes the agent compiler and keeps runtime dependencies', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const root = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '');
  const packager = { info: {
    projectDir: root,
    buildResourcesDir: 'build',
    config: manifest.build,
    isPrepackedAppAsar: false,
    debugLogger: { isEnabled: false },
  } };
  const [matcher] = getMainFileMatchers(root, path.join(root, 'release', 'staged'), (value) => value, {}, packager, path.join(root, 'release'), false);
  const filter = matcher.createFilter();
  for (const name of ['typescript', '@typescript/typescript-darwin-arm64', '@typescript/typescript-win32-x64']) {
    assert.equal(filter(path.join(root, 'rhwp/rhwp-agent/node_modules', name, 'package.json'), { isDirectory: () => false }), false, name);
  }
  for (const name of ['tsc', 'tsc.cmd', 'tsc.ps1']) {
    assert.equal(filter(path.join(root, 'rhwp/rhwp-agent/node_modules/.bin', name), { isDirectory: () => false }), false, name);
  }
  for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64-msvc', 'win32-arm64-msvc', 'linux-x64-gnu', 'linux-arm64-gnu', 'linux-x64-musl', 'linux-arm64-musl']) {
    for (const filename of ['package.json', `keyring.${target}.node`]) {
      const relative = `rhwp/rhwp-agent/node_modules/@napi-rs/keyring-${target}/${filename}`;
      assert.equal(filter(path.join(root, relative), { isDirectory: () => false }), true, relative);
    }
  }
  for (const name of ['ws', 'cross-spawn', '@agentclientprotocol/sdk', 'playwright', 'playwright-core', '@napi-rs/keyring', '@types/node']) {
    assert.equal(filter(path.join(root, 'rhwp/rhwp-agent/node_modules', name, 'package.json'), { isDirectory: () => false }), true, name);
  }
});

test('the installed browser keyring native entry loads without vault access', () => {
  const agentDir = fileURLToPath(new URL('../rhwp/rhwp-agent/', import.meta.url));
  const result = verifyKeyringBinding(agentDir);
  assert.ok(result.package.startsWith(`@napi-rs/keyring-${process.platform}-`));
  assert.ok(result.entry.endsWith('.node'));
});
