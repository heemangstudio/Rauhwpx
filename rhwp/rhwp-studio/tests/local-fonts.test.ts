import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  clearStoredLocalFonts,
  detectLocalFonts,
  getDetectedLocalFonts,
  getLocalFontRecords,
  getLocalFontState,
  getLocalFonts,
  importLocalFontFiles,
  importedFontPhysicalStyle,
  getImportedFontGeneration,
  getImportedLocalFontBytes,
  getSessionLocalFontFace,
  hasImportedLocalFontFace,
  localFontImportMessage,
  LOCAL_FONT_BYTE_READ_CONCURRENCY,
  LOCAL_FONT_MAX_BYTES_PER_FACE,
  LOCAL_FONT_MAX_FACES_PER_DOCUMENT,
  localFontFaceKey,
  loadLocalFontBytes,
  loadLocalFontBytesFor,
  loadStoredLocalFonts,
  registerLocalFontFace,
  setDesktopFontByteReader,
  resetLocalFontsForTests,
  resolveLocalFont,
  type LocalFontSnapshot,
} from '../src/core/local-fonts.ts';
import { analyzeDocumentFonts } from '../src/core/document-font-status.ts';
import { createEquationLiteralFontResolver } from '../src/core/equation-font.ts';
import { fontFamilyChainForDisplay, prefersImportedHancomSubstitute } from '../src/core/font-substitution.ts';
import { setHftWasmApi, takeHftOutlineChange } from '../src/core/hft-glyphs.ts';

const STORAGE_KEY = 'rhwp-local-fonts';

type TestGlobals = typeof globalThis & {
  browser?: unknown;
  chrome?: unknown;
  document?: unknown;
  localStorage?: Storage;
  queryLocalFonts?: unknown;
};

function createStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  } as Storage;
}

function sortedKo(values: string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b, 'ko'));
}

function restoreGlobals(originals: {
  browser: unknown;
  chrome: unknown;
  document: unknown;
  localStorage: Storage | undefined;
  queryLocalFonts: unknown;
}): void {
  const g = globalThis as TestGlobals;
  if (originals.browser === undefined) {
    delete g.browser;
  } else {
    g.browser = originals.browser;
  }
  if (originals.chrome === undefined) {
    delete g.chrome;
  } else {
    g.chrome = originals.chrome;
  }
  if (originals.document === undefined) {
    delete g.document;
  } else {
    g.document = originals.document;
  }
  if (originals.localStorage === undefined) {
    delete g.localStorage;
  } else {
    g.localStorage = originals.localStorage;
  }
  if (originals.queryLocalFonts === undefined) {
    delete g.queryLocalFonts;
  } else {
    g.queryLocalFonts = originals.queryLocalFonts;
  }
}

function firstQuotedFontFamily(value: string): string | undefined {
  const start = value.indexOf('"');
  if (start < 0) return undefined;

  let result = '';
  for (let index = start + 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') return result;
    if (char === '\\' && index + 1 < value.length) {
      result += value[index + 1];
      index += 1;
      continue;
    }
    result += char;
  }
  return undefined;
}

function createProbeDocument(installedFamilies: readonly string[]): unknown {
  const installed = new Set(installedFamilies);
  const context = {
    font: '',
    measureText(text: string) {
      const fallback = this.font.split(',').pop()?.trim() ?? 'sans-serif';
      const target = firstQuotedFontFamily(this.font);
      const fallbackWidth = fallback.includes('monospace') ? 12 : fallback.includes('serif') ? 10 : 11;
      const width = target && installed.has(target) ? fallbackWidth + 3 : fallbackWidth;
      return { width: text.length * width };
    },
  };
  return {
    createElement(tagName: string) {
      if (tagName !== 'canvas') return {};
      return {
        getContext(contextId: string) {
          return contextId === '2d' ? context : null;
        },
      };
    },
  };
}

function utf16Be(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    bytes[index * 2] = codeUnit >> 8;
    bytes[index * 2 + 1] = codeUnit & 0xff;
  }
  return bytes;
}

function createSfntWithNameRecords(entries: ReadonlyArray<{
  nameId: number;
  value: string;
  platformId?: number;
  bytes?: Uint8Array;
}>): Uint8Array {
  const encoded = entries.map(entry => ({ ...entry, bytes: entry.bytes ?? utf16Be(entry.value) }));
  const nameTableOffset = 12 + 16;
  const stringsOffset = 6 + encoded.length * 12;
  const nameTableLength = stringsOffset + encoded.reduce((sum, entry) => sum + entry.bytes.length, 0);
  const bytes = new Uint8Array(nameTableOffset + nameTableLength);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, 0x00010000, false);
  view.setUint16(4, 1, false);
  bytes.set([0x6e, 0x61, 0x6d, 0x65], 12);
  view.setUint32(20, nameTableOffset, false);
  view.setUint32(24, nameTableLength, false);

  view.setUint16(nameTableOffset, 0, false);
  view.setUint16(nameTableOffset + 2, encoded.length, false);
  view.setUint16(nameTableOffset + 4, stringsOffset, false);
  let stringCursor = 0;
  encoded.forEach((entry, index) => {
    const recordOffset = nameTableOffset + 6 + index * 12;
    view.setUint16(recordOffset, entry.platformId ?? 3, false);
    view.setUint16(recordOffset + 2, 1, false);
    view.setUint16(recordOffset + 4, 0x0412, false);
    view.setUint16(recordOffset + 6, entry.nameId, false);
    view.setUint16(recordOffset + 8, entry.bytes.length, false);
    view.setUint16(recordOffset + 10, stringCursor, false);
    bytes.set(entry.bytes, nameTableOffset + stringsOffset + stringCursor);
    stringCursor += entry.bytes.length;
  });
  return bytes;
}

