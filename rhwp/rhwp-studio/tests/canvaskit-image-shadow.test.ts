import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import CanvasKitInit from 'canvaskit-wasm';
import { createTestModuleServer } from './support/module-server.ts';

test('shadow picture raster bounds track nominal height across point boundaries and preserve transforms', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const source = kit.MakeSurface(8, 8);
  const target = kit.MakeSurface(40, 40);
  assert.ok(source && target);
  source.getCanvas().clear(kit.RED);
  const image = source.makeImageSnapshot();
  assert.ok(image);
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null);
    renderer.imageForOp = () => image;
    const canvas = target.getCanvas();
    const cssPerPt = 96 / 72;
    const shadow = { color: '#000000', alpha: 0, blurSigma: 0, offsetX: 0, offsetY: 0, nominalHeightPt: 8.4 };
    const pixels = () => {
      const data = canvas.readPixels(0, 0, { width: 40, height: 40,
        colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
      assert.ok(data); return data;
    };
    for (const heightPt of [8.6, 9.1]) {
      const bbox = { x: 5, y: 10, width: 10.4 * cssPerPt, height: heightPt * cssPerPt };
      canvas.clear(kit.WHITE);
      renderer.renderImage(canvas, { type: 'image', bbox, shadow });
      const actual = pixels();
      canvas.clear(kit.WHITE);
      renderer.drawImageOp(canvas, image, { type: 'image', shadow, bbox: {
        x: 5, y: 10 + (Math.floor(heightPt) - 9) * cssPerPt,
        width: 10 * cssPerPt, height: Math.floor(heightPt) * cssPerPt,
      } });
      assert.deepEqual(actual, pixels(), 'whole-point height changes also move the foreground origin');
      for (const transform of [{ horzFlip: true }, { rotation: 15 }]) {
        canvas.clear(kit.WHITE);
        renderer.renderImage(canvas, { type: 'image', bbox, shadow, transform });
        const transformed = pixels();
        canvas.clear(kit.WHITE);
        renderer.withShapeTransform(canvas, bbox, transform, () => renderer.drawImageOp(canvas, image,
          { type: 'image', bbox, shadow, transform }));
        assert.deepEqual(transformed, pixels(), 'rotated and flipped pictures retain their original bounds');
      }
    }
  } finally {
    image.delete(); source.delete(); target.delete(); await vite.close();
  }
});

test('CanvasKit image shadow follows the cropped image alpha and stays behind it', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const source = kit.MakeSurface(10, 10);
  const target = kit.MakeSurface(80, 70);
  assert.ok(source && target);
  const sourcePaint = new kit.Paint();
  sourcePaint.setColor(kit.BLACK);
  source.getCanvas().clear(kit.TRANSPARENT);
  source.getCanvas().drawRect(kit.XYWHRect(2, 2, 6, 6), sourcePaint);
  const image = source.makeImageSnapshot();
  assert.ok(image);
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null);
    const canvas = target.getCanvas();
    canvas.clear(kit.WHITE);
    renderer.drawImageOp(canvas, image, {
      type: 'image',
      bbox: { x: 10, y: 10, width: 30, height: 30 },
      crop: { left: 0, top: 0, right: 8, bottom: 8 },
      originalSizeHu: [10, 10],
      shadow: { color: '#ff0000', alpha: 0.8, blurSigma: 1, offsetX: 12, offsetY: 5 },
    });
    const pixels = canvas.readPixels(0, 0, { width: 80, height: 70, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
    assert.ok(pixels);
    const pixel = (x: number, y: number) => [...pixels.slice((y * 80 + x) * 4, (y * 80 + x) * 4 + 4)];
    assert.deepEqual(pixel(15, 15).slice(0, 3), [255, 255, 255], 'transparent source area leaves no shadow');
    const shadow = pixel(43, 30);
    assert.ok(shadow[0] > shadow[1] + 60 && shadow[0] > shadow[2] + 60, 'offset red shadow appears outside image');
    const ink = pixel(25, 25);
    assert.ok(ink[0] < 30 && ink[1] < 30 && ink[2] < 30, 'original image stays above shadow');
  } finally {
    image.delete();
    sourcePaint.delete();
    source.delete();
    target.delete();
    await vite.close();
  }
});
