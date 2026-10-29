# Template imports preserve the clipboard

The baseline preserves copied `A` across importing a `TEMPLATE` block: the next paste produces `ATEMPLATEA`. The candidate originally produced `ATEMPLATETEMPLATE` while its clipboard metadata still reported `A`. `oracle.json` records those actual package results and the fixed result. No old engine implementation was read or copied.

The native programmatic import now builds a local fragment and uses the existing atomic paste/import path. Shared clipboard state is untouched. Native tests cover invalid source/target ranges, closed sources, an initially empty clipboard, exact copied formatting and one undo/redo step. The real-WASM `heemang-template-clipboard.test.ts` exercises `template_insert_block` through source/target inspection, pending review, approval, history undo/redo, another paste and both file formats.

The live baseline and candidate check runs the editor's Copy command, imports through the block bridge, rejects an invalid import, sends a paste event through the actual input handler, and checks `ATEMPLATEA`. Both UI Save As HWP and Save As HWPX reopen with that content. The runtime is `http://127.0.0.1:7724/?engine=heemang`, headless Chrome, 2026-10-25, with a fixture-backed provider. No page errors were reported; both servers stopped. Screenshots show the reopened saved output.

Reproduce with `node rhwp/rhwp-studio/e2e/heemang-verify/template-clipboard.mjs`. The tool test uses the existing blank document fixtures. `summary.json` records the live results.
