# hm-wasm

Generated browser bindings and WASM from HeemangEngine `rc/combined-20261028` at `afcacaf` (2026-10-28 release
candidate). It is core `53fabe6` (qualified native `01c8536` plus the selected performance commits over
integration `e48a461`) with five accepted rendering fixes: HWPX picture outer shadows (`02d1b46`),
document-level integer-percent picture fill zoom with overflow clipping (`f8899cd`), paragraph-relative horizontal
object alignment between paragraph margins (`150b388`), connected character borders (`9b93aa0`) and picture bullets
with empty number formats as paragraph heads (`a7dd228`), followed by two Studio fixes: tables pasted into a narrower
cell fit its text width and `resizeTableCells` takes absolute sizes (`edbd0aa`), and structural merges keep the
current document's default-tab paragraph shapes and compare HWPX binary entries without package addressing
(`afcacaf`). Built with
`CARGO_BUILD_JOBS=3 WASM_BINDGEN=<wasm-bindgen 0.2.125> crates/hm-wasm/build.sh`, no wasm-opt.
Contract and page-packet versions are both 1. The package is committed so Studio does not need the HeemangEngine
checkout to run or build.

SHA-256 of the four files:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `hm_wasm_bg.wasm` | 7,585,818 | `1c91ad51ff815187b3f7c93dedddbb66fb29fe22f122c1f120405107699dbae9` |
| `hm_wasm.js` | 73,254 | `2c860bee0d93549badb95a81433bcb8a42a8afb95e9688da018f91e3776c8110` |
| `hm_wasm.d.ts` | 54,782 | `004d64e811527a3ca6924d136e1b086310cce53c6b462185a434b28e894b92b4` |
| `hm_wasm_bg.wasm.d.ts` | 9,178 | `4dd860b1e9ac983d76fdad7265f36a420b0f2d07a65bebc0a16c12a6f2c77bd4` |

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