test('세션 글꼴 파일은 웹 대체 face보다 먼저 선택되고 CanvasKit에 원본 바이트를 제공한다', async () => {
  const g = globalThis as TestGlobals & { FontFace?: unknown };
  const originalDocument = g.document;
  const originalFontFace = g.FontFace;
  const originalStorage = g.localStorage;
  const added: Array<{ family: string; source: ArrayBuffer }> = [];
  const bytes = createSfntWithNameRecords([
    { nameId: 1, value: 'Malgun Gothic' },
    { nameId: 1, value: '맑은 고딕' },
    { nameId: 2, value: 'Regular' },
    { nameId: 4, value: 'Malgun Gothic Regular' },
    { nameId: 6, value: 'MalgunGothic-Regular' },
  ]);
  class TestFontFace {
    family: string;
    source: ArrayBuffer;
    constructor(family: string, source: ArrayBuffer) {
      this.family = family;
      this.source = source;
    }
    async load(): Promise<this> { return this; }
  }
  resetLocalFontsForTests();
  g.FontFace = TestFontFace;
  g.document = {
    fonts: {
      add(face: TestFontFace) { added.push(face); },
      delete() { return true; },
    },
  };
  const batangBeforeImport = fontFamilyChainForDisplay('바탕');
  assert.equal(prefersImportedHancomSubstitute('바탕'), false);
  const unrelatedBeforeImport = fontFamilyChainForDisplay('없는글꼴');
  try {
    // 가져오기 전에 만든 체인은 캐시되므로, 가져온 뒤 새 face 로 바뀌어야 한다.
    const chainBeforeImport = fontFamilyChainForDisplay('맑은 고딕');
    const file = new File([bytes], 'Malgun.ttf');
    const result = await importLocalFontFiles([file, new File([new Uint8Array([0])], 'unusable.ttf')]);
    const { imported } = result;
    assert.equal(imported.length, 1);
    assert.deepEqual(result.rejected, ['unusable.ttf']);
    assert.match(localFontImportMessage(result), /unusable\.ttf/);
    assert.equal(added.length, 1);
    assert.equal(added[0]?.family, imported[0]?.runtimeFamily);
    assert.equal(resolveLocalFont('맑은 고딕')?.postscriptName, 'MalgunGothic-Regular');
    const directBytes = getImportedLocalFontBytes('맑은 고딕');
    assert.deepEqual(new Uint8Array(directBytes!), bytes);
    assert.notEqual(firstQuotedFontFamily(chainBeforeImport), imported[0]?.runtimeFamily);
    assert.equal(firstQuotedFontFamily(fontFamilyChainForDisplay('맑은 고딕')), imported[0]?.runtimeFamily);
    const loaded = await loadLocalFontBytesFor(['맑은 고딕']);
    assert.deepEqual(new Uint8Array(loaded.get(localFontFaceKey(imported[0]!))!), bytes);
    assert.equal(getLocalFontState().stored, false);
    const nativeBatang = await importLocalFontFiles([new File([createSfntWithNameRecords([
      { nameId: 1, value: 'Haansoft Batang' }, { nameId: 1, value: '한컴바탕' },
      { nameId: 2, value: 'Regular' }, { nameId: 6, value: 'Haansoft-Batang' },
    ])], 'NativeBatang.ttf')]);
    const nativeBatangFamily = nativeBatang.imported[0]?.runtimeFamily;
    assert.ok(nativeBatangFamily);
    assert.notEqual(firstQuotedFontFamily(batangBeforeImport), nativeBatangFamily);
    for (const family of ['바탕', 'Batang', '바탕체', 'BatangChe', '궁서']) {
      assert.equal(firstQuotedFontFamily(fontFamilyChainForDisplay(family)), nativeBatangFamily);
      assert.equal(prefersImportedHancomSubstitute(family), true);
    }
    // 등록 bytes가 없어도 실제 로컬 감지 레코드의 원본 face가 우선이다.
    g.localStorage = createStorage({ [STORAGE_KEY]: JSON.stringify({
      version: 1, detectedAt: '2026-06-21T00:00:00.000Z',
      families: ['궁서'], source: 'local-font-access',
    }) });
    await loadStoredLocalFonts();
    assert.ok(resolveLocalFont('궁서'));
    assert.equal(prefersImportedHancomSubstitute('궁서'), false);
    assert.equal(firstQuotedFontFamily(fontFamilyChainForDisplay('궁서')), '궁서');
    await clearStoredLocalFonts();
    assert.equal(prefersImportedHancomSubstitute('궁서'), true);
    assert.equal(fontFamilyChainForDisplay('없는글꼴'), unrelatedBeforeImport);
    assert.equal(firstQuotedFontFamily(fontFamilyChainForDisplay('바탕', 0, 0, {
      confirmedLocalFonts: ['바탕'],
    })), '바탕');
    assert.equal(firstQuotedFontFamily(fontFamilyChainForDisplay('바탕', 0, 0, {
      includeUnconfirmedOriginal: true,
    })), '바탕');
    const requestedBatang = await importLocalFontFiles([new File([createSfntWithNameRecords([
      { nameId: 1, value: 'Batang' }, { nameId: 1, value: '바탕' },
      { nameId: 2, value: 'Regular' }, { nameId: 6, value: 'Batang-Regular' },
    ])], 'RequestedBatang.ttf')]);
    assert.equal(firstQuotedFontFamily(fontFamilyChainForDisplay('바탕')),
      requestedBatang.imported[0]?.runtimeFamily);
    assert.equal(prefersImportedHancomSubstitute('바탕'), false);
    const importedHcr = await importLocalFontFiles([new File([createSfntWithNameRecords([
      { nameId: 1, value: 'HCR Batang' }, { nameId: 1, value: '함초롬바탕' },
      { nameId: 2, value: 'Regular' }, { nameId: 6, value: 'HCRBatang-Regular' },
    ])], 'HCR.ttf')]);
    const hcrFamily = importedHcr.imported[0]?.runtimeFamily;
    assert.ok(hcrFamily);
    for (const family of ['HY신명조', '한양신명조']) {
      const chain = fontFamilyChainForDisplay(family);
      assert.ok(chain.indexOf(hcrFamily!) < chain.indexOf('serif'));
    }
    const requestedHy = await importLocalFontFiles([new File([createSfntWithNameRecords([
      { nameId: 1, value: 'HY신명조' }, { nameId: 2, value: 'Regular' },
      { nameId: 6, value: 'HYSMyeongjo-Regular' },
    ])], 'HY.ttf')]);
    assert.equal(firstQuotedFontFamily(fontFamilyChainForDisplay('HY신명조')),
      requestedHy.imported[0]?.runtimeFamily);

  } finally {
    resetLocalFontsForTests();
    g.document = originalDocument;
    g.FontFace = originalFontFace;
    g.localStorage = originalStorage;
  }
  assert.equal(fontFamilyChainForDisplay('바탕'), batangBeforeImport);
  assert.equal(fontFamilyChainForDisplay('없는글꼴'), unrelatedBeforeImport);
});

test('HFT outline-only imports count toward the session face limit', async () => {
  const g = globalThis as TestGlobals & { FontFace?: unknown };
  const originalDocument = g.document;
  const originalFontFace = g.FontFace;
  const bytes = new TextEncoder().encode('Han Unified Font File 1.0\x1a').buffer as ArrayBuffer;
  let registrations = 0;
  g.FontFace = class {};
  g.document = { fonts: { add() {}, delete() { return true; } } };
  resetLocalFontsForTests();
  takeHftOutlineChange();
  setHftWasmApi({
    register: () => { registrations += 1; return true; },
    glyphPath: () => '',
  });
  try {
    for (let index = 0; index < LOCAL_FONT_MAX_FACES_PER_DOCUMENT; index += 1) {
      const result = await registerLocalFontFace(bytes, { source: 'imported', fileName: `bank-${index}.hft` });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.reason, 'hft-outlines');
    }
    const overflow = await registerLocalFontFace(bytes, { source: 'imported', fileName: 'overflow.hft' });
    assert.equal(overflow.ok, false);
    if (!overflow.ok) assert.equal(overflow.reason, 'face-limit');
    assert.equal(registrations, LOCAL_FONT_MAX_FACES_PER_DOCUMENT);
  } finally {
    setHftWasmApi(null);
    takeHftOutlineChange();
    resetLocalFontsForTests();
    g.document = originalDocument;
    g.FontFace = originalFontFace;
  }
});

