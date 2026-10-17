import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestModuleServer } from './support/module-server.ts';

test('CanvasKit omits discretionary hyphens without shifting positioned literal punctuation', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const vite = await createTestModuleServer(root);
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    class FakeFont {
      constructor(_face: unknown, _size: number) {}
      setEdging() {}
      setHinting() {}
      setEmbeddedBitmaps() {}
      setLinearMetrics() {}
      setSubpixel() {}
      setEmbolden() {}
      setSkewX() {}
      getGlyphIDs(text: string) { return Array.from(text, ch => ch.codePointAt(0) ?? 0); }
      delete() {}
    }
    const kit = { Font: FakeFont, FontEdging: { AntiAlias: 1 }, FontHinting: { None: 0 } };
    const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, { face: 'default' });
    renderer.recordTextRunCoverageGaps = () => {};
    renderer.makeFillPaint = () => ({ setAntiAlias() {}, delete() {} });
    const drawn: Array<{ glyphs: number[]; positions: number[] } | { text: string }> = [];
    const canvas = {
      save() {}, restore() {},
      drawGlyphs(glyphs: Uint16Array, positions: Float32Array) {
        drawn.push({ glyphs: Array.from(glyphs), positions: Array.from(positions) });
      },
      drawText(text: string) { drawn.push({ text }); },
    };
    const op = {
      type: 'textRun',
      bbox: { x: 0, y: 0, width: 32, height: 18 },
      text: '\u00ad-A-',
      positions: [0, 0, 10, 18, 28],
      style: { fontSize: 16, color: '#000000' },
    };
    renderer.renderTextRun(canvas, op);
    assert.deepEqual(drawn, [{
      glyphs: [45, 65, 45],
      positions: [0, 0, 10, 0, 18, 0],
    }]);

    drawn.length = 0;
    renderer.renderTextRun(canvas, { ...op, positions: undefined });
    assert.deepEqual(drawn, [{ text: '-A-' }]);
  } finally {
    await vite.close();
  }
});


test('CanvasKit omits authored blank controls while literal NBSP and following origins survive', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const vite = await createTestModuleServer(root);
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    class FakeFont {
      constructor(_face: unknown, _size: number) {}
      setEdging() {} setHinting() {} setEmbeddedBitmaps() {} setLinearMetrics() {}
      setSubpixel() {} setEmbolden() {} setSkewX() {}
      getGlyphIDs(text: string) { return Array.from(text, ch => ch === '😀' ? 42 : (ch.codePointAt(0) ?? 0)); }
      getGlyphWidths(ids: number[]) { return ids.map(() => 10); }
      delete() {}
    }
    const kit = { Font: FakeFont, FontEdging: { AntiAlias: 1 }, FontHinting: { None: 0 } };
    const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, { face: 'default' });
    renderer.recordTextRunCoverageGaps = () => {};
    renderer.makeFillPaint = () => ({ setAntiAlias() {}, delete() {} });
    renderer.renderShapedScriptText = () => { throw new Error('raw blanks require positioned replay'); };
    const drawn: Array<{ glyphs: number[]; positions: number[] }> = [];
    const canvas = { save() {}, restore() {}, translate() {},
      drawGlyphs(glyphs: Uint16Array, positions: Float32Array) {
        drawn.push({ glyphs: Array.from(glyphs), positions: Array.from(positions) });
      },
      drawText() { throw new Error('raw blanks must not enter whole-text replay'); },
    };
    const op = { type: 'textRun', bbox: { x: 0, y: 0, width: 70, height: 18 },
      text: 'A\u00a0B\u00a0C\u2007D', positions: [0, 10, 18.5, 28.5, 36.5, 46.5, 58, 68],
      nonprintingSpaces: [1, 5], style: { fontSize: 16, color: '#000000' } };
    renderer.renderTextRun(canvas, op);
    assert.deepEqual(drawn, [
      { glyphs: [65], positions: [0, 0] },
      { glyphs: [66, 160, 67], positions: [18.5, 0, 28.5, 0, 36.5, 0] },
      { glyphs: [68], positions: [58, 0] },
    ]);
    drawn.length = 0;
    renderer.renderTextRun(canvas, { ...op, nonprintingSpaces: undefined });
    assert.deepEqual(drawn[0].glyphs, [65, 160, 66, 160, 67, 8199, 68]);
    drawn.length = 0;
    renderer.renderTextRun(canvas, { ...op, nonprintingSpaces: [0, 2, -1, NaN, 100] });
    assert.deepEqual(drawn[0].glyphs, [65, 160, 66, 160, 67, 8199, 68], 'invalid indices cannot hide ordinary glyphs');
    drawn.length = 0;
    renderer.renderTextRun(canvas, { ...op, style: { ...op.style, superscript: true } });
    assert.deepEqual(drawn.flatMap(run => run.glyphs), [65, 66, 160, 67, 68]);
    assert.deepEqual(op.positions, [0, 10, 18.5, 28.5, 36.5, 46.5, 58, 68]);
    assert.equal(op.text, 'A\u00a0B\u00a0C\u2007D');
    drawn.length = 0;
    renderer.renderTextRun(canvas, { ...op, text: '😀\u00a0B', positions: [0, 20, 28.5, 38.5], nonprintingSpaces: [1] });
    assert.deepEqual(drawn, [
      { glyphs: [42], positions: [0, 0] },
      { glyphs: [66], positions: [28.5, 0] },
    ], 'blank indices are Unicode scalar indices, independent of UTF-16 code units');
  } finally { await vite.close(); }
});
