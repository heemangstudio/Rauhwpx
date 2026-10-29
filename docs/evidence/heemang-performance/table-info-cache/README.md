# Table information reuse

The failed seven-run research typing gate is preserved under `/private/tmp/heemang-perf-resume/report-seven-frozen/`. The following changes have no repeated-latency qualification yet.

The paired CPU profile found repeated native table geometry reads inside sliced version snapshots during typing. Each table summary reads its signature, dimensions, cell metadata and bounding boxes through the same table query. Internal consumers derive new projections and do not mutate the table result.

Root executed the frozen `table-snapshot-control.mjs` at Studio `fbf7ec31`, using the real research document and normal sliced snapshot builder. Every capture uses a fresh builder and clears the runtime probe, with symmetric warmup and four measured pairs in alternating order. Complete snapshot JSON is identical in all ten captures, and content/layout/font/dirty/Undo/Redo state is unchanged. Native table queries fall from 152 to 108 with 44 hits per capture. Median measured elapsed time falls from 101.25 to 86.25 ms. This is a causal snapshot diagnostic, not the cold/typing acceptance gate. Raw output is [snapshot-control.json](snapshot-control.json).

Production reuse is in `HmCore.tableInfo()`, bounded to 64 entries. Its tag includes document instance, content epoch, layout epoch and font generation. Its key includes the full nested list path and optional page filter. Mutations and replacements release entries immediately. `query()` still performs a fresh native read. Table, agent and clipboard readers use the typed method.

The new real-WASM test first failed with five native geometry reads where one was expected. The fixed focused suite passes 19 tests. Coverage includes body/cell/structural edits, exact Undo/Redo table information, save/reopen, nested paths, page filters, layout changes, font-only outline refill, replacement with equal numeric epochs, closed-document rejection and mutation of public projections. TypeScript passes.

```sh
cd rhwp/rhwp-studio
node --test tests/heemang-table-info.test.ts tests/heemang-objects.test.ts tests/heemang-agent-tools.test.ts tests/heemang-template-clipboard.test.ts tests/heemang-version-merge.test.ts
npx tsc --noEmit
```

The real headless editor at `http://127.0.0.1:7733/?engine=heemang` opens the 92-page research HWP. Its hub uses the offline Pi fixture. Actual browser input inserts a marker, keyboard Undo/Redo restores exact complete version snapshots, the real version controller adds one checkpoint, and the File menu writes an HWP through a fixture file handle. Reopening those written bytes preserves the entire edited snapshot. Cached and fresh-native snapshot JSON match at open/type/Undo/Redo/reopen, and stale-snapshot cancellation returns null at all five stages. Reopening changes document instance 1→2 at the same font generation 54. Page errors are zero. No latency is recorded. Raw output is [runtime.json](runtime.json); saved bytes remain at `/private/tmp/heemang-perf-resume/table-cache-live/saved.hwp`.

```sh
HV_OUT=/private/tmp/heemang-perf-resume/table-cache-live node rhwp/rhwp-studio/e2e/heemang-verify/table-cache-runtime.mjs
```

Both controls use lane-local engine `de9d79e` WASM SHA-256 `be2b5cb9d31bef505bdd22faa192791996560fce126a02baff08389c2a822b3d`. Generated vendor bytes are excluded from this change. Version scheduling, revision ownership and cancellation are unchanged. A new seven-run completed-result gate is still required.
