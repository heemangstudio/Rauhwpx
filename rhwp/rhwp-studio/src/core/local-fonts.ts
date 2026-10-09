/**
 * 로컬 글꼴 감지 모듈
 *
 * Local Font Access API (queryLocalFonts) 를 사용하여 사용자 PC에 설치된
 * 글꼴 목록을 조회한다. 저장된 감지 결과는 재사용하되, 새 목록 조회는
 * 사용자 승인 흐름에서만 호출하도록 API를 분리한다.
 */
import { REGISTERED_FONTS } from './font-loader.ts';
import { convertHftToOpenType } from './hft-font.ts';
import { isHftBytes, registerHftOutlines } from './hft-glyphs.ts';
import { normalizeMalformedCmapSentinels, repairUnderstatedCompositeBounds } from './sfnt-repair.ts';
import { sfntMetricsSubset } from './sfnt-subset.ts';

/** queryLocalFonts 반환 타입 (DOM 표준 미포함) */
interface FontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  blob?: () => Promise<Blob>;
}

export type LocalFontDetectionSource = 'local-font-access' | 'font-presence-probe';

/**
 * 하나의 설치 글꼴 face를 나타내는 로컬 메타데이터다.
 *
 * `family`는 브라우저 CSS에서 사용할 canonical 이름이고, `aliases`에는 HWP가 저장한
 * 한글/영문 family, full name, PostScript name을 함께 둔다. 원본 SFNT 바이트는 저장하지 않는다.
 */
export interface LocalFontRecord {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  displayName: string;
  aliases: string[];
  /** 이번 세션에 가져온 face 이름. 번들 CSS 대체 글꼴보다 먼저 선택한다. */
  runtimeFamily?: string;
  /**
   * 설치 face 의 합성 글리프 bbox 복구 필요 여부 (`repairUnderstatedCompositeBounds`).
   * 한 번 읽어 판정한 결과를 감지 snapshot 에 저장해, 복구가 필요 없는 글꼴은 다시 읽지 않는다.
   */
  sfntBoundsRepair?: boolean;
  /** 세션 face의 출처. 사용자가 고른 파일이면 imported, 글꼴 색인(데스크톱·글꼴 폴더)이면 desktop. */
  source?: 'imported' | 'desktop';
  /** 데스크톱 글꼴 파일 경로 (진단용) */
  sourcePath?: string;
  /** 데스크톱 글꼴 색인 face id. 바이트를 다시 읽을 때 쓴다. */
  desktopFaceId?: string;
}

export interface LocalFontSnapshot {
  /** v1은 family 문자열만 저장한 이전 형식이며 로드 시 v2 레코드로 승격한다. */
  version: 1 | 2;
  detectedAt: string;
  families: string[];
  /** v2에서만 저장되는 설치 글꼴 face 메타데이터. */
  fontRecords?: LocalFontRecord[];
  source: LocalFontDetectionSource;
  /** font-presence-probe는 전체 목록이 아니라 문서 후보만 확인한다. */
  checkedFamilies?: string[];
}

export type LocalFontStorageKind =
  | 'chrome-storage-local'
  | 'browser-storage-local'
  | 'local-storage'
  | 'none';

export interface LocalFontState {
  supported: boolean;
  method: LocalFontDetectionSource | null;
  loaded: boolean;
  stored: boolean;
  source: LocalFontDetectionSource | null;
  complete: boolean;
  storage: LocalFontStorageKind;
  count: number;
  checkedFamilies: string[];
  detectedAt: string | null;
  lastError: string | null;
}

export interface DetectLocalFontsOptions {
  /** 저장/메모리 캐시가 있어도 Local Font Access API를 다시 호출한다. */
  force?: boolean;
  /** true면 REGISTERED_FONTS에 포함된 family도 반환한다. */
  includeRegistered?: boolean;
  /** Local Font Access API가 없는 브라우저에서 현재 문서 글꼴만 확인할 때 사용한다. */
  candidateFamilies?: readonly string[];
}

export interface GetLocalFontsOptions {
  /** true면 REGISTERED_FONTS에 포함된 family도 반환한다. */
  includeRegistered?: boolean;
}

type LocalFontGlobal = typeof globalThis & {
  queryLocalFonts?: (options?: { postscriptNames?: string[] }) => Promise<FontData[]>;
  document?: {
    createElement?: (tagName: string) => unknown;
  };
};

interface ChromeRuntimeLike {
  lastError?: { message?: string };
}

interface ChromeStorageAreaLike {
  get(
    keys: string | string[] | Record<string, unknown> | null,
    callback?: (items: Record<string, unknown>) => void,
  ): void | Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>, callback?: () => void): void | Promise<void>;
  remove(keys: string | string[], callback?: () => void): void | Promise<void>;
}

interface ChromeLike {
  runtime?: ChromeRuntimeLike;
  storage?: {
    local?: ChromeStorageAreaLike;
  };
}

type BrowserLike = ChromeLike;

const STORAGE_KEY = 'rhwp-local-fonts';
const PROBE_FONT_SIZE = 72;
const PROBE_WIDTH_EPSILON = 0.1;
const PROBE_FALLBACKS = ['monospace', 'serif', 'sans-serif'];
const PROBE_TEXTS = [
  'mmmmmmmmmiiiiiiiiiWWW',
  '0123456789 ABCDEFG abcdefg',
  '가나다라마바사아자차카타파하',
  '한글과 English 12345',
];
const LOCAL_FONT_NAME_READ_CONCURRENCY = 4;
let importedFontGeneration = 0;
/** resolveLocalFont·repairedLocalFontFamily 결과가 바뀔 수 있을 때마다 증가한다 (글꼴 체인 캐시 무효화 기준). */
let localFontLookupGeneration = 0;

export function getImportedFontGeneration(): number {
  return importedFontGeneration;
}

export function getLocalFontLookupGeneration(): number {
  return localFontLookupGeneration;
}
export const LOCAL_FONT_BYTE_READ_CONCURRENCY = 4;
export const LOCAL_FONT_MAX_BYTES_PER_FACE = 32 * 1024 * 1024;
export const LOCAL_FONT_MAX_AGGREGATE_BYTES = 128 * 1024 * 1024;
export const LOCAL_FONT_MAX_FACES_PER_DOCUMENT = 64;
/**
 * 데스크톱 시스템 글꼴 한도. 사용자가 고른 파일과 달리 바이트를 JS에 보관하지 않고
 * (FontFace가 자체 사본을 갖고, CanvasKit은 필요할 때 다시 읽는다) 한컴 번들 CJK 글꼴은
 * face 하나가 30MB를 넘기도 해서 가져오기 한도와 따로 둔다. 문서 하나가 수십 개 family의
 * regular/bold/italic을 모두 쓰는 경우까지 담는다.
 */
export const DESKTOP_FONT_MAX_BYTES_PER_FACE = 64 * 1024 * 1024;
export const DESKTOP_FONT_MAX_AGGREGATE_BYTES = 512 * 1024 * 1024;
export const DESKTOP_FONT_MAX_FACES = 192;
const HANGUL_RE = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/;

/** 캐시된 로컬 글꼴 snapshot (감지/저장소 로드 전 null) */
let cachedSnapshot: LocalFontSnapshot | null = null;
let cachedFontRecords: LocalFontRecord[] = [];
let cachedFontLookup: LocalFontLookup = emptyLocalFontLookup();
interface SessionFontFaceEntry {
  record: LocalFontRecord;
  /** 가져온 파일만 보관한다. 데스크톱 face는 null이고 필요할 때 다시 읽는다. */
  bytes: ArrayBuffer | null;
  /** 수식 literal 측정이 동기로 읽는 데스크톱 face의 메트릭 표 사본 */
  literalBytes: ArrayBuffer | null;
  byteLength: number;
  face: FontFace;
}
const importedFontFaces = new Map<string, SessionFontFaceEntry>();
let importedFontLookup: LocalFontLookup = emptyLocalFontLookup();
let nextImportedFamilyId = 0;
let storageLoaded = false;
let lastStorageError: string | null = null;
/** 설치 face 의 합성 글리프 bbox 복구 필요 여부 (face key → 판정). snapshot 재로드와 무관하게 유지한다. */
const sfntBoundsRepairByFaceKey = new Map<string, boolean>();
/** 복구한 설치 글꼴을 이번 세션에 등록한 CSS family (face key → family). */
const repairedLocalFamilyByFaceKey = new Map<string, string>();
/** 복구 판정/등록이 진행 중인 설치 family (중복 조회 방지). */
const localFamilyRepairs = new Map<string, Promise<boolean>>();
let nextRepairedFamilyId = 0;
/** 동시에 들어온 CanvasKit SFNT 바이트 조회만 합치는 in-flight cache. */
const localFontBytesByPostscriptName = new Map<string, Promise<ArrayBuffer | null>>();
let localFontByteBatchTail: Promise<void> = Promise.resolve();

/** Local Font Access API 지원 여부 */
export function isLocalFontAccessSupported(): boolean {
  return typeof (globalThis as LocalFontGlobal).queryLocalFonts === 'function';
}

/** 문서 후보 글꼴 단위의 fallback probe 지원 여부 */
export function isFontPresenceProbeSupported(): boolean {
  try {
    const documentLike = (globalThis as LocalFontGlobal).document;
    const canvas = documentLike?.createElement?.('canvas') as {
      getContext?: (contextId: '2d') => unknown;
    } | null | undefined;
    const context = canvas?.getContext?.('2d') as { measureText?: unknown } | null | undefined;
    return typeof context?.measureText === 'function';
  } catch {
    return false;
  }
}

export function getLocalFontDetectionMethod(): LocalFontDetectionSource | null {
  if (isLocalFontAccessSupported()) return 'local-font-access';
  if (isFontPresenceProbeSupported()) return 'font-presence-probe';
  return null;
}

