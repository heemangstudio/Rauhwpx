# HeemangEngine cutover handoff

Feature work resumed at Andy's request after the navigation cleanup on 2026-10-25. Preserve saved lane edits. This is the current task handoff, replacing transcript/history reads for routine continuation.

Navigation work split the engine's `hm-wasm/src/lib.rs` from 3,858 to 384 lines without changing method bodies. Rust checks passed 37 tests; the rebuilt WASM declarations match the integration vendor. JS checks with real samples passed 60 of 63 tests, with the same three failures on the unchanged vendor: formatting/font resolution, underline-shape roundtrip, and missing glyph-outline assumptions. These remain baseline issues, not fixes made by navigation work.

## Code to read

Studio uses `rhwp/rhwp-studio/src/core/wasm-bridge.ts` → `core/hm/api.ts` + `extensions.ts` → `core/heemang-adapter.ts` → `vendor/hm-wasm`. The old engine is never a fallback. Start with [the bridge map](../rhwp/rhwp-studio/src/core/hm/README.md), then read only your registered implementation and its callers. Base stubs are often overridden.

The engine worktree's `CONTEXT.md` routes tasks to crates. `crates/hm-wasm/README.md` maps exported methods to focused source modules. `types.rs` owns request/result schemas and TypeScript declarations. Consult the relevant contract document rather than reading the entire architecture and parity history.

## Acceptance already agreed

- Close every confirmed old-Studio feature gap, including HML read/write, HWP3 editing and HWP5/HWPX save conversion, remaining bridge methods and conditional limitations. Compare behavior before counting an invalid-input rejection as a gap.
- Resolve the reported first-paint slowdown, verify all four agent modes and revision/review/undo behavior, and verify editing, saving and reopening real HWP/HWPX documents.
- Match layout, styling and displayed values. The version-storage size difference must be investigated through serialization; masking the value in the visual check is not accepted.
- Signed local commits only; no push or PR. Engine `main` remains at MAIN107. No old-engine fallback or copying, porting or paraphrasing old-engine implementation.

## Current lanes and integration

Worktrees are under `/Users/pyu/projects/hobbies/Rau/heemang-wt`. Studio integration is `studio-only` on `feat/heemang-engine-only`; engine integration is `engine-integrate` on `feat/studio-integrate`. Inspect each lane's git status before editing. The bundled vendor is awaiting a final combined rebuild; do not infer current native behavior from its checked-in bytes.

| Lane | Studio / engine worktrees | Current work |
| --- | --- | --- |
| HML and version merge | `studio-hml` / `engine-hml` | HML read/write is merged, including live edit/save/reopen checks. Structural version merging is in progress, using typed document properties and independent three-way merge logic. |
| HWP3, exports and performance | `studio-hwp3w` / `engine-hwp3w` | HWP3 editing/conversion and explicit HWPX export packaging are merged. Cold-open font transfer and preparation remain in progress. |
| Remaining methods and runtime verification | `studio-stubs` / `engine-stubs` | Transpose, captures, furniture IDs, connectors and OLE promotion are merged. Four-mode runtime verification is committed. Available for final combined checks. |
| Conditional gaps and final audit | `studio-gaps` / `engine-gaps` | Formatting, clipboard/resources, objects, header/footer, list restart, last-page masters and template clipboard preservation are merged. Final reachable-gap audit is active. |

Latest integration checkpoints are engine `e48a461` and the Studio commit that records this paragraph. Over `e2c92f9`, the engine merges structural version merging (`208dbfb`), sparse host-font coverage (`ebf68e8`), the audit gap fixes (`fix/studio-audit-gaps`, `cb86974`) and only the accepted rendering milestones `968dc9a`, `5dfe0c6`, `4e2a40d`, `381dcae`, `5921168`, `f72c281` and `05515e0`. Studio merges version merge (`16f5524a`), font performance (`4fcceaeb`), missing-picture verification (`860fa6ea`), the audit gap fixes (`fix/heemang-audit-gaps`, `c064551f`) and `heemangstudio/main` (`d25f784c`). Engine main remains MAIN107.

