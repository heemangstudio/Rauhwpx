import test from 'node:test';
import assert from 'node:assert/strict';
import { requireWasmPackage } from './browser-support.ts';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as nodeModule from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const runner = join(here, 'support', 'mixed-char-format.runner.mjs');
const transformHooks = pathToFileURL(join(here, 'support', 'ts-transform-hooks.mjs')).href;

function registerHooksSupported(): boolean {
  return typeof (nodeModule as { registerHooks?: unknown }).registerHooks === 'function';
}

test('#6788 실제 WASM + Studio 혼합 모양 적용/Undo/Redo', (t) => {
  requireWasmPackage(fileURLToPath(new URL('../../pkg/', import.meta.url)));
  if (!registerHooksSupported()) {
    t.skip('현재 Node 가 module.registerHooks 미지원 — 행위 테스트 skip');
    return;
  }
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', '--import', transformHooks, runner],
    { encoding: 'utf8' },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
  assert.match(result.stdout, /MIXED_CHAR_FORMAT_OK/);
});
