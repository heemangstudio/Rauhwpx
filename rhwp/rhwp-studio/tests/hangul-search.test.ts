import test from 'node:test';
import assert from 'node:assert/strict';

import { decomposeHangul, hangulInitials, isInitialsQuery } from '../src/ui/agent-sidebar/hangul-search.ts';

const target = decomposeHangul('새로만들기');

test('조합 중인 값이 모두 이름에 이어진다', () => {
  for (const typing of ['ㅅ', '새', '샐', '새로', '새로ㅁ']) {
    assert.equal(target.includes(decomposeHangul(typing)), true, typing);
  }
  assert.equal(target.includes(decomposeHangul('삭')), false);
});

test('겹자모는 첫 자모를 친 순간부터 맞는다', () => {
  assert.equal(decomposeHangul('화면').includes(decomposeHangul('호')), true);
  assert.equal(decomposeHangul('없음').includes(decomposeHangul('업')), true);
  assert.equal(decomposeHangul('없음').includes(decomposeHangul('ㅄ')), true);
});

test('초성만 쳐도 찾고, 한글이 아닌 글자는 그대로 둔다', () => {
  assert.equal(hangulInitials('새로만들기').includes('ㅅㄹ'), true);
  assert.equal(hangulInitials('HWPX로저장'), 'HWPXㄹㅈㅈ');
  assert.equal(decomposeHangul('ctrl+b'), 'ctrl+b');
  assert.equal(isInitialsQuery('ㅅㄹ'), true);
  assert.equal(isInitialsQuery('새ㄹ'), false);
  assert.equal(isInitialsQuery('ctrl'), false);
});
