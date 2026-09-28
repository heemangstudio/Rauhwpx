# School-report HWPX parity

Reference: a seven-page PDF exported by Hancom Office for macOS from the supplied report. The private source document, full-page captures, and proprietary fonts are not included.

The native comparison uses 200 dpi renders and the Hancom parity harness. Its mismatch percentage measures differing pixels after the harness tolerances.

| Page | Final native mismatch |
| --- | ---: |
| 1 | 0.00% |
| 2 | 7.02% |
| 3 | 0.00% |
| 4 | 5.38% |
| 5 | 0.02% |
| 6 | 0.02% |
| 7 | 0.00% |

The original renderer produced five pages instead of seven, with an 81.68% worst-page mismatch. The updated renderer produces seven pages. All 70 comparison bands were reviewed.

![Floating title before, after, and in Hancom](title-placement.png)

## Remaining differences

Full visual parity is not verified. Equation appearance still differs, and the following table row begins approximately 2.41 pt too low on page 2 and 4.76 pt too low on page 4. Greek μ font selection and associated spaces also differ. There is a small Canvas2D spacing difference on one pledge line and minor border/raster rounding.

A controlled empty-paragraph/font-slot experiment could not be completed because Hancom became unresponsive. The implementation does not include an unverified document-specific adjustment for those residuals.

## Browser verification

Studio uses the production font-import event so imported metrics reach WASM. The reference font set includes ten fonts, including HYhwpEQ for equations. Studio renders seven pages with no browser errors. Its per-page mismatch is 0.00%, 7.13%, 0.00%, 5.51%, 0.02%, 0.06%, and 2.17%. Tests also cover fonts imported after opening and a fresh context without direct font imports. The desktop font loader supplies fonts in that last case.

## Regression checks

Compatibility metadata scopes generated line metrics and consecutive large-table flow to MS Word HWPX. Existing HWP-generated layout and editing cases are checked separately. Header coordinates were updated only after comparison with the existing official PDF; the expected number position is within 0.08 px of its mapped PDF origin. One SVG golden changed only in numerical serialization below 1.14e-13 px. The table-text SVG remains byte-identical to its original golden.

The complete Rust run recorded 5,172 passes, six failures, and 66 ignored tests. Five failures reproduced on the base commit. The remaining failure used an intermediate table-text golden; restoring its original, byte-identical golden made all three active SVG tests pass. No introduced failure remains after that targeted rerun. Studio unit tests recorded 2,495 passes and one skip, and TypeScript and Rust formatting checks passed.