/** 로컬 글꼴 감지 지원 여부. Firefox에서는 문서 후보 글꼴 probe만 지원한다. */
export function isLocalFontSupported(): boolean {
  return getLocalFontDetectionMethod() !== null;
}

function normalizeFamilies(families: unknown): string[] {
  if (!Array.isArray(families)) return [];
  const set = new Set<string>();
  for (const family of families) {
    if (typeof family !== 'string') continue;
    const name = family.trim();
    if (name) set.add(name);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'ko'));
}

/** 글꼴 이름 → 정규화 별칭. 같은 이름을 수식 측정·조회마다 다시 정규화하지 않는다. */
const normalizedFontAliases = new Map<string, string>();
const NORMALIZED_FONT_ALIAS_LIMIT = 8192;

function normalizeFontAlias(value: unknown): string {
  if (typeof value !== 'string') return '';
  let alias = normalizedFontAliases.get(value);
  if (alias === undefined) {
    alias = value
      .replace(/\u0000/g, '')
      .normalize('NFC')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase('en-US');
    if (normalizedFontAliases.size >= NORMALIZED_FONT_ALIAS_LIMIT) normalizedFontAliases.clear();
    normalizedFontAliases.set(value, alias);
  }
  return alias;
}

function normalizeFontNames(values: readonly unknown[]): string[] {
  const byAlias = new Map<string, string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const name = value.replace(/\u0000/g, '').normalize('NFC').replace(/\s+/g, ' ').trim();
    const alias = normalizeFontAlias(name);
    if (alias && !byAlias.has(alias)) byAlias.set(alias, name);
  }
  return Array.from(byAlias.values()).sort((a, b) => a.localeCompare(b, 'ko'));
}

interface SfntFontNames {
  families: string[];
  fullNames: string[];
  postscriptNames: string[];
  styles: string[];
}

interface LocalFontLookup {
  aliases: Map<string, LocalFontRecord[]>;
  postscriptNames: Map<string, LocalFontRecord[]>;
  fullNames: Map<string, LocalFontRecord[]>;
  familyStyles: Map<string, LocalFontRecord[]>;
  families: Map<string, LocalFontRecord[]>;
}

function emptyLocalFontLookup(): LocalFontLookup {
  return {
    aliases: new Map(),
    postscriptNames: new Map(),
    fullNames: new Map(),
    familyStyles: new Map(),
    families: new Map(),
  };
}

function addLocalFontLookupRecord(
  index: Map<string, LocalFontRecord[]>,
  name: string,
  record: LocalFontRecord,
): void {
  const key = normalizeFontAlias(name);
  if (!key) return;
  const records = index.get(key);
  if (!records) {
    index.set(key, [record]);
  } else if (!records.includes(record)) {
    records.push(record);
  }
}

function buildLocalFontLookup(records: readonly LocalFontRecord[]): LocalFontLookup {
  const lookup = emptyLocalFontLookup();
  for (const record of records) {
    for (const alias of record.aliases) addLocalFontLookupRecord(lookup.aliases, alias, record);
    addLocalFontLookupRecord(lookup.postscriptNames, record.postscriptName, record);
    addLocalFontLookupRecord(lookup.fullNames, record.fullName, record);
    addLocalFontLookupRecord(lookup.familyStyles, `${record.family} ${record.style}`, record);
    addLocalFontLookupRecord(lookup.families, record.family, record);
  }
  return lookup;
}

function emptySfntFontNames(): SfntFontNames {
  return { families: [], fullNames: [], postscriptNames: [], styles: [] };
}

function byteRangeAvailable(view: DataView, offset: number, length: number): boolean {
  return Number.isSafeInteger(offset)
    && Number.isSafeInteger(length)
    && offset >= 0
    && length >= 0
    && offset <= view.byteLength
    && length <= view.byteLength - offset;
}

function sfntTag(view: DataView, offset: number): string {
  if (!byteRangeAvailable(view, offset, 4)) return '';
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function decodeUtf16Be(bytes: Uint8Array): string {
  const codeUnits: number[] = [];
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    codeUnits.push((bytes[index] << 8) | bytes[index + 1]);
  }
  let text = '';
  for (let index = 0; index < codeUnits.length; index += 4096) {
    text += String.fromCharCode(...codeUnits.slice(index, index + 4096));
  }
  return text;
}

function decodeSfntName(bytes: Uint8Array, platformId: number): string {
  if (platformId === 0 || platformId === 3) return decodeUtf16Be(bytes);
  let text = '';
  for (let index = 0; index < bytes.length; index += 4096) {
    text += String.fromCharCode(...bytes.slice(index, index + 4096));
  }
  return text;
}

/**
 * macOS legacy name record는 문자 인코딩을 platform ID만으로 확정할 수 없다.
 * 브라우저가 제공한 Unicode 이름은 유지하고, 이 record는 표시/별칭 후보에서 제외한다.
 */
function isUnicodeSfntPlatform(platformId: number): boolean {
  return platformId === 0 || platformId === 3;
}

function parseSfntNameTable(buffer: ArrayBuffer): SfntFontNames {
  const view = new DataView(buffer);
  if (!byteRangeAvailable(view, 0, 6)) return emptySfntFontNames();

  const count = view.getUint16(2, false);
  const stringOffset = view.getUint16(4, false);
  const recordsEnd = 6 + count * 12;
  if (!byteRangeAvailable(view, 6, count * 12) || stringOffset > view.byteLength || recordsEnd > view.byteLength) {
    return emptySfntFontNames();
  }

  const families: string[] = [];
  const fullNames: string[] = [];
  const postscriptNames: string[] = [];
  const styles: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const recordOffset = 6 + index * 12;
    const platformId = view.getUint16(recordOffset, false);
    const nameId = view.getUint16(recordOffset + 6, false);
    const length = view.getUint16(recordOffset + 8, false);
    const relativeOffset = view.getUint16(recordOffset + 10, false);
    const valueOffset = stringOffset + relativeOffset;
    if (!byteRangeAvailable(view, valueOffset, length)) continue;
    if (!isUnicodeSfntPlatform(platformId)) continue;

    const name = decodeSfntName(
      new Uint8Array(buffer, valueOffset, length),
      platformId,
    ).replace(/\u0000/g, '').trim();
    if (!name) continue;
    if (nameId === 1 || nameId === 16) {
      families.push(name);
    } else if (nameId === 2 || nameId === 17) {
      styles.push(name);
    } else if (nameId === 4) {
      fullNames.push(name);
    } else if (nameId === 6) {
      postscriptNames.push(name);
    }
  }

  return {
    families: normalizeFontNames(families),
    fullNames: normalizeFontNames(fullNames),
    postscriptNames: normalizeFontNames(postscriptNames),
    styles: normalizeFontNames(styles),
  };
}

async function readSfntFontNames(fontData: FontData): Promise<SfntFontNames> {
  if (!fontData.blob) return emptySfntFontNames();
  try {
    const blob = await fontData.blob();
    if (
      !Number.isSafeInteger(blob.size)
      || blob.size < 12
      || blob.size > LOCAL_FONT_MAX_BYTES_PER_FACE
    ) return emptySfntFontNames();
    const header = new DataView(await blob.slice(0, 12).arrayBuffer());
    const tableCount = header.getUint16(4, false);
    const directoryLength = 12 + tableCount * 16;
    if (blob.size < directoryLength) return emptySfntFontNames();
    const directory = new DataView(await blob.slice(0, directoryLength).arrayBuffer());
    for (let index = 0; index < tableCount; index += 1) {
      const recordOffset = 12 + index * 16;
      if (sfntTag(directory, recordOffset) !== 'name') continue;
      const offset = directory.getUint32(recordOffset + 8, false);
      const length = directory.getUint32(recordOffset + 12, false);
      if (offset > blob.size || length > blob.size - offset) return emptySfntFontNames();
      return parseSfntNameTable(await blob.slice(offset, offset + length).arrayBuffer());
    }
  } catch {
    // 메타데이터 보강 실패는 감지 자체를 실패시키지 않고 API 기본 이름만 사용한다.
  }
  return emptySfntFontNames();
}

function preferredLocalFontDisplayName(fullNames: readonly string[], families: readonly string[]): string {
  return fullNames.find(name => HANGUL_RE.test(name))
    ?? families.find(name => HANGUL_RE.test(name))
    ?? fullNames[0]
    ?? families[0]
    ?? '';
}

/** UTF-8/UTF-16 이름을 legacy code page로 오독했을 때의 전형적인 깨짐을 제외한다. */
function isUsableFontDisplayName(value: string): boolean {
  if (!value.trim() || /[\u0000-\u001f\u007f-\u009f\ufffd]/.test(value)) return false;
  return !/[\u00ab\u00bb\u00c2\u00c3\u00d0\u00db]/.test(value);
}

function makeLocalFontRecord(fontData: Pick<FontData, 'family' | 'fullName' | 'postscriptName' | 'style'>, sfntNames: SfntFontNames = emptySfntFontNames()): LocalFontRecord | null {
  const families = normalizeFontNames([fontData.family, ...sfntNames.families]);
  const fullNames = normalizeFontNames([fontData.fullName, ...sfntNames.fullNames]);
  const postscriptNames = normalizeFontNames([fontData.postscriptName, ...sfntNames.postscriptNames]);
  const styles = normalizeFontNames([fontData.style, ...sfntNames.styles]);
  const family = normalizeFontNames([fontData.family])[0] ?? families[0] ?? fullNames[0] ?? postscriptNames[0];
  if (!family) return null;

  const aliases = normalizeFontNames([
    ...families,
    ...fullNames,
    ...postscriptNames,
    ...families.flatMap(familyName => styles.map(style => `${familyName} ${style}`)),
  ]);
  return {
    family,
    fullName: fullNames[0] ?? family,
    postscriptName: postscriptNames[0] ?? '',
    // name table의 여러 언어 스타일 이름은 가나다순이라 'Corsivo' 같은 현지화 이름이 먼저 올 수 있다.
    // 굵기·기울임 판정에 쓰므로 API가 준 이름을 먼저 쓴다.
    style: normalizeFontNames([fontData.style])[0] ?? styles[0] ?? '',
    displayName: preferredLocalFontDisplayName(fullNames, families) || family,
    aliases,
  };
}

