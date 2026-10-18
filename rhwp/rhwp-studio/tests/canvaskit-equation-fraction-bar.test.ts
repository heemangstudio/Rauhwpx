import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestModuleServer } from './support/module-server.ts';

const fraction = {
  x: 3, y: 5, width: 40, height: 30, baseline: 18,
  kind: {
    type: 'fraction', barInset: 1,
    numer: { x: 0, y: 0, width: 10, height: 10, baseline: 8, kind: { type: 'row', children: [] } },
    denom: { x: 0, y: 20, width: 10, height: 10, baseline: 8, kind: { type: 'row', children: [] } },
  },
};

test('source fraction bars retain native sizing, fallback and prepared-face changes', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const fonts: Array<{ face: any; size: number; deleted: boolean }> = [];
    const paints: Array<{ deleted: boolean }> = [];
    class TestFont {
      face: any;
      size: number;
      deleted = false;
      constructor(face: any, size: number) { this.face = face; this.size = size; fonts.push(this); }
      setEdging() {} setHinting() {} setEmbeddedBitmaps() {} setLinearMetrics() {} setSubpixel() {}
      getGlyphIDs(text: string) { assert.equal(text, '\ue06d'); return new Uint16Array([this.face.glyph]); }
      getGlyphWidths() { return new Float32Array([this.face.advance * this.size]); }
      delete() { assert.equal(this.deleted, false); this.deleted = true; }
    }
    const kit = { Font: TestFont, FontEdging: { AntiAlias: 1 }, FontHinting: { None: 0 } };
    const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null);
    let prepared: { glyph: number; advance: number } | undefined = { glyph: 7, advance: 2 };
    renderer.findPreparedTypeface = () => prepared ? { typeface: prepared } : undefined;
    const paint = () => {
      const result = { deleted: false, delete() { assert.equal(this.deleted, false); this.deleted = true; } };
      paints.push(result); return result;
    };
    renderer.makeFillPaint = paint;
    renderer.makeStrokePaint = paint;
    const calls: Array<[string, ...any[]]> = [];
    const failure = new Error('glyph replay failure');
    let throws = false;
    const canvas = {
      save() { calls.push(['save']); }, restore() { calls.push(['restore']); },
      translate(x: number, y: number) { calls.push(['translate', x, y]); },
      scale(x: number, y: number) { calls.push(['scale', x, y]); },
      drawText(text: string, x: number, y: number, _paint: any, font: TestFont) {
        calls.push(['text', text, x, y, font.size]); if (throws) throw failure;
      },
      drawLine(...coordinates: number[]) { calls.push(['line', ...coordinates.slice(0, 4)]); },
    };
    const render = (modern: boolean, family = 'HYhwpEQ') => {
      calls.length = 0;
      assert.equal(renderer.renderEquationBox(canvas, fraction, 0, 0, '#000000', 10, family,
        true, false, 0, { remainingNodes: 10, modernHy: modern, hft: !modern }), true);
      assert.ok(fonts.every(font => font.deleted));
      assert.ok(paints.every(value => value.deleted));
    };
    for (const modern of [true, false]) {
      render(modern);
      const font = fonts.at(-1)!;
      assert.equal(font.size, 10 * (modern ? 1 : 1.256));
      assert.deepEqual(calls.find(call => call[0] === 'translate'), ['translate', 4, 23 + 10 * (modern ? 0.3 : 0.46)]);
      const natural = new Float32Array([2 * font.size])[0];
      assert.deepEqual(calls.find(call => call[0] === 'scale'), ['scale', 38 / natural, 1]);
      assert.equal(calls.filter(call => call[0] === 'text').length, 1);
      assert.equal(calls.some(call => call[0] === 'line'), false);
    }
    prepared = { glyph: 7, advance: 3.8 };
    render(true);
    assert.equal(calls.some(call => call[0] === 'scale'), false, 'native keeps a source advance within 2% unscaled');
    const beforeNonHy = fonts.length;
    render(true, 'Latin Modern Math');
    assert.equal(fonts.length, beforeNonHy);
    assert.equal(calls.filter(call => call[0] === 'line').length, 1);
    assert.equal(calls.some(call => call[0] === 'text'), false);
    for (const face of [undefined, { glyph: 0, advance: 2 }, { glyph: 7, advance: 0 }, { glyph: 7, advance: NaN }]) {
      prepared = face; render(true);
      assert.equal(calls.filter(call => call[0] === 'line').length, 1);
      assert.equal(calls.some(call => call[0] === 'text'), false);
    }
    // 준비되지 않은 세대의 실패를 캐시하지 않고, 다음 세대의 실제 face를 쓴다.
    prepared = { glyph: 9, advance: 1 }; render(true);
    assert.deepEqual(calls.find(call => call[0] === 'scale'), ['scale', 3.8, 1]);
    prepared = undefined; render(true);
    assert.equal(calls.filter(call => call[0] === 'line').length, 1);
    prepared = { glyph: 7, advance: 2 }; throws = true; calls.length = 0;
    assert.throws(() => render(true), error => error === failure);
    assert.deepEqual(calls.at(-1), ['restore']);
    assert.ok(fonts.every(font => font.deleted));
    assert.ok(paints.every(value => value.deleted));
  } finally { await vite.close(); }
});
