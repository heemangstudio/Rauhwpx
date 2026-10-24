/**
 * HeemangEngine wire 계약 — 에이전트 도구가 쓰는 hm-wasm 요청·결과 모양.
 *
 * vendor/hm-wasm 의 d.ts 와 따로 둔다. 번들된 엔진이 아직 이 모양을 다 갖추지 않았어도
 * 도구 코드가 컴파일되고, 실제로 있는지는 capabilities() 로 실행 시점에 확인한다
 * (없으면 ENGINE_NOT_SUPPORTED). HeemangEngine crates/hm-wasm/src/types.rs 의 TS 절에서 옮겼다.
 */
/** One step from a paragraph into a list one of its controls holds. */
export interface Step { para: number; control: number; index: number }
/** A wire position: UTF-16 units, controls take 8. */
export interface Address { section: number; steps?: Step[]; para: number; offset: number }
export type Affinity = "downstream" | "upstream";
/** Page HU (7200 per inch). */
export interface Caret { page: number; x: number; y: number; height: number }
/** A floating object or table of a page; `control` indexes its paragraph's controls. */
export interface ObjectTarget {
  section: number; steps?: Step[]; para: number; control: number; kind: string;
  layer: "behind" | "text" | "front"; page: number; x: number; y: number; width: number; height: number;
}
/** `object` is set when the point picks a floating object rather than text. */
export interface Located { position: Address; affinity: Affinity; caret: Caret; object?: ObjectTarget }
export type LocateRequest =
  | { kind: "point"; page: number; x: number; y: number }
  | { kind: "caret"; position: Address; affinity?: Affinity; page?: number };
export interface Rect { page: number; x: number; y: number; width: number; height: number }
/** A table control in a paragraph list. */
export interface TableAddress { section: number; steps?: Step[]; para: number; control: number }
export interface CellRef { row: number; column: number }
/**
 * Ends in different lists select by their nearest common list (an end inside
 * a control takes the whole control), or, in two cells of one table, the block
 * of cells between them.
 */
export type SelectRequest =
  | { from: Address; to: Address; page?: number }
  | { kind: "cells"; table: TableAddress; from: CellRef; to: CellRef; page?: number };
export type SelectedRange =
  | { kind: "text"; from: Address; to: Address }
  | { kind: "cells"; table: TableAddress; from: CellRef; to: CellRef; cells: { row: number; column: number; rowSpan: number; columnSpan: number; list: ListAddress }[] };
export interface Selected { range: SelectedRange; rects: Rect[] }
export type Motion = "left" | "right" | "lineStart" | "lineEnd" | "up" | "down";
export interface NavigateRequest { position: Address; affinity?: Affinity; motion: Motion; preferredX?: number; page?: number }
/**
 * `size` in HU (1000 = 10 pt); `color` a COLORREF; `fontFace` a family for
 * all seven script slots, which must be registered; `charSpacing` a percent
 * of the character size (-50 to 50) for all slots.
 */
export interface CharPatch {
  bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; size?: number; color?: number;
  fontFace?: string; charSpacing?: number;
}
export type Align = "justify" | "left" | "right" | "center" | "distribute" | "divide";
export interface ParaPatch { align?: Align; spaceBefore?: number; spaceAfter?: number; left?: number; indent?: number; lineSpacing?: number }
export interface ListSpec { kind: "bullet" | "numbering"; id: number; level?: number; restart?: number }
export type EditOp =
  | { op: "insertText"; at: Address; text: string; format?: CharPatch }
  | { op: "delete"; from: Address; to: Address }
  | { op: "split"; at: Address; pageBreak?: boolean }
  | { op: "formatChars"; from: Address; to: Address; patch: CharPatch }
  | { op: "formatParas"; from: Address; to: Address; patch: ParaPatch }
  | { op: "pageBreak"; at: Address; on: boolean }
  | { op: "applyStyle"; from: Address; to: Address; styleId: number }
  | { op: "insertTableRows"; table: TableAddress; beforeRow: number; count: number }
  | { op: "deleteTableRows"; table: TableAddress; startRow: number; count: number }
  | { op: "insertTableColumns"; table: TableAddress; beforeColumn: number; count: number }
  | { op: "deleteTableColumns"; table: TableAddress; startColumn: number; count: number }
  | { op: "mergeTableCells"; table: TableAddress; startRow: number; startColumn: number; endRow: number; endColumn: number }
  | { op: "splitTableCell"; table: TableAddress; row: number; column: number; rows: number; columns: number; equalRowHeight: boolean }
  | { op: "setList"; from: Address; to: Address; list: ListSpec | null };
