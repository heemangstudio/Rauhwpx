import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import CanvasKitInit from 'canvaskit-wasm';
import { createTestModuleServer } from './support/module-server.ts';

test('modern HY radical parts share the source anchor while legacy and HFT anchors remain stable', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const face = kit.Typeface.MakeFreeTypeFaceFromData(fs.readFileSync(new URL('../../tests/fixtures/fonts/HYhwpEQSourceFixture.ttf', import.meta.url)));
  assert.ok(face);
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null, null);
    renderer.findPreparedTypeface = () => ({ typeface: face });
    for (const size of [8, 12, 16]) {
      const body = { x: size, y: 3, width: 20, height: size, baseline: size * 0.8,
        kind: { type: 'row', children: [] } };
      const box = { x: 10, y: 4, width: size + 20, height: size + 3,
        baseline: size * 0.8, kind: { type: 'sqrt', body } };
      const replay = (modernHy: boolean, hft = false) => {
        const anchors: number[][] = [];
        const canvas = { save() {}, restore() {}, scale() {}, drawText() {},
          translate: (x: number, y: number) => anchors.push([x, y]) };
        assert.equal(renderer.renderEquationBox(canvas, box, 0, 0, '#000000', size,
          'HYhwpEQ', false, false, 0, { remainingNodes: 100, modernHy, hft }), true);
        assert.equal(anchors.length, 2, 'both prepared radical glyph parts are painted');
        return anchors;
      };
      const legacy = replay(false), modern = replay(true);
      for (let part = 0; part < 2; part++) {
        assert.equal(modern[part][0], legacy[part][0], 'the shared anchor changes no horizontal geometry');
        assert.ok(Math.abs(modern[part][1] - legacy[part][1] - size * 0.05) < 1e-6,
          'Source radical sign and bar move together by the measured 0.05em');
      }
      assert.deepEqual(replay(true, true), replay(false, true), 'HFT radical geometry keeps its own anchor');
    }
  } finally {
    face.delete();
    await vite.close();
  }
});

test('modern HY CJK replay uses the prepared source fallback and preserves missing-face fallback', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const load = (name: string) => kit.Typeface.MakeFreeTypeFaceFromData(fs.readFileSync(new URL(`../../assets/fonts/${name}`, import.meta.url)));
  const sourceFace = load('NotoSerifKR-Regular.woff2');
  const fallbackFace = load('NotoSansKR-Regular.woff2');
  const mathFace = load('LatinModernMath-Regular.woff2');
  const surface = kit.MakeSurface(80, 50);
  assert.ok(sourceFace && fallbackFace && mathFace && surface);
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const { createOutlineSkiaFont } = await vite.ssrLoadModule('/src/core/skia-font.ts');
    const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null, null);
    const prepared = new Map([['HYhwpEQ', mathFace], ['Haansoft Batang', sourceFace], ['Noto Serif KR', fallbackFace]]);
    renderer.findPreparedTypeface = (name: string) => {
      const typeface = prepared.get(name);
      return typeface ? { typeface } : null;
    };
    const canvas = surface.getCanvas();
    const pixels = () => {
      const result = canvas.readPixels(0, 0, { width: 80, height: 50,
        colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
      assert.ok(result);
      return result;
    };
    const render = (modern: boolean, text = '한') => {
      canvas.clear(kit.WHITE);
      assert.equal(renderer.drawEquationText(canvas, text, 10, 30, 20, '#000000',
        false, false, 20, false, 'HYhwpEQ', false, true, modern), true);
      return pixels();
    };
    const reference = (face: NonNullable<typeof sourceFace>) => {
      canvas.clear(kit.WHITE);
      const font = createOutlineSkiaFont(kit, face, 20);
      const paint = new kit.Paint();
      try {
        paint.setAntiAlias(true); paint.setColor(kit.BLACK);
        canvas.drawText('한', 10, 30, paint, font);
        return pixels();
      } finally { font.delete(); paint.delete(); }
    };
    assert.deepEqual(render(true), reference(sourceFace));
    assert.deepEqual(render(false), reference(fallbackFace));
    assert.notDeepEqual(reference(sourceFace), reference(fallbackFace));
    assert.deepEqual(render(true, 'x'), render(false, 'x'), 'Latin replay keeps the equation font chain');
    prepared.delete('Haansoft Batang'); renderer.equationTypefaces.clear();
    assert.deepEqual(render(true), reference(fallbackFace), 'an unavailable source fallback retains CJK ink');
    prepared.set('Haansoft Batang', mathFace); renderer.equationTypefaces.clear();
    assert.deepEqual(render(true), reference(fallbackFace), 'a face missing the CJK glyph is skipped');
  } finally {
    surface.delete(); sourceFace.delete(); fallbackFace.delete(); mathFace.delete(); await vite.close();
  }
});

