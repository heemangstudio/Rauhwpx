# Conversation

- Keep responses short and easy to scan. Share key details first and elaborate when the user asks.
- Push back on unreasonable decisions and ask about the concern at least once.
- When the user asks to "talk with me," brainstorm with them first, then execute once the plan is concrete.

# Environment

- You are working on the user's local laptop. Avoid computer-use automation unless the user asks for it, and prefer sandbox-supported browsers.

# Sidebar Design Preview

- Use `npm run dev:sidebar` and open `http://127.0.0.1:7715` for sidebar design work and frontend interaction checks. On a fresh checkout, first run `npm --prefix rhwp/rhwp-studio ci`. The preview needs no full application, WASM build, agent hub, or provider credentials.
- The preview mounts the production sidebar from `rhwp/rhwp-studio/src/ui/agent-sidebar/`. Make shipping UI changes there so the application and preview stay in sync; keep temporary experiments in `src/sidebar-preview/preview.css` or an isolated worktree.
- Use the preview controls for sample chat, plans, questions, change review, subagents, connection failures, and provider setup. Backend and document-engine actions use local fixtures and placeholders.
- Maintain the typed mocks in `rhwp/rhwp-studio/src/sidebar-preview/` when service interfaces change. Preserve the independent Vite configuration and frontend-only behavior.
- For sidebar behavior changes, run `npm run test:sidebar`; it uses a fresh headless browser and saves screenshots in `rhwp/rhwp-studio/sidebar-preview/artifacts/`. `npm run build:sidebar` checks the standalone build. Simply starting the preview does not require rerunning these checks.
- See [the preview guide](rhwp/rhwp-studio/sidebar-preview/README.md) for URL scenarios, storage reset, browser prerequisites, and extension instructions.

# Repository

Rauhwpx is a viewer and editor for Korean HWP/HWPX documents: a Rust engine compiled to WebAssembly, a web editor (`rhwp-studio`) with an AI sidebar, a local agent hub (`rhwp-agent`), and an Electron desktop app. The sidebar runs Claude, Codex and Pi through their local CLIs. The live MCP tool list is `rhwp/rhwp-agent/tools.mjs`; do not hardcode the tool count in prose. Code comments, commit messages and CLI output are largely Korean; follow the convention of the file you edit. Setup and focused checks are in [CONTRIBUTING.md](CONTRIBUTING.md).

| Path | What lives there |
| --- | --- |
| `rhwp/src/` | Rust engine. CLI entry is `rhwp/src/main.rs`; wasm surface is `rhwp/src/wasm_api.rs` |
| `rhwp/rhwp-studio/` | Studio web editor (TypeScript, no UI framework) |
| `rhwp/rhwp-agent/` | Local hub, provider adapters, MCP tools |
| `desktop/` | Electron main process |
| `site-api/` | Waitlist and install counter behind the product site (Railway service, see its README) |
| `tests/` | Root Node tests for desktop (`desktop-*.test.mjs`) |
| `scripts/`, `.github/workflows/` | Build and CI helpers; workflows are the source of truth for CI commands |
| `website/` | Product site |

There is no root `src/` and no `rhwp/.cargo/`. `rhwp/README.md` is the only README in `rhwp/`; the English product README is `README.en.md` at the root.

# GitHub

- PRs, CI, branch protection and releases live on `heemangstudio/Rauhwpx` (remote `heemangstudio`). `origin` is the `ghandhitechnology` mirror. Pass `-R heemangstudio/Rauhwpx` to `gh` unless `gh repo set-default` is configured.
- `main` requires signed commits, linear history, an up-to-date branch and the `Session tests (macos-15)` and `Session tests (windows-latest)` checks. Rebase with `git rebase -S` when commits were created unsigned.

# Setup in a new worktree

Run from the repository root before Studio or agent work:

```sh
npm run setup        # root, rhwp-studio and rhwp-agent dependencies
npm run build:wasm   # rhwp/pkg, needed by Studio dev, build, tsc and npm test
```

