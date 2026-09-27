/**
 * 사용자 PC 글꼴 연결 (데스크톱 앱·브라우저 공용).
 *
 * 글꼴 색인 host에서 문서 글꼴과 같은 face를 찾아 이번 세션 FontFace(글리프)와 엔진 런타임
 * 메트릭(레이아웃)으로 등록한다. host는 두 가지다.
 *   - desktop: Electron preload 색인 (시스템·사용자·한컴 오피스 번들 전체)
 *   - browser-folder: 사용자가 연결한 글꼴 폴더 (font-folder.ts)
 * 글꼴 파일은 배포하지 않고 사용자 PC에 이미 있는 파일만 읽는다. 브라우저의 queryLocalFonts
 * 감지 결과는 글리프를 브라우저가 직접 그리므로 레이아웃 메트릭만 등록한다.
 *
 * 매칭 우선순위 (먼저 맞는 단계에서 멈춘다):
 *   1. PostScript 이름 정확 일치
 *   2. full name 정확 일치
 *   3. family / typographic family / 한글 이름 정확 일치
 *   4. 한컴 FontList.lst 이름 → 파일 → face
 *   5. 정규화 일치 (대소문자·공백·하이픈 무시, " Bold" 같은 RIBBI 스타일 접미사 제거)
 *   6. 같은 글꼴의 한/영 이름 별칭표 (근사 대체는 넣지 않는다)
 * 다른 family로의 근사 매칭은 하지 않는다.
 *
 * 같은 이름이 여러 파일에 있으면 한컴 번들 > 사용자 설치 > 시스템 순으로 고른다. 한컴 번들
 * 사본이 한컴 오피스가 실제로 그리고 재는 판본이라 조판 동등성에 가장 가깝다.
 */
import {
  LOCAL_FONT_BYTE_READ_CONCURRENCY,
  LOCAL_FONT_MAX_FACES_PER_DOCUMENT,
  addSessionLocalFontAliases,
  getDetectedLocalFontRecords,
  getLocalFontState,
  getSessionLocalFontFace,
  getSessionLocalFontRecords,
  importedFontSlant,
  importedFontWeight,
  localFontFaceKey,
  queryLocalFontAccessPermission,
  readLocalFontAccessBytes,
  readSessionLocalFontBytes,
  registerLocalFontFace,
  resolveSessionLocalFont,
  setDesktopFontByteReader,
  type LocalFontFaceNames,
  type LocalFontRecord,
} from './local-fonts.ts';

// ─── preload 계약 ─────────────────────────────────────────────

export type SystemFontSource = 'system' | 'user' | 'hancom';
export type SystemFontFormat = 'ttf' | 'otf' | 'ttc' | 'otc' | 'hft';

export interface SystemFontFace {
  id: string;
  path: string;
  faceIndex: number;
  format: SystemFontFormat;
  source: SystemFontSource;
  size: number;
  families: string[];
  fullNames: string[];
  postscriptNames: string[];
  styles: string[];
  typographicFamilies: string[];
  typographicStyles: string[];
  koreanNames: string[];
  weight: number;
  italic: boolean;
  bold: boolean;
  hangul: boolean;
  latin: boolean;
}

export interface SystemFontIndex {
  version: 1;
  platform: string;
  scannedAt: string;
  durationMs: number;
  fromCache: boolean;
  roots: Array<{ path: string; kind: SystemFontSource; exists: boolean; fileCount: number; error?: string }>;
  faces: SystemFontFace[];
  hancomFaceMap: Array<{ name: string; file: string; script: string; faceId: string | null }>;
  errors: Array<{ path: string; message: string }>;
}

export interface DesktopFontHostApi {
  listSystemFonts?: (options?: { refresh?: boolean }) => Promise<SystemFontIndex>;
  readSystemFont?: (id: string) => Promise<Uint8Array>;
}

export type SystemFontHostKind = 'desktop' | 'browser-folder' | 'hub' | 'combined';
export type FontReportHost = SystemFontHostKind | 'local-font-access';

/** 글꼴 색인과 face 바이트를 제공하는 쪽. face 바이트는 JS에 남기지 않고 필요할 때 다시 읽는다. */
export interface SystemFontHost {
  kind: SystemFontHostKind;
  /** 색인이 설치 글꼴 전체를 다루는지. 그렇다면 브라우저 로컬 글꼴 감지를 묻지 않는다. */
  coversSystem: boolean;
  list(options?: { refresh?: boolean }): Promise<SystemFontIndex>;
  /** TTC face는 단독 SFNT로 돌려준다. 파일이 바뀌었으면 'stale' 오류를 던진다. */
  read(id: string): Promise<Uint8Array | ArrayBuffer>;
}

/** wasm 런타임 메트릭 등록 API. 오래된 wasm 빌드에는 없을 수 있다. */
export interface RuntimeFontMetricsApi {
  register(bytes: Uint8Array, aliasesJson: string, bold: boolean, italic: boolean): string;
  clear?(): void;
  report?(): string;
  /** 엔진 내장 메트릭 보유 여부. 노출되면 layoutMetrics 판정에 쓴다. */
  hasBaked?(name: string, bold: boolean, italic: boolean): boolean;
}

// ─── 보고서 ───────────────────────────────────────────────────

export type DesktopFontMatchKind = 'postscript' | 'full-name' | 'family' | 'hancom-map' | 'normalized' | 'alias';
export type DesktopFontSlot = 'regular' | 'bold' | 'italic' | 'bold-italic';
export type DesktopFontItemStatus = 'loaded' | 'already-available' | 'missing' | 'failed' | 'unsupported-hft';
/** unknown: 등록하지 않았고 엔진이 내장 메트릭 여부를 알려 주지 않는 경우 */
export type DesktopFontLayoutMetrics = 'baked' | 'runtime' | 'heuristic' | 'unknown';

export interface DesktopFontFaceReport {
  slot: DesktopFontSlot;
  id: string;
  file: string;
  source: SystemFontSource | 'local';
  format: SystemFontFormat | 'local';
  status: 'loaded' | 'already-registered' | 'failed' | 'unsupported-hft' | 'skipped';
  bytes: number;
  runtimeFamily?: string;
  metrics?: 'registered' | 'rejected' | 'unavailable';
  metricsDetail?: unknown;
  error?: string;
}

export interface DesktopFontReportItem {
  requested: string;
  status: DesktopFontItemStatus;
  matchedBy?: DesktopFontMatchKind;
  matchedName?: string;
  face?: {
    displayName: string;
    family: string;
    file: string;
    source: SystemFontSource | 'imported' | 'local';
    format: SystemFontFormat | 'imported' | 'local';
    stylesLoaded: DesktopFontSlot[];
    faces: DesktopFontFaceReport[];
  };
  layoutMetrics: DesktopFontLayoutMetrics;
  runtimeMetricHits?: number;
  bytes: number;
  ms: number;
  error?: string;
}

export interface DesktopFontReport {
  host: FontReportHost;
  available: boolean;
  platform: string | null;
  indexStats: {
    faces: number;
    roots: SystemFontIndex['roots'];
    durationMs: number;
    fromCache: boolean;
    scannedAt: string | null;
    hancomMapEntries: number;
    errors: number;
  } | null;
  items: DesktopFontReportItem[];
  totals: {
    requested: number;
    loaded: number;
    alreadyAvailable: number;
    missing: number;
    failed: number;
    unsupportedHft: number;
    facesRegistered: number;
    metricsRegistered: number;
    bytes: number;
  };
  timings: { indexMs: number; matchMs: number; loadMs: number; totalMs: number };
  metricsApi: boolean;
  error?: string;
  finalized: boolean;
}

// ─── 이름 정규화와 별칭 ────────────────────────────────────────

const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);
const HANGUL_RE = /[ᄀ-ᇿ㄰-㆏가-힣]/;
const SOURCE_RANK: Record<SystemFontSource, number> = { hancom: 0, user: 1, system: 2 };
const SLOT_ORDER: DesktopFontSlot[] = ['regular', 'bold', 'italic', 'bold-italic'];
const SLOT_STYLE: Record<DesktopFontSlot, string> = {
  regular: 'Regular',
  bold: 'Bold',
  italic: 'Italic',
  'bold-italic': 'Bold Italic',
};
/** 이 접미사는 같은 family 안의 RIBBI 스타일만 가리킨다. Medium·Black 같은 굵기는 별도 family다. */
const RIBBI_SUFFIX_RE = /[\s_-]+(regular|normal|roman|bold|italic|oblique|bold\s*italic|bold\s*oblique|보통|굵게|기울임|굵은\s*기울임)$/iu;

export function exactFontKey(value: string): string {
  return value.replace(/\u0000/g, '').normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
}

export function looseFontKey(value: string): string {
  return exactFontKey(value).replace(/[\s\-_.]+/g, '');
}

/**
 * 같은 face의 한글 이름과 영문 이름. rhwp 메트릭 별칭표(font_metrics_data.rs
 * resolve_metric_alias) 중 동일 글꼴 쌍만 옮겼다. 본한글→Pretendard 같은 근사 대체는 제외한다.
 */
