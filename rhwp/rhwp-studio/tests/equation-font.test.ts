import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { equationFontFamilies, equationLocalFontFace, createEquationTextMeasurer } from '../src/core/equation-font.ts';
import type { LocalFontRecord } from '../src/core/local-fonts.ts';

test('legacy equations retain their source face and prefer real Times italic fallback', () => {
  assert.deepEqual(equationFontFamilies('HYhwpEQ').slice(0, 4), [
    'HYhwpEQ', 'Times New Roman', 'Times', 'STIX Two Text',
  ]);
  for (const family of ['Latin Modern Math', 'Cambria Math', 'STIX Two Math']) {
    assert.equal(equationFontFamilies(family)[0], family);
  }
});

test('equation variables and numbers choose distinct real italic and upright faces', () => {
  const records: LocalFontRecord[] = ['Bold', 'Italic', 'Regular', 'Bold Italic'].map(style => ({
    family: 'Times New Roman',
    fullName: `Times New Roman ${style}`,
    postscriptName: `Times-${style}`,
    style,
    displayName: 'Times New Roman',
    aliases: ['Times New Roman'],
  }));
  assert.equal(equationLocalFontFace(records, 'Times New Roman', true, false)?.style, 'Italic');
  assert.equal(equationLocalFontFace(records, 'Times New Roman', false, false)?.style, 'Regular');
  assert.equal(equationLocalFontFace(records, 'Times New Roman', true, true)?.style, 'Bold Italic');
  assert.equal(equationLocalFontFace(records, 'Cambria Math', false, false), undefined);
});

test('legacy math cmap keeps intrinsic italic, roman, digits and Greek distinct', async () => {
  const { legacyEquationGlyph, legacyEquationRuns } = await import('../src/core/equation-font.ts');
  assert.deepEqual(legacyEquationGlyph('°', false, true), ['\ue0c8', false]);
  assert.deepEqual(legacyEquationGlyph('°', false, false), ['°', false]);
  assert.deepEqual(legacyEquationRuns('°', false, false), [{ text: '°', italic: false }]);
  assert.deepEqual(legacyEquationRuns('pif1+αΩL', true), [
    { text: '\ue0f4\ue0ed\ue0ea\ue034\ue048\ue09d\ue09c', italic: false },
    { text: '\ue00b', italic: true },
  ]);
  assert.deepEqual(legacyEquationRuns('PMexp1+α', false), [{ text: 'PMexp\ue034\ue048α', italic: false }]);
  assert.deepEqual(legacyEquationRuns('∑', false, true), [{ text: '\ue067', italic: false, baselineEm: 0 }]);
  assert.deepEqual(legacyEquationRuns('x1.2=rm', true, true), [
    { text: '\ue0fc', italic: false, baselineEm: 0.06 },
    { text: '\ue034', italic: false, baselineEm: 0.06 },
    { text: '\ue053', italic: false, baselineEm: 0 },
    { text: '\ue035', italic: false, baselineEm: 0.06 },
    { text: '\ue047', italic: false, baselineEm: 0 },
    { text: '\ue0f6', italic: false, baselineEm: 0.06 },
    { text: '\ue0f1', italic: false, baselineEm: 0.06 },
  ]);
  assert.deepEqual(legacyEquationRuns('A1', false, true), [
    { text: 'A', italic: false, baselineEm: 0 },
    { text: '\ue034', italic: false, baselineEm: 0.06 },
  ]);
  assert.deepEqual(legacyEquationRuns('→∞', false, true), [
    { text: '→', italic: false, baselineEm: 0.06 },
    { text: '∞', italic: false, baselineEm: 0.06 },
  ]);
  assert.deepEqual(legacyEquationRuns('→∞', false), [{ text: '→∞', italic: false }]);
});

