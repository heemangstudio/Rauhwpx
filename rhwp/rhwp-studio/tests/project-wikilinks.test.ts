import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseWikilinks } from '../src/ui/agent-sidebar/wikilinks.ts';
import { tokenizeInline, tokenizeMarkdown } from '../src/ui/agent-sidebar/plan-markdown.ts';
import { stableStreamingBlocks } from '../src/ui/agent-sidebar/chat-markdown.ts';

interface Case {
  name: string;
  text: string;
  expect: unknown[];
}

// 허브 project-links.mjs 와 같은 사례 파일을 읽는다 — 두 파서의 동작이 갈라지면 여기서 드러난다.
const fixture = JSON.parse(readFileSync(
  new URL('../../rhwp-agent/tests/fixtures/wikilinks-cases.json', import.meta.url),
  'utf8',
)) as { cases: Case[] };

for (const entry of fixture.cases) {
  test(`wikilink grammar: ${entry.name}`, () => {
    assert.deepEqual(parseWikilinks(entry.text), entry.expect);
  });
}

test('tokenizeInline turns citations into wikilink tokens', () => {
  assert.deepEqual(tokenizeInline('근거는 [[fabc234#c3|예산은 3억 원]] 입니다'), [
    { kind: 'text', text: '근거는 ' },
    { kind: 'wikilink', raw: '[[fabc234#c3|예산은 3억 원]]', id: 'fabc234', anchor: { kind: 'chunk', n: 3 }, label: '예산은 3억 원' },
    { kind: 'text', text: ' 입니다' },
  ]);
});

test('citations inside code spans and fences stay literal', () => {
  assert.deepEqual(tokenizeInline('`[[fabc234]]`'), [{ kind: 'code', text: '[[fabc234]]' }]);
  const blocks = tokenizeMarkdown('```\n[[fabc234]]\n```');
  assert.deepEqual(blocks, [{ kind: 'code', lang: '', code: '[[fabc234]]' }]);
});

test('a citation cut off at the stream tail is plain text, never a broken chip', () => {
  const partial = tokenizeInline('답변 [[fabc234#c4|부분 인');
  assert.ok(partial.every((token) => token.kind === 'text'));
  // 스트리밍 중에는 쓰는 중인 마지막 문단을 그리지 않는다.
  const source = '첫 문단입니다.\n\n둘째 [[fabc234#c4|부분';
  const stable = stableStreamingBlocks(tokenizeMarkdown(source), source);
  assert.deepEqual(stable, [{ kind: 'paragraph', text: '첫 문단입니다.' }]);
});

test('escaped and markdown-link brackets are not citations', () => {
  assert.ok(tokenizeInline('\\[[fabc234]]').every((token) => token.kind === 'text'));
  assert.deepEqual(tokenizeInline('[링크](https://example.com)'), [
    { kind: 'link', text: '링크', href: 'https://example.com' },
  ]);
});
