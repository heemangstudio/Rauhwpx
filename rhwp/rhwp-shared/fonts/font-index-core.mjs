// 글꼴 색인의 플랫폼 중립 부분. 데스크톱(Node)과 브라우저 Worker가 함께 쓴다.
// node: 모듈을 쓰지 않고 `{ size, read(offset, length) → Promise<Uint8Array> }` 원본만 다룬다.
// 파일 시스템 탐색·캐시·파일 열기는 호출부가 맡는다.

export const SYSTEM_FONT_INDEX_VERSION = 1;
export const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc', '.hft']);
export const FONT_SCAN_LIMITS = Object.freeze({ maxDepth: 6, maxFiles: 20_000, maxDirs: 20_000 });
export const MAX_FACE_BYTES = 48 * 1024 * 1024;
export const MAX_TABLE_READ = 8 * 1024 * 1024;
export const HEAD_CHUNK = 64 * 1024;
export const HANCOM_MAP_FILE = /^(hftinfo\.dat|fontlist\.lst|privatefontlist[^\\/]*\.ini)$/i;
export const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;
export const KIND_ORDER = Object.freeze({ hancom: 0, user: 1, system: 2 });
const HFT_MAGIC = Uint8Array.from('Han Unified Font File 1.0\x1a', (char) => char.charCodeAt(0));
const SFNT_VERSIONS = new Set([0x00010000, 0x4f54544f /* OTTO */, 0x74727565 /* true */]);
const TTCF = 0x74746366;
const NAME_IDS = [1, 2, 4, 6, 16, 17];

// ---------------------------------------------------------------------------
// 바이트 판독기
// ---------------------------------------------------------------------------

function dataView(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function i16(bytes, offset) {
  const value = u16(bytes, offset);
  return value & 0x8000 ? value - 0x10000 : value;
}

function u32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function checkRange(offset, length, size) {
  if (offset < 0 || length < 0 || offset + length > size) {
    throw new Error(`truncated read at ${offset}+${length} (size ${size})`);
  }
}

/** 메모리의 바이트 배열을 원본으로 감싼다. */
export class BytesSource {
  constructor(bytes) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.size = this.bytes.length;
  }

  async read(offset, length) {
    checkRange(offset, length, this.size);
    return this.bytes.subarray(offset, offset + length);
  }
}

/**
 * 임의 위치 읽기 함수를 원본으로 감싼다. 헤더·테이블 목록이 모여 있는 앞부분은
 * 한 번에 읽어 두고 재사용한다.
 * @param {number} size
 * @param {(offset: number, length: number) => Promise<Uint8Array>} readAt
 */
export function createReadSource(size, readAt) {
  let head = null;
  return {
    size,
    async read(offset, length) {
      checkRange(offset, length, size);
      if (!head) head = await readAt(0, Math.min(size, HEAD_CHUNK));
      if (offset + length <= head.length) return head.subarray(offset, offset + length);
      return readAt(offset, length);
    },
  };
}

/** Blob/File 을 원본으로 감싼다. 브라우저와 Node 모두 Blob.slice 를 쓴다. */
export function blobSource(blob) {
  return createReadSource(blob.size, async (offset, length) => {
    const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    if (bytes.length !== length) throw new Error(`unexpected end of file at ${offset + bytes.length}`);
    return bytes;
  });
}

function asSource(input) {
  if (input && typeof input.read === 'function' && Number.isFinite(input.size)) return input;
  return new BytesSource(input);
}

// ---------------------------------------------------------------------------
// SFNT 파싱
// ---------------------------------------------------------------------------

