import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_AGENT_INSTRUCTIONS } from '../../rhwp-agent/agent-instructions.mjs';
import {
  assembleDocument,
  joinSource,
  parseBlocks,
  parseInline,
  parseMarkdown,
  serializeBlock,
  serializeBlocks,
  serializeInline,
  type Block,
  type EmittedBlock,
  type OriginalBlockMeta,
} from '../src/ui/agent-sidebar/markdown-model.ts';

/** 편집기가 하는 일을 흉내 낸다: 블록마다 정규 직렬화를 canon 으로 두고, 고친 블록만 바꿔 잇는다. */
function edit(text: string, change: (blocks: Block[]) => Array<{ block: Block; origin: number | null }>): string {
  const doc = parseMarkdown(text);
  const originals: OriginalBlockMeta[] = doc.blocks.map((block) => ({
    src: block.src,
    before: block.before,
    canon: serializeBlock(block.block),
    kind: block.block.t,
  }));
  const emitted: EmittedBlock[] = change(structuredClone(doc.blocks.map((block) => block.block)))
    .map(({ block, origin }) => ({ markdown: serializeBlock(block), origin, kind: block.t }));
  return assembleDocument(emitted, originals, doc.tail, doc.eol);
}

const keep = (blocks: Block[]) => blocks.map((block, origin) => ({ block, origin }));

test('허브 기본 AGENTS.md 는 그대로 다시 이어지고, 블록마다 정규 직렬화가 원문과 같다', () => {
  const doc = parseMarkdown(DEFAULT_AGENT_INSTRUCTIONS);
  assert.equal(joinSource(doc), DEFAULT_AGENT_INSTRUCTIONS);
  assert.deepEqual(doc.blocks.map((block) => block.block.t), ['heading', 'paragraph', 'heading', 'list']);
  for (const block of doc.blocks) assert.equal(serializeBlock(block.block), block.src);
  assert.equal(edit(DEFAULT_AGENT_INSTRUCTIONS, keep), DEFAULT_AGENT_INSTRUCTIONS);
});

test('지원하지 않는 구조는 원문 블록으로 남고 다시 이을 때 한 글자도 바뀌지 않는다', () => {
  const cases = [
    '---\ntitle: 지시\ntags: [a, b]\n---',
    '| 열 | 값 |\n|:---|---:|\n| a | 1 |',
    '<details>\n<summary>열기</summary>\n본문\n</details>',
    '<!-- 메모\n\n여러 줄 -->',
    '[ref]: https://example.com  "제목"',
    '[^1]: 각주 본문\n    이어지는 줄',
    '제목\n===',
    '    들여쓴 코드',
    '$$\na^2 + b^2\n$$',
    '> 인용\n게으른 이어짐',
    '- 항목\n\n  느슨한 목록의 둘째 문단',
    '- 항목\n  ```\n  안쪽 코드\n  ```',
    '```\n닫히지 않은 코드는 끝까지 원문',
  ];
  for (const source of cases) {
    const text = source.startsWith('---') ? `${source}\n\n끝 문단\n` : `# 머리\n\n${source}\n\n끝 문단\n`;
    const doc = parseMarkdown(text);
    assert.equal(joinSource(doc), text, source);
    assert(doc.blocks.some((block) => block.block.t === 'raw' && (block.src.includes(source) || source.includes(block.src))), `raw block for ${JSON.stringify(source)}`);
    // 다른 블록을 고쳐도 원문 블록은 그대로다.
    const edited = edit(text, (blocks) => blocks.map((block, origin) => (
      { block: origin === blocks.length - 1 && block.t === 'paragraph' ? { t: 'heading', level: 2, content: [{ t: 'text', text: '바뀐 끝' }] } as Block : block, origin }
    )));
    const expected = source.startsWith('```') ? text : text.replace('끝 문단', '## 바뀐 끝');
    assert.equal(edited, expected, source);
  }
});

test('손대지 않은 블록은 원래 글머리 문자·구분자·빈 줄을 지킨다', () => {
  const text = '\n# 제목 #\n문단 __굵게__ _기울임_\n\n\n* 하나\n* 둘\n\n1) 첫째\n1) 둘째\n\n***\n';
  assert.equal(edit(text, keep), text);
  const edited = edit(text, (blocks) => blocks.map((block, origin) => {
    if (block.t === 'list' && !block.ordered) block.items.push({ content: [{ t: 'text', text: '셋' }], children: [] });
    return { block, origin };
  }));
  assert.equal(edited, '\n# 제목 #\n문단 __굵게__ _기울임_\n\n\n* 하나\n* 둘\n* 셋\n\n1) 첫째\n1) 둘째\n\n***\n');
  // 블록을 지우면 이웃은 원래 빈 줄 대신 빈 줄 하나로 붙는다.
  const removed = edit(text, (blocks) => keep(blocks).filter(({ block }) => block.t !== 'paragraph'));
  assert.equal(removed, '\n# 제목 #\n\n* 하나\n* 둘\n\n1) 첫째\n1) 둘째\n\n***\n');
});

