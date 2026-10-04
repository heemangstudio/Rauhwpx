# Hancom rendering and reflow evidence

This campaign compares 20 HWPX documents against PDFs exported by macOS Hancom Office. The saved-layout corpus has 303 reference pages. A second corpus removes each document's stored line segments so the engine must calculate line breaks, heights, and pagination itself. Its references were exported separately after Hancom recomposed those documents.

## What changed

The engine now records the source format and font-metric policy, resolves runtime TTF and HFT metrics, and uses measured Hancom rules for glyph advances, line geometry, cell width, paragraph heads, and overflow compression. Editing and loading share the corrected reflow paths. Equation layout and glyph outlines, shape painting, image sampling, and Studio's CanvasKit replay have matching native and browser implementations.

Studio registers imported font metrics and HFT outlines before refreshing document layout. Late font imports also trigger layout or painting again. The new `lineseg-oracle` CLI compares engine reflow with the exact line geometry stored by Hancom, with separate load, edit, and supplied-width measurements.

## How to read the measurements

Saved-layout parity uses the worst of ten horizontal bands on any page, rendered at 200 DPI with a four-pixel position tolerance. The denominator is the union of ink in the engine and reference images, so a few edge pixels can produce a high percentage in a sparse band. Page count, mismatch pixels, and visual review accompany the percentage. The target is below 1% worst band after actual defects have been resolved.

Own-layout flow compares extracted text and positions. It averages same-page percentage, matching-break percentage, and a vertical-error term. OCR is used for references that do not expose usable text. Flow values should be compared within the same document and reference set.

The clean-main own-layout baseline excludes the mock exam from its aggregate because it crashes on an empty line array. The earlier campaign checkpoint provides a complete 20-document comparison.

## Analysis used

The external `/Users/pyu/hwp-analysis` notes identify layout units, font routines, draw operations, and the distinction between runtime structures and disk records. Disk LINESEG stores nine 32-bit fields; a runtime 24-byte object is a different representation. These distinctions helped constrain the implementation and prevented incorrect unit and flag mappings.

Hancom probe PDFs establish behavior before a rule changes. The SQUEEZE probe family checks both fonts, narrow widths, hard breaks, empty lines, and trailing breaks. The equation PILE probes establish the spacing of empty rows. The default-tab field identity remains unverified, so this campaign leaves the default width unchanged.

The 85% baseline rule also explains the missing-line text-box alignment error. A 36-case Hancom control checks vertical alignment at 9, 10, and 12 points while preserving saved anchors and object-bearing paths. The textbook footer baseline moves from 796.73 to 792.23 points, against Hancom's 792.24 points.

The HFT format analysis supplies the Hanyang rolling cipher, linked record layout, and outline commands. The implementation exposes verified ASCII and KS Hangul/Hanja banks. An independent decoder matches all 24,992 decoded outlines checked, excluding 12 preserved hyphen overrides. Installed-font coverage grows from 72,985 to 97,981 mapped glyphs, while the geometry of all 359 non-Hanyang files remains unchanged. Font bytes stay outside the repository.

The drawing analysis also supplies the thick/thin note separator formula. At a nominal device width of 17 pixels, the strokes are 9 and 4 pixels. Hancom exports confirm the formula at several widths and with the order reversed. PDF Form transforms must be applied when comparing stroke widths; raw inspection values can differ from the painted width.

The separator correction covers HWP5-origin HWPX and authored double separators in normal HWPX. Six fresh normal-HWPX controls confirm exact stroke positions and widths, with solid and triple styles unchanged. In the mock exam, the green separator band falls from 446 to 53 mismatched pixels. [Analysis findings](analysis-findings.json) records the source hashes, backend scope, independent checks, and unsupported font banks.

The font analysis establishes per-face EM units and the macOS CoreText measurement path. Fresh Hancom controls determine how document font ratios interact with the engine's glyph and space grid. Preserving the authored ratio through measurement fixes Hcar wrapping; 504 TTF controls cover proportional and monospace faces, fractional sizes, spacing, and font-space settings. Footnote layout also reserves the actual assigned marker width before composing a line, including the transition from 9 to 10. An 84-group body and note control checks numbering and spacing together.

## Results

The final native checkpoint is `codex-final-pr`, with binary SHA256 `c0e63727770194b3c2ecdbf93edf55601c59798686666dfd3c145209ac2d47ce`. All 542 Rust source files and 418 Studio source files match the frozen build manifest. The comparison uses the maximum of all ten bands across every page, rather than page averages or a selection of bands.

