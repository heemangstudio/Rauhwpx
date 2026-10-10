import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// Load the native module without constructing an entry or accessing the OS vault.
export function verifyKeyringBinding(agentDir) {
  const agentRequire = createRequire(path.join(agentDir, 'package.json'));
  const binding = agentRequire('@napi-rs/keyring');
  assert.equal(typeof binding.AsyncEntry, 'function', 'The browser OS credential binding must export AsyncEntry');
  const suffix = process.platform === 'win32' ? `${process.arch}-msvc`
    : process.platform === 'linux' ? `${process.arch}-${process.report.getReport().header.glibcVersionRuntime ? 'gnu' : 'musl'}`
      : process.arch;
  const nativePackage = `@napi-rs/keyring-${process.platform}-${suffix}`;
  const manifestPath = agentRequire.resolve(`${nativePackage}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(typeof manifest.main, 'string', `${nativePackage} must declare its native entry`);
  const packageDir = path.dirname(manifestPath);
  const nativeEntry = path.resolve(packageDir, manifest.main);
  const relative = path.relative(packageDir, nativeEntry);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Keyring entry must stay inside its native package');
  assert.ok(nativeEntry.endsWith('.node'), 'Keyring entry must be a native Node binding');
  assert.ok(lstatSync(nativeEntry).isFile(), 'Keyring native entry must be a regular file');
  return { package: nativePackage, version: manifest.version, entry: nativeEntry };
}
