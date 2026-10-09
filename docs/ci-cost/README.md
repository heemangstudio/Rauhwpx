# CI cost and validation time project

Current direction (October 2): keep every workflow on Blacksmith and prioritize validation time. The user explicitly requested removal of nightly releases. The earlier standard-hosted proposal at c5939e1a is withdrawn and must not merge. Its 16m11s cold run versus the 6m51s warm Blacksmith baseline is retained as historical evidence, not a steady-state comparison or the current savings proposal.

## Current implementation

- Restore the exact original Blacksmith runner labels and expressions for every PR check. Platform architectures, resource sizes, timeouts, check names, selection, concurrency and permissions remain unchanged.
- Cache npm downloads keyed by every production lockfile. Actual installations, three-platform provider/Electron execution and all audits continue on every selected run. Add explicit audit-matrix architecture checks.
- Keep nightly Rust workspace/doc tests, RustSec enforcement, WASM sharing, application, browser, agent, authorization and sidebar checks on their original Blacksmith runners and daily 18:00UTC schedule.
- Remove nightly identity preparation, macOS/Windows installer builds, signing/notarization invocation and GitHub Release/tag publication. This cadence change is explicitly authorized by the user's request to remove nightly releases. Tagged-release signing, notarization, Linux installers and publication gates are unchanged.
- Accept both exact pinned cargo-audit0.22.2 CLI spellings when reusing its executable cache. Reject wrong/malformed versions, install the same locked source version on a miss and verify the version afterward. Audit commands and advisory exceptions are unchanged.
- Reject missing/invalid source SHAs in the run-level cost model, closing the independent review's minor robustness finding.

No UI/renderer, provider, billing, protection, signing implementation, secret or provisioning configuration is changed. PR431's renderer branch remains outside scope. Parent integration review is required before merging PR432; branch-protection settings remain inaccessible to the integration (HTTP403), and no access change was attempted.

## Evidence and measurement

`baseline-runs.json` retains exact run/job IDs, SHAs, labels, timestamps and step outcomes for the full PR430, narrower PR431, latest nightly and successful2.0.9 release. Reproduce gross compute models with `node scripts/ci-cost-model.mjs`. These are observed durations multiplied by list rates, excluding vendor credits/free tier, storage, transfer and vendor rounding. The rounded-minute column is a scenario, not verified vendor policy.

Current [Blacksmith pricing](https://www.blacksmith.sh/pricing), checked October2: 2-core Ubuntu x64$0.004/min, ARM$0.0025/min, Windows$0.008/min, 6-core macOS$0.08/min. Larger Linux/Windows prices are explicitly modeled proportionally to cores. This is consistent with the supplied historical4-core invoice line, not a vendor usage export.

| Representative run | Observed gross duration-equivalent model | Rounded-minute scenario |
| --- | ---: | ---: |
| [PR430 full checks36848222173](https://github.com/heemangstudio/Rauhwpx/actions/runs/36848222173) | $0.2190 | $0.3280 |
| [PR431 narrower36865996217](https://github.com/heemangstudio/Rauhwpx/actions/runs/36865996217) | $0.0648 | $0.0960 |
| [Nightly36932761506](https://github.com/heemangstudio/Rauhwpx/actions/runs/36932761506) | $0.9703 | $1.0120 |
| [Tagged release36643093004](https://github.com/heemangstudio/Rauhwpx/actions/runs/36643093004) | $1.5173 | $1.5800 |

Latest-nightly retained verification jobs model$0.2783; removed installer/identity/publication work models$0.6920 (71.3% of that run's gross compute). This is **authorized removal of release workload**, not75% savings for comparable unchanged CI coverage. Four other sampled nightlies already had no installer jobs because branch verification or failed verification prevented packaging. Across the latest30 historical runs,19 PRs model$2.4764,6 nightlies$3.7270,3 tagged releases$6.1686 and2 free Windows recovery runs$0, total$12.3720. Removing only the observed nightly release jobs models$1.4437/11.67% of that sample. Do not extrapolate this release-heavy sample as a monthly forecast.

Latest-nightly engine logs show a cargo-audit executable cache hit followed by a59.90s rebuild of the pinned version ([job110605841004](https://github.com/heemangstudio/Rauhwpx/actions/runs/36932761506/job/110605841004)). The previous guard accepted only `cargo-audit 0.22.2`; Cargo subcommand invocation can print `cargo-audit-audit 0.22.2`. The pinned [upstream CLI source](https://github.com/RustSec/rustsec/blob/cargo-audit/v0.22.2/cargo-audit/src/commands.rs) and [firsthand upstream version output](https://github.com/RustSec/rustsec/issues/1296) support handling the alternate prefix. The new guard is locally tested for both exact outputs, missing/old/malformed versions and failed installation. Actual per-run time savings for this guard require a normal subsequent nightly; no nightly/release dispatch is used merely to measure it. Upper opportunity is about60s/$0.016 per corresponding8-core run; no realized saving is claimed.

Invoice BLA-DFA1-202610-88951 remains organization-wide September24–30 evidence: $45.69 gross, $12 credit, $33.69 net. Largest reported lines macOS arm64 6-core223min/$17.84 and amd644-core1,996min/$15.97 cannot be attributed to this repository. Vendor-reported overdue October2, settlement unknown. No payment or billing action occurred. Blacksmith dashboard requires sign-in; net recurring billing is unknown. The original comparable-workload75% target is open; time priority and all-Blacksmith placement constrain the optimization approach.

## Safety, storage and continuation

Existing audits, check identities and three-platform coverage remain. Updated contracts assert all current workflow runners are Blacksmith, nightly is verification-only and tagged-release verification/signing topology is retained. Local workflow normalization against verified main confirms original commands/gates except the explicitly removed nightly release jobs and tightly scoped cache/version additions.

Latest nightly's Windows installer artifact was254,995,339 bytes at default90-day retention; identity4,884 bytes/90days; sidebar evidence2,494,231 bytes/7days; tested WASM4,004,364 bytes/1day. Removing nightly installer creation avoids future installer/identity artifacts, while verification evidence remains. Existing historical artifacts/releases/tags are not deleted by this change. Artifact/storage and transfer invoice attribution are unavailable; [GitHub's billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions) documents GB-hour storage accrual and separate cache allowances. No quota/retention limit, paid cache setting, transfer billing configuration or infrastructure purchase is changed.

Detailed current execution state, latest30-run data, historical withdrawn hosted-run measurements and independent reviews are maintained in `/workspace/ci-cost-project/STATE.md` and adjacent evidence files. The committed ledger may predate final CI to avoid a documentation-only push and extra validation expense. Each new implementation head needs its own minimum necessary CI evidence; previous hosted success is not Blacksmith validation for the revised head.

Next opportunities: investigate very slow cache restore (the latest nightly spent about184s restoring its Cargo cache) and reduce proven redundant compilation with correct profiles/source identity. Preserve all tagged release gates. No release dispatch or optional expensive benchmark. Apple required-agreement403 remains an account-owner issue and must block any required tagged notarization. No indefinite spending authority is assumed past the earlier October12 maintenance window.

Rollback must revert the entire merged PR as one change, or restore all affected files from verified base `ae8cc31c4a3b6467dfb788045035b6e0ed3d25a4`. Never revert only the replacement commit: the earlier intermediate commit contains the withdrawn standard-runner placement. Keep every runner on Blacksmith throughout rollback. No branch protection or account setting was changed.
