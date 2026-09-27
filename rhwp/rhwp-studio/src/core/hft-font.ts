/**
 * HFT 1.0 서체의 cubic outline을 세션용 OpenType/CFF로 옮긴다.
 * 좌표/advance는 원본 값을 유지하며, 브라우저가 지원하지 않는 HFT hint만 제외한다.
 * 한컴 본문 서체는 문자군(한글·영문·한자·기호)마다 파일이 나뉘므로 한 이름의 파일들을
 * 하나의 글꼴로 합칠 수 있다. 지원하지 않는 outline 명령은 대체 도형 없이 거절한다.
 */
const MAGIC = 'Han Unified Font File 1.0\x1a';
/** 합친 글꼴의 em. 파일마다 em(1000·1058·1200 …)이 달라 좌표를 이 값으로 맞춘다. */
const MERGED_UNITS = 1000;
type Point = [number, number];
type Outline = Array<{ op: 'move' | 'line' | 'curve' | 'close'; points: Point[] }>;
interface Glyph { unicodes: number[]; advance: number; outline: Outline }
interface HftFont { family: string; italic: boolean; units: number; baseline: number; copyright: string; glyphs: Glyph[] }

class Reader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) { this.bytes = bytes; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  check(at: number, length: number): void {
    if (!Number.isInteger(at) || at < 0 || length < 0 || at + length > this.bytes.length) throw new Error('잘못된 HFT 서체 범위입니다.');
  }
  u16(at: number): number { this.check(at, 2); return this.view.getUint16(at, true); }
  i16(at: number): number { this.check(at, 2); return this.view.getInt16(at, true); }
  u32(at: number): number { this.check(at, 4); return this.view.getUint32(at, true); }
}

function isHft(bytes: Uint8Array): boolean {
  return bytes.length >= MAGIC.length && [...MAGIC].every((c, i) => bytes[i] === c.charCodeAt(0));
}

/** HFT가 아니면 null. 손상되거나 지원하지 않는 HFT는 오류로 보고한다. */
export function convertHftToOpenType(bytes: ArrayBuffer, filename: string): ArrayBuffer | null {
  const source = new Uint8Array(bytes);
  if (!isHft(source)) return null;
  const font = readHft(source, filename);
  if (!font.glyphs.some(drawable)) throw new Error('지원하지 않는 HFT 문자표입니다.');
  return encodeOpenType(font).buffer as ArrayBuffer;
}

/**
 * 한 글꼴 이름에 딸린 문자군별 HFT 파일을 하나의 OpenType으로 합친다. 같은 문자가 여러
 * 파일에 있으면 앞 파일이 이긴다. 쓸 수 있는 문자가 없는 파일은 건너뛰고, 전부 비면 오류다.
 */
