/**
 * Some legacy TrueType fonts end a format-4 cmap with U+FFFF → glyph 65535.
 * That sentinel must map to glyph 0; Chrome's font sanitizer rejects the face.
 * Repair only this malformed sentinel and update the SFNT checksums.
 */
export function normalizeMalformedCmapSentinels(source: ArrayBuffer): ArrayBuffer {
  const input = new DataView(source);
  if (input.byteLength < 12) return source;
  const sfntVersion = input.getUint32(0, false);
  if (![0x00010000, 0x4f54544f, 0x74727565].includes(sfntVersion)) return source;
  const tableCount = input.getUint16(4, false);
  if (12 + tableCount * 16 > input.byteLength) return source;

  const table = (tag: string) => {
    for (let index = 0; index < tableCount; index += 1) {
      const record = 12 + index * 16;
      const name = String.fromCharCode(...new Uint8Array(source, record, 4));
      if (name !== tag) continue;
      const offset = input.getUint32(record + 8, false);
      const length = input.getUint32(record + 12, false);
      if (offset > input.byteLength || length > input.byteLength - offset) return null;
      return { record, offset, length };
    }
    return null;
  };
  const cmap = table('cmap');
  const head = table('head');
  const maxp = table('maxp');
  if (!cmap || cmap.length < 4 || !head || head.length < 12 || !maxp || maxp.length < 6) {
    return source;
  }
  if (input.getUint16(maxp.offset + 4, false) === 0) return source;
  const encodingCount = input.getUint16(cmap.offset + 2, false);
  if (4 + encodingCount * 8 > cmap.length) return source;

  let output: ArrayBuffer | null = null;
  const visited = new Set<number>();
  for (let index = 0; index < encodingCount; index += 1) {
    const subtableOffset = input.getUint32(cmap.offset + 4 + index * 8 + 4, false);
    if (visited.has(subtableOffset)) continue;
    visited.add(subtableOffset);
    if (subtableOffset > cmap.length - 16) continue;
    const subtable = cmap.offset + subtableOffset;
    if (input.getUint16(subtable, false) !== 4) continue;
    const length = input.getUint16(subtable + 2, false);
    const segCountX2 = input.getUint16(subtable + 6, false);
    if (segCountX2 === 0 || segCountX2 % 2 !== 0) continue;
    const segments = segCountX2 / 2;
    if (length < 16 + segments * 8 || subtableOffset + length > cmap.length) continue;

    const lastEnd = subtable + 12 + segments * 2;
    const lastStart = subtable + 14 + segments * 4;
    const lastDelta = subtable + 14 + segments * 6;
    const lastRange = subtable + 14 + segments * 8;
    if (input.getUint16(lastEnd, false) !== 0xffff
      || input.getUint16(lastStart, false) !== 0xffff
      || input.getUint16(lastDelta, false) !== 0
      || input.getUint16(lastRange, false) !== 0) continue;
    output ??= source.slice(0);
    new DataView(output).setUint16(lastDelta, 1, false);
  }
  if (!output) return source;

  writeSfntChecksums(output, head, [cmap]);
  return output;
}

interface SfntTableRef {
  record: number;
  offset: number;
  length: number;
}

