import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestModuleServer } from './support/module-server.ts';

test('equation outlines bind exact prepared bytes, preserve placement and fall back atomically', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  let renderer: any;
  let setApi: ((api: any) => void) | undefined;
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const sfnt = await vite.ssrLoadModule('/src/core/sfnt-glyphs.ts');
    setApi = sfnt.setSfntGlyphPathApi;
    const fonts: Array<{ deleted: boolean }> = [];
    const paints: Array<{ deleted: boolean }> = [];
    const paths: Array<{ source: string; deleted: boolean }> = [];
    class TestFont {
      deleted = false;
      constructor(_face: any, _size: number) { fonts.push(this); }
      setEdging() {} setHinting() {} setEmbeddedBitmaps() {} setLinearMetrics() {} setSubpixel() {}
      setEmbolden() {} setSkewX() {}
      getGlyphIDs(text: string) { return Uint16Array.from(Array.from(text, ch => ch.codePointAt(0)!)); }
      getGlyphWidths(ids: Uint16Array) { return Float32Array.from(ids, id => id === 32 ? 4 : id === 65 ? 10 : 11); }
      getGlyphBounds(ids: Uint16Array) { return Float32Array.from([...ids].flatMap(id => id === 32 ? [0, 0, 0, 0] : [0, -8, 9, 0])); }
      delete() { assert.equal(this.deleted, false); this.deleted = true; }
    }
    const kit = { Font: TestFont, FontEdging: { AntiAlias: 1 }, FontHinting: { None: 0 },
      Path: { MakeFromSVGString(source: string) {
        if (source === 'invalid') return null;
        const path = { source, deleted: false, delete() { assert.equal(this.deleted, false); this.deleted = true; } };
        paths.push(path); return path;
      } } };
    renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null);
    renderer.makeFillPaint = () => {
      const paint = { deleted: false, delete() { assert.equal(this.deleted, false); this.deleted = true; } };
      paints.push(paint); return paint;
    };
    const faceA = {}, faceB = {};
    const bytesA = new Uint8Array([1, 2, 3]).buffer;
    const bytesB = new Uint8Array([4, 5, 6]).buffer;
    let currentFace = faceA;
    let syntheticBold = false;
    renderer.findEquationTypefaces = () => [{ typeface: currentFace, syntheticItalic: true, syntheticBold }];
    renderer.retainSfntTypefaceSource(faceA, bytesA);
    let calls: Array<[string, ...any[]]> = [];
    let throwPaint = false;
    const failure = new Error('path paint failure');
    const canvas = {
      save() { calls.push(['save']); }, restore() { calls.push(['restore']); },
      translate(...p: number[]) { calls.push(['translate', ...p]); },
      scale(...p: number[]) { calls.push(['scale', ...p]); },
      skew(...p: number[]) { calls.push(['skew', ...p]); },
      drawPath(path: any) { calls.push(['path', path.source]); if (throwPaint) throw failure; },
      drawText(text: string, x: number, y: number) { calls.push(['mask', text, x, y]); },
    };
    const layout = { x: 5, y: 7, width: 25, height: 10, baseline: 8, kind: { type: 'text', text: 'A B' } };
    const render = (currentLayout = layout) => {
      calls = [];
      assert.equal(renderer.renderEquationBox(canvas, currentLayout, 0, 0, '#000000', 10, 'Prepared source',
        true, false, 0, { remainingNodes: 10, modernHy: false, hft: false }), true);
      assert.ok(fonts.every(value => value.deleted));
      assert.ok(paints.every(value => value.deleted));
    };
    const queries: any[] = [];
    const complete = (bytes: Uint8Array, index: number, glyph: number) => {
      queries.push([bytes.buffer, index, glyph]);
      return glyph === 32 ? '' : `M${glyph} 0 L0 0 Z`;
    };
    setApi!(complete);
    render();
    assert.deepEqual(queries, [[bytesA, 0, 65], [bytesA, 0, 32], [bytesA, 0, 66]]);
    assert.deepEqual(calls.filter(call => call[0] === 'translate'), [['translate', 5, 15], ['translate', 19, 15]], 'blank advance survives without ink');
    assert.deepEqual(calls.filter(call => call[0] === 'scale'), [['scale', 0.01, 0.01], ['scale', 0.01, 0.01]]);
    assert.deepEqual(calls.filter(call => call[0] === 'skew'), [['skew', -0.2, 0], ['skew', -0.2, 0]]);
    assert.equal(calls.some(call => call[0] === 'mask'), false);
    render(); assert.equal(queries.length, 3, 'same concrete typeface reuses its glyph paths');
    render({ ...layout, height: 0.5, baseline: 0.4 });
    assert.equal(calls.some(call => call[0] === 'path'), false, 'subpixel em retains the existing clamped-font mask');
    assert.equal(calls.filter(call => call[0] === 'mask').length, 1);

    syntheticBold = true; render(); syntheticBold = false;
    assert.deepEqual(calls.filter(call => call[0] === 'mask'), [['mask', 'A B', 5, 15]], 'unproven synthetic bold retains its mask');
    setApi!(null); render({ ...layout, height: 0.5, baseline: 0.4 });
    assert.ok(paths.every(path => path.deleted), 'disabling the API releases cached native paths immediately');
    render();
    assert.equal(calls.some(call => call[0] === 'path'), false);
    assert.equal(calls.filter(call => call[0] === 'mask').length, 1);
    setApi!((bytes: Uint8Array, index: number, glyph: number) => glyph === 66 ? '' : complete(bytes, index, glyph));
    render();
    assert.equal(calls.some(call => call[0] === 'path'), false, 'later missing ink cannot leave an earlier painted glyph');
    assert.equal(calls.filter(call => call[0] === 'mask').length, 1);
    setApi!(() => 'invalid'); render();
    assert.equal(calls.some(call => call[0] === 'path'), false);
    assert.equal(calls.filter(call => call[0] === 'mask').length, 1);
    currentFace = faceB; setApi!(complete); render();
    assert.equal(calls.some(call => call[0] === 'path'), false, 'same requested family cannot borrow another concrete face bytes');
    renderer.retainSfntTypefaceSource(faceB, bytesB); render();
    assert.ok(queries.slice(-3).every(([bytes, index]) => bytes === bytesB && index === 0));
    renderer.releaseSfntTypefaceSource(faceA);
    assert.equal(renderer.sfntTypefaceSources.has(faceA), false);
    throwPaint = true;
    assert.throws(render, error => error === failure);
    assert.deepEqual(calls.at(-1), ['restore']);
    assert.ok(fonts.every(value => value.deleted));
    assert.ok(paints.every(value => value.deleted));
    renderer.dispose(); renderer = null;
    assert.ok(paths.every(path => path.deleted), 'reset/dispose releases cached paths from every face generation');
  } finally { renderer?.dispose(); setApi?.(null); await vite.close(); }
});
