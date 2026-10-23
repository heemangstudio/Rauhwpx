/* tslint:disable */
/* eslint-disable */

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
export interface CharPatch { bold?: boolean; italic?: boolean; underline?: boolean; size?: number; color?: number }
export type Align = "justify" | "left" | "right" | "center" | "distribute" | "divide";
export interface ParaPatch { align?: Align; spaceBefore?: number; spaceAfter?: number; left?: number; indent?: number; lineSpacing?: number }
export type EditOp =
| { op: "insertText"; at: Address; text: string }
| { op: "delete"; from: Address; to: Address }
| { op: "split"; at: Address; pageBreak?: boolean }
| { op: "formatChars"; from: Address; to: Address; patch: CharPatch }
| { op: "formatParas"; from: Address; to: Address; patch: ParaPatch }
| { op: "pageBreak"; at: Address; on: boolean };
/** A directed selection the host keeps with an undo step. */
export interface Selection { anchor: Address; focus: Address; anchorAffinity: Affinity; focusAffinity: Affinity }
export interface TransactRequest { expectedEpoch?: number; ops: EditOp[]; selection?: Selection }
/**
 * \`changedPages\`: pages (zero-based, as now laid out, plus pages that no
 * longer exist) to paint again; null for all. \`selection\`: after a
 * transaction, the collapsed caret; after undo, the selection from before the
 * step; after redo, the one after it. \`historyId\` names the history position.
 */
export interface Receipt {
    contentEpoch: number; layoutEpoch: number; pageCount: number; caret?: Address; undo: number; redo: number;
    changedPages: number[] | null; selection?: Selection; historyId: number;
}
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
    contract: number; packet: number; open: string[]; serialize: string[];
    scopes: string[]; ops: string[]; locate: string[]; motions: string[]; query: string[]; missing: string[];
}
export interface ListAddress { section: number; steps?: Step[] }
export interface QueryRequest { kind: "paragraphs"; list: ListAddress; from?: number; count?: number }
export interface ControlInfo { index: number; offset: number; kind: string; lists: number }
export interface ParagraphInfo { index: number; text: string; length: number; caret: [number, number]; controls: ControlInfo[] }
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
export interface PasteRequest { at: Address; text?: string; expectedEpoch?: number }
export type ErrorCode =
| "MALFORMED_INPUT" | "UNSUPPORTED_FORMAT" | "BAD_REQUEST" | "BAD_ADDRESS"
| "STALE_EPOCH" | "EDIT_FAILED" | "NO_SUCH_PAGE" | "CLOSED" | "SAVE_FAILED"
| "COMPOSING" | "STALE_HANDLE";



/**
 * BLAKE3 of bytes fed in pieces, for the host's document digests.
 */
export class Blake3Hasher {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The hash as lowercase hex; the hasher can go on taking bytes.
     */
    finalizeHex(): string;
    constructor();
    update(bytes: Uint8Array): void;
}

/**
 * An open document.
 */
