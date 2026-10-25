# Version merge live evidence

Headless real Studio at `http://127.0.0.1:7721/?engine=heemang` with a fixture-backed local hub and no provider calls. The production branch UI creates, switches and checkpoints branches. The resolver closes/resumes its draft, applies a conflicted HWP choice and compatible HWPX edits, and composite Undo/Redo restores both document contents and branch references. Both saved files reopen with the expected edited text. There were no page errors or old-engine requests. The harness stops both servers.

`summary.json` records actual branch heads and assertions. Review/reopen screenshots and the written HWP/HWPX outputs accompany it. Reproduce with `e2e/heemang-verify/version-merge.mjs` using a locally rebuilt hm-wasm package in the lane's temporary vendor directory.

The final rerun used engine `208dbfb` and Studio feature commit `df0f8020`. `summary.json` includes the SHA-256 of the actual hm-wasm binary served to the browser.
