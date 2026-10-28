// 이 파일의 함수는 WasmBridge 의 같은 이름 메서드가 위임한다. 엔진이 아직 못 하는 기능은
// EngineNotSupportedError 를 던지고, 명령 계층이 해당 메뉴·버튼을 비활성으로 보여 준다.
//
// 문서 수명(열기·새 문서·저장), 쪽 정보·그리기, 스냅샷을 맡는다.
import type { PageInfo as HmPageInfo } from '../../../vendor/hm-wasm/hm_wasm';
import type { HmCore } from './core';
import { engineError, px, unsupported } from './core';
import { blake3Hex } from '../content-hash';
import { FALLBACK_DOCUMENT_FILE_NAME, NEW_DOCUMENT_FILE_NAME } from '../document-names';
import blankTemplateUrl from './blank.hwpx?url';
import type { DocumentInfo, PageInfo, LayerRenderProfile, PageLayerTree, HmlSaveState, RuntimeFontMetricsApi, ValidationReport, HmlOpenMetadata, DeferredPaginationResult, WebCanvasImageCacheStats, PreparedWasmDocument } from './bridge-types';

const NO_DOCUMENT = '문서가 로드되지 않았습니다';

export async function initialize(core: HmCore): Promise<void> {
  const [, template] = await Promise.all([core.adapter.initialize(), preloadBlankTemplate()]);
  core.adapter.editWarmupTemplate = template;
}

export function getRuntimeFontMetricsApi(core: HmCore): RuntimeFontMetricsApi | null {
  return core.adapter.getRuntimeFontMetricsApi();
}

export function isSubsecondHotpatchEnabled(_core: HmCore): boolean {
  return false;
}

export function getSubsecondProbeValue(_core: HmCore): number | null {
  return null;
}

export function getSubsecondPatchRevision(_core: HmCore): string | null {
  return null;
}

export function invalidateSubsecondRenderCaches(_core: HmCore): boolean {
  return false;
}

export function releaseDocument(core: HmCore): void {
  core.adapter.releaseDocument();
  core.noteDocumentReplaced();
}

/**
 * 문서를 들인 직후의 정보. 글꼴을 준비하기 전에는 조판하지 않도록 쪽·구역 수를 세지 않는다(0쪽, 1구역).
 * 편집기는 글꼴을 준비한 뒤 getDocumentInfo 로 다시 읽는다. 글꼴을 준비하지 않는 사본 브리지도 getDocumentInfo 를 읽는다.
 */
function loadedInfo(core: HmCore): DocumentInfo {
  return core.adapter.fontsReady ? getDocumentInfo(core) : core.adapter.getDocumentInfo();
}

function adoptLoaded(core: HmCore): DocumentInfo {
  core.noteDocumentReplaced();
  return loadedInfo(core);
}

export function loadDocument(core: HmCore, data: Uint8Array, fileName?: string): DocumentInfo {
  try {
    core.adapter.loadDocument(data, fileName ?? FALLBACK_DOCUMENT_FILE_NAME);
  } catch (error) {
    throw engineError(error);
  }
  return adoptLoaded(core);
}

/** 읽어 둔 문서 바이트. 엔진 문서는 들일 때 만든다(같은 바이트를 두 번 해석하지 않으려면 어댑터가 문서를 들고 있어야 한다). */
class PreparedHeemangDocument implements PreparedWasmDocument {
  constructor(
    private bytes: Uint8Array | null,
    readonly fileName: string,
    readonly info: DocumentInfo,
    readonly openedFromFile: boolean,
  ) {}

  take(): { bytes: Uint8Array; fileName: string; openedFromFile: boolean } {
    if (!this.bytes) throw new Error('Prepared document has already been consumed or disposed');
    const bytes = this.bytes;
    this.bytes = null;
    return { bytes, fileName: this.fileName, openedFromFile: this.openedFromFile };
  }

  dispose(): void {
    this.bytes = null;
  }
}

