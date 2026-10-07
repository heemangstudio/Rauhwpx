import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import CanvasKitInit from 'canvaskit-wasm';
import { requireWasmPackage } from './browser-support.ts';
import { createTestModuleServer } from './support/module-server.ts';

requireWasmPackage(fileURLToPath(new URL('../../pkg/', import.meta.url)));
const engine = await import('../../pkg/rhwp.js');
engine.initSync({ module: readFileSync(new URL('../../pkg/rhwp_bg.wasm', import.meta.url)) });

test('shadowed pictures share the Hermite raster and retain its cropped alpha in the shadow', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const target = kit.MakeSurface(16, 10);
  assert.ok(target);
  const bytes = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y++) for (let x = 4; x < 8; x++) bytes.set([0, 0, 255, 255], (y * 8 + x) * 4);
  const image = kit.MakeImage({ width: 8, height: 8, colorType: kit.ColorType.RGBA_8888,
    alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB }, bytes, 32);
  assert.ok(image);
  const { setImageDownsampleApi } = await vite.ssrLoadModule('/src/core/image-sampling.ts');
  const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
  const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null);
  setImageDownsampleApi(engine.smoothHermiteDownsampleRgba);
  try {
    const canvas = target.getCanvas();
    canvas.clear(kit.WHITE);
    renderer.drawImageOp(canvas, image, { type: 'image', imageRef: 'shadow-alpha',
      bbox: { x: 2, y: 2, width: 3.6, height: 3.6 },
      shadow: { color: '#ff0000', alpha: 1, blurSigma: 0, offsetX: 6, offsetY: 0 },
    });
    assert.equal(renderer.imageCache.size, 1, 'shadowed minification uses the shared sampler');
    const pixels = canvas.readPixels(0, 0, { width: 16, height: 10,
      colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
    assert.ok(pixels);
    const pixel = (x: number, y: number) => [...pixels.slice((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
    assert.deepEqual(pixel(2, 4), [255, 255, 255, 255]);
    assert.deepEqual(pixel(5, 4), [0, 0, 255, 255]);
    assert.deepEqual(pixel(8, 4), [255, 255, 255, 255], 'transparent raster pixels cast no shadow');
    assert.deepEqual(pixel(11, 4), [255, 0, 0, 255], 'the sampled opaque pixels still cast the colored shadow');
  } finally {
    setImageDownsampleApi(null); renderer.resetDocumentResources();
    image.delete(); target.delete(); await vite.close();
  }
});

test('enlarged pictures use the shared fixed-point sampler on both axes', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const target = kit.MakeSurface(12, 12);
  assert.ok(target);
  const source = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) source.set([x % 2 * 255, y % 2 * 255, 0, 255], (y * 8 + x) * 4);
  }
  const image = kit.MakeImage({
    width: 8, height: 8, colorType: kit.ColorType.RGBA_8888,
    alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB,
  }, source, 32);
  assert.ok(image);
  const { setImageAffineSampleApi } = await vite.ssrLoadModule('/src/core/image-sampling.ts');
  const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
  const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null);
  setImageAffineSampleApi(engine.gridfitAffineSampleRgba);
  try {
    const canvas = target.getCanvas();
    canvas.clear(kit.TRANSPARENT);
    renderer.drawImageOp(canvas, image, {
      type: 'image', imageRef: 'bilinear-checker', bbox: { x: 0, y: 0, width: 10.88, height: 10.88 },
    });
    const sampled = [...renderer.imageCache.values()][0].image;
    assert.equal(sampled.width(), 11);
    assert.equal(sampled.height(), 11);
    assert.deepEqual(canvas.readPixels(4, 4, {
      width: 1, height: 1, colorType: kit.ColorType.RGBA_8888,
      alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB,
    }), new Uint8Array([196, 196, 0, 255]));
  } finally {
    setImageAffineSampleApi(null);
    renderer.resetDocumentResources();
    image.delete(); target.delete(); await vite.close();
  }
});