function sfntChecksum(bytes: Uint8Array, offset: number, length: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const whole = length & ~3;
  let sum = 0;
  for (let index = 0; index < whole; index += 4) sum = (sum + view.getUint32(offset + index, false)) >>> 0;
  if (whole < length) {
    let word = 0;
    for (let index = whole; index < whole + 4; index += 1) {
      word = (word << 8) | (index < length ? bytes[offset + index]! : 0);
    }
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

/** 바뀐 테이블과 head 의 checksum, 그리고 글꼴 전체 checkSumAdjustment 를 다시 쓴다. */
function writeSfntChecksums(output: ArrayBuffer, head: SfntTableRef, changed: SfntTableRef[]): void {
  const bytes = new Uint8Array(output);
  const view = new DataView(output);
  view.setUint32(head.offset + 8, 0, false);
  for (const table of changed) {
    view.setUint32(table.record + 4, sfntChecksum(bytes, table.offset, table.length), false);
  }
  view.setUint32(head.record + 4, sfntChecksum(bytes, head.offset, head.length), false);
  view.setUint32(head.offset + 8, (0xb1b0afba - sfntChecksum(bytes, 0, bytes.length)) >>> 0, false);
}

// glyf 합성 글리프 component flag (OpenType glyf 명세)
const ARG_1_AND_2_ARE_WORDS = 0x0001;
const ARGS_ARE_XY_VALUES = 0x0002;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;
const SCALED_COMPONENT_OFFSET = 0x0800;

/**
 * 합성 글리프 헤더 bbox 가 component 합집합보다 작은 TrueType 글꼴을 고친다.
 *
 * HY헤드라인M·돋움체 등 한컴 서체의 한글 합성 글리프는 헤더 bbox 가 실제 윤곽보다
 * 낮게 기록돼 있다. macOS Chrome(CoreText)은 글리프를 헤더 bbox 크기로 래스터해
 * 초성 윗획이 잘린다('초→조', '즉→슥'). 그런 합성 글리프 헤더만 component
 * bbox 합집합까지 넓히고, head 의 글꼴 bbox 도 같이 넓힌다. 윤곽·advance 는 그대로다.
 * 고칠 글리프가 없으면 원본 버퍼를 그대로 반환한다.
 */
export function repairUnderstatedCompositeBounds(source: ArrayBuffer): ArrayBuffer {
  const input = new DataView(source);
  if (input.byteLength < 12) return source;
  const sfntVersion = input.getUint32(0, false);
  if (sfntVersion !== 0x00010000 && sfntVersion !== 0x74727565) return source;
  const tableCount = input.getUint16(4, false);
  if (12 + tableCount * 16 > input.byteLength) return source;
  const table = (tag: string): SfntTableRef | null => {
    for (let index = 0; index < tableCount; index += 1) {
      const record = 12 + index * 16;
      const name = String.fromCharCode(...new Uint8Array(source, record, 4));
      if (name !== tag) continue;
      const offset = input.getUint32(record + 8, false);
      const length = input.getUint32(record + 12, false);
      if (offset > input.byteLength || length > input.byteLength - offset) return null;
      return { record, offset, length };
    }
    return null;
  };
  const head = table('head');
  const maxp = table('maxp');
  const loca = table('loca');
  const glyf = table('glyf');
  if (!head || head.length < 54 || !maxp || maxp.length < 6 || !loca || !glyf) return source;
  const numGlyphs = input.getUint16(maxp.offset + 4, false);
  const longLoca = input.getInt16(head.offset + 50, false) === 1;
  if (loca.length < (numGlyphs + 1) * (longLoca ? 4 : 2)) return source;

  // 글리프 범위를 [start, end) 로 돌려준다. 비었거나 표 밖이면 start 가 -1 이다.
  let rangeEnd = 0;
  const glyphStart = (glyph: number): number => {
    const start = longLoca
      ? input.getUint32(loca.offset + glyph * 4, false)
      : input.getUint16(loca.offset + glyph * 2, false) * 2;
    rangeEnd = longLoca
      ? input.getUint32(loca.offset + glyph * 4 + 4, false)
      : input.getUint16(loca.offset + glyph * 2 + 2, false) * 2;
    if (rangeEnd - start < 10 || rangeEnd > glyf.length) return -1;
    rangeEnd += glyf.offset;
    return glyf.offset + start;
  };

  // 합성 글리프 bbox = component bbox 를 변환한 네 꼭짓점의 합집합 (보수적 외접 사각형).
  // F2Dot14 배율 오차(-0.99988 등)로 1 단위씩 넓히지 않도록 정수로 반올림한다.
  // component 번호는 uint16 이라 표를 65536 칸으로 잡는다. 0: 미정, 1: 경계 있음, 2: 없음.
  const state = new Uint8Array(0x10000);
  const bounds = new Int32Array(0x10000 * 4);
  const pending: number[] = [];
  const settle = (glyph: number, xMin: number, yMin: number, xMax: number, yMax: number): true => {
    state[glyph] = 1;
    bounds[glyph * 4] = xMin;
    bounds[glyph * 4 + 1] = yMin;
    bounds[glyph * 4 + 2] = xMax;
    bounds[glyph * 4 + 3] = yMax;
    return true;
  };
  const compositeBounds = (glyph: number, depth: number): boolean => {
    if (state[glyph] !== 0) return state[glyph] === 1;
    const start = glyphStart(glyph);
    const end = rangeEnd;
    if (start < 0 || depth > 8) return false;
    const hx0 = input.getInt16(start + 2, false);
    const hy0 = input.getInt16(start + 4, false);
    const hx1 = input.getInt16(start + 6, false);
    const hy1 = input.getInt16(start + 8, false);
    if (input.getInt16(start, false) >= 0) return settle(glyph, hx0, hy0, hx1, hy1);
    let any = false;
    let ux0 = 0; let uy0 = 0; let ux1 = 0; let uy1 = 0;
    let at = start + 10;
    let flags = MORE_COMPONENTS;
    while (flags & MORE_COMPONENTS) {
      if (at + 4 > end) return false;
      flags = input.getUint16(at, false);
      const component = input.getUint16(at + 2, false);
      at += 4;
      if (!(flags & ARGS_ARE_XY_VALUES)) {
        // 점 맞춤(point matching) 배치는 윤곽 좌표가 필요하므로 건드리지 않는다.
        state[glyph] = 2;
        return false;
      }
      const words = (flags & ARG_1_AND_2_ARE_WORDS) !== 0;
      if (at + (words ? 4 : 2) > end) return false;
      let dx = words ? input.getInt16(at, false) : input.getInt8(at);
      let dy = words ? input.getInt16(at + 2, false) : input.getInt8(at + 1);
      at += words ? 4 : 2;
      let a = 1; let b = 0; let c = 0; let d = 1;
      if (flags & WE_HAVE_A_SCALE) {
        a = d = input.getInt16(at, false) / 16384;
        at += 2;
      } else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
        a = input.getInt16(at, false) / 16384;
        d = input.getInt16(at + 2, false) / 16384;
        at += 4;
      } else if (flags & WE_HAVE_A_TWO_BY_TWO) {
        a = input.getInt16(at, false) / 16384;
        b = input.getInt16(at + 2, false) / 16384;
        c = input.getInt16(at + 4, false) / 16384;
        d = input.getInt16(at + 6, false) / 16384;
        at += 8;
      }
      if (flags & SCALED_COMPONENT_OFFSET) {
        const sx = a * dx + c * dy;
        dy = b * dx + d * dy;
        dx = sx;
      }
      if (!compositeBounds(component, depth + 1)) {
        // 빈 component(공백 등)는 합집합에 영향이 없다.
        if (glyphStart(component) >= 0) {
          state[glyph] = 2;
          return false;
        }
        continue;
      }
      const ix0 = bounds[component * 4]!;
      const iy0 = bounds[component * 4 + 1]!;
      const ix1 = bounds[component * 4 + 2]!;
      const iy1 = bounds[component * 4 + 3]!;
      for (let corner = 0; corner < 4; corner += 1) {
        const x = corner < 2 ? ix0 : ix1;
        const y = corner % 2 === 0 ? iy0 : iy1;
        const tx = a * x + c * y + dx;
        const ty = b * x + d * y + dy;
        if (!any) {
          ux0 = ux1 = tx;
          uy0 = uy1 = ty;
          any = true;
        } else {
          ux0 = Math.min(ux0, tx);
          uy0 = Math.min(uy0, ty);
          ux1 = Math.max(ux1, tx);
          uy1 = Math.max(uy1, ty);
        }
      }
    }
    if (!any) return settle(glyph, hx0, hy0, hx1, hy1);
    const gx0 = Math.min(hx0, Math.round(ux0));
    const gy0 = Math.min(hy0, Math.round(uy0));
    const gx1 = Math.max(hx1, Math.round(ux1));
    const gy1 = Math.max(hy1, Math.round(uy1));
    if ((gx0 !== hx0 || gy0 !== hy0 || gx1 !== hx1 || gy1 !== hy1)
      && [gx0, gy0, gx1, gy1].every(value => value >= -32768 && value <= 32767)) {
      pending.push(glyph);
    }
    return settle(glyph, gx0, gy0, gx1, gy1);
  };
  for (let glyph = 0; glyph < numGlyphs; glyph += 1) compositeBounds(glyph, 0);
  if (pending.length === 0) return source;

  const output = source.slice(0);
  const view = new DataView(output);
  const fontBounds = [
    input.getInt16(head.offset + 36, false),
    input.getInt16(head.offset + 38, false),
    input.getInt16(head.offset + 40, false),
    input.getInt16(head.offset + 42, false),
  ];
  for (const glyph of pending) {
    const at = glyphStart(glyph) + 2;
    for (let index = 0; index < 4; index += 1) {
      const value = bounds[glyph * 4 + index]!;
      view.setInt16(at + index * 2, value, false);
      fontBounds[index] = index < 2 ? Math.min(fontBounds[index]!, value) : Math.max(fontBounds[index]!, value);
    }
  }
  fontBounds.forEach((value, index) => view.setInt16(head.offset + 36 + index * 2, value, false));
  writeSfntChecksums(output, head, [glyf]);
  return output;
}
