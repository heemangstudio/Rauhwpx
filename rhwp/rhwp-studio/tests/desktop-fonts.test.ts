import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDesktopFontLookup,
  configureDesktopFonts,
  createCombinedFontHost,
  isDesktopFontMatch,
  isDesktopFontsSupported,
  matchDesktopFont,
  prepareDesktopFontsForDocument,
  resetDesktopFontsForTests,
  type DesktopFontMatch,
  type SystemFontFace,
  type SystemFontIndex,
} from '../src/core/desktop-fonts.ts';
import {
  DESKTOP_FONT_MAX_AGGREGATE_BYTES,
  LOCAL_FONT_MAX_AGGREGATE_BYTES,
  LOCAL_FONT_MAX_BYTES_PER_FACE,
  getImportedFontGeneration,
  getImportedLocalFontBytes,
  getSessionLocalFontFace,
  hasImportedLocalFontFace,
  loadLocalFontBytesFor,
  localFontFaceKey,
  registerLocalFontFace,
  resetLocalFontsForTests,
  resolveLocalFont,
} from '../src/core/local-fonts.ts';
import { analyzeDocumentFonts } from '../src/core/document-font-status.ts';

function face(id: string, overrides: Partial<SystemFontFace>): SystemFontFace {
  return {
    id,
    path: `/fonts/${id}.ttf`,
    faceIndex: 0,
    format: 'ttf',
    source: 'system',
    size: 1000,
    families: [],
    fullNames: [],
    postscriptNames: [],
    styles: ['Regular'],
    typographicFamilies: [],
    typographicStyles: [],
    koreanNames: [],
    weight: 400,
    italic: false,
    bold: false,
    hangul: true,
    latin: true,
    ...overrides,
  };
}

function makeIndex(faces: SystemFontFace[], hancomFaceMap: SystemFontIndex['hancomFaceMap'] = []): SystemFontIndex {
  return {
    version: 1,
    platform: 'darwin',
    scannedAt: '2026-09-27T00:00:00.000Z',
    durationMs: 12,
    fromCache: false,
    roots: [{ path: '/fonts', kind: 'system', exists: true, fileCount: faces.length }],
    faces,
    hancomFaceMap,
    errors: [],
  };
}

const malgun = face('malgun', {
  families: ['Malgun Gothic', '맑은 고딕'],
  fullNames: ['Malgun Gothic'],
  postscriptNames: ['MalgunGothicRegular'],
  koreanNames: ['맑은 고딕'],
});
const malgunBold = face('malgun-bold', {
  families: ['Malgun Gothic', '맑은 고딕'],
  fullNames: ['Malgun Gothic Bold'],
  postscriptNames: ['MalgunGothicBold'],
  styles: ['Bold'],
  koreanNames: ['맑은 고딕'],
  weight: 700,
  bold: true,
});
const malgunSemilight = face('malgun-semilight', {
  families: ['Malgun Gothic Semilight'],
  fullNames: ['Malgun Gothic Semilight'],
  postscriptNames: ['MalgunGothic-Semilight'],
  typographicFamilies: ['Malgun Gothic'],
  weight: 350,
});
const haansoftBatang = face('hbatang', {
  families: ['Haansoft Batang'],
  fullNames: ['Haansoft Batang'],
  postscriptNames: ['HaansoftBatang'],
  source: 'hancom',
});
const batangChe = face('batangche', {
  families: ['BatangChe'],
  fullNames: ['BatangChe'],
  postscriptNames: ['BatangChe'],
});
const hyExtra = face('hygothic-extra', {
  families: ['HYGothic-Extra'],
  fullNames: ['HYGothic-Extra'],
  postscriptNames: ['HYGothic-Extra'],
  weight: 700,
  bold: true,
});

function match(name: string, index: SystemFontIndex): DesktopFontMatch {
  const result = matchDesktopFont(name, buildDesktopFontLookup(index));
  assert.ok(isDesktopFontMatch(result), `${name} should match`);
  return result;
}

