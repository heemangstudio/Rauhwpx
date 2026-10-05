import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import CanvasKitInit from 'canvaskit-wasm';
import { createTestModuleServer } from './support/module-server.ts';
import fs from 'node:fs';

test('CanvasKit preserves dotted borders on lines, shapes, and path line styles', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const surface = kit.MakeSurface(120, 80);
  assert.ok(surface);
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null);
    const canvas = surface.getCanvas();
    const pixels = () => {
      const data = canvas.readPixels(0, 0, { width: 120, height: 80,
        colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
      assert.ok(data);
      return data;
    };
    for (const kind of ['line', 'rectangle', 'path']) {
      canvas.clear(kit.WHITE);
      const bbox = { x: 10, y: 20, width: 100, height: 40 };
      if (kind === 'line') renderer.renderLine(canvas, {
        type: 'line', bbox, x1: 10, y1: 20, x2: 110, y2: 20,
        style: { color: '#000000', width: 2, dash: 'dot' },
      });
      if (kind === 'rectangle') renderer.renderRectangle(canvas, {
        type: 'rectangle', bbox, style: { strokeColor: '#000000', strokeWidth: 2, strokeDash: 'dot' },
      });
      if (kind === 'path') renderer.renderPath(canvas, {
        type: 'path', bbox, commands: [{ type: 'moveTo', x: 10, y: 20 }, { type: 'lineTo', x: 110, y: 20 }],
        lineStyle: { color: '#000000', width: 2, dash: 'dot' },
      });
      const data = pixels();
      const row = Array.from({ length: 92 }, (_, i) => data[(20 * 120 + 14 + i) * 4]);
      assert.ok(row.filter(value => value < 50).length > 15, `${kind} retains visible dots`);
      assert.ok(row.filter(value => value === 255).length > 30, `${kind} retains spaces between dots`);
    }
  } finally {
    surface.delete(); await vite.close();
  }
});

test('CanvasKit text highlights follow saved advances and run placement without shading shadows', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const face = kit.Typeface.MakeFreeTypeFaceFromData(fs.readFileSync(new URL('../../tests/fixtures/fonts/RHWPShapingFixture.ttf', import.meta.url)));
  const surface = kit.MakeSurface(100, 80);
  assert.ok(face && surface);
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, face);
    const canvas = surface.getCanvas();
    const render = (shadeColor: string, shadowType = 0) => {
      canvas.clear(kit.WHITE);
      renderer.renderTextRun(canvas, {
        type: 'textRun', text: 'AA', bbox: { x: 10, y: 20, width: 70, height: 20 },
        baseline: 20, positions: [0, 12, 24],
        placement: { runToPage: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 }, baselineY: 20 },
        style: { fontSize: 20, shadeColor, shadowType, shadowOffsetX: 40, shadowOffsetY: 0 },
      });
      const data = canvas.readPixels(0, 0, { width: 100, height: 80,
        colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
      assert.ok(data);
      return (x: number, y: number) => [...data.slice((y * 100 + x) * 4, (y * 100 + x) * 4 + 4)];
    };
    const highlighted = render('#ffff00', 2);
    assert.deepEqual(highlighted(11, 24), [255, 255, 0, 255]);
    assert.deepEqual(highlighted(33, 24), [255, 255, 0, 255]);
    assert.deepEqual(highlighted(35, 24), [255, 255, 255, 255], 'saved advances determine the highlight width');
    assert.deepEqual(highlighted(51, 24), [255, 255, 255, 255], 'shadow replay does not duplicate the highlight');
    assert.deepEqual(render('#000000')(11, 24), [255, 255, 255, 255], 'black is the legacy no-shading sentinel');
    assert.deepEqual(render('#ffffff')(11, 24), [255, 255, 255, 255]);
  } finally {
    surface.delete(); face.delete(); await vite.close();
  }
});

