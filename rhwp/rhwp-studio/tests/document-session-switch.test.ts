/**
 * 문서 세션 전환 — 실제 WASM 두 문서 사이를 페이지 퍼사드가 옮겨 다니는 동안 세션별 히스토리가
 * 자기 문서에만 실행되는지 본다. 엔진 클래스(TS 파라미터 프로퍼티)를 읽으려면 변환 훅이 필요해
 * 러너를 자식 프로세스로 돌린다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgWasm = join(here, '..', '..', 'pkg', 'rhwp_bg.wasm');

test('실제 WASM: 백그라운드 에이전트 편집과 사용자 편집이 각 문서의 히스토리로 undo 된다', (t) => {
  if (!existsSync(pkgWasm)) {
    t.skip('rhwp/pkg 의 WASM 빌드가 필요하다 (wasm-pack build --target web)');
    return;
  }
  const result = spawnSync(process.execPath, [
    '--no-warnings',
    '--import', pathToFileURL(join(here, 'support', 'ts-transform-hooks.mjs')).href,
    join(here, 'support', 'document-session-switch.runner.mjs'),
  ], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /DOCUMENT_SESSION_SWITCH_OK/);
});