### Release-candidate integration (2026-10-25)

#### Resumed checks (2026-10-26)

- Studio is signed-rebased onto `heemangstudio/main` `fcefd947` at `a9233132`. The upstream changes since `d25f784c` affect the website, site API and release version; the old engine and Studio comparison baseline is unchanged. The pre-rebase branch is `chore/rc-before-main-rebase-20261026`.
- Engine integration `806027e` adds two accepted HWP3 fixes. Table commit `769282d` closes gaps between imported cells and restores sample16 from 65 to Hancom's 64 pages. The fresh `rc-render-tables/accept-current-20261026` gate passes 687 documents with 14 improved pages and no failures; all 11 importer tests pass with real fixtures.
- Object commit `9e784cc` preserves the overlap flag on paragraph-anchored HWP3 objects. Its isolated binary is byte-identical to the previously accepted `rc-objects-1`; both target documents improve by 525,030 pixels compared with old and retain their 16-page matches. The importer regression was checked red before the fix, and all 11 importer tests pass. The separate vertical-text trial remains excluded. Native before/after crops were visually reviewed for both integrated fixes.
- The combined importer build `rc-806027e` passes all 687 documents: 32 improved pages, no failures, and sample16 retains its gained page-count match. Its native importer suite passes 12 tests with real fixtures.
- Engine integration `e2e0d75` also merges accepted punctuation commits `1501822`/`dd48608`, negative-size picture orientation `c27c263`, and connected paragraph borders `26508c1`. Both Korean exam targets score 13,693 pixels, compared with old's 28,536 and 29,144. The combined frozen candidate passes the full gate against `rc-806027e`: 687 documents, 179 improved pages, 24 neutral, no failures or page-count changes. Renderer tests pass 45 cases; the image and border tests were checked red before their fixes. Evidence is under `rc-render-objects/accept-images-parabox-text/` and `old-images-parabox-text/`.
- These engine changes are not yet in the Studio vendor. The combined native gate, vendor rebuild and final runtime/suite checks remain pending. Rendering, text and performance work continues under the existing release gates.
- Font-argument pilots identified a measurement gap in the footnote pair. Hancom embeds system NanumGothic, absent from the frozen comparison arguments; supplying its exact MobileAsset font gives parity within 2 pixels on the document comparison and zero mismatch on the affected title page. Adding system font directories alone does not resolve the exam-eng regression. Pilot font manifests and scores are separate under `parity/notes/rc-vs-old/`; the frozen acceptance font arguments are unchanged.
- The final minimal font pilot adds only explicit Arial Black and NanumGothic files to the original arguments, avoiding family precedence changes caused by scanning system directories. Its manifest hash is `212db0ebb28526d241eb3f63b466badeaa503d581815300bff3497b0cbcf9716`. Both footnote twins match within 2 pixels; exam-eng still needs layout/rendering work. Its old score stays 840 pixels, compared with 2,371 when system directories were included.

- Vendor `hm_wasm_bg.wasm` is rebuilt from engine `e48a461`: 7,527,537 bytes, SHA-256 `8a5eee93da7b64f1765ce09dea56afc46e84c66297a039dad3d1d199817ea248`. Hashes of all four files are in `rhwp/rhwp-studio/vendor/hm-wasm/README.md`.
- The frozen native parity CLI is `heemang-cleanroom/parity/bins/rc-e48a461` (`cargo build --profile parity -p hm-cli --bin heemang`), SHA-256 `eb1a716c5730b8e71101f68027dcaa8347a173687eb067a9ebc62401a95d3645`. Every engine change after `54900b4` is in hm-wasm or tests, so `rc-54900b4`, `rc-cda58ff` and `rc-e48a461` are the same bytes.
- Integration fixes. Engine:
  - `54900b4` adds the `objects` field to two merged table render tests.
  - `238182c` updates the two stale hm-edit tests: `roundtrip.rs` handles `Format::Hml`, and last-page masters now convert, per `0bc7652`.
