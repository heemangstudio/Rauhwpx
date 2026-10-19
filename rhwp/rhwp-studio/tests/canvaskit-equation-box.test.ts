import './support/wasm-liftoff.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import CanvasKitInit from 'canvaskit-wasm/bin/full/canvaskit.js';
import type { LayerEquationLayoutBox as Box } from '../src/core/types.ts';
import { createTestModuleServer } from './support/module-server.ts';
import { syntheticEquationFont } from './support/equation-font-fixture.ts';

// 실제 CanvasKit surface + MIT 소유 fixture. 한컴 font나 UI는 실행하지 않는다.
test('BOX paint preserves Korean, Latin, nested fraction ink and rejects invalid layouts atomically', async () => {
  const vite = await createTestModuleServer();
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/full/${file}`, import.meta.url)) });
  const face = kit.Typeface.MakeFreeTypeFaceFromData(syntheticEquationFont('(가)A12', 1, 600));
  assert.ok(face);
  const surface = kit.MakeSurface(200, 160);
  assert.ok(surface);
  const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
  const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null);
  renderer.findEquationTypefaces = () => [{ typeface: face, syntheticItalic: false, syntheticBold: false }];
  const actual = surface.getCanvas();
  const events: Array<{ type: string; text?: string; x?: number; y?: number }> = [];
  const canvas = new Proxy(actual, {
    get(target, property) {
      if (property === 'drawRect') return (rect: any, paint: any) => {
        events.push({ type: 'rect' }); target.drawRect(rect, paint);
      };
      if (property === 'drawText') return (text: string, x: number, y: number, paint: any, font: any) => {
        assert.ok([...font.getGlyphIDs(text)].every((glyph: number) => glyph !== 0));
        events.push({ type: 'text', text, x, y }); target.drawText(text, x, y, paint, font);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const leaf = (text: string, x = 0, y = 0): Box => ({ x, y, width: [...text].length * 12, height: 20, baseline: 16,
    resolvedFontSize: 20, kind: { type: 'text', text } });
  const framed = (body: Box, width: number, height: number): Box => ({
    x: 0, y: 0, width, height, baseline: body.y + body.baseline, resolvedFontSize: 20,
    kind: { type: 'decoration', decoration: 'box', body },
  });
  const pixels = () => {
    surface.flush();
    const result = actual.readPixels(0, 0, { width: 200, height: 160, colorType: kit.ColorType.RGBA_8888,
      alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
    assert.ok(result); return result;
  };
  const pixel = (data: any, x: number, y: number) => [...data.slice((y * 200 + x) * 4, (y * 200 + x) * 4 + 3)];
  try {
    const numerator = leaf('1', 6);
    const denominator = leaf('2', 6, 26);
    const fraction: Box = { x: 16, y: 6, width: 36, height: 48, baseline: 24, resolvedFontSize: 20,
      kind: { type: 'fraction', numer: numerator, denom: denominator } };
    for (const body of [leaf('(가)A', 16, 6), fraction, framed(leaf('A', 12, 5), 50, 32)]) {
      const layout = framed(body, 100, 72);
      actual.clear(kit.BLUE); events.length = 0;
      assert.equal(renderer.renderEquationBox(canvas, layout, 20, 20, '#b30000', 20, 'BOX fixture',
        false, false, 0, { remainingNodes: 100, modernHy: false, hft: false }), true);
      const data = pixels();
      assert.deepEqual(events.slice(0, 2).map(event => event.type), ['rect', 'rect'], 'background and frame precede the child');
      assert.ok(events.some(event => event.type === 'text'));
      assert.ok(events.filter(event => event.type === 'text').every(event => !/BOX|box/.test(event.text!)));
      assert.deepEqual(pixel(data, 110, 80), [255, 255, 255], 'frame replaces the blue background with white');
      assert.ok(pixel(data, 70, 20).every(channel => channel < 220), 'upper black border exists');
      let childInk = 0;
      for (let y = 23; y < 87; y++) for (let x = 23; x < 117; x++) {
        const [r, g, b] = pixel(data, x, y);
        if (r > 100 && g < 80 && b < 80) childInk++;
      }
      assert.ok(childInk > 10, 'colored child remains after the white background is painted');
      if (body.kind.type === 'text') {
        assert.equal(events.find(event => event.type === 'text')!.text, '(가)A');
        assert.equal(events.find(event => event.type === 'text')!.y, 42, 'child stays on its layout baseline');
      }
    }
    const valid = framed(leaf('A', 16, 6), 100, 72);
    // 전체 equation recorder를 통해 자식 실패 후 이미 기록된 흰 상자가 노출되지 않는지 검사한다.
    for (const bad of [
      { ...valid, width: Number.NaN },
      framed({ ...leaf('A'), baseline: Number.POSITIVE_INFINITY }, 100, 72),
      framed({ ...leaf('A'), kind: { type: 'fontStyle', fontStyle: 'fraktur', body: leaf('A') } }, 100, 72),
    ]) {
      actual.clear(kit.BLUE);
      renderer.renderEquation(actual, { type: 'equation', bbox: { x: 20, y: 20, width: 100, height: 72 },
        layoutBox: bad, fontSize: 20, fontName: 'BOX fixture', versionInfo: 'Equation Version 60' });
      const data = pixels();
      assert.deepEqual(pixel(data, 40, 40), [0, 0, 255], 'failed frame replay leaves the destination untouched');
    }
  } finally {
    renderer.dispose(); surface.delete(); face.delete(); await vite.close();
  }
});
