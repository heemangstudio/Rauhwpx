# Benchmarks

Perf tools, not tests. Run from `rhwp/rhwp-studio/`. Most print a summary and can write JSON (`--json=` or `--out=`); read each file's header for flags.
Benches marked *dev server* need `npm run dev` running and `VITE_URL` pointing at it (default `http://localhost:7700`); the rest start their own servers.

- `npm run bench:agent-tools`: MCP tool cost through hub, bridge, executor and wasm, with a fake provider.
- `npm run bench:agent-tool-concurrency`: tool round trips through a real `mcp-stdio` child at concurrency 1/4/8, split into stages.
- `npm run bench:live-agent-quota`: real `claude`/`codex`/`pi` CLI turns from the sidebar. **Spends real provider quota.**
- `npm run bench:live-agent-suite-quota`: scored editing tasks with a real provider. **Spends real provider quota.** Compare runs with `node bench/agent-live-compare.mjs a.json b.json`.
- `node bench/browser-agent-suite.mjs`: ten real-site browser tasks with Claude Haiku 5.5 and Codex GPT-6 Luna, interleaved over three repetitions. `--probe` checks sites without model calls; `--execute` uses subscription quota.
- `npm run bench:typing-latency` / `bench:typing-latency-bigdoc`: keypress-to-paint latency (*dev server*).
- `node bench/browser-human-latency.mjs`: browser click latency in an isolated Electron profile (*dev server*). Also checks native typing, Korean IME, scrolling, and annotation capture. `--managed` measures the screenshot fallback; `RHWP_BROWSER_LATENCY_OUTPUT` writes JSON.
- `npm run bench:chat-stream`: Markdown streaming cost in the sidebar (needs `npm run dev:sidebar`, `--url=`).
- `npm run bench:chat-stream-frame`: whole-sidebar frame cost while an answer streams into a visible or hidden chat (needs `npm run dev:sidebar`, `--url=`).
- `npm run bench:preview-frame`: document preview frame cost (`--label=`).
- `npm run bench:typeset-line-width`: typeset line-width measurement cost (`--label=`).
- `npm run bench:long-document-image-cache`: picture cache on a long picture document (*dev server*).
- `npm run bench:canvaskit-image-cache`: CanvasKit picture cache budget (*dev server*).
- `npm run bench:app-memory`: app and agent-process memory with documents and idle chats, using a fake Claude CLI (`--runs=`, `--output=`).
- `npm run bench:agent-overlay`: pending-edit overlay renderer against a baseline commit, with power samples on macOS.

The live benches start the hub with `RHWP_TOOL_TRACE=1`, which writes one JSONL row per tool call (`RHWP_TOOL_TRACE_FILE`, default `<work dir>/tool-trace.jsonl`). For Pi, the live benches link the installed Pi (`~/Library/Application Support/rhwp/pi/prefix` or `RHWP_BENCH_PI_SOURCE`) and read the OpenRouter key from `OPENROUTER_API_KEY` or `~/.env`.

The browser suite starts fresh headless managed Chromium profiles in question/safe mode. Install Chromium before timing and set `CHROME_PATH` and `PLAYWRIGHT_BROWSERS_PATH`. Sign in to Claude and Codex first; the quota gate at `~/.claude/skills/pr-parity-watch/scripts/gate.sh` must pass before every turn. The active arms use the existing Claude SDK/CLI transport with `claude-haiku-5-5` and Codex app-server with `gpt-6-luna`. They require no Pi installation or OpenRouter key. Subscription cash cost is recorded as zero; runtime catalog estimates are separate.

```sh
node bench/browser-agent-suite.mjs --execute --label=baseline --out=output/browser-baseline.json
node bench/browser-agent-suite.mjs --execute --label=candidate --round=shared-1 --baseline=output/browser-baseline.json --out=output/browser-shared-1.json
node bench/browser-agent-suite.mjs --execute --label=final --baseline=output/browser-baseline.json --out=output/browser-final.json
node bench/agent-live-compare.mjs output/browser-baseline.json output/browser-final.json --json
```

Resume with the same command and output file. Source, model, backend or configuration changes require a new file. Failed retry attempts remain in the record and cannot qualify for a three-success speed comparison. Ratios require identical arm and task definitions on the same Asia/Seoul calendar day, with exactly three observed attempts all passing independent final URL, DOM and answer checks. Benchmark-only private snapshot receipts preserve masked service DOM before provider transcript truncation; capture failures stop the round as measurement-insufficient.

Candidate rounds evaluate shared tool-layer changes with the same bare CLI configurations. Pi-specific prompt and harness experiments do not apply to these arms. The OpenRouter budget module remains available for existing ledger reconciliation and its fake-provider checks. Existing spending and uncertain reservations remain in the locked ledger at `~/.rhwp-browser-bench/openrouter-budget.json`; subscription runs do not alter it. Its default cap remains $10, and `--budget-usd` selects an explicit operator cap for OpenRouter experiments.