test('데스크톱 글꼴 매칭은 한글 이름·한컴 목록·정규화·별칭 순서를 지키고 다른 family로 넘어가지 않는다', () => {
  const index = makeIndex(
    [malgun, malgunBold, malgunSemilight, haansoftBatang, batangChe, hyExtra],
    [{ name: '한컴바탕', file: 'HBATANG.TTF', script: 'hangul', faceId: 'hbatang' }],
  );

  const korean = match('맑은 고딕', index);
  assert.equal(korean.matchedBy, 'family');
  assert.equal(korean.single, false);
  assert.deepEqual(korean.slots.map(slot => [slot.slot, slot.face.id]), [['regular', 'malgun'], ['bold', 'malgun-bold']]);

  // 한컴 목록은 같은 글꼴의 별칭표보다 먼저 쓰인다.
  const hancom = match('한컴바탕', index);
  assert.equal(hancom.matchedBy, 'hancom-map');
  assert.equal(hancom.anchor.id, 'hbatang');

  const normalized = match('malgun-gothic', index);
  assert.equal(normalized.matchedBy, 'normalized');
  assert.equal(normalized.anchor.id, 'malgun');
  assert.equal(match('Malgun Gothic Regular', index).matchedBy, 'normalized');

  const alias = match('HY견고딕', index);
  assert.equal(alias.matchedBy, 'alias');
  // 굵게 플래그만 있는 단독 face는 본문 글자용 regular로 등록한다.
  assert.deepEqual(alias.slots.map(slot => [slot.slot, slot.face.id]), [['regular', 'hygothic-extra']]);

  // 이름으로 지목된 굵은 face는 family 그룹과 분리된 단일 face다.
  const boldByName = match('Malgun Gothic Bold', index);
  assert.equal(boldByName.matchedBy, 'full-name');
  assert.equal(boldByName.single, true);
  assert.deepEqual(boldByName.slots.map(slot => [slot.slot, slot.face.id]), [['regular', 'malgun-bold']]);

  // 굵기 이름(Semilight)은 별도 family라 regular 그룹에 섞이지 않는다.
  const semilight = match('Malgun Gothic Semilight', index);
  assert.deepEqual(semilight.slots.map(slot => slot.face.id), ['malgun-semilight']);

  const lookup = buildDesktopFontLookup(index);
  for (const name of ['바탕', 'Batang', '맑은 고딕체', 'Malgun', 'Malgun Gothic Light']) {
    assert.equal(isDesktopFontMatch(matchDesktopFont(name, lookup)), false, `${name} must not fuzzy-match`);
  }
});

test('같은 이름이 여러 곳에 있으면 한컴 번들 사본과 그 출처의 스타일을 고른다', () => {
  const systemRegular = face('sys-hcr', { families: ['HCR Batang'], koreanNames: ['함초롬바탕'], postscriptNames: ['HCRBatang'] });
  const systemBold = face('sys-hcr-bold', {
    families: ['HCR Batang'], koreanNames: ['함초롬바탕'], postscriptNames: ['HCRBatang-Bold'], weight: 700, bold: true,
  });
  const hancomRegular = face('hc-hcr', {
    families: ['HCR Batang'], koreanNames: ['함초롬바탕'], postscriptNames: ['HCRBatang'], source: 'hancom',
  });
  const hancomBold = face('hc-hcr-bold', {
    families: ['HCR Batang'], koreanNames: ['함초롬바탕'], postscriptNames: ['HCRBatang-Bold'],
    source: 'hancom', weight: 700, bold: true,
  });
  const italic = face('sys-hcr-italic', {
    families: ['HCR Batang'], postscriptNames: ['HCRBatang-Italic'], italic: true,
  });
  const result = match('함초롬바탕', makeIndex([systemRegular, systemBold, hancomRegular, hancomBold, italic]));
  assert.equal(result.anchor.id, 'hc-hcr');
  assert.deepEqual(
    result.slots.map(slot => [slot.slot, slot.face.id]),
    [['regular', 'hc-hcr'], ['bold', 'hc-hcr-bold'], ['italic', 'sys-hcr-italic']],
  );
});

test('rhwpDesktop이 없으면 데스크톱 글꼴 경로는 아무것도 바꾸지 않는다', async () => {
  resetDesktopFontsForTests();
  resetLocalFontsForTests();
  assert.equal(isDesktopFontsSupported(), false);
  const report = await prepareDesktopFontsForDocument(['맑은 고딕']);
  assert.equal(report.available, false);
  assert.equal(report.items.length, 0);
  assert.equal(resolveLocalFont('맑은 고딕'), null);
});

