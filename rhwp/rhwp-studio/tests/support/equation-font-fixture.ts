import { readFileSync } from 'node:fs';

// MIT 소유 fixture의 사각형만 재사용한다. 한컴 서체/윤곽은 읽거나 복제하지 않는다.
export function syntheticEquationFont(characters: string, glyph: number, advance: number, italic = false, weight = 400): ArrayBuffer {
  const original = readFileSync(new URL('../../../tests/fixtures/fonts/RHWPShapingFixture.ttf', import.meta.url));
  const codes = [...new Set([...characters].map(ch => ch.codePointAt(0)!))].sort((a, b) => a - b);
  const offset = (original.length + 3) & ~3;
  const length = 28 + codes.length * 12;
  const bytes = new ArrayBuffer(offset + length);
  new Uint8Array(bytes).set(original);
  const view = new DataView(bytes);
  for (let i = 0; i < view.getUint16(4); i++) {
    const record = 12 + i * 16;
    const tag = view.getUint32(record);
    if (tag === 0x636d6170) {
      view.setUint32(record + 8, offset); view.setUint32(record + 12, length);
    }
    if (tag === 0x686d7478) view.setUint16(view.getUint32(record + 8) + glyph * 4, advance);
    if (tag === 0x68656164) view.setUint16(view.getUint32(record + 8) + 44, (italic ? 2 : 0) | (weight >= 700 ? 1 : 0));
    if (tag === 0x4f532f32) {
      const table = view.getUint32(record + 8);
      view.setUint16(table + 4, weight);
      view.setUint16(table + 62, (italic ? 1 : 0) | (weight >= 700 ? 32 : 0));
    }
  }
  view.setUint16(offset + 2, 1); view.setUint16(offset + 4, 3); view.setUint16(offset + 6, 10);
  view.setUint32(offset + 8, 12);
  view.setUint16(offset + 12, 12); view.setUint32(offset + 16, length - 12);
  view.setUint32(offset + 24, codes.length);
  codes.forEach((code, i) => {
    view.setUint32(offset + 28 + i * 12, code);
    view.setUint32(offset + 32 + i * 12, code);
    view.setUint32(offset + 36 + i * 12, glyph);
  });
  return bytes;
}
