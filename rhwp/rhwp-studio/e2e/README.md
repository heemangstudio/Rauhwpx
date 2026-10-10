# Smoke suite

`npm run e2e:smoke` starts its own hub and Vite on free ports, opens one headless Chrome, runs the flows in `smoke/` and prints one pass/fail line per flow. It exits nonzero on any failure. `npm run e2e:smoke -- agent` runs only flows whose file name contains `agent`.

Needs `rhwp/pkg` (`npm run build:wasm` from the root), Studio and hub dependencies, and Chrome. Set `CHROME_PATH` (or `PUPPETEER_EXECUTABLE_PATH`) when Chrome is not in `/Applications`. Server logs go to `rhwp/target/smoke-hub.log` and `smoke-vite.log`.

Each flow gets a fresh browser context and a fresh document and waits on observable state, never on fixed sleeps. Flow 7 drives the real hub with a fake Pi CLI, so no provider account or network is used.

To add a flow, add `smoke/NN-name.mjs` exporting `{ name, run({ page, context, url, hubPort, token, finishTurnPath }) }`. Shared waits and document helpers are in `smoke/lib.mjs`.

## Standalone flows

These run outside the smoke suite and CI, for changes to the areas they cover.

`npm run e2e:background-sessions` starts its own hub and Vite with a fake Pi and a mock MCP provider. It checks that an agent keeps working on a document you switch away from, that its writes land only in that document, that parallel chats on one document are locked to 채팅, and that New Document and opens work while an agent runs.

`npm run e2e:chat-follows-document` needs `npm run dev` running. Clicking another document's chat saves and commits the current document once, then opens that document and continues its chat.

`npm run e2e:worktrees` starts an isolated hub and Studio to check worktree creation
from current edits, independent document state, local saving, standalone export,
close and reopen, portable history import, removal with retained history, merge
undo and redo, and cross-window ownership. It uses the real editor, WASM and
IndexedDB; the file picker uses an in-memory handle.
Chrome and the built WASM package are required. No provider credentials are needed.

`npm run e2e:agent-interruption-recovery` starts its own hub and Vite with a fake Pi and a mock MCP provider. Reloading while a turn runs, and again while the agent waits on a question, keeps the chat on the same provider session and turn: the question comes back at its step with the typed answer, and the original provider call receives the submitted answer. Restarting the hub mid-turn leaves a cut-off turn that says why and offers 이어서 진행, also in a new tab after another restart. A reload cuts off a second chat that was working while the window's own chat is re-adopted.

`npm run e2e:engine-trap-recovery` starts its own hub and Vite with a fake Pi. It reports a simulated engine trap (a `WebAssembly.RuntimeError` through the app's trap path; a real trap cannot be produced on demand) and checks that the page reloads and reopens every open document: edits come back unsaved and still linked to their file, the agent's document returns to its background session with its turn cut off, a document that traps again is held back, `.rhwpx` and read-only documents come back as they were, and a turn the stopped page could not stop is stopped after the reload.

Both choose their starting ports from `RHWP_AGENT_PORT` and `VITE_PORT` when set.

## Hub and Vite processes

Start a hub or Vite server with `spawnLogged`, or with `startHub` and
`startVite`, from `agent-bench-harness.mjs`, and stop it with `stopServer`. Do not
call `child.kill()` on the server. `npm run dev` runs Vite under npm and a
shell, so killing the child stops only npm and leaves Vite listening.

Each server runs in its own process group (taskkill `/T` on Windows), and
`stopServer` stops the whole tree. It also stops processes the server moved
out of its group, such as the hub's Pi auto-update `npm install`, and waits
for them to exit. If a script exits through Ctrl-C, SIGTERM, an uncaught error
or `process.exit` before stopping its servers, the harness stops them on exit.
Remove fixture directories with `removeTempDir`. It retries while files are
still being released and logs a warning if removal fails, so a failed cleanup
does not crash the run.

## Fixtures

`agent-bench-harness.mjs` starts a real hub and Vite for scripts; `helpers.mjs` serves the benches in `../bench/` and the browser tests. `fake-codex-fleet.mjs` is a fixture for the hub's Codex subagent test.
