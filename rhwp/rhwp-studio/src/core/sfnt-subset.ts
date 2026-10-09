/**
 * 엔진 런타임 메트릭(runtime_font_metrics.rs → ttf_parser)이 읽는 표만 남긴 SFNT.
 *
 * 등록 때 wasm 선형 메모리로 글꼴 전체를 복사하면 한컴 CJK 글꼴 하나에 30MB가 넘게
 * 늘어나고 줄지 않는다. 엔진은 head·hhea·maxp·OS/2·cmap·hmtx와 컬렉션 face 선택용
 * name·post만 읽으므로 나머지 표(glyf·CFF·GSUB 등)를 빼도 등록 결과가 같다.
 * 표 바이트는 그대로 옮기므로 표 체크섬도 원본 값이 맞다.
 */

const tagOf = (text: string): number =>
  ((text.charCodeAt(0) << 24) | (text.charCodeAt(1) << 16) | (text.charCodeAt(2) << 8) | text.charCodeAt(3)) >>> 0;

const TTCF = tagOf('ttcf');
const SFNT_VERSIONS = new Set([0x00010000, tagOf('true'), tagOf('OTTO')]);
const FVAR = tagOf('fvar');
const HVAR = tagOf('HVAR');
/** ttf_parser가 단위·세로 메트릭·advance·cmap·이름을 읽는 표와, 기본 좌표의 가변 보정 표 */
const METRIC_TABLES = new Set(['head', 'hhea', 'maxp', 'OS/2', 'cmap', 'hmtx', 'name', 'fvar', 'avar', 'HVAR', 'MVAR'].map(tagOf));
/** 컬렉션 face 선택의 is_italic이 post의 italicAngle을 읽는다. */
const POST = tagOf('post');

interface TableRecord {
  tag: number;
  checksum: number;
  offset: number;
  length: number;
}

function readFace(view: DataView, faceOffset: number, collection: boolean): TableRecord[] | null {
  if (faceOffset + 12 > view.byteLength) return null;
  if (!SFNT_VERSIONS.has(view.getUint32(faceOffset, false))) return null;
  const count = view.getUint16(faceOffset + 4, false);
  if (faceOffset + 12 + count * 16 > view.byteLength) return null;
  const kept: TableRecord[] = [];
  let previous = -1;
  let variable = false;
  let hvar = false;
  for (let index = 0; index < count; index += 1) {
    const record = faceOffset + 12 + index * 16;
    const tag = view.getUint32(record, false);
    const offset = view.getUint32(record + 8, false);
    const length = view.getUint32(record + 12, false);
    // 정렬이 어긋나거나 범위를 벗어난 표가 있으면 원본 그대로 넘겨 엔진 판단을 바꾸지 않는다.
    if (tag <= previous || offset + length > view.byteLength) return null;
    previous = tag;
    if (tag === FVAR) variable = true;
    if (tag === HVAR) hvar = true;
    if (METRIC_TABLES.has(tag) || (collection && tag === POST)) {
      kept.push({ tag, checksum: view.getUint32(record + 4, false), offset, length });
    }
  }
  // HVAR 없는 가변 글꼴은 advance를 glyf·gvar 팬텀 점으로 보정한다.
  if (variable && !hvar) return null;
  return kept;
}

/** 엔진 런타임 메트릭 등록용 SFNT. 줄일 수 없는 입력이면 원본을 그대로 돌려준다. */
export function sfntMetricsSubset(source: ArrayBuffer): Uint8Array {
  const original = new Uint8Array(source);
  const view = new DataView(source);
  if (view.byteLength < 12) return original;
  const collection = view.getUint32(0, false) === TTCF;
  let faceOffsets: number[];
  if (collection) {
    const count = view.getUint32(8, false);
    if (count === 0 || 12 + count * 4 > view.byteLength) return original;
    faceOffsets = Array.from({ length: count }, (_, index) => view.getUint32(12 + index * 4, false));
  } else {
    faceOffsets = [0];
  }
  const faces: TableRecord[][] = [];
  for (const offset of faceOffsets) {
    const records = readFace(view, offset, collection);
    if (!records) return original;
    faces.push(records);
  }

  const headerLength = collection ? 12 + faces.length * 4 : 0;
  let cursor = headerLength + faces.reduce((sum, records) => sum + 12 + records.length * 16, 0);
  // 컬렉션 face끼리 공유하는 표는 한 번만 싣는다.
  const placed = new Map<string, number>();
  const blocks: Array<{ from: number; length: number; to: number }> = [];
  for (const records of faces) {
    for (const record of records) {
      const key = `${record.offset}:${record.length}`;
      if (placed.has(key)) continue;
      placed.set(key, cursor);
      blocks.push({ from: record.offset, length: record.length, to: cursor });
      cursor += (record.length + 3) & ~3;
    }
  }
  if (cursor >= source.byteLength) return original;

  const output = new Uint8Array(cursor);
  const out = new DataView(output.buffer);
  let directory = headerLength;
  if (collection) {
    out.setUint32(0, TTCF, false);
    out.setUint32(4, 0x00010000, false);
    out.setUint32(8, faces.length, false);
  }
  faces.forEach((records, index) => {
    if (collection) out.setUint32(12 + index * 4, directory, false);
    const count = records.length;
    const power = count > 0 ? 2 ** Math.floor(Math.log2(count)) : 0;
    out.setUint32(directory, view.getUint32(faceOffsets[index]!, false), false);
    out.setUint16(directory + 4, count, false);
    out.setUint16(directory + 6, power * 16, false);
    out.setUint16(directory + 8, power > 0 ? Math.log2(power) : 0, false);
    out.setUint16(directory + 10, count * 16 - power * 16, false);
    records.forEach((record, position) => {
      const entry = directory + 12 + position * 16;
      out.setUint32(entry, record.tag, false);
      out.setUint32(entry + 4, record.checksum, false);
      out.setUint32(entry + 8, placed.get(`${record.offset}:${record.length}`)!, false);
      out.setUint32(entry + 12, record.length, false);
    });
    directory += 12 + count * 16;
  });
  for (const block of blocks) output.set(original.subarray(block.from, block.from + block.length), block.to);
  return output;
}