test('글꼴 파일 일부가 실패해도 정상 face와 굵기를 보존하고 실패한 파일명을 알린다', async () => {
  const g = globalThis as TestGlobals & { FontFace?: unknown };
  const originalDocument = g.document;
  const originalFontFace = g.FontFace;
  const added: Array<{ family: string; weight: string }> = [];
  let loadCount = 0;
  class TestFontFace {
    family: string;
    source: ArrayBuffer;
    descriptors: { weight: string };
    constructor(family: string, source: ArrayBuffer, descriptors: { weight: string }) {
      this.family = family;
      this.source = source;
      this.descriptors = descriptors;
    }
    async load(): Promise<this> {
      if (++loadCount === 3) throw new Error('invalid font outline');
      return this;
    }
  }
  const font = (style: string, postscriptName: string, fileName: string, fullName = `Malgun Gothic ${style}`) => new File([
    createSfntWithNameRecords([
      { nameId: 1, value: 'Malgun Gothic' },
      { nameId: 1, value: '맑은 고딕' },
      { nameId: 2, value: style },
      { nameId: 4, value: fullName },
      { nameId: 6, value: postscriptName },
    ]),
  ], fileName);
  resetLocalFontsForTests();
  g.FontFace = TestFontFace;
  g.document = {
    fonts: {
      add(face: TestFontFace) { added.push({ family: face.family, weight: face.descriptors.weight }); },
      delete() { return true; },
    },
  };
  try {
    const generationBefore = getImportedFontGeneration();
    const result = await importLocalFontFiles([
      font('Regular', 'Malgun-Regular', 'Regular.ttf'),
      font('Bold', 'Malgun-Bold', 'Bold.ttf'),
      font('Black', 'Malgun-Black', 'Broken.ttf'),
    ]);
    assert.equal(result.imported.length, 2);
    assert.deepEqual(result.rejected, ['Broken.ttf']);
    assert.match(localFontImportMessage(result), /Broken\.ttf/);
    assert.equal(added.length, 2);
    assert.equal(added[0]?.family, added[1]?.family);
    assert.deepEqual(added.map(face => face.weight), ['400', '700']);
    assert.equal(resolveLocalFont('Malgun Gothic')?.style, 'Regular');
    assert.equal(hasImportedLocalFontFace('Malgun Gothic'), true);
    assert.equal(getImportedFontGeneration(), generationBefore + 2);
    assert.notDeepEqual(
      new Uint8Array(getImportedLocalFontBytes('Malgun Gothic', false, false)!),
      new Uint8Array(getImportedLocalFontBytes('Malgun Gothic', true, false)!),
    );
    assert.deepEqual(
      new Uint8Array(getImportedLocalFontBytes('Malgun Gothic', true, false)!),
      new Uint8Array(await font('Bold', 'Malgun-Bold', 'Bold.ttf').arrayBuffer()),
    );
    assert.deepEqual(
      new Uint8Array(getImportedLocalFontBytes('맑은 고딕', true, false)!),
      new Uint8Array(await font('Bold', 'Malgun-Bold', 'Bold.ttf').arrayBuffer()),
    );
    assert.deepEqual(
      new Uint8Array(getImportedLocalFontBytes('Malgun-Regular', true, false)!),
      new Uint8Array(await font('Regular', 'Malgun-Regular', 'Regular.ttf').arrayBuffer()),
    );

    const replacement = font('Regular', 'Malgun-Regular', 'Regular-v2.ttf', 'Malgun Gothic Regular v2');
    const replaced = await importLocalFontFiles([replacement]);
    assert.equal(replaced.imported.length, 1);
    assert.equal(getImportedFontGeneration(), generationBefore + 3);
    assert.deepEqual(
      new Uint8Array(getImportedLocalFontBytes('Malgun Gothic', false, false)!),
      new Uint8Array(await replacement.arrayBuffer()),
    );
    assert.deepEqual(
      new Uint8Array(getImportedLocalFontBytes('Malgun Gothic', true, false)!),
      new Uint8Array(await font('Bold', 'Malgun-Bold', 'Bold.ttf').arrayBuffer()),
    );
  } finally {
    resetLocalFontsForTests();
    g.document = originalDocument;
    g.FontFace = originalFontFace;
  }
});

test('데스크톱 수식 서체는 동기 측정에 필요한 바이트만 보존하고 일반 서체는 사본을 버린다', async () => {
  const g = globalThis as TestGlobals & { FontFace?: unknown };
  const originalDocument = g.document;
  const originalFontFace = g.FontFace;
  resetLocalFontsForTests();
  g.FontFace = class { async load() { return this; } };
  g.document = { fonts: { add() {}, delete() { return true; } } };
  const fixture = readFileSync(new URL('../../tests/fixtures/fonts/RHWPShapingFixture.ttf', import.meta.url));
  const source = () => fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength);
  try {
    for (const family of ['HyhwpEQ', 'HCR Batang', 'Batang', 'Times New Roman', 'Noto Sans KR']) {
      const result = await registerLocalFontFace(source(), {
        source: 'desktop',
        fileName: `${family}.ttf`,
        names: { family, fullName: family, postscriptName: family.replaceAll(' ', ''), style: 'Regular', aliases: [family] },
      });
      assert.ok(result.ok);
      assert.equal(hasImportedLocalFontFace(family), true, 'loaded FontFace availability survives disposal of its JS byte copy');
      const retained = getImportedLocalFontBytes(family);
      if (family === 'Noto Sans KR') {
        assert.equal(retained, null);
      } else if (family === 'HyhwpEQ') {
        assert.deepEqual(new Uint8Array(retained!), new Uint8Array(fixture), 'PUA ink metrics read glyf from the full face');
      } else {
        assert.ok(retained!.byteLength < fixture.byteLength, 'literal faces keep only the tables the measurer reads');
        const fromCopy = createEquationLiteralFontResolver(resolveLocalFont, getImportedLocalFontBytes);
        const fromFile = createEquationLiteralFontResolver(resolveLocalFont, source);
        for (const text of ['A', 'ió', 'é', '가']) assert.deepEqual(fromCopy(text), fromFile(text), text);
        assert.ok(fromCopy('A'), 'covered literal resolves to the desktop face');
      }
    }
  } finally {
    resetLocalFontsForTests();
    g.document = originalDocument;
    g.FontFace = originalFontFace;
  }
});

test('저장된 localStorage snapshot 로드는 queryLocalFonts를 호출하지 않는다', async () => {
  const g = globalThis as TestGlobals;
  const originals = {
    browser: g.browser,
    chrome: g.chrome,
    document: g.document,
    localStorage: g.localStorage,
    queryLocalFonts: g.queryLocalFonts,
  };
  const snapshot: LocalFontSnapshot = {
    version: 1,
    detectedAt: '2026-06-21T00:00:00.000Z',
    families: ['로컬B', '함초롬바탕', '로컬A', '로컬A'],
    source: 'local-font-access',
  };
  let queryCount = 0;

  resetLocalFontsForTests();
  g.browser = undefined;
  g.chrome = undefined;
  g.localStorage = createStorage({ [STORAGE_KEY]: JSON.stringify(snapshot) });
  g.queryLocalFonts = async () => {
    queryCount++;
    return [];
  };

  try {
    const loaded = await loadStoredLocalFonts();
    assert.deepEqual(loaded?.families, sortedKo(['로컬A', '로컬B', '함초롬바탕']));
    assert.equal(queryCount, 0);
    assert.deepEqual(getLocalFonts(), sortedKo(['로컬A', '로컬B']));
    assert.deepEqual(getDetectedLocalFonts(), sortedKo(['로컬A', '로컬B', '함초롬바탕']));
    assert.deepEqual(getLocalFontState(), {
      supported: true,
      method: 'local-font-access',
      loaded: true,
      stored: true,
      source: 'local-font-access',
      complete: true,
      storage: 'local-storage',
      count: 3,
      checkedFamilies: sortedKo(['로컬A', '로컬B', '함초롬바탕']),
      detectedAt: '2026-06-21T00:00:00.000Z',
      lastError: null,
    });
  } finally {
    await clearStoredLocalFonts();
    resetLocalFontsForTests();
    restoreGlobals(originals);
  }
});