function normalizeLocalFontRecords(value: unknown): LocalFontRecord[] {
  if (!Array.isArray(value)) return [];
  const records = new Map<string, LocalFontRecord>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const data = candidate as Partial<LocalFontRecord>;
    const record = makeLocalFontRecord({
      family: typeof data.family === 'string' ? data.family : '',
      fullName: typeof data.fullName === 'string' ? data.fullName : '',
      postscriptName: typeof data.postscriptName === 'string' ? data.postscriptName : '',
      style: typeof data.style === 'string' ? data.style : '',
    }, {
      families: [],
      fullNames: [],
      postscriptNames: [],
      styles: [],
    });
    if (!record) continue;
    const aliases = normalizeFontNames([...record.aliases, ...(Array.isArray(data.aliases) ? data.aliases : [])]);
    const displayCandidates = [
      typeof data.displayName === 'string' ? data.displayName.trim() : '',
      typeof data.fullName === 'string' ? data.fullName.trim() : '',
      typeof data.family === 'string' ? data.family.trim() : '',
      ...aliases,
    ].filter(isUsableFontDisplayName);
    const displayName = displayCandidates.find(name => HANGUL_RE.test(name))
      ?? displayCandidates[0]
      ?? preferredLocalFontDisplayName(aliases.filter(name => HANGUL_RE.test(name)), [record.fullName, record.family])
      ?? record.family;
    const normalized: LocalFontRecord = { ...record, displayName, aliases };
    if (typeof data.sfntBoundsRepair === 'boolean') normalized.sfntBoundsRepair = data.sfntBoundsRepair;
    const key = normalizeFontAlias(normalized.postscriptName || normalized.fullName || normalized.family);
    if (key && !records.has(key)) records.set(key, normalized);
  }
  return Array.from(records.values()).sort((a, b) => a.displayName.localeCompare(b.displayName, 'ko'));
}

function recordsFromFamilies(families: readonly string[]): LocalFontRecord[] {
  return normalizeLocalFontRecords(families.map(family => ({ family, fullName: family, postscriptName: '', style: '' })));
}

function snapshotRecords(snapshot: LocalFontSnapshot | null): LocalFontRecord[] {
  if (!snapshot) return [];
  return snapshot.fontRecords?.length ? snapshot.fontRecords : recordsFromFamilies(snapshot.families);
}

function cacheLocalFontSnapshot(snapshot: LocalFontSnapshot | null): void {
  cachedSnapshot = snapshot;
  cachedFontRecords = snapshotRecords(snapshot);
  cachedFontLookup = buildLocalFontLookup(cachedFontRecords);
  localFontLookupGeneration++;
}

function refreshImportedFontLookup(): void {
  importedFontLookup = buildLocalFontLookup(
    Array.from(importedFontFaces.values(), entry => entry.record),
  );
  localFontLookupGeneration++;
}

export function importedFontWeight(style: string): string {
  if (/thin|hairline/i.test(style)) return '100';
  if (/extra.?light|ultra.?light/i.test(style)) return '200';
  if (/light/i.test(style)) return '300';
  if (/medium/i.test(style)) return '500';
  if (/semi.?bold|demi.?bold|^demi$/i.test(style)) return '600';
  if (/extra.?bold|ultra.?bold/i.test(style)) return '800';
  if (/heavy|black/i.test(style)) return '900';
  if (/bold|굵게|^b(?:i)?$/i.test(style)) return '700';
  return '400';
}

export function importedFontSlant(style: string): 'normal' | 'italic' {
  return /italic|oblique|기울임|^(?:i|bi)$/i.test(style) ? 'italic' : 'normal';
}

export interface LocalFontImportResult {
  imported: LocalFontRecord[];
  rejected: string[];
  /** 엔진이 윤곽선으로 그리는 HFT 파일 이름 */
  hftOutlines?: string[];
}

export function localFontImportMessage(result: LocalFontImportResult): string {
  const count = result.imported.length + (result.hftOutlines?.length ?? 0);
  const loaded = count > 0
    ? `글꼴 ${count}개를 이번 세션에 불러왔습니다.`
    : '글꼴을 불러오지 못했습니다.';
  return result.rejected.length > 0
    ? `${loaded} 실패한 파일: ${result.rejected.join(', ')}`
    : loaded;
}

export type LocalFontFaceSource = 'imported' | 'desktop';

/** 이미 알고 있는 face 이름. 주어지면 SFNT name table을 다시 읽지 않는다. */
export interface LocalFontFaceNames {
  family: string;
  fullName: string;
  postscriptName: string;
  /** CSS weight/slant와 CanvasKit 스타일 선택에 쓰는 style 이름 */
  style: string;
  displayName?: string;
  aliases: readonly string[];
}

export interface RegisterLocalFontFaceOptions {
  source: LocalFontFaceSource;
  /** HFT 판별/오류 메시지용 파일 이름 */
  fileName: string;
  sourcePath?: string;
  names?: LocalFontFaceNames;
  /** 문서 글꼴명처럼 name table에 없는 별칭 */
  extraAliases?: readonly string[];
  /** 같은 키의 face는 하나의 runtime CSS family를 공유한다. 없으면 별칭 겹침으로 찾는다. */
  runtimeFamilyKey?: string;
  /** 데스크톱 글꼴 색인 face id (source가 desktop일 때) */
  desktopFaceId?: string;
}

export type RegisterLocalFontFaceFailure =
  /** 브라우저 face 는 아니지만 엔진이 HFT 윤곽선으로 그린다. */
  | 'hft-outlines'
  | 'unsupported-hft'
  | 'invalid'
  | 'too-large'
  | 'face-limit'
  | 'aggregate-limit'
  | 'load-failed';

export type RegisterLocalFontFaceResult =
  | { ok: true; record: LocalFontRecord; bytes: ArrayBuffer; convertedFromHft: boolean; reused?: true }
  | { ok: false; reason: RegisterLocalFontFaceFailure; error?: string };

const runtimeFamilyByKey = new Map<string, string>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionFontLimits(source: LocalFontFaceSource): { perFace: number; aggregate: number; faces: number } {
  return source === 'desktop'
    ? { perFace: DESKTOP_FONT_MAX_BYTES_PER_FACE, aggregate: DESKTOP_FONT_MAX_AGGREGATE_BYTES, faces: DESKTOP_FONT_MAX_FACES }
    : { perFace: LOCAL_FONT_MAX_BYTES_PER_FACE, aggregate: LOCAL_FONT_MAX_AGGREGATE_BYTES, faces: LOCAL_FONT_MAX_FACES_PER_DOCUMENT };
}

function sessionFontUsage(source: LocalFontFaceSource): { bytes: number; faces: number } {
  let bytes = 0;
  let faces = 0;
  for (const entry of importedFontFaces.values()) {
    if ((entry.record.source ?? 'imported') !== source) continue;
    bytes += entry.byteLength;
    faces += 1;
  }
  if (source === 'imported') {
    bytes += importedHftOutlineBytes;
    faces += importedHftOutlineFaces;
  }
  return { bytes, faces };
}

let importedHftOutlineBytes = 0;
let importedHftOutlineFaces = 0;

/**
 * 세션 FontFace에 넘기는 바이트: HFT 변환과 SFNT cmap·합성 글리프 bbox 복구를 거친다.
 * `desktopFaceId`가 있으면 그 face의 bbox 복구 판정을 기억해, 고칠 글리프가 없던 face는
 * 다음부터 전체 글리프를 다시 훑지 않는다.
 */
export function prepareSessionFontBytes(
  source: ArrayBuffer,
  fileName: string,
  desktopFaceId?: string,
): { ok: true; bytes: ArrayBuffer; convertedFromHft: boolean } | { ok: false; reason: 'unsupported-hft' | 'invalid'; error: string } {
  let converted: ArrayBuffer | null;
  try {
    converted = convertHftToOpenType(source, fileName);
  } catch (error) {
    return { ok: false, reason: 'unsupported-hft', error: errorMessage(error) };
  }
  try {
    const verdict = desktopFaceId ? desktopBoundsRepairVerdicts().get(desktopFaceId) : undefined;
    const repaired = repairSfntBytes(converted ?? source, verdict !== false);
    if (desktopFaceId && verdict === undefined) rememberDesktopBoundsRepair(desktopFaceId, repaired.boundsRepaired);
    return { ok: true, bytes: repaired.bytes, convertedFromHft: converted !== null };
  } catch (error) {
    return { ok: false, reason: 'invalid', error: errorMessage(error) };
  }
}

const DESKTOP_BOUNDS_REPAIR_KEY = 'rhwp-desktop-font-bounds-repair';
const DESKTOP_BOUNDS_REPAIR_LIMIT = 4096;
/** 데스크톱 face id(경로·크기·수정 시각에서 나온다) → 합성 글리프 bbox 복구 필요 여부 */
let desktopBoundsRepair: Map<string, boolean> | null = null;

function desktopBoundsRepairVerdicts(): Map<string, boolean> {
  if (desktopBoundsRepair) return desktopBoundsRepair;
  desktopBoundsRepair = new Map();
  try {
    const stored = JSON.parse(localStorageRef()?.getItem(DESKTOP_BOUNDS_REPAIR_KEY) ?? 'null');
    if (stored && typeof stored === 'object') {
      for (const [id, verdict] of Object.entries(stored)) {
        if (typeof verdict === 'boolean') desktopBoundsRepair.set(id, verdict);
      }
    }
  } catch {
    // 읽지 못한 판정은 다시 내린다.
  }
  return desktopBoundsRepair;
}

