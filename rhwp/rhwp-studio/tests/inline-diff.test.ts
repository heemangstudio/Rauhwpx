import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedTextRanges } from '../src/ui/agent-sidebar/inline-diff.ts';
import type { DiffItem } from '../src/compare/types.ts';

function textItem(severity: DiffItem['severity'], leftPreview: string, rightPreview: string): DiffItem {
  return { id: 'item', kind: 'text', severity, path: { section: 0, paragraph: 3 }, title: '', leftPreview, rightPreview };
}

const slice = (text: string, ranges: { start: number; end: number }[] | null) =>
  ranges?.map(({ start, end }) => text.slice(start, end));

test('a modified paragraph jumps to each changed word, not to the paragraph start', () => {
  const after = '오늘 회의는 오후 세 시에 본관에서 열립니다.';
  const ranges = changedTextRanges(textItem('modified', '오늘 회의는 오전 열 시에 별관에서 열립니다.', after));
  assert.deepEqual(slice(after, ranges), ['오후 세', '본관에서']);
});

test('a deletion jumps to where the removed text was', () => {
  const ranges = changedTextRanges(textItem('modified', '첫째 둘째 셋째', '첫째 셋째'));
  assert.deepEqual(ranges, [{ start: 3, end: 3 }]);
});

test('an added paragraph covers the whole paragraph and removed or non-text items have no range', () => {
  assert.deepEqual(changedTextRanges(textItem('added', '', '새 문단')), [{ start: 0, end: 4 }]);
  assert.equal(changedTextRanges(textItem('removed', '지운 문단', '')), null);
  assert.equal(changedTextRanges({ ...textItem('modified', 'a', 'b'), kind: 'table' }), null);
});
