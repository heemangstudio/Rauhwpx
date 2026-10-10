import test from 'node:test';
import assert from 'node:assert/strict';
import { extractHwpJsonModel, HWPJSON_PASTE_MAX_CHARS } from '../src/engine/office-html-sanitize.ts';

test('한글 클립보드 HTML 에서 [data-hwpjson] 모델을 꺼낸다', () => {
  const html =
    '<!--StartFragment--><p>본문</p><!--EndFragment-->' +
    '<!--[data-hwpjson]{"ro":{"hp":1},"sl":{}}-->';
  assert.equal(extractHwpJsonModel(html), '{"ro":{"hp":1},"sl":{}}');
});

test('한글이 아닌 HTML 에서는 null 을 준다', () => {
  assert.equal(extractHwpJsonModel('<p>워드</p>'), null);
  assert.equal(extractHwpJsonModel('<!--[data-hwpjson]-->'), null);
});

test('문서모델 추출은 32M 자를 넘는 모델을 버린다', () => {
  const html = (size: number) => `<!--[data-hwpjson]{${'a'.repeat(size - 2)}}-->`;
  assert.equal(extractHwpJsonModel(html(HWPJSON_PASTE_MAX_CHARS))?.length, HWPJSON_PASTE_MAX_CHARS);
  assert.equal(extractHwpJsonModel(html(32_000_001)), null);
});
