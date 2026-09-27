# Editor engine integration verification

The merged engine preserves #374's native output and uses #373's browser font measurement/substitution policy. A controlled comparison across 14 documents and 31 pages favors that browser policy overall: ink-weighted Hancom mismatch falls from **8.4617% to 6.7890%**. The follow-up also fixes a race in which late desktop font discovery could replace a face explicitly imported by the user.

This choice has document-level tradeoffs. It improves the four-page public-health table substantially, while the first page of `hwpx-h-01` and the Korean exam favor #374's raw imported-face policy. All page counts match. Existing layout defects remain in the random sample; the results establish comparative parity on this corpus, not universal parity.

## Builds and integration

| Revision | Role |
|---|---|
| `0db1b63041e429fb46a80fd076937a9405b5c3a5` | Original #372 head |
| `3b3e00a9c8ae36d089af942d9a00f815eccec40c` | Original #373 head |
| `6ab868ff524f39f1cd1d21adf698cd35926da371` | Final original #374 baseline |
| `7372895d481b53c471c2d61db67216422be5e663` | Initial locally combined engine |
| `9a7b639af9f1b1638e27efe17fba12df8f5c192d` | Main after #372, #373 and #374 merged; tree equals the combined engine |
| `9098df53f79ab61e947cda3d08b346e269c77ff5` | Imported-face priority fix, published as `5eade895` |
| `a112a5ba1495e52da70713b3683382ac69575f44` | Selected browser policy, published as `4b3e0fcb` |

The merges retain #372's glyph/font rendering repairs, #373's live editing and font discovery/registration, and #374's table, footnote, equation and native font fixes. This follow-up changes only the browser body-text measurement/substitution policy and asynchronous font registration and its atlas verification guard, plus Rust formatting. Native custom-face metrics and embedded-font shaping remain intact. The original PRs were merged through normal required checks and signing/linear-history rules.

## Method

