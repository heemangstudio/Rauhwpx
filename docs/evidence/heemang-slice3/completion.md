# Slice 3 completion

Studio runtime: `http://127.0.0.1:7700/?engine=heemang`. Engine main: `2008f209e97a70bd586644b8b8596ca32ef5274f`. All four generated vendor files exactly match the isolated git-archive build. The source checkout was read-only. During verification main advanced from `4627d0a` to `2008f20`; the final bundle was rebuilt from the latter and unit/type, Enter, whole-table formatting, persistence and performance checks were rerun. Original fixture hashes were unchanged.

Adopted page-local receipt invalidation, native directed selection/history dirty identity, and `markSaved(expectedEpoch)`. Removed the adapter undo/redo/content identity stacks and saved-byte substitution. Two native selection omissions still require a historyId-keyed fallback for format redo and rich paste undo. Cell blocks support drag, delete, character/paragraph formatting and TSV/HTML copy. Whole-table formatting includes cell lists in one undo action. Copy tokens permit plain TSV paste when native copy cleared the rich fragment.

| Document | Pages | Lines | Maximum geometry drift |
| --- | --- | --- | --- |
| exam_math.hwp | 20 | 568 | 0 HU |
| lang_exam.hwp | 15 | 1284 | 0 HU |
| nikl_plan.hwp | 35 | 2159 | 0 HU |
| fdi_q1.hwpx | 10 | 1605 | 0 HU |

All 5,616 lines and caret stops on all 80 pages match after formatting through real body/cell dialogs, same-format File > Save and reopening written bytes. Text, sampled styles and normalized paint also match. Cancellation and filesystem write failure preserve state. Raw geometry, packet snapshots, hashes and screenshots are linked from `output/heemang-editing/slice3/report.md`.

- 100 Enters at end of fdi_q1 section 1: pages 9 -> 13, paragraphs 18 -> 118, caret page 9 -> 13. Caret visible at every ten-Enter checkpoint.
- 100 Enters inside table cell: pages 9 -> 14, paragraphs 1 -> 101, caret page 1 -> 5. Caret visible at every ten-Enter checkpoint.

Handbook final sample: first paint 1557.1 ms; open complete 1808.5 ms; settled WASM 116.06 MiB; post-GC JS heap 52.47 MiB; trusted-key typing p50/p95 24.7/34.3 ms over 36 keys. Dev server, Chrome 155, 1440px viewport, DPR 1. Previous typing used synthetic events, so it is not directly comparable. Handbook is now 384 pages versus 385 previously; pagination parity remains unverified.

Validation: Studio unit tests 2,931 passed, zero failures, two existing TODO cases; native adapter 34 passed; focused reader/helper Chrome suite passed; TypeScript and `git diff --check` passed. The reader Chrome regression tests have fixture-backed native/service boundaries. The separate live checks use production Studio and real WASM. Clipboard live checks use DOM ClipboardEvent/DataTransfer transport, with browser keyboard input for undo.

Remaining engine requests: consistent history selection metadata and published cell-selection types; richer font/strike/spacing and insertion formatting; style/context/list APIs; structural table edits/query; rich clipboard replacement/table fragments/HTML import and special-control preservation; complete native transaction rollback. See `output/heemang-editing/engine-requests.md`.

Screenshots:

- [100 body Enters](body-after-100.png) and [100 cell Enters](cell-after-100.png).
- [Cell selection](reader-cell-selection.png), [cell deletion](reader-cell-delete.png), and [TSV paste](cell-copy-paste.png).
- [Whole-table selection before formatting](whole-table-selected.png) and [after 17pt formatting](whole-table-formatted.png).

Reproduce with `verify-enter.mjs`, `verify-table-format.mjs`, and `verify-live.mjs --gates-only` / `--performance-only` in `output/heemang-editing/slice3/`. These scripts use the existing Studio server at port 7700 and Chrome harness, make their own fixture copies, and save output only under slice3.