const SAME_FACE_ALIAS_GROUPS: ReadonlyArray<readonly string[]> = [
  ['함초롬돋움', 'HCR Dotum', 'HCRDotum'],
  ['함초롬바탕', 'HCR Batang', 'HCRBatang'],
  ['한컴돋움', 'Haansoft Dotum', 'HaansoftDotum'],
  ['한컴바탕', 'Haansoft Batang', 'HaansoftBatang'],
  ['돋움', 'Dotum'],
  ['돋움체', 'DotumChe'],
  ['바탕', 'Batang'],
  ['바탕체', 'BatangChe'],
  ['굴림', 'Gulim'],
  ['굴림체', 'GulimChe'],
  ['궁서', 'Gungsuh'],
  ['궁서체', 'GungsuhChe'],
  ['새굴림', 'New Gulim', 'NewGulim'],
  ['맑은 고딕', 'Malgun Gothic', 'MalgunGothic'],
  ['나눔고딕', 'NanumGothic', 'Nanum Gothic'],
  ['나눔명조', 'NanumMyeongjo', 'Nanum Myeongjo'],
  ['나눔바른고딕', 'NanumBarunGothic', 'Nanum Barun Gothic'],
  ['D2Coding', 'D2 Coding'],
  ['고운바탕', 'Gowun Batang'],
  ['고운돋움', 'Gowun Dodum'],
  ['프리텐다드', 'Pretendard'],
  ['HY중고딕', 'HYGothic-Medium', 'HYGothic Medium'],
  ['HY견고딕', 'HYGothic-Extra', 'HYGothic Extra'],
  ['HY헤드라인M', 'HYHeadLine-Medium', 'HYHeadLine Medium'],
  ['HY견명조', 'HYMyeongJo-Extra', 'HYMyeongJo Extra'],
  ['HY신명조', 'HYSinMyeongJo-Medium', 'HYSinMyeongJo Medium'],
  ['HY그래픽', 'HYGraphic-Medium', 'HYGraphic Medium'],
  ['HY궁서', 'HYGungSo-Bold', 'HYGungSo Bold'],
  ['HY강B', 'HYkanB'],
  ['HY수평선B', 'HYsupB'],
  ['HY수평선M', 'HYsupM'],
  ['HY울릉도B', 'HYwulB'],
  ['HY울릉도M', 'HYwulM'],
  ['HY태백B', 'HYtbrB'],
  ['HY동녘B', 'HYdnkB'],
  ['HY동녘M', 'HYdnkM'],
  ['문체부 돋음체', 'MDotum'],
  ['한양신명조', 'HanyangSinMyeongJo'],
  ['한양중고딕', 'HanyangJungGothic'],
  ['한양견명조', 'HanyangKyunMyeongJo'],
  ['한양견고딕', 'HanyangKyunGothic'],
  ['휴먼명조', 'HumanMyeongJo'],
  ['Apple SD 산돌고딕 Neo', 'Apple SD Gothic Neo', 'AppleSDGothicNeo'],
  ['애플명조', 'AppleMyungjo'],
];

const SAME_FACE_ALIASES: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const group of SAME_FACE_ALIAS_GROUPS) {
    for (const name of group) {
      const key = exactFontKey(name);
      const others = group.filter(other => exactFontKey(other) !== key);
      map.set(key, [...(map.get(key) ?? []), ...others]);
    }
  }
  return map;
})();

// ─── 색인 조회 ─────────────────────────────────────────────────

export interface DesktopFontLookup {
  index: SystemFontIndex;
  byId: Map<string, SystemFontFace>;
  postscript: Map<string, SystemFontFace[]>;
  fullName: Map<string, SystemFontFace[]>;
  family: Map<string, SystemFontFace[]>;
  legacyFamily: Map<string, SystemFontFace[]>;
  loosePostscript: Map<string, SystemFontFace[]>;
  looseFullName: Map<string, SystemFontFace[]>;
  looseFamily: Map<string, SystemFontFace[]>;
  hancom: Map<string, SystemFontIndex['hancomFaceMap']>;
}

function pushIndex<T>(map: Map<string, T[]>, key: string, value: T): void {
  if (!key) return;
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
}

function familyLevelNames(face: SystemFontFace): string[] {
  return [...face.families, ...face.typographicFamilies, ...face.koreanNames];
}

export function buildDesktopFontLookup(index: SystemFontIndex): DesktopFontLookup {
  const lookup: DesktopFontLookup = {
    index,
    byId: new Map(),
    postscript: new Map(),
    fullName: new Map(),
    family: new Map(),
    legacyFamily: new Map(),
    loosePostscript: new Map(),
    looseFullName: new Map(),
    looseFamily: new Map(),
    hancom: new Map(),
  };
  for (const raw of Array.isArray(index.faces) ? index.faces : []) {
    if (!raw || typeof raw.id !== 'string') continue;
    const face: SystemFontFace = {
      ...raw,
      families: stringList(raw.families),
      fullNames: stringList(raw.fullNames),
      postscriptNames: stringList(raw.postscriptNames),
      styles: stringList(raw.styles),
      typographicFamilies: stringList(raw.typographicFamilies),
      typographicStyles: stringList(raw.typographicStyles),
      koreanNames: stringList(raw.koreanNames),
      weight: Number.isFinite(raw.weight) ? raw.weight : 400,
    };
    lookup.byId.set(face.id, face);
    for (const name of face.postscriptNames) {
      pushIndex(lookup.postscript, exactFontKey(name), face);
      pushIndex(lookup.loosePostscript, looseFontKey(name), face);
    }
    for (const name of face.fullNames) {
      pushIndex(lookup.fullName, exactFontKey(name), face);
      pushIndex(lookup.looseFullName, looseFontKey(name), face);
    }
    for (const name of face.families) pushIndex(lookup.legacyFamily, exactFontKey(name), face);
    for (const name of familyLevelNames(face)) {
      pushIndex(lookup.family, exactFontKey(name), face);
      pushIndex(lookup.looseFamily, looseFontKey(name), face);
    }
  }
  for (const entry of Array.isArray(index.hancomFaceMap) ? index.hancomFaceMap : []) {
    if (!entry || typeof entry.name !== 'string') continue;
    pushIndex(lookup.hancom, exactFontKey(entry.name), entry);
  }
  return lookup;
}

// ─── 매칭 ─────────────────────────────────────────────────────

export interface DesktopFontSlotFace {
  slot: DesktopFontSlot;
  face: SystemFontFace;
}

export interface DesktopFontMatch {
  requested: string;
  matchedBy: DesktopFontMatchKind;
  /** 색인 쪽에서 실제로 일치한 이름 (별칭 매칭이면 별칭) */
  matchedName: string;
  anchor: SystemFontFace;
  /** 같은 키를 가진 매칭은 face와 runtime CSS family를 공유한다. */
  groupKey: string;
  family: string;
  /** 이름으로 지목된 단일 face (예: "Malgun Gothic Bold"). regular로 등록한다. */
  single: boolean;
  slots: DesktopFontSlotFace[];
}

export interface DesktopFontMiss {
  requested: string;
  reason: string;
}

type NameSpecificity = 'face' | 'family';

interface Candidates {
  kind: DesktopFontMatchKind;
  specificity: NameSpecificity;
  faces: SystemFontFace[];
  name: string;
}

function isBoldFace(face: SystemFontFace): boolean {
  return face.bold || face.weight >= 600;
}

function faceSlot(face: SystemFontFace): DesktopFontSlot {
  const bold = isBoldFace(face);
  if (face.italic) return bold ? 'bold-italic' : 'italic';
  return bold ? 'bold' : 'regular';
}

function formatRank(face: SystemFontFace): number {
  return face.format === 'hft' ? 1 : 0;
}

function compareKeys(left: ReadonlyArray<number | string>, right: ReadonlyArray<number | string>): number {
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] === right[i]) continue;
    return left[i]! < right[i]! ? -1 : 1;
  }
  return 0;
}

/**
 * 같은 이름의 후보 중 하나를 고른다. anchor가 있으면 anchor 자신과 같은 출처를 먼저,
 * 그다음 한컴 > 사용자 > 시스템, TTF/OTF > HFT, 목표 굵기에 가까운 순이다.
 */
function faceRank(face: SystemFontFace, targetWeight: number | null, anchor?: SystemFontFace): Array<number | string> {
  return [
    anchor ? (face === anchor ? 0 : 1) : 0,
    anchor ? (face.source === anchor.source ? 0 : 1) : 0,
    SOURCE_RANK[face.source] ?? 3,
    formatRank(face),
    targetWeight === null ? 0 : (face.italic ? 1 : 0),
    targetWeight === null ? 0 : Math.abs(face.weight - targetWeight),
    face.path,
    face.faceIndex,
  ];
}

function bestFace(
  faces: readonly SystemFontFace[],
  targetWeight: number | null,
  anchor?: SystemFontFace,
): SystemFontFace | undefined {
  return [...faces].sort((a, b) => compareKeys(faceRank(a, targetWeight, anchor), faceRank(b, targetWeight, anchor)))[0];
}

