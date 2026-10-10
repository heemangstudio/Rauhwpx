# Smoke suite

`npm run e2e:smoke` starts its own hub and Vite on free ports, opens one headless Chrome, runs the flows in `smoke/` and prints one pass/fail line per flow. It exits nonzero on any failure. `npm run e2e:smoke -- agent` runs only flows whose file name contains `agent`.

Needs `rhwp/pkg` (`npm run build:wasm` from the root), Studio and hub dependencies, and Chrome. Set `CHROME_PATH` (or `PUPPETEER_EXECUTABLE_PATH`) when Chrome is not in `/Applications`. Server logs go to `rhwp/target/smoke-hub.log` and `smoke-vite.log`.

Each flow gets a fresh browser context and a fresh document and waits on observable state, never on fixed sleeps. Flow 7 drives the real hub with a fake Pi CLI, so no provider account or network is used.

To add a flow, add `smoke/NN-name.mjs` exporting `{ name, run({ page, context, url, hubPort, token, finishTurnPath }) }`. Shared waits and document helpers are in `smoke/lib.mjs`.

## Standalone flows

These run outside the smoke suite and CI, for changes to the areas they cover.

`npm run e2e:background-sessions` starts its own hub and Vite with a fake Pi and a mock MCP provider. It checks that an agent keeps working on a document you switch away from, that its writes land only in that document, that parallel chats on one document are locked to 채팅, and that New Document and opens work while an agent runs.

`npm run e2e:chat-permissions` starts its own hub and Vite with a fake Pi. It checks per-chat permission requests and the edit review boundary in each mode.

`npm run e2e:chat-follows-document` needs `npm run dev` running. Clicking another document's chat saves and commits the current document once, then opens that document and continues its chat.

`npm run e2e:worktrees` starts an isolated hub and Studio to check worktree creation
from current edits, independent document state, local saving, standalone export,
close and reopen, portable history import, removal with retained history, merge
undo and redo, and cross-window ownership. It uses the real editor, WASM and
IndexedDB; the file picker uses an in-memory handle.
Chrome and the built WASM package are required. No provider credentials are needed.

## Fixtures

`agent-bench-harness.mjs` starts a real hub and Vite for scripts; `helpers.mjs` serves the benches in `../bench/` and the browser tests. `fake-codex-fleet.mjs` is a fixture for the hub's Codex subagent test.
