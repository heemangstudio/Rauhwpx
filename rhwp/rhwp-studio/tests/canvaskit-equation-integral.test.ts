import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestModuleServer } from './support/module-server.ts';

test('modern integral selects HY before STIX and preserves origins, scale and outline fallback', async () => {
  const vite = await createTestModuleServer();
  const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
  const { setSfntGlyphPathApi } = await vite.ssrLoadModule('/src/core/sfnt-glyphs.ts');
  const fonts: any[] = [], paints: any[] = [], paths: any[] = [];
  class TestFont {
    deleted = false;
    face: any;
    size: number;
    constructor(face: any, size: number) { this.face = face; this.size = size; fonts.push(this); }
    setEdging() {} setHinting() {} setEmbeddedBitmaps() {} setLinearMetrics() {} setSubpixel() {}
    getGlyphIDs(text: string) { return Uint16Array.from([...text], ch => this.face.glyphs[ch] ?? 0); }
    getGlyphWidths() { return new Float32Array([this.size / 2]); }
    getGlyphBounds() { return new Float32Array([0, -10, 5, 0]); }
    delete() { assert.equal(this.deleted, false); this.deleted = true; }
  }
  const kit = { Font: TestFont, FontEdging: { AntiAlias: 1 }, FontHinting: { None: 0 }, Path: {
    MakeFromSVGString(source: string) {
      if (source === 'invalid') return null;
      const path = { source, deleted: false, delete() { assert.equal(this.deleted, false); this.deleted = true; } };
      paths.push(path); return path;
    },
  } };
  const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null);
  renderer.makeFillPaint = () => {
    const paint = { deleted: false, delete() { assert.equal(this.deleted, false); this.deleted = true; } };
    paints.push(paint); return paint;
  };
  let hy: any = { glyphs: { '\ue05b': 7 } };
  let stix: any = { glyphs: { '∫': 11 } };
  renderer.findPreparedTypeface = (family: string) => {
    const typeface = family === 'HYhwpEQ' ? hy : family === 'STIXGeneral' ? stix : null;
    return typeface ? { typeface } : undefined;
  };
  const calls: any[] = [];
  let throws = false;
  const failure = new Error('integral path paint failure');
  const canvas = {
    save() { calls.push(['save']); }, restore() { calls.push(['restore']); },
    translate(...coords: number[]) { calls.push(['translate', ...coords]); },
    scale(...coords: number[]) { calls.push(['scale', ...coords]); },
    drawText(text: string, x: number, y: number, _paint: any, font: TestFont) {
      calls.push(['mask', text, x, y, font.size, font.face]);
    },
    drawPath(path: any) { calls.push(['path', path.source]); if (throws) throw failure; },
  };
  const render = () => { calls.length = 0; return renderer.drawModernHyIntegral(canvas, 3, 5, 10, '#000000'); };
  try {
    assert.equal(render(), true);
    assert.deepEqual(calls, [['mask', '\ue05b', 3.42, 24.4, 20, hy]]);
    hy = { glyphs: {} }; assert.equal(render(), true);
    assert.deepEqual(calls, [['mask', '∫', 3.42, 24.4, 17.48, stix]]);
    hy = undefined; assert.equal(render(), true); assert.equal(calls[0][1], '∫');
    stix = { glyphs: {} }; assert.equal(render(), null); assert.deepEqual(calls, []);
    hy = { glyphs: { '\ue05b': 13 } };
    const bytes = new Uint8Array([4, 5, 6]).buffer;
    renderer.retainSfntTypefaceSource(hy, bytes);
    const queries: any[] = [];
    setSfntGlyphPathApi((data: Uint8Array, faceIndex: number, glyph: number) => {
      queries.push([data.buffer, faceIndex, glyph]); return 'M0 0 L50 -100 Z';
    });
    assert.equal(render(), true);
    assert.deepEqual(queries, [[bytes, 0, 13]]);
    assert.deepEqual(calls, [['save'], ['translate', 3.42, 24.4], ['scale', 0.02, 0.02], ['path', 'M0 0 L50 -100 Z'], ['restore']]);
    render(); assert.equal(queries.length, 1);
    setSfntGlyphPathApi(() => 'invalid'); render();
    assert.equal(calls[0][0], 'mask', 'invalid outline retains the HY mask rather than switching face');
    setSfntGlyphPathApi(() => 'M0 0 L50 -100 Z'); throws = true;
    assert.throws(render, error => error === failure); assert.deepEqual(calls.at(-1), ['restore']);
  } finally {
    renderer.dispose(); setSfntGlyphPathApi(null); await vite.close();
    assert.ok(fonts.every(font => font.deleted)); assert.ok(paints.every(paint => paint.deleted));
    assert.ok(paths.every(path => path.deleted));
  }
});
