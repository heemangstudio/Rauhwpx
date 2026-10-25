# core/hm: the WasmBridge API on HeemangEngine

`WasmBridge` (`src/core/wasm-bridge.ts`) is Studio's only document engine boundary. Its public methods keep the old
Studio signatures and coordinates, so the input handler, dialogs, toolbar, agent tools and versioning call it unchanged.
Every method delegates to a function of the same name in `api` (`api.ts`), which collects the area files in this
directory. Those functions turn Studio coordinates into HeemangEngine addresses and call hm-wasm.

## Layout

| File | Owns |
| --- | --- |
| `core.ts` | `HmCore`: the open `Doc`, paragraph and line caches, `transact`/`mutate` (every content change goes through them), caret and point lookups |
| `address.ts` | Coordinate conversion. Characters are Unicode scalars (an emoji is one). Caret offsets are logical (characters plus inline objects and notes, one each); text offsets count characters only; the engine uses wire offsets. Cell paths map to engine `steps` |
| `document.ts` | Open, new document, save/export, page info and painting, snapshots |
| `cursor.ts` | Caret rects, hit testing, line info, vertical movement, selection rects |
| `text.ts` | Insert, delete, split and merge in body, cells and nested cells |
| `format.ts` | Character and paragraph formatting, styles, numbering |
| `table.ts`, `objects.ts`, `furniture.ts`, `fields.ts`, `page.ts`, `clipboard.ts`, `search.ts` | The rest, mostly stubs today |

A function the engine cannot serve yet throws `unsupported(name)` (`EngineNotSupportedError`). The command layer
disables the matching menu and toolbar entries; it never falls back to another engine.

## Adding or replacing methods from another lane

Do not edit the area files above; they belong to the core lane. Instead:

1. Create `src/core/hm/<area>-<topic>.ts`, for example `objects-layout.ts` or `status-counts.ts`.
2. Export functions with exactly the stub's name and signature (first parameter `core: HmCore`). Use the helpers in
   `core.ts` and `address.ts`; route every content change through `core.transact` or `core.mutate`.
3. At the bottom of the file call `extendBridge({ fnA, fnB })` from `./api`.
4. Add one line `import './<area>-<topic>';` to `extensions.ts`, kept in name order.

The registered implementation replaces the stub for every `WasmBridge` instance. New `WasmBridge` methods need a
signature in `wasm-bridge.ts` and a stub in an area file; ask the core lane, or add both in one small commit.

Low-level helpers that need the hm-wasm `Doc` or `Engine` belong in a clearly marked section of
`heemang-adapter.ts`, added only. hm-wasm API additions go to the HeemangEngine `feat/studio-api` branch; the core lane
merges engine branches and is the only lane that rebuilds `vendor/hm-wasm`.

## Coordinates in short

- Page coordinates are 96 DPI px; the engine uses HU (`px = hu / 75`).
- `logicalToWire` puts a caret right after the unit before it, so field starts and bookmarks stay after the caret.
- Ranges cover whole units: `logicalRangeToWire` for caret ranges, `textRangeToWire` for text ranges.
- `pathTarget(sec, parentPara, pathJson)` gives the list and paragraph a cell path names; it accepts both the long
  (`controlIndex`) and short (`controlIdx`) keys.