/** 최소 SFNT: format4 cmap의 한 문자만 가진다. 누락 글립 경계도 검증한다. */
function fontWithGlyph(code: number, glyphId = 1): ArrayBuffer {
  const bytes = new ArrayBuffer(96);
  const v = new DataView(bytes);
  const u16 = (offset: number, value: number) => v.setUint16(offset, value);
  const u32 = (offset: number, value: number) => v.setUint32(offset, value);
  u32(0, 0x00010000); u16(4, 2);
  u32(12, 0x6d617870); u32(20, 44); u32(24, 6); u16(48, 2);
  u32(28, 0x636d6170); u32(36, 52); u32(40, 44);
  u16(54, 1); u16(56, 3); u16(58, 1); u32(60, 12);
  const t = 64;
  u16(t, 4); u16(t + 2, 32); u16(t + 6, 4);
  u16(t + 14, code); u16(t + 16, 0xffff);
  u16(t + 20, code); u16(t + 22, 0xffff);
  u16(t + 24, (glyphId - code) & 0xffff); u16(t + 26, 1);
  return bytes;
}

test('legacy PUA is allowed only for a loaded exact face whose cmap covers the text', async () => {
  const { createEquationFontResolver } = await import('../src/core/equation-font.ts');
  let record: LocalFontRecord | null = null;
  const resolver = createEquationFontResolver(() => record, () => fontWithGlyph(0xe0f4));
  assert.equal(resolver('HYhwpEQ', '\ue0f4'), null);
  record = { family: 'HyhwpEQ', fullName: 'HyhwpEQ', postscriptName: 'HyhwpEQ', style: 'Regular', displayName: 'HyhwpEQ', aliases: ['HYhwpEQ'] };
  assert.equal(resolver('HYhwpEQ', '\ue0f4'), null, 'saved detection metadata alone must not enable PUA');
  record.runtimeFamily = '__imported_hy';
  assert.equal(resolver('HYhwpEQ', '\ue0f4'), '__imported_hy');
  assert.equal(resolver('HYhwpEQ', '\ue0f4\ue0ed'), null, 'subset missing i must use original Unicode fallback');
  assert.equal(resolver('Times New Roman', '\ue0f4'), null);
  const degreeResolver = createEquationFontResolver(() => record, () => fontWithGlyph(0xe0c8));
  assert.equal(degreeResolver('HYhwpEQ', '\ue0c8'), '__imported_hy');
  assert.equal(resolver('HYhwpEQ', '\ue0c8'), null, 'missing degree PUA uses Unicode fallback');
});

test('cmap validation rejects malformed data and out-of-range glyph IDs', async () => {
  const { sfntCoversText } = await import('../src/core/sfnt-cmap.ts');
  assert.equal(sfntCoversText(fontWithGlyph(0xe0f4), '\ue0f4'), true);
  assert.equal(sfntCoversText(fontWithGlyph(0xe0f4, 0), '\ue0f4'), false);
  assert.equal(sfntCoversText(fontWithGlyph(0xe0f4, 0xffff), '\ue0f4'), false);
  assert.equal(sfntCoversText(new ArrayBuffer(2), '\ue0f4'), false);
});

test('HFT bank lookup requires an imported exact face and leaves uncovered glyphs to fallback', async () => {
  const { createEquationFontResolver } = await import('../src/core/equation-font.ts');
  const record: LocalFontRecord = { family: 'HSUSFL', fullName: 'HSUSFL', postscriptName: 'HSUSFL', style: 'Regular', displayName: 'HSUSFL', aliases: ['HSUSFL'], runtimeFamily: '__imported_greek' };
  const resolver = createEquationFontResolver(() => record, () => fontWithGlyph(0x03bb));
  assert.equal(resolver('HSUSFL', 'λ'), '__imported_greek');
  assert.equal(resolver('HSUSFL', 'x'), null);
  assert.equal(resolver('HSUSRI', 'λ'), null, 'a substituted face must not enable a different bank');
});