function tagString(value) {
  return String.fromCharCode((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
}

export async function readTableDirectory(source, faceOffset) {
  const header = await source.read(faceOffset, 12);
  const sfntVersion = u32(header, 0);
  if (!SFNT_VERSIONS.has(sfntVersion)) {
    throw new Error(`unsupported sfnt version 0x${sfntVersion.toString(16)} at ${faceOffset}`);
  }
  const numTables = u16(header, 4);
  if (numTables === 0 || numTables > 512) throw new Error(`implausible table count ${numTables}`);
  const records = await source.read(faceOffset + 12, numTables * 16);
  const tables = new Map();
  for (let i = 0; i < numTables; i += 1) {
    const base = i * 16;
    const tag = tagString(u32(records, base));
    const offset = u32(records, base + 8);
    const length = u32(records, base + 12);
    if (offset + length > source.size) throw new Error(`table ${tag} exceeds file size`);
    tables.set(tag, { tag, checksum: u32(records, base + 4), offset, length });
  }
  return { sfntVersion, tables };
}

/** 컬렉션이면 각 서브폰트의 오프셋 표 위치를, 단일 폰트면 [0] 을 돌려준다. */
export async function faceOffsets(source) {
  const head = await source.read(0, 12);
  if (u32(head, 0) !== TTCF) return { collection: false, offsets: [0] };
  const numFonts = u32(head, 8);
  if (numFonts === 0 || numFonts > 1024) throw new Error(`implausible collection size ${numFonts}`);
  const list = await source.read(12, numFonts * 4);
  const offsets = [];
  for (let i = 0; i < numFonts; i += 1) offsets.push(u32(list, i * 4));
  return { collection: true, offsets };
}

const decoders = new Map();
function decoderFor(label) {
  if (!decoders.has(label)) {
    let decoder = null;
    try {
      decoder = new TextDecoder(label, { fatal: false });
    } catch {
      decoder = null;
    }
    decoders.set(label, decoder);
  }
  return decoders.get(label);
}

const WINDOWS_LEGACY_ENCODINGS = { 2: 'shift_jis', 3: 'gbk', 4: 'big5', 5: 'euc-kr' };
const MAC_ENCODINGS = { 0: 'macintosh', 1: 'shift_jis', 2: 'big5', 3: 'euc-kr', 25: 'gbk' };

/** UTF-16 코드 단위를 그대로 문자열로 옮긴다 (홀수 끝 바이트는 버린다). */
function utf16(bytes, littleEndian) {
  const units = Math.floor(bytes.length / 2);
  let text = '';
  const chunk = [];
  for (let i = 0; i < units; i += 1) {
    const at = i * 2;
    chunk.push(littleEndian ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1]);
    if (chunk.length === 4096) {
      text += String.fromCharCode(...chunk);
      chunk.length = 0;
    }
  }
  if (chunk.length) text += String.fromCharCode(...chunk);
  return text;
}

/** name 레코드 하나를 문자열로 푼다. 해석할 수 없는 인코딩이면 null. */
export function decodeNameRecord(platformId, encodingId, bytes) {
  if (platformId === 0 || (platformId === 3 && (encodingId === 0 || encodingId === 1 || encodingId === 10))) {
    return utf16(bytes, false);
  }
  if (platformId === 3) {
    const label = WINDOWS_LEGACY_ENCODINGS[encodingId];
    if (!label) return null;
    // 구형 윈도우 CJK 폰트는 2바이트 단위로 저장해 1바이트 문자 앞에 0x00 을 끼운다.
    const packed = Uint8Array.from(bytes.filter((byte) => byte !== 0));
    return decoderFor(label)?.decode(packed) ?? null;
  }
  if (platformId === 1) {
    const label = MAC_ENCODINGS[encodingId];
    if (!label) return null;
    return decoderFor(label)?.decode(bytes) ?? null;
  }
  return null;
}

function isKoreanRecord(record) {
  return (record.platformId === 3 && record.languageId === 0x0412)
    || (record.platformId === 1 && (record.languageId === 23 || record.encodingId === 3));
}

function recordRank(record) {
  if (record.platformId === 3 && record.languageId === 0x0409) return 0;
  if (record.platformId === 1 && record.languageId === 0) return 1;
  if (isKoreanRecord(record)) return 2;
  if (record.platformId === 0) return 3;
  return 4;
}

function cleanName(text) {
  return typeof text === 'string' ? text.replace(/\u0000/g, '').trim() : '';
}

export function parseNameTable(bytes) {
  const records = [];
  let undecodable = 0;
  if (bytes.length < 6) return { records, undecodable };
  const count = u16(bytes, 2);
  const stringOffset = u16(bytes, 4);
  for (let i = 0; i < count; i += 1) {
    const base = 6 + i * 12;
    if (base + 12 > bytes.length) break;
    const platformId = u16(bytes, base);
    const encodingId = u16(bytes, base + 2);
    const languageId = u16(bytes, base + 4);
    const nameId = u16(bytes, base + 6);
    if (!NAME_IDS.includes(nameId)) continue;
    const length = u16(bytes, base + 8);
    const start = stringOffset + u16(bytes, base + 10);
    if (start + length > bytes.length) continue;
    const text = cleanName(decodeNameRecord(platformId, encodingId, bytes.subarray(start, start + length)));
    if (!text) {
      undecodable += 1;
      continue;
    }
    records.push({ platformId, encodingId, languageId, nameId, text });
  }
  return { records, undecodable };
}

function namesFor(records, nameId) {
  const picked = records
    .filter((record) => record.nameId === nameId)
    .map((record, order) => ({ record, order, rank: recordRank(record) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(({ record }) => record.text);
  return uniqueStrings(picked);
}

export function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = cleanName(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function koreanNamesFrom(records) {
  return uniqueStrings(records
    .filter((record) => [1, 4, 16].includes(record.nameId))
    .filter((record) => isKoreanRecord(record) || HANGUL.test(record.text))
    .sort((a, b) => [16, 1, 4].indexOf(a.nameId) - [16, 1, 4].indexOf(b.nameId))
    .map((record) => record.text));
}

async function readTable(source, table, maxLength = MAX_TABLE_READ) {
  if (!table) return null;
  return source.read(table.offset, Math.min(table.length, maxLength));
}

function lookupCmapSubtable(bytes, codepoint) {
  const format = u16(bytes, 0);
  if (format === 0) {
    return codepoint < 256 && bytes.length >= 262 ? bytes[6 + codepoint] : 0;
  }
  if (format === 4) {
    const segCount = u16(bytes, 6) / 2;
    const endBase = 14;
    const startBase = endBase + segCount * 2 + 2;
    const deltaBase = startBase + segCount * 2;
    const rangeBase = deltaBase + segCount * 2;
    if (rangeBase + segCount * 2 > bytes.length) return 0;
    for (let i = 0; i < segCount; i += 1) {
      const end = u16(bytes, endBase + i * 2);
      if (codepoint > end) continue;
      const start = u16(bytes, startBase + i * 2);
      if (codepoint < start) return 0;
      const delta = i16(bytes, deltaBase + i * 2);
      const rangeOffset = u16(bytes, rangeBase + i * 2);
      if (rangeOffset === 0) return (codepoint + delta) & 0xffff;
      const glyphAt = rangeBase + i * 2 + rangeOffset + (codepoint - start) * 2;
      if (glyphAt + 2 > bytes.length) return 0;
      const glyph = u16(bytes, glyphAt);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  }
  if (format === 6) {
    const first = u16(bytes, 6);
    const count = u16(bytes, 8);
    const index = codepoint - first;
    return index >= 0 && index < count && 10 + index * 2 + 2 <= bytes.length
      ? u16(bytes, 10 + index * 2)
      : 0;
  }
  if (format === 12 || format === 13) {
    const groups = u32(bytes, 12);
    let lo = 0;
    let hi = Math.min(groups, Math.floor((bytes.length - 16) / 12)) - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const base = 16 + mid * 12;
      const start = u32(bytes, base);
      const end = u32(bytes, base + 4);
      if (codepoint < start) hi = mid - 1;
      else if (codepoint > end) lo = mid + 1;
      else {
        const glyph = u32(bytes, base + 8);
        return format === 12 ? glyph + (codepoint - start) : glyph;
      }
    }
    return 0;
  }
  return 0;
}

async function readCmapSubtable(source, cmapOffset, subOffset, cache) {
  const at = cmapOffset + subOffset;
  if (cache.has(at)) return cache.get(at);
  if (at + 8 > source.size) return null;
  const probe = await source.read(at, 8);
  const format = u16(probe, 0);
  let length;
  if (format === 0 || format === 4 || format === 6) length = u16(probe, 2);
  else if (format === 12 || format === 13) length = u32(probe, 4);
  else length = 0;
  let bytes = null;
  if (length >= 8 && length <= MAX_TABLE_READ && at + length <= source.size) {
    bytes = await source.read(at, length);
  }
  cache.set(at, bytes);
  return bytes;
}

async function cmapCoverage(source, table, cache) {
  const result = { hangul: false, latin: false };
  if (!table || table.length < 4) return result;
  const header = await source.read(table.offset, Math.min(table.length, 4 + 8 * 64));
  const numTables = u16(header, 2);
  const unicode = [];
  const macRoman = [];
  for (let i = 0; i < numTables; i += 1) {
    const base = 4 + i * 8;
    if (base + 8 > header.length) break;
    const platformId = u16(header, base);
    const encodingId = u16(header, base + 2);
    const offset = u32(header, base + 4);
    if (offset >= table.length) continue;
    if (platformId === 0 || (platformId === 3 && (encodingId === 1 || encodingId === 10))) unicode.push(offset);
    else if (platformId === 1 && encodingId === 0) macRoman.push(offset);
  }
  for (const offset of unicode) {
    const bytes = await readCmapSubtable(source, table.offset, offset, cache);
    if (!bytes) continue;
    if (!result.hangul && lookupCmapSubtable(bytes, 0xac00) !== 0) result.hangul = true;
    if (!result.latin && lookupCmapSubtable(bytes, 0x41) !== 0) result.latin = true;
    if (result.hangul && result.latin) break;
  }
  if (!result.latin) {
    for (const offset of macRoman) {
      const bytes = await readCmapSubtable(source, table.offset, offset, cache);
      if (bytes && lookupCmapSubtable(bytes, 0x41) !== 0) {
        result.latin = true;
        break;
      }
    }
  }
  return result;
}

/**
 * SFNT/TTC 헤더에서 면(face)별 메타데이터를 읽는다.
 * 반환 항목은 id/경로/출처가 빠진 원시 정보다.
 * @param {Uint8Array | { size: number, read(offset: number, length: number): Promise<Uint8Array> }} input
 */
export async function parseSfntFaces(input) {
  const source = asSource(input);
  const { collection, offsets } = await faceOffsets(source);
  const cmapCache = new Map();
  const nameCache = new Map();
  const faces = [];
  let undecodable = 0;
  for (let faceIndex = 0; faceIndex < offsets.length; faceIndex += 1) {
    const { sfntVersion, tables } = await readTableDirectory(source, offsets[faceIndex]);
    const nameTable = tables.get('name');
    let parsedNames = { records: [], undecodable: 0 };
    if (nameTable) {
      const key = `${nameTable.offset}:${nameTable.length}`;
      if (!nameCache.has(key)) nameCache.set(key, parseNameTable(await readTable(source, nameTable)));
      parsedNames = nameCache.get(key);
    }
    undecodable += parsedNames.undecodable;
    const os2 = await readTable(source, tables.get('OS/2'), 64);
    const head = await readTable(source, tables.get('head'), 54);
    const macStyle = head && head.length >= 46 ? u16(head, 44) : 0;
    const fsSelection = os2 && os2.length >= 64 ? u16(os2, 62) : 0;
    let weight = os2 && os2.length >= 6 ? u16(os2, 4) : 0;
    if (weight > 0 && weight < 10) weight *= 100;
    if (!weight) weight = macStyle & 1 ? 700 : 400;
    let coverage = { hangul: false, latin: false };
    try {
      coverage = await cmapCoverage(source, tables.get('cmap'), cmapCache);
    } catch {
      // 깨진 cmap 은 커버리지 없음으로 둔다. 이름 정보는 그대로 쓴다.
    }
    const { records } = parsedNames;
    faces.push({
      faceIndex,
      format: collection
        ? (sfntVersion === 0x4f54544f ? 'otc' : 'ttc')
        : (sfntVersion === 0x4f54544f ? 'otf' : 'ttf'),
      families: namesFor(records, 1),
      fullNames: namesFor(records, 4),
      postscriptNames: namesFor(records, 6),
      styles: namesFor(records, 2),
      typographicFamilies: namesFor(records, 16),
      typographicStyles: namesFor(records, 17),
      koreanNames: koreanNamesFrom(records),
      weight,
      italic: Boolean(fsSelection & 1) || Boolean(macStyle & 2),
      bold: Boolean(fsSelection & 32) || Boolean(macStyle & 1),
      hangul: coverage.hangul,
      latin: coverage.latin,
    });
  }
  return { collection, faces, undecodable };
}

/**
 * 글꼴 파일 하나를 판별하고 면 정보를 읽는다. HFT 는 서명만 확인한다.
 * @returns {Promise<{ type: 'hft' | 'sfnt', faces: object[], undecodable?: number }>}
 */
export async function parseFontSource(input, fileName) {
  const source = asSource(input);
  if (source.size < 12) throw new Error('file too small to be a font');
  const magic = await source.read(0, Math.min(source.size, HFT_MAGIC.length));
  if (magic.length === HFT_MAGIC.length && magic.every((byte, i) => byte === HFT_MAGIC[i])) {
    return { type: 'hft', faces: [] };
  }
  if (/\.hft$/i.test(fileName ?? '')) throw new Error('missing HFT signature');
  const parsed = await parseSfntFaces(source);
  return { type: 'sfnt', faces: parsed.faces, undecodable: parsed.undecodable };
}

// ---------------------------------------------------------------------------
// TTC/OTC 서브폰트 추출
// ---------------------------------------------------------------------------

function pad4(length) {
  return (length + 3) & ~3;
}

function sfntChecksum(bytes) {
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

/**
 * 컬렉션의 faceIndex 번째 서브폰트를 독립 SFNT 로 재조립한다.
 * 브라우저 FontFace 는 컬렉션의 첫 면만 올리기 때문이다.
 * DSIG 는 재조립하면 서명이 깨지므로 뺀다.
 * @returns {Promise<Uint8Array>}
 */
export async function extractCollectionFace(input, faceIndex, { maxBytes = MAX_FACE_BYTES } = {}) {
  const source = asSource(input);
  const { collection, offsets } = await faceOffsets(source);
  if (!collection) throw new Error('not a font collection');
  if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= offsets.length) {
    throw new Error(`face index ${faceIndex} out of range (0..${offsets.length - 1})`);
  }
  const { sfntVersion, tables } = await readTableDirectory(source, offsets[faceIndex]);
  const entries = [...tables.values()]
    .filter((table) => table.tag !== 'DSIG')
    .sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const numTables = entries.length;
  const headerLength = 12 + numTables * 16;
  const total = headerLength + entries.reduce((sum, table) => sum + pad4(table.length), 0);
  if (total > maxBytes) throw new Error(`too-large: extracted face is ${total} bytes (cap ${maxBytes})`);
  const output = new Uint8Array(total);
  const view = dataView(output);
  let entrySelector = 0;
  while (2 ** (entrySelector + 1) <= numTables) entrySelector += 1;
  const searchRange = 2 ** entrySelector * 16;
  view.setUint32(0, sfntVersion);
  view.setUint16(4, numTables);
  view.setUint16(6, searchRange);
  view.setUint16(8, entrySelector);
  view.setUint16(10, numTables * 16 - searchRange);
  let cursor = headerLength;
  let headAt = -1;
  for (let i = 0; i < numTables; i += 1) {
    const table = entries[i];
    const data = await source.read(table.offset, table.length);
    output.set(data, cursor);
    const padded = output.subarray(cursor, cursor + pad4(table.length));
    if (table.tag === 'head') {
      if (table.length < 12) throw new Error('head table is truncated');
      view.setUint32(cursor + 8, 0);
      headAt = cursor;
    }
    const record = 12 + i * 16;
    for (let c = 0; c < 4; c += 1) output[record + c] = table.tag.charCodeAt(c) & 255;
    view.setUint32(record + 4, sfntChecksum(padded));
    view.setUint32(record + 8, cursor);
    view.setUint32(record + 12, table.length);
    cursor += pad4(table.length);
  }
  if (headAt >= 0) {
    view.setUint32(headAt + 8, (0xb1b0afba - sfntChecksum(output)) >>> 0);
  }
  return output;
}

// ---------------------------------------------------------------------------
// 한컴 폰트 목록 파일
// ---------------------------------------------------------------------------

/** 한컴 목록 파일(UTF-16LE, BOM 이 FFFE 또는 FFFF) 을 문자열로 푼다. */
export function decodeHancomText(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return utf16(bytes.subarray(2), false);
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] === 0xfe || bytes[1] === 0xff)) {
    return utf16(bytes.subarray(2), true);
  }
  let oddZeros = 0;
  const sample = Math.min(bytes.length, 512);
  for (let i = 1; i < sample; i += 2) if (bytes[i] === 0) oddZeros += 1;
  if (sample > 8 && oddZeros > sample / 4) return utf16(bytes, true);
  return new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
}

/**
 * 한컴 목록 파일에서 글꼴 이름 → 파일 대응을 뽑는다.
 * - hftinfo.dat:  [Font Definition - <문자군>] 이름=FILE.HFT,,,,제작사,1033,영문이름
 * - FontList.lst: [Font List] 이름=file.hft,<문자군>   (사용자가 추가한 HFT)
 * - PrivateFontList*.ini: [All]/[Hwp] 이름=FILE.TTF    (한컴 번들 TTF 의 표시 이름)
 * 파일 확장자가 폰트가 아닌 줄은 무시한다.
 */
export function parseHancomFontList(text) {
  const entries = [];
  let section = '';
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/^﻿/, '').trim();
    if (!line || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const name = line.slice(0, equals).trim();
    const parts = line.slice(equals + 1).split(',').map((part) => part.trim());
    const file = parts[0];
    if (!name || !/\.(hft|ttf|otf|ttc|otc)$/i.test(file ?? '')) continue;
    const definition = /^font definition\s*-\s*(.+)$/i.exec(section);
    let script;
    if (definition) script = definition[1].trim();
    else if (/^font list$/i.test(section)) script = parts[1] || '';
    else script = section;
    entries.push({ name, file, script });
    const englishName = definition ? parts[6] : '';
    if (englishName && englishName !== name) entries.push({ name: englishName, file, script });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 색인 조립
// ---------------------------------------------------------------------------

export function pathKey(target, platform) {
  return platform === 'win32' ? target.toLowerCase() : target;
}

/** 브라우저 폴더처럼 '/' 로 구분한 상대 경로용 최소 path API. */
export const posixPath = Object.freeze({
  basename(target, ext) {
    const base = String(target).replace(/\/+$/, '').split('/').pop() ?? '';
    return ext && base.endsWith(ext) && base !== ext ? base.slice(0, -ext.length) : base;
  },
  dirname(target) {
    const trimmed = String(target).replace(/\/+$/, '');
    const at = trimmed.lastIndexOf('/');
    if (at < 0) return '.';
    return at === 0 ? '/' : trimmed.slice(0, at);
  },
  extname(target) {
    const base = posixPath.basename(target);
    const at = base.lastIndexOf('.');
    return at <= 0 ? '' : base.slice(at);
  },
  join(...parts) {
    return parts.filter((part) => part !== '').join('/').replace(/\/{2,}/g, '/') || '.';
  },
});

export function commonPrefixLength(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

export function sortFaces(faces) {
  return faces.sort((a, b) => (KIND_ORDER[a.source] - KIND_ORDER[b.source])
    || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    || a.faceIndex - b.faceIndex);
}

function cloneFaceNames(raw) {
  return {
    families: [...raw.families],
    fullNames: [...raw.fullNames],
    postscriptNames: [...raw.postscriptNames],
    styles: [...raw.styles],
    typographicFamilies: [...raw.typographicFamilies],
    typographicStyles: [...raw.typographicStyles],
    koreanNames: [...raw.koreanNames],
  };
}

/**
 * 파일별 파싱 결과와 한컴 목록 파일로 색인 face 목록을 만든다.
 *
 * @param {{
 *   parsedFiles: Array<{ file: { path: string, realPath: string, size: number, mtimeMs: number, kind: 'system'|'user'|'hancom' },
 *     result: { type: string, faces: object[], error?: string } }>,
 *   mapFiles: string[],
 *   readMapFile: (path: string) => Promise<Uint8Array>,
 *   faceId: (file: object, faceIndex: number) => string,
 *   pathApi: { basename: Function, dirname: Function, join: Function, extname: Function },
 *   platform: string,
 *   errors: Array<{ path: string, message: string }>,
 * }} input
 */
export async function assembleFontIndex({ parsedFiles, mapFiles, readMapFile, faceId, pathApi, platform, errors }) {
  const faces = [];
  const hftFiles = [];
  const byId = new Map();
  for (const { file, result } of parsedFiles) {
    if (result.error) {
      errors.push({ path: file.path, message: result.error });
      continue;
    }
    if (result.type === 'hft') {
      hftFiles.push(file);
      continue;
    }
    for (const raw of result.faces) {
      const face = {
        id: faceId(file, raw.faceIndex),
        path: file.path,
        faceIndex: raw.faceIndex,
        format: raw.format,
        source: file.kind,
        size: file.size,
        ...cloneFaceNames(raw),
        weight: raw.weight,
        italic: raw.italic,
        bold: raw.bold,
        hangul: raw.hangul,
        latin: raw.latin,
      };
      faces.push(face);
      byId.set(face.id, { face, file });
    }
  }

  const { hancomFaceMap, hftFaces, mapStats } = await buildHancomMaps({
    mapFiles,
    readMapFile,
    hftFiles,
    faces,
    byId,
    errors,
    faceId,
    pathApi,
    platform,
  });
  faces.push(...hftFaces);
  sortFaces(faces);
  return { faces, byId, hancomFaceMap, hftFiles, mapStats };
}

async function buildHancomMaps({ mapFiles, readMapFile, hftFiles, faces, byId, errors, faceId, pathApi, platform }) {
  const hancomFaces = new Map(); // 소문자 파일명 → face[]
  for (const face of faces) {
    if (face.source !== 'hancom' || face.faceIndex !== 0) continue;
    const key = pathApi.basename(face.path).toLowerCase();
    if (!hancomFaces.has(key)) hancomFaces.set(key, []);
    hancomFaces.get(key).push(face);
  }
  const hftByName = new Map();
  for (const file of hftFiles) {
    const key = pathApi.basename(file.path).toLowerCase();
    if (!hftByName.has(key)) hftByName.set(key, []);
    hftByName.get(key).push(file);
  }
  const closest = (candidates, mapFile, getPath) => {
    if (!candidates?.length) return null;
    const mapDir = pathKey(pathApi.dirname(mapFile), platform);
    return candidates.reduce((best, item) => (
      commonPrefixLength(pathKey(getPath(item), platform), mapDir)
        > commonPrefixLength(pathKey(getPath(best), platform), mapDir) ? item : best
    ));
  };

  const hancomFaceMap = [];
  const hftNames = new Map(); // HFT realPath → { file, entries[] }
  const seen = new Set();
  let entries = 0;
  let resolved = 0;
  let unresolved = 0;
  for (const mapFile of [...mapFiles].sort()) {
    let parsed;
    try {
      parsed = parseHancomFontList(decodeHancomText(await readMapFile(mapFile)));
    } catch (error) {
      errors.push({ path: mapFile, message: `hancom font list unreadable: ${error.message}` });
      continue;
    }
    for (const entry of parsed) {
      const key = `${entry.name}\u0000${entry.file.toLowerCase()}\u0000${entry.script}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries += 1;
      const fileKey = entry.file.toLowerCase();
      let id = null;
      if (fileKey.endsWith('.hft')) {
        const file = closest(hftByName.get(fileKey), mapFile, (item) => item.path);
        if (file) {
          const bucketKey = pathKey(file.realPath, platform);
          if (!hftNames.has(bucketKey)) hftNames.set(bucketKey, { file, entries: [] });
          hftNames.get(bucketKey).entries.push(entry);
          id = faceId(file, 0);
        }
      } else {
        const face = closest(hancomFaces.get(fileKey), mapFile, (item) => item.path);
        if (face) {
          id = face.id;
          // 한컴이 문서에 기록하는 표시 이름을 별칭으로 붙인다.
          if (!face.families.includes(entry.name)
            && !face.fullNames.includes(entry.name)
            && !face.typographicFamilies.includes(entry.name)) {
            face.families.push(entry.name);
          }
          if (HANGUL.test(entry.name) && !face.koreanNames.includes(entry.name)) face.koreanNames.push(entry.name);
        }
      }
      if (id) resolved += 1;
      else unresolved += 1;
      hancomFaceMap.push({ name: entry.name, file: entry.file, script: entry.script, faceId: id });
    }
  }

  const hftFaces = [];
  const mapped = new Set();
  for (const [bucketKey, { file, entries: names }] of hftNames) {
    mapped.add(bucketKey);
    hftFaces.push(hftFace(file, names, faceId));
  }
  // 굵게/기울임 변형(ENGARMB.HFT, ENGARMBI.HFT …)은 목록에 없고 기본 파일 이름 뒤에
  // B/I/BI 를 붙인 규칙으로만 존재한다. 기본 파일의 이름을 물려받고 스타일을 표시한다.
  const stemOf = (file) => pathKey(
    pathApi.join(pathApi.dirname(file.path), pathApi.basename(file.path, pathApi.extname(file.path))),
    'win32',
  );
  const mappedByStem = new Map();
  for (const { file, entries: names } of hftNames.values()) mappedByStem.set(stemOf(file), names);
  for (const file of hftFiles) {
    if (mapped.has(pathKey(file.realPath, platform))) continue;
    const stem = stemOf(file);
    const suffix = ['bi', 'b', 'i'].find((candidate) => (
      stem.endsWith(candidate) && mappedByStem.has(stem.slice(0, -candidate.length))
    ));
    if (!suffix) {
      hftFaces.push(hftFace(file, [], faceId));
      continue;
    }
    const face = hftFace(file, mappedByStem.get(stem.slice(0, -suffix.length)), faceId);
    face.bold = suffix.includes('b');
    face.italic = suffix.includes('i');
    face.weight = face.bold ? 700 : 400;
    face.styles = [face.bold && face.italic ? 'Bold Italic' : face.bold ? 'Bold' : 'Italic'];
    hftFaces.push(face);
  }
  for (const face of hftFaces) byId.set(face.id, { face, file: face.__file });
  for (const face of hftFaces) delete face.__file;
  return {
    hancomFaceMap,
    hftFaces,
    mapStats: { files: mapFiles.length, entries, resolved, unresolved },
  };
}

function hftFace(file, entries, faceId) {
  const names = uniqueStrings([
    ...entries.filter((entry) => HANGUL.test(entry.name)).map((entry) => entry.name),
    ...entries.map((entry) => entry.name),
  ]);
  const scripts = new Set(entries.map((entry) => entry.script.toLowerCase()));
  const face = {
    id: faceId(file, 0),
    path: file.path,
    faceIndex: 0,
    format: 'hft',
    source: file.kind,
    size: file.size,
    families: names,
    fullNames: [],
    postscriptNames: [],
    styles: [],
    typographicFamilies: [],
    typographicStyles: [],
    koreanNames: names.filter((name) => HANGUL.test(name)),
    weight: 400,
    italic: false,
    bold: false,
    hangul: scripts.has('hangul'),
    latin: scripts.has('latin'),
  };
  Object.defineProperty(face, '__file', { value: file, enumerable: false, configurable: true });
  return face;
}
