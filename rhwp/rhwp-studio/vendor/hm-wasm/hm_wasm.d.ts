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
| { kind: "point"; page: number; x: number; y: number; body?: boolean; within?: ListAddress }
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
 * \`size\` in HU (1000 = 10 pt); \`color\` a COLORREF; \`fontFace\` a family for
 * all seven script slots, which must draw with a registered face (its own
 * family or one Hancom draws in its place); \`fontFaces\` a family per
 * slot (Hangul, Latin, Hanja, Japanese, other, symbol, user), null keeping the
 * slot's, read back with all seven; \`charSpacing\` a percent of the character
 * size (-50 to 50) for all slots. \`relSizes\` (10 to 250) and \`offsets\`
 * (-100 to 100) are percents per slot; line shapes, \`outline\` (0 to 6),
 * \`shadow\` (0 none, 1 discrete, 2 continuous) and \`emphasis\` (0 to 12) are
 * HWP codes; \`shadeColor\` 0xFFFFFFFF is no shading.
 */
export interface CharPatch {
    bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; size?: number; color?: number;
    fontFace?: string; fontFaces?: (string | null)[]; charSpacing?: number; spacings?: (number | null)[]; ratios?: (number | null)[];
    relSizes?: (number | null)[]; offsets?: (number | null)[]; superscript?: boolean; subscript?: boolean; emboss?: boolean; engrave?: boolean;
    kerning?: boolean; underlineKind?: "none" | "below" | "above"; underlineShape?: number; underlineColor?: number; strikeShape?: number;
    strikeColor?: number; outline?: number; shadow?: number; shadowColor?: number; shadowOffset?: [number, number]; emphasis?: number;
    shadeColor?: number; borderFillId?: number; borderFill?: BorderFillPatch;
}
export type Align = "justify" | "left" | "right" | "center" | "distribute" | "divide";
export interface ParaPatch { align?: Align; spaceBefore?: number; spaceAfter?: number; left?: number; right?: number; indent?: number; lineSpacing?: number; lineSpacingKind?: "percent" | "fixed" | "added" | "atLeast"; tabStops?:{position:number;type:number;fill:number}[] }
export interface StylePatch { characters?: CharPatch; paragraphs?: ParaPatch; name?: string; englishName?: string; kind?: "paragraph" | "character"; next?: number; charShapeId?: number; paraShapeId?: number }
export type ListDefinition = { kind: "bullet"; bullet: string } | { kind: "numbering"; start?: number; levels: { format: string; numberKind?: number; start?: number }[] };
export interface FontFace { id: number; name: string }
export type ListRestart = { mode: "continue" } | { mode: "restart"; start: number };
export interface ListSpec { kind: "bullet" | "numbering" | "outline"; id: number; level?: number; restart?: number }
export interface PageSettingsPatch { width?: number; height?: number; marginLeft?: number; marginRight?: number; marginTop?: number; marginBottom?: number; marginHeader?: number; marginFooter?: number; gutter?: number; landscape?: boolean; binding?: number }
export interface SectionSettingsPatch { attr?: number; columnGap?: number; tabStop?: number; outlineNumbering?: number; pageNumber?: number; figureNumber?: number; tableNumber?: number; equationNumber?: number; language?: number }
export interface ColumnSettingsPatch { count?: number; kind?: number; direction?: number; equalWidths?: boolean; gap?: number; columns?: [number, number][]; lineKind?: number; lineWidth?: number; lineColor?: number }
export interface NoteShapePatch { attr?: number; userChar?: number; prefix?: number; suffix?: number; start?: number; separatorLength?: number; spaceAbove?: number; spaceBelow?: number; spaceBetween?: number; lineKind?: number; lineWidth?: number; lineColor?: number }
export interface FieldPatch { command?: string; name?: string; editable?: boolean; value?: string }
export interface DocumentPropertiesPatch { pageStart?: number; footnoteStart?: number; endnoteStart?: number; figureStart?: number; tableStart?: number; equationStart?: number; caretList?: number; caretPara?: number; caretPos?: number }
export interface BorderLineSpec { kind: number; width: number; color: number }
export type PageFill = { kind: "none" } | { kind: "solid"; color: number; patternColor?: number; pattern?: number } | { kind: "gradient" | "image" };
/** `lines` (left, right, top, bottom) and `fill` derive a border fill from the current one; queries report both. */
export interface PageBorderPatch { attr?: number; offsets?: [number, number, number, number]; borderFill?: number; lines?: [BorderLineSpec, BorderLineSpec, BorderLineSpec, BorderLineSpec]; fill?: PageFill }
export type Side = "both" | "even" | "odd";
export type NoteKind = "footnote" | "endnote";
export type FieldKind = "clickHere" | "hyperlink" | "bookmark" | "date" | "time" | "fileName" | "title" | "pageNumber" | "pageCount";
export type ControlAddress = TableAddress;
export interface SectionSettings {section:number;page:PageSettingsPatch|null;settings:SectionSettingsPatch|null;columns:ColumnSettingsPatch|null;noteShapes:{footnote:NoteShapePatch|null;endnote:NoteShapePatch|null};pageBorders:PageBorderPatch[]}
/** A form object's state. `value` is a check box or radio button's 0 off, 1 on, 2 indeterminate; `text` an edit or combo box's entry. `properties` flattens every property set, first name wins. */
export interface FormRecord {formType:"PushButton"|"CheckBox"|"RadioButton"|"ComboBox"|"ListBox"|"Edit"|"ScrollBar"|"Unknown";name:string;value:number;text:string;caption:string;enabled:boolean;width:number;height:number;foreColor:number;backColor:number;properties:Record<string,string>;items:string[]}
export interface ControlRecord {target:ControlAddress;offset:number;kind:string;lists:ListAddress[];side?:Side;number?:number;prefix?:number;suffix?:number;flags?:number;fieldId?:number;fieldKind?:FieldKind;name?:string;command?:string;guide?:string;editable?:boolean;value?:string;end?:Address;form?:FormRecord}
/** HU throughout, including natural image dimensions. Patches reject unknown fields. */
export interface ObjectPatch {
    width?:number; height?:number; horzOffset?:number; vertOffset?:number; treatAsChar?:boolean;
    vertRelTo?:"paper"|"page"|"para"; horzRelTo?:"paper"|"page"|"column"|"para";
    vertAlign?:"top"|"center"|"bottom"|"inside"|"outside"; horzAlign?:"left"|"center"|"right"|"inside"|"outside";
    textWrap?:"square"|"topAndBottom"|"behind"|"inFront"; margins?:[number,number,number,number];
    description?:string; rotation?:number; flipHorizontal?:boolean; flipVertical?:boolean; zOrder?:number; sizeProtect?:boolean;
    restrictInPage?:boolean; allowOverlap?:boolean; keepWithAnchor?:boolean;
    border?:{color?:number;width?:number;style?:number;endCap?:number;head?:number;tail?:number;headSize?:number;tailSize?:number}; crop?:[number,number,number,number];
    brightness?:number; contrast?:number; effect?:number; transparency?:number; pictureMargins?:[number,number,number,number];
    fill?:FillPatch; fillAlpha?:number;
    caption?:CaptionPatch; textMargins?:[number,number,number,number];textVerticalAlign?:"top"|"center"|"bottom";round?:number;shadow?:{kind?:number;color?:number;x?:number;y?:number};
}
export interface CaptionPatch {
    enabled?:boolean; side?:"left"|"right"|"top"|"bottom"; verticalAlign?:"top"|"center"|"bottom";
    width?:number;gap?:number;maxWidth?:number;includeMargin?:boolean;
}
export interface LinePatch { style:number; width:number; color:number }
export type FillPatch = { kind:"none"|"image" } | { kind:"solid"; background:number; patternColor?:number; pattern?:number } | {kind:"gradient";gradientType?:number;angle?:number;centerX?:number;centerY?:number;step?:number};
export interface BorderFillPatch {
    left?:LinePatch; right?:LinePatch; top?:LinePatch; bottom?:LinePatch; diagonal?:LinePatch;
    slash?:number; backslash?:number; centerLine?:"none"|"horizontal"|"vertical"|"cross"; fill?:FillPatch;
}
export interface TablePatch { repeatHeader?:boolean; split?:"none"|"row"|"cell"; spacing?:number; padding?:[number,number,number,number]; borderFill?:BorderFillPatch; borderFillId?:number }
export interface CellPatch { width?:number; height?:number; padding?:[number,number,number,number]; verticalAlign?:"top"|"center"|"bottom"; ownPadding?:boolean; protected?:boolean; header?:boolean; textDirection?:number; editableInForm?:boolean; borderFill?:BorderFillPatch; borderFillId?:number;fieldName?:string }
export interface ObjectProperties extends Omit<ObjectPatch,"fill"|"caption"> {
    kind:string; text?:string; size?:[number,number]; pictureMargins?:[number,number,number,number];
    brightness?:number; contrast?:number; effect?:number; transparency?:number; naturalWidth?:number; naturalHeight?:number;
    fill?:{kind:number;color:number|null;solid:unknown;gradient:unknown;image:unknown;alpha:number[]};
    /** Drawings and equations: null without a caption; `list` is the caption's list index in the object's steps. */
    caption?:{side:"left"|"right"|"top"|"bottom";verticalAlign:"top"|"center"|"bottom";includeMargin:boolean;width:number;gap:number;maxWidth:number;paragraphs:number;list:number}|null;
}
/** `caption` is null without a caption; `zones` are the table's cell zones, each with the border fill it applies. */
export interface TableProperties extends Omit<TablePatch,"borderFill"> {
    rows:number; columns:number; borderFill:unknown;
    caption:{side:"left"|"right"|"top"|"bottom";verticalAlign:"top"|"center"|"bottom";includeMargin:boolean;width:number;gap:number;maxWidth:number;paragraphs:number}|null;
    zones:{startRow:number;startColumn:number;endRow:number;endColumn:number;borderFill:unknown}[];
}
export interface CellProperties extends Omit<CellPatch,"borderFill"> { row:number; column:number; rowSpan:number; columnSpan:number; tablePadding:number[]; borderFill:unknown }
export interface PictureData { bytes:number[]; extension:string; mime:string; naturalWidth:number; naturalHeight:number }
/** Equation fields: size in HU (1000 = 10 pt), baseline a percent of the height. */
export interface EquationPatch { script?: string; size?: number; color?: number; baseline?: number; font?: string }
export interface EquationInfo { script: string; size: number; color: number; baseline: number; font: string | null; width: number; height: number }
export interface EquationPreview { svg: string; widthPx: number; heightPx: number; baselinePx: number; warnings: string[] }
export type EditOp =
| { op: "setCharShape"; from: Address; to: Address; charShapeId: number }
| { op: "setParaShape"; from: Address; to: Address; paraShapeId: number }
| { op: "createStyle"; style: StylePatch }
| { op: "updateStyle"; id: number; style: StylePatch }
| { op: "deleteStyle"; id: number }
| { op: "ensureList"; definition: ListDefinition }
| {op:"setPageSettings";section:number;patch:PageSettingsPatch}
| {op:"setSectionSettings";section:number;patch:SectionSettingsPatch}
| {op:"setColumns";at:Address;patch:ColumnSettingsPatch}
| {op:"setNoteShape";section:number;kind:NoteKind;patch:NoteShapePatch}
| {op:"setPageBorder";section:number;side:Side;patch:PageBorderPatch}
| {op:"setPageHide";at:Address;flags:number}
| {op:"createHeaderFooter";section:number;kind:"header"|"footer";side:Side}
| {op:"insertNote";at:Address;kind:NoteKind}
/** Gives every note the number Hancom shows. Runs on its own after edits that add, remove or restart notes. */
| {op:"renumberNotes"}
| {op:"insertField";at:Address;kind:FieldKind;to?:Address;command?:string;name?:string;editable?:boolean;text?:string}
| {op:"updateField";target:ControlAddress;patch:FieldPatch}
| {op:"insertBookmark";at:Address;name:string}
| {op:"renameBookmark";target:ControlAddress;name:string}
| {op:"deleteControl";target:ControlAddress}
| {op:"setFormValue";target:ControlAddress;value?:number;text?:string}
| {op:"setDocumentProperties";patch:DocumentPropertiesPatch}
| {op:"columnBreak";at:Address}
| {op:"insertNewNumber";at:Address;number:number}
| { op:"createTable"; at:Address; rows:number; columns:number; columnWidths?:number[]; rowHeights?:number[]; inline?:boolean }
| { op:"insertPicture"; at:Address; bytes:number[]; extension:string; description?:string; width:number; height:number; naturalWidth?:number; naturalHeight?:number; inline?:boolean; horzOffset?:number; vertOffset?:number }
| { op:"assignPictureImage"; object:ObjectAddress; bytes:number[]; extension:string; naturalWidth:number; naturalHeight:number }
| { op:"createShape"; at:Address; kind:"rect"|"ellipse"|"line"|"textbox"|"polygon"|"arc"; connector?:ConnectorSpec; width:number; height:number; points?:[number,number][]; text?:string; inline?:boolean; horzOffset?:number; vertOffset?:number }
| { op:"deleteObject"; object:ObjectAddress }
| { op:"relocateObject"; object:ObjectAddress; at:Address }
| { op:"setLineEnds"; object:ObjectAddress; start:[number,number]; end:[number,number] }
| { op:"groupObjects"; objects:ObjectAddress[] }
| { op:"ungroupObject"; object:ObjectAddress }
| { op:"setObjectProperties"; object:ObjectAddress; patch:ObjectPatch }
| { op:"setTableProperties"; table:TableAddress; patch:TablePatch }
| { op:"setCellProperties"; table:TableAddress; row:number; column:number; patch:CellPatch }
| { op:"setCellZone"; table:TableAddress; startRow:number; startColumn:number; endRow:number; endColumn:number; borderFill:BorderFillPatch }
| { op: "insertEquation"; at: Address; script: string; size?: number; color?: number; font?: string; baseline?: number }
| { op: "promoteOleEquation"; object: TableAddress }
| { op: "setEquation"; object: TableAddress; patch: EquationPatch }
| { op: "setTableCaption"; table: TableAddress; text: string; withNumber?: boolean }
/** A picture, drawing or equation caption; "그림 N" or "수식 N" first with `withNumber`. Created below the object when missing. */
| { op: "setObjectCaption"; object: ObjectAddress; text: string; withNumber?: boolean }
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
| { op: "setListRestart"; at: Address; restart: ListRestart | null }
| { op: "setList"; from: Address; to: Address; list: ListSpec | null }
| { op: "moveObject"; object: ObjectAddress; dx: number; dy: number }
| { op: "resizeObject"; object: ObjectAddress; width: number; height: number }
| { op: "resizeTableCells"; table: TableAddress; cells: CellResize[] };
/** An object control in a paragraph list (a table's address names it too). */
export type ObjectAddress = TableAddress;
/** HU added to a cell's laid-out width and height; `index` is the cell's in the table. */
export interface CellResize { index: number; widthDelta?: number; heightDelta?: number }
/**
 * An object or table a page draws (`Doc.pageObjects`), bottom to top. The box
 * excludes outer margins; a table split over pages gives this page's part.
 * \`line\` holds a line's start and end on the page.
 */
export interface PageObject {
    section: number; steps?: Step[]; para: number; control: number;
    kind: "table" | "picture" | "shape" | "line" | "connector" | "group" | "ole" | "equation" | "form" | "object";
    page: number; x: number; y: number; width: number; height: number;
    inline: boolean; layer: "behind" | "text" | "front"; wrap: "square" | "topAndBottom" | "behindText" | "inFrontOfText"; rows?: number; cols?: number; z: number;
    furniture: boolean; locked: boolean; text: boolean; missing?: boolean; rotation?: number; line?: [number, number, number, number];
}
/** A directed selection the host keeps with an undo step. */
export type Selection =
| { anchor: Address; focus: Address; anchorAffinity: Affinity; focusAffinity: Affinity }
| { kind: "cells"; table: TableAddress; from: CellRef; to: CellRef };
export interface TransactRequest { expectedEpoch?: number; ops: EditOp[]; selection?: Selection; afterSelection?: Selection }
/**
 * \`changedPages\`: pages (zero-based, as now laid out, plus pages that no
 * longer exist) to paint again; null for all. \`selection\`: after a
 * transaction, the collapsed caret; after undo, the selection from before the
 * step; after redo, the one after it. \`historyId\` names the history position.
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
    format: "hwp5" | "hwpx" | "hwp3" | "hml"; pageCount: number; dirty: boolean; undo: number; redo: number;
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
    contract: number; packet: number; pageInfo: boolean; equationScripts: boolean; paragraphCaptures: boolean; tableTranspose: boolean; connectors: boolean; open: string[]; serialize: string[];
    scopes: string[]; ops: string[]; paste: string[]; locate: string[]; motions: string[]; query: string[]; missing: string[];
}
export interface ListAddress { section: number; steps?: Step[] }
export type QueryRequest =
| { kind: "fonts" }
| { kind: "fontCandidates"; names: string[] }
| { kind: "charShape"; id: number }
| { kind: "paraShape"; id: number }
| {kind:"sectionSettings";section:number}
| {kind:"noteShape";section:number;noteKind:NoteKind}
| {kind:"documentProperties"}
| {kind:"controls"|"fields";list?:ListAddress}
| {kind:"objectProperties";object:ObjectAddress}
| {kind:"tableProperties";table:TableAddress}
| {kind:"cellProperties";table:TableAddress;row:number;column:number}
| {kind:"pictureData";object:ObjectAddress}
| { kind: "equation"; object: TableAddress }
| { kind: "equationPreview"; script: string; size: number; color?: number; font?: string }
| { kind: "table"; table: TableAddress; page?: number }
| { kind: "paragraphs"; list: ListAddress; from?: number; count?: number }
| { kind: "formatContext"; at: Address; to?: Address }
| { kind: "styles"; from?: number; count?: number }
| { kind: "style"; id: number }
| { kind: "lists" }
| { kind: "list"; listKind: "bullet" | "numbering"; id: number }
| { kind: "count"; list?: ListAddress; from?: Address; to?: Address }
| { kind: "formatRuns"; list: ListAddress; from?: number; count?: number }
| { kind: "lines"; list: ListAddress; para: number };
/**
 * Characters as Hancom's status bar counts them (\`count\`): one per code
 * point, spaces, tabs and fixed spaces included, line breaks, numbers and
 * objects not; with each field's end, and the text of the tables, text
 * boxes, captions, headers, footers and notes inside. The whole document's
 * body with no \`list\` or range, one list with all it holds, or \`[from, to)\`
 * with what the controls in it hold.
 */
export interface CharacterCount { characters: number }
/** A paragraph's formatting (\`formatRuns\`): runs start at a wire offset. */
export interface ParagraphFormat {
    index: number; styleId: number; paraShapeId: number; paragraphs: ParaPatch; list: ListRef | null; listRestart: ListRestart | null;
    runs: { offset: number; charShapeId: number; characters: CharPatch }[];
    /** The paragraph starts a new page or column. */
    pageBreak: boolean; columnBreak: boolean;
}
/** A paragraph's laid-out line (\`lines\` query): page HU and the wire range it shows. */
export interface LineInfo { line: number; page: number; y: number; height: number; baseline: number; start: number; end: number; left: number; right: number }

export interface ListRef { kind: "bullet" | "numbering" | "outline"; id: number; level: number }
/**
 * Values at \`at\` (for a caret, what typing there takes: the shape of the
 * unit before it, or the paragraph's first at its start); \`mixed\` names the
 * properties (\`characters.bold\`, \`styleId\`, \`list\`, ...) that differ over
 * the range. \`lineSpacingKind\` identifies the spacing units.
 */
export interface FormatContext { characters: CharPatch; paragraphs: ParaPatch; styleId: number; list: ListRef | null; listRestart: ListRestart | null; mixed: string[] }
export interface StyleInfo {
    id: number; name: string; englishName: string; kind: "paragraph" | "character"; next: number;
    paraShape: number; charShape: number; characters: CharPatch; paragraphs: ParaPatch;
}
export interface ListLevel { format: string; numberKind: number; start: number }
export interface ListInfo { kind: "bullet" | "numbering" | "outline"; id: number; bullet?: string; start?: number; levels?: ListLevel[] }
export interface ControlInfo {
    index: number; offset: number; kind: string; lists: number;
    /** Authored equation source, including an empty string; absent on other controls. */
    script?: string;
    /** Objects, tables and form objects: whether it sits in the text like a character. */
    inline?: boolean;
    /** Headers and footers: the pages they apply to. */
    side?: "both" | "even" | "odd";
    /** Notes and automatic numbers: the number Hancom last assigned. */
    number?: number;
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
    /** Match text as if controls (notes, fields, objects) were absent; a match may then span them. */
    acrossControls?: boolean;
}
export interface Match { from: Address; to: Address }
export interface SearchResult { contentEpoch: number; matches: Match[] }
export interface FaceRequest { name: string; candidates: string[]; standIns: string[]; text?: boolean }
/** A family a host may set (\`fontCandidates\`): what to register for it, and whether text set in it already draws with a registered face. */
export interface FaceCandidates extends FaceRequest { resolves: boolean }
export interface FontRequests { faces: FaceRequest[]; classDefaults: string[][]; fallbacks: string[] }
/** A font file the host holds, read in pieces (`Engine.addFontFile`). */
export interface FontFileSource { readonly size: number; read(offset: number, length: number): Uint8Array }
export interface ComposeRequest { at?: Address; text?: string }
export interface ConnectorSpec { kind: number; start: [number,number]; end: [number,number] }
export type TableTransposeRequest =
| {action:"copy";transpose?:boolean;table:TableAddress;startRow:number;startColumn:number;endRow:number;endColumn:number}
| {action:"paste";transpose?:boolean;table:TableAddress;startRow:number;startColumn:number}
| {action:"inPlace";table:TableAddress}
| {action:"insert";at:Address};
export interface TableTransposeResult { ok:boolean; sourceRows:number; sourceCols:number; targetRows:number; targetCols:number; receipt:Receipt|null; paraIdx?:number; controlIdx?:number; text?:string; html?:string }
export interface CopyRequest { from: Address; to: Address }
/** `objects`: tables and objects carried; they paste back only into the document copied from. */
export interface Copied { text: string; html: string; objects: number }
/** Exactly one of `at` and `replace`. */
export interface PasteRequest {
    at?: Address; replace?: { from: Address; to: Address };
    text?: string; expectedEpoch?: number; selection?: Selection; afterSelection?: Selection;
}
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
     * Takes `other`'s document in place of this one's, with an empty
     * history, and closes `other`. This document's checkpoints stay, so a
     * host can put back what it held before; the result counts as unsaved.
     * A `Receipt`.
     */
    adopt(other: Doc): string;
    /**
     * Takes the IME text out; a `Receipt` with the caret where it began,
     * or `null` when nothing was composing.
     */
    cancelComposition(): string;
    /**
     * Keeps a drawing's placement and transform (its box, matrices,
     * rotation, flips and crop) under a handle, for `swapObjectTransform`.
     */
    captureObjectTransform(object: string): number;
    /**
     * Keeps one complete paragraph, including nested controls, in this document.
     */
    captureParagraph(address: string): number;
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
     * the system clipboard. The fragment is shared by this Engine's
     * documents until the next copy, survives source closure, and carries
     * face names for paste into another document.
     */
    copy(request: string): string;
    /**
     * Drops a kept transform; false when there was none.
     */
    discardObjectTransform(handle: number): boolean;
    discardParagraphCapture(handle: number): boolean;
    /**
     * An explicit HWPX editor export. Preview images are stored without a
     * second compression layer; native serialize/serializeAs keep their
     * source-preserving contract. Export never acknowledges a file write.
     */
    exportHwpx(): Uint8Array;
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
     * A disposable document showing the selected header/footer on every page.
     * Editing and the shared clipboard of the source document are untouched.
     */
    furniturePreview(target: string): Doc;
    /**
     * Actual glyphs drawn on every current page, grouped by canonical font
     * source label and source face index. Touches residency so an unavailable
     * outline also appears in Engine.outlineRequests before visible painting.
     */
    glyphRequests(): string;
    hasTableTransposeClipboard(): boolean;
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
     * Metadata for just one page, without serializing the whole document.
     */
    pageInfo(index: number): string;
    /**
     * Every object and table page `i` draws, in any paragraph list
     * (`PageObject[]`), bottom to top.
     */
    pageObjects(i: number): string;
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
     * Pastes at `at`, or over `replace` (one list), as one undo step
     * (`PasteRequest`): the engine's fragment when `text` is absent or is
     * the fragment's text, else `text` as typed. A `Receipt` with the caret
     * after the paste; on failure nothing changes, epochs included.
     */
    paste(request: string): string;
    /**
     * Imports a source range through the same atomic paste path, without
     * reading or replacing the Engine's user clipboard.
     */
    pasteFrom(source: Doc, range: string, request: string): string;
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
     * `paragraphs` gives `ParagraphInfo[]` for a list, `formatContext` a
     * `FormatContext`, `styles` `StyleInfo[]` and `style` one (or null),
     * `lists` `ListInfo[]` and `list` one (or null), `count` a
     * `CharacterCount` and `formatRuns` `ParagraphFormat[]`.
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
     * Restores only the addressed paragraph as one undoable edit; keeps the capture.
     */
    restoreParagraph(handle: number, address: string): string;
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
     * segments from our layout. An HWP 3 document is written as a new
     * HWP 5 file, the `.hwp` format this engine writes. `markSaved`
     * clears the dirty state; the content epoch never changes.
     */
    serialize(mark_saved: boolean): Uint8Array;
    /**
     * The document written as `format` (`"hwp5"`, `"hwpx"` or `"hml"`): in its
     * own format as [`Doc::serialize`] writes it, in the other as a new
     * file encoded from the model alone. An HWP 3 document, which has no
     * writer, is always converted; as `"hwp5"` it is what
     * [`Doc::serialize`] writes. The open document keeps its format;
     * `markSaved` clears the dirty state.
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
     * Exchanges a kept transform with the object's current one as one
     * undo step, keeping the current one under the same handle; a
     * `Receipt`.
     */
    swapObjectTransform(handle: number): string;
    /**
     * Applies edits atomically as one undo step and lays out again;
     * returns a `Receipt`. With `expectedEpoch` set, a document edited
     * since fails with `STALE_EPOCH` and nothing changes.
     */
    transact(request: string): string;
    /**
     * Copies or applies a transposed cell block; writes form one undo step.
     */
    transposeTable(request: string): string;
    /**
     * Reverts the last transaction; a `Receipt`, or `null` when there is
     * nothing to undo.
     */
    undo(): string;
    /**
     * Rebinds the section's attached connector endpoints as one undoable edit.
     */
    updateConnectors(section: number): string;
    /**
     * Reopens an HWP export and compares its typed properties and resource
     * values with the model that was written, excluding source/layout caches.
     */
    verifyHwp(): string;
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
     * Complete sources are retained for later characters. Explicitly sparse
     * SFNT files retain their supplied outlines; other outlines come empty
     * (`em` 0 in `glyphOutlines`) and name the file in
     * [`Engine::outline_requests`]. Registering a complete source with the
     * same label promotes it without changing face IDs, and requires a new
     * layout only when one measured a missing outline.
     */
    addFont(label: string, bytes: Uint8Array): number;
    /**
     * Registers a font file the host holds, like [`Engine::add_font`],
     * reading through `file.read(offset, length)` (a `Uint8Array`).
     * Complete files are retained; explicitly sparse SFNT files keep only
     * their supplied outlines as described above.
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
     * Characters whose outlines compact font registration retains, including
     * the documents opened so far and the engine's basic Latin seed.
     */
    fontCharacters(): string;
    /**
     * Retained and pending glyph IDs for canonical source labels, as
     * `[label, faceIndex, glyphIds][]`. Sparse refills must keep their union.
     */
    glyphCoverage(labels: string): string;
    /**
     * Outlines for `(face, glyph)` pairs as a page's `GLYF` block lists
     * them (see [`packet::glyph_outlines`]).
     */
    glyphOutlines(pairs: Uint32Array): Uint8Array;
    constructor();
    /**
     * Opens HWP 5, HWPX, HML or HWP 3 bytes; layout waits for a request.
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
 * Decompresses a Brotli stream, such as a WOFF2 font's tables, into at
 * most `max` bytes. Browsers without a Brotli `DecompressionStream` read
 * web fonts through this.
 */
export function brotliDecompress(bytes: Uint8Array, max: number): Uint8Array;

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

export function structuralMergeAnalyze(base: string, current: string, incoming: string): string;

export function structuralMergeAnalyzeDocument(b: Uint8Array, c: Uint8Array, i: Uint8Array): string;

export function structuralMergeAnalyzeDocumentWithManifests(b: Uint8Array, c: Uint8Array, i: Uint8Array, bm: string, cm: string, im: string): string;

export function structuralMergeBuildManifest(bytes: Uint8Array): string;

export function structuralMergeMaterialize(analysis: string, resolutions: string): string;

export function structuralMergeMaterializeDocument(b: Uint8Array, c: Uint8Array, i: Uint8Array, r: string): Uint8Array;

export function structuralMergeMaterializeDocumentWithManifests(b: Uint8Array, c: Uint8Array, i: Uint8Array, bm: string, cm: string, im: string, r: string): Uint8Array;

export function structuralMergeMaterializeReviewDocument(b: Uint8Array, c: Uint8Array, i: Uint8Array, bm: string, cm: string, im: string, r: string): Uint8Array;

export function structuralMergeReviewDocument(b: Uint8Array, c: Uint8Array, i: Uint8Array, bm: string, cm: string, im: string): string;

export function structuralMergeVirtualBase(raw: string): string;

export function structuralMergeVirtualBaseDocument(raw: string, format: string): Uint8Array;

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
    readonly brotliDecompress: (a: number, b: number, c: number) => [number, number, number, number];
    readonly capabilities: () => [number, number];
    readonly doc_adopt: (a: number, b: number) => [number, number, number, number];
    readonly doc_cancelComposition: (a: number) => [number, number, number, number];
    readonly doc_captureObjectTransform: (a: number, b: number, c: number) => [number, number, number];
    readonly doc_captureParagraph: (a: number, b: number, c: number) => [number, number, number];
    readonly doc_checkpoint: (a: number) => [number, number, number];
    readonly doc_close: (a: number) => void;
    readonly doc_commitComposition: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_compose: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_copy: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_discardObjectTransform: (a: number, b: number) => [number, number, number];
    readonly doc_discardParagraphCapture: (a: number, b: number) => [number, number, number];
    readonly doc_exportHwpx: (a: number) => [number, number, number, number];
    readonly doc_fontNames: (a: number) => [number, number, number, number];
    readonly doc_fontRequests: (a: number) => [number, number, number, number];
    readonly doc_furniturePreview: (a: number, b: number, c: number) => [number, number, number];
    readonly doc_glyphRequests: (a: number) => [number, number, number, number];
    readonly doc_hasTableTransposeClipboard: (a: number) => [number, number, number];
    readonly doc_layoutStats: (a: number) => [number, number, number, number];
    readonly doc_locate: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_markSaved: (a: number, b: number) => [number, number];
    readonly doc_navigate: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_objects: (a: number, b: number) => [number, number, number, number];
    readonly doc_page: (a: number, b: number) => [number, number, number, number];
    readonly doc_pageInfo: (a: number, b: number) => [number, number, number, number];
    readonly doc_pageObjects: (a: number, b: number) => [number, number, number, number];
    readonly doc_pagePng: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_pageSvg: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_pages: (a: number) => [number, number, number, number];
    readonly doc_paste: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_pasteFrom: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly doc_patch: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly doc_pdf: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly doc_pictureBytes: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_pictureSource: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_query: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_redo: (a: number) => [number, number, number, number];
    readonly doc_releaseCheckpoint: (a: number, b: number) => [number, number, number];
    readonly doc_restore: (a: number, b: number) => [number, number, number, number];
    readonly doc_restoreParagraph: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly doc_search: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_select: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_selectRange: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_serialize: (a: number, b: number) => [number, number, number, number];
    readonly doc_serializeAs: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly doc_state: (a: number) => [number, number, number, number];
    readonly doc_substitutions: (a: number) => [number, number, number, number];
    readonly doc_swapObjectTransform: (a: number, b: number) => [number, number, number, number];
    readonly doc_transact: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_transposeTable: (a: number, b: number, c: number) => [number, number, number, number];
    readonly doc_undo: (a: number) => [number, number, number, number];
    readonly doc_updateConnectors: (a: number, b: number) => [number, number, number, number];
    readonly doc_verifyHwp: (a: number) => [number, number, number, number];
    readonly engine_addCodeTable: (a: number, b: number, c: number) => number;
    readonly engine_addFont: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly engine_addFontFile: (a: number, b: number, c: number, d: any) => number;
    readonly engine_addFontMap: (a: number, b: number, c: number) => number;
    readonly engine_addHftInfo: (a: number, b: number, c: number) => number;
    readonly engine_create: (a: number, b: number, c: number) => [number, number, number];
    readonly engine_fontBytes: (a: number) => number;
    readonly engine_fontCharacters: (a: number) => [number, number];
    readonly engine_fontGeneration: (a: number) => number;
    readonly engine_glyphCoverage: (a: number, b: number, c: number) => [number, number, number, number];
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
    readonly structuralMergeAnalyze: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly structuralMergeAnalyzeDocument: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly structuralMergeAnalyzeDocumentWithManifests: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number, number];
    readonly structuralMergeBuildManifest: (a: number, b: number) => [number, number, number, number];
    readonly structuralMergeMaterialize: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly structuralMergeMaterializeDocument: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly structuralMergeMaterializeDocumentWithManifests: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => [number, number, number, number];
    readonly structuralMergeMaterializeReviewDocument: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => [number, number, number, number];
    readonly structuralMergeReviewDocument: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number, number];
    readonly structuralMergeVirtualBase: (a: number, b: number) => [number, number, number, number];
    readonly structuralMergeVirtualBaseDocument: (a: number, b: number, c: number, d: number) => [number, number, number, number];
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