test('dotted tab leaders preserve their leading bearing and trailing phase', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const surface = kit.MakeSurface(160, 80);
  assert.ok(surface);
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null, null);
    const canvas = surface.getCanvas();
    const render = (endX: number) => {
      canvas.clear(kit.WHITE);
      renderer.renderTabLeader(canvas, {
        type: 'tabLeader', bbox: { x: 10, y: 10, width: 130, height: 40 },
        baseline: 36, fontSize: 16, rotation: 0, isVertical: false,
        color: '#000000', leadersComplete: true,
        leaders: [{ startX: 20, endX, fillType: 3 }],
      });
      const pixels = canvas.readPixels(0, 0, { width: 160, height: 80,
        colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
      assert.ok(pixels);
      return pixels;
    };
    const pixels = render(100);
    const red = (x: number, y: number) => pixels[(y * 160 + x) * 4];
    assert.equal(red(31, 40), 255, 'the leader leaves space beside the preceding text');
    assert.ok(red(41, 40) < 100 && red(45, 40) < 100, 'dots repeat at a quarter-em pitch');
    assert.equal(red(43, 40), 255, 'dot gaps remain open');
    assert.ok(red(113, 40) < 100, 'the last dot keeps its end-aligned phase');
    assert.ok(render(23).every(value => value === 255), 'a span narrower than the bearing has no dots');
  } finally {
    surface.delete();
    await vite.close();
  }
});

test('equation NOT paints a diagonal slash instead of an overbar', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const surface = kit.MakeSurface(100, 60);
  assert.ok(surface);
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null, null);
    const canvas = surface.getCanvas();
    canvas.clear(kit.WHITE);
    assert.equal(renderer.drawEquationDecoration(canvas, 'strikeThrough', 50, 10, 20, '#000000', 20), true);
    const pixels = canvas.readPixels(0, 0, { width: 100, height: 60,
      colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
    assert.ok(pixels);
    const red = (x: number, y: number) => pixels[(y * 100 + x) * 4];
    assert.ok(red(45, 27) < 220 && red(55, 17) < 220, 'slash crosses the operand diagonally');
    assert.equal(red(50, 11), 255, 'NOT does not add a horizontal accent above the operand');
  } finally {
    surface.delete();
    await vite.close();
  }
});

