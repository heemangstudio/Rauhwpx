import './support/wasm-liftoff.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import CanvasKitInit from 'canvaskit-wasm/bin/full/canvaskit.js';
import type { LayerEquationLayoutBox as Box, LayerEquationLayoutKind as Kind } from '../src/core/types.ts';
import { createTestModuleServer } from './support/module-server.ts';
import { syntheticEquationFont } from './support/equation-font-fixture.ts';

function box(kind: Kind, em: number, x = 0, y = 0, width = em, height = em): Box {
  return { x, y, width, height, baseline: em * 0.8, kind };
}
function number(em: number): Box { return box({ type: 'number', text: '1' }, em); }
function fraction(em: number): Box {
  return box({ type: 'fraction', numer: number(em), denom: { ...number(em), y: em * 1.2 } }, em,
    em * 0.3, em * 0.2, em * 1.8, em * 2.2);
}
function radical(em: number, index?: Box): Box {
  return box({ type: 'sqrt', body: { ...number(em), x: em, y: em * 0.1 }, index }, em,
    em * 0.2, em * 0.1, em * 2.2, em * 1.2);
}
type Request = { text: string; size: number; x: number; y: number; scaleX: number; glyphs: number[] };
function close(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-4, `${message}: ${actual} != ${expected}`);
}