function exactCandidates(name: string, lookup: DesktopFontLookup): Candidates | null {
  const key = exactFontKey(name);
  if (!key) return null;
  const postscript = lookup.postscript.get(key);
  if (postscript?.length) return { kind: 'postscript', specificity: 'face', faces: postscript, name };
  const fullName = lookup.fullName.get(key);
  if (fullName?.length) {
    // "맑은 고딕"처럼 full name과 family가 같은 regular face는 family 매칭으로 다룬다.
    const familyToo = lookup.family.get(key);
    return familyToo?.length
      ? { kind: 'family', specificity: 'family', faces: familyToo, name }
      : { kind: 'full-name', specificity: 'face', faces: fullName, name };
  }
  const family = lookup.family.get(key);
  if (family?.length) return { kind: 'family', specificity: 'family', faces: family, name };
  return null;
}

function hancomCandidates(name: string, lookup: DesktopFontLookup): Candidates | null {
  const entries = lookup.hancom.get(exactFontKey(name)) ?? [];
  const faces = entries
    .map(entry => (entry.faceId ? lookup.byId.get(entry.faceId) : undefined))
    .filter((face): face is SystemFontFace => !!face);
  return faces.length ? { kind: 'hancom-map', specificity: 'family', faces, name } : null;
}

function looseCandidates(name: string, lookup: DesktopFontLookup): Candidates | null {
  const key = looseFontKey(name);
  if (key) {
    const postscript = lookup.loosePostscript.get(key);
    if (postscript?.length) return { kind: 'normalized', specificity: 'face', faces: postscript, name };
    const family = lookup.looseFamily.get(key);
    if (family?.length) return { kind: 'normalized', specificity: 'family', faces: family, name };
    const fullName = lookup.looseFullName.get(key);
    if (fullName?.length) return { kind: 'normalized', specificity: 'face', faces: fullName, name };
  }
  const stripped = name.replace(RIBBI_SUFFIX_RE, '').trim();
  if (stripped && stripped !== name.trim()) {
    const family = lookup.family.get(exactFontKey(stripped)) ?? lookup.looseFamily.get(looseFontKey(stripped));
    if (family?.length) return { kind: 'normalized', specificity: 'family', faces: family, name: stripped };
  }
  return null;
}

function findCandidates(requested: string, lookup: DesktopFontLookup): Candidates | null {
  const direct = exactCandidates(requested, lookup)
    ?? hancomCandidates(requested, lookup)
    ?? looseCandidates(requested, lookup);
  if (direct) return direct;
  for (const alias of SAME_FACE_ALIASES.get(exactFontKey(requested)) ?? []) {
    const viaAlias = exactCandidates(alias, lookup) ?? hancomCandidates(alias, lookup) ?? looseCandidates(alias, lookup);
    if (viaAlias) return { ...viaAlias, kind: 'alias' };
  }
  return null;
}

function canonicalFamily(face: SystemFontFace): string {
  return face.families.find(name => !HANGUL_RE.test(name))
    ?? face.families[0]
    ?? face.typographicFamilies[0]
    ?? face.fullNames.find(name => !HANGUL_RE.test(name))
    ?? face.fullNames[0]
    ?? face.postscriptNames[0]
    ?? face.id;
}

function canonicalFaceName(face: SystemFontFace): string {
  return face.fullNames.find(name => !HANGUL_RE.test(name))
    ?? face.fullNames[0]
    ?? face.postscriptNames[0]
    ?? canonicalFamily(face);
}

/** anchor와 legacy family(nameID 1)를 공유하는 face. Windows GDI의 RIBBI style-link 단위다. */
function ribbiGroup(anchor: SystemFontFace, lookup: DesktopFontLookup): SystemFontFace[] {
  const group = new Set<SystemFontFace>([anchor]);
  for (const name of anchor.families) {
    for (const face of lookup.legacyFamily.get(exactFontKey(name)) ?? []) group.add(face);
  }
  return Array.from(group);
}

function assignSlots(group: readonly SystemFontFace[], anchor: SystemFontFace): DesktopFontSlotFace[] {
  const slots: DesktopFontSlotFace[] = [];
  for (const slot of SLOT_ORDER) {
    const target = slot === 'bold' || slot === 'bold-italic' ? 700 : 400;
    const face = bestFace(group.filter(candidate => faceSlot(candidate) === slot), target, anchor);
    if (face) slots.push({ slot, face });
  }
  // 굵게 플래그만 있는 단독 face("HY견고딕" 등)는 문서의 보통 글자에 쓰이므로 regular로 올린다.
  if (!slots.some(entry => entry.slot === 'regular')) {
    const promoted = slots.find(entry => entry.face === anchor) ?? slots[0];
    if (promoted) {
      slots.splice(slots.indexOf(promoted), 1);
      slots.unshift({ slot: 'regular', face: promoted.face });
    }
  }
  return slots;
}

/** 문서 글꼴명 하나를 색인 face 집합으로 연결한다. 맞는 face가 없으면 miss를 돌려준다. */
export function matchDesktopFont(requested: string, lookup: DesktopFontLookup): DesktopFontMatch | DesktopFontMiss {
  const name = requested.trim();
  if (!name || GENERIC_FONTS.has(name.toLowerCase())) return { requested, reason: 'generic' };
  const candidates = findCandidates(name, lookup);
  if (!candidates) {
    const hancom = lookup.hancom.get(exactFontKey(name));
    return {
      requested,
      reason: hancom?.length ? `hancom-map-unresolved:${hancom.map(entry => entry.file).join(',')}` : 'not-found',
    };
  }
  const anchor = bestFace(candidates.faces, candidates.specificity === 'family' ? 400 : null)!;
  const group = ribbiGroup(anchor, lookup);
  const slots = assignSlots(group, anchor);
  const anchorSlot = slots.find(entry => entry.face === anchor)?.slot;
  const single = candidates.specificity === 'face' && anchorSlot !== 'regular';
  if (single) {
    return {
      requested,
      matchedBy: candidates.kind,
      matchedName: candidates.name,
      anchor,
      groupKey: `face:${anchor.id}`,
      family: canonicalFaceName(anchor),
      single: true,
      slots: [{ slot: 'regular', face: anchor }],
    };
  }
  const family = canonicalFamily(slots[0]?.face ?? anchor);
  return {
    requested,
    matchedBy: candidates.kind,
    matchedName: candidates.name,
    anchor,
    groupKey: `family:${exactFontKey(family)}`,
    family,
    single: false,
    slots,
  };
}

export function isDesktopFontMatch(value: DesktopFontMatch | DesktopFontMiss): value is DesktopFontMatch {
  return 'anchor' in value;
}

// ─── 세션 상태 ─────────────────────────────────────────────────

interface DesktopFontsConfig {
  host?: DesktopFontHostApi | null;
  metrics?: RuntimeFontMetricsApi | null;
  /** 백그라운드에서 새 face가 등록됐을 때 (지연 완료·reload·문서 편집 뒤) */
  onLateRegistration?: (report: DesktopFontReport) => void;
}

let config: DesktopFontsConfig = {};
/** 브라우저 폴더 host. 설정되면 데스크톱 preload보다 먼저 쓴다 (둘이 같이 있을 일은 없다). */
let explicitHost: SystemFontHost | null = null;
/** 로컬 에이전트 허브 host. 데스크톱 preload와 글꼴 폴더가 없을 때만 쓴다. */
let hubHost: SystemFontHost | null = null;
let indexPromise: Promise<SystemFontIndex> | null = null;
let currentIndex: SystemFontIndex | null = null;
let currentLookup: DesktopFontLookup | null = null;
let lastReport: DesktopFontReport | null = null;
let lastLocalFontAccessReport: DesktopFontReport | null = null;
let lastRequested: string[] = [];
const attemptedFonts = new Set<string>();
/** faceKey → 런타임 메트릭에 등록한 별칭 */
const metricAliasesByFace = new Map<string, Set<string>>();
let registrationTail: Promise<unknown> = Promise.resolve();
/** face id → 진행 중인 파일 읽기. 동시에 도는 준비 호출이 같은 파일을 두 번 읽지 않게 한다. */
const inflightReads = new Map<string, Promise<ArrayBuffer>>();
/** 파일이 바뀐 face를 읽었으면 다음 준비 때 색인을 다시 만든다. */
let indexStale = false;

export function configureDesktopFonts(next: DesktopFontsConfig): void {
  config = { ...config, ...next };
  installByteReader();
  installDebugHandle();
}

/**
 * 브라우저 글꼴 폴더 host를 바꾼다. 색인 상태는 새 host 기준으로 다시 만들고, 이미 등록한
 * FontFace와 메트릭은 세션 동안 유지한다.
 */
export function setSystemFontHost(host: SystemFontHost | null): void {
  if (explicitHost === host) return;
  const before = getSystemFontHost();
  explicitHost = host;
  if (getSystemFontHost() !== before) resetHostState();
}

/**
 * 로컬 에이전트 허브가 내주는 글꼴 색인 host를 둔다. 폴더를 고르지 않은 브라우저가
 * 허브 PC의 설치 글꼴을 데스크톱처럼 쓴다. 데스크톱 preload나 글꼴 폴더가 있으면 그쪽이 먼저다.
 */
