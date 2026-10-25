# hm-wasm

Generated browser bindings and WASM from HeemangEngine `feat/studio-objects` at `5c96a91`, which includes main (MAIN107,
`d660276`), the core API branch and native table/object editing. Built on 2026-10-25. Contract and page-packet versions are
both 1. The package is committed so Studio does not need the HeemangEngine checkout to run or build.

`hm_wasm_bg.wasm`: 5,080,059 bytes, SHA-256
`285405e7b67c7d3d1e399649ef83d881056ba190083b7b8c9685da31d1f817b5`.

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

To refresh, run `CARGO_BUILD_JOBS=3 WASM_BINDGEN=<wasm-bindgen 0.2.125> ./crates/hm-wasm/build.sh` in a HeemangEngine
worktree of `feat/studio-objects`, copy the four files from `target/hm-wasm-pkg/web/` here and update this
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
