# One transaction for IME replacement

An IME update replacing one preedit with another deleted and inserted in separate native transactions, laying out between them. The body/cell logical-replacement path now sends both operations in one existing native transaction. It preserves the original removed text and caret conversion, and uses ordinary document redraw. No page-local shortcut or native API is added.

The real-WASM test compares the replacement against split operations at every logical offset around a zero-width bookmark, click-here field and surrogate pair, including removed content and caret position. Native Undo restores text and controls atomically and Redo restores the replacement. The focused field/transaction suite passes eight tests.

The live runner reuses production IME smoke checks for commit/click/Undo/Redo. It then composes `ㄸ → 따 → 땅`, sends Escape and verifies empty original text, the original anchor and no application Undo/Redo step. Fresh insertion `다`, Undo and Redo pass. `live-history.json` records the real Studio at port 7733 with fixture Pi hub and zero page errors. The runner uses the separate browser cleanup helper from signed commit `2d7f1bd6`.

A quiet split-only source control retains the same vendor, guards and Player cache. Inclusive CPU over 41 strokes:

| Work, ms | Fused | Split |
| --- | ---: | ---: |
| Native relayout | 56.97 | 72.80 |
| LineFacts reset | 10.64 | 16.58 |
| `replaceBodyTextLocal` | 72.50 | 81.86 |

Profiled p50/p95 is fused 10.40/26.33 ms and split 11.55/21.17 ms. These singles support the CPU reduction, and do not establish a latency improvement. Strict seven-run completed-result p50/p95 qualification remains pending. The split source and control remain available for final latency comparison if p95 stays slower.

The immutable split source is `a377d2c8:rhwp/rhwp-studio/src/core/hm/text.ts`. The manifests record exact variants and vendor SHA-256. Generated vendor bytes are excluded from the commit. Fusion uses existing atomic operations and has no runtime dependency on the HFT-retention or glyph-run cache changes.