/** 지금 문서를 건드리지 않고 바이트를 검증한다. 들일 때 다시 연다. */
export function prepareDocument(
  core: HmCore,
  data: Uint8Array,
  fileName?: string,
  { openedFromFile = true }: { openedFromFile?: boolean } = {},
): PreparedWasmDocument {
  const name = fileName ?? FALLBACK_DOCUMENT_FILE_NAME;
  let probe;
  try {
    probe = core.adapter.hmEngine().open(data);
  } catch (error) {
    throw engineError(error);
  }
  let info: DocumentInfo;
  try {
    const requests = JSON.parse(probe.fontRequests()) as { faces: { name: string; text?: boolean }[] };
    info = {
      version: 'hm-wasm/1',
      sectionCount: 1,
      pageCount: 0,
      encrypted: false,
      fallbackFont: '',
      fontsUsed: [...new Set(requests.faces.filter(face => face.text !== false).map(face => face.name))],
    };
  } finally {
    probe.close();
    probe.free();
  }
  return new PreparedHeemangDocument(data, name, info, openedFromFile);
}

export function adoptPreparedDocument(core: HmCore, prepared: PreparedWasmDocument): DocumentInfo {
  if (!(prepared instanceof PreparedHeemangDocument)) {
    throw new Error('Prepared document was not created by this WASM bridge');
  }
  const { bytes, fileName, openedFromFile } = prepared.take();
  const info = loadDocument(core, bytes, fileName);
  core.adapter.openedFromFile = openedFromFile;
  return info;
}

export function loadTrustedLocalFileOnce(core: HmCore, data: Uint8Array, fileName?: string): DocumentInfo {
  return loadDocument(core, data, fileName);
}

/**
 * 파일 연결은 그대로 두고 내용만 바꾼다(버전 되돌리기·외부 변경 반영). 열린 엔진 문서가 새 내용을 받아들여
 * 바꾸기 전에 잡아 둔 스냅샷이 그대로 남으므로, 바꾸기를 되돌릴 수 있다.
 */
export function replaceContentFromBytes(core: HmCore, data: Uint8Array): DocumentInfo {
  const adapter = core.adapter;
  if (adapter.hasLoadedDocument()) {
    try {
      adapter.hmAdopt(data);
    } catch (error) {
      throw engineError(error);
    }
    core.noteDocumentReplaced();
    return loadedInfo(core);
  }
  const name = adapter.fileName;
  const handle = adapter.currentFileHandle;
  const digest = adapter.documentDigest;
  const prepared = adapter.fontsReady;
  const openedFromFile = adapter.openedFromFile;
  loadDocument(core, data, name);
  adapter.openedFromFile = openedFromFile;
  adapter.currentFileHandle = handle;
  if (digest) adapter.adoptSourceDigest(digest);
  if (prepared) adapter.markFontsPrepared();
  return loadedInfo(core);
}

export function getFontMetricsPolicy(_core: HmCore): string {
  return 'heemang';
}

export function hasLoadedDocument(core: HmCore): boolean {
  return core.adapter.hasLoadedDocument();
}

/** 번들 빈 문서(HWPX). 기존 편집기의 빈 문서와 같은 쪽·글꼴·스타일이다. */
let blankTemplate: Promise<Uint8Array> | null = null;
let blankTemplateBytes: Uint8Array | null = null;

/** 새 문서 서식을 미리 받아 둔다. 새 문서 만들기는 동기 API 라 initialize 가 기다린다. */
function preloadBlankTemplate(): Promise<Uint8Array> {
  blankTemplate ??= fetch(blankTemplateUrl)
    .then(async response => {
      if (!response.ok) throw new Error(`빈 문서 서식을 읽지 못했습니다: ${response.status}`);
      blankTemplateBytes = new Uint8Array(await response.arrayBuffer());
      return blankTemplateBytes;
    })
    .catch(error => { blankTemplate = null; throw error; });
  return blankTemplate;
}

export function prepareNewDocument(core: HmCore, source?: Uint8Array): PreparedWasmDocument {
  return prepareDocument(core, newDocumentBytes(core, source), NEW_DOCUMENT_FILE_NAME, { openedFromFile: false });
}