| Final native check | Result |
| --- | --- |
| Saved layout | 20 documents, 303/303 pages; 19 documents below 1% worst band |
| Recomputed layout | 20 documents, 305/305 pages; 14 documents below 1% worst band |
| Recomputed flow | 94.84 mean score; 98.77% correct-page lines, 96.40% matching breaks, 93.95% exact text/positions |
| Installed-font load oracle | 20 documents, 19,810 paragraphs, 23,150 lines; no failures or exclusions; 97.2% exact paragraphs, 98.5% matching breaks, 96.1% aligned lines |
| Native library tests | 3,982 passed, 0 failed, 8 ignored |
| Complete native suite | 5,557 passed, 0 failed, 68 ignored; all 414 integration targets, library, binaries and doctests across 29 batches |
| Final Studio saved layout | 20 documents, 303/303 pages; 19 documents below 1%; zero browser errors/unsupported operations |
| Final Studio recomputed layout | 20 documents, 305/305 pages; 14 documents below 1%; zero browser errors/unsupported operations |
| Final Studio editing | Actual input, undo, redo, save and reopen pass, preserving two pages |
| Production build and formatting | Passed |

Final saved Studio uses the same frozen source. It removes 235 mismatch pixels across three improved bands against the earlier caption/spacing/late-font capture, with no worse band. Mock improves from 1.63% to 0.77% document worst-band error; Readmission artwork remains 38.47%. Earlier Studio unit tests pass 2,654 with zero failures and one skip, and all 418 Studio source hashes are unchanged. Recomputed Studio also matches every page count and reaches the target for 14 documents. Actual input changes 474 characters to 480, undo restores 474, redo restores 480, and saving/reopening the 12,558-byte HWPX preserves 480 characters and two pages.

Final recomputed Studio removes 997,733 mismatch pixels across 92 improved bands against the earlier caption/spacing/late-font capture. Two low-error Mock bands add 12 edge pixels in total, separately from the four native bands discussed below. Mock reaches 1.13% and Textbook 0.02% document worst-band error in Studio.

The final ASCII-bracket, strict integer-fit and endnote-cursor batch removes 40,013 mismatch pixels across 13 improved bands against the preceding equation/page-start checkpoint. All 303 saved PNGs and 297 recomputed PNGs are byte identical; only eight recomputed pages change. Four low-error Mock bands add 30 edge pixels in total, with final errors between 0.07% and 0.20%. The measured secondary baseline step is 0.12 points. The cumulative subscript drift found during review was removed before this batch was accepted.

ASCII-bracket handling clears Textbook page 19, and strict integer fitting clears page 17. Textbook's final document maximum is 0.06%. Strict fitting also clears the affected Korean exam page 11 and 15 bands; the Korean exam still has a 10.42% document maximum on page 3. The endnote cursor correction reduces Mock's document maximum to 1.16%. Aift's first-paragraph page-start correction clears page 51, while the document maximum remains 19.07% on page 69. HY source pi selection and composite-product spacing reduce Mock page 21 band 8 from 0.82% to 0.15% in both native lanes.

The 1% target remains unmet for Readmission artwork, Korean exam, Social exam, Mel, Mock, and Aift in recomputed layout. The Kor23 floating-table/TAC picture candidate is held and excluded because its final control and corpus gates were incomplete. Full parity is not claimed. The separately reviewed Readmission artwork is the saved-layout exception.

The complete local suite passes, and the [test provenance](final-test-provenance.json) records every native batch command and log hash. GitHub production dependency audits fail on macOS, Windows and Linux for the main-inherited `http-cache-semantics` advisory [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp). Agent dependency manifests match main exactly. The new 4.3.0 package retains the reported behavior, and [the upstream dispute](https://github.com/github/advisory-database/issues/10139) remains open. The audit remains enforced. Session checks on macOS and Windows, hostile input, and auth/resource boundaries pass; browser and dependency-container checks are still running.

The final load oracle hashes 187 installed TTF files, 387 HFT files and 16 font metadata files, 590 inputs in total. Font bytes remain outside the repository. The [per-document matrix](final-results-table.md), [final metrics and hashes](final-metrics.json), and [analysis findings](analysis-findings.json) identify measurements and their scope.

The five final proofs below use actual native PNGs from the frozen checkpoint. Each shows Hancom, native before the corresponding correction, and final native. The original three evidence images remain available as earlier campaign examples.

- [ASCII-bracket wrapping, Textbook page 19](04-final-ascii-bracket-p19.png)
- [Strict integer fit, Textbook page 17](05-final-strict-fit-p17.png)
- [Endnote cursor spacing, Mock page 19](06-final-endnote-cursor-p19.png)
- [HY pi and composite product, Mock page 21](07-final-equation-p21.png)
- [First-paragraph page spacing, Aift page 51](08-final-aift-page-start-p51.png)