test('actual CanvasKit uses resolved composite em for nested scripts and root indices without moving glyph origins', async () => {
  const vite = await createTestModuleServer();
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/full/${file}`, import.meta.url)) });
  const face = kit.Typeface.MakeFreeTypeFaceFromData(syntheticEquationFont('\ue034\ue05b\ue05c\ue06d', 1, 600));
  assert.ok(face);
  const surface = kit.MakeSurface(640, 320);
  assert.ok(surface);
  const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
  const renderer = new CanvasKitLayerRenderer(kit, 'default', {}, null);
  renderer.findPreparedTypeface = () => ({ typeface: face });
  renderer.findEquationTypefaces = () => [{ typeface: face, legacy: true, syntheticItalic: false, syntheticBold: false }];
  const actualCanvas = surface.getCanvas();
  const requests: Request[] = [];
  const canvas = new Proxy(actualCanvas, {
    get(target, property) {
      if (property === 'drawText') return (text: string, x: number, y: number, paint: any, font: any) => {
        const matrix = target.getTotalMatrix();
        const glyphs = [...font.getGlyphIDs(text)];
        assert.ok(glyphs.length > 0 && glyphs.every(id => id !== 0), 'actual selected face covers each painted glyph');
        requests.push({ text, size: font.getSize(), x: matrix[0] * x + matrix[1] * y + matrix[2],
          y: matrix[3] * x + matrix[4] * y + matrix[5], scaleX: matrix[0], glyphs });
        target.drawText(text, x, y, paint, font);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const render = (layout: Box, em: number, parentX = 16, parentY = 32) => {
    requests.length = 0;
    actualCanvas.clear(kit.WHITE);
    assert.equal(renderer.renderEquationBox(canvas, layout, parentX, parentY, '#000000', em, 'HYhwpEQ',
      false, false, 0, { remainingNodes: 200, modernHy: true, hft: false }), true);
    surface.flush();
    const pixels = actualCanvas.readPixels(0, 0, { width: 640, height: 320, colorType: kit.ColorType.RGBA_8888,
      alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
    assert.ok(pixels && pixels.some((value: number, i: number) => i % 4 === 0 && value < 255), 'real surface contains equation ink');
    return requests.map(request => ({ ...request }));
  };
  try {
    for (const dpi of [96, 144, 192]) {
      const em = 1100 * dpi / 7200;
      const scriptEm = em * 0.68;
      const indexEm = em * 0.5;
      const fractionSup = { ...fraction(scriptEm), resolvedFontSize: scriptEm };
      const radicalSup = { ...radical(scriptEm), resolvedFontSize: scriptEm };
      const fractionIndex = { ...fraction(indexEm), resolvedFontSize: indexEm };
      const radicalIndex = { ...radical(indexEm), resolvedFontSize: indexEm };
      const nestedFraction = { ...fraction(indexEm * 0.68), resolvedFontSize: indexEm * 0.68 };
      const nestedIndex = { ...box({ type: 'superscript', base: number(indexEm), sup: nestedFraction }, indexEm),
        resolvedFontSize: indexEm };
      const cases = [
        { name: 'fraction superscript', child: fractionSup, size: scriptEm, first: 1,
          parent: box({ type: 'superscript', base: number(em), sup: fractionSup }, em), structural: [['\ue06d', scriptEm]] },
        { name: 'radical superscript', child: radicalSup, size: scriptEm, first: 1,
          parent: box({ type: 'superscript', base: number(em), sup: radicalSup }, em), structural: [['\ue05c', scriptEm * 1.1], ['\ue06d', scriptEm]] },
        { name: 'fraction root index', child: fractionIndex, size: indexEm, first: 2,
          parent: radical(em, fractionIndex), structural: [['\ue06d', indexEm]] },
        { name: 'radical root index', child: radicalIndex, size: indexEm, first: 2,
          parent: radical(em, radicalIndex), structural: [['\ue05c', indexEm * 1.1], ['\ue06d', indexEm]] },
        { name: 'root index with nested fraction superscript', child: nestedIndex, size: indexEm, first: 2,
          parent: radical(em, nestedIndex), structural: [['\ue06d', indexEm * 0.68]] },
      ];
      for (const scenario of cases) {
        const parent = { ...scenario.parent, x: 3, y: 5, resolvedFontSize: em };
        const actual = render(parent, em * 1.7);
        // 독립 subtree를 정확한 layout em으로 칠한 결과와 원점·glyph 요청까지 비교한다.
        const expected = render({ ...scenario.child, resolvedFontSize: undefined }, scenario.size, 19, 37);
        const subtree = actual.slice(scenario.first, scenario.first + expected.length);
        assert.equal(subtree.length, expected.length, `${dpi}dpi ${scenario.name}`);
        expected.forEach((request, i) => {
          assert.equal(subtree[i].text, request.text);
          assert.deepEqual(subtree[i].glyphs, request.glyphs);
          for (const key of ['size', 'x', 'y', 'scaleX'] as const) close(subtree[i][key], request[key], `${dpi}dpi ${scenario.name} ${key}`);
        });
        for (const [glyph, size] of scenario.structural) {
          const structural = subtree.find(request => request.text === glyph);
          assert.ok(structural, `${scenario.name} paints structural glyph ${glyph}`);
          close(structural.size, size as number, `${scenario.name} resolved structural em`);
        }
      }
      // Positioned glyph splitting must carry incoming em, even if leaf recovery uses height.
      const positioned = { ...box({ type: 'mathSymbol', text: '∫' }, scriptEm, 3, 5, scriptEm, scriptEm * 1.3),
        glyphAdvances: [scriptEm], resolvedFontSize: scriptEm };
      const integral = render(positioned, em).find(request => request.text === '\ue05b');
      assert.ok(integral);
      close(integral.size, scriptEm * 2, 'positioned integral retains resolved em');
      close(integral.x, 19 + scriptEm * 0.042, 'positioned integral x');
      close(integral.y, 37 + scriptEm * 1.94, 'positioned integral baseline');

      for (const invalid of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const legacy = { ...fraction(scriptEm), resolvedFontSize: invalid };
        const parent = box({ type: 'superscript', base: number(em), sup: legacy }, em);
        const bar = render(parent, em).find(request => request.text === '\ue06d');
        assert.ok(bar);
        close(bar.size, em * 0.7, 'missing/invalid metadata preserves legacy 0.7 traversal');
      }
    }
  } finally {
    renderer.dispose(); surface.delete(); face.delete(); await vite.close();
  }
});
