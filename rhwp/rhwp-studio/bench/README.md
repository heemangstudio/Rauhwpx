# Benchmarks

Perf tools, not tests. Run from `rhwp/rhwp-studio/`. Most print a summary and can write JSON (`--json=` or `--out=`); read each file's header for flags.
Benches marked *dev server* need `npm run dev` running and `VITE_URL` pointing at it (default `http://localhost:7700`); the rest start their own servers.

- `npm run bench:agent-tools`: MCP tool cost through hub, bridge, executor and wasm, with a fake provider.
- `npm run bench:agent-tool-concurrency`: tool round trips through a real `mcp-stdio` child at concurrency 1/4/8, split into stages.
- `npm run bench:live-agent-quota`: real `claude`/`codex`/`pi` CLI turns from the sidebar. **Spends real provider quota.**
- `npm run bench:live-agent-suite-quota`: scored editing tasks with a real provider. **Spends real provider quota.** Compare runs with `node bench/agent-live-compare.mjs a.json b.json`.
- `npm run bench:typing-latency` / `bench:typing-latency-bigdoc`: keypress-to-paint latency (*dev server*).
- `npm run bench:chat-stream`: Markdown streaming cost in the sidebar (needs `npm run dev:sidebar`, `--url=`).
- `npm run bench:preview-frame`: document preview frame cost (`--label=`).
- `npm run bench:typeset-line-width`: typeset line-width measurement cost (`--label=`).
- `npm run bench:long-document-image-cache`: picture cache on a long picture document (*dev server*).
- `npm run bench:canvaskit-image-cache`: CanvasKit picture cache budget (*dev server*).
- `npm run bench:app-memory`: app and agent-process memory with documents and idle chats, using a fake Claude CLI (`--runs=`, `--output=`).
- `npm run bench:agent-overlay`: pending-edit overlay renderer against a baseline commit, with power samples on macOS.

The live benches start the hub with `RHWP_TOOL_TRACE=1`, which writes one JSONL row per tool call (`RHWP_TOOL_TRACE_FILE`, default `<work dir>/tool-trace.jsonl`). For Pi, the live benches link the installed Pi (`~/Library/Application Support/rhwp/pi/prefix` or `RHWP_BENCH_PI_SOURCE`) and read the OpenRouter key from `OPENROUTER_API_KEY` or `~/.env`.
