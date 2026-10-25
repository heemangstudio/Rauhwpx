# Conditional feature verification

Real Studio at `http://127.0.0.1:7724/?engine=heemang`, headless Chrome, 2026-10-25. The hub uses a local provider fixture. Both documents are repository samples, and all document operations use the native engine.

`conditional-features.mjs` exercises the character-border dialog and cancellation, HTML merged-cell table and embedded image paste, cell color/border/padding, an inactive even-page header filename template, total-page insertion, the save command and reopening the saved output. Both samples retained the pasted table and fields. The run reports no page errors, unsupported-feature warnings or cursor errors.

- `biz_plan.hwp`: 28,672 bytes saved.
- `표-텍스트.hwpx`: 20,182 bytes saved.

Screenshots show the inactive header being edited. The scenario is reproducible with `node rhwp/rhwp-studio/e2e/heemang-verify/conditional-features.mjs`. `summary.json` records the runtime results.