test('저장된 v2 snapshot의 반복 별칭 해석은 전체 face를 다시 정규화하지 않는다', async () => {
  const g = globalThis as TestGlobals;
  const originals = {
    browser: g.browser,
    chrome: g.chrome,
    document: g.document,
    localStorage: g.localStorage,
    queryLocalFonts: g.queryLocalFonts,
  };
  const records = Array.from({ length: 256 }, (_, index) => ({
    family: `Family ${index}`,
    fullName: `Family ${index} Regular`,
    postscriptName: `Family${index}-Regular`,
    style: 'Regular',
    displayName: `글꼴 ${index}`,
    aliases: [`Family ${index}`, `Family ${index} Regular`, `별칭 ${index}`],
  }));
  const snapshot: LocalFontSnapshot = {
    version: 2,
    detectedAt: '2026-07-12T00:00:00.000Z',
    families: records.map(record => record.family),
    fontRecords: records,
    source: 'local-font-access',
  };
  const originalNormalize = String.prototype.normalize;
  let normalizeCalls = 0;

  resetLocalFontsForTests();
  g.browser = undefined;
  g.chrome = undefined;
  g.localStorage = createStorage({ [STORAGE_KEY]: JSON.stringify(snapshot) });
  g.queryLocalFonts = undefined;

  try {
    await loadStoredLocalFonts();
    String.prototype.normalize = function(this: string, form?: string): string {
      normalizeCalls++;
      return originalNormalize.call(this, form);
    };

    for (let index = 0; index < 40; index++) {
      assert.equal(resolveLocalFont('별칭 255')?.postscriptName, 'Family255-Regular');
      assert.equal(resolveLocalFont('Family 128 Regular')?.family, 'Family 128');
    }
    assert.ok(normalizeCalls <= 80, `${normalizeCalls} normalize calls`);
  } finally {
    String.prototype.normalize = originalNormalize;
    await clearStoredLocalFonts();
    resetLocalFontsForTests();
    restoreGlobals(originals);
  }
});

test('Chrome 확장 컨텍스트에서는 chrome.storage.local snapshot을 우선 사용한다', async () => {
  const g = globalThis as TestGlobals;
  const originals = {
    browser: g.browser,
    chrome: g.chrome,
    document: g.document,
    localStorage: g.localStorage,
    queryLocalFonts: g.queryLocalFonts,
  };
  const snapshot: LocalFontSnapshot = {
    version: 1,
    detectedAt: '2026-06-21T01:00:00.000Z',
    families: ['확장로컬'],
    source: 'local-font-access',
  };
  let localStorageRead = 0;

  resetLocalFontsForTests();
  g.browser = undefined;
  g.chrome = {
    storage: {
      local: {
        get: (_key: string, callback: (items: Record<string, unknown>) => void) => {
          callback({ [STORAGE_KEY]: snapshot });
        },
        set: (_items: Record<string, unknown>, callback: () => void) => {
          callback();
        },
        remove: (_key: string, callback: () => void) => {
          callback();
        },
      },
    },
  };
  g.localStorage = {
    get length() {
      return 0;
    },
    clear() {},
    getItem() {
      localStorageRead++;
      throw new Error('localStorage should not be read');
    },
    key() {
      return null;
    },
    removeItem() {},
    setItem() {},
  } as Storage;
  g.queryLocalFonts = async () => {
    throw new Error('queryLocalFonts should not be called');
  };

  try {
    const loaded = await loadStoredLocalFonts();
    assert.deepEqual(loaded?.families, ['확장로컬']);
    assert.equal(localStorageRead, 0);
    assert.equal(getLocalFontState().storage, 'chrome-storage-local');
  } finally {
    await clearStoredLocalFonts();
    resetLocalFontsForTests();
    restoreGlobals(originals);
  }
});

test('Firefox 확장 컨텍스트에서는 browser.storage.local snapshot을 사용한다', async () => {
  const g = globalThis as TestGlobals;
  const originals = {
    browser: g.browser,
    chrome: g.chrome,
    document: g.document,
    localStorage: g.localStorage,
    queryLocalFonts: g.queryLocalFonts,
  };
  const snapshot: LocalFontSnapshot = {
    version: 1,
    detectedAt: '2026-06-21T01:30:00.000Z',
    families: ['파이어폭스로컬'],
    source: 'font-presence-probe',
    checkedFamilies: ['파이어폭스로컬', '없는글꼴'],
  };

  resetLocalFontsForTests();
  g.chrome = undefined;
  g.browser = {
    storage: {
      local: {
        get: async () => ({ [STORAGE_KEY]: snapshot }),
        set: async () => {},
        remove: async () => {},
      },
    },
  };
  g.localStorage = createStorage();
  g.queryLocalFonts = undefined;
  g.document = createProbeDocument([]);

  try {
    const loaded = await loadStoredLocalFonts();
    const state = getLocalFontState();
    assert.deepEqual(loaded?.families, ['파이어폭스로컬']);
    assert.deepEqual(loaded?.checkedFamilies, sortedKo(['파이어폭스로컬', '없는글꼴']));
    assert.equal(state.storage, 'browser-storage-local');
    assert.equal(state.source, 'font-presence-probe');
    assert.equal(state.complete, false);
  } finally {
    await clearStoredLocalFonts();
    resetLocalFontsForTests();
    restoreGlobals(originals);
  }
});

test('detectLocalFonts는 전체 snapshot을 저장하고 기본 반환은 웹 등록 글꼴을 제외한다', async () => {
  const g = globalThis as TestGlobals;
  const originals = {
    browser: g.browser,
    chrome: g.chrome,
    document: g.document,
    localStorage: g.localStorage,
    queryLocalFonts: g.queryLocalFonts,
  };
  let storedSnapshot: LocalFontSnapshot | null = null;
  let queryCount = 0;

  resetLocalFontsForTests();
  g.browser = undefined;
  g.localStorage = undefined;
  g.chrome = {
    storage: {
      local: {
        get: (_key: string, callback: (items: Record<string, unknown>) => void) => {
          callback({});
        },
        set: (items: Record<string, unknown>, callback: () => void) => {
          storedSnapshot = items[STORAGE_KEY] as LocalFontSnapshot;
          callback();
        },
        remove: (_key: string, callback: () => void) => {
          storedSnapshot = null;
          callback();
        },
      },
    },
  };
  g.queryLocalFonts = async () => {
    queryCount++;
    return [
      { family: '내 로컬', fullName: '내 로컬', postscriptName: 'LocalPS', style: 'Regular' },
      { family: '함초롬바탕', fullName: '함초롬바탕', postscriptName: 'HCRBatang', style: 'Regular' },
      { family: '내 로컬', fullName: '내 로컬', postscriptName: 'LocalPS', style: 'Regular' },
    ];
  };

  try {
    const filtered = await detectLocalFonts({ force: true });
    assert.equal(queryCount, 1);
    assert.deepEqual(filtered, ['내 로컬']);
    assert.deepEqual(getDetectedLocalFonts(), sortedKo(['내 로컬', '함초롬바탕']));
    assert.deepEqual(storedSnapshot?.families, sortedKo(['내 로컬', '함초롬바탕']));
    assert.equal(storedSnapshot?.source, 'local-font-access');
    assert.equal(storedSnapshot?.checkedFamilies, undefined);
  } finally {
    await clearStoredLocalFonts();
    resetLocalFontsForTests();
    restoreGlobals(originals);
  }
});

