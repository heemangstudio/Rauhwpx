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

## Preserved lanes

Paths below are relative to `/Users/pyu/projects/hobbies/Rau/heemang-wt`. Integration tips before navigation work were Studio `feat/heemang-engine-only` at `72d2b5a2` and engine `feat/studio-integrate` at `802bd97`.

| Lane | Studio / engine worktrees | Saved state when stopped |
| --- | --- | --- |
| HML | `studio-hml` / `engine-hml` | Untracked `hm-hml` codec work; Studio HML metadata/export modules, adapter/type/registration edits and tests. Incomplete, not verified. |
| HWP3 / export parity | `studio-hwp3w` / `engine-hwp3w` | HWP3 completed and merged: engine `813a678`, Studio `c4256062` via merge `7f562e01`. Native 38/38, focused Studio 13/13, 15 real inputs → 30 reopened HWP5/HWPX outputs; live Save/Save As/cancel/failure passed. Worker now owns explicit HWPX export packaging, exact version badge parity and performance verification. Vendor remains temporary in the lane. |
| Remaining methods | `studio-stubs` / `engine-stubs` | Clean at stop. Findings: transpose and furniture shape-ID setters are live stubs; capture/restore and connector references need work; CanvasKit bridge paths need reachability review. |
| Conditional gaps | `studio-gaps` / `engine-gaps` | Clean at stop. Confirmed work includes clipboard objects/HTML, cross-section edits, character borders, outline numbering and object/header/footer variants. Baseline page image/gradient authoring was also restricted, so it is not automatically a parity gap. |

Do not restore the HWP3 lane's vendor from git until its work is reviewed. The final vendor is rebuilt from the merged engine tip with provenance. Inspect `git status --short` in each lane before editing; this table is a checkpoint, not a substitute for current status.

## Measurements and evidence

Earlier full-suite results at the integration tips: Studio 2,977 pass, hub 1,566 pass, engine workspace 316 pass. These precede the stopped lane edits and must not be claimed as their validation.

Fresh checks on the unchanged integration build found the version screen still differs by 8 pixels, showing 15 KB versus 10 KB. Direct mixed-text HWPX export was 13,595 bytes on the old engine versus 8,000 bytes on HeemangEngine. ZIP inspection found differences in preview-image compression, XML and metadata.

The reported footnote first paint of 458 ms versus 182 ms did not reproduce in the isolated rerun. Six warm-open median times were 54 ms candidate versus 56 ms baseline; the original functional flow also passed with first paints 1,607 versus 1,788 ms. Timing depends on warm state and machine load; repeat the original mixed-document sequence before declaring performance resolved. The typing probe missed candidate paint observations, which remains unverified.

Local diagnostic scripts/exports are under `/tmp/heemang-cutover-resume/`. Persist important results before relying on them across machine restarts. Committed verification harnesses are under `rhwp/rhwp-studio/e2e/heemang-verify/`.

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
