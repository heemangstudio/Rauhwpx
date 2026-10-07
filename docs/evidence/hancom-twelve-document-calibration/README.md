# Twelve-document engine checkpoint

The stopped calibration campaign accepted twelve defect-bearing documents at engine commit `2c415886995b219b2209b9e182e6f6401b9d93f8`, tree `1fc3ed296834995cade9c066b799f20a310b8aca`. Ten commits after base `6148a38a` contain the accepted engine changes. Five initially passing fixture documents served as controls and are excluded from the twelve-document count.

| Accepted documents | Engine changes | Acceptance commit |
| --- | --- | --- |
| cell-mixed-text | Keep justification on automatic wrapping before inline pictures. | `9ab405e7` |
| gov-excavation-report | Reconcile fresh and saved line layout, cell paint order, conical fills and browser font identity. | `6af1dc8b` |
| gov-fire-report | Match fresh table rows, double borders and registered font advances. | `1372c052` |
| medicine-plan, birthday-receipt, work-change, water-plan | Preserve wrapper placement, nested measurement, saved row endpoints and quote advances. | `35e792b9` |
| meal-payment, audit-opinion | Keep wrapper heights through refresh and retain registered corner quote advances. | `84913972` |
| training-annotation | Place inline annotations with native widths and baselines while preserving control ownership. | `a3df72b9` |
| fdi-2024-q1 | Resolve script font slots and distributed widths; measure and paint with the imported Hancom face. | `afdaaee9` |
| fdi-2024-q2 | Apply native negative character spacing to supported plain text. | `2c415886` |

The cumulative diff changes renderer composition, table measurement and placement, text metrics, ruby layout and paint replay. Studio changes support imported font identity, rendering order and flow-image clipping. Existing regression suites cover these behaviors. The checkpoint adds no application UI controls.

Prior validation on the accepted content tree recorded 5,361 Rust tests passed, zero failed and 68 ignored. Studio recorded 2,628 passed, zero failed and one skipped, with TypeScript exit zero. A fresh WASM build succeeded. Native comparisons cover 38 pages across 17 entries, including six synthetic controls; browser review verified 152 captures across screen and print with required and empty font imports. Q2 retains its native nine-page count with 0.02% worst-page and 0.06% worst-band mismatch. Required-font Studio screen and print each record 0.01% worst-page and 0.04% worst-band mismatch.

Empty-font captures measure fallback behavior. Their remaining font differences and a cross-reproduced desktop font-discovery variation are retained in the private analysis evidence. Unsupported fonts and layouts retain their existing rendering routes. Lecturer and Mock proposals remain unaccepted and are excluded from this branch.

PR preparation rehashed all 23 final source pins, eight frozen WASM package files, the WASM build log and the complete Rust test log. The Rust log SHA-256 is `70f2f04f04d925cb1edc996942d77736b94d125cb78125d6e211d613fb05545e`; the WASM SHA-256 is `16f391496079f08e8fa0e6f90101046b1369e9a93319f0c2e6a1e8bb3e0e2aba`. No calibration, native export or GUI run was restarted while preparing this PR.

The [checkpoint manifest](checkpoint.json) lists accepted document identities, source commits, prior results and private analysis paths. Stop checkpoint `3e201f69` preserves the analysis records separately. The [inline-picture comparison](../hancom-inline-picture-justification/README.md) contains committed visual evidence for the first accepted fix.

The PR integrates the accepted fixes with main `674159d8`. Resolution covered 23 files and retained main's newer font grids, HFT fallback, inline-object safeguards and parser changes. Integration repairs remove duplicate terminal-space and tracking corrections, preserve cell flow guards, and distinguish Windows baked metrics from macOS registered-face metrics. The original checkpoint measurements above describe the accepted tree; the integrated engine is checked separately below.

Integration validation is in progress. Studio has 2,672 passing tests and two skips. Rust compilation, formatting, publish documentation and website checks pass. The complete Rust suite and fresh WASM/Studio build must pass before merge.