- Find and replace now match the old engine. The candidate used to search footnotes, endnotes, headers, footers, captions and grouped-shape text. It also visited cell hits after all body hits, never reported the wrap, and could not match across a footnote mark.
  - Studio `search-text.ts` now uses the old scopes. Find next covers the body and tables at any depth. Find all and replace all cover the body, top-level cells and a drawing's own text.
  - Hits come in document order, and the wrap is reported. Engine `3e2a9df` adds `acrossControls`, and a match spanning a note mark keeps the note when replaced.
  - Probes on footnote-01, endnote-01, header, footer, nested-table, text-box, field and research-report documents now give equal counts, hit sets and next-hit order on both engines.
  - One exception remains, a field-content model difference: click-here field text such as `여기에 입력` is missing from the old engine's paragraph text.
  - Tests: `tests/heemang-find-scope.test.ts`, and engine `studio_bridge::search_across_controls_*`.
- Version history on large documents is fixed.
  - The structural manifest aligned each document with itself and copied the full character format into every text unit: a 185 MB view for the 92-page research report.
  - Building it took about 460 s in WASM. Every opening hit the 5 s worker budget twice, the done event waited 10 s, and the toast `문서는 열렸지만 버전 기록을 준비하지 못했습니다.` appeared. No version was created.
  - Engine `cbd1009`, `d50e982` and `e48a461` build the manifest from one unaligned view and hash sections and documents over their children's hashes. Studio raises `MERGE_MANIFEST_VERSION` to 5, so stored v4 manifests are rebuilt.
  - Result: 0.3 s native, 1.1 to 1.9 s in Node WASM, about 0.6 s in the browser worker. Open completes in 2.35 s (old app 2.31 s) with no toast. The old app builds its manifest in about 300 ms.
  - The live `version-merge.mjs` flow passes. Test: `structural_merge::manifest_hashes_follow_text_and_format_changes_of_each_paragraph`.
- WASM grew from 6.3 to 7.5 MB, almost all from structural merge: the `merge_*` modules (+341 KB of code) and typed `hm_model` property views (+500 KB), plus a 170 KB larger name section. The name section is 0.9 MB in total and could be stripped.
  - Gzipped size is 2.50 MB, against 4.51 MB for the old 12.4 MB `rhwp_bg.wasm`.
  - Median of 7 `WebAssembly.compile` runs under load: 18.5 ms vs 55 ms for the old engine.
  - First paint in the final five-document run is parity or better on all five documents.
- Final checks:
  - Engine: hm-wasm, hm-fonts, hm-model, hm-hwpx, hm-hml, hm-layout, hm-render and hm-edit, 359 passed, 2 ignored, 0 failed. hm-edit `roundtrip` also passes with `HEEMANG_CORPUS`.
  - Studio: typecheck clean; `npm test` 3,027 passed, 0 failed, 2 todo; build passed.
  - Hub: 1,567 passed, 49 skipped.
  - Desktop: 308 passed, 5 failed. The same five `desktop-native-file-follow` tests fail on the old-engine baseline (`/private/var` vs `/var`).
- Harness runs use the fixture Pi provider, against a baseline worktree at `heemangstudio/main` `d25f784c`:
  - `design-diff`: 0 of 23 states differ.
  - `functional`, five documents: no candidate feature failures, no old-engine requests, unsupported toasts or page errors. Press-release select+bold fails only on the baseline.
  - `mcp-parity`: 63 parity, 1 better, 1 poorer (`get_structure` 38 vs 8 ms, single run), 6 failing on both.
  - The footnote-01 find count after the scripted edits (16 vs 18) comes from the harness flow, not from find. The old engine deletes the title table when the mark is typed over its selection; the candidate keeps it and pastes it with the copied mark. Counts on the unedited document are 17 on both.
