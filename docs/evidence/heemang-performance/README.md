# Performance work in progress

The separate guide-redraw fix is signed Studio commit `f215bb7c`, integrated as `6977948c`. Its evidence is in [async-redraw](async-redraw/README.md). Performance trials remain unqualified. The first frozen seven-run research gate passes cold open, 1151.9→480.1 ms, and fails typing p50 16.2→17.0 ms and p95 26.5→26.7 ms. The strict gate is unchanged: every measured document must have cold first-visible and typing p50/p95 medians no slower than the old-engine app, using at least seven fresh-context runs. The subsequent causal table-query control and correctness checks are in [table-info-cache](table-info-cache/README.md).

## Inputs and runtime

- Baseline: isolated detached `d25f784c` at `/private/tmp/heemang-perf-resume/baseline-main`, old generated WASM from `studio-baseline`. The old engine source tree IDs at `a2dc5c36` and `d25f784c` are identical. Old engine source was not inspected.
- Initial candidate snapshot: `studio-hwp3w` at `f611e5c1`, engine `engine-hwp3w` at `e48a461`, with preserved uncommitted trials. Initial lane WASM SHA-256 is `7910f2194ad2182c4e645c7c7cdd6e12f3c0338194783f066fc7a13e8765a0c3`.
- Real headless Studio at baseline `http://127.0.0.1:7743/` and candidate `http://127.0.0.1:7733/?engine=heemang`. Hubs use fixture Pi providers; input and document rendering use the real runtimes.
- The original five inputs are mixed Korean/Latin HWPX, table borders HWPX, press release HWP, `footnote-01.hwp`, and `1341000` research report HWP. The sixth input is corpus `d-footnote-01-d363a97c53ae.hwpx`. Research was already one of the original five; it is not counted twice.
- The harness writes exact document, revision and WASM hashes beside each JSONL output. `cold-open-summary.mjs --check` fails on a slower median, insufficient runs, page errors or missed edited frames. Overlapping quartiles do not turn a slower median into a pass.

## Initial diagnostic

Command from the candidate repository root, with `HV_BASELINE=/private/tmp/heemang-perf-resume/baseline-main`:

```sh
node rhwp/rhwp-studio/e2e/heemang-verify/cold-open-bench.mjs \
  --mode=typing --docs=report --runs=1 --warmup=0 \
  --out=/private/tmp/heemang-perf-resume/research-initial
```

One sample only, same 228-character body target, no page errors:

| Runtime | p50 ms | p95 ms |
| --- | ---: | ---: |
| Baseline | 15.1 | 26.2 |
| Preserved trial | 16.9 | 29.1 |
| Trial with page-local redraw disabled | 16.0 | 26.9 |

These samples reproduce a gap but do not qualify performance. A seven-run attempt was interrupted to return the exclusive resource slot; it is incomplete and excluded from acceptance.

A separate 100-microsecond CPU profile of the trial has 62.8 ms inclusive native relayout, including 46.8 ms pagination and 17.2 ms `LineFacts::ensure`; `pageStable` has 16.3 ms. Font refill and native patch work are small in this sample. Profiled timings are excluded from acceptance.

## Line-facts trial

The inherited cache checked every line range on every per-line access. The new trial resets facts when a paragraph is first formatted, at both subsequent `format` replacements, and after the in-place square-gap `reflow`. Queries are constant-time and borrow control slices.

The first version omitted the in-place `reflow`. Existing behavioral test `preceding_square_bands_reflow_only_the_stored_spans_they_block` failed with cache length 2 and line index 2. After the missing reset was added, that exact test and the focused suites passed: hm-layout 72 passed, 1 ignored; hm-wasm 12 passed; Studio 71 passed; TypeScript and formatting clean. A fresh current-base hm-layout run passes 130 tests, with one existing ignored test. The wire-behavior test covers floating and inline controls, Hangul, a surrogate pair, tabs, paragraph ends, reordered/overlapping/empty ranges and reuse after paragraph/reflow changes.

Only outer section pagination uses this `Flow` cache. Nested table/caption stacks and footnote frames do not receive that `Flow`. Pending table continuation uses it without reading or resetting facts; endnotes use it after the body paragraph loop.

A separate corrected-trial profile has 10.98 ms line-facts reset work, 60.86 ms native relayout and 78.12 ms `replaceBodyTextLocal`. The inherited page-local shortcut was removed; ordinary redraw is restored and its `pageStable` work is gone. These profiles are diagnostic, not repeated-median acceptance. Corrected trial WASM is 7,537,788 bytes, SHA-256 `8174d3ba83a10a83fecadcec83a1b301081c1d57bf26805eb5d07adde8af9728`, built from accepted engine `806027e` plus the preserved native trials. Engine source has since fast-forwarded to `e2e0d75`; a final accepted-base rebuild remains due.

## Glyph-run reuse probes

The real typing path replaces the edited page's decoded packet. A runtime-only WeakMap identity cache therefore had zero hits and 4,257 misses. No production identity cache was added.

A runtime-only content-key cache has 6,923 hits and 972 misses with a 256-entry bound. Cached and uncached painting of each exact same packet, scale and font generation matched at all 41 strokes, with zero differing pixels and no page errors. The initial full-refresh oracle also exposed the independent guide issue fixed above. Correctness runs were concurrent with other work and their latency fields are excluded. The subsequent causal profile and production correctness checks are in [glyph-run-cache](glyph-run-cache/README.md). The separate signed cache commit is `441f9e48`; seven-run qualification remains pending.

`--mode=structure` prepares a first-call `get_structure` loop against the real UI's engine and real `AgentToolExecutor`; hub transport is checked separately through MCP parity. It has not been measured yet.

