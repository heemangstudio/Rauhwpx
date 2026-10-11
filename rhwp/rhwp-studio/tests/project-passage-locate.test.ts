import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { joinPdfTextItems } from '../../rhwp-agent/reference-extractor.mjs';
import {
  buildPageText,
  locateInText,
  locatePassage,
  type ItemRange,
  type PageItem,
  type PdfTextItem,
} from '../src/ui/agent-sidebar/project/passage-locate.ts';

/** 허브 collectPdfPages + chunkReferenceText 와 같은 쪽 문자열. */
function hubPageText(items: readonly PageItem[]): string {
  const objects = items.map((item) => (typeof item === 'string' ? { str: item } : item));
  return joinPdfTextItems(objects).normalize('NFKC').trim();
}

/** 허브처럼 조각 위치를 잰다. */
function hubChunk(items: readonly PageItem[], phrase: string) {
  const text = hubPageText(items);
  const start = text.indexOf(phrase);
  assert.ok(start >= 0, `phrase not in page: ${phrase}`);
  return { start, end: start + phrase.length, text: phrase };
}

/** 범위가 가리키는 원문 글자를 이어 붙인다. */
function covered(items: readonly PageItem[], ranges: ItemRange[]): string {
  return ranges.map((range) => {
    const item = items[range.item]!;
    return (typeof item === 'string' ? item : item.str).slice(range.start, range.end);
  }).join('|');
}

interface JoinCase {
  name: string;
  expected: string;
  items: PdfTextItem[];
}

const JOIN_CASES = (JSON.parse(readFileSync(
  new URL('../../rhwp-agent/tests/fixtures/pdf-join-cases.json', import.meta.url),
  'utf8',
)) as { cases: JoinCase[] }).cases;

test('page text joins items exactly like the hub for every shared case', () => {
  for (const { name, items, expected } of JOIN_CASES) {
    const page = buildPageText(items);
    assert.equal(page.text, expected, name);
    assert.equal(page.item.length, page.text.length, name);
    // 잇는 구분자만 item 이 없고, 나머지 글자는 모두 원문 item 을 가리킨다.
    for (let i = 0; i < page.text.length; i += 1) {
      if (page.item[i]! < 0) assert.match(page.text[i]!, /\s/u, name);
      else assert.ok(page.to[i]! > page.from[i]!, name);
    }
  }
});

test('a chunk from the Chrome-printed Korean page highlights whole words across glyph items', () => {
  const items = JOIN_CASES.find((entry) => entry.name.startsWith('Chrome'))!.items;
  const chunk = hubChunk(items, '연구개발 지원사업');
  const match = locatePassage(items, { chunk });
  assert.ok(match);
  assert.equal(match.exact, true);
  assert.equal(covered(items, match.ranges), '연|구개|발|지원|사|업');
});

test('page text matches the hub, including empty items and edge whitespace', () => {
  const items = ['  제1조 목적', '', ' ', '이 규정은', 'ﬁle 처리를 정한다.  '];
  const page = buildPageText(items);
  assert.equal(page.text, hubPageText(items));
  assert.equal(page.item.length, page.text.length);
});

test('exact hub offsets map back to the spans that hold the chunk', () => {
  const items = ['연구 계획서', '', '예산은 총 3억 원이며', '2027년까지 집행한다.', '부록'];
  const chunk = hubChunk(items, '예산은 총 3억 원이며 2027년까지 집행한다.');
  const match = locatePassage(items, { chunk });
  assert.ok(match);
  assert.equal(match.exact, true);
  assert.equal(match.matched, 'chunk');
  assert.deepEqual(match.ranges, [
    { item: 2, start: 0, end: items[2]!.length },
    { item: 3, start: 0, end: items[3]!.length },
  ]);
});

test('quote narrows the highlight inside the chunk, ignoring whitespace differences', () => {
  const items = ['예산은 총 3억 원이며', '2027년까지 집행한다.'];
  const chunk = hubChunk(items, '예산은 총 3억 원이며 2027년까지 집행한다.');
  const match = locatePassage(items, { chunk, quote: '3억원이며  2027년' });
  assert.ok(match);
  assert.equal(match.matched, 'quote');
  assert.equal(covered(items, match.ranges), '3억 원이며|2027년');
});

