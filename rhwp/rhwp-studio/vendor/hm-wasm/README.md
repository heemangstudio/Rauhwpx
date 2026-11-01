# hm-wasm

Generated browser bindings and WASM from HeemangEngine `rc/combined-20261028` at `df06a7a` (2026-11-02). Over `b3a2d0b`
(editing parity #4 and table splits #3) it merges: #6 and #9 (a missing Hancom face draws with the closest OS face but
lays out with the Hancom face's own widths, from committed width tables), #5, #7, #13 and #14 (Hancom pagination rules:
held tables whose first row misses the page, bottom-caption reservation, footnotes inside split tables, merged-cell
leftover height and page-end credit, and more), #10 and #11 (local rendering: cut-cell alignment, Latin glyph fallback,
Word-compatible cut cells, chart theme colours, WMF scale and pens, paper-relative pictures), #12 (HWP and HWPX
conversion keeps stored lines and no longer refuses edited documents; fixes for files Hancom refused) and #8 (incremental
pagination, `layoutFirst`/`layoutMore` progressive first pages and faster cold layout). After `c4fbb80` it adds #15, #18,
#20, #21 and #23 (merged cells carried and re-cut across pages, nested-table header repetition), #17 and #25 (table
placement and overfull-cell alignment), #19 (HWP 3 replays its stored lines), #22 (round-trip round 2: typed tabs,
incomplete HWPX headers), #24 (merge manifest 60x faster, caret lookup index) and #16 (test fixes). After `5d474bf` it adds #26, #30 and #33
(round trip: unedited conversions keep every page, tab-ended aligned lines replay like Hancom, page setup edits re-lay text,
tabs save their kind and leader), #27, #29, #31 and #32 (centered merged-cell splits, objects moving with their line,
cell pictures moving to the next cell part, deferred table spacing) and #28 (rounded corners, body-kept front tables). After `f250292` it adds #35, #36, #38 and #40 (nested table parts cut per cell with Hancom's frames, column regions of converter-made forms; every Hancom page in the corpus in sync), #34, #37 and #39 (text box tables, objects at the foot of a page, equation sizing, bold HFT stand-ins, unequal columns, arrowheads). Built with
`CARGO_BUILD_JOBS=3 WASM_BINDGEN=<wasm-bindgen 0.2.125> crates/hm-wasm/build.sh`, no wasm-opt.
Contract and page-packet versions are both 1. The package is committed so Studio does not need the HeemangEngine
checkout to run or build.

SHA-256 of the four files:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `hm_wasm_bg.wasm` | 8,575,759 | `cfd9ca4657a5b076be4ea5cf9147b6d962dbe484a7d388d9d6f351d591ba217a` |
| `hm_wasm.js` | 77,636 | `1e1a9f8ea520d241f8c15a690785afd92ac7017fd1d1c6c43669fbdc5a72806a` |
| `hm_wasm.d.ts` | 68,221 | `fb0bb83bf4e8091c419d2b6d93e00e588ea3813e80100f5dc74b072ab1e460dd` |
| `hm_wasm_bg.wasm.d.ts` | 9,689 | `c76607cfd0f7ad53a8cde07d0e06bbaf102a42994b9cf87e5bc70a125bd609c9` |

Earlier packages: `b3a2d0b` merged engine PR #4 (editing parity with Hancom Office 2022) and #3 (table splits) over
`6d33534` (save-corruption fixes, #2) and `f7c5b55` (footnote and endnote parity, #1).

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