export function setHubFontHost(host: SystemFontHost | null): void {
  if (hubHost === host) return;
  const before = getSystemFontHost();
  hubHost = host;
  if (getSystemFontHost() !== before) resetHostState();
}

function resetHostState(): void {
  indexPromise = null;
  currentIndex = null;
  currentLookup = null;
  desktopMenuNames = null;
  indexStale = false;
  attemptedFonts.clear();
  inflightReads.clear();
  installByteReader();
  installDebugHandle();
}

/**
 * 지금 쓰는 글꼴 색인 host. 글꼴 폴더·데스크톱 preload·로컬 허브 중 있는 것을 모두 합친다.
 * 하나뿐이면 그 host를 그대로 쓰고, 여럿이면 색인을 합친 host를 돌려준다.
 */
export function getSystemFontHost(): SystemFontHost | null {
  const members: Array<[string, SystemFontHost]> = [];
  if (explicitHost) members.push(['f', explicitHost]);
  const api = desktopHost();
  if (typeof api?.listSystemFonts === 'function' && typeof api.readSystemFont === 'function') {
    members.push(['d', desktopHostAdapter(api)]);
  }
  if (hubHost) members.push(['h', hubHost]);
  if (members.length <= 1) return members[0]?.[1] ?? null;
  return combinedHostFor(members);
}

let combinedHost: { members: Array<[string, SystemFontHost]>; host: SystemFontHost } | null = null;

/** 같은 구성이면 같은 host 객체를 돌려줘 색인 캐시가 유지되게 한다. */
function combinedHostFor(members: Array<[string, SystemFontHost]>): SystemFontHost {
  const same = combinedHost
    && combinedHost.members.length === members.length
    && combinedHost.members.every(([tag, host], index) => members[index]![0] === tag && members[index]![1] === host);
  if (same) return combinedHost!.host;
  const host = createCombinedFontHost(members);
  combinedHost = { members, host };
  return host;
}

/**
 * 여러 host의 색인을 합친다. face id는 host 표시를 앞에 붙여 겹치지 않게 하고, 읽을 때 떼어
 * 원래 host로 보낸다. 한 host가 실패해도 나머지 색인으로 계속한다. 같은 글꼴이 여러 곳에
 * 있으면 매칭 단계의 출처 순위(한컴 > 사용자 > 시스템)가 고른다.
 */
export function createCombinedFontHost(members: ReadonlyArray<readonly [string, SystemFontHost]>): SystemFontHost {
  const byTag = new Map(members.map(([tag, host]) => [tag, host]));
  const combined: SystemFontHost = {
    kind: 'combined',
    coversSystem: members.some(([, host]) => host.coversSystem),
    async list(options) {
      const results = await Promise.allSettled(members.map(([, host]) => host.list(options)));
      const indexes: Array<[string, SystemFontIndex]> = [];
      const errors: SystemFontIndex['errors'] = [];
      results.forEach((result, position) => {
        const [tag, host] = members[position]!;
        if (result.status === 'fulfilled') indexes.push([tag, result.value]);
        else errors.push({ path: host.kind, message: errorText(result.reason) });
      });
      if (!indexes.length) throw new Error(errors.map(error => `${error.path}: ${error.message}`).join('; '));
      combined.coversSystem = members.some(([, host]) => host.coversSystem);
      const prefix = (tag: string, id: string) => `${tag}:${id}`;
      return {
        version: 1,
        platform: indexes[0]![1].platform,
        scannedAt: new Date().toISOString(),
        durationMs: Math.max(...indexes.map(([, index]) => index.durationMs ?? 0)),
        fromCache: indexes.every(([, index]) => index.fromCache),
        roots: indexes.flatMap(([, index]) => index.roots ?? []),
        faces: indexes.flatMap(([tag, index]) => index.faces.map(face => ({ ...face, id: prefix(tag, face.id) }))),
        hancomFaceMap: indexes.flatMap(([tag, index]) => (index.hancomFaceMap ?? []).map(entry => ({
          ...entry,
          faceId: entry.faceId ? prefix(tag, entry.faceId) : null,
        }))),
        errors: [...errors, ...indexes.flatMap(([, index]) => index.errors ?? [])],
      };
    },
    read(id) {
      const split = id.indexOf(':');
      const host = split > 0 ? byTag.get(id.slice(0, split)) : undefined;
      if (!host) return Promise.reject(new Error(`unknown font id ${id}`));
      return host.read(id.slice(split + 1));
    },
  };
  return combined;
}

const desktopAdapters = new WeakMap<DesktopFontHostApi, SystemFontHost>();

function desktopHostAdapter(api: DesktopFontHostApi): SystemFontHost {
  let adapter = desktopAdapters.get(api);
  if (!adapter) {
    adapter = {
      kind: 'desktop',
      coversSystem: true,
      list: (options) => api.listSystemFonts!(options?.refresh ? { refresh: true } : undefined),
      read: (id) => api.readSystemFont!(id),
    };
    desktopAdapters.set(api, adapter);
  }
  return adapter;
}

/** 등록된 face는 JS에 바이트를 남기지 않으므로 CanvasKit·메트릭 재등록은 host에서 다시 읽는다. */
function installByteReader(): void {
  const host = getSystemFontHost();
  setDesktopFontByteReader(host ? (faceId) => host.read(faceId) : null);
}

function readDesktopFace(host: SystemFontHost, faceId: string): Promise<ArrayBuffer> {
  const pending = inflightReads.get(faceId);
  if (pending) return pending;
  const read = Promise.resolve().then(() => host.read(faceId)).then(toArrayBuffer);
  inflightReads.set(faceId, read);
  void read.then(
    () => inflightReads.delete(faceId),
    () => inflightReads.delete(faceId),
  );
  return read;
}

function desktopHost(): DesktopFontHostApi | null {
  if (config.host !== undefined) return config.host;
  return (globalThis as { rhwpDesktop?: DesktopFontHostApi }).rhwpDesktop ?? null;
}

/** 데스크톱 preload가 글꼴 색인 API를 제공하는지 */
export function isDesktopFontsSupported(): boolean {
  const host = desktopHost();
  return typeof host?.listSystemFonts === 'function' && typeof host.readSystemFont === 'function';
}

/** 데스크톱 색인이나 연결된 글꼴 폴더가 있는지 */
export function hasSystemFontHost(): boolean {
  return getSystemFontHost() !== null;
}

/** 지금 host의 색인을 한 번 이상 받았는지 */
export function isDesktopFontIndexReady(): boolean {
  return currentIndex !== null;
}

/** 설치 글꼴 전체를 다루는 색인(데스크톱)을 받았는지. 받았다면 로컬 글꼴 감지 권한을 묻지 않는다. */
export function isSystemFontIndexComplete(): boolean {
  return currentIndex !== null && getSystemFontHost()?.coversSystem === true;
}

export function getDesktopFontIndex(): SystemFontIndex | null {
  return currentIndex;
}

export function getLastDesktopFontReport(): DesktopFontReport | null {
  return lastReport;
}

/** 세션당 한 번 색인을 받는다. 실패하면 다음 호출에서 다시 시도한다. */
export function loadDesktopFontIndex(options: { refresh?: boolean } = {}): Promise<SystemFontIndex> {
  const host = getSystemFontHost();
  if (!host) return Promise.reject(new Error('system font index unavailable'));
  if (indexPromise && !options.refresh && !indexStale) return indexPromise;
  const refresh = options.refresh === true || indexStale;
  indexStale = false;
  const pending = host.list(refresh ? { refresh: true } : undefined).then((index) => {
    if (!index || !Array.isArray(index.faces)) throw new Error('invalid system font index');
    // 기다리는 동안 host가 바뀌었으면 이 결과는 버린다.
    if (getSystemFontHost() !== host) throw new Error('system font host changed');
    currentIndex = index;
    currentLookup = buildDesktopFontLookup(index);
    desktopMenuNames = null;
    const byRoot = (index.roots ?? []).map(root => `${root.kind}:${root.fileCount}${root.exists ? '' : '(없음)'}`).join(' ');
    console.info(
      `${logTag(host.kind)} 색인 ${index.faces.length}개 face · 한컴 목록 ${index.hancomFaceMap?.length ?? 0}개 · `
      + `${Math.round(index.durationMs)}ms${index.fromCache ? ' (캐시)' : ''} · ${byRoot}`
      + (index.errors?.length ? ` · 오류 ${index.errors.length}개` : ''),
    );
    return index;
  });
  indexPromise = pending;
  pending.catch(() => {
    if (indexPromise === pending) indexPromise = null;
  });
  return pending;
}

let desktopMenuNames: string[] | null = null;

/** 글꼴 메뉴용 family 이름. 바이트는 읽지 않고, 적용된 뒤 문서 글꼴로 연결된다. */
export function getDesktopFontMenuNames(): string[] {
  if (!currentIndex) return [];
  if (desktopMenuNames) return desktopMenuNames;
  const names = new Set<string>();
  for (const face of currentIndex.faces) {
    if (face.format === 'hft' || face.italic || isBoldFace(face)) continue;
    const name = face.families.find(family => HANGUL_RE.test(family)) ?? face.families[0];
    if (name && !name.startsWith('.')) names.add(name.trim());
  }
  desktopMenuNames = Array.from(names).sort((a, b) => a.localeCompare(b, 'ko'));
  return desktopMenuNames;
}

