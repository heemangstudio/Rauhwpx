import './support/wasm-liftoff.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import CanvasKitInit from 'canvaskit-wasm/bin/full/canvaskit.js';
import { requireWasmPackage } from './browser-support.ts';
import { createTestModuleServer } from './support/module-server.ts';
import { syntheticEquationFont } from './support/equation-font-fixture.ts';

function findEquation(value: any): any {
  if (!value || typeof value !== 'object') return undefined;
  if (value.type === 'equation' && value.layoutBox) return value;
  for (const child of Object.values(value)) {
    const found = findEquation(child);
    if (found) return found;
  }
}

test('registered fallback uses actual WASM callback ink for radical layout and upright mixed glyph origins', async () => {
  const wasmRoot = process.env.RHWP_WASM_PACKAGE_DIR ?? fileURLToPath(new URL('../../pkg/', import.meta.url));
  requireWasmPackage(wasmRoot);
  const vite = await createTestModuleServer();
  const engine = await vite.ssrLoadModule('@wasm/rhwp.js');
  engine.initSync({ module: readFileSync(resolve(wasmRoot, 'rhwp_bg.wasm')) });
  const local = await vite.ssrLoadModule('/src/core/local-fonts.ts');
  const equation = await vite.ssrLoadModule('/src/core/equation-font.ts');
  const { sfntMetricsSubset } = await vite.ssrLoadModule('/src/core/sfnt-subset.ts');
  const { CanvasKitLayerRenderer } = await vite.ssrLoadModule('/src/view/canvaskit-renderer.ts');
  const keys = ['document', 'window', 'FontFace', 'measureEquationTextMetrics', 'resolveEquationFontFamily', 'resolveEquationLiteralFont'];
  const globals = globalThis as Record<string, any>;
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globals, key)]));
  const calls: Array<{ source: string; text: string; size: number; italic: boolean; bold: boolean; policy?: string; scale?: number; metrics: any }> = [];
  globals.FontFace = class { async load() { return this; } };
  globals.document = { fonts: { add() {}, delete() { return true; } }, createElement: () => ({ getContext: () => ({
    font: '', measureText() { throw new Error('owned full SFNT fixtures must use exact metrics'); },
  }) }) };
  globals.window = { setTimeout };
  local.resetLocalFontsForTests(); engine.clearRuntimeFontMetrics();
  const measure = equation.createEquationTextMeasurer(local.resolveLocalFont, local.getImportedLocalFontBytes);
  globals.measureEquationTextMetrics = (source: string, text: string, size: number, italic: boolean, hft: boolean, literal: boolean, bold: boolean, policy?: 'hcr-declared' | 'hancom-windows', scale?: number) => {
    const metrics = measure(source, text, size, italic, hft, literal, bold, policy, scale);
    calls.push({ source, text, size, italic, bold, policy, scale, metrics }); return metrics;
  };
  globals.resolveEquationFontFamily = equation.createEquationFontResolver(local.resolveLocalFont, local.getImportedLocalFontBytes);
  globals.resolveEquationLiteralFont = equation.createEquationLiteralFontResolver(local.resolveLocalFont, local.getImportedLocalFontBytes);
  const kit = await CanvasKitInit({ locateFile: (file: string) => fileURLToPath(new URL(`../node_modules/canvaskit-wasm/bin/full/${file}`, import.meta.url)) });
  const surface = kit.MakeSurface(120, 60);
  assert.ok(surface);
  const fontFaces = new WeakMap<object, object>();
  const trackedKit = { ...kit, Font: function(face: any, size: number) {
    const font = new kit.Font(face, size); fontFaces.set(font, face); return font;
  } };
  const renderer = new CanvasKitLayerRenderer(trackedKit, 'default', {}, null);
  const canvas = surface.getCanvas();
  const painted: Array<{ text: string; glyph: number; face: object; x: number; y: number; width: number; size: number; skew: number; bold: boolean }> = [];
  const observed = new Proxy(canvas, { get(target, property) {
    if (property === 'drawText') return (text: string, x: number, y: number, paint: any, font: any) => {
      const matrix = target.getTotalMatrix();
      const ids = font.getGlyphIDs(text);
      painted.push({ text, glyph: ids[0], face: fontFaces.get(font)!,
        x: matrix[0] * x + matrix[1] * y + matrix[2], y: matrix[3] * x + matrix[4] * y + matrix[5],
        width: font.getGlyphWidths(ids)[0] * matrix[0], size: font.getSize(), skew: font.getSkewX(), bold: font.isEmbolden() });
      target.drawText(text, x, y, paint, font);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const registered = new Map<string, { bytes: ArrayBuffer; family: string; italic: boolean; weight: number }>();
  const register = async (family: string, chars: string, glyph: number, advance: number, italic = false, weight = 400) => {
    const bytes = syntheticEquationFont(chars, glyph, advance, italic, weight);
    const style = `${weight === 600 ? 'Semibold' : weight === 700 ? 'Bold' : 'Regular'}${italic ? ' Italic' : ''}`;
    const result = await local.registerLocalFontFace(bytes, { source: 'imported', fileName: 'owned-equation.ttf', names: {
      family, fullName: `${family} ${style}`, postscriptName: `${family.replaceAll(' ', '')}-${style}`, style, aliases: [],
    } });
    assert.equal(result.ok, true);
    assert.equal(result.record.sfntStyle.weight, weight, 'physical OS/2 weight survives registration');
    registered.set(`${family}:${italic}:${weight}`, { bytes, family, italic, weight });
    engine.clearRuntimeFontMetrics();
    // 엔진 메트릭 슬롯은 boolean 굵기다. 600보다 실제 목표 700을 마지막에 등록한다.
    for (const item of [...registered.values()].sort((a, b) => a.weight - b.weight)) {
      const metrics = engine.registerRuntimeFontMetrics(sfntMetricsSubset(item.bytes), JSON.stringify([item.family]), item.weight >= 600, item.italic);
      assert.equal(JSON.parse(metrics).registered, true, 'actual engine accepts the same owned face metadata');
    }
    await renderer.prepareLocalFonts(['HYhwpEQ']);
    return result.record;
  };
  const preview = (script: string) => {
    const doc = engine.HwpDocument.createEmpty();
    try { doc.setDpi(96); return JSON.parse(doc.renderEquationPreviewWithFont(script, 750, 0, 'HYhwpEQ')); }
    finally { doc.free(); }
  };
  const checkRadical = (advance: number, inkLeft: number, inkRight: number) => {
    calls.length = 0;
    const rendered = preview('sqrt {□}');
    const metrics = calls.filter(call => call.text === '□' && call.size === 10 && !call.italic && call.metrics);
    assert.ok(metrics.length > 0, 'real WASM layout invokes the registered production callback');
    assert.deepEqual(metrics[0].metrics, { advance, inkLeft, inkRight });
    assert.equal(rendered.widthPx, 11 + advance, 'actual fallback ink adds no synthetic radical clearance');
    const rule = rendered.svg.match(/<text\b[^>]*>\ue06d<\/text>/u)?.[0];
    assert.ok(rule, 'registered HY pair paints the actual radical rule');
    const x = Number(rule.match(/\bx="([^"]+)"/)?.[1]);
    const extent = Number(rule.match(/\btextLength="([^"]+)"/)?.[1]);
    // Preview API는 version 없는 SVG 경로다. 현대식 배치에도 구형 막대 길이를 쓴다.
    assert.ok(Math.abs(x - 10.2) < 1e-4, `legacy preview rule origin: ${rule}`);
    assert.ok(Math.abs(extent - (advance + 1.7)) < 1e-4, `legacy preview rule extent: ${rule}`);
    assert.ok(Math.abs(x + extent - (rendered.widthPx + 0.9)) < 1e-4, `legacy preview rule right: ${rule}`);
    const doc = engine.HwpDocument.createEmpty();
    try {
      doc.createBlankDocument(); doc.setDpi(96);
      assert.equal(JSON.parse(doc.insertEquation(0, 0, 0, 'sqrt {□}', 750, 0)).ok, true);
      const op = findEquation(JSON.parse(doc.getPageLayerTree(0)));
      assert.ok(op?.versionInfo, 'inserted equation carries the modern version');
      assert.equal(op.layoutBox.width, 11 + advance);
      painted.length = 0;
      assert.equal(renderer.renderEquationBox(observed, op.layoutBox, 0, 0, op.color, op.fontSize, op.fontName,
        true, false, 0, { remainingNodes: 100, modernHy: true, hft: false }), true);
      const bar = painted.find(item => item.text === '\ue06d');
      assert.ok(bar, 'actual CanvasKit paints the modern radical rule');
      assert.ok(Math.abs(bar.width - (advance + 1)) < 1e-4, `modern rule extent: ${bar.width}`);
      assert.ok(Math.abs(bar.x + bar.width - (op.layoutBox.x + op.layoutBox.width + 0.2)) < 1e-4,
        `modern rule right: ${bar.x + bar.width}`);
    } finally { doc.free(); }
  };
  try {
    await register('HYhwpEQ', 'A\ue000\ue034\ue03d\ue05c\ue06d', 1, 600);
    assert.equal(measure('HYhwpEQ', '□', 10, false, false, true), null, 'absent fallback is unavailable');
    await register('Haansoft Batang', '□∆′″', 3, 800);
    checkRadical(7.2, 0.5, 5);
    await register('Haansoft Batang', '□∆′″', 4, 1000, true);
    checkRadical(7.2, 0.5, 5);
    assert.deepEqual(measure('HYhwpEQ', '□', 10, true, false, true), { advance: 9, inkLeft: 0.5, inkRight: 5 }, 'explicit low-level italic measurement stays distinct');
    const mixedMetrics = measure('HYhwpEQ', 'A□A', 10, true, false, true);
    assert.ok(Math.abs(mixedMetrics.advance - 19.2) < 1e-6, 'mixed callback keeps italic source letters and upright fallback');
    assert.ok(Math.abs(mixedMetrics.inkLeft - 0.5) < 1e-6 && Math.abs(mixedMetrics.inkRight - 18.2) < 1e-6);
    const doc = engine.HwpDocument.createEmpty();
    try {
      doc.createBlankDocument(); doc.setDpi(96);
      calls.length = 0;
      assert.equal(JSON.parse(doc.insertEquation(0, 0, 0, '"A□A"', 750, 0)).ok, true);
      const op = findEquation(JSON.parse(doc.getPageLayerTree(0)));
      assert.ok(op && op.fontName === 'HYhwpEQ' && op.versionInfo, 'actual inserted modern equation emits its production layout');
      assert.ok(calls.some(call => call.text === '□' && !call.italic && call.metrics?.advance === 7.2));
      assert.ok(calls.some(call => call.text === 'A' && call.italic && call.metrics?.advance === 6));
      painted.length = 0; canvas.clear(kit.WHITE);
      assert.equal(renderer.renderEquationBox(observed, op.layoutBox, 10, 20, op.color, op.fontSize, op.fontName,
        true, false, 0, { remainingNodes: 100, modernHy: true, hft: false }), true);
      assert.deepEqual(painted.map(item => item.glyph), [1, 3, 1], 'actual WASM-generated advances select upright regular fallback between source letters');
      assert.ok(Math.abs(painted[1].x - painted[0].x - 6) < 1e-5);
      assert.ok(Math.abs(painted[2].x - painted[1].x - 7.2) < 1e-5, 'paint origins use callback/layout output, not hand-built glyphAdvances');
      assert.equal(painted[1].skew, 0);
      assert.ok(Math.abs(painted[0].skew + 0.2) < 1e-6 && Math.abs(painted[2].skew + 0.2) < 1e-6);
      surface.flush();
      const pixels = canvas.readPixels(0, 0, { width: 120, height: 60, colorType: kit.ColorType.RGBA_8888,
        alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
      assert.ok(pixels?.some((value: number, i: number) => i % 4 === 0 && value < 255));
    } finally { doc.free(); }
    await register('Haansoft Batang', '□∆′″', 3, 1000);
    checkRadical(9, 0.5, 5);
    await register('Haansoft Batang', 'V', 3, 800);
    assert.equal(measure('HYhwpEQ', '□', 10, false, false, true), null, 'uncovered replacement removes exact fallback');

    for (const weights of [[600, 700], [700, 600]]) {
      local.resetLocalFontsForTests(); renderer.resetDocumentResources(); registered.clear();
      await register('HYhwpEQ', 'A\ue000', 1, 600);
      const regular = await register('Haansoft Batang', '□', 3, 800);
      let boldFace: any;
      for (const weight of weights) {
        const record = await register('Haansoft Batang', '□', weight === 700 ? 4 : 2,
          weight === 700 ? 1200 : 800, false, weight);
        if (weight === 700) boldFace = record;
      }
      for (const bold of [true, false]) {
        const advance = bold ? 10.8 : 7.2;
        const record = bold ? boldFace : regular;
        assert.deepEqual(measure('HYhwpEQ', '□', 10, false, false, true, bold),
          { advance, inkLeft: 0.5, inkRight: 5 });
        const mixed = measure('HYhwpEQ', 'A□A', 10, true, false, true, bold);
        assert.ok(mixed && Math.abs(mixed.advance - (12 + advance)) < 1e-9
          && mixed.inkLeft === 0.5 && Math.abs(mixed.inkRight - (11 + advance)) < 1e-9);
        for (const text of ['A□A', '□']) {
          const doc = engine.HwpDocument.createEmpty();
          try {
            doc.createBlankDocument(); doc.setDpi(96); calls.length = 0;
            const script = bold ? `bold {"${text}"}` : `"${text}"`;
            assert.equal(JSON.parse(doc.insertEquation(0, 0, 0, script, 750, 0)).ok, true);
            const op = findEquation(JSON.parse(doc.getPageLayerTree(0)));
            assert.ok(op?.versionInfo);
            assert.ok(calls.some(call => call.text === '□' && call.bold === bold && !call.italic
              && call.metrics?.advance === advance && call.metrics.inkLeft === 0.5 && call.metrics.inkRight === 5),
              `WASM callback selects the physical ${bold ? 700 : 400} metrics with registration ${weights}`);
            painted.length = 0; canvas.clear(kit.WHITE);
            assert.equal(renderer.renderEquationBox(observed, op.layoutBox, 10, 20, op.color, op.fontSize, op.fontName,
              true, false, 0, { remainingNodes: 100, modernHy: true, hft: false }), true);
            const glyph = bold ? 4 : 3;
            assert.deepEqual(painted.map(item => item.glyph), text === '□' ? [glyph] : [1, glyph, 1]);
            const square = painted[text === '□' ? 0 : 1];
            assert.equal(square.face, renderer.localTypefaces.get(local.localFontFaceKey(record)).typeface,
              `painting and measurement bind the same physical face with registration ${weights}`);
            assert.ok(Math.abs(square.width - (bold ? 12 : 8)) <= 1 / 65536,
              `paint keeps the selected face natural advance within one Skia 16.16 unit: ${square.width}`);
            assert.equal(square.skew, 0); assert.equal(square.bold, false, 'physical face needs no synthetic weight');
            if (text !== '□') {
              assert.ok(Math.abs(square.x - painted[0].x - 6) < 1e-5);
              assert.ok(Math.abs(painted[2].x - square.x - advance) < 1e-5,
                'following glyph uses the callback advance of the same painted physical face');
            }
          } finally { doc.free(); }
        }
      }
    }

    local.resetLocalFontsForTests(); renderer.resetDocumentResources(); registered.clear();
    // MIT 소유 SFNT만 사용한다. 500/1000 em은 원본 숫자 512/1024 advance 비율이다.
    await register('HYhwpEQ', '\ue03d\ue034\ue035\ue036\ue037\ue038\ue0fcx', 1, 500);
    for (const dpi of [96, 200]) {
      const scale = dpi / 96;
      for (const policy of ['hancom-windows', 'hcr-declared', 'hancom-windows', 'hcr-declared']) {
        for (const digit of ['4', '5']) {
          const doc = engine.HwpDocument.createEmpty();
          try {
            doc.createBlankDocument(); doc.setDpi(dpi); doc.setFontMetricsPolicy(policy);
            calls.length = 0;
            assert.equal(JSON.parse(doc.insertEquation(0, 0, 0, `${digit}x`, 1100, 0)).ok, true);
            const op = findEquation(JSON.parse(doc.getPageLayerTree(0)));
            assert.ok(op?.versionInfo, 'document layout retains the actual modern equation version');
            // HcrDeclared는 출력 px 격자, Windows는 논리 96dpi 격자를 유지한다.
            const step = policy === 'hancom-windows' ? 7 * scale : dpi === 96 ? 6.3 : 13.5;
            const callback = calls.find(call => call.text === digit && call.policy === policy
              && Math.abs((call.scale ?? 0) - scale) < 1e-9 && call.metrics);
            assert.ok(callback, `document WASM forwards ${policy} and output scale ${scale}`);
            assert.ok(Math.abs(callback.metrics.advance - step) < 1e-7,
              `source advance before accumulation: ${callback.metrics.advance}, expected ${step}`);
            painted.length = 0; canvas.clear(kit.WHITE);
            assert.equal(renderer.renderEquationBox(observed, op.layoutBox, 0, 0, op.color, op.fontSize, op.fontName,
              true, false, 0, { remainingNodes: 100, modernHy: true, hft: false }), true);
            assert.equal(painted.length, 2, 'real document layout paints one digit and one variable');
            assert.ok(Math.abs((painted[1].x - painted[0].x) / scale - step / scale) < 1e-5,
              `CanvasKit consumes the ${policy} document origins at ${dpi} DPI`);
            for (const glyph of painted) assert.ok(Math.abs(glyph.size - 1100 / 75 * scale) < 1e-5,
              'advance policy preserves nominal paint size');
          } finally { doc.free(); }
        }
      }
    }
    // 같은 경로의 source 등록 세대가 바뀌어도 두 정책의 실제 WASM 배치를 다시 잰다.
    await register('HYhwpEQ', '\ue03d\ue034\ue035\ue036\ue037\ue038\ue0fcx', 1, 800);
    for (const policy of ['hancom-windows', 'hcr-declared']) {
      const doc = engine.HwpDocument.createEmpty();
      try {
        doc.createBlankDocument(); doc.setDpi(96); doc.setFontMetricsPolicy(policy);
        calls.length = 0; doc.insertEquation(0, 0, 0, '4x', 1100, 0);
        const op = findEquation(JSON.parse(doc.getPageLayerTree(0)));
        assert.ok(op);
        const expected = policy === 'hancom-windows' ? 11 : 9.9;
        const callback = calls.find(call => call.text === '4' && call.policy === policy && call.metrics);
        assert.ok(callback && Math.abs(callback.metrics.advance - expected) < 1e-7,
          'replaced source bytes invalidate both policy measurements in the real document');
        painted.length = 0;
        assert.equal(renderer.renderEquationBox(observed, op.layoutBox, 0, 0, op.color, op.fontSize, op.fontName,
          true, false, 0, { remainingNodes: 100, modernHy: true, hft: false }), true);
        assert.ok(Math.abs(painted[1].x - painted[0].x - expected) < 1e-5);
      } finally { doc.free(); }
    }
  } finally {
    renderer.dispose(); surface.delete(); local.resetLocalFontsForTests(); engine.clearRuntimeFontMetrics();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globals, key, descriptor); else delete globals[key];
    }
    await vite.close();
  }
});