test('SFNT 지역화 이름을 보존해 HWP 한글 full name을 영문 family로 해석한다', async () => {
  const g = globalThis as TestGlobals;
  const originals = {
    browser: g.browser,
    chrome: g.chrome,
    document: g.document,
    localStorage: g.localStorage,
    queryLocalFonts: g.queryLocalFonts,
  };
  const storage = createStorage();

  resetLocalFontsForTests();
  g.browser = undefined;
  g.chrome = undefined;
  g.localStorage = storage;
  g.queryLocalFonts = async () => [{
    family: '08SeoulHangang',
    fullName: '08SeoulHangang M',
    postscriptName: 'SeoulHangangM',
    style: 'M',
    blob: async () => new Blob([createSfntWithNameRecords([
      { nameId: 1, value: '08서울한강체' },
      { nameId: 2, value: 'M' },
      { nameId: 4, value: '08서울한강체 M' },
      { nameId: 6, value: 'SeoulHangangM' },
    ])]),
  }];

  try {
    const fonts = await detectLocalFonts({ force: true, includeRegistered: true });
    const record = resolveLocalFont('08서울한강체 M');
    const englishRecord = resolveLocalFont('08SeoulHangang M');
    const report = analyzeDocumentFonts(['08서울한강체 M']);
    const cssChain = fontFamilyChainForDisplay('08서울한강체 M');
    const stored = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as LocalFontSnapshot;

    assert.deepEqual(fonts, ['08서울한강체 M']);
    assert.equal(record?.family, '08SeoulHangang');
    assert.equal(englishRecord?.postscriptName, 'SeoulHangangM');
    assert.equal(record?.postscriptName, 'SeoulHangangM');
    assert.ok(record?.aliases.includes('08서울한강체 M'));
    assert.deepEqual(getLocalFontRecords().map(item => item.displayName), ['08서울한강체 M']);
    assert.deepEqual(report.fonts.map(item => [item.fontName, item.status, item.source]), [
      ['08서울한강체 M', 'available', 'local'],
    ]);
    assert.match(cssChain, /^"08SeoulHangang"/);
    assert.equal(stored.version, 2);
    assert.equal('blob' in (stored.fontRecords?.[0] ?? {}), false);
  } finally {
    await clearStoredLocalFonts();
    resetLocalFontsForTests();
    restoreGlobals(originals);
  }
});

test('SFNT metadata discovery rejects an oversized font before reading any table bytes', async () => {
  const g = globalThis as TestGlobals;
  const originals = {
    browser: g.browser,
    chrome: g.chrome,
    document: g.document,
    localStorage: g.localStorage,
    queryLocalFonts: g.queryLocalFonts,
  };
  const storage = createStorage();
  let sliceReads = 0;

  resetLocalFontsForTests();
  g.browser = undefined;
  g.chrome = undefined;
  g.localStorage = storage;
  g.queryLocalFonts = async () => [{
    family: 'Oversized Font',
    fullName: 'Oversized Font Regular',
    postscriptName: 'OversizedFont-Regular',
    style: 'Regular',
    blob: async () => ({
      size: LOCAL_FONT_MAX_BYTES_PER_FACE + 1,
      slice: () => {
        sliceReads += 1;
        return new Blob();
      },
    }) as Blob,
  }];

  try {
    assert.deepEqual(
      await detectLocalFonts({ force: true, includeRegistered: true }),
      ['Oversized Font Regular'],
    );
    assert.equal(sliceReads, 0);
  } finally {
    await clearStoredLocalFonts();
    resetLocalFontsForTests();
    restoreGlobals(originals);
  }
});

test('legacy Macintosh name record는 표시 이름에 섞지 않는다', async () => {
  const g = globalThis as TestGlobals;
  const originals = {
    browser: g.browser,
    chrome: g.chrome,
    document: g.document,
    localStorage: g.localStorage,
    queryLocalFonts: g.queryLocalFonts,
  };
  const storage = createStorage();
  resetLocalFontsForTests();
  g.browser = undefined;
  g.chrome = undefined;
  g.localStorage = storage;
  g.queryLocalFonts = async () => [{
    family: 'Browser Font',
    fullName: 'Browser Font Regular',
    postscriptName: 'BrowserFont-Regular',
    style: 'Regular',
    blob: async () => new Blob([createSfntWithNameRecords([
      { nameId: 1, value: '!legacy', platformId: 1, bytes: new TextEncoder().encode('!legacy') },
      { nameId: 4, value: '!legacy display', platformId: 1, bytes: new TextEncoder().encode('!legacy display') },
    ])]),
  }];

  try {
    assert.deepEqual(await detectLocalFonts({ force: true }), ['Browser Font Regular']);
  } finally {
    await clearStoredLocalFonts();
    resetLocalFontsForTests();
    restoreGlobals(originals);
  }
});

test('저장된 깨진 표시 이름은 브라우저 family 이름으로 복구한다', async () => {
  const g = globalThis as TestGlobals;
  const originals = {
    browser: g.browser,
    chrome: g.chrome,
    document: g.document,
    localStorage: g.localStorage,
    queryLocalFonts: g.queryLocalFonts,
  };
  const snapshot: LocalFontSnapshot = {
    version: 2,
    detectedAt: '2026-07-12T00:00:00.000Z',
    families: ['Browser Font'],
    fontRecords: [{
      family: 'Browser Font',
      fullName: 'Browser Font Regular',
      postscriptName: 'BrowserFont-Regular',
      style: 'Regular',
      displayName: '»Ã깨진 이름',
      aliases: ['Browser Font', 'Browser Font Regular', '»Ã깨진 이름'],
    }],
    source: 'local-font-access',
  };
  const storage = createStorage({ [STORAGE_KEY]: JSON.stringify(snapshot) });
  resetLocalFontsForTests();
  g.browser = undefined;
  g.chrome = undefined;
  g.localStorage = storage;
  g.queryLocalFonts = undefined;

  try {
    await loadStoredLocalFonts();
    assert.deepEqual(getLocalFonts(), ['Browser Font Regular']);
  } finally {
    await clearStoredLocalFonts();
    resetLocalFontsForTests();
    restoreGlobals(originals);
  }
});

test('CanvasKit용 SFNT 바이트는 여러 PostScript face를 일괄 조회하고 동시 요청만 공유한다', async () => {
  const g = globalThis as TestGlobals;
  const originals = {
    browser: g.browser,
    chrome: g.chrome,
    document: g.document,
    localStorage: g.localStorage,
    queryLocalFonts: g.queryLocalFonts,
  };
  const storage = createStorage();
  const nameTableBytes = createSfntWithNameRecords([
    { nameId: 1, value: '08서울한강체' },
    { nameId: 2, value: 'M' },
    { nameId: 4, value: '08서울한강체 M' },
    { nameId: 6, value: 'SeoulHangangM' },
  ]);
  const secondNameTableBytes = createSfntWithNameRecords([
    { nameId: 1, value: '08서울한강체' },
    { nameId: 2, value: 'L' },
    { nameId: 4, value: '08서울한강체 L' },
    { nameId: 6, value: 'SeoulHangangL' },
  ]);
  const fontBytes = new Uint8Array(nameTableBytes.length + 4);
  fontBytes.set(nameTableBytes);
  fontBytes.set([0xde, 0xad, 0xbe, 0xef], nameTableBytes.length);
  const secondFontBytes = new Uint8Array(secondNameTableBytes.length + 4);
  secondFontBytes.set(secondNameTableBytes);
  secondFontBytes.set([0xca, 0xfe, 0xba, 0xbe], secondNameTableBytes.length);
  const queryCalls: Array<string[] | undefined> = [];

  resetLocalFontsForTests();
  g.browser = undefined;
  g.chrome = undefined;
  g.localStorage = storage;
  g.queryLocalFonts = async (options?: { postscriptNames?: string[] }) => {
    queryCalls.push(options?.postscriptNames);
    return [
      {
        family: '08SeoulHangang',
        fullName: '08SeoulHangang M',
        postscriptName: 'SeoulHangangM',
        style: 'M',
        blob: async () => new Blob([options ? fontBytes : nameTableBytes]),
      },
      {
        family: '08SeoulHangang',
        fullName: '08SeoulHangang L',
        postscriptName: 'SeoulHangangL',
        style: 'L',
        blob: async () => new Blob([options ? secondFontBytes : secondNameTableBytes]),
      },
    ];
  };

  try {
    await detectLocalFonts({ force: true, includeRegistered: true });
    const [all, first] = await Promise.all([
      loadLocalFontBytesFor(['08서울한강체 M', '08서울한강체 L']),
      loadLocalFontBytes('08서울한강체 M'),
    ]);
    const hangangRecord = resolveLocalFont('08서울한강체 M');
    const hangangLightRecord = resolveLocalFont('08서울한강체 L');

    assert.deepEqual(new Uint8Array(all.get(localFontFaceKey(hangangRecord!)) ?? new ArrayBuffer(0)), fontBytes);
    assert.deepEqual(new Uint8Array(all.get(localFontFaceKey(hangangLightRecord!)) ?? new ArrayBuffer(0)), secondFontBytes);
    assert.deepEqual(new Uint8Array(first ?? new ArrayBuffer(0)), fontBytes);
    assert.equal(resolveLocalFont('08SeoulHangang'), null);
    assert.equal(queryCalls.length, 2);
    assert.equal(queryCalls[0], undefined);
    assert.deepEqual(new Set(queryCalls[1]), new Set(['SeoulHangangM', 'SeoulHangangL']));
  } finally {
    await clearStoredLocalFonts();
    resetLocalFontsForTests();
    restoreGlobals(originals);
  }
});