/** A directed selection the host keeps with an undo step. */
export type Selection =
  | { anchor: Address; focus: Address; anchorAffinity: Affinity; focusAffinity: Affinity }
  | { kind: "cells"; table: TableAddress; from: CellRef; to: CellRef };
export interface TransactRequest { expectedEpoch?: number; ops: EditOp[]; selection?: Selection; afterSelection?: Selection }
/**
 * `changedPages`: pages (zero-based, as now laid out, plus pages that no
 * longer exist) to paint again; null for all. `selection`: after a
 * transaction, the collapsed caret; after undo, the selection from before the
 * step; after redo, the one after it. `historyId` names the history position.
 */
export interface Receipt {
  contentEpoch: number; layoutEpoch: number; pageCount: number; caret?: Address; undo: number; redo: number;
  changedPages: number[] | null; selection?: Selection | null; historyId: number; tableChanges?: TableChange[];
}
/** Ordered per operation. Removed cells map to null; merged cells to their survivor.
 * All cell list addresses in the table expire after structural edits or undo/redo.
 * Requery the table to resolve a mapped origin to its new list. */
export interface TableChange { table: TableAddress; cells: { from: CellRef; to: CellRef | null; index: number | null; paragraphShift: number }[] }
export interface TableCell extends CellRef { rowSpan: number; columnSpan: number; list: ListAddress; rects: Rect[] }
export interface TableInfo { table: TableAddress; rows: number; columns: number; cells: TableCell[]; rects: Rect[] }
export interface DocState {
  instance: number; contentEpoch: number; layoutEpoch: number; fontGeneration: number;
  format: "hwp5" | "hwpx"; pageCount: number; dirty: boolean; undo: number; redo: number;
}
export interface Area { x: number; y: number; width: number; height: number }
/** A picture to decode with the browser and draw in place of a patch. */
export interface PictureSource {
  key: string; mime: string; width: number; height: number;
  matrix: [number, number, number, number, number, number];
  clip: [number, number][] | null;
}
export interface Margins { left: number; right: number; top: number; bottom: number; header: number; footer: number; gutter: number }
export interface PageInfo {
  index: number; section: number; width: number; height: number; number: number; landscape: boolean;
  margins: Margins; body: Area; header: Area; footer: Area; columns: Area[];
}
export interface Capabilities {
  contract: number; packet: number; pageInfo: boolean; equationScripts: boolean; open: string[]; serialize: string[];
  scopes: string[]; ops: string[]; paste: string[]; locate: string[]; motions: string[]; query: string[]; missing: string[];
  /** 에이전트 검토용 이력 조작 (history·revertSteps·combineSteps). 없는 빌드도 있다. */
  history?: string[];
  [key: string]: unknown;
}
export interface ListAddress { section: number; steps?: Step[] }
export type QueryRequest =
  | { kind: "table"; table: TableAddress; page?: number }
  | { kind: "paragraphs"; list: ListAddress; from?: number; count?: number }
  | { kind: "formatContext"; at: Address; to?: Address }
  | { kind: "styles"; from?: number; count?: number }
  | { kind: "style"; id: number }
  | { kind: "lists" }
  | { kind: "list"; listKind: "bullet" | "numbering"; id: number };
export interface ListRef { kind: "bullet" | "numbering" | "outline"; id: number; level: number }
/**
 * Values at `at` (for a caret, what typing there takes: the shape of the
 * unit before it, or the paragraph's first at its start); `mixed` names the
 * properties (`characters.bold`, `styleId`, `list`, ...) that differ over
 * the range. `lineSpacing` is absent unless the spacing is a percentage.
 */