test('CanvasKit paints an encoded page background underneath its border', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const source = kit.MakeSurface(4, 4);
  const target = kit.MakeSurface(20, 20);
  assert.ok(source && target);
  source.getCanvas().clear(kit.Color(128, 128, 128, 1));
  const image = source.makeImageSnapshot();
  assert.ok(image);
  try {
    const encoded = image.encodeToBytes();
    assert.ok(encoded);
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null);
    const canvas = target.getCanvas();
    canvas.clear(kit.WHITE);
    renderer.renderPageBackground(canvas, {
      type: 'pageBackground', bbox: { x: 2, y: 2, width: 16, height: 16 },
      backgroundColor: '#ffff00', image: { fillMode: 'total', base64: Buffer.from(encoded).toString('base64') },
      borderColor: '#000000', borderWidth: 2,
    });
    const pixels = canvas.readPixels(0, 0, { width: 20, height: 20,
      colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
    assert.ok(pixels);
    const pixel = (x: number, y: number) => [...pixels.slice((y * 20 + x) * 4, (y * 20 + x) * 4 + 4)];
    assert.deepEqual(pixel(10, 10), [128, 128, 128, 255]);
    assert.deepEqual(pixel(2, 10), [0, 0, 0, 255]);
    assert.deepEqual(pixel(0, 0), [255, 255, 255, 255]);
    renderer.resetDocumentResources();
  } finally {
    image.delete(); source.delete(); target.delete(); await vite.close();
  }
});

test('CanvasKit grayscale preserves image alpha and skips baked watermark effects', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const source = kit.MakeSurface(2, 1);
  const target = kit.MakeSurface(6, 1);
  assert.ok(source && target);
  const paint = new kit.Paint();
  paint.setColor(kit.RED);
  source.getCanvas().clear(kit.TRANSPARENT);
  source.getCanvas().drawRect(kit.XYWHRect(0, 0, 1, 1), paint);
  const image = source.makeImageSnapshot();
  assert.ok(image);
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null);
    const canvas = target.getCanvas();
    canvas.clear(kit.WHITE);
    renderer.drawImageOp(canvas, image, { type: 'image', bbox: { x: 0, y: 0, width: 2, height: 1 }, effect: 'grayScale' }, false);
    renderer.drawImageOp(canvas, image, { type: 'image', bbox: { x: 2, y: 0, width: 2, height: 1 }, effect: 'grayScale', opacity: 0.5 }, false);
    renderer.drawImageOp(canvas, image, { type: 'image', bbox: { x: 4, y: 0, width: 2, height: 1 }, effect: 'grayScale', bakedWatermark: true }, false);
    const pixels = canvas.readPixels(0, 0, { width: 6, height: 1, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
    assert.ok(pixels);
    const pixel = (x: number) => [...pixels.slice(x * 4, x * 4 + 4)];
    assert.deepEqual(pixel(0), [76, 76, 76, 255]);
    assert.deepEqual(pixel(1), [255, 255, 255, 255], 'transparent source pixels remain transparent');
    const faded = pixel(2);
    assert.ok(faded[0] >= 165 && faded[0] <= 167);
    assert.equal(faded[0], faded[1]);
    assert.equal(faded[1], faded[2]);
    assert.deepEqual(pixel(4), [255, 0, 0, 255], 'resolved watermark pixels are not filtered twice');
    canvas.clear(kit.WHITE);
    renderer.drawImageOp(canvas, image, {
      type: 'image', bbox: { x: 0, y: 0, width: 8, height: 1 }, effect: 'grayScale',
    }, false);
    const enlarged = canvas.readPixels(0, 0, { width: 6, height: 1, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
    assert.ok(enlarged);
    assert.ok(enlarged[12] > 76 && enlarged[12] < 255,
      `scaled images interpolate color and alpha at source pixel boundaries: ${enlarged[12]}`);
    assert.equal(enlarged[12], enlarged[13]);
    assert.equal(enlarged[13], enlarged[14]);
  } finally {
    image.delete();
    paint.delete();
    source.delete();
    target.delete();
    await vite.close();
  }
});

test('CanvasKit screen rendering preserves subpixel picture border coverage', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const surface = kit.MakeSurface(40, 40);
  assert.ok(surface);
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null);
    const canvas = surface.getCanvas();
    canvas.clear(kit.WHITE);
    renderer.renderRectangle(canvas, {
      type: 'rectangle', bbox: { x: 10.2, y: 10.2, width: 20, height: 20 },
      style: { strokeColor: '#808080', strokeWidth: 0.133 },
    });
    const pixels = canvas.readPixels(0, 0, { width: 40, height: 40, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
    assert.ok(pixels);
    const coverage = [9, 10, 11].map(x => pixels[(20 * 40 + x) * 4]);
    assert.ok(Math.min(...coverage) > 200, 'a fractional gray border stays lighter than a full screen pixel');
    assert.ok(Math.min(...coverage) < 255, 'the border retains visible antialias coverage');
  } finally {
    surface.delete();
    await vite.close();
  }
});

