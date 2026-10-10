import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// 남은 소스 가드: 아래 호출부는 페이지 렌더러와 DOM 대화상자 안에 있어 Node 에서 실행할
// seam 이 없다. 같은 한도를 쓰는 다른 경로는 untrusted-input-limits.test.ts 가 실제 모듈로,
// main.ts 의 호출부는 main-entry-guards.test.ts 가 지킨다.

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function between(contents: string, start: string, end: string): string {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return contents.slice(startIndex, endIndex);
}

function assertBefore(contents: string, first: string, second: string): void {
  const firstIndex = contents.indexOf(first);
  const secondIndex = contents.indexOf(second);
  assert.notEqual(firstIndex, -1, `missing guard: ${first}`);
  assert.notEqual(secondIndex, -1, `missing decode path: ${second}`);
  assert.ok(firstIndex < secondIndex, `${first} must run before ${second}`);
}

test('page renderer decodes DOM flow images only after every image passes the size check', () => {
  const flowImages = between(
    source('../src/view/page-renderer.ts'),
    '  private createOrReuseFlowImageLayer',
    '  private createOrReuseFilteredCanvasLayer',
  );
  assertBefore(flowImages, 'images.every(isDomDisplayableFlowImage)', 'new Image()');
});

test('dialog uploads read through their size limit', () => {
  for (const [relativePath, call] of [
    ['../src/versioning/controller.ts', 'readBlobBytesWithLimit(file, INSERTED_IMAGE_MAX_BYTES'],
    ['../src/merge/manual-conflict-editor.ts', 'readBlobBytesWithLimit(file, MAX_IMAGE_UPLOAD_BYTES'],
    ['../src/ui/agent-sidebar/writing-style-calibration.ts', 'readBlobBytesWithLimit(file, MAX_FILE_BYTES'],
    ['../src/ui/compare-dialog.ts', 'readBlobBytesWithLimit(selected, UNTRUSTED_DOCUMENT_MAX_BYTES'],
  ]) {
    const code = source(relativePath);
    assert.ok(code.includes(call), `${relativePath}: ${call}`);
    assert.doesNotMatch(code, /(file|selected)\.arrayBuffer\(\)/, relativePath);
  }
});
