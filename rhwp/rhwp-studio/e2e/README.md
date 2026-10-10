# Smoke suite

`npm run e2e:smoke` starts its own hub and Vite on free ports, opens one headless Chrome, runs the flows in `smoke/` and prints one pass/fail line per flow. It exits nonzero on any failure. `npm run e2e:smoke -- agent` runs only flows whose file name contains `agent`.

Needs `rhwp/pkg` (`npm run build:wasm` from the root), Studio and hub dependencies, and Chrome. Set `CHROME_PATH` (or `PUPPETEER_EXECUTABLE_PATH`) when Chrome is not in `/Applications`. Server logs go to `rhwp/target/smoke-hub.log` and `smoke-vite.log`.

Each flow gets a fresh browser context and a fresh document and waits on observable state, never on fixed sleeps. Flow 7 drives the real hub with a fake Pi CLI, so no provider account or network is used.

To add a flow, add `smoke/NN-name.mjs` exporting `{ name, run({ page, context, url, hubPort, token, finishTurnPath }) }`. Shared waits and document helpers are in `smoke/lib.mjs`.

`agent-bench-harness.mjs` starts a real hub and Vite for scripts; `helpers.mjs` serves the benches in `../bench/` and the browser tests. `fake-codex-fleet.mjs` is a fixture for the hub's Codex subagent test.