test('CanvasKit local font byte reads use bounded worker concurrency', async () => {
  const g = globalThis as TestGlobals;
  const originals = {
    browser: g.browser,
    chrome: g.chrome,
    document: g.document,
    localStorage: g.localStorage,
    queryLocalFonts: g.queryLocalFonts,
  };
  const records = Array.from({ length: LOCAL_FONT_BYTE_READ_CONCURRENCY + 3 }, (_, index) => ({
    family: `Bounded Font ${index}`,
    fullName: `Bounded Font ${index} Regular`,
    postscriptName: `BoundedFont${index}-Regular`,
    style: 'Regular',
    displayName: `Bounded Font ${index}`,
    aliases: [`Bounded Font ${index}`, `Bounded Font ${index} Regular`],
  }));
  const snapshot: LocalFontSnapshot = {
    version: 2,
    detectedAt: new Date(0).toISOString(),
    families: records.map(record => record.family),
    fontRecords: records,
    source: 'local-font-access',
  };
  const storage = createStorage({ [STORAGE_KEY]: JSON.stringify(snapshot) });
  let activeReads = 0;
  let maximumActiveReads = 0;
  let completedReads = 0;

  resetLocalFontsForTests();
  g.browser = undefined;
  g.chrome = undefined;
  g.localStorage = storage;
  g.queryLocalFonts = async () => records.map((record, index) => ({
    ...record,
    blob: async () => ({
      size: 4,
      arrayBuffer: async () => {
        activeReads += 1;
        maximumActiveReads = Math.max(maximumActiveReads, activeReads);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        activeReads -= 1;
        completedReads += 1;
        return new Uint8Array([0, 1, 2, index]).buffer;
      },
    }) as Blob,
  }));

  try {
    await loadStoredLocalFonts();
    const loaded = await loadLocalFontBytesFor(records.map(record => record.fullName));
    assert.equal(loaded.size, records.length);
    assert.equal(completedReads, records.length);
    assert.ok(maximumActiveReads > 1);
    assert.ok(maximumActiveReads <= LOCAL_FONT_BYTE_READ_CONCURRENCY);
  } finally {
    await clearStoredLocalFonts();
    resetLocalFontsForTests();
    restoreGlobals(originals);
  }
});

test('CanvasKit local font byte reads cap face count and reject oversized blobs before allocation', async () => {
  const g = globalThis as TestGlobals;
  const originals = {
    browser: g.browser,
    chrome: g.chrome,
    document: g.document,
    localStorage: g.localStorage,
    queryLocalFonts: g.queryLocalFonts,
  };
  const records = Array.from({ length: LOCAL_FONT_MAX_FACES_PER_DOCUMENT + 1 }, (_, index) => ({
    family: `Large Font ${index}`,
    fullName: `Large Font ${index} Regular`,
    postscriptName: `LargeFont${index}-Regular`,
    style: 'Regular',
    displayName: `Large Font ${index}`,
    aliases: [`Large Font ${index}`, `Large Font ${index} Regular`],
  }));
  const snapshot: LocalFontSnapshot = {
    version: 2,
    detectedAt: new Date(0).toISOString(),
    families: records.map(record => record.family),
    fontRecords: records,
    source: 'local-font-access',
  };
  const storage = createStorage({ [STORAGE_KEY]: JSON.stringify(snapshot) });
  let requestedPostscriptNames: string[] = [];
  let arrayBufferReads = 0;

  resetLocalFontsForTests();
  g.browser = undefined;
  g.chrome = undefined;
  g.localStorage = storage;
  g.queryLocalFonts = async (options?: { postscriptNames?: string[] }) => {
    requestedPostscriptNames = options?.postscriptNames ?? [];
    return records.map(record => ({
      ...record,
      blob: async () => ({
        size: LOCAL_FONT_MAX_BYTES_PER_FACE + 1,
        arrayBuffer: async () => {
          arrayBufferReads += 1;
          return new ArrayBuffer(0);
        },
      }) as Blob,
    }));
  };

  try {
    await loadStoredLocalFonts();
    const loaded = await loadLocalFontBytesFor(records.map(record => record.fullName));
    assert.equal(loaded.size, 0);
    assert.equal(requestedPostscriptNames.length, LOCAL_FONT_MAX_FACES_PER_DOCUMENT);
    assert.equal(arrayBufferReads, 0);
  } finally {
    await clearStoredLocalFonts();
    resetLocalFontsForTests();
    restoreGlobals(originals);
  }
});

test('저장소 읽기 실패는 빈 상태로 처리하고 오류 상태만 기록한다', async () => {
  const g = globalThis as TestGlobals;
  const originals = {
    browser: g.browser,
    chrome: g.chrome,
    document: g.document,
    localStorage: g.localStorage,
    queryLocalFonts: g.queryLocalFonts,
  };

  resetLocalFontsForTests();
  g.browser = undefined;
  g.chrome = undefined;
  g.localStorage = {
    get length() {
      return 0;
    },
    clear() {},
    getItem() {
      throw new Error('storage blocked');
    },
    key() {
      return null;
    },
    removeItem() {},
    setItem() {},
  } as Storage;
  g.queryLocalFonts = undefined;

  try {
    const loaded = await loadStoredLocalFonts();
    const state = getLocalFontState();
    assert.equal(loaded, null);
    assert.equal(state.loaded, true);
    assert.equal(state.stored, false);
    assert.equal(state.storage, 'local-storage');
    assert.equal(state.method, null);
    assert.equal(state.source, null);
    assert.equal(state.complete, false);
    assert.deepEqual(state.checkedFamilies, []);
    assert.equal(state.lastError, 'storage blocked');
    assert.deepEqual(getLocalFonts(), []);
  } finally {
    await clearStoredLocalFonts();
    resetLocalFontsForTests();
    restoreGlobals(originals);
  }
});

test('clearStoredLocalFonts는 저장된 snapshot과 런타임 상태를 초기화한다', async () => {
  const g = globalThis as TestGlobals;
  const originals = {
    browser: g.browser,
    chrome: g.chrome,
    document: g.document,
    localStorage: g.localStorage,
    queryLocalFonts: g.queryLocalFonts,
  };
  const snapshot: LocalFontSnapshot = {
    version: 1,
    detectedAt: '2026-06-21T02:00:00.000Z',
    families: ['초기화대상'],
    source: 'local-font-access',
  };
  const storage = createStorage({ [STORAGE_KEY]: JSON.stringify(snapshot) });

  resetLocalFontsForTests();
  g.browser = undefined;
  g.chrome = undefined;
  g.localStorage = storage;
  g.queryLocalFonts = async () => {
    throw new Error('queryLocalFonts should not be called');
  };

  try {
    await loadStoredLocalFonts();
    assert.equal(getLocalFontState().stored, true);
    assert.deepEqual(getDetectedLocalFonts(), ['초기화대상']);

    await clearStoredLocalFonts();
    const state = getLocalFontState();
    assert.equal(storage.getItem(STORAGE_KEY), null);
    assert.equal(state.loaded, true);
    assert.equal(state.stored, false);
    assert.equal(state.count, 0);
    assert.equal(state.detectedAt, null);
    assert.deepEqual(state.checkedFamilies, []);
    assert.deepEqual(getDetectedLocalFonts(), []);
  } finally {
    await clearStoredLocalFonts();
    resetLocalFontsForTests();
    restoreGlobals(originals);
  }
});