Studio `npm test` imports hub modules, so `rhwp/rhwp-agent/node_modules` must exist too. Install the whole package with `npm run setup` rather than adding single packages by hand. Do not share `CARGO_TARGET_DIR` across worktrees. Use `python3`; there is no `python`. macOS has no `timeout`.

# Commands

## Test map

| Layer | Command | PR check |
| --- | --- | --- |
| Engine | `cargo test` from `rhwp/` | Engine |
| Studio unit | `npm --prefix rhwp/rhwp-studio test` | App |
| Hub | `node --test rhwp/rhwp-agent/tests/*.test.mjs` | App |
| Desktop | `npm run test:desktop` | App, Session tests (macOS, Windows) |
| Browser | `npm --prefix rhwp/rhwp-studio run test:browser`, then `run e2e:smoke` | Browser |
| Sidebar | `npm run test:sidebar` | nightly only |

PR checks run only for the paths a change touches (`scripts/ci-changes.mjs`). Nightly adds the corpus sweeps, Skia rendering, cargo and npm audits, and the 3-OS production dependency check.

## Rust engine (from `rhwp/`)

- Toolchain is pinned by `rust-toolchain.toml` and includes `wasm32-unknown-unknown`.
- Build `cargo build`; tests `cargo test` (unit tests + the single `it` integration binary); one module `cargo test --test it <module>`; one function `cargo test --test it <module>::<fn>`. Integration tests are modules in `tests/it/` (register each in `tests/it/main.rs`), mostly named `issue_NNNN_*` / `pr_NNNN_*`, and load fixtures from `samples/`; shared helpers live in `tests/it/common.rs`, Hancom page-count pins in `tests/it/page_count_pins.rs`.
- Corpus roundtrip sweeps and tests over ~20 s in debug live in `tests/sweeps/` (`test = false`, skipped by `cargo test`): `cargo test --profile release-test --test sweeps`. Skia PNG/PDF tests compile only with `cargo test --features native-skia --test it`.
- Faster optimized build for render comparisons: `cargo build --profile release-test --features native-skia --bin rhwp` (release without LTO).
- Lint and format from `rhwp/`: `cargo clippy`, `cargo fmt` (max_width 100). `Cargo.toml` deliberately allows many structural lints pending a phased refactor; do not fix or tighten them in unrelated changes.
- WASM: `wasm-pack build --target web` (wasm-pack 0.15.0), or `npm run build:wasm` from the root.
- CLI: `cargo run --bin rhwp -- <command>`. The dispatcher is at the top of `src/main.rs`; subcommands take no `--help`, so read the handler there. Common: `info`, `export-svg|png|pdf|text|markdown|tables|hwpx|hml`, `export-render-tree` (render tree as JSON, the easiest way to inspect layout), `export-structure`, `dump`, `dump-pages`, `diag`, `search`, `convert`, `edit`, `batch`, many `hwp5-*` probes. `capabilities --mcp` generates MCP tool definitions; a test enforces it covers every `--json` command.
- Export `-p`/`--page` takes a 0-based page index; output filenames are 1-based (`render_tree_001.json`).
- Fonts: `--font-path` or `RHWP_FONT_PATH` (`:`-separated) accept files or directories; directories are read one level deep, not recursively. `ttfs/opensource` is the last fallback.
- Hancom font tooling and Studio capture for parity work: `tools/hancom_font_atlas/` (see its README). Put throwaway Rust probes in `examples/` and run them with `cargo run --example`.
- PDF/PNG export is native-only. `native-skia` enables the Skia backend. `svg2pdf` is a vendored determinism fork in `[patch.crates-io]`; keep the patch.

## Studio (from `rhwp/rhwp-studio/`)

