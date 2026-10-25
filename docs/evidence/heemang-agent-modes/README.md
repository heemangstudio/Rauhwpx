# Agent mode integration verification

Headless Chrome at `http://127.0.0.1:7723/?engine=heemang`, 2026-10-25. Studio `4115f41e` used the combined engine `744b178` package, 6,316,394 WASM bytes, SHA256 `5f1d1f7df5ed40a5b17598c9df76dec2f939ca86f025857815baf8c0e0ab6a8d`. Pi was a controlled provider fixture; Studio, authenticated hub/MCP, document engine, UI approvals and IndexedDB version storage were real. The original vendor files were restored and all test servers stopped.

The same scenario passed on `rhwp/samples/footnote-01.hwp` and `rhwp/tests/fixtures/editing_parity/mac-hancom-12.30.0/body-mixed-text/edited.hwpx`:

- Chat rejected writes without changing content or revision. Plan rejected writes during planning and while awaiting approval; the real approval button enabled a safe implementation turn.
- Agent showed edits in the live document, restored a rejected preview, and accepted two edits as one undo/redo step. A write using the revision before an overlapping edit returned `REVISION_MISMATCH` and inserted no text.
- Full applied two writes immediately, with one undo/redo step per write. `commit_version` created a named checkpoint in the real version store and cleared its dirty state.
- Both inputs were exported through the registered `WasmBridge.exportHwp/exportHwpx` APIs and reopened in Studio. All four outputs retained approved markers and omitted rejected, stale, Chat and unapproved Plan markers. No page errors or legacy-engine requests occurred.

`summary.json` records both runs and saved byte counts. The screenshots show Plan approval, an active Agent preview and the final Full document. Reproduce after installing the intended combined package:

```sh
HV_CANDIDATE_VITE_PORT=7723 node rhwp/rhwp-studio/e2e/heemang-verify/agent-modes.mjs
```

The registered image-data API also matches the baseline contract. `objects-editing.ts` registers `getControlImageData/getControlImageMime`, both querying native `pictureData` with the body or cell path. Real Studio returned the exact 68-byte PNG and `image/png` for body and cell pictures before and after both-format reopen (`image-data.json`). The baseline WASM read those same inserted bytes from both saved outputs (`old-picture-data.json`); it also retained the fixture's existing 1,011-byte picture. The body target was paragraph 0/control 3; the cell target was paragraph 0/table control 2/cell 0/paragraph 0/control 0.

For the real OLE equation fixture, body paragraph 4/control 0 and the nested target at paragraph 2/table control 0/cell 3/paragraph 1/control 0 rejected both data and MIME calls in both engines. Baseline errors explicitly require a Picture control (`old-ole-data.json`); native errors report that the object is not a picture. Compare callers catch this rejection, and clipboard image extraction shares the same Picture contract. No OLE image-data feature change was warranted. Later structural-merge and font-performance changes are outside this package's verification.
