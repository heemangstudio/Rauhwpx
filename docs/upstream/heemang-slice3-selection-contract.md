# Slice 3 selection and history contract

Verified against the Studio bundle from HeemangEngine main `2008f209e97a70bd586644b8b8596ca32ef5274f`.

The reader calls `viewer.selectRange(request): Selected`, backed by native `Doc.selectRange`. `Selected` contains `{ range, rects }`. Text selections retain their original directed endpoints and affinities, including body/table selections that native normalizes to whole controls. Cell selections use `{ kind: "cells", table, from, to }`. Native `range.cells` supplies the addressed cell lists; Studio does not reconstruct merged-cell geometry. Failed normalization keeps the last valid reader selection.

`EditingSelection` is the text/cell union. The adapter normalizes before same-list edit helpers run. Delete clears selected cell contents, preserving their table. Formatting uses one native transaction for all selected spans and includes descendant table-cell lists for a whole-table selection. `EditResult.selection` preserves a tagged block after formatting. Cross-section selections, replacing cell blocks with text, and unsupported object operations remain guarded.

`TransactRequest.selection` records the original directed selection. Native undo/redo owns document history and dirty identity. Two omissions still need a narrow historyId-keyed fallback: format redo lacks its after-selection, and rich paste undo lacks its before-selection. Runtime accepts tagged cell metadata, while the generated selection declarations still describe text only. The remaining requests are recorded in `output/heemang-editing/engine-requests.md`.

Reader mutations emit one `document-changed` event carrying their receipt. CanvasView consumes `changedPages`; `null` invalidates all pages. Page-count changes rebuild virtual page offsets before the caret is revealed. The adapter retains packets for unchanged pages and updates their epochs.

Cell-block copy exports native TSV/HTML and clears the internal rich fragment. Reader copy tokens validate its own clipboard content independently of `hasInternalClipboard()`, so that content pastes as TSV at a text caret. External HTML remains guarded. Asynchronous Cut/Paste checks compare full selection kind, nested table address, endpoints, affinities, epoch, document instance and clipboard token where applicable.

Pointer cancellation, window blur, released buttons and document swaps terminate dragging. Find and select-all use text addresses from native normalization or the live caret.

Live evidence is in `docs/evidence/heemang-slice3/` and `output/heemang-editing/slice3/`. The engine checkout was inspected read-only.
