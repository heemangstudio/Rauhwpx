# Paragraph field-query guards

Typing and cursor-format updates queried every field in the document even when the current paragraph had no field control. The existing result filters already required fields to begin and end in that paragraph. The guard checks its already available paragraph metadata and returns the same empty result before the whole-document query.

Two quiet candidate-only CPU profiles replay the same 41 research-report IME/Latin strokes on the same HFT vendor. The control removes only the five guard lines. The source is restored after the control. All frames paint and both runs have zero page errors.

| Inclusive CPU over the sequence, ms | Guards on | Guards off |
| --- | ---: | ---: |
| Native `Doc::query` | 16.22 | 745.89 |
| `fieldAt` | 0.50 | 619.60 |
| `getHyperlinkContext` | 0.16 | 103.12 |
| Native relayout | 56.97 | 52.24 |
| Glyph `runPath` | 4.49 | 4.93 |

The control spends its extra CPU in `dialogs::scan`, allocation and JSON values. Profiled typing p50 is 10.4 ms with the guards and 28.1 ms without them. These are causal diagnostics, excluded from the strict seven-run latency gate.

The focused real-WASM field and transaction suites pass eight tests. They cover click-here activation/input, link insertion/update/removal with Unicode offsets, native save/reopen, and text/control Undo/Redo. The real Studio IME replay also completes without page errors. Runtime is `http://127.0.0.1:7733/?engine=heemang`, using a fixture Pi hub.

Both profiles use temporary WASM SHA-256 `be2b5cb9d31bef505bdd22faa192791996560fce126a02baff08389c2a822b3d`, with the separate HFT-retention, LineFacts and fused-IME trials. The manifests record exact source hashes. No vendor bytes are included here. Final combined cold first-visible and completed-result typing p50/p95 qualification remains pending.
