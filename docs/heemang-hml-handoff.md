# HML lane checkpoint

HML now opens, edits, exports and saves through HeemangEngine. The `hm-hml` codec maps HWPML XML into the existing typed OWPML mapping, with UTF-8, UTF-16 and EUC-KR decoding, base64/compressed resources, formatting, nested tables, pictures, shapes, equations, headers, footers, notes and section master pages. Original root metadata and script tails survive same-format saves.

Studio registers real `exportHml`, `hasHmlExportCapability`, `getHmlSaveState` and `getHmlOpenMetadata` implementations in `core/hm/hml-document.ts`. The adapter records HML source metadata and permits editing; existing save commands and format dialogs consume those capabilities. No styling changed and no generated vendor files are committed.

Validation on the lane:

- `cargo test -p hm-hml`: 5 passing behavior tests, including the real `aligns`, `formatting_table` and equation HML samples; model formatting, tables, picture bytes, headers/footers/notes, master pages, encodings, compressed resources and HWP5/HWPX roundtrips.
- `cargo test -p hm-wasm --test hml`: 2 passing API tests for editing, undo/redo, save state and paired HWP5/HWPX equation conversion.
- `cargo check -p hm-cli -p hm-wasm`, `cargo clippy -p hm-hml`, and `cargo fmt --all -- --check`: passed.
- `HM_WASM_PKG=<engine-hml>/target/hm-wasm-pkg/web node --test .../tests/heemang-hml.test.ts .../tests/hml-source-metadata.test.ts .../tests/heemang-font-flow.test.ts`: 10 passing checks. Real `test-image.hwp`, `test-image.hwpx` and `footnote-01.hwp` retain nested lists and picture data through HML and both output formats.
- Studio TypeScript check passed. Full Studio suite: 2,982 passed, 0 failed, 2 existing TODOs.
- `node rhwp/rhwp-studio/e2e/heemang-verify/hml.mjs`: 7 live scenarios passed at `http://127.0.0.1:7721/?engine=heemang`. Opened real HML, typed Korean/emoji into its textbox, saved/reopened, canceled format selection, selected HML/HWP5/HWPX output formats and reopened each, then rejected malformed HML without losing the current document. Local fixture-backed hub; no provider calls, page errors or old-engine requests. Servers stopped after the run.

Live report, written files and before/after/dialog screenshots are under `rhwp/rhwp-studio/e2e/heemang-verify/out/hml/`. The script temporarily used the lane WASM build; the checked-in vendor was restored afterward. Engine branches are based on navigation tip `5f68adf`; signed engine HML commits begin at `cadcbe1` on `feat/studio-hml`.

The existing shared conversion guard in `hm-edit/src/lines.rs` still rejects cross-format conversion of last-page masters. Normal section masters are covered by the new HML roundtrip test. No HML bridge method remains stubbed.