test('CanvasKit picture placement preserves enlarged line contrast and quantizes contained images', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const source = kit.MakeSurface(8, 8);
  const target = kit.MakeSurface(16, 16);
  assert.ok(source && target);
  const paint = new kit.Paint();
  source.getCanvas().clear(kit.WHITE);
  paint.setColor(kit.Color(194, 194, 194, 1));
  source.getCanvas().drawRect(kit.XYWHRect(0, 3, 8, 1), paint);
  paint.setAntiAlias(true);
  const image = source.makeImageSnapshot();
  assert.ok(image);
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null);
    const canvas = target.getCanvas();
    const pixels = () => {
      const data = canvas.readPixels(0, 0, { width: 16, height: 16, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
      assert.ok(data);
      return data;
    };
    const render = (x: number, size: number, fillMode = 'fitToSize') => {
      canvas.clear(kit.TRANSPARENT);
      renderer.drawImageOp(canvas, image, { type: 'image', bbox: { x, y: x, width: size, height: size }, fillMode });
      return pixels();
    };
    const enlarged = render(1.1, 9.2);
    canvas.clear(kit.TRANSPARENT);
    canvas.drawImageRectOptions(image, kit.XYWHRect(0, 0, 8, 8), kit.XYWHRect(1, 1, 10, 10),
      kit.FilterMode.Linear, kit.MipmapMode.None, paint);
    assert.deepEqual(enlarged, pixels());
    canvas.clear(kit.TRANSPARENT);
    canvas.drawImageRectOptions(image, kit.XYWHRect(0, 0, 8, 8), kit.XYWHRect(1.1, 1.1, 9.2, 9.2),
      kit.FilterMode.Linear, kit.MipmapMode.None, paint);
    const unsnapped = pixels();
    const sample = (5 * 16 + 5) * 4;
    assert.ok(enlarged[sample] < unsnapped[sample], 'enlarged thin lines retain more contrast');
    assert.ok(enlarged[sample] < 210);
    const contained = render(1.1, 9.21, 'none');
    canvas.clear(kit.TRANSPARENT);
    const unit = 7864 / 65536 * 96 / 72;
    canvas.save();
    canvas.clipRect(kit.XYWHRect(1.1, 1.1, 9.21, 9.21), kit.ClipOp.Intersect, true);
    canvas.drawImageRectOptions(image, kit.XYWHRect(0, 0, 8, 8),
      kit.XYWHRect(Math.fround(7 * unit), Math.fround(7 * unit), Math.fround(58 * unit), Math.fround(58 * unit)),
      kit.FilterMode.Linear, kit.MipmapMode.None, paint);
    canvas.restore();
    assert.deepEqual(contained, pixels(), 'contained pictures preserve the print grid and the cell clip');
    assert.notDeepEqual(render(1.17, 3.35), render(1, 4), 'minified images retain fractional placement');
  } finally {
    image.delete();
    paint.delete();
    source.delete();
    target.delete();
    await vite.close();
  }
});