test('데스크톱 글꼴은 스타일별 FontFace와 런타임 메트릭으로 등록되고 권한 요청을 막는다', async () => {
  const g = globalThis as typeof globalThis & { FontFace?: unknown; document?: unknown };
  const originalDocument = g.document;
  const originalFontFace = g.FontFace;
  const added: Array<{ family: string; weight: string }> = [];
  class TestFontFace {
    family: string;
    descriptors: { weight: string };
    constructor(family: string, _source: ArrayBuffer, descriptors: { weight: string }) {
      this.family = family;
      this.descriptors = descriptors;
    }
    async load(): Promise<this> { return this; }
  }
  g.FontFace = TestFontFace;
  g.document = {
    fonts: {
      add(fontFace: TestFontFace) { added.push({ family: fontFace.family, weight: fontFace.descriptors.weight }); },
      delete() { return true; },
    },
  };
  const reads: string[] = [];
  const metricCalls: Array<{ aliases: string[]; bold: boolean; italic: boolean }> = [];
  resetDesktopFontsForTests();
  resetLocalFontsForTests();
  configureDesktopFonts({
    host: {
      listSystemFonts: async () => makeIndex([malgun, malgunBold]),
      readSystemFont: async (id) => {
        reads.push(id);
        return new Uint8Array([1, 2, 3, id.length]);
      },
    },
    metrics: {
      register: (_bytes, aliasesJson, bold, italic) => {
        metricCalls.push({ aliases: JSON.parse(aliasesJson), bold, italic });
        return JSON.stringify({ registered: true, key: `k${metricCalls.length}` });
      },
    },
  });
  try {
    const report = await prepareDesktopFontsForDocument(['맑은 고딕', 'serif', '없는글꼴']);
    assert.deepEqual(report.items.map(item => [item.requested, item.status]), [['맑은 고딕', 'loaded'], ['없는글꼴', 'missing']]);
    assert.deepEqual(report.items[0]?.face?.stylesLoaded, ['regular', 'bold']);
    assert.equal(report.totals.facesRegistered, 2);
    assert.deepEqual(reads.sort(), ['malgun', 'malgun-bold']);
    assert.equal(added.length, 2);
    assert.equal(added[0]?.family, added[1]?.family);
    assert.deepEqual(added.map(entry => entry.weight).sort(), ['400', '700']);
    assert.deepEqual(metricCalls.map(call => call.bold).sort(), [false, true]);
    assert.ok(metricCalls.every(call => call.aliases.includes('맑은 고딕') && !call.italic));

    const record = resolveLocalFont('맑은 고딕');
    assert.equal(record?.source, 'desktop');
    assert.equal(record?.style, 'Regular');
    const status = analyzeDocumentFonts(['맑은 고딕', '없는글꼴'], { localSupported: true, localSnapshotStored: false });
    assert.equal(status.fonts.find(font => font.fontName === '맑은 고딕')?.status, 'available');
    assert.equal(status.shouldPromptLocalAccess, false);

    const again = await prepareDesktopFontsForDocument(['Malgun Gothic']);
    assert.equal(again.items[0]?.status, 'already-available');
    assert.equal(again.totals.facesRegistered, 0);
    assert.equal(reads.length, 2);

    // 데스크톱 face는 등록 뒤 JS 사본을 남기지 않고, CanvasKit 요청 때 파일을 다시 읽는다.
    const boldKey = localFontFaceKey(resolveLocalFont('Malgun Gothic Bold')!);
    assert.equal(getSessionLocalFontFace(boldKey)?.bytes, null);
    assert.equal(getImportedLocalFontBytes('맑은 고딕'), null);
    const [first, second] = await Promise.all([
      loadLocalFontBytesFor(['Malgun Gothic Bold']),
      loadLocalFontBytesFor(['Malgun Gothic Bold']),
    ]);
    assert.deepEqual(reads.slice(2), ['malgun-bold']);
    assert.deepEqual(new Uint8Array(first.get(boldKey)!), new Uint8Array([1, 2, 3, 'malgun-bold'.length]));
    assert.equal(second.get(boldKey), first.get(boldKey));
  } finally {
    resetDesktopFontsForTests();
    resetLocalFontsForTests();
    g.document = originalDocument;
    g.FontFace = originalFontFace;
  }
});

