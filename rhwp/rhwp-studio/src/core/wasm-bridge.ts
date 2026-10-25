/**
 * Studio 의 문서 엔진 경계. HeemangEngine(hm-wasm) 하나만 쓴다.
 *
 * 공개 메서드는 기존 Studio 좌표(구역·문단·캐럿 논리 오프셋·셀 경로)를 그대로 받는다. 각 메서드는
 * src/core/hm/ 의 같은 이름 함수에 위임하고, 그 함수가 엔진 주소로 바꿔 hm-wasm 을 부른다.
 * 엔진이 아직 못 하는 기능은 EngineNotSupportedError 를 던진다 (명령 계층이 메뉴를 비활성으로 둔다).
 */
import { HeemangAdapter } from './heemang-adapter';
import { HmCore } from './hm/core';
import { api } from './hm/api';
import './hm/extensions';
import { fontFamilyChainForDisplay, prefersHcrOverWebProxy, prefersImportedHancomSubstitute } from './font-substitution';
import { hasImportedLocalFontFace } from './local-fonts';
import { createDeclaredFontAvailabilityProbe, createRawFontAvailabilityProbe } from './font-presence';
import { getWebFontSubstituteFamilies } from './font-loader';
import { isUntitledNewDocumentName } from './document-names';
import type {
  DocumentInfo, PageInfo, PageDef, SectionDef, PageBorderFillSettings, EndnoteShapeSettings, NoteEditInfo, CursorRect,
  HitTestResult, BodyFootnoteMarkerHit, FootnoteAtCursorResult, DeleteFootnoteResult, LineInfo, TableDimensions, CellInfo,
  TableCellTarget, CellBbox, CellProperties, TableProperties, DocumentPosition, MoveVerticalResult, SelectionRect,
  CharProperties, ParaProperties, CellPathEntry, CellPathLike, NavContextEntry, FieldInfoResult, BookmarkInfo,
  LayerRenderProfile, PageLayerTree, CanvasKitDocumentPreflight, CharShapeRun, HyperlinkTarget, HyperlinkContext,
  HmlSaveState, SelectionPageHints, TextContent, LocalBodyTextReplaceResult, RuntimeFontMetricsApi,
  FileSystemFileHandleLike, RemovedParaMeta, ValidationReport, HmlOpenMetadata, TableCellResizeUpdate,
  TableTransposeResult, DeferredCellTextMutationResult, DeferredPaginationResult, WebCanvasImageCacheStats,
  PreparedWasmDocument,
} from './hm/bridge-types';

export type {
  RemovedParaMeta, ValidationReport, HmlWarningCode, HmlOpenMetadata, TableCellResizeUpdate, TableTransposeResult,
  DeferredCellTextMutationResult, DeferredPaginationStatus, DeferredPaginationResult, WebCanvasImageCacheStats,
  PreparedWasmDocument,
} from './hm/bridge-types';

/**
 * Canvas 텍스트 페인트와 별개로, 원본 face 의 실제 존재 여부를 글꼴 상태 UI 에 알린다.
 * 패치 전 font setter 로 재야 없는 face 가 fallback 체인으로 치환되어 "설치됨"으로 보이지 않는다.
 */
export function installDeclaredFontAvailabilityProbe(): void {
  const host = globalThis as Record<string, unknown>;
  if (typeof host.isDeclaredFontFamilyAvailable === 'function') return;
  if (typeof CanvasRenderingContext2D === 'undefined') return;
  const descriptor = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'font');
  const context = globalThis.document.createElement('canvas').getContext('2d');
  if (!descriptor?.get || !descriptor.set || !context) return;
  host.isInstalledFontFamilyAvailable = createRawFontAvailabilityProbe(
    context,
    { get: descriptor.get, set: descriptor.set },
  );
  host.isDeclaredFontFamilyAvailable = createDeclaredFontAvailabilityProbe(
    context,
    { get: descriptor.get, set: descriptor.set },
    hasImportedLocalFontFace,
    getWebFontSubstituteFamilies(),
    family => prefersHcrOverWebProxy(family) || prefersImportedHancomSubstitute(family),
  );
  void fontFamilyChainForDisplay;
}

export class WasmBridge {
  /** 엔진 문서와 글꼴·쪽 그리기를 맡는 저수준 어댑터. */
  readonly viewer: HeemangAdapter;
  /** 위임 함수가 공유하는 상태와 엔진 호출. */
  readonly core: HmCore;

  constructor() {
    this.viewer = new HeemangAdapter();
    this.core = new HmCore(this.viewer);
  }

  get wasmMemoryBytes(): number {
    try { return this.viewer.wasmMemoryBytes; } catch { return 0; }
  }
  get documentGeneration(): number { return this.viewer.documentGeneration; }
  get documentInstance(): number { return this.viewer.documentInstance; }

  /** [#3313] 외부 연결 그림 주입 완료 훅. HeemangEngine 은 외부 그림을 따로 주입하지 않는다. */
  onExternalImagesInjected?: (injected: number) => void;
  /** 문서 로드·새 문서·저장 이름 확정 후 알림. */
  get onFileNameChanged(): ((fileName: string) => void) | undefined { return this.viewer.onFileNameChanged; }
  set onFileNameChanged(listener: ((fileName: string) => void) | undefined) { this.viewer.onFileNameChanged = listener; }

  get fileName(): string { return this.viewer.fileName; }
  set fileName(name: string) { this.viewer.fileName = name; }
  get documentDigest(): string | null { return this.viewer.documentDigest; }
  get currentFileHandle(): FileSystemFileHandleLike | null { return this.viewer.currentFileHandle; }
  set currentFileHandle(handle: FileSystemFileHandleLike | null) { this.viewer.currentFileHandle = handle; }
  get isNewDocument(): boolean { return isUntitledNewDocumentName(this.viewer.fileName); }
  get pageCount(): number { return api.pageCount(this.core); }

  initialize(): Promise<void> {
    return api.initialize(this.core);
  }

  getRuntimeFontMetricsApi(): RuntimeFontMetricsApi | null {
    return api.getRuntimeFontMetricsApi(this.core);
  }

  isSubsecondHotpatchEnabled(): boolean {
    return api.isSubsecondHotpatchEnabled(this.core);
  }

  getSubsecondProbeValue(): number | null {
    return api.getSubsecondProbeValue(this.core);
  }

  getSubsecondPatchRevision(): string | null {
    return api.getSubsecondPatchRevision(this.core);
  }

  invalidateSubsecondRenderCaches(): boolean {
    return api.invalidateSubsecondRenderCaches(this.core);
  }

  releaseDocument(): void {
    return api.releaseDocument(this.core);
  }

  loadDocument(data: Uint8Array, fileName?: string): DocumentInfo {
    return api.loadDocument(this.core, data, fileName);
  }

  prepareDocument(data: Uint8Array, fileName?: string): PreparedWasmDocument {
    return api.prepareDocument(this.core, data, fileName);
  }

  adoptPreparedDocument(prepared: PreparedWasmDocument): DocumentInfo {
    return api.adoptPreparedDocument(this.core, prepared);
  }

  loadTrustedLocalFileOnce(data: Uint8Array, fileName?: string): DocumentInfo {
    return api.loadTrustedLocalFileOnce(this.core, data, fileName);
  }

  replaceContentFromBytes(data: Uint8Array): DocumentInfo {
    return api.replaceContentFromBytes(this.core, data);
  }

  getFontMetricsPolicy(): string {
    return api.getFontMetricsPolicy(this.core);
  }

  hasLoadedDocument(): boolean {
    return api.hasLoadedDocument(this.core);
  }

  prepareNewDocument(source?: Uint8Array): PreparedWasmDocument {
    return api.prepareNewDocument(this.core, source);
  }

  newDocumentBytes(source?: Uint8Array): Uint8Array {
    return api.newDocumentBytes(this.core, source);
  }

  createNewDocument(prepared?: PreparedWasmDocument): DocumentInfo {
    return api.createNewDocument(this.core, prepared);
  }

  adoptSourceDigest(digest: string): void {
    return api.adoptSourceDigest(this.core, digest);
  }

  exportHwp(): Uint8Array {
    return api.exportHwp(this.core);
  }

  exportHwpx(): Uint8Array {
    return api.exportHwpx(this.core);
  }

  exportHml(): Uint8Array {
    return api.exportHml(this.core);
  }

  hasHmlExportCapability(): boolean {
    return api.hasHmlExportCapability(this.core);
  }

  getHmlSaveState(): HmlSaveState {
    return api.getHmlSaveState(this.core);
  }

  exportHwpVerify(): string {
    return api.exportHwpVerify(this.core);
  }

  getSourceFormat(): string {
    return api.getSourceFormat(this.core);
  }

  getHmlOpenMetadata(): HmlOpenMetadata | null {
    return api.getHmlOpenMetadata(this.core);
  }

  getValidationWarnings(): ValidationReport {
    return api.getValidationWarnings(this.core);
  }

  getExternalImageReferences(): Array<{
    key?: string;
    binDataId?: number;
    originalPath?: string;
    basename?: string;
    extension?: string;
    loaded: boolean;
  }> {
    return api.getExternalImageReferences(this.core);
  }

  reflowLinesegs(): number {
    return api.reflowLinesegs(this.core);
  }

  beginDeferredPagination(fragmentBudget = 1): DeferredPaginationResult {
    return api.beginDeferredPagination(this.core, fragmentBudget);
  }

  stepDeferredPagination(fragmentBudget = 1): DeferredPaginationResult {
    return api.stepDeferredPagination(this.core, fragmentBudget);
  }

  cancelDeferredPagination(): boolean {
    return api.cancelDeferredPagination(this.core);
  }

  flushDeferredPagination(): DeferredPaginationResult {
    return api.flushDeferredPagination(this.core);
  }

  getSectionCount(): number {
    return api.getSectionCount(this.core);
  }

  getDocumentCharacterCount(): number {
    return api.getDocumentCharacterCount(this.core);
  }

  getBodyRangeCharacterCount(startSec: number, startPara: number, startOffset: number, endSec: number, endPara: number, endOffset: number): number {
    return api.getBodyRangeCharacterCount(this.core, startSec, startPara, startOffset, endSec, endPara, endOffset);
  }

  getContainerCharacterCountByPath(sec: number, parentPara: number, pathJson: string): number {
    return api.getContainerCharacterCountByPath(this.core, sec, parentPara, pathJson);
  }

  getContainerRangeCharacterCountByPath(sec: number, parentPara: number, pathJson: string, startPara: number, startOffset: number, endPara: number, endOffset: number): number {
    return api.getContainerRangeCharacterCountByPath(this.core, sec, parentPara, pathJson, startPara, startOffset, endPara, endOffset);
  }

  getPageInfo(pageNum: number): PageInfo {
    return api.getPageInfo(this.core, pageNum);
  }

  getAllPageInfo(): PageInfo[] {
    return api.getAllPageInfo(this.core);
  }

  getWebCanvasImageCacheStats(): WebCanvasImageCacheStats {
    return api.getWebCanvasImageCacheStats(this.core);
  }

  refreshLayout(): void {
    return api.refreshLayout(this.core);
  }

  getDocumentInfo(): DocumentInfo {
    return api.getDocumentInfo(this.core);
  }

  getPageDef(sectionIdx: number): PageDef {
    return api.getPageDef(this.core, sectionIdx);
  }

