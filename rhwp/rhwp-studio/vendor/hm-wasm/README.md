# hm-wasm

Generated browser bindings and WASM from HeemangEngine commit
`1d396f76bd1f277695d5905bb77d2ac7cb9716e3`, built on 2026-10-23.
The source checkout had the same HEAD before and after the build. Contract and
page-packet versions are both 1. The package is committed so Studio does not
need the HeemangEngine checkout to run or build.

`hm_wasm_bg.wasm`: 3,401,615 bytes, SHA-256
`0c186f0b5ff748346d25f60b9ca37e4acb669e0927c40837c2bed3425865e3bb`.

To refresh, run `CARGO_BUILD_JOBS=3 ./build.sh` in HeemangEngine's
`crates/hm-wasm`. It requires wasm-bindgen 0.2.125; set `WASM_BINDGEN` to its
binary if it is outside PATH. Copy the four generated files from
`target/hm-wasm-pkg/web/` here and update this provenance. The TypeScript
Canvas2D player in `src/view/heemang-player.ts` ports `crates/hm-wasm/js/player.mjs`.
The accompanying LICENSE applies to the engine and reference player.

Open Studio with `?engine=heemang` for a read-only document session. Omitting
that parameter keeps rhwp. The engine is fixed when each WasmBridge is created.

The adapter receives full font bytes from Studio's existing system/imported-font
pipeline before metric subsetting. Bundled WOFF/WOFF2 sources use Studio's shared
SFNT decoder. Browsers without Brotli decompression need local SFNT fonts for
WOFF2 sources. No proprietary fonts or Hancom tables are included here.

For local comparison, `RHWP_DEV_FONT_PACK` keeps the existing TTF/OTF import path.
`RHWP_HEEMANG_FONT_ASSETS` optionally points to a JSON array of absolute local
TTF/OTF/TTC/HFT and DAT paths. Its dev-only Vite route registers code tables,
FontMap and hftinfo first, then loads only the families chosen from
`Doc.fontRequests`. Include HancomEQN.ttf for equations. Desktop's existing font
host streams font files but has no DAT-table endpoint; the explicit dev manifest
supplies those files during local verification.

Editing, clipboard, save/export/print, search UI, versions/merge, engine-specific
view settings and CanvasKit remain unavailable in Heemang sessions. They throw
`EngineNotSupportedError` with code `ENGINE_NOT_SUPPORTED`, or are disabled by
the existing read-only UI. Live first-page thumbnails use this session's painter.
Cross-list selections are rejected because hm-wasm select currently covers one
paragraph list. Rulers and margin guides are suppressed because pages() does not
expose margins. Font registration has no unregister operation.