/** 다시 연결을 시도하도록 시도 기록을 지운다 (글꼴 감지를 다시 돌릴 때). */
export function forgetAttemptedFonts(fontNames: readonly string[] | undefined): void {
  for (const name of uniqueFontNames(fontNames)) attemptedFonts.delete(exactFontKey(name));
}

/** 이번 세션에서 아직 연결을 시도하지 않은 문서 글꼴 */
export function unattemptedDesktopFonts(fontNames: readonly string[] | undefined): string[] {
  return uniqueFontNames(fontNames).filter(name => !attemptedFonts.has(exactFontKey(name)));
}

function uniqueFontNames(fontNames: readonly string[] | undefined): string[] {
  const seen = new Map<string, string>();
  for (const raw of fontNames ?? []) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name || GENERIC_FONTS.has(name.toLowerCase())) continue;
    const key = exactFontKey(name);
    if (!seen.has(key)) seen.set(key, name);
  }
  return Array.from(seen.values());
}

// ─── 런타임 메트릭 ─────────────────────────────────────────────

function metricsApi(): RuntimeFontMetricsApi | null {
  return config.metrics ?? null;
}

interface MetricsRegistration {
  status: 'registered' | 'rejected' | 'unavailable' | 'unchanged';
  detail?: unknown;
}

/** 새로 등록해야 할 별칭 집합. 이미 같은 별칭으로 등록돼 있으면 null. */
function pendingMetricAliases(faceKey: string, aliases: readonly string[]): Set<string> | null {
  const known = metricAliasesByFace.get(faceKey);
  const merged = new Set(known ?? []);
  for (const alias of aliases) {
    const name = alias.trim();
    if (name && !/^rhwp-(desktop|imported)-\d+$/.test(name)) merged.add(name);
  }
  return known && merged.size === known.size ? null : merged;
}

function registerFaceMetrics(
  faceKey: string,
  bytes: ArrayBuffer,
  aliases: readonly string[],
  bold: boolean,
  italic: boolean,
): MetricsRegistration {
  const api = metricsApi();
  if (!api) return { status: 'unavailable' };
  const merged = pendingMetricAliases(faceKey, aliases);
  if (!merged) return { status: 'unchanged' };
  try {
    const raw = api.register(new Uint8Array(bytes), JSON.stringify(Array.from(merged)), bold, italic);
    const detail = safeJson(raw);
    const registered = !!(detail && typeof detail === 'object' && (detail as { registered?: unknown }).registered === true);
    if (registered) metricAliasesByFace.set(faceKey, merged);
    return { status: registered ? 'registered' : 'rejected', detail };
  } catch (error) {
    return { status: 'rejected', detail: errorText(error) };
  }
}

function safeJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordStyleFlags(record: LocalFontRecord): { bold: boolean; italic: boolean } {
  return {
    bold: Number(importedFontWeight(record.style)) >= 600,
    italic: importedFontSlant(record.style) === 'italic',
  };
}

/**
 * 사용자가 직접 가져온 글꼴 파일도 레이아웃 메트릭에 올린다.
 * @returns 새로 등록한 face 수
 */
export function syncImportedFontMetrics(): number {
  if (!metricsApi()) return 0;
  let registered = 0;
  for (const record of getSessionLocalFontRecords()) {
    if (record.source === 'desktop') continue;
    const faceKey = localFontFaceKey(record);
    const entry = getSessionLocalFontFace(faceKey);
    if (!entry?.bytes) continue;
    const { bold, italic } = recordStyleFlags(record);
    if (registerFaceMetrics(faceKey, entry.bytes, record.aliases, bold, italic).status === 'registered') registered += 1;
  }
  return registered;
}

function readRuntimeMetricReport(): Array<{ aliases: string[]; hits: number }> | null {
  const api = metricsApi();
  if (!api?.report) return null;
  try {
    const parsed = JSON.parse(api.report());
    if (!Array.isArray(parsed)) return null;
    return parsed.map(entry => ({
      aliases: stringList(entry?.aliases),
      hits: Number.isFinite(entry?.hits) ? Number(entry.hits) : 0,
    }));
  } catch {
    return null;
  }
}

// ─── 준비 ─────────────────────────────────────────────────────

interface FacePlanEntry extends DesktopFontSlotFace {
  names: LocalFontFaceNames;
  faceKey: string;
  report: DesktopFontFaceReport;
}

interface GroupPlan {
  match: DesktopFontMatch;
  requested: string[];
  faces: FacePlanEntry[];
  bytes: number;
  startedAt: number;
  finishedAt: number;
  runtimeFamily?: string;
}

function metricAliasesFor(plan: GroupPlan, entry: FacePlanEntry): string[] {
  const face = entry.face;
  if (plan.match.single) return [...plan.requested, ...face.fullNames, ...face.postscriptNames];
  // 엔진 레지스트리는 같은 스타일 슬롯에서 별칭이 겹치면 앞 등록을 교체한다. 그래서 여러 legacy
  // family가 공유하는 typographic family(nameID 16)와 한글 typographic 이름은 넣지 않는다.
  // 한글 legacy family 이름은 families에 이미 들어 있다.
  return [...plan.requested, ...face.families, ...face.fullNames, ...face.postscriptNames];
}

function faceNamesFor(plan: GroupPlan, slot: DesktopFontSlot, face: SystemFontFace): LocalFontFaceNames {
  const single = plan.match.single;
  const displayName = (single ? face.fullNames : face.families).find(name => HANGUL_RE.test(name))
    ?? (single ? canonicalFaceName(face) : plan.match.family);
  const aliases = single
    ? [...face.fullNames, ...face.postscriptNames]
    : [...face.families, ...face.fullNames, ...face.postscriptNames];
  return {
    family: plan.match.family,
    fullName: canonicalFaceName(face),
    // 단일 face 등록은 같은 파일의 family 그룹 등록과 faceKey가 겹치지 않도록 full name을 키로 쓴다.
    postscriptName: single ? '' : face.postscriptNames[0] ?? '',
    style: SLOT_STYLE[slot],
    displayName,
    aliases: [...aliases, ...plan.requested],
  };
}