- Open performance items for the performance lane: research-report typing p50/p95 is still slower (48/65 vs 24/30 ms here, consistent across runs). Single-run p95 spikes appear on press-release and footnote-01.
- Font performance lane evidence is in `docs/evidence/heemang-font-performance/`.

## Measurements and evidence

- The real version badge now displays 15 KB on both builds. Baseline storage is 13,595-byte blob + 1,883-byte snapshot; candidate is 12,907 + 2,003. Explicit HWPX exports preserve preview-image storage, with no padding or display masking. No-op serialization remains source-identical.
- HML and HWP3 live editing, save, save-as, cancellation, failure preservation and saved-output reopening passed. HWP3 corpus conversion covered 15 inputs and 30 reopened outputs.
- Four modes passed in a real authenticated hub with a fixture Pi provider: read-only Chat/Plan, actual Plan approval, revision rejection, staged review accept/reject, grouped and separate undo, version storage and saved-output reopening. Evidence is in `docs/evidence/heemang-agent-modes/`. This verifies the provider fixture rather than a real provider CLI.
- Template import now preserves the user's clipboard through success, failure and undo/redo. Live baseline/candidate copy/import/paste and HWP/HWPX reopening passed. Evidence is in `docs/evidence/heemang-template-clipboard/`.
- Cold-open performance remains unresolved. Warm timing alone concealed the original first-frame gap. Font preparation and excess font transfer are being corrected; repeat the original five-document sequence and unseen-glyph checks before claiming parity.
- Root picture assignment has native and Studio checks, but the actual missing-image file-picker flow still needs a live combined-build check.

Earlier full-suite checks predate the newest merges. Run final combined suites after the structural merge and font work are integrated. Local probes are under `/tmp/heemang-cutover-resume/`; committed harnesses are under `rhwp/rhwp-studio/e2e/heemang-verify/`.

## Worker brief

Give one worker its lane, expected behavior, owned files, worktree and evidence required. Point it here and to the applicable code map; do not paste the transcript or historical shared briefs. Andy authorized four cutover workers plus three separate continuous rendering workers. Do not spawn nested helpers beyond those seven slots. Checkpoint changes and test results in the lane handoff before stopping.

The rendering worktrees are `render-text`, `render-tables`, and `render-objects`, on `fix/render-*-continuous` branches from MAIN107. Their durable checkpoints are in `heemang-cleanroom/parity/notes/render-*-continuous/STATUS.md`. They own text metrics/breaking, table/pagination, and object/furniture rendering respectively. They validate against cached official Hancom references using `heemang-cleanroom/tools/accept.py`; only passing candidates are eligible for integration. Main's unrelated uncommitted old-Hangul work is preserved. Serialize expensive render builds to stay within available disk and memory.

Use `CARGO_BUILD_JOBS=3`, separate target directories and bounded output. Do not read generated WASM/JS, corpus bytes or whole log files into context. Start with `rg --files` and `rg -n` in the relevant module. Keep full logs on disk; report failures and summary counts. Use existing helpers and module interfaces before adding abstractions.

## Focused verification

Run from the Studio repository root. For engine-backed tests against an unbundled build, set `HM_WASM_PKG` to its `target/hm-wasm-pkg/web` directory.

```sh
npm --prefix rhwp/rhwp-studio exec -- tsc --noEmit -p rhwp/rhwp-studio
node --test rhwp/rhwp-studio/tests/heemang-<area>.test.ts
node rhwp/rhwp-studio/e2e/heemang-verify/design-diff.mjs versions-changes
node rhwp/rhwp-studio/e2e/heemang-verify/functional.mjs footnote-01
```

Use the existing headless harness for real Studio interactions, with fake-provider checks labeled as such. Assign a separate port per lane and stop servers after checks. After integration run full Studio/hub suites, engine tests, `design-diff.mjs`, `functional.mjs` and `mcp-parity.mjs`; update `heemang-cleanroom/STATE.md` after merges with concise results.