function rememberDesktopBoundsRepair(faceId: string, verdict: boolean): void {
  const verdicts = desktopBoundsRepairVerdicts();
  verdicts.set(faceId, verdict);
  while (verdicts.size > DESKTOP_BOUNDS_REPAIR_LIMIT) verdicts.delete(verdicts.keys().next().value!);
  try {
    localStorageRef()?.setItem(DESKTOP_BOUNDS_REPAIR_KEY, JSON.stringify(Object.fromEntries(verdicts)));
  } catch {
    // 저장하지 못해도 이번 세션에는 판정을 쓴다.
  }
}

/**
 * 글꼴 바이트 하나를 이번 세션 FontFace로 등록한다. 파일 가져오기와 데스크톱 시스템 글꼴이
 * 같은 경로를 쓰므로 Canvas2D·CanvasKit·수식 글꼴 조회가 두 출처를 구분하지 않는다.
 */
export async function registerLocalFontFace(
  source: ArrayBuffer,
  options: RegisterLocalFontFaceOptions,
): Promise<RegisterLocalFontFaceResult> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) {
    return { ok: false, reason: 'load-failed', error: 'FontFace unavailable' };
  }
  const limits = sessionFontLimits(options.source);
  if (source.byteLength <= 0) return { ok: false, reason: 'invalid' };
  if (source.byteLength > limits.perFace) return { ok: false, reason: 'too-large' };
  const prepared = prepareSessionFontBytes(source, options.fileName, options.desktopFaceId);
  if (!prepared.ok) {
    // 브라우저 face 로 변환할 수 없는 HFT 은행도 윤곽선은 읽을 수 있다.
    // 가져온 파일은 이 경로에서도 세션 용량·개수 한도를 지킨다.
    if (options.source === 'imported' && isHftBytes(source)) {
      const usage = sessionFontUsage(options.source);
      if (usage.faces >= limits.faces) return { ok: false, reason: 'face-limit' };
      if (source.byteLength > limits.aggregate - usage.bytes) return { ok: false, reason: 'aggregate-limit' };
      if (registerHftOutlines(source)) {
        importedHftOutlineBytes += source.byteLength;
        importedHftOutlineFaces += 1;
        return { ok: false, reason: 'hft-outlines' };
      }
    }
    return { ok: false, reason: prepared.reason, error: prepared.error };
  }
  const { bytes, convertedFromHft } = prepared;
  const budgetBytes = convertedFromHft ? Math.max(source.byteLength, bytes.byteLength) : bytes.byteLength;
  if (bytes.byteLength > limits.perFace) return { ok: false, reason: 'too-large' };

  let record: LocalFontRecord | null;
  if (options.names) {
    const names = options.names;
    const base = makeLocalFontRecord({
      family: names.family,
      fullName: names.fullName,
      postscriptName: names.postscriptName,
      style: names.style,
    });
    record = base && {
      ...base,
      family: names.family.trim() || base.family,
      fullName: names.fullName.trim() || base.fullName,
      postscriptName: names.postscriptName.trim() || base.postscriptName,
      style: names.style.trim(),
      displayName: names.displayName?.trim() || base.displayName,
      aliases: normalizeFontNames([...base.aliases, ...names.aliases]),
    };
  } else {
    const parsed = await readSfntFontNames({
      family: '', fullName: '', postscriptName: '', style: '',
      blob: async () => new Blob([bytes]),
    });
    record = makeLocalFontRecord({ family: '', fullName: '', postscriptName: '', style: '' }, parsed);
  }
  if (!record) return { ok: false, reason: 'invalid', error: 'no usable font names' };
  if (options.extraAliases?.length) {
    record.aliases = normalizeFontNames([...record.aliases, ...options.extraAliases]);
  }
  record.source = options.source;
  if (options.sourcePath) record.sourcePath = options.sourcePath;
  if (options.desktopFaceId) record.desktopFaceId = options.desktopFaceId;

  const faceKey = localFontFaceKey(record);
  const existing = importedFontFaces.get(faceKey);
  // 사용자가 가져온 face는 뒤늦게 끝난 데스크톱 색인 등록보다 우선한다.
  if (options.source === 'desktop' && existing?.record.source === 'imported' && existing.bytes) {
    return { ok: true, record: existing.record, bytes: existing.bytes, convertedFromHft: false, reused: true };
  }
  const sameSourceExisting = existing && (existing.record.source ?? 'imported') === options.source ? existing : undefined;
  const usage = sessionFontUsage(options.source);
  if (!sameSourceExisting && usage.faces >= limits.faces) {
    return { ok: false, reason: 'face-limit' };
  }
  const reserved = usage.bytes - (sameSourceExisting?.byteLength ?? 0);
  if (budgetBytes > limits.aggregate - reserved) {
    return { ok: false, reason: 'aggregate-limit' };
  }

  const keyedFamily = options.runtimeFamilyKey ? runtimeFamilyByKey.get(options.runtimeFamilyKey) : undefined;
  const related = keyedFamily || options.runtimeFamilyKey
    ? undefined
    : Array.from(importedFontFaces.values()).find(entry =>
      entry.record.aliases.some(alias => record!.aliases.some(name =>
        normalizeFontAlias(alias) === normalizeFontAlias(name))));
  const prefix = options.source === 'desktop' ? 'rhwp-desktop' : 'rhwp-imported';
  record.runtimeFamily = keyedFamily
    ?? (options.runtimeFamilyKey ? undefined : existing?.record.runtimeFamily)
    ?? related?.record.runtimeFamily
    ?? `${prefix}-${++nextImportedFamilyId}`;
  if (options.runtimeFamilyKey) runtimeFamilyByKey.set(options.runtimeFamilyKey, record.runtimeFamily);
  record.aliases.push(record.runtimeFamily);
  localFontLookupGeneration++;
  try {
    const face = new FontFace(record.runtimeFamily, bytes, {
      style: importedFontSlant(record.style),
      weight: importedFontWeight(record.style),
    });
    await face.load();
    // FontFace.load 중 사용자가 같은 face를 가져왔을 수 있다.
    const latest = importedFontFaces.get(faceKey);
    if (options.source === 'desktop' && latest?.record.source === 'imported' && latest.bytes) {
      return { ok: true, record: latest.record, bytes: latest.bytes, convertedFromHft: false, reused: true };
    }
    document.fonts.add(face);
    if (latest) document.fonts.delete(latest.face);
    // 수식 PUA 측정은 HY 수식 서체의 cmap/glyf를 동기로 읽는다. 이 서체와 HFT 변환본만
    // 사본을 유지하고 일반 데스크톱 face는 FontFace에 맡긴다.
    const keepBytes = options.source !== 'desktop' || convertedFromHft
      || normalizeFontAlias(record.family) === 'hyhwpeq';
    importedFontFaces.set(faceKey, {
      record,
      bytes: keepBytes ? bytes : null,
      literalBytes: keepBytes ? null : equationLiteralBytes(record.family, bytes),
      byteLength: budgetBytes,
      face,
    });
    if (options.source === 'imported' || convertedFromHft) importedFontGeneration++;
    if (convertedFromHft && options.source === 'imported') registerHftOutlines(source);
    desktopFontBytesInflight.delete(faceKey);
    refreshImportedFontLookup();
    return { ok: true, record, bytes, convertedFromHft };
  } catch (error) {
    return { ok: false, reason: 'load-failed', error: errorMessage(error) };
  }
}

/**
 * 수식 literal 측정(createEquationLiteralFontResolver)은 cmap·maxp·head·hhea만 동기로 읽으므로
 * 이 서체들은 메트릭 표만 남긴 사본을 둔다.
 */
function equationLiteralBytes(family: string, bytes: ArrayBuffer): ArrayBuffer | null {
  if (!['hcr batang', 'batang', 'times new roman'].includes(normalizeFontAlias(family))) return null;
  return sfntMetricsSubset(bytes).slice().buffer;
}

/** 이번 세션에 등록된 face(가져온 파일·데스크톱 글꼴)만 찾는다. 설치 목록 snapshot은 보지 않는다. */
export function resolveSessionLocalFont(fontName: string): LocalFontRecord | null {
  const target = normalizeFontAlias(fontName);
  return target ? resolveFromLookup(importedFontLookup, target, true) : null;
}

/** 세션 face. 데스크톱 face는 bytes가 null이며 `readSessionLocalFontBytes`로 다시 읽는다. */
export function getSessionLocalFontFace(faceKey: string): { record: LocalFontRecord; bytes: ArrayBuffer | null } | null {
  const entry = importedFontFaces.get(faceKey);
  return entry ? { record: entry.record, bytes: entry.bytes } : null;
}

export type DesktopFontByteReader = (faceId: string) => Promise<Uint8Array | ArrayBuffer>;

let desktopFontByteReader: DesktopFontByteReader | null = null;
const desktopFontBytesInflight = new Map<string, Promise<ArrayBuffer | null>>();
let desktopFontReadsActive = 0;
const desktopFontReadWaiters: Array<() => void> = [];

/** 데스크톱 글꼴 바이트를 다시 읽는 함수. desktop-fonts가 preload API로 설정한다. */
export function setDesktopFontByteReader(reader: DesktopFontByteReader | null): void {
  desktopFontByteReader = reader;
}

async function withDesktopFontReadSlot<T>(task: () => Promise<T>): Promise<T> {
  while (desktopFontReadsActive >= LOCAL_FONT_BYTE_READ_CONCURRENCY) {
    await new Promise<void>(resolve => desktopFontReadWaiters.push(resolve));
  }
  desktopFontReadsActive += 1;
  try {
    return await task();
  } finally {
    desktopFontReadsActive -= 1;
    desktopFontReadWaiters.shift()?.();
  }
}