The procedure follows [#374's verification](../pr374-parity/README.md): export Hancom-for-macOS PDFs, render native Skia and live Studio Canvas2D at 200 dpi, score ink-distance mismatches with tolerance 4, and inspect the rendered pages. All 31 pages were reviewed in the six contact sheets below.

The eight #374 documents contribute 22 pages and reuse its final reference PDFs. Six documents contribute nine more pages, selected with `random.Random(20260927).sample` from nine sorted repository samples that have same-stem PDFs of one to four pages, excluding the baseline stems. Existing PDFs only bounded the selection; **all six selected references were freshly exported through Hancom on this Mac**. [Selection and population](selection-portable.json) and [source/PDF hashes](document-receipts.json) record the inputs. This is a seeded sample of that eligible subset, not of every repository document.

Native uses installed Hancom TTFs plus the nine converted HFT faces already audited in #374. Baseline and combined builds receive identical fonts. Studio imports each document's required font files through production `importLocalFontFiles`, then opens the actual HWP/HWPX through the application's event bus and renders with `renderPageToCanvas`. Each document receives a fresh browser context. Both policies use the same references, fonts, viewport, backend and DPI. [Font filenames, sizes and hashes](studio-font-receipt.json) record all 115 manifest entries. Proprietary fonts and generated font binaries remain local.

The A/B isolates font policy on the combined engine; it is not a comparison of unrelated full PR snapshots. The normal build uses #374's imported raw-face advances and availability hook. The diagnostic alternate makes those two hooks return null/false, retaining runtime metrics registration, equation font access and Canvas font painting. This also restores the prior legacy-HFT substitution decision, so the measured change includes both measurement and substitution. The production follow-up removes those hooks and their WASM cache, retains embedded shaping, and uses baked metrics followed by the runtime registry.

Captures use a clean server after source edits. The A/B checks hook identities against the imported font module. Production requires the removed hooks to be absent and rejects timestamped HMR font modules. Earlier captures with split HMR module state were discarded; they do not support a product regression claim.

The rebuilt production WASM was captured without diagnostic overrides: **14 documents, 31 pages, 115/115 font imports, zero page errors**, and **zero changed pixels against the selected diagnostic on every page**. [Production receipt](studio-production-receipt.json) includes per-page image hashes and the WASM/capture-script hashes.

## Results

Worst-page Hancom mismatch, lower is better. These are raster metrics, not percentages of incorrect document content. Native baseline and combined images are pixel-identical on all 31 pages.

| Document | Pages | Native, both builds | Studio raw-face | Studio selected |
|---|---:|---:|---:|---:|
| el-school-001 | 1 | 0.85% | 0.85% | 0.86% |
| hy-001 | 2 | 0.03% | 0.00% | 0.00% |
| tb-org-02 | 1 | 0.02% | 0.00% | 0.00% |
| eq-002 | 1 | 0.60% | 0.91% | 0.90% |
| exam-kor-1p | 1 | 1.19% | 1.13% | 1.48% |
| footnote-01 | 6 | 0.77% | 0.75% | 0.75% |
| hwpx-h-01 | 9 | 0.02% | 0.59% | 3.61% |
| landscape-001 | 1 | 0.00% | 0.00% | 0.00% |
| random-01-issue_241 | 1 | 11.95% | 13.27% | 13.27% |
| random-02 | 1 | 60.32% | 61.15% | 59.98% |
| random-03-exam_math_8 | 1 | 46.07% | 42.01% | 41.72% |
| random-04 | 4 | 32.69% | 34.64% | 32.19% |
| random-05-text-align-2 | 1 | 5.27% | 6.75% | 6.75% |
| random-06-pua-test | 1 | 4.49% | 4.55% | 4.61% |

The aggregate combines all page ink/error counts, rather than averaging each document's worst page: raw-face **528,529 / 6,246,145** pixels, selected **420,522 / 6,194,209** pixels. Full page-level scores and visual classifications are in [studio-ab-comparison.json](studio-ab-comparison.json); exact native comparisons are in [native-comparison.json](native-comparison.json).

The largest improvement is `random-04`: pages 1–3 change from **25.10%, 16.74%, 18.89%** to **9.17%, 0.16%, 2.79%**. Text advances and row alignment move visibly closer to Hancom. Page 4 still begins one row later than Hancom, an inherited table continuation defect also present in native rendering.

The main tradeoff is `hwpx-h-01` page 1, **0.59% → 3.61%**, with wider bold text and changed wrapping; page 3 changes from 0.00% to 0.41%. The Korean exam changes from 1.13% to 1.48%. The original raw-face build remains better for those pages. No document-name exceptions or sample-specific constants were introduced. The selected policy improves the overall measured corpus, especially its previously unseen table document.

The large residuals in `random-02` and `random-03` exist in the baseline too: title/table geometry and logo differences in the application form, and Korean missing-glyph boxes inside a math equation. PUA diagnostics also retain differences. These were not masked or counted as integration fixes.

## Imported-face race

Desktop discovery can begin before a user import and finish afterward. Previously, its registration replaced the imported face with a desktop record, dropping the retained font bytes and changing the runtime family without advancing the imported generation. The fix checks imported ownership before and after `FontFace.load`, reuses the winning imported face and its metrics, and avoids charging its bytes again to desktop discovery. Converted HFT registrations advance the retained-byte generation.

A live Dinaru probe demonstrates the failure and repair. Before the fix, a 646,568-byte imported face became a desktop face with no retained bytes; after the fix, the same imported record, bytes, runtime family and generation survive. See [before](font-coexistence-before.json) and [after](font-coexistence-after.json). A replacement that finishes after another registration also removes the latest registered FontFace, preventing stale duplicate browser faces. Three durable tests cover regular/bold preservation and both asynchronous completion orders. The atlas capture tool now verifies the actual imported session face instead of the retired body-metric hooks.

## Checks

| Check | Result |
|---|---|
| Native full suite: `cargo test --profile release-test --features native-skia --no-fail-fast` | 5,136 passed, 5 inherited failures, 66 ignored across 415 result groups |
| Studio unit suite: `node scripts/run-tests.mjs unit` | 2,461 passed, 0 failed, 1 skipped |
| Updated atlas capture tool | One equation page, 4/4 imported faces; [receipt](atlas-smoke-receipt.json); syntax check passed |
| Final focused desktop/local font tests | 9 / 9 and 17 / 17 passed |
| No-import production smoke | Six random documents / nine pages, zero imports or page errors; [receipt](studio-no-font-receipt.json) |
| Studio `npx tsc --noEmit` | Passed, including final policy and race follow-ups |
| `wasm-pack build --target web` | Passed for final policy |
| Agent hub `npm test` | 1,050 passed |
| Live agent editing parity | 54 staged tools matched live preview through reject, approve and undo |
| `cargo fmt --check`, `git diff --check` | Passed |

The native suite and live editing check ran on the combined engine. Later changes affect browser font policy/registration; native rendering and editing operations tested there did not change. The full Studio suite includes the first race fix; the reversed-completion fix has focused tests and a fresh TypeScript check. Sequential font imports in the parity capture do not exercise that concurrent completion order; the final policy removes bridge hooks and is covered by a rebuilt WASM package, TypeScript checks and live production captures. [Test receipts](test-receipts.json) record the log hashes and inherited failures.

The same five native failures are documented in #374: the HCI Poppy fallback expectation, endnote equation cursor rewind, between-note equation gap, and two float-table host-title placement assertions. Their assertions were not relaxed.

## Visual evidence

Each sheet places raw-face / selected policy / Hancom side by side. The two representative sheets use the production output directly; all-page diagnostic sheets are backed by the pixel-exact production comparison.

- [Public-health table page 2](production-random-04-p2-comparison.png): representative improvement.
- [HWPX page 1](production-hwpx-h-01-p1-comparison.png): representative tradeoff.
- All-page review: [1](studio-ab-contact-01.png), [2](studio-ab-contact-02.png), [3](studio-ab-contact-03.png), [4](studio-ab-contact-04.png), [5](studio-ab-contact-05.png), [6](studio-ab-contact-06.png).

## Reproduction and rollout

The local run bundle is `/tmp/rhwp-parity-integration`; #374's original bundle is `/tmp/rhwp-parity-374`. It holds full-resolution PNGs, PDFs, capture scripts, manifests, compiled native binaries and raw logs. The committed JSON receipts and contact sheets preserve the reviewable results after worktree cleanup.

To repeat, use the recorded document/font hashes and selection seed; export the six sample PDFs with Hancom; build native Skia and WASM at the recorded revisions; load identical font sets; restart Studio after every source change; open one document per fresh browser context; render all pages at 200 dpi; compare against PDF rasterization with tolerance 4. The corpus's generated font faces require the local #374 conversion outputs. No font binaries are distributed by this PR.

No migration is required. Font-dependent rendering outside this corpus can differ. If needed, revert the browser-policy commit independently of the imported-face race repair.
