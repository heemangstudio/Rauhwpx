import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  configureDesktopFonts,
  getSystemFontHost,
  prepareDesktopFontsForDocument,
  prepareLocalFontAccessMetrics,
  resetDesktopFontsForTests,
  syncImportedFontMetrics,
} from '../src/core/desktop-fonts.ts';
import {
  configureFontFolder,
  connectFontFolder,
  getFontFolderState,
  reconnectFontFolder,
  resetFontFolderForTests,
  restoreFontFolder,
} from '../src/core/font-folder.ts';
import type { FolderDirectoryHandleLike, FolderFileHandleLike } from '../src/core/font-folder-index.ts';
import {
  detectLocalFonts,
  getSessionLocalFontFace,
  loadLocalFontBytesFor,
  localFontFaceKey,
  registerLocalFontFace,
  resetLocalFontsForTests,
  resolveLocalFont,
} from '../src/core/local-fonts.ts';
import { analyzeDocumentFonts } from '../src/core/document-font-status.ts';

const NOTO = readFileSync(new URL('../../ttfs/opensource/NotoSansKR-Regular.ttf', import.meta.url));

type Tree = { [name: string]: Uint8Array | Tree };

function fakeFolder(name: string, tree: Tree, permission: { query: PermissionState; request: PermissionState; requests: number } = {
  query: 'granted', request: 'granted', requests: 0,
}): FolderDirectoryHandleLike & { permission: typeof permission } {
  const entries = Object.entries(tree).map(([child, value]): FolderFileHandleLike | FolderDirectoryHandleLike => (
    value instanceof Uint8Array
      ? { kind: 'file', name: child, getFile: async () => new File([value], child, { lastModified: 1_700_000_000_000 }) }
      : fakeFolder(child, value, permission)
  ));
  return {
    kind: 'directory',
    name,
    permission,
    async *values() { yield* entries; },
    async getDirectoryHandle(child) { return entries.find(entry => entry.name === child && entry.kind === 'directory') as FolderDirectoryHandleLike; },
    async getFileHandle(child) { return entries.find(entry => entry.name === child && entry.kind === 'file') as FolderFileHandleLike; },
    async queryPermission() { return permission.query; },
    async requestPermission() {
      permission.requests += 1;
      return permission.request;
    },
  };
}

function utf16le(text: string): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
}

/** 한컴 Shared 폴더 모양: 표시 이름 목록은 Fonts/, TTF는 TTF/All/ 아래에 있다. */
function hancomShared(permission?: Parameters<typeof fakeFolder>[2]) {
  return fakeFolder('Shared', {
    Fonts: {
      'PrivateFontList.ini': utf16le('[All]\r\nHY헤드라인M=H2HDRM.TTF\r\n'),
      'Readme.txt': new Uint8Array([1, 2, 3]),
    },
    TTF: { All: { 'H2HDRM.TTF': new Uint8Array(NOTO) } },
  }, permission);
}

interface Harness {
  added: string[];
  metricCalls: Array<{ aliases: string[]; bold: boolean; italic: boolean }>;
  restore(): void;
}

function installBrowserStubs(): Harness {
  const g = globalThis as typeof globalThis & { FontFace?: unknown; document?: unknown };
  const originalDocument = g.document;
  const originalFontFace = g.FontFace;
  const added: string[] = [];
  const metricCalls: Harness['metricCalls'] = [];
  g.FontFace = class {
    family: string;
    constructor(family: string) { this.family = family; }
    async load(): Promise<this> { return this; }
  };
  g.document = { fonts: { add(face: { family: string }) { added.push(face.family); }, delete() { return true; } } };
  resetDesktopFontsForTests();
  resetLocalFontsForTests();
  resetFontFolderForTests();
  configureDesktopFonts({
    host: null,
    metrics: {
      register: (_bytes, aliasesJson, bold, italic) => {
        metricCalls.push({ aliases: JSON.parse(aliasesJson), bold, italic });
        return JSON.stringify({ registered: true });
      },
    },
  });
  return {
    added,
    metricCalls,
    restore() {
      resetFontFolderForTests();
      resetDesktopFontsForTests();
      resetLocalFontsForTests();
      g.document = originalDocument;
      g.FontFace = originalFontFace;
    },
  };
}

test('연결한 글꼴 폴더는 한컴 목록 이름으로 데스크톱과 같은 경로로 연결되고 바이트를 남기지 않는다', async () => {
  const harness = installBrowserStubs();
  try {
    const index = await connectFontFolder({ kind: 'handle', handle: hancomShared() });
    assert.equal(getSystemFontHost()?.kind, 'browser-folder');
    assert.deepEqual(index.roots.map(root => [root.path, root.kind, root.fileCount]), [['Shared', 'hancom', 1]]);
    assert.deepEqual(index.hancomFaceMap.map(entry => entry.name), ['HY헤드라인M']);
    assert.ok(index.faces[0]!.families.includes('HY헤드라인M'));

    const report = await prepareDesktopFontsForDocument(['HY헤드라인M', '없는글꼴']);
    assert.equal(report.host, 'browser-folder');
    assert.deepEqual(report.items.map(item => [item.requested, item.status]), [['HY헤드라인M', 'loaded'], ['없는글꼴', 'missing']]);
    assert.equal(report.items[0]?.face?.file, 'Shared/TTF/All/H2HDRM.TTF');
    assert.equal(report.items[0]?.face?.source, 'hancom');
    assert.equal(harness.added.length, 1);
    assert.ok(harness.metricCalls[0]?.aliases.includes('HY헤드라인M'));
    assert.equal(getFontFolderState().status, 'connected');

    // 폴더에서 찾은 글꼴은 감지 권한을 묻지 않지만, 폴더는 설치 글꼴 전체가 아니므로 나머지는 묻는다.
    const status = analyzeDocumentFonts(['HY헤드라인M', '없는글꼴'], { localSupported: true, localSnapshotStored: false });
    assert.equal(status.fonts.find(font => font.fontName === 'HY헤드라인M')?.status, 'available');
    assert.equal(status.shouldPromptLocalAccess, true);

    // 등록 뒤 JS 사본은 버리고 CanvasKit 요청 때 폴더에서 다시 읽는다.
    const faceKey = localFontFaceKey(resolveLocalFont('HY헤드라인M')!);
    assert.equal(getSessionLocalFontFace(faceKey)?.bytes, null);
    const reread = await loadLocalFontBytesFor(['HY헤드라인M']);
    assert.equal(reread.get(faceKey)?.byteLength, NOTO.byteLength);
  } finally {
    harness.restore();
  }
});

