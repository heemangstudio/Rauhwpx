// WOFF / WOFF2 를 SFNT 로 되돌린다. 데스크톱(Node)과 브라우저 Worker 가 함께 쓴다.
// 압축 해제기는 호출부가 넣는다 (Node: node:zlib, 브라우저: DecompressionStream).
//   decompress.zlib(data, outLength)   WOFF 표 하나 (zlib 형식)
//   decompress.brotli(data, outLength) WOFF2 압축 스트림 전체
// 둘 다 outLength 바이트를 넘게 만들지 않아야 한다 (압축 폭탄 방지). 결과 길이가 다르면 거부한다.
//
// WOFF2 의 glyf/loca 변환과 hmtx 변환은 명세(W3C WOFF2 5.1~5.4) 그대로 되돌린다. 글리프 윤곽은
// 원본과 같은 점·명령·bbox 이고, 바이트 배치(플래그 반복 압축, 정렬)만 다를 수 있다.

const WOFF = 0x774f4646; // 'wOFF'
const WOFF2 = 0x774f4632; // 'wOF2'
const TTCF = 0x74746366;

/** 첫 4바이트로 웹 글꼴 형식을 판별한다. */
export function webFontKind(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const tag = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return tag === WOFF ? 'woff' : tag === WOFF2 ? 'woff2' : null;
}

/** 색인이 읽는 표. 색인 때는 이 표만 풀어 작은 SFNT 를 만든다. */
export const WEB_FONT_INDEX_TABLES = Object.freeze(['name', 'OS/2', 'head', 'cmap', 'fvar']);

// ---------------------------------------------------------------------------
// 바이트 판독기
// ---------------------------------------------------------------------------

function u16(bytes, at) {
  return (bytes[at] << 8) | bytes[at + 1];
}

function i16(bytes, at) {
  const value = u16(bytes, at);
  return value & 0x8000 ? value - 0x10000 : value;
}

