import type { HmlOpenMetadata } from './bridge-types';

/** 엔진이 검증한 HML의 출처 정보만 읽는다. 문서 내용은 엔진이 해석한다. */
export function readHmlSourceMetadata(bytes: Uint8Array): HmlOpenMetadata {
  const prefix = new TextDecoder().decode(bytes.subarray(0, 256));
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be'
    : /<\?xml\b[^>]*\bencoding\s*=\s*['"](?:euc-kr|ks_c_5601-1987|cp949)['"]/i.test(prefix) ? 'euc-kr'
    : 'utf-8';
  const xml = new TextDecoder(encoding).decode(bytes).replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const root = /<(?:[\w.-]+:)?HWPML\b([^>]*)>/.exec(xml)?.[1] ?? '';
  const version = /\bVersion\s*=\s*['"]([^'"]*)['"]/.exec(root)?.[1];
  return {
    format: 'hml',
    ...(version ? { hwpmlVersion: version } : {}),
    encoding,
    resourceCount: [...xml.matchAll(/<(?:[\w.-]+:)?BINITEM\b/g)].length,
    hmlSavable: true,
    saveBlockers: [],
    warnings: [],
  };
}
