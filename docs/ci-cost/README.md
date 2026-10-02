# CI cost reduction project

Status: phase 1 implemented; exact-head CI validation and parent integration review pending. Target: at least 75% lower attributable cost for comparable repository CI workload, retaining all tests, platform coverage, security, signing and publication gates. This target is not yet achieved for the whole repository.

## Scope and ownership

Started 2026-10-02 in the saved Rauhwpx cloud environment from verified main `ae8cc31c4a3b6467dfb788045035b6e0ed3d25a4` (merged PR430). Branch: `ci/reduce-paid-checks`. No renderer, frontend or UI files are changed. PR431 belongs to Mini and remains untouched at `a94e6fc1b157d2d4af222694867ad12c17bccf1c`. Release/dependency coordination belongs to task `01a0f694-6bec-71b5-86d3-88adab4200d0`; notify parent before extending scope into release files. This phase changes `checks.yml`, tooling contract tests and this ledger/evidence only.

Parent integration review is required before merge. No release dispatch, account changes, billing changes, purchases, credential grants or cancellation of others' runs is authorized by this implementation. No unmonitored daemon is running. The earlier exam arrangement ends October 12 at 12:40 KST; this project's authority beyond that is unspecified. Resume in bounded batches and record unfinished scope.

## Implemented reductions

- Use standard GitHub-hosted Ubuntu 24.04 x64, Windows Server 2025 x64 and macOS 15 arm64 for the PR-only checks workflow, retaining its public check names, change-selection predicates, fail-safe behavior and job timeouts.
- Keep the three-platform *installed* provider/Electron verification, six-lock audits and both real worker/sandbox container checks. Add explicit architecture assertions to the dependency audit matrix.
- Cache npm downloads for all six lockfiles in the production-dependency matrix. `npm ci` and audits still execute; no `node_modules` or audit results are reused.
- Preserve existing superseded-PR cancellation, read-only permissions and docs placeholder jobs. No check or platform is removed.

## Verified pricing and limitations

