# hm-wasm

Generated browser bindings and WASM from HeemangEngine `feat/studio-dialogs` at `e6ee8d8`: `feat/studio-api` (`05a3207`,
main `d660276` plus the additions below) with `feat/studio-widgets` merged and the dialog API from
`docs/wasm-dialogs.md` (page and section settings, columns, page borders, headers and footers, notes, fields,
bookmarks, form objects). Built on 2026-10-25. Contract and page-packet versions are both 1. The package is committed
so Studio does not need the HeemangEngine checkout to run or build.

`hm_wasm_bg.wasm`: 5,094,990 bytes, SHA-256
`658a3f6ade03fc8065de6db55199c1da791f071f4ee15d3fe932092b7126b66f`.

Studio API additions on `feat/studio-api`:

- `ControlInfo.inline`, `side` and `number` in paragraph queries.
- The `lines` query: a paragraph's laid-out lines with their pages and wire ranges.
- `body` and `within` scopes for point lookups.
- `brotliDecompress`, so browsers without a Brotli `DecompressionStream` can read WOFF2 fonts.

To refresh, run `CARGO_BUILD_JOBS=6 WASM_BINDGEN=<wasm-bindgen 0.2.125> ./crates/hm-wasm/build.sh` in a HeemangEngine
worktree of `feat/studio-api` rebased on main, copy the four files from `target/hm-wasm-pkg/web/` here and update this
provenance. Only the Studio core lane rebuilds this directory. The Canvas2D player in `src/view/heemang-player.ts`
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