function toOwnedArrayBuffer(bytes: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * 세션 face의 SFNT 바이트. 가져온 파일은 보관한 사본을, 데스크톱 face는 원본 파일을 다시 읽어
 * 등록 때와 같은 변환을 거친 바이트를 돌려준다. 같은 face의 동시 요청은 한 번만 읽는다.
 */
export function readSessionLocalFontBytes(faceKey: string): Promise<ArrayBuffer | null> {
  const entry = importedFontFaces.get(faceKey);
  if (!entry) return Promise.resolve(null);
  if (entry.bytes) return Promise.resolve(entry.bytes);
  const faceId = entry.record.desktopFaceId;
  const reader = desktopFontByteReader;
  if (!faceId || !reader) return Promise.resolve(null);
  const pending = desktopFontBytesInflight.get(faceKey);
  if (pending) return pending;
  const read = withDesktopFontReadSlot(async () => {
    try {
      const prepared = prepareSessionFontBytes(
        toOwnedArrayBuffer(await reader(faceId)),
        entry.record.sourcePath?.split(/[\\/]/).pop() ?? faceId,
        faceId,
      );
      return prepared.ok ? prepared.bytes : null;
    } catch (error) {
      console.warn(`[LocalFonts] ${entry.record.displayName} 글꼴 바이트를 다시 읽지 못했습니다:`, error);
      return null;
    }
  });
  desktopFontBytesInflight.set(faceKey, read);
  void read.finally(() => {
    if (desktopFontBytesInflight.get(faceKey) === read) desktopFontBytesInflight.delete(faceKey);
  });
  return read;
}

export function getSessionLocalFontRecords(): LocalFontRecord[] {
  return Array.from(importedFontFaces.values(), entry => entry.record);
}

/** 이미 등록된 face에 문서 글꼴명 별칭을 더한다. */
export function addSessionLocalFontAliases(faceKey: string, names: readonly string[]): boolean {
  const entry = importedFontFaces.get(faceKey);
  if (!entry) return false;
  const next = normalizeFontNames([...entry.record.aliases, ...names]);
  if (next.length === entry.record.aliases.length) return false;
  entry.record.aliases = next;
  refreshImportedFontLookup();
  return true;
}

/** 사용자가 선택한 TTF/OTF/HFT를 이번 세션에만 등록한다. 글꼴 바이트는 저장소로 보내지 않는다. */
export async function importLocalFontFiles(files: readonly File[]): Promise<LocalFontImportResult> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) {
    throw new Error('이 브라우저에서는 글꼴 파일을 불러올 수 없습니다.');
  }
  if (files.length > LOCAL_FONT_MAX_FACES_PER_DOCUMENT) {
    throw new Error(`한 번에 ${LOCAL_FONT_MAX_FACES_PER_DOCUMENT}개 이하의 글꼴을 선택해 주세요.`);
  }

  const imported: LocalFontRecord[] = [];
  const rejected: string[] = [];
  const hftOutlines: string[] = [];
  const usage = sessionFontUsage('imported');
  const candidates: FontImportCandidate[] = [];
  for (const file of files) {
    if (!/\.(ttf|otf|hft)$/i.test(file.name)
      || file.size <= 0 || file.size > LOCAL_FONT_MAX_BYTES_PER_FACE) {
      rejected.push(file.name);
    } else {
      candidates.push({ file, order: candidates.length });
    }
  }
  const selectedBytes = candidates.reduce((sum, candidate) => sum + candidate.file.size, 0);
  const fitsBudget = usage.bytes + selectedBytes <= LOCAL_FONT_MAX_AGGREGATE_BYTES
    && usage.faces + candidates.length <= LOCAL_FONT_MAX_FACES_PER_DOCUMENT;
  // 예산을 넘으면 선택 순서 대신 문서가 쓰는 글꼴 → 대표 글꼴 → 작은 파일 순으로 채운다.
  const ordered = fitsBudget ? candidates : await prioritizeFontImports(candidates);
  for (const { file } of ordered) {
    let source: ArrayBuffer;
    try {
      source = await file.arrayBuffer();
    } catch {
      rejected.push(file.name);
      continue;
    }
    const result = await registerLocalFontFace(source, { source: 'imported', fileName: file.name });
    if (result.ok) {
      imported.push(result.record);
    } else if (result.reason === 'hft-outlines') {
      hftOutlines.push(file.name);
    } else {
      rejected.push(file.name);
    }
  }
  refreshImportedFontLookup();
  return { imported, rejected, ...(hftOutlines.length ? { hftOutlines } : {}) };
}

interface FontImportCandidate {
  file: File;
  order: number;
}

/** 가져오기 우선순위를 정할 때 참고하는 현재 문서의 글꼴 이름. */
let activeDocumentFontAliases = new Set<string>();

/** 현재 문서가 쓰는 글꼴을 알린다. 글꼴 가져오기 예산을 이 글꼴부터 채운다. */
export function setActiveDocumentFonts(fontNames: readonly string[]): void {
  activeDocumentFontAliases = new Set(fontNames.map(normalizeFontAlias).filter(Boolean));
}

/**
 * 예산(face 수·총 바이트)을 넘는 선택에서 가져올 순서를 정한다.
 * 0: 열린 문서가 쓰는 face, 1: 번들 대체 글꼴이 있는 대표 한글 글꼴, 2: 나머지.
 * 같은 단계에서는 작은 파일부터 채워, 거대한 확장 글꼴 하나가 여러 핵심 face 를 밀어내지 않게 한다.
 */
async function prioritizeFontImports(candidates: readonly FontImportCandidate[]): Promise<FontImportCandidate[]> {
  const registeredAliases = new Set(Array.from(REGISTERED_FONTS, normalizeFontAlias));
  const ranked = await Promise.all(candidates.map(async (candidate) => {
    let names = emptySfntFontNames();
    let converted: ArrayBuffer | null | undefined;
    try {
      if (/\.hft$/i.test(candidate.file.name)) {
        converted = convertHftToOpenType(await candidate.file.arrayBuffer(), candidate.file.name);
      }
      const blob = converted ? new Blob([converted]) : candidate.file;
      names = await readSfntFontNames({
        family: '', fullName: '', postscriptName: '', style: '', blob: async () => blob,
      });
    } catch {
      // 이름을 못 읽은 파일은 가장 낮은 단계로 두고, 실제 가져오기에서 다시 판정한다.
    }
    const aliases = [...names.families, ...names.fullNames, ...names.postscriptNames].map(normalizeFontAlias);
    const tier = aliases.some(alias => activeDocumentFontAliases.has(alias)) ? 0
      : names.families.some(name => registeredAliases.has(normalizeFontAlias(name))) ? 1
        : 2;
    const size = converted?.byteLength ?? candidate.file.size;
    return { candidate, tier, size };
  }));
  ranked.sort((a, b) => a.tier - b.tier || a.size - b.size || a.candidate.order - b.candidate.order);
  return ranked.map(entry => entry.candidate);
}

/** 브라우저 sanitizer/래스터라이저가 잘못 다루는 SFNT 결함을 고친다. 고칠 게 없으면 원본 버퍼다. */
function repairSfntBytes(source: ArrayBuffer, repairBounds = true): { bytes: ArrayBuffer; boundsRepaired: boolean } {
  const sanitized = normalizeMalformedCmapSentinels(source);
  const bytes = repairBounds ? repairUnderstatedCompositeBounds(sanitized) : sanitized;
  return { bytes, boundsRepaired: bytes !== sanitized };
}

/** 합성 글리프 bbox 를 복구해 이번 세션에 등록한 설치 face 의 CSS family. 없으면 null. */
export function repairedLocalFontFamily(record: Pick<LocalFontRecord, 'family' | 'fullName' | 'postscriptName'>): string | null {
  return repairedLocalFamilyByFaceKey.get(localFontFaceKey(record)) ?? null;
}

/**
 * 문서가 쓰는 설치 글꼴 중 합성 글리프 bbox 가 잘못된 face 를 복구해 FontFace 로 등록한다.
 *
 * Canvas2D 는 설치 글꼴을 CSS 이름으로 그리므로 OS 가 원본(잘린) 글리프를 쓴다. 복구가
 * 실제로 필요한 family 만 전체 face 를 바이트로 읽어 별도 CSS family 로 등록하고, 판정은
 * 감지 snapshot 에 저장해 복구가 필요 없는 글꼴은 이후 다시 읽지 않는다.
 * 새로 등록한 face 가 있으면 true.
 */
export async function repairLocalFontFacesFor(fontNames: readonly string[]): Promise<boolean> {
  if (cachedSnapshot?.source !== 'local-font-access'
    || typeof FontFace === 'undefined'
    || typeof document === 'undefined'
    || !document.fonts) return false;
  const familyKeys = new Set<string>();
  for (const fontName of fontNames) {
    const target = normalizeFontAlias(fontName);
    if (!target || importedFontLookup.aliases.has(target)) continue;
    for (const record of cachedFontLookup.aliases.get(target) ?? []) {
      familyKeys.add(normalizeFontAlias(record.family));
    }
  }
  const pending: Promise<boolean>[] = [];
  for (const familyKey of familyKeys) {
    let repair = localFamilyRepairs.get(familyKey);
    if (!repair) {
      const faces = (cachedFontLookup.families.get(familyKey) ?? [])
        .filter(record => record.postscriptName)
        .slice(0, LOCAL_FONT_MAX_FACES_PER_DOCUMENT);
      if (faces.length === 0 || faces.every(record => sfntBoundsRepairVerdict(record) === false)) continue;
      repair = registerRepairedLocalFamily(faces);
      localFamilyRepairs.set(familyKey, repair);
      // 실패한 조회는 다음 문서에서 다시 시도한다.
      void repair.then(ok => { if (!ok) localFamilyRepairs.delete(familyKey); }, () => localFamilyRepairs.delete(familyKey));
    }
    pending.push(repair);
  }
  if (pending.length === 0) return false;
  const results = await Promise.all(pending.map(repair => repair.catch(() => false)));
  await persistSfntRepairVerdicts();
  return results.some(Boolean);
}

