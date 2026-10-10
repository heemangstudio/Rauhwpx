# Memo #8 copy-layout worker verification

Codex 0.162.1 advertises GPT-6.1-Sol MCP calls through Code Mode. The original worker disabled that host, producing zero calls and an unfinished-job failure. Both launch paths now enable it while retaining the read-only native sandbox and scoped MCP catalog.

The actual CLI regression fails with the old flag and passes after the repair. It explicitly verifies the native patch denial. Run it with `RHWP_TEST_CODEX_BIN=/path/to/codex node --test rhwp/rhwp-agent/tests/codex-copy-layout-runtime.test.mjs`.

The screenshots and results come from isolated production Studio, hub, Codex, WASM and native helper/rendering at http://127.0.0.1:7921. Model responses and login markers were offline fixtures; no provider quota or user credentials were used. The blank HWPX fixture produced a verified published artifact and visible completed fleet row. A separate action delivered an explicit failed completion without a false artifact. The original source digest stayed unchanged. This checks lifecycle and tool access; semantic template choices for the user document were not evaluated.

Owned servers and browser were stopped. No separate live cancellation action was performed; existing focused worker cleanup checks passed.