test('CRLF 문서는 고친 뒤에도 CRLF 로 저장된다', () => {
  const text = '# 제목\r\n\r\n- 하나\r\n';
  assert.equal(joinSource(parseMarkdown(text)), text);
  const edited = edit(text, (blocks) => [...keep(blocks), { block: { t: 'paragraph', content: [{ t: 'text', text: '새 문단' }] }, origin: null }]);
  assert.equal(edited, '# 제목\r\n\r\n- 하나\r\n\r\n새 문단\r\n');
});

test('고친 제목·목록·인라인 서식은 결정적으로 직렬화되고 다시 읽어도 같은 구조다', () => {
  const blocks: Block[] = [
    { t: 'heading', level: 2, content: [{ t: 'text', text: '규칙 ' }, { t: 'code', text: 'a`b' }] },
    {
      t: 'paragraph',
      content: [
        { t: 'strong', delim: '**', children: [{ t: 'text', text: '굵게 ' }] },
        { t: 'text', text: '와 ' },
        { t: 'em', delim: '*', children: [{ t: 'strong', delim: '**', children: [{ t: 'text', text: '둘 다' }] }] },
        { t: 'br' },
        { t: 'link', dest: '<https://example.com/a b>', children: [{ t: 'text', text: '링크' }] },
        { t: 'text', text: ' 2*3*4 와 snake_case' },
      ],
    },
    {
      t: 'list', ordered: true, marker: '.', start: 3, items: [
        { content: [{ t: 'text', text: '셋' }], children: [
          { t: 'list', ordered: false, marker: '-', start: 1, items: [{ content: [{ t: 'text', text: '1. 숫자로 시작' }], children: [] }] },
        ] },
        { content: [{ t: 'text', text: '넷' }], children: [] },
      ],
    },
    { t: 'paragraph', content: [{ t: 'text', text: '# 제목 아님' }, { t: 'br' }, { t: 'text', text: '- 목록 아님' }] },
    { t: 'quote', children: [{ t: 'paragraph', content: [{ t: 'text', text: '인용' }] }, { t: 'list', ordered: false, marker: '-', start: 1, items: [{ content: [{ t: 'text', text: '안' }], children: [] }] }] },
    { t: 'code', fence: '```', info: 'ts', text: 'const s = "```";' },
  ];
  const markdown = serializeBlocks(blocks);
  assert.equal(markdown, [
    '## 규칙 ``a`b``',
    '',
    '**굵게** 와 _**둘 다**_',
    '[링크](<https://example.com/a b>) 2\\*3\\*4 와 snake\\_case',
    '',
    '3. 셋',
    '   - 1\\. 숫자로 시작',
    '4. 넷',
    '',
    '\\# 제목 아님',
    '\\- 목록 아님',
    '',
    '> 인용',
    '>',
    '> - 안',
    '',
    '````ts',
    'const s = "```";',
    '````',
  ].join('\n'));
  assert.equal(serializeBlocks(parseBlocks(markdown)), markdown, 'serialization is a fixed point');
});

test('인라인 직렬화는 필요할 때만 이스케이프한다', () => {
  for (const text of ['a * b', 'snake_case_name', 'C:\\path', '1 < 2', '[대괄호] 글', '100%', '~물결~']) {
    assert.equal(serializeInline([{ t: 'text', text }]), text);
  }
  assert.equal(serializeInline([{ t: 'text', text: '*별*' }]), '\\*별\\*');
  assert.equal(serializeInline([{ t: 'text', text: '`틱`' }]), '\\`틱\\`');
  assert.equal(serializeInline([{ t: 'text', text: '<b>' }]), '\\<b>');
  // 공백은 강조 기호 밖으로 뺀다.
  assert.equal(serializeInline([{ t: 'strong', delim: '**', children: [{ t: 'text', text: ' 굵게 ' }] }]), ' **굵게** ');
  // 브라우저가 겹쳐 만든 굵게 안의 굵게는 한 겹으로 쓴다.
  assert.equal(serializeInline([
    { t: 'strong', delim: '**', children: [{ t: 'text', text: '굵은말 ' }, { t: 'strong', delim: '**', children: [{ t: 'text', text: '보통' }] }] },
  ]), '**굵은말 보통**');
  // 원문 인라인(HTML·그림)은 그대로.
  const raw = '<kbd>Ctrl</kbd> ![그림](a.png)';
  assert.equal(serializeInline(parseInline(raw)), raw);
});
