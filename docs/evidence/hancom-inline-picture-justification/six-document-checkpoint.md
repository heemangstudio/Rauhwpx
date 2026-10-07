# Six-document checkpoint

Engine fix `9ab405e7` corrects `cell-mixed-text`. The other five initial documents already pass on the base. This checkpoint counts one newly fixed document toward the twenty-document campaign.

| Document | Native worst band | Studio worst band | Pages |
| --- | --- | --- | --- |
| cell-paragraph-spacing | 0.00% | 0.00% | 1/1 |
| body-mixed-text | 0.00% | 0.00% | 1/1 |
| cell-mixed-text | 10.40% → 0.00% | 0.00% | 1/1 |
| body-paragraph-spacing | 0.00% | 0.00% | 1/1 |
| cell-fit-width | 0.00% | 0.00% | 1/1 |
| cell-empty | 0.00% | 0.00% | 1/1 |

Native and Studio scoring use 200 dpi and channel tolerance 4. Review covered whole pages and enlarged regions. Studio captures with the fixture's HCR Batang font and empty font imports are byte-identical. Each document's imported and freshly edited session survives three save/reopen cycles with matching local layout; fresh-session bytes have no independent Hancom edit reference.

WASM compilation and TypeScript checking pass. Studio tests pass with 2,625 passed and one skipped after restoring declared agent dependencies from an identical-lock APFS clone. The full native Rust suite reports 5,291 passed, 68 ignored and one outdated justification assertion. That assertion passes after the exact Hancom-reference-backed test correction, with both base behavior and corrected behavior checked in isolated worktrees. The next engine change requires cumulative regression verification.

The run retains source/PDF SHA-256 provenance, frozen binaries, before/fixed comparisons and static source packages. Per-document cleanup retains compact evidence and score JSON while clearing redundant rasters, temporary diagnostic sources and completed worktrees. Resource snapshots record available memory and disk; they do not measure peak memory.