function toArrayBuffer(bytes: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

async function runPool<T>(items: readonly T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

function serialRegistration<T>(task: () => Promise<T>): Promise<T> {
  const run = registrationTail.then(task, task);
  registrationTail = run.catch(() => undefined);
  return run;
}

function logTag(host: FontReportHost): string {
  return `[SystemFonts:${host}]`;
}

function emptyReport(host: FontReportHost, available: boolean, error?: string): DesktopFontReport {
  return {
    host,
    available,
    platform: null,
    indexStats: null,
    items: [],
    totals: {
      requested: 0, loaded: 0, alreadyAvailable: 0, missing: 0, failed: 0,
      unsupportedHft: 0, facesRegistered: 0, metricsRegistered: 0, bytes: 0,
    },
    timings: { indexMs: 0, matchMs: 0, loadMs: 0, totalMs: 0 },
    metricsApi: metricsApi() !== null,
    ...(error ? { error } : {}),
    finalized: false,
  };
}

export interface PrepareDesktopFontsOptions {
  onProgress?: (done: number, total: number) => void;
}

/**
 * 문서 글꼴을 데스크톱 글꼴 파일에 연결하고 FontFace와 런타임 메트릭으로 등록한다.
 * 새 face가 등록됐으면(`totals.facesRegistered > 0`) 호출자가 레이아웃을 새로 계산해야 한다.
 */
export async function prepareDesktopFontsForDocument(
  fontsUsed: readonly string[] | undefined,
  options: PrepareDesktopFontsOptions = {},
): Promise<DesktopFontReport> {
  const startedAt = now();
  const host = getSystemFontHost();
  if (!host) return emptyReport('desktop', false);
  installByteReader();
  const names = uniqueFontNames(fontsUsed);
  for (const name of names) attemptedFonts.add(exactFontKey(name));
  lastRequested = uniqueFontNames([...lastRequested, ...names]);

  let index: SystemFontIndex;
  try {
    index = await loadDesktopFontIndex();
  } catch (error) {
    // 색인을 못 받았으면 시도하지 않은 것으로 되돌려, host가 준비된 뒤(허브 연결 등) 다시 연결한다.
    for (const name of names) attemptedFonts.delete(exactFontKey(name));
    const report = emptyReport(host.kind, true, errorText(error));
    report.timings.totalMs = now() - startedAt;
    lastReport = report;
    console.warn(`${logTag(host.kind)} 글꼴 색인을 받지 못했습니다:`, error);
    return report;
  }
  const lookup = currentLookup ?? buildDesktopFontLookup(index);
  const indexedAt = now();

  const items = new Map<string, DesktopFontReportItem>();
  const plans = new Map<string, GroupPlan>();
  const planByName = new Map<string, GroupPlan>();
  for (const requested of names) {
    const sessionRecord = resolveSessionLocalFont(requested);
    if (sessionRecord && sessionRecord.source !== 'desktop') {
      items.set(requested, importedItem(requested, sessionRecord));
      continue;
    }
    const match = matchDesktopFont(requested, lookup);
    if (!isDesktopFontMatch(match)) {
      items.set(requested, {
        requested,
        status: 'missing',
        layoutMetrics: 'unknown',
        bytes: 0,
        ms: 0,
        ...(match.reason !== 'not-found' ? { error: match.reason } : {}),
      });
      continue;
    }
    let plan = plans.get(match.groupKey);
    if (!plan) {
      plan = { match, requested: [], faces: [], bytes: 0, startedAt: 0, finishedAt: 0 };
      plans.set(match.groupKey, plan);
    }
    plan.requested.push(requested);
    planByName.set(requested, plan);
  }
  for (const plan of plans.values()) {
    plan.faces = plan.match.slots.map(({ slot, face }) => {
      const names = faceNamesFor(plan, slot, face);
      return {
        slot,
        face,
        names,
        faceKey: localFontFaceKey(names),
        report: {
          slot,
          id: face.id,
          file: face.path,
          source: face.source,
          format: face.format,
          status: 'skipped',
          bytes: 0,
        },
      };
    });
  }
  const matchedAt = now();

  // regular을 먼저 채워 용량 한도에 걸려도 본문 글꼴이 우선 연결되게 한다. 읽기는 병렬이지만
  // 등록은 이 순서대로 해서 한도에 걸리는 쪽이 항상 덜 중요한 스타일이 된다.
  const jobs: Array<{ plan: GroupPlan; entry: FacePlanEntry; order: number }> = [];
  for (const slot of SLOT_ORDER) {
    for (const plan of plans.values()) {
      const entry = plan.faces.find(candidate => candidate.slot === slot);
      if (entry) jobs.push({ plan, entry, order: jobs.length });
    }
  }
  const turns = jobs.map(() => {
    let release: () => void = () => {};
    const done = new Promise<void>((resolve) => { release = resolve; });
    return { done, release };
  });
  let done = 0;
  let facesRegistered = 0;
  let metricsRegistered = 0;

  const reuseRegisteredFace = async (plan: GroupPlan, entry: FacePlanEntry, bold: boolean, italic: boolean): Promise<void> => {
    const existing = getSessionLocalFontFace(entry.faceKey)!;
    addSessionLocalFontAliases(entry.faceKey, plan.requested);
    entry.report.status = 'already-registered';
    entry.report.runtimeFamily = existing.record.runtimeFamily;
    plan.runtimeFamily ??= existing.record.runtimeFamily;
    const aliases = metricAliasesFor(plan, entry);
    if (!metricsApi()) {
      entry.report.metrics = 'unavailable';
      return;
    }
    if (!pendingMetricAliases(entry.faceKey, aliases)) {
      entry.report.metrics = 'registered';
      return;
    }
    // 별칭이 늘었을 때만 파일을 다시 읽어 메트릭을 재등록한다.
    const bytes = await readSessionLocalFontBytes(entry.faceKey);
    if (!bytes) {
      entry.report.metrics = 'rejected';
      entry.report.metricsDetail = 'reread-failed';
      return;
    }
    const metrics = registerFaceMetrics(entry.faceKey, bytes, aliases, bold, italic);
    if (metrics.status === 'registered') metricsRegistered += 1;
    entry.report.metrics = metrics.status === 'unchanged' ? 'registered' : metrics.status;
    if (metrics.detail !== undefined) entry.report.metricsDetail = metrics.detail;
  };

  await runPool(jobs, LOCAL_FONT_BYTE_READ_CONCURRENCY, async ({ plan, entry, order }) => {
    plan.startedAt ||= now();
    const bold = entry.slot === 'bold' || entry.slot === 'bold-italic';
    const italic = entry.slot === 'italic' || entry.slot === 'bold-italic';
    const isRegistered = () => getSessionLocalFontFace(entry.faceKey) !== null;
    try {
      let bytes: ArrayBuffer | null = null;
      let readError: unknown = null;
      if (!isRegistered()) {
        try {
          bytes = await readDesktopFace(host, entry.face.id);
        } catch (error) {
          readError = error;
        }
      }
      if (order > 0) await turns[order - 1]!.done;
      if (isRegistered()) {
        await reuseRegisteredFace(plan, entry, bold, italic);
        return;
      }
      if (readError || !bytes) throw readError ?? new Error('empty read');
      entry.report.bytes = bytes.byteLength;
      plan.bytes += bytes.byteLength;
      const source = bytes;
      const result = await serialRegistration(() => registerLocalFontFace(source, {
        source: 'desktop',
        fileName: fileName(entry.face.path),
        sourcePath: entry.face.path,
        desktopFaceId: entry.face.id,
        names: entry.names,
        extraAliases: plan.requested,
        runtimeFamilyKey: `desktop:${plan.match.groupKey}`,
      }));
      if (!result.ok) {
        entry.report.status = result.reason === 'unsupported-hft' ? 'unsupported-hft' : 'failed';
        entry.report.error = result.error ? `${result.reason}: ${result.error}` : result.reason;
        return;
      }
      if (result.reused) {
        plan.bytes -= entry.report.bytes;
        entry.report.bytes = 0;
        await reuseRegisteredFace(plan, entry, bold, italic);
        return;
      }
      facesRegistered += 1;
      entry.report.status = 'loaded';
      entry.report.runtimeFamily = result.record.runtimeFamily;
      plan.runtimeFamily ??= result.record.runtimeFamily;
      const metrics = registerFaceMetrics(
        localFontFaceKey(result.record),
        result.bytes,
        metricAliasesFor(plan, entry),
        bold,
        italic,
      );
      if (metrics.status === 'registered') metricsRegistered += 1;
      entry.report.metrics = metrics.status === 'unchanged' ? 'registered' : metrics.status;
      if (metrics.detail !== undefined) entry.report.metricsDetail = metrics.detail;
    } catch (error) {
      const message = errorText(error);
      entry.report.status = 'failed';
      entry.report.error = message;
      // 파일이 바뀌었으면 다음 요청에서 색인을 새로 받는다.
      if (/stale/i.test(message)) indexStale = true;
    } finally {
      turns[order]!.release();
      plan.finishedAt = now();
      done += 1;
      options.onProgress?.(done, jobs.length);
    }
  });
  const loadedAt = now();

  for (const requested of names) {
    if (items.has(requested)) continue;
    const plan = planByName.get(requested)!;
    items.set(requested, planItem(requested, plan));
  }
  const orderedItems = names.map(name => items.get(name)!);
  const report: DesktopFontReport = {
    host: host.kind,
    available: true,
    platform: index.platform ?? null,
    indexStats: {
      faces: index.faces.length,
      roots: index.roots,
      durationMs: index.durationMs,
      fromCache: index.fromCache,
      scannedAt: index.scannedAt ?? null,
      hancomMapEntries: index.hancomFaceMap?.length ?? 0,
      errors: index.errors?.length ?? 0,
    },
    items: orderedItems,
    totals: {
      requested: orderedItems.length,
      loaded: orderedItems.filter(item => item.status === 'loaded').length,
      alreadyAvailable: orderedItems.filter(item => item.status === 'already-available').length,
      missing: orderedItems.filter(item => item.status === 'missing').length,
      failed: orderedItems.filter(item => item.status === 'failed').length,
      unsupportedHft: orderedItems.filter(item => item.status === 'unsupported-hft').length,
      facesRegistered,
      metricsRegistered,
      bytes: Array.from(plans.values()).reduce((sum, plan) => sum + plan.bytes, 0),
    },
    timings: {
      indexMs: indexedAt - startedAt,
      matchMs: matchedAt - indexedAt,
      loadMs: loadedAt - matchedAt,
      totalMs: now() - startedAt,
    },
    metricsApi: metricsApi() !== null,
    finalized: false,
  };
  lastReport = report;
  installDebugHandle();
  return report;
}

// ─── 로컬 글꼴 감지(queryLocalFonts) 메트릭 ─────────────────────

interface LocalAccessSlot {
  slot: DesktopFontSlot;
  record: LocalFontRecord;
  faceKey: string;
  report: DesktopFontFaceReport;
}

interface LocalAccessPlan {
  anchor: LocalFontRecord;
  single: boolean;
  requested: string[];
  slots: LocalAccessSlot[];
  bytes: number;
}

function recordSlot(record: LocalFontRecord): DesktopFontSlot {
  const { bold, italic } = recordStyleFlags(record);
  if (italic) return bold ? 'bold-italic' : 'italic';
  return bold ? 'bold' : 'regular';
}

function recordSlots(anchor: LocalFontRecord, records: readonly LocalFontRecord[]): Array<{ slot: DesktopFontSlot; record: LocalFontRecord }> {
  const family = exactFontKey(anchor.family);
  const group = records.filter(record => exactFontKey(record.family) === family);
  if (!group.includes(anchor)) group.push(anchor);
  const slots: Array<{ slot: DesktopFontSlot; record: LocalFontRecord }> = [];
  for (const slot of SLOT_ORDER) {
    const target = slot === 'bold' || slot === 'bold-italic' ? 700 : 400;
    const record = group
      .filter(candidate => recordSlot(candidate) === slot)
      .sort((a, b) => (a === anchor ? -1 : b === anchor ? 1 : 0)
        || Math.abs(Number(importedFontWeight(a.style)) - target) - Math.abs(Number(importedFontWeight(b.style)) - target))[0];
    if (record) slots.push({ slot, record });
  }
  if (!slots.some(entry => entry.slot === 'regular')) {
    const promoted = slots.find(entry => entry.record === anchor) ?? slots[0];
    if (promoted) {
      slots.splice(slots.indexOf(promoted), 1);
      slots.unshift({ slot: 'regular', record: promoted.record });
    }
  }
  return slots;
}

/**
 * 감지 목록에서 문서 글꼴명의 face를 찾는다. PostScript·full name이 맞으면 그 face를,
 * family 이름이면 같은 family의 regular에 가까운 face를 고른다.
 */
function resolveDetectedRecord(
  requested: string,
  byName: ReadonlyMap<string, LocalFontRecord[]>,
): LocalFontRecord | null {
  const key = exactFontKey(requested);
  const matches = byName.get(key);
  if (!matches?.length) return null;
  const named = matches.find(record => exactFontKey(record.postscriptName) === key || exactFontKey(record.fullName) === key);
  if (named) return named;
  return [...matches].sort((a, b) => (recordSlot(a) === 'regular' ? 0 : 1) - (recordSlot(b) === 'regular' ? 0 : 1)
    || Math.abs(Number(importedFontWeight(a.style)) - 400) - Math.abs(Number(importedFontWeight(b.style)) - 400))[0] ?? null;
}

function localAccessAliases(plan: LocalAccessPlan, record: LocalFontRecord): string[] {
  const names = plan.single ? [record.fullName, record.postscriptName] : [record.family, record.fullName, record.postscriptName];
  return [...plan.requested, ...names];
}

function bakedMetrics(api: RuntimeFontMetricsApi, name: string): boolean {
  if (!api.hasBaked) return false;
  try {
    return api.hasBaked(name, false, false);
  } catch {
    return false;
  }
}

export interface PrepareLocalFontAccessOptions {
  /** 방금 사용자가 감지를 허용했으면 권한 조회를 건너뛴다. */
  assumeGranted?: boolean;
}

/**
 * 로컬 글꼴 감지(queryLocalFonts)로 찾은 설치 글꼴 중 문서가 쓰는 face의 레이아웃 메트릭을
 * 등록한다. 글리프는 브라우저가 이름으로 직접 그리므로 FontFace는 만들지 않고, 바이트는 등록
 * 뒤 바로 버린다. 권한이 이미 허용됐을 때만 읽어 문서 로드 중 권한 창을 띄우지 않는다.
 * 글꼴 폴더·데스크톱 색인·가져온 파일로 연결된 글꼴과 엔진 내장 메트릭이 있는 글꼴은 건너뛴다.
 * 등록할 대상이 없으면 null.
 */
export async function prepareLocalFontAccessMetrics(
  fontsUsed: readonly string[] | undefined,
  options: PrepareLocalFontAccessOptions = {},
): Promise<DesktopFontReport | null> {
  const startedAt = now();
  const api = metricsApi();
  if (!api || getLocalFontState().source !== 'local-font-access') return null;
  const detected = getDetectedLocalFontRecords();
  const byName = new Map<string, LocalFontRecord[]>();
  for (const record of detected) {
    for (const name of new Set([record.family, record.fullName, record.postscriptName, ...record.aliases].map(exactFontKey))) {
      if (name) pushIndex(byName, name, record);
    }
  }
  const plans = new Map<string, LocalAccessPlan>();
  const planByName = new Map<string, LocalAccessPlan>();
  for (const requested of uniqueFontNames(fontsUsed)) {
    if (resolveSessionLocalFont(requested)) continue;
    const anchor = resolveDetectedRecord(requested, byName);
    if (!anchor || !anchor.postscriptName || bakedMetrics(api, requested)) continue;
    const key = exactFontKey(requested);
    const namesFace = [anchor.fullName, anchor.postscriptName].some(name => exactFontKey(name) === key)
      && exactFontKey(anchor.family) !== key;
    const single = namesFace && recordSlot(anchor) !== 'regular';
    const groupKey = single ? `face:${localFontFaceKey(anchor)}` : `family:${exactFontKey(anchor.family)}`;
    let plan = plans.get(groupKey);
    if (!plan) {
      const slots = single ? [{ slot: 'regular' as const, record: anchor }] : recordSlots(anchor, detected);
      plan = {
        anchor,
        single,
        requested: [],
        bytes: 0,
        slots: slots.map(({ slot, record }) => ({
          slot,
          record,
          faceKey: `local:${groupKey}:${localFontFaceKey(record)}`,
          report: {
            slot,
            id: record.postscriptName,
            file: record.postscriptName,
            source: 'local',
            format: 'local',
            status: 'skipped',
            bytes: 0,
          },
        })),
      };
      plans.set(groupKey, plan);
    }
    plan.requested.push(requested);
    planByName.set(requested, plan);
  }
  if (plans.size === 0) return null;

  const toRead = new Map<string, LocalFontRecord>();
  for (const plan of plans.values()) {
    for (const entry of plan.slots) {
      if (!pendingMetricAliases(entry.faceKey, localAccessAliases(plan, entry.record))) {
        entry.report.status = 'already-registered';
        entry.report.metrics = 'registered';
      } else if (toRead.size < LOCAL_FONT_MAX_FACES_PER_DOCUMENT) {
        toRead.set(exactFontKey(entry.record.postscriptName), entry.record);
      }
    }
  }
  if (toRead.size > 0 && !options.assumeGranted && await queryLocalFontAccessPermission() !== 'granted') return null;
  const matchedAt = now();
  const bytesByName = toRead.size > 0 ? await readLocalFontAccessBytes(Array.from(toRead.values())) : new Map<string, ArrayBuffer>();
  let metricsRegistered = 0;
  for (const plan of plans.values()) {
    for (const entry of plan.slots) {
      if (entry.report.status === 'already-registered') continue;
      const bytes = bytesByName.get(exactFontKey(entry.record.postscriptName));
      if (!bytes) {
        entry.report.status = 'failed';
        entry.report.error = 'read-failed';
        continue;
      }
      entry.report.bytes = bytes.byteLength;
      plan.bytes += bytes.byteLength;
      const bold = entry.slot === 'bold' || entry.slot === 'bold-italic';
      const italic = entry.slot === 'italic' || entry.slot === 'bold-italic';
      const metrics = registerFaceMetrics(entry.faceKey, bytes, localAccessAliases(plan, entry.record), bold, italic);
      if (metrics.status === 'registered') metricsRegistered += 1;
      entry.report.status = metrics.status === 'rejected' ? 'failed' : 'loaded';
      entry.report.metrics = metrics.status === 'unchanged' ? 'registered' : metrics.status;
      if (metrics.detail !== undefined) entry.report.metricsDetail = metrics.detail;
    }
  }
  const loadedAt = now();

  const items: DesktopFontReportItem[] = Array.from(planByName, ([requested, plan]) => {
    const faces = plan.slots.map(entry => entry.report);
    const ok = faces.filter(face => face.status === 'loaded' || face.status === 'already-registered');
    return {
      requested,
      status: ok.some(face => face.status === 'loaded') ? 'loaded' : ok.length ? 'already-available' : 'failed',
      matchedBy: 'family',
      matchedName: plan.single ? plan.anchor.fullName : plan.anchor.family,
      face: {
        displayName: plan.anchor.displayName,
        family: plan.anchor.family,
        file: plan.anchor.postscriptName,
        source: 'local',
        format: 'local',
        stylesLoaded: ok.map(face => face.slot),
        faces,
      },
      layoutMetrics: ok.some(face => face.metrics === 'registered') ? 'runtime' : 'unknown',
      bytes: plan.bytes,
      ms: 0,
    };
  });
  const report: DesktopFontReport = {
    host: 'local-font-access',
    available: true,
    platform: null,
    indexStats: null,
    items,
    totals: {
      requested: items.length,
      loaded: items.filter(item => item.status === 'loaded').length,
      alreadyAvailable: items.filter(item => item.status === 'already-available').length,
      missing: 0,
      failed: items.filter(item => item.status === 'failed').length,
      unsupportedHft: 0,
      facesRegistered: 0,
      metricsRegistered,
      bytes: Array.from(plans.values()).reduce((sum, plan) => sum + plan.bytes, 0),
    },
    timings: { indexMs: 0, matchMs: matchedAt - startedAt, loadMs: loadedAt - matchedAt, totalMs: now() - startedAt },
    metricsApi: true,
    finalized: false,
  };
  lastLocalFontAccessReport = report;
  installDebugHandle();
  return report;
}

/**
 * 문서 글꼴을 연결할 수 있는 모든 출처에 연결한다. 글꼴 폴더·데스크톱 색인이 먼저이고,
 * 거기서 찾지 못한 글꼴만 로컬 글꼴 감지 결과로 메트릭을 등록한다.
 */
export async function prepareSystemFontsForDocument(
  fontsUsed: readonly string[] | undefined,
  options: PrepareDesktopFontsOptions = {},
): Promise<DesktopFontReport[]> {
  const reports: DesktopFontReport[] = [];
  if (hasSystemFontHost() && fontsUsed?.length) reports.push(await prepareDesktopFontsForDocument(fontsUsed, options));
  const local = await prepareLocalFontAccessMetrics(fontsUsed).catch((error) => {
    console.warn(`${logTag('local-font-access')} 메트릭 등록 실패:`, error);
    return null;
  });
  if (local) reports.push(local);
  return reports;
}

/** 새 face나 메트릭이 등록돼 레이아웃을 다시 계산해야 하는지 */
export function fontReportsChangedLayout(reports: ReadonlyArray<DesktopFontReport | null | undefined>): boolean {
  return reports.some(report => !!report && (report.totals.facesRegistered > 0 || report.totals.metricsRegistered > 0));
}

function importedItem(requested: string, record: LocalFontRecord): DesktopFontReportItem {
  const faceKey = localFontFaceKey(record);
  const registered = metricAliasesByFace.has(faceKey);
  return {
    requested,
    status: 'already-available',
    face: {
      displayName: record.displayName,
      family: record.family,
      file: record.sourcePath ?? '',
      source: 'imported',
      format: 'imported',
      stylesLoaded: [],
      faces: [],
    },
    layoutMetrics: registered ? 'runtime' : 'unknown',
    bytes: 0,
    ms: 0,
  };
}

function planItem(requested: string, plan: GroupPlan): DesktopFontReportItem {
  const faces = plan.faces.map(entry => entry.report);
  const ok = faces.filter(face => face.status === 'loaded' || face.status === 'already-registered');
  const status: DesktopFontItemStatus = ok.some(face => face.status === 'loaded')
    ? 'loaded'
    : ok.length > 0
      ? 'already-available'
      : faces.some(face => face.status === 'unsupported-hft') ? 'unsupported-hft' : 'failed';
  const anchor = plan.match.anchor;
  const firstError = faces.find(face => face.error)?.error;
  return {
    requested,
    status,
    matchedBy: plan.match.matchedBy,
    matchedName: plan.match.matchedName,
    face: {
      displayName: plan.match.single ? canonicalFaceName(anchor) : plan.match.family,
      family: plan.match.family,
      file: anchor.path,
      source: anchor.source,
      format: anchor.format,
      stylesLoaded: ok.map(face => face.slot),
      faces,
    },
    layoutMetrics: ok.some(face => face.metrics === 'registered') ? 'runtime' : 'unknown',
    bytes: plan.bytes,
    ms: Math.max(0, Math.round((plan.finishedAt || plan.startedAt) - plan.startedAt)),
    ...(status === 'failed' || status === 'unsupported-hft' ? { error: firstError } : {}),
  };
}

/**
 * 레이아웃을 다시 계산한 뒤 호출한다. 런타임 메트릭 hit 수로 엔진이 실제로 쓴 메트릭을
 * 추정하고 보고서를 콘솔에 남긴다. 등록했는데 hit가 0이면 엔진 내장 메트릭이 먼저 쓰였다고 본다.
 */
export function finalizeDesktopFontReport(report: DesktopFontReport): DesktopFontReport {
  const api = metricsApi();
  const runtime = readRuntimeMetricReport();
  for (const item of report.items) {
    const key = exactFontKey(item.requested);
    const hits = runtime
      ?.filter(entry => entry.aliases.some(alias => exactFontKey(alias) === key))
      .reduce((sum, entry) => sum + entry.hits, 0);
    if (hits !== undefined) item.runtimeMetricHits = hits;
    const registered = item.layoutMetrics === 'runtime' || (hits ?? 0) > 0;
    let baked: boolean | null = null;
    if (api?.hasBaked) {
      try {
        baked = api.hasBaked(item.requested, false, false);
      } catch {
        baked = null;
      }
    }
    if (baked !== null) {
      // 엔진 순서: 내장 → 런타임 → 추정
      item.layoutMetrics = baked ? 'baked' : registered ? 'runtime' : 'heuristic';
    } else if (registered) {
      // 등록했는데 레이아웃 뒤 hit가 0이면 내장 메트릭이 먼저 쓰인 것으로 추정한다.
      item.layoutMetrics = hits === 0 ? 'baked' : 'runtime';
    }
  }
  report.finalized = true;
  if (report.host === 'local-font-access') lastLocalFontAccessReport = report;
  else lastReport = report;
  installDebugHandle();
  logDesktopFontReport(report);
  return report;
}

export function logDesktopFontReport(report: DesktopFontReport): void {
  if (!report.available) return;
  const { totals } = report;
  const connected = totals.loaded + totals.alreadyAvailable;
  const title = `${logTag(report.host)} 문서 글꼴 ${totals.requested}개 중 ${connected}개 연결`
    + ` · 새 face ${totals.facesRegistered}개 · 메트릭 ${totals.metricsRegistered}개`
    + ` · ${formatBytes(totals.bytes)} · ${Math.round(report.timings.totalMs)}ms`;
  const log = console as Console & { groupCollapsed?: Console['groupCollapsed'] };
  if (typeof log.groupCollapsed !== 'function') {
    console.info(title);
    return;
  }
  log.groupCollapsed(title);
  try {
    if (report.error) console.warn('색인 오류:', report.error);
    if (report.indexStats) console.info('색인:', report.platform, report.indexStats);
    if (!report.metricsApi) console.info('런타임 메트릭 API 없음: 레이아웃은 엔진 내장/추정 메트릭을 씁니다.');
    console.table?.(report.items.map(item => ({
      요청: item.requested,
      상태: item.status,
      매칭: item.matchedBy ?? '',
      이름: item.matchedName ?? '',
      face: item.face?.displayName ?? '',
      출처: item.face?.source ?? '',
      형식: item.face?.format ?? '',
      스타일: item.face?.stylesLoaded.join('/') ?? '',
      메트릭: item.layoutMetrics,
      hits: item.runtimeMetricHits ?? '',
      크기: formatBytes(item.bytes),
      ms: item.ms,
      파일: item.face?.file ?? '',
      오류: item.error ?? '',
    })));
    const faceRows = report.items.flatMap(item => (item.face?.faces ?? []).map(face => ({
      요청: item.requested,
      slot: face.slot,
      상태: face.status,
      메트릭: face.metrics ?? '',
      family: face.runtimeFamily ?? '',
      크기: formatBytes(face.bytes),
      파일: face.file,
      오류: face.error ?? '',
    })));
    if (faceRows.length) console.table?.(faceRows);
    console.info('시간:', report.timings, '합계:', report.totals);
  } finally {
    console.groupEnd();
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** 색인을 새로 받고 마지막 문서 글꼴을 다시 연결한다 (디버깅용). */
export async function reloadDesktopFonts(): Promise<DesktopFontReport> {
  attemptedFonts.clear();
  await loadDesktopFontIndex({ refresh: true });
  const report = await prepareDesktopFontsForDocument(lastRequested);
  if (report.totals.facesRegistered > 0 || report.totals.metricsRegistered > 0) {
    config.onLateRegistration?.(report);
  } else {
    finalizeDesktopFontReport(report);
  }
  return report;
}

function installDebugHandle(): void {
  const g = globalThis as typeof globalThis & {
    __rhwpDesktopFontReport?: DesktopFontReport | null;
    __rhwpLocalFontAccessReport?: DesktopFontReport | null;
    __rhwpDesktopFonts?: unknown;
  };
  g.__rhwpDesktopFontReport = lastReport;
  g.__rhwpLocalFontAccessReport = lastLocalFontAccessReport;
  if (!g.__rhwpDesktopFonts) {
    g.__rhwpDesktopFonts = {
      get host() { return getSystemFontHost()?.kind ?? null; },
      get report() { return lastReport; },
      get localFontAccessReport() { return lastLocalFontAccessReport; },
      get index() { return currentIndex; },
      reload: reloadDesktopFonts,
      match: (name: string) => (currentLookup ? matchDesktopFont(name, currentLookup) : null),
      runtimeMetrics: () => readRuntimeMetricReport(),
    };
  }
}

/** 지정 시간 안에 끝나면 결과를, 아니면 null을 돌려준다. 원래 작업은 계속 진행된다. */
export async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise.then(value => ({ value })), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 테스트 전용 */
export function resetDesktopFontsForTests(): void {
  config = {};
  explicitHost = null;
  hubHost = null;
  combinedHost = null;
  lastLocalFontAccessReport = null;
  indexPromise = null;
  currentIndex = null;
  currentLookup = null;
  lastReport = null;
  lastRequested = [];
  desktopMenuNames = null;
  attemptedFonts.clear();
  metricAliasesByFace.clear();
  registrationTail = Promise.resolve();
  inflightReads.clear();
  indexStale = false;
}
