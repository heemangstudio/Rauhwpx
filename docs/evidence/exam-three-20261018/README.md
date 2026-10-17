Original parity and font retention **pass** for the recorded fonts. Bounded fallback smoke passes with the pre-existing limitation below. Native v36 and current browser v37 normal/late captures pass **all 32 original pages / all 320 fixed bands**.

| Exam | Pages | Native baseline worst | Native v36 worst | Browser normal | Browser late |
|---|---:|---:|---:|---:|---:|
| Science | 4 | 100% | 0.749057% | 0.749941% | 0.749941% |
| English | 8 | 45.448419% | 0.494361% | 0.495116% | 0.556857% |
| Math | 20 | 40.013813% | 0.799065% | 0.799065% | 0.799065% |

[Evidence](evidence.json) pins source/reference/scorer/cuts, native binary, unchanged v36 WASM and current TS source. The [320-row matrix](original-band-matrix.json) retains baseline/native/normal/late integers. Original cuts, 200dpi, ink threshold 200 and 4px tolerance are unchanged; acceptance uses `100 × mismatch pixels < union ink` with the existing blank-band policy.

[Normal lifecycle](reviews/browser-v37-normal.json): 96 ready/error-free original/edit/reopen captures retain prepared fonts 22/12/15. All 32 original PNGs match visually accepted v36 output, binding the [Science/English](reviews/browser-science-english.json) and [Math](reviews/browser-math.json) reviews. [Actual public paste and toolbar Undo](reviews/public-edit-undo.json) retain 15 fonts, 20 pages and readiness through length 0→1→0.

[Late lifecycle](reviews/late-lifecycle.json): 96 ready/error-free captures retain fonts 22/15/15 and the same document instance/generation/digest/pagecount through the production import event. **29/32 originals match normal pixels**; English p1/p4/p6 use additional physical TNR B/I/BI faces. All 32 late originals match the previously quantified late cohort and all 320 current bands pass. The historical strict cross-cohort pixel-identity script remains **failed and explained**, not relabelled passed; [cohort receipt](reviews/late-font-cohorts.json).

[Bounded fallback](reviews/fallback-current.json): 96 no-explicit-import captures retain fonts 22/14/15 and pass readiness/count/edit-persistence checks. Normal, late and fallback edited→reopened output is exact on **30/32 pages**. Two pre-existing Math notice lines (p12#45/p16#27) differ in advances; content/frames remain complete with no clipping. Automatic fonts remain available; fallback is not a fontless or <1% parity claim.

[Native](reviews/native.json) and [17-document/161-page cross-corpus](reviews/cross-corpus.json) review continuity is byte-exact. Native checks: 4220 library + 7 additional + 1693 integration + 4 doc passes. Current Studio: 2703 pass / 2 existing TODOs; typecheck passes. Old-code red 2 / corrected focused 19 checks protect font and resource lifetime. Remote CI is separate from these local receipts.

Native baseline/current/Hancom crops: [Science](science-before-after.png), [English](english-before-after.png), [Math](math-before-after.png); [metadata](images.json). After panels match native v36. Fine typography/delimiter contours and the English p7 arrow residual remain. [Outline proof](diagnostics/math-equation-outline-boundary.json) and [resolved font-loss history](reviews/fallback-v36-history.json) preserve causal evidence. Documents, PDFs, fonts, binaries and full UI images are excluded; external receipts use portable labels/hashes. Intentional edits use lifecycle checks rather than unchanged-original parity scores.