test('legacy Unicode literals use actual font cell metrics rather than a fixed size factor', async () => {
  const { sfntEmToCellRatio } = await import('../src/core/sfnt-cmap.ts');
  const { createEquationLiteralFontResolver } = await import('../src/core/equation-font.ts');
  const old = new Uint8Array(fontWithGlyph(0x03bb));
  const bytes = new ArrayBuffer(240); const data = new Uint8Array(bytes); const v = new DataView(bytes);
  data.set(old.subarray(0, 44)); data.set(old.subarray(44), 76);
  v.setUint16(4, 4); v.setUint32(20, 76); v.setUint32(36, 84);
  v.setUint32(44, 0x68656164); v.setUint32(52, 128); v.setUint32(56, 54);
  v.setUint32(60, 0x68686561); v.setUint32(68, 184); v.setUint32(72, 36);
  v.setUint16(146, 1000); v.setInt16(188, 1070); v.setInt16(190, -230);
  assert.equal(sfntEmToCellRatio(bytes), 1000 / 1300);
  assert.equal(sfntEmToCellRatio(new ArrayBuffer(4)), null);
  const record: LocalFontRecord = { family: 'HCR Batang', fullName: 'HCR Batang', postscriptName: 'HCRBatang', style: 'Regular', displayName: 'HCR Batang', aliases: [], runtimeFamily: '__imported_literal' };
  const resolve = createEquationLiteralFontResolver(() => record, () => bytes);
  assert.deepEqual(resolve('λ'), { family: '__imported_literal', emScale: 1000 / 1300 });
  assert.equal(resolve('Δ'), null, 'missing Unicode literal keeps fallback');
});

test('수식 측정은 실제 글립의 잉크와 굵기 및 run 커닝을 보존한다', async () => {
  const { createEquationTextMeasurer } = await import('../src/core/equation-font.ts');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const calls: Array<{ text: string; font: string }> = [];
  const context = { font: '', measureText(text: string) { calls.push({ text, font: this.font }); return { width: text.length === 2 ? 13 : 8, actualBoundingBoxLeft: 0, actualBoundingBoxRight: text.length === 2 ? 15 : 10 }; } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => context }) } });
  try {
    const record: LocalFontRecord = { family: 'HYhwpEQ', fullName: 'HYhwpEQ', postscriptName: 'HYhwpEQ', style: 'Regular', displayName: 'HYhwpEQ', aliases: [], runtimeFamily: '__hy' };
    const measure = createEquationTextMeasurer(name => name === 'HYhwpEQ' ? record : null, () => fontWithGlyph(0xe0f4));
    assert.deepEqual(measure('HYhwpEQ', 'p', 16, true, false, true), { advance: 8, inkLeft: 0, inkRight: 10 });
    assert.deepEqual(measure('HYhwpEQ', 'pp', 16, true, false, true, true), { advance: 13, inkLeft: 0, inkRight: 15 });
    assert.equal(calls[1].text, '\ue0f4\ue0f4');
    assert.equal(calls[1].font, 'bold 16.000px "__hy"');
    assert.equal(calls[0].text, '\ue0f4');
    assert.equal(calls[0].font, '16.000px "__hy"', 'intrinsic italic glyph must not be slanted twice');
    assert.equal(measure('HYhwpEQ', 'i', 16, true, false, true), null);
    assert.equal(measure('HYhwpEQ', 'p', 16, true, true, true), null, 'missing HFT keeps offline layout fallback');
    const bank: LocalFontRecord = { ...record, family: 'HSUSR', fullName: 'HSUSR', postscriptName: 'HSUSR', runtimeFamily: '__hft' };
    const legacyMeasure = createEquationTextMeasurer(name => name === 'HSUSR' ? bank : null, () => fontWithGlyph(0x00b0));
    assert.deepEqual(legacyMeasure('HYhwpEQ', '°', 16, false, true, false), { advance: 8, inkLeft: 0, inkRight: 10 });
    assert.equal(calls.at(-1)?.text, '°', 'empty-version HFT path keeps the Unicode degree glyph');
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});


test('modern equation advances reproduce the hinted size steps while preserving paint size', async () => {
  const { modernEquationAdvance } = await import('../src/core/equation-font.ts');
  for (const [points, digitAdvance] of [[10, 4.725], [11, 4.725], [12, 5.4], [13, 6.075], [16, 7.425], [20, 8.775]]) {
    const pixels = points * 4 / 3;
    assert.ok(Math.abs(modernEquationAdvance(pixels * 0.5, pixels) * 3 / 4 - digitAdvance) < 1e-9);
  }
});


