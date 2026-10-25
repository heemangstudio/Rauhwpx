# hm-wasm

Generated browser bindings and WASM from HeemangEngine `fix/studio-residual-a` at `a5b0951`, which is
`feat/studio-integrate` (`f9528d9`: `feat/studio-api` (`05a3207`) with `feat/studio-widgets` (`bb98daf`),
`feat/studio-dialogs` (`e6ee8d8`), `feat/studio-objects` (`5c96a91`) and `feat/studio-agent-api` (`8d6a669`) merged
and the read-back fix `f9528d9` on top, over main (MAIN107, `d660276`)) plus note renumbering (`0de6421`),
`Doc.adopt` (`708adb0`) and object captions (`a5b0951`). Built on 2026-10-25.
Contract and page-packet versions are both 1. The package is committed so Studio does not need the HeemangEngine
checkout to run or build.

`hm_wasm_bg.wasm`: 5,688,384 bytes, SHA-256
`d0ba3af3e695c7d90b785f083d89fe100a3701b497566a8c8186ccf61b950eb3`.

Studio API additions on `feat/studio-api`:

- `ControlInfo.inline`, `side` and `number` in paragraph queries.
- The `lines` query: a paragraph's laid-out lines with their pages and wire ranges.
- `body` and `within` scopes for point lookups.
- `brotliDecompress`, so browsers without a Brotli `DecompressionStream` can read WOFF2 fonts.

Object branch additions (`8478dc5`, `e2dab41`): table, picture and shape creation; deletion and relocation;
object, table and cell property queries and edits; native page-object geometry; embedded-picture reads;
and HWP/HWPX packaging of inserted image data. `670a489` turns and mirrors drawings (`rotation`, `flipHorizontal`,
`flipVertical`; a turned picture's box frames its turned bounds), reports a drawing's unturned `size`, keeps object
transforms under handles (`captureObjectTransform`, `swapObjectTransform`, `discardObjectTransform`) and makes a point
in a table cell find that cell's text. `98c849b`, `7ec4163` and `5c96a91` set cell, table and cell-zone borders and
fills (`borderFill` patches, the `setCellZone` op), cell text direction and form editing, object `restrictInPage`,
`allowOverlap` and `keepWithAnchor`, picture brightness, contrast, effect, transparency and inner margins, and drawing
face fills.

Widget branch additions (`18fac63`, `bb98daf`): atomic style, list definition and shape-ID edits; font and shape
queries; character patches for script positions, emboss and engrave, kerning, underline and strikeout shapes and
colors, outlines, shadows, emphasis marks, shading and per-slot faces, sizes and offsets; and the `fontCandidates`
query. Dialog branch additions (`4483a40`, `e6ee8d8`): page, section, column and page-border settings, headers and
footers, footnotes and endnotes, click-here fields, hyperlinks, bookmarks and form objects. Agent tools branch
(`8d6a669`): equation insert and edit (`insertEquation`, `setEquation`), numbered table captions (`setTableCaption`)
and the `equation` and `equationPreview` queries. `f9528d9` reports page and column breaks in `formatRuns` and a
table's caption and cell zones in `tableProperties`. `0de6421` renumbers notes in document order after edits that add, remove or
restart them (`renumberNotes`); `708adb0` adds `Doc.adopt`, which takes another opened document's content while
keeping checkpoints; `a5b0951` adds `setObjectCaption` and reports object captions in `objectProperties`.

To refresh, run `CARGO_BUILD_JOBS=3 WASM_BINDGEN=<wasm-bindgen 0.2.125> ./crates/hm-wasm/build.sh` in a HeemangEngine
worktree of `feat/studio-integrate`, copy the four files from `target/hm-wasm-pkg/web/` here and update this
provenance. The Canvas2D player in `src/view/heemang-player.ts`
ports `crates/hm-wasm/js/player.mjs`. The accompanying LICENSE applies to the engine and reference player.

HeemangEngine is Studio's only document engine. `src/core/wasm-bridge.ts` keeps the Studio API and delegates to
`src/core/hm/` (see its README), which drives this package through `src/core/heemang-adapter.ts`.

The adapter registers fonts through `addFontFile`, so only requested tables and outlines enter WASM. It uses catalog
families to select the first available face candidate and default, then rechecks character fallbacks before layout.
Missing outlines trigger a file refetch and repaint. Plain pictures use browser-decoded bitmaps shared across pages;
other items and failed decodes use engine patches. No proprietary fonts or Hancom tables are included here.

For local comparison, `RHWP_HEEMANG_FONT_ASSETS` optionally points to a JSON array of absolute local TTF/OTF/TTC/HFT
and DAT paths. Its dev-only Vite route registers code tables, FontMap and hftinfo first, then loads only the families
chosen from `Doc.fontRequests`.