test('데스크톱 글꼴은 가져온 파일과 별도 한도를 쓴다', async () => {
  const g = globalThis as typeof globalThis & { FontFace?: unknown; document?: unknown };
  const originalDocument = g.document;
  const originalFontFace = g.FontFace;
  g.FontFace = class {
    family: string;
    constructor(family: string) { this.family = family; }
    async load(): Promise<this> { return this; }
  };
  g.document = { fonts: { add() {}, delete() { return true; } } };
  resetLocalFontsForTests();
  const bigFace = LOCAL_FONT_MAX_BYTES_PER_FACE + 8 * 1024 * 1024;
  const names = (id: number) => ({
    family: 'Big Desktop', fullName: `Big Desktop ${id}`, postscriptName: `BigDesktop-${id}`, style: 'Regular', aliases: [],
  });
  try {
    // 가져오기 한도(face당 32MB, 합계 128MB)를 넘는 크기도 데스크톱 한도 안에서는 등록된다.
    const count = Math.ceil(LOCAL_FONT_MAX_AGGREGATE_BYTES / bigFace) + 1;
    assert.ok(count * bigFace < DESKTOP_FONT_MAX_AGGREGATE_BYTES);
    for (let id = 0; id < count; id += 1) {
      const result = await registerLocalFontFace(new ArrayBuffer(bigFace), {
        source: 'desktop', fileName: `big-${id}.ttf`, desktopFaceId: `big-${id}`, names: names(id),
      });
      assert.equal(result.ok, true, `desktop face ${id}`);
    }
    const tooLarge = await registerLocalFontFace(new ArrayBuffer(bigFace), {
      source: 'imported', fileName: 'big.ttf', names: names(99),
    });
    assert.deepEqual(tooLarge, { ok: false, reason: 'too-large' });
    // 데스크톱 사용량은 가져온 파일의 합계 한도에 잡히지 않는다.
    const small = await registerLocalFontFace(new ArrayBuffer(1024), {
      source: 'imported', fileName: 'small.ttf', names: names(100),
    });
    assert.equal(small.ok, true);
  } finally {
    resetLocalFontsForTests();
    g.document = originalDocument;
    g.FontFace = originalFontFace;
  }
});

test('데스크톱 색인은 이미 가져온 regular·bold face와 WASM 바이트를 보존한다', async () => {
  const g = globalThis as unknown as { FontFace?: unknown; document?: unknown };
  const originalDocument = g.document;
  const originalFontFace = g.FontFace;
  const added: string[] = [];
  g.FontFace = class {
    family: string;
    constructor(family: string) { this.family = family; }
    async load(): Promise<this> { return this; }
  };
  g.document = { fonts: { add(face: { family: string }) { added.push(face.family); }, delete() { return true; } } };
  resetLocalFontsForTests();
  const names = (style: string) => ({
    family: 'Shared Font', fullName: `Shared Font ${style}`,
    postscriptName: `SharedFont-${style}`, style, aliases: [],
  });
  const bytes = (marker: number) => {
    const data = new Uint8Array(1024);
    data[0] = marker;
    return data.buffer;
  };
  try {
    for (const [style, marker] of [['Regular', 1], ['Bold', 2]] as const) {
      const result = await registerLocalFontFace(bytes(marker), {
        source: 'imported', fileName: `${style}.ttf`, names: names(style),
      });
      assert.equal(result.ok, true);
    }
    const generation = getImportedFontGeneration();
    for (const style of ['Regular', 'Bold']) {
      const result = await registerLocalFontFace(bytes(9), {
        source: 'desktop', fileName: `${style}.ttf`, desktopFaceId: style, names: names(style),
      });
      assert.equal(result.ok && result.reused, true);
      assert.equal(getSessionLocalFontFace(localFontFaceKey(names(style)))?.record.source, 'imported');
    }
    assert.equal(getImportedFontGeneration(), generation);
    assert.equal(getImportedLocalFontBytes('Shared Font', false, false)?.byteLength, 1024);
    assert.equal(new Uint8Array(getImportedLocalFontBytes('Shared Font', false, false)!)[0], 1);
    assert.equal(new Uint8Array(getImportedLocalFontBytes('Shared Font', true, false)!)[0], 2);
    assert.equal(added.length, 2);
  } finally {
    resetLocalFontsForTests();
    g.document = originalDocument;
    g.FontFace = originalFontFace;
  }
});