test('a quote missing from the chunk keeps the whole chunk', () => {
  const items = ['첫 문장입니다.', '둘째 문장입니다.'];
  const chunk = hubChunk(items, '첫 문장입니다.');
  const match = locatePassage(items, { chunk, quote: '둘째 문장' });
  assert.ok(match);
  assert.equal(match.matched, 'chunk');
  assert.equal(covered(items, match.ranges), '첫 문장입니다.');
});

test('NFKC ligatures and fullwidth forms map to their source characters', () => {
  const items = ['ﬁnancial ＡＢＣ report', 'ｓｕｍｍａｒｙ'];
  const text = hubPageText(items);
  assert.equal(text, 'financial ABC report summary');
  const chunk = hubChunk(items, 'financial ABC');
  const match = locatePassage(items, { chunk });
  assert.ok(match);
  // 합자 ﬁ 한 글자가 fi 두 글자가 되어도 원문 범위는 ﬁ 하나를 가리킨다.
  assert.deepEqual(match.ranges, [{ item: 0, start: 0, end: 'ﬁnancial ＡＢＣ'.length }]);
  const quoted = locatePassage(items, { quote: 'ＡＢＣ report summary' });
  assert.ok(quoted);
  assert.equal(covered(items, quoted.ranges), 'ＡＢＣ report|ｓｕｍｍａｒｙ');
});

test('decomposed Hangul composes the same way as the hub', () => {
  const decomposed = '한국어'.normalize('NFD');
  const items = [`${decomposed} 문서`];
  assert.equal(buildPageText(items).text, '한국어 문서');
  const match = locatePassage(items, { quote: '국어' });
  assert.ok(match);
  assert.equal(covered(items, match.ranges), '국어'.normalize('NFD'));
});

test('drifted offsets fall back to a whitespace-insensitive search near the hint', () => {
  const items = ['머리말', '같은 문장이 두 번 나온다.', '본문', '같은 문장이 두 번 나온다.', '끝'];
  const text = hubPageText(items);
  const second = text.lastIndexOf('같은 문장이');
  // 허브 위치가 몇 글자 밀렸고 공백 모양도 다르다.
  const match = locatePassage(items, {
    chunk: { start: second - 3, end: second + 10, text: '같은 문장이  두 번\n나온다.' },
  });
  assert.ok(match);
  assert.equal(match.exact, false);
  assert.deepEqual(match.ranges, [{ item: 3, start: 0, end: 15 }]);
});

test('a chunk with a few changed characters is still bracketed by its head and tail', () => {
  const body = Array.from({ length: 30 }, (_, index) => `${index}번째 항목은 서로 다르다.`).join(' ');
  const items = ['서문', body, '결론'];
  // 공백이 아닌 두 글자를 바꾼다. 앞 머리(공백 뺀 48자)가 바뀐 곳을 덮어 뒤 머리로 찾게 한다.
  let at = 30;
  while (/\s/u.test(body[at]!) || /\s/u.test(body[at + 1]!)) at += 1;
  const changed = `${body.slice(0, at)}XX${body.slice(at + 2)}`;
  const match = locatePassage(items, { chunk: { start: 900, end: 1000, text: changed } });
  assert.ok(!hubPageText(items).includes(changed));
  assert.ok(match);
  assert.equal(match.exact, false);
  assert.deepEqual(match.ranges, [{ item: 1, start: 0, end: body.length }]);
});

test('reader text uses chunk offsets directly and reports unknown passages as null', () => {
  const text = '첫 줄\n\n둘째 줄의 인용 구절입니다.';
  const start = text.indexOf('둘째');
  const match = locateInText(text, { chunk: { start, end: text.length, text: text.slice(start) }, quote: '인용 구절' });
  assert.deepEqual(match, { start: text.indexOf('인용'), end: text.indexOf('입니다'), matched: 'quote', exact: true });
  assert.equal(locateInText(text, { chunk: { start: 0, end: 3, text: '없는 문장' } }), null);
  assert.equal(locateInText(text, {}), null);
});
