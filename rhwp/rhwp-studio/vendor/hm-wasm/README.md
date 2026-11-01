# hm-wasm

Generated browser bindings and WASM from HeemangEngine `rc/combined-20261028` at `b3a2d0b` (2026-10-31), which merges
engine PR #4 (`fix/editing-parity`, merge `306e4ed`: editing parity with Hancom Office 2022 from the Studio editing audit)
and engine PR #3 (`fix/table-split-parity` at `7e09370`). `21bc492` was `6d33534` plus table pagination parity with Hancom Office 2022 (rows and cells split across pages, merged-cell cuts, rows
taller than a page, nested-table margins at a cut, continuation spacing). `6d33534` adds the save-corruption fixes of engine PR #2 over `f7c5b55`, which merges `feat/notes-parity` at `845ba85`:
`rc/combined-20261028` at `8d80eb0` plus footnote and endnote parity with Hancom Office 2022 (note insertion, numbering,
note shapes, clipboard, page-local numbers, HWP/HWPX/HML round trips, and note layout and painting). `8d80eb0` changes only tests and documents
over `1a54900`, which over the
`afcacaf` package adds the rendering lanes through `b3cce93` (tables, text, forms/math, curriculum and objects
under the r12 gate fonts), Hancom-captured table editing (`9bbcf60`: merge drops empty cells, split grids and heights,
`copyRow`/`copyColumn`, saved laid-out table height, `moveTableCellEdge`), caret motion fixes (`054d48b`) and the
typing performance work with its incremental-versus-fresh layout equivalence test (`1a54900`). Built with
`CARGO_BUILD_JOBS=4 WASM_BINDGEN=<wasm-bindgen 0.2.125> crates/hm-wasm/build.sh`, no wasm-opt.
Contract and page-packet versions are both 1. The package is committed so Studio does not need the HeemangEngine
checkout to run or build.

SHA-256 of the four files:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `hm_wasm_bg.wasm` | 8,076,941 | `5f99378e9d70749103c42586ad042b17657ce738d82a0553534a5874fc770efe` |
| `hm_wasm.js` | 75,224 | `3db65c95d05ed435b11805bc34129ed9d235574d78b83b3ffadd4d45cb47a4bb` |
| `hm_wasm.d.ts` | 66,520 | `634c301dec4743ecfbd141e8f1f0f53978e07e645b614d4bb342b5503e3c6b6a` |
| `hm_wasm_bg.wasm.d.ts` | 9,432 | `07b5c75ac375ad462fbe491a4162bca1d5e0956c203c02a37823eceec6135c4f` |

Integration `e48a461` adds, over the earlier `e2c92f9`, structural version merging and `Doc.verifyHwp`
(`feat/studio-version-merge`, `208dbfb`), sparse host-font glyph coverage (`fix/studio-export-packaging`, `ebf68e8`)
and the accepted rendering milestones `968dc9a`, `5dfe0c6` (text), `4e2a40d`, `381dcae` (tables) and `5921168`,
`f72c281`, `05515e0` (objects), over main (MAIN107, `d660276`). `3e2a9df` adds `acrossControls` text search, `cbd1009`, `d50e982` and `e48a461` build structural merge manifests from one document view (manifest version 5), and `fix/studio-audit-gaps` (`cb86974`) adds polygon/arc shapes, caption numbers and the audit follow-ups.

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
worktree of the release-candidate branch, copy the four files from `target/hm-wasm-pkg/web/` here and update this
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