test('CanvasKit scales glyph ink without scaling saved positions and paints offset shadows', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const face = kit.Typeface.MakeFreeTypeFaceFromData(fs.readFileSync(new URL('../../assets/fonts/NotoSansKR-Regular.woff2', import.meta.url)));
  const surface = kit.MakeSurface(100, 70);
  assert.ok(face && surface);
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, face, null);
    const canvas = surface.getCanvas();
    const op = { type: 'textRun', text: 'HH', bbox: { x: 10, y: 10, width: 60, height: 32 }, baseline: 32, positions: [0, 30, 60], style: { fontSize: 32, color: '#000000' } };
    const render = (style: object, overrides: object = {}) => {
      canvas.clear(kit.WHITE);
      renderer.renderTextRun(canvas, { ...op, ...overrides, style: { ...op.style, ...style } });
      const pixels = canvas.readPixels(0, 0, { width: 100, height: 70, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
      assert.ok(pixels);
      return pixels;
    };
    const bounds = (pixels: Uint8Array | Float32Array, left: number, right: number) => {
      const xs: number[] = [];
      for (let y = 0; y < 70; y++) for (let x = left; x < right; x++) {
        const at = (y * 100 + x) * 4;
        if (pixels[at] < 100 && pixels[at + 1] < 100) xs.push(x);
      }
      assert.ok(xs.length);
      return { left: Math.min(...xs), width: Math.max(...xs) - Math.min(...xs) + 1 };
    };
    const plain = render({ ratio: 1 });
    const stroked = render({ bold: true, fauxBoldStrokeWidth: 0.8 });
    const { createOutlineSkiaFont: makeStrokeFont } = await vite.ssrLoadModule('/src/core/skia-font.ts');
    const strokeFont = makeStrokeFont(kit, face, 32);
    const strokePaint = new kit.Paint();
    try {
      strokePaint.setAntiAlias(true);
      strokePaint.setColor(kit.BLACK);
      strokePaint.setStrokeWidth(0.8);
      canvas.clear(kit.WHITE);
      canvas.drawGlyphs(strokeFont.getGlyphIDs('HH', 2), new Float32Array([0, 0, 30, 0]), 10, 42, strokeFont, strokePaint);
      strokePaint.setStyle(kit.PaintStyle.Stroke);
      canvas.drawGlyphs(strokeFont.getGlyphIDs('HH', 2), new Float32Array([0, 0, 30, 0]), 10, 42, strokeFont, strokePaint);
      assert.deepEqual(stroked, canvas.readPixels(0, 0, {
        width: 100, height: 70, colorType: kit.ColorType.RGBA_8888,
        alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB,
      }), 'synthetic bold uses the regular face with the engine stroke and saved positions');
    } finally {
      strokePaint.delete(); strokeFont.delete();
    }
    const narrow = render({ ratio: 0.5 });
    assert.ok(bounds(narrow, 10, 40).width < bounds(plain, 10, 40).width * 0.7);
    assert.equal(bounds(narrow, 40, 70).left - bounds(narrow, 10, 40).left, 30, 'saved glyph origins remain unchanged');
    const shadow = render({ ratio: 0.5, shadowType: 1, shadowColor: '#ff0000', shadowOffsetX: 3, shadowOffsetY: 2 });
    let red = 0;
    for (let at = 0; at < shadow.length; at += 4) if (shadow[at] > shadow[at + 1] + 60) red++;
    assert.ok(red > 20, 'colored shadow is drawn beneath original text');
    assert.deepEqual(render({ ratio: 0.5 }), narrow, 'shadow translation and paint do not leak');
    assert.ok(!renderer.unsupportedOps.has('textRun:ratioTextEffect'));
    assert.ok(!renderer.unsupportedOps.has('textRun:shadowTextEffect'));
    const boxed = { text: String.fromCodePoint(0xF02B1, 0xF02B2) };
    const boxedPlain = render({ ratio: 1 }, boxed);
    const boxedNarrow = render({ ratio: 0.5 }, boxed);
    assert.ok(bounds(boxedNarrow, 8, 38).width < bounds(boxedPlain, 8, 38).width * 0.7,
      'boxed fallback scales both enclosure and numeral');
    assert.equal(bounds(boxedNarrow, 38, 68).left - bounds(boxedNarrow, 8, 38).left, 30);
    for (const ones of [0, 1, 2]) {
      canvas.clear(kit.WHITE);
      renderer.unsupportedOps.clear();
      renderer.renderCharOverlap(canvas, {
        ...op, text: String.fromCodePoint(0xF02BA, 0xF02C3 + ones),
        positions: [0, 16, 32], positionsComplete: true, rotation: 0,
        charOverlap: { borderType: 0, innerCharSize: -3 },
      });
      const pixels = canvas.readPixels(0, 0, { width: 100, height: 70, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
      assert.ok(pixels);
      assert.ok(!renderer.unsupportedOps.has('textRun:glyphMapping'), 'boxed 10–12 markers decode both PUA components');
      assert.ok(bounds(pixels, 8, 38).width > 15, 'the decoded number keeps its enclosing square');
    }
    const { createOutlineSkiaFont } = await vite.ssrLoadModule('/src/core/skia-font.ts');
    const shapeFont = createOutlineSkiaFont(kit, face, 32);
    const innerFont = createOutlineSkiaFont(kit, face, 25.6);
    const shapePaint = new kit.Paint();
    const innerPaint = new kit.Paint();
    try {
      shapePaint.setAntiAlias(true); shapePaint.setColor(kit.BLACK);
      innerPaint.setAntiAlias(true); innerPaint.setColor(kit.WHITE);
      canvas.clear(kit.WHITE);
      renderer.renderCharOverlap(canvas, {
        ...op, type: 'charOverlap', text: '3', positions: [0, 32], positionsComplete: true,
        rotation: 0, isVertical: false, charOverlap: { borderType: 4, innerCharSize: -2 },
      });
      const actual = canvas.readPixels(0, 0, { width: 100, height: 70, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
      canvas.clear(kit.WHITE);
      const shapeIds = shapeFont.getGlyphIDs('■', 1);
      assert.ok(shapeIds[0], 'the bundled face provides its square glyph');
      const shapeWidth = shapeFont.getGlyphWidths(shapeIds)[0];
      const digitWidth = innerFont.getGlyphWidths(innerFont.getGlyphIDs('3', 1))[0];
      canvas.drawText('■', 26 - shapeWidth / 2, 42, shapePaint, shapeFont);
      canvas.drawText('3', 26 - digitWidth / 2, 42 - 32 * 0.35 + 25.6 * 0.35, innerPaint, innerFont);
      const expected = canvas.readPixels(0, 0, { width: 100, height: 70, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
      assert.deepEqual(actual, expected, 'overlap enclosures use the source face glyph and baseline');
    } finally {
      innerPaint.delete(); shapePaint.delete(); innerFont.delete(); shapeFont.delete();
    }
    render({ ratio: 0.5, shadowType: 1 }, { charOverlap: { borderType: 0, innerCharSize: 0 } });
    assert.ok(renderer.unsupportedOps.has('textRun:ratioTextEffect'));
    assert.ok(renderer.unsupportedOps.has('textRun:shadowTextEffect'));
    const { setHftWasmApi } = await vite.ssrLoadModule('/src/core/hft-glyphs.ts');
    setHftWasmApi({
      register: () => true,
      glyphPath: () => 'M0 -700 L500 -700 L500 0 L0 0 Z',
    });
    try {
      const plainHft = render({ hftFamily: 'Test HFT', bold: false }, { text: 'H', positions: undefined });
      const boldHft = render({ hftFamily: 'Test HFT', bold: true }, { text: 'H', positions: undefined });
      assert.deepEqual(boldHft, plainHft, 'HFT outlines render without synthetic bold even without layout positions');
      assert.deepEqual(render({ hftFamily: 'Test HFT', bold: true, fauxBoldStrokeWidth: 0.8 }, {
        text: 'H', positions: undefined,
      }), plainHft, 'explicit HFT outlines remain filled without fallback TTF bold strokes');
      assert.ok(bounds(plainHft, 10, 40).width >= 10, 'HFT path is painted without layout positions');
      const tabbedHft = render({ hftFamily: 'Test HFT' }, { text: '\tH', positions: [0, 30, 60] });
      const shiftedHft = render({ hftFamily: 'Test HFT' }, {
        text: 'H', positions: [0, 30], bbox: { ...op.bbox, x: 40, width: 30 },
      });
      assert.deepEqual(tabbedHft, shiftedHft, 'tabs advance without painting control glyphs');
      const verticalOp = { text: '데', positions: [0, 32], isVertical: true };
      const verticalPlain = render({ hftFamily: 'Test HFT', bold: false }, verticalOp);
      const verticalCopy = render({ hftFamily: 'Test HFT', bold: false }, {
        ...verticalOp, hftVerticalBoldCopy: { offsetY: 16, emboldenX: 2 },
      });
      let addedBelow = 0;
      let addedRight = 0;
      for (let y = 0; y < 70; y++) for (let x = 0; x < 100; x++) {
        const at = (y * 100 + x) * 4;
        if (verticalCopy[at] < 100 && verticalPlain[at] >= 100) {
          if (y > 42) addedBelow++;
          if (x > 25) addedRight++;
        }
        if (verticalPlain[at] < 100) assert.ok(verticalCopy[at] < 100, 'the original HFT ink remains');
      }
      assert.ok(addedBelow > 100 && addedRight > 20, 'engine metadata adds the lower, wider HFT copy');
      assert.deepEqual(render({ hftFamily: 'Test HFT', bold: false }, verticalOp), verticalPlain,
        'copy transforms do not leak into later runs');
      const parenOp = { text: '(', positions: [0, 32], isVertical: true };
      const parenPlain = render({ hftFamily: 'Test HFT' }, parenOp);
      const rotatedCopy = render({ hftFamily: 'Test HFT' }, {
        ...parenOp, hftVerticalBoldCopy: { offsetX: -1, offsetY: 1, emboldenX: 2, rotation: 90 },
      });
      render({ hftFamily: 'Test HFT' }, parenOp);
      const path = kit.Path.MakeFromSVGString('M0 -700 L500 -700 L500 0 L0 0 Z');
      const paint = new kit.Paint();
      assert.ok(path);
      try {
        paint.setAntiAlias(true); paint.setColor(kit.BLACK);
        canvas.save(); canvas.translate(9, 43); canvas.rotate(90, 0, 0);
        try {
          for (let step = 0; step <= 5; step++) {
            canvas.save(); canvas.translate(2 * step / 5, 0); canvas.scale(32 / 1000, 32 / 1000);
            canvas.drawPath(path, paint); canvas.restore();
          }
        } finally { canvas.restore(); }
        const expected = canvas.readPixels(0, 0, { width: 100, height: 70, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
        assert.deepEqual(rotatedCopy, expected, 'parenthesis copies rotate around the glyph baseline before scaling');
      } finally { path.delete(); paint.delete(); }
      assert.deepEqual(render({ hftFamily: 'Test HFT' }, {
        ...parenOp, hftVerticalBoldCopy: { offsetY: 1, emboldenX: 2, rotation: NaN },
      }), parenPlain, 'invalid copy transforms do not alter glyphs');
      assert.deepEqual(render({ hftFamily: 'Test HFT' }, parenOp), parenPlain,
        'copy rotation is restored for subsequent text');
      setHftWasmApi({ register: () => false, glyphPath: () => null });
      const fallbackPlain = render({ hftFamily: 'Rejected HFT', bold: false }, verticalOp);
      const fallbackCopy = render({ hftFamily: 'Rejected HFT', bold: false }, {
        ...verticalOp, hftVerticalBoldCopy: { offsetY: 16, emboldenX: 2 },
      });
      let fallbackAdded = 0;
      for (let at = 0; at < fallbackCopy.length; at += 4) {
        if (fallbackCopy[at] < 100 && fallbackPlain[at] >= 100) fallbackAdded++;
        if (fallbackPlain[at] < 100) assert.ok(fallbackCopy[at] < 100, 'resolved fallback ink remains');
      }
      assert.ok(fallbackAdded > 100, 'rejected HFT banks copy the actual resolved TTF glyph');
    } finally {
      setHftWasmApi(null);
    }
    renderer.equationTypeface = face;
    const renderLeaf = (parentSize: number, text = 'H') => {
      canvas.clear(kit.WHITE);
      assert.equal(renderer.renderEquationBox(canvas, {
        x: 10, y: 4, width: 12, height: 14, baseline: 11,
        kind: { type: 'text', text },
      }, 0, 0, '#000000', parentSize, 'Latin Modern Math', false, false, 0,
      { remainingNodes: 100, hft: false }), true);
      const pixels = canvas.readPixels(0, 0, { width: 100, height: 70, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
      assert.ok(pixels);
      assert.ok(bounds(pixels, 10, 40).width > 0);
      return pixels;
    };
    assert.deepEqual(renderLeaf(32), renderLeaf(14), 'equation leaves preserve their measured em inside larger parent boxes');
    const leafParen = renderLeaf(14, '(');
    canvas.clear(kit.WHITE);
    assert.equal(renderer.renderEquationBox(canvas, {
      x: 10, y: 4, width: 12, height: 14, baseline: 11,
      kind: { type: 'paren', left: '(', right: '', body: {
        x: 0, y: 0, width: 0, height: 14, baseline: 11, kind: { type: 'row', children: [] },
      } },
    }, 0, 0, '#000000', 14, 'Latin Modern Math', false, false, 0,
    { remainingNodes: 100, hft: false }), true);
    const smallParen = canvas.readPixels(0, 0, { width: 100, height: 70, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
    assert.deepEqual(smallParen, leafParen, 'ordinary equation brackets share the adjacent leaves’ em, baseline, and glyph origin');
    for (const height of [14, 42]) {
      canvas.clear(kit.WHITE);
      const slot = 14 * 0.333, width = 20 + 2 * slot;
      assert.equal(renderer.renderEquationBox(canvas, {
        x: 10, y: 4, width, height, baseline: 11,
        kind: { type: 'paren', left: '|', right: '|', body: {
          x: slot, y: 0, width: 20, height, baseline: 11, kind: { type: 'row', children: [] },
        } },
      }, 0, 0, '#000000', 14, 'Latin Modern Math', false, false, 0,
      { remainingNodes: 100, hft: false }), true);
      const actual = canvas.readPixels(0, 0, { width: 100, height: 70, colorType: kit.ColorType.RGBA_8888,
        alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
      canvas.clear(kit.WHITE);
      const paint = new kit.Paint();
      try {
        paint.setColor(kit.BLACK); paint.setAntiAlias(true);
        paint.setStyle(kit.PaintStyle.Stroke); paint.setStrokeWidth(14 * 0.04);
        for (const x of [10 + slot / 2, 10 + width - slot / 2]) canvas.drawLine(x, 4, x, 4 + height, paint);
        const expected = canvas.readPixels(0, 0, { width: 100, height: 70, colorType: kit.ColorType.RGBA_8888,
          alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
        assert.deepEqual(actual, expected, 'absolute-value bars stay centered within their layout slots');
      } finally { paint.delete(); }
    }
    for (const fontSize of [8, 12, 16]) {
      for (const height of [fontSize, fontSize * 3]) {
        for (const [left, right] of [['|', '|'], ['|', ''], ['', '|']]) {
          canvas.clear(kit.WHITE);
          const slot = fontSize / 2;
          const width = 20 + (left ? slot : 0) + (right ? slot : 0);
          assert.equal(renderer.renderEquationBox(canvas, {
            x: 10, y: 4, width, height, baseline: fontSize * 0.8,
            kind: { type: 'paren', left, right, body: {
              x: left ? slot : 0, y: 0, width: 20, height, baseline: fontSize * 0.8,
              kind: { type: 'row', children: [] },
            } },
          }, 0, 0, '#000000', fontSize, 'HYhwpEQ', false, false, 0,
          { remainingNodes: 100, hft: false, modernHy: true }), true);
          const actual = canvas.readPixels(0, 0, { width: 100, height: 70,
            colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul,
            colorSpace: kit.ColorSpace.SRGB });
          canvas.clear(kit.WHITE);
          const paint = new kit.Paint();
          try {
            paint.setColor(kit.BLACK); paint.setAntiAlias(true);
            paint.setStyle(kit.PaintStyle.Stroke); paint.setStrokeWidth(Math.max(0.5, fontSize * 0.04));
            const centers = [left ? 10 + fontSize / 4 : null,
              right ? 10 + width - fontSize / 4 : null];
            for (const center of centers) {
              if (center !== null) canvas.drawLine(center, 4, center, 4 + height, paint);
            }
            const expected = canvas.readPixels(0, 0, { width: 100, height: 70,
              colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul,
              colorSpace: kit.ColorSpace.SRGB });
            assert.deepEqual(actual, expected,
              'Source HY bars keep their half-em centers at every body height and font size');
          } finally { paint.delete(); }
        }
      }
    }
    const renderLimit = (parentSize: number) => {
      canvas.clear(kit.WHITE);
      assert.equal(renderer.renderEquationBox(canvas, {
        x: 10, y: 4, width: 40, height: 30, baseline: 16,
        kind: { type: 'limit', isUpper: false },
      }, 0, 0, '#000000', parentSize, 'Latin Modern Math', false, false, 0,
      { remainingNodes: 100, hft: false }), true);
      return canvas.readPixels(0, 0, { width: 100, height: 70, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
    };
    assert.deepEqual(renderLimit(14), renderLimit(32), 'limit names preserve the em encoded by their baseline');
    const renderLimitSub = (italic: boolean, roman = false, offsets: { nameX?: number; nameY?: number } = {}) => {
      canvas.clear(kit.WHITE);
      const operand = { x: 0, y: 0, width: 10, height: 9.8, baseline: 7.84,
        kind: { type: 'text', text: 'x' } };
      const sub = { ...operand, y: 20,
        kind: roman ? { type: 'fontStyle', fontStyle: 'roman', body: operand } : operand.kind };
      assert.equal(renderer.renderEquationBox(canvas, {
        x: 10, y: 4, width: 40, height: 40, baseline: 16,
        kind: { type: 'limit', isUpper: false, sub, ...offsets },
      }, 0, 0, '#000000', 14, 'Latin Modern Math', italic, false, 0,
      { remainingNodes: 100, hft: false }), true);
      return canvas.readPixels(0, 0, { width: 100, height: 70, colorType: kit.ColorType.RGBA_8888,
        alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
    };
    assert.notDeepEqual(renderLimitSub(true), renderLimitSub(false),
      'limit operands inherit the surrounding variable style');
    assert.deepEqual(renderLimitSub(true, true), renderLimitSub(false, true),
      'an explicit roman operand overrides the surrounding italic style');
    const plainLimit = renderLimitSub(true);
    const shiftedLimit = renderLimitSub(true, false, { nameX: 6, nameY: 2 });
    assert.ok(plainLimit && shiftedLimit);
    assert.deepEqual(renderLimitSub(true, false, { nameX: 0, nameY: 0 }), plainLimit,
      'zero label offsets preserve older serialized layouts');
    assert.deepEqual(shiftedLimit.slice(25 * 100 * 4), plainLimit.slice(25 * 100 * 4),
      'moving a limit name preserves the separately positioned subscript');
    for (let y = 0; y < 25; y++) {
      for (let x = 0; x < 100; x++) {
        for (let channel = 0; channel < 4; channel++) {
          const expected = x >= 6 && y >= 2
            ? plainLimit[((y - 2) * 100 + x - 6) * 4 + channel] : 255;
          assert.equal(shiftedLimit[(y * 100 + x) * 4 + channel], expected,
            'label offsets translate the name without changing its font size');
        }
      }
    }
    canvas.clear(kit.WHITE);
    assert.equal(renderer.renderEquationBox(canvas, {
      x: 10, y: 4, width: 36, height: 14, baseline: 11,
      kind: { type: 'row', children: [{ x: 0, y: 0, width: 14, height: 14, baseline: 11,
        kind: { type: 'text', text: '이' } }] },
    }, 0, 0, '#000000', 14, 'HYhwpEQ', false, false, 0,
    { remainingNodes: 100, hft: false }), true, 'an unsupported Korean glyph uses the body font without dropping its equation');
    canvas.clear(kit.WHITE);
    renderer.renderFormObject(canvas, {
      type: 'formObject', formType: 'checkBox', bbox: { x: 10, y: 10, width: 40, height: 20 },
      foreColor: '#0000ff', backColor: '#ffffff', value: false,
    });
    const checkbox = canvas.readPixels(0, 0, { width: 100, height: 70, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
    assert.ok(checkbox);
    const edge = [...checkbox.slice((20 * 100 + 12) * 4, (20 * 100 + 12) * 4 + 3)];
    assert.ok(edge[0] < 255);
    assert.equal(edge[0], edge[1]);
    assert.equal(edge[1], edge[2], 'checkbox borders stay neutral independently of the caption color');
    assert.deepEqual([...checkbox.slice((20 * 100 + 50) * 4, (20 * 100 + 50) * 4 + 3)], [255, 255, 255],
      'checkbox ink occupies the 14px control square rather than the caption allocation');
  } finally { surface.delete(); face.delete(); await vite.close(); }
});

test('tall HY square brackets keep the source em and avoid partial glyph fallback', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const face = kit.Typeface.MakeFreeTypeFaceFromData(fs.readFileSync(new URL('../../assets/fonts/NotoSansKR-Regular.woff2', import.meta.url)));
  const surface = kit.MakeSurface(80, 100);
  assert.ok(face && surface);
  const OriginalFont = kit.Font;
  const mapParts = (text: string) => text.replace(/[\ue100-\ue105]/g, glyph => (
    glyph === '\ue100' || glyph === '\ue103' ? '['
      : glyph === '\ue102' || glyph === '\ue104' ? ']' : '|'
  ));
  let missingMiddle = false;
  // Use portable glyphs to check the renderer without requiring installed HY fonts.
  kit.Font = function (typeface, size) {
    const font = new OriginalFont(typeface, size);
    const glyphs = font.getGlyphIDs.bind(font);
    font.getGlyphIDs = (text, count) => {
      const ids = glyphs(mapParts(text), count);
      if (missingMiddle && /[\ue101\ue105]/.test(text) && ids) ids[1] = 0;
      return ids;
    };
    return font;
  } as typeof kit.Font;
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, face, null);
    renderer.findEquationTypefaces = () => [{ typeface: face, legacy: true }];
    const canvas = surface.getCanvas();
    const drawCanvas = { drawText: (text, x, y, paint, font) => canvas.drawText(mapParts(text), x, y, paint, font) };
    const render = (height: number, left: boolean) => {
      canvas.clear(kit.WHITE);
      const drawn = renderer.drawLegacySquareBracket(drawCanvas, left, 20, 4, height, 16, '#000000', 'HYhwpEQ', { remainingNodes: 100, hft: false });
      const pixels = canvas.readPixels(0, 0, { width: 80, height: 100,
        colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
      assert.ok(pixels);
      const xs: number[] = [], ys: number[] = [];
      for (let y = 0; y < 100; y++) for (let x = 0; x < 80; x++) {
        if (pixels[(y * 80 + x) * 4] < 100) { xs.push(x); ys.push(y); }
      }
      return { drawn, pixels, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    };
    for (const left of [true, false]) {
      const short = render(32, left), tall = render(64, left);
      assert.ok(short.drawn && tall.drawn);
      assert.equal(tall.width, short.width, 'a taller bracket does not get wider');
      assert.ok(tall.height >= short.height + 24, `parts extend the bracket vertically: ${short.height} -> ${tall.height}`);
    }
    missingMiddle = true;
    const missing = render(64, true);
    assert.equal(missing.drawn, false);
    assert.ok(missing.pixels.every(value => value === 255), 'missing parts leave no ink before fallback');
    missingMiddle = false;
    const oversized = render(100000, true);
    assert.equal(oversized.drawn, false, 'bracket parts stay within the equation replay budget');
    assert.ok(oversized.pixels.every(value => value === 255));
    renderer.findEquationTypefaces = () => [];
    assert.equal(render(64, true).drawn, false, 'an absent source face uses the regular fallback');
  } finally {
    kit.Font = OriginalFont;
    surface.delete(); face.delete(); await vite.close();
  }
});