/** 새 문서(template 이 있으면 그 내용)의 HWPX 바이트. 지금 문서는 건드리지 않는다. */
export function newDocumentBytes(core: HmCore, source?: Uint8Array): Uint8Array {
  if (!source) {
    if (!blankTemplateBytes) throw unsupported('빈 문서 서식');
    return blankTemplateBytes.slice();
  }
  let doc;
  try {
    doc = core.adapter.hmEngine().open(source);
  } catch (error) {
    throw engineError(error);
  }
  try {
    return doc.serializeAs('hwpx', false).slice();
  } catch (error) {
    throw engineError(error);
  } finally {
    doc.close();
    doc.free();
  }
}

export function createNewDocument(core: HmCore, prepared?: PreparedWasmDocument): DocumentInfo {
  return adoptPreparedDocument(core, prepared ?? prepareNewDocument(core));
}

export function adoptSourceDigest(core: HmCore, digest: string): void {
  core.adapter.adoptSourceDigest(digest);
}

function serializeAs(core: HmCore, format: 'hwp5' | 'hwpx'): Uint8Array {
  if (!core.hasDocument()) throw new Error(NO_DOCUMENT);
  return core.call(doc => doc.serializeAs(format, false)).slice();
}

export function exportHwp(core: HmCore): Uint8Array {
  return serializeAs(core, 'hwp5');
}

export function exportHwpx(core: HmCore): Uint8Array {
  return serializeAs(core, 'hwpx');
}

export function exportHml(_core: HmCore): Uint8Array {
  throw unsupported('HML 저장');
}

export function hasHmlExportCapability(_core: HmCore): boolean {
  return false;
}

export function getHmlSaveState(_core: HmCore): HmlSaveState {
  throw unsupported('HML 저장');
}

/** 저장 결과를 다시 열어 문서 속성과 그림 바이트를 검증한다. */
export function exportHwpVerify(core: HmCore): string {
  return core.adapter.hmDoc().verifyHwp();
}

export function getSourceFormat(core: HmCore): string {
  if (!core.hasDocument()) return 'hwp';
  return core.adapter.getSourceFormat();
}

export function getHmlOpenMetadata(_core: HmCore): HmlOpenMetadata | null {
  return null;
}

export function getValidationWarnings(_core: HmCore): ValidationReport {
  return { count: 0, summary: {}, warnings: [] };
}

export function getExternalImageReferences(_core: HmCore): Array<{
    key?: string;
    binDataId?: number;
    originalPath?: string;
    basename?: string;
    extension?: string;
    loaded: boolean;
  }> {
  return [];
}

export function reflowLinesegs(_core: HmCore): number {
  return 0;
}

/** HeemangEngine 은 편집마다 바뀐 문단만 다시 조판하므로 미뤄 둔 쪽 나누기가 없다. */
function noDeferredPagination(core: HmCore): DeferredPaginationResult {
  return { ok: true, status: 'none', revision: 0, fragmentsProcessed: 0, pageCount: pageCount(core) };
}

export function beginDeferredPagination(core: HmCore, _fragmentBudget: number): DeferredPaginationResult {
  return noDeferredPagination(core);
}

export function stepDeferredPagination(core: HmCore, _fragmentBudget: number): DeferredPaginationResult {
  return noDeferredPagination(core);
}

export function cancelDeferredPagination(_core: HmCore): boolean {
  return false;
}

export function flushDeferredPagination(core: HmCore): DeferredPaginationResult {
  return noDeferredPagination(core);
}

export function pageCount(core: HmCore): number {
  if (!core.hasDocument()) return 0;
  return core.state().pageCount;
}

export function getSectionCount(core: HmCore): number {
  if (!core.hasDocument()) return 0;
  return core.adapter.getSectionCount();
}

export function getDocumentCharacterCount(core: HmCore): number {
  throw unsupported('getDocumentCharacterCount');
}

export function getBodyRangeCharacterCount(core: HmCore, startSec: number, startPara: number, startOffset: number, endSec: number, endPara: number, endOffset: number): number {
  throw unsupported('getBodyRangeCharacterCount');
}

export function getContainerCharacterCountByPath(core: HmCore, sec: number, parentPara: number, pathJson: string): number {
  throw unsupported('getContainerCharacterCountByPath');
}

export function getContainerRangeCharacterCountByPath(core: HmCore, sec: number, parentPara: number, pathJson: string, startPara: number, startOffset: number, endPara: number, endOffset: number): number {
  throw unsupported('getContainerRangeCharacterCountByPath');
}