- `npm run dev` serves http://127.0.0.1:7700 and starts its own authenticated hub.
- `npm test` runs fast Node tests and `../npm/editor/tests`; `npm run test:browser` runs browser integrations (see `tests/README.md`).
- `npm run build` type-checks and builds.
- Smoke: `npm run e2e:smoke` starts its own hub and Vite, runs eight user flows in headless Chrome (fake provider, offline) and exits nonzero on failure. Set `CHROME_PATH` if Chrome is not in `/Applications`. See `e2e/README.md`. Perf tools are `npm run bench:*` (see `bench/README.md`); the `*-quota` ones spend real provider quota.
- To drive Studio and a real hub from a script, import `e2e/agent-bench-harness.mjs` (`findAvailablePort`, `startHub`, `startVite`, `ensureChromePath`, `stopServer`) instead of picking ports and env vars by hand.

## Hub (from `rhwp/rhwp-agent/`)

- `npm test`; `npm run typecheck:acp` checks only `agents/backend.mjs`, `agents/acp-session.mjs` and `agents/provider-user-input.mjs`.
- From the root, `npm start` runs a background hub on 127.0.0.1:5175, `npm stop` stops it, `npm run start:fg` runs it in the foreground. Studio dev does not need it.
- On Windows every child process needs `windowsHide: true`; use `processTreeSpawnOptions` from `process-tree.mjs`.

## Desktop and site API (from the root)

- `npm run test:desktop` runs the root desktop tests.
- Site API: `npm --prefix site-api test`.
- Testing a packaged app from an agent shell: unset `ELECTRON_RUN_AS_NODE` (`env -u ELECTRON_RUN_AS_NODE`). The first launch of a signed build asks for Keychain access, which a person must approve. Signing and release steps are in [docs/releasing.md](docs/releasing.md).

# Architecture

## Rust engine (`rhwp/src/`)

Pipeline: parser → model → document_core → renderer → serializer, exposed to JS through `wasm_api.rs`.

- `parser/`: HWP 5.0 (CFB, `body_text/`, `doc_info.rs`, `record.rs`), `hwpx/`, `hml/`, `hwp3/`, `ingest/`. All formats converge on one model.
- `model/`: in-memory document model.
- `document_core/`: editing layer (`commands/`, `queries/`, `builders/`, `converters/`, table calc, validation). `DocumentCore` is the entry.
- `renderer/`: `typeset.rs`, `layout/` (`paragraph_layout.rs`, `text_measurement.rs`, `table_layout.rs`), `composer/`, `pagination/`, `render_tree.rs` (`RenderNode`), `skia/` (native), `static_svg.rs`, `pdf.rs`, `web_canvas.rs`. Font metrics are generated into `font_metrics_data.rs` by the `font-metric-gen` bin.
- `paint/`: paint ops and layer tree, JSON in `paint/json.rs`.
- `serializer/`: HWPX/HML writers. Roundtrip fidelity is a core concern; many tests are roundtrip contracts.
- Supporting: `wmf/`, `emf/`, `ole_chart/`, `ooxml_chart/`, `diagnostics/`, `doclang/`.

## Studio (`rhwp/rhwp-studio/src/`)

`engine/` wraps wasm; `core/`, `view/`, `command/`, `history/` (undo), `ui/` (dialogs, command palette, `agent-sidebar/`), `hwpctl/`, `embed/`. `agent/` is the Studio side of the AI bridge: `bridge.ts` (WS client), `tool-executor.ts` (MCP tools against the engine, including `apply_edits`), `pending-edits.ts` and `pending-overlay.ts` (staging). One agent mode selector maps onto the wire's `workflow` + `permissionProfile` (`AgentMode` in `agent/types.ts`): **채팅** = question (read-only), **플랜** = plan (read-only until the user approves; approval picks the run profile), **에이전트** = direct + safe (writes stage as a live preview and are held for review at turn end), **전체** = direct + unrestricted (no review: each write tool call commits as its own undo step).

## Hub (`rhwp/rhwp-agent/`)

