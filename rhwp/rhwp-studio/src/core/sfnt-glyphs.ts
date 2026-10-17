/** 실제 CanvasKit face를 만든 바이트와 glyph ID로만 윤곽선을 읽는다. */
export type SfntGlyphPathApi = (bytes: Uint8Array, faceIndex: number, glyphId: number) => string;
let api: SfntGlyphPathApi | null = null;

export function setSfntGlyphPathApi(next: SfntGlyphPathApi | null): void {
  api = next;
}

export function getSfntGlyphPathApi(): SfntGlyphPathApi | null {
  return api;
}
