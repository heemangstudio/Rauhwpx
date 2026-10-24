# Slice 3 reader verification

Runtime: `http://127.0.0.1:7700/?engine=heemang`, real Studio, refreshed native
WASM, system fonts. Source: `rhwp/tests/fixtures/editing_parity/mac-hancom-12.30.0/cell-mixed-text/source.hwpx`.
The source file was opened through the file input. Pointer events used native
caret-derived page coordinates and the production reader DOM listeners. Copy
used a DOM ClipboardEvent/DataTransfer. Delete/Undo used browser keyboard input.
Character formatting used the production `format-char` EventBus command.

- Forward drag from cell 0 to cell 1 selected the first table row as tagged
  `{kind:'cells',table:{section:0,para:0,control:2},from:{row:0,column:0},to:{row:0,column:1}}`.
  Highlights covered both complete cells. Reverse drag produced the same block.
- Copy returned the original Korean/English first-cell text plus a tab and
  newline for the empty second cell. Its adapter copy call received tagged cells; the adapter passed normalized cell-list endpoints to native copy.
- Formatting to 1200 changed one native history step. A single-cell native text
  copy confirmed `font-size:12pt`. The block and its highlights remained selected
  for the next command. The cell-block native HTML copy is a plain HTML table;
  style preservation of that native copy is engine-owned.
- Keyboard Delete received tagged cells, cleared the selected first-row text,
  preserved the table, and added one history step. Undo restored the original
  first-cell text and tagged block selection. State epochs were 0, 1, 2, 3 for
  initial, formatting, deletion, and undo.
- Drag from the body caret after the table into first-cell offset 3 retained its
  directed text endpoints. Native normalization returned whole-table body span
  `{section:0,para:0,offset:16}` to `{section:0,para:1,offset:0}`. Delete removed
  the table control. Undo restored all four cell lists and the original body-to-
  cell direction and affinities. Epochs advanced to 4 and 5.
- Typing `Z` into a cell block showed the supported-operation error and left
  contentEpoch 5, layoutEpoch 7, undo 1, redo 1 and the first-cell text unchanged.
  Replacing a cell block with text remains outside this slice.
- Every successful mutation emitted exactly one `document-changed` event with
  its native receipt, including `changedPages:[0]`, for CanvasView repainting.

Screenshots: [selected cells](reader-cell-selection.png),
[deleted cell content](reader-cell-delete.png),
[rejected cell replacement](reader-cell-replacement-rejected.png).
Native requests, command ranges and receipts are in [the live log](reader-live-log.json).

Focused checks passed:

```sh
node --test rhwp/rhwp-studio/tests/heemang-selection.test.ts rhwp/rhwp-studio/tests/heemang-reader.browser.test.ts
rhwp/rhwp-studio/node_modules/.bin/tsc --noEmit -p rhwp/rhwp-studio/tsconfig.json
```

The browser regression suite uses the production reader with fixture-backed
native/service boundaries. It covers directed body/table affinity, forward and
reverse cell blocks, copy/format/delete, unsupported cross-section/object hits,
pending Cut invalidation, external rich clipboard rejection, and receipt events.
The live pass above exercises the real native adapter instead.

## Completion checks

The final adapter expands whole-table formatting into its queried cell lists in the same transaction. A fresh real Studio run on a copy of `fdi_q1.hwpx` used Shift+click from body text into its title table, then Format > Character shape > 17pt. Native text copy confirmed 17pt inside the cell; one undo restored the original 26pt and native dirty=false, and redo restored 17pt. See [before](whole-table-selected.png), [after](whole-table-formatted.png), and [native readings](whole-table-format-live.json). Full harness and raw output: `output/heemang-editing/slice3/verify-table-format.mjs` and `table-format/results.json`.

Cell Copy -> Paste at a body caret now inserts TSV as plain text when native Copy has cleared its rich fragment. A fresh real WASM/production-reader check used DOM ClipboardEvent/DataTransfer delivery and browser Meta+Z. It inserted the copied text in one undo step and undo restored the body. Replacement of a selected cell block still rejected without mutation. This check used the cell-mixed-text fixture through the file input; OS clipboard transport was not exercised. See [the log](cell-copy-paste-live.json) and [paste screenshot](cell-copy-paste.png).

Drag cancellation, blur, released buttons and document swaps terminate dragging. Fixture-backed browser coverage also checks own-copy tokens with and without a native rich fragment, stale/mismatched tokens, asynchronous Cut selection changes and external HTML rejection.

Final Studio unit suite: 2,931 passed, zero failures, two pre-existing TODO cases. `tsc --noEmit -p rhwp/rhwp-studio/tsconfig.json` passed. Focused native adapter tests: 34 passed. The reader/browser suite was run separately because it uses a real Chrome DOM with fixture-backed native/service boundaries.