test('저장된 폴더는 권한이 있으면 조용히, 없으면 클릭 한 번으로 다시 연결한다', async () => {
  const harness = installBrowserStubs();
  const g = globalThis as typeof globalThis & { window?: unknown };
  const originalWindow = g.window;
  g.window = { showDirectoryPicker: async () => { throw new Error('picker not expected'); } };
  try {
    const granted = hancomShared();
    configureFontFolder({ store: { load: async () => granted, save: async () => {}, clear: async () => {} } });
    await restoreFontFolder();
    assert.equal(getSystemFontHost()?.kind, 'browser-folder');
    assert.notEqual(getFontFolderState().status, 'needs-permission');
    assert.equal(granted.permission.requests, 0);

    resetFontFolderForTests();
    const prompt = hancomShared({ query: 'prompt', request: 'granted', requests: 0 });
    configureFontFolder({ store: { load: async () => prompt, save: async () => {}, clear: async () => {} } });
    await restoreFontFolder();
    assert.equal(getFontFolderState().status, 'needs-permission');
    assert.equal(getFontFolderState().name, 'Shared');
    assert.equal(getSystemFontHost(), null);
    assert.equal(prompt.permission.requests, 0);

    const index = await reconnectFontFolder();
    assert.equal(prompt.permission.requests, 1);
    assert.equal(index?.faces.length, 1);
    assert.equal(getFontFolderState().status, 'connected');
  } finally {
    g.window = originalWindow;
    harness.restore();
  }
});

test('가져온 파일과 로컬 글꼴 감지 face도 레이아웃 메트릭에 올리고, 폴더 face가 우선한다', async () => {
  const harness = installBrowserStubs();
  const g = globalThis as typeof globalThis & { queryLocalFonts?: unknown };
  const originalQuery = g.queryLocalFonts;
  const blobReads: string[] = [];
  const fontData = (postscriptName: string, style: string, family = 'Rau Gothic') => ({
    family,
    fullName: `${family} ${style}`,
    postscriptName,
    style,
    blob: async () => {
      blobReads.push(postscriptName);
      return new Blob([new Uint8Array(64)]);
    },
  });
  g.queryLocalFonts = async (options?: { postscriptNames?: string[] }) => {
    const all = [
      fontData('RauGothic-Regular', 'Regular'),
      fontData('RauGothic-Bold', 'Bold'),
      fontData('HYHeadLine-Medium', 'Regular', 'HY헤드라인M'),
    ];
    return options?.postscriptNames ? all.filter(font => options.postscriptNames!.includes(font.postscriptName)) : all;
  };
  try {
    // 가져온 파일
    const imported = await registerLocalFontFace(new ArrayBuffer(128), {
      source: 'imported',
      fileName: 'rau.ttf',
      names: { family: 'Rau Imported', fullName: 'Rau Imported', postscriptName: 'RauImported', style: 'Regular', aliases: [] },
    });
    assert.equal(imported.ok, true);
    assert.equal(syncImportedFontMetrics(), 1);
    assert.ok(harness.metricCalls.at(-1)?.aliases.includes('Rau Imported'));

    // 로컬 글꼴 감지: 문서가 쓰는 family의 regular/bold만 읽고 메트릭 등록
    await detectLocalFonts({ force: true });
    blobReads.length = 0;
    harness.metricCalls.length = 0;
    const report = await prepareLocalFontAccessMetrics(['Rau Gothic'], { assumeGranted: true });
    assert.equal(report?.host, 'local-font-access');
    assert.equal(report?.totals.metricsRegistered, 2);
    assert.deepEqual(blobReads.sort(), ['RauGothic-Bold', 'RauGothic-Regular']);
    assert.deepEqual(harness.metricCalls.map(call => call.bold).sort(), [false, true]);
    assert.ok(harness.metricCalls.every(call => call.aliases.includes('Rau Gothic')));
    // 같은 별칭이면 다시 읽지 않는다.
    const again = await prepareLocalFontAccessMetrics(['Rau Gothic'], { assumeGranted: true });
    assert.equal(again?.totals.metricsRegistered, 0);

    // 폴더가 같은 글꼴을 연결하면 로컬 글꼴 감지 쪽은 건너뛴다.
    await connectFontFolder({ kind: 'handle', handle: hancomShared() });
    await prepareDesktopFontsForDocument(['HY헤드라인M']);
    blobReads.length = 0;
    assert.equal(await prepareLocalFontAccessMetrics(['HY헤드라인M'], { assumeGranted: true }), null);
    assert.deepEqual(blobReads, []);
  } finally {
    g.queryLocalFonts = originalQuery;
    harness.restore();
  }
});