/** 구 엔진 API 처럼 쪽 정보는 0.1px 로 맞춘다. 눈금자·쪽 틀이 이 값으로 그려진다(A4 폭 793.71 → 793.7). */
const pagePx = (hu: number): number => Math.round(px(hu) * 10) / 10;

function toPageInfo(page: HmPageInfo): PageInfo {
  const m = page.margins;
  return {
    pageIndex: page.index,
    pageNumber: page.number,
    width: pagePx(page.width),
    height: pagePx(page.height),
    sectionIndex: page.section,
    marginLeft: pagePx(m.left),
    marginRight: pagePx(m.right),
    marginTop: pagePx(m.top),
    marginBottom: pagePx(m.bottom),
    marginHeader: pagePx(m.header),
    marginFooter: pagePx(m.footer),
    headerArea: { x: pagePx(page.header.x), y: pagePx(page.header.y), width: pagePx(page.header.width), height: pagePx(page.header.height) },
    footerArea: { x: pagePx(page.footer.x), y: pagePx(page.footer.y), width: pagePx(page.footer.width), height: pagePx(page.footer.height) },
    bodyLeft: pagePx(page.body.x),
    bodyRight: pagePx(page.body.x + page.body.width),
    columns: page.columns.map(column => ({ x: pagePx(column.x), width: pagePx(column.width) })),
  };
}

/** 쪽 정보 캐시. 레이아웃이 바뀌면 다시 읽는다. */
const pageInfoCache = new WeakMap<HmCore, { tag: string; pages: Map<number, PageInfo>; all?: PageInfo[] }>();

function pageCacheFor(core: HmCore) {
  const state = core.state();
  const tag = `${core.adapter.documentInstance}:${state.layoutEpoch}:${state.pageCount}`;
  let cache = pageInfoCache.get(core);
  if (!cache || cache.tag !== tag) {
    cache = { tag, pages: new Map() };
    pageInfoCache.set(core, cache);
  }
  return cache;
}

export function getPageInfo(core: HmCore, pageNum: number): PageInfo {
  if (!core.hasDocument()) throw new Error(NO_DOCUMENT);
  const cache = pageCacheFor(core);
  let info = cache.pages.get(pageNum);
  if (!info) {
    info = toPageInfo(JSON.parse(core.call(doc => doc.pageInfo(pageNum))) as HmPageInfo);
    cache.pages.set(pageNum, info);
  }
  return info;
}

export function getAllPageInfo(core: HmCore): PageInfo[] {
  if (!core.hasDocument()) throw new Error(NO_DOCUMENT);
  const cache = pageCacheFor(core);
  if (!cache.all) {
    // 어댑터가 이 조판에서 읽은 쪽 목록을 함께 쓴다.
    cache.all = core.call(() => core.adapter.hmPages()).map(toPageInfo);
    cache.all.forEach((info, index) => cache.pages.set(index, info));
  }
  return cache.all;
}

export function getWebCanvasImageCacheStats(_core: HmCore): WebCanvasImageCacheStats {
  return { decodedCanvasEntries: 0, decodedCanvasPixels: 0, decodedCanvasRgbaBytes: 0, htmlImageEntries: 0, htmlImageSourceBytes: 0 };
}

export function refreshLayout(core: HmCore): void {
  if (!core.hasDocument()) throw new Error(NO_DOCUMENT);
  core.adapter.refreshLayout();
  // 명시적으로 다시 조판할 때는 브리지 밖에서 바뀐 내용까지 읽도록 문단·서식 읽기 캐시도 버린다.
  core.noteDocumentReplaced();
}

/** 쪽·구역 수는 글꼴 준비와 상관없이 pageCount·getSectionCount 와 같다. */
export function getDocumentInfo(core: HmCore): DocumentInfo {
  if (!core.hasDocument()) throw new Error(NO_DOCUMENT);
  return { ...core.adapter.getDocumentInfo(), sectionCount: getSectionCount(core), pageCount: pageCount(core) };
}