export class Doc {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Takes the IME text out; a `Receipt` with the caret where it began,
     * or `null` when nothing was composing.
     */
    cancelComposition(): string;
    /**
     * Keeps the document and its history to come back to; returns the
     * checkpoint's handle.
     */
    checkpoint(): number;
    /**
     * Releases the document; later calls fail with `CLOSED`.
     */
    close(): void;
    /**
     * Ends the composition with `text` (the shown text when absent) as one
     * undo step; a `Receipt`.
     */
    commitComposition(request: string): string;
    /**
     * Shows IME text in progress at `at` (or where the composition began),
     * replacing the text shown before; laid out as typed text but kept out
     * of the history. Returns a `Receipt` whose caret ends the text.
     */
    compose(request: string): string;
    /**
     * Copies `[from, to)` (`CopyRequest`) as `Copied` text and HTML for
     * the system clipboard; the engine keeps the fragment for `paste`.
     */
    copy(request: string): string;
    /**
     * Every family [`Doc::font_requests`] names, as a JSON `string[]`.
     */
    fontNames(): string;
    /**
     * What fonts the document draws with (`FontRequests`): per face name
     * its text, paragraph heads and equations use, its candidate families
     * in the order the engine tries them and its font-map stand-ins; the
     * class default lists; and `fallbacks`, the unregistered families the
     * engine looks in, in order, for characters the registered faces lack.
     *
     * Register the first available candidate of each face and the first
     * available family of the first default list (Hancom's default face;
     * failing that, of the others), then ask again and register the
     * available fallbacks before the first layout. Doesn't lay the
     * document out. Once laid out, the faces also include every name the
     * layout asked for and the fallbacks what it looked for; registering
     * what is new and available lays it out again.
     */
    fontRequests(): string;
    /**
     * Paragraphs the last layout reused and formatted.
     */
    layoutStats(): Float64Array;
    /**
     * A point to a position (`Located`), or a position to its caret
     * (`Caret`); `null` when nothing editable is there.
     */
    locate(request: string): string;
    /**
     * Marks the document saved as it was at `expectedEpoch` (after the
     * host wrote what `serialize(false)` gave it); `STALE_EPOCH` when it
     * changed since. Changes nothing else.
     */
    markSaved(expected_epoch: number): void;
    /**
     * The caret after a movement (`Located`), `null` when the position is
     * on no page.
     */
    navigate(request: string): string;
    /**
     * The body's floating objects and tables on page `i`
     * (`ObjectTarget[]`), bottom to top.
     */
    objects(i: number): string;
    /**
     * Page `i` as a packet (see [`packet`]).
     */
    page(i: number): Uint8Array;
    /**
     * Page `i` rasterized by the engine as PNG, the reference the canvas
     * player is checked against.
     */
    pagePng(i: number, dpi: number): Uint8Array;
    /**
     * Page `i` as an SVG document: text and rules as vectors, pictures
     * and brushes as PNG patches at `dpi`.
     */
    pageSvg(i: number, dpi: number): string;
    /**
     * `PageInfo[]` as JSON, sizes in HU.
     */
    pages(): string;
    /**
     * Pastes at `at` (`PasteRequest`) as one undo step: the engine's
     * fragment when `text` is absent or is the fragment's text, else
     * `text` as typed. A `Receipt` with the caret after the paste.
     */
    paste(request: string): string;
    /**
     * Pixels of patch op `item` of page `i` at `dpi`: `u32` width and
     * height, then straight RGBA rows; empty when it draws nothing.
     */
    patch(i: number, item: number, dpi: number): Uint8Array;
    /**
     * Pages `from..to` as one PDF for printing or export: text and rules
     * as vectors, pictures and brushes as images at `dpi`.
     */
    pdf(from: number, to: number, dpi: number): Uint8Array;
    /**
     * The bytes of the picture [`Doc::picture_source`] describes: the file
     * as stored, or straight RGBA rows for `image/x-rgba`.
     */
    pictureBytes(i: number, item: number): Uint8Array;
    /**
     * Patch op `item` of page `i` as a picture the host decodes and
     * scales itself (`PictureSource`), or `null` when the patch has to be
     * rendered by [`Doc::patch`]. JPEG, PNG, GIF and BMP files come as
     * stored; other raster formats as straight RGBA rows
     * (`image/x-rgba`). Hosts decode such pictures off the critical path,
     * so a first paint need not wait for the engine to decode and
     * resample them.
     */
    pictureSource(i: number, item: number): string;
    /**
     * Bounded reads of the document (`QueryRequest`), as JSON:
     * `paragraphs` gives `ParagraphInfo[]` for a list.
     */
    query(request: string): string;
    /**
     * Applies the last undone transaction again; like [`Doc::undo`].
     */
    redo(): string;
    /**
     * Drops a checkpoint; false when there was none.
     */
    releaseCheckpoint(checkpoint: number): boolean;
    /**
     * Puts back a checkpoint's document and history, keeping the
     * checkpoint; a `Receipt`.
     */
    restore(checkpoint: number): string;
    /**
     * Text matches within paragraphs (`SearchRequest` to `SearchResult`),
     * in document order: each list, then the lists its paragraphs' controls
     * hold. Doesn't lay the document out.
     */
    search(request: string): string;
    /**
     * Selection rectangles (`Rect[]`) for `[from, to)` in one list.
     */
    select(request: string): string;
    /**
     * Like [`Doc::select`], with the selection as normalized
     * (`Selected`): the text range in the common list, or the block of
     * cells with each cell's list.
     */
    selectRange(request: string): string;
    /**
     * The document in its own format, edited paragraphs carrying line
     * segments from our layout. `markSaved` clears the dirty state; the
     * content epoch never changes.
     */
    serialize(mark_saved: boolean): Uint8Array;
    /**
     * The document written as `format` (`"hwp5"` or `"hwpx"`): in its
     * own format as [`Doc::serialize`] writes it, in the other as a new
     * file encoded from the model alone. The open document keeps its
     * format; `markSaved` clears the dirty state.
     */
    serializeAs(format: string, mark_saved: boolean): Uint8Array;
    /**
     * `DocState` as JSON.
     */
    state(): string;
    /**
     * Face names that resolved to another family, as `requested\tused`
     * lines: the fonts worth providing.
     */
    substitutions(): string;
    /**
     * Applies edits atomically as one undo step and lays out again;
     * returns a `Receipt`. With `expectedEpoch` set, a document edited
     * since fails with `STALE_EPOCH` and nothing changes.
     */
    transact(request: string): string;
    /**
     * Reverts the last transaction; a `Receipt`, or `null` when there is
     * nothing to undo.
     */
    undo(): string;
}

