import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import CanvasKitInit from 'canvaskit-wasm';
import { createTestModuleServer } from './support/module-server.ts';

test('missing glyphs use the Hancom glyph fallback before whole-face substitutions', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const load = (path: string) => kit.Typeface.MakeFreeTypeFaceFromData(fs.readFileSync(new URL(path, import.meta.url)));
  const primary = load('../../tests/fixtures/fonts/RHWPShapingFixture.ttf');
  const hancom = load('../../assets/fonts/NotoSansKR-Regular.woff2');
  const substitution = load('../../assets/fonts/GowunBatang-Regular.woff2');
  const surface = kit.MakeSurface(100, 70);
  assert.ok(primary && hancom && substitution && surface);
  const { configureDesktopFonts } = await vite.ssrLoadModule('/src/core/desktop-fonts.ts');
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    configureDesktopFonts({ metrics: { register: () => '', fallbackFamilies: () => ['Substitution'] } });
    const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, primary, null);
    renderer.findStyledPreparedTypeface = (family: string) => {
      const face = family === 'Primary' ? primary
        : family === 'HCR Dotum' || family === '함초롬돋움' ? hancom
        : family === 'Substitution' ? substitution : null;
      return { prepared: face ? { typeface: face, fontFamily: family, fontManager: null } : null,
        syntheticBold: false, syntheticItalic: false };
    };
    renderer.recordTextRunCoverageGaps = () => {};
    const canvas = surface.getCanvas();
    const render = (fontFamily: string, text: string, hftFamily?: string) => {
      canvas.clear(kit.WHITE);
      renderer.renderTextRun(canvas, {
        type: 'textRun', text, bbox: { x: 10, y: 10, width: 40, height: 36 }, baseline: 36,
        positions: [0, 40], style: { fontFamily, fontSize: 36, color: '#000000', hftFamily },
      });
      const pixels = canvas.readPixels(0, 0, { width: 100, height: 70,
        colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
      assert.ok(pixels);
      return pixels;
    };
    const missing = render('Primary', 'B');
    assert.deepEqual(missing, render('HCR Dotum', 'B'));
    assert.notDeepEqual(missing, render('Substitution', 'B'));
    assert.notDeepEqual(render('Primary', 'A'), render('HCR Dotum', 'A'),
      'glyphs present in the requested face keep that face');
    assert.deepEqual(render('Primary', 'B', 'Unregistered HFT'), render('Substitution', 'B'),
      'HFT fallback banks retain their existing substitution order');
    configureDesktopFonts({ metrics: null });
    renderer.findStyledPreparedTypeface = (family: string) => {
      const face = family === 'Primary' ? primary
        : family === 'Haansoft Batang' ? substitution : null;
      return { prepared: face ? { typeface: face, fontFamily: family, fontManager: null } : null,
        syntheticBold: false, syntheticItalic: false };
    };
    assert.deepEqual(render('Primary', 'B'), render('Haansoft Batang', 'B'),
      'prepared Hancom symbol faces are tried before replacing a missing glyph');
    assert.notDeepEqual(render('Primary', 'A'), render('Haansoft Batang', 'A'),
      'symbol fallback faces do not replace glyphs in the requested face');
  } finally {
    configureDesktopFonts({ metrics: null });
    surface.delete(); primary.delete(); hancom.delete(); substitution.delete(); await vite.close();
  }
});

test('precomposed boxed glyph parts keep their full size and shared baseline', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const bytes = fs.readFileSync(new URL('../../tests/fixtures/fonts/RHWPShapingFixture.ttf', import.meta.url));
  const primary = kit.Typeface.MakeFreeTypeFaceFromData(bytes);
  const fallback = kit.Typeface.MakeFreeTypeFaceFromData(bytes);
  const surface = kit.MakeSurface(100, 70);
  assert.ok(primary && fallback && surface);
  const OriginalFont = kit.Font;
  // 실제 CanvasKit 글리프를 쓰되 테스트 서체에 없는 PUA의 cmap만 대체한다.
  kit.Font = function (face, size) {
    const font = new OriginalFont(face, size);
    if (face === fallback) {
      const glyphs = font.getGlyphIDs.bind(font);
      font.getGlyphIDs = (text, count) => glyphs(text.replaceAll('\u{f02ba}', 'A').replaceAll('\u{f02c3}', '한'), count);
    }
    return font;
  } as typeof kit.Font;
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, primary, null);
    renderer.findStyledPreparedTypeface = (family: string) => ({
      prepared: { typeface: family === 'HCR Dotum' ? fallback : primary, fontFamily: family, fontManager: null },
      syntheticBold: false, syntheticItalic: false,
    });
    const canvas = surface.getCanvas();
    const pixels = () => {
      const result = canvas.readPixels(0, 0, { width: 100, height: 70,
        colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
      assert.ok(result);
      return result;
    };
    const render = (text: string, innerCharSize: number) => {
      canvas.clear(kit.WHITE);
      renderer.renderCharOverlap(canvas, {
        type: 'charOverlap', text, bbox: { x: 10, y: 10, width: 20, height: 25 }, baseline: 20,
        rotation: 0, isVertical: false,
        positions: Array.from({ length: [...text].length + 1 }, (_, i) => i * 20), positionsComplete: true,
        charOverlap: { borderType: 0, innerCharSize },
        style: { fontFamily: 'Primary', fontSize: 20, color: '#000000' },
      });
      return pixels();
    };
    const smallInnerSize = render('\u{f02ba}\u{f02c3}', -3);
    assert.deepEqual(smallInnerSize, render('\u{f02ba}\u{f02c3}', 0));
    canvas.clear(kit.WHITE);
    const font = new OriginalFont(fallback, 20);
    const paint = new kit.Paint();
    try {
      font.setEdging(kit.FontEdging.AntiAlias);
      font.setSubpixel(true);
      font.setHinting(kit.FontHinting.None);
      font.setEmbeddedBitmaps(false);
      font.setLinearMetrics(true);
      paint.setAntiAlias(true);
      paint.setColor(kit.BLACK);
      canvas.drawGlyphs(font.getGlyphIDs('A한', 2), new Float32Array(4), 10, 30, font, paint);
      assert.deepEqual(smallInnerSize, pixels(), 'both parts use the source origin at full em');
    } finally { font.delete(); paint.delete(); }
    assert.notDeepEqual(render('A', -3), render('A', 0), 'ordinary overlap text still honors inner size');
  } finally {
    kit.Font = OriginalFont;
    surface.delete(); primary.delete(); fallback.delete(); await vite.close();
  }
});