Repository visibility was verified as **public** using authorized GitHub connector metadata. [GitHub's runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) states standard public-repository runner compute is free, including `ubuntu-24.04`, `windows-2025` and arm64 `macos-15`. Larger runners are excluded from this proposal. Compute is modeled at $0 while the repo remains public; storage is a separate dimension.

[Blacksmith pricing](https://www.blacksmith.sh/pricing), checked October 2, lists 2-vCPU Ubuntu x64 at $0.004/min, ARM at $0.0025/min, Windows at $0.008/min, and 6-vCPU macOS at $0.08/min. The model scales Linux/Windows rates proportionally with cores ($0.008 x64 4-core, $0.016 x64 8-core/Windows 4-core, $0.005 ARM 4-core); this is an explicit rate-model assumption, consistent with the supplied historical 4-core invoice line, rather than a vendor usage export. [Blacksmith's runner reference](https://docs.blacksmith.sh/blacksmith-runners/overview) also documents proportional free-minute consumption. No vendor speed claim is used as measured performance.

Standard Ubuntu and Windows have 4 CPUs/16 GB RAM for public repos. Standard macOS has 3 M1 CPUs/7 GB versus Blacksmith's 6 M4 CPUs/24 GB; the PR macOS workload installs/runs Node dependencies rather than compiling release installers. Container disk space (14 GB standard runner specification versus Blacksmith's larger disk), queue latency, cache misses and tool-image differences require live validation. The official [Ubuntu image manifest](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md) includes Podman and Chrome. Release runner migration remains a separate unvalidated phase.

## Attributable baseline

`baseline-runs.json` contains job IDs, exact source SHAs, runner labels, timestamps, step outcomes and run links, collected through authorized read-only GitHub connector GETs. Run/job lists are requested with `per_page=100` for these runs. Baselines are latest attempt only and the chosen sample is illustrative, not a monthly spend census.

Reproduce: `node scripts/ci-cost-model.mjs`. Models use observed job elapsed seconds (queue time excluded). Skipped jobs cost zero. Unknown runners, incomplete jobs and mismatched source heads fail closed. Both duration-equivalent cost and an **unverified** rounded-minute scenario are reported; neither is an invoice or realized charge.

| Run and coverage | Duration-equivalent list cost | Rounded-minute scenario | Phase 1 projection |
| --- | ---: | ---: | ---: |
| [36848222173](https://github.com/heemangstudio/Rauhwpx/actions/runs/36848222173), PR430 full checks, `cf9ff708751831f40c9d592bf90676531e391c31` | $0.2190 | $0.3280 | $0 runner compute for successful comparable gates |
| [36865996217](https://github.com/heemangstudio/Rauhwpx/actions/runs/36865996217), PR431 engine/browser checks and placeholders, `a94e6fc1b157d2d4af222694867ad12c17bccf1c` | $0.0648 | $0.0960 | $0 runner compute for this narrower workload |
| [36932761506](https://github.com/heemangstudio/Rauhwpx/actions/runs/36932761506), scheduled nightly, `ae8cc31c4a3b6467dfb788045035b6e0ed3d25a4`, notary failure | $0.9703 | $1.0120 | Unchanged |
| [36643093004](https://github.com/heemangstudio/Rauhwpx/actions/runs/36643093004), successful tagged 2.0.9 release, `c9b3c9d8e197605d222aec061075ef417d9c0fc7` | $1.5173 | $1.5800 | Unchanged |

The full PR baseline has 11 successful jobs, 1,039 job-seconds total; container verification dominates at 388 seconds, of which real asset building took 235 and container verification 114. The narrower PR431 run has successful placeholder jobs for unselected platforms; it does **not** prove platform-audit coverage. The nightly's 751-second engine job and 403-second failed macOS job are recurring-cost candidates, but the Apple gate must remain blocking. Tagged releases additionally build both cloud architectures and Linux installer architectures.

For a workload containing `N` full PR430-like runs, `K` PR431-like runs, `D` nightly-like runs and `R` successful tagged releases, baseline duration-equivalent compute is `0.2190*N + 0.0648*K + 0.9703*D + 1.5173*R`; phase 1 is `0.9703*D + 1.5173*R`. Savings depend on that mix, credits and actual vendor accounting. Do not claim 75% repo-wide from 100% PR-only modeled compute savings.

Invoice BLA-DFA1-202610-88951: user-supplied organization-wide September 24–30 usage is $45.69 gross, $12 credit, $33.69 net; macOS arm64 6-core 223min/$17.84 and amd64 4-core 1,996min/$15.97 are largest lines. It cannot be attributed to this repo or extrapolated as recurring spend. Vendor-reported overdue October 2; settlement unknown. No payment action taken. Blacksmith dashboard needs user sign-in, so realized invoice reduction is **unknown**.

## Workflow inventory and opportunities

| Workflow | Events/concurrency | Current phase |
| --- | --- | --- |
| Repository checks | PR + manual; `checks-PR/ref`, cancels superseded checks | Migrated in this proposal; no push duplicate exists |
| Nightly verification and release | Daily 18:00 UTC + manual; `nightly-ref`, never cancels running release | Unchanged; engine tests/audits feed one tested WASM artifact, app and signing/builds feed publication |
| Release desktop apps | `v*` tags; `release-ref`, never cancels running release | Unchanged; preflight/contracts, single shared WASM, two cloud architectures, signed macOS and Windows/Linux packages gate publication |
| Cloud sandbox image | Manual + `cloud-sandbox-v*` tags; noncancelling | Unchanged; real display/input/container gates before push |
| Pages | Path-filtered main push + manual; deployment noncancelling | Unchanged; potential free-runner migration, requiring parent scope coordination |

Caching reviewed: Rust keys include OS/architecture/pinned compiler/profile/Cargo.lock/SHA, with dependency/profile prefix fallback. Restoring Blacksmith Rust outputs onto hosted machines is normally a miss because the cache backends differ; source builds still run. WASM keys fingerprint committed engine inputs plus build tools, with no fallback for unmatched fingerprints; consumers do not invalidate engine outputs. Package reuse is already implemented for nightly and desktop releases. Two release cloud jobs still invoke build-wasm independently, which is a possible reuse improvement; source/toolchain proof and gate validation are required before editing it. Do not reuse source artifacts from an unrelated archive with old mtimes: PR431's historical stale native artifacts demonstrate that this is unsafe.

Storage reviewed through two run artifact lists: PR430 audit evidence is only 1,757 bytes across three artifacts, retained 7 days. Latest nightly Windows installer artifact is 254,995,339 bytes with default 90-day retention, identity is 4,884 bytes with default 90 days, sidebar evidence is 2,494,231 bytes/7 days and tested WASM is 4,004,364 bytes/1 day. Retention changes affect recovery and release consumers, so left untouched pending owner coordination. Total cache inventory is unavailable through the connector's allowed endpoint set; no cache deletion or paid cache expansion was attempted.

## Validation, evidence and rollback

Local: `npm run test:ci` — 87 passed, 1 existing skipped, 0 failed (88 total); `python3 website/check.py` — 4 pages checked; `npm run check:docs` passed; `git diff --check` passed. Local npm bootstrap used `/tmp/rauhwpx-npm-cache` with install scripts disabled, after the default home cache proved unwritable. No platform/runtime gate is inferred from that bootstrap.

Minimum live validation: one normal draft-PR event should select every check because workflow/tooling files changed. Monitor the exact head to terminal results, confirm audits/containers were executed (not placeholders), record durations/cache behavior, and compare with the full PR430 baseline. Separate this one-time run from recurring projections. Do not casually dispatch/rerun releases. Runtime changes or a failed gate require another reviewed correction and exact-head validation.

Rollback: revert the phase 1 implementation commit; this restores prior runner labels and removes the npm cache additions/architecture checks. No repository settings or release configuration are changed. Required-check names remain identical.

## Blockers and next bounded batch

- GitHub CLI's supplied token is invalid. Authorized GitHub connector reads work and existing git transport can read main; use the authorized connector for API work. No credentials replaced.
- `GET repos/heemangstudio/Rauhwpx/branches/main/protection` returned 403 `Resource not accessible by integration`. Do not infer no protection. Preserve names/conditions, and have parent check actual protection during integration review. Rulesets read shows an active release-tag ruleset. No protection settings changed.
- Live runner compatibility/coverage and terminal exact-head result are pending until draft creation.
- Account-wide cache usage and net vendor billing need an already-authorized vendor usage export/sign-in. No new OAuth grant, spending authority or vendor contract is requested.
- No supported cloud quota/usage tool is exposed. Historical Mini usage is not current cloud quota; no current-quota claim is made.
- Next phase: parent coordinate free-runner migration for nightly/release/Pages and package reuse; validate verification-only/nightly branch behavior without publication, then observe required release gates through their normal authorized cadence. Apple notarytool 403 required-agreement issue remains an account-owner action, not a CI gate to bypass.
