/**
 * 프로젝트 텍스트 파일의 바이트를 글자로 푼다.
 * BOM → UTF-8 → BOM 없는 UTF-16 → EUC-KR(CP949) 순서로 시도하고, 이진 파일이면 null 을 돌려준다.
 * `partial` 은 앞부분만 잘라 읽을 때 끝에서 끊긴 글자를 오류로 보지 않는다.
 */
export function decodeTextBytes(bytes: Uint8Array, { partial = false }: { partial?: boolean } = {}): string | null {
  const decode = (label: string, from = 0): string | null => {
    try {
      return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(from), { stream: partial });
    } catch {
      return null;
    }
  };
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return decode('utf-8', 3);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return decode('utf-16le', 2);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return decode('utf-16be', 2);
  const utf16 = guessUtf16(bytes);
  if (utf16) return decode(utf16);
  if (bytes.includes(0)) return null;
  return decode('utf-8') ?? decode('euc-kr');
}

/** BOM 없는 UTF-16: 짝수나 홀수 자리에만 0이 몰려 있으면 그쪽 바이트 순서로 본다. */
function guessUtf16(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  const length = Math.min(bytes.length, 1024) & ~1;
  if (length < 4) return null;
  let even = 0;
  let odd = 0;
  for (let index = 0; index < length; index += 2) {
    if (bytes[index] === 0) even += 1;
    if (bytes[index + 1] === 0) odd += 1;
  }
  const pairs = length / 2;
  if (odd > pairs * 0.3 && even < pairs * 0.05) return 'utf-16le';
  if (even > pairs * 0.3 && odd < pairs * 0.05) return 'utf-16be';
  return null;
}

export type TextFormat = 'markdown' | 'json' | 'plain';

/** 파일 이름과 MIME 으로 읽기 보기의 형식을 고른다. */
export function textFormatOf(item: { originalName?: string; title?: string; mimeType?: string }): TextFormat {
  const name = (item.originalName || item.title || '').toLowerCase();
  const mime = (item.mimeType ?? '').toLowerCase();
  if (/\.(md|markdown)$/.test(name) || mime.includes('markdown')) return 'markdown';
  if (/\.json$/.test(name) || mime.includes('json')) return 'json';
  return 'plain';
}

/** 한 줄로 이어 붙은 JSON 을 들여 쓴다. 읽지 못하면 그대로 둔다. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
