# Font performance evidence

Lane commits: engine `ebf68e8` (`fix/studio-export-packaging`, after `de13d62` HWPX export packaging); Studio `7897b04a` catalog index, `6fa32882` sparse transfer and preparation, `4fcceaeb` shared startup catalog readiness. Measured in a headless real Studio on port 7722 against the old-engine baseline app, with a lane-local hm-wasm build.

## Cause and fix

Cold font preparation read duplicate SFNT variants and whole large CJK files, prepared browser font-list faces before the native canvas and input, carried outlines for metric-only fonts and raced initial catalog readiness. The lane reads only preferred catalog slots (every HFT bank is kept), transfers sparse original-ID TrueType subsets with explicit HMGC glyph coverage, refills retained and pending glyphs, preflights the actual page's glyphs before first paint, defers metric-only outlines and shares catalog readiness with the first document. CFF, HFT and variable fonts keep the full original path, as does remote or incomplete catalog preparation.

## Results

Cold open completion, median of three fresh runs (`final-catalog-{1,2,3}.log`), milliseconds:

| Document | Baseline | Candidate |
|---|---:|---:|
| mixed Korean/Latin HWPX | 670 | 586 |
| table borders HWPX | 131 | 144 |
| press release HWP | 894 | 608 |
| footnote HWP | 272 | 281 |
| research report HWP | 1305 | 914 |

Table and footnote remain slightly slower; this is not universal speed parity.

- First visible frame (`final-catalog-visible.log`, single run): mixed 521/467 ms baseline/candidate, footnote 163/210 ms. Candidate accepts click-to-type before completion.
- First native page SVG equals the SVG after font settle and network idle for all five documents (`firstpaint-accuracy.json`).
- Native footnote font transfer fell from about 117 MB to 4.8 MB; browser font-list reads happen after the canvas is visible and input-ready (`firstpaint-subset-reads.json`).
- Version panel shows `15 KB / 10.00 GB` on both engines. Stored bytes: baseline 13,595 blob + 1,883 snapshot, candidate 12,907 + 2,003. No display masking or padding (`*-final-versions.json`, `.png`).
- Five-document functional flow: all 45 visible character paints, saved reopen, no old-engine requests, unsupported toasts or page errors (`final-functional.log`). The press-release select+bold failure occurs on both engines. Its one flagged row is a single-run table timing.
- HWP3 live flow: edit, Save, both Save As formats, canceled save, disk failure and reopen (`final-hwp3-live.log`).

## Checks

Native hm-fonts + hm-wasm 56/56 (`final-native-tests.log`), Studio font tests 30/30 plus typecheck (`final-studio-font-tests.log`), desktop/hub font services 24/24 (`final-font-service-tests.log`). Sparse tests cover omitted Latin, unseen Korean and non-BMP, composite components, retained IDs, malformed coverage, Undo/Redo and HWP/HWPX reopen. The non-BMP case is a synthetic cmap alias to a portable outline, not color-emoji support.

These are lane results before integration; the combined build is verified separately in `docs/heemang-cutover.md`.