test('mixed-axis scaling and large magnification select the shared affine filter', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const target = kit.MakeSurface(6, 4);
  assert.ok(target);
  const { setImageAffineSampleApi } = await vite.ssrLoadModule('/src/core/image-sampling.ts');
  const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
  const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null);
  setImageAffineSampleApi(engine.gridfitAffineSampleRgba);
  try {
    for (const { height, width, targetHeight, expected } of [
      { height: 4, width: 3, targetHeight: 2, expected: [127, 127, 0, 255] },
      { height: 1, width: 6, targetHeight: 1, expected: [0, 0, 0, 255] },
    ]) {
      const source = new Uint8Array(2 * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < 2; x++) source.set([x * 255, y % 2 * 255, 0, 255], (y * 2 + x) * 4);
      }
      const image = kit.MakeImage({
        width: 2, height, colorType: kit.ColorType.RGBA_8888,
        alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB,
      }, source, 8);
      assert.ok(image);
      try {
        const canvas = target.getCanvas();
        canvas.clear(kit.TRANSPARENT);
        renderer.drawImageOp(canvas, image, {
          type: 'image', imageRef: `affine-${height}`,
          bbox: { x: 0, y: 0, width: width - 0.12, height: targetHeight - 0.08 },
        });
        assert.deepEqual(canvas.readPixels(1, 0, {
          width: 1, height: 1, colorType: kit.ColorType.RGBA_8888,
          alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB,
        }), new Uint8Array(expected));
        assert.equal(renderer.imageCache.size, 1);
      } finally {
        renderer.resetDocumentResources();
        image.delete();
      }
    }
  } finally {
    setImageAffineSampleApi(null);
    renderer.resetDocumentResources();
    target.delete(); await vite.close();
  }
});

test('CanvasKit uses the shared WASM sampler for straight alpha and retires cached rasters', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const target = kit.MakeSurface(4, 4);
  assert.ok(target);
  const image = kit.MakeImage({
    width: 2, height: 2, colorType: kit.ColorType.RGBA_8888,
    alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB,
  }, new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255]), 8);
  assert.ok(image);
  const { setImageDownsampleApi } = await vite.ssrLoadModule('/src/core/image-sampling.ts');
  const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
  const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null);
  setImageDownsampleApi(engine.smoothHermiteDownsampleRgba);
  try {
    const canvas = target.getCanvas();
    const op = { type: 'image', imageRef: 'alpha-checker', bbox: { x: 0, y: 0, width: 0.8, height: 0.8 } };
    const render = () => {
      canvas.clear(kit.TRANSPARENT);
      renderer.drawImageOp(canvas, image, op);
      return canvas.readPixels(0, 0, {
        width: 1, height: 1, colorType: kit.ColorType.RGBA_8888,
        alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB,
      });
    };
    assert.deepEqual(render(), new Uint8Array([128, 128, 128, 128]),
      'filtering straight RGB independently of alpha preserves the gray edge');
    assert.equal(renderer.imageCache.size, 1);
    assert.deepEqual(render(), new Uint8Array([128, 128, 128, 128]));
    assert.equal(renderer.imageCache.size, 1, 'repeated draws reuse the sampled raster');
    renderer.resetDocumentResources();
    assert.equal(renderer.imageCache.size, 0, 'document changes retire the sampled raster with decoded images');
    assert.deepEqual(render(), new Uint8Array([128, 128, 128, 128]));
  } finally {
    setImageDownsampleApi(null);
    renderer.resetDocumentResources();
    image.delete();
    target.delete();
    await vite.close();
  }
});

test('picture inputs preserve Native float32 rounding at a print pixel boundary', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)) });
  const target = kit.MakeSurface(1600, 1800);
  assert.ok(target);
  const source = new Uint8Array(1531 * 641 * 4).fill(90);
  for (let i = 3; i < source.length; i += 4) source[i] = 255;
  const image = kit.MakeImage({
    width: 1531, height: 641, colorType: kit.ColorType.RGBA_8888,
    alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB,
  }, source, 1531 * 4);
  assert.ok(image);
  const { setImageDownsampleApi } = await vite.ssrLoadModule('/src/core/image-sampling.ts');
  const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
  const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null);
  setImageDownsampleApi(engine.smoothHermiteDownsampleRgba);
  try {
    const canvas = target.getCanvas();
    canvas.clear(kit.TRANSPARENT);
    canvas.scale(200 / 96, 200 / 96);
    renderer.drawImageOp(canvas, image, {
      type: 'image', imageRef: 'float32-boundary',
      bbox: { x: 75.584, y: 548.64, width: 641.08, height: 268.4 },
    });
    const sampled = [...renderer.imageCache.values()][0].image;
    assert.equal(sampled.width(), 1336);
    assert.equal(sampled.height(), 561, 'the half-grid height must round after adding float32 inputs');
    const pixel = canvas.readPixels(200, 1142, {
      width: 1, height: 1, colorType: kit.ColorType.RGBA_8888,
      alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB,
    });
    assert.deepEqual(pixel, new Uint8Array([90, 90, 90, 255]), 'the first print row remains covered');
  } finally {
    setImageDownsampleApi(null);
    renderer.resetDocumentResources();
    image.delete(); target.delete(); await vite.close();
  }
});