/**
 * Fonts shared by the documents an engine opens.
 */
export class Engine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Registers a Hancom code conversion table (`u300_*.dat`).
     */
    addCodeTable(bytes: Uint8Array): boolean;
    /**
     * Registers a TTF, OTF, TTC or HFT file; returns the faces added.
     * Documents lay out again with it on their next request.
     *
     * The engine keeps of a TrueType face its metrics and the outlines of
     * the characters in the documents opened so far, not the file. Other
     * outlines come empty (`em` 0 in `glyphOutlines`) and name the file in
     * [`Engine::outline_requests`]; registering the same label again fills
     * them in and bumps the font generation, without a new layout unless
     * one measured a missing outline.
     */
    addFont(label: string, bytes: Uint8Array): number;
    /**
     * Registers a font file the host holds, like [`Engine::add_font`],
     * reading through `file.read(offset, length)` (a `Uint8Array`) only
     * the parts the engine keeps, so the file never enters the engine's
     * memory whole.
     */
    addFontFile(label: string, file: FontFileSource): number;
    /**
     * Registers Hancom's font mapping table (`FontMap.dat`).
     */
    addFontMap(bytes: Uint8Array): boolean;
    /**
     * Registers Hancom's HFT catalog (`hftinfo.dat`), before HFT files.
     */
    addHftInfo(bytes: Uint8Array): boolean;
    /**
     * A new document from a template: the template's pages, styles,
     * headers and footers, with each section's text emptied to one
     * paragraph and no history.
     */
    create(template: Uint8Array): Doc;
    /**
     * Outlines for `(face, glyph)` pairs as a page's `GLYF` block lists
     * them (see [`packet::glyph_outlines`]).
     */
    glyphOutlines(pairs: Uint32Array): Uint8Array;
    constructor();
    /**
     * Opens HWP 5, HWPX or HWP 3 bytes and lays them out.
     */
    open(bytes: Uint8Array): Doc;
    /**
     * Labels of registered font files with outlines asked for but not
     * kept, as a JSON `string[]`: register each again with its bytes.
     */
    outlineRequests(): string;
    /**
     * Unregisters the font files registered under the labels of a JSON
     * `string[]`; returns the faces removed. Documents lay out again on
     * their next request.
     */
    unregisterFonts(labels: string): number;
    /**
     * Bytes of font data the engine holds.
     */
    readonly fontBytes: number;
    readonly fontGeneration: number;
}

