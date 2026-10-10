import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeTextBytes } from '../src/ui/agent-sidebar/project/text-decode.ts';

const KOREAN = '밑줄 긋기의 학습 효과\n요약: 효과가 낮다.';

/** EUC-KR 바이트는 표준 인코더가 없어 직접 적는다. "한글 문서" */
const EUC_KR_HANGUL = Uint8Array.from([0xc7, 0xd1, 0xb1, 0xdb, 0x20, 0xb9, 0xae, 0xbc, 0xad]);

function utf16(text: string, littleEndian: boolean, bom: boolean): Uint8Array {
  const out = new Uint8Array((text.length + (bom ? 1 : 0)) * 2);
  const view = new DataView(out.buffer);
  let offset = 0;
  if (bom) { view.setUint16(0, 0xfeff, littleEndian); offset = 2; }
  for (let index = 0; index < text.length; index += 1) view.setUint16(offset + index * 2, text.charCodeAt(index), littleEndian);
  return out;
}

test('텍스트 파일 바이트를 인코딩에 맞춰 한글로 푼다', () => {
  const utf8 = new TextEncoder().encode(KOREAN);
  assert.equal(decodeTextBytes(utf8), KOREAN);
  assert.equal(decodeTextBytes(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8])), KOREAN);
  assert.equal(decodeTextBytes(utf16(KOREAN, true, true)), KOREAN);
  assert.equal(decodeTextBytes(utf16(KOREAN, false, true)), KOREAN);
  assert.equal(decodeTextBytes(utf16(`plain ${KOREAN} text`, true, false)), `plain ${KOREAN} text`);
  assert.equal(decodeTextBytes(EUC_KR_HANGUL), '한글 문서');
});

test('앞부분만 자른 UTF-8 은 끊긴 글자를 버리고, 이진 파일은 글자로 보지 않는다', () => {
  const utf8 = new TextEncoder().encode(KOREAN);
  assert.equal(decodeTextBytes(utf8.subarray(0, 4), { partial: true }), '밑');
  assert.equal(decodeTextBytes(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48])), null);
});