export function renderPageToCanvas(core: HmCore, pageNum: number, canvas: HTMLCanvasElement, scale: number): void {
  if (!core.hasDocument()) throw new Error(NO_DOCUMENT);
  core.adapter.renderPageToCanvas(pageNum, canvas, scale);
}

/** 층을 나누지 않는다. 본문 층 요청에 쪽 전체를 그리고, 앞·뒤 층은 비운다. */
export function renderPageToCanvasFiltered(core: HmCore, pageNum: number, canvas: HTMLCanvasElement, scale: number, layerKind: 'all' | 'background' | 'flow' | 'flow-dynamic' | 'flow-static' | 'behind' | 'front', _profile: LayerRenderProfile): void {
  if (layerKind === 'all' || layerKind === 'flow' || layerKind === 'flow-dynamic') {
    renderPageToCanvas(core, pageNum, canvas, scale);
    return;
  }
  const info = getPageInfo(core, pageNum);
  canvas.width = Math.max(1, Math.floor(info.width * scale));
  canvas.height = Math.max(1, Math.floor(info.height * scale));
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
}

function emptyLayerTree(core: HmCore, pageNum: number, profile: LayerRenderProfile): PageLayerTree {
  const info = getPageInfo(core, pageNum);
  return {
    pageWidth: info.width,
    pageHeight: info.height,
    profile,
    buildOptions: { showTransparentBorders: false, clipEnabled: true },
    debugOptions: { debugOverlay: false },
    outputOptions: { showParagraphMarks: false, showControlCodes: false, showTransparentBorders: false, clipEnabled: true, debugOverlay: false },
    root: { kind: 'leaf', bounds: { x: 0, y: 0, width: info.width, height: info.height }, ops: [] },
  } as PageLayerTree;
}

export function getPageLayerTree(core: HmCore, pageNum: number): string {
  return JSON.stringify(emptyLayerTree(core, pageNum, 'screen'));
}

export function getPageLayerTreeObject(core: HmCore, pageNum: number, profile: LayerRenderProfile): PageLayerTree {
  return emptyLayerTree(core, pageNum, profile);
}

export function clearLayerResourceCache(_core: HmCore): void {
  /* 쪽 packet 은 어댑터가 관리한다. */
}

export function getPageOverlayImages(_core: HmCore, _pageNum: number): string {
  return '';
}

export function renderPageSvg(core: HmCore, pageNum: number): string {
  return core.call(doc => doc.pageSvg(pageNum, 96));
}

export function renderPageSvgWithProfile(core: HmCore, pageNum: number, profile: LayerRenderProfile): string {
  return core.call(doc => doc.pageSvg(pageNum, profile === 'print' || profile === 'highQuality' ? 300 : 96));
}

export function withBodyTextPaginationBatch<T>(_core: HmCore, _sectionIdx: number, edit: () => T): T {
  return edit();
}

export function getParagraphStableId(_core: HmCore, _sec: number, _para: number): string {
  return '';
}

export function ensureParagraphStableIds(_core: HmCore): void {
  /* HeemangEngine 문단은 안정 ID 를 따로 두지 않는다. */
}

export function debugDumpStableIds(_core: HmCore, _sec: number, _startPara: number, _count: number): string {
  return '[]';
}

/** 조판 부호·문단 부호 표시는 엔진 그리기가 아직 지원하지 않는다. 설정값만 기억한다. */
const viewFlags = new WeakMap<HmCore, { paragraphMarks: boolean; controlCodes: boolean; transparentBorders: boolean }>();
function flags(core: HmCore) {
  let value = viewFlags.get(core);
  if (!value) {
    value = { paragraphMarks: false, controlCodes: false, transparentBorders: false };
    viewFlags.set(core, value);
  }
  return value;
}

export function setShowParagraphMarks(core: HmCore, enabled: boolean): void {
  flags(core).paragraphMarks = enabled;
}

export function getShowParagraphMarks(core: HmCore): boolean {
  return flags(core).paragraphMarks;
}

export function getShowControlCodes(core: HmCore): boolean {
  return flags(core).controlCodes;
}

export function setShowControlCodes(core: HmCore, enabled: boolean): void {
  flags(core).controlCodes = enabled;
}

export function getShowTransparentBorders(core: HmCore): boolean {
  return flags(core).transparentBorders;
}