function sfntBoundsRepairVerdict(record: LocalFontRecord): boolean | undefined {
  return sfntBoundsRepairByFaceKey.get(localFontFaceKey(record)) ?? record.sfntBoundsRepair;
}

/** 이번 세션에 내린 복구 판정을 감지 snapshot 에 저장한다. */
async function persistSfntRepairVerdicts(): Promise<void> {
  if (!cachedSnapshot?.fontRecords) return;
  let changed = false;
  for (const record of cachedSnapshot.fontRecords) {
    const verdict = sfntBoundsRepairByFaceKey.get(localFontFaceKey(record));
    if (verdict === undefined || record.sfntBoundsRepair === verdict) continue;
    record.sfntBoundsRepair = verdict;
    changed = true;
  }
  if (changed) await writeStoredSnapshot(cachedSnapshot);
}

async function registerRepairedLocalFamily(faces: readonly LocalFontRecord[]): Promise<boolean> {
  const bytesByPostscriptName = await enqueueLocalFontBytesBatch(faces);
  if (!faces.some(record => sfntBoundsRepairVerdict(record) === true)) return false;
  // 같은 family 의 다른 굵기/기울임도 함께 등록해야 굵게 쓴 글자가 합성 굵게로 바뀌지 않는다.
  const family = `rhwp-local-repaired-${++nextRepairedFamilyId}`;
  const registered: LocalFontRecord[] = [];
  for (const record of faces) {
    const bytes = bytesByPostscriptName.get(normalizeFontAlias(record.postscriptName));
    if (!bytes) continue;
    try {
      const face = new FontFace(family, bytes, {
        style: importedFontSlant(record.style),
        weight: importedFontWeight(record.style),
      });
      await face.load();
      document.fonts.add(face);
      registered.push(record);
    } catch {
      // 등록하지 못한 face 는 설치 글꼴로 계속 그린다.
    }
  }
  for (const record of registered) repairedLocalFamilyByFaceKey.set(localFontFaceKey(record), family);
  if (registered.length > 0) localFontLookupGeneration++;
  return registered.length > 0;
}

async function collectLocalFontRecords(fontDataList: readonly FontData[]): Promise<LocalFontRecord[]> {
  const records: Array<LocalFontRecord | null> = new Array(fontDataList.length).fill(null);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < fontDataList.length) {
      const index = nextIndex;
      nextIndex += 1;
      const fontData = fontDataList[index];
      records[index] = makeLocalFontRecord(fontData, await readSfntFontNames(fontData));
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(LOCAL_FONT_NAME_READ_CONCURRENCY, fontDataList.length) },
    () => worker(),
  ));
  return normalizeLocalFontRecords(records.filter((record): record is LocalFontRecord => record !== null));
}

function normalizeSnapshot(value: unknown): LocalFontSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Partial<LocalFontSnapshot>;
  if (data.source !== 'local-font-access' && data.source !== 'font-presence-probe') return null;
  if (typeof data.detectedAt !== 'string' || !data.detectedAt) return null;
  if (data.version !== 1 && data.version !== 2) return null;
  const records = data.version === 2
    ? normalizeLocalFontRecords(data.fontRecords)
    : [];
  return makeSnapshot(
    records.length > 0 ? records : recordsFromFamilies(normalizeFamilies(data.families)),
    data.source,
    data.checkedFamilies,
    data.detectedAt,
  );
}

function makeSnapshot(
  records: readonly LocalFontRecord[],
  source: LocalFontDetectionSource,
  checkedFamilies?: readonly string[],
  detectedAt = new Date().toISOString(),
): LocalFontSnapshot {
  const fontRecords = normalizeLocalFontRecords(records);
  return {
    version: 2,
    detectedAt,
    families: normalizeFamilies(fontRecords.map(record => record.family)),
    fontRecords,
    source,
    checkedFamilies: source === 'font-presence-probe'
      ? normalizeFamilies(checkedFamilies)
      : undefined,
  };
}

function cssQuoteFontFamily(name: string): string {
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function createProbeContext(): CanvasRenderingContext2D | null {
  try {
    const documentLike = (globalThis as LocalFontGlobal).document;
    const canvas = documentLike?.createElement?.('canvas') as {
      getContext?: (contextId: '2d') => CanvasRenderingContext2D | null;
    } | null | undefined;
    return canvas?.getContext?.('2d') ?? null;
  } catch {
    return null;
  }
}

function measureWithFamily(
  context: Pick<CanvasRenderingContext2D, 'font' | 'measureText'>,
  family: string,
  text: string,
): number {
  context.font = `${PROBE_FONT_SIZE}px ${family}`;
  return context.measureText(text).width;
}

function isFamilyLikelyAvailable(
  context: Pick<CanvasRenderingContext2D, 'font' | 'measureText'>,
  family: string,
): boolean {
  const quoted = cssQuoteFontFamily(family);
  for (const fallback of PROBE_FALLBACKS) {
    for (const text of PROBE_TEXTS) {
      const baseWidth = measureWithFamily(context, fallback, text);
      const candidateWidth = measureWithFamily(context, `${quoted}, ${fallback}`, text);
      if (Math.abs(candidateWidth - baseWidth) > PROBE_WIDTH_EPSILON) {
        return true;
      }
    }
  }
  return false;
}

function probeCandidateFamilies(candidateFamilies: readonly string[]): string[] {
  const context = createProbeContext();
  if (!context) return [];
  return normalizeFamilies(candidateFamilies)
    .filter(family => !GENERIC_FONTS.has(family))
    .filter(family => !REGISTERED_FONTS.has(family))
    .filter(family => isFamilyLikelyAvailable(context, family));
}

const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace']);

function getChromeApi(): ChromeLike | null {
  return (globalThis as typeof globalThis & { chrome?: ChromeLike }).chrome ?? null;
}

function getChromeStorageLocal(): ChromeStorageAreaLike | null {
  return getChromeApi()?.storage?.local ?? null;
}

function getBrowserApi(): BrowserLike | null {
  return (globalThis as typeof globalThis & { browser?: BrowserLike }).browser ?? null;
}

function getBrowserStorageLocal(): ChromeStorageAreaLike | null {
  return getBrowserApi()?.storage?.local ?? null;
}

function getExtensionStorageLocal(): { kind: 'chrome-storage-local' | 'browser-storage-local'; storage: ChromeStorageAreaLike } | null {
  const chromeStorage = getChromeStorageLocal();
  if (chromeStorage) return { kind: 'chrome-storage-local', storage: chromeStorage };
  const browserStorage = getBrowserStorageLocal();
  if (browserStorage) return { kind: 'browser-storage-local', storage: browserStorage };
  return null;
}

function getStorageKind(): LocalFontStorageKind {
  const extensionStorage = getExtensionStorageLocal();
  if (extensionStorage) return extensionStorage.kind;
  try {
    if ((globalThis as typeof globalThis & { localStorage?: Storage }).localStorage) {
      return 'local-storage';
    }
  } catch {
    return 'none';
  }
  return 'none';
}

function chromeLastErrorMessage(): string | null {
  return getChromeApi()?.runtime?.lastError?.message ?? null;
}

function isThenable<T>(value: unknown): value is Promise<T> {
  return !!value && typeof (value as { then?: unknown }).then === 'function';
}

function chromeGet(storage: ChromeStorageAreaLike, key: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    try {
      const result = storage.get(key, (items) => {
        const err = chromeLastErrorMessage();
        if (err) {
          settle(() => reject(new Error(err)));
        } else {
          settle(() => resolve(items ?? {}));
        }
      });
      if (isThenable<Record<string, unknown>>(result)) {
        result.then(
          (items) => settle(() => resolve(items ?? {})),
          (error) => settle(() => reject(error)),
        );
      }
    } catch (error) {
      settle(() => reject(error));
    }
  });
}

function chromeSet(storage: ChromeStorageAreaLike, items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    try {
      const result = storage.set(items, () => {
        const err = chromeLastErrorMessage();
        if (err) {
          settle(() => reject(new Error(err)));
        } else {
          settle(() => resolve());
        }
      });
      if (isThenable<void>(result)) {
        result.then(
          () => settle(() => resolve()),
          (error) => settle(() => reject(error)),
        );
      }
    } catch (error) {
      settle(() => reject(error));
    }
  });
}

function chromeRemove(storage: ChromeStorageAreaLike, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    try {
      const result = storage.remove(key, () => {
        const err = chromeLastErrorMessage();
        if (err) {
          settle(() => reject(new Error(err)));
        } else {
          settle(() => resolve());
        }
      });
      if (isThenable<void>(result)) {
        result.then(
          () => settle(() => resolve()),
          (error) => settle(() => reject(error)),
        );
      }
    } catch (error) {
      settle(() => reject(error));
    }
  });
}