Temporary preservation patches, logs and raw diagnostic samples are under `/private/tmp/heemang-perf-resume/`. No generated vendor bytes are to be committed. Final rebuild belongs to integration.


## Completed visible-result signal

Typing now records the earliest observed frame matching the completed page bitmap. Three stable frames and completion of visible native-outline requests establish the final bitmap. The timestamp is captured before extraction and hashing; capture cost and quiescence are recorded separately. Earlier revision-painted and changed-frame timings remain diagnostic records and cannot satisfy the typing gate.

One concurrent research sample with this signal had baseline p50/p95 14.3/24.1 ms and candidate 13.8/39.3 ms. Seven IME keys showed completed pixels after the earliest changed frame. The trace maps all seven to the approved `TESSMHG.HFT` source, family 신명 신신명조. A temporary runtime-only retention control eliminated those seven refills and late bitmaps; its observed-character list was never a production fix and has been removed from the harness.

## Host HFT source-retention trial

The host path now retains the HFT source after its first real full read, using the existing parsed HFT representation. It reuses a repeated label, shares that payload among its family members, and keeps face IDs and labels stable. A new bank clears the family's cached face so previously resolved families see its glyphs. `add_compact` and sparse TrueType storage/refill remain unchanged. No prewarm character list or additional WASM API is added.

Native red controls fail on an unseen compatibility jamo `ㅆ` under compact registration and on Latin `A` when the family-cache reset is removed. The fixed hm-fonts and hm-wasm suites pass 106 tests, including other unseen jamo/syllables, `TESSMEN.HFT` as a second bank, compact-source promotion with owed relayout, repeated registration, release and TrueType equivalence. Focused Studio tests pass 31/31 and TypeScript checks pass.

The lane-local build uses accepted engine base `e2e0d75` plus the isolated LineFacts and HFT trials. Temporary WASM is 7,544,291 bytes, SHA-256 `be2b5cb9d31bef505bdd22faa192791996560fce126a02baff08389c2a822b3d`. It is excluded from commits. The real 41-stroke IME trace has zero outline refills and zero late completed bitmaps. Full-redraw and exact-packet pixel oracles both pass 41/41; reopening instance 1→2 at the same font generation 54 also passes. Native font bytes stay 29,886,155 across typing, about 18.35 MB above the earlier compact trial. The separate signed engine commit is `e2e64f0`, with evidence in its `docs/evidence/host-hft-retention/`. Cold/typing repeated medians remain pending.

## Remaining trial inventory

- LineFacts lifecycle reset and borrowed control slices are separately signed as engine `de9d79e`. The unchanged full acceptance gate passes 687 documents / 11,498 pages against e2e: three SVG changes are exact RGB equality, with zero page-count changes or failures. Repeated runtime qualification remains due.
- Content-run reuse is separately signed as `441f9e48`, with exact-packet pixel equivalence. It remains unqualified by the strict timing gate.
- Fused IME replacement is separately signed as `0ef8ea4f`, with expanded body/cell tab/CRLF/newline/emoji semantic coverage in `4c72d6ae`. Focused fields/transaction tests pass nine cases. Its split control increases relayout CPU 56.97→72.80 ms over 41 strokes; latency remains unqualified and the split control is preserved.
- The five-line no-field guards are separately signed as `a377d2c8`. In the quiet causal control, removing only those lines increases native query CPU from 16.22 to 745.89 ms across the same 41 strokes. Evidence is in [field-query-guards](field-query-guards/README.md).
- The inherited native RGBA patch cache, broad Hangul prefetch, retaining-characters API and page-local redraw shortcut are removed from production source and preserved externally. No generated vendor bytes will be committed.


## Additional live controls

The fixed cache matches uncached exact-packet pixels 410/410 times across all six documents and ten body/cell targets. All six document replacements at unchanged font generations pass. Real TrueType outline refills advance generations from 3 to 21 and from 28 to 49 in these checks; the cache keeps no partial path through them. There are zero page errors. These correctness runs overlap other work and exclude every latency field from acceptance.

The real input handler also passes IME commit/click/Undo/Redo, then `ㄸ → 따 → 땅` followed by Escape cancellation. Cancellation restores empty text and the original anchor without an application Undo/Redo step. Fresh input `다` and subsequent Undo/Redo pass. This is the fixture-hub real Studio at port 7733.

The quiet one-pair HFT diagnostic has complete first-visible ink on both apps: baseline/candidate 1,146/435 ms. Completed-result typing remains slower at p50 13.2/14.9 ms and p95 23.1/27.3 ms. The refill tail is gone; no strict performance pass is claimed. The post-HFT field-query control is complete, with the causal result above. The isolated fused-IME CPU control is complete; completed-result repeated latency remains pending.

A runner-only teardown fix closes Chrome's owned output pipes after its process has exited. The previous two referenced PipeWrap handles held Node idle about 19.4 seconds after results. The same two-app lifecycle repro now has zero active resources and exits in the same millisecond as the final output line. Server process-tree cleanup remains in place.


## Frozen benchmark interpretation

The manifest records engine revision and source hashes separately from Studio source and vendor WASM hashes. It includes exact LineFacts and fusion patch hashes against their fixed bases, current dirty patch hashes, and cache/guard/fusion/HFT commit IDs.

The baseline lacks the candidate's positive per-page outline-completion counter. Baseline readiness uses painted revision and three stable nonblank bitmap frames. Interpretation assumes its whole-font registration leaves no late outline refill after open, supported by the earlier first-paint/font-settle checks; this observer does not independently count baseline outline promises. Candidate quiescence additionally waits for visible outlines and their repaint. Both latency values are the earliest observed frame matching the completed bitmap, with extraction and later quiescence excluded.