/**
 * A failure JS can tell apart by `code`.
 */
export class EngineError {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    toString(): string;
    readonly code: string;
    readonly message: string;
}

/**
 * What this build offers, as JSON (`Capabilities`).
 */
export function capabilities(): string;

/**
 * The family names of a font file (TTF, OTF, TTC or HFT) as a JSON
 * `string[]`, for a host's font catalog; empty when unreadable.
 */
export function familyNames(bytes: Uint8Array): string;

/**
 * [`family_names`] of a file the host holds, reading only its tables.
 */
export function fileFamilyNames(file: FontFileSource): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_blake3hasher_free: (a: number, b: number) => void;
    readonly __wbg_doc_free: (a: number, b: number) => void;
    readonly __wbg_engine_free: (a: number, b: number) => void;
    readonly __wbg_engineerror_free: (a: number, b: number) => void;
    readonly blake3hasher_finalizeHex: (a: number) => [number, number];
    readonly blake3hasher_new: () => number;
    readonly blake3hasher_update: (a: number, b: number, c: number) => void;
    readonly capabilities: () => [number, number];
    readonly doc_cancelComposition: (a: number) => [number, number, number, number];
    readonly doc_checkpoint: (a: number) => [number, number, number];
    readonly doc_close: (a: number) => void;
    readonly doc_commitComposition: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_compose: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_copy: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_fontNames: (a: number) => [number, number, number, number];
    readonly doc_fontRequests: (a: number) => [number, number, number, number];
    readonly doc_layoutStats: (a: number) => [number, number, number, number];
    readonly doc_locate: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_markSaved: (a: number, b: number) => [number, number];
    readonly doc_navigate: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_objects: (a: number, b: number) => [number, number, number, number];
    readonly doc_page: (a: number, b: number) => [number, number, number, number];
    readonly doc_pagePng: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_pageSvg: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_pages: (a: number) => [number, number, number, number];
    readonly doc_paste: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_patch: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly doc_pdf: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly doc_pictureBytes: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_pictureSource: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_query: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_redo: (a: number) => [number, number, number, number];
    readonly doc_releaseCheckpoint: (a: number, b: number) => [number, number, number];
    readonly doc_restore: (a: number, b: number) => [number, number, number, number];
    readonly doc_search: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_select: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_selectRange: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_serialize: (a: number, b: number) => [number, number, number, number];
    readonly doc_serializeAs: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly doc_state: (a: number) => [number, number, number, number];
    readonly doc_substitutions: (a: number) => [number, number, number, number];
    readonly doc_transact: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_undo: (a: number) => [number, number, number, number];
    readonly engine_addCodeTable: (a: number, b: number, c: number) => number;
    readonly engine_addFont: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly engine_addFontFile: (a: number, b: number, c: number, d: any) => number;
    readonly engine_addFontMap: (a: number, b: number, c: number) => number;
    readonly engine_addHftInfo: (a: number, b: number, c: number) => number;
    readonly engine_create: (a: number, b: number, c: number) => [number, number, number];
    readonly engine_fontBytes: (a: number) => number;
    readonly engine_fontGeneration: (a: number) => number;
    readonly engine_glyphOutlines: (a: number, b: number, c: number) => [number, number];
    readonly engine_new: () => number;
    readonly engine_open: (a: number, b: number, c: number) => [number, number, number];
    readonly engine_outlineRequests: (a: number) => [number, number];
    readonly engine_unregisterFonts: (a: number, b: number, c: number) => [number, number, number];
    readonly engineerror_code: (a: number) => [number, number];
    readonly engineerror_message: (a: number) => [number, number];
    readonly engineerror_toString: (a: number) => [number, number];
    readonly familyNames: (a: number, b: number) => [number, number];
    readonly fileFamilyNames: (a: any) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