export function setShowTransparentBorders(core: HmCore, enabled: boolean): void {
  flags(core).transparentBorders = enabled;
}

export function setClipEnabled(_core: HmCore, _enabled: boolean): void {
  /* 엔진은 항상 개체를 쪽 영역으로 자른다. */
}

export function capturePictureTransform(core: HmCore, target: Record<string, unknown>): number {
  throw unsupported('capturePictureTransform');
}

export function swapPictureTransform(core: HmCore, id: number): void {
  throw unsupported('swapPictureTransform');
}

export function discardPictureTransform(core: HmCore, id: number): void {
  throw unsupported('discardPictureTransform');
}

/** 문단 단위 보관은 아직 없다. null 이면 호출자가 문서 스냅샷으로 되돌린다. */
export function captureParagraph(_core: HmCore, _sec: number, _para: number): number | null {
  return null;
}

export function restoreCapturedParagraph(_core: HmCore, _id: number, _sec: number, _para: number): void {
  throw unsupported('문단 보관');
}

export function discardParagraphCapture(_core: HmCore, _id: number): void {
  /* captureParagraph 가 보관하지 않는다. */
}

export function getParagraphContentDigest(_core: HmCore, _sec: number, _para: number): string | null {
  return null;
}

/**
 * 스냅샷: 엔진 checkpoint(문서와 이력)를 공유 참조로 보관한다. Studio id 는 여러 개가
 * 한 checkpoint 를 가리킬 수 있고, 마지막 id 를 버릴 때 checkpoint 를 놓는다.
 */
interface SnapshotTable { next: number; ids: Map<number, number>; refs: Map<number, number> }
const snapshots = new WeakMap<HmCore, SnapshotTable>();
function snapshotTable(core: HmCore): SnapshotTable {
  let table = snapshots.get(core);
  if (!table) {
    table = { next: 1, ids: new Map(), refs: new Map() };
    snapshots.set(core, table);
  }
  return table;
}

function share(core: HmCore, checkpoint: number): number {
  const table = snapshotTable(core);
  const id = table.next++;
  table.ids.set(id, checkpoint);
  table.refs.set(checkpoint, (table.refs.get(checkpoint) ?? 0) + 1);
  return id;
}

export function saveSnapshot(core: HmCore): number {
  return share(core, core.call(doc => doc.checkpoint()));
}

export function shareSnapshot(core: HmCore, sourceId: number): number {
  const checkpoint = snapshotTable(core).ids.get(sourceId);
  return checkpoint === undefined ? saveSnapshot(core) : share(core, checkpoint);
}

export function shareSnapshotExact(core: HmCore, sourceId: number): number | null {
  const checkpoint = snapshotTable(core).ids.get(sourceId);
  return checkpoint === undefined ? null : share(core, checkpoint);
}

export function restoreSnapshot(core: HmCore, id: number): void {
  const checkpoint = snapshotTable(core).ids.get(id);
  if (checkpoint === undefined) throw new Error(`스냅샷 ${id} 이 없습니다`);
  core.mutate(doc => doc.restore(checkpoint));
  core.adapter.refreshLayout();
}

export function discardSnapshot(core: HmCore, id: number): void {
  const table = snapshotTable(core);
  const checkpoint = table.ids.get(id);
  if (checkpoint === undefined) return;
  table.ids.delete(id);
  const refs = (table.refs.get(checkpoint) ?? 1) - 1;
  if (refs > 0) {
    table.refs.set(checkpoint, refs);
    return;
  }
  table.refs.delete(checkpoint);
  if (core.hasDocument()) core.call(doc => doc.releaseCheckpoint(checkpoint));
}

export function getOutlineStructure(_core: HmCore, _mode: string): {
    mode: string; node_count: number; preamble?: string[];
    roots: Array<Record<string, unknown>>;
  } | null {
  return null;
}

export function dispose(core: HmCore): void {
  releaseDocument(core);
}

/** 문서 내용 지문 — 버전 기록과 자동 저장이 같은 내용인지 비교한다. */
export function contentDigest(bytes: Uint8Array): string {
  return `blake3:${blake3Hex(bytes)}`;
}
