import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// 남은 소스 가드: 아래 호출부는 DOM 대화상자 안에 있어 Node 에서 실행할
// seam 이 없다. 같은 한도를 쓰는 다른 경로는 untrusted-input-limits.test.ts 가 실제 모듈로,
// main.ts 의 호출부는 main-entry-guards.test.ts 가 지킨다.

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

test('dialog uploads read through their size limit', () => {
  for (const [relativePath, call] of [
    ['../src/versioning/controller.ts', 'readBlobBytesWithLimit(file, INSERTED_IMAGE_MAX_BYTES'],
    ['../src/merge/manual-conflict-editor.ts', 'readBlobBytesWithLimit(file, MAX_IMAGE_UPLOAD_BYTES'],
    ['../src/ui/agent-sidebar/settings-rau.ts', 'readBlobBytesWithLimit(file, STYLE_LEARN_MAX_FILE_BYTES'],
    ['../src/ui/compare-dialog.ts', 'readBlobBytesWithLimit(selected, UNTRUSTED_DOCUMENT_MAX_BYTES'],
  ]) {
    const code = source(relativePath);
    assert.ok(code.includes(call), `${relativePath}: ${call}`);
    assert.doesNotMatch(code, /(file|selected)\.arrayBuffer\(\)/, relativePath);
  }
});