function u32(bytes, at) {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function tagString(value) {
  return String.fromCharCode((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
}

function asReader(input) {
  if (input && typeof input.read === 'function' && Number.isFinite(input.size)) return input;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return {
    size: bytes.length,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > bytes.length) {
        throw new Error(`truncated read at ${offset}+${length} (size ${bytes.length})`);
      }
      return bytes.subarray(offset, offset + length);
    },
  };
}

class Cursor {
  constructor(bytes, offset = 0, end = bytes.length) {
    this.bytes = bytes;
    this.at = offset;
    this.end = end;
  }

  need(length) {
    if (this.at + length > this.end) throw new Error('woff2: truncated stream');
  }

  u8() {
    this.need(1);
    return this.bytes[this.at++];
  }

  u16() {
    this.need(2);
    const value = u16(this.bytes, this.at);
    this.at += 2;
    return value;
  }

  i16() {
    const value = this.u16();
    return value & 0x8000 ? value - 0x10000 : value;
  }

  u32() {
    this.need(4);
    const value = u32(this.bytes, this.at);
    this.at += 4;
    return value;
  }

  take(length) {
    this.need(length);
    const slice = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return slice;
  }

  base128() {
    let value = 0;
    for (let i = 0; i < 5; i += 1) {
      const byte = this.u8();
      if (i === 0 && byte === 0x80) throw new Error('woff2: UIntBase128 has a leading zero');
      if (value & 0xfe000000) throw new Error('woff2: UIntBase128 overflow');
      value = ((value << 7) | (byte & 0x7f)) >>> 0;
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('woff2: UIntBase128 is longer than 5 bytes');
  }

  u255() {
    const code = this.u8();
    if (code === 253) return this.u16();
    if (code === 255) return this.u8() + 253;
    if (code === 254) return this.u8() + 506;
    return code;
  }
}

// ---------------------------------------------------------------------------
// SFNT 쓰기
// ---------------------------------------------------------------------------

function pad4(length) {
  return (length + 3) & ~3;
}

function checksum(bytes) {
  let sum = 0;
  const whole = bytes.length - (bytes.length % 4);
  for (let i = 0; i < whole; i += 4) sum = (sum + u32(bytes, i)) >>> 0;
  if (whole < bytes.length) {
    const tail = new Uint8Array(4);
    tail.set(bytes.subarray(whole));
    sum = (sum + u32(tail, 0)) >>> 0;
  }
  return sum;
}

/** 표 목록(태그 → 바이트)을 태그 순 SFNT 로 묶고 체크섬을 다시 계산한다. */
function buildSfnt(flavor, tables, maxBytes) {
  const entries = [...tables.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const numTables = entries.length;
  const headerLength = 12 + numTables * 16;
  const total = headerLength + entries.reduce((sum, [, data]) => sum + pad4(data.length), 0);
  if (total > maxBytes) throw new Error(`too-large: decoded font is ${total} bytes (cap ${maxBytes})`);
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  let entrySelector = 0;
  while (2 ** (entrySelector + 1) <= numTables) entrySelector += 1;
  const searchRange = 2 ** entrySelector * 16;
  view.setUint32(0, flavor);
  view.setUint16(4, numTables);
  view.setUint16(6, searchRange);
  view.setUint16(8, entrySelector);
  view.setUint16(10, numTables * 16 - searchRange);
  let cursor = headerLength;
  let headAt = -1;
  entries.forEach(([tag, data], i) => {
    output.set(data, cursor);
    if (tag === 'head' && data.length >= 12) {
      view.setUint32(cursor + 8, 0);
      headAt = cursor;
    }
    const record = 12 + i * 16;
    for (let c = 0; c < 4; c += 1) output[record + c] = tag.charCodeAt(c) & 255;
    view.setUint32(record + 4, checksum(output.subarray(cursor, cursor + pad4(data.length))));
    view.setUint32(record + 8, cursor);
    view.setUint32(record + 12, data.length);
    cursor += pad4(data.length);
  });
  if (headAt >= 0) view.setUint32(headAt + 8, (0xb1b0afba - checksum(output)) >>> 0);
  return output;
}

async function decompressed(decoder, kind, data, outLength) {
  if (typeof decoder !== 'function') throw new Error(`unsupported: no ${kind} decoder for this font`);
  const result = await decoder(data, outLength);
  const bytes = result instanceof Uint8Array ? result : new Uint8Array(result);
  if (bytes.length !== outLength) {
    throw new Error(`${kind} stream decoded to ${bytes.length} bytes, expected ${outLength}`);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// WOFF 1
// ---------------------------------------------------------------------------

async function decodeWoff(source, { decompress, tables: wanted, maxBytes }) {
  const header = await source.read(0, 44);
  const flavor = u32(header, 4);
  if (flavor === TTCF) throw new Error('unsupported: WOFF font collections');
  const numTables = u16(header, 12);
  if (numTables === 0 || numTables > 512) throw new Error(`implausible table count ${numTables}`);
  const directory = await source.read(44, numTables * 20);
  const records = [];
  let total = 0;
  for (let i = 0; i < numTables; i += 1) {
    const at = i * 20;
    const record = {
      tag: tagString(u32(directory, at)),
      offset: u32(directory, at + 4),
      compLength: u32(directory, at + 8),
      origLength: u32(directory, at + 12),
    };
    if (record.offset + record.compLength > source.size) throw new Error(`woff: table ${record.tag} exceeds file size`);
    if (record.compLength > record.origLength) throw new Error(`woff: table ${record.tag} is larger compressed`);
    if (wanted && !wanted.has(record.tag)) continue;
    total += pad4(record.origLength);
    records.push(record);
  }
  // 풀기 전에 원래 크기 합으로 상한을 본다.
  if (total > maxBytes) throw new Error(`too-large: decoded font is ${total} bytes (cap ${maxBytes})`);
  const tables = new Map();
  for (const record of records) {
    const data = await source.read(record.offset, record.compLength);
    tables.set(record.tag, record.compLength === record.origLength
      ? data
      : await decompressed(decompress?.zlib, 'zlib', data, record.origLength));
  }
  return buildSfnt(flavor, tables, maxBytes);
}

// ---------------------------------------------------------------------------
// WOFF 2
// ---------------------------------------------------------------------------

const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep',
  'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE',
  'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt',
  'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar',
  'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

async function readWoff2Directory(source) {
  const header = await source.read(0, 48);
  const flavor = u32(header, 4);
  if (flavor === TTCF) throw new Error('unsupported: WOFF2 font collections');
  const numTables = u16(header, 12);
  if (numTables === 0 || numTables > 512) throw new Error(`implausible table count ${numTables}`);
  const totalCompressedSize = u32(header, 20);
  // 표 목록은 표마다 많아야 1 + 4 + 5 + 5 바이트다.
  const probe = await source.read(48, Math.min(source.size - 48, numTables * 15));
  const cursor = new Cursor(probe);
  const tables = [];
  let streamLength = 0;
  for (let i = 0; i < numTables; i += 1) {
    const flags = cursor.u8();
    const tag = (flags & 0x3f) === 0x3f ? tagString(cursor.u32()) : KNOWN_TAGS[flags & 0x3f];
    const version = flags >> 6;
    const origLength = cursor.base128();
    // glyf/loca 는 3 이 변환 없음, 나머지 표는 0 이 변환 없음이다.
    const transformed = tag === 'glyf' || tag === 'loca' ? version !== 3 : version !== 0;
    const transformLength = transformed ? cursor.base128() : origLength;
    if (transformed && tag !== 'glyf' && tag !== 'loca' && tag !== 'hmtx') {
      throw new Error(`woff2: unknown transform ${version} for ${tag}`);
    }
    if (tag === 'loca' && transformed && transformLength !== 0) throw new Error('woff2: transformed loca must be empty');
    tables.push({ tag, transformed, version, origLength, offset: streamLength, length: transformLength });
    streamLength += transformLength;
  }
  return { flavor, tables, streamOffset: 48 + cursor.at, totalCompressedSize, streamLength };
}

/** WOFF2 변환 glyf 를 표준 glyf/loca 로 되돌린다. xMins 는 hmtx 복원용 글리프별 xMin 이다. */
function reconstructGlyf(data, { indexFormat: headIndexFormat, maxBytes }) {
  const head = new Cursor(data);
  head.u16(); // reserved
  const optionFlags = head.u16();
  const numGlyphs = head.u16();
  const indexFormat = head.u16();
  if (indexFormat !== headIndexFormat) throw new Error('woff2: glyf index format differs from head');
  const sizes = Array.from({ length: 7 }, () => head.u32());
  let at = head.at;
  const streams = sizes.map((size) => {
    const stream = new Cursor(data, at, at + size);
    if (at + size > data.length) throw new Error('woff2: glyf substream exceeds table');
    at += size;
    return stream;
  });
  const [nContourStream, nPointsStream, flagStream, glyphStream, compositeStream, bboxStream, instructionStream] = streams;
  const bboxBitmapLength = 4 * Math.floor((numGlyphs + 31) / 32);
  const bboxBitmap = bboxStream.take(bboxBitmapLength);
  let overlapBitmap = null;
  if (optionFlags & 1) {
    const length = Math.floor((numGlyphs + 7) / 8);
    if (at + length > data.length) throw new Error('woff2: overlap bitmap exceeds table');
    overlapBitmap = data.subarray(at, at + length);
  }
  const hasBit = (bitmap, index) => (bitmap[index >> 3] & (0x80 >> (index & 7))) !== 0;

  const glyphs = new Array(numGlyphs);
  const xMins = new Int16Array(numGlyphs);
  let total = 0;
  for (let glyph = 0; glyph < numGlyphs; glyph += 1) {
    const nContours = nContourStream.i16();
    const explicitBox = hasBit(bboxBitmap, glyph);
    if (nContours === 0) {
      if (explicitBox) throw new Error('woff2: empty glyph has a bbox');
      glyphs[glyph] = null;
      continue;
    }
    let bytes;
    if (nContours === -1) {
      if (!explicitBox) throw new Error('woff2: composite glyph without bbox');
      const start = compositeStream.at;
      let flags;
      let instructions = false;
      do {
        flags = compositeStream.u16();
        compositeStream.u16(); // glyphIndex
        compositeStream.take(flags & 0x0001 ? 4 : 2);
        if (flags & 0x0008) compositeStream.take(2);
        else if (flags & 0x0040) compositeStream.take(4);
        else if (flags & 0x0080) compositeStream.take(8);
        if (flags & 0x0100) instructions = true;
      } while (flags & 0x0020);
      const components = compositeStream.bytes.subarray(start, compositeStream.at);
      const program = instructions ? instructionStream.take(glyphStream.u255()) : null;
      const box = bboxStream.take(8);
      bytes = new Uint8Array(10 + components.length + (program ? 2 + program.length : 0));
      bytes[0] = 0xff;
      bytes[1] = 0xff;
      bytes.set(box, 2);
      bytes.set(components, 10);
      if (program) {
        const end = 10 + components.length;
        bytes[end] = program.length >> 8;
        bytes[end + 1] = program.length & 255;
        bytes.set(program, end + 2);
      }
      xMins[glyph] = i16(box, 0);
    } else if (nContours > 0) {
      const endPoints = new Array(nContours);
      let points = 0;
      for (let c = 0; c < nContours; c += 1) {
        points += nPointsStream.u255();
        endPoints[c] = points - 1;
      }
      if (points > 0xffff) throw new Error('woff2: too many points in a glyph');
      const xs = new Int32Array(points);
      const ys = new Int32Array(points);
      const onCurve = new Uint8Array(points);
      let x = 0;
      let y = 0;
      for (let p = 0; p < points; p += 1) {
        const raw = flagStream.u8();
        onCurve[p] = raw & 0x80 ? 0 : 1;
        const flag = raw & 0x7f;
        const extra = flag < 84 ? 1 : flag < 120 ? 2 : flag < 124 ? 3 : 4;
        const b = glyphStream.take(extra);
        let dx;
        let dy;
        const sign = (bit, value) => (bit & 1 ? value : -value);
        if (flag < 10) {
          dx = 0;
          dy = sign(flag, ((flag & 14) << 7) + b[0]);
        } else if (flag < 20) {
          dx = sign(flag, (((flag - 10) & 14) << 7) + b[0]);
          dy = 0;
        } else if (flag < 84) {
          const b0 = flag - 20;
          dx = sign(flag, 1 + (b0 & 0x30) + (b[0] >> 4));
          dy = sign(flag >> 1, 1 + ((b0 & 0x0c) << 2) + (b[0] & 0x0f));
        } else if (flag < 120) {
          const b0 = flag - 84;
          dx = sign(flag, 1 + (Math.floor(b0 / 12) << 8) + b[0]);
          dy = sign(flag >> 1, 1 + (((b0 % 12) >> 2) << 8) + b[1]);
        } else if (flag < 124) {
          dx = sign(flag, (b[0] << 4) + (b[1] >> 4));
          dy = sign(flag >> 1, ((b[1] & 0x0f) << 8) + b[2]);
        } else {
          dx = sign(flag, (b[0] << 8) + b[1]);
          dy = sign(flag >> 1, (b[2] << 8) + b[3]);
        }
        x += dx;
        y += dy;
        xs[p] = x;
        ys[p] = y;
      }
      const program = instructionStream.take(glyphStream.u255());
      let box;
      if (explicitBox) {
        const raw = bboxStream.take(8);
        box = [i16(raw, 0), i16(raw, 2), i16(raw, 4), i16(raw, 6)];
      } else {
        box = [xs[0], ys[0], xs[0], ys[0]];
        for (let p = 1; p < points; p += 1) {
          if (xs[p] < box[0]) box[0] = xs[p];
          if (ys[p] < box[1]) box[1] = ys[p];
          if (xs[p] > box[2]) box[2] = xs[p];
          if (ys[p] > box[3]) box[3] = ys[p];
        }
      }
      bytes = encodeSimpleGlyph(nContours, endPoints, program, xs, ys, onCurve, box,
        overlapBitmap ? hasBit(overlapBitmap, glyph) : false);
      xMins[glyph] = box[0];
    } else {
      throw new Error(`woff2: invalid contour count ${nContours}`);
    }
    total += pad4(bytes.length);
    if (total > maxBytes) throw new Error(`too-large: decoded glyf exceeds ${maxBytes} bytes`);
    glyphs[glyph] = bytes;
  }

  const glyf = new Uint8Array(total);
  const loca = new Uint8Array((numGlyphs + 1) * (indexFormat ? 4 : 2));
  const locaView = new DataView(loca.buffer);
  let offset = 0;
  for (let glyph = 0; glyph <= numGlyphs; glyph += 1) {
    if (indexFormat) locaView.setUint32(glyph * 4, offset);
    else {
      if (offset / 2 > 0xffff) throw new Error('woff2: glyf too large for short loca');
      locaView.setUint16(glyph * 2, offset / 2);
    }
    const bytes = glyphs[glyph];
    if (!bytes) continue;
    glyf.set(bytes, offset);
    offset += pad4(bytes.length);
  }
  return { glyf, loca, numGlyphs, xMins };
}

function encodeSimpleGlyph(nContours, endPoints, program, xs, ys, onCurve, box, overlap) {
  const points = xs.length;
  const flags = new Uint8Array(points);
  let xLength = 0;
  let yLength = 0;
  let lastX = 0;
  let lastY = 0;
  for (let p = 0; p < points; p += 1) {
    let flag = onCurve[p];
    if (p === 0 && overlap) flag |= 0x40;
    const dx = xs[p] - lastX;
    const dy = ys[p] - lastY;
    if (dx === 0) flag |= 0x10;
    else if (dx > -256 && dx < 256) {
      flag |= 0x02 | (dx > 0 ? 0x10 : 0);
      xLength += 1;
    } else xLength += 2;
    if (dy === 0) flag |= 0x20;
    else if (dy > -256 && dy < 256) {
      flag |= 0x04 | (dy > 0 ? 0x20 : 0);
      yLength += 1;
    } else yLength += 2;
    flags[p] = flag;
    lastX = xs[p];
    lastY = ys[p];
  }
  const length = 10 + nContours * 2 + 2 + program.length + points + xLength + yLength;
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setInt16(0, nContours);
  box.forEach((value, i) => view.setInt16(2 + i * 2, value));
  let at = 10;
  for (const end of endPoints) {
    view.setUint16(at, end);
    at += 2;
  }
  view.setUint16(at, program.length);
  at += 2;
  bytes.set(program, at);
  at += program.length;
  bytes.set(flags, at);
  at += points;
  let xAt = at;
  let yAt = at + xLength;
  lastX = 0;
  lastY = 0;
  for (let p = 0; p < points; p += 1) {
    const dx = xs[p] - lastX;
    const dy = ys[p] - lastY;
    if (flags[p] & 0x02) bytes[xAt++] = Math.abs(dx);
    else if (!(flags[p] & 0x10)) {
      view.setInt16(xAt, dx);
      xAt += 2;
    }
    if (flags[p] & 0x04) bytes[yAt++] = Math.abs(dy);
    else if (!(flags[p] & 0x20)) {
      view.setInt16(yAt, dy);
      yAt += 2;
    }
    lastX = xs[p];
    lastY = ys[p];
  }
  return bytes;
}

/** WOFF2 변환 hmtx 를 되돌린다. 빠진 lsb 는 글리프 xMin 이다 (명세가 그렇게 정의한다). */
function reconstructHmtx(data, { numGlyphs, numberOfHMetrics, xMins }) {
  if (numberOfHMetrics < 1 || numberOfHMetrics > numGlyphs) throw new Error('woff2: bad numberOfHMetrics');
  const cursor = new Cursor(data);
  const flags = cursor.u8();
  if (flags & 0xfc) throw new Error('woff2: reserved hmtx flags are set');
  const advances = Array.from({ length: numberOfHMetrics }, () => cursor.u16());
  const lsbs = new Int16Array(numGlyphs);
  for (let glyph = 0; glyph < numberOfHMetrics; glyph += 1) lsbs[glyph] = flags & 1 ? xMins[glyph] : cursor.i16();
  for (let glyph = numberOfHMetrics; glyph < numGlyphs; glyph += 1) lsbs[glyph] = flags & 2 ? xMins[glyph] : cursor.i16();
  const output = new Uint8Array(numberOfHMetrics * 4 + (numGlyphs - numberOfHMetrics) * 2);
  const view = new DataView(output.buffer);
  for (let glyph = 0; glyph < numGlyphs; glyph += 1) {
    if (glyph < numberOfHMetrics) {
      view.setUint16(glyph * 4, advances[glyph]);
      view.setInt16(glyph * 4 + 2, lsbs[glyph]);
    } else {
      view.setInt16(numberOfHMetrics * 4 + (glyph - numberOfHMetrics) * 2, lsbs[glyph]);
    }
  }
  return output;
}

async function decodeWoff2(source, { decompress, tables: wanted, maxBytes }) {
  const directory = await readWoff2Directory(source);
  const { flavor, tables, streamOffset, totalCompressedSize, streamLength } = directory;
  if (streamOffset + totalCompressedSize > source.size) throw new Error('woff2: compressed stream exceeds file size');
  // 풀린 스트림 길이가 곧 출력 상한이다. 풀기 전에 막는다.
  if (streamLength > maxBytes) throw new Error(`too-large: WOFF2 stream is ${streamLength} bytes (cap ${maxBytes})`);
  const stream = await decompressed(
    decompress?.brotli,
    'brotli',
    await source.read(streamOffset, totalCompressedSize),
    streamLength,
  );
  const raw = new Map(tables.map((table) => [table.tag, { ...table, data: stream.subarray(table.offset, table.offset + table.length) }]));
  const output = new Map();
  for (const table of raw.values()) {
    if (table.transformed || (wanted && !wanted.has(table.tag))) continue;
    output.set(table.tag, table.data);
  }
  const needsGlyf = !wanted || wanted.has('glyf') || wanted.has('loca') || wanted.has('hmtx');
  const glyfTable = raw.get('glyf');
  let xMins = null;
  let numGlyphs = 0;
  if (glyfTable?.transformed && needsGlyf) {
    const head = raw.get('head')?.data;
    if (!head || head.length < 54) throw new Error('woff2: head table is missing');
    if (!raw.get('loca')?.transformed) throw new Error('woff2: transformed glyf needs a transformed loca');
    const rebuilt = reconstructGlyf(glyfTable.data, { indexFormat: i16(head, 50), maxBytes });
    if (!wanted || wanted.has('glyf')) output.set('glyf', rebuilt.glyf);
    if (!wanted || wanted.has('loca')) output.set('loca', rebuilt.loca);
    ({ xMins, numGlyphs } = rebuilt);
  }
  const hmtxTable = raw.get('hmtx');
  if (hmtxTable?.transformed && (!wanted || wanted.has('hmtx'))) {
    const hhea = raw.get('hhea')?.data;
    const maxp = raw.get('maxp')?.data;
    if (!hhea || hhea.length < 36 || !maxp || maxp.length < 6) throw new Error('woff2: hhea or maxp is missing');
    if (!xMins) throw new Error('woff2: transformed hmtx needs a glyf table');
    if (u16(maxp, 4) !== numGlyphs) throw new Error('woff2: maxp and glyf disagree on glyph count');
    output.set('hmtx', reconstructHmtx(hmtxTable.data, { numGlyphs, numberOfHMetrics: u16(hhea, 34), xMins }));
  }
  return buildSfnt(flavor, output, maxBytes);
}

/**
 * WOFF/WOFF2 원본을 SFNT 바이트로 되돌린다.
 * @param {Uint8Array | { size: number, read(offset: number, length: number): Promise<Uint8Array> }} input
 * @param {{ decompress?: { zlib?: Function, brotli?: Function }, tables?: Iterable<string> | null, maxBytes: number }} options
 *   tables 를 주면 그 표만 담는다 (색인용). maxBytes 는 풀린 크기 상한이다.
 */
export async function decodeWebFont(input, { decompress, tables = null, maxBytes }) {
  const source = asReader(input);
  if (source.size < 48) throw new Error('file too small to be a web font');
  const kind = webFontKind(await source.read(0, 4));
  if (!kind) throw new Error('not a WOFF or WOFF2 font');
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('decodeWebFont needs maxBytes');
  const options = { decompress, tables: tables ? new Set(tables) : null, maxBytes };
  return kind === 'woff' ? decodeWoff(source, options) : decodeWoff2(source, options);
}

// ---------------------------------------------------------------------------
// 브라우저 압축 해제기
// ---------------------------------------------------------------------------

function streamFormatSupported(format) {
  if (typeof DecompressionStream === 'undefined') return false;
  try {
    new DecompressionStream(format);
    return true;
  } catch {
    return false;
  }
}

/** DecompressionStream 으로 풀되 outLength 를 넘으면 끊는다. */
function streamDecoder(format) {
  return async (data, outLength) => {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format));
    const reader = stream.getReader();
    const output = new Uint8Array(outLength);
    let filled = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (filled + value.length > outLength) throw new Error(`${format} stream is longer than ${outLength} bytes`);
        output.set(value, filled);
        filled += value.length;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    return filled === outLength ? output : output.subarray(0, filled);
  };
}

/**
 * 브라우저에서 쓸 수 있는 압축 해제기. WOFF 는 'deflate'(zlib) 를 쓰고, 'brotli' 를 모르는
 * 브라우저에서는 WOFF2 를 읽지 않는다 (brotli 디코더를 따로 싣지 않는다).
 */
export function streamWebFontDecoders() {
  return {
    ...(streamFormatSupported('deflate') ? { zlib: streamDecoder('deflate') } : {}),
    ...(streamFormatSupported('brotli') ? { brotli: streamDecoder('brotli') } : {}),
  };
}