function localStorageRef(): Storage | null {
  try {
    return (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

async function readStoredSnapshot(): Promise<LocalFontSnapshot | null> {
  lastStorageError = null;
  const extensionStorage = getExtensionStorageLocal();
  if (extensionStorage) {
    try {
      const data = await chromeGet(extensionStorage.storage, STORAGE_KEY);
      return normalizeSnapshot(data[STORAGE_KEY]);
    } catch (error) {
      lastStorageError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  const storage = localStorageRef();
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return raw ? normalizeSnapshot(JSON.parse(raw)) : null;
  } catch (error) {
    lastStorageError = error instanceof Error ? error.message : String(error);
    return null;
  }
}

async function writeStoredSnapshot(snapshot: LocalFontSnapshot): Promise<void> {
  lastStorageError = null;
  const extensionStorage = getExtensionStorageLocal();
  if (extensionStorage) {
    try {
      await chromeSet(extensionStorage.storage, { [STORAGE_KEY]: snapshot });
    } catch (error) {
      lastStorageError = error instanceof Error ? error.message : String(error);
    }
    return;
  }

  const storage = localStorageRef();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    lastStorageError = error instanceof Error ? error.message : String(error);
  }
}

async function removeStoredSnapshot(): Promise<void> {
  lastStorageError = null;
  const extensionStorage = getExtensionStorageLocal();
  if (extensionStorage) {
    try {
      await chromeRemove(extensionStorage.storage, STORAGE_KEY);
    } catch (error) {
      lastStorageError = error instanceof Error ? error.message : String(error);
    }
    return;
  }

  const storage = localStorageRef();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch (error) {
    lastStorageError = error instanceof Error ? error.message : String(error);
  }
}

/**
 * 저장된 로컬 글꼴 감지 결과를 로드한다.
 * 이 함수는 queryLocalFonts()를 호출하지 않는다.
 */
export async function loadStoredLocalFonts(): Promise<LocalFontSnapshot | null> {
  const snapshot = await readStoredSnapshot();
  cacheLocalFontSnapshot(snapshot);
  storageLoaded = true;
  return snapshot;
}

/** 저장된 로컬 글꼴 감지 결과와 런타임 캐시를 초기화한다. */
export async function clearStoredLocalFonts(): Promise<void> {
  cacheLocalFontSnapshot(null);
  storageLoaded = true;
  localFontBytesByPostscriptName.clear();
  await removeStoredSnapshot();
}

/**
 * 로컬 글꼴을 감지하여 family 목록을 반환한다.
 * - 중복 제거, 한국어 로케일 정렬
 * - 기본 반환값은 기존 UI 호환을 위해 REGISTERED_FONTS에 이미 등록된 글꼴을 제외
 * - includeRegistered=true면 문서 상태 분석용 전체 family 목록을 반환
 * - 캐시/저장소 결과가 있으면 권한 프롬프트 없이 즉시 반환
 */
export async function detectLocalFonts(options: DetectLocalFontsOptions = {}): Promise<string[]> {
  if (!options.force) {
    if (cachedSnapshot) return getLocalFonts({ includeRegistered: options.includeRegistered });
    if (!storageLoaded) {
      await loadStoredLocalFonts();
      if (cachedSnapshot) return getLocalFonts({ includeRegistered: options.includeRegistered });
    }
  }

  let snapshot: LocalFontSnapshot | null = null;
  if (isLocalFontAccessSupported()) {
    const queryLocalFonts = (globalThis as LocalFontGlobal).queryLocalFonts!;
    const fontDataList = await queryLocalFonts();
    snapshot = makeSnapshot(await collectLocalFontRecords(fontDataList), 'local-font-access');
  } else if (isFontPresenceProbeSupported() && options.candidateFamilies?.length) {
    const checkedFamilies = normalizeFamilies(options.candidateFamilies);
    const families = probeCandidateFamilies(checkedFamilies);
    snapshot = makeSnapshot(recordsFromFamilies(families), 'font-presence-probe', checkedFamilies);
  }

  if (!snapshot) return [];

  localFontBytesByPostscriptName.clear();
  cacheLocalFontSnapshot(snapshot);
  storageLoaded = true;
  await writeStoredSnapshot(snapshot);
  console.log(`[LocalFonts] ${cachedFontRecords.length}개 로컬 글꼴 감지됨 (${snapshot.source})`);
  return getLocalFonts({ includeRegistered: options.includeRegistered });
}

/** 캐시된 로컬 글꼴 face 레코드를 반환한다. */
export function getLocalFontRecords(options: GetLocalFontsOptions = {}): LocalFontRecord[] {
  const records = [
    ...Array.from(importedFontFaces.values(), entry => entry.record),
    ...cachedFontRecords,
  ];
  if (options.includeRegistered) return records;
  return records.filter(record => !record.aliases.some(name => REGISTERED_FONTS.has(name)));
}

/** 캐시된 로컬 글꼴 목록을 동기적으로 반환 (감지 전이면 빈 배열) */
export function getLocalFonts(options: GetLocalFontsOptions = {}): string[] {
  return normalizeFamilies(getLocalFontRecords(options).map(record => record.displayName));
}

export function getImportedLocalFontCount(): number {
  let count = 0;
  for (const entry of importedFontFaces.values()) if (entry.record.source !== 'desktop') count += 1;
  return count;
}

/** 캐시된 전체 로컬 글꼴 목록을 반환한다. */
export function getDetectedLocalFonts(): string[] {
  return normalizeFamilies(getLocalFontRecords({ includeRegistered: true }).map(record => record.family));
}

function resolveFromLookup(
  lookup: LocalFontLookup,
  target: string,
  preferRegular = false,
): LocalFontRecord | null {
  const matches = lookup.aliases.get(target) ?? [];
  if (matches.length === 0) return null;
  const uniqueMatch = (records: readonly LocalFontRecord[] | undefined): LocalFontRecord | null =>
    records?.length === 1 ? records[0] : null;
  const exact = uniqueMatch(lookup.postscriptNames.get(target))
    ?? uniqueMatch(lookup.fullNames.get(target))
    ?? uniqueMatch(lookup.familyStyles.get(target))
    ?? uniqueMatch(lookup.families.get(target));
  if (exact) return exact;
  if (preferRegular) {
    const regular = matches.filter(record => /^(regular|normal|보통|)$/i.test(record.style.trim()));
    if (regular.length === 1) return regular[0];
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * 조판 중 수식 측정은 같은 글꼴을 글자마다 조회한다. 글꼴 조회 결과가 바뀔 때마다 오르는
 * localFontLookupGeneration 이 같으면 지난 결과를 그대로 쓴다.
 */
let lookupMemoGeneration = -1;
const resolvedLocalFonts = new Map<string, LocalFontRecord | null>();
const importedFontBytesByRequest = new Map<string, ArrayBuffer | null>();

function syncLookupMemo(): void {
  if (lookupMemoGeneration === localFontLookupGeneration) return;
  lookupMemoGeneration = localFontLookupGeneration;
  resolvedLocalFonts.clear();
  importedFontBytesByRequest.clear();
}

/** HWP/CSS 글꼴명에서 동일한 설치 글꼴 face를 찾는다. */
export function resolveLocalFont(fontName: string): LocalFontRecord | null {
  syncLookupMemo();
  let record = resolvedLocalFonts.get(fontName);
  if (record === undefined) {
    const target = normalizeFontAlias(fontName);
    record = target
      ? resolveFromLookup(importedFontLookup, target, true) ?? resolveFromLookup(cachedFontLookup, target)
      : null;
    resolvedLocalFonts.set(fontName, record);
  }
  return record;
}

/**
 * 가져온 파일·수식 글꼴의 SFNT 바이트. 같은 family의 style face를 구분한다.
 * 세션이 보관한 버퍼를 복사하지 않고 돌려주므로 호출자는 읽기만 한다.
 */
export function getImportedLocalFontBytes(
  fontName: string,
  bold = false,
  italic = false,
): ArrayBuffer | null {
  syncLookupMemo();
  const key = `${fontName}\u0000${bold ? 1 : 0}${italic ? 1 : 0}`;
  let bytes = importedFontBytesByRequest.get(key);
  if (bytes === undefined) {
    bytes = findImportedLocalFontBytes(fontName, bold, italic);
    importedFontBytesByRequest.set(key, bytes);
  }
  return bytes;
}

function findImportedLocalFontBytes(fontName: string, bold: boolean, italic: boolean): ArrayBuffer | null {
  const record = resolveLocalFont(fontName);
  if (!record?.runtimeFamily) return null;
  const target = normalizeFontAlias(fontName);
  const family = normalizeFontAlias(record.family);
  const exactFace = target === normalizeFontAlias(record.postscriptName)
    || (target !== family && target === normalizeFontAlias(record.fullName))
    || target === normalizeFontAlias(`${record.family} ${record.style}`);
  const aliases = importedFontLookup.aliases.get(target) ?? [];
  const variants = (target === family || target === normalizeFontAlias(record.runtimeFamily)
    ? importedFontLookup.families.get(family) ?? []
    : aliases).filter(candidate => candidate.runtimeFamily === record.runtimeFamily);
  const selected = !exactFace && variants.length > 1
    ? variants.sort((a, b) => {
      const distance = (candidate: LocalFontRecord): number =>
        (importedFontSlant(candidate.style) === (italic ? 'italic' : 'normal') ? 0 : 1000)
        + Math.abs(Number(importedFontWeight(candidate.style)) - (bold ? 700 : 400));
      return distance(a) - distance(b);
    })[0]
    : record;
  const entry = importedFontFaces.get(localFontFaceKey(selected));
  return entry?.bytes ?? entry?.literalBytes ?? null;
}

/** 가져온 face가 실제로 등록됐는지 바이트 복사 없이 확인한다. */
export function hasImportedLocalFontFace(fontName: string): boolean {
  const record = resolveLocalFont(fontName);
  return !!record?.runtimeFamily && importedFontFaces.has(localFontFaceKey(record));
}

/** CSS family와 달리 style별 native Typeface cache를 구분하는 안정 키다. */
export function localFontFaceKey(record: Pick<LocalFontRecord, 'family' | 'fullName' | 'postscriptName'>): string {
  return normalizeFontAlias(record.postscriptName || record.fullName || record.family);
}

function localFontRecordMatchesFontData(record: LocalFontRecord, fontData: FontData): boolean {
  const expectedPostscriptName = normalizeFontAlias(record.postscriptName);
  const actualPostscriptName = normalizeFontAlias(fontData.postscriptName);
  if (expectedPostscriptName && actualPostscriptName) {
    return expectedPostscriptName === actualPostscriptName;
  }
  const names = [fontData.family, fontData.fullName, fontData.postscriptName]
    .map(normalizeFontAlias)
    .filter(Boolean);
  const aliases = new Set(record.aliases.map(normalizeFontAlias));
  return names.some(name => aliases.has(name));
}

async function readLocalFontBytesBatch(records: readonly LocalFontRecord[]): Promise<Map<string, ArrayBuffer>> {
  const bytesByPostscriptName = new Map<string, ArrayBuffer>();
  if (cachedSnapshot?.source !== 'local-font-access') return bytesByPostscriptName;
  const queryLocalFonts = (globalThis as LocalFontGlobal).queryLocalFonts;
  const postscriptNames = normalizeFontNames(records.map(record => record.postscriptName));
  if (!queryLocalFonts || postscriptNames.length === 0) return bytesByPostscriptName;

  try {
    const candidates = await queryLocalFonts({ postscriptNames });
    let reservedBytes = 0;
    let nextIndex = 0;
    let firstReadError: unknown;
    const worker = async (): Promise<void> => {
      while (nextIndex < records.length) {
        const record = records[nextIndex]!;
        nextIndex += 1;
        const fontData = candidates.find(candidate => localFontRecordMatchesFontData(record, candidate));
        if (!fontData?.blob) continue;
        let reserved = 0;
        try {
          const blob = await fontData.blob();
          if (
            !Number.isSafeInteger(blob.size)
            || blob.size <= 0
            || blob.size > LOCAL_FONT_MAX_BYTES_PER_FACE
            || blob.size > LOCAL_FONT_MAX_AGGREGATE_BYTES - reservedBytes
          ) continue;
          reserved = blob.size;
          reservedBytes += reserved;
          const bytes = await blob.arrayBuffer();
          if (bytes.byteLength !== reserved) {
            reservedBytes -= reserved;
            continue;
          }
          // 가져온 파일과 같은 복구를 거쳐야 CanvasKit 도 잘린 합성 글리프를 그대로 그리지 않는다.
          const repaired = repairSfntBytes(bytes);
          sfntBoundsRepairByFaceKey.set(localFontFaceKey(record), repaired.boundsRepaired);
          bytesByPostscriptName.set(normalizeFontAlias(record.postscriptName), repaired.bytes);
        } catch (error) {
          if (reserved > 0) reservedBytes -= reserved;
          firstReadError ??= error;
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(LOCAL_FONT_BYTE_READ_CONCURRENCY, records.length) },
      () => worker(),
    ));
    if (firstReadError) {
      console.warn('[LocalFonts] 일부 CanvasKit용 SFNT 바이트를 읽지 못했습니다:', firstReadError);
    }
  } catch (error) {
    // 이미 승인된 글꼴을 다시 읽지 못해도 기본 Typeface fallback으로 계속 렌더한다.
    console.warn('[LocalFonts] CanvasKit용 SFNT 바이트 일괄 조회 실패:', error);
  }
  return bytesByPostscriptName;
}

/** queryLocalFonts로 감지한 face 레코드. 세션 face(가져온 파일·글꼴 폴더)는 뺀다. */
export function getDetectedLocalFontRecords(): readonly LocalFontRecord[] {
  return cachedSnapshot?.source === 'local-font-access' ? cachedFontRecords : [];
}

/** 로컬 글꼴 감지 권한 상태. Permissions API가 이 이름을 모르면 'unknown'. */
export async function queryLocalFontAccessPermission(): Promise<PermissionState | 'unknown'> {
  try {
    const permissions = (globalThis as { navigator?: { permissions?: Permissions } }).navigator?.permissions;
    if (!permissions?.query) return 'unknown';
    const status = await permissions.query({ name: 'local-fonts' as PermissionName });
    return status.state;
  } catch {
    return 'unknown';
  }
}

/**
 * 감지한 face들의 원본 SFNT 바이트를 한 번의 queryLocalFonts 조회로 읽는다.
 * 키는 정규화한 PostScript 이름이다. 가져오기와 같은 face·합계 한도를 쓰고 저장하지 않는다.
 */
export function readLocalFontAccessBytes(records: readonly LocalFontRecord[]): Promise<Map<string, ArrayBuffer>> {
  return enqueueLocalFontBytesBatch(records);
}

function enqueueLocalFontBytesBatch(records: readonly LocalFontRecord[]): Promise<Map<string, ArrayBuffer>> {
  const batch = localFontByteBatchTail.then(
    () => readLocalFontBytesBatch(records),
    () => readLocalFontBytesBatch(records),
  );
  localFontByteBatchTail = batch.then(() => undefined, () => undefined);
  return batch;
}

/**
 * CanvasKit이 현재 문서의 local face를 등록할 때만 원본 SFNT 바이트를 일괄 조회한다.
 * 바이트는 localStorage나 session cache에 보존하지 않고, 동시에 들어온 같은
 * PostScript face 요청만 하나의 조회로 합친다.
 */
export async function loadLocalFontBytesFor(fontNames: readonly string[]): Promise<Map<string, ArrayBuffer>> {
  const recordsByPostscriptName = new Map<string, LocalFontRecord>();
  const result = new Map<string, ArrayBuffer>();
  const sessionReads = new Map<string, Promise<ArrayBuffer | null>>();
  for (const fontName of fontNames) {
    const record = resolveLocalFont(fontName);
    if (!record) continue;
    const faceKey = localFontFaceKey(record);
    const imported = importedFontFaces.get(faceKey);
    if (imported) {
      if (imported.bytes) {
        result.set(faceKey, imported.bytes);
      } else if (!sessionReads.has(faceKey)) {
        sessionReads.set(faceKey, readSessionLocalFontBytes(faceKey));
      }
      continue;
    }
    if (!record.postscriptName) continue;
    const postscriptName = normalizeFontAlias(record.postscriptName);
    if (!recordsByPostscriptName.has(postscriptName)
      && recordsByPostscriptName.size >= LOCAL_FONT_MAX_FACES_PER_DOCUMENT) continue;
    recordsByPostscriptName.set(postscriptName, record);
  }

  const missing = Array.from(recordsByPostscriptName.entries())
    .filter(([postscriptName]) => !localFontBytesByPostscriptName.has(postscriptName));
  if (missing.length > 0) {
    const records = missing.map(([, record]) => record);
    const batch = enqueueLocalFontBytesBatch(records);
    for (const [postscriptName] of missing) {
      const pending = batch.then(
        bytesByPostscriptName => bytesByPostscriptName.get(postscriptName) ?? null,
      );
      localFontBytesByPostscriptName.set(postscriptName, pending);
      void pending.then(
        () => {
          if (localFontBytesByPostscriptName.get(postscriptName) === pending) {
            localFontBytesByPostscriptName.delete(postscriptName);
          }
        },
        () => {
          if (localFontBytesByPostscriptName.get(postscriptName) === pending) {
            localFontBytesByPostscriptName.delete(postscriptName);
          }
        },
      );
    }
  }

  const pendingByPostscriptName = new Map(
    Array.from(recordsByPostscriptName.keys(), postscriptName => [
      postscriptName,
      localFontBytesByPostscriptName.get(postscriptName),
    ] as const),
  );
  for (const [postscriptName, record] of recordsByPostscriptName) {
    const bytes = await pendingByPostscriptName.get(postscriptName);
    if (bytes) result.set(localFontFaceKey(record), bytes);
  }
  for (const [faceKey, pending] of sessionReads) {
    const bytes = await pending;
    if (bytes) result.set(faceKey, bytes);
  }
  return result;
}

/** 단일 face 요청도 일괄 조회 cache를 경유하는 편의 함수다. */
export async function loadLocalFontBytes(fontName: string): Promise<ArrayBuffer | null> {
  const record = resolveLocalFont(fontName);
  if (!record) return null;
  return (await loadLocalFontBytesFor([fontName])).get(localFontFaceKey(record)) ?? null;
}

/** 현재 로컬 글꼴 감지/저장 상태를 반환한다. */
export function getLocalFontState(): LocalFontState {
  const method = getLocalFontDetectionMethod();
  const complete = cachedSnapshot?.source === 'local-font-access';
  const checkedFamilies = cachedSnapshot?.source === 'font-presence-probe'
    ? (cachedSnapshot.checkedFamilies ?? [])
    : (complete ? (cachedSnapshot?.families ?? []) : []);
  return {
    supported: method !== null,
    method,
    loaded: storageLoaded,
    stored: cachedSnapshot !== null,
    source: cachedSnapshot?.source ?? null,
    complete,
    storage: getStorageKind(),
    count: cachedSnapshot?.families.length ?? 0,
    checkedFamilies,
    detectedAt: cachedSnapshot?.detectedAt ?? null,
    lastError: lastStorageError,
  };
}

/** 테스트 전용: 모듈 내부 캐시를 초기화한다. */
export function resetLocalFontsForTests(): void {
  cacheLocalFontSnapshot(null);
  importedFontFaces.clear();
  importedHftOutlineBytes = 0;
  importedHftOutlineFaces = 0;
  desktopFontBytesInflight.clear();
  desktopFontByteReader = null;
  importedFontGeneration++;
  importedFontLookup = emptyLocalFontLookup();
  runtimeFamilyByKey.clear();
  nextImportedFamilyId = 0;
  storageLoaded = false;
  lastStorageError = null;
  localFontBytesByPostscriptName.clear();
  sfntBoundsRepairByFaceKey.clear();
  desktopBoundsRepair = null;
  repairedLocalFamilyByFaceKey.clear();
  localFontLookupGeneration++;
  localFamilyRepairs.clear();
  nextRepairedFamilyId = 0;
  activeDocumentFontAliases = new Set();
}
