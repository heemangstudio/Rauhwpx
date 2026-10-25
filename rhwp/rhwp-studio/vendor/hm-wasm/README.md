# hm-wasm

Generated browser bindings and WASM from a local HeemangEngine integration tree (`engine-agent-int`, `a819f29`, not a
branch): `feat/studio-agent-api` (`8d6a669`, on `feat/studio-api` `05a3207`) merged with the Studio lane branches
`feat/studio-objects` (`5c96a91`), `feat/studio-dialogs` (`e6ee8d8`) and `feat/studio-widgets` (`bb98daf`). Built on
2026-10-25 for the agent lane. Contract and page-packet versions are both 1.

`hm_wasm_bg.wasm`: 5,656,507 bytes, SHA-256
`30ff7985ec3adeae822210d3719d8d7b4ce390805a207230c9451250386a3679`.

Agent lane additions on `feat/studio-agent-api`: `insertEquation` and `setEquation` edits, `equation` and
`equationPreview` queries, `setTableCaption` (numbered "표 N" captions).

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
