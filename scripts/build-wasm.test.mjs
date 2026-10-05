import assert from 'node:assert/strict';
import test from 'node:test';

import { binaryenAssetFor, parseWasmOptVersion, prepareWasmOptPath } from './build-wasm.mjs';

test('wasm-opt --version output parses to a numeric version', () => {
  assert.equal(parseWasmOptVersion('wasm-opt version 125 (version_125)\n'), 125);
  assert.equal(parseWasmOptVersion('wasm-opt version 117 (version_117)\n'), 117);
  assert.equal(parseWasmOptVersion(''), null);
  assert.equal(parseWasmOptVersion('not a wasm-opt'), null);
});

test('binaryen asset matrix covers the desktop platforms the app ships on', () => {
  for (const key of ['win32:x64', 'linux:x64', 'linux:arm64', 'darwin:x64', 'darwin:arm64']) {
    const [platform, arch] = key.split(':');
    const asset = binaryenAssetFor(platform, arch);
    assert.ok(asset, key);
    assert.match(asset.archive, /^binaryen-version_125-.+\.tar\.gz$/);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(binaryenAssetFor('win32', 'arm64'), null);
});

test('PATH stays unchanged when a usable wasm-opt is already installed', async () => {
  const path = await prepareWasmOptPath({
    platform: 'win32',
    arch: 'x64',
    env: { PATH: 'sentinel' },
    log: () => {},
    probe: () => 125,
  });
  assert.equal(path, 'sentinel');
});

test('unsupported platforms fall back to wasm-pack managed wasm-opt', async () => {
  const path = await prepareWasmOptPath({
    platform: 'win32',
    arch: 'arm64',
    env: { PATH: 'sentinel' },
    log: () => {},
    probe: () => null,
  });
  assert.equal(path, 'sentinel');
});
