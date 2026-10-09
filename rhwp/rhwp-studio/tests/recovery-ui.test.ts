import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeDraft,
  formatDraftSavedAt,
  formatDraftSize,
} from '../src/recovery/recovery-format.ts';

test('formatDraftSize는 복구 후보 크기를 읽기 좋은 단위로 표시한다', () => {
  assert.equal(formatDraftSize(512), '512 B');
  assert.equal(formatDraftSize(1536), '1.5 KB');
  assert.equal(formatDraftSize(2 * 1024 * 1024), '2.0 MB');
  assert.equal(formatDraftSize(Number.NaN), '크기 알 수 없음');
});

test('describeDraft는 저장 시각, 크기, 출처 포맷을 포함한다', () => {
  const savedAt = new Date('2026-06-21T00:00:00+09:00').getTime();
  const text = describeDraft({
    id: 'd1',
    fileName: '문서.hwp',
    sourceFormat: 'hwp',
    savedAt,
    byteLength: 2048,
  });

  assert.match(text, /HWP/);
  assert.match(text, /2\.0 KB/);
  assert.notEqual(formatDraftSavedAt(savedAt), '저장 시각 알 수 없음');
});

test('예전 HWPX·HML draft 만 HWP 로 열린다고 표시한다', () => {
  for (const sourceFormat of ['hwpx', 'hml']) {
    const legacy = describeDraft({ id: 'old', fileName: `문서.${sourceFormat}`, sourceFormat, savedAt: 1, byteLength: 1024 });
    assert.match(legacy, /→ HWP/);
    const linked = describeDraft({
      id: 'new', fileName: `문서.${sourceFormat}`, sourceFormat, savedAt: 1, byteLength: 1024,
      documentId: 'doc', dataFormat: sourceFormat as 'hwpx' | 'hml',
    });
    assert.doesNotMatch(linked, /→/);
  }
});