test('Local Font Access API가 없으면 문서 후보 글꼴만 probe snapshot으로 저장한다', async () => {
  const g = globalThis as TestGlobals;
  const originals = {
    browser: g.browser,
    chrome: g.chrome,
    document: g.document,
    localStorage: g.localStorage,
    queryLocalFonts: g.queryLocalFonts,
  };
  let storedSnapshot: LocalFontSnapshot | null = null;

  resetLocalFontsForTests();
  g.browser = undefined;
  g.chrome = undefined;
  g.localStorage = {
    get length() {
      return storedSnapshot ? 1 : 0;
    },
    clear() {
      storedSnapshot = null;
    },
    getItem() {
      return null;
    },
    key() {
      return storedSnapshot ? STORAGE_KEY : null;
    },
    removeItem() {
      storedSnapshot = null;
    },
    setItem(_key: string, value: string) {
      storedSnapshot = JSON.parse(value) as LocalFontSnapshot;
    },
  } as Storage;
  g.queryLocalFonts = undefined;
  g.document = createProbeDocument(['문서로컬']);

  try {
    const fonts = await detectLocalFonts({
      force: true,
      includeRegistered: true,
      candidateFamilies: ['문서로컬', '없는글꼴', '함초롬바탕'],
    });
    const state = getLocalFontState();
    assert.deepEqual(fonts, ['문서로컬']);
    assert.equal(storedSnapshot?.source, 'font-presence-probe');
    assert.deepEqual(storedSnapshot?.families, ['문서로컬']);
    assert.deepEqual(storedSnapshot?.checkedFamilies, sortedKo(['문서로컬', '없는글꼴', '함초롬바탕']));
    assert.equal(state.method, 'font-presence-probe');
    assert.equal(state.source, 'font-presence-probe');
    assert.equal(state.complete, false);
    assert.deepEqual(state.checkedFamilies, sortedKo(['문서로컬', '없는글꼴', '함초롬바탕']));
  } finally {
    await clearStoredLocalFonts();
    resetLocalFontsForTests();
    restoreGlobals(originals);
  }
});

function localizedStyleFont(style: string, weight: number, selection: number): ArrayBuffer {
  const original = createSfntWithNameRecords([
    { nameId: 1, value: 'Locale Family' }, { nameId: 2, value: style },
    { nameId: 4, value: `Locale Family ${style}` }, { nameId: 6, value: `Locale-${weight}-${selection}` },
  ]);
  const old = new DataView(original.buffer, original.byteOffset, original.byteLength);
  const nameOffset = old.getUint32(20); const nameLength = old.getUint32(24);
  const bytes = new ArrayBuffer(60 + nameLength + 64 + 46);
  const v = new DataView(bytes); v.setUint32(0, 0x00010000); v.setUint16(4, 3);
  for (const [index, tag, offset, length] of [[0, 0x6e616d65, 60, nameLength], [1, 0x4f532f32, 60 + nameLength, 64], [2, 0x68656164, 124 + nameLength, 46]]) {
    v.setUint32(12 + index * 16, tag); v.setUint32(20 + index * 16, offset); v.setUint32(24 + index * 16, length);
  }
  new Uint8Array(bytes, 60, nameLength).set(original.subarray(nameOffset, nameOffset + nameLength));
  v.setUint16(60 + nameLength, 4); v.setUint16(64 + nameLength, weight); v.setUint16(122 + nameLength, selection);
  return bytes;
}

test('SFNT localized style metadata drives browser descriptors and variant bytes', async () => {
  const g = globalThis as TestGlobals & { FontFace?: unknown };
  const originalDocument = g.document; const originalFace = g.FontFace;
  const descriptors: Array<{style: string; weight: string}> = [];
  g.FontFace = class { constructor(_family: string, _bytes: ArrayBuffer, value: {style: string; weight: string}) { descriptors.push(value); } async load() { return this; } };
  g.document = { fonts: { add() {}, delete() { return true; } } };
  resetLocalFontsForTests();
  try {
    const italic = localizedStyleFont('Corsivo', 400, 1);
    const boldItalic = localizedStyleFont('Grassetto Corsivo', 700, 1);
    await registerLocalFontFace(localizedStyleFont('Regular', 400, 0), {source: 'imported', fileName: 'regular.ttf'});
    const a = await registerLocalFontFace(italic, {source: 'imported', fileName: 'italic.ttf'}); const b = await registerLocalFontFace(boldItalic, {source: 'imported', fileName: 'bolditalic.ttf'});
    assert.equal(a.ok, true); assert.equal(b.ok, true);
    assert.deepEqual(descriptors, [{style: 'normal', weight: '400'}, {style: 'italic', weight: '400'}, {style: 'italic', weight: '700'}]);
    if (!a.ok || !b.ok) return;
    assert.equal(a.record.style, 'Corsivo'); assert.ok(a.record.aliases.includes('Locale Family Corsivo'));
    assert.deepEqual(getImportedLocalFontBytes('Locale Family', false, true), italic);
    assert.deepEqual(getImportedLocalFontBytes('Locale Family', true, true), boldItalic);
  } finally { resetLocalFontsForTests(); g.document = originalDocument; g.FontFace = originalFace; }
});


test('가변 인스턴스 굵기는 기본 SFNT 굵기보다 우선하고 바이트 선택에도 반영된다', async () => {
  const g = globalThis as TestGlobals & { FontFace?: unknown };
  const originalDocument = g.document; const originalFace = g.FontFace;
  const descriptors: Array<{ style: string; weight: string }> = [];
  g.FontFace = class {
    constructor(_family: string, _bytes: ArrayBuffer, value: { style: string; weight: string }) { descriptors.push(value); }
    async load() { return this; }
  };
  g.document = { fonts: { add() {}, delete() { return true; } } };
  try {
    for (const source of ['imported', 'desktop'] as const) {
      resetLocalFontsForTests();
      descriptors.length = 0;
      const regular = localizedStyleFont('Regular', 400, 0);
      const semibold = localizedStyleFont('Semibold', 600, 0);
      const sfnt = new DataView(semibold);
      sfnt.setUint16(sfnt.getUint32(36) + 4, 400); // 이름은 인스턴스, OS/2는 기본 face.
      const a = await registerLocalFontFace(regular, {
        source, fileName: 'variable.ttf', desktopFaceId: 'variable-regular',
      });
      const b = await registerLocalFontFace(semibold, {
        source, fileName: 'variable.ttf', desktopFaceId: 'variable-semibold', descriptors: { weight: '600' },
      });
      assert.equal(a.ok, true); assert.equal(b.ok, true);
      if (!a.ok || !b.ok) throw new Error('fixture registration failed');
      assert.deepEqual(importedFontPhysicalStyle(a.record), { weight: 400, bold: false, italic: false });
      assert.deepEqual(importedFontPhysicalStyle(b.record), { weight: 600, bold: true, italic: false });
      assert.deepEqual(descriptors, [{ style: 'normal', weight: '400' }, { style: 'normal', weight: '600' }]);
      if (source === 'imported') {
        assert.deepEqual(getImportedLocalFontBytes('Locale Family', false, false), regular);
        assert.deepEqual(getImportedLocalFontBytes('Locale Family', true, false), semibold);
      } else {
        // 데스크톱 face는 사본을 보관하지 않고 등록한 인스턴스 id로 다시 읽는다.
        assert.equal(getSessionLocalFontFace(localFontFaceKey(a.record))?.bytes, null);
        assert.equal(getSessionLocalFontFace(localFontFaceKey(b.record))?.bytes, null);
        assert.equal(getImportedLocalFontBytes('Locale Family', false, false), null);
        assert.equal(getImportedLocalFontBytes('Locale Family', true, false), null);
        const reads: string[] = [];
        setDesktopFontByteReader(async id => {
          reads.push(id);
          assert.ok(id === 'variable-regular' || id === 'variable-semibold');
          return id === 'variable-regular' ? regular : semibold;
        });
        const bytes = await loadLocalFontBytesFor(['Locale Family', b.record.postscriptName]);
        assert.deepEqual(bytes.get(localFontFaceKey(a.record)), regular);
        assert.deepEqual(bytes.get(localFontFaceKey(b.record)), semibold);
        assert.deepEqual(reads.sort(), ['variable-regular', 'variable-semibold']);
      }
    }
  } finally { resetLocalFontsForTests(); g.document = originalDocument; g.FontFace = originalFace; }
});