test('직접 가져온 face는 늦게 끝난 데스크톱 등록보다 우선한다', async () => {
  const g = globalThis as unknown as { FontFace?: unknown; document?: unknown };
  const originalDocument = g.document;
  const originalFontFace = g.FontFace;
  let releaseDesktop: (() => void) | undefined;
  const added: string[] = [];
  g.FontFace = class {
    family: string;
    constructor(family: string) { this.family = family; }
    async load(): Promise<this> {
      if (this.family.startsWith('rhwp-desktop')) {
        await new Promise<void>(resolve => { releaseDesktop = resolve; });
      }
      return this;
    }
  };
  g.document = { fonts: { add(face: { family: string }) { added.push(face.family); }, delete() { return true; } } };
  resetLocalFontsForTests();
  const names = {
    family: 'Shared Font', fullName: 'Shared Font Regular', postscriptName: 'SharedFont-Regular',
    style: 'Regular', aliases: [],
  };
  try {
    const pendingDesktop = registerLocalFontFace(new ArrayBuffer(1024), {
      source: 'desktop', fileName: 'desktop.ttf', desktopFaceId: 'desktop-face', names,
    });
    assert.ok(releaseDesktop);
    const imported = await registerLocalFontFace(new ArrayBuffer(1024), {
      source: 'imported', fileName: 'imported.ttf', names,
    });
    assert.equal(imported.ok, true);
    const generation = getImportedFontGeneration();
    releaseDesktop?.();
    const desktop = await pendingDesktop;
    assert.equal(desktop.ok && desktop.reused, true);
    assert.equal(getSessionLocalFontFace(localFontFaceKey(names))?.record.source, 'imported');
    assert.equal(hasImportedLocalFontFace(names.family), true);
    assert.ok(getImportedLocalFontBytes(names.family));
    assert.equal(getImportedFontGeneration(), generation);
    assert.equal(added.length, 1);
  } finally {
    resetLocalFontsForTests();
    g.document = originalDocument;
    g.FontFace = originalFontFace;
  }
});

test('글꼴 폴더와 허브 색인을 합치고, 한쪽이 실패해도 나머지로 연결한다', async () => {
  const folder = {
    kind: 'browser-folder' as const,
    coversSystem: false,
    list: async () => makeIndex(
      [face('aaaaaaaaaaaaaaaa', { families: ['휴먼명조'], source: 'hancom' })],
      [{ name: '휴먼명조', file: 'HMKMM.TTF', script: 'Hwp', faceId: 'aaaaaaaaaaaaaaaa' }],
    ),
    read: async (id: string) => new Uint8Array([id === 'aaaaaaaaaaaaaaaa' ? 1 : 0]),
  };
  const hub = {
    kind: 'hub' as const,
    coversSystem: true,
    list: async () => makeIndex([face('bbbbbbbbbbbbbbbb', { families: ['Arial'] })]),
    read: async (id: string) => new Uint8Array([id === 'bbbbbbbbbbbbbbbb' ? 2 : 0]),
  };
  const combined = createCombinedFontHost([['f', folder], ['h', hub]]);
  const index = await combined.list();
  assert.deepEqual(index.faces.map(entry => entry.id), ['f:aaaaaaaaaaaaaaaa', 'h:bbbbbbbbbbbbbbbb']);
  assert.equal(index.hancomFaceMap[0]?.faceId, 'f:aaaaaaaaaaaaaaaa');
  assert.equal(combined.coversSystem, true);
  assert.deepEqual([...await combined.read('f:aaaaaaaaaaaaaaaa') as Uint8Array], [1]);
  assert.deepEqual([...await combined.read('h:bbbbbbbbbbbbbbbb') as Uint8Array], [2]);
  await assert.rejects(combined.read('x:bbbbbbbbbbbbbbbb'));

  const offline = createCombinedFontHost([
    ['f', folder],
    ['h', { ...hub, list: async () => { throw new Error('hub offline'); } }],
  ]);
  const partial = await offline.list();
  assert.deepEqual(partial.faces.map(entry => entry.id), ['f:aaaaaaaaaaaaaaaa']);
  assert.match(partial.errors[0]?.message ?? '', /hub offline/);
});
