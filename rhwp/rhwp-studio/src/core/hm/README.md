# core/hm: the WasmBridge API on HeemangEngine

`WasmBridge` (`src/core/wasm-bridge.ts`) is Studio's only document engine boundary. Its public methods keep the old
Studio signatures and coordinates, so the input handler, dialogs, toolbar, agent tools and versioning call it unchanged.
Every method delegates to a function of the same name in `api` (`api.ts`). `extensions.ts` loads the registered
implementations that replace base functions. Those functions turn Studio coordinates into HeemangEngine addresses
and call hm-wasm. Read `extensions.ts` before auditing stubs: a throw in a base file does not establish a runtime gap.

## Layout

| File | Owns |
| --- | --- |
| `core.ts` | `HmCore`: the open `Doc`, paragraph and line caches, `transact`/`mutate` (every content change goes through them), caret and point lookups |
| `address.ts` | Coordinate conversion. Characters are Unicode scalars (an emoji is one). Caret offsets are logical (characters plus inline objects and notes, one each); text offsets count characters only; the engine uses wire offsets. Cell paths map to engine `steps` |
| `document.ts` | Open, new document, save/export, page info and painting, snapshots |
| `cursor.ts` | Caret rects, hit testing, line info, vertical movement, selection rects |
| `document-captures.ts` | Native paragraph captures, scoped restoration and release |
| `objects-ole.ts` | Body legacy OLE equation conversion through native transactions |
| `objects-connectors.ts` | Bound connector endpoint updates |
| `table-transpose.ts` | Native cell-range and transpose clipboard, paste and in-place transpose |
| `text.ts`, `agent-clipboard.ts`, `clipboard-native.ts`, `hwpjson.ts` | Text edits, internal/native clipboard and structured paste |
| `format-fonts.ts`, `format-widgets.ts` | Formatting, fonts, styles and numbering |
| `table-editing.ts`, `table-properties.ts`, `agent-tables.ts` | Table edits, properties and agent operations |
| `objects-editing.ts`, `objects-grouping.ts`, `objects-navigation.ts`, `objects-transform.ts`, `agent-equations.ts` | Pictures, shapes, equations and transforms |
| `furniture-editing.ts`, `furniture-pictures.ts`, `fields-controls.ts`, `fields-forms.ts` | Headers/footers, notes, fields and forms |
| `notes-shape.ts` | Footnote and endnote shapes per section (number format, numbering, placement, separator) |
| `page-settings.ts`, `search-text.ts`, `document-counts.ts`, `agent-document.ts` | Page settings, search, counts and agent document operations |

A function the engine cannot serve yet throws `unsupported(name)` (`EngineNotSupportedError`). The command layer
disables the matching menu and toolbar entries; it never falls back to another engine.

## Adding or replacing methods from another lane

For an existing implementation, edit its registered module. To replace an unimplemented base method:

1. Create `src/core/hm/<area>-<topic>.ts`, for example `objects-layout.ts` or `status-counts.ts`.
2. Export functions with exactly the stub's name and signature (first parameter `core: HmCore`). Use the helpers in
   `core.ts` and `address.ts`; route every content change through `core.transact` or `core.mutate`.
3. At the bottom of the file call `extendBridge({ fnA, fnB })` from `./api`.
4. Add one line `import './<area>-<topic>';` to `extensions.ts`, kept in name order.

The registered implementation replaces the stub for every `WasmBridge` instance. Register a method once. New
`WasmBridge` methods need a signature in `wasm-bridge.ts`, an implementation and registration.

Low-level helpers that need the hm-wasm `Doc` or `Engine` belong in a clearly marked section of
`heemang-adapter.ts`. Make hm-wasm additions in a task-owned engine worktree. The integrator merges engine branches
into `feat/studio-integrate` and rebuilds `vendor/hm-wasm` once from that merged tip.

The current lane ownership, stopped work and verification commands are in [the cutover handoff](../../../../../docs/heemang-cutover.md).

## Coordinates in short

- Page coordinates are 96 DPI px; the engine uses HU (`px = hu / 75`).
- `logicalToWire` puts a caret right after the unit before it, so field starts and bookmarks stay after the caret.
- Ranges cover whole units: `logicalRangeToWire` for caret ranges, `textRangeToWire` for text ranges.
- `pathTarget(sec, parentPara, pathJson)` gives the list and paragraph a cell path names; it accepts both the long
  (`controlIndex`) and short (`controlIdx`) keys.