test('modern advance shrink follows synthetic glyph style rather than the italic request', async () => {
  const { modernEquationAdvance, legacyEquationRuns } = await import('../src/core/equation-font.ts');
  for (const [character, italic, shrink] of [['A', true, 1], ['A', false, 0.9], ['a', true, 0.9], ['α', true, 0.9]] as const) {
    const synthetic = legacyEquationRuns(character, italic)[0].italic;
    assert.equal(modernEquationAdvance(10, 20, synthetic), 10 * shrink);
  }
});

const modernHyFixture = readFileSync(new URL('../../tests/fixtures/fonts/RHWPShapingFixture.ttf', import.meta.url));
const modernHyBytes = modernHyFixture.buffer.slice(modernHyFixture.byteOffset, modernHyFixture.byteOffset + modernHyFixture.byteLength);
const modernHyRecord = { family: 'HYhwpEQ', fullName: 'HYhwpEQ', postscriptName: 'HYhwpEQ', style: 'Regular', displayName: 'HYhwpEQ', aliases: [], runtimeFamily: '__hy' };

test('short modern square paint follows the loaded face and excludes other fences', async () => {
  const { modernShortSquarePaintMetrics } = await import('../src/core/equation-font.ts');
  const { sfntTrueTypeRunMetrics } = await import('../src/core/sfnt-cmap.ts');
  const fixture = readFileSync(new URL('../../tests/fixtures/fonts/HYhwpEQSourceFixture.ttf', import.meta.url));
  const bytes = fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength);
  for (const size of [6, 9, 12]) {
    const open = sfntTrueTypeRunMetrics(bytes, '\ue049', size)!;
    const close = sfntTrueTypeRunMetrics(bytes, '\ue04a', size)!;
    const body = { x: open.advance + size * 0.225, width: size * 0.5 };
    const layout = { left: '[', right: ']', height: size, body,
      width: body.x + body.width + close.advance + size * 0.225 };
    assert.deepEqual(modernShortSquarePaintMetrics(bytes, size, layout, true), {
      openInkLeft: open.inkLeft, rightSlot: close.advance + size * 0.10,
    });
    assert.equal(modernShortSquarePaintMetrics(bytes, size, layout, false), null);
    assert.equal(modernShortSquarePaintMetrics(null, size, layout, true), null);
    assert.equal(modernShortSquarePaintMetrics(fontWithGlyph(0xe049), size, layout, true), null);
    assert.equal(modernShortSquarePaintMetrics(bytes, size,
      { ...layout, left: '(' }, true), null);
    assert.equal(modernShortSquarePaintMetrics(bytes, size,
      { ...layout, height: size * 2 }, true), null);
  }
});

test('mixed modern HY runs keep covered glyph metrics and native CJK pitch', () => {
  const measure = createEquationTextMeasurer(() => modernHyRecord, () => modernHyBytes);
  const mixed = measure('HYhwpEQ', 'A배V', 10, false, false, true)!;
  assert.ok(Math.abs(mixed.advance - 19.8) < 1e-9);
  assert.ok(Math.abs(mixed.inkLeft - .5) < 1e-9);
  assert.ok(Math.abs(mixed.inkRight - 19.4) < 1e-9);
  assert.deepEqual(measure('HYhwpEQ', '배수', 10, true, false, true), { advance: 18, inkLeft: 0, inkRight: 19 });
  const covered = measure('HYhwpEQ', 'AV', 10, false, false, true)!;
  assert.ok(Math.abs(covered.advance - 10.8) < 1e-9);
  assert.ok(Math.abs(covered.inkRight - 10.4) < 1e-9);
  assert.equal(measure('HYhwpEQ', 'Ω', 10, false, false, true), null);
  assert.equal(measure('HYhwpEQ', '한', 10, false, true, true), null);
});

test('CJK pitch requires a loaded exact source with valid font data', () => {
  assert.equal(createEquationTextMeasurer(() => ({ ...modernHyRecord, runtimeFamily: undefined }), () => modernHyBytes)('HYhwpEQ', '한', 10, false, false, true), null);
  assert.equal(createEquationTextMeasurer(() => ({ ...modernHyRecord, family: 'Other' }), () => modernHyBytes)('HYhwpEQ', '한', 10, false, false, true), null);
  assert.equal(createEquationTextMeasurer(() => modernHyRecord, () => new ArrayBuffer(2))('HYhwpEQ', '한', 10, false, false, true), null);
});
