import test from 'node:test';
import assert from 'node:assert/strict';
import { readHmlSourceMetadata } from '../src/core/hm/hml-source.ts';

const xml = '<?xml version="1.0" encoding="UTF-8"?><HWPML Version="2.91"><HEAD><BINITEM Id="1"/><BINITEM Id="2"/></HEAD><!-- <BINITEM/> --><![CDATA[<BINITEM/>]]></HWPML>';

test('HML 출처의 인코딩과 자원 수를 기록한다', () => {
  for (const encoding of ['utf-8', 'utf-16le', 'utf-16be'] as const) {
    const bytes = encoding === 'utf-8' ? new TextEncoder().encode(xml)
      : new Uint8Array(Buffer.from(`\ufeff${xml}`, 'utf16le'));
    if (encoding === 'utf-16be') {
      for (let i = 0; i < bytes.length; i += 2) [bytes[i], bytes[i + 1]] = [bytes[i + 1], bytes[i]];
    }
    assert.deepEqual(readHmlSourceMetadata(bytes), {
      format: 'hml', hwpmlVersion: '2.91', encoding, resourceCount: 2,
      hmlSavable: true, saveBlockers: [], warnings: [],
    });
  }
  const korean = new TextEncoder().encode(xml.replace('UTF-8', 'EUC-KR'));
  assert.equal(readHmlSourceMetadata(korean).encoding, 'euc-kr');
});