`server.mjs` is the WS hub (`/studio`, `/mcp`, `/healthz`). Adapters: `agents/claude.mjs`, `agents/codex.mjs` (+ `codex-app-server.mjs`), `agents/pi.mjs`; shared briefs in `agents/backend.mjs`. Each CLI spawns `mcp-stdio.mjs`, which forwards tool calls to the hub and on to the Studio tab. Tools are `mcp__rhwp__<name>` in `tools.mjs`. Revision contract: every read returns `revision`, every write requires `expectedRevision`, mismatch returns `REVISION_MISMATCH`; saving does not bump the revision. Coordinates are 0-based body-text `sectionIdx`/`paraIdx`/`charOffset`.

## Other deliverables

`rhwp-chrome/`, `rhwp-firefox/`, `rhwp-safari/`, `rhwp-vscode/`, `npm/editor`, `rhwp-shared/`. `rhwp/pkg/` is generated; `samples/` holds fixtures; `saved/` and `output/` hold generated artifacts.

# Pull Requests

Pull requests should give reviewers enough context to understand the problem, evaluate the approach, and verify the result without reconstructing the work from the diff.

Use this structure:

1. **Title**
   - Clearly summarize the user-visible or technical outcome.
   - Be specific; avoid vague titles such as "fix issue" or "update code."

2. **Summary**
   - Explain what changed and why in 2–4 sentences.
   - Include relevant product or technical context.

3. **Problem**
   - Describe what was missing, broken, confusing, or risky.
   - Include the observable impact and root cause when known.

4. **Solution**
   - List the important implementation changes.
   - Explain notable design decisions and why this approach was chosen.
   - Call out intentionally excluded work or follow-ups.

5. **Diff overview**
   - Summarize the meaningful changes by component or file area.
   - Focus on behavior and architecture, not a file-by-file transcript.

6. **Testing**
   - List commands and checks that were run, with their outcomes.
   - Include important manual verification scenarios.
   - If testing was not performed, state that clearly and explain why.

7. **Risk and rollout**
   - Identify compatibility concerns, migrations, configuration changes, or deployment requirements.
   - Note rollback steps when the change carries meaningful risk.
   - Write "None" when there are no notable risks or rollout steps.

8. **Visual evidence**
   - For UI changes, include before/after screenshots or a short recording when practical.
   - For non-UI changes, omit this section.

Keep PR descriptions detailed but relevant. Do not pad them with boilerplate, repeat the commit history, or claim tests that were not run.

# Smoke Testing

- Do not run heavy smoke tests for simply booting an app or for trivial code changes.
- Run appropriate smoke tests for new features and changes that could break existing behavior.

# Live App Verification

- For changes to user-visible behavior, exercise the affected flow in a running app before claiming it works. Pair focused regression tests with a fresh live check; a green Node suite or source-text assertion alone is insufficient.
- Start Studio with `npm run dev:studio` and use the running editor at `http://127.0.0.1:7700`. Use the sidebar preview above for isolated sidebar interactions, but verify document-engine, hub, provider, and desktop changes in the corresponding real runtime. Clearly label fixture-backed checks.
- Reproduce the original trigger, perform the user action through the UI, and check the resulting document, persisted state, emitted request, or visible behavior. Check the relevant failure or cancellation path. For save/export changes, reopen the saved output and verify its content.
- Record the app URL or runtime, scenario, observed result, and relevant screenshot or log in the handoff/PR. If prerequisites or credentials block live verification, state what was blocked and what remains unverified; never substitute a passing mock test for a claim of live success.
- Prefer bounded waits for observable readiness or state changes over fixed sleeps. Run the smallest relevant checks first; do not rerun broad suites without a new change, failure, or unresolved concern.
- New regression tests should fail when the user behavior breaks. Avoid tests that only pin labels, CSS values, comments, source ordering, function names, call-site counts, or constant arithmetic. Replace security, edit-history, and data-loss source guards with behavioral coverage before removing them. Keep meaningful accessibility, format compatibility, boundary, and compile-time contracts.