export interface FormatContext { characters: CharPatch; paragraphs: ParaPatch; styleId: number; list: ListRef | null; mixed: string[] }
export interface StyleInfo {
  id: number; name: string; englishName: string; kind: "paragraph" | "character"; next: number;
  paraShape: number; charShape: number; characters: CharPatch; paragraphs: ParaPatch;
}
export interface ListLevel { format: string; numberKind: number; start: number }
export interface ListInfo { kind: "bullet" | "numbering"; id: number; bullet?: string; start?: number; levels?: ListLevel[] }
export interface ControlInfo {
  index: number; offset: number; kind: string; lists: number;
  /** Authored equation source, including an empty string; absent on other controls. */
  script?: string;
}
export interface ParagraphInfo {
  index: number;
  /** Characters, tabs, line breaks (\n) and the two fixed spaces (U+00A0, U+2007). */
  text: string;
  /** The wire offset of each UTF-16 unit of `text`, then the end mark's. */
  offsets: number[];
  length: number; caret: [number, number]; controls: ControlInfo[];
}
export interface SearchRequest {
  text: string; caseSensitive?: boolean; list?: ListAddress; limit?: number;
  /** With `from`, the one match after it (before it with `backward`), wrapping around. */
  from?: Address; backward?: boolean;
}
export interface Match { from: Address; to: Address }
export interface SearchResult { contentEpoch: number; matches: Match[] }
export interface FaceRequest { name: string; candidates: string[]; standIns: string[] }
export interface FontRequests { faces: FaceRequest[]; classDefaults: string[][]; fallbacks: string[] }
/** A font file the host holds, read in pieces (`Engine.addFontFile`). */
export interface FontFileSource { readonly size: number; read(offset: number, length: number): Uint8Array }
export interface ComposeRequest { at?: Address; text?: string }
export interface CopyRequest { from: Address; to: Address }
export interface Copied { text: string; html: string }
/** Exactly one of `at` and `replace`. */
export interface PasteRequest {
  at?: Address; replace?: { from: Address; to: Address };
  text?: string; expectedEpoch?: number; selection?: Selection; afterSelection?: Selection;
}
export type ErrorCode =
  | "MALFORMED_INPUT" | "UNSUPPORTED_FORMAT" | "BAD_REQUEST" | "BAD_ADDRESS"
  | "STALE_EPOCH" | "EDIT_FAILED" | "NO_SUCH_PAGE" | "CLOSED" | "SAVE_FAILED"
  | "COMPOSING" | "STALE_HANDLE";

/** 실패 — wasm-bindgen 이 던지는 EngineError 의 모양. */
export interface EngineErrorLike { code: ErrorCode | string; message: string }

/** 이력 단계 (Receipt.historyId 와 같은 번호), 오래된 것부터. */
export interface HistoryList { undo: number[]; redo: number[] }
export interface RevertStepsRequest { steps: number[]; expectedEpoch?: number }
/** kept: 뒤 단계가 같은 문단을 고쳐 손대지 않고 남긴 단계. */
export interface RevertStepsResult { receipt: Receipt; reverted: number[]; kept: number[] }
export interface CombineStepsRequest { steps: number[] }
export interface CombineStepsResult { historyId: number; combined: number[]; kept: number[] }

/** 에이전트 도구가 부르는 Doc 메서드. 모두 JSON 문자열을 주고받는다. */
export interface HmDoc {
  state(): string;
  pages(): string;
  query(request: string): string;
  search(request: string): string;
  select(request: string): string;
  selectRange(request: string): string;
  locate(request: string): string;
  objects(page: number): string;
  transact(request: string): string;
  checkpoint(): number;
  restore(checkpoint: number): string;
  releaseCheckpoint(checkpoint: number): boolean;
  undo(): string;
  redo(): string;
  pageSvg(page: number, dpi: number): string;
  pagePng(page: number, dpi: number): Uint8Array;
  serialize(markSaved: boolean): Uint8Array;
  serializeAs(format: string, markSaved: boolean): Uint8Array;
  // 아래는 엔진 빌드에 따라 없을 수 있다 (capabilities 로 확인).
  history?(): string;
  revertSteps?(request: string): string;
  combineSteps?(request: string): string;
}