test('SFNT metadata bounds, versioned oblique and collection offsets preserve fallback', async () => {
  const g = globalThis as TestGlobals & { FontFace?: unknown };
  const doc = g.document; const fontFace = g.FontFace;
  g.FontFace = class { async load() { return this; } };
  g.document = {fonts: {add() {}, delete() {return true;}}};
  const register = async (bytes: ArrayBuffer) => {
    resetLocalFontsForTests();
    const result = await registerLocalFontFace(bytes, {source: 'imported', fileName: 'face.ttf', names: {family: 'Fixture', fullName: 'Fixture', postscriptName: 'Fixture', style: 'Italic', aliases: []}});
    assert.equal(result.ok, true); if (!result.ok) throw new Error('fixture registration failed');
    return result.record.sfntStyle;
  };
  try {
    const modern = localizedStyleFont('Corsivo', 550, 0x200);
    assert.deepEqual(await register(modern), {weight: 550, italic: true});
    const old = modern.slice(0); const oldView = new DataView(old); const os2 = oldView.getUint32(36);
    oldView.setUint16(os2, 3);
    assert.deepEqual(await register(old), {weight: 550, italic: false}, 'oblique bit is not defined before OS/2 v4');
    const invalidWeight = modern.slice(0); const iv = new DataView(invalidWeight);
    iv.setUint16(os2 + 4, 1001); iv.setUint16(iv.getUint32(52) + 44, 1);
    assert.deepEqual(await register(invalidWeight), {weight: 700, italic: true});
    const short = modern.slice(0); const sv = new DataView(short);
    sv.setUint32(40, 4); sv.setUint32(56, 44);
    assert.equal(await register(short), undefined, 'truncated tables use existing style-name fallback');
    const collection = new ArrayBuffer(modern.byteLength + 16); const cv = new DataView(collection);
    cv.setUint32(0, 0x74746366); cv.setUint32(4, 0x00010000); cv.setUint32(8, 1); cv.setUint32(12, 16);
    new Uint8Array(collection, 16).set(new Uint8Array(modern));
    for (let i = 0; i < 3; i++) cv.setUint32(16 + 20 + i * 16, cv.getUint32(16 + 20 + i * 16) + 16);
    assert.deepEqual(await register(collection), {weight: 550, italic: true});
    cv.setUint32(12, collection.byteLength);
    assert.equal(await register(collection), undefined, 'out-of-range TTC face does not invent metadata');
  } finally {resetLocalFontsForTests(); g.document = doc; g.FontFace = fontFace;}
});


test('SFNT detection reads bounded metadata slices without whole font allocation', async () => {
  const g = globalThis as TestGlobals;
  const originals = {browser: g.browser, chrome: g.chrome, document: g.document, localStorage: g.localStorage, queryLocalFonts: g.queryLocalFonts};
  const metadata = localizedStyleFont('Corsivo', 400, 1);
  const blob = new Blob([metadata, new Uint8Array(1024 * 1024)]);
  const slices: Array<[number, number]> = [];
  const bounded = {size: blob.size, arrayBuffer: async () => {throw new Error('whole font read forbidden');}, slice(start: number, end: number) {slices.push([start, end]); return blob.slice(start, end);}};
  resetLocalFontsForTests(); g.localStorage = createStorage();
  g.queryLocalFonts = async () => [{family: 'Locale Family', fullName: 'Locale Family Corsivo', postscriptName: 'Locale-I', style: 'Corsivo', blob: async () => bounded}];
  try {
    await detectLocalFonts({force: true});
    const record = getLocalFontRecords().find(face => face.family === 'Locale Family');
    assert.deepEqual(record?.sfntStyle, {weight: 400, italic: true});
    assert.ok(slices.length > 0);
    assert.ok(slices.reduce((sum, [start, end]) => sum + end - start, 0) < 1024, 'glyph data is never read for metadata');
  } finally {resetLocalFontsForTests(); restoreGlobals(originals);}
});

test('SFNT explicit names preserve supplied alias and display topology', async () => {
  const g = globalThis as TestGlobals & {FontFace?: unknown}; const doc = g.document; const ff = g.FontFace;
  g.FontFace = class {async load() {return this;}}; g.document = {fonts: {add() {}, delete() {return true;}}};
  const names = {family: 'Explicit', fullName: 'Explicit Cursive', postscriptName: 'Explicit-I', style: 'Cursive', displayName: '표시', aliases: ['Explicit Alias']};
  resetLocalFontsForTests();
  try {
    const plain = await registerLocalFontFace(new Uint8Array([1, 2, 3]).buffer, {source: 'desktop', fileName: 'plain.ttf', names});
    resetLocalFontsForTests();
    const metadata = await registerLocalFontFace(localizedStyleFont('Corsivo', 400, 1), {source: 'desktop', fileName: 'metadata.ttf', names});
    assert.equal(plain.ok, true); assert.equal(metadata.ok, true); if (!plain.ok || !metadata.ok) return;
    assert.deepEqual(metadata.record.aliases, plain.record.aliases);
    assert.equal(metadata.record.displayName, plain.record.displayName); assert.equal(metadata.record.style, plain.record.style);
    assert.deepEqual(metadata.record.sfntStyle, {weight: 400, italic: true});
  } finally {resetLocalFontsForTests(); g.document = doc; g.FontFace = ff;}
});

test('SFNT regular family lookup selects unique nearest 400 and preserves ties', async () => {
  const g = globalThis as TestGlobals & {FontFace?: unknown}; const doc = g.document; const ff = g.FontFace;
  g.FontFace = class {async load() {return this;}}; g.document = {fonts: {add() {}, delete() {return true;}}};
  resetLocalFontsForTests();
  try {
    const regular = await registerLocalFontFace(localizedStyleFont('Regular', 400, 0), {source: 'imported', fileName: 'regular.ttf'});
    await registerLocalFontFace(localizedStyleFont('Light', 300, 0), {source: 'imported', fileName: 'light.ttf'});
    assert.equal(regular.ok, true); if (!regular.ok) return;
    assert.equal(resolveLocalFont('Locale Family')?.postscriptName, regular.record.postscriptName);
    resetLocalFontsForTests();
    await registerLocalFontFace(localizedStyleFont('Light', 300, 0), {source: 'imported', fileName: 'light.ttf'});
    await registerLocalFontFace(localizedStyleFont('Medium', 500, 0), {source: 'imported', fileName: 'medium.ttf'});
    assert.equal(resolveLocalFont('Locale Family'), null, 'equal physical distance remains ambiguous');
  } finally {resetLocalFontsForTests(); g.document = doc; g.FontFace = ff;}
});
