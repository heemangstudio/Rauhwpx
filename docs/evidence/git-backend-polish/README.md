# Local history verification

Browser storage benchmark on macOS with Chrome, comparing baseline `26cbce4c` against storage/controller phase `b9ca7d46`. Each timing is the median of five runs. Payload reads and global scans are totals across those five runs.

| Operation | Before, ms | After, ms | Payload reads | Global scans |
| --- | ---: | ---: | ---: | ---: |
| Checkpoint | 15.1 | 16.9 | 10 → 0 | 0 → 0 |
| History refresh | 41.6 | 26.2 | 2550 → 0 | 0 → 0 |
| Ancestry | 2.9 | 3.5 | 0 → 0 | 5 → 0 |
| History export | 2659.4 | 2805.5 | 2050 → 2050 | 10 → 0 |
| 8 MiB accounting | 10.7 | 0.8 | 10 → 0 | 0 → 0 |
| 8 MiB checkpoint | 606.3 | 584.1 | 10 → 0 | 0 → 0 |
| Image history export | 3831 | 3784.8 | 35 → 35 | 10 → 0 |

Sampled peak renderer heap: 157,979,815 → 148,565,934 bytes. Sampling runs every 10 ms and after each operation; it excludes native IndexedDB allocations.

The fixture contains 205 history commits, 200 unrelated commits, and a separate six-commit history with 8 MiB payloads. Payloads are synthetic storage fixtures with HWP signatures. This measures the store and portable archive path, excluding editor rendering and document capture. Real WASM browser tests separately verify that dirty checks and repeated captures share one export per editor revision.

History refresh and storage accounting improved; checkpoint, ancestry, and export timings did not all improve. The durable result is removal of global scans and accounting payload reads. Export still reads the objects it must package. Small timing differences are sensitive to concurrent local builds.

Reproduce from `rhwp/rhwp-studio`:

```sh
node scripts/benchmark-versioning.mjs --root=/path/to/baseline/rhwp/rhwp-studio
node scripts/benchmark-versioning.mjs
```

Recovery UI evidence: [before](before.png) and [after](after.png), captured from the production sidebar preview in an isolated headless browser.

The full sidebar suite fails at `cloud-stream.check.mjs:13` on both baseline and changed code. The sidebar build and focused Versions browser tests pass.

The complete versioning and portable-history suite passed all 121 tests against rebuilt WASM. It covers recovery across IndexedDB restart and name reuse, interrupted metadata backfill, import validation, maintenance/undo protection, capture reuse, and merge review. TypeScript checks passed.

The real-editor selective-review browser test accepts an image insertion while rejecting an unrelated text edit, then exports and reloads the result twice in both HWP and HWPX. Rust tests also cover all four image/text selection combinations and independent paragraph insertion/deletion choices.

Selective-review UI evidence: [before](../selective-merge-review/before.png) shows one document-wide choice; [after](../selective-merge-review/after.png) shows the image accepted and text rejected, with the local paragraph preserved. The fixture uses an existing application icon and the production resolver.

All 59 focused Rust merge tests passed with `cargo test --lib merge:: --quiet`, including Korean/emoji edits, repeated/missing paragraph identities, resource remapping, and stable review choices before and after lazy image loading.
