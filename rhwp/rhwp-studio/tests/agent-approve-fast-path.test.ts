/**
 * 에이전트 change set 승인 — 첫 변이 직전 스냅샷을 undo 기준으로 그대로 쓰는 경로.
 *
 * 승인은 미리보기를 채택하므로, 사용자 편집·다른 set 의 확정·뒤에 남은 다른 set 의 op 이
 * 없으면 op 을 하나씩 되돌리고(문서 전체 복원) 미리보기를 다시 복원하거나 다시 조판할 필요가
 * 없다. 실제 WASM 으로 그 경로의 엔진 호출이 없고 undo/redo 결과가 기존 경로와 같은지,
 * 조건이 깨지면 기존 경로로 돌아가 사용자 글자·다른 set 의 미리보기를 지키는지 본다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireWasmPackage } from './browser-support.ts';

const here = dirname(fileURLToPath(import.meta.url));

test('실제 WASM: 승인은 되돌림·재조판 없이 첫 변이 직전 문서를 undo 기준으로 쓰고, 조건이 깨지면 기존 경로로 간다', () => {
  requireWasmPackage(join(here, '..', '..', 'pkg'));
  const result = spawnSync(process.execPath, [
    '--no-warnings',
    '--import', pathToFileURL(join(here, 'support', 'ts-transform-hooks.mjs')).href,
    join(here, 'support', 'pending-approve-fast-path.runner.mjs'),
  ], { encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PENDING_APPROVE_FAST_PATH_OK/);
});