  setPageDef(sectionIdx: number, pageDef: PageDef): { ok: boolean; pageCount: number } {
    return api.setPageDef(this.core, sectionIdx, pageDef);
  }

  setPageDefAll(patch: Partial<PageDef>): { ok: boolean; pageCount: number } {
    return api.setPageDefAll(this.core, patch);
  }

  getSectionDef(sectionIdx: number): SectionDef {
    return api.getSectionDef(this.core, sectionIdx);
  }

  setSectionDef(sectionIdx: number, sectionDef: SectionDef): { ok: boolean; pageCount: number } {
    return api.setSectionDef(this.core, sectionIdx, sectionDef);
  }

  setSectionDefAll(sectionDef: SectionDef): { ok: boolean; pageCount: number } {
    return api.setSectionDefAll(this.core, sectionDef);
  }

  getPageBorderFill(sectionIdx: number): PageBorderFillSettings {
    return api.getPageBorderFill(this.core, sectionIdx);
  }

  setPageBorderFill(sectionIdx: number, settings: PageBorderFillSettings): { ok: boolean; pageCount: number } {
    return api.setPageBorderFill(this.core, sectionIdx, settings);
  }

  renderPageToCanvas(pageNum: number, canvas: HTMLCanvasElement, scale = 1.0): void {
    return api.renderPageToCanvas(this.core, pageNum, canvas, scale);
  }

  renderPageToCanvasFiltered(pageNum: number, canvas: HTMLCanvasElement, scale: number, layerKind: 'all' | 'background' | 'flow' | 'flow-dynamic' | 'flow-static' | 'behind' | 'front', profile: LayerRenderProfile = 'screen'): void {
    return api.renderPageToCanvasFiltered(this.core, pageNum, canvas, scale, layerKind, profile);
  }

  getPageLayerTree(pageNum: number): string {
    return api.getPageLayerTree(this.core, pageNum);
  }

  getPageLayerTreeObject(pageNum: number, profile: LayerRenderProfile = 'screen'): PageLayerTree {
    return api.getPageLayerTreeObject(this.core, pageNum, profile);
  }

  clearLayerResourceCache(): void {
    return api.clearLayerResourceCache(this.core);
  }

  getCanvasKitReplayPlan(pageNum: number, mode: 'default' | 'compat' = 'default', profile: LayerRenderProfile = 'screen'): string {
    return api.getCanvasKitReplayPlan(this.core, pageNum, mode, profile);
  }

  getCanvasKitDocumentPreflight(mode: 'default' | 'compat' = 'default', profile: LayerRenderProfile = 'screen'): CanvasKitDocumentPreflight {
    return api.getCanvasKitDocumentPreflight(this.core, mode, profile);
  }

  getPageOverlayImages(pageNum: number): string {
    return api.getPageOverlayImages(this.core, pageNum);
  }

  renderPageSvg(pageNum: number): string {
    return api.renderPageSvg(this.core, pageNum);
  }

  renderPageSvgWithProfile(pageNum: number, profile: LayerRenderProfile): string {
    return api.renderPageSvgWithProfile(this.core, pageNum, profile);
  }

  getCursorRect(sec: number, para: number, charOffset: number): CursorRect {
    return api.getCursorRect(this.core, sec, para, charOffset);
  }

  getCursorRectOnLine(sec: number, para: number, lineIndex: number, atEnd: boolean, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number): CursorRect {
    return api.getCursorRectOnLine(this.core, sec, para, lineIndex, atEnd, parentPara, controlIdx, cellIdx, cellParaIdx);
  }

  hitTest(pageNum: number, x: number, y: number): HitTestResult {
    return api.hitTest(this.core, pageNum, x, y);
  }

  hitTestBodyFootnoteMarker(pageNum: number, x: number, y: number): BodyFootnoteMarkerHit {
    return api.hitTestBodyFootnoteMarker(this.core, pageNum, x, y);
  }

  withBodyTextPaginationBatch<T>(sectionIdx: number, edit: () => T): T {
    return api.withBodyTextPaginationBatch(this.core, sectionIdx, edit);
  }

  insertText(sec: number, para: number, charOffset: number, text: string, logical = false): string {
    return api.insertText(this.core, sec, para, charOffset, text, logical);
  }

  insertTextContent(sec: number, para: number, charOffset: number, content: TextContent, logical = false): string {
    return api.insertTextContent(this.core, sec, para, charOffset, content, logical);
  }

  insertTextContentInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, content: TextContent, logical = false): string {
    return api.insertTextContentInCell(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, charOffset, content, logical);
  }

  insertTextContentInCellDeferredPagination(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, content: TextContent, logical = false): DeferredCellTextMutationResult {
    return api.insertTextContentInCellDeferredPagination(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, charOffset, content, logical);
  }

  insertTextContentInCellByPath(sec: number, parentPara: number, pathJson: string, charOffset: number, content: TextContent, logical = false): string {
    return api.insertTextContentInCellByPath(this.core, sec, parentPara, pathJson, charOffset, content, logical);
  }

  insertTextContentInHeaderFooter(sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, charOffset: number, content: TextContent): string {
    return api.insertTextContentInHeaderFooter(this.core, sec, isHeader, applyTo, hfParaIdx, charOffset, content);
  }

  insertTextContentInFootnote(sec: number, para: number, controlIdx: number, fnParaIdx: number, charOffset: number, content: TextContent): { ok: boolean; charOffset: number } {
    return api.insertTextContentInFootnote(this.core, sec, para, controlIdx, fnParaIdx, charOffset, content);
  }

  insertTextLogical(sec: number, para: number, logicalOffset: number, text: string): string {
    return api.insertTextLogical(this.core, sec, para, logicalOffset, text);
  }

  replaceBodyTextLocal(sec: number, para: number, charOffset: number, deleteCount: number, text: string, logical = false): LocalBodyTextReplaceResult {
    return api.replaceBodyTextLocal(this.core, sec, para, charOffset, deleteCount, text, logical);
  }

  deleteText(sec: number, para: number, charOffset: number, count: number, logical = false): string {
    return api.deleteText(this.core, sec, para, charOffset, count, logical);
  }

  splitParagraph(sec: number, para: number, charOffset: number, removedParaMeta?: RemovedParaMeta): string {
    return api.splitParagraph(this.core, sec, para, charOffset, removedParaMeta);
  }

  splitParagraphLogical(sec: number, para: number, charOffset: number): string {
    return api.splitParagraphLogical(this.core, sec, para, charOffset);
  }

  insertPageBreak(sec: number, para: number, charOffset: number): string {
    return api.insertPageBreak(this.core, sec, para, charOffset);
  }

  insertColumnBreak(sec: number, para: number, charOffset: number): string {
    return api.insertColumnBreak(this.core, sec, para, charOffset);
  }

  getColumnDef(sec: number): { columnCount: number; columnType: number; sameWidth: boolean; spacing: number; widths?: number[] } {
    return api.getColumnDef(this.core, sec);
  }

  insertNewNumber(sec: number, para: number, charOffset: number, startNum: number): string {
    return api.insertNewNumber(this.core, sec, para, charOffset, startNum);
  }

  /** columnWidths: 너비가 다른 단(sameWidth 0)의 단마다 너비 비율. getColumnDef().widths(HU)도 그대로 받는다. */
  setColumnDef(sec: number, columnCount: number, columnType: number, sameWidth: number, spacingHu: number, columnWidths?: number[]): string {
    return api.setColumnDef(this.core, sec, columnCount, columnType, sameWidth, spacingHu, columnWidths);
  }

  mergeParagraph(sec: number, para: number): string {
    return api.mergeParagraph(this.core, sec, para);
  }

  deleteParagraph(sec: number, para: number): string {
    return api.deleteParagraph(this.core, sec, para);
  }

  insertParagraph(sec: number, para: number): string {
    return api.insertParagraph(this.core, sec, para);
  }

  splitParagraphInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, removedParaMeta?: RemovedParaMeta): string {
    return api.splitParagraphInCell(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, charOffset, removedParaMeta);
  }

  splitParagraphInCellLogical(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number): string {
    return api.splitParagraphInCellLogical(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, charOffset);
  }

  mergeParagraphInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number): string {
    return api.mergeParagraphInCell(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx);
  }

  getTextRange(sec: number, para: number, charOffset: number, count: number, logical = false): string {
    return api.getTextRange(this.core, sec, para, charOffset, count, logical);
  }

  getParagraphLength(sec: number, para: number): number {
    return api.getParagraphLength(this.core, sec, para);
  }

  getLogicalLength(sec: number, para: number): number {
    return api.getLogicalLength(this.core, sec, para);
  }

  logicalToTextOffset(sec: number, para: number, logicalOffset: number): number {
    return api.logicalToTextOffset(this.core, sec, para, logicalOffset);
  }

  getParagraphCount(sec: number): number {
    return api.getParagraphCount(this.core, sec);
  }

  getParagraphStableId(sec: number, para: number): string {
    return api.getParagraphStableId(this.core, sec, para);
  }

  ensureParagraphStableIds(): void {
    return api.ensureParagraphStableIds(this.core);
  }

  debugDumpStableIds(sec: number, startPara: number, count: number): string {
    return api.debugDumpStableIds(this.core, sec, startPara, count);
  }

  getTextBoxControlIndex(sec: number, para: number): number {
    return api.getTextBoxControlIndex(this.core, sec, para);
  }

  findNextEditableControl(sec: number, para: number, ctrlIdx: number, delta: number): { type: string; sec: number; para: number; ci: number } {
    return api.findNextEditableControl(this.core, sec, para, ctrlIdx, delta);
  }

  findNearestControlBackward(sec: number, para: number, charOffset: number): { type: string; sec: number; para: number; ci: number } {
    return api.findNearestControlBackward(this.core, sec, para, charOffset);
  }

  findNearestControlForward(sec: number, para: number, charOffset: number): { type: string; sec: number; para: number; ci: number; charPos?: number } {
    return api.findNearestControlForward(this.core, sec, para, charOffset);
  }

  getControlTextPositions(sec: number, para: number): number[] {
    return api.getControlTextPositions(this.core, sec, para);
  }

  navigateNextEditable(sec: number, para: number, charOffset: number, delta: number, contextJson: string): { type: string; sec: number; para: number; charOffset: number; context: NavContextEntry[] } {
    return api.navigateNextEditable(this.core, sec, para, charOffset, delta, contextJson);
  }

  getCursorRectInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number): CursorRect {
    return api.getCursorRectInCell(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, charOffset);
  }

  insertTextInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, text: string, logical = false): string {
    return api.insertTextInCell(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, charOffset, text, logical);
  }

  insertTextInCellDeferredPagination(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, text: string, logical = false): DeferredCellTextMutationResult {
    return api.insertTextInCellDeferredPagination(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, charOffset, text, logical);
  }

  replaceTextInCellDeferredPagination(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, deleteCount: number, text: string, logical = false): DeferredCellTextMutationResult {
    return api.replaceTextInCellDeferredPagination(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, charOffset, deleteCount, text, logical);
  }

  deleteTextInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, count: number, logical = false): string {
    return api.deleteTextInCell(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, charOffset, count, logical);
  }

  deleteTextInCellDeferredPagination(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, count: number, logical = false): DeferredCellTextMutationResult {
    return api.deleteTextInCellDeferredPagination(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, charOffset, count, logical);
  }

  insertTextInCellByPath(sec: number, parentPara: number, pathJson: string, charOffset: number, text: string, logical = false): string {
    return api.insertTextInCellByPath(this.core, sec, parentPara, pathJson, charOffset, text, logical);
  }

  deleteTextInCellByPath(sec: number, parentPara: number, pathJson: string, charOffset: number, count: number, logical = false): string {
    return api.deleteTextInCellByPath(this.core, sec, parentPara, pathJson, charOffset, count, logical);
  }

  deleteRangeInCellByPath(sec: number, parentPara: number, pathJson: string, startPara: number, startOffset: number, endPara: number, endOffset: number, logical = false): string {
    return api.deleteRangeInCellByPath(this.core, sec, parentPara, pathJson, startPara, startOffset, endPara, endOffset, logical);
  }

  splitParagraphInCellByPath(sec: number, parentPara: number, pathJson: string, charOffset: number, removedParaMeta?: RemovedParaMeta): string {
    return api.splitParagraphInCellByPath(this.core, sec, parentPara, pathJson, charOffset, removedParaMeta);
  }

  mergeParagraphInCellByPath(sec: number, parentPara: number, pathJson: string): string {
    return api.mergeParagraphInCellByPath(this.core, sec, parentPara, pathJson);
  }

  getTextInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, count: number, logical = false): string {
    return api.getTextInCell(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, charOffset, count, logical);
  }

  getTextInCellByPath(sec: number, parentPara: number, pathJson: string, charOffset: number, count: number, logical = false): string {
    return api.getTextInCellByPath(this.core, sec, parentPara, pathJson, charOffset, count, logical);
  }

  logicalToTextOffsetInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, logicalOffset: number): number {
    return api.logicalToTextOffsetInCell(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, logicalOffset);
  }

  textToLogicalOffset(sec: number, para: number, textOffset: number): number {
    return api.textToLogicalOffset(this.core, sec, para, textOffset);
  }

  textToLogicalOffsetInCellByPath(sec: number, parentPara: number, pathJson: string, textOffset: number): number {
    return api.textToLogicalOffsetInCellByPath(this.core, sec, parentPara, pathJson, textOffset);
  }

  logicalToTextOffsetInCellByPath(sec: number, parentPara: number, pathJson: string, logicalOffset: number): number {
    return api.logicalToTextOffsetInCellByPath(this.core, sec, parentPara, pathJson, logicalOffset);
  }

  getCellParagraphLength(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number): number {
    return api.getCellParagraphLength(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx);
  }

  getCellParagraphCount(sec: number, parentPara: number, controlIdx: number, cellIdx: number): number {
    return api.getCellParagraphCount(this.core, sec, parentPara, controlIdx, cellIdx);
  }

  getCellParagraphCountByPath(sec: number, parentPara: number, pathJson: string): number {
    return api.getCellParagraphCountByPath(this.core, sec, parentPara, pathJson);
  }

  getCellParagraphLengthByPath(sec: number, parentPara: number, pathJson: string): number {
    return api.getCellParagraphLengthByPath(this.core, sec, parentPara, pathJson);
  }

  getCellLogicalLengthByPath(sec: number, parentPara: number, pathJson: string): number {
    return api.getCellLogicalLengthByPath(this.core, sec, parentPara, pathJson);
  }

  getCellTextDirection(sec: number, parentPara: number, controlIdx: number, cellIdx: number): number {
    return api.getCellTextDirection(this.core, sec, parentPara, controlIdx, cellIdx);
  }

  getParagraphPages(sec: number, para: number): number[] | null {
    return api.getParagraphPages(this.core, sec, para);
  }

  getLineInfo(sec: number, para: number, charOffset: number): LineInfo {
    return api.getLineInfo(this.core, sec, para, charOffset);
  }

  getLineInfoInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number): LineInfo {
    return api.getLineInfoInCell(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, charOffset);
  }

  getCaretPosition(): DocumentPosition | null {
    return api.getCaretPosition(this.core);
  }

  getTableDimensions(sec: number, parentPara: number, controlIdx: number): TableDimensions {
    return api.getTableDimensions(this.core, sec, parentPara, controlIdx);
  }

  getCellInfo(sec: number, parentPara: number, controlIdx: number, cellIdx: number): CellInfo {
    return api.getCellInfo(this.core, sec, parentPara, controlIdx, cellIdx);
  }

  getTableCellBboxes(sec: number, parentPara: number, controlIdx: number, pageHint?: number): CellBbox[] {
    return api.getTableCellBboxes(this.core, sec, parentPara, controlIdx, pageHint);
  }

  getTableBBox(sec: number, parentPara: number, controlIdx: number): { pageIndex: number; x: number; y: number; width: number; height: number } {
    return api.getTableBBox(this.core, sec, parentPara, controlIdx);
  }

  getTableBBoxAtPage(sec: number, parentPara: number, controlIdx: number, pageIdx: number): { pageIndex: number; x: number; y: number; width: number; height: number } {
    return api.getTableBBoxAtPage(this.core, sec, parentPara, controlIdx, pageIdx);
  }

  getShapeBBox(sec: number, parentPara: number, controlIdx: number): { pageIndex: number; x: number; y: number; width: number; height: number } {
    return api.getShapeBBox(this.core, sec, parentPara, controlIdx);
  }

  getObjectBBox(kind: 'image' | 'equation', sec: number, parentPara: number, controlIdx: number, cellIdx?: number, cellParaIdx?: number, innerControlIdx?: number, cellPath?: CellPathLike): { pageIndex: number; x: number; y: number; width: number; height: number } {
    return api.getObjectBBox(this.core, kind, sec, parentPara, controlIdx, cellIdx, cellParaIdx, innerControlIdx, cellPath);
  }

  deleteTableControl(sec: number, parentPara: number, controlIdx: number): { ok: boolean } {
    return api.deleteTableControl(this.core, sec, parentPara, controlIdx);
  }

  deleteCellTableControlByPath(sec: number, parentPara: number, pathJson: string, controlIdx: number): { ok: boolean } {
    return api.deleteCellTableControlByPath(this.core, sec, parentPara, pathJson, controlIdx);
  }

  getCellProperties(sec: number, parentPara: number, controlIdx: number, cellIdx: number): CellProperties {
    return api.getCellProperties(this.core, sec, parentPara, controlIdx, cellIdx);
  }

  getCellPropertiesByPath(sec: number, parentPara: number, pathJson: string, cellIdx: number): CellProperties {
    return api.getCellPropertiesByPath(this.core, sec, parentPara, pathJson, cellIdx);
  }

  getCellOwnProperties(sec: number, parentPara: number, controlIdx: number, cellIdx: number): CellProperties {
    return api.getCellOwnProperties(this.core, sec, parentPara, controlIdx, cellIdx);
  }

  setCellProperties(sec: number, parentPara: number, controlIdx: number, cellIdx: number, props: Partial<CellProperties>): { ok: boolean } {
    return api.setCellProperties(this.core, sec, parentPara, controlIdx, cellIdx, props);
  }

  setCellZoneProperties(sec: number, parentPara: number, controlIdx: number, range: { startRow: number; startCol: number; endRow: number; endCol: number }, props: Partial<CellProperties>): { ok: boolean; borderFillId: number } {
    return api.setCellZoneProperties(this.core, sec, parentPara, controlIdx, range, props);
  }

  resizeTableCells(sec: number, parentPara: number, controlIdx: number, updates: TableCellResizeUpdate[]): { ok: boolean } {
    return api.resizeTableCells(this.core, sec, parentPara, controlIdx, updates);
  }

  resizeTableCellsByPath(sec: number, parentPara: number, pathJson: string, updates: TableCellResizeUpdate[]): { ok: boolean } {
    return api.resizeTableCellsByPath(this.core, sec, parentPara, pathJson, updates);
  }

  moveTableOffset(sec: number, parentPara: number, controlIdx: number, deltaH: number, deltaV: number): { ok: boolean; ppi: number; ci: number } {
    return api.moveTableOffset(this.core, sec, parentPara, controlIdx, deltaH, deltaV);
  }

  getTableProperties(sec: number, parentPara: number, controlIdx: number): TableProperties {
    return api.getTableProperties(this.core, sec, parentPara, controlIdx);
  }

  getTableSignature(sec: number, parentPara: number, controlIdx: number): string {
    return api.getTableSignature(this.core, sec, parentPara, controlIdx);
  }

  setTableProperties(sec: number, parentPara: number, controlIdx: number, props: Partial<TableProperties>): { ok: boolean } {
    return api.setTableProperties(this.core, sec, parentPara, controlIdx, props);
  }

  setTableColumnWidths(sec: number, parentPara: number, controlIdx: number, widths: number[]): { ok: boolean; colCount: number; tableWidth: number } {
    return api.setTableColumnWidths(this.core, sec, parentPara, controlIdx, widths);
  }

  fitTableToPage(sec: number, parentPara: number, controlIdx: number): { ok: boolean; colCount: number; tableWidth: number } {
    return api.fitTableToPage(this.core, sec, parentPara, controlIdx);
  }

  setTableCaptionText(sec: number, parentPara: number, controlIdx: number, text: string, withNumber: boolean): { ok: boolean; captionText: string } {
    return api.setTableCaptionText(this.core, sec, parentPara, controlIdx, text, withNumber);
  }

  mergeTableCells(sec: number, parentPara: number, controlIdx: number, startRow: number, startCol: number, endRow: number, endCol: number): { ok: boolean; cellCount: number } {
    return api.mergeTableCells(this.core, sec, parentPara, controlIdx, startRow, startCol, endRow, endCol);
  }

  mergeTableCellsByPath(sec: number, parentPara: number, pathJson: string, startRow: number, startCol: number, endRow: number, endCol: number): { ok: boolean; cellCount: number } {
    return api.mergeTableCellsByPath(this.core, sec, parentPara, pathJson, startRow, startCol, endRow, endCol);
  }

  splitTableCell(sec: number, parentPara: number, controlIdx: number, row: number, col: number): { ok: boolean; cellCount: number } {
    return api.splitTableCell(this.core, sec, parentPara, controlIdx, row, col);
  }

  splitTableCellByPath(sec: number, parentPara: number, pathJson: string, row: number, col: number): { ok: boolean; cellCount: number } {
    return api.splitTableCellByPath(this.core, sec, parentPara, pathJson, row, col);
  }

  splitTableCellInto(sec: number, parentPara: number, controlIdx: number, row: number, col: number, nRows: number, mCols: number, equalRowHeight: boolean, mergeFirst: boolean): { ok: boolean; cellCount: number } {
    return api.splitTableCellInto(this.core, sec, parentPara, controlIdx, row, col, nRows, mCols, equalRowHeight, mergeFirst);
  }

  splitTableCellIntoByPath(sec: number, parentPara: number, pathJson: string, row: number, col: number, nRows: number, mCols: number, equalRowHeight: boolean, mergeFirst: boolean): { ok: boolean; cellCount: number } {
    return api.splitTableCellIntoByPath(this.core, sec, parentPara, pathJson, row, col, nRows, mCols, equalRowHeight, mergeFirst);
  }

  splitTableCellsInRange(sec: number, parentPara: number, controlIdx: number, startRow: number, startCol: number, endRow: number, endCol: number, nRows: number, mCols: number, equalRowHeight: boolean): { ok: boolean; cellCount: number } {
    return api.splitTableCellsInRange(this.core, sec, parentPara, controlIdx, startRow, startCol, endRow, endCol, nRows, mCols, equalRowHeight);
  }

  splitTableCellsInRangeByPath(sec: number, parentPara: number, pathJson: string, startRow: number, startCol: number, endRow: number, endCol: number, nRows: number, mCols: number, equalRowHeight: boolean): { ok: boolean; cellCount: number } {
    return api.splitTableCellsInRangeByPath(this.core, sec, parentPara, pathJson, startRow, startCol, endRow, endCol, nRows, mCols, equalRowHeight);
  }

  copyTableCellRange(sec: number, parent: number, pathJson: string, startRow: number, startCol: number, endRow: number, endCol: number): { ok: boolean; text: string; html: string } {
    return api.copyTableCellRange(this.core, sec, parent, pathJson, startRow, startCol, endRow, endCol);
  }

  clearTableCellRange(sec: number, parent: number, pathJson: string, startRow: number, startCol: number, endRow: number, endCol: number): { ok: boolean } {
    return api.clearTableCellRange(this.core, sec, parent, pathJson, startRow, startCol, endRow, endCol);
  }

  pasteTableCellRange(sec: number, parent: number, pathJson: string, startRow: number, startCol: number): { ok: boolean } {
    return api.pasteTableCellRange(this.core, sec, parent, pathJson, startRow, startCol);
  }

  copyTableCellsTransposed(sec: number, parentPara: number, controlIdx: number, startRow: number, startCol: number, endRow: number, endCol: number): TableTransposeResult {
    return api.copyTableCellsTransposed(this.core, sec, parentPara, controlIdx, startRow, startCol, endRow, endCol);
  }

  pasteTableCellsTransposed(sec: number, parentPara: number, controlIdx: number, startRow: number, startCol: number): TableTransposeResult {
    return api.pasteTableCellsTransposed(this.core, sec, parentPara, controlIdx, startRow, startCol);
  }

  transposeTableCellsInPlace(sec: number, parentPara: number, controlIdx: number): TableTransposeResult {
    return api.transposeTableCellsInPlace(this.core, sec, parentPara, controlIdx);
  }

  pasteTableCellsTransposedAsTable(sec: number, para: number, charOffset: number): TableTransposeResult {
    return api.pasteTableCellsTransposedAsTable(this.core, sec, para, charOffset);
  }

  hasTableTransposeClipboard(): boolean {
    return api.hasTableTransposeClipboard(this.core);
  }

  insertTableRow(sec: number, parentPara: number, controlIdx: number, rowIdx: number, below: boolean): { ok: boolean; rowCount: number; colCount: number } {
    return api.insertTableRow(this.core, sec, parentPara, controlIdx, rowIdx, below);
  }

  insertTableRowByPath(sec: number, parentPara: number, pathJson: string, rowIdx: number, below: boolean): { ok: boolean; rowCount: number; colCount: number } {
    return api.insertTableRowByPath(this.core, sec, parentPara, pathJson, rowIdx, below);
  }

  insertTableColumn(sec: number, parentPara: number, controlIdx: number, colIdx: number, right: boolean): { ok: boolean; rowCount: number; colCount: number } {
    return api.insertTableColumn(this.core, sec, parentPara, controlIdx, colIdx, right);
  }

  insertTableColumnByPath(sec: number, parentPara: number, pathJson: string, colIdx: number, right: boolean): { ok: boolean; rowCount: number; colCount: number } {
    return api.insertTableColumnByPath(this.core, sec, parentPara, pathJson, colIdx, right);
  }

  deleteTableRow(sec: number, parentPara: number, controlIdx: number, rowIdx: number): { ok: boolean; rowCount: number; colCount: number } {
    return api.deleteTableRow(this.core, sec, parentPara, controlIdx, rowIdx);
  }

  deleteTableRowByPath(sec: number, parentPara: number, pathJson: string, rowIdx: number): { ok: boolean; rowCount: number; colCount: number } {
    return api.deleteTableRowByPath(this.core, sec, parentPara, pathJson, rowIdx);
  }

  deleteTableColumn(sec: number, parentPara: number, controlIdx: number, colIdx: number): { ok: boolean; rowCount: number; colCount: number } {
    return api.deleteTableColumn(this.core, sec, parentPara, controlIdx, colIdx);
  }

  deleteTableColumnByPath(sec: number, parentPara: number, pathJson: string, colIdx: number): { ok: boolean; rowCount: number; colCount: number } {
    return api.deleteTableColumnByPath(this.core, sec, parentPara, pathJson, colIdx);
  }

  createTable(sec: number, para: number, charOffset: number, rows: number, cols: number): { ok: boolean; paraIdx: number; controlIdx: number } {
    return api.createTable(this.core, sec, para, charOffset, rows, cols);
  }

  createTableEx(options: {
    sectionIdx: number;
    paraIdx: number;
    charOffset: number;
    rowCount: number;
    colCount: number;
    treatAsChar?: boolean;
    colWidths?: number[];
    rowHeights?: number[];
  }): { ok: boolean; paraIdx: number; controlIdx: number } {
    return api.createTableEx(this.core, options);
  }

  evaluateTableFormula(sec: number, parentPara: number, controlIdx: number, targetRow: number, targetCol: number, formula: string, writeResult: boolean): string {
    return api.evaluateTableFormula(this.core, sec, parentPara, controlIdx, targetRow, targetCol, formula, writeResult);
  }

  evaluateTableFormulaEx(options: {
    sectionIdx: number; parentParaIdx: number; controlIdx: number;
    targetRow: number; targetCol: number; formula: string; writeResult: boolean;
    decimalPlaces?: number; thousandsSeparator?: boolean; prefix?: string; suffix?: string;
  }): { ok: boolean; value?: number; display?: string } {
    return api.evaluateTableFormulaEx(this.core, options);
  }

  insertPicture(sec: number, paraIdx: number, charOffset: number, cellPathJson: string, imageData: Uint8Array, width: number, height: number, naturalWidthPx: number, naturalHeightPx: number, extension: string, description: string = '', paperOffsetXHu?: number, paperOffsetYHu?: number, placement?: 'inline' | 'floating'): { ok: boolean; paraIdx: number; controlIdx: number; logicalOffset?: number; sectionIdx?: number; cellPath?: CellPathEntry[] } {
    return api.insertPicture(this.core, sec, paraIdx, charOffset, cellPathJson, imageData, width, height, naturalWidthPx, naturalHeightPx, extension, description, paperOffsetXHu, paperOffsetYHu, placement);
  }

  assignPictureImage(sec: number, parentParaIdx: number, cellPathJson: string, controlIdx: number, imageData: Uint8Array, naturalWidthPx: number, naturalHeightPx: number, extension: string): { ok: boolean; binDataId: number } {
    return api.assignPictureImage(this.core, sec, parentParaIdx, cellPathJson, controlIdx, imageData, naturalWidthPx, naturalHeightPx, extension);
  }

  getPageControlLayout(pageNum: number): { controls: import('./types').ControlLayoutItem[] } {
    return api.getPageControlLayout(this.core, pageNum);
  }

  getPageLineLayout(pageNum: number): { lines: import('./types').LineLayoutItem[] } {
    return api.getPageLineLayout(this.core, pageNum);
  }

  getPictureProperties(sec: number, para: number, ci: number): import('./types').PictureProperties {
    return api.getPictureProperties(this.core, sec, para, ci);
  }

  getHeaderFooterPictureProperties(sec: number, outerPara: number, outerCtrl: number, innerPara: number, innerCtrl: number): import('./types').PictureProperties {
    return api.getHeaderFooterPictureProperties(this.core, sec, outerPara, outerCtrl, innerPara, innerCtrl);
  }

  setHeaderFooterPictureProperties(sec: number, outerPara: number, outerCtrl: number, innerPara: number, innerCtrl: number, props: Record<string, unknown>): { ok: boolean } {
    return api.setHeaderFooterPictureProperties(this.core, sec, outerPara, outerCtrl, innerPara, innerCtrl, props);
  }

  getCellShapePropertiesByPath(sec: number, parentPara: number, cellPath: CellPathLike, innerControlIdx: number): import('./types').ShapeProperties {
    return api.getCellShapePropertiesByPath(this.core, sec, parentPara, cellPath, innerControlIdx);
  }

  getCellPicturePropertiesByPath(sec: number, parentPara: number, cellPath: CellPathLike, innerControlIdx: number): import('./types').PictureProperties {
    return api.getCellPicturePropertiesByPath(this.core, sec, parentPara, cellPath, innerControlIdx);
  }

  setCellShapePropertiesByPath(sec: number, parentPara: number, cellPath: CellPathLike, innerControlIdx: number, props: Record<string, unknown>): { ok: boolean } {
    return api.setCellShapePropertiesByPath(this.core, sec, parentPara, cellPath, innerControlIdx, props);
  }

  setPictureProperties(sec: number, para: number, ci: number, props: Record<string, unknown>): { ok: boolean } {
    return api.setPictureProperties(this.core, sec, para, ci, props);
  }

  setCellPicturePropertiesByPath(sec: number, parentPara: number, cellPath: CellPathLike, innerControlIdx: number, props: Record<string, unknown>): { ok: boolean } {
    return api.setCellPicturePropertiesByPath(this.core, sec, parentPara, cellPath, innerControlIdx, props);
  }

  getEquationProperties(sec: number, para: number, ci: number, cellIdx?: number, cellParaIdx?: number, innerControlIdx?: number): import('./types').EquationProperties {
    return api.getEquationProperties(this.core, sec, para, ci, cellIdx, cellParaIdx, innerControlIdx);
  }

  getEquationPropertiesByPath(sec: number, parentPara: number, cellPath: CellPathLike, innerControlIdx: number): import('./types').EquationProperties {
    return api.getEquationPropertiesByPath(this.core, sec, parentPara, cellPath, innerControlIdx);
  }

  getNoteEquationProperties(noteRef: import('./types').NoteControlRef): import('./types').EquationProperties {
    return api.getNoteEquationProperties(this.core, noteRef);
  }

  setEquationProperties(sec: number, para: number, ci: number, cellIdx: number | undefined, cellParaIdx: number | undefined, props: Record<string, unknown>, innerControlIdx?: number): { ok: boolean } {
    return api.setEquationProperties(this.core, sec, para, ci, cellIdx, cellParaIdx, props, innerControlIdx);
  }

  setEquationPropertiesByPath(sec: number, parentPara: number, cellPath: CellPathLike, innerControlIdx: number, props: Record<string, unknown>): { ok: boolean } {
    return api.setEquationPropertiesByPath(this.core, sec, parentPara, cellPath, innerControlIdx, props);
  }

  setNoteEquationProperties(noteRef: import('./types').NoteControlRef, props: Record<string, unknown>): { ok: boolean } {
    return api.setNoteEquationProperties(this.core, noteRef, props);
  }

  renderEquationPreview(script: string, fontSizeHwpunit: number, color: number, fontName?: string): string {
    return api.renderEquationPreview(this.core, script, fontSizeHwpunit, color, fontName);
  }

  deletePictureControl(sec: number, para: number, ci: number): { ok: boolean } {
    return api.deletePictureControl(this.core, sec, para, ci);
  }

  movePictureControlByPath(sec: number, fromParentPara: number, fromPath: CellPathLike, fromControl: number, toParentPara: number, toPath: CellPathLike, toCharOffset: number): { ok: boolean; moved: boolean; paraIdx: number; controlIdx: number; cellPath: CellPathEntry[]; charOffset: number } {
    return api.movePictureControlByPath(this.core, sec, fromParentPara, fromPath, fromControl, toParentPara, toPath, toCharOffset);
  }

  movePictureControl(sec: number, fromPara: number, fromCi: number, toPara: number, toCharOffset: number): { ok: boolean; paraIdx: number; controlIdx: number; moved: boolean } {
    return api.movePictureControl(this.core, sec, fromPara, fromCi, toPara, toCharOffset);
  }

  deleteCellPictureControlByPath(sec: number, parentPara: number, cellPath: CellPathLike, innerControlIdx: number): { ok: boolean } {
    return api.deleteCellPictureControlByPath(this.core, sec, parentPara, cellPath, innerControlIdx);
  }

  createShapeControl(params: Record<string, unknown>): { ok: boolean; paraIdx: number; controlIdx: number } {
    return api.createShapeControl(this.core, params);
  }

  getShapeProperties(sec: number, para: number, ci: number): import('./types').ShapeProperties {
    return api.getShapeProperties(this.core, sec, para, ci);
  }

  getShapeText(sec: number, para: number, ci: number): { ok: boolean; text: string } {
    return api.getShapeText(this.core, sec, para, ci);
  }

  setShapeProperties(sec: number, para: number, ci: number, props: Record<string, unknown>): { ok: boolean } {
    return api.setShapeProperties(this.core, sec, para, ci, props);
  }

  deleteShapeControl(sec: number, para: number, ci: number): { ok: boolean } {
    return api.deleteShapeControl(this.core, sec, para, ci);
  }

  deleteEquationControl(sec: number, para: number, ci: number): { ok: boolean } {
    return api.deleteEquationControl(this.core, sec, para, ci);
  }

  changeObjectZOrder(sec: number, para: number, ci: number, operation: string): { ok: boolean; zOrder?: number } {
    return api.changeObjectZOrder(this.core, sec, para, ci, operation);
  }

  groupShapes(sec: number, targets: { paraIdx: number; controlIdx: number }[]): { ok: boolean; paraIdx: number; controlIdx: number } {
    return api.groupShapes(this.core, sec, targets);
  }

  insertEquation(sec: number, para: number, charOffset: number, script: string, fontSizeHwpunit: number, color: number, logical = false): { ok: boolean; paraIdx: number; controlIdx: number } {
    return api.insertEquation(this.core, sec, para, charOffset, script, fontSizeHwpunit, color, logical);
  }

  promoteOleEquation(sec: number, para: number, ci: number): { ok: boolean; paraIdx: number; controlIdx: number; script: string } {
    return api.promoteOleEquation(this.core, sec, para, ci);
  }

  insertEquationInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, script: string, fontSizeHwpunit: number, color: number, logical = false): { ok: boolean; cellParaIdx: number; controlIdx: number } {
    return api.insertEquationInCell(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, charOffset, script, fontSizeHwpunit, color, logical);
  }

  insertEquationInCellByPath(sec: number, parentPara: number, cellPath: CellPathLike, charOffset: number, script: string, fontSizeHwpunit: number, color: number, logical = false): { ok: boolean; cellParaIdx: number; controlIdx: number } {
    return api.insertEquationInCellByPath(this.core, sec, parentPara, cellPath, charOffset, script, fontSizeHwpunit, color, logical);
  }

  deleteEquationControlInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, eqControlIdx: number): { ok: boolean } {
    return api.deleteEquationControlInCell(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, eqControlIdx);
  }

  deleteEquationControlInCellByPath(sec: number, parentPara: number, cellPath: CellPathLike, eqControlIdx: number): { ok: boolean } {
    return api.deleteEquationControlInCellByPath(this.core, sec, parentPara, cellPath, eqControlIdx);
  }

  getEquationScriptInCellAt(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, eqControlIdx: number): string | null {
    return api.getEquationScriptInCellAt(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, eqControlIdx);
  }

  getFontList(): Array<{ lang: number; id: number; name: string }> {
    return api.getFontList(this.core);
  }

  insertFootnote(sec: number, para: number, charOffset: number): { ok: boolean; paraIdx: number; controlIdx: number; footnoteNumber: number } {
    return api.insertFootnote(this.core, sec, para, charOffset);
  }

  insertEndnote(sec: number, para: number, charOffset: number): { ok: boolean; paraIdx: number; controlIdx: number; endnoteNumber: number } {
    return api.insertEndnote(this.core, sec, para, charOffset);
  }

  getEndnoteShape(sec: number): EndnoteShapeSettings {
    return api.getEndnoteShape(this.core, sec);
  }

  applyEndnoteShape(sec: number, settings: EndnoteShapeSettings): { ok: boolean } {
    return api.applyEndnoteShape(this.core, sec, settings);
  }

  getFootnoteInfo(sec: number, para: number, controlIdx: number): { ok: boolean; paraCount: number; totalTextLen: number; number: number; texts: string[] } {
    return api.getFootnoteInfo(this.core, sec, para, controlIdx);
  }

  getFootnoteAtCursor(sec: number, para: number, charOffset: number, direction: 'backward' | 'forward'): FootnoteAtCursorResult {
    return api.getFootnoteAtCursor(this.core, sec, para, charOffset, direction);
  }

  deleteFootnote(sec: number, para: number, controlIdx: number): DeleteFootnoteResult {
    return api.deleteFootnote(this.core, sec, para, controlIdx);
  }

  insertTextInFootnote(sec: number, para: number, controlIdx: number, fnParaIdx: number, charOffset: number, text: string): { ok: boolean; charOffset: number } {
    return api.insertTextInFootnote(this.core, sec, para, controlIdx, fnParaIdx, charOffset, text);
  }

  deleteTextInFootnote(sec: number, para: number, controlIdx: number, fnParaIdx: number, charOffset: number, count: number): { ok: boolean; charOffset: number; deletedText: string } {
    return api.deleteTextInFootnote(this.core, sec, para, controlIdx, fnParaIdx, charOffset, count);
  }

  splitParagraphInFootnote(sec: number, para: number, controlIdx: number, fnParaIdx: number, charOffset: number, removedParaMeta?: RemovedParaMeta): { ok: boolean; fnParaIndex: number; charOffset: number } {
    return api.splitParagraphInFootnote(this.core, sec, para, controlIdx, fnParaIdx, charOffset, removedParaMeta);
  }

  mergeParagraphInFootnote(sec: number, para: number, controlIdx: number, fnParaIdx: number): { ok: boolean; fnParaIndex: number; charOffset: number; removedParaMeta: RemovedParaMeta } {
    return api.mergeParagraphInFootnote(this.core, sec, para, controlIdx, fnParaIdx);
  }

  getPageFootnoteInfo(pageNum: number, footnoteIndex: number): { ok: boolean; sectionIdx: number; paraIdx: number; controlIdx: number; sourceType: string } | null {
    return api.getPageFootnoteInfo(this.core, pageNum, footnoteIndex);
  }

  pageHasFootnoteFootholds(pageNum: number): boolean {
    return api.pageHasFootnoteFootholds(this.core, pageNum);
  }

  hitTestFootnote(pageNum: number, x: number, y: number): { hit: boolean; footnoteIndex?: number } {
    return api.hitTestFootnote(this.core, pageNum, x, y);
  }

  hitTestInFootnote(pageNum: number, x: number, y: number): { hit: boolean; fnParaIndex?: number; charOffset?: number; footnoteIndex?: number; cursorRect?: { pageIndex: number; x: number; y: number; height: number } } {
    return api.hitTestInFootnote(this.core, pageNum, x, y);
  }

  getCursorRectInFootnote(pageNum: number, footnoteIndex: number, fnParaIdx: number, charOffset: number): { pageIndex: number; x: number; y: number; height: number } | null {
    return api.getCursorRectInFootnote(this.core, pageNum, footnoteIndex, fnParaIdx, charOffset);
  }

  getNoteEditInfo(sec: number, para: number, controlIdx: number): NoteEditInfo | null {
    return api.getNoteEditInfo(this.core, sec, para, controlIdx);
  }

  getCursorRectInNote(sec: number, para: number, controlIdx: number, noteParaIdx: number, charOffset: number): CursorRect | null {
    return api.getCursorRectInNote(this.core, sec, para, controlIdx, noteParaIdx, charOffset);
  }

  getParaPropertiesInFootnote(sec: number, para: number, controlIdx: number, fnParaIdx: number): ParaProperties {
    return api.getParaPropertiesInFootnote(this.core, sec, para, controlIdx, fnParaIdx);
  }

  applyParaFormatInFootnote(sec: number, para: number, controlIdx: number, fnParaIdx: number, propsJson: string): string {
    return api.applyParaFormatInFootnote(this.core, sec, para, controlIdx, fnParaIdx, propsJson);
  }

  getCharPropertiesInFootnote(sec: number, para: number, controlIdx: number, fnParaIdx: number, charOffset: number): CharProperties {
    return api.getCharPropertiesInFootnote(this.core, sec, para, controlIdx, fnParaIdx, charOffset);
  }

  applyCharFormatInFootnote(sec: number, para: number, controlIdx: number, fnParaIdx: number, startOffset: number, endOffset: number, propsJson: string): string {
    return api.applyCharFormatInFootnote(this.core, sec, para, controlIdx, fnParaIdx, startOffset, endOffset, propsJson);
  }

  setCharShapeIdInFootnote(sec: number, para: number, controlIdx: number, fnParaIdx: number, startOffset: number, endOffset: number, charShapeId: number): string {
    return api.setCharShapeIdInFootnote(this.core, sec, para, controlIdx, fnParaIdx, startOffset, endOffset, charShapeId);
  }

  setParaShapeIdInFootnote(sec: number, para: number, controlIdx: number, fnParaIdx: number, paraShapeId: number): string {
    return api.setParaShapeIdInFootnote(this.core, sec, para, controlIdx, fnParaIdx, paraShapeId);
  }

  moveLineEndpoint(sec: number, para: number, ci: number, sx: number, sy: number, ex: number, ey: number): void {
    return api.moveLineEndpoint(this.core, sec, para, ci, sx, sy, ex, ey);
  }

  updateConnectorsInSection(sec: number): void {
    return api.updateConnectorsInSection(this.core, sec);
  }

  ungroupShape(sec: number, para: number, ci: number): { ok: boolean } {
    return api.ungroupShape(this.core, sec, para, ci);
  }

  moveVertical(sec: number, para: number, charOffset: number, delta: number, preferredX: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number): MoveVerticalResult {
    return api.moveVertical(this.core, sec, para, charOffset, delta, preferredX, parentPara, controlIdx, cellIdx, cellParaIdx);
  }

  getCursorRectByPath(sec: number, parentPara: number, pathJson: string, charOffset: number): CursorRect {
    return api.getCursorRectByPath(this.core, sec, parentPara, pathJson, charOffset);
  }

  getCursorRectByPathNear(sec: number, parentPara: number, pathJson: string, charOffset: number, hintPage: number): CursorRect {
    return api.getCursorRectByPathNear(this.core, sec, parentPara, pathJson, charOffset, hintPage);
  }

  getCellInfoByPath(sec: number, parentPara: number, pathJson: string): CellInfo {
    return api.getCellInfoByPath(this.core, sec, parentPara, pathJson);
  }

  getTableDimensionsByPath(sec: number, parentPara: number, pathJson: string): TableDimensions {
    return api.getTableDimensionsByPath(this.core, sec, parentPara, pathJson);
  }

  getTableCellTargetByPath(sec: number, parentPara: number, pathJson: string, row: number, col: number, preferredParaIdx: number): TableCellTarget {
    return api.getTableCellTargetByPath(this.core, sec, parentPara, pathJson, row, col, preferredParaIdx);
  }

  getTableCellBboxesByPath(sec: number, parentPara: number, pathJson: string): CellBbox[] {
    return api.getTableCellBboxesByPath(this.core, sec, parentPara, pathJson);
  }

  moveVerticalByPath(sec: number, parentPara: number, pathJson: string, charOffset: number, delta: number, preferredX: number): MoveVerticalResult {
    return api.moveVerticalByPath(this.core, sec, parentPara, pathJson, charOffset, delta, preferredX);
  }

  getSelectionRects(sec: number, startPara: number, startOffset: number, endPara: number, endOffset: number, closeGaps?: boolean): SelectionRect[] {
    return api.getSelectionRects(this.core, sec, startPara, startOffset, endPara, endOffset, closeGaps);
  }

  getSelectionRectsInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, startCellPara: number, startOffset: number, endCellPara: number, endOffset: number, pageHints?: SelectionPageHints, closeGaps?: boolean): SelectionRect[] {
    return api.getSelectionRectsInCell(this.core, sec, parentPara, controlIdx, cellIdx, startCellPara, startOffset, endCellPara, endOffset, pageHints, closeGaps);
  }

  getSelectionRectsByPath(sec: number, parentPara: number, cellPath: unknown[], startCellPara: number, startOffset: number, endCellPara: number, endOffset: number, closeGaps?: boolean): SelectionRect[] {
    return api.getSelectionRectsByPath(this.core, sec, parentPara, cellPath, startCellPara, startOffset, endCellPara, endOffset, closeGaps);
  }

  getTableBoundaryPosition(request: {
    sectionIndex: number;
    parentParaIndex: number;
    containerPath: CellPathEntry[];
    hostParaIndex: number;
    controlIndex: number;
    after: boolean;
  }): { paraIdx: number; charOffset: number } | null {
    return api.getTableBoundaryPosition(this.core, request);
  }

  getTableControlsInSelection(sec: number, parentPara: number, containerPath: CellPathEntry[], startPara: number, startOffset: number, endPara: number, endOffset: number): Array<{ sec: number; ppi: number; ci: number; cellPath?: CellPathEntry[] }> {
    return api.getTableControlsInSelection(this.core, sec, parentPara, containerPath, startPara, startOffset, endPara, endOffset);
  }

  getSelectionRectsInFootnote(pageNum: number, footnoteIndex: number, startFnPara: number, startOffset: number, endFnPara: number, endOffset: number): SelectionRect[] {
    return api.getSelectionRectsInFootnote(this.core, pageNum, footnoteIndex, startFnPara, startOffset, endFnPara, endOffset);
  }

  deleteRange(sec: number, startPara: number, startOffset: number, endPara: number, endOffset: number, logical = false): { ok: boolean; paraIdx: number; charOffset: number } {
    return api.deleteRange(this.core, sec, startPara, startOffset, endPara, endOffset, logical);
  }

  deleteRangeAcrossSections(startSec: number, startPara: number, startOffset: number, endSec: number, endPara: number, endOffset: number, logical = false): { ok: boolean; sectionIdx: number; paraIdx: number; charOffset: number } {
    return api.deleteRangeAcrossSections(this.core, startSec, startPara, startOffset, endSec, endPara, endOffset, logical);
  }

  deleteRangeInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, startCellPara: number, startOffset: number, endCellPara: number, endOffset: number): { ok: boolean; paraIdx: number; charOffset: number } {
    return api.deleteRangeInCell(this.core, sec, parentPara, controlIdx, cellIdx, startCellPara, startOffset, endCellPara, endOffset);
  }

  copySelection(sec: number, startPara: number, startOffset: number, endPara: number, endOffset: number): string {
    return api.copySelection(this.core, sec, startPara, startOffset, endPara, endOffset);
  }

  copySelectionAcrossSections(startSec: number, startPara: number, startOffset: number, endSec: number, endPara: number, endOffset: number): string {
    return api.copySelectionAcrossSections(this.core, startSec, startPara, startOffset, endSec, endPara, endOffset);
  }

  copySelectionInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, startCellPara: number, startOffset: number, endCellPara: number, endOffset: number): string {
    return api.copySelectionInCell(this.core, sec, parentPara, controlIdx, cellIdx, startCellPara, startOffset, endCellPara, endOffset);
  }

  copySelectionInCellByPath(sec: number, parentPara: number, pathJson: string, startCellPara: number, startOffset: number, endCellPara: number, endOffset: number): string {
    return api.copySelectionInCellByPath(this.core, sec, parentPara, pathJson, startCellPara, startOffset, endCellPara, endOffset);
  }

  pasteInternal(sec: number, para: number, charOffset: number): string {
    return api.pasteInternal(this.core, sec, para, charOffset);
  }

  pasteDocumentBlock(sourceBytes: Uint8Array, sourceSection: number, startPara: number, endPara: number, targetSection: number, targetPara: number, targetCharOffset: number): string {
    return api.pasteDocumentBlock(this.core, sourceBytes, sourceSection, startPara, endPara, targetSection, targetPara, targetCharOffset);
  }

  pasteInternalInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number): string {
    return api.pasteInternalInCell(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, charOffset);
  }

  pasteInternalInCellByPath(sec: number, parentPara: number, pathJson: string, charOffset: number): string {
    return api.pasteInternalInCellByPath(this.core, sec, parentPara, pathJson, charOffset);
  }

  hasInternalClipboard(): boolean {
    return api.hasInternalClipboard(this.core);
  }

  getClipboardText(): string {
    return api.getClipboardText(this.core);
  }

  copyControl(sec: number, para: number, ci: number, cellPathJson = ''): string {
    return api.copyControl(this.core, sec, para, ci, cellPathJson);
  }

  exportControlHtml(sec: number, para: number, ci: number, cellPathJson = ''): string {
    return api.exportControlHtml(this.core, sec, para, ci, cellPathJson);
  }

  getControlImageData(sec: number, para: number, ci: number, cellPathJson = ''): Uint8Array {
    return api.getControlImageData(this.core, sec, para, ci, cellPathJson);
  }

  getControlImageMime(sec: number, para: number, ci: number, cellPathJson = ''): string {
    return api.getControlImageMime(this.core, sec, para, ci, cellPathJson);
  }

  clipboardHasControl(): boolean {
    return api.clipboardHasControl(this.core);
  }

  clipboardIsSingleControl(): boolean {
    return api.clipboardIsSingleControl(this.core);
  }

  pasteControl(sec: number, para: number, charOffset: number): string {
    return api.pasteControl(this.core, sec, para, charOffset);
  }

  exportSelectionHtml(sec: number, startPara: number, startOffset: number, endPara: number, endOffset: number): string {
    return api.exportSelectionHtml(this.core, sec, startPara, startOffset, endPara, endOffset);
  }

  exportSelectionAcrossSectionsHtml(startSec: number, startPara: number, startOffset: number, endSec: number, endPara: number, endOffset: number): string {
    return api.exportSelectionAcrossSectionsHtml(this.core, startSec, startPara, startOffset, endSec, endPara, endOffset);
  }

  exportSelectionInCellHtml(sec: number, parentPara: number, controlIdx: number, cellIdx: number, startCellPara: number, startOffset: number, endCellPara: number, endOffset: number): string {
    return api.exportSelectionInCellHtml(this.core, sec, parentPara, controlIdx, cellIdx, startCellPara, startOffset, endCellPara, endOffset);
  }

  exportSelectionInCellByPathHtml(sec: number, parentPara: number, pathJson: string, startCellPara: number, startOffset: number, endCellPara: number, endOffset: number): string {
    return api.exportSelectionInCellByPathHtml(this.core, sec, parentPara, pathJson, startCellPara, startOffset, endCellPara, endOffset);
  }

  pasteHwpJson(sec: number, para: number, charOffset: number, json: string): string {
    return api.pasteHwpJson(this.core, sec, para, charOffset, json);
  }

  pasteHtml(sec: number, para: number, charOffset: number, html: string): string {
    return api.pasteHtml(this.core, sec, para, charOffset, html);
  }

  pasteHtmlInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number, html: string): string {
    return api.pasteHtmlInCell(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, charOffset, html);
  }

  pasteHtmlInCellByPath(sec: number, parentPara: number, pathJson: string, charOffset: number, html: string): string {
    return api.pasteHtmlInCellByPath(this.core, sec, parentPara, pathJson, charOffset, html);
  }

  getCharPropertiesAt(sec: number, para: number, charOffset: number): CharProperties {
    return api.getCharPropertiesAt(this.core, sec, para, charOffset);
  }

  getCellCharPropertiesAt(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, charOffset: number): CharProperties {
    return api.getCellCharPropertiesAt(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, charOffset);
  }

  getCellCharPropertiesAtByPath(sec: number, parentPara: number, pathJson: string, charOffset: number): CharProperties {
    return api.getCellCharPropertiesAtByPath(this.core, sec, parentPara, pathJson, charOffset);
  }

  applyCharFormat(sec: number, para: number, startOffset: number, endOffset: number, propsJson: string): string {
    return api.applyCharFormat(this.core, sec, para, startOffset, endOffset, propsJson);
  }

  getCharShapeRuns(sec: number, para: number, start: number, end: number): CharShapeRun[] {
    return api.getCharShapeRuns(this.core, sec, para, start, end);
  }

  setCharShapeRuns(sec: number, para: number, start: number, end: number, runs: CharShapeRun[]): string {
    return api.setCharShapeRuns(this.core, sec, para, start, end, runs);
  }

  getCharShapeRunsInCellByPath(sec: number, para: number, path: string, start: number, end: number): CharShapeRun[] {
    return api.getCharShapeRunsInCellByPath(this.core, sec, para, path, start, end);
  }

  setCharShapeRunsInCellByPath(sec: number, para: number, path: string, start: number, end: number, runs: CharShapeRun[]): string {
    return api.setCharShapeRunsInCellByPath(this.core, sec, para, path, start, end, runs);
  }

  applyCharFormatAcrossSections(startSec: number, startPara: number, startOffset: number, endSec: number, endPara: number, endOffset: number, propsJson: string): string {
    return api.applyCharFormatAcrossSections(this.core, startSec, startPara, startOffset, endSec, endPara, endOffset, propsJson);
  }

  setCharShapeId(sec: number, para: number, startOffset: number, endOffset: number, charShapeId: number): string {
    return api.setCharShapeId(this.core, sec, para, startOffset, endOffset, charShapeId);
  }

  applyCharFormatInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, startOffset: number, endOffset: number, propsJson: string): string {
    return api.applyCharFormatInCell(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, startOffset, endOffset, propsJson);
  }

  applyCharFormatInCellByPath(sec: number, parentPara: number, pathJson: string, startOffset: number, endOffset: number, propsJson: string): string {
    return api.applyCharFormatInCellByPath(this.core, sec, parentPara, pathJson, startOffset, endOffset, propsJson);
  }

  setCharShapeIdInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, startOffset: number, endOffset: number, charShapeId: number): string {
    return api.setCharShapeIdInCell(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, startOffset, endOffset, charShapeId);
  }

  setCharShapeIdInCellByPath(sec: number, parentPara: number, pathJson: string, startOffset: number, endOffset: number, charShapeId: number): string {
    return api.setCharShapeIdInCellByPath(this.core, sec, parentPara, pathJson, startOffset, endOffset, charShapeId);
  }

  findOrCreateFontId(name: string): number {
    return api.findOrCreateFontId(this.core, name);
  }

  prepareFontFamilies(names: string[]): Promise<void> {
    return api.prepareFontFamilies(this.core, names);
  }

  findOrCreateFontIdForLang(lang: number, name: string): number {
    return api.findOrCreateFontIdForLang(this.core, lang, name);
  }

  getParaPropertiesAt(sec: number, para: number): ParaProperties {
    return api.getParaPropertiesAt(this.core, sec, para);
  }

  getCellParaPropertiesAt(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number): ParaProperties {
    return api.getCellParaPropertiesAt(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx);
  }

  setNumberingRestart(sec: number, para: number, mode: number, startNum: number): string {
    return api.setNumberingRestart(this.core, sec, para, mode, startNum);
  }

  getPageHide(sec: number, para: number): Record<string, unknown> {
    return api.getPageHide(this.core, sec, para);
  }

  setPageHide(sec: number, para: number, hideHeader: boolean, hideFooter: boolean, hideMaster: boolean, hideBorder: boolean, hideFill: boolean, hidePageNum: boolean): string {
    return api.setPageHide(this.core, sec, para, hideHeader, hideFooter, hideMaster, hideBorder, hideFill, hidePageNum);
  }

  applyParaFormat(sec: number, para: number, propsJson: string): string {
    return api.applyParaFormat(this.core, sec, para, propsJson);
  }

  applyParaFormatAcrossSections(startSec: number, startPara: number, endSec: number, endPara: number, propsJson: string): string {
    return api.applyParaFormatAcrossSections(this.core, startSec, startPara, endSec, endPara, propsJson);
  }

  applyDocumentParaSpacing(spacing: { lineSpacing: number; spacingBefore: number; spacingAfter: number }): { ok: boolean; changed: number; pageCount: number } {
    return api.applyDocumentParaSpacing(this.core, spacing);
  }

  getDocumentParaSpacing(): { count: number; lineSpacing: number | null; spacingBefore: number | null; spacingAfter: number | null } {
    return api.getDocumentParaSpacing(this.core);
  }

  setParaShapeId(sec: number, para: number, paraShapeId: number): string {
    return api.setParaShapeId(this.core, sec, para, paraShapeId);
  }

  applyParaFormatInCell(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, propsJson: string): string {
    return api.applyParaFormatInCell(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, propsJson);
  }

  setCellParaShapeId(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, paraShapeId: number): string {
    return api.setCellParaShapeId(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, paraShapeId);
  }

  getCellParaPropertiesAtByPath(sec: number, parentPara: number, pathJson: string): ParaProperties {
    return api.getCellParaPropertiesAtByPath(this.core, sec, parentPara, pathJson);
  }

  applyParaFormatInCellByPath(sec: number, parentPara: number, pathJson: string, propsJson: string): string {
    return api.applyParaFormatInCellByPath(this.core, sec, parentPara, pathJson, propsJson);
  }

  setCellParaShapeIdByPath(sec: number, parentPara: number, pathJson: string, paraShapeId: number): string {
    return api.setCellParaShapeIdByPath(this.core, sec, parentPara, pathJson, paraShapeId);
  }

  getParaPropertiesInHf(sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number): ParaProperties {
    return api.getParaPropertiesInHf(this.core, sec, isHeader, applyTo, hfParaIdx);
  }

  applyParaFormatInHf(sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, propsJson: string): string {
    return api.applyParaFormatInHf(this.core, sec, isHeader, applyTo, hfParaIdx, propsJson);
  }

  getCharPropertiesInHf(sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, charOffset: number): CharProperties {
    return api.getCharPropertiesInHf(this.core, sec, isHeader, applyTo, hfParaIdx, charOffset);
  }

  applyCharFormatInHf(sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, startOffset: number, endOffset: number, propsJson: string): string {
    return api.applyCharFormatInHf(this.core, sec, isHeader, applyTo, hfParaIdx, startOffset, endOffset, propsJson);
  }

  setCharShapeIdInHf(sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, startOffset: number, endOffset: number, charShapeId: number): string {
    return api.setCharShapeIdInHf(this.core, sec, isHeader, applyTo, hfParaIdx, startOffset, endOffset, charShapeId);
  }

  setParaShapeIdInHf(sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, paraShapeId: number): string {
    return api.setParaShapeIdInHf(this.core, sec, isHeader, applyTo, hfParaIdx, paraShapeId);
  }

  insertFieldInHf(sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, charOffset: number, fieldType: number): { ok: boolean; charOffset: number; insertedAt: number; insertedLength: number } {
    return api.insertFieldInHf(this.core, sec, isHeader, applyTo, hfParaIdx, charOffset, fieldType);
  }

  applyHfTemplate(sec: number, isHeader: boolean, applyTo: number, templateId: number): { ok: boolean } {
    return api.applyHfTemplate(this.core, sec, isHeader, applyTo, templateId);
  }

  getStyleList(): Array<{ id: number; name: string; englishName: string; type: number; nextStyleId: number; paraShapeId: number; charShapeId: number }> {
    return api.getStyleList(this.core);
  }

  getStyleDetail(styleId: number): { charProps: import('./types').CharProperties; paraProps: import('./types').ParaProperties } {
    return api.getStyleDetail(this.core, styleId);
  }

  updateStyle(styleId: number, json: string): boolean {
    return api.updateStyle(this.core, styleId, json);
  }

  updateStyleShapes(styleId: number, charModsJson: string, paraModsJson: string): boolean {
    return api.updateStyleShapes(this.core, styleId, charModsJson, paraModsJson);
  }

  createStyle(json: string): number {
    return api.createStyle(this.core, json);
  }

  deleteStyle(styleId: number): boolean {
    return api.deleteStyle(this.core, styleId);
  }

  getNumberingList(): Array<{ id: number; levelFormats: string[]; numberFormats?: number[]; startNumber: number }> {
    return api.getNumberingList(this.core);
  }

  getBulletList(): Array<{ id: number; char: string; rawCode: number }> {
    return api.getBulletList(this.core);
  }

  ensureDefaultNumbering(): number {
    return api.ensureDefaultNumbering(this.core);
  }

  createNumbering(json: string): number {
    return api.createNumbering(this.core, json);
  }

  ensureDefaultBullet(bulletChar: string): number {
    return api.ensureDefaultBullet(this.core, bulletChar);
  }

  getStyleAt(sec: number, para: number): { id: number; name: string } {
    return api.getStyleAt(this.core, sec, para);
  }

  getCellStyleAt(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number): { id: number; name: string } {
    return api.getCellStyleAt(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx);
  }

  applyStyle(sec: number, para: number, styleId: number): { ok: boolean } {
    return api.applyStyle(this.core, sec, para, styleId);
  }

  applyCellStyle(sec: number, parentPara: number, controlIdx: number, cellIdx: number, cellParaIdx: number, styleId: number): { ok: boolean } {
    return api.applyCellStyle(this.core, sec, parentPara, controlIdx, cellIdx, cellParaIdx, styleId);
  }

  setShowParagraphMarks(enabled: boolean): void {
    return api.setShowParagraphMarks(this.core, enabled);
  }

  getShowParagraphMarks(): boolean {
    return api.getShowParagraphMarks(this.core);
  }

  getShowControlCodes(): boolean {
    return api.getShowControlCodes(this.core);
  }

  setShowControlCodes(enabled: boolean): void {
    return api.setShowControlCodes(this.core, enabled);
  }

  getShowTransparentBorders(): boolean {
    return api.getShowTransparentBorders(this.core);
  }

  setShowTransparentBorders(enabled: boolean): void {
    return api.setShowTransparentBorders(this.core, enabled);
  }

  setClipEnabled(enabled: boolean): void {
    return api.setClipEnabled(this.core, enabled);
  }

  capturePictureTransform(target: Record<string, unknown>): number {
    return api.capturePictureTransform(this.core, target);
  }

  swapPictureTransform(id: number): void {
    return api.swapPictureTransform(this.core, id);
  }

  discardPictureTransform(id: number): void {
    return api.discardPictureTransform(this.core, id);
  }

  captureParagraph(sec: number, para: number): number | null {
    return api.captureParagraph(this.core, sec, para);
  }

  restoreCapturedParagraph(id: number, sec: number, para: number): void {
    return api.restoreCapturedParagraph(this.core, id, sec, para);
  }

  discardParagraphCapture(id: number): void {
    return api.discardParagraphCapture(this.core, id);
  }

  getParagraphContentDigest(sec: number, para: number): string | null {
    return api.getParagraphContentDigest(this.core, sec, para);
  }

  saveSnapshot(): number {
    return api.saveSnapshot(this.core);
  }

  shareSnapshot(sourceId: number): number {
    return api.shareSnapshot(this.core, sourceId);
  }

  shareSnapshotExact(sourceId: number): number | null {
    return api.shareSnapshotExact(this.core, sourceId);
  }

  restoreSnapshot(id: number): void {
    return api.restoreSnapshot(this.core, id);
  }

  discardSnapshot(id: number): void {
    return api.discardSnapshot(this.core, id);
  }

  getHeaderFooter(sectionIdx: number, isHeader: boolean, applyTo: number): string {
    return api.getHeaderFooter(this.core, sectionIdx, isHeader, applyTo);
  }

  createHeaderFooter(sectionIdx: number, isHeader: boolean, applyTo: number): string {
    return api.createHeaderFooter(this.core, sectionIdx, isHeader, applyTo);
  }

  insertTextInHeaderFooter(sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, charOffset: number, text: string): string {
    return api.insertTextInHeaderFooter(this.core, sec, isHeader, applyTo, hfParaIdx, charOffset, text);
  }

  deleteTextInHeaderFooter(sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, charOffset: number, count: number): string {
    return api.deleteTextInHeaderFooter(this.core, sec, isHeader, applyTo, hfParaIdx, charOffset, count);
  }

  splitParagraphInHeaderFooter(sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, charOffset: number, removedParaMeta?: RemovedParaMeta): string {
    return api.splitParagraphInHeaderFooter(this.core, sec, isHeader, applyTo, hfParaIdx, charOffset, removedParaMeta);
  }

  mergeParagraphInHeaderFooter(sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number): string {
    return api.mergeParagraphInHeaderFooter(this.core, sec, isHeader, applyTo, hfParaIdx);
  }

  getHeaderFooterParaInfo(sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number): string {
    return api.getHeaderFooterParaInfo(this.core, sec, isHeader, applyTo, hfParaIdx);
  }

  replaceRangeInHeaderFooter(sec: number, isHeader: boolean, applyTo: number, startHfParaIdx: number, startOffset: number, endHfParaIdx: number, endOffset: number, replacementText: string): { ok: boolean; hfParaIndex: number; charOffset: number } {
    return api.replaceRangeInHeaderFooter(this.core, sec, isHeader, applyTo, startHfParaIdx, startOffset, endHfParaIdx, endOffset, replacementText);
  }

  copySelectionInHeaderFooter(sec: number, isHeader: boolean, applyTo: number, startHfParaIdx: number, startOffset: number, endHfParaIdx: number, endOffset: number): { ok: boolean; text: string } {
    return api.copySelectionInHeaderFooter(this.core, sec, isHeader, applyTo, startHfParaIdx, startOffset, endHfParaIdx, endOffset);
  }

  getCharPropertiesInHeaderFooter(sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, charOffset: number): CharProperties {
    return api.getCharPropertiesInHeaderFooter(this.core, sec, isHeader, applyTo, hfParaIdx, charOffset);
  }

  applyCharFormatInHeaderFooter(sec: number, isHeader: boolean, applyTo: number, startHfParaIdx: number, startOffset: number, endHfParaIdx: number, endOffset: number, propsJson: string): string {
    return api.applyCharFormatInHeaderFooter(this.core, sec, isHeader, applyTo, startHfParaIdx, startOffset, endHfParaIdx, endOffset, propsJson);
  }

  getCursorRectInHeaderFooter(sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number, charOffset: number, previewPage: number): CursorRect {
    return api.getCursorRectInHeaderFooter(this.core, sec, isHeader, applyTo, hfParaIdx, charOffset, previewPage);
  }

  getSelectionRectsInHeaderFooter(sec: number, isHeader: boolean, applyTo: number, pageNum: number, startHfParaIdx: number, startOffset: number, endHfParaIdx: number, endOffset: number): SelectionRect[] {
    return api.getSelectionRectsInHeaderFooter(this.core, sec, isHeader, applyTo, pageNum, startHfParaIdx, startOffset, endHfParaIdx, endOffset);
  }

  hitTestHeaderFooter(pageNum: number, x: number, y: number): { hit: boolean; isHeader?: boolean; sectionIndex?: number; applyTo?: number } {
    return api.hitTestHeaderFooter(this.core, pageNum, x, y);
  }

  getHeaderFooterEditTarget(pageNum: number, isHeader: boolean): { sectionIndex: number; applyTo: number } {
    return api.getHeaderFooterEditTarget(this.core, pageNum, isHeader);
  }

  getHeaderFooterPreviewPage(sectionIdx: number): number {
    return api.getHeaderFooterPreviewPage(this.core, sectionIdx);
  }

  hitTestInHeaderFooter(pageNum: number, isHeader: boolean, x: number, y: number): { hit: boolean; sectionIndex?: number; applyTo?: number; paraIndex?: number; charOffset?: number; cursorRect?: { pageIndex: number; x: number; y: number; height: number } } {
    return api.hitTestInHeaderFooter(this.core, pageNum, isHeader, x, y);
  }

  hitTestInHeaderFooterTarget(pageNum: number, sectionIdx: number, isHeader: boolean, applyTo: number, x: number, y: number): { hit: boolean; sectionIndex?: number; applyTo?: number; paraIndex?: number; charOffset?: number; cursorRect?: { pageIndex: number; x: number; y: number; height: number } } {
    return api.hitTestInHeaderFooterTarget(this.core, pageNum, sectionIdx, isHeader, applyTo, x, y);
  }

  renderHeaderFooterEditPreviewToCanvas(pageNum: number, sectionIdx: number, isHeader: boolean, applyTo: number, canvas: HTMLCanvasElement, scale: number): void {
    return api.renderHeaderFooterEditPreviewToCanvas(this.core, pageNum, sectionIdx, isHeader, applyTo, canvas, scale);
  }

  deleteHeaderFooter(sectionIdx: number, isHeader: boolean, applyTo: number): void {
    return api.deleteHeaderFooter(this.core, sectionIdx, isHeader, applyTo);
  }

  getHeaderFooterList(currentSectionIdx: number, currentIsHeader: boolean, currentApplyTo: number): { ok: boolean; items: { sectionIdx: number; isHeader: boolean; applyTo: number; label: string }[]; currentIndex: number } {
    return api.getHeaderFooterList(this.core, currentSectionIdx, currentIsHeader, currentApplyTo);
  }

  toggleHideHeaderFooter(pageIndex: number, isHeader: boolean): { hidden: boolean } {
    return api.toggleHideHeaderFooter(this.core, pageIndex, isHeader);
  }

  navigateHeaderFooterByPage(currentPage: number, isHeader: boolean, direction: number): { ok: boolean; pageIndex?: number; sectionIdx?: number; isHeader?: boolean; applyTo?: number } {
    return api.navigateHeaderFooterByPage(this.core, currentPage, isHeader, direction);
  }

  getFieldList(): Array<{
    fieldId: number;
    fieldType: string;
    name: string;
    guide: string;
    command: string;
    value: string;
    location: { sectionIndex: number; paraIndex: number; path?: Array<any> };
    startCharIdx?: number;
    endCharIdx?: number;
    editableInForm?: boolean;
  }> {
    return api.getFieldList(this.core);
  }

  getFieldValue(fieldId: number): { ok: boolean; value: string } {
    return api.getFieldValue(this.core, fieldId);
  }

  getFieldValueByName(name: string): { ok: boolean; fieldId: number; value: string } {
    return api.getFieldValueByName(this.core, name);
  }

  setFieldValue(fieldId: number, value: string): { ok: boolean; fieldId: number; oldValue: string; newValue: string } {
    return api.setFieldValue(this.core, fieldId, value);
  }

  setFieldValueByName(name: string, value: string): { ok: boolean; fieldId: number; oldValue: string; newValue: string } {
    return api.setFieldValueByName(this.core, name, value);
  }

  getHyperlinkContext(target: HyperlinkTarget): HyperlinkContext {
    return api.getHyperlinkContext(this.core, target);
  }

  insertHyperlink(target: HyperlinkTarget, start: number, end: number, uri: string): number {
    return api.insertHyperlink(this.core, target, start, end, uri);
  }

  updateHyperlink(target: HyperlinkTarget, fieldId: number, uri: string): boolean {
    return api.updateHyperlink(this.core, target, fieldId, uri);
  }

  replaceHyperlinkText(target: HyperlinkTarget, fieldId: number, text: string): boolean {
    return api.replaceHyperlinkText(this.core, target, fieldId, text);
  }

  removeHyperlink(target: HyperlinkTarget, fieldId: number, restoreFormatting = false): void {
    return api.removeHyperlink(this.core, target, fieldId, restoreFormatting);
  }

  getFieldInfoAt(pos: DocumentPosition): FieldInfoResult {
    return api.getFieldInfoAt(this.core, pos);
  }

  removeFieldAt(pos: DocumentPosition): { ok: boolean } {
    return api.removeFieldAt(this.core, pos);
  }

  setActiveField(pos: DocumentPosition): boolean {
    return api.setActiveField(this.core, pos);
  }

  clearActiveField(): void {
    return api.clearActiveField(this.core);
  }

  getClickHereProps(fieldId: number): { ok: boolean; guide?: string; memo?: string; name?: string; editable?: boolean } {
    return api.getClickHereProps(this.core, fieldId);
  }

  updateClickHereProps(fieldId: number, guide: string, memo: string, name: string, editable: boolean): { ok: boolean } {
    return api.updateClickHereProps(this.core, fieldId, guide, memo, name, editable);
  }

  insertClickHereField(pos: DocumentPosition, guide: string, memo: string, name: string, editable: boolean): { ok: boolean; fieldId?: number; charOffset?: number } {
    return api.insertClickHereField(this.core, pos, guide, memo, name, editable);
  }

  getFormObjectAt(pageNum: number, x: number, y: number): import('./types').FormObjectHitResult {
    return api.getFormObjectAt(this.core, pageNum, x, y);
  }

  getFormValue(sec: number, para: number, ci: number): import('./types').FormValueResult {
    return api.getFormValue(this.core, sec, para, ci);
  }

  setFormValue(sec: number, para: number, ci: number, valueJson: string): { ok: boolean } {
    return api.setFormValue(this.core, sec, para, ci, valueJson);
  }

  setFormValueInCell(sec: number, tablePara: number, tableCi: number, cellIdx: number, cellPara: number, formCi: number, valueJson: string): { ok: boolean } {
    return api.setFormValueInCell(this.core, sec, tablePara, tableCi, cellIdx, cellPara, formCi, valueJson);
  }

  getFormObjectInfo(sec: number, para: number, ci: number): import('./types').FormObjectInfoResult {
    return api.getFormObjectInfo(this.core, sec, para, ci);
  }

  searchText(query: string, fromSec: number, fromPara: number, fromChar: number, forward: boolean, caseSensitive: boolean, fromPath: import('./types').CellPathEntry[] = []): import('./types').SearchResult {
    return api.searchText(this.core, query, fromSec, fromPara, fromChar, forward, caseSensitive, fromPath);
  }

  searchAllText(query: string, caseSensitive: boolean, includeCells: boolean = false): import('./types').SearchHit[] {
    return api.searchAllText(this.core, query, caseSensitive, includeCells);
  }

  replaceText(sec: number, para: number, charOffset: number, length: number, newText: string): import('./types').ReplaceResult {
    return api.replaceText(this.core, sec, para, charOffset, length, newText);
  }

  replaceOne(query: string, newText: string, caseSensitive: boolean): import('./types').ReplaceOneResult {
    return api.replaceOne(this.core, query, newText, caseSensitive);
  }

  replaceAll(query: string, newText: string, caseSensitive: boolean): import('./types').ReplaceAllResult {
    return api.replaceAll(this.core, query, newText, caseSensitive);
  }

  getPositionOfPage(globalPage: number): { ok: boolean; sec?: number; para?: number; charOffset?: number; continued?: boolean } {
    return api.getPositionOfPage(this.core, globalPage);
  }

  getPageOfPosition(sectionIdx: number, paraIdx: number): import('./types').PageOfPositionResult {
    return api.getPageOfPosition(this.core, sectionIdx, paraIdx);
  }

  getOutlineStructure(mode: string): {
    mode: string; node_count: number; preamble?: string[];
    roots: Array<Record<string, unknown>>;
  } | null {
    return api.getOutlineStructure(this.core, mode);
  }

  getBookmarks(): BookmarkInfo[] {
    return api.getBookmarks(this.core);
  }

  addBookmark(sec: number, para: number, charOffset: number, name: string): { ok: boolean; error?: string } {
    return api.addBookmark(this.core, sec, para, charOffset, name);
  }

  deleteBookmark(sec: number, para: number, ctrlIdx: number): { ok: boolean; error?: string } {
    return api.deleteBookmark(this.core, sec, para, ctrlIdx);
  }

  renameBookmark(sec: number, para: number, ctrlIdx: number, newName: string): { ok: boolean; error?: string } {
    return api.renameBookmark(this.core, sec, para, ctrlIdx, newName);
  }

  dispose(): void {
    return api.dispose(this.core);
  }
}
