# hm-wasm

Generated browser bindings and WASM from HeemangEngine commit
`c953ceb` (main, MAIN106), built on 2026-10-24.
Built from a git archive of main in an isolated output directory; the source checkout was read-only. Contract and
page-packet versions are both 1. The package is committed so Studio does not
need the HeemangEngine checkout to run or build.

`hm_wasm_bg.wasm`: 4,524,413 bytes, SHA-256
`b5d9addc9dc0d598b72a02b0113b430aa0d6f4b4523b0dbfc4a2c7e53cbbfa9d`.

To refresh, run `CARGO_BUILD_JOBS=3 ./build.sh` in HeemangEngine's
`crates/hm-wasm`. It requires wasm-bindgen 0.2.125; set `WASM_BINDGEN` to its
binary if it is outside PATH. Copy the four generated files from
`target/hm-wasm-pkg/web/` here and update this provenance. The TypeScript
Canvas2D player in `src/view/heemang-player.ts` ports `crates/hm-wasm/js/player.mjs`.
The accompanying LICENSE applies to the engine and reference player.

Open Studio with `?engine=heemang` for an opt-in document session. Omitting
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

HWP5/HWPX sessions support typing, buffered Korean IME commit/cancel, empty
paragraphs, joins, character/paragraph formatting, search and same-format save.
Native receipts invalidate only changed pages, restore directed text selections
and identify undo history. Native dirty state follows the saved history position;
`markSaved(expectedEpoch)` acknowledges a successful write without serializing again.
A narrow selection fallback remains for format redo and rich-paste undo, where this
engine revision omits native selection metadata.

`selectRange` normalizes body/table endpoints to whole controls and cross-cell
endpoints to tagged cell blocks, including merged cells. Studio supports cell-block
delete, formatting and TSV/HTML copy; cell copy does not create an internal rich
fragment. Whole-object clipboard, HWP3 writing, extended font/style/list/table
structure editing, HTML import and cross-format saves remain unavailable. See
`output/heemang-editing/engine-requests.md` for remaining engine requests and
`output/heemang-editing/slice3/` for measured verification. Rulers and margin guides
remain suppressed. Registered fonts live for the browser session.
