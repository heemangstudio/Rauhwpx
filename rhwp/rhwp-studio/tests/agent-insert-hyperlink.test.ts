/**
 * insert_hyperlink 와 insert_image caption — 실제 WASM 으로 스테이징·거절·승인·저장 왕복을 본다 (support/insert-hyperlink.runner.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireWasmPackage } from './browser-support.ts';

const here = dirname(fileURLToPath(import.meta.url));

test('실제 WASM: 인용 링크·출처 각주와 캡션 단 근거 그림이 한 변경씩 들어가고 거절·undo·HWP/HWPX 왕복이 맞다', () => {
  requireWasmPackage(join(here, '..', '..', 'pkg'));
  const result = spawnSync(process.execPath, [
    '--no-warnings',
    '--import', pathToFileURL(join(here, 'support', 'ts-transform-hooks.mjs')).href,
    join(here, 'support', 'insert-hyperlink.runner.mjs'),
  ], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /INSERT_HYPERLINK_OK/);
});