export function convertHftFamilyToOpenType(
  parts: ReadonlyArray<{ bytes: ArrayBuffer; fileName: string }>,
  family: string,
): ArrayBuffer {
  const fonts: HftFont[] = [];
  const errors: string[] = [];
  for (const part of parts) {
    const source = new Uint8Array(part.bytes);
    if (!isHft(source)) { errors.push(`${part.fileName}: HFT가 아닙니다.`); continue; }
    try {
      const font = readHft(source, part.fileName);
      if (font.glyphs.some(drawable)) fonts.push(font);
    } catch (error) {
      errors.push(`${part.fileName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!fonts.length) throw new Error(errors.join('; ') || '지원하지 않는 HFT 문자표입니다.');
  const primary = fonts[0];
  const baseline = Math.round(primary.baseline * MERGED_UNITS / primary.units);
  const seen = new Set<number>();
  const glyphs: Glyph[] = [];
  for (const font of fonts) {
    const scale = MERGED_UNITS / font.units;
    const at = (n: number): number => Math.round(n * scale);
    for (const glyph of font.glyphs) {
      const unicodes = glyph.unicodes.filter(code => !seen.has(code));
      if (!unicodes.length || (!drawable(glyph) && !unicodes.includes(0x20))) continue;
      unicodes.forEach(code => seen.add(code));
      glyphs.push({
        unicodes,
        advance: at(glyph.advance),
        outline: glyph.outline.map(command => ({
          op: command.op,
          points: command.points.map(([x, y]): Point => [at(x), at(y)]),
        })),
      });
    }
  }
  return encodeOpenType({
    family, italic: primary.italic, units: MERGED_UNITS, baseline, copyright: primary.copyright, glyphs,
  }).buffer as ArrayBuffer;
}

function drawable(glyph: Glyph): boolean {
  return glyph.unicodes.length > 0
    && glyph.outline.some(command => command.op === 'line' || command.op === 'curve');
}

function readHft(bytes: Uint8Array, filename: string): HftFont {
  const r = new Reader(bytes);
  r.check(0, 0x200);
  if (r.u32(0x1a) !== 0x01020304 || r.u32(0x24) !== bytes.length) throw new Error('지원하지 않는 HFT 헤더입니다.');
  // 0x1A8이 0이 아닌 파일(한양신명조 등 일부 번들)은 glyph 기록이 보호되어 있다. 풀지 않고 fallback에 맡긴다.
  if (r.u16(0x1a8) !== 0) throw new Error('보호된 HFT 서체는 변환하지 않습니다.');
  const widthAt = r.u32(0x1aa);
  const outlineAt = r.u32(0x1ae);
  r.check(widthAt, 12);
  r.check(outlineAt, 36);
  const outlineEnd = outlineAt + r.u32(outlineAt);
  if (outlineEnd > bytes.length || outlineEnd < outlineAt + 36) throw new Error('잘못된 HFT 테이블 길이입니다.');
  // 폭 표: 문자마다 폭(flag 1) 또는 모든 문자가 같은 고정 폭(flag 0).
  const widthFirst = r.u16(widthAt + 4);
  const widthLast = r.u16(widthAt + 6);
  const perCodeWidth = r.u16(widthAt + 8) === 1;
  if (perCodeWidth) r.check(widthAt + 10, (widthLast - widthFirst + 1) * 2);
  const advanceOf = (code: number): number => {
    if (!perCodeWidth) return r.u16(widthAt + 10);
    return code >= widthFirst && code <= widthLast ? r.u16(widthAt + 10 + (code - widthFirst) * 2) : 0;
  };
  const units = r.u16(outlineAt + 4);
  const baseline = r.u16(0x194);
  if (units < 16 || units > 16384 || baseline > units) throw new Error('잘못된 HFT em 값입니다.');
  const blockCount = r.u16(outlineAt + 8);
  if (r.u16(outlineAt + 6) !== 1 || blockCount < 1 || blockCount > 64) {
    throw new Error('지원하지 않는 HFT 문자표 또는 outline 형식입니다.');
  }
  const italic = bytes[0x158] === 1;
  // 내부 Johab family `수식` + 문자표로 bank를 식별한다. 파일을 바꿔 이름 붙여도 동일하다.
  const equationFamily = [0xae, 0x81, 0xaf, 0xa2, 0].every((byte, i) => bytes[0x6c + i] === byte);
  const glyphs: Glyph[] = [];
  let firstCode = -1;
  // 블록: u32 길이, u16 flag, u16 first/last/count, u16 em, bbox 4개. flag bit0 이면 코드 목록이
  // 뒤따르며(0xffff = 표준 순서) 그다음이 glyph offset 표다. 다음 블록은 길이만큼 뒤에 있다.
  let block = outlineAt + 14;
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
    r.check(block, 22);
    const length = r.u32(block);
    const flag = r.u16(block + 4);
    const first = r.u16(block + 6);
    const last = r.u16(block + 8);
    const count = r.u16(block + 10);
    const blockEnd = blockIndex + 1 < blockCount ? block + length : outlineEnd;
    if (blockEnd > outlineEnd || blockEnd <= block || last < first) throw new Error('잘못된 HFT 테이블 길이입니다.');
    let offsets = block + 22;
    let codes: number[] | null = null;
    if (flag & 1) {
      const listBytes = r.u16(block + 22);
      const kind = r.u16(block + 24);
      if (kind !== 0xffff) {
        if (listBytes !== 4 + count * 2) throw new Error('잘못된 HFT 코드 목록입니다.');
        codes = Array.from({ length: count }, (_, i) => r.u16(block + 26 + i * 2));
      } else if (listBytes !== 4) throw new Error('잘못된 HFT 코드 목록입니다.');
      offsets += listBytes;
    } else if (last - first + 1 !== count) {
      throw new Error('지원하지 않는 HFT 문자표 또는 outline 형식입니다.');
    }
    if (firstCode < 0) firstCode = first;
    const base = offsets - 2;
    r.check(offsets, count * 4);
    let corrupt = 0;
    for (let index = 0; index < count; index++) {
      const start = base + r.u32(offsets + index * 4);
      const end = index + 1 < count ? base + r.u32(offsets + (index + 1) * 4) : blockEnd;
      // 빈틈 없이 붙은 파일은 첫 기록의 머리 2 byte가 마지막 offset의 상위 word(0)와 겹친다.
      if (start < offsets + count * 4 - 2 || end < start || end > blockEnd) throw new Error('잘못된 HFT glyph 순서입니다.');
      r.check(start, end - start);
      r.check(start, 11);
      const code = codes ? codes[index] : first + index;
      const advance = advanceOf(code);
      if (advance > 32767) throw new Error('HFT advance 범위를 벗어났습니다.');
      // 기록 머리: 수식·영문(flag bit4 = 0)은 12 byte, 본문 한글·한자·기호는 u16 flag + u16 길이 4 byte.
      // 빈 glyph는 짧은 기록을 쓰며, 일부 오래된 space에는 미완성 moveto가 있다.
      const short = (flag & 0x10) !== 0;
      const lengthAt = short ? start + 2 : start + 10;
      const empty = short ? end - start <= 4 : end - start <= 12 || r.u16(start + 6) === 0;
      let outline: Outline = [];
      // 본문 영문 bank의 space도 미완성 moveto만 담는다. 그릴 것이 없으니 읽지 않는다.
      if (!empty && !(first < 0x100 && code === 0x20)) {
        const glyphLength = r.u16(lengthAt);
        if (glyphLength < 2 || lengthAt + glyphLength > end) throw new Error('잘못된 HFT glyph 길이입니다.');
        // outline의 마지막 1 byte(대개 close, 때로는 좌표 0)는 길이 밖, 다음 기록의 첫 byte에 있다.
        // 넘어온 byte가 명령 자리의 0이면 outline 끝 표시로 읽는다.
        const dataEnd = Math.min(lengthAt + glyphLength + 1, blockEnd);
        try {
          outline = decodeOutline(bytes.subarray(lengthAt + 2, dataEnd), baseline);
        } catch (error) {
          // 수천 자짜리 본문 서체의 손상 glyph 몇 개는 fallback에 맡긴다. 1%를 넘으면 파일을 거절한다.
          if (++corrupt > Math.floor(count / 100)) throw error;
        }
      }
      const unicodes = equationFamily
        ? equationUnicodes(code)
        : hftUnicodes(first, code, codes ? -1 : index);
      glyphs.push({ unicodes, advance, outline });
    }
    block += length;
  }
  const family = equationFamily
    ? firstCode === 0x500 ? 'HSUSFL' : firstCode === 0x2200 ? 'HSUSSP' : italic ? 'HSUSRI' : 'HSUSR'
    : filename.replace(/^.*[\\/]/, '').replace(/\.hft$/i, '').trim() || 'Imported HFT';
  const copyright = new TextDecoder('ascii').decode(bytes.subarray(0xcc, 0x10c)).replace(/\0.*$/s, '').trim();
  return { family, italic, units, baseline, copyright, glyphs };
}

/** 수식 서체: 기호 bank는 Unicode 그대로, Greek bank는 Unicode Greek + 0x190 이고 나머지는 PUA로 보존한다. */
function equationUnicodes(code: number): number[] {
  if (code < 0x500 || code >= 0x2200) return [code];
  if (code > 0x5ff) return [];
  const greek = (code >= 0x521 && code <= 0x559) || (code >= 0x560 && code <= 0x566);
  return greek ? [code - 0x190, 0xe000 + code - 0x500] : [0xe000 + code - 0x500];
}

/** 영문 bank의 ASCII 뒤 한컴 전용 칸: 둥근 따옴표와 가운뎃점. */
const LATIN_EXTRA = new Map([[0x81, 0x201c], [0x82, 0x201d], [0x83, 0x2018], [0x84, 0x2019], [0x85, 0xb7]]);

/**
 * 본문 HFT의 문자 bank. 한글·한자는 KS X 1001 행(94자) 순서이고, 기호(0xA1행~)와
 * 일본 가나(0xAA행~)는 행마다 96칸(0xA0~0xFF, 양 끝 빈칸) 순서다. 코드 목록이 있는
 * 한글 블록은 Johab 코드다.
 */
function hftUnicodes(bankFirst: number, code: number, implicitIndex: number): number[] {
  if (bankFirst < 0x100) {
    if (code >= 0x20 && code <= 0x7e) return [code];
    const extra = LATIN_EXTRA.get(code);
    return extra ? [extra] : [];
  }
  if (bankFirst >= 0x8000) {
    if (implicitIndex < 0) return johabUnicodes(code);
    return implicitIndex < 25 * 94 ? ksx1001(0xb0 + Math.floor(implicitIndex / 94), 0xa1 + implicitIndex % 94) : [];
  }
  if (bankFirst >= 0x4000 && bankFirst < 0x8000) {
    const i = code - 0x4000;
    return i >= 0 && i < 52 * 94 ? ksx1001(0xca + Math.floor(i / 94), 0xa1 + i % 94) : [];
  }
  if (bankFirst >= 0x3400 && bankFirst < 0x4000) return ksx1001Rows96(code - 0x3400, 0xa1, 12);
  if (bankFirst >= 0x1f00 && bankFirst < 0x2000) return ksx1001Rows96(code - 0x1f00, 0xaa, 2);
  return [];
}

function ksx1001Rows96(i: number, firstLead: number, rows: number): number[] {
  const row = Math.floor(i / 96);
  return i >= 0 && row < rows ? ksx1001(firstLead + row, 0xa0 + i % 96) : [];
}

let eucKr: TextDecoder | null | undefined;
function ksx1001(lead: number, trail: number): number[] {
  // 0xA0·0xFF 칸이나 확장 완성형 영역은 KS X 1001 문자가 아니다.
  if (trail < 0xa1 || trail > 0xfe || lead < 0xa1 || lead > 0xfe) return [];
  if (eucKr === undefined) {
    try { eucKr = new TextDecoder('euc-kr'); } catch { eucKr = null; }
  }
  if (!eucKr) return [];
  const text = eucKr.decode(Uint8Array.of(lead, trail));
  const code = text.codePointAt(0);
  if (code === undefined || code === 0xfffd || text.length !== 1) return [];
  const normalized = text.normalize('NFC').codePointAt(0)!;
  // 한자 호환 영역(U+F900~)은 문서가 통합 한자로 저장하는 경우도 함께 받는다.
  return normalized !== code ? [code, normalized] : [code];
}

const JOHAB_CHO = [-1, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
const JOHAB_JUNG = [-1, -1, -1, 0, 1, 2, 3, 4, -1, -1, 5, 6, 7, 8, 9, 10, -1, -1, 11, 12, 13, 14, 15, 16, -1, -1, 17, 18, 19, 20];
const JOHAB_JONG = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, -1, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27];
// 첫소리·받침 인덱스 → 호환 자모(U+3131~).
const CHO_COMPAT = [0x3131, 0x3132, 0x3134, 0x3137, 0x3138, 0x3139, 0x3141, 0x3142, 0x3143, 0x3145, 0x3146,
  0x3147, 0x3148, 0x3149, 0x314a, 0x314b, 0x314c, 0x314d, 0x314e];
const JONG_COMPAT = [0, 0x3131, 0x3132, 0x3133, 0x3134, 0x3135, 0x3136, 0x3137, 0x3139, 0x313a, 0x313b, 0x313c,
  0x313d, 0x313e, 0x313f, 0x3140, 0x3141, 0x3142, 0x3144, 0x3145, 0x3146, 0x3147, 0x3148, 0x314a, 0x314b,
  0x314c, 0x314d, 0x314e];

/** 상용 조합형(Johab) 코드 → 완성형 음절 또는 호환 자모. 채움 코드만 있으면 대응하지 않는다. */
function johabUnicodes(code: number): number[] {
  if (!(code & 0x8000)) return [];
  const cho = JOHAB_CHO[(code >> 10) & 31] ?? -1;
  const jung = JOHAB_JUNG[(code >> 5) & 31] ?? -1;
  const jong = JOHAB_JONG[code & 31] ?? -1;
  const choFill = ((code >> 10) & 31) === 1;
  const jungFill = ((code >> 5) & 31) === 2;
  if (cho >= 0 && jung >= 0 && jong >= 0) return [0xac00 + (cho * 21 + jung) * 28 + jong];
  if (choFill && jung >= 0 && jong === 0) return [0x314f + jung];
  if (cho >= 0 && jungFill && jong === 0) return [CHO_COMPAT[cho]];
  if (choFill && jungFill && jong > 0) return [JONG_COMPAT[jong]];
  return [];
}

function decodeOutline(bytes: Uint8Array, baseline: number): Outline {
  let at = 0;
  let x = 0;
  let y = 0;
  let start: Point = [0, 0];
  let open = false;
  const outline: Outline = [];
  const read = (): number => {
    if (at >= bytes.length) throw new Error('HFT outline이 잘렸습니다.');
    return bytes[at++];
  };
  const number = (): number => {
    const value = read();
    if (value >= 0x7c && value <= 0x7f) return (value - 0x7c) * 256 + 124 + read();
    if (value >= 0x81 && value <= 0x84) return -((0x84 - value) * 256 + 124 + read());
    // 0x80: 1147을 넘는 좌표(주로 한자 hint)는 뒤 2 byte가 little-endian i16이다.
    if (value === 0x80) { const low = read(); const word = read() * 256 + low; return word > 32767 ? word - 65536 : word; }
    return value < 128 ? value : value - 256;
  };
  const point = (dx: number, dy: number): Point => {
    x += dx; y += dy;
    if (Math.abs(x) > 32767 || Math.abs(y - baseline) > 32767) throw new Error('HFT 좌표 범위를 벗어났습니다.');
    return [x, y - baseline];
  };
  const move = (dx: number, dy: number): void => {
    if (open) outline.push({ op: 'close', points: [] });
    const p = point(dx, dy);
    start = [x, y];
    outline.push({ op: 'move', points: [p] });
    open = true;
  };
  while (at < bytes.length) {
    const op = read();
    if (op === 0) break; // 일부 glyph는 0으로 outline 끝을 표시한다.
    if (op === 1) move(number(), 0);
    else if (op === 2) move(0, number());
    else if (op === 3) move(number(), number());
    else if (op === 4) {
      // 이미 닫힌 contour의 close는 아무것도 하지 않는다.
      if (open) { outline.push({ op: 'close', points: [] }); open = false; [x, y] = start; }
    } else if (op === 5 || op === 6 || op === 7) {
      if (!open) move(0, 0); // close 뒤 moveto 없이 그리면 그 자리에서 새 contour가 시작된다.
      const dx = op === 6 ? 0 : number();
      const dy = op === 5 ? 0 : number();
      outline.push({ op: 'line', points: [point(dx, dy)] });
    } else if (op === 9 || op === 10 || op === 11) {
      if (!open) move(0, 0);
      const a = point(op === 10 ? 0 : number(), op === 9 ? 0 : number());
      const b = point(number(), number());
      const c = point(op === 9 ? 0 : number(), op === 10 ? 0 : number());
      outline.push({ op: 'curve', points: [a, b, c] });
    } else if (op >= 0x40 && op <= 0x43) {
      // hstem/vstem 및 3-stem hint. 곡선 좌표에는 영향을 주지 않는다.
      for (let n = 0; n < (op % 2 === 0 ? 2 : 6); n++) number();
    } else throw new Error(`지원하지 않는 HFT outline 명령: ${op}`);
  }
  if (open) outline.push({ op: 'close', points: [] });
  return outline;
}

const u16 = (n: number): number[] => [(n >>> 8) & 255, n & 255];
const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string): number[] => [...s].map(c => c.charCodeAt(0) & 127);
const utf16 = (s: string): number[] => Array.from({ length: s.length }, (_, i) => u16(s.charCodeAt(i))).flat();
const set16 = (b: Uint8Array, at: number, n: number): void => { b.set(u16(n), at); };
const set32 = (b: Uint8Array, at: number, n: number): void => { b.set(u32(n), at); };
const checksum = (bytes: Uint8Array): number => {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) sum = (sum + (((bytes[i] ?? 0) * 0x1000000)
    + ((bytes[i + 1] ?? 0) << 16) + ((bytes[i + 2] ?? 0) << 8) + (bytes[i + 3] ?? 0))) >>> 0;
  return sum;
};

function cffInteger(n: number): number[] {
  if (n >= -107 && n <= 107) return [n + 139];
  if (n >= 108 && n <= 1131) return [247 + ((n - 108) >> 8), (n - 108) & 255];
  if (n >= -1131 && n <= -108) return [251 + ((-n - 108) >> 8), (-n - 108) & 255];
  if (n >= -32768 && n <= 32767) return [28, ...u16(n)];
  return [29, ...u32(n)];
}
function cffReal(n: number): number[] {
  const digits = n.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
  const nibbles = [...digits].map(c => c === '.' ? 10 : c === '-' ? 14 : Number(c));
  nibbles.push(15); if (nibbles.length % 2) nibbles.push(15);
  return [30, ...Array.from({ length: nibbles.length / 2 }, (_, i) => nibbles[i * 2] * 16 + nibbles[i * 2 + 1])];
}
/** 본문 서체는 glyph가 수천 개라 CFF 조각을 number[] 대신 typed array로 이어 붙인다. */
function concat(parts: ReadonlyArray<ArrayLike<number>>): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
function cffIndex(items: ReadonlyArray<ArrayLike<number>>): Uint8Array {
  if (!items.length) return Uint8Array.of(0, 0);
  let total = 1;
  for (const item of items) total += item.length;
  const size = total <= 0xffff ? 2 : 4;
  const head = new Uint8Array(3 + (items.length + 1) * size);
  set16(head, 0, items.length); head[2] = size;
  let offset = 1;
  const writeOffset = (i: number): void => { if (size === 2) set16(head, 3 + i * 2, offset); else set32(head, 3 + i * 4, offset); };
  items.forEach((item, i) => { writeOffset(i); offset += item.length; });
  writeOffset(items.length);
  return concat([head, ...items]);
}
function charString(glyph: Glyph): Uint8Array {
  const out = cffInteger(glyph.advance);
  let x = 0; let y = 0;
  for (const command of glyph.outline) {
    if (command.op === 'close') continue; // Type 2 closes each contour at the next move/endchar.
    for (const [nx, ny] of command.points) {
      const dx = nx - x; const dy = ny - y;
      if (dx < -32768 || dx > 32767 || dy < -32768 || dy > 32767) throw new Error('HFT 상대 좌표 범위를 벗어났습니다.');
      out.push(...cffInteger(dx), ...cffInteger(dy)); x = nx; y = ny;
    }
    out.push(command.op === 'move' ? 21 : command.op === 'line' ? 5 : 8);
  }
  out.push(14);
  return Uint8Array.from(out);
}
function cffTable(font: HftFont, bbox: number[]): Uint8Array {
  const postscript = font.family.replace(/[^A-Za-z0-9_-]/g, '') || 'ImportedHFT';
  const names = cffIndex([ascii(postscript)]);
  const strings = cffIndex(font.glyphs.map((_, i) => ascii(`hft${i.toString(16)}`)));
  const charset = new Uint8Array(1 + font.glyphs.length * 2);
  font.glyphs.forEach((_, i) => set16(charset, 1 + i * 2, 391 + i));
  const chars = cffIndex([[14], ...font.glyphs.map(charString)]);
  // 고정 32-bit DICT offset으로 INDEX 크기가 offset 값에 의존하지 않는다.
  const dict = (charsetAt: number, charsAt: number, privateAt: number): number[] => [
    ...bbox.flatMap(cffInteger), 5,
    ...[1 / font.units, 0, 0, 1 / font.units, 0, 0].flatMap(cffReal), 12, 7,
    29, ...u32(charsetAt), 15, 29, ...u32(charsAt), 17,
    139, 29, ...u32(privateAt), 18,
  ];
  const prefixSize = 4 + names.length + cffIndex([dict(0, 0, 0)]).length + strings.length + 2;
  const top = cffIndex([dict(prefixSize, prefixSize + charset.length, prefixSize + charset.length + chars.length)]);
  return concat([[1, 0, 4, 4], names, top, strings, [0, 0], charset, chars]);
}

function unicodeEntries(glyphs: Glyph[]): Array<[number, number]> {
  const entries: Array<[number, number]> = [];
  const seen = new Set<number>();
  glyphs.forEach((glyph, i) => {
    // 빈 glyph는 fallback 글꼴에 넘긴다. 폭이 있는 space만 예외다.
    if (!drawable(glyph) && !(glyph.unicodes.includes(0x20) && glyph.advance > 0)) return;
    // 한자 중복 음(호환 한자)의 통합 한자 별칭이 앞 glyph와 겹치면 앞 glyph가 이긴다.
    for (const code of glyph.unicodes) if (!seen.has(code)) { seen.add(code); entries.push([code, i + 1]); }
  });
  return entries.sort((a, b) => a[0] - b[0]);
}
function cmapTable(glyphs: Glyph[]): Uint8Array {
  const entries = unicodeEntries(glyphs);
  const out = new Uint8Array(12 + 16 + entries.length * 12);
  out.set([0, 0, 0, 1, 0, 3, 0, 10]); set32(out, 8, 12);
  set16(out, 12, 12); set32(out, 16, 16 + entries.length * 12); set32(out, 24, entries.length);
  entries.forEach(([code, gid], i) => { set32(out, 28 + i * 12, code); set32(out, 32 + i * 12, code); set32(out, 36 + i * 12, gid); });
  return out;
}
function nameTable(font: HftFont): Uint8Array {
  const style = font.italic ? 'Italic' : 'Regular';
  const names: Array<[number, string]> = [[0, font.copyright], [1, font.family], [2, style],
    [3, `${font.family};HFT1.0`], [4, `${font.family} ${style}`], [5, 'Version 1.000'],
    [6, font.family.replace(/[^A-Za-z0-9_-]/g, '') || 'ImportedHFT']];
  const data: number[] = []; const records: number[] = [];
  for (const [id, name] of names) {
    const value = utf16(name);
    records.push(0, 3, 0, 1, 4, 9, ...u16(id), ...u16(value.length), ...u16(data.length)); data.push(...value);
  }
  return Uint8Array.from([0, 0, ...u16(names.length), ...u16(6 + records.length), ...records, ...data]);
}
function encodeOpenType(font: HftFont): Uint8Array {
  // 합친 본문 서체는 좌표가 수십만 개라 spread 인자로 min/max를 구하지 않는다.
  let bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const glyph of font.glyphs) {
    for (const command of glyph.outline) {
      for (const [x, y] of command.points) {
        bbox = [Math.min(bbox[0], x), Math.min(bbox[1], y), Math.max(bbox[2], x), Math.max(bbox[3], y)];
      }
    }
  }
  if (!Number.isFinite(bbox[0])) bbox = [0, 0, 0, 0];
  const ascent = font.units - font.baseline; const descent = -font.baseline;
  const count = font.glyphs.length + 1;
  const maxAdvance = font.glyphs.reduce((max, g) => Math.max(max, g.advance), 0);
  const head = new Uint8Array(54); set32(head, 0, 0x00010000); set32(head, 4, 0x00010000);
  set32(head, 12, 0x5f0f3cf5); set16(head, 16, 3); set16(head, 18, font.units);
  bbox.forEach((v, i) => set16(head, 36 + i * 2, v)); set16(head, 44, font.italic ? 2 : 0); set16(head, 46, 8);
  const hhea = new Uint8Array(36); set32(hhea, 0, 0x00010000);
  set16(hhea, 4, ascent); set16(hhea, 6, descent); set16(hhea, 10, maxAdvance);
  set16(hhea, 12, bbox[0]); set16(hhea, 14, Math.min(0, maxAdvance - bbox[2])); set16(hhea, 16, bbox[2]);
  set16(hhea, 18, 1); set16(hhea, 34, count);
  const hmtx = new Uint8Array(count * 4);
  font.glyphs.forEach((g, i) => {
    let lsb = Infinity;
    for (const command of g.outline) for (const [x] of command.points) lsb = Math.min(lsb, x);
    set16(hmtx, 4 + i * 4, g.advance); set16(hmtx, 6 + i * 4, Number.isFinite(lsb) ? lsb : 0);
  });
  const os2 = new Uint8Array(96); set16(os2, 0, 4); set16(os2, 2, Math.round(maxAdvance / 2));
  set16(os2, 4, 400); set16(os2, 6, 5); os2.set(ascii('RHWP'), 58); set16(os2, 62, font.italic ? 1 : 64);
  const codes = unicodeEntries(font.glyphs).map(e => e[0]); set16(os2, 64, codes[0] ?? 0); set16(os2, 66, Math.min(codes.at(-1) ?? 0, 0xffff));
  set16(os2, 68, ascent); set16(os2, 70, descent); set16(os2, 74, Math.max(ascent, bbox[3]));
  set16(os2, 76, Math.max(-descent, -bbox[1])); set16(os2, 86, Math.round(font.units * .5));
  set16(os2, 88, Math.round(font.units * .7)); set16(os2, 92, 32); set16(os2, 94, 1);
  const post = new Uint8Array(32); set32(post, 0, 0x00030000); set32(post, 4, font.italic ? -12 * 65536 : 0);
  set16(post, 8, -100); set16(post, 10, 50);
  const tables = new Map<string, Uint8Array>([
    ['CFF ', cffTable(font, bbox)], ['OS/2', os2], ['cmap', cmapTable(font.glyphs)], ['head', head],
    ['hhea', hhea], ['hmtx', hmtx], ['maxp', Uint8Array.from([...u32(0x5000), ...u16(count)])],
    ['name', nameTable(font)], ['post', post],
  ]);
  const sorted = [...tables].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  let offset = 12 + sorted.length * 16;
  const size = offset + sorted.reduce((sum, [, data]) => sum + ((data.length + 3) & ~3), 0);
  const result = new Uint8Array(size); result.set(ascii('OTTO')); set16(result, 4, sorted.length);
  const power = Math.floor(Math.log2(sorted.length)); set16(result, 6, 16 * 2 ** power); set16(result, 8, power);
  set16(result, 10, sorted.length * 16 - 16 * 2 ** power);
  let headOffset = 0;
  sorted.forEach(([tag, data], i) => {
    const record = 12 + i * 16; result.set(ascii(tag), record); set32(result, record + 4, checksum(data));
    set32(result, record + 8, offset); set32(result, record + 12, data.length); result.set(data, offset);
    if (tag === 'head') headOffset = offset;
    offset += (data.length + 3) & ~3;
  });
  set32(result, headOffset + 8, (0xb1b0afba - checksum(result)) >>> 0);
  return result;
}
