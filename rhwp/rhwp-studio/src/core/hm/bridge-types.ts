/**
 * WasmBridge 공개 API가 쓰는 타입 모음. HeemangEngine 위의 브리지와 도메인 모듈이 함께 쓴다.
 */
import type { HmlSaveBlocker } from '../hml-save-capability';
import type { TextRemoval } from '../local-text-replace-result';
import type { DocumentInfo } from '../types';

export type { DocumentInfo, PageInfo, PageDef, SectionDef, PageBorderFillSettings, EndnoteShapeSettings, NoteEditInfo, CursorRect, HitTestResult, BodyFootnoteMarkerHit, FootnoteAtCursorResult, DeleteFootnoteResult, LineInfo, TableDimensions, CellInfo, TableCellTarget, CellBbox, CellProperties, TableProperties, DocumentPosition, MoveVerticalResult, SelectionRect, CharProperties, ParaProperties, CellPathEntry, CellPathLike, NavContextEntry, FieldInfoResult, BookmarkInfo, LayerRenderProfile, PageLayerTree, CanvasKitDocumentPreflight, CharShapeRun } from '../types';
export type { NoteRef, NoteCaret, NoteHit, NoteContentInfo, NoteListEntry } from '../types';
export type { HyperlinkTarget, HyperlinkContext } from '../hyperlink';
export type { HmlSaveBlocker, HmlSaveState } from '../hml-save-capability';
export type { SelectionPageHints } from '../selection-page-hints';
export type { TextContent, TextRemoval, LocalBodyTextReplaceResult } from '../local-text-replace-result';
export type { RuntimeFontMetricsApi } from '../desktop-fonts';
export type { FileSystemFileHandleLike } from '../../command/file-system-access';


/**
 * 문단 병합으로 사라진 문단의 스코프 메타데이터 (Task #2342).
 *
 * 병합 결과에 실려 오고 undo 분할에 그대로 되돌려주는 불투명 값이다 — 스튜디오는
 * 내용을 해석하지 않는다.
 */
export type RemovedParaMeta = Record<string, unknown>;

/** HWPX 비표준 감지 경고 리포트 (#177). */
export interface ValidationReport {
  /** 경고 총 개수 */
  count: number;
  /** 경고 종류별 요약 (key: 한국어 설명, value: 개수) */
  summary: Record<string, number>;
  /** 개별 경고 목록 */
  warnings: Array<{
    section: number;
    paragraph: number;
    kind: 'LinesegArrayEmpty' | 'LinesegUncomputed' | 'LinesegTextRunReflow';
    cell: { ctrl: number; row: number; col: number; innerPara: number } | null;
  }>;
}

export type HmlWarningCode =
  | 'UnsupportedElement'
  | 'UnsupportedAttribute'
  | 'UnsupportedEquationSemantics'
  | 'MissingResource'
  | 'ExternalResourceBlocked'
  | 'InvalidReference'
  | 'LossyConversion';

export interface HmlOpenMetadata {
  format: 'hml';
  hwpmlVersion?: string;
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'euc-kr';
  resourceCount: number;
  /** HML로 다시 저장 가능한지 여부 (보존 불가 요소가 있으면 false). */
  hmlSavable: boolean;
  /** hmlSavable이 false일 때, 보존할 수 없는 요소의 경로 목록. */
  saveBlockers: HmlSaveBlocker[];
  warnings: Array<{
    code: HmlWarningCode;
    xmlPath: string;
    message: string;
    preserved: boolean;
  }>;
}

export interface TableCellResizeUpdate {
  cellIdx: number;
  widthDelta?: number;
  heightDelta?: number;
  localResize?: boolean;
  renderWidth?: number;
  renderHeight?: number;
}

export interface TableTransposeResult {
  ok: boolean;
  paraIdx?: number;
  controlIdx?: number;
  sourceRows: number;
  sourceCols: number;
  targetRows: number;
  targetCols: number;
}

/** deferred cell text mutation의 pagination 경계 결과 (#2214/#2424). */
export interface DeferredCellTextMutationResult extends Partial<TextRemoval> {
  ok: boolean;
  charOffset: number;
  paginationDeferred: boolean;
  cellFlowChanged: boolean;
}

export type DeferredPaginationStatus = 'none' | 'pending' | 'complete' | 'fallback' | 'stale';

export interface DeferredPaginationResult {
  ok: boolean;
  status: DeferredPaginationStatus;
  revision: number;
  fragmentsProcessed: number;
  pageCount: number;
}

export interface WebCanvasImageCacheStats {
  decodedCanvasEntries: number;
  decodedCanvasPixels: number;
  decodedCanvasRgbaBytes: number;
  htmlImageEntries: number;
  htmlImageSourceBytes: number;
}

/** 문서를 들이기 전에 읽어 둔 결과. adoptPreparedDocument 로 들이거나 dispose 한다. */
export interface PreparedWasmDocument {
  readonly info: DocumentInfo;
  dispose(): void;
}
