/** 호스트가 만든 SFNT의 포함 glyph 비트맵. glyph ID는 원본과 같다. */
export function fontGlyphCoverage(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4);
  for (let i = 0; i < count && 12 + i * 16 + 16 <= bytes.length; i++) {
    const at = 12 + i * 16;
    if (view.getUint32(at) !== 0x484d4743) continue; // HMGC
    const start = view.getUint32(at + 8), length = view.getUint32(at + 12);
    if (length < 8 || start > bytes.length - length || view.getUint32(start) !== 0x484d3031) return null;
    const glyphs = view.getUint32(start + 4);
    if (glyphs > 65535 || length !== 8 + Math.ceil(glyphs / 8)) return null;
    return bytes.subarray(start + 8, start + length);
  }
  return null;
}
