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

Latest integration checkpoints are engine `54900b4` and the Studio commit that records this paragraph. Over `e2c92f9`, the engine merges structural version merging (`208dbfb`), sparse host-font coverage (`ebf68e8`) and only the accepted rendering milestones `968dc9a`, `5dfe0c6`, `4e2a40d`, `381dcae`, `5921168`, `f72c281` and `05515e0`; `54900b4` adds the `objects` field to two merged table render tests. Studio merges version merge (`16f5524a`), font performance (`4fcceaeb`), missing-picture verification (`860fa6ea`) and `heemangstudio/main` (`d25f784c`). Engine main remains MAIN107.

### Release-candidate integration (2026-10-25)

- Vendor `hm_wasm_bg.wasm` is rebuilt from engine `54900b4`: 7,517,203 bytes, SHA-256 `fd7ea2ac9b303b53cdf2f35bb0a29b2be14c468d09f0bdc2330a3e403b695c81`. Hashes of all four files are in `rhwp/rhwp-studio/vendor/hm-wasm/README.md`.
- The frozen native parity CLI is `heemang-cleanroom/parity/bins/rc-54900b4` (`cargo build --profile parity -p hm-cli --bin heemang`), SHA-256 `eb1a716c5730b8e71101f68027dcaa8347a173687eb067a9ebc62401a95d3645`, manifest `rc-54900b4.json`.
- Engine focused tests (hm-wasm, hm-fonts, hm-model, hm-hwpx, hm-hml, hm-layout, hm-render): 324 passed, 2 ignored, 0 failed over 57 binaries. hm-edit has two stale tests that predate this integration. `tests/roundtrip.rs` does not compile because it does not match `Format::Hml` (since `cadcbe1`). `conversion_membership::unplaced_furniture_and_last_page_master_refuse_partial_output` still expects last-page masters to be refused, but `0bc7652` made them convert.
- Studio: typecheck clean; `npm test` 3,011 + 20 passed, 0 failed, 2 todo; build passed. Hub: 1,566 passed, 49 skipped; the single full-run failure (`project-migration` metadata coalescing) passes 5/5 when run alone. Desktop: 306 passed, 7 failed. Old-engine `studio-baseline` (`a2dc5c36`) fails the same five `desktop-native-file-follow` tests (`/private/var` vs `/var` tmp paths) and `desktop-owned-browser` hidden guests. `desktop-browser-agent-tools` passes alone.
- Harness, fixture Pi provider: `design-diff versions-changes` 0 px. `functional footnote-01` has every feature at parity, with no old-engine requests, unsupported toasts or page errors. Typing p50/p95 over three runs, baseline/candidate: 20/40, 24/34, 22/42 vs 24/53, 26/33, 18/55. The p95 median is 40 vs 53 ms, still unresolved. Find-replace for `3D` counts 16 matches on baseline vs 19 on candidate, the same as the font lane's earlier evidence.
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
