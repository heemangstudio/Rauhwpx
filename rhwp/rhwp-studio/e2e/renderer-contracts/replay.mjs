import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { PNG } from 'pngjs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { comparePngBuffers } from '../helpers.mjs';
const studioRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const vite = await createServer({
  root: studioRoot,
  configFile: false,
  resolve: { alias: { '@': path.join(studioRoot, 'src') } },
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
let CanvasKitLayerRendererRuntime;
let glyphOutlinePayloadResourceKeyRuntime;
try {
  ({ CanvasKitLayerRenderer: CanvasKitLayerRendererRuntime } = await vite.ssrLoadModule(
    '/src/view/canvaskit-renderer.ts',
  ));
  ({ glyphOutlinePayloadResourceKey: glyphOutlinePayloadResourceKeyRuntime }
    = await vite.ssrLoadModule('/src/view/glyph-outline-payload-status.ts'));
} finally {
  await vite.close();
}

function runExecutableTextReplay(op, {
  glyphIds,
  fallbackGlyphIds,
  symbolGlyphIds,
  usePreparedTypeface = false,
  drawGlyphsError,
  drawParagraphError,
  shapedTextAvailable = true,
} = {}) {
  const events = [];
  const unsupportedOps = new Set();
  const replayText = op.displayText ?? op.text;
  const resolvedGlyphIds = glyphIds
    ?? Array.from({ length: Array.from(replayText).length }, (_, index) => index + 1);

  class FakeFont {
    setEdging() {}
    setHinting() {}
    setEmbeddedBitmaps() {}
    setLinearMetrics() {}
    setSubpixel() {}
    constructor(typeface, size) {
      this.typeface = typeface;
      events.push({ type: 'font.create', face: typeface?.face ?? 'default', size });
    }

    getGlyphIDs(text, count) {
      events.push({ type: 'font.getGlyphIDs', text, count });
      return Uint16Array.from(
        this.typeface?.face === 'symbol' && symbolGlyphIds
          ? symbolGlyphIds
          : this.typeface?.face === 'fallback' && fallbackGlyphIds
            ? fallbackGlyphIds
            : resolvedGlyphIds,
      );
    }

    getGlyphWidths(ids) {
      return Array.from(ids, () => 8);
    }

    delete() {
      events.push({ type: 'font.delete' });
    }
  }

  class FakeParagraphStyle {
    constructor(style) {
      this.style = style;
      events.push({ type: 'paragraphStyle.create', style });
    }
  }

  const paragraph = {
    layout(width) {
      events.push({ type: 'paragraph.layout', width });
    },
    delete() {
      events.push({ type: 'paragraph.delete' });
    },
  };
  const paragraphBuilder = {
    addText(text) {
      events.push({ type: 'paragraphBuilder.addText', text });
    },
    build() {
      events.push({ type: 'paragraphBuilder.build' });
      return paragraph;
    },
    delete() {
      events.push({ type: 'paragraphBuilder.delete' });
    },
  };

  const paint = {
    setAntiAlias(value) {
      events.push({ type: 'paint.antiAlias', value });
    },
    delete() {
      events.push({ type: 'paint.delete' });
    },
  };
  const canvas = {
    translate(x,y) { events.push({type:'canvas.translate',x,y}); },
    scale(x,y) { events.push({type:'canvas.scale',x,y}); },
    save() {
      events.push({ type: 'canvas.save' });
    },
    concat(matrix) {
      events.push({ type: 'canvas.concat', matrix: Array.from(matrix) });
    },
    rotate(rotation, x, y) {
      events.push({ type: 'canvas.rotate', rotation, x, y });
    },
    drawGlyphs(ids, positions, x, y) {
      events.push({
        type: 'canvas.drawGlyphs',
        glyphIds: Array.from(ids),
        positions: Array.from(positions),
        x,
        y,
      });
      if (drawGlyphsError) throw drawGlyphsError;
    },
    drawText(text, x, y) {
      events.push({ type: 'canvas.drawText', text, x, y });
    },
    drawRect(rect) {
      events.push({ type: 'canvas.drawRect', rect });
    },
    drawParagraph(_paragraph, x, y) {
      events.push({ type: 'canvas.drawParagraph', x, y });
      if (drawParagraphError) throw drawParagraphError;
    },
    restore() {
      events.push({ type: 'canvas.restore' });
    },
  };
  const fallbackTypeface = { face: 'fallback' };
  const symbolTypeface = symbolGlyphIds ? { face: 'symbol' } : null;
  const renderer = new CanvasKitLayerRendererRuntime({
    Font: FakeFont,
    FontEdging: { AntiAlias: 1 },
    FontHinting: { None: 0 },
    ParagraphStyle: FakeParagraphStyle,
    ParagraphBuilder: {
      Make(style, fontManager) {
        events.push({ type: 'paragraphBuilder.make', style, fontManager });
        return paragraphBuilder;
      },
    },
    XYWHRect(x, y, width, height) {
      return { x, y, width, height };
    },
  }, 'default', {}, fallbackTypeface, symbolTypeface, shapedTextAvailable ? {} : null, 'Noto Sans KR');
  renderer.unsupportedOps = unsupportedOps;
  if (usePreparedTypeface) {
    renderer.findPreparedTypeface = (fontFamily) => ({
      typeface: fontFamily === 'Source Han Serif K Old Hangul'
        ? null
        : { face: 'primary' },
      fontManager: shapedTextAvailable ? {} : null,
      fontFamily,
    });
  }
  renderer.recordTextRunCoverageGaps = () => {
    events.push({ type: 'coverage.record' });
  };
  renderer.makeFillPaint = () => {
    events.push({ type: 'paint.create' });
    return paint;
  };
  renderer.makeStrokePaint = () => {
    events.push({ type: 'strokePaint.create' });
    return paint;
  };
  renderer.color = (color) => color;

  let error = null;
  try {
    renderer.renderTextRun(canvas, op);
  } catch (caught) {
    error = caught;
  }
  return { error, events, unsupportedOps };
}

function runExecutableTextSpecialReplay() {
  const events = [];
  class FakePaint {
    setAntiAlias() {}
    setStyle() {}
    setColor() {}
    setStrokeWidth() {}
    setStrokeCap() {}
    setPathEffect() { events.push({ type: 'paint.pathEffect' }); }
    delete() { events.push({ type: 'paint.delete' }); }
  }
  class FakeFont {
    setEdging() {}
    setHinting() {}
    setEmbeddedBitmaps() {}
    setLinearMetrics() {}
    setSubpixel() {}
    constructor(_typeface, size) { this.size = size; }
    getGlyphIDs(text) { return Uint16Array.from(Array.from(text), (_, index) => index + 1); }
    getGlyphWidths(ids) { return Array.from(ids, () => this.size * 0.5); }
    setScaleX(scale) { events.push({ type: 'font.scaleX', scale }); }
    delete() { events.push({ type: 'font.delete' }); }
  }
  const canvasKit = {
    Font: FakeFont,
    FontEdging: { AntiAlias: 1 },
    FontHinting: { None: 0 },
    Paint: FakePaint,
    PaintStyle: { Fill: 0, Stroke: 1 },
    StrokeCap: { Round: 0 },
    PathEffect: {
      MakeDash(dash) {
        events.push({ type: 'pathEffect.create', dash: [...dash] });
        return { delete() { events.push({ type: 'pathEffect.delete' }); } };
      },
    },
    Color: (r, g, b, a) => [r, g, b, a],
    XYWHRect: (x, y, width, height) => ({ x, y, width, height }),
  };
  const canvas = {
    save() { events.push({ type: 'canvas.save' }); },
    restore() { events.push({ type: 'canvas.restore' }); },
    translate(x, y) { events.push({ type: 'canvas.translate', x, y }); },
    rotate(rotation) { events.push({ type: 'canvas.rotate', rotation }); },
    drawOval(rect) { events.push({ type: 'canvas.drawOval', rect }); },
    drawRect(rect) { events.push({ type: 'canvas.drawRect', rect }); },
    drawText(text, x, y) { events.push({ type: 'canvas.drawText', text, x, y }); },
    drawLine(x1, y1, x2, y2) { events.push({ type: 'canvas.drawLine', x1, y1, x2, y2 }); },
    drawCircle(x, y, radius) { events.push({ type: 'canvas.drawCircle', x, y, radius }); },
  };
  const renderer = new CanvasKitLayerRendererRuntime(
    canvasKit,
    'default',
    {},
    { face: 'fallback' },
    null,
    null,
    'Noto Sans KR',
  );
  renderer.currentShowParagraphMarks = true;
  renderer.currentShowControlCodes = true;
  const incompleteOldHangulAlias = { typeface: { face: 'old-hangul-incomplete' }, fontManager: null };
  renderer.bundledTypefaceAliases.set('source han serif k old hangul', incompleteOldHangulAlias);
  const rejectedOldHangulAlias = renderer.findPreparedTypeface('Source Han Serif K Old Hangul');
  const oldHangulAlias = {
    typeface: { face: 'old-hangul-alias' },
    fontManager: { family: 'old-hangul-manager' },
  };
  renderer.bundledTypefaceAliases.set('source han serif k old hangul', oldHangulAlias);
  const resolvedOldHangulAlias = renderer.findPreparedTypeface('Source Han Serif K Old Hangul');

  renderer.renderOp(canvas, {
    type: 'charOverlap',
    bbox: { x: 10, y: 20, width: 16, height: 16 },
    text: '①',
    baseline: 12,
    rotation: 0,
    isVertical: false,
    style: { fontSize: 16, color: '#112233' },
    positions: [0, 16],
    positionsComplete: true,
    charOverlap: { borderType: 1, innerCharSize: 80 },
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'charOverlap',
    bbox: { x: 30, y: 20, width: 16, height: 16 },
    text: '\u{F0289}\u{F0294}',
    baseline: 12,
    rotation: 0,
    isVertical: false,
    style: { fontSize: 16, color: '#112233' },
    positions: [0, 8, 16],
    positionsComplete: true,
    charOverlap: { borderType: 1, innerCharSize: 80 },
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'textControlMark',
    bbox: { x: 10, y: 20, width: 40, height: 16 },
    fieldMarker: 'none',
    isParaEnd: true,
    isLineBreakEnd: false,
    baseline: 12,
    rotation: 0,
    isVertical: false,
    marks: [
      { kind: 'space', text: '∨', x: 8, y: 0, fontSize: 8 },
      { kind: 'paragraphEnd', text: '↵', x: 40, y: 0, fontSize: 16 },
    ],
    marksComplete: true,
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'tabLeader',
    bbox: { x: 10, y: 20, width: 40, height: 16 },
    leaders: [{ startX: 4, endX: 30, fillType: 2 }],
    color: '#000000',
    fontSize: 16,
    baseline: 12,
    rotation: 0,
    isVertical: false,
    leadersComplete: true,
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'textDecoration',
    bbox: { x: 10, y: 20, width: 40, height: 16 },
    decoration: {
      kind: 'emphasisDot',
      baseline: 12,
      rotation: 0,
      isVertical: false,
      fontSize: 16,
      ratio: 1,
      color: '#000000',
      shape: 0,
      underline: 'none',
      emphasisDot: 1,
      positions: [0, 12],
      positionsComplete: true,
    },
  }, 'screen');
  const beforeMirror = events.length;
  renderer.renderTextRun(canvas, {
    type: 'textRun',
    bbox: { x: 10, y: 20, width: 16, height: 16 },
    text: '①',
    style: { fontSize: 16 },
    charOverlap: { borderType: 1, innerCharSize: 80 },
    legacyVisuals: { charOverlap: 'mirror' },
  });
  const mirrorEvents = events.slice(beforeMirror);
  const beforeMalformed = events.length;
  renderer.renderOp(canvas, {
    type: 'textDecoration',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    decoration: {
      kind: 'underline',
      baseline: 8,
      rotation: 0,
      isVertical: false,
      fontSize: 10,
      ratio: 1,
      color: '#000000',
      shape: 0,
      underline: 'center',
      emphasisDot: 0,
      positions: [0, 10],
      positionsComplete: true,
    },
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'charOverlap',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    text: 'A'.repeat(4097),
    baseline: 8,
    rotation: 0,
    isVertical: false,
    style: { fontSize: 10 },
    positions: [],
    positionsComplete: true,
    charOverlap: { borderType: 1, innerCharSize: 100 },
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'charOverlap',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    text: 'A',
    baseline: 8,
    rotation: 0,
    isVertical: false,
    style: { fontSize: 10 },
    positions: [0, 10],
    positionsComplete: true,
    charOverlap: { borderType: 5, innerCharSize: 100 },
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'charOverlap',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    text: 'A',
    baseline: 8,
    rotation: 0,
    isVertical: false,
    style: { fontSize: 10 },
    positions: [],
    positionsComplete: true,
    charOverlap: { borderType: 1, innerCharSize: 100 },
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'textControlMark',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    baseline: 8,
    rotation: 0,
    isVertical: false,
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'tabLeader',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    fontSize: 10,
    baseline: 8,
    rotation: 0,
    isVertical: false,
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'charOverlap',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    text: 'A',
    baseline: 8,
    rotation: 0,
    isVertical: false,
    style: { fontSize: 10 },
    positions: [0, 10],
    charOverlap: { borderType: 1, innerCharSize: 100 },
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'textControlMark',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    fieldMarker: 'none',
    isParaEnd: false,
    isLineBreakEnd: false,
    baseline: 8,
    rotation: 0,
    isVertical: false,
    marks: [],
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'tabLeader',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    leaders: [{ startX: 1, endX: 8, fillType: 1 }],
    color: '#000000',
    fontSize: 10,
    baseline: 8,
    rotation: 0,
    isVertical: false,
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'textDecoration',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    decoration: {
      kind: 'underline',
      baseline: 8,
      rotation: 0,
      isVertical: false,
      fontSize: 10,
      ratio: 1,
      color: '#000000',
      shape: 0,
      underline: 'bottom',
      emphasisDot: 0,
      positions: [0, 10],
    },
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'textDecoration',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'textDecoration',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    decoration: {
      kind: 'underline',
      baseline: 8,
      rotation: 0,
      isVertical: false,
      fontSize: 10,
      ratio: 1,
      color: '#000000',
      shape: 0,
      underline: 'bottom',
      emphasisDot: 0,
      positions: [0, 10],
      positionsComplete: false,
    },
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'charOverlap',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    text: 'A',
    baseline: 8,
    rotation: 0,
    isVertical: false,
    style: { fontSize: 10 },
    positions: [0, 10],
    positionsComplete: false,
    charOverlap: { borderType: 1, innerCharSize: 100 },
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'tabLeader',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    leaders: [{ startX: 1, endX: 8, fillType: 1 }],
    leadersComplete: false,
    color: '#000000',
    fontSize: 10,
    baseline: 8,
    rotation: 0,
    isVertical: false,
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'tabLeader',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    leaders: [{ startX: 1, endX: 8, fillType: 1.5 }],
    leadersComplete: true,
    color: '#000000',
    fontSize: 10,
    baseline: 8,
    rotation: 0,
    isVertical: false,
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'tabLeader',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    leaders: [{ startX: 4, endX: 4, fillType: 1 }],
    leadersComplete: true,
    color: '#000000',
    fontSize: 10,
    baseline: 8,
    rotation: 0,
    isVertical: false,
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'textDecoration',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    decoration: {
      kind: 'underline',
      baseline: 8,
      rotation: 0,
      isVertical: false,
      fontSize: 10,
      ratio: 1,
      color: '#000000',
      shape: 0.5,
      underline: 'future',
      emphasisDot: 0,
      positions: [0, 10],
      positionsComplete: true,
    },
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'charOverlap',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    text: 'A',
    baseline: 8,
    rotation: 15,
    isVertical: false,
    style: { fontSize: 10 },
    positions: [0, 10],
    positionsComplete: true,
    charOverlap: { borderType: 1, innerCharSize: 100 },
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'textControlMark',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    baseline: 8,
    rotation: 15,
    isVertical: false,
    marks: [],
    marksComplete: true,
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'tabLeader',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    leaders: [{ startX: 1, endX: 8, fillType: 1 }],
    color: '#000000',
    fontSize: 10,
    baseline: 8,
    rotation: 15,
    isVertical: false,
    leadersComplete: true,
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'textDecoration',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    decoration: {
      kind: 'underline',
      baseline: 8,
      rotation: 15,
      isVertical: false,
      fontSize: 10,
      ratio: 1,
      color: '#000000',
      shape: 0,
      underline: 'bottom',
      emphasisDot: 0,
      positions: [0, 10],
      positionsComplete: true,
    },
  }, 'screen');
  renderer.renderOp(canvas, {
    type: 'tabLeader',
    bbox: { x: 0, y: 0, width: -1, height: 10 },
    leaders: [{ startX: 1, endX: 8, fillType: 1 }],
    color: '#000000',
    fontSize: 10,
    baseline: 8,
    rotation: 0,
    isVertical: false,
    leadersComplete: true,
  }, 'screen');
  return {
    events,
    mirrorEvents,
    malformedEvents: events.slice(beforeMalformed),
    oldHangulAlias,
    rejectedOldHangulAlias,
    resolvedOldHangulAlias,
    unsupportedOps: renderer.unsupportedOps,
  };
}

function runExecutableFontNativeGlyphReplay() {
  const events = [];
  class FakePaint {
    setAntiAlias() {}
    setStyle() {}
    setColor() {}
    setStrokeWidth() {}
    setStrokeJoin() {}
    setStrokeCap() {}
    setStrokeMiter() {}
    setPathEffect() {}
    delete() { events.push('paint.delete'); }
  }
  const fakeImage = {
    width: () => 1,
    height: () => 1,
    delete() { events.push('image.delete'); },
  };
  const fakePath = () => ({
    setFillType() {},
    delete() { events.push('path.delete'); },
  });
  const canvasKit = {
    MakeImageFromEncoded(bytes) {
      events.push(`image.decode:${bytes.byteLength}`);
      return fakeImage;
    },
    Path: {
      MakeFromSVGString(pathData) {
        events.push(`path.parse:${pathData}`);
        return fakePath();
      },
    },
    Paint: FakePaint,
    PaintStyle: { Fill: 0, Stroke: 1 },
    FillType: { EvenOdd: 0, Winding: 1 },
    StrokeJoin: { Round: 0, Bevel: 1, Miter: 2 },
    StrokeCap: { Round: 0, Square: 1, Butt: 2 },
    PathEffect: { MakeDash: () => null },
    ClipOp: { Intersect: 0 },
    Color: (r, g, b, a) => [r, g, b, a],
    XYWHRect: (x, y, width, height) => ({ x, y, width, height }),
  };
  const canvas = {
    save() { events.push('canvas.save'); },
    restore() { events.push('canvas.restore'); },
    concat() { events.push('canvas.concat'); },
    translate() { events.push('canvas.translate'); },
    scale() { events.push('canvas.scale'); },
    drawImageRect() { events.push('canvas.drawImageRect'); },
    drawPath() { events.push('canvas.drawPath'); },
  };
  const renderer = new CanvasKitLayerRendererRuntime(
    canvasKit,
    'default',
    { preference: 'software', requested: 'software' },
    null,
  );
  const textFallback = {
    type: 'textRun',
    bbox: { x: 0, y: 0, width: 16, height: 16 },
    text: '\ue100',
    variant: {
      equivalenceGroup: 'font-native-0',
      variantId: 'textRun',
      variantKind: 'textRun',
      isDefaultFallback: true,
    },
  };
  const bitmapBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
  const bitmapBytes = new Uint8Array(Buffer.from(bitmapBase64, 'base64'));
  const bitmapResourceKey = `img:blake3:${bitmapBytes.byteLength}:${bytesToHex(blake3(bitmapBytes))}`;
  const bitmap = {
    type: 'glyphOutline',
    bbox: { x: 0, y: 0, width: 16, height: 16 },
    payloadKind: 'bitmapGlyph',
    bitmapGlyph: {
      imageRef: 0,
      placement: { x: 0, y: 0, width: 16, height: 16 },
      scalingPolicy: 'sourceExact',
    },
    diagnostics: { strictVisualEligible: true },
    variant: {
      equivalenceGroup: 'font-native-0',
      variantId: 'glyphOutline',
      variantKind: 'glyphOutline',
      isDefaultFallback: false,
    },
  };
  bitmap.payloadResourceKey = `${glyphOutlinePayloadResourceKeyRuntime(bitmap)}:resource:${bitmapResourceKey}`;
  const svgFragment = '<svg viewBox="0 0 16 16"><path d="M0 0H16V16H0Z"/></svg>';
  const svgBytes = new TextEncoder().encode(svgFragment);
  const svgResourceKey = `svg:blake3:${svgBytes.byteLength}:${bytesToHex(blake3(svgBytes))}`;
  renderer.currentResources = {
    images: [bitmapBase64],
    imageKeys: [bitmapResourceKey],
    svgFragments: [svgFragment],
    svgKeys: [svgResourceKey],
  };
  renderer.selectTextVariants({
    kind: 'leaf',
    bounds: bitmap.bbox,
    ops: [textFallback, bitmap],
  });
  assert.equal(renderer.selectedTextVariantOps.has(bitmap), true);
  assert.equal(renderer.selectedTextVariantOps.has(textFallback), false);
  renderer.renderGlyphOutline(canvas, bitmap);

  const svg = {
    ...bitmap,
    payloadKind: 'svgGlyph',
    payloadResourceKey: undefined,
    bitmapGlyph: undefined,
    svgGlyph: {
      svgRef: 0,
      viewBox: { x: 0, y: 0, width: 16, height: 16 },
      staticSanitized: true,
      scriptAllowed: false,
      animationAllowed: false,
      externalResourcesAllowed: false,
      interactivityAllowed: false,
    },
  };
  svg.payloadResourceKey = `${glyphOutlinePayloadResourceKeyRuntime(svg)}:resource:${svgResourceKey}`;
  assert.equal(renderer.glyphOutlineVariantReplayable(svg), true);
  renderer.renderGlyphOutline(canvas, svg);

  const corrupt = { ...bitmap, payloadResourceKey: 'glyphPayload:bitmapGlyph:resource:img:missing' };
  assert.equal(renderer.glyphOutlineVariantReplayable(corrupt), false);
  renderer.lastRenderCompleted = true;
  renderer.localTypefacePending.set('pending:test-face', 1);
  assert.ok(renderer.diagnostics().readinessBlockers.includes('localFontsPending'));
  renderer.localTypefacePending.clear();
  return events;
}

function runExecutableEquationFallback() {
  const events = [];
  class FakeFont {
    setEdging() {}
    setHinting() {}
    setEmbeddedBitmaps() {}
    setLinearMetrics() {}
    setSubpixel() {}
    constructor(face) { events.push(`font.face:${face?.family}`); }
    getGlyphIDs(text) { return Uint16Array.from(Array.from(text), () => 1); }
    getGlyphWidths(glyphIds) { return Array.from(glyphIds, () => 8); }
    setScaleX(scale) { events.push(`font.scale:${scale}`); }
    setEmbolden() {}
    setSkewX(skew) { events.push(`font.skew:${skew}`); }
    delete() { events.push('font.delete'); }
  }
  class FakePaint {
    setAntiAlias() {}
    setStyle() {}
    setColor() {}
    setStrokeWidth() {}
    delete() { events.push('paint.delete'); }
  }
  const recordingCanvas = {
    save() { events.push('recording.save'); },
    restore() { events.push('recording.restore'); },
    translate() { events.push('recording.translate'); },
    scale() { events.push('recording.scale'); },
    drawLine() { events.push('canvas.drawLine'); },
    drawText() { events.push('canvas.drawText'); },
  };
  const picture = { delete() { events.push('picture.delete'); } };
  class FakePictureRecorder {
    beginRecording() { return recordingCanvas; }
    finishRecordingAsPicture() { return picture; }
    delete() { events.push('recorder.delete'); }
  }
  const renderer = new CanvasKitLayerRendererRuntime({
    Font: FakeFont,
    FontEdging: { AntiAlias: 1 },
    FontHinting: { None: 0 },
    Paint: FakePaint,
    PictureRecorder: FakePictureRecorder,
    PaintStyle: { Fill: 0, Stroke: 1 },
    Color: (r, g, b, a) => [r, g, b, a],
    XYWHRect: (x, y, width, height) => ({ x, y, width, height }),
  }, 'default', {}, {});
  renderer.equationTypeface = { family: 'math' };
  const canvas = {
    drawPicture() { events.push('canvas.drawPicture'); },
  };
  renderer.unsupportedOps = new Set();
  renderer.renderEquation(canvas, {
    type: 'equation',
    bbox: { x: 10, y: 20, width: 100, height: 30 },
    svgContent: '<svg><script>invalid</script></svg>',
    color: '#000000',
    fontSize: 12,
    layoutBox: {
      x: 0,
      y: 0,
      width: 40,
      height: 20,
      baseline: 10,
      kind: {
        type: 'fraction',
        numer: { x: 2, y: 0, width: 8, height: 8, baseline: 7, kind: { type: 'text', text: 'x' } },
        denom: { x: 2, y: 12, width: 8, height: 8, baseline: 7, kind: { type: 'number', text: '2' } },
      },
    },
  });
  assert.equal(renderer.unsupportedOps.size, 0, 'invalid equation SVG should use the semantic layout fallback');
  assert.ok(events.includes('canvas.drawLine'));
  assert.equal(events.filter((event) => event === 'canvas.drawText').length, 2);
  assert.equal(events.filter((event) => event === 'font.face:math').length, 2);
  assert.ok(events.includes('font.skew:-0.2'), 'variables inherit equation italic');
  assert.ok(events.includes('font.skew:0'), 'numbers remain upright');
  assert.ok(!events.some(event => event.startsWith('font.scale:')), 'glyphs retain their natural width');

  renderer.renderEquation(canvas, {
    type: 'equation',
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    layoutBox: {
      x: Number.NaN,
      y: 0,
      width: 10,
      height: 10,
      baseline: 8,
      kind: { type: 'text', text: 'x' },
    },
  });
  assert.ok(renderer.unsupportedOps.has('equation:invalidLayout'));
}

const fontNativeGlyphReplayEvents = runExecutableFontNativeGlyphReplay();
assert.ok(fontNativeGlyphReplayEvents.includes('canvas.drawImageRect'));
assert.ok(fontNativeGlyphReplayEvents.includes('canvas.drawPath'));
runExecutableEquationFallback();



















const placedSuperscriptReplay = runExecutableTextReplay({
  type: 'textRun',
  bbox: { x: 10, y: 100, width: 30, height: 20 },
  text: 'AB',
  baseline: 15,
  rotation: 90,
  placement: {
    runToPage: { a: 0, b: 1, c: -1, d: 0, e: 50, f: 60 },
    baselineY: 0,
  },
  positions: [0, 12, 24],
  style: { fontSize: 20, superscript: true },
});
assert.equal(placedSuperscriptReplay.error, null);
const superGlyphs=placedSuperscriptReplay.events.find(event=>event.type==='canvas.drawGlyphs');
assert.deepEqual(superGlyphs.glyphIds,[1,2]);
assert.deepEqual([superGlyphs.positions[0],superGlyphs.positions[2]],[0,12],'Producer advances survive superscript styling');
assert.equal(superGlyphs.positions[1],superGlyphs.positions[3]);
assert(superGlyphs.positions[1]<0 && superGlyphs.positions[1]>-20,'Superscript stays above the baseline within one em');
assert.deepEqual([superGlyphs.x,superGlyphs.y],[0,0]);

const rotatedSubscriptReplay = runExecutableTextReplay({
  type: 'textRun',
  bbox: { x: 7, y: 100, width: 30, height: 20 },
  text: 'AB',
  baseline: 15,
  rotation: 90,
  positions: [0, 9, 18],
  style: { fontSize: 20, subscript: true },
});
assert.deepEqual(
  rotatedSubscriptReplay.events.find((event) => event.type === 'canvas.rotate'),
  { type: 'canvas.rotate', rotation: 90, x: 7, y: 115 },
  'legacy placement fallback should add the run-local baseline exactly once',
);
const subPositions=rotatedSubscriptReplay.events.find(event=>event.type==='canvas.drawGlyphs').positions;
assert.deepEqual([subPositions[0],subPositions[2]],[0,9]);
assert.equal(subPositions[1],subPositions[3]);
assert(subPositions[1]>0 && subPositions[1]<20,'Subscript stays below the baseline within one em');

const projectedTextReplay = runExecutableTextReplay({
  type: 'textRun',
  bbox: { x: 0, y: 20, width: 30, height: 20 },
  text: '\u{F012B}',
  displayText: '(인)',
  baseline: 15,
  positions: [0, 5],
  displayPositions: [0, 11, 22, 33],
  style: { fontSize: 20, superscript: true },
});
assert.deepEqual(
  projectedTextReplay.events.find((event) => event.type === 'paragraphBuilder.addText'),
  { type: 'paragraphBuilder.addText', text: '(인)' },
  'CanvasKit replay should shape the actual PUA display projection',
);
assert.equal(
  projectedTextReplay.events.some((event) => event.type === 'canvas.drawGlyphs'),
  false,
  'a non-ASCII PUA display projection should not enter direct glyph replay',
);

const shapedTextReplay = runExecutableTextReplay({
  type: 'textRun',
  bbox: { x: 0, y: 20, width: 30, height: 20 },
  text: 'e\u0301',
  baseline: 15,
  positions: [0, 8, 8],
  style: { fontSize: 20, superscript: true },
});
assert.equal(
  shapedTextReplay.events.some((event) => event.type === 'font.getGlyphIDs'),
  false,
  'text requiring shaping should not enter nominal glyph replay',
);
assert.equal(
  shapedTextReplay.events.some((event) => event.type === 'canvas.drawParagraph'),
  true,
  'text requiring shaping should use CanvasKit paragraph replay',
);
assert.equal(shapedTextReplay.unsupportedOps.has('textRun:scriptTextRequiresShaping'), false);

const unavailableShapingReplay = runExecutableTextReplay({
  type: 'textRun',
  bbox: { x: 0, y: 20, width: 30, height: 20 },
  text: 'e\u0301',
  baseline: 15,
  positions: [0, 8, 8],
  style: { fontSize: 20, superscript: true },
}, { shapedTextAvailable: false });
assert.equal(unavailableShapingReplay.unsupportedOps.has('textRun:scriptTextRequiresShaping'), true);
assert.equal(
  unavailableShapingReplay.events.some((event) => event.type === 'canvas.drawText'),
  false,
  'text requiring shaping must not silently fall back to CanvasKit drawText',
);

const missingGlyphReplay = runExecutableTextReplay({
  type: 'textRun',
  bbox: { x: 0, y: 20, width: 30, height: 20 },
  text: 'AB',
  baseline: 15,
  positions: [0, 8, 16],
  style: { fontSize: 20, superscript: true },
}, { glyphIds: [1, 0] });
assert.equal(missingGlyphReplay.unsupportedOps.has('textRun:glyphMapping'), true);
assert.equal(
  missingGlyphReplay.events.some((event) => event.type === 'canvas.drawGlyphs'),
  true,
  'an unresolved glyph should retain its producer position while runtime diagnostics fail closed',
);

const fallbackGlyphReplay = runExecutableTextReplay({
  type: 'textRun',
  bbox: { x: 0, y: 20, width: 30, height: 20 },
  text: 'A①B',
  baseline: 15,
  positions: [0, 8, 17, 25],
  style: { fontFamily: 'Prepared', fontSize: 20 },
}, {
  glyphIds: [1, 0, 2],
  fallbackGlyphIds: [0, 7, 0],
  usePreparedTypeface: true,
});
assert.equal(fallbackGlyphReplay.unsupportedOps.has('textRun:glyphMapping'), false);
assert.deepEqual(
  fallbackGlyphReplay.events
    .filter((event) => event.type === 'canvas.drawGlyphs')
    .map(({ glyphIds: ids, positions }) => ({ glyphIds: ids, positions })),
  [
    { glyphIds: [1], positions: [0, 0] },
    { glyphIds: [7], positions: [8, 0] },
    { glyphIds: [2], positions: [17, 0] },
  ],
  'fallback glyphs should switch fonts per contiguous run without changing serialized positions',
);

const symbolGlyphReplay = runExecutableTextReplay({
  type: 'textRun',
  bbox: { x: 0, y: 20, width: 30, height: 20 },
  text: 'A①B',
  baseline: 15,
  positions: [0, 8, 17, 25],
  style: { fontFamily: 'Prepared', fontSize: 20 },
}, {
  glyphIds: [1, 0, 2],
  fallbackGlyphIds: [0, 0, 0],
  symbolGlyphIds: [0, 9, 0],
  usePreparedTypeface: true,
});
assert.equal(symbolGlyphReplay.unsupportedOps.has('textRun:glyphMapping'), false);
assert.deepEqual(
  symbolGlyphReplay.events
    .filter((event) => event.type === 'canvas.drawGlyphs')
    .map(({ glyphIds: ids, positions }) => ({ glyphIds: ids, positions })),
  [
    { glyphIds: [1], positions: [0, 0] },
    { glyphIds: [9], positions: [8, 0] },
    { glyphIds: [2], positions: [17, 0] },
  ],
  'the bounded symbol face should be the final positioned fallback without moving surrounding text',
);

const oldHangulReplay = runExecutableTextReplay({
  type: 'textRun',
  bbox: { x: 10, y: 20, width: 40, height: 20 },
  text: 'A\u{F53A}B',
  displayText: 'A\u1112\u119E\u11ABB',
  baseline: 15,
  positions: [0, 8, 20, 28],
  displayPositions: [0, 8, 8, 8, 20, 28],
  style: { fontFamily: 'Prepared', fontSize: 20 },
}, { usePreparedTypeface: true });
assert.equal(oldHangulReplay.unsupportedOps.has('textRun:glyphMapping'), false);
assert.deepEqual(
  oldHangulReplay.events.find(event => event.type === 'paragraphBuilder.addText'),
  { type: 'paragraphBuilder.addText', text: '\u1112\u119E\u11AB' },
  'old Hangul PUA projection should shape its Jamo sequence as one cluster',
);
const oldHangulDraw=oldHangulReplay.events.find(event=>event.type==='canvas.drawParagraph');
const oldHangulTranslation=oldHangulReplay.events.filter(event=>event.type==='canvas.translate').at(-1);
assert.deepEqual({x:oldHangulDraw.x+oldHangulTranslation.x,y:oldHangulDraw.y+oldHangulTranslation.y},{x:18,y:15},'Shaped cluster keeps its serialized position through canvas translation');

assert.deepEqual(
  oldHangulReplay.events
    .filter(event => event.type === 'canvas.drawGlyphs')
    .map(({ glyphIds: ids, positions }) => ({ glyphIds: ids, positions })),
  [
    { glyphIds: [1], positions: [0, 0] },
    { glyphIds: [5], positions: [20, 0] },
  ],
  'surrounding glyphs should retain their producer positions around shaped old Hangul',
);

const boxedPuaReplay = runExecutableTextReplay({
  type: 'textRun',
  bbox: { x: 0, y: 20, width: 20, height: 20 },
  text: '\u{F02B1}',
  baseline: 15,
  positions: [0, 18],
  style: { fontFamily: 'Prepared', fontSize: 20 },
}, {
  glyphIds: [0],
  fallbackGlyphIds: [0],
  symbolGlyphIds: [0],
  usePreparedTypeface: true,
});
assert.equal(boxedPuaReplay.unsupportedOps.has('textRun:glyphMapping'), false);
assert.equal(
  boxedPuaReplay.events.some(event => event.type === 'canvas.drawRect'),
  true,
  'Hancom boxed-number PUA should use a bounded vector box fallback',
);
assert.equal(
  boxedPuaReplay.events.some(event => event.type === 'canvas.drawText' && event.text === '1'),
  true,
  'Hancom boxed-number PUA should preserve the encoded number',
);

const textSpecialReplay = runExecutableTextSpecialReplay();
assert.equal(textSpecialReplay.events.some(event => event.type === 'canvas.drawOval'), true);
assert.equal(
  textSpecialReplay.events.some(event => event.type === 'canvas.drawText' && event.text === '1'),
  true,
  'circled overlap text should replay as a directly drawn border plus display digit',
);
assert.equal(
  textSpecialReplay.events.filter(event => event.type === 'canvas.drawLine').length >= 6,
  true,
  'control marks should replay as font-independent vectors at producer positions',
);
assert.equal(
  textSpecialReplay.events.some(event => event.type === 'canvas.drawText' && ['∨', '↵'].includes(event.text)),
  false,
  'control mark replay should not depend on optional symbol glyph coverage',
);
assert.equal(textSpecialReplay.events.some(event => event.type === 'pathEffect.create'), true);
assert.equal(textSpecialReplay.events.some(event => event.type === 'canvas.drawCircle'), true);
assert.equal(
  textSpecialReplay.events.some(event => event.type === 'font.scaleX' && event.scale === 0.7),
  true,
  'combined overlap numbers should use the Canvas2D digit-count compression formula',
);
assert.equal(
  textSpecialReplay.rejectedOldHangulAlias,
  null,
  'a typeface-only old-Hangul alias must not satisfy the shaping contract',
);
assert.equal(
  textSpecialReplay.resolvedOldHangulAlias,
  textSpecialReplay.oldHangulAlias,
  'a prepared old-Hangul alias must remain reachable when the dedicated subset is unavailable',
);
assert.deepEqual(textSpecialReplay.mirrorEvents, [], 'the TextRun char-overlap mirror must not double-paint');
assert.deepEqual(
  textSpecialReplay.malformedEvents,
  [],
  'malformed or over-limit text visuals must fail closed without drawing partial output',
);
for (const diagnostic of [
  'charOverlap:visualItemLimitExceeded',
  'charOverlap:invalidGeometry',
  'textControlMark:invalidGeometry',
  'textControlMark:visualItemLimitExceeded',
  'tabLeader:invalidGeometry',
  'tabLeader:visualItemLimitExceeded',
  'textDecoration:invalidGeometry',
  'textDecoration:visualItemLimitExceeded',
  'charOverlap:rotatedText',
  'textControlMark:rotatedText',
  'tabLeader:rotatedText',
  'textDecoration:rotatedText',
]) {
  assert.equal(
    textSpecialReplay.unsupportedOps.has(diagnostic),
    true,
    `malformed text visuals should report ${diagnostic}`,
  );
}

const alternatingGlyphText = 'A'.repeat(4098);
const alternatingGlyphReplay = runExecutableTextReplay({
  type: 'textRun',
  bbox: { x: 0, y: 20, width: 4098, height: 20 },
  text: alternatingGlyphText,
  baseline: 15,
  positions: Array.from({ length: 4099 }, (_, index) => index),
  style: { fontSize: 12 },
}, {
  glyphIds: Array.from({ length: 4098 }, (_, index) => index % 2 === 0 ? 1 : 0),
  symbolGlyphIds: Array.from({ length: 4098 }, (_, index) => index % 2 === 0 ? 0 : 1),
});
assert.equal(
  alternatingGlyphReplay.unsupportedOps.has('textRun:fallbackSpanLimitExceeded'),
  true,
  'alternating fallback coverage must fail closed before native draw-call amplification',
);
assert.equal(
  alternatingGlyphReplay.events.some(event => event.type === 'canvas.drawGlyphs'),
  false,
  'over-limit fallback segmentation must not draw a partial text run',
);

const cleanupReplay = runExecutableTextReplay({
  type: 'textRun',
  bbox: { x: 0, y: 20, width: 30, height: 20 },
  text: 'AB',
  baseline: 15,
  positions: [0, 8, 16],
  style: { fontSize: 20, superscript: true },
}, { drawGlyphsError: new Error('draw failed') });
assert.equal(cleanupReplay.error?.message, 'draw failed');
for (const cleanupEvent of ['canvas.restore', 'font.delete', 'paint.delete']) {
  assert.equal(
    cleanupReplay.events.some((event) => event.type === cleanupEvent),
    true,
    `${cleanupEvent} should run after drawGlyphs throws`,
  );
}

const shapedCleanupReplay = runExecutableTextReplay({
  type: 'textRun',
  bbox: { x: 0, y: 20, width: 30, height: 20 },
  text: 'e\u0301',
  baseline: 15,
  positions: [0, 8, 8],
  style: { fontSize: 20, superscript: true },
}, { drawParagraphError: new Error('paragraph draw failed') });
assert.equal(shapedCleanupReplay.error?.message, 'paragraph draw failed');
for (const cleanupEvent of ['canvas.restore', 'paragraph.delete', 'paragraphBuilder.delete', 'paint.delete']) {
  assert.equal(
    shapedCleanupReplay.events.some((event) => event.type === cleanupEvent),
    true,
    `${cleanupEvent} should run after drawParagraph throws`,
  );
}
const shiftedInkExpected = new PNG({ width: 3, height: 1 });
shiftedInkExpected.data.fill(255);
shiftedInkExpected.data.set([0, 0, 0, 255], 0);
const shiftedInkActual = new PNG({ width: 3, height: 1 });
shiftedInkActual.data.fill(255);
shiftedInkActual.data.set([0, 0, 0, 255], 4);
const shiftedInkDiff = await comparePngBuffers(
  PNG.sync.write(shiftedInkExpected),
  PNG.sync.write(shiftedInkActual),
  {
    inkMaskNeighborhoodRadius: 1,
    inkMaskMaxDiffPixels: 0,
    nonInkMaxDiffPixels: 0,
    solidInkMaxDiffPixels: 0,
  },
);
assert.equal(shiftedInkDiff.passed, true, 'nearby rasterized ink should pass the ink-mask gate');
assert.equal(shiftedInkDiff.hasVisualBudget, true);
assert.equal(shiftedInkDiff.passMetric, 'rasterOnly');

const collapsedInkExpected = new PNG({ width: 3, height: 1 });
collapsedInkExpected.data.fill(255);
collapsedInkExpected.data.set([0, 0, 0, 255], 0);
collapsedInkExpected.data.set([0, 0, 0, 255], 8);
const collapsedInkActual = new PNG({ width: 3, height: 1 });
collapsedInkActual.data.fill(255);
collapsedInkActual.data.set([0, 0, 0, 255], 4);
const collapsedInkDiff = await comparePngBuffers(
  PNG.sync.write(collapsedInkExpected),
  PNG.sync.write(collapsedInkActual),
  { inkMaskNeighborhoodRadius: 1, inkMaskMaxDiffPixels: 0 },
);
assert.equal(
  collapsedInkDiff.passed,
  false,
  'one actual ink pixel must not satisfy multiple expected ink pixels',
);
assert.equal(collapsedInkDiff.inkMaskDiffPixels, 1);

const augmentingInkExpected = new PNG({ width: 3, height: 2 });
augmentingInkExpected.data.fill(255);
augmentingInkExpected.data.set([0, 0, 0, 255], 4);
augmentingInkExpected.data.set([0, 0, 0, 255], 12);
const augmentingInkActual = new PNG({ width: 3, height: 2 });
augmentingInkActual.data.fill(255);
augmentingInkActual.data.set([0, 0, 0, 255], 0);
augmentingInkActual.data.set([0, 0, 0, 255], 8);
const augmentingInkDiff = await comparePngBuffers(
  PNG.sync.write(augmentingInkExpected),
  PNG.sync.write(augmentingInkActual),
  { inkMaskNeighborhoodRadius: 1, inkMaskMaxDiffPixels: 0 },
);
assert.equal(
  augmentingInkDiff.inkMaskDiffPixels,
  0,
  'one-to-one ink matching should find an augmenting path instead of depending on scan order',
);

const missingInkExpected = new PNG({ width: 3, height: 1 });
missingInkExpected.data.fill(255);
const missingInkActual = new PNG({ width: 3, height: 1 });
missingInkActual.data.fill(255);
missingInkActual.data.set([0, 0, 0, 255], 8);
const missingInkDiff = await comparePngBuffers(
  PNG.sync.write(missingInkExpected),
  PNG.sync.write(missingInkActual),
  { inkMaskMaxDiffPixels: 0 },
);
assert.equal(missingInkDiff.passed, false, 'new unmatched ink should fail the ink-mask gate');
assert.equal(missingInkDiff.inkMaskDiffPixels, 1);
const noBudgetDiff = await comparePngBuffers(
  PNG.sync.write(missingInkExpected),
  PNG.sync.write(missingInkExpected),
);
assert.equal(noBudgetDiff.hasVisualBudget, false, 'readiness requires an explicit visual budget');
const blankInkDiff = await comparePngBuffers(
  PNG.sync.write(missingInkExpected),
  PNG.sync.write(missingInkExpected),
  { maxDiffPixels: 0, minimumInkPixels: 1 },
);
assert.equal(blankInkDiff.passed, false, 'matching blank captures must not pass readiness');
assert.equal(blankInkDiff.minimumInkBudgetPassed, false);

console.log('Production renderer replay and visual comparison passed');
