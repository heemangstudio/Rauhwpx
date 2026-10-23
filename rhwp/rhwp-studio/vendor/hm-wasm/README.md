# hm-wasm

Generated browser bindings and WASM from HeemangEngine commit
`280497a916a7590fce1bfa7ac5ce8ad1b39516e9`, built on 2026-10-23.
The source checkout had the same HEAD before and after the build. Contract and
page-packet versions are both 1. The package is committed so Studio does not
need the HeemangEngine checkout to run or build.

`hm_wasm_bg.wasm`: 3,853,822 bytes, SHA-256
`cb404ef58bca9bb05c3d2ac66a2009e3a53f3514d297e6f1af7ac06de314460b`.

To refresh, run `CARGO_BUILD_JOBS=3 ./build.sh` in HeemangEngine's
`crates/hm-wasm`. It requires wasm-bindgen 0.2.125; set `WASM_BINDGEN` to its
binary if it is outside PATH. Copy the four generated files from
`target/hm-wasm-pkg/web/` here and update this provenance. The TypeScript
Canvas2D player in `src/view/heemang-player.ts` ports `crates/hm-wasm/js/player.mjs`.
The accompanying LICENSE applies to the engine and reference player.

Open Studio with `?engine=heemang` for a read-only document session. Omitting
that parameter keeps rhwp. The engine is fixed when each WasmBridge is created.

The adapter registers fonts through `addFontFile`, so only requested tables and
outlines enter WASM. It uses catalog families to select the first available
face candidate and default, then rechecks character fallbacks before layout.
Missing outlines trigger a file refetch and repaint. BLAKE3 uses the WASM hasher.
Plain pictures use browser-decoded bitmaps shared across pages; other items and
failed decodes use engine patches. Decoded bitmaps repaint attached pages and
are closed when the document is released. Local files satisfy requests
before bundled WOFF/WOFF2 sources are considered. No proprietary fonts or Hancom
tables are included here.

For local comparison, `RHWP_DEV_FONT_PACK` keeps the existing TTF/OTF import path.
`RHWP_HEEMANG_FONT_ASSETS` optionally points to a JSON array of absolute local
TTF/OTF/TTC/HFT and DAT paths. Its dev-only Vite route registers code tables,
FontMap and hftinfo first, then loads only the families chosen from
`Doc.fontRequests`, including equation fallbacks. Desktop's existing font
host streams font files but has no DAT-table endpoint; the explicit dev manifest
supplies those files during local verification.

Editing, clipboard, save/export/print, search UI, versions/merge, engine-specific
view settings and CanvasKit remain unavailable in Heemang sessions. They throw
`EngineNotSupportedError` with code `ENGINE_NOT_SUPPORTED`, or are disabled by
the existing read-only UI. Live first-page thumbnails use this session's painter.
Cross-list selections are rejected because hm-wasm select currently covers one
paragraph list. Rulers and margin guides are suppressed because pages() does not
expose margins. The adapter keeps registered fonts for the browser session.
