import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import CanvasKitInit from 'canvaskit-wasm';
import { createTestModuleServer } from './support/module-server.ts';

// 실제 raster surface의 flush 대상만 대체한다. Skia 할당·그리기·dispose는 그대로 쓴다.
class TargetCanvas {
  width = 257;
  height = 193;
  classList = { contains: () => false };
  flushedPixel: number | null = null;
  getContext() {
    return { putImageData: (image: { data: Uint8ClampedArray }) => { this.flushedPixel = image.data[0]; } };
  }
}
class RasterImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

test('repeated CanvasKit software renders release pixel buffers after success and failure', async () => {
  const vite = await createTestModuleServer(fileURLToPath(new URL('../', import.meta.url)));
  const previousCanvas = Object.getOwnPropertyDescriptor(globalThis, 'HTMLCanvasElement');
  const previousImageData = Object.getOwnPropertyDescriptor(globalThis, 'ImageData');
  Object.defineProperty(globalThis, 'HTMLCanvasElement', { value: TargetCanvas, configurable: true });
  Object.defineProperty(globalThis, 'ImageData', { value: RasterImageData, configurable: true });
  const kit = await CanvasKitInit({
    locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/${file}`, import.meta.url)),
  });
  const memory = kit as unknown as { _malloc(bytes: number): number; _free(pointer: number): void };
  const malloc = memory._malloc;
  const free = memory._free;
  const bufferBytes = new TargetCanvas().width * new TargetCanvas().height * 4;
  const liveBuffers = new Set<number>();
  let allocated = 0;
  let released = 0;
  memory._malloc = bytes => {
    const pointer = malloc(bytes);
    if (bytes === bufferBytes) { liveBuffers.add(pointer); allocated += 1; }
    return pointer;
  };
  memory._free = pointer => {
    if (liveBuffers.delete(pointer)) released += 1;
    free(pointer);
  };
  let renderer: { dispose(): void } | undefined;
  try {
    const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
    const active = new CanvasKitLayerRenderer(kit, 'default', { preference: 'software', requested: 'software' }, null, null);
    renderer = active;
    const bounds = { x: 0, y: 0, width: 257, height: 193 };
    const tree = { pageWidth: 257, pageHeight: 193, profile: 'print', root: { kind: 'leaf', bounds, ops: [] } };
    const renderNode = active.renderNode;
    const failure = new Error('paint failure');
    for (let index = 0; index < 72; index += 1) {
      const target = new TargetCanvas();
      const throws = index >= 32 && index < 40;
      active.renderNode = throws ? () => { throw failure; } : renderNode;
      if (throws) {
        assert.throws(() => active.renderPage(tree, target, 1), error => error === failure);
        assert.equal(target.flushedPixel, null);
      } else {
        assert.equal(active.renderPage(tree, target, 1), target);
        assert.equal(target.flushedPixel, 255, 'real CanvasKit software surface flushed its white raster');
      }
      assert.equal(liveBuffers.size, 0, `render ${index} must release the raster backing allocation`);
      assert.equal(allocated, index + 1);
      assert.equal(released, allocated);
    }
    active.renderNode = renderNode;
  } finally {
    renderer?.dispose();
    for (const pointer of liveBuffers) free(pointer);
    memory._malloc = malloc;
    memory._free = free;
    if (previousCanvas) Object.defineProperty(globalThis, 'HTMLCanvasElement', previousCanvas);
    else Reflect.deleteProperty(globalThis, 'HTMLCanvasElement');
    if (previousImageData) Object.defineProperty(globalThis, 'ImageData', previousImageData);
    else Reflect.deleteProperty(globalThis, 'ImageData');
    await vite.close();
  }
});
