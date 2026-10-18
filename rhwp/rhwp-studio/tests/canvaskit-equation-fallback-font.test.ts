import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import CanvasKitInit from 'canvaskit-wasm/bin/full/canvaskit.js';
import { createTestModuleServer } from './support/module-server.ts';
import { syntheticEquationFont as syntheticFont } from './support/equation-font-fixture.ts';

test('modern special symbols bind registered metrics and CanvasKit glyphs across font arrival and replacement', async () => {
  const vite = await createTestModuleServer();
  const local = await vite.ssrLoadModule('/src/core/local-fonts.ts');
  const { createEquationTextMeasurer } = await vite.ssrLoadModule('/src/core/equation-font.ts');
  const { sfntCoversText, sfntTrueTypeRunMetrics } = await vite.ssrLoadModule('/src/core/sfnt-cmap.ts');
  const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
  const { setSfntGlyphPathApi } = await vite.ssrLoadModule('/src/core/sfnt-glyphs.ts');
  const globals = globalThis as unknown as { document?: any; FontFace?: any; window?: any };
  const previous = { document: globals.document, FontFace: globals.FontFace, window: globals.window };
  const cssMeasurements: Array<[string, string]> = [];
  const context = { font: '', measureText(text: string) {
    cssMeasurements.push([text, this.font]);
    return { width: 8, actualBoundingBoxLeft: -0.5, actualBoundingBoxRight: 5 };
  } };
  let finishLoad: (() => void) | undefined;
  let delayLoad = false;
  globals.FontFace = class {
    async load() { if (delayLoad) await new Promise<void>(resolve => { finishLoad = resolve; }); return this; }
  };
  globals.document = { fonts: { add() {}, delete() { return true; } }, createElement: () => ({ getContext: () => context }) };
  globals.window = { setTimeout };
  local.resetLocalFontsForTests();
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/full/${file}`, import.meta.url)) });
  const fontFaces = new WeakMap<object, object>();
  const trackedKit = { ...kit, Font: function(face: any, size: number) {
    const font = new kit.Font(face, size); fontFaces.set(font, face); return font;
  } };
  const renderer = new CanvasKitLayerRenderer(trackedKit, 'default', {}, null);
  const painted: Array<{ glyph: number; face: object; x: number; y: number; width: number; skew: number; bold: boolean }> = [];
  const canvas = { drawText(text: string, x: number, y: number, _paint: any, font: any) {
    const ids = font.getGlyphIDs(text);
    painted.push({ glyph: ids[0], face: fontFaces.get(font)!, x, y, width: font.getGlyphWidths(ids)[0],
      skew: font.getSkewX(), bold: font.isEmbolden() });
  } };
  const names = (family: string, style: string) => ({ family, fullName: `${family} ${style}`, postscriptName: `${family.replaceAll(' ', '')}-${style}`, style, aliases: [] });
  const register = async (family: string, bytes: ArrayBuffer, source = 'imported', style = 'Regular', aliases: string[] = []) => {
    const result = await local.registerLocalFontFace(bytes, { source, fileName: 'owned-synthetic.ttf', names: { ...names(family, style), aliases } });
    assert.equal(result.ok, true); return result;
  };
  const measure = createEquationTextMeasurer(local.resolveLocalFont, local.getImportedLocalFontBytes);
  const draw = (text: string, modern = true, hft = false, italic = false, bold = false) => {
    painted.length = 0;
    assert.equal(renderer.drawEquationText(canvas, text, 3, 17, 10, '#000000', italic, bold, 0, false, 'HYhwpEQ', hft, false, modern), true);
    assert.equal(painted.length, 1); return painted[0];
  };
  const drawLeaf = (modern = true, hft = false, bold = false) => {
    painted.length = 0;
    assert.equal(renderer.renderEquationBox(canvas, { x: 3, y: 7, width: 10, height: 10, baseline: 10,
      kind: { type: 'text', text: '□' } }, 0, 0, '#000000', 10, 'HYhwpEQ',
    true, bold, 0, { remainingNodes: 10, modernHy: modern, hft }), true);
    assert.equal(painted.length, 1); return painted[0];
  };
  const outlineLeaf = () => {
    const glyphs: number[] = [], skews: number[] = [];
    let pathCount = 0;
    setSfntGlyphPathApi((_bytes: Uint8Array, _face: number, glyph: number) => {
      glyphs.push(glyph); return 'M50 0 L500 0 L500 -700 Z';
    });
    try {
      assert.equal(renderer.renderEquationBox({ save() {}, restore() {}, translate() {}, scale() {},
        skew(value: number) { skews.push(value); }, drawPath() { pathCount++; },
        drawText() { assert.fail('proven outline should not use a mask'); },
      }, { x: 3, y: 7, width: 10, height: 10, baseline: 10, kind: { type: 'text', text: '□' } },
      0, 0, '#000000', 10, 'HYhwpEQ', true, false, 0, { remainingNodes: 10, modernHy: true, hft: false }), true);
      assert.deepEqual(glyphs, [3]); assert.deepEqual(skews, []); assert.equal(pathCount, 1);
    } finally { setSfntGlyphPathApi(null); }
  };
  try {
    assert.equal(measure('HYhwpEQ', '□', 10, false, false, false), null);
    await register('HYhwpEQ', syntheticFont('A', 1, 600));
    await register('Times New Roman', syntheticFont('□∆′″', 2, 400));
    await renderer.prepareLocalFonts(['HYhwpEQ']);
    const timesFace = draw('□').face;
    assert.equal(painted[0].glyph, 2);
    assert.equal(measure('HYhwpEQ', '□', 10, false, false, false), null);

    delayLoad = true;
    const pending = register('Haansoft Batang', syntheticFont('□∆′″', 3, 800));
    assert.ok(finishLoad);
    assert.equal(measure('HYhwpEQ', '□', 10, false, false, false), null, 'unloaded face cannot supply coverage');
    assert.equal(draw('□').face, timesFace);
    delayLoad = false; finishLoad!(); await pending;
    await renderer.prepareLocalFonts(['HYhwpEQ']);
    const batangFace = draw('□').face;
    assert.notEqual(batangFace, timesFace);
    assert.equal(drawLeaf().face, batangFace, 'production text leaf suppresses inherited math italics on the covering fallback');
    assert.equal(painted[0].skew, 0);
    outlineLeaf();
    assert.equal(drawLeaf(true, false, true).bold, true, 'upright fallback retains the bold request');
    for (const symbol of '□∆′″') {
      const selected = draw(symbol);
      assert.equal(selected.face, batangFace); assert.equal(selected.glyph, 3);
      assert.equal(selected.width, 8); assert.equal(selected.x, 3); assert.equal(selected.y, 17);
      assert.deepEqual(measure('HYhwpEQ', symbol, 10, false, false, false), { advance: 7.2, inkLeft: 0.5, inkRight: 5 });
    }
    assert.equal(draw('□', false).face, timesFace, 'legacy mode keeps its prior fallback');
    assert.equal(draw('□', false, true).face, timesFace, 'HFT fallback remains separate');
    const mixed = measure('HYhwpEQ', 'A□A', 10, false, false, true);
    assert.ok(mixed); assert.ok(Math.abs(mixed.advance - 18) < 1e-9); assert.ok(Math.abs(mixed.inkRight - 17.6) < 1e-9);
    const advances = [...'A□A'].map(ch => measure('HYhwpEQ', ch, 10, false, false, true).advance);
    painted.length = 0;
    assert.equal(renderer.renderEquationBox(canvas, { x: 3, y: 7, width: mixed.advance, height: 10, baseline: 10,
      glyphAdvances: advances, kind: { type: 'text', text: 'A□A' } }, 0, 0, '#000000', 10, 'HYhwpEQ',
    false, false, 0, { remainingNodes: 10, modernHy: true, hft: false }), true);
    assert.deepEqual(painted.map(({ glyph, x, y, width }) => [glyph, x, y, width]), [
      [1, 3, 17, 6], [3, 3 + advances[0], 17, 8], [1, 3 + (advances[0] + advances[1]), 17, 6],
    ], 'layout advances place natural-size glyphs once without stretching fallback ink');

    await register('Haansoft Batang', syntheticFont('□∆′″', 4, 1000, true), 'imported', 'Italic');
    await renderer.prepareLocalFonts(['HYhwpEQ']);
    assert.equal(drawLeaf().face, batangFace, 'distinct italic sibling must not override the upright fallback');
    assert.equal(painted[0].glyph, 3); assert.equal(painted[0].skew, 0);
    outlineLeaf();
    const italicFace = draw('□', true, false, true).face;
    assert.notEqual(italicFace, batangFace); assert.equal(painted[0].glyph, 4);
    assert.deepEqual(measure('HYhwpEQ', '□', 10, true, false, false), { advance: 9, inkLeft: 0.5, inkRight: 5 });
    assert.equal(draw('□').face, batangFace, 'regular and actual italic candidates keep separate caches');
    assert.deepEqual(measure('HYhwpEQ', '□', 10, false, false, false), { advance: 7.2, inkLeft: 0.5, inkRight: 5 });

    await register('Haansoft Batang', syntheticFont('□∆′″', 4, 1000));
    await renderer.prepareLocalFonts(['HYhwpEQ']);
    assert.notEqual(draw('□').face, batangFace); assert.equal(painted[0].glyph, 4);
    assert.deepEqual(measure('HYhwpEQ', '□', 10, false, false, false), { advance: 9, inkLeft: 0.5, inkRight: 5 });

    await register('HYhwpEQ', syntheticFont('A□∆′″', 1, 600));
    await renderer.prepareLocalFonts(['HYhwpEQ']);
    assert.equal(draw('□').glyph, 1, 'covered source survives a covering Haansoft and Times');
    assert.equal(drawLeaf().glyph, 1, 'source-covered text keeps the source policy');
    assert.ok(Math.abs(painted[0].skew + 0.2) < 1e-6);
    assert.deepEqual(measure('HYhwpEQ', '□', 10, false, false, false), { advance: 5.4, inkLeft: 0.5, inkRight: 5 });

    await register('HYhwpEQ', syntheticFont('A', 1, 600));
    await register('Haansoft Batang', syntheticFont('V', 3, 800));
    await renderer.prepareLocalFonts(['HYhwpEQ']);
    assert.equal(draw('□').face, timesFace, 'uncovered replacement restores generic fallback');
    assert.equal(drawLeaf().face, italicFace, 'covering italic sibling remains available after only upright replacement');
    assert.equal(painted[0].glyph, 4); assert.equal(painted[0].skew, 0);
    await register('Haansoft Batang', syntheticFont('V', 4, 1000, true), 'imported', 'Italic');
    await renderer.prepareLocalFonts(['HYhwpEQ']);
    assert.equal(drawLeaf().face, timesFace);
    assert.ok(Math.abs(painted[0].skew + 0.2) < 1e-6, 'uncovered fallback retains inherited math italics');
    assert.equal(drawLeaf(false).face, timesFace);
    assert.ok(Math.abs(painted[0].skew + 0.2) < 1e-6, 'legacy fallback keeps its style');
    assert.equal(drawLeaf(false, true).face, timesFace);
    assert.equal(painted[0].skew, 0, 'HFT Unicode literals retain their upright ordinary-font policy');
    assert.equal(draw('□', false, true, true).face, timesFace);
    assert.ok(Math.abs(painted[0].skew + 0.2) < 1e-6, 'HFT nonliteral fallback keeps its inherited italic style');
    assert.equal(measure('HYhwpEQ', '□', 10, false, false, false), null);

    local.resetLocalFontsForTests(); renderer.resetDocumentResources();
    assert.equal(measure('HYhwpEQ', '□', 10, false, false, false), null, 'unload clears positive coverage');
    await register('HYhwpEQ', syntheticFont('A', 1, 600));
    const desktop = await register('Haansoft Batang', syntheticFont('□∆′″', 3, 800), 'desktop');
    const retained = local.getImportedLocalFontBytes('Haansoft Batang');
    assert.ok(retained); assert.ok(retained.byteLength < desktop.bytes.byteLength);
    assert.equal(local.getSessionLocalFontFace(local.localFontFaceKey(desktop.record)).bytes, null);
    assert.equal(sfntCoversText(retained, '□'), true);
    assert.equal(sfntTrueTypeRunMetrics(retained, '□', 10), null, 'desktop retention excludes outlines');
    assert.deepEqual(measure('HYhwpEQ', '□', 10, false, false, false), { advance: 7.2, inkLeft: 0.5, inkRight: 5 });
    assert.deepEqual(cssMeasurements.at(-1), ['□', `10.000px "${desktop.record.runtimeFamily}"`]);
    local.resetLocalFontsForTests(); renderer.resetDocumentResources();
    await register('HYhwpEQ', syntheticFont('A', 1, 600));
    await register('Haansoft Batang', syntheticFont('□∆′″', 4, 1000, true), 'imported', 'Italic');
    await register('Haansoft Batang', syntheticFont('□∆′″', 3, 800));
    await renderer.prepareLocalFonts(['HYhwpEQ']);
    assert.equal(drawLeaf().glyph, 3, 'upright selection survives reversed face registration order');
    assert.equal(painted[0].skew, 0); outlineLeaf();

    local.resetLocalFontsForTests(); renderer.resetDocumentResources();
    await register('HYhwpEQ', syntheticFont('A', 1, 600));
    const localized = await register('한컴바탕', syntheticFont('′', 3, 800), 'imported', 'Regular',
      ['Haansoft Batang', 'Haansoft Batang Regular']);
    assert.equal(local.resolveLocalFont('Haansoft Batang'), localized.record);
    assert.equal(localized.record.family, '한컴바탕', 'English alias keeps the actual canonical family');
    await renderer.prepareLocalFonts(['HYhwpEQ']);
    const selectedPrime = draw('′');
    assert.equal(selectedPrime.face, renderer.localTypefaces.get(local.localFontFaceKey(localized.record)).typeface,
      'CanvasKit PRIME and callback bytes belong to the same registered localized face');
    assert.equal(selectedPrime.glyph, 3); assert.equal(selectedPrime.width, 8);
    assert.equal(selectedPrime.skew, 0); assert.equal(selectedPrime.bold, false);
    for (const literal of [false, true]) {
      assert.deepEqual(measure('HYhwpEQ', '′', 10, false, false, literal),
        { advance: 7.2, inkLeft: 0.5, inkRight: 5 }, 'localized PRIME keeps natural fallback ink');
    }
  } finally {
    renderer.dispose(); setSfntGlyphPathApi(null); local.resetLocalFontsForTests(); Object.assign(globals, previous); await vite.close();
  }
});
