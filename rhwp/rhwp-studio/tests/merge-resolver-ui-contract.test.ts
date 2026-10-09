import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// 남은 소스 가드: 병합 창의 접근성·키보드·버리기 확인 배선. 완료 흐름과 원본 브랜치 보존은
// version-merge-controller.browser.test.ts 와 merge-completion-coordinator.test.ts 가
// 실제 모듈로 검증한다.
const source = await readFile(new URL('../src/merge/merge-resolver-window.ts', import.meta.url), 'utf8');

test('resolver keeps live announcements, tab panels, keyboard undo and an explicit discard confirmation', () => {
  assert.match(source, /aria-live/);
  assert.match(source, /aria-controls/);
  assert.match(source, /configureTabPanel/);
  assert.match(source, /event\.key\.toLowerCase\(\) === 'z'/);
  assert.match(source, /window\.confirm\('이 병합 초안/);
});
